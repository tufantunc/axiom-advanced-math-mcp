# Measurement Quality — Boxed Prompt + Raw-Response Storage

**Date:** 2026-06-09
**Branch:** `measurement-quality` (isolated worktree, based on `main`)
**Status:** DESIGN — approved, pending implementation plan
**Scope:** benchmark harness only (no `src/` production code, no MCP tool change)

## Background

The post-tier re-run revealed that the dominant remaining bottleneck on CAS is
**answer extraction**, not symbolic-equivalence matching: the tool computes the
right answer (often `Verified: TRUE`) but the model's prose final answer is
mangled by the extractor (`3*x^2` → `3`/`3x`, `x^2` → `x`).

Two grounded root findings:

1. **The benchmark prompt mandates a prose, number-shaped format.** Every prompt
   in `benchmark/providers/prompts.ts` ends with: *"At the very end, state your
   final answer in this exact format: The answer is <number>"*. For symbolic CAS
   answers this is actively harmful — `<number>` is wrong, and prose
   ("The answer is 3x^2") drives the extractor's last-number/answer-is logic to
   grab a single digit. The fix is to mandate `\boxed{...}` (the MATH-benchmark
   convention), which the extractor's Tier-1 boxed fail-safe already extracts
   cleanly for symbolic and numeric answers alike.

2. **Raw model responses are never stored.** `benchmark/index.ts` has the raw
   text (`br.text` / `tr.text`, passed to `grade()`), but the `ProblemDetail`
   trace only records the post-extraction `extractedAnswer`. This is why offline
   `regrade.ts` cannot exercise extraction changes — there is nothing to
   re-extract from. Storing the raw response removes that blind spot.

## Goal

Make benchmark measurement reflect the tool's real correctness by (1) having the
model emit a cleanly-extractable `\boxed{}` final answer, and (2) storing the raw
response so extraction/grading changes are diagnosable and offline-regradable.

**Guardrail:** harness-only; the prompt change applies equally to baseline and
tool-augmented conditions (fair); no MCP tool / `src/` change; no risky extractor
heuristics (the boxed prompt + existing boxed fail-safe do the work).

**Non-goals:** prose-symbolic extractor strengthening (deferred — only revisit if
boxed-prompt leaves residual misses); re-running the LLM benchmark (separate
step); MATH L4/L5 loading (already fixed on main).

## Architecture

### Component 1 (implement first): raw-response storage

- **`benchmark/problem-detail.ts`** — add optional `response?: string` to the
  `baseline` and `toolAugmented` shapes of `ProblemDetail`.
- **`benchmark/index.ts`** — when building `detail`, set
  `baseline.response = br?.text` and `toolAugmented.response = tr?.text` (guard
  for the no-result/error case so it stays `undefined`).
- **`benchmark/regrade.ts`** — when a record has a `response`, **re-extract** with
  `extractModelAnswer(response)` and grade that; otherwise fall back to the stored
  `extractedAnswer` (backward compatible with old traces). This makes the stored
  response immediately useful: extraction + grading changes become measurable
  offline. Add `response?: string` to regrade's local `Detail` interface.

This component lands first so that the very next benchmark run (and any later
regrade) captures raw responses.

### Component 2: boxed final-answer prompt

- **`benchmark/providers/prompts.ts`** — replace the trailing format instruction
  in every prompt (the baseline/non-tool prompt(s) and all tool-category prompts:
  cas, algebra, counting, calculus, number_theory, geometry, probability) from:

  > At the very end, state your final answer in this exact format:
  > The answer is <number>

  to:

  > At the very end, put your final answer in a LaTeX box: \boxed{...}
  > Use the exact mathematical form, e.g. \boxed{3x^2}, \boxed{\frac{1}{2}},
  > \boxed{42}, \boxed{x=-2 \text{ or } x=2}.

  (Single shared trailer string if the prompts already share one; otherwise edit
  each occurrence consistently.)

- **Extraction:** unchanged. `extractModelAnswer`'s boxed fail-safe (prefers the
  last fully-balanced `\boxed{}`) already handles symbolic and numeric boxed
  answers; grader-v2 (with the now-default symbolic equivalence) matches
  equivalent forms.

## Data flow (after both components)

`grade(rawResponse, GT)` → model wrote `... \boxed{3x^2}` → `extractModelAnswer`
→ `3x^2` → grader-v2 symbolic stage vs `3*x^2` → match. The raw `... \boxed{3x^2}`
is also stored in `toolAugmented.response`, so `regrade.ts` can re-extract and
re-grade it offline if the extractor/grader changes again.

## Error handling

- `response` is optional everywhere; `analyze.ts` and any other reader are
  unaffected (additive field).
- `regrade.ts` re-extraction is gated on `response` presence — old traces without
  it behave exactly as today.
- A run where a condition errored (`br`/`tr` undefined) stores `response:
  undefined`, not a crash.

## Testing strategy (TDD — failing test first)

- **regrade re-extraction (unit):** a `Detail` with
  `response: 'work... \\boxed{3x^2}'` and a stale `extractedAnswer: '3'` →
  regrade's grading path uses the re-extracted `3x^2` (matches GT `3*x^2`); a
  `Detail` with no `response` → uses the stored `extractedAnswer` (old behavior).
  (Extract the re-extract decision into a small pure helper so it is unit-testable
  without running the full regrade I/O.)
- **prompt content (unit):** every exported prompt string contains `\boxed`; none
  still contains `The answer is <number>`.
- **extraction regression (unit):** `extractModelAnswer('... \\boxed{3x^2}')` →
  `3x^2`; `extractModelAnswer('... \\boxed{42}')` → `42` (guards that boxed
  extraction still works for the new prompt's outputs).
- **`ProblemDetail` shape (typecheck):** `response?: string` present on both
  conditions; `npm test` + `npx tsc --noEmit` green.

## Affected files

| File | Change |
|---|---|
| `benchmark/problem-detail.ts` | add `response?: string` to baseline + toolAugmented |
| `benchmark/index.ts` | populate `response` from `br.text` / `tr.text` |
| `benchmark/regrade.ts` | re-extract from `response` when present (+ local type) |
| `benchmark/providers/prompts.ts` | `\boxed{}` final-answer format in all prompts |
| tests | regrade re-extract, prompt content, extraction regression |

## Validation

The real impact is measured on the **next benchmark run** (now diagnosable: raw
responses stored, boxed answers cleanly extracted). The unit tests prove the
mechanism; a fresh `--cas --math-l4 --math-l5 --quick --zai --features=grader-v3`
run quantifies the lift and lets us regrade/inspect per-problem.
