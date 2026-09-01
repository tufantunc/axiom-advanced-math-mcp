import type { RouteResult } from './types.js';
import {
  parseOdeSystem,
  differentiatedFunction,
  isDerivativeEquation,
} from '../ode-system-shape.js';
import { coerceTestData } from '../hypothesis-testing.js';
import {
  extractFnArgs,
  splitArgs,
  parseCallArgs,
  pickNumbers,
  parseBracketList,
  parsePointList,
  parsePointPairs,
  parseNumberList,
  expressionArg,
  stripEnclosingBrackets,
} from './arg-parsing.js';
import { isNumberList } from '../value-guards.js';
import { rewriteCombinatorics } from '../combinatorics-rewrite.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Guess the primary variable from an expression by finding single-letter
 * identifiers that aren't common constants (e, i) or function names.
 */
function guessVariable(expr: string): string {
  const varMatch = expr.match(/\b([a-zA-Z])\b/g);
  if (!varMatch) return 'x';
  const constants = new Set(['e', 'i', 'E', 'I']);
  for (const v of varMatch) {
    if (!constants.has(v)) return v;
  }
  return 'x';
}

/**
 * The variable an ODE is solved with respect to: the first single-letter
 * identifier that is neither the unknown function nor a constant.
 */
function independentVariable(equation: string, functionName: string): string {
  const candidates = equation.match(/\b([a-zA-Z])\b/g) ?? [];
  const excluded = new Set([functionName, 'e', 'E', 'i', 'I']);
  return candidates.find((name) => !excluded.has(name)) ?? 'x';
}

/**
 * Extract matrix string [[...],[...]] from problem.
 */
function extractMatrixString(problem: string): string {
  const match = /(\[\s*\[[\s\S]*\]\s*\])/.exec(problem);
  return match ? match[1] : '';
}

function extractVariables(equations: string[]): string[] {
  const vars = new Set<string>();
  for (const eq of equations) {
    const matches = eq.match(/\b([a-zA-Z])\b/g);
    if (matches)
      matches.forEach((v) => {
        if (v !== 'e' && v !== 'E') vars.add(v);
      });
  }
  return Array.from(vars);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

// --- Solve ---

/**
 * Is this argument a variable list rather than an equation list?
 *
 * `solve_system` accepts both `solve_system([x+y=3, x-y=1], [x, y])` and bare
 * `solve_system(x+y=3, x-y=1)`. Positionally these are indistinguishable, so
 * classify by content: a variable list holds nothing but bare identifiers.
 */
function isVariableList(part: string): boolean {
  const tokens = splitArgs(stripEnclosingBrackets(part.trim()));
  return tokens.length > 0 && tokens.every((t) => /^[A-Za-z]\w*$/.test(t.trim()));
}

export function extractSolveSystem(problem: string): RouteResult {
  // Try to parse "solve_system([eq1, eq2], [x, y])" or "[eq1; eq2]" formats
  if (/^solve_system\s*\(/i.test(problem.trim())) {
    const parts = splitArgs(extractFnArgs(problem), true);

    // Assuming `([equations], [variables])` positionally made
    // `solve_system(x+y=3, x-y=1)` build `solve([x+y=3],[x-y=1])`: the second
    // equation became the variable list and Giac answered `{}` — the empty
    // solution set — with isError:false.
    const equations: string[] = [];
    let variables: string[] = [];
    for (const part of parts) {
      if (isVariableList(part)) {
        variables = variables.concat(
          splitArgs(stripEnclosingBrackets(part.trim())).map((v) => v.trim())
        );
      } else {
        equations.push(...splitArgs(stripEnclosingBrackets(part.trim())).map((e) => e.trim()));
      }
    }
    return {
      handler: 'solve_system',
      args: {
        equations,
        variables: variables.length > 0 ? variables : extractVariables(equations),
      },
    };
  }
  // Semicolon-separated equations
  if (problem.includes(';')) {
    const equations = problem
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
    return {
      handler: 'solve_system',
      args: { equations, variables: extractVariables(equations) },
    };
  }
  // [eq1, eq2] bracket format
  const equations = parseBracketList(problem);
  return {
    handler: 'solve_system',
    args: { equations, variables: extractVariables(equations) },
  };
}

export function extractSolveEquation(problem: string, domain?: string): RouteResult {
  if (/^(c?solve)\s*\(/i.test(problem.trim())) {
    const inner = extractFnArgs(problem);
    const parts = splitArgs(inner);
    const equation = parts[0] || '';
    const variable = parts[1] || guessVariable(equation);
    const isComplex = problem.trim().toLowerCase().startsWith('csolve') || domain === 'complex';
    return {
      handler: 'solve_equation',
      args: { equation, variable, domain: isComplex ? 'complex' : 'real' },
    };
  }
  // Implicit: expression with = sign
  const variable = guessVariable(problem);
  return {
    handler: 'solve_equation',
    args: { equation: problem.trim(), variable, domain: domain === 'complex' ? 'complex' : 'real' },
  };
}

// --- Calculus ---

export function extractDiff(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const order = parts[2] ? Number.parseInt(parts[2], 10) : undefined;
  return {
    handler: 'calculus',
    args: {
      operation: 'differentiate',
      expression,
      variable,
      ...(order ? { order } : {}),
    },
  };
}

export function extractIntegrate(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const lower_bound = parts[2];
  const upper_bound = parts[3];
  return {
    handler: 'calculus',
    args: {
      operation: 'integrate',
      expression,
      variable,
      ...(lower_bound !== undefined ? { lower_bound } : {}),
      ...(upper_bound !== undefined ? { upper_bound } : {}),
    },
  };
}

export function extractLimit(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const point = parts[2] || '0';
  const direction = parts[3] as '+' | '-' | undefined;
  return {
    handler: 'calculus',
    args: {
      operation: 'limit',
      expression,
      variable,
      point,
      ...(direction ? { direction } : {}),
    },
  };
}

export function extractTaylor(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  // taylor(expr, var=point, order) or taylor(expr, var, point, order)
  let variable = parts[1] || guessVariable(expression);
  // No initialiser: both branches below assign it, so '0' was never read.
  let point: string;
  let order: number | undefined;

  if (variable.includes('=')) {
    const [v, p] = variable.split('=');
    variable = v.trim();
    point = p.trim();
    order = parts[2] ? Number.parseInt(parts[2], 10) : undefined;
  } else {
    point = parts[2] || '0';
    order = parts[3] ? Number.parseInt(parts[3], 10) : undefined;
  }

  return {
    handler: 'calculus',
    args: {
      operation: 'taylor',
      expression,
      variable,
      point,
      ...(order ? { order } : {}),
    },
  };
}

/**
 * An initial or boundary condition as a caller writes it beside the equation:
 * `y(0)=1`, `y'(0)=0`, `y''(1)=3`.
 *
 * Primes are part of the shape, unlike CONDITION_FORM in ode-system-shape.ts.
 * That one guards the system path, which rewrites to Y' = A*Y + b and is
 * first-order by construction, so `y'(0)` cannot arise there; a single equation
 * can be any order. Sharing one regex would have to loosen that path to suit
 * this one.
 *
 * Requiring the `=` is what keeps a bare call — `ifactor(2^257-1)` — from being
 * read as a condition and folded into the command.
 *
 * The point is a single argument: `\(\s*[^),]*\s*\)`, not `\([^)]*\)`. The looser
 * group accepted `y(0,1)=1`, folded it, and Giac answered as though the caller
 * had written `y(0)=1` — a confident answer to a different problem.
 */
const SINGLE_ODE_CONDITION = /^[A-Za-z_]\w*'*\s*\(\s*[^),]*\s*\)\s*=\s*(.+)$/;

/** The point a condition is stated at, for the variable test after inference. */
const CONDITION_POINT = /^[A-Za-z_]\w*'*\s*\(\s*([^),]*)\s*\)\s*=/;

/**
 * A condition's right-hand side must be a VALUE, not a proposition.
 *
 * `.+` admitted a top-level boolean, and parenthesising the join — correct on
 * its own terms — turned that from a Giac error into a silent loss:
 * `(y'=y) and (y(0)=1 or y(0)=2)` is accepted, the condition is ignored, and
 * `c_0*exp(x)` ships with isError:false. That is the very shape this extractor
 * was changed to remove. `y(0)=1==1` answered -exp(x) the same way.
 */
const CONDITION_VALUE_IS_A_PROPOSITION = /\b(and|or)\b|[=<>!]=|[<>]/;

function isCondition(part: string): boolean {
  // An equation is not a condition, and the test is the one parseOdeSystem uses,
  // so a spelling it reads as a derivative cannot be folded in as a condition.
  // `diff(z)=5` satisfies the shape below — identifier, one argument, `=`, value
  // — and folding it turned `[y'=y]` into a two-equation system and
  // `[y'=z, z'=-y]` into a three-component one, answers to systems the caller
  // never wrote, carrying verification marks honest about the wrong system.
  if (isDerivativeEquation(part)) return false;
  const rhs = SINGLE_ODE_CONDITION.exec(part)?.[1];
  return rhs !== undefined && !CONDITION_VALUE_IS_A_PROPOSITION.test(rhs);
}

/**
 * The unknowns of a SYSTEM, named as Giac's own third argument: `[y,z]`, or
 * `[y(x),z(x)]`.
 *
 * Ignorable when it MATCHES, refused when it does not — the membership rule is
 * at the use site. For a real system parseOdeSystem derives the function list
 * from the equations and `function_name` is never read, so naming the unknowns
 * correctly is redundant rather than wrong; naming different ones states an arity
 * or a set the system does not have, and `[q]` must reach the same verdict as
 * `q(x)` or the same claim spelled two ways gets opposite answers. Refusing it took previously-correct,
 * self-verified calls to a hard error — four rows below cover them.
 *
 * What this does NOT restore is the spelling prompts/index.ts advertises,
 * `desolve([eq1,eq2],[f,g])` with no variable argument. Recognising the list
 * leaves `named` empty, so the variable falls to independentVariable(), which
 * picks one of the unknowns and the call is refused as "uses z as both the
 * independent variable and an unknown function" — on main too. Accepting the
 * list is necessary for the variable-supplied spellings and not sufficient for
 * that one; making it answerable means excluding the system's own function names
 * from independentVariable's candidates, which is a separate change.
 */
const UNKNOWNS_LIST =
  /^\[\s*[A-Za-z]\w*(\s*\(\s*[A-Za-z]\w*\s*\))?(\s*,\s*[A-Za-z]\w*(\s*\(\s*[A-Za-z]\w*\s*\))?)*\s*\]$/;

const BARE_IDENTIFIER = /^[A-Za-z]\w*$/;

/**
 * The unknown function written applied: `y(x)`.
 *
 * The canonical spelling in the dialects whose verbs this router advertises —
 * `dsolve` is Maple's and SymPy's — and already caller idiom in this repo, whose
 * own fixtures use `diff(y(x),x)`. Dropping it used to work by accident:
 * inference recovered the same function name from the equation. Classifying it
 * as unsupported turned `desolve(y'=y, y(x))`, correct on main, into a refusal.
 *
 * Both identifiers are bare, so `ifactor(2^257-1)` stays out.
 */
const APPLIED_FUNCTION = /^([A-Za-z]\w*)\s*\(\s*[A-Za-z]\w*\s*\)$/;

export function extractOde(problem: string): RouteResult {
  if (/^(desolve|dsolve|odesolve|solve_ode)\s*\(/i.test(problem.trim())) {
    const inner = extractFnArgs(problem);
    const parts = splitArgs(inner);
    const equation = parts[0] || '';

    // Giac takes (equation, independent variable, function), and with three
    // arguments that is exactly what arrives. With ONE identifier argument the
    // arity says nothing about which role it plays, and both spellings are in
    // use: `desolve(y'=x, y)` names the function, while `desolve(y'=2*x, x)` —
    // the form prompts/index.ts tells callers to write, minus its last argument
    // — names the variable.
    //
    // Reading it as the variable made `desolve(y'=x, y)` build
    // `desolve(y'=x,y,y)`, answered `c_0+x*y-y` instead of x²/2 + c. Reading it
    // as the function broke the other spelling just as quietly: `desolve(y'=2*x,
    // x)` became `[1/2]`. The equation settles it — the unknown function is the
    // one that appears differentiated.
    // Every trailing argument is used or refused. They used to be filtered down
    // to the bare identifiers and the rest discarded, so `desolve(y'=y, y(0)=1)`
    // emitted `desolve(y'=y,x,y)` and answered `c_0*exp(x)` — the general
    // solution — with isError:false. The correct answer is exp(x). The condition
    // the caller wrote never reached the engine, and nothing said so.
    const rest = parts
      .slice(1)
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    // `y(x)` names the function by its identifier, so it joins the identifiers
    // rather than forming a fourth category.
    const trimmedEquation = equation.trim();
    // A bracketed equation is a SYSTEM, and the two paths have different rules
    // about the trailing arguments, so this has to be known before they are
    // classified.
    // The MEMBERS parseOdeSystem will read, not the caller's outer punctuation.
    // stripEnclosingBrackets peels `(` and `[` alike, and repeatedly, so the list
    // it reaches is not always the one the outer brackets name: keying the fold
    // off `startsWith('[')` appended ` and …` after `(y'=z, z'=-y)` — a real
    // system — and inserted inside the outer bracket of `[[y'=z, z'=-y]]`, one
    // level above the members. Both then parsed as non-systems downstream and
    // were refused, where main answered and verified them.
    const strippedEquation = stripEnclosingBrackets(trimmedEquation);
    // A member LIST takes conditions as further members; a lone equation joins
    // them with `and`. This is the syntax question asked correctly — a top-level
    // comma after stripping, rather than the punctuation that happened to be
    // outermost.
    //
    // The reason is parseOdeSystem, not Giac. calculus.ts decides whether to take
    // the Y' = A*Y + b path by parsing this text, and it only reads conditions
    // that are MEMBERS of the list. `[y'=z, z'=-y] and y(0)=1` parses as no system
    // at all, which is how appending once cost the matrix rewrite, the components
    // note and the verification, and answered `[]`.
    //
    // Not a Giac constraint: measured through giacEngine, `and` carries a list
    // perfectly well — `desolve(([y''=-y, y(0)=1]) and (y'(0)=0),x,y)` answers
    // cos(x), the same as the list spelling. Two earlier versions of this comment
    // claimed otherwise, first that Giac drops a derivative condition in list form
    // and then that `and` cannot hold a comma; both were measured false. The one
    // spelling Giac really does drop is `diff(y(x),x)(0)=0`, and this never folds
    // it because SINGLE_ODE_CONDITION rejects its inner comma.
    const isMemberList = splitArgs(strippedEquation).length > 1;
    const fold = (members: string[]): string =>
      isMemberList
        ? `[${strippedEquation}, ${members.join(', ')}]`
        : `(${strippedEquation}) and (${members.join(') and (')})`;
    // `y(x)` names the FUNCTION — it cannot be an independent variable — so that
    // fact is carried rather than re-derived below.
    // The system parser's reader, not a second one. Two readers that knew
    // different spellings is why the `diff(y(x),x)` form fell through every rule
    // keyed on "the equation differentiates something else".
    const differentiated = differentiatedFunction(equation);
    // The SAME predicate calculus.ts uses, not the punctuation. The rules used to
    // key off the brackets, and parseOdeSystem needs two
    // derivative members — its own docblock says `[y'=2*x, y(0)=1]` is a single
    // equation. So bracketed non-systems got the system's trailing-argument rules
    // and the single-equation path's consequences: `desolve([y'=y, y(0)=1], x, y,
    // zzz)` answered exp(x) and dropped `zzz`, the drop this change exists to
    // remove, while the unbracketed same request was refused.
    const parsedSystem = parseOdeSystem(trimmedEquation);
    const isSystem = parsedSystem !== null;

    const systemFunctions = new Set(parsedSystem?.equations.map((e) => e.fn) ?? []);
    // Classified by POSITION, so the argument reported back is the first one the
    // caller wrote rather than the first some filter reached.
    const roles = rest.map((part) => {
      const applied = APPLIED_FUNCTION.exec(part)?.[1];
      if (applied !== undefined) {
        // A system's unknowns may be named applied, and function_name is unused
        // on that path, so naming one is redundant rather than wrong. Comparing
        // against `differentiated` refused them: that helper returns only the
        // FIRST differentiated name, so for `[y'=z, z'=-y]` every unknown but `y`
        // looked like a contradiction — `x, y(x)` was accepted and `x, z(x)`
        // refused for the same system. Membership is the right test, and a name
        // that is not an unknown of the system is still refused.
        if (isSystem) {
          // A system that differentiates the same function twice is refused
          // downstream by name ("differentiates the same function twice: y, y").
          // The Set collapses the duplicate, so refusing here preempted that with
          // a message about the wrong thing.
          const duplicated = systemFunctions.size !== parsedSystem.equations.length;
          return systemFunctions.has(applied) || duplicated
            ? ({ kind: 'unknowns' } as const)
            : ({ kind: 'unsupported' } as const);
        }
        // Single equation: `y(x)` names the function. If the equation
        // differentiates something else the two disagree and the caller has to
        // settle it — silently preferring either is how this file's older bugs
        // read.
        return differentiated !== undefined && applied !== differentiated
          ? ({ kind: 'unsupported' } as const)
          : ({ kind: 'function', name: applied } as const);
      }
      if (BARE_IDENTIFIER.test(part)) return { kind: 'identifier', name: part } as const;
      if (isCondition(part)) return { kind: 'condition' } as const;
      // Recognised on both paths — gating it on the system made
      // `desolve(y'=y, [y])`, answered on main, a refusal while
      // `desolve([y'=y], [y])` was accepted: same mathematics, opposite outcomes
      // decided by whether the caller bracketed the equation.
      //
      // Checked for membership like the applied case, and for the same reason:
      // without it `q(x)` was refused while `[q]` was accepted and ignored — the
      // same claim spelled two ways getting opposite verdicts, which is the defect
      // the applied rule was added to remove. `[y,z,w]` on a two-equation system
      // states an arity the system does not have, so the sets must match.
      if (UNKNOWNS_LIST.test(part)) {
        const names = splitArgs(stripEnclosingBrackets(part)).map(
          (n) => APPLIED_FUNCTION.exec(n.trim())?.[1] ?? n.trim()
        );
        const matches = isSystem
          ? names.length === systemFunctions.size && names.every((n) => systemFunctions.has(n))
          : differentiated === undefined || (names.length === 1 && names[0] === differentiated);
        return matches ? ({ kind: 'unknowns' } as const) : ({ kind: 'unsupported' } as const);
      }
      return { kind: 'unsupported' } as const;
    });
    const appliedNames = roles.flatMap((r) => (r.kind === 'function' ? [r.name] : []));
    const bareNames = roles.flatMap((r) => (r.kind === 'identifier' ? [r.name] : []));
    const named = [...bareNames, ...appliedNames];
    let variable: string;
    let function_name: string;
    if (appliedNames.length > 0) {
      // `y(x)` settles the function on its own. Deriving it from the equation
      // instead read `y` as the VARIABLE whenever differentiatedName found no
      // derivative — which is every `diff(y(x),x)` spelling, since that helper
      // knows only `y'` and `dy/dx`. `desolve(diff(y(x),x)=y(x), y(x))` built
      // `desolve(...,y,y)`, Giac answered `[]`, and the new empty-result guard
      // then reported an unsatisfiable IVP for a call with no conditions.
      function_name = appliedNames[0];
      variable = bareNames[0]?.trim() ?? independentVariable(equation, function_name);
    } else if (named.length >= 2) {
      variable = named[0].trim();
      function_name = named[1].trim();
    } else {
      const only = named[0]?.trim();
      const namesTheFunction = only !== undefined && only === differentiated;
      function_name = namesTheFunction ? only : (differentiated ?? 'y');
      variable = namesTheFunction
        ? independentVariable(equation, function_name)
        : (only ?? independentVariable(equation, function_name));
    }

    // A condition's POINT must be a point, and this is the only test that can
    // tell one from the independent variable. `[^),]*` matches `x` as happily as
    // `0`, so `y(x)=5` and `y'(x)=0` were folded as conditions — and Giac reads
    // them as EQUATIONS. `desolve(y'=y, y(x)=5)` answered `5/exp(x)*exp(x)`, whose
    // residual in the caller's own equation is -5, with isError:false; 25 measured
    // calls answered a non-solution that way.
    //
    // isDerivativeEquation cannot catch these and neither could the invariant it
    // replaced: parseOdeSystem also classifies `y'(x)=0` as a condition, so the
    // extractor and the parser agree. They agree and are both wrong about what
    // Giac will do, which is why this test is about the caller's variable rather
    // than about the parser.
    //
    // It runs here, after inference, because that is the first point at which the
    // independent variable is known. A symbolic endpoint is still a point:
    // `y(L)=0` and `y(pi)=0` fold and answer correctly, and must.
    const effectiveRoles = roles.map((role, i) => {
      if (role.kind !== 'condition') return role;
      const point = CONDITION_POINT.exec(rest[i])?.[1]?.trim();
      return point === variable ? ({ kind: 'unsupported' } as const) : role;
    });
    const conditions = rest.filter((_, i) => effectiveRoles[i].kind === 'condition');
    // Only the first two identifiers are read on the single-equation path, so a
    // later one is neither used nor refused unless it is collected here — the
    // same silent drop this change exists to remove, one bucket over. A SYSTEM is
    // different: parseOdeSystem ignores function_name entirely, so
    // `desolve([y'=z, z'=-y], x, y, z)` names its unknowns redundantly and was
    // answered, and verified, on main.
    let identifiersSeen = 0;
    const unsupported: string[] = rest.filter((_, i) => {
      const role = effectiveRoles[i];
      if (role.kind === 'unsupported') return true;
      if (isSystem) return false;
      if (role.kind === 'identifier' || role.kind === 'function') {
        identifiersSeen += 1;
        return identifiersSeen > 2;
      }
      return false;
    });

    // Two shapes, because the equation has two and only one of them survives an
    // ` and ` suffix.
    //
    // A bracketed list is a SYSTEM, and calculus.ts decides that by handing
    // `equation` to parseOdeSystem. `[y'=z, z'=-y] and y(0)=1` does not parse as
    // one, so appending pushed the whole request off the Y' = A*Y + b path: no
    // matrix rewrite, no components note, no verifyOdeSystem — and because
    // `functions` came back undefined it also skipped the guard that refuses
    // `[]`. `desolve([y'=z, z'=-y], y(0)=1, z(0)=0, x)` answered `[]` with
    // isError:false, where main at least returned a verified solution family.
    // Folding into the list is the shape parseOdeSystem already reads, and it
    // answers [[cos(x),-sin(x)]] verified.
    //
    // A single equation joins with `and`, Giac's own IVP spelling and already a
    // working route — `desolve(y'=y and y(0)=1, x, y)` answered exp(x) before
    // this change. Each side is parenthesised because this code, not the caller,
    // is building a boolean expression: `and` and `or` are the same precedence
    // and left-associative in Giac, so an unparenthesised splice lets a
    // condition's own boolean escape its side of the join.
    //
    // Inference above reads the ORIGINAL equation, not either of these, so a
    // condition's text cannot be mistaken for the unknown function or the
    // independent variable.
    //
    // No new length bound, and not because MAX_EXPRESSION_LENGTH is adequate —
    // it is 8192 and ode-system-shape.ts records conditions trapping the engine
    // at 1,415 characters, which is why that channel bounds itself at 280. The
    // reason is parity: this exact text already reaches this exact `desolve`
    // through the equation argument on main, and kills the worker there the same
    // way. What does measure it is compute/schema.ts's MAX_EXPRESSION_LENGTH on
    // the whole `problem` — 8192, far above the ~1,415-character trap — so the
    // channel is bounded, not closed, and calculus.ts now actively tells callers
    // to use it. Applying MAX_CONDITION_CHARS here is the open follow-up.
    // An empty equation is refused by validateParams, and folding onto it built a
    // non-empty string that slipped past that check — `desolve(, y(0)=1)` reached
    // the worker and came back blaming the CAS.
    // A condition that would change the equation's shape was already classified
    // 'unsupported' in the roles pass, positionally, so it is reported in the
    // caller's own order. It used to be rejected in a loop here and appended after
    // every positional entry, which broke that guarantee by construction.
    const withConditions =
      conditions.length === 0 || trimmedEquation.length === 0 ? equation : fold(conditions);

    return {
      handler: 'calculus',
      args: {
        operation: 'solve_ode',
        equation: withConditions,
        variable,
        function_name,
        ...(unsupported.length > 0 ? { unsupported_argument: unsupported[0] } : {}),
      },
    };
  }
  // Implicit ODE: contains y', y'', dy/dx
  return {
    handler: 'calculus',
    args: { operation: 'solve_ode', equation: problem.trim(), variable: 'x', function_name: 'y' },
  };
}

// --- Algebra ---

export function extractFactor(problem: string, domain?: string): RouteResult {
  const inner = extractFnArgs(problem);
  const isComplex = problem.trim().toLowerCase().startsWith('cfactor') || domain === 'complex';
  return {
    handler: 'algebra',
    args: { operation: 'factor', expression: inner, ...(isComplex ? { complex: true } : {}) },
  };
}

export function extractSimplify(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'algebra', args: { operation: 'simplify', expression: inner } };
}

export function extractExpand(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'algebra', args: { operation: 'expand', expression: inner } };
}

export function extractPartfrac(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  return {
    handler: 'algebra',
    args: { operation: 'partial_fractions', expression, variable },
  };
}

// --- Matrix ---

export function extractMatrix(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const matrix = extractMatrixString(problem);

  // Map function name to operation
  const opMap: Record<string, string> = {
    det: 'determinant',
    inv: 'inverse',
    eigenvals: 'eigenvalues',
    eigenvects: 'eigenvectors',
    rref: 'rref',
    rank: 'rank',
    tran: 'transpose',
    ker: 'nullspace',
    qr: 'qr',
    lu: 'lu',
    cholesky: 'cholesky',
    svd: 'svd',
    norm: 'norm_frobenius',
    l1norm: 'norm_1',
    linfnorm: 'norm_inf',
    cond: 'condition_number',
  };

  let operation = 'determinant';
  for (const [fn, op] of Object.entries(opMap)) {
    if (trimmed.startsWith(fn + '(') || trimmed.startsWith(fn + ' (')) {
      operation = op;
      break;
    }
  }

  return { handler: 'matrix', args: { operation, matrix } };
}

// --- Number theory ---

export function extractNumberTheory(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  if (trimmed.startsWith('ifactor')) {
    return {
      handler: 'number_theory',
      args: { operation: 'prime_factorize', number: Number.parseInt(inner, 10) },
    };
  }
  if (trimmed.startsWith('isprime')) {
    return {
      handler: 'number_theory',
      args: { operation: 'analyze', number: Number.parseInt(inner, 10) },
    };
  }
  if (trimmed.startsWith('euler')) {
    return {
      handler: 'number_theory',
      args: { operation: 'analyze', number: Number.parseInt(inner, 10) },
    };
  }
  return {
    handler: 'number_theory',
    args: { operation: 'prime_factorize', number: Number.parseInt(inner, 10) },
  };
}

// --- Combinatorics ---

export function extractCombinatorics(problem: string): RouteResult {
  const trimmed = problem.trim();

  // C(n,k) or comb(n,k)
  const combMatch = /^[Cc](?:omb)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(trimmed);
  if (combMatch) {
    return {
      handler: 'combinatorics',
      args: {
        operation: 'combinations',
        n: Number.parseInt(combMatch[1], 10),
        k: Number.parseInt(combMatch[2], 10),
      },
    };
  }

  // P(n,k) or perm(n,k)
  const permMatch = /^[Pp](?:erm)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(trimmed);
  if (permMatch) {
    return {
      handler: 'combinatorics',
      args: {
        operation: 'permutations',
        n: Number.parseInt(permMatch[1], 10),
        k: Number.parseInt(permMatch[2], 10),
      },
    };
  }

  // Keyword-based: stirling, bell, catalan, derangements, partitions
  const lc = trimmed.toLowerCase();
  const inner = extractFnArgs(problem);
  const numArgs = splitArgs(inner).map((s) => Number.parseInt(s, 10));

  if (lc.includes('stirling')) {
    const kind = lc.includes('first') ? 'stirling_first' : 'stirling_second';
    return { handler: 'combinatorics', args: { operation: kind, n: numArgs[0], k: numArgs[1] } };
  }
  if (lc.includes('bell')) {
    return { handler: 'combinatorics', args: { operation: 'bell_number', n: numArgs[0] } };
  }
  if (lc.includes('catalan')) {
    return { handler: 'combinatorics', args: { operation: 'catalan_number', n: numArgs[0] } };
  }
  if (lc.includes('derangement')) {
    return { handler: 'combinatorics', args: { operation: 'derangements', n: numArgs[0] } };
  }
  if (lc.includes('partition')) {
    return { handler: 'combinatorics', args: { operation: 'partition_count', n: numArgs[0] } };
  }
  // `permutations(10,3)` matched neither the `P(n,k)` regex (which needs `(`
  // right after `P`/`perm`) nor any keyword, so it fell to the combinations
  // default below: it answered 120 under the heading "Combinations C(10, 3)"
  // for a question about P(10,3) = 720.
  if (lc.includes('permutation')) {
    return {
      handler: 'combinatorics',
      args: { operation: 'permutations', n: numArgs[0], k: numArgs[1] },
    };
  }
  if (lc.includes('combination') || lc.includes('choose')) {
    return {
      handler: 'combinatorics',
      args: { operation: 'combinations', n: numArgs[0], k: numArgs[1] },
    };
  }
  if (lc.includes('multinomial')) {
    // `multinomial(5, [2,2,1])` — n first, then the group sizes. Passing the
    // whole flattened arg list as `groups` left n undefined and the group sum
    // NaN, so the handler rejected every call.
    const parts = splitArgs(extractFnArgs(problem));
    const groups = parseNumberList(parts.slice(1).join(',')) ?? [];
    return {
      handler: 'combinatorics',
      args: { operation: 'multinomial', n: numArgs[0], groups: groups.length ? groups : undefined },
    };
  }

  // Default: combinations. `|| 0` used to turn an unparsable argument into a
  // real answer for n = 0, so pass NaN through and let the handler say so.
  return {
    handler: 'combinatorics',
    args: { operation: 'combinations', n: numArgs[0], k: numArgs[1] },
  };
}

// --- Probability ---

/**
 * Caller spellings for the parameter names probability-calc.ts reads.
 *
 * The router claims `beta(a=2, b=3, x=0.5)` as a distribution query, so the
 * handler has to receive it under the names it reads — otherwise the router
 * recognises a spelling the handler answers with "requires params alpha and
 * beta".
 */
const DISTRIBUTION_PARAM_ALIASES: Record<string, string> = {
  a: 'alpha',
  b: 'beta',
  mean: 'mu',
  sd: 'sigma',
  stddev: 'sigma',
  rate: 'lambda',
};

export function extractProbability(problem: string): RouteResult {
  const lc = problem.toLowerCase();
  const inner = extractFnArgs(problem);

  // Try to detect distribution and operation
  const distributions = [
    'binomial',
    'normal',
    'poisson',
    'geometric',
    'hypergeometric',
    'chi_square',
    'student_t',
    'f_distribution',
    'beta',
    'exponential',
  ];
  // Match the leading verb exactly where there is one: substring matching in
  // list order made `hypergeometric(N=50,K=5,n=10,k=2)` run as `geometric`,
  // which reported "Geometric requires param p" for a complete call. Prose
  // falls back to a longest-name-first scan for the same reason.
  const verb = /^\s*([a-z_][a-z0-9_]*)\s*\(/i.exec(problem)?.[1]?.toLowerCase();
  let distribution = 'normal';
  if (verb && distributions.includes(verb)) {
    distribution = verb;
  } else {
    for (const d of [...distributions].sort((a, b) => b.length - a.length)) {
      if (lc.includes(d)) {
        distribution = d;
        break;
      }
    }
  }

  // `pmf` is the name every branch in probability-calc.ts tests. Defaulting to
  // `pdf` meant the router invented a spelling the handler then had to undo.
  const operations = ['pmf', 'pdf', 'cdf', 'expected_value', 'variance', 'quantile'];
  let operation = 'pmf';
  for (const op of operations) {
    if (lc.includes(op)) {
      operation = op;
      break;
    }
  }

  // This was the last `name=value` parser outside arg-parsing.ts, and it had its
  // own coercion policy: unanchored, `parseFloat`, and no `=(?!=)` guard — so
  // `normal(mu=0, sigma=2abc, x=1)` silently read sigma as 2 and answered a
  // density for a distribution the caller never described.
  // Every named value is forwarded, malformed ones included: dropping them here
  // let the handler's own `params.sigma ?? 1` default stand in, so
  // `normal(mu=0, sigma=2abc, x=1)` answered the density for sigma = 1 instead
  // of reporting the argument it could not read.
  const params: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parseCallArgs(inner).named)) {
    params[DISTRIBUTION_PARAM_ALIASES[key.toLowerCase()] ?? key] = value;
  }

  return {
    handler: 'probability',
    args: { distribution, operation, params, x: params['x'] },
  };
}

// --- Hypothesis testing ---

export function extractHypothesisTesting(problem: string): RouteResult {
  const lc = problem.toLowerCase();

  let test = 'one_sample_t';
  if (lc.includes('two_sample') || lc.includes('two sample')) test = 'two_sample_t';
  else if (lc.includes('paired')) test = 'paired_t';
  else if (lc.includes('anova')) test = 'one_way_anova';
  // `chi_square_independence` is the handler's own name for this test, and only
  // the `_test` spelling was recognised — so calling it by its published name
  // ran a one-sample t-test on a contingency table.
  else if (lc.includes('chi_square') || lc.includes('chi square')) test = 'chi_square_independence';

  // hypothesisTestingHandler reads data.sample1/sample2/mu0/groups/
  // contingency_table/significance. This used to fall back to `data: { raw }`,
  // which none of those names match, so every call through compute reported
  // "requires sample1 with at least 2 values" — for a call that supplied it.
  const inner = extractFnArgs(problem);
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to named/positional parsing */
  }

  if (Object.keys(data).length === 0) {
    const { named, positional } = parseCallArgs(inner);
    data = coerceTestData(named, positional, test);
  }

  return { handler: 'hypothesis_testing', args: { test, data } };
}

// --- Geometry ---

export function extractGeometry(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  const opMap: Record<string, string> = {
    distance: 'distance',
    midpoint: 'midpoint',
    slope: 'slope',
    area_triangle: 'area_triangle',
    area_polygon: 'area_polygon',
    area_circle: 'area_circle',
    area: 'area_triangle',
    perimeter: 'perimeter_polygon',
    perimeter_polygon: 'perimeter_polygon',
    circumference: 'circumference',
    intersection: 'line_intersection',
    line_intersection: 'line_intersection',
    point_line_distance: 'point_line_distance',
    angle: 'angle_between_lines',
    angle_between_lines: 'angle_between_lines',
  };

  let operation = 'distance';
  for (const [key, op] of Object.entries(opMap)) {
    if (trimmed.startsWith(key + '(') || trimmed.startsWith(key + ' (')) {
      operation = op;
      break;
    }
  }

  const args: Record<string, unknown> = { operation };

  // Named arguments first: `area_circle(radius=2)` and
  // `area_triangle(base=4, height=3)` are the forms the schema advertises.
  // These used to fall into the JSON catch below and land in a `raw` field
  // that geometryHandler does not read, so it reported "requires radius or
  // diameter" for a call that supplied one.
  const callArgs = parseCallArgs(inner);
  const named = pickNumbers(callArgs.named, ['radius', 'diameter', 'base', 'height']);
  Object.assign(args, named);

  // `area_polygon(vertices=[[0,0],...])` names its list the way the schema's
  // other named forms do; only the scalar names were picked up.
  for (const key of ['vertices', 'points']) {
    const pairs = parsePointPairs(callArgs.named[key]);
    if (pairs) args['points'] = pairs;
  }

  // A named `vertices`/`points` list is already in `args`, and the positional
  // reading below would replace it with an empty list.
  if (Object.keys(named).length === 0 && args['points'] === undefined) {
    // `callArgs.positional` already holds this — splitArgs plus per-element
    // coercion — so parsing `inner` again with a second policy meant one
    // non-JSON element threw and dropped every point, where the shared parser
    // coerces element by element and keeps the rest.
    {
      const parsed = callArgs.positional;
      {
        if (operation === 'area_circle' || operation === 'circumference') {
          args['radius'] = parsed[0];
        } else if (
          operation === 'area_triangle' &&
          parsed.length === 2 &&
          parsed.every((n) => typeof n === 'number')
        ) {
          // Two bare numbers for a triangle are base and height, not points.
          args['base'] = parsed[0];
          args['height'] = parsed[1];
        } else if (operation === 'angle_between_lines' || operation === 'line_intersection') {
          args['line1'] = parsed[0];
          args['line2'] = parsed[1];
        } else if (operation === 'point_line_distance') {
          // The handler reads `points[0]` and `line1`; nothing set `line1`, so
          // every call reported "requires points[0] and line1". The line comes
          // either as one [a,b,c] argument or as three bare coefficients —
          // reading the first spelling only left the second destructuring a
          // number, which surfaced as the raw "line1 is not iterable".
          args['points'] = [parsed[0]];
          args['line1'] = Array.isArray(parsed[1])
            ? parsed[1]
            : parsed.slice(1, 4).every((n) => typeof n === 'number')
              ? parsed.slice(1, 4)
              : undefined;
        } else {
          args['points'] = parsePointList(inner) ?? parsed;
        }
      }
    }
  }

  return { handler: 'geometry', args };
}

// --- Numerical methods ---

/** Which fields a numerical method reads its positional numbers into. */
type NumericArgShape = 'bracket' | 'bounds' | 'guess';

const NUMERIC_ARG_FIELDS: Record<NumericArgShape, string[]> = {
  bracket: ['x0', 'x1'],
  bounds: ['lower_bound', 'upper_bound'],
  guess: ['initial_guess'],
};

export function extractNumericalMethods(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // One table, carrying each verb's method AND the shape of its numeric
  // arguments. A second list of "which of these are integrations" had to be kept
  // in sync by hand, and forgetting it reproduces the bug the shapes exist to
  // fix: an integration request emitting `initial_guess`.
  //
  // `numerical_integration` was absent entirely, so it took the newton_raphson
  // default and answered `f(root) = 0.000000e+0` — root-finding on an integral.
  const methodMap: Record<string, { method: string; shape: NumericArgShape }> = {
    newton: { method: 'newton_raphson', shape: 'guess' },
    newton_raphson: { method: 'newton_raphson', shape: 'guess' },
    bisection: { method: 'bisection', shape: 'bracket' },
    secant: { method: 'secant', shape: 'bracket' },
    romberg: { method: 'romberg_integration', shape: 'bounds' },
    romberg_integration: { method: 'romberg_integration', shape: 'bounds' },
    simpson: { method: 'numerical_integration', shape: 'bounds' },
    numerical_integration: { method: 'numerical_integration', shape: 'bounds' },
  };

  let method = 'newton_raphson';
  let shape: NumericArgShape = 'guess';
  for (const [key, entry] of Object.entries(methodMap)) {
    if (trimmed.startsWith(key + '(') || trimmed.startsWith(key + ' (')) {
      method = entry.method;
      shape = entry.shape;
      break;
    }
  }

  // The variable is optional: `newton(x^2-2, x, 1)` names it, `bisection(x^2-2,
  // 1, 2)` does not. Taking parts[1] as the variable unconditionally made the
  // bracket `1` the variable name.
  const expression = parts[0] || '';
  const hasVariable = /^[A-Za-z]\w*$/.test((parts[1] ?? '').trim());
  const variable = hasVariable ? parts[1].trim() : guessVariable(expression);
  // `parseFloat` is lenient in exactly the way this file condemns elsewhere:
  // `parseFloat('2abc')` is 2, so `bisection(x^2-2, 1, 2abc)` emitted x1 = 2 and
  // answered confidently for a bracket nobody wrote. coerceValue rejects it.
  const positional = parseCallArgs(inner).positional;
  const numbers = positional
    .slice(hasVariable ? 2 : 1)
    .map((value) => (typeof value === 'number' ? value : Number.NaN));

  // Only `initial_guess` was ever emitted, so bisection and secant reported
  // "requires x0 and x1" and both integrations reported "requires lower_bound
  // and upper_bound".
  const positionalArgs: Record<string, number> = {};
  NUMERIC_ARG_FIELDS[shape].forEach((field, i) => {
    if (Number.isFinite(numbers[i])) positionalArgs[field] = numbers[i];
  });

  return {
    handler: 'numerical_methods',
    args: { method, expression, variable, ...positionalArgs },
  };
}

// --- Exact value ---

export function extractExactValue(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  let operation = 'to_exact';
  if (trimmed.startsWith('to_decimal')) operation = 'to_decimal';
  else if (trimmed.startsWith('simplify_fraction')) operation = 'simplify_fraction';

  // `value` is the field exactValueHandler reads; emitting `expression` meant
  // to_exact/to_decimal/simplify_fraction crashed on `undefined`.
  return { handler: 'exact_value', args: { operation, value: inner } };
}

// --- Linear regression ---

export function extractLinearRegression(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // linearRegressionHandler reads x, y, model and degree. This used to emit a
  // bare array for the JSON form and `{ raw: parts }` otherwise, so `x.length`
  // dereferenced undefined for every input.
  const args: Record<string, unknown> = {};

  // An explicit object argument wins — it can already name x/y/model/degree.
  try {
    const parsed: unknown = JSON.parse(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { handler: 'linear_regression', args: parsed as Record<string, unknown> };
    }
  } catch {
    /* not an object literal */
  }

  const { named, positional } = parseCallArgs(inner);

  // Named form: `linear_regression(x=[1,2,3], y=[2,4,6])`.
  if (isNumberList(named['x']) && isNumberList(named['y'])) {
    args['x'] = named['x'];
    args['y'] = named['y'];
  }

  // Point pairs: `linear_regression([[1,2],[2,4]])`.
  const points = args['x'] === undefined ? parsePointPairs(expressionArg(parts[0])) : null;
  if (points) {
    args['x'] = points.map((point) => point[0]);
    args['y'] = points.map((point) => point[1]);
  }

  // Two separate lists: `linear_regression([1,2,3], [2,4,6])`.
  if (args['x'] === undefined) {
    const [xs, ys] = positional;
    if (isNumberList(xs) && isNumberList(ys)) {
      args['x'] = xs;
      args['y'] = ys;
    }
  }

  if (trimmed.startsWith('polynomial_regression') || trimmed.includes('polynomial')) {
    args['model'] = 'polynomial';
    // `named['degree']` is already parsed above and was never read: the code
    // took `parts[last]` verbatim, so `Number('degree=2')` was NaN and the key
    // stayed unset. linearRegressionHandler then defaulted to 1, and
    // `polynomial_regression(x=[1,2,3,4], y=[1,4,9,16], degree=2)` answered a
    // straight line (ŷ = 5x - 5, R² = 0.969) for data whose fit is ŷ = x².
    const named = parseCallArgs(inner).named;
    const degree =
      typeof named['degree'] === 'number' ? named['degree'] : Number(parts[parts.length - 1]);
    if (Number.isInteger(degree) && degree > 0) args['degree'] = degree;
  }

  return { handler: 'linear_regression', args };
}

// --- Sequence identify ---

export function extractSequenceIdentify(problem: string): RouteResult {
  // Same parser as fourier: `JSON.parse('[' + '[1,2,3]' + ']')` yields
  // [[1,2,3]], so the bracketed form used to arrive as one element and the
  // arity guard then blamed the user for supplying one term.
  const terms = parseNumberList(extractFnArgs(problem)) ?? [];
  return { handler: 'sequence_identify', args: { terms } };
}

// --- Number properties ---

export function extractNumberProperties(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'number_properties', args: { number: Number.parseInt(inner, 10) } };
}

// --- Quick calc ---

export function extractQuickCalc(problem: string): RouteResult {
  return { handler: 'quick_calc', args: { expression: problem.trim() } };
}

// --- Fourier ---

export function extractFourier(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  // `mode` and `data` are the names fourierTransformHandler reads, and it
  // compares mode against 'fft'/'ifft'. This used to emit `signal` and
  // 'forward'/'inverse', so every field missed and the handler crashed on
  // `data.length` for every input — `fft([1,2,3,4])` included.
  const mode: 'fft' | 'ifft' =
    trimmed.startsWith('ifft') || trimmed.startsWith('inverse') ? 'ifft' : 'fft';

  // No `data` is what makes the handler explain itself; there is no consumer
  // for the raw argument, so passing it along would be another phantom field.
  const data = parseNumberList(inner);
  return { handler: 'fourier', args: data ? { mode, data } : { mode } };
}

// --- Giac raw (fallback) ---

export function extractGiacRaw(problem: string): RouteResult {
  // C(n,k)/P(n,k) notation reaches this fallback when it appears inside a
  // compound expression — rewrite it to Giac-native comb()/perm().
  return { handler: 'giac_raw', args: { expression: rewriteCombinatorics(problem.trim()) } };
}

// --- Multivariable ---

export function extractMultivariable(problem: string): RouteResult {
  const trimmed = problem.trim();
  const lc = trimmed.toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  parts[0] = expressionArg(parts[0]);

  // Multiple integrals.
  if (lc.startsWith('iint') || lc.startsWith('iiint') || lc.startsWith('multiple_integral')) {
    const expression = parts[0] || '';
    const bounds: { variable: string; lower: string; upper: string }[] = [];
    for (let i = 1; i + 2 < parts.length; i += 3) {
      bounds.push({ variable: parts[i], lower: parts[i + 1], upper: parts[i + 2] });
    }
    return {
      handler: 'multivariable',
      args: { operation: 'multiple_integral', expression, bounds },
    };
  }
  if (/int\s*\(\s*int\s*\(/i.test(trimmed)) {
    return { handler: 'multivariable', args: { operation: 'multiple_integral', raw: trimmed } };
  }

  // Vector / differential operators.
  if (lc.startsWith('gradient') || lc.startsWith('grad')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'gradient',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('hessian')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'hessian',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('jacobian')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'jacobian',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('divergence') || lc.startsWith('div')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'divergence',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('curl')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'curl',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('partial')) {
    return {
      handler: 'multivariable',
      args: { operation: 'partial', expression: parts[0] || '', variables: parts.slice(1) },
    };
  }

  // Optimization.
  if (lc.startsWith('critical_points')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'critical_points',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('lagrange')) {
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

  return { handler: 'giac_raw', args: { expression: trimmed } };
}

// --- 3D geometry ---

const GEOMETRY3D_OPS = [
  'distance3d',
  'midpoint3d',
  'dot',
  'cross',
  'vector_norm',
  'angle_vectors',
  'plane_from_points',
  'point_plane_distance',
  'line_plane_intersection',
  'plane_plane_angle',
  'line_line_distance',
  'volume_tetrahedron',
  'volume_sphere',
  'volume_parallelepiped',
];

export function extractGeometry3d(problem: string): RouteResult {
  const lc = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // Router already guarantees the input starts with exactly `<name>(`, and no op name
  // is a prefix of another, so a bare startsWith is unambiguous here.
  const operation = GEOMETRY3D_OPS.find((name) => lc.startsWith(name)) ?? '';

  const lists: number[][] = [];
  let scalar: number | undefined;
  for (const part of parts) {
    if (part.trim().startsWith('[')) {
      const nums = parseNumberList(part);
      if (nums) lists.push(nums);
    } else if (scalar === undefined && part.trim() !== '') scalar = Number(part);
  }

  return {
    handler: 'geometry3d',
    args: { operation, lists, ...(scalar !== undefined ? { scalar } : {}) },
  };
}
