export function erf(x: number): number {
  const sign = x >= 0 ? 1 : -1;
  x = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}

/**
 * log Γ(x), by the Lanczos approximation.
 *
 * Exists so the discrete cdf sums can work in log space. Summing them directly
 * fails at both ends: computing a fresh binomial coefficient per term is
 * quadratic (9.8s at n = k = 100000), and a running-term recurrence cannot even
 * start when its first term underflows — `0.5^100000` is 0, so every later term
 * was 0 too and `binomial(n=100000, p=0.5, k=100000)` answered 0 for a
 * probability of 1.
 */
export function lgamma(x: number): number {
  const g = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  const z = x - 1;
  let a = 0.99999999999980993;
  const t = z + 7.5;
  for (let i = 0; i < 8; i++) a += g[i] / (z + i + 1);
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
}

/** log C(n, k). */
export function lchoose(n: number, k: number): number {
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}

/**
 * Terms below this in log space contribute nothing a double can represent
 * (exp(-745) is the smallest positive subnormal), so they are skipped rather
 * than exponentiated to zero.
 */
const LOG_UNDERFLOW = -745;

/** Σ over a log-space term generator, skipping terms that cannot be represented. */
export function sumLogTerms(count: number, logTerm: (i: number) => number): number {
  let sum = 0;
  for (let i = 0; i <= count; i++) {
    const l = logTerm(i);
    if (Number.isFinite(l) && l > LOG_UNDERFLOW) sum += Math.exp(l);
  }
  return Math.min(sum, 1);
}
