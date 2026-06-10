import { extractRHS } from './extract-rhs.js';
import { normalize } from './normalizer.js';
import {
  stripTrailingConstraint,
  stripValueLabels,
  stripConstantTail,
  stripBigOTail,
  stripLogAbs,
} from './answer-residue.js';

export interface Candidate {
  value: string;
  /** True when an equation-RHS extraction contributed to this candidate. */
  viaEquationRHS: boolean;
}

const MAX_CANDIDATES = 12;
const MAX_DEPTH = 2;

/**
 * Generate grading candidates for a predicted answer: the original string
 * first, then every distinct result of composing residue transforms up to
 * MAX_DEPTH times (BFS, deduped, capped). Pure function. Transforms apply to
 * the PREDICTED side only and can never make a wrong answer right — the
 * caller re-grades every candidate against the ground truth.
 */
export function generateCandidates(predicted: string, ground: string): Candidate[] {
  const allowSingleLetterLHS = normalize(ground).kind === 'expression';
  const transforms: Array<{ rhs: boolean; apply: (s: string) => string | null }> = [
    { rhs: true, apply: (s) => extractRHS(s, { allowSingleLetterLHS }) },
    { rhs: false, apply: stripTrailingConstraint },
    { rhs: false, apply: stripValueLabels },
    { rhs: false, apply: (s) => stripConstantTail(s, ground) },
    { rhs: false, apply: stripBigOTail },
    { rhs: false, apply: stripLogAbs },
  ];

  const seen = new Set<string>([predicted]);
  const out: Candidate[] = [{ value: predicted, viaEquationRHS: false }];
  let frontier: Candidate[] = [out[0]];

  for (let depth = 0; depth < MAX_DEPTH && out.length < MAX_CANDIDATES; depth++) {
    const next: Candidate[] = [];
    for (const cand of frontier) {
      for (const t of transforms) {
        const v = t.apply(cand.value);
        if (v === null) continue;
        const trimmed = v.trim();
        if (!trimmed || seen.has(trimmed)) continue;
        seen.add(trimmed);
        const c: Candidate = {
          value: trimmed,
          viaEquationRHS: cand.viaEquationRHS || t.rhs,
        };
        out.push(c);
        next.push(c);
        if (out.length >= MAX_CANDIDATES) return out;
      }
    }
    frontier = next;
  }
  return out;
}
