import { giacEngine } from '../giac/index.js';
import { formatErrorResponse } from './response-formatter.js';
import { validateExpression } from './symbolic/validator.js';
import { evalWithLatex } from './giac-eval.js';
import { listToSet, splitTopLevel } from './output-cleanup.js';
import { verifySolveSet, verifySystem, type VerificationResult } from './self-verify.js';

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

interface Candidate {
  fn: string;
  note?: string;
}

interface Attempt {
  giacExpr: string;
  verification: VerificationResult;
  note?: string;
}

export async function solveEquationHandler(args: Record<string, unknown>) {
  try {
    const equation = args.equation as string;
    const variable = args.variable as string;
    const domain = args.domain as string | undefined;

    if (!equation) return formatErrorResponse("'equation' is required");
    if (!variable) return formatErrorResponse("'variable' is required");

    const validationError = validateExpression(equation);
    if (validationError) return formatErrorResponse(validationError.message);

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
      if (!raw || raw === 'undef') continue;
      const verification = await verifySolveSet(equation, variable, parseSolutions(raw));
      if (primary === null) primary = { giacExpr, verification, note: undefined };
      if (verification.verified) {
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
    const equations = args.equations as string[];
    const variables = args.variables as string[];

    if (!equations || !Array.isArray(equations) || equations.length === 0) {
      return formatErrorResponse("'equations' must be a non-empty array");
    }
    if (!variables || !Array.isArray(variables) || variables.length === 0) {
      return formatErrorResponse("'variables' must be a non-empty array");
    }

    for (const eq of equations) {
      const validationError = validateExpression(eq);
      if (validationError) return formatErrorResponse(validationError.message);
    }

    const giacExpr = `solve([${equations.join(',')}],[${variables.join(',')}])`;
    const verify = async (result: string): Promise<VerificationResult | undefined> => {
      const tuples = parseTuples(result);
      if (tuples.length === 0) return undefined; // unparseable / no solution → skip
      for (const tup of tuples) {
        const v = await verifySystem(equations, variables, tup);
        if (!v.verified) {
          return {
            verified: false,
            method: 'substitution',
            detail: `${tuples.length} solution(s); at least one did not satisfy all equations`,
          };
        }
      }
      return {
        verified: true,
        method: 'substitution',
        detail: `${tuples.length} solution(s) satisfy all equations`,
      };
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
