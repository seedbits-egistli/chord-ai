/**
 * Constant-Q magnitude matching BTC's training features (librosa.cqt, 22.05 kHz, hop 2048,
 * 144 bins from C1, 24 bins/octave). Implemented as one 32768-point FFT per frame times a sparse
 * spectral kernel (Brown–Puckette). A per-bin log offset (calibrated against librosa, r = 0.9995)
 * makes log-magnitudes interchangeable with librosa's.
 */
import { fftInPlace } from './fftc.js';

export const CQT_SR = 22050;
export const CQT_HOP = 2048;
export const CQT_BINS = 144;
const BPO = 24;
const FMIN = 32.70319566257483;
const NFFT = 32768;

/** log(librosa) - log(this) per bin, measured on real music. */
export const CQT_LOG_OFFSET = new Float32Array([5.0161,4.9983,4.9852,4.9681,4.9582,4.9465,4.9273,4.9092,4.9035,4.8834,4.8729,4.8575,4.8398,4.8221,4.8157,4.8088,4.7756,4.7680,4.7609,4.7404,4.7236,4.7121,4.6970,4.6853,4.6687,4.6548,4.6352,4.6257,4.6128,4.5969,4.5809,4.5666,4.5500,4.5467,4.5319,4.5125,4.4945,4.4854,4.4759,4.4498,4.4407,4.4275,4.4136,4.3948,4.3807,4.3715,4.3480,4.3414,4.3335,4.3000,4.2874,4.2830,4.2731,4.2538,4.2385,4.2255,4.2143,4.1937,4.1861,4.1638,4.1473,4.1313,4.1325,4.0986,4.0783,4.0779,4.0727,4.0433,4.0403,4.0126,4.0192,3.9883,3.9891,3.9559,3.9272,3.9212,3.9305,3.9058,3.8808,3.8611,3.8727,3.8453,3.8321,3.8193,3.8047,3.7782,3.7858,3.7556,3.7439,3.7238,3.7273,3.6986,3.6892,3.6679,3.6706,3.6411,3.6416,3.6126,3.5841,3.5792,3.5839,3.5554,3.5312,3.5174,3.5259,3.4973,3.4914,3.4697,3.4588,3.4265,3.4404,3.4062,3.3950,3.3829,3.3795,3.3509,3.3465,3.3201,3.3227,3.2935,3.2951,3.2646,3.2476,3.2250,3.2374,3.2105,3.1921,3.1795,3.1765,3.1514,3.1383,3.1226,3.1144,3.0783,3.0916,3.0634,3.0556,3.0346,3.0252,3.0063,2.9880,2.9713,2.9737,2.9493]);

interface SparseRow { idx: Int32Array; re: Float64Array; im: Float64Array }
let kernel: SparseRow[] | null = null;

function buildKernel(thresh = 0.0054): SparseRow[] {
  const Q = 1 / (2 ** (1 / BPO) - 1);
  const rows: SparseRow[] = [];
  for (let k = 0; k < CQT_BINS; k++) {
    const f = FMIN * 2 ** (k / BPO);
    const N = Math.ceil((Q * CQT_SR) / f);
    const re = new Float64Array(NFFT);
    const im = new Float64Array(NFFT);
    let l1 = 0;
    const w = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      w[i] = N === 1 ? 1 : 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
      l1 += w[i]!;
    }
    const off = NFFT / 2 - Math.floor((N - 1) / 2);
    for (let i = 0; i < N; i++) {
      const n = i - (N - 1) / 2;
      const ph = (2 * Math.PI * f * n) / CQT_SR;
      re[off + i] = (w[i]! * Math.cos(ph)) / l1;
      im[off + i] = (w[i]! * Math.sin(ph)) / l1;
    }
    fftInPlace(re, im);
    // conj / NFFT, keep positive frequencies above threshold
    let mx = 0;
    for (let i = 0; i < NFFT; i++) mx = Math.max(mx, Math.hypot(re[i]!, im[i]!));
    const keep: number[] = [];
    for (let i = 0; i <= NFFT / 2; i++) if (Math.hypot(re[i]!, im[i]!) > thresh * mx) keep.push(i);
    rows.push({
      idx: Int32Array.from(keep),
      re: Float64Array.from(keep, (i) => re[i]! / NFFT),
      im: Float64Array.from(keep, (i) => -im[i]! / NFFT),
    });
  }
  return rows;
}

/**
 * Log-CQT features [frames x 144] (row-major), already offset to librosa scale: log(|C|+1e-6).
 * onProgress gets 0..1.
 */
export function logCqt(y: Float32Array, onProgress?: (p: number) => void): { data: Float32Array; frames: number } {
  kernel ??= buildKernel();
  const frames = 1 + Math.floor(y.length / CQT_HOP);
  const out = new Float32Array(frames * CQT_BINS);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  for (let t = 0; t < frames; t++) {
    const start = t * CQT_HOP - NFFT / 2;
    for (let i = 0; i < NFFT; i++) {
      const j = start + i;
      re[i] = j >= 0 && j < y.length ? y[j]! : 0;
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < CQT_BINS; k++) {
      const r = kernel[k]!;
      let sr = 0;
      let si = 0;
      for (let q = 0; q < r.idx.length; q++) {
        const i = r.idx[q]!;
        sr += re[i]! * r.re[q]! - im[i]! * r.im[q]!;
        si += re[i]! * r.im[q]! + im[i]! * r.re[q]!;
      }
      out[t * CQT_BINS + k] = Math.log(Math.hypot(sr, si) + 1e-6) + CQT_LOG_OFFSET[k]!;
    }
    if (onProgress && t % 64 === 0) onProgress(t / frames);
  }
  return { data: out, frames };
}
