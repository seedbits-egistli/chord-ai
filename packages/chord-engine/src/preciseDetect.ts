/**
 * Note-based chord inference for 精準模式 (precise mode).
 *
 * Training-free pipeline (Mauch & Dixon 2010, independently implemented):
 * 1) Beat grid → harmonic-novelty downbeat phase (+ local re-phase)
 * 2) NNLS approximate-note-transcription chroma (treble + bass) from instrumental
 * 3) Fuse NNLS + Basic Pitch PC histogram (reliability-weighted) → emissions
 * 4) Metric-position HMM/Viterbi + key/drone/sus-aware template scoring
 *
 * No staff notation — chords only. No model training. Not derived from GPL Chordino.
 */

import { trackBeatsFromAudio } from './beats.js';
import {
  averageChroma,
  computeChromaFrames,
  estimateTuningCents,
  normalizeL2,
  rmsEnergy,
} from './chroma.js';
import { formatChord, parseChord, simplifyLabel } from './chordParse.js';
import {
  buildBeatChromas,
  estimateDownbeatFromBeatChromas,
} from './downbeat.js';
import { detectKey } from './key.js';
import {
  topKMatches,
  viterbiSmoothMetric,
  type BeatObservation,
  type MatchContext,
} from './match.js';
import { computeNnlsBeatChroma } from './nnlsChroma.js';
import { buildInstrumental, type SeparationStems } from './separate.js';
import type { ChordEvent, ChordLabel, DetectOptions, DetectionResult } from './types.js';

/** Portable note event (seconds) — matches Basic Pitch / neural-transcribe shape. */
export interface NoteEvent {
  time: number;
  duration: number;
  midi: number;
  velocity: number;
}

export interface PreciseDetectOptions extends DetectOptions {
  /**
   * If true (default), run beat-level metric HMM then merge identical labels.
   * If false, fall back to half-bar windows + non-metric Viterbi.
   */
  metricDecode?: boolean;
  /** Fraction of windows a PC must appear in to count as hard drone (default 0.7). */
  droneWindowFrac?: number;
  /**
   * Mix instrumental audio chroma into note chroma (0–1). Default 0 —
   * pure note-driven harmony; raise toward 0.3–0.4 to stabilize dense mixes.
   */
  audioChromaBlend?: number;
  /** Emit slash chords when bass ≠ root. Default true. */
  allowSlash?: boolean;
  /** Bass/other RMS ratio; low values trigger guitar-only root proxy. */
  bassEnergyRatio?: number;
  /** Re-estimate downbeat every N bars (0 = global only). Default 8. */
  downbeatChunkBars?: number;
  /** Enable NNLS chroma from instrumental (default true when beat audio present). */
  useNnls?: boolean;
  /** Weight of NNLS treble vs fused emission (0–1). Default 0.55. */
  nnlsWeight?: number;
  /** Soft-subtract scaled vocal stem from instrumental before NNLS (0–1). Default 0.25. */
  vocalResidual?: number;
  /** Optional mono vocal stem (same rate/length as beat audio) for leakage control. */
  vocalSamples?: Float32Array;
  /** Optional mono bass stem (same rate as beat audio) for per-beat bass reliability. */
  bassSamples?: Float32Array;
  /** Highest MIDI note accepted as a real bass-stem root (higher = leaked instrument). Default 52 (E3). */
  bassMaxMidi?: number;
  /** sus2/sus4/7sus4 must beat the best maj/min candidate by this score margin. Default 0.03. */
  susMargin?: number;
  /** Beats quieter than this fraction of the loud (90th pct) beat level are output as N (0 = off). Default 0 — 0.12 removed the Wonderwall pre-roll but cost Stand By Me -1.9. */
  silenceGate?: number;
  /** Weight of the song-level chord-vocabulary prior on quiet beats (0 = off). Default 0.3. */
  vocabPrior?: number;
  /** Slash bass needs the bass note to sustain this fraction of the beat. Default 0.45. */
  slashMinSustain?: number;
  /** @deprecated Prefer metricDecode; kept for callers that passed halfBar. */
  halfBar?: boolean;
}

function midiToPc(midi: number): number {
  return ((Math.round(midi) % 12) + 12) % 12;
}

function notesInWindow(
  notes: NoteEvent[],
  startSec: number,
  endSec: number,
): NoteEvent[] {
  const out: NoteEvent[] = [];
  for (const n of notes) {
    const n0 = n.time;
    const n1 = n.time + Math.max(0.01, n.duration);
    if (n1 > startSec && n0 < endSec) out.push(n);
  }
  return out;
}

/** Duration × velocity weighted pitch-class histogram (L2-normalized). */
export function noteChroma(
  notes: NoteEvent[],
  startSec: number,
  endSec: number,
  suppressPcs?: Set<number>,
): Float32Array {
  const chroma = new Float32Array(12);
  const win = Math.max(1e-3, endSec - startSec);
  for (const n of notes) {
    const n0 = n.time;
    const n1 = n.time + Math.max(0.01, n.duration);
    const overlap = Math.min(n1, endSec) - Math.max(n0, startSec);
    if (overlap <= 0) continue;
    const pc = midiToPc(n.midi);
    if (suppressPcs?.has(pc)) continue;
    const w = overlap * (0.25 + 0.75 * Math.min(1, Math.max(0, n.velocity)));
    chroma[pc]! += w / win;
  }
  normalizeL2(chroma);
  return chroma;
}

/** Lowest MIDI in window (bass root / inversion cue). */
export function lowestBassPc(
  bassNotes: NoteEvent[],
  startSec: number,
  endSec: number,
): { pc: number; midi: number; weight: number } | null {
  const hits = notesInWindow(bassNotes, startSec, endSec);
  if (!hits.length) return null;
  let best = hits[0]!;
  for (const n of hits) {
    if (n.midi < best.midi - 0.25) best = n;
    else if (Math.abs(n.midi - best.midi) < 0.25 && n.velocity > best.velocity) best = n;
  }
  const n0 = best.time;
  const n1 = best.time + Math.max(0.01, best.duration);
  const overlap = Math.min(n1, endSec) - Math.max(n0, startSec);
  return {
    pc: midiToPc(best.midi),
    midi: best.midi,
    weight: Math.max(0, overlap) * (0.25 + 0.75 * best.velocity),
  };
}

/** Per-window RMS of a mono signal. */
function windowRms(x: Float32Array, sr: number, windows: Array<{ startMs: number; endMs: number }>): Float32Array {
  const out = new Float32Array(windows.length);
  for (let i = 0; i < windows.length; i++) {
    const a = Math.max(0, Math.floor((windows[i]!.startMs / 1000) * sr));
    const b = Math.min(x.length, Math.floor((windows[i]!.endMs / 1000) * sr));
    let s = 0;
    for (let k = a; k < b; k++) s += x[k]! * x[k]!;
    out[i] = b > a ? Math.sqrt(s / (b - a)) : 0;
  }
  return out;
}

/**
 * Narrow-register / re-entrant instrument detector (ukulele, high-capo guitar):
 * accompaniment notes around the window have no low register and a small span,
 * so their "lowest note" says little about the root.
 */
export function isNarrowRegister(notes: NoteEvent[], startSec: number, endSec: number): boolean {
  const hits = notesInWindow(notes, startSec, endSec);
  if (hits.length < 3) return false;
  let lo = Infinity;
  let hi = -Infinity;
  for (const n of hits) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  return lo >= 55 && hi - lo <= 15;
}

/**
 * Lowest sustained pitch-class from accompaniment (weak-bass / guitar-only proxy).
 */
export function lowestSustainedPc(
  notes: NoteEvent[],
  startSec: number,
  endSec: number,
  maxMidi = 58,
): { pc: number; midi: number; weight: number } | null {
  const hits = notesInWindow(notes, startSec, endSec).filter((n) => n.midi <= maxMidi);
  if (!hits.length) return null;
  const pcWeight = new Float32Array(12);
  const pcMidi = new Float32Array(12);
  const pcMidiW = new Float32Array(12);
  const win = Math.max(1e-3, endSec - startSec);
  for (const n of hits) {
    const n0 = n.time;
    const n1 = n.time + Math.max(0.01, n.duration);
    const overlap = Math.min(n1, endSec) - Math.max(n0, startSec);
    if (overlap < 0.05) continue;
    const pc = midiToPc(n.midi);
    const lowBias = 1.15 - Math.min(1, Math.max(0, (n.midi - 36) / 28)) * 0.45;
    const w =
      (overlap / win) *
      (0.3 + 0.7 * n.velocity) *
      lowBias *
      (0.5 + Math.min(1, n.duration));
    pcWeight[pc]! += w;
    pcMidi[pc]! += n.midi * w;
    pcMidiW[pc]! += w;
  }
  let bestPc = -1;
  let bestW = 0;
  for (let p = 0; p < 12; p++) {
    if (pcWeight[p]! > bestW) {
      bestW = pcWeight[p]!;
      bestPc = p;
    }
  }
  if (bestPc < 0 || bestW < 0.02) return null;
  return {
    pc: bestPc,
    midi: pcMidiW[bestPc]! > 0 ? pcMidi[bestPc]! / pcMidiW[bestPc]! : 48,
    weight: bestW,
  };
}

/**
 * Soft drone profile: mean pitch-class energy across windows.
 */
export function meanNoteChroma(
  notes: NoteEvent[],
  windows: { startSec: number; endSec: number }[],
): Float32Array {
  const mean = new Float32Array(12);
  if (!windows.length) return mean;
  let n = 0;
  for (const w of windows) {
    const ch = noteChroma(notes, w.startSec, w.endSec);
    let energy = 0;
    for (let p = 0; p < 12; p++) energy += ch[p]!;
    if (energy < 1e-6) continue;
    for (let p = 0; p < 12; p++) mean[p]! += ch[p]!;
    n++;
  }
  if (n > 0) {
    for (let p = 0; p < 12; p++) mean[p]! /= n;
  }
  return mean;
}

/** Hard drone set for tests / diagnostics — PCs strong in ≥frac of windows. */
export function findDronePcs(
  notes: NoteEvent[],
  windows: { startSec: number; endSec: number }[],
  frac = 0.7,
): Set<number> {
  if (windows.length < 8) return new Set();
  const present = new Float32Array(12);
  for (const w of windows) {
    const ch = noteChroma(notes, w.startSec, w.endSec);
    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, ch[p]!);
    if (peak < 1e-6) continue;
    for (let p = 0; p < 12; p++) {
      if (ch[p]! >= peak * 0.65) present[p]! += 1;
    }
  }
  const drones = new Set<number>();
  const need = windows.length * frac;
  for (let p = 0; p < 12; p++) {
    if (present[p]! >= need) drones.add(p);
  }
  if (drones.size > 2) {
    const ranked = [...drones].sort((a, b) => present[b]! - present[a]!);
    return new Set(ranked.slice(0, 2));
  }
  return drones;
}

function subtractDroneMean(chroma: Float32Array, mean: Float32Array, amount = 0.65): void {
  for (let p = 0; p < 12; p++) {
    chroma[p] = Math.max(0, chroma[p]! - amount * mean[p]!);
  }
  normalizeL2(chroma);
}

function applyBassSlash(
  label: ChordLabel,
  bassPc: number | null,
  bassWeight: number,
  allowSlash: boolean,
): ChordLabel {
  if (!allowSlash || bassPc === null || bassWeight < 0.04) {
    return { root: label.root, quality: label.quality };
  }
  const rel = (bassPc - label.root + 12) % 12;
  if (rel === 0) return { root: label.root, quality: label.quality };
  if (rel === 3 || rel === 4 || rel === 7 || rel === 10) {
    return { root: label.root, quality: label.quality, bass: bassPc };
  }
  return { root: label.root, quality: label.quality };
}

function estimateKeyFromNoteHist(notes: NoteEvent[]): string {
  const hist = new Float32Array(12);
  for (const n of notes) {
    hist[midiToPc(n.midi)]! += n.duration * (0.3 + 0.7 * n.velocity);
  }
  normalizeL2(hist);
  return detectKey(hist);
}

function beatWindows(
  beats: number[],
  bpm: number,
  durationMs: number,
): { startMs: number; endMs: number; startSec: number; endSec: number }[] {
  const beatMs = 60000 / bpm;
  const windows: { startMs: number; endMs: number; startSec: number; endSec: number }[] = [];
  for (let i = 0; i < beats.length; i++) {
    const startMs = beats[i]!;
    let endMs = i + 1 < beats.length ? beats[i + 1]! : Math.min(durationMs, startMs + beatMs);
    if (endMs - startMs < 120) endMs = startMs + 120;
    windows.push({
      startMs,
      endMs,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
    });
  }
  return windows;
}

/** Soft-subtract vocal residual from instrumental (clip not applied — signed ok for analysis). */
export function subtractVocalResidual(
  instrumental: Float32Array,
  vocals: Float32Array,
  amount: number,
): Float32Array {
  const n = Math.min(instrumental.length, vocals.length);
  const out = new Float32Array(n);
  const a = Math.max(0, Math.min(1, amount));
  for (let i = 0; i < n; i++) {
    out[i] = instrumental[i]! - a * vocals[i]!;
  }
  return out;
}

/** RMS in [startSec, endSec) for mono samples. */
function rmsInRange(
  samples: Float32Array,
  sampleRate: number,
  startSec: number,
  endSec: number,
): number {
  const i0 = Math.max(0, Math.floor(startSec * sampleRate));
  const i1 = Math.min(samples.length, Math.floor(endSec * sampleRate));
  if (i1 <= i0) return 0;
  let s = 0;
  for (let i = i0; i < i1; i++) s += samples[i]! * samples[i]!;
  return Math.sqrt(s / (i1 - i0));
}

/**
 * Down-weight Basic Pitch notes whose windows are dominated by vocal energy
 * (likely leakage into `other`).
 */
export function filterVocalLeakNotes(
  notes: NoteEvent[],
  other: Float32Array,
  vocals: Float32Array,
  sampleRate: number,
): NoteEvent[] {
  return notes
    .map((n) => {
      const t0 = n.time;
      const t1 = n.time + Math.max(0.01, n.duration);
      const vR = rmsInRange(vocals, sampleRate, t0, t1);
      const oR = rmsInRange(other, sampleRate, t0, t1);
      let vel = n.velocity;
      // Only strongly vocal-dominated windows (avoid hurting dense pop mixes)
      if (vR > 1e-6 && vR > oR * 1.8) {
        const ratio = vR / Math.max(1e-6, oR);
        vel *= Math.max(0.4, 1 / (0.35 + 0.4 * ratio));
      }
      return { ...n, velocity: vel };
    })
    .filter((n) => n.velocity >= 0.05);
}

/** Per-PC drone strength (high mean, low variance across beats) ∈ [0,1]. */
function computeDroneStrength(chromas: Float32Array[]): Float32Array {
  const strength = new Float32Array(12);
  if (chromas.length < 4) return strength;
  for (let p = 0; p < 12; p++) {
    let mean = 0;
    for (const c of chromas) mean += c[p]!;
    mean /= chromas.length;
    let var_ = 0;
    for (const c of chromas) {
      const d = c[p]! - mean;
      var_ += d * d;
    }
    var_ /= chromas.length;
    const s = mean / (mean + Math.sqrt(var_) + 0.08);
    strength[p] = Math.max(0, Math.min(1, s * (mean > 0.12 ? 1 : 0.5)));
  }
  return strength;
}

/** Per-beat, per-PC novelty vs previous beat chroma. */
function computeLocalNovelty(chromas: Float32Array[]): Float32Array[] {
  return chromas.map((c, i) => {
    const nov = new Float32Array(12);
    if (i === 0) {
      nov.fill(0.5);
      return nov;
    }
    const prev = chromas[i - 1]!;
    for (let p = 0; p < 12; p++) {
      const d = Math.abs(c[p]! - prev[p]!);
      nov[p] = Math.max(0, Math.min(1, d * 2.5));
    }
    return nov;
  });
}

/**
 * Chord detection from transcribed notes + optional stem audio for beat tracking.
 */
export function detectChordsFromNotes(
  accompanimentNotes: NoteEvent[],
  bassNotes: NoteEvent[],
  durationMs: number,
  options: PreciseDetectOptions = {},
  beatAudio?: { samples: Float32Array; sampleRate: number },
): DetectionResult {
  const simplifyLevel = options.simplifyLevel ?? 0.45;
  const metricDecode = options.metricDecode !== false;
  const droneFrac = options.droneWindowFrac ?? 0.42;
  const bassEnergyRatioEarly = options.bassEnergyRatio ?? 1;
  const weakBassEarly = bassEnergyRatioEarly < 0.2;
  // Auto-enable NNLS on weak-bass / guitar-drone mixes (e.g. Wonderwall).
  // Strong-bass pop (Hey Jude) stays on the proven Basic Pitch path unless forced.
  const useNnls =
    options.useNnls === true || (options.useNnls !== false && weakBassEarly);
  const nnlsWeight = Math.min(1, Math.max(0, options.nnlsWeight ?? (weakBassEarly ? 0.55 : 0.25)));

  let bpm = options.bpmHint ?? 120;
  let beats: number[] = [];
  let timeSig = '4/4';
  let audioFrames: ReturnType<typeof computeChromaFrames> | null = null;
  const audioBlend = Math.min(1, Math.max(0, options.audioChromaBlend ?? 0));
  const allowSlash = options.allowSlash !== false;
  let nnlsAnalysisMs = 0;

  if (beatAudio && beatAudio.samples.length > 1024) {
    const frameSize = options.frameSize ?? (beatAudio.sampleRate >= 44100 ? 8192 : 4096);
    const hopSize = options.hopSize ?? Math.floor(frameSize / 4);
    const tuning = estimateTuningCents(
      beatAudio.samples,
      beatAudio.sampleRate,
      Math.min(8192, frameSize),
    );
    const frames = computeChromaFrames(
      beatAudio.samples,
      beatAudio.sampleRate,
      frameSize,
      hopSize,
      tuning,
    );
    if (frames.length) {
      audioFrames = frames;
      const tracked = trackBeatsFromAudio(beatAudio.samples, beatAudio.sampleRate, {
        bpmHint: options.bpmHint,
      });
      bpm = tracked.bpm;
      beats = tracked.beats;
      timeSig = tracked.timeSig;
    }
  }

  if (beats.length < 2) {
    const beatMs = 60000 / bpm;
    beats = [];
    for (let t = 0; t < durationMs; t += beatMs) beats.push(t);
  }

  const windows = beatWindows(beats, bpm, durationMs);
  const allNotes = accompanimentNotes.concat(bassNotes);
  const droneNotes = accompanimentNotes.length ? accompanimentNotes : allNotes;

  let nnlsTreble: (Float32Array | null)[] = windows.map(() => null);
  let nnlsBassArr: (Float32Array | null)[] = windows.map(() => null);
  if (useNnls && beatAudio && beatAudio.samples.length > 1024) {
    const nnls = computeNnlsBeatChroma(
      beatAudio.samples,
      beatAudio.sampleRate,
      beats,
      durationMs,
      { maxFrames: 360 },
    );
    nnlsAnalysisMs = nnls.analysisMs;
    for (let i = 0; i < Math.min(windows.length, nnls.beats.length); i++) {
      nnlsTreble[i] = nnls.beats[i]!.treble;
      nnlsBassArr[i] = nnls.beats[i]!.bass;
    }
  }

  // Downbeat from note chromas when available (NNLS-only on empty windows)
  const beatChromas = buildBeatChromas(windows.length, (i) => {
    const w = windows[i]!;
    let ch = noteChroma(accompanimentNotes, w.startSec, w.endSec);
    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, ch[p]!);
    if (peak < 0.05 && nnlsTreble[i]) return nnlsTreble[i]!;
    if (peak < 0.05) ch = noteChroma(allNotes, w.startSec, w.endSec);
    return ch;
  });

  const downbeat = estimateDownbeatFromBeatChromas(beatChromas, {
    beatsPerBar: 4,
    chunkBars: options.downbeatChunkBars ?? 8,
  });

  const droneMean = meanNoteChroma(droneNotes, windows);
  const hardDrones =
    options.suppressDrone === false
      ? new Set<number>()
      : findDronePcs(droneNotes, windows, Math.max(0.65, droneFrac));

  // Per-beat bass reliability: the bass stem may be silent in intros or carry
  // leaked guitar/ukulele (Wonderwall, Riptide intros). A beat's bass is
  // trusted only when the stem is locally loud relative to its own typical level.
  const bassMaxMidi = options.bassMaxMidi ?? 52;
  let localBassOk: boolean[] = windows.map(() => true);
  if (options.bassSamples && beatAudio) {
    const rms = windowRms(options.bassSamples, beatAudio.sampleRate, windows);
    const sorted = Array.from(rms).sort((a, b) => a - b);
    const ref = sorted[Math.floor(sorted.length * 0.75)] ?? 0;
    localBassOk = Array.from(rms).map((r) => ref > 0 && r >= 0.15 * ref);
  }

  const droneStrength = computeDroneStrength(beatChromas);
  const localNovelty = computeLocalNovelty(beatChromas);

  let key = estimateKeyFromNoteHist(allNotes.length ? allNotes : accompanimentNotes);

  const bassEnergyRatio = options.bassEnergyRatio ?? 1;
  const weakBass = bassEnergyRatio < 0.15;
  const keyConfidence = weakBass ? 0.5 : 0.65;

  const observations: BeatObservation[] = [];
  for (let bi = 0; bi < windows.length; bi++) {
    const w = windows[bi]!;
    let noteCh = noteChroma(accompanimentNotes, w.startSec, w.endSec, hardDrones);
    let notePeak = 0;
    for (let p = 0; p < 12; p++) notePeak = Math.max(notePeak, noteCh[p]!);
    const noteCount = notesInWindow(accompanimentNotes, w.startSec, w.endSec).length;
    const accompEmpty = notePeak < 0.05 || noteCount < 2;

    const bpReliability = accompEmpty
      ? 0
      : Math.min(1, (noteCount / 8) * 0.55 + notePeak * 0.45);

    let chroma = new Float32Array(12);
    const nt = nnlsTreble[bi];
    if (nt && nnlsWeight > 0) {
      // High BP reliability → mostly notes; sparse/empty → mostly NNLS
      const nnW = Math.min(0.85, nnlsWeight * (1.15 - 0.95 * bpReliability));
      const bpW = Math.max(0, 1 - nnW) * (bpReliability > 0.05 ? 1 : 0);
      if (bpW > 0.08) {
        for (let p = 0; p < 12; p++) chroma[p] = nnW * nt[p]! + bpW * noteCh[p]!;
        normalizeL2(chroma);
      } else {
        chroma.set(nt);
        normalizeL2(chroma);
      }
    } else if (!accompEmpty) {
      chroma.set(noteCh);
      if (options.suppressDrone !== false) {
        subtractDroneMean(chroma, droneMean, weakBass ? 0.62 : 0.55);
      }
    } else if (audioFrames) {
      chroma.set(averageChroma(audioFrames, w.startMs, w.endMs).chroma);
      normalizeL2(chroma);
    } else {
      chroma.set(noteChroma(allNotes, w.startSec, w.endSec));
    }

    if (audioFrames && audioBlend > 0 && bpReliability > 0.2) {
      const ac = averageChroma(audioFrames, w.startMs, w.endMs).chroma;
      for (let p = 0; p < 12; p++) {
        chroma[p] = chroma[p]! * (1 - audioBlend) + ac[p]! * audioBlend;
      }
      normalizeL2(chroma);
    }

    // Soft drone discount on weak-bass / NNLS paths only
    if (options.suppressDrone !== false && (weakBass || useNnls) && bpReliability < 0.75) {
      const amt = 0.35 + 0.25 * (1 - bpReliability);
      for (let p = 0; p < 12; p++) {
        const d = droneStrength[p]!;
        const nov = localNovelty[bi]![p]!;
        const keep = nov > 0.4 ? 0.2 : 1;
        chroma[p] = Math.max(0, chroma[p]! - amt * d * keep * droneMean[p]!);
      }
      normalizeL2(chroma);
    }

    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, chroma[p]!);
    const sparse = peak < 0.08 && !nt;

    const rawBassHit = lowestBassPc(bassNotes, w.startSec, w.endSec);
    const bassHit =
      rawBassHit && rawBassHit.midi <= bassMaxMidi && localBassOk[bi] ? rawBassHit : null;
    // weak bass for this beat: globally weak stem, or no trustworthy bass here
    const beatWeakBass = weakBass || !bassHit;
    const ctxStart = Math.max(0, w.startSec - 2 * (w.endSec - w.startSec));
    const ctxEnd = w.endSec + 2 * (w.endSec - w.startSec);
    const narrow = isNarrowRegister(accompanimentNotes, ctxStart, ctxEnd);
    const proxy = lowestSustainedPc(accompanimentNotes, w.startSec, w.endSec, 58);
    // lowest sustained instrument note = strong-but-not-absolute root evidence
    const lowW = narrow ? 0.15 : 0.6;
    const bassChroma = new Float32Array(12);
    const nb = nnlsBassArr[bi];
    if (bassHit && !weakBass) {
      // Strong bass stem: trust Basic Pitch bass (protects Hey Jude roots)
      bassChroma[bassHit.pc] = 1;
      if (nb) {
        for (let p = 0; p < 12; p++) bassChroma[p]! += 0.25 * nb[p]!;
      }
    } else if (nb && nnlsWeight > 0.2) {
      bassChroma.set(nb);
      if (bassHit) bassChroma[bassHit.pc]! += 0.35;
      else if (proxy) bassChroma[proxy.pc]! += 0.4 * lowW;
    } else if (bassHit) {
      bassChroma[bassHit.pc] = 1;
    } else {
      // no usable bass: blend lowest sustained note with treble chroma
      for (let p = 0; p < 12; p++) bassChroma[p] = (1 - lowW) * chroma[p]!;
      if (proxy) bassChroma[proxy.pc]! += lowW;
    }
    normalizeL2(bassChroma);

    if (sparse) {
      let hold: ChordLabel;
      if (observations.length > 0) {
        hold = { ...observations[observations.length - 1]!.candidates[0]!.label };
      } else {
        const isMinor = key.endsWith('m');
        const p = parseChord(key);
        hold = { root: p?.root ?? 0, quality: isMinor ? 'min' : 'maj' };
      }
      observations.push({
        startMs: w.startMs,
        endMs: w.endMs,
        candidates: [{ label: hold, score: -0.2 }],
      });
      continue;
    }

    const matchCtx: MatchContext = {
      keyPrior: key,
      keyConfidence,
      bassWeight: weakBass ? 0.55 : beatWeakBass ? (narrow ? 0.3 : 0.6) : 1,
      extendedHarmony: weakBass || useNnls,
      droneStrength: weakBass || useNnls ? droneStrength : undefined,
      localNovelty: weakBass || useNnls ? localNovelty[bi] : undefined,
    };
    const raw = topKMatches(chroma, bassChroma, simplifyLevel, 8, matchCtx);
    // sus chords must beat the best plain triad by a margin (shared-tone
    // smearing from ringing strings / previous chord easily fakes sus2/sus4)
    const susMargin = options.susMargin ?? 0.03;
    let bestTriad = -Infinity;
    for (const c of raw) {
      if (c.label.quality === 'maj' || c.label.quality === 'min') bestTriad = Math.max(bestTriad, c.score);
    }
    const winSec = Math.max(1e-3, w.endSec - w.startSec);
    // slash only with strong, sustained bass in bass register
    const slashOk =
      allowSlash && !weakBass && !!bassHit && bassHit.weight >= (options.slashMinSustain ?? 0.45) * winSec;
    const candidates = raw.map((c) => {
      const q = c.label.quality;
      const isSus = q === 'sus2' || q === 'sus4' || q === '7sus4';
      const susPenalty = isSus && c.score < bestTriad + susMargin ? susMargin : 0;
      const withSlash = applyBassSlash(
        c.label,
        slashOk ? bassHit!.pc : null,
        slashOk ? bassHit!.weight : 0,
        slashOk,
      );
      return {
        label: simplifyLabel(withSlash, simplifyLevel),
        score: c.score - susPenalty + (bassHit && bassHit.pc === c.label.root ? 0.04 : 0),
      };
    });
    observations.push({ startMs: w.startMs, endMs: w.endMs, candidates });
  }

  const decode = (obs: BeatObservation[]) =>
    metricDecode
      ? viterbiSmoothMetric(obs, downbeat.beatInBar, {
          selfBias: 0.58,
          sameRootBias: 0.2,
          changeCost: [-0.03, -0.3, -0.11, -0.27],
        })
      : viterbiSmoothMetric(
          obs,
          obs.map(() => 0),
          { selfBias: 0.72 + (1 - simplifyLevel) * 0.1, changeCost: [-0.12, -0.12, -0.12, -0.12] },
        );

  // Beat loudness of the instrumental (silence gate + vocabulary confidence)
  const beatRms = beatAudio ? windowRms(beatAudio.samples, beatAudio.sampleRate, windows) : null;
  let loudRef = 0;
  if (beatRms) {
    const sorted = Array.from(beatRms).sort((x, y) => x - y);
    loudRef = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  }
  const silenceGate = options.silenceGate ?? 0;
  // Silence gate on the full mix (instrumental + vocals): a vocal-led intro
  // with quiet accompaniment is music; a near-silent lead-in is not.
  let mixRms: Float32Array | null = null;
  let mixRef = 0;
  if (beatAudio) {
    const v = options.vocalSamples;
    const mix = new Float32Array(beatAudio.samples.length);
    for (let i = 0; i < mix.length; i++) mix[i] = beatAudio.samples[i]! + (v && i < v.length ? v[i]! : 0);
    mixRms = windowRms(mix, beatAudio.sampleRate, windows);
    const sorted = Array.from(mixRms).sort((x, y) => x - y);
    mixRef = sorted[Math.floor(sorted.length * 0.9)] ?? 0;
  }
  const silent = windows.map((_, i) => !!mixRms && mixRef > 0 && mixRms[i]! < silenceGate * mixRef);

  let labels = decode(observations);

  // Song-level vocabulary prior: chords decoded on the loud, confident body of
  // the song become a soft prior for quieter / sparser passages (intros,
  // breakdowns) whose evidence is ambiguous. Only re-ranks existing candidates.
  const vocabWeight = options.vocabPrior ?? 0.3;
  if (vocabWeight > 0 && beatRms && loudRef > 0 && labels.length > 8) {
    const vocab = new Map<string, number>();
    let tot = 0;
    for (let i = 0; i < labels.length; i++) {
      const rel = beatRms[i]! / loudRef;
      if (rel < 0.5 || silent[i]) continue;
      const k = `${labels[i]!.root}:${labels[i]!.quality}`;
      vocab.set(k, (vocab.get(k) ?? 0) + 1);
      tot++;
    }
    if (tot >= 8) {
      let maxShare = 0;
      for (const v of vocab.values()) maxShare = Math.max(maxShare, v / tot);
      const adjusted: BeatObservation[] = observations.map((o, i) => {
        const rel = Math.min(1, beatRms[i]! / loudRef);
        // only clearly quiet passages (<25% of loud level) lean on the song vocabulary
        const w = vocabWeight * Math.max(0, 1 - rel / 0.25);
        if (w <= 0) return o;
        return {
          ...o,
          candidates: o.candidates.map((c) => {
            const share = (vocab.get(`${c.label.root}:${c.label.quality}`) ?? 0) / tot;
            return { ...c, score: c.score + w * (share / Math.max(1e-6, maxShare)) };
          }),
        };
      });
      labels = decode(adjusted);
    }
  }

  for (let i = 1; i < labels.length - 1; i++) {
    const a = formatChord(labels[i - 1]!, false);
    const b = formatChord(labels[i]!, false);
    const c = formatChord(labels[i + 1]!, false);
    if (a === c && a !== b) labels[i] = { ...labels[i - 1]! };
  }

  const chords: ChordEvent[] = [];
  for (let i = 0; i < labels.length; i++) {
    const chord = silent[i] ? 'N' : formatChord(labels[i]!, key);
    const startMs = observations[i]!.startMs;
    const endMs = observations[i]!.endMs;
    const conf = observations[i]!.candidates[0]?.score;
    const last = chords[chords.length - 1];
    if (last && last.chord === chord) {
      last.endMs = endMs;
    } else {
      chords.push({ tMs: startMs, endMs, chord, beat: i, confidence: conf });
    }
  }

  const hist = new Float32Array(12);
  for (const c of chords) {
    const p = parseChord(c.chord);
    if (p) {
      hist[p.root]! += 1;
      hist[(p.root + 7) % 12]! += 0.35;
    }
  }
  normalizeL2(hist);
  key = detectKey(hist);
  for (const c of chords) {
    const p = parseChord(c.chord);
    if (p) c.chord = formatChord(p, key);
  }

  return {
    chords,
    key,
    bpm,
    timeSig,
    beats,
    simplifyLevel,
    downbeatPhase: downbeat.phase,
    beatInBar: downbeat.beatInBar,
    nnlsAnalysisMs,
  };
}

/**
 * Precise path from separated stems + note lists (browser / Node).
 */
export function detectChordsPreciseFromStems(
  stems: SeparationStems,
  accompanimentNotes: NoteEvent[],
  bassNotes: NoteEvent[],
  options: PreciseDetectOptions = {},
): DetectionResult {
  const vocals = stemToMono(stems.vocals.left, stems.vocals.right);
  const other = stemToMono(stems.other.left, stems.other.right);
  const bass = stemToMono(stems.bass.left, stems.bass.right);
  const bassEnergyRatio =
    options.bassEnergyRatio ?? rmsEnergy(bass) / Math.max(1e-9, rmsEnergy(other));
  const weakBass = bassEnergyRatio < 0.2;
  // Vocal residual / leak filter only on weak-bass paths (guitar mixes)
  const vocalResidual =
    options.vocalResidual ?? (weakBass ? 0.22 : 0);
  let instrumental = buildInstrumental(stems);
  if (vocalResidual > 0) {
    instrumental = subtractVocalResidual(instrumental, vocals, vocalResidual);
    let peak = 1e-6;
    for (let i = 0; i < instrumental.length; i++) peak = Math.max(peak, Math.abs(instrumental[i]!));
    const g = Math.min(1, 0.95 / peak);
    for (let i = 0; i < instrumental.length; i++) instrumental[i]! *= g;
  }
  const durationMs = (instrumental.length / stems.sampleRate) * 1000;
  const filteredOther = weakBass
    ? filterVocalLeakNotes(accompanimentNotes, other, vocals, stems.sampleRate)
    : accompanimentNotes;
  return detectChordsFromNotes(
    filteredOther,
    bassNotes,
    durationMs,
    {
      ...options,
      bassEnergyRatio,
      vocalSamples: vocals,
      bassSamples: bass,
      useNnls: options.useNnls === true || (options.useNnls !== false && weakBass),
    },
    {
      samples: instrumental,
      sampleRate: stems.sampleRate,
    },
  );
}

/** Merge stereo stem to mono for transcription. */
export function stemToMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right || right === left) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}
