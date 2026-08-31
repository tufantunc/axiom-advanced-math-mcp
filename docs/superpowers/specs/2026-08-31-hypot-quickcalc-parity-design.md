# quick_calc display parity + Math.hypot mini-batch

Date: 2026-08-31
Branch: `fix/hypot-quickcalc-parity` (from `main` dba079e)
Rules/findings: backend Low from the to_decimal precision review;
SonarQube `typescript:S7769` (deferred from batch 1b).

## Problem

Two loose ends:

1. **quick_calc renders precision differently from to_decimal.** Since the
   to_decimal fix, the two tools diverge for the same input+precision:
   `to_decimal('0.000001234', precision 3)` shows the worker's rendering
   `1.23e-6`, while quick_calc's display path does `String(result.result)`,
   a `Number()` round-trip that collapses mathjs's exponential notation to
   `0.00000123`. Same value and digit count, different string — a model
   comparing the two tools' outputs sees an inconsistency. The exact-form
   promotion path has the same issue on its `Decimal:` line (it always shows
   the full double, ignoring an explicitly requested precision).

2. **S7769: `Math.sqrt(x*x + y*y)` overflows where `Math.hypot` does not.**
   Six flagged sites (`geometry.ts:18,114,159,176,177`,
   `fourier-transform.ts:47`) plus one unflagged n-dimensional variant of the
   same class (`geometry3d/vec.ts:32`, `vnorm = sqrt(vdot(a, a))` — Sonar
   flags only the textual two-term form). Demonstrated: at 1e154 the sqrt
   form answers `Infinity`, `Math.hypot` answers the correct
   `1.4142135623730953e+154`. Deferred from batch 1b because hypot reorders
   rounding: results are identical or within ~1 ULP for typical inputs — a
   numerical change, not a bit-identical one, in a repo whose worst failure
   class is the silent wrong answer.

## Approach

Tests first, then the changes. `geometry.ts` has no direct test file and the
fourier tests assert only `isError` — the affected geometry paths
(distance, perimeter_polygon, point_line_distance, angle_between_lines) and
the fourier magnitude line are pinned to known values BEFORE the hypot
switch, so the switch is verified against goldens rather than by luck.

## Design

### Commit 1 — behavior-pinning tests (no production change)

New `test/geometry.test.ts` driving `geometryHandler` directly (real handler,
no engine needed — geometry is pure JS):

- `distance` (0,0)→(3,4) = `5`; (0,0)→(1,1) = `1.4142135624`
  (formatNumber rounds to 1e-10).
- `perimeter_polygon` unit square = `4`; a 3-4-5 right triangle = `12`.
- `point_line_distance` point (1,1), line [3,4,0]: |7|/5 = `1.4`.
- `angle_between_lines` identical lines → `0`; perpendicular lines → `90`.
- Overflow golden: `distance` (0,0)→(1e154,1e154) currently answers
  `Infinity` — pinned as the pre-hypot fact the next commit flips; the
  post-switch expectation is `1.4142135623730953e+154` (asserted with a
  `/1\.41421\d*e\+154/` shape match, tolerant of the last digits).

`test/fourier-transform.test.ts` gains one magnitude pin: DFT of `[1,0,0,0]`
with magnitudes on → `[0] … |X| = 1.000000`.

`test/geometry3d-vectors.test.ts` already pins `vnorm` values (verified by
its existing assertions); if a norm pin is missing it is added here.

### Commit 2 — hypot conversion (7 sites)

```ts
Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2)  -> Math.hypot(x2 - x1, y2 - y1)   // geometry.ts:18
perimeter += Math.sqrt((xj - xi) ** 2 + (yj - yi) ** 2)
  -> perimeter += Math.hypot(xj - xi, yj - yi)                                 // :114
Math.abs(a * px + b * py + c) / Math.sqrt(a * a + b * b)
  -> Math.abs(a * px + b * py + c) / Math.hypot(a, b)                          // :159
const mag1 = Math.hypot(a1, b1); const mag2 = Math.hypot(a2, b2);              // :176-177
const mag = Math.hypot(re, im);                                                // fourier-transform.ts:47
export const vnorm = (a: number[]): number => Math.hypot(...a);                // geometry3d/vec.ts:32
```

The overflow test from commit 1 flips its expectation in this commit: commit 1
pins today's `Infinity` as a real assertion (the current behavior), and this
commit updates that one assertion to the hypot golden alongside the
conversion. Typical
inputs: identical results or ≤1 ULP; assertions use `toBeCloseTo(x, 12)` or
formatted-string equality where formatNumber makes it exact.

### Commit 3 — quick_calc display parity

`quick-calc.ts`, both display sites, same rule as to_decimal — the worker's
verbatim `formatted` rendering whenever the caller passed `precision`:

```ts
// exact-form promotion path
decimal: opts.precision !== undefined ? result.formatted : String(numericResult),
// fallback path
result: opts.precision !== undefined ? result.formatted : String(result.result),
```

Principle: **precision applies to every rendered decimal.** Without
precision the output is byte-identical to before. The `The answer is X (≈ Y)`
line derives from `decimal` and aligns automatically. Tests: exact-path
fixture asserting `Result: 2/3`, `Decimal: 0.667` (precision 3) and the full
double without precision; a fallback fixture asserting the verbatim
rendering (including an exponent-form case distinguishing the round-trip);
the precise fixture values are verified against the real worker while
writing the tests.

## Error handling / edge cases

- hypot: `Math.hypot(...a)` on an empty array returns 0, matching
  `Math.sqrt(vdot([], []))` → `sqrt(0)` → 0 — no behavior change; zero
  vectors keep the existing 1e-12 degeneracy guard in angle_between_lines.
- quick_calc parity: `result.formatted` is always set (required interface
  field since the to_decimal fix); no new null paths. The nonFinite caveat
  logic is untouched.
- to_decimal is NOT touched — it already displays `formatted`.

## Verification

Five gates after each commit batch: `npm run typecheck`, `npm run lint`
(0 warnings), `npm test`, `npm run test:integration` once at the end. Then
review-pro over the branch delta with correctness + tests + performance
dispatch (performance: measure hypot vs sqrt on the realistic path — the DP
tables are gone, these are per-request geometry calls, expectation: noise;
measure to confirm, per the axiom-cas performance pack).
