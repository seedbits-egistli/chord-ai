/**
 * Vocal melody: CREPE small (MIT, marl/crepe weights; ONNX export yqzhishen/onnxcrepe, MIT) f0 on the separated
 * vocal stem → note events (onset, duration, MIDI) → beat-grid snap. Section-level voting lives in structure.ts.
 */
import type { OnnxRun, Progress } from './types.js';
import { vocalActiveRegions } from './ctcAlign.js';

export interface PitchTrack { hop: number; f0: Float32Array; conf: Float32Array }
export interface MelodyNote {
  start: number; end: number; midi: number; conf: number;
  /** Beat-grid snapped (1/4 beat) times. */
  qStart: number; qEnd: number;
}

const SR = 16000;
const FRAME = 1024;

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
      const c = idx[s + k]! * hs; // frame centred on c
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

/** f0 → notes: voicing threshold, 5-frame median, split on >0.7 semitone jumps or gaps, min 90 ms. */
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
  const notes: MelodyNote[] = [];
  let cur: number[] = [];
  let cs: number[] = [];
  let st = -1;
  const flush = (endI: number) => {
    if (st >= 0 && (endI - st) * t.hop >= 0.09) {
      const m = Math.round(median(cur));
      notes.push({ start: st * t.hop, end: endI * t.hop, midi: m, conf: cs.reduce((a, b) => a + b, 0) / cs.length, qStart: 0, qEnd: 0 });
    }
    cur = []; cs = []; st = -1;
  };
  for (let i = 0; i < n; i++) {
    const v = sm[i]!;
    if (Number.isNaN(v)) { flush(i); continue; }
    if (st >= 0) {
      const ref = median(cur.slice(-6));
      // require 2 consecutive deviating frames to split (vibrato/glide tolerance)
      if (Math.abs(v - ref) > 0.7 && i + 1 < n && !Number.isNaN(sm[i + 1]!) && Math.abs(sm[i + 1]! - ref) > 0.7) flush(i);
    }
    if (st < 0) st = i;
    cur.push(v); cs.push(t.conf[i]!);
  }
  flush(n);
  // merge same-pitch notes separated by < 60 ms
  const merged: MelodyNote[] = [];
  for (const x of notes) {
    const p = merged[merged.length - 1];
    if (p && p.midi === x.midi && x.start - p.end < 0.06) { p.end = x.end; continue; }
    merged.push(x);
  }
  for (const x of merged) { x.qStart = snapToGrid(x.start, beats); x.qEnd = Math.max(snapToGrid(x.end, beats), x.qStart + 0.05); }
  return merged;
}

/** Snap a time to the nearest quarter-beat subdivision of the beat grid. */
export function snapToGrid(time: number, beats: number[]): number {
  if (beats.length < 2) return time;
  let lo = 0, hi = beats.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (beats[mid]! <= time) lo = mid; else hi = mid; }
  const a = beats[lo]!, b = beats[hi]!;
  if (time < a || time > b) return time;
  const q = (b - a) / 4;
  return a + Math.round((time - a) / q) * q;
}

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m: number) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
