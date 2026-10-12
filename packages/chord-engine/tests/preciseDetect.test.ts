import { describe, expect, it } from 'vitest';
import {
  detectChordsFromNotes,
  findDronePcs,
  lowestBassPc,
  noteChroma,
  type NoteEvent,
} from '../src/preciseDetect.js';
import { parseChord } from '../src/chordParse.js';

function note(time: number, duration: number, midi: number, velocity = 0.8): NoteEvent {
  return { time, duration, midi, velocity };
}

describe('preciseDetect helpers', () => {
  it('builds duration-weighted pitch-class chroma', () => {
    // C major triad: C3 E3 G3
    const notes = [
      note(0, 1, 48),
      note(0, 1, 52),
      note(0, 0.5, 55),
    ];
    const ch = noteChroma(notes, 0, 1);
    expect(ch[0]!).toBeGreaterThan(ch[1]!); // C
    expect(ch[4]!).toBeGreaterThan(0.1); // E
    expect(ch[7]!).toBeGreaterThan(0.05); // G
  });

  it('picks lowest bass pitch class', () => {
    const bass = [note(0, 1, 43, 0.9), note(0, 0.5, 55, 1)]; // G2 + G3
    const b = lowestBassPc(bass, 0, 1);
    expect(b?.pc).toBe(7);
  });

  it('flags only very persistent drone pitch classes', () => {
    const notes: NoteEvent[] = [];
    for (let i = 0; i < 16; i++) {
      notes.push(note(i * 0.5, 0.5, 54, 1)); // F# drone every window
      notes.push(note(i * 0.5, 0.35, 60 + (i % 4), 0.7)); // moving notes
    }
    const windows = Array.from({ length: 16 }, (_, i) => ({
      startSec: i * 0.5,
      endSec: (i + 1) * 0.5,
    }));
    const drones = findDronePcs(notes, windows, 0.7);
    expect(drones.has(6)).toBe(true); // F#
  });
});

describe('detectChordsFromNotes', () => {
  it('infers F – C – Bb style progression with slash bass', () => {
    // 4 bars @ 120 BPM → 2s/bar, half-bar windows with bpmHint
    const notes: NoteEvent[] = [];
    const bass: NoteEvent[] = [];
    const addChord = (t0: number, midis: number[], bassMidi: number) => {
      for (const m of midis) notes.push(note(t0, 1.8, m, 0.85));
      bass.push(note(t0, 1.8, bassMidi, 0.9));
    };
    // F: F A C, bass F2
    addChord(0, [53, 57, 60], 41);
    // C: C E G, bass C2
    addChord(2, [48, 52, 55], 36);
    // Bb: Bb D F, bass Bb1
    addChord(4, [46, 50, 53], 34);
    // F again
    addChord(6, [53, 57, 60], 41);

    const result = detectChordsFromNotes(notes, bass, 8000, {
      bpmHint: 120,
      halfBar: true,
      simplifyLevel: 0.55,
    });
    expect(result.chords.length).toBeGreaterThan(0);
    const roots = result.chords.map((c) => parseChord(c.chord)?.root);
    expect(roots).toContain(5); // F
    expect(roots).toContain(0); // C
  });
});
