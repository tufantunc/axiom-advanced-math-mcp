import { z } from 'zod';

export const computeSchema = z.object({
  problem: z
    .string()
    .min(1)
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
        'Or any valid Giac/Xcas expression as fallback.'
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
  precision: z.number().min(1).max(50).optional().describe('Decimal precision (default: 10)'),
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
