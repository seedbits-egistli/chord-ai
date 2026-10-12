import { parseChord } from './chordParse.js';
import { QUALITY_INTERVALS } from './templates.js';
import type { ReferenceSegment, SongFixture } from './types.js';

export interface SynthOptions {
  sampleRate?: number;
  /** seconds of silence / pad at end */
  tailSec?: number;
  /** 'piano' additive or 'guitar' plucked-ish */
  timbre?: 'piano' | 'guitar';
}

/**
 * Synthesize mono PCM from a chord timeline (additive harmonics).
 * Used for validation — no copyrighted recordings required.
 */
export function synthesizeChordProgression(
  segments: ReferenceSegment[],
  bpm: number,
  options: SynthOptions = {},
): { samples: Float32Array; sampleRate: number } {
  const sampleRate = options.sampleRate ?? 22050;
  const timbre = options.timbre ?? 'guitar';
  const beatSec = 60 / bpm;
  const totalBeats = segments.reduce((m, s) => Math.max(m, s.endBeat), 0);
  const durationSec = totalBeats * beatSec + (options.tailSec ?? 0.25);
  const n = Math.ceil(durationSec * sampleRate);
  const samples = new Float32Array(n);

  for (const seg of segments) {
    const freqs = chordFrequencies(seg.chord);
    const start = Math.floor(seg.startBeat * beatSec * sampleRate);
    const end = Math.min(n, Math.floor(seg.endBeat * beatSec * sampleRate));
    const len = end - start;
    if (len <= 0 || freqs.length === 0) continue;

    for (let i = 0; i < len; i++) {
      const t = i / sampleRate;
      const env = envelope(i, len, timbre);
      let v = 0;
      for (let h = 0; h < freqs.length; h++) {
        const f = freqs[h]!;
        const harm =
          timbre === 'guitar'
            ? Math.sin(2 * Math.PI * f * t) * Math.exp(-1.8 * t) +
              0.35 * Math.sin(2 * Math.PI * f * 2 * t) * Math.exp(-2.5 * t) +
              0.15 * Math.sin(2 * Math.PI * f * 3 * t) * Math.exp(-3.2 * t)
            : Math.sin(2 * Math.PI * f * t) +
              0.45 * Math.sin(2 * Math.PI * f * 2 * t) +
              0.2 * Math.sin(2 * Math.PI * f * 3 * t);
        v += harm / freqs.length;
      }
      samples[start + i]! += v * env * 0.35;
    }
  }

  // Soft limit
  for (let i = 0; i < n; i++) {
    samples[i] = Math.tanh(samples[i]!);
  }
  return { samples, sampleRate };
}

function envelope(i: number, len: number, timbre: 'piano' | 'guitar'): number {
  const attack = Math.min(0.02 * (timbre === 'guitar' ? 1 : 1.5), len / 8 / 22050);
  const aN = Math.max(1, Math.floor(attack * 22050));
  if (i < aN) return i / aN;
  const release = Math.floor(len * 0.15);
  if (i > len - release) return Math.max(0, (len - i) / release);
  return 1;
}

function chordFrequencies(chord: string): number[] {
  const p = parseChord(chord);
  if (!p) return [];
  const intervals = QUALITY_INTERVALS[p.quality] ?? [0, 4, 7];
  // Voicing around octave 3–4
  const baseMidi = 48 + p.root; // C3 + root
  const freqs: number[] = [];
  for (const iv of intervals) {
    const midi = baseMidi + iv;
    freqs.push(midiToHz(midi));
  }
  // Add bass note an octave down
  const bassMidi = 36 + (p.bass ?? p.root);
  freqs.unshift(midiToHz(bassMidi));
  return freqs;
}

function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Expand fixture segments to full timeline audio */
export function synthesizeFixture(
  fixture: SongFixture,
  options: SynthOptions = {},
): { samples: Float32Array; sampleRate: number } {
  return synthesizeChordProgression(fixture.segments, fixture.bpm, options);
}
