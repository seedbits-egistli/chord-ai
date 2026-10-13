import { formatChord, qualityComplexity, simplifyLabel } from './chordParse.js';
import { QUALITY_INTERVALS, cosineSimilarity, getTemplates } from './templates.js';
import type { ChordLabel, ChordQuality } from './types.js';

export interface MatchCandidate {
  label: ChordLabel;
  score: number;
}

/** Optional match priors. Passing a string keyPrior keeps legacy behavior (+ aug guard). */
export interface MatchContext {
  keyPrior?: string;
  /** Scales bass agreement (default 1). Lower when bass stem energy is weak. */
  bassWeight?: number;
  /** 0–1 scales out-of-key tone penalty. Default 0.55 when keyPrior set. */
  keyConfidence?: number;
  /**
   * Per-PC drone strength 0–1. Discounted for chord-identity scoring, but
   * distinctive sus/7 tones that move vs neighbours are restored by caller
   * (pass already-adjusted chroma) or via `localNovelty`.
   */
  droneStrength?: ArrayLike<number>;
  /** Per-PC local novelty 0–1 (change vs neighbour beats). */
  localNovelty?: ArrayLike<number>;
  /**
   * Enable size-normalised presence blend + sus/7 distinctive bonuses +
   * drone identity discount. Off by default (preserves strong-bass pop scores).
   */
  extendedHarmony?: boolean;
}

function nameToPc(n: string): number | null {
  const map: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
  };
  return map[n] ?? null;
}

function scalePcs(key: string): Set<number> | null {
  const isMinor = key.endsWith('m');
  const keyRootName = isMinor ? key.slice(0, -1) : key;
  const kr = nameToPc(keyRootName);
  if (kr === null) return null;
  const intervals = isMinor
    ? [0, 2, 3, 5, 7, 8, 10]
    : [0, 2, 4, 5, 7, 9, 11];
  return new Set(intervals.map((i) => (kr + i) % 12));
}

function diatonicBonus(root: number, quality: ChordQuality, key: string): number {
  const isMinor = key.endsWith('m');
  const keyRootName = isMinor ? key.slice(0, -1) : key;
  const kr = nameToPc(keyRootName);
  if (kr === null) return 0;
  const rel = (root - kr + 12) % 12;
  const majorScale = new Set([0, 2, 4, 5, 7, 9, 11]);
  const minorScale = new Set([0, 2, 3, 5, 7, 8, 10]);
  const scale = isMinor ? minorScale : majorScale;
  if (!scale.has(rel)) return -0.8;
  if (!isMinor && rel === 0 && quality === 'maj') return 1;
  if (!isMinor && rel === 5 && quality === 'maj') return 0.8;
  if (!isMinor && rel === 7 && (quality === 'maj' || quality === '7')) return 0.8;
  if (!isMinor && rel === 9 && quality === 'min') return 0.8;
  if (isMinor && rel === 0 && (quality === 'min' || quality === 'min7')) return 1;
  if (isMinor && rel === 3 && quality === 'maj') return 0.7; // relative major
  if (
    isMinor &&
    (quality === 'sus2' || quality === 'sus4' || quality === '7sus4') &&
    scale.has(rel)
  ) {
    return 0.45;
  }
  return 0.15;
}

/** Mild penalty for chord tones outside the estimated key scale. */
function outOfKeyTonePenalty(
  root: number,
  quality: ChordQuality,
  scale: Set<number>,
): number {
  const iv = QUALITY_INTERVALS[quality] ?? [0, 4, 7];
  let out = 0;
  for (const i of iv) {
    if (!scale.has((root + i) % 12)) out++;
  }
  if (out === 0) return 0;
  let pen = 0.05 * out;
  if (quality === 'aug') pen += 0.12;
  if (quality === 'dim' || quality === 'dim7') pen += 0.06;
  return pen;
}

/**
 * Size-normalised template presence: mean energy on chord tones minus mean
 * on non-tones. Fairer to sus4/7sus4 (3–4 tones) vs triads than raw cosine
 * alone when drones inflate shared bins.
 */
export function templatePresenceScore(
  chroma: ArrayLike<number>,
  root: number,
  quality: ChordQuality,
): number {
  const iv = QUALITY_INTERVALS[quality] ?? [0, 4, 7];
  const on = new Set(iv.map((i) => (root + i) % 12));
  let sumOn = 0;
  let sumOff = 0;
  let nOn = 0;
  let nOff = 0;
  for (let p = 0; p < 12; p++) {
    if (on.has(p)) {
      sumOn += chroma[p]!;
      nOn++;
    } else {
      sumOff += chroma[p]!;
      nOff++;
    }
  }
  return (nOn ? sumOn / nOn : 0) - (nOff ? sumOff / nOff : 0);
}

/** Bonus when distinctive sus/7 intervals stand out vs competing triad tones. */
function distinctiveIntervalBonus(
  chroma: ArrayLike<number>,
  root: number,
  quality: ChordQuality,
  peak: number,
  localNovelty?: ArrayLike<number> | null,
): number {
  let bonus = 0;
  const fourth = chroma[(root + 5) % 12]!;
  const thirdM = chroma[(root + 4) % 12]!;
  const thirdm = chroma[(root + 3) % 12]!;
  const b7 = chroma[(root + 10) % 12]!;
  const nov4 = localNovelty?.[(root + 5) % 12] ?? 0.5;
  const nov7 = localNovelty?.[(root + 10) % 12] ?? 0.5;

  if (quality === 'sus4' || quality === '7sus4') {
    if (fourth > peak * 0.32 && fourth >= thirdM * 1.05 && fourth >= thirdm * 1.05) {
      bonus += 0.08 + 0.05 * Math.min(1, nov4);
    }
  }
  if (quality === '7' || quality === '7sus4' || quality === 'min7') {
    if (b7 > peak * 0.28) bonus += 0.05 + 0.04 * Math.min(1, nov7);
  }
  if (quality === 'maj' || quality === 'min') {
    if (fourth > peak * 0.5 && fourth > Math.max(thirdM, thirdm) * 1.35) {
      bonus -= 0.05;
    }
  }
  return bonus;
}

/** Top-k matches for Viterbi */
export function topKMatches(
  chroma: ArrayLike<number>,
  bassChroma: ArrayLike<number>,
  simplifyLevel: number,
  k = 5,
  keyPriorOrCtx?: string | MatchContext,
): MatchCandidate[] {
  const ctx: MatchContext =
    typeof keyPriorOrCtx === 'string' || keyPriorOrCtx === undefined
      ? { keyPrior: keyPriorOrCtx }
      : keyPriorOrCtx;
  const keyPrior = ctx.keyPrior;
  const bassWeight = Math.max(0, Math.min(1.5, ctx.bassWeight ?? 1));
  const useEnhancedKey = ctx.keyConfidence !== undefined;
  const keyConf = Math.max(0, Math.min(1, ctx.keyConfidence ?? 0));
  const scale =
    keyPrior && useEnhancedKey && keyConf > 0.3 ? scalePcs(keyPrior) : null;

  const templates = getTemplates();
  const scored: MatchCandidate[] = [];
  const complexityWeight = 0.05 + simplifyLevel * 0.28;

  // Precompute chroma energy concentration — noisy frames prefer simple chords
  let peak = 0;
  for (let i = 0; i < 12; i++) peak = Math.max(peak, chroma[i]!);
  const noisy = peak < 0.45;

  const ext = !!ctx.extendedHarmony;
  const drone = ext ? ctx.droneStrength : undefined;
  const novelty = ext ? ctx.localNovelty : undefined;

  for (const t of templates) {
    const cos = cosineSimilarity(chroma, t.vector);
    let score = cos;
    if (ext) {
      const presence = templatePresenceScore(chroma, t.root, t.quality);
      score = 0.8 * cos + 0.2 * Math.max(-0.5, Math.min(1.2, presence));
    }

    if (drone) {
      const iv = QUALITY_INTERVALS[t.quality] ?? [0, 4, 7];
      let dronePen = 0;
      for (const i of iv) {
        const pc = (t.root + i) % 12;
        const d = drone[pc] ?? 0;
        const nov = novelty?.[pc] ?? 0;
        const keep =
          (t.quality === 'sus4' || t.quality === '7sus4' || t.quality === '7') &&
          (i === 5 || i === 10) &&
          nov > 0.35;
        if (d > 0.45 && !keep) dronePen += 0.025 * d;
      }
      score -= dronePen;
    }

    // Bass: strongly prefer root in bass (separates F vs Am, etc.)
    const bassAgree = cosineSimilarity(bassChroma, t.bassBias);
    score += 0.22 * bassWeight * bassAgree;
    let bassPc = 0;
    let bassPeak = -1;
    for (let i = 0; i < 12; i++) {
      if (bassChroma[i]! > bassPeak) {
        bassPeak = bassChroma[i]!;
        bassPc = i;
      }
    }
    if (bassPeak > 0.25 && bassWeight > 0.15) {
      const rel = (bassPc - t.root + 12) % 12;
      if (rel !== 0 && rel !== 3 && rel !== 4 && rel !== 7 && rel !== 10) {
        score -= 0.08 * bassWeight;
      }
      if (rel === 0) score += 0.06 * bassWeight;
    }
    let cq = qualityComplexity(t.quality);
    if (ext && (t.quality === 'sus4' || t.quality === '7sus4')) cq = Math.max(0, cq - 0.5);
    score -= complexityWeight * cq;
    if (noisy && cq >= 2) score -= 0.12;

    if (ext) score += distinctiveIntervalBonus(chroma, t.root, t.quality, peak, novelty);

    if (keyPrior) {
      if (useEnhancedKey) {
        score += 0.055 * keyConf * diatonicBonus(t.root, t.quality, keyPrior);
        if (scale) score -= keyConf * outOfKeyTonePenalty(t.root, t.quality, scale);
      } else {
        score += 0.045 * diatonicBonus(t.root, t.quality, keyPrior);
      }
    }

    if (t.quality === 'aug') {
      const sharp5 = chroma[(t.root + 8) % 12]!;
      const fifth = chroma[(t.root + 7) % 12]!;
      const rootE = chroma[t.root]!;
      if (sharp5 < peak * 0.6 || sharp5 < fifth * 0.95 || sharp5 < rootE * 0.7) {
        score -= 0.25;
      }
    }

    scored.push({ label: { root: t.root, quality: t.quality }, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map((c) => ({
    label: simplifyLabel(c.label, simplifyLevel),
    score: c.score,
  }));
}

export function matchChord(
  chroma: ArrayLike<number>,
  bassChroma: ArrayLike<number>,
  simplifyLevel: number,
  keyPriorOrCtx?: string | MatchContext,
): MatchCandidate {
  return topKMatches(chroma, bassChroma, simplifyLevel, 1, keyPriorOrCtx)[0]!;
}

export interface BeatObservation {
  startMs: number;
  endMs: number;
  candidates: MatchCandidate[];
}

function labelKey(l: ChordLabel): string {
  return formatChord(l, false);
}

/**
 * Viterbi smoothing — prefer staying on same chord / same root.
 */
export function viterbiSmooth(observations: BeatObservation[], selfBias = 0.35): ChordLabel[] {
  return viterbiSmoothMetric(
    observations,
    observations.map(() => 0),
    { selfBias, changeCost: [-0.12, -0.12, -0.12, -0.12] },
  );
}

export interface MetricViterbiOptions {
  /** Bonus for staying on the same label. Default 0.55. */
  selfBias?: number;
  /** Extra stay bonus for same root / different quality. Default 0.18. */
  sameRootBias?: number;
  /**
   * Additive score when *changing* chord into metric position 0..3
   * (0 = downbeat). More negative = harder to change.
   * Default: easy on 1, medium on 3, hard on 2/4.
   */
  changeCost?: [number, number, number, number];
}

/**
 * Beat-level HMM/Viterbi with metric-position transition prior (training-free).
 * Simplifies Mauch & Dixon (2010) metric-position dependence without learning.
 */
export function viterbiSmoothMetric(
  observations: BeatObservation[],
  beatInBar: number[],
  options: MetricViterbiOptions = {},
): ChordLabel[] {
  if (observations.length === 0) return [];
  const T = observations.length;
  const selfBias = options.selfBias ?? 0.55;
  const sameRootBias = options.sameRootBias ?? 0.18;
  // Hand-set: change preferred at downbeat (0), ok at beat 3 (2), rare on 2/4
  const changeCost = options.changeCost ?? [-0.04, -0.28, -0.12, -0.26];

  const pathScore: number[][] = [];
  const back: number[][] = [];

  for (let t = 0; t < T; t++) {
    const cands = observations[t]!.candidates;
    const pos = beatInBar[t] ?? 0;
    const chCost = changeCost[((pos % 4) + 4) % 4]!;
    pathScore[t] = [];
    back[t] = [];
    for (let j = 0; j < cands.length; j++) {
      if (t === 0) {
        pathScore[t]![j] = cands[j]!.score;
        back[t]![j] = -1;
        continue;
      }
      let best = -Infinity;
      let bestI = 0;
      const prev = observations[t - 1]!.candidates;
      for (let i = 0; i < prev.length; i++) {
        let s = pathScore[t - 1]![i]! + cands[j]!.score;
        const same = labelKey(prev[i]!.label) === labelKey(cands[j]!.label);
        const sameRoot = prev[i]!.label.root === cands[j]!.label.root;
        if (same) s += selfBias;
        else if (sameRoot) s += sameRootBias + chCost * 0.35;
        else s += chCost;
        if (s > best) {
          best = s;
          bestI = i;
        }
      }
      pathScore[t]![j] = best;
      back[t]![j] = bestI;
    }
  }

  let last = 0;
  let bestLast = -Infinity;
  const lastC = observations[T - 1]!.candidates;
  for (let j = 0; j < lastC.length; j++) {
    if (pathScore[T - 1]![j]! > bestLast) {
      bestLast = pathScore[T - 1]![j]!;
      last = j;
    }
  }
  const idx = new Array<number>(T);
  idx[T - 1] = last;
  for (let t = T - 1; t > 0; t--) {
    idx[t - 1] = back[t]![idx[t]!]!;
  }
  return idx.map((j, t) => observations[t]!.candidates[j]!.label);
}
