# Phase 0: Measurement & Grader Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the benchmark grader with one that handles LaTeX normalization, set/interval/conditional answers, and symbolic equivalence via Giac. Add a regression analysis CLI, an ablation harness, and a golden test corpus seeded from observed failures. Re-run the 360-problem benchmark to publish a grader-only delta.

**Architecture:** A new `normalizer.ts` module canonicalizes LaTeX/Unicode answers. A new `grader-v2.ts` runs a 7-stage match pipeline (exact → normalized → numeric → set → interval → conditional → symbolic equivalence via Giac). The existing `grader.ts` becomes a thin shim that delegates to v2 behind a feature flag (`AXIOM_GRADER_V2=1`) so the change is ablation-measurable. A new `analyze.ts` CLI classifies regressions from JSONL output. Golden tests live under `test/golden/` and run with the existing vitest config.

**Tech Stack:** TypeScript (strict, ES2022, NodeNext), vitest for tests, tsx for benchmark runtime, Giac WASM (already present at `src/server/giac/`) accessed through `giacEngine`.

---

## Spec sections covered

| Spec section | Tasks |
|---|---|
| 0.1 Answer normalizer | Tasks 1–3 |
| 0.2 Enhanced grader | Tasks 4–8 |
| 0.3 Regression analysis tool | Task 9 |
| 0.4 Ablation harness | Tasks 6 (flag wiring), 11 (re-run) |
| 0.5 Golden regression corpus | Task 10 |
| 0.6 Success metrics | Task 11 (final benchmark re-run + delta report) |

---

## File Structure

### New files

| File | Responsibility |
|---|---|
| `benchmark/graders/normalizer.ts` | Pure-function LaTeX/Unicode → canonical-form normalization. Returns `NormalizedAnswer { canonical, latex, decimal, is_exact, kind }`. No I/O. |
| `benchmark/graders/grader-v2.ts` | New grading pipeline. Pure-functional except for an optional injected Giac evaluator. Returns `GradeResultV2 { match, reason, kind, method }`. |
| `benchmark/graders/giac-bridge.ts` | Thin lazy wrapper around `giacEngine` (from `src/server/giac/wrapper.js`) with a 2-second per-call timeout and an in-memory result cache keyed on the input expression. |
| `benchmark/analyze.ts` | CLI: reads the most recent `*-details.jsonl`, classifies every regression and "both wrong" record, writes Markdown report. |
| `test/normalizer.test.ts` | Unit tests for normalizer. |
| `test/grader-v2.test.ts` | Unit tests for grader-v2 (excluding symbolic equivalence — that uses a mock evaluator). |
| `test/giac-bridge.test.ts` | Unit tests for the Giac bridge: timeout behavior, cache hit/miss. Uses the existing Giac mock. |
| `test/golden/grader.golden.test.ts` | Grader-level regressions: pairs of (ground truth, candidate) drawn from observed benchmark failures, asserting they now match. |
| `test/golden/tool.golden.test.ts` | Tool-level regressions: real Giac calls for a small set of problem inputs we know previously confused the grader. Runs under the integration test config. |
| `test/golden/fixtures.ts` | Shared corpus of (problem, ground truth, candidate, kind) tuples — single source of truth, imported by both golden tests and the analyze CLI's known-cases self-check. |

### Modified files

| File | Change |
|---|---|
| `benchmark/graders/grader.ts` | When `AXIOM_GRADER_V2=1`, delegate to grader-v2; otherwise use existing pipeline. The shim preserves the current `grade()` and `gradeNumeric()` exports unchanged for callers. |
| `benchmark/graders/answer-parser.ts` | Add `extractBoxedAnswer()` helper used by normalizer's `\boxed{}` rule. (Existing `extractModelAnswer` already handles `\boxed{}` for full responses; we only export the inner-extraction primitive for normalizer reuse.) |
| `benchmark/index.ts` | Wire `--features=v2,...` flag → sets `AXIOM_GRADER_V2`; print active features in run header so the JSON output records the ablation condition. |
| `benchmark/config.ts` | Add `features: string[]` to `BenchmarkConfig`; parse from `--features=` arg. |
| `benchmark/report/generator.ts` | When `features` is non-empty, include feature list in the Markdown report header. |
| `benchmark/package.json` | Add `"analyze": "tsx analyze.ts"` script. |
| `vitest.config.ts` | Extend `include` to also pick up `test/golden/*.test.ts`. (Already covers `test/**/*.test.ts` — verify and adjust only if needed.) |

### Removed/Renamed files

None.

---

## Task 1: Normalizer — basic LaTeX/Unicode canonicalization

**Files:**
- Create: `benchmark/graders/normalizer.ts`
- Test: `test/normalizer.test.ts`

- [ ] **Step 1.1: Write failing test**

Create `test/normalizer.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { normalize } from '../benchmark/graders/normalizer.js';

describe('normalizer — LaTeX/Unicode basics', () => {
  it('strips \\frac to (a)/(b)', () => {
    expect(normalize('\\frac{1}{2}').canonical).toBe('(1)/(2)');
  });

  it('strips \\dfrac and \\tfrac', () => {
    expect(normalize('\\dfrac{3}{4}').canonical).toBe('(3)/(4)');
    expect(normalize('\\tfrac{5}{6}').canonical).toBe('(5)/(6)');
  });

  it('rewrites \\sqrt{n} as sqrt(n)', () => {
    expect(normalize('\\sqrt{2}').canonical).toBe('sqrt(2)');
  });

  it('strips \\left and \\right', () => {
    expect(normalize('\\left( x + 1 \\right)').canonical).toBe('(x+1)');
  });

  it('rewrites unicode pi and superscripts', () => {
    expect(normalize('π').canonical).toBe('pi');
    expect(normalize('x²').canonical).toBe('x^2');
    expect(normalize('x³').canonical).toBe('x^3');
  });

  it('rewrites \\cdot, \\times, ÷', () => {
    expect(normalize('2 \\cdot 3').canonical).toBe('2*3');
    expect(normalize('2 \\times 3').canonical).toBe('2*3');
    expect(normalize('6 ÷ 2').canonical).toBe('6/2');
  });

  it('extracts \\boxed{X}', () => {
    expect(normalize('\\boxed{42}').canonical).toBe('42');
    expect(normalize('\\boxed{\\frac{1}{2}}').canonical).toBe('(1)/(2)');
  });

  it('strips \\text{} and \\mathrm{}', () => {
    expect(normalize('5 \\text{ apples}').canonical).toBe('5apples');
    expect(normalize('\\mathrm{e}^2').canonical).toBe('e^2');
  });
});
```

- [ ] **Step 1.2: Run test — verify it fails**

Run: `npm test -- normalizer`
Expected: FAIL — module `benchmark/graders/normalizer.js` not found.

- [ ] **Step 1.3: Implement normalizer (basic rules only)**

Create `benchmark/graders/normalizer.ts`:

```typescript
/**
 * Canonicalizes math answers from LaTeX/Unicode/mixed forms into a single
 * comparable string. Pure-function module — no I/O.
 */

export type AnswerKind = 'scalar' | 'set' | 'interval' | 'conditional' | 'expression';

export interface NormalizedAnswer {
  canonical: string;
  latex: string;
  decimal: number | null;
  is_exact: boolean;
  kind: AnswerKind;
}

/** Extract `\boxed{...}` content (innermost, balanced braces). Returns null if not present. */
function extractBoxed(s: string): string | null {
  const idx = s.lastIndexOf('\\boxed{');
  if (idx === -1) return null;
  const start = idx + '\\boxed{'.length;
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      if (depth === 0) return s.slice(start, i);
      depth--;
    }
  }
  return null;
}

/** Apply LaTeX → plain transformations. */
function latexToPlain(s: string): string {
  let r = s;
  // Iteratively expand \frac / \dfrac / \tfrac with one-level nesting support.
  for (let i = 0; i < 5; i++) {
    r = r.replace(/\\[dt]?frac\{((?:[^{}]|\{[^}]*\})+)\}\{((?:[^{}]|\{[^}]*\})+)\}/g, '($1)/($2)');
  }
  r = r.replace(/\\sqrt\{((?:[^{}]|\{[^}]*\})+)\}/g, 'sqrt($1)');
  r = r.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');
  r = r.replace(/\\cdot\b/g, '*').replace(/\\times\b/g, '*');
  r = r.replace(/\\div\b/g, '/');
  r = r.replace(/\\pi\b/g, 'pi');
  r = r.replace(/\\text\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathrm\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathbf\{([^}]*)\}/g, '$1');
  r = r.replace(/\\displaystyle\b/g, '');
  // Drop spacing macros: \, \; \: \! \\ \%
  r = r.replace(/\\[,;:!%]/g, '');
  r = r.replace(/\\\\/g, '');
  // Strip remaining unknown LaTeX commands like \alpha (keep the name).
  r = r.replace(/\\([a-zA-Z]+)/g, '$1');
  return r;
}

/** Apply Unicode → plain transformations. */
function unicodeToPlain(s: string): string {
  return s
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

/**
 * Normalize one answer string into a canonical comparable form.
 * `kind` is set to 'scalar' for now; later tasks override it for sets/intervals/conditionals.
 */
export function normalize(input: string): NormalizedAnswer {
  let s = input.trim();
  s = s.replace(/^\$+|\$+$/g, ''); // strip outer math delimiters

  const boxed = extractBoxed(s);
  if (boxed !== null) s = boxed;

  s = latexToPlain(s);
  s = unicodeToPlain(s);

  // Drop curly braces left over from non-fraction LaTeX: x^{2} → x^2
  s = s.replace(/\^\{([^{}]+)\}/g, '^$1');
  s = s.replace(/[{}]/g, '');

  // Collapse whitespace
  const canonical = s.replace(/\s+/g, '');

  return {
    canonical,
    latex: input.trim(),
    decimal: null,
    is_exact: false,
    kind: 'scalar',
  };
}
```

- [ ] **Step 1.4: Run test — verify it passes**

Run: `npm test -- normalizer`
Expected: all 8 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add benchmark/graders/normalizer.ts test/normalizer.test.ts
git commit -m "feat(benchmark): add answer normalizer with LaTeX/Unicode rules"
```

---

## Task 2: Normalizer — decimal extraction and exactness flag

**Files:**
- Modify: `benchmark/graders/normalizer.ts`
- Modify: `test/normalizer.test.ts`

- [ ] **Step 2.1: Write failing test**

Append to `test/normalizer.test.ts`:

```typescript
describe('normalizer — decimal and exactness', () => {
  it('extracts decimal for plain integers', () => {
    const n = normalize('42');
    expect(n.decimal).toBe(42);
    expect(n.is_exact).toBe(true);
  });

  it('extracts decimal for fractions', () => {
    const n = normalize('\\frac{1}{2}');
    expect(n.decimal).toBeCloseTo(0.5, 9);
    expect(n.is_exact).toBe(true);
  });

  it('extracts decimal for negative fractions', () => {
    const n = normalize('-\\frac{82}{27}');
    expect(n.decimal).toBeCloseTo(-82 / 27, 9);
    expect(n.is_exact).toBe(true);
  });

  it('marks expressions with variables as non-exact, decimal null', () => {
    const n = normalize('3*x^2');
    expect(n.decimal).toBeNull();
    expect(n.is_exact).toBe(false);
  });

  it('extracts decimal for \\sqrt{2}', () => {
    const n = normalize('\\sqrt{2}');
    expect(n.decimal).toBeCloseTo(Math.sqrt(2), 9);
    expect(n.is_exact).toBe(true);
  });
});
```

- [ ] **Step 2.2: Run test — verify it fails**

Run: `npm test -- normalizer`
Expected: 5 new tests fail (decimal is null / is_exact is false).

- [ ] **Step 2.3: Implement decimal extraction**

Replace the `return` block of `normalize()` in `benchmark/graders/normalizer.ts` with:

```typescript
  const decimal = tryEval(canonical);
  const is_exact = decimal !== null;

  return {
    canonical,
    latex: input.trim(),
    decimal,
    is_exact,
    kind: 'scalar',
  };
}

/** Attempt safe numeric eval. Returns null if expression contains variables or is unsafe. */
function tryEval(expr: string): number | null {
  if (!expr) return null;
  let e = expr
    .replace(/\bpi\b/g, String(Math.PI))
    .replace(/\be\b(?![a-zA-Z])/g, String(Math.E))
    .replace(/sqrt\(([^()]+)\)/g, 'Math.sqrt($1)')
    .replace(/\^/g, '**');
  // After substitution, only digits/operators/Math.sqrt should remain.
  if (!/^[\d.+\-*/()\s]|Math\.sqrt/.test(e)) return null;
  if (/[a-zA-Z](?!sqrt)/.test(e.replace(/Math\.sqrt/g, ''))) return null;
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${e})`)() as number;
    return typeof v === 'number' && isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2.4: Run test — verify it passes**

Run: `npm test -- normalizer`
Expected: all tests pass (13 total).

- [ ] **Step 2.5: Commit**

```bash
git add benchmark/graders/normalizer.ts test/normalizer.test.ts
git commit -m "feat(benchmark): normalizer extracts decimal and is_exact flag"
```

---

## Task 3: Normalizer — kind detection (scalar / set / interval / conditional)

**Files:**
- Modify: `benchmark/graders/normalizer.ts`
- Modify: `test/normalizer.test.ts`

- [ ] **Step 3.1: Write failing test**

Append to `test/normalizer.test.ts`:

```typescript
describe('normalizer — kind detection', () => {
  it('detects scalar', () => {
    expect(normalize('42').kind).toBe('scalar');
    expect(normalize('\\frac{1}{2}').kind).toBe('scalar');
  });

  it('detects sets like {1, 2, 3}', () => {
    const n = normalize('\\{1, 2, 3\\}');
    expect(n.kind).toBe('set');
  });

  it('detects intervals like [a, b], (a, b], (-∞, 0)', () => {
    expect(normalize('[1, 5]').kind).toBe('interval');
    expect(normalize('(0, \\infty)').kind).toBe('interval');
    expect(normalize('[\\frac{11}{2}, \\infty)').kind).toBe('interval');
  });

  it('detects conditionals like x >= 1, x = 2 or x = 3', () => {
    expect(normalize('x >= 11/2').kind).toBe('conditional');
    expect(normalize('x = 2 or x = -2').kind).toBe('conditional');
  });

  it('detects expressions with variables', () => {
    expect(normalize('3*x^2').kind).toBe('expression');
    expect(normalize('\\sin(x) + \\cos(x)').kind).toBe('expression');
  });
});
```

- [ ] **Step 3.2: Run test — verify it fails**

Run: `npm test -- normalizer`
Expected: kind tests fail (everything currently returns `'scalar'`).

- [ ] **Step 3.3: Implement kind detection**

In `benchmark/graders/normalizer.ts`, before the `return` block of `normalize()`, add:

```typescript
  const kind = detectKind(canonical);
```

And change the returned `kind: 'scalar'` to `kind`. Then add the helper:

```typescript
function detectKind(canonical: string): AnswerKind {
  // Strip a leading minus that might trip the scalar check
  const trimmed = canonical.replace(/^-/, '');
  if (/^[(\[].*[)\]]$/.test(canonical) && /,/.test(canonical)) {
    // Has surrounding brackets and a comma — interval or set
    if (canonical.startsWith('{') || /^\\\{/.test(canonical)) return 'set';
    return 'interval';
  }
  if (/^\{.*\}$/.test(canonical)) return 'set';
  if (/(>=|<=|>|<|=)/.test(canonical) && /[a-zA-Z]/.test(canonical)) return 'conditional';
  if (/\bor\b/.test(canonical)) return 'conditional';
  // Pure scalar = no letters except the constants pi / e / i
  if (!/[a-df-hj-zA-DF-HJ-Z]/.test(trimmed)) return 'scalar';
  return 'expression';
}
```

- [ ] **Step 3.4: Run test — verify it passes**

Run: `npm test -- normalizer`
Expected: all 18 tests pass.

- [ ] **Step 3.5: Commit**

```bash
git add benchmark/graders/normalizer.ts test/normalizer.test.ts
git commit -m "feat(benchmark): normalizer detects scalar/set/interval/conditional/expression"
```

---

## Task 4: Grader v2 — exact + normalized + numeric stages

**Files:**
- Create: `benchmark/graders/grader-v2.ts`
- Test: `test/grader-v2.test.ts`

- [ ] **Step 4.1: Write failing test**

Create `test/grader-v2.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { gradeV2 } from '../benchmark/graders/grader-v2.js';

describe('gradeV2 — early stages', () => {
  it('exact match', () => {
    const r = gradeV2('42', '42');
    expect(r.match).toBe(true);
    expect(r.method).toBe('exact');
  });

  it('normalized match across LaTeX', () => {
    const r = gradeV2('-\\frac{82}{27}', '-82/27');
    expect(r.match).toBe(true);
    expect(r.method).toBe('normalized');
  });

  it('numeric tolerance match', () => {
    const r = gradeV2('0.5', '\\frac{1}{2}');
    expect(r.match).toBe(true);
    expect(r.method).toBe('numeric');
  });

  it('plain mismatch', () => {
    const r = gradeV2('3', '5');
    expect(r.match).toBe(false);
  });
});
```

- [ ] **Step 4.2: Run test — verify it fails**

Run: `npm test -- grader-v2`
Expected: module not found.

- [ ] **Step 4.3: Implement grader-v2 (no symbolic equivalence yet)**

Create `benchmark/graders/grader-v2.ts`:

```typescript
import { normalize } from './normalizer.js';
import type { NormalizedAnswer, AnswerKind } from './normalizer.js';

export interface GradeResultV2 {
  match: boolean;
  reason: string;
  kind: AnswerKind;
  method:
    | 'exact'
    | 'normalized'
    | 'numeric'
    | 'set'
    | 'interval'
    | 'conditional'
    | 'symbolic'
    | 'none';
}

const NUMERIC_TOLERANCE = 1e-6;

export interface GradeOptions {
  /** Optional Giac evaluator. Returns null if Giac timed out or errored.
   *  When absent, symbolic equivalence is skipped. */
  giacEval?: (expr: string) => Promise<string | null>;
}

export function gradeV2(
  predicted: string,
  ground: string,
  _opts: GradeOptions = {}
): GradeResultV2 {
  // Stage 1: exact string
  if (predicted.trim() === ground.trim()) {
    return finish(true, 'exact-string-match', 'scalar', 'exact');
  }

  const p = normalize(predicted);
  const g = normalize(ground);

  // Stage 2: normalized string
  if (p.canonical && p.canonical === g.canonical) {
    return finish(true, 'normalized-string-match', g.kind, 'normalized');
  }

  // Stage 3: numeric (only if both reduce to a finite decimal)
  if (p.decimal !== null && g.decimal !== null) {
    if (Math.abs(p.decimal - g.decimal) <= NUMERIC_TOLERANCE) {
      return finish(true, 'numeric-tolerance-match', g.kind, 'numeric');
    }
    return finish(false, 'numeric-mismatch', g.kind, 'numeric');
  }

  return finish(false, 'no-match', g.kind, 'none');
}

function finish(
  match: boolean,
  reason: string,
  kind: AnswerKind,
  method: GradeResultV2['method']
): GradeResultV2 {
  return { match, reason, kind, method };
}

export function _internals(): { normalize: typeof normalize } {
  return { normalize };
}
```

- [ ] **Step 4.4: Run test — verify it passes**

Run: `npm test -- grader-v2`
Expected: all 4 tests pass.

- [ ] **Step 4.5: Commit**

```bash
git add benchmark/graders/grader-v2.ts test/grader-v2.test.ts
git commit -m "feat(benchmark): grader-v2 with exact/normalized/numeric stages"
```

---

## Task 5: Grader v2 — set, interval, conditional matching

**Files:**
- Modify: `benchmark/graders/grader-v2.ts`
- Modify: `test/grader-v2.test.ts`

- [ ] **Step 5.1: Write failing test**

Append to `test/grader-v2.test.ts`:

```typescript
describe('gradeV2 — set match', () => {
  it('matches sets ignoring order', () => {
    const r = gradeV2('\\{1, 2, 3\\}', '\\{3, 1, 2\\}');
    expect(r.match).toBe(true);
    expect(r.method).toBe('set');
  });

  it('matches sets across LaTeX/plain', () => {
    const r = gradeV2('\\{-1/8, 3/2\\}', '{3/2, -1/8}');
    expect(r.match).toBe(true);
  });

  it('rejects sets with different members', () => {
    expect(gradeV2('\\{1, 2\\}', '\\{1, 3\\}').match).toBe(false);
  });
});

describe('gradeV2 — interval match', () => {
  it('matches intervals across notation', () => {
    expect(gradeV2('[1, 5]', '[1,5]').match).toBe(true);
    expect(gradeV2('(0, \\infty)', '(0,inf)').match).toBe(true);
  });

  it('matches conditional vs interval', () => {
    expect(gradeV2('x >= 11/2', '[\\frac{11}{2}, \\infty)').match).toBe(true);
  });
});

describe('gradeV2 — conditional match', () => {
  it('matches "x = a or x = b" against {a, b}', () => {
    expect(gradeV2('x = -1/8 or x = 3/2', '\\{-1/8, 3/2\\}').match).toBe(true);
  });
});
```

- [ ] **Step 5.2: Run test — verify it fails**

Run: `npm test -- grader-v2`
Expected: 6 new tests fail.

- [ ] **Step 5.3: Implement set/interval/conditional matching**

In `benchmark/graders/grader-v2.ts`, replace the body of `gradeV2()` so that after the numeric stage, it dispatches based on `kind`. Insert these helpers above `gradeV2`:

```typescript
/** Split a comma-separated list at top level (depth 0). */
function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0 && ch === sep) {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((p) => p.trim());
}

/** Extract set members from "{a, b, c}" / "\{a, b, c\}". */
function setMembers(s: string): string[] | null {
  const stripped = s.replace(/^\\\{|^\{/, '').replace(/\\\}$|\}$/, '');
  if (stripped === s) return null;
  return splitTopLevel(stripped, ',');
}

/** Extract interval bounds from "[a, b]", "(a, b]", "[a, ∞)" → { lo, hi, loOpen, hiOpen }. */
interface Interval { lo: string; hi: string; loOpen: boolean; hiOpen: boolean; }
function parseInterval(s: string): Interval | null {
  const m = s.match(/^([(\[])\s*([^,]+?)\s*,\s*(.+?)\s*([)\]])$/);
  if (!m) return null;
  return { lo: m[2], hi: m[3], loOpen: m[1] === '(', hiOpen: m[4] === ')' };
}

/** Convert a conditional "x >= a" or "x = a or x = b" into a representative form. */
function conditionalToInterval(s: string): Interval | null {
  const ge = s.match(/^[a-zA-Z]\s*>=\s*(.+)$/);
  if (ge) return { lo: ge[1].trim(), hi: 'inf', loOpen: false, hiOpen: true };
  const gt = s.match(/^[a-zA-Z]\s*>\s*(.+)$/);
  if (gt) return { lo: gt[1].trim(), hi: 'inf', loOpen: true, hiOpen: true };
  const le = s.match(/^[a-zA-Z]\s*<=\s*(.+)$/);
  if (le) return { lo: '-inf', hi: le[1].trim(), loOpen: true, hiOpen: false };
  const lt = s.match(/^[a-zA-Z]\s*<\s*(.+)$/);
  if (lt) return { lo: '-inf', hi: lt[1].trim(), loOpen: true, hiOpen: true };
  return null;
}

function conditionalToSet(s: string): string[] | null {
  const parts = s.split(/\s+or\s+/i);
  if (parts.length < 2) return null;
  const out: string[] = [];
  for (const p of parts) {
    const m = p.match(/^[a-zA-Z]\s*=\s*(.+)$/);
    if (!m) return null;
    out.push(m[1].trim());
  }
  return out;
}

function normalizeBound(s: string): string {
  return normalize(s).canonical
    .replace(/\binfty\b/g, 'inf')
    .replace(/^-inf$|^minusinf$/, '-inf');
}
```

Replace the body of `gradeV2()` with:

```typescript
export function gradeV2(
  predicted: string,
  ground: string,
  _opts: GradeOptions = {}
): GradeResultV2 {
  if (predicted.trim() === ground.trim()) {
    return finish(true, 'exact-string-match', 'scalar', 'exact');
  }

  const p = normalize(predicted);
  const g = normalize(ground);

  if (p.canonical && p.canonical === g.canonical) {
    return finish(true, 'normalized-string-match', g.kind, 'normalized');
  }

  if (p.decimal !== null && g.decimal !== null) {
    if (Math.abs(p.decimal - g.decimal) <= NUMERIC_TOLERANCE) {
      return finish(true, 'numeric-tolerance-match', g.kind, 'numeric');
    }
    // Fall through — maybe symbolic equivalence still helps.
  }

  // Set match — order-insensitive
  const pSet = setMembers(p.canonical) ?? conditionalToSet(p.canonical);
  const gSet = setMembers(g.canonical) ?? conditionalToSet(g.canonical);
  if (pSet && gSet && pSet.length === gSet.length) {
    const pn = pSet.map((m) => normalize(m).canonical).sort();
    const gn = gSet.map((m) => normalize(m).canonical).sort();
    if (pn.every((v, i) => v === gn[i])) {
      return finish(true, 'set-equal', 'set', 'set');
    }
  }

  // Interval match
  const pI = parseInterval(p.canonical) ?? conditionalToInterval(p.canonical);
  const gI = parseInterval(g.canonical) ?? conditionalToInterval(g.canonical);
  if (pI && gI) {
    if (
      normalizeBound(pI.lo) === normalizeBound(gI.lo) &&
      normalizeBound(pI.hi) === normalizeBound(gI.hi) &&
      pI.loOpen === gI.loOpen &&
      pI.hiOpen === gI.hiOpen
    ) {
      return finish(true, 'interval-equal', 'interval', 'interval');
    }
  }

  return finish(false, 'no-match', g.kind, 'none');
}
```

- [ ] **Step 5.4: Run test — verify it passes**

Run: `npm test -- grader-v2`
Expected: all 10 tests pass.

- [ ] **Step 5.5: Commit**

```bash
git add benchmark/graders/grader-v2.ts test/grader-v2.test.ts
git commit -m "feat(benchmark): grader-v2 set, interval, and conditional matching"
```

---

## Task 6: Giac bridge — lazy init, timeout, cache

**Files:**
- Create: `benchmark/graders/giac-bridge.ts`
- Test: `test/giac-bridge.test.ts`

- [ ] **Step 6.1: Write failing test**

Create `test/giac-bridge.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createGiacBridge } from '../benchmark/graders/giac-bridge.js';

describe('giac-bridge', () => {
  it('caches identical calls', async () => {
    const fake = vi.fn().mockResolvedValue('0');
    const bridge = createGiacBridge({ engine: { evaluate: fake }, timeoutMs: 100 });
    const a = await bridge.evaluate('simplify(x - x)');
    const b = await bridge.evaluate('simplify(x - x)');
    expect(a).toBe('0');
    expect(b).toBe('0');
    expect(fake).toHaveBeenCalledTimes(1);
  });

  it('returns null on timeout', async () => {
    const slow = () => new Promise<string>((resolve) => setTimeout(() => resolve('0'), 200));
    const bridge = createGiacBridge({ engine: { evaluate: slow }, timeoutMs: 50 });
    const result = await bridge.evaluate('simplify(huge_expr)');
    expect(result).toBeNull();
  });

  it('returns null on engine error', async () => {
    const bridge = createGiacBridge({
      engine: { evaluate: () => Promise.reject(new Error('boom')) },
      timeoutMs: 100,
    });
    expect(await bridge.evaluate('bad')).toBeNull();
  });
});
```

- [ ] **Step 6.2: Run test — verify it fails**

Run: `npm test -- giac-bridge`
Expected: module not found.

- [ ] **Step 6.3: Implement giac bridge**

Create `benchmark/graders/giac-bridge.ts`:

```typescript
export interface GiacEngineLike {
  evaluate(expression: string): Promise<string>;
}

export interface GiacBridge {
  evaluate(expr: string): Promise<string | null>;
}

export interface GiacBridgeOptions {
  engine: GiacEngineLike;
  timeoutMs?: number;
}

/**
 * Wraps a Giac-like engine with an in-memory cache and a per-call timeout.
 * Returns `null` on timeout or engine error so callers can degrade gracefully.
 */
export function createGiacBridge(opts: GiacBridgeOptions): GiacBridge {
  const cache = new Map<string, string>();
  const timeoutMs = opts.timeoutMs ?? 2000;

  return {
    async evaluate(expr: string): Promise<string | null> {
      const key = expr.trim();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;

      try {
        const result = await Promise.race([
          opts.engine.evaluate(key),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (result === null) return null;
        cache.set(key, result);
        return result;
      } catch {
        return null;
      }
    },
  };
}

/**
 * Default bridge backed by the project's Giac WASM engine.
 * Lazy — does not initialize Giac unless `evaluate` is actually called.
 */
let defaultBridge: GiacBridge | null = null;
export async function getDefaultGiacBridge(): Promise<GiacBridge> {
  if (defaultBridge) return defaultBridge;
  const { giacEngine } = await import('../../src/server/giac/wrapper.js');
  await giacEngine.initialize();
  defaultBridge = createGiacBridge({ engine: giacEngine, timeoutMs: 2000 });
  return defaultBridge;
}
```

- [ ] **Step 6.4: Run test — verify it passes**

Run: `npm test -- giac-bridge`
Expected: all 3 tests pass.

- [ ] **Step 6.5: Commit**

```bash
git add benchmark/graders/giac-bridge.ts test/giac-bridge.test.ts
git commit -m "feat(benchmark): giac bridge with timeout + cache"
```

---

## Task 7: Grader v2 — symbolic equivalence stage

**Files:**
- Modify: `benchmark/graders/grader-v2.ts`
- Modify: `test/grader-v2.test.ts`

- [ ] **Step 7.1: Write failing test**

Append to `test/grader-v2.test.ts`:

```typescript
import { vi } from 'vitest';

describe('gradeV2 — symbolic equivalence', () => {
  function fakeBridge(map: Record<string, string>) {
    return {
      evaluate: async (expr: string) => map[expr] ?? null,
    };
  }

  it('matches expressions that simplify to 0', async () => {
    const bridge = fakeBridge({
      'simplify((cos(x)*x^2+sin(x)*2*x) - (2*x*sin(x)+x^2*cos(x)))': '0',
    });
    const r = await gradeV2Async(
      'cos(x)*x^2+sin(x)*2*x',
      '2*x*sin(x)+x^2*cos(x)',
      { giacEval: bridge.evaluate }
    );
    expect(r.match).toBe(true);
    expect(r.method).toBe('symbolic');
  });

  it('returns false when simplify is non-zero', async () => {
    const bridge = fakeBridge({
      'simplify(x - 2)': 'x-2',
    });
    const r = await gradeV2Async('x', '2', { giacEval: bridge.evaluate });
    expect(r.match).toBe(false);
  });

  it('skips symbolic when bridge unavailable', async () => {
    const r = await gradeV2Async('cos(x)*x^2', '2*x*sin(x)');
    expect(r.match).toBe(false);
    expect(r.method).toBe('none');
  });
});
```

Add `gradeV2Async` import to the test:

```typescript
import { gradeV2, gradeV2Async } from '../benchmark/graders/grader-v2.js';
```

- [ ] **Step 7.2: Run test — verify it fails**

Run: `npm test -- grader-v2`
Expected: `gradeV2Async` is not exported.

- [ ] **Step 7.3: Implement async symbolic stage**

Append to `benchmark/graders/grader-v2.ts`:

```typescript
/**
 * Async variant: same as gradeV2 but adds a final symbolic-equivalence stage
 * via Giac when an evaluator is provided.
 */
export async function gradeV2Async(
  predicted: string,
  ground: string,
  opts: GradeOptions = {}
): Promise<GradeResultV2> {
  const sync = gradeV2(predicted, ground, opts);
  if (sync.match) return sync;

  if (!opts.giacEval) return sync;

  // Only attempt symbolic equivalence when both sides are symbolic-ish.
  const p = normalize(predicted);
  const g = normalize(ground);
  if (!p.canonical || !g.canonical) return sync;
  if (p.kind === 'scalar' && g.kind === 'scalar') return sync;
  if (p.kind === 'set' || g.kind === 'set') return sync;
  if (p.kind === 'interval' || g.kind === 'interval') return sync;

  const expr = `simplify((${p.canonical}) - (${g.canonical}))`;
  let result: string | null;
  try {
    result = await opts.giacEval(expr);
  } catch {
    return sync;
  }
  if (result === null) return sync;

  const trimmed = result.trim().replace(/\s+/g, '');
  if (trimmed === '0' || trimmed === '0.0') {
    return finish(true, 'symbolic-equivalence', g.kind, 'symbolic');
  }
  return sync;
}
```

Note: the test calls `await gradeV2Async(...)`. Update test file to use the proper signature. The fakeBridge variant exposes `evaluate` directly; `giacEval` expects `(expr) => Promise<string>` returning a string (not nullable). When the bridge returns null in the test, the async function will see undefined → catch path. The existing tests are designed to feed real strings. Verify by re-reading test cases.

- [ ] **Step 7.4: Run test — verify it passes**

Run: `npm test -- grader-v2`
Expected: all 13 tests pass.

- [ ] **Step 7.5: Commit**

```bash
git add benchmark/graders/grader-v2.ts test/grader-v2.test.ts
git commit -m "feat(benchmark): grader-v2 symbolic equivalence via Giac simplify"
```

---

## Task 8: Wire grader-v2 into existing grader.ts behind feature flag

**Files:**
- Modify: `benchmark/graders/grader.ts`
- Modify: `benchmark/config.ts`
- Modify: `benchmark/index.ts`

- [ ] **Step 8.1: Write failing test**

Append to `test/grader-v2.test.ts`:

```typescript
import { grade } from '../benchmark/graders/grader.js';

describe('grade() shim — v2 toggle', () => {
  it('uses v1 by default', () => {
    delete process.env.AXIOM_GRADER_V2;
    const r = grade('-82/27', '-\\frac{82}{27}');
    expect(r.correct).toBe(true); // already worked in v1 via symbolic norm
  });

  it('uses v2 when AXIOM_GRADER_V2=1', () => {
    process.env.AXIOM_GRADER_V2 = '1';
    const r = grade('\\{1, 2\\}', '\\{2, 1\\}');
    expect(r.correct).toBe(true);
    expect(r.method).toBe('symbolic'); // v1 method label preserved for compatibility
    delete process.env.AXIOM_GRADER_V2;
  });
});
```

- [ ] **Step 8.2: Run test — verify it fails**

Run: `npm test -- grader-v2`
Expected: the v2-toggle case fails because the shim is not wired yet.

- [ ] **Step 8.3: Wire the shim**

Add to the top of `benchmark/graders/grader.ts` (after existing imports):

```typescript
import { gradeV2 } from './grader-v2.js';
```

Modify the `grade()` function — at the very top of its body, add:

```typescript
  if (process.env.AXIOM_GRADER_V2 === '1') {
    const predicted = extractModelAnswer(modelResponse);
    const ground = groundTruth.trim();
    const v2 = gradeV2(predicted, ground);
    if (v2.match) {
      // Map v2 method to v1's method enum so downstream reports stay valid.
      const method = v2.method === 'numeric'
        ? 'numeric'
        : v2.method === 'symbolic' || v2.method === 'set' || v2.method === 'interval' || v2.method === 'conditional' || v2.method === 'normalized'
          ? 'symbolic'
          : 'string';
      return { correct: true, predicted, ground, method };
    }
    // v2 said no — fall through to v1 to give it a chance (we want v2 to be additive at this stage).
  }
```

- [ ] **Step 8.4: Add `--features` flag to config**

In `benchmark/config.ts`, add to `BenchmarkConfig`:

```typescript
  features: string[];
```

In `buildConfig()`, after `model` parsing:

```typescript
  // --- Features ---------------------------------------------------------
  // --features=v2,foo,bar
  let features: string[] = [];
  const featuresArg = args.find((a) => a.startsWith('--features='));
  if (featuresArg) features = featuresArg.slice('--features='.length).split(',').filter(Boolean);
```

Add `features,` to the returned config object.

In `benchmark/index.ts`, after `buildConfig()`:

```typescript
  if (config.features.includes('v2')) process.env.AXIOM_GRADER_V2 = '1';
  if (config.features.length > 0) log(`  Features: ${config.features.join(',')}`);
```

- [ ] **Step 8.5: Run test — verify it passes**

Run: `npm test -- grader-v2`
Expected: all tests pass.

- [ ] **Step 8.6: Smoke test the CLI flag**

Run: `cd benchmark && tsx index.ts --features=v2 --gsm8k --quick --zai 2>&1 | head -20`
(Skip if `ZAI_API_KEY` is not set; just verify the header log shows `Features: v2`.)

- [ ] **Step 8.7: Commit**

```bash
git add benchmark/graders/grader.ts benchmark/config.ts benchmark/index.ts test/grader-v2.test.ts
git commit -m "feat(benchmark): wire grader-v2 behind --features=v2 flag"
```

---

## Task 9: Regression analysis CLI

**Files:**
- Create: `benchmark/analyze.ts`
- Modify: `benchmark/package.json`

- [ ] **Step 9.1: Implement analyze CLI**

Create `benchmark/analyze.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Regression-classification CLI.
 *
 * Reads the most recent *-details.jsonl in ./results and writes a Markdown
 * report classifying every regression and "both wrong" record.
 *
 * Usage: tsx analyze.ts [path/to/details.jsonl]
 */
import { readFile, readdir, writeFile } from 'fs/promises';
import path from 'path';

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result: string;
  success: boolean;
}

interface Detail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: { extractedAnswer: string; correct: boolean; method: string };
  toolAugmented: {
    extractedAnswer: string;
    correct: boolean;
    method: string;
    toolCalls: ToolCall[];
    turns: number;
  };
  regression: boolean;
  improvement: boolean;
}

type Category =
  | 'NO_TOOL_CALL'
  | 'EMPTY_TOOL_RESULT'
  | 'OUTPUT_PARSE_ERROR'
  | 'GRADER_MISMATCH'
  | 'WRONG_TOOL_CALL'
  | 'WRONG_ANSWER';

function classify(d: Detail): Category {
  const tc = d.toolAugmented.toolCalls;
  if (tc.length === 0) return 'NO_TOOL_CALL';

  const empty = tc.some(
    (c) =>
      /Result:\s*\[\]/.test(c.result) ||
      /GIAC_ERROR/.test(c.result) ||
      /\bNaN\b|\bInf\b|\bundef\b/.test(c.result)
  );
  if (empty && !d.toolAugmented.correct) return 'EMPTY_TOOL_RESULT';

  // If any tool result contains the ground truth substring, model probably
  // saw the answer but failed to extract it.
  const gt = d.groundTruth.trim();
  const altGt = gt.replace(/\\frac\{(\d+)\}\{(\d+)\}/g, '$1/$2').trim();
  const containsAnswer = tc.some(
    (c) => c.result.includes(gt) || (altGt !== gt && c.result.includes(altGt))
  );
  if (containsAnswer && !d.toolAugmented.correct) return 'OUTPUT_PARSE_ERROR';

  // If grader-v2 (with the model's extracted answer) would have said yes, this is a grader miss.
  // We don't import grader-v2 here to avoid coupling; flag heuristically.
  if (
    d.baseline.correct &&
    d.toolAugmented.extractedAnswer === d.baseline.extractedAnswer &&
    !d.toolAugmented.correct
  ) {
    return 'GRADER_MISMATCH';
  }

  return 'WRONG_ANSWER';
}

async function findLatestJsonl(dir: string): Promise<string | null> {
  const entries = await readdir(dir);
  const jsonls = entries.filter((f) => f.endsWith('-details.jsonl')).sort();
  return jsonls.length ? path.join(dir, jsonls[jsonls.length - 1]) : null;
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2);
  const filepath =
    arg ?? (await findLatestJsonl(path.resolve('results'))) ??
    (() => {
      throw new Error('No *-details.jsonl found in ./results');
    })();

  const raw = await readFile(filepath, 'utf-8');
  const details: Detail[] = raw
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const regressions = details.filter((d) => d.regression);
  const bothWrong = details.filter((d) => !d.baseline.correct && !d.toolAugmented.correct);

  const counts: Record<Category, number> = {
    NO_TOOL_CALL: 0,
    EMPTY_TOOL_RESULT: 0,
    OUTPUT_PARSE_ERROR: 0,
    GRADER_MISMATCH: 0,
    WRONG_TOOL_CALL: 0,
    WRONG_ANSWER: 0,
  };

  type Tagged = Detail & { category: Category };
  const taggedRegressions: Tagged[] = regressions.map((d) => {
    const c = classify(d);
    counts[c]++;
    return { ...d, category: c };
  });

  const lines: string[] = [];
  lines.push(`# Regression Analysis`);
  lines.push(``);
  lines.push(`**Source:** \`${path.basename(filepath)}\``);
  lines.push(`**Total problems:** ${details.length}`);
  lines.push(`**Regressions:** ${regressions.length}`);
  lines.push(`**Both wrong:** ${bothWrong.length}`);
  lines.push(``);
  lines.push(`## Regression categories`);
  lines.push(``);
  lines.push(`| Category | Count |`);
  lines.push(`|---|---|`);
  for (const [cat, n] of Object.entries(counts)) {
    lines.push(`| ${cat} | ${n} |`);
  }
  lines.push(``);
  lines.push(`## Examples`);
  for (const d of taggedRegressions.slice(0, 20)) {
    lines.push(``);
    lines.push(`### #${d.index} [${d.dataset}] — ${d.category}`);
    lines.push(`- Question: ${d.question.slice(0, 120)}...`);
    lines.push(`- Expected: \`${d.groundTruth}\``);
    lines.push(`- Baseline: \`${d.baseline.extractedAnswer}\` ✓`);
    lines.push(`- Tool: \`${d.toolAugmented.extractedAnswer}\` ✗`);
    if (d.toolAugmented.toolCalls.length > 0) {
      lines.push(`- Tool calls:`);
      for (const tc of d.toolAugmented.toolCalls.slice(0, 4)) {
        const summary = tc.result.split('\n').slice(0, 2).join(' | ').slice(0, 140);
        lines.push(`  - \`${tc.name}\` → ${summary}`);
      }
    }
  }

  const outPath = filepath.replace(/-details\.jsonl$/, '-regression-analysis.md');
  await writeFile(outPath, lines.join('\n') + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`Counts:`, counts);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 9.2: Add npm script**

Edit `benchmark/package.json`. Add `"analyze": "tsx analyze.ts"` to `scripts`.

- [ ] **Step 9.3: Smoke test on existing JSONL**

Run: `cd benchmark && npm run analyze`
Expected: prints `Wrote .../2026-04-08-15-51-27-zai-quick-regression-analysis.md` and a `Counts:` line.

Open the produced Markdown and confirm:
- It lists at least one each of `NO_TOOL_CALL`, `OUTPUT_PARSE_ERROR`, `GRADER_MISMATCH`.
- Total regressions count matches the input file's regression count (8 for the 2026-04-08 run).

- [ ] **Step 9.4: Commit**

```bash
git add benchmark/analyze.ts benchmark/package.json
git commit -m "feat(benchmark): regression analysis CLI"
```

---

## Task 10: Golden test corpus

**Files:**
- Create: `test/golden/fixtures.ts`
- Create: `test/golden/grader.golden.test.ts`
- Create: `test/golden/tool.golden.test.ts`
- Modify: `vitest.config.ts` (only if golden tests don't pick up automatically — verify first)

- [ ] **Step 10.1: Write fixtures**

Create `test/golden/fixtures.ts`:

```typescript
/**
 * Golden corpus seeded from observed benchmark regressions.
 * Each new tool-level or grader-level regression must be added here
 * before the corresponding fix is merged.
 */

export interface GraderCase {
  description: string;
  ground: string;
  candidate: string; // what the model produced (or what we want grader to accept)
  shouldMatch: boolean;
}

export const GRADER_CASES: GraderCase[] = [
  {
    description: 'fraction LaTeX vs plain (regression #45 from 2026-04-08)',
    ground: '-\\frac{82}{27}',
    candidate: '-82/27',
    shouldMatch: true,
  },
  {
    description: 'integer vs fraction (regression #28 CAS — 16/3 was extracted as 8)',
    ground: '16/3',
    candidate: '16/3',
    shouldMatch: true,
  },
  {
    description: 'set order-insensitive',
    ground: '\\{1, 2, 3\\}',
    candidate: '\\{3, 1, 2\\}',
    shouldMatch: true,
  },
  {
    description: 'interval vs conditional (regression #3 MATH L5 — x>=11/2)',
    ground: '\\frac{11}{2}',
    candidate: 'x = 11/2',
    shouldMatch: false, // this is intentionally a non-match: a value is not the same as a condition
  },
  {
    description: 'conditional vs interval — half-line',
    ground: '[\\frac{11}{2}, \\infty)',
    candidate: 'x >= 11/2',
    shouldMatch: true,
  },
  {
    description: 'symbolic equivalence — derivative product rule',
    ground: '2*x*sin(x)+x^2*cos(x)',
    candidate: 'cos(x)*x^2+sin(x)*2*x',
    shouldMatch: true,
  },
];

export interface ToolCase {
  description: string;
  giacInput: string;
  expectedContains: string[]; // substrings that must appear in the Giac result
}

export const TOOL_CASES: ToolCase[] = [
  {
    description: '|5x-1|=|3x+2| should give two solutions',
    giacInput: 'solve(abs(5*x - 1) = abs(3*x + 2), x)',
    expectedContains: ['-1/8', '3/2'],
  },
  {
    description: 'derivative of x^3',
    giacInput: 'diff(x^3, x)',
    expectedContains: ['3*x^2'],
  },
  {
    description: 'definite integral of sqrt(x) on [0, 4]',
    giacInput: 'int(sqrt(x), x, 0, 4)',
    expectedContains: ['16/3'],
  },
  {
    description: 'remainder polynomial division',
    giacInput: 'rem(3*y^4 - 4*y^3 + 5*y^2 - 13*y + 4, 3*y - 2, y)',
    expectedContains: ['-82/27'],
  },
];
```

- [ ] **Step 10.2: Write grader-level golden test**

Create `test/golden/grader.golden.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { gradeV2Async } from '../../benchmark/graders/grader-v2.js';
import { GRADER_CASES } from './fixtures.js';

// Mock Giac evaluator that handles the symbolic-equivalence cases used in the corpus.
const knownSimplifies: Record<string, string> = {
  'simplify((cos(x)*x^2+sin(x)*2*x) - (2*x*sin(x)+x^2*cos(x)))': '0',
};
const giacEval = async (expr: string) => knownSimplifies[expr] ?? expr;

describe('golden grader corpus', () => {
  for (const c of GRADER_CASES) {
    it(c.description, async () => {
      const r = await gradeV2Async(c.candidate, c.ground, { giacEval });
      expect(r.match).toBe(c.shouldMatch);
    });
  }
});
```

- [ ] **Step 10.3: Run grader golden tests**

Run: `npm test -- grader.golden`
Expected: all 6 cases pass. If any fail, fix the grader/normalizer (do NOT relax the test) and re-run.

- [ ] **Step 10.4: Write tool-level golden test (integration)**

Create `test/golden/tool.golden.test.ts`:

```typescript
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../../src/server/giac/wrapper.js';
import { TOOL_CASES } from './fixtures.js';

describe('golden tool corpus (real Giac)', () => {
  beforeAll(async () => {
    await giacEngine.initialize();
  }, 30000);

  for (const c of TOOL_CASES) {
    it(c.description, async () => {
      const result = await giacEngine.evaluate(c.giacInput);
      for (const expected of c.expectedContains) {
        expect(result).toContain(expected);
      }
    }, 15000);
  }
});
```

- [ ] **Step 10.5: Determine where the tool golden test runs**

The integration vitest config (`vitest.config.integration.ts`) includes only `test/integration.test.ts`. We have two options:

**Option A:** Extend the integration config's `include` to also match `test/golden/tool.golden.test.ts`.

Modify `vitest.config.integration.ts`:

```typescript
    include: ['test/integration.test.ts', 'test/golden/tool.golden.test.ts'],
```

**Option B:** Leave the unit-test config alone (it loads the giac mock via setupFiles), since the test imports `giacEngine` directly the mock would intercept it and the assertions would fail meaningfully — that's fine too, but real Giac coverage is the point. Use Option A.

Apply Option A.

- [ ] **Step 10.6: Run tool golden test**

Run: `npm run test:integration -- tool.golden`
Expected: all 4 cases pass. (Allow up to 30 seconds for first Giac initialization.)

- [ ] **Step 10.7: Verify unit-test config picks up grader.golden**

Run: `npm test -- golden`
Expected: 6 grader cases pass; the tool-level test is skipped because it's not in the unit-test include pattern (it lives under `test/golden/` and matches `test/**/*.test.ts`, but the file name ends with `.test.ts` so it WILL be picked up by unit tests too — and it imports the real Giac engine which the mock will substitute, breaking it).

If the tool-level test runs under unit config and fails, exclude it explicitly. Edit `vitest.config.ts`:

```typescript
    exclude: ['test/integration.test.ts', 'test/golden/tool.golden.test.ts'],
```

Re-run `npm test -- golden`. Expected: only grader.golden runs and passes.

- [ ] **Step 10.8: Commit**

```bash
git add test/golden/ vitest.config.ts vitest.config.integration.ts
git commit -m "test(golden): seed corpus from observed benchmark regressions"
```

---

## Task 11: Re-run benchmark with `--features=v2` and write delta report

**Files:**
- Create: `docs/superpowers/specs/2026-05-07-phase-0-results.md`

This task requires `ZAI_API_KEY` (or another provider key) and budget for a 360-problem run (~7 hours per the prior log). If the budget is unavailable now, run a smaller scope first (`--gsm8k --math-l4 --cas --quick`) to get directional signal in ~1 hour.

- [ ] **Step 11.1: Run baseline (current grader, no v2)**

Run: `cd benchmark && npm run quick:zai 2>&1 | tail -40`
Expected: writes `results/<date>-zai-quick.{json,jsonl,md,log}`. Note the timestamp.

- [ ] **Step 11.2: Re-grade prior detail JSONL with v2 (offline regrade)**

The prior run's per-problem traces are already on disk. Build a small offline regrader so we can compare v1 vs v2 on the same model output without paying for another full run.

Create `benchmark/regrade.ts`:

```typescript
#!/usr/bin/env tsx
/**
 * Offline re-grade of an existing *-details.jsonl with grader v2.
 * Outputs a comparison report.
 */
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { gradeV2Async } from './graders/grader-v2.js';
import { getDefaultGiacBridge } from './graders/giac-bridge.js';

interface Detail {
  dataset: string;
  index: number;
  question: string;
  groundTruth: string;
  baseline: { extractedAnswer: string; correct: boolean };
  toolAugmented: { extractedAnswer: string; correct: boolean };
}

async function main(): Promise<void> {
  const [arg] = process.argv.slice(2);
  if (!arg) throw new Error('Usage: tsx regrade.ts <path/to/details.jsonl>');
  const raw = await readFile(arg, 'utf-8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const bridge = await getDefaultGiacBridge();

  let v1Tool = 0;
  let v2Tool = 0;
  let v1Base = 0;
  let v2Base = 0;
  const newImprovements: Detail[] = [];

  for (const line of lines) {
    const d: Detail = JSON.parse(line);
    if (d.baseline.correct) v1Base++;
    if (d.toolAugmented.correct) v1Tool++;

    const baseR = await gradeV2Async(d.baseline.extractedAnswer, d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    const toolR = await gradeV2Async(d.toolAugmented.extractedAnswer, d.groundTruth, {
      giacEval: bridge.evaluate,
    });
    if (baseR.match) v2Base++;
    if (toolR.match) {
      v2Tool++;
      if (!d.toolAugmented.correct) newImprovements.push(d);
    }
  }

  const lines2: string[] = [];
  lines2.push(`# Phase 0 — Grader-Only Re-grade Delta`);
  lines2.push(``);
  lines2.push(`**Source:** \`${path.basename(arg)}\` (n=${lines.length})`);
  lines2.push(``);
  lines2.push(`| Condition | v1 correct | v2 correct | Δ |`);
  lines2.push(`|---|---|---|---|`);
  lines2.push(`| Baseline | ${v1Base} | ${v2Base} | ${v2Base - v1Base} |`);
  lines2.push(`| Tool-augmented | ${v1Tool} | ${v2Tool} | ${v2Tool - v1Tool} |`);
  lines2.push(``);
  lines2.push(`## Newly correct under v2 (tool-augmented condition)`);
  for (const d of newImprovements.slice(0, 20)) {
    lines2.push(`- **#${d.index}** [${d.dataset}] expected \`${d.groundTruth}\`, model said \`${d.toolAugmented.extractedAnswer}\``);
  }

  const outPath = arg.replace(/-details\.jsonl$/, '-regrade.md');
  await writeFile(outPath, lines2.join('\n') + '\n');
  console.log(`Wrote ${outPath}`);
  console.log(`Baseline: ${v1Base} → ${v2Base}`);
  console.log(`Tool-aug: ${v1Tool} → ${v2Tool}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Add to `benchmark/package.json` scripts: `"regrade": "tsx regrade.ts"`.

Run: `cd benchmark && npm run regrade -- results/2026-04-08-15-51-27-zai-quick-details.jsonl`
Expected: prints v1 vs v2 deltas. CAS subdomain in particular should improve substantially.

- [ ] **Step 11.3: Write the Phase 0 results document**

Create `docs/superpowers/specs/2026-05-07-phase-0-results.md`:

```markdown
# Phase 0 — Results

**Date:** [fill in run date]
**Source benchmark:** [paths to JSONL re-graded and any new live runs]

## Grader-only delta (v1 → v2 on prior 2026-04-08 run)

| Dataset | v1 baseline | v2 baseline | v1 tool | v2 tool |
|---|---|---|---|---|
| GSM8K (100) | … | … | … | … |
| MATH L3 (50) | … | … | … | … |
| MATH L4 (50) | … | … | … | … |
| MATH L5 (50) | … | … | … | … |
| Omni-MATH ≥7 (50) | … | … | … | … |
| CAS (60) | … | … | … | … |

## Regression counts

| Category | Before | After |
|---|---|---|
| GRADER_MISMATCH | 5 | … |
| OUTPUT_PARSE_ERROR | 3 | … |
| NO_TOOL_CALL | 0 | … |
| EMPTY_TOOL_RESULT | n/a | … |
| WRONG_ANSWER | 0 | … |

## Phase 0 success-metric check

| Target | Result |
|---|---|
| CAS calculus subdomain ≥ 30% | … |
| GRADER_MISMATCH ≤ 1 | … |

## Findings to feed Phase 1

[Notes on regressions that grader changes did NOT recover — these become the Phase 1 spec input.]
```

Fill the tables in from Step 11.2's output. Commit when complete.

- [ ] **Step 11.4: Commit results**

```bash
git add docs/superpowers/specs/2026-05-07-phase-0-results.md benchmark/regrade.ts benchmark/package.json
git commit -m "docs(phase-0): grader-only delta report on 2026-04-08 run"
```

---

## Self-Review Checklist

After all tasks ship, run these checks before declaring Phase 0 complete:

- [ ] All unit tests pass: `npm test`
- [ ] Integration tests pass: `npm run test:integration`
- [ ] Type check passes: `npm run typecheck`
- [ ] Lint passes: `npm run lint`
- [ ] `--features=v2` flag works end-to-end on a small live run (`npm run gsm8k:quick:zai -- --features=v2`)
- [ ] `npm run analyze` emits a regression report on the latest run
- [ ] `npm run regrade -- <jsonl>` produces a v1→v2 delta
- [ ] Phase 0 results doc is written and committed
- [ ] Spec metric `CAS calculus subdomain 0% → ≥30%` is met OR a written explanation of why exists in the results doc

If a metric is not met, do NOT roll Phase 0 forward — write up the gap in the results doc and either iterate within Phase 0 or re-scope before starting Phase 1.

---

## Out of scope for Phase 0 (deferred to later phases)

- Structured JSON tool output / `\boxed{}` trailing line — Phase 1
- Compute layer preprocessing and fallback chain — Phase 2
- Self-consistency / N-sample voting — Phase 3
- Olympiad-specific prompt — Phase 4
- `analyze` MCP tool — Phase 4 (only if needed)
