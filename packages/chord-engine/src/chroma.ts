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

/** Quadratic (parabolic) peak offset in bins from three magnitude samples. */
export function parabolicPeakOffset(ym1: number, y0: number, yp1: number): number {
  const denom = ym1 - 2 * y0 + yp1;
  if (Math.abs(denom) < 1e-18) return 0;
  const delta = (0.5 * (ym1 - yp1)) / denom;
  if (!Number.isFinite(delta)) return 0;
  return Math.max(-0.5, Math.min(0.5, delta));
}

/**
 * Estimate global tuning offset in cents from spectral peaks (−50…+50).
 *
 * Samples many frames across the clip, interpolates peak bins with a
 * parabolic fit, then takes an energy-weighted circular mean of cent
 * deviations (period 100¢). More robust than a coarse histogram vote.
 */
export function estimateTuningCents(
  samples: Float32Array,
  sampleRate: number,
  frameSize = 8192,
): number {
  if (samples.length < frameSize) return 0;
  const window = hannWindow(frameSize);
  const hop = Math.max(256, Math.floor(frameSize / 4));
  const maxFrames = 96;
  const usable = samples.length - frameSize;
  const stride =
    usable <= 0
      ? hop
      : Math.max(hop, Math.floor(usable / Math.max(1, maxFrames - 1)));

  // Accumulator for circular mean on the 100-cent wrap
  let sumCos = 0;
  let sumSin = 0;
  let weightSum = 0;
  const centSamples: number[] = [];
  const centWeights: number[] = [];

  for (let off = 0; off + frameSize <= samples.length; off += stride) {
    const frame = samples.subarray(off, off + frameSize);
    let frameEnergy = 0;
    for (let i = 0; i < frame.length; i++) frameEnergy += frame[i]! * frame[i]!;
    frameEnergy = Math.sqrt(frameEnergy / frame.length);
    if (frameEnergy < 1e-5) continue;

    const mag = rfftMagnitudes(frame, window);
    const n = mag.length;
    const fftSize = n * 2;

    // Adaptive peak floor from mid-band energy
    let bandSum = 0;
    let bandN = 0;
    for (let k = 2; k < n; k++) {
      const freq = (k * sampleRate) / fftSize;
      if (freq < 80 || freq > 2500) continue;
      bandSum += mag[k]!;
      bandN++;
    }
    const bandMean = bandN ? bandSum / bandN : 0;
    const peakFloor = Math.max(bandMean * 4, 1e-8);

    for (let k = 2; k < n - 1; k++) {
      const amp = mag[k]!;
      if (amp < peakFloor) continue;
      if (amp < mag[k - 1]! || amp < mag[k + 1]!) continue;

      const delta = parabolicPeakOffset(mag[k - 1]!, amp, mag[k + 1]!);
      const freq = ((k + delta) * sampleRate) / fftSize;
      if (freq < 90 || freq > 2200) continue;

      const midi = hzToMidi(freq);
      if (!Number.isFinite(midi)) continue;
      const nearest = Math.round(midi);
      let cents = (midi - nearest) * 100; // (−50, +50]
      if (cents > 50) cents -= 100;
      if (cents <= -50) cents += 100;

      // Prefer mid-band fundamentals; down-weight very high partials
      const bandW = freq >= 120 && freq <= 1200 ? 1.4 : freq < 120 ? 0.7 : 0.55;
      const w = amp * amp * bandW * (0.25 + frameEnergy);

      const ang = (cents / 100) * 2 * Math.PI;
      sumCos += w * Math.cos(ang);
      sumSin += w * Math.sin(ang);
      weightSum += w;
      centSamples.push(cents);
      centWeights.push(w);
    }
    if (centSamples.length > 8000) break; // enough evidence
  }

  if (weightSum < 1e-12 || centSamples.length < 8) return 0;

  let mean =
    (Math.atan2(sumSin, sumCos) / (2 * Math.PI)) * 100; // (−50, +50]
  if (mean > 50) mean -= 100;
  if (mean <= -50) mean += 100;

  // Outlier trim: drop samples >35¢ from circular mean, re-average
  let c2 = 0;
  let s2 = 0;
  let w2 = 0;
  for (let i = 0; i < centSamples.length; i++) {
    let d = centSamples[i]! - mean;
    if (d > 50) d -= 100;
    if (d < -50) d += 100;
    if (Math.abs(d) > 35) continue;
    const ang = (centSamples[i]! / 100) * 2 * Math.PI;
    const w = centWeights[i]!;
    c2 += w * Math.cos(ang);
    s2 += w * Math.sin(ang);
    w2 += w;
  }
  if (w2 > 1e-12) {
    mean = (Math.atan2(s2, c2) / (2 * Math.PI)) * 100;
    if (mean > 50) mean -= 100;
    if (mean <= -50) mean += 100;
  }

  // 1-cent resolution, clamp
  const out = Math.round(mean);
  return Math.max(-50, Math.min(50, out));
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

/** RMS of a mono buffer. */
export function rmsEnergy(samples: ArrayLike<number>, start = 0, end?: number): number {
  const n0 = Math.max(0, start);
  const n1 = Math.min(samples.length, end ?? samples.length);
  if (n1 <= n0) return 0;
  let s = 0;
  for (let i = n0; i < n1; i++) s += samples[i]! * samples[i]!;
  return Math.sqrt(s / (n1 - n0));
}
