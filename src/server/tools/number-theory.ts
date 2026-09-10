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

async function runPrimeFactorize(args: Record<string, unknown>) {
  const n = args.number as number | undefined;
  if (n === undefined) return formatErrorResponse("'number' is required for prime_factorize");
  // The extractors run Number.parseInt on the caller's text with no NaN
  // check, so `ifactor(foo)` arrives here as NaN and used to be answered
  // ("NaN has no prime factors", isError:false). Refused, not answered.
  if (!Number.isFinite(n)) {
    return formatErrorResponse('number must be a finite integer, e.g. ifactor(360)');
  }
  return await primeFactorize(n);
}

async function runAnalyze(args: Record<string, unknown>) {
  const n = args.number as number | undefined;
  if (n === undefined) return formatErrorResponse("'number' is required for analyze");
  // Same extractor gap: `isprime(x)` / `euler(n)` arrive as NaN and
  // analyzeNumberCore used to ship its degenerate report at isError:false.
  if (!Number.isFinite(n)) {
    return formatErrorResponse('number must be a finite integer, e.g. isprime(97)');
  }
  return await analyzeNumber(n);
}

async function runSequenceIdentify(args: Record<string, unknown>) {
  const seq = args.sequence as number[] | undefined;
  if (!seq || seq.length < 3)
    return formatErrorResponse(
      "'sequence' array with at least 3 terms is required for sequence_identify"
    );
  return await sequenceIdentify(seq);
}

export async function numberTheoryHandler(args: Record<string, unknown>) {
  try {
    const operation = args.operation as string;

    if (operation === 'prime_factorize') return await runPrimeFactorize(args);
    if (operation === 'analyze') return await runAnalyze(args);
    if (operation === 'sequence_identify') return await runSequenceIdentify(args);

    return formatErrorResponse(`Unknown operation: ${operation}`);
  } catch (error) {
    return formatErrorResponse(error instanceof Error ? error.message : String(error));
  }
}
