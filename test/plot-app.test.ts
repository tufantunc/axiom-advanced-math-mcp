import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerPlotTools } from '../src/server/tools/plot/index.js';
import { plotToSvg, type PlotResult } from '../src/server/tools/plot/render.js';
import {
  MCP_APP_MIME_TYPE,
  PLOT_APP_URI,
  toPlotStructuredContent,
  type PlotStructuredContent,
} from '../src/server/tools/plot/app.js';
import {
  assemblePlotView,
  plotViewHtml,
  readPlotViewSources,
  type PlotViewSources,
} from '../src/server/tools/plot/view.js';
import { VERSION } from '../src/version.js';

/**
 * MCP Apps support for `plot`, exercised through a real MCP client so the
 * assertions cover what a host actually receives: the tool listing, the
 * resource read and the call result. The view's behaviour is in
 * plot-view.test.ts.
 */

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
    structuredContent?: PlotStructuredContent;
    isError?: boolean;
  };
}

/** [x, y] samples of every curve, with x rebuilt the way the view rebuilds it. */
function samples(sc: PlotStructuredContent): [number, number][][] {
  const [x0, x1] = sc.x_range;
  const step = (x1 - x0) / (sc.samples - 1);
  return sc.curves.map((c) => c.y.map((y, k): [number, number] => [x0 + (c.start + k) * step, y]));
}

describe('plot — MCP Apps declaration', () => {
  it('points the tool at the ui:// view, in both the spec form and the legacy flat key', async () => {
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'plot');
    const meta = tool?._meta as Record<string, unknown> | undefined;
    expect((meta?.ui as { resourceUri?: string })?.resourceUri).toBe(PLOT_APP_URI);
    expect(meta?.['ui/resourceUri']).toBe(PLOT_APP_URI);
    // No outputSchema on purpose: see toPlotStructuredContent.
    expect(tool?.outputSchema).toBeUndefined();
  });

  it('serves the view with the exact MIME type the spec requires', async () => {
    const { contents } = await client.readResource({ uri: PLOT_APP_URI });
    expect(contents).toHaveLength(1);
    expect(contents[0].uri).toBe(PLOT_APP_URI);
    // A MUST in the spec: a host keys rendering on this exact string, so a
    // plain text/html resource is never shown as an app.
    expect(contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect(contents[0].mimeType).toBe(MCP_APP_MIME_TYPE);
    expect((contents[0] as { text?: string }).text).toBe(plotViewHtml());
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
    expect(sc.title).toBe('f(x) = sin(x)');
    expect(sc.x_range).toEqual([0, Math.PI]);
    expect(sc.samples).toBe(200);
    expect(sc.segments).toBe(1);
    expect(sc.curves).toEqual([{ start: 0, y: expect.any(Array) }]);

    const [pts] = samples(sc);
    expect(pts).toHaveLength(sc.points);
    expect(pts[0][0]).toBe(0);
    expect(pts[pts.length - 1][0]).toBeCloseTo(Math.PI, 12);
    for (const [x, y] of pts) expect(y).toBeCloseTo(Math.sin(x), 12);
    // The auto y range is the sampled span padded by 5%, so it holds every sample.
    const [y0, y1] = sc.y_range;
    expect(y0).toBeLessThan(y1);
    for (const [, y] of pts) expect(y >= y0 && y <= y1).toBe(true);
    expect(y1).toBeCloseTo(1 + 0.05, 3);
  });

  it('reports a pinned y window, a named variable and the caller’s title', async () => {
    const r = await plot({
      expression: 't^2',
      variable: 't',
      x_min: -2,
      x_max: 2,
      y_min: -1,
      y_max: 5,
      title: 'Parabola',
    });
    const sc = r.structuredContent!;
    expect(sc.variable).toBe('t');
    expect(sc.y_range).toEqual([-1, 5]);
    expect(sc.title).toBe('Parabola');
    for (const [t, y] of samples(sc).flat()) expect(y).toBeCloseTo(t * t, 12);
  });

  it('keeps the image block for hosts without MCP Apps', async () => {
    const r = await plot({ expression: 'x^2' });
    const image = r.content.find((c) => c.type === 'image');
    expect(image?.mimeType).toBe('image/svg+xml');
    expect(r.content.find((c) => c.type === 'text')?.text).toBe(
      'Plot of f(x) = x^2 over [-10, 10]'
    );
  });

  it('splits 1/x into one curve per side of the pole', async () => {
    const r = await plot({ expression: '1/x', x_min: -1, x_max: 1 });
    const sc = r.structuredContent!;
    expect(sc.curves).toHaveLength(2);
    const [left, right] = samples(sc);
    expect(left.every(([x, y]) => x < 0 && y < 0)).toBe(true);
    expect(right.every(([x, y]) => x > 0 && y > 0)).toBe(true);
    for (const [x, y] of [...left, ...right]) expect(y).toBeCloseTo(1 / x, 9);
  });

  it('keeps every sample of a narrow range far from zero distinct', async () => {
    // Rounding to a fixed count of significant digits would map all 200 x
    // values in [1e6, 1e6 + 1] onto a handful of numbers and draw a spike.
    const r = await plot({ expression: 'x - 1000000', x_min: 1e6, x_max: 1e6 + 1 });
    const [pts] = samples(r.structuredContent!);
    expect(new Set(pts.map((p) => p[0])).size).toBe(r.structuredContent!.samples);
    for (const [x, y] of pts) expect(y).toBeCloseTo(x - 1e6, 6);
  });

  it('is about half the size of sending x and y', async () => {
    const r = await plot({ expression: 'sin(x)' });
    const size = JSON.stringify(r.structuredContent).length;
    expect(size).toBeLessThan(4500);
  });

  it('returns no structuredContent when the plot fails', async () => {
    const r = await plot({ expression: 'notafunction(x)' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
  });

  it('refuses an inverted y range instead of drawing it upside down', async () => {
    const explicit = await plot({ expression: 'x', y_min: 5, y_max: -5 });
    expect(explicit.isError).toBe(true);
    expect(explicit.content[0].text).toMatch(/y_min must be less than y_max/);
    // Only y_min given, above everything sin(x) reaches: just as inverted.
    const implied = await plot({ expression: 'sin(x)', y_min: 100 });
    expect(implied.isError).toBe(true);
  });
});

describe('toPlotStructuredContent — the grid encoding', () => {
  it('rebuilds every x bit for bit, so the view draws each sample where it was computed', async () => {
    const result = await plotToSvg({ expression: 'tan(x)', xMin: -3.3, xMax: 7.1 });
    const sc = toPlotStructuredContent(result);
    const rebuilt = samples(sc).flat();
    const original = result.curve.flatMap((s) => s.points.map((p): [number, number] => [p.x, p.y]));
    expect(rebuilt).toEqual(original);
  });

  it('throws when a sample is off the grid, rather than misplace it', () => {
    const result: PlotResult = {
      svg: '',
      expression: 'x',
      variable: 'x',
      title: 'f(x) = x',
      xMin: 0,
      xMax: 1,
      yMin: 0,
      yMax: 1,
      segments: 1,
      samples: 3,
      points: 2,
      curve: [
        {
          points: [
            { x: 0, y: 0 },
            { x: 0.4, y: 0.4 },
          ],
        },
      ],
    };
    expect(() => toPlotStructuredContent(result)).toThrow(/not on the 3-point grid/);
  });
});

describe('plot view page', () => {
  const sources = readPlotViewSources();
  const html = plotViewHtml();

  /** The network loads a page can make, matched in the assembled HTML. */
  const NETWORK_LOADS = [
    /\b(src|href)\s*=\s*["']?(https?:)?\/\//i,
    /url\(\s*["']?(https?:)?\/\//i,
    /@import/i,
    /setAttribute\(\s*['"](src|href)['"]/,
    /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|new Image\(|importScripts/,
  ];

  it('is one self-contained document with the version filled in', () => {
    expect(html).toContain(`version: '${VERSION}'`);
    expect(html).not.toContain('__AXIOM_VERSION__');
    expect(html).not.toMatch(/<link\b|<script src=/);
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<style>/g)).toHaveLength(1);
  });

  it('loads nothing from the network', () => {
    // The host's default CSP blocks remote origins when the resource declares
    // none; a remote script or stylesheet would leave a blank iframe.
    for (const pattern of NETWORK_LOADS) expect(html).not.toMatch(pattern);
  });

  it('has network patterns that do catch remote loads', () => {
    const remote = [
      '<link href="https://x.test/a.css">',
      'body { background: url(https://x.test/a.png) }',
      "@import 'https://x.test/a.css';",
      "node.setAttribute('src', u)",
      'fetch(u)',
    ];
    for (const sample of remote) {
      expect(NETWORK_LOADS.some((p) => p.test(sample))).toBe(true);
    }
  });

  it('never writes caller-controlled text as markup', () => {
    expect(sources.js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  describe('assembly guards', () => {
    const base: PlotViewSources = sources;

    it('refuses a script that would close its own <script> element', () => {
      const js = base.js + '\n// </script>';
      expect(() => assemblePlotView({ ...base, js }, VERSION)).toThrow(/contains <\/script/);
    });

    it('refuses a stylesheet that would close its own <style> element', () => {
      const css = base.css + '\n/* </style> */';
      expect(() => assemblePlotView({ ...base, css }, VERSION)).toThrow(/contains <\/style/);
    });

    it('refuses a page whose stylesheet link or script tag is missing', () => {
      const html = base.html.replace('<script src="plot-view.js"></script>', '');
      expect(() => assemblePlotView({ ...base, html }, VERSION)).toThrow(/one script tag, found 0/);
    });

    it('needs exactly one version placeholder', () => {
      const js = base.js.replace('__AXIOM_VERSION__', '1.0.0');
      expect(() => assemblePlotView({ ...base, js }, VERSION)).toThrow(/found 0/);
    });

    it('inlines a script containing $-patterns verbatim', () => {
      const js = base.js + "\nconst s = '$& $` $1';";
      expect(assemblePlotView({ ...base, js }, VERSION)).toContain("const s = '$& $` $1';");
    });

    it('is what the files on disk assemble to', () => {
      const onDisk = (name: string) =>
        readFileSync(new URL(`../src/server/tools/plot/view/${name}`, import.meta.url), 'utf8');
      expect(sources).toEqual({
        html: onDisk('plot-view.html'),
        css: onDisk('plot-view.css'),
        js: onDisk('plot-view.js'),
      });
    });
  });
});
