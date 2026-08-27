import { describe, it, expect } from 'vitest';
import { QuickCalcService } from '../src/server/tools/quick-calc-service.js';

describe('QuickCalcService', () => {
  const service = new QuickCalcService();

  describe('Basic Arithmetic', () => {
    it('should add two numbers', async () => {
      const result = await service.evaluate({ expression: '2 + 3' });
      expect(result.result).toBe(5);
    });

    it('should subtract two numbers', async () => {
      const result = await service.evaluate({ expression: '10 - 4' });
      expect(result.result).toBe(6);
    });

    it('should multiply two numbers', async () => {
      const result = await service.evaluate({ expression: '6 * 7' });
      expect(result.result).toBe(42);
    });

    it('should divide two numbers', async () => {
      const result = await service.evaluate({ expression: '20 / 4' });
      expect(result.result).toBe(5);
    });

    it('should handle exponentiation', async () => {
      const result = await service.evaluate({ expression: '2^3' });
      expect(result.result).toBe(8);
    });

    it('should handle modulo', async () => {
      const result = await service.evaluate({ expression: '17 % 5' });
      expect(result.result).toBe(2);
    });
  });

  describe('Trigonometric Functions', () => {
    it('should calculate sine', async () => {
      const result = await service.evaluate({ expression: 'sin(0)' });
      expect(result.result).toBeCloseTo(0);
    });

    it('should calculate cosine', async () => {
      const result = await service.evaluate({ expression: 'cos(0)' });
      expect(result.result).toBe(1);
    });

    it('should calculate tangent', async () => {
      const result = await service.evaluate({ expression: 'tan(0)' });
      expect(result.result).toBe(0);
    });

    it('should handle degrees', async () => {
      const result = await service.evaluate({ expression: 'sin(30deg)' });
      expect(result.result).toBeCloseTo(0.5, 10);
    });
  });

  describe('Logarithmic Functions', () => {
    it('should calculate natural log', async () => {
      const result = await service.evaluate({ expression: 'log(e)' });
      expect(result.result).toBeCloseTo(1, 10);
    });

    it('should calculate log10', async () => {
      const result = await service.evaluate({ expression: 'log10(100)' });
      expect(result.result).toBeCloseTo(2, 10);
    });

    it('should calculate exponential', async () => {
      const result = await service.evaluate({ expression: 'exp(1)' });
      expect(result.result).toBeCloseTo(Math.E, 10);
    });
  });

  describe('Complex Expressions', () => {
    it('should handle parentheses', async () => {
      const result = await service.evaluate({ expression: '(2 + 3) * 4' });
      expect(result.result).toBe(20);
    });

    it('should handle nested parentheses', async () => {
      const result = await service.evaluate({ expression: '((2 + 3) * (4 - 1))' });
      expect(result.result).toBe(15);
    });

    it('should handle mixed operations', async () => {
      const result = await service.evaluate({ expression: '2 + 3 * 4' });
      expect(result.result).toBe(14);
    });

    it('should handle complex trigonometric expression', async () => {
      const result = await service.evaluate({ expression: '2 * sin(30deg) + 5' });
      expect(result.result).toBeCloseTo(6, 10);
    });
  });

  describe('Format Options', () => {
    it('should return text format by default', async () => {
      const result = await service.evaluate({ expression: '2 + 3' });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeUndefined();
    });

    it('should handle latex format', async () => {
      const result = await service.evaluate({ expression: '2 + 3', format: 'latex' });
      expect(result.result).toBeDefined();
    });

    it('should handle json format', async () => {
      const result = await service.evaluate({ expression: '2 + 3', format: 'json' });
      expect(result.result).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid expression', async () => {
      await expect(service.evaluate({ expression: '2 + +' })).rejects.toThrow(
        'Math evaluation error'
      );
    });
  });

  describe('Natural Language Rejection', () => {
    it('should reject "Let S = 3T, then..."', async () => {
      await expect(
        service.evaluate({ expression: 'Let S = 3T, then G = S - 2T = T' })
      ).rejects.toThrow('natural language');
    });

    it('should reject "If S = 3T, then..."', async () => {
      await expect(
        service.evaluate({ expression: 'If S = 3T, then G = S - 2T = T' })
      ).rejects.toThrow('natural language');
    });

    it('should reject "Given that x > 0..."', async () => {
      await expect(
        service.evaluate({ expression: 'Given that x > 0, find the minimum value' })
      ).rejects.toThrow('natural language');
    });

    it('should reject expressions with "let" keyword', async () => {
      await expect(service.evaluate({ expression: 'let x = 5, then y = x + 3' })).rejects.toThrow(
        'natural language'
      );
    });

    it('should reject expressions with "since"', async () => {
      await expect(
        service.evaluate({ expression: 'since x^2 is always non-negative, therefore...' })
      ).rejects.toThrow('natural language');
    });

    it('should allow valid single-letter variable expressions', async () => {
      // 'a' as a variable should NOT be rejected (no natural language trigger)
      const result = await service.evaluate({ expression: '3 * 5 + 2' });
      expect(result.result).toBe(17);
    });

    it('should allow normal math expressions', async () => {
      const result = await service.evaluate({ expression: 'sin(pi/4)^2 + cos(pi/4)^2' });
      expect(result.result).toBeCloseTo(1, 8);
    });

    it('should allow expressions with "or" as logical operator context', async () => {
      // 'or' alone doesn't trigger — only sentence-starting words do
      const result = await service.evaluate({ expression: '2^10' });
      expect(result.result).toBe(1024);
    });
  });

  describe('Constants', () => {
    it('should handle pi', async () => {
      const result = await service.evaluate({ expression: 'pi' });
      expect(result.result).toBeCloseTo(Math.PI, 10);
    });

    it('should handle e', async () => {
      const result = await service.evaluate({ expression: 'e' });
      expect(result.result).toBeCloseTo(Math.E, 10);
    });
  });

  describe('Complex Numbers', () => {
    it('should handle imaginary unit i', async () => {
      const result = await service.evaluate({ expression: 'i^2' });
      expect(result.result).toBe('-1');
    });

    it('should calculate complex addition', async () => {
      const result = await service.evaluate({ expression: '(1 + 2i) + (3 + 4i)' });
      expect(result.result).toBeDefined();
    });
  });

  describe('Precision', () => {
    it('should handle default precision', async () => {
      const result = await service.evaluate({ expression: '1 / 3' });
      expect(result.result).toBeDefined();
    });

    it('should handle custom precision', async () => {
      const result = await service.evaluate({ expression: '1 / 3', precision: 5 });
      expect(result.result).toBeDefined();
    });
  });
});

describe('ln alias (natural log)', () => {
  const service = new QuickCalcService();

  it('evaluates ln() as the natural logarithm', async () => {
    expect((await service.evaluate({ expression: 'ln(1)' })).result).toBe(0);
    expect((await service.evaluate({ expression: 'ln(e)' })).result).toBeCloseTo(1, 10);
    expect((await service.evaluate({ expression: '0.0001*ln(0.0001)' })).result).toBeCloseTo(
      -0.000921034,
      6
    );
  });
});
