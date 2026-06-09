/**
 * Normalizes and parses math answers from various formats:
 * - Plain numbers: "42", "-3.14"
 * - Fractions: "1/3", "\frac{1}{3}", "\\frac{1}{3}"
 * - LaTeX: "\sqrt{2}", "2\pi", etc.
 * - Sets/lists: "{-2, 2}", "[1, 2, 3]"
 * - Symbolic expressions: "3*x^2", "sin(x)", "exp(x)/2"
 */

const NUMERIC_TOLERANCE = 1e-6;

/**
 * Try to convert a string to a number. Returns null if not possible.
 */
export function toNumber(s: string): number | null {
  const cleaned = s
    .replace(/\\!/g, '')         // LaTeX negative thin space: 17,\!280 → 17,280
    .replace(/,/g, '')           // remove thousand separators
    .replace(/\s/g, '')          // remove whitespace
    .replace(/^\\\$/, '')        // LaTeX dollar sign: \$460 → 460
    .replace(/^\$/, '')          // plain dollar sign: $460 → 460
    .replace(/^[€£¥₹₽]/u, '')   // other currency symbols
    .replace(/\\text\{[^}]*\}/g, '') // \text{...} wrappers
    .replace(/\\(?:mathrm|mathbf)\{([^}]*)\}/g, '$1') // \mathrm{}, \mathbf{}
    .trim();

  if (!cleaned) return null;

  // Plain number
  const n = parseFloat(cleaned);
  if (!isNaN(n) && String(n) === cleaned || /^-?[\d.]+$/.test(cleaned)) {
    return isNaN(n) ? null : n;
  }

  // Simple fraction: a/b
  const fracMatch = cleaned.match(/^(-?\d+)\/(\d+)$/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1]);
    const den = parseInt(fracMatch[2]);
    if (den !== 0) return num / den;
  }

  // LaTeX fraction: \frac{a}{b} or \dfrac{a}{b}, optionally with leading minus sign
  // Numerator and denominator can contain nested braces like \sqrt{N}
  // Uses (?:[^{}]|\{[^}]*\})+ to match one level of nested braces
  const latexFrac = cleaned.match(/^(-?)\\d?frac\{((?:[^{}]|\{[^}]*\})+)\}\{((?:[^{}]|\{[^}]*\})+)\}$/);
  if (latexFrac) {
    const sign = latexFrac[1] === '-' ? -1 : 1;
    const numVal = parseLatexAtom(latexFrac[2]);
    const denVal = parseLatexAtom(latexFrac[3]);
    if (numVal !== null && denVal !== null && denVal !== 0) return sign * (numVal / denVal);
  }

  // Standalone \sqrt{N}
  const sqrtMatch = cleaned.match(/^(-?)\\sqrt\{(\d+(?:\.\d+)?)\}$/);
  if (sqrtMatch) {
    const sign = sqrtMatch[1] === '-' ? -1 : 1;
    const inner = parseFloat(sqrtMatch[2]);
    if (!isNaN(inner)) return sign * Math.sqrt(inner);
  }

  // Percentage: "42%" → 42
  if (cleaned.endsWith('%')) {
    const pct = parseFloat(cleaned.slice(0, -1));
    if (!isNaN(pct)) return pct;
  }

  return null;
}

/**
 * Parse a single LaTeX atom that may appear inside \frac numerator/denominator.
 * Handles: plain integers/decimals, \sqrt{N}, and simple products like 3\sqrt{5}
 */
function parseLatexAtom(s: string): number | null {
  const t = s.trim();

  // Plain number
  const n = parseFloat(t);
  if (!isNaN(n) && /^-?\d+(\.\d+)?$/.test(t)) return n;

  // \sqrt{N}
  const sqrtMatch = t.match(/^\\sqrt\{(\d+(?:\.\d+)?)\}$/);
  if (sqrtMatch) return Math.sqrt(parseFloat(sqrtMatch[1]));

  // coefficient * \sqrt{N}  e.g. "3\\sqrt{5}"
  const coefSqrt = t.match(/^(-?\d+(?:\.\d+)?)\\sqrt\{(\d+(?:\.\d+)?)\}$/);
  if (coefSqrt) return parseFloat(coefSqrt[1]) * Math.sqrt(parseFloat(coefSqrt[2]));

  return null;
}

/**
 * Normalize a string answer for string comparison fallback.
 * Strips LaTeX markup, whitespace, and normalizes common symbols.
 */
export function normalizeString(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\*\*/g, '')       // markdown bold
    .replace(/\\\$/g, '')       // LaTeX dollar sign
    .replace(/[$€£¥₹₽]/gu, '') // currency symbols
    .replace(/\\,/g, '')
    .replace(/\\!/g, '')
    .replace(/\\;/g, '')
    .replace(/\\:/g, '')
    .replace(/\\\\/g, '')       // double backslash
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\mathrm\{([^}]*)\}/g, '$1')
    .replace(/\\mathbf\{([^}]*)\}/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/\^1\b/g, '')      // x^1 → x
    .replace(/\*1\b/g, '')      // x*1 → x
    .replace(/1\*/g, '')        // 1*x → x
    .replace(/\+0\b/g, '')      // x+0 → x
    .replace(/\\cdot/g, '*')
    .replace(/\\times/g, '*')
    .replace(/\bpi\b/g, 'π')
    .replace(/\\pi\b/g, 'π')
    .trim();
}

/**
 * Normalize a symbolic math expression for comparison.
 * Handles CAS output vs LaTeX vs natural notation differences.
 *
 * Examples:
 *   "3*x^2"               ↔ "3x^2" ↔ "3\\cdot x^{2}"
 *   "exp(x)"              ↔ "e^x" ↔ "e^{x}"
 *   "sin(x)^2"            ↔ "\\sin^2(x)" ↔ "\\sin^{2}(x)"
 *   "(x-3)*(x+3)"         ↔ "(x-3)(x+3)"
 *   "C_0*cos(x)+C_1*sin(x)" ↔ "c_1 cos(x) + c_2 sin(x)"
 */
export function normalizeSymbolic(s: string): string {
  let r = s;

  // Strip LaTeX display wrappers
  r = r.replace(/\$\$/g, '').replace(/\$/g, '');
  r = r.replace(/\\displaystyle\s*/g, '');
  r = r.replace(/\\left\s*/g, '').replace(/\\right\s*/g, '');

  // LaTeX \frac{a}{b} → (a)/(b)
  // Handle nested braces iteratively
  for (let i = 0; i < 5; i++) {
    r = r.replace(/\\d?frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
  }

  // LaTeX \sqrt{x} → sqrt(x)
  r = r.replace(/\\sqrt\{([^{}]+)\}/g, 'sqrt($1)');

  // LaTeX \ln → ln, \log → log, \sin → sin, etc.
  r = r.replace(/\\(sin|cos|tan|cot|sec|csc|arcsin|arccos|arctan|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|sqrt|abs)\b/g, '$1');

  // LaTeX e^{...} → exp(...)
  r = r.replace(/e\^\{([^{}]+)\}/g, 'exp($1)');
  r = r.replace(/e\^([a-zA-Z0-9])/g, 'exp($1)');

  // LaTeX x^{n} → x^n  (remove braces around single-token exponents)
  r = r.replace(/\^\{([^{}]+)\}/g, '^($1)');

  // LaTeX \cdot and \times → *
  r = r.replace(/\\cdot/g, '*').replace(/\\times/g, '*');

  // Strip remaining LaTeX commands: \, \; \: \! \text{} \mathrm{} etc.
  r = r.replace(/\\text\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathrm\{([^}]*)\}/g, '$1');
  r = r.replace(/\\mathbf\{([^}]*)\}/g, '$1');
  r = r.replace(/\\[,;:!]/g, '');
  r = r.replace(/\\ /g, '');

  // Remove remaining braces (but not parentheses)
  r = r.replace(/[{}]/g, '');

  // Normalize whitespace
  r = r.replace(/\s+/g, '');

  // Lowercase
  r = r.toLowerCase();

  // Normalize multiplication: "2x" = "2*x", but be careful
  // Insert * between number and letter: 3x → 3*x, 2sin → 2*sin
  r = r.replace(/(\d)([a-z])/g, '$1*$2');
  // Insert * between closing paren and opening paren or letter: )(  → )*(, )x → )*x
  r = r.replace(/\)(\()/g, ')*$1');
  r = r.replace(/\)([a-z])/g, ')*$1');
  // Insert * between letter/paren and opening paren (if not a function name):
  // NOT: sin( cos( exp( etc. — only standalone letters: x( → x*(
  r = r.replace(/([a-z])(\()(?<!sin\(|cos\(|tan\(|cot\(|sec\(|csc\(|exp\(|log\(|ln\(|sqrt\(|abs\(|atan\(|asin\(|acos\(|sinh\(|cosh\(|tanh\(|arcsin\(|arccos\(|arctan\()/g, '$1*$2');

  // Normalize constant naming: c_0, c_1, C, C1, c1 → generic constants
  // Replace all constant patterns with canonical form
  r = r.replace(/c_?(\d)/gi, 'K$1');
  r = r.replace(/\bc\b/gi, 'K');

  // Normalize pi
  r = r.replace(/\\pi/g, 'pi');

  // Remove redundant outer parentheses: ((expr)) → (expr)
  if (r.startsWith('(') && r.endsWith(')')) {
    let depth = 0;
    let outerMatch = true;
    for (let i = 0; i < r.length - 1; i++) {
      if (r[i] === '(') depth++;
      else if (r[i] === ')') depth--;
      if (depth === 0 && i < r.length - 1) { outerMatch = false; break; }
    }
    if (outerMatch) r = r.slice(1, -1);
  }

  // Remove explicit *1 and 1*
  r = r.replace(/\*1\b/g, '').replace(/\b1\*/g, '');

  // Remove trailing + constant of integration markers
  r = r.replace(/\+K\b$/i, '');

  return r;
}

/**
 * Check if a string looks like a symbolic math expression (not just a number).
 */
export function isSymbolic(s: string): boolean {
  const trimmed = s.trim();
  if (!trimmed) return false;
  // Contains variable letters that aren't just 'e' or 'i' as constants
  if (/[a-df-hj-zA-DF-HJ-Z]/.test(trimmed)) return true;
  // Contains function calls: sin(, cos(, exp(, etc.
  if (/\b(sin|cos|tan|exp|ln|log|sqrt|abs|atan|asin|acos)\s*\(/i.test(trimmed)) return true;
  // Contains CAS operators
  if (/[a-zA-Z]\^/.test(trimmed)) return true;
  return false;
}

/**
 * Strip markdown/LaTeX formatting from a captured answer token.
 * e.g. "**$460**" → "460", "\\$460" → "460", "243." → "243"
 */
function cleanExtracted(s: string): string {
  return s
    .replace(/\*\*/g, '')        // markdown bold
    .replace(/^\\\$/g, '')       // LaTeX dollar \$
    .replace(/^\$/g, '')         // plain dollar $
    .replace(/^[€£¥₹₽]/u, '')   // other currency
    .replace(/[.,;:!?)}\]]+$/, '') // trailing punctuation (keep leading minus)
    .trim();
}

/**
 * Extract the final answer from model response text.
 * Looks for (in priority order):
 * 1. \boxed{...} (MATH/Omni-MATH format)
 * 2. "#### N" (GSM8K format — though model might not use it)
 * 3. "The answer is N" / "the final answer is N" / "= N" at end
 * 4. Markdown-bold standalone number: **42** or **$460**
 * 5. Last number in the text
 */
export function extractModelAnswer(text: string): string {
  // 1. \boxed{...} — prefer the LAST fully-balanced box. A model that copies a
  //    long expression sometimes emits a complete box followed by a truncated
  //    one; fall back past the incomplete trailing box to the last complete one.
  {
    let searchFrom = 0;
    let lastComplete: string | null = null;
    for (;;) {
      const boxedIdx = text.indexOf('\\boxed{', searchFrom);
      if (boxedIdx === -1) break;
      const start = boxedIdx + 7;
      let depth = 0;
      let i = start;
      let closed = false;
      for (; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') {
          if (depth === 0) {
            closed = true;
            break;
          }
          depth--;
        }
      }
      if (closed) {
        const inner = text.slice(start, i).trim();
        if (inner) lastComplete = inner;
      }
      searchFrom = start;
    }
    if (lastComplete !== null) return cleanExtracted(lastComplete);
  }

  // 2. #### N (GSM8K)
  const gsm8kMatches = [...text.matchAll(/####\s*([\d,.-]+)/g)];
  if (gsm8kMatches.length > 0) {
    return gsm8kMatches[gsm8kMatches.length - 1][1].replace(/,/g, '');
  }

  // 3. "The answer is N" — broadened patterns (case-insensitive)
  //    Uses matchAll + takes LAST match to handle multi-turn text where
  //    earlier turns may contain intermediate "answer is" statements.
  //    Supports both numeric ("42") and symbolic ("3*x^2", "sin(x)") answers.
  const answerPatterns = [
    // "The answer is ..." — captures everything until end of line or next sentence
    /[Tt]he\s+(?:final\s+)?answer\s+is[:\s]+\*{0,2}\$?([\d,.\-/\\a-zA-Z^()*_+{}]+(?:\([^)]*\))*(?:\{[^}]*\})*)\*{0,2}/g,
    /[Aa]nswer[:\s]+\*{0,2}\$?([\d,.\-/\\a-zA-Z^()*_+{}]+(?:\([^)]*\))*(?:\{[^}]*\})*)\*{0,2}/g,
    /[Tt]herefore[,:]?\s+.*?(?:is|=)\s+\*{0,2}\$?([\d,.\-/\\a-zA-Z^()*_+{}]+(?:\([^)]*\))*)\*{0,2}/g,
    /(?:^|\n)\s*=\s*\*{0,2}\$?([\d,.\-/\\a-zA-Z^()*_+{}]+)\*{0,2}\s*$/gm,
  ];
  for (const pat of answerPatterns) {
    const matches = [...text.matchAll(pat)];
    if (matches.length > 0) {
      const extracted = cleanExtracted(matches[matches.length - 1][1]);
      if (extracted && /[\da-zA-Z]/.test(extracted)) return extracted;
    }
  }

  // 3b. If the entire trimmed input looks like a simple fraction (e.g. "-82/27"),
  //     return it verbatim so the numeric grader can evaluate it correctly.
  const simpleFrac = text.trim().match(/^(-?\d+\/\d+)$/);
  if (simpleFrac) return simpleFrac[1];

  // 4. Markdown-bold number near end of text: **460**, **$460**, **\$460**
  //    Only look in the last 300 characters to avoid picking up intermediate results
  const tail = text.slice(-300);
  const boldNumbers = [...tail.matchAll(/\*\*\$?\\?\$?([\d,.\-/]+)\*\*/g)];
  if (boldNumbers.length > 0) {
    const last = boldNumbers[boldNumbers.length - 1][1];
    const cleaned = cleanExtracted(last);
    if (cleaned && /\d/.test(cleaned)) return cleaned;
  }

  // 5. Last number in text — search from the end, skip false positives
  //    Filter out "Step 1", "Rule 2", "#3", ordinals like "1st", "2nd", etc.
  const FALSE_POSITIVE_PREFIX = /(?:step|rule|#|item|part|case|option|method)\s*$/i;
  const ORDINAL_SUFFIX = /^(?:st|nd|rd|th)\b/i;

  const numberMatches = [...text.matchAll(/(?:^|[\s=:$(*])(-?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?)/g)];
  // Walk backwards to find the last genuine numeric answer
  for (let j = numberMatches.length - 1; j >= 0; j--) {
    const m = numberMatches[j];
    const num = m[1];
    const beforeIdx = m.index!;
    const afterIdx = beforeIdx + m[0].length;

    // Skip if preceded by "Step", "Rule", etc.
    const before = text.slice(Math.max(0, beforeIdx - 10), beforeIdx + (m[0].length - num.length));
    if (FALSE_POSITIVE_PREFIX.test(before)) continue;

    // Skip ordinals: "1st", "2nd", "3rd", "4th"
    const after = text.slice(afterIdx);
    if (ORDINAL_SUFFIX.test(after)) continue;

    return cleanExtracted(num);
  }

  // 5b. Relaxed: any last number
  const anyNumbers = [...text.matchAll(/-?(?:\d+\.?\d*|\.\d+)/g)];
  if (anyNumbers.length > 0) {
    return anyNumbers[anyNumbers.length - 1][0];
  }

  return text.trim().slice(-50); // last 50 chars as fallback
}
