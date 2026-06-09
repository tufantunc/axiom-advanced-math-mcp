import { toNumber, extractModelAnswer } from './answer-parser.js';
import { gradeV2Async } from './grader-v2.js';
import { getDefaultGiacBridge } from './giac-bridge.js';

const NUMERIC_TOLERANCE = 1e-6;

export interface GradeResult {
  correct: boolean;
  predicted: string;
  ground: string;
  method: 'numeric' | 'symbolic' | 'string' | 'fallback';
}

/**
 * Grade a model's response against the ground truth using grader-v2.
 *
 * v2's pipeline (exact → normalized → numeric → set → interval → symbolic-equiv,
 * plus optional v3 stages when AXIOM_GRADER_V3=1) is the production grader.
 * This function maps v2's method enum to v1's enum so existing report
 * consumers continue to work.
 *
 * Tries v2 on both the extracted answer AND the raw model response — the
 * extractor sometimes strips useful structure (e.g., set expressions like
 * "\{1, 2\}" extracted to just "2"); the raw response retains it.
 */
export async function grade(modelResponse: string, groundTruth: string): Promise<GradeResult> {
  const predicted = extractModelAnswer(modelResponse);
  const ground = groundTruth.trim();

  const bridge = await getDefaultGiacBridge();
  const giacEval = (expr: string) => bridge.evaluate(expr);

  const v2Extracted = await gradeV2Async(predicted, ground, { giacEval });
  const v2Raw =
    predicted === modelResponse.trim()
      ? v2Extracted
      : await gradeV2Async(modelResponse.trim(), ground, { giacEval });
  const v2 = v2Extracted.match ? v2Extracted : v2Raw;

  return {
    correct: v2.match,
    predicted,
    ground,
    method: mapV2Method(v2.method),
  };
}

/**
 * Map grader-v2's fine-grained method enum to v1's coarse enum so the
 * existing JSONL/report shape stays compatible with consumers.
 */
function mapV2Method(v2Method: string): GradeResult['method'] {
  if (v2Method === 'numeric') return 'numeric';
  if (
    v2Method === 'symbolic' ||
    v2Method === 'set' ||
    v2Method === 'interval' ||
    v2Method === 'conditional' ||
    v2Method === 'normalized' ||
    v2Method === 'equation-rhs-match'
  ) {
    return 'symbolic';
  }
  if (v2Method === 'exact') return 'string';
  return 'fallback';
}

/**
 * Grade for GSM8K — ground truth is a pre-extracted number.
 * Independent of the v2 pipeline (operates on pre-parsed numerics).
 */
export function gradeNumeric(modelResponse: string, groundTruth: number): GradeResult {
  const predicted = extractModelAnswer(modelResponse);
  const predNum = toNumber(predicted);

  return {
    correct: predNum !== null && Math.abs(predNum - groundTruth) <= NUMERIC_TOLERANCE,
    predicted,
    ground: String(groundTruth),
    method: 'numeric',
  };
}
