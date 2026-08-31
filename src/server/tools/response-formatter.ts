export interface MathToolResponse {
  result: string;
  decimal?: string;
  latex?: string;
  giacCommand?: string;
  notes?: string[];
  methodNote?: string;
  verification?: { verified: boolean; method: string; detail: string };
}

/**
 * The caveat that accompanies an infinite result.
 *
 * Worded for what is actually true of every case. The first version enumerated
 * "division by zero or an overflow", which is false for `log(0)` — a genuine
 * limit that is neither.
 *
 * The `Warning:` prefix is load-bearing: it is what `compute/normalize.ts` lifts
 * into the envelope's `warnings`. It deliberately does NOT say `Note:`, because
 * matching on that swept up genuine notes from other handlers — a correct
 * Lagrange result was arriving flagged as unreliable.
 */
export const NON_FINITE_NOTE =
  'Warning: the result is infinite. This tool cannot distinguish a genuinely ' +
  'infinite value from one that overflowed the range of a double, so treat the ' +
  'magnitude as unknown rather than as a computed number.';

export function formatToolResponse(data: MathToolResponse): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
} {
  const lines: string[] = [];
  lines.push(`Result: ${data.result}`);
  if (data.decimal && data.decimal !== data.result) lines.push(`Decimal: ${data.decimal}`);
  if (data.latex) lines.push(`LaTeX: ${data.latex}`);
  if (data.giacCommand) lines.push(`Command: ${data.giacCommand}`);
  if (data.methodNote) lines.push(`Method: ${data.methodNote}`);
  if (data.verification) {
    const mark = data.verification.verified ? '✓' : '✗';
    lines.push(`Verified: ${mark} (${data.verification.method}: ${data.verification.detail})`);
  }
  if (data.notes && data.notes.length > 0) lines.push(...data.notes);
  lines.push('');
  if (data.decimal && data.decimal !== data.result) {
    const rounded = Number.parseFloat(data.decimal);
    if (Number.isFinite(rounded)) {
      const display = Number.isInteger(rounded)
        ? String(rounded)
        : Number.parseFloat(rounded.toPrecision(10)).toString();
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

/**
 * The failure message carried in a handler's own output lines, or null.
 *
 * Several handlers build a `string[]` and signal a validation or convergence
 * failure by putting a marked line in it, then hand the whole array to
 * `formatToolResponse` — which sets `isError: false`. The caller then reads the
 * failure as the answer.
 *
 * This lived as three separate checks that disagreed on what the convention IS:
 * one matched only a single-element array, one only the last line, one only the
 * `Error:` spelling — so `newton(x^3-2*x+2, x, 0)` answered "0" for an input
 * with no root there, and `chi_square(df=3)` answered "pmf/cdf requires param x".
 * Match the marker rather than one wording: `✗` prefixes every failure line
 * these handlers emit, and `Error:` covers the ones without it.
 *
 * The real fix is a discriminated outcome from those functions; until they have
 * one, this is the single place the convention is interpreted.
 */
export function inBandFailure(lines: string[]): string | null {
  // Match the failure WORD, not the ✗ glyph. Hypothesis testing uses ✗ as its
  // reject-the-null marker — `✗ Reject H₀ (p = 0.0474 < α = 0.05)` is a result,
  // not a failure — so keying on the symbol alone turned every significant test
  // into an error.
  const failureWord = /^\s*(?:✗\s*)?(Error:|Failed:|Did not converge)/;
  const marker = /^\s*(?:✗\s*)?(?:Error:\s*|Failed:\s*)?/;
  const hit = lines.find((line) => failureWord.test(line));
  if (!hit) return null;
  const from = lines.indexOf(hit);
  return lines
    .slice(from)
    .filter((line) => line.trim() !== '')
    .join(' ')
    .replace(marker, '')
    .trim();
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
