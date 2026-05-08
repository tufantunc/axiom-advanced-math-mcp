# Phase 2: Output Hygiene + Grader v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land three independent improvements behind separate `--features` flags — `tokens-8k` (4096→8192 maxTokens), `output-hygiene` (Unicode normalize + optional simplify + silent-failure warn), and `grader-v3` (equation-RHS + bare-comma-list stages) — then run a 5-condition CAS-quick ablation and write a results doc.

**Architecture:** No new modules. Two small pure-function helpers per component, each gated by an env var set from the corresponding `--features` flag. v1 default behavior preserved when flags are off (zero-risk additions).

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest, tsx for benchmark runtime, Giac WASM (already wired).

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| 2.1 Truncation fix (`tokens-8k`) | Task 1 |
| 2.2 Compute output hygiene (`output-hygiene`) | Tasks 2–6 |
| 2.3 Grader v3 (`grader-v3`) | Tasks 7–9 |
| Golden corpus additions | Task 10 |
| Live ablation + results doc | Task 11 |

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `src/server/tools/unicode-normalize.ts` | Pure function `unicodeToAscii(s)`. Single responsibility: replace Unicode math symbols (`√`, `π`, `²/³/⁰¹⁴⁵⁶⁷⁸⁹`, `×`, `÷`) with ASCII equivalents. Used by both compute hygiene and (later) grader normalizer for consistency. |
| `src/server/tools/compute/silent-failure.ts` | Pure function `detectFailure(displayText): string \| null` returning a kind string when result is empty/error/non-finite, else null. |
| `src/server/tools/compute/simplify-trigger.ts` | Pure function `shouldTrySimplify(result: string): boolean` — true when the result has structural complexity signals (negative exponent, mixed `*`/`/` at depth, deep nesting). |
| `src/server/tools/compute/hygiene.ts` | Orchestrator: `applyHygiene(envelope, giacEngine)` runs the three hygiene steps in order, returns possibly-rewritten envelope. |
| `benchmark/graders/extract-rhs.ts` | Pure function `extractRHS(s): string \| null`. Returns RHS of a top-level equality, or null when unsuitable. |
| `benchmark/graders/bare-list.ts` | Pure function `bareCommaList(s): string[] \| null`. Returns members of a bare comma-separated set, or null. |

### New tests

| File | Covers |
|---|---|
| `test/unicode-normalize.test.ts` | All Unicode rules including `√` (which the existing grader normalizer is missing). |
| `test/silent-failure.test.ts` | Empty result, GIAC_ERROR prefix, NaN/Inf/undef, normal result returns null. |
| `test/simplify-trigger.test.ts` | Trigger fires on `^-`, mixed-deep `*`//`/`, deep nesting; clean output stays clean. |
| `test/compute-hygiene.test.ts` | `applyHygiene` orchestration with mocked Giac (no real engine in unit tests). |
| `test/extract-rhs.test.ts` | Equation forms, variable assignments rejected, no `=` returns null. |
| `test/bare-list.test.ts` | Positive (`i,-i`, `sqrt(2),-sqrt(2)`) + negative (`a*x+b*y,c`, `x = 5, y = 6`) cases. |

### Modified files

| File | Change |
|---|---|
| `benchmark/config.ts` | `maxTokens` becomes `features.includes('tokens-8k') ? 8192 : 4096`. |
| `benchmark/index.ts` | Set `AXIOM_COMPUTE_HYGIENE` and `AXIOM_GRADER_V3` env vars when their flags are present. |
| `src/server/tools/compute/index.ts` | When `AXIOM_COMPUTE_HYGIENE=1`, call `applyHygiene(envelope, giacEngine)` between `normalize()` and `formatOutput()`. |
| `benchmark/graders/grader-v2.ts` | When `AXIOM_GRADER_V3=1`, add equation-RHS stage at top + bare-comma-list fallback in set stage. Recursion guard: pass an internal flag through opts to skip v3 on recursive calls. |
| `benchmark/graders/normalizer.ts` | `unicodeToPlain()` adds `√ → sqrt` rule. (Independently useful even without the flag — fixes a pre-existing gap.) |
| `test/golden/fixtures.ts` | Add 5+ new `GraderCase` entries for Phase 2 regressions. |

### Removed/renamed files

None.

---

## Branch setup

This plan starts on a fresh feature branch off main:

```bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp
git checkout main
git pull --ff-only 2>/dev/null || true   # OK if no remote
git checkout -b phase-2-output-hygiene
```

Verify: `git branch --show-current` → `phase-2-output-hygiene`.

---

## Task 1: tokens-8k flag

**Files:**
- Modify: `benchmark/config.ts`
- Test: `benchmark/test/config.test.ts` OR a new test in `test/config.test.ts` (the benchmark dir does not yet have a vitest setup; place the test in the project-root `test/` so it runs under existing vitest config)

- [ ] **Step 1.1: Write failing test**

Create `test/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { buildConfig } from '../benchmark/config.js';

describe('buildConfig — tokens-8k feature flag', () => {
  it('returns maxTokens=4096 by default', () => {
    process.argv = ['tsx', 'index.ts', '--quick'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(4096);
  });

  it('returns maxTokens=8192 when tokens-8k is in features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=tokens-8k'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(8192);
  });

  it('handles tokens-8k combined with other features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=v2,tokens-8k,output-hygiene'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(8192);
    expect(c.features).toEqual(['v2', 'tokens-8k', 'output-hygiene']);
  });

  it('does NOT bump tokens for other features', () => {
    process.argv = ['tsx', 'index.ts', '--quick', '--features=v2'];
    const c = buildConfig();
    expect(c.maxTokens).toBe(4096);
  });
});
```

- [ ] **Step 1.2: Run test — verify it fails**

Run: `npm test -- config 2>&1 | tail -10`
Expected: tokens-8k tests fail (expected 8192, got 4096).

- [ ] **Step 1.3: Implement the change**

In `benchmark/config.ts`, find the returned config object (around line 168 in `buildConfig`). The current line is:

```typescript
    maxTokens: 4096,
```

Replace with:

```typescript
    maxTokens: features.includes('tokens-8k') ? 8192 : 4096,
```

(`features` is already defined earlier in `buildConfig` as a `string[]` from the `--features=` arg. No new logic needed.)

- [ ] **Step 1.4: Run test — verify it passes**

Run: `npm test -- config 2>&1 | tail -10`
Expected: 4/4 pass.

- [ ] **Step 1.5: Run full suite**

Run: `npm test 2>&1 | tail -5`
Expected: still green (only added a 4-test file).

- [ ] **Step 1.6: Commit**

```bash
git add benchmark/config.ts test/config.test.ts
git commit -m "feat(benchmark): --features=tokens-8k bumps maxTokens to 8192"
```

---

## Task 2: unicode-normalize shared module (with `√` fix)

**Files:**
- Create: `src/server/tools/unicode-normalize.ts`
- Test: `test/unicode-normalize.test.ts`
- Modify: `benchmark/graders/normalizer.ts` (use the new shared module)

This task pulls the existing `unicodeToPlain()` rules out of `benchmark/graders/normalizer.ts` and **adds the missing `√ → sqrt` rule**. Both the runtime tool output (next tasks) and the grader will share this canonical form.

- [ ] **Step 2.1: Write failing test**

Create `test/unicode-normalize.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { unicodeToAscii } from '../src/server/tools/unicode-normalize.js';

describe('unicodeToAscii', () => {
  it('replaces √ with sqrt', () => {
    expect(unicodeToAscii('√(1-x^2)')).toBe('sqrt(1-x^2)');
    expect(unicodeToAscii('-1/2*2*x*(√(1-x^2))^-1')).toBe('-1/2*2*x*(sqrt(1-x^2))^-1');
  });

  it('replaces π with pi', () => {
    expect(unicodeToAscii('π/2')).toBe('pi/2');
  });

  it('replaces unicode superscripts ⁰-⁹', () => {
    expect(unicodeToAscii('x²')).toBe('x^2');
    expect(unicodeToAscii('x³+x²+x¹+x⁰')).toBe('x^3+x^2+x^1+x^0');
    expect(unicodeToAscii('x⁴⁵⁶⁷⁸⁹')).toBe('x^4^5^6^7^8^9');
  });

  it('replaces × with * and ÷ with /', () => {
    expect(unicodeToAscii('2 × 3 ÷ 4')).toBe('2 * 3 / 4');
  });

  it('returns string unchanged when no Unicode math chars present', () => {
    expect(unicodeToAscii('sqrt(2)*x^2 + 3')).toBe('sqrt(2)*x^2 + 3');
  });

  it('handles multiple Unicode chars in one string', () => {
    expect(unicodeToAscii('√(π × x²)')).toBe('sqrt(pi * x^2)');
  });
});
```

- [ ] **Step 2.2: Run test — verify it fails**

Run: `npm test -- unicode-normalize 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 2.3: Implement unicode-normalize**

Create `src/server/tools/unicode-normalize.ts`:

```typescript
/**
 * Replace Unicode math characters with their ASCII / Giac-plain equivalents.
 * Pure function — used by both runtime tool output (compute hygiene) and the
 * benchmark grader normalizer, so both have a consistent canonical form.
 */
export function unicodeToAscii(s: string): string {
  return s
    .replace(/√/g, 'sqrt')
    .replace(/π/g, 'pi')
    .replace(/×/g, '*')
    .replace(/÷/g, '/')
    .replace(/²/g, '^2')
    .replace(/³/g, '^3')
    .replace(/⁰/g, '^0')
    .replace(/¹/g, '^1')
    .replace(/⁴/g, '^4')
    .replace(/⁵/g, '^5')
    .replace(/⁶/g, '^6')
    .replace(/⁷/g, '^7')
    .replace(/⁸/g, '^8')
    .replace(/⁹/g, '^9');
}
```

- [ ] **Step 2.4: Run test — verify it passes**

Run: `npm test -- unicode-normalize 2>&1 | tail -10`
Expected: 6/6 pass.

- [ ] **Step 2.5: Wire grader normalizer to use the shared function**

Read `benchmark/graders/normalizer.ts` lines 68-83 (the existing `unicodeToPlain` function).

Replace the entire `function unicodeToPlain(...) { ... }` block with:

```typescript
import { unicodeToAscii } from '../../src/server/tools/unicode-normalize.js';

function unicodeToPlain(s: string): string {
  return unicodeToAscii(s);
}
```

Place the `import` line at the top of the file alongside the other imports. Keep `unicodeToPlain` as an internal alias to avoid touching all its existing callers.

(The grader normalizer was previously missing the `√` rule. After this change it gets the rule "for free" — a tiny independent improvement. Validate that grader tests still pass.)

- [ ] **Step 2.6: Run grader normalizer tests + full suite**

Run: `npm test 2>&1 | tail -5`
Expected: all tests green (the existing normalizer tests still pass; `√` rule is a strict superset).

- [ ] **Step 2.7: Commit**

```bash
git add src/server/tools/unicode-normalize.ts test/unicode-normalize.test.ts benchmark/graders/normalizer.ts
git commit -m "feat(tools): shared unicode-normalize module; add missing √→sqrt rule"
```

---

## Task 3: silent-failure detection helper

**Files:**
- Create: `src/server/tools/compute/silent-failure.ts`
- Test: `test/silent-failure.test.ts`

- [ ] **Step 3.1: Write failing test**

Create `test/silent-failure.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detectFailure } from '../src/server/tools/compute/silent-failure.js';

describe('detectFailure', () => {
  it('detects empty result', () => {
    expect(detectFailure('Result: []')).toBe('empty result');
    expect(detectFailure('  Result:   []  ')).toBe('empty result');
  });

  it('detects GIAC_ERROR', () => {
    expect(detectFailure('GIAC_ERROR: bad arg')).toBe('Giac error');
    expect(detectFailure('Result: GIAC_ERROR: desolve(...)')).toBe('Giac error');
  });

  it('detects non-finite numerics', () => {
    expect(detectFailure('Result: NaN')).toBe('non-finite result');
    expect(detectFailure('Result: Inf')).toBe('non-finite result');
    expect(detectFailure('Result: -Inf')).toBe('non-finite result');
    expect(detectFailure('Result: undef')).toBe('non-finite result');
  });

  it('returns null on healthy results', () => {
    expect(detectFailure('Result: 3*x^2')).toBeNull();
    expect(detectFailure('Result: 16/3')).toBeNull();
    expect(detectFailure('Result: sqrt(2)')).toBeNull();
  });

  it('does not false-positive on result containing "Inf" as substring', () => {
    expect(detectFailure('Result: Information theory result: 0.5')).toBeNull();
  });

  it('does not false-positive on result containing "undef" as substring', () => {
    expect(detectFailure('Result: undefined_var')).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run test — verify it fails**

Run: `npm test -- silent-failure 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 3.3: Implement detectFailure**

Create `src/server/tools/compute/silent-failure.ts`:

```typescript
/**
 * Detect known failure modes in compute tool result text.
 *
 * Signals:
 *   - Empty solve result: "Result: []"
 *   - Giac error: any substring matching "GIAC_ERROR"
 *   - Non-finite numeric: NaN, Inf, -Inf, undef as standalone tokens
 *
 * Returns the failure kind, or null if the result looks healthy.
 */
export function detectFailure(displayText: string): string | null {
  const t = displayText.trim();
  if (/^Result:\s*\[\]\s*$/m.test(t) || /^Result:\s*\[\]\s*\|/m.test(t)) {
    return 'empty result';
  }
  if (/GIAC_ERROR/.test(t)) {
    return 'Giac error';
  }
  // Match \b(NaN|Inf|-Inf|undef)\b as standalone tokens, not substrings.
  // -Inf needs special handling because '-' isn't a word boundary on the left.
  if (/(?:^|[^A-Za-z])-?Inf(?![A-Za-z])/.test(t)) return 'non-finite result';
  if (/\b(NaN|undef)\b(?!\w)/.test(t)) return 'non-finite result';
  return null;
}
```

- [ ] **Step 3.4: Run test — verify it passes**

Run: `npm test -- silent-failure 2>&1 | tail -10`
Expected: 6/6 pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/server/tools/compute/silent-failure.ts test/silent-failure.test.ts
git commit -m "feat(compute): detectFailure helper for silent compute failures"
```

---

## Task 4: simplify-trigger helper

**Files:**
- Create: `src/server/tools/compute/simplify-trigger.ts`
- Test: `test/simplify-trigger.test.ts`

- [ ] **Step 4.1: Write failing test**

Create `test/simplify-trigger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldTrySimplify } from '../src/server/tools/compute/simplify-trigger.js';

describe('shouldTrySimplify', () => {
  it('triggers on negative exponent', () => {
    expect(shouldTrySimplify('-1/2*2*x*(sqrt(1-x^2))^-1')).toBe(true);
    expect(shouldTrySimplify('x^-2')).toBe(true);
  });

  it('triggers on deep nested parens (depth > 2)', () => {
    expect(shouldTrySimplify('(((x+1)*(x-1)))')).toBe(true);
    expect(shouldTrySimplify('(a*(b*(c+(d*e))))')).toBe(true);
  });

  it('does not trigger on clean output', () => {
    expect(shouldTrySimplify('3*x^2')).toBe(false);
    expect(shouldTrySimplify('sqrt(2)')).toBe(false);
    expect(shouldTrySimplify('cos(x) + sin(x)')).toBe(false);
    expect(shouldTrySimplify('16/3')).toBe(false);
  });

  it('does not trigger on simple top-level mixed * and /', () => {
    expect(shouldTrySimplify('a*b/c')).toBe(false);
    expect(shouldTrySimplify('2*x/3')).toBe(false);
  });

  it('triggers on mixed * and / inside nested parens', () => {
    // (..*..)/.. is not enough; we need the * AND / both to be inside parens
    expect(shouldTrySimplify('(2*x*(x^2-1)*(x^2+1))/(...)')).toBe(false);  // top-level / only inside paren operands
    // A real complex case from the live data:
    expect(shouldTrySimplify('-1/2*2*x*(sqrt(1-x^2))^-1')).toBe(true);  // already covered by ^- rule
  });

  it('handles empty input safely', () => {
    expect(shouldTrySimplify('')).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run test — verify it fails**

Run: `npm test -- simplify-trigger 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 4.3: Implement shouldTrySimplify**

Create `src/server/tools/compute/simplify-trigger.ts`:

```typescript
/**
 * Decide whether a Giac result is structurally complex enough to be worth
 * a follow-up simplify() call.
 *
 * Conservative — avoids spending Giac time on already-clean output.
 *
 * Trigger signals (any one is enough):
 *   1. Contains a negative exponent (`^-`) — often a sign of unsimplified
 *      reciprocals like `(...)^-1`.
 *   2. Maximum paren-nesting depth > 2 — suggests an intermediate form Giac
 *      did not collapse.
 */
export function shouldTrySimplify(result: string): boolean {
  if (!result) return false;
  if (/\^-/.test(result)) return true;
  if (maxParenDepth(result) > 2) return true;
  return false;
}

function maxParenDepth(s: string): number {
  let depth = 0;
  let max = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
      if (depth > max) max = depth;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
    }
  }
  return max;
}
```

- [ ] **Step 4.4: Run test — verify it passes**

Run: `npm test -- simplify-trigger 2>&1 | tail -10`
Expected: 6/6 pass.

- [ ] **Step 4.5: Commit**

```bash
git add src/server/tools/compute/simplify-trigger.ts test/simplify-trigger.test.ts
git commit -m "feat(compute): shouldTrySimplify trigger heuristic"
```

---

## Task 5: applyHygiene orchestrator

**Files:**
- Create: `src/server/tools/compute/hygiene.ts`
- Test: `test/compute-hygiene.test.ts`

- [ ] **Step 5.1: Write failing test**

Create `test/compute-hygiene.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { applyHygiene } from '../src/server/tools/compute/hygiene.js';
import type { ComputeEnvelope } from '../src/server/tools/compute/types.js';

const baseEnvelope = (display: string, latex?: string): ComputeEnvelope => ({
  success: true,
  result_type: 'symbolic',
  display,
  latex,
  data: {},
  method: 'test',
});

describe('applyHygiene — Unicode normalize', () => {
  it('replaces Unicode in display', async () => {
    const env = baseEnvelope('√(1-x^2)');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('sqrt(1-x^2)');
    // No simplify call expected: result is already clean after Unicode swap.
    expect(fakeEngine.evaluate).not.toHaveBeenCalled();
  });

  it('replaces Unicode in latex too when present', async () => {
    const env = baseEnvelope('√(2)', '\\sqrt{2}');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('sqrt(2)');
    expect(out.latex).toBe('\\sqrt{2}'); // already ASCII
  });
});

describe('applyHygiene — silent-failure warning', () => {
  it('appends warning note to envelope when result is empty', async () => {
    const env = baseEnvelope('Result: []');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings).toBeDefined();
    expect(out.warnings![0]).toMatch(/empty result/);
  });

  it('appends warning when GIAC_ERROR present', async () => {
    const env = baseEnvelope('GIAC_ERROR: bad arg');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings![0]).toMatch(/Giac error/);
  });

  it('no warning on healthy result', async () => {
    const env = baseEnvelope('3*x^2');
    const fakeEngine = { evaluate: vi.fn() };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.warnings).toBeUndefined();
  });
});

describe('applyHygiene — optional simplify', () => {
  it('calls simplify when trigger fires and uses shorter result', async () => {
    const env = baseEnvelope('-1/2*2*x*(sqrt(1-x^2))^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockResolvedValue('-x/sqrt(1-x^2)'),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(fakeEngine.evaluate).toHaveBeenCalledWith(
      'simplify(-1/2*2*x*(sqrt(1-x^2))^-1)'
    );
    expect(out.display).toBe('-x/sqrt(1-x^2)');
  });

  it('keeps original when simplified is longer', async () => {
    const env = baseEnvelope('(x+1)^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockResolvedValue('1/(x+1) + extra_stuff_longer'),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('(x+1)^-1');
  });

  it('keeps original when simplify throws', async () => {
    const env = baseEnvelope('(x+1)^-1');
    const fakeEngine = {
      evaluate: vi.fn().mockRejectedValue(new Error('Giac timeout')),
    };
    const out = await applyHygiene(env, fakeEngine);
    expect(out.display).toBe('(x+1)^-1');
  });
});
```

- [ ] **Step 5.2: Run test — verify it fails**

Run: `npm test -- compute-hygiene 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 5.3: Implement applyHygiene**

First, extend the `ComputeEnvelope` type to support a `warnings` field. Read `src/server/tools/compute/types.ts`. Find the `ComputeEnvelope` interface and add an optional field:

```typescript
export interface ComputeEnvelope {
  success: boolean;
  result_type: ResultType;
  display: string;
  latex?: string;
  data: Record<string, unknown>;
  method: string;
  verification?: VerificationInfo;
  giac_command?: string;
  /** Hygiene-layer notices (e.g., "empty result", "Giac error"). */
  warnings?: string[];
}
```

Then create `src/server/tools/compute/hygiene.ts`:

```typescript
import type { ComputeEnvelope } from './types.js';
import { unicodeToAscii } from '../unicode-normalize.js';
import { detectFailure } from './silent-failure.js';
import { shouldTrySimplify } from './simplify-trigger.js';

export interface GiacEngineLike {
  evaluate(expr: string): Promise<string>;
}

/**
 * Three-step compute output hygiene pipeline.
 *
 * 1. Unicode normalize on `display` (and `latex` if present).
 * 2. Silent-failure detection: if the result text contains failure signals,
 *    add a warning string to the envelope so the model sees it.
 * 3. Optional simplify: if the display has structural complexity, ask Giac
 *    to simplify and use the result if it is shorter.
 *
 * Returns a new envelope (does not mutate input).
 */
export async function applyHygiene(
  envelope: ComputeEnvelope,
  engine: GiacEngineLike
): Promise<ComputeEnvelope> {
  let next: ComputeEnvelope = { ...envelope };

  // Step 1: Unicode → ASCII on display + latex
  next.display = unicodeToAscii(next.display);
  if (next.latex !== undefined) {
    next.latex = unicodeToAscii(next.latex);
  }

  // Step 2: silent-failure warning
  const failure = detectFailure(next.display);
  if (failure !== null) {
    const note = `${failure}: tool result may be unreliable. Consider trying a different formulation.`;
    next.warnings = [...(next.warnings ?? []), note];
  }

  // Step 3: optional simplify (skip if we already flagged a failure)
  if (failure === null && shouldTrySimplify(next.display)) {
    try {
      const simplified = (await engine.evaluate(`simplify(${next.display})`)).trim();
      if (simplified && simplified.length < next.display.length) {
        next = { ...next, display: simplified };
      }
    } catch {
      // Giac error during simplify — keep the original display.
    }
  }

  return next;
}
```

- [ ] **Step 5.4: Run test — verify it passes**

Run: `npm test -- compute-hygiene 2>&1 | tail -10`
Expected: 6 tests pass (Unicode 2, silent-failure 3, simplify 3 — total 8 it() blocks; vitest counts tests).

- [ ] **Step 5.5: Run full suite**

Run: `npm test 2>&1 | tail -5`
Expected: green.

- [ ] **Step 5.6: Commit**

```bash
git add src/server/tools/compute/hygiene.ts src/server/tools/compute/types.ts test/compute-hygiene.test.ts
git commit -m "feat(compute): applyHygiene orchestrator (unicode + warn + simplify)"
```

---

## Task 6: wire output-hygiene into compute handler + benchmark flag

**Files:**
- Modify: `src/server/tools/compute/index.ts`
- Modify: `benchmark/index.ts`

- [ ] **Step 6.1: Wire hygiene into computeHandler**

Edit `src/server/tools/compute/index.ts`. Add a new import at the top:

```typescript
import { applyHygiene } from './hygiene.js';
import { giacEngine } from '../../giac/index.js';
```

Find the existing line:

```typescript
    // 3. Normalize
    const envelope = normalize(response, handler, handlerArgs);

    // 4. Format output
    return formatOutput(envelope, format, response);
```

Replace with:

```typescript
    // 3. Normalize
    let envelope = normalize(response, handler, handlerArgs);

    // 3.5 Optional hygiene pass (Unicode normalize, silent-failure warn,
    //     conservative simplify) — gated behind --features=output-hygiene.
    if (process.env.AXIOM_COMPUTE_HYGIENE === '1') {
      envelope = await applyHygiene(envelope, giacEngine);
    }

    // 4. Format output
    return formatOutput(envelope, format, response);
```

(`envelope` becomes `let` because the hygiene pass may rewrite it.)

- [ ] **Step 6.2: Surface warnings in formatOutput**

Hygiene-layer warnings need to appear in the response text the model sees. The current `formatOutput` returns `rawResponse` for `text` format. We prepend warnings to the response text when present.

In the same file, modify `formatOutput`. Find the `text` case (default):

```typescript
    case 'text':
    default:
      return rawResponse;
```

Replace with:

```typescript
    case 'text':
    default:
      if (envelope.warnings && envelope.warnings.length > 0) {
        const warnLines = envelope.warnings.map(
          (w) => ({ type: 'text' as const, text: `[Warning: ${w}]` })
        );
        return {
          content: [...warnLines, ...rawResponse.content],
          isError: rawResponse.isError,
        };
      }
      return rawResponse;
```

(Warnings appear at the top of the response so the model sees them before the result.)

- [ ] **Step 6.3: Add output-hygiene flag mapping**

Edit `benchmark/index.ts`. Find the existing line that handles `tokens-8k` or `v2`:

```typescript
  if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';
```

Right after it, add:

```typescript
  if (config.features.includes('output-hygiene')) process.env.AXIOM_COMPUTE_HYGIENE = '1';
```

- [ ] **Step 6.4: Add an integration smoke test**

Create `test/output-hygiene-integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('computeHandler — output-hygiene flag', () => {
  beforeAll(() => {
    process.env.AXIOM_COMPUTE_HYGIENE = '1';
  });
  afterAll(() => {
    delete process.env.AXIOM_COMPUTE_HYGIENE;
  });

  it('returns sanitized display for a simple expression', async () => {
    const r = await computeHandler({ problem: '2 + 3' });
    expect(r.isError).toBe(false);
    // Healthy result, no warning expected
    const allText = r.content.map((c) => c.text).join('\n');
    expect(allText).not.toMatch(/\[Warning/);
  });

  it('shape is unchanged when flag is off', async () => {
    delete process.env.AXIOM_COMPUTE_HYGIENE;
    const r = await computeHandler({ problem: '2 + 3' });
    expect(r.isError).toBe(false);
    process.env.AXIOM_COMPUTE_HYGIENE = '1'; // restore for afterAll
  });
});
```

(This is a light smoke check. The unit tests for `applyHygiene` already cover the three steps in detail.)

- [ ] **Step 6.5: Run tests**

Run: `npm test -- output-hygiene 2>&1 | tail -10`
Expected: 2/2 pass.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green.

- [ ] **Step 6.6: Commit**

```bash
git add src/server/tools/compute/index.ts benchmark/index.ts test/output-hygiene-integration.test.ts
git commit -m "feat(compute): wire applyHygiene behind --features=output-hygiene"
```

---

## Task 7: extractRHS helper

**Files:**
- Create: `benchmark/graders/extract-rhs.ts`
- Test: `test/extract-rhs.test.ts`

- [ ] **Step 7.1: Write failing test**

Create `test/extract-rhs.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { extractRHS } from '../benchmark/graders/extract-rhs.js';

describe('extractRHS', () => {
  it('extracts RHS of a function-call equation', () => {
    expect(extractRHS('sin(x) = x - x^3/6 + x^5/120')).toBe('x - x^3/6 + x^5/120');
    expect(extractRHS('f(x) = 2*x+1')).toBe('2*x+1');
  });

  it('extracts RHS of a LaTeX function-call equation', () => {
    expect(extractRHS('\\sin(x) = x - \\frac{x^3}{6}')).toBe('x - \\frac{x^3}{6}');
  });

  it('rejects bare variable assignment "x = N"', () => {
    expect(extractRHS('x = 5')).toBeNull();
    expect(extractRHS('y = 2*x+1')).toBeNull();
  });

  it('rejects strings without =', () => {
    expect(extractRHS('3*x^2')).toBeNull();
    expect(extractRHS('x + y')).toBeNull();
  });

  it('rejects multiple top-level =', () => {
    expect(extractRHS('a = b = c')).toBeNull();
  });

  it('does not split inside parens', () => {
    // "f(a=b)" has = inside parens; not a top-level equation.
    expect(extractRHS('f(a=b)')).toBeNull();
  });

  it('strips leading/trailing whitespace from RHS', () => {
    expect(extractRHS('f(x) =   2*x+1   ')).toBe('2*x+1');
  });

  it('strips outer \\boxed{} before extraction', () => {
    expect(extractRHS('\\boxed{sin(x) = x - x^3/6}')).toBe('x - x^3/6');
  });

  it('strips outer $...$ math delimiters', () => {
    expect(extractRHS('$f(x) = 2x+1$')).toBe('2x+1');
  });

  it('LHS must contain function call OR multiple letters', () => {
    // Single variable LHS rejected ("x = 5"); function call accepted.
    expect(extractRHS('a = 5')).toBeNull();
    // Multi-letter symbol like "log(x) = ..." accepted.
    expect(extractRHS('log(x) = ln(x)/ln(10)')).toBe('ln(x)/ln(10)');
  });
});
```

- [ ] **Step 7.2: Run test — verify it fails**

Run: `npm test -- extract-rhs 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 7.3: Implement extractRHS**

Create `benchmark/graders/extract-rhs.ts`:

```typescript
/**
 * Extract the right-hand side of a top-level equation.
 *
 * Returns the RHS trimmed, or null when the input is not a suitable equation.
 *
 * Rules:
 *   - Strips outer `\boxed{...}` and outer `$...$` math delimiters.
 *   - Finds a top-level '=' (depth 0 — not inside any brackets).
 *   - Requires exactly one top-level '=' (rejects chains like a=b=c).
 *   - LHS must contain a function call (e.g. `sin(x)`, `f(x)`) — single
 *     variable names are rejected because `x = 5` is itself the answer,
 *     not a renaming.
 */
export function extractRHS(input: string): string | null {
  let s = input.trim();

  // Strip surrounding math delimiters
  s = s.replace(/^\$+|\$+$/g, '').trim();

  // Strip a single outer \boxed{...} if it wraps the entire string
  const boxedMatch = s.match(/^\\boxed\{(.*)\}$/);
  if (boxedMatch) s = boxedMatch[1].trim();

  // Find top-level '=' — collect all occurrences
  const positions: number[] = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === '=' && depth === 0) positions.push(i);
  }
  if (positions.length !== 1) return null;

  const eq = positions[0];
  const lhs = s.slice(0, eq).trim();
  const rhs = s.slice(eq + 1).trim();

  if (!lhs || !rhs) return null;

  // LHS must look like a function call OR a multi-character symbolic name.
  // Single bare variables ("x", "y", "a") are rejected.
  const looksLikeFunctionCall = /\(/.test(lhs);
  const isMultiCharSymbol = /[A-Za-z]{2,}/.test(lhs);
  if (!looksLikeFunctionCall && !isMultiCharSymbol) return null;

  return rhs;
}
```

- [ ] **Step 7.4: Run test — verify it passes**

Run: `npm test -- extract-rhs 2>&1 | tail -10`
Expected: 10/10 pass.

- [ ] **Step 7.5: Commit**

```bash
git add benchmark/graders/extract-rhs.ts test/extract-rhs.test.ts
git commit -m "feat(grader): extractRHS helper for equation-form match"
```

---

## Task 8: bareCommaList helper

**Files:**
- Create: `benchmark/graders/bare-list.ts`
- Test: `test/bare-list.test.ts`

- [ ] **Step 8.1: Write failing test**

Create `test/bare-list.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { bareCommaList } from '../benchmark/graders/bare-list.js';

describe('bareCommaList', () => {
  it('parses simple atomic list', () => {
    expect(bareCommaList('i,-i')).toEqual(['i', '-i']);
    expect(bareCommaList('1,-1,2,-2')).toEqual(['1', '-1', '2', '-2']);
  });

  it('handles function-call atoms', () => {
    expect(bareCommaList('sqrt(2),-sqrt(2)')).toEqual(['sqrt(2)', '-sqrt(2)']);
    expect(bareCommaList('exp(1),exp(-1)')).toEqual(['exp(1)', 'exp(-1)']);
  });

  it('rejects when contains =', () => {
    expect(bareCommaList('x = 5, y = 6')).toBeNull();
  });

  it('rejects when contains comparison ops', () => {
    expect(bareCommaList('x>1, y<2')).toBeNull();
    expect(bareCommaList('x>=1, y<=2')).toBeNull();
  });

  it('rejects single member', () => {
    expect(bareCommaList('x')).toBeNull();
    expect(bareCommaList('sqrt(2)')).toBeNull();
  });

  it('rejects when top-level + suggests one expression', () => {
    expect(bareCommaList('a*x+b*y,c')).toBeNull();
  });

  it('does not split inside parens', () => {
    // f(a,b),g(c,d) is a 2-element list; commas inside parens should be ignored.
    expect(bareCommaList('f(a,b),g(c,d)')).toEqual(['f(a,b)', 'g(c,d)']);
  });

  it('strips whitespace around members', () => {
    expect(bareCommaList('i, -i')).toEqual(['i', '-i']);
    expect(bareCommaList('  i ,  -i  ')).toEqual(['i', '-i']);
  });

  it('returns null for empty string', () => {
    expect(bareCommaList('')).toBeNull();
  });

  it('returns null for empty members like "1,,2"', () => {
    expect(bareCommaList('1,,2')).toBeNull();
  });
});
```

- [ ] **Step 8.2: Run test — verify it fails**

Run: `npm test -- bare-list 2>&1 | tail -10`
Expected: module not found.

- [ ] **Step 8.3: Implement bareCommaList**

Create `benchmark/graders/bare-list.ts`:

```typescript
/**
 * Parse a bare comma-separated list of atomic members.
 *
 * Returns the trimmed members, or null when the input does not look like a list.
 *
 * Rejects:
 *   - Strings containing '=' or comparison operators ('>', '<', '>=', '<=').
 *   - Strings whose top-level contains a '+' (suggests one expression, not list).
 *   - Single-member lists.
 *   - Empty input or empty members.
 */
export function bareCommaList(input: string): string[] | null {
  if (!input || !input.trim()) return null;

  // Reject equations and comparisons up front (top-level only — but checking
  // any-occurrence is fine because nested commas in a real list rarely include
  // these tokens at all).
  if (/=/.test(input)) return null;
  if (/(>=|<=|<|>)/.test(input)) return null;

  // Split top-level commas (depth 0)
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of input) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const trimmed = parts.map((p) => p.trim());
  if (trimmed.length < 2) return null;
  if (trimmed.some((p) => p.length === 0)) return null;

  // Reject if any member has a top-level '+' (suggests it's all one expression
  // that happens to contain commas inside subexpressions — very unusual but
  // we want to be conservative).
  for (const m of trimmed) {
    let d = 0;
    for (const ch of m) {
      if (ch === '(' || ch === '[' || ch === '{') d++;
      else if (ch === ')' || ch === ']' || ch === '}') d--;
      else if (ch === '+' && d === 0) return null;
    }
  }

  return trimmed;
}
```

- [ ] **Step 8.4: Run test — verify it passes**

Run: `npm test -- bare-list 2>&1 | tail -10`
Expected: 10/10 pass.

- [ ] **Step 8.5: Commit**

```bash
git add benchmark/graders/bare-list.ts test/bare-list.test.ts
git commit -m "feat(grader): bareCommaList helper for set match"
```

---

## Task 9: wire grader-v3 stages + benchmark flag

**Files:**
- Modify: `benchmark/graders/grader-v2.ts`
- Modify: `benchmark/index.ts`
- Modify: `test/grader-v2.test.ts`

- [ ] **Step 9.1: Add grader-v3 flag mapping in benchmark/index.ts**

Edit `benchmark/index.ts`. After the line you added in Task 6 for `output-hygiene`, add:

```typescript
  if (config.features.includes('grader-v3')) process.env.AXIOM_GRADER_V3 = '1';
```

- [ ] **Step 9.2: Write failing tests for the v3 stages**

Append to `test/grader-v2.test.ts` (do not modify existing tests):

```typescript
describe('gradeV2 — v3 equation-RHS stage', () => {
  it('matches when predicted is equation-form and ground is plain RHS', () => {
    process.env.AXIOM_GRADER_V3 = '1';
    const r = gradeV2(
      '\\sin(x) = x - x^3/6 + x^5/120',
      'x - x^3/6 + x^5/120'
    );
    expect(r.match).toBe(true);
    delete process.env.AXIOM_GRADER_V3;
  });

  it('matches when ground is equation-form and predicted is plain RHS', () => {
    process.env.AXIOM_GRADER_V3 = '1';
    const r = gradeV2(
      '2*x+1',
      'f(x) = 2*x+1'
    );
    expect(r.match).toBe(true);
    delete process.env.AXIOM_GRADER_V3;
  });

  it('rejects bare variable assignment as equation', () => {
    process.env.AXIOM_GRADER_V3 = '1';
    // "x = 5" has trivial LHS — should NOT be treated as equation form.
    const r = gradeV2('x = 5', '5');
    // gradeV2 falls through to other stages; without equation-rhs trigger,
    // it may still match via canonicalization. We assert that the equation-rhs
    // path does not fire by checking method.
    if (r.match) {
      expect(r.method).not.toBe('equation-rhs-match' as any);
    }
    delete process.env.AXIOM_GRADER_V3;
  });

  it('does not fire when AXIOM_GRADER_V3 is unset', () => {
    delete process.env.AXIOM_GRADER_V3;
    const r = gradeV2(
      '\\sin(x) = x - x^3/6 + x^5/120',
      'x - x^3/6 + x^5/120'
    );
    // Without the flag, this should NOT match (the strings are different,
    // and v2's other stages don't extract RHS).
    expect(r.match).toBe(false);
  });
});

describe('gradeV2 — v3 bare-comma-list stage', () => {
  it('matches bare list i,-i ↔ -i,i', () => {
    process.env.AXIOM_GRADER_V3 = '1';
    const r = gradeV2('i,-i', '-i,i');
    expect(r.match).toBe(true);
    delete process.env.AXIOM_GRADER_V3;
  });

  it('matches bare list with sqrt members', () => {
    process.env.AXIOM_GRADER_V3 = '1';
    const r = gradeV2('sqrt(2),-sqrt(2)', '-sqrt(2),sqrt(2)');
    expect(r.match).toBe(true);
    delete process.env.AXIOM_GRADER_V3;
  });

  it('does not fire when AXIOM_GRADER_V3 is unset', () => {
    delete process.env.AXIOM_GRADER_V3;
    const r = gradeV2('i,-i', '-i,i');
    // Without v3, bare comma lists are treated as expressions and string-compared.
    // i,-i and -i,i are different strings.
    expect(r.match).toBe(false);
  });
});
```

- [ ] **Step 9.3: Run tests — verify equation-RHS and bare-list tests fail**

Run: `npm test -- grader-v2 2>&1 | tail -15`
Expected: the new v3 stage tests fail. The "does not fire when unset" tests pass (existing v2 doesn't match these).

- [ ] **Step 9.4: Wire v3 stages into gradeV2**

Edit `benchmark/graders/grader-v2.ts`. At the top, alongside existing imports, add:

```typescript
import { extractRHS } from './extract-rhs.js';
import { bareCommaList } from './bare-list.js';
```

Find the start of `gradeV2()` body (after the function signature, after the recursion-guard preamble if any). The first stage is currently the exact-string match. Add the v3 equation-RHS stage **after** the exact match but **before** normalization:

```typescript
export function gradeV2(
  predicted: string,
  ground: string,
  opts: GradeOptions = {}
): GradeResult {
  // (existing exact-string match)

  // v3 equation-RHS stage — only when flag set, and skip on recursive calls.
  if (process.env.AXIOM_GRADER_V3 === '1' && !opts._skipV3) {
    const innerOpts: GradeOptions = { ...opts, _skipV3: true };
    const pRHS = extractRHS(predicted);
    if (pRHS !== null) {
      const r = gradeV2(pRHS, ground, innerOpts);
      if (r.match) {
        return { ...r, method: 'equation-rhs-match' as GradeResult['method'] };
      }
    }
    const gRHS = extractRHS(ground);
    if (gRHS !== null) {
      const r = gradeV2(predicted, gRHS, innerOpts);
      if (r.match) {
        return { ...r, method: 'equation-rhs-match' as GradeResult['method'] };
      }
    }
  }

  // (existing v2 stages: normalize, numeric, set, interval, ...)
}
```

Read the existing `GradeOptions` interface and add `_skipV3?: boolean` as an internal field:

```typescript
export interface GradeOptions {
  // ... existing fields ...
  /** Internal: skip the v3 equation-RHS stage on recursive grader calls to avoid loops. */
  _skipV3?: boolean;
}
```

Read the existing `GradeResult` `method` enum (search for `'numeric' |`). Add `'equation-rhs-match'` to the union:

```typescript
method: 'numeric' | 'symbolic' | 'string' | 'normalized' | 'fallback' | 'equation-rhs-match';
```

(Adjust the exact union to match the existing one — just add `'equation-rhs-match'` at the end.)

Find the existing set-match stage. The current code looks like (around line 151):

```typescript
  const pSet = pSetRaw ?? setMembers(p.canonical) ?? conditionalToSet(predicted.trim());
  const gSet = gSetRaw ?? setMembers(g.canonical) ?? conditionalToSet(ground.trim());
```

Replace with:

```typescript
  const v3 = process.env.AXIOM_GRADER_V3 === '1';
  const pSet = pSetRaw
    ?? setMembers(p.canonical)
    ?? conditionalToSet(predicted.trim())
    ?? (v3 ? bareCommaList(predicted.trim()) : null);
  const gSet = gSetRaw
    ?? setMembers(g.canonical)
    ?? conditionalToSet(ground.trim())
    ?? (v3 ? bareCommaList(ground.trim()) : null);
```

- [ ] **Step 9.5: Run grader tests**

Run: `npm test -- grader-v2 2>&1 | tail -15`
Expected: v3 tests pass; existing v2 tests still pass.

Run: `npm test 2>&1 | tail -5`
Expected: full suite green.

- [ ] **Step 9.6: Commit**

```bash
git add benchmark/graders/grader-v2.ts benchmark/index.ts test/grader-v2.test.ts
git commit -m "feat(grader): v3 equation-RHS + bare-comma-list stages behind --features=grader-v3"
```

---

## Task 10: golden corpus expansion

**Files:**
- Modify: `test/golden/fixtures.ts`

- [ ] **Step 10.1: Add Phase 2 golden cases**

Read `test/golden/fixtures.ts` to find the existing `GRADER_CASES` array. Append these 5 new entries:

```typescript
  {
    description: 'equation-form RHS extraction (regression #56 CAS taylor sin)',
    ground: 'x-x^3/6+x^5/120',
    candidate: '\\sin(x) = x - \\frac{x^3}{6} + \\frac{x^5}{120}',
    shouldMatch: true,
    expectedMethod: 'equation-rhs-match',
  },
  {
    description: 'bare comma-list set match (regression #49 CAS eigenvals)',
    ground: 'i,-i',
    candidate: '-i,i',
    shouldMatch: true,
    expectedMethod: 'set',
  },
  {
    description: 'bare comma-list with sqrt members',
    ground: 'sqrt(2),-sqrt(2)',
    candidate: '-sqrt(2),sqrt(2)',
    shouldMatch: true,
    expectedMethod: 'set',
  },
  {
    description: 'equation-RHS rejects bare variable assignment "x = 5" vs "5"',
    ground: '5',
    candidate: 'x = 5',
    // The equation-rhs stage rejects single-variable LHS, so this falls through
    // to other stages — which may still match via canonicalization. We accept
    // either match or no-match here; the key invariant is "method is NOT
    // equation-rhs-match", which we assert in the test wrapper. For the
    // golden corpus, leave shouldMatch=false to assert the conservative path.
    shouldMatch: false,
  },
  {
    description: 'unicode √ in candidate (regression CAS #6 atan derivative)',
    ground: '-x/sqrt(1-x^2)',
    candidate: '-x/√(1-x^2)',
    shouldMatch: true,
    // No expectedMethod here; the normalizer's √→sqrt rule (Task 2) handles
    // this so any matching method is acceptable.
  },
```

The `expectedMethod` field is part of `GraderCase` already (added in Phase 0 Task 10). The new `'equation-rhs-match'` value matches the union update made in Task 9.

- [ ] **Step 10.2: Update grader.golden.test.ts to enable v3 for the new cases**

Read `test/golden/grader.golden.test.ts`. Find the `describe` block. Wrap the test body so that v3-flagged cases get the env var set:

Look for the existing test structure. It likely iterates `GRADER_CASES` and asserts each. Add `beforeAll`/`afterAll` to set `AXIOM_GRADER_V3` because some new cases require it:

```typescript
beforeAll(() => {
  process.env.AXIOM_GRADER_V3 = '1';
});
afterAll(() => {
  delete process.env.AXIOM_GRADER_V3;
});
```

(Place these inside the existing `describe` block at the top.)

This means the entire golden suite runs with v3 enabled. Existing v2-only cases still pass (v3 stages are additive — they only fire when v2 says no).

- [ ] **Step 10.3: Run golden tests**

Run: `npm test -- grader.golden 2>&1 | tail -15`
Expected: all golden cases pass (existing + 5 new).

- [ ] **Step 10.4: Commit**

```bash
git add test/golden/fixtures.ts test/golden/grader.golden.test.ts
git commit -m "test(golden): Phase 2 corpus entries (equation-RHS, bare-list, √)"
```

---

## Task 11: 5-condition ablation + Phase 2 results doc

**Files:**
- Create: `docs/superpowers/specs/2026-05-08-phase-2-results.md`

This task requires `ZAI_API_KEY`. Total runtime: ~2.5–3 hours, ~$5–10. The user runs the benchmark from a long-lived terminal (per Phase 1 lesson — agent harness shells don't survive long-running processes).

- [ ] **Step 11.1: Write the run-instructions block**

Create `docs/superpowers/specs/2026-05-08-phase-2-results.md` with the following content:

```markdown
# Phase 2 — Results

**Date:** 2026-05-08
**Branch:** phase-2-output-hygiene (merged to main)
**Status:** PENDING LIVE ABLATION — implementation merged; numbers TBD

## How to run the experiment

From a long-lived terminal (NOT inside an agent harness — Phase 1 lesson):

\`\`\`bash
cd /Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/benchmark

# Condition 1 — control (Phase 0 baseline)
npm run cas:quick:zai -- --features=v2

# Condition 2 — tokens-8k only
npm run cas:quick:zai -- --features=v2,tokens-8k

# Condition 3 — output-hygiene only
npm run cas:quick:zai -- --features=v2,output-hygiene

# Condition 4 — grader-v3 only
npm run cas:quick:zai -- --features=v2,grader-v3

# Condition 5 — combined (Phase 2 goal)
npm run cas:quick:zai -- --features=v2,tokens-8k,output-hygiene,grader-v3

# Analyze each
for f in results/2026-05-08-*-cas-quick-details.jsonl; do
  npm run analyze -- "$f"
done
\`\`\`

## Result tables (fill in after running)

### Per-condition CAS-quick

| Condition | N | Baseline | +MCP | Δ | Regressions | Improvements |
|---|---|---|---|---|---|---|
| 1: v2 (control) | 60 | TBD | TBD | TBD | TBD | TBD |
| 2: +tokens-8k | 60 | TBD | TBD | TBD | TBD | TBD |
| 3: +output-hygiene | 60 | 60 | TBD | TBD | TBD | TBD |
| 4: +grader-v3 | 60 | TBD | TBD | TBD | TBD | TBD |
| 5: combined | 60 | TBD | TBD | TBD | TBD | TBD |

### Per-flag delta (vs control)

| Flag | Δ-correct (live) | Hypothesis | Status |
|---|---|---|---|
| tokens-8k | TBD | +3 to +6 | TBD (PASS/FAIL) |
| output-hygiene | TBD | +2 to +4 | TBD |
| grader-v3 | TBD | +2 to +3 | TBD |
| combined | TBD | +6 to +13 | TBD |

### Regression diagnosis breakdown

| Condition | extraction_mismatch | wrong_tool_result | empty_result | other |
|---|---|---|---|---|
| 1: v2 | TBD | TBD | TBD | TBD |
| 5: combined | TBD | TBD | TBD | TBD |

## Findings

[After running, fill in:]
- Which flags delivered measurable lift?
- Did any flag REGRESS the metric (Phase 1 lesson)? If so, decision: keep flag in code (off by default) and document failure mode.
- What new failure modes appeared in the combined run that weren't in any single-flag run? (Interaction effects.)

## Phase 2 success-metric check

| Target | Result | Status |
|---|---|---|
| CAS-quick combined ≥ 78% | TBD | TBD |
| Combined regression count ≤ 2 | TBD | TBD |
| Token-per-correct ≤ 1.5× control | TBD | TBD |

## Files shipped in Phase 2

- \`src/server/tools/unicode-normalize.ts\` — shared Unicode→ASCII helper (also fixes pre-existing √ gap)
- \`src/server/tools/compute/silent-failure.ts\` — pure failure-detection helper
- \`src/server/tools/compute/simplify-trigger.ts\` — pure trigger heuristic
- \`src/server/tools/compute/hygiene.ts\` — applyHygiene orchestrator (Unicode + warn + simplify)
- \`benchmark/graders/extract-rhs.ts\` — equation-form RHS extractor
- \`benchmark/graders/bare-list.ts\` — bare comma-separated list parser
- \`benchmark/config.ts\` — \`tokens-8k\` flag
- \`benchmark/index.ts\` — env-var mappings for output-hygiene + grader-v3
- \`src/server/tools/compute/index.ts\` — wired (env-gated)
- \`benchmark/graders/grader-v2.ts\` — wired (env-gated v3 stages)
- \`benchmark/graders/normalizer.ts\` — uses shared unicode-normalize

## Phase 3 inputs

[Findings to feed Phase 3 (self-consistency / N-sample voting):]
- TBD: how many regressions remain after combined Phase 2?
- TBD: do any specific failure modes look like they'd benefit from majority-vote across multiple model samples?
```

- [ ] **Step 11.2: Commit the doc skeleton**

```bash
git add docs/superpowers/specs/2026-05-08-phase-2-results.md
git commit -m "docs(phase-2): results-doc skeleton (PENDING live ablation)"
```

This is the closing artifact: the user fills in the TBDs after running the 5 ablation conditions in their own terminal. Following Phase 1's pattern, the implementation work is "DONE" once the doc skeleton + run instructions are committed.

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring Phase 2 complete:

- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] When all three flags are unset, every existing test produces byte-for-byte identical output as before Phase 2 (no regressions in the v1/v2 default paths)
- [ ] All three flags have at least one positive integration test verifying the expected behavior fires when the flag is set
- [ ] Phase 2 results doc exists with run instructions

If any check fails, do NOT roll forward — fix or escalate.

---

## Out of scope for Phase 2 (deferred)

- Input preprocessing (Unicode/LaTeX → Giac on tool input) — defer; few affected cases observed
- Multi-stage fallback chain with retry — defer; silent-failure WARNING is sufficient for now
- Truncated-LaTeX repair in grader — defer; risky
- LaTeX paraphrase root-cause prompt experiment — Phase 2.5 (separate spec)
- Self-consistency / N-sample voting — Phase 3
- Olympiad wrapper — Phase 4
