import type { OutputMode } from './parse.js';
import type { PlotResult } from '../server/tools/plot/render.js';
import { formatVerifyResponse, type VerifyResult } from '../server/tools/verify/index.js';

export interface ToolResult {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

/** Concatenates a handler's text blocks the way the MCP client would see them. */
export function resultText(r: ToolResult): string {
  return r.content.map((c) => c.text ?? '').join('\n');
}

/**
 * `quiet` and `json` both read the structured envelope the handler produced with
 * `format: 'json'` — never the human-readable text. Scraping text would be
 * fragile, and a silently wrong answer is this product's worst failure mode.
 */
export function renderCompute(r: ToolResult, mode: OutputMode): string {
  const text = resultText(r);
  if (mode === 'text' || mode === 'latex') return text;

  const envelope = JSON.parse(text) as { display?: string };
  if (mode === 'json') return text;
  return envelope.display ?? '';
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
): { out: string; verified: boolean } {
  const json = resultText(r);
  const parsed = JSON.parse(json) as VerifyResult;
  const verified = parsed.verified === true;

  if (mode === 'json') return { out: json, verified };
  if (mode === 'quiet') return { out: String(verified), verified };

  const rendered = formatVerifyResponse(parsed, 'text');
  return { out: rendered.content.map((c) => c.text).join('\n'), verified };
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
      points: p.points,
    },
    null,
    2
  );
}
