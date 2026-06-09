# Post-Tier Targeted Re-run — Protocol

**Date:** 2026-06-09
**Type:** measurement (live benchmark run — requires `ZAI_API_KEY` + API budget)

## Goal

Measure the **combined real impact** of the shipped work — Tier 1 (output
hygiene), Tier 2 (self-verification), Tier 3 (input normalization), and the
benchmark grader robustness (sound symbolic equivalence + extraction hardening) —
on the headroom datasets, with the now-honest grader. This tests the triage's
prediction that the tool's true CAS accuracy is well above the previously-measured
~70% (most "failures" were grader artifacts).

This is the one step that needs a fresh LLM run: the existing traces store only
post-extraction answers, so offline regrade cannot exercise the new
`grade()`/extraction path.

## Scope

| Dataset | Quick size | Why |
|---|---|---|
| CAS-quick (`--cas`) | 60 | the triage's prime target; where Tier 1/2/3 + grader fixes concentrate |
| MATH L4 (`--math-l4`) | 50 | headroom band, more "capable-but-erring" signal |
| MATH L5 (`--math-l5`) | 50 | hardest non-olympiad band |

Total ≈ 160 problems × (baseline + tool-augmented). Skip GSM8K (98% ceiling) and
olympiad (triage: incapable). Provider: **z.ai / glm-5.1** (same as the triage
baseline, for apples-to-apples comparison).

## Features

`--features=grader-v3`. Rationale:
- Tier 1/2/3 (output hygiene, self-verification, input normalization) are **default
  on** — no flag needed.
- Symbolic equivalence + extraction hardening are now **default** in `grade()` —
  no flag needed.
- `grader-v3` additionally enables the `bareCommaList` stage, so the multi-value
  extraction fix (e.g. eigenvalues `3,1`) actually **matches** a reordered ground
  truth. Without it the preserved list does not auto-match (see the grader
  robustness spec — kept gated to avoid false-positives on ordered answers).

Optional: add `output-hygiene` (`--features=grader-v3,output-hygiene`) to also
enable the marginal Unicode/silent-failure output pass — but for a clean read of
the grading + tier impact, `grader-v3` alone is the focused choice.

## What it produces

The harness runs baseline (no MCP) vs tool-augmented per problem and writes, under
`benchmark/results/`:
- `<ts>-zai-...-details.jsonl` — per-problem traces (now graded by the new path)
- `<ts>-zai-...-.md` / `.json` — aggregate baseline-vs-tool accuracy

## How to read the result

- Compare **tool-augmented accuracy** against the May-2026 baseline (CAS ~70%,
  MATH L4 ~50-65%, L5 ~38-52%). A meaningful CAS lift confirms the triage thesis
  (grader was under-counting verified-correct answers).
- Inspect the new `details.jsonl` for any **regression** (a previously-correct
  problem now wrong) — the guardrail says there should be none from grading
  (symbolic equiv is sound); a drop would point to a tier-side regression to
  investigate.

## Command

See `2026-06-09-post-tier-rerun-protocol` command block below (also in the chat
hand-off). Requires `ZAI_API_KEY` exported.

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
# ZAI_API_KEY must be set in the environment
npx tsx index.ts --cas --math-l4 --math-l5 --quick --zai --features=grader-v3
```

Run datasets separately if you prefer shorter runs:
```bash
npx tsx index.ts --cas --quick --zai --features=grader-v3
npx tsx index.ts --math-l4 --quick --zai --features=grader-v3
npx tsx index.ts --math-l5 --quick --zai --features=grader-v3
```
