import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPlotTools } from '../src/server/tools/plot/index.js';
import { MCP_APP_MIME_TYPE, PLOT_APP_URI } from '../src/server/tools/plot/app.js';
import { PLOT_APP_HTML } from '../src/server/tools/plot/app-html.js';
import { VERSION } from '../src/version.js';

/**
 * MCP Apps support for `plot`, exercised through a real MCP client so the
 * assertions cover what a host actually receives — the tool listing, the
 * resource read and the call result — rather than the helpers in isolation.
 */

interface PlotData {
  expression: string;
  variable: string;
  x_range: [number, number];
  y_range: [number, number];
  segments: number;
  samples: number;
  points: number;
  polylines: number[][];
}

let client: Client;
let server: McpServer;

beforeAll(async () => {
  // Only the plot tool: it never touches Giac, so no engine is needed here.
  server = new McpServer({ name: 'plot-app-test', version: '0.0.0' });
  registerPlotTools(server);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-host', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

async function plot(args: Record<string, unknown>) {
  const r = await client.callTool({ name: 'plot', arguments: args });
  return r as {
    content: { type: string; text?: string; mimeType?: string }[];
    structuredContent?: PlotData;
    isError?: boolean;
  };
}

/** [x, y] pairs from one flat polyline. */
function pairs(line: number[]): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < line.length; i += 2) out.push([line[i], line[i + 1]]);
  return out;
}

describe('plot — MCP Apps declaration', () => {
  it('points the tool at the ui:// view, in both the spec form and the legacy flat key', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'plot');
    const meta = tool?._meta as Record<string, unknown> | undefined;
    expect((meta?.ui as { resourceUri?: string })?.resourceUri).toBe(PLOT_APP_URI);
    expect(meta?.['ui/resourceUri']).toBe(PLOT_APP_URI);
  });

  it('serves the view with the exact MIME type the spec requires', async () => {
    const { contents } = await client.readResource({ uri: PLOT_APP_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe(PLOT_APP_URI);
    // A MUST in the spec: a host keys rendering on this exact string, so a
    // plain text/html resource is never shown as an app.
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
    expect((contents[0] as { text?: string }).text).toBe(PLOT_APP_HTML);
  });

  it('lists the view among the resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(PLOT_APP_URI);
  });
});

describe('plot — structuredContent carries the computed samples', () => {
  it('sends sin(x) samples that are sin(x), at full precision', async () => {
    const r = await plot({ expression: 'sin(x)', x_min: 0, x_max: Math.PI });
    expect(r.isError).toBe(false);
    const sc = r.structuredContent!;
    expect(sc.expression).toBe('sin(x)');
    expect(sc.variable).toBe('x');
    expect(sc.x_range).toEqual([0, Math.PI]);
    expect(sc.segments).toBe(1);
    expect(sc.polylines).toHaveLength(1);

    const pts = pairs(sc.polylines[0]);
    expect(pts).toHaveLength(sc.points);
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBeCloseTo(Math.PI, 12);
    for (const [x, y] of pts) expect(y).toBeCloseTo(Math.sin(x), 12);
    // sin on [0, pi] peaks at 1 and never goes negative beyond rounding.
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(1, 3);
    expect(Math.min(...pts.map((p) => p[1]))).toBeGreaterThan(-1e-12);
  });

  it('keeps the image block for hosts without MCP Apps', async () => {
    const r = await plot({ expression: 'x^2' });
    const image = r.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/svg+xml');
    expect(r.content.find((c) => c.type === 'text')?.text).toBe('Plot of f(x) = x^2 over [-10, 10]');
  });

  it('splits 1/x into one polyline per side of the pole', async () => {
    const r = await plot({ expression: '1/x', x_min: -1, x_max: 1 });
    const sc = r.structuredContent!;
    expect(sc.polylines).toHaveLength(2);
    const [left, right] = sc.polylines.map(pairs);
    expect(left.every(([x, y]) => x < 0 && y < 0)).toBe(true);
    expect(right.every(([x, y]) => x > 0 && y > 0)).toBe(true);
    for (const [x, y] of [...left, ...right]) expect(y).toBeCloseTo(1 / x, 9);
  });

  it('keeps every sample of a narrow range far from zero distinct', async () => {
    // Rounding to a fixed count of significant digits would map all 200 x
    // values in [1e6, 1e6 + 1] onto a handful of numbers and draw a spike.
    const r = await plot({ expression: 'x - 1000000', x_min: 1e6, x_max: 1e6 + 1 });
    const pts = pairs(r.structuredContent!.polylines[0]);
    expect(new Set(pts.map((p) => p[0])).size).toBe(r.structuredContent!.samples);
    for (const [x, y] of pts) expect(y).toBeCloseTo(x - 1e6, 6);
  });

  it('returns no structuredContent when the plot fails', async () => {
    const r = await plot({ expression: 'notafunction(x)' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });
});

describe('plot view HTML', () => {
  function inlineScript(): string {
    const m = /<script>([\s\S]*)<\/script>/.exec(PLOT_APP_HTML);
    expect(m).not.toBeNull();
    return m![1];
  }

  it('has an inline script that parses', () => {
    // String.raw keeps the script's escapes, but a stray backtick or `${`
    // would silently cut or rewrite it; parsing catches both.
    expect(() => new Function(inlineScript())).not.toThrow();
  });

  it('interpolates the package version and nothing else', () => {
    expect(PLOT_APP_HTML).toContain(`version: '${VERSION}'`);
    expect(PLOT_APP_HTML).not.toContain('${');
  });

  it('loads nothing from the network', () => {
    // The host's default CSP blocks remote origins when the resource declares
    // none; a remote script or stylesheet would leave a blank iframe.
    expect(PLOT_APP_HTML).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:)?\/\//i);
    expect(PLOT_APP_HTML).not.toMatch(/@import|fetch\(|XMLHttpRequest|WebSocket/);
  });

  it('never writes caller-controlled text as markup', () => {
    expect(inlineScript()).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('speaks the 2026-01-26 protocol', () => {
    const s = inlineScript();
    expect(s).toContain("PROTOCOL_VERSION = '2026-01-26'");
    for (const method of [
      'ui/initialize',
      'ui/notifications/initialized',
      'ui/notifications/tool-input',
      'ui/notifications/tool-result',
      'ui/notifications/size-changed',
      'ui/resource-teardown',
      'tools/call',
    ]) {
      expect(s).toContain(`'${method}'`);
    }
  });
});
