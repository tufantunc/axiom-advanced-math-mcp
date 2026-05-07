import { describe, it, expect } from 'vitest';
import { gradeV2, gradeV2Async } from '../benchmark/graders/grader-v2.js';

describe('gradeV2 — early stages', () => {
  it('exact match', () => {
    const r = gradeV2('42', '42');
    expect(r.match).toBe(true);
    expect(r.method).toBe('exact');
  });

  it('normalized match across LaTeX', () => {
    const r = gradeV2('-\\frac{82}{27}', '-82/27');
    expect(r.match).toBe(true);
    expect(r.method).toBe('normalized');
  });

  it('numeric tolerance match', () => {
    const r = gradeV2('0.5', '\\frac{1}{2}');
    expect(r.match).toBe(true);
    expect(r.method).toBe('numeric');
  });

  it('plain mismatch', () => {
    const r = gradeV2('3', '5');
    expect(r.match).toBe(false);
  });

  it('does not over-collapse function-call parens like sqrt(2)', () => {
    // Both sides evaluate to the same decimal — numeric match (not falsely
    // collapsed to a bare identifier). Confirmed correct: match is true.
    const r = gradeV2('\\frac{\\sqrt{2}}{3}', 'sqrt(2)/3');
    expect(r.match).toBe(true);
    expect(r.method).not.toBe('none');
  });

  it('does not falsely match sqrt2 (bare identifier) against sqrt(2)/3', () => {
    // sqrt2 is a bare identifier (kind=expression, decimal=null);
    // sqrt(2)/3 is a numeric expression. They MUST NOT match.
    const r = gradeV2('sqrt2/3', '\\frac{\\sqrt{2}}{3}');
    expect(r.match).toBe(false);
  });
});

describe('gradeV2 — set match', () => {
  it('matches sets ignoring order', () => {
    const r = gradeV2('\\{1, 2, 3\\}', '\\{3, 1, 2\\}');
    expect(r.match).toBe(true);
    expect(r.method).toBe('set');
  });

  it('matches sets across LaTeX/plain', () => {
    const r = gradeV2('\\{-1/8, 3/2\\}', '{3/2, -1/8}');
    expect(r.match).toBe(true);
  });

  it('rejects sets with different members', () => {
    expect(gradeV2('\\{1, 2\\}', '\\{1, 3\\}').match).toBe(false);
  });
});

describe('gradeV2 — interval match', () => {
  it('matches intervals across notation', () => {
    expect(gradeV2('[1, 5]', '[1,5]').match).toBe(true);
    expect(gradeV2('(0, \\infty)', '(0,inf)').match).toBe(true);
  });

  it('matches conditional vs interval', () => {
    expect(gradeV2('x >= 11/2', '[\\frac{11}{2}, \\infty)').match).toBe(true);
  });
});

describe('gradeV2 — conditional match', () => {
  it('matches "x = a or x = b" against {a, b}', () => {
    expect(gradeV2('x = -1/8 or x = 3/2', '\\{-1/8, 3/2\\}').match).toBe(true);
  });
});

describe('gradeV2 — symbolic equivalence', () => {
  function fakeBridge(map: Record<string, string | null>) {
    return {
      evaluate: async (expr: string): Promise<string | null> => map[expr] ?? null,
    };
  }

  it('matches expressions that simplify to 0', async () => {
    const bridge = fakeBridge({
      'simplify((cos(x)*x^2+sin(x)*2*x) - (2*x*sin(x)+x^2*cos(x)))': '0',
    });
    const r = await gradeV2Async(
      'cos(x)*x^2+sin(x)*2*x',
      '2*x*sin(x)+x^2*cos(x)',
      { giacEval: bridge.evaluate }
    );
    expect(r.match).toBe(true);
    expect(r.method).toBe('symbolic');
  });

  it('returns false when simplify is non-zero', async () => {
    const bridge = fakeBridge({
      'simplify((x) - (2))': 'x-2',
    });
    const r = await gradeV2Async('x', '2', { giacEval: bridge.evaluate });
    expect(r.match).toBe(false);
    expect(r.method).toBe('none');
  });

  it('matches when simplify returns "0.0" (decimal zero)', async () => {
    const bridge = fakeBridge({
      'simplify((cos(x)) - (cos(x)))': '0.0',
    });
    const r = await gradeV2Async('cos(x)', 'cos(x)', { giacEval: bridge.evaluate });
    // sync stage already matches via exact, but if not, symbolic should
    expect(r.match).toBe(true);
  });

  it('matches when simplify returns "0.0" — symbolic-only path', async () => {
    // Use distinct expressions so sync stages don't match; force the symbolic path.
    const bridge = fakeBridge({
      'simplify((cos(x)*x^2+sin(x)*2*x) - (2*x*sin(x)+x^2*cos(x)))': '0.0',
    });
    const r = await gradeV2Async(
      'cos(x)*x^2+sin(x)*2*x',
      '2*x*sin(x)+x^2*cos(x)',
      { giacEval: bridge.evaluate }
    );
    expect(r.match).toBe(true);
    expect(r.method).toBe('symbolic');
  });

  it('falls back to sync when giacEval throws', async () => {
    const r = await gradeV2Async(
      'cos(x)*x^2+sin(x)*2*x',
      '2*x*sin(x)+x^2*cos(x)',
      { giacEval: async () => { throw new Error('boom'); } }
    );
    expect(r.match).toBe(false);
    expect(r.method).toBe('none');
  });

  it('skips symbolic when bridge unavailable', async () => {
    const r = await gradeV2Async('cos(x)*x^2', '2*x*sin(x)');
    expect(r.match).toBe(false);
    expect(r.method).toBe('none');
  });
});
