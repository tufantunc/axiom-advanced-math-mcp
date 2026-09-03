import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AdvancedSolveService } from '../src/server/tools/advanced-solve-service.js';
import { giacEngine } from '../src/server/giac/index.js';

describe('AdvancedSolveService', () => {
  let service: AdvancedSolveService;

  beforeAll(async () => {
    await giacEngine.initialize();
  });

  beforeEach(() => {
    service = new AdvancedSolveService();
  });

  it('renders LaTeX through the shared path, bounds and all', async () => {
    // This was a fourth open-coded copy of the latex pipeline: no size bound, so
    // a deep result handed straight to `latex(...)` traps the engine and takes
    // the shared worker down with whatever else is in flight, and no `undef`
    // rejection or quote stripping either.
    const local = new AdvancedSolveService();
    const ordinary = await local.evaluate({ expression: 'integrate(x^2,x)', format: 'latex' });
    expect(ordinary.latex).toBe('\\frac{x^{3}}{3}');

    const deep = await local.evaluate({
      expression: 'g:=x;for(k:=0;k<150;k++){g:=sqrt(1+g);};g',
      format: 'latex',
      simplify: false,
    });
    expect(deep.latex).toBeUndefined();
    await expect(giacEngine.evaluate('diff(x^3,x)')).resolves.toContain('3*x^2');
  });

  it('records the raw and simplified steps in order', async () => {
    // The steps transcript is an internal surface (no router spelling emits
    // the flag), but it is this service's own audit trail — order included.
    const r = await service.evaluate({ expression: '2*x + 3*x', steps: true });
    expect(r.steps).toEqual(['Input: 2*x + 3*x', 'Raw result: 2*x+3*x', 'Simplified: 5*x']);
  });

  describe('Integration', () => {
    it('should integrate polynomial', async () => {
      const result = await service.evaluate({
        expression: 'int(x^2, x)',
        format: 'latex',
      });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeDefined();
    });

    it('should integrate sin', async () => {
      const result = await service.evaluate({
        expression: 'int(sin(x), x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should integrate cos', async () => {
      const result = await service.evaluate({
        expression: 'int(cos(x), x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should integrate exp', async () => {
      const result = await service.evaluate({
        expression: 'int(exp(x), x)',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Differentiation', () => {
    it('should differentiate polynomial', async () => {
      const result = await service.evaluate({
        expression: 'diff(x^3, x)',
        format: 'latex',
      });
      expect(result.result).toBeDefined();
    });

    it('should differentiate sin', async () => {
      const result = await service.evaluate({
        expression: 'diff(sin(x), x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should differentiate cos', async () => {
      const result = await service.evaluate({
        expression: 'diff(cos(x), x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should differentiate exp', async () => {
      const result = await service.evaluate({
        expression: 'diff(exp(x), x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should differentiate log', async () => {
      const result = await service.evaluate({
        expression: 'diff(log(x), x)',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Limits', () => {
    it('should calculate simple limit', async () => {
      const result = await service.evaluate({
        expression: 'limit(x, x, 0)',
      });
      expect(result.result).toBeDefined();
    });

    it('should calculate limit of rational function', async () => {
      const result = await service.evaluate({
        expression: 'limit((x^2-1)/(x-1), x, 1)',
      });
      expect(result.result).toBeDefined();
    });

    it('should calculate limit with infinity', async () => {
      const result = await service.evaluate({
        expression: 'limit(1/x, x, +infinity)',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Equation Solving', () => {
    it('should solve linear equation', async () => {
      const result = await service.evaluate({
        expression: 'solve(2*x + 3 = 7, x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should solve quadratic equation', async () => {
      const result = await service.evaluate({
        expression: 'solve(x^2 - 5*x + 6 = 0, x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should solve cubic equation', async () => {
      const result = await service.evaluate({
        expression: 'solve(x^3 - 6*x^2 + 11*x - 6 = 0, x)',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Factorization', () => {
    it('should factor polynomial', async () => {
      const result = await service.evaluate({
        expression: 'factor(x^2 - 4)',
      });
      expect(result.result).toBeDefined();
    });

    it('should factor complex polynomial', async () => {
      const result = await service.evaluate({
        expression: 'factor(x^3 - x)',
      });
      expect(result.result).toBeDefined();
    });

    it('should factor with cfactor', async () => {
      const result = await service.evaluate({
        expression: 'cfactor(x^4 - 16)',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Expansion', () => {
    it('should expand expression', async () => {
      const result = await service.evaluate({
        expression: 'expand((x + 1)^3)',
      });
      expect(result.result).toBeDefined();
    });

    it('should expand product', async () => {
      const result = await service.evaluate({
        expression: 'expand((x + 1)*(x + 2))',
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Simplification', () => {
    it('should simplify expression', async () => {
      const result = await service.evaluate({
        expression: 'simplify((x^2 - 1)/(x - 1))',
      });
      expect(result.result).toBeDefined();
    });

    it('should simplify trigonometric expression', async () => {
      const result = await service.evaluate({
        expression: 'simplify(sin(x)^2 + cos(x)^2)',
      });
      expect(result.result).toBeDefined();
    });

    it('should auto-simplify by default', async () => {
      const result = await service.evaluate({
        expression: '2*x + 3*x',
      });
      expect(result.result).toBeDefined();
    });

    it('should respect simplify = false', async () => {
      const result = await service.evaluate({
        expression: '2*x + 3*x',
        simplify: false,
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Differential Equations', () => {
    it('should solve first order ODE', async () => {
      const result = await service.evaluate({
        expression: "desolve(y' = x, y)",
      });
      expect(result.result).toBeDefined();
    });

    it('should solve separable ODE', async () => {
      const result = await service.evaluate({
        expression: "desolve(y' = y, y)",
      });
      expect(result.result).toBeDefined();
    });
  });

  describe('Format Options', () => {
    it('should return LaTeX when format is latex', async () => {
      const result = await service.evaluate({
        expression: 'diff(x^2, x)',
        format: 'latex',
      });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeDefined();
    });

    it('should return LaTeX when format is json', async () => {
      const result = await service.evaluate({
        expression: 'int(x^2, x)',
        format: 'json',
      });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeDefined();
    });

    it('should return text by default', async () => {
      const result = await service.evaluate({
        expression: 'diff(x^2, x)',
      });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeUndefined();
    });
  });

  describe('Error Handling', () => {
    it('should auto-correct unclosed parentheses', async () => {
      // Giac auto-closes missing parentheses and returns a valid result
      const result = await service.evaluate({ expression: 'int(x^2' });
      expect(result.result).toBeDefined();
    });

    it('should return undef for malformed expression', async () => {
      const result = await service.evaluate({ expression: ')invalid_syntax(' });
      expect(result.result).toContain('undef');
    });
  });
});
