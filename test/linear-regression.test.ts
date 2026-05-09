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
      expect(result.content[0].text).toContain('R²');
      expect(result.content[0].text).toContain('1.000000');
      expect(result.content[0].text).toContain('Linear');
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
});
