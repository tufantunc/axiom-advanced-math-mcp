# Multivariable Calculus (M1) — Design

**Date:** 2026-06-09
**Status:** Approved

## Goal

Add first-class multivariable calculus to the `compute` gateway: differential operators (gradient, Hessian, Jacobian, divergence, curl, higher-order/mixed partials), multiple integrals (double/triple), and multivariable optimization (critical points, Lagrange multipliers, tangent plane, directional derivative).

This is **M1** of a three-part roadmap (M1 multivariable calculus → M2 3D geometry → M3 3D/surface visualization). M2 and M3 are separate spec → plan → implementation cycles and are out of scope here.

## Background

The server exposes three MCP tools: `compute` (the gateway), `verify`, `plot`. `compute` takes a CAS-style problem string, routes it through ordered rules in `router.ts`, an `extract*` function produces `{handler, args}`, and `dispatcher.ts` dispatches to the matching handler.

Vector calculus partially exists today: router Rule 14 (`grad`, `curl`, `divergence`, `hessian`, `jacobian`) routes to `giac_raw` — a raw Giac passthrough with no validation, no consistent formatting, and no server-side orchestration. The chosen scope (optimization + key intermediate values) requires server-side multi-step orchestration, which a raw passthrough cannot deliver. M1 promotes these operations from raw passthrough to a first-class, validated, formatted handler and adds the missing operations.

## Design

### 1. New directory: `src/server/tools/multivariable/`

Mirrors the existing directory convention (`compute/`, `plot/`, `symbolic/`, `verify/`).

- `index.ts` — exports `multivariableHandler(args)`; switches on `args.operation` and delegates to the sub-modules below. Formats final output via `response-formatter.ts` (`formatToolResponse` / `formatErrorResponse`).
- `operators.ts` — single-shot Giac operators (no orchestration):

  | Operation | Giac call | Output |
  |---|---|---|
  | `gradient` / `grad` | `grad(f, [vars])` | vector |
  | `hessian` | `hessian(f, [vars])` | matrix |
  | `jacobian` | `jacobian([funcs], [vars])` | matrix |
  | `divergence` / `div` | `divergence(F, [vars])` | scalar |
  | `curl` | `curl(F, [vars])` | vector |
  | `partial` | `diff(f, v1, v2, ...)` | mixed/higher-order partial |

- `integrals.ts` — multiple integrals:
  - double: `int(int(f, x, a, b), y, c, d)`
  - triple: nested thrice
  - returns exact result + decimal + LaTeX
- `optimization.ts` — multi-step orchestration. Calls the Giac engine (`giac/index.ts` `evaluate()`) directly for intermediate steps, returns final answer plus key intermediate values in `notes`:
  - `critical_points(f, vars)`: compute `grad` → `solve(grad components = 0, vars)` → for each solution compute Hessian, its determinant `D`, and `f_xx` → classify via the second-derivative test (min / max / saddle). Notes carry gradient, Hessian, `D`.
  - `lagrange(f, g, c, vars)`: `solve([grad(f) − λ·grad(g) = 0 componentwise, g = c], vars ∪ {λ})` → candidate points + objective values.
  - `tangent_plane(f, point)`: `z = f(a,b) + f_x(a,b)(x−a) + f_y(a,b)(y−b)` — compute partials, evaluate at `point`, assemble.
  - `directional_derivative(f, vars, point, direction)`: `grad(f) · (u/|u|)` evaluated at `point`.

### 2. Router changes (`compute/router.ts`)

Two real collisions to resolve:

- **`diff` collision:** Rule 3 sends `diff(...)` to calculus and interprets the 3rd argument as *order* (a number), so `diff(f,x,y)` (mixed partial) would break. **Resolution:** the new handler owns a separate function name `partial(f, x, y)` for mixed/higher-order partials; we do not touch `diff`.
- **`int` collision:** nested `int(int(...))` starts with `int(`, so Rule 4 (integrate) catches it first. **Resolution:** add a nested-integral detection rule (`int(int(` / `int(…int(` pattern) **above** Rule 4; also accept explicit `iint(...)` / `iiint(...)`.

Function names owned by the new handler: `gradient`/`grad`, `hessian`, `jacobian`, `divergence`/`div`, `curl`, `partial`, `iint`/`iiint` (+ nested-`int` detection), `critical_points`, `lagrange`, `tangent_plane`, `directional_derivative`. Rule 14 is re-pointed from `giac_raw` to the new `extractMultivariable` extractor.

### 3. Extractor (`compute/extractors.ts`)

New `extractMultivariable(problem, domain)` parses the function name and arguments into `{ handler: 'multivariable', args: { operation, ... } }`. Argument shapes per operation match the operator table above (expression, variable list, function vector, integration bounds, point, direction, constraint).

### 4. Dispatcher (`compute/dispatcher.ts`)

New `case 'multivariable': return (await multivariableHandler(args)) as McpResponse;` and the import.

### 5. Data flow

```
compute(problem)
  → route()                     # multivariable rule matches
  → extractMultivariable()      # → {handler:'multivariable', args:{operation, ...}}
  → dispatch('multivariable')   # dispatcher.ts new case
  → multivariableHandler()      # delegates to operators / integrals / optimization
  → formatToolResponse({result, notes})
```

### 6. Error handling

Follows the existing pattern (`formatErrorResponse` + try/catch):

- **Argument validation:** missing/malformed variable list; expressions validated via `symbolic/validator.js` `validateExpression` (as in `calculus.ts`).
- **No-solution cases:** if `solve` yields no real roots → "no critical points in the real domain".
- **Inconclusive classification:** Hessian `D = 0` → report the second-derivative test as inconclusive; never fabricate a classification.
- **Giac errors:** caught by try/catch and wrapped in `formatErrorResponse`.

### 7. Testing

Vitest, matching the existing suite. Unit tests per module:

- **operators:** `grad(x^2+y^2) = [2x, 2y]`, `curl([y,-x,0]) = [0,0,-2]`, `divergence`, known Hessian/Jacobian results.
- **integrals:** `∫∫ x*y over [0,1]×[0,2] = 1`, triple-integral sanity check.
- **optimization:** local min / saddle examples (`x^2+y^2` → min at origin; `x^2−y^2` → saddle); classic Lagrange (`max xy s.t. x+y=1 → (½,½)`); tangent plane; directional derivative.
- **router (regression):** new patterns route to `multivariable` **and** existing `diff` / `int` routes still behave — explicit regression assertions for the two collisions.

## Usage

```
gradient(x^2 + y^2, [x, y])
curl([y, -x, 0], [x, y, z])
partial(x^2*y^3, x, y)
iint(x*y, x, 0, 1, y, 0, 2)
critical_points(x^2 + y^2, [x, y])
lagrange(x*y, x + y, 1, [x, y])
tangent_plane(x^2 + y^2, [1, 1])
directional_derivative(x^2 + y^2, [x, y], [1, 1], [1, 0])
```

## Files changed

| File | Change |
|---|---|
| `src/server/tools/multivariable/index.ts` | **New** — handler + delegation |
| `src/server/tools/multivariable/operators.ts` | **New** — single-shot Giac operators |
| `src/server/tools/multivariable/integrals.ts` | **New** — double/triple integrals |
| `src/server/tools/multivariable/optimization.ts` | **New** — multi-step orchestration |
| `src/server/tools/compute/router.ts` | Add nested-`int` rule above Rule 4; re-point Rule 14; new function-name patterns |
| `src/server/tools/compute/extractors.ts` | **New** `extractMultivariable()` |
| `src/server/tools/compute/dispatcher.ts` | New `multivariable` case + import |
| `src/server/tools/multivariable/*.test.ts` | **New** — unit + router regression tests |

## Out of scope

- **M2 (3D geometry)** and **M3 (3D/surface visualization)** — separate spec → plan → implementation cycles.
- **Multivariable benchmark slice** — a ~30–40 problem validation set is a follow-up step after M1 lands, not part of M1's core delivery.
- **README sync** — the README's stale "15 Tools" table vs. the real 3-tool gateway is a separate documentation task.
- Symbolic step-by-step narration in the handler — narration stays in the prompt layer; the handler returns result + key intermediate values only.
