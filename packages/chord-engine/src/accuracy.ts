import { parseChord, toMajorMinorClass, formatChord } from './chordParse.js';
import { QUALITY_INTERVALS } from './templates.js';
import type { ChordEvent, ChordQuality, ReferenceSegment } from './types.js';

/** Per-beat tone-overlap breakdown (pitch-class sets). */
export interface ToneOverlapDetail {
  jaccard: number;
  recall: number;
  rootMatch: boolean;
  /** Headline per-beat score: 0.55·J + 0.35·recall + 0.10·root */
  weighted: number;
}

export interface AccuracyResult {
  beats: number;
  /** Headline metric: mean weighted PC tone-overlap (0–100). */
  toneOverlapPct: number;
  /** Mean Jaccard |A∩B|/|A∪B| (0–100). */
  toneJaccardPct: number;
  /** Mean recall of reference pitch classes |A∩B|/|A| (0–100). */
  toneRecallPct: number;
  /** Fraction of beats with matching root (0–100). */
  rootMatchPct: number;
  exactCorrect: number;
  exactPct: number;
  majMinCorrect: number;
  majMinPct: number;
  offsetMs: number;
  details: Array<{
    beat: number;
    ref: string;
    hyp: string;
    exact: boolean;
    majMin: boolean;
    tone: ToneOverlapDetail;
  }>;
}

/** Weights for the headline tone-overlap score (sum = 1). */
export const TONE_OVERLAP_WEIGHTS = {
  jaccard: 0.55,
  recall: 0.35,
  root: 0.1,
} as const;

function normalizeEnharmonic(chord: string): string {
  const p = parseChord(chord);
  if (!p) return chord;
  return formatChord(p, false);
}

export function exactMatch(ref: string, hyp: string): boolean {
  if (normalizeEnharmonic(ref) === normalizeEnharmonic(hyp)) return true;
  const a = parseChord(ref);
  const b = parseChord(hyp);
  if (!a || !b || a.root !== b.root) return false;
  const fam = (q: string) => {
    if (['maj', '6', 'add9', 'maj7', 'maj9'].includes(q)) return 'maj';
    if (['min', 'min6', 'min7', 'min9'].includes(q)) return 'min';
    if (['7', '9', '11', '13'].includes(q)) return '7';
    if (['sus2', 'sus4', '7sus4'].includes(q)) return 'sus';
    if (['dim', 'dim7', 'm7b5'].includes(q)) return 'dim';
    if (q === 'aug') return 'aug';
    return q;
  };
  return fam(a.quality) === fam(b.quality);
}

/** Pitch-class set of a chord symbol (quality intervals + optional bass). */
export function pitchClassSet(chord: string): Set<number> {
  const p = parseChord(chord);
  if (!p || chord === 'N' || chord === 'X') return new Set();
  const iv = QUALITY_INTERVALS[p.quality as ChordQuality] ?? [0, 4, 7];
  const s = new Set(iv.map((i) => (p.root + i) % 12));
  if (p.bass !== undefined) s.add(p.bass % 12);
  return s;
}

/**
 * Pitch-class tone overlap between reference and hypothesis chords.
 * Primary evaluation: shared chord tones, not chord-name equality.
 */
export function toneOverlap(ref: string, hyp: string): ToneOverlapDetail {
  const a = pitchClassSet(ref);
  const b = pitchClassSet(hyp);
  const pa = parseChord(ref);
  const pb = parseChord(hyp);
  const rootMatch = !!(pa && pb && pa.root === pb.root);

  if (!a.size && !b.size) {
    return { jaccard: 1, recall: 1, rootMatch: true, weighted: 1 };
  }
  if (!a.size) {
    return {
      jaccard: 0,
      recall: 0,
      rootMatch,
      weighted:
        TONE_OVERLAP_WEIGHTS.jaccard * 0 +
        TONE_OVERLAP_WEIGHTS.recall * 0 +
        TONE_OVERLAP_WEIGHTS.root * (rootMatch ? 1 : 0),
    };
  }

  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  const jaccard = union ? inter / union : 0;
  const recall = inter / a.size;
  const weighted =
    TONE_OVERLAP_WEIGHTS.jaccard * jaccard +
    TONE_OVERLAP_WEIGHTS.recall * recall +
    TONE_OVERLAP_WEIGHTS.root * (rootMatch ? 1 : 0);

  return { jaccard, recall, rootMatch, weighted };
}

function chordAtTime(events: ChordEvent[], tMs: number): string {
  for (const e of events) {
    if (tMs >= e.tMs && tMs < e.endMs) return e.chord;
  }
  let best = events[0]?.chord ?? 'N';
  let bestDist = Infinity;
  for (const e of events) {
    const mid = (e.tMs + e.endMs) / 2;
    const d = Math.abs(mid - tMs);
    if (d < bestDist) {
      bestDist = d;
      best = e.chord;
    }
  }
  return best;
}

function refAtBeat(segments: ReferenceSegment[], beat: number): string {
  for (const s of segments) {
    if (beat >= s.startBeat && beat < s.endBeat) return s.chord;
  }
  return segments[segments.length - 1]?.chord ?? 'N';
}

function rootClass(chord: string): number {
  const mm = toMajorMinorClass(chord);
  if (!mm) return -1;
  const p = parseChord(mm);
  if (!p) return -1;
  return p.root + (p.quality === 'min' ? 12 : 0); // 0-11 maj, 12-23 min
}

function emptyResult(offsetMs = 0): AccuracyResult {
  return {
    beats: 0,
    toneOverlapPct: 0,
    toneJaccardPct: 0,
    toneRecallPct: 0,
    rootMatchPct: 0,
    exactCorrect: 0,
    exactPct: 0,
    majMinCorrect: 0,
    majMinPct: 0,
    offsetMs,
    details: [],
  };
}

function finalize(
  details: AccuracyResult['details'],
  exactCorrect: number,
  majMinCorrect: number,
  offsetMs: number,
): AccuracyResult {
  const n = details.length || 1;
  const toneSum = details.reduce((s, d) => s + d.tone.weighted, 0);
  const jacSum = details.reduce((s, d) => s + d.tone.jaccard, 0);
  const recSum = details.reduce((s, d) => s + d.tone.recall, 0);
  const rootHits = details.reduce((s, d) => s + (d.tone.rootMatch ? 1 : 0), 0);
  const beats = details.length;
  return {
    beats,
    toneOverlapPct: beats ? (toneSum / n) * 100 : 0,
    toneJaccardPct: beats ? (jacSum / n) * 100 : 0,
    toneRecallPct: beats ? (recSum / n) * 100 : 0,
    rootMatchPct: beats ? (rootHits / n) * 100 : 0,
    exactCorrect,
    exactPct: beats ? (exactCorrect / n) * 100 : 0,
    majMinCorrect,
    majMinPct: beats ? (majMinCorrect / n) * 100 : 0,
    offsetMs,
    details,
  };
}

function betterResult(a: AccuracyResult, b: AccuracyResult): boolean {
  if (b.toneOverlapPct > a.toneOverlapPct + 1e-9) return true;
  if (Math.abs(b.toneOverlapPct - a.toneOverlapPct) > 1e-9) return false;
  if (b.majMinPct > a.majMinPct + 1e-9) return true;
  if (Math.abs(b.majMinPct - a.majMinPct) > 1e-9) return false;
  return b.exactPct > a.exactPct;
}

export function scoreAgainstReference(
  detected: ChordEvent[],
  segments: ReferenceSegment[],
  bpm: number,
  offsetMs = 0,
): AccuracyResult {
  const totalBeats = Math.floor(segments.reduce((m, s) => Math.max(m, s.endBeat), 0));
  const beatMs = 60000 / bpm;
  const details: AccuracyResult['details'] = [];
  let exactCorrect = 0;
  let majMinCorrect = 0;

  for (let b = 0; b < totalBeats; b++) {
    const t = offsetMs + b * beatMs + beatMs * 0.5;
    const ref = refAtBeat(segments, b);
    const hyp = chordAtTime(detected, t);
    const exact = exactMatch(ref, hyp);
    const majMin = toMajorMinorClass(ref) === toMajorMinorClass(hyp) && !!toMajorMinorClass(ref);
    if (exact) exactCorrect++;
    if (majMin) majMinCorrect++;
    details.push({ beat: b, ref, hyp, exact, majMin, tone: toneOverlap(ref, hyp) });
  }

  return finalize(details, exactCorrect, majMinCorrect, offsetMs);
}

/**
 * Align hyp vs timed reference by maximizing headline tone-overlap over lag,
 * then score with majority-vote inside each beat (more robust on real mixes).
 * Optionally samples half-bars (2× per bar in 4/4) when `halfBar` is true.
 */
export function scoreAgainstTimedReference(
  detected: ChordEvent[],
  segmentsMs: Array<{ chord: string; startMs: number; endMs: number }>,
  options: {
    bpm: number;
    maxOffsetMs?: number;
    durationMs?: number;
    /** Score every half-bar (2 beats) midpoint as well as beat midpoints. Default: beat. */
    halfBar?: boolean;
  } = { bpm: 120 },
): AccuracyResult {
  const maxOffset = options.maxOffsetMs ?? 8000;
  const durationMs =
    options.durationMs ??
    Math.min(
      segmentsMs.reduce((m, s) => Math.max(m, s.endMs), 0),
      detected.reduce((m, e) => Math.max(m, e.endMs), 0),
    );
  // Step in half-beats when halfBar; otherwise full beats.
  const stepBeats = options.halfBar ? 0.5 : 1;

  let best: AccuracyResult | null = null;

  for (const bpmScale of [1, 0.985, 1.015, 0.97, 1.03]) {
    const beatMs = (60000 / options.bpm) * bpmScale;
    const stepMs = beatMs * stepBeats;
    const refSeq: string[] = [];
    for (let t = stepMs * 0.5; t < durationMs; t += stepMs) {
      let ref = 'N';
      for (const s of segmentsMs) {
        if (t >= s.startMs && t < s.endMs) {
          ref = s.chord;
          break;
        }
      }
      refSeq.push(ref);
    }
    if (refSeq.length < 8) continue;

    const hypAt = (t: number) => chordAtTime(detected, t);
    const hypStart = detected[0]?.tMs ?? 0;
    const hypSeq = refSeq.map((_, i) => {
      const t = i * stepMs + stepMs * 0.5;
      if (t < hypStart) return 'N';
      return hypAt(t);
    });

    // Align on tone-overlap (headline), with maj/min root class as fallback fill
    const maxLagSteps = Math.floor(maxOffset / stepMs);
    let bestLag = 0;
    let bestCorr = -Infinity;
    const body0 = Math.floor(refSeq.length * 0.1);
    const body1 = Math.floor(refSeq.length * 0.85);
    for (let lag = -maxLagSteps; lag <= maxLagSteps; lag++) {
      let sum = 0;
      let n = 0;
      for (let i = body0; i < body1; i++) {
        const j = i + lag;
        if (j < 0 || j >= hypSeq.length) continue;
        const ref = refSeq[i]!;
        const hyp = hypSeq[j]!;
        if (ref === 'N' || hyp === 'N') continue;
        n++;
        sum += toneOverlap(ref, hyp).weighted;
      }
      if (n < 16) continue;
      const corr = sum / n;
      if (corr > bestCorr) {
        bestCorr = corr;
        bestLag = lag;
      }
    }

    // Fallback lag via maj/min if tone alignment found nothing
    if (!Number.isFinite(bestCorr) || bestCorr < 0) {
      const refRC = refSeq.map(rootClass);
      const hypRC = hypSeq.map(rootClass);
      for (let lag = -maxLagSteps; lag <= maxLagSteps; lag++) {
        let hit = 0;
        let n = 0;
        for (let i = body0; i < body1; i++) {
          const j = i + lag;
          if (j < 0 || j >= hypRC.length) continue;
          if (refRC[i]! < 0 || hypRC[j]! < 0) continue;
          n++;
          if (refRC[i] === hypRC[j]) hit++;
        }
        if (n < 16) continue;
        const corr = hit / n;
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }
    }

    let exactCorrect = 0;
    let majMinCorrect = 0;
    const details: AccuracyResult['details'] = [];
    for (let i = 0; i < refSeq.length; i++) {
      const ref = refSeq[i]!;
      if (ref === 'N') continue;
      const t0 = (i + bestLag) * stepMs;
      const t1 = t0 + stepMs;
      if (t1 < 0 || t0 > durationMs) continue;
      const votes = new Map<string, number>();
      for (let t = t0 + stepMs * 0.15; t < t1; t += stepMs / 4) {
        const h = hypAt(t);
        votes.set(h, (votes.get(h) ?? 0) + 1);
      }
      let hyp = 'N';
      let bestV = 0;
      for (const [k, v] of votes) {
        if (v > bestV) {
          bestV = v;
          hyp = k;
        }
      }
      const exact = exactMatch(ref, hyp);
      const majMin = toMajorMinorClass(ref) === toMajorMinorClass(hyp) && !!toMajorMinorClass(ref);
      if (exact) exactCorrect++;
      if (majMin) majMinCorrect++;
      details.push({
        beat: i,
        ref,
        hyp,
        exact,
        majMin,
        tone: toneOverlap(ref, hyp),
      });
    }
    if (!details.length) continue;
    // Cap stored details for harness size but metrics use full list above —
    // keep full details for correctness of averages (200 was only for logging).
    const result = finalize(details, exactCorrect, majMinCorrect, Math.round(bestLag * stepMs));
    if (!best || betterResult(best, result)) best = result;
  }

  return best ?? emptyResult();
}
