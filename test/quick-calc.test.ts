import { describe, it, expect, beforeAll } from 'vitest';
import { QuickCalcService } from '../src/server/tools/quick-calc-service.js';
import { quickCalcHandler } from '../src/server/tools/quick-calc.js';
import { tryExactResult } from '../src/server/tools/exact-arithmetic.js';
import { giacEngine } from '../src/server/giac/index.js';

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

  describe('a non-finite result is not presented as a plain answer', () => {
    it('refuses NaN rather than answering it', async () => {
      const service = new QuickCalcService();
      await expect(service.evaluate({ expression: '0/0' })).rejects.toThrow(/NaN|undefined/);
    });

    it('refuses a Complex whose components are NaN', async () => {
      // Bare `.rejects.toThrow()` could not tell "refused for being NaN" from
      // "refused at all", so any unrelated failure satisfied it.
      const service = new QuickCalcService();
      await expect(service.evaluate({ expression: 'sqrt(-1)*0/0' })).rejects.toThrow(
        /evaluated to NaN/
      );
    });

    it('refuses the same Complex when precision is supplied', async () => {
      // The old check compared the whole rendered string to 'NaN'. Under
      // `precision` mathjs renders the same value as "NaN + NaNi", so passing a
      // documented parameter walked straight past the guard.
      const service = new QuickCalcService();
      await expect(
        service.evaluate({ expression: 'sqrt(-1)*0/0', precision: 10 })
      ).rejects.toThrow(/evaluated to NaN/);
    });

    it('refuses a NaN inside a container', async () => {
      const service = new QuickCalcService();
      await expect(service.evaluate({ expression: '[1, 0/0]' })).rejects.toThrow(
        /evaluated to NaN/
      );
    });

    it('does not refuse a string that merely spells NaN', async () => {
      const service = new QuickCalcService();
      expect((await service.evaluate({ expression: '"NaN"' })).result).toBe('NaN');
    });

    it('still returns Infinity, which is a different case from NaN', async () => {
      const service = new QuickCalcService();
      expect((await service.evaluate({ expression: '1/0' })).result).toBe(Infinity);
    });
  });

  describe('non-finite detection walks the value, not its rendering', () => {
    it.each([
      // Each of these needed a branch the others do not exercise.
      ['[{a: 0/0}]'],          // plain object inside an array — the generic walk
      ['{a: 0/0}'],            // plain object at the top level
      ['1;0/0'],               // ResultSet, from a multi-statement expression
      ['0/0 m'],               // Unit — value, no isNaN()
      ['[[[[[[[[0/0]]]]]]]]'], // deep nesting: the old cap answered this at depth 8
    ])('refuses %s', async (expression) => {
      const service = new QuickCalcService();
      await expect(service.evaluate({ expression })).rejects.toThrow(/evaluated to NaN/);
    });

    it('refuses a Decimal NaN — the isNaN/isFinite branch, not the generic walk', async () => {
      // A real Decimal, which `0/0` is NOT: precision only changes formatting, so
      // that expression stays a plain number. This distinction is load-bearing —
      // Object.values(bignumber(0)/bignumber(0)) is [null,null,null,null], so the
      // generic walk alone reports a Decimal NaN clean. Only asking the value
      // itself works, which is why the isNaN/isFinite branch must precede it.
      const service = new QuickCalcService();
      await expect(
        service.evaluate({ expression: 'bignumber(0)/bignumber(0)' })
      ).rejects.toThrow(/evaluated to NaN/);
    });

    it('flags a Decimal infinity through the same branch', async () => {
      const service = new QuickCalcService();
      const r = await service.evaluate({ expression: 'bignumber(1)/bignumber(0)' });
      expect(r.nonFinite).toBe(true);
    });

    it.each([
      ['1/0 m', 'Infinity m'],
      ['[1, 1/0]', '[1, Infinity]'],
    ])('flags %s as non-finite without refusing it', async (expression, expected) => {
      const service = new QuickCalcService();
      const r = await service.evaluate({ expression });
      expect(r.result).toBe(expected);
      expect(r.nonFinite).toBe(true);
    });

    it.each([
      '2+2',
      '[[1,2],[3,4]]',
      'fraction(1,3)',
      '5 m/s',
      '"NaN"',
      '1;2;3',
      // These two are the ONLY shapes that reach the isNaN/isFinite branch, so
      // without them `infinite: true` in that branch flags every BigNumber and
      // Complex answer as infinite with the suite green.
      'bignumber(1)/bignumber(3)',
      'sqrt(-1)+1',
    ])(
      'does not flag the finite value %s',
      async (expression) => {
        const service = new QuickCalcService();
        expect((await service.evaluate({ expression })).nonFinite).toBe(false);
      }
    );
  });

  describe('a self-referential value is answered, not refused as too deep', () => {
    it('walks a cycle without hitting the depth cap', async () => {
      // mathjs really does build one from a caller expression. Without the
      // WeakSet the depth counter runs to the cap and refuses this.
      const service = new QuickCalcService();
      const r = await service.evaluate({ expression: 'a={}; a.b=a; a' });
      expect(String(r.result)).toContain('object Object');
    });

    it('still finds a NaN inside a cyclic value', async () => {
      const service = new QuickCalcService();
      await expect(
        service.evaluate({ expression: 'a={}; a.b=a; a.c=0/0; a' })
      ).rejects.toThrow(/evaluated to NaN/);
    });
  });
});

// Degree handling spans two evaluators: the preprocessor turns '90°' into the
// mathjs 'deg' unit, and the exact path rewrites it to '(90*pi/180)' for Giac.
// Both rewrites were once completely unpinned — the suite stayed green with
// either rule deleted — so each path is asserted end-to-end here.
describe('degree expressions', () => {
  beforeAll(async () => {
    await giacEngine.initialize();
  }, 60000);

  it('the mathjs path evaluates sin(90°) to 1 through the handler', async () => {
    const r = await quickCalcHandler({ expression: 'sin(90°)' });
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toBe('Result: 1');
  });

  it('the Giac exact path converts degrees to radians exactly', async () => {
    // sin(60°) is irrational, so the fraction path declines and the Giac
    // rewrite '60°' -> '(60*pi/180)' runs before evaluation.
    const exact = await tryExactResult('sin(60°)', Math.sin(Math.PI / 3));
    expect(exact).not.toBeNull();
    expect(exact?.exact).toBe('√3/2');
  });
});
