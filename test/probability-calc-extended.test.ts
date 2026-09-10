import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { probabilityCalcHandler } from '../src/server/tools/probability-calc.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('probability_calc extended distributions', () => {
  function allText(r: { content: { text: string }[] }): string {
    return r.content.map((c) => c.text).join('\n');
  }

  describe('binomial summary notes', () => {
    // The headline values are pinned elsewhere; these pin the E[X]/Var(X)
    // notes a model reads for the distribution summary — a dropped or
    // reordered note survives the rest of the suite (verified by mutation).
    it('pmf reports the expectation and variance', async () => {
      const t = allText(
        await probabilityCalcHandler({
          distribution: 'binomial',
          operation: 'pmf',
          params: { n: 10, p: 0.5, k: 5 },
        })
      );
      expect(t).toMatch(/^E\[X\] = 5$/m);
      expect(t).toMatch(/^Var\(X\) = 2\.5$/m);
    });

    it('expected_value reports expectation before variance', async () => {
      const t = allText(
        await probabilityCalcHandler({
          distribution: 'binomial',
          operation: 'expected_value',
          params: { n: 10, p: 0.5 },
        })
      );
      expect(t).toMatch(/^E\[X\] = n×p = 10×0\.5 = 5\nVar\(X\) = n×p×\(1-p\) = 2\.5$/m);
    });
  });

  describe('chi_square', () => {
    it('should compute expected value and variance', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'chi_square',
        operation: 'expected_value',
        params: { df: 5 },
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('5');
    });

    it('should compute CDF P(X ≤ x)', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'chi_square',
        operation: 'cdf',
        params: { df: 5, x: 5 },
      });
      expect(result.isError).toBe(false);
      // chi_square(df=5) CDF at x=5 ≈ 0.584
      const text = allText(result);
      expect(text).toMatch(/0\.[45678]/);
    });

    it('should compute quantile', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'chi_square',
        operation: 'quantile',
        params: { df: 5, p: 0.95 },
      });
      expect(result.isError).toBe(false);
      // chi_square(df=5) 95th percentile ≈ 11.07
      expect(allText(result)).toContain('11');
    });
  });

  describe('student_t', () => {
    it('should compute expected value', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'student_t',
        operation: 'expected_value',
        params: { df: 10 },
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('E[X] = 0');
    });

    it('should compute CDF', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'student_t',
        operation: 'cdf',
        params: { df: 10, x: 0 },
      });
      expect(result.isError).toBe(false);
      // t-distribution is symmetric, CDF at 0 = 0.5
      expect(allText(result)).toMatch(/0\.5/);
    });

    it('should compute quantile (two-tailed critical value)', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'student_t',
        operation: 'quantile',
        params: { df: 29, p: 0.975 },
      });
      expect(result.isError).toBe(false);
      // t(29, 0.975) ≈ 2.045
      expect(allText(result)).toMatch(/2\.0/);
    });
  });

  describe('f_distribution', () => {
    it('should compute expected value', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'f_distribution',
        operation: 'expected_value',
        params: { df1: 5, df2: 10 },
      });
      expect(result.isError).toBe(false);
      // E[X] = df2/(df2-2) = 10/8 = 1.25
      expect(allText(result)).toContain('1.25');
    });

    it('should compute CDF', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'f_distribution',
        operation: 'cdf',
        params: { df1: 5, df2: 10, x: 1 },
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toMatch(/P\(X/);
    });
  });

  describe('beta', () => {
    it('should compute expected value', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'beta',
        operation: 'expected_value',
        params: { alpha: 2, beta: 5 },
      });
      expect(result.isError).toBe(false);
      // E[X] = 2/7 ≈ 0.2857
      expect(allText(result)).toMatch(/0\.285/);
    });

    it('should compute CDF', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'beta',
        operation: 'cdf',
        params: { alpha: 2, beta: 5, x: 0.5 },
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toMatch(/P\(X/);
    });
  });

  describe('exponential', () => {
    it('should compute expected value and variance', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'exponential',
        operation: 'expected_value',
        params: { lambda: 2 },
      });
      expect(result.isError).toBe(false);
      // E[X] = 1/lambda = 0.5
      expect(allText(result)).toContain('0.5');
    });

    it('should compute CDF', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'exponential',
        operation: 'cdf',
        params: { lambda: 1, x: 1 },
      });
      expect(result.isError).toBe(false);
      // P(X ≤ 1) = 1 - e^(-1) ≈ 0.6321
      expect(allText(result)).toMatch(/0\.63/);
    });

    it('should compute quantile (median)', async () => {
      const result = await probabilityCalcHandler({
        distribution: 'exponential',
        operation: 'quantile',
        params: { lambda: 1, p: 0.5 },
      });
      expect(result.isError).toBe(false);
      // median of Exp(1) = ln(2) ≈ 0.6931
      expect(allText(result)).toMatch(/0\.693/);
    });
  });
});
