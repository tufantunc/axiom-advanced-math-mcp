# S3776 — decompose fourierTransformHandler (cognitive complexity 33)

## Finding

SonarQube S3776 on `src/server/tools/fourier-transform.ts:5`:
`fourierTransformHandler` has cognitive complexity 33 (threshold 15) in a
77-line file. After the input guard (list of ≥2 numeric samples; symbolic
Fourier refused with the laplace pointer), the handler builds the report in
two fat branches: the FFT branch (per-bin lines with sampleRate-dependent
frequency formatting, an optional magnitude-spectrum block, and the optional
sampleRate footer with resolution + Nyquist) and the IFFT branch
(reconstruction lines with the 1e-10 imaginary threshold and sign
formatting).

## Design

Extract two module-level render helpers; the handler stays a linear
guard → evaluate → parse → format pipeline:

- `spectrumLines(complex, n, sampleRate, outputMagnitude)` — the FFT branch
  complete: header, `freqStep` (`sampleRate ? sampleRate/n : 1/n`), per-bin
  lines (Hz vs normalized frequency, 12-char padded re, signed im), optional
  `hypot` magnitude block, optional resolution + Nyquist footer.
- `reconstructionLines(complex)` — the IFFT branch: per-sample lines, the
  `Math.abs(im) > 1e-10` imaginary gate and sign formatting.

The handler: guard (comment block stays) → `try { evaluate(\`${mode ===
'ifft' ? 'ifft' : 'fft'}(...)\`) → parseComplexList → header line + spread of
the branch's lines → formatRawResponse } catch formatRawError`. `complex` is
typed structurally (`{ re: number; im: number }[]`) — no dependency on
parseComplexList's declared return type. Engine-call sequence and output line
order are unchanged.

## Verification

- Equivalence harness: old (`git show 7432746:…`, relative imports rewritten)
  vs new, real Giac, byte-compare of `formatRawResponse` output over:
  `fft([1,0,1,0])`; fft with `sample_rate` (Hz formatting + footer);
  `output_magnitude: false`; `ifft` (and ifft of a spectrum with exact-zero
  imaginaries — the 1e-10 gate); an 8-sample signal; `mode` undefined (→
  fft); refusals (non-array, single-element); error path (engine throw).
- Five gates; review-pro correctness → tests-mutation (sequential).
