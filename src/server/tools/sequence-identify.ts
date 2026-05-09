import { identifySequenceCore } from './sequence-utils.js';
import { formatRawResponse, formatRawError } from './response-formatter.js';

export async function sequenceIdentifyHandler(args: Record<string, unknown>) {
  const terms = args.terms as number[];

  try {
    const { lines } = await identifySequenceCore(terms);
    lines.push('Suggestion: Try providing more terms or check if the sequence is correct.');
    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
