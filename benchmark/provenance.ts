import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * What a result file needs in order to be comparable with another one.
 *
 * Runs used to record the model, the mode and the numbers, and nothing about
 * how they were produced. That made the archive uninterpretable: CAS-quick
 * deltas across the recorded history range from -13.3pp to +21.7pp, and there
 * is no way to tell, after the fact, which of those runs used which grader
 * version or which feature flags. Two runs that disagree by 30 points might be
 * measuring different things or might be the same thing twice — the files do
 * not say.
 *
 * `dirty` matters as much as `commit`. A run against uncommitted changes cannot
 * be reproduced from the repository at all, so a number produced that way
 * should never be quoted as a project result.
 */
export interface RunProvenance {
  /** Feature flags the run was invoked with (`--features=...`). */
  features: string[];
  /** N-sample voting config, when `self-consistency` was enabled. */
  selfConsistency: { N: number; temperature: number } | null;
  /** Repository commit the grader and server code came from. */
  commit: string;
  /** True when the working tree had uncommitted changes: not reproducible. */
  dirty: boolean;
  /** Version of the MCP server under test. */
  serverVersion: string;
  nodeVersion: string;
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function collectProvenance(
  features: string[],
  selfConsistency: { N: number; temperature: number } | null
): RunProvenance {
  let serverVersion = 'unknown';
  try {
    serverVersion = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8')
    ).version as string;
  } catch {
    // leave as unknown; a missing version should not abort a benchmark run
  }

  return {
    features,
    selfConsistency,
    commit: git(['rev-parse', 'HEAD']) ?? 'unknown',
    // --porcelain prints one line per changed path, so any output means dirty.
    dirty: (git(['status', '--porcelain']) ?? '') !== '',
    serverVersion,
    nodeVersion: process.version,
  };
}

/** One-line rendering for the markdown report header. */
export function formatProvenance(p: RunProvenance): string {
  const flags = p.features.length > 0 ? p.features.join(',') : 'none';
  const sc = p.selfConsistency ? `N=${p.selfConsistency.N}@t${p.selfConsistency.temperature}` : 'off';
  const commit = p.commit === 'unknown' ? 'unknown' : p.commit.slice(0, 7);
  return [
    `**Features:** ${flags}`,
    `**Self-consistency:** ${sc}`,
    `**Server:** v${p.serverVersion}`,
    `**Commit:** ${commit}${p.dirty ? ' (dirty — not reproducible)' : ''}`,
    `**Node:** ${p.nodeVersion}`,
  ].join(' | ');
}
