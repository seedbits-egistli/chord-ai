/// <reference lib="webworker" />
/**
 * v2 analysis worker: Beat This! → BTC chords → (optional) wav2vec2 lyric alignment.
 * All inference is local (onnxruntime-web, wasm EP); models are fetched once and kept in Cache Storage.
 */
import * as ortWasm from 'onnxruntime-web/wasm';
import {
  BTC_NORM,
  alignLyrics,
  btcNames,
  detectChordsBtc,
  separateHtdemucs,
  crepePitch,
  pitchToNotes,
  analyzeStructure,
  accompanimentBeatChroma,
  type MelodyNote,
  type StructureResult,
  type LyricLineTiming,
  toDetectionResult,
  trackBeatsBeatThis,
  type DetectionResult,
  type OnnxRun,
} from '@chord-ai/engine';
import { readOrtWorkerConfig } from '../lib/ortConfig';
import { getCachedArrayBuffer, putArrayBuffer } from '../lib/assetCache';
import { MODEL_BASE_URL, V2_MODELS, modelUrl, type ModelSpec } from '../lib/modelsV2';

export type V2Stage = 'download' | 'separate' | 'beats' | 'chords' | 'melody' | 'align' | 'structure';
export type V2Request =
  | { type: 'beats'; id: number; mix22k: Float32Array }
  | { type: 'separate'; id: number; left: Float32Array; right: Float32Array }
  | { type: 'chords'; id: number; acc22k: Float32Array; beats: number[]; downbeats: number[] }
  | { type: 'align'; id: number; voc16k: Float32Array; lyrics: string }
  | { type: 'melody'; id: number; voc16k: Float32Array; beats: number[] }
  | { type: 'structure'; id: number; mix22k: Float32Array; voc16k: Float32Array; beats: number[]; downbeats: number[]; lines: LyricLineTiming[]; notes: MelodyNote[] }
  | { type: 'status'; id: number; withAlign: boolean };
export type V2Response =
  | { id: number; type: 'stage'; stage: V2Stage; progress: number; detail: string; bytes?: { loaded: number; total: number } }
  | { id: number; type: 'separateDone'; acc: Float32Array; vocals: Float32Array }
  | { id: number; type: 'beatsDone'; beats: number[]; downbeats: number[] }
  | { id: number; type: 'chordsDone'; result: DetectionResult; extra: { model: string; halfTime: boolean; downbeatsMs: number[] } }
  | { id: number; type: 'alignDone'; lines: { text: string; section: number }[]; words: { word: string; line: number; start: number; end: number; confidence: number }[] }
  | { id: number; type: 'melodyDone'; notes: MelodyNote[]; f0: Float32Array; conf: Float32Array; hop: number }
  | { id: number; type: 'structureDone'; result: StructureResult }
  | { id: number; type: 'status'; missingMB: number }
  | { id: number; type: 'error'; error: string };

const post = (m: V2Response) => (self as unknown as Worker).postMessage(m);
const dbg = (...a: unknown[]) => console.log('[v2w]', (performance.now() / 1000).toFixed(1), ...a);
const cfg = readOrtWorkerConfig(self.name);
type Ort = typeof ortWasm;
let ort: Ort = ortWasm;
let eps: string[] = ['wasm'];
let ortInit: Promise<void> | null = null;
/**
 * Pick the execution provider once per worker. WebGPU (opt-in: ?ort_ep=webgpu, or ep=auto with VITE_ORT_WEBGPU=1,
 * only when an adapter exists) loads ORT's webgpu build. Its 26.8 MB asyncify wasm exceeds the Pages 25 MiB limit,
 * so the wasm binary is fetched from MODEL_BASE_URL/ort/ (R2) while the small .mjs glue stays same-origin in /ort/.
 */
function initOrt(): Promise<void> {
  ortInit ??= (async () => {
    const wantGpu = cfg.ep === 'webgpu' || (cfg.ep === 'auto' && import.meta.env.VITE_ORT_WEBGPU === '1');
    let gpuOk = false;
    if (wantGpu && 'gpu' in navigator) {
      try {
        gpuOk = !!(await (navigator as unknown as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter());
      } catch { gpuOk = false; }
    }
    if (gpuOk) {
      ort = (await import('onnxruntime-web/webgpu')) as unknown as Ort;
      ort.env.wasm.wasmPaths = {
        mjs: `${self.location.origin}/ort/ort-wasm-simd-threaded.asyncify.mjs`,
        wasm: new URL(`${MODEL_BASE_URL}/ort/ort-wasm-simd-threaded.asyncify.wasm`, self.location.origin).href,
      };
      eps = ['webgpu', 'wasm'];
    } else {
      ort.env.wasm.wasmPaths = `${self.location.origin}/ort/`;
    }
    ort.env.wasm.numThreads = cfg.threads;
    ort.env.wasm.proxy = false;
    dbg('ep', eps.join(','), 'threads', cfg.threads, wantGpu && !gpuOk ? '(no WebGPU adapter -> wasm)' : '');
  })();
  return ortInit;
}

const buffers = new Map<string, ArrayBuffer>();
const sessions = new Map<string, ortWasm.InferenceSession>();

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
    await initOrt();
    const t = performance.now();
    s = await ort.InferenceSession.create(new Uint8Array(buffers.get(url)!), { executionProviders: eps, graphOptimizationLevel: m.noGraphOpt ? 'disabled' : 'all', enableMemPattern: !m.noGraphOpt, enableCpuMemArena: !m.noGraphOpt });
    sessions.set(url, s);
    dbg('session', m.label, `${(performance.now() - t).toFixed(0)} ms`);
  }
  const sess = s;
  return async (feeds) => {
    const f: Record<string, ortWasm.Tensor> = {};
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
    const stage = (stage: V2Stage, detail: string) => (p: number) => post({ id: msg.id, type: 'stage', stage, progress: p, detail });
    if (msg.type === 'separate') {
      await ensureModels(msg.id, [V2_MODELS.htdemucs]);
      const run = await session(V2_MODELS.htdemucs);
      buffers.delete(modelUrl(V2_MODELS.htdemucs)); // session holds its own copy
      const r = await separateHtdemucs(msg.left, msg.right, run, stage('separate', '分離人聲（HT-Demucs）'));
      (self as unknown as Worker).postMessage({ id: msg.id, type: 'separateDone', acc: r.acc, vocals: r.vocals } satisfies V2Response, [r.acc.buffer, r.vocals.buffer]);
      return;
    }
    if (msg.type === 'beats') {
      await ensureModels(msg.id, [V2_MODELS.beat]);
      const beatRun = await session(V2_MODELS.beat);
      const { beats, downbeats } = await trackBeatsBeatThis(msg.mix22k, beatRun, stage('beats', '偵測節拍'));
      post({ id: msg.id, type: 'beatsDone', beats: Array.from(beats), downbeats: Array.from(downbeats) });
      return;
    }
    if (msg.type === 'chords') {
      await ensureModels(msg.id, [V2_MODELS.btcMajmin, V2_MODELS.btcLarge]);
      const { beats, downbeats } = msg;
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
    if (msg.type === 'melody') {
      await ensureModels(msg.id, [V2_MODELS.crepe]);
      const run = await session(V2_MODELS.crepe);
      const t = await crepePitch(msg.voc16k, run, stage('melody', '擷取旋律（CREPE）'));
      const notes = pitchToNotes(t, msg.beats);
      (self as unknown as Worker).postMessage({ id: msg.id, type: 'melodyDone', notes, f0: t.f0, conf: t.conf, hop: t.hop } satisfies V2Response, [t.f0.buffer, t.conf.buffer]);
      return;
    }
    if (msg.type === 'structure') {
      post({ id: msg.id, type: 'stage', stage: 'structure', progress: 0.1, detail: '切割段落' });
      const result = analyzeStructure(msg.mix22k, msg.voc16k, msg.beats, msg.downbeats, msg.lines, msg.notes);
      result.accChroma = accompanimentBeatChroma(msg.mix22k, msg.voc16k, msg.beats);
      post({ id: msg.id, type: 'structureDone', result });
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
