import { vi } from 'vitest';

export const giacEngine = {
  async initialize() {
  },
  async evaluate(expression: string) {
    if (expression.includes('diff')) {
      return '2*x';
    }
    if (expression.includes('int')) {
      if (expression.match(/int\(x\^2,/)) {
        return 'x^3/3';
      }
      if (expression.match(/int\(sin\(x\)/)) {
        return '-cos(x)';
      }
      if (expression.match(/int\(cos\(x\)/)) {
        return 'sin(x)';
      }
      if (expression.match(/int\(exp\(x\)/)) {
        return 'exp(x)';
      }
      throw new Error('Invalid syntax');
    }
    if (expression.includes('limit')) {
      return '0';
    }
    if (expression.includes('solve')) {
      return '[2]';
    }
    if (expression.includes('factor')) {
      return '(x-2)*(x+2)';
    }
    if (expression.includes('expand')) {
      return 'x^2+2*x+1';
    }
    if (expression.includes('simplify')) {
      return 'x+1';
    }
    if (expression.includes('desolve')) {
      return 'x^2/2+c0';
    }
    if (expression.includes('tex')) {
      return '\\\\' + expression;
    }
    return expression;
  }
};
