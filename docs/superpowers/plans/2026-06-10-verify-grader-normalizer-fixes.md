# Verify order_size + Grader Candidate Pipeline + Normalizer Gaps — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the verify tool's false negatives on taylor/series claims, make grader residue transforms compose with each other and with symbolic equivalence via a candidate pipeline, and close normalizer parse gaps (`e^{-2x}`, `xe^x`, `\cos x`).

**Architecture:** Three components in priority order. (1) `verify` pre-normalizes claim sides through the engine and treats `order_size` residues as zero, plus parses `EXPR at x=a = b` claims. (2) A new pure `candidates.ts` generates a bounded BFS (depth ≤ 2, cap 12) of transformed answer candidates; `gradeV2`'s v3 stage and `gradeV2Async`'s symbolic stage both iterate it. (3) `normalizer.ts` learns multi-char exponents, `e^` → `exp()`, narrow implicit products, and unparenthesized function args.

**Tech Stack:** TypeScript, vitest, Giac WASM via the forked-worker host (`src/server/giac/wrapper.ts`).

**Spec:** `docs/superpowers/specs/2026-06-10-verify-grader-normalizer-fixes-design.md`

**Binding guardrail:** No grader change may create a false positive. The golden corpus (`test/golden/`) and the full existing suite (544 tests) must stay green UNMODIFIED. Every transform is a candidate-producer re-graded against ground truth. If a task makes an existing test fail, STOP and report — do not edit the existing test.

**Execution context:** Work in an isolated git worktree (parallel sessions share this checkout — standing instruction). Create it first via superpowers:using-git-worktrees (branch name: `verify-grader-normalizer`), symlink `node_modules` from the main checkout if missing.

**Conventions:** Tests run from repo root: `npx vitest run test/<file> --reporter=verbose` (or `npm test` for everything). Several new tests need `AXIOM_GRADER_V3` — set/restore it in `beforeAll`/`afterAll` exactly like the existing `test/grader-residue.test.ts` does. Tests that touch the live engine should use generous timeouts (30s first call — WASM init).

---

### Task 1: verify — order_size-aware identity verification

**Files:**
- Modify: `src/server/tools/verify/index.ts`
- Test: `test/verify-order-size.test.ts` (new)

The defect: `verifySymbolic` computes `simplify((taylor(exp(x),x=0,4)) - (poly))` → `x^5*order_size(x)` ≠ `'0'` → FALSE on a true claim. The numeric path dies the same way (`evalf` of an order_size expression → NaN at every test point).

- [ ] **Step 1.1: Write the failing test**

Create `test/verify-order-size.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { verifyHandler } from '../src/server/tools/verify/index.js';

function text(res: { content: { text: string }[] }): string {
  return res.content.map((c) => c.text).join('\n');
}

describe('verify: taylor/series order_size handling', () => {
  it('verifies a true taylor claim symbolically', async () => {
    const res = await verifyHandler({
      claim: 'taylor(exp(x), x=0, 4) = 1 + x + x^2/2 + x^3/6 + x^4/24',
      method: 'symbolic',
    });
    const t = text(res);
    expect(t).toContain('Verified: TRUE');
    expect(t).toContain('Confidence: high');
  }, 30000);

  it('still rejects a WRONG taylor claim (broken coefficient)', async () => {
    const res = await verifyHandler({
      claim: 'taylor(exp(x), x=0, 4) = 1 + x + x^2/2 + x^3/3 + x^4/24',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: FALSE');
  }, 30000);

  it('verifies a true taylor claim with method "both" (numeric path survives)', async () => {
    const res = await verifyHandler({
      claim: 'taylor(sin(x), x=0, 5) = x - 1/6*x^3 + 1/120*x^5',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);

  it('does not disturb plain identity verification', async () => {
    const res = await verifyHandler({
      claim: 'sin(x)^2 + cos(x)^2 = 1',
      method: 'symbolic',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);
});
```

- [ ] **Step 1.2: Run it to verify the right failures**

Run: `npx vitest run test/verify-order-size.test.ts --reporter=verbose`
Expected: tests 1 and 3 FAIL (`Verified: FALSE`), tests 2 and 4 PASS.

- [ ] **Step 1.3: Implement**

In `src/server/tools/verify/index.ts`:

Add to the imports (top of file):

```ts
import { stripOrderTerm } from '../output-cleanup.js';
```

Add two helpers above `verifySymbolic`:

```ts
/**
 * True when `expr` consists ONLY of top-level additive terms that carry an
 * order_size factor — i.e. it is a series remainder, zero for verification
 * purposes. (stripOrderTerm cannot be used here: it returns the ORIGINAL
 * string when stripping would leave nothing.)
 */
function isOrderResidueOnly(expr: string): boolean {
  if (!expr.includes('order_size')) return false;
  const terms: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && (ch === '+' || ch === '-') && cur.trim() !== '') {
      terms.push(cur);
      cur = ch === '-' ? '-' : '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '' && cur.trim() !== '-') terms.push(cur);
  return terms.length > 0 && terms.every((t) => t.includes('order_size'));
}

/**
 * Pre-normalize one side of an identity claim: when it evaluates to a series
 * result carrying an order_size remainder, substitute the bare polynomial.
 * Any evaluation problem leaves the side untouched.
 */
async function normalizeSide(side: string): Promise<string> {
  try {
    const r = await giacEngine.evaluate(side);
    if (r && r !== 'undef' && r.includes('order_size')) {
      const stripped = stripOrderTerm(r);
      if (stripped && stripped !== r) return `(${stripped})`;
    }
  } catch {
    // keep original side
  }
  return side;
}
```

In `verifySymbolic`, replace the zero check:

```ts
    const trimmed = result.trim();
    const isZero = trimmed === '0' || trimmed === '0.0' || isOrderResidueOnly(trimmed);
```

In `handleIdentityVerification`, replace the first two lines:

```ts
  const lhs = await normalizeSide(parsed.lhs ?? '');
  const rhs = await normalizeSide(parsed.rhs ?? '');
```

- [ ] **Step 1.4: Run the new test — all pass**

Run: `npx vitest run test/verify-order-size.test.ts --reporter=verbose`
Expected: 4/4 PASS.

- [ ] **Step 1.5: Run the full suite (guardrail)**

Run: `npm test`
Expected: all existing tests green (544 + 4 new).

- [ ] **Step 1.6: Commit**

```bash
git add src/server/tools/verify/index.ts test/verify-order-size.test.ts
git commit -m "fix(verify): treat order_size series residue as zero in identity checks"
```

---

### Task 2: verify — parse `EXPR at x=a = b` claims

**Files:**
- Modify: `src/server/tools/verify/index.ts` (the `parseClaim` function)
- Test: `test/verify-order-size.test.ts` (extend)

Models phrase point-evaluation claims as `"diff(exp(x),x,4) at x=0 = 1"`; today `parseClaim` finds the first top-level `=` inside `x=0` and builds a nonsense identity.

- [ ] **Step 2.1: Write the failing test**

Append to `test/verify-order-size.test.ts`:

```ts
describe('verify: "EXPR at x=a = b" claims', () => {
  it('verifies a true point-evaluation claim', async () => {
    const res = await verifyHandler({
      claim: 'diff(exp(x), x, 4) at x=0 = 1',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: TRUE');
  }, 30000);

  it('rejects a false point-evaluation claim', async () => {
    const res = await verifyHandler({
      claim: 'diff(exp(x), x, 4) at x=0 = 2',
      method: 'both',
    });
    expect(text(res)).toContain('Verified: FALSE');
  }, 30000);
});
```

- [ ] **Step 2.2: Run it to verify failure**

Run: `npx vitest run test/verify-order-size.test.ts --reporter=verbose`
Expected: the new TRUE-case FAILS (parse produces a wrong identity → FALSE); the false-case may pass trivially.

- [ ] **Step 2.3: Implement**

In `parseClaim` (before the existing `solutionMatch` block), add:

```ts
  // Point-evaluation claim: "EXPR at x=a = b" → identity subst(EXPR, x=a) = b
  const atMatch = claim.match(/^(.+?)\s+at\s+([A-Za-z]\w*)\s*=\s*([^=\s,]+)\s*=\s*(.+)$/i);
  if (atMatch) {
    return {
      type: 'identity',
      lhs: `subst(${atMatch[1].trim()}, ${atMatch[2]}=${atMatch[3]})`,
      rhs: atMatch[4].trim(),
    };
  }
```

- [ ] **Step 2.4: Run the test file — all pass**

Run: `npx vitest run test/verify-order-size.test.ts --reporter=verbose`
Expected: 6/6 PASS.

- [ ] **Step 2.5: Run the full suite (guardrail)**

Run: `npm test`
Expected: all green.

- [ ] **Step 2.6: Commit**

```bash
git add src/server/tools/verify/index.ts test/verify-order-size.test.ts
git commit -m "feat(verify): parse 'EXPR at x=a = b' point-evaluation claims"
```

---

### Task 3: New residue transforms — `stripConstantTail`, `stripBigOTail`, `stripLogAbs`

**Files:**
- Modify: `benchmark/graders/answer-residue.ts`
- Test: `test/grader-residue.test.ts` (extend — do NOT modify existing tests)

Pure functions only — grader integration happens in Task 7.

- [ ] **Step 3.1: Write the failing tests**

Append a new describe block to `test/grader-residue.test.ts` (merge the import into the
existing top-of-file imports — ESM imports cannot sit mid-file):

```ts
import {
  stripConstantTail,
  stripBigOTail,
  stripLogAbs,
} from '../benchmark/graders/answer-residue.js';

describe('residue transforms: +C / big-O / log-abs (pure)', () => {
  it('strips a trailing bare "+ C"', () => {
    expect(stripConstantTail('x^2 + C', 'x^2')).toBe('x^2');
    expect(stripConstantTail('\\frac{e^{2x}}{2} + C', 'exp(2*x)/2')).toBe('\\frac{e^{2x}}{2}');
    expect(stripConstantTail('x^2 + C_1', 'x^2')).toBe('x^2');
  });

  it('does NOT strip when ground truth itself contains C', () => {
    expect(stripConstantTail('C*e^x + C', 'C*exp(x)')).toBeNull();
  });

  it('does NOT strip C-bearing product terms (general vs particular solution)', () => {
    expect(stripConstantTail('e^x/2 + C*e^{-x}', 'exp(x)/2')).toBeNull();
  });

  it('returns null when there is no constant tail', () => {
    expect(stripConstantTail('x^2', 'x^2')).toBeNull();
  });

  it('strips trailing big-O tails, balanced and truncated', () => {
    expect(stripBigOTail('1 + x + \\mathcal{O}(x^5)')).toBe('1 + x');
    expect(stripBigOTail('1 + x + \\mathcal{O}(x^5')).toBe('1 + x');
    expect(stripBigOTail('x - \\frac{x^3}{6} + O(x^6')).toBe('x - \\frac{x^3}{6}');
  });

  it('returns null when there is no big-O tail', () => {
    expect(stripBigOTail('1 + x + x^2/2')).toBeNull();
  });

  it('drops absolute-value bars inside a logarithm only', () => {
    expect(stripLogAbs('\\ln|x| + C')).toBe('\\ln(x) + C');
    expect(stripLogAbs('\\ln\\left|x\\right|')).toBe('\\ln(x)');
    expect(stripLogAbs('|x| + 1')).toBeNull();
    expect(stripLogAbs('ln(x)')).toBeNull();
  });
});
```

- [ ] **Step 3.2: Run to verify failure**

Run: `npx vitest run test/grader-residue.test.ts --reporter=verbose`
Expected: FAIL — the three functions are not exported yet.

- [ ] **Step 3.3: Implement**

Append to `benchmark/graders/answer-residue.ts`:

```ts
const CONSTANT_TAIL = /\s*\+\s*C(?:_\{?\d+\}?)?\s*$/;

/** Strip a trailing bare integration constant "+ C" / "+ C_1". Refuses when
 *  the ground truth itself contains a C (the constant is then meaningful)
 *  or when the C is part of a product term (general-solution shape). */
export function stripConstantTail(s: string, ground: string): string | null {
  if (/C/.test(ground)) return null;
  const m = s.match(CONSTANT_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

const BIG_O_TAIL = /\s*\+\s*(?:\\mathcal\{O\}|O)\s*\(\s*x\s*(?:\^\s*\{?\d+\}?)?\s*\)?\s*$/;

/** Strip a trailing big-O remainder "+ \mathcal{O}(x^5)" / "+ O(x^6)",
 *  including the truncated form with a missing closing paren. */
export function stripBigOTail(s: string): string | null {
  const m = s.match(BIG_O_TAIL);
  if (!m || m.index === undefined) return null;
  const stripped = s.slice(0, m.index).trim();
  return stripped.length > 0 ? stripped : null;
}

/** Replace absolute-value bars DIRECTLY inside a logarithm: "ln|x|" → "ln(x)".
 *  Textbook-convention mismatch only; bars anywhere else are left alone. */
export function stripLogAbs(s: string): string | null {
  const cleaned = s.replace(/\\left\|/g, '|').replace(/\\right\|/g, '|');
  const out = cleaned.replace(/(\\?(?:ln|log))\s*\|([^|]+)\|/g, '$1($2)');
  return out !== cleaned ? out : null;
}
```

Note the `stripLogAbs` return guard compares against `cleaned`, not `s` — a string that only contained `\left|` without a log must return null.

- [ ] **Step 3.4: Run the test file — all pass**

Run: `npx vitest run test/grader-residue.test.ts --reporter=verbose`
Expected: all PASS (old 5 + new 7).

- [ ] **Step 3.5: Commit**

```bash
git add benchmark/graders/answer-residue.ts test/grader-residue.test.ts
git commit -m "feat(grader): residue transforms for +C tail, big-O tail, log-abs convention"
```

---

### Task 4: Extend `stripTrailingConstraint` (text-for, ∈-tails) and `stripValueLabels` (and-separators)

**Files:**
- Modify: `benchmark/graders/answer-residue.ts`
- Test: `test/grader-residue.test.ts` (extend)

- [ ] **Step 4.1: Write the failing tests**

Append to `test/grader-residue.test.ts` (inside a new describe; these call the pure
functions directly — extend the answer-residue import added in Task 3 rather than
adding a duplicate import):

```ts
import { stripTrailingConstraint, stripValueLabels } from '../benchmark/graders/answer-residue.js';

describe('residue transforms: extended constraint/label forms (pure)', () => {
  it('strips a "\\text{ for } x \\neq 1" constraint tail', () => {
    expect(stripTrailingConstraint('x + 1 \\text{ for } x \\neq 1')).toBe('x + 1');
  });

  it('strips a ", C \\in \\mathbb{R}" membership tail', () => {
    expect(stripTrailingConstraint('Ce^{x}, \\quad C \\in \\mathbb{R}')).toBe('Ce^{x}');
  });

  it('still strips the comma form and rejects non-constraints', () => {
    expect(stripTrailingConstraint('x + 1, \\quad x \\neq 1')).toBe('x + 1');
    expect(stripTrailingConstraint('x + 1')).toBeNull();
  });

  it('handles \\text{ and } separators in labeled value lists', () => {
    expect(stripValueLabels('\\lambda = i \\text{ and } \\lambda = -i')).toBe('i, -i');
    expect(stripValueLabels('x = 2 and x = 5')).toBe('2, 5');
  });

  it('keeps rejecting mixed/unlabeled lists', () => {
    expect(stripValueLabels('i \\text{ and } \\lambda = -i')).toBeNull();
  });
});
```

- [ ] **Step 4.2: Run to verify failure**

Run: `npx vitest run test/grader-residue.test.ts --reporter=verbose`
Expected: the 4 new assertions on new forms FAIL; existing ones PASS.

- [ ] **Step 4.3: Implement**

In `benchmark/graders/answer-residue.ts`, replace the `CONSTRAINT_TAIL` constant and `stripTrailingConstraint` with:

```ts
const CONSTRAINT_TAIL =
  /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*[^,]+\s*$/;
const TEXT_FOR_TAIL =
  /\s*,?\s*\\text\{\s*for\s*\}\s*[A-Za-z](?:_\{?\w+\}?)?\s*(?:\\neq\b|≠|!=)\s*\S[^,]*\s*$/;
const IN_SET_TAIL =
  /,\s*(?:\\quad\s*|\\;\s*|\\,\s*)?[A-Za-z](?:_\{?\w+\}?)?\s*\\in\s*\\mathbb\{[A-Z]\}\s*$/;

/** Strip a single trailing domain constraint — ", x ≠ 1", "\text{ for } x \neq 1",
 *  or ", C \in \mathbb{R}". Returns the remainder, or null when no tail matches. */
export function stripTrailingConstraint(s: string): string | null {
  for (const re of [CONSTRAINT_TAIL, TEXT_FOR_TAIL, IN_SET_TAIL]) {
    const m = s.match(re);
    if (m && m.index !== undefined) {
      const stripped = s.slice(0, m.index).trim();
      if (stripped.length > 0) return stripped;
    }
  }
  return null;
}
```

In `stripValueLabels`, replace the first statement:

```ts
  const cleaned = s
    .replace(/\\text\{\s*and\s*\}/g, ', ')
    .replace(/\s+\band\b\s+/g, ', ')
    .replace(/\\quad\b/g, ' ')
    .trim();
```

- [ ] **Step 4.4: Run the test file — all pass**

Run: `npx vitest run test/grader-residue.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 4.5: Run the full suite (guardrail — `stripTrailingConstraint` is live in grader-v2)**

Run: `npm test`
Expected: all green.

- [ ] **Step 4.6: Commit**

```bash
git add benchmark/graders/answer-residue.ts test/grader-residue.test.ts
git commit -m "feat(grader): constraint/label residues learn text-for, set-membership and and-separator forms"
```

---

### Task 5: `extractRHS` — gated single-letter LHS

**Files:**
- Modify: `benchmark/graders/extract-rhs.ts`
- Test: `test/extract-rhs.test.ts` (extend — do NOT modify existing tests)

- [ ] **Step 5.1: Write the failing tests**

Append to `test/extract-rhs.test.ts`:

```ts
describe('extractRHS: allowSingleLetterLHS option', () => {
  it('rejects single-letter LHS by default (unchanged)', () => {
    expect(extractRHS('y = x^2')).toBeNull();
  });

  it('accepts single-letter LHS when the option is set', () => {
    expect(extractRHS('y = x^2', { allowSingleLetterLHS: true })).toBe('x^2');
    expect(extractRHS('y = 3\\,e^{-2x}', { allowSingleLetterLHS: true })).toBe('3\\,e^{-2x}');
  });

  it('the option does not loosen anything else', () => {
    expect(extractRHS('a = b = c', { allowSingleLetterLHS: true })).toBeNull();
    expect(extractRHS('= x^2', { allowSingleLetterLHS: true })).toBeNull();
  });
});
```

(Match the import style already used at the top of the file.)

- [ ] **Step 5.2: Run to verify failure**

Run: `npx vitest run test/extract-rhs.test.ts --reporter=verbose`
Expected: FAIL — second argument not accepted / option ignored.

- [ ] **Step 5.3: Implement**

In `benchmark/graders/extract-rhs.ts`, change the signature and the LHS check:

```ts
export interface ExtractRHSOptions {
  /** Accept a single-letter LHS like "y = …". Callers must enable this ONLY
   *  when the ground truth is an expression (not a scalar) — "x = 5" vs "5"
   *  must keep failing (golden corpus). */
  allowSingleLetterLHS?: boolean;
}

export function extractRHS(input: string, opts: ExtractRHSOptions = {}): string | null {
```

and replace the final LHS validation block:

```ts
  // LHS must look like a function call OR a multi-character symbolic name.
  // Single bare variables ("x", "y", "a") are rejected unless explicitly allowed.
  const looksLikeFunctionCall = /\(/.test(lhs);
  const isMultiCharSymbol = /[A-Za-z]{2,}/.test(lhs);
  const isSingleLetter = /^[A-Za-z]'?$/.test(lhs);
  if (
    !looksLikeFunctionCall &&
    !isMultiCharSymbol &&
    !(opts.allowSingleLetterLHS && isSingleLetter)
  ) {
    return null;
  }
```

- [ ] **Step 5.4: Run the test file — all pass**

Run: `npx vitest run test/extract-rhs.test.ts --reporter=verbose`
Expected: all PASS (existing + new).

- [ ] **Step 5.5: Commit**

```bash
git add benchmark/graders/extract-rhs.ts test/extract-rhs.test.ts
git commit -m "feat(grader): extractRHS gains gated single-letter LHS acceptance"
```

---

### Task 6: Candidate generator — `benchmark/graders/candidates.ts`

**Files:**
- Create: `benchmark/graders/candidates.ts`
- Test: `test/grader-candidates.test.ts` (new)

- [ ] **Step 6.1: Write the failing tests**

Create `test/grader-candidates.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateCandidates } from '../benchmark/graders/candidates.js';

describe('generateCandidates', () => {
  it('always returns the original string first', () => {
    const c = generateCandidates('x^2', 'x^2');
    expect(c[0]).toEqual({ value: 'x^2', viaEquationRHS: false });
  });

  it('produces depth-2 chains (RHS extraction then +C strip)', () => {
    const values = generateCandidates('y = x^2 + C', 'x^2').map((c) => c.value);
    expect(values).toContain('x^2');
  });

  it('marks RHS-derived candidates', () => {
    const c = generateCandidates("f'(x) = 3x^2", '3*x^2');
    const rhs = c.find((k) => k.value === '3x^2');
    expect(rhs?.viaEquationRHS).toBe(true);
  });

  it('does NOT extract bare "x = 5" when ground truth is a scalar', () => {
    const values = generateCandidates('x = 5', '5').map((c) => c.value);
    expect(values).toEqual(['x = 5']);
  });

  it('allows single-letter LHS when ground truth is an expression', () => {
    const values = generateCandidates('y = 3e^{-2x}', '3*exp(-2*x)').map((c) => c.value);
    expect(values).toContain('3e^{-2x}');
  });

  it('dedupes and respects the cap', () => {
    const c = generateCandidates('x + 1, \\quad x \\neq 1', 'x+1');
    const values = c.map((k) => k.value);
    expect(new Set(values).size).toBe(values.length);
    expect(c.length).toBeLessThanOrEqual(12);
  });

  it('chains constraint strip then RHS extraction', () => {
    const values = generateCandidates('y(x) = Ce^{x}, \\quad C \\in \\mathbb{R}', 'C*exp(x)').map(
      (c) => c.value
    );
    expect(values).toContain('Ce^{x}');
  });
});
```

- [ ] **Step 6.2: Run to verify failure**

Run: `npx vitest run test/grader-candidates.test.ts --reporter=verbose`
Expected: FAIL — module does not exist.

- [ ] **Step 6.3: Implement**

Create `benchmark/graders/candidates.ts`:

```ts
import { extractRHS } from './extract-rhs.js';
import { normalize } from './normalizer.js';
import {
  stripTrailingConstraint,
  stripValueLabels,
  stripConstantTail,
  stripBigOTail,
  stripLogAbs,
} from './answer-residue.js';

export interface Candidate {
  value: string;
  /** True when an equation-RHS extraction contributed to this candidate. */
  viaEquationRHS: boolean;
}

const MAX_CANDIDATES = 12;
const MAX_DEPTH = 2;

/**
 * Generate grading candidates for a predicted answer: the original string
 * first, then every distinct result of composing residue transforms up to
 * MAX_DEPTH times (BFS, deduped, capped). Pure function. Transforms can never
 * make a wrong answer right — the caller re-grades every candidate against
 * the ground truth.
 */
export function generateCandidates(predicted: string, ground: string): Candidate[] {
  const allowSingleLetterLHS = normalize(ground).kind === 'expression';
  const transforms: Array<{ rhs: boolean; apply: (s: string) => string | null }> = [
    { rhs: true, apply: (s) => extractRHS(s, { allowSingleLetterLHS }) },
    { rhs: false, apply: stripTrailingConstraint },
    { rhs: false, apply: stripValueLabels },
    { rhs: false, apply: (s) => stripConstantTail(s, ground) },
    { rhs: false, apply: stripBigOTail },
    { rhs: false, apply: stripLogAbs },
  ];

  const seen = new Set<string>([predicted]);
  const out: Candidate[] = [{ value: predicted, viaEquationRHS: false }];
  let frontier: Candidate[] = [out[0]];

  for (let depth = 0; depth < MAX_DEPTH && out.length < MAX_CANDIDATES; depth++) {
    const next: Candidate[] = [];
    for (const cand of frontier) {
      for (const t of transforms) {
        const v = t.apply(cand.value);
        if (v === null) continue;
        const trimmed = v.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const c: Candidate = {
          value: trimmed,
          viaEquationRHS: cand.viaEquationRHS || t.rhs,
        };
        out.push(c);
        next.push(c);
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
    frontier = next;
  }
  return out;
}
```

- [ ] **Step 6.4: Run the test file — all pass**

Run: `npx vitest run test/grader-candidates.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 6.5: Commit**

```bash
git add benchmark/graders/candidates.ts test/grader-candidates.test.ts
git commit -m "feat(grader): bounded BFS candidate generator over residue transforms"
```

---

### Task 7: Pipeline integration — `gradeV2` v3 loop + `gradeV2Async` per-candidate symbolic

**Files:**
- Modify: `benchmark/graders/grader-v2.ts`
- Test: `test/grader-candidate-pipeline.test.ts` (new)

- [ ] **Step 7.1: Write the failing tests**

Create `test/grader-candidate-pipeline.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gradeV2, gradeV2Async } from '../benchmark/graders/grader-v2.js';
import { getDefaultGiacBridge } from '../benchmark/graders/giac-bridge.js';

let prev: string | undefined;
beforeAll(() => {
  prev = process.env.AXIOM_GRADER_V3;
  process.env.AXIOM_GRADER_V3 = '1';
});
afterAll(() => {
  if (prev === undefined) delete process.env.AXIOM_GRADER_V3;
  else process.env.AXIOM_GRADER_V3 = prev;
});

describe('candidate pipeline — sync composition', () => {
  it('recovers ODE answer with label and +C: "y = x^2 + C" vs "x^2"', () => {
    expect(gradeV2('y = x^2 + C', 'x^2').match).toBe(true);
  });

  it('guard: wrong RHS stays wrong through every transform', () => {
    expect(gradeV2('y = x^3 + C', 'x^2').match).toBe(false);
  });

  it('golden invariant: "x = 5" vs scalar "5" still fails', () => {
    expect(gradeV2('x = 5', '5').match).toBe(false);
  });

  it('recovers big-O tail behind an equation prefix (truncated paren)', () => {
    expect(
      gradeV2(
        '\\sin(x) = x - \\frac{x^3}{6} + \\frac{x^5}{120} + \\mathcal{O}(x^7',
        'x-x^3/6+x^5/120'
      ).match
    ).toBe(true);
  });

  it('guard: big-O strip cannot fix a wrong coefficient', () => {
    expect(
      gradeV2(
        '\\sin(x) = x - \\frac{x^3}{3} + \\frac{x^5}{120} + \\mathcal{O}(x^7',
        'x-x^3/6+x^5/120'
      ).match
    ).toBe(false);
  });

  it('recovers "x + 1 \\text{ for } x \\neq 1" vs "x+1"', () => {
    expect(gradeV2('x + 1 \\text{ for } x \\neq 1', 'x+1').match).toBe(true);
  });

  it('recovers "\\lambda = i \\text{ and } \\lambda = -i" vs "i,-i"', () => {
    expect(gradeV2('\\lambda = i \\text{ and } \\lambda = -i', 'i,-i').match).toBe(true);
  });
});

describe('candidate pipeline — symbolic equivalence reaches candidates', () => {
  it('verifies f\'(x)-labeled derivative via Giac', async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async("f'(x) = \\dfrac{-4x}{(x^2-1)^2}", '-4*x/(x^2-1)^2', {
      giacEval,
    });
    expect(r.match).toBe(true);
  }, 30000);

  it('verifies restated-LHS partial fractions via Giac', async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async(
      '\\dfrac{1}{x^2-1} = \\dfrac{1}{2(x-1)} - \\dfrac{1}{2(x+1)}',
      '1/(2*(x-1))-1/(2*(x+1))',
      { giacEval }
    );
    expect(r.match).toBe(true);
  }, 30000);

  it('guard: symbolic stage cannot pass a wrong labeled answer', async () => {
    const bridge = await getDefaultGiacBridge();
    const giacEval = (e: string) => bridge.evaluate(e);
    const r = await gradeV2Async("f'(x) = \\dfrac{-3x}{(x^2-1)^2}", '-4*x/(x^2-1)^2', {
      giacEval,
    });
    expect(r.match).toBe(false);
  }, 30000);
});
```

- [ ] **Step 7.2: Run to verify failure**

Run: `npx vitest run test/grader-candidate-pipeline.test.ts --reporter=verbose`
Expected: the composition cases and the two async recovery cases FAIL; the guards PASS.

- [ ] **Step 7.3: Implement**

In `benchmark/graders/grader-v2.ts`:

Replace the import of the residue functions with the candidate generator (keep `extractRHS` — still used for the ground-side direction):

```ts
import { extractRHS } from './extract-rhs.js';
import { generateCandidates } from './candidates.js';
```

(remove the `stripTrailingConstraint, stripValueLabels` import line — they are now reached via `candidates.ts`.)

Replace the entire v3 stage inside `gradeV2` (the block guarded by `process.env.AXIOM_GRADER_V3 === '1' && !opts._skipV3`) with:

```ts
  // v3 candidate stage — only when flag set, and skip on recursive calls.
  if (process.env.AXIOM_GRADER_V3 === '1' && !opts._skipV3) {
    const innerOpts: GradeOptions = { ...opts, _skipV3: true };
    for (const cand of generateCandidates(predicted, ground).slice(1)) {
      const r = gradeV2(cand.value, ground, innerOpts);
      if (r.match) {
        return cand.viaEquationRHS
          ? { ...r, method: 'equation-rhs-match' as GradeResultV2['method'] }
          : r;
      }
    }
    const gRHS = extractRHS(ground);
    if (gRHS !== null) {
      const r = gradeV2(predicted, gRHS, innerOpts);
      if (r.match) {
        return { ...r, method: 'equation-rhs-match' as GradeResultV2['method'] };
      }
    }
  }
```

Replace `gradeV2Async` entirely with:

```ts
/**
 * Async variant: same as gradeV2 but adds a symbolic-equivalence stage via
 * Giac when an evaluator is provided. With grader-v3 enabled, the symbolic
 * attempt runs over the full candidate list — residue/RHS-transformed
 * candidates reach simplify((p)-(g)) too, not just the raw string.
 */
export async function gradeV2Async(
  predicted: string,
  ground: string,
  opts: GradeOptions = {}
): Promise<GradeResultV2> {
  const sync = gradeV2(predicted, ground, opts);
  if (sync.match) return sync;

  if (!opts.giacEval) return sync;

  const g = normalize(ground);
  if (!g.canonical) return sync;
  if (g.kind === 'set' || g.kind === 'interval') return sync;

  const v3 = process.env.AXIOM_GRADER_V3 === '1' && !opts._skipV3;
  const candidates = v3
    ? generateCandidates(predicted, ground)
    : [{ value: predicted, viaEquationRHS: false }];

  for (const cand of candidates) {
    const p = normalize(cand.value);
    if (!p.canonical) continue;
    if (p.kind === 'scalar' && g.kind === 'scalar') continue;
    if (p.kind === 'set' || p.kind === 'interval') continue;

    const expr = `simplify((${p.canonical}) - (${g.canonical}))`;
    let result: string | null;
    try {
      result = await opts.giacEval(expr);
    } catch {
      continue;
    }
    if (result === null) continue;

    const trimmed = result.trim().replace(/\s+/g, '');
    if (trimmed === '0' || trimmed === '0.0') {
      return finish(true, 'symbolic-equivalence', g.kind, 'symbolic');
    }
  }
  return sync;
}
```

Behavioral parity note: with v3 off, the candidate list is exactly `[predicted]`, reproducing today's behavior including the kind-guards.

- [ ] **Step 7.4: Run the new test file — all pass**

Run: `npx vitest run test/grader-candidate-pipeline.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 7.5: Run the full suite (guardrail — golden corpus + 544)**

Run: `npm test`
Expected: ALL green, especially `test/golden/`, `test/grader-v2.test.ts`, `test/grader-residue.test.ts`, `test/grader-robustness.test.ts`. If any existing test fails, STOP and report (do not edit it).

- [ ] **Step 7.6: Commit**

```bash
git add benchmark/graders/grader-v2.ts test/grader-candidate-pipeline.test.ts
git commit -m "feat(grader): v3 candidate pipeline — transforms compose with each other and with symbolic equivalence"
```

---

### Task 8: Normalizer gaps — exponent braces, `e^` → `exp()`, implicit products, function args

**Files:**
- Modify: `benchmark/graders/normalizer.ts`
- Test: `test/normalizer-gaps.test.ts` (new)

- [ ] **Step 8.1: Write the failing tests**

Create `test/normalizer-gaps.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalize } from '../benchmark/graders/normalizer.js';

describe('normalizer: exponent braces and Euler base', () => {
  it('keeps single-token exponents brace-free (regression guard)', () => {
    expect(normalize('x^{2}').canonical).toBe('x^2');
    expect(normalize('x^{10}').canonical).toBe('x^10');
  });

  it('parenthesizes multi-token exponents', () => {
    expect(normalize('x^{2y}').canonical).toBe('x^(2y)');
  });

  it('converts a standalone e base to exp()', () => {
    expect(normalize('e^x').canonical).toBe('exp(x)');
    expect(normalize('e^{-2x}').canonical).toBe('exp(-2x)');
  });

  it('splits fused single-char factors off e^', () => {
    expect(normalize('xe^x').canonical).toBe('x*exp(x)');
    expect(normalize('3e^{2x}').canonical).toBe('3*exp(2x)');
    expect(normalize('Ce^{x}').canonical).toBe('C*exp(x)');
  });

  it('leaves longer identifiers fused (conservative)', () => {
    expect(normalize('lambdae^x').canonical).toBe('lambdae^x');
  });

  it('does not touch non-e bases', () => {
    expect(normalize('2^x').canonical).toBe('2^x');
  });
});

describe('normalizer: unparenthesized function arguments', () => {
  it('wraps space-separated args of known functions', () => {
    expect(normalize('\\cos x').canonical).toBe('cos(x)');
    expect(normalize('\\ln x').canonical).toBe('ln(x)');
  });

  it('inserts explicit multiplication before LaTeX function commands', () => {
    expect(normalize('x^{2}\\cos x + 2x\\sin x').canonical).toBe('x^2*cos(x)+2x*sin(x)');
  });

  it('already-parenthesized args are unchanged apart from the * insertion', () => {
    expect(normalize('x\\cos(x)').canonical).toBe('x*cos(x)');
    expect(normalize('\\cos(x)').canonical).toBe('cos(x)');
  });
});

describe('normalizer: direct match payoff on real failure shapes', () => {
  it('"e^x + xe^x" normalizes to the ground-truth form', () => {
    expect(normalize('e^x + xe^x').canonical).toBe('exp(x)+x*exp(x)');
  });
});
```

- [ ] **Step 8.2: Run to verify failure**

Run: `npx vitest run test/normalizer-gaps.test.ts --reporter=verbose`
Expected: most FAIL (current canonicals: `e^-2x`, `xe^x`, `x^2cosx`…). The `x^{2}` regression guards PASS.

- [ ] **Step 8.3: Implement**

In `benchmark/graders/normalizer.ts`:

(a) In `latexToPlain`, immediately BEFORE the line `r = r.replace(/\\text\{([^}]*)\}/g, '$1');`, add:

```ts
  // Known functions: insert explicit '*' when the command directly follows an
  // operand, then wrap a space-separated single-atom argument in parens.
  const FUNC_NAMES = 'arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|ln|log|exp';
  r = r.replace(new RegExp(`([A-Za-z0-9)}])\\s*\\\\(${FUNC_NAMES})\\b`, 'g'), '$1*\\$2');
  r = r.replace(
    new RegExp(`\\\\(${FUNC_NAMES})\\s+([A-Za-z0-9]+(?:\\^[A-Za-z0-9]+)?)`, 'g'),
    '$1($2)'
  );
```

(Longer names come first in the alternation so `arcsin` wins over `sin`.)

(b) In `normalize`, replace the exponent-brace line `s = s.replace(/\^\{([^{}]+)\}/g, '^$1');` with:

```ts
  // Single atomic token keeps the brace-free form (x^{2} → x^2); anything
  // longer needs parens to survive as one exponent (e^{-2x} → e^(-2x)).
  s = s.replace(/\^\{([^{}]+)\}/g, (_m, inner: string) => {
    const tok = inner.trim();
    return /^(\d+|[A-Za-z])$/.test(tok) ? `^${tok}` : `^(${tok})`;
  });
```

(c) Immediately after the set-delimiter restore (the two `SET_OPEN`/`SET_CLOSE` replaces), add:

```ts
  // Split a fused single-char factor off "e^": "xe^x" → "x*e^x", "3e^(2x)" → "3*e^(2x)".
  s = s.replace(/(?<![A-Za-z0-9_])([A-Za-z0-9])e\^/g, '$1*e^');
  // Standalone Euler base → exp(): "e^x" → "exp(x)", "e^(-2x)" → "exp(-2x)".
  s = s.replace(/(?<![A-Za-z0-9_])e\^(\([^()]*\)|[A-Za-z0-9]+)/g, (_m, ex: string) =>
    `exp(${ex.startsWith('(') ? ex.slice(1, -1) : ex})`
  );
```

(d) Keep numeric grading of `exp(...)` working. In `tryEval`, extend the rewrite chain — replace:

```ts
  let e = expr
    .replace(/\bpi\b/g, String(Math.PI))
    .replace(/\be\b/g, String(Math.E))
    .replace(/sqrt\(([^()]+)\)/g, 'Math.sqrt($1)')
    .replace(/\^/g, '**');
```

with:

```ts
  let e = expr
    .replace(/\bpi\b/g, String(Math.PI))
    .replace(/exp\(([^()]+)\)/g, 'Math.exp($1)')
    .replace(/\be\b/g, String(Math.E))
    .replace(/sqrt\(([^()]+)\)/g, 'Math.sqrt($1)')
    .replace(/\^/g, '**');
```

and replace the residue check line:

```ts
  const stripped = e.replace(/Math\.sqrt\([^()]*\)/g, '');
```

with:

```ts
  const stripped = e.replace(/Math\.(?:sqrt|exp)\([^()]*\)/g, '');
```

(e) In `detectKind`, treat `exp` as a known function — add one line to the `stripped` chain, after the `\bsqrt\b` replace:

```ts
    .replace(/\bexp\b/g, '')
```

(f) Keep `is_exact` honest: `exp(2)` is transcendental, exactly like the old `e^2` canonical was. In `normalize`, replace the `has_irrational` line with:

```ts
  const has_irrational = /\bsqrt\b|\bpi\b|\be\b|\bexp\b/.test(canonical);
```

- [ ] **Step 8.4: Run the new test file — all pass**

Run: `npx vitest run test/normalizer-gaps.test.ts --reporter=verbose`
Expected: all PASS.

- [ ] **Step 8.5: Run the full suite (guardrail — the normalizer is in EVERY grading path)**

Run: `npm test`
Expected: ALL green. The golden corpus is the canary here: a normalize change that breaks a previously-matching canonical shows up immediately. If any existing test fails, STOP and report.

- [ ] **Step 8.6: Commit**

```bash
git add benchmark/graders/normalizer.ts test/normalizer-gaps.test.ts
git commit -m "feat(grader): normalizer learns multi-token exponents, exp() base, implicit products, bare function args"
```

---

### Task 9: Full verification + offline regrade evidence

**Files:**
- No source changes. Read-only validation against `benchmark/results/2026-06-10-12-13-49-zai-cas-quick-details.jsonl`.

- [ ] **Step 9.1: Full quality gates**

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all green (544 pre-existing + ~35 new tests).

- [ ] **Step 9.2: Offline regrade of the 2026-06-10 run**

```bash
AXIOM_GRADER_V3=1 npx tsx benchmark/regrade.ts benchmark/results/2026-06-10-12-13-49-zai-cas-quick-details.jsonl
```

Record from the output: v1 vs v2 tool-augmented and baseline counts, the "newly correct" list, and ANY "newly wrong" entries.

Acceptance:
- **Zero newly-wrong** (previously-correct answers must stay correct) — binding; a single regression fails the task.
- Tool-augmented correct count ≥ 50/60 (was 34/60 stored; ~22-24 of the 26 failures are recoverable artifacts).
- Baseline correct count rises too (~12 `+ C` cases; was 39/60).

Report the exact numbers and the per-problem flip list in the task summary. (The verify-tool fixes from Tasks 1-2 do NOT show up in this offline regrade — they need a future live run; say so in the summary rather than hunting for their effect.)

- [ ] **Step 9.3: Production smoke (server side untouched by grader work, but verify changed)**

```bash
npx tsx -e "
import('./src/server/tools/verify/index.js').then(async (m) => {
  const r = await m.verifyHandler({ claim: 'taylor(exp(x), x=0, 4) = 1 + x + x^2/2 + x^3/6 + x^4/24', method: 'both' });
  console.log(r.content.map((c) => c.text).join('\n'));
  process.exit(0);
});
"
```

Expected output contains `Verified: TRUE` and `Confidence: high`, process exits cleanly.

- [ ] **Step 9.4: Commit (only if anything changed — otherwise skip)**

No expected changes; this task produces evidence for the final report.
