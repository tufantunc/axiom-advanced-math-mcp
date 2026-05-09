import { route } from './router.js';
import { dispatch } from './dispatcher.js';
import { normalize } from './normalize.js';
import { computeSchema } from './schema.js';
import type { ComputeEnvelope } from './types.js';
import { applyHygiene } from './hygiene.js';
import { giacEngine } from '../../giac/index.js';

export { computeSchema } from './schema.js';
export type { ComputeEnvelope, ResultType } from './types.js';

/**
 * Main compute handler — single gateway for all math computations.
 *
 * Flow:
 * 1. Route: pattern-match the problem string → handler key + extracted args
 * 2. Dispatch: call the existing handler with extracted args
 * 3. Normalize: convert MCP response → ComputeEnvelope
 * 4. Format: return based on format preference (text/latex/json)
 */
export async function computeHandler(
  args: Record<string, unknown>
): Promise<{ content: { type: 'text'; text: string }[]; isError: boolean }> {
  const problem = args.problem as string;
  const domain = args.domain as string | undefined;
  const format = (args.format as string) || 'text';

  try {
    // 1. Route
    const { handler, args: handlerArgs } = route(problem, domain);

    // Apply precision if provided
    if (args.precision !== undefined && handlerArgs.precision === undefined) {
      handlerArgs.precision = args.precision;
    }

    // 2. Dispatch
    const response = await dispatch(handler, handlerArgs);

    // 3. Normalize
    let envelope = normalize(response, handler, handlerArgs);

    // 3.5 Optional hygiene pass (Unicode normalize, silent-failure warn,
    //     conservative simplify) — gated behind --features=output-hygiene.
    if (process.env.AXIOM_COMPUTE_HYGIENE === '1') {
      envelope = await applyHygiene(envelope, giacEngine);
    }

    // 4. Format output
    return formatOutput(envelope, format, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: `Error: ${message}` }],
      isError: true,
    };
  }
}

function formatOutput(
  envelope: ComputeEnvelope,
  format: string,
  rawResponse: { content: { type: 'text'; text: string }[]; isError: boolean }
): { content: { type: 'text'; text: string }[]; isError: boolean } {
  switch (format) {
    case 'json':
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
        isError: !envelope.success,
      };
    case 'latex':
      if (envelope.latex) {
        return {
          content: [
            { type: 'text' as const, text: `Result: ${envelope.display}` },
            { type: 'text' as const, text: `LaTeX: ${envelope.latex}` },
            ...(envelope.giac_command
              ? [{ type: 'text' as const, text: `Command: ${envelope.giac_command}` }]
              : []),
          ],
          isError: !envelope.success,
        };
      }
      return rawResponse;
    case 'text':
    default:
      if (envelope.warnings && envelope.warnings.length > 0) {
        const warnLines = envelope.warnings.map((w) => ({
          type: 'text' as const,
          text: `[Warning: ${w}]`,
        }));
        return {
          content: [...warnLines, ...rawResponse.content],
          isError: rawResponse.isError,
        };
      }
      return rawResponse;
  }
}
