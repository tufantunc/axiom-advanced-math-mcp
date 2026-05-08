# Phase 3 — Results

**Date:** 2026-05-08
**Branch:** phase-3-self-consistency (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness):

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (current best, no voting)
npm run cas:quick:zai -- --features=v2

# Condition 2 — Phase 3 voting on top of v2
npm run cas:quick:zai -- --features=v2,self-consistency

# Optional: voting + Phase 2 stack (largest deltas may live here)
npm run cas:quick:zai -- --features=v2,output-hygiene,grader-v3,self-consistency

# Repeatability check — run condition 2 a SECOND time
npm run cas:quick:zai -- --features=v2,self-consistency

# Analyze each
for f in results/2026-05-08-*-cas-quick-details.jsonl; do
  npm run analyze -- "$f"
done
```

## Result tables (fill in after running)

### Per-condition CAS-quick

| Condition | N | Baseline | +MCP | Δ | Avg agreement (tool-aug) |
|---|---|---|---|---|---|
| 1: v2 (control) | 60 | TBD | TBD | TBD | n/a |
| 2: v2 + self-consistency | 60 | TBD | TBD | TBD | TBD |
| 3: v2 + Phase 2 + self-consistency | 60 | TBD | TBD | TBD | TBD |
| 4: condition 2 again (repeatability) | 60 | TBD | TBD | TBD | TBD |

### Variance reduction check

| Pair | Phase 2 swing | Phase 3 swing | Status |
|---|---|---|---|
| Two consecutive runs of identical condition | ±8pp on Phase 2 baseline | TBD (target ≤±2pp on conditions 2+4) | TBD |

### Phase 3 success-metric check

| Target | Result | Status |
|---|---|---|
| CAS-quick condition 2 ≥ 76% | TBD | TBD (PASS/FAIL) |
| Two-run baseline swing ≤ ±2pp | TBD | TBD |
| Average voting agreement ≥ 0.6 | TBD | TBD |

## Findings

[After running, fill in:]

- Did self-consistency lift CAS-quick measurably?
- What is the average agreement, and does it correlate with correctness?
- Did Phase 2 flags (output-hygiene, grader-v3) show clearer signal under voting (i.e., now that variance is reduced)?
- Token-cost ratio actually observed (target ≤ 3.5x).

## Files shipped in Phase 3

- `benchmark/runners/self-consistency.ts` — voteBaseline / voteToolAugmented + majorityVote (with first-occurrence tie-break, plurality vote)
- `benchmark/providers/types.ts` — LLMProvider gains optional temperature
- `benchmark/providers/openai-compat.ts` — parametric temperature (defaults to 0)
- `benchmark/providers/anthropic.ts` — parametric temperature
- `benchmark/runners/baseline.ts` — forwards optional temperature
- `benchmark/runners/tool-augmented.ts` — forwards optional temperature
- `benchmark/config.ts` — selfConsistency config field + AXIOM_SC_N / AXIOM_SC_TEMP env overrides
- `benchmark/index.ts` — per-problem dispatch swaps to voting wrappers under flag
- `benchmark/problem-detail.ts` — SelfConsistencyData JSONL field (optional)
- `benchmark/report/generator.ts` — Self-Consistency aggregate section in run report

Test coverage: +13 unit tests (355 → 368). Zero regressions in pre-Phase-3 tests when flag is off.

## Phase 4+ inputs

[Findings to feed Phase 4 (olympiad wrapper):]

- Does voting help any Omni-MATH ≥7 problems, or are they uniformly 0%? (If still 0%, Phase 4 must do something fundamentally different — voting can't rescue problems where every sample is wrong in the same way.)
- Per-problem agreement vs correctness curves: which failure modes show "high agreement, wrong answer"? Those are coherent-but-confused problems where voting helps least.
- Token-per-correct ratio under self-consistency: if it's near 3x, voting is purely averaging cost; if it's >3x there's interaction overhead worth investigating.
