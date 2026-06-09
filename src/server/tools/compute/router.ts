import type { RouterRule, RouteResult } from './types.js';
import {
  extractSolveSystem,
  extractSolveEquation,
  extractDiff,
  extractIntegrate,
  extractLimit,
  extractTaylor,
  extractOde,
  extractGiacRaw,
  extractFactor,
  extractSimplify,
  extractExpand,
  extractPartfrac,
  extractMatrix,
  extractNumberTheory,
  extractCombinatorics,
  extractProbability,
  extractHypothesisTesting,
  extractGeometry,
  extractNumericalMethods,
  extractExactValue,
  extractLinearRegression,
  extractSequenceIdentify,
  extractNumberProperties,
  extractQuickCalc,
  extractFourier,
  extractMultivariable,
} from './extractors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Test if `problem` starts with one of the given function names (case-insensitive). */
function startsWith(problem: string, ...names: string[]): boolean {
  const trimmed = problem.trimStart().toLowerCase();
  return names.some((n) => {
    const lc = n.toLowerCase();
    return trimmed.startsWith(lc + '(') || trimmed.startsWith(lc + ' (');
  });
}

/** Check if problem contains keyword (whole-word, case-insensitive). */
function hasKeyword(problem: string, ...keywords: string[]): boolean {
  const lc = problem.toLowerCase();
  return keywords.some((kw) => {
    const re = new RegExp(`\\b${kw.toLowerCase()}\\b`);
    return re.test(lc);
  });
}

/** Detect matrix-like argument: [[...]] */
function hasMatrixArg(problem: string): boolean {
  return /\[\s*\[/.test(problem);
}

/** Check if problem looks like multiple equations (system). */
function isSystemOfEquations(problem: string): boolean {
  // [eq1, eq2, ...] format
  if (/^\s*\[.*,.*\]\s*$/.test(problem) && (problem.includes('=') || problem.includes(','))) {
    const eqCount = (problem.match(/=/g) || []).length;
    if (eqCount >= 2) return true;
  }
  // solve_system(...) explicit call
  if (startsWith(problem, 'solve_system')) return true;
  // Multiple equations separated by semicolons with =
  const semiParts = problem.split(';').filter((p) => p.includes('='));
  if (semiParts.length >= 2) return true;
  return false;
}

/** Check if problem is a pure arithmetic/trig expression (no function-call patterns
 *  that match higher-priority rules). */
function isPureArithmetic(problem: string): boolean {
  const trimmed = problem.trim();
  // Must not be empty
  if (!trimmed) return false;
  // Should not start with known CAS function calls
  const casPatterns =
    /^(solve|csolve|diff|int|integrate|limit|taylor|desolve|factor|cfactor|simplify|expand|partfrac|det|inv|eigenvals|rref|rank|tran|ker|qr|lu|cholesky|svd|norm|cond|ifactor|isprime|euler|laplace|ilaplace|sum|product|grad|curl|divergence|hessian|jacobian|C|P|comb|perm)\s*\(/i;
  if (casPatterns.test(trimmed)) return false;
  // Should not look like a system of equations
  if (isSystemOfEquations(trimmed)) return false;
  // Check for unknown function calls — if there's a word followed by '(' that isn't
  // a known math function, it's likely a CAS command and should go to giac_raw
  const knownMathFns =
    /^(sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|sqrt|cbrt|abs|ceil|floor|round|log|log2|log10|ln|exp|pow|min|max|sign|mod|gcd|lcm|nCr|nPr|factorial|gamma)\s*\(/i;
  const fnCallPattern = /\b([a-zA-Z_]\w*)\s*\(/g;
  let match;
  while ((match = fnCallPattern.exec(trimmed)) !== null) {
    const fnName = match[1];
    if (!knownMathFns.test(fnName + '(')) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rules — ordered most-specific first
// ---------------------------------------------------------------------------

const rules: RouterRule[] = [
  // 1. System of equations
  {
    name: 'solve_system',
    test: (p) => isSystemOfEquations(p) || startsWith(p, 'solve_system'),
    extract: extractSolveSystem,
  },

  // 2. Single equation solve
  {
    name: 'solve_equation',
    test: (p, d) => {
      // Domain hint "numeric" overrides to numerical_methods
      if (d === 'numeric') return false;
      if (startsWith(p, 'solve', 'csolve')) return true;
      // Single equation with = that isn't a system and doesn't match other patterns
      if (/=/.test(p) && !isSystemOfEquations(p)) {
        // Exclude ODE patterns: y', y'', dy/dx
        if (/y['']/.test(p) || /dy\s*\/\s*dx/.test(p) || /y''\s*[+=]/.test(p)) return false;
        // Exclude patterns that belong to other handlers
        if (
          startsWith(
            p,
            'diff',
            'int',
            'integrate',
            'limit',
            'taylor',
            'desolve',
            'factor',
            'simplify',
            'expand',
            'partfrac',
            'det',
            'inv',
            'eigenvals',
            'rref',
            'binomial',
            'normal',
            'poisson',
            'geometric',
            'hypergeometric',
            'chi_square',
            'student_t',
            'f_distribution',
            'beta_dist',
            'exponential',
            't_test',
            'anova',
            'newton',
            'bisection',
            'secant',
            'romberg',
            'to_exact',
            'to_decimal',
            'simplify_fraction'
          )
        )
          return false;
        // Exclude keyword-based patterns with = inside function args (e.g., "normal(mu=0, ...)")
        if (
          /^\w+\s*\(.*=/.test(p) &&
          hasKeyword(
            p,
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
            't_test',
            'anova',
            'chi_square_test',
            'one_sample_t',
            'two_sample_t',
            'paired_t'
          )
        )
          return false;
        return true;
      }
      return false;
    },
    extract: extractSolveEquation,
  },

  // 3. Differentiation
  {
    name: 'calculus:differentiate',
    test: (p) => startsWith(p, 'diff', 'differentiate', 'derivative'),
    extract: extractDiff,
  },

  // Multiple integrals — MUST precede single integrate (nested int starts with "int(").
  {
    name: 'multivariable:multiple_integral',
    test: (p) =>
      startsWith(p, 'iint', 'iiint') || /int\s*\(\s*int\s*\(/i.test(p),
    extract: extractMultivariable,
  },

  // 4. Integration
  {
    name: 'calculus:integrate',
    test: (p) => startsWith(p, 'int', 'integrate'),
    extract: extractIntegrate,
  },

  // 5. Limit
  {
    name: 'calculus:limit',
    test: (p) => startsWith(p, 'limit', 'lim'),
    extract: extractLimit,
  },

  // 6. Taylor
  {
    name: 'calculus:taylor',
    test: (p) => startsWith(p, 'taylor', 'series'),
    extract: extractTaylor,
  },

  // 7. ODE
  {
    name: 'calculus:solve_ode',
    test: (p) =>
      startsWith(p, 'desolve', 'dsolve', 'odesolve') ||
      /y['']/.test(p) ||
      /dy\s*\/\s*dx/.test(p) ||
      /y''\s*[+=]/.test(p),
    extract: extractOde,
  },

  // 8. Laplace / inverse Laplace
  {
    name: 'giac_raw:laplace',
    test: (p) => startsWith(p, 'laplace', 'ilaplace'),
    extract: extractGiacRaw,
  },

  // 9. Factor
  {
    name: 'algebra:factor',
    test: (p) => startsWith(p, 'factor', 'cfactor'),
    extract: extractFactor,
  },

  // 10. Simplify
  {
    name: 'algebra:simplify',
    test: (p) => startsWith(p, 'simplify'),
    extract: extractSimplify,
  },

  // 11. Expand
  {
    name: 'algebra:expand',
    test: (p) => startsWith(p, 'expand'),
    extract: extractExpand,
  },

  // 12. Partial fractions
  {
    name: 'algebra:partial_fractions',
    test: (p) => startsWith(p, 'partfrac', 'partial_fractions'),
    extract: extractPartfrac,
  },

  // 13. Summation / product
  {
    name: 'giac_raw:sum_product',
    test: (p) => startsWith(p, 'sum', 'product'),
    extract: extractGiacRaw,
  },

  // 14. Vector / differential operators + multivariable optimization.
  {
    name: 'multivariable:operators',
    test: (p) =>
      startsWith(
        p,
        'gradient',
        'grad',
        'curl',
        'divergence',
        'div',
        'hessian',
        'jacobian',
        'partial',
        'critical_points',
        'lagrange',
        'tangent_plane',
        'directional_derivative'
      ),
    extract: extractMultivariable,
  },

  // 15. Matrix operations (primary)
  {
    name: 'matrix:primary',
    test: (p) =>
      startsWith(p, 'det', 'inv', 'eigenvals', 'eigenvects', 'rref', 'rank', 'tran', 'ker') &&
      hasMatrixArg(p),
    extract: extractMatrix,
  },

  // 16. Matrix decompositions
  {
    name: 'matrix:decomposition',
    test: (p) =>
      startsWith(p, 'qr', 'lu', 'cholesky', 'svd', 'norm', 'l1norm', 'linfnorm', 'cond') &&
      hasMatrixArg(p),
    extract: extractMatrix,
  },

  // 17. Number theory
  {
    name: 'number_theory',
    test: (p) => startsWith(p, 'ifactor', 'isprime', 'euler'),
    extract: extractNumberTheory,
  },

  // 18. Combinatorics
  {
    name: 'combinatorics',
    test: (p) =>
      /^[CP]\s*\(\s*\d/.test(p.trim()) ||
      startsWith(p, 'comb', 'perm', 'C', 'P') ||
      hasKeyword(
        p,
        'choose',
        'combinations',
        'permutations',
        'stirling',
        'bell',
        'catalan',
        'derangements',
        'partitions',
        'multinomial'
      ),
    extract: extractCombinatorics,
  },

  // 19. Probability distributions
  {
    name: 'probability',
    test: (p) =>
      hasKeyword(
        p,
        'binomial',
        'normal',
        'poisson',
        'geometric',
        'hypergeometric',
        'chi_square',
        'student_t',
        'f_distribution',
        'beta_dist',
        'exponential_dist'
      ) ||
      startsWith(
        p,
        'binomial',
        'normal',
        'poisson',
        'geometric',
        'hypergeometric',
        'chi_square',
        'student_t',
        'f_distribution',
        'beta_dist',
        'exponential'
      ),
    extract: extractProbability,
  },

  // 20. Hypothesis testing
  {
    name: 'hypothesis_testing',
    test: (p) =>
      hasKeyword(
        p,
        't_test',
        'anova',
        'chi_square_test',
        'one_sample_t',
        'two_sample_t',
        'paired_t'
      ),
    extract: extractHypothesisTesting,
  },

  // 21. Fourier
  {
    name: 'fourier',
    test: (p) => startsWith(p, 'fft', 'ifft', 'fourier'),
    extract: extractFourier,
  },

  // 22. Geometry
  {
    name: 'geometry',
    test: (p) =>
      startsWith(
        p,
        'distance',
        'midpoint',
        'slope',
        'area',
        'perimeter',
        'circumference',
        'intersection',
        'angle',
        'point_line_distance'
      ) || hasKeyword(p, 'area_triangle', 'area_polygon', 'area_circle', 'perimeter_polygon'),
    extract: extractGeometry,
  },

  // 23. Numerical methods
  {
    name: 'numerical_methods',
    test: (p, d) =>
      d === 'numeric' ||
      startsWith(p, 'newton', 'bisection', 'secant', 'romberg', 'simpson') ||
      hasKeyword(p, 'newton_raphson', 'numerical_integration'),
    extract: extractNumericalMethods,
  },

  // 24. Exact value
  {
    name: 'exact_value',
    test: (p) => startsWith(p, 'to_exact', 'to_decimal', 'simplify_fraction'),
    extract: extractExactValue,
  },

  // 25. Linear regression
  {
    name: 'linear_regression',
    test: (p) =>
      startsWith(p, 'linear_regression', 'fit', 'regression') ||
      hasKeyword(p, 'linear_regression', 'polynomial_regression'),
    extract: extractLinearRegression,
  },

  // 26. Sequence identify
  {
    name: 'sequence_identify',
    test: (p) =>
      startsWith(p, 'sequence', 'identify_sequence') ||
      hasKeyword(p, 'identify_sequence', 'sequence_pattern'),
    extract: extractSequenceIdentify,
  },

  // 27. Number properties
  {
    name: 'number_properties',
    test: (p) =>
      startsWith(p, 'analyze', 'number_properties') ||
      hasKeyword(p, 'number_properties', 'prime_analysis'),
    extract: extractNumberProperties,
  },

  // 28. Pure arithmetic → quick_calc
  {
    name: 'quick_calc',
    test: (p) => isPureArithmetic(p),
    extract: extractQuickCalc,
  },

  // 29. Fallback → raw Giac
  {
    name: 'giac_raw:fallback',
    test: () => true,
    extract: extractGiacRaw,
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function route(problem: string, domain?: string): RouteResult {
  for (const rule of rules) {
    if (rule.test(problem, domain)) {
      return rule.extract(problem, domain);
    }
  }
  // Should never reach here due to fallback, but just in case
  return { handler: 'giac_raw', args: { expression: problem } };
}

// Export rules for testing
export { rules as routerRules };
