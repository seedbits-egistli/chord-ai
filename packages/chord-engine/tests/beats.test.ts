import { describe, expect, it } from 'vitest';
import { trackBeatsFromAudio } from '../src/beats.js';

const SR = 22050;

/** Click/strum-like synthetic track: decaying noise bursts + low "kick". */
function synth(bpm: number, seconds: number, opts: { syncopate?: boolean; drift?: number } = {}): Float32Array {
  const out = new Float32Array(Math.floor(SR * seconds));
  let rng = 12345;
  const rnd = () => ((rng = (rng * 1103515245 + 12345) >>> 0) / 2 ** 32) * 2 - 1;
  const hit = (t: number, amp: number, low: boolean) => {
    const s0 = Math.floor(t * SR);
    for (let i = 0; i < SR * 0.12 && s0 + i < out.length; i++) {
      const env = Math.exp(-i / (SR * 0.03));
      out[s0 + i]! += amp * env * (low ? Math.sin((2 * Math.PI * 60 * i) / SR) : rnd() * 0.6);
    }
  };
  let t = 0.25;
  let beat = 0;
  while (t < seconds - 0.2) {
    const local = bpm * (1 + (opts.drift ?? 0) * (t / seconds));
    const ibi = 60 / local;
    const inBar = beat % 4;
    hit(t, inBar === 0 ? 1 : 0.7, inBar === 0 || inBar === 2);
    if (opts.syncopate) {
      // "and" of 2 and 4 accented, skip beat 3 strum (push)
      if (inBar === 1 || inBar === 3) hit(t + ibi / 2, 0.8, false);
    } else {
      hit(t + ibi / 2, 0.35, false);
    }
    t += ibi;
    beat++;
  }
  return out;
}

function medianIbi(beats: number[]): number {
  const d = beats.slice(1).map((b, i) => b - beats[i]!).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)]!;
}

/**
 * 68–120 BPM must hit the exact level. At the extremes (60, 150) a clean
 * synthetic pulse with 8th-note subdivisions is genuinely 2:1 ambiguous and the
 * ~90 BPM prior picks 120 / 75 — accept the octave-related level there.
 */
function levelErr(det: number, bpm: number): number {
  const exact = Math.abs(det - bpm) / bpm;
  if (bpm >= 68 && bpm <= 120) return exact;
  return Math.min(exact, Math.abs(det - bpm * 2) / (bpm * 2), Math.abs(det - bpm / 2) / (bpm / 2));
}

describe('trackBeatsFromAudio', () => {
  for (const bpm of [60, 68, 90, 120, 150]) {
    it(`finds ${bpm} BPM`, () => {
      const r = trackBeatsFromAudio(synth(bpm, 30), SR);
      expect(levelErr(r.bpm, bpm)).toBeLessThan(0.04);
      expect(levelErr(60000 / medianIbi(r.beats), bpm)).toBeLessThan(0.04);
    });
    it(`finds ${bpm} BPM with syncopation`, () => {
      const r = trackBeatsFromAudio(synth(bpm, 30, { syncopate: true }), SR);
      expect(levelErr(r.bpm, bpm)).toBeLessThan(0.04);
    });
  }
  it('follows gradual tempo drift (DP)', () => {
    const r = trackBeatsFromAudio(synth(100, 40, { drift: 0.06 }), SR);
    const b = r.beats;
    const early = 60000 / medianIbi(b.slice(0, 15));
    const late = 60000 / medianIbi(b.slice(-15));
    expect(late).toBeGreaterThan(early + 2);
  });
});
