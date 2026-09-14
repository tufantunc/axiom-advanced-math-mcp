import { parseQuantity } from '../env-bounds.js';

/**
 * The heap ceiling for the compute child, resolved from the option or the
 * environment.
 *
 * Lives beside host.ts rather than inside it for the same reason env-bounds.ts
 * exists: host.ts is a fork/queue/timer/fault-recovery bridge, and how Node's
 * argv parser reads `--max-old-space-size` is a different subject. The two halves
 * of one operator question — how long, and how much memory, may one evaluation
 * hold the server — now sit at the same layer.
 *
 * The defect this exists to close: `--max-old-space-size` takes a WHOLE number
 * of MB and Node refuses anything else outright ("illegal value ... of type
 * size_t"), so a merely finite-and-positive value reached the fork intact and
 * killed the child before it ran a single task. `AXIOM_JS_COMPUTE_HEAP_MB=1.5`
 * failed every combinatorics / quick_calc / plot call in ~50ms as
 * `worker_failed` — "not the caller's fault", which is true and points the
 * operator away from the env value that caused it. The child's stderr is
 * discarded and logFault names only the number in force, so without a line here
 * there is nothing to go on.
 */

export const DEFAULT_HEAP_MB = 512;

/**
 * Hard floor. Below ~10MB the child cannot boot at all, whatever it is asked to
 * do: measured through the host that forks it, 6MB dies, 8MB booted in one run
 * and died in another, 10MB up is reliable. 16 is that boundary with the margin
 * the variance demands — not a figure from any Node documentation, which
 * specifies no minimum for the flag.
 */
export const MIN_HEAP_MB = 16;

/**
 * The ceiling below which the child boots and runs the arbitrary-precision tasks
 * but cannot complete the mathjs import that quick_calc and plot need. Measured
 * on this repo's worker: 44MB dies, 46MB runs, and 43MB is the flaky edge;
 * worker.ts prices the import at ~50MB itself. 48 is the first reliable value.
 *
 * Deliberately NOT a floor. 32MB is a working, legitimately tight ceiling for
 * the integer tasks — the OOM rows in input-bounds.test.ts and
 * js-compute-error-codes.test.ts depend on exactly that value being honoured —
 * so rejecting it outright would discard a real configuration to protect a
 * different one. It gates the mathjs tasks only, and `run()` refuses those by
 * name rather than letting them fork and die as an unattributable worker fault.
 */
export const MATHJS_MIN_HEAP_MB = 48;

/**
 * Policy ceiling, and honest about being one: V8 accepts far larger values and
 * honours them (2TB measured at 2097344MB). What it cannot survive is ~1.76e13
 * MB and up, where the MB->byte multiply wraps a size_t and
 * `--max-old-space-size=17592186044415` silently yields a ~191MB heap — tighter
 * than the default and nothing like the request. This cap sits far below that,
 * because a ceiling past 1TB is a typo rather than a deployment, and clamping to
 * it keeps the correction in the safe direction. It also removes the last band
 * where `String` would spell the number in exponential form, so a plain
 * `Math.floor` is all the whole-number rule needs.
 */
export const MAX_HEAP_MB = 1_048_576;

/** Units that mean what the variable's name already says, plus the obvious step up. */
const HEAP_UNITS: Record<string, number> = { m: 1, mb: 1, mib: 1, g: 1024, gb: 1024, gib: 1024 };

/**
 * Resolves the ceiling, warning on anything it had to change.
 *
 * Clamped rather than replaced, and never upward past what was asked for.
 * SECURITY.md documents this variable as a containment bound, so answering a
 * typo with a LOOSER ceiling is the one wrong direction: `AXIOM_JS_COMPUTE_HEAP_MB=12`
 * ran at 12MB before this existed and must not silently become 512, and `64MB`
 * must not either. Every legible quantity keeps its intent — floored to whole
 * MB, then clamped into [MIN_HEAP_MB, MAX_HEAP_MB]. Only input with no quantity
 * in it at all takes the default.
 *
 * Falls back rather than throwing, on both paths: this is an operator typo in
 * one tunable that has a working default, and refusing to construct the host
 * would take the server down over it.
 */
export function resolveHeapMb(option: number | null | undefined): number {
  // `null` counts as absent: `opts.heapMb ?? env` used to do that, and a bare
  // `=== undefined` test would send a null to the fallback and discard a tighter
  // environment setting.
  const fromEnv = option === undefined || option === null;
  const raw = fromEnv ? process.env.AXIOM_JS_COMPUTE_HEAP_MB : String(option);
  // Unset or blank is not a misconfiguration — `.env` files and compose produce
  // a set-but-empty var constantly — so it takes the default silently.
  if (raw === undefined || raw.trim() === '') return DEFAULT_HEAP_MB;
  // The env value is quoted like http.ts's MCP_PORT refusal, so a value that is
  // whitespace or otherwise invisible is still legible in the log.
  const source = fromEnv
    ? `AXIOM_JS_COMPUTE_HEAP_MB=${JSON.stringify(raw)}`
    : `the heapMb option (${raw})`;

  const quantity = parseQuantity(raw, HEAP_UNITS);
  if (quantity === undefined || quantity <= 0) {
    console.error(`[js-compute] ${source}: no usable heap size in it; using ${DEFAULT_HEAP_MB}MB`);
    return DEFAULT_HEAP_MB;
  }

  const effective = Math.min(MAX_HEAP_MB, Math.max(MIN_HEAP_MB, Math.floor(quantity)));
  if (effective !== quantity) {
    console.error(
      `[js-compute] ${source}: the child heap must be a whole number of MB between ` +
        `${MIN_HEAP_MB} and ${MAX_HEAP_MB}; using ${effective}MB`
    );
  }
  if (effective < MATHJS_MIN_HEAP_MB) {
    console.error(
      `[js-compute] the child heap is ${effective}MB; the mathjs-backed tools (quick_calc, ` +
        `plot) need at least ${MATHJS_MIN_HEAP_MB}MB and will be refused at this ceiling`
    );
  }
  return effective;
}

/**
 * Whether a task needs the mathjs import, by name.
 *
 * A name test rather than a `MATHJS_TASKS` lookup on purpose: mathjs-tasks.ts
 * statically imports mathjs, so reaching for it from the host process would pull
 * the ~50MB import into the parent — the exact cost worker.ts defers by
 * importing it lazily in the child.
 */
export function needsMathjsHeap(task: string): boolean {
  return task.startsWith('mathjs_');
}
