/**
 * Numeric bounds read from the environment, parsed and clamped in one place.
 *
 * Two operator-tunable bounds share this: `AXIOM_EVAL_TIMEOUT_MS` and
 * `AXIOM_INTEGRATION_BUDGET_MS`. A third, `AXIOM_JS_COMPUTE_HEAP_MB`, uses the
 * same primitives from js-compute/heap-config.ts but keeps its own policy, since
 * its units, floor and advisory differ.
 *
 * `AXIOM_EVAL_TIMEOUT_MS` was read at three sites and checked at one. `??` does
 * not treat a set-but-empty var as absent, so `''` coerced to 0 and any unit
 * suffix to NaN, and Node clamps both to a 1ms timer: measured,
 * `AXIOM_EVAL_TIMEOUT_MS=10s` made every CAS evaluation reject as "Giac
 * evaluation timed out" in ~118ms — an operator typo reported as the caller's
 * expression being too slow. The NaN also reached
 * `Math.max(evalTimeoutMs() * 3, 30_000)`, where `Date.now() > NaN` is always
 * false, silently deleting the integration budget SECURITY.md relies on to stop
 * one request holding the CAS worker.
 *
 * The rule, shared with the heap ceiling: a legible quantity keeps its intent,
 * and what the platform cannot represent is clamped rather than replaced.
 * Answering a tightening typo with a LOOSER bound is the one wrong direction —
 * `250ms` must not become the 10s default. Only input with no quantity in it at
 * all falls back.
 */

/** setTimeout's own resolution: anything smaller already behaves as 1ms. */
const MIN_TIMEOUT_MS = 1;

/** Past this Node wraps the delay and fires immediately, failing every call. */
const MAX_TIMEOUT_MS = 2_147_483_647;

const DEFAULT_EVAL_TIMEOUT_MS = 10_000;

const MS_UNITS: Record<string, number> = { ms: 1, s: 1000, sec: 1000, secs: 1000 };

/**
 * Warned once per VARIABLE, not once per process and not once per read.
 *
 * Per read would flood the log: `msEnv` is called per numerical routine via
 * `integrationBudgetMs`, so a typo would print one line per integration for as
 * long as it lived, burying the operator's own traffic. Per process would be
 * worse in the other direction — the first bad variable would silence the
 * second.
 */
const warned = new Set<string>();

function warnOnce(name: string, message: string): void {
  if (warned.has(name)) return;
  warned.add(name);
  console.error(message);
}

/**
 * Reads a quantity with an optional unit suffix, in the units of `units`.
 *
 * Exists because `Number('64MB')` is NaN, and treating that as "no value" hands
 * back a default LOOSER than what the operator wrote — the failure this module
 * exists to end, in a different spelling. A bare number is taken as already
 * being in the target unit, which is what the variable names promise.
 *
 * Returns undefined when there is no number, or the unit is not one we know:
 * guessing at `64 furlongs` would be worse than falling back and saying so.
 */
export function parseQuantity(raw: string, units: Record<string, number>): number | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  // Unit-less first, so everything `Number` already understood keeps working —
  // `0x40` and `64e0` were accepted before this parser existed, and refusing
  // them now would hand back a default LOOSER than what was written.
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct;
  const match = /^(.+?)\s*([a-z]+)$/i.exec(trimmed);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const factor = units[match[2].toLowerCase()];
  return factor === undefined ? undefined : value * factor;
}

/**
 * A millisecond bound from `name`, or `fallback` when the variable carries no
 * usable quantity. Clamped into what setTimeout can actually represent.
 */
export function msEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  // Unset or blank is not a misconfiguration — `.env` files and compose produce
  // a set-but-empty var constantly — so it takes the fallback silently.
  if (raw === undefined || raw.trim() === '') return fallback;

  const quantity = parseQuantity(raw, MS_UNITS);
  if (quantity === undefined || quantity <= 0) {
    // Quoted like http.ts's MCP_PORT refusal, so an invisible value stays legible.
    warnOnce(
      name,
      `[axiom] ignoring ${name}=${JSON.stringify(raw)}: no usable number of milliseconds in it; ` +
        `using ${fallback}ms`
    );
    return fallback;
  }

  const effective = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(quantity)));
  if (effective !== quantity) {
    warnOnce(
      name,
      `[axiom] ${name}=${JSON.stringify(raw)} is outside what a timer can hold ` +
        `(${MIN_TIMEOUT_MS}-${MAX_TIMEOUT_MS}ms); using ${effective}ms`
    );
  }
  return effective;
}

/**
 * Wall-clock bound per evaluation, shared by the CAS worker and the js-compute
 * worker: both answer the same operator question, "how long may one evaluation
 * hold the server".
 */
export function evalTimeoutMs(): number {
  return msEnv('AXIOM_EVAL_TIMEOUT_MS', DEFAULT_EVAL_TIMEOUT_MS);
}
