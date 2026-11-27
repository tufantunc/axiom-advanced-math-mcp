import { excerpt } from './output-cleanup.js';
import {
  MAGNITUDE_OPERATORS,
  factorialLog10,
  foldPrimes,
  tokenizeMagnitude,
  type MagnitudeToken,
} from './ode-text-tokens.js';
import { POWERED_FUNCTIONS, unicodeToAscii } from './unicode-normalize.js';

/**
 * The COST bounds on ODE text — what solving it would cost the shared worker —
 * as opposed to the SIZE bounds in ode-condition-bounds.ts (length, depth, the
 * digits a condition denotes). Every rule about cost is here: what an initial
 * condition may CALL (conditionCallError, applied per condition through
 * conditionBoundError) and what a whole problem's numbers and powers cost
 * (odeCostError, applied to the equation and its conditions together).
 *
 * Text-only, like ode-condition-bounds.ts and ode-text-tokens.ts: no `async`,
 * no engine symbol, and no import path to `src/server/giac`.
 * ode-system-shape-boundary.test.ts checks all three for this file.
 *
 * Measured on main, one input per fresh worker, default 10s budget:
 *
 *   - CALLS. `desolve(y'=y, y(0)=ifactor(2^257-1), x, y)` burns the budget, and
 *     in a system the replacement worker then failed to start for the next
 *     caller; `nextprime(10^900)` holds the worker 11s and then answers.
 *   - HEIGHT, the size of the exact numbers. An exact root of an integer past
 *     the largest double does not finish: `sqrt(17*10^307)` answers in the
 *     single-equation fold in 20ms, `sqrt(18*10^307+1)` times out, and the step
 *     is flat on either side (a 306-digit radicand answers in 31ms). The solver
 *     takes those roots ITSELF from bare numbers, so writing no `sqrt` is no
 *     defence: `y''+(10^400+1)*y=0` (a characteristic root),
 *     `y''+(10^160+1)*y'+y=0` (a discriminant that squares the coefficient),
 *     `y'=y+1/(x^2+10^400+1)` (an `atan` integral), `y'=(10^400+1)*y^2+1` (a
 *     Riccati equation), `y'=2*sqrt(y), y(0)=10^400+1` (a constant solved from
 *     a square) and `[y'=(10^400+1)*z, z'=-y]` (eigenvalues) each burn the full
 *     budget, and every one of them was inside the 3,000-digit magnitude bound.
 *   - EXPANSION, the size of the polynomial a power of a sum expands to.
 *     `y'=(x+1)^n*y` takes 0.2s at n=50, 1.6s at 100, 6.7s at 150 and times out
 *     at 200, all in desolve itself; `y'=x^5000*y` is 25ms. The cost composes:
 *     `(x+1)^99*(x+2)^99*y` takes 6.4s, `((x+1)^14+1)^14*y` 6.4s, and
 *     `(x+a+1)^40*y` — a second symbol — times out.
 *
 * Not covered: a call in the EQUATION. `y'=y+0*ifactor(2^257-1)` still burns
 * the budget. An equation calls what it likes (`erf(x)`, `Heaviside(x-1)`,
 * `besselJ(0,x)`), so an allowlist there would refuse ordinary ODEs, and the
 * same call reaches the worker directly as `compute("ifactor(2^257-1)")` on
 * main, where nothing bounds it; that is the general compute-cost question,
 * not this channel's.
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
 * A DECIMAL is charged as written but not raised: `1.01^100` is a float to
 * Giac, which roots it in floating point, so `y'=y*1.01^100` (143ms on main)
 * and compound-interest shapes such as `(1+0.07/12)^360` are admitted.
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
 * Ceiling on the EXPANSION estimate of any product or power: terms times one
 * more than the digits, where terms bounds how many monomials it expands to and
 * digits bounds the coefficients.
 *
 * Calibrated on `y'=(x+1)^n*y`, the costliest position measured (as a forcing
 * term the same power is several times cheaper): n=50 is 819 and answers in
 * 0.2s, n=97 is 2,960 and answers in about 1.5s, n=150 is 6,969 at 6.7s and
 * n=200 is 12,302 and times out. 3,000 admits the first two — 97 is the largest
 * n admitted, 98 the smallest refused — and keeps a factor of four below the
 * lowest estimate measured to time out. The estimate over-counts some shapes —
 * `(x^2+x+1)^100*y` is 9,791 and answered in 6.9s — so those are refused
 * earlier than their time requires, which is the direction an estimate may err
 * in.
 */
const MAX_EXPANSION = 3_000;

/**
 * Ceiling on how deeply the tree may nest — brackets, signs, powers and `!`
 * alike. Above it the problem is refused rather than read: the folds recurse
 * once per level, and recursion this file cannot finish is not a bound. 100 is
 * far past any ODE a caller writes and far inside the JS stack.
 */
const MAX_COST_DEPTH = 100;

/**
 * The derivative operator's spellings: Giac's `diff` and its aliases `derive`
 * and `deriver`. ode-system-shape.ts builds DERIVATIVE_CALL from this list, so
 * the shape reader and the condition call check cannot disagree about which
 * names are the derivative.
 */
export const DERIVATIVE_NAMES = ['diff', 'derive', 'deriver'] as const;

/**
 * What an initial condition may call besides the unknowns and the derivative:
 * Giac's elementary one-argument functions (POWERED_FUNCTIONS, the list
 * unicode-normalize.ts keeps of them), the three spellings readMagnitude
 * already bounds (`factorial`, `Gamma`, `pow`), and `round`, the rounding
 * function POWERED_FUNCTIONS lacks beside `floor` and `ceil`.
 *
 * An ALLOWLIST, because what an initial condition calls is a cost the size
 * bounds cannot see: `ifactor(2^257-1)` denotes a 78-digit number and burns
 * the budget. A DENYLIST of the number-theory names would be
 * ode-condition-bounds.ts's most-repeated defect in another form: `comb`,
 * `perm`, `ithprime`, `sum`, `fib` and every name not yet thought of would
 * each have been the next escape.
 *
 * Every name here was measured cheap on a 78-digit and a 2,863-digit argument:
 * `sqrt`, `ln`, `exp`, `sin`, `atan` and the rest answer in under 30ms in both
 * `exact([y(0)=…,z(0)=0])` and the single-equation fold. What is NOT cheap is
 * an exact ROOT of a large integer — `sqrt(3^1000+2)` times out in the fold —
 * and that is a size MAX_PROBLEM_HEIGHT refuses, because the solver forms such
 * roots itself from bare numbers.
 *
 * The cost is stated: a free user function is refused too. `y(0)=g(2)` and
 * `y(0)=myfactorial(50000)` came back symbolic and cheap, and are now refused,
 * because the text cannot tell `g` from `ifactor` and a condition is a number.
 */
const CONDITION_FUNCTIONS: ReadonlySet<string> = new Set([
  ...POWERED_FUNCTIONS,
  'factorial',
  'Gamma',
  'pow',
  'round',
]);

/**
 * Whether a character is one a number can be written with: digits, names for
 * constants and functions, the tokenizer's operators, the derivative prime and
 * the `=` that joins a condition. Anything else is an operator a number does
 * not need and a cost no reader sees: Giac's `$` builds a sequence
 * (`(2^900+k)$(k=1..10000)` is ten thousand numbers and no call), `..` is a
 * range, `:=` assigns, `@` composes, and a quoted string can name a function.
 * `**` and the typeset minus `−` never reach here; unicodeToAscii rewrites
 * them to `^` and `-`.
 */
function isNumberCharacter(character: string): boolean {
  return /[\w\s.'=]/.test(character) || MAGNITUDE_OPERATORS.includes(character);
}

/**
 * Why an initial condition's CALLS are too costly to evaluate, or undefined.
 * `condition` is normalised text; the phrase continues "cannot solve this … —
 * it ".
 *
 * Its SUBJECT first: a condition constrains one of the `unknowns`, and a
 * subject that is not one is worded as such rather than as a call — main
 * folded `ifactor(2^257-1)=1` in as a condition and burned the budget on it.
 * Then every bracket, by what precedes it: an operator, a number or nothing is
 * grouping; a name is a call, admitted when it is an unknown, a derivative
 * spelling or in CONDITION_FUNCTIONS; and a closing bracket applies the group
 * it closes — `diff(y(x),x)(0)` was judged at `diff`'s own bracket, and
 * `(ifactor)(N)`, a call with no name in front of it, is judged by the names
 * inside the group.
 */
export function conditionCallError(
  condition: string,
  unknowns: readonly string[]
): string | undefined {
  const stray = [...condition].find((character) => !isNumberCharacter(character));
  const asNumber = 'give the value itself, as in y(0)=1';
  if (stray !== undefined)
    return `contains "${stray}", which a number is not written with — ${asNumber}`;
  if (condition.includes('..'))
    return `contains a range "..", which a number is not written with — ${asNumber}`;
  const admits = (name: string): boolean => {
    const bare = name.replace(/'+$/, '');
    return (
      CONDITION_FUNCTIONS.has(bare) ||
      (DERIVATIVE_NAMES as readonly string[]).includes(bare) ||
      unknowns.includes(bare)
    );
  };
  const tokens = foldPrimes(tokenizeMagnitude(condition));
  const [subject, opens] = tokens;
  if (subject?.kind === 'name' && opens?.text === '(' && !admits(subject.text)) {
    const solved = unknowns.join(' or ');
    return (
      `gives a condition on ${excerpt(subject.text, 30)}(…), but the function solved for is ` +
      `${solved} — write it as ${unknowns[0] ?? 'y'}(0)=1`
    );
  }
  const calls = (name: string): string =>
    `calls ${excerpt(name, 30)} — an initial condition is a number, so compute ` +
    `${excerpt(name, 30)}(…) on its own first and give the value it returns`;
  for (const [i, token] of tokens.entries()) {
    if (token.kind !== 'op' || (token.text !== '(' && token.text !== '[')) continue;
    const before = tokens[i - 1];
    if (before?.kind === 'name') {
      if (!admits(before.text)) return calls(before.text);
      continue;
    }
    if (before?.text !== ')' && before?.text !== ']') continue;
    const opener = before.text === ')' ? '(' : '[';
    let depth = 0;
    let at = i - 1;
    for (; at >= 0; at -= 1) {
      if (tokens[at]?.text === before.text) depth += 1;
      else if (tokens[at]?.text === opener && --depth === 0) break;
    }
    if (tokens[at - 1]?.kind === 'name') continue;
    const foreign = tokens
      .slice(Math.max(at, 0), i - 1)
      .find((t) => t.kind === 'name' && !admits(t.text));
    if (foreign !== undefined) return calls(foreign.text);
    if (opener === '[') return `applies a list as a function — ${asNumber}`;
  }
  return undefined;
}

type Span = { from: number; to: number };

type CostNode = Span &
  (
    | { kind: 'number'; text: string; value: number }
    | { kind: 'name'; text: string }
    | { kind: 'call'; name: string; args: CostNode[] }
    | { kind: 'negate' | 'reciprocal' | 'factorial'; operand: CostNode }
    | { kind: 'sum' | 'product'; items: CostNode[] }
    | { kind: 'power'; base: CostNode; exponent: CostNode }
    | { kind: 'empty' }
  );

/**
 * The tree. It reads the same tokens as readMagnitude in
 * ode-condition-bounds.ts with the same binding for `!` (tightest), `^`
 * (right-associative) and signs, and differs where its job differs:
 * juxtaposition (`2x`, `(x+1)(x+2)`) multiplies, where readMagnitude stops
 * reading; an unclosed bracket is read to the end rather than declined; and
 * every separator — `=`, `;`, a stray `)` — joins its sides as a sum.
 * Each of those is the conservative reading for a fold that charges cost.
 *
 * Sums and products are n-ary, so a flat chain of 8,000 terms is one level
 * rather than 8,000, and every level of nesting — brackets, signs, powers and
 * `!` — counts against MAX_COST_DEPTH, past which the read stops and the
 * problem is refused. Never throws, and always consumes the input.
 */
function parseCost(tokens: MagnitudeToken[]): { root: CostNode; tooDeep: boolean } {
  let at = 0;
  let tooDeep = false;
  const empty = (): CostNode => ({ kind: 'empty', from: 0, to: 0 });
  const deep = (): CostNode => {
    tooDeep = true;
    return empty();
  };
  const peek = (): MagnitudeToken | undefined => tokens[at];
  const isOp = (text: string): boolean => peek()?.kind === 'op' && peek()?.text === text;
  const span = (from: number): Span => ({
    from: tokens[from]?.at ?? 0,
    to: (tokens[at - 1]?.at ?? 0) + (tokens[at - 1]?.text.length ?? 0),
  });
  const startsOperand = (): boolean => {
    const token = peek();
    return token?.kind === 'number' || token?.kind === 'name' || isOp('(') || isOp('[');
  };
  const many = (kind: 'sum' | 'product', items: CostNode[], from: number): CostNode =>
    items.length === 1 && items[0] ? items[0] : { kind, items, ...span(from) };

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
      return many('sum', items(closer, depth), from);
    }
    return empty();
  }

  function postfix(depth: number): CostNode {
    const from = at;
    let node = primary(depth);
    let level = depth;
    while (isOp('!')) {
      at += 1;
      level += 1;
      if (level > MAX_COST_DEPTH) return deep();
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
    const factors = [unary(depth)];
    for (;;) {
      const divide = isOp('/');
      const explicit = divide || isOp('*');
      if (!explicit && !startsOperand()) break;
      if (explicit) at += 1;
      const before = at;
      const from2 = at;
      const operand = unary(depth);
      factors.push(divide ? { kind: 'reciprocal', operand, ...span(from2) } : operand);
      // Past the depth bound `unary` declines without consuming, and a
      // juxtaposed operand would then be offered to it forever.
      if (!explicit && at === before) break;
    }
    return many('product', factors, from);
  }

  function expression(depth: number): CostNode {
    const from = at;
    const terms = [term(depth)];
    while (isOp('+') || isOp('-')) {
      const negative = isOp('-');
      at += 1;
      const from2 = at;
      const operand = term(depth);
      terms.push(negative ? { kind: 'negate', operand, ...span(from2) } : operand);
    }
    return many('sum', terms, from);
  }

  function join(depth: number): CostNode {
    const from = at;
    const parts = [expression(depth)];
    while (peek()?.kind === 'separator') {
      at += 1;
      parts.push(expression(depth));
    }
    return many('sum', parts, from);
  }

  const parts: CostNode[] = [];
  while (at < tokens.length) {
    const before = at;
    parts.push(join(0));
    if (at === before) at += 1;
  }
  return { root: { kind: 'sum', items: parts, from: 0, to: 0 }, tooDeep };
}

/** Giac's functions a constant exponent or factorial operand is written with. */
const CONSTANT_CALLS: Readonly<Record<string, (...args: number[]) => number>> = {
  abs: Math.abs,
  sqrt: Math.sqrt,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  factorial: (n) => factorialValue(n),
  Gamma: (n) => factorialValue(n - 1),
};

function factorialValue(n: number): number {
  if (!Number.isInteger(n) || n < 0) return Number.NaN;
  if (n > 170) return Number.POSITIVE_INFINITY;
  let product = 1;
  for (let k = 2; k <= n; k += 1) product *= k;
  return product;
}

/**
 * The node's value as a double when it names no symbol, or undefined: an
 * unknown call, a free name, or a value that is not a number. Approximate on
 * purpose — it decides only whether an exponent is an integer and how large,
 * which Giac also decides from the value: `(x+1)^abs(200)`, `(x+1)^(5!*2)` and
 * `pow(x+1,200)` each expanded and timed out on this branch's first version,
 * which read only literal exponents.
 */
function constantValue(node: CostNode): number | undefined {
  const all = (nodes: CostNode[]): number[] | undefined => {
    const values: number[] = [];
    for (const item of nodes) {
      const value = constantValue(item);
      if (value === undefined) return undefined;
      values.push(value);
    }
    return values;
  };
  switch (node.kind) {
    case 'number':
      return node.value;
    case 'negate':
    case 'reciprocal':
    case 'factorial': {
      const value = constantValue(node.operand);
      if (value === undefined) return undefined;
      if (node.kind === 'negate') return -value;
      return node.kind === 'reciprocal' ? 1 / value : factorialValue(value);
    }
    case 'sum':
    case 'product': {
      const values = all(node.items);
      if (values === undefined) return undefined;
      return node.kind === 'sum'
        ? values.reduce((total, value) => total + value, 0)
        : values.reduce((total, value) => total * value, 1);
    }
    case 'power': {
      const [base, exponent] = all([node.base, node.exponent]) ?? [];
      return base === undefined || exponent === undefined ? undefined : base ** exponent;
    }
    case 'call': {
      const fn = CONSTANT_CALLS[node.name];
      const values = all(node.args);
      if (fn === undefined || values === undefined) return undefined;
      const value = fn(...values);
      return Number.isNaN(value) ? undefined : value;
    }
    default:
      return undefined;
  }
}

/** Whether the node names no free symbol, so Giac reduces it to a value. */
function isConstant(node: CostNode): boolean {
  switch (node.kind) {
    case 'number':
    case 'empty':
      return true;
    case 'name':
      return false;
    case 'negate':
    case 'reciprocal':
    case 'factorial':
      return isConstant(node.operand);
    case 'sum':
    case 'product':
      return node.items.every(isConstant);
    case 'power':
      return isConstant(node.base) && isConstant(node.exponent);
    case 'call':
      return node.args.every(isConstant);
  }
}

/**
 * What an exponent is to the folds: an integer they can raise by (possibly
 * infinite, past a double), a fraction or a symbol that leaves the power
 * unexpanded, or a constant they cannot evaluate — `2^foo(3)` — which is
 * charged as if it were unbounded.
 */
type Exponent = { kind: 'integer'; n: number } | { kind: 'unexpanded' } | { kind: 'unreadable' };

function readExponent(node: CostNode): Exponent {
  if (node.kind === 'empty' || !isConstant(node)) return { kind: 'unexpanded' };
  const value = constantValue(node);
  if (value === undefined) return { kind: 'unreadable' };
  if (!Number.isFinite(value)) return { kind: 'integer', n: Number.POSITIVE_INFINITY };
  return Number.isInteger(value) ? { kind: 'integer', n: Math.abs(value) } : { kind: 'unexpanded' };
}

/** Whether the node holds a decimal literal, which makes Giac compute in floats. */
function hasDecimal(node: CostNode): boolean {
  switch (node.kind) {
    case 'number':
      return !/^0[xXbB]/.test(node.text) && /[.eE]/.test(node.text);
    case 'negate':
    case 'reciprocal':
    case 'factorial':
      return hasDecimal(node.operand);
    case 'sum':
    case 'product':
      return node.items.some(hasDecimal);
    case 'power':
      return hasDecimal(node.base) || hasDecimal(node.exponent);
    case 'call':
      return node.args.some(hasDecimal);
    default:
      return false;
  }
}

/** log10 of the larger of a literal's numerator and denominator. */
function literalHeight(text: string, value: number): number {
  // A radix literal by its digits, which stay countable past a double.
  if (/^0[xX]/.test(text)) return (text.length - 2) * Math.log10(16);
  if (/^0[bB]/.test(text)) return (text.length - 2) * Math.log10(2);
  const magnitude = value === 0 ? 0 : Math.max(0, Math.log10(Math.abs(value)));
  const [mantissa = '', exponent = '0'] = text.toLowerCase().split('e');
  const decimals = mantissa.split('.')[1]?.length ?? 0;
  const scale = decimals - Number(exponent);
  return scale > 0 ? Math.max(magnitude + scale, scale) : magnitude;
}

/**
 * The HEIGHT of everything in the tree, summed, and the single largest
 * contribution to name in a refusal.
 */
function problemHeight(root: CostNode): { total: number; largest?: Span } {
  let largest: Span | undefined;
  let largestHeight = 0;
  const charge = (node: CostNode, height: number): number => {
    if (height > largestHeight) {
      largestHeight = height;
      largest = node;
    }
    return height;
  };
  const scaled = (n: number, height: number): number => (height === 0 ? 0 : n * height);
  const powerHeight = (node: CostNode, base: CostNode, exponent: CostNode): number => {
    const read = readExponent(exponent);
    const baseHeight = height(base);
    if (read.kind === 'unexpanded') return baseHeight + height(exponent);
    if (read.kind === 'unreadable') {
      return baseHeight === 0 ? height(exponent) : charge(node, Number.POSITIVE_INFINITY);
    }
    // A decimal base is a float to Giac: charged as written, not raised.
    if (isConstant(base) && hasDecimal(base)) return baseHeight;
    return charge(node, scaled(read.n, baseHeight));
  };
  const factorialHeight = (node: CostNode, operand: CostNode, offset: number): number => {
    const value = constantValue(operand);
    if (value !== undefined && Number.isFinite(value) && value + offset >= 0) {
      return charge(node, factorialLog10(Math.ceil(value) + offset));
    }
    return isConstant(operand) ? charge(node, Number.POSITIVE_INFINITY) : height(operand);
  };
  function height(node: CostNode): number {
    switch (node.kind) {
      case 'number':
        return charge(node, literalHeight(node.text, node.value));
      case 'name':
      case 'empty':
        return 0;
      case 'negate':
      case 'reciprocal':
        return height(node.operand);
      case 'sum':
      case 'product':
        return node.items.reduce((total, item) => total + height(item), 0);
      case 'power':
        return powerHeight(node, node.base, node.exponent);
      case 'factorial':
        return factorialHeight(node, node.operand, 0);
      case 'call': {
        const [first, second] = node.args;
        if (node.args.length === 1 && first !== undefined) {
          if (node.name === 'factorial') return factorialHeight(node, first, 0);
          if (node.name === 'Gamma') return factorialHeight(node, first, -1);
        }
        if (node.name === 'pow' && node.args.length === 2 && first && second) {
          return powerHeight(node, first, second);
        }
        return node.args.reduce((total, arg) => total + height(arg), 0);
      }
    }
  }
  const total = height(root);
  return { total, largest };
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
 * The first product or power, innermost first, whose EXPANSION estimate
 * exceeds MAX_EXPANSION — the power to name in a refusal rather than the member
 * that contains it — or undefined.
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
 * A symbol, a call and a power whose exponent is a fraction or a symbol each
 * count as one opaque term: `sin(x)^5000` and `x^5000` expand to themselves,
 * and `(x+1)^(1/2)` is not expanded at all. A power whose exponent is a
 * constant this cannot evaluate is charged as unbounded once its base is a
 * sum. A quotient is charged as a product, which over-counts a polynomial
 * denominator the solver may never expand.
 *
 * Linear in the tree: every degree map is owned by the node that made it, so
 * a product or a sum merges into its first part's map in place, where copying
 * per node made an 8 KB sum of distinct symbols quadratic (250ms).
 */
function overExpansion(
  root: CostNode,
  text: string
): { estimate: number; node: CostNode } | undefined {
  let first: { estimate: number; node: CostNode } | undefined;
  const atom = (key: string): Expansion => ({ terms: 1, degrees: new Map([[key, 1]]), digits: 0 });
  const constant = (digits: number): Expansion => ({ terms: 1, degrees: new Map(), digits });
  // Every node is TIGHTENED; only a product or a power is CHARGED, because
  // only they create expansion — a sum is as large as its parts, which the
  // caller wrote.
  const record = (node: CostNode, expansion: Expansion, charged: boolean): Expansion => {
    if (expansion.degrees.size === 0) return expansion;
    let monomials = 1;
    for (const degree of expansion.degrees.values()) {
      monomials *= degree + 1;
      if (monomials >= expansion.terms) break;
    }
    const terms = Math.min(expansion.terms, monomials);
    const raw = terms * (expansion.digits + 1);
    const estimate = Number.isNaN(raw) ? Number.POSITIVE_INFINITY : raw;
    if (charged && first === undefined && estimate > MAX_EXPANSION) first = { estimate, node };
    expansion.terms = terms;
    return expansion;
  };
  const merge = (
    into: Map<string, number>,
    from: Map<string, number>,
    pick: (x: number, y: number) => number
  ): void => {
    for (const [key, degree] of from) into.set(key, pick(into.get(key) ?? 0, degree));
  };
  // log10 of a sum of norms, computed from their logs without overflowing.
  const log10Sum = (logs: number[]): number => {
    const top = Math.max(0, ...logs);
    if (!Number.isFinite(top)) return top;
    return top + Math.log10(logs.reduce((total, log) => total + 10 ** (log - top), 0) || 1);
  };
  const raise = (base: Expansion, m: number): Expansion => {
    if (m === 0) return constant(0);
    const terms = base.terms <= 1 ? 1 : multinomialTerms(m, base.terms);
    for (const [key, degree] of base.degrees) base.degrees.set(key, degree * m);
    return { terms, degrees: base.degrees, digits: base.digits === 0 ? 0 : m * base.digits };
  };
  const power = (node: CostNode, baseNode: CostNode, exponentNode: CostNode): Expansion => {
    const base = expand(baseNode);
    expand(exponentNode);
    const read = readExponent(exponentNode);
    if (read.kind === 'unexpanded') return atom(text.slice(node.from, node.to));
    if (read.kind === 'unreadable') {
      if (base.terms <= 1) return atom(text.slice(node.from, node.to));
      const unbounded = Number.POSITIVE_INFINITY;
      return record(node, { terms: unbounded, degrees: base.degrees, digits: unbounded }, true);
    }
    // A decimal base is a float to Giac, as in problemHeight: not raised.
    if (isConstant(baseNode) && hasDecimal(baseNode)) return base;
    return record(node, raise(base, read.n), true);
  };
  function expand(node: CostNode): Expansion {
    switch (node.kind) {
      case 'number':
        return constant(literalHeight(node.text, node.value));
      case 'name':
        return atom(node.text);
      case 'empty':
        return constant(0);
      case 'negate':
      case 'reciprocal':
        return expand(node.operand);
      case 'sum': {
        const parts = node.items.map(expand);
        const degrees = new Map<string, number>();
        for (const part of parts) merge(degrees, part.degrees, Math.max);
        return record(
          node,
          {
            terms: parts.reduce((total, part) => total + part.terms, 0),
            degrees,
            digits: log10Sum(parts.map((part) => part.digits)),
          },
          false
        );
      }
      case 'product': {
        const product: Expansion = { terms: 1, degrees: new Map(), digits: 0 };
        for (const item of node.items) {
          const part = expand(item);
          product.terms *= part.terms;
          product.digits += part.digits;
          merge(product.degrees, part.degrees, (x, y) => x + y);
        }
        return record(node, product, true);
      }
      case 'power':
        return power(node, node.base, node.exponent);
      case 'factorial': {
        const value = constantValue(node.operand);
        expand(node.operand);
        return value !== undefined && Number.isFinite(value) && value >= 0
          ? constant(factorialLog10(Math.ceil(value)))
          : atom(text.slice(node.from, node.to));
      }
      case 'call': {
        const [base, exponent] = node.args;
        if (node.name === 'pow' && node.args.length === 2 && base && exponent) {
          return power(node, base, exponent);
        }
        for (const arg of node.args) expand(arg);
        // An opaque term is keyed by its text, so `sin(x)` twice is one symbol.
        return atom(text.slice(node.from, node.to));
      }
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
 * Callers run it after every size bound, so a problem those refuse keeps their
 * wording, and it reads height before expansion for the same reason: a large
 * literal is a size, and naming it as an expansion would point the caller at
 * the wrong fix.
 */
export function odeCostError(text: string): string | undefined {
  const normalised = unicodeToAscii(text);
  const { root, tooDeep } = parseCost(foldPrimes(tokenizeMagnitude(normalised)));
  if (tooDeep) {
    return (
      `is nested more than ${MAX_COST_DEPTH} deep, which this tool cannot bound — ` +
      'remove redundant brackets or split the expression'
    );
  }
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
