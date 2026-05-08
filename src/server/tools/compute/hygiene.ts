import type { ComputeEnvelope } from './types.js';
import { unicodeToAscii } from '../unicode-normalize.js';
import { detectFailure } from './silent-failure.js';
import { shouldTrySimplify } from './simplify-trigger.js';

export interface GiacEngineLike {
  evaluate(expr: string): Promise<string>;
}

/**
 * Three-step compute output hygiene pipeline.
 *
 * 1. Unicode normalize on `display` (and `latex` if present).
 * 2. Silent-failure detection: if the result text contains failure signals,
 *    add a warning string to the envelope so the model sees it.
 * 3. Optional simplify: if the display has structural complexity, ask Giac
 *    to simplify and use the result if it is shorter.
 *
 * Returns a new envelope (does not mutate input).
 */
export async function applyHygiene(
  envelope: ComputeEnvelope,
  engine: GiacEngineLike
): Promise<ComputeEnvelope> {
  let next: ComputeEnvelope = { ...envelope };

  // Step 1: Unicode → ASCII on display + latex
  next.display = unicodeToAscii(next.display);
  if (next.latex !== undefined) {
    next.latex = unicodeToAscii(next.latex);
  }

  // Step 2: silent-failure warning
  const failure = detectFailure(next.display);
  if (failure !== null) {
    const note = `${failure}: tool result may be unreliable. Consider trying a different formulation.`;
    next.warnings = [...(next.warnings ?? []), note];
  }

  // Step 3: optional simplify (skip if we already flagged a failure)
  if (failure === null && shouldTrySimplify(next.display)) {
    try {
      const simplified = (await engine.evaluate(`simplify(${next.display})`)).trim();
      if (simplified && simplified.length < next.display.length) {
        next = { ...next, display: simplified };
      }
    } catch {
      // Giac error during simplify — keep the original display.
    }
  }

  return next;
}
