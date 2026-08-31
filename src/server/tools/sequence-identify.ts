import { identifySequenceCore } from './sequence-utils.js';
import { formatRawResponse, formatRawError, formatErrorResponse } from './response-formatter.js';

export async function sequenceIdentifyHandler(args: Record<string, unknown>) {
  const terms = args.terms as number[];

  try {
    const { lines, isError } = await identifySequenceCore(terms);
    if (isError) return formatErrorResponse(lines.join(' '));
    lines.push('Suggestion: Try providing more terms or check if the sequence is correct.');
    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
