# 3D Geometry (M2) — Design

**Date:** 2026-06-09
**Status:** Approved

## Goal

Add 3D geometry to the `compute` gateway: vector operations (distance, midpoint, dot, cross, norm, angle), planes (from points, point-plane distance, line-plane intersection, plane-plane angle, line-line distance), and volumes (tetrahedron, sphere, parallelepiped). All explicit 3D-named operations, computed in pure JavaScript.

This is **M2** of a three-part roadmap (M1 multivariable calculus → M2 3D geometry → M3 3D/surface visualization). M1 is complete and on `main`. M3 is a separate spec → plan → implementation cycle and is out of scope here.

## Background

The server exposes three MCP tools: `compute` (the gateway), `verify`, `plot`. `compute` routes a CAS-style problem string through ordered rules in `router.ts`; an `extract*` function produces `{handler, args}`; `dispatcher.ts` dispatches to the matching handler.

The existing `geometry.ts` is 2D only (`[x, y]` points): distance, midpoint, slope, area_*, perimeter, circumference, line_intersection, point_line_distance, angle_between_lines. It is pure JavaScript and returns `formatToolResponse` with a `formatNumber` helper. M2 adds 3D as a **separate** module so the 2D handler is untouched (no regression risk) and 2D/3D concerns stay isolated.

## Design

### 1. New directory: `src/server/tools/geometry3d/`

Mirrors the M1 directory convention. Pure JavaScript (`Math`); no Giac. Each operation returns `formatToolResponse({ result, notes })`; numbers formatted via a local `formatNumber` (same rounding as `geometry.ts`, 1e10).

- `vectors.ts` — `distance3d`, `midpoint3d`, `dot`, `cross`, `vector_norm`, `angle_vectors`
- `planes.ts` — `plane_from_points`, `point_plane_distance`, `line_plane_intersection`, `plane_plane_angle`, `line_line_distance`
- `volumes.ts` — `volume_tetrahedron`, `volume_sphere`, `volume_parallelepiped`
- `index.ts` — `geometry3dHandler(args)`; switches on `args.operation`, delegates to the sub-modules; unknown operation → `formatErrorResponse`.

### 2. Naming and collision resolution

All operations use explicit 3D names so the 2D handler is never touched. Verified non-collisions against the router's `startsWith(name + '(')` matching:

- `distance3d(` does not match 2D `distance(`; `midpoint3d(` does not match `midpoint(`.
- `point_plane_distance` ≠ `point_line_distance`; `plane_plane_angle` ≠ `angle(`/`angle_between_lines`.
- **Vector magnitude is named `vector_norm`, NOT `norm`** — `norm` is a matrix operation (router rule for matrix decompositions). `vector_norm` avoids that collision entirely.
- `dot`, `cross`, `plane_from_points`, `line_plane_intersection`, `volume_*` have no existing-verb collisions.

The new `geometry3d` router rule is placed **before** the 2D geometry rule for clarity/safety, though distinct names mean ordering between them does not affect correctness.

### 3. Operations (formulas + input shapes)

Points/vectors are 3-number bracket lists; planes are 4-coefficient lists `[a,b,c,d]` for `ax+by+cz+d=0`.

**vectors.ts**

| Operation | Input | Result |
|---|---|---|
| `distance3d` | `(P, Q)` | `√Σ(Qi−Pi)²` |
| `midpoint3d` | `(P, Q)` | `((Pi+Qi)/2)` |
| `dot` | `(U, V)` | `ΣUi·Vi` |
| `cross` | `(U, V)` | `[UyVz−UzVy, UzVx−UxVz, UxVy−UyVx]` |
| `vector_norm` | `(V)` | `√(V·V)` |
| `angle_vectors` | `(U, V)` | `acos(U·V/(‖U‖‖V‖))` in degrees; error if either vector is zero |

**planes.ts**

| Operation | Input | Result |
|---|---|---|
| `plane_from_points` | `(P1, P2, P3)` | `n = cross(P2−P1, P3−P1)`, `d = −n·P1` → `[a,b,c,d]`; error if points are collinear (`n = 0`) |
| `point_plane_distance` | `(P, [a,b,c,d])` | `\|a·Px+b·Py+c·Pz+d\| / ‖(a,b,c)‖`; error if normal is zero |
| `line_plane_intersection` | `(P, D, [a,b,c,d])` (line point, line direction, plane) | `t = −(n·P + d)/(n·D)`; if `n·D = 0` → parallel, error; else `P + t·D` |
| `plane_plane_angle` | `([a,b,c,d], [a,b,c,d])` | `acos(\|n1·n2\|/(‖n1‖‖n2‖))` in degrees |
| `line_line_distance` | `(P1, D1, P2, D2)` | skew: `\|(P2−P1)·(D1×D2)\| / ‖D1×D2‖`; if `D1×D2 = 0` (parallel) → `‖(P2−P1)×D1‖ / ‖D1‖` |

**volumes.ts**

| Operation | Input | Result |
|---|---|---|
| `volume_tetrahedron` | `(P1, P2, P3, P4)` | `\|(P2−P1)·((P3−P1)×(P4−P1))\| / 6` |
| `volume_sphere` | `(r)` (scalar) | `(4/3)·π·r³` |
| `volume_parallelepiped` | `(V1, V2, V3)` | `\|V1·(V2×V3)\|` |

### 4. Extractor (`compute/extractors.ts`)

New `extractGeometry3d(problem)` parses the function name and arguments into `{ handler: 'geometry3d', args: { operation, ... } }`. Each argument is split with the existing `splitArgs` (paren/bracket-aware), and bracket-list arguments are parsed into number arrays; `volume_sphere`'s single scalar is parsed as a number. Argument keys per operation match the input shapes above (e.g. `{ operation, points: number[][] }` for multi-point ops, `{ operation, plane: number[], ... }` where a plane is involved).

### 5. Router (`compute/router.ts`)

A new rule routing the 3D verbs to `extractGeometry3d`, placed before the 2D geometry rule:

```
startsWith(p,
  'distance3d', 'midpoint3d', 'dot', 'cross', 'vector_norm', 'angle_vectors',
  'plane_from_points', 'point_plane_distance', 'line_plane_intersection',
  'plane_plane_angle', 'line_line_distance',
  'volume_tetrahedron', 'volume_sphere', 'volume_parallelepiped')
```

### 6. Dispatcher (`compute/dispatcher.ts`)

New `case 'geometry3d': return (await geometry3dHandler(args)) as McpResponse;` and the import.

### 7. Data flow

```
compute(problem)
  → route()                  # geometry3d rule matches (before 2D geometry)
  → extractGeometry3d()      # → {handler:'geometry3d', args:{operation, ...}}
  → dispatch('geometry3d')   # dispatcher.ts new case
  → geometry3dHandler()      # delegates to vectors / planes / volumes
  → formatToolResponse({result, notes})
```

### 8. Error handling

Follows the `geometry.ts` pattern (`formatErrorResponse` + try/catch):

- **Coordinate count:** every point/vector must have exactly 3 numbers; a plane must have 4 coefficients. Otherwise a clear error.
- **Degenerate cases:** zero vector for `angle_vectors`/normalization → error; collinear points in `plane_from_points` (`n = 0`) → error; parallel line/plane in `line_plane_intersection` (`n·D = 0`) → error. `line_line_distance` falls back to the parallel formula rather than erroring.
- **Number formatting:** `formatNumber` (matches `geometry.ts`, rounds to 1e10).

### 9. Testing

Vitest, pure JS (no Giac init needed). Unit tests per module:

- **vectors:** `distance3d([0,0,0],[2,3,6]) = 7`; `dot([1,2,3],[4,5,6]) = 32`; `cross([1,0,0],[0,1,0]) = [0,0,1]`; `vector_norm([2,3,6]) = 7`; `angle_vectors([1,0,0],[0,1,0]) = 90`; zero-vector error.
- **planes:** `plane_from_points([0,0,0],[1,0,0],[0,1,0]) = [0,0,1,0]`; `point_plane_distance([0,0,5],[0,0,1,0]) = 5`; `line_plane_intersection([0,0,-1],[0,0,1],[0,0,1,0]) = (0,0,0)`; `plane_plane_angle([0,0,1,0],[0,1,0,0]) = 90`; `line_line_distance([0,0,0],[1,0,0],[0,0,1],[0,1,0]) = 1`; collinear / parallel paths.
- **volumes:** `volume_tetrahedron([0,0,0],[1,0,0],[0,1,0],[0,0,1]) = 1/6`; `volume_sphere(r)`; `volume_parallelepiped([1,0,0],[0,1,0],[0,0,1]) = 1`.
- **router (regression):** every 3D verb routes to `geometry3d` **and** existing 2D `distance`/`midpoint`/`angle` and matrix `norm` routes still behave — explicit regression assertions.

## Files changed

| File | Change |
|---|---|
| `src/server/tools/geometry3d/vectors.ts` | **New** — vector operations |
| `src/server/tools/geometry3d/planes.ts` | **New** — plane/line operations |
| `src/server/tools/geometry3d/volumes.ts` | **New** — volume operations |
| `src/server/tools/geometry3d/index.ts` | **New** — handler + delegation |
| `src/server/tools/compute/extractors.ts` | **New** `extractGeometry3d()` |
| `src/server/tools/compute/router.ts` | New `geometry3d` rule before the 2D geometry rule |
| `src/server/tools/compute/dispatcher.ts` | New `geometry3d` case + import |
| `test/geometry3d-*.test.ts` | **New** — unit + router regression tests |

## Out of scope

- **M3 (3D/surface visualization)** — separate spec → plan → implementation cycle.
- **Modifying the existing 2D `geometry.ts`** — the 2D handler is intentionally left untouched.
- **Multivariable/3D benchmark slice** — a follow-up validation step, not part of M2's core delivery.
- **README sync** — the README's stale tool table is a separate documentation task.
- **Curved surfaces / quadrics, convex hulls, mesh operations** — beyond the core+intersections scope chosen for M2.
