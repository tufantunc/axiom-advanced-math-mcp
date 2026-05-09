import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { createSymbolicHandler } from '../src/server/tools/symbolic/handler.js';
import type { SymbolicToolDefinition } from '../src/server/tools/symbolic/types.js';

describe('Symbolic Handler', () => {
  beforeAll(async () => {
    await giacEngine.initialize();
  }, 60000);

  describe('LaTeX Normalization', () => {
    it('should normalize \\dfrac to \\frac in output', async () => {
      // Use a definition that produces a fraction result
      const def: SymbolicToolDefinition = {
        name: 'test_frac',
        description: 'test',
        params: [{ name: 'expression', type: 'string', description: 'expr', required: true }],
        buildGiacExpression: (args) => `simplify(${args.expression})`,
      };
      const handler = createSymbolicHandler(def);
      const result = await handler({ expression: '2/17' });

      expect(result.isError).toBe(false);
      const latexBlock = result.content.find((c) => c.text.startsWith('LaTeX:'));
      if (latexBlock) {
        // Must not contain \dfrac
        expect(latexBlock.text).not.toContain('\\dfrac');
      }
    });

    it('should not emit \\displaystyle in output', async () => {
      const def: SymbolicToolDefinition = {
        name: 'test_display',
        description: 'test',
        params: [{ name: 'expression', type: 'string', description: 'expr', required: true }],
        buildGiacExpression: (args) => `simplify(${args.expression})`,
      };
      const handler = createSymbolicHandler(def);
      const result = await handler({ expression: '1/3' });

      expect(result.isError).toBe(false);
      for (const block of result.content) {
        expect(block.text).not.toContain('\\displaystyle');
      }
    });
  });

  describe('Validation', () => {
    it('should return validation error for unbalanced parentheses', async () => {
      const def: SymbolicToolDefinition = {
        name: 'test_validate',
        description: 'test',
        params: [{ name: 'expression', type: 'string', description: 'expr', required: true }],
        buildGiacExpression: (args) => `simplify(${args.expression})`,
      };
      const handler = createSymbolicHandler(def);
      const result = await handler({ expression: '(x + 1' });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Validation error');
    });
  });

  describe('Result Content', () => {
    it('should include Result block in output', async () => {
      const def: SymbolicToolDefinition = {
        name: 'test_result',
        description: 'test',
        params: [{ name: 'expression', type: 'string', description: 'expr', required: true }],
        buildGiacExpression: (args) => `diff(${args.expression}, x)`,
      };
      const handler = createSymbolicHandler(def);
      const result = await handler({ expression: 'x^2' });

      expect(result.isError).toBe(false);
      const resultBlock = result.content.find((c) => c.text.startsWith('Result:'));
      expect(resultBlock).toBeDefined();
      expect(resultBlock?.text).toContain('2');
    });
  });
});
