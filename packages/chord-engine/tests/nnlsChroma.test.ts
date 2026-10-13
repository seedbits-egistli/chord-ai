import { describe, expect, it } from 'vitest';
import {
  activationsToChroma,
  bassPitchWeight,
  buildNoteDictionary,
  magnitudeToLogFreq,
  nnls,
  standardizeLogFreq,
  treblePitchWeight,
} from '../src/nnlsChroma.js';
import { templatePresenceScore } from '../src/match.js';

describe('nnlsChroma (Mauch & Dixon 2010, independent)', () => {
  it('builds an L1-normalised 84-note dictionary', () => {
    const E = buildNoteDictionary(0.6);
    expect(E.length).toBe(252 * 84);
    // First column sums ~1
    let sum = 0;
    for (let i = 0; i < 252; i++) sum += E[i]!;
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
  });

  it('NNLS recovers a sparse non-negative activation', () => {
    const E = buildNoteDictionary(0.6);
    const nRows = 252;
    const nCols = 84;
    // Synthesise y = 0.8 * col[10] + 0.5 * col[22]
    const y = new Float32Array(nRows);
    for (let i = 0; i < nRows; i++) {
      y[i] = 0.8 * E[10 * nRows + i]! + 0.5 * E[22 * nRows + i]!;
    }
    const x = nnls(E, y, nRows, nCols);
    expect(x[10]!).toBeGreaterThan(0.3);
    expect(x[22]!).toBeGreaterThan(0.2);
    // Most other activations near zero
    let big = 0;
    for (let j = 0; j < nCols; j++) if (x[j]! > 0.15) big++;
    expect(big).toBeLessThanOrEqual(4);
  });

  it('maps activations to treble/bass chroma with register windows', () => {
    expect(bassPitchWeight(40)).toBeGreaterThan(bassPitchWeight(70));
    expect(treblePitchWeight(70)).toBeGreaterThan(treblePitchWeight(35));
    const x = new Float32Array(84);
    x[48 - 21] = 1; // C3
    x[52 - 21] = 0.8; // E3
    x[55 - 21] = 0.7; // G3
    const { treble, bass } = activationsToChroma(x);
    expect(treble[0]!).toBeGreaterThan(0.1); // C
    expect(bass[0]!).toBeGreaterThan(0.1);
  });

  it('standardises log-freq (non-negative after whitening)', () => {
    const Y = new Float32Array(252);
    for (let i = 0; i < 252; i++) Y[i] = 1 + Math.sin(i / 5) * 0.5;
    Y[100] = 5;
    const S = standardizeLogFreq(Y);
    expect(S[100]!).toBeGreaterThan(0);
    for (let i = 0; i < 252; i++) expect(S[i]!).toBeGreaterThanOrEqual(0);
  });

  it('magnitudeToLogFreq puts energy near expected pitch bin', () => {
    // Fake spectrum: peak at ~440 Hz with sr=11025, fft=4096
    const sr = 11025;
    const fft = 4096;
    const mag = new Float32Array(fft / 2);
    const k = Math.round((440 * fft) / sr);
    mag[k] = 1;
    const Y = magnitudeToLogFreq(mag, sr, fft, 0);
    // A4 = MIDI 69 → index (69-21)*3 + 1 ≈ centre
    const bin = (69 - 21) * 3 + 1;
    let peak = 0;
    let peakI = 0;
    for (let i = 0; i < Y.length; i++) {
      if (Y[i]! > peak) {
        peak = Y[i]!;
        peakI = i;
      }
    }
    expect(Math.abs(peakI - bin)).toBeLessThanOrEqual(3);
  });
});

describe('template presence (sus fairness)', () => {
  it('scores sus4 higher than maj when 4th dominates 3rd', () => {
    const chroma = new Float32Array(12);
    // E sus4: E A B
    chroma[4] = 0.6;
    chroma[9] = 0.55;
    chroma[11] = 0.5;
    const sus = templatePresenceScore(chroma, 4, 'sus4');
    const maj = templatePresenceScore(chroma, 4, 'maj'); // E G# B — G# missing
    expect(sus).toBeGreaterThan(maj);
  });
});
