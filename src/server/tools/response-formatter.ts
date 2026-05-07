import { formatToolResponseV2 } from './response-formatter-v2.js';
import type { Confidence } from './response-formatter-v2.js';

export interface MathToolResponse {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes?: string[];
  /** Optional v2 confidence — only used when AXIOM_OUTPUT_V2=1. v1 ignores it. */
  confidence?: 'high' | 'medium' | 'low';
}

export function formatToolResponse(data: MathToolResponse): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  if (process.env.AXIOM_OUTPUT_V2 === '1') {
    const numeric = data.decimal !== undefined ? Number(data.decimal) : undefined;
    return formatToolResponseV2({
      answer: data.result,
      answer_latex: data.latex,
      answer_numeric: Number.isFinite(numeric as number) ? numeric : undefined,
      confidence: ((data as { confidence?: Confidence }).confidence) ?? 'medium',
      warnings: data.notes,
      raw: data.giacCommand,
    });
  }

  // --- v1 path (unchanged) ---
  const lines: string[] = [];
  lines.push(`Result: ${data.result}`);
  if (data.decimal && data.decimal !== data.result) lines.push(`Decimal: ${data.decimal}`);
  if (data.latex) lines.push(`LaTeX: ${data.latex}`);
  if (data.giacCommand) lines.push(`Command: ${data.giacCommand}`);
  if (data.notes && data.notes.length > 0) lines.push(...data.notes);
  lines.push('');
  if (data.decimal && data.decimal !== data.result) {
    const rounded = parseFloat(data.decimal);
    if (!isNaN(rounded) && isFinite(rounded)) {
      const display = Number.isInteger(rounded)
        ? String(rounded)
        : parseFloat(rounded.toPrecision(10)).toString();
      lines.push(`The answer is ${data.result} (≈ ${display})`);
    } else {
      lines.push(`The answer is ${data.result}`);
    }
  } else {
    lines.push(`The answer is ${data.result}`);
  }
  return {
    content: lines.map((l) => ({ type: 'text' as const, text: l })),
    isError: false,
  };
}

export function formatErrorResponse(message: string): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
