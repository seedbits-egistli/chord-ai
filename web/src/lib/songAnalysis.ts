/**
 * 歌曲分析 orchestration (all in-browser): UMX-HQ vocals ∥ Beat This! → CREPE melody → (lyrics) wav2vec2 alignment
 * → classical structure analysis. Progressive callbacks; cancel via AbortSignal. Audio never leaves the device.
 */
import type { LyricLineTiming, MelodyNote, StructureResult } from '@chord-ai/engine';
import { resetSeparateWorker, separateInWorker } from './audio';
import { CancelledError, Eta, nextId, resample, rpc, type AlignedLyrics, type StageState, type V2Stage } from './v2';
import type { V2Response } from '../workers/v2Worker';

export const SONG_STAGES: V2Stage[] = ['download', 'separate', 'beats', 'melody', 'align', 'structure'];
export interface SongAnalysis {
  duration: number;
  beats: number[];
  downbeats: number[];
  notes: MelodyNote[];
  lyrics: AlignedLyrics | null;
  structure: StructureResult | null;
  timings: Record<string, number>;
}
export interface SongHandlers {
  onStage: (s: StageState) => void;
  onPartial: (a: SongAnalysis) => void;
}

export async function analyzeSong(samples: Float32Array, sampleRate: number, lyrics: string, h: SongHandlers, signal?: AbortSignal): Promise<SongAnalysis> {
  const t0 = performance.now();
  const mark = (k: string) => { out.timings[k] = Math.round((performance.now() - t0) / 100) / 10; };
  const etas = new Map<V2Stage, Eta>();
  const etaOf = (s: V2Stage) => { let e = etas.get(s); if (!e) { e = new Eta(); etas.set(s, e); } return e; };
  const emit = (stage: V2Stage, status: StageState['status'], progress: number, extra: Partial<StageState> = {}) =>
    h.onStage({ stage, status, progress, etaSec: status === 'active' ? etaOf(stage).eta(progress) : null, ...extra });
  const forward = (m: V2Response) => {
    if (m.type !== 'stage') return;
    if (m.progress === 0) etaOf(m.stage).reset();
    emit(m.stage, m.progress >= 1 ? 'done' : 'active', m.progress, { detail: m.detail, bytes: m.bytes });
  };
  const out: SongAnalysis = { duration: samples.length / sampleRate, beats: [], downbeats: [], notes: [], lyrics: null, structure: null, timings: {} };
  const mix22k = resample(samples, sampleRate, 22050);
  const beatsP = rpc<Extract<V2Response, { type: 'beatsDone' }>>({ type: 'beats', id: nextId(), mix22k: mix22k.slice() }, forward, signal);
  beatsP.catch(() => {});

  emit('separate', 'active', 0);
  let dl = false;
  const onAbort = () => resetSeparateWorker();
  signal?.addEventListener('abort', onAbort);
  let stems;
  try {
    stems = await separateInWorker(samples, sampleRate, {
      onProgress: (p, detail, fromCache) => {
        if (signal?.aborted) return;
        if (/下載|MB/.test(detail) && fromCache === false) { if (!dl) etaOf('download').reset(); dl = true; emit('download', 'active', Math.min(0.99, p / 0.5), { detail }); return; }
        if (dl) { dl = false; emit('download', 'done', 1); }
        emit('separate', 'active', p, { detail });
      },
    });
  } finally { signal?.removeEventListener('abort', onAbort); }
  if (signal?.aborted) throw new CancelledError();
  const n = stems.vocals.left.length;
  const voc = new Float32Array(n);
  for (let i = 0; i < n; i++) voc[i] = (stems.vocals.left[i]! + stems.vocals.right[i]!) / 2;
  const voc16k = resample(voc, stems.sampleRate, 16000);
  (globalThis as unknown as { __saVoc16k?: Float32Array }).__saVoc16k = voc16k; // debug/verification hook
  emit('separate', 'done', 1); mark('separate');

  const bt = await beatsP;
  out.beats = bt.beats; out.downbeats = bt.downbeats;
  emit('beats', 'done', 1); mark('beats');
  h.onPartial({ ...out });

  const mel = await rpc<Extract<V2Response, { type: 'melodyDone' }>>({ type: 'melody', id: nextId(), voc16k: voc16k.slice(), beats: out.beats }, forward, signal);
  out.notes = mel.notes;
  emit('melody', 'done', 1); mark('melody');
  h.onPartial({ ...out });

  let lines: LyricLineTiming[] = [];
  if (lyrics.trim()) {
    const ar = await rpc<Extract<V2Response, { type: 'alignDone' }>>({ type: 'align', id: nextId(), voc16k: voc16k.slice(), lyrics }, forward, signal);
    out.lyrics = { lines: ar.lines, words: ar.words };
    lines = ar.lines.map((l, i) => {
      const ws = ar.words.filter((w) => w.line === i);
      const k = 0;
      return { text: l.text, paragraph: l.section, start: ws[k]?.start ?? 0, end: ws[ws.length - 1]?.end ?? 0 };
    }).filter((l) => l.end > l.start);
    emit('align', 'done', 1); mark('align');
    h.onPartial({ ...out });
  } else emit('align', 'skipped', 0);

  emit('structure', 'active', 0.1);
  const st = await rpc<Extract<V2Response, { type: 'structureDone' }>>(
    { type: 'structure', id: nextId(), mix22k, voc16k, beats: out.beats, downbeats: out.downbeats, lines, notes: out.notes }, forward, signal);
  out.structure = st.result;
  emit('structure', 'done', 1); mark('structure');
  h.onPartial({ ...out });
  return out;
}
