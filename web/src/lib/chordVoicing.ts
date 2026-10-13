import { parseChord, QUALITY_INTERVALS } from '@chord-ai/engine';
import { lookupVoicingMidi } from './fingerings';

export type PlayInstrument = 'piano' | 'guitar' | 'ukulele';

/** Close-position piano voicing around C3–C5 from chord quality intervals. */
export function pianoMidiNotes(chord: string): number[] {
  const label = parseChord(chord);
  if (!label) return [];
  const intervals = QUALITY_INTERVALS[label.quality] ?? [0, 4, 7];
  const rootMidi = 48 + label.root; // C3 + pc
  const notes = intervals.map((iv) => {
    let n = rootMidi + iv;
    // Keep extensions from wrapping too high awkwardly
    while (n > rootMidi + 14) n -= 12;
    return n;
  });
  if (label.bass !== undefined && label.bass !== label.root) {
    notes.unshift(36 + label.bass);
  }
  return [...new Set(notes)].sort((a, b) => a - b);
}

/** Resolve MIDI notes for the selected playback instrument. */
export function resolveChordMidi(chord: string, instrument: PlayInstrument): number[] {
  if (instrument === 'piano') return pianoMidiNotes(chord);
  const fretted = lookupVoicingMidi(chord, instrument);
  if (fretted.length) return fretted;
  // Fallback: piano voicing if chords-db miss
  return pianoMidiNotes(chord);
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}
