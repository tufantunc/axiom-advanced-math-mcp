/**
 * Golden corpus seeded from observed benchmark regressions.
 * Each new tool-level or grader-level regression must be added here
 * before the corresponding fix is merged.
 */

export interface GraderCase {
  description: string;
  ground: string;
  candidate: string; // what the model produced (or what we want grader to accept)
  shouldMatch: boolean;
}

export const GRADER_CASES: GraderCase[] = [
  {
    description: 'fraction LaTeX vs plain (regression #45 from 2026-04-08)',
    ground: '-\\frac{82}{27}',
    candidate: '-82/27',
    shouldMatch: true,
  },
  {
    description: 'integer vs fraction (regression #28 CAS — 16/3 was extracted as 8)',
    ground: '16/3',
    candidate: '16/3',
    shouldMatch: true,
  },
  {
    description: 'set order-insensitive',
    ground: '\\{1, 2, 3\\}',
    candidate: '\\{3, 1, 2\\}',
    shouldMatch: true,
  },
  {
    description: 'interval vs conditional (regression #3 MATH L5 — x>=11/2)',
    ground: '\\frac{11}{2}',
    candidate: 'x = 11/2',
    shouldMatch: false,
  },
  {
    description: 'conditional vs interval — half-line',
    ground: '[\\frac{11}{2}, \\infty)',
    candidate: 'x >= 11/2',
    shouldMatch: true,
  },
  {
    description: 'symbolic equivalence — derivative product rule',
    ground: '2*x*sin(x)+x^2*cos(x)',
    candidate: 'cos(x)*x^2+sin(x)*2*x',
    shouldMatch: true,
  },
];

export interface ToolCase {
  description: string;
  giacInput: string;
  expectedContains: string[];
}

export const TOOL_CASES: ToolCase[] = [
  {
    description: '|5x-1|=|3x+2| should give two solutions',
    giacInput: 'solve(abs(5*x - 1) = abs(3*x + 2), x)',
    expectedContains: ['-1/8', '3/2'],
  },
  {
    description: 'derivative of x^3',
    giacInput: 'diff(x^3, x)',
    expectedContains: ['3*x^2'],
  },
  {
    description: 'definite integral of sqrt(x) on [0, 4]',
    giacInput: 'int(sqrt(x), x, 0, 4)',
    expectedContains: ['16/3'],
  },
  {
    description: 'remainder polynomial division',
    giacInput: 'rem(3*y^4 - 4*y^3 + 5*y^2 - 13*y + 4, 3*y - 2, y)',
    expectedContains: ['-82/27'],
  },
];
