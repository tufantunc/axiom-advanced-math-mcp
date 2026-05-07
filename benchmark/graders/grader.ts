import {
  toNumber,
  normalizeString,
  normalizeSymbolic,
  isSymbolic,
  extractModelAnswer,
} from './answer-parser.js';
import { gradeV2 } from './grader-v2.js';

const NUMERIC_TOLERANCE = 1e-6;

export interface GradeResult {
  correct: boolean;
  predicted: string;
  ground: string;
  method: 'numeric' | 'symbolic' | 'string' | 'fallback';
}

/**
 * Grade a model's response against the ground truth answer.
 *
 * Pipeline: numeric → symbolic → string → fallback
 */
export function grade(modelResponse: string, groundTruth: string): GradeResult {
  if (process.env.AXIOM_GRADER_V2 === '1') {
    const predicted = extractModelAnswer(modelResponse);
    const ground = groundTruth.trim();
    // Try v2 on the extracted answer first; if it doesn't match, also try on the
    // raw model response in case extractModelAnswer stripped useful structure
    // (e.g., set expressions like "\{1, 2\}" extracted to just "2").
    const v2Extracted = gradeV2(predicted, ground);
    const v2Raw = predicted === modelResponse.trim() ? v2Extracted : gradeV2(modelResponse.trim(), ground);
    const v2 = v2Extracted.match ? v2Extracted : v2Raw;
    if (v2.match) {
      // Map v2 method to v1's method enum so downstream reports stay valid.
      const method =
        v2.method === 'numeric'
          ? 'numeric'
          : v2.method === 'symbolic' ||
              v2.method === 'set' ||
              v2.method === 'interval' ||
              v2.method === 'conditional' ||
              v2.method === 'normalized'
            ? 'symbolic'
            : 'string';
      return { correct: true, predicted, ground, method };
    }
    // v2 said no — fall through to v1 to give it a chance (additive behavior).
  }

  const predicted = extractModelAnswer(modelResponse);
  const ground = groundTruth.trim();

  // 1. Try numeric comparison first
  const predNum = toNumber(predicted);
  const groundNum = toNumber(ground);

  if (predNum !== null && groundNum !== null) {
    if (Math.abs(predNum - groundNum) <= NUMERIC_TOLERANCE) {
      return { correct: true, predicted, ground, method: 'numeric' };
    }
    // Numeric mismatch — check if tool result contains the correct answer
    const toolResult = extractToolResult(modelResponse);
    if (toolResult) {
      const toolNum = toNumber(toolResult);
      if (toolNum !== null && Math.abs(toolNum - groundNum) <= NUMERIC_TOLERANCE) {
        return { correct: true, predicted: toolResult, ground, method: 'numeric' };
      }
    }
    // Definitive numeric mismatch
    return { correct: false, predicted, ground, method: 'numeric' };
  }

  // One side is numeric, the other is a constant expression (e.g., "e-1" vs "1.718...")
  if (predNum !== null && groundNum === null) {
    const groundEval = evaluateConstantExpr(ground);
    if (groundEval !== null && Math.abs(predNum - groundEval) <= 1e-4) {
      return { correct: true, predicted, ground, method: 'numeric' };
    }
  }
  if (groundNum !== null && predNum === null) {
    const predEval = evaluateConstantExpr(predicted);
    if (predEval !== null && Math.abs(predEval - groundNum) <= 1e-4) {
      return { correct: true, predicted, ground, method: 'numeric' };
    }
  }

  // 2. Symbolic comparison — if either side looks symbolic
  if (isSymbolic(ground) || isSymbolic(predicted)) {
    const result = gradeSymbolic(predicted, ground);
    if (result.correct) return result;
    // If symbolic didn't match, also check inside tool results
    // (the full model response may contain the correct answer from a tool call)
    const toolResult = extractToolResult(modelResponse);
    if (toolResult) {
      const toolGrade = gradeSymbolic(toolResult, ground);
      if (toolGrade.correct) {
        return { ...toolGrade, predicted: toolResult };
      }
    }
  }

  // 3. String comparison after normalization
  const predNorm = normalizeString(predicted);
  const groundNorm = normalizeString(ground);

  if (predNorm && groundNorm) {
    if (predNorm === groundNorm) {
      return { correct: true, predicted, ground, method: 'string' };
    }
  }

  // 4. Last resort: direct substring check
  if (!predicted.trim()) {
    return { correct: false, predicted, ground, method: 'fallback' };
  }
  return {
    correct: predicted.includes(ground) || ground.includes(predicted),
    predicted,
    ground,
    method: 'fallback',
  };
}

/**
 * Grade for GSM8K — ground truth is a pre-extracted number.
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

/**
 * Grade two expressions using symbolic normalization.
 * Tries multiple normalization strategies to find a match.
 */
function gradeSymbolic(predicted: string, ground: string): GradeResult {
  const predSym = normalizeSymbolic(predicted);
  const groundSym = normalizeSymbolic(ground);

  if (predSym && groundSym && predSym === groundSym) {
    return { correct: true, predicted, ground, method: 'symbolic' };
  }

  // Try with sorted terms: "cos(x)*x^2+sin(x)*2*x" ↔ "2*x*sin(x)+x^2*cos(x)"
  if (predSym && groundSym) {
    const predSorted = sortTerms(predSym);
    const groundSorted = sortTerms(groundSym);
    if (predSorted === groundSorted) {
      return { correct: true, predicted, ground, method: 'symbolic' };
    }
  }

  // Try numeric evaluation for expressions with known constants (e, pi)
  // e.g., "e-1" ground vs "1.718281828" predicted
  const predNum = evaluateConstantExpr(predicted);
  const groundNum = evaluateConstantExpr(ground);
  if (predNum !== null && groundNum !== null) {
    if (Math.abs(predNum - groundNum) <= 1e-4) {
      return { correct: true, predicted, ground, method: 'symbolic' };
    }
  }

  return { correct: false, predicted, ground, method: 'symbolic' };
}

/**
 * Sort additive terms so "b+a" matches "a+b".
 * Splits on top-level '+' and '-', sorts, rejoins.
 */
function sortTerms(expr: string): string {
  // Split on + and - at top level (not inside parentheses)
  const terms: string[] = [];
  let depth = 0;
  let current = '';
  let sign = '';

  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && (ch === '+' || ch === '-') && i > 0) {
      terms.push(sign + current.trim());
      current = '';
      sign = ch === '-' ? '-' : '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) terms.push(sign + current.trim());

  // Sort terms, also sort factors within each term
  return terms
    .map((t) => {
      // Sort multiplicative factors: "2*x*sin(x)" → factors sorted
      const factors = splitFactors(t);
      return factors.sort().join('*');
    })
    .sort()
    .join('+');
}

/**
 * Split a term into multiplicative factors at top-level '*'.
 */
function splitFactors(term: string): string[] {
  const factors: string[] = [];
  let depth = 0;
  let current = '';

  for (const ch of term) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && ch === '*') {
      if (current.trim()) factors.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) factors.push(current.trim());
  return factors.length > 0 ? factors : [term];
}

/**
 * Try to evaluate an expression containing known constants (e, pi)
 * to a numeric value for approximate comparison.
 */
function evaluateConstantExpr(s: string): number | null {
  // First try direct number parse
  const direct = toNumber(s);
  if (direct !== null) return direct;

  let expr = s.trim();

  // Replace known constants BEFORE checking for unknown variables
  expr = expr
    .replace(/\\pi/g, String(Math.PI))
    .replace(/\bpi\b/gi, String(Math.PI))
    .replace(/(?<![a-zA-Z])\be\b(?![a-zA-Z])/g, String(Math.E));

  // Simple expressions: "e-1", "pi/4", "pi^2-4", "16/3"
  // Only evaluate if it's safe (no function calls, no variables other than constants)
  // After constant substitution, check for remaining letters
  if (/[a-zA-Z]/.test(expr)) return null; // has unknown variables

  // Replace ^ with **
  expr = expr.replace(/\^/g, '**');

  try {
    // eslint-disable-next-line no-eval
    const result = Function(`"use strict"; return (${expr})`)() as number;
    if (typeof result === 'number' && isFinite(result)) return result;
  } catch {
    // not evaluable
  }
  return null;
}

/**
 * Extract the "Result: ..." line from tool call output embedded in model response.
 * Tool results appear as "[Tool result: Result: 3*x^2\n...]"
 */
function extractToolResult(text: string): string | null {
  // Look for "[Tool result: Result: ...]" pattern (injected by providers)
  const toolResultMatches = [...text.matchAll(/\[Tool result:.*?Result:\s*([^\n]+)/g)];
  if (toolResultMatches.length > 0) {
    const last = toolResultMatches[toolResultMatches.length - 1][1].trim();
    if (last) return last;
  }

  // Also look for standalone "Result: ..." lines from compute tool output
  const resultMatches = [...text.matchAll(/^Result:\s*(.+)$/gm)];
  if (resultMatches.length > 0) {
    return resultMatches[resultMatches.length - 1][1].trim();
  }

  return null;
}
