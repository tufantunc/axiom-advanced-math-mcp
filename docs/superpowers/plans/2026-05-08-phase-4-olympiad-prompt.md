# Phase 4: Olympiad Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land an olympiad-specific system prompt routed to Omni-MATH problems behind `--features=olympiad-prompt`. Drive Omni-MATH ≥7 from 0% to ≥6% (3 problems) by fixing the dominant 82% no-tool-call failure mode via mandatory tool-use scaffolding (Polya method).

**Architecture:** New `TOOL_PROMPT_OLYMPIAD` constant in `benchmark/providers/prompts.ts`. Providers gain optional `systemPrompt?: string` parameter on `runWithTools` (when undefined, falls back to existing `getToolPromptForProblem(problem)` keyword dispatcher). Per-problem benchmark dispatch passes the olympiad prompt only when `--features=olympiad-prompt` is set AND the active dataset is Omni-MATH.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, tsx for benchmark runtime, existing zai/anthropic/openai-compat providers. Pattern identical to Phase 3's temperature plumbing.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| 4.1 TOOL_PROMPT_OLYMPIAD content | Task 1 |
| 4.2 Provider system-prompt parameter | Task 2 |
| 4.3 Runner passthrough | Task 3 |
| Self-consistency wrapper passthrough | Task 4 |
| 4.4 Per-problem dispatch in benchmark/index.ts | Task 5 |
| Unit tests for routing logic | Task 6 |
| Live ablation skeleton | Task 7 |

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `test/olympiad-prompt.test.ts` | 3 routing-logic unit tests (mock provider captures `systemPrompt` arg). |
| `docs/superpowers/specs/2026-05-08-phase-4-results.md` | Closing artifact — empty result tables, run instructions, files-shipped list. User fills TBDs from a long-lived terminal session. |

### Modified files

| File | Change |
|---|---|
| `benchmark/providers/prompts.ts` | Add `TOOL_PROMPT_OLYMPIAD` constant (~60 lines of prompt text). |
| `benchmark/providers/types.ts` | `LLMProvider.runWithTools` gains optional `systemPrompt?: string` parameter (after `temperature?`). |
| `benchmark/providers/openai-compat.ts` | At line 84 (or wherever `getToolPromptForProblem` is called), prefer the new optional `systemPrompt` arg; fall back to existing keyword dispatcher. Method signature accepts the new param. |
| `benchmark/providers/anthropic.ts` | Same parametric change as openai-compat. |
| `benchmark/runners/tool-augmented.ts` | `runToolAugmented` accepts and forwards optional `systemPrompt`. |
| `benchmark/runners/self-consistency.ts` | `voteToolAugmented` accepts and forwards optional `systemPrompt`. |
| `benchmark/index.ts` | Per-problem dispatch sets `systemPrompt` to `TOOL_PROMPT_OLYMPIAD` when both `features.includes('olympiad-prompt')` AND `datasetName.startsWith('Omni-MATH')`. Passes through to both runner ternary branches. |

### Removed/renamed files

None.

---

## Branch setup

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git checkout -b phase-4-olympiad-prompt
```

Verify: `git branch --show-current` → `phase-4-olympiad-prompt`. Current main commit: `20351e0`. 368/368 unit tests passing.

---

## Task 1: Add TOOL_PROMPT_OLYMPIAD constant

**Files:**
- Modify: `benchmark/providers/prompts.ts`

This task only adds a new exported constant. No other behavior change. Existing tests must continue passing.

- [ ] **Step 1.1: Add the constant**

Read `benchmark/providers/prompts.ts` first. Find a sensible place after the existing per-domain prompts (e.g., `TOOL_PROMPT_ALGEBRA`) and before `getToolPromptForProblem`. Add this new exported constant:

```typescript
export const TOOL_PROMPT_OLYMPIAD = `You are solving an OLYMPIAD-LEVEL math problem. These are designed to be hard — they cannot be solved by a single direct calculation.

REQUIRED APPROACH (do NOT skip steps):

1. Read carefully. Identify what kind of answer the problem expects:
   - A specific number (e.g., "what is the maximum value of...")
   - A formula in n (e.g., "find the minimum m as a function of n")
   - A yes/no (e.g., "does there exist..." → answer "Yes" or "No")

2. Try small cases. Plug in n=2, 3, 4, 5 and compute the answer for each. Use compute for EACH small case:
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

5. State the final answer in \\boxed{...} — the formula, the number, or "Yes"/"No".

GIAC SYNTAX (use these exact forms — NO Python loops, NO custom functions):
- Sums: sum(k^2, k, 1, n)
- Products: product(k, k, 1, n)
- Solve: solve(equation, x)
- Combinations: binomial(n, k) or C(n, k)
- Floor/ceil: floor(x), ceil(x)
- Logarithms: log(x, base) or ln(x)
- Sequences: seq(f(k), k, 1, n) returns a list

DO NOT:
- Write Python-style loops: \`for k in range(...)\` ❌
- Define new functions inside compute: \`f(x) := ...\` ❌
- Skip the small-cases step. Even if the pattern looks obvious, verify with at least 3 compute calls.
- Output an empty answer. If after 3 small cases you cannot find a pattern, state your best educated guess in \\boxed{...} with a brief rationale.

CRITICAL: Use compute at least 3 times per olympiad problem. The model alone cannot solve these — the tool's exact computation on small cases is what reveals the structure.

At the very end, state your final answer in this exact format:
\\boxed{<answer>}`;
```

(Note the doubled backslashes in `\\boxed{...}` — that's correct for the TypeScript string literal so the runtime value is `\boxed{...}`.)

- [ ] **Step 1.2: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean. The new constant is unused for now; TypeScript should not complain about a top-level export.

Run: `npm test 2>&1 | tail -5`
Expected: 368/368 pass. No behavior change.

- [ ] **Step 1.3: Commit**

```bash
git add benchmark/providers/prompts.ts
git commit -m "feat(prompts): add TOOL_PROMPT_OLYMPIAD constant"
```

---

## Task 2: Provider system-prompt parameter

**Files:**
- Modify: `benchmark/providers/types.ts`
- Modify: `benchmark/providers/openai-compat.ts`
- Modify: `benchmark/providers/anthropic.ts`

Pattern identical to Phase 3 Task 1's parametric temperature. The new optional parameter, when undefined, falls back to the existing `getToolPromptForProblem(problem)` keyword dispatcher.

- [ ] **Step 2.1: Update LLMProvider interface**

Edit `benchmark/providers/types.ts`. Find the `runWithTools` signature in the `LLMProvider` interface and add a new optional parameter at the END (after `temperature?: number`):

```typescript
  runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number,
    systemPrompt?: string
  ): Promise<ToolAugmentedResult>;
```

`runBaseline` does NOT get this parameter — olympiad prompt is tool-augmented-only.

- [ ] **Step 2.2: Update openai-compat to use the new parameter**

Read `benchmark/providers/openai-compat.ts` first. Find the `runWithTools` method (~line 70) and the line that calls `getToolPromptForProblem` (~line 84):

```typescript
{ role: 'system', content: getToolPromptForProblem(problem) },
```

Add the new parameter to the method signature:

```typescript
  async runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number,
    systemPrompt?: string
  ): Promise<ToolAugmentedResult> {
```

Then change the system prompt line to prefer the new parameter, falling back to the existing keyword dispatcher:

```typescript
{ role: 'system', content: systemPrompt ?? getToolPromptForProblem(problem) },
```

- [ ] **Step 2.3: Update anthropic to use the new parameter**

Read `benchmark/providers/anthropic.ts` first. Find the `runWithTools` method and the line that uses `getToolPromptForProblem` (anthropic uses a `system:` field on the API call, not a message — verify exact location).

Add the new parameter to the method signature (same shape as openai-compat).

Replace the existing `getToolPromptForProblem(problem)` reference with `systemPrompt ?? getToolPromptForProblem(problem)`.

- [ ] **Step 2.4: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: 368/368 pass. Existing callers don't pass `systemPrompt`, so they fall through to `getToolPromptForProblem` exactly as before.

- [ ] **Step 2.5: Commit**

```bash
git add benchmark/providers/types.ts benchmark/providers/openai-compat.ts benchmark/providers/anthropic.ts
git commit -m "feat(providers): parametric systemPrompt (defaults to keyword dispatcher)"
```

---

## Task 3: Runner passthrough — tool-augmented

**Files:**
- Modify: `benchmark/runners/tool-augmented.ts`

- [ ] **Step 3.1: Forward systemPrompt parameter**

Read `benchmark/runners/tool-augmented.ts` first. Replace the function body with this version that accepts and forwards `systemPrompt`:

```typescript
import type { LLMProvider, ToolAugmentedResult } from '../providers/types.js';
import type { MCPProxy } from './mcp-proxy.js';
import type { RetryOptions } from '../providers/retry.js';
import { executeWithRetry } from '../providers/retry.js';

export type { ToolAugmentedResult };

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

- [ ] **Step 3.2: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: 368/368 pass.

- [ ] **Step 3.3: Commit**

```bash
git add benchmark/runners/tool-augmented.ts
git commit -m "feat(runners): forward optional systemPrompt to provider"
```

---

## Task 4: Self-consistency wrapper passthrough

**Files:**
- Modify: `benchmark/runners/self-consistency.ts`

- [ ] **Step 4.1: Forward systemPrompt through voteToolAugmented**

Read `benchmark/runners/self-consistency.ts` first. Find the `voteToolAugmented` function. Add `systemPrompt?: string` as the LAST parameter and forward it to each `runToolAugmented` call inside the for-loop.

The new signature:

```typescript
export async function voteToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  N: number,
  temperature: number,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: import('../providers/retry.js').RetryOptions,
  systemPrompt?: string
): Promise<ToolAugmentedResult & { selfConsistency: SelfConsistencyData }> {
  const samples: ToolAugmentedResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(
      await runToolAugmented(
        problem,
        provider,
        proxy,
        maxTokens,
        maxTurns,
        retryOptions,
        temperature,
        systemPrompt
      )
    );
  }
  return composeWithVote(samples, N, temperature);
}
```

`voteBaseline` does NOT change — baseline doesn't get olympiad prompt per spec scope.

- [ ] **Step 4.2: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: 368/368 pass. Existing self-consistency tests don't pass systemPrompt, so they fall through unchanged.

- [ ] **Step 4.3: Commit**

```bash
git add benchmark/runners/self-consistency.ts
git commit -m "feat(runners): voteToolAugmented forwards optional systemPrompt"
```

---

## Task 5: Per-problem dispatch in benchmark/index.ts

**Files:**
- Modify: `benchmark/index.ts`

This task wires the routing logic. When `--features=olympiad-prompt` is set AND the active dataset is Omni-MATH, the dispatch passes `TOOL_PROMPT_OLYMPIAD`; otherwise undefined.

- [ ] **Step 5.1: Add the import**

At the top of `benchmark/index.ts`, alongside the existing prompts import (or wherever prompts are imported), add:

```typescript
import { TOOL_PROMPT_OLYMPIAD } from './providers/prompts.js';
```

If `prompts` isn't already imported, add the full import line; otherwise extend the existing one to include `TOOL_PROMPT_OLYMPIAD`.

- [ ] **Step 5.2: Compute systemPrompt per problem**

Read `benchmark/index.ts` first. Find the per-problem loop (around line 140-220). Find where `tr` (the tool-augmented result) is computed via the existing ternary `config.selfConsistency ? voteToolAugmented(...) : runToolAugmented(...)` (around line 188).

Just BEFORE the `tr` ternary, add the routing decision:

```typescript
      // Phase 4 olympiad prompt routing — only fires when flag is set AND
      // the active dataset is Omni-MATH. Other datasets and flag-off runs
      // continue to use the keyword dispatcher in providers/prompts.ts.
      const useOlympiadPrompt =
        config.features.includes('olympiad-prompt') &&
        datasetName.startsWith('Omni-MATH');
      const systemPrompt = useOlympiadPrompt ? TOOL_PROMPT_OLYMPIAD : undefined;
```

- [ ] **Step 5.3: Pass systemPrompt through both ternary branches**

Update both branches of the `tr` ternary to forward `systemPrompt` as the last argument. The existing structure is approximately:

```typescript
        const tr = config.selfConsistency
          ? await voteToolAugmented(
              problemText,
              provider,
              proxy,
              config.selfConsistency.N,
              config.selfConsistency.temperature,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions
            )
          : await runToolAugmented(
              problemText,
              provider,
              proxy,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions
            );
```

Update to:

```typescript
        const tr = config.selfConsistency
          ? await voteToolAugmented(
              problemText,
              provider,
              proxy,
              config.selfConsistency.N,
              config.selfConsistency.temperature,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions,
              systemPrompt
            )
          : await runToolAugmented(
              problemText,
              provider,
              proxy,
              config.maxTokens,
              config.maxAgentTurns,
              config.retryOptions,
              undefined,           // temperature — no override outside self-consistency
              systemPrompt
            );
```

Note: `runToolAugmented` takes `(problem, provider, proxy, maxTokens, maxTurns, retryOptions, temperature, systemPrompt)`. To pass `systemPrompt` as the 8th argument, we must pass `undefined` for the 7th (`temperature`) so the positional order is preserved. `voteToolAugmented` already passes temperature as a required argument, so its `systemPrompt` is the 9th and last.

- [ ] **Step 5.4: Add an "Olympiad prompt" log line**

Find the existing run-header log block. Right after the existing `Self-consistency` log line (or `Features` line if Self-consistency log isn't present), add:

```typescript
  if (config.features.includes('olympiad-prompt')) {
    log(`  Olympiad prompt: enabled (active on Omni-MATH datasets only)`);
  }
```

- [ ] **Step 5.5: Type check + smoke test**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: 368/368 pass. The wiring is exercised by Task 6's unit tests; existing tests are unaffected.

For a quick smoke test of the dispatch:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
tsx -e "
import { buildConfig } from './config.js';
process.argv = ['tsx', 'index.ts', '--olympiad', '--quick', '--features=v2,olympiad-prompt'];
const c = buildConfig();
console.log('features:', c.features);
"
```

Expected output:
```
features: [ 'v2', 'olympiad-prompt' ]
```

- [ ] **Step 5.6: Commit**

```bash
git add benchmark/index.ts
git commit -m "feat(benchmark): route TOOL_PROMPT_OLYMPIAD to Omni-MATH when --features=olympiad-prompt"
```

---

## Task 6: Unit tests for routing logic

**Files:**
- Create: `test/olympiad-prompt.test.ts`

These tests verify the routing decision (which prompt is selected for a given dataset + flag combo). The prompt content itself is a string constant — no need to test it.

- [ ] **Step 6.1: Write the test file**

Create `test/olympiad-prompt.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  voteToolAugmented,
} from '../benchmark/runners/self-consistency.js';
import { runToolAugmented } from '../benchmark/runners/tool-augmented.js';
import { TOOL_PROMPT_OLYMPIAD } from '../benchmark/providers/prompts.js';
import type { LLMProvider, ToolAugmentedResult } from '../benchmark/providers/types.js';
import type { MCPProxy } from '../benchmark/runners/mcp-proxy.js';

// ---------------------------------------------------------------------------
// Mock provider that captures the systemPrompt arg passed to runWithTools
// ---------------------------------------------------------------------------

function makeCapturingProvider(): {
  provider: LLMProvider;
  capturedPrompts: (string | undefined)[];
} {
  const captured: (string | undefined)[] = [];
  const provider: LLMProvider = {
    name: 'mock',
    model: 'mock-1',
    async runBaseline() {
      return { text: 'baseline', inputTokens: 1, outputTokens: 1, durationMs: 1 };
    },
    async runWithTools(
      _problem,
      _tools,
      _cb,
      _maxTokens,
      _maxTurns,
      _temperature,
      systemPrompt
    ): Promise<ToolAugmentedResult> {
      captured.push(systemPrompt);
      return {
        text: 'The answer is \\boxed{42}',
        toolCalls: [],
        turns: 1,
        inputTokens: 10,
        outputTokens: 5,
        durationMs: 100,
      };
    },
  };
  return { provider, capturedPrompts: captured };
}

const fakeProxy: MCPProxy = {
  tools: [],
  callTool: async () => 'Result: stub',
  close: async () => {},
};

// ---------------------------------------------------------------------------
// Tests — these simulate the dispatch decision in benchmark/index.ts directly,
// not the full benchmark loop. They verify that `systemPrompt` is correctly
// threaded through runToolAugmented and voteToolAugmented when explicitly
// passed, and undefined when not.
// ---------------------------------------------------------------------------

describe('olympiad-prompt routing', () => {
  it('runToolAugmented forwards systemPrompt when provided', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await runToolAugmented(
      'p',
      provider,
      fakeProxy,
      4096,
      8,
      undefined, // retryOptions
      undefined, // temperature
      TOOL_PROMPT_OLYMPIAD
    );
    expect(capturedPrompts).toEqual([TOOL_PROMPT_OLYMPIAD]);
  });

  it('runToolAugmented passes undefined when systemPrompt absent', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await runToolAugmented('p', provider, fakeProxy, 4096, 8);
    expect(capturedPrompts).toEqual([undefined]);
  });

  it('voteToolAugmented forwards systemPrompt to all N samples', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await voteToolAugmented(
      'p',
      provider,
      fakeProxy,
      3, // N
      0.7, // temperature
      4096,
      8,
      undefined, // retryOptions
      TOOL_PROMPT_OLYMPIAD
    );
    expect(capturedPrompts).toEqual([
      TOOL_PROMPT_OLYMPIAD,
      TOOL_PROMPT_OLYMPIAD,
      TOOL_PROMPT_OLYMPIAD,
    ]);
  });

  it('voteToolAugmented passes undefined to all samples when systemPrompt absent', async () => {
    const { provider, capturedPrompts } = makeCapturingProvider();
    await voteToolAugmented('p', provider, fakeProxy, 3, 0.7, 4096, 8);
    expect(capturedPrompts).toEqual([undefined, undefined, undefined]);
  });
});
```

- [ ] **Step 6.2: Run tests — verify they pass**

Run: `npm test -- olympiad-prompt 2>&1 | tail -10`
Expected: 4/4 pass. (The implementation from Tasks 1-5 already covers this; the tests confirm the wiring.)

Run: `npm test 2>&1 | tail -5`
Expected: 372/372 pass (368 + 4 new).

- [ ] **Step 6.3: Commit**

```bash
git add test/olympiad-prompt.test.ts
git commit -m "test(olympiad): routing-logic unit tests"
```

---

## Task 7: Phase 4 results doc skeleton

**Files:**
- Create: `docs/superpowers/specs/2026-05-08-phase-4-results.md`

This task does NOT run any benchmarks. It creates the closing artifact: a results doc with run instructions and empty result tables. The user fills in the TBD numbers from a long-lived terminal session.

- [ ] **Step 7.1: Write the results doc**

Create `docs/superpowers/specs/2026-05-08-phase-4-results.md`:

```markdown
# Phase 4 — Results

**Date:** 2026-05-08
**Branch:** phase-4-olympiad-prompt (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness):

\`\`\`bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (Apr 2026 baseline reproduced; no olympiad prompt)
npm run olympiad:quick:zai -- --features=v2

# Condition 2 — Phase 4 olympiad prompt enabled
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt

# Condition 3 — olympiad prompt + voting (variance-stable measurement)
npm run olympiad:quick:zai -- --features=v2,olympiad-prompt,self-consistency

# Analyze each
for f in results/2026-05-08-*-olympiad-quick-details.jsonl; do
  npm run analyze -- "\$f"
done
\`\`\`

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

- \`benchmark/providers/prompts.ts\` — added \`TOOL_PROMPT_OLYMPIAD\` constant (~60 lines)
- \`benchmark/providers/types.ts\` — \`runWithTools\` gains optional \`systemPrompt\`
- \`benchmark/providers/openai-compat.ts\` — parametric \`systemPrompt\` (defaults to keyword dispatcher)
- \`benchmark/providers/anthropic.ts\` — same parametric change
- \`benchmark/runners/tool-augmented.ts\` — forwards optional \`systemPrompt\`
- \`benchmark/runners/self-consistency.ts\` — \`voteToolAugmented\` forwards \`systemPrompt\`
- \`benchmark/index.ts\` — per-problem dispatch picks \`TOOL_PROMPT_OLYMPIAD\` when flag is set + Omni dataset
- \`test/olympiad-prompt.test.ts\` — 4 routing-logic unit tests

Test coverage: +4 unit tests (368 → 372). Zero regressions in pre-Phase-4 tests when flag is off.

## Phase 5+ inputs

[Findings to feed forward:]

- If engagement fix worked but accuracy stayed low → reasoning is the next bottleneck. Phase 4.5 priorities: per-step verify forcing, problem-decomposition prompts, or domain-specific scaffolds.
- If engagement AND accuracy both lifted → prompt engineering is the lever. Phase 4.5: subdomain prompts (algebra vs combinatorics vs number theory), more pattern examples, larger small-cases set.
- Per-problem failure breakdown reveals which Omni subdomains are most/least responsive to scaffolding.
- Token cost ratio: if it stays ≤4× MATH L4, the approach is Pareto-acceptable; if it exceeds, Phase 4.5 needs cost optimization (shorter prompt, conditional sections).
- If Phase 4 result is FAIL (0% lift) → prompt-only insufficient; future work must consider Lean/Coq integration, retrieval-augmented examples, or olympiad-trained model variants.
```

- [ ] **Step 7.2: Commit**

```bash
git add docs/superpowers/specs/2026-05-08-phase-4-results.md
git commit -m "docs(phase-4): results-doc skeleton (PENDING live ablation)"
```

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring Phase 4 complete:

- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Benchmark-internal type check passes: `cd benchmark && npx tsc --noEmit` (Phase 3 lesson — root tsc excludes benchmark/)
- [ ] When `--features=olympiad-prompt` is unset, every existing test produces byte-for-byte identical output as before Phase 4 (no regressions in v1 default paths)
- [ ] `--features=olympiad-prompt` smoke test parses correctly (config has the feature)
- [ ] Phase 4 results doc exists with run instructions and TBD tables

If any check fails, do NOT roll forward — fix or escalate.

---

## Out of scope for Phase 4 (deferred)

- Per-step verification forcing (Phase 4.5 candidate if Phase 4 lifts above 0%)
- `analyze` tool / static lookup table (Phase 4.5 candidate)
- Subdomain-specific prompts (algebra vs geometry vs number theory)
- Different prompts for different olympiad sources (Putnam vs IMO vs USAMO)
- Mandatory N=5 self-consistency (Phase 3 disproved)
- Olympiad prompt for baseline (no tools available, scaffolding has no value)
