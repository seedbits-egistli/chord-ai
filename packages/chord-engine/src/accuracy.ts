import { parseChord, toMajorMinorClass, formatChord } from './chordParse.js';
import type { ChordEvent, ReferenceSegment } from './types.js';

export interface AccuracyResult {
  beats: number;
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
  }>;
}

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
    details.push({ beat: b, ref, hyp, exact, majMin });
  }

  const beats = totalBeats || 1;
  return {
    beats,
    exactCorrect,
    exactPct: (exactCorrect / beats) * 100,
    majMinCorrect,
    majMinPct: (majMinCorrect / beats) * 100,
    offsetMs,
    details,
  };
}

/**
 * Align hyp vs timed reference by maximizing maj/min agreement over lag,
 * then score with majority-vote inside each beat (more robust on real mixes).
 */
export function scoreAgainstTimedReference(
  detected: ChordEvent[],
  segmentsMs: Array<{ chord: string; startMs: number; endMs: number }>,
  options: { bpm: number; maxOffsetMs?: number; durationMs?: number } = { bpm: 120 },
): AccuracyResult {
  const maxOffset = options.maxOffsetMs ?? 8000;
  const durationMs =
    options.durationMs ??
    Math.min(
      segmentsMs.reduce((m, s) => Math.max(m, s.endMs), 0),
      detected.reduce((m, e) => Math.max(m, e.endMs), 0),
    );

  let best: AccuracyResult | null = null;

  for (const bpmScale of [1, 0.985, 1.015, 0.97, 1.03]) {
    const beatMs = (60000 / options.bpm) * bpmScale;
    const refSeq: string[] = [];
    for (let t = beatMs * 0.5; t < durationMs; t += beatMs) {
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
    // First detection time — don't score silence before model engages
    const hypStart = detected[0]?.tMs ?? 0;
    const hypSeq = refSeq.map((_, i) => {
      const t = i * beatMs + beatMs * 0.5;
      if (t < hypStart) return 'N';
      return hypAt(t);
    });
    const refRC = refSeq.map(rootClass);
    const hypRC = hypSeq.map(rootClass);
    const maxLagBeats = Math.floor(maxOffset / beatMs);
    let bestLag = 0;
    let bestCorr = -Infinity;
    // Prefer aligning on the middle body of the track (skip flaky intro/outro)
    const body0 = Math.floor(refRC.length * 0.1);
    const body1 = Math.floor(refRC.length * 0.85);
    for (let lag = -maxLagBeats; lag <= maxLagBeats; lag++) {
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

    let exactCorrect = 0;
    let majMinCorrect = 0;
    let n = 0;
    const details: AccuracyResult['details'] = [];
    for (let i = 0; i < refSeq.length; i++) {
      const ref = refSeq[i]!;
      if (ref === 'N') continue;
      // Majority vote of hyp in this beat window, shifted by lag
      const t0 = (i + bestLag) * beatMs;
      const t1 = t0 + beatMs;
      if (t1 < 0 || t0 > durationMs) continue;
      const votes = new Map<string, number>();
      for (let t = t0 + beatMs * 0.15; t < t1; t += beatMs / 4) {
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
      n++;
      if (exact) exactCorrect++;
      if (majMin) majMinCorrect++;
      if (details.length < 120) details.push({ beat: i, ref, hyp, exact, majMin });
    }
    if (n === 0) continue;
    const result: AccuracyResult = {
      beats: n,
      exactCorrect,
      exactPct: (exactCorrect / n) * 100,
      majMinCorrect,
      majMinPct: (majMinCorrect / n) * 100,
      offsetMs: Math.round(bestLag * beatMs),
      details,
    };
    if (
      !best ||
      result.majMinPct > best.majMinPct ||
      (result.majMinPct === best.majMinPct && result.exactPct > best.exactPct)
    ) {
      best = result;
    }
  }

  return (
    best ?? {
      beats: 0,
      exactCorrect: 0,
      exactPct: 0,
      majMinCorrect: 0,
      majMinPct: 0,
      offsetMs: 0,
      details: [],
    }
  );
}
