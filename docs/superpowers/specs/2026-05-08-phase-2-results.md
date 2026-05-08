# Phase 2 — Results

**Date:** 2026-05-08
**Branch:** phase-2-output-hygiene (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness — Phase 1 lesson):

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (Phase 0 baseline)
npm run cas:quick:zai -- --features=v2

# Condition 2 — tokens-8k only
npm run cas:quick:zai -- --features=v2,tokens-8k

# Condition 3 — output-hygiene only
npm run cas:quick:zai -- --features=v2,output-hygiene

# Condition 4 — grader-v3 only
npm run cas:quick:zai -- --features=v2,grader-v3

# Condition 5 — combined (Phase 2 goal)
npm run cas:quick:zai -- --features=v2,tokens-8k,output-hygiene,grader-v3

# Analyze each
for f in results/2026-05-08-*-cas-quick-details.jsonl; do
  npm run analyze -- "$f"
done
```

## Result tables (fill in after running)

### Per-condition CAS-quick

| Condition | N | Baseline | +MCP | Δ | Regressions | Improvements |
|---|---|---|---|---|---|---|
| 1: v2 (control) | 60 | TBD | TBD | TBD | TBD | TBD |
| 2: +tokens-8k | 60 | TBD | TBD | TBD | TBD | TBD |
| 3: +output-hygiene | 60 | TBD | TBD | TBD | TBD | TBD |
| 4: +grader-v3 | 60 | TBD | TBD | TBD | TBD | TBD |
| 5: combined | 60 | TBD | TBD | TBD | TBD | TBD |

### Per-flag delta (vs control)

| Flag | Δ-correct (live) | Hypothesis | Status |
|---|---|---|---|
| tokens-8k | TBD | +3 to +6 | TBD (PASS/FAIL) |
| output-hygiene | TBD | +2 to +4 | TBD |
| grader-v3 | TBD | +2 to +3 | TBD |
| combined | TBD | +6 to +13 | TBD |

### Regression diagnosis breakdown

| Condition | extraction_mismatch | wrong_tool_result | empty_result | other |
|---|---|---|---|---|
| 1: v2 | TBD | TBD | TBD | TBD |
| 5: combined | TBD | TBD | TBD | TBD |

## Findings

[After running, fill in:]
- Which flags delivered measurable lift?
- Did any flag REGRESS the metric (Phase 1 lesson)? If so, decision: keep flag in code (off by default) and document failure mode.
- What new failure modes appeared in the combined run that weren't in any single-flag run? (Interaction effects.)

## Phase 2 success-metric check

| Target | Result | Status |
|---|---|---|
| CAS-quick combined ≥ 78% | TBD | TBD |
| Combined regression count ≤ 2 | TBD | TBD |
| Token-per-correct ≤ 1.5× control | TBD | TBD |

## Files shipped in Phase 2

- `src/server/tools/unicode-normalize.ts` — shared Unicode→ASCII helper (also fixes pre-existing √ gap)
- `src/server/tools/compute/silent-failure.ts` — pure failure-detection helper
- `src/server/tools/compute/simplify-trigger.ts` — pure trigger heuristic
- `src/server/tools/compute/hygiene.ts` — applyHygiene orchestrator (Unicode + warn + simplify)
- `benchmark/graders/extract-rhs.ts` — equation-form RHS extractor
- `benchmark/graders/bare-list.ts` — bare comma-separated list parser
- `benchmark/config.ts` — `tokens-8k` flag
- `benchmark/index.ts` — env-var mappings for output-hygiene + grader-v3
- `src/server/tools/compute/index.ts` — wired (env-gated)
- `benchmark/graders/grader-v2.ts` — wired (env-gated v3 stages); minor stripRedundantParens extension for (x^3) → x^3
- `benchmark/graders/normalizer.ts` — uses shared unicode-normalize

## Phase 3 inputs

[Findings to feed Phase 3 (self-consistency / N-sample voting):]
- TBD: how many regressions remain after combined Phase 2?
- TBD: do any specific failure modes look like they'd benefit from majority-vote across multiple model samples?
