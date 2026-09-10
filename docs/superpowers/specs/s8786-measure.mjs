// S8786 ölçüm arabası — her deseni 8192 karakterlik düşman girdiye karşı ölçer
const CAP = 8192;
const t = (name, re, input, transform) => {
  const start = process.hrtime.bigint();
  if (transform) transform(input); else re.test(input);
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${ms > 999 ? '!!!' : ms > 100 ? ' ! ' : '   '} ${String(ms).padStart(9)} ms  ${name}`);
};

const P = {
  'arg-parsing:89 name=value': /^\s*([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]+)$/,
  'extractors:55 matrix': /(\[\s*\[[\s\S]*\]\s*\])/,
  'extractors:262 ode-cond': /^[A-Za-z_]\w*'*\s*\(\s*[^),]*\s*\)\s*=\s*(.+)$/,
  'exact-arith:57 degree': /(\d+(?:\.\d*)?)\s*°/g,
  'optimization:139 solshape': /^\s*(list)?\s*[[(]/,
  'ode-shape:92 condform': /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)\s*=\s*(.+)$/,
  'preproc:22 choose': /(\d+)\s+choose\s+(\d+)/gi,
  'verify:320 satisfies': /(\w+)\s*=\s*([^,\s]+)\s+(?:satisfies|is\s+(?:a\s+)?solution\s+(?:of|to))\s+(.+)/i,
  'verify:331 at-pattern': /^(.+?)\s+at\s+([a-z]\w*)\s*=\s*([^=\s,]+)\s*=\s*(.+)$/i,
};

// Düşman girdiler (her desen için en kötü şekil)
t('arg-parsing  aaaa…=x', P['arg-parsing:89 name=value'], 'a'.repeat(CAP - 2) + '=x');
t('arg-parsing  aaa aaa…=x(spaces)', P['arg-parsing:89 name=value'], 'a '.repeat(CAP / 2) + ' b=x');
t('extractors:55 [[x…](1 close)', P['extractors:55 matrix'], '[[' + 'x'.repeat(CAP - 3) + ']');
t('extractors:55 [[ [ [ …', P['extractors:55 matrix'], '['.repeat(CAP));
t('extractors:55 [[x…]x (tail junk)', P['extractors:55 matrix'], '[[' + 'x'.repeat(CAP - 4) + ']x]');
t('extractors:262 f(xxxx…(noclose', P['extractors:262 ode-cond'], 'f(' + 'x'.repeat(CAP - 2));
t('extractors:262 f(x xx xx…)', P['extractors:262 ode-cond'], 'f(' + 'x '.repeat(CAP / 2) + ')');
t('exact-arith 9…x°', null, null, (s) => {}, );
{ const re = P['exact-arith:57 degree']; const inp = '9'.repeat(CAP - 2) + 'x°';
  const s0 = process.hrtime.bigint(); inp.replaceAll(re, 'Z'); const ms = Number(process.hrtime.bigint() - s0) / 1e6;
  console.log(`${ms > 999 ? '!!!' : ms > 100 ? ' ! ' : '   '} ${String(ms).padStart(9)} ms  exact-arith:57 9…x°`); }
t('optimization nonlist-garbage', P['optimization:139 solshape'], ' '.repeat(CAP - 1) + 'x');
t('ode-shape:92 f(xxx…(noclose', P['ode-shape:92 condform'], 'f(' + 'x'.repeat(CAP - 2));
t('preproc 9… choose 9', P['preproc:22 choose'], '9'.repeat(CAP - 10) + ' choose 9');
t('verify:320 x=1 is a a a…', P['verify:320 satisfies'], 'x=1 ' + 'is a '.repeat(CAP / 5));
t('verify:320 x=1 satis…alt', P['verify:320 satisfies'], 'x=1 satisfies' + ' '.repeat(CAP - 13));
t('verify:331 a at a at…(many at)', P['verify:331 at-pattern'], ('a at ').repeat(CAP / 5));
t('verify:331 aaaa… at x=1=1', P['verify:331 at-pattern'], 'a'.repeat(CAP - 10) + ' at x=1=1');
