import { z } from 'zod';
import { MAX_EXPRESSION_LENGTH } from '../limits.js';
import { giacEngine } from '../../giac/index.js';
import { unicodeToAscii } from '../unicode-normalize.js';
import { rewriteCombinatorics } from '../combinatorics-rewrite.js';
import { stripOrderTerm } from '../output-cleanup.js';

export const verifySchema = z.object({
  claim: z
    .string()
    .min(1)
    .max(MAX_EXPRESSION_LENGTH, `claim must be at most ${MAX_EXPRESSION_LENGTH} characters`)
    .describe(
      'Mathematical claim to verify. Examples:\n' +
        '  "sin(x)^2 + cos(x)^2 = 1"     — identity check\n' +
        '  "x=2 satisfies x^2-4=0"        — solution check\n' +
        '  "diff(x^3, x) = 3*x^2"         — computation check'
    ),
  method: z
    .enum(['numeric', 'symbolic', 'both'])
    .optional()
    .describe('Verification method (default: "both")'),
  format: z
    .enum(['text', 'json'])
    .optional()
    .describe(
      'Output format:\n' +
        '  text (default) — human-readable verdict\n' +
        '  json — structured VerifyResult'
    ),
});

export interface VerifyResult {
  verified: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  checks_performed: string[];
  /**
   * Whether the claim was actually checked.
   *
   * `false` means no check produced a usable answer — the claim did not parse,
   * or every strategy failed on it. That is NOT the same as "checked and found
   * false", and collapsing the two is a wrong answer: `verify '((('` and
   * `verify 'x + = 1'` both used to report `verified: false`, which the CLI
   * turned into exit 2 ("ran and disproved"). A script reading that exit code
   * treats a syntax error as a refuted theorem.
   *
   * `verified: true` implies `evaluated: true` — a check that returned true
   * necessarily ran.
   */
  evaluated: boolean;
}

// ---------------------------------------------------------------------------
// Verification strategies
// ---------------------------------------------------------------------------

/**
 * True when `expr` consists ONLY of top-level additive terms that carry an
 * order_size factor — i.e. it is a series remainder, zero for verification
 * purposes. (stripOrderTerm cannot be used here: it returns the ORIGINAL
 * string when stripping would leave nothing.)
 */
function isOrderResidueOnly(expr: string): boolean {
  if (!expr.includes('order_size')) return false;
  const terms: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of expr) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (depth === 0 && (ch === '+' || ch === '-') && cur.trim() !== '') {
      terms.push(cur);
      cur = ch === '-' ? '-' : '';
    } else {
      cur += ch;
    }
  }
  if (cur.trim() !== '' && cur.trim() !== '-') terms.push(cur);
  return terms.length > 0 && terms.every((t) => t.includes('order_size'));
}

/**
 * Pre-normalize one side of an identity claim: when it evaluates to a series
 * result carrying an order_size remainder, substitute the bare polynomial.
 * Any evaluation problem leaves the side untouched.
 */
async function normalizeSide(side: string): Promise<string> {
  try {
    const r = await giacEngine.evaluate(side);
    if (r && r !== 'undef' && r.includes('order_size')) {
      const stripped = stripOrderTerm(r);
      if (stripped && stripped !== r) return `(${stripped})`;
    }
  } catch {
    // keep original side
  }
  return side;
}

/**
 * Symbolic verification: simplify(LHS - RHS) and check if result is 0.
 */
async function verifySymbolic(
  lhs: string,
  rhs: string
): Promise<{
  verified: boolean;
  evaluated: boolean;
  detail: string;
}> {
  try {
    const expr = `simplify((${lhs}) - (${rhs}))`;
    const result = await giacEngine.evaluate(expr);

    if (!result || result === 'undef') {
      return { verified: false, evaluated: false, detail: 'Simplification returned undefined' };
    }

    const trimmed = result.trim();
    const isZero = trimmed === '0' || trimmed === '0.0' || isOrderResidueOnly(trimmed);

    return {
      verified: isZero,
      evaluated: true,
      detail: isZero
        ? `simplify(LHS - RHS) = 0 ✓`
        : `simplify(LHS - RHS) = ${trimmed} (expected 0)`,
    };
  } catch (error) {
    // A Giac error here is a malformed claim, not a false one.
    return {
      verified: false,
      evaluated: false,
      detail: `Symbolic check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Numeric verification: substitute random values for all variables
 * and check if LHS ≈ RHS.
 */
async function verifyNumeric(
  lhs: string,
  rhs: string
): Promise<{
  verified: boolean;
  evaluated: boolean;
  detail: string;
}> {
  try {
    // Extract variables
    const varsResult = await giacEngine.evaluate(`lname(${lhs})`);
    const vars = parseVariableList(varsResult);

    if (vars.length === 0) {
      // No variables — direct numeric evaluation
      const lhsVal = await giacEngine.evaluate(`evalf(${lhs})`);
      const rhsVal = await giacEngine.evaluate(`evalf(${rhs})`);
      const diff = Math.abs(Number.parseFloat(lhsVal) - Number.parseFloat(rhsVal));
      // A non-numeric side leaves diff NaN: nothing was compared, so this is
      // "could not check", not "checked and unequal".
      if (Number.isNaN(diff)) {
        return {
          verified: false,
          evaluated: false,
          detail: `Direct evaluation produced no number: ${lhsVal} / ${rhsVal}`,
        };
      }
      const verified = diff < 1e-8;
      return {
        verified,
        evaluated: true,
        detail: verified
          ? `Direct evaluation: ${lhsVal} ≈ ${rhsVal} ✓`
          : `Direct evaluation: ${lhsVal} ≠ ${rhsVal} (diff = ${diff})`,
      };
    }

    // Test with multiple random values
    const testPoints = [0.5, 1.0, 1.5, 2.0, -1.0];
    let passCount = 0;
    let totalTested = 0;
    const failures: string[] = [];

    for (const val of testPoints) {
      try {
        let substExpr = `(${lhs}) - (${rhs})`;
        for (const v of vars) {
          substExpr = `subst(${substExpr}, ${v}=${val})`;
        }
        const result = await giacEngine.evaluate(`evalf(${substExpr})`);
        const numResult = Number.parseFloat(result);

        if (!Number.isFinite(numResult)) {
          continue; // Skip undefined points
        }

        totalTested++;
        if (Math.abs(numResult) < 1e-6) {
          passCount++;
        } else {
          failures.push(`At ${vars.map((v) => `${v}=${val}`).join(', ')}: diff = ${numResult}`);
        }
      } catch {
        // Skip points that cause evaluation errors
      }
    }

    if (totalTested === 0) {
      return { verified: false, evaluated: false, detail: 'Could not evaluate at any test point' };
    }

    const verified = passCount === totalTested;
    return {
      verified,
      evaluated: true,
      detail: verified
        ? `Passed ${passCount}/${totalTested} numeric checks ✓`
        : `Failed: ${failures.join('; ')}`,
    };
  } catch (error) {
    return {
      verified: false,
      evaluated: false,
      detail: `Numeric check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Solution verification: check if a value satisfies an equation.
 * e.g., "x=2 satisfies x^2-4=0"
 */
async function verifySolution(
  variable: string,
  value: string,
  equation: string
): Promise<{ verified: boolean; evaluated: boolean; detail: string }> {
  try {
    // Parse equation into expression = 0 form
    let expr: string;
    if (equation.includes('=')) {
      const [lhs, rhs] = equation.split('=').map((s) => s.trim());
      expr = `(${lhs}) - (${rhs})`;
    } else {
      expr = equation;
    }

    const substituted = `evalf(subst(${expr}, ${variable}=${value}))`;
    const result = await giacEngine.evaluate(substituted);
    const numResult = Number.parseFloat(result);

    // No number back means the substitution did not produce something
    // comparable to zero — nothing was checked.
    if (Number.isNaN(numResult)) {
      return {
        verified: false,
        evaluated: false,
        detail: `Substituting ${variable}=${value} produced no number: ${result}`,
      };
    }

    const verified = Math.abs(numResult) < 1e-8;
    return {
      verified,
      evaluated: true,
      detail: verified
        ? `Substituting ${variable}=${value}: equation evaluates to ${result} ≈ 0 ✓`
        : `Substituting ${variable}=${value}: equation evaluates to ${result} ≠ 0`,
    };
  } catch (error) {
    return {
      verified: false,
      evaluated: false,
      detail: `Solution check failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Claim parsing
// ---------------------------------------------------------------------------

function parseVariableList(giacOutput: string): string[] {
  if (!giacOutput || giacOutput === 'undef' || giacOutput.trim() === '[]') {
    return [];
  }
  // Parse [x, y, z] or list(x, y, z)
  const inner = /^\[(.+)\]$/.exec(giacOutput)?.[1] || /^list\((.+)\)$/.exec(giacOutput)?.[1] || '';
  return (
    inner
      .split(',')
      .map((s) => s.trim())
      // `undef` is Giac's undefined marker, not an identifier. It comes back
      // inside a list when Giac swallows a syntax error — `lname(x +)` returns
      // `[undef]` — and treating it as a free variable makes the numeric check
      // substitute values into nonsense and report real-looking differences,
      // turning a malformed claim into a refuted one.
      .filter((s) => s.length > 0 && s !== 'undef' && /^[a-zA-Z_]\w*$/.test(s))
  );
}

interface ParsedClaim {
  type: 'identity' | 'solution' | 'unknown';
  lhs?: string;
  rhs?: string;
  variable?: string;
  value?: string;
  equation?: string;
}

function parseClaim(claim: string): ParsedClaim {
  // Solution check: "x=2 satisfies x^2-4=0" or "x=2 is a solution of x^2-4=0"
  // Checked BEFORE the point-evaluation pattern so claims containing "at" with
  // solution phrasing are not hijacked by the lazy at-pattern.
  const solutionMatch =
    /(\w+)\s*=\s*([^,\s]+)\s+(?:satisfies|is\s+(?:a\s+)?solution\s+(?:of|to))\s+(.+)/i.exec(claim);
  if (solutionMatch) {
    return {
      type: 'solution',
      variable: solutionMatch[1],
      value: solutionMatch[2],
      equation: solutionMatch[3].trim(),
    };
  }

  // Point-evaluation claim: "EXPR at x=a = b" → identity subst(EXPR, x=a) = b
  const atMatch = /^(.+?)\s+at\s+([a-z]\w*)\s*=\s*([^=\s,]+)\s*=\s*(.+)$/i.exec(claim);
  if (atMatch) {
    return {
      type: 'identity',
      lhs: `subst(${atMatch[1].trim()}, ${atMatch[2]}=${atMatch[3]})`,
      rhs: atMatch[4].trim(),
    };
  }

  // Identity check: "LHS = RHS"
  // Find the main "=" that splits LHS and RHS (not inside parens/brackets)
  const eqIdx = findMainEquals(claim);
  if (eqIdx !== -1) {
    return {
      type: 'identity',
      lhs: claim.slice(0, eqIdx).trim(),
      rhs: claim.slice(eqIdx + 1).trim(),
    };
  }

  return { type: 'unknown' };
}

function findMainEquals(expr: string): number {
  let depth = 0;
  let bracketDepth = 0;
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[') {
      if (ch === '(') depth++;
      else bracketDepth++;
    } else if (ch === ')' || ch === ']') {
      if (ch === ')') depth--;
      else bracketDepth--;
    } else if (ch === '=' && depth === 0 && bracketDepth === 0) {
      // Skip == (comparison operator)
      if (expr[i + 1] === '=') {
        i++;
        continue;
      }
      // Skip != or <=, >=
      if (i > 0 && (expr[i - 1] === '!' || expr[i - 1] === '<' || expr[i - 1] === '>')) {
        continue;
      }
      return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Public handler
// ---------------------------------------------------------------------------

export async function verifyHandler(
  args: Record<string, unknown>
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const claim = rewriteCombinatorics(
    unicodeToAscii(typeof args.claim === 'string' ? args.claim : '')
  );
  const method = (args.method as string) || 'both';
  const format = args.format === 'json' ? 'json' : 'text';

  try {
    const parsed = parseClaim(claim);
    let result: VerifyResult;

    switch (parsed.type) {
      case 'solution':
        result = await handleSolutionVerification(parsed, method);
        break;
      case 'identity':
        result = await handleIdentityVerification(parsed, method);
        break;
      default:
        result = {
          verified: false,
          evaluated: false,
          confidence: 'low',
          explanation:
            'Could not parse the claim. Use format: "LHS = RHS" for identities, or "x=2 satisfies equation" for solutions.',
          checks_performed: ['parse_attempt'],
        };
    }

    return formatVerifyResponse(result, format);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}

async function handleIdentityVerification(
  parsed: ParsedClaim,
  method: string
): Promise<VerifyResult> {
  const lhs = await normalizeSide(parsed.lhs ?? '');
  const rhs = await normalizeSide(parsed.rhs ?? '');
  const checks: string[] = [];
  let symbolicOk: boolean | null = null;
  let numericOk: boolean | null = null;
  let anyEvaluated = false;

  if (method === 'symbolic' || method === 'both') {
    const symbolic = await verifySymbolic(lhs, rhs);
    symbolicOk = symbolic.verified;
    anyEvaluated ||= symbolic.evaluated;
    checks.push(`Symbolic: ${symbolic.detail}`);
  }

  if (method === 'numeric' || method === 'both') {
    const numeric = await verifyNumeric(lhs, rhs);
    numericOk = numeric.verified;
    anyEvaluated ||= numeric.evaluated;
    checks.push(`Numeric: ${numeric.detail}`);
  }

  const verified =
    symbolicOk === true || numericOk === true ? symbolicOk !== false && numericOk !== false : false;

  let confidence: 'high' | 'medium' | 'low';
  if (symbolicOk === true) confidence = 'high';
  else if (numericOk === true && symbolicOk === null) confidence = 'medium';
  else if (numericOk === true && symbolicOk === false) confidence = 'low';
  else confidence = verified ? 'medium' : 'low';

  // One strategy succeeding is enough to call the claim checked: with
  // `method: 'both'`, symbolic can legitimately fail on a claim numeric
  // settles. Only when neither produced anything is the verdict meaningless.
  return {
    verified,
    evaluated: anyEvaluated,
    confidence,
    explanation: anyEvaluated
      ? verified
        ? `Identity verified: ${lhs} = ${rhs}`
        : `Identity NOT verified: ${lhs} ≠ ${rhs}`
      : `Could not evaluate the claim: ${lhs} = ${rhs}`,
    checks_performed: checks,
  };
}

async function handleSolutionVerification(
  parsed: ParsedClaim,
  method: string
): Promise<VerifyResult> {
  const { variable, value, equation } = parsed;
  if (!variable || !value || !equation) {
    return {
      verified: false,
      evaluated: false,
      confidence: 'low',
      explanation: 'Missing variable, value, or equation in solution claim.',
      checks_performed: [],
    };
  }
  const checks: string[] = [];

  const solution = await verifySolution(variable, value, equation);
  checks.push(`Substitution: ${solution.detail}`);

  if ((method === 'symbolic' || method === 'both') && equation.includes('=')) {
    const [eqLhs, eqRhs] = equation.split('=').map((s) => s.trim());
    const substLhs = `subst(${eqLhs}, ${variable}=${value})`;
    const substRhs = `subst(${eqRhs}, ${variable}=${value})`;
    const symbolic = await verifySymbolic(substLhs, substRhs);
    checks.push(`Symbolic after substitution: ${symbolic.detail}`);
  }

  return {
    verified: solution.verified,
    evaluated: solution.evaluated,
    confidence: solution.verified ? 'high' : 'medium',
    explanation: solution.evaluated
      ? solution.verified
        ? `Verified: ${variable}=${value} satisfies ${equation}`
        : `NOT verified: ${variable}=${value} does not satisfy ${equation}`
      : `Could not evaluate ${equation} at ${variable}=${value}`,
    checks_performed: checks,
  };
}

export function formatVerifyResponse(
  result: VerifyResult,
  format: 'text' | 'json'
): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (format === 'json') {
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      isError: false,
    };
  }

  // UNKNOWN, not FALSE, when nothing could be checked: reporting a malformed
  // claim as FALSE tells a reader the mathematics was refuted.
  const verdict = !result.evaluated
    ? 'UNKNOWN — could not be checked'
    : result.verified
      ? 'TRUE ✓'
      : 'FALSE ✗';

  const lines: string[] = [
    `Verified: ${verdict}`,
    `Confidence: ${result.confidence}`,
    `Explanation: ${result.explanation}`,
    '',
    'Checks performed:',
    ...result.checks_performed.map((c) => `  - ${c}`),
  ];
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}
