import { describe, expect, it } from 'vitest';
import { applyChordExtensions, decideExtension } from '../src/chordExtensions.js';

const ch = (m: Record<number, number>) => Array.from({ length: 12 }, (_, i) => m[i] ?? 0);

describe('chord extensions', () => {
  it('keeps a plain triad without colour-tone evidence', () => {
    expect(decideExtension({ root: 9, quality: 'maj' }, ch({ 9: 1, 1: 0.8, 4: 0.9 }))).toBe('maj');
  });
  it('upgrades minor to m7 when the b7 is as strong as the triad', () => {
    expect(decideExtension({ root: 6, quality: 'min' }, ch({ 6: 1, 9: 0.9, 1: 0.9, 4: 1 }))).toBe('min7');
  });
  it('detects sus4 when the 3rd is absent and the 4th is present (Esus4)', () => {
    expect(decideExtension({ root: 4, quality: 'maj' }, ch({ 4: 0.8, 11: 1, 9: 0.45 }))).toBe('sus4');
  });
  it('detects 7sus4 (B7sus4 = B E F# A)', () => {
    expect(decideExtension({ root: 11, quality: 'maj' }, ch({ 11: 1, 4: 0.9, 6: 0.9, 9: 0.9 }))).toBe('7sus4');
  });
  it('does not emit maj7 by default (vocal leakage)', () => {
    expect(decideExtension({ root: 0, quality: 'maj' }, ch({ 0: 1, 4: 1, 7: 1, 11: 1 }))).toBe('maj');
  });
  it('ignores flat noisy chroma', () => {
    const c = ch({}).map(() => 0.3);
    c[6] = 0.9;
    expect(decideExtension({ root: 6, quality: 'min' }, c)).toBe('min');
  });
  it('upgrades whole runs and skips single-beat runs', () => {
    const e = ch({ 4: 0.8, 11: 1, 9: 0.6 });
    const out = applyChordExtensions(
      [{ root: 4, quality: 'maj' }, { root: 4, quality: 'maj' }, { root: 9, quality: 'maj' }],
      [e, e, e],
    );
    expect(out.map((l) => l.quality)).toEqual(['sus4', 'sus4', 'maj']);
  });
});
