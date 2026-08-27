import { create, all, type MathJsInstance } from 'mathjs';
import { JsComputeError } from './errors.js';
import type { TaskModule } from './task-module.js';

/**
 * The mathjs-backed tasks, in a module the worker imports only on demand.
 *
 * Separate from `tasks.ts` because `require('mathjs')` costs ~170ms and ~50MB:
 * a `bell_number` call must not pay for it. The worker imports this lazily on
 * the first mathjs task, so a server that never evaluates arithmetic never
 * loads it at all. The saving is once per worker process, not per call — the
 * child is reused until it faults.
 *
 * Why it runs out here rather than in the server process: mathjs evaluation is
 * synchronous and its cost is unbounded in the expression, so it cannot be
 * interrupted in-process. `1:20000000` — eleven characters — blocked the event
 * loop for 18.5s and built a 266-million-character result. The reachable
 * surface is whatever `isPureArithmetic` (compute/router.ts) admits, which is
 * open-ended: bounding time, memory and result size covers constructs nobody
 * has thought of yet, where a guard naming `1:N` would not.
 */

/**
 * Above this, a result is refused rather than returned.
 *
 * Separate from the heap cap because a result can fit in memory and still be
 * useless to ship: `1:2000000` builds 24.3 million characters, which would land
 * whole in an MCP client's context. Note this fires AFTER stringification, so it
 * bounds what is returned, not what is spent computing it — the timeout and heap
 * cap are what contain the cost (of `1:2000000`'s 1.7s, 1.64s is `String()`).
 */
const MAX_RESULT_CHARS = 100_000;

/**
 * The per-worker mathjs instance, plus the config guard that keeps one caller's
 * expression from changing what the next caller is told.
 *
 * `config` is reachable from the expression parser and mutates the instance, and
 * the instance is a per-worker singleton shared by `compute`, `quick_calc`,
 * `exact_value` and `plot`. So `plot("config({number:\"BigNumber\"})*0+x")` — 32
 * bytes through an unauthenticated tool — permanently changed what every later
 * `compute` answered (`0.1+0.2` became `0.3`) and made every later polynomial
 * plot come back blank, until the child happened to be recycled.
 *
 * The fix is to restore the config rather than to disable `config`: shadowing it
 * breaks mathjs internally (`Matrix.toString()` reads it, so `1:5` degraded from
 * `[1, 2, 3, 4, 5]` to `1,2,3,4,5`), and restoring needs no list of mutators —
 * anything that moves the config, by any route present now or added later, is
 * undone before the next task. The read-and-compare costs ~0.4us against an
 * `evaluate("2+2")` of ~1.6us; the write only happens when it actually drifted.
 *
 * `import` and `createUnit` stay disabled outright, per mathjs's own guidance:
 * they can redefine trusted built-ins, and unlike `config` nothing internal
 * calls them. https://mathjs.org/docs/expressions/security.html
 */
interface HardenedInstance {
  m: MathJsInstance;
  baseline: string;
  snapshot: Record<string, unknown>;
}

function readConfig(m: MathJsInstance): Record<string, unknown> {
  return (m.config as unknown as () => Record<string, unknown>)();
}

let instance: HardenedInstance | null = null;

function build(): HardenedInstance {
  const m = create(all, {});
  m.import({ ln: (x: number) => Math.log(x) });
  m.import(
    {
      import: function (): never {
        throw new Error('Function import is disabled');
      },
      createUnit: function (): never {
        throw new Error('Function createUnit is disabled');
      },
    },
    { override: true }
  );
  // mathjs's types declare config() as write-only; the zero-arg read is real.
  const snapshot = readConfig(m);
  return { m, baseline: JSON.stringify(snapshot), snapshot };
}

/**
 * The hardened instance, with any config drift from a previous task undone.
 *
 * A caller's own expression may still change the config for the rest of its own
 * evaluation — that was true before this worker existed, and it is their own
 * request. What must not happen is the change outliving it.
 */
function math(): MathJsInstance {
  instance ??= build();
  const { m, baseline, snapshot } = instance;
  if (JSON.stringify(readConfig(m)) !== baseline) {
    m.config(snapshot);
  }
  return m;
}

/**
 * Refuses an oversized collection before it is stringified.
 *
 * `capped` can only measure a string that already exists, and building it is the
 * expensive part: of `1:2000000`'s 1.7s, ~1.64s is `String()` producing 24.3
 * million characters that are then thrown away. An element cannot render in
 * fewer than two characters (a digit and a separator), so more elements than the
 * character cap definitely exceeds it — the check never refuses something the
 * character cap would have allowed.
 */
function refuseIfTooManyElements(raw: unknown): void {
  let count: number | undefined;
  if (Array.isArray(raw)) {
    count = raw.length;
  } else if (typeof raw === 'object' && raw !== null && 'size' in raw) {
    const size = (raw as { size: () => number[] }).size();
    if (Array.isArray(size) && size.every((d) => typeof d === 'number')) {
      count = size.reduce((a, b) => a * b, 1);
    }
  }
  if (count !== undefined && count > MAX_RESULT_CHARS) {
    throw new JsComputeError(
      `the result has ${count} elements, above the ${MAX_RESULT_CHARS}-character response limit — ` +
        `ask for a smaller range or fewer elements`,
      'result_too_large'
    );
  }
}

/**
 * Nesting depth above which LaTeX is refused.
 *
 * `toTex` cost grows ~1.8x per level: nested `sqrt(` reaches 24ms at depth 14,
 * 158ms at 18 and 543ms at 20, so 157 characters of input could consume a whole
 * 10s budget while producing only 155 characters of output. Capping the OUTPUT
 * cannot bound this — the cost is in producing the string, not its size.
 * Ordinary expressions sit well under 10 levels.
 */
const MAX_LATEX_DEPTH = 20;

function astDepth(node: { forEach: (cb: (child: unknown) => void) => void }): number {
  let deepest = 0;
  node.forEach((child) => {
    const d = astDepth(child as typeof node);
    if (d > deepest) deepest = d;
  });
  return deepest + 1;
}

function capped(value: string, what: string): string {
  if (value.length > MAX_RESULT_CHARS) {
    throw new JsComputeError(
      `the ${what} is ${value.length} characters, above the ${MAX_RESULT_CHARS}-character response limit — ` +
        `ask for a smaller range or fewer elements`,
      'result_too_large'
    );
  }
  return value;
}

/** A sampled point. Canonical here because this module produces them. */
export interface PlotPoint {
  x: number;
  y: number;
}

export interface PlotSegment {
  points: PlotPoint[];
}

/** The `mathjs_sample` result, as it crosses the IPC boundary. */
export interface SampledFunction {
  segments: PlotSegment[];
  yMin: number;
  yMax: number;
  /** Points that evaluated to a finite number. Zero means nothing plotted. */
  sampled: number;
  /** First error thrown while sampling, if any — names an undefined function. */
  firstError?: string;
}

/** The `mathjs_evaluate` result, as it crosses the IPC boundary. */
export interface EvaluatedExpression {
  value: string;
  isNumber: boolean;
  latex?: string;
}

/**
 * A y value that survives JSON.
 *
 * `JSON.stringify(Infinity)` is `null`, and the 5% padding below overflows a
 * ±1e308 span to ±Infinity — which arrived back through `JSON.parse` as `null`
 * in a field declared `number`, and reached the SVG as NaN coordinates.
 */
function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export const MATHJS_TASKS = {
  /** One expression evaluated to a value, plus its LaTeX when asked for. */
  mathjs_evaluate: (a: { expression: string; precision?: number; latex?: boolean }): string => {
    const m = math();
    // Second argument is deliberately an EMPTY scope. It is mathjs's scope, not
    // an options object: passing `{precision: n}` here bound `precision` as a
    // variable, so `compute("precision+1")` answered 11 instead of reporting an
    // undefined symbol.
    const raw: unknown = m.evaluate(a.expression, {});

    // `String(undefined)` is "undefined", where the `.toString()` this replaced
    // threw. Without this guard `compute("#")` answered "Result: undefined" with
    // isError:false, and `--quiet` handed a script "undefined" on exit 0.
    if (raw === undefined || raw === null) {
      throw new Error('the expression produced no value');
    }

    refuseIfTooManyElements(raw);

    const isNumber = typeof raw === 'number';
    // Precision is applied only when the caller actually asked for it: the
    // documented default is 10, and formatting to 10 significant digits would
    // silently change every existing caller's output (`0.1+0.2` -> `0.3`).
    // Strings are excluded because `format` adds quotes around them.
    const formatted =
      a.precision !== undefined && typeof raw !== 'string'
        ? m.format(raw, { precision: a.precision })
        : String(raw);

    const result: EvaluatedExpression = {
      value: capped(formatted, 'result'),
      isNumber,
    };
    // Capped too: `toTex` output is unbounded in the input's nesting depth, and
    // the response limit is stated as a limit on the response.
    if (a.latex) {
      const node = m.parse(a.expression);
      if (astDepth(node) > MAX_LATEX_DEPTH) {
        throw new JsComputeError(
          `the expression nests more than ${MAX_LATEX_DEPTH} levels deep, which is too deep to render as LaTeX`,
          'result_too_large'
        );
      }
      result.latex = capped(node.toTex(), 'LaTeX');
    }
    return JSON.stringify(result);
  },

  /**
   * One expression sampled across a range, split at discontinuities.
   *
   * The whole grid is sampled in one call rather than one round trip per point:
   * the sample count is fixed at 200 but the caller writes the expression, and
   * `sum(1:200000)*x` took 9.5s across those 200 points.
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
    let sampled = 0;
    let firstError: string | undefined;
    for (let i = 0; i < a.numPoints; i++) {
      const x = a.xMin + i * step;
      try {
        const y: unknown = compiled.evaluate({ [a.variable]: x });
        if (typeof y === 'number' && Number.isFinite(y)) {
          allPoints.push({ x, y });
          sampled++;
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        } else {
          allPoints.push(null);
        }
      } catch (e) {
        if (firstError === undefined) {
          firstError = e instanceof Error ? e.message : String(e);
        }
        allPoints.push(null);
      }
    }

    // The jump threshold is measured against the RAW span, before padding.
    // Padding first was the bug: it made the threshold 2.2x the raw span while
    // no adjacent jump can exceed the raw span itself, so the split below could
    // never fire and `1/x` was drawn as one curve straight through its pole.
    const rawRange = sampled > 0 ? yMax - yMin : 0;

    // Pad the y range, and pick a default when nothing was finite.
    if (sampled === 0) {
      yMin = -10;
      yMax = 10;
    } else if (rawRange === 0) {
      yMin -= 1;
      yMax += 1;
    } else {
      yMin = finiteOr(yMin - rawRange * 0.05, yMin);
      yMax = finiteOr(yMax + rawRange * 0.05, yMax);
    }

    // Pass two: split into continuous segments, breaking at a non-finite sample
    // or at a jump over half the raw span. Half is a heuristic: a pole crossing
    // moves nearly the whole span between adjacent samples, while a steep but
    // continuous curve moves a fraction of it (over [-10,10], `exp(x)`'s largest
    // adjacent step is 10% of its span and `x^2`'s is 2%).
    const segments: PlotSegment[] = [];
    let current: PlotPoint[] = [];
    const threshold = rawRange * 0.5;
    for (const pt of allPoints) {
      if (pt === null) {
        if (current.length > 1) segments.push({ points: current });
        current = [];
        continue;
      }
      if (current.length > 0) {
        const prev = current[current.length - 1];
        if (rawRange > 0 && Math.abs(pt.y - prev.y) > threshold) {
          if (current.length > 1) segments.push({ points: current });
          current = [];
        }
      }
      current.push(pt);
    }
    if (current.length > 1) segments.push({ points: current });

    const result: SampledFunction = { segments, yMin, yMax, sampled };
    if (firstError !== undefined) result.firstError = firstError;
    // Insurance rather than an active bound: 200 points serialize to ~10KB. It
    // becomes reachable if the sample count is ever exposed to callers.
    return capped(JSON.stringify(result), 'sampled curve');
  },
} as const satisfies TaskModule;

export type MathJsTaskName = keyof typeof MATHJS_TASKS;

/** Argument shape per task, so the seam is checked rather than asserted. */
export type MathJsTaskArgs = {
  [K in MathJsTaskName]: Parameters<(typeof MATHJS_TASKS)[K]>[0];
};
