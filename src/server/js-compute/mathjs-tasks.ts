import { create, all, type MathJsInstance } from 'mathjs';

/**
 * The mathjs-backed tasks, in a module the worker imports only on demand.
 *
 * Separate from `tasks.ts` because `require('mathjs')` costs ~143ms and a few
 * tens of MB: a `bell_number` call must not pay for it. The worker imports this
 * lazily on the first mathjs task, so a server that never evaluates arithmetic
 * never loads it at all.
 *
 * Why it runs out here rather than in the server process: mathjs evaluation is
 * synchronous and its cost is unbounded in the expression, so it cannot be
 * interrupted in-process. `1:20000000` — eleven characters — blocked the event
 * loop for 20s and produced a 532MB response, and a guard on range syntax would
 * not have helped: `zeros(3000,3000)` is 3.7s and `ones(2000,2000)*ones(2000,2000)`
 * is 21s with no range in sight. The host's timeout and heap cap bound all of
 * them without naming a construct.
 */

/**
 * Above this, a result is refused rather than returned.
 *
 * Separate from the heap cap because a result can be cheap to compute and still
 * useless to ship: `1:2000000` is 1.7s of work and a 48MB response that lands
 * whole in an MCP client's context. The digit/element count in the message is
 * what a caller needs to act on.
 */
const MAX_RESULT_CHARS = 100_000;

let instance: MathJsInstance | null = null;

/**
 * The hardened instance, built once per worker.
 *
 * `import` and `createUnit` are reachable from the expression parser and can
 * redefine trusted built-ins, so mathjs's own security guidance is to disable
 * them on any instance evaluating third-party expressions:
 * https://mathjs.org/docs/expressions/security.html
 *
 * This mirrors the two in-process instances it replaces — the same disables and
 * the same `ln` alias, which mathjs lacks and models write constantly.
 */
function math(): MathJsInstance {
  if (instance) return instance;
  const m = create(all, {});
  m.import({ ln: (x: number) => Math.log(x) });
  m.import(
    {
      import: function () {
        throw new Error('Function import is disabled');
      },
      createUnit: function () {
        throw new Error('Function createUnit is disabled');
      },
    },
    { override: true }
  );
  instance = m;
  return m;
}

function capped(value: string, what: string): string {
  if (value.length > MAX_RESULT_CHARS) {
    throw new Error(
      `the ${what} is ${value.length} characters, above the ${MAX_RESULT_CHARS}-character response limit — ` +
        `ask for a smaller range or fewer elements`
    );
  }
  return value;
}

export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotSegment {
  points: PlotPoint[];
}

export interface SampledFunction {
  segments: PlotSegment[];
  yMin: number;
  yMax: number;
}

export const MATHJS_TASKS = {
  /** One expression evaluated to a value, plus its LaTeX when asked for. */
  mathjs_evaluate: (a: { expression: string; precision?: number; latex?: boolean }): string => {
    const m = math();
    const raw: unknown = m.evaluate(a.expression, { precision: a.precision ?? 10 });
    const result: { value: string; isNumber: boolean; latex?: string } = {
      value: capped(String(raw), 'result'),
      isNumber: typeof raw === 'number',
    };
    if (a.latex) result.latex = m.parse(a.expression).toTex();
    return JSON.stringify(result);
  },

  /**
   * One expression sampled across a range, split at discontinuities.
   *
   * A faithful port of what plot/evaluator.ts did in-process, and the two passes
   * are load-bearing: the jump that marks an asymptote is judged against
   * `(yMax - yMin) * 2`, which is only known once every point is sampled. A fixed
   * threshold instead of the relative one stops `1/x` splitting at its pole.
   *
   * The whole grid is sampled in one call rather than one round trip per point:
   * the sample count is fixed at 200 but the caller writes the expression, and
   * `sum(1:2000000)*x` took 10.9s across those 200 points.
   */
  mathjs_sample: (a: {
    expression: string;
    variable: string;
    xMin: number;
    xMax: number;
    numPoints: number;
  }): string => {
    const m = math();
    const compiled = m.compile(a.expression);
    const step = (a.xMax - a.xMin) / (a.numPoints - 1);

    // Pass one: sample, with null marking a point that is not finite.
    const allPoints: (PlotPoint | null)[] = [];
    let yMin = Number.POSITIVE_INFINITY;
    let yMax = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < a.numPoints; i++) {
      const x = a.xMin + i * step;
      try {
        const y: unknown = compiled.evaluate({ [a.variable]: x });
        if (typeof y === 'number' && Number.isFinite(y)) {
          allPoints.push({ x, y });
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        } else {
          allPoints.push(null);
        }
      } catch {
        allPoints.push(null);
      }
    }

    // Pad the y range, and pick a default when nothing was finite.
    if (yMin === Number.POSITIVE_INFINITY) {
      yMin = -10;
      yMax = 10;
    }
    const yRange = yMax - yMin;
    if (yRange === 0) {
      yMin -= 1;
      yMax += 1;
    } else {
      yMin -= yRange * 0.05;
      yMax += yRange * 0.05;
    }

    // Pass two: split into continuous segments, breaking at a null or at a jump
    // large relative to the range just computed.
    const segments: PlotSegment[] = [];
    let current: PlotPoint[] = [];
    const threshold = (yMax - yMin) * 2;
    for (const pt of allPoints) {
      if (pt === null) {
        if (current.length > 1) segments.push({ points: current });
        current = [];
        continue;
      }
      if (current.length > 0) {
        const prev = current[current.length - 1];
        if (Math.abs(pt.y - prev.y) > threshold) {
          if (current.length > 1) segments.push({ points: current });
          current = [];
        }
      }
      current.push(pt);
    }
    if (current.length > 1) segments.push({ points: current });

    return capped(JSON.stringify({ segments, yMin, yMax }), 'sampled curve');
  },
} as const;

export type MathJsTaskName = keyof typeof MATHJS_TASKS;
