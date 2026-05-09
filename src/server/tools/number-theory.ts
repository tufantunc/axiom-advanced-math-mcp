import { giacEngine } from '../giac/index.js';
import { formatToolResponse, formatErrorResponse } from './response-formatter.js';
import { analyzeNumberCore } from './number-utils.js';
import { identifySequenceCore } from './sequence-utils.js';

async function primeFactorize(n: number) {
  const absN = Math.abs(n);
  if (absN < 2) {
    return formatToolResponse({
      result: String(absN),
      notes: [`${absN} has no prime factors.`],
    });
  }
  try {
    const result = await giacEngine.evaluate(`ifactor(${absN})`);
    return formatToolResponse({
      result: result.trim(),
      notes: [`Prime factorization of ${absN}: ${result.trim()}`],
    });
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}

async function analyzeNumber(n: number) {
  const lines = await analyzeNumberCore(n);
  return formatToolResponse({
    result: String(n),
    notes: lines,
  });
}

async function sequenceIdentify(terms: number[]) {
  const { lines, isError } = await identifySequenceCore(terms);
  if (isError) {
    return formatErrorResponse('Could not identify sequence pattern. Try providing more terms.');
  }
  const mainResult = lines.find((l) => l.startsWith('Formula:'))?.replace('Formula: ', '') ?? '';
  return formatToolResponse({ result: mainResult, notes: lines });
}

export async function numberTheoryHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    if (operation === 'prime_factorize') {
      const n = args.number as number | undefined;
      if (n === undefined) return formatErrorResponse("'number' is required for prime_factorize");
      return primeFactorize(n);
    }

    if (operation === 'analyze') {
      const n = args.number as number | undefined;
      if (n === undefined) return formatErrorResponse("'number' is required for analyze");
      return analyzeNumber(n);
    }

    if (operation === 'sequence_identify') {
      const seq = args.sequence as number[] | undefined;
      if (!seq || seq.length < 3)
        return formatErrorResponse(
          "'sequence' array with at least 3 terms is required for sequence_identify"
        );
      return sequenceIdentify(seq);
    }

    return formatErrorResponse(`Unknown operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
