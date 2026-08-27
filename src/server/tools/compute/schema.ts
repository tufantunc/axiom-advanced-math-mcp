import { z } from 'zod';
import { MAX_EXPRESSION_LENGTH } from '../limits.js';

/**
 * Upper bound on the `problem` field accepted by the compute tool.
 *
 * The transport already caps the whole HTTP body at 1 MB (see
 * `MAX_MCP_BODY_BYTES` in http-app.ts), but that limit exists to bound
 * memory use for an unauthenticated caller -- it says nothing about what's a
 * *reasonable* CAS expression. Evaluation itself is bounded out of process now,
 * but the routing and preprocessing an oversized `problem` goes through first
 * are not, and neither is parse cost.
 *
 * 8 KB comfortably covers realistic symbolic-math input -- even a gnarly
 * multi-line system of equations or a long Taylor expansion request -- while
 * keeping worst-case parsing/evaluation cost bounded.
 */

export const computeSchema = z.object({
  problem: z
    .string()
    .min(1)
    .max(MAX_EXPRESSION_LENGTH, `problem must be at most ${MAX_EXPRESSION_LENGTH} characters`)
    .describe(
      'Mathematical problem to solve. Use CAS-style function calls for clarity:\n' +
        '  solve(x^2-4=0, x)        — solve equation\n' +
        '  diff(x^3, x)             — differentiate\n' +
        '  int(x^2, x, 0, 1)       — definite integral\n' +
        '  limit(sin(x)/x, x, 0)   — limit\n' +
        '  taylor(exp(x), x=0, 5)  — Taylor series\n' +
        '  factor(x^2-4)            — factorize\n' +
        '  simplify((x^2-1)/(x-1)) — simplify\n' +
        '  expand((x+1)^3)          — expand\n' +
        '  det([[1,2],[3,4]])        — matrix determinant\n' +
        '  C(10,3)                   — combinations\n' +
        '  ifactor(2310)             — prime factorization\n' +
        '  2+3*sin(pi/4)            — arithmetic\n' +
        'Or any valid Giac/Xcas expression as fallback.\n' +
        'Results larger than 100,000 characters are refused rather than returned — ask for a ' +
        'smaller range or fewer elements.'
    ),
  domain: z
    .enum(['real', 'complex', 'numeric', 'exact'])
    .optional()
    .describe(
      'Domain hint:\n' +
        '  real (default) — real solutions\n' +
        '  complex — complex solutions (csolve, cfactor)\n' +
        '  numeric — force numerical methods\n' +
        '  exact — exact symbolic form'
    ),
  precision: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .describe(
      'Significant digits for a numeric result. Omit for full precision. Values above ~17 have no ' +
        'effect: the result is a double.'
    ),
  format: z
    .enum(['text', 'latex', 'json'])
    .optional()
    .describe(
      'Output format:\n' +
        '  text (default) — human-readable result\n' +
        '  latex — LaTeX-focused output\n' +
        '  json — structured ComputeEnvelope'
    ),
});
