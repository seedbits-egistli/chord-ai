import { describe, expect, it } from 'vitest';
import { estimateTuningCents, parabolicPeakOffset } from '../src/chroma.js';

/** Synthetic tone at A4 shifted by `cents`, plus quiet harmonics. */
function synthTone(cents: number, durationSec = 2.5, sampleRate = 22050): Float32Array {
  const n = Math.floor(durationSec * sampleRate);
  const out = new Float32Array(n);
  const f0 = 440 * Math.pow(2, cents / 1200);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // Slight amplitude envelope so frames aren't edge-silent
    const env = 0.25 + 0.75 * Math.min(1, t * 4) * Math.min(1, (durationSec - t) * 4);
    out[i] =
      env *
      (0.9 * Math.sin(2 * Math.PI * f0 * t) +
        0.35 * Math.sin(2 * Math.PI * f0 * 2 * t) +
        0.15 * Math.sin(2 * Math.PI * f0 * 3 * t));
  }
  return out;
}

describe('parabolicPeakOffset', () => {
  it('returns 0 at a symmetric peak', () => {
    expect(parabolicPeakOffset(1, 2, 1)).toBeCloseTo(0, 5);
  });

  it('leans toward the taller neighbor', () => {
    expect(parabolicPeakOffset(1, 2, 1.5)).toBeGreaterThan(0);
    expect(parabolicPeakOffset(1.5, 2, 1)).toBeLessThan(0);
  });
});

describe('estimateTuningCents', () => {
  const cases = [
    { cents: 0, tol: 4 },
    { cents: 20, tol: 5 },
    { cents: -30, tol: 5 },
    { cents: 45, tol: 6 },
  ] as const;

  for (const { cents, tol } of cases) {
    it(`recovers ~${cents >= 0 ? '+' : ''}${cents} cents`, () => {
      const samples = synthTone(cents);
      const est = estimateTuningCents(samples, 22050, 8192);
      expect(Math.abs(est - cents)).toBeLessThanOrEqual(tol);
    });
  }

  it('returns near 0 on silence / too-short audio', () => {
    expect(estimateTuningCents(new Float32Array(100), 22050, 8192)).toBe(0);
    expect(estimateTuningCents(new Float32Array(8192), 22050, 8192)).toBe(0);
  });
});
