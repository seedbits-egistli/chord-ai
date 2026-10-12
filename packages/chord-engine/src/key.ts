import { pcToName, preferFlatsForKey } from './notes.js';
import { cosineSimilarity } from './templates.js';

/** Krumhansl-Schmuckler key profiles (major / minor). */
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const MINOR_PROFILE = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

function rotate(profile: number[], root: number): Float32Array {
  const v = new Float32Array(12);
  for (let i = 0; i < 12; i++) v[i] = profile[(i - root + 12) % 12]!;
  // normalize
  let n = 0;
  for (let i = 0; i < 12; i++) n += v[i]! * v[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 12; i++) v[i]! /= n;
  return v;
}

export function detectKey(globalChroma: ArrayLike<number>): string {
  let best = 'C';
  let bestScore = -Infinity;
  for (let root = 0; root < 12; root++) {
    const maj = cosineSimilarity(globalChroma, rotate(MAJOR_PROFILE, root));
    const min = cosineSimilarity(globalChroma, rotate(MINOR_PROFILE, root));
    if (maj > bestScore) {
      bestScore = maj;
      best = pcToName(root, preferFlatsForKey(pcToName(root, false)));
      // Prefer flats naming for flat keys
      const sharp = pcToName(root, false);
      const flat = pcToName(root, true);
      best = preferFlatsForKey(flat) || preferFlatsForKey(sharp) ? flat : sharp;
      // Actually check FLAT_KEYS against major key name
      best = preferFlatsForKey(flat) ? flat : sharp;
    }
    if (min > bestScore) {
      bestScore = min;
      const sharp = pcToName(root, false) + 'm';
      const flat = pcToName(root, true) + 'm';
      best = preferFlatsForKey(flat) ? flat : sharp;
    }
  }
  return best;
}

/** Global average chroma from frame list */
export function globalChromaFromFrames(
  frames: Array<{ chroma: Float32Array }>,
): Float32Array {
  const g = new Float32Array(12);
  for (const f of frames) {
    for (let i = 0; i < 12; i++) g[i]! += f.chroma[i]!;
  }
  let n = 0;
  for (let i = 0; i < 12; i++) n += g[i]! * g[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 12; i++) g[i]! /= n;
  return g;
}
