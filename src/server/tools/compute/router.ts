import type { RouterRule, RouteResult } from './types.js';
import { splitTopLevel } from '../output-cleanup.js';
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
  extractGeometry3d,
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

/**
 * True when the problem has an `=` at bracket depth 0 — i.e. it is an equation,
 * not a call carrying keyword arguments.
 *
 * This is the distinction that matters for routing. `gradient(f = x*y, [x,y])`
 * and `normal(mu=0, sigma=1)` contain `=` but are calls whose own handler should
 * take them; `x^2-4=0` and `sum(k,k,1,n) = 55` are equations to solve. Testing
 * for a bare `=` cannot tell those apart, which is why the solve rule used to
 * carry two hand-maintained lists of every other handler's verbs.
 *
 * Unbalanced brackets are treated as an equation. Depth is meaningless on input
 * like `f(x=1`, and routing it here sends it to a handler that runs
 * `validateExpression`, which reports the unclosed bracket. Letting it fall
 * through to the raw-Giac fallback instead produced `Result: f` — a silent wrong
 * answer to a typo.
 */
function hasTopLevelEquals(problem: string): boolean {
  if (!isBracketBalanced(problem)) return problem.includes('=');
  return splitTopLevel(stripEnclosingBrackets(problem), '=').length > 1;
}

/**
 * Whether every bracket opens and closes in order, and closes with its own
 * kind.
 *
 * Depth alone is not enough: `f(x=1]` opens one bracket and closes one, so a
 * depth counter calls it balanced, the `=` reads as nested, and the typo
 * reaches the raw-Giac fallback as `Result: undef` with no error.
 */
function isBracketBalanced(problem: string): boolean {
  const closerFor: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const expected: string[] = [];
  for (const ch of problem) {
    if (closerFor[ch]) expected.push(closerFor[ch]);
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (expected.pop() !== ch) return false;
    }
  }
  return expected.length === 0;
}

/**
 * Drops bracket pairs that wrap the whole problem, so a parenthesised equation
 * still reads as an equation: `(x^2-4=0)` and the Giac-idiomatic `[x^2-4=0]`
 * have no depth-0 `=` until the wrapper comes off.
 *
 * Only strips a pair whose partner is the final character, so `gradient(f =
 * x*y, [x,y])` (opener preceded by a verb) and `(a=1)*(b=2)` are untouched.
 * `{}` is left alone: it is a Giac set, not grouping.
 */
function stripEnclosingBrackets(problem: string): string {
  let s = problem.trim();
  while (s.length > 1 && (s[0] === '(' || s[0] === '[')) {
    let depth = 0;
    let partner = -1;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') {
        depth--;
        if (depth === 0) {
          partner = i;
          break;
        }
      }
    }
    if (partner !== s.length - 1) break;
    s = s.slice(1, -1).trim();
  }
  return s;
}

/**
 * Derivative notation that marks the problem as an ODE, owned by
 * `calculus:solve_ode`. Defined once because two rules need it: solve_ode to
 * claim these, and the solve rule above it to decline them.
 *
 * `y''` contains `y'`, so the first pattern already covers second-order forms.
 */
function looksLikeOde(problem: string): boolean {
  return /y'/.test(problem) || /dy\s*\/\s*dx/.test(problem);
}

/** Check if problem looks like multiple equations (system). */
function isSystemOfEquations(problem: string): boolean {
  // [eq1, eq2, ...] format
  //
  // `[^,]*` rather than `.*` before the comma: two greedy `.*` either side of a
  // literal makes the split ambiguous, so an input that does not match backtracks
  // through every position. Stopping at the first comma is deterministic and
  // accepts exactly the same strings.
  if (/^\s*\[[^,]*,.*\]\s*$/.test(problem) && (problem.includes('=') || problem.includes(','))) {
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
      // An equation to solve. Systems need no check here: rule 1 tests
      // isSystemOfEquations and route() is first-match, so it has already
      // claimed them. ODEs do, because solve_ode sits below this rule.
      if (hasTopLevelEquals(p)) {
        if (looksLikeOde(p)) return false;
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
    test: (p) => startsWith(p, 'iint', 'iiint') || /int\s*\(\s*int\s*\(/i.test(p),
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
    test: (p) => startsWith(p, 'desolve', 'dsolve', 'odesolve') || looksLikeOde(p),
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
        'div', // 'div' is the short alias for divergence, NOT arithmetic division
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
    test: (p) => {
      const t = p.trim();
      // Call-form: claim ONLY a single bare call. Compound arithmetic like
      // "C(4,2) * (5/6)^2" must fall through to the Giac evaluator, which
      // computes the whole expression (this handler would silently drop
      // everything after the first call).
      const callForm =
        /^[cp]\s*\(\s*\d/i.test(t) || startsWith(p, 'comb', 'perm', 'combinations', 'permutations');
      if (callForm) return /^[A-Za-z]+\s*\([^()]*\)$/.test(t);
      return hasKeyword(
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
      );
    },
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

  // 22. 3D geometry — explicit 3D-named verbs. Placed before the 2D geometry rule.
  // 'vector_norm' (not 'norm') avoids the matrix-norm rule; all names are distinct
  // from 2D geometry verbs, so routing is unambiguous.
  {
    name: 'geometry3d',
    test: (p) =>
      startsWith(
        p,
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
        'volume_parallelepiped'
      ),
    extract: extractGeometry3d,
  },

  // 23. Geometry
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
