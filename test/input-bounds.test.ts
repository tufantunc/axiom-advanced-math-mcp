import { describe, it, expect } from 'vitest';
import { isFatalWasmTrap } from '../src/server/giac/fatal-trap.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { hypothesisTestingHandler } from '../src/server/tools/hypothesis-testing.js';
import { linearRegressionHandler } from '../src/server/tools/linear-regression.js';
import { numericalMethodsHandler } from '../src/server/tools/numerical-methods.js';
import { createJsComputeHost } from '../src/server/js-compute/index.js';
import { probabilityCalcHandler } from '../src/server/tools/probability-calc.js';
import { plotToSvg } from '../src/server/tools/plot/render.js';

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
        /exceeded its time budget/
      );
    } finally {
      await host.dispose();
    }
  });

  it('survives the timeout and answers the next call', async () => {
    // A synchronous BigInt loop cannot be interrupted, so the timeout kills the
    // child. The next call must transparently get a fresh one.
    //
    // 2s rather than the 50ms used above: this test needs the SECOND call to
    // succeed, and under a parallel suite run a fork plus a cold start can
    // itself outlast a tight budget. bell_number(100000) takes minutes, so the
    // first call still times out reliably.
    const host = createJsComputeHost({ timeoutMs: 2000 });
    try {
      await expect(host.run('bell_number', { n: 100000 })).rejects.toThrow(/budget/);
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 30_000);

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
    // reported "✗ Reject H₀ (p = 0.0000)". The guard now lives beside the
    // statistic rather than on the raw sample, so the wording changed with it.
    const r = await hypothesisTestingHandler({
      test: 'one_sample_t',
      data: { sample1: [2, 2, 2], mu0: 1, significance: 0.05 },
      alternative: 'two_sided',
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/no variation|zero standard error/);
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

describe('mathjs evaluation is bounded outside the server process', () => {
  // It ran synchronously on the main thread, where an unbounded expression
  // cannot be interrupted: `1:20000000` is eleven characters and blocked the
  // event loop for 20s while building a 532MB response. A guard on range syntax
  // would not have been enough — the cost shows up as time, as memory, or as
  // response size depending on the expression, so all three are bounded and none
  // of the bounds names a mathjs construct.
  it.each([
    ['1:200000', /response limit/],
    ['1:2000000', /response limit/],
  ])('%s is refused on response size', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(expected);
    // The refusal itself must be small — the point is not to ship 48MB.
    expect(text(r).length).toBeLessThan(500);
  });

  it('does not blame other computations when nothing else is running', async () => {
    // The worker acked `start` only AFTER resolving the task, and resolving the
    // first mathjs task on a fresh worker runs an `import` that worker.ts prices
    // at ~170ms. That import was therefore charged to the host's ADMISSION
    // budget, which is sized by timeoutMs — so `2+2`, on an idle machine, with
    // nothing queued behind anything, was refused with "the compute worker was
    // busy with other computations". There were no other computations.
    //
    // Measured: ready at +27ms, start ack at +205ms on an idle machine; +40ms
    // and +340ms under a loaded one. That is why this surfaced as a flake in
    // `a runaway expression is refused` (400ms budget) only during a parallel
    // suite run. 100ms here is under the import cost either way, which makes it
    // deterministic instead of load-dependent.
    const host = createJsComputeHost({ timeoutMs: 100 });
    try {
      const outcome = await host.run('mathjs_evaluate', { expression: '2+2' }).then(
        (v) => v,
        (e: Error) => e.message
      );
      // Whatever the verdict is, it must not blame a caller that is alone.
      expect(outcome).not.toMatch(/busy with other computations/);
    } finally {
      await host.dispose();
    }
  });

  it('a runaway expression is refused on time or memory, not answered', async () => {
    const host = createJsComputeHost({ timeoutMs: 400, heapMb: 64 });
    try {
      await expect(host.run('mathjs_evaluate', { expression: '1:50000000' })).rejects.toThrow(
        /budget|response limit/
      );
      // And the worker is usable again straight after.
      await expect(host.run('mathjs_evaluate', { expression: '2+2' })).resolves.toContain('"4"');
    } finally {
      await host.dispose();
    }
  }, 30_000);

  it.each([
    ['2+2', '4'],
    ['sin(pi/4)', '0.7071067811865475'],
    ['ln(e)', '1'],
    ['sqrt(2)*100', '141.4213562373095'],
  ])('still evaluates %s', async (expression, expected) => {
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const raw = await host.run('mathjs_evaluate', { expression });
      expect((JSON.parse(raw) as { value: string }).value).toBe(expected);
    } finally {
      await host.dispose();
    }
  });

  it('keeps mathjs import and createUnit disabled in the worker', async () => {
    // The two in-process instances this replaces both disabled these per mathjs's
    // security guidance; the move must not quietly drop that.
    const host = createJsComputeHost({ timeoutMs: 5000 });
    try {
      await expect(host.run('mathjs_evaluate', { expression: 'import({evil:1})' })).rejects.toThrow(
        /import is disabled/
      );
      await expect(host.run('mathjs_evaluate', { expression: 'createUnit("zz")' })).rejects.toThrow(
        /createUnit is disabled/
      );
    } finally {
      await host.dispose();
    }
  });

  it('bounds the plot sampler too, and still plots an ordinary function', async () => {
    // 200 samples is fixed, but the CALLER writes the expression:
    // `sum(1:2000000)*x` measured 10.9s across those points, and plot is not
    // behind the CAS session mutex, so it stalled every client directly.
    const host = createJsComputeHost({ timeoutMs: 500 });
    try {
      await expect(
        host.run('mathjs_sample', {
          expression: 'sum(1:2000000)*x',
          variable: 'x',
          xMin: -5,
          xMax: 5,
          numPoints: 200,
        })
      ).rejects.toThrow(/budget/);
    } finally {
      await host.dispose();
    }

    const plotted = await plotToSvg({ expression: 'sin(x)', xMin: -5, xMax: 5 });
    expect(plotted.points).toBe(200);
    expect(plotted.segments).toBe(1);
  }, 30_000);
});

describe('the plot sampler kept the behaviour it had in-process', () => {
  // These two details were both wrong in the first attempt at moving this code,
  // and nothing caught it: a fixed jump threshold instead of the relative one,
  // and the y-range padding dropped. They are the reason the sampler is two
  // passes — the threshold is judged against a range only known once every point
  // is sampled — so pin them rather than the fact that it runs.
  it('pads the y range by 5% of the sampled span', async () => {
    const r = await plotToSvg({ expression: 'sin(x)', xMin: -5, xMax: 5 });
    // Sampled span is very nearly [-1, 1]; 5% of 2 is 0.1 at each end.
    expect(r.yMin).toBeCloseTo(-1.0999, 3);
    expect(r.yMax).toBeCloseTo(1.0999, 3);
  });

  it('pads a flat function by ±1 rather than by 5% of zero', async () => {
    const r = await plotToSvg({ expression: '5', xMin: -5, xMax: 5 });
    expect(r.yMin).toBe(4);
    expect(r.yMax).toBe(6);
  });

  it('splits at a pole, judging the jump against the raw sampled span', async () => {
    // The threshold is half the span measured BEFORE padding. Padding first was
    // the bug: it put the threshold at 2.2x the raw span while no adjacent jump
    // can exceed the raw span, so this branch could never fire and 1/x^3 was
    // drawn as one curve straight through its pole — while plot's own tool
    // description promised poles were split.
    const r = await plotToSvg({ expression: '1/x^3', xMin: -1, xMax: 1 });
    expect(r.segments).toBe(2);
  });

  it.each([
    ['1/x', -10, 10, 2],
    ['tan(x)', -10, 10, 3],
    ['1/(x^2-4)', -10, 10, 3],
  ])('splits %s into %i segments', async (expression, xMin, xMax, segments) => {
    const r = await plotToSvg({ expression, xMin, xMax });
    expect(r.segments).toBe(segments);
  });

  it.each([
    // Steep but continuous: the largest adjacent step is a fraction of the span,
    // so none of these may be split. `100000*x^2` and `1e6*x` are the adversarial
    // cases for a threshold expressed as a fraction of the span.
    ['x^2', -10, 10],
    ['exp(x)', -1, 20],
    ['1e6*x', -10, 10],
    ['100000*x^2', -10, 10],
    ['x^7', -5, 5],
    ['x^2+sin(10*x)', -10, 10],
    ['atan(x)', -50, 50],
  ])('does not split the continuous curve %s', async (expression, xMin, xMax) => {
    const r = await plotToSvg({ expression, xMin, xMax });
    expect(r.segments).toBe(1);
  });
});

/**
 * The worker is a process-wide singleton shared by `compute`, `quick_calc`,
 * `exact_value` and `plot`, which makes anything it remembers a cross-caller
 * channel. Each of these failed before the guard it exercises existed.
 */
describe('one caller cannot change what the next caller is told', () => {
  it('does not let a plot expression reconfigure later arithmetic', async () => {
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const before = await host.run('mathjs_evaluate', { expression: '0.1+0.2' });
      expect(JSON.parse(before).value).toBe('0.30000000000000004');

      // 32 bytes through an unauthenticated tool. `config` mutates the shared
      // instance, so this permanently changed every later caller's answer.
      await host
        .run('mathjs_sample', {
          expression: 'config({number:"BigNumber"})*0+x',
          variable: 'x',
          xMin: -10,
          xMax: 10,
          numPoints: 200,
        })
        .catch(() => undefined);

      const after = await host.run('mathjs_evaluate', { expression: '0.1+0.2' });
      expect(JSON.parse(after).value).toBe('0.30000000000000004');
    } finally {
      await host.dispose();
    }
  });

  it('keeps formatting intact — the guard must not shadow config', async () => {
    // Disabling `config` outright breaks mathjs internally: Matrix.toString()
    // reads it, and `1:5` degraded to `1,2,3,4,5`.
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      await host
        .run('mathjs_evaluate', { expression: 'config({number:"BigNumber"})' })
        .catch(() => undefined);
      const r = await host.run('mathjs_evaluate', { expression: '1:5' });
      expect(JSON.parse(r).value).toBe('[1, 2, 3, 4, 5]');
    } finally {
      await host.dispose();
    }
  });

  it('fails only the computation at fault, not the ones queued behind it', async () => {
    const host = createJsComputeHost({ timeoutMs: 10_000, heapMb: 64 });
    try {
      const settled = await Promise.allSettled([
        host.run('mathjs_evaluate', { expression: '1:20000000' }),
        host.run('mathjs_evaluate', { expression: '2+3' }),
        host.run('mathjs_evaluate', { expression: 'sin(pi/4)' }),
        host.run('bell_number', { n: 5 }),
      ]);
      expect(settled[0].status).toBe('rejected');
      // The innocents used to be rejected with the offender's own error, which
      // told `2+3` that it had exhausted a 512MB heap.
      expect(settled.slice(1).map((s) => s.status)).toEqual([
        'fulfilled',
        'fulfilled',
        'fulfilled',
      ]);
      expect(JSON.parse((settled[1] as PromiseFulfilledResult<string>).value).value).toBe('5');
      expect((settled[3] as PromiseFulfilledResult<string>).value).toBe('52');
    } finally {
      await host.dispose();
    }
  }, 30_000);
});

describe('a non-answer is an error, not an answer', () => {
  it.each([['#'], ['# hello'], ['null']])(
    'refuses %s rather than answering "undefined"',
    async (problem) => {
      // `String(undefined)` is "undefined", where the `.toString()` it replaced
      // threw — so this answered with isError:false and exit 0.
      const r = await computeHandler({ problem });
      expect(r.isError, `${problem} -> ${text(r)}`).toBe(true);
    }
  );

  it('refuses a plot whose expression never evaluates', async () => {
    await expect(plotToSvg({ expression: 'notafunction(x)', xMin: -10, xMax: 10 })).rejects.toThrow(
      /Undefined function/
    );
  });
});

describe('precision is honoured, and only when asked for', () => {
  it('leaves the default answer untouched', async () => {
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const r = await host.run('mathjs_evaluate', { expression: 'sqrt(2)' });
      expect(JSON.parse(r).value).toBe('1.4142135623730951');
    } finally {
      await host.dispose();
    }
  });

  it.each([
    [3, '1.41'],
    [10, '1.414213562'],
  ])('formats to %i significant digits when given', async (precision, expected) => {
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const r = await host.run('mathjs_evaluate', { expression: 'sqrt(2)', precision });
      expect(JSON.parse(r).value).toBe(expected);
    } finally {
      await host.dispose();
    }
  });

  it("does not leak `precision` into the caller's expression namespace", async () => {
    // It was passed as mathjs's SCOPE, so `precision+1` answered 11.
    const r = await computeHandler({ problem: 'precision+1' });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/Undefined symbol/);
  });
});

describe('an oversized result is refused before it is built', () => {
  it('rejects on element count rather than stringifying 24 million characters', async () => {
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const started = Date.now();
      await expect(host.run('mathjs_evaluate', { expression: '1:2000000' })).rejects.toThrow(
        /2000000 elements/
      );
      // Measuring the built string first cost ~1.8s here. Generous bound: this
      // asserts the pre-check exists at all, not a specific machine's speed.
      expect(Date.now() - started).toBeLessThan(1500);
    } finally {
      await host.dispose();
    }
  }, 30_000);

  it('refuses LaTeX for an expression too deeply nested to render', async () => {
    // Capping the OUTPUT cannot bound this: 157 characters of nested sqrt burn a
    // whole 10s budget and produce 155 characters of LaTeX.
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const expression = 'sqrt('.repeat(26) + '2' + ')'.repeat(26);
      await expect(host.run('mathjs_evaluate', { expression, latex: true })).rejects.toThrow(
        /nests more than 20 levels/
      );
      // A normal depth still renders.
      const ok = await host.run('mathjs_evaluate', { expression: '2+3*4', latex: true });
      expect(JSON.parse(ok).latex).toBe('2+3\\cdot4');
    } finally {
      await host.dispose();
    }
  }, 30_000);
});

describe('a burst is shed rather than queued without limit', () => {
  it('refuses past the queue depth, and says so truthfully', async () => {
    const host = createJsComputeHost({ timeoutMs: 10_000, maxQueueDepth: 3 });
    try {
      const settled = await Promise.allSettled(
        Array.from({ length: 6 }, () => host.run('mathjs_evaluate', { expression: '2+2' }))
      );
      const refused = settled.filter(
        (s) => s.status === 'rejected' && /busy/.test((s.reason as Error).message)
      );
      // The overflow must be refused as busy — not left to wait and then be
      // reported as an oversized computation, which is what the single
      // enqueue-time budget did.
      expect(refused.length).toBe(3);
      expect(settled.filter((s) => s.status === 'fulfilled').length).toBe(3);
    } finally {
      await host.dispose();
    }
  }, 30_000);
});

describe("an initial condition's cost is bounded, not only its size", () => {
  // `y(0)=50000!` is six characters of value, nests zero deep, and is not an
  // exponent, so neither of the two bounds this channel already had could see
  // it. Measured on ed5917e it killed the shared worker outright — the caller
  // got "memory access out of bounds" and the next request in the same process
  // got "Giac worker exited (code 1)".
  //
  // Every row here is a real kill on that build, in a spelling the guard has to
  // recognise separately: the postfix operator, Giac's named alias for it, and a
  // nested operand whose longest digit run is one character.
  it.each([
    ["desolve(y'=y, y(0)=50000!, x, y)", /a factorial of 50000/],
    ["desolve(y'=y, y(0)=factorial(50000), x, y)", /a factorial of 50000/],
    ["desolve(y'=y, y(0)=(8!)!, x, y)", /a factorial this cannot bound \(8!\)/],
    ["desolve(y'=y, y(0)=factorial(9)!, x, y)", /a factorial this cannot bound/],
    // The condition written as a MEMBER of the equation argument rather than
    // beside it. Same request, same command, and it reached the worker through a
    // different door.
    ["desolve([y'=y, y(0)=50000!], x, y)", /a factorial of 50000/],
    // The system path is not the counter-example it looks like: it had the same
    // hole, and merely reported its own worker death as a refusal.
    ["desolve([y'=z, z'=-y, y(0)=50000!, z(0)=0], x)", /a factorial of 50000/],
  ])('refuses %s before the CAS sees it', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).toMatch(/initial conditions are ordinary numbers/);
    // The refusal must be reached without an engine call at all. A guard that
    // fires after the trap is not a guard — the system path's version of this
    // refused with a clean, correct message having already killed the worker.
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
    // And the shared worker is still usable afterwards, which is the actual
    // severity: a trap here recycles the one forked engine every caller shares,
    // and worker-host.ts's recycle() rejects everything already in flight. On
    // ed5917e the row above this one killed the worker and THIS assertion is
    // what a clean refusal buys. Asserted rather than inferred from elapsed
    // time, which was the first version of this check and is a flake under a
    // loaded runner.
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
    expect(text(after)).toMatch(/^Result: 2\*exp\(x\)$/m);
  });

  // The two axes this channel already had, now applied to the single-equation
  // path too. Measured in the shape it actually builds,
  // `desolve((y'=y) and (y(0)=…),x,y)`: a flat condition answers at 1,006
  // characters and traps at 1,406.
  it('refuses a condition longer than the bound, on the single-equation path', async () => {
    const value = '1' + '*2'.repeat(700);
    const r = await computeHandler({ problem: `desolve(y'=y, y(0)=${value}, x, y)` });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/initial condition of \d+ characters, above the 280/);
  });

  it('refuses a condition nested deeper than the bound', async () => {
    const value = '('.repeat(101) + '1' + ')'.repeat(101);
    const r = await computeHandler({ problem: `desolve(y'=y, y(0)=${value}, x, y)` });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/nested \d+ deep, above the 100/);
  });

  it('refuses an exponent too large to be meant, on the single-equation path', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=10^100000, x, y)" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/an exponent of 100000/);
  });

  // Both paths must word the same rule for their own shape. The single-equation
  // prefix is the only thing that differs, and if these two ever diverge it is
  // because someone added a second copy of the rule.
  it('words the identical rule for an equation and for a system', async () => {
    const one = await computeHandler({ problem: "desolve(y'=y, y(0)=50000!, x, y)" });
    const many = await computeHandler({
      problem: "desolve([y'=z, z'=-y, y(0)=50000!, z(0)=0], x)",
    });
    expect(text(one)).toMatch(/^Error: solve_ode cannot solve this equation — it gives /m);
    expect(text(many)).toMatch(/^Error: solve_ode cannot solve this system — it gives /m);
    const tail = (s: string): string => s.slice(s.indexOf(' — it '));
    expect(tail(text(one))).toBe(tail(text(many)));
  });

  // An oversized condition is a value this router READ correctly, so it must not
  // be reported as a shape it failed to understand — that would tell the caller
  // to rewrite something already right.
  it('does not call an oversized condition an unrecognised argument', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=50000!, x, y)" });
    expect(text(r)).not.toMatch(/does not understand the argument/);
  });

  // Positional order, the guarantee the rest of this extractor's refusals keep:
  // the equation is argument zero, so a condition folded into it outranks a
  // garbage argument written after it.
  it('reports the equation before a later unrecognised argument', async () => {
    const r = await computeHandler({ problem: "desolve([y'=y, y(0)=50000!], x, y, zzz)" });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/a factorial of 50000/);
    expect(text(r)).not.toMatch(/zzz/);
  });

  // Two oversized conditions, one inside the equation argument and one beside
  // it, is the only input where the precedence is observable — that row above
  // reaches the same message either way, so it does not pin this. Reversing the
  // two makes the second condition the one reported for a request whose first
  // one is already out of bounds.
  it('reports the condition inside the equation before one written after it', async () => {
    const r = await computeHandler({
      problem: "desolve([y'=y, y(0)=50000!], y(0)=10^100000, x, y)",
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/a factorial of 50000/);
    expect(text(r)).not.toMatch(/an exponent of 100000/);
    // And the trailing one is still reported when the equation's own is fine,
    // so this is an ordering assertion rather than the equation simply winning.
    const other = await computeHandler({
      problem: "desolve([y'=y, y(0)=1], y(0)=10^100000, x, y)",
    });
    expect(other.isError).toBe(true);
    expect(text(other)).toMatch(/an exponent of 100000/);
  });

  // The false-refusal side, which is the whole cost of a bound like this. Every
  // one of these answers on ed5917e and must keep answering: ordinary numbers,
  // symbolic endpoints, symbolic values, second-order IVPs, BVPs, both system
  // spellings, and factorials small enough to mean something.
  //
  // Matched against the Result LINE, this file's convention, and not with
  // `toContain`: the response also carries a `Command:` line echoing the
  // caller's own text, so `y(pi)=0` and `y(L)=0` — whose answer is `0` — passed
  // `toContain('0')` on the echo alone and would have passed on `5*exp(x)` too.
  it.each([
    ["desolve(y'=y, y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y, y(2)=3, x, y)", /^Result: 3\/exp\(2\)\*exp\(x\)$/m],
    ["desolve(y'=y, y(pi)=0, x, y)", /^Result: 0$/m],
    ["desolve(y'=y, y(L)=0, x, y)", /^Result: 0$/m],
    ["desolve(y'=y, y(a)=1, x, y)", /^Result: 1\/exp\(a\)\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=sqrt(2), x, y)", /^Result: √2\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=exp(1), x, y)", /^Result: exp\(1\)\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=1/3, x, y)", /^Result: 1\/3\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=-2, x, y)", /^Result: -2\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=2^10, x, y)", /^Result: 1024\*exp\(x\)$/m],
    ["desolve(y''=-y, y(0)=1, y'(0)=0, x, y)", /^Result: cos\(x\)$/m],
    ["desolve(y''=-y, y(0)=0, y(pi/2)=1, x, y)", /^Result: sin\(x\)$/m],
    ["desolve([y'=y, y(0)=1], x, y)", /^Result: exp\(x\)$/m],
    ["desolve(y'=y and y(0)=1, x, y)", /^Result: exp\(x\)$/m],
    ["desolve([y'=z, z'=-y, y(0)=1, z(0)=0], x)", /^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m],
    ["desolve([y'=z, z'=-y], y(0)=1, z(0)=0, x)", /^Result: \[\[cos\(x\),-sin\(x\)\]\]$/m],
    // A factorial is not itself suspicious. The bound is on its argument, and
    // 1000! — a 2,568-digit number — is the largest one this admits.
    ["desolve(y'=y, y(0)=5!, x, y)", /^Result: 120\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=20!, x, y)", /^Result: 2432902008176640000\*exp\(x\)$/m],
    // A bare symbol denotes no literal, and Giac leaves it unevaluated, so it is
    // left alone rather than refused — and `factorial(n)` must agree with it,
    // since giving one operator two verdicts by spelling is this area's
    // most-repeated defect.
    ["desolve(y'=y, y(0)=n!, x, y)", /^Result: n!\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=factorial(n), x, y)", /^Result: n!\*exp\(x\)$/m],
    // A symbol whose NAME ENDS IN DIGITS is still a symbol. Reading a digit run
    // leftward instead of a whole token refused these — `k2000!` as a factorial
    // of 2,000 — and a one-character `n` is the only symbol shape that never
    // exercises that read.
    ["desolve(y'=y, y(0)=k2000!, x, y)", /^Result: k2000!\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=y_2000!, x, y)", /^Result: y_2000!\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=n50000!, x, y)", /^Result: n50000!\*exp\(x\)$/m],
    // A parenthesised operand still reads as the literal it is.
    ["desolve(y'=y, y(0)=(20)!, x, y)", /^Result: 2432902008176640000\*exp\(x\)$/m],
    // A digit run that is a whole token, next to punctuation rather than to
    // more of a token.
    ["desolve(y'=y, y(0)=1/2!, x, y)", /^Result: 1\/2\*exp\(x\)$/m],
    // A DECIMAL operand is a readable literal, not an unreadable token. `.` had
    // to become a token character to stop `1.0e4!` being read as `4`, and that
    // refused these until the bound learned to count them rounded up.
    ["desolve(y'=y, y(0)=1.5!, x, y)", /^Result: 1\.32934038818\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=0.5!, x, y)", /^Result: 0\.886226925453\*exp\(x\)$/m],
    // The named spelling needs a left boundary, or any symbol ending in
    // "factorial" is read as one: this was refused as a factorial of 50,000.
    ["desolve(y'=y, y(0)=myfactorial(50000), x, y)", /^Result: myfactorial\(50000\)\*exp\(x\)$/m],
  ])('still answers %s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // implausibleMagnitude is applied to every system equation's RIGHT-HAND SIDE
  // too, not only to conditions, so a symbol ending in digits had to survive
  // there as well: `y'=z*k2000!` was refused as a right-hand side of implausible
  // magnitude. Pinned on the Result line, not the whole response, whose
  // `Command:` line echoes the caller's own `k2000!` back.
  it('does not refuse a symbol ending in digits on a system right-hand side', async () => {
    const r = await computeHandler({ problem: "desolve([y'=z*k2000!, z'=-y], x)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/^Result: .*k2000!/m);
  });

  // A digit run that is only the TAIL of a token is not the operand. Reading it
  // as one read `1e5!` as a factorial of 5 — admitting a 456,574-digit number —
  // and made the two spellings disagree, since `factorial(1e5)` takes the whole
  // group and was already refused.
  it.each([
    ["desolve(y'=y, y(0)=1e5!, x, y)", /a factorial this cannot bound \(1e5\)/],
    ["desolve(y'=y, y(0)=1.0e4!, x, y)", /a factorial this cannot bound \(1\.0e4\)/],
    ["desolve(y'=y, y(0)=0x10!, x, y)", /a factorial this cannot bound \(0x10\)/],
    ["desolve(y'=y, y(0)=factorial(1e5), x, y)", /a factorial this cannot bound \(1e5\)/],
  ])('refuses %s rather than reading the tail of the token', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
  });

  // A system's trailing conditions are folded into its member list and
  // re-checked by validateSystemShape, so the refusal must carry the SYSTEM
  // wording. Bounding them in the extractor instead called a system an equation.
  it('words a system refusal as a system whichever side the condition is on', async () => {
    const inList = await computeHandler({
      problem: "desolve([y'=z, z'=-y, y(0)=50000!, z(0)=0], x)",
    });
    const beside = await computeHandler({
      problem: "desolve([y'=z, z'=-y], y(0)=50000!, z(0)=0, x)",
    });
    for (const r of [inList, beside]) {
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/^Error: solve_ode cannot solve this system — it gives /m);
      expect(text(r)).toMatch(/a factorial of 50000/);
      expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
    }
  });

  // An unbalanced named call must never SHORTEN the operand: slicing one short
  // of the end read `factorial(10000` as 1000 and passed it, and truncation is
  // the one direction a bound must not fail in. Taking the whole tail leaves it
  // either a readable literal that is bounded like any other or unreadable and
  // refused — these two land on the second, because the bracketed argument
  // carries its `]` into the operand.
  it.each([
    "desolve([y'=y, y(0)=factorial(10000], x, y)",
    "desolve([y'=y, y(0)=factorial(1001], x, y)",
  ])('refuses the unbalanced %s', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/a factorial this cannot bound/);
  });

  // And the other landing: a bare unbalanced tail that IS a readable literal is
  // bounded as that literal rather than truncated to a passing one. Truncation
  // read this exact input as `1000` — inside the bound — and let it through.
  it('bounds an unbalanced tail as the literal it is, not a shortened one', async () => {
    const r = await computeHandler({ problem: "y'=y, y(0)=factorial(10000" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/a factorial of 10000/);
  });

  it('still answers the largest factorial the bound admits', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=1142!, x, y)" });
    expect(r.isError, text(r)).toBe(false);
    // 1142! is 2,998 digits, just inside the 3,000. Asserting the leading digits
    // pins that the value was computed rather than echoed.
    expect(text(r)).toMatch(/^Result: 65818352720512045295/m);
  });

  it('refuses one past the bound and admits the bound itself', async () => {
    const inside = await computeHandler({ problem: "desolve(y'=y, y(0)=1142!, x, y)" });
    const outside = await computeHandler({ problem: "desolve(y'=y, y(0)=1143!, x, y)" });
    expect(inside.isError, text(inside)).toBe(false);
    expect(outside.isError, text(outside)).toBe(true);
    // 2,998 digits in, 3,001 out. The message reports the count, so the
    // boundary is visible rather than inferred.
    expect(text(outside)).toMatch(/a factorial of 1143, which denotes a 3001-digit number/);
  });

  // The axis is the size of the number the WHOLE condition denotes, and bounding
  // each factorial's argument alone did not express it: eleven copies of a
  // per-argument maximum of 1,000 is 70 characters, nests zero deep, and killed
  // the shared worker — measured, 28,248 denoted digits against a cliff that
  // turns over between 25,800 and 27,800 however the caller composes it.
  it('refuses factorials that compose past the cliff, each one admissible alone', async () => {
    const eleven = Array.from({ length: 11 }, () => '1000!').join('*');
    const r = await computeHandler({ problem: `desolve(y'=y, y(0)=${eleven}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/factorials denoting 28248 digits together/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
    // Each factor on its own is admitted, so this refusal cannot come from a
    // per-argument bound.
    const alone = await computeHandler({ problem: "desolve(y'=y, y(0)=1000!, x, y)" });
    expect(alone.isError, text(alone)).toBe(false);
    // And the worker the composition used to kill still answers.
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
    expect(text(after)).toMatch(/^Result: 2\*exp\(x\)$/m);
  });

  it('sums the composition on the system path too', async () => {
    const r = await computeHandler({
      problem: "desolve([y'=z, z'=-y, y(0)=1000!*1000!, z(0)=0], x)",
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/^Error: solve_ode cannot solve this system — it gives /m);
    expect(text(r)).toMatch(/factorials denoting 5136 digits together/);
  });

  // The implicit route builds no `desolve(` of its own, but calculus.ts builds
  // one from its args, so it reaches the same trap. Gating the bound on the verb
  // made the verdict depend on how the request was typed: on ed5917e
  // `desolve([y'=y, y(0)=50000!], x, y)` was refused while `[y'=y, y(0)=50000!]`
  // killed the worker AND the call queued behind it.
  it.each(["[y'=y, y(0)=50000!]", "y'=y, y(0)=50000!", "y''=-y, y(0)=50000!, y'(0)=0"])(
    'refuses the verbless %s',
    async (problem) => {
      const r = await computeHandler({ problem });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/a factorial of 50000/);
      expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
      const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
      expect(after.isError, text(after)).toBe(false);
    }
  );
});
