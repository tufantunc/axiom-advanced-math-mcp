import type { PlotSegment } from './evaluator.js';

export interface SvgOptions {
  width: number;
  height: number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  title?: string;
  segments: PlotSegment[];
}

function niceStep(range: number, targetTicks: number): number {
  const rough = range / targetTicks;
  const exp = Math.floor(Math.log10(rough));
  const frac = rough / Math.pow(10, exp);
  let nice: number;
  if (frac <= 1.5) nice = 1;
  else if (frac <= 3.5) nice = 2;
  else if (frac <= 7.5) nice = 5;
  else nice = 10;
  return nice * Math.pow(10, exp);
}

export function renderSvg(opts: SvgOptions): string {
  const { width, height, xMin, xMax, yMin, yMax, title, segments } = opts;

  const margin = { top: title ? 40 : 20, right: 20, bottom: 40, left: 50 };
  const plotW = width - margin.left - margin.right;
  const plotH = height - margin.top - margin.bottom;

  // Coordinate mapping
  const toSvgX = (x: number) => margin.left + ((x - xMin) / (xMax - xMin)) * plotW;
  const toSvgY = (y: number) => margin.top + ((yMax - y) / (yMax - yMin)) * plotH;

  const lines: string[] = [];

  lines.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`);
  lines.push(`<rect width="${width}" height="${height}" fill="white"/>`);

  // Grid + axis ticks
  const xStep = niceStep(xMax - xMin, 8);
  const yStep = niceStep(yMax - yMin, 6);

  const xStart = Math.ceil(xMin / xStep) * xStep;
  const yStart = Math.ceil(yMin / yStep) * yStep;

  // Grid lines
  lines.push(`<g stroke="#e0e0e0" stroke-width="0.5">`);
  for (let x = xStart; x <= xMax; x += xStep) {
    const sx = toSvgX(x);
    lines.push(`<line x1="${sx}" y1="${margin.top}" x2="${sx}" y2="${margin.top + plotH}"/>`);
  }
  for (let y = yStart; y <= yMax; y += yStep) {
    const sy = toSvgY(y);
    lines.push(`<line x1="${margin.left}" y1="${sy}" x2="${margin.left + plotW}" y2="${sy}"/>`);
  }
  lines.push(`</g>`);

  // Axes (if origin is visible)
  lines.push(`<g stroke="#999" stroke-width="1">`);
  if (xMin <= 0 && xMax >= 0) {
    const x0 = toSvgX(0);
    lines.push(`<line x1="${x0}" y1="${margin.top}" x2="${x0}" y2="${margin.top + plotH}"/>`);
  }
  if (yMin <= 0 && yMax >= 0) {
    const y0 = toSvgY(0);
    lines.push(`<line x1="${margin.left}" y1="${y0}" x2="${margin.left + plotW}" y2="${y0}"/>`);
  }
  lines.push(`</g>`);

  // Tick labels
  lines.push(`<g font-family="sans-serif" font-size="11" fill="#333">`);
  for (let x = xStart; x <= xMax; x += xStep) {
    const sx = toSvgX(x);
    const label = Math.abs(x) < 1e-10 ? '0' : formatNum(x);
    lines.push(`<text x="${sx}" y="${margin.top + plotH + 16}" text-anchor="middle">${label}</text>`);
  }
  for (let y = yStart; y <= yMax; y += yStep) {
    const sy = toSvgY(y);
    const label = Math.abs(y) < 1e-10 ? '0' : formatNum(y);
    lines.push(`<text x="${margin.left - 6}" y="${sy + 4}" text-anchor="end">${label}</text>`);
  }
  lines.push(`</g>`);

  // Plot border
  lines.push(`<rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}" fill="none" stroke="#ccc" stroke-width="1"/>`);

  // Function curve — clip to plot area
  lines.push(`<defs><clipPath id="plot-area"><rect x="${margin.left}" y="${margin.top}" width="${plotW}" height="${plotH}"/></clipPath></defs>`);
  lines.push(`<g clip-path="url(#plot-area)">`);

  for (const segment of segments) {
    if (segment.points.length < 2) continue;
    const d = segment.points
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${toSvgX(pt.x).toFixed(2)},${toSvgY(pt.y).toFixed(2)}`)
      .join(' ');
    lines.push(`<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2" stroke-linejoin="round"/>`);
  }
  lines.push(`</g>`);

  // Title
  if (title) {
    lines.push(`<text x="${width / 2}" y="${24}" text-anchor="middle" font-family="sans-serif" font-size="14" font-weight="bold" fill="#333">${escapeXml(title)}</text>`);
  }

  lines.push(`</svg>`);
  return lines.join('\n');
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toString();
  return n.toFixed(2).replace(/\.?0+$/, '');
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
