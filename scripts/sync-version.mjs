#!/usr/bin/env node
/**
 * Copies package.json's version into src/version.ts.
 *
 * The two have to agree — the MCP server reports VERSION in `serverInfo`, so a
 * mismatch is visible to every client — and test/version.test.ts fails when
 * they do not. `npm version` only rewrites package.json, so without this the
 * release workflow would go red on a bump that looked complete.
 *
 * Wired to the `version` lifecycle script, which npm runs after bumping
 * package.json and before creating the version commit, so the rewritten file
 * lands in that same commit.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const versionFile = new URL('src/version.ts', root);

const { version } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));

const source = readFileSync(versionFile, 'utf8');
const declaration = /^export const VERSION = '[^']*';$/m;

// A silent no-op here would hand the release workflow a mismatch to discover,
// so refuse rather than guess if the file has been restructured.
if (!declaration.test(source)) {
  console.error(
    `sync-version: no \`export const VERSION = '...'\` line in ${fileURLToPath(versionFile)}`
  );
  process.exit(1);
}

const updated = source.replace(declaration, `export const VERSION = '${version}';`);

if (updated === source) {
  console.log(`sync-version: src/version.ts already at ${version}`);
} else {
  writeFileSync(versionFile, updated);
  console.log(`sync-version: src/version.ts -> ${version}`);
}
