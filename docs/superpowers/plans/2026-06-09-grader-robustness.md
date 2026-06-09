# Benchmark Grader Robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce benchmark grader false-negatives — wire sound symbolic equivalence into the production grade path and harden answer extraction (inline-math delimiters + multi-value lists) — without introducing any false-positives.

**Architecture:** `grade()` becomes async and runs `gradeV2Async` with a memoized Giac bridge (sound `simplify((p)-(g))==0`; timeout/error → no match). `extractModelAnswer`/`cleanExtracted` gain inline-math (`\(...\)`/`\[...\]`) stripping and bare comma-list preservation. New real-bridge unit tests cover recovered cases AND a no-false-positive guardrail set.

**Tech Stack:** TypeScript, ES modules (`.js` imports), Vitest (real Giac WASM engine; `testTimeout` 60s). The benchmark grader lives in `benchmark/graders/`.

**Spec:** `docs/superpowers/specs/2026-06-09-grader-robustness-design.md`

**Guardrail (binding):** every change is precision-preserving. Symbolic equivalence is sound (Giac proves equality). Extraction only cleans/preserves — it cannot make a wrong answer right. A dedicated guardrail test set enforces this.

**Validation note (honest):** the existing traces store only the post-extraction `extractedAnswer`, NOT the raw model response, so the extraction fixes (Tasks 2-3) cannot be measured by `regrade.ts`; they are validated by unit tests. `regrade.ts` measures only the symbolic-equivalence lift on already-clean stored answers (a lower bound). Full measurement of the extraction fixes needs the deferred targeted re-run (which stores raw responses).

---

## File Structure

| File | Change |
|---|---|
| `benchmark/graders/grader.ts` (MODIFY) | `grade()` → async; memoized Giac `giacEval`; call `gradeV2Async` |
| `benchmark/index.ts` (MODIFY) | `await grade(...)` at the two call sites (lines ~178, ~230) |
| `benchmark/graders/answer-parser.ts` (MODIFY) | `cleanExtracted`: strip inline-math delimiters; `extractModelAnswer`: preserve bare comma-lists |
| `test/grader-robustness.test.ts` (NEW) | real-bridge: recovered symbolic + no-false-positive guardrail + async-grade end-to-end |
| `test/answer-parser-extraction.test.ts` (NEW) | inline-math + multi-value extraction unit tests (no engine) |

---

## Task 1: async `grade()` with symbolic equivalence

**Files:**
- Modify: `benchmark/graders/grader.ts`
- Modify: `benchmark/index.ts`
- Test: `test/grader-robustness.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/grader-robustness.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { gradeV2Async } from '../benchmark/graders/grader-v2.js';
import { getDefaultGiacBridge } from '../benchmark/graders/giac-bridge.js';
import { grade } from '../benchmark/graders/grader.js';

let giacEval: (expr: string) => Promise<string | null>;
beforeAll(async () => {
  const bridge = await getDefaultGiacBridge();
  giacEval = (expr) => bridge.evaluate(expr);
}, 60000);

describe('symbolic equivalence — recovered cases', () => {
  it('matches equivalent rational forms', async () => {
    const r = await gradeV2Async('1/(1+x^2)', '1/(x^2+1)', { giacEval });
    expect(r.match).toBe(true);
    expect(r.method).toBe('symbolic');
  });
  it('matches a re-associated polynomial', async () => {
    const r = await gradeV2Async('(x+1)^2', 'x^2+2*x+1', { giacEval });
    expect(r.match).toBe(true);
  });
});

describe('symbolic equivalence — guardrail (must NOT match)', () => {
  it('rejects genuinely different expressions', async () => {
    expect((await gradeV2Async('x^2', 'x^3', { giacEval })).match).toBe(false);
    expect((await gradeV2Async('1/(1+x^2)', '2/(1+x^2)', { giacEval })).match).toBe(false);
  });
  it('rejects non-equal abs vs bare (ln|x| vs ln x)', async () => {
    expect((await gradeV2Async('ln(abs(x))', 'ln(x)', { giacEval })).match).toBe(false);
  });
});

describe('async grade() end-to-end', () => {
  it('grades an equivalent-form response correct via symbolic stage', async () => {
    const r = await grade('Therefore the derivative is \\(\\frac{1}{1+x^2}\\).', '1/(x^2+1)');
    expect(r.correct).toBe(true);
    expect(r.method).toBe('symbolic');
  });
  it('still grades a wrong response wrong', async () => {
    const r = await grade('The answer is x^3.', 'x^2');
    expect(r.correct).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/grader-robustness.test.ts`
Expected: FAIL — `grade` is currently sync returning `GradeResult` (not a Promise; `r.correct` on a Promise is undefined), and the recovered symbolic cases fail because the production path has no symbolic stage. (The `gradeV2Async` recovered/guardrail cases may already pass — that's fine; the `grade()` end-to-end cases must fail before the change.)

- [ ] **Step 3: Make `grade()` async with a Giac bridge**

Replace the top imports and the `grade()` function in `benchmark/graders/grader.ts`. Change the imports:

```ts
import { toNumber, extractModelAnswer } from './answer-parser.js';
import { gradeV2Async } from './grader-v2.js';
import { getDefaultGiacBridge } from './giac-bridge.js';
```

Replace the `grade()` function body with:

```ts
export async function grade(modelResponse: string, groundTruth: string): Promise<GradeResult> {
  const predicted = extractModelAnswer(modelResponse);
  const ground = groundTruth.trim();

  const bridge = await getDefaultGiacBridge();
  const giacEval = (expr: string) => bridge.evaluate(expr);

  const v2Extracted = await gradeV2Async(predicted, ground, { giacEval });
  const v2Raw =
    predicted === modelResponse.trim()
      ? v2Extracted
      : await gradeV2Async(modelResponse.trim(), ground, { giacEval });
  const v2 = v2Extracted.match ? v2Extracted : v2Raw;

  return {
    correct: v2.match,
    predicted,
    ground,
    method: mapV2Method(v2.method),
  };
}
```

Leave `mapV2Method` and `gradeNumeric` unchanged (`mapV2Method` already maps `'symbolic'`). Note the `gradeV2` import is removed (no longer used) — confirm nothing else in the file references it.

- [ ] **Step 4: Update the two call sites in `benchmark/index.ts`**

At ~line 178-179 and ~line 230-231 the code is:
```ts
        const result =
          typeof groundTruth === 'number'
            ? gradeNumeric(br.text, groundTruth)
            : grade(br.text, groundTruthStr);
```
(second site uses `tr.text`). Add `await` before `grade(` at BOTH sites:
```ts
        const result =
          typeof groundTruth === 'number'
            ? gradeNumeric(br.text, groundTruth)
            : await grade(br.text, groundTruthStr);
```
and
```ts
        const result =
          typeof groundTruth === 'number'
            ? gradeNumeric(tr.text, groundTruth)
            : await grade(tr.text, groundTruthStr);
```
Both call sites are already inside the async per-problem loop, so `await` is valid. Verify with `npx tsc --noEmit` that no other caller of `grade()` exists that now needs awaiting (grep shows only these two).

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/grader-robustness.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 6: Run the full suite + typecheck**

Run: `npm test` then `npm run typecheck`
Expected: all pass; tsc clean. If a pre-existing test called `grade()` synchronously and now breaks, STOP and report (grep indicated none do).

- [ ] **Step 7: Commit**

```bash
git add benchmark/graders/grader.ts benchmark/index.ts test/grader-robustness.test.ts
git commit -m "feat(grader): wire sound symbolic equivalence into production grade()"
```

---

## Task 2: strip inline-math delimiters in extraction

**Files:**
- Modify: `benchmark/graders/answer-parser.ts`
- Test: `test/answer-parser-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/answer-parser-extraction.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractModelAnswer } from '../benchmark/graders/answer-parser.js';

describe('extraction — inline-math delimiters', () => {
  it('strips \\(...\\) around the answer', () => {
    expect(extractModelAnswer('Therefore the answer is \\(\\frac{1}{1+x^2}\\).'))
      .toBe('\\frac{1}{1+x^2}');
  });
  it('strips \\[...\\] around the answer', () => {
    expect(extractModelAnswer('The result: \\[x^2+1\\]')).toBe('x^2+1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/answer-parser-extraction.test.ts`
Expected: FAIL — the extracted strings retain `\(` / `\)` / `\[` / `\]` fragments.

- [ ] **Step 3: Strip inline-math delimiters in `cleanExtracted`**

In `benchmark/graders/answer-parser.ts`, update `cleanExtracted` to remove inline-math delimiter fragments FIRST (before the trailing-punctuation strip):

```ts
function cleanExtracted(s: string): string {
  return s
    .replace(/\\[()[\]]/g, '')   // inline-math delimiters \( \) \[ \]
    .replace(/\*\*/g, '')        // markdown bold
    .replace(/^\\\$/g, '')       // LaTeX dollar \$
    .replace(/^\$/g, '')         // plain dollar $
    .replace(/^[€£¥₹₽]/u, '')   // other currency
    .replace(/[.,;:!?)}\]]+$/, '') // trailing punctuation (keep leading minus)
    .trim();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/answer-parser-extraction.test.ts`
Expected: PASS (the two inline-math tests). The first should yield `\frac{1}{1+x^2}`.

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all pass. `\(...\)` stripping only removes delimiter fragments; existing answers without them are unchanged.

- [ ] **Step 6: Commit**

```bash
git add benchmark/graders/answer-parser.ts test/answer-parser-extraction.test.ts
git commit -m "feat(grader): strip inline-math delimiters in answer extraction"
```

---

## Task 3: preserve bare multi-value comma-lists

**Files:**
- Modify: `benchmark/graders/answer-parser.ts`
- Test: `test/answer-parser-extraction.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/answer-parser-extraction.test.ts`:

```ts
describe('extraction — bare multi-value lists', () => {
  it('keeps a trailing comma-list of values whole', () => {
    expect(extractModelAnswer('The eigenvalues are 3, 1.')).toBe('3, 1');
  });
  it('keeps a 3-value list whole', () => {
    expect(extractModelAnswer('The roots are -2, 0, 2')).toBe('-2, 0, 2');
  });
  it('does NOT treat prose with a stray comma as a list', () => {
    // "Step 1, we get 5" must extract 5, not "1, ...5"
    expect(extractModelAnswer('Step 1, we get 5')).toBe('5');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/answer-parser-extraction.test.ts -t "multi-value"`
Expected: FAIL — `'The eigenvalues are 3, 1.'` extracts `1` (last number), not `3, 1`.

- [ ] **Step 3: Add a bare comma-list extraction step**

In `benchmark/graders/answer-parser.ts`, in `extractModelAnswer`, add a new step immediately AFTER the `// 3b.` simple-fraction block and BEFORE the `// 4. Markdown-bold` block:

```ts
  // 3c. Bare comma-list of values at the very end (e.g. eigenvalues "3, 1").
  //     Requires >=2 numeric/expression members contiguous at the tail, so it
  //     does not fire on prose like "Step 1, we get 5".
  const listMatch = text
    .trim()
    .match(/(-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+)\s*[.)\]]?\s*$/);
  if (listMatch) {
    return listMatch[1].replace(/\s*,\s*/g, ', ').trim();
  }
```

This returns the whole list (normalized to `a, b`) so grader-v2's set / bareCommaList matching compares it order-insensitively against the ground truth.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/answer-parser-extraction.test.ts`
Expected: PASS (all, including the prose guard — `'Step 1, we get 5'` → `5`, because the tail `we get 5` is not a contiguous number comma-list).

- [ ] **Step 5: Run the full suite (no regressions)**

Run: `npm test`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add benchmark/graders/answer-parser.ts test/answer-parser-extraction.test.ts
git commit -m "feat(grader): preserve bare multi-value comma-lists in extraction"
```

---

## Task 4: validation + measurement

**Files:** none (verification only)

- [ ] **Step 1: Full suite + typecheck + lint**

Run: `npm test` (all green), `npm run typecheck` (clean), `npm run lint` (0 warnings/errors in `src/` — note the lint script covers `src/` only; the grader changes are under `benchmark/`, so also run `npx tsc --noEmit` which covers `benchmark/` and `test/`).

- [ ] **Step 2: Measure the symbolic-equivalence lift via regrade (lower bound)**

Run:
```bash
npx tsx benchmark/regrade.ts /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark/results/2026-05-08-08-42-51-zai-cas-quick-details.jsonl
```
`regrade.ts` already uses `gradeV2Async` + the default bridge. Record the reported delta (how many tool-augmented failures flip to correct on the stored extracted answers). This is a LOWER BOUND on the real lift — it cannot reflect the Task 2/3 extraction fixes (the traces store only post-extraction answers, not raw responses). Note the number in the commit message / summary; do NOT treat it as the full impact.

- [ ] **Step 3: Commit any incidental fixes**

If steps 1-2 surfaced fixes, commit them:
```bash
git add -A
git commit -m "fix(grader): resolve issues found during verification"
```
If nothing needed fixing, skip.

---

## Self-Review notes (incorporated)

- **Spec coverage:** symbolic-equivalence wiring → Task 1; inline-math extraction → Task 2; multi-value extraction → Task 3; guardrail (no false positives) → Task 1 guardrail tests; regrade measurement → Task 4. All spec sections mapped.
- **Soundness:** the only matching change is Giac symbolic equivalence (sound) + extraction that strips/preserves. Guardrail tests (`x^2` vs `x^3`, `1/(1+x^2)` vs `2/(1+x^2)`, `ln|x|` vs `ln x`) assert no false positives; the prose-comma test asserts the multi-value rule doesn't over-fire.
- **Async correctness:** `grade()` becomes async; both `index.ts` call sites are inside the async loop and gain `await`; `gradeNumeric` stays sync; no other `grade()` caller exists (grep-verified).
- **Method enum:** `gradeV2Async` returns `method: 'symbolic'` for the equivalence stage (`finish(..., 'symbolic')`); `mapV2Method` already maps it — no change needed.
- **Honest measurement limit:** extraction fixes are unit-test-validated only (raw responses not stored); regrade is a lower bound on the symbolic lift. Stated in the plan header and Task 4.
- **Golden test untouched:** new symbolic cases use a real bridge in `test/grader-robustness.test.ts` rather than the golden mock (which is keyed by exact expr strings and would be brittle).
