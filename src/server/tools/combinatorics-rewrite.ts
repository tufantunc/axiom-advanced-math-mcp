/**
 * Rewrite human combinatorics notation into Giac-native calls so compound
 * expressions like "C(4,2) * (5/6)^2" evaluate correctly in the raw Giac
 * path. Narrow by design: only numeric two-argument forms are rewritten, so
 * probability notation like P(X=2) and symbolic uses of C/P are untouched.
 */
export function rewriteCombinatorics(expr: string): string {
  return expr
    .replaceAll(/(?<![A-Za-z])C\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, 'comb($1,$2)')
    .replaceAll(/(?<![A-Za-z])P\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, 'perm($1,$2)')
    .replaceAll(/\b(?:combinations|nCr|binomial)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'comb($1,$2)')
    .replaceAll(/\b(?:permutations|nPr)\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'perm($1,$2)');
}
