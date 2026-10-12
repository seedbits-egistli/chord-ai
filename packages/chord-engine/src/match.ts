import { formatChord, qualityComplexity, simplifyLabel } from './chordParse.js';
import { cosineSimilarity, getTemplates } from './templates.js';
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
}

function nameToPc(n: string): number | null {
  const map: Record<string, number> = {
    C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5,
    'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11,
  };
  return map[n] ?? null;
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
  return 0.15;
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
    if (keyPrior) score += 0.045 * diatonicBonus(t.root, t.quality, keyPrior);

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
  if (observations.length === 0) return [];
  const T = observations.length;
  const pathScore: number[][] = [];
  const back: number[][] = [];

  for (let t = 0; t < T; t++) {
    const cands = observations[t]!.candidates;
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
        else if (sameRoot) s += selfBias * 0.35;
        else s -= 0.12;
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
