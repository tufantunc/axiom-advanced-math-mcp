import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { hypothesisTestingHandler } from '../src/server/tools/hypothesis-testing.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

function allText(r: { content: { text: string }[] }): string {
  return r.content.map((c) => c.text).join('\n');
}

describe('hypothesis_testing', () => {
  describe('one_sample_t', () => {
    it('should reject H0 when sample mean differs significantly from mu0', async () => {
      // Sample clearly not from mu0=0
      const sample1 = [10, 11, 12, 10.5, 11.5, 12.5, 10.2, 11.8, 12.1, 10.8];
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1, mu0: 0, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
      expect(allText(result)).toContain('t-statistic');
      expect(allText(result)).toContain('p-value');
    });

    it('should fail to reject H0 when sample is consistent with mu0', async () => {
      // Sample around mu0=5
      const sample1 = [4.9, 5.1, 5.0, 4.95, 5.05, 5.02, 4.98, 5.01];
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1, mu0: 5, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });

    it('should return error without mu0', async () => {
      const result = await hypothesisTestingHandler({
        test: 'one_sample_t',
        data: { sample1: [1, 2, 3], significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Error');
    });
  });

  describe('two_sample_t', () => {
    it('should detect significant difference between groups', async () => {
      const sample1 = [2, 3, 2.5, 2.8, 3.2, 2.7];
      const sample2 = [8, 9, 8.5, 9.2, 7.8, 8.7];
      const result = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1, sample2, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should not detect difference between similar groups', async () => {
      const sample1 = [5.0, 5.1, 4.9, 5.0, 5.2];
      const sample2 = [5.1, 4.9, 5.0, 5.1, 4.8];
      const result = await hypothesisTestingHandler({
        test: 'two_sample_t',
        data: { sample1, sample2, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });
  });

  describe('paired_t', () => {
    it('should detect significant before/after effect', async () => {
      const before = [70, 75, 68, 72, 80];
      const after = [60, 65, 58, 62, 70]; // 10 units lower each
      const result = await hypothesisTestingHandler({
        test: 'paired_t',
        data: { sample1: before, sample2: after, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Reject H₀');
    });
  });

  describe('chi_square_independence', () => {
    it('should detect dependence in 2x2 contingency table', async () => {
      // Clear dependence
      const table = [
        [50, 5],
        [5, 50],
      ];
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: table, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('χ²');
      expect(allText(result)).toContain('p-value');
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should not detect dependence in independent table', async () => {
      // Expected frequencies proportional → no dependence
      const table = [
        [25, 25],
        [25, 25],
      ];
      const result = await hypothesisTestingHandler({
        test: 'chi_square_independence',
        data: { contingency_table: table, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Fail to reject H₀');
    });
  });

  describe('one_way_anova', () => {
    it('should detect significant group difference', async () => {
      const groups = [
        [2, 3, 2.5, 2.8],
        [8, 9, 8.5, 9.2],
        [15, 16, 14.5, 15.8],
      ];
      const result = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: { groups, significance: 0.05 },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('F =');
      expect(allText(result)).toContain('Reject H₀');
    });

    it('should require at least 3 groups', async () => {
      const result = await hypothesisTestingHandler({
        test: 'one_way_anova',
        data: {
          groups: [
            [1, 2],
            [3, 4],
          ],
          significance: 0.05,
        },
        alternative: 'two_sided',
      });
      expect(result.isError).toBe(false);
      expect(allText(result)).toContain('Error');
    });
  });
});
