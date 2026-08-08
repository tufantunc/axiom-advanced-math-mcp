import type { OutputMode } from './parse.js';
import type { PlotResult } from '../server/tools/plot/render.js';
import { formatVerifyResponse, type VerifyResult } from '../server/tools/verify/index.js';

/**
 * The shape both tool handlers return. Kept structurally identical to the
 * handlers' own return type rather than widened: `text?: string` here would
 * accept a block the handlers never produce and hide it behind `?? ''`.
 */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** Concatenates a handler's text blocks the way the MCP client would see them. */
export function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text).join('\n');
}

/**
 * Parses the structured envelope a tool returns for `format: 'json'`.
 *
 * The handlers emit plain text from their catch blocks regardless of the
 * requested format, so a caller that skipped the `isError` check would
 * otherwise get an opaque SyntaxError here instead of something actionable.
 */
function parseEnvelope<T>(text: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected structured output but got: ${text.slice(0, 200)}`);
  }
}

/**
 * `quiet` and `json` both read the structured envelope the handler produced with
 * `format: 'json'` — never the human-readable text. Scraping text would be
 * fragile, and a silently wrong answer is this product's worst failure mode.
 */
export function renderCompute(r: ToolResult, mode: OutputMode): string {
  const text = resultText(r);
  if (mode === 'text' || mode === 'latex') return text;

  if (mode === 'json') return text;
  const envelope = parseEnvelope<{ display?: string }>(text);
  // An empty display would hand a script a silent, successful empty capture —
  // exactly the wrong-answer failure mode this CLI treats as worst-case. Throw
  // instead; the dispatcher turns a throw into stderr + exit 1.
  if (!envelope.display) {
    throw new Error('compute produced no displayable result');
  }
  return envelope.display;
}

/**
 * The CLI always asks `verify` for `format: 'json'`, so the verdict is read from
 * a typed field in every mode — including text mode, whose human-readable layout
 * is produced by calling the tool's own formatter rather than reconstructing it
 * here. Nothing parses human-readable output anywhere.
 */
export function renderVerify(
  r: ToolResult,
  mode: OutputMode
): { out: string; verified: boolean; evaluated: boolean } {
  const json = resultText(r);
  const parsed = parseEnvelope<VerifyResult>(json);
  if (typeof parsed.verified !== 'boolean' || typeof parsed.evaluated !== 'boolean') {
    // The exit code is derived from these two fields, so an envelope missing
    // them must fail loudly rather than default to a verdict.
    throw new Error(`verify returned no verdict: ${json.slice(0, 200)}`);
  }
  const { verified, evaluated } = parsed;

  if (mode === 'json') return { out: json, verified, evaluated };
  if (mode === 'quiet') return { out: String(verified), verified, evaluated };

  const rendered = formatVerifyResponse(parsed, 'text');
  return { out: rendered.content.map((c) => c.text).join('\n'), verified, evaluated };
}

export function renderPlotMeta(p: PlotResult, path: string | null): string {
  return JSON.stringify(
    {
      ok: true,
      path,
      expression: p.expression,
      variable: p.variable,
      x_range: [p.xMin, p.xMax],
      y_range: [p.yMin, p.yMax],
      segments: p.segments,
      samples: p.samples,
      points: p.points,
    },
    null,
    2
  );
}
