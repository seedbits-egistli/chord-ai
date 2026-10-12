import { describe, expect, it } from 'vitest';
import {
  formatChord,
  parseChord,
  simplifyLabel,
  toMajorMinorClass,
} from '../src/chordParse.js';
import { transposeChord, transposeKey, suggestCapo } from '../src/transpose.js';

describe('parseChord / formatChord', () => {
  it('parses triads and sevenths', () => {
    expect(parseChord('C')).toEqual({ root: 0, quality: 'maj' });
    expect(parseChord('Am7')).toEqual({ root: 9, quality: 'min7' });
    expect(parseChord('F#dim')).toEqual({ root: 6, quality: 'dim' });
    expect(parseChord('Bbmaj7')).toEqual({ root: 10, quality: 'maj7' });
    expect(parseChord('A7sus4')).toEqual({ root: 9, quality: '7sus4' });
  });

  it('parses slash chords', () => {
    expect(parseChord('C/G')).toEqual({ root: 0, quality: 'maj', bass: 7 });
    expect(parseChord('Am7/E')).toEqual({ root: 9, quality: 'min7', bass: 4 });
  });

  it('formats with flat-key spelling', () => {
    expect(formatChord({ root: 10, quality: 'maj' }, 'F')).toBe('Bb');
    expect(formatChord({ root: 3, quality: 'min' }, 'Bb')).toBe('Ebm');
  });
});

describe('simplifyLabel', () => {
  it('collapses extensions at high simplify', () => {
    const s = simplifyLabel({ root: 0, quality: 'maj9' }, 0.9);
    expect(s.quality).toBe('maj');
  });

  it('keeps sevenths at mid simplify', () => {
    const s = simplifyLabel({ root: 0, quality: '9' }, 0.5);
    expect(s.quality).toBe('7');
  });
});

describe('transposition', () => {
  it('transposes chords and keys with correct accidentals', () => {
    expect(transposeChord('C', 5, 'F')).toBe('F');
    expect(transposeChord('Am', 5, 'Dm')).toBe('Dm');
    expect(transposeChord('G', 5, 'F')).toBe('C');
    // +1 from C → Db key uses flats
    expect(transposeKey('C', 1)).toBe('Db');
    expect(transposeChord('F', 1, 'Db')).toBe('Gb');
  });

  it('suggests capo minimizing hard shapes', () => {
    const s = suggestCapo(['F', 'Bb', 'C', 'F'], 'guitar');
    expect(s.capo).toBeGreaterThanOrEqual(0);
    expect(s.capo).toBeLessThanOrEqual(7);
    expect(s.shapes).toHaveLength(4);
  });
});

describe('toMajorMinorClass', () => {
  it('maps sevenths to maj/min', () => {
    expect(toMajorMinorClass('Am7')).toBe('Am');
    expect(toMajorMinorClass('G7')).toBe('G');
    expect(toMajorMinorClass('Fmaj7')).toBe('F');
  });
});
