# Phase 3: Self-Consistency / N-Sample Voting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land always-N=3 self-consistency voting on both baseline and tool-augmented benchmark paths behind `--features=self-consistency`. Cleanly preserve v1 default behavior when flag is off.

**Architecture:** A single new voting wrapper (`benchmark/runners/self-consistency.ts`) calls existing runners N times in series with `temperature=0.7`, then majority-votes on grader-v2-normalized canonical answers. Provider `temperature` parameter is plumbed parametrically (currently hardcoded to 0). Voting metadata is written to the existing JSONL detail format under a new optional `selfConsistency` field.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, tsx for benchmark runtime, existing zai/anthropic/openai-compat providers.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| 3.1 Voting wrapper (majorityVote, voteBaseline, voteToolAugmented) | Task 3 |
| 3.2 Provider temperature plumbing | Tasks 1, 2 |
| 3.3 JSONL extension (SelfConsistencyData) | Task 5 |
| 3.4 Config + flag wiring | Task 4 |
| Per-problem dispatch (benchmark/index.ts swap) | Task 6 |
| Report generator addition | Task 7 |
| Live ablation skeleton | Task 8 |

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `benchmark/runners/self-consistency.ts` | Internal `majorityVote`, exported `voteBaseline` and `voteToolAugmented` wrappers. ~80 lines, pure-functional except for the calls into the existing runners. |
| `test/self-consistency.test.ts` | Unit tests for `majorityVote` (tie cases, all-same, all-different) and the two voting wrappers (mocked provider returning preset N samples). |
| `docs/superpowers/specs/2026-05-08-phase-3-results.md` | Closing artifact — empty result tables + run instructions + files-shipped list. User fills in TBDs from a long-lived terminal session (Phase 1 lesson). |

### Modified files

| File | Change |
|---|---|
| `benchmark/providers/types.ts` | `LLMProvider.runBaseline` and `runWithTools` gain optional `temperature?: number` parameter (defaults to 0 in implementations). |
| `benchmark/providers/openai-compat.ts` | Three hardcoded `temperature: 0` lines become `temperature: temperature ?? 0`. |
| `benchmark/providers/anthropic.ts` | Same parametric change as openai-compat. |
| `benchmark/runners/baseline.ts` | `runBaseline` accepts and forwards optional `temperature`. |
| `benchmark/runners/tool-augmented.ts` | `runToolAugmented` accepts and forwards optional `temperature`. |
| `benchmark/config.ts` | Add `selfConsistency: { N: number; temperature: number } \| null` field; parse from `--features=self-consistency` + `AXIOM_SC_N`/`AXIOM_SC_TEMP` env-var overrides. |
| `benchmark/index.ts` | Per-problem dispatch becomes flag-conditional (`runBaseline` ↔ `voteBaseline`, `runToolAugmented` ↔ `voteToolAugmented`). Populate `detail.baseline.selfConsistency` and `detail.toolAugmented.selfConsistency` when present. |
| `benchmark/problem-detail.ts` | Add `SelfConsistencyData` interface; `selfConsistency?` field on baseline/toolAugmented sub-records. |
| `benchmark/report/generator.ts` | When any record has `selfConsistency` data, emit a "Self-Consistency" section in the run report with N, temperature, and average agreement. |

### Removed/renamed files

None.

---

## Branch setup

This plan starts on a fresh feature branch off main:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git checkout -b phase-3-self-consistency
```

Verify: `git branch --show-current` → `phase-3-self-consistency`.

Current main commit: `9aefc92` (Phase 3 design doc). 355/355 unit tests passing.

---

## Task 1: Provider temperature plumbing — types + openai-compat + anthropic

**Files:**
- Modify: `benchmark/providers/types.ts`
- Modify: `benchmark/providers/openai-compat.ts`
- Modify: `benchmark/providers/anthropic.ts`

This task only touches provider sources — no runner changes yet, no behavior change without a temperature argument. Existing tests must continue passing because all current callers pass no temperature, which falls back to the historical `0`.

- [ ] **Step 1.1: Update LLMProvider interface signatures**

Edit `benchmark/providers/types.ts`. Replace the `LLMProvider` interface body:

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
    temperature?: number
  ): Promise<ToolAugmentedResult>;
}
```

- [ ] **Step 1.2: Make openai-compat parametric**

Edit `benchmark/providers/openai-compat.ts`. Find every line that reads `temperature: 0,` (per the grep earlier there are exactly three: at lines 44, 93, and 141 — verify before editing).

For each `temperature: 0,` occurrence, change to `temperature: temperature ?? 0,`.

You also need to thread the new optional parameter into the `runBaseline` and `runWithTools` method signatures. The class currently exports a class implementing `LLMProvider`. Find both methods and add the optional parameter to their signatures:

For `runBaseline`:
```typescript
  async runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult> {
```

For `runWithTools`:
```typescript
  async runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number
  ): Promise<ToolAugmentedResult> {
```

Then the body's `temperature: 0,` lines become `temperature: temperature ?? 0,` and the `temperature` value flows through.

- [ ] **Step 1.3: Make anthropic parametric**

Edit `benchmark/providers/anthropic.ts` with the same pattern. Per the grep there are three `temperature: 0,` lines (at lines 27, 72, 131). Apply the same parametric change.

Method signatures get the same optional parameter additions:
```typescript
  async runBaseline(
    problem: string,
    maxTokens: number,
    temperature?: number
  ): Promise<BaselineResult> {
```

```typescript
  async runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number
  ): Promise<ToolAugmentedResult> {
```

Body `temperature: 0,` → `temperature: temperature ?? 0,`.

- [ ] **Step 1.4: Type check**

Run: `npm run typecheck 2>&1 | tail -5`
Expected: clean (zero errors). The optional parameter is backwards-compatible — all existing callers continue to compile.

- [ ] **Step 1.5: Run full test suite**

Run: `npm test 2>&1 | tail -5`
Expected: 355/355 pass. Existing tests don't pass `temperature`, so the fallback `?? 0` keeps behavior identical.

- [ ] **Step 1.6: Commit**

```bash
git add benchmark/providers/types.ts benchmark/providers/openai-compat.ts benchmark/providers/anthropic.ts
git commit -m "feat(providers): parametric temperature (defaults to 0)"
```

---

## Task 2: Runner temperature passthrough

**Files:**
- Modify: `benchmark/runners/baseline.ts`
- Modify: `benchmark/runners/tool-augmented.ts`

The runners are thin wrappers that retry. They need to accept and forward `temperature`.

- [ ] **Step 2.1: Update runBaseline**

Read `benchmark/runners/baseline.ts` first. Replace the function body:

```typescript
import type { LLMProvider, BaselineResult } from '../providers/types.js';
import type { RetryOptions } from '../providers/retry.js';
import { executeWithRetry } from '../providers/retry.js';

export type { BaselineResult };

export async function runBaseline(
  problem: string,
  provider: LLMProvider,
  maxTokens: number,
  retryOptions?: RetryOptions,
  temperature?: number
): Promise<BaselineResult> {
  return executeWithRetry(
    () => provider.runBaseline(problem, maxTokens, temperature),
    retryOptions
  );
}
```

(The `temperature` parameter goes after `retryOptions` because existing call sites pass `retryOptions` as the 4th arg — adding `temperature` before it would silently shift positional arguments.)

- [ ] **Step 2.2: Update runToolAugmented**

Read `benchmark/runners/tool-augmented.ts` first. Replace the function body:

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
  temperature?: number
): Promise<ToolAugmentedResult> {
  return executeWithRetry(
    () =>
      provider.runWithTools(
        problem,
        proxy.tools,
        (name, args) => proxy.callTool(name, args),
        maxTokens,
        maxTurns,
        temperature
      ),
    retryOptions
  );
}
```

- [ ] **Step 2.3: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: 355/355 pass.

- [ ] **Step 2.4: Commit**

```bash
git add benchmark/runners/baseline.ts benchmark/runners/tool-augmented.ts
git commit -m "feat(runners): forward optional temperature to providers"
```

---

## Task 3: majorityVote + voting wrapper module

**Files:**
- Create: `benchmark/runners/self-consistency.ts`
- Test: `test/self-consistency.test.ts`

This is the core of Phase 3. Pure-function `majorityVote` plus two voting wrappers around the runners.

- [ ] **Step 3.1: Write failing tests**

Create `test/self-consistency.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import {
  majorityVote,
  voteBaseline,
  voteToolAugmented,
} from '../benchmark/runners/self-consistency.js';
import type { LLMProvider, BaselineResult, ToolAugmentedResult } from '../benchmark/providers/types.js';
import type { MCPProxy } from '../benchmark/runners/mcp-proxy.js';

describe('majorityVote', () => {
  it('all-same: winner is unanimous', () => {
    const r = majorityVote(['3*x^2', '3*x^2', '3*x^2']);
    expect(r.winnerAnswer).toBe('3*x^2');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ '3*x^2': 3 });
  });

  it('2-1 split: majority wins, winnerIndex is first occurrence of winner', () => {
    const r = majorityVote(['A', 'B', 'A']);
    expect(r.winnerAnswer).toBe('A');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ A: 2, B: 1 });
  });

  it('all-different: tie-break by first occurrence', () => {
    const r = majorityVote(['A', 'B', 'C']);
    expect(r.winnerAnswer).toBe('A');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ A: 1, B: 1, C: 1 });
  });

  it('plurality without strict majority (N=4, 2-1-1): plurality wins', () => {
    const r = majorityVote(['X', 'Y', 'X', 'Z']);
    expect(r.winnerAnswer).toBe('X');
    expect(r.winnerIndex).toBe(0);
    expect(r.votes).toEqual({ X: 2, Y: 1, Z: 1 });
  });

  it('throws on empty input', () => {
    expect(() => majorityVote([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Mock helpers for vote* tests
// ---------------------------------------------------------------------------

function makeMockProvider(textsInOrder: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'mock',
    model: 'mock-1',
    async runBaseline(_p, _m, _t): Promise<BaselineResult> {
      const text = textsInOrder[i++ % textsInOrder.length];
      return { text, inputTokens: 10, outputTokens: 5, durationMs: 100 };
    },
    async runWithTools(_p, _tools, _cb, _m, _mt, _t): Promise<ToolAugmentedResult> {
      const text = textsInOrder[i++ % textsInOrder.length];
      return {
        text,
        toolCalls: [{ name: 'compute', args: { problem: 'x' }, result: 'Result: 1', success: true }],
        turns: 2,
        inputTokens: 50,
        outputTokens: 25,
        durationMs: 500,
      };
    },
  };
}

const fakeProxy: MCPProxy = {
  tools: [],
  callTool: async () => 'Result: stub',
  close: async () => {},
};

describe('voteBaseline', () => {
  it('majority wins, returns winner sample with selfConsistency block', async () => {
    const provider = makeMockProvider([
      'The answer is \\boxed{3*x^2}',
      'The answer is \\boxed{3*x^2}',
      'The answer is \\boxed{3}',
    ]);
    const out = await voteBaseline('diff(x^3, x)', provider, 3, 0.7, 4096);
    expect(out.text).toContain('3*x^2'); // winner came from sample 0 or 1
    expect(out.selfConsistency.N).toBe(3);
    expect(out.selfConsistency.temperature).toBe(0.7);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(2 / 3, 5);
    expect(out.selfConsistency.samples).toHaveLength(3);
    expect(out.selfConsistency.samples[0].extractedAnswer).toBe('3*x^2');
  });

  it('all-different tie-breaks to first sample', async () => {
    const provider = makeMockProvider([
      'The answer is 1',
      'The answer is 2',
      'The answer is 3',
    ]);
    const out = await voteBaseline('p', provider, 3, 0.7, 4096);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(1 / 3, 5);
  });
});

describe('voteToolAugmented', () => {
  it('majority wins, samples preserved', async () => {
    const provider = makeMockProvider([
      'Final: \\boxed{16/3}',
      'Final: \\boxed{16/3}',
      'Final: \\boxed{8}',
    ]);
    const out = await voteToolAugmented('int(sqrt(x), x, 0, 4)', provider, fakeProxy, 3, 0.7, 4096, 8);
    expect(out.selfConsistency.N).toBe(3);
    expect(out.selfConsistency.winnerIndex).toBe(0);
    expect(out.selfConsistency.agreement).toBeCloseTo(2 / 3, 5);
    expect(out.toolCalls.length).toBeGreaterThan(0); // winner's tool calls preserved
  });
});
```

- [ ] **Step 3.2: Run test — verify it fails**

Run: `npm test -- self-consistency 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 3.3: Implement self-consistency module**

Create `benchmark/runners/self-consistency.ts`:

```typescript
/**
 * Self-consistency / N-sample voting wrapper.
 *
 * Calls the existing runners N times in series, normalizes each sample's
 * extracted answer via the grader's normalizer, then majority-votes
 * (plurality with first-occurrence tie-break) to pick a winner.
 *
 * Voting target: the canonical form from grader-v2's normalize(). This means
 * `\frac{1}{2}`, `(1)/(2)`, and `0.5` all collapse to the same equivalence
 * class for voting purposes — voting on mathematical equivalence, not surface
 * form.
 */

import type { LLMProvider, BaselineResult, ToolAugmentedResult } from '../providers/types.js';
import type { MCPProxy } from './mcp-proxy.js';
import { runBaseline } from './baseline.js';
import { runToolAugmented } from './tool-augmented.js';
import { extractModelAnswer } from '../graders/answer-parser.js';
import { normalize } from '../graders/normalizer.js';

export interface SelfConsistencyData {
  N: number;
  temperature: number;
  votes: Record<string, number>;
  winnerIndex: number;
  agreement: number;
  samples: { extractedAnswer: string }[];
}

export interface VoteResult {
  winnerIndex: number;
  winnerAnswer: string;
  votes: Record<string, number>;
}

/**
 * Plurality vote with first-occurrence tie-break.
 *
 * Throws on empty input — voting on zero samples is a programmer error.
 */
export function majorityVote(canonicalAnswers: string[]): VoteResult {
  if (canonicalAnswers.length === 0) {
    throw new Error('majorityVote: input must contain at least one element');
  }

  const votes: Record<string, number> = {};
  for (const a of canonicalAnswers) {
    votes[a] = (votes[a] ?? 0) + 1;
  }

  // Find max-count answer. Tie-break: keep the first occurrence (the answer
  // associated with sample 0 is preferred when its count ties any other).
  let winnerAnswer = canonicalAnswers[0];
  let bestCount = votes[winnerAnswer];
  for (const [ans, count] of Object.entries(votes)) {
    if (count > bestCount) {
      winnerAnswer = ans;
      bestCount = count;
    }
  }

  // Index of the FIRST sample that produced the winning answer
  const winnerIndex = canonicalAnswers.indexOf(winnerAnswer);
  return { winnerIndex, winnerAnswer, votes };
}

/**
 * Run baseline N times with the given temperature, then majority-vote.
 * Returns the winner sample extended with a selfConsistency metadata block.
 */
export async function voteBaseline(
  problem: string,
  provider: LLMProvider,
  N: number,
  temperature: number,
  maxTokens: number,
  retryOptions?: import('../providers/retry.js').RetryOptions
): Promise<BaselineResult & { selfConsistency: SelfConsistencyData }> {
  const samples: BaselineResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(await runBaseline(problem, provider, maxTokens, retryOptions, temperature));
  }
  return composeWithVote(samples, N, temperature);
}

/**
 * Run tool-augmented N times with the given temperature, then majority-vote.
 * Returns the winner sample extended with a selfConsistency metadata block.
 */
export async function voteToolAugmented(
  problem: string,
  provider: LLMProvider,
  proxy: MCPProxy,
  N: number,
  temperature: number,
  maxTokens: number,
  maxTurns: number,
  retryOptions?: import('../providers/retry.js').RetryOptions
): Promise<ToolAugmentedResult & { selfConsistency: SelfConsistencyData }> {
  const samples: ToolAugmentedResult[] = [];
  for (let i = 0; i < N; i++) {
    samples.push(
      await runToolAugmented(problem, provider, proxy, maxTokens, maxTurns, retryOptions, temperature)
    );
  }
  return composeWithVote(samples, N, temperature);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * Generic vote composer used by both voteBaseline and voteToolAugmented.
 * Extracts answers, normalizes, votes, and packages the winner sample with
 * the selfConsistency metadata.
 */
function composeWithVote<T extends { text: string }>(
  samples: T[],
  N: number,
  temperature: number
): T & { selfConsistency: SelfConsistencyData } {
  const extracted = samples.map((s) => extractModelAnswer(s.text));
  const canonicals = extracted.map((e) => normalize(e).canonical);
  const { winnerIndex, votes } = majorityVote(canonicals);
  const winner = samples[winnerIndex];
  const winnerCanonical = canonicals[winnerIndex];
  const agreement = (votes[winnerCanonical] ?? 0) / N;

  return {
    ...winner,
    selfConsistency: {
      N,
      temperature,
      votes,
      winnerIndex,
      agreement,
      samples: extracted.map((e) => ({ extractedAnswer: e })),
    },
  };
}
```

- [ ] **Step 3.4: Run test — verify it passes**

Run: `npm test -- self-consistency 2>&1 | tail -10`
Expected: 8/8 tests pass (5 majorityVote + 2 voteBaseline + 1 voteToolAugmented = 8 it() blocks).

Run: `npm test 2>&1 | tail -5`
Expected: full suite green (363 = 355 + 8).

- [ ] **Step 3.5: Commit**

```bash
git add benchmark/runners/self-consistency.ts test/self-consistency.test.ts
git commit -m "feat(runners): self-consistency voting wrapper (majorityVote + voteBaseline/voteToolAugmented)"
```

---

## Task 4: Config + flag wiring

**Files:**
- Modify: `benchmark/config.ts`
- Test: append to `test/config.test.ts`

- [ ] **Step 4.1: Write failing tests**

Append to `test/config.test.ts`:

```typescript
describe('buildConfig — self-consistency feature flag', () => {
  beforeEach(() => {
    delete process.env.AXIOM_SC_N;
    delete process.env.AXIOM_SC_TEMP;
  });

  it('selfConsistency is null by default', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    const c = buildConfig();
    expect(c.selfConsistency).toBeNull();
  });

  it('returns N=3 temperature=0.7 when --features=self-consistency', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 3, temperature: 0.7 });
  });

  it('AXIOM_SC_N env var overrides N', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    process.env.AXIOM_SC_N = '5';
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 5, temperature: 0.7 });
  });

  it('AXIOM_SC_TEMP env var overrides temperature', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=self-consistency'];
    process.env.AXIOM_SC_TEMP = '0.5';
    const c = buildConfig();
    expect(c.selfConsistency).toEqual({ N: 3, temperature: 0.5 });
  });

  it('env vars are ignored when flag is not present', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    process.env.AXIOM_SC_N = '5';
    process.env.AXIOM_SC_TEMP = '0.5';
    const c = buildConfig();
    expect(c.selfConsistency).toBeNull();
  });
});
```

You may need to import `beforeEach` from vitest at the top of the file if not already imported.

- [ ] **Step 4.2: Run test — verify it fails**

Run: `npm test -- config 2>&1 | tail -10`
Expected: new tests fail (`selfConsistency` field doesn't exist on the config yet).

- [ ] **Step 4.3: Add the config field**

Edit `benchmark/config.ts`. Find the `BenchmarkConfig` interface and add a new field:

```typescript
export interface BenchmarkConfig {
  // ... existing fields preserved ...
  selfConsistency: { N: number; temperature: number } | null;
}
```

(Add it at the end of the interface body.)

- [ ] **Step 4.4: Add parsing in buildConfig**

In `buildConfig()`, find the section where `features` is parsed (after the `--features=` arg processing). Add this block right before the return statement:

```typescript
  // --- Self-consistency ----------------------------------------------------
  // Activated by --features=self-consistency.
  // N defaults to 3, temperature to 0.7. Both can be overridden via
  // AXIOM_SC_N and AXIOM_SC_TEMP env vars (useful for ablation).
  let selfConsistency: { N: number; temperature: number } | null = null;
  if (features.includes('self-consistency')) {
    const nRaw = process.env.AXIOM_SC_N;
    const tRaw = process.env.AXIOM_SC_TEMP;
    const N = nRaw ? parseInt(nRaw, 10) : 3;
    const temperature = tRaw ? parseFloat(tRaw) : 0.7;
    if (Number.isFinite(N) && N >= 1 && Number.isFinite(temperature) && temperature >= 0) {
      selfConsistency = { N, temperature };
    } else {
      throw new Error(
        `Invalid self-consistency config: N=${nRaw}, temperature=${tRaw}`
      );
    }
  }
```

In the returned object, add `selfConsistency,` alongside the other fields.

- [ ] **Step 4.5: Run tests**

Run: `npm test -- config 2>&1 | tail -10`
Expected: 9/9 pass (4 prior + 5 new).

Run: `npm test 2>&1 | tail -5`
Expected: full suite green (368 = 363 + 5).

- [ ] **Step 4.6: Commit**

```bash
git add benchmark/config.ts test/config.test.ts
git commit -m "feat(benchmark): --features=self-consistency config (N=3, temp=0.7 defaults)"
```

---

## Task 5: ProblemDetail extension

**Files:**
- Modify: `benchmark/problem-detail.ts`

This task makes `selfConsistency` an optional field on the JSONL problem-detail records. Backwards compatible: when no voting happens, the field is absent (byte-for-byte unchanged).

- [ ] **Step 5.1: Add SelfConsistencyData type and optional field**

Read `benchmark/problem-detail.ts`. Find the `ProblemDetail` interface. Add the new type just above it (or in the imports if you prefer):

```typescript
export interface SelfConsistencyData {
  N: number;
  temperature: number;
  votes: Record<string, number>;
  winnerIndex: number;
  agreement: number;
  samples: { extractedAnswer: string }[];
}
```

Then modify the `baseline` and `toolAugmented` sub-types of `ProblemDetail` to include `selfConsistency?: SelfConsistencyData`:

```typescript
export interface ProblemDetail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    error?: string;
    selfConsistency?: SelfConsistencyData;
  };
  toolAugmented: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    toolCalls: ProblemDetail['toolAugmented']['toolCalls'];   // KEEP existing toolCalls type as-is
    turns: number;
    error?: string;
    selfConsistency?: SelfConsistencyData;
  };
  regression: boolean;
  improvement: boolean;
}
```

**Important:** The exact existing field names of `ProblemDetail.baseline` and `ProblemDetail.toolAugmented` may differ slightly. Read the file first to confirm the structure. Adjust the patch above to add `selfConsistency?: SelfConsistencyData` alongside whatever existing fields are there. Do not touch any existing fields.

- [ ] **Step 5.2: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green (368 still — no new tests yet, just an interface change).

- [ ] **Step 5.3: Commit**

```bash
git add benchmark/problem-detail.ts
git commit -m "feat(benchmark): SelfConsistencyData JSONL field (optional)"
```

---

## Task 6: Wire voting into benchmark/index.ts main loop

**Files:**
- Modify: `benchmark/index.ts`

The per-problem loop currently calls `runBaseline` and `runToolAugmented` unconditionally. We make the calls flag-conditional and populate `selfConsistency` when voting fires.

- [ ] **Step 6.1: Add imports**

At the top of `benchmark/index.ts`, alongside the existing runner imports, add:

```typescript
import { voteBaseline, voteToolAugmented } from './runners/self-consistency.js';
```

- [ ] **Step 6.2: Wrap the baseline call**

Find the existing baseline call (around line 152):

```typescript
        const br = await runBaseline(problemText, provider, config.maxTokens, config.retryOptions);
```

Replace with:

```typescript
        const br = config.selfConsistency
          ? await voteBaseline(
              problemText,
              provider,
              config.selfConsistency.N,
              config.selfConsistency.temperature,
              config.maxTokens,
              config.retryOptions
            )
          : await runBaseline(problemText, provider, config.maxTokens, config.retryOptions);
```

- [ ] **Step 6.3: Wrap the tool-augmented call**

Find the existing tool-augmented call (around line 176):

```typescript
        const tr = await runToolAugmented(
          problemText,
          provider,
          proxy,
          config.maxTokens,
          config.maxAgentTurns,
          config.retryOptions
        );
```

Replace with:

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

- [ ] **Step 6.4: Persist selfConsistency in detail records**

Find the part of the loop where `detail` is constructed (the `const detail: ProblemDetail = { ... }` block, around line 210 — read the file to confirm).

Inside the `baseline:` sub-object, add at the end (after existing fields):

```typescript
          ...(('selfConsistency' in br && br.selfConsistency) ? { selfConsistency: br.selfConsistency } : {}),
```

Inside the `toolAugmented:` sub-object, add at the end:

```typescript
          ...(('selfConsistency' in tr && tr.selfConsistency) ? { selfConsistency: tr.selfConsistency } : {}),
```

The `'selfConsistency' in br` guard is a TypeScript-level narrowing — since `br` is the union of `BaselineResult` and `BaselineResult & { selfConsistency: SelfConsistencyData }`, the property may or may not exist.

- [ ] **Step 6.5: Add a "Features" log line for selfConsistency**

Find the existing log block where features are printed (probably the `Features: v2` line for grader-v2). Right after it, add:

```typescript
  if (config.selfConsistency) {
    log(`  Self-consistency: N=${config.selfConsistency.N}, temperature=${config.selfConsistency.temperature}`);
  }
```

(This makes it obvious in the run header that voting is active.)

- [ ] **Step 6.6: Type check + smoke test**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green (368 — no test changes here; the wiring is exercised in Task 8's live ablation).

For a quick smoke test of the dispatch (no API call needed), run from the benchmark dir:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark
tsx -e "
import { buildConfig } from './config.js';
process.argv = ['tsx', 'index.ts', '--quick', '--features=v2,self-consistency'];
const c = buildConfig();
console.log('selfConsistency:', c.selfConsistency);
console.log('features:', c.features);
"
```

Expected output:
```
selfConsistency: { N: 3, temperature: 0.7 }
features: [ 'v2', 'self-consistency' ]
```

- [ ] **Step 6.7: Commit**

```bash
git add benchmark/index.ts
git commit -m "feat(benchmark): per-problem dispatch swaps to voting wrappers under --features=self-consistency"
```

---

## Task 7: Report generator section

**Files:**
- Modify: `benchmark/report/generator.ts`

When the run includes voting data, add a "Self-Consistency" section to the generated markdown report.

- [ ] **Step 7.1: Inspect the report generator**

Read `benchmark/report/generator.ts`. Identify the function that builds the markdown report and where it's appropriate to inject a new section. The existing report likely has sections like Summary, Results, Tool Usage, Regression Analysis. We add a new section after Tool Usage when any record has selfConsistency.

- [ ] **Step 7.2: Add a Self-Consistency section**

Inside the report-building function, find a stable insertion point (e.g. immediately before the Regression Analysis section). Add a block like this:

```typescript
  // Self-consistency aggregate (if any record has it)
  const scRecords: { agreement: number; N: number; temperature: number }[] = [];
  for (const d of details) {
    if (d.toolAugmented.selfConsistency) {
      scRecords.push({
        agreement: d.toolAugmented.selfConsistency.agreement,
        N: d.toolAugmented.selfConsistency.N,
        temperature: d.toolAugmented.selfConsistency.temperature,
      });
    }
  }
  const baselineScRecords: { agreement: number }[] = [];
  for (const d of details) {
    if (d.baseline.selfConsistency) {
      baselineScRecords.push({ agreement: d.baseline.selfConsistency.agreement });
    }
  }

  if (scRecords.length > 0) {
    const N = scRecords[0].N;
    const temperature = scRecords[0].temperature;
    const avgToolAg =
      scRecords.reduce((s, r) => s + r.agreement, 0) / scRecords.length;
    const avgBaseAg = baselineScRecords.length
      ? baselineScRecords.reduce((s, r) => s + r.agreement, 0) / baselineScRecords.length
      : null;

    // Distribution buckets (only for the tool-augmented condition)
    const unanimous = scRecords.filter((r) => r.agreement >= 0.99).length;
    const strongMaj = scRecords.filter((r) => r.agreement >= 0.6 && r.agreement < 0.99).length;
    const allDiff = scRecords.filter((r) => r.agreement < 0.4).length;

    sections.push('## Self-Consistency');
    sections.push('');
    sections.push(`- Configuration: N=${N}, temperature=${temperature}`);
    sections.push(
      `- Average agreement (tool-augmented): ${avgToolAg.toFixed(3)} (n=${scRecords.length} problems)`
    );
    if (avgBaseAg !== null) {
      sections.push(
        `- Average agreement (baseline): ${avgBaseAg.toFixed(3)} (n=${baselineScRecords.length} problems)`
      );
    }
    sections.push('- Tool-augmented agreement distribution:');
    sections.push(`  - Unanimous (all ${N} agree): ${unanimous}`);
    sections.push(`  - Strong majority (≥60% agree): ${strongMaj}`);
    sections.push(`  - All-different / weak (<40%): ${allDiff}`);
    sections.push('');
  }
```

The exact variable names (`details`, `sections`) should match the existing function. **Read the file first** and adapt — the patch above describes the logic shape, not literal variable names.

- [ ] **Step 7.3: Type check + tests**

Run: `npm run typecheck 2>&1 | tail -3`
Expected: clean.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green (no new tests for the report — its rendering is exercised by Task 8's live ablation).

- [ ] **Step 7.4: Commit**

```bash
git add benchmark/report/generator.ts
git commit -m "feat(report): self-consistency aggregate section in run report"
```

---

## Task 8: Live ablation skeleton + Phase 3 results doc

**Files:**
- Create: `docs/superpowers/specs/2026-05-08-phase-3-results.md`

This task does NOT run any benchmarks. It creates the closing artifact: a results doc with run instructions and empty result tables. The user fills in the TBD numbers from a long-lived terminal session (Phase 1 lesson — agent harness shells don't survive long-running benchmarks).

- [ ] **Step 8.1: Write the results doc skeleton**

Create `docs/superpowers/specs/2026-05-08-phase-3-results.md`:

```markdown
# Phase 3 — Results

**Date:** 2026-05-08
**Branch:** phase-3-self-consistency (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness):

\`\`\`bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (current best, no voting)
npm run cas:quick:zai -- --features=v2

# Condition 2 — Phase 3 voting on top of v2
npm run cas:quick:zai -- --features=v2,self-consistency

# Optional: voting + Phase 2 stack (largest deltas may live here)
npm run cas:quick:zai -- --features=v2,output-hygiene,grader-v3,self-consistency

# Repeatability check — run condition 2 a SECOND time
npm run cas:quick:zai -- --features=v2,self-consistency

# Analyze each
for f in results/2026-05-08-*-cas-quick-details.jsonl; do
  npm run analyze -- "$f"
done
\`\`\`

## Result tables (fill in after running)

### Per-condition CAS-quick

| Condition | N | Baseline | +MCP | Δ | Avg agreement (tool-aug) |
|---|---|---|---|---|---|
| 1: v2 (control) | 60 | TBD | TBD | TBD | n/a |
| 2: v2 + self-consistency | 60 | TBD | TBD | TBD | TBD |
| 3: v2 + Phase 2 + self-consistency | 60 | TBD | TBD | TBD | TBD |
| 4: condition 2 again (repeatability) | 60 | TBD | TBD | TBD | TBD |

### Variance reduction check

| Pair | Phase 2 swing | Phase 3 swing | Status |
|---|---|---|---|
| Two consecutive runs of identical condition | ±8pp on Phase 2 baseline | TBD (target ≤±2pp on conditions 2+4) | TBD |

### Phase 3 success-metric check

| Target | Result | Status |
|---|---|---|
| CAS-quick condition 2 ≥ 76% | TBD | TBD (PASS/FAIL) |
| Two-run baseline swing ≤ ±2pp | TBD | TBD |
| Average voting agreement ≥ 0.6 | TBD | TBD |

## Findings

[After running, fill in:]

- Did self-consistency lift CAS-quick measurably?
- What is the average agreement, and does it correlate with correctness?
- Did Phase 2 flags (output-hygiene, grader-v3) show clearer signal under voting (i.e., now that variance is reduced)?
- Token-cost ratio actually observed (target ≤ 3.5x).

## Files shipped in Phase 3

- \`benchmark/runners/self-consistency.ts\` — voteBaseline / voteToolAugmented + majorityVote
- \`benchmark/providers/types.ts\` — LLMProvider gains optional temperature
- \`benchmark/providers/openai-compat.ts\` — parametric temperature (defaults to 0)
- \`benchmark/providers/anthropic.ts\` — parametric temperature
- \`benchmark/runners/baseline.ts\` — forwards optional temperature
- \`benchmark/runners/tool-augmented.ts\` — forwards optional temperature
- \`benchmark/config.ts\` — selfConsistency config field + AXIOM_SC_N / AXIOM_SC_TEMP env overrides
- \`benchmark/index.ts\` — per-problem dispatch swaps to voting wrappers
- \`benchmark/problem-detail.ts\` — SelfConsistencyData JSONL field (optional)
- \`benchmark/report/generator.ts\` — Self-Consistency section in run report

Test coverage: +13 unit tests (355 → 368). Zero regressions in pre-Phase-3 tests when flag is off.

## Phase 4+ inputs

[Findings to feed Phase 4 (olympiad wrapper):]

- Does voting help any Omni-MATH ≥7 problems, or are they uniformly 0%? (If still 0%, Phase 4 must do something fundamentally different — voting can't rescue problems where every sample is wrong in the same way.)
- Per-problem agreement vs correctness curves: which failure modes show "high agreement, wrong answer"? Those are coherent-but-confused problems where voting helps least.
- Token-per-correct ratio under self-consistency: if it's near 3x, voting is purely averaging cost; if it's >3x there's interaction overhead worth investigating.
```

- [ ] **Step 8.2: Commit**

```bash
git add docs/superpowers/specs/2026-05-08-phase-3-results.md
git commit -m "docs(phase-3): results-doc skeleton (PENDING live ablation)"
```

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring Phase 3 complete:

- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] When `--features=self-consistency` is unset, every existing test produces byte-for-byte identical output as before Phase 3 (no regressions in v1 default paths)
- [ ] `--features=self-consistency` smoke test from the project root produces the expected config object: `{ N: 3, temperature: 0.7 }`
- [ ] Phase 3 results doc exists with run instructions and TBD tables

If any check fails, do NOT roll forward — fix or escalate.

---

## Out of scope for Phase 3 (deferred)

- Tier-based N (different N per dataset) — defer; measure flat N=3 first
- Adaptive (retry-on-failure) voting — defer; deterministic always-N is simpler to measure
- N>3 escalation
- Olympiad-specific intervention — Phase 4 (separate spec)
- Voting on tool-call sequences (only final-answer voting is in scope)
- Anthropic-side validation under voting (z.ai is the target provider for live ablation)
