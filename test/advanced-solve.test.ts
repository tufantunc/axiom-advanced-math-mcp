import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { AdvancedSolveService } from '../src/server/tools/advanced-solve-service.js';
import { giacEngine } from '../src/server/giac/index.js';
import { computeHandler } from '../src/server/tools/compute/index.js';
import { allText } from './helpers/all-text.js';
import { resultLine } from './helpers/result-line.js';

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

  // This route goes straight to the engine, past evalWithLatex, and Giac
  // misreads a raw superscript glyph rather than refusing it: each of these
  // answered a wrong result with isError:false before the service normalised
  // its input.
  describe('Unicode input', () => {
    it.each([
      ['sum(k², k, 1, n)', '(2*n^3+3*n^2+n)/6', ['n']],
      ['sum(1/k², k, 1, inf)', 'pi^2/6', undefined],
      ['product(k², k, 1, 3)', '36', undefined],
      ['laplace(t², t, s)', '2/s^3', ['s']],
    ])('%s answers %s', async (expression, expected, variables) => {
      const r = await service.evaluate({ expression });
      expect(r.result).toBe(expected);
      // The exact list, so a raw glyph read as `kmicro` or `tmicro` fails it.
      expect(r.variables).toEqual(variables);
    });

    it('records normalised steps', async () => {
      const r = await service.evaluate({ expression: 'sum(k², k, 1, n)', steps: true });
      expect(r.steps).toEqual([
        'Input: sum(k^2, k, 1, n)',
        'Raw result: (2*(n+1)^3-3*(n+1)^2+n+1)/6',
        'Simplified: (2*n^3+3*n^2+n)/6',
      ]);
    });

    it('reaches the route through compute', async () => {
      const r = await computeHandler({ problem: 'sum(k², k, 1, n)' });
      expect(r.isError).toBe(false);
      expect(allText(r)).toMatch(resultLine('(2*n^3+3*n^2+n)/6'));
    });
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

    it.each([['int(sin(x), x)'], ['int(cos(x), x)'], ['int(exp(x), x)']])(
      'should integrate %s',
      async (expression) => {
        const result = await service.evaluate({ expression });
        expect(result.result).toBeDefined();
      }
    );
  });

  describe('Differentiation', () => {
    it('should differentiate polynomial', async () => {
      const result = await service.evaluate({
        expression: 'diff(x^3, x)',
        format: 'latex',
      });
      expect(result.result).toBeDefined();
    });

    it.each([['diff(sin(x), x)'], ['diff(cos(x), x)'], ['diff(exp(x), x)'], ['diff(log(x), x)']])(
      'should differentiate %s',
      async (expression) => {
        const result = await service.evaluate({ expression });
        expect(result.result).toBeDefined();
      }
    );
  });

  describe('Limits', () => {
    it.each([['limit(x, x, 0)'], ['limit((x^2-1)/(x-1), x, 1)'], ['limit(1/x, x, +infinity)']])(
      'should calculate %s',
      async (expression) => {
        const result = await service.evaluate({ expression });
        expect(result.result).toBeDefined();
      }
    );
  });

  describe('Equation Solving', () => {
    it.each([
      ['linear equation', 'solve(2*x + 3 = 7, x)'],
      ['quadratic equation', 'solve(x^2 - 5*x + 6 = 0, x)'],
      ['cubic equation', 'solve(x^3 - 6*x^2 + 11*x - 6 = 0, x)'],
    ])('should solve %s', async (_label, expression) => {
      const result = await service.evaluate({ expression });
      expect(result.result).toBeDefined();
    });
  });

  describe('Factorization', () => {
    it.each([
      ['polynomial', 'factor(x^2 - 4)'],
      ['complex polynomial', 'factor(x^3 - x)'],
      ['with cfactor', 'cfactor(x^4 - 16)'],
    ])('should factor %s', async (_label, expression) => {
      const result = await service.evaluate({ expression });
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
    it.each([['simplify((x^2 - 1)/(x - 1))'], ['simplify(sin(x)^2 + cos(x)^2)'], ['2*x + 3*x']])(
      'should simplify %s',
      async (expression) => {
        const result = await service.evaluate({ expression });
        expect(result.result).toBeDefined();
      }
    );

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
