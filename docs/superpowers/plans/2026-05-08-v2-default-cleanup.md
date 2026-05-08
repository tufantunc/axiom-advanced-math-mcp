# v2-Default Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make grader-v2 the unconditional production default, physically remove REJECTED experimental code (tokens-8k, olympiad-prompt, v1 grader fallback), preserve marginal/methodology flags, and update README + AGENTS.md.

**Architecture:** Pure subtractive cleanup. ~11 file edits + 1 file deletion + 2 doc rewrites + 2 doc one-line notes. Test count drops 372 → ~361.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, tsx for benchmark runtime.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| Make grader-v2 default + delete v1 fallback | Task 1 |
| Remove tokens-8k flag | Task 2 |
| Remove olympiad-prompt — top-down (routing + constant + test) | Task 3 |
| Remove olympiad-prompt — bottom-up (systemPrompt parameter) | Task 4 |
| README update | Task 5 |
| AGENTS.md update | Task 6 |
| Phase 2/4 results docs one-line note | Task 7 |

---

## File Structure

### Modified files (11)

| File | Change |
|---|---|
| `benchmark/graders/grader.ts` | v1 fallback + 5 helpers removed; v2-only body |
| `benchmark/index.ts` | v2 flag mapping + olympiad routing block + olympiad import + log line + ternary systemPrompt args removed |
| `benchmark/config.ts` | `maxTokens` hardcoded 4096 |
| `benchmark/providers/prompts.ts` | `TOOL_PROMPT_OLYMPIAD` constant deleted |
| `benchmark/providers/types.ts` | `systemPrompt?` removed from `runWithTools` interface |
| `benchmark/providers/openai-compat.ts` | `systemPrompt?` parameter + `systemPrompt ??` fallback removed |
| `benchmark/providers/anthropic.ts` | Same parametric rollback (both `system:` field locations) |
| `benchmark/runners/tool-augmented.ts` | `systemPrompt?` parameter + forward removed |
| `benchmark/runners/self-consistency.ts` | `systemPrompt?` removed from `voteToolAugmented` + forward |
| `test/grader-v2.test.ts` | `grade() shim — v2 toggle` describe block deleted (~3 tests) |
| `test/config.test.ts` | `tokens-8k feature flag` describe block deleted (4 tests) |

### Deleted files (1)

- `test/olympiad-prompt.test.ts` (4 tests)

### Doc updates (2 + 2 light notes)

- `README.md` — benchmark table refresh + Run Benchmarks section + What we tried section
- `AGENTS.md` — new Benchmark recipe section
- `docs/superpowers/specs/2026-05-08-phase-2-results.md` — one-line note about tokens-8k removal
- `docs/superpowers/specs/2026-05-08-phase-4-results.md` — one-line note about olympiad-prompt removal

---

## Branch setup

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git checkout -b v2-default-cleanup
```

Verify: `git branch --show-current` → `v2-default-cleanup`. Current main: `95994c5`. 372/372 tests passing.

---

## Task 1: Make grader-v2 default + delete v1 fallback

**Files:**
- Modify: `benchmark/graders/grader.ts`
- Modify: `benchmark/index.ts`
- Modify: `test/grader-v2.test.ts`

This task makes grader-v2 unconditional and physically removes the v1 fallback path.

- [ ] **Step 1.1: Replace grader.ts body**

Read `benchmark/graders/grader.ts` first. Confirm the existing structure has:
- Imports from `answer-parser.js`: `toNumber`, `normalizeString`, `normalizeSymbolic`, `isSymbolic`, `extractModelAnswer`
- Import `gradeV2` from `./grader-v2.js`
- A `grade()` function with env-gated v2 path + v1 fallback
- A `gradeNumeric()` function (independent — keep)
- Private helpers: `gradeSymbolic`, `sortTerms`, `splitFactors`, `evaluateConstantExpr`, `extractToolResult`

Replace the ENTIRE file content with:

```typescript
import { toNumber, extractModelAnswer } from './answer-parser.js';
import { gradeV2 } from './grader-v2.js';

const NUMERIC_TOLERANCE = 1e-6;

export interface GradeResult {
  correct: boolean;
  predicted: string;
  ground: string;
  method: 'numeric' | 'symbolic' | 'string' | 'fallback';
}

/**
 * Grade a model's response against the ground truth using grader-v2.
 *
 * v2's pipeline (exact → normalized → numeric → set → interval → symbolic-equiv,
 * plus optional v3 stages when AXIOM_GRADER_V3=1) is the production grader.
 * This function maps v2's method enum to v1's enum so existing report
 * consumers continue to work.
 *
 * Tries v2 on both the extracted answer AND the raw model response — the
 * extractor sometimes strips useful structure (e.g., set expressions like
 * "\{1, 2\}" extracted to just "2"); the raw response retains it.
 */
export function grade(modelResponse: string, groundTruth: string): GradeResult {
  const predicted = extractModelAnswer(modelResponse);
  const ground = groundTruth.trim();

  const v2Extracted = gradeV2(predicted, ground);
  const v2Raw =
    predicted === modelResponse.trim() ? v2Extracted : gradeV2(modelResponse.trim(), ground);
  const v2 = v2Extracted.match ? v2Extracted : v2Raw;

  return {
    correct: v2.match,
    predicted,
    ground,
    method: mapV2Method(v2.method),
  };
}

/**
 * Map grader-v2's fine-grained method enum to v1's coarse enum so the
 * existing JSONL/report shape stays compatible with consumers.
 */
function mapV2Method(v2Method: string): GradeResult['method'] {
  if (v2Method === 'numeric') return 'numeric';
  if (
    v2Method === 'symbolic' ||
    v2Method === 'set' ||
    v2Method === 'interval' ||
    v2Method === 'conditional' ||
    v2Method === 'normalized' ||
    v2Method === 'equation-rhs-match'
  ) {
    return 'symbolic';
  }
  if (v2Method === 'exact') return 'string';
  return 'fallback';
}

/**
 * Grade for GSM8K — ground truth is a pre-extracted number.
 * Independent of the v2 pipeline (operates on pre-parsed numerics).
 */
export function gradeNumeric(modelResponse: string, groundTruth: number): GradeResult {
  const predicted = extractModelAnswer(modelResponse);
  const predNum = toNumber(predicted);

  return {
    correct: predNum !== null && Math.abs(predNum - groundTruth) <= NUMERIC_TOLERANCE,
    predicted,
    ground: String(groundTruth),
    method: 'numeric',
  };
}
```

This shrinks the file from ~287 lines to ~63 lines. The v1 helpers (`gradeSymbolic`, `sortTerms`, `splitFactors`, `evaluateConstantExpr`, `extractToolResult`) are gone. The unused imports (`normalizeString`, `normalizeSymbolic`, `isSymbolic`) are gone.

- [ ] **Step 1.2: Remove v2 flag mapping in benchmark/index.ts**

Read `benchmark/index.ts`. Find this line (around line 65):

```typescript
  if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';
```

Delete this single line. Keep the surrounding `output-hygiene` and `grader-v3` mappings.

- [ ] **Step 1.3: Clean up grader-v2.test.ts**

Read `test/grader-v2.test.ts`. Find the `grade() shim — v2 toggle` describe block (around line 145+). Delete the entire describe block including its imports of `grade` from `grader.js` IF the import is only used in that block.

The block looks approximately like:

```typescript
import { grade } from '../benchmark/graders/grader.js';

describe('grade() shim — v2 toggle', () => {
  it('uses v1 by default', () => {
    delete process.env.AXIOM_GRADER_V2;
    const r = grade('-82/27', '-\\frac{82}{27}');
    expect(r.correct).toBe(true);
  });

  it('uses v2 when AXIOM_GRADER_V2=1', () => {
    process.env.AXIOM_GRADER_V2 = '1';
    const r = grade('\\{1, 2\\}', '\\{2, 1\\}');
    expect(r.correct).toBe(true);
    expect(r.method).toBe('symbolic');
    delete process.env.AXIOM_GRADER_V2;
  });
});
```

Delete this entire block. Also delete the `import { grade } from '../benchmark/graders/grader.js';` line if `grade` is not referenced elsewhere in this test file.

Also audit the rest of `test/grader-v2.test.ts` for any `process.env.AXIOM_GRADER_V2 = '1'` or `delete process.env.AXIOM_GRADER_V2` lines that may have been added as setup for now-irrelevant tests. Remove those lines (the env var is no longer read by any code).

- [ ] **Step 1.4: Run typecheck + tests**

Run from project root:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
npm run typecheck 2>&1 | tail -3
```
Expected: clean (zero errors).

```bash
npm test 2>&1 | tail -5
```
Expected: ~369/369 pass (372 - ~3 v2-toggle tests = ~369). All v2 direct tests still pass; `gradeV2` is unchanged.

Also run benchmark-internal typecheck (Phase 3 lesson — root tsc excludes benchmark/):

```bash
cd benchmark && npx tsc --noEmit 2>&1 | grep -v "wasm-wrapper" | tail -5
```
Expected: clean.

- [ ] **Step 1.5: Commit**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git add benchmark/graders/grader.ts benchmark/index.ts test/grader-v2.test.ts
git commit -m "refactor(grader): grader-v2 unconditional; delete v1 fallback + helpers"
```

---

## Task 2: Remove tokens-8k flag

**Files:**
- Modify: `benchmark/config.ts`
- Modify: `test/config.test.ts`

- [ ] **Step 2.1: Hardcode maxTokens in config.ts**

Read `benchmark/config.ts`. Find the line (around line 191):

```typescript
    maxTokens: features.includes('tokens-8k') ? 8192 : 4096,
```

Replace with:

```typescript
    maxTokens: 4096,
```

- [ ] **Step 2.2: Remove tokens-8k tests from config.test.ts**

Read `test/config.test.ts`. Find the `buildConfig — tokens-8k feature flag` describe block (4 tests). Delete the entire describe block.

The block looks approximately like:

```typescript
describe('buildConfig — tokens-8k feature flag', () => {
  it('returns maxTokens=4096 by default', () => { ... });
  it('returns maxTokens=8192 when tokens-8k is in features', () => { ... });
  it('handles tokens-8k combined with other features', () => { ... });
  it('does NOT bump tokens for other features', () => { ... });
});
```

Keep the `buildConfig — self-consistency feature flag` describe block (5 tests) intact.

- [ ] **Step 2.3: Run typecheck + tests**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
npm run typecheck 2>&1 | tail -3
```
Expected: clean.

```bash
npm test 2>&1 | tail -5
```
Expected: ~365/365 (369 - 4 tokens-8k tests).

```bash
cd benchmark && npx tsc --noEmit 2>&1 | grep -v "wasm-wrapper" | tail -5
```
Expected: clean.

- [ ] **Step 2.4: Commit**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git add benchmark/config.ts test/config.test.ts
git commit -m "refactor(config): remove rejected tokens-8k flag (Phase 2 regression)"
```

---

## Task 3: Remove olympiad-prompt — top-down (routing + constant + test file)

**Files:**
- Modify: `benchmark/index.ts`
- Modify: `benchmark/providers/prompts.ts`
- Delete: `test/olympiad-prompt.test.ts`

This task removes the routing and prompt constant. After this, providers/runners will still accept the now-unused `systemPrompt` parameter (no callers pass it) — Task 4 cleans up the parameter itself.

- [ ] **Step 3.1: Remove olympiad routing from benchmark/index.ts**

Read `benchmark/index.ts`. Three blocks need deletion.

**Block A — import (around line 36):**

```typescript
import { TOOL_PROMPT_OLYMPIAD } from './providers/prompts.js';
```

Delete this line.

**Block B — log line (around line 85):**

```typescript
  if (config.features.includes('olympiad-prompt')) {
    log(`  Olympiad prompt: enabled (active on Omni-MATH datasets only)`);
  }
```

Delete this 3-line block.

**Block C — routing decision + ternary args (around line 200-225):**

Find the per-problem dispatch where `useOlympiadPrompt` and `systemPrompt` are computed. The block looks like:

```typescript
      // Phase 4 olympiad prompt routing — only fires when flag is set AND
      // the active dataset is Omni-MATH. Other datasets and flag-off runs
      // continue to use the keyword dispatcher in providers/prompts.ts.
      const useOlympiadPrompt =
        config.features.includes('olympiad-prompt') &&
        datasetName.startsWith('Omni-MATH');
      const systemPrompt = useOlympiadPrompt ? TOOL_PROMPT_OLYMPIAD : undefined;
```

Delete this entire block (the comment + the two `const` declarations).

Then find the `tr` ternary that follows. It currently passes `systemPrompt` as the trailing argument in both branches:

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

Replace with the version that drops the trailing `systemPrompt` argument from BOTH branches:

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

(In the `runToolAugmented` branch, also drop the `undefined` temperature arg AND the comment — they were only there to keep `systemPrompt` in the right positional slot, no longer needed.)

- [ ] **Step 3.2: Delete TOOL_PROMPT_OLYMPIAD constant**

Read `benchmark/providers/prompts.ts`. Find the `export const TOOL_PROMPT_OLYMPIAD = \`...\`;` block (around line 152, ~60 lines long ending with `\boxed{<answer>}`;`).

Delete the entire constant declaration including its multi-line template literal. The block starts with `export const TOOL_PROMPT_OLYMPIAD = ` and ends with the closing backtick + semicolon.

After deletion, verify the surrounding structure is intact — the file should still have `getToolPromptForProblem`, the other `TOOL_PROMPT_*` constants, etc.

- [ ] **Step 3.3: Delete the olympiad test file**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git rm test/olympiad-prompt.test.ts
```

- [ ] **Step 3.4: Run typecheck + tests**

```bash
npm run typecheck 2>&1 | tail -3
```
Expected: clean.

```bash
npm test 2>&1 | tail -5
```
Expected: ~361/361 (365 - 4 olympiad-prompt tests).

```bash
cd benchmark && npx tsc --noEmit 2>&1 | grep -v "wasm-wrapper" | tail -5
```
Expected: clean. (Providers/runners still declare `systemPrompt?` but no caller passes it — that's fine, optional parameter.)

- [ ] **Step 3.5: Commit**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git add benchmark/index.ts benchmark/providers/prompts.ts
git commit -m "refactor(benchmark): remove olympiad-prompt routing + constant (Phase 4 fail)"
```

---

## Task 4: Remove olympiad-prompt — bottom-up (systemPrompt parameter)

**Files:**
- Modify: `benchmark/providers/types.ts`
- Modify: `benchmark/providers/openai-compat.ts`
- Modify: `benchmark/providers/anthropic.ts`
- Modify: `benchmark/runners/tool-augmented.ts`
- Modify: `benchmark/runners/self-consistency.ts`

After Task 3, no caller passes `systemPrompt`. This task removes the parameter from the entire chain.

- [ ] **Step 4.1: Remove systemPrompt from LLMProvider interface**

Read `benchmark/providers/types.ts`. Find the `runWithTools` signature in the `LLMProvider` interface:

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

Remove the `systemPrompt?: string` parameter line (and its preceding comma if needed):

```typescript
  runWithTools(
    problem: string,
    tools: NeutralTool[],
    callTool: (name: string, args: Record<string, unknown>) => Promise<string>,
    maxTokens: number,
    maxTurns: number,
    temperature?: number
  ): Promise<ToolAugmentedResult>;
```

- [ ] **Step 4.2: Roll back openai-compat**

Read `benchmark/providers/openai-compat.ts`. Find the `runWithTools` method signature; remove the `systemPrompt?: string` parameter:

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

Find the system-prompt usage line (around line 85):

```typescript
      { role: 'system', content: systemPrompt ?? getToolPromptForProblem(problem) },
```

Replace with:

```typescript
      { role: 'system', content: getToolPromptForProblem(problem) },
```

- [ ] **Step 4.3: Roll back anthropic**

Read `benchmark/providers/anthropic.ts`. Same pattern but with TWO occurrences (main loop + final-turn fallback per the Phase 4 implementation).

Update the method signature to remove `systemPrompt?: string`.

Find both `system: systemPrompt ?? getToolPromptForProblem(problem)` (or similar) lines and replace with:

```typescript
system: getToolPromptForProblem(problem),
```

(The exact key may differ — Anthropic SDK uses `system:` as a top-level field on `client.messages.create()`. Verify by reading the surrounding code.)

- [ ] **Step 4.4: Roll back tool-augmented runner**

Read `benchmark/runners/tool-augmented.ts`. Replace the function with:

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

`systemPrompt` is gone from the signature and the inner provider call.

- [ ] **Step 4.5: Roll back voteToolAugmented**

Read `benchmark/runners/self-consistency.ts`. Find the `voteToolAugmented` function. Remove the `systemPrompt?` parameter from the signature and from the inner `runToolAugmented` call.

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
  retryOptions?: import('../providers/retry.js').RetryOptions
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
        temperature
      )
    );
  }
  return composeWithVote(samples, N, temperature);
}
```

(The inner call to `runToolAugmented` no longer passes `systemPrompt` either.)

- [ ] **Step 4.6: Run typecheck + tests**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
npm run typecheck 2>&1 | tail -3
```
Expected: clean.

```bash
npm test 2>&1 | tail -5
```
Expected: ~361/361 (no test count change in this task — tests don't reference systemPrompt directly outside the deleted olympiad-prompt.test.ts).

```bash
cd benchmark && npx tsc --noEmit 2>&1 | grep -v "wasm-wrapper" | tail -5
```
Expected: clean.

- [ ] **Step 4.7: Commit**

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git add benchmark/providers/types.ts benchmark/providers/openai-compat.ts benchmark/providers/anthropic.ts benchmark/runners/tool-augmented.ts benchmark/runners/self-consistency.ts
git commit -m "refactor(providers): remove systemPrompt parameter (olympiad-prompt cleanup)"
```

---

## Task 5: Update README.md

**Files:**
- Modify: `README.md`

- [ ] **Step 5.1: Refresh the Benchmark Results table**

Read `README.md` and find the existing benchmark results table (currently labeled "GLM-5.1 + Improved Prompts" with April numbers).

Replace it with:

```markdown
### Benchmark Results (GLM-5.1, May 2026)

| Dataset           | Baseline | +MCP    | Delta     |
| ----------------- | -------- | ------- | --------- |
| GSM8K (100)       | 96.0%    | 98.0%   | +2.0%     |
| MATH L3 (50)      | 70.0%    | 80.0%   | +10.0%    |
| MATH L4 (50)      | 50.0%    | 62.0%   | +12.0%    |
| MATH L5 (50)      | 38.0%    | 52.0%   | +14.0%    |
| CAS-quick (60)    | 55.0%    | 70.0%   | +15.0%    |
| Omni-MATH ≥7 (50) | 0.0%     | 0–4%    | (ceiling) |

**Key insights:**

- Phase 0 grader (LaTeX/Unicode normalization + symbolic equivalence) is the dominant value driver across all datasets
- CAS-quick lifted from 26.7% (April pre-grader) to 70% (post-grader) — the biggest single jump
- Omni-MATH ≥7 is at ceiling for current LLM+CAS setups; needs fundamentally different approaches (Lean/Coq, fine-tuning, RAG)

Full results: [`benchmark/results/`](benchmark/results/) and [`docs/superpowers/specs/`](docs/superpowers/specs/) (per-phase analysis)
```

(The "Key insights" content varies based on existing wording — preserve the structure, replace numbers, update bullets.)

- [ ] **Step 5.2: Add "Run Benchmarks" section**

Find a sensible place in README.md after the Installation/Usage section. Add this new section:

````markdown
## Run Benchmarks

Default production recipe (grader-v2 included automatically):

```bash
cd benchmark
npm install

# Set provider API key (one of):
export ZAI_API_KEY=...
export ANTHROPIC_API_KEY=...
export OPENROUTER_API_KEY=...

# Run benchmarks (provider defaults from --zai/--anthropic/--openrouter flags)
npm run cas:quick:zai      # CAS-quick (60 problems, ~30 min)
npm run gsm8k:quick:zai    # GSM8K-quick (100 problems, ~30 min)
npm run math:quick:zai     # MATH L3-L5 quick (150 problems, ~75 min)
```

### Optional ablation features (off by default)

- `--features=output-hygiene` — tool output post-processing (Unicode normalize, optional simplify, silent-failure warning). Marginal +1pp on CAS in live measurement.
- `--features=grader-v3` — equation-RHS extraction + bare-comma-list set match. Marginal +1pp on CAS.
- `--features=self-consistency` — N=3 majority voting (variance reduction; 3× cost; no accuracy gain on CAS).

Example:

```bash
npm run cas:quick:zai -- --features=output-hygiene,grader-v3
```

See `docs/superpowers/specs/2026-05-*-results.md` for live ablation analysis of every flag.
````

- [ ] **Step 5.3: Add "What we tried that didn't work" section**

Append after the Run Benchmarks section:

```markdown
### What we tried that didn't work

This project went through extensive ablation across five phases (Phase 0–4). The following experimental approaches were tested live and rejected:

- **Phase 1: Structured JSON output with `\boxed{}` trailers** — model paraphrased boxed content into LaTeX style, breaking answer extraction. Net regression on CAS.
- **Phase 2: 8K token budget (`tokens-8k`)** — gave the model more room to wander rather than recovering from truncation. Net regression −6.7pp on CAS.
- **Phase 3: Self-consistency for accuracy** — N=3 voting did not lift accuracy (Wang et al. literature gain not reproducible on CAS); kept as a methodology tool for variance reduction only.
- **Phase 4: Olympiad-specific scaffolding prompt** — engagement improved (no-tool-call rate 84% → 74%) but accuracy stayed at 0%. Olympiad-tier problems are out of scope for prompt-engineering interventions.

Each phase's per-problem analysis is in `docs/superpowers/specs/2026-05-*-results.md`. The honest documentation of failures is preserved as a project archive.
```

- [ ] **Step 5.4: Verify README renders correctly**

Read the modified README. Visually inspect for broken markdown, dangling sections, code-block fence mismatches.

- [ ] **Step 5.5: Commit**

```bash
git add README.md
git commit -m "docs(readme): refresh benchmark table; add Run Benchmarks + What didn't work sections"
```

---

## Task 6: Update AGENTS.md

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 6.1: Add Benchmark recipe section**

Read `AGENTS.md`. The current file is from 2026-04-22 and pre-dates the Phase 0-4 work. Find a sensible placement (likely after the existing Run/Build/Test sections).

Add this new section:

```markdown
## Benchmark recipe

Default recipe (grader-v2 default; no flag needed):

\`\`\`bash
cd benchmark
npm run cas:quick:zai
npm run gsm8k:quick:zai
npm run math:quick:zai
\`\`\`

Optional opt-in flags (see README "Optional ablation features"):
- `--features=output-hygiene`
- `--features=grader-v3`
- `--features=self-consistency`

**Removed flags** (silent no-op for backwards-compat):
- `--features=v2` — grader-v2 is now the default; passing this is harmless
- `--features=tokens-8k` — Phase 2 regression; removed from code
- `--features=olympiad-prompt` — Phase 4 fail; removed from code

Per-phase results live in `docs/superpowers/specs/2026-05-*-results.md`.
```

- [ ] **Step 6.2: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): add benchmark recipe section"
```

---

## Task 7: Phase results docs one-line notes

**Files:**
- Modify: `docs/superpowers/specs/2026-05-08-phase-2-results.md`
- Modify: `docs/superpowers/specs/2026-05-08-phase-4-results.md`

- [ ] **Step 7.1: Add tokens-8k removal note in Phase 2 results**

Read `docs/superpowers/specs/2026-05-08-phase-2-results.md`. Find the Decisions section, specifically item 1 about tokens-8k:

```markdown
1. **`tokens-8k`: REJECTED for production use.** Keep the flag in code (it's a 1-line config conditional), but document this failure and do not use in any production / measurement runs. Same treatment as Phase 1's `output-v2` (kept disabled, results doc the source of truth).
```

Add a one-line note at the end of the same paragraph:

```markdown
1. **`tokens-8k`: REJECTED for production use.** Keep the flag in code (it's a 1-line config conditional), but document this failure and do not use in any production / measurement runs. Same treatment as Phase 1's `output-v2` (kept disabled, results doc the source of truth).

   **Update (2026-05-08 cleanup):** The `tokens-8k` flag was physically removed from the codebase in commit `<sha>`. Passing `--features=tokens-8k` is now a silent no-op.
```

(Use the actual commit SHA from Task 2's commit; you can leave `<sha>` as placeholder for now and replace it via `git log --oneline | grep tokens-8k` after Task 2 ships.)

- [ ] **Step 7.2: Add olympiad-prompt removal note in Phase 4 results**

Read `docs/superpowers/specs/2026-05-08-phase-4-results.md`. Find the Decision section:

```markdown
**`olympiad-prompt`: KEEP, off by default. Document as harmful for production.** Same disposition as Phase 1's `output-v2` and Phase 2's `tokens-8k`. The flag stays in code (it's a single conditional in `benchmark/index.ts`), but production runs should NOT enable it.
```

Add a one-line note:

```markdown
**`olympiad-prompt`: KEEP, off by default. Document as harmful for production.** Same disposition as Phase 1's `output-v2` and Phase 2's `tokens-8k`. The flag stays in code (it's a single conditional in `benchmark/index.ts`), but production runs should NOT enable it.

**Update (2026-05-08 cleanup):** The `olympiad-prompt` flag, the `TOOL_PROMPT_OLYMPIAD` constant, the `systemPrompt` plumbing, and the routing tests were all physically removed from the codebase in commits `<sha-task-3>` and `<sha-task-4>`. Passing `--features=olympiad-prompt` is now a silent no-op.
```

(Same pattern — use placeholder SHAs and resolve them after Tasks 3 and 4 commit.)

- [ ] **Step 7.3: Resolve placeholder SHAs**

After all earlier tasks have shipped, find the actual commits:

```bash
git log --oneline | head -10
```

Identify the commit SHAs for Task 2 (tokens-8k removal) and Tasks 3+4 (olympiad-prompt removal). Replace `<sha>`, `<sha-task-3>`, `<sha-task-4>` in both results docs with the real short SHAs (7-char prefix is fine).

- [ ] **Step 7.4: Commit**

```bash
git add docs/superpowers/specs/2026-05-08-phase-2-results.md docs/superpowers/specs/2026-05-08-phase-4-results.md
git commit -m "docs(phase-results): note that rejected flags were removed in cleanup"
```

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring the cleanup complete:

- [ ] All unit tests pass: `npm test` → ~361/361
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Benchmark-internal type check passes: `cd benchmark && npx tsc --noEmit` (excluding pre-existing wasm-wrapper warnings)
- [ ] Lint passes: `npm run lint` (only pre-existing warnings, no new ones)
- [ ] `grep -rn "AXIOM_GRADER_V2" --include="*.ts" .` returns 0 hits
- [ ] `grep -rn "TOOL_PROMPT_OLYMPIAD" --include="*.ts" .` returns 0 hits
- [ ] `grep -rn "tokens-8k" --include="*.ts" .` returns 0 hits
- [ ] `grep -rn "olympiad-prompt" --include="*.ts" .` returns 0 hits (the flag is no longer recognized)
- [ ] `grep -rn "systemPrompt" --include="*.ts" benchmark/ src/` returns 0 hits
- [ ] Backwards-compat smoke test: `cd benchmark && tsx -e "import { buildConfig } from './config.js'; process.argv = ['tsx', 'index.ts', '--features=v2,tokens-8k,olympiad-prompt', '--quick']; const c = buildConfig(); console.log('maxTokens:', c.maxTokens, 'features:', c.features);"` should print `maxTokens: 4096, features: [ 'v2', 'tokens-8k', 'olympiad-prompt' ]` (silent no-op on removed tokens)

If any check fails, do NOT roll forward — fix or escalate.

---

## Out of scope for this cleanup

- Editing results docs beyond the one-line cleanup notes (Task 7)
- Touching marginal/methodology features (`output-hygiene`, `grader-v3`, `self-consistency`) — they stay as-is
- Refactoring grader-v2 internals
- New features
- Performance optimization
- Adding hard error / warning logs for unrecognized `--features=` tokens
- Touching `src/server/` (the MCP server itself)
- Removing the `--features=` parser entirely (still used by 3 active flags)
