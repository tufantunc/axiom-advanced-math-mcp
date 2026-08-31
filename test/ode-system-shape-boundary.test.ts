import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * The split's invariant, checked rather than asserted in a comment.
 *
 * The point of separating the shape half is that "no caller text reaches the
 * engine unchecked" becomes a property of the module graph. That only holds
 * while the shape half stays free of evaluation — and a comment claiming it is
 * exactly what went stale before: a note asserting the conditions were the only
 * caller text reaching an engine call is why the equation right-hand sides went
 * unguarded for a whole review round.
 *
 * The import half of the invariant is NOT here. It is an oxlint
 * no-restricted-imports rule scoped to this one path in .oxlintrc.json, which
 * fires as an error. This file used to pin the import list with an ordered
 * `toEqual`, which failed on import ORDER — something the invariant does not care
 * about — and whose cheapest green fix was to paste in the new list.
 */
describe('the shape half evaluates nothing', () => {
  const source = readFileSync('src/server/tools/ode-system-shape.ts', 'utf8');
  const code = source.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*/g, '');

  // The compiler is the stronger guard for these two: making validateSystemShape
  // `async` does not build, because its caller reads the result synchronously.
  // These rows catch the case where a NEW function in this file is async and is
  // invoked as `void helper()`, which would compile fine.
  it.each([['async'], ['await']])('contains no %s outside comments', (keyword) => {
    expect(code).not.toMatch(new RegExp(String.raw`\b${keyword}\b`));
  });

  it('names no engine symbol', () => {
    expect(code).not.toMatch(/giacEngine|GiacEngineLike|\.evaluate\(/);
  });

  // The transitive half, and the only mechanism that can state it. The oxlint
  // no-restricted-imports rule in .oxlintrc.json is a denylist of five spellings:
  // it fails fast on the imports someone is most likely to reach for, but 27 other
  // modules under src/server/tools also reach the CAS, and a denylist cannot say
  // "no path to the engine". An earlier version of this file pinned an allowlist
  // with an ordered `toEqual`, which was deleted for failing on import ORDER —
  // that was a real complaint with the wrong remedy, since sorting fixes ordering
  // and deleting it removed the only check that saw the graph at all.
  //
  // So: walk the value-import closure from each guarded file and assert the engine
  // is not in it. This holds no matter which module is added, or how the specifier
  // is spelt.
  it.each([
    ['src/server/tools/ode-system-shape.ts'],
    ['src/server/tools/output-cleanup.ts'],
    ['src/server/tools/unicode-normalize.ts'],
    ['src/server/tools/compute/arg-parsing.ts'],
  ])('reaches the engine from no path out of %s', (entry) => {
    const seen = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = readFileSync(file, 'utf8');
      const stripped = text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*/g, '');
      for (const m of stripped.matchAll(/(?:^|\n)\s*import\s+(?!type\b)[^;]*?from\s+'([^']+)'/g)) {
        const spec = m[1];
        if (!spec.startsWith('.')) continue;
        walk(resolve(dirname(file), spec.replace(/\.js$/, '.ts')));
      }
    };
    walk(entry);
    const engine = [...seen].filter((f) => f.includes('/src/server/giac/'));
    expect(engine).toEqual([]);
  });

  // The split invalidated all five comments in the original file that located
  // something by distance, each true while it was one 1210-line file: "only
  // happens to sit nearby", "139 lines ahead of the conditions scan", "300 lines
  // downstream", "a second refusal eleven lines away", "the checking above". The
  // extractions that followed then added two more of the same kind in new
  // docblocks — "a long way from", "far from ... further still from" — which is
  // why the last two rows exist: the first three assertions caught none of them.
  //
  // Every string quoted above is covered by an assertion below; if a phrasing is
  // named here it must fail, or this comment is doing what it was written to stop.
  // calculus.ts is here because it is the third file whose comments cross into the
  // pair, and it had written "the test below pins it" about a test in another file.
  it.each([
    ['src/server/tools/ode-system-shape.ts'],
    ['src/server/tools/ode-system.ts'],
    ['src/server/tools/calculus.ts'],
  ])('locates nothing in %s by distance', (path) => {
    const comments = readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trimStart().startsWith('//') || l.trimStart().startsWith('*'))
      .join('\n');
    expect(comments).not.toMatch(/\d+\s+lines\b/);
    expect(comments).not.toMatch(/\b(?:\w+ )?lines (?:ahead|downstream|away|below|above)\b/);
    expect(comments).not.toMatch(/\bsits? nearby\b/);
    expect(comments).not.toMatch(/\bthe (?:checking|check|scan|rule|code|block) (?:above|below)\b/);
    expect(comments).not.toMatch(/\b(?:far|a long way|further still)\s+from\b/);
  });
});
