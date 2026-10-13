import { describe, expect, it } from 'vitest';
import { istftChannels, stftChannels, UMX_HOP, UMX_N_FFT } from '../src/stft.js';

describe('stft/istft', () => {
  it('round-trips a sine with low error', () => {
    const sr = 44100;
    const n = sr * 2;
    const freq = 440;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) mono[i] = 0.5 * Math.sin((2 * Math.PI * freq * i) / sr);

    const spec = stftChannels([mono, mono], { nFft: UMX_N_FFT, hop: UMX_HOP });
    expect(spec.bins).toBe(2049);
    expect(spec.frames).toBeGreaterThan(10);

    const [out] = istftChannels(spec, n);
    // Skip edges (window/pad transient)
    let num = 0;
    let den = 0;
    for (let i = UMX_N_FFT; i < n - UMX_N_FFT; i++) {
      const e = out![i]! - mono[i]!;
      num += e * e;
      den += mono[i]! * mono[i]!;
    }
    const snr = 10 * Math.log10(den / Math.max(num, 1e-20));
    expect(snr).toBeGreaterThan(20);
  });
});
