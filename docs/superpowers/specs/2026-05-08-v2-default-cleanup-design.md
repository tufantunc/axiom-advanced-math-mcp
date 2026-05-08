# v2-Default Cleanup (Design)

**Date:** 2026-05-08
**Status:** Approved
**Branch target:** `v2-default-cleanup` (off `main` post-Phase-4-merge)
**Scope:** Code cleanup + doc update following the closing of the Phase 0–4 iteration arc.

## Why

After live ablation across Phases 0-4, the benchmark recipe has stabilized: `--features=v2` (Phase 0 grader-v2) is the production driver, and three subsequent phases produced REJECTED or MARGINAL flags. The codebase still carries the experimental flags — including ones we know are harmful — leaving a noisy code surface and confusing recipe story.

This cleanup makes the production recipe the default (no flag required), removes REJECTED experimental code paths (tokens-8k, olympiad-prompt), and removes the v1 grader fallback that v2 has fully obsoleted. Marginal/methodology flags (output-hygiene, grader-v3, self-consistency) stay as opt-in for ablation and methodology work.

After cleanup: production users run `npm run cas:quick:zai` with no flags and get the right behavior. README and AGENTS.md document the recipe.

## Goals

- v2 grader is THE grader — no env var, no flag, no v1 fallback in code
- REJECTED features (tokens-8k, olympiad-prompt) physically removed from codebase
- Marginal/methodology features kept opt-in (output-hygiene, grader-v3, self-consistency)
- Backwards-compat: passing `--features=v2` or `--features=tokens-8k` from old scripts is a silent no-op
- README + AGENTS.md updated to reflect the new default recipe and document what was tried-and-rejected
- Test count drops by ~11 (removed v1-toggle, tokens-8k, olympiad-prompt tests). All remaining tests pass.

## Non-goals

- Touching marginal features (output-hygiene, grader-v3, self-consistency) — they stay as-is
- Edit results docs (Phase 0-4 archive) except minor notes acknowledging cleanup happened
- Refactoring grader-v2 internals
- New features
- Performance optimization
- Adding hard error / warning logs for unrecognized `--features=` (preserve silent no-op behavior)

## Architecture

No new modules. Surgical deletions across 9 existing files + 1 file deletion + 2 doc updates.

### Deletions (REJECTED features)

**`tokens-8k`** (Phase 2 regression):
- `benchmark/config.ts` — replace `maxTokens: features.includes('tokens-8k') ? 8192 : 4096` with `maxTokens: 4096`
- `test/config.test.ts` — delete the `tokens-8k feature flag` describe block (4 tests)

**`olympiad-prompt`** (Phase 4 fail):
- `benchmark/providers/prompts.ts` — delete `TOOL_PROMPT_OLYMPIAD` constant (~60 lines)
- `benchmark/providers/types.ts` — remove `systemPrompt?: string` from `runWithTools` interface
- `benchmark/providers/openai-compat.ts` — remove `systemPrompt?` parameter; replace `systemPrompt ?? getToolPromptForProblem(problem)` with `getToolPromptForProblem(problem)`
- `benchmark/providers/anthropic.ts` — same parametric rollback at both `system:` field locations
- `benchmark/runners/tool-augmented.ts` — remove `systemPrompt?` parameter and forward
- `benchmark/runners/self-consistency.ts` — remove `systemPrompt?` from `voteToolAugmented` and forward
- `benchmark/index.ts` — delete the `useOlympiadPrompt` + `systemPrompt` block, the olympiad log line, the `TOOL_PROMPT_OLYMPIAD` import, and `systemPrompt` arguments to runner ternaries
- `test/olympiad-prompt.test.ts` — delete file entirely

**v1 grader fallback** (now obsoleted by v2):
- `benchmark/graders/grader.ts` — replace the `grade()` body with a v2-only implementation; delete the `gradeSymbolic`, `sortTerms`, `splitFactors`, `evaluateConstantExpr`, `extractToolResult` private helpers
- `benchmark/index.ts` — delete `if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';`
- `test/grader-v2.test.ts` — delete the `grade() shim — v2 toggle` describe block (~3 tests); remove `process.env.AXIOM_GRADER_V2 = '1'` setup lines from any tests that retain it
- `AXIOM_GRADER_V2` env var — referenced nowhere after cleanup

### Preservation (marginal/methodology)

| Flag | Status | Code surface preserved |
|---|---|---|
| `output-hygiene` | Off-by-default opt-in | `AXIOM_COMPUTE_HYGIENE` env var, `applyHygiene` orchestrator + 3 helpers, all tests |
| `grader-v3` | Off-by-default opt-in | `AXIOM_GRADER_V3` env var, equation-RHS + bare-list stages in `gradeV2`, all tests |
| `self-consistency` | Off-by-default methodology | `AXIOM_SC_N`/`AXIOM_SC_TEMP` env vars, `voteBaseline` + `voteToolAugmented` + `majorityVote`, all tests |

These flags continue to work exactly as before. The `--features=` parser stays in `config.ts`, just without the `v2` and `tokens-8k` mappings.

### Backwards compatibility

The `--features=` parser still accepts arbitrary feature names. Passing a removed flag (`v2`, `tokens-8k`, `olympiad-prompt`) is silently ignored — no warning, no error. This matches the established silent-no-op behavior across Phase 0-4.

Result: any existing script with `--features=v2` continues to work; the `v2` token is just present in `config.features` but no code reads it.

## Component-level details

### `benchmark/graders/grader.ts` — body simplification

Current body has two paths gated by `process.env.AXIOM_GRADER_V2 === '1'`:
- v2 path: try `gradeV2`, return on match, fall through on no-match
- v1 path: numeric → symbolic → string → fallback pipeline (~80 lines)

Target body (v2-only):

```typescript
import {
  toNumber,
  extractModelAnswer,
} from './answer-parser.js';
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
 * v2's pipeline (exact → normalized → numeric → set → interval → symbolic-equiv)
 * is the production grader. This function maps v2's method enum to v1's enum
 * so existing report consumers continue to work.
 */
export function grade(modelResponse: string, groundTruth: string): GradeResult {
  const predicted = extractModelAnswer(modelResponse);
  const ground = groundTruth.trim();

  const v2 = gradeV2(predicted, ground);

  return {
    correct: v2.match,
    predicted,
    ground,
    method: mapV2Method(v2.method),
  };
}

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
 * (Independent of the v2 pipeline.)
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

Helpers `gradeSymbolic`, `sortTerms`, `splitFactors`, `evaluateConstantExpr`, `extractToolResult` and the `normalizeString`, `normalizeSymbolic`, `isSymbolic` imports (if no longer used) are deleted. The file shrinks from ~270 lines to ~50 lines.

### `benchmark/index.ts` — flag mapping cleanup

Current:
```typescript
if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';
if (config.features.includes('output-hygiene')) process.env.AXIOM_COMPUTE_HYGIENE = '1';
if (config.features.includes('grader-v3')) process.env.AXIOM_GRADER_V3 = '1';
```

Target:
```typescript
if (config.features.includes('output-hygiene')) process.env.AXIOM_COMPUTE_HYGIENE = '1';
if (config.features.includes('grader-v3')) process.env.AXIOM_GRADER_V3 = '1';
```

The olympiad-prompt block (import, `useOlympiadPrompt`, `systemPrompt`, log line) is deleted. Both runner-call ternary branches drop the trailing `systemPrompt` argument.

### `benchmark/config.ts` — maxTokens hardcoded

Current:
```typescript
maxTokens: features.includes('tokens-8k') ? 8192 : 4096,
```

Target:
```typescript
maxTokens: 4096,
```

The `features: string[]` config field stays (still used by output-hygiene, grader-v3, self-consistency).

### Provider/runner systemPrompt rollback

Each of `benchmark/providers/types.ts`, `openai-compat.ts`, `anthropic.ts`, `benchmark/runners/tool-augmented.ts`, `benchmark/runners/self-consistency.ts` removes the trailing `systemPrompt?: string` parameter. Bodies that used `systemPrompt ?? getToolPromptForProblem(problem)` revert to plain `getToolPromptForProblem(problem)`. The `temperature?: number` parameter (Phase 3) remains untouched.

### Test deletions

**`test/olympiad-prompt.test.ts`** — entire file deleted (4 tests).

**`test/config.test.ts`** — delete the `buildConfig — tokens-8k feature flag` describe block (4 tests). Keep the `self-consistency feature flag` describe block (5 tests).

**`test/grader-v2.test.ts`** — delete the `grade() shim — v2 toggle` describe block. Inside the remaining grader-v2 tests, audit any `process.env.AXIOM_GRADER_V2 = '1'` set/delete lines and remove them (no longer relevant — v2 is always on at the gradeV2-direct level).

Expected post-cleanup test count: 372 − (4 + 4 + ~3) = ~361. Tighter, focused on what remains.

## Documentation updates

### README.md

Three updates:

1. **Benchmark table** — refresh with May 2026 live numbers from Phase 4 closing data:

```markdown
### Benchmark Results (GLM-5.1, May 2026)

| Dataset           | Baseline | +MCP      | Delta     |
|-------------------|----------|-----------|-----------|
| GSM8K (100)       | 96.0%    | 98.0%     | +2.0%     |
| MATH L3 (50)      | 70.0%    | 80.0%     | +10.0%    |
| MATH L4 (50)      | 50.0%    | 62.0%     | +12.0%    |
| MATH L5 (50)      | 38.0%    | 52.0%     | +14.0%    |
| CAS-quick (60)    | 55.0%    | 70.0%     | +15.0%    |
| Omni-MATH ≥7 (50) | 0.0%     | 0–4%      | (ceiling) |
```

2. **New "Run Benchmarks" section** with opinionated recipe + optional flags

3. **New "What we tried that didn't work" section** — three bullets summarizing the rejected experiments (output-v2, tokens-8k, olympiad-prompt) with pointers to results docs

### AGENTS.md

Single new section "Benchmark recipe" documenting:
- Default `npm run cas:quick:zai` etc. (no flags needed)
- Optional opt-in flags: `output-hygiene`, `grader-v3`, `self-consistency`
- DO NOT use: `v2` (now default), `tokens-8k`, `olympiad-prompt` (removed)

### Phase results docs

`2026-05-07-phase-2-results.md` and `2026-05-08-phase-4-results.md` get a one-line note in their Decision sections acknowledging the cleanup removed those flags from code. This preserves the historical analysis intact while pointing the reader to the new state.

The other Phase results docs (Phase 0, 1, 3) need no edits.

## File-changes summary

### Modified (9 + 2 docs)

| File | Change |
|---|---|
| `benchmark/config.ts` | `maxTokens` hardcoded; tokens-8k flag mapping removed |
| `benchmark/index.ts` | v2 flag mapping removed; olympiad-prompt routing removed |
| `benchmark/graders/grader.ts` | v2-only body; v1 helpers + symbolic equiv block deleted |
| `benchmark/providers/types.ts` | `systemPrompt?` removed from `runWithTools` interface |
| `benchmark/providers/openai-compat.ts` | `systemPrompt?` parameter removed; reverts to keyword dispatcher |
| `benchmark/providers/anthropic.ts` | Same rollback (both `system:` field locations) |
| `benchmark/providers/prompts.ts` | `TOOL_PROMPT_OLYMPIAD` constant deleted |
| `benchmark/runners/tool-augmented.ts` | `systemPrompt?` parameter removed |
| `benchmark/runners/self-consistency.ts` | `systemPrompt?` removed from `voteToolAugmented` |
| `test/config.test.ts` | tokens-8k describe block deleted |
| `test/grader-v2.test.ts` | v2-toggle describe block deleted; env-var setups cleaned |
| `README.md` | Benchmark table + Run Benchmarks + What we tried sections |
| `AGENTS.md` | Benchmark recipe section |

### Deleted

| File | Reason |
|---|---|
| `test/olympiad-prompt.test.ts` | Olympiad prompt removed; routing tests no longer apply |

### Touched lightly (1-line note)

| File | Note |
|---|---|
| `docs/superpowers/specs/2026-05-08-phase-2-results.md` | Note added that tokens-8k was removed from codebase |
| `docs/superpowers/specs/2026-05-08-phase-4-results.md` | Note added that olympiad-prompt was removed |

## Test policy

After cleanup, the test suite:
- Removes ~11 tests (4 tokens-8k + 4 olympiad-prompt + ~3 v2-toggle)
- Adds 0 new tests (cleanup is purely subtractive)
- Final count: ~361 unit tests, all passing

`npm run typecheck` clean (root + benchmark dir).
`npm run lint` clean (or only pre-existing warnings, no new ones).
`npm test` 361/361 pass.

Manual verification:
- `npm run cas:quick:zai` (no flags) runs successfully and uses grader-v2 (verified by checking grader behavior on a known case where v1 vs v2 differ).
- `npm run cas:quick:zai -- --features=v2` (legacy script) runs without error (silent no-op on the removed token).
- `npm run cas:quick:zai -- --features=tokens-8k` runs without error and reports `maxTokens: 4096` in the run header.

## Out of scope

- New features (this is purely cleanup)
- Refactoring marginal flags (`output-hygiene`, `grader-v3`, `self-consistency`) — they keep their current shape
- Editing results docs beyond the one-line removal notes
- CHANGELOG file (project doesn't have one)
- Hard errors or warning logs for unrecognized `--features=` tokens
- Touching `src/server/` (the MCP server itself; only benchmark tooling changes)
