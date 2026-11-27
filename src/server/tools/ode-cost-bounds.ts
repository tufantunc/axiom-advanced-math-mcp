import { excerpt } from './output-cleanup.js';
import { factorialLog10, tokenizeMagnitude, type MagnitudeToken } from './ode-condition-bounds.js';
import { unicodeToAscii } from './unicode-normalize.js';

/**
 * The COST bounds on a whole ODE problem — the equation and every condition the
 * solver will see together — as opposed to the SIZE bounds in
 * ode-condition-bounds.ts, which read one piece of text at a time.
 *
 * Text-only, like the two files it sits beside: no `async`, no engine symbol,
 * and no import path to `src/server/giac`. ode-system-shape-boundary.test.ts
 * checks all three for this file as it does for those.
 *
 * Two axes, each measured on main with one input per fresh worker and the
 * default 10s budget:
 *
 *   - HEIGHT, the size of the exact numbers. An exact root of an integer past
 *     the largest double does not finish: `sqrt(17*10^307)` answers in the
 *     single-equation fold in 20ms, `sqrt(18*10^307+1)` times out, and the step
 *     is flat on either side (a 306-digit radicand answers in 31ms). The solver
 *     takes those roots ITSELF from bare numbers, so writing no `sqrt` is no
 *     defence: `y''+(10^400+1)*y=0` (a characteristic root),
 *     `y''+(10^160+1)*y'+y=0` (a discriminant that squares the coefficient),
 *     `y'=y+1/(x^2+10^400+1)` (an `atan` integral), `y'=(10^400+1)*y^2+1` (a
 *     Riccati equation) and `y'=2*sqrt(y), y(0)=10^400+1` (a constant solved
 *     from a square) each burn the full budget, and every one of them was
 *     inside the 3,000-digit magnitude bound.
 *   - EXPANSION, the size of the polynomial a power of a sum expands to.
 *     `y'=(x+1)^n*y` takes 0.2s at n=50, 1.6s at 100, 6.7s at 150 and times out
 *     at 200, all in desolve itself; `y'=x^5000*y` is 25ms. The cost composes:
 *     `(x+1)^99*(x+2)^99*y` takes 6.4s, `((x+1)^14+1)^14*y` 6.4s, and
 *     `(x+a+1)^40*y` — a second symbol — times out.
 *
 * Both are read off one small expression tree built from the same tokens the
 * magnitude reader uses, so the three bounds agree about where every number,
 * name, bracket and operator is.
 */

/**
 * Ceiling on the HEIGHT of a problem's numbers, summed over all of them: for
 * each number, log10 of the larger of its numerator and denominator as an exact
 * rational, with a power of a number charged its exponent times over.
 *
 * Summed over the WHOLE problem because the roots the solver takes combine the
 * caller's numbers: a second-order discriminant is p^2-4q, a rational
 * coefficient a/b brings its denominator along, and a constant fixed by a
 * condition mixes the condition's value with the equation's coefficients. A
 * product of any two numbers from a problem of total height h has height at
 * most 2h, so 150 keeps every such root below 10^300 against a measured cliff
 * at 10^308.25. Measured at the edge: `y''+(10^150+1)*y'+y=0` answers in 71ms,
 * `y''+(10^160+1)*y'+y=0` times out.
 *
 * The cliff does not move with heap state the way the magnitude cliffs in
 * ode-condition-bounds.ts do — it is the largest double, not an allocation —
 * so the headroom is in the factor of two for a product, not in the constant.
 * A product of three numbers can still reach it; none of the shapes measured
 * forms one.
 *
 * The cost: a number that is never rooted is refused all the same.
 * `y'=y*2^4096` answers in 17ms, and `y'=y*10^200` in about as long, because a
 * first-order linear equation forms no root — but `y''+(2^4096+1)*y=0` traps,
 * and which equations form roots is the solver's business, not the text's.
 * And because the sum is over every number, many small ones count together: a
 * polynomial with written coefficients 1..50 is 64.5 digits and admitted, and
 * one with coefficients 1..120 is 199 and refused. Summing is what catches a
 * product of coefficients from different terms, which no per-term bound sees.
 */
const MAX_PROBLEM_HEIGHT = 150;

/**
 * Ceiling on the EXPANSION estimate of any subexpression: terms times digits,
 * where terms is an upper bound on how many monomials it expands to and digits
 * bounds the coefficients.
 *
 * Calibrated on `y'=(x+1)^n*y`, the costliest position measured (as a forcing
 * term the same power is several times cheaper): n=50 is 816 and answers in
 * 0.2s, n=97 is 2,961 and answers in about 1.5s, n=150 is 6,946 at 6.7s and
 * n=200 is 12,241 and times out. 3,000 admits the first two and keeps a factor
 * of four below the lowest estimate measured to time out. The estimate
 * over-counts the multinomial cases — `(x^2+x+1)^100*y` is 9,789 and answered
 * in 6.9s — so those are refused earlier than their time requires, which is
 * the direction an estimate may err in.
 */
const MAX_EXPANSION = 3_000;

/**
 * Ceiling on how deeply the tree may nest. Above it the tree is not built and
 * the problem is refused: an equation 200 deep burns the budget in the engine
 * (measured for conditions in ode-condition-bounds.ts), and recursion this
 * file cannot finish is not a bound.
 */
const MAX_COST_DEPTH = 100;

type Span = { from: number; to: number };

type CostNode = Span &
  (
    | { kind: 'number'; text: string; value: number }
    | { kind: 'name'; text: string }
    | { kind: 'call'; name: string; args: CostNode[] }
    | { kind: 'negate'; operand: CostNode }
    | { kind: 'sum' | 'product'; left: CostNode; right: CostNode }
    | { kind: 'power'; base: CostNode; exponent: CostNode }
    | { kind: 'factorial'; operand: CostNode }
    | { kind: 'group'; items: CostNode[] }
    | { kind: 'deep' }
    | { kind: 'empty' }
  );

/**
 * The tokens, with a derivative's primes folded into its name so `y''` is one
 * symbol rather than a name and two separators, and Giac's boolean keywords
 * made separators: the single-equation path folds its conditions in as
 * `(y'=…) and (y(0)=1)`, and read as a name `and` would multiply the equation
 * by its own conditions.
 */
function costTokens(text: string): MagnitudeToken[] {
  const merged: MagnitudeToken[] = [];
  for (const token of tokenizeMagnitude(text)) {
    const last = merged[merged.length - 1];
    if (token.text === "'" && last?.kind === 'name') {
      merged[merged.length - 1] = { ...last, text: `${last.text}'` };
    } else if (token.kind === 'name' && BOOLEAN_WORDS.has(token.text)) {
      merged.push({ ...token, kind: 'separator' });
    } else merged.push(token);
  }
  return merged;
}

const BOOLEAN_WORDS: ReadonlySet<string> = new Set(['and', 'or', 'xor', 'not']);

/**
 * The tree, built with the magnitude reader's precedence: `!` binds tighter
 * than `^`, `^` is right-associative and tighter than a sign, and juxtaposition
 * (`2x`, `(x+1)(x+2)`) multiplies. Every other separator — `=`, `;`, a stray
 * `)` — joins its sides as a sum, which is the conservative reading for both
 * folds. Never throws and always consumes the input.
 */
function parseCost(tokens: MagnitudeToken[]): { root: CostNode; tooDeep: boolean } {
  let at = 0;
  let tooDeep = false;
  const deep = (): CostNode => {
    tooDeep = true;
    return { kind: 'deep', from: 0, to: 0 };
  };
  const peek = (): MagnitudeToken | undefined => tokens[at];
  const isOp = (text: string): boolean => peek()?.kind === 'op' && peek()?.text === text;
  const span = (from: number): Span => ({
    from: tokens[from]?.at ?? 0,
    to: (tokens[at - 1]?.at ?? 0) + (tokens[at - 1]?.text.length ?? 0),
  });
  const startsOperand = (): boolean => {
    const token = peek();
    return (
      token !== undefined &&
      (token.kind === 'number' ||
        token.kind === 'name' ||
        (token.kind === 'op' && (token.text === '(' || token.text === '[')))
    );
  };

  function items(closer: string, depth: number): CostNode[] {
    const list: CostNode[] = [];
    while (at < tokens.length && !isOp(closer)) {
      const before = at;
      list.push(join(depth + 1));
      if (isOp(',')) at += 1;
      else if (at === before) at += 1;
    }
    if (isOp(closer)) at += 1;
    return list;
  }

  function primary(depth: number): CostNode {
    const from = at;
    if (depth > MAX_COST_DEPTH) return deep();
    const token = peek();
    if (token?.kind === 'number') {
      at += 1;
      return { kind: 'number', text: token.text, value: Number(token.text), ...span(from) };
    }
    if (token?.kind === 'name') {
      at += 1;
      if (!isOp('(')) return { kind: 'name', text: token.text, ...span(from) };
      at += 1;
      return { kind: 'call', name: token.text, args: items(')', depth), ...span(from) };
    }
    if (isOp('(') || isOp('[')) {
      const closer = isOp('(') ? ')' : ']';
      at += 1;
      const list = items(closer, depth);
      const only = list.length === 1 ? list[0] : undefined;
      return only ?? { kind: 'group', items: list, ...span(from) };
    }
    return { kind: 'empty', from: token?.at ?? 0, to: token?.at ?? 0 };
  }

  function postfix(depth: number): CostNode {
    const from = at;
    let node = primary(depth);
    while (isOp('!')) {
      at += 1;
      node = { kind: 'factorial', operand: node, ...span(from) };
    }
    return node;
  }

  function power(depth: number): CostNode {
    const from = at;
    const base = postfix(depth);
    if (!isOp('^')) return base;
    at += 1;
    return { kind: 'power', base, exponent: unary(depth + 1), ...span(from) };
  }

  function unary(depth: number): CostNode {
    const from = at;
    if (depth > MAX_COST_DEPTH) return deep();
    if (isOp('+')) {
      at += 1;
      return unary(depth + 1);
    }
    if (isOp('-')) {
      at += 1;
      return { kind: 'negate', operand: unary(depth + 1), ...span(from) };
    }
    return power(depth);
  }

  function term(depth: number): CostNode {
    const from = at;
    let left = unary(depth);
    for (;;) {
      const explicit = isOp('*') || isOp('/');
      if (!explicit && !startsOperand()) return left;
      if (explicit) at += 1;
      const before = at;
      const right = unary(depth);
      left = { kind: 'product', left, right, ...span(from) };
      // Past the depth bound `unary` declines without consuming, and a
      // juxtaposed operand would then be offered to it forever.
      if (!explicit && at === before) return left;
    }
  }

  function expression(depth: number): CostNode {
    const from = at;
    let left = term(depth);
    while (isOp('+') || isOp('-')) {
      const negative = isOp('-');
      at += 1;
      const operand = term(depth);
      const right: CostNode = negative ? { kind: 'negate', operand, ...span(from) } : operand;
      left = { kind: 'sum', left, right, ...span(from) };
    }
    return left;
  }

  function join(depth: number): CostNode {
    const from = at;
    let left = expression(depth);
    while (peek()?.kind === 'separator') {
      at += 1;
      left = { kind: 'sum', left, right: expression(depth), ...span(from) };
    }
    return left;
  }

  const parts: CostNode[] = [];
  while (at < tokens.length) {
    const before = at;
    parts.push(join(0));
    if (at === before) at += 1;
  }
  return { root: { kind: 'group', items: parts, from: 0, to: 0 }, tooDeep };
}

/**
 * The node's value when it is a small exact integer — an exponent or a
 * factorial's operand the folds need as a number — or undefined.
 */
function integerValue(node: CostNode): number | undefined {
  const safe = (value: number): number | undefined =>
    Number.isSafeInteger(value) ? value : undefined;
  switch (node.kind) {
    case 'number':
      return safe(node.value);
    case 'negate': {
      const value = integerValue(node.operand);
      return value === undefined ? undefined : -value;
    }
    case 'sum':
    case 'product': {
      const left = integerValue(node.left);
      const right = integerValue(node.right);
      if (left === undefined || right === undefined) return undefined;
      return safe(node.kind === 'sum' ? left + right : left * right);
    }
    case 'power': {
      const base = integerValue(node.base);
      const exponent = integerValue(node.exponent);
      if (base === undefined || exponent === undefined || exponent < 0) return undefined;
      return safe(base ** exponent);
    }
    default:
      return undefined;
  }
}

/** log10 of the larger of a literal's numerator and denominator. */
function literalHeight(text: string, value: number): number {
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const decimals = mantissa.split('.')[1]?.length ?? 0;
  const scale = decimals - Number(exponent);
  const magnitude = value === 0 ? 0 : Math.max(0, Math.log10(Math.abs(value)));
  return scale > 0 ? Math.max(magnitude + scale, scale) : magnitude;
}

/**
 * Whether the node names nothing — no symbol and no call — so the engine will
 * reduce it to a number.
 */
function isNumeric(node: CostNode): boolean {
  switch (node.kind) {
    case 'number':
    case 'empty':
      return true;
    case 'negate':
    case 'factorial':
      return isNumeric(node.operand);
    case 'sum':
    case 'product':
      return isNumeric(node.left) && isNumeric(node.right);
    case 'power':
      return isNumeric(node.base) && isNumeric(node.exponent);
    case 'group':
      return node.items.every(isNumeric);
    default:
      return false;
  }
}

/**
 * The HEIGHT of everything in the node, summed, and the single largest
 * contribution to name in a refusal.
 */
function problemHeight(root: CostNode): { total: number; largest?: Span; largestHeight: number } {
  let largest: Span | undefined;
  let largestHeight = 0;
  const charge = (node: CostNode, height: number): number => {
    if (height > largestHeight) {
      largestHeight = height;
      largest = node;
    }
    return height;
  };
  const factorialHeight = (node: CostNode, operand: CostNode, offset: number): number => {
    // A decimal literal is the gamma function at a float (`1.5!` answers
    // 1.32934038818), charged as the next integer up like the magnitude
    // reader charges it.
    const n = operand.kind === 'number' ? Math.ceil(operand.value) : integerValue(operand);
    if (n !== undefined && n + offset >= 0) return charge(node, factorialLog10(n + offset));
    return isNumeric(operand) ? Number.POSITIVE_INFINITY : height(operand);
  };
  const powerHeight = (node: CostNode, base: CostNode, exponent: CostNode): number => {
    const n = integerValue(exponent);
    if (n === undefined) return height(base) + height(exponent);
    return charge(node, Math.abs(n) * height(base));
  };
  function height(node: CostNode): number {
    switch (node.kind) {
      case 'number':
        return charge(node, literalHeight(node.text, node.value));
      case 'name':
      case 'empty':
        return 0;
      case 'deep':
        return Number.POSITIVE_INFINITY;
      case 'negate':
        return height(node.operand);
      case 'sum':
      case 'product':
        return height(node.left) + height(node.right);
      case 'power':
        return powerHeight(node, node.base, node.exponent);
      case 'factorial':
        return factorialHeight(node, node.operand, 0);
      case 'group':
        return node.items.reduce((sum, item) => sum + height(item), 0);
      case 'call': {
        const [first, second] = node.args;
        if (node.args.length === 1 && first !== undefined) {
          if (node.name === 'factorial') return factorialHeight(node, first, 0);
          if (node.name === 'Gamma') return factorialHeight(node, first, -1);
        }
        if (node.name === 'pow' && node.args.length === 2 && first && second) {
          return powerHeight(node, first, second);
        }
        return node.args.reduce((sum, arg) => sum + height(arg), 0);
      }
    }
  }
  const total = height(root);
  return { total, largest, largestHeight };
}

type Expansion = { terms: number; degrees: Map<string, number>; digits: number };

/** C(m + k - 1, k - 1): how many monomials a sum of k terms raised to m has at most. */
function multinomialTerms(m: number, k: number): number {
  const steps = Math.min(m, k - 1);
  if (steps > 10_000) return Number.POSITIVE_INFINITY;
  let count = 1;
  for (let i = 1; i <= steps; i += 1) count = (count * (m + k - 1 - steps + i)) / i;
  return count;
}

/**
 * The first node, innermost first, whose EXPANSION estimate exceeds
 * MAX_EXPANSION — the power to name in a refusal rather than the member that
 * contains it — or undefined.
 *
 * Each node carries an upper bound on its terms (a sum adds them, a product
 * multiplies them, a power of a k-term sum takes the multinomial count), the
 * degree of each symbol in it, and log10 of the sum of its coefficients'
 * absolute values. That norm bounds every coefficient and, unlike the largest
 * coefficient, it is exact to compose: it multiplies under a product and is
 * raised under a power, so `(x+1)^n` is charged n·log10(2) digits and nothing
 * is counted twice. The terms used are the smaller of the multiplied count
 * and the number of monomials the degrees allow — `(x+1)^99*(x+2)^99`
 * multiplies to 10,000 but has at most 199 — and the estimate is that count
 * times one more than the digits.
 *
 * A symbol, a call and a power the folds cannot read as an integer each count
 * as one opaque term: `sin(x)^5000` and `x^5000` expand to themselves, and
 * `(x+1)^(1/2)` is not expanded at all. A quotient is charged as a product,
 * which over-counts a polynomial denominator the solver may never expand.
 */
function overExpansion(
  root: CostNode,
  text: string
): { estimate: number; node: CostNode } | undefined {
  let first: { estimate: number; node: CostNode } | undefined;
  const atom = (key: string): Expansion => ({
    terms: 1,
    degrees: new Map([[key, 1]]),
    digits: 0,
  });
  const constant = (digits: number): Expansion => ({ terms: 1, degrees: new Map(), digits });
  // Every node is TIGHTENED (below); only a product or a power is CHARGED,
  // because only they create expansion — a sum is as large as its parts, which
  // the caller wrote, and a 2,998-digit condition beside a two-term equation
  // is a size for the height bound, not a power that "expands too far".
  const record = (node: CostNode, expansion: Expansion, charged = false): Expansion => {
    // A node with no symbol in it is a NUMBER, whose size is the height
    // bound's business: charging it here would word a 2,999-digit condition
    // as a power that "expands too far".
    if (expansion.degrees.size === 0) return expansion;
    let monomials = 1;
    for (const degree of expansion.degrees.values()) monomials *= degree + 1;
    // The smaller of two upper bounds is one too, and carrying it upward is
    // what keeps `(x^2+x+1)^40*y` at 81 terms rather than the multinomial 861.
    const terms = Math.min(expansion.terms, monomials);
    const raw = terms * (expansion.digits + 1);
    const estimate = Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
    if (charged && first === undefined && estimate > MAX_EXPANSION) first = { estimate, node };
    return { ...expansion, terms };
  };
  const combine = (
    a: Map<string, number>,
    b: Map<string, number>,
    merge: (x: number, y: number) => number
  ): Map<string, number> => {
    const out = new Map(a);
    for (const [key, degree] of b) out.set(key, merge(out.get(key) ?? 0, degree));
    return out;
  };
  // log10 of a sum of norms, computed from their logs without overflowing.
  const log10Sum = (logs: number[]): number => {
    const top = Math.max(0, ...logs);
    if (!Number.isFinite(top)) return top;
    return top + Math.log10(logs.reduce((total, log) => total + 10 ** (log - top), 0) || 1);
  };
  // Flattened before this, so a chain of `+` is one sum of k parts rather
  // than k-1 nested ones.
  const sumOf = (parts: Expansion[]): Expansion => ({
    terms: parts.reduce((total, part) => total + part.terms, 0),
    degrees: parts.reduce(
      (acc, part) => combine(acc, part.degrees, Math.max),
      new Map<string, number>()
    ),
    digits: log10Sum(parts.map((part) => part.digits)),
  });
  const addends = (node: CostNode): CostNode[] =>
    node.kind === 'sum' ? [...addends(node.left), ...addends(node.right)] : [node];
  const raise = (base: Expansion, m: number): Expansion => {
    if (m === 0) return constant(0);
    const terms = base.terms <= 1 ? 1 : multinomialTerms(m, base.terms);
    const degrees = new Map([...base.degrees].map(([key, degree]) => [key, degree * m]));
    return { terms, degrees, digits: m * base.digits };
  };
  // An opaque term is keyed by its text, so `sin(x)` twice is one symbol.
  const source = (node: CostNode): string => text.slice(node.from, node.to);
  function expand(node: CostNode): Expansion {
    switch (node.kind) {
      case 'number':
        return record(node, constant(literalHeight(node.text, node.value)));
      case 'name':
        return atom(node.text);
      case 'empty':
        return constant(0);
      case 'deep':
        return constant(0);
      case 'negate':
        return expand(node.operand);
      case 'sum':
        return record(node, sumOf(addends(node).map(expand)));
      case 'group':
        return record(node, sumOf(node.items.map(expand)));
      case 'product': {
        const left = expand(node.left);
        const right = expand(node.right);
        return record(
          node,
          {
            terms: left.terms * right.terms,
            degrees: combine(left.degrees, right.degrees, (x, y) => x + y),
            digits: left.digits + right.digits,
          },
          true
        );
      }
      case 'power': {
        const base = expand(node.base);
        expand(node.exponent);
        const n = integerValue(node.exponent);
        if (n === undefined) return atom(source(node));
        return record(node, raise(base, Math.abs(n)), true);
      }
      case 'factorial': {
        const n = integerValue(node.operand);
        expand(node.operand);
        return n !== undefined && n >= 0
          ? record(node, constant(factorialLog10(n)))
          : atom(source(node));
      }
      case 'call':
        for (const arg of node.args) expand(arg);
        return atom(source(node));
    }
  }
  expand(root);
  return first;
}

/**
 * Why solving this ODE problem would cost more than the engine can give it, or
 * undefined. `text` is everything the solver will see together — the equation
 * with its conditions folded in, or a system's right-hand sides and
 * conditions — and the phrase continues "cannot solve this … — it ".
 *
 * Runs after every size bound, so a problem those refuse keeps their wording,
 * and reads height before expansion for the same reason: a large literal is a
 * size, and naming it as an expansion would point the caller at the wrong fix.
 */
export function odeCostError(text: string): string | undefined {
  const normalised = unicodeToAscii(text);
  const { root, tooDeep } = parseCost(costTokens(normalised));
  if (tooDeep)
    return `is nested more than ${MAX_COST_DEPTH} deep, which this tool cannot bound — remove redundant brackets or split the expression`;
  const quoted = (span: Span | undefined): string =>
    span === undefined ? '' : ` (${excerpt(normalised.slice(span.from, span.to), 40)})`;
  const height = problemHeight(root);
  if (height.total > MAX_PROBLEM_HEIGHT) {
    const total = Number.isFinite(height.total)
      ? `${Math.ceil(height.total)} digits`
      : 'too many digits to count';
    return (
      `has numbers that come to ${total} together${quoted(height.largest)}, above the ` +
      `${MAX_PROBLEM_HEIGHT} this tool accepts across an equation and its conditions — ` +
      'the solver takes exact roots of them, and a root past about 308 digits does not ' +
      'finish; rescale the problem so its coefficients and conditions are smaller'
    );
  }
  const expansion = overExpansion(root, normalised);
  if (expansion !== undefined) {
    const estimate = Number.isFinite(expansion.estimate)
      ? `about ${Math.round(expansion.estimate).toLocaleString('en-US')}`
      : 'too many to count';
    return (
      `has a term that expands too far${quoted(expansion.node)}: its terms times their ` +
      `digits come to ${estimate}, above the ${MAX_EXPANSION.toLocaleString('en-US')} ` +
      'the CAS can solve in its time limit — lower the exponent, or substitute one ' +
      'symbol for a bracketed sum (u = x+1) so the power is of that symbol'
    );
  }
  return undefined;
}
