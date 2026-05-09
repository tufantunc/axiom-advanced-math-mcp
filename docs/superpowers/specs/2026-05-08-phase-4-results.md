# Phase 4 — Results

**Date:** 2026-05-08
**Branch:** main (post-merge)
**Status:** COMPLETE — **HYPOTHESIS REJECTED.** Olympiad prompt regressed accuracy. Phase 4 marks the end of prompt-engineering interventions for olympiad problems; further work requires fundamentally different approaches.

## TL;DR

| Goal | Target | Result | Status |
|---|---|---|---|
| Omni-MATH ≥7 +MCP | ≥6% (3 problems) | **0% (Cond 2), 0% true (Cond 3)** | ❌ FAIL |
| "No tool call" rate | ≤40% | 74% (Cond 2) | ❌ FAIL |
| Avg tool calls per problem | ≥3 | 2.38 (Cond 3 only) | ⚠ MARGINAL |
| Token cost | ≤4× MATH L4 | within budget | ✅ PASS |

**Decision:** Mark olympiad as **out of scope for prompt-engineering interventions**. The Axiom Math MCP is production-ready at its current ceiling (GSM8K 98%, MATH L4-L5 52-65%, CAS 70%) for non-olympiad problems. Olympiad-tier problems require fundamentally different approaches (model fine-tuning, Lean/Coq integration, retrieval-augmented examples, multi-tool coordinators) — out of scope for this project.

## Live ablation runs

3 conditions × 50 Omni-MATH ≥7 problems × glm-5.1 via z.ai.

### Per-condition Omni-MATH ≥7

| Condition | N | +MCP | "No tool call" | Avg tool calls | Avg turns |
|---|---|---|---|---|---|
| 1: v2 (control) | 50 | **2/50 (4.0%)** | 42/50 (84%) | 1.28 | 2.16 |
| 2: v2 + olympiad-prompt | 50 | 0/50 (0.0%) | 37/50 (74%) | 1.48 | 1.94 |
| 3: olympiad-prompt + voting | 50 | 1/50 (2.0%)\* | 40/50 (80%) | 2.38 | 2.20 |

\* Cond 3's single "win" is a grader false positive — see Findings below.

### Engagement-vs-accuracy disconnect

The olympiad prompt **DID improve engagement** (no-tool rate 84% → 74%, avg tool calls 1.28 → 2.38) but **DID NOT translate to accuracy**. More engagement led to more pseudocode errors and more confident-but-wrong answers, not more correct ones.

| Metric | Apr 2026 | Cond 1 (May, no prompt) | Cond 2 (May, with prompt) | Δ Apr→Cond 2 |
|---|---|---|---|---|
| +MCP correct | 0/50 | 2/50 | 0/50 | 0 |
| No tool call | 41/50 (82%) | 42/50 (84%) | 37/50 (74%) | −4 |
| Avg tool calls | 1.26 | 1.28 | 1.48 | +0.22 |

The engagement metric improved per design, but the underlying problem — model can't solve these problems even when it engages — is unaffected.

### Phase 4 success-metric check

| Target | Result | Status |
|---|---|---|
| Omni-MATH +MCP ≥6% (3 problems) | 0% (or 4% with grader-noise wins) | ❌ FAIL |
| "No tool call" rate ≤40% | 74% | ❌ FAIL |
| Avg tool calls ≥3 | 2.38 (only under voting) | ⚠ MARGINAL |
| Token cost ≤4× MATH L4 | within budget | ✅ PASS |

## Findings

### Why Cond 1 "won" 2 problems (and they're not real wins)

The April baseline reported 0/50; May Cond 1 reports 2/50. Inspection shows **both wins are grader artifacts**, not reasoning gains:

**Problem #1** (acute scalene triangle, orthocenter problem):
- GT: `"1"` (a single digit)
- Cond 1 extracted: `"1"` ✓ (matched)
- Cond 1 trace: 9 turns, 8 tool calls, mostly Giac errors on coordinate geometry; final extracted answer was a numeric mention from one of the failed compute calls

**Problem #45** (find all positive integer pairs (a,n)):
- GT: `"(a, n) = (a, 1)"` (parametric — n=1 works for all a)
- Cond 1 extracted: `"1"` ✓ (substring match against `(a, 1)`)
- Cond 1 didn't construct the parametric answer; the grader's substring match treated `"1"` as a hit

**Cond 3's "win"** — Problem #31:
- GT: `"the incenter, circumcenter, and orthocenter of △ABC"` (long-text answer)
- Cond 3 extracted: `"a"` ✓ (grader matched substring against the long text)
- This is unambiguously a grader false positive — `"a"` has no semantic connection to the answer

### Why the olympiad prompt regressed Cond 1's lucky wins

**Problem #1** under Cond 2 (olympiad prompt): extracted `"5"` ✗
- Model followed the "try small cases n=2,3,4,5" instruction
- Last computed small-case value was 5, which the model then reported as the answer
- The "lucky 1" extraction from Cond 1 became a "deliberate 5" miss

**Problem #45** under Cond 2: extracted `"GIAC_ERROR"` ✗
- Model followed the "use compute at least 3 times" instruction
- Wrote pseudocode-style Giac calls that the engine rejected
- 9 turns wasted on syntax errors; final answer just echoed the error string

The pattern: **the prompt forced the model into a structured small-cases / compute-heavy approach that prevented even the accidental wins**. When you tell the model "do step 1, 2, 3", it does them — and on these problems, doing them correctly produces wrong answers.

### Why prompt-engineering can't fix olympiad problems

Inspecting the 50 Omni-MATH ≥7 problems reveals four failure modes that prompt-engineering cannot address:

1. **Symbolic-in-N answers (24/50):** GTs like `"⌈n/2⌉+1"`, `"(a, 1)"`, `"⌈log₂n⌉"`. The model needs to construct symbolic expressions in n after detecting a pattern. This is a reasoning capability gap, not a prompt gap.

2. **Long-text answers (~5/50):** `"the incenter, circumcenter, and orthocenter of △ABC"`, `"there exist polynomials..."`. These don't fit the `\boxed{...}` numeric/short-formula format. The grader either fails or matches by accident.

3. **Geometry constructions (~8/50):** Coordinate setup with three altitudes, inversive distance, etc. Giac's `solve` cannot handle these; the model has no path to a numeric answer.

4. **Existence proofs (~5/50):** "Does there exist..." questions need domain knowledge (e.g., is it possible to construct such a polynomial?). Pattern detection from small cases doesn't generalize.

The olympiad prompt addresses none of these — it only addresses the engagement layer, which was never the binding constraint.

### What we learned

1. **The April baseline of 0% was real.** May Cond 1's 2/50 is grader artifacts; the actual capability hasn't changed.
2. **Engagement is not the binding constraint on olympiad problems.** Model engagement improved but accuracy did not. The bottleneck is upstream of engagement — it's the reasoning required to translate engagement into correct answers.
3. **Adding scaffolding can hurt.** When the model accidentally lands on a correct answer through unstructured reasoning, structured scaffolding can prevent that. Phase 4's "lucky 1 → deliberate 5" pattern is a striking example.
4. **Olympiad problems are out of distribution for current LLM+CAS systems.** Going further requires either (a) a model trained specifically for olympiads, (b) a different proof system (Lean/Coq), or (c) a retrieval system with olympiad solution patterns. None of these are in scope for this project.

## Decision

**`olympiad-prompt`: KEEP, off by default. Document as harmful for production.** Same disposition as Phase 1's `output-v2` and Phase 2's `tokens-8k`. The flag stays in code (it's a single conditional in `benchmark/index.ts`), but production runs should NOT enable it.

**Update (2026-05-08 cleanup):** The `olympiad-prompt` flag, the `TOOL_PROMPT_OLYMPIAD` constant, the `systemPrompt` plumbing, and the routing tests were all physically removed from the codebase in commits `0efd79a` and `da8d585`. Passing `--features=olympiad-prompt` is now a silent no-op.

**Olympiad benchmark dataset: KEEP for completeness.** The `--olympiad` benchmark flag stays so future work can re-evaluate when fundamentally different approaches are tried. But our recommended production benchmark is `--features=v2` on GSM8K, MATH, and CAS — not olympiad.

**Production benchmark recipe (final, unchanged from Phase 3):** `--features=v2`. Optional add: `output-hygiene,grader-v3` for marginal lift on CAS. **Avoid:** `tokens-8k`, `olympiad-prompt`. Optional methodology: `self-consistency` for variance-stable measurement.

## Production-ready ceiling (final)

The Axiom Math MCP is production-ready at:

| Dataset | +MCP accuracy | Notes |
|---|---|---|
| GSM8K | 98% | At ceiling — voting/prompts won't move it |
| MATH L3 | ~80% | Phase 0 grader is the value driver |
| MATH L4 | 50-65% | Significant headroom but model-bound |
| MATH L5 | 38-52% | Model-bound |
| CAS-quick | 70-72% | Ceiling for current model+tools |
| Omni-MATH ≥7 | 0-4% | Out of scope for prompt-engineering; needs different approach |

This is a strong baseline. Phase 0's grader work was the dominant value driver across all datasets — every subsequent phase had at most marginal effects on top of it.

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

## Closing note: scope for future work

If someone wants to push olympiad accuracy in the future, the data points away from prompt-engineering and toward:

1. **Lean/Coq integration** for proof-style olympiad problems (a separate project, not an MCP enhancement)
2. **Olympiad-specific RAG** — retrieval over a corpus of solved olympiad problems with similar structures (a separate project)
3. **A different LLM** trained specifically for olympiad math (out of project control)
4. **A multi-step decomposition system** that breaks olympiad problems into MATH-level subproblems (significant new architecture)

None of these are within scope for the Axiom Math MCP's prompt + grader iteration cycle. **Phase 4 marks the natural end of this iteration arc.**
