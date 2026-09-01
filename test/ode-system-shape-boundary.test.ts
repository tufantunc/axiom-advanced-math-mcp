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
 * The import half of the invariant IS here: the closure walk below is the only
 * mechanism that can express "no path to the engine". The oxlint
 * no-restricted-imports rule over the same four files is an editor-time backstop
 * that fires faster and proves less — see the comment on that test.
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
  // no-restricted-imports rule in .oxlintrc.json is a denylist of specifier texts:
  // it fails fast on the imports someone is most likely to reach for, but most of
  // the modules under src/server/tools that reach the CAS are not among them (the
  // count is in ode-system-shape.ts's docblock, kept in one place so there is one
  // number to keep right), and a denylist cannot say "no path to the engine". An
  // earlier version of this file pinned an allowlist with an ordered
  // `toEqual`, which was deleted for failing on import ORDER — a real complaint
  // with the wrong remedy, since sorting fixes ordering and deleting it removed
  // the only check that saw the graph at all.
  //
  // So: walk the value-import closure from each guarded file and assert the engine
  // is not in it. This holds however deep the path is, for these specifier forms:
  // static `import ... from`, `export ... from` and `export * from`, side-effect
  // `import '...'`, dynamic `import('...')`, and `import x = require('...')` — in
  // single quotes, double quotes or backticks, whether or not the statement starts
  // its line. `import type` is skipped deliberately: it is erased at compile time
  // and reaches nothing.
  //
  // The list is closed on purpose, and it is closed because each round of widening
  // it was written after something walked through. First the scan read only
  // single-quoted static imports while the comment claimed it held regardless of
  // spelling, and `await import('../giac/index.js')` passed the walk, oxlint and
  // tsc. Then, with the comment claiming "either quote style", the backtick form
  // `import(\`../giac/index.js\`)` passed all four gates including prettier. What
  // this comment must not do is claim more than the three regexes below implement:
  // a specifier built by concatenation is NOT covered, and neither is
  // `createRequire(...)`.
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
      const specs = [
        // Anchored on a statement boundary, not a line start: `x = 1;export * from
        // '...'` puts the second module item mid-line, where a `\n\s*` anchor cannot
        // reach it. All three quote styles — a no-substitution template literal is
        // a string by the time the loader sees it.
        //
        // `(?!\s*type\b)` consumes the space itself. With `\s*` before the keyword
        // and a bare `(?!type\b)`, the lookahead is evaluated at the SPACE, where
        // `type` does not match, so it always succeeded and the exclusion below was
        // dead — `import type { G } from '../giac/interface.js'` was walked as a
        // value edge. It fails red rather than silent, but on a type-only import
        // that reaches nothing at runtime.
        ...stripped.matchAll(
          /(?:^|[\n;}])\s*(?:import|export)\s*(?!\s*type\b)(?:[^;]*?from\s*)?['"`]([^'"`]+)['"`]/g
        ),
        ...stripped.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g),
        // import-equals. tsc accepts it under this tsconfig and emits a working
        // createRequire shim, so it is a real path, not a dead form.
        ...stripped.matchAll(/\bimport\s+\w+\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/g),
      ].map((m) => m[1]);
      for (const spec of specs) {
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
