/**
 * NNLS approximate-note-transcription chroma (Mauch & Dixon, ISMIR 2010).
 *
 * Independent MIT implementation from the paper description — not derived from
 * Chordino / nnls-chroma (GPL). Pipeline:
 *   DFT → log-frequency spectrum (3 bins/semitone) → tuning shift →
 *   spectral standardisation → NNLS vs harmonic note dictionary →
 *   treble / bass chroma (pitch-domain windows) → beat sync.
 */

import { nextPow2, rfftMagnitudes } from './fft.js';
import { normalizeL2 } from './chroma.js';

const A4 = 440;
/** MIDI A0 … G♯6 inclusive = 84 notes (paper §2.4). */
const MIDI_LO = 21;
const MIDI_HI = 104;
const N_NOTES = MIDI_HI - MIDI_LO + 1; // 84
const BINS_PER_SEMI = 3;
const N_LOG = N_NOTES * BINS_PER_SEMI; // 252
/** Geometric harmonic decay (paper best MIREX setting s=0.6). */
const HARM_DECAY = 0.6;
const TARGET_SR = 11025;
const FRAME = 4096;
const HOP = 2048;

export interface NnlsBeatChroma {
  startMs: number;
  endMs: number;
  treble: Float32Array;
  bass: Float32Array;
  /** Semitone activation energy (optional diagnostics). */
  noteEnergy: number;
}

export interface NnlsChromaResult {
  beats: NnlsBeatChroma[];
  tuningCents: number;
  /** Wall time for this analysis (ms). */
  analysisMs: number;
  frameCount: number;
}

function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / A4);
}

function midiToHz(midi: number): number {
  return A4 * Math.pow(2, (midi - 69) / 12);
}

function hammingWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (size - 1));
  }
  return w;
}

/** Linear resample (analysis quality). */
function resampleLinear(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const n = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const f = src - i0;
    out[i] = input[i0]! * (1 - f) + input[i1]! * f;
  }
  return out;
}

/** Soft cosine kernel weight for distance in [0,1]. */
function cosKernel(d: number): number {
  if (d >= 1) return 0;
  if (d <= 0) return 1;
  return 0.5 * (1 + Math.cos(Math.PI * d));
}

/**
 * Map linear FFT magnitudes → log-frequency (3 bins / semitone).
 * Cosine interpolation on the pitch axis (paper §2.2).
 */
export function magnitudeToLogFreq(
  mag: ArrayLike<number>,
  sampleRate: number,
  fftSize: number,
  tuningCents = 0,
): Float32Array {
  const out = new Float32Array(N_LOG);
  const tune = Math.pow(2, tuningCents / 1200);
  const midi0 = MIDI_LO - 0.5 / BINS_PER_SEMI; // left edge of first bin
  for (let k = 1; k < mag.length; k++) {
    const amp = mag[k]!;
    if (amp <= 0) continue;
    const hz = ((k * sampleRate) / fftSize) / tune;
    if (hz < 20 || hz > 5000) continue;
    const midi = hzToMidi(hz);
    const binF = (midi - midi0) * BINS_PER_SEMI;
    const b0 = Math.floor(binF);
    // distribute to ±1 bin with cosine
    for (let db = -1; db <= 2; db++) {
      const b = b0 + db;
      if (b < 0 || b >= N_LOG) continue;
      const d = Math.abs(binF - b);
      const w = cosKernel(d / 1.5);
      if (w > 0) out[b]! += amp * w;
    }
  }
  return out;
}

/** Octave-wide (±18 third-semitone bins) Hamming running mean / std, then std whitening. */
export function standardizeLogFreq(Y: Float32Array): Float32Array {
  const n = Y.length;
  const half = 18; // paper: bin k±18
  const out = new Float32Array(n);
  // Precompute Hamming weights
  const win = half * 2 + 1;
  const hw = new Float32Array(win);
  let wsum = 0;
  for (let i = 0; i < win; i++) {
    hw[i] = 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (win - 1));
    wsum += hw[i]!;
  }
  for (let i = 0; i < win; i++) hw[i]! /= wsum;

  for (let k = 0; k < n; k++) {
    let mu = 0;
    let m2 = 0;
    for (let d = -half; d <= half; d++) {
      const j = Math.max(0, Math.min(n - 1, k + d));
      const w = hw[d + half]!;
      const v = Y[j]!;
      mu += w * v;
      m2 += w * v * v;
    }
    const var_ = Math.max(1e-12, m2 - mu * mu);
    const sig = Math.sqrt(var_);
    const v = (Y[k]! - mu) / sig;
    out[k] = v > 0 ? v : 0;
  }
  return out;
}

/** Estimate tuning cents from log-freq energy concentrated on centre bins of each semitone. */
export function estimateTuningFromLogFreq(frames: Float32Array[]): number {
  // Vote: for each semitone, compare energy of 3 sub-bins; offset → cents
  let sinAcc = 0;
  let cosAcc = 0;
  for (const Y of frames) {
    for (let s = 0; s < N_NOTES; s++) {
      const b = s * BINS_PER_SEMI;
      const e0 = Y[b]!;
      const e1 = Y[b + 1]!;
      const e2 = Y[b + 2]!;
      const sum = e0 + e1 + e2;
      if (sum < 1e-6) continue;
      // sub-bin offset -1,0,+1 → ±33.3¢ within semitone; circular in 100¢
      const num = -e0 + e2;
      const den = e0 + e1 + e2;
      const cents = (num / den) * (100 / 3);
      const ang = (cents / 100) * 2 * Math.PI;
      sinAcc += sum * Math.sin(ang);
      cosAcc += sum * Math.cos(ang);
    }
  }
  if (sinAcc * sinAcc + cosAcc * cosAcc < 1e-18) return 0;
  let cents = (Math.atan2(sinAcc, cosAcc) / (2 * Math.PI)) * 100;
  // map to [-50,50]
  while (cents > 50) cents -= 100;
  while (cents < -50) cents += 100;
  return cents;
}

/** Shift log-freq by fractional bins (linear interpolation). */
export function shiftLogFreq(Y: Float32Array, cents: number): Float32Array {
  const shiftBins = (cents / 100) * BINS_PER_SEMI; // 100¢ = 1 semitone = 3 bins
  if (Math.abs(shiftBins) < 1e-6) return Y;
  const out = new Float32Array(N_LOG);
  for (let i = 0; i < N_LOG; i++) {
    const src = i - shiftBins;
    const i0 = Math.floor(src);
    const f = src - i0;
    const a = i0 >= 0 && i0 < N_LOG ? Y[i0]! : 0;
    const b = i0 + 1 >= 0 && i0 + 1 < N_LOG ? Y[i0 + 1]! : 0;
    out[i] = a * (1 - f) + b * f;
  }
  return out;
}

let DICT_CACHE: Float32Array | null = null; // column-major N_LOG * N_NOTES

/** Build note dictionary E (columns = idealised harmonic notes, L1-normalised). */
export function buildNoteDictionary(s = HARM_DECAY): Float32Array {
  if (DICT_CACHE && s === HARM_DECAY) return DICT_CACHE;
  const E = new Float32Array(N_LOG * N_NOTES);
  for (let n = 0; n < N_NOTES; n++) {
    const midi = MIDI_LO + n;
    const col = n * N_LOG;
    for (let h = 1; h <= 20; h++) {
      const hz = midiToHz(midi) * h;
      if (hz > 5000) break;
      const midiH = hzToMidi(hz);
      const binF = (midiH - (MIDI_LO - 0.5 / BINS_PER_SEMI)) * BINS_PER_SEMI;
      const amp = Math.pow(s, h - 1);
      const b0 = Math.round(binF);
      for (let db = -1; db <= 1; db++) {
        const b = b0 + db;
        if (b < 0 || b >= N_LOG) continue;
        const w = db === 0 ? 1 : 0.5;
        E[col + b]! += amp * w;
      }
    }
    // L1 normalise column
    let sum = 0;
    for (let i = 0; i < N_LOG; i++) sum += E[col + i]!;
    if (sum > 1e-12) {
      for (let i = 0; i < N_LOG; i++) E[col + i]! /= sum;
    }
  }
  if (s === HARM_DECAY) DICT_CACHE = E;
  return E;
}

/**
 * Lawson–Hanson active-set NNLS: min ||Ex - y||² s.t. x ≥ 0.
 * Compact independent implementation (not from GPL Chordino).
 */
export function nnls(E: Float32Array, y: ArrayLike<number>, nRows: number, nCols: number): Float32Array {
  const x = new Float32Array(nCols);
  const P: number[] = []; // passive (free) set
  const w = new Float32Array(nCols); // dual / gradient
  const maxIter = nCols * 3;

  const resid = new Float32Array(nRows);
  for (let i = 0; i < nRows; i++) resid[i] = y[i]!;

  const recomputeGrad = () => {
    for (let j = 0; j < nCols; j++) {
      let s = 0;
      const col = j * nRows;
      for (let i = 0; i < nRows; i++) s += E[col + i]! * resid[i]!;
      w[j] = s;
    }
  };

  recomputeGrad();

  for (let iter = 0; iter < maxIter; iter++) {
    // Find max positive gradient outside P
    let maxW = 0;
    let maxJ = -1;
    for (let j = 0; j < nCols; j++) {
      if (P.includes(j)) continue;
      if (w[j]! > maxW) {
        maxW = w[j]!;
        maxJ = j;
      }
    }
    if (maxJ < 0 || maxW < 1e-10) break;
    P.push(maxJ);

    // Solve unconstrained least squares on P: (E_P^T E_P) z = E_P^T y
    for (let inner = 0; inner < nCols + 2; inner++) {
      const m = P.length;
      if (m === 0) break;
      // Build Gram G[m×m] and b[m]
      const G = new Float32Array(m * m);
      const b = new Float32Array(m);
      for (let a = 0; a < m; a++) {
        const ja = P[a]!;
        const cola = ja * nRows;
        let bv = 0;
        for (let i = 0; i < nRows; i++) bv += E[cola + i]! * y[i]!;
        b[a] = bv;
        for (let c = a; c < m; c++) {
          const jc = P[c]!;
          const colc = jc * nRows;
          let g = 0;
          for (let i = 0; i < nRows; i++) g += E[cola + i]! * E[colc + i]!;
          G[a * m + c] = g;
          G[c * m + a] = g;
        }
        G[a * m + a]! += 1e-8; // ridge for stability
      }
      // Solve Gz = b via Gaussian elimination
      const z = solveSymmetric(G, b, m);

      // Check non-negativity
      let allPos = true;
      let minAlpha = 1;
      let dropIdx = -1;
      for (let a = 0; a < m; a++) {
        if (z[a]! <= 1e-12) {
          allPos = false;
          const xa = x[P[a]!]!;
          // step toward boundary
          if (z[a]! < xa) {
            const alpha = xa / (xa - z[a]!);
            if (alpha < minAlpha) {
              minAlpha = alpha;
              dropIdx = a;
            }
          }
        }
      }
      if (allPos) {
        for (let a = 0; a < m; a++) x[P[a]!] = Math.max(0, z[a]!);
        break;
      }
      // Move toward z, drop zeroed variable
      for (let a = 0; a < m; a++) {
        const j = P[a]!;
        x[j] = x[j]! + minAlpha * (z[a]! - x[j]!);
        if (x[j]! < 1e-12) x[j] = 0;
      }
      if (dropIdx >= 0) {
        P.splice(dropIdx, 1);
      } else {
        // drop any near-zero
        for (let a = m - 1; a >= 0; a--) {
          if (x[P[a]!]! <= 1e-12) P.splice(a, 1);
        }
      }
    }

    // Update residual
    for (let i = 0; i < nRows; i++) {
      let pred = 0;
      for (const j of P) pred += E[j * nRows + i]! * x[j]!;
      resid[i] = y[i]! - pred;
    }
    recomputeGrad();
  }
  return x;
}

function solveSymmetric(G: Float32Array, b: Float32Array, m: number): Float32Array {
  // Copy to augmented matrix
  const A = new Float32Array(m * (m + 1));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < m; j++) A[i * (m + 1) + j] = G[i * m + j]!;
    A[i * (m + 1) + m] = b[i]!;
  }
  for (let col = 0; col < m; col++) {
    let piv = col;
    let best = Math.abs(A[col * (m + 1) + col]!);
    for (let r = col + 1; r < m; r++) {
      const v = Math.abs(A[r * (m + 1) + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-14) continue;
    if (piv !== col) {
      for (let j = col; j <= m; j++) {
        const tmp = A[col * (m + 1) + j]!;
        A[col * (m + 1) + j] = A[piv * (m + 1) + j]!;
        A[piv * (m + 1) + j] = tmp;
      }
    }
    const diag = A[col * (m + 1) + col]!;
    for (let r = col + 1; r < m; r++) {
      const f = A[r * (m + 1) + col]! / diag;
      for (let j = col; j <= m; j++) {
        A[r * (m + 1) + j]! -= f * A[col * (m + 1) + j]!;
      }
    }
  }
  const z = new Float32Array(m);
  for (let i = m - 1; i >= 0; i--) {
    let s = A[i * (m + 1) + m]!;
    for (let j = i + 1; j < m; j++) s -= A[i * (m + 1) + j]! * z[j]!;
    const diag = A[i * (m + 1) + i]!;
    z[i] = Math.abs(diag) > 1e-14 ? s / diag : 0;
  }
  return z;
}

/**
 * Pitch-domain windows before chroma wrap (paper Fig. 2 — shapes reimplemented
 * from the published figure description, not from GPL sources).
 * Bass: emphasise ~MIDI 30–55; treble: ~MIDI 45–88.
 */
export function bassPitchWeight(midi: number): number {
  if (midi < 24 || midi > 64) return 0;
  if (midi < 32) return (midi - 24) / 8;
  if (midi <= 50) return 1;
  return Math.max(0, 1 - (midi - 50) / 14);
}

export function treblePitchWeight(midi: number): number {
  if (midi < 32 || midi > 100) return 0;
  if (midi < 45) return (midi - 32) / 13;
  if (midi <= 80) return 1;
  return Math.max(0, 1 - (midi - 80) / 20);
}

export function activationsToChroma(x: ArrayLike<number>): {
  treble: Float32Array;
  bass: Float32Array;
  noteEnergy: number;
} {
  const treble = new Float32Array(12);
  const bass = new Float32Array(12);
  let noteEnergy = 0;
  for (let n = 0; n < N_NOTES; n++) {
    const a = x[n]!;
    if (a <= 0) continue;
    noteEnergy += a;
    const midi = MIDI_LO + n;
    const pc = ((midi % 12) + 12) % 12;
    treble[pc]! += a * treblePitchWeight(midi);
    bass[pc]! += a * bassPitchWeight(midi);
  }
  // Max-norm as in paper §2.5, then L2 for cosine match compatibility
  maxNorm(treble);
  maxNorm(bass);
  normalizeL2(treble);
  normalizeL2(bass);
  return { treble, bass, noteEnergy };
}

function maxNorm(v: Float32Array): void {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, v[i]!);
  if (m < 1e-12) return;
  for (let i = 0; i < v.length; i++) v[i]! /= m;
}

function medianCol(frames: Float32Array[], n: number): Float32Array {
  const out = new Float32Array(n);
  if (!frames.length) return out;
  const tmp = new Float32Array(frames.length);
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < frames.length; f++) tmp[f] = frames[f]![i]!;
    tmp.sort();
    const mid = tmp.length >> 1;
    out[i] =
      tmp.length % 2 ? tmp[mid]! : 0.5 * (tmp[mid - 1]! + tmp[mid]!);
  }
  return out;
}

export interface NnlsOptions {
  /** Harmonic decay s (default 0.6). */
  harmDecay?: number;
  /** Skip NNLS and map log-freq centres directly (ablation). */
  skipNnls?: boolean;
  /** Max frames to process (downsample in time if exceeded). */
  maxFrames?: number;
}

/**
 * Compute beat-synchronous NNLS treble/bass chroma from mono audio.
 * Beats are in milliseconds (same convention as the rest of the engine).
 */
export function computeNnlsBeatChroma(
  samples: Float32Array,
  sampleRate: number,
  beatsMs: number[],
  durationMs: number,
  options: NnlsOptions = {},
): NnlsChromaResult {
  const t0 = performance.now();
  const s = options.harmDecay ?? HARM_DECAY;
  let mono = samples;
  let sr = sampleRate;
  if (sr !== TARGET_SR) {
    mono = resampleLinear(samples, sr, TARGET_SR);
    sr = TARGET_SR;
  }

  const window = hammingWindow(FRAME);
  const frameTimes: number[] = [];
  const rawLog: Float32Array[] = [];
  const maxFrames = options.maxFrames ?? 400;
  const hop = HOP;
  const nFramesAvail = Math.max(0, Math.floor((mono.length - FRAME) / hop) + 1);
  const step = nFramesAvail > maxFrames ? Math.ceil(nFramesAvail / maxFrames) : 1;
  const fftSize = nextPow2(FRAME);

  for (let idx = 0; idx + FRAME <= mono.length; idx += hop * step) {
    const frame = mono.subarray(idx, idx + FRAME);
    const mag = rfftMagnitudes(frame, window);
    rawLog.push(magnitudeToLogFreq(mag, sr, fftSize, 0));
    frameTimes.push(((idx + FRAME / 2) / sr) * 1000);
    if (rawLog.length >= maxFrames) break;
  }

  if (!rawLog.length) {
    return { beats: [], tuningCents: 0, analysisMs: performance.now() - t0, frameCount: 0 };
  }

  const tuningCents = estimateTuningFromLogFreq(rawLog);
  const whitened: Float32Array[] = [];
  for (const Y of rawLog) {
    const shifted = shiftLogFreq(Y, tuningCents);
    whitened.push(standardizeLogFreq(shifted));
  }

  const E = buildNoteDictionary(s);
  const beatMs = beatsMs.length >= 2 ? undefined : 60000 / 120;
  const edges: { startMs: number; endMs: number }[] = [];
  if (beatsMs.length >= 2) {
    for (let i = 0; i < beatsMs.length; i++) {
      const startMs = beatsMs[i]!;
      const endMs =
        i + 1 < beatsMs.length
          ? beatsMs[i + 1]!
          : Math.min(durationMs, startMs + (beatMs ?? 500));
      edges.push({ startMs, endMs });
    }
  } else {
    const bm = 500;
    for (let t = 0; t < durationMs; t += bm) {
      edges.push({ startMs: t, endMs: Math.min(durationMs, t + bm) });
    }
  }

  const beats: NnlsBeatChroma[] = [];
  for (const e of edges) {
    const slice: Float32Array[] = [];
    for (let i = 0; i < whitened.length; i++) {
      const t = frameTimes[i]!;
      if (t >= e.startMs && t < e.endMs) slice.push(whitened[i]!);
    }
    if (!slice.length) {
      // nearest frame
      let best = 0;
      let bestD = Infinity;
      const mid = (e.startMs + e.endMs) / 2;
      for (let i = 0; i < frameTimes.length; i++) {
        const d = Math.abs(frameTimes[i]! - mid);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      slice.push(whitened[best]!);
    }
    const Yb = medianCol(slice, N_LOG);
    let x: Float32Array;
    if (options.skipNnls) {
      // centre bin of each semitone
      x = new Float32Array(N_NOTES);
      for (let n = 0; n < N_NOTES; n++) x[n] = Yb[n * BINS_PER_SEMI + 1]!;
    } else {
      x = nnls(E, Yb, N_LOG, N_NOTES);
    }
    const { treble, bass, noteEnergy } = activationsToChroma(x);
    beats.push({
      startMs: e.startMs,
      endMs: e.endMs,
      treble,
      bass,
      noteEnergy,
    });
  }

  return {
    beats,
    tuningCents,
    analysisMs: performance.now() - t0,
    frameCount: whitened.length,
  };
}
