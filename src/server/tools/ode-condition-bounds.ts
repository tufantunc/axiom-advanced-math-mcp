import { stripEnclosingBrackets } from './compute/arg-parsing.js';
import { GIAC_NUMBER, nestingDepth } from './output-cleanup.js';
import { unicodeToAscii } from './unicode-normalize.js';

/**
 * Every bound on an initial condition — its length, its nesting depth, and the
 * size of the number it denotes — and everything else decidable about
 * condition text from the text alone.
 *
 * Split from the shape half of the same name (ode-system-shape.ts, which reads
 * the SYSTEM: members, equations, derivative targets) along the one seam that
 * matters here: the dependency runs one way. validateSystemShape charges each
 * right-hand side and each condition through implausibleMagnitude,
 * conditionBoundError and conditionsTogetherError below, while nothing in this
 * file imports a symbol from that one. A reverse import would mean the
 * extraction drew the boundary wrong — the three imports above are the same
 * leaf modules the shape half uses, so this module adds no new reach.
 *
 * The invariant is that nothing here EVALUATES anything, and it is checkable
 * rather than asserted. Three mechanisms, and the prose claims only what they
 * cover:
 *
 *   - No `async` and no `await` in this file, and no engine symbol named in it.
 *     Both are text assertions in ode-system-shape-boundary.test.ts, which
 *     reads this file and the shape half together.
 *   - No path from this file, or from any of the three leaf modules it
 *     imports, to `src/server/giac`. That is the real invariant, and only a
 *     walk of the import closure can state it — the same test does that walk,
 *     per guarded file, with this file as one entry of its own rather than
 *     something covered only while the shape half keeps importing it.
 *   - An oxlint no-restricted-imports rule in .oxlintrc.json, which is a
 *     DENYLIST of specifier texts and is therefore not the guarantee. It
 *     exists to fail fast, in the editor, on the imports someone is most
 *     likely to reach for. The count of how many modules under
 *     src/server/tools reach the CAS transitively, and how few the rule names,
 *     is kept in ode-system-shape.ts's header — one number to keep right, not
 *     two that can drift apart.
 */

/**
 * Ceiling on a single initial condition, as written by the caller.
 *
 * Its own number rather than MAX_COMMAND_CHARS in ode-system.ts, which is
 * measured for the finished command: the two bound different text
 * against different limits, and borrowing one for the other hides the
 * measurement.
 *
 * Sized from the WORST shape, not the cheapest. A flat product survives to 994
 * characters, but the same call on `y(0)=9/9/9/…` answers at 566 and traps at
 * 606, and on `y(0)=1!!!…` at 726 — so a bound justified by the product would
 * have carried a third of the headroom it claimed. 280 keeps a factor of two
 * below the worst measured, and costs nothing: a real initial condition is a
 * number and rarely passes thirty characters.
 *
 * This bound is the only thing guarding the CHAINED-factorial shape below —
 * `y(0)=1!!!…`, whose every operand after the first is another `!` and so is not
 * a literal MAX_DENOTED_DIGITS can count. That shape does not throw either:
 * `exact([y(0)=1!!!…])` RETURNS a normal-looking answer and leaves the worker
 * dead, so nothing downstream notices — `isFatalWasmTrap` is never consulted,
 * and the try/catch around the call never runs.
 */
const MAX_CONDITION_CHARS = 280;

/**
 * Ceiling on how deeply a single initial condition may nest.
 *
 * Its own number for the same reason the one above is: MAX_ENGINE_DEPTH is
 * measured for handing a RESULT back to `latex(...)`, and borrowing it here
 * would be the mistake the length bound was just corrected for. Measured on
 * `exact([y(0)=sqrt(1+…),z(0)=0])`, function nesting is refused gracefully at
 * depth 100, burns the whole per-call budget at 200, and kills the worker at
 * 400. Grouping parentheses are harmless past 600, so this refuses a little more
 * than it must — one number cannot tell the two apart, and the conservative end
 * is the one that does not take the worker down.
 */
const MAX_CONDITION_DEPTH = 100;

/**
 * Ceiling on the DIGITS the factorials in one initial condition denote, all of
 * them together.
 *
 * A third axis, because neither of the two above expresses it: `y(0)=50000!` is
 * six characters of value, nests zero deep, and kills the shared worker. It is
 * not an exponent either, so the guard below did not see it — measured on
 * ed5917e, `desolve(y'=y, y(0)=50000!, x, y)` came back "memory access out of
 * bounds" and a call queued behind it got "Giac worker exited (code 1)", and
 * `desolve([y'=z, z'=-y, y(0)=50000!, z(0)=0], x)` reached the conditions scan in
 * ode-system.ts, killed the worker there, and reported its own death as a
 * refusal while the next unrelated request came back "the CAS was unavailable".
 *
 * DIGITS, and not the argument, because the argument is only a proxy and a
 * leaky one. An earlier version of this bounded each factorial's argument at
 * 1,000 and was composable straight through: `y(0)=1000!*1000!*…` with eleven
 * factors is 70 characters, nests zero deep, holds nothing but the admitted
 * maximum, and killed the worker — inside the very channel this exists to bound.
 * The text budget buys about forty of them, so no per-argument number survives
 * that. What traps is the size of the number the condition denotes, so that is
 * what is bounded.
 *
 * One cliff, measured four independent ways on a FRESH worker, one value per
 * process, in both shapes this text reaches (`exact([y(0)=…,z(0)=0])` as
 * ode-system.ts's conditions scan sends it, and
 * `desolve((y'=y) and (y(0)=…),x,y)` as the single-equation path folds it):
 *
 *   one factorial       7500!            25,809 digits  answers
 *                       8000!            27,753 digits  kills the worker
 *   ten of the maximum  1000!*…  (×10)   25,680 digits  answers
 *                       1000!*…  (×11)   28,248 digits  kills the worker
 *   many small ones     100!*…   (×160)  25,280 digits  answers
 *                       100!*…   (×180)  28,440 digits  kills the worker
 *
 * Every construction turns over between about 25,800 and 27,800 denoted digits,
 * however the caller composes it, which is what makes this one axis rather than
 * a list of shapes.
 *
 * 3,000 keeps a factor of nine below the lowest kill, where MAX_CONDITION_CHARS
 * keeps two. The extra headroom is because this cliff MOVES: the same value
 * evaluated bare, with no command around it, still answers at 8000! (27,753
 * digits), and inside one already-warm worker it fell to 8000! in the `exact`
 * shape while the fold survived to 9000!. So it tracks the command and the
 * worker's heap state, not just the number.
 *
 * The factor of nine is PER CONDITION, which is not the same as per command:
 * both paths join their conditions into one call, so nine at the ceiling would
 * be 27,000 digits together and a factor of 1.03. That is what
 * conditionsTogetherError is for, and its docblock carries the arithmetic and
 * the measurement that the worst case reachable today still answers.
 *
 * It also costs nothing real. `1000!` is 2,568 digits and still answers, which
 * is already an order of magnitude more digits than the 280 characters the
 * condition TEXT is allowed to be; `y(0)=5!`, `y(0)=20!` and `y(0)=100!` are
 * far below it. The largest single factorial admitted is 1142!, at 2,998 digits.
 *
 * The SAME axis as powers, which is what this constant now measures. An earlier
 * version of this comment claimed the opposite — that `10^1000*…` forty times
 * "denotes 40,040 digits and answers with the worker alive", so a power's cost
 * was not its digit count. Its arithmetic was wrong (the count is 40,001, not
 * 40,040) and so was its conclusion, but the replacement written for it was a
 * per-count table of which multiples trap, and THAT DOES NOT REPRODUCE: re-run
 * one count per fresh process it disagrees with itself at four of nine points,
 * including the one the correction leaned on, and re-run in a shared process it
 * disagrees again. Whether a given multiple traps depends on what the worker has
 * already done, so no table of survivors is evidence about its neighbours — the
 * first comment's error was quoting one such survivor, and quoting a different
 * one would be the same error.
 *
 * What survives without a table is the conclusion this constant rests on: powers
 * trap in the same region factorials do, nowhere near the orders of magnitude
 * apart that a separate operator cap would imply. So the digit count is used as
 * a conservative proxy for both and denotedDigits charges them to this one
 * budget. Composing two per-operator caps is what `1000!^12` walked through.
 */
const MAX_DENOTED_DIGITS = 3_000;

/**
 * How many decimal digits n! has.
 *
 * Stirling with the 1/(12n) correction rather than a loop over k, because the
 * argument is caller text: `1000000000!` would walk a billion iterations to
 * reach a verdict this can state in closed form. Checked against the exact sum
 * of log10(k) at the sizes that decide anything — 1000! gives 2,568 both ways.
 *
 * Approximate is sound HERE specifically because it feeds a bound with a factor
 * of nine of headroom; the error is far below one digit for n ≥ 2, and this is
 * never used to report a value back to a caller as exact.
 *
 * stats-utils.ts exports `lgamma`, and `factorialLog10(n)` is `lgamma(n+1)/LN10`.
 * Stirling is kept anyway, deliberately: the closed form above is the argument
 * for why a billion-iteration argument costs nothing to bound, and importing it
 * would add a fourth module to the import closure this file's header reasons
 * about. Recorded so the next reader does not re-derive the comparison.
 */
function factorialLog10(n: number): number {
  if (n < 2) return 0;
  const ln = n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n);
  return ln / Math.LN10;
}

function factorialDigits(n: number): number {
  return n < 2 ? 1 : Math.floor(factorialLog10(n)) + 1;
}

/**
 * Every bound this tool puts on ONE initial condition, or undefined.
 *
 * Exported because TWO paths hand condition text to the engine and they had
 * nothing in common. Systems reach it through validateSystemShape in
 * ode-system-shape.ts; a single equation reaches it through extractOde in
 * compute/extractors.ts, which
 * folds `y(0)=1` into the `desolve` command and — until this existed — bounded
 * nothing at all. `desolve(y'=y, y(0)=50000!, x, y)` killed the shared worker
 * and a call queued behind it came back "Giac worker exited (code 1)".
 *
 * One function rather than one number each, because the three axes have to be
 * applied together to mean anything and this file's history is of two readers
 * that knew different rules. The phrasing is a verb phrase so both call sites'
 * prefixes ("cannot solve this system — it …", "cannot solve this equation —
 * it …") read as sentences.
 *
 * All three bounds were RE-MEASURED on the single-equation path rather than
 * assumed to carry over, in the shape it actually builds,
 * `desolve((y'=y) and (y(0)=…),x,y)`. Two of them carry their own weight there
 * and one does not:
 *
 *   - LENGTH. A flat `y(0)=1*2*2*…` answers at 1,006 characters and traps at
 *     1,406, within nine characters of the `exact([…])` figures the constant was
 *     measured from. The worst flat shape there is more forgiving here — `9/9/9/…`
 *     survives to 1,006 and traps at 1,206, where it traps at 606 in `exact` — so
 *     280 is at or below every cliff measured on either path.
 *   - MAGNITUDE. The same in both: `8000!` traps and `7500!` answers in each, so
 *     the trap is in evaluating the number rather than in the command around it.
 *   - DEPTH is the one that does NOT carry its own weight here, and saying so is
 *     the point of measuring it. This shape is far more fragile — `sqrt(1+…)` at
 *     depth 100 kills the worker outright, where `exact([…])` refuses it
 *     gracefully — but that condition is 806 characters, so MAX_CONDITION_CHARS
 *     already refuses it. Nothing reachable INSIDE 280 characters got near a
 *     cliff in the ENGINE: handed those inputs directly, 137 nested grouping
 *     parentheses (280 characters) and 45 nested `sqrt(` (276) both answer, as
 *     does `sqrt(1+…)` at depth 34 (278). Read what that says about this bound
 *     rather than about Giac: MAX_CONDITION_DEPTH is 100, so the tool REFUSES
 *     the 137-paren condition — measured, "nested 137 deep" — where the engine
 *     would have answered it. An earlier version of this paragraph cited that
 *     input as evidence the check costs nothing, which is backwards on both
 *     counts: it is not load-bearing against a trap, AND it turns away inputs
 *     the engine handles. Kept as a parity bound so the two paths cannot drift
 *     into different rules, with that cost stated rather than implied away.
 */
export function conditionBoundError(raw: string): string | undefined {
  // ONE string for all three bounds. They measured different ones for a while:
  // magnitude read the normalised text (it has to — `unicodeToAscii` runs
  // downstream at giac-eval.ts, so the guard would otherwise be reading a
  // different string from the one Giac gets), while length and depth read the
  // caller's own. Normalisation expands — `√` becomes `sqrt`, `²` becomes `^2` —
  // so `√` 270 times WAS 275 characters to the length check and 1,085 to the
  // engine, and MAX_CONDITION_CHARS' claim to sit below every measured cliff was
  // about a string that is not the one evaluated. Measured after this change,
  // the length check sees 1,085 and refuses it.
  const condition = unicodeToAscii(raw);
  // Two shapes, because they trap differently and neither bound catches the
  // other. Measured on `exact([y(0)=1*2*2*…,z(0)=0])`, a FLAT condition answers
  // at 1,015 characters and traps at 1,415, killing the worker; further up it
  // exhausts the JS stack instead, which left the worker running and corrupted
  // rather than recycled. A NESTED one traps at 2,415 characters — inside any
  // length bound that would allow the flat case — which is why depth is
  // measured separately.
  // Named when the two differ, because the number here is measured AFTER
  // normalisation and the caller counted before it: `√` 270 times is 275
  // characters typed and 1,085 evaluated, and "an initial condition of 1085
  // characters" against an input the caller can see is 275 reads as a miscount
  // with no shortening it can compute.
  const expanded = condition.length === raw.length ? '' : ' after normalising';
  if (condition.length > MAX_CONDITION_CHARS) {
    return (
      `gives an initial condition of ${condition.length} characters${expanded}, above the ` +
      `${MAX_CONDITION_CHARS} this tool accepts`
    );
  }
  const depth = nestingDepth(condition);
  if (depth > MAX_CONDITION_DEPTH) {
    return (
      `gives an initial condition nested ${depth} deep${expanded}, above ` +
      `the ${MAX_CONDITION_DEPTH} this tool accepts`
    );
  }
  const oversized = implausibleMagnitude(condition);
  if (oversized !== undefined) {
    return (
      `gives an initial condition of implausible magnitude (${oversized}) — ` +
      'initial conditions are ordinary numbers'
    );
  }
  return undefined;
}

/**
 * The magnitude bound on a group of conditions taken TOGETHER, or undefined.
 *
 * conditionBoundError is per condition, and a per-condition bound is not a
 * per-command one. Both paths join their conditions into a single command:
 * ode-system.ts's conditions scan builds `[${conditions.join(',')}]` and
 * evaluates it twice, and the single-equation path folds every condition into
 * one `desolve`. So nine conditions at the ceiling denote 9 × 3,000 = 27,000
 * digits in one call, against a lowest measured kill of 27,753 — a factor of
 * 1.03 where MAX_DENOTED_DIGITS claims nine.
 *
 * Measured, neither worst case traps today. `exact([v0(0)=1142!, …, v8(0)=1142!])`
 * at 26,982 digits answers in 129ms with the worker alive, and the
 * single-equation form with forty conditions answers because desolve
 * short-circuits before evaluating every member. This exists because the cliff
 * MOVES with the command and the worker's heap state — a 3% margin, or one that
 * holds only because of a short-circuit, is not a bound — and because one
 * function is the only way the two paths cannot drift into different rules.
 *
 * Only the magnitude axis, not length or depth: the joined text is longer and
 * deeper than any single condition by construction, so MAX_CONDITION_CHARS and
 * MAX_CONDITION_DEPTH cannot be applied to it. Length is ode-system.ts's
 * MAX_PROBE_CHARS and MAX_COMMAND_CHARS for a system, and compute/schema.ts's
 * MAX_EXPRESSION_LENGTH for the whole problem otherwise.
 *
 * Fewer than two conditions is not this function's business — one condition is
 * conditionBoundError's, and repeating that here would word the same refusal
 * twice.
 */
export function conditionsTogetherError(conditions: string[]): string | undefined {
  if (conditions.length < 2) return undefined;
  const together = implausibleMagnitude(`[${conditions.join(',')}]`);
  return together === undefined
    ? undefined
    : `gives initial conditions of implausible magnitude together (${together}) — ` +
        'initial conditions are ordinary numbers';
}

/**
 * A conservative ceiling below which an integer operand is still exact in a
 * double — 2^53 is 9.007e15, so this leaves most of an order of magnitude of
 * margin. Past it the reader stops carrying a value and keeps only log10.
 *
 * The safety does not come from the constant's size. Every arithmetic result is
 * handed back through `known()`, which re-applies this filter, so a product that
 * leaves the window is dropped rather than trusted — removing that re-filter is
 * what would break the reader, not raising this number.
 */
const MAX_READABLE_VALUE = 1e15;

/**
 * Caller text quoted back in a refusal, cut to a readable length.
 *
 * Marked, because an unmarked cut names a DIFFERENT input from the one refused:
 * `10^1000*10^1000*10^1000*10^1000` came back as `(10^1000*10^1000*10^1)`, which
 * denotes 2,002 digits and passes the bound, so a caller shortening its input to
 * what the message named would be refused again. Every refusal in this file goes
 * through here — the exponent branch did not, and returned up to 8 KB of caller
 * digits as the tool's answer on the right-hand-side channel, which has no length
 * bound in front of it.
 */
function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
}

/**
 * What a piece of condition text denotes, as a base-10 magnitude.
 *
 *   - `known` carries log10 of the absolute value, and `value` as well while it
 *     is exact. Both are needed: `^` and `!` consume the operand's VALUE, while
 *     the budget compares sizes. `3!^2` is the cheapest input that needs the
 *     value — 3! must be 6 before `^2` can be 36 — and it is an answered row in
 *     the suite.
 *   - `symbolic` is a free identifier. Giac leaves it alone, so it costs nothing
 *     real: measured, `n!`, `(n+1)!` and `2^n` all come back unevaluated in a few
 *     characters with the worker alive.
 *   - `unreadable` is a node the reader declines — an unknown call, an operand it
 *     cannot pin down. Declining never discards what was already measured beneath
 *     it, which is the property `n*1000!^12` needed.
 *
 * The two are NOT interchangeable, and that difference is the whole of why an
 * exponent may be declined safely or not. `2^n` is cheap because Giac cannot
 * evaluate `n`; `2^abs(400000)` is not, because `abs(400000)` is 400000 and Giac
 * computes the power for real. These two states were merged for one commit on
 * the grounds that nothing could tell them apart. That was true of the code as it
 * then stood and was still the wrong conclusion: what it meant was that the rule
 * needing the distinction had not been written yet. `1000!^abs(12)` is the same
 * 30,812-digit number as this suite's flagship row, and four characters
 * re-admitted it.
 */
type Magnitude =
  { kind: 'known'; log10: number; value?: number } | { kind: 'symbolic' } | { kind: 'unreadable' };

const UNREADABLE: Magnitude = { kind: 'unreadable' };
const SYMBOLIC: Magnitude = { kind: 'symbolic' };

type MagnitudeToken = {
  kind: 'number' | 'name' | 'op' | 'separator';
  text: string;
  at: number;
};

const MAGNITUDE_NUMBER = new RegExp(`^${GIAC_NUMBER}`);

/**
 * The condition's characters, as tokens. Never fails.
 *
 * A character this does not model becomes a SEPARATOR rather than aborting the
 * read, and that is load-bearing: aborting made one unmodelled character a
 * master key. `1000!^12%7` was admitted and evaluated — 152ms, having built the
 * 30,812-digit intermediate — because `%` ended the tokenizer and the whole
 * segment went unmeasured. As a separator it ends one run and starts another,
 * and the run before it is still charged.
 *
 * The numeric pattern is GIAC_NUMBER, the spelling this repo already exports,
 * rather than a second one written here. The local copy dropped the trailing
 * decimal form, so `100.!^200` read as unmodelled where `100!^200` was refused —
 * one character apart, opposite verdicts.
 */
function tokenizeMagnitude(text: string): MagnitudeToken[] {
  const tokens: MagnitudeToken[] = [];
  let at = 0;
  while (at < text.length) {
    const rest = text.slice(at);
    if (/^\s/.test(rest)) {
      at += 1;
      continue;
    }
    const number = MAGNITUDE_NUMBER.exec(rest)?.[0];
    if (number !== undefined && Number.isFinite(Number(number))) {
      tokens.push({ kind: 'number', text: number, at });
      at += number.length;
      continue;
    }
    const name = /^[A-Za-z_]\w*/.exec(rest)?.[0];
    if (name !== undefined) {
      tokens.push({ kind: 'name', text: name, at });
      at += name.length;
      continue;
    }
    const character = rest[0] ?? '';
    tokens.push({
      kind: '+-*/^!()[],'.includes(character) ? 'op' : 'separator',
      text: character,
      at,
    });
    at += 1;
  }
  return tokens;
}

/**
 * Whether a run left of an `=` is just naming the condition — `y(0)`.
 *
 * Deliberately narrow, and deliberately NOT agreeing with CONDITION_FORM in
 * ode-system-shape.ts, which accepts any `[^)]*` as the point and would call
 * `y(1000!^12)` a well-formed subject. That one validates shape; this one
 * decides cost, and it has to refuse
 * exactly that shape — Giac evaluates a condition's point as readily as its
 * value, and admitting `y(1000!^12)=1` because it sat on the left trapped the
 * shared worker. Two predicates that must not converge, like
 * SINGLE_ODE_CONDITION in extractors.ts and for the same kind of reason.
 *
 * A one-token run needs no arm here: readMagnitude declines a bare name, records
 * nothing, and denotedDigits skips a run with no magnitude.
 */
function isBareSubject(run: MagnitudeToken[]): boolean {
  if (run.length !== 4) return false;
  const [name, open, point, close] = run;
  return (
    name?.kind === 'name' && open?.text === '(' && point?.kind === 'number' && close?.text === ')'
  );
}

/**
 * The largest magnitude anything in this token run denotes, or undefined where
 * nothing in it could be read.
 *
 * What it reports is the worst NODE, never the root. Reporting the root was this
 * reader's own first escape, and it is worth stating plainly because the shape
 * recurs: the magnitudes were all computed correctly and then thrown away one
 * level up. `pairOf` and `powerOf` stop reporting a `known` size as soon as
 * one operand is, so `n*1000!^40` discarded a measured 102,705 digits, fell
 * through to the per-operator scans, and fatally trapped the shared worker. Ten
 * characters, plain ASCII, no bracket or Unicode trick. A known subterm's size
 * is a sound lower bound on the work regardless of what stands beside it: the
 * engine forms `1000!^40` before it can multiply it by n.
 *
 * Composition is not enumerated anywhere here; it falls out of precedence.
 * `2^(3)!` is 2^(3!) because `!` binds tighter than `^`, not because a clause
 * says so — which is the property the five escapes before this all lacked.
 */
function readMagnitude(tokens: MagnitudeToken[]): number | undefined {
  let at = 0;
  let worst = Number.NEGATIVE_INFINITY;

  // Charging happens HERE, in the constructor, rather than at each site that
  // calls it. It was a wrapper applied by hand at nine construction sites, which
  // compiled and typechecked just as well when someone forgot it — and failing
  // to carry a measured magnitude upward is the exact defect this reader already
  // shipped once. Measured then: dropping the wrapper at six of the nine sites
  // left the whole suite green, because the per-operator scans covered for the
  // reader. There is now no way to build a known magnitude without charging it.
  const known = (log10: number, value?: number): Magnitude => {
    const exact =
      value !== undefined && Number.isFinite(value) && Math.abs(value) < MAX_READABLE_VALUE
        ? value
        : undefined;
    worst = Math.max(worst, Number.isFinite(log10) ? Math.abs(log10) : log10);
    return { kind: 'known', log10, value: exact };
  };

  /** A magnitude read from an exact value, which is the precise case. */
  const fromValue = (value: number): Magnitude =>
    known(value === 0 ? 0 : Math.log10(Math.abs(value)), value);

  const operatorAt = (text: string): boolean =>
    tokens[at]?.kind === 'op' && tokens[at]?.text === text;

  const factorialOf = (operand: Magnitude): Magnitude => {
    // An operand Giac WILL evaluate but this cannot read is charged the whole
    // budget rather than waved through — the rule factorialOperands already
    // applies to `abs(100000)!`. A free identifier is the exception, because
    // Giac leaves `n!` alone.
    if (operand.kind === 'unreadable') return known(Number.POSITIVE_INFINITY);
    if (operand.kind !== 'known') return operand;
    if (operand.value === undefined) return known(Number.POSITIVE_INFINITY);
    if (operand.value < 0) return UNREADABLE;
    const n = Math.ceil(operand.value);
    // Carried on while it stays exact, so a factorial can be another's operand.
    // `factorial(factorial(8))` is the input that reaches this through the
    // reader; the `(8!)!` spelling never does, because factorialOperands
    // refuses it first.
    let exact: number | undefined;
    if (n <= 17) {
      exact = 1;
      for (let k = 2; k <= n; k += 1) exact *= k;
    }
    return known(factorialLog10(n), exact);
  };

  const powerOf = (base: Magnitude, exponent: Magnitude): Magnitude => {
    // A free identifier in either position is free — Giac leaves `2^n` and `n^2`
    // alone. Anything else this cannot read is charged the whole budget instead
    // of declined, because Giac evaluates it: `10^abs(100000)`,
    // `1000!^max(12,1)`, `2^floor(400000)` and `pow(abs(10),100000)` all trapped
    // the shared worker while this clause and the `^` clause declined the same
    // node and so failed together.
    //
    // The cost is stated rather than hidden: an exponent that is a call is now
    // refused even where it is small and harmless, so `2^sqrt(2)` is turned away.
    // That is the trade this file makes throughout — a refusal is visible to the
    // caller and a dead worker is not — and it is the rule the `^` clause has
    // always used for an exponent it cannot read.
    if (exponent.kind === 'unreadable' || base.kind === 'unreadable') {
      return known(Number.POSITIVE_INFINITY);
    }
    if (exponent.kind !== 'known' || base.kind !== 'known') return SYMBOLIC;
    // 1 and 0 stay themselves however they are raised, and reaching the branch
    // below with them reported "too large to count" for the digit 1.
    if (base.value === 1 || base.value === 0) return fromValue(base.value);
    // An exponent too large to hold exactly is too large to be meant, whatever
    // its sign: `10^-50000` is an exact rational with a 50,001-digit
    // denominator, which is the same work as the positive one.
    if (exponent.value === undefined) return known(Number.POSITIVE_INFINITY);
    if (base.value !== undefined && Math.abs(exponent.value) <= 64) {
      const exact = base.value ** exponent.value;
      if (Number.isFinite(exact) && Math.abs(exact) < MAX_READABLE_VALUE) {
        return fromValue(exact);
      }
    }
    return known(exponent.value * base.log10);
  };

  const pairOf = (
    left: Magnitude,
    right: Magnitude,
    exact: (a: number, b: number) => number,
    bound: (a: number, b: number) => number
  ): Magnitude => {
    // Both sides have already been recorded, so declining here costs the budget
    // nothing it had measured. Worth being exact about where the old escape
    // lived, because this is the obvious place to look and it is the wrong one:
    // this collapse is unchanged, and mutating it back leaves the suite green.
    // What erased the measurement was denotedDigits reading the ROOT of the
    // parse instead of the worst node in it.
    if (left.kind !== 'known' || right.kind !== 'known') {
      return left.kind === 'unreadable' || right.kind === 'unreadable' ? UNREADABLE : SYMBOLIC;
    }
    if (left.value !== undefined && right.value !== undefined) {
      const value = exact(left.value, right.value);
      if (Number.isFinite(value)) return fromValue(value);
    }
    return known(bound(left.log10, right.log10));
  };

  /**
   * Load-bearing, on a route callers can reach today.
   *
   * An earlier version of this comment called it unreachable, on the strength of
   * the mutation surviving the suite. That was the wrong inference — the suite
   * had no row for the route, which is not the same as the route not existing.
   * validateSystemShape hands each equation's RIGHT-HAND SIDE to
   * implausibleMagnitude with no length and no depth bound in front of it; only
   * MAX_EXPRESSION_LENGTH gates it, and the coefficient-length refusal runs
   * downstream of this, not ahead of it. Measured, `[y'=z+(((…1…))), z'=-y]` at
   * 1,500 and at 4,000 parens: with this bound, a clean refusal naming the
   * coefficient length; with it replaced by `() => true`, "Maximum call stack
   * size exceeded" out of a function contracted to return `string | undefined`.
   * A guard that can throw is not a guard.
   */
  const readDepth = (depth: number): boolean => depth <= MAX_CONDITION_DEPTH;

  // primary -> number | name | name(args) | ( expression ) | [ args ]
  const primary = (depth: number): Magnitude => {
    if (!readDepth(depth)) return UNREADABLE;
    const token = tokens[at];
    if (token === undefined) return UNREADABLE;
    if (token.kind === 'number') {
      at += 1;
      return fromValue(Number(token.text));
    }
    if (token.kind === 'name') {
      at += 1;
      if (!operatorAt('(')) return SYMBOLIC;
      at += 1;
      const args = argumentList(')', depth);
      if (args === undefined) return UNREADABLE;
      // The calls read as VALUES: the two that are pure magnitude written as
      // functions. Every other name is declined rather than called symbolic,
      // because Giac evaluates most of them — but its ARGUMENTS are charged
      // either way, which is what `abs(1000!^12)` needed. Charging arguments is
      // not enough on its own: `pow(10,100000)` costs 100,001 digits while its
      // arguments cost 2 and 6, and it trapped the worker.
      const [first, second] = args;
      if (token.text === 'factorial' && args.length === 1 && first !== undefined) {
        return factorialOf(first);
      }
      // Giac's Euler gamma, which is the factorial under a third name:
      // `Gamma(n)` is `(n-1)!`. Measured, `y(0)=Gamma(50001)` fatally trapped the
      // shared worker while `y(0)=50000!` and `y(0)=factorial(50000)` — the same
      // number — were both refused. Lowercase `gamma` stays symbolic and is
      // harmless. Listing one spelling and not its sibling is this file's
      // most-repeated defect; `fact` was checked and excluded by name, which made
      // the enumeration read as finished when it was not.
      if (token.text === 'Gamma' && args.length === 1 && first !== undefined) {
        const inner =
          first.kind === 'known' && first.value !== undefined ? fromValue(first.value - 1) : first;
        return factorialOf(inner);
      }
      if (
        token.text === 'pow' &&
        args.length === 2 &&
        first !== undefined &&
        second !== undefined
      ) {
        return powerOf(first, second);
      }
      return UNREADABLE;
    }
    if (operatorAt('(')) {
      at += 1;
      const inner = expression(depth + 1);
      if (!operatorAt(')')) return UNREADABLE;
      at += 1;
      return inner;
    }
    if (operatorAt('[')) {
      at += 1;
      const args = argumentList(']', depth);
      if (args === undefined) return UNREADABLE;
      // Giac takes `[` for grouping as well as for a list, and `10^[9]` is a
      // measured spelling. One element is that value; more is a list, which is
      // not a scalar this can report — its members are charged all the same.
      const only = args.length === 1 ? args[0] : undefined;
      return only ?? UNREADABLE;
    }
    return UNREADABLE;
  };

  function argumentList(closer: string, depth: number): Magnitude[] | undefined {
    const args: Magnitude[] = [];
    if (!operatorAt(closer)) {
      args.push(expression(depth + 1));
      while (operatorAt(',')) {
        at += 1;
        args.push(expression(depth + 1));
      }
    }
    if (!operatorAt(closer)) return undefined;
    at += 1;
    return args;
  }

  // postfix -> primary '!'*
  const postfix = (depth: number): Magnitude => {
    let value = primary(depth);
    while (operatorAt('!')) {
      at += 1;
      value = factorialOf(value);
    }
    return value;
  };

  // power -> postfix ( '^' unary )?   — right-associative through unary
  const power = (depth: number): Magnitude => {
    const before = at;
    const base = postfix(depth);
    // Whether a base was CONSUMED, measured here rather than after the exponent.
    // An unreadable operand and a MISSING one are not the same thing, and only
    // the first is evidence Giac will compute something large: `y'^2=x` is an
    // ordinary ODE whose apostrophe ends the run in front of the `^`, and
    // charging its absent base the whole budget refused it.
    const hasBase = at > before;
    if (!operatorAt('^')) return base;
    at += 1;
    const exponent = unary(depth);
    return hasBase ? powerOf(base, exponent) : UNREADABLE;
  };

  // unary -> ('+'|'-') unary | power
  function unary(depth: number): Magnitude {
    // Checked BEFORE the sign arms, not after them. Placed after, it was never
    // reached by a chain of signs at all: each arm recurses straight back into
    // this function, so the counter they increment was read only once the chain
    // ended — 8,100 signs still overflowed the stack, and the bound read exactly
    // like a live one while doing nothing.
    if (!readDepth(depth)) return UNREADABLE;
    // Charged against the SAME bound as every other production. These two arms
    // recursed at the caller's depth, so a chain of leading signs cost a frame
    // each with nothing counting them, and the bound that was supposed to make
    // this function incapable of throwing did not cover them: measured on the
    // right-hand-side route, 8,000 `-` inside MAX_EXPRESSION_LENGTH answered
    // "Maximum call stack size exceeded" where 4,000 refused cleanly.
    if (operatorAt('+')) {
      at += 1;
      return unary(depth + 1);
    }
    if (operatorAt('-')) {
      at += 1;
      const operand = unary(depth + 1);
      if (operand.kind !== 'known') return operand;
      return operand.value === undefined ? operand : fromValue(-operand.value);
    }
    if (!readDepth(depth)) return UNREADABLE;
    return power(depth);
  }

  // term -> unary ( ('*'|'/') unary )*
  const term = (depth: number): Magnitude => {
    let left = unary(depth);
    for (;;) {
      const multiply = operatorAt('*');
      if (!multiply && !operatorAt('/')) return left;
      at += 1;
      const right = unary(depth);
      left = multiply
        ? pairOf(
            left,
            right,
            (a, b) => a * b,
            (a, b) => a + b
          )
        : pairOf(
            left,
            right,
            (a, b) => (b === 0 ? Number.NaN : a / b),
            (a, b) => a - b
          );
    }
  };

  // expression -> term ( ('+'|'-') term )*
  function expression(depth: number): Magnitude {
    let left = term(depth);
    for (;;) {
      const add = operatorAt('+');
      if (!add && !operatorAt('-')) return left;
      at += 1;
      const right = term(depth);
      // Without exact values a sum is bounded, not computed: one more digit than
      // the larger side is an upper bound on a+b for any two of them.
      left = pairOf(
        left,
        right,
        (a, b) => (add ? a + b : a - b),
        (a, b) => Math.max(a, b) + Math.log10(2)
      );
    }
  }

  // Everything, not just a prefix. A run that stops early still gets charged for
  // what was read — `1000!^12 2` leaves a token over, and the 30,812 digits in
  // front of it are real either way. The `at += 1` is the loop guard, and what
  // reaches it is ordinary balanced input, not only malformed input: past
  // MAX_CONDITION_DEPTH the reader declines WITHOUT consuming, so a well-formed
  // 101-deep expression leaves 101 closers no production will take — measured,
  // it lands here 101 times. Stepping over them is what lets the parse resume at
  // a shallower point and keep the measurement the depth cut truncated. Nothing
  // in the suite tells it from `break`, which stays true.
  while (at < tokens.length) {
    const before = at;
    expression(0);
    if (at === before) at += 1;
  }
  return worst === Number.NEGATIVE_INFINITY ? undefined : worst;
}

/**
 * What the whole text denotes: a total across its parts, and the largest single
 * part to name in the refusal.
 *
 * The TOTAL, because the factorial clause has always summed and
 * conditionsTogetherError bounds the joined command on the strength of that —
 * "nine conditions at the ceiling denote 27,000 digits together". A per-segment
 * maximum makes the together bound identical to the per-condition one, so one
 * constant meant "total" on one axis and "largest" on the other; measured, nine
 * conditions denoting 26,109 digits were admitted — nine copies of
 * `10^1000*10^1000*10^900`, the input the pinning row uses — while nine
 * factorials denoting 23,112 were refused.
 *
 * Takes the stripped text and the tokens implausibleMagnitude already made:
 * one reading is the point of the merge, and re-deriving either here would
 * put the second reader back that the merge removed.
 */
function denotedDigits(
  inner: string,
  tokens: MagnitudeToken[]
): { total: number; worst: { digits: number; source: string } } | undefined {
  const runs: MagnitudeToken[][] = [[]];
  const subjects = new Set<number>();
  let depth = 0;
  for (const token of tokens) {
    if (token.kind === 'op' && '(['.includes(token.text)) depth += 1;
    else if (token.kind === 'op' && ')]'.includes(token.text)) depth -= 1;
    // `=` and `;` join conditions; a comma does too, but only outside brackets,
    // where it is not separating a call's arguments or a list's members.
    // `=` and `;` are not in the operator set above, so they arrive as
    // separators already, and they end a run at ANY depth. Only the comma is
    // depth-gated, because inside a call it separates arguments rather than
    // parts. Gating every separator was tried and reverted: it bought no verdict
    // — `max(1000!^12,q=1)` was already refused, because `record` fires on the
    // argument before argumentList declines the call — and it cost the sum
    // everywhere inside a bracket, since this is the only place per-part counts
    // are added up. Measured, `[999^1000;999^1000;999^1000]` went from refused
    // at 9,000 digits to admitted.
    const separates = token.kind === 'separator' || (depth === 0 && token.text === ',');
    if (separates) {
      // The run that ends at an `=` can be the condition's SUBJECT — `y(0)` in
      // `y(0)=1000!^12` — which is charged its one digit for the 0 and pushed a
      // single condition into the "together" wording, moving the real boundary
      // from 3,000 to 2,999.
      //
      // Only a bare subject, though. Skipping the whole run instead left the
      // evaluation POINT unmeasured, and the point is evaluated for real:
      // `y(1000!^12)=1` was admitted and fatally trapped the worker while the
      // same number on the right was refused at 30,812 digits. Dropping one
      // spurious digit does not require dropping the run that carries it.
      if (token.text === '=' && isBareSubject(runs[runs.length - 1] ?? [])) {
        subjects.add(runs.length - 1);
      }
      runs.push([]);
    } else runs[runs.length - 1]?.push(token);
  }

  let total = 0;
  let worst: { digits: number; source: string } | undefined;
  for (const [index, run] of runs.entries()) {
    if (subjects.has(index)) continue;
    const first = run[0];
    const last = run[run.length - 1];
    if (first === undefined || last === undefined) continue;
    const log10 = readMagnitude(run);
    if (log10 === undefined) continue;
    // The denominator counts as much as the numerator: `1/1000!` is an exact
    // rational with 2,568 digits under the line, which is the same work.
    const digits = Number.isFinite(log10) ? Math.floor(log10) + 1 : Number.POSITIVE_INFINITY;
    // A bare `y(0)` is not charged at all — isBareSubject takes it out, and
    // measured, the boundary is exactly 3,000 because of that. What IS charged is
    // a point that reads as a value: `y(1000!^12)` costs 30,812 digits and
    // `y(x+1)` costs one. Not `y(x)`, which an earlier version of this sentence
    // named — measured, it is charged nothing, because readMagnitude declines a
    // bare call before the subject rule is consulted at all.
    total += digits;
    // The text as measured, sliced rather than rebuilt from the tokens:
    // rebuilding `1000!^12 2` as `1000!^122` names a number nobody wrote. Note
    // "as measured", not "as typed" — this string has been through
    // unicodeToAscii and the `**` rewrite, so `1000!²²²` is named `1000!^222`.
    const source = inner.slice(first.at, last.at + last.text.length);
    if (worst === undefined || digits > worst.digits) worst = { digits, source };
  }
  return worst === undefined ? undefined : { total, worst };
}

/**
 * Describes a number in caller text too large to be meant, or undefined.
 *
 * The SIZE of caller text says nothing about the size of the number it denotes:
 * `10^100000` is nine characters, sits at 8% of MAX_COMMAND_CHARS, and fatally
 * traps the engine — recycling the shared worker and degrading whatever else was
 * in flight. `10^10000` does not trap but produces an 80,000-character result.
 *
 * Callers are deliberately not enumerated here. An earlier version named the one
 * channel it was written for, a later round read that as a statement of where
 * the hazard lives, and the right-hand sides went unguarded because of it.
 *
 * Two OPERATORS, `^` and `!`, which are the shapes measured to be dangerous — a
 * long literal is MAX_COMMAND_CHARS' job, and this had no branch for one despite
 * an earlier version of this text claiming otherwise. A parenthesised exponent
 * is caught (`10^(50000+50000)` refuses on its first operand), a symbolic one is
 * not, and this is a bound on observed shapes rather than a proof about
 * magnitude in general.
 *
 * ONE mechanism for both since the merge: the operator clauses and the reader
 * at the end share one normalisation, one enclosing-bracket strip and one
 * token list, so no operator can be one character to a clause and a different
 * one to the grammar. Away from the junctions below, differential corpora —
 * hand rows, clause-boundary grids, seeded fuzz, and adversarial review
 * sweeps an order of magnitude larger — ran identical across the merge. The
 * junctions, each found by one of those sweeps and each deliberate:
 *
 *   - An exponent bracket that never closes is read to the END of the text.
 *     The scan chopped the last character, which on the untrimmed string it
 *     read was usually trailing whitespace — but against the stripped,
 *     trimmed inner string it was a real digit: `^(1001 ` was admitted and
 *     `10^(50000 ` answered "an exponent of 5000". Truncation making an
 *     unreadable exponent look readable is the one direction a bound must
 *     never fail in. And a tail that does not read as a plain signed integer
 *     is refused outright when it carries a digit run over the ceiling: the
 *     chop used to do that to `^(1001 x` by accident, and the accident was
 *     right about the direction even though its arithmetic was luck.
 *   - `factorial(` directly after a token character now triggers, so
 *     `2factorial(1000)` is judged like the spaced `2*factorial(1000)` Giac
 *     reads it as, instead of slipping between the two spellings. The
 *     left-bound guard this replaces existed for suffix names like
 *     `myfactorial`, which a name token cannot be. Verdicts here move toward
 *     refusal only.
 *   - A `!` stranded at the head of fully-bracketed text (`[!]`) is refused
 *     by the reader's message rather than "a factorial this cannot bound
 *     ([)" — the bracket that message named is the one the strip removes.
 *   - The strip itself shows in two factorial wordings: an unbalanced
 *     `factorial(` group tail no longer includes the closing bracket the
 *     strip took, and a postfix `!` reading leftward finds one bracket layer
 *     fewer. Both sides refuse; only the quoted operand shifts.
 *
 * A NAMED function that computes a huge value is emphatically not covered, and
 * cannot be by anything shaped like this: measured, `comb(100000,50000)` returns
 * a 30,101-character answer and leaves the worker dead, and `perm(50000,25000)`
 * and `sum(k!,k,1,20000)` trap outright. That is the COST channel the conditions
 * scan already records as open, not a gap this function is close to closing.
 */
export function implausibleMagnitude(raw: string): string | undefined {
  // Normalised FIRST, because every guard here reads operators out of the text
  // and `unicodeToAscii` runs downstream of all of them — measured at
  // giac-eval.ts, after this bound has already returned. `1000!\u{2079}\u{2079}`
  // carries no `^` for implausibleMagnitude to find, and reaches Giac as
  // `1000!^99`. Length and depth are normalised too, once, in
  // conditionBoundError, and `**` is rewritten inside unicodeToAscii rather than
  // here — so all three bounds really do read one string.
  // `**` is Giac's own spelling of `^`, and unicodeToAscii rewrites it — see
  // there for why it belongs in that one seam. Nothing here modelled it: the `^`
  // scan found no `^`, and the reader read two multiplications, charging
  // `10**100000` six digits for a number with 100,001.
  const text = unicodeToAscii(raw);
  // ONE reading from here down. The operator clauses and the reader at the end
  // share this strip and this token list, so a `^` cannot be one character to
  // a clause and a different one to the grammar, and a `!` cannot end a token
  // for one of them and sit inside it for the other. They were two mechanisms
  // that each walked the text on their own — a regex scan for the `^` clauses,
  // a character scan for the factorial operands, a grammar for the magnitude —
  // and every escape this file records is a shape where two of those readings
  // disagreed about a boundary. The clause decisions are carried over —
  // wording, order, thresholds — except at the three junctions the docblock
  // names; what moved is their discovery, from each scan's own traversal to
  // the shared tokens.
  //
  // The enclosing-bracket strip is the reader's requirement, applied to the
  // clauses too: the joined form conditionsTogetherError builds is `[c1,c2,…]`,
  // and its outer bracket puts every separating comma at depth 1 where nothing
  // splits on it. What it strips encloses everything by construction, so no
  // `^`, `!` or `factorial(` can live in it — the clauses see exactly the
  // triggers the unstripped text carried.
  const inner = stripEnclosingBrackets(text.trim());
  const tokens = tokenizeMagnitude(inner);
  // Every `^`, not only the ones whose exponent is a readable literal. Reading a
  // digit run after `^` cannot bound a NESTED exponent: `10^(10^5)` captures "10"
  // and "5" and passed, and it is the same 10^100000 this guard exists to stop —
  // it crashed the shared worker in the conditions scan, where main answers
  // harmlessly. An exponent that is not a small literal is not ordinary-number
  // input either, so anything this cannot read is refused rather than passed.
  // The exponent TOKEN, not the rest of the term. `[^),\\s]+` ran past the end of
  // the exponent, so `x^2+x^3` captured "2+x^3", saw a `^` in it and refused an
  // ordinary polynomial — and the verdict flipped on a space, since `x^2 + x^3`
  // captured just "2". The bare form is a signed digit run; the bracketed form is
  // the balanced group, which is what a nested exponent hides inside.
  //
  // `[` as well as `(`, because Giac takes either and only one was recognised:
  // `10^[9]` fell to the bare branch, read an empty exponent, and was admitted.
  // The sign is read too, for the same reason — `10^+50000` read empty and was
  // admitted where `10^50000` is refused.
  //
  // `after` is tracked rather than re-derived from the exponent's length: for a
  // bracketed group the exponent text stops inside the brackets, so measuring
  // from it lands before the closing one and cannot see what follows the group.
  // That is exactly the bug the `!` clause in this loop had.
  //
  // The loop runs over the shared tokens rather than a regex over the string,
  // in token order, which is text order — the first `^` whose clause trips is
  // the same one the regex found first.
  for (const token of tokens) {
    if (token.kind !== 'op' || token.text !== '^') continue;
    let at = token.at + 1;
    while (at < inner.length && /\s/.test(inner[at])) at += 1;
    const opener = inner[at] === '(' || inner[at] === '[' ? inner[at] : undefined;
    let exponent: string;
    let after: number;
    let unclosed = false;
    if (opener === undefined) {
      const sign = /^[+-]?/.exec(inner.slice(at))?.[0] ?? '';
      const run = /^\d*/.exec(inner.slice(at + sign.length))?.[0] ?? '';
      exponent = sign + run;
      after = at + exponent.length;
    } else {
      const closer = opener === '(' ? ')' : ']';
      at += 1;
      let depth = 1;
      let i = at;
      for (; i < inner.length && depth > 0; i += 1) {
        if (inner[i] === opener) depth += 1;
        else if (inner[i] === closer) depth -= 1;
      }
      // When the group closes, the loop leaves `i` one past the closing
      // bracket, so `i - 1` IS that bracket and the slice stops just before
      // it. Unbalanced, the loop runs off the end with depth still positive
      // and the WHOLE TAIL is the exponent — the rule factorialOperands'
      // group walk states: truncation making an out-of-bounds operand look
      // in-bounds is the one direction a bound must never fail in. The scan
      // this replaces chopped the text's last character instead, which the
      // untrimmed string it read usually turned into trailing whitespace;
      // against the stripped, trimmed inner string it dropped a real digit —
      // `10^(50000 ` answered "an exponent of 5000", and `^(1001 ` was
      // admitted outright.
      if (depth === 0) {
        exponent = inner.slice(at, i - 1);
      } else {
        unclosed = true;
        exponent = inner.slice(at);
      }
      after = i;
    }
    // Signed or not, and by MAGNITUDE, because reading the sign is what made
    // this clause miss it: `/^\d+$/` does not match `+50000`, and the nested
    // check below skips anything that reads as a plain signed integer on the
    // grounds that this clause already handled it. So `10^+50000` fell between
    // the two and killed the worker with "table index is out of bounds", the
    // next caller getting "Giac worker exited (code 1)". Before the sign was
    // read at all it was admitted for a different reason — the bare read
    // returned empty — so this is the same input, refused for the first time.
    //
    // The negative side counts too: `10^-50000` is an exact rational with a
    // 50,001-digit denominator, which is the same work as the positive one.
    const signed = /^\s*([+-]?)(\d+)\s*$/.exec(exponent);
    if (signed && Number(signed[2]) > 1_000) {
      return `an exponent of ${excerpt(exponent)}`;
    }
    // What was read is the whole exponent only if nothing binds tighter after
    // it, and `!` does — measured, it binds through a bracket too: `2^(3)!` is
    // 64, not 2^3 followed by a stray operator. `10^9!` is `10^(9!)`, ten
    // characters denoting 362,881 digits, and neither bound saw it: this one
    // read the exponent as the run `9` and stopped, while the factorial bound
    // below read the operand as `9` and charged six digits. Measured, it killed
    // the worker and the next caller got "Giac worker exited (code 1)".
    //
    // Checked past `after` for EVERY form, which is the correction: gating this
    // on the bare form left `10^(9)!`, `10^((9))!`, `10^[9]!`, `10^(9) !`,
    // `10^+9!` and `3^(9)!` admitted and killing the worker through all three
    // bounded channels, while factorialArguments only ever saw a `!` written
    // INSIDE the group. `10^(8)!` is worse than a trap: it answers 40,321
    // characters and leaves the worker to fail the call after it.
    //
    // Refused rather than evaluated, which is this function's standing rule for
    // an exponent it cannot read, and the right rule here because the hazard is
    // NOT monotonic in the exponent: `10^(9!)` is 10^362880 and traps, while
    // `10^(20!)` is far larger and merely stays symbolic
    // (`exp(2432902008176640000*ln(10))`, worker alive). Admitting only what is
    // safe would mean admitting a window, so both are refused.
    //
    // The measured cost is `2^3!` — 2^6 — and `10^(20!)`, which answered before
    // this clause. An exponent written as a factorial is not ordinary-number
    // input, and these are the only shapes it takes away.
    if (/^\s*!/.test(inner.slice(after))) {
      return `an exponent this cannot bound (${excerpt(`${exponent}!`)})`;
    }
    // A NESTED exponent, which reading a digit run cannot bound: `10^(10^5)` was
    // captured as "10" and "5" and passed, and it is the same 10^100000 this
    // exists to stop. `+` and `-` count too — `10^(50000+50000)` is the example
    // an earlier version of this comment wrongly claimed was already caught.
    // `!` too, and for the same reason one step along: `10^(9!)` is 362,881
    // digits with no run over 1,000 in it.
    if (/[\^+\-!]/.test(exponent) && !/^\s*[+-]?\d+\s*$/.test(exponent)) {
      const digits = exponent.match(/\d+/g) ?? [];
      if (
        exponent.includes('^') ||
        exponent.includes('!') ||
        digits.some((d) => Number(d) > 1_000)
      ) {
        return `an exponent this cannot bound (${excerpt(exponent)})`;
      }
    }
    // The bracket never closed, so the tail is the exponent by default rather
    // than by syntax, and a tail that does not read as a plain signed integer
    // is not boundable at all once it carries a digit run over the ceiling:
    // `^(1001 x` and `^(1001]`. The scan this replaces chopped the tail's last
    // character, which turned exactly these tails into the readable `1001 `
    // and refused them by accident — the accident pointed the right way, an
    // exponent bracket that never closes is not a shape a caller means, and
    // the digits are not made smaller by the junk behind them. Tails whose
    // runs are all at or under the ceiling (`^(2`, `^(abc`) still pass here
    // as they always did.
    if (
      unclosed &&
      !/^\s*[+-]?\d+\s*$/.test(exponent) &&
      (exponent.match(/\d+/g) ?? []).some((d) => Number(d) > 1_000)
    ) {
      return `an exponent this cannot bound (${excerpt(exponent)})`;
    }
  }
  // Summed, not judged one at a time: what traps is the size of the number the
  // whole condition denotes, and eleven copies of a per-argument maximum reach
  // it just as well as one argument over that maximum.
  let digits = 0;
  let biggest = '';
  for (const argument of factorialOperands(inner, tokens)) {
    const literal = argument.trim();
    // A literal DECIMAL counts too, and is not refused for having a point in
    // it: `y(0)=1.5!` is gamma(2.5) and answers as 1.32934038818, so refusing it
    // was a cost the docblock never claimed. Rounded up, which is the direction
    // that cannot under-count.
    if (/^[\d.]+$/.test(literal) && Number.isFinite(Number(literal))) {
      digits += factorialDigits(Math.ceil(Number(literal)));
      if (biggest === '' || Number(literal) > Number(biggest)) biggest = literal;
      continue;
    }
    // A bare symbol denotes no literal and Giac does not evaluate it — measured,
    // `n!` comes back as the two characters `n!` and the worker survives — so it
    // is left alone rather than refused. Anything else is refused, because a
    // group can hide any magnitude behind digits this cannot read: `(8!)!` is
    // 40320! and kills the worker with no run longer than one digit in it, and
    // `factorial(9)!` hides the same thing behind a function name.
    if (/^[A-Za-z_]\w*$/.test(literal)) continue;
    return `a factorial this cannot bound (${excerpt(literal)})`;
  }
  if (digits > MAX_DENOTED_DIGITS) {
    // Named by its argument when there is only one, because that is what the
    // caller can act on; by the total when the size was composed, because then
    // no single factorial is the thing that is too big. factorialDigits is at
    // least 1 and monotonic, so equality here implies exactly one literal
    // operand — a symbol contributes nothing and cannot make two look like one.
    //
    // Both halves are truncated. The right-hand-side channel reaches this with
    // no length bound in front of it, where a 200-digit operand rendered the
    // count as `1.9956570551809676e+202` and a 308-digit one as `Infinity`, in a
    // 465-character message.
    if (!Number.isFinite(digits)) return 'a factorial too large to count the digits of';
    const single = biggest !== '' && digits === factorialDigits(Math.ceil(Number(biggest)));
    return single
      ? `a factorial of ${excerpt(biggest)}, which denotes a ${digits}-digit number`
      : `factorials denoting ${digits} digits together`;
  }
  // Runs after the operator clauses above, not before them. Those clauses name
  // the shape they refuse and their wording is what callers read and what about
  // sixty test rows pin — measured by rewriting all seven refusal strings and
  // counting the failures, and left approximate on purpose because an exact
  // count drifts the moment a row is added. denotedDigits sees what no single
  // clause can, because it reads the expression rather than the operators.
  // `1000!^12` is a factorial inside the factorial cap raised to an exponent
  // inside the exponent cap, and denotes 30,812 digits — the count the tool
  // itself reports, which is the one a reader can reproduce — measured, it
  // killed the worker through every route while both caps reported it fine.
  const denoted = denotedDigits(inner, tokens);
  if (denoted !== undefined && denoted.total > MAX_DENOTED_DIGITS) {
    const { digits, source } = denoted.worst;
    if (digits <= MAX_DENOTED_DIGITS) return `values denoting ${denoted.total} digits together`;
    return Number.isFinite(digits)
      ? `a value denoting ${digits} digits (${excerpt(source)})`
      : `a value too large to count the digits of (${excerpt(source)})`;
  }
  return undefined;
}

/**
 * The operand of every factorial in `inner`, as written.
 *
 * Both spellings, in one list, because they are the same operator and giving
 * them different verdicts is this file's most-repeated defect — DERIVATIVE_CALL
 * in ode-system-shape.ts exists because `diff` was listed and `derive` was not.
 * Giac's `fact` is NOT a third spelling: measured, `fact(50000)` comes back
 * unevaluated in eleven characters and the worker survives.
 *
 * TRIGGERS come from the shared token list and the operands are still sliced
 * out of the text, so what is read is what the reader's grammar also sees —
 * one notion of where each factorial sits, which is the point of the merge.
 * The named spelling is a `factorial` NAME TOKEN followed by `(`, which makes
 * the old left-bound guard structural: `myfactorial(50000)` is one name token
 * and cannot match, where the character scan it replaces had to refuse, at
 * every index, a match that was only a suffix of a longer name.
 *
 * The postfix operand is read LEFTWARD, and reading only a digit run there is
 * not enough in either direction. `(8!)!` is 40320! and traps, with no digit run
 * longer than one character — so a closing bracket is followed back to its
 * opener and then over any name in front of it, which is what stops
 * `factorial(9)!` being read as a factorial of 9. Enclosing brackets are then
 * stripped so `(1000)!` reads as the literal it is, while `(2+3)!` and
 * `factorial(9)!` stay unreadable and are refused by the caller above — the
 * conservative end, matching how that function already treats an exponent it
 * cannot read.
 *
 * ALL THREE closing brackets, because Giac maps factorial over a list and `]`
 * was neither a bracket this followed nor a token character: `y(0)=[50000]!`
 * yielded no operand at all, was charged zero digits, and killed the worker with
 * the same 213,237-digit number `y(0)=50000!` is refused for. That is why the
 * fall-through at the bottom is now enumerated rather than assumed — the comment
 * that assumed it is what hid this.
 *
 * And a whole TOKEN is read, not a digit run, because a run that stops at the
 * first non-digit is the tail of a longer token as often as it is the token:
 * `1e5!` was read as a factorial of 5, admitting a 456,574-digit number, while
 * `k2000!` was read as a factorial of 2,000 and refused a symbol this promises
 * to leave alone — `y'=z*k2000!` came back as a right-hand side of implausible
 * magnitude. `.` is a token character for the same reason (`1.0e4!`), and a
 * decimal that is a whole token is a readable literal rather than a refusal —
 * `1.5!` answers, so the caller above counts it rounded up instead of refusing
 * it. Reading the token and letting the caller classify it is also what makes
 * the two spellings agree, which they did not: `factorial(1e5)` takes the whole
 * group and was already refused.
 *
 * A `!` whose operand is another `!` is skipped, deliberately: at the largest
 * inner value MAX_DENOTED_DIGITS admits, Giac leaves the outer one
 * unapplied — measured, `1000!!` answers `(402387…)!` in 2,571 characters with
 * the worker alive. MAX_CONDITION_CHARS is what bounds a long chain of them.
 */
function factorialOperands(inner: string, tokens: MagnitudeToken[]): string[] {
  const operands: string[] = [];
  const isTokenChar = (c: string): boolean => /[A-Za-z0-9_.]/.test(c);
  const OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    if (token === undefined) continue;
    if (token.kind === 'name' && token.text === 'factorial') {
      const open = tokens[t + 1];
      if (open !== undefined && open.kind === 'op' && open.text === '(') {
        const from = open.at + 1;
        let depth = 1;
        let j = from;
        for (; j < inner.length && depth > 0; j += 1) {
          if (inner[j] === '(') depth += 1;
          else if (inner[j] === ')') depth -= 1;
        }
        // When the group closes, the loop leaves `j` one past the closing bracket,
        // so `j - 1` IS that bracket and the slice stops just before it. Unbalanced,
        // the loop instead runs off the end with depth still positive and `j - 1`
        // drops the operand's last character — `factorial(10000` was read as 1000
        // and passed, and truncation making an out-of-bounds argument look
        // in-bounds is the one direction a bound must never fail in.
        //
        // So the unbalanced case takes the whole tail. The point is only that the
        // operand is never SHORTENED; the tail is then classified like any other,
        // which means `factorial(10000` is bounded as the literal 10000 while
        // `factorial(1000]` is refused as unreadable. Either is fine — neither
        // understates the operand.
        operands.push(
          depth === 0 ? stripEnclosingBrackets(inner.slice(from, j - 1)) : inner.slice(from)
        );
        // Falls through INSIDE the group, as the character scan's `i = from - 1`
        // did: a `!` written within the argument is still a trigger.
        continue;
      }
    }
    if (token.kind !== 'op' || token.text !== '!') continue;
    let end = token.at - 1;
    while (end >= 0 && /\s/.test(inner[end])) end -= 1;
    if (end < 0) continue;
    const closer = inner[end];
    if (OPENER[closer] !== undefined) {
      const opener = OPENER[closer];
      let depth = 0;
      let start = end;
      for (; start >= 0; start -= 1) {
        if (inner[start] === closer) depth += 1;
        else if (inner[start] === opener) {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      // An unbalanced closer leaves start at -1; take the whole prefix, which is
      // unreadable as a literal and so refused rather than silently ignored.
      let from = start;
      while (from > 0 && isTokenChar(inner[from - 1])) from -= 1;
      operands.push(stripEnclosingBrackets(inner.slice(Math.max(from, 0), end + 1)));
      continue;
    }
    // One token — a literal, a symbol, or something that is neither and will be
    // refused as unreadable. Which of the three it is is the caller's rule.
    if (isTokenChar(inner[end])) {
      let start = end;
      while (start >= 0 && isTokenChar(inner[start])) start -= 1;
      operands.push(inner.slice(start + 1, end + 1));
      continue;
    }
    // A chained `!` is the one operand deliberately skipped, measured harmless
    // above. EVERYTHING else reaches the caller's unreadable branch rather than
    // vanishing: the previous version dropped it silently on the strength of a
    // comment claiming an operator was all that was left, and `]` was not.
    //
    // Defence in depth, and honestly so — every shape measured to reach here is
    // harmless (`y(0)="50000"!` answers symbolically with the worker alive; the
    // dangerous bracket forms all take the branch above). It is kept and pinned
    // because a dead branch is one a later reader deletes for free, and what it
    // guards against is the silent drop that hid the `]` case.
    if (closer !== '!') operands.push(closer);
  }
  return operands;
}
