import { describe, it, expect } from 'vitest';
import { isFatalWasmTrap } from '../src/server/giac/fatal-trap.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { hypothesisTestingHandler } from '../src/server/tools/hypothesis-testing.js';
import { linearRegressionHandler } from '../src/server/tools/linear-regression.js';
import { numericalMethodsHandler } from '../src/server/tools/numerical-methods.js';
import { createJsComputeHost } from '../src/server/js-compute/index.js';
import { probabilityCalcHandler } from '../src/server/tools/probability-calc.js';

const text = (r: { content: { text: string }[] }): string =>
  r.content.map((c) => c.text).join('\n');

/**
 * The guards in this file all exist to stop a specific measured failure, and
 * none of them had a test: deleting any one of them left the whole suite green.
 * A guard nothing exercises is a guard a later refactor removes for free.
 */
describe('a fatal WASM trap is distinguished from an ordinary Giac error', () => {
  // Both directions matter. Missing a trap leaves the engine wedged while
  // isReady() reports true; matching too widely recycles the CAS on a typo.
  it.each([
    'Giac WASM evaluation error: memory access out of bounds',
    'Giac WASM evaluation error: RuntimeError: unreachable',
    'Giac WASM evaluation error: unreachable',
    'Giac WASM evaluation error: table index is out of bounds',
    'Giac WASM evaluation error: RuntimeError: memory access out of bounds',
  ])('recycles on %s', (message) => {
    expect(isFatalWasmTrap(message)).toBe(true);
  });

  it.each([
    'GIAC_ERROR: Invalid function foo',
    'Unable to parse : syntax error',
    'Error: Bad Argument Value',
    'GIAC_ERROR: Unable to isolate x',
    'undef',
    'Giac evaluation timed out after 10000ms',
    '',
  ])('keeps the worker alive on %s', (message) => {
    expect(isFatalWasmTrap(message)).toBe(false);
  });
});

describe('significance must be a probability', () => {
  // The comment on the guard states the stakes: α = 1.5 makes every test
  // reject, α ≤ 0 makes none reject, and both used to be reported as confident
  // successes.
  it.each([1.5, 0, 1, -0.05, Number.NaN, '0.05', null])(
    'rejects significance %s',
    async (significance) => {
      const r = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1: [1, 2, 3, 4, 5], mu0: 3, significance },
        alternative: 'two_sided',
      });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/strictly between 0 and 1/);
    }
  );

  it('an absent significance takes the 0.05 convention', async () => {
    // Absent and malformed are different inputs, and the boundary between them
    // is the part most likely to be lost in a later refactor.
    const r = await hypothesisTestingHandler({
      test: 'one_sample_t',
      data: { sample1: [1, 2, 3, 4, 5], mu0: 5 },
      alternative: 'two_sided',
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^α = 0\.05$/m);
  });
});

describe('a polynomial fit is bounded', () => {
  const points = { x: [1, 2, 3, 4, 5, 6], y: [1, 4, 9, 16, 25, 36], model: 'polynomial' };

  it.each([11, 3000, 0, -1, 2.5])('rejects degree %s', async (degree) => {
    const r = await linearRegressionHandler({ ...points, degree });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/degree must be an integer/);
  });

  // The identifiability boundary in both directions: with n points a degree of
  // n-1 is the highest that is determined.
  it('rejects a degree at the point count', async () => {
    const r = await linearRegressionHandler({
      x: [1, 2, 3],
      y: [1, 4, 9],
      model: 'polynomial',
      degree: 3,
    });
    expect(r.isError).toBe(true);
  });

  it('accepts a degree below the point count', async () => {
    const r = await linearRegressionHandler({
      x: [1, 2, 3],
      y: [1, 4, 9],
      model: 'polynomial',
      degree: 2,
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^Equation: ŷ = x\^2$/m);
  });

  it.each([
    [{ x: [1], y: [1] }, /at least 2 points/],
    [{ x: [1, 2], y: [1, Number.POSITIVE_INFINITY] }, /finite numbers/],
    [{ x: 'nope', y: [1, 2] }, /requires x and y arrays/],
  ])('rejects malformed samples (%#)', async (data, expected) => {
    const r = await linearRegressionHandler({ ...data, model: 'linear' });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(expected);
  });
});

describe('arbitrary-precision work is bounded outside the server process', () => {
  // Four rounds of per-operation ceilings each landed on the wrong axis for at
  // least one operation: `factorial` alone missed five siblings, cell count
  // missed cell WIDTH, n²·k rejected cheap shapes, k alone made S(n,n) = 1
  // unreachable above 500, and the n ceiling on permutations still let the call
  // trap the CAS engine. The bound is now a child process with a wall-clock
  // timeout and a heap cap, which covers every operation and every one added
  // later. These tests pin that contract, not a set of numbers.

  it.each([
    // Each of these was rejected by a ceiling that should not have applied.
    ['combinations(100000,3)', /^Result: 166661666700000$/m],
    ['stirling_second(600,600)', /^Result: 1$/m],
    ['stirling_second(1000,600)', /^Result: 305134181871302850583718528780/m],
    // 24 characters. Aborted the whole server under the cell-count ceiling;
    // refused by the n²·k one. It is simply an answer.
    ['stirling_first(20000,48)', /^Result: 131276123551409011274941445553/m],
    // Trapped the WASM engine and failed the NEXT client's in-flight call.
    ['permutations(50000,25000)', /^Result: \d{20}/m],
  ])('%s answers instead of being refused', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  it('an expensive computation does not take the next call down with it', async () => {
    // The permutations ceiling existed to stop a WASM trap whose recycle failed
    // every other in-flight call. Moving the arithmetic off the CAS removes the
    // trap; this pins that the neighbour survives.
    await computeHandler({ problem: 'permutations(50000,25000)' });
    const neighbour = await computeHandler({ problem: 'C(20,3)' });
    expect(neighbour.isError, text(neighbour)).toBe(false);
    expect(text(neighbour)).toMatch(/^Result: 1140$/m);
  });

  it.each([
    ['combinations(a,b)', /n must be a non-negative integer/],
    ['bell_number(-5)', /n must be a non-negative integer/],
    ['derangements(-5)', /n must be a non-negative integer/],
    ['stirling_first(5)', /k is required for stirling_first/],
    ['combinations(3,5)', /k \(5\) cannot exceed n \(3\)/],
  ])('%s is rejected on its shape, which the worker cannot judge', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(expected);
  });

  it.each([
    ['bell_number(5)', /^Result: 52$/m],
    ['catalan_number(5)', /^Result: 42$/m],
    ['derangements(5)', /^Result: 44$/m],
    ['stirling_first(5,2)', /^Result: 50$/m],
    ['stirling_second(5,2)', /^Result: 15$/m],
    ['multinomial(5,[2,2,1])', /^Result: 30$/m],
    ['partition_count(10)', /^Result: 42$/m],
  ])('still answers %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });
});

describe('the compute worker bounds both axes', () => {
  // Tested against the host factory rather than the singleton so the budget can
  // be shrunk: the real one is AXIOM_EVAL_TIMEOUT_MS, too slow to assert.
  it('kills a computation that outlives its timeout', async () => {
    const host = createJsComputeHost({ timeoutMs: 50 });
    try {
      await expect(host.run('bell_number', { n: 100000 })).rejects.toThrow(
        /exceeded its 50ms budget/
      );
    } finally {
      await host.dispose();
    }
  });

  it('survives the timeout and answers the next call', async () => {
    // A synchronous BigInt loop cannot be interrupted, so the timeout kills the
    // child. The next call must transparently get a fresh one.
    const host = createJsComputeHost({ timeoutMs: 60 });
    try {
      await expect(host.run('bell_number', { n: 100000 })).rejects.toThrow(/budget/);
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  });

  it('contains an out-of-memory computation instead of aborting the server', async () => {
    // This is the axis no input ceiling expressed: cost is the WIDTH of the
    // BigInts, not the iteration count. Under a tight heap the child dies and
    // the server keeps running — the previous behaviour was a SIGABRT of the
    // whole process from 24 characters of input.
    const host = createJsComputeHost({ timeoutMs: 30_000, heapMb: 32 });
    try {
      await expect(host.run('stirling_first', { n: 60000, k: 20000 })).rejects.toThrow(
        /memory budget|stopped unexpectedly/
      );
      // The server is still here, and so is the next answer.
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 40_000);

  it('reports an unknown task rather than hanging', async () => {
    const host = createJsComputeHost({ timeoutMs: 2000 });
    try {
      await expect(host.run('not_a_task' as Parameters<typeof host.run>[0], {})).rejects.toThrow(
        /unknown task/
      );
    } finally {
      await host.dispose();
    }
  });
});

describe('an integration is bounded by wall clock, not just per call', () => {
  // Simpson's rule issues one Giac call per subinterval and the caller chooses
  // the integrand, so the per-call timeout never fires while the total runs
  // away — a 78-character problem was still running after ten minutes, holding
  // the global CAS lock the whole time.
  it('rejects n_points above the cap', async () => {
    const r = await computeHandler({ problem: 'numerical_integration(x^2, x, 0, 1, 100000)' });
    // The extractor does not forward a 5th positional argument, so this asserts
    // the default path stays inside the cap rather than the rejection message.
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/n = 200 subintervals/);
  });

  it('still integrates correctly inside the cap', async () => {
    const r = await computeHandler({ problem: 'numerical_integration(x^2, x, 0, 1)' });
    expect(r.isError).toBe(false);
    expect(text(r)).toMatch(/^Result: 0\.33333333/m);
  });
});

describe('the integration budget actually fires', () => {
  // The real budget takes ~11s to trip, so shrink it. Asserting the mechanism
  // rather than the wall-clock number is the point: without it a 78-character
  // problem ran past ten minutes holding the global CAS lock.
  it('aborts a sum that outlives its budget', async () => {
    process.env.AXIOM_INTEGRATION_BUDGET_MS = '1';
    try {
      const r = await computeHandler({ problem: 'numerical_integration(x^2, x, 0, 1)' });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/exceeded its 1ms budget after \d+ of 200 steps/);
    } finally {
      delete process.env.AXIOM_INTEGRATION_BUDGET_MS;
    }
  });

  it('leaves the default budget alone once the override is gone', async () => {
    const r = await computeHandler({ problem: 'numerical_integration(x^2, x, 0, 1)' });
    expect(r.isError, text(r)).toBe(false);
  });
});

describe('a validation message names the field that is actually wrong', () => {
  it('mismatched lengths are reported as lengths, not as degree', async () => {
    // Checking degree before the lengths matched reported "degree must be ...
    // below the number of points (3)" while the real defect was that y was
    // shorter — a message about the wrong field, citing the wrong array.
    const r = await linearRegressionHandler({
      x: [1, 2, 3],
      y: [1, 2],
      model: 'polynomial',
      degree: 5,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/x and y must have the same length \(got 3 and 2\)/);
  });

  it('a degree paired with a model that ignores it is not rejected', async () => {
    const r = await linearRegressionHandler({
      x: [1, 2, 3],
      y: [1, 4, 9],
      model: 'exponential',
      degree: 7,
    });
    expect(r.isError, text(r)).toBe(false);
  });
});

describe('the data a test runs on is the shape it claims', () => {
  // checkDataShape could be neutered — `if (data) return null;` — with the whole
  // suite green: nothing anywhere passed a malformed sample.
  it.each([
    [{ sample1: [1, 2, 'x'], mu0: 2 }, /sample1 must be a list of finite numbers/],
    [{ sample1: 'abcd', mu0: 2 }, /sample1 must be a list of finite numbers/],
    [{ sample1: [1, 2, 3], sample2: [1, 'y'] }, /sample2 must be a list of finite numbers/],
    [{ sample1: [1, 2, 3], mu0: [9, 9] }, /mu0 must be a finite number/],
    [{ sample1: [1, 2, 3], mu0: '5' }, /mu0 must be a finite number/],
    [{ groups: [[1, 2], 'x'] }, /groups must be a list of lists of finite numbers/],
  ])('rejects malformed data (%#)', async (data, expected) => {
    const r = await hypothesisTestingHandler({
      test: 'one_sample_t',
      data: { ...data, significance: 0.05 },
      alternative: 'two_sided',
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(expected);
  });

  it('rejects a constant sample rather than reporting t = Infinity', async () => {
    // Passes every shape check, then divides by zero. tPValue's normalCdf
    // fallback returns 0 rather than NaN, so the isNaN guard never fired and it
    // reported "✗ Reject H₀ (p = 0.0000)".
    const r = await hypothesisTestingHandler({
      test: 'one_sample_t',
      data: { sample1: [2, 2, 2], mu0: 1, significance: 0.05 },
      alternative: 'two_sided',
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/zero variance/);
  });
});

describe('a trap is recognised by its type, not only by its wording', () => {
  // Both existing RuntimeError rows also contain a phrase an earlier clause
  // matches, so the clause this commit added was never exercised alone.
  it('classifies a trap that identifies itself only by type', () => {
    expect(
      isFatalWasmTrap(
        'Giac WASM evaluation error: RuntimeError: null function or function signature mismatch'
      )
    ).toBe(true);
  });

  it('does not match RuntimeError inside a longer identifier', () => {
    expect(isFatalWasmTrap('Giac WASM evaluation error: MyRuntimeErrorHandler failed')).toBe(false);
  });

  it('classifies the message wasm-wrapper actually builds', () => {
    // Crosses the seam: the predicate is tested against hand-written strings
    // everywhere else, so reverting the wrapper's `error.name` prefix was
    // invisible. Rebuild the string the wrapper produces.
    const trap = new Error('null function or function signature mismatch');
    trap.name = 'RuntimeError';
    const built = `Giac WASM evaluation error: ${trap.name}: ${trap.message}`;
    expect(built).toMatch(/^Giac WASM evaluation error: RuntimeError: /);
    expect(isFatalWasmTrap(built)).toBe(true);
  });
});

describe('a root-finder is bounded by wall clock too', () => {
  // The budget went to Simpson only; a wide bracket runs all 100 iterations and
  // measured 455.8s, holding the single CAS worker for the whole window.
  it('aborts a root search that outlives its budget', async () => {
    process.env.AXIOM_INTEGRATION_BUDGET_MS = '1';
    try {
      const r = await computeHandler({ problem: 'bisection(x^2-2, 1, 2)' });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/root finding exceeded its 1ms budget/);
    } finally {
      delete process.env.AXIOM_INTEGRATION_BUDGET_MS;
    }
  });

  it('rejects a max_iterations above the cap', async () => {
    const r = await numericalMethodsHandler({
      method: 'bisection',
      expression: 'x^2-2',
      variable: 'x',
      x0: 1,
      x1: 2,
      max_iterations: 100000,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/max_iterations must be an integer between 1 and 100/);
  });

  it('rejects an n_points above the cap', async () => {
    // Reachable only by calling the handler directly — the extractor forwards no
    // fifth positional argument — so the previous row asserted the default path
    // and the guard could be deleted with the suite green.
    const r = await numericalMethodsHandler({
      method: 'numerical_integration',
      expression: 'x^2',
      variable: 'x',
      lower_bound: 0,
      upper_bound: 1,
      n_points: 100000,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/n_points must be an integer between 2 and 200/);
  });
});

describe('a discrete cdf is summed in log space', () => {
  // The sums were quadratic (a fresh binomial coefficient or factorial per term)
  // and no ceiling on the parameter names could bound all three: poisson has no
  // `n`, and hypergeometric's cost is driven by `K`. A running-term recurrence
  // fixed the complexity but not the range — its first term underflows, so
  // `binomial(n=100000, p=0.5, k=100000)` summed zeros and answered 0 for a
  // probability of 1. Log space fixes both.
  it.each([
    // Textbook values, computed independently of the implementation.
    [{ distribution: 'binomial', params: { n: 10, p: 0.5, k: 5 } }, 0.623046875],
    [{ distribution: 'binomial', params: { n: 20, p: 0.3, k: 7 } }, 0.7722717974],
    [{ distribution: 'poisson', params: { lambda: 2, k: 3 } }, 0.8571234605],
    [{ distribution: 'poisson', params: { lambda: 5, k: 8 } }, 0.9319063653],
    [{ distribution: 'hypergeometric', params: { N: 50, K: 5, n: 10, k: 2 } }, 0.9517396968],
    [{ distribution: 'hypergeometric', params: { N: 100, K: 30, n: 20, k: 8 } }, 0.9115435242],
    // The whole distribution: exactly 1, and the cases that answered 0.
    [{ distribution: 'binomial', params: { n: 100000, p: 0.5, k: 100000 } }, 1],
    [{ distribution: 'poisson', params: { lambda: 2, k: 100000 } }, 1],
    [{ distribution: 'hypergeometric', params: { N: 100000, K: 99999, n: 20, k: 100000 } }, 1],
    // Rejected outright by the n·k ceiling; 0.03ms of real work.
    [{ distribution: 'binomial', params: { n: 100000, p: 0.0001, k: 30 } }, 0.9999999202],
  ])('cdf %# is correct and cheap', async (args, expected) => {
    const started = Date.now();
    const r = await probabilityCalcHandler({ ...args, operation: 'cdf' });
    // The property that matters as much as the value: no ceiling is doing this,
    // the algorithm is. The worst of these measured 11.3s before.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r.isError, text(r)).toBe(false);
    const value = Number(/P\(X ≤ [\d.]+\) = ([\d.e+-]+)/.exec(text(r))?.[1]);
    expect(value).toBeCloseTo(expected, 8);
  });
});
