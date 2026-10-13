import { describe, expect, it } from 'vitest';
import {
  detectChordsFromNotes,
  findDronePcs,
  lowestBassPc,
  lowestSustainedPc,
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

  it('derives lowest sustained PC from accompaniment when bass is absent', () => {
    // Ringing open A2 + short high notes
    const notes = [
      note(0, 0.9, 45, 0.8), // A2 sustained
      note(0.1, 0.15, 64, 0.9), // E4 flick
      note(0.3, 0.2, 69, 0.7), // A4
    ];
    const b = lowestSustainedPc(notes, 0, 1, 62);
    expect(b?.pc).toBe(9); // A
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
      metricDecode: true,
      simplifyLevel: 0.55,
    });
    expect(result.chords.length).toBeGreaterThan(0);
    expect(result.downbeatPhase).toBeGreaterThanOrEqual(0);
    expect(result.downbeatPhase).toBeLessThan(4);
    expect(result.beatInBar?.length).toBeGreaterThan(0);
    const roots = result.chords.map((c) => parseChord(c.chord)?.root);
    expect(roots).toContain(5); // F
    expect(roots).toContain(0); // C
  });

  it('rejects slash when bass note is too fleeting (slashMinSustain)', () => {
    // F–A–C with C2 bass → Am/C only when the bass note sustains ≥ slashMinSustain
    const notes: NoteEvent[] = [];
    for (const t0 of [0, 2, 4, 6, 8, 10, 12, 14]) {
      notes.push(note(t0, 1.8, 53, 0.9), note(t0, 1.8, 57, 0.9), note(t0, 1.8, 60, 0.85));
    }
    const opts = {
      bpmHint: 120,
      metricDecode: true,
      simplifyLevel: 0.35,
      allowSlash: true,
      bassEnergyRatio: 1,
      useNnls: false,
    } as const;
    const sustainedBass = [0, 2, 4, 6, 8, 10, 12, 14].map((t0) => note(t0, 1.8, 36, 0.95));
    const fleetingBass = [0, 2, 4, 6].map((t0) => note(t0 + 0.05, 0.05, 36, 0.95));

    const withSlash = detectChordsFromNotes(notes, sustainedBass, 16000, {
      ...opts,
      slashMinSustain: 0.45,
    });
    expect(withSlash.chords.some((c) => c.chord.includes('/'))).toBe(true);

    const fleeting = detectChordsFromNotes(notes, fleetingBass, 16000, {
      ...opts,
      slashMinSustain: 0.45,
    });
    expect(fleeting.chords.some((c) => c.chord.includes('/'))).toBe(false);

    const strictSustain = detectChordsFromNotes(notes, sustainedBass, 16000, {
      ...opts,
      slashMinSustain: 0.99,
    });
    expect(strictSustain.chords.some((c) => c.chord.includes('/'))).toBe(false);
  });

  it('silenceGate marks near-silent lead-in as N when mix audio is provided', () => {
    const sr = 22050;
    const totalSec = 8;
    const samples = new Float32Array(sr * totalSec);
    // Quiet lead-in 0–2s, then loud C major tone cluster
    for (let i = Math.floor(sr * 2); i < samples.length; i++) {
      const t = i / sr;
      samples[i] =
        0.25 * Math.sin(2 * Math.PI * 261.63 * t) +
        0.2 * Math.sin(2 * Math.PI * 329.63 * t) +
        0.2 * Math.sin(2 * Math.PI * 392.0 * t);
    }
    const notes: NoteEvent[] = [];
    const bass: NoteEvent[] = [];
    for (let bar = 0; bar < 4; bar++) {
      const t0 = bar * 2;
      notes.push(note(t0, 1.8, 60), note(t0, 1.8, 64), note(t0, 1.8, 67));
      bass.push(note(t0, 1.8, 36));
    }
    const result = detectChordsFromNotes(
      notes,
      bass,
      totalSec * 1000,
      {
        bpmHint: 120,
        metricDecode: true,
        silenceGate: 0.15,
        vocabPrior: 0,
        useNnls: false,
        bassEnergyRatio: 1,
      },
      { samples, sampleRate: sr },
    );
    expect(result.chords.some((c) => c.chord === 'N')).toBe(true);
    expect(result.chords.some((c) => c.chord !== 'N')).toBe(true);
  });
});
