# Server Stability + Grader Residue — Design

**Date:** 2026-06-10
**Branch:** `server-stability-grader-residue` (isolated worktree, based on `main`)
**Status:** DESIGN — approved, pending implementation plan

## Background

The 2026-06-10 post-tier benchmark run (`2026-06-10-00-18-10-...`) delivered the
strongest MCP result yet (MATH L5 58% → 80%) but exposed two problems:

1. **The MCP server hard-hung mid-run.** Tool-call failure rate by run-order
   octile: 0%, 0%, 0%, 0%, 41%, 100%, 100%, 100% — after ~520 calls the server
   stopped responding permanently and all 291 subsequent calls failed with
   `MCP error -32001: Request timed out`. CAS ran last and bore the full damage
   (its −13.3pp is an artifact of a dead tool, not a capability change).
2. **Grader residue.** Among the model's tool-less fallback answers, several
   mathematically-correct forms failed to grade (verified live):
   `n = 4` vs `4`; `x + 1, \quad x \neq 1` vs `x+1`;
   `\lambda_1 = i, \quad \lambda_2 = -i` vs `i,-i`.

### Root-cause evidence (server hang)

- In-process stress (800 mixed compute/verify calls): flat memory (~417MB RSS),
  zero hangs → no simple leak.
- The first timed-out call (an LLM-written imperative `for` loop) returns in
  **22ms on a fresh engine** → the trigger is state-accumulation-dependent
  (hundreds of heavy L4/L5 evaluations + `sto` assignments), not one expression;
  the exact trigger is not deterministically isolable.
- **The architectural defect is certain:** Giac's `caseval` is a synchronous C
  call running on the same event loop as the MCP server, with no watchdog and no
  recovery. Whatever wedges one evaluation kills the server permanently.

The fix must therefore be **cause-agnostic**: isolate the evaluation, bound it
with a hard timeout, and recover by recycling the engine.

## Goals

1. The MCP server survives ANY wedged Giac evaluation: the affected call fails
   fast with a structured error; subsequent calls work (fresh engine).
2. The grader correctly accepts the three verified residue patterns — without
   any false positives (binding guardrail, as in prior grader work).
3. A documented protocol re-measures CAS cleanly after the fix.

**Non-goals:** pinpointing the exact wedge expression (cause-agnostic recovery
makes it unnecessary); benchmark-side server restarts (defense-in-depth deferred
— the production fix covers all clients); prompt changes.

## Component 1 — Isolated Giac evaluator (watchdog + recycle)

Move WASM evaluation off the server's event loop into a `node:worker_threads`
Worker, bridged by a host that enforces a per-call timeout and recycles the
worker on timeout.

### New `src/server/giac/worker.ts` (runs inside the Worker)

Hosts the existing `WasmGiacEngine` (initialized once per worker). Receives
`{ id, expr }` messages on `parentPort`, replies `{ id, result }` on success or
`{ id, error }` when the engine throws. The synchronous `caseval` blocking THIS
thread is fine — the server's loop stays free.

### New `src/server/giac/worker-host.ts` (main thread)

```ts
export interface WorkerHostOptions { timeoutMs?: number }  // default 10_000,
// overridable via AXIOM_EVAL_TIMEOUT_MS
export function createWorkerHost(opts?: WorkerHostOptions): {
  evaluate(expr: string): Promise<string>;
  isReady(): boolean;
}
```

- Lazily spawns the worker on first `evaluate`; waits for a `ready` handshake
  (engine initialized) before dispatching.
- Each `evaluate` registers a pending entry keyed by `id` with a timer.
- **On timeout:** `worker.terminate()`; the timed-out call (and any other
  in-flight calls) reject with `Error('Giac evaluation timed out')`; the worker
  reference is cleared so the NEXT call spawns a fresh worker + fresh WASM
  engine. The server process never dies.
- On worker `error`/`exit`, pending calls reject and the worker is recycled the
  same way.

### `src/server/giac/wrapper.ts` (modified)

`giacEngine` delegates `evaluate` to the worker host. The public interface
(`initialize(): Promise<void>`, `evaluate(expr): Promise<string>`,
`isReady(): boolean`) is unchanged — tools, tests, benchmark, and the verify
tool are untouched.

### Behavior notes (documented, accepted)

- A recycle resets Giac global state (e.g. `sto` variable assignments). Recycling
  happens only on timeout/crash, so this is rare; cross-call `sto` state was
  never a guaranteed contract.
- The timed-out call surfaces to the model as a structured tool error
  (`success: false`, message `Giac evaluation timed out`) — the model can adapt;
  subsequent calls work.
- The in-process `evaluationCache` (tools layer) is independent and unaffected.

### Loader-compatibility risk (flagged for the plan)

Loading a TS worker under tsx/vitest can be finicky. The plan must verify the
worker entry resolves under (a) `npm test` (vitest) and (b) `tsx src/cli.ts`
(production). If `worker_threads` + the TS loader prove unreliable, the SAME
design ships on `child_process.fork` (identical host semantics: per-call
timeout, kill, respawn). The host abstracts the primitive.

## Component 2 — Grader residue (three sound patterns, v3-gated)

All three are deterministic transforms gated behind `AXIOM_GRADER_V3` (the
extended-matching tier — consistent with the `bareCommaList` precedent; the
production benchmark recipe already runs `--features=grader-v3`). Each ships
with must-NOT-match guardrail tests; the binding rule from the grader-robustness
work applies: no change may make a wrong answer grade correct.

1. **Asymmetric single-variable RHS.** `extractRHS` currently rejects
   single-letter LHS (`n = 4`) by design ("x = 5 may itself be the answer").
   Extend gradeV2's v3 stage: when the GROUND TRUTH contains no top-level `=`,
   also try the RHS of a single-letter-LHS predicted equation. Guardrail:
   `n = 5` vs `4` stays wrong; when GT IS an equation the strict rule is
   unchanged.
2. **Constraint stripping.** New pure helper: strip a trailing domain constraint
   of the narrow form `,\s*(\\quad\s*)?<var>\s*(\\neq|≠|!=)\s*<expr>` (e.g.
   `x + 1, \quad x \neq 1` → `x + 1`), then re-grade the remainder. Only the
   `≠` constraint shape — nothing broader. Guardrail: `x + 2, x ≠ 1` vs `x+1`
   stays wrong.
3. **Label stripping for multi-values.** When EVERY top-level comma segment has
   the form `<label> = <value>` (e.g. `\lambda_1 = i, \quad \lambda_2 = -i`),
   strip the labels and compare the bare value list (`i, -i`) via the existing
   v3 `bareCommaList` order-insensitive match. Mixed labeled/unlabeled input is
   left untouched. Guardrail: `\lambda_1 = i, \lambda_2 = i` vs `i,-i` stays
   wrong.

Placement: helpers live beside the existing grader helpers
(`benchmark/graders/`), invoked from gradeV2's v3 stage as additional candidate
transforms before the final no-match.

## Component 3 — Clean CAS re-measurement (protocol, no code)

After both components merge to main:

```bash
cd benchmark
npx tsx index.ts --cas --quick --zai --features=grader-v3
```

(~60 problems, CAS only.) Expected: tool-call failure rate ≈ 0 even if a wedge
occurs (watchdog converts it to a single failed call); CAS +MCP back at/above
the ~70% band. Cheap supplementary check: run `regrade.ts` on the
`2026-06-10-00-18-10` details (raw responses stored) — the grader-residue fixes
should flip the verified residue cases offline.

## Testing strategy

- **Worker host:** unit/integration — normal evaluate round-trips; a deliberately
  wedged evaluation (e.g. a worker-side test hook or a pathological long-running
  expression) times out with the structured error AND the next call succeeds
  (recycle proof); full existing suite (537) green unchanged (interface stable).
- **Grader patterns:** per pattern, recovered cases match + guardrail cases stay
  non-match; golden suite green; all gated behind `AXIOM_GRADER_V3`.

## Affected files

| File | Change |
|---|---|
| `src/server/giac/worker.ts` (NEW) | worker entry hosting WasmGiacEngine |
| `src/server/giac/worker-host.ts` (NEW) | timeout watchdog + recycle bridge |
| `src/server/giac/wrapper.ts` | delegate evaluate to worker host |
| `benchmark/graders/extract-rhs.ts` / `grader-v2.ts` | asymmetric single-var RHS (v3) |
| `benchmark/graders/` (new helper) | constraint stripping + label stripping (v3) |
| tests | worker-host watchdog/recycle; 3 patterns recovered + guardrail |

## Out of scope

- Benchmark-side health-check/restart (defense-in-depth; revisit only if the
  watchdog proves insufficient).
- Periodic preventive engine recycling (YAGNI — recycle on failure only).
- Broader lenient matching beyond the three verified patterns.
