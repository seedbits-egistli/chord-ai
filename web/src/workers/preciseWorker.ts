/// <reference lib="webworker" />
/**
 * 精準模式 worker: Basic Pitch on bass/other stems → note-based chords.
 * Expects already-separated stem channels from the main thread / separateWorker.
 */
import * as ort from 'onnxruntime-web/wasm';
import {
  BASIC_PITCH_MODEL_URL,
  detectChordsPreciseFromStems,
  stemToMono,
  transcribeNotes,
  type DetectionResult,
  type NoteEvent,
  type SeparationStems,
} from '@chord-ai/engine';
import {
  getCachedArrayBuffer,
  installFetchCacheInterceptor,
  isOnnxModelUrl,
  putArrayBuffer,
  type CacheSource,
} from '../lib/assetCache';

installFetchCacheInterceptor((url) => isOnnxModelUrl(url));

export type PreciseRequest = {
  type: 'precise';
  id: number;
  sampleRate: number;
  drumsL: Float32Array;
  drumsR: Float32Array;
  bassL: Float32Array;
  bassR: Float32Array;
  otherL: Float32Array;
  otherR: Float32Array;
  vocalsL: Float32Array;
  vocalsR: Float32Array;
  simplifyLevel?: number;
  bpmHint?: number;
  modelUrl?: string;
};

export type PreciseResponse =
  | {
      id: number;
      ok: true;
      result: DetectionResult;
      sources: { basicPitch: CacheSource };
      noteCounts: { other: number; bass: number };
    }
  | { id: number; ok: false; error: string }
  | { id: number; type: 'progress'; progress: number; detail: string; fromCache?: boolean };

function ortWasmBase(): string {
  const origin =
    typeof self !== 'undefined' && self.location?.origin && self.location.origin !== 'null'
      ? self.location.origin
      : '';
  return `${origin}/ort/`;
}

let ortReady: Promise<void> | null = null;
let bpSession: ort.InferenceSession | null = null;
let bpModelKey = '';

async function ensureOrt(): Promise<void> {
  if (ortReady) return ortReady;
  ortReady = (async () => {
    ort.env.wasm.wasmPaths = ortWasmBase();
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
  })();
  return ortReady;
}

async function loadBasicPitchModel(
  url: string,
  id: number,
): Promise<{ bytes: Uint8Array; source: CacheSource }> {
  const cached = await getCachedArrayBuffer(url);
  if (cached) {
    post({
      id,
      type: 'progress',
      progress: 0.12,
      detail: '已快取 Basic Pitch 模型',
      fromCache: true,
    });
    return { bytes: new Uint8Array(cached), source: 'cache' };
  }
  post({
    id,
    type: 'progress',
    progress: 0.08,
    detail: '下載 Basic Pitch（~0.2MB）…',
    fromCache: false,
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Basic Pitch download failed: ${res.status}`);
  const buf = await res.arrayBuffer();
  try {
    await putArrayBuffer(url, buf, 'application/octet-stream');
  } catch {
    /* quota */
  }
  return { bytes: new Uint8Array(buf), source: 'network' };
}

async function getBpSession(modelBytes: Uint8Array, key: string): Promise<ort.InferenceSession> {
  if (bpSession && bpModelKey === key) return bpSession;
  await ensureOrt();
  bpSession = await ort.InferenceSession.create(modelBytes.slice(), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  bpModelKey = key;
  return bpSession;
}

function post(msg: PreciseResponse) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

async function handlePrecise(msg: PreciseRequest) {
  const { id } = msg;
  try {
    post({ id, type: 'progress', progress: 0.05, detail: '初始化 Basic Pitch…' });
    await ensureOrt();
    const modelUrl = msg.modelUrl || BASIC_PITCH_MODEL_URL;
    const { bytes, source } = await loadBasicPitchModel(modelUrl, id);
    const session = await getBpSession(bytes, modelUrl);

    const stems: SeparationStems = {
      drums: { left: msg.drumsL, right: msg.drumsR },
      bass: { left: msg.bassL, right: msg.bassR },
      other: { left: msg.otherL, right: msg.otherR },
      vocals: { left: msg.vocalsL, right: msg.vocalsR },
      sampleRate: msg.sampleRate,
    };

    const otherMono = stemToMono(stems.other.left, stems.other.right);
    const bassMono = stemToMono(stems.bass.left, stems.bass.right);

    const makeSession = async () => ({
      inputs: session.inputNames.map((name) => ({ name })),
      run: async (
        feeds: Record<string, { data: Float32Array; dims: number[]; type: string }>,
      ) => {
        const ortFeeds: Record<string, ort.Tensor> = {};
        for (const [k, v] of Object.entries(feeds)) {
          ortFeeds[k] = new ort.Tensor(v.type as 'float32', v.data, v.dims);
        }
        const out = await session.run(ortFeeds);
        const result: Record<string, { data: Float32Array; dims: number[] }> = {};
        for (const [k, t] of Object.entries(out)) {
          const data =
            t.data instanceof Float32Array ? t.data : new Float32Array(t.data as ArrayLike<number>);
          result[k] = { data, dims: Array.from(t.dims) };
        }
        return result;
      },
      // Keep warm session across windows / stems
      free: () => undefined,
    });

    post({ id, type: 'progress', progress: 0.2, detail: '轉錄伴奏軌（other）…' });
    const otherNotes: NoteEvent[] = await transcribeNotes(otherMono, {
      sampleRate: msg.sampleRate,
      model: bytes,
      session: makeSession,
      minFreq: 80,
      maxFreq: 1200,
    });

    post({ id, type: 'progress', progress: 0.55, detail: '轉錄貝斯軌…' });
    const bassNotes: NoteEvent[] = await transcribeNotes(bassMono, {
      sampleRate: msg.sampleRate,
      model: bytes,
      session: makeSession,
      minFreq: 30,
      maxFreq: 350,
      onsetThreshold: 0.4,
      frameThreshold: 0.25,
    });

    post({ id, type: 'progress', progress: 0.85, detail: '以音符推斷和弦…' });
    const result = detectChordsPreciseFromStems(stems, otherNotes, bassNotes, {
      simplifyLevel: msg.simplifyLevel ?? 0.4,
      bpmHint: msg.bpmHint,
      halfBar: true,
      suppressDrone: true,
    });

    post({ id, type: 'progress', progress: 1, detail: '精準模式完成' });
    post({
      id,
      ok: true,
      result,
      sources: { basicPitch: source === 'cache' ? 'cache' : source },
      noteCounts: { other: otherNotes.length, bass: bassNotes.length },
    });
  } catch (e) {
    post({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

self.onmessage = async (ev: MessageEvent<PreciseRequest>) => {
  if (ev.data?.type === 'precise') await handlePrecise(ev.data);
};
