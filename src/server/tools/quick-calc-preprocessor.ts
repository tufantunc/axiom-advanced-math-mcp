export interface PreprocessResult {
  expression: string;
}

export function preprocessExpression(expr: string): PreprocessResult {
  let r = expr.trim();

  r = r.replace(/(\d+\.?\d*)\s*°/g, '$1 deg');

  r = r.replace(/(?<![a-zA-Z])C\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, 'combinations($1, $2)');

  r = r.replace(/\bnCr\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'combinations($1, $2)');

  r = r.replace(/\bnPr\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'permutations($1, $2)');

  r = r.replace(/(\d+)\s+choose\s+(\d+)/gi, 'combinations($1, $2)');

  r = r.replace(/\bbinomial\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'combinations($1, $2)');

  return { expression: r };
}
