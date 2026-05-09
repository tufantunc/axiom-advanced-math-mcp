export interface MathToolResponse {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes?: string[];
}

export function formatToolResponse(data: MathToolResponse): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
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

export function formatRawResponse(lines: string[]): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: 'text' as const, text: lines.join('\n') }],
    isError: false,
  };
}

export function formatRawError(error: unknown): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
    ],
    isError: true,
  };
}
