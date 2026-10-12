import { describe, expect, it } from 'vitest';
import { cosineSimilarity, getTemplates, QUALITY_INTERVALS } from '../src/templates.js';
import { matchChord } from '../src/match.js';
import { synthesizeChordProgression } from '../src/synthesize.js';
import { detectChords } from '../src/detect.js';

describe('chord templates', () => {
  it('covers all qualities × 12 roots', () => {
    const qualities = Object.keys(QUALITY_INTERVALS).length;
    expect(getTemplates()).toHaveLength(12 * qualities);
  });

  it('matches pure maj/min chroma templates', () => {
    // Build C major chroma manually
    const chroma = new Float32Array(12);
    chroma[0] = 1;
    chroma[4] = 1;
    chroma[7] = 1;
    let n = Math.sqrt(3);
    for (let i = 0; i < 12; i++) chroma[i]! /= n;
    const bass = new Float32Array(12);
    bass[0] = 1;
    const m = matchChord(chroma, bass, 0.9);
    expect(m.label.root).toBe(0);
    expect(m.label.quality).toBe('maj');
  });

  it('cosine self-similarity is 1', () => {
    const t = getTemplates()[0]!;
    expect(cosineSimilarity(t.vector, t.vector)).toBeCloseTo(1, 5);
  });
});

describe('synthesize + detect smoke', () => {
  it('detects a simple C–G–Am–F loop', () => {
    const { samples, sampleRate } = synthesizeChordProgression(
      [
        { chord: 'C', startBeat: 0, endBeat: 4 },
        { chord: 'G', startBeat: 4, endBeat: 8 },
        { chord: 'Am', startBeat: 8, endBeat: 12 },
        { chord: 'F', startBeat: 12, endBeat: 16 },
      ],
      90,
      { timbre: 'piano' },
    );
    const result = detectChords(samples, sampleRate, { simplifyLevel: 0.85 });
    const names = result.chords.map((c) => c.chord);
    // Should contain the four chords in some form
    const joined = names.join(' ');
    expect(joined).toMatch(/C/);
    expect(joined).toMatch(/G/);
    expect(joined).toMatch(/Am|A/);
    expect(joined).toMatch(/F/);
  });
});
