# Benchmark Grader Robustness — Design

**Date:** 2026-06-09
**Branch:** `grader-robustness` (isolated worktree, based on `main`)
**Status:** DESIGN — approved, pending implementation plan

## Background

The GLM-5.1 failure triage (`2026-06-09-glm5.1-failure-triage-results.md`) found
that **~14 of 19 CAS-quick "failures" are measurement artifacts, not tool
failures**: the tool computed the right answer (often `Verified: TRUE`) but the
benchmark grader failed to extract or match the model's verbose answer. The two
dominant gaps:

1. **Symbolic equivalence is OFF in the production grading path.** `grader-v2`
   already implements sound symbolic equivalence (`gradeV2Async`, via a Giac
   `simplify((p)-(g))==0` check), and `regrade.ts` uses it offline — but the live
   `grade()` shim (`benchmark/graders/grader.ts`, called only at
   `benchmark/index.ts:179,231`) is synchronous and passes no `giacEval`, so
   equivalent forms like `\frac{1}{1+x^2}` vs `1/(x^2+1)` never match.
2. **Answer extraction loses/garbles answers.** `extractModelAnswer` does not
   handle inline-math delimiters `\(...\)` / `\[...\]` (triage idx 5 extracted the
   broken `\(\frac{1}{1+x^2}\`), and truncates a bare multi-value answer like
   `3,1` to a single token `3` (triage idx 41, eigenvalues).

## Goal

Reduce grader **false-negatives** (true-correct answers scored wrong) **without
introducing false-positives** (wrong answers scored right), so measured accuracy
reflects the tool's real, often Giac-verified correctness.

**Guardrail (binding):** every change is precision-preserving. Symbolic
equivalence is sound (Giac must prove equality; timeout/error → no match).
Extraction changes only strip delimiters or preserve more of the answer — they
cannot turn a wrong answer into a right one. A dedicated no-false-positive test
set guards this.

**Non-goals:** abs/constant-of-integration equivalence (`ln|x|` vs `ln x`,
`+C`) — not symbolically equal, so sound grading correctly leaves them as
failures; loose heuristic matching of any kind; changing the MCP tools or
re-running the LLM benchmark.

## Architecture

### 1. Wire symbolic equivalence into the production grade path

- Convert `grade()` in `benchmark/graders/grader.ts` to **async**. It obtains a
  `giacEval` from `getDefaultGiacBridge()` (memoized singleton — the WASM engine
  initializes once and is reused across the per-problem loop) and calls
  `gradeV2Async(predicted, ground, { giacEval })` instead of the sync `gradeV2`.
  The dual-attempt logic (extracted answer + raw response) is preserved, now
  awaiting the async grader.
- `benchmark/index.ts:179,231` change `grade(...)` → `await grade(...)`. The
  runner loop is already async, so this is a local change.
- `gradeNumeric` stays synchronous (GSM8K numeric path needs no symbolic stage).
- **Soundness:** `gradeV2Async`'s symbolic stage skips scalar/set/interval kinds
  (numbers/sets are already handled by exact/numeric/set stages), runs
  `simplify((p)-(g))` and matches only on a `0` result, and returns the prior
  (non-match) result on any Giac timeout or error. It cannot produce a false
  positive.

### 2. Harden answer extraction (`benchmark/graders/answer-parser.ts`)

- **Inline-math delimiters:** treat `\(...\)` and `\[...\]` as answer containers
  (alongside the existing `\boxed{}`), and strip stray `\(`, `\)`, `\[`, `\]`
  in `cleanExtracted`. Fixes the idx-5 class where the extracted string carried
  delimiters and was truncated.
- **Multi-value answers:** when the answer region is a bare, top-level
  comma-separated list of values (e.g. `3,1`), preserve it whole rather than
  collapsing to the last/first number. Guard: only treat it as a value-list when
  the members are number/expression-like, to avoid swallowing prose.
  - **Note (matching is conditional):** preserving the list is strictly better
    than the old single-token collapse. The order-insensitive *match* of a bare
    comma-list against the ground truth runs via grader-v2's `bareCommaList`
    stage, which is **gated behind `AXIOM_GRADER_V3=1`** (i.e. the
    `--features=grader-v3` benchmark recipe). Without that flag the preserved
    list does not auto-match a reordered ground truth. This is intentional:
    making bare-comma-list order-insensitive matching unconditional risks
    false-positives on ordered/sequence answers, which the binding guardrail
    forbids. So a benchmark that wants this recovery must enable grader-v3.

### 3. Method enum

`grade()` maps `gradeV2Async`'s `symbolic-equivalence` method into the existing
`GradeResult.method` enum (`'symbolic'`), so report/JSONL consumers are
unchanged.

## Data flow (idx-5 example, after fix)

`grade(rawResponse, "1/(x^2+1)")` → `extractModelAnswer` strips `\(...\)` →
`\frac{1}{1+x^2}` → `gradeV2Async`: exact/normalized/numeric/set/interval all
miss → symbolic stage `simplify((1/(1+x^2)) - (1/(x^2+1)))` → `0` → **match**
(`method: 'symbolic'`). Previously: no symbolic stage → no-match.

## Error handling

- Bridge initialization failure (WASM unavailable): `getDefaultGiacBridge`/`giacEval`
  returns `null` on error, so `gradeV2Async` degrades to the sync result — grading
  still works, just without the symbolic stage. No crash, no false positive.
- Extraction changes are pure string ops; malformed input falls through to the
  existing fallback chain unchanged.

## Testing strategy (TDD — failing test first)

- **Recovered cases (should now grade correct):**
  - `gradeV2Async('1/(1+x^2)', '1/(x^2+1)', {giacEval})` → match (`symbolic`).
  - extraction: `\(\frac{1}{1+x^2}\)` → clean `\frac{1}{1+x^2}` (or `1/(1+x^2)`).
  - extraction + grade: a `3,1` multi-value answer matches GT `1,3`.
- **Guardrail — must STAY wrong (no false positives):**
  - `gradeV2Async('x^2', 'x^3', {giacEval})` → no match.
  - `gradeV2Async('1/(1+x^2)', '2/(1+x^2)', {giacEval})` → no match.
  - `ln(abs(x))` vs `ln(x)` → no match (correctly — not symbolically equal).
- **Async grade() integration:** `await grade(...)` returns the symbolic match
  for an equivalent-form response; uses a fake `giacEval` in unit tests and the
  real bridge in an integration test.
- **Golden suite:** existing `test/golden/grader.golden.test.ts` (already uses
  `gradeV2Async`) must stay green; add the recovered + guardrail cases to fixtures.
- **regrade measurement (no LLM):** run `tsx benchmark/regrade.ts <cas-quick
  details.jsonl>` and record how many failures flip to correct on the stored
  extracted answers (the symbolic-equivalence lift). Extraction lift is covered by
  the unit tests above (the stored traces hold post-old-extraction answers).

## Affected files

| File | Change |
|---|---|
| `benchmark/graders/grader.ts` | `grade()` → async; obtain memoized `giacEval` from default bridge; call `gradeV2Async`; map `symbolic-equivalence` → `'symbolic'` |
| `benchmark/index.ts` | `await grade(...)` at the two call sites |
| `benchmark/graders/answer-parser.ts` | inline-math delimiter handling + multi-value preservation |
| `test/golden/fixtures.ts` (+ golden test) | recovered + guardrail cases |
| new unit test(s) | extraction + async-grade behavior |
| (measurement only) `benchmark/regrade.ts` | run as-is to quantify the delta |

## Out of scope

- abs / constant-of-integration equivalence (not sound to auto-match).
- Re-running the LLM benchmark (a separate, optional targeted run).
- Any MCP tool / production `src/` change — this is benchmark-grader only.
