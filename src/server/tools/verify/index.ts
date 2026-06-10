import { z } from 'zod';
import { giacEngine } from '../../giac/index.js';
import { unicodeToAscii } from '../unicode-normalize.js';
import { stripOrderTerm } from '../output-cleanup.js';

export const verifySchema = z.object({
  claim: z
    .string()
    .min(1)
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
});

interface VerifyResult {
  verified: boolean;
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  checks_performed: string[];
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
  detail: string;
}> {
  try {
    const expr = `simplify((${lhs}) - (${rhs}))`;
    const result = await giacEngine.evaluate(expr);

    if (!result || result === 'undef') {
      return { verified: false, detail: 'Simplification returned undefined' };
    }

    const trimmed = result.trim();
    const isZero = trimmed === '0' || trimmed === '0.0' || isOrderResidueOnly(trimmed);

    return {
      verified: isZero,
      detail: isZero
        ? `simplify(LHS - RHS) = 0 ✓`
        : `simplify(LHS - RHS) = ${trimmed} (expected 0)`,
    };
  } catch (error) {
    return {
      verified: false,
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
      const diff = Math.abs(parseFloat(lhsVal) - parseFloat(rhsVal));
      const verified = diff < 1e-8;
      return {
        verified,
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
        const numResult = parseFloat(result);

        if (isNaN(numResult) || !isFinite(numResult)) {
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
      return { verified: false, detail: 'Could not evaluate at any test point' };
    }

    const verified = passCount === totalTested;
    return {
      verified,
      detail: verified
        ? `Passed ${passCount}/${totalTested} numeric checks ✓`
        : `Failed: ${failures.join('; ')}`,
    };
  } catch (error) {
    return {
      verified: false,
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
): Promise<{ verified: boolean; detail: string }> {
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
    const numResult = parseFloat(result);
    const verified = !isNaN(numResult) && Math.abs(numResult) < 1e-8;

    return {
      verified,
      detail: verified
        ? `Substituting ${variable}=${value}: equation evaluates to ${result} ≈ 0 ✓`
        : `Substituting ${variable}=${value}: equation evaluates to ${result} ≠ 0`,
    };
  } catch (error) {
    return {
      verified: false,
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
  const inner =
    giacOutput.match(/^\[(.+)\]$/)?.[1] || giacOutput.match(/^list\((.+)\)$/)?.[1] || '';
  return inner
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[a-zA-Z_]\w*$/.test(s));
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
  const solutionMatch = claim.match(
    /(\w+)\s*=\s*([^,\s]+)\s+(?:satisfies|is\s+(?:a\s+)?solution\s+(?:of|to))\s+(.+)/i
  );
  if (solutionMatch) {
    return {
      type: 'solution',
      variable: solutionMatch[1],
      value: solutionMatch[2],
      equation: solutionMatch[3].trim(),
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
  const claim = unicodeToAscii(String(args.claim ?? ''));
  const method = (args.method as string) || 'both';

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
          confidence: 'low',
          explanation:
            'Could not parse the claim. Use format: "LHS = RHS" for identities, or "x=2 satisfies equation" for solutions.',
          checks_performed: ['parse_attempt'],
        };
    }

    return formatVerifyResponse(result);
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

  if (method === 'symbolic' || method === 'both') {
    const symbolic = await verifySymbolic(lhs, rhs);
    symbolicOk = symbolic.verified;
    checks.push(`Symbolic: ${symbolic.detail}`);
  }

  if (method === 'numeric' || method === 'both') {
    const numeric = await verifyNumeric(lhs, rhs);
    numericOk = numeric.verified;
    checks.push(`Numeric: ${numeric.detail}`);
  }

  const verified =
    symbolicOk === true || numericOk === true ? symbolicOk !== false && numericOk !== false : false;

  let confidence: 'high' | 'medium' | 'low';
  if (symbolicOk === true) confidence = 'high';
  else if (numericOk === true && symbolicOk === null) confidence = 'medium';
  else if (numericOk === true && symbolicOk === false) confidence = 'low';
  else confidence = verified ? 'medium' : 'low';

  return {
    verified,
    confidence,
    explanation: verified
      ? `Identity verified: ${lhs} = ${rhs}`
      : `Identity NOT verified: ${lhs} ≠ ${rhs}`,
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
    confidence: solution.verified ? 'high' : 'medium',
    explanation: solution.verified
      ? `Verified: ${variable}=${value} satisfies ${equation}`
      : `NOT verified: ${variable}=${value} does not satisfy ${equation}`,
    checks_performed: checks,
  };
}

function formatVerifyResponse(result: VerifyResult): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  const lines: string[] = [
    `Verified: ${result.verified ? 'TRUE ✓' : 'FALSE ✗'}`,
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
