# CAS Pre-Giac Input Normalization (Tier 3) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize unicode math glyphs in user input before it reaches Giac, so `factor(x²-4)` and `2·x` compute correctly instead of producing corrupt (`xmicro`) or `undef` results.

**Architecture:** Reuse the existing pure `unicodeToAscii` helper. Extend it with one mapping (middot `·` → `*`), then apply it to input at two server-side chokepoints: `evalWithLatex` (covers all compute operations) and the `verify` tool's `claim`. Default-on, deterministic; ASCII input is a fixed point (no over-matching).

**Tech Stack:** TypeScript, ES modules (`.js` imports), Vitest (root config runs `test/**/*.test.ts` against the REAL Giac WASM engine; `testTimeout` 60s; no mock). Giac WASM.

**Spec:** `docs/superpowers/specs/2026-06-09-cas-input-normalization-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/tools/unicode-normalize.ts` (MODIFY) | add `·` → `*` mapping to the shared normalizer |
| `src/server/tools/giac-eval.ts` (MODIFY) | normalize `giacExpr` via `unicodeToAscii` before cacheKey/eval |
| `src/server/tools/verify/index.ts` (MODIFY) | normalize `claim` via `unicodeToAscii` at handler entry |
| `test/cas-input-normalization.test.ts` (NEW) | integration tests (compute + verify, real engine) |
| `test/unicode-normalize.test.ts` (MODIFY) | unit test for the middot mapping |

---

## Task 1: extend `unicodeToAscii` with middot

**Files:**
- Modify: `src/server/tools/unicode-normalize.ts`
- Test: `test/unicode-normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/unicode-normalize.test.ts` (inside the existing top-level `describe` for `unicodeToAscii`; if the file imports `unicodeToAscii` already, reuse that import — do NOT add a duplicate import):

```ts
  it('maps the middot · to multiplication', () => {
    expect(unicodeToAscii('2·x')).toBe('2*x');
  });
  it('still maps superscript ² to ^2 (regression)', () => {
    expect(unicodeToAscii('x²-4')).toBe('x^2-4');
  });
  it('leaves ASCII input unchanged', () => {
    expect(unicodeToAscii('factor(x^2-4)')).toBe('factor(x^2-4)');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unicode-normalize.test.ts`
Expected: the middot test FAILS (`'2·x'` is returned unchanged); the other two pass.

- [ ] **Step 3: Write the implementation**

In `src/server/tools/unicode-normalize.ts`, add the middot mapping immediately after the `.replace(/×/g, '*')` line (grouping the multiplication signs):

```ts
    .replace(/×/g, '*')
    .replace(/·/g, '*')
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unicode-normalize.test.ts`
Expected: PASS (all, including the new middot test).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/unicode-normalize.ts test/unicode-normalize.test.ts
git commit -m "feat(cas): map middot to multiply in unicodeToAscii"
```

---

## Task 2: normalize input in `evalWithLatex`

**Files:**
- Modify: `src/server/tools/giac-eval.ts`
- Test: `test/cas-input-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cas-input-normalization.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';
import { computeHandler } from '../src/server/tools/compute/index.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — input unicode normalization', () => {
  it('normalizes a superscript in giacExpr (no micro corruption)', async () => {
    const r = await evalWithLatex({ giacExpr: 'factor(x²-4)', operation: 'factor' });
    const text = allText(r);
    expect(text).toContain('Result: (x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
  it('normalizes a middot in giacExpr (no undef)', async () => {
    const r = await evalWithLatex({ giacExpr: 'simplify(2·x)', operation: 'simplify' });
    expect(allText(r)).toContain('Result: 2*x');
  });
});

describe('compute end-to-end — input unicode normalization', () => {
  it('factor(x²-4) via computeHandler resolves correctly', async () => {
    const r = await computeHandler({ problem: 'factor(x²-4)' });
    const text = allText(r);
    expect(text).toContain('(x-2)*(x+2)');
    expect(text).not.toContain('micro');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-input-normalization.test.ts`
Expected: FAIL — `factor(x²-4)` yields `(xmicro-2)*(xmicro+2)` (contains `micro`); `simplify(2·x)` yields `undef`.

- [ ] **Step 3: Write the implementation**

In `src/server/tools/giac-eval.ts`:

(a) Add the import at the top (next to the other `./` imports):

```ts
import { unicodeToAscii } from './unicode-normalize.js';
```

(b) At the very top of `evalWithLatex`, normalize the incoming expression. Change the destructuring line so `giacExpr` is the normalized value (do NOT destructure `giacExpr` from `options`; derive it):

Replace:
```ts
export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage, resultTransform, verify, methodNote } = options;
```
with:
```ts
export async function evalWithLatex(options: EvalOptions) {
  const { operation, errorMessage, resultTransform, verify, methodNote } = options;
  // Normalize unicode math glyphs in the input before anything else (cacheKey,
  // evaluation, latex) so e.g. factor(x²-4) is not parsed as factor(xmicro-4).
  const giacExpr = unicodeToAscii(options.giacExpr);
```

Everything below (cacheKey computation, evaluate, etc.) stays the same — it now operates on the normalized `giacExpr`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-input-normalization.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all pass. ASCII-input tests are unaffected (normalization is a fixed point on ASCII). If a PRE-EXISTING test fails, STOP and report DONE_WITH_CONCERNS with the test name.

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/giac-eval.ts test/cas-input-normalization.test.ts
git commit -m "feat(cas): normalize unicode input in evalWithLatex before Giac"
```

---

## Task 3: normalize `claim` in the `verify` tool

**Files:**
- Modify: `src/server/tools/verify/index.ts`
- Test: `test/cas-input-normalization.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/cas-input-normalization.test.ts` (add the import at the top of the file alongside the others):

```ts
import { verifyHandler } from '../src/server/tools/verify/index.js';

describe('verify tool — input unicode normalization', () => {
  it('verifies an identity written with unicode glyphs', async () => {
    const r = await verifyHandler({ claim: 'x² = x·x' });
    expect(allText(r)).toContain('Verified: TRUE ✓');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-input-normalization.test.ts -t "unicode glyphs"`
Expected: FAIL — without normalization the claim `x² = x·x` does not verify (`Verified: FALSE ✗` or a parse failure).

- [ ] **Step 3: Write the implementation**

In `src/server/tools/verify/index.ts`:

(a) Add the import at the top (the file is in `tools/verify/`, so the helper is one level up):

```ts
import { unicodeToAscii } from '../unicode-normalize.js';
```

(b) In `verifyHandler`, normalize the claim at entry. Replace:
```ts
  const claim = args.claim as string;
```
with:
```ts
  const claim = unicodeToAscii(String(args.claim ?? ''));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-input-normalization.test.ts`
Expected: PASS (all 4 tests in this file).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/verify/index.ts test/cas-input-normalization.test.ts
git commit -m "feat(cas): normalize unicode in verify tool claim"
```

---

## Task 4: full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all pass (no regressions; the only behavior change is that unicode-laden inputs now parse correctly).

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 warnings, 0 errors in touched files.

- [ ] **Step 4: Commit any incidental fixes**

If steps 1-3 surfaced fixes, commit them:

```bash
git add -A
git commit -m "fix(cas): resolve issues found during verification"
```

If nothing needed fixing, skip this step.

---

## Self-Review notes (incorporated)

- **Spec coverage:** middot extension → Task 1; `evalWithLatex` input normalization → Task 2; `verify` claim normalization → Task 3. All three spec touch-points mapped.
- **Cache benefit:** Task 2 normalizes before `cacheKey`, so `factor(x²-4)` and `factor(x^2-4)` share a cache entry (per spec).
- **Defensive claim handling:** Task 3 uses `String(args.claim ?? '')` so `unicodeToAscii` cannot throw on a missing claim (the zod schema requires `claim`, but this stays safe for direct handler calls).
- **No over-matching:** `unicodeToAscii` only rewrites specific unicode glyphs; ASCII `giacExpr`/`claim` pass through unchanged, so existing tests are unaffected.
- **No flags:** behavior is default-on, independent of `AXIOM_COMPUTE_HYGIENE` (which applies `unicodeToAscii` to OUTPUT; this plan adds INPUT normalization at a different layer).
