import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { numericalMethodsHandler } from '../src/server/tools/numerical-methods.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('numerical_methods', () => {
  function allText(r: { content: { text: string }[] }): string {
    return r.content.map((c) => c.text).join('\n');
  }

  describe('newton_raphson', () => {
    it('should find sqrt(2) as root of x^2 - 2', async () => {
      const result = await numericalMethodsHandler({
        method: 'newton_raphson',
        expression: 'x^2 - 2',
        variable: 'x',
        initial_guess: 1.5,
        tolerance: 1e-10,
        max_iterations: 50,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Converged');
      expect(allText(result)).toContain('1.4142');
    });

    it('should find root of sin(x) near pi', async () => {
      const result = await numericalMethodsHandler({
        method: 'newton_raphson',
        expression: 'sin(x)',
        variable: 'x',
        initial_guess: 3,
        tolerance: 1e-10,
        max_iterations: 50,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Converged');
      expect(allText(result)).toContain('3.14159');
    });

    it('should return error without initial_guess', async () => {
      const result = await numericalMethodsHandler({
        method: 'newton_raphson',
        expression: 'x^2 - 2',
        variable: 'x',
      });
      expect(result.isError).toBe(true);
      expect(allText(result)).toContain('initial_guess');
    });
  });

  describe('bisection', () => {
    it('should find sqrt(2) in bracket [1, 2]', async () => {
      const result = await numericalMethodsHandler({
        method: 'bisection',
        expression: 'x^2 - 2',
        variable: 'x',
        x0: 1,
        x1: 2,
        tolerance: 1e-8,
        max_iterations: 60,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Converged');
      expect(allText(result)).toContain('1.4142');
    });

    it('should reject bracket with no sign change', async () => {
      const result = await numericalMethodsHandler({
        method: 'bisection',
        expression: 'x^2 + 1', // always positive
        variable: 'x',
        x0: 0,
        x1: 2,
        tolerance: 1e-8,
        max_iterations: 50,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('same sign');
    });
  });

  describe('secant', () => {
    it('should find sqrt(2) using secant method', async () => {
      const result = await numericalMethodsHandler({
        method: 'secant',
        expression: 'x^2 - 2',
        variable: 'x',
        x0: 1,
        x1: 2,
        tolerance: 1e-10,
        max_iterations: 50,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Converged');
      expect(allText(result)).toContain('1.4142');
    });
  });

  describe('romberg_integration', () => {
    it('should integrate x^2 from 0 to 1 = 1/3', async () => {
      const result = await numericalMethodsHandler({
        method: 'romberg_integration',
        expression: 'x^2',
        variable: 'x',
        lower_bound: 0,
        upper_bound: 1,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('0.333');
    });

    it('should integrate sin(x) from 0 to pi = 2', async () => {
      const result = await numericalMethodsHandler({
        method: 'romberg_integration',
        expression: 'sin(x)',
        variable: 'x',
        lower_bound: 0,
        upper_bound: 3.14159265358979,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toMatch(/Result = 2/);
    });
  });

  describe('numerical_integration', () => {
    it("should integrate x^3 from 0 to 1 = 0.25 via Simpson's rule", async () => {
      const result = await numericalMethodsHandler({
        method: 'numerical_integration',
        expression: 'x^3',
        variable: 'x',
        lower_bound: 0,
        upper_bound: 1,
        n_points: 100,
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('0.25');
    });
  });
});
