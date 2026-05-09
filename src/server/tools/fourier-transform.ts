import { z } from 'zod';
import { giacEngine } from '../giac/index.js';

export const fourierTransformSchema = z.object({
  mode: z
    .enum(['fft', 'ifft'] as const)
    .describe(
      'Transform mode: fft (forward Discrete Fourier Transform) or ifft (inverse DFT). ' +
      'SCOPE: Only use for actual numerical signal/data arrays (engineering, signal processing). ' +
      'Do NOT use for standard math problems, algebraic expressions, or symbolic computations. ' +
      'For symbolic Fourier transforms of expressions, use advanced_solve.',
    ),
  data: z
    .array(z.number())
    .min(2)
    .describe('Input data array (real-valued numbers). For FFT, best performance with power-of-2 length.'),
  sample_rate: z
    .number()
    .positive()
    .optional()
    .describe('Sample rate in Hz. If provided, frequency axis is computed in Hz (default: normalized 0–1).'),
  output_magnitude: z
    .boolean()
    .optional()
    .default(true)
    .describe('If true (default), also return magnitude spectrum |X[k]|.'),
});

/** Parse a Giac list string like "[2.0,0.0,2.0,0.0]" into number pairs [real, imag] */
function parseGiacComplex(giac: string): { re: number; im: number }[] {
  // Giac fft returns real-interleaved list: [re0, im0, re1, im1, ...]
  const stripped = giac.replace(/^\[/, '').replace(/\]$/, '');
  if (!stripped) return [];
  const nums = stripped.split(',').map((s) => parseFloat(s.trim()));
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

    // Giac returns a flat real-interleaved list
    const complex = parseGiacComplex(raw);

    const lines: string[] = [
      `${mode.toUpperCase()}: n = ${n} samples`,
      ``,
    ];

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
      // IFFT
      lines.push('Reconstructed time-domain signal:');
      for (let k = 0; k < complex.length; k++) {
        const { re, im } = complex[k];
        lines.push(`  [${k}]  ${re.toFixed(8)}${Math.abs(im) > 1e-10 ? ` + ${im.toFixed(8)}i` : ''}`);
      }
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      isError: false,
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
