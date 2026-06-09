import { extractModelAnswer } from './graders/answer-parser.js';

/**
 * The answer string to grade for one run condition: re-extract from the raw
 * response when present (so extraction changes are measured offline), else fall
 * back to the stored post-extraction answer (backward compatible with old
 * traces that have no `response`).
 */
export function answerToGrade(cond: { response?: string; extractedAnswer: string }): string {
  return cond.response !== undefined && cond.response !== ''
    ? extractModelAnswer(cond.response)
    : cond.extractedAnswer;
}
