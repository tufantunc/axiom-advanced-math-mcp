import { readFileSync } from 'node:fs';
import { VERSION } from '../../../version.js';

/**
 * The page behind `plot`'s MCP Apps view, assembled from the real source files
 * in `./view/`.
 *
 * The page must be one self-contained document: a resource that declares no
 * `csp` gets the host's restrictive default, which blocks every remote load. So
 * the stylesheet and script that plot-view.html links (and that a browser loads
 * when the file is opened directly during development) are inlined here, and the
 * package version is filled in.
 *
 * They live as files, not as a string in a .ts module, so that the toolchain
 * checks them: tsconfig.view.json type-checks the script against the DOM lib,
 * oxlint lints it and prettier formats all three. `npm run build` copies them
 * next to this module in dist/ (scripts/copy-assets.mjs).
 */

const VIEW_DIR = new URL('./view/', import.meta.url);

const STYLESHEET_LINK = /<link rel="stylesheet" href="plot-view\.css" \/>/g;
const SCRIPT_TAG = /<script src="plot-view\.js"><\/script>/g;
const VERSION_PLACEHOLDER = '__AXIOM_VERSION__';

export interface PlotViewSources {
  html: string;
  css: string;
  js: string;
}

/** Replaces the single match of `pattern`; anything else is a broken page. */
function replaceOnce(text: string, pattern: RegExp, replacement: string, what: string): string {
  const count = text.match(pattern)?.length ?? 0;
  if (count !== 1) throw new Error(`plot view: expected one ${what}, found ${count}`);
  // A function, so `$&` or `$'` in the script is never read as a substitution.
  return text.replace(pattern, () => replacement);
}

/**
 * Builds the self-contained page. Pure, and exported so its guards can be
 * tested against sources that break them.
 */
export function assemblePlotView(sources: PlotViewSources, version: string): string {
  // Inlined text that closes its own element would end it early, and whatever
  // followed would be parsed as markup.
  if (/<\/style/i.test(sources.css)) throw new Error('plot view: the stylesheet contains </style');
  if (/<\/script/i.test(sources.js)) throw new Error('plot view: the script contains </script');

  const occurrences = sources.js.split(VERSION_PLACEHOLDER).length - 1;
  if (occurrences !== 1) {
    throw new Error(`plot view: expected one ${VERSION_PLACEHOLDER}, found ${occurrences}`);
  }
  const js = sources.js.replace(VERSION_PLACEHOLDER, () => version);

  let html = replaceOnce(
    sources.html,
    STYLESHEET_LINK,
    `<style>\n${sources.css}</style>`,
    'stylesheet link'
  );
  html = replaceOnce(html, SCRIPT_TAG, `<script>\n${js}</script>`, 'script tag');
  return html;
}

export function readPlotViewSources(): PlotViewSources {
  const read = (name: string) => readFileSync(new URL(name, VIEW_DIR), 'utf8');
  return { html: read('plot-view.html'), css: read('plot-view.css'), js: read('plot-view.js') };
}

let cached: string | undefined;

/**
 * The page, read and assembled on first use. Lazily, so a server whose view
 * files went missing still serves compute and verify; the integration suite
 * reads the resource from dist/ to catch that before release.
 */
export function plotViewHtml(): string {
  cached ??= assemblePlotView(readPlotViewSources(), VERSION);
  return cached;
}
