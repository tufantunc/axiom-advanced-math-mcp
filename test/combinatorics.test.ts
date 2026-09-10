import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { combinatoricsHandler } from '../src/server/tools/combinatorics.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('combinatorics', () => {
  describe('combinations', () => {
    it('C(5,2) = 10', async () => {
      const result = await combinatoricsHandler({ operation: 'combinations', n: 5, k: 2 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('10');
    });

    it('C(10,3) = 120', async () => {
      const result = await combinatoricsHandler({ operation: 'combinations', n: 10, k: 3 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('120');
    });

    it('C(n,0) = 1', async () => {
      const result = await combinatoricsHandler({ operation: 'combinations', n: 7, k: 0 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('1');
    });
  });

  describe('permutations', () => {
    it('P(5,2) = 20', async () => {
      const result = await combinatoricsHandler({ operation: 'permutations', n: 5, k: 2 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('20');
    });

    it('P(4,4) = 24 = 4!', async () => {
      const result = await combinatoricsHandler({ operation: 'permutations', n: 4, k: 4 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('24');
    });
  });

  describe('multinomial', () => {
    it('multinomial(4; 2,1,1) = 12', async () => {
      const result = await combinatoricsHandler({
        operation: 'multinomial',
        n: 4,
        groups: [2, 1, 1],
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('12');
    });

    it('should error when groups do not sum to n', async () => {
      const result = await combinatoricsHandler({ operation: 'multinomial', n: 5, groups: [2, 1] });
      expect(result.isError).toBe(true);
    });
  });

  describe('stirling_second', () => {
    it('S(4,2) = 7', async () => {
      const result = await combinatoricsHandler({ operation: 'stirling_second', n: 4, k: 2 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('7');
    });

    it('S(n,1) = 1 for any n≥1', async () => {
      const result = await combinatoricsHandler({ operation: 'stirling_second', n: 5, k: 1 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('1');
    });
  });

  describe('stirling_first', () => {
    it('|s(4,2)| = 11', async () => {
      const result = await combinatoricsHandler({ operation: 'stirling_first', n: 4, k: 2 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('Result: 11');
    });

    it('|s(6,2)| = 274', async () => {
      const result = await combinatoricsHandler({ operation: 'stirling_first', n: 6, k: 2 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('Result: 274');
    });
  });

  describe('bell_number', () => {
    it('B(0) = 1', async () => {
      const result = await combinatoricsHandler({ operation: 'bell_number', n: 0 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('1');
    });

    it('B(4) = 15', async () => {
      const result = await combinatoricsHandler({ operation: 'bell_number', n: 4 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe('Result: 15');
    });

    it('B(10) = 115975', async () => {
      const result = await combinatoricsHandler({ operation: 'bell_number', n: 10 });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('115975');
    });
  });

  describe('catalan_number', () => {
    it.each([
      [0, '1'],
      [4, '14'],
      [10, '16796'],
    ])('C(%d) = %s', async (n, expected) => {
      const result = await combinatoricsHandler({ operation: 'catalan_number', n });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain(expected);
    });
  });

  describe('derangements', () => {
    it.each([
      [1, '0'],
      [4, '9'],
      [6, '265'],
    ])('D(%d) = %s', async (n, expected) => {
      const result = await combinatoricsHandler({ operation: 'derangements', n });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain(expected);
    });
  });

  describe('partition_count', () => {
    it.each([
      [5, 'Result: 7'],
      [10, 'Result: 42'],
      [100, 'Result: 190569292'],
    ])('p(%d) = %s', async (n, expected) => {
      const result = await combinatoricsHandler({ operation: 'partition_count', n });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toBe(expected);
    });
  });

  describe('error handling', () => {
    it('combinations: should error when k is missing', async () => {
      const result = await combinatoricsHandler({ operation: 'combinations', n: 5 });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('k is required');
    });

    it('combinations: should error when k > n', async () => {
      const result = await combinatoricsHandler({ operation: 'combinations', n: 3, k: 5 });
      expect(result.isError).toBe(true);
    });
  });
});
