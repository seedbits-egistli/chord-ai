/**
 * BTC (Park et al., ISMIR 2019, MIT) chord recognition on CQT features + beat-synchronous decoding.
 * Port of the Python prototype (proto-v2): beat-sync log-mean-exp → bar self-similarity voting →
 * Viterbi with switch penalty; maj/min vs large-vocab chosen per song.
 */
import { logCqt, CQT_BINS } from './cqt.js';
import type { OnnxRun, Progress } from './types.js';
import type { ChordEvent } from '../types.js';

/** Feature normalisation stored in the BTC checkpoints. */
export const BTC_NORM = {
  majmin: { mean: -2.2279364109039306, std: 1.719106559064301 },
  large: { mean: -2.2279878897355596, std: 1.7191329394436938 },
};
export interface BtcModel { run: OnnxRun; mean: number; std: number; names: string[] }
const T = 108;
export const BTC_FPS = T / 10;

const ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const Q = ['m', '', 'dim', 'aug', 'm6', '6', 'm7', 'm', 'maj7', '7', 'dim7', 'm7b5', 'sus2', 'sus4'];
export function btcNames(large: boolean): string[] {
  if (!large) return [...ROOTS.flatMap((r) => [r, r + 'm']), 'N'];
  const out: string[] = [];
  for (let i = 0; i < 168; i++) out.push(ROOTS[Math.floor(i / 14)]! + Q[i % 14]!);
  return [...out, 'N', 'N'];
}

/** Frame log-probs [frames x C]. */
export async function btcLogProbs(
  feats: { data: Float32Array; frames: number },
  model: BtcModel,
  onProgress?: Progress,
): Promise<{ lp: Float32Array; frames: number; C: number }> {
  const n = feats.frames;
  const chunks = Math.ceil(n / T) || 1;
  const C = model.names.length;
  const lp = new Float32Array(n * C);
  const x = new Float32Array(T * CQT_BINS);
  for (let c = 0; c < chunks; c++) {
    x.fill(0);
    for (let t = 0; t < T; t++) {
      const f = c * T + t;
      if (f >= n) break;
      for (let k = 0; k < CQT_BINS; k++) x[t * CQT_BINS + k] = (feats.data[f * CQT_BINS + k]! - model.mean) / model.std;
    }
    const o = await model.run({ x: { data: x, dims: [1, T, CQT_BINS] } });
    const d = o.logp!.data;
    for (let t = 0; t < T; t++) {
      const f = c * T + t;
      if (f >= n) break;
      lp.set(d.subarray(t * C, (t + 1) * C), f * C);
    }
    onProgress?.((c + 1) / chunks);
  }
  return { lp, frames: n, C };
}

function logAddExp(a: number, b: number) {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m));
}

/** Beat-synchronous mean (in prob domain) → log. Returns E [beats x C] and edges (s). */
export function beatSync(lp: Float32Array, frames: number, C: number, beats: number[], dur: number) {
  const edges = [...beats, Math.min(dur, beats[beats.length - 1]! + (beats[beats.length - 1]! - beats[beats.length - 2]!))];
  if (edges[0]! > 0.05) edges.unshift(0);
  const nb = edges.length - 1;
  const E = new Float64Array(nb * C);
  for (let b = 0; b < nb; b++) {
    let i0 = Math.floor(edges[b]! * BTC_FPS);
    let i1 = Math.max(i0 + 1, Math.floor(edges[b + 1]! * BTC_FPS));
    if (i0 >= frames) { i0 = frames - 1; i1 = frames; }
    i1 = Math.min(i1, frames);
    for (let k = 0; k < C; k++) {
      let s = -Infinity;
      for (let i = i0; i < i1; i++) s = logAddExp(s, lp[i * C + k]!);
      E[b * C + k] = s - Math.log(i1 - i0);
    }
  }
  return { E, edges, nb };
}

export function viterbi(E: Float64Array, n: number, C: number, stay = 2.0): number[] {
  let D = Float64Array.from(E.subarray(0, C));
  const bp = new Int32Array(n * C);
  for (let t = 1; t < n; t++) {
    let best = 0;
    for (let k = 1; k < C; k++) if (D[k]! > D[best]!) best = k;
    const sw = D[best]! - stay;
    const ND = new Float64Array(C);
    for (let k = 0; k < C; k++) {
      if (D[k]! >= sw) { bp[t * C + k] = k; ND[k] = D[k]! + E[t * C + k]!; }
      else { bp[t * C + k] = best; ND[k] = sw + E[t * C + k]!; }
    }
    D = ND;
  }
  let last = 0;
  for (let k = 1; k < C; k++) if (D[k]! > D[last]!) last = k;
  const path = [last];
  for (let t = n - 1; t > 0; t--) path.push(bp[t * C + path[path.length - 1]!]!);
  return path.reverse();
}

/** Beat-synced chroma from the CQT (fold 144 bins → 12 by summing magnitudes of 2 bins/semitone). */
function beatChroma(feats: { data: Float32Array; frames: number }, edges: number[]): Float64Array[] {
  const out: Float64Array[] = [];
  const fps = 22050 / 2048;
  for (let b = 0; b < edges.length - 1; b++) {
    const i0 = Math.floor(edges[b]! * fps);
    const i1 = Math.max(i0 + 1, Math.floor(edges[b + 1]! * fps));
    const v = new Float64Array(12);
    for (let i = i0; i < Math.min(i1, feats.frames); i++)
      for (let k = 0; k < CQT_BINS; k++) v[Math.floor(k / 2) % 12] += Math.exp(feats.data[i * CQT_BINS + k]!);
    let nrm = 0;
    for (const x of v) nrm += x * x;
    nrm = Math.sqrt(nrm) + 1e-9;
    for (let j = 0; j < 12; j++) v[j]! /= nrm;
    out.push(v);
  }
  return out;
}

/** Blend each bar's beat posteriors with acoustically similar bars (repetition consistency). */
export function sectionVote(
  E: Float64Array, nb: number, C: number, edges: number[], downbeats: number[],
  chroma: Float64Array[], thr = 0.92, w = 0.5,
): Float64Array {
  const db = downbeats.filter((d) => d < edges[edges.length - 1]!);
  if (db.length < 4) return E;
  const barOf = new Int32Array(nb);
  for (let b = 0; b < nb; b++) {
    let k = -1;
    for (let j = 0; j < db.length; j++) if (db[j]! <= edges[b]! + 1e-3) k = j;
    barOf[b] = k;
  }
  const bars = new Map<number, number[]>();
  for (let b = 0; b < nb; b++) {
    if (barOf[b]! < 0) continue;
    const a = bars.get(barOf[b]!) ?? [];
    a.push(b);
    bars.set(barOf[b]!, a);
  }
  const keys = [...bars.keys()].filter((k) => bars.get(k)!.length >= 2);
  const P = E.map(Math.exp);
  const out = Float64Array.from(P);
  for (const k of keys) {
    const bk = bars.get(k)!;
    const acc = new Float64Array(bk.length * C);
    let cnt = 0;
    for (const j of keys) {
      const bj = bars.get(j)!;
      if (j === k || bj.length !== bk.length) continue;
      let s = 0;
      for (let i = 0; i < bk.length; i++) for (let q = 0; q < 12; q++) s += chroma[bk[i]!]![q]! * chroma[bj[i]!]![q]!;
      if (s / bk.length > thr) {
        cnt++;
        for (let i = 0; i < bk.length; i++) for (let c = 0; c < C; c++) acc[i * C + c] += P[bj[i]! * C + c]!;
      }
    }
    if (cnt) for (let i = 0; i < bk.length; i++) for (let c = 0; c < C; c++)
      out[bk[i]! * C + c] = (1 - w) * P[bk[i]! * C + c]! + (w * acc[i * C + c]!) / cnt;
  }
  return out.map((x) => Math.log(x + 1e-12));
}

const MAJ_FAMILY = new Set(['', 'aug', '6', 'maj7', '7', 'sus2', 'sus4']);
const EXT = ['7', 'sus2', 'sus4', '6', 'maj7', 'm7b5', 'dim7'];
function family(name: string): number {
  if (name === 'N') return 24;
  const r = name.length > 1 && name[1] === '#' ? name.slice(0, 2) : name[0]!;
  return ROOTS.indexOf(r) * 2 + (MAJ_FAMILY.has(name.slice(r.length)) ? 0 : 1);
}
function collapsedConf(E: Float64Array, n: number, names: string[]): number {
  const fam = names.map(family);
  const C = names.length;
  let s = 0;
  for (let t = 0; t < n; t++) {
    const acc = new Float64Array(25);
    for (let k = 0; k < C; k++) acc[fam[k]!] += Math.exp(E[t * C + k]!);
    let m = 0;
    for (const v of acc) m = Math.max(m, v);
    s += m;
  }
  return s / n;
}

/** Half-time fix: Beat This! sometimes tracks 8th notes (e.g. 136 vs 68 BPM). */
export function tempoFix(beats: number[], downbeats: number[], lp: Float32Array, frames: number, C: number) {
  const diffs = beats.slice(1).map((b, i) => b - beats[i]!).sort((a, b) => a - b);
  const bpm = 60 / diffs[Math.floor(diffs.length / 2)]!;
  const prior = (x: number) => Math.abs(Math.log(x / 90));
  const am: number[] = [];
  for (let i = 0; i < frames; i++) {
    let b = 0;
    for (let k = 1; k < C; k++) if (lp[i * C + k]! > lp[i * C + b]!) b = k;
    am.push(b);
  }
  const ch: number[] = [];
  for (let i = 1; i < am.length; i++) if (am[i] !== am[i - 1]) ch.push((i - 1) / BTC_FPS);
  let seglen = 0;
  if (ch.length > 2) {
    const d = ch.slice(1).map((x, i) => x - ch[i]!).sort((a, b) => a - b);
    const m = d.length % 2 ? d[(d.length - 1) / 2]! : (d[d.length / 2 - 1]! + d[d.length / 2]!) / 2;
    seglen = (m * bpm) / 60;
  }
  if (bpm > 110 && prior(bpm / 2) < prior(bpm) && seglen >= 3 && downbeats.length) {
    let d0 = beats.findIndex((b) => b >= downbeats[0]!);
    if (d0 < 0) d0 = 0;
    return {
      beats: beats.filter((_, i) => (((i - d0) % 2) + 2) % 2 === 0),
      downbeats: downbeats.filter((_, i) => i % 2 === 0),
      bpm: bpm / 2,
      halved: true,
    };
  }
  return { beats, downbeats, bpm, halved: false };
}

export interface BtcChordResult {
  chords: ChordEvent[];
  beats: number[];
  downbeats: number[];
  bpm: number;
  model: 'btc-majmin' | 'btc-large';
  halfTime: boolean;
  confidence: { majmin: number; large: number };
  extendedShare: number;
}

/** Full chord stage: accompaniment (22.05 kHz mono) + beats/downbeats (s) → chord events. */
export async function detectChordsBtc(
  acc: Float32Array,
  beatsIn: number[],
  downbeatsIn: number[],
  models: { majmin: BtcModel; large: BtcModel },
  onProgress?: Progress,
): Promise<BtcChordResult> {
  const dur = acc.length / 22050;
  const feats = logCqt(acc, (p) => onProgress?.(p * 0.5));
  const mm = await btcLogProbs(feats, models.majmin, (p) => onProgress?.(0.5 + p * 0.2));
  const lg = await btcLogProbs(feats, models.large, (p) => onProgress?.(0.7 + p * 0.25));
  const tf = tempoFix(beatsIn, downbeatsIn, mm.lp, mm.frames, mm.C);
  const beats = tf.beats.filter((b) => b < dur);
  const R: Record<'majmin' | 'large', { path: number[]; names: string[]; edges: number[]; conf: number; N: number; ext: number }> = {} as never;
  let chroma: Float64Array[] | null = null;
  for (const [key, lpr, model] of [['majmin', mm, models.majmin], ['large', lg, models.large]] as const) {
    const { E, edges, nb } = beatSync(lpr.lp, lpr.frames, lpr.C, beats, dur);
    chroma ??= beatChroma(feats, edges);
    const E2 = sectionVote(E, nb, lpr.C, edges, tf.downbeats, chroma);
    const path = viterbi(E2, nb, lpr.C);
    const names = model.names;
    R[key] = {
      path, names, edges,
      conf: collapsedConf(E2, nb, names),
      N: path.filter((k) => names[k] === 'N').length / path.length,
      ext: path.filter((k) => names[k] !== 'N' && EXT.some((e) => names[k]!.endsWith(e))).length / path.length,
    };
  }
  const L = R.large;
  const M = R.majmin;
  const pick = (L.conf >= M.conf || L.ext >= 0.3) && L.N < 0.15 ? 'large' : 'majmin';
  const s = R[pick];
  const chords: ChordEvent[] = [];
  s.path.forEach((k, i) => {
    const name = s.names[k]!;
    const last = chords[chords.length - 1];
    if (last && last.chord === name) last.endMs = Math.round(s.edges[i + 1]! * 1000);
    else chords.push({ chord: name, tMs: Math.round(s.edges[i]! * 1000), endMs: Math.round(s.edges[i + 1]! * 1000) });
  });
  onProgress?.(1);
  return {
    chords, beats, downbeats: tf.downbeats, bpm: tf.bpm,
    model: pick === 'large' ? 'btc-large' : 'btc-majmin', halfTime: tf.halved,
    confidence: { majmin: M.conf, large: L.conf }, extendedShare: L.ext,
  };
}
