/**
 * Word-level lyric alignment: wav2vec2-base-960h (int8 ONNX, CTC over A–Z ' |) emissions on the vocal stem
 * + CTC Viterbi forced alignment of the user's lyrics (same algorithm as torchaudio.functional.forced_align).
 */
import type { OnnxRun, Progress } from './types.js';

export interface LyricLine { text: string; section: number; words: number[] }
export interface AlignedWord { word: string; line: number; start: number; end: number; confidence: number }

/** Blank line = new section. Parentheses are dropped (backing vocals are still sung, so words are kept). */
export function parseLyrics(text: string): { lines: LyricLine[]; words: { w: string; n: string; line: number }[] } {
  const lines: LyricLine[] = [];
  const words: { w: string; n: string; line: number }[] = [];
  let section = 0;
  let pendingBreak = false;
  for (let raw of text.split(/\r?\n/)) {
    raw = raw.replace(/[()]/g, '').trim();
    if (!raw) { pendingBreak = lines.length > 0; continue; }
    if (pendingBreak) { section++; pendingBreak = false; }
    const ids: number[] = [];
    for (const w of raw.split(/\s+/)) {
      const n = w.toUpperCase().replace(/-/g, '').replace(/[^A-Z']/g, '');
      if (n) { ids.push(words.length); words.push({ w, n, line: lines.length }); }
    }
    lines.push({ text: raw, section, words: ids });
  }
  return { lines, words };
}

/** Emissions [T x V] (log-probs) from 16 kHz mono vocals, 20 s chunks. */
/**
 * Vocal-activity regions on the separated vocal stem: 0.1 s RMS frames above max(-40 dB of the 95th-percentile
 * RMS, absolute floor); gaps < 1.5 s are bridged and regions padded by 0.3 s. Silent spans skip the model.
 */
export function vocalActiveRegions(x: Float32Array, sr = 16000): [number, number][] {
  const hop = Math.round(sr * 0.1);
  const n = Math.floor(x.length / hop);
  const rms = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i]! * x[i]!;
    rms[f] = Math.sqrt(e / hop);
  }
  const sorted = Float32Array.from(rms).sort();
  const p95 = sorted[Math.floor(0.95 * (n - 1))] ?? 0;
  const thr = Math.max(p95 * 0.01, 1e-4);
  const regs: [number, number][] = [];
  for (let f = 0; f < n; f++) {
    if (rms[f]! < thr) continue;
    const last = regs[regs.length - 1];
    if (last && f - last[1] <= 15) last[1] = f + 1;
    else regs.push([f, f + 1]);
  }
  return regs.map(([a, b]) => [Math.max(0, (a - 3) * hop), Math.min(x.length, (b + 3) * hop)] as [number, number]);
}

/** Emissions on a fixed 20 ms grid (320 samples); frames outside vocal regions are pure blank. */
export async function wav2vec2Emissions(
  vocals16k: Float32Array, run: OnnxRun, onProgress?: Progress, opts: { vad?: boolean; blank?: number } = {},
): Promise<{ em: Float32Array; T: number; V: number; fps: number; computedSec: number }> {
  let peak = 0;
  for (const v of vocals16k) peak = Math.max(peak, Math.abs(v));
  const scale = 1 / (peak + 1e-9);
  const HOP = 320;
  const C = 16000 * 20;
  const regions = opts.vad === false ? [[0, vocals16k.length] as [number, number]] : vocalActiveRegions(vocals16k);
  const pieces: [number, number][] = [];
  for (const [a, b] of regions) for (let s = a; s < b; s += C) if (Math.min(b, s + C) - s >= 800) pieces.push([s, Math.min(b, s + C)]);
  const total = pieces.reduce((t, [a, b]) => t + b - a, 0) || 1;
  const T = Math.floor(vocals16k.length / HOP);
  let em: Float32Array | null = null;
  let V = 0;
  let done = 0;
  const blank = opts.blank ?? 0;
  for (const [a, b] of pieces) {
    const x = new Float32Array(b - a);
    for (let i = 0; i < x.length; i++) x[i] = vocals16k[a + i]! * scale;
    const lp = (await run({ wav: { data: x, dims: [1, x.length] } })).logp!;
    if (!em) {
      V = lp.dims[2]!;
      em = new Float32Array(T * V).fill(-30);
      for (let t = 0; t < T; t++) em[t * V + blank] = 0;
    }
    const f0 = Math.round(a / HOP);
    const nf = Math.min(lp.dims[1]!, T - f0);
    em.set(lp.data.subarray(0, nf * V), f0 * V);
    done += b - a;
    onProgress?.(done / total);
  }
  if (!em) { V = 32; em = new Float32Array(T * V).fill(-30); for (let t = 0; t < T; t++) em[t * V + blank] = 0; }
  return { em, T, V, fps: 16000 / HOP, computedSec: total / 16000 };
}

/** CTC Viterbi forced alignment. Returns, per target token, [firstFrame, lastFrame, meanProb]. */
export function ctcForcedAlign(em: Float32Array, T: number, V: number, targets: number[], blank = 0) {
  const L = targets.length;
  const S = 2 * L + 1;
  if (L === 0) return [];
  const ext = new Int32Array(S);
  for (let s = 0; s < S; s++) ext[s] = s % 2 ? targets[(s - 1) / 2]! : blank;
  let prev = new Float64Array(S).fill(-Infinity);
  let cur = new Float64Array(S);
  const bp = new Uint8Array(T * S); // 0 stay, 1 from s-1, 2 from s-2
  prev[0] = em[blank]!;
  if (S > 1) prev[1] = em[ext[1]!]!;
  for (let t = 1; t < T; t++) {
    // band: state s reachable only if s <= 2t+1 and enough frames remain (s >= S - 2(T-t))
    const lo = Math.max(0, S - 2 * (T - t) - 1);
    const hi = Math.min(S - 1, 2 * t + 1);
    cur.fill(-Infinity);
    for (let s = lo; s <= hi; s++) {
      let best = prev[s]!;
      let arg = 0;
      if (s > 0 && prev[s - 1]! > best) { best = prev[s - 1]!; arg = 1; }
      if (s > 1 && ext[s] !== blank && ext[s] !== ext[s - 2] && prev[s - 2]! > best) { best = prev[s - 2]!; arg = 2; }
      if (best === -Infinity) continue;
      cur[s] = best + em[t * V + ext[s]!]!;
      bp[t * S + s] = arg;
    }
    [prev, cur] = [cur, prev];
  }
  let s = S > 1 && prev[S - 2]! > prev[S - 1]! ? S - 2 : S - 1;
  const first = new Int32Array(L).fill(-1);
  const last = new Int32Array(L).fill(-1);
  const psum = new Float64Array(L);
  const pcnt = new Int32Array(L);
  for (let t = T - 1; t >= 0; t--) {
    if (s % 2) {
      const k = (s - 1) / 2;
      if (last[k] === -1) last[k] = t;
      first[k] = t;
      psum[k] += Math.exp(em[t * V + ext[s]!]!);
      pcnt[k]++;
    }
    if (t > 0) s -= bp[t * S + s]!;
  }
  return Array.from({ length: L }, (_, k) => [first[k]!, last[k]!, pcnt[k] ? psum[k]! / pcnt[k]! : 0] as const);
}

export async function alignLyrics(
  vocals16k: Float32Array, lyrics: string, run: OnnxRun, labels: string[], onProgress?: Progress, opts: { vad?: boolean } = {},
): Promise<{ lines: LyricLine[]; words: AlignedWord[] }> {
  const { lines, words } = parseLyrics(lyrics);
  if (!words.length) return { lines, words: [] };
  const { em, T, V, fps } = await wav2vec2Emissions(vocals16k, run, (p) => onProgress?.(p * 0.9), { vad: opts.vad });
  const d = new Map(labels.map((c, i) => [c, i]));
  const targets: number[] = [];
  const wid: number[] = [];
  words.forEach((w, i) => {
    if (i) { targets.push(d.get('|')!); wid.push(-1); }
    for (const ch of w.n) if (d.has(ch)) { targets.push(d.get(ch)!); wid.push(i); }
  });
  if (targets.length * 2 + 1 > T) throw new Error('歌詞比音訊長，無法對齊');
  const al = ctcForcedAlign(em, T, V, targets, 0);
  const out: AlignedWord[] = words.map((w) => ({ word: w.w, line: w.line, start: -1, end: -1, confidence: 0 }));
  const cnt = new Array(words.length).fill(0);
  al.forEach(([f0, f1, p], k) => {
    const i = wid[k]!;
    if (i < 0 || f0 < 0) return;
    const o = out[i]!;
    if (o.start < 0) o.start = f0 / fps;
    o.end = (f1 + 1) / fps;
    o.confidence += p;
    cnt[i]++;
  });
  out.forEach((o, i) => { if (cnt[i]) o.confidence /= cnt[i]; o.start = +o.start.toFixed(3); o.end = +o.end.toFixed(3); });
  onProgress?.(1);
  return { lines, words: out };
}
