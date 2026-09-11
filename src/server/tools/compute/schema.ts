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

/**
 * The limits named in the descriptions below, and where each number comes from:
 *
 *   - `problem` at 8 KB: MAX_EXPRESSION_LENGTH (../limits.ts), documented there.
 *   - 100,000-character result refusal: MAX_RESULT_CHARS
 *     (js-compute/mathjs-tasks.ts). Measured there: `1:2000000` builds
 *     24.3 million characters that would land whole in an MCP client's
 *     context; the cap fires after stringification, bounding what is
 *     returned, not what is spent computing it.
 *   - "more than 9 equations": MAX_SYSTEM_EQUATIONS
 *     (ode-system-shape.ts). Measured there: the linearity probe is
 *     quadratic in the equation count, and 9 equations produce a
 *     1,681-character probe while 10 produce 2,006 — past the probe's own
 *     character cap. Nine is the largest count that can pass, not a round
 *     number chosen for its shape.
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
        'smaller range or fewer elements.\n' +
        'Refused rather than answered, because the answer would be meaningless:\n' +
        '  - arithmetic evaluating to NaN (e.g. 0/0). An infinite result IS returned, ' +
        'with a warning, since a true infinity and an overflowed finite value are ' +
        'indistinguishable in the result.\n' +
        '  - a t-test whose sample has no variation (paired_t compares the differences, ' +
        'so it is those that must vary; Welch two_sample_t needs only one sample to vary)\n' +
        '  - a contingency table with a negative count, an all-zero row or column, ' +
        'rows of differing length, or only one row or column\n' +
        '  - a one-way ANOVA with no within-group variation, or with no more ' +
        'observations than groups\n' +
        '  - any of these whose values are large enough that the statistic overflows ' +
        'to infinity (the t-statistic, chi-square or F), since the overflowed value ' +
        'is no longer the statistic\n' +
        '  - a numerical method whose expression does not depend on the variable it ' +
        'is solved or integrated over, or which the CAS answers symbolically rather ' +
        'than with a number\n' +
        '  - a result nested more deeply than the evaluator can certify as free of ' +
        'undefined values\n' +
        '  - a system of differential equations that this rewrite cannot express as a ' +
        'constant matrix. Linear constant-coefficient systems ARE solved: ' +
        "desolve([y'=z, z'=-y], x) returns every function, and the envelope's " +
        '`components` field says which is which. Refused: not linear in the unknowns; ' +
        'coefficients depending on the independent variable; a derivative of order ' +
        "above one (rewrite y''=z as y'=w, w'=z); more than 9 equations; initial " +
        'conditions for only some of the functions, or at different points.\n' +
        'The infinite-result rule above is about arithmetic evaluation; a symbolic ' +
        '+/-infinity from the CAS routes (a limit, a divergent integral) is a normal ' +
        'answer and is not flagged.'
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
  // Precision is significant digits. The floor of 1 is definitional — fewer
  // than one significant digit is not a precision. The ceiling of 50 has no
  // recorded rationale: it arrived with the field and nothing measured it.
  // What is known is in the description itself — above ~17 digits the result
  // is a double and carries no more information — so 50 bounds only how far
  // a caller may ask past the point of effect. The CLI's --precision window
  // mirrors this 1..50 exactly (requirePrecision in cli/parse.ts, pinned by
  // test/cli-parse.test.ts).
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
