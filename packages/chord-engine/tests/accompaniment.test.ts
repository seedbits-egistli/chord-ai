import { describe, expect, it } from 'vitest';
import {
  buildAccompanimentChart,
  chartToStrumEvents,
  chooseCapo,
  chooseStrumPattern,
  formatChartText,
  simplifyChordForLevel,
} from '../src/accompaniment.js';
import { getGuitarVoicing, voicingMidi } from '../src/guitarShapes.js';
import type { DetectionResult } from '../src/types.js';

function result(chordsPerBeat: string[], bpm = 100, phase = 0): DetectionResult {
  const beatMs = 60000 / bpm;
  const beats = chordsPerBeat.map((_, i) => i * beatMs);
  const chords = chordsPerBeat.map((c, i) => ({ tMs: i * beatMs, endMs: (i + 1) * beatMs, chord: c }));
  return {
    chords, key: 'A', bpm, timeSig: '4/4', beats, simplifyLevel: 0.5,
    beatInBar: beats.map((_, i) => (((i - phase) % 4) + 4) % 4),
  };
}

describe('simplifyChordForLevel', () => {
  it('simple collapses to triads', () => {
    expect(simplifyChordForLevel('B7sus4', 'simple')).toBe('B');
    expect(simplifyChordForLevel('F#m7', 'simple', 'A')).toBe('F#m');
    expect(simplifyChordForLevel('C#m/G#', 'simple', 'A')).toBe('C#m');
    expect(simplifyChordForLevel('N', 'simple')).toBe('N');
  });
  it('standard keeps 7 and sus but drops slash/extensions', () => {
    expect(simplifyChordForLevel('Esus4', 'standard')).toBe('Esus4');
    expect(simplifyChordForLevel('G9', 'standard')).toBe('G7');
    expect(simplifyChordForLevel('A/C#', 'standard')).toBe('A');
  });
  it('raw is unchanged', () => {
    expect(simplifyChordForLevel('A/C#', 'raw')).toBe('A/C#');
  });
});

describe('chooseCapo', () => {
  it('keeps open-key songs at capo 0', () => {
    expect(chooseCapo(['G', 'D', 'Am', 'C'], 'G').capo).toBe(0);
  });
  it('moves Bb/Eb/F songs to easy shapes', () => {
    const p = chooseCapo(['F', 'C', 'Bb', 'Gm', 'F', 'C'], 'F');
    expect(p.capo).toBeGreaterThan(0);
    expect(p.shapes['Bb']).not.toBe('Bb');
    expect(p.summary).toMatch(/^Capo \d，用 .+ 調指法$/);
  });
  it('honours override', () => {
    const p = chooseCapo(['A', 'E', 'F#m', 'D'], 'A', 2);
    expect(p.capo).toBe(2);
    expect(p.shapes['A']).toBe('G');
    expect(p.auto).toBe(false);
  });
});

describe('voicings', () => {
  it('has open shapes and barre fallbacks', () => {
    expect(getGuitarVoicing('C')!.open).toBe(true);
    const fsharp = getGuitarVoicing('F#m')!;
    expect(fsharp.open).toBe(false);
    expect(fsharp.barreFret).toBe(2);
    expect(voicingMidi(getGuitarVoicing('E')!, 0)).toEqual([40, 47, 52, 56, 59, 64]);
    expect(voicingMidi(getGuitarVoicing('E')!, 2)[0]).toBe(42);
  });
});

describe('strum pattern', () => {
  it('chooses by tempo / meter', () => {
    expect(chooseStrumPattern(68).id).toBe('ballad');
    expect(chooseStrumPattern(100).label).toBe('D - D U - U D U');
    expect(chooseStrumPattern(160).id).toBe('drive');
    expect(chooseStrumPattern(100, 3).id).toBe('waltz');
  });
});

describe('buildAccompanimentChart', () => {
  it('groups by downbeat and keeps ≤2 chords per bar at simple level', () => {
    const seq = ['A', 'A', 'E', 'E', 'F#m', 'Bm', 'D', 'D', 'A', 'A', 'A', 'A'];
    const chart = buildAccompanimentChart(result(seq), { level: 'simple' });
    expect(chart.bars.length).toBe(3);
    for (const b of chart.bars) expect(b.chords.length).toBeLessThanOrEqual(2);
    // 1-beat Bm blip is merged away
    expect(chart.bars[1]!.chords.map((c) => c.chord)).not.toContain('Bm');
  });
  it('respects a pickup (downbeat phase) and fills N gaps', () => {
    const seq = ['G', 'C', 'C', 'C', 'C', 'N', 'G', 'G', 'G'];
    const chart = buildAccompanimentChart(result(seq, 100, 1), { level: 'standard' });
    expect(chart.bars[0]!.beatMs.length).toBe(1);
    expect(chart.bars[1]!.chords.every((c) => c.chord !== 'N')).toBe(true);
  });
  it('produces strum events with capo-shifted MIDI', () => {
    const chart = buildAccompanimentChart(result(['A', 'A', 'A', 'A', 'D', 'D', 'E', 'E']), {
      level: 'simple',
      capoOverride: 2,
    });
    const ev = chartToStrumEvents(chart);
    expect(ev.length).toBe(2 * chart.strum.strokes.length);
    expect(ev[0]!.shape).toBe('G');
    expect(ev[0]!.midi[0]).toBe(43 + 2);
    expect(ev.some((e) => e.dir === 'U')).toBe(true);
    expect(formatChartText(chart)).toContain('Capo 2');
  });
});
