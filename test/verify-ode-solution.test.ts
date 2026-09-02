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
    // A join the cut did not recognise leaves the caller's condition sitting in the
    // equation, and every measured instance of that shipped a non-solution. So this
    // refuses rather than declining: "I could not check" ships, and this is not that
    // — it is "there is something here that is not the equation".
    //
    // The part no join spelling can walk past. It does not ask what the join was,
    // only whether what is left is one equation, so `et`, `⋀` or whatever the next
    // round would have found lands here instead of in a shipped answer.
    ["y'=y or y(0)=1", 'exp(x)'],
    ["y'=y || y(0)=1", 'exp(x)'],
    // Two top-level `=` is not one equation, whatever joined them.
    ["y'=y=1", 'exp(x)'],
    // Stripping the brackets can EXPOSE a join the cut could not see: inside the
    // member's own parentheses it is not top-level, and once they come off it is.
    ["[(y'=y and y(0)=1), q]", 'exp(x)'],
  ])('refuses %s rather than shipping it unchecked', async (equation, answer) => {
    const verdict = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(verdict?.verified).toBe(false);
    expect(verdict?.detail).toMatch(/carries more than one equation or condition/);
  });

  it.each([
    // Nothing to substitute: not this function's equation to judge.
    ['z_1=w_2', 'exp(x)'],
    // The same domain problem with NO marker to spot it by. `sqrt(1-y^2)` makes the
    // residual cos(θ)-√(1-sin²θ), which is cos(θ)-|cos(θ)| wearing a square root:
    // zero while cos θ >= 0, nonzero after. One probe at x=13/10 sits past that
    // boundary, so this correct answer was refuted — and adding `sqrt` to the marker
    // list would have gutted the disproof for every equation with a radical in it.
    // The domain is sampled instead, and a residual that vanishes anywhere on the
    // sample is an artifact rather than evidence.
    ["y'=sqrt(1-y^2)", 'sin(x+pi/6)'],
    // A branch solution: the CONSTANT is the domain boundary, so probing at a fixed
    // x with an assigned c_0 asks whether a correct answer holds at a point it never
    // claimed. All six of these were refused — correct answers, all of which main
    // returned — and whether it fired was luck: the same equation with y(0)=1 gives
    // [(1+x/2)^2], where the probe point lands inside the branch, and shipped.
    // `abs(`/`sign(` in the residual is the signature; no pinned disproof carries one.
    ["y'=sqrt(y)", '[(-1/2*c_0+1/2*x)^2]'],
    ["y'=y^(1/2)", '[(-1/2*c_0+1/2*x)^2]'],
    ["y'=sqrt(y+1)", '[(-1/2*c_0+1/2*x)^2-1]'],
    ["y'=x*sqrt(y)", '[(-1/2*c_0+1/4*x^2)^2]'],
    ["y'=y^(3/2)", '[(2/(c_0-x))^2]'],
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
    // Too large to hand back to the engine.
    ["y'=y", `exp(x)*(${'1+'.repeat(2100)}1)`],
  ])('returns no verdict for %s / %s', async (equation, answer) => {
    const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate);
    expect(out).toBeUndefined();
  });

  /**
   * The conditions, which the equation's residual says nothing about.
   *
   * An IVP asks a strictly stronger question than its equation does, and until
   * these rows every answer below earned an honest ✓ for the half that was
   * checked: `2*exp(x)` is a genuine solution of `y'=y` and of the initial-value
   * problem `y(0)=2`, which is not the one the caller posed. Eleven measured
   * answers were marked verified that way, `sin(x)` for `y''=-y, y(0)=1, y'(0)=0`
   * among them — wrong in BOTH conditions.
   *
   * `conditionSource` is the sixth argument: the command the extractor built, in
   * which the conditions live. The caller's own equation stays the first argument,
   * so the two spellings a caller can use — conditions folded in from separate
   * arguments, and conditions written into the equation — are both covered, and
   * the equation's residual is still checked against what they wrote.
   */
  it.each([
    // Folded in from separate arguments, the shape `desolve(y'=y, y(0)=1, x, y)`
    // builds.
    ["y'=y", 'exp(x)', "(y'=y) and (y(0)=1)"],
    ["y''=-y", 'cos(x)', "(y''=-y) and (y(0)=1) and (y'(0)=0)"],
    // A member list, which is what the fold uses when the equation already has
    // top-level commas.
    ["y'=y", 'exp(x)', "[y'=y, y(0)=1]"],
    // Under-determined and legitimate: `desolve(y''=-y, y(0)=1, x, y)` really does
    // answer this, and the surviving `c_1` is not a failure to apply the condition
    // — cos(0) + c_1*sin(0) - 1 is exactly zero whatever c_1 is.
    ["y''=-y", 'cos(x)+c_1*sin(x)', "(y''=-y) and (y(0)=1)"],
    // A float condition, whose residual prints `0.0` rather than `0`. Comparing
    // components to the string '0' is the trap this project has now paid for
    // twice, most recently in verifyOdeSystem's own condition block.
    ["y'=y", '1.5*exp(x)', "(y'=y) and (y(0)=1.5)"],
    ["y'=0.5*y", '2.5*exp(x*0.5)', "(y'=0.5*y) and (y(0)=2.5)"],
    // A symbolic point and a symbolic value. `desolve(y'=y, y(a)=b, x, y)` answers
    // this and must keep its mark: the residual normalises to 0 without either
    // symbol needing a number.
    ["y'=y", 'b/exp(a)*exp(x)', "(y'=y) and (y(a)=b)"],
    // A BVP, with a transcendental point and a symbolic endpoint.
    ["y''=-y", 'sin(x)', "(y''=-y) and (y(0)=0) and (y(pi/2)=1)"],
    ["y''=0", 'x/L', "(y''=0) and (y(0)=0) and (y(L)=1)"],
    // Conditions away from the origin, and at a negative point.
    ["y''=-y", '-cos(x)', "(y''=-y) and (y(pi)=1) and (y'(pi)=0)"],
    ["y'=y", '2*exp(1)*exp(x)', "(y'=y) and (y(-1)=2)"],
    // Derivative conditions to second order, differentiated before being
    // evaluated at the point — `y''(0)=6` is a claim about the second derivative
    // AT 0, and `desolve(y'''=0, y(0)=1, y'(0)=2, y''(0)=6, x, y)` answers this.
    ["y'''=0", '(6*x^2+2*x*2+2)/2', "(y'''=0) and (y(0)=1) and (y'(0)=2) and (y''(0)=6)"],
    // Giac's one-element list, its implicit-solution spelling: the condition is
    // checked against the member, not against the brackets.
    ["y'=y^2", '[1/(-x+1)]', "(y'=y^2) and (y(0)=1)"],
    // Conditions written into the equation, with no fold at all — the sixth
    // argument absent, which is how every caller of this function outside
    // calculus.ts reaches it.
    ["y'=y and y(0)=1", 'exp(x)', undefined],
    // One condition written into the equation and another passed as an argument,
    // so the fold nests the two spellings: `(y'=y and y(0)=1) and (y(1)=exp(1))`.
    // A single top-level split leaves `y'=y and y(0)=1` as the first clause, which
    // is not the equation, so without flattening through the brackets this correct
    // answer loses its mark instead of earning it.
    ["y'=y and y(0)=1", 'exp(x)', "(y'=y and y(0)=1) and (y(1)=exp(1))"],
    // `&&&`, which the engine accepts as a conjunction. The cut only had to know
    // WHERE a join starts and behaved the same on `&&` and `&&&`; the splitter has
    // to step over it, and a two-character reading left a stray `&` heading the
    // next clause, which matched no condition and cost this correct answer its mark.
    ["y'=y", 'exp(x)', "(y'=y)&&&(y(0)=1)"],
    // `normal` is not a zero test. It leaves `exp(ln(2)/3)-2^(1/3)` standing — the
    // artifact this file already records for the equation's residual — so this
    // correct answer lost its mark for a condition it satisfies exactly. The
    // fallback asks `simplify`, which is a stronger simplification and not a
    // smaller number, so the mark is still only given where it is proven.
    ["y'=y", 'exp(ln(2)/3)*exp(x)', "(y'=y) and (y(0)=2^(1/3))"],
    // A factorial value. `desolve(y'=y, y(0)=5!, x, y)` is a real request answered
    // `120*exp(x)`, and a bare `!` in the rule that refuses comparisons cost it its
    // mark — `!` is factorial, and only `!=` is a comparison.
    ["y'=y", '120*exp(x)', "(y'=y) and (y(0)=5!)"],
    // Exactly as many conditions as the cap allows, so the bound is pinned from
    // both sides: nine of these declines, eight is still certified.
    ["y'=y", 'exp(x)', `(y'=y)${' and (y(0)=1)'.repeat(8)}`],
  ])(
    'verifies %s satisfied by %s together with the conditions in %s',
    async (equation, answer, conditionSource) => {
      const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate, conditionSource);
      expect(out, `${equation} / ${answer}`).toMatchObject({ verified: true });
    }
  );

  it('says in the detail that the conditions were checked, not only the equation', async () => {
    // The mark's own words have to distinguish the two claims, because a ✓ that
    // reads the same whether or not the conditions were looked at is how this
    // family shipped in the first place.
    const withConditions = await verifyOdeSolution(
      "y'=y",
      'y',
      'x',
      'exp(x)',
      evaluate,
      "(y'=y) and (y(0)=1)"
    );
    expect(withConditions?.detail).toMatch(/and meets the conditions$/);
    const equationOnly = await verifyOdeSolution("y'=y", 'y', 'x', 'exp(x)', evaluate);
    expect(equationOnly?.detail).not.toMatch(/conditions/);
  });

  it.each([
    // The reproduction. Each answer solves the equation exactly and misses a
    // condition, and each was marked verified:true before the conditions were
    // checked.
    ["y'=y", '2*exp(x)', "(y'=y) and (y(0)=1)"],
    // Both conditions wrong at once: sin(0) is 0, not 1, and sin'(0) is 1, not 0.
    ["y''=-y", 'sin(x)', "(y''=-y) and (y(0)=1) and (y'(0)=0)"],
    ["y'=y", 'exp(x)', "[y'=y, y(0)=2]"],
    // Written into the equation, in every conjunction spelling Giac accepts. The
    // cut takes the equation from before the join, so without a condition check
    // these were the same false ✓ four times over.
    ["y'=y and y(0)=1", '2*exp(x)', undefined],
    ["y'=y && y(0)=1", '2*exp(x)', undefined],
    ["y'=y AND y(0)=1", '2*exp(x)', undefined],
    ["y'=y ∧ y(0)=1", '2*exp(x)', undefined],
    ["[y'=y, y(0)=1]", '2*exp(x)', undefined],
    ["y''=-y and y(0)=1 and y'(0)=0", 'sin(x)', undefined],
    // Both spellings at once, which is what a caller who writes one condition into
    // the equation and passes another as an argument gets. A single top-level split
    // stops at `(y'=y and y(0)=1)` and would have missed the inner condition, so
    // the clauses are flattened through the brackets.
    ["y'=y and y(0)=1", '2*exp(x)', "(y'=y and y(0)=1) and (y(1)=2)"],
    // The general solution is not a verified answer to an IVP: `c_0-1` is not zero
    // for every c_0, so nothing here proves the condition was applied. Declining is
    // the whole verdict — see below for why it is never a refusal.
    ["y'=y", 'c_0*exp(x)', "(y'=y) and (y(0)=1)"],
    // Conditions this cannot read, declined rather than guessed at. Reading any of
    // them wrong would mean substituting into something whose meaning was assumed,
    // which is how the earlier rounds on this file manufactured residuals.
    //
    //   - `diff(y(x),x)(0)=0` is the one spelling Giac itself drops, so an answer
    //     cannot be certified against it even though cos(x) does satisfy it.
    //   - `z(0)=1` is about another function.
    //   - a disjunction is a set of alternatives, not a claim that both hold.
    //   - `1==1` is a proposition; subtracting a truth value is not the claim.
    //   - `y(x)=1` mentions the independent variable, which Giac reads as a second
    //     equation — that family is the equation residual's business, and
    //     substituting `x=x` here would mean nothing.
    ["y''=-y", 'cos(x)', "(y''=-y) and (diff(y(x),x)(0)=0)"],
    ["y'=y", 'exp(x)', "(y'=y) and (z(0)=1)"],
    ["y'=y", 'exp(x)', "(y'=y) and (y(0)=1 or y(0)=2)"],
    ["y'=y", 'exp(x)', "(y'=y) and (y(0)=1==1)"],
    ["y'=y", 'exp(x)', "(y'=y) and (y(x)=1)"],
    // The shape that makes the variable guard earn itself rather than merely agree
    // with the residual: `y(x)=exp(x)` is an identity the answer really does
    // satisfy, so without the guard it is read as a condition, holds, and the mark
    // comes back saying the conditions were met — about a clause that is not one.
    ["y'=y", 'exp(x)', "(y'=y) and (y(x)=exp(x))"],
    // A bracketed point. The character class excluded only parentheses and commas
    // at first, so `y([0])=1` parsed, `subst(exp(x),x=([0]))` was evaluated, and the
    // answer was certified against the point `[0]` — a reading that happened to
    // agree with Giac's and need not have.
    ["y'=y", 'exp(x)', "(y'=y) and (y([0])=1)"],
    // A disjunction as the VALUE. `y(0)=1 or y(0)=2` was declined only because its
    // second disjunct carries an `=`; parenthesise it and the `=` goes away, Giac
    // evaluates `1 or 2` to 1, and the mark came back saying the conditions were
    // met about a clause whose value is a boolean.
    ["y'=y", 'exp(x)', "(y'=y) and (y(0)=(1 or 2))"],
    ["y'=y", 'exp(x)', "(y'=y) and (y(0)=(2 && 1))"],
    // The cross-check between the two texts. `conditionSource` is trusted for the
    // conditions only on the strength of its first clause being the caller's own
    // equation; where it is not, the rest of it is not known to be this equation's
    // conditions and nothing is claimed about them.
    ["y'=y", 'exp(x)', "(y'=2*y) and (y(0)=1)"],
    // More conditions than the check will pay for. Nine here, all of them
    // satisfied — it still declines, because certifying a prefix of the conditions
    // is the failure these rows exist to remove.
    ["y'=y", 'exp(x)', `(y'=y)${' and (y(0)=1)'.repeat(9)}`],
  ])(
    'withholds the mark from %s answered %s under conditions %s',
    async (equation, answer, conditionSource) => {
      const out = await verifyOdeSolution(equation, 'y', 'x', answer, evaluate, conditionSource);
      // Undefined, NOT verified:false. A missed condition is never a disproof
      // here: measured, the CORRECT answer to `desolve(y'=y, y(0.1)=1e10, x, y)`
      // is `9048374180.36*exp(x)`, whose condition residual is 3.7e-4 — four
      // orders above the 1e-6 the equation's disproof uses, and 3.7e-14 relative
      // — so an absolute threshold would refuse a correct answer and a relative
      // one is the scoring this file already records as unable to tell correct
      // from wrong. And an under-determined answer's `c_1` is not evidence
      // either. So the certificate is withdrawn and the answer still ships,
      // which is exactly verifyOdeSystem's rule for the same question.
      expect(out, `${equation} / ${answer} / ${conditionSource}`).toBeUndefined();
    }
  );

  it('never turns a missed condition into a refusal', async () => {
    // The property the rows above assert one at a time, stated once so that a
    // future round cannot quietly promote a decline into a ✗. calculus.ts refuses
    // the request on `verified === false`, so a disproof invented here becomes a
    // hard error on a correct answer — the outcome this whole file is arranged to
    // avoid.
    const answers = ['2*exp(x)', 'c_0*exp(x)', '3*exp(x)', 'exp(x)/2'];
    for (const answer of answers) {
      const out = await verifyOdeSolution(
        "y'=y",
        'y',
        'x',
        answer,
        evaluate,
        "(y'=y) and (y(0)=1)"
      );
      expect(out?.verified, answer).not.toBe(false);
    }
  });
});
