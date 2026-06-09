# Measurement Quality (Boxed Prompt + Raw-Response Storage) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make benchmark measurement reflect the tool's real correctness — store the raw model response (so extraction is offline-regradable) and have the model emit a cleanly-extractable `\boxed{}` final answer.

**Architecture:** Benchmark-harness only. Add an optional `response` to the trace, populate it from the runner's raw text, and let `regrade.ts` re-extract from it. Replace the prose `The answer is <number>` format in every prompt with `\boxed{...}` (handled by the existing Tier-1 boxed fail-safe). No extractor heuristics; no `src/` change.

**Tech Stack:** TypeScript, ES modules (`.js` imports), Vitest. Benchmark grader/runner under `benchmark/`.

**Spec:** `docs/superpowers/specs/2026-06-09-measurement-quality-design.md`

**⚠ Critical escaping note (Task 4):** The prompts are template literals (backticks). Inside a JS string `\b` is a backspace escape — so `\boxed` would become a backspace + `oxed`. The source MUST use **`\\boxed`** (double backslash), which renders to the literal `\boxed`. Likewise `\\frac`, `\\text`.

---

## File Structure

| File | Change |
|---|---|
| `benchmark/problem-detail.ts` | add `response?: string` to `baseline` + `toolAugmented` |
| `benchmark/index.ts` | populate `response` from `br?.text` / `tr?.text` |
| `benchmark/regrade-extract.ts` (NEW) | pure `answerToGrade()` — re-extract from response else stored answer |
| `benchmark/regrade.ts` | use `answerToGrade()`; add `response?` to local `Detail` |
| `benchmark/providers/prompts.ts` | `\\boxed{}` final-answer format in all 9 prompt trailers |
| `test/regrade-extract.test.ts` (NEW) | `answerToGrade` unit tests |
| `test/prompt-format.test.ts` (NEW) | prompt-content + boxed-extraction regression |

---

## Task 1: store the raw response in the trace

**Files:**
- Modify: `benchmark/problem-detail.ts`
- Modify: `benchmark/index.ts`

This is a wiring task (field add + populate); it is verified by typecheck and inspection (the orchestration loop is not unit-tested in isolation). The payoff is exercised by Task 2/3's regrade re-extraction.

- [ ] **Step 1: Add the field to the type**

In `benchmark/problem-detail.ts`, add `response?: string;` to BOTH condition objects in `ProblemDetail`:

```ts
  baseline: {
    extractedAnswer: string;
    correct: boolean;
    method: string; // 'numeric' | 'string' | 'fallback'
    error?: string; // if API call threw
    response?: string; // raw model response text (for offline re-extraction)
    selfConsistency?: SelfConsistencyData;
  };

  toolAugmented: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    toolCalls: {
      name: string;
      args: Record<string, unknown>;
      result: string;
      success: boolean;
    }[];
    turns: number;
    error?: string;
    response?: string; // raw model response text (for offline re-extraction)
    selfConsistency?: SelfConsistencyData;
  };
```

- [ ] **Step 2: Populate it in index.ts**

In `benchmark/index.ts`, in the `detail` object construction, add a `response` line to each condition (alongside `extractedAnswer`). `br`/`tr` are the baseline/tool run results (possibly undefined on error), so use optional chaining:

In the `baseline: { ... }` block add:
```ts
          response: br?.text,
```
In the `toolAugmented: { ... }` block add:
```ts
          response: tr?.text,
```
(`response?: string` accepts `string | undefined`; `JSON.stringify` omits `undefined`.)

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. Confirm `br`/`tr` expose `.text` (they do — `grade(br.text, ...)` / `grade(tr.text, ...)` already use it).

- [ ] **Step 4: Commit**

```bash
git add benchmark/problem-detail.ts benchmark/index.ts
git commit -m "feat(benchmark): store raw model response in trace details"
```

---

## Task 2: `answerToGrade` re-extraction helper

**Files:**
- Create: `benchmark/regrade-extract.ts`
- Test: `test/regrade-extract.test.ts`

Placed in its own module (not `regrade.ts`) because `regrade.ts` calls `main()` at top level, so importing it in a test would execute the script.

- [ ] **Step 1: Write the failing test**

Create `test/regrade-extract.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { answerToGrade } from '../benchmark/regrade-extract.js';

describe('answerToGrade', () => {
  it('re-extracts from the raw response when present', () => {
    expect(answerToGrade({ response: 'work... \\boxed{3x^2}', extractedAnswer: '3' })).toBe('3x^2');
  });
  it('falls back to the stored extractedAnswer when no response', () => {
    expect(answerToGrade({ extractedAnswer: '3' })).toBe('3');
  });
  it('falls back when response is empty', () => {
    expect(answerToGrade({ response: '', extractedAnswer: '7' })).toBe('7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/regrade-extract.test.ts`
Expected: FAIL — module `../benchmark/regrade-extract.js` not found.

- [ ] **Step 3: Write the implementation**

Create `benchmark/regrade-extract.ts`:

```ts
import { extractModelAnswer } from './graders/answer-parser.js';

/**
 * The answer string to grade for one run condition: re-extract from the raw
 * response when present (so extraction changes are measured offline), else fall
 * back to the stored post-extraction answer (backward compatible with old
 * traces that have no `response`).
 */
export function answerToGrade(cond: { response?: string; extractedAnswer: string }): string {
  return cond.response !== undefined && cond.response !== ''
    ? extractModelAnswer(cond.response)
    : cond.extractedAnswer;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/regrade-extract.test.ts`
Expected: PASS (3 tests). The first asserts `extractModelAnswer('work... \\boxed{3x^2}')` → `3x^2` (boxed fail-safe).

- [ ] **Step 5: Commit**

```bash
git add benchmark/regrade-extract.ts test/regrade-extract.test.ts
git commit -m "feat(benchmark): add answerToGrade re-extraction helper"
```

---

## Task 3: wire regrade.ts to re-extract

**Files:**
- Modify: `benchmark/regrade.ts`

- [ ] **Step 1: Add the import + extend the local Detail type**

In `benchmark/regrade.ts`, add to the imports:
```ts
import { answerToGrade } from './regrade-extract.js';
```
Extend the local `Detail` interface's condition shapes with the optional response:
```ts
interface Detail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: { extractedAnswer: string; correct: boolean; response?: string };
  toolAugmented: { extractedAnswer: string; correct: boolean; response?: string };
}
```

- [ ] **Step 2: Use `answerToGrade` in the two grade calls**

Replace:
```ts
    const baseR = await gradeV2Async(d.baseline.extractedAnswer, d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    const toolR = await gradeV2Async(d.toolAugmented.extractedAnswer, d.groundTruth, {
      giacEval: bridge.evaluate,
    });
```
with:
```ts
    const baseR = await gradeV2Async(answerToGrade(d.baseline), d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    const toolR = await gradeV2Async(answerToGrade(d.toolAugmented), d.groundTruth, {
      giacEval: bridge.evaluate,
    });
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add benchmark/regrade.ts
git commit -m "feat(benchmark): regrade re-extracts from stored raw response"
```

---

## Task 4: boxed final-answer prompt

**Files:**
- Modify: `benchmark/providers/prompts.ts`
- Test: `test/prompt-format.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/prompt-format.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  BASELINE_SYSTEM_PROMPT,
  TOOL_SYSTEM_PROMPT,
  getToolPromptForProblem,
} from '../benchmark/providers/prompts.js';

describe('prompts — boxed final-answer format', () => {
  it('baseline and tool system prompts request \\boxed', () => {
    expect(BASELINE_SYSTEM_PROMPT).toContain('\\boxed');
    expect(TOOL_SYSTEM_PROMPT).toContain('\\boxed');
  });
  it('no prompt still uses the old number format', () => {
    expect(BASELINE_SYSTEM_PROMPT).not.toContain('The answer is <number>');
    expect(TOOL_SYSTEM_PROMPT).not.toContain('The answer is <number>');
    expect(getToolPromptForProblem('find the integral of x^2')).not.toContain('The answer is <number>');
  });
  it('category prompts (via selector) request \\boxed', () => {
    expect(getToolPromptForProblem('find the integral of x^2')).toContain('\\boxed');
    expect(getToolPromptForProblem('solve the quadratic equation')).toContain('\\boxed');
  });
});

describe('boxed extraction still works (regression guard)', () => {
  it('extracts a symbolic boxed answer', async () => {
    const { extractModelAnswer } = await import('../benchmark/graders/answer-parser.js');
    expect(extractModelAnswer('Reasoning... \\boxed{3x^2}')).toBe('3x^2');
    expect(extractModelAnswer('So \\boxed{42}.')).toBe('42');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prompt-format.test.ts`
Expected: FAIL — prompts still contain `The answer is <number>` and not `\boxed`.

- [ ] **Step 3: Replace the trailer in all prompts**

In `benchmark/providers/prompts.ts`, the following 2-line block appears 9 times (identical), inside template literals:
```
At the very end, state your final answer in this exact format:
The answer is <number>
```
Replace ALL 9 occurrences with (note the **double backslashes** — required inside template literals so the runtime string contains literal `\boxed`/`\frac`/`\text`):
```
At the very end, put your final answer in a LaTeX box: \\boxed{...}
Use the exact mathematical form, e.g. \\boxed{3x^2}, \\boxed{\\frac{1}{2}}, \\boxed{42}, \\boxed{x=-2 \\text{ or } x=2}.
```
Do this with a single replace-all edit on the exact 2-line block. After editing, `grep -c 'The answer is <number>' benchmark/providers/prompts.ts` must be `0`, and `grep -c '\\\\boxed' benchmark/providers/prompts.ts` must be `9`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/prompt-format.test.ts`
Expected: PASS. (If a prompt string shows a backspace artifact instead of `\boxed`, you used single backslash — fix to `\\boxed`.)

- [ ] **Step 5: Commit**

```bash
git add benchmark/providers/prompts.ts test/prompt-format.test.ts
git commit -m "feat(benchmark): mandate \\boxed{} final-answer format in prompts"
```

---

## Task 5: full verification

**Files:** none

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: all pass (new tests + no regressions).

- [ ] **Step 2: Typecheck + lint**

Run: `npx tsc --noEmit` (clean) and `npm run lint` (0 warnings/errors in `src/`; benchmark/test are typecheck-covered).

- [ ] **Step 3: Sanity-check the rendered prompt (no backspace artifact)**

Run:
```bash
npx tsx -e "import('./benchmark/providers/prompts.js').then(m => console.log(JSON.stringify(m.TOOL_SYSTEM_PROMPT.slice(-180))))"
```
Expected: the tail shows literal `\boxed{...}` (a backslash then `boxed`), NOT a control character. Confirms the escaping is correct.

- [ ] **Step 4: Commit any incidental fixes** (skip if none).

---

## Self-Review notes (incorporated)

- **Spec coverage:** raw-response storage → Task 1 (field+populate) + Task 2/3 (regrade re-extract payoff); boxed prompt → Task 4; no extractor heuristics (only the regression guard) → Task 4; backward-compat regrade → Task 2 fallback. All spec sections mapped.
- **Escaping:** Task 4 explicitly requires `\\boxed` in the template-literal source (the prompts are backtick strings; `\b` is backspace). Step 3's grep checks and Step-3 sanity check in Task 5 guard against the single-backslash mistake.
- **Helper isolation:** `answerToGrade` lives in `regrade-extract.ts`, not `regrade.ts`, because regrade.ts runs `main()` on import.
- **No src/ change:** benchmark-only; the MCP tools and grader-v2 core are untouched (symbolic equivalence already shipped).
- **Type consistency:** `response?: string` used identically in ProblemDetail (Task 1) and regrade's Detail (Task 3); `answerToGrade(cond)` signature matches both call sites.
