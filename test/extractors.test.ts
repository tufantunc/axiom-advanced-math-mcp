import { describe, it, expect } from 'vitest';
import {
  extractDiff,
  extractIntegrate,
  extractLimit,
  extractTaylor,
  extractOde,
  extractSolveEquation,
  extractSolveSystem,
  extractFactor,
  extractSimplify,
  extractExpand,
  extractPartfrac,
  extractMatrix,
  extractCombinatorics,
  extractQuickCalc,
  extractGiacRaw,
  extractExactValue,
  extractNumberTheory,
  extractGeometry,
  extractNumericalMethods,
  extractSequenceIdentify,
} from '../src/server/tools/compute/extractors.js';

describe('Extractors', () => {
  describe('extractDiff', () => {
    it('should extract expression and variable', () => {
      const result = extractDiff('diff(x^3, x)');
      expect(result.args.expression).toBe('x^3');
      expect(result.args.variable).toBe('x');
      expect(result.args.operation).toBe('differentiate');
    });

    it('should extract higher order', () => {
      const result = extractDiff('diff(x^5, x, 3)');
      expect(result.args.order).toBe(3);
    });

    it('should guess variable if not provided', () => {
      const result = extractDiff('diff(t^2)');
      expect(result.args.variable).toBe('t');
    });
  });

  describe('extractIntegrate', () => {
    it('should extract indefinite integral', () => {
      const result = extractIntegrate('int(x^2, x)');
      expect(result.args.expression).toBe('x^2');
      expect(result.args.variable).toBe('x');
      expect(result.args.lower_bound).toBeUndefined();
    });

    it('should extract definite integral with bounds', () => {
      const result = extractIntegrate('integrate(x^2, x, 0, 1)');
      expect(result.args.lower_bound).toBe('0');
      expect(result.args.upper_bound).toBe('1');
    });
  });

  describe('extractLimit', () => {
    it('should extract limit with point', () => {
      const result = extractLimit('limit(sin(x)/x, x, 0)');
      expect(result.args.expression).toBe('sin(x)/x');
      expect(result.args.point).toBe('0');
    });

    it('should extract one-sided limit', () => {
      const result = extractLimit('limit(1/x, x, 0, +)');
      expect(result.args.direction).toBe('+');
    });
  });

  describe('extractTaylor', () => {
    it('should extract with var=point syntax', () => {
      const result = extractTaylor('taylor(exp(x), x=0, 5)');
      expect(result.args.expression).toBe('exp(x)');
      expect(result.args.variable).toBe('x');
      expect(result.args.point).toBe('0');
      expect(result.args.order).toBe(5);
    });

    it('should extract with separate point arg', () => {
      const result = extractTaylor('taylor(sin(t), t, 0, 4)');
      expect(result.args.variable).toBe('t');
      expect(result.args.point).toBe('0');
      expect(result.args.order).toBe(4);
    });
  });

  describe('extractOde', () => {
    it('should extract desolve format', () => {
      const result = extractOde("desolve(y'=2*x, x, y)");
      expect(result.args.operation).toBe('solve_ode');
      expect(result.args.equation).toBe("y'=2*x");
    });

    it('should handle implicit ODE', () => {
      const result = extractOde("y' = x^2 + y");
      expect(result.args.operation).toBe('solve_ode');
      expect(result.args.variable).toBe('x');
      expect(result.args.function_name).toBe('y');
    });
  });

  describe('extractSolveEquation', () => {
    it('should extract from solve() call', () => {
      const result = extractSolveEquation('solve(x^2-4=0, x)');
      expect(result.args.equation).toBe('x^2-4=0');
      expect(result.args.variable).toBe('x');
    });

    it('should detect complex from csolve', () => {
      const result = extractSolveEquation('csolve(x^2+1=0, x)');
      expect(result.args.domain).toBe('complex');
    });

    it('should handle implicit equation', () => {
      const result = extractSolveEquation('x^2 - 4 = 0');
      expect(result.args.equation).toBe('x^2 - 4 = 0');
    });
  });

  describe('extractSolveSystem', () => {
    it('should extract from solve_system() call', () => {
      const result = extractSolveSystem('solve_system([x+y=5, x-y=1], [x, y])');
      expect(result.args.equations).toEqual(['x+y=5', 'x-y=1']);
      expect(result.args.variables).toEqual(['x', 'y']);
    });

    it('should extract from semicolon format', () => {
      const result = extractSolveSystem('x+y=5; x-y=1');
      expect(result.args.equations).toEqual(['x+y=5', 'x-y=1']);
    });
  });

  describe('extractFactor', () => {
    it('should extract expression', () => {
      const result = extractFactor('factor(x^2-4)');
      expect(result.args.expression).toBe('x^2-4');
      expect(result.args.operation).toBe('factor');
    });

    it('should set complex flag for cfactor', () => {
      const result = extractFactor('cfactor(x^2+1)');
      expect(result.args.complex).toBe(true);
    });
  });

  describe('extractSimplify', () => {
    it('should extract expression', () => {
      const result = extractSimplify('simplify((x^2-1)/(x-1))');
      expect(result.args.expression).toBe('(x^2-1)/(x-1)');
    });
  });

  describe('extractExpand', () => {
    it('should extract expression', () => {
      const result = extractExpand('expand((x+1)^3)');
      expect(result.args.expression).toBe('(x+1)^3');
    });
  });

  describe('extractPartfrac', () => {
    it('should extract expression and variable', () => {
      const result = extractPartfrac('partfrac(1/(x^2-1), x)');
      expect(result.args.expression).toBe('1/(x^2-1)');
      expect(result.args.variable).toBe('x');
    });
  });

  describe('extractMatrix', () => {
    it('should extract det operation', () => {
      const result = extractMatrix('det([[1,2],[3,4]])');
      expect(result.args.operation).toBe('determinant');
      expect(result.args.matrix).toBe('[[1,2],[3,4]]');
    });

    it('should extract eigenvals operation', () => {
      const result = extractMatrix('eigenvals([[2,1],[1,2]])');
      expect(result.args.operation).toBe('eigenvalues');
    });

    it('should extract svd operation', () => {
      const result = extractMatrix('svd([[1,0],[0,1]])');
      expect(result.args.operation).toBe('svd');
    });
  });

  describe('extractCombinatorics', () => {
    it('should extract C(n,k)', () => {
      const result = extractCombinatorics('C(10, 3)');
      expect(result.args.operation).toBe('combinations');
      expect(result.args.n).toBe(10);
      expect(result.args.k).toBe(3);
    });

    it('should extract P(n,k)', () => {
      const result = extractCombinatorics('P(5, 2)');
      expect(result.args.operation).toBe('permutations');
      expect(result.args.n).toBe(5);
      expect(result.args.k).toBe(2);
    });

    it('should extract bell number', () => {
      const result = extractCombinatorics('bell(10)');
      expect(result.args.operation).toBe('bell_number');
    });
  });

  describe('extractQuickCalc', () => {
    it('should pass expression through', () => {
      const result = extractQuickCalc('2 + 3 * 4');
      expect(result.args.expression).toBe('2 + 3 * 4');
    });
  });

  describe('extractGiacRaw', () => {
    it('should pass expression through', () => {
      const result = extractGiacRaw('laplace(exp(-2*t), t, s)');
      expect(result.args.expression).toBe('laplace(exp(-2*t), t, s)');
    });
  });

  describe('extractExactValue', () => {
    it('should detect to_exact operation', () => {
      const result = extractExactValue('to_exact(0.333333)');
      expect(result.args.operation).toBe('to_exact');
      // `value`, not `expression`: this is the field exactValueHandler reads.
      // Pinning the extractor's old output in isolation is what let the two
      // sides disagree — the handler crashed on undefined while this passed.
      expect(result.args.value).toBe('0.333333');
    });

    it('should detect to_decimal operation', () => {
      const result = extractExactValue('to_decimal(1/3)');
      expect(result.args.operation).toBe('to_decimal');
    });
  });

  describe('extractNumberTheory', () => {
    it('should extract ifactor', () => {
      const result = extractNumberTheory('ifactor(2310)');
      expect(result.args.operation).toBe('prime_factorize');
      expect(result.args.number).toBe(2310);
    });
  });

  describe('extractGeometry', () => {
    it('should extract distance operation', () => {
      const result = extractGeometry('distance([0,0], [3,4])');
      expect(result.args.operation).toBe('distance');
    });
  });

  describe('extractNumericalMethods', () => {
    it('should extract newton method', () => {
      const result = extractNumericalMethods('newton(x^2-2, x, 1.5)');
      expect(result.args.method).toBe('newton_raphson');
      expect(result.args.expression).toBe('x^2-2');
      expect(result.args.initial_guess).toBe(1.5);
    });
  });

  describe('extractSequenceIdentify', () => {
    it('parses a clean numeric list', () => {
      const result = extractSequenceIdentify('sequence_identify(1, 4, 9, 16)');
      expect(result.handler).toBe('sequence_identify');
      expect(result.args.terms).toEqual([1, 4, 9, 16]);
    });

    it('refuses the whole list when any term is not numeric', () => {
      // Strict by design upstream: silently dropping junk terms made a
      // malformed sequence look like a shorter valid one.
      const result = extractSequenceIdentify('sequence_identify(1, x, 4, 9, 16)');
      expect(result.args.terms).toEqual([]);
    });
  });
});
