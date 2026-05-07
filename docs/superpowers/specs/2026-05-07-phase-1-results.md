# Phase 1 — Results (FAILED)

**Date:** 2026-05-08
**Status:** HYPOTHESIS REJECTED — output-v2 removed from codebase
**Branch:** main

## Hypothesis

Wrap every MCP tool response in a structured JSON envelope ending with a
`\boxed{...}` line so the LLM reliably repeats the symbolic answer
instead of extracting only the leading coefficient (e.g., `3` instead
of `3*x^2`).

## Test design

A/B comparison on CAS-quick (60 problems, glm-5.1 via z.ai) with two
conditions, both running grader-v2:

- **A (control):** `--features=v2` (v1 tool output)
- **B (experimental):** `--features=v2,output-v2` (JSON envelope + boxed trailer)

## Results

### CAS-quick, condition A (control)

| Metric | Value |
|---|---|
| Baseline | 55.0% (33/60) |
| +MCP | 68.3% (41/60) |
| Delta | **+13.3pp, net +8** |
| Improvements | 11 |
| Regressions | 3 |

### CAS-quick, condition B (experimental)

| Metric | Value |
|---|---|
| Baseline | 58.3% (35/60) |
| +MCP | 56.7% (34/60) |
| Delta | **−1.7pp, net −1** |
| Improvements | 9 |
| Regressions | 10 |
| Regression diagnosis | extraction_mismatch: 5, wrong_tool_result: 5 |

### Direct A→B comparison

8 problems flipped from correct under A to wrong under B (cost of v2).
1 problem flipped the other way (benefit of v2).
**Net: −7 problems.** v2 envelope made things significantly worse.

## Why output-v2 failed

Inspection of the 8 A→B regressions revealed a consistent pattern: the
model does NOT repeat the `\boxed{...}` content verbatim. Instead, it
re-renders the answer in its own LaTeX style, often:

| GT (Giac plain) | Boxed in tool | Model's final extraction |
|---|---|---|
| `exp(x)+x*exp(x)` | `\boxed{exp(x)+x*exp(x)}` | `e^x + xe^x` |
| `exp(2*x)/2` | `\boxed{exp(2*x)/2}` | `\dfrac{e^{2x}}{2} + C` |
| `(x-3)*(x+3)` | `\boxed{(x-3)*(x+3)}` | `(x - 3)(x + 3` (truncated) |
| `3*exp(3*x)*cos(x)-exp(3*x)*sin(x)` | (boxed) | `e^{3x}\left(3\cos(x) - \sin(x)\right` |

Two factors compounded:

1. **LaTeX preference.** When the JSON contained both `answer` (plain Giac)
   and `answer_latex` (LaTeX rendering), the model latched onto the LaTeX
   form. Under v1 the response was a plain-text line format with the plain
   answer prominently repeated (`Result: ...`, `The answer is ...`),
   which the model copied directly.
2. **Auto-rendering.** Even when only the boxed plain form was visible,
   the model paraphrased it into LaTeX while writing its final answer
   (training prior for math content). The grader could not match the
   re-rendered form against Giac plain ground truth.

A secondary failure mode: verify's `\boxed{TRUE/FALSE}` trailer (later
hot-fixed) overwrote compute's symbolic boxed because the answer parser
uses `lastIndexOf('\\boxed{')`. The trailer fix landed before the live
A/B and is therefore reflected in the numbers above.

## Decision

**Remove output-v2 from the codebase entirely.** Keeping it as opt-in dead
code creates maintenance burden with zero proven benefit.

## What stays from the Phase 1 work

These independent fixes were exposed during Phase 1 development and have
been retained on main:

- **`benchmark/runners/mcp-proxy.ts` env passthrough** — passes `process.env`
  to the spawned MCP server. Defensive improvement for any future env-var use.
- **`benchmark/graders/answer-parser.ts` bare-fraction handling** —
  `extractModelAnswer('-82/27')` no longer truncates to `-82`.
- **`src/server/tools/verify/index.ts` confidence corrections** —
  identity verification failure now reports `confidence: 'low'` (was
  incorrectly `'high'`); solution failure now reports `'medium'`
  (was hard-coded `'high'` in both branches).

## What we learned (for future work)

1. **`\boxed{}` repeat-verbatim is unreliable for symbolic answers.**
   The model's training prior to render math in LaTeX style overrides
   verbatim copy. Future "structured output" attempts must address this
   directly — most likely via prompt engineering ("copy the boxed content
   exactly, do not rewrite") rather than format engineering alone.
2. **Phase 0 was a much bigger win than the regrade suggested.** Live
   measurement: CAS 55% → 68.3% (+13.3pp) under grader-v2 alone vs the
   April regrade's 26.7→31.7 (+5pp). The fresh model run with the v2
   grader in the loop is what matters.
3. **Live A/B is essential.** The Phase 1 hypothesis looked plausible
   in unit tests and golden integration tests (both verified the boxed
   trailer reached the response). Only live model behavior revealed
   the LaTeX-paraphrase issue.

## New baseline for Phase 2

CAS-quick under `--features=v2` (grader-v2 only) is the working baseline
going forward:

- **CAS:** 68.3% (was 26.7% pre-Phase-0 measurement)
- **Regressions per 60:** 3 (extraction_mismatch: 1, wrong_tool_result: 2)

Phase 2 (preprocessing + fallback chain) targets the remaining failure
modes — wrong_tool_result and silent compute failures — which are
independent of output formatting.
