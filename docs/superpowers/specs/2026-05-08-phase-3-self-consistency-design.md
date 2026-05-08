# Phase 3 — Self-Consistency / N-Sample Voting (Design)

**Date:** 2026-05-08
**Status:** Approved
**Branch target:** `phase-3-self-consistency` (off `main` post-Phase-2-merge)
**Supersedes:** Section "Phase 3 — Self-Consistency" in `2026-05-07-sota-math-mcp-design.md`

## Why this revision

The original Phase 3 spec (`2026-05-07-sota-math-mcp-design.md`) proposed adaptive self-consistency: trigger N-sample voting only on hard problems (MATH L5, Omni, verify-failed). Live data from Phases 0-2 changed the priorities:

| Original assumption | Live evidence |
|---|---|
| Voting needs cost control via tier-based triggers | Phase 2 showed per-run baseline variance ±8pp, which dominates 1-2pp flag effects. **Methodology fix is now the primary value.** |
| Voting addresses olympiad accuracy | Voting alone won't move Omni-MATH ≥7 from 0% — that needs Phase 4. CAS/MATH L4-L5 are the right targets. |
| Token cost is the binding constraint | After Phase 2's $25 cost, +$9 per CAS-quick run for 3x sample is acceptable. |

This revision pivots to **always-N=3 voting on every problem**, on both baseline AND tool-augmented paths. The trade-off: ~3x token cost in exchange for stable measurement and per-problem accuracy lift simultaneously.

## Goals

- **Methodology fix:** Eliminate baseline ±8pp run-to-run variance so future ablations measure real effects, not model temperature noise.
- **Accuracy lift on hard problems:** Match literature gains (Wang et al. 2022: +5-15pp on MATH-style problems).
- **Composability:** Phase 3 stacks cleanly with Phase 0 (`v2`) and Phase 2 (`output-hygiene`, `grader-v3`) flags.
- **Reversibility:** v1 default behavior unchanged when flag is off.

## Non-goals

- Adaptive / tier-based N (deferred — keep simple, add complexity only if budget becomes binding).
- Olympiad-specific intervention (Phase 4).
- N > 3 escalation on first-attempt failure (deferred — measure first, escalate later if data warrants).
- Voting on tool-call sequences (we vote on extracted-and-normalized final answers only).

## Architecture

```
┌─ benchmark/index.ts ──────────────────────────────┐
│  --features=self-consistency →                    │
│    config.selfConsistency = { N: 3, temperature: 0.7 } │
│  Per-problem dispatch:                            │
│    if config.selfConsistency:                     │
│      voteBaseline / voteToolAugmented              │
│    else:                                          │
│      runBaseline / runToolAugmented (existing)    │
├─ benchmark/runners/self-consistency.ts ───────────┤  NEW
│  voteBaseline(...): Promise<                      │
│    BaselineResult & { selfConsistency: SCData }>  │
│  voteToolAugmented(...): Promise<                 │
│    ToolAugmentedResult & { selfConsistency: ... }>│
│  Internal: majorityVote(canonicalAnswers)         │
├─ benchmark/providers/openai-compat.ts ────────────┤  Modified
│  temperature: 0 → temperature ?? 0                │
├─ benchmark/providers/anthropic.ts ────────────────┤  Modified (if hardcoded)
│  Same parametric change as openai-compat          │
├─ benchmark/providers/types.ts ────────────────────┤  Modified
│  runBaseline / runWithTools accept                │
│  optional `temperature` parameter                 │
├─ benchmark/problem-detail.ts ─────────────────────┤  Modified
│  ProblemDetail.baseline / .toolAugmented gain     │
│  optional `selfConsistency: SCData` field         │
├─ benchmark/config.ts ─────────────────────────────┤  Modified
│  Add selfConsistency: { N, temperature } | null   │
└───────────────────────────────────────────────────┘
```

No new architecture beyond the single voting wrapper. Existing runner functions (`runBaseline`, `runToolAugmented`) are reused — voting calls them N times in series.

## Component 3.1 — Voting wrapper

### `benchmark/runners/self-consistency.ts`

Single new file. ~80 lines. Two exported functions plus an internal `majorityVote` helper.

#### Voting algorithm

Plurality vote (not strict majority). Tie-break: first sample's canonical form.

```typescript
function majorityVote(canonicalAnswers: string[]): {
  winnerIndex: number;
  winnerAnswer: string;
  votes: Record<string, number>;
} {
  const counts: Record<string, number> = {};
  canonicalAnswers.forEach((a) => {
    counts[a] = (counts[a] ?? 0) + 1;
  });

  // Find max-count answer; ties broken by first-occurrence (deterministic)
  let bestAnswer = canonicalAnswers[0];
  let bestCount = counts[bestAnswer];
  for (const [ans, count] of Object.entries(counts)) {
    if (count > bestCount) {
      bestAnswer = ans;
      bestCount = count;
    }
  }
  // Return index of FIRST sample that produced the winning answer
  const winnerIndex = canonicalAnswers.indexOf(bestAnswer);
  return { winnerIndex, winnerAnswer: bestAnswer, votes: counts };
}
```

#### Vote target

Each sample's text is processed:
1. `extractModelAnswer(sample.text)` → string (may be `\boxed{...}` content, `The answer is X`, etc.)
2. `normalize(extracted).canonical` from grader-v2 → equivalence class string

Vote on the canonical form. This means `\frac{1}{2}`, `(1)/(2)`, and `0.5` all collapse to the same equivalence class for voting purposes (Phase 0 grader handles this).

#### `voteBaseline` and `voteToolAugmented`

Both follow the same pattern:

```typescript
export async function voteToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  N: number,
  temperature: number,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: RetryOptions
): Promise<ToolAugmentedResult & { selfConsistency: SCData }> {
  const samples: ToolAugmentedResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(
      await runToolAugmented(problem, provider, proxy, maxTokens, maxTurns, temperature, retryOptions)
    );
  }
  const canonicals = samples.map((s) =>
    normalize(extractModelAnswer(s.text)).canonical
  );
  const { winnerIndex, votes } = majorityVote(canonicals);
  const winner = samples[winnerIndex];
  const agreement = (votes[canonicals[winnerIndex]] ?? 0) / N;
  return {
    ...winner,
    selfConsistency: {
      N,
      temperature,
      votes,
      winnerIndex,
      agreement,
      samples: samples.map((s) => ({
        extractedAnswer: extractModelAnswer(s.text),
      })),
    },
  };
}
```

`voteBaseline` is structurally identical, calling `runBaseline` instead of `runToolAugmented`.

#### Sequential vs parallel sampling

Samples run **sequentially** (await in a for-loop). Reasons:
- Simplifies retry logic (existing `executeWithRetry` is per-call)
- Avoids overwhelming z.ai or Anthropic API rate limits
- Per-problem latency triples but absolute time per CAS-quick problem is still ~30-60s

If parallelism becomes a binding constraint later, `Promise.all` is a one-line change.

## Component 3.2 — Provider temperature plumbing

### Problem

Both `openai-compat.ts` and `anthropic.ts` currently hardcode `temperature: 0`. With deterministic temperature, N samples produce identical outputs and voting is meaningless.

### Fix

Make `temperature` an optional parameter on `LLMProvider.runBaseline` and `LLMProvider.runWithTools`:

```typescript
// benchmark/providers/types.ts
export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number  // NEW: defaults to 0 when absent
  ): Promise<BaselineResult>;
  runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number  // NEW
  ): Promise<ToolAugmentedResult>;
}
```

Inside each provider, replace hardcoded `temperature: 0` with `temperature: temperature ?? 0`. This preserves the v1 default exactly when no temperature is passed (zero-risk addition).

### Anthropic

Anthropic's API takes `temperature` directly. Same parametric pattern.

## Component 3.3 — JSONL extension

### `benchmark/problem-detail.ts`

Add an optional `selfConsistency` field to both `baseline` and `toolAugmented` records:

```typescript
export interface SelfConsistencyData {
  N: number;
  temperature: number;
  votes: Record<string, number>;  // canonical → count
  winnerIndex: number;             // 0..N-1
  agreement: number;               // votes[winner] / N, in [0, 1]
  samples: { extractedAnswer: string }[];  // compact per-sample record
}

export interface ProblemDetail {
  // ... existing fields preserved ...
  baseline: {
    // ... existing fields ...
    selfConsistency?: SelfConsistencyData;
  };
  toolAugmented: {
    // ... existing fields ...
    selfConsistency?: SelfConsistencyData;
  };
}
```

When the flag is off, the `selfConsistency` field is absent — JSONL records are byte-for-byte unchanged.

### Report generator addition

`benchmark/report/generator.ts` gets one new section when any record has `selfConsistency` data:

```markdown
## Self-Consistency

- Configuration: N=3, temperature=0.7
- Average agreement (baseline): 0.78 (N=60 problems)
- Average agreement (tool-aug): 0.65
- Distribution of agreement levels:
  - 1.0 (unanimous, all 3 agree): 24 problems
  - 0.67 (2 of 3 agree): 28 problems
  - 0.33 (all 3 different): 8 problems
```

This reveals the voting "health" — if agreement is consistently low, the model is too random for voting to help.

## Component 3.4 — Config + flag wiring

### `benchmark/config.ts`

Add a new optional config field:

```typescript
export interface BenchmarkConfig {
  // ... existing fields ...
  selfConsistency: { N: number; temperature: number } | null;
}
```

Inside `buildConfig()`:

```typescript
const N = parseInt(process.env.AXIOM_SC_N ?? '3', 10);
const temperature = parseFloat(process.env.AXIOM_SC_TEMP ?? '0.7');
const selfConsistency = features.includes('self-consistency')
  ? { N, temperature }
  : null;
```

`AXIOM_SC_N` and `AXIOM_SC_TEMP` env vars provide override knobs without code changes — useful for ablation experiments (e.g., `AXIOM_SC_N=5 npm run cas:quick:zai -- --features=self-consistency`).

### `benchmark/index.ts`

Per-problem dispatch becomes flag-conditional:

```typescript
let baselineResult: BaselineResult & { selfConsistency?: SelfConsistencyData };
if (config.selfConsistency) {
  baselineResult = await voteBaseline(
    problem, provider,
    config.selfConsistency.N,
    config.selfConsistency.temperature,
    config.maxTokens,
    config.retryOptions
  );
} else {
  baselineResult = await runBaseline(problem, provider, config.maxTokens, config.retryOptions);
}
// ... similar for toolAugmented ...
```

Same env-var passthrough as Phase 1's mcp-proxy fix means the spawned MCP server inherits any env vars (no separate env-set needed for self-consistency since voting happens in the runner, not the server).

## Success metrics

### Accuracy lift (literature target)

Compared to current main baseline (single-shot, `--features=v2`):

| Metric | Now (live) | Phase 3 target |
|---|---|---|
| CAS-quick `+MCP` | 71.7% | **76-82%** |
| MATH L4-quick | 62% (Apr 8) | 67-72% |
| MATH L5-quick | 52% (Apr 8) | 58-65% |
| GSM8K (ceiling) | 98% | 98-99% |
| Tokens-per-correct | 1.0× control | ≤3.5× control |

### Variance reduction (methodology fix)

Compared to Phase 2's run-to-run baseline variance:

| Metric | Phase 2 (single-shot) | Phase 3 target (N=3) |
|---|---|---|
| Baseline run-to-run swing on CAS-quick | ±8pp (50-58%) | **≤±2pp** |
| Average voting agreement | n/a | **≥0.6** |
| Same-condition repeatability (run twice → max diff) | not measured | ≤2pp |

If average agreement is < 0.5 (i.e., majority of problems show all-different answers), voting is not converging. This is a Phase 3.5 signal — model is too random; investigate prompt or temperature.

### Phase 2 re-measurement (optional bonus)

After Phase 3 ships, optionally re-run Phase 2's 5-condition ablation with self-consistency stacked. Cost: ~$120. Expected: cleaner per-flag deltas with smaller error bars. Not required for Phase 3 success — just a follow-up if budget allows.

## Test plan

### Unit tests

- `majorityVote`:
  - all-same: `['A', 'A', 'A']` → winner='A', votes={A:3}, index=0
  - 2-1 split: `['A', 'B', 'A']` → winner='A', votes={A:2, B:1}, index=0 (first occurrence)
  - all-different: `['A', 'B', 'C']` → winner='A' (tie-break: first), votes={A:1, B:1, C:1}, index=0
  - empty input: throws or returns sentinel (decide during impl)
- `voteBaseline` with mocked provider returning preset 3 samples — verify samples preserved, winner correct, agreement computed.
- `voteToolAugmented` with mocked provider+proxy — same.
- ProblemDetail extension: serialize/deserialize JSONL with selfConsistency populated; round-trip equal.

### Integration tests

- Smoke: real provider (zai), small problem (`2+3`), N=3, temperature=0.7. Verify all 3 samples ran, voting succeeded, JSONL has selfConsistency block.
- Verify when `--features=self-consistency` is OFF, JSONL records have NO selfConsistency field (byte-for-byte unchanged).

### Live ablation

Two runs, sequential:
1. `npm run cas:quick:zai -- --features=v2` (control — current baseline; or reuse the existing run from 2026-05-08-01-04-22)
2. `npm run cas:quick:zai -- --features=v2,self-consistency` (Phase 3)

Cost: ~$3 control + ~$9 Phase 3 = ~$12. Single run reveals accuracy delta.

For variance measurement: run Phase 3 twice and compare. If both runs land within 2pp, methodology fix succeeded.

### Regression test

After Phase 3 implementation, run **all existing tests** (350+ unit + integration). All must pass without setting any env vars or features. Default behavior must be byte-for-byte identical to pre-Phase-3.

## File changes summary

### New files (2)

| File | Lines (approx) | Responsibility |
|---|---|---|
| `benchmark/runners/self-consistency.ts` | ~80 | Voting wrapper with `voteBaseline`, `voteToolAugmented`, internal `majorityVote` |
| `test/self-consistency.test.ts` | ~80 | Unit + smoke tests for the voting wrapper |

### Modified files (6)

| File | Change |
|---|---|
| `benchmark/config.ts` | `selfConsistency: { N, temperature } \| null` field; `--features=self-consistency` parsing; `AXIOM_SC_N` and `AXIOM_SC_TEMP` env-var overrides |
| `benchmark/index.ts` | Per-problem dispatch swaps `runBaseline` ↔ `voteBaseline` and `runToolAugmented` ↔ `voteToolAugmented` based on `config.selfConsistency` |
| `benchmark/providers/types.ts` | `runBaseline` and `runWithTools` signatures accept optional `temperature: number` |
| `benchmark/providers/openai-compat.ts` | `temperature: 0` → `temperature ?? 0` (parametric) |
| `benchmark/providers/anthropic.ts` | Same parametric change (if hardcoded) |
| `benchmark/problem-detail.ts` | Add `SelfConsistencyData` interface; `selfConsistency?` field on baseline/toolAugmented sub-records |
| `benchmark/report/generator.ts` | Add Self-Consistency section to per-run markdown report when data is present |

## Out of scope

- Tier-based N (defer — measure flat N=3 first)
- N>3 escalation
- Olympiad-specific prompt
- Anthropic-side voting if user is using zai (it'll work, but only zai is tested in live ablation)
- Self-consistency on tool-call sequences themselves (only final-answer voting)

## Phase 4+ inputs

Findings to feed forward:

- If average agreement is high (≥0.7) → model is coherent; future work focuses on accuracy ceiling
- If average agreement is low (~0.4-0.5) → model is noisy on these problems; consider prompt experiments or different sampling temperatures
- Agreement vs. correctness correlation: do unanimous problems get higher accuracy than 2-of-3 problems? (Expected yes; quantify the relationship)
- Per-problem record of which answers tied/lost reveals systematic confusion patterns (Phase 4 olympiad work could exploit these)
