/**
 * Regenerates src/server/tools/giac-reserved-names.ts: every name the bundled
 * Giac reads as something other than a plain symbol — a built-in command, a
 * constant, a keyword of its programming syntax.
 *
 *   npm run build && node scripts/generate-giac-reserved-names.mjs
 *
 * Run it whenever src/server/giac/giac.wasm.js changes: the generated file
 * records the SHA-256 of the engine it was read from, and
 * test/giac-reserved-names.test.ts fails until the two agree. With `--check`
 * it writes nothing and exits 1 if the file is not what it would write, which
 * test/giac-reserved-names-current.test.ts runs against the built engine.
 *
 * CANDIDATES are every identifier-shaped run of bytes in the WASM binary and
 * every tail of one — the engine's function table, its lexer table and its
 * help text all hold their names as strings, some of them merged into the
 * tail of a longer one — plus the keywords its flex lexer matches as patterns,
 * which leave no string behind (FLEX_KEYWORDS below). Junk costs nothing: the
 * engine, not this script, decides what each candidate is.
 *
 * A candidate is FREE — a symbol the caller may use as a parameter or a
 * function of their own — when the engine reads it as one in every position
 * an equation puts it: `type(N)` is `identifier`, `2*N+1` is an expression
 * whose only name is N, and `N(u)` is one whose only names are N and u.
 * Everything else is RESERVED:
 * `type(ifactor)` is `func`, `type(while)` does not parse, `2*od+1` collapses
 * to undef, and `pop(u)` is an error.
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const enginePath = join(root, 'src', 'server', 'giac', 'giac.wasm.js');
const outPath = join(root, 'src', 'server', 'tools', 'giac-reserved-names.ts');

/**
 * The quoted literal rules of geogebra/giac's src/giac/flex/input_lexer.ll
 * (master, read 2026-11-27). A flex rule compiles into the lexer's state
 * tables, so `while`, `do` and `repeat` appear nowhere in the binary as text.
 */
const FLEX_KEYWORDS = `
AND Ans BREAK CASE CONT Col Cycle D DEBUG DELTALIST DIGITS DO Dialog Digits Disp
DropDown ERROR Exit FOR For Goto HALT HAngle HComplex HDigits HFormat HLanguage
I IF IFTE If KILL Lbl Loop NOT OR PI PILIST PURGE Pause Pi Popup REPEAT RETURN
Request Return Row SIGMA SIGMALIST SST SST_IN Text Title VARS WHILE While XOR _
_Faraday_ _G_ _IO_ _NA_ _PSun_ _REarth_ _RSun_ _R_ _Rinfinity_ _StdP_ _StdT_
_Vm_ _a0_ _alpha_ _and _assign _c3_ _c_ _divide _epsilon0_ _epsilon0q_
_epsilonox_ _epsilonsi_ _equal _f0_ _fconcat _fnest _g_ _h_ _hbar_ _if
_intersect _k_ _kq_ _lambda0_ _lambdac_ _leequal _less _mEarth_ _mSun_ _me_
_minus _mod _mp_ _mpme_ _mu0_ _muB_ _muN_ _mult _not _or _phi_ _plus _power _qe_
_qepsilon0_ _qme_ _range _sd_ _seqgen _sigma_ _subtract _syr_ _unequal _union
_xor all_trig_solutions angle_radian approx_mode arccos arccosh arcsin arcsinh
arctan arctanh at augmente_de backquote bloc complex_mode complex_variables
derive diminue_de do e epsilon equal erase error est_divise_par
est_eleve_puissance est_multiplie_par euler_gamma expand export fdistrib feuille
for i if ifactors ifte increasing_power inf infinity interval keep_algext lim
list log minus_inf mod neg normalf not ntl_on oo op operator option pcoef pi
plotfunc2d plus_inf pow proba_epsilon purge randnorm randseed repeat repeter
retourne return root same scientific_format step_infolevel subs subsop threads
trier unassign undef unsigned_inf user_operator virgule while xor
`;

function wasmBytes(source) {
  const match = /data:application\/wasm;base64,([A-Za-z0-9+/=]+)/.exec(source);
  if (!match) throw new Error(`no embedded WASM binary in ${enginePath}`);
  return Buffer.from(match[1], 'base64');
}

function candidates(bytes) {
  const names = new Set(FLEX_KEYWORDS.split(/\s+/).filter(Boolean));
  const isNameByte = (c) =>
    (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
  let start = -1;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i < bytes.length && isNameByte(bytes[i])) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      // Every TAIL of the run too: the linker stores a string literal that
      // ends another as that string's tail, so `CATCH` and `_plus` have no
      // bytes of their own — they are the last bytes of a longer name.
      const run = bytes.subarray(start, i).toString('latin1');
      for (let from = Math.max(0, run.length - 40); from < run.length; from += 1) {
        const tail = run.slice(from);
        if (/^[A-Za-z_]/.test(tail)) names.add(tail);
      }
    }
    start = -1;
  }
  return [...names].sort();
}

const check = process.argv.includes('--check');
const source = readFileSync(enginePath, 'utf8');
const sha256 = createHash('sha256').update(source).digest('hex');
const names = candidates(wasmBytes(source));
console.error(`classifying ${names.length} candidate names…`);

const { giacEngine } = await import(join(root, 'dist', 'server', 'giac', 'index.js'));
await giacEngine.initialize();
const evaluate = async (expression) => {
  try {
    return String(await giacEngine.evaluate(expression)).replace(/\s+/g, ' ');
  } catch {
    return 'THROW';
  }
};

/** Whether the engine reads `name` as a plain symbol everywhere an equation can put it. */
async function isFree(name) {
  if ((await evaluate(`type(${name})`)) !== 'identifier') return false;
  if ((await evaluate(`[type(2*${name}+1),lname(2*${name}+1)]`)) !== `[expression,[${name}]]`) {
    return false;
  }
  // A symbol, not a number, as the argument: the CAS applies `x` and `t` as
  // the identity to a number (`x(2)` is 2), and both must stay free.
  const arg = name === 'u' ? 'v' : 'u';
  const applied = `${name}(${arg})`;
  return (await evaluate(`[type(${applied}),lname(${applied})]`)) === `[expression,[${name},${arg}]]`;
}

const reserved = [];
for (const name of names) {
  if (!(await isFree(name))) reserved.push(name);
  // Evaluating a name can run it: a bare `restart` is a command. Reset so no
  // name's classification depends on the one before it.
  await giacEngine.reset();
}

const lines = [];
let line = '';
for (const name of reserved) {
  if (line.length + name.length + 1 > 96) {
    lines.push(line);
    line = '';
  }
  line = line ? `${line} ${name}` : name;
}
if (line) lines.push(line);

const generated = await prettier.format(
  `/**
 * GENERATED by scripts/generate-giac-reserved-names.mjs from the engine in
 * src/server/giac/giac.wasm.js — do not edit by hand; rerun the script.
 *
 * Every name that engine reads as something other than a plain symbol: a
 * built-in command, a constant, or a keyword of its programming syntax. A name
 * not listed here is free — the caller's own parameter or function. The
 * script's docblock says how each name was classified.
 *
 * Text-only and import-free: ode-cost-bounds.ts reads it before any engine call.
 */

/** SHA-256 of the giac.wasm.js these names were read from. */
export const GIAC_ENGINE_SHA256 = '${sha256}';

const NAMES = \`
${lines.join('\n')}
\`;

export const GIAC_RESERVED_NAMES: ReadonlySet<string> = new Set(NAMES.split(/\\s+/).filter(Boolean));
`,
  { ...(await prettier.resolveConfig(outPath)), filepath: outPath }
);

if (check) {
  const current = readFileSync(outPath, 'utf8');
  if (current !== generated) {
    console.error(`${outPath} is stale: rerun node scripts/generate-giac-reserved-names.mjs`);
    process.exit(1);
  }
  console.error(`${outPath} is current: ${reserved.length} reserved of ${names.length}`);
  process.exit(0);
}
writeFileSync(outPath, generated);
console.error(`${reserved.length} reserved of ${names.length}; wrote ${outPath}`);
process.exit(0);
