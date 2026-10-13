import type { ChromaFrame } from './chroma.js';

export interface BeatTrackResult {
  bpm: number;
  beats: number[];
  timeSig: string;
}

export interface BeatTrackOptions {
  /** Optional BPM prior (e.g. from song metadata / UI) */
  bpmHint?: number;
}

/**
 * Lightweight beat tracker: onset envelope from frame energy flux,
 * autocorrelation for tempo, peak picking for beats.
 */
export function trackBeats(
  frames: ChromaFrame[],
  sampleRateHint = 22050,
  options: BeatTrackOptions = {},
): BeatTrackResult {
  void sampleRateHint;
  if (frames.length < 4) {
    return { bpm: options.bpmHint ?? 120, beats: [0], timeSig: '4/4' };
  }

  const hopMs = frames.length > 1 ? frames[1]!.tMs - frames[0]!.tMs : 50;
  const flux = new Float32Array(frames.length);
  for (let i = 1; i < frames.length; i++) {
    let spectral = 0;
    for (let p = 0; p < 12; p++) {
      spectral += Math.max(0, frames[i]!.chroma[p]! - frames[i - 1]!.chroma[p]!);
    }
    const d = Math.max(0, frames[i]!.energy - frames[i - 1]!.energy);
    flux[i] = d * 0.7 + spectral * 0.3;
  }

  const smooth = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) {
    let s = 0;
    let c = 0;
    for (let k = -2; k <= 2; k++) {
      const j = i + k;
      if (j >= 0 && j < flux.length) {
        s += flux[j]!;
        c++;
      }
    }
    smooth[i] = s / c;
  }

  const minLag = Math.max(1, Math.round(60000 / 200 / hopMs));
  const maxLag = Math.min(smooth.length - 1, Math.round(60000 / 60 / hopMs));
  let bestLag = Math.round(60000 / (options.bpmHint ?? 120) / hopMs);
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let score = 0;
    for (let i = 0; i + lag < smooth.length; i++) {
      score += smooth[i]! * smooth[i + lag]!;
    }
    const bpm = 60000 / (lag * hopMs);
    let prior = 1 - Math.min(1, Math.abs(bpm - 110) / 120) * 0.12;
    if (options.bpmHint) {
      prior *= 1 + 0.8 * Math.exp(-0.5 * ((bpm - options.bpmHint) / 8) ** 2);
      // also encourage half/double of hint
      prior *= 1 + 0.35 * Math.exp(-0.5 * ((bpm - options.bpmHint * 2) / 12) ** 2);
      prior *= 1 + 0.35 * Math.exp(-0.5 * ((bpm - options.bpmHint / 2) / 6) ** 2);
    }
    score *= prior;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let bpm = 60000 / (bestLag * hopMs);
  if (options.bpmHint) {
    // Snap toward hint if within 8%
    if (Math.abs(bpm - options.bpmHint) / options.bpmHint < 0.08) bpm = options.bpmHint;
    else if (Math.abs(bpm - options.bpmHint * 2) / (options.bpmHint * 2) < 0.08) bpm = options.bpmHint;
    else if (Math.abs(bpm - options.bpmHint / 2) / (options.bpmHint / 2) < 0.08) bpm = options.bpmHint;
  }
  if (bpm > 180) bpm /= 2;
  if (bpm < 70) bpm *= 2;

  const beatMs = 60000 / bpm;
  const duration = frames[frames.length - 1]!.tMs + hopMs;

  let bestPhase = 0;
  let bestPhaseScore = -Infinity;
  const phaseSteps = 24;
  for (let p = 0; p < phaseSteps; p++) {
    const phase = (p / phaseSteps) * beatMs;
    let score = 0;
    for (let t = phase; t < Math.min(duration, phase + beatMs * 64); t += beatMs) {
      const idx = Math.round(t / hopMs);
      if (idx >= 0 && idx < smooth.length) score += smooth[idx]!;
    }
    if (score > bestPhaseScore) {
      bestPhaseScore = score;
      bestPhase = phase;
    }
  }

  const beats: number[] = [];
  for (let t = bestPhase; t < duration; t += beatMs) {
    beats.push(Math.round(t));
  }
  if (beats.length === 0) beats.push(0);

  return { bpm: Math.round(bpm * 10) / 10, beats, timeSig: '4/4' };
}

// ---------------------------------------------------------------------------
// Audio-domain beat tracker (precise mode). Training-free:
//  - log-magnitude spectral-flux onset strength (full band + low band)
//  - autocorrelation tempogram with harmonic summation
//  - metrical-level selection (log-normal prior ~100 BPM, bass-onset and
//    harmonic-change periodicity), explicit 2:1 / 3:2 candidate comparison
//  - Ellis (2007) dynamic-programming beat tracking (follows tempo drift)
// ---------------------------------------------------------------------------

export interface AudioBeatOptions {
  bpmHint?: number;
  /** Prior centre (BPM) for metrical-level choice. Default 90. */
  priorBpm?: number;
  /** Prior width in octaves (std dev of log2 tempo). Default 0.6. */
  priorOctaves?: number;
  /** DP tightness (Ellis alpha). Default 100. */
  tightness?: number;
  minBpm?: number;
  maxBpm?: number;
  /** Exponent on relative salience when choosing the metrical level. Default 0.3. */
  salienceExponent?: number;
}

export interface AudioBeatResult extends BeatTrackResult {
  /** Onset envelope frame rate (frames/s) */
  envRate: number;
  /** Top tempo candidates with scores (debug) */
  candidates: Array<{ bpm: number; score: number }>;
}

interface OnsetEnvelopes {
  full: Float32Array;
  low: Float32Array;
  chromaNov: Float32Array;
  rate: number;
}

function fftMagInPlace(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]!; re[i] = re[j]!; re[j] = t;
      t = im[i]!; im[i] = im[j]!; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr; im[b] = im[a]! - ti;
        re[a] = re[a]! + tr; im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** Onset strength envelopes (~86 frames/s). */
export function computeOnsetEnvelopes(samples: Float32Array, sampleRate: number): OnsetEnvelopes {
  const dec = Math.max(1, Math.round(sampleRate / 11025));
  const sr = sampleRate / dec;
  const n = Math.floor(samples.length / dec);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < dec; k++) s += samples[i * dec + k]!;
    x[i] = s / dec;
  }
  const N = 1024;
  const hop = 128;
  const nFrames = Math.max(0, Math.floor((n - N) / hop) + 1);
  const bins = N / 2 + 1;
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const lowBin = Math.round((180 * N) / sr);
  const maxBin = Math.min(bins - 1, Math.round((5000 * N) / sr));
  const full = new Float32Array(nFrames);
  const low = new Float32Array(nFrames);
  const chromaNov = new Float32Array(nFrames);
  let prev = new Float64Array(bins);
  let prevChroma = new Float64Array(12);
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const binPc = new Int8Array(bins).fill(-1);
  for (let b = 1; b <= maxBin; b++) {
    const f = (b * sr) / N;
    if (f < 60 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    binPc[b] = ((Math.round(midi) % 12) + 12) % 12;
  }
  for (let fr = 0; fr < nFrames; fr++) {
    const off = fr * hop;
    for (let i = 0; i < N; i++) { re[i] = x[off + i]! * win[i]!; im[i] = 0; }
    fftMagInPlace(re, im);
    const cur = new Float64Array(bins);
    const chroma = new Float64Array(12);
    let fsum = 0;
    let lsum = 0;
    for (let b = 1; b <= maxBin; b++) {
      const mag = Math.hypot(re[b]!, im[b]!);
      const lm = Math.log1p(1000 * mag);
      cur[b] = lm;
      const d = lm - prev[b]!;
      if (d > 0) {
        fsum += d;
        if (b <= lowBin) lsum += d;
      }
      const pc = binPc[b]!;
      if (pc >= 0) chroma[pc] += mag;
    }
    let cn = 0;
    let cs = 1e-9;
    for (let p = 0; p < 12; p++) cs += chroma[p]!;
    for (let p = 0; p < 12; p++) {
      chroma[p] = chroma[p]! / cs;
      cn += Math.max(0, chroma[p]! - prevChroma[p]!);
    }
    full[fr] = fr ? fsum : 0;
    low[fr] = fr ? lsum : 0;
    chromaNov[fr] = fr ? cn : 0;
    prev = cur;
    prevChroma = chroma;
  }
  const rate = sr / hop;
  return {
    full: normalizeEnvelope(full, rate),
    low: normalizeEnvelope(low, rate),
    chromaNov: normalizeEnvelope(smoothEnv(chromaNov, Math.round(rate * 0.1)), rate),
    rate,
  };
}

function smoothEnv(e: Float32Array, half: number): Float32Array {
  if (half <= 0) return e;
  const out = new Float32Array(e.length);
  let s = 0;
  for (let i = 0; i < Math.min(e.length, half); i++) s += e[i]!;
  for (let i = 0; i < e.length; i++) {
    if (i + half < e.length) s += e[i + half]!;
    if (i - half - 1 >= 0) s -= e[i - half - 1]!;
    const lo = Math.max(0, i - half);
    const hi = Math.min(e.length - 1, i + half);
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

/** Subtract local mean (~0.5 s), half-wave rectify, unit std. */
function normalizeEnvelope(e: Float32Array, rate: number): Float32Array {
  const m = smoothEnv(e, Math.round(rate * 0.25));
  const out = new Float32Array(e.length);
  let ss = 0;
  for (let i = 0; i < e.length; i++) {
    out[i] = Math.max(0, e[i]! - m[i]!);
    ss += out[i]! * out[i]!;
  }
  const sd = Math.sqrt(ss / Math.max(1, e.length)) || 1;
  for (let i = 0; i < e.length; i++) out[i]! /= sd;
  return out;
}

/** Normalised autocorrelation r[lag] for lag 0..maxLag. */
function autocorr(e: Float32Array, maxLag: number): Float64Array {
  const r = new Float64Array(maxLag + 1);
  let mean = 0;
  for (let i = 0; i < e.length; i++) mean += e[i]!;
  mean /= Math.max(1, e.length);
  for (let lag = 0; lag <= maxLag; lag++) {
    let s = 0;
    for (let i = 0; i + lag < e.length; i++) s += (e[i]! - mean) * (e[i + lag]! - mean);
    r[lag] = s / Math.max(1, e.length - lag);
  }
  const r0 = r[0]! || 1;
  for (let lag = 0; lag <= maxLag; lag++) r[lag] = r[lag]! / r0;
  return r;
}

/** Peak-ish ACF value at fractional lag (max over ±tol frames). */
function acfAt(r: Float64Array, lag: number, tol = 1): number {
  const c = Math.round(lag);
  let best = -Infinity;
  for (let k = c - tol; k <= c + tol; k++) {
    if (k > 0 && k < r.length) best = Math.max(best, r[k]!);
  }
  return best === -Infinity ? 0 : Math.max(0, best);
}

/**
 * Pulse salience at beat period `lag` (frames): harmonic summation over
 * integer multiples (the beat and its bar-level groupings) plus the half-period
 * (on-beat subdivisions should exist but are not required).
 */
function pulseSalience(r: Float64Array, lag: number): number {
  let s = 0;
  const w = [1, 0.5, 0.33, 0.25];
  for (let k = 1; k <= 4; k++) {
    if (k * lag >= r.length - 1) break;
    s += w[k - 1]! * acfAt(r, k * lag, Math.max(1, Math.round(lag * k * 0.02)));
  }
  return s;
}

/** Debug: per-level salience parts [onset acf at k=1..4, low, chord]. */
export function debugSalience(env: OnsetEnvelopes, bpm: number): number[] {
  const rate = env.rate;
  const maxLag = Math.min(env.full.length - 2, Math.ceil((60 / 50) * rate * 4.2));
  const r = autocorr(env.full, maxLag);
  const rl = autocorr(env.low, maxLag);
  const rc = autocorr(env.chromaNov, maxLag);
  const lag = (60 / bpm) * rate;
  return [1, 2, 3, 4].map((k) => acfAt(r, k * lag, 2)).concat([acfAt(r, lag / 2, 1), pulseSalience(rl, lag), acfAt(rc, lag, 1), acfAt(rc, 2 * lag, 2), acfAt(rc, 4 * lag, 3)]);
}

export function estimateTempoFromEnvelopes(
  env: OnsetEnvelopes,
  options: AudioBeatOptions = {},
): { bpm: number; candidates: Array<{ bpm: number; score: number }> } {
  const minBpm = options.minBpm ?? 50;
  const maxBpm = options.maxBpm ?? 200;
  const rate = env.rate;
  const maxLag = Math.min(env.full.length - 2, Math.ceil((60 / minBpm) * rate * 4.2));
  const rFull = autocorr(env.full, maxLag);
  const rLow = autocorr(env.low, maxLag);
  const rChord = autocorr(env.chromaNov, maxLag);
  const priorBpm = options.priorBpm ?? 90;
  const priorOct = options.priorOctaves ?? 0.6;

  const sal = (bpm: number): { s: number; parts: number[] } => {
    const lag = (60 / bpm) * rate;
    const a = pulseSalience(rFull, lag);
    const b = pulseSalience(rLow, lag);
    // harmonic rhythm: chords change on multiples of the beat (1,2,4 beats)
    const c =
      Math.max(acfAt(rChord, 2 * lag, 2), acfAt(rChord, 4 * lag, 3)) +
      0.5 * acfAt(rChord, lag, 1);
    return { s: a + 0.6 * b + 0.5 * c, parts: [a, b, c] };
  };
  const prior = (bpm: number): number => {
    let p = Math.exp(-0.5 * (Math.log2(bpm / priorBpm) / priorOct) ** 2);
    if (options.bpmHint) {
      p *= 1 + 3 * Math.exp(-0.5 * (Math.log2(bpm / options.bpmHint) / 0.05) ** 2);
    }
    return p;
  };

  // Coarse-to-fine scan on a log grid
  const scores: Array<{ bpm: number; score: number; raw: number }> = [];
  for (let bpm = minBpm; bpm <= maxBpm; bpm *= 1.004) {
    const raw = sal(bpm).s;
    scores.push({ bpm, score: raw * prior(bpm), raw });
  }
  // local maxima of raw salience
  const peaks: Array<{ bpm: number; score: number; raw: number }> = [];
  for (let i = 1; i + 1 < scores.length; i++) {
    if (scores[i]!.raw >= scores[i - 1]!.raw && scores[i]!.raw >= scores[i + 1]!.raw) peaks.push(scores[i]!);
  }
  if (!peaks.length) return { bpm: options.bpmHint ?? 120, candidates: [] };
  peaks.sort((a, b) => b.raw - a.raw);
  // Metrical hierarchy of the most salient periodicity: binary levels
  // (x2^j, resolves 2:1) plus ternary relatives (x3/2, x2/3) that must show
  // their own clear evidence. The beat level is then chosen mainly by the
  // tempo prior, weighted softly by salience (levels in one hierarchy all
  // have strong ACF, so salience alone always prefers slow levels).
  const refine = (bpm: number): { bpm: number; raw: number } => {
    let best = { bpm, raw: -1 };
    for (let k = -8; k <= 8; k++) {
      const b2 = bpm * 1.0025 ** k;
      const r = sal(b2).s;
      if (r > best.raw) best = { bpm: b2, raw: r };
    }
    return best;
  };
  const base = refine(peaks[0]!.bpm);
  const levels: Array<{ bpm: number; raw: number }> = [];
  for (const mult of [1, 1.5, 2 / 3]) {
    for (let j = -3; j <= 3; j++) {
      const bpm = base.bpm * mult * 2 ** j;
      if (bpm < minBpm || bpm > maxBpm) continue;
      const lv = refine(bpm);
      if (mult !== 1 && lv.raw < 0.9 * base.raw) continue;
      levels.push(lv);
    }
  }
  const maxRaw = Math.max(...levels.map((l) => l.raw), 1e-9);
  const salExp = options.salienceExponent ?? 0.3;
  const cands = levels
    .filter((l) => l.raw >= 0.35 * maxRaw)
    .map((l) => ({ bpm: l.bpm, score: prior(l.bpm) * (l.raw / maxRaw) ** salExp }));
  if (!cands.length) cands.push({ bpm: base.bpm, score: 1 });
  cands.sort((a, b) => b.score - a.score);
  return {
    bpm: cands[0]!.bpm,
    candidates: cands.slice(0, 8).map((c) => ({ bpm: Math.round(c.bpm * 10) / 10, score: Math.round(c.score * 1000) / 1000 })),
  };
}

/** Ellis (2007) DP beat tracker on an onset envelope. Returns beat frames. */
export function dpBeatTrack(env: Float32Array, periodFrames: number, tightness = 400): number[] {
  const n = env.length;
  if (n < 2 || periodFrames < 2) return [];
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(periodFrames / 2);
  const hi = Math.round(periodFrames * 2);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let arg = -1;
    for (let d = lo; d <= hi && t - d >= 0; d++) {
      const pen = -tightness * Math.log(d / periodFrames) ** 2;
      const v = score[t - d]! + pen;
      if (v > best || arg < 0) {
        if (arg < 0 || v > best) {
          best = v;
          arg = t - d;
        }
      }
    }
    score[t] = env[t]! + (arg >= 0 ? Math.max(0, best) : 0);
    back[t] = arg >= 0 && best > 0 ? arg : -1;
  }
  // pick end: best score within the last period
  let end = n - 1;
  let bestEnd = -Infinity;
  for (let t = Math.max(0, n - Math.round(periodFrames)); t < n; t++) {
    if (score[t]! > bestEnd) {
      bestEnd = score[t]!;
      end = t;
    }
  }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]!) {
    beats.push(t);
    if (back[t]! < 0) break;
  }
  beats.reverse();
  // extend backwards to start with the period if the chain stopped early
  while (beats.length && beats[0]! - periodFrames >= 0) {
    const guess = Math.round(beats[0]! - periodFrames);
    let b = guess;
    let bv = -1;
    for (let k = -2; k <= 2; k++) {
      const j = guess + k;
      if (j >= 0 && j < n && env[j]! > bv) { bv = env[j]!; b = j; }
    }
    beats.unshift(b);
  }
  return beats;
}

/** Precise-mode beat tracking directly from audio samples. */
export function trackBeatsFromAudio(
  samples: Float32Array,
  sampleRate: number,
  options: AudioBeatOptions = {},
): AudioBeatResult {
  const env = computeOnsetEnvelopes(samples, sampleRate);
  if (env.full.length < env.rate * 3) {
    const bpm = options.bpmHint ?? 120;
    const beats: number[] = [];
    const dur = (samples.length / sampleRate) * 1000;
    for (let t = 0; t < dur; t += 60000 / bpm) beats.push(Math.round(t));
    return { bpm, beats: beats.length ? beats : [0], timeSig: '4/4', envRate: env.rate, candidates: [] };
  }
  const { bpm, candidates } = estimateTempoFromEnvelopes(env, options);
  const period = (60 / bpm) * env.rate;
  const combo = new Float32Array(env.full.length);
  for (let i = 0; i < combo.length; i++) combo[i] = env.full[i]! + 0.5 * env.low[i]!;
  const frames = dpBeatTrack(combo, period, options.tightness ?? 100);
  // frame t covers samples [t*hop, t*hop+N); onset sits ~ at frame centre
  const frameMs = 1000 / env.rate;
  const beats = frames.map((f) => Math.round(f * frameMs));
  // Report median local tempo (DP may drift)
  let reported = bpm;
  if (beats.length > 4) {
    const iois = beats.slice(1).map((b, i) => b - beats[i]!).sort((a, b) => a - b);
    reported = 60000 / iois[Math.floor(iois.length / 2)]!;
  }
  return {
    bpm: Math.round(reported * 10) / 10,
    beats: beats.length ? beats : [0],
    timeSig: '4/4',
    envRate: env.rate,
    candidates,
  };
}
