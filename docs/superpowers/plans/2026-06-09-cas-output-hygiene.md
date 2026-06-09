# CAS Output Hygiene + Extraction Robustness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CAS tool output clean and copyable (strip latex() quotes, drop the `order_size` big-O remainder, normalize `solve`'s `list[...]` to set/tuple notation) and make answer extraction fall back to the last *complete* `\boxed{}`.

**Architecture:** Layered cleanup. Pure string helpers live in one new file `src/server/tools/output-cleanup.ts`. Generic cleanup (quote-strip, order_size-strip) is applied unconditionally inside `evalWithLatex`. Solve-semantic cleanup (`list → set`) is injected into `evalWithLatex` via a new optional `resultTransform` hook that the solve handlers pass. The benchmark grader's boxed extraction is hardened independently. All changes are default-on and additive/defensive — any cleanup failure degrades to current output, never an error.

**Tech Stack:** TypeScript, Vitest (root config runs `test/**/*.test.ts` against the REAL Giac WASM engine; no mock setup file; `testTimeout` 60s), Giac WASM.

**Spec:** `docs/superpowers/specs/2026-06-09-cas-output-hygiene-design.md`

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/tools/output-cleanup.ts` (NEW) | Pure string helpers: `splitTopLevel`, `stripQuotes`, `stripOrderTerm`, `listToSet` |
| `src/server/tools/giac-eval.ts` (MODIFY) | Add `resultTransform?` to `EvalOptions`; apply transform → `stripOrderTerm` → `stripQuotes` on latex |
| `src/server/tools/solve.ts` (MODIFY) | Pass `resultTransform: listToSet` in both handlers |
| `src/server/tools/compute/normalize.ts` (MODIFY) | `set` buildData parses clean `{...}` form (+ defensive legacy forms) via `splitTopLevel` |
| `benchmark/graders/answer-parser.ts` (MODIFY) | Boxed fail-safe: prefer last fully-balanced `\boxed{}` |
| `test/output-cleanup.test.ts` (NEW) | Unit tests for the four helpers |
| `test/answer-parser-boxed.test.ts` (NEW) | Unit tests for boxed fail-safe |
| `test/cas-output-hygiene.test.ts` (NEW) | Integration tests (real engine) for A/B/D wiring |

---

## Task 1: `output-cleanup.ts` — `splitTopLevel` + `stripQuotes`

**Files:**
- Create: `src/server/tools/output-cleanup.ts`
- Test: `test/output-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/output-cleanup.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { splitTopLevel, stripQuotes } from '../src/server/tools/output-cleanup.js';

describe('splitTopLevel', () => {
  it('splits at top-level separator only', () => {
    expect(splitTopLevel('a,b,c', ',')).toEqual(['a', 'b', 'c']);
  });
  it('ignores separators nested in brackets/parens/braces', () => {
    expect(splitTopLevel('[2,1],[3,4]', ',')).toEqual(['[2,1]', '[3,4]']);
    expect(splitTopLevel('f(a,b),c', ',')).toEqual(['f(a,b)', 'c']);
  });
  it('returns single element when no separator', () => {
    expect(splitTopLevel('abc', ',')).toEqual(['abc']);
  });
});

describe('stripQuotes', () => {
  it('removes a matched pair of surrounding double-quotes', () => {
    expect(stripQuotes('"hello"')).toBe('hello');
  });
  it('leaves quote-free strings untouched', () => {
    expect(stripQuotes('hello')).toBe('hello');
  });
  it('does not strip a single leading or trailing quote', () => {
    expect(stripQuotes('"hello')).toBe('"hello');
    expect(stripQuotes('hello"')).toBe('hello"');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: FAIL — `Cannot find module '../src/server/tools/output-cleanup.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/server/tools/output-cleanup.ts`:

```ts
/**
 * Pure string helpers for cleaning raw Giac CAS output before it reaches the
 * model or the structured envelope. No I/O, no Giac calls — easy to unit-test.
 */

/** Split `s` at top-level (depth-0) occurrences of `sep`, respecting (), [], {}. */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && ch === sep) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

/** Strip a single matched pair of surrounding double-quotes (Giac latex() artifact). */
export function stripQuotes(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1);
  }
  return s;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/output-cleanup.ts test/output-cleanup.test.ts
git commit -m "feat(cas): add splitTopLevel + stripQuotes output helpers"
```

---

## Task 2: `stripOrderTerm` (B)

**Files:**
- Modify: `src/server/tools/output-cleanup.ts`
- Test: `test/output-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/output-cleanup.test.ts` (add `stripOrderTerm` to the import line):

```ts
import { splitTopLevel, stripQuotes, stripOrderTerm } from '../src/server/tools/output-cleanup.js';

describe('stripOrderTerm', () => {
  it('drops the trailing order_size term at center 0', () => {
    expect(stripOrderTerm('1+x+1/2*x^2+1/6*x^3+1/24*x^4+x^5*order_size(x)')).toBe(
      '1+x+1/2*x^2+1/6*x^3+1/24*x^4'
    );
  });
  it('drops the trailing order_size term at a non-zero center', () => {
    expect(stripOrderTerm('x-1-1/2*(x-1)^2+1/3*(x-1)^3+(x-1)^4*order_size(x-1)')).toBe(
      'x-1-1/2*(x-1)^2+1/3*(x-1)^3'
    );
  });
  it('leaves order-free expressions unchanged', () => {
    expect(stripOrderTerm('x^3/3')).toBe('x^3/3');
    expect(stripOrderTerm('(x-2)*(x+2)')).toBe('(x-2)*(x+2)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: FAIL — `stripOrderTerm is not a function` / import error

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/tools/output-cleanup.ts`:

```ts
/**
 * Remove the trailing big-O remainder term (e.g. `+x^5*order_size(x)`) that
 * Giac appends to series/taylor results. The remainder is always the last
 * additive term, so we cut from the last depth-0 +/- operator before the
 * `order_size` token to the end of the string.
 */
export function stripOrderTerm(expr: string): string {
  const idx = expr.indexOf('order_size');
  if (idx === -1) return expr;
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < idx; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && (ch === '+' || ch === '-') && i > 0) cut = i;
  }
  if (cut === -1) return expr;
  const stripped = expr.slice(0, cut).trim();
  return stripped || expr;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: PASS (9 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/output-cleanup.ts test/output-cleanup.test.ts
git commit -m "feat(cas): add stripOrderTerm for series big-O remainder"
```

---

## Task 3: `listToSet` (D helper)

**Files:**
- Modify: `src/server/tools/output-cleanup.ts`
- Test: `test/output-cleanup.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/output-cleanup.test.ts` (add `listToSet` to the import line):

```ts
import {
  splitTopLevel,
  stripQuotes,
  stripOrderTerm,
  listToSet,
} from '../src/server/tools/output-cleanup.js';

describe('listToSet', () => {
  it('converts a two-root list to a set', () => {
    expect(listToSet('list[-2,2]')).toBe('{-2, 2}');
  });
  it('returns a single root bare (not a set)', () => {
    expect(listToSet('list[3]')).toBe('3');
  });
  it('converts a system solution to a tuple', () => {
    expect(listToSet('list[[2,1]]')).toBe('(2, 1)');
  });
  it('converts complex roots to a set', () => {
    expect(listToSet('list[i,-i]')).toBe('{i, -i}');
  });
  it('maps an empty result to the empty set', () => {
    expect(listToSet('[]')).toBe('{}');
  });
  it('wraps multiple tuples in a set', () => {
    expect(listToSet('list[[2,1],[3,4]]')).toBe('{(2, 1), (3, 4)}');
  });
  it('returns the raw string when not a list', () => {
    expect(listToSet('x^2+1')).toBe('x^2+1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: FAIL — `listToSet is not a function` / import error

- [ ] **Step 3: Write minimal implementation**

Append to `src/server/tools/output-cleanup.ts`:

```ts
/**
 * Normalize Giac's `solve` list output into clean set/tuple notation.
 *   list[-2,2]    -> {-2, 2}
 *   list[3]       -> 3
 *   list[[2,1]]   -> (2, 1)
 *   list[i,-i]    -> {i, -i}
 *   []            -> {}
 * Any unparseable input is returned unchanged (never throws).
 */
export function listToSet(raw: string): string {
  const trimmed = raw.trim();
  let inner = trimmed.startsWith('list') ? trimmed.slice(4).trim() : trimmed;
  if (!inner.startsWith('[') || !inner.endsWith(']')) return raw;
  inner = inner.slice(1, -1).trim();
  if (inner === '') return '{}';

  const members = splitTopLevel(inner, ',')
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  if (members.length === 0) return '{}';

  // System solutions: each member is itself a [a,b,...] tuple.
  const tuples = members.map((m) => {
    if (m.startsWith('[') && m.endsWith(']')) {
      const elems = splitTopLevel(m.slice(1, -1), ',').map((e) => e.trim());
      return `(${elems.join(', ')})`;
    }
    return null;
  });
  if (tuples.every((t) => t !== null)) {
    return tuples.length === 1 ? (tuples[0] as string) : `{${tuples.join(', ')}}`;
  }

  // Scalars.
  if (members.length === 1) return members[0];
  return `{${members.join(', ')}}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/output-cleanup.test.ts`
Expected: PASS (16 tests total)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/output-cleanup.ts test/output-cleanup.test.ts
git commit -m "feat(cas): add listToSet for solve output normalization"
```

---

## Task 4: Wire generic cleanup + hook into `evalWithLatex` (A + B)

**Files:**
- Modify: `src/server/tools/giac-eval.ts`
- Test: `test/cas-output-hygiene.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cas-output-hygiene.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { evalWithLatex } from '../src/server/tools/giac-eval.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('evalWithLatex — generic output hygiene', () => {
  it('A: strips surrounding quotes from latex() output', async () => {
    const r = await evalWithLatex({ giacExpr: 'factor(x^2-4)', operation: 'factor' });
    const text = allText(r);
    expect(text).toMatch(/LaTeX: /);
    expect(text).not.toContain('LaTeX: "');
  });

  it('B: strips the order_size big-O remainder from a series', async () => {
    const r = await evalWithLatex({ giacExpr: 'series(exp(x),x,0,4)', operation: 'series' });
    const text = allText(r);
    expect(text).not.toContain('order_size');
    expect(text).toContain('Result: 1+x+1/2*x^2+1/6*x^3+1/24*x^4');
  });

  it('applies an optional resultTransform before formatting', async () => {
    const r = await evalWithLatex({
      giacExpr: 'solve(x^2-4,x)',
      operation: 'solve',
      resultTransform: () => 'TRANSFORMED',
    });
    expect(allText(r)).toContain('Result: TRANSFORMED');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: FAIL — A still shows `LaTeX: "..."`; B still contains `order_size`; `resultTransform` is not an accepted option (no effect / type error).

- [ ] **Step 3: Write minimal implementation**

Replace the body of `src/server/tools/giac-eval.ts` with:

```ts
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache } from './symbolic/cache.js';
import { stripQuotes, stripOrderTerm } from './output-cleanup.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  /** Optional caller-supplied cleanup applied to the raw result (e.g. solve's list→set). */
  resultTransform?: (raw: string) => string;
}

export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage, resultTransform } = options;

  const cached = evaluationCache.get(giacExpr);
  if (cached) {
    return formatToolResponse({
      result: cached.result,
      latex: cached.latex,
      giacCommand: giacExpr,
    });
  }

  let result = await giacEngine.evaluate(giacExpr);
  if (!result || result === 'undef') {
    return formatErrorResponse(errorMessage ?? `Could not compute ${operation}`);
  }

  // Cleanup, in order: caller transform (solve list→set) → generic order_size strip.
  if (resultTransform) result = resultTransform(result);
  result = stripOrderTerm(result);

  let latex: string | undefined;
  try {
    const rawLatex = await giacEngine.evaluate(`latex(${result})`);
    if (rawLatex && rawLatex !== 'undef' && !rawLatex.startsWith('latex')) {
      latex = stripQuotes(rawLatex)
        .replace(/\\dfrac\b/g, '\\frac')
        .replace(/\\displaystyle\s*/g, '')
        .replace(/\\textstyle\s*/g, '');
    }
  } catch {
    /* best effort */
  }

  evaluationCache.set(giacExpr, { result, latex });

  return formatToolResponse({
    result,
    latex,
    giacCommand: giacExpr,
  });
}
```

Note: the `!rawLatex.startsWith('latex')` guard intentionally checks the original
(quoted) value before stripping — Giac error echoes begin with `latex`, never `"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/giac-eval.ts test/cas-output-hygiene.test.ts
git commit -m "feat(cas): strip latex quotes + order_size in evalWithLatex, add resultTransform hook"
```

---

## Task 5: Wire `listToSet` into the solve handlers (D — text path)

**Files:**
- Modify: `src/server/tools/solve.ts`
- Test: `test/cas-output-hygiene.test.ts`

- [ ] **Step 1: Write the failing test**

Append a new describe block to `test/cas-output-hygiene.test.ts`:

```ts
import { solveEquationHandler, solveSystemHandler } from '../src/server/tools/solve.js';

describe('solve handlers — list→set normalization (D)', () => {
  it('renders two roots as a set', async () => {
    const r = await solveEquationHandler({ equation: 'x^2-4', variable: 'x' });
    expect(allText(r)).toContain('Result: {-2, 2}');
  });
  it('renders a single root bare', async () => {
    const r = await solveEquationHandler({ equation: 'x-3', variable: 'x' });
    expect(allText(r)).toContain('Result: 3');
  });
  it('renders a system solution as a tuple', async () => {
    const r = await solveSystemHandler({
      equations: ['x+y=3', 'x-y=1'],
      variables: ['x', 'y'],
    });
    expect(allText(r)).toContain('Result: (2, 1)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: FAIL — output still shows `Result: list[-2,2]`, `Result: list[3]`, `Result: list[[2,1]]`.

- [ ] **Step 3: Write minimal implementation**

In `src/server/tools/solve.ts`, add the import and pass `resultTransform` in both handlers.

Change the import block (top of file) to:

```ts
import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';
import { listToSet } from './output-cleanup.js';
```

In `solveEquationHandler`, change the `evalWithLatex` call to:

```ts
    return evalWithLatex({
      giacExpr,
      operation: 'solve',
      errorMessage: 'Could not solve equation',
      resultTransform: listToSet,
    });
```

In `solveSystemHandler`, change the `evalWithLatex` call to:

```ts
    return evalWithLatex({
      giacExpr,
      operation: 'solve_system',
      errorMessage: 'Could not solve system',
      resultTransform: listToSet,
    });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: PASS (6 tests total in this file)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/solve.ts test/cas-output-hygiene.test.ts
git commit -m "feat(cas): normalize solve list output to set/tuple via resultTransform"
```

---

## Task 6: `normalize.ts` `set` buildData parses clean `{...}` (D — json path)

**Files:**
- Modify: `src/server/tools/compute/normalize.ts`
- Test: `test/cas-output-hygiene.test.ts`

**Why:** After Task 5, `solve`'s `Result:` line is already `{-2, 2}` by the time
`normalize` re-parses it. The current `set` buildData only matched `[...]` /
`list(...)`, so it would treat `{-2, 2}` as a single solution. Update it to parse
the clean `{...}` form (keeping legacy forms defensively).

- [ ] **Step 1: Write the failing test**

Append a new describe block to `test/cas-output-hygiene.test.ts`:

```ts
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('compute json envelope — solution set parsing (D)', () => {
  it('parses a two-root solve into two structured solutions', async () => {
    const r = await computeHandler({ problem: 'solve(x^2-4,x)', format: 'json' });
    const env = JSON.parse(allText(r));
    expect(env.data.count).toBe(2);
    expect(env.data.solutions).toEqual(['-2', '2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-output-hygiene.test.ts -t "two-root solve"`
Expected: FAIL — `count` is `1` and `solutions` is `['{-2, 2}']` (the clean set string was not split).

- [ ] **Step 3: Write minimal implementation**

In `src/server/tools/compute/normalize.ts`, add the import at the top:

```ts
import { splitTopLevel } from '../output-cleanup.js';
```

Replace the `set` case in `buildData` with:

```ts
    case 'set': {
      let solutions = [fields.result];
      const trimmed = fields.result.trim();
      const setMatch =
        trimmed.match(/^\{(.+)\}$/) ||
        trimmed.match(/^\[(.+)\]$/) ||
        trimmed.match(/^list\[(.+)\]$/) ||
        trimmed.match(/^list\((.+)\)$/);
      if (setMatch) {
        solutions = splitTopLevel(setMatch[1], ',').map((s) => s.trim());
      }
      return { solutions, count: solutions.length };
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: PASS (7 tests total in this file)

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/compute/normalize.ts test/cas-output-hygiene.test.ts
git commit -m "feat(cas): parse clean {set} form in compute json envelope"
```

---

## Task 7: Boxed fail-safe extraction (C)

**Files:**
- Modify: `benchmark/graders/answer-parser.ts:258-274`
- Test: `test/answer-parser-boxed.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/answer-parser-boxed.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { extractModelAnswer } from '../benchmark/graders/answer-parser.js';

describe('extractModelAnswer — boxed fail-safe', () => {
  it('prefers the last COMPLETE box when the trailing box is truncated', () => {
    const text =
      'First the clean form \\boxed{42}. Then a long truncated copy \\boxed{1+x+\\frac{1}{2';
    expect(extractModelAnswer(text)).toBe('42');
  });
  it('returns the single complete box', () => {
    expect(extractModelAnswer('the result is \\boxed{x = 5}')).toBe('x = 5');
  });
  it('handles nested braces inside a box', () => {
    expect(extractModelAnswer('answer: \\boxed{\\frac{a}{b} + 1}')).toBe('\\frac{a}{b} + 1');
  });
  it('uses the last complete box when several are complete', () => {
    expect(extractModelAnswer('\\boxed{1} then \\boxed{2}')).toBe('2');
  });
  it('falls through to text patterns when no box is complete', () => {
    expect(extractModelAnswer('The answer is 7. \\boxed{unterminated')).toBe('7');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/answer-parser-boxed.test.ts`
Expected: FAIL — the first test returns the truncated `1+x+\frac{1}{2` (current `lastIndexOf` picks the last box regardless of completeness); the last test returns the truncated `unterminated`.

- [ ] **Step 3: Write minimal implementation**

In `benchmark/graders/answer-parser.ts`, replace the `// 1. \boxed{...}` block
(lines 259-274, from `const boxedIdx = text.lastIndexOf('\\boxed{');` through the
closing `}` of `if (boxedIdx !== -1) { ... }`) with:

```ts
  // 1. \boxed{...} — prefer the LAST fully-balanced box. A model that copies a
  //    long expression sometimes emits a complete box followed by a truncated
  //    one; fall back past the incomplete trailing box to the last complete one.
  {
    let searchFrom = 0;
    let lastComplete: string | null = null;
    for (;;) {
      const boxedIdx = text.indexOf('\\boxed{', searchFrom);
      if (boxedIdx === -1) break;
      const start = boxedIdx + 7;
      let depth = 0;
      let i = start;
      let closed = false;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          if (depth === 0) {
            closed = true;
            break;
          }
          depth--;
        }
      }
      if (closed) {
        const inner = text.slice(start, i).trim();
        if (inner) lastComplete = inner;
      }
      searchFrom = start;
    }
    if (lastComplete !== null) return cleanExtracted(lastComplete);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/answer-parser-boxed.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add benchmark/graders/answer-parser.ts test/answer-parser-boxed.test.ts
git commit -m "feat(grader): boxed fail-safe — prefer last complete \\boxed{}"
```

---

## Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS — all pre-existing tests plus the new files green. No regressions in solve/algebra/calculus tests.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no new warnings from the touched files.

- [ ] **Step 4: Sanity-check a fraction/integrate path for quote regression**

Run: `npx vitest run test/cas-output-hygiene.test.ts`
Expected: PASS. (Quote-strip is general; integrate/factor LaTeX must be quote-free.)

- [ ] **Step 5: Commit any incidental fixes**

If steps 1-4 surfaced fixes, commit them:

```bash
git add -A
git commit -m "fix(cas): resolve issues found during full verification"
```

If nothing needed fixing, skip this step.

---

## Self-Review notes (already incorporated)

- **Spec coverage:** A → Task 4 (+ Task 1 helper). B → Task 2 + Task 4. C → Task 7. D → Task 3 + Task 5 (text) + Task 6 (json). All four spec items mapped.
- **Design refinement vs spec:** The spec said "add `list[...]` regex to buildData". Because `resultTransform` cleans the result to `{...}` *before* `normalize` runs, the json path must parse the clean `{...}` form instead. Task 6 reflects this (legacy `[...]`/`list[...]`/`list(...)` kept defensively). This supersedes the spec's exact wording; the intent (json path handles solve sets) is preserved.
- **Type consistency:** `resultTransform?: (raw: string) => string` defined in Task 4, used in Task 5. Helper names (`splitTopLevel`, `stripQuotes`, `stripOrderTerm`, `listToSet`) consistent across Tasks 1-3, 4, 5, 6.
- **No flags:** all changes are default-on, independent of `AXIOM_COMPUTE_HYGIENE` (which gates a separate, higher-level hygiene pass in `computeHandler`).
```
