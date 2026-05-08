# Phase 4 — Results

**Date:** 2026-05-08
**Branch:** phase-4-olympiad-prompt (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness):

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (Apr 2026 baseline reproduced; no olympiad prompt)
npm run olympiad:quick:zai -- --features=v2

# Condition 2 — Phase 4 olympiad prompt enabled
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt

# Condition 3 — olympiad prompt + voting (variance-stable measurement)
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt,self-consistency

# Analyze each
for f in results/2026-05-08-*-olympiad-quick-details.jsonl; do
  npm run analyze -- "$f"
done
```

## Result tables (fill in after running)

### Per-condition Omni-MATH ≥7 (50 problems)

| Condition | N | Baseline | +MCP | Δ | "No tool call" rate | Avg tool calls/problem |
|---|---|---|---|---|---|---|
| 1: v2 (control) | 50 | TBD | TBD | TBD | TBD | TBD |
| 2: v2 + olympiad-prompt | 50 | TBD | TBD | TBD | TBD | TBD |
| 3: v2 + olympiad-prompt + voting | 50 | TBD | TBD | TBD | TBD | TBD |

### Engagement metrics

| Metric | Apr 2026 | Phase 4 (cond 2) | Status |
|---|---|---|---|
| "No tool call" rate | 82% (41/50) | TBD | TBD (target ≤40%) |
| Avg tool calls per problem | 1.26 | TBD | TBD (target ≥3) |
| Pseudocode rejection count | unmeasured | TBD | TBD |

### Phase 4 success-metric check

| Target | Result | Status |
|---|---|---|
| Omni-MATH +MCP ≥6% (3 problems) | TBD | TBD (PASS / MARGINAL / FAIL) |
| "No tool call" rate ≤40% | TBD | TBD |
| Avg tool calls ≥3 | TBD | TBD |
| Token cost ≤4× MATH L4 per problem | TBD | TBD |

## Findings

[After running, fill in:]

- Did the prompt drive engagement (no-tool-call rate down)?
- Did engagement translate to correctness, or did the model engage but still fail?
- Which Omni problem types responded best (parametric, find-all, prove-existence)?
- Any new failure modes introduced (e.g., model wrote pseudocode despite the DO NOT instruction)?
- Voting impact on Omni: did the variance-stable measurement (cond 3) reveal a clearer signal than cond 2 alone?

## Files shipped in Phase 4

- `benchmark/providers/prompts.ts` — added `TOOL_PROMPT_OLYMPIAD` constant (~60 lines)
- `benchmark/providers/types.ts` — `runWithTools` gains optional `systemPrompt`
- `benchmark/providers/openai-compat.ts` — parametric `systemPrompt` (defaults to keyword dispatcher)
- `benchmark/providers/anthropic.ts` — same parametric change
- `benchmark/runners/tool-augmented.ts` — forwards optional `systemPrompt`
- `benchmark/runners/self-consistency.ts` — `voteToolAugmented` forwards `systemPrompt`
- `benchmark/index.ts` — per-problem dispatch picks `TOOL_PROMPT_OLYMPIAD` when flag is set + Omni dataset
- `test/olympiad-prompt.test.ts` — 4 routing-logic unit tests

Test coverage: +4 unit tests (368 → 372). Zero regressions in pre-Phase-4 tests when flag is off.

## Phase 5+ inputs

[Findings to feed forward:]

- If engagement fix worked but accuracy stayed low → reasoning is the next bottleneck. Phase 4.5 priorities: per-step verify forcing, problem-decomposition prompts, or domain-specific scaffolds.
- If engagement AND accuracy both lifted → prompt engineering is the lever. Phase 4.5: subdomain prompts (algebra vs combinatorics vs number theory), more pattern examples, larger small-cases set.
- Per-problem failure breakdown reveals which Omni subdomains are most/least responsive to scaffolding.
- Token cost ratio: if it stays ≤4× MATH L4, the approach is Pareto-acceptable; if it exceeds, Phase 4.5 needs cost optimization (shorter prompt, conditional sections).
- If Phase 4 result is FAIL (0% lift) → prompt-only insufficient; future work must consider Lean/Coq integration, retrieval-augmented examples, or olympiad-trained model variants.
