import { hannWindow, rfftMagnitudes } from './fft.js';

const A4 = 440;

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4);
}

/**
 * Fold magnitude spectrum into 12-bin pitch-class chroma (HPCP-style).
 * Includes harmonic weighting (2nd/3rd partials vote for fundamental PC).
 */
export function spectrumToChroma(
  mag: ArrayLike<number>,
  sampleRate: number,
  tuningCents = 0,
): { chroma: Float32Array; bassChroma: Float32Array } {
  const chroma = new Float32Array(12);
  const bassChroma = new Float32Array(12);
  const n = mag.length;
  const fftSize = n * 2;
  const tuneRatio = Math.pow(2, tuningCents / 1200);

  for (let k = 1; k < n; k++) {
    const freq = ((k * sampleRate) / fftSize) / tuneRatio;
    if (freq < 55 || freq > 5000) continue;
    const midi = hzToMidi(freq);
    if (!Number.isFinite(midi)) continue;
    const amp = mag[k]!;
    if (amp <= 0) continue;

    // Soft triangular contribution to nearest pitch classes
    const pcFloat = ((midi % 12) + 12) % 12;
    const pc0 = Math.floor(pcFloat) % 12;
    const pc1 = (pc0 + 1) % 12;
    const frac = pcFloat - Math.floor(pcFloat);
    const midW = freq >= 100 && freq <= 2500 ? 1.25 : 0.65;
    const a0 = amp * (1 - frac) * midW;
    const a1 = amp * frac * midW;
    chroma[pc0]! += a0;
    chroma[pc1]! += a1;

    // Harmonic contribution: 2nd & 3rd partials reinforce fundamental
    for (const harm of [2, 3]) {
      const f0 = freq / harm;
      if (f0 < 55) continue;
      const m0 = hzToMidi(f0);
      const pcf = ((m0 % 12) + 12) % 12;
      const p = Math.round(pcf) % 12;
      chroma[p]! += amp * (harm === 2 ? 0.35 : 0.2) * midW;
    }

    if (freq < 250) {
      bassChroma[pc0]! += a0;
      bassChroma[pc1]! += a1;
    }
  }
  normalizeL2(chroma);
  normalizeL2(bassChroma);
  return { chroma, bassChroma };
}

export function normalizeL2(v: Float32Array): void {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n);
  if (n < 1e-12) return;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
}

export interface ChromaFrame {
  tMs: number;
  chroma: Float32Array;
  bassChroma: Float32Array;
  energy: number;
}

/** Estimate global tuning offset in cents from spectral peaks (−50…+50). */
export function estimateTuningCents(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 8192,
): number {
  const window = hannWindow(frameSize);
  const start = Math.min(
    Math.floor(samples.length * 0.2),
    Math.max(0, samples.length - frameSize * 4),
  );
  const votes = new Float32Array(21); // -50..+50 step 5
  for (let s = 0; s < 4; s++) {
    const off = start + s * frameSize;
    if (off + frameSize > samples.length) break;
    const frame = samples.subarray(off, off + frameSize);
    const mag = rfftMagnitudes(frame, window);
    const n = mag.length;
    const fftSize = n * 2;
    for (let k = 2; k < n; k++) {
      const freq = (k * sampleRate) / fftSize;
      if (freq < 100 || freq > 2000) continue;
      const amp = mag[k]!;
      if (amp < (mag[k - 1] ?? 0) || amp < (mag[k + 1] ?? 0)) continue;
      const midi = hzToMidi(freq);
      const nearest = Math.round(midi);
      const cents = (midi - nearest) * 100;
      const bin = Math.round((cents + 50) / 5);
      if (bin >= 0 && bin < 21) votes[bin]! += amp;
    }
  }
  let best = 10;
  let bestV = -Infinity;
  for (let i = 0; i < 21; i++) {
    if (votes[i]! > bestV) {
      bestV = votes[i]!;
      best = i;
    }
  }
  return best * 5 - 50;
}

export function computeChromaFrames(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 4096,
  hopSize = 2048,
  tuningCents = 0,
): ChromaFrame[] {
  const window = hannWindow(frameSize);
  const frames: ChromaFrame[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.subarray(start, start + frameSize);
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i]! * frame[i]!;
    energy = Math.sqrt(energy / frame.length);
    const mag = rfftMagnitudes(frame, window);
    const { chroma, bassChroma } = spectrumToChroma(mag, sampleRate, tuningCents);
    frames.push({
      tMs: (start / sampleRate) * 1000,
      chroma,
      bassChroma,
      energy,
    });
  }
  return frames;
}

/** Average chroma over [startMs, endMs) with energy weighting */
export function averageChroma(
  frames: ChromaFrame[],
  startMs: number,
  endMs: number,
): { chroma: Float32Array; bassChroma: Float32Array; energy: number } {
  const chroma = new Float32Array(12);
  const bassChroma = new Float32Array(12);
  let energy = 0;
  let wSum = 0;
  for (const f of frames) {
    if (f.tMs < startMs) continue;
    if (f.tMs >= endMs) break;
    const w = 0.05 + f.energy;
    for (let i = 0; i < 12; i++) {
      chroma[i]! += f.chroma[i]! * w;
      bassChroma[i]! += f.bassChroma[i]! * w;
    }
    energy += f.energy * w;
    wSum += w;
  }
  if (wSum > 0) {
    for (let i = 0; i < 12; i++) {
      chroma[i]! /= wSum;
      bassChroma[i]! /= wSum;
    }
    energy /= wSum;
  }
  normalizeL2(chroma);
  normalizeL2(bassChroma);
  return { chroma, bassChroma, energy };
}
