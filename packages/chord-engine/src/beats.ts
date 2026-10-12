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
