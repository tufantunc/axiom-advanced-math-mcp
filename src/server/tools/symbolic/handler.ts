import { giacEngine } from '../../giac/index.js';
import type { SymbolicToolDefinition } from './types.js';
import { validateExpression } from './validator.js';
import { evaluationCache } from './cache.js';

function normalizeLaTeX(s: string): string {
  return s
    .replace(/\\dfrac\b/g, '\\frac')
    .replace(/\\displaystyle\s*/g, '')
    .replace(/\\textstyle\s*/g, '');
}

export function createSymbolicHandler(definition: SymbolicToolDefinition) {
  return async (args: Record<string, unknown>) => {
    try {
      const giacExpression = definition.buildGiacExpression(args);

      // Pre-flight validation on all string args that look like expressions
      for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string' && key !== 'operation' && key !== 'domain' && key !== 'direction' && key !== 'type') {
          const error = validateExpression(value);
          if (error) {
            return {
              content: [{ type: 'text' as const, text: `Validation error in '${key}': ${error.message}` }],
              isError: true,
            };
          }
        }
      }

      // Check cache
      const cached = evaluationCache.get(giacExpression);
      if (cached) {
        const content: { type: 'text'; text: string }[] = [
          { type: 'text', text: `Result: ${cached.result}` },
        ];
        if (cached.latex) {
          content.push({ type: 'text', text: `LaTeX: ${cached.latex}` });
        }
        content.push({ type: 'text', text: `Giac command: ${giacExpression}` });
        return { content, isError: false };
      }

      // Evaluate
      const result = await giacEngine.evaluate(giacExpression);

      const content: { type: 'text'; text: string }[] = [];
      content.push({ type: 'text', text: `Result: ${result}` });

      // LaTeX rendering — use tex() on the result string for more reliable output
      let latexStr: string | undefined;
      try {
        const rawLatex = await giacEngine.evaluate(`latex(${result})`);
        if (rawLatex && rawLatex !== 'undef' && !rawLatex.startsWith('latex')) {
          latexStr = normalizeLaTeX(rawLatex);
          content.push({ type: 'text', text: `LaTeX: ${latexStr}` });
        }
      } catch {
        // LaTeX rendering is best-effort
      }

      // Extract variables using lname()
      try {
        const vars = await giacEngine.evaluate(`lname(${args.expression || giacExpression})`);
        if (vars && vars !== '[]' && vars !== 'undef') {
          content.push({ type: 'text', text: `Variables: ${vars}` });
        }
      } catch {
        // Variable extraction is best-effort
      }

      content.push({ type: 'text', text: `Giac command: ${giacExpression}` });

      // Cache the result
      evaluationCache.set(giacExpression, { result, latex: latexStr });

      return { content, isError: false };
    } catch (error) {
      return {
        content: [
          { type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` },
        ],
        isError: true,
      };
    }
  };
}
