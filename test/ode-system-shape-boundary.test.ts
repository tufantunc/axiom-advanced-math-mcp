import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The split's invariant, checked rather than asserted in a comment.
 *
 * The point of separating the shape half is that "no caller text reaches the
 * engine unchecked" becomes a property of the module graph. That only holds
 * while the shape half stays free of evaluation — and a comment claiming it is
 * exactly what went stale before: a note asserting the conditions were the only
 * caller text reaching an engine call is why the equation right-hand sides went
 * unguarded for a whole review round.
 */
describe('the shape half evaluates nothing', () => {
  const source = readFileSync('src/server/tools/ode-system-shape.ts', 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replaceAll(/\/\/.*/g, '');

  // The compiler is the stronger guard for these two: making validateSystemShape
  // `async` does not build, because its caller reads the result synchronously.
  // These rows catch the case where a NEW function in this file is async, which
  // would compile fine.
  it.each([['async'], ['await']])('contains no %s outside comments', (keyword) => {
    expect(code).not.toMatch(new RegExp(String.raw`\b${keyword}\b`));
  });

  it('imports nothing that can evaluate', () => {
    // `nestingDepth` from giac-eval is a pure text measurement, which is why it
    // is named here rather than covered by a blanket rule.
    const imports = [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual([
      './compute/arg-parsing.js',
      './giac-eval.js',
      './output-cleanup.js',
      './unicode-normalize.js',
    ]);
    expect(code).not.toMatch(/giacEngine|GiacEngineLike|\.evaluate\(/);
  });
});
