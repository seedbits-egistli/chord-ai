/**
 * Note-based chord inference for 精準模式 (precise mode).
 *
 * Inputs: Basic Pitch note events from accompaniment (other) and bass stems.
 * Per beat / half-bar: duration×velocity weighted pitch-class histogram,
 * lowest bass note as root/slash bass, persistent drone PC suppression,
 * key-aware Viterbi smoothing. Emits full quality vocabulary + slash chords.
 *
 * No staff notation — chords only.
 */

import { trackBeats } from './beats.js';
import {
  averageChroma,
  computeChromaFrames,
  estimateTuningCents,
  normalizeL2,
} from './chroma.js';
import { formatChord, parseChord, simplifyLabel } from './chordParse.js';
import { detectKey } from './key.js';
import { topKMatches, viterbiSmooth, type BeatObservation } from './match.js';
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
  /** Use half-bar windows (2 beats) instead of one beat. Default true. */
  halfBar?: boolean;
  /** Fraction of windows a PC must appear in to count as hard drone (default 0.7). */
  droneWindowFrac?: number;
  /**
   * Mix instrumental audio chroma into note chroma (0–1). Default 0 —
   * pure note-driven harmony; raise toward 0.3–0.4 to stabilize dense mixes.
   */
  audioChromaBlend?: number;
  /** Emit slash chords when bass ≠ root. Default true. */
  allowSlash?: boolean;
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

/**
 * Soft drone profile: mean pitch-class energy across windows.
 * Capo / open-string drones stay high in the mean; subtracting them
 * (rather than hard-zeroing PCs) preserves real chord roots that also
 * appear often (e.g. F and C in Hey Jude).
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
  // Root in bass — no slash
  if (rel === 0) return { root: label.root, quality: label.quality };
  // Common inversions / chord-tone bass only (avoid noisy slashes)
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
  const halfBar = options.halfBar !== false;
  const droneFrac = options.droneWindowFrac ?? 0.42;

  let bpm = options.bpmHint ?? 120;
  let beats: number[] = [];
  let timeSig = '4/4';
  let audioFrames: ReturnType<typeof computeChromaFrames> | null = null;
  const audioBlend = Math.min(1, Math.max(0, options.audioChromaBlend ?? 0));
  const allowSlash = options.allowSlash !== false;

  if (beatAudio && beatAudio.samples.length > 1024) {
    const frameSize = options.frameSize ?? (beatAudio.sampleRate >= 44100 ? 8192 : 4096);
    const hopSize = options.hopSize ?? Math.floor(frameSize / 4);
    const tuning = estimateTuningCents(beatAudio.samples, beatAudio.sampleRate, Math.min(8192, frameSize));
    const frames = computeChromaFrames(
      beatAudio.samples,
      beatAudio.sampleRate,
      frameSize,
      hopSize,
      tuning,
    );
    if (frames.length) {
      audioFrames = frames;
      const tracked = trackBeats(frames, beatAudio.sampleRate, { bpmHint: options.bpmHint });
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

  // Build analysis windows: beat or half-bar (2 beats)
  const windows: { startMs: number; endMs: number; startSec: number; endSec: number }[] = [];
  const step = halfBar ? 2 : 1;
  for (let i = 0; i < beats.length; i += step) {
    const startMs = beats[i]!;
    const endIdx = Math.min(beats.length - 1, i + step);
    let endMs = i + step < beats.length ? beats[endIdx]! : startMs + (60000 / bpm) * step;
    if (endMs - startMs < 200) endMs = startMs + 200;
    windows.push({
      startMs,
      endMs,
      startSec: startMs / 1000,
      endSec: endMs / 1000,
    });
  }

  const allNotes = accompanimentNotes.concat(bassNotes);
  const droneNotes = accompanimentNotes.length ? accompanimentNotes : allNotes;
  const droneMean = meanNoteChroma(droneNotes, windows);
  // Optional hard mask only for very persistent PCs (capo rings); soft mean always applied
  const hardDrones =
    options.suppressDrone === false
      ? new Set<number>()
      : findDronePcs(droneNotes, windows, Math.max(0.65, droneFrac));

  let key = estimateKeyFromNoteHist(allNotes.length ? allNotes : accompanimentNotes);

  const observations: BeatObservation[] = [];
  for (const w of windows) {
    let chroma = noteChroma(accompanimentNotes, w.startSec, w.endSec, hardDrones);
    // If accompaniment empty, fall back to all notes without hard mask
    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, chroma[p]!);
    if (peak < 0.05) {
      chroma = noteChroma(allNotes, w.startSec, w.endSec);
      peak = 0;
      for (let p = 0; p < 12; p++) peak = Math.max(peak, chroma[p]!);
    }
    if (options.suppressDrone !== false) {
      subtractDroneMean(chroma, droneMean, 0.55);
    }
    if (audioFrames && audioBlend > 0) {
      const ac = averageChroma(audioFrames, w.startMs, w.endMs).chroma;
      for (let p = 0; p < 12; p++) {
        chroma[p] = chroma[p]! * (1 - audioBlend) + ac[p]! * audioBlend;
      }
      normalizeL2(chroma);
    }
    peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, chroma[p]!);

    const bass = lowestBassPc(bassNotes, w.startSec, w.endSec);
    const bassChroma = new Float32Array(12);
    if (bass) {
      bassChroma[bass.pc] = 1;
    } else {
      // Soft bass prior from lowest accompaniment notes
      const lows = notesInWindow(accompanimentNotes, w.startSec, w.endSec)
        .filter((n) => n.midi < 55)
        .sort((a, b) => a.midi - b.midi);
      if (lows[0]) bassChroma[midiToPc(lows[0].midi)] = 1;
      else bassChroma.set(chroma);
    }
    normalizeL2(bassChroma);

    if (peak < 0.08) {
      const hold =
        observations.length > 0
          ? { ...observations[observations.length - 1]!.candidates[0]!.label }
          : ({ root: 0, quality: 'maj' } as ChordLabel);
      observations.push({
        startMs: w.startMs,
        endMs: w.endMs,
        candidates: [{ label: hold, score: -0.15 }],
      });
      continue;
    }

    const raw = topKMatches(chroma, bassChroma, simplifyLevel, 8, key);
    const candidates = raw.map((c) => {
      const withSlash = applyBassSlash(
        c.label,
        bass?.pc ?? null,
        bass?.weight ?? 0,
        allowSlash,
      );
      return {
        label: simplifyLabel(withSlash, simplifyLevel),
        score: c.score + (bass && bass.pc === c.label.root ? 0.04 : 0),
      };
    });
    observations.push({ startMs: w.startMs, endMs: w.endMs, candidates });
  }

  const labels = viterbiSmooth(observations, 0.72 + (1 - simplifyLevel) * 0.1);

  // Median-filter single-beat flips
  for (let i = 1; i < labels.length - 1; i++) {
    const a = formatChord(labels[i - 1]!, false);
    const b = formatChord(labels[i]!, false);
    const c = formatChord(labels[i + 1]!, false);
    if (a === c && a !== b) labels[i] = { ...labels[i - 1]! };
  }

  const chords: ChordEvent[] = [];
  for (let i = 0; i < labels.length; i++) {
    const chord = formatChord(labels[i]!, key);
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

  // Re-spell with key from chord roots
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

  return { chords, key, bpm, timeSig, beats, simplifyLevel };
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
  const instrumental = buildInstrumental(stems);
  const durationMs = (instrumental.length / stems.sampleRate) * 1000;
  return detectChordsFromNotes(accompanimentNotes, bassNotes, durationMs, options, {
    samples: instrumental,
    sampleRate: stems.sampleRate,
  });
}

/** Merge stereo stem to mono for transcription. */
export function stemToMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right || right === left) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}
