import { describe, it, expect } from 'vitest';
import { isFatalWasmTrap } from '../src/server/giac/fatal-trap.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { hypothesisTestingHandler } from '../src/server/tools/hypothesis-testing.js';
import { linearRegressionHandler } from '../src/server/tools/linear-regression.js';
import { numericalMethodsHandler } from '../src/server/tools/numerical-methods.js';
import { parseOdeSystem, validateSystemShape } from '../src/server/tools/ode-system-shape.js';
import { conditionBoundError } from '../src/server/tools/ode-condition-bounds.js';
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
    // refused by the n²·k one. It is simply an answer. n=12000, not the
    // original 20000: the DP takes ~1s on the dev machine and CI runners
    // are 3-6x slower against the worker's default 10s budget — 12000 keeps
    // n²·k ≈ 6.9×10⁹ (far above every retired ceiling) with 2.5x headroom.
    ['stirling_first(12000,48)', /^Result: 66011291014257532782019614647237/m],
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
    // whole process from 24 characters of input. The heap fills in ~8s on the
    // dev machine; CI runners are 3-6x slower, so the wall clock is 150s —
    // matching the js-compute-error-codes sibling that runs this same input
    // and documented 30s losing the race under load. The memory budget must
    // be the bound that fires, never the timeout; work to fill a heap of B
    // bytes is bounded regardless of k, and machine speed scales it uniformly.
    // The memory-vs-timeout axis itself is enforced by the js-compute-error-
    // codes sibling, which runs this same input and asserts the out_of_memory
    // code; this row's unique pin is the survival assertion below.
    const host = createJsComputeHost({ timeoutMs: 150_000, heapMb: 32 });
    try {
      await expect(host.run('stirling_first', { n: 60000, k: 20000 })).rejects.toThrow(
        /memory budget|stopped unexpectedly/
      );
      // The server is still here, and so is the next answer.
      await expect(host.run('bell_number', { n: 5 })).resolves.toBe('52');
    } finally {
      await host.dispose();
    }
  }, 300_000);

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
    [{ sample1: [1, 2, 3], mu0: [9, 9] }, /mu0 must be a finite number, got \[9,9\]/],
    [{ sample1: [1, 2, 3], mu0: '5' }, /mu0 must be a finite number, got "5"/],
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

  it('clamps the padded y range when 5% of the span overflows to Infinity', async () => {
    // yMax - yMin = 2e308 = Infinity, so the 5% pad is ±Infinity, which
    // JSON.stringify renders as null in a field declared number — the bug
    // finiteOr exists for. Assert the IPC payload, not the SVG: render's own
    // tick math still overflows downstream.
    const host = createJsComputeHost({ timeoutMs: 10_000 });
    try {
      const raw = await host.run('mathjs_sample', {
        expression: '1e307*x',
        variable: 'x',
        xMin: -10,
        xMax: 10,
        numPoints: 200,
      });
      const r = JSON.parse(raw) as { yMin: number; yMax: number };
      expect(r.yMin).toBe(-1e308);
      expect(r.yMax).toBe(1e308);
    } finally {
      await host.dispose();
    }
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
      // No wall-clock assertion: the check (~0.3s) and the build it refuses
      // (~1.9s measured — mathjs-tasks.ts documents 1.64s of that as
      // String() itself) are within 6x of each other, so no machine-independent
      // constant separates them — the old 1.5s bound flaked on CI and a loose
      // one admits build-first. The refusal itself, before any string reaches
      // the caller, is what the /elements/ message pins.
      await expect(host.run('mathjs_evaluate', { expression: '1:2000000' })).rejects.toThrow(
        /2000000 elements/
      );
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
      expect(refused).toHaveLength(3);
      expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(3);
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
    // A factorial is not itself suspicious. The bound is on the DIGITS the
    // condition's factorials denote together, which these are nowhere near.
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
  // magnitude. Pinned on the whole solution, not just on the symbol appearing:
  // matching the response echoes the caller's own `k2000!` back off the
  // `Command:` line, and even `/^Result: .*k2000!/` passes on a wrong answer
  // that happens to mention it.
  it('does not refuse a symbol ending in digits on a system right-hand side', async () => {
    const r = await computeHandler({ problem: "desolve([y'=z*k2000!, z'=-y], x)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(
      /^Result: \[\[\(c_0\*√\(k2000!\)\*cos\(√\(k2000!\)\*x\)\+c_1\*k2000!\*sin\(√\(k2000!\)\*x\)\)\/√\(k2000!\),\(-c_0\*sin\(√\(k2000!\)\*x\)\+c_1\*√\(k2000!\)\*cos\(√\(k2000!\)\*x\)\)\/√\(k2000!\)\]\]$/m
    );
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

  // Giac maps factorial over a LIST, so `[50000]!` denotes the same
  // 213,237-digit number `50000!` does. `]` was neither a bracket the leftward
  // read followed nor a token character, so it yielded no operand at all, was
  // charged zero digits, and killed the worker through all three channels —
  // including the right-hand side, which the same guard covers.
  it.each([
    "desolve(y'=y, y(0)=[50000]!, x, y)",
    "desolve([y'=z, z'=-y, y(0)=[50000]!, z(0)=0], x)",
    "desolve([y'=[50000]!*z, z'=-y], x)",
  ])('refuses the list-form %s', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/a factorial of 50000/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
  });

  // A `!` whose operand this cannot read at all must reach the unreadable branch
  // rather than vanish. The previous version dropped it silently, on the
  // strength of a comment asserting the only cases left were another `!` or an
  // operator — and `]` was neither, which is how the rows above got through.
  //
  // `[[50000]]!` is the demonstrated kill here — stripEnclosingBrackets peels
  // repeatedly, so it reads as 50000 — and `(1,50000)!` is another, refused as
  // unreadable. The other two rows pin defence in depth, and are labelled as
  // such rather than as kills: `{50000}!` is `undef!` with the worker alive,
  // because Giac does not map factorial over a SET the way it does over a list,
  // and `"50000"!` answers symbolically. `}` in fact never yields a readable
  // operand, since stripEnclosingBrackets peels `(` and `[` but not braces.
  //
  // They are pinned anyway: without them those branches are dead code, and a
  // dead branch here is exactly what a later reader deletes for free — after
  // which the next unreadable operand vanishes silently, which is how `]` got
  // through in the first place.
  it.each([
    ["desolve(y'=y, y(0)={50000}!, x, y)", /a factorial this cannot bound/],
    ["desolve(y'=y, y(0)=[[50000]]!, x, y)", /a factorial of 50000/],
    ["desolve([y'=y, y(0)=(1,50000)!], x, y)", /a factorial this cannot bound \(1,50000\)/],
    ['desolve(y\'=y, y(0)="50000"!, x, y)', /a factorial this cannot bound/],
  ])('refuses %s, whose operand it cannot read as a value', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
  });

  // The two magnitude axes have to compose, and did not: `10^9!` is `10^(9!)`,
  // ten characters denoting 362,881 digits, and neither saw it — the exponent
  // clause read the digit run `9` and stopped before the `!`, while the
  // factorial clause read the operand `9` and charged six digits. Measured, it
  // killed the worker and the next caller got "Giac worker exited (code 1)".
  it.each([
    "desolve(y'=y, y(0)=10^9!, x, y)",
    "desolve(y'=y, y(0)=10^(9!), x, y)",
    "desolve([y'=z, z'=-y, y(0)=10^9!, z(0)=0], x)",
  ])('refuses the exponent-of-a-factorial %s', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/an exponent this cannot bound \(9!\)/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError/);
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
  });

  // The cost of refusing rather than evaluating, recorded because the hazard is
  // not monotonic: `10^(20!)` is far larger than the trapping `10^(9!)` and
  // merely stays symbolic, so it answered before that clause and does not now.
  // Pinned so the trade is visible if anyone narrows the clause later.
  it('refuses a symbolic-only exponent of a factorial, which is the cost', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=10^(20!), x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/an exponent this cannot bound \(20!\)/);
  });

  // The per-condition bound is not a per-COMMAND bound: ode-system.ts joins a
  // system's conditions into one `exact([...])` and evaluates it twice, so nine
  // at the ceiling would be 27,000 digits in one call against a lowest measured
  // kill of 27,753. Each condition here is inside the bound on its own.
  it('bounds a system’s conditions where it joins them, not only one at a time', async () => {
    const equations = Array.from({ length: 9 }, (_, i) => `v${i}'=v${(i + 1) % 9}`);
    const conditions = Array.from({ length: 9 }, (_, i) => `v${i}(0)=1142!`);
    const r = await computeHandler({
      problem: `desolve([${[...equations, ...conditions].join(', ')}], x)`,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/initial conditions of implausible magnitude together/);
    expect(text(r)).toMatch(/factorials denoting 26982 digits together/);
    // And one of them alone is admitted, so this cannot be the per-condition
    // bound firing.
    const alone = await computeHandler({ problem: "desolve(y'=y, y(0)=1142!, x, y)" });
    expect(alone.isError, text(alone)).toBe(false);
  });

  // A verbless SYSTEM must be worded as a system. calculus.ts words every
  // condition_refusal as "cannot solve this equation", so the implicit route has
  // to leave a system's conditions to validateSystemShape exactly as the verb
  // path's trailing arguments do — otherwise the same claim gets opposite
  // wording depending on whether the caller typed `desolve(`.
  it('words a verbless system refusal as a system', async () => {
    const verbless = await computeHandler({ problem: "[y'=z, z'=-y, y(0)=50000!, z(0)=0]" });
    const verb = await computeHandler({
      problem: "desolve([y'=z, z'=-y, y(0)=50000!, z(0)=0], x)",
    });
    for (const r of [verbless, verb]) {
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/^Error: solve_ode cannot solve this system — it gives /m);
    }
    const tail = (s: string): string => s.slice(s.indexOf(' — it '));
    expect(tail(text(verbless))).toBe(tail(text(verb)));
  });

  // `!` binds tighter than `^` even THROUGH a bracket — measured, `2^(3)!` is
  // 64 — so every one of these denotes the same 10^362880 the bare `10^9!` does.
  // The first version of that clause was gated on the bare form and only looked
  // for a `!` written INSIDE a grouped exponent, which left all of these
  // admitted and killing the worker. Each is checked with a surviving
  // neighbour, because the two rows that already existed used only the bare
  // spellings and so passed while the clause covered half its axis.
  it.each([
    "desolve(y'=y, y(0)=10^(9)!, x, y)",
    "desolve(y'=y, y(0)=10^((9))!, x, y)",
    "desolve(y'=y, y(0)=10^[9]!, x, y)",
    "desolve(y'=y, y(0)=10^ (9)!, x, y)",
    "desolve(y'=y, y(0)=10^(9) !, x, y)",
    "desolve(y'=y, y(0)=1/10^(9)!, x, y)",
    "desolve(y'=y, y(0)=10^+9!, x, y)",
    "desolve(y'=y, y(0)=10^-9!, x, y)",
    "desolve(y'=y, y(0)=3^(9)!, x, y)",
    // Worse than a trap: this one ANSWERS 40,321 characters and leaves the
    // worker to fail the call after it.
    "desolve(y'=y, y(0)=10^(8)!, x, y)",
    "desolve([y'=z, z'=-y, y(0)=10^(9)!, z(0)=0], x)",
    "desolve([y'=10^(9)!*z, z'=-y], x)",
  ])('refuses the bracketed exponent-of-a-factorial %s', async (problem) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/an exponent this cannot bound/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
    expect(text(after)).toMatch(/^Result: 2\*exp\(x\)$/m);
  });

  // Reading the sign, which the `!` lookahead needed, made the magnitude clause
  // miss a signed literal: `/^\d+$/` does not match `+50000`, and the nested
  // check skips whatever reads as a plain signed integer. `10^+50000` fell
  // between the two and killed the worker with "table index is out of bounds".
  // `[`-delimited exponents were never recognised at all.
  it.each([
    ["desolve(y'=y, y(0)=10^+50000, x, y)", /an exponent of \+50000/],
    ["desolve(y'=y, y(0)=10^-50000, x, y)", /an exponent of -50000/],
    ["desolve(y'=y, y(0)=10^[50000], x, y)", /an exponent of 50000/],
  ])('refuses %s, whose exponent used to read as empty', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
  });

  // And the ordinary signed exponents the clause above must not take with it.
  it.each([
    ["desolve(y'=y, y(0)=10^-9, x, y)", /^Result: 1\/1000000000\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=10^\\+9, x, y)", /^Result: 1000000000\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=2^\\(3\\+4\\), x, y)", /^Result: 128\*exp\(x\)$/m],
    ["desolve(y'=y, y(0)=1\\/2^10, x, y)", /^Result: 1\/1024\*exp\(x\)$/m],
  ])('still answers %s', async (problem, expected) => {
    const r = await computeHandler({ problem: problem.replaceAll('\\', '') });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // The single-equation path's twin of the joined-conditions check, through the
  // same function. Each condition here is inside the per-condition bound; ten of
  // them denote 29,980 digits in the one command the fold builds.
  it('bounds the single-equation path’s conditions together as well', async () => {
    const conditions = Array.from({ length: 10 }, (_, i) => `y(${i})=1142!`).join(', ');
    const r = await computeHandler({ problem: `desolve(y'=y, ${conditions}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/initial conditions of implausible magnitude together/);
    expect(text(r)).toMatch(/factorials denoting 29980 digits together/);
    const alone = await computeHandler({ problem: "desolve(y'=y, y(0)=1142!, x, y)" });
    expect(alone.isError, text(alone)).toBe(false);
  });
});

/**
 * The composition net.
 *
 * Every bound on this channel before it named the shapes it refused, and a
 * composition of two ADMITTED shapes escaped it every round. `1000!^12` is the
 * fifth: a factorial well inside the factorial cap, raised to an exponent well
 * inside the exponent cap, denoting 30,812 digits — measured, it killed the
 * shared worker through every route while both caps reported it fine.
 *
 * Each row carries the digit count the tool reports, not a `> 3000` band. The
 * band was the first version of this suite and it proved nothing: the clause
 * only ever emits that message when the count exceeds 3,000, so asserting the
 * count exceeds 3,000 re-stated the branch condition and passed by
 * construction — replacing the reported number with the literal 3001 left the
 * whole suite green.
 */
describe('a condition is bounded by what it denotes, not by one operator at a time', () => {
  // The escapes, each with the size the reader computes for it. Grouped by the
  // channel that used to let it through rather than by spelling, because the
  // spelling is what five previous rounds chased.
  it.each([
    // two per-operator caps composed — the original escape
    ['y(0)=1000!^12', 30812],
    ['y(0)=(2^1000)^1000', 301030],
    ['y(0)=100!^200', 31595],
    ['y(0)=1142!^10', 29979],
    ['y(0)=10^1000*10^1000*10^1000', 3001],
    // a sibling operand the reader cannot read used to erase the one it could:
    // `n*` in front of a refused value is a two-character bypass, and it trapped
    // the worker on every route.
    ['y(0)=n*1000!^12', 30812],
    ['y(0)=1000!^12*n', 30812],
    ['y(0)=1000!^12+n', 30812],
    ['y(0)=sin(0)+1000!^12', 30812],
    // an unknown call's ARGUMENT is charged: Giac evaluates it before it can
    // apply the function, whatever the function turns out to be.
    ['y(0)=abs(1000!^12)', 30812],
    ['y(0)=max(1000!^12,1)', 30812],
    ['y(0)=sqrt(1000!^12)', 30812],
    // the denominator costs what the numerator costs
    ['y(0)=1/1000!^12', 30812],
    // the other spelling of the same operator, which this file has been burned
    // by before
    ['y(0)=factorial(1000)^12', 30812],
    ['y(0)=factorial(200)^50', 18745],
    // exponent notation, the reason the tokenizer reads `1e5` as 100000. This one
    // sits exactly on an integer boundary — 1000 * log10(1e5) is 5000.0 — so it
    // rests on log10(1e5) === 5, which the spec leaves implementation-approximated.
    // The row below it is the same rule off the boundary; keep both.
    ['y(0)=1e5^1000', 5001],
    ['y(0)=2e5^1000', 5302],
    // one character the reader does not model used to end the whole measurement
    ['y(0)=1000!^12%7', 30812],
    // the trailing-decimal spelling the local number pattern dropped
    ['y(0)=100.!^200', 31595],
    // the factorial under a third name: `Gamma(n)` is `(n-1)!`, and the count
    // asserts that reading rather than merely that something refused
    ['y(0)=Gamma(50001)', 213237],
    // a token the grammar cannot place no longer discards what was read first
    ['y(0)=1000!^12 2', 30812],
    // `[` groups as well as lists in Giac, and `10^[9]` is a measured spelling —
    // so a bracket must not be a way to hide a base
    ['y(0)=[1000!]^12', 30812],
    // a unary `+` on the exponent. The `^` scan skips `+12` because it reads as a
    // plain signed integer, so the reader is the only clause that sees this one.
    ['y(0)=1000!^+12', 30812],
    // the quotient rule itself, not a large subterm: these two are over the bound
    // ONLY because a negative exponent under the line adds digits, and both
    // exponents are inside the 1,000 ceiling so no other clause catches them
    ['y(0)=1000!/10^-500', 3068],
    ['y(0)=10^1000/10^-1000/10^-1000', 3001],
    // a named argument is ordinary Giac (`subst`, `sum`, `limit` all take one) and
    // its `=` used to split the run and mark the half holding the value a subject
    ['y(0)=max(1000!^12,q=1)', 30812],
    ['y(0)=1000!^12=1', 30812],
  ])('refuses %s as denoting %i digits', async (condition, digits) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(new RegExp(`a value denoting ${digits} digits`));
    // The whole point: the text never reaches the engine.
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
    const after = await computeHandler({ problem: "desolve(y'=y, y(0)=2, x, y)" });
    expect(after.isError, text(after)).toBe(false);
  });

  // `**` is Giac's own spelling of `^` — `y(0)=10**20` answers
  // 100000000000000000000 — and nothing modelled it: the per-operator scan found
  // no `^`, and the reader read two multiplications and charged `10**100000` six
  // digits for a number with 100,001. Six spellings trapped the worker through
  // it, including on the equation's right-hand side.
  it.each([
    ['y(0)=10**100000', /an exponent of 100000/],
    ['y(0)=10 ** 100000', /an exponent of 100000/],
    ['y(0)=1000!**12', /a value denoting 30812 digits/],
    ['y(0)=pow\\(10,100000\\)', /a value denoting 100001 digits/],
    ['y(0)=pow\\(1000!,12\\)', /a value denoting 30812 digits/],
  ])('refuses %s, whose power is not written `^`', async (condition, reason) => {
    const r = await computeHandler({
      problem: `desolve(y'=y, ${condition.replaceAll('\\', '')}, x, y)`,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
  });

  // A condition's POINT is evaluated as readily as its value. Skipping the whole
  // run left of the `=` — to spare the one spurious digit a bare `y(0)` costs —
  // left the point unmeasured, and `y(1000!^12)=1` was admitted and trapped the
  // worker while the same number on the right was refused at 30,812 digits.
  it.each(['y(1000!^12)=1', 'y(1000!**12)=1'])(
    'refuses %s, whose point is the value',
    async (condition) => {
      const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
      expect(r.isError, text(r)).toBe(true);
      expect(text(r)).toMatch(/a value denoting 30812 digits/);
      expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
    }
  );

  // The ordinary spellings the two rules above must not take with them: a power
  // written `**`, a power written as a call, and conditions at a point that is
  // not zero.
  it.each([
    ['y(0)=10**20', /^Result: 100000000000000000000\*exp\(x\)$/m],
    ['y(0)=pow(2,10)', /^Result: 1024\*exp\(x\)$/m],
    ['y(2)=5', /^Result: 5\/exp\(2\)\*exp\(x\)$/m],
  ])('still answers %s', async (condition, expected) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // The refusal names the caller's OWN characters, not the tokens joined back up.
  // Rebuilding them reports `1000!^12 2` as `1000!^122` — a number nobody wrote —
  // and nothing else in this suite would notice.
  it.each([
    ['y(0)=1000!^12 2', 'a value denoting 30812 digits (1000!^12 2)'],
    ['y(0)=100.!^200', 'a value denoting 31595 digits (100.!^200)'],
  ])('names %s in the refusal exactly as written', async (condition, expected) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain(expected);
  });

  // Parts inside one bracket are SUMMED, and the separator rule is what decides
  // that. Depth-gating every separator — tried and reverted — turned this from
  // refused into admitted, and no row noticed at the time.
  it('sums the parts of a bracketed condition', async () => {
    const r = await computeHandler({
      problem: "desolve(y'=y, y(0)=[999^1000;999^1000;999^1000], x, y)",
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain('values denoting 9000 digits together');
  });

  // A superscript carries no `^` for any clause to find. unicodeToAscii runs
  // downstream of this whole bound — at giac-eval.ts, long after it has
  // returned — so the guard has to normalise its own input or it is reading a
  // different string from the one Giac gets. The normaliser maps each
  // superscript digit separately, so `⁹⁹` is `^9^9`, and this row also proves
  // the reader composes two exponents rather than reading one.
  it('refuses 1000!⁹⁹, whose `^` only exists after normalisation', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=1000!\u{2079}\u{2079}, x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/a value denoting 994742646824 digits/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
  });

  // An exponent too large to hold exactly reports the other message arm, which
  // nothing else reaches.
  it('refuses an exponent past the exact-integer window without a digit count', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=10^1e16, x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/a value too large to count the digits of \(10\^1e16\)/);
  });

  // The bound itself, both sides. Without this pair, `>` and `>=` are the same
  // suite.
  it('admits 3,000 denoted digits and refuses 3,001', async () => {
    const under = await computeHandler({
      problem: "desolve(y'=y, y(0)=10^999*10^1000*10^1000, x, y)",
    });
    expect(under.isError, text(under)).toBe(false);
    const over = await computeHandler({
      problem: "desolve(y'=y, y(0)=10^1000*10^1000*10^1000, x, y)",
    });
    expect(over.isError, text(over)).toBe(true);
    expect(text(over)).toMatch(/a value denoting 3001 digits/);
  });

  // Nine conditions each inside the per-condition bound. The reader sums across
  // them for the same reason the factorial scan always has: both paths join
  // their conditions into one command, and a per-condition bound is not a
  // per-command one. Taking the largest instead made this check a no-op on the
  // new axis — measured then, 26,109 digits were admitted.
  it('charges the joined command what all of its conditions denote', async () => {
    const conditions = Array.from({ length: 9 }, (_, i) => `y(${i})=10^1000*10^1000*10^900`).join(
      ', '
    );
    const r = await computeHandler({ problem: `desolve(y'=y, ${conditions}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/values denoting 26109 digits together/);
    const alone = await computeHandler({
      problem: "desolve(y'=y, y(0)=10^1000*10^1000*10^900, x, y)",
    });
    expect(alone.isError, text(alone)).toBe(false);
  });

  // The equation's RIGHT-HAND SIDE, which is the route with no length and no
  // depth bound ahead of the reader — validateSystemShape hands it straight to
  // implausibleMagnitude, and the coefficient-length refusal runs downstream of
  // that, not before it. So this is where the reader's own recursion bound is
  // load-bearing: measured, replacing it with `() => true` turns both rows below
  // into "Maximum call stack size exceeded" out of a function contracted to
  // return a refusal. A guard that can throw is not a guard.
  //
  // An earlier version of this row used a bare nested CONDITION, which
  // conditionBoundError refuses on length long before the reader sees it — it
  // passed without exercising anything it named.
  // A CALL in the exponent position. The rule that an exponent nobody can
  // evaluate costs nothing is true of a free identifier and false of a call:
  // `abs(12)` is 12, and Giac computes the power for real. Both the reader and
  // the `^` scan declined the same node, so they failed together and nothing
  // charged it — `1000!^abs(12)` is the flagship row's own number, re-admitted
  // by four characters. `pow` has no `^` in it at all, so the scan never runs
  // and the reader is the only clause there.
  it.each([
    ['y(0)=1000!^abs(12)', '1000!^abs(12)'],
    ['y(0)=1000!^max(12,1)', '1000!^max(12,1)'],
    ['y(0)=1000!**abs(12)', '1000!^abs(12)'],
    ['y(0)=10^abs(100000)', '10^abs(100000)'],
    ['y(0)=10^floor(100000)', '10^floor(100000)'],
    ['y(0)=2^abs(400000)', '2^abs(400000)'],
    ['y(0)=10^sqrt(10^10)', '10^sqrt(10^10)'],
    ['y(0)=pow(abs(10),100000)', 'pow(abs(10),100000)'],
    ['y(0)=pow(1000!,abs(12))', 'pow(1000!,abs(12))'],
  ])('refuses %s, whose exponent is a call', async (condition, named) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(true);
    // The clause AND the operand, not merely that something refused: several
    // clauses here can say "implausible magnitude", so a generic match stays
    // green if one of these moves to the `^` scan and the branch it was written
    // for quietly stops running. The `**` row also pins that the name is
    // reported as measured, not as typed.
    expect(text(r)).toContain(`a value too large to count the digits of (${named})`);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
  });

  // The other side of that rule, and the reason the two states it rests on are
  // not interchangeable: a free identifier really is free. Merging `symbolic`
  // into `unreadable` for one commit is what let the rows above through, and
  // these are what fail if it is merged again.
  it.each([
    ['y(0)=2^n', /^Result: 2\^n\*exp\(x\)$/m],
    ['y(0)=n^2', /^Result: n\^2\*exp\(x\)$/m],
    ['y(0)=2^(n+1)', /^Result: 2\^\(n\+1\)\*exp\(x\)$/m],
  ])('still answers %s, whose exponent Giac cannot evaluate', async (condition, expected) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // An unreadable operand and a MISSING one are not the same thing. `y'^2=x` is
  // an ordinary ODE whose apostrophe ends the run in front of the `^`, so the
  // reader sees a power with no base at all — and charging that the whole budget
  // turned a common form away. This is the control on the rule above it: without
  // the guard, this answer becomes "a value too large to count the digits of
  // (^2)".
  it('still answers an ODE whose derivative is squared', async () => {
    const r = await computeHandler({ problem: "desolve(y'^2=x, x, y)" });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(/2\/3\*√x\*x\+c_0/);
  });

  // The three junction classes the mechanism merge changed on purpose — the
  // operator clauses and the reader now share one token list — pinned here so
  // the deliberate part stays deliberate. Each was found by re-running the
  // merge's differential with adversarial corpora; none is a shape the old
  // scans refused, and the refuse→admit count across every corpus was zero.
  //
  // `factorial(` directly after a token character triggers, so the
  // juxtaposed spelling is judged like the spaced one Giac reads it as.
  // The spaced row was always refused at this count; the juxtaposed one
  // used to slip between the two spellings.
  it.each([
    [
      "desolve(y'=y, y(0)=2factorial(1000)*2factorial(1000), x, y)",
      /factorials denoting 5136 digits together/,
    ],
    [
      "desolve(y'=y, y(0)=2*factorial(1000)*2*factorial(1000), x, y)",
      /factorials denoting 5136 digits together/,
    ],
  ])('refuses %s at a junction the merge deliberately widened', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).toMatch(/initial conditions are ordinary numbers/);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
  });

  // The merge's other two junction classes cross the extractor seam too, but
  // only in specific shapes: an unclosed bracket swallows every argument
  // AFTER it (the splitter then refuses the shape), while the fallback for a
  // never-rebalanced paren hands the tail through verbatim when the malformed
  // condition is the LAST argument — the typo a caller actually makes. A
  // subject-free `[!]` member reaches the bound the same way, because a
  // member without `=` is a condition in its own raw text. The rows below
  // cross that seam end to end, and the unit rows behind them pin the clause
  // and the count tightly. (The junk-tail spelling `y(0)=^(1001 x` is refused
  // by the extractor's own argument check before any bound runs, so it is
  // pinned at the unit level only.)
  it.each([
    ["desolve(y'=y, y(0)=^(1001 ", /an exponent of 1001/],
    ["desolve(y'=y, y(0)=10^(50000 ", /an exponent of 50000/],
    ["desolve(y'=y, y(0)=10^(50000", /an exponent of 50000/],
    ["desolve([y'=y, [!]], x, y)", /a value too large to count the digits of \(!\)/],
  ])('refuses %s across the extractor seam', async (problem, reason) => {
    const r = await computeHandler({ problem });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(reason);
    expect(text(r)).not.toMatch(/memory access|worker exited|RuntimeError|table index/);
  });

  it.each([
    ['y(0)=^(1001 ', /an exponent of 1001/],
    ['y(0)=10^(50000 ', /an exponent of 50000/],
    ['y(0)=10^(50000', /an exponent of 50000/],
    ['y(0)=^(1001 x', /an exponent this cannot bound \(1001 x\)/],
    ['y(0)=^(1001]', /an exponent this cannot bound \(1001\]\)/],
    // A `!` stranded at the head of fully-bracketed text is refused by the
    // reader's message; the bracket the old wording named is the one the
    // enclosing-strip removes.
    ['[!]', /a value too large to count the digits of \(!\)/],
  ])('refuses %s at a junction of the merged reading', (condition, reason) => {
    expect(conditionBoundError(condition)).toMatch(reason);
  });

  // A deliberate false refusal, pinned so that widening the rule is a decision
  // rather than an accident. `2^sqrt(2)` is small and harmless, and it is turned
  // away because this reader cannot tell a call that shrinks its argument from
  // one that explodes it — `exp(1000)` is 10^434. The trade is the file's
  // standing one: a refusal is visible to the caller, a dead worker is not.
  it('refuses 2^sqrt(2), which is harmless, and says so on purpose', async () => {
    const r = await computeHandler({ problem: "desolve(y'=y, y(0)=2^sqrt(2), x, y)" });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain('a value too large to count the digits of (2^sqrt(2))');
  });

  // Leading signs recurse through `unary`, and the depth check sat AFTER the two
  // sign arms — so a chain of them never reached it, and the counter they
  // increment was read only once the chain had ended. An inert bound reads
  // exactly like a live one.
  //
  // Driven through validateSystemShape rather than computeHandler, and that is
  // the honest scope: MAX_EXPRESSION_LENGTH caps a request at 8,192 characters
  // and the coefficient-extraction bound refuses 8,100 signs before the reader
  // is reached, so this is NOT reachable end to end today. It is reachable by
  // any caller of the exported function, and a guard contracted to return
  // `string | undefined` must not throw for anyone. An earlier version of this
  // row went through computeHandler at 4,000 and 8,100 signs and was refused by
  // the coefficient bound — it passed without exercising anything it named.
  // Measured: 20,000 signs throw RangeError with the check after the arms, and
  // again with the check moved but the depth increments reverted, so both halves
  // are load-bearing.
  it('refuses a long chain of leading signs without overflowing the stack', () => {
    const system = parseOdeSystem(`[y'=${'-'.repeat(20_000)}1, z'=-y]`);
    expect(system, 'the fixture must parse, or this row pins nothing').not.toBeNull();
    expect(() => validateSystemShape(system as NonNullable<typeof system>, 'x')).not.toThrow();
  });

  // The number in a length or depth refusal is measured AFTER normalisation and
  // the caller counted before it — `√` 270 times is 275 typed and 1,085
  // evaluated. Unqualified, "1085 characters" reads as a miscount against an
  // input the caller can see is 275, with no shortening it can compute.
  it('says when a length refusal counted the normalised text', async () => {
    const r = await computeHandler({
      problem: `desolve(y'=y, y(0)=${'\u221A'.repeat(270)}, x, y)`,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain('1085 characters after normalising');
  });

  // An unmarked cut names a DIFFERENT input from the one refused: the excerpt
  // below denotes 2,002 digits on its own and would be admitted, so a caller
  // trimming to what the message named would be refused again.
  it('marks a truncated excerpt so it cannot be read as the whole operand', async () => {
    const r = await computeHandler({
      problem: "desolve(y'=y, y(0)=10^1000*10^1000*10^1000*10^1000, x, y)",
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toContain('a value denoting 4001 digits (10^1000*10^1000*10^1\u2026)');
  });

  // The one refusal that quoted caller text without a cap, on the channel that
  // has no length bound in front of it: 3,000 digits of exponent came back as a
  // 3,165-character tool answer.
  it('caps the exponent refusal instead of echoing the whole operand', async () => {
    const r = await computeHandler({
      problem: `desolve([y'=10^${'9'.repeat(3000)}, z'=-y], x)`,
    });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).toMatch(/an exponent of 99999999999999999999\u2026/);
    expect(text(r).length).toBeLessThan(300);
  });

  it.each([1500, 4000])('refuses a %i-deep right-hand side without overflowing', async (depth) => {
    const deep = '('.repeat(depth) + '1' + ')'.repeat(depth);
    const r = await computeHandler({ problem: `desolve([y'=z+${deep}, z'=-y], x)` });
    expect(r.isError, text(r)).toBe(true);
    expect(text(r)).not.toMatch(/call stack|RangeError/);
    expect(text(r)).toMatch(/^Error: solve_ode cannot solve this system — /m);
  });

  // The safe direction. Without these the escape rows above are satisfied by a
  // bound that simply refuses `!` anywhere near `^` — measured, replacing the
  // reader with that cruder rule fails exactly these rows.
  it.each([
    ['y(0)=3!^2', /^Result: 36\*exp\(x\)$/m],
    ['y(0)=5!^3', /^Result: 1728000\*exp\(x\)$/m],
    ['y(0)=10!^2', /^Result: 13168189440000\*exp\(x\)$/m],
    ['y(0)=factorial(5)^3', /^Result: 1728000\*exp\(x\)$/m],
    ['y(0)=1000000*1000000', /^Result: 1000000000000\*exp\(x\)$/m],
    // the same three branches as the escapes above, in the direction that must
    // keep answering: a bracketed exponent, a unary `+`, and a quotient whose
    // denominator cancels rather than accumulates
    ['y(0)=10^[3]', /^Result: 1000\*exp\(x\)$/m],
    // lowercase `gamma` stays symbolic where `Gamma` is the factorial
    ['y(0)=gamma(5)', /^Result: gamma\(5\)\*exp\(x\)$/m],
    ['y(0)=+5!^3', /^Result: 1728000\*exp\(x\)$/m],
    ['y(0)=10^500/10^-500', /^Result: 1[0]+\*exp\(x\)$/m],
  ])('still answers %s', async (condition, expected) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // A symbol alone costs nothing real — measured, `n!` and `2^n` come back
  // unevaluated in a few characters and the worker survives. This guard only
  // ever ADDS refusals, so over-charging is its characteristic regression and
  // these are the rows that detect it.
  it.each([
    ['y(0)=2^n', /^Result: 2\^n\*exp\(x\)$/m],
    ['y(0)=2^(n+1)', /^Result: 2\^\(n\+1\)\*exp\(x\)$/m],
  ])('still answers %s, whose exponent nobody can evaluate', async (condition, expected) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(false);
    expect(text(r)).toMatch(expected);
  });

  // 1000! is 2,568 digits and inside the budget; raising it to the first power
  // does not change that, and putting it under the line does not either. A
  // bound that charged for the OPERATOR rather than the size would refuse both.
  it.each(['y(0)=1000!^1', 'y(0)=1/1000!', 'y(0)=1000!'])('still answers %s', async (condition) => {
    const r = await computeHandler({ problem: `desolve(y'=y, ${condition}, x, y)` });
    expect(r.isError, text(r)).toBe(false);
  });
});
