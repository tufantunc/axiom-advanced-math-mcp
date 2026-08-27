export interface PreprocessResult {
  expression: string;
}

export function preprocessExpression(expr: string): PreprocessResult {
  let r = expr.trim();

  // `\d+(?:\.\d*)?` rather than `\d+\.?\d*`. The latter can split a run of
  // digits many ways, so an input like 8000 digits followed by `x°` backtracks
  // catastrophically: measured at 208 s here, against 0.1 s for this form.
  // It runs before the expression reaches any worker, on the event loop, so
  // AXIOM_EVAL_TIMEOUT_MS does not bound it — one request would stall the whole
  // process. MAX_EXPRESSION_LENGTH is what keeps it bounded.
  r = r.replace(/(\d+(?:\.\d*)?)\s*°/g, '$1 deg');

  r = r.replace(/(?<![a-zA-Z])C\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/g, 'combinations($1, $2)');

  r = r.replace(/\bnCr\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'combinations($1, $2)');

  r = r.replace(/\bnPr\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'permutations($1, $2)');

  r = r.replace(/(\d+)\s+choose\s+(\d+)/gi, 'combinations($1, $2)');

  r = r.replace(/\bbinomial\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)/gi, 'combinations($1, $2)');

  return { expression: r };
}
