import { ortWorkerConfig } from './ortConfig';
/**
 * v2 in-browser pipeline orchestration with staged progress, ETA, progressive results and cancel.
 * Separation reuses the UMX-HQ worker; beats/chords/alignment run in the v2 worker. Audio never leaves the device.
 */
import type { DetectionResult } from '@chord-ai/engine';
import { resetSeparateWorker, separateInWorker } from './audio';
import type { V2Request, V2Response, V2Stage } from '../workers/v2Worker';

export type { V2Stage };
export const STAGE_LABEL: Record<V2Stage, string> = {
  download: '下載模型',
  separate: '分離人聲',
  beats: '偵測節拍',
  chords: '辨識和弦',
  align: '對齊歌詞',
};
export interface StageState {
  stage: V2Stage;
  status: 'pending' | 'active' | 'done' | 'skipped';
  progress: number;
  etaSec: number | null;
  detail?: string;
  bytes?: { loaded: number; total: number };
}
export interface AlignedLyrics {
  lines: { text: string; section: number }[];
  words: { word: string; line: number; start: number; end: number; confidence: number }[];
}
export interface V2Handlers {
  onStage: (s: StageState) => void;
  onChords: (r: DetectionResult, extra: { model: string; halfTime: boolean; downbeatsMs: number[] }) => void;
  onLyrics: (a: AlignedLyrics) => void;
}

/** Box-filter + linear resample (good enough for analysis features). */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  const ratio = from / to;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  const half = Math.max(0, Math.floor(ratio / 2));
  for (let i = 0; i < n; i++) {
    const c = i * ratio;
    const j0 = Math.max(0, Math.floor(c) - half + (ratio >= 2 ? 1 : 0));
    const j1 = Math.min(x.length - 1, Math.floor(c) + half);
    if (ratio < 2) {
      const a = Math.floor(c);
      const f = c - a;
      out[i] = (x[a] ?? 0) * (1 - f) + (x[a + 1] ?? x[a] ?? 0) * f;
    } else {
      let s = 0;
      for (let j = j0; j <= j1; j++) s += x[j]!;
      out[i] = s / (j1 - j0 + 1);
    }
  }
  return out;
}

let worker: Worker | null = null;
function getWorker() {
  worker ??= new Worker(new URL('../workers/v2Worker.ts', import.meta.url), { type: 'module', name: ortWorkerConfig() });
  return worker;
}
let seq = 1;

export class CancelledError extends Error { constructor() { super('已取消'); } }

function rpc<T extends V2Response>(req: V2Request, onMsg: (m: V2Response) => void, signal?: AbortSignal): Promise<T> {
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); worker?.terminate(); worker = null; reject(new CancelledError()); };
    const handler = (ev: MessageEvent<V2Response>) => {
      const m = ev.data;
      if (m.id !== req.id) return;
      if (m.type === 'error') { cleanup(); reject(new Error(m.error)); return; }
      if (m.type === 'stage') { onMsg(m); return; }
      cleanup();
      resolve(m as T);
    };
    const cleanup = () => { w.removeEventListener('message', handler); signal?.removeEventListener('abort', abort); };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort);
    w.addEventListener('message', handler);
    const transfer: Transferable[] = [];
    if (req.type === 'chords') transfer.push(req.mix22k.buffer, req.acc22k.buffer);
    if (req.type === 'align') transfer.push(req.voc16k.buffer);
    w.postMessage(req, transfer);
  });
}

class Eta {
  private t0 = performance.now();
  private p0 = 0;
  reset() { this.t0 = performance.now(); this.p0 = 0; }
  eta(p: number): number | null {
    if (p <= this.p0 + 0.02) return null;
    const el = (performance.now() - this.t0) / 1000;
    return Math.max(0, (el / (p - this.p0)) * (1 - p));
  }
}

export async function analyzeV2(
  samples: Float32Array,
  sampleRate: number,
  lyrics: string,
  h: V2Handlers,
  signal?: AbortSignal,
): Promise<void> {
  const eta = new Eta();
  const emit = (stage: V2Stage, status: StageState['status'], progress: number, extra: Partial<StageState> = {}) =>
    h.onStage({ stage, status, progress, etaSec: status === 'active' ? eta.eta(progress) : null, ...extra });
  const forward = (m: V2Response) => {
    if (m.type !== 'stage') return;
    if (m.progress === 0 || (m.stage !== lastStage)) { eta.reset(); lastStage = m.stage; }
    emit(m.stage, m.progress >= 1 ? 'done' : 'active', m.progress, { detail: m.detail, bytes: m.bytes });
  };
  let lastStage: V2Stage | null = null;

  // 1) separation (UMX-HQ worker; its own model download is reported as 下載模型)
  emit('separate', 'active', 0);
  let sepDownloading = false;
  const onAbort = () => resetSeparateWorker();
  signal?.addEventListener('abort', onAbort);
  let stems;
  try {
    stems = await separateInWorker(samples, sampleRate, {
      onProgress: (p, detail, fromCache) => {
        if (signal?.aborted) return;
        const dl = /下載|MB/.test(detail) && fromCache === false;
        if (dl) { if (!sepDownloading) eta.reset(); sepDownloading = true; emit('download', 'active', Math.min(0.99, p / 0.5), { detail }); return; }
        if (sepDownloading) { sepDownloading = false; emit('download', 'done', 1); eta.reset(); }
        emit('separate', 'active', p, { detail });
      },
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  if (signal?.aborted) throw new CancelledError();
  emit('separate', 'done', 1);

  const sr = stems.sampleRate;
  const n = stems.other.left.length;
  const acc = new Float32Array(n);
  const voc = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    acc[i] = (stems.bass.left[i]! + stems.bass.right[i]! + stems.other.left[i]! + stems.other.right[i]!) / 2;
    voc[i] = (stems.vocals.left[i]! + stems.vocals.right[i]!) / 2;
  }
  const mix22k = resample(samples, sampleRate, 22050);
  const acc22k = resample(acc, sr, 22050);
  const voc16k = lyrics.trim() ? resample(voc, sr, 16000) : null;

  // 2) beats + chords → render immediately
  eta.reset();
  const cr = await rpc<Extract<V2Response, { type: 'chordsDone' }>>(
    { type: 'chords', id: seq++, mix22k, acc22k }, forward, signal);
  emit('beats', 'done', 1);
  emit('chords', 'done', 1);
  h.onChords(cr.result, cr.extra);

  // 3) lyric alignment in background
  if (!voc16k) { emit('align', 'skipped', 0); return; }
  eta.reset();
  const ar = await rpc<Extract<V2Response, { type: 'alignDone' }>>(
    { type: 'align', id: seq++, voc16k, lyrics }, forward, signal);
  emit('align', 'done', 1);
  h.onLyrics({ lines: ar.lines, words: ar.words });
}

