import { analyzeNumberCore } from './number-utils.js';
import { formatRawResponse, formatRawError } from './response-formatter.js';

export async function numberPropertiesHandler(args: Record<string, unknown>) {
  const n = args.number as number;

  try {
    const lines = await analyzeNumberCore(n);
    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
