/**
 * Beat This! (Foscarin et al., ISMIR 2024, MIT) beat/downbeat tracking.
 * Log-mel front end identical to beat_this.preprocessing.LogMelSpect (torchaudio MelSpectrogram:
 * 22.05 kHz, n_fft 1024, hop 441, 30–11000 Hz, 128 slaney mels, norm None, |X|/sqrt(1024), log1p(1000x)),
 * chunked inference (1500 frames, border 6, keep_first) and the "minimal" peak-picking postprocessor.
 */
import { fftInPlace } from './fftc.js';
import type { OnnxRun, Progress } from './types.js';

const SR = 22050;
const NFFT = 1024;
const HOP = 441;
const NMEL = 128;
const FPS = 50;

function hzToMelSlaney(f: number) {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp;
}
function melToHzSlaney(m: number) {
  const fSp = 200 / 3;
  const minLogHz = 1000;
  const minLogMel = minLogHz / fSp;
  const logstep = Math.log(6.4) / 27;
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m;
}

let fb: Float32Array | null = null;
/** torchaudio.functional.melscale_fbanks(513, 30, 11000, 128, 22050, norm=None, mel_scale='slaney') → [513 x 128] */
function melFilterbank(): Float32Array {
  if (fb) return fb;
  const nF = NFFT / 2 + 1;
  const allF = Array.from({ length: nF }, (_, i) => ((SR / 2) * i) / (nF - 1));
  const mMin = hzToMelSlaney(30);
  const mMax = hzToMelSlaney(11000);
  const fPts = Array.from({ length: NMEL + 2 }, (_, i) => melToHzSlaney(mMin + ((mMax - mMin) * i) / (NMEL + 1)));
  const out = new Float32Array(nF * NMEL);
  for (let m = 0; m < NMEL; m++) {
    const lo = fPts[m]!, c = fPts[m + 1]!, hi = fPts[m + 2]!;
    for (let i = 0; i < nF; i++) {
      const down = (allF[i]! - lo) / (c - lo);
      const up = (hi - allF[i]!) / (hi - c);
      out[i * NMEL + m] = Math.max(0, Math.min(down, up));
    }
  }
  fb = out;
  return out;
}

/** Log-mel spectrogram [frames x 128] for mono 22.05 kHz audio. */
export function beatThisSpect(y: Float32Array): { data: Float32Array; frames: number } {
  const F = melFilterbank();
  const pad = NFFT / 2;
  const frames = 1 + Math.floor(y.length / HOP);
  const win = new Float64Array(NFFT);
  for (let i = 0; i < NFFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT); // periodic hann
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const mag = new Float64Array(NFFT / 2 + 1);
  const out = new Float32Array(frames * NMEL);
  const n = y.length;
  const reflect = (j: number) => {
    if (n === 1) return 0;
    while (j < 0 || j >= n) j = j < 0 ? -j : 2 * (n - 1) - j;
    return j;
  };
  const norm = 1 / Math.sqrt(NFFT);
  for (let t = 0; t < frames; t++) {
    const s = t * HOP - pad;
    for (let i = 0; i < NFFT; i++) { re[i] = y[reflect(s + i)]! * win[i]!; im[i] = 0; }
    fftInPlace(re, im);
    for (let i = 0; i <= NFFT / 2; i++) mag[i] = Math.hypot(re[i]!, im[i]!) * norm;
    for (let m = 0; m < NMEL; m++) {
      let v = 0;
      for (let i = 0; i <= NFFT / 2; i++) {
        const w = F[i * NMEL + m]!;
        if (w) v += w * mag[i]!;
      }
      out[t * NMEL + m] = Math.log1p(1000 * v);
    }
  }
  return { data: out, frames };
}

function dedup(peaks: number[], width = 1): number[] {
  const res: number[] = [];
  if (!peaks.length) return res;
  let p = peaks[0]!;
  let c = 1;
  for (const p2 of peaks.slice(1)) {
    if (p2 - p <= width) { c++; p += (p2 - p) / c; }
    else { res.push(p); p = p2; c = 1; }
  }
  res.push(p);
  return res;
}

function peaks(logits: Float32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < logits.length; i++) {
    const v = logits[i]!;
    if (v <= 0) continue;
    let mx = -Infinity;
    for (let j = Math.max(0, i - 3); j <= Math.min(logits.length - 1, i + 3); j++) mx = Math.max(mx, logits[j]!);
    if (v === mx) out.push(i);
  }
  return out;
}

/** Beats and downbeats in seconds. */
export async function trackBeatsBeatThis(
  y: Float32Array,
  run: OnnxRun,
  onProgress?: Progress,
): Promise<{ beats: number[]; downbeats: number[] }> {
  const spect = beatThisSpect(y);
  onProgress?.(0.3);
  const n = spect.frames;
  const chunk = 1500;
  const border = 6;
  const starts: number[] = [];
  for (let s = -border; s < n - border; s += chunk - 2 * border) starts.push(s);
  if (n > chunk - 2 * border) starts[starts.length - 1] = n - (chunk - border);
  const beat = new Float32Array(n).fill(NaN);
  const down = new Float32Array(n).fill(NaN);
  for (let ci = 0; ci < starts.length; ci++) {
    const st = starts[ci]!;
    const a = Math.max(st, 0);
    const b = Math.min(st + chunk, n);
    const left = Math.max(0, -st);
    const right = Math.max(0, Math.min(border, st + chunk - n));
    const len = left + (b - a) + right;
    const x = new Float32Array(len * NMEL);
    x.set(spect.data.subarray(a * NMEL, b * NMEL), left * NMEL);
    const o = await run({ spect: { data: x, dims: [1, len, NMEL] } });
    const pb = o.beat!.data;
    const pd = o.downbeat!.data;
    // keep_first: fill frames not yet written, discarding borders
    for (let i = border; i < len - border; i++) {
      const f = st + i;
      if (f < 0 || f >= n || !Number.isNaN(beat[f]!)) continue;
      beat[f] = pb[i]!;
      down[f] = pd[i]!;
    }
    onProgress?.(0.3 + (0.7 * (ci + 1)) / starts.length);
  }
  for (let i = 0; i < n; i++) if (Number.isNaN(beat[i]!)) { beat[i] = -1000; down[i] = -1000; }
  const bt = dedup(peaks(beat)).map((f) => f / FPS);
  let dt = dedup(peaks(down)).map((f) => f / FPS);
  if (bt.length) dt = dt.map((d) => bt.reduce((best, b) => (Math.abs(b - d) < Math.abs(best - d) ? b : best), bt[0]!));
  dt = [...new Set(dt)].sort((p, q) => p - q);
  return { beats: bt, downbeats: dt };
}
