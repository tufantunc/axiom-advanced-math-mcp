# Giac exact-acceptance policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tryExactResult accept a Giac output as "exact" only when it is a bare integer or a float-free symbolic form — never a float (echo or coarse) and never a float-carrying unevaluated echo.

**Architecture:** One acceptance predicate in `src/server/tools/exact-arithmetic.ts`, plus policy pins at the seam (`tryExactResult`) and through both surfaces. Single commit (tests pin post-policy behavior, so they ship with the fix).

**Tech Stack:** TypeScript, vitest with the real Giac engine.

**Spec:** `docs/superpowers/specs/2026-08-31-giac-exact-acceptance-design.md`

## Global Constraints

- Work only in `/Users/tufantunc/Desktop/Projects/Personal/axiom-advanced-math-mcp/.claude/worktrees/fix-hypot-parity`, branch `fix/hypot-quickcalc-parity`.
- Keepers that MUST still pass (probed goldens): `sin(pi)`→exact `0`; `20!`→`2432902008176640000`; `sin(60°)`→`√3/2`; `sqrt(2)`→`√2`; `log(2)`→`ln(2)`; `exp(-30)`→`1/exp(30)`; `1/2500000000`→`1/2500000000`.
- Rejections that MUST hold after the fix: `sin(1.5)`, `2e-9`, `sech(23.4)` (bare floats) and `std([1e-05,2e-05])`, `nthRoot(1.2345678e-05,3)` (float-carrying echoes) → `tryExactResult` returns `null`.
- Gates: lint 0, typecheck, full unit suite, integration once at the end. Do not push.
- After implementation: review-pro with the mutation tests reviewer run LAST and alone.

---

### Task 1: The acceptance predicate + policy pins

**Files:**
- Modify: `src/server/tools/exact-arithmetic.ts` (the `if (giacResult && …)` acceptance condition)
- Modify: `test/quick-calc.test.ts` (new describe + update the sech pin)
- Modify: `test/exact-value.test.ts` (to_exact('2e-9') case)

**Interfaces:**
- Consumes: existing `ExactResult` shape; `giacEngine.evaluate`.
- Produces: `tryExactResult` whose Giac branch only returns float-free exacts.

- [ ] **Step 1: Replace the acceptance condition**

Current (inside the Giac branch of `tryExactResult`):

```ts
      const giacResult = await giacEngine.evaluate(giacExpr);
      if (
        giacResult &&
        giacResult !== 'undef' &&
        !giacResult.startsWith('Error') &&
        giacResult !== String(numericResult) &&
        giacResult !== numericResult.toFixed(15)
      ) {
```

New:

```ts
      const giacResult = await giacEngine.evaluate(giacExpr);
      // An exact form is symbolic or an integer — a float is not exact. A bare
      // non-integer float from Giac is either the same value re-rendered
      // ('2e-9' -> '2e-09') or a ~12-digit computation passing itself off as
      // exact while the true double waits on the decimal line; a symbolic form
      // carrying a float literal is an echo of an input Giac declined to
      // evaluate ('nthRoot(1.2345678e-05,3)').
      const trimmed = giacResult.trim();
      const bareNumber = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed);
      const bareInteger = /^[+-]?\d+$/.test(trimmed);
      const carriesFloat = /\d\.\d|\d[eE][+-]?\d/.test(trimmed);
      const isExactForm = bareNumber ? bareInteger : !carriesFloat;
      if (
        giacResult &&
        giacResult !== 'undef' &&
        !giacResult.startsWith('Error') &&
        isExactForm &&
        giacResult !== String(numericResult) &&
        giacResult !== numericResult.toFixed(15)
      ) {
```

- [ ] **Step 2: Update the sech pin in `test/quick-calc.test.ts`**

```ts
  it('a tiny computed value shows the true magnitude, not zero', async () => {
    // sech(23.4) ≈ 1.4e-10; the old snap answered "Result: 0". Giac's own
    // float for it is no longer accepted as an exact form (floats are not
    // exact), so the honest worker double reaches the Result line directly.
    const r = await quickCalcHandler({ expression: 'sech(23.4)' });
    expect(r.isError).toBe(false);
    const out = text(r);
    expect(out).toMatch(/^Result: 1\.375748725426922e-10$/m);
    expect(out).not.toMatch(/^Result: 0$/m);
  });
```

- [ ] **Step 3: Add the policy describe in `test/quick-calc.test.ts`**

Append (imports `tryExactResult`, `quickCalcHandler`, `giacEngine` already exist in the file):

```ts
// The Giac branch's exact badge: symbolic or integral only. A float —
// whether a reformatted echo or a coarse 12-digit computation — and a
// float-carrying unevaluated echo are not exact forms.
describe('the Giac exact form must be symbolic or integral', () => {
  beforeAll(async () => {
    await giacEngine.initialize();
  }, 60000);

  it('accepts a bare integer Giac result', async () => {
    expect((await tryExactResult('sin(pi)', Math.sin(Math.PI)))?.exact).toBe('0');
    expect((await tryExactResult('20!', 2.43290200817664e18))?.exact).toBe(
      '2432902008176640000'
    );
  });

  it('accepts float-free symbolic forms', async () => {
    expect((await tryExactResult('sin(60°)', Math.sin(Math.PI / 3)))?.exact).toBe('√3/2');
    expect((await tryExactResult('sqrt(2)', Math.SQRT2))?.exact).toBe('√2');
    expect((await tryExactResult('log(2)', Math.log(2)))?.exact).toBe('ln(2)');
    expect((await tryExactResult('exp(-30)', Math.exp(-30)))?.exact).toBe('1/exp(30)');
    expect((await tryExactResult('1/2500000000', 4e-10))?.exact).toBe('1/2500000000');
  });

  it('rejects a bare non-integer float — echo or coarse computation', async () => {
    expect(await tryExactResult('sin(1.5)', Math.sin(1.5))).toBeNull();
    expect(await tryExactResult('2e-9', 2e-9)).toBeNull();
    expect(await tryExactResult('sech(23.4)', 1 / Math.cosh(23.4))).toBeNull();
  });

  it('rejects a float-carrying unevaluated echo', async () => {
    expect(await tryExactResult('std([1e-05,2e-05])', 5e-6)).toBeNull();
    expect(await tryExactResult('nthRoot(1.2345678e-05,3)', 0.00231)).toBeNull();
  });

  it('the honest double reaches the surface when the float exact is refused', async () => {
    const r = await quickCalcHandler({ expression: 'sin(1.5)' });
    expect(r.isError).toBe(false);
    expect(r.content.map((c) => c.text).join('\n')).toMatch(
      /^Result: 0\.9974949866040544$/m
    );
  });
});
```

- [ ] **Step 4: Add the to_exact case in `test/exact-value.test.ts`**

Inside the `to_exact` describe:

```ts
  it('does not accept a reformatted float echo as an exact form', async () => {
    // Giac answers '2e-09' for '2e-9' — the same value, re-exponented. That
    // is not an improvement, so the honest answer is the no-simpler-form note.
    const r = await exactValueHandler({ operation: 'to_exact', value: '2e-9' });
    expect(r.isError).toBe(false);
    const text = allText(r);
    expect(text).toContain('No simpler exact form found');
    expect(text).toContain('Result: 2e-9');
    expect(text).not.toContain('2e-09');
  });
```

- [ ] **Step 5: Run the touched files**

Run: `npx vitest run test/quick-calc.test.ts test/exact-value.test.ts`
Expected: all PASS. A keeper failing means the predicate is too strict — check the trimmed classification against the actual Giac string before touching the expectation.

- [ ] **Step 6: Full gates**

Run: `npm run lint 2>&1 | grep Found && npm run typecheck && npm test 2>&1 | grep -E "Test Files|Tests "`
Run: `npm run test:integration 2>&1 | grep -E "Test Files|Tests "` (once)
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src/ test/
git commit -m "fix: accept a Giac result as exact only when it is symbolic or integral

The Giac branch accepted any output that differed as a string from the
numeric result, so a reformatted echo ('2e-9' -> 'Result: 2e-09'), a
coarse ~12-digit float ('sin(1.5)' -> 'Result: 0.997494986604' with the
true double on the Decimal line) and an unevaluated echo
('Result: nthRoot(1.2345678e-05,3)') all wore the exact badge. A float
is not an exact form: bare integers and float-free symbolic forms are
accepted; bare non-integer floats and float-carrying echoes are
refused, and the honest worker double reaches the Result line."
```
