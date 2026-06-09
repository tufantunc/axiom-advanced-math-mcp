# CAS Compute Self-Verification (Tier 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `compute` annotate every solve/factor/integrate result with a CAS-derived `Verified:` signal, and for single-equation `solve`, escalate real→complex→numeric using verification as the selector — never discarding a result for failing verification.

**Architecture:** Server-side, deterministic. A new pure module `self-verify.ts` runs round-trip checks via Giac (substitution / expand / differentiation), never throwing. `evalWithLatex` gains an optional `verify` callback + `methodNote` that flow to the text response and (via `normalize`) the JSON envelope's existing `verification` field. `solve.ts` runs an escalation loop; `factor`/`integrate` annotate only.

**Tech Stack:** TypeScript, ES modules (`.js` imports), Vitest (root config runs `test/**/*.test.ts` against the REAL Giac WASM engine; `testTimeout` 60s; no mock setup). Giac WASM.

**Spec:** `docs/superpowers/specs/2026-06-09-cas-self-verification-design.md`

**Safety principle:** Verification never discards or alters a result beyond labeling it. A miss → `verified:false`, best answer still returned. Escalation only adds alternatives.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/tools/self-verify.ts` (NEW) | `VerificationResult` + `verifySolveSet`/`verifySystem`/`verifyFactor`/`verifyIntegrate` (Giac round-trip, never throw) |
| `src/server/tools/response-formatter.ts` (MODIFY) | render `Method:` + `Verified:` lines |
| `src/server/tools/symbolic/cache.ts` (MODIFY) | `CacheEntry.verification` field |
| `src/server/tools/giac-eval.ts` (MODIFY) | `verify?` callback + `methodNote?`; cache verification |
| `src/server/tools/algebra.ts` (MODIFY) | factor → verify callback |
| `src/server/tools/calculus.ts` (MODIFY) | indefinite integrate → verify callback |
| `src/server/tools/solve.ts` (MODIFY) | single-eq escalation + verification; system annotate |
| `src/server/tools/compute/normalize.ts` (MODIFY) | parse `Verified:` line → envelope `verification` |
| `test/self-verify.test.ts` (NEW) | self-verify integration tests |
| `test/response-formatter.test.ts` (NEW) | render unit tests |
| `test/cas-self-verification.test.ts` (NEW) | handler integration tests (solve/factor/integrate/json) |

Note: `ComputeEnvelope.verification?: VerificationInfo { status; check }` ALREADY exists in `compute/types.ts` — reuse it; no types.ts change needed.

---

## Task 1: `self-verify.ts` module

**Files:**
- Create: `src/server/tools/self-verify.ts`
- Test: `test/self-verify.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/self-verify.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import {
  verifySolveSet,
  verifySystem,
  verifyFactor,
  verifyIntegrate,
} from '../src/server/tools/self-verify.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('verifySolveSet', () => {
  it('verifies correct real roots', async () => {
    const v = await verifySolveSet('x^2-4', 'x', ['-2', '2']);
    expect(v.verified).toBe(true);
    expect(v.method).toBe('substitution');
    expect(v.detail).toContain('2/2');
  });
  it('verifies complex roots', async () => {
    expect((await verifySolveSet('x^2+1', 'x', ['i', '-i'])).verified).toBe(true);
  });
  it('rejects a wrong root', async () => {
    expect((await verifySolveSet('x^2-4', 'x', ['-2', '3'])).verified).toBe(false);
  });
  it('treats an empty solution set as unverified', async () => {
    const v = await verifySolveSet('x^2+1', 'x', []);
    expect(v.verified).toBe(false);
  });
  it('handles an equation written with =', async () => {
    expect((await verifySolveSet('x^2=4', 'x', ['-2', '2'])).verified).toBe(true);
  });
});

describe('verifySystem', () => {
  it('verifies a correct tuple', async () => {
    expect((await verifySystem(['x+y=3', 'x-y=1'], ['x', 'y'], ['2', '1'])).verified).toBe(true);
  });
  it('rejects a tuple/variable count mismatch', async () => {
    expect((await verifySystem(['x+y=3'], ['x', 'y'], ['2'])).verified).toBe(false);
  });
});

describe('verifyFactor', () => {
  it('verifies a correct factorization', async () => {
    const v = await verifyFactor('x^2-4', '(x-2)*(x+2)');
    expect(v.verified).toBe(true);
    expect(v.method).toBe('expand');
  });
  it('rejects a wrong factorization', async () => {
    expect((await verifyFactor('x^2-4', '(x-2)*(x+3)')).verified).toBe(false);
  });
});

describe('verifyIntegrate', () => {
  it('verifies a correct antiderivative', async () => {
    const v = await verifyIntegrate('2*x', 'x', 'x^2');
    expect(v.verified).toBe(true);
    expect(v.method).toBe('differentiation');
  });
  it('rejects a wrong antiderivative', async () => {
    expect((await verifyIntegrate('2*x', 'x', 'x^3')).verified).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/self-verify.test.ts`
Expected: FAIL — module `../src/server/tools/self-verify.js` not found.

- [ ] **Step 3: Write the implementation**

Create `src/server/tools/self-verify.ts`:

```ts
import { giacEngine } from '../giac/index.js';

export interface VerificationResult {
  verified: boolean;
  method: string; // 'substitution' | 'expand' | 'differentiation'
  detail: string;
}

/** Normalize "lhs=rhs" to "(lhs)-(rhs)"; wrap in parens if no '='. */
function toZeroForm(equation: string): string {
  const idx = equation.indexOf('=');
  if (idx !== -1) {
    const lhs = equation.slice(0, idx).trim();
    const rhs = equation.slice(idx + 1).trim();
    return `(${lhs})-(${rhs})`;
  }
  return `(${equation})`;
}

/** True iff evalf(subst(zeroForm, substs)) is numerically ~0. Never throws. */
async function isZeroAfterSubst(zeroForm: string, substs: string): Promise<boolean> {
  try {
    const r = await giacEngine.evaluate(`evalf(subst(${zeroForm},${substs}))`);
    const n = parseFloat(r);
    return !isNaN(n) && Math.abs(n) < 1e-8;
  } catch {
    return false;
  }
}

/** True iff simplify(expr) is exactly 0. Never throws. */
async function simplifiesToZero(expr: string): Promise<boolean> {
  try {
    const r = await giacEngine.evaluate(`simplify(${expr})`);
    const t = (r ?? '').trim();
    return t === '0' || t === '0.0';
  } catch {
    return false;
  }
}

export async function verifySolveSet(
  equation: string,
  variable: string,
  solutions: string[]
): Promise<VerificationResult> {
  const method = 'substitution';
  if (solutions.length === 0) {
    return { verified: false, method, detail: 'no solutions to verify' };
  }
  const zero = toZeroForm(equation);
  let ok = 0;
  for (const sol of solutions) {
    if (await isZeroAfterSubst(zero, `${variable}=${sol}`)) ok++;
  }
  return {
    verified: ok === solutions.length,
    method,
    detail: `${ok}/${solutions.length} roots satisfy the equation`,
  };
}

export async function verifySystem(
  equations: string[],
  variables: string[],
  tuple: string[]
): Promise<VerificationResult> {
  const method = 'substitution';
  if (tuple.length === 0 || tuple.length !== variables.length) {
    return { verified: false, method, detail: 'solution tuple does not match variables' };
  }
  const substs = variables.map((v, i) => `${v}=${tuple[i]}`).join(',');
  let ok = 0;
  for (const eq of equations) {
    if (await isZeroAfterSubst(toZeroForm(eq), substs)) ok++;
  }
  return {
    verified: ok === equations.length,
    method,
    detail: `${ok}/${equations.length} equations satisfied`,
  };
}

export async function verifyFactor(
  original: string,
  factored: string
): Promise<VerificationResult> {
  const ok = await simplifiesToZero(`expand(${factored})-(${original})`);
  return {
    verified: ok,
    method: 'expand',
    detail: ok ? 'expand(factored) equals the original' : 'expand(factored) does not equal original',
  };
}

export async function verifyIntegrate(
  integrand: string,
  variable: string,
  result: string
): Promise<VerificationResult> {
  const ok = await simplifiesToZero(`diff(${result},${variable})-(${integrand})`);
  return {
    verified: ok,
    method: 'differentiation',
    detail: ok ? 'derivative of the result equals the integrand' : 'derivative does not equal the integrand',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/self-verify.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/self-verify.ts test/self-verify.test.ts
git commit -m "feat(cas): add self-verify module (solve/system/factor/integrate round-trip)"
```

---

## Task 2: render `Verified:` + `Method:` lines

**Files:**
- Modify: `src/server/tools/response-formatter.ts`
- Test: `test/response-formatter.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/response-formatter.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatToolResponse } from '../src/server/tools/response-formatter.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('formatToolResponse — verification rendering', () => {
  it('renders a verified line (always, even when true)', () => {
    const r = formatToolResponse({
      result: '{-2, 2}',
      verification: { verified: true, method: 'substitution', detail: '2/2 roots satisfy the equation' },
    });
    expect(allText(r)).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
  });
  it('renders an unverified line and a method note', () => {
    const r = formatToolResponse({
      result: '{i, -i}',
      methodNote: 'csolve (escalated — no real solution verified)',
      verification: { verified: false, method: 'substitution', detail: '0/2 roots satisfy the equation' },
    });
    const text = allText(r);
    expect(text).toContain('Method: csolve (escalated — no real solution verified)');
    expect(text).toContain('Verified: ✗ (substitution: 0/2 roots satisfy the equation)');
  });
  it('omits both lines when not provided', () => {
    const text = allText(formatToolResponse({ result: '5' }));
    expect(text).not.toContain('Verified:');
    expect(text).not.toContain('Method:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/response-formatter.test.ts`
Expected: FAIL — `verification`/`methodNote` not rendered (lines absent).

- [ ] **Step 3: Write the implementation**

In `src/server/tools/response-formatter.ts`, extend the `MathToolResponse` interface (add two optional fields):

```ts
export interface MathToolResponse {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes?: string[];
  methodNote?: string;
  verification?: { verified: boolean; method: string; detail: string };
}
```

In `formatToolResponse`, after the `if (data.giacCommand) lines.push(\`Command: ${data.giacCommand}\`);` line and BEFORE the `if (data.notes ...)` line, insert:

```ts
  if (data.methodNote) lines.push(`Method: ${data.methodNote}`);
  if (data.verification) {
    const mark = data.verification.verified ? '✓' : '✗';
    lines.push(`Verified: ${mark} (${data.verification.method}: ${data.verification.detail})`);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/response-formatter.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/response-formatter.ts test/response-formatter.test.ts
git commit -m "feat(cas): render Verified and Method lines in tool responses"
```

---

## Task 3: `evalWithLatex` verify callback + cache verification

**Files:**
- Modify: `src/server/tools/symbolic/cache.ts`
- Modify: `src/server/tools/giac-eval.ts`
- Test: `test/cas-self-verification.test.ts`

- [ ] **Step 1: Write the failing test**

Create `test/cas-self-verification.test.ts`:

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

describe('evalWithLatex — verify callback + methodNote', () => {
  it('attaches verification from the verify callback', async () => {
    const r = await evalWithLatex({
      giacExpr: 'factor(x^2-4)',
      operation: 'factor',
      verify: async () => ({ verified: true, method: 'expand', detail: 'ok' }),
    });
    expect(allText(r)).toContain('Verified: ✓ (expand: ok)');
  });
  it('passes methodNote through', async () => {
    const r = await evalWithLatex({
      giacExpr: 'csolve(x^2+1,x)',
      operation: 'solve',
      methodNote: 'csolve (escalated)',
      verify: async () => ({ verified: true, method: 'substitution', detail: '2/2' }),
    });
    expect(allText(r)).toContain('Method: csolve (escalated)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: FAIL — `verify`/`methodNote` not accepted; no `Verified:`/`Method:` lines.

- [ ] **Step 3: Implement — cache.ts**

In `src/server/tools/symbolic/cache.ts`, extend `CacheEntry` (use an inline structural type to keep cache.ts dependency-free):

```ts
export interface CacheEntry {
  result: string;
  latex?: string;
  verification?: { verified: boolean; method: string; detail: string };
}
```

- [ ] **Step 4: Implement — giac-eval.ts**

Replace the ENTIRE contents of `src/server/tools/giac-eval.ts` with:

```ts
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { evaluationCache } from './symbolic/cache.js';
import { stripQuotes, stripOrderTerm } from './output-cleanup.js';
import type { VerificationResult } from './self-verify.js';

export interface EvalOptions {
  giacExpr: string;
  operation: string;
  errorMessage?: string;
  /** Optional caller-supplied cleanup applied to the raw result (e.g. solve's list→set). */
  resultTransform?: (raw: string) => string;
  /** Optional round-trip verification run on the (final) result. Never throws. */
  verify?: (result: string) => Promise<VerificationResult>;
  /** Optional note about which method produced the result (e.g. escalation). */
  methodNote?: string;
}

export async function evalWithLatex(options: EvalOptions) {
  const { giacExpr, operation, errorMessage, resultTransform, verify, methodNote } = options;

  // Transformed results are cached under a separate key so a transformed call
  // and a raw call for the same giacExpr never return each other's result.
  // Assumes at most one transform variant per giacExpr (production uses only
  // listToSet, applied solely to solve expressions).
  const cacheKey = resultTransform ? `${giacExpr} transformed` : giacExpr;

  let result: string;
  let latex: string | undefined;
  let verification: VerificationResult | undefined;

  const cached = evaluationCache.get(cacheKey);
  if (cached) {
    result = cached.result;
    latex = cached.latex;
    verification = cached.verification;
  } else {
    let raw = await giacEngine.evaluate(giacExpr);
    if (!raw || raw === 'undef') {
      return formatErrorResponse(errorMessage ?? `Could not compute ${operation}`);
    }

    // Strip the series big-O remainder BEFORE computing latex — the cleaned
    // polynomial re-parses in Giac and yields clean latex.
    raw = stripOrderTerm(raw);

    try {
      const rawLatex = await giacEngine.evaluate(`latex(${raw})`);
      if (rawLatex && rawLatex !== 'undef' && !rawLatex.startsWith('latex')) {
        latex = stripQuotes(rawLatex)
          .replace(/\\dfrac\b/g, '\\frac')
          .replace(/\\displaystyle\s*/g, '')
          .replace(/\\textstyle\s*/g, '');
      }
    } catch {
      /* best effort */
    }

    // Apply the caller transform AFTER latex — e.g. solve's list→set yields set
    // notation ({-2, 2}) that Giac's latex() cannot re-parse, so latex must be
    // derived from the raw (pre-transform) result.
    result = resultTransform ? resultTransform(raw) : raw;

    if (verify) verification = await verify(result);

    evaluationCache.set(cacheKey, { result, latex, verification });
  }

  return formatToolResponse({
    result,
    latex,
    giacCommand: giacExpr,
    verification,
    methodNote,
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/giac-eval.ts src/server/tools/symbolic/cache.ts test/cas-self-verification.test.ts
git commit -m "feat(cas): evalWithLatex verify callback + methodNote, cache verification"
```

---

## Task 4: factor + indefinite-integrate annotation

**Files:**
- Modify: `src/server/tools/algebra.ts`
- Modify: `src/server/tools/calculus.ts`
- Test: `test/cas-self-verification.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/cas-self-verification.test.ts` (add the handler imports at the top of the file):

```ts
import { algebraHandler } from '../src/server/tools/algebra.js';
import { calculusHandler } from '../src/server/tools/calculus.js';

describe('factor / integrate annotation', () => {
  it('factor: shows a verified line', async () => {
    const r = await algebraHandler({ operation: 'factor', expression: 'x^2-4' });
    expect(allText(r)).toContain('Verified: ✓ (expand:');
  });
  it('indefinite integrate: shows a verified line', async () => {
    const r = await calculusHandler({ operation: 'integrate', expression: '2*x', variable: 'x' });
    expect(allText(r)).toContain('Verified: ✓ (differentiation:');
  });
  it('definite integrate: no verification line', async () => {
    const r = await calculusHandler({
      operation: 'integrate',
      expression: 'x',
      variable: 'x',
      lower_bound: '0',
      upper_bound: '1',
    });
    expect(allText(r)).not.toContain('Verified:');
  });
  it('simplify: no verification line (not in scope)', async () => {
    const r = await algebraHandler({ operation: 'simplify', expression: 'x+x' });
    expect(allText(r)).not.toContain('Verified:');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: FAIL — factor/integrate show no `Verified:` line yet.

- [ ] **Step 3: Implement — algebra.ts**

In `src/server/tools/algebra.ts`, add the import and pass a `verify` callback for `factor` only. Change the import block top:

```ts
import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';
import { verifyFactor } from './self-verify.js';
```

Replace the final two lines of `algebraHandler` (the `const giacExpr = ...; return evalWithLatex({ giacExpr, operation });`) with:

```ts
    const giacExpr = buildGiacExpression(operation, args);
    const verify =
      operation === 'factor'
        ? (result: string) => verifyFactor(args.expression as string, result)
        : undefined;
    return evalWithLatex({ giacExpr, operation, verify });
```

- [ ] **Step 4: Implement — calculus.ts**

In `src/server/tools/calculus.ts`, add the import and pass a `verify` callback for INDEFINITE `integrate` only. Change the import block top:

```ts
import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';
import { verifyIntegrate } from './self-verify.js';
```

Replace the final two lines of `calculusHandler` (the `const giacExpr = ...; return evalWithLatex({ giacExpr, operation });`) with:

```ts
    const giacExpr = buildGiacExpression(operation, args);
    const isIndefiniteIntegral =
      operation === 'integrate' &&
      args.lower_bound === undefined &&
      args.upper_bound === undefined;
    const verify = isIndefiniteIntegral
      ? (result: string) => verifyIntegrate(args.expression as string, args.variable as string, result)
      : undefined;
    return evalWithLatex({ giacExpr, operation, verify });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: PASS (all tests in this file).

- [ ] **Step 6: Commit**

```bash
git add src/server/tools/algebra.ts src/server/tools/calculus.ts test/cas-self-verification.test.ts
git commit -m "feat(cas): annotate factor and indefinite integrate with verification"
```

---

## Task 5: solve escalation + verification

**Files:**
- Modify: `src/server/tools/solve.ts`
- Test: `test/cas-self-verification.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/cas-self-verification.test.ts` (add the import at the top):

```ts
import { solveEquationHandler, solveSystemHandler } from '../src/server/tools/solve.js';

describe('solve escalation + verification (D + C)', () => {
  it('real roots verify with no escalation note', async () => {
    const r = await solveEquationHandler({ equation: 'x^2-4', variable: 'x' });
    const t = allText(r);
    expect(t).toContain('Result: {-2, 2}');
    expect(t).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
    expect(t).not.toContain('Method:');
  });
  it('escalates to csolve for complex-only roots', async () => {
    const r = await solveEquationHandler({ equation: 'x^2+1', variable: 'x' });
    const t = allText(r);
    expect(t).toContain('Result: {i, -i}');
    expect(t).toContain('Method: csolve');
    expect(t).toContain('Verified: ✓');
  });
  it('verifies a system solution tuple', async () => {
    const r = await solveSystemHandler({ equations: ['x+y=3', 'x-y=1'], variables: ['x', 'y'] });
    const t = allText(r);
    expect(t).toContain('Result: (2, 1)');
    expect(t).toContain('Verified: ✓');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: FAIL — solve shows no `Verified:`/`Method:` lines; `x^2+1` returns an empty/`{}` result with no escalation.

- [ ] **Step 3: Write the implementation**

Replace the ENTIRE contents of `src/server/tools/solve.ts` with:

```ts
import { giacEngine } from '../giac/index.js';
import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';
import { listToSet, splitTopLevel } from './output-cleanup.js';
import { verifySolveSet, verifySystem, type VerificationResult } from './self-verify.js';

/** Parse a raw Giac solve result (list[...] / [] / [..]) into top-level member strings. */
function parseSolutions(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith('list')) inner = inner.slice(4).trim();
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner, ',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a clean tuple "(a, b)" into ['a','b']; returns [] if not a single tuple. */
function parseTuple(s: string): string[] {
  const t = s.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    return splitTopLevel(t.slice(1, -1), ',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return [];
}

interface Candidate {
  fn: string;
  note?: string;
}

interface Attempt {
  giacExpr: string;
  verification: VerificationResult;
  note?: string;
}

export async function solveEquationHandler(args: Record<string, unknown>) {
  try {
    const equation = args.equation as string;
    const variable = args.variable as string;
    const domain = args.domain as string | undefined;

    if (!equation) return formatErrorResponse("'equation' is required");
    if (!variable) return formatErrorResponse("'variable' is required");

    const validationError = validateExpression(equation);
    if (validationError) return formatErrorResponse(validationError.message);

    const candidates: Candidate[] =
      domain === 'complex'
        ? [{ fn: 'csolve' }, { fn: 'fsolve', note: 'fsolve (numeric fallback)' }]
        : [
            { fn: 'solve' },
            { fn: 'csolve', note: 'csolve (escalated — no real solution verified)' },
            { fn: 'fsolve', note: 'fsolve (numeric fallback)' },
          ];

    let primary: Attempt | null = null;
    let chosen: Attempt | null = null;

    for (const cand of candidates) {
      const giacExpr = `${cand.fn}(${equation},${variable})`;
      let raw: string;
      try {
        raw = await giacEngine.evaluate(giacExpr);
      } catch {
        continue;
      }
      if (!raw || raw === 'undef') continue;
      const verification = await verifySolveSet(equation, variable, parseSolutions(raw));
      if (primary === null) primary = { giacExpr, verification, note: undefined };
      if (verification.verified) {
        chosen = { giacExpr, verification, note: cand.note };
        break;
      }
    }

    const final = chosen ?? primary;
    if (!final) return formatErrorResponse('Could not solve equation');

    return evalWithLatex({
      giacExpr: final.giacExpr,
      operation: 'solve',
      resultTransform: listToSet,
      verify: () => Promise.resolve(final.verification),
      methodNote: final.note,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

export async function solveSystemHandler(args: Record<string, unknown>) {
  try {
    const equations = args.equations as string[];
    const variables = args.variables as string[];

    if (!equations || !Array.isArray(equations) || equations.length === 0) {
      return formatErrorResponse("'equations' must be a non-empty array");
    }
    if (!variables || !Array.isArray(variables) || variables.length === 0) {
      return formatErrorResponse("'variables' must be a non-empty array");
    }

    for (const eq of equations) {
      const validationError = validateExpression(eq);
      if (validationError) return formatErrorResponse(validationError.message);
    }

    const giacExpr = `solve([${equations.join(',')}],[${variables.join(',')}])`;
    const verify = (result: string) => verifySystem(equations, variables, parseTuple(result));
    return evalWithLatex({
      giacExpr,
      operation: 'solve_system',
      resultTransform: listToSet,
      verify,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: PASS (all tests in this file).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/solve.ts test/cas-self-verification.test.ts
git commit -m "feat(cas): solve real->complex->numeric escalation with verification"
```

---

## Task 6: surface verification in the JSON envelope

**Files:**
- Modify: `src/server/tools/compute/normalize.ts`
- Test: `test/cas-self-verification.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/cas-self-verification.test.ts` (add the import at the top):

```ts
import { computeHandler } from '../src/server/tools/compute/index.js';

describe('compute json envelope — verification field', () => {
  it('carries a verified status for a solved equation', async () => {
    const r = await computeHandler({ problem: 'solve(x^2-4,x)', format: 'json' });
    const env = JSON.parse(allText(r));
    expect(env.verification).toBeDefined();
    expect(env.verification.status).toBe('verified');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/cas-self-verification.test.ts -t "verified status for a solved"`
Expected: FAIL — `env.verification` is undefined (normalize does not parse the `Verified:` line).

- [ ] **Step 3: Write the implementation**

In `src/server/tools/compute/normalize.ts`:

(a) Add the type import at the top of the file (next to the other type imports):

```ts
import type { VerificationInfo } from './types.js';
```

(b) Add a `verification` field to the `ParsedFields` interface (the interface ending around line 75 that lists `result`, `decimal`, `latex`, `giacCommand`, `notes`):

```ts
interface ParsedFields {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  verification?: VerificationInfo;
  notes: string[];
}
```

(c) In `parseResponseLines`, add two `else if` branches BEFORE the `else if (line.startsWith('The answer is '))` branch:

```ts
    } else if (line.startsWith('Verified: ')) {
      const rest = line.slice('Verified: '.length).trim();
      fields.verification = {
        status: rest.startsWith('✓') ? 'verified' : 'failed',
        check: rest.replace(/^[✓✗]\s*/, ''),
      };
    } else if (line.startsWith('Method: ')) {
      // Informational model-facing note — not surfaced in the envelope.
```

(d) In the `normalize` function's returned envelope object, add the verification field (next to `latex`/`giac_command` spreads):

```ts
    ...(fields.verification ? { verification: fields.verification } : {}),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/cas-self-verification.test.ts`
Expected: PASS (all tests in this file).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/compute/normalize.ts test/cas-self-verification.test.ts
git commit -m "feat(cas): surface verification in compute json envelope"
```

---

## Task 7: full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS. Watch specifically for:
- `test/golden/tool.golden.test.ts` is excluded from the default run (integration config) — not a concern here.
- Any existing solve/factor/integrate test that asserts EXACT full output (not `toContain`) may now fail because of the added `Verified:` line. If so, that test was asserting output shape; update it to accommodate the new line ONLY if the change is the expected new behavior — and note it in the commit.
- `test/output-hygiene-integration.test.ts` asserts compute output shape — confirm the added line does not break its assertions.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Confirms no import cycle between `self-verify.ts`, `giac-eval.ts`, `cache.ts`.)

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: 0 warnings, 0 errors in touched files.

- [ ] **Step 4: Manual sanity check of the escalation win**

Run: `npx vitest run test/cas-self-verification.test.ts -t "escalates to csolve"`
Expected: PASS — confirms the real→complex escalation produces `{i, -i}` with a `Method: csolve` note and `Verified: ✓`.

- [ ] **Step 5: Commit any incidental fixes**

If steps 1-4 surfaced fixes (e.g. a golden snapshot or an exact-output assertion update):

```bash
git add -A
git commit -m "test(cas): update assertions for the added Verified line"
```

If nothing needed fixing, skip this step.

---

## Self-Review notes (incorporated)

- **Spec coverage:** A (annotate) → Tasks 2/3 (rendering+plumbing) + Task 4 (factor/integrate) + Task 5 (solve/system). C (escalation) → Task 5. self-verify functions → Task 1. JSON envelope (reuses existing `VerificationInfo`) → Task 6. Safety principle (never discard) → Task 5 escalation falls back to `primary`; verify callbacks never throw (Task 1).
- **Reused existing field:** `ComputeEnvelope.verification` / `VerificationInfo {status, check}` already exist in `types.ts` — Task 6 maps the parsed `Verified:` line into them; no types.ts change.
- **Definite vs indefinite integrate:** Task 4 attaches verification only to indefinite integrals (definite integrals return a number, not an antiderivative — `diff` round-trip is invalid).
- **Type consistency:** `VerificationResult { verified, method, detail }` defined in Task 1, imported (type-only) by `giac-eval.ts` and `solve.ts`; `cache.ts` and `response-formatter.ts` use a structurally identical inline type to stay dependency-free. Envelope uses the pre-existing `VerificationInfo { status, check }`.
- **No flags:** all behavior is default-on, independent of `AXIOM_COMPUTE_HYGIENE`.
- **Cache:** verification is cached in `CacheEntry`; `methodNote` is always taken from the current call's options (solve recomputes escalation each call, so it is never stale).
```
