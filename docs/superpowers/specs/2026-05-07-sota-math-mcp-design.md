# Axiom SOTA Math MCP — Design Document (Revised)

**Date:** 2026-05-07
**Status:** Approved (revision 2)
**Author:** Tufan Tunc + Axiom Design Session
**Supersedes:** Initial design (commit 826a9aa)

## Why this revision

The prior spec was rewritten after a critical review against the actual benchmark data (`benchmark/results/2026-04-08-15-51-27-zai-quick-details.jsonl`, 360 problems). Three of its core assumptions did not match the evidence:

1. The "tool under-utilization" framing was wrong. On MATH datasets the tool call rate is already 94–100%; the under-utilization is concentrated **only on Omni-MATH**, where 41 of 50 problems get zero tool calls.
2. The CAS calculus 0% problem is **not a tool problem**. Concrete evidence: `diff(x^3, x)` returns `3*x^2` correctly with full LaTeX, but the model extracts `3` as its final answer. This is an answer-extraction / grader issue.
3. The proposed `analyze` tool (rule-based classifier + 8 strategy templates) is a high-cost intervention with no evidence of benefit and significant added latency. Self-consistency and structured output have stronger SOTA precedent.

This revision reorders the work so that the cheapest, highest-evidence fixes ship first, every change is ablation-measured, and the more speculative interventions are deferred until earlier work plateaus.

## Problem Statement

Axiom Advanced Math MCP provides 15 math tools (76 operations) backed by Giac CAS WASM and math.js. The 2026-04-08 benchmark (glm-5.1, 360 problems) shows the system is competitive on standard MATH datasets but has three data-grounded failure modes:

1. **Answer-extraction collapse on symbolic outputs** — Tool returns `3*x^2`, model writes `3`. Drives ~63% of regressions and the 0% CAS calculus subdomain accuracy.
2. **Olympiad disengagement** — On Omni-MATH ≥7, 41/50 (82%) problems get no tool call at all. Average 1.26 tool calls per problem vs. 4.90 on MATH L5.
3. **Silent compute failures** — `solve(|5x-1|=|3x+2|, x)` returns `[]` (parse failure) but the model treats it as "no solutions exist". Tool layer reports 100% success because empty/error results are not detected.

Secondary issues identified in regressions:
- LaTeX/symbolic equivalence not handled by grader (`-82/27` vs `-\frac{82}{27}`, `16/3` extracted as `8`).
- Set/interval/conditional answer formats fail string match.
- Unicode / LaTeX preprocessing inconsistencies (`\|x\|` vs `abs(x)`).

**Current best results (2026-04-08, glm-5.1):**

| Dataset | Baseline | +MCP | Delta | Tool calls/problem | "No tool" |
|---|---|---|---|---|---|
| GSM8K (100) | 96.0% | 98.0% | +2.0% | 1.88 | 3 |
| MATH L3 (50) | 70.0% | 80.0% | +10.0% | 3.22 | 0 |
| MATH L4 (50) | 50.0% | 62.0% | +12.0% | 4.20 | 2 |
| MATH L5 (50) | 38.0% | 52.0% | +14.0% | 4.90 | 3 |
| Omni-MATH ≥7 (50) | 0.0% | 0.0% | 0.0% | 1.26 | 41 |
| CAS (60) | 28.3% | 26.7% | −1.7% | 2.33 | 0 |

Token cost ratio: 712k → 3.25M tokens (4.6× for tool-augmented condition).

## Design Goals

- **Evidence-driven:** Every change must have a measurable hypothesis and an ablation test. No change ships without a benchmark delta.
- **Cheapest fix first:** Order interventions by ROI. Fix the grader / output before building new tools.
- **Model-agnostic:** Improvements must benefit any tool-using LLM, not just glm-5.1.
- **Pareto-aware:** Track token cost alongside accuracy. Goal is to push the cost-accuracy frontier, not just accuracy.
- **No silent failures:** Compute layer must distinguish success, partial success, and failure. Empty/error results are not "success".
- **Reference SOTA:** Include literature baselines (ToRA, MARIO, GPT-4 + Code Interpreter) so "SOTA" has concrete meaning.

## Non-Goals (this revision)

- Training a fine-tuned model. Out of scope; we improve the tool layer only.
- A second CAS engine (e.g., SymPy alongside Giac). Defer until Giac gaps prove unworkable.
- Proof verification (Lean/Coq integration). Olympiad proof problems remain partially out of scope; we target computational olympiad problems first.

## Reference SOTA (literature baselines)

Approximate published numbers on similar datasets. Direct comparison is imperfect (different splits, models, evaluation), but anchors target setting.

| System | GSM8K | MATH | Notes |
|---|---|---|---|
| GPT-4 + Code Interpreter | ~95% | ~70% | Reported by OpenAI; tool-augmented |
| Claude 3.5 Sonnet + tools | ~95% | ~70% | Internal reports |
| ToRA-70B | ~88% | ~50% | Open-source tool-augmented LLM |
| MARIO | ~78% | ~58% | Multi-tool reasoning |
| Self-consistency (N=40, no tools) | +5–10% | +8–15% | Wang et al., consistent gain |
| Omni-MATH top open systems | n/a | 5–15% | Olympiad-tier |

**Implication:** Our MATH L5 at 52% is already in the open-system competitive band. Pushing toward 60–65% on L5 and producing any non-zero Omni-MATH score would be SOTA-tier for an open-source MCP.

## Architecture

```
┌─────────────────────────────────────────────────┐
│         OUTPUT HYGIENE (Phase 1)                │
│  Tool result → structured JSON →                │
│  \boxed{answer} suffix → silent-failure flag    │
├─────────────────────────────────────────────────┤
│      COMPUTE LAYER (Phase 2)                    │
│  Preprocess → primary route → fallback chain → │
│  result-quality check → format                  │
├─────────────────────────────────────────────────┤
│       VERIFICATION LAYER (existing + Phase 1)   │
│  Symbolic + numeric + boundary checks →         │
│  structured fix_attempt on failure              │
├─────────────────────────────────────────────────┤
│      SELF-CONSISTENCY (Phase 3, optional)       │
│  N=3–5 sampling on hard problems →              │
│  majority vote on normalized answers            │
├─────────────────────────────────────────────────┤
│       OLYMPIAD WRAPPER (Phase 4)                │
│  Olympiad-specific prompt + N=5 sampling +      │
│  per-step verification                          │
└─────────────────────────────────────────────────┘
```

The grader, normalizer, and benchmark harness live alongside this stack and are upgraded in Phase 0 before any tool changes ship.

## Phase 0 — Measurement & Grader

The single highest-ROI work. We have strong evidence (CAS 0% subdomains where the tool produces correct symbolic output) that fixing the grader alone recovers a large fraction of regressions. Grader fixes also let us measure the impact of every subsequent phase honestly.

### 0.1 Answer normalizer

New module `benchmark/graders/normalizer.ts`:

```typescript
interface NormalizedAnswer {
  canonical: string      // "sqrt(2)/2"
  latex: string          // "\frac{\sqrt{2}}{2}"
  decimal: number | null // 0.7071... or null if non-numeric
  is_exact: boolean
  kind: 'scalar' | 'set' | 'interval' | 'conditional' | 'expression'
}
```

Normalization rules cover:

| Pattern | Transform |
|---|---|
| `\frac{a}{b}` | `(a)/(b)` |
| `\dfrac`, `\tfrac` | `\frac` |
| `\sqrt{n}` | `sqrt(n)` |
| `\left(`, `\right)` | `(`, `)` |
| `^{2}`, `²` | `^2` |
| `\pi`, `π` | `pi` |
| `\cdot`, `\times`, `×` | `*` |
| `\div`, `÷` | `/` |
| `\boxed{X}` | `X` (extract) |
| `\text{...}`, `\mathrm{...}` | strip |
| `sin^2(x)` | `(sin(x))^2` |
| Whitespace | collapsed |

### 0.2 Enhanced grader

Pipeline in `benchmark/graders/grader.ts`:

```typescript
function grade(expected: string, actual: string): GradeResult {
  // 1. Exact string match (fast path)
  // 2. Normalize both, retry exact match
  // 3. Numeric tolerance for scalars
  // 4. Set-aware match for {a, b, c} (order-insensitive)
  // 5. Interval-aware match for (a, b], [a, ∞), x >= a
  // 6. Conditional-aware match for "x = 1 or x = 2"
  // 7. Symbolic equivalence: simplify(normalize(expected) - normalize(actual)) == 0 via Giac
  // 8. Multi-point numeric eval for parametric expressions
  return { match: bool, reason: string, kind: string }
}
```

Symbolic equivalence (step 7) is the single biggest grader change. It catches the `3*x^2` vs `3 \cdot x^{2}` family of regressions wholesale.

### 0.3 Regression analysis tool

New CLI: `npm run benchmark:analyze`. Reads latest JSONL and classifies every regression and "both wrong" case:

| Category | Detection |
|---|---|
| `NO_TOOL_CALL` | `toolCalls.length == 0` |
| `EMPTY_TOOL_RESULT` | Tool result is `[]`, `GIAC_ERROR`, NaN, or empty |
| `OUTPUT_PARSE_ERROR` | Correct symbolic answer in tool output, model extracted differently |
| `GRADER_MISMATCH` | Normalizer says equal, grader said not |
| `WRONG_ANSWER` | Genuinely wrong final answer |
| `WRONG_TOOL_CALL` | Tool input was malformed |

Output: per-category Markdown report with examples and suggested fix area.

### 0.4 Ablation harness

Benchmark runner accepts a `--features` flag listing which Phase changes are enabled (e.g., `--features=normalizer,structured_output`). Each phase's PR re-runs the benchmark with feature on/off so we get an isolated delta per change.

### 0.5 Golden regression corpus

Every concrete failure observed in past runs is added as a permanent test case under `test/golden/`. Tests fall into two kinds:

**Tool-level golden tests** — exercise the compute/verify layer directly. Asserts the tool returns the right symbolic result and (post-Phase 1) the right `answer_boxed` field.

- `solve(|5x - 1| = |3x + 2|, x)` — pipe-notation parse failure (Phase 2 fallback chain must recover this)
- `int(sqrt(x), x, 0, 4)` — must produce `16/3` and box it
- `diff(x^3, x)` — must produce `3*x^2` and box it
- `(x-3)^2 - (x-8)^2 >= 0` — must produce `x>=11/2`
- `C(3,2)*(1/6)^2*(5/6) + (1/6)^3` — must produce `2/27`

**Grader-level golden tests** — given a (ground truth, candidate answer) pair, assert the grader matches them.

- `(-82/27, -\frac{82}{27})` → match
- `(16/3, 16/3)` → match (regression: was extracted as 8 by parser)
- `({1, 2, 3}, {3, 1, 2})` → match (set-aware)
- `(x >= 11/2, [11/2, ∞))` → match (interval-aware)
- `(2*x*sin(x)+x^2*cos(x), cos(x)*x^2+sin(x)*2*x)` → match (symbolic equivalence)

Cases like the Carlos lemon-tree problem (model extracted 12 vs ground truth 13) are *interaction-level* failures — they depend on the model's reasoning, not on tool or grader behavior — and so are tracked in the regression analysis report (0.3) rather than as deterministic golden tests.

Policy: any new tool-level or grader-level regression observed in a benchmark run becomes a golden test before its fix lands.

### 0.6 Phase 0 success metrics

| Metric | Now | After Phase 0 (target) | Measurement |
|---|---|---|---|
| CAS subdomain (calculus) | 0% | ≥30% | Same benchmark run, grader-only change |
| GRADER_MISMATCH count | 5 of 8 regressions | ≤1 | Regression analysis output |
| Symbolic-equivalence cases caught | 0 | All sampled | Unit + integration tests |

Phase 0 ships before any tool-side change. We rerun the 360-problem benchmark and publish the delta from grader work alone.

## Phase 1 — Output Hygiene (REJECTED)

**Status:** Hypothesis rejected by live A/B benchmark. Removed from codebase.

The structured JSON envelope + `\boxed{...}` trailer hypothesis assumed
LLMs repeat `\boxed{}` content verbatim. In practice the model
paraphrases symbolic answers into its own LaTeX style, breaking the
answer parser. See [`2026-05-07-phase-1-results.md`](./2026-05-07-phase-1-results.md)
for the full analysis.

Independent fixes that survived: env passthrough in mcp-proxy,
bare-fraction handling in answer-parser, verify confidence corrections.

The "Why this revision" section's commit reference (826a9aa) and the
phase numbering in subsequent sections still apply.

## Phase 2 — Preprocessing & Fallback Chain

### 2.1 Compute pipeline

```
input
  → preprocess (Unicode/LaTeX normalize)
  → primary route (router.ts existing logic)
  → dispatch to Giac/math.js
  → result-quality check
     ├─ ok → format
     ├─ empty/error → fallback chain
     └─ ambiguous → mark confidence=low, format
```

### 2.2 Preprocessing rules

| Pattern | Transform | Reason |
|---|---|---|
| `\|x\|` / `|x|` | `abs(x)` | Giac pipe notation |
| `π`, `\pi` | `pi` | Unicode |
| `²`, `³` | `^2`, `^3` | Unicode superscript |
| `×`, `\times`, `\cdot` | `*` | Multiplication symbol |
| `÷`, `\div` | `/` | Division symbol |
| `\frac{a}{b}` | `(a)/(b)` | LaTeX fraction |
| `\sqrt{n}` | `sqrt(n)` | LaTeX root |
| `mod(a,b)` | `irem(a,b)` | Giac modulus |
| `fibonacci(n)` | call helper | Giac lacks fibonacci |
| `seq(...)` | `makelist(...)` | Giac seq returns empty in some forms |

Preprocessing is **non-destructive**: original input is preserved in `raw` and tried in the fallback chain.

### 2.3 Result-quality check

Detect bad-but-not-thrown results from Giac:

| Signal | Action |
|---|---|
| Result is `[]` and operation was `solve` | Mark as empty-result, try fallback |
| Result starts with `GIAC_ERROR` | Mark error, try fallback |
| Result is `NaN`, `Inf`, or `undef` | Mark unstable, try fallback |
| Result is identical to input | No simplification happened, mark low confidence |

### 2.4 Fallback chain

For each compute call, attempt in order:

1. **Plain input** (preserved from user)
2. **Preprocessed input** (Unicode/LaTeX normalized)
3. **Alternate-form input** (operation-specific, e.g., `abs(x)` → `sqrt(x^2)` for solve)
4. **math.js fallback** (for purely numeric expressions)

If all fail, return `confidence: 'low'` with the best partial result and clear `warnings`.

### 2.5 Phase 2 success metrics

| Metric | Now | Target |
|---|---|---|
| CAS subdomain (definite_integrals) | 60% | ≥75% |
| CAS subdomain (derivatives) | 0% | ≥60% (with Phase 0+1 grader) |
| Silent-failure regressions | observed | 0 |
| Tool 100% success rate (suspicious) | 100% | accurate (real failures surface) |

## Phase 3 — Self-Consistency

Cheap, high-evidence SOTA technique. Apply only to hard problems to control cost.

### 3.1 Mechanism

For problems flagged as hard (criteria below), the runner samples N solutions independently with `temperature ≈ 0.7`, normalizes each final answer, and majority-votes:

```typescript
function self_consistent_solve(problem, n=5): Answer {
  const answers = [];
  for (let i = 0; i < n; i++) {
    const a = solve_once(problem, { temperature: 0.7 });
    answers.push(normalize(a));
  }
  return mode(answers);
}
```

Hard-problem trigger:
- Dataset is MATH L5, Omni-MATH, or hard CAS subdomain
- OR final-answer verify failed
- OR `confidence` of last compute call was `low`

### 3.2 Cost control

- N=3 default, N=5 for olympiad
- Skip self-consistency for any problem the baseline first-shot already verifies
- Token budget cap per problem (configurable, default 8k)

### 3.3 Phase 3 success metrics

| Metric | Now | Target |
|---|---|---|
| MATH L5 | 52% | 58–62% |
| Omni-MATH ≥7 | 0% | 4–8% (modest, prep for Phase 4) |
| Tokens per correct answer | track | ≤2× baseline |

## Phase 4 — Olympiad Wrapper

Olympiad disengagement (41/50 no tool calls on Omni) is its own problem and gets its own intervention.

### 4.1 Olympiad-specific prompt template

System prompt augmentation triggered when problem is classified as olympiad (heuristic: source dataset, length, presence of "prove", "find all", competition keywords):

```
This is an olympiad-level problem. They are designed to require multiple
non-obvious steps. You will not solve it in one shot. Your job is to:

1. Make the problem concrete: try N=2, N=3 special cases with `compute`.
2. Conjecture a pattern from the special cases.
3. Verify the conjecture on a fresh case with `compute` or `verify`.
4. State the answer in \boxed{...}.

Do NOT skip steps 1–2. Do NOT answer without using compute at least 3 times.
```

### 4.2 Per-step verification

Olympiad mode forces a `verify` call after every non-trivial `compute` call. The verify response's `fix_attempt` flow drives any retry.

### 4.3 N=5 self-consistency, mandatory

Olympiad problems always run with N=5 self-consistency. Cost is acceptable because base accuracy is 0%.

### 4.4 (Deferred) `analyze` tool

If Phases 0–4 stall before Omni-MATH ≥10%, revisit a lightweight `analyze` tool. Scope at that time:
- Olympiad-only (no general MATH use)
- Outputs at most: `{is_olympiad: bool, recommended_special_cases: number[], known_identities: string[]}`
- Not a "strategy planner" — just a static lookup table for known competition patterns

### 4.5 Phase 4 success metrics

| Metric | Now | Target |
|---|---|---|
| Omni-MATH ≥7 | 0% | ≥10% |
| Omni-MATH "no tool call" rate | 82% | ≤20% |
| Olympiad token cost | n/a | ≤4× MATH L5 token cost per problem |

## File Changes Summary

### New files

| File | Phase | Purpose |
|---|---|---|
| `benchmark/graders/normalizer.ts` | 0 | LaTeX/Unicode normalization |
| `benchmark/graders/grader-v2.ts` | 0 | Symbolic equivalence + set/interval matching |
| `benchmark/analyze.ts` | 0 | Regression classifier CLI |
| `benchmark/ablation.ts` | 0 | `--features` flag harness |
| `test/golden/` | 0 | Permanent regression corpus |
| `src/server/tools/response-formatter-v2.ts` | 1 | Structured JSON + `\boxed{}` suffix |
| `src/server/tools/compute/preprocess.ts` | 2 | Input preprocessing |
| `src/server/tools/compute/fallback.ts` | 2 | Multi-stage fallback chain |
| `src/server/tools/compute/quality-check.ts` | 2 | Detect empty/error/Inf results |
| `benchmark/runners/self-consistency.ts` | 3 | N-sample majority vote |
| `src/server/prompts/olympiad.ts` | 4 | Olympiad-specific prompt |

### Modified files

| File | Changes |
|---|---|
| `benchmark/graders/grader.ts` | Wire normalizer + grader-v2 pipeline |
| `benchmark/graders/answer-parser.ts` | Use normalizer for `\boxed{}` extraction |
| `benchmark/index.ts` | `analyze` and `ablation` CLI commands |
| `src/server/tools/compute/index.ts` | Wire preprocess → primary → fallback → quality-check |
| `src/server/tools/verify/index.ts` | Structured `fix_attempt` instead of free-form suggestion |
| `src/server/tools/response-formatter.ts` | Bridge to v2 formatter |
| `src/server/tools/index.ts` | Tool descriptions clarify "always use compute, repeat \boxed answer" |
| `src/server/prompts/index.ts` | Updated default prompt + olympiad detection |

### Removed from prior spec

| Item | Reason |
|---|---|
| `analyze` tool (rule-based classifier + 8 strategy templates) | No evidence of benefit; high token cost; may revisit narrowly in Phase 4 |
| "Tool call rate >85%" success metric | Already achieved on MATH (94–100%); misleading metric |
| Free-form "reflexion suggestion" in verify | Replaced with structured `fix_attempt` |
| `structured-solve` / `step-verify` prompt templates | Folded into the default prompt; olympiad-solve kept |

## Success Metrics (consolidated)

| Metric | Now | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|---|---|---|---|---|---|---|
| GSM8K | 98% | — | 98% | 99% | 99% | 99% |
| MATH L3 | 80% | — | 82% | 85% | 87% | — |
| MATH L4 | 62% | — | 65% | 70% | 72% | — |
| MATH L5 | 52% | — | 56% | 60% | 62% | — |
| Omni-MATH ≥7 | 0% | — | — | — | 4% | ≥10% |
| CAS overall | 26.7% | ~45% | 50% | 60% | — | — |
| Regression count / 360 | 8 | ≤4 | ≤3 | ≤2 | ≤2 | ≤2 |
| Tokens per correct (relative) | 1.0 | 1.0 | 1.05 | 1.1 | 1.6 | 1.8 |

The token-per-correct row is the Pareto control. Self-consistency (Phase 3) is allowed to roughly double cost only because the accuracy gain is large.

## Test Policy

- Every Phase ships with: unit tests for new modules, an integration test on the golden corpus, and a full 360-problem benchmark rerun with the ablation flag set.
- Every observed regression in any benchmark run becomes a permanent golden test before its fix lands.
- Integration test config (`vitest.config.integration.ts`) must continue to skip the Giac mock — see `AGENTS.md`.

## Open Questions

These do not block Phase 0 but should be resolved during implementation.

1. Does glm-5.1's `\boxed{}` repetition behavior generalize to Claude / GPT-4? Plan: test on at least one alternate model in Phase 1 ablation.
2. Self-consistency at temperature 0.7 — is glm-5.1 stable enough? Plan: pilot N=3 on 30 problems before committing to Phase 3.
3. Is grader-v2's symbolic equivalence (Giac `simplify(a-b)==0`) fast enough at benchmark scale? Plan: cache + timeout.

## References

- Wang et al., "Self-Consistency Improves Chain of Thought Reasoning in Language Models", 2022.
- Gou et al., "ToRA: A Tool-Integrated Reasoning Agent for Mathematical Problem Solving", 2023.
- MATH dataset (Hendrycks et al.) and Omni-MATH (2024).
- Giac/Xcas user manual — function reference for `simplify`, `solve`, `irem`, `makelist`.
