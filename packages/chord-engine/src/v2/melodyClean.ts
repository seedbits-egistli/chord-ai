/**
 * 「整理後」旋律: a musically plausible best-guess transcription layered on the raw CREPE detection.
 * 1. Slots: one per aligned lyric word (split into ≤ 2 notes by stable plateaus); without lyrics, raw notes ≥ 120 ms.
 *    Pitched material between words is dropped (usually instrument bleed in the vocal stem).
 * 2. Candidates per slot from conf-weighted f0 histogram (+ octave alternatives), scored with a key prior,
 *    accompaniment-bleed suppression and a chord-tone bonus on strong beats.
 * 3. Viterbi over slots: stepwise motion favoured, leaps > 7 st penalised unless sustained and confident.
 * 4. Drop short low-confidence out-of-key notes; glides collapse to the chosen (stable) pitch.
 * 5. Section consensus: repetitions of the same section group vote on pitch per beat offset.
 */
import { detectKey } from '../key.js';
import { addTicks, quantizeTicks, snapToGrid, type MelodyNote, type PitchTrack } from './melody.js';
import type { Section } from './structure.js';

export interface CleanInput {
  track: PitchTrack;
  beats: number[];
  rawNotes: MelodyNote[];
  words?: { word: string; start: number; end: number }[];
  sections?: Section[];
  accChroma?: number[];
  downbeats?: number[];
}
export interface CleanResult { notes: MelodyNote[]; key: string; stats: { slots: number; dropped: number; consensusFixed: number } }

const PC_NAMES: Record<string, number> = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
export function keyScale(key: string): Set<number> {
  const minor = key.endsWith('m');
  const root = PC_NAMES[key.replace(/m$/, '')] ?? 0;
  const iv = minor ? [0, 2, 3, 5, 7, 8, 10, 11] /* natural + leading tone */ : [0, 2, 4, 5, 7, 9, 11];
  return new Set(iv.map((i) => (root + i) % 12));
}

type Slot = { t0: number; t1: number; lyric?: string; cands: { midi: number; w: number }[]; conf: number };

function beatIndex(beats: number[], t: number): number {
  let lo = 0, hi = beats.length - 1;
  if (hi < 1 || t < beats[0]!) return 0;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (beats[m]! <= t) lo = m; else hi = m; }
  return lo;
}

/** Conf-weighted pitch histogram + plateaus within [t0, t1). */
function framesIn(tr: PitchTrack, t0: number, t1: number) {
  const out: { t: number; m: number; c: number }[] = [];
  for (let i = Math.max(0, Math.floor(t0 / tr.hop)); i < Math.min(tr.f0.length, Math.ceil(t1 / tr.hop)); i++) {
    const c = tr.conf[i]!, f = tr.f0[i]!;
    if (c >= 0.3 && f > 60 && f < 1200) out.push({ t: i * tr.hop, m: 69 + 12 * Math.log2(f / 440), c });
  }
  return out;
}

function histCands(fr: { m: number; c: number }[]): { midi: number; w: number }[] {
  const h = new Map<number, number>();
  for (const x of fr) { const r = Math.round(x.m); h.set(r, (h.get(r) ?? 0) + x.c * x.c); }
  const tot = [...h.values()].reduce((a, b) => a + b, 0) || 1;
  const list = [...h.entries()].map(([midi, w]) => ({ midi, w: w / tot })).sort((a, b) => b.w - a.w).slice(0, 4);
  // octave alternatives of the winner (octave errors are common with bleed)
  if (list[0]) for (const d of [-12, 12]) if (!list.some((c) => c.midi === list[0]!.midi + d)) list.push({ midi: list[0]!.midi + d, w: list[0]!.w * 0.15 });
  return list;
}

/** Stable plateaus (run within ±0.5 st, ≥ 100 ms) inside a slot, longest first. */
function plateaus(fr: { t: number; m: number; c: number }[], hop: number) {
  const out: { t0: number; t1: number; m: number }[] = [];
  let i = 0;
  while (i < fr.length) {
    let j = i + 1;
    const ref = fr[i]!.m;
    while (j < fr.length && Math.abs(fr[j]!.m - ref) <= 0.6 && fr[j]!.t - fr[j - 1]!.t <= hop * 2.5) j++;
    if ((j - i) * hop >= 0.1) {
      const ms = fr.slice(i, j).map((x) => x.m).sort((a, b) => a - b);
      out.push({ t0: fr[i]!.t, t1: fr[j - 1]!.t + hop, m: ms[ms.length >> 1]! });
    }
    i = j;
  }
  return out;
}

export function cleanMelody(inp: CleanInput): CleanResult {
  const { track: tr, beats } = inp;
  // ---- key: melody pitch classes + accompaniment chroma
  const chroma = new Float32Array(12);
  for (const n of inp.rawNotes) chroma[((n.midi % 12) + 12) % 12] += (n.end - n.start) * n.conf;
  if (inp.accChroma) for (let i = 0; i < inp.accChroma.length; i++) chroma[i % 12] += inp.accChroma[i]! * 0.15;
  const key = detectKey(chroma);
  const scale = keyScale(key);
  const accAt = (t: number, pc: number) => (inp.accChroma ? inp.accChroma[beatIndex(beats, t) * 12 + pc] ?? 0 : 0);
  const db = new Set((inp.downbeats ?? []).map((d) => Math.round(d * 20)));
  const strongBeat = (t: number) => { const b = beats[beatIndex(beats, t)]; return b != null && Math.abs(b - t) < 0.08 && (db.has(Math.round(b * 20)) || beatIndex(beats, t) % 2 === 0); };

  // ---- 1. slots
  const slots: Slot[] = [];
  const words = (inp.words ?? []).filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  if (words.length) {
    for (let k = 0; k < words.length; k++) {
      const w = words[k]!;
      const t1 = Math.min(Math.max(w.end, w.start + 0.12), words[k + 1]?.start ?? Infinity);
      const fr = framesIn(tr, w.start, t1);
      if (fr.length < 3) continue; // nothing sung there (alignment off or unvoiced)
      const pl = plateaus(fr, tr.hop).sort((a, b) => (b.t1 - b.t0) - (a.t1 - a.t0));
      const span = t1 - w.start;
      const two = pl.length >= 2 && pl[1]!.t1 - pl[1]!.t0 >= 0.4 * span * 0.5 && Math.abs(Math.round(pl[0]!.m) - Math.round(pl[1]!.m)) >= 1 && span > 0.35;
      const parts = two ? [pl[0]!, pl[1]!].sort((a, b) => a.t0 - b.t0) : null;
      if (parts) {
        const cut = parts[1]!.t0;
        for (const [a, b, lyr] of [[w.start, cut, w.word], [cut, t1, undefined]] as [number, number, string | undefined][]) {
          const f2 = framesIn(tr, a, b);
          if (f2.length < 2) continue;
          slots.push({ t0: a, t1: b, lyric: lyr, cands: histCands(f2), conf: f2.reduce((s, x) => s + x.c, 0) / f2.length });
        }
      } else {
        // pitch from the most stable portion: longest plateau if present, else whole span
        const src = pl[0] ? framesIn(tr, pl[0].t0, pl[0].t1) : fr;
        slots.push({ t0: w.start, t1, lyric: w.word, cands: histCands(src), conf: fr.reduce((s, x) => s + x.c, 0) / fr.length });
      }
    }
  } else {
    for (const n of inp.rawNotes) {
      if (n.end - n.start < 0.12) continue;
      const fr = framesIn(tr, n.start, n.end);
      const cands = fr.length >= 3 ? histCands(fr) : [{ midi: n.midi, w: 1 }];
      slots.push({ t0: n.start, t1: n.end, cands, conf: n.conf });
    }
  }

  // ---- 2+3. Viterbi
  const emit = (s: Slot, m: number, w: number) => {
    const pc = ((m % 12) + 12) % 12;
    let e = Math.log(w + 1e-3);
    e += scale.has(pc) ? 0.4 : -0.9 * (1.2 - s.conf);
    const acc = accAt(s.t0, pc);
    if (s.conf < 0.6 && acc > 0.75 && !scale.has(pc)) e -= 0.7; // bleed: out-of-key accompaniment pitch, weak voice
    if (s.conf < 0.6 && acc > 0.85 && w < 0.5) e -= 0.4;
    if (strongBeat(s.t0) && acc > 0.6 && s.conf >= 0.5) e += 0.25 * acc; // chord tone on strong beat
    if (m < 45 || m > 84) e -= 2; // outside plausible voice range
    return e;
  };
  const trans = (a: number, b: number, s: Slot) => {
    const d = Math.abs(b - a);
    if (d === 0) return 0;
    if (d <= 2) return -0.1 * d;
    if (d <= 5) return -0.35 - 0.1 * d;
    if (d <= 7) return -0.9;
    const sustained = s.t1 - s.t0 > 0.4 && s.conf > 0.7;
    return sustained ? -1.4 : -2.6 - 0.1 * (d - 7);
  };
  const n = slots.length;
  const score: number[][] = [], back: number[][] = [];
  for (let i = 0; i < n; i++) {
    const s = slots[i]!;
    score.push([]); back.push([]);
    s.cands.forEach((c, j) => {
      const e = emit(s, c.midi, c.w);
      if (i === 0) { score[i]![j] = e; back[i]![j] = -1; return; }
      // phrase break (> 1.2 s gap) resets the transition prior
      const gap = s.t0 - slots[i - 1]!.t1 > 1.2;
      let best = -Infinity, arg = 0;
      slots[i - 1]!.cands.forEach((p, k) => {
        const v = score[i - 1]![k]! + (gap ? 0 : trans(p.midi, c.midi, s));
        if (v > best) { best = v; arg = k; }
      });
      score[i]![j] = best + e; back[i]![j] = arg;
    });
  }
  const pick = new Array<number>(n).fill(0);
  if (n) {
    let arg = 0;
    score[n - 1]!.forEach((v, j) => { if (v > score[n - 1]![arg]!) arg = j; });
    for (let i = n - 1; i >= 0; i--) { pick[i] = arg; arg = back[i]![arg]!; }
  }

  // ---- 4. build notes, drop short low-confidence out-of-key
  let dropped = 0;
  const out: (MelodyNote & { lyric?: string })[] = [];
  for (let i = 0; i < n; i++) {
    const s = slots[i]!;
    const m = s.cands[pick[i]!]!.midi;
    const pc = ((m % 12) + 12) % 12;
    if (s.t1 - s.t0 < 0.15 && s.conf < 0.6 && !scale.has(pc)) { dropped++; continue; }
    const qStart = snapToGrid(s.t0, beats, 4);
    let qEnd = Math.max(snapToGrid(s.t1, beats, 4), qStart + 0.05);
    const nextT = slots[i + 1] ? snapToGrid(slots[i + 1]!.t0, beats, 4) : Infinity;
    if (nextT > qStart) qEnd = Math.min(qEnd, nextT);
    const ticks = quantizeTicks(qStart, qEnd, beats);
    qEnd = Math.min(addTicks(qStart, ticks, beats), nextT > qStart ? nextT : Infinity);
    let qs = qStart, qe = qEnd, tk = ticks;
    const prev = out[out.length - 1];
    if (prev && prev.qStart >= qs - 1e-4) {
      // two syllables snapped to one 16th: push this one a 16th later (keeps every word on its own note)
      qs = addTicks(prev.qStart, 1, beats);
      if (qs >= s.t1 + 0.1 || (nextT !== Infinity && qs >= nextT - 1e-4)) { if (s.lyric && prev.lyric) prev.lyric += ' ' + s.lyric; continue; }
      prev.qEnd = prev.end = qs; prev.ticks = 1;
      tk = quantizeTicks(qs, Math.max(qe, addTicks(qs, 1, beats)), beats);
      qe = Math.min(addTicks(qs, tk, beats), nextT > qs ? nextT : Infinity);
    } else if (prev && prev.qEnd > qs) { prev.qEnd = prev.end = qs; prev.ticks = quantizeTicks(prev.qStart, qs, beats); }
    out.push({ start: qs, end: qe, qStart: qs, qEnd: qe, midi: m, conf: s.conf, ticks: tk, lyric: s.lyric });
  }

  // ---- 5. section consensus (pitch per 16th offset from section start)
  let consensusFixed = 0;
  const secs = (inp.sections ?? []).filter((s) => s.lyrics.length || s.vocal > 0.3);
  const groups = new Map<string, Section[]>();
  for (const s of secs) groups.set(s.group, [...(groups.get(s.group) ?? []), s]);
  const q = (t: number) => { const b = beatIndex(beats, t); const nx = beats[b + 1] ?? beats[b]! + 0.5; return b * 4 + Math.round(((t - beats[b]!) / (nx - beats[b]!)) * 4); };
  for (const occ of groups.values()) {
    if (occ.length < 2) continue;
    const per = occ.map((s) => { const q0 = q(s.start); return out.filter((x) => x.start >= s.start && x.start < s.end).map((x) => ({ x, off: q(x.start) - q0 })); });
    for (let a = 0; a < occ.length; a++) {
      for (const { x, off } of per[a]!) {
        const pcs = new Map<number, number[]>();
        for (let b = 0; b < occ.length; b++) {
          if (b === a) continue;
          const hit = per[b]!.find((y) => Math.abs(y.off - off) <= 1);
          if (hit) { const pc = ((hit.x.midi % 12) + 12) % 12; pcs.set(pc, [...(pcs.get(pc) ?? []), hit.x.midi]); }
        }
        const need = Math.ceil(occ.length / 2); // majority of all occurrences (others agreeing among themselves)
        for (const [pc, ms] of pcs) {
          if (ms.length >= need && pc !== ((x.midi % 12) + 12) % 12 && x.conf < 0.75) {
            // move to that pitch class in the octave nearest the current note
            const base = x.midi - (((x.midi % 12) + 12) % 12) + pc;
            x.midi = [base - 12, base, base + 12].reduce((b2, c) => (Math.abs(c - x.midi) < Math.abs(b2 - x.midi) ? c : b2));
            consensusFixed++;
            break;
          }
        }
      }
    }
  }
  return { notes: out, key, stats: { slots: n, dropped, consensusFixed } };
}

/** Stats for comparing melodies: count, % in key, leap histogram, mean |interval|. */
export function melodyStats(notes: { midi: number; start: number }[], key: string) {
  const sc = keyScale(key);
  const ns = [...notes].sort((a, b) => a.start - b.start);
  let inKey = 0, leaps7 = 0, leaps12 = 0, sumAbs = 0, cnt = 0;
  for (let i = 0; i < ns.length; i++) {
    if (sc.has(((ns[i]!.midi % 12) + 12) % 12)) inKey++;
    if (i && ns[i]!.start - ns[i - 1]!.start < 1.5) {
      const d = Math.abs(ns[i]!.midi - ns[i - 1]!.midi);
      sumAbs += d; cnt++;
      if (d > 7) leaps7++;
      if (d >= 12) leaps12++;
    }
  }
  return { count: ns.length, inKeyPct: ns.length ? Math.round((inKey / ns.length) * 1000) / 10 : 0, leapsOver7: leaps7, octaveJumps: leaps12, meanAbsInterval: cnt ? Math.round((sumAbs / cnt) * 100) / 100 : 0 };
}
