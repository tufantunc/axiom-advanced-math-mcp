import { extractModelAnswer } from './graders/answer-parser.js';

/**
 * The answer string to grade for one run condition: re-extract from the raw
 * response when present (so extraction changes are measured offline), else fall
 * back to the stored post-extraction answer (backward compatible with old
 * traces that have no `response`).
 * Tradeoff: when `response` has no boxed/recognizable answer, extractModelAnswer
 * falls back to the tail of the text, which can regrade worse than the stored
 * answer. Accepted — this helper is measurement-only, and the next runs store
 * boxed answers that extract cleanly.
 */
export function answerToGrade(cond: { response?: string; extractedAnswer: string }): string {
  return cond.response !== undefined && cond.response !== ''
    ? extractModelAnswer(cond.response)
    : cond.extractedAnswer;
}
