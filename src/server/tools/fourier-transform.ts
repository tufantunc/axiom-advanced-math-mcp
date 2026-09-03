import { giacEngine } from '../giac/index.js';
import { formatRawResponse, formatRawError, formatErrorResponse } from './response-formatter.js';
import { parseComplexList } from './output-cleanup.js';

export async function fourierTransformHandler(args: Record<string, unknown>) {
  const mode = args.mode as string;
  const data = args.data as number[];
  const sampleRate = args.sample_rate as number | undefined;
  const outputMagnitude = args.output_magnitude !== false;

  // Early return, matching how every other handler in this directory reports
  // bad input. Giac has no symbolic Fourier transform (`fourier(sin(t),t,s)`
  // comes back unevaluated), so this tool is discrete FFT over samples only.
  // n < 2 is rejected here because Giac answers `fft([1])` with
  // "GIAC_ERROR: Invalid dimension" rather than throwing.
  if (!Array.isArray(data) || data.length < 2) {
    return formatErrorResponse(
      'fourier needs a list of at least 2 numeric samples, e.g. fft([1,0,1,0]). ' +
        'Symbolic Fourier transforms are not supported; use laplace() for a symbolic transform.'
    );
  }

  try {
    const n = data.length;
    const giacList = `[${data.join(',')}]`;

    const fn = mode === 'ifft' ? 'ifft' : 'fft';
    const raw = await giacEngine.evaluate(`${fn}(${giacList})`);

    const complex = parseComplexList(raw);

    const lines: string[] = [`${mode.toUpperCase()}: n = ${n} samples`, ``];

    if (mode === 'fft') {
      lines.push('Frequency spectrum (index, real, imag):');
      const freqStep = sampleRate ? sampleRate / n : 1 / n;
      const magLines: string[] = outputMagnitude ? ['', 'Magnitude spectrum:'] : [];

      for (let k = 0; k < complex.length; k++) {
        const { re, im } = complex[k];
        const freq = sampleRate ? (k * freqStep).toFixed(4) + ' Hz' : (k / n).toFixed(4);
        const reStr = re.toFixed(6).padStart(12);
        const imStr = (im >= 0 ? '+' : '') + im.toFixed(6) + 'i';
        lines.push(`  [${k}] f=${freq}  ${reStr} ${imStr}`);

        if (outputMagnitude) {
          const mag = Math.hypot(re, im);
          magLines.push(`  [${k}] f=${freq}  |X| = ${mag.toFixed(6)}`);
        }
      }

      if (outputMagnitude) lines.push(...magLines);
      if (sampleRate) {
        lines.push(
          '',
          `Frequency resolution: ${freqStep.toFixed(4)} Hz/bin`,
          `Nyquist frequency: ${(sampleRate / 2).toFixed(4)} Hz`
        );
      }
    } else {
      lines.push('Reconstructed time-domain signal:');
      for (let k = 0; k < complex.length; k++) {
        const { re, im } = complex[k];
        let imaginaryPart = '';
        if (Math.abs(im) > 1e-10) {
          const sign = im < 0 ? '-' : '+';
          imaginaryPart = ` ${sign} ${Math.abs(im).toFixed(8)}i`;
        }
        lines.push(`  [${k}]  ${re.toFixed(8)}${imaginaryPart}`);
      }
    }

    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
