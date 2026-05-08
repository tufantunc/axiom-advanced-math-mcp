# Phase 4 — Olympiad Prompt (Design)

**Date:** 2026-05-08
**Status:** Approved
**Branch target:** `phase-4-olympiad-prompt` (off `main` post-Phase-3-merge)
**Supersedes:** Section "Phase 4 — Olympiad Wrapper" in `2026-05-07-sota-math-mcp-design.md`

## Why this revision

The original Phase 4 spec proposed four components: olympiad system prompt, per-step verification forcing, mandatory N=5 self-consistency, and a deferred `analyze` tool. Phase 3 evidence rules out one of these and demotes another:

| Original component | Phase 3-informed verdict |
|---|---|
| Olympiad system prompt | ✅ KEEP — addresses 82% no-tool-call dominant failure |
| Per-step verification forcing | ⏸ DEFER to Phase 4.5 — token cost vs uncertain gain |
| **Mandatory N=5 self-consistency** | ❌ REJECT — Phase 3 voting yielded +0pp on systematic failures |
| `analyze` tool / static lookup | ⏸ DEFER to Phase 4.5 |

Phase 3 lesson: when failures are systematic (model takes the same wrong path every time), voting cannot help — N samples produce the same wrong answer N times. Olympiad failures are systematic (model gives up entirely 82% of the time, or writes Python pseudocode the CAS doesn't accept). The right intervention is **prompt engineering to force engagement**, not sampling diversity.

Phase 4 ships the minimum viable intervention: a single olympiad-specific system prompt routed to Omni-MATH problems via a new `--features=olympiad-prompt` flag. If this measurably lifts Omni accuracy above 0%, Phase 4.5 can layer per-step verification or static lookup tables. If it doesn't, the data tells us prompt-only isn't enough and Phase 4.5 needs a different angle.

## Live evidence (from April 2026 Omni-MATH run)

50 Omni-MATH ≥7 problems, glm-5.1 + tools:

| Failure mode | Count |
|---|---|
| No tool call (model gave up) | 41/50 (82%) |
| 1-2 tool calls | 2/50 |
| 3+ tool calls | 7/50 |
| Correct | **0/50 (0%)** |

Of the 9 problems where the model engaged:
- 3+ wrote Python-style pseudocode (`for sigma in perms(...)`) that Giac rejects
- 1 set up coordinate geometry but Giac couldn't solve the system
- The rest had reasoning errors despite correct tool usage

Question patterns (50 problems):
- 24 mention "integer" (parametric answers in n)
- 16 mention "positive integer" (constructions/sequences)
- 8 "find all", 8 "maximum", 7 "minimum"
- Average question length 355 chars (vs MATH problems 150-300)

Three dominant root causes confirmed:
1. **Engagement collapse** (82%) — model treats olympiad problems as "too hard, skip"
2. **Pseudocode misuse** (3-5 problems) — model writes Python loops thinking Giac supports them
3. **Parametric answer blindness** — answers like `⌈n/2⌉+1`, `⌈log₂n⌉`, `2(4^n-1)/3+1` require small-case → pattern reasoning the model doesn't attempt

## Goals

- **Engagement fix:** Drive Omni "no tool call" rate from 82% to ≤40% via mandatory tool-use scaffolding in the prompt.
- **Pseudocode fix:** Eliminate Python-style code in compute calls via explicit Giac syntax cheat-sheet + DO NOT examples.
- **Parametric answer fix:** Force Polya-method reasoning (small cases → conjecture → verify) via explicit step-by-step instructions.
- **Composability:** New flag stacks cleanly with Phase 0 (`v2`), Phase 2 (`output-hygiene`, `grader-v3`), and Phase 3 (`self-consistency`).
- **Reversibility:** Default behavior unchanged when flag is absent.

## Non-goals

- Per-step verification forcing — defer to Phase 4.5 if Phase 4 lifts above 0%
- `analyze` tool / static lookup table — defer
- Subdomain-specific prompts (algebra vs geometry vs number theory) — single olympiad prompt for all Omni problems
- Mandatory N=5 self-consistency — Phase 3 disproved this approach
- Different prompts for different olympiad sources (Putnam vs IMO vs USAMO) — treat all uniformly

## Architecture

```
┌─ benchmark/providers/prompts.ts ─────────────────────┐
│  TOOL_PROMPT_OLYMPIAD (NEW) — Polya scaffolding +    │
│  Giac syntax cheat-sheet + parametric guidance       │
├─ benchmark/providers/types.ts ───────────────────────┤
│  runWithTools gains optional systemPrompt?: string   │
├─ benchmark/providers/openai-compat.ts ───────────────┤  Modified
│  3 hardcoded TOOL_SYSTEM_PROMPT references become    │
│  systemPrompt ?? TOOL_SYSTEM_PROMPT                  │
├─ benchmark/providers/anthropic.ts ───────────────────┤  Modified
│  Same parametric change                              │
├─ benchmark/runners/tool-augmented.ts ────────────────┤  Modified
│  Forward optional systemPrompt to provider           │
├─ benchmark/runners/self-consistency.ts ──────────────┤  Modified
│  voteToolAugmented forwards systemPrompt             │
├─ benchmark/index.ts ─────────────────────────────────┤  Modified
│  Per-problem dispatch picks olympiad prompt when:    │
│    features.includes('olympiad-prompt') AND          │
│    datasetName.startsWith('Omni-MATH')               │
└──────────────────────────────────────────────────────┘
```

No new architecture beyond the prompt constant. Pattern identical to Phase 3's temperature plumbing — same approach, different optional parameter.

## Component 4.1 — TOOL_PROMPT_OLYMPIAD content

The full prompt (placed in `benchmark/providers/prompts.ts`):

```
You are solving an OLYMPIAD-LEVEL math problem. These are designed to be hard
— they cannot be solved by a single direct calculation.

REQUIRED APPROACH (do NOT skip steps):

1. Read carefully. Identify what kind of answer the problem expects:
   - A specific number (e.g., "what is the maximum value of...")
   - A formula in n (e.g., "find the minimum m as a function of n")
   - A yes/no (e.g., "does there exist..." → answer "Yes" or "No")

2. Try small cases. Plug in n=2, 3, 4, 5 and compute the answer for each. Use
   compute for EACH small case:
   - compute({problem: "..."}) for n=2
   - compute({problem: "..."}) for n=3
   - compute({problem: "..."}) for n=4

3. Detect the pattern from the small-case answers:
   - 1, 2, 3, 4 → linear in n
   - 2, 5, 10, 17 → n²+1
   - 1, 2, 4, 8 → 2^(n-1)
   - 1, 2, 4, 7, 11 → ⌈n²/4⌉ or n(n-1)/2 + 1
   - State your conjectured formula explicitly

4. Verify the formula on a fresh value (n=6 or n=10):
   - compute({problem: "your_formula(6)"})
   - verify({claim: "f(6) = your_formula_value"})

5. State the final answer in \boxed{...} — the formula, the number, or
   "Yes"/"No".

GIAC SYNTAX (use these exact forms — NO Python loops, NO custom functions):
- Sums: sum(k^2, k, 1, n)
- Products: product(k, k, 1, n)
- Solve: solve(equation, x)
- Combinations: binomial(n, k) or C(n, k)
- Floor/ceil: floor(x), ceil(x)
- Logarithms: log(x, base) or ln(x)
- Sequences: seq(f(k), k, 1, n) returns a list

DO NOT:
- Write Python-style loops: `for k in range(...)` ❌
- Define new functions inside compute: `f(x) := ...` ❌
- Skip the small-cases step. Even if the pattern looks obvious, verify with
  at least 3 compute calls.
- Output an empty answer. If after 3 small cases you cannot find a pattern,
  state your best educated guess in \boxed{...} with a brief rationale.

CRITICAL: Use compute at least 3 times per olympiad problem. The model alone
cannot solve these — the tool's exact computation on small cases is what
reveals the structure.

At the very end, state your final answer in this exact format:
\boxed{<answer>}
```

Each section maps to an observed failure:

| Prompt section | Failure mode addressed |
|---|---|
| "REQUIRED APPROACH (do NOT skip)" | 82% no-tool-call (engagement collapse) |
| "Read carefully → identify answer type" | Parametric answer blindness |
| "Try small cases" with N=2,3,4,5 | Engagement + parametric answer detection |
| Pattern recognition table (1,2,3,4 → linear etc.) | Concrete examples prime model's pattern matching |
| "Verify the formula" | Already-existing verify step, reinforced |
| "GIAC SYNTAX" cheat-sheet | Pseudocode misuse |
| "DO NOT" rules | Pseudocode + giving-up + skipping steps |
| "Compute at least 3 times" | Engagement enforcement |
| "Output … in \boxed{...}" | Phase 0 grader compatibility |

Cost: ~400 words vs default ~50 words. ~+1500 tokens per Omni problem (input). 50 problems × 1500 = 75k extra tokens, ~$0.20-0.50 per olympiad-quick run. Acceptable since baseline is 0%.

## Component 4.2 — Provider system-prompt parameter

Same plumbing pattern as Phase 3 temperature.

### `benchmark/providers/types.ts`

```typescript
export interface LLMProvider {
  readonly name: string;
  readonly model: string;

  runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult>;

  runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number,
    systemPrompt?: string
  ): Promise<ToolAugmentedResult>;
}
```

`runBaseline` does NOT gain `systemPrompt` because olympiad prompt is tool-augmented-only — the small-cases scaffolding has no value without compute access.

### `benchmark/providers/openai-compat.ts`

Currently uses `TOOL_SYSTEM_PROMPT` in 3 places. All three become `systemPrompt ?? TOOL_SYSTEM_PROMPT`. Method signature gains `systemPrompt?: string`.

### `benchmark/providers/anthropic.ts`

Same parametric change as openai-compat.

## Component 4.3 — Runner passthrough

### `benchmark/runners/tool-augmented.ts`

```typescript
export async function runToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: RetryOptions,
  temperature?: number,
  systemPrompt?: string
): Promise<ToolAugmentedResult> {
  return executeWithRetry(
    () =>
      provider.runWithTools(
        problem,
        proxy.tools,
        (name, args) => proxy.callTool(name, args),
        maxTokens,
        maxTurns,
        temperature,
        systemPrompt
      ),
    retryOptions
  );
}
```

`systemPrompt` is the LAST parameter to maintain backward-compat with existing positional callers.

### `benchmark/runners/self-consistency.ts`

`voteToolAugmented` accepts and forwards `systemPrompt`:

```typescript
export async function voteToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  N: number,
  temperature: number,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: RetryOptions,
  systemPrompt?: string
): Promise<ToolAugmentedResult & { selfConsistency: SelfConsistencyData }> {
  // calls runToolAugmented N times with systemPrompt threaded through
}
```

## Component 4.4 — Per-problem dispatch in benchmark/index.ts

Inside the per-problem loop, before the tool-augmented call:

```typescript
const useOlympiadPrompt =
  config.features.includes('olympiad-prompt') &&
  datasetName.startsWith('Omni-MATH');

const systemPrompt = useOlympiadPrompt ? TOOL_PROMPT_OLYMPIAD : undefined;
```

Then both runner ternary branches forward `systemPrompt`:

```typescript
const tr = config.selfConsistency
  ? await voteToolAugmented(..., systemPrompt)
  : await runToolAugmented(..., systemPrompt);
```

When `systemPrompt` is undefined, providers fall back to their default (`TOOL_SYSTEM_PROMPT`). Zero behavior change for non-olympiad datasets or when flag is off.

## Test plan

### Unit tests

`test/olympiad-prompt.test.ts` — 3 tests covering routing logic only (the prompt content is a string constant; testing it would just duplicate it):

1. `--features=olympiad-prompt` + Omni-MATH dataset → olympiad prompt selected
2. `--features=olympiad-prompt` + CAS dataset → default prompt selected
3. No flag + Omni-MATH dataset → default prompt selected

Implementation: mock provider whose `runWithTools` captures the `systemPrompt` argument. Run the per-problem dispatch logic directly (not via the full benchmark loop) and assert.

### Integration

Existing 368 tests must continue passing without any env vars or features set. The `systemPrompt` parameter being optional preserves the v1 default exactly.

### Live ablation

Three conditions on Omni-MATH-quick (50 problems):

```bash
# Condition 1 — control (Apr 2026 baseline reproduced)
npm run olympiad:quick:zai -- --features=v2

# Condition 2 — Phase 4 olympiad prompt enabled
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt

# Condition 3 — olympiad prompt + voting (variance-stable measurement)
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt,self-consistency
```

3 runs × 50 problems × glm-5.1, ~1.5-2 hours, ~$3-8 (Condition 3 ~3× cost due to voting).

## Success metrics

| Metric | Apr 2026 | Phase 4 target | Verdict logic |
|---|---|---|---|
| Omni-MATH ≥7 +MCP | 0% | **≥6% (3 problems)** | PASS if Cond 2 ≥ 3/50; MARGINAL if 1-2; FAIL if 0 |
| "No tool call" rate | 82% | **≤40%** | Direct measure of engagement fix |
| Avg tool calls per Omni problem | 1.26 | **≥3** | Measures whether the prompt's "compute at least 3 times" rule is followed |
| Tokens per Omni problem | n/a | **≤4× MATH L4 cost** | Cost ceiling |

### Verdict scenarios

- **PASS (Cond 2 ≥ 6%):** Phase 4 succeeded. Document findings, optionally layer Phase 4.5 (per-step verify or analyze tool) for further lift.
- **MARGINAL (Cond 2 = 2-5%):** Engagement fix worked partially. Phase 4 ships, but the data shows reasoning is the next bottleneck. Phase 4.5 priority becomes "improve reasoning paths post-engagement", not "add more scaffolding".
- **FAIL (Cond 2 = 0%):** Prompt-only insufficient. Olympiad failures need fundamentally different intervention (e.g., Lean/Coq integration, dedicated olympiad-trained model, retrieval-augmented examples). Document and escalate.

## File-changes summary

### New files (1 + 1 test)

| File | Purpose | Lines |
|---|---|---|
| `test/olympiad-prompt.test.ts` | 3 unit tests for routing logic | ~80 |
| `docs/superpowers/specs/2026-05-08-phase-4-results.md` | Closing artifact (results doc skeleton, filled in post-ablation) | ~80 |

### Modified files (6)

| File | Change |
|---|---|
| `benchmark/providers/prompts.ts` | Add `TOOL_PROMPT_OLYMPIAD` constant (~60 lines of prompt text) |
| `benchmark/providers/types.ts` | `runWithTools` gains optional `systemPrompt?: string` |
| `benchmark/providers/openai-compat.ts` | 3 hardcoded prompt references → parametric |
| `benchmark/providers/anthropic.ts` | Same parametric change |
| `benchmark/runners/tool-augmented.ts` | Forwards optional `systemPrompt` |
| `benchmark/runners/self-consistency.ts` | `voteToolAugmented` forwards `systemPrompt` |
| `benchmark/index.ts` | Per-problem dispatch picks olympiad prompt when conditions met |

### Out of scope

- Per-step verification forcing (Phase 4.5 candidate)
- `analyze` tool / static lookup table (Phase 4.5 candidate)
- Subdomain-specific prompts (algebra vs geometry vs number theory)
- Different olympiad sources treated differently (Putnam vs IMO vs USAMO)
- Mandatory N=5 self-consistency (Phase 3 disproved)
- Olympiad prompt for baseline (no tools available, scaffolding has no value)

## Open questions

These resolve from live data, not a priori:

1. Does the model actually follow the "compute 3 times" rule, or is the reasoning collapse deeper than prompt instructions can fix?
2. Does the pattern-recognition table (1,2,3,4 → linear etc.) actively help or does it bias the model toward suggested patterns even when wrong?
3. Does `\boxed{}` extraction work cleanly on olympiad answers (which are often LaTeX-formatted formulas like `\lceil n/2 \rceil + 1`)?

## Phase 5+ inputs

Findings to feed forward:

- If the prompt lifts engagement but accuracy stays low → reasoning is the bottleneck, not engagement. Phase 4.5 priorities: per-step verify forcing, problem-decomposition prompts, or domain-specific scaffolds.
- If the prompt lifts both engagement AND accuracy → prompt engineering is the lever. Phase 4.5: subdomain prompts, more pattern examples, larger small-cases set.
- Per-problem failure breakdown reveals which Omni subdomains are most/least responsive to scaffolding.
- Token cost ratio: if it stays ≤4× MATH L4, the approach is Pareto-acceptable; if it exceeds, Phase 4.5 needs cost optimization.
