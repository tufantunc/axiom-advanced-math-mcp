# Server Stability + Grader Residue — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the MCP server survive any wedged Giac evaluation (worker-thread watchdog + recycle), and teach the grader three verified sound residue patterns (v3-gated, guardrailed).

**Architecture:** Giac WASM moves into a `node:worker_threads` Worker (`worker.ts`); a host bridge (`worker-host.ts`) enforces a per-call timeout and, on timeout/crash, terminates and lazily respawns the worker — `giacEngine`'s public interface is unchanged. Grader: `extractRHS` gains an opt-in bare-variable LHS mode; two new pure helpers strip trailing `≠` constraints and `label =` prefixes; gradeV2's v3 stage tries them as additional candidates.

**Tech Stack:** TypeScript, ES modules (`.js` imports), `node:worker_threads`, Vitest (real WASM engine; `testTimeout` 60s), tsx.

**Spec:** `docs/superpowers/specs/2026-06-10-server-stability-grader-residue-design.md`

**De-risked:** a spike verified `new Worker('<path>.ts', { execArgv: ['--import', 'tsx'] })` works under BOTH `npx tsx` and vitest in this repo (returned a round-trip result in <200ms). The child_process fallback from the spec should not be needed; if the implementer hits a loader failure anyway, STOP and report (do not improvise).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/giac/worker.ts` (NEW) | worker entry: hosts `WasmGiacEngine`, answers `{id,expr}` messages; deterministic `__AXIOM_TEST_HANG__` hook |
| `src/server/giac/worker-host.ts` (NEW) | main-thread bridge: per-call timeout, terminate+respawn recycle, init handshake |
| `src/server/giac/wrapper.ts` (MODIFY) | `giacEngine` delegates to the worker host (public interface unchanged) |
| `benchmark/graders/extract-rhs.ts` (MODIFY) | `allowBareVarLHS` option + `hasTopLevelEquals` export |
| `benchmark/graders/answer-residue.ts` (NEW) | `stripTrailingConstraint`, `stripValueLabels` (pure) |
| `benchmark/graders/grader-v2.ts` (MODIFY) | v3 stage: 3 residue candidates |
| `test/giac-worker-host.test.ts` (NEW) | watchdog + recycle proof |
| `test/grader-residue.test.ts` (NEW) | recovered + guardrail + gating tests |

---

## Task 1: Giac worker + watchdog host

**Files:**
- Create: `src/server/giac/worker.ts`
- Create: `src/server/giac/worker-host.ts`
- Test: `test/giac-worker-host.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/giac-worker-host.test.ts`:

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { createWorkerHost } from '../src/server/giac/worker-host.js';

describe('giac worker host — watchdog + recycle', () => {
  const host = createWorkerHost({ timeoutMs: 3000 });
  afterAll(async () => {
    await host.dispose();
  });

  it('evaluates normally through the worker', async () => {
    expect(await host.evaluate('diff(x^3, x)')).toBe('3*x^2');
  }, 60000);

  it('times out a wedged evaluation and recovers on the next call', async () => {
    await expect(host.evaluate('__AXIOM_TEST_HANG__')).rejects.toThrow('Giac evaluation timed out');
    // Recycle proof: a fresh worker serves the next call.
    expect(await host.evaluate('1+1')).toBe('2');
  }, 60000);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/giac-worker-host.test.ts`
Expected: FAIL — module `../src/server/giac/worker-host.js` not found.

- [ ] **Step 3: Create the worker entry**

Create `src/server/giac/worker.ts`:

```ts
import { parentPort } from 'node:worker_threads';
import { WasmGiacEngine } from './wasm-wrapper.js';

/**
 * Worker entry: hosts the Giac WASM engine on its own thread so a wedged
 * synchronous caseval can never block the MCP server's event loop.
 */
const port = parentPort!;
const engine = new WasmGiacEngine();

const ready = engine
  .initialize()
  .then(() => port.postMessage({ type: 'ready' }))
  .catch((e) =>
    port.postMessage({ type: 'init-error', error: e instanceof Error ? e.message : String(e) })
  );

port.on('message', async (msg: { id: number; expr: string }) => {
  await ready;
  // Deterministic hang hook for watchdog tests — never sent by production code.
  if (msg.expr === '__AXIOM_TEST_HANG__') {
    for (;;) {
      /* block this worker thread forever */
    }
  }
  try {
    const result = await engine.evaluate(msg.expr);
    port.postMessage({ type: 'result', id: msg.id, result });
  } catch (e) {
    port.postMessage({
      type: 'result',
      id: msg.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});
```

- [ ] **Step 4: Create the host bridge**

Create `src/server/giac/worker-host.ts`:

```ts
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export interface WorkerHostOptions {
  timeoutMs?: number;
}

interface Pending {
  resolve: (s: string) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.AXIOM_EVAL_TIMEOUT_MS ?? 10_000);
const INIT_TIMEOUT_MS = 30_000;

/**
 * Main-thread bridge to the Giac worker. Enforces a hard per-call timeout;
 * on timeout (or worker crash) it terminates the worker, fails in-flight
 * calls, and lazily respawns a fresh worker (fresh WASM engine) on the next
 * call. The server process never dies with a wedged evaluation.
 *
 * Note: a recycle resets Giac global state (e.g. `sto` assignments) — accepted,
 * documented in the design spec; recycling happens only on timeout/crash.
 */
export function createWorkerHost(opts: WorkerHostOptions = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let worker: Worker | null = null;
  let readyPromise: Promise<void> | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  // Resolve the sibling worker entry with the SAME extension as this module:
  // under tsx/vitest this file is .ts → spawn worker.ts with the tsx loader;
  // in the compiled dist it is .js → spawn worker.js plain.
  const here = fileURLToPath(import.meta.url);
  const isTs = here.endsWith('.ts');
  const workerPath = path.join(path.dirname(here), isTs ? 'worker.ts' : 'worker.js');
  const execArgv = isTs ? ['--import', 'tsx'] : [];

  function failAllPending(err: Error): void {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  }

  function recycle(err: Error): void {
    const w = worker;
    worker = null;
    readyPromise = null;
    failAllPending(err);
    if (w) void w.terminate();
  }

  function ensureWorker(): Promise<void> {
    if (worker && readyPromise) return readyPromise;
    const w = new Worker(workerPath, { execArgv });
    worker = w;
    readyPromise = new Promise<void>((resolve, reject) => {
      const initTimer = setTimeout(() => {
        const err = new Error('Giac worker init timed out');
        recycle(err);
        reject(err);
      }, INIT_TIMEOUT_MS);

      w.on('message', (msg: { type?: string; id?: number; result?: string; error?: string }) => {
        if (msg.type === 'ready') {
          clearTimeout(initTimer);
          resolve();
          return;
        }
        if (msg.type === 'init-error') {
          clearTimeout(initTimer);
          const err = new Error(`Giac worker init failed: ${msg.error}`);
          recycle(err);
          reject(err);
          return;
        }
        if (msg.type === 'result' && msg.id !== undefined) {
          const p = pending.get(msg.id);
          if (!p) return; // already timed out
          pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error !== undefined) p.reject(new Error(msg.error));
          else p.resolve(msg.result ?? '');
        }
      });
      w.on('error', (e) => {
        clearTimeout(initTimer);
        const err = e instanceof Error ? e : new Error(String(e));
        recycle(err);
        reject(err);
      });
      w.on('exit', (code) => {
        if (worker === w) recycle(new Error(`Giac worker exited (code ${code})`));
      });
    });
    return readyPromise;
  }

  return {
    async evaluate(expr: string): Promise<string> {
      await ensureWorker();
      const w = worker!;
      const id = nextId++;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          const err = new Error('Giac evaluation timed out');
          recycle(err); // kill the wedged worker; next call gets a fresh one
          reject(err);
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        w.postMessage({ id, expr });
      });
    },
    async warmup(): Promise<void> {
      await ensureWorker();
    },
    isReady(): boolean {
      return worker !== null;
    },
    async dispose(): Promise<void> {
      const w = worker;
      worker = null;
      readyPromise = null;
      failAllPending(new Error('worker host disposed'));
      if (w) await w.terminate();
    },
  };
}

export type WorkerHost = ReturnType<typeof createWorkerHost>;
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/giac-worker-host.test.ts`
Expected: PASS (2 tests — normal eval `3*x^2`; hang times out with `Giac evaluation timed out` then `1+1` → `2` on a fresh worker).

- [ ] **Step 6: Commit**

```bash
git add src/server/giac/worker.ts src/server/giac/worker-host.ts test/giac-worker-host.test.ts
git commit -m "feat(giac): worker-thread evaluator with watchdog timeout + recycle"
```

---

## Task 2: wire `giacEngine` through the worker host

**Files:**
- Modify: `src/server/giac/wrapper.ts`

- [ ] **Step 1: Rewire the wrapper**

Replace the ENTIRE contents of `src/server/giac/wrapper.ts` (current version holds a direct `WasmGiacEngine` + `ensureInit`) with:

```ts
import { createWorkerHost } from './worker-host.js';
import type { GiacEngine } from './interface.js';

// Singleton host: one worker (one WASM engine) per process, recycled on
// timeout/crash by the host. Public GiacEngine interface is unchanged.
const host = createWorkerHost();

export const giacEngine: GiacEngine = {
  initialize: () => host.warmup(),
  async evaluate(expression: string): Promise<string> {
    await host.warmup();
    return host.evaluate(expression);
  },
  isReady(): boolean {
    return host.isReady();
  },
};
```

- [ ] **Step 2: Typecheck + targeted smoke**

Run: `npx tsc --noEmit` (clean), then a tsx-path sanity check (the production loader path):
```bash
npx tsx -e "import('./src/server/giac/index.js').then(async (m) => { await m.giacEngine.initialize(); console.log(await m.giacEngine.evaluate('factor(x^2-4)')); process.exit(0); })"
```
Expected: `(x-2)*(x+2)`.

- [ ] **Step 3: Run the FULL suite (the real regression gate)**

Run: `npm test`
Expected: all pass (interface unchanged; every existing real-engine test now routes through the worker). Slightly higher startup per vitest worker (~0.5-1s tsx bootstrap) is expected; `testTimeout` is 60s. If a test fails on timing, report it — do NOT raise global timeouts silently.

- [ ] **Step 4: Build sanity (dist path)**

Run: `npm run build`
Expected: tsc compiles cleanly (worker.ts → `dist/server/giac/worker.js`; the host's extension-aware resolution picks `.js` in dist).

- [ ] **Step 5: Commit**

```bash
git add src/server/giac/wrapper.ts
git commit -m "feat(giac): route giacEngine through the watchdog worker host"
```

---

## Task 3: grader residue patterns (v3-gated)

**Files:**
- Modify: `benchmark/graders/extract-rhs.ts`
- Create: `benchmark/graders/answer-residue.ts`
- Modify: `benchmark/graders/grader-v2.ts`
- Test: `test/grader-residue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/grader-residue.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gradeV2 } from '../benchmark/graders/grader-v2.js';

describe('grader residue patterns (v3-gated)', () => {
  beforeAll(() => {
    process.env.AXIOM_GRADER_V3 = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_GRADER_V3;
  });

  it('accepts a single-variable equation when ground is bare (n = 4 vs 4)', () => {
    expect(gradeV2('n = 4', '4').match).toBe(true);
  });
  it('guards: wrong value still wrong (n = 5 vs 4)', () => {
    expect(gradeV2('n = 5', '4').match).toBe(false);
  });
  it('keeps the strict rule when ground IS an equation', () => {
    expect(gradeV2('n = 4', 'm = 5').match).toBe(false);
  });

  it('strips a trailing ≠ constraint (x + 1, \\quad x \\neq 1 vs x+1)', () => {
    expect(gradeV2('x + 1, \\quad x \\neq 1', 'x+1').match).toBe(true);
  });
  it('guards: different expression with constraint still wrong', () => {
    expect(gradeV2('x + 2, \\quad x \\neq 1', 'x+1').match).toBe(false);
  });

  it('strips labels from fully-labeled multi-values (λ1 = i, λ2 = -i vs i,-i)', () => {
    expect(gradeV2('\\lambda_1 = i, \\quad \\lambda_2 = -i', 'i,-i').match).toBe(true);
  });
  it('guards: wrong labeled values still wrong', () => {
    expect(gradeV2('\\lambda_1 = i, \\lambda_2 = i', 'i,-i').match).toBe(false);
  });

  it('gating: patterns are OFF without AXIOM_GRADER_V3', () => {
    delete process.env.AXIOM_GRADER_V3;
    expect(gradeV2('n = 4', '4').match).toBe(false);
    process.env.AXIOM_GRADER_V3 = '1';
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grader-residue.test.ts`
Expected: FAIL — the three "accepts/strips" cases return `match: false` today (guard + gating cases may already pass).

- [ ] **Step 3: Extend `extract-rhs.ts`**

In `benchmark/graders/extract-rhs.ts`:

(a) Change the signature and the final LHS check of `extractRHS`:
```ts
export function extractRHS(
  input: string,
  opts: { allowBareVarLHS?: boolean } = {}
): string | null {
```
and replace the final check:
```ts
  // LHS must look like a function call OR a multi-character symbolic name.
  // Single bare variables ("x", "y", "a") are rejected unless the caller
  // explicitly opts in (used asymmetrically when the GROUND TRUTH is not an
  // equation — then "n = 4" is a labeled answer, not a renaming).
  const looksLikeFunctionCall = /\(/.test(lhs);
  const isMultiCharSymbol = /[A-Za-z]{2,}/.test(lhs);
  if (!looksLikeFunctionCall && !isMultiCharSymbol && !opts.allowBareVarLHS) return null;
```

(b) Add an exported helper at the end of the file:
```ts
/** True iff the input contains a top-level (bracket-depth-0) '=' character. */
export function hasTopLevelEquals(input: string): boolean {
  let depth = 0;
  for (const ch of input) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) return true;
  }
  return false;
}
```

- [ ] **Step 4: Create `benchmark/graders/answer-residue.ts`**

```ts
import { splitTopLevel } from '../../src/server/tools/output-cleanup.js';

/**
 * Sound residue transforms for grader-v2's v3 stage. Each returns the
 * transformed candidate, or null when the pattern does not apply (so the
 * caller simply moves on). Narrow by design — the binding no-false-positive
 * guardrail forbids anything broader.
 */

/** Strip a single trailing domain constraint of the form ", x ≠ 1" /
 *  ", \quad x \neq 1" / ", x != 1". Returns the remainder, or null. */
const CONSTRAINT_TAIL = /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*[^,]+\s*$/;
export function stripTrailingConstraint(s: string): string | null {
  const m = s.match(CONSTRAINT_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

/** When EVERY top-level comma segment is "<label> = <value>" (e.g.
 *  "\lambda_1 = i, \lambda_2 = -i"), return the bare value list "i, -i".
 *  Mixed labeled/unlabeled input returns null (left untouched). */
export function stripValueLabels(s: string): string | null {
  const cleaned = s.replace(/\\quad\b/g, ' ').trim();
  const parts = splitTopLevel(cleaned, ',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const values: string[] = [];
  for (const part of parts) {
    const m = part.match(/^\\?[A-Za-z]+(?:_\{?\w+\}?)?\s*=\s*(.+)$/);
    if (!m) return null;
    values.push(m[1].trim());
  }
  return values.join(', ');
}
```

- [ ] **Step 5: Add the residue candidates to gradeV2's v3 stage**

In `benchmark/graders/grader-v2.ts`:

(a) Update imports:
```ts
import { extractRHS, hasTopLevelEquals } from './extract-rhs.js';
import { stripTrailingConstraint, stripValueLabels } from './answer-residue.js';
```

(b) Inside the existing `if (process.env.AXIOM_GRADER_V3 === '1' && !opts._skipV3) { ... }` block, AFTER the existing `gRHS` attempt and before the block's closing brace, add:

```ts
    // Residue 1: predicted is "var = value" while ground is NOT an equation —
    // accept the RHS (asymmetric: the ground-truth side keeps the strict rule).
    if (!hasTopLevelEquals(ground)) {
      const pBare = extractRHS(predicted, { allowBareVarLHS: true });
      if (pBare !== null) {
        const r = gradeV2(pBare, ground, innerOpts);
        if (r.match) {
          return { ...r, method: 'equation-rhs-match' as GradeResultV2['method'] };
        }
      }
    }
    // Residue 2: trailing domain constraint ", x ≠ 1" on the predicted answer.
    const pNoConstraint = stripTrailingConstraint(predicted);
    if (pNoConstraint !== null) {
      const r = gradeV2(pNoConstraint, ground, innerOpts);
      if (r.match) return r;
    }
    // Residue 3: fully-labeled multi-value ("λ₁ = i, λ₂ = -i") → bare list,
    // matched order-insensitively by the (v3) bareCommaList set stage.
    const pUnlabeled = stripValueLabels(predicted);
    if (pUnlabeled !== null) {
      const r = gradeV2(pUnlabeled, ground, innerOpts);
      if (r.match) return r;
    }
```

(Note: `innerOpts` already exists in that block with `_skipV3: true`, which prevents recursion into the v3-RHS stage while the env-gated set-stage `bareCommaList` still applies — exactly what residue 3 needs.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/grader-residue.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 7: Run the full suite + typecheck**

Run: `npm test` and `npx tsc --noEmit`
Expected: all green / clean (golden grader suite unaffected — patterns are v3-gated and narrow).

- [ ] **Step 8: Commit**

```bash
git add benchmark/graders/extract-rhs.ts benchmark/graders/answer-residue.ts benchmark/graders/grader-v2.ts test/grader-residue.test.ts
git commit -m "feat(grader): v3 residue patterns — bare-var RHS, constraint strip, label strip"
```

---

## Task 4: full verification + re-measure protocol

**Files:** none (verification only)

- [ ] **Step 1: Full suite, typecheck, lint**

Run: `npm test` (all green; report count), `npm run typecheck` (clean), `npm run lint` (0 warnings/errors).

- [ ] **Step 2: Offline residue confirmation on the stored run**

Run regrade on the 2026-06-10 traces (raw responses stored, so the residue fixes are measurable offline):
```bash
npx tsx benchmark/regrade.ts /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark/results/2026-06-10-00-18-10-zai-math-l4-math-l5-cas-quick-details.jsonl
```
Note: regrade.ts itself does not set `AXIOM_GRADER_V3`; run it as
`AXIOM_GRADER_V3=1 npx tsx benchmark/regrade.ts <path>` so the residue patterns
apply. Expected: the tool-aug delta improves vs the stored labels (the verified
residue cases — e.g. CAS #5/#49/#52 — flip to correct). Report the delta.

- [ ] **Step 3: Commit any incidental fixes** (skip if none).

- [ ] **Step 4: NOTE the user-run re-measure protocol (no action)**

After merge to main, the user runs the clean CAS re-measurement:
```bash
cd benchmark && npx tsx index.ts --cas --quick --zai --features=grader-v3
```
Expected: tool-call failure rate ≈ 0 (a wedge now costs one failed call, not the server), CAS +MCP back at/above ~70%.

---

## Self-Review notes (incorporated)

- **Spec coverage:** Component 1 (worker watchdog + recycle) → Tasks 1-2; Component 2 (3 residue patterns, v3-gated, guardrails) → Task 3; Component 3 (re-measure protocol) → Task 4. All mapped.
- **De-risk:** the loader spike (tsx + vitest) already passed; the host resolves the worker entry extension-aware (`.ts`+tsx loader in dev, `.js` plain in dist), covered by Task 2's build step.
- **Recycle semantics:** in-flight calls all fail on recycle (documented); `sto` reset accepted per spec; `__AXIOM_TEST_HANG__` hook is inert in production (exact-string match, never generated by tools).
- **Guardrails:** Task 3 tests include wrong-value, wrong-expression, wrong-labeled-values, GT-is-equation, and v3-off gating — no false-positive path.
- **Type consistency:** `createWorkerHost`/`WorkerHost` (Task 1) used in Task 2; `extractRHS(input, opts)` second param is optional so the existing two call sites in grader-v2 are source-compatible; helper names consistent across Tasks 3a/3b/3c.
- **`splitTopLevel` reuse:** imported from `src/server/tools/output-cleanup.js` (benchmark already imports src modules, e.g. the normalizer's `unicodeToAscii`).
