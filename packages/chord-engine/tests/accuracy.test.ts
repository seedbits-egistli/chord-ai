import { describe, expect, it } from 'vitest';
import { exactMatch, pitchClassSet, toneOverlap } from '../src/accuracy.js';

describe('toneOverlap (headline metric)', () => {
  it('gives perfect score for identical chords', () => {
    const t = toneOverlap('F#m7', 'F#m7');
    expect(t.jaccard).toBe(1);
    expect(t.recall).toBe(1);
    expect(t.rootMatch).toBe(true);
    expect(t.weighted).toBe(1);
  });

  it('credits F#m7 vs A as high shared-tone overlap (relative)', () => {
    // F#m7 = F# A C# E; A = A C# E → Jaccard 0.75, recall 0.75, root false
    const t = toneOverlap('F#m7', 'A');
    expect(t.jaccard).toBeCloseTo(0.75, 5);
    expect(t.recall).toBeCloseTo(0.75, 5);
    expect(t.rootMatch).toBe(false);
    expect(t.weighted).toBeCloseTo(0.55 * 0.75 + 0.35 * 0.75 + 0.1 * 0, 5);
  });

  it('credits A6 vs F#m7 as near-equivalent PC sets', () => {
    const a = pitchClassSet('F#m7');
    const b = pitchClassSet('A6');
    expect([...a].sort()).toEqual([...b].sort());
    const t = toneOverlap('F#m7', 'A6');
    expect(t.jaccard).toBe(1);
    expect(t.recall).toBe(1);
  });

  it('gives recall=1 when hyp is a superset of ref tones', () => {
    // A ⊂ Aadd9
    const t = toneOverlap('A', 'Aadd9');
    expect(t.recall).toBe(1);
    expect(t.rootMatch).toBe(true);
    expect(t.jaccard).toBeLessThan(1);
  });

  it('exactMatch still treats quality families', () => {
    expect(exactMatch('F#m7', 'F#m')).toBe(true);
    expect(exactMatch('B7sus4', 'Bsus4')).toBe(true);
  });
});
