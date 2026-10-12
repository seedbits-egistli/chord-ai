/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';
import {
  UMX_BASS_URL,
  UMX_SAMPLE_RATE,
  UMX_TOTAL_MB,
  UMX_VOCALS_URL,
  separateWithUmx,
  type OrtSession,
} from '@chord-ai/engine';
import {
  CACHE_NAME,
  CACHE_VERSION,
  assetStatus,
  clearAssetCache,
  getCachedArrayBuffer,
  installFetchCacheInterceptor,
  isOnnxModelUrl,
  isOrtCdnUrl,
  putArrayBuffer,
  type CacheSource,
  type CachedAssetInfo,
} from '../lib/assetCache';

/** ORT wasm/mjs loaded from CDN — keep Workers static assets under the 25 MiB limit. */
const ORT_VERSION = '1.30.0';
const ORT_WASM_CDN = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;

/** ORT files we proactively pin into Cache Storage (wasm EP + jsep for WebGPU). */
const ORT_PIN_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.jsep.mjs',
];

export type SeparateRequest = {
  type?: 'separate';
  id: number;
  samples: Float32Array;
  sampleRate: number;
  vocalsUrl?: string;
  bassUrl?: string;
  /** When false, skip bass ONNX (~17 MiB) and use lowpass proxy. Default true. */
  useBass?: boolean;
  preferWebGpu?: boolean;
};

export type CacheStatusRequest = {
  type: 'cacheStatus';
  id: number;
  vocalsUrl?: string;
  bassUrl?: string;
  useBass?: boolean;
};

export type ClearCacheRequest = {
  type: 'clearCache';
  id: number;
};

export type PrefetchRequest = {
  type: 'prefetch';
  id: number;
  vocalsUrl?: string;
  bassUrl?: string;
  useBass?: boolean;
  preferWebGpu?: boolean;
};

export type WorkerRequest =
  | SeparateRequest
  | CacheStatusRequest
  | ClearCacheRequest
  | PrefetchRequest;

export type SeparateResponse =
  | {
      id: number;
      ok: true;
      stems: {
        drumsL: Float32Array;
        drumsR: Float32Array;
        bassL: Float32Array;
        bassR: Float32Array;
        otherL: Float32Array;
        otherR: Float32Array;
        vocalsL: Float32Array;
        vocalsR: Float32Array;
        sampleRate: number;
      };
      sources: { vocals: CacheSource; bass: CacheSource | 'skipped'; ort: CacheSource };
    }
  | { id: number; ok: false; error: string }
  | {
      id: number;
      type: 'progress';
      progress: number;
      detail: string;
      fromCache?: boolean;
    }
  | {
      id: number;
      type: 'cacheStatus';
      cacheName: string;
      cacheVersion: string;
      entries: CachedAssetInfo[];
      allCached: boolean;
      totalBytes: number;
    }
  | { id: number; type: 'cacheCleared' }
  | { id: number; type: 'prefetchDone'; sources: Record<string, CacheSource> };

/** In-memory bytes (survives across analyses in the same long-lived worker). */
const memoryBuffers = new Map<string, ArrayBuffer>();
/** Warm ONNX sessions keyed by url + EP list. */
const sessions = new Map<string, OrtSession>();
let ortConfigured = false;
let ortWarmSource: CacheSource = 'network';

installFetchCacheInterceptor(
  (url) => isOrtCdnUrl(url, ORT_WASM_CDN) || isOnnxModelUrl(url),
);

function configureOrt(preferWebGpu: boolean) {
  if (ortConfigured) return;
  ort.env.wasm.wasmPaths = ORT_WASM_CDN;
  try {
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
  } catch {
    /* ignore */
  }
  void preferWebGpu;
  ortConfigured = true;
}

function post(msg: SeparateResponse) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

function envUrl(key: 'VITE_UMX_VOCALS_URL' | 'VITE_UMX_BASS_URL'): string | undefined {
  try {
    return (import.meta as ImportMeta & { env?: Record<string, string> }).env?.[key];
  } catch {
    return undefined;
  }
}

function resolveUrls(msg: {
  vocalsUrl?: string;
  bassUrl?: string;
  useBass?: boolean;
}): { vocalsUrl: string; bassUrl: string; withBass: boolean } {
  return {
    vocalsUrl: msg.vocalsUrl || envUrl('VITE_UMX_VOCALS_URL') || UMX_VOCALS_URL,
    bassUrl: msg.bassUrl || envUrl('VITE_UMX_BASS_URL') || UMX_BASS_URL,
    withBass: msg.useBass !== false,
  };
}

function trackedUrls(vocalsUrl: string, bassUrl: string, withBass: boolean) {
  const entries: { url: string; label: string }[] = [
    { url: vocalsUrl, label: 'vocals.onnx' },
  ];
  if (withBass) entries.push({ url: bassUrl, label: 'bass.onnx' });
  for (const f of ORT_PIN_FILES) {
    entries.push({ url: `${ORT_WASM_CDN}${f}`, label: f });
  }
  return entries;
}

async function loadAsset(
  url: string,
  id: number,
  label: string,
  progressFrom: number,
  progressTo: number,
): Promise<{ buf: ArrayBuffer; source: CacheSource }> {
  const mem = memoryBuffers.get(url);
  if (mem) {
    post({
      id,
      type: 'progress',
      progress: progressTo,
      detail: `已快取（記憶體）${label}`,
      fromCache: true,
    });
    return { buf: mem, source: 'memory' };
  }

  const cached = await getCachedArrayBuffer(url);
  if (cached) {
    memoryBuffers.set(url, cached);
    post({
      id,
      type: 'progress',
      progress: progressTo,
      detail: `已快取 ${label}`,
      fromCache: true,
    });
    return { buf: cached, source: 'cache' };
  }

  post({
    id,
    type: 'progress',
    progress: progressFrom,
    detail: `下載 ${label}（合計 ≲${UMX_TOTAL_MB}MB）…`,
    fromCache: false,
  });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status} ${url}`);
  const total = Number(res.headers.get('content-length') || 0);
  let buf: ArrayBuffer;
  if (!res.body) {
    buf = await res.arrayBuffer();
  } else {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      const t = total ? loaded / total : 0.5;
      post({
        id,
        type: 'progress',
        progress: progressFrom + (progressTo - progressFrom) * t,
        detail: `${label} ${(loaded / 1e6).toFixed(1)}${total ? `/${(total / 1e6).toFixed(1)}` : ''} MB`,
        fromCache: false,
      });
    }
    const out = new Uint8Array(loaded);
    let off = 0;
    for (const c of chunks) {
      out.set(c, off);
      off += c.length;
    }
    buf = out.buffer;
  }

  memoryBuffers.set(url, buf);
  try {
    await putArrayBuffer(url, buf, label.endsWith('.onnx') ? 'application/octet-stream' : 'application/wasm');
  } catch (e) {
    console.warn('Cache Storage put failed', e);
  }
  return { buf, source: 'network' };
}

async function pinOrtWasm(
  id: number,
  preferWebGpu: boolean,
): Promise<CacheSource> {
  const files = preferWebGpu
    ? ORT_PIN_FILES
    : ORT_PIN_FILES.filter((f) => !f.includes('jsep'));
  let worst: CacheSource = 'memory';
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const url = `${ORT_WASM_CDN}${f}`;
    // Quiet progress band 0.0–0.02
    const { source } = await loadAsset(url, id, f, 0.001 + i * 0.002, 0.01 + i * 0.002);
    if (source === 'network') worst = 'network';
    else if (source === 'cache' && worst === 'memory') worst = 'cache';
  }
  ortWarmSource = worst;
  return worst;
}

async function getOrCreateSession(
  url: string,
  buf: ArrayBuffer,
  providers: string[],
): Promise<OrtSession> {
  const key = `${url}|${providers.join(',')}`;
  const hit = sessions.get(key);
  if (hit) return hit;
  const session = await ort.InferenceSession.create(buf, {
    executionProviders: providers,
    graphOptimizationLevel: 'basic',
    enableCpuMemArena: false,
    enableMemPattern: false,
  });
  sessions.set(key, session as unknown as OrtSession);
  return session as unknown as OrtSession;
}

async function handleCacheStatus(msg: CacheStatusRequest) {
  const { vocalsUrl, bassUrl, withBass } = resolveUrls(msg);
  const entries = await assetStatus(trackedUrls(vocalsUrl, bassUrl, withBass));
  // Treat memory hits as cached for UI
  for (const e of entries) {
    if (!e.cached && memoryBuffers.has(e.url)) {
      e.cached = true;
      e.bytes = memoryBuffers.get(e.url)!.byteLength;
    }
  }
  const totalBytes = entries.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const modelEntries = entries.filter((e) => e.label.endsWith('.onnx'));
  const allCached = modelEntries.every((e) => e.cached);
  post({
    id: msg.id,
    type: 'cacheStatus',
    cacheName: CACHE_NAME,
    cacheVersion: CACHE_VERSION,
    entries,
    allCached,
    totalBytes,
  });
}

async function handleClearCache(msg: ClearCacheRequest) {
  memoryBuffers.clear();
  sessions.clear();
  ortConfigured = false;
  ortWarmSource = 'network';
  await clearAssetCache();
  post({ id: msg.id, type: 'cacheCleared' });
}

async function handlePrefetch(msg: PrefetchRequest) {
  const { vocalsUrl, bassUrl, withBass } = resolveUrls(msg);
  configureOrt(msg.preferWebGpu !== false);
  const sources: Record<string, CacheSource> = {};
  sources.ort = await pinOrtWasm(msg.id, msg.preferWebGpu !== false);
  const v = await loadAsset(vocalsUrl, msg.id, 'vocals.onnx', 0.05, 0.4);
  sources.vocals = v.source;
  if (withBass) {
    const b = await loadAsset(bassUrl, msg.id, 'bass.onnx', 0.4, 0.85);
    sources.bass = b.source;
  }
  post({ id: msg.id, type: 'prefetchDone', sources });
}

async function handleSeparate(msg: SeparateRequest) {
  const { id, samples, sampleRate, preferWebGpu, useBass } = msg;
  try {
    configureOrt(preferWebGpu !== false);
    const { vocalsUrl, bassUrl, withBass } = resolveUrls({
      vocalsUrl: msg.vocalsUrl,
      bassUrl: msg.bassUrl,
      useBass,
    });

    const ortSource = await pinOrtWasm(id, preferWebGpu !== false);
    const v = await loadAsset(vocalsUrl, id, 'vocals.onnx', 0.02, 0.22);
    let bassBuf: ArrayBuffer | null = null;
    let bassSource: CacheSource | 'skipped' = 'skipped';
    if (withBass) {
      const b = await loadAsset(bassUrl, id, 'bass.onnx', 0.22, 0.4);
      bassBuf = b.buf;
      bassSource = b.source;
    }

    const providers: string[] = preferWebGpu !== false ? ['webgpu', 'wasm'] : ['wasm'];
    const vocalsSession = await getOrCreateSession(vocalsUrl, v.buf, providers);
    const bassSession = bassBuf
      ? await getOrCreateSession(bassUrl, bassBuf, providers)
      : null;

    const stems = await separateWithUmx(samples, sampleRate, {
      ort: ort as unknown as import('@chord-ai/engine').OrtLike,
      vocalsSession,
      bassSession,
      sessionOptions: {
        executionProviders: providers,
        graphOptimizationLevel: 'basic',
        enableCpuMemArena: false,
        enableMemPattern: false,
      },
      onProgress: (p) => {
        post({
          id,
          type: 'progress',
          progress: 0.4 + p.progress * 0.55,
          detail: p.detail || p.phase,
          fromCache: v.source !== 'network' && bassSource !== 'network',
        });
      },
    });

    post({
      id,
      ok: true,
      sources: { vocals: v.source, bass: bassSource, ort: ortSource },
      stems: {
        drumsL: stems.drums.left,
        drumsR: stems.drums.right,
        bassL: stems.bass.left,
        bassR: stems.bass.right,
        otherL: stems.other.left,
        otherR: stems.other.right,
        vocalsL: stems.vocals.left,
        vocalsR: stems.vocals.right,
        sampleRate: stems.sampleRate || UMX_SAMPLE_RATE,
      },
    });
  } catch (e) {
    post({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const data = ev.data;
  const type = 'type' in data && data.type ? data.type : 'separate';
  if (type === 'cacheStatus') {
    await handleCacheStatus(data as CacheStatusRequest);
    return;
  }
  if (type === 'clearCache') {
    await handleClearCache(data as ClearCacheRequest);
    return;
  }
  if (type === 'prefetch') {
    await handlePrefetch(data as PrefetchRequest);
    return;
  }
  await handleSeparate(data as SeparateRequest);
};
