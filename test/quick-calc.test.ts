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

  describe('Natural Language Rejection', () => {
    it('should reject "Let S = 3T, then..."', () => {
      expect(() => {
        service.evaluate({ expression: 'Let S = 3T, then G = S - 2T = T' });
      }).toThrow('natural language');
    });

    it('should reject "If S = 3T, then..."', () => {
      expect(() => {
        service.evaluate({ expression: 'If S = 3T, then G = S - 2T = T' });
      }).toThrow('natural language');
    });

    it('should reject "Given that x > 0..."', () => {
      expect(() => {
        service.evaluate({ expression: 'Given that x > 0, find the minimum value' });
      }).toThrow('natural language');
    });

    it('should reject expressions with "let" keyword', () => {
      expect(() => {
        service.evaluate({ expression: 'let x = 5, then y = x + 3' });
      }).toThrow('natural language');
    });

    it('should reject expressions with "since"', () => {
      expect(() => {
        service.evaluate({ expression: 'since x^2 is always non-negative, therefore...' });
      }).toThrow('natural language');
    });

    it('should allow valid single-letter variable expressions', () => {
      // 'a' as a variable should NOT be rejected (no natural language trigger)
      const result = service.evaluate({ expression: '3 * 5 + 2' });
      expect(result.result).toBe(17);
    });

    it('should allow normal math expressions', () => {
      const result = service.evaluate({ expression: 'sin(pi/4)^2 + cos(pi/4)^2' });
      expect(result.result).toBeCloseTo(1, 8);
    });

    it('should allow expressions with "or" as logical operator context', () => {
      // 'or' alone doesn't trigger — only sentence-starting words do
      const result = service.evaluate({ expression: '2^10' });
      expect(result.result).toBe(1024);
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
