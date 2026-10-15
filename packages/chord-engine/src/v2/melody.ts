/**
 * Vocal melody: CREPE small (MIT) f0 → notes with glides, beat-grid quantization (¼ / ⅛ / dotted / 16th) and rests.
 * Section-level rhythm voting lives in structure.ts.
 */
import type { OnnxRun, Progress } from './types.js';
import { vocalActiveRegions } from './ctcAlign.js';
import { detectKey } from '../key.js';

export interface PitchTrack { hop: number; f0: Float32Array; conf: Float32Array }
export interface MelodyNote {
  start: number; end: number; midi: number; conf: number;
  /** Beat-grid snapped times (16th-note grid). */
  qStart: number; qEnd: number;
  /** Continuous f0 slide from `midi` to this pitch over the note's duration (undefined = flat). */
  glideTo?: number;
  /** Duration in 16th-note ticks after quantization (1=16th, 2=8th, 3=dotted-8th, 4=¼, 6=dotted-¼, 8=½). */
  ticks: number;
}

const SR = 16000;
const FRAME = 1024;
/** Allowed note lengths in 16th-note ticks. */
export const ALLOWED_TICKS = [1, 2, 3, 4, 6, 8] as const;

/** CREPE f0 at `hop` seconds (default 20 ms), only on vocal-active regions (others: f0=0, conf=0). */
export async function crepePitch(voc16k: Float32Array, run: OnnxRun, onProgress?: Progress, hop = 0.02): Promise<PitchTrack> {
  const hs = Math.round(hop * SR);
  const n = Math.floor(voc16k.length / hs);
  const f0 = new Float32Array(n);
  const conf = new Float32Array(n);
  const active = new Uint8Array(n);
  for (const [a, b] of vocalActiveRegions(voc16k, SR)) {
    for (let i = Math.max(0, Math.floor(a / hs)); i < Math.min(n, Math.ceil(b / hs)); i++) active[i] = 1;
  }
  const idx: number[] = [];
  for (let i = 0; i < n; i++) if (active[i]) idx.push(i);
  const B = 256;
  const buf = new Float32Array(B * FRAME);
  for (let s = 0; s < idx.length; s += B) {
    const m = Math.min(B, idx.length - s);
    for (let k = 0; k < m; k++) {
      const c = idx[s + k]! * hs;
      let mean = 0;
      for (let j = 0; j < FRAME; j++) { const v = voc16k[c - FRAME / 2 + j] ?? 0; buf[k * FRAME + j] = v; mean += v; }
      mean /= FRAME;
      let sd = 0;
      for (let j = 0; j < FRAME; j++) { const v = (buf[k * FRAME + j]! -= mean); sd += v * v; }
      sd = Math.max(1e-10, Math.sqrt(sd / FRAME));
      for (let j = 0; j < FRAME; j++) buf[k * FRAME + j]! /= sd;
    }
    const out = await run({ frames: { data: buf.slice(0, m * FRAME), dims: [m, FRAME] } });
    const p = Object.values(out)[0]!.data;
    for (let k = 0; k < m; k++) {
      let am = 0;
      for (let j = 1; j < 360; j++) if (p[k * 360 + j]! > p[k * 360 + am]!) am = j;
      let ws = 0, wc = 0;
      for (let j = Math.max(0, am - 4); j <= Math.min(359, am + 4); j++) { const w = p[k * 360 + j]!; ws += w; wc += w * (1997.3794084376191 + 20 * j); }
      const i = idx[s + k]!;
      conf[i] = p[k * 360 + am]!;
      f0[i] = 10 * Math.pow(2, wc / ws / 1200);
    }
    onProgress?.(Math.min(1, (s + m) / Math.max(1, idx.length)));
  }
  onProgress?.(1);
  return { hop, f0, conf };
}

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]!; };

type Seg = { i0: number; i1: number; kind: 'note' | 'glide'; midi: number; midiEnd: number; conf: number };

/**
 * f0 → notes with glides:
 * 1. Voicing + 5-frame median.
 * 2. Find stable plateaus (≥ 80 ms, within 0.4 semitone).
 * 3. Between plateaus: continuous voiced f0 with |Δ| ≥ 0.7 st → glide; else absorb short plateaus.
 * 4. Snap onsets to 16th grid; end at next onset or silence. Quantize duration to ALLOWED_TICKS.
 */
export function pitchToNotes(t: PitchTrack, beats: number[], voicing = 0.5): MelodyNote[] {
  const n = t.f0.length;
  const midi = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (t.conf[i]! >= voicing && t.f0[i]! > 60 && t.f0[i]! < 1200) midi[i] = 69 + 12 * Math.log2(t.f0[i]! / 440);
  const sm = new Float32Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i]!)) continue;
    const w: number[] = [];
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && !Number.isNaN(midi[j]!)) w.push(midi[j]!);
    sm[i] = median(w);
  }
  // plateaus: runs where pitch stays within 0.4 st of a running median
  const plateaus: { i0: number; i1: number; midi: number; conf: number }[] = [];
  {
    let i = 0;
    while (i < n) {
      while (i < n && Number.isNaN(sm[i]!)) i++;
      if (i >= n) break;
      const vals = [sm[i]!];
      const cs = [t.conf[i]!];
      let j = i + 1;
      while (j < n && !Number.isNaN(sm[j]!) && Math.abs(sm[j]! - median(vals.slice(-8))) <= 0.4) {
        vals.push(sm[j]!); cs.push(t.conf[j]!); j++;
      }
      if ((j - i) * t.hop >= 0.08) {
        plateaus.push({ i0: i, i1: j, midi: Math.round(median(vals)), conf: cs.reduce((a, b) => a + b, 0) / cs.length });
      }
      i = j;
    }
  }
  // build segments: plateaus + glides between them when f0 is continuous and moves ≥ 0.7 st
  const segs: Seg[] = [];
  for (let p = 0; p < plateaus.length; p++) {
    const cur = plateaus[p]!;
    if (p > 0) {
      const prev = plateaus[p - 1]!;
      const gap = cur.i0 - prev.i1;
      const voiced = gap > 0 && Array.from({ length: gap }, (_, k) => sm[prev.i1 + k]!).every((v) => !Number.isNaN(v));
      const delta = cur.midi - prev.midi;
      if (voiced && Math.abs(delta) >= 1 && gap * t.hop >= 0.04) {
        // continuous slide → glide note spanning the gap (and optionally overlapping plateau edges)
        const g0 = prev.i1;
        const g1 = cur.i0;
        segs.push({ i0: g0, i1: Math.max(g0 + 1, g1), kind: 'glide', midi: prev.midi, midiEnd: cur.midi, conf: (prev.conf + cur.conf) / 2 });
      } else if (!voiced && gap * t.hop < 0.06 && Math.abs(delta) <= 1) {
        // tiny unvoiced gap, same pitch-ish → extend previous
        const last = segs[segs.length - 1];
        if (last) last.i1 = cur.i0;
      }
    }
    segs.push({ i0: cur.i0, i1: cur.i1, kind: 'note', midi: cur.midi, midiEnd: cur.midi, conf: cur.conf });
  }
  // absorb very short plateaus (< 100 ms) into neighbouring glide or principal note
  const absorbed: Seg[] = [];
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]!;
    const dur = (s.i1 - s.i0) * t.hop;
    if (s.kind === 'note' && dur < 0.1) {
      const prev = absorbed[absorbed.length - 1];
      const next = segs[i + 1];
      if (prev?.kind === 'glide') {
        prev.i1 = s.i1; prev.midiEnd = s.midi; continue;
      }
      if (next?.kind === 'glide') {
        next.i0 = s.i0; next.midi = s.midi; continue;
      }
      if (prev && Math.abs(prev.midi - s.midi) <= 1) { prev.i1 = s.i1; continue; }
      if (next && Math.abs(next.midi - s.midi) <= 1) { next.i0 = s.i0; continue; }
      // otherwise drop (passing tone)
      continue;
    }
    absorbed.push(s);
  }
  // merge consecutive same-pitch flat notes with tiny gaps
  const merged: Seg[] = [];
  for (const s of absorbed) {
    const p = merged[merged.length - 1];
    if (p && p.kind === 'note' && s.kind === 'note' && p.midi === s.midi && (s.i0 - p.i1) * t.hop < 0.08) {
      p.i1 = s.i1; p.conf = (p.conf + s.conf) / 2; continue;
    }
    // short preceding plateau + glide → one gliding note; long plateau keeps its own note then a glide
    if (p && p.kind === 'note' && s.kind === 'glide' && p.midi === s.midi) {
      if ((p.i1 - p.i0) * t.hop < 0.2) { p.kind = 'glide'; p.midiEnd = s.midiEnd; p.i1 = s.i1; continue; }
      // long hold: leave plateau, glide is its own event starting at plateau end
    }
    // only a short hold after a glide is absorbed (arrival ornament); longer plateaus stay as notes
    if (p && p.kind === 'glide' && s.kind === 'note' && p.midiEnd === s.midi && (s.i1 - s.i0) * t.hop < 0.12) {
      p.i1 = s.i1; continue;
    }
    merged.push({ ...s });
  }
  // snap onsets to 16th grid; end at next onset or silence (already at i1)
  const notes: MelodyNote[] = [];
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i]!;
    const start = s.i0 * t.hop;
    const end = Math.max(start + 0.05, s.i1 * t.hop);
    const nextStart = i + 1 < merged.length ? merged[i + 1]!.i0 * t.hop : end;
    // don't extend past next onset (prevents overlapping)
    const rawEnd = Math.min(end, nextStart);
    const qStart = snapToGrid(start, beats, 4);
    let qEnd = Math.max(snapToGrid(rawEnd, beats, 4), qStart + gridStep(beats, qStart) / 4);
    // if next note snaps to same onset, keep a 16th
    if (i + 1 < merged.length) {
      const nq = snapToGrid(merged[i + 1]!.i0 * t.hop, beats, 4);
      if (nq > qStart) qEnd = Math.min(qEnd, nq);
    }
    const ticks = quantizeTicks(qStart, qEnd, beats);
    qEnd = addTicks(qStart, ticks, beats);
    const note: MelodyNote = {
      start: qStart, end: qEnd, midi: s.midi, conf: s.conf, qStart, qEnd, ticks,
    };
    if (s.kind === 'glide' && s.midiEnd !== s.midi) note.glideTo = s.midiEnd;
    notes.push(note);
  }
  // ensure non-overlapping onsets after snap
  notes.sort((a, b) => a.qStart - b.qStart || a.qEnd - b.qEnd);
  const clean: MelodyNote[] = [];
  for (const n of notes) {
    const p = clean[clean.length - 1];
    if (p && n.qStart < p.qEnd - 1e-4) {
      if (n.qStart <= p.qStart + 1e-4) {
        // same onset: prefer keeping a short glide then the following hold
        if (p.glideTo != null && n.glideTo == null) { n.qStart = p.qEnd; n.start = p.qEnd; if (n.qEnd <= n.qStart) continue; n.ticks = quantizeTicks(n.qStart, n.qEnd, beats); }
        else if (n.glideTo != null && p.glideTo == null) { p.qEnd = n.qStart; /* will push n */ }
        else if (n.qEnd > p.qEnd) { p.qEnd = n.qEnd; p.end = n.end; p.ticks = n.ticks; if (n.glideTo != null) p.glideTo = n.glideTo; continue; }
        else continue;
      }
      p.qEnd = n.qStart; p.end = n.qStart;
      p.ticks = quantizeTicks(p.qStart, p.qEnd, beats);
    }
    clean.push(n);
  }
  return clean;
}
/** Snap to 1/`sub` of a beat (sub=4 → 16th notes). */
export function snapToGrid(time: number, beats: number[], sub = 4): number {
  if (beats.length < 2) return time;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid]! <= time) lo = mid; else hi = mid; }
  const a = beats[lo]!, b = beats[hi]!;
  if (time < a) return a;
  if (time > b && hi === beats.length - 1) return b;
  const q = (b - a) / sub;
  return a + Math.round((time - a) / q) * q;
}

function gridStep(beats: number[], t: number): number {
  if (beats.length < 2) return 0.5;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid]! <= t) lo = mid; else hi = mid; }
  return Math.max(0.05, beats[Math.min(hi, beats.length - 1)]! - beats[lo]!);
}

/** Map a time span onto the nearest ALLOWED_TICKS duration. */
export function quantizeTicks(qStart: number, qEnd: number, beats: number[]): number {
  const step = gridStep(beats, qStart) / 4;
  const raw = Math.max(1, Math.round((qEnd - qStart) / step));
  let best: number = ALLOWED_TICKS[0]!, bd = Infinity;
  for (const a of ALLOWED_TICKS) {
    const d = Math.abs(a - raw);
    if (d < bd || (d === bd && a < best)) { best = a; bd = d; }
  }
  if (raw > 8) {
    const q = Math.round(raw / 4) * 4;
    return Math.min(16, Math.max(4, q));
  }
  return best;
}

export function addTicks(t: number, ticks: number, beats: number[]): number {
  if (beats.length < 2) return t + ticks * 0.125;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid]! <= t + 1e-6) lo = mid; else hi = mid; }
  const a = beats[lo]!, b = beats[Math.min(hi, beats.length - 1)]!;
  const step = (b - a) / 4;
  const pos = Math.round((t - a) / step) + ticks;
  const beatIdx = lo + Math.floor(pos / 4);
  const rem = pos % 4;
  if (beatIdx + 1 < beats.length) return beats[beatIdx]! + rem * (beats[beatIdx + 1]! - beats[beatIdx]!) / 4;
  const last = beats[beats.length - 1]! - beats[beats.length - 2]!;
  return beats[beats.length - 1]! + (beatIdx - (beats.length - 1)) * last + rem * last / 4;
}

/** Song key from duration-weighted melody pitch classes (Krumhansl–Schmuckler). */
export function keyFromMelody(notes: MelodyNote[]): string {
  const chroma = new Float32Array(12);
  for (const n of notes) {
    const d = Math.max(0.05, n.end - n.start);
    chroma[((n.midi % 12) + 12) % 12] += d * n.conf;
    if (n.glideTo != null) chroma[(((n.glideTo) % 12) + 12) % 12] += d * 0.3;
  }
  return detectKey(chroma);
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** VexFlow-friendly note name for a MIDI pitch in a given key (e.g. "c/4", "bb/3"). */
export function midiToVex(midi: number, key: string): string {
  const flats = /^(F|Bb|Eb|Ab|Db|Gb|Dm|Gm|Cm|Fm|Bbm|Ebm)/.test(key);
  const names = flats
    ? ['c', 'db', 'd', 'eb', 'e', 'f', 'gb', 'g', 'ab', 'a', 'bb', 'b']
    : ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b'];
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return `${names[pc]}/${oct}`;
}
