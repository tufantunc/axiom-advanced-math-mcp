# Phase 2 — Results

**Date:** 2026-05-08
**Branch:** main (post-merge)
**Status:** COMPLETE — partial success. Phase 2 headline target (CAS combined ≥78%) NOT met. Two of three flags marginal positives, one is a clear regression.

## TL;DR

| Flag | Effect (vs control) | Decision |
|---|---|---|
| `output-hygiene` | +1 problem (within noise) | Keep, off by default |
| `grader-v3` | +1 problem (within noise) | Keep, off by default |
| `tokens-8k` | **−4 problems** (real regression) | Keep flag in code, **DO NOT use** in production runs |
| Combined | −3 problems | Combined run dragged down by tokens-8k |

Phase 2 generated useful infrastructure (golden corpus expanded, shared unicode-normalize, regression-classification CLI), but the headline accuracy target was missed. Per-condition variance on 60 problems is too high (baseline swings ±5pp per run) to confidently attribute small effects. **Phase 3 (self-consistency / N-sample voting) is the right next move** — voting across multiple samples reduces variance and matches a documented +5–15pp lift in literature.

## Live ablation runs

5 conditions × 60 CAS problems × glm-5.1 via z.ai. All runs completed 2026-05-08.

### Per-condition CAS-quick

| Condition | N | Baseline | +MCP | Δ vs baseline | Regressions | Improvements |
|---|---|---|---|---|---|---|
| 1: v2 (control) | 60 | 33/60 (55.0%) | **43/60 (71.7%)** | +10 (+16.7pp) | 5 | 15 |
| 2: +tokens-8k | 60 | 31/60 (51.7%) | 39/60 (65.0%) | +8 (+13.3pp) | 4 | 12 |
| 3: +output-hygiene | 60 | 31/60 (51.7%) | 44/60 (73.3%) | +13 (+21.7pp) | 2 | 15 |
| 4: +grader-v3 | 60 | 35/60 (58.3%) | 44/60 (73.3%) | +9 (+15.0pp) | 6 | 15 |
| 5: combined | 60 | 30/60 (50.0%) | 40/60 (66.7%) | +10 (+16.7pp) | 2 | 12 |

Baselines vary from 50.0% to 58.3% across runs (±8pp swing) — pure model-temperature noise. The right comparison is therefore the **+MCP absolute score across conditions**, not the per-run delta.

### Per-flag delta (vs control's 71.7% +MCP)

| Flag | +MCP score | Δ vs control | Hypothesis | Status |
|---|---|---|---|---|
| `tokens-8k` (alone) | 65.0% | **−6.7pp (−4 problems)** | +3 to +6 | ❌ FAIL — clear regression |
| `output-hygiene` (alone) | 73.3% | +1.6pp (+1 problem) | +2 to +4 | ⚠ within noise |
| `grader-v3` (alone) | 73.3% | +1.6pp (+1 problem) | +2 to +3 | ⚠ within noise |
| Combined (all 3) | 66.7% | −5.0pp (−3 problems) | +6 to +13 | ❌ FAIL — tokens-8k drags |

### Regression diagnosis (from `npm run analyze`)

| Condition | OUTPUT_PARSE_ERROR | EMPTY_TOOL_RESULT | WRONG_ANSWER | Total |
|---|---|---|---|---|
| 1: v2 (control) | 1 | 0 | 4 | 5 |
| 2: +tokens-8k | 0 | 2 | 2 | 4 |
| 3: +output-hygiene | 1 | 1 | 0 | 2 |
| 4: +grader-v3 | 1 | 0 | 5 | 6 |
| 5: combined | 0 | 0 | 2 | 2 |

`output-hygiene` and `combined` produced the lowest regression counts (2 each). The `EMPTY_TOOL_RESULT` showing up under `tokens-8k` suggests the larger budget gives the model room to take longer paths that hit Giac's empty-solve cases (e.g., `desolve` returning `[]`).

## Findings

### Why `tokens-8k` regressed

Inspecting the 4 problems lost when `tokens-8k` was added (#16, #39, #56, #57) reveals a consistent pattern: the larger token budget gives the model **more room to wander**, producing longer reasoning chains that end in worse final answers, not better ones.

| Problem | Control extracted | tokens-8k extracted |
|---|---|---|
| #16 (∫x²eˣ) | `e^x(x^2 - 2x + 2) + C` ✓ | `\(e^x(x^2` ✗ (still truncated) |
| #39 (ODE) | `3*exp(-2*x)` ✓ (5 tool calls) | `y` ✗ (8 tool calls — got confused) |
| #56 (Taylor sin) | `x` ✓* (1 tool call) | `list` ✗ (6 tool calls — gave up, returned subexpression) |
| #57 (Taylor cos) | `1 - \dfrac{x^2}{2} + \dfrac{x^4}{24` ✓ | full equation form, longer, still truncated ✗ |

\* Note: `x` matching `x-x^3/6+x^5/120` under control is a grader artifact — likely the symbolic-equivalence pass made a generous match. Not a robust pass either way.

The hypothesis ("truncation causes ~10/16 both-wrong; bumping max recovers some") is rejected by data: doubling the budget did not eliminate truncation, and meanwhile encouraged the model to take longer, more-error-prone paths. **Same lesson as Phase 1's output-v2: format-engineering interventions interact unpredictably with model behavior.**

### Why `output-hygiene` and `grader-v3` are marginal

Both flags produced +1 problem net vs control. With baseline variance of ±5pp (3 problems), this is **statistically indistinguishable from noise**. The flag-specific gains (e.g., `i,-i ↔ -i,i` matched by grader-v3) are real but get washed out by independent run-to-run model variance.

12/60 problems flipped between conditions — a 20% volatility rate driven by model temperature, not flag effects. Distinguishing 1pp signals from this noise requires either (a) much larger sample sizes, or (b) variance-reducing techniques like self-consistency voting.

### Combined run

Combined `tokens-8k+output-hygiene+grader-v3` scored 66.7% — between tokens-8k-alone (65.0%) and the marginal two (73.3% each). The negative tokens-8k effect dominates the combined result. If we'd run `output-hygiene+grader-v3` (without tokens-8k), we'd likely have seen ~74-75% — still short of the 78% target.

## Phase 2 success-metric check

| Target | Result | Status |
|---|---|---|
| CAS-quick combined ≥ 78% | 66.7% | ❌ FAIL |
| Combined regression count ≤ 2 | 2 | ✅ PASS |
| Token-per-correct ≤ 1.5× control | not separately measured | — |

## Decisions

1. **`tokens-8k`: REJECTED for production use.** Keep the flag in code (it's a 1-line config conditional), but document this failure and do not use in any production / measurement runs. Same treatment as Phase 1's `output-v2` (kept disabled, results doc the source of truth).

   **Update (2026-05-08 cleanup):** The `tokens-8k` flag was physically removed from the codebase in commit `5f5a201`. Passing `--features=tokens-8k` is now a silent no-op.

2. **`output-hygiene`: KEEP, off by default.** Marginal positive. The Unicode `√→sqrt` fix in the shared module is itself a real grader bug fix that landed independently. The simplify-trigger and silent-failure-warning machinery is in place if Phase 3+ needs it.

3. **`grader-v3`: KEEP, off by default.** Marginal positive. Captures the 2 specific golden-corpus regressions (equation-form #56, bare-list #49) plus a few more. Not strong enough to default-on without more evidence.

4. **Default benchmark recipe going forward:** `--features=v2` (Phase 0 grader). Optional add: `output-hygiene,grader-v3` for slight lift. Avoid `tokens-8k`.

## What we learned (for future work)

1. **60-problem benchmark is too small to distinguish 1–2pp signals.** Baseline alone varies ±5pp run to run. Either run on full CAS dataset (240 problems) for tighter intervals, or use voting/consistency techniques.
2. **Format-layer interventions have unpredictable model interactions.** Phase 1's `output-v2` and Phase 2's `tokens-8k` both regressed against intuition. Direct empirical measurement is non-negotiable.
3. **Pure-function helpers ship cleanly.** All 6 Phase 2 helpers landed with TDD discipline, comprehensive unit tests, and zero impact when flags are off. The Phase 0 ablation-discipline pattern continues to be sound.

## Files shipped in Phase 2

- `src/server/tools/unicode-normalize.ts` — shared Unicode→ASCII helper (also fixes pre-existing `√` gap)
- `src/server/tools/compute/silent-failure.ts` — pure failure-detection helper
- `src/server/tools/compute/simplify-trigger.ts` — pure trigger heuristic
- `src/server/tools/compute/hygiene.ts` — `applyHygiene` orchestrator (Unicode + warn + simplify)
- `benchmark/graders/extract-rhs.ts` — equation-form RHS extractor
- `benchmark/graders/bare-list.ts` — bare comma-separated list parser
- `benchmark/config.ts` — `tokens-8k` flag (kept but documented as harmful)
- `benchmark/index.ts` — env-var mappings for `output-hygiene` + `grader-v3`
- `src/server/tools/compute/index.ts` — wired (env-gated)
- `benchmark/graders/grader-v2.ts` — wired (env-gated v3 stages); minor `stripRedundantParens` extension for `(x^3) → x^3`
- `benchmark/graders/normalizer.ts` — uses shared unicode-normalize

Test coverage: +64 unit tests (291 → 355). Zero regressions in pre-Phase-2 tests when flags are off.

## Phase 3 inputs

The data points strongly toward **self-consistency / N-sample voting** as the next intervention:

1. **High per-run variance** (12/60 problems flip across conditions, baseline ±8pp range) means a single sample is unreliable. Majority vote across N=3–5 samples per problem would dramatically stabilize results.
2. **Literature reports** +5–15pp gains from self-consistency on math problems (Wang et al. 2022) — much larger than any Phase 2 effect.
3. **Cost is acceptable** for hard problems: vote on N=5 only when the first attempt fails verification or returns low confidence.
4. **Compute-side hygiene already exists** — Phase 2's `applyHygiene` and `detectFailure` give us the signals to know WHEN to trigger a re-vote.

Open question for Phase 3 brainstorming: should self-consistency be model-side (sample N model trajectories independently) or grader-side (re-grade the same trajectory against multiple parsings)? Probably model-side — the failures we saw are mostly "model wandered into bad subspace", which model-side voting addresses directly.
