# Multivariable Calculus (M1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class multivariable calculus to the `compute` gateway — differential operators, multiple integrals, and multivariable optimization — promoting vector calculus from raw Giac passthrough to a validated, formatted, server-orchestrated handler.

**Architecture:** A new `src/server/tools/multivariable/` directory with an `index.ts` handler that delegates by `operation` to three sub-modules: `operators.ts` (single-shot Giac calls), `integrals.ts` (nested integrals), and `optimization.ts` (multi-step orchestration). The `compute` router gains a multiple-integral rule above the existing integrate rule and re-points its vector-calculus rule to a new `extractMultivariable` extractor; the dispatcher gains a `multivariable` case.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Giac/Xcas WASM via `giacEngine.evaluate()`, vitest. Existing helpers: `evalWithLatex` (single-shot eval + LaTeX), `formatToolResponse`/`formatErrorResponse`, `validateExpression`.

**Design reference:** `docs/superpowers/specs/2026-06-09-multivariable-calculus-m1-design.md`

**Conventions observed in this codebase:**
- Tests live in top-level `test/`, importing from `../src/server/...js`.
- Handler tests call `await giacEngine.initialize()` in `beforeAll(..., 60000)`, then assert on `result.isError` and `result.content[0].text` (or `.some(c => c.text.includes(...))`).
- Router tests import `route` and assert `result.handler` / `result.args`.
- Each handler returns `{ content: {type:'text', text}[], isError }` via the formatter helpers.
- A refinement over the spec's illustrative usage: `tangent_plane` and `directional_derivative` take an **explicit variable list** as their second argument (`tangent_plane(f, [x,y], [1,1])`) so parsing is unambiguous.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/server/tools/multivariable/operators.ts` | Build + eval single-shot Giac operators (gradient, hessian, jacobian, divergence, curl, partial) |
| `src/server/tools/multivariable/integrals.ts` | Double/triple integrals (structured bounds or raw nested form) |
| `src/server/tools/multivariable/optimization.ts` | Multi-step orchestration: critical_points, lagrange, tangent_plane, directional_derivative |
| `src/server/tools/multivariable/index.ts` | `multivariableHandler(args)` — validate + delegate by `operation` |
| `src/server/tools/compute/extractors.ts` | Add `extractMultivariable()` |
| `src/server/tools/compute/router.ts` | Add multiple-integral rule (above integrate); re-point vector-calculus rule |
| `src/server/tools/compute/dispatcher.ts` | Add `multivariable` case |
| `test/multivariable-operators.test.ts` | Operator unit tests |
| `test/multivariable-integrals.test.ts` | Integral unit tests |
| `test/multivariable-optimization.test.ts` | Optimization unit tests |
| `test/multivariable-router.test.ts` | Router routing + regression tests |

---

## Task 1: Operators module (single-shot Giac)

**Files:**
- Create: `src/server/tools/multivariable/operators.ts`
- Test: `test/multivariable-operators.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/multivariable-operators.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { operatorHandler } from '../src/server/tools/multivariable/operators.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable operators', () => {
  it('gradient of x^2+y^2 is [2*x, 2*y]', async () => {
    const r = await operatorHandler({ operation: 'gradient', expression: 'x^2+y^2', variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('2*x');
    expect(text(r).replace(/\s/g, '')).toContain('2*y');
  });

  it('curl of [y,-x,0] is [0,0,-2]', async () => {
    const r = await operatorHandler({ operation: 'curl', functions: ['y', '-x', '0'], variables: ['x', 'y', 'z'] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('-2');
  });

  it('divergence of [x,y,z] is 3', async () => {
    const r = await operatorHandler({ operation: 'divergence', functions: ['x', 'y', 'z'], variables: ['x', 'y', 'z'] });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('3');
  });

  it('mixed partial of x^2*y^3 wrt x,y is 6*x*y^2', async () => {
    const r = await operatorHandler({ operation: 'partial', expression: 'x^2*y^3', variables: ['x', 'y'] });
    expect(r.isError).toBe(false);
    expect(text(r).replace(/\s/g, '')).toContain('6*x*y^2');
  });

  it('errors when variables missing', async () => {
    const r = await operatorHandler({ operation: 'gradient', expression: 'x^2+y^2' });
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/multivariable-operators.test.ts`
Expected: FAIL — cannot resolve `../src/server/tools/multivariable/operators.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/tools/multivariable/operators.ts
import { evalWithLatex } from '../giac-eval.js';
import { formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../symbolic/validator.js';

const VECTOR_OPS = new Set(['divergence', 'curl', 'jacobian']);

export async function operatorHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const variables = (args.variables as string[]) ?? [];
    if (variables.length === 0) {
      return formatErrorResponse(`'variables' (a non-empty list) is required for ${operation}`);
    }
    const varList = `[${variables.join(',')}]`;

    let giacExpr: string;
    if (VECTOR_OPS.has(operation)) {
      const functions = (args.functions as string[]) ?? [];
      if (functions.length === 0) {
        return formatErrorResponse(`'functions' (a non-empty list) is required for ${operation}`);
      }
      const vec = `[${functions.join(',')}]`;
      const validation = validateExpression(functions.join(','));
      if (validation) return formatErrorResponse(validation.message);
      giacExpr = `${operation}(${vec},${varList})`;
    } else {
      const expression = args.expression as string;
      if (!expression) return formatErrorResponse(`'expression' is required for ${operation}`);
      const validation = validateExpression(expression);
      if (validation) return formatErrorResponse(validation.message);
      if (operation === 'gradient') giacExpr = `grad(${expression},${varList})`;
      else if (operation === 'hessian') giacExpr = `hessian(${expression},${varList})`;
      else if (operation === 'partial') giacExpr = `diff(${expression},${variables.join(',')})`;
      else return formatErrorResponse(`Unknown operator: ${operation}`);
    }

    return evalWithLatex({ giacExpr, operation });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/multivariable-operators.test.ts`
Expected: PASS (5 tests). If Giac prints `grad`/`curl` results with different spacing, the `.replace(/\s/g,'')` assertions already absorb whitespace; if a function name differs in this Giac build, adjust the builder and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/multivariable/operators.ts test/multivariable-operators.test.ts
git commit -m "feat(multivariable): single-shot operators (grad/hessian/jacobian/div/curl/partial)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Integrals module (double/triple)

**Files:**
- Create: `src/server/tools/multivariable/integrals.ts`
- Test: `test/multivariable-integrals.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/multivariable-integrals.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { integralHandler } from '../src/server/tools/multivariable/integrals.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable integrals', () => {
  it('double integral of x*y over [0,1]x[0,2] is 1', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      expression: 'x*y',
      bounds: [
        { variable: 'x', lower: '0', upper: '1' },
        { variable: 'y', lower: '0', upper: '2' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('triple integral of 1 over unit cube is 1', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      expression: '1',
      bounds: [
        { variable: 'x', lower: '0', upper: '1' },
        { variable: 'y', lower: '0', upper: '1' },
        { variable: 'z', lower: '0', upper: '1' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('evaluates a raw nested-int expression', async () => {
    const r = await integralHandler({
      operation: 'multiple_integral',
      raw: 'int(int(x*y,x,0,1),y,0,2)',
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('1');
  });

  it('errors when neither bounds nor raw provided', async () => {
    const r = await integralHandler({ operation: 'multiple_integral', expression: 'x*y' });
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/multivariable-integrals.test.ts`
Expected: FAIL — cannot resolve `integrals.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/tools/multivariable/integrals.ts
import { evalWithLatex } from '../giac-eval.js';
import { formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../symbolic/validator.js';

interface Bound {
  variable: string;
  lower: string;
  upper: string;
}

export async function integralHandler(args: Record<string, unknown>) {
  try {
    // Raw native form: pass straight through (already valid Giac).
    const raw = args.raw as string | undefined;
    if (raw) {
      const validation = validateExpression(raw);
      if (validation) return formatErrorResponse(validation.message);
      return evalWithLatex({ giacExpr: raw, operation: 'multiple_integral' });
    }

    const expression = args.expression as string;
    const bounds = (args.bounds as Bound[]) ?? [];
    if (!expression) return formatErrorResponse("'expression' is required for multiple_integral");
    if (bounds.length < 2) {
      return formatErrorResponse("multiple_integral requires at least 2 integration bounds (use 'int' for a single integral)");
    }
    const validation = validateExpression(expression);
    if (validation) return formatErrorResponse(validation.message);

    // Build nested int(): the first bound is the innermost integral.
    let giacExpr = expression;
    for (const b of bounds) {
      if (!b.variable || b.lower === undefined || b.upper === undefined) {
        return formatErrorResponse('each bound needs variable, lower, and upper');
      }
      giacExpr = `int(${giacExpr},${b.variable},${b.lower},${b.upper})`;
    }

    return evalWithLatex({ giacExpr, operation: 'multiple_integral' });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/multivariable-integrals.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/multivariable/integrals.ts test/multivariable-integrals.test.ts
git commit -m "feat(multivariable): double/triple integrals (structured + raw nested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Optimization — tangent_plane and directional_derivative

These two are single-result compositions (compute partials, substitute a point, assemble). `critical_points` and `lagrange` follow in Tasks 4–5.

**Files:**
- Create: `src/server/tools/multivariable/optimization.ts`
- Test: `test/multivariable-optimization.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/multivariable-optimization.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { optimizationHandler } from '../src/server/tools/multivariable/optimization.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join('\n');

describe('multivariable optimization — tangent_plane & directional_derivative', () => {
  it('tangent plane of x^2+y^2 at (1,1)', async () => {
    // z = 2 + 2(x-1) + 2(y-1) = 2x + 2y - 2
    const r = await optimizationHandler({
      operation: 'tangent_plane',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1', '1'],
    });
    expect(r.isError).toBe(false);
    const flat = text(r).replace(/\s/g, '');
    expect(flat).toContain('2*x');
    expect(flat).toContain('2*y');
  });

  it('directional derivative of x^2+y^2 at (1,1) along (1,0) is 2', async () => {
    // grad = [2,2] at (1,1); unit dir (1,0); Dv = 2
    const r = await optimizationHandler({
      operation: 'directional_derivative',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1', '1'],
      direction: ['1', '0'],
    });
    expect(r.isError).toBe(false);
    expect(text(r)).toContain('2');
  });

  it('errors when point length != variables length', async () => {
    const r = await optimizationHandler({
      operation: 'tangent_plane',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
      point: ['1'],
    });
    expect(r.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: FAIL — cannot resolve `optimization.js`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/server/tools/multivariable/optimization.ts
import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from '../response-formatter.js';
import { validateExpression } from '../symbolic/validator.js';

/** Build a Giac substitution list "[x=1,y=2]" from variables + point values. */
function substList(variables: string[], point: string[]): string {
  return `[${variables.map((v, i) => `${v}=${point[i]}`).join(',')}]`;
}

/** Evaluate a Giac expression, throwing on undef/empty. */
async function giac(expr: string): Promise<string> {
  const out = await giacEngine.evaluate(expr);
  if (!out || out === 'undef') throw new Error(`Giac could not evaluate: ${expr}`);
  return out;
}

export async function optimizationHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;
    const expression = args.expression as string;
    const variables = (args.variables as string[]) ?? [];

    if (!expression) return formatErrorResponse(`'expression' is required for ${operation}`);
    if (variables.length === 0) return formatErrorResponse(`'variables' is required for ${operation}`);
    const validation = validateExpression(expression);
    if (validation) return formatErrorResponse(validation.message);

    if (operation === 'tangent_plane') {
      const point = (args.point as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const f0 = await giac(`subst(${expression},${sub})`);
      const terms: string[] = [f0];
      for (let i = 0; i < variables.length; i++) {
        const slope = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        terms.push(`(${slope})*(${variables[i]}-(${point[i]}))`);
      }
      const plane = await giac(`simplify(${terms.join('+')})`);
      return formatToolResponse({
        result: `z = ${plane}`,
        notes: [`Expansion point: (${point.join(', ')})`, `f at point = ${f0}`],
      });
    }

    if (operation === 'directional_derivative') {
      const point = (args.point as string[]) ?? [];
      const direction = (args.direction as string[]) ?? [];
      if (point.length !== variables.length) {
        return formatErrorResponse("'point' length must match 'variables' length");
      }
      if (direction.length !== variables.length) {
        return formatErrorResponse("'direction' length must match 'variables' length");
      }
      const sub = substList(variables, point);
      const norm = await giac(`sqrt(${direction.map((d) => `(${d})^2`).join('+')})`);
      const parts: string[] = [];
      for (let i = 0; i < variables.length; i++) {
        const gi = await giac(`subst(diff(${expression},${variables[i]}),${sub})`);
        parts.push(`(${gi})*(${direction[i]})`);
      }
      const dv = await giac(`simplify((${parts.join('+')})/(${norm}))`);
      return formatToolResponse({
        result: dv,
        notes: [`Point: (${point.join(', ')})`, `Direction: [${direction.join(', ')}]`, `‖direction‖ = ${norm}`],
      });
    }

    return formatErrorResponse(`Unknown optimization operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/multivariable/optimization.ts test/multivariable-optimization.test.ts
git commit -m "feat(multivariable): tangent_plane and directional_derivative

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Optimization — critical_points (2-variable second-derivative test)

**Files:**
- Modify: `src/server/tools/multivariable/optimization.ts`
- Test: `test/multivariable-optimization.test.ts` (add cases)

- [ ] **Step 1: Add failing tests**

Append inside the existing `describe` block in `test/multivariable-optimization.test.ts`:

```typescript
  it('critical point of x^2+y^2 is a local minimum at (0,0)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2+y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const t = text(r).toLowerCase();
    expect(t).toContain('minimum');
  });

  it('critical point of x^2-y^2 is a saddle at (0,0)', async () => {
    const r = await optimizationHandler({
      operation: 'critical_points',
      expression: 'x^2-y^2',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    expect(text(r).toLowerCase()).toContain('saddle');
  });
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: the two new tests FAIL with "Unknown optimization operation: critical_points".

- [ ] **Step 3: Implement critical_points**

Add this helper above `optimizationHandler` in `optimization.ts`:

```typescript
/**
 * Parse a Giac solve()-with-variable-list result into coordinate tuples.
 * Giac returns "[[0,0]]" (list of solution vectors). Strips one outer bracket
 * layer and splits each inner vector on top-level commas.
 */
function parseSolutionPoints(raw: string): string[][] {
  const trimmed = raw.replace(/^list/, '').trim();
  const inner = trimmed.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return [];
  const points: string[][] = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const coords = current.replace(/^\[/, '').replace(/\]$/, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (coords.length) points.push(coords);
    current = '';
  };
  for (const ch of inner) {
    if (ch === '[') {
      depth++;
      current += ch;
    } else if (ch === ']') {
      depth--;
      current += ch;
    } else if (ch === ',' && depth === 0) {
      flush();
    } else {
      current += ch;
    }
  }
  if (current.trim()) flush();
  return points;
}
```

Add this branch inside `optimizationHandler`, before the final `return formatErrorResponse(...)`:

```typescript
    if (operation === 'critical_points') {
      if (variables.length !== 2) {
        return formatErrorResponse('critical_points classification is supported for exactly 2 variables');
      }
      const [x, y] = variables;
      const stationary = `[diff(${expression},${x}),diff(${expression},${y})]`;
      const grad = await giac(stationary);
      const raw = await giac(`solve(${stationary},[${x},${y}])`);
      const points = parseSolutionPoints(raw);
      if (points.length === 0) {
        return formatToolResponse({
          result: 'No critical points in the real domain',
          notes: [`Gradient: ${grad}`, `solve returned: ${raw}`],
        });
      }

      // Second-derivative test symbols.
      const fxx = `diff(${expression},${x},2)`;
      const fyy = `diff(${expression},${y},2)`;
      const fxy = `diff(diff(${expression},${x}),${y})`;
      const discriminant = `(${fxx})*(${fyy})-(${fxy})^2`;

      const classified: string[] = [];
      for (const pt of points) {
        const sub = substList(variables, pt);
        const D = await giac(`subst(${discriminant},${sub})`);
        const fxxAt = await giac(`subst(${fxx},${sub})`);
        const dNum = Number(D);
        const fxxNum = Number(fxxAt);
        let kind: string;
        if (!Number.isFinite(dNum) || dNum === 0) kind = 'inconclusive (second-derivative test fails, D=0)';
        else if (dNum < 0) kind = 'saddle point';
        else if (fxxNum > 0) kind = 'local minimum';
        else kind = 'local maximum';
        classified.push(`(${pt.join(', ')}): ${kind} [D=${D}, f_xx=${fxxAt}]`);
      }

      return formatToolResponse({
        result: classified.join('; '),
        notes: [`Gradient: ${grad}`, `Discriminant D = f_xx*f_yy - f_xy^2`, ...classified],
      });
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: PASS (5 tests). If `solve` output format differs from `[[0,0]]` in this Giac build (e.g. uses `=` or a different wrapper), inspect the `solve returned:` note from a temporary run and adjust `parseSolutionPoints`.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/multivariable/optimization.ts test/multivariable-optimization.test.ts
git commit -m "feat(multivariable): critical_points with 2-var second-derivative test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Optimization — lagrange

**Files:**
- Modify: `src/server/tools/multivariable/optimization.ts`
- Test: `test/multivariable-optimization.test.ts` (add case)

- [ ] **Step 1: Add failing test**

Append inside the existing `describe` block:

```typescript
  it('lagrange: max xy s.t. x+y=1 yields (1/2, 1/2)', async () => {
    const r = await optimizationHandler({
      operation: 'lagrange',
      expression: 'x*y',
      constraint: 'x+y',
      value: '1',
      variables: ['x', 'y'],
    });
    expect(r.isError).toBe(false);
    const flat = text(r).replace(/\s/g, '');
    expect(flat).toContain('1/2');
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: the new test FAILS with "Unknown optimization operation: lagrange".

- [ ] **Step 3: Implement lagrange**

Add this branch inside `optimizationHandler`, before the final `return formatErrorResponse(...)`:

```typescript
    if (operation === 'lagrange') {
      const constraint = args.constraint as string;
      const value = (args.value as string) ?? '0';
      if (!constraint) return formatErrorResponse("'constraint' is required for lagrange");
      const cValidation = validateExpression(constraint);
      if (cValidation) return formatErrorResponse(cValidation.message);

      // Stationarity: grad(f) = L*grad(g) componentwise, plus constraint g = value.
      const stationarity = variables.map(
        (v) => `diff(${expression},${v})=L*diff(${constraint},${v})`
      );
      const system = `[${stationarity.join(',')},${constraint}=${value}]`;
      const unknowns = `[${variables.join(',')},L]`;
      const raw = await giac(`solve(${system},${unknowns})`);

      const candidates = parseSolutionPoints(raw);
      if (candidates.length === 0) {
        return formatToolResponse({
          result: 'No stationary points found in the real domain',
          notes: [`System: ${system}`, `solve returned: ${raw}`],
        });
      }

      // Report each candidate point (dropping the trailing lambda) and the objective value there.
      const reported: string[] = [];
      for (const cand of candidates) {
        const coords = cand.slice(0, variables.length);
        const sub = substList(variables, coords);
        const fVal = await giac(`subst(${expression},${sub})`);
        reported.push(`(${coords.join(', ')}): f = ${fVal}`);
      }

      return formatToolResponse({
        result: reported.join('; '),
        notes: [`Constraint: ${constraint} = ${value}`, `Candidates (Lagrange):`, ...reported],
      });
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/multivariable-optimization.test.ts`
Expected: PASS (6 tests). If `solve` orders the unknowns differently or wraps lambda, the `solve returned:` note reveals the shape; `parseSolutionPoints` + `.slice(0, variables.length)` assumes `[x, y, L]` order matching `unknowns`.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools/multivariable/optimization.ts test/multivariable-optimization.test.ts
git commit -m "feat(multivariable): lagrange multipliers

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Handler entry point (index.ts)

**Files:**
- Create: `src/server/tools/multivariable/index.ts`
- Test: covered indirectly by Task 7 (router/dispatch). No separate test file.

- [ ] **Step 1: Write the implementation**

```typescript
// src/server/tools/multivariable/index.ts
import { formatErrorResponse } from '../response-formatter.js';
import { operatorHandler } from './operators.js';
import { integralHandler } from './integrals.js';
import { optimizationHandler } from './optimization.js';

const OPERATOR_OPS = new Set(['gradient', 'hessian', 'jacobian', 'divergence', 'curl', 'partial']);
const OPTIMIZATION_OPS = new Set([
  'critical_points',
  'lagrange',
  'tangent_plane',
  'directional_derivative',
]);

export async function multivariableHandler(args: Record<string, unknown>) {
  const operation = args.operation as string;
  if (OPERATOR_OPS.has(operation)) return operatorHandler(args);
  if (operation === 'multiple_integral') return integralHandler(args);
  if (OPTIMIZATION_OPS.has(operation)) return optimizationHandler(args);
  return formatErrorResponse(`Unknown multivariable operation: ${operation}`);
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add src/server/tools/multivariable/index.ts
git commit -m "feat(multivariable): handler entry point delegating by operation

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Wire into compute (extractor + router + dispatcher) with regression tests

**Files:**
- Modify: `src/server/tools/compute/extractors.ts` (add `extractMultivariable`)
- Modify: `src/server/tools/compute/router.ts` (add multiple-integral rule; re-point vector-calculus rule)
- Modify: `src/server/tools/compute/dispatcher.ts` (add `multivariable` case + import)
- Test: `test/multivariable-router.test.ts`

- [ ] **Step 1: Write the failing router test**

```typescript
// test/multivariable-router.test.ts
import { describe, it, expect } from 'vitest';
import { route } from '../src/server/tools/compute/router.js';

describe('Router — multivariable', () => {
  it('routes gradient() to multivariable', () => {
    const r = route('gradient(x^2+y^2, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('gradient');
    expect(r.args.expression).toBe('x^2+y^2');
    expect(r.args.variables).toEqual(['x', 'y']);
  });

  it('routes curl() to multivariable with functions', () => {
    const r = route('curl([y, -x, 0], [x, y, z])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('curl');
    expect(r.args.functions).toEqual(['y', '-x', '0']);
    expect(r.args.variables).toEqual(['x', 'y', 'z']);
  });

  it('routes partial() to multivariable', () => {
    const r = route('partial(x^2*y^3, x, y)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('partial');
    expect(r.args.variables).toEqual(['x', 'y']);
  });

  it('routes iint() to multivariable multiple_integral', () => {
    const r = route('iint(x*y, x, 0, 1, y, 0, 2)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('multiple_integral');
    expect(r.args.bounds).toEqual([
      { variable: 'x', lower: '0', upper: '1' },
      { variable: 'y', lower: '0', upper: '2' },
    ]);
  });

  it('routes nested int(int(...)) to multivariable as raw', () => {
    const r = route('int(int(x*y,x,0,1),y,0,2)');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('multiple_integral');
    expect(r.args.raw).toBe('int(int(x*y,x,0,1),y,0,2)');
  });

  it('routes critical_points() to multivariable', () => {
    const r = route('critical_points(x^2+y^2, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('critical_points');
  });

  it('routes lagrange() to multivariable', () => {
    const r = route('lagrange(x*y, x+y, 1, [x, y])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('lagrange');
    expect(r.args.constraint).toBe('x+y');
    expect(r.args.value).toBe('1');
  });

  it('routes tangent_plane() to multivariable', () => {
    const r = route('tangent_plane(x^2+y^2, [x, y], [1, 1])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('tangent_plane');
    expect(r.args.point).toEqual(['1', '1']);
  });

  it('routes directional_derivative() to multivariable', () => {
    const r = route('directional_derivative(x^2+y^2, [x, y], [1, 1], [1, 0])');
    expect(r.handler).toBe('multivariable');
    expect(r.args.operation).toBe('directional_derivative');
    expect(r.args.direction).toEqual(['1', '0']);
  });

  // --- Regression: existing routes must NOT break ---
  it('still routes single int() to calculus', () => {
    const r = route('int(x^2, x, 0, 1)');
    expect(r.handler).toBe('calculus');
    expect(r.args.operation).toBe('integrate');
  });

  it('still routes diff() to calculus with numeric order', () => {
    const r = route('diff(x^5, x, 3)');
    expect(r.handler).toBe('calculus');
    expect(r.args.operation).toBe('differentiate');
    expect(r.args.order).toBe(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/multivariable-router.test.ts`
Expected: FAIL — multivariable routes currently fall through to `giac_raw` / `calculus`.

- [ ] **Step 3: Add `extractMultivariable` to `extractors.ts`**

Append at the end of `src/server/tools/compute/extractors.ts` (the helpers `extractFnArgs` and `splitArgs` already exist at the top of this file — reuse them):

```typescript
// --- Multivariable ---

/** Parse a "[a, b, c]" bracket list into trimmed string elements. */
function parseBracketList(s: string): string[] {
  return s
    .trim()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

export function extractMultivariable(problem: string): RouteResult {
  const trimmed = problem.trim();
  const lc = trimmed.toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // Multiple integrals.
  if (lc.startsWith('iint') || lc.startsWith('iiint')) {
    // iint(f, x, a, b, y, c, d[, z, e, g])
    const expression = parts[0] || '';
    const bounds: { variable: string; lower: string; upper: string }[] = [];
    for (let i = 1; i + 2 < parts.length; i += 3) {
      bounds.push({ variable: parts[i], lower: parts[i + 1], upper: parts[i + 2] });
    }
    return { handler: 'multivariable', args: { operation: 'multiple_integral', expression, bounds } };
  }
  if (/int\s*\(\s*int\s*\(/i.test(trimmed)) {
    // Native nested int(int(...)) — pass through raw.
    return { handler: 'multivariable', args: { operation: 'multiple_integral', raw: trimmed } };
  }

  // Vector / differential operators: name(expr-or-functions, [vars]).
  if (lc.startsWith('gradient') || lc.startsWith('grad')) {
    return { handler: 'multivariable', args: { operation: 'gradient', expression: parts[0] || '', variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('hessian')) {
    return { handler: 'multivariable', args: { operation: 'hessian', expression: parts[0] || '', variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('jacobian')) {
    return { handler: 'multivariable', args: { operation: 'jacobian', functions: parseBracketList(parts[0] || ''), variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('divergence') || lc.startsWith('div')) {
    return { handler: 'multivariable', args: { operation: 'divergence', functions: parseBracketList(parts[0] || ''), variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('curl')) {
    return { handler: 'multivariable', args: { operation: 'curl', functions: parseBracketList(parts[0] || ''), variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('partial')) {
    // partial(f, x, y, ...) — remaining args are the differentiation variables.
    return { handler: 'multivariable', args: { operation: 'partial', expression: parts[0] || '', variables: parts.slice(1) } };
  }

  // Optimization.
  if (lc.startsWith('critical_points')) {
    return { handler: 'multivariable', args: { operation: 'critical_points', expression: parts[0] || '', variables: parseBracketList(parts[1] || '') } };
  }
  if (lc.startsWith('lagrange')) {
    // lagrange(f, g, value, [vars])
    return {
      handler: 'multivariable',
      args: {
        operation: 'lagrange',
        expression: parts[0] || '',
        constraint: parts[1] || '',
        value: parts[2] || '0',
        variables: parseBracketList(parts[3] || ''),
      },
    };
  }
  if (lc.startsWith('tangent_plane')) {
    // tangent_plane(f, [vars], [point])
    return {
      handler: 'multivariable',
      args: {
        operation: 'tangent_plane',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
        point: parseBracketList(parts[2] || ''),
      },
    };
  }
  if (lc.startsWith('directional_derivative')) {
    // directional_derivative(f, [vars], [point], [direction])
    return {
      handler: 'multivariable',
      args: {
        operation: 'directional_derivative',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
        point: parseBracketList(parts[2] || ''),
        direction: parseBracketList(parts[3] || ''),
      },
    };
  }

  // Fallback: treat as raw passthrough (should not normally hit).
  return { handler: 'giac_raw', args: { expression: trimmed } };
}
```

- [ ] **Step 4: Update `router.ts`**

Add `extractMultivariable` to the import block at the top of `src/server/tools/compute/router.ts`:

```typescript
  extractFourier,
  extractMultivariable,
} from './extractors.js';
```

Insert a new multiple-integral rule **immediately before** the existing `calculus:integrate` rule (rule "4. Integration"):

```typescript
  // Multiple integrals — MUST precede single integrate (nested int starts with "int(").
  {
    name: 'multivariable:multiple_integral',
    test: (p) =>
      startsWith(p, 'iint', 'iiint') || /int\s*\(\s*int\s*\(/i.test(p),
    extract: extractMultivariable,
  },
```

Replace the existing vector-calculus rule (rule "14. Vector calculus", currently routing to `extractGiacRaw`) with this expanded rule:

```typescript
  // Vector / differential operators + multivariable optimization.
  {
    name: 'multivariable:operators',
    test: (p) =>
      startsWith(
        p,
        'gradient',
        'grad',
        'curl',
        'divergence',
        'div',
        'hessian',
        'jacobian',
        'partial',
        'critical_points',
        'lagrange',
        'tangent_plane',
        'directional_derivative'
      ),
    extract: extractMultivariable,
  },
```

- [ ] **Step 5: Update `dispatcher.ts`**

Add the import alongside the other handler imports in `src/server/tools/compute/dispatcher.ts`:

```typescript
import { multivariableHandler } from '../multivariable/index.js';
```

Add this case to the `switch (handler)` block, before the `giac_raw`/`default` case:

```typescript
    case 'multivariable':
      return (await multivariableHandler(args)) as McpResponse;
```

- [ ] **Step 6: Run the multivariable router test**

Run: `npx vitest run test/multivariable-router.test.ts`
Expected: PASS (all routing + 2 regression tests).

- [ ] **Step 7: Run the FULL suite to confirm no regressions**

Run: `npm test`
Expected: all prior tests still pass plus the new multivariable suites. If the existing `test/router.test.ts` has a case asserting `grad`/`curl` routes to `giac_raw`, update that assertion to `multivariable` (the behavior intentionally changed) and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/server/tools/compute/extractors.ts src/server/tools/compute/router.ts src/server/tools/compute/dispatcher.ts test/multivariable-router.test.ts
git commit -m "feat(multivariable): wire into compute router/extractor/dispatcher

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: End-to-end smoke through the compute gateway

**Files:**
- Test: `test/multivariable-router.test.ts` (add an end-to-end block)

- [ ] **Step 1: Add a failing end-to-end test**

Append to `test/multivariable-router.test.ts`:

```typescript
import { computeHandler } from '../src/server/tools/compute/index.js';
import { giacEngine } from '../src/server/giac/index.js';
import { beforeAll } from 'vitest';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('compute gateway — multivariable end-to-end', () => {
  it('gradient through compute()', async () => {
    const r = await computeHandler({ problem: 'gradient(x^2+y^2, [x, y])' });
    expect(r.isError).toBe(false);
    const flat = r.content.map((c: { text: string }) => c.text).join('\n').replace(/\s/g, '');
    expect(flat).toContain('2*x');
  });

  it('double integral through compute()', async () => {
    const r = await computeHandler({ problem: 'iint(x*y, x, 0, 1, y, 0, 2)' });
    expect(r.isError).toBe(false);
    expect(r.content.map((c: { text: string }) => c.text).join('\n')).toContain('1');
  });
});
```

Note: the `compute` gateway's input field is `problem` (verified in `compute/schema.ts`); `computeHandler` reads `args.problem`. `normalize()` falls back to `'symbolic'` for the unknown `multivariable` handler key, so text-format output passes through unchanged — no normalize change required.

- [ ] **Step 2: Run test to verify it passes once Task 7 wiring is in place**

Run: `npx vitest run test/multivariable-router.test.ts`
Expected: the end-to-end cases PASS (routing + dispatch wired in Task 7).

- [ ] **Step 3: Run full suite + lint + typecheck**

Run: `npm test && npm run lint && npm run typecheck`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add test/multivariable-router.test.ts
git commit -m "test(multivariable): end-to-end smoke through compute gateway

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Out of scope (follow-ups, not this plan)

- **M2 (3D geometry)** and **M3 (3D/surface visualization)** — separate spec → plan → implementation cycles.
- **Multivariable benchmark slice** (~30–40 problems) to measure the lift.
- **README sync** — the README's stale "15 Tools" table vs. the real 3-tool gateway.
- **>2-variable critical-point classification** — Task 4 classifies the 2-variable case; higher dimensions report points + gradient without full Hessian classification.
- **Updating the `compute` tool instructions/prompts** to advertise the new multivariable verbs (worth doing once M1 lands, but not required for functionality).
