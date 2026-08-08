#!/usr/bin/env node
/**
 * Copies package.json's version into the other files that carry it.
 *
 * `npm version` rewrites package.json alone, but the version lives in three
 * more places that must agree with it:
 *
 *   src/version.ts   the MCP server reports it in `serverInfo`, so a mismatch
 *                    is visible to every client (test/version.test.ts pins it)
 *   server.json      twice — the registry entry's own version, and the npm
 *                    package version it points at. The MCP registry resolves
 *                    that second one against npm, so a stale value publishes a
 *                    listing for a version that may not exist.
 *
 * Wired to the `version` lifecycle script, which npm runs after bumping
 * package.json and before creating the version commit, so the rewritten files
 * land in that same commit.
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

// --- server.json (MCP registry entry) -------------------------------------

const registryFile = new URL('server.json', root);
const registry = JSON.parse(readFileSync(registryFile, 'utf8'));

const npmPackage = registry.packages?.find((p) => p.registryType === 'npm');
if (!npmPackage) {
  console.error('sync-version: server.json has no npm package entry to update');
  process.exit(1);
}

const wasStale = registry.version !== version || npmPackage.version !== version;
registry.version = version;
// The registry resolves this against npm to verify the listing, so it has to
// name a version that is actually published.
npmPackage.version = version;

if (wasStale) {
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`);
  console.log(`sync-version: server.json -> ${version}`);
} else {
  console.log(`sync-version: server.json already at ${version}`);
}
