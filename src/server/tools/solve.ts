import { giacEngine } from '../giac/index.js';
import { formatErrorResponse } from './response-formatter.js';
import { validateEquation } from './expression-validator.js';
import { unicodeToAscii } from './unicode-normalize.js';
import { evalWithLatex } from './giac-eval.js';
import { isEngineFailure, listToSet, splitTopLevel } from './output-cleanup.js';
import { verifySolveSet, verifySystemSolutions, type VerificationResult } from './self-verify.js';

/** Parse a raw Giac solve result (list[...] / [] / [..]) into top-level member strings. */
export function parseSolutions(raw: string): string[] {
  let inner = raw.trim();
  if (inner.startsWith('list[')) inner = inner.slice(4).trim();
  if (inner.startsWith('[') && inner.endsWith(']')) inner = inner.slice(1, -1).trim();
  if (inner === '') return [];
  return splitTopLevel(inner, ',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse a clean tuple "(a, b)" into ['a','b']; returns [] if not a single tuple. */
export function parseTuple(s: string): string[] {
  const t = s.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    return splitTopLevel(t.slice(1, -1), ',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0);
  }
  return [];
}

/** Parse all solution tuples from a normalized system result.
 *  "(a, b)" -> [['a','b']]; "{(a,b), (c,d)}" -> [['a','b'],['c','d']]; else []. */
export function parseTuples(result: string): string[][] {
  const t = result.trim();
  if (t.startsWith('(') && t.endsWith(')')) {
    const tup = parseTuple(t);
    return tup.length > 0 ? [tup] : [];
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const body = t.slice(1, -1).trim();
    if (body === '') return [];
    return splitTopLevel(body, ',')
      .map((x) => parseTuple(x.trim()))
      .filter((x) => x.length > 0);
  }
  return [];
}

/** Re-exported where it was first defined; it lives beside printedList now. */
export { isEngineFailure };

/**
 * Refuses an equation Giac cannot parse, by asking how it reads it without
 * evaluating it.
 *
 * {@link validateEquation} catches the shapes a pattern can name. What it cannot
 * see is a syntax error Giac swallows: `x^2=4 4`, `x^2=4;` and `sin(x)=x y z`
 * all quote as `undef`, and `solve` answers each with `[]` — "no solutions",
 * exit status 0. The undefined marker in the quoted form is the only trace.
 */
async function engineParseError(equation: string): Promise<string | null> {
  const parsed = await giacEngine.evaluate(`quote(${equation})`);
  if (!isEngineFailure(parsed)) return null;
  return 'Malformed equation: Giac cannot parse part of it — check for a missing operator or a stray character';
}

/** Both pre-flight checks, the pattern one first: it names the problem more precisely. */
async function malformedEquation(equation: string): Promise<string | null> {
  return validateEquation(equation)?.message ?? (await engineParseError(equation));
}

interface Candidate {
  fn: string;
  note?: string;
}

interface Attempt {
  giacExpr: string;
  /** Undefined when the substitution check could not decide either way. */
  verification: VerificationResult | undefined;
  note?: string;
}

export async function solveEquationHandler(args: Record<string, unknown>) {
  try {
    // Normalised once, here, because everything below sends the equation to
    // Giac itself — the escalation candidates, the parse probe and the
    // substitution check. Only evalWithLatex normalised, so `x²=4` was
    // displayed as {-2, 2} while every candidate had solved for an identifier
    // `x²` and the answer came back "Verified: ✗ (no solutions to verify)".
    const equation = unicodeToAscii((args.equation as string | undefined) ?? '');
    const variable = unicodeToAscii((args.variable as string | undefined) ?? '');
    const domain = args.domain as string | undefined;

    if (!equation) return formatErrorResponse("'equation' is required");
    if (!variable) return formatErrorResponse("'variable' is required");

    const malformed = await malformedEquation(equation);
    if (malformed) return formatErrorResponse(malformed);

    // Escalation ladder. In practice Giac's solve already returns numeric roots
    // for many transcendental equations, so the fsolve fallback rarely fires.
    const candidates: Candidate[] =
      domain === 'complex'
        ? [{ fn: 'csolve' }, { fn: 'fsolve', note: 'fsolve (numeric fallback)' }]
        : [
            { fn: 'solve' },
            { fn: 'csolve', note: 'csolve (escalated — no real solution verified)' },
            { fn: 'fsolve', note: 'fsolve (numeric fallback)' },
          ];

    let primary: Attempt | null = null;
    let chosen: Attempt | null = null;

    for (const cand of candidates) {
      const giacExpr = `${cand.fn}(${equation},${variable})`;
      let raw: string;
      try {
        raw = await giacEngine.evaluate(giacExpr);
      } catch {
        continue;
      }
      if (!raw || isEngineFailure(raw)) continue;
      const verification = await verifySolveSet(equation, variable, parseSolutions(raw));
      primary ??= { giacExpr, verification, note: undefined };
      if (verification?.verified) {
        chosen = { giacExpr, verification, note: cand.note };
        break;
      }
    }

    const final = chosen ?? primary;
    if (!final) return formatErrorResponse('Could not solve equation');

    return evalWithLatex({
      giacExpr: final.giacExpr,
      operation: 'solve',
      resultTransform: listToSet,
      verify: () => Promise.resolve(final.verification),
      methodNote: final.note,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

export async function solveSystemHandler(args: Record<string, unknown>) {
  try {
    const rawEquations = args.equations as string[];
    const rawVariables = args.variables as string[];

    if (!rawEquations || !Array.isArray(rawEquations) || rawEquations.length === 0) {
      return formatErrorResponse("'equations' must be a non-empty array");
    }
    if (!rawVariables || !Array.isArray(rawVariables) || rawVariables.length === 0) {
      return formatErrorResponse("'variables' must be a non-empty array");
    }
    // As in solveEquationHandler: the substitution check below reads these
    // directly, so they must be what the engine is asked to solve.
    const equations = rawEquations.map(unicodeToAscii);
    const variables = rawVariables.map(unicodeToAscii);

    for (const eq of equations) {
      const malformed = await malformedEquation(eq);
      if (malformed) return formatErrorResponse(malformed);
    }

    const giacExpr = `solve([${equations.join(',')}],[${variables.join(',')}])`;
    const verify = async (result: string): Promise<VerificationResult | undefined> => {
      const tuples = parseTuples(result);
      if (tuples.length === 0) return undefined; // unparseable / no solution → skip
      return verifySystemSolutions(equations, variables, tuples);
    };
    return evalWithLatex({
      giacExpr,
      operation: 'solve_system',
      resultTransform: listToSet,
      verify,
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
