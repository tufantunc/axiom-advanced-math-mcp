import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeHandler } from '../src/server/tools/compute/index.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Every operation name a handler dispatches on, and a call that exercises it.
 *
 * The seam these cover: each handler is unit-tested by calling it directly with
 * its own field names, and the router is tested on the *short* spellings, so a
 * published operation name that no routing rule claims is invisible to both.
 * Nine of them fell through to the raw CAS, which returns an unknown call
 * unevaluated — so `bell_number(5)` answered "bell_number(5)", isError:false.
 * The input came back as its own answer and 934 tests stayed green.
 *
 * Values are hand-computed, not captured from the implementation: `chi_square`
 * passed its arguments to Giac's density in the wrong order and answered
 * 0.1116 (the density of χ²(2) at 3) for a query about χ²(3) at 2, which is
 * 0.2076. A recorded-output assertion would have pinned the wrong number.
 */
const PROBES: Record<string, { call: string; expect: RegExp }> = {
  // combinatorics
  bell_number: { call: 'bell_number(5)', expect: /^Result: 52$/m },
  catalan_number: { call: 'catalan_number(5)', expect: /^Result: 42$/m },
  combinations: { call: 'combinations(10,3)', expect: /^Result: 120$/m },
  derangements: { call: 'derangements(5)', expect: /^Result: 44$/m },
  multinomial: { call: 'multinomial(5,[2,2,1])', expect: /^Result: 30$/m },
  partition_count: { call: 'partition_count(5)', expect: /^Result: 7$/m },
  permutations: { call: 'permutations(10,3)', expect: /^Result: 720$/m },
  stirling_first: { call: 'stirling_first(5,2)', expect: /^Result: 50$/m },
  stirling_second: { call: 'stirling_second(5,2)', expect: /^Result: 15$/m },

  // geometry — x+y=0 and x−y=0 meet at right angles; x+y=2 and x−y=0 at (1,1)
  angle_between_lines: { call: 'angle_between_lines([1,1,0],[1,-1,0])', expect: /90°/ },
  line_intersection: { call: 'line_intersection([1,1,-2],[1,-1,0])', expect: /\(1, 1\)/ },
  area_circle: { call: 'area_circle(radius=2)', expect: /12\.566/ },
  area_polygon: { call: 'area_polygon([[0,0],[4,0],[4,3],[0,3]])', expect: /^Result: 12$/m },
  area_triangle: { call: 'area_triangle(base=4, height=3)', expect: /^Result: 6$/m },
  circumference: { call: 'circumference(2)', expect: /12\.566/ },
  distance: { call: 'distance([0,0],[3,4])', expect: /^Result: 5$/m },
  midpoint: { call: 'midpoint([0,0],[4,4])', expect: /\(2, 2\)/ },
  perimeter_polygon: {
    call: 'perimeter_polygon([[0,0],[4,0],[4,3],[0,3]])',
    expect: /^Result: 14$/m,
  },
  point_line_distance: { call: 'point_line_distance([0,0],[3,4,-5])', expect: /^Result: 1$/m },
  slope: { call: 'slope([0,0],[2,4])', expect: /^Result: 2$/m },

  // numerical methods — all four converge on √2
  bisection: { call: 'bisection(x^2-2, 1, 2)', expect: /^Root: x = 1\.41421356/m },
  newton_raphson: { call: 'newton_raphson(x^2-2, x, 1)', expect: /^Root: x = 1\.41421356/m },
  secant: { call: 'secant(x^2-2, 1, 2)', expect: /^Root: x = 1\.41421356/m },
  numerical_integration: { call: 'numerical_integration(x^2, x, 0, 1)', expect: /0\.3333/ },
  romberg_integration: { call: 'romberg_integration(x^2, x, 0, 1)', expect: /0\.3333/ },

  // probability — densities computed by hand from each definition
  beta: { call: 'beta(alpha=2,beta=3,x=0.5)', expect: /f\(0\.5\) = 1\.5/ },
  binomial: { call: 'binomial(n=10,p=0.5,k=5)', expect: /0\.2460937/ },
  chi_square: { call: 'chi_square(df=3,x=2)', expect: /f\(2\) = 0\.207553/ },
  exponential: { call: 'exponential(lambda=1,x=1)', expect: /0\.367879/ },
  f_distribution: { call: 'f_distribution(df1=2,df2=6,x=2)', expect: /f\(2\) = 0\.1296/ },
  geometric: { call: 'geometric(p=0.5,k=3)', expect: /0\.125/ },
  hypergeometric: { call: 'hypergeometric(N=50,K=5,n=10,k=2)', expect: /0\.209839/ },
  normal: { call: 'normal(mu=0,sigma=1,x=1)', expect: /f\(1\) = 0\.241970/ },
  poisson: { call: 'poisson(lambda=2,k=3)', expect: /0\.180447/ },
  student_t: { call: 'student_t(df=5,x=2)', expect: /f\(2\) = 0\.0650903/ },

  // 3D geometry
  angle_vectors: { call: 'angle_vectors([1,0,0],[0,1,0])', expect: /90/ },
  cross: { call: 'cross([1,0,0],[0,1,0])', expect: /\[0, ?0, ?1\]|0,0,1/ },
  distance3d: { call: 'distance3d([0,0,0],[1,1,1])', expect: /1\.732/ },
  dot: { call: 'dot([1,2,3],[4,5,6])', expect: /\b32\b/ },
  midpoint3d: { call: 'midpoint3d([0,0,0],[2,2,2])', expect: /\(1, 1, 1\)|1, ?1, ?1/ },
  vector_norm: { call: 'vector_norm([3,4,0])', expect: /^Result: 5$/m },
  line_line_distance: {
    call: 'line_line_distance([0,0,0],[1,0,0],[0,1,0],[0,0,1])',
    expect: /\d/,
  },
  line_plane_intersection: {
    call: 'line_plane_intersection([0,0,0],[0,0,1],[0,0,1,-5])',
    expect: /\d/,
  },
  plane_from_points: { call: 'plane_from_points([0,0,0],[1,0,0],[0,1,0])', expect: /z/ },
  plane_plane_angle: { call: 'plane_plane_angle([1,0,0,0],[0,1,0,0])', expect: /90/ },
  point_plane_distance: { call: 'point_plane_distance([0,0,0],[1,0,0,-5])', expect: /\b5\b/ },
  volume_parallelepiped: {
    call: 'volume_parallelepiped([1,0,0],[0,1,0],[0,0,1])',
    expect: /^Result: 1$/m,
  },
  volume_sphere: { call: 'volume_sphere(2)', expect: /33\.51/ },
  volume_tetrahedron: {
    call: 'volume_tetrahedron([0,0,0],[1,0,0],[0,1,0],[0,0,1])',
    expect: /0\.1666|1\/6/,
  },

  // exact values
  simplify_fraction: { call: 'simplify_fraction(4/8)', expect: /1\/2/ },
  to_decimal: { call: 'to_decimal(1/3)', expect: /0\.333/ },
  to_exact: { call: 'to_exact(0.5)', expect: /1\/2/ },

  // algebra
  expand: { call: 'expand((x+1)^3)', expect: /x\^3/ },
  factor: { call: 'factor(x^2-4)', expect: /^Result: \(x-2\)\*\(x\+2\)$/m },
  partial_fractions: { call: 'partial_fractions(1/(x^2-1))', expect: /x-1|x\+1/ },
  simplify: { call: 'simplify((x^2-1)/(x-1))', expect: /^Result: x\+1$/m },

  // calculus
  differentiate: { call: 'differentiate(x^3, x)', expect: /3\*x\^2/ },
  integrate: { call: 'integrate(x^2, x, 0, 1)', expect: /1\/3/ },
  limit: { call: 'limit(sin(x)/x, x, 0)', expect: /^Result: 1$/m },
  solve_ode: { call: "solve_ode(y'=x, y)", expect: /x|c_0/ },
  taylor: { call: 'taylor(exp(x), x=0, 5)', expect: /x\^2/ },

  // hypothesis testing
  chi_square_independence: {
    call: 'chi_square_independence([[10,20],[30,40]])',
    expect: /^χ² = 0\.793651$/m,
  },
  one_sample_t: {
    call: 'one_sample_t(mu0=5, data=[1,2,3,4,5])',
    expect: /^t-statistic = -2\.828427$/m,
  },
  one_way_anova: { call: 'one_way_anova([1,2,3],[4,5,6],[7,8,9])', expect: /^F = 27\.000000$/m },
  paired_t: { call: 'paired_t([10,12,14],[12,15,16])', expect: /^t-statistic = -7\.000000$/m },
  two_sample_t: { call: 'two_sample_t([1,2,3],[4,5,6])', expect: /^t-statistic = -3\.674235$/m },
};

/**
 * The files whose `case '<name>'` labels ARE operation names. Deliberately a
 * list and not a directory walk: dispatcher.ts and normalize.ts also switch on
 * string literals, and those are handler names and output shapes, not
 * operations a caller can ask for.
 */
const HANDLER_FILES = [
  'src/server/tools/algebra.ts',
  'src/server/tools/calculus.ts',
  'src/server/tools/combinatorics.ts',
  'src/server/tools/exact-value.ts',
  'src/server/tools/geometry.ts',
  'src/server/tools/hypothesis-testing.ts',
  'src/server/tools/numerical-methods.ts',
  'src/server/tools/probability-calc.ts',
  'src/server/tools/geometry3d/planes.ts',
  'src/server/tools/geometry3d/vectors.ts',
  'src/server/tools/geometry3d/volumes.ts',
];

function declaredOperations(): string[] {
  const names = new Set<string>();
  for (const file of HANDLER_FILES) {
    const source = readFileSync(path.join(repoRoot, file), 'utf8');
    for (const m of source.matchAll(/case '([a-z][a-z0-9_]*)':/g)) names.add(m[1]);
  }
  return [...names].sort();
}

describe('operation coverage', () => {
  // Without this the table silently stops covering new work: an operation added
  // to a handler with no routing rule is exactly the bug above, and a probe
  // table that has to be updated by hand would not have caught it.
  it('probes every operation its handlers dispatch on', () => {
    const missing = declaredOperations().filter((op) => !(op in PROBES));
    expect(
      missing,
      `add a probe (and a routing rule if needed) for: ${missing.join(', ')}`
    ).toEqual([]);
  });

  it('probes nothing that no handler dispatches on', () => {
    const declared = new Set(declaredOperations());
    const stale = Object.keys(PROBES).filter((op) => !declared.has(op));
    expect(stale, `these probes name operations no handler has: ${stale.join(', ')}`).toEqual([]);
  });

  it('finds enough operations to be a real check', () => {
    // Guards the scan itself: a regex that stopped matching would empty both
    // lists above and leave all three tests green.
    expect(declaredOperations().length).toBeGreaterThan(50);
  });

  it.each(Object.entries(PROBES).map(([op, p]) => [op, p.call, p.expect] as const))(
    '%s answers',
    async (_op, call, expected) => {
      const r = await computeHandler({ problem: call });
      const text = r.content.map((c) => c.text).join('\n');

      expect(r.isError, `${call} errored: ${text}`).toBe(false);

      // Several handlers return validation failures as ordinary output lines,
      // so isError alone cannot see them.
      expect(text, call).not.toMatch(/(^|: )Error:/m);

      // An unclaimed call comes back from the CAS unevaluated, which means the
      // response contains the problem verbatim as its own answer.
      const answer = text
        .split('\n')
        .filter((l) => !l.startsWith('Command: '))
        .join('\n');
      expect(answer, `${call} was returned as its own answer`).not.toContain(call);

      expect(answer, `${call} -> ${text}`).toMatch(expected);
    }
  );
});

describe('a malformed call is reported as a failure, not an answer', () => {
  // These handlers signal validation failures by returning a single
  // `Error: ...` line, which the response formatter shipped with
  // isError:false — so the failure text arrived as "The answer is ...".
  it.each([
    ['beta(a=2,b=3,x=0.5)', /requires params alpha and beta/],
    ['chi_square(x=2)', /requires param df/],
    ['t_test(data=[1])', /at least 2 values/],
  ])('%s', async (problem, expected) => {
    const r = await computeHandler({ problem });
    const text = r.content.map((c) => c.text).join('\n');
    expect(r.isError, `${problem} was reported as success: ${text}`).toBe(true);
    expect(text).toMatch(expected);
  });
});
