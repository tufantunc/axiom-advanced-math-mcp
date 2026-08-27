import type { RouteResult } from './types.js';
import { rewriteCombinatorics } from '../combinatorics-rewrite.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Extract the content inside the outermost parentheses of a function call.
 * e.g. "solve(x^2-4, x)" → "x^2-4, x"
 */
function extractFnArgs(problem: string): string {
  const idx = problem.indexOf('(');
  if (idx === -1) return problem;
  // Find matching closing paren
  let depth = 0;
  let end = -1;
  for (let i = idx; i < problem.length; i++) {
    if (problem[i] === '(') depth++;
    else if (problem[i] === ')') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return problem.slice(idx + 1); // unbalanced — take everything after (
  return problem.slice(idx + 1, end);
}

/**
 * Split args by top-level commas (not inside nested parens/brackets).
 */
function splitArgs(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let bracketDepth = 0;
  let current = '';

  for (const ch of inner) {
    if (ch === '(' || ch === '[') {
      if (ch === '(') depth++;
      else bracketDepth++;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      if (ch === ')') depth--;
      else bracketDepth--;
      current += ch;
    } else if (ch === ',' && depth === 0 && bracketDepth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/**
 * Guess the primary variable from an expression by finding single-letter
 * identifiers that aren't common constants (e, i) or function names.
 */
function guessVariable(expr: string): string {
  const varMatch = expr.match(/\b([a-zA-Z])\b/g);
  if (!varMatch) return 'x';
  const constants = new Set(['e', 'i', 'E', 'I']);
  for (const v of varMatch) {
    if (!constants.has(v)) return v;
  }
  return 'x';
}

/**
 * Extract matrix string [[...],[...]] from problem.
 */
function extractMatrixString(problem: string): string {
  const match = problem.match(/(\[\s*\[[\s\S]*\]\s*\])/);
  return match ? match[1] : '';
}

function extractVariables(equations: string[]): string[] {
  const vars = new Set<string>();
  for (const eq of equations) {
    const matches = eq.match(/\b([a-zA-Z])\b/g);
    if (matches)
      matches.forEach((v) => {
        if (v !== 'e' && v !== 'E') vars.add(v);
      });
  }
  return Array.from(vars);
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

// --- Solve ---

export function extractSolveSystem(problem: string): RouteResult {
  // Try to parse "solve_system([eq1, eq2], [x, y])" or "[eq1; eq2]" formats
  if (/^solve_system\s*\(/i.test(problem.trim())) {
    const inner = extractFnArgs(problem);
    const parts = splitArgs(inner);
    // Expected: [equations], [variables]
    const equations = parts[0]
      ? parts[0]
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((e) => e.trim())
      : [];
    const variables = parts[1]
      ? parts[1]
          .replace(/^\[|\]$/g, '')
          .split(',')
          .map((v) => v.trim())
      : [];
    return { handler: 'solve_system', args: { equations, variables } };
  }
  // Semicolon-separated equations
  if (problem.includes(';')) {
    const equations = problem
      .split(';')
      .map((e) => e.trim())
      .filter(Boolean);
    return {
      handler: 'solve_system',
      args: { equations, variables: extractVariables(equations) },
    };
  }
  // [eq1, eq2] bracket format
  const inner = problem.replace(/^\[|\]$/g, '').trim();
  const equations = splitArgs(inner);
  return {
    handler: 'solve_system',
    args: { equations, variables: extractVariables(equations) },
  };
}

export function extractSolveEquation(problem: string, domain?: string): RouteResult {
  if (/^(c?solve)\s*\(/i.test(problem.trim())) {
    const inner = extractFnArgs(problem);
    const parts = splitArgs(inner);
    const equation = parts[0] || '';
    const variable = parts[1] || guessVariable(equation);
    const isComplex = problem.trim().toLowerCase().startsWith('csolve') || domain === 'complex';
    return {
      handler: 'solve_equation',
      args: { equation, variable, domain: isComplex ? 'complex' : 'real' },
    };
  }
  // Implicit: expression with = sign
  const variable = guessVariable(problem);
  return {
    handler: 'solve_equation',
    args: { equation: problem.trim(), variable, domain: domain === 'complex' ? 'complex' : 'real' },
  };
}

// --- Calculus ---

export function extractDiff(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const order = parts[2] ? parseInt(parts[2], 10) : undefined;
  return {
    handler: 'calculus',
    args: {
      operation: 'differentiate',
      expression,
      variable,
      ...(order ? { order } : {}),
    },
  };
}

export function extractIntegrate(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const lower_bound = parts[2];
  const upper_bound = parts[3];
  return {
    handler: 'calculus',
    args: {
      operation: 'integrate',
      expression,
      variable,
      ...(lower_bound !== undefined ? { lower_bound } : {}),
      ...(upper_bound !== undefined ? { upper_bound } : {}),
    },
  };
}

export function extractLimit(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  const point = parts[2] || '0';
  const direction = parts[3] as '+' | '-' | undefined;
  return {
    handler: 'calculus',
    args: {
      operation: 'limit',
      expression,
      variable,
      point,
      ...(direction ? { direction } : {}),
    },
  };
}

export function extractTaylor(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  // taylor(expr, var=point, order) or taylor(expr, var, point, order)
  let variable = parts[1] || guessVariable(expression);
  // No initialiser: both branches below assign it, so '0' was never read.
  let point: string;
  let order: number | undefined;

  if (variable.includes('=')) {
    const [v, p] = variable.split('=');
    variable = v.trim();
    point = p.trim();
    order = parts[2] ? parseInt(parts[2], 10) : undefined;
  } else {
    point = parts[2] || '0';
    order = parts[3] ? parseInt(parts[3], 10) : undefined;
  }

  return {
    handler: 'calculus',
    args: {
      operation: 'taylor',
      expression,
      variable,
      point,
      ...(order ? { order } : {}),
    },
  };
}

export function extractOde(problem: string): RouteResult {
  if (/^(desolve|dsolve|odesolve)\s*\(/i.test(problem.trim())) {
    const inner = extractFnArgs(problem);
    const parts = splitArgs(inner);
    // desolve(eq, var, fn) or desolve([eq, ic], var, fn)
    const equation = parts[0] || '';
    const variable = parts[1] || 'x';
    const function_name = parts[2] || 'y';
    return {
      handler: 'calculus',
      args: { operation: 'solve_ode', equation, variable, function_name },
    };
  }
  // Implicit ODE: contains y', y'', dy/dx
  return {
    handler: 'calculus',
    args: { operation: 'solve_ode', equation: problem.trim(), variable: 'x', function_name: 'y' },
  };
}

// --- Algebra ---

export function extractFactor(problem: string, domain?: string): RouteResult {
  const inner = extractFnArgs(problem);
  const isComplex = problem.trim().toLowerCase().startsWith('cfactor') || domain === 'complex';
  return {
    handler: 'algebra',
    args: { operation: 'factor', expression: inner, ...(isComplex ? { complex: true } : {}) },
  };
}

export function extractSimplify(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'algebra', args: { operation: 'simplify', expression: inner } };
}

export function extractExpand(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'algebra', args: { operation: 'expand', expression: inner } };
}

export function extractPartfrac(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  const expression = parts[0] || '';
  const variable = parts[1] || guessVariable(expression);
  return {
    handler: 'algebra',
    args: { operation: 'partial_fractions', expression, variable },
  };
}

// --- Matrix ---

export function extractMatrix(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const matrix = extractMatrixString(problem);

  // Map function name to operation
  const opMap: Record<string, string> = {
    det: 'determinant',
    inv: 'inverse',
    eigenvals: 'eigenvalues',
    eigenvects: 'eigenvectors',
    rref: 'rref',
    rank: 'rank',
    tran: 'transpose',
    ker: 'nullspace',
    qr: 'qr',
    lu: 'lu',
    cholesky: 'cholesky',
    svd: 'svd',
    norm: 'norm_frobenius',
    l1norm: 'norm_1',
    linfnorm: 'norm_inf',
    cond: 'condition_number',
  };

  let operation = 'determinant';
  for (const [fn, op] of Object.entries(opMap)) {
    if (trimmed.startsWith(fn + '(') || trimmed.startsWith(fn + ' (')) {
      operation = op;
      break;
    }
  }

  return { handler: 'matrix', args: { operation, matrix } };
}

// --- Number theory ---

export function extractNumberTheory(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  if (trimmed.startsWith('ifactor')) {
    return {
      handler: 'number_theory',
      args: { operation: 'prime_factorize', number: parseInt(inner, 10) },
    };
  }
  if (trimmed.startsWith('isprime')) {
    return {
      handler: 'number_theory',
      args: { operation: 'analyze', number: parseInt(inner, 10) },
    };
  }
  if (trimmed.startsWith('euler')) {
    return {
      handler: 'number_theory',
      args: { operation: 'analyze', number: parseInt(inner, 10) },
    };
  }
  return {
    handler: 'number_theory',
    args: { operation: 'prime_factorize', number: parseInt(inner, 10) },
  };
}

// --- Combinatorics ---

export function extractCombinatorics(problem: string): RouteResult {
  const trimmed = problem.trim();

  // C(n,k) or comb(n,k)
  const combMatch = trimmed.match(/^[Cc](?:omb)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (combMatch) {
    return {
      handler: 'combinatorics',
      args: {
        operation: 'combinations',
        n: parseInt(combMatch[1], 10),
        k: parseInt(combMatch[2], 10),
      },
    };
  }

  // P(n,k) or perm(n,k)
  const permMatch = trimmed.match(/^[Pp](?:erm)?\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (permMatch) {
    return {
      handler: 'combinatorics',
      args: {
        operation: 'permutations',
        n: parseInt(permMatch[1], 10),
        k: parseInt(permMatch[2], 10),
      },
    };
  }

  // Keyword-based: stirling, bell, catalan, derangements, partitions
  const lc = trimmed.toLowerCase();
  const inner = extractFnArgs(problem);
  const numArgs = splitArgs(inner).map((s) => parseInt(s, 10));

  if (lc.includes('stirling')) {
    const kind = lc.includes('first') ? 'stirling_first' : 'stirling_second';
    return { handler: 'combinatorics', args: { operation: kind, n: numArgs[0], k: numArgs[1] } };
  }
  if (lc.includes('bell')) {
    return { handler: 'combinatorics', args: { operation: 'bell_number', n: numArgs[0] } };
  }
  if (lc.includes('catalan')) {
    return { handler: 'combinatorics', args: { operation: 'catalan_number', n: numArgs[0] } };
  }
  if (lc.includes('derangement')) {
    return { handler: 'combinatorics', args: { operation: 'derangements', n: numArgs[0] } };
  }
  if (lc.includes('partition')) {
    return { handler: 'combinatorics', args: { operation: 'partition_count', n: numArgs[0] } };
  }
  if (lc.includes('multinomial')) {
    // `multinomial(5, [2,2,1])` — n first, then the group sizes. Passing the
    // whole flattened arg list as `groups` left n undefined and the group sum
    // NaN, so the handler rejected every call.
    const parts = splitArgs(extractFnArgs(problem));
    const groups = parseNumberList(parts.slice(1).join(','));
    return {
      handler: 'combinatorics',
      args: { operation: 'multinomial', n: numArgs[0], groups: groups.length ? groups : undefined },
    };
  }

  // Default: combinations
  return {
    handler: 'combinatorics',
    args: { operation: 'combinations', n: numArgs[0] || 0, k: numArgs[1] || 0 },
  };
}

// --- Probability ---

export function extractProbability(problem: string): RouteResult {
  // This handler expects structured data, which is hard to extract from a free-form string.
  // We pass the problem to giac_raw as fallback, or try basic parsing.
  const lc = problem.toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // Try to detect distribution and operation
  const distributions = [
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
  ];
  let distribution = 'normal';
  for (const d of distributions) {
    if (lc.includes(d)) {
      distribution = d;
      break;
    }
  }

  const operations = ['pmf', 'pdf', 'cdf', 'expected_value', 'variance', 'quantile'];
  let operation = 'pdf';
  for (const op of operations) {
    if (lc.includes(op)) {
      operation = op;
      break;
    }
  }

  // Try to extract params as key=value pairs or positional
  const params: Record<string, number> = {};
  for (const part of parts) {
    const kvMatch = part.match(/(\w+)\s*=\s*([\d.eE+-]+)/);
    if (kvMatch) {
      params[kvMatch[1]] = parseFloat(kvMatch[2]);
    }
  }

  return {
    handler: 'probability',
    args: { distribution, operation, params, x: params['x'] },
  };
}

// --- Hypothesis testing ---

/**
 * Parses a hypothesis test's arguments into the shape the handler reads.
 *
 * Accepts named arguments — `t_test(data=[1,2,3], mu0=5)` — with `data` and
 * `sample` treated as aliases for `sample1`, and falls back to position:
 * the first list is sample1, a second list is sample2, and a bare number is
 * mu0. Lists of lists become `groups`.
 */
function parseTestArgs(inner: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const aliases: Record<string, string> = {
    data: 'sample1',
    sample: 'sample1',
    alpha: 'significance',
  };
  const positional: unknown[] = [];

  for (const part of splitArgs(inner)) {
    const named = /^\s*([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(part);
    const rawValue = named ? named[2].trim() : part.trim();
    let value: unknown;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = Number(rawValue);
      if (!Number.isFinite(value as number)) continue;
    }
    if (named) out[aliases[named[1]] ?? named[1]] = value;
    else positional.push(value);
  }

  const lists = positional.filter((v): v is number[] => Array.isArray(v));
  const nested = lists.filter((v) => v.every((n) => Array.isArray(n)));
  if (nested.length) out['groups'] = nested.length === 1 ? nested[0] : nested;
  else {
    const flat = lists.filter((v) => v.every((n) => typeof n === 'number'));
    if (flat[0] && out['sample1'] === undefined) out['sample1'] = flat[0];
    if (flat[1] && out['sample2'] === undefined) out['sample2'] = flat[1];
  }
  const scalar = positional.find((v) => typeof v === 'number');
  if (scalar !== undefined && out['mu0'] === undefined) out['mu0'] = scalar;

  return out;
}

export function extractHypothesisTesting(problem: string): RouteResult {
  // Hypothesis testing requires structured data (arrays) that's hard to extract
  // from a free-form string. We'll try to detect the test type and pass through.
  const lc = problem.toLowerCase();

  let test = 'one_sample_t';
  if (lc.includes('two_sample') || lc.includes('two sample')) test = 'two_sample_t';
  else if (lc.includes('paired')) test = 'paired_t';
  else if (lc.includes('anova')) test = 'one_way_anova';
  else if (lc.includes('chi_square_test') || lc.includes('chi square test'))
    test = 'chi_square_independence';

  // hypothesisTestingHandler reads data.sample1/sample2/mu0/groups/
  // contingency_table/significance. This used to fall back to `data: { raw }`,
  // which none of those names match, so every call through compute reported
  // "requires sample1 with at least 2 values" — for a call that supplied it.
  const inner = extractFnArgs(problem);
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to named/positional parsing */
  }

  if (Object.keys(data).length === 0) {
    data = parseTestArgs(inner);
  }

  return { handler: 'hypothesis_testing', args: { test, data } };
}

// --- Geometry ---

/**
 * Picks `name=value` arguments out of a call's argument list.
 *
 * Only the names the caller allows, so a stray `=` cannot invent a field, and
 * only numeric values — every consumer of this today wants a number.
 */
function parseNamedArgs(inner: string, allowed: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of splitArgs(inner)) {
    const match = /^\s*([A-Za-z_]\w*)\s*=\s*(.+)$/.exec(part);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (!allowed.includes(name)) continue;
    const value = Number(rawValue.trim());
    if (Number.isFinite(value)) out[name] = value;
  }
  return out;
}

export function extractGeometry(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  const opMap: Record<string, string> = {
    distance: 'distance',
    midpoint: 'midpoint',
    slope: 'slope',
    area_triangle: 'area_triangle',
    area_polygon: 'area_polygon',
    area_circle: 'area_circle',
    area: 'area_triangle',
    perimeter: 'perimeter_polygon',
    perimeter_polygon: 'perimeter_polygon',
    circumference: 'circumference',
    intersection: 'line_intersection',
    line_intersection: 'line_intersection',
    point_line_distance: 'point_line_distance',
    angle: 'angle_between_lines',
    angle_between_lines: 'angle_between_lines',
  };

  let operation = 'distance';
  for (const [key, op] of Object.entries(opMap)) {
    if (trimmed.startsWith(key + '(') || trimmed.startsWith(key + ' (')) {
      operation = op;
      break;
    }
  }

  const args: Record<string, unknown> = { operation };

  // Named arguments first: `area_circle(radius=2)` and
  // `area_triangle(base=4, height=3)` are the forms the schema advertises.
  // These used to fall into the JSON catch below and land in a `raw` field
  // that geometryHandler does not read, so it reported "requires radius or
  // diameter" for a call that supplied one.
  const named = parseNamedArgs(inner, ['radius', 'diameter', 'base', 'height']);
  Object.assign(args, named);

  if (Object.keys(named).length === 0) {
    try {
      const parsed: unknown = JSON.parse(`[${inner}]`);
      if (Array.isArray(parsed)) {
        if (operation === 'area_circle' || operation === 'circumference') {
          args['radius'] = parsed[0];
        } else if (
          operation === 'area_triangle' &&
          parsed.length === 2 &&
          parsed.every((n) => typeof n === 'number')
        ) {
          // Two bare numbers for a triangle are base and height, not points.
          args['base'] = parsed[0];
          args['height'] = parsed[1];
        } else if (operation === 'angle_between_lines' || operation === 'line_intersection') {
          args['line1'] = parsed[0];
          args['line2'] = parsed[1];
        } else {
          args['points'] = parsed;
        }
      }
    } catch {
      /* leave the handler to report what it needs */
    }
  }

  return { handler: 'geometry', args };
}

// --- Numerical methods ---

export function extractNumericalMethods(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  const methodMap: Record<string, string> = {
    newton: 'newton_raphson',
    newton_raphson: 'newton_raphson',
    bisection: 'bisection',
    secant: 'secant',
    romberg: 'romberg_integration',
    simpson: 'numerical_integration',
  };

  let method = 'newton_raphson';
  for (const [key, m] of Object.entries(methodMap)) {
    if (trimmed.startsWith(key + '(') || trimmed.startsWith(key + ' (')) {
      method = m;
      break;
    }
  }

  return {
    handler: 'numerical_methods',
    args: {
      method,
      expression: parts[0] || '',
      variable: parts[1] || 'x',
      ...(parts[2] ? { initial_guess: parseFloat(parts[2]) } : {}),
    },
  };
}

// --- Exact value ---

export function extractExactValue(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  let operation = 'to_exact';
  if (trimmed.startsWith('to_decimal')) operation = 'to_decimal';
  else if (trimmed.startsWith('simplify_fraction')) operation = 'simplify_fraction';

  // `value` is the field exactValueHandler reads; emitting `expression` meant
  // to_exact/to_decimal/simplify_fraction crashed on `undefined`.
  return { handler: 'exact_value', args: { operation, value: inner } };
}

// --- Linear regression ---

export function extractLinearRegression(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // linearRegressionHandler reads x, y, model and degree. This used to emit a
  // bare array for the JSON form and `{ raw: parts }` otherwise, so `x.length`
  // dereferenced undefined for every input.
  const args: Record<string, unknown> = {};

  // An explicit object argument wins — it can already name x/y/model/degree.
  try {
    const parsed: unknown = JSON.parse(inner);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { handler: 'linear_regression', args: parsed as Record<string, unknown> };
    }
  } catch {
    /* not an object literal */
  }

  const points = parsePointPairs(expressionArg(parts[0]));
  if (points) {
    args['x'] = points.map((point) => point[0]);
    args['y'] = points.map((point) => point[1]);
  }

  // `linear_regression([[..]], [[..]])` — separate x and y lists.
  if (!points && parts.length >= 2) {
    const xs = parseNumberList(parts[0]);
    const ys = parseNumberList(parts[1]);
    if (xs.length && ys.length) {
      args['x'] = xs;
      args['y'] = ys;
    }
  }

  if (trimmed.startsWith('polynomial_regression') || trimmed.includes('polynomial')) {
    args['model'] = 'polynomial';
    const degree = Number(parts[parts.length - 1]);
    if (Number.isInteger(degree) && degree > 0) args['degree'] = degree;
  }

  return { handler: 'linear_regression', args };
}

/** `[[1,2],[2,4]]` as a list of (x, y) pairs, or null if it is not that shape. */
function parsePointPairs(arg: string | undefined): [number, number][] | null {
  const trimmed = (arg || '').trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (pair) =>
          Array.isArray(pair) &&
          pair.length === 2 &&
          pair.every((n) => typeof n === 'number' && Number.isFinite(n))
      )
    ) {
      return parsed as [number, number][];
    }
  } catch {
    /* not point pairs */
  }
  return null;
}

// --- Sequence identify ---

/**
 * A flat list of numeric samples, or null if the argument is not one.
 *
 * Accepts both `fft([1,2,3])` and `fft(1,2,3)`. The bracketed form must not be
 * wrapped again — `JSON.parse('[' + '[1,2,3]' + ']')` yields `[[1,2,3]]`, one
 * level too deep for the handler.
 */
function parseSampleList(inner: string): number[] | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;
  const source = trimmed.startsWith('[') ? trimmed : `[${trimmed}]`;
  try {
    const parsed: unknown = JSON.parse(source);
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((n) => typeof n === 'number' && Number.isFinite(n))
    ) {
      return parsed as number[];
    }
  } catch {
    /* not a sample list */
  }
  return null;
}

export function extractSequenceIdentify(problem: string): RouteResult {
  // Same parser as fourier: `JSON.parse('[' + '[1,2,3]' + ']')` yields
  // [[1,2,3]], so the bracketed form used to arrive as one element and the
  // arity guard then blamed the user for supplying one term.
  const terms = parseSampleList(extractFnArgs(problem)) ?? [];
  return { handler: 'sequence_identify', args: { terms } };
}

// --- Number properties ---

export function extractNumberProperties(problem: string): RouteResult {
  const inner = extractFnArgs(problem);
  return { handler: 'number_properties', args: { number: parseInt(inner, 10) } };
}

// --- Quick calc ---

export function extractQuickCalc(problem: string): RouteResult {
  return { handler: 'quick_calc', args: { expression: problem.trim() } };
}

// --- Fourier ---

export function extractFourier(problem: string): RouteResult {
  const trimmed = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);

  // `mode` and `data` are the names fourierTransformHandler reads, and it
  // compares mode against 'fft'/'ifft'. This used to emit `signal` and
  // 'forward'/'inverse', so every field missed and the handler crashed on
  // `data.length` for every input — `fft([1,2,3,4])` included.
  const mode: 'fft' | 'ifft' =
    trimmed.startsWith('ifft') || trimmed.startsWith('inverse') ? 'ifft' : 'fft';

  // No `data` is what makes the handler explain itself; there is no consumer
  // for the raw argument, so passing it along would be another phantom field.
  const data = parseSampleList(inner);
  return { handler: 'fourier', args: data ? { mode, data } : { mode } };
}

// --- Giac raw (fallback) ---

export function extractGiacRaw(problem: string): RouteResult {
  // C(n,k)/P(n,k) notation reaches this fallback when it appears inside a
  // compound expression — rewrite it to Giac-native comb()/perm().
  return { handler: 'giac_raw', args: { expression: rewriteCombinatorics(problem.trim()) } };
}

// --- Multivariable ---

/** Parse a "[a, b, c]" bracket list into trimmed elements (paren/bracket-aware via splitArgs). */
function parseBracketList(s: string): string[] {
  return splitArgs(s.trim().replace(/^\[/, '').replace(/\]$/, ''));
}

/**
 * Drops a leading `name =` label from an expression argument.
 *
 * `gradient(f = x*y, [x,y])` names its argument; the expression to operate on
 * is `x*y`, not `f = x*y`. Handlers that receive the label pass it to Giac
 * whole and produce confident nonsense (`grad(f = x*y)` -> `[0,0]=[y,x]`).
 * Only fires on a bare identifier followed by `=`, so real equations and
 * comparisons are untouched.
 */
function expressionArg(arg: string | undefined): string {
  return (arg || '').replace(/^\s*[A-Za-z_]\w*\s*=\s*(?!=)/, '');
}

export function extractMultivariable(problem: string): RouteResult {
  const trimmed = problem.trim();
  const lc = trimmed.toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);
  parts[0] = expressionArg(parts[0]);

  // Multiple integrals.
  if (lc.startsWith('iint') || lc.startsWith('iiint')) {
    const expression = parts[0] || '';
    const bounds: { variable: string; lower: string; upper: string }[] = [];
    for (let i = 1; i + 2 < parts.length; i += 3) {
      bounds.push({ variable: parts[i], lower: parts[i + 1], upper: parts[i + 2] });
    }
    return {
      handler: 'multivariable',
      args: { operation: 'multiple_integral', expression, bounds },
    };
  }
  if (/int\s*\(\s*int\s*\(/i.test(trimmed)) {
    return { handler: 'multivariable', args: { operation: 'multiple_integral', raw: trimmed } };
  }

  // Vector / differential operators.
  if (lc.startsWith('gradient') || lc.startsWith('grad')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'gradient',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('hessian')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'hessian',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('jacobian')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'jacobian',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('divergence') || lc.startsWith('div')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'divergence',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('curl')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'curl',
        functions: parseBracketList(parts[0] || ''),
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('partial')) {
    return {
      handler: 'multivariable',
      args: { operation: 'partial', expression: parts[0] || '', variables: parts.slice(1) },
    };
  }

  // Optimization.
  if (lc.startsWith('critical_points')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'critical_points',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
      },
    };
  }
  if (lc.startsWith('lagrange')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'lagrange',
        expression: parts[0] || '',
        constraint: parts[1] || '',
        value: parts[2] || '0',
        variables: parseBracketList(parts[3] || ''),
      },
    };
  }
  if (lc.startsWith('tangent_plane')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'tangent_plane',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
        point: parseBracketList(parts[2] || ''),
      },
    };
  }
  if (lc.startsWith('directional_derivative')) {
    return {
      handler: 'multivariable',
      args: {
        operation: 'directional_derivative',
        expression: parts[0] || '',
        variables: parseBracketList(parts[1] || ''),
        point: parseBracketList(parts[2] || ''),
        direction: parseBracketList(parts[3] || ''),
      },
    };
  }

  return { handler: 'giac_raw', args: { expression: trimmed } };
}

// --- 3D geometry ---

const GEOMETRY3D_OPS = [
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
  'volume_parallelepiped',
];

/** Parse a bracket list "[a, b, c]" into a number array (reuses parseBracketList). */
function parseNumberList(s: string): number[] {
  return parseBracketList(s).map(Number);
}

export function extractGeometry3d(problem: string): RouteResult {
  const lc = problem.trim().toLowerCase();
  const inner = extractFnArgs(problem);
  const parts = splitArgs(inner);

  // Router already guarantees the input starts with exactly `<name>(`, and no op name
  // is a prefix of another, so a bare startsWith is unambiguous here.
  const operation = GEOMETRY3D_OPS.find((name) => lc.startsWith(name)) ?? '';

  const lists: number[][] = [];
  let scalar: number | undefined;
  for (const part of parts) {
    if (part.trim().startsWith('[')) lists.push(parseNumberList(part));
    else if (scalar === undefined && part.trim() !== '') scalar = Number(part);
  }

  return {
    handler: 'geometry3d',
    args: { operation, lists, ...(scalar !== undefined ? { scalar } : {}) },
  };
}
