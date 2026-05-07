import { describe, it, expect } from 'vitest';
import { normalize } from '../benchmark/graders/normalizer.js';

describe('normalizer — LaTeX/Unicode basics', () => {
  it('strips \\frac to (a)/(b)', () => {
    expect(normalize('\\frac{1}{2}').canonical).toBe('(1)/(2)');
  });

  it('strips \\dfrac and \\tfrac', () => {
    expect(normalize('\\dfrac{3}{4}').canonical).toBe('(3)/(4)');
    expect(normalize('\\tfrac{5}{6}').canonical).toBe('(5)/(6)');
  });

  it('rewrites \\sqrt{n} as sqrt(n)', () => {
    expect(normalize('\\sqrt{2}').canonical).toBe('sqrt(2)');
  });

  it('strips \\left and \\right', () => {
    expect(normalize('\\left( x + 1 \\right)').canonical).toBe('(x+1)');
  });

  it('rewrites unicode pi and superscripts', () => {
    expect(normalize('π').canonical).toBe('pi');
    expect(normalize('x²').canonical).toBe('x^2');
    expect(normalize('x³').canonical).toBe('x^3');
  });

  it('rewrites \\cdot, \\times, ÷', () => {
    expect(normalize('2 \\cdot 3').canonical).toBe('2*3');
    expect(normalize('2 \\times 3').canonical).toBe('2*3');
    expect(normalize('6 ÷ 2').canonical).toBe('6/2');
  });

  it('extracts \\boxed{X}', () => {
    expect(normalize('\\boxed{42}').canonical).toBe('42');
    expect(normalize('\\boxed{\\frac{1}{2}}').canonical).toBe('(1)/(2)');
  });

  it('strips \\text{} and \\mathrm{}', () => {
    expect(normalize('5 \\text{ apples}').canonical).toBe('5apples');
    expect(normalize('\\mathrm{e}^2').canonical).toBe('e^2');
  });

  it('strips unknown LaTeX commands but keeps the name', () => {
    expect(normalize('\\alpha + 1').canonical).toBe('alpha+1');
  });

  it('preserves \\% as a literal percent', () => {
    expect(normalize('25\\%').canonical).toBe('25%');
  });
});

describe('normalizer — decimal and exactness', () => {
  it('extracts decimal for plain integers', () => {
    const n = normalize('42');
    expect(n.decimal).toBe(42);
    expect(n.is_exact).toBe(true);
  });

  it('extracts decimal for fractions', () => {
    const n = normalize('\\frac{1}{2}');
    expect(n.decimal).toBeCloseTo(0.5, 9);
    expect(n.is_exact).toBe(true);
  });

  it('extracts decimal for negative fractions', () => {
    const n = normalize('-\\frac{82}{27}');
    expect(n.decimal).toBeCloseTo(-82 / 27, 9);
    expect(n.is_exact).toBe(true);
  });

  it('marks expressions with variables as non-exact, decimal null', () => {
    const n = normalize('3*x^2');
    expect(n.decimal).toBeNull();
    expect(n.is_exact).toBe(false);
  });

  it('extracts decimal for \\sqrt{2} but marks is_exact false (irrational)', () => {
    const n = normalize('\\sqrt{2}');
    expect(n.decimal).toBeCloseTo(Math.sqrt(2), 9);
    expect(n.is_exact).toBe(false);
  });

  it('rejects array-literal injection', () => {
    expect(normalize('1*[]').decimal).toBeNull();
  });

  it('rejects comma-operator injection', () => {
    expect(normalize('(1,2)').decimal).toBeNull();
  });

  it('treats pi as irrational (decimal known, is_exact false)', () => {
    const n = normalize('pi');
    expect(n.decimal).toBeCloseTo(Math.PI, 9);
    expect(n.is_exact).toBe(false);
  });
});
