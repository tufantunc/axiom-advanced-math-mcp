import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Window, type HTMLElement, type HTMLInputElement, type HTMLButtonElement } from 'happy-dom';
import { plotViewHtml } from '../src/server/tools/plot/view.js';
import { plotToSvg, type PlotArgs } from '../src/server/tools/plot/render.js';
import {
  toPlotStructuredContent,
  type PlotStructuredContent,
} from '../src/server/tools/plot/app.js';
import { VERSION } from '../src/version.js';

/**
 * The plot view's behaviour, run for real: the assembled page loads in a
 * happy-dom window, a fake host answers its JSON-RPC over postMessage, and the
 * assertions read what it sends and what it draws.
 *
 * The data comes from the server's own plotToSvg + toPlotStructuredContent, so
 * these also pin the contract between the two halves: the vertices drawn must
 * be the samples the server computed, placed where the server computed them.
 */

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Geometry the view uses (plot-view.js: VIEW_HEIGHT, MARGIN, 600px fallback width). */
const PLOT = { left: 58, top: 12, width: 600 - 58 - 16, height: 320 - 12 - 28 };

async function plotData(args: PlotArgs): Promise<PlotStructuredContent> {
  return toPlotStructuredContent(await plotToSvg(args));
}

function okResult(sc: PlotStructuredContent | Record<string, unknown>) {
  return { content: [{ type: 'text', text: 'caption' }], structuredContent: sc, isError: false };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

class FakeHost {
  readonly window: Window;
  readonly sent: Rpc[] = [];
  private readonly parent: unknown;

  constructor() {
    this.window = new Window({
      settings: {
        enableJavaScriptEvaluation: true,
        suppressInsecureJavaScriptEnvironmentWarning: true,
      },
    });
    // The view posts to window.parent, which in a top-level window is the
    // window itself: capture instead of letting it echo back to the view.
    (this.window as unknown as { postMessage: (m: unknown) => void }).postMessage = (m) => {
      this.sent.push(JSON.parse(JSON.stringify(m)) as Rpc);
    };
    this.window.document.write(plotViewHtml());
    // `window.parent` as the page's script sees it: event.source is compared
    // against this, and happy-dom's script global is a different object.
    this.parent = (this.window as unknown as { eval: (s: string) => unknown }).eval(
      'window.parent'
    );
  }

  deliver(message: Rpc): void {
    const event = new this.window.MessageEvent('message', {
      data: message,
      source: this.parent as never,
    });
    this.window.dispatchEvent(event);
  }

  requests(method: string): Rpc[] {
    return this.sent.filter((m) => m.method === method && m.id !== undefined);
  }

  /** Answers ui/initialize and waits for the view to say it is ready. */
  async connect(options: { serverTools?: boolean; theme?: 'light' | 'dark' } = {}) {
    await settle();
    const [init] = this.requests('ui/initialize');
    this.deliver({
      jsonrpc: '2.0',
      id: init.id,
      result: {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'test-host', version: '0' },
        hostCapabilities: options.serverTools === false ? {} : { serverTools: {} },
        hostContext: { theme: options.theme ?? 'light' },
      },
    });
    await settle();
  }

  async show(args: Record<string, unknown>, sc: PlotStructuredContent | Record<string, unknown>) {
    this.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: { arguments: args },
    });
    this.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: okResult(sc) });
    await settle();
  }

  reply(request: Rpc, result: unknown): void {
    this.deliver({ jsonrpc: '2.0', id: request.id, result });
  }

  el<T = HTMLElement>(id: string): T {
    const node = this.window.document.getElementById(id);
    if (!node) throw new Error(`#${id} missing`);
    return node as unknown as T;
  }

  input(id: string): HTMLInputElement {
    return this.el<HTMLInputElement>(id);
  }

  click(id: string): void {
    this.el(id).click();
  }

  text(id: string): string {
    return this.el(id).textContent ?? '';
  }

  paths(): string[] {
    return Array.from(this.window.document.querySelectorAll('path.curve')).map(
      (p) => p.getAttribute('d') ?? ''
    );
  }

  async close(): Promise<void> {
    await this.window.happyDOM.close();
  }
}

/** [x, y] pixel pairs from a path's d attribute. */
function vertices(d: string): [number, number][] {
  return [...d.matchAll(/[ML](-?[\d.]+),(-?[\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
}

let host: FakeHost;
let parabola: PlotStructuredContent;

beforeAll(async () => {
  parabola = await plotData({ expression: 'x^2', xMin: -2, xMax: 2 });
});

afterEach(async () => {
  await host?.close();
});

describe('plot view — protocol', () => {
  it('opens with ui/initialize and reports initialized only after the host answers', async () => {
    host = new FakeHost();
    await settle();
    expect(host.sent[0]).toMatchObject({
      method: 'ui/initialize',
      params: {
        protocolVersion: '2026-01-26',
        appInfo: { name: 'axiom-math-plot', version: VERSION },
        appCapabilities: {},
      },
    });
    expect(host.sent.some((m) => m.method === 'ui/notifications/initialized')).toBe(false);

    await host.connect();
    const methods = host.sent.map((m) => m.method);
    expect(methods.indexOf('ui/notifications/initialized')).toBe(1);
    expect(host.sent[1].id).toBeUndefined();
  });

  it('answers ping and ui/resource-teardown, and rejects unknown requests', async () => {
    host = new FakeHost();
    await host.connect();
    host.deliver({ jsonrpc: '2.0', id: 'p1', method: 'ping', params: {} });
    host.deliver({ jsonrpc: '2.0', id: 't1', method: 'ui/resource-teardown', params: {} });
    host.deliver({ jsonrpc: '2.0', id: 'x1', method: 'ui/unknown', params: {} });
    expect(host.sent.find((m) => m.id === 'p1')).toEqual({ jsonrpc: '2.0', id: 'p1', result: {} });
    expect(host.sent.find((m) => m.id === 't1')).toEqual({ jsonrpc: '2.0', id: 't1', result: {} });
    expect(host.sent.find((m) => m.id === 'x1')?.error?.code).toBe(-32601);
  });

  it('ignores messages that do not come from the host', async () => {
    host = new FakeHost();
    await host.connect();
    const forged = new host.window.MessageEvent('message', {
      data: { jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: okResult(parabola) },
    });
    host.window.dispatchEvent(forged);
    await settle();
    expect(host.paths()).toHaveLength(0);
  });
});

describe('plot view — drawing', () => {
  it('draws exactly the server samples, each at the x the server evaluated', async () => {
    host = new FakeHost();
    await host.connect();
    await host.show({ expression: 'x^2', x_min: -2, x_max: 2 }, parabola);

    const [x0, x1] = parabola.x_range;
    const [y0, y1] = parabola.y_range;
    const step = (x1 - x0) / (parabola.samples - 1);
    const paths = host.paths();
    expect(paths).toHaveLength(1);
    const drawn = vertices(paths[0]);
    expect(drawn).toHaveLength(parabola.samples);
    drawn.forEach(([px, py], i) => {
      const x = x0 + i * step;
      // The server's value at that x is x^2; the view must place it there.
      expect(parabola.curves[0].y[i]).toBeCloseTo(x * x, 12);
      expect(px).toBeCloseTo(PLOT.left + ((x - x0) / (x1 - x0)) * PLOT.width, 2);
      expect(py).toBeCloseTo(PLOT.top + ((y1 - x * x) / (y1 - y0)) * PLOT.height, 2);
    });
    expect(host.text('title')).toBe('f(x) = x^2');
    expect(host.el('chart').getAttribute('aria-label')).toContain('y from');
  });

  it('draws 1/x as two paths, one per side of the pole', async () => {
    host = new FakeHost();
    await host.connect();
    const sc = await plotData({ expression: '1/x', xMin: -1, xMax: 1 });
    await host.show({ expression: '1/x', x_min: -1, x_max: 1 }, sc);
    const paths = host.paths();
    expect(paths).toHaveLength(2);
    const mid = PLOT.left + PLOT.width / 2;
    expect(vertices(paths[0]).every(([px]) => px < mid)).toBe(true);
    expect(vertices(paths[1]).every(([px]) => px > mid)).toBe(true);
  });

  it('shows the error text of a failed plot and draws nothing', async () => {
    host = new FakeHost();
    await host.connect();
    host.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { content: [{ type: 'text', text: 'Error: unknown function' }], isError: true },
    });
    await settle();
    expect(host.text('status')).toBe('Error: unknown function');
    expect(host.el('status').classList.contains('error')).toBe(true);
    expect(host.el('chart').classList.contains('empty')).toBe(true);
    expect(host.paths()).toHaveLength(0);
  });

  it.each([
    [
      'a non-finite sample',
      (sc: PlotStructuredContent) => ({ ...sc, curves: [{ start: 0, y: [1, null, 2] }] }),
    ],
    ['an inverted y range', (sc: PlotStructuredContent) => ({ ...sc, y_range: [5, -5] })],
    [
      'a curve past the last sample',
      (sc: PlotStructuredContent) => ({ ...sc, curves: [{ start: sc.samples - 1, y: [1, 2] }] }),
    ],
    ['no title', (sc: PlotStructuredContent) => ({ ...sc, title: undefined })],
  ])('refuses data with %s rather than drawing it', async (_label, corrupt) => {
    host = new FakeHost();
    await host.connect();
    await host.show({ expression: 'x^2' }, corrupt(parabola));
    expect(host.text('status')).toBe('The result carried no plot data this view can draw.');
    expect(host.paths()).toHaveLength(0);
  });
});

describe('plot view — reading samples', () => {
  it('reads a sample with the keyboard slider, reporting the server value', async () => {
    host = new FakeHost();
    await host.connect();
    await host.show({ expression: 'x^2', x_min: -2, x_max: 2 }, parabola);
    expect(host.el('inspect-row').hidden).toBe(false);

    const slider = host.input('inspect');
    expect(slider.max).toBe(String(parabola.samples - 1));
    slider.value = '150';
    slider.dispatchEvent(new host.window.Event('input'));
    const x = -2 + 150 * (4 / (parabola.samples - 1));
    const y = parabola.curves[0].y[150];
    expect(y).toBeCloseTo(x * x, 12);
    const readout = host.text('readout');
    expect(readout).toBe(
      `sample at x ≈ ${Number(x.toPrecision(10))}:  f ≈ ${Number(y.toPrecision(10))}`
    );
    expect(slider.getAttribute('aria-valuetext')).toBe(readout);
  });

  it('moves the slider off a gap onto the nearest drawn sample', async () => {
    host = new FakeHost();
    await host.connect();
    // sqrt(x) is undefined left of 0: samples 0..99 are not drawn.
    const sc = await plotData({ expression: 'sqrt(x)', xMin: -1, xMax: 1 });
    await host.show({ expression: 'sqrt(x)', x_min: -1, x_max: 1 }, sc);
    const firstDrawn = sc.curves[0].start;
    expect(firstDrawn).toBeGreaterThan(50);

    const slider = host.input('inspect');
    slider.value = '10';
    slider.dispatchEvent(new host.window.Event('input'));
    expect(slider.value).toBe(String(firstDrawn));
    expect(host.text('readout')).toMatch(/^sample at x ≈ /);
  });
});

describe('plot view — replotting', () => {
  async function ready(args: Record<string, unknown>, sc = parabola) {
    host = new FakeHost();
    await host.connect();
    await host.show(args, sc);
  }

  it('keeps the caller’s y window, title and expression when it zooms', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2, y_min: -1, y_max: 5, title: 'T' });
    host.click('zoom-in');
    const [call] = host.requests('tools/call');
    expect(call.params).toEqual({
      name: 'plot',
      arguments: {
        expression: 'x^2',
        variable: 'x',
        x_min: -1,
        x_max: 1,
        y_min: -1,
        y_max: 5,
        title: 'T',
      },
    });
  });

  it('pans by a quarter of the width in each direction', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    host.click('pan-right');
    const [right] = host.requests('tools/call');
    expect(right.params?.arguments).toMatchObject({ x_min: -1, x_max: 3 });
  });

  it('draws the reply, puts its range in the inputs and announces it', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    host.click('zoom-in');
    const [call] = host.requests('tools/call');
    const zoomed = await plotData({ expression: 'x^2', xMin: -1, xMax: 1 });
    host.reply(call, okResult(zoomed));
    await settle();
    expect(host.input('xmin').value).toBe('-1');
    expect(host.input('xmax').value).toBe('1');
    expect(host.text('status')).toMatch(/^Showing x from -1 to 1, y from /);
    expect(vertices(host.paths()[0])).toHaveLength(zoomed.samples);
  });

  it('keeps focus on the pressed button and ignores presses while a replot runs', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    const zoomIn = host.el<HTMLButtonElement>('zoom-in');
    zoomIn.focus();
    zoomIn.click();
    expect(host.window.document.activeElement).toBe(zoomIn);
    expect(zoomIn.disabled).toBe(false);
    expect(zoomIn.getAttribute('aria-disabled')).toBe('true');
    zoomIn.click();
    expect(host.requests('tools/call')).toHaveLength(1);
  });

  it('lets Reset abandon a pending replot, and drops its late reply', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    host.click('zoom-in');
    expect(host.el('reset').getAttribute('aria-disabled')).not.toBe('true');

    host.click('reset');
    expect(host.el('zoom-in').getAttribute('aria-disabled')).toBe('false');
    expect(host.text('status')).toMatch(/^Showing the original range, x from -2 to 2/);

    host.click('zoom-out');
    const [stale, fresh] = host.requests('tools/call');
    expect(fresh.params?.arguments).toMatchObject({ x_min: -4, x_max: 4 });

    host.reply(stale, okResult(await plotData({ expression: 'x^2', xMin: -1, xMax: 1 })));
    await settle();
    expect(host.input('xmin').value).toBe('-2');

    host.reply(fresh, okResult(await plotData({ expression: 'x^2', xMin: -4, xMax: 4 })));
    await settle();
    expect(host.input('xmin').value).toBe('-4');
  });

  it('sends a typed range back exactly, even one too narrow for 12 digits', async () => {
    const lo = 1000;
    const hi = 1000 + 1e-9;
    const sc = await plotData({ expression: 'x - 1000', xMin: lo, xMax: hi });
    await ready({ expression: 'x - 1000', x_min: lo, x_max: hi }, sc);
    host.click('apply');
    const [call] = host.requests('tools/call');
    expect(call.params?.arguments).toMatchObject({ x_min: lo, x_max: hi });
  });

  it('marks both inputs invalid for a reversed range and calls nothing', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    host.input('xmin').value = '3';
    host.click('apply');
    expect(host.requests('tools/call')).toHaveLength(0);
    expect(host.text('status')).toBe('x min must be a number less than x max.');
    expect(host.input('xmin').getAttribute('aria-invalid')).toBe('true');
    expect(host.input('xmax').getAttribute('aria-invalid')).toBe('true');
    expect(host.input('xmin').getAttribute('aria-describedby')).toBe('status');
  });

  it('restores the drawn range to the inputs when a replot fails', async () => {
    await ready({ expression: 'x^2', x_min: -2, x_max: 2 });
    host.input('xmin').value = '0';
    host.click('apply');
    const [call] = host.requests('tools/call');
    host.reply(call, { content: [{ type: 'text', text: 'Error: boom' }], isError: true });
    await settle();
    expect(host.text('status')).toBe('Could not replot: Error: boom');
    expect(host.input('xmin').value).toBe('-2');
    expect(host.paths()).toHaveLength(1);
  });

  it('stops zooming in at the limit of double precision', async () => {
    const sc = await plotData({ expression: 'x', xMin: 1, xMax: 1 + 1.5e-12 });
    await ready({ expression: 'x', x_min: 1, x_max: 1 + 1.5e-12 }, sc);
    host.click('zoom-in');
    expect(host.requests('tools/call')).toHaveLength(0);
    expect(host.text('status')).toMatch(/^Cannot zoom in further/);
  });

  it('hides the range controls when the host cannot proxy tool calls', async () => {
    host = new FakeHost();
    await host.connect({ serverTools: false });
    await host.show({ expression: 'x^2', x_min: -2, x_max: 2 }, parabola);
    expect(host.el('range').hidden).toBe(true);
    expect(host.el('inspect-row').hidden).toBe(false);
    expect(host.paths()).toHaveLength(1);
  });
});

describe('plot view — host context', () => {
  it('applies the theme and only well-formed CSS variable names', async () => {
    host = new FakeHost();
    await host.connect({ theme: 'dark' });
    const root = host.window.document.documentElement;
    expect(root.getAttribute('data-theme')).toBe('dark');
    host.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/host-context-changed',
      params: {
        theme: 'light',
        styles: { variables: { '--color-text-primary': '#123456', 'color; x': 'red' } },
      },
    });
    expect(root.getAttribute('data-theme')).toBe('light');
    expect(root.style.getPropertyValue('--color-text-primary')).toBe('#123456');
    expect(root.getAttribute('style')).not.toContain('red');
  });
});
