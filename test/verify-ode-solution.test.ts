import { describe, it, expect } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { verifyOdeSolution } from '../src/server/tools/self-verify.js';

/**
 * The single-equation residual check, driven against the real engine.
 *
 * A stub would not test the part that matters. Its whole job is to substitute a
 * candidate back into the caller's own equation and let the CAS decide, so the
 * substitution — three derivative spellings, list-wrapped implicit answers, free
 * constants — is the logic, and a stub would model my assumptions about Giac
 * rather than Giac.
 *
 * Three outcomes, and the third is the one that keeps it honest: verified,
 * refuted, and NO VERDICT. Every guard on this path before it was a shape scan
 * that had to predict what a wrong answer looks like, and three rounds of them
 * each closed the reported spelling and left the field next door. This predicts
 * nothing — but it must also never accuse an answer it did not actually check.
 */
const evaluate = (expr: string): Promise<string> =>
  giacEngine.evaluate(expr).then((r) => String(r));

describe('verifyOdeSolution', () => {
  it.each([
    ["y'=y", 'c_0*exp(x)'],
    ["y'=y", 'exp(x)'],
    ["y'=2*x", 'c_0+x^2'],
    ["y''=-y", 'cos(x)'],
    ["y''+y=0", 'c_0*cos(x)+c_1*sin(x)'],
    ['diff(y(x),x)=y(x)', 'c_0*exp(x)'],
    ['dy/dx=y', 'c_0*exp(x)'],
    // A one-element list is Giac's implicit-solution spelling.
    ["y'=y^2", '[1/(1/5-x)]'],
    // Exactness artifacts, not errors: an earlier numeric verifier on the system
    // path refused these because `normal` leaves `exp(ln(2)/3)-2^(1/3)` standing
    // and it evaluates to -7.1e-15.
    ["y'=y", 'sqrt(2)*exp(x)'],
    ["y'=y", '2^(1/3)*exp(x)'],
    // Every conjunction spelling Giac accepts. Knowing only `and` refused correct
    // answers on `&&`/`AND` and — worse — CERTIFIED a non-solution on them, because
    // the leftover boolean sometimes collapses to a truth value instead of
    // surviving normalisation.
    ["y'=y && y(0)=1", 'exp(x)'],
    ["y'=y AND y(0)=1", 'exp(x)'],
    ["y'=y and(y(0)=1)", 'exp(x)'],
    // U+2227, which Giac accepts and answers identically. Found by probing the
    // engine for what it takes as a join rather than by waiting for the next
    // review: `and`, `AND`, `&&`, `&&&` and `∧` are accepted; `And`, `et`, `xor`,
    // `∩`, `⋀` and `&` are not.
    ["y'=y ∧ y(0)=1", 'exp(x)'],
  ])('verifies %s satisfied by %s', async (equation, answer) => {
    const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(out, `${equation} / ${answer}`).toMatchObject({ verified: true });
  });

  it.each([
    // The point family: an argument Giac reads as a second equation.
    ["y'=y", '5/exp(x)*exp(x)'],
    // The value family, found one probe into a residual audit after two rounds
    // of widening a syntactic guard on the point.
    ["y'=y", 'x^2*exp(x)'],
    // The same non-solution under every conjunction spelling. `&&` and `AND` used
    // to come back verified:true here, which is the worst outcome available: the
    // check certifying the family it exists to catch.
    ["y'=y && y(x)=5", '5/exp(x)*exp(x)'],
    ["y'=y AND y(x)=5", '5/exp(x)*exp(x)'],
    ["y'=y and y(x)=5", '5/exp(x)*exp(x)'],
    ["y'=y ∧ y(x)=5", '5/exp(x)*exp(x)'],
    ["y'=2*x", 'x^2+x^2'],
    ["y''=-y", 'x^2*sin(x)'],
    ["y'=y*x", 'x^2*exp(x^2/2)'],
    // A disguised c_1/sin(x). Its residual is plainly nonzero but still mentions
    // c_1, so evaluating at a point alone gave NaN and the check declined — a
    // solution family has to hold for every constant, so an assignment that
    // leaves a residual is a disproof.
    ["y''=-y", '(-c_1*tan(x/2)^2+c_1)*1/2/tan(x/2)*cos(x)+c_1*sin(x)'],
  ])('refutes %s answered with %s', async (equation, answer) => {
    const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(out, `${equation} / ${answer}`).toMatchObject({ verified: false });
  });

  it('does not accuse an answer when the caller wrote conditions into the equation', async () => {
    // The first version substituted into the WHOLE equation argument, conditions
    // included, producing `(exp(x))(0)=1` and a confident disproof of a correct
    // answer: `desolve(y'=y and y(0)=1, x, y)` went from exp(x) to a hard error.
    // splitTopLevel takes a single character, so the `and` split it was given
    // silently split on nothing — which is why the guard needs its own.
    const out = await verifyOdeSolution("y'=y and y(0)=1", 'y', 'x', 'exp(x)', evaluate);
    expect(out).toMatchObject({ verified: true });
  });

  it.each([
    ['[y’=y, y(0)=1]'.replace('’', "'"), 'exp(x)'],
    ["y'=y, y(0)=1", 'exp(x)'],
  ])('takes the equation from the first member of %s', async (equation, answer) => {
    const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(out).toMatchObject({ verified: true });
  });

  it.each([
    // Nothing to substitute: not this function's equation to judge.
    ['z_1=w_2', 'exp(x)'],
    // A branch set — which branch the caller meant is a different question.
    ["y'=y^2", '[1/(1-x),2/(1-x)]'],
    // `y'(x)` is not one of the three spellings, and neither is `y''(x)`. Both were
    // partially substituted: the prime rule backtracked, the bare-`y` rule mopped up
    // the rest, and Giac then DROPPED the leftover `y''(x)` silently — so the
    // residual for `y''(x)=-y(x)` came back as the whole answer and refuted a
    // correct `cos(x)`. The substituted TEXT is now checked for a surviving mention
    // before the engine sees it, because a leftover the engine erases cannot be
    // seen downstream.
    ["y'(x)=y(x)", 'c_0*exp(x)'],
    ["y' (x)=y(x)", 'c_0*exp(x)'],
    ["y''(x)=-y(x)", 'cos(x)'],
    ["y''(x)+y(x)=0", 'cos(x)'],
    // A disjunction is not cut — the first term is not "the equation", so refuting
    // an answer to the second branch would be wrong. Giac refuses `or` in desolve
    // anyway, so this cannot arise from the compute route.
    ["y'=y or y(0)=1", 'exp(x)'],
    ["y'=y || y(0)=1", 'exp(x)'],
    // Two top-level `=` is not one equation. This row pins the OUTCOME, not the
    // line that produces it: removing the `=` count leaves it green, because the
    // later guards decline these anyway. The count is the half of the check that
    // does not depend on knowing a join spelling, so it is redundant against every
    // spelling currently known and is kept for one that is not — recorded here
    // rather than implied, since a row that passes either way proves nothing about
    // the line it appears to test.
    ["y'=y=1", 'exp(x)'],
    // Stripping the brackets can EXPOSE a join the cut could not see: inside the
    // member's own parentheses it is not top-level, and once they come off it is.
    // The assertion after the cut is what catches that; without it this would be
    // substituted into as though it were a bare equation. (`(y'=y and y(0)=1)`
    // alone does NOT reach it — the outer strip runs before the cut, so the join is
    // already top-level and gets cut normally.)
    ["[(y'=y and y(0)=1), q]", 'exp(x)'],
    // Too large to hand back to the engine.
    ["y'=y", `exp(x)*(${'1+'.repeat(2100)}1)`],
  ])('returns no verdict for %s / %s', async (equation, answer) => {
    const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(out).toBeUndefined();
  });
});
