import { giacEngine } from '../giac/index.js';
import { formatRawResponse, formatRawError } from './response-formatter.js';

function parseGiacComplex(giac: string): { re: number; im: number }[] {
  const stripped = giac.replace(/^\[/, '').replace(/\]$/, '');
  if (!stripped) return [];
  const nums = stripped.split(',').map((s) => Number.parseFloat(s.trim()));
  const result: { re: number; im: number }[] = [];
  for (let i = 0; i < nums.length; i += 2) {
    result.push({ re: nums[i] ?? 0, im: nums[i + 1] ?? 0 });
  }
  return result;
}

export async function fourierTransformHandler(args: Record<string, unknown>) {
  const mode = args.mode as string;
  const data = args.data as number[];
  const sampleRate = args.sample_rate as number | undefined;
  const outputMagnitude = args.output_magnitude !== false;

  try {
    const n = data.length;
    const giacList = `[${data.join(',')}]`;

    const fn = mode === 'ifft' ? 'ifft' : 'fft';
    const raw = await giacEngine.evaluate(`${fn}(${giacList})`);

    const complex = parseGiacComplex(raw);

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
          const mag = Math.sqrt(re * re + im * im);
          magLines.push(`  [${k}] f=${freq}  |X| = ${mag.toFixed(6)}`);
        }
      }

      if (outputMagnitude) lines.push(...magLines);
      if (sampleRate) {
        lines.push('');
        lines.push(`Frequency resolution: ${freqStep.toFixed(4)} Hz/bin`);
        lines.push(`Nyquist frequency: ${(sampleRate / 2).toFixed(4)} Hz`);
      }
    } else {
      lines.push('Reconstructed time-domain signal:');
      for (let k = 0; k < complex.length; k++) {
        const { re, im } = complex[k];
        lines.push(
          `  [${k}]  ${re.toFixed(8)}${Math.abs(im) > 1e-10 ? ` + ${im.toFixed(8)}i` : ''}`
        );
      }
    }

    return formatRawResponse(lines);
  } catch (error) {
    return formatRawError(error);
  }
}
