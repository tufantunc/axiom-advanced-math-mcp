import { describe, it, expect } from 'vitest';
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INTEGRATION_TESTS } from '../vitest.suites.ts';
import unitConfig from '../vitest.config.ts';
import integrationConfig from '../vitest.config.integration.ts';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..');

function allTestFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return allTestFiles(full);
    if (!e.name.endsWith('.test.ts')) return [];
    // INTEGRATION_TESTS (and vitest's own globs) use forward slashes, so the
    // discovered paths have to as well — path.relative yields backslashes on
    // Windows, and CI runs a windows-latest leg.
    return [path.relative(repoRoot, full).split(path.sep).join('/')];
  });
}

/**
 * The unit and integration suites must partition test/ exactly.
 *
 * The list lives once (vitest.suites.ts), but a single list is not enough on
 * its own: what actually decides which suite runs a file is what each config
 * passes to vitest. So these assertions read the *resolved configs*, not just
 * the list — otherwise a config reverted to a hardcoded array would leave this
 * file green while integration tests ran under `npm test` with no build,
 * against a stale or absent dist/.
 */
describe('unit and integration suites partition test/', () => {
  const discovered = allTestFiles(testDir).sort();
  const integration = [...INTEGRATION_TESTS].sort();

  it('finds the test files at all', () => {
    // Guards against the walker returning nothing and everything below
    // passing vacuously.
    expect(discovered.length).toBeGreaterThan(50);
  });

  it('every integration entry names a file that exists', () => {
    for (const rel of integration) {
      expect(existsSync(path.join(repoRoot, rel)), rel).toBe(true);
    }
  });

  it('the integration config runs exactly the listed files', () => {
    expect([...(integrationConfig.test?.include ?? [])].sort()).toEqual(integration);
  });

  it('the unit config excludes exactly the listed files and includes the rest', () => {
    expect([...(unitConfig.test?.exclude ?? [])].sort()).toEqual(integration);
    expect(unitConfig.test?.include).toEqual(['test/**/*.test.ts']);
  });

  it('every test that reads dist/ is in the integration suite', () => {
    // The guard that actually catches something. Both configs read the one
    // shared array, so the partition holds by construction and asserting it
    // per-file can never fail. What CAN happen: a build-dependent test is added
    // (or an existing one dropped from the list), lands in the unit suite, and
    // runs against a stale or absent dist/ with no build step.
    // Exclude this file: it names 'dist/' in the probe below, so scanning
    // itself would always self-match — the same trap that made an earlier
    // marker-based version of this check useless.
    const self = path
      .relative(repoRoot, fileURLToPath(import.meta.url))
      .split(path.sep)
      .join('/');
    const buildDependent = discovered
      .filter((rel) => rel !== self)
      .filter((rel) => readFileSync(path.join(repoRoot, rel), 'utf8').includes('dist/'));
    expect(
      buildDependent.length,
      'no build-dependent tests found — check the probe'
    ).toBeGreaterThan(0);
    expect(buildDependent.filter((f) => !integration.includes(f))).toEqual([]);
  });

  it('no stale entry: every listed file was discovered', () => {
    // A stale name would otherwise sit in the config forever, matching nothing.
    expect(integration.filter((f) => !discovered.includes(f))).toEqual([]);
    // And no duplicates, which the set-based check above cannot see.
    expect(new Set(integration).size).toBe(integration.length);
  });
});
