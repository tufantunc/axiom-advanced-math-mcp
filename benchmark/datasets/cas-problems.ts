/**
 * CAS-heavy benchmark problems — tests symbolic computation capabilities
 * that GSM8K/MATH datasets don't cover: integrals, ODEs, matrix operations,
 * Taylor series, Laplace transforms, etc.
 *
 * These are inline (no HuggingFace fetch) because no suitable CAS-specific
 * benchmark dataset exists on HuggingFace.
 *
 * Each problem has:
 * - problem: natural language question
 * - answer: expected result (numeric or symbolic, grader-compatible)
 * - category: for breakdown reporting
 * - compute_hint: the CAS expression the LLM should ideally send to compute
 */

export interface CASProblem {
  problem: string;
  answer: string;
  category: string;
  compute_hint: string;
}

const CAS_PROBLEMS: CASProblem[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // DERIVATIVES (10 quick / 40 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the derivative of x^3 with respect to x.',
    answer: '3*x^2',
    category: 'derivatives',
    compute_hint: 'diff(x^3, x)',
  },
  {
    problem: 'Compute d/dx(sin(x) * x^2).',
    answer: '2*x*sin(x)+x^2*cos(x)',
    category: 'derivatives',
    compute_hint: 'diff(sin(x)*x^2, x)',
  },
  {
    problem: 'Find the derivative of ln(x^2 + 1) with respect to x.',
    answer: '2*x/(x^2+1)',
    category: 'derivatives',
    compute_hint: 'diff(ln(x^2+1), x)',
  },
  {
    problem: 'Compute the derivative of e^(3x) * cos(x).',
    answer: '3*exp(3*x)*cos(x)-exp(3*x)*sin(x)',
    category: 'derivatives',
    compute_hint: 'diff(exp(3*x)*cos(x), x)',
  },
  {
    problem: 'Find the second derivative of x^4 - 2x^2 + 1.',
    answer: '12*x^2-4',
    category: 'derivatives',
    compute_hint: 'diff(x^4-2*x^2+1, x, 2)',
  },
  {
    problem: 'Compute d/dx(arctan(x)).',
    answer: '1/(x^2+1)',
    category: 'derivatives',
    compute_hint: 'diff(atan(x), x)',
  },
  {
    problem: 'Find the derivative of sqrt(1 - x^2).',
    answer: '-x/sqrt(1-x^2)',
    category: 'derivatives',
    compute_hint: 'diff(sqrt(1-x^2), x)',
  },
  {
    problem: 'Compute the third derivative of x^5 with respect to x.',
    answer: '60*x^2',
    category: 'derivatives',
    compute_hint: 'diff(x^5, x, 3)',
  },
  {
    problem: 'Find d/dx(x * e^x).',
    answer: 'exp(x)+x*exp(x)',
    category: 'derivatives',
    compute_hint: 'diff(x*exp(x), x)',
  },
  {
    problem: 'Compute the derivative of (x^2+1)/(x^2-1).',
    answer: '-4*x/(x^2-1)^2',
    category: 'derivatives',
    compute_hint: 'diff((x^2+1)/(x^2-1), x)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // INDEFINITE INTEGRALS (10 quick / 40 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the indefinite integral of 2x with respect to x.',
    answer: 'x^2',
    category: 'integrals',
    compute_hint: 'int(2*x, x)',
  },
  {
    problem: 'Compute the antiderivative of cos(x).',
    answer: 'sin(x)',
    category: 'integrals',
    compute_hint: 'int(cos(x), x)',
  },
  {
    problem: 'Find the integral of e^(2x) dx.',
    answer: 'exp(2*x)/2',
    category: 'integrals',
    compute_hint: 'int(exp(2*x), x)',
  },
  {
    problem: 'Compute the antiderivative of 1/x.',
    answer: 'ln(x)',
    category: 'integrals',
    compute_hint: 'int(1/x, x)',
  },
  {
    problem: 'Find the integral of x * cos(x) dx.',
    answer: 'cos(x)+x*sin(x)',
    category: 'integrals',
    compute_hint: 'int(x*cos(x), x)',
  },
  {
    problem: 'Compute the antiderivative of 1/(1+x^2).',
    answer: 'atan(x)',
    category: 'integrals',
    compute_hint: 'int(1/(1+x^2), x)',
  },
  {
    problem: 'Find the integral of x^2 * e^x dx.',
    answer: '(x^2-2*x+2)*exp(x)',
    category: 'integrals',
    compute_hint: 'int(x^2*exp(x), x)',
  },
  {
    problem: 'Compute the antiderivative of sin^2(x).',
    answer: 'x/2-sin(2*x)/4',
    category: 'integrals',
    compute_hint: 'int(sin(x)^2, x)',
  },
  {
    problem: 'Find the integral of 1/sqrt(1-x^2) dx.',
    answer: 'asin(x)',
    category: 'integrals',
    compute_hint: 'int(1/sqrt(1-x^2), x)',
  },
  {
    problem: 'Compute the antiderivative of x * ln(x).',
    answer: 'x^2*ln(x)/2-x^2/4',
    category: 'integrals',
    compute_hint: 'int(x*ln(x), x)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // DEFINITE INTEGRALS (10 quick / 40 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Evaluate the definite integral of x^2 from 0 to 3.',
    answer: '9',
    category: 'definite_integrals',
    compute_hint: 'int(x^2, x, 0, 3)',
  },
  {
    problem: 'Compute the integral of sin(x) from 0 to pi.',
    answer: '2',
    category: 'definite_integrals',
    compute_hint: 'int(sin(x), x, 0, pi)',
  },
  {
    problem: 'Evaluate the integral of e^x from 0 to 1.',
    answer: 'e-1',
    category: 'definite_integrals',
    compute_hint: 'int(exp(x), x, 0, 1)',
  },
  {
    problem: 'Compute the integral of 1/x from 1 to e.',
    answer: '1',
    category: 'definite_integrals',
    compute_hint: 'int(1/x, x, 1, e)',
  },
  {
    problem: 'Evaluate the integral of cos(x) from 0 to pi/2.',
    answer: '1',
    category: 'definite_integrals',
    compute_hint: 'int(cos(x), x, 0, pi/2)',
  },
  {
    problem: 'Compute the integral of x * e^(-x) from 0 to infinity.',
    answer: '1',
    category: 'definite_integrals',
    compute_hint: 'int(x*exp(-x), x, 0, inf)',
  },
  {
    problem: 'Evaluate the integral of 1/(1+x^2) from 0 to 1.',
    answer: 'pi/4',
    category: 'definite_integrals',
    compute_hint: 'int(1/(1+x^2), x, 0, 1)',
  },
  {
    problem: 'Compute the integral of x^3 from -1 to 1.',
    answer: '0',
    category: 'definite_integrals',
    compute_hint: 'int(x^3, x, -1, 1)',
  },
  {
    problem: 'Evaluate the integral of sqrt(x) from 0 to 4.',
    answer: '16/3',
    category: 'definite_integrals',
    compute_hint: 'int(sqrt(x), x, 0, 4)',
  },
  {
    problem: 'Compute the integral of x^2 * sin(x) from 0 to pi.',
    answer: 'pi^2-4',
    category: 'definite_integrals',
    compute_hint: 'int(x^2*sin(x), x, 0, pi)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // LIMITS (5 quick / 20 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the limit of sin(x)/x as x approaches 0.',
    answer: '1',
    category: 'limits',
    compute_hint: 'limit(sin(x)/x, x, 0)',
  },
  {
    problem: 'Compute the limit of (e^x - 1)/x as x approaches 0.',
    answer: '1',
    category: 'limits',
    compute_hint: 'limit((exp(x)-1)/x, x, 0)',
  },
  {
    problem: 'Find the limit of (1 + 1/n)^n as n approaches infinity.',
    answer: 'e',
    category: 'limits',
    compute_hint: 'limit((1+1/n)^n, n, inf)',
  },
  {
    problem: 'Compute the limit of x * ln(x) as x approaches 0 from the right.',
    answer: '0',
    category: 'limits',
    compute_hint: 'limit(x*ln(x), x, 0, +)',
  },
  {
    problem: 'Find the limit of (x^2 - 4)/(x - 2) as x approaches 2.',
    answer: '4',
    category: 'limits',
    compute_hint: 'limit((x^2-4)/(x-2), x, 2)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // ODE (5 quick / 20 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: "Solve the ODE y' = 2x.",
    answer: 'x^2',
    category: 'ode',
    compute_hint: "desolve(y'=2*x, x, y)",
  },
  {
    problem: "Solve the ODE y' = y.",
    answer: 'C*exp(x)',
    category: 'ode',
    compute_hint: "desolve(y'=y, x, y)",
  },
  {
    problem: "Solve y'' + y = 0.",
    answer: 'C_0*cos(x)+C_1*sin(x)',
    category: 'ode',
    compute_hint: "desolve(y''+y=0, x, y)",
  },
  {
    problem: "Solve y' + y = e^x.",
    answer: 'exp(x)/2',
    category: 'ode',
    compute_hint: "desolve(y'+y=exp(x), x, y)",
  },
  {
    problem: "Solve y' = -2y with y(0) = 3.",
    answer: '3*exp(-2*x)',
    category: 'ode',
    compute_hint: "desolve([y'=-2*y, y(0)=3], x, y)",
  },

  // ═══════════════════════════════════════════════════════════════════════
  // LINEAR ALGEBRA (10 quick / 40 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Compute the determinant of the matrix [[1,2],[3,4]].',
    answer: '-2',
    category: 'linear_algebra',
    compute_hint: 'det([[1,2],[3,4]])',
  },
  {
    problem: 'Find the eigenvalues of the matrix [[2,1],[1,2]].',
    answer: '1,3',
    category: 'linear_algebra',
    compute_hint: 'eigenvals([[2,1],[1,2]])',
  },
  {
    problem: 'Compute the determinant of [[1,0,2],[3,1,0],[0,2,1]].',
    answer: '-5',
    category: 'linear_algebra',
    compute_hint: 'det([[1,0,2],[3,1,0],[0,2,1]])',
  },
  {
    problem: 'Find the rank of the matrix [[1,2,3],[4,5,6],[7,8,9]].',
    answer: '2',
    category: 'linear_algebra',
    compute_hint: 'rank([[1,2,3],[4,5,6],[7,8,9]])',
  },
  {
    problem: 'Compute the determinant of the 3x3 identity matrix.',
    answer: '1',
    category: 'linear_algebra',
    compute_hint: 'det([[1,0,0],[0,1,0],[0,0,1]])',
  },
  {
    problem: 'Find the eigenvalues of [[4,1],[2,3]].',
    answer: '2,5',
    category: 'linear_algebra',
    compute_hint: 'eigenvals([[4,1],[2,3]])',
  },
  {
    problem: 'Compute the trace of the matrix [[3,1,4],[1,5,9],[2,6,5]].',
    answer: '13',
    category: 'linear_algebra',
    compute_hint: '3+5+5',
  },
  {
    problem: 'Find the determinant of [[2,-1,0],[-1,2,-1],[0,-1,2]].',
    answer: '4',
    category: 'linear_algebra',
    compute_hint: 'det([[2,-1,0],[-1,2,-1],[0,-1,2]])',
  },
  {
    problem: 'What is the rank of [[1,1],[1,1]]?',
    answer: '1',
    category: 'linear_algebra',
    compute_hint: 'rank([[1,1],[1,1]])',
  },
  {
    problem: 'Find the eigenvalues of [[0,1],[-1,0]].',
    answer: 'i,-i',
    category: 'linear_algebra',
    compute_hint: 'eigenvals([[0,1],[-1,0]])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // POLYNOMIAL ALGEBRA (5 quick / 20 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Factor x^2 - 9.',
    answer: '(x-3)*(x+3)',
    category: 'polynomial',
    compute_hint: 'factor(x^2-9)',
  },
  {
    problem: 'Expand (x + 2)^3.',
    answer: 'x^3+6*x^2+12*x+8',
    category: 'polynomial',
    compute_hint: 'expand((x+2)^3)',
  },
  {
    problem: 'Simplify (x^2 - 1)/(x - 1).',
    answer: 'x+1',
    category: 'polynomial',
    compute_hint: 'simplify((x^2-1)/(x-1))',
  },
  {
    problem: 'Factor x^4 - 1 over the reals.',
    answer: '(x-1)*(x+1)*(x^2+1)',
    category: 'polynomial',
    compute_hint: 'factor(x^4-1)',
  },
  {
    problem: 'Find the partial fraction decomposition of 1/(x^2-1).',
    answer: '1/(2*(x-1))-1/(2*(x+1))',
    category: 'polynomial',
    compute_hint: 'partfrac(1/(x^2-1), x)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // TAYLOR SERIES (5 quick / 20 full)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the Taylor series of e^x around x=0 up to order 4.',
    answer: '1+x+x^2/2+x^3/6+x^4/24',
    category: 'series',
    compute_hint: 'taylor(exp(x), x=0, 4)',
  },
  {
    problem: 'Compute the Taylor expansion of sin(x) around x=0 up to order 5.',
    answer: 'x-x^3/6+x^5/120',
    category: 'series',
    compute_hint: 'taylor(sin(x), x=0, 5)',
  },
  {
    problem: 'Find the Maclaurin series of cos(x) up to order 4.',
    answer: '1-x^2/2+x^4/24',
    category: 'series',
    compute_hint: 'taylor(cos(x), x=0, 4)',
  },
  {
    problem: 'Compute the Taylor expansion of ln(1+x) around x=0 up to order 5.',
    answer: 'x-x^2/2+x^3/3-x^4/4+x^5/5',
    category: 'series',
    compute_hint: 'taylor(ln(1+x), x=0, 5)',
  },
  {
    problem: 'Find the Taylor series of 1/(1-x) around x=0 up to order 4.',
    answer: '1+x+x^2+x^3+x^4',
    category: 'series',
    compute_hint: 'taylor(1/(1-x), x=0, 4)',
  },
];

/**
 * Load CAS benchmark problems (inline dataset — no network fetch).
 */
export function loadCAS(limit: number): CASProblem[] {
  if (limit <= 0) return [];
  return CAS_PROBLEMS.slice(0, Math.min(limit, CAS_PROBLEMS.length));
}
