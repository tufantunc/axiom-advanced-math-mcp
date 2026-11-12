/**
 * Copy the non-TypeScript runtime assets into the build output.
 *
 * `tsc` only emits compiled .ts files; it never copies anything else. Two
 * runtime modules read files that sit next to them:
 *   - dist/server/giac/wasm-wrapper.js resolves giac.wasm.js relative to its own
 *     directory, so without it a packaged install fails at startup with
 *     "Giac WASM file not found".
 *   - dist/server/tools/plot/view.js reads the plot view's page, stylesheet and
 *     script from ./view/, so without them the MCP Apps view cannot be served.
 *
 * Written in Node rather than `cp` so it works on Windows too.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const ASSETS = [
  {
    path: ['server', 'giac', 'giac.wasm.js'],
    missing: 'Build it first:\n  npm run build:giac:wasm\n',
  },
  { path: ['server', 'tools', 'plot', 'view', 'plot-view.html'] },
  { path: ['server', 'tools', 'plot', 'view', 'plot-view.css'] },
  { path: ['server', 'tools', 'plot', 'view', 'plot-view.js'] },
];

for (const asset of ASSETS) {
  const src = join(root, 'src', ...asset.path);
  const dest = join(root, 'dist', ...asset.path);
  if (!existsSync(src)) {
    console.error(`Asset missing: ${src}\n${asset.missing ?? ''}`);
    process.exit(1);
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  console.log(`copied ${asset.path.at(-1)} -> ${dest.slice(root.length + 1)}`);
}
