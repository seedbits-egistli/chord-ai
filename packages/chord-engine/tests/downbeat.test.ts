import { describe, expect, it } from 'vitest';
import {
  estimateDownbeatFromBeatChromas,
  harmonicNovelty,
  pickBestPhase,
  scoreDownbeatPhase,
} from '../src/downbeat.js';
import { viterbiSmoothMetric, type BeatObservation } from '../src/match.js';

function chromaAt(pcs: number[]): Float32Array {
  const c = new Float32Array(12);
  for (const p of pcs) c[p]! = 1;
  let n = 0;
  for (let i = 0; i < 12; i++) n += c[i]! * c[i]!;
  const inv = n > 0 ? 1 / Math.sqrt(n) : 1;
  for (let i = 0; i < 12; i++) c[i]! *= inv;
  return c;
}

describe('downbeat from harmonic novelty', () => {
  it('scores novelty higher when changes land on candidate downbeats', () => {
    // Novelty spikes at indices 4,8,12 (phase 0) vs weak elsewhere
    const novelty = new Float32Array(16);
    for (let i = 4; i < 16; i += 4) novelty[i] = 1;
    novelty[2] = 0.2;
    novelty[6] = 0.2;
    expect(scoreDownbeatPhase(novelty, 0)).toBeGreaterThan(scoreDownbeatPhase(novelty, 1));
    expect(pickBestPhase(novelty).phase).toBe(0);
  });

  it('credits early (pre-barline) changes toward the next downbeat', () => {
    // Strong novelty on downbeats + anticipation on last beat of bar → phase 0
    // (early-only spikes would correctly prefer phase 3 as the literal change beat)
    const novelty = new Float32Array(16);
    for (let i = 4; i < 16; i += 4) {
      novelty[i] = 1;
      novelty[i - 1] = 0.85;
    }
    novelty[0] = 1;
    expect(scoreDownbeatPhase(novelty, 0)).toBeGreaterThan(scoreDownbeatPhase(novelty, 1));
    expect(scoreDownbeatPhase(novelty, 0)).toBeGreaterThan(scoreDownbeatPhase(novelty, 2));
    expect(pickBestPhase(novelty).phase).toBe(0);
  });

  it('recovers phase from synthetic bar-synchronous chord changes', () => {
    // 4-chord loop, change every 4 beats, starting at beat index 1
    const loop = [
      chromaAt([6, 9, 1]), // F#m
      chromaAt([9, 1, 4]), // A
      chromaAt([4, 9, 11]), // Esus-ish
      chromaAt([11, 4, 6]), // Bsus-ish
    ];
    const phaseOffset = 1;
    const chromas: Float32Array[] = [];
    for (let i = 0; i < 32; i++) {
      chromas.push(loop[((i - phaseOffset) % 4 + 4) % 4]!);
    }
    const est = estimateDownbeatFromBeatChromas(chromas, { chunkBars: 0 });
    expect(est.phase).toBe(phaseOffset);
    expect(est.beatInBar[phaseOffset]).toBe(0);
  });

  it('harmonicNovelty is near zero for identical chroma', () => {
    const a = chromaAt([0, 4, 7]);
    expect(harmonicNovelty(a, a)).toBeLessThan(0.05);
    expect(harmonicNovelty(a, chromaAt([2, 5, 9]))).toBeGreaterThan(0.5);
  });
});

describe('metric Viterbi', () => {
  it('prefers chord changes on downbeats over weak beats', () => {
    const mk = (label: { root: number; quality: 'maj' | 'min' }, score: number) => ({
      label,
      score,
    });
    const F = { root: 5, quality: 'maj' as const };
    const C = { root: 0, quality: 'maj' as const };
    // Clear emissions with a change at beat 4 (downbeat); wrong-beat change is costly
    const observations: BeatObservation[] = [];
    for (let i = 0; i < 8; i++) {
      const preferF = i < 4;
      observations.push({
        startMs: i * 500,
        endMs: (i + 1) * 500,
        candidates: preferF
          ? [mk(F, 1.0), mk(C, 0.55)]
          : [mk(C, 1.0), mk(F, 0.55)],
      });
    }
    // Phase 0: downbeats at 0,4
    const beatInBar = [0, 1, 2, 3, 0, 1, 2, 3];
    const labels = viterbiSmoothMetric(observations, beatInBar, {
      selfBias: 0.5,
      changeCost: [-0.02, -0.35, -0.1, -0.3],
    });
    // Should stay F for first 4 beats, C for next 4
    expect(labels.slice(0, 4).every((l) => l.root === 5)).toBe(true);
    expect(labels.slice(4, 8).every((l) => l.root === 0)).toBe(true);

    // Same emissions but change forced mid-bar at beat 2: metric prior prefers holding
    const earlyChange: BeatObservation[] = [];
    for (let i = 0; i < 8; i++) {
      const preferF = i < 2;
      earlyChange.push({
        startMs: i * 500,
        endMs: (i + 1) * 500,
        candidates: preferF
          ? [mk(F, 0.82), mk(C, 0.78)]
          : [mk(C, 0.82), mk(F, 0.78)],
      });
    }
    const sticky = viterbiSmoothMetric(earlyChange, beatInBar, {
      selfBias: 0.55,
      changeCost: [-0.02, -0.4, -0.1, -0.35],
    });
    // With weak emission gap on a weak beat, self+metric bias should not flip at beat 1
    expect(sticky[1]!.root).toBe(sticky[0]!.root);
  });
});
