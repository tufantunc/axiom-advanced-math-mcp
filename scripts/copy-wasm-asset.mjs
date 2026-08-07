/**
 * Copy the Giac WASM asset into the build output.
 *
 * `tsc` only emits compiled .ts files — it never copies plain .js assets. The
 * runtime loader (dist/server/giac/wasm-wrapper.js) resolves giac.wasm.js
 * relative to its own directory, so without this step a packaged install fails
 * at startup with "Giac WASM file not found".
 *
 * Written in Node rather than `cp` so it works on Windows too.
 */
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src', 'server', 'giac', 'giac.wasm.js');
const dest = join(root, 'dist', 'server', 'giac', 'giac.wasm.js');

if (!existsSync(src)) {
  console.error(
    `Giac WASM asset missing: ${src}\n` + 'Build it first:\n  npm run build:giac:wasm\n'
  );
  process.exit(1);
}

mkdirSync(dirname(dest), { recursive: true });
copyFileSync(src, dest);
console.log(`copied giac.wasm.js -> ${dest.slice(root.length + 1)}`);
