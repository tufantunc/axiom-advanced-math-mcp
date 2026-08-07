import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ENTRY = 'dist/server/transports/http-app.js';

/** Every `from '...'` / `import('...')` specifier in a compiled ES module. */
function specifiers(source: string): string[] {
  const out: string[] = [];
  const patterns = [/from\s+['"]([^'"]+)['"]/g, /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) out.push(m[1]);
  }
  return out;
}

/**
 * Walk the transitive closure of relative imports starting at `entry`,
 * collecting every bare `node:*` specifier encountered along the way.
 */
function nodeImportsInClosure(entry: string): { file: string; specifier: string }[] {
  const violations: { file: string; specifier: string }[] = [];
  const seen = new Set<string>();
  const queue = [resolve(entry)];

  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);

    for (const spec of specifiers(readFileSync(file, 'utf8'))) {
      if (spec.startsWith('node:')) {
        violations.push({ file, specifier: spec });
      } else if (spec.startsWith('.')) {
        queue.push(resolve(dirname(file), spec));
      }
      // Bare package specifiers (hono, @modelcontextprotocol/sdk) are not
      // walked: they are the dependency's own portability problem, and both
      // are Workers-compatible by design — the SDK's web-standard transport
      // documents Cloudflare Workers as a supported target.
    }
  }

  return violations;
}

describe('http-app portability boundary', () => {
  it('has a build to inspect', () => {
    expect(existsSync(ENTRY), `${ENTRY} missing — run \`npm run build\` first`).toBe(true);
  });

  it('imports no node: builtin anywhere in its transitive closure', () => {
    const violations = nodeImportsInClosure(ENTRY);
    const rendered = violations.map((v) => `${v.file} imports ${v.specifier}`).join('\n');
    expect(violations, `Workers portability boundary broken:\n${rendered}`).toEqual([]);
  });

  it('detects a node: builtin reached transitively (positive control)', () => {
    // Guards the guard. The entry file has no relative imports at all once
    // both of its dependencies are injected, so the walk over it cannot
    // demonstrate that traversal works — a broken walker would return an
    // empty violation list and the test above would pass vacuously.
    //
    // dist/server/index.js is a known-positive: it reaches node:child_process
    // six hops down, through tools/verify -> giac -> wrapper -> worker-host.
    // If the walker stops traversing, this test fails and tells us the guard
    // above has stopped guarding.
    const violations = nodeImportsInClosure('dist/server/index.js');
    expect(violations.some((v) => v.specifier === 'node:child_process')).toBe(true);
  });
});
