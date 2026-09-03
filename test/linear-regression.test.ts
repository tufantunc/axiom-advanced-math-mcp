import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { linearRegressionHandler } from '../src/server/tools/linear-regression.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('linear_regression', () => {
  describe('linear model', () => {
    it('should fit perfect linear data with R²=1', async () => {
      const x = [1, 2, 3, 4, 5];
      const y = [2, 4, 6, 8, 10]; // y = 2x
      const result = await linearRegressionHandler({
        x, y, model: 'linear',
      });
      expect(result.isError).toBe(false);
      const t = result.content[0].text;
      expect(t).toContain('R²');
      expect(t).toContain('1.000000');
      expect(t).toContain('Linear');
      // The goodness-of-fit pair, in order — nothing else asserted these
      // lines (a dropped RMSE survived the whole suite, verified by mutation).
      expect(t).toMatch(/^  MSE = 0\.000000\n  RMSE = 0\.000000$/m);
    });

    it('should compute correct slope and intercept', async () => {
      const x = [0, 1, 2, 3, 4];
      const y = [1, 3, 5, 7, 9]; // y = 1 + 2x
      const result = await linearRegressionHandler({
        x, y, model: 'linear',
      });
      expect(result.isError).toBe(false);
      const text = result.content[0].text;
      // a0 (intercept) ≈ 1, a1 (slope) ≈ 2
      expect(text).toMatch(/a0 = 1/);
      expect(text).toMatch(/a1 = 2/);
    });
  });

  describe('polynomial model', () => {
    it('should fit quadratic data y = x^2', async () => {
      const x = [1, 2, 3, 4, 5];
      const y = [1, 4, 9, 16, 25];
      const result = await linearRegressionHandler({
        x, y, model: 'polynomial', degree: 2,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('R²');
      expect(result.content[0].text).toContain('1.000000');
      expect(result.content[0].text).toContain('degree 2');
    });
  });

  describe('exponential model', () => {
    it('should fit exponential data y = e^x', async () => {
      const x = [0, 1, 2, 3];
      const y = x.map(Math.exp);
      const result = await linearRegressionHandler({
        x, y, model: 'exponential',
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Exponential');
      // b should be ≈ 1
      expect(result.content[0].text).toMatch(/b = 1\./);
    });

    it('should reject y with non-positive values', async () => {
      const result = await linearRegressionHandler({
        x: [1, 2, 3], y: [-1, 2, 3], model: 'exponential',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('y > 0');
    });
  });

  describe('power model', () => {
    it('should fit power data y = x^2', async () => {
      const x = [1, 2, 3, 4, 5];
      const y = x.map((xi) => xi ** 2);
      const result = await linearRegressionHandler({
        x, y, model: 'power',
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Power');
      // b should be ≈ 2
      expect(result.content[0].text).toMatch(/b = 2\./);
    });
  });

  describe('error handling', () => {
    it('should reject mismatched x and y lengths', async () => {
      const result = await linearRegressionHandler({
        x: [1, 2, 3], y: [1, 2], model: 'linear',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('same length');
    });
  });

  describe('exact rational coefficients from lsq', () => {
    it('fits y = 0.6429x + 0.5 rather than reading 1/2 and 9/14 as 1 and 9', async () => {
      // Bare `lsq` returns EXACT RATIONALS — [[1/2],[9/14]] — and parseFloat read
      // those as [1, 9], so this reported "ŷ = 9.00000x + 1.00000" with
      // R² = -762 against a true fit of 0.6429x + 0.5.
      const r = await linearRegressionHandler({ x: [1, 2, 4], y: [1, 2, 3] });
      expect(r.isError).toBe(false);
      const t = r.content.map((c) => c.text).join('\n');
      expect(t).toMatch(/ŷ = 0\.642857x \+ 0\.500000/);
      expect(t).not.toMatch(/ŷ = 9/);
      // R² for a real fit is in [0,1]; the laundered coefficients gave -762.
      const r2 = Number(/R² = (-?[\d.]+)/.exec(t)?.[1]);
      expect(r2).toBeGreaterThan(0.9);
      // The imperfect-fit error pair, pinned by hand: MSE for residuals
      // [-0.047619, 0.023810, 0.023810] is 0.023810, its root 0.154303.
      expect(t).toMatch(/^  MSE = 0\.023810\n  RMSE = 0\.154303$/m);
    });

    it('still fits an exactly-linear set', async () => {
      const r = await linearRegressionHandler({ x: [1, 2, 3], y: [2, 4, 6] });
      const t = r.content.map((c) => c.text).join('\n');
      expect(t).toMatch(/ŷ = 2\.0*x/);
    });

    it('prints a negative leading coefficient with its sign', async () => {
      // y = 1 - 2x: the FIRST term's sign is a bare '-', not ' - ' and not
      // nothing. Dropping that arm renders "ŷ = 2.00000x + 1.00000" — a
      // wrong-sign equation with correct coefficients beneath it, which no
      // other pin catches (every existing fixture fits a positive slope).
      const r = await linearRegressionHandler({ x: [0, 1, 2, 3, 4], y: [1, -1, -3, -5, -7] });
      expect(r.isError).toBe(false);
      const t = r.content.map((c) => c.text).join('\n');
      expect(t).toMatch(/ŷ = -2\.00000x \+ 1\.00000/);
    });
  });
});

