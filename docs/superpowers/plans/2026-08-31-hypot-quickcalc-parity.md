# hypot + quick_calc parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin the geometry/fourier math with golden tests, switch the seven squared-sum `Math.sqrt` sites to overflow-safe `Math.hypot`, and make quick_calc render `precision` exactly like to_decimal.

**Architecture:** Tests first (goldens verified empirically against the current handlers on this branch), then two small production changes on top. Three commits, each independently green.

**Tech Stack:** TypeScript, vitest (real handlers — geometry is pure JS; quick_calc tests use the real forked mathjs worker + Giac engine via `beforeAll` initialize).

**Spec:** `docs/superpowers/specs/2026-08-31-hypot-quickcalc-parity-design.md`

## Global Constraints

- Work only in `/Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/.claude/worktrees/fix-hypot-parity`, branch `fix/hypot-quickcalc-parity`.
- All golden values below were verified against the CURRENT handlers (pre-change) unless marked POST-HYPOT; do not retype them from memory — if a test fails on a golden, investigate before changing the expectation.
- `to_decimal` (`src/server/tools/exact-value.ts`) is NOT touched — already fixed.
- Gates: `npm run typecheck`, `npm run lint` (0 warnings), `npm test`, and `npm run test:integration` once at the end. Do not push.
- `formatNumber` (geometry.ts:201) rounds to 10 decimals; geometry assertions match exact rendered strings.

---

### Task 1: Golden tests for geometry, fourier magnitude, vnorm

**Files:**
- Create: `test/geometry.test.ts`
- Modify: `test/fourier-transform.test.ts` (one added `it`)
- Modify (only if a norm pin is absent): `test/geometry3d-vectors.test.ts`

**Interfaces:**
- Consumes: `geometryHandler(args: Record<string, unknown>)` from `src/server/tools/geometry.js` — args `{ operation, points: [number,number][], line1?: [number,number,number], line2?: [...] }`; response `{ content: [{type:'text',text}], isError }`.
- Produces: pinned behavior that Task 2's conversion must keep (and one assertion Task 2 deliberately flips).

- [ ] **Step 1: Create `test/geometry.test.ts` with the verified goldens**

```ts
import { describe, it, expect } from 'vitest';
import { geometryHandler } from '../src/server/tools/geometry.js';

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

// Goldens verified against the handler before the Math.hypot conversion; the
// values must not move by more than the renderer's 10th decimal when they do.
describe('geometry — 2D distances and magnitudes', () => {
  it('distance of a 3-4-5 pair is exactly 5', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [3, 4]] });
    expect(r.isError).toBe(false);
    expect(allText(r)).toContain('Result: 5');
    expect(allText(r)).toContain('The answer is 5');
  });

  it('distance renders √2 to the renderer precision', async () => {
    const r = await geometryHandler({ operation: 'distance', points: [[0, 0], [1, 1]] });
    expect(allText(r)).toContain('Result: 1.4142135624');
  });

  it('perimeter of the unit square is 4', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [1, 0], [1, 1], [0, 1]],
    });
    expect(allText(r)).toContain('Result: 4');
  });

  it('perimeter of a 3-4-5 triangle is 12', async () => {
    const r = await geometryHandler({
      operation: 'perimeter_polygon',
      points: [[0, 0], [3, 0], [3, 4]],
    });
    expect(allText(r)).toContain('Result: 12');
  });

  it('point-to-line distance is |3+4|/5 = 1.4', async () => {
    const r = await geometryHandler({
      operation: 'point_line_distance',
      points: [[1, 1]],
      line1: [3, 4, 0],
    });
    expect(allText(r)).toContain('Result: 1.4');
  });

  it('angle between identical lines is 0°, perpendicular lines 90°', async () => {
    const same = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [1, 0, 0],
      line2: [1, 0, 5],
    });
    expect(allText(same)).toContain('Result: 0°');
    const perp = await geometryHandler({
      operation: 'angle_between_lines',
      line1: [0, 1, 0],
      line2: [1, 0, 0],
    });
    expect(allText(perp)).toContain('Result: 90°');
  });

  it('distance overflows to Infinity at 1e154 coordinates (pre-hypot fact)', async () => {
    // Task 2 flips this expectation together with the Math.hypot switch; the
    // comment keeps today's rationale discoverable.
    const r = await geometryHandler({
      operation: 'distance',
      points: [[0, 0], [1e154, 1e154]],
    });
    expect(allText(r)).toContain('Result: Infinity');
  });
});
```

- [ ] **Step 2: Run the new file**

Run: `npx vitest run test/geometry.test.ts`
Expected: all PASS (these pin current behavior).

- [ ] **Step 3: Add the fourier magnitude pin to `test/fourier-transform.test.ts`**

Inside the existing `describe('FFT', ...)` block (file already initializes the Giac engine in `beforeAll`):

```ts
    it('pins the magnitude line of an impulse spectrum', async () => {
      // An impulse [1, 0, 0, 0] has a flat unit spectrum: |X| = 1 everywhere,
      // including bin 0. This is the line the Math.hypot conversion touches.
      const result = await fourierTransformHandler({
        mode: 'fft',
        data: [1, 0, 0, 0],
        output_magnitude: true,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toMatch(/\[0\].*\|X\| = 1\.000000/);
    });
```

- [ ] **Step 4: Ensure a vnorm pin exists**

Run: `grep -n "norm" test/geometry3d-vectors.test.ts`
If a norm assertion exists (e.g. norm of [3,4] = 5), nothing to add. If not, add to that file's describe:

```ts
  it('norm of a 3-4-5 vector is 5', async () => {
    const r = await vectorHandler({ operation: 'norm', vectors: [[3, 4]] });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain('5');
  });
```

(Adjust `operation`/arg names to the handler's actual contract by reading `src/server/tools/geometry3d/vectors.ts` first; the value 5 is the invariant.)

- [ ] **Step 5: Gates + commit**

Run: `npm run lint 2>&1 | grep Found && npm run typecheck && npx vitest run test/geometry.test.ts test/fourier-transform.test.ts test/geometry3d-vectors.test.ts`
Expected: lint 0, typecheck clean, all pass.

```bash
git add test/
git commit -m "test: pin the geometry, magnitude and norm values the hypot switch will touch"
```

---

### Task 2: Math.hypot conversion (7 sites) + overflow expectation flip

**Files:**
- Modify: `src/server/tools/geometry.ts:18,114,159,176-177`
- Modify: `src/server/tools/fourier-transform.ts:47`
- Modify: `src/server/tools/geometry3d/vec.ts:32`
- Modify: `test/geometry.test.ts` (the overflow assertion only)

**Interfaces:**
- Consumes: Task 1's goldens.
- Produces: overflow-safe magnitudes; identical rendered values for the typical-input goldens.

- [ ] **Step 1: Convert the five geometry sites**

```ts
// geometry.ts:18 — was: const d = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
        const d = Math.hypot(x2 - x1, y2 - y1);
// geometry.ts:114 — was: perimeter += Math.sqrt((xj - xi) ** 2 + (yj - yi) ** 2);
          perimeter += Math.hypot(xj - xi, yj - yi);
// geometry.ts:159 — was: const d = Math.abs(a * px + b * py + c) / Math.sqrt(a * a + b * b);
        const d = Math.abs(a * px + b * py + c) / Math.hypot(a, b);
// geometry.ts:176-177 — was: Math.sqrt(a1 * a1 + b1 * b1) / Math.sqrt(a2 * a2 + b2 * b2)
        const mag1 = Math.hypot(a1, b1);
        const mag2 = Math.hypot(a2, b2);
```

- [ ] **Step 2: Convert fourier magnitude and the n-dimensional norm**

```ts
// fourier-transform.ts:47 — was: const mag = Math.sqrt(re * re + im * im);
          const mag = Math.hypot(re, im);
// geometry3d/vec.ts:32 — was: export const vnorm = (a: number[]): number => Math.sqrt(vdot(a, a));
export const vnorm = (a: number[]): number => Math.hypot(...a);
```

(If `vdot` becomes unused in vec.ts, remove the import; typecheck will say.)

- [ ] **Step 3: Flip the overflow expectation in `test/geometry.test.ts`**

```ts
  it('distance stays finite at 1e154 coordinates (hypot is overflow-safe)', async () => {
    // The sqrt(x²+y²) form answered Infinity here; Math.hypot computes the
    // correct 1.4142135623730953e+154. Shape-matched: formatNumber's 10th
    // decimal rounding may move the last digits of the mantissa.
    const r = await geometryHandler({
      operation: 'distance',
      points: [[0, 0], [1e154, 1e154]],
    });
    expect(allText(r)).toMatch(/Result: 1\.41421\d*e\+154/);
  });
```

- [ ] **Step 4: Run the pinned files — goldens must hold, overflow must flip**

Run: `npx vitest run test/geometry.test.ts test/fourier-transform.test.ts test/geometry3d-vectors.test.ts test/fourier-seam.test.ts`
Expected: all PASS. A failure on `1.4142135624`, `1.4`, `12`, `0°`, `90°`, or `|X| = 1.000000` means the conversion changed typical-input results beyond the renderer's 10-decimal rounding — STOP and investigate, do not widen the assertion.

- [ ] **Step 5: Gates + commit**

Run: `npm run lint 2>&1 | grep Found && npm run typecheck && npm test 2>&1 | grep -E "Test Files|Tests "`

```bash
git add src/ test/
git commit -m "fix: use Math.hypot for squared-sum magnitudes (S7769)

sqrt(x²+y²) overflows to Infinity once the squared terms exceed the
double range — at 1e154 coordinates the distance handler answered
Infinity where hypot computes the correct 1.414e154. Converts the five
flagged geometry sites, the fourier magnitude line and the unflagged
n-dimensional vnorm (same defect class). Typical-input results are
identical to the renderer's 10-decimal rounding; the pinned goldens
from the previous commit all hold unchanged."
```

---

### Task 3: quick_calc display parity

**Files:**
- Modify: `src/server/tools/quick-calc.ts` (two display sites)
- Modify: `test/quick-calc.test.ts` (add a parity describe)

**Interfaces:**
- Consumes: `QuickCalcResult.formatted: string` (required field, worker's verbatim rendering — exists since the to_decimal fix).
- Produces: quick_calc renders `precision` identically to to_decimal.

- [ ] **Step 1: Apply the two display changes**

In the exact-form promotion block:

```ts
// was: decimal: String(numericResult),
          decimal: opts.precision !== undefined ? result.formatted : String(numericResult),
```

In the fallback block:

```ts
// was: result: String(result.result),
      result: opts.precision !== undefined ? result.formatted : String(result.result),
```

Add one comment above the exact-path return:

```ts
        // With `precision` every rendered decimal is the worker's formatting —
        // the same rule as to_decimal, so the two tools cannot disagree.
```

- [ ] **Step 2: Add parity tests (goldens verified pre-change; Decimal/≈ flip post-change)**

Append to `test/quick-calc.test.ts` (engine already initialized by the degree describe's `beforeAll`; if the file has no top-level init, give this describe its own `beforeAll` + import):

```ts
describe('quick_calc renders precision like to_decimal', () => {
  it('the exact-form Decimal line honours precision', async () => {
    const r = await quickCalcHandler({ expression: '2/3', precision: 3 });
    expect(r.isError).toBe(false);
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).toContain('Result: 2/3');
    expect(text).toMatch(/^Decimal: 0\.667$/m);
    expect(text).not.toContain('0.6666666666666666');
  });

  it('an exponent rendering survives on the Decimal line', async () => {
    // Pre-change this fixture rendered Decimal: 0.000001234 — the exact
    // Number() round-trip collapse the parity fix removes. mathjs formats
    // 1.234e-6 at precision 3 as "1.23e-6" (verified: mathjs emits e-6).
    const r = await quickCalcHandler({ expression: '0.000001234', precision: 3 });
    expect(r.isError).toBe(false);
    const text = r.content.map((c) => c.text).join('\n');
    expect(text).toMatch(/^Decimal: 1\.23e-6$/m);
    expect(text).not.toContain('Decimal: 0.000001234');
  });

  it('truncates a repeating sum and keeps the full double without precision', async () => {
    const withP = await quickCalcHandler({ expression: '0.1+0.2', precision: 5 });
    expect(withP.content.map((c) => c.text).join('\n')).toMatch(/^Decimal: 0\.3$/m);
    const without = await quickCalcHandler({ expression: '0.1+0.2' });
    expect(without.content.map((c) => c.text).join('\n')).toMatch(
      /^Decimal: 0\.30000000000000004$/m
    );
  });
});
```

- [ ] **Step 3: Run and confirm**

Run: `npx vitest run test/quick-calc.test.ts`
Expected: all PASS. If `Decimal: 1.234e-06` fails, print the actual text and pin the real rendering — the invariant is "worker's rendering verbatim, not the round-tripped double", not any specific string.

- [ ] **Step 4: Full gates + integration**

Run: `npm run lint 2>&1 | grep Found && npm run typecheck && npm test 2>&1 | grep -E "Test Files|Tests "`
Run: `npm run test:integration 2>&1 | grep -E "Test Files|Tests "` (once, at the end)
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/ test/
git commit -m "fix: quick_calc renders precision like to_decimal

Both display sites — the exact-form Decimal line and the fallback
Result line — now show the worker's verbatim formatting when the
caller passed precision, instead of a Number() round-trip that
collapsed mathjs's exponential notation (0.000001234 vs 1.234e-06)
and a Decimal line that ignored the requested digits entirely.
Without precision the output is byte-identical to before."
```
