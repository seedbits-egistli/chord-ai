/**
 * v2 in-browser pipeline glue: key from chords, respelling, DetectionResult assembly.
 * Model execution is injected (onnxruntime-web in the worker, onnxruntime-node in validation scripts).
 */
import { parseChord, formatChord } from '../chordParse.js';
import { QUALITY_INTERVALS } from '../templates.js';
import { detectKey } from '../key.js';
import type { ChordEvent, DetectionResult } from '../types.js';
import type { BtcChordResult } from './btc.js';

/** Key from duration-weighted chord tones (root counted twice). */
export function keyFromChords(chords: ChordEvent[]): string {
  const chroma = new Float64Array(12);
  for (const c of chords) {
    const p = parseChord(c.chord);
    if (!p) continue;
    const d = (c.endMs - c.tMs) / 1000;
    chroma[p.root] += d;
    for (const iv of QUALITY_INTERVALS[p.quality] ?? [0, 4, 7]) chroma[(p.root + iv) % 12] += d;
  }
  return detectKey(chroma);
}

/** Respell sharps → flats according to the key (A# → Bb in F). */
export function respellForKey(chords: ChordEvent[], key: string): ChordEvent[] {
  return chords.map((c) => {
    const p = parseChord(c.chord);
    return p ? { ...c, chord: formatChord(p, key) } : c;
  });
}

export function toDetectionResult(r: BtcChordResult): DetectionResult {
  const key = keyFromChords(r.chords);
  const beatsMs = r.beats.map((b) => Math.round(b * 1000));
  const dbs = r.downbeats.map((d) => Math.round(d * 1000));
  const beatInBar: number[] = [];
  let k = 0;
  for (const b of beatsMs) {
    if (dbs.some((d) => Math.abs(d - b) < 60)) k = 0;
    beatInBar.push(k % 4);
    k++;
  }
  return {
    chords: respellForKey(r.chords, key),
    key,
    bpm: Math.round(r.bpm * 10) / 10,
    timeSig: '4/4',
    beats: beatsMs,
    simplifyLevel: 0,
    beatInBar,
  };
}
