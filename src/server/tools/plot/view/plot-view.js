// @ts-check
/**
 * The interactive view behind `plot`: the browser half of its MCP Apps
 * support (spec 2026-01-26). `../view.ts` inlines this file into
 * plot-view.html, and hosts render the page in a sandboxed iframe.
 *
 * A plain script rather than a bundle: the host's default CSP for a resource
 * that declares no `csp` blocks every remote load, and the part of the
 * protocol this view needs (the handshake, four notifications, `tools/call`)
 * is small enough to speak directly over postMessage. Type-checked by
 * tsconfig.view.json, linted and formatted with the rest of src/.
 *
 * Two rules it keeps:
 *   - It never evaluates the expression. It draws the samples the server sent
 *     and, for a new range, asks the host to call `plot` again. A browser-side
 *     evaluator could disagree with the server's and draw a curve nobody
 *     computed.
 *   - Caller-controlled text (expression, title, error messages) reaches the
 *     DOM only through `textContent` and attribute values, never as markup.
 */
(() => {
  'use strict';

  const PROTOCOL_VERSION = '2026-01-26';
  // The version placeholder below is replaced when ../view.ts assembles the page.
  const APP_INFO = { name: 'axiom-math-plot', version: '__AXIOM_VERSION__' };
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEW_HEIGHT = 320;
  const MARGIN = { top: 12, right: 16, bottom: 28, left: 58 };
  const REQUEST_TIMEOUT_MS = 30000;
  // Bounds the pixel coordinates handed to the SVG engine. A sample beside a
  // pole can map to 1e300 px, which some renderers drop the whole path for;
  // past this bound the segment is vertical on screen either way.
  const COORD_LIMIT = 1e6;
  // Narrowest zoom, relative to the magnitude of the range. Below it the 200
  // samples stop being distinct doubles and zoom-in has nothing left to show.
  const MIN_RELATIVE_WIDTH = 1e-12;

  /**
   * One run of drawn samples. Sample `start + k` sits at
   * `x_range[0] + (start + k) * step` with `step = (x_range[1] - x_range[0]) /
   * (samples - 1)`: the sampler's own formula, so x is rebuilt bit for bit
   * rather than sent.
   * @typedef {{ start: number, y: number[] }} Curve
   */
  /**
   * A `plot` result's `structuredContent` (see `../app.ts`).
   * @typedef {{
   *   expression: string, variable: string, title: string,
   *   x_range: [number, number], y_range: [number, number],
   *   segments: number, samples: number, points: number, curves: Curve[]
   * }} PlotData
   */
  /**
   * @typedef {{ resolve: (value: any) => void, reject: (error: Error) => void,
   *   timer: ReturnType<typeof setTimeout> }} Waiter
   */
  /**
   * What the pointer and the inspect slider need from the last draw.
   * @typedef {{
   *   sx: (x: number) => number, sy: (y: number) => number, xAt: (i: number) => number,
   *   x0: number, y0: number, y1: number, step: number, width: number, pw: number,
   *   drawn: (number | null)[], cursor: SVGLineElement, dot: SVGCircleElement
   * }} Hover
   */

  /**
   * @template {Element} T
   * @param {string} id
   * @param {{ new (): T, prototype: T }} type
   * @returns {T}
   */
  function byId(id, type) {
    const node = document.getElementById(id);
    if (!(node instanceof type)) throw new Error('plot view: #' + id + ' is missing');
    return node;
  }

  const titleEl = byId('title', HTMLElement);
  const chart = byId('chart', SVGSVGElement);
  const readout = byId('readout', HTMLElement);
  const statusEl = byId('status', HTMLElement);
  // Not a <form>: a sandboxed iframe without allow-forms blocks submission
  // before the submit event fires, so Apply would silently do nothing.
  const rangeControls = byId('range', HTMLElement);
  const xMinInput = byId('xmin', HTMLInputElement);
  const xMaxInput = byId('xmax', HTMLInputElement);
  const resetButton = byId('reset', HTMLButtonElement);
  const inspectRow = byId('inspect-row', HTMLElement);
  const inspect = byId('inspect', HTMLInputElement);
  // Reset stays live while a replot runs: it is the way out of one that hangs.
  const busyButtons = Array.from(rangeControls.querySelectorAll('button')).filter(
    (b) => b !== resetButton
  );

  let nextId = 1;
  /** @type {Map<number, Waiter>} */
  const pending = new Map();
  /** @type {Record<string, unknown> | null} */
  let toolArgs = null;
  /** @type {PlotData | null} */
  let original = null;
  /** @type {PlotData | null} */
  let current = null;
  /** @type {Hover | null} */
  let hover = null;
  let canCallTools = false;
  let busy = false;
  let latestCall = 0;

  // ---- transport -------------------------------------------------------

  /** @param {object} message */
  function send(message) {
    window.parent.postMessage(message, '*');
  }

  /**
   * @param {string} method
   * @param {object} params
   * @returns {Promise<any>}
   */
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(method + ' timed out'));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /** @param {string} method @param {object} [params] */
  function notify(method, params) {
    send(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
  }

  /** @param {MessageEvent} event */
  function onMessage(event) {
    if (event.source !== window.parent) return;
    const m = event.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;

    if (typeof m.method !== 'string') {
      const waiter = pending.get(m.id);
      if (!waiter) return;
      pending.delete(m.id);
      clearTimeout(waiter.timer);
      if (m.error) waiter.reject(new Error((m.error && m.error.message) || 'request failed'));
      else waiter.resolve(m.result);
      return;
    }

    if (m.id !== undefined && m.id !== null) {
      if (m.method === 'ping' || m.method === 'ui/resource-teardown') {
        send({ jsonrpc: '2.0', id: m.id, result: {} });
      } else {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'Method not found' } });
      }
      return;
    }

    const params = m.params && typeof m.params === 'object' ? m.params : {};
    if (m.method === 'ui/notifications/tool-input') {
      /** @type {Record<string, unknown>} */
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      toolArgs = args;
      if (!current) titleEl.textContent = placeholderTitle(args);
    } else if (m.method === 'ui/notifications/tool-result') {
      try {
        original = readPlot(params);
        draw(original);
        syncInputs();
        setStatus('');
      } catch (e) {
        setStatus(errorText(e), true);
      }
    } else if (m.method === 'ui/notifications/tool-cancelled') {
      if (!current) setStatus('The plot was cancelled.', true);
    } else if (m.method === 'ui/notifications/host-context-changed') {
      applyHostContext(params);
    }
  }

  // ---- host context ----------------------------------------------------

  /** @param {any} ctx */
  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    const root = document.documentElement;
    if (ctx.theme === 'light' || ctx.theme === 'dark') root.setAttribute('data-theme', ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      for (const name of Object.keys(vars)) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof vars[name] === 'string') {
          root.style.setProperty(name, vars[name]);
        }
      }
    }
  }

  // ---- results ---------------------------------------------------------

  /** @param {unknown} e */
  function errorText(e) {
    return e instanceof Error ? e.message : String(e);
  }

  /** @param {any} result */
  function textOf(result) {
    return (Array.isArray(result.content) ? result.content : [])
      .filter((/** @type {any} */ c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((/** @type {{ text: string }} */ c) => c.text)
      .join('\n');
  }

  /** @param {unknown} v @returns {v is number} */
  function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
  }

  /** @param {unknown} v @returns {v is [number, number]} */
  function isRange(v) {
    return Array.isArray(v) && v.length === 2 && v.every(isFiniteNumber) && v[0] < v[1];
  }

  /**
   * Everything the drawing code relies on, checked once at the boundary. An
   * inverted or empty range is refused rather than drawn upside down.
   * @param {any} sc
   * @returns {sc is PlotData}
   */
  function isPlotData(sc) {
    if (!sc || typeof sc !== 'object') return false;
    if (typeof sc.expression !== 'string' || typeof sc.variable !== 'string') return false;
    if (typeof sc.title !== 'string' || !isRange(sc.x_range) || !isRange(sc.y_range)) return false;
    if (!Number.isInteger(sc.samples) || sc.samples < 2) return false;
    if (!Number.isInteger(sc.points) || !Number.isInteger(sc.segments)) return false;
    return (
      Array.isArray(sc.curves) &&
      sc.curves.every(
        (/** @type {any} */ c) =>
          c &&
          Number.isInteger(c.start) &&
          c.start >= 0 &&
          Array.isArray(c.y) &&
          c.y.length > 0 &&
          c.start + c.y.length <= sc.samples &&
          c.y.every(isFiniteNumber)
      )
    );
  }

  /**
   * @param {any} result A CallToolResult.
   * @returns {PlotData}
   */
  function readPlot(result) {
    if (!result || typeof result !== 'object') throw new Error('The host sent no result.');
    if (result.isError) throw new Error(textOf(result) || 'The plot failed.');
    const sc = result.structuredContent;
    if (!isPlotData(sc)) throw new Error('The result carried no plot data this view can draw.');
    return sc;
  }

  /**
   * Shown only until the result arrives; from then on the server's resolved
   * `title` is used, so the view and the image never caption a plot differently.
   * @param {Record<string, unknown>} args
   */
  function placeholderTitle(args) {
    if (typeof args.title === 'string' && args.title) return args.title;
    if (typeof args.expression !== 'string') return 'Plot';
    const variable = typeof args.variable === 'string' && args.variable ? args.variable : 'x';
    return 'f(' + variable + ') = ' + args.expression;
  }

  // ---- drawing ---------------------------------------------------------

  /**
   * @template {keyof SVGElementTagNameMap} K
   * @param {K} name
   * @param {Record<string, string | number>} attrs
   * @param {string} [text]
   * @returns {SVGElementTagNameMap[K]}
   */
  function svgEl(name, attrs, text) {
    const node = document.createElementNS(SVG_NS, name);
    for (const k of Object.keys(attrs)) node.setAttribute(k, String(attrs[k]));
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * Same thresholds as `niceStep` in ../svg-renderer.ts, so the image and this
   * view grid a range alike. Keep the two in step.
   * @param {number} rough
   */
  function niceStep(rough) {
    const exp = Math.floor(Math.log10(rough));
    const frac = rough / Math.pow(10, exp);
    const nice = frac <= 1.5 ? 1 : frac <= 3.5 ? 2 : frac <= 7.5 ? 5 : 10;
    return nice * Math.pow(10, exp);
  }

  /** @param {number} lo @param {number} hi @param {number} target */
  function ticks(lo, hi, target) {
    const step = niceStep((hi - lo) / Math.max(2, target));
    const values = [];
    for (let k = Math.ceil(lo / step); k * step <= hi + step * 1e-9 && values.length < 60; k++) {
      values.push(k * step);
    }
    return { values, step };
  }

  /** @param {number} v @param {number} step */
  function formatTick(v, step) {
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    if (Math.abs(v) >= 1e7 || decimals > 8) return v.toExponential(2);
    const s = v.toFixed(decimals);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
  }

  /** @param {number} v */
  function formatValue(v) {
    const a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-6)) return v.toExponential(6);
    return String(Number(v.toPrecision(10)));
  }

  /** @param {number} v */
  function clampCoord(v) {
    return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));
  }

  /** @param {PlotData} data */
  function summary(data) {
    let s = data.points + ' of ' + data.samples + ' samples drawn';
    if (data.segments > 1) {
      s += ', ' + data.segments + ' segments (split where the function is undefined)';
    }
    return s;
  }

  /** @param {PlotData} data */
  function rangeText(data) {
    return (
      data.variable +
      ' from ' +
      formatValue(data.x_range[0]) +
      ' to ' +
      formatValue(data.x_range[1]) +
      ', y from ' +
      formatValue(data.y_range[0]) +
      ' to ' +
      formatValue(data.y_range[1])
    );
  }

  /**
   * Renders `data`. Touches no input: a redraw on resize must not overwrite a
   * range the user is still typing (see syncInputs).
   * @param {PlotData} data
   */
  function draw(data) {
    current = data;
    chart.classList.remove('empty');
    rangeControls.hidden = !canCallTools;
    inspectRow.hidden = false;
    const [x0, x1] = data.x_range;
    const [y0, y1] = data.y_range;
    // The sampler's grid (js-compute/mathjs-tasks.ts sampleGrid), recomputed
    // with the same operations so every x is the double the server evaluated at.
    const step = (x1 - x0) / (data.samples - 1);
    /** @param {number} i */
    const xAt = (i) => x0 + i * step;

    const width = Math.max(280, Math.round(chart.getBoundingClientRect().width) || 600);
    const height = VIEW_HEIGHT;
    const pw = width - MARGIN.left - MARGIN.right;
    const ph = height - MARGIN.top - MARGIN.bottom;
    /** @param {number} v */
    const sx = (v) => MARGIN.left + ((v - x0) / (x1 - x0)) * pw;
    /** @param {number} v */
    const sy = (v) => MARGIN.top + ((y1 - v) / (y1 - y0)) * ph;

    titleEl.textContent = data.title;
    chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    chart.setAttribute(
      'aria-label',
      'Graph of ' + data.title + ' for ' + rangeText(data) + '. ' + summary(data) + '.'
    );
    chart.replaceChildren();

    const xt = ticks(x0, x1, pw / 80);
    const yt = ticks(y0, y1, ph / 45);
    for (const v of xt.values) {
      const x = sx(v);
      chart.append(
        svgEl('line', { class: 'grid', x1: x, y1: MARGIN.top, x2: x, y2: MARGIN.top + ph }),
        svgEl(
          'text',
          { class: 'tick', x, y: height - 8, 'text-anchor': 'middle' },
          formatTick(v, xt.step)
        )
      );
    }
    for (const v of yt.values) {
      const y = sy(v);
      chart.append(
        svgEl('line', { class: 'grid', x1: MARGIN.left, y1: y, x2: MARGIN.left + pw, y2: y }),
        svgEl(
          'text',
          { class: 'tick', x: MARGIN.left - 6, y: y + 4, 'text-anchor': 'end' },
          formatTick(v, yt.step)
        )
      );
    }
    // Axes when the origin is in range, edges included, as svg-renderer.ts does.
    if (x0 <= 0 && x1 >= 0) {
      chart.append(
        svgEl('line', { class: 'axis', x1: sx(0), y1: MARGIN.top, x2: sx(0), y2: MARGIN.top + ph })
      );
    }
    if (y0 <= 0 && y1 >= 0) {
      chart.append(
        svgEl('line', {
          class: 'axis',
          x1: MARGIN.left,
          y1: sy(0),
          x2: MARGIN.left + pw,
          y2: sy(0),
        })
      );
    }

    const defs = svgEl('defs', {});
    const clip = svgEl('clipPath', { id: 'plot-clip' });
    clip.append(svgEl('rect', { x: MARGIN.left, y: MARGIN.top, width: pw, height: ph }));
    defs.append(clip);
    chart.append(defs);

    /** @type {(number | null)[]} */
    const drawn = Array.from({ length: data.samples }, () => null);
    const curves = svgEl('g', { 'clip-path': 'url(#plot-clip)' });
    for (const curve of data.curves) {
      let d = '';
      curve.y.forEach((y, k) => {
        const i = curve.start + k;
        drawn[i] = y;
        d +=
          (k === 0 ? 'M' : ' L') +
          clampCoord(sx(xAt(i))).toFixed(2) +
          ',' +
          clampCoord(sy(y)).toFixed(2);
      });
      // A lone sample has no line to draw; give it a visible stub.
      if (curve.y.length === 1) d += ' h0.01';
      curves.append(svgEl('path', { class: 'curve', d }));
    }
    chart.append(curves);
    chart.append(
      svgEl('rect', { class: 'frame', x: MARGIN.left, y: MARGIN.top, width: pw, height: ph })
    );

    const cursor = svgEl('line', {
      class: 'cursor',
      x1: 0,
      y1: MARGIN.top,
      x2: 0,
      y2: MARGIN.top + ph,
      visibility: 'hidden',
    });
    const dot = svgEl('circle', { class: 'dot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
    chart.append(cursor, dot);
    hover = { sx, sy, xAt, x0, y0, y1, step, width, pw, drawn, cursor, dot };

    inspect.max = String(data.samples - 1);
    if (Number(inspect.value) > data.samples - 1) inspect.value = String(data.samples - 1);
    inspect.setAttribute('aria-valuetext', summary(data));
    readout.textContent = summary(data);
  }

  /**
   * The drawn sample nearest to sample index `index`. It reports a sample the
   * server computed rather than interpolating between two of them.
   * @param {number} index
   * @returns {{ index: number, x: number, y: number } | null}
   */
  function nearestDrawn(index) {
    if (!hover) return null;
    const { drawn, xAt } = hover;
    for (let d = 0; d < drawn.length; d++) {
      for (const i of [index - d, index + d]) {
        const y = i >= 0 && i < drawn.length ? drawn[i] : null;
        if (y !== null) return { index: i, x: xAt(i), y };
      }
    }
    return null;
  }

  /** @param {number} index */
  function showSample(index) {
    if (!current || !hover) return;
    const s = nearestDrawn(index);
    if (!s) return;
    const cx = hover.sx(s.x);
    hover.cursor.setAttribute('x1', String(cx));
    hover.cursor.setAttribute('x2', String(cx));
    hover.cursor.setAttribute('visibility', 'visible');
    const inside = s.y >= hover.y0 && s.y <= hover.y1;
    hover.dot.setAttribute('cx', String(cx));
    hover.dot.setAttribute('cy', String(inside ? hover.sy(s.y) : 0));
    hover.dot.setAttribute('visibility', inside ? 'visible' : 'hidden');
    const text =
      'sample at ' +
      current.variable +
      ' ≈ ' +
      formatValue(s.x) +
      ':  f ≈ ' +
      formatValue(s.y) +
      (inside ? '' : ' (outside the y range)');
    readout.textContent = text;
    inspect.value = String(s.index);
    inspect.setAttribute('aria-valuetext', text);
  }

  /** @param {PointerEvent} event */
  function onPointer(event) {
    if (!current || !hover) return;
    const rect = chart.getBoundingClientRect();
    if (rect.width === 0) return;
    const px = (event.clientX - rect.left) * (hover.width / rect.width);
    if (px < MARGIN.left || px > MARGIN.left + hover.pw) {
      onLeave();
      return;
    }
    const x = hover.x0 + ((px - MARGIN.left) / hover.pw) * (current.x_range[1] - hover.x0);
    const index = Math.round((x - hover.x0) / hover.step);
    showSample(Math.max(0, Math.min(current.samples - 1, index)));
  }

  function onLeave() {
    if (!hover || !current) return;
    hover.cursor.setAttribute('visibility', 'hidden');
    hover.dot.setAttribute('visibility', 'hidden');
    readout.textContent = summary(current);
  }

  // ---- range controls --------------------------------------------------

  /** @param {string} message @param {boolean} [isError] */
  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.classList.toggle('error', !!isError);
  }

  /**
   * aria-disabled, not `disabled`: disabling the button that has focus drops
   * keyboard focus to <body>, so a second press of Zoom in would go nowhere.
   * The handlers check `busy` instead.
   * @param {boolean} value
   */
  function setBusy(value) {
    busy = value;
    for (const b of busyButtons) b.setAttribute('aria-disabled', value ? 'true' : 'false');
    chart.setAttribute('aria-busy', value ? 'true' : 'false');
  }

  /**
   * Puts the range that is drawn back into the inputs, at full precision so
   * an untouched input parses back to exactly the drawn bound.
   */
  function syncInputs() {
    if (!current) return;
    xMinInput.value = String(current.x_range[0]);
    xMaxInput.value = String(current.x_range[1]);
    markInvalid(false, false);
  }

  /** @param {boolean} badMin @param {boolean} badMax */
  function markInvalid(badMin, badMax) {
    for (const [input, bad] of /** @type {const} */ ([
      [xMinInput, badMin],
      [xMaxInput, badMax],
    ])) {
      if (bad) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', 'status');
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    }
  }

  /** @param {number} lo @param {number} hi */
  function replot(lo, hi) {
    if (!canCallTools || !current || busy) return;
    if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || !(lo < hi)) {
      const ordered = isFiniteNumber(lo) && isFiniteNumber(hi);
      markInvalid(!isFiniteNumber(lo) || ordered, !isFiniteNumber(hi) || ordered);
      setStatus('x min must be a number less than x max.', true);
      return;
    }
    markInvalid(false, false);
    // The original call with only the x range replaced: a y window, title or
    // anything else the caller chose survives zoom and pan.
    const args = Object.assign({}, toolArgs, {
      expression: current.expression,
      variable: current.variable,
      x_min: lo,
      x_max: hi,
    });
    const callId = ++latestCall;
    setBusy(true);
    setStatus('Plotting…');
    request('tools/call', { name: 'plot', arguments: args })
      .then((result) => {
        if (callId !== latestCall) return;
        const data = readPlot(result);
        draw(data);
        syncInputs();
        setStatus('Showing ' + rangeText(data) + '.');
      })
      .catch((e) => {
        if (callId !== latestCall) return;
        syncInputs();
        setStatus('Could not replot: ' + errorText(e), true);
      })
      .finally(() => {
        if (callId === latestCall) setBusy(false);
      });
  }

  /** @param {number} fraction */
  function shift(fraction) {
    if (!current) return;
    const [a, b] = current.x_range;
    const w = b - a;
    replot(a + w * fraction, b + w * fraction);
  }

  /** @param {number} factor */
  function zoom(factor) {
    if (!current || busy) return;
    const [a, b] = current.x_range;
    const c = (a + b) / 2;
    const h = ((b - a) / 2) * factor;
    const lo = c - h;
    const hi = c + h;
    if (!(hi - lo > Math.max(Math.abs(lo), Math.abs(hi)) * MIN_RELATIVE_WIDTH)) {
      setStatus(
        'Cannot zoom in further: the range is at the limit of floating-point precision.',
        true
      );
      return;
    }
    replot(lo, hi);
  }

  function applyTypedRange() {
    const lo = xMinInput.value.trim() === '' ? Number.NaN : Number(xMinInput.value);
    const hi = xMaxInput.value.trim() === '' ? Number.NaN : Number(xMaxInput.value);
    replot(lo, hi);
  }

  byId('apply', HTMLButtonElement).addEventListener('click', applyTypedRange);
  for (const input of [xMinInput, xMaxInput]) {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        applyTypedRange();
      }
    });
  }
  byId('pan-left', HTMLButtonElement).addEventListener('click', () => shift(-0.25));
  byId('pan-right', HTMLButtonElement).addEventListener('click', () => shift(0.25));
  byId('zoom-in', HTMLButtonElement).addEventListener('click', () => zoom(0.5));
  byId('zoom-out', HTMLButtonElement).addEventListener('click', () => zoom(2));
  resetButton.addEventListener('click', () => {
    if (!original) return;
    // Abandons a replot still in flight: its reply no longer matches latestCall.
    latestCall++;
    setBusy(false);
    draw(original);
    syncInputs();
    setStatus('Showing the original range, ' + rangeText(original) + '.');
  });
  inspect.addEventListener('input', () => showSample(Number(inspect.value)));
  chart.addEventListener('pointermove', onPointer);
  chart.addEventListener('pointerdown', onPointer);
  chart.addEventListener('pointerleave', onLeave);

  // ---- sizing ----------------------------------------------------------

  let lastWidth = 0;
  let lastHeight = 0;
  let frame = 0;
  function onResize() {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const w = Math.round(chart.getBoundingClientRect().width);
      if (current && w !== lastWidth) {
        lastWidth = w;
        draw(current);
      }
      const h = Math.ceil(document.documentElement.getBoundingClientRect().height);
      if (h !== lastHeight) {
        lastHeight = h;
        notify('ui/notifications/size-changed', { height: h });
      }
    });
  }

  // ---- start -----------------------------------------------------------

  window.addEventListener('message', onMessage);
  request('ui/initialize', {
    appInfo: APP_INFO,
    appCapabilities: {},
    protocolVersion: PROTOCOL_VERSION,
  }).then(
    (result) => {
      const r = result && typeof result === 'object' ? result : {};
      applyHostContext(r.hostContext);
      canCallTools = !!(r.hostCapabilities && r.hostCapabilities.serverTools);
      if (current) rangeControls.hidden = !canCallTools;
      notify('ui/notifications/initialized');
      if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(document.body);
      onResize();
    },
    (e) => setStatus('Could not connect to the host: ' + errorText(e), true)
  );
})();
