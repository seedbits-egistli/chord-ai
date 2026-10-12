import {
  averageChroma,
  computeChromaFrames,
  estimateTuningCents,
  normalizeL2,
  rmsEnergy,
} from './chroma.js';
import { trackBeats } from './beats.js';
import { detectKey, globalChromaFromFrames } from './key.js';
import { formatChord, parseChord, simplifyLabel } from './chordParse.js';
import { topKMatches, viterbiSmooth, type MatchContext } from './match.js';
import type { ChordEvent, ChordLabel, DetectOptions, DetectionResult } from './types.js';

/**
 * Full offline chord detection pipeline.
 * Audio stays in-memory; nothing is uploaded.
 */
export function detectChords(
  samples: Float32Array,
  sampleRate: number,
  options: DetectOptions = {},
): DetectionResult {
  const simplifyLevel = options.simplifyLevel ?? 0.45;
  const frameSize = options.frameSize ?? (sampleRate >= 44100 ? 8192 : 4096);
  const hopSize = options.hopSize ?? Math.floor(frameSize / 4);
  const suppressDrone = options.suppressDrone ?? true;

  const tuningCents = estimateTuningCents(samples, sampleRate, Math.min(8192, frameSize));
  const frames = computeChromaFrames(samples, sampleRate, frameSize, hopSize, tuningCents);
  if (frames.length === 0) {
    return {
      chords: [],
      key: 'C',
      bpm: 120,
      timeSig: '4/4',
      beats: [0],
      simplifyLevel,
    };
  }

  // Optional bass stem → replace per-frame bass chroma (blend when stem is weak)
  let bassWeight = 1;
  let weakBass = false;
  if (options.bassSamples && options.bassSamples.length > 0) {
    const ratio = rmsEnergy(options.bassSamples) / Math.max(1e-9, rmsEnergy(samples));
    weakBass = ratio < 0.15;
    bassWeight = weakBass ? Math.max(0.35, Math.min(0.55, ratio / 0.12)) : 1;
    const bassFrames = computeChromaFrames(
      options.bassSamples,
      sampleRate,
      frameSize,
      hopSize,
      tuningCents,
    );
    const n = Math.min(frames.length, bassFrames.length);
    for (let i = 0; i < n; i++) {
      if (weakBass) {
        const blended = new Float32Array(12);
        for (let p = 0; p < 12; p++) {
          // Prefer low-band mix chroma when UMX bass is guitar thumps only
          blended[p] = bassFrames[i]!.chroma[p]! * 0.3 + frames[i]!.bassChroma[p]! * 0.7;
        }
        normalizeL2(blended);
        frames[i]!.bassChroma = blended;
      } else {
        frames[i]!.bassChroma = bassFrames[i]!.chroma;
      }
    }
  }

  // Running-mean drone suppression (helps capo songs with ringing open strings)
  if (suppressDrone && frames.length > 8) {
    const mean = new Float32Array(12);
    const win = 24;
    const amount = weakBass ? 0.75 : 0.7;
    for (let i = 0; i < frames.length; i++) {
      mean.fill(0);
      let c = 0;
      const a = Math.max(0, i - win);
      const b = Math.min(frames.length, i + win);
      for (let j = a; j < b; j++) {
        for (let p = 0; p < 12; p++) mean[p]! += frames[j]!.chroma[p]!;
        c++;
      }
      for (let p = 0; p < 12; p++) {
        frames[i]!.chroma[p] = Math.max(0, frames[i]!.chroma[p]! - amount * (mean[p]! / c));
      }
      normalizeL2(frames[i]!.chroma);
    }
  }

  const gChroma = globalChromaFromFrames(frames);
  let key = detectKey(gChroma);

  const { bpm, beats, timeSig } = trackBeats(frames, sampleRate, {
    bpmHint: options.bpmHint,
  });

  const minWinMs = 260;
  const observations = [];
  for (let i = 0; i < beats.length; i++) {
    const startMs = beats[i]!;
    let endMs = i + 1 < beats.length ? beats[i + 1]! : startMs + 60000 / bpm;
    if (endMs - startMs < minWinMs) endMs = startMs + minWinMs;
    const { chroma, bassChroma, energy } = averageChroma(frames, startMs, endMs);
    const obsEnd = i + 1 < beats.length ? beats[i + 1]! : endMs;
    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, chroma[p]!);
    // Flat/noisy chroma: hold previous label (avoid random C)
    if (energy < 0.006 || peak < 0.38) {
      let hold: ChordLabel = { root: 0, quality: 'maj' };
      if (observations.length > 0) {
        const lastCand = observations[observations.length - 1]!.candidates[0];
        if (lastCand) hold = { ...lastCand.label };
      }
      observations.push({
        startMs,
        endMs: obsEnd,
        candidates: [{ label: hold, score: -0.2 }],
      });
      continue;
    }
    const candidates =
      options.bassSamples && weakBass
        ? topKMatches(chroma, bassChroma, simplifyLevel, 8, {
            keyPrior: key,
            bassWeight,
          } satisfies MatchContext)
        : topKMatches(chroma, bassChroma, simplifyLevel, 8, key);
    observations.push({ startMs, endMs: obsEnd, candidates });
  }

  const labels = viterbiSmooth(observations, 0.6 + (1 - simplifyLevel) * 0.12);

  for (let i = 1; i < labels.length - 1; i++) {
    const a = formatChord(labels[i - 1]!, false);
    const b = formatChord(labels[i]!, false);
    const c = formatChord(labels[i + 1]!, false);
    if (a === c && a !== b) labels[i] = labels[i - 1]!;
  }

  const chords: ChordEvent[] = [];
  for (let i = 0; i < labels.length; i++) {
    const chord = formatChord(labels[i]!, key);
    const startMs = observations[i]!.startMs;
    const endMs = observations[i]!.endMs;
    const conf = observations[i]!.candidates[0]?.score;
    if (conf !== undefined && conf < -0.5 && chords.length > 0) {
      chords[chords.length - 1]!.endMs = endMs;
      continue;
    }
    const last = chords[chords.length - 1];
    if (last && last.chord === chord) {
      last.endMs = endMs;
    } else {
      chords.push({ tMs: startMs, endMs, chord, beat: i, confidence: conf });
    }
  }

  key = estimateKeyFromChords(chords.map((c) => c.chord)) ?? key;
  for (const c of chords) {
    const p = parseChord(c.chord);
    if (p) c.chord = formatChord(p, key);
  }

  // Drop leading low-confidence guesses (noise floor / fade-in)
  while (
    chords.length > 1 &&
    (chords[0]!.confidence === undefined || chords[0]!.confidence < 0.35)
  ) {
    chords.shift();
  }

  return { chords, key, bpm, timeSig, beats, simplifyLevel };
}

function estimateKeyFromChords(chords: string[]): string | null {
  const hist = new Float32Array(12);
  for (const c of chords) {
    const p = parseChord(c);
    if (!p) continue;
    hist[p.root]! += 1;
    hist[(p.root + 7) % 12]! += 0.3;
  }
  let n = 0;
  for (let i = 0; i < 12; i++) n += hist[i]! * hist[i]!;
  n = Math.sqrt(n);
  if (n < 1e-6) return null;
  for (let i = 0; i < 12; i++) hist[i]! /= n;
  return detectKey(hist);
}

export function applySimplify(
  result: DetectionResult,
  simplifyLevel: number,
): DetectionResult {
  const chords = result.chords.map((c) => {
    const p = parseChord(c.chord);
    if (!p) return { ...c };
    const s = simplifyLabel(p, simplifyLevel);
    return { ...c, chord: formatChord(s, result.key) };
  });
  const merged: ChordEvent[] = [];
  for (const c of chords) {
    const last = merged[merged.length - 1];
    if (last && last.chord === c.chord) last.endMs = c.endMs;
    else merged.push({ ...c });
  }
  return { ...result, chords: merged, simplifyLevel };
}
