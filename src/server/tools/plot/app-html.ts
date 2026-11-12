import { VERSION } from '../../../version.js';

/**
 * The interactive view behind `plot`, served as the `ui://` resource that MCP
 * Apps hosts render in a sandboxed iframe (see `app.ts`).
 *
 * Self-contained on purpose: the host's default CSP for a resource that
 * declares no `csp` is `default-src 'none'` plus inline script and style, so
 * anything fetched from a CDN would be blocked — and nothing here needs it.
 * Kept as a string module rather than a file read at runtime so the package
 * needs no extra asset copy step and the unit suite needs no build.
 *
 * It speaks the View side of the MCP Apps protocol (spec 2026-01-26) directly
 * over postMessage instead of bundling `@modelcontextprotocol/ext-apps`: that
 * library's 2.x line requires the v2 SDK, and the part this view uses is the
 * handshake, three notifications and `tools/call`.
 *
 * Two rules the script keeps:
 *   - It never evaluates the expression. It draws the samples the server sent
 *     and, for a new range, asks the host to call `plot` again. A browser-side
 *     evaluator could disagree with the server's and draw a curve nobody
 *     computed.
 *   - Caller-controlled text (expression, title, error messages) reaches the
 *     DOM only through `textContent`, never as markup.
 *
 * Written with String.raw so the script's own backslash escapes survive; the
 * template must contain no backtick and no other interpolation.
 */
export const PLOT_APP_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Axiom plot</title>
<style>
  :root {
    --ax-bg: var(--color-background-primary, #ffffff);
    --ax-fg: var(--color-text-primary, #1f2328);
    --ax-muted: var(--color-text-secondary, #59636e);
    --ax-border: var(--color-border-primary, #d1d9e0);
    --ax-grid: var(--color-border-tertiary, #eef1f4);
    --ax-axis: var(--color-text-tertiary, #8c959f);
    --ax-curve: var(--color-text-info, #2563eb);
    --ax-danger: var(--color-text-danger, #b42318);
    --ax-control: var(--color-background-secondary, #f6f8fa);
    color-scheme: light;
  }
  :root[data-theme="dark"] {
    --ax-bg: var(--color-background-primary, #1b1d21);
    --ax-fg: var(--color-text-primary, #e6e8eb);
    --ax-muted: var(--color-text-secondary, #a3abb5);
    --ax-border: var(--color-border-primary, #3a3f46);
    --ax-grid: var(--color-border-tertiary, #2a2e34);
    --ax-axis: var(--color-text-tertiary, #6e7681);
    --ax-curve: var(--color-text-info, #7aa7ff);
    --ax-danger: var(--color-text-danger, #ff8a80);
    --ax-control: var(--color-background-secondary, #25292e);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ax-bg: var(--color-background-primary, #1b1d21);
      --ax-fg: var(--color-text-primary, #e6e8eb);
      --ax-muted: var(--color-text-secondary, #a3abb5);
      --ax-border: var(--color-border-primary, #3a3f46);
      --ax-grid: var(--color-border-tertiary, #2a2e34);
      --ax-axis: var(--color-text-tertiary, #6e7681);
      --ax-curve: var(--color-text-info, #7aa7ff);
      --ax-danger: var(--color-text-danger, #ff8a80);
      --ax-control: var(--color-background-secondary, #25292e);
      color-scheme: dark;
    }
  }
  html, body { margin: 0; background: var(--ax-bg); color: var(--ax-fg); }
  body {
    font-family: var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
    font-size: var(--font-text-sm-size, 14px);
    line-height: var(--font-text-sm-line-height, 1.45);
  }
  main { padding: 12px 16px; }
  h1 {
    margin: 0 0 8px;
    font-size: var(--font-heading-sm-size, 15px);
    font-weight: var(--font-weight-semibold, 600);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
    overflow-wrap: anywhere;
  }
  .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin: 0 0 8px; }
  .controls[hidden], #chart.empty { display: none; }
  label { display: inline-flex; align-items: center; gap: 4px; color: var(--ax-muted); }
  input, button {
    font: inherit;
    color: var(--ax-fg);
    background: var(--ax-control);
    border: 1px solid var(--ax-border);
    border-radius: var(--border-radius-sm, 6px);
    min-height: 30px;
  }
  input { width: 7.5em; padding: 2px 6px; }
  button { padding: 2px 10px; cursor: pointer; }
  button:disabled, input:disabled { opacity: 0.55; cursor: default; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--ax-curve); outline-offset: 1px; }
  .group { display: inline-flex; gap: 4px; }
  svg { display: block; width: 100%; height: auto; touch-action: pan-y; }
  .grid { stroke: var(--ax-grid); stroke-width: 1; }
  .axis { stroke: var(--ax-axis); stroke-width: 1; }
  .frame { fill: none; stroke: var(--ax-border); stroke-width: 1; }
  .tick { fill: var(--ax-muted); font-size: 11px; }
  .curve { fill: none; stroke: var(--ax-curve); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
  .cursor { stroke: var(--ax-axis); stroke-width: 1; stroke-dasharray: 3 3; }
  .dot { fill: var(--ax-curve); stroke: var(--ax-bg); stroke-width: 2; }
  p { margin: 6px 0 0; }
  #readout { color: var(--ax-muted); font-variant-numeric: tabular-nums; min-height: 1.45em; }
  #status:empty { display: none; }
  #status.error { color: var(--ax-danger); }
</style>
</head>
<body>
<main>
  <h1 id="title">Plot</h1>
  <div id="range" class="controls" role="group" aria-label="x range" hidden>
    <label>x min <input id="xmin" type="number" step="any" required></label>
    <label>x max <input id="xmax" type="number" step="any" required></label>
    <button type="button" id="apply">Apply</button>
    <span class="group" role="group" aria-label="Move the view">
      <button type="button" id="pan-left" aria-label="Pan left">&larr;</button>
      <button type="button" id="zoom-out" aria-label="Zoom out">&minus;</button>
      <button type="button" id="zoom-in" aria-label="Zoom in">+</button>
      <button type="button" id="pan-right" aria-label="Pan right">&rarr;</button>
      <button type="button" id="reset">Reset</button>
    </span>
  </div>
  <svg id="chart" class="empty" role="img" aria-label="Function plot" xmlns="http://www.w3.org/2000/svg"></svg>
  <p id="readout"></p>
  <p id="status" role="status">Waiting for the plot&hellip;</p>
</main>
<script>
(function () {
  'use strict';

  var PROTOCOL_VERSION = '2026-01-26';
  var APP_INFO = { name: 'axiom-math-plot', version: '${VERSION}' };
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var VIEW_HEIGHT = 320;
  var MARGIN = { top: 12, right: 16, bottom: 28, left: 58 };
  var REQUEST_TIMEOUT_MS = 30000;
  // Bounds the pixel coordinates handed to the SVG engine. A sample beside a
  // pole can map to 1e300 px, which some renderers drop the whole path for;
  // past this bound the segment is vertical on screen either way.
  var COORD_LIMIT = 1e6;

  function byId(id) { return document.getElementById(id); }
  var titleEl = byId('title');
  var chart = byId('chart');
  var readout = byId('readout');
  var statusEl = byId('status');
  // Not a <form>: a sandboxed iframe without allow-forms blocks submission
  // before the submit event fires, so Apply would silently do nothing.
  var rangeControls = byId('range');
  var xMinInput = byId('xmin');
  var xMaxInput = byId('xmax');
  var controls = Array.prototype.slice.call(rangeControls.querySelectorAll('input, button'));

  var nextId = 1;
  var pending = {};
  var toolArgs = null;
  var original = null;
  var current = null;
  var canCallTools = false;
  var latestCall = 0;
  var hover = null;

  // ---- transport -------------------------------------------------------

  function send(message) {
    window.parent.postMessage(message, '*');
  }

  function request(method, params, timeoutMs) {
    var id = nextId++;
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error(method + ' timed out'));
      }, timeoutMs);
      pending[id] = { resolve: resolve, reject: reject, timer: timer };
      send({ jsonrpc: '2.0', id: id, method: method, params: params });
    });
  }

  function notify(method, params) {
    var message = { jsonrpc: '2.0', method: method };
    if (params !== undefined) message.params = params;
    send(message);
  }

  function onMessage(event) {
    if (event.source !== window.parent) return;
    var m = event.data;
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return;

    if (typeof m.method !== 'string') {
      var waiter = pending[m.id];
      if (!waiter) return;
      delete pending[m.id];
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

    var params = m.params || {};
    if (m.method === 'ui/notifications/tool-input') {
      toolArgs = params.arguments || {};
      if (!current && typeof toolArgs.expression === 'string') {
        titleEl.textContent = plotTitle({
          variable: typeof toolArgs.variable === 'string' && toolArgs.variable ? toolArgs.variable : 'x',
          expression: toolArgs.expression,
        });
      }
    } else if (m.method === 'ui/notifications/tool-result') {
      showResult(params, true);
    } else if (m.method === 'ui/notifications/tool-cancelled') {
      if (!current) setStatus('The plot was cancelled.', true);
    } else if (m.method === 'ui/notifications/host-context-changed') {
      applyHostContext(params);
    }
  }

  // ---- host context ----------------------------------------------------

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    var root = document.documentElement;
    if (ctx.theme === 'light' || ctx.theme === 'dark') root.setAttribute('data-theme', ctx.theme);
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      Object.keys(vars).forEach(function (name) {
        if (/^--[a-z0-9-]+$/.test(name) && typeof vars[name] === 'string') {
          root.style.setProperty(name, vars[name]);
        }
      });
    }
  }

  // ---- results ---------------------------------------------------------

  function textOf(result) {
    return (result.content || [])
      .filter(function (c) { return c && c.type === 'text'; })
      .map(function (c) { return c.text; })
      .join('\n');
  }

  function isFiniteNumber(v) { return typeof v === 'number' && isFinite(v); }

  function readPlot(result) {
    if (!result || typeof result !== 'object') throw new Error('The host sent no result.');
    if (result.isError) throw new Error(textOf(result) || 'The plot failed.');
    var sc = result.structuredContent;
    var ok = sc && typeof sc.expression === 'string' && typeof sc.variable === 'string' &&
      Array.isArray(sc.x_range) && Array.isArray(sc.y_range) && Array.isArray(sc.polylines) &&
      sc.x_range.every(isFiniteNumber) && sc.y_range.every(isFiniteNumber) &&
      sc.polylines.every(function (line) { return Array.isArray(line) && line.every(isFiniteNumber); });
    if (!ok) throw new Error('The result carried no plot data this view can draw.');
    return sc;
  }

  function showResult(result, isOriginal) {
    var data;
    try {
      data = readPlot(result);
    } catch (e) {
      setStatus(e.message, true);
      return;
    }
    if (isOriginal) original = data;
    setStatus('');
    draw(data);
  }

  // ---- drawing ---------------------------------------------------------

  function svgEl(name, attrs, text) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { node.setAttribute(k, String(attrs[k])); });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function niceStep(raw) {
    var p = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / p;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p;
  }

  function ticks(lo, hi, target) {
    var step = niceStep((hi - lo) / Math.max(2, target));
    var out = [];
    for (var k = Math.ceil(lo / step); k * step <= hi + step * 1e-9 && out.length < 60; k++) {
      out.push(k * step);
    }
    return { values: out, step: step };
  }

  function formatTick(v, step) {
    var decimals = Math.max(0, -Math.floor(Math.log10(step)));
    if (Math.abs(v) >= 1e7 || decimals > 8) return v.toExponential(2);
    var s = v.toFixed(decimals);
    return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
  }

  function formatValue(v) {
    var a = Math.abs(v);
    if (a !== 0 && (a >= 1e9 || a < 1e-6)) return v.toExponential(6);
    return String(Number(v.toPrecision(10)));
  }

  function clampCoord(v) { return Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v)); }

  function plotTitle(data) {
    var t = toolArgs && typeof toolArgs.title === 'string' && toolArgs.title;
    return t || 'f(' + data.variable + ') = ' + data.expression;
  }

  function summary(data) {
    var s = data.points + ' of ' + data.samples + ' samples drawn';
    if (data.segments > 1) s += ', ' + data.segments + ' segments (split where the function is undefined)';
    return s;
  }

  function draw(data) {
    current = data;
    chart.setAttribute('class', '');
    rangeControls.hidden = !canCallTools;
    var x0 = data.x_range[0], x1 = data.x_range[1];
    var y0 = data.y_range[0], y1 = data.y_range[1];
    if (!(y1 > y0)) { y0 -= 1; y1 += 1; }

    var width = Math.max(280, Math.round(chart.getBoundingClientRect().width) || 600);
    var height = VIEW_HEIGHT;
    var pw = width - MARGIN.left - MARGIN.right;
    var ph = height - MARGIN.top - MARGIN.bottom;
    function sx(v) { return MARGIN.left + (v - x0) / (x1 - x0) * pw; }
    function sy(v) { return MARGIN.top + (y1 - v) / (y1 - y0) * ph; }

    titleEl.textContent = plotTitle(data);
    chart.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    chart.setAttribute('aria-label', 'Graph of ' + plotTitle(data) + ' for ' + data.variable +
      ' from ' + formatValue(x0) + ' to ' + formatValue(x1));
    while (chart.firstChild) chart.removeChild(chart.firstChild);

    var xt = ticks(x0, x1, pw / 80);
    var yt = ticks(y0, y1, ph / 45);
    xt.values.forEach(function (v) {
      var x = sx(v);
      chart.appendChild(svgEl('line', { class: 'grid', x1: x, y1: MARGIN.top, x2: x, y2: MARGIN.top + ph }));
      chart.appendChild(svgEl('text', { class: 'tick', x: x, y: height - 8, 'text-anchor': 'middle' }, formatTick(v, xt.step)));
    });
    yt.values.forEach(function (v) {
      var y = sy(v);
      chart.appendChild(svgEl('line', { class: 'grid', x1: MARGIN.left, y1: y, x2: MARGIN.left + pw, y2: y }));
      chart.appendChild(svgEl('text', { class: 'tick', x: MARGIN.left - 6, y: y + 4, 'text-anchor': 'end' }, formatTick(v, yt.step)));
    });
    if (x0 < 0 && x1 > 0) chart.appendChild(svgEl('line', { class: 'axis', x1: sx(0), y1: MARGIN.top, x2: sx(0), y2: MARGIN.top + ph }));
    if (y0 < 0 && y1 > 0) chart.appendChild(svgEl('line', { class: 'axis', x1: MARGIN.left, y1: sy(0), x2: MARGIN.left + pw, y2: sy(0) }));

    var defs = svgEl('defs', {});
    var clip = svgEl('clipPath', { id: 'plot-clip' });
    clip.appendChild(svgEl('rect', { x: MARGIN.left, y: MARGIN.top, width: pw, height: ph }));
    defs.appendChild(clip);
    chart.appendChild(defs);

    var curves = svgEl('g', { 'clip-path': 'url(#plot-clip)' });
    data.polylines.forEach(function (line) {
      if (line.length < 2) return;
      var d = '';
      for (var i = 0; i + 1 < line.length; i += 2) {
        d += (i === 0 ? 'M' : ' L') + clampCoord(sx(line[i])).toFixed(2) + ',' + clampCoord(sy(line[i + 1])).toFixed(2);
      }
      // A lone sample has no line to draw; give it a visible stub.
      if (line.length === 2) d += ' h0.01';
      curves.appendChild(svgEl('path', { class: 'curve', d: d }));
    });
    chart.appendChild(curves);
    chart.appendChild(svgEl('rect', { class: 'frame', x: MARGIN.left, y: MARGIN.top, width: pw, height: ph }));

    var cursor = svgEl('line', { class: 'cursor', x1: 0, y1: MARGIN.top, x2: 0, y2: MARGIN.top + ph, visibility: 'hidden' });
    var dot = svgEl('circle', { class: 'dot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
    chart.appendChild(cursor);
    chart.appendChild(dot);
    hover = { sx: sx, sy: sy, x0: x0, x1: x1, y0: y0, y1: y1, width: width, pw: pw, cursor: cursor, dot: dot };

    xMinInput.value = String(Number(x0.toPrecision(12)));
    xMaxInput.value = String(Number(x1.toPrecision(12)));
    readout.textContent = summary(data);
  }

  // Nearest drawn sample to the pointer, by x. It reports the sample the
  // server computed rather than interpolating between two of them.
  function nearestSample(x) {
    var best = null;
    current.polylines.forEach(function (line) {
      for (var i = 0; i + 1 < line.length; i += 2) {
        var d = Math.abs(line[i] - x);
        if (best === null || d < best.d) best = { d: d, x: line[i], y: line[i + 1] };
      }
    });
    return best;
  }

  function onPointer(event) {
    if (!current || !hover) return;
    var rect = chart.getBoundingClientRect();
    if (rect.width === 0) return;
    var px = (event.clientX - rect.left) * (hover.width / rect.width);
    if (px < MARGIN.left || px > MARGIN.left + hover.pw) { onLeave(); return; }
    var x = hover.x0 + (px - MARGIN.left) / hover.pw * (hover.x1 - hover.x0);
    var s = nearestSample(x);
    if (!s) return;
    var cx = hover.sx(s.x);
    hover.cursor.setAttribute('x1', cx);
    hover.cursor.setAttribute('x2', cx);
    hover.cursor.setAttribute('visibility', 'visible');
    var inside = s.y >= hover.y0 && s.y <= hover.y1;
    hover.dot.setAttribute('cx', cx);
    hover.dot.setAttribute('cy', inside ? hover.sy(s.y) : 0);
    hover.dot.setAttribute('visibility', inside ? 'visible' : 'hidden');
    readout.textContent = 'sample at ' + current.variable + ' ≈ ' + formatValue(s.x) +
      ':  f ≈ ' + formatValue(s.y) + (inside ? '' : ' (outside the y range)');
  }

  function onLeave() {
    if (!hover) return;
    hover.cursor.setAttribute('visibility', 'hidden');
    hover.dot.setAttribute('visibility', 'hidden');
    if (current) readout.textContent = summary(current);
  }

  // ---- range controls --------------------------------------------------

  function setStatus(message, isError) {
    statusEl.textContent = message;
    statusEl.className = isError ? 'error' : '';
  }

  function setBusy(busy) {
    controls.forEach(function (c) { c.disabled = busy; });
    chart.setAttribute('aria-busy', busy ? 'true' : 'false');
  }

  function replot(lo, hi) {
    if (!canCallTools || !current) return;
    if (!isFiniteNumber(lo) || !isFiniteNumber(hi) || !(lo < hi)) {
      setStatus('x min must be a number less than x max.', true);
      return;
    }
    var args = { expression: current.expression, variable: current.variable, x_min: lo, x_max: hi };
    if (toolArgs && typeof toolArgs.title === 'string') args.title = toolArgs.title;
    var callId = ++latestCall;
    setBusy(true);
    setStatus('Plotting…');
    request('tools/call', { name: 'plot', arguments: args }, REQUEST_TIMEOUT_MS).then(
      function (result) { if (callId === latestCall) showResult(result, false); },
      function (e) { if (callId === latestCall) setStatus('Could not replot: ' + e.message, true); }
    ).then(function () { if (callId === latestCall) setBusy(false); });
  }

  function shift(fraction) {
    var w = current.x_range[1] - current.x_range[0];
    replot(current.x_range[0] + w * fraction, current.x_range[1] + w * fraction);
  }

  function zoom(factor) {
    var c = (current.x_range[0] + current.x_range[1]) / 2;
    var h = (current.x_range[1] - current.x_range[0]) / 2 * factor;
    replot(c - h, c + h);
  }

  function applyTypedRange() {
    var lo = xMinInput.value.trim() === '' ? NaN : Number(xMinInput.value);
    var hi = xMaxInput.value.trim() === '' ? NaN : Number(xMaxInput.value);
    replot(lo, hi);
  }
  byId('apply').addEventListener('click', applyTypedRange);
  [xMinInput, xMaxInput].forEach(function (input) {
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') { event.preventDefault(); applyTypedRange(); }
    });
  });
  byId('pan-left').addEventListener('click', function () { if (current) shift(-0.25); });
  byId('pan-right').addEventListener('click', function () { if (current) shift(0.25); });
  byId('zoom-in').addEventListener('click', function () { if (current) zoom(0.5); });
  byId('zoom-out').addEventListener('click', function () { if (current) zoom(2); });
  byId('reset').addEventListener('click', function () {
    if (!original) return;
    latestCall++;
    setBusy(false);
    setStatus('');
    draw(original);
  });
  chart.addEventListener('pointermove', onPointer);
  chart.addEventListener('pointerdown', onPointer);
  chart.addEventListener('pointerleave', onLeave);

  // ---- sizing ----------------------------------------------------------

  var lastWidth = 0;
  var lastHeight = 0;
  var frame = 0;
  function onResize() {
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var w = Math.round(chart.getBoundingClientRect().width);
      if (current && w !== lastWidth) { lastWidth = w; draw(current); }
      var h = Math.ceil(document.documentElement.getBoundingClientRect().height);
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
  }, REQUEST_TIMEOUT_MS).then(function (result) {
    result = result || {};
    applyHostContext(result.hostContext);
    canCallTools = !!(result.hostCapabilities && result.hostCapabilities.serverTools);
    if (current) rangeControls.hidden = !canCallTools;
    notify('ui/notifications/initialized');
    if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(document.body);
    onResize();
  }, function (e) {
    setStatus('Could not connect to the host: ' + e.message, true);
  });
})();
</script>
</body>
</html>
`;
