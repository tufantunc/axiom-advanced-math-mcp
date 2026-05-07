# Phase 0 — Results

**Date:** 2026-05-07
**Source benchmark:** `benchmark/results/2026-04-08-15-51-27-zai-quick-details.jsonl` (n=360)
**Re-grade method:** offline; v1 grader vs grader-v2 on identical model traces (zero new LLM cost)
**Branch:** phase-0-grader

## Grader-only delta (v1 → v2)

| Dataset | N | v1 base | v2 base | Δb | v1 tool | v2 tool | Δt |
|---|---|---|---|---|---|---|---|
| GSM8K (100) | 100 | 96 | 96 | +0 | 98 | 94 | -4 |
| MATH L3 (50) | 50 | 35 | 34 | -1 | 40 | 39 | -1 |
| MATH L4 (50) | 50 | 25 | 24 | -1 | 31 | 29 | -2 |
| MATH L5 (50) | 50 | 19 | 19 | +0 | 26 | 25 | -1 |
| Omni-MATH ≥7 (50) | 50 | 0 | 0 | +0 | 0 | 0 | +0 |
| CAS (60) | 60 | 17 | 17 | +0 | 16 | 19 | +3 |
| **Total** | **360** | **192** | **190** | **-2** | **211** | **206** | **-5** |

**Key finding:** grader-v2 is net stricter on most datasets (better normalization catches false positives), but recovers 3 CAS tool-augmented items via symbolic/numeric equivalence. The GSM8K drop (-4 tool-aug) comes from tighter set-matching — v1 accepted `list[x>=12]` as correct for `13`, v2 does not.

## Phase 0 success-metric check

| Target | Actual | Status |
|---|---|---|
| CAS overall tool-aug: 26.7% → ≥30% | 26.7% → 31.7% (19/60) | PASS |
| CAS symbolic subdomain (derivatives + integrals + ode): 0% → ≥30% | 0/25 = 0% → 0/25 = 0% | FAIL |
| GRADER_MISMATCH count: ≤ 1 | 0 (from analyze run) | PASS |
| Symbolic-equivalence cases caught | 3 (e-1≈1.71828, π²-4 via LaTeX, e≈2.71828) | recorded |

**Notes on CAS target:**
- The design-doc target "CAS subdomain (calculus): 0% → ≥30%" refers to the pure-symbolic subdomain (derivatives/integrals/ode) that was 0% in the original run. Grader-v2 alone did NOT move these categories — all 25 items there are still wrong because the model's extracted answer (e.g. `3` instead of `3*x^2`) is genuinely wrong, not a grader normalization issue.
- However, the full CAS dataset crossed the 30% threshold (31.7%) via the numeric/symbolic equivalence stage catching decimal representations of `e` and `π²-4`.
- Phase 1 (output hygiene) is required to address the 0% derivative/integral/ode categories, which require fixing what the model actually outputs.

## Newly correct under v2 (highlights)

Three tool-augmented answers that v1 missed but v2 catches via numeric/symbolic equivalence:

- **#22** [CAS — definite_integrals] `∫e^x dx from 0 to 1`: expected `e-1`, model answered `1.718281828`. Caught by numeric tolerance stage (|1.71828... - (e-1)| < 1e-6).
- **#29** [CAS — definite_integrals] `∫x²·sin(x) dx from 0 to π`: expected `pi^2-4`, model answered `\pi^2 - 4` (LaTeX). Caught by normalizer canonicalizing LaTeX `\pi^2` to `pi^2`.
- **#32** [CAS — limits] `lim(1+1/n)^n as n→∞`: expected `e`, model answered `2.718281828`. Caught by numeric tolerance (|2.71828... - e| < 1e-6).

## Findings to feed Phase 1

1. **Derivatives (0/10):** The model outputs the constant coefficient or leading term (e.g., `3` for `3*x^2`, `2` for `2*x*sin(x)+x^2*cos(x)`). The compute tool returns the correct symbolic expression but the model fails to extract it cleanly from a multi-line response. Phase 1 fix: structured tool output with explicit `\boxed{}` suffix.

2. **Indefinite integrals (0/10):** Similar pattern — model gives scalar or partial answer. The tool result has the full correct expression but extraction picks up the wrong token.

3. **ODE (0/5):** Model outputs the coefficient rather than the general solution (e.g., `2` instead of `y = x^2 + C`). The tool does compute the right solution.

4. **GSM8K regression (-4):** v2's stricter normalization rejects answers like `list[x>=12]` being matched against `13`. These are cases where the tool returned a Giac list-form answer and the model incorrectly extracted from it — not grader false-negatives. Phase 1 should improve output parsing to extract the final numeric value from list results.

5. **Grader v2 is net stricter overall:** Total tool-aug went from 211 to 206 (-5). This is the correct direction — v1 was too lenient. The 3 CAS improvements (+3) are genuine symbolic catches; the -8 elsewhere are real false-positives that v1 accepted.

## CAS subdomain detail

| Category | N | v1 base | v1 tool | v2 tool | Δt |
|---|---|---|---|---|---|
| derivatives | 10 | 0 | 0 | 0 | +0 |
| integrals (indefinite) | 10 | 0 | 0 | 0 | +0 |
| definite_integrals | 10 | 7 | 6 | 8 | +2 |
| limits | 5 | 4 | 4 | 5 | +1 |
| ode | 5 | 0 | 0 | 0 | +0 |
| linear_algebra | 10 | 6 | 6 | 6 | +0 |
| polynomial | 5 | 0 | 0 | 0 | +0 |
| series | 5 | 0 | 0 | 0 | +0 |

## Files shipped in Phase 0

- `benchmark/graders/normalizer.ts` (LaTeX/Unicode canonicalization, kind detection)
- `benchmark/graders/grader-v2.ts` (5-stage pipeline + symbolic equivalence)
- `benchmark/graders/giac-bridge.ts` (timeout + cache wrapper)
- `benchmark/analyze.ts` (regression classification CLI)
- `benchmark/regrade.ts` (offline regrade CLI)
- `test/golden/` (regression-seeded golden corpus)
- `--features=v2` flag in `benchmark/index.ts` / `benchmark/config.ts` for ablation
