import { describe, it, expect } from 'vitest';
import { QuickCalcService } from '../src/server/tools/quick-calc-service.js';

describe('QuickCalcService', () => {
  const service = new QuickCalcService();

  describe('Basic Arithmetic', () => {
    it('should add two numbers', () => {
      const result = service.evaluate({ expression: '2 + 3' });
      expect(result.result).toBe(5);
    });

    it('should subtract two numbers', () => {
      const result = service.evaluate({ expression: '10 - 4' });
      expect(result.result).toBe(6);
    });

    it('should multiply two numbers', () => {
      const result = service.evaluate({ expression: '6 * 7' });
      expect(result.result).toBe(42);
    });

    it('should divide two numbers', () => {
      const result = service.evaluate({ expression: '20 / 4' });
      expect(result.result).toBe(5);
    });

    it('should handle exponentiation', () => {
      const result = service.evaluate({ expression: '2^3' });
      expect(result.result).toBe(8);
    });

    it('should handle modulo', () => {
      const result = service.evaluate({ expression: '17 % 5' });
      expect(result.result).toBe(2);
    });
  });

  describe('Trigonometric Functions', () => {
    it('should calculate sine', () => {
      const result = service.evaluate({ expression: 'sin(0)' });
      expect(result.result).toBeCloseTo(0);
    });

    it('should calculate cosine', () => {
      const result = service.evaluate({ expression: 'cos(0)' });
      expect(result.result).toBe(1);
    });

    it('should calculate tangent', () => {
      const result = service.evaluate({ expression: 'tan(0)' });
      expect(result.result).toBe(0);
    });

    it('should handle degrees', () => {
      const result = service.evaluate({ expression: 'sin(30deg)' });
      expect(result.result).toBeCloseTo(0.5, 10);
    });
  });

  describe('Logarithmic Functions', () => {
    it('should calculate natural log', () => {
      const result = service.evaluate({ expression: 'log(e)' });
      expect(result.result).toBeCloseTo(1, 10);
    });

    it('should calculate log10', () => {
      const result = service.evaluate({ expression: 'log10(100)' });
      expect(result.result).toBeCloseTo(2, 10);
    });

    it('should calculate exponential', () => {
      const result = service.evaluate({ expression: 'exp(1)' });
      expect(result.result).toBeCloseTo(Math.E, 10);
    });
  });

  describe('Complex Expressions', () => {
    it('should handle parentheses', () => {
      const result = service.evaluate({ expression: '(2 + 3) * 4' });
      expect(result.result).toBe(20);
    });

    it('should handle nested parentheses', () => {
      const result = service.evaluate({ expression: '((2 + 3) * (4 - 1))' });
      expect(result.result).toBe(15);
    });

    it('should handle mixed operations', () => {
      const result = service.evaluate({ expression: '2 + 3 * 4' });
      expect(result.result).toBe(14);
    });

    it('should handle complex trigonometric expression', () => {
      const result = service.evaluate({ expression: '2 * sin(30deg) + 5' });
      expect(result.result).toBeCloseTo(6, 10);
    });
  });

  describe('Format Options', () => {
    it('should return text format by default', () => {
      const result = service.evaluate({ expression: '2 + 3' });
      expect(result.result).toBeDefined();
      expect(result.latex).toBeUndefined();
    });

    it('should handle latex format', () => {
      const result = service.evaluate({ expression: '2 + 3', format: 'latex' });
      expect(result.result).toBeDefined();
    });

    it('should handle json format', () => {
      const result = service.evaluate({ expression: '2 + 3', format: 'json' });
      expect(result.result).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid expression', () => {
      expect(() => {
        service.evaluate({ expression: '2 + +' });
      }).toThrow('Math evaluation error');
    });
  });

  describe('Constants', () => {
    it('should handle pi', () => {
      const result = service.evaluate({ expression: 'pi' });
      expect(result.result).toBeCloseTo(Math.PI, 10);
    });

    it('should handle e', () => {
      const result = service.evaluate({ expression: 'e' });
      expect(result.result).toBeCloseTo(Math.E, 10);
    });
  });

  describe('Complex Numbers', () => {
    it('should handle imaginary unit i', () => {
      const result = service.evaluate({ expression: 'i^2' });
      expect(result.result).toBe('-1');
    });

    it('should calculate complex addition', () => {
      const result = service.evaluate({ expression: '(1 + 2i) + (3 + 4i)' });
      expect(result.result).toBeDefined();
    });
  });

  describe('Precision', () => {
    it('should handle default precision', () => {
      const result = service.evaluate({ expression: '1 / 3' });
      expect(result.result).toBeDefined();
    });

    it('should handle custom precision', () => {
      const result = service.evaluate({ expression: '1 / 3', precision: 5 });
      expect(result.result).toBeDefined();
    });
  });
});
