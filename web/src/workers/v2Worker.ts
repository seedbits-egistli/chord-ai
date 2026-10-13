/// <reference lib="webworker" />
/**
 * v2 analysis worker: Beat This! → BTC chords → (optional) wav2vec2 lyric alignment.
 * All inference is local (onnxruntime-web, wasm EP); models are fetched once and kept in Cache Storage.
 */
import * as ort from 'onnxruntime-web/wasm';
import {
  BTC_NORM,
  alignLyrics,
  btcNames,
  detectChordsBtc,
  toDetectionResult,
  trackBeatsBeatThis,
  type DetectionResult,
  type OnnxRun,
} from '@chord-ai/engine';
import { readOrtWorkerConfig } from '../lib/ortConfig';
import { getCachedArrayBuffer, putArrayBuffer } from '../lib/assetCache';
import { V2_MODELS, modelUrl, type ModelSpec } from '../lib/modelsV2';

export type V2Stage = 'download' | 'separate' | 'beats' | 'chords' | 'align';
export type V2Request =
  | { type: 'chords'; id: number; mix22k: Float32Array; acc22k: Float32Array }
  | { type: 'align'; id: number; voc16k: Float32Array; lyrics: string }
  | { type: 'status'; id: number; withAlign: boolean };
export type V2Response =
  | { id: number; type: 'stage'; stage: V2Stage; progress: number; detail: string; bytes?: { loaded: number; total: number } }
  | { id: number; type: 'chordsDone'; result: DetectionResult; extra: { model: string; halfTime: boolean; downbeatsMs: number[] } }
  | { id: number; type: 'alignDone'; lines: { text: string; section: number }[]; words: { word: string; line: number; start: number; end: number; confidence: number }[] }
  | { id: number; type: 'status'; missingMB: number }
  | { id: number; type: 'error'; error: string };

const post = (m: V2Response) => (self as unknown as Worker).postMessage(m);
ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
const cfg = readOrtWorkerConfig(self.name);
ort.env.wasm.numThreads = cfg.threads;
const dbg = (...a: unknown[]) => console.log('[v2w]', ((performance.now()) / 1000).toFixed(1), ...a);
dbg('cfg', JSON.stringify(cfg), 'isolated', (self as unknown as { crossOriginIsolated: boolean }).crossOriginIsolated);
ort.env.wasm.proxy = false;

const buffers = new Map<string, ArrayBuffer>();
const sessions = new Map<string, ort.InferenceSession>();

async function fetchModel(id: number, m: ModelSpec, acc: { loaded: number; total: number }): Promise<ArrayBuffer> {
  const url = modelUrl(m);
  const mem = buffers.get(url);
  if (mem) return mem;
  const cached = await getCachedArrayBuffer(url);
  if (cached) { buffers.set(url, cached); return cached; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下載失敗 ${res.status}：${url}`);
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    n += value.length;
    acc.loaded += value.length;
    post({ id, type: 'stage', stage: 'download', progress: acc.total ? acc.loaded / acc.total : 0, detail: `${m.label}`, bytes: { ...acc } });
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  buffers.set(url, out.buffer);
  try { await putArrayBuffer(url, out.buffer, 'application/octet-stream'); } catch { /* quota */ }
  return out.buffer;
}

async function ensureModels(id: number, list: ModelSpec[]) {
  const missing: ModelSpec[] = [];
  for (const m of list) if (!buffers.has(modelUrl(m)) && !(await getCachedArrayBuffer(modelUrl(m)))) missing.push(m);
  const acc = { loaded: 0, total: Math.round(missing.reduce((s, m) => s + m.approxMB, 0) * 1e6) };
  if (missing.length) post({ id, type: 'stage', stage: 'download', progress: 0, detail: '下載模型', bytes: { ...acc } });
  for (const m of list) await fetchModel(id, m, acc);
  if (missing.length) post({ id, type: 'stage', stage: 'download', progress: 1, detail: '模型就緒', bytes: { loaded: acc.total, total: acc.total } });
}

async function session(m: ModelSpec): Promise<OnnxRun> {
  const url = modelUrl(m);
  let s = sessions.get(url);
  if (!s) {
    dbg('create', m.label);
    s = await ort.InferenceSession.create(new Uint8Array(buffers.get(url)!), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    sessions.set(url, s);
    dbg('created', m.label);
  }
  const sess = s;
  return async (feeds) => {
    const f: Record<string, ort.Tensor> = {};
    for (const [k, v] of Object.entries(feeds)) f[k] = new ort.Tensor('float32', v.data, v.dims as number[]);
    const o = await sess.run(f);
    const r: Record<string, { data: Float32Array; dims: readonly number[] }> = {};
    for (const [k, v] of Object.entries(o)) r[k] = { data: v.data as Float32Array, dims: v.dims };
    return r;
  };
}

self.onmessage = async (ev: MessageEvent<V2Request>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'status') {
      const list = [V2_MODELS.beat, V2_MODELS.btcMajmin, V2_MODELS.btcLarge, ...(msg.withAlign ? [V2_MODELS.w2v] : [])];
      let mb = 0;
      for (const m of list) if (!(await getCachedArrayBuffer(modelUrl(m)))) mb += m.approxMB;
      post({ id: msg.id, type: 'status', missingMB: mb });
      return;
    }
    if (msg.type === 'chords') {
      await ensureModels(msg.id, [V2_MODELS.beat, V2_MODELS.btcMajmin, V2_MODELS.btcLarge]);
      const stage = (stage: V2Stage, detail: string) => (p: number) => post({ id: msg.id, type: 'stage', stage, progress: p, detail });
      const beatRun = await session(V2_MODELS.beat);
      const { beats, downbeats } = await trackBeatsBeatThis(msg.mix22k, beatRun, stage('beats', '偵測節拍'));
      const models = {
        majmin: { run: await session(V2_MODELS.btcMajmin), ...BTC_NORM.majmin, names: btcNames(false) },
        large: { run: await session(V2_MODELS.btcLarge), ...BTC_NORM.large, names: btcNames(true) },
      };
      const r = await detectChordsBtc(msg.acc22k, beats, downbeats, models, stage('chords', '辨識和弦'));
      post({
        id: msg.id, type: 'chordsDone', result: toDetectionResult(r),
        extra: { model: r.model, halfTime: r.halfTime, downbeatsMs: r.downbeats.map((d) => Math.round(d * 1000)) },
      });
      return;
    }
    if (msg.type === 'align') {
      await ensureModels(msg.id, [V2_MODELS.w2v, V2_MODELS.w2vLabels]);
      const labels = JSON.parse(new TextDecoder().decode(buffers.get(modelUrl(V2_MODELS.w2vLabels))!)) as string[];
      const run = await session(V2_MODELS.w2v);
      const r = await alignLyrics(msg.voc16k, msg.lyrics, run, labels, (p) =>
        post({ id: msg.id, type: 'stage', stage: 'align', progress: p, detail: '對齊歌詞' }));
      post({ id: msg.id, type: 'alignDone', lines: r.lines.map((l) => ({ text: l.text, section: l.section })), words: r.words });
    }
  } catch (e) {
    post({ id: msg.id, type: 'error', error: e instanceof Error ? e.message : String(e) });
  }
};
