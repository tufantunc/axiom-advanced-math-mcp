import { describe, it, expect } from 'vitest';
import { validateEquation } from '../src/server/tools/expression-validator.js';
import {
  isEngineFailure,
  solveEquationHandler,
  solveSystemHandler,
} from '../src/server/tools/solve.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

const INCOMPLETE_AFTER = (op: string) =>
  `Malformed equation: '${op}' has nothing after it — the equation is incomplete`;
const INCOMPLETE_BEFORE = (op: string) =>
  `Malformed equation: '${op}' has nothing before it — the equation is incomplete`;
const ASSIGNMENT = (op: string) =>
  `Malformed equation: '${op}' is an assignment, not an equation — write it with a single '='`;
const COMPARISON =
  "Malformed equation: '==' is a comparison, not an equation — write it with a single '='";
const TWO_EQUALS =
  "Malformed equation: more than one '=' — solve takes a single equation; use solve_system for several";
const UNPARSEABLE =
  'Malformed equation: Giac cannot parse part of it — check for a missing operator or a stray character';

/**
 * Giac does not reject a malformed equation, it answers it. Each row below was
 * measured on main 193da1c, where it came back with exit status 0:
 *
 *   x^2=     → {}               "no solutions"
 *   =4       → {}
 *   x^2+     → {}
 *   x^2=4=   → {√(undef_+4), -√(undef_+4)}
 *   x^2==4   → x                Giac's `==` is a boolean test
 *   x*=4     → GIAC_ERROR …     printed as the Result
 *   x^2=4 4  → {}               a swallowed syntax error
 */
describe('validateEquation — shapes a pattern can name', () => {
  it.each([
    ['x^2=', INCOMPLETE_AFTER('=')],
    ['x^2 = ', INCOMPLETE_AFTER('=')],
    ['x^2=4=', INCOMPLETE_AFTER('=')],
    ['x^2+', INCOMPLETE_AFTER('+')],
    ['x^2-', INCOMPLETE_AFTER('-')],
    ['sin(x)=(1+)', INCOMPLETE_AFTER('+')],
    ['x^2<', INCOMPLETE_AFTER('<')],
    ['=4', INCOMPLETE_BEFORE('=')],
    [' = 4', INCOMPLETE_BEFORE('=')],
    ['sin(*x)=1', INCOMPLETE_BEFORE('*')],
    ['x*=4', ASSIGNMENT('*=')],
    ['x^2-=4', ASSIGNMENT('-=')],
    ['x:=4', ASSIGNMENT(':=')],
    ['x^2==4', COMPARISON],
    ['x=4=y', TWO_EQUALS],
  ])('refuses %j', (equation, message) => {
    expect(validateEquation(equation)?.message).toBe(message);
  });

  it('still reports unbalanced delimiters first', () => {
    expect(validateEquation('x=sqrt(')?.message).toBe('1 unclosed parenthesis');
  });

  it.each([
    'x^2=4',
    'x^2-4',
    '-x=4',
    '+x=4',
    'x^-1=2',
    'x^(-1)=2',
    'sin(x)=(1+x)',
    'int(t,t=0..x)=2', // the inner `=` is a range, one level down
    'sum(k,k=1..n)=55',
    'x^2>=4',
    'x^2<=4',
    'x!=4',
    'x^2=4 and x>0',
    'x+y=3',
    '[1,-2]=[x,y]',
  ])('accepts %j', (equation) => {
    expect(validateEquation(equation)).toBeNull();
  });
});

describe('solve refuses a malformed equation (MCP compute)', () => {
  it.each([
    ['solve(x^2=', INCOMPLETE_AFTER('=')],
    ['solve(x^2=,x)', INCOMPLETE_AFTER('=')],
    ['csolve(x^2=)', INCOMPLETE_AFTER('=')],
    ['x^2=', INCOMPLETE_AFTER('=')],
    ['solve(=4)', INCOMPLETE_BEFORE('=')],
    ['solve(x^2+)', INCOMPLETE_AFTER('+')],
    ['solve(x^2=4=)', INCOMPLETE_AFTER('=')],
    ['solve(x^2==4)', COMPARISON],
    ['solve(x*=4)', ASSIGNMENT('*=')],
    ['solve(x=4=y)', TWO_EQUALS],
    // Past every pattern: only the engine's own reading shows these are broken.
    ['solve(x^2=4 4)', UNPARSEABLE],
    ['solve(x^2=4;)', UNPARSEABLE],
    ['solve(sin(x)=x y z)', UNPARSEABLE],
  ])('%s', async (problem, message) => {
    const r = await computeHandler({ problem });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(message);
    expect(allText(r)).not.toMatch(/^Result:/m);
  });

  it('refuses rather than printing a GIAC_ERROR or undef the engine returned', async () => {
    // `x@=1` passes both pre-flight checks. solve and csolve resolve with
    // `GIAC_ERROR: Unable to isolate x`, fsolve with `undef` — none is an answer.
    const r = await computeHandler({ problem: 'solve(x@=1)' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain('Could not solve equation');
    expect(allText(r)).not.toContain('GIAC_ERROR');
  });

  it('refuses a malformed equation inside a system', async () => {
    const r = await computeHandler({ problem: 'solve_system(x+y=, x-y=1)' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(INCOMPLETE_AFTER('='));
  });
});

describe('solve handlers refuse directly too', () => {
  it('solveEquationHandler', async () => {
    const r = await solveEquationHandler({ equation: 'x^2=', variable: 'x', domain: 'real' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(INCOMPLETE_AFTER('='));
  });

  it('solveSystemHandler', async () => {
    const r = await solveSystemHandler({ equations: ['x+y=3', 'x-y=1 1'], variables: ['x', 'y'] });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(UNPARSEABLE);
  });
});

describe('well-formed equations still solve', () => {
  it.each([
    ['solve(x^2=4)', '{-2, 2}'],
    ['solve(x^2=4,x)', '{-2, 2}'],
    ['solve(-x=4)', '-4'],
    ['solve(x^-1=2)', '1/2'],
    ['solve(x^2=4 x)', '{0, 4}'], // `4 x` is implicit multiplication, not an error
    ['solve(exp(x)=2)', 'ln(2)'],
    ['solve(x^2=-4)', '{2*i, -2*i}'],
    ['solve(int(t,t=0..x)=2,x)', '{-2, 2}'],
    ['solve(x^2>=4)', '{x<=-2, x>=2}'],
    ['solve_system(x+y=3, x-y=1)', '(2, 1)'],
  ])('%s → %s', async (problem, answer) => {
    const r = await computeHandler({ problem });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(resultLine(answer));
  });
});

/**
 * The solve handlers send the equation to Giac themselves (the escalation
 * candidates, the substitution check), and only evalWithLatex normalised. On
 * main 193da1c `solve(x²=4, x)` printed `Result: {-2, 2}` beside
 * `Verified: ✗ (substitution: no solutions to verify)`: every candidate had
 * solved for an identifier named `x²` and found nothing.
 */
describe('a superscript equation is solved and verified as written', () => {
  it.each([
    ['solve(x²=4, x)', '{-2, 2}', 'Verified: ✓ (substitution: 2/2 roots satisfy the equation)'],
    ['solve(x⁻¹=2)', '1/2', 'Verified: ✓ (substitution: 1/1 roots satisfy the equation)'],
    [
      'solve_system(x²+y=5, x-y=1)',
      '{(2, 1), (-3, -4)}',
      'Verified: ✓ (substitution: 2 solution(s) satisfy all equations)',
    ],
  ])('%s', async (problem, answer, verdict) => {
    const r = await computeHandler({ problem });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(resultLine(answer));
    expect(allText(r)).toContain(verdict);
  });

  it('solveEquationHandler normalises an equation it is handed directly', async () => {
    const r = await solveEquationHandler({ equation: 'x²=9', variable: 'x', domain: 'real' });
    expect(allText(r)).toMatch(resultLine('{-3, 3}'));
    expect(allText(r)).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
  });

  it('solveSystemHandler normalises equations it is handed directly', async () => {
    const r = await solveSystemHandler({ equations: ['x²=y', 'y=4'], variables: ['x', 'y'] });
    expect(allText(r)).toMatch(resultLine('{(2, 4), (-2, 4)}'));
    expect(allText(r)).toContain('Verified: ✓ (substitution: 2 solution(s) satisfy all equations)');
  });
});

/**
 * Giac's undefined marker is a whole token, not a prefix. Measured on main
 * b795f92, Giac prints it as `undef` (`quote(x^2=4 4)`, `fsolve(x@=1,x)`,
 * `quote(x^2=)` → `x^2=undef`) or as `undef_` inside a symbolic answer
 * (`solve(x^2=4=,x)` → `list[√(undef_+4),-√(undef_+4)]`), and never with a
 * digit after the underscore. Matching `/\bundef/` instead refused every
 * equation with a symbol whose NAME starts with the word, because the parse
 * probe runs on the caller's own text: `quote(undefined_k*x=2)` echoes it.
 */
describe('the undefined marker is matched as a token', () => {
  it.each([
    ['undef', true],
    ['x^2=undef', true],
    ['x^2=(4=undef)', true],
    ['list[√(undef_+4),-√(undef_+4)]', true],
    ['list[ln(undef_+4)]', true],
    ['list[√(-undef_),-√(-undef_)]', true],
    ['GIAC_ERROR: Unable to isolate x in x@1', true],
    ['list[2/undefined_k]', false],
    ['list[1/undefx]', false],
    ['undefined_k*x=2', false],
    ['list[√undef_1,-√undef_1]', false],
    ['k_undef*x=2', false],
    ['list[-2,2]', false],
  ])('%s → %s', (raw, failed) => {
    expect(isEngineFailure(raw)).toBe(failed);
  });

  it.each([
    ['solve(undefined_k*x=2, x)', '2/undefined_k', '1/1 roots'],
    ['solve(undefx*x=1, x)', '1/undefx', '1/1 roots'],
    ['solve(undefx^2=4, undefx)', '{-2, 2}', '2/2 roots'],
    ['solve(x^2=undef_1, x)', '{√undef_1, -√undef_1}', '2/2 roots'],
  ])('%s → %s, verified', async (problem, answer, roots) => {
    const r = await computeHandler({ problem });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(resultLine(answer));
    expect(allText(r)).toContain(`Verified: ✓ (substitution: ${roots} satisfy the equation)`);
  });

  it('solveEquationHandler solves for a variable beside such a symbol', async () => {
    const r = await solveEquationHandler({
      equation: 'undefined_k*x^2=undefined_k*9',
      variable: 'x',
      domain: 'real',
    });
    expect(r.isError).toBe(false);
    expect(allText(r)).toMatch(resultLine('{-3, 3}'));
    expect(allText(r)).toContain('Verified: ✓ (substitution: 2/2 roots satisfy the equation)');
  });

  it("refuses a symbol spelled exactly like Giac's marker", async () => {
    // `undef_` in an answer is indistinguishable from the marker, so it is
    // refused rather than risk passing a swallowed syntax error on.
    const r = await computeHandler({ problem: 'solve(x^2+undef_=0, x)' });
    expect(r.isError).toBe(true);
    expect(allText(r)).toContain(UNPARSEABLE);
  });
});
