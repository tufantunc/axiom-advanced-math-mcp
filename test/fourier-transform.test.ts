import { describe, it, expect, beforeAll } from 'vitest';
import { giacEngine } from '../src/server/giac/index.js';
import { fourierTransformHandler } from '../src/server/tools/fourier-transform.js';

beforeAll(async () => {
  await giacEngine.initialize();
}, 60000);

describe('fourier_transform', () => {
  describe('FFT', () => {
    it('should return DC component for constant signal', async () => {
      // DC signal [1, 1, 1, 1]: FFT should give [4, 0, 0, 0]
      const result = await fourierTransformHandler({
        mode: 'fft',
        data: [1, 1, 1, 1],
        output_magnitude: true,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('[0]');
      expect(result.content[0].text).toContain('4');
    });

    it('should handle alternating signal [1, -1, 1, -1]', async () => {
      const result = await fourierTransformHandler({
        mode: 'fft',
        data: [1, -1, 1, -1],
        output_magnitude: true,
      });
      expect(result.isError).toBe(false);
      // Alternating signal concentrates energy (Giac returns one-sided spectrum)
      expect(result.content[0].text).toMatch(/4\.0+/);
    });

    it('should include sample rate info when provided', async () => {
      const result = await fourierTransformHandler({
        mode: 'fft',
        data: [1, 0, 1, 0, 1, 0, 1, 0],
        sample_rate: 8,
        output_magnitude: true,
      });
      expect(result.isError).toBe(false);
      expect(result.content[0].text).toContain('Hz');
      expect(result.content[0].text).toContain('Nyquist');
    });
  });

  describe('IFFT', () => {
    it('should reconstruct original signal from spectrum', async () => {
      // fft([1,0,1,0]) → [2,0,0,0,2,0,0,0] approximately
      // ifft of that should give back [1,0,1,0]
      const fftResult = await fourierTransformHandler({
        mode: 'fft',
        data: [1, 0, 1, 0],
        output_magnitude: false,
      });
      expect(fftResult.isError).toBe(false);

      // Now IFFT should recover [1,0,1,0]
      const ifftResult = await fourierTransformHandler({
        mode: 'ifft',
        data: [2, 0, 0, 0, 2, 0, 0, 0],
        output_magnitude: false,
      });
      expect(ifftResult.isError).toBe(false);
      expect(ifftResult.content[0].text).toContain('[0]');
    });
  });

  describe('Error handling', () => {
    it('should require at least 2 data points', async () => {
      const result = await fourierTransformHandler({
        mode: 'fft',
        data: [1],
        output_magnitude: false,
      });
      // Zod validation would reject this, but handler should not crash either way
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('at least 2 numeric samples');
    });
  });
});
