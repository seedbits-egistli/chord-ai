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

  for (const t of templates) {
    let score = cosineSimilarity(chroma, t.vector);
    // Bass: strongly prefer root in bass (separates F vs Am, etc.)
    const bassAgree = cosineSimilarity(bassChroma, t.bassBias);
    score += 0.22 * bassWeight * bassAgree;
    // Soft penalty if dominant bass PC is far from root/third/fifth
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
    score -= complexityWeight * qualityComplexity(t.quality);
    if (noisy && qualityComplexity(t.quality) >= 2) score -= 0.12;
    if (keyPrior) {
      if (useEnhancedKey) {
        score += 0.055 * keyConf * diatonicBonus(t.root, t.quality, keyPrior);
        if (scale) score -= keyConf * outOfKeyTonePenalty(t.root, t.quality, scale);
      } else {
        // Legacy string keyPrior path (fast mode / older callers)
        score += 0.045 * diatonicBonus(t.root, t.quality, keyPrior);
      }
    }

    // Guard: a single neighbor-semitone shouldn't invent aug (#5)
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
