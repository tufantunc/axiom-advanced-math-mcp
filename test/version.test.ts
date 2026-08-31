import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { VERSION } from '../src/version.js';

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8')) as T;
}

/**
 * package.json owns the version; `scripts/sync-version.mjs` derives the other
 * three copies from it. This suite is the checker for that generator: every
 * copy the script writes has to be asserted here, or a stale one ships.
 *
 * server.json matters most and is the copy that had no guard. Nothing else
 * reads it: release.yml validates the tag and polls npm against
 * package.json's version, then hands server.json to `mcp-publisher`. So a
 * stale server.json passes every CI job and publishes an MCP-registry listing
 * naming a different release than the one that went out — the exact failure
 * sync-version.mjs says it exists to prevent.
 */
describe('version single source of truth', () => {
  const pkg = readJson<{ version: string }>('../package.json');

  it('matches the version field in package.json', () => {
    expect(VERSION).toBe(pkg.version);
  });

  it('matches the top-level version in server.json', () => {
    const registry = readJson<{ version: string }>('../server.json');
    expect(registry.version).toBe(pkg.version);
  });

  it('matches the npm package version in server.json', () => {
    // Same lookup sync-version.mjs uses, so the test tracks whichever entry
    // the script would rewrite rather than a fixed array index.
    const registry = readJson<{ packages?: { registryType: string; version: string }[] }>(
      '../server.json'
    );
    const npmPackage = registry.packages?.find((p) => p.registryType === 'npm');
    expect(npmPackage, 'server.json has no npm package entry').toBeDefined();
    expect(npmPackage?.version).toBe(pkg.version);
  });
});
