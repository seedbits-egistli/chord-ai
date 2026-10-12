/**
 * Training-free downbeat estimation from harmonic novelty on a beat grid.
 * Inspired by metric-position ideas in Mauch & Dixon (2010), without learning.
 */

import { normalizeL2 } from './chroma.js';

export interface DownbeatEstimate {
  /** Global best phase: beats[i] is a downbeat when (i % beatsPerBar) === phase */
  phase: number;
  /** Score per candidate phase 0..beatsPerBar-1 */
  phaseScores: number[];
  /** Per-beat metric position 0..beatsPerBar-1 (0 = downbeat) */
  beatInBar: number[];
  /** Per-chunk phases when local re-phase is enabled */
  chunkPhases: number[];
}

function l1Dist(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < 12; i++) s += Math.abs(a[i]! - b[i]!);
  return s;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 1e-12 ? dot / d : 0;
}

/** Harmonic novelty between consecutive beat chromas (0≈same, higher≈change). */
export function harmonicNovelty(prev: ArrayLike<number>, next: ArrayLike<number>): number {
  const l1 = l1Dist(prev, next) / 2; // typical range ~0–2 after L2 norm
  const cosD = 1 - cosine(prev, next);
  return 0.55 * l1 + 0.45 * cosD;
}

/**
 * Score how well `phase` places harmonic changes on downbeats.
 * Novelty at beat i is the change entering beat i.
 * Early changes (up to ~½ beat before the barline → novelty on beat pos 3)
 * also credit the following downbeat.
 */
export function scoreDownbeatPhase(
  novelty: ArrayLike<number>,
  phase: number,
  beatsPerBar = 4,
  earlyWeight = 0.7,
): number {
  let score = 0;
  let n = 0;
  for (let i = 1; i < novelty.length; i++) {
    const barPos = (((i - phase) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    const nov = novelty[i]!;
    if (barPos === 0) {
      score += nov;
      n++;
    } else if (barPos === beatsPerBar - 1) {
      // Change just before next downbeat (anticipation)
      score += earlyWeight * nov;
      n++;
    } else if (barPos === 2) {
      // Half-bar changes are mildly informative
      score += 0.25 * nov;
    } else {
      // Changes on weak beats argue against this phase
      score -= 0.15 * nov;
    }
  }
  return n > 0 ? score : -Infinity;
}

export function pickBestPhase(novelty: ArrayLike<number>, beatsPerBar = 4): {
  phase: number;
  scores: number[];
} {
  const scores: number[] = [];
  let best = 0;
  let bestS = -Infinity;
  for (let p = 0; p < beatsPerBar; p++) {
    const s = scoreDownbeatPhase(novelty, p, beatsPerBar);
    scores.push(s);
    if (s > bestS) {
      bestS = s;
      best = p;
    }
  }
  return { phase: best, scores };
}

/**
 * Estimate downbeat phase from per-beat chromas.
 * Optional local re-phase every `chunkBars` bars (default 8) with continuity bias.
 */
export function estimateDownbeatFromBeatChromas(
  beatChromas: Float32Array[],
  options: {
    beatsPerBar?: number;
    /** Re-estimate phase every N bars; 0 = global only. Default 8. */
    chunkBars?: number;
    continuityBonus?: number;
  } = {},
): DownbeatEstimate {
  const beatsPerBar = options.beatsPerBar ?? 4;
  const chunkBars = options.chunkBars ?? 8;
  const continuityBonus = options.continuityBonus ?? 0.12;
  const n = beatChromas.length;

  const novelty = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    novelty[i] = harmonicNovelty(beatChromas[i - 1]!, beatChromas[i]!);
  }

  const global = pickBestPhase(novelty, beatsPerBar);
  const beatInBar = new Array<number>(n);
  const chunkPhases: number[] = [];

  if (!chunkBars || chunkBars <= 0 || n < beatsPerBar * chunkBars * 2) {
    for (let i = 0; i < n; i++) {
      beatInBar[i] = (((i - global.phase) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    }
    chunkPhases.push(global.phase);
    return {
      phase: global.phase,
      phaseScores: global.scores,
      beatInBar,
      chunkPhases,
    };
  }

  const chunkBeats = chunkBars * beatsPerBar;
  let prevPhase = global.phase;
  for (let start = 0; start < n; start += chunkBeats) {
    const end = Math.min(n, start + chunkBeats);
    const localNov = novelty.subarray(start, end);
    // Need a small prefix for novelty[1] semantics — use full-slice scores with offset
    const scores: number[] = [];
    let best = prevPhase;
    let bestS = -Infinity;
    for (let p = 0; p < beatsPerBar; p++) {
      let s = 0;
      for (let i = 1; i < localNov.length; i++) {
        const gi = start + i;
        const barPos = (((gi - p) % beatsPerBar) + beatsPerBar) % beatsPerBar;
        const nov = novelty[gi]!;
        if (barPos === 0) s += nov;
        else if (barPos === beatsPerBar - 1) s += 0.7 * nov;
        else if (barPos === 2) s += 0.25 * nov;
        else s -= 0.15 * nov;
      }
      if (p === prevPhase) s += continuityBonus * (end - start);
      scores.push(s);
      if (s > bestS) {
        bestS = s;
        best = p;
      }
    }
    chunkPhases.push(best);
    for (let i = start; i < end; i++) {
      beatInBar[i] = (((i - best) % beatsPerBar) + beatsPerBar) % beatsPerBar;
    }
    prevPhase = best;
  }

  // Majority phase as global report
  const counts = new Array(beatsPerBar).fill(0);
  for (const p of chunkPhases) counts[p]!++;
  let phase = global.phase;
  let maxC = -1;
  for (let p = 0; p < beatsPerBar; p++) {
    if (counts[p]! > maxC) {
      maxC = counts[p]!;
      phase = p;
    }
  }

  return {
    phase,
    phaseScores: global.scores,
    beatInBar,
    chunkPhases,
  };
}

/** Build L2-normalized chroma list from a callback (e.g. note histograms). */
export function buildBeatChromas(
  beatCount: number,
  chromaFn: (beatIndex: number) => Float32Array,
): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < beatCount; i++) {
    const c = chromaFn(i);
    const copy = new Float32Array(12);
    copy.set(c);
    normalizeL2(copy);
    out.push(copy);
  }
  return out;
}
