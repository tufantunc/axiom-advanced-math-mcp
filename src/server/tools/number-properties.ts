import { analyzeNumberCore } from './number-utils.js';
import { formatRawResponse, formatRawError } from './response-formatter.js';

export async function numberPropertiesHandler(args: Record<string, unknown>) {
  const n = args.number as number;

  // The extractor's parseInt passes `number_properties(foo)` straight through
  // as NaN; analyzeNumberCore would ship its degenerate report at
  // isError:false. Refused, not answered.
  if (!Number.isFinite(n)) {
    return formatRawError(
      new Error('number must be a finite integer, e.g. number_properties(360)')
    );
  }

  try {
    const lines = await analyzeNumberCore(n);
    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
