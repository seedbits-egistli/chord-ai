import type { ChordQuality } from './types.js';

/** Pitch-class intervals from root for each quality (MIT). */
export const QUALITY_INTERVALS: Record<ChordQuality, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  '6': [0, 4, 7, 9],
  min6: [0, 3, 7, 9],
  '9': [0, 4, 7, 10, 2],
  maj9: [0, 4, 7, 11, 2],
  min9: [0, 3, 7, 10, 2],
  add9: [0, 4, 7, 2],
  '11': [0, 4, 7, 10, 2, 5],
  '13': [0, 4, 7, 10, 2, 9],
  '7sus4': [0, 5, 7, 10],
};

export interface ChordTemplate {
  root: number;
  quality: ChordQuality;
  /** L2-normalized 12-bin chroma template */
  vector: Float32Array;
  /** Optional bass emphasis template (same length) */
  bassBias: Float32Array;
}

function buildVector(intervals: number[], root: number): Float32Array {
  const v = new Float32Array(12);
  for (const iv of intervals) {
    v[(root + iv) % 12] += 1;
  }
  // Slight extra weight on root & fifth for stability
  v[root % 12] += 0.35;
  v[(root + 7) % 12] += 0.15;
  // L2 normalize
  let n = 0;
  for (let i = 0; i < 12; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 12; i++) v[i]! /= n;
  return v;
}

function buildBassBias(root: number, bass?: number): Float32Array {
  const v = new Float32Array(12);
  const b = bass ?? root;
  v[b % 12] = 1;
  let n = 0;
  for (let i = 0; i < 12; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 12; i++) v[i]! /= n;
  return v;
}

let CACHE: ChordTemplate[] | null = null;

/** All root × quality templates (12 × qualities). Slash templates added at match time via bass. */
export function getTemplates(): ChordTemplate[] {
  if (CACHE) return CACHE;
  const list: ChordTemplate[] = [];
  const qualities = Object.keys(QUALITY_INTERVALS) as ChordQuality[];
  for (let root = 0; root < 12; root++) {
    for (const quality of qualities) {
      list.push({
        root,
        quality,
        vector: buildVector(QUALITY_INTERVALS[quality], root),
        bassBias: buildBassBias(root),
      });
    }
  }
  CACHE = list;
  return list;
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d > 0 ? dot / d : 0;
}
