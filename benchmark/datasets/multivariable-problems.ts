/**
 * Multivariable calculus (M1) + 3D geometry (M2) benchmark slice.
 *
 * Measures the lift the M1/M2 `compute` verbs give over a tool-free baseline.
 * Inline (no HuggingFace fetch) — there is no off-the-shelf dataset that
 * targets these exact capabilities.
 *
 * Same shape as cas-problems.ts so it plugs into the existing runner:
 * - problem:      natural-language question
 * - answer:       expected result (grader-compatible: normalized symbolic/numeric)
 * - category:     for per-category breakdown reporting
 * - compute_hint: the ideal `compute` call (what a tool-using model should send)
 *
 * NOTE on grading: scalar-answer categories (vector-calculus divergence,
 * vectors-3d dot/norm/angle/distance, planes-lines-3d, volumes-3d, optimization
 * values, multiple-integrals) grade cleanly via symbolic equivalence. Categories
 * whose natural answer is a vector/matrix/point (gradient, curl, hessian,
 * jacobian, cross, midpoint, plane coefficients) depend on the grader's
 * list/matrix tolerance — read the per-category breakdown accordingly.
 */

export interface MultivarProblem {
  problem: string;
  answer: string;
  category: string;
  compute_hint: string;
}

const MULTIVAR_PROBLEMS: MultivarProblem[] = [
  // ═══════════════════════════════════════════════════════════════════════
  // M1 — Multivariable derivatives (gradient, partials, hessian, jacobian)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the gradient of f(x, y, z) = x^2 + y^2 + z^2.',
    answer: '[2*x, 2*y, 2*z]',
    category: 'multivariable-derivatives',
    compute_hint: 'gradient(x^2+y^2+z^2, [x, y, z])',
  },
  {
    problem: 'Find the gradient of f(x, y, z) = x*y*z.',
    answer: '[y*z, x*z, x*y]',
    category: 'multivariable-derivatives',
    compute_hint: 'gradient(x*y*z, [x, y, z])',
  },
  {
    problem: 'Compute the mixed second partial derivative of f(x, y) = x^2*y^3 with respect to x then y.',
    answer: '6*x*y^2',
    category: 'multivariable-derivatives',
    compute_hint: 'partial(x^2*y^3, x, y)',
  },
  {
    problem: 'Compute the second partial derivative of f(x, y) = x^3*y^2 with respect to x twice.',
    answer: '6*x*y^2',
    category: 'multivariable-derivatives',
    compute_hint: 'partial(x^3*y^2, x, x)',
  },
  {
    problem: 'Find the Hessian matrix of f(x, y) = x^2 + x*y + y^2.',
    answer: '[[2,1],[1,2]]',
    category: 'multivariable-derivatives',
    compute_hint: 'hessian(x^2+x*y+y^2, [x, y])',
  },
  {
    problem: 'Find the Jacobian matrix of F(x, y) = (x*y, x + y).',
    answer: '[[y,x],[1,1]]',
    category: 'multivariable-derivatives',
    compute_hint: 'jacobian([x*y, x+y], [x, y])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M1 — Vector calculus (divergence, curl)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the divergence of the vector field F = (x, y, z).',
    answer: '3',
    category: 'vector-calculus',
    compute_hint: 'divergence([x, y, z], [x, y, z])',
  },
  {
    problem: 'Find the divergence of the vector field F = (x^2, y^2, z^2).',
    answer: '2*x+2*y+2*z',
    category: 'vector-calculus',
    compute_hint: 'divergence([x^2, y^2, z^2], [x, y, z])',
  },
  {
    problem: 'Find the curl of the vector field F = (y, -x, 0).',
    answer: '[0, 0, -2]',
    category: 'vector-calculus',
    compute_hint: 'curl([y, -x, 0], [x, y, z])',
  },
  {
    problem: 'Find the curl of the vector field F = (0, 0, x^2 + y^2).',
    answer: '[2*y, -2*x, 0]',
    category: 'vector-calculus',
    compute_hint: 'curl([0, 0, x^2+y^2], [x, y, z])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M1 — Multiple integrals
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Evaluate the double integral of x*y over the rectangle [0,1] x [0,2].',
    answer: '1',
    category: 'multiple-integrals',
    compute_hint: 'iint(x*y, x, 0, 1, y, 0, 2)',
  },
  {
    problem: 'Evaluate the double integral of (x + y) over the unit square [0,1] x [0,1].',
    answer: '1',
    category: 'multiple-integrals',
    compute_hint: 'iint(x+y, x, 0, 1, y, 0, 1)',
  },
  {
    problem: 'Evaluate the triple integral of 1 over the unit cube [0,1]^3 (i.e. its volume).',
    answer: '1',
    category: 'multiple-integrals',
    compute_hint: 'iiint(1, x, 0, 1, y, 0, 1, z, 0, 1)',
  },
  {
    problem: 'Evaluate the triple integral of x over the box [0,2] x [0,1] x [0,1].',
    answer: '2',
    category: 'multiple-integrals',
    compute_hint: 'iiint(x, x, 0, 2, y, 0, 1, z, 0, 1)',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M1 — Optimization (critical points, Lagrange, tangent plane, directional)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Classify the critical point of f(x, y) = x^2 + y^2. Is it a minimum, maximum, or saddle?',
    answer: 'minimum',
    category: 'optimization',
    compute_hint: 'critical_points(x^2+y^2, [x, y])',
  },
  {
    problem: 'Classify the critical point of f(x, y) = x^2 - y^2. Is it a minimum, maximum, or saddle?',
    answer: 'saddle',
    category: 'optimization',
    compute_hint: 'critical_points(x^2-y^2, [x, y])',
  },
  {
    problem: 'Using Lagrange multipliers, find the maximum value of f(x, y) = x*y subject to x + y = 1.',
    answer: '1/4',
    category: 'optimization',
    compute_hint: 'lagrange(x*y, x+y, 1, [x, y])',
  },
  {
    problem: 'Using Lagrange multipliers, find the minimum value of f(x, y) = x^2 + y^2 subject to x + y = 2.',
    answer: '2',
    category: 'optimization',
    compute_hint: 'lagrange(x^2+y^2, x+y, 2, [x, y])',
  },
  {
    problem: 'Find the equation of the tangent plane to z = x^2 + y^2 at the point (1, 1).',
    answer: '2*x+2*y-2',
    category: 'optimization',
    compute_hint: 'tangent_plane(x^2+y^2, [x, y], [1, 1])',
  },
  {
    problem: 'Find the directional derivative of f(x, y) = x^2 + y^2 at (1, 1) in the direction (1, 0).',
    answer: '2',
    category: 'optimization',
    compute_hint: 'directional_derivative(x^2+y^2, [x, y], [1, 1], [1, 0])',
  },
  {
    problem: 'Find the directional derivative of f(x, y) = x*y at (1, 2) in the direction (1, 0).',
    answer: '2',
    category: 'optimization',
    compute_hint: 'directional_derivative(x*y, [x, y], [1, 2], [1, 0])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M2 — 3D vectors (distance, midpoint, dot, cross, norm, angle)
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the distance between the 3D points (0, 0, 0) and (2, 3, 6).',
    answer: '7',
    category: 'vectors-3d',
    compute_hint: 'distance3d([0,0,0], [2,3,6])',
  },
  {
    problem: 'Find the distance between the 3D points (1, 2, 3) and (4, 6, 3).',
    answer: '5',
    category: 'vectors-3d',
    compute_hint: 'distance3d([1,2,3], [4,6,3])',
  },
  {
    problem: 'Find the midpoint of the segment from (0, 0, 0) to (2, 4, 6).',
    answer: '[1, 2, 3]',
    category: 'vectors-3d',
    compute_hint: 'midpoint3d([0,0,0], [2,4,6])',
  },
  {
    problem: 'Compute the dot product of the vectors (1, 2, 3) and (4, 5, 6).',
    answer: '32',
    category: 'vectors-3d',
    compute_hint: 'dot([1,2,3], [4,5,6])',
  },
  {
    problem: 'Compute the dot product of the vectors (1, 0, -1) and (2, 3, 4).',
    answer: '-2',
    category: 'vectors-3d',
    compute_hint: 'dot([1,0,-1], [2,3,4])',
  },
  {
    problem: 'Compute the cross product of (1, 0, 0) and (0, 1, 0).',
    answer: '[0, 0, 1]',
    category: 'vectors-3d',
    compute_hint: 'cross([1,0,0], [0,1,0])',
  },
  {
    problem: 'Compute the cross product of (2, 0, 0) and (0, 3, 0).',
    answer: '[0, 0, 6]',
    category: 'vectors-3d',
    compute_hint: 'cross([2,0,0], [0,3,0])',
  },
  {
    problem: 'Find the magnitude (norm) of the vector (2, 3, 6).',
    answer: '7',
    category: 'vectors-3d',
    compute_hint: 'vector_norm([2,3,6])',
  },
  {
    problem: 'Find the angle in degrees between the vectors (1, 0, 0) and (0, 1, 0).',
    answer: '90',
    category: 'vectors-3d',
    compute_hint: 'angle_vectors([1,0,0], [0,1,0])',
  },
  {
    problem: 'Find the angle in degrees between the vectors (1, 1, 0) and (1, 0, 0).',
    answer: '45',
    category: 'vectors-3d',
    compute_hint: 'angle_vectors([1,1,0], [1,0,0])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M2 — Planes and lines in 3D
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the plane (ax + by + cz + d = 0) through the points (0,0,0), (1,0,0), (0,1,0).',
    answer: '[0, 0, 1, 0]',
    category: 'planes-lines-3d',
    compute_hint: 'plane_from_points([0,0,0], [1,0,0], [0,1,0])',
  },
  {
    problem: 'Find the distance from the point (0, 0, 5) to the plane z = 0 (i.e. 0x + 0y + 1z + 0 = 0).',
    answer: '5',
    category: 'planes-lines-3d',
    compute_hint: 'point_plane_distance([0,0,5], [0,0,1,0])',
  },
  {
    problem: 'Find where the line through (0,0,-1) with direction (0,0,1) meets the plane z = 0.',
    answer: '[0, 0, 0]',
    category: 'planes-lines-3d',
    compute_hint: 'line_plane_intersection([0,0,-1], [0,0,1], [0,0,1,0])',
  },
  {
    problem: 'Find the angle in degrees between the planes z = 0 and y = 0.',
    answer: '90',
    category: 'planes-lines-3d',
    compute_hint: 'plane_plane_angle([0,0,1,0], [0,1,0,0])',
  },
  {
    problem: 'Find the distance between the skew lines: line 1 through (0,0,0) along (1,0,0), and line 2 through (0,0,1) along (0,1,0).',
    answer: '1',
    category: 'planes-lines-3d',
    compute_hint: 'line_line_distance([0,0,0], [1,0,0], [0,0,1], [0,1,0])',
  },

  // ═══════════════════════════════════════════════════════════════════════
  // M2 — Volumes
  // ═══════════════════════════════════════════════════════════════════════
  {
    problem: 'Find the volume of the tetrahedron with vertices (0,0,0), (1,0,0), (0,1,0), (0,0,1).',
    answer: '1/6',
    category: 'volumes-3d',
    compute_hint: 'volume_tetrahedron([0,0,0], [1,0,0], [0,1,0], [0,0,1])',
  },
  {
    problem: 'Find the volume of a sphere of radius 3 (leave the answer in terms of pi).',
    answer: '36*pi',
    category: 'volumes-3d',
    compute_hint: 'volume_sphere(3)',
  },
  {
    problem: 'Find the volume of the parallelepiped spanned by the vectors (1,0,0), (0,1,0), (0,0,1).',
    answer: '1',
    category: 'volumes-3d',
    compute_hint: 'volume_parallelepiped([1,0,0], [0,1,0], [0,0,1])',
  },
];

export function loadMultivar(limit: number): MultivarProblem[] {
  if (limit <= 0) return [];
  return MULTIVAR_PROBLEMS.slice(0, Math.min(limit, MULTIVAR_PROBLEMS.length));
}
