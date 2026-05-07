# Phase 1 — Results

**Date:** 2026-05-07
**Branch:** phase-1-output-hygiene
**Status:** NOT YET RUN — A/B benchmark requires a long-lived shell session

## Why no numbers yet

A live GSM8K-quick A/B run requires ~75–90 minutes of continuous LLM API
calls (100 problems × 2 conditions × ~30–45 s/problem). The first attempt
on this branch terminated at problem 12/100 when the parent shell closed.
Re-running inside the agent harness has the same risk. The user should
run the experiment from a real terminal session and update this document
with the resulting numbers.

## How to run this experiment

When credentials are available, from a long-lived terminal:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition A (control): grader-v2 only — Phase 0 baseline
npm run gsm8k:quick:zai -- --features=v2

# Condition B (experimental): grader-v2 + output-v2 — Phase 1 hypothesis
npm run gsm8k:quick:zai -- --features=v2,output-v2

# Find the two newest *-details.jsonl files in results/, then:
npm run analyze -- results/<A-details.jsonl>
npm run analyze -- results/<B-details.jsonl>
```

Then update the result tables below.

## Hypothesis

Condition B should reduce OUTPUT_PARSE_ERROR regressions (where the tool
produced the correct symbolic answer but the model extracted only the
leading scalar — e.g. `3` instead of `3*x^2`). The mechanism:
trailing `\boxed{...}` line is a well-trained LLM repetition pattern;
the answer parser then captures the symbolic form via its existing
`\boxed{}` extraction.

GSM8K is the cheapest dataset to validate this on. CAS calculus
subdomain (where the effect should be largest, since Phase 0 measured
0% there) requires either CAS-quick or full MATH suite to produce
meaningful sample sizes.

## Result tables (when run)

### GSM8K results

| Condition | N | Baseline | +MCP | Δ |
|---|---|---|---|---|
| A: v2 grader only | 100 | TBD | TBD | TBD |
| B: v2 + output-v2 | 100 | TBD | TBD | TBD |

### OUTPUT_PARSE_ERROR delta

| Condition | OUTPUT_PARSE_ERROR | Total regressions |
|---|---|---|
| A: v2 grader only | TBD | TBD |
| B: v2 + output-v2 | TBD | TBD |
| Δ | TBD | TBD |

### Phase 1 success-metric check

| Target | Result | Status |
|---|---|---|
| OUTPUT_PARSE_ERROR ≤ 1 (per 100 GSM8K under condition B) | TBD | TBD |
| GSM8K tool-augmented improves vs A | TBD | TBD |
| MATH L4 ≥ 65% (separate run, full MATH dataset) | not yet measured | — |
| MATH L5 ≥ 56% | not yet measured | — |
| CAS calculus subdomain ≥ 40% | not yet measured | — |

## Files shipped in Phase 1

All gated behind `AXIOM_OUTPUT_V2=1` (set by `--features=output-v2`); v1
default behavior unchanged.

- `src/server/tools/response-formatter-v2.ts` — v2 envelope formatter (JSON + `\boxed{}` trailer)
- `src/server/tools/confidence.ts` — confidence inference for tool results
- `src/server/tools/verify/fix-attempt.ts` — deterministic `fix_attempt` builder for verify
- `src/server/tools/response-formatter.ts` — env-gated v2 routing shim
- `src/server/tools/compute/index.ts` — wired (with try/finally env-var suppression around dispatch)
- `src/server/tools/verify/index.ts` — wired with structured `fix_attempt` + `steps` + `explanation` fields
- `src/server/tools/plot/index.ts` — boxed annotation under v2
- `benchmark/index.ts` — `--features=output-v2` ablation flag
- `test/golden/output.golden.test.ts` — output corpus integration tests (4 cases)
- `test/golden/fixtures.ts` — `OutputCase` interface + 4 `OUTPUT_CASES`

## Test coverage

- 320 unit tests passing
- Output golden corpus: 4/4 passing under integration config (real Giac)
- Type check + lint: clean

## Known limitations (carried into Phase 2)

- Compute env-var suppression around `dispatch()` is not concurrency-safe.
  Acceptable for sequential benchmark use; revisit when adding HTTP transport.
- The `fix_attempt` builder only handles `identity` and `solution` claim
  types; other claim shapes (e.g. inequality verification) return
  `undefined` and the model must improvise.
