/**
 * Song structure (classical, no trained model): bar-synchronous chroma + MFCC → self-similarity matrix →
 * Foote checkerboard novelty → DP segmentation preferring 4/8-bar sections (+ lyric-paragraph and vocal on/off
 * evidence) → grouping by lyric repetition and musical similarity → 前奏/主歌/導歌/副歌/橋段/間奏/尾奏.
 * Also builds a per-group representative melody by voting across repetitions.
 */
import { fftInPlace } from './fftc.js';
import type { MelodyNote } from './melody.js';

export type SectionKind = 'intro' | 'verse' | 'prechorus' | 'chorus' | 'bridge' | 'interlude' | 'outro' | 'section';
export const SECTION_LABEL: Record<SectionKind, string> = {
  intro: '前奏', verse: '主歌', prechorus: '導歌', chorus: '副歌', bridge: '橋段', interlude: '間奏', outro: '尾奏', section: '段落',
};
export interface Section {
  start: number; end: number; startBar: number; endBar: number;
  kind: SectionKind; label: string; group: string; vocal: number; lyrics: string[];
}
export interface RepNote { qOffset: number; qLen: number; midi: number; support: number; glideTo?: number; ticks: number }
export interface StructureResult {
  sections: Section[];
  bars: number[];
  novelty: number[];
  /** Representative melody per group, in quarter-beat units from the section start. */
  repMelody: Record<string, RepNote[]>;
}
export interface LyricLineTiming { text: string; paragraph: number; start: number; end: number }

const SR = 22050, N = 4096, HOP = 1024;

function frameFeatures(x: Float32Array) {
  const nF = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const nb = N / 2;
  const pc = new Int16Array(nb).fill(-1);
  for (let k = 1; k < nb; k++) { const f = (k * SR) / N; if (f >= 55 && f <= 2000) pc[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12; }
  // 40 mel bands 30 Hz–8 kHz
  const mel = (f: number) => 2595 * Math.log10(1 + f / 700);
  const imel = (m: number) => 700 * (10 ** (m / 2595) - 1);
  const NM = 40;
  const edges = Array.from({ length: NM + 2 }, (_, i) => imel(mel(30) + ((mel(8000) - mel(30)) * i) / (NM + 1)));
  const chroma = new Float32Array(nF * 12), mfcc = new Float32Array(nF * 12), rms = new Float32Array(nF);
  const re = new Float64Array(N), im = new Float64Array(N), mag = new Float64Array(nb), mb = new Float64Array(NM);
  for (let f = 0; f < nF; f++) {
    let e = 0;
    for (let i = 0; i < N; i++) { const v = x[f * HOP + i] ?? 0; re[i] = v * win[i]!; im[i] = 0; e += v * v; }
    rms[f] = Math.sqrt(e / N);
    fftInPlace(re, im);
    for (let k = 0; k < nb; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    for (let k = 1; k < nb; k++) if (pc[k]! >= 0) chroma[f * 12 + pc[k]!] += Math.log1p(10 * mag[k]!);
    mb.fill(0);
    for (let b = 0; b < NM; b++) {
      const lo = edges[b]!, c = edges[b + 1]!, hi = edges[b + 2]!;
      for (let k = Math.floor((lo * N) / SR); k <= Math.ceil((hi * N) / SR) && k < nb; k++) {
        const fr = (k * SR) / N;
        const w = fr < c ? (fr - lo) / (c - lo) : (hi - fr) / (hi - c);
        if (w > 0) mb[b] += w * mag[k]! * mag[k]!;
      }
      mb[b] = Math.log(mb[b]! + 1e-8);
    }
    for (let c = 1; c <= 12; c++) {
      let s = 0;
      for (let b = 0; b < NM; b++) s += mb[b]! * Math.cos((Math.PI * c * (b + 0.5)) / NM);
      mfcc[f * 12 + c - 1] = s;
    }
  }
  return { nF, chroma, mfcc, rms };
}

export function barGrid(beats: number[], downbeats: number[], duration: number): number[] {
  let bars = downbeats.filter((d) => d < duration);
  if (bars.length < 4) bars = beats.filter((_, i) => i % 4 === 0);
  if (!bars.length) bars = [0];
  const out = [...bars];
  const len = out.length > 1 ? out[out.length - 1]! - out[out.length - 2]! : 2;
  while (out[out.length - 1]! + len * 0.5 < duration) out.push(Math.min(duration, out[out.length - 1]! + len));
  if (out[out.length - 1]! < duration) out.push(duration);
  if (out[0]! > 0.3) out.unshift(0);
  return out;
}

const cos = (a: Float32Array | number[], b: Float32Array | number[]) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { s += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return s / Math.sqrt(na * nb + 1e-12);
};
const trigrams = (t: string) => {
  const s = ` ${t.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff ]/g, '').replace(/\s+/g, ' ')} `;
  const m = new Map<string, number>();
  for (let i = 0; i + 3 <= s.length; i++) m.set(s.slice(i, i + 3), (m.get(s.slice(i, i + 3)) ?? 0) + 1);
  return m;
};
export function textSim(a: string, b: string): number {
  const A = trigrams(a), B = trigrams(b);
  let inter = 0, na = 0, nb = 0;
  for (const v of A.values()) na += v;
  for (const v of B.values()) nb += v;
  for (const [k, v] of A) inter += Math.min(v, B.get(k) ?? 0);
  return na + nb ? (2 * inter) / (na + nb) : 0;
}

export function analyzeStructure(
  mix22k: Float32Array, voc16k: Float32Array, beats: number[], downbeats: number[],
  lines: LyricLineTiming[], notes: MelodyNote[],
): StructureResult {
  const duration = mix22k.length / SR;
  {
    const spans = lines.map((l) => l.end - l.start).sort((x, y) => x - y);
    const med = spans[spans.length >> 1] ?? 4;
    lines = lines.filter((l) => l.end - l.start <= Math.max(8, 2.5 * med));
  }
  const bars = barGrid(beats, downbeats, duration);
  const B = bars.length - 1;
  const ff = frameFeatures(mix22k);
  // ---- bar features
  const ch: Float32Array[] = [], mf: Float32Array[] = [], en: number[] = [];
  for (let b = 0; b < B; b++) {
    const f0 = Math.floor((bars[b]! * SR) / HOP), f1 = Math.max(f0 + 1, Math.floor((bars[b + 1]! * SR) / HOP));
    const c = new Float32Array(12), m = new Float32Array(12);
    let e = 0, k = 0;
    for (let f = f0; f < Math.min(f1, ff.nF); f++, k++) {
      for (let i = 0; i < 12; i++) { c[i] += ff.chroma[f * 12 + i]!; m[i] += ff.mfcc[f * 12 + i]!; }
      e += ff.rms[f]!;
    }
    k = Math.max(1, k);
    let mx = 1e-9; for (let i = 0; i < 12; i++) { m[i] /= k; mx = Math.max(mx, c[i]!); }
    for (let i = 0; i < 12; i++) c[i] /= mx;
    ch.push(c); mf.push(m); en.push(e / k);
  }
  // z-score mfcc across song
  for (let i = 0; i < 12; i++) {
    let mu = 0, sd = 0;
    for (const m of mf) mu += m[i]!;
    mu /= Math.max(1, B);
    for (const m of mf) sd += (m[i]! - mu) ** 2;
    sd = Math.sqrt(sd / Math.max(1, B)) + 1e-9;
    for (const m of mf) m[i] = (m[i]! - mu) / sd;
  }
  // vocal activity per bar (strict: −20 dB re p95 of 0.1 s RMS)
  const vh = 1600, vn = Math.floor(voc16k.length / vh), vr = new Float32Array(vn);
  for (let f = 0; f < vn; f++) { let e = 0; for (let i = f * vh; i < (f + 1) * vh; i++) e += voc16k[i]! ** 2; vr[f] = Math.sqrt(e / vh); }
  const vthr = (Float32Array.from(vr).sort()[Math.floor(0.95 * (vn - 1))] ?? 0) * 0.1;
  const vocal: number[] = [];
  for (let b = 0; b < B; b++) {
    let on = 0, t = 0;
    for (let f = Math.floor(bars[b]! * 10); f < Math.min(vn, Math.ceil(bars[b + 1]! * 10)); f++, t++) if (vr[f]! > vthr) on++;
    vocal.push(t ? on / t : 0);
  }
  // ---- SSM (chroma with 2-bar context + timbre)
  const S: number[][] = Array.from({ length: B }, () => new Array<number>(B).fill(0));
  for (let i = 0; i < B; i++) for (let j = i; j < B; j++) {
    let c = cos(ch[i]!, ch[j]!);
    if (i + 1 < B && j + 1 < B) c = (c + cos(ch[i + 1]!, ch[j + 1]!)) / 2;
    let d = 0; for (let k = 0; k < 12; k++) d += (mf[i]![k]! - mf[j]![k]!) ** 2;
    const t = Math.exp(-d / 24);
    S[i]![j] = S[j]![i] = 0.6 * c + 0.4 * t;
  }
  // ---- Foote novelty (gaussian-tapered checkerboard, half-width 4 bars)
  const W = 4;
  const nov = new Array<number>(B + 1).fill(0);
  for (let b = 1; b < B; b++) {
    let s = 0, wsum = 0;
    for (let u = -W; u < W; u++) for (let v = -W; v < W; v++) {
      const i = b + u, j = b + v;
      if (i < 0 || j < 0 || i >= B || j >= B) continue;
      const g = Math.exp(-(((u + 0.5) / W) ** 2 + ((v + 0.5) / W) ** 2) * 2);
      const sign = (u < 0) === (v < 0) ? 1 : -1;
      s += sign * g * S[i]![j]!; wsum += g;
    }
    nov[b] = Math.max(0, s / (wsum || 1));
  }
  const nmax = Math.max(1e-9, ...nov);
  for (let b = 0; b <= B; b++) nov[b] = nov[b]! / nmax;
  // ---- boundary evidence
  const barOf = (t: number) => { let b = 0; while (b < B && bars[b + 1]! <= t) b++; return b; };
  const nearestBar = (t: number) => { let best = 0; for (let b = 0; b <= B; b++) if (Math.abs(bars[b]! - t) < Math.abs(bars[best]! - t)) best = b; return best; };
  const reward = new Array<number>(B + 1).fill(0);
  for (let b = 1; b < B; b++) reward[b] = nov[b]!;
  const para = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || lines[i]!.paragraph !== lines[i - 1]!.paragraph) {
      // a pickup word may start before the downbeat: snap the line start to the nearest bar line
      const b = nearestBar(lines[i]!.start);
      para.add(b); reward[b] = reward[b]! + 1.5;
    }
  }
  for (let b = 1; b < B; b++) {
    const was = (vocal[b - 1]! + (vocal[b - 2] ?? vocal[b - 1]!)) / 2, now = (vocal[b]! + (vocal[b + 1] ?? vocal[b]!)) / 2;
    if ((was < 0.15 && now > 0.4) || (was > 0.4 && now < 0.15)) reward[b] = reward[b]! + 0.7;
  }
  // ---- DP segmentation, length prior on bars
  const lenPrior = (L: number) => ({ 4: 0.6, 8: 0.8, 16: 0.4, 12: 0.2, 2: -0.1, 6: -0.1 } as Record<number, number>)[L] ?? -0.6;
  const best = new Array<number>(B + 1).fill(-Infinity), prev = new Array<number>(B + 1).fill(0);
  best[0] = 0;
  for (let b = 1; b <= B; b++) for (let L = 1; L <= Math.min(16, b); L++) {
    const a = b - L;
    const v = best[a]! + (a > 0 ? reward[a]! : 0) + lenPrior(L) - 0.9;
    if (v > best[b]!) { best[b] = v; prev[b] = a; }
  }
  const cuts: number[] = [];
  for (let b = B; b > 0; b = prev[b]!) cuts.unshift(b);
  const segs: [number, number][] = [];
  let a0 = 0; for (const c of cuts) { segs.push([a0, c]); a0 = c; }
  // ---- per-segment info
  const info = segs.map(([a, b]) => {
    // a line belongs to the segment holding most of it (start snapped to the nearest bar line for pickups)
    const ls = lines.filter((l) => {
      const s0 = bars[nearestBar(l.start)]!, e0 = Math.max(l.end, s0 + 0.1);
      const ov = Math.min(e0, bars[b]!) - Math.max(s0, bars[a]!);
      return ov > 0 && ov >= (e0 - s0) / 2 - 1e-6;
    });
    let v = 0; for (let k = a; k < b; k++) v += vocal[k]!;
    let e = 0; for (let k = a; k < b; k++) e += en[k]!;
    return { a, b, lyrics: ls.map((l) => l.text), text: ls.map((l) => l.text).join(' '), vocal: v / (b - a), energy: e / (b - a) };
  });
  const hasLyrics = lines.length > 0;
  const isVocal = (i: number) => (hasLyrics ? info[i]!.lyrics.length > 0 : info[i]!.vocal > 0.35);
  const musicSim = (i: number, j: number) => {
    const A = info[i]!, Bq = info[j]!;
    const L = Math.min(A.b - A.a, Bq.b - Bq.a);
    let s = 0; for (let k = 0; k < L; k++) s += S[A.a + k]![Bq.a + k]!;
    return (s / L) * (L / Math.max(A.b - A.a, Bq.b - Bq.a)) ** 0.3;
  };
  // musical similarity threshold relative to the song's off-diagonal distribution
  const off: number[] = [];
  for (let i = 0; i < B; i++) for (let j = i + 2; j < B; j++) off.push(S[i]![j]!);
  off.sort((x, y) => x - y);
  const mThr = off[Math.floor(off.length * 0.7)] ?? 0.8;
  // ---- grouping
  const n = info.length;
  const grp = new Array<number>(n).fill(-1);
  const kind = new Array<SectionKind>(n).fill('section');
  let g = 0;
  // lyric-identical groups
  if (hasLyrics) {
    for (let i = 0; i < n; i++) {
      if (!isVocal(i) || grp[i]! >= 0) continue;
      const members = [i];
      for (let j = i + 1; j < n; j++) if (grp[j]! < 0 && isVocal(j) && textSim(info[i]!.text, info[j]!.text) > 0.55) members.push(j);
      if (members.length >= 2) { for (const m of members) grp[m] = g; g++; }
    }
  }
  const lyricGroups = g;
  // chorus = the most repeated lyric group (ties → louder)
  let chorusG = -1, bestScore = -1;
  for (let k = 0; k < lyricGroups; k++) {
    const m = info.filter((_, i) => grp[i] === k);
    const sc = m.length + m.reduce((s, x) => s + x.energy, 0) / m.length / Math.max(...en) * 0.5;
    if (sc > bestScore) { bestScore = sc; chorusG = k; }
  }
  if (!hasLyrics) {
    // music-only: cluster vocal segments by similarity
    for (let i = 0; i < n; i++) {
      if (!isVocal(i) || grp[i]! >= 0) continue;
      grp[i] = g;
      for (let j = i + 1; j < n; j++) if (grp[j]! < 0 && isVocal(j) && musicSim(i, j) > mThr) grp[j] = g;
      g++;
    }
    // singletons join the most similar multi-member cluster when reasonably close
    const sizes = new Map<number, number>();
    for (const x of grp) if (x >= 0) sizes.set(x, (sizes.get(x) ?? 0) + 1);
    const lo = off[Math.floor(off.length * 0.45)] ?? 0.6;
    for (let i = 0; i < n; i++) {
      if (grp[i]! < 0 || sizes.get(grp[i]!)! > 1) continue;
      let bj = -1, bs = lo;
      for (let j = 0; j < n; j++) if (j !== i && grp[j]! >= 0 && sizes.get(grp[j]!)! > 1 && musicSim(i, j) > bs) { bs = musicSim(i, j); bj = j; }
      if (bj >= 0) grp[i] = grp[bj]!; else grp[i] = -1;
    }
    let bestE = -1;
    for (let k = 0; k < g; k++) {
      const m = info.filter((_, i) => grp[i] === k);
      if (m.length < 2) continue;
      const e = m.reduce((s, x) => s + x.energy, 0) / m.length;
      if (e > bestE) { bestE = e; chorusG = k; }
    }
  }
  // remaining vocal segments with distinct lyrics default to 主歌 (verse); 橋段 only when musically unlike every
  // other vocal segment (bottom 35% of the song's similarity distribution) and after the first chorus.
  const verseG = g++;
  const lowThr = off[Math.floor(off.length * 0.35)] ?? 0.5;
  const firstChorus = info.findIndex((_, i) => grp[i] === chorusG);
  const rest = info.map((_, i) => i).filter((i) => isVocal(i) && grp[i]! < 0);
  for (const i of rest) {
    const others = info.map((_, j) => j).filter((j) => j !== i && isVocal(j));
    const maxSim = Math.max(-1, ...others.map((j) => musicSim(i, j)));
    const bridge = hasLyrics ? maxSim < lowThr && firstChorus >= 0 && i > firstChorus : maxSim < mThr;
    if (!bridge) grp[i] = verseG;
  }
  for (let i = 0; i < n; i++) {
    if (!isVocal(i)) {
      kind[i] = i === 0 || info.slice(0, i).every((_, k) => !isVocal(k)) ? 'intro'
        : info.slice(i + 1).every((_, k) => !isVocal(i + 1 + k)) ? 'outro' : 'interlude';
      continue;
    }
    if (grp[i] === chorusG) kind[i] = 'chorus';
    else if (grp[i] === verseG) kind[i] = 'verse';
    else if (grp[i]! >= 0 && grp[i]! < lyricGroups) kind[i] = info[i + 1] && grp[i + 1] === chorusG ? 'prechorus' : 'verse';
    else if (grp[i]! >= 0) kind[i] = 'verse';
    else kind[i] = 'bridge';
  }
  // a lone vocal segment right before a chorus whose music matches other verses stays verse; unique ones → bridge
  for (let i = 0; i < n; i++) if (grp[i]! < 0) grp[i] = g++;
  // ---- coarse structure: merge adjacent same-kind segments (verse ×2 → one 主歌), then absorb short pieces
  const isInst = (k: SectionKind) => k === 'intro' || k === 'outro' || k === 'interlude';
  type M = { a: number; b: number; kind: SectionKind; grp: number; lyrics: string[]; vocal: number };
  let merged: M[] = info.map((x, i) => ({ a: x.a, b: x.b, kind: kind[i]!, grp: grp[i]!, lyrics: [...x.lyrics], vocal: x.vocal }));
  const join = (p: M, q: M): M => ({
    a: p.a, b: q.b, kind: p.kind, grp: p.grp, lyrics: [...p.lyrics, ...q.lyrics],
    vocal: (p.vocal * (p.b - p.a) + q.vocal * (q.b - q.a)) / (q.b - p.a),
  });
  const mergeSame = () => {
    const out: M[] = [];
    for (const m of merged) {
      const p = out[out.length - 1];
      if (p && p.kind === m.kind && (isInst(m.kind) || bars[m.b]! - bars[p.a]! <= 70)) out[out.length - 1] = join(p, m); else out.push(m);
    }
    merged = out;
  };
  const blockSim = (x: M, y: M) => { let s = 0, c = 0; for (let i = x.a; i < x.b; i++) for (let j = y.a; j < y.b; j++) { s += S[i]![j]!; c++; } return c ? s / c : 0; };
  mergeSame();
  // minimum lengths: vocal sections ≥ 8 bars, instrumental ≥ 2 bars; the shortest offender goes to its most similar neighbour
  const dur = (m: M) => bars[m.b]! - bars[m.a]!;
  const minLen = (m: M) => (isInst(m.kind) ? 4 : 11.5);
  for (;;) {
    let worst = -1;
    for (let i = 0; i < merged.length; i++) {
      const m = merged[i]!;
      if (dur(m) < minLen(m) && merged.length > 1 && (worst < 0 || dur(m) < dur(merged[worst]!))) worst = i;
    }
    // too many sections overall → merge the shortest non-intro/outro anyway
    if (worst < 0 && merged.length > 12) {
      for (let i = 1; i < merged.length - 1; i++) if (worst < 0 || dur(merged[i]!) < dur(merged[worst]!)) worst = i;
    }
    if (worst < 0) break;
    const m = merged[worst]!, L = merged[worst - 1], R = merged[worst + 1];
    const toLeft = !R || (L && (isInst(m.kind) === isInst(L.kind) ? 1 : 0) + blockSim(m, L) >= (isInst(m.kind) === isInst(R.kind) ? 1 : 0) + blockSim(m, R));
    if (toLeft) merged.splice(worst - 1, 2, join(L!, m)); else merged.splice(worst, 2, { ...join(m, R!), kind: R!.kind, grp: R!.grp });
    mergeSame();
  }
  // one group letter per kind for vocal sections so all 主歌 / 副歌 share a representative melody
  const kindGrp = new Map<SectionKind, number>();
  for (const m of merged) if (!isInst(m.kind)) { if (!kindGrp.has(m.kind)) kindGrp.set(m.kind, m.grp); m.grp = kindGrp.get(m.kind)!; }
  // group letters (A, B, …) by first appearance; per-kind ordinals
  const letter = new Map<number, string>();
  const counts: Partial<Record<SectionKind, number>> = {};
  const totals: Partial<Record<SectionKind, number>> = {};
  for (const m of merged) totals[m.kind] = (totals[m.kind] ?? 0) + 1;
  const sections: Section[] = merged.map((m) => {
    if (!letter.has(m.grp)) letter.set(m.grp, String.fromCharCode(65 + letter.size));
    counts[m.kind] = (counts[m.kind] ?? 0) + 1;
    const lab = SECTION_LABEL[m.kind] + ((totals[m.kind] ?? 0) > 1 && !['intro', 'outro'].includes(m.kind) ? ` ${counts[m.kind]}` : '');
    return { start: bars[m.a]!, end: bars[m.b]!, startBar: m.a, endBar: m.b, kind: m.kind, label: lab, group: letter.get(m.grp)!, vocal: m.vocal, lyrics: m.lyrics };
  });
  return { sections, bars, novelty: nov, repMelody: representativeMelody(sections, notes, beats) };
}

/** Vote across repetitions of each group on a 16th-note grid; unify rhythm to ALLOWED_TICKS; keep glides. */
export function representativeMelody(sections: Section[], notes: MelodyNote[], beats: number[]): Record<string, RepNote[]> {
  const allowed = [1, 2, 3, 4, 6, 8];
  const snapTicks = (raw: number) => {
    if (raw > 8) return Math.min(16, Math.max(4, Math.round(raw / 4) * 4));
    let best = 1, bd = Infinity;
    for (const a of allowed) { const d = Math.abs(a - Math.max(1, raw)); if (d < bd) { best = a; bd = d; } }
    return best;
  };
  const qIndex = (t: number) => {
    let lo = 0, hi = beats.length - 1;
    if (t <= beats[0]!) return 0;
    if (t >= beats[hi]!) return hi * 4;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m]! <= t) lo = m; else hi = m; }
    return lo * 4 + Math.round(((t - beats[lo]!) / (beats[hi]! - beats[lo]!)) * 4);
  };
  const out: Record<string, RepNote[]> = {};
  const byGroup = new Map<string, Section[]>();
  for (const s of sections) if (s.vocal > 0.2 || s.lyrics.length) byGroup.set(s.group, [...(byGroup.get(s.group) ?? []), s]);
  for (const [gname, occ] of byGroup) {
    const len = Math.min(...occ.map((s) => qIndex(s.end) - qIndex(s.start)));
    if (len <= 0) continue;
    // onset voting: each note casts a vote at its snapped onset with (midi, ticks, glideTo)
    type Vote = { midi: number; ticks: number; glideTo?: number };
    const onsetVotes = new Map<number, Vote[]>();
    for (const s of occ) {
      const q0 = qIndex(s.start);
      for (const nt of notes) {
        if (nt.end <= s.start || nt.start >= s.end) continue;
        const off = qIndex(nt.qStart) - q0;
        if (off < 0 || off >= len) continue;
        const ticks = snapTicks(nt.ticks || Math.max(1, qIndex(nt.qEnd) - qIndex(nt.qStart)));
        const list = onsetVotes.get(off) ?? [];
        list.push({ midi: nt.midi, ticks, glideTo: nt.glideTo });
        onsetVotes.set(off, list);
      }
    }
    // keep onsets that appear in ≥ half of occurrences (or ≥ 1 if only one occurrence)
    const need = Math.max(1, Math.ceil(occ.length / 2));
    const onsets = [...onsetVotes.entries()].filter(([, v]) => v.length >= need).sort((a, b) => a[0] - b[0]);
    const rn: RepNote[] = [];
    let cursor = 0;
    for (const [off, votes] of onsets) {
      // skip if overlaps previous note
      if (off < cursor) continue;
      // majority midi (pitch-class tolerant)
      const pcv = new Map<number, number>();
      for (const v of votes) pcv.set(v.midi % 12, (pcv.get(v.midi % 12) ?? 0) + 1);
      let bp = 0, bc = -1; for (const [p, c] of pcv) if (c > bc) { bc = c; bp = p; }
      const same = votes.filter((v) => v.midi % 12 === bp);
      const midiCounts = new Map<number, number>();
      for (const v of same) midiCounts.set(v.midi, (midiCounts.get(v.midi) ?? 0) + 1);
      let midi = same[0]!.midi, mc = -1;
      for (const [m, c] of midiCounts) if (c > mc) { mc = c; midi = m; }
      // majority ticks
      const tc = new Map<number, number>();
      for (const v of same) tc.set(v.ticks, (tc.get(v.ticks) ?? 0) + 1);
      let ticks = 2, tcc = -1;
      for (const [t, c] of tc) if (c > tcc) { tcc = c; ticks = t; }
      ticks = snapTicks(ticks);
      // majority glide target (if ≥ half of votes have a glide)
      const glides = same.filter((v) => v.glideTo != null);
      let glideTo: number | undefined;
      if (glides.length >= Math.ceil(same.length / 2)) {
        const gc = new Map<number, number>();
        for (const v of glides) gc.set(v.glideTo!, (gc.get(v.glideTo!) ?? 0) + 1);
        let gbest = glides[0]!.glideTo!, gcc = -1;
        for (const [g, c] of gc) if (c > gcc) { gcc = c; gbest = g; }
        glideTo = gbest;
      }
      // don't overrun next onset or section end
      const nextOff = onsets.find(([o]) => o > off)?.[0] ?? len;
      ticks = Math.min(ticks, nextOff - off);
      ticks = snapTicks(Math.max(1, ticks));
      const note: RepNote = { qOffset: off, qLen: ticks, midi, support: same.length / occ.length, ticks };
      if (glideTo != null && glideTo !== midi) note.glideTo = glideTo;
      rn.push(note);
      cursor = off + ticks;
    }
    out[gname] = rn;
  }
  return out;
}
