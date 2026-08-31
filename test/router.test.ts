import { describe, it, expect } from 'vitest';
import { route } from '../src/server/tools/compute/router.js';

describe('Router', () => {
  describe('Solve system (rule 1)', () => {
    it('should route solve_system() call', () => {
      const result = route('solve_system([x+y=5, x-y=1], [x, y])');
      expect(result.handler).toBe('solve_system');
    });

    it('should route semicolon-separated equations', () => {
      const result = route('x+y=5; x-y=1');
      expect(result.handler).toBe('solve_system');
    });

    it('should route bracket format with multiple =', () => {
      const result = route('[x+y=5, x-y=1]');
      expect(result.handler).toBe('solve_system');
    });
  });

  describe('Solve equation (rule 2)', () => {
    it('should route solve() call', () => {
      const result = route('solve(x^2-4=0, x)');
      expect(result.handler).toBe('solve_equation');
    });

    it('should route csolve() call', () => {
      const result = route('csolve(x^2+1=0, x)');
      expect(result.handler).toBe('solve_equation');
      expect(result.args.domain).toBe('complex');
    });

    it('should route implicit equation with =', () => {
      const result = route('x^2 - 4 = 0');
      expect(result.handler).toBe('solve_equation');
    });

    it('should use complex domain when domain hint is complex', () => {
      const result = route('solve(x^2+1=0, x)', 'complex');
      expect(result.args.domain).toBe('complex');
    });
  });

  describe('Calculus - differentiate (rule 3)', () => {
    it('should route diff() call', () => {
      const result = route('diff(x^3, x)');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('differentiate');
      expect(result.args.expression).toBe('x^3');
      expect(result.args.variable).toBe('x');
    });

    it('should route diff with higher order', () => {
      const result = route('diff(x^5, x, 3)');
      expect(result.handler).toBe('calculus');
      expect(result.args.order).toBe(3);
    });

    it('should route differentiate() call', () => {
      const result = route('differentiate(sin(x), x)');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('differentiate');
    });
  });

  describe('Calculus - integrate (rule 4)', () => {
    it('should route int() call (indefinite)', () => {
      const result = route('int(x^2, x)');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('integrate');
      expect(result.args.expression).toBe('x^2');
    });

    it('should route integrate() with bounds', () => {
      const result = route('integrate(x^2, x, 0, 1)');
      expect(result.handler).toBe('calculus');
      expect(result.args.lower_bound).toBe('0');
      expect(result.args.upper_bound).toBe('1');
    });
  });

  describe('Calculus - limit (rule 5)', () => {
    it('should route limit() call', () => {
      const result = route('limit(sin(x)/x, x, 0)');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('limit');
      expect(result.args.point).toBe('0');
    });

    it('should route one-sided limit', () => {
      const result = route('limit(1/x, x, 0, +)');
      expect(result.handler).toBe('calculus');
      expect(result.args.direction).toBe('+');
    });
  });

  describe('Calculus - taylor (rule 6)', () => {
    it('should route taylor() call', () => {
      const result = route('taylor(exp(x), x=0, 5)');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('taylor');
      expect(result.args.expression).toBe('exp(x)');
      expect(result.args.variable).toBe('x');
      expect(result.args.point).toBe('0');
      expect(result.args.order).toBe(5);
    });
  });

  describe('Calculus - ODE (rule 7)', () => {
    it('should route desolve() call', () => {
      const result = route("desolve(y'=2*x, x, y)");
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('solve_ode');
    });

    it("should route implicit ODE with y'", () => {
      const result = route("y' = x^2 + y");
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('solve_ode');
    });

    it('should route ODE with dy/dx', () => {
      const result = route('dy/dx = x + 1');
      expect(result.handler).toBe('calculus');
      expect(result.args.operation).toBe('solve_ode');
    });
  });

  describe('Laplace (rule 8)', () => {
    it('should route laplace() to giac_raw', () => {
      const result = route('laplace(exp(-2*t), t, s)');
      expect(result.handler).toBe('giac_raw');
    });

    it('should route ilaplace() to giac_raw', () => {
      const result = route('ilaplace(1/(s+2), s, t)');
      expect(result.handler).toBe('giac_raw');
    });
  });

  describe('Algebra - factor (rule 9)', () => {
    it('should route factor() call', () => {
      const result = route('factor(x^2-4)');
      expect(result.handler).toBe('algebra');
      expect(result.args.operation).toBe('factor');
      expect(result.args.expression).toBe('x^2-4');
    });

    it('should route cfactor() with complex flag', () => {
      const result = route('cfactor(x^2+1)');
      expect(result.handler).toBe('algebra');
      expect(result.args.complex).toBe(true);
    });
  });

  describe('Algebra - simplify (rule 10)', () => {
    it('should route simplify() call', () => {
      const result = route('simplify((x^2-1)/(x-1))');
      expect(result.handler).toBe('algebra');
      expect(result.args.operation).toBe('simplify');
    });
  });

  describe('Algebra - expand (rule 11)', () => {
    it('should route expand() call', () => {
      const result = route('expand((x+1)^3)');
      expect(result.handler).toBe('algebra');
      expect(result.args.operation).toBe('expand');
    });
  });

  describe('Algebra - partial fractions (rule 12)', () => {
    it('should route partfrac() call', () => {
      const result = route('partfrac(1/(x^2-1), x)');
      expect(result.handler).toBe('algebra');
      expect(result.args.operation).toBe('partial_fractions');
    });
  });

  describe('Sum/product (rule 13)', () => {
    it('should route sum() to giac_raw', () => {
      const result = route('sum(k, k, 1, 100)');
      expect(result.handler).toBe('giac_raw');
    });

    it('should route product() to giac_raw', () => {
      const result = route('product(k, k, 1, 10)');
      expect(result.handler).toBe('giac_raw');
    });
  });

  describe('Vector calculus (rule 14)', () => {
    it('should route grad() to multivariable', () => {
      const result = route('grad(x^2+y^2, [x,y])');
      expect(result.handler).toBe('multivariable');
    });
  });

  describe('Matrix (rules 15-16)', () => {
    it('should route det() with matrix', () => {
      const result = route('det([[1,2],[3,4]])');
      expect(result.handler).toBe('matrix');
      expect(result.args.operation).toBe('determinant');
    });

    it('should route eigenvals() with matrix', () => {
      const result = route('eigenvals([[2,1],[1,2]])');
      expect(result.handler).toBe('matrix');
      expect(result.args.operation).toBe('eigenvalues');
    });

    it('should route svd() with matrix', () => {
      const result = route('svd([[1,2],[3,4]])');
      expect(result.handler).toBe('matrix');
      expect(result.args.operation).toBe('svd');
    });
  });

  describe('Number theory (rule 17)', () => {
    it('should route ifactor()', () => {
      const result = route('ifactor(2310)');
      expect(result.handler).toBe('number_theory');
      expect(result.args.operation).toBe('prime_factorize');
    });

    it('should route isprime()', () => {
      const result = route('isprime(17)');
      expect(result.handler).toBe('number_theory');
    });
  });

  describe('Combinatorics (rule 18)', () => {
    it('should route C(10,3)', () => {
      const result = route('C(10, 3)');
      expect(result.handler).toBe('combinatorics');
      expect(result.args.operation).toBe('combinations');
      expect(result.args.n).toBe(10);
      expect(result.args.k).toBe(3);
    });

    it('should route P(5,2)', () => {
      const result = route('P(5, 2)');
      expect(result.handler).toBe('combinatorics');
      expect(result.args.operation).toBe('permutations');
    });

    it('should route bell keyword', () => {
      const result = route('bell(10)');
      expect(result.handler).toBe('combinatorics');
      expect(result.args.operation).toBe('bell_number');
    });

    it('should route catalan keyword', () => {
      const result = route('catalan(5)');
      expect(result.handler).toBe('combinatorics');
      expect(result.args.operation).toBe('catalan_number');
    });
  });

  describe('Probability (rule 19)', () => {
    it('should route binomial distribution', () => {
      const result = route('binomial(n=10, p=0.5, x=3, cdf)');
      expect(result.handler).toBe('probability');
      expect(result.args.distribution).toBe('binomial');
      expect(result.args.params.n).toBe(10);
      expect(result.args.params.p).toBe(0.5);
      expect(result.args.x).toBe(3);
    });

    it('should route normal distribution', () => {
      const result = route('normal(mu=0, sigma=1, x=1.96, cdf)');
      expect(result.handler).toBe('probability');
      expect(result.args.distribution).toBe('normal');
    });
  });

  describe('Hypothesis testing (rule 20)', () => {
    it('should route t_test keyword', () => {
      const result = route('t_test({"sample1": [1,2,3], "mu0": 2})');
      expect(result.handler).toBe('hypothesis_testing');
    });

    it('should route anova keyword', () => {
      const result = route('anova({"groups": [[1,2,3],[4,5,6]]})');
      expect(result.handler).toBe('hypothesis_testing');
      expect(result.args.test).toBe('one_way_anova');
    });
  });

  describe('Geometry (rule 22)', () => {
    it('should route distance()', () => {
      const result = route('distance([0,0], [3,4])');
      expect(result.handler).toBe('geometry');
      expect(result.args.operation).toBe('distance');
    });

    it('should route area()', () => {
      const result = route('area([0,0], [3,0], [0,4])');
      expect(result.handler).toBe('geometry');
    });
  });

  describe('Numerical methods (rule 23)', () => {
    it('should route newton()', () => {
      const result = route('newton(x^2-2, x, 1.5)');
      expect(result.handler).toBe('numerical_methods');
      expect(result.args.method).toBe('newton_raphson');
    });

    it('should route with numeric domain hint', () => {
      const result = route('x^2-2=0', 'numeric');
      expect(result.handler).toBe('numerical_methods');
    });
  });

  describe('Exact value (rule 24)', () => {
    it('should route to_exact()', () => {
      const result = route('to_exact(0.333333)');
      expect(result.handler).toBe('exact_value');
      expect(result.args.operation).toBe('to_exact');
    });

    it('should route to_decimal()', () => {
      const result = route('to_decimal(1/3)');
      expect(result.handler).toBe('exact_value');
      expect(result.args.operation).toBe('to_decimal');
    });
  });

  describe('Quick calc (rule 28)', () => {
    it('should route simple arithmetic', () => {
      const result = route('2 + 3 * 4');
      expect(result.handler).toBe('quick_calc');
    });

    it('should route trig expression', () => {
      const result = route('sin(pi/4) + cos(pi/3)');
      expect(result.handler).toBe('quick_calc');
    });

    it('should route sqrt expression', () => {
      const result = route('sqrt(144) + 2^10');
      expect(result.handler).toBe('quick_calc');
    });
  });

  describe('Giac raw fallback (rule 29)', () => {
    it('should fallback for unknown expressions', () => {
      const result = route('some_unknown_giac_function(x)');
      expect(result.handler).toBe('giac_raw');
    });
  });

  describe('Priority ordering', () => {
    it('should prefer solve over quick_calc for equations with =', () => {
      const result = route('x^2 - 4 = 0');
      expect(result.handler).toBe('solve_equation');
    });

    it('should prefer diff over giac_raw', () => {
      const result = route('diff(x^2, x)');
      expect(result.handler).toBe('calculus');
    });

    it('should prefer system solver over single solve for multiple equations', () => {
      const result = route('x+y=5; x-y=1');
      expect(result.handler).toBe('solve_system');
    });
  });
});
