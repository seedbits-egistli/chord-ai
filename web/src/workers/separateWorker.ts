/// <reference lib="webworker" />
// wasm-only entry (not default ort which loads ort-wasm-simd-threaded.jsep.*).
import { readOrtWorkerConfig } from '../lib/ortConfig';
import * as ort from 'onnxruntime-web/wasm';
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
  putArrayBuffer,
  type CacheSource,
  type CachedAssetInfo,
} from '../lib/assetCache';

/**
 * Same-origin ORT wasm runtime (web/public/ort via sync-ort-runtime.mjs).
 * Must be real http(s) URLs — ORT's multi-thread path fetch()→blob:→import()
 * fails under COOP/COEP in Vite workers (and jsep is not shipped).
 */
function ortWasmBase(): string {
  const origin =
    typeof self !== 'undefined' && self.location?.origin && self.location.origin !== 'null'
      ? self.location.origin
      : '';
  return `${origin}/ort/`;
}

export type SeparateRequest = {
  type?: 'separate';
  id: number;
  samples: Float32Array;
  sampleRate: number;
  vocalsUrl?: string;
  bassUrl?: string;
  /** When false, skip bass ONNX (~17 MiB) and use lowpass proxy. Default true. */
  useBass?: boolean;
  /** Ignored: WebGPU/jsep is not shipped (25 MiB limit); wasm EP only. */
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

/** In-memory ONNX bytes (survives across analyses in the same long-lived worker). */
const memoryBuffers = new Map<string, ArrayBuffer>();
/** Warm ONNX sessions keyed by url + EP list. */
const sessions = new Map<string, OrtSession>();
let ortConfigured = false;
let ortInitPromise: Promise<void> | null = null;

// Cache ONNX fetches only — never ORT .mjs/.wasm (breaks blob: dynamic import).
installFetchCacheInterceptor((url) => isOnnxModelUrl(url));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function configureOrt(): Promise<void> {
  if (ortConfigured) return;
  if (ortInitPromise) return ortInitPromise;
  ortInitPromise = (async () => {
    const base = ortWasmBase();
    ort.env.wasm.wasmPaths = base;
    // numThreads>1 makes ORT fetch the .mjs, wrap it as blob:, then import() —
    // that fails under COOP/COEP ("Failed to fetch dynamically imported module: blob:…").
    // Keep single-threaded same-origin import of /ort/*.mjs.
    // Threads work once /ort/* is served with COOP/COEP (pthread workers must be isolated too).
    ort.env.wasm.numThreads = readOrtWorkerConfig(self.name).threads;
    ort.env.wasm.proxy = false;
    // Probe that same-origin runtime is real JS — Vite SPA can 200 index.html for /ort/*
    const mjsUrl = `${base}ort-wasm-simd-threaded.mjs`;
    const wasmUrl = `${base}ort-wasm-simd-threaded.wasm`;
    const probe = await fetch(mjsUrl, { method: 'GET' });
    if (!probe.ok) {
      throw new Error(
        `ORT runtime missing at ${mjsUrl} (${probe.status}). Restart Vite or run: npm run sync:ort`,
      );
    }
    const ct = (probe.headers.get('content-type') || '').toLowerCase();
    const head = (await probe.text()).trimStart().slice(0, 80);
    if (
      ct.includes('text/html') ||
      head.startsWith('<!DOCTYPE') ||
      head.startsWith('<!doctype') ||
      head.startsWith('<html') ||
      head.startsWith('<HTML')
    ) {
      throw new Error(
        `ORT runtime at ${mjsUrl} returned HTML (SPA fallback), not the wasm loader. ` +
          'Restart the Vite dev server so ensureOrtRuntime can copy files from node_modules.',
      );
    }
    // Lightweight existence check — avoid downloading 14 MiB just to probe.
    const wasmProbe = await fetch(wasmUrl, { method: 'HEAD' });
    if (!wasmProbe.ok) {
      throw new Error(
        `ORT wasm missing at ${wasmUrl} (${wasmProbe.status}). Restart Vite or run: npm run sync:ort`,
      );
    }
    ortConfigured = true;
  })();
  try {
    await withTimeout(ortInitPromise, 30_000, 'ORT runtime init');
  } catch (e) {
    ortInitPromise = null;
    ortConfigured = false;
    throw e;
  }
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

function trackedModelUrls(vocalsUrl: string, bassUrl: string, withBass: boolean) {
  const entries: { url: string; label: string }[] = [
    { url: vocalsUrl, label: 'vocals.onnx' },
  ];
  if (withBass) entries.push({ url: bassUrl, label: 'bass.onnx' });
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
    await putArrayBuffer(url, buf, 'application/octet-stream');
  } catch (e) {
    console.warn('Cache Storage put failed', e);
  }
  return { buf, source: 'network' };
}

async function getOrCreateSession(
  url: string,
  buf: ArrayBuffer,
): Promise<OrtSession> {
  const key = `${url}|wasm`;
  const hit = sessions.get(key);
  if (hit) return hit;
  if (!buf || buf.byteLength < 1024) {
    throw new Error(`ONNX buffer too small for ${url} (${buf?.byteLength ?? 0} bytes)`);
  }
  const label = url.split('/').pop() || 'model.onnx';
  const session = await withTimeout(
    ort.InferenceSession.create(buf.slice(0), {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'basic',
      enableCpuMemArena: false,
      enableMemPattern: false,
    }),
    90_000,
    `ONNX session create (${label})`,
  );
  sessions.set(key, session as unknown as OrtSession);
  return session as unknown as OrtSession;
}

async function handleCacheStatus(msg: CacheStatusRequest) {
  const { vocalsUrl, bassUrl, withBass } = resolveUrls(msg);
  const entries = await assetStatus(trackedModelUrls(vocalsUrl, bassUrl, withBass));
  for (const e of entries) {
    if (!e.cached && memoryBuffers.has(e.url)) {
      e.cached = true;
      e.bytes = memoryBuffers.get(e.url)!.byteLength;
    }
  }
  const totalBytes = entries.reduce((s, e) => s + (e.bytes ?? 0), 0);
  const allCached = entries.length > 0 && entries.every((e) => e.cached);
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
  // Keep ortConfigured — runtime files are same-origin, not in Cache Storage
  await clearAssetCache();
  post({ id: msg.id, type: 'cacheCleared' });
}

async function handlePrefetch(msg: PrefetchRequest) {
  const { vocalsUrl, bassUrl, withBass } = resolveUrls(msg);
  await configureOrt();
  const sources: Record<string, CacheSource> = { ort: 'memory' };
  const v = await loadAsset(vocalsUrl, msg.id, 'vocals.onnx', 0.05, 0.4);
  sources.vocals = v.source;
  if (withBass) {
    const b = await loadAsset(bassUrl, msg.id, 'bass.onnx', 0.4, 0.85);
    sources.bass = b.source;
  }
  post({ id: msg.id, type: 'prefetchDone', sources });
}

async function handleSeparate(msg: SeparateRequest) {
  const { id, samples, sampleRate, useBass } = msg;
  try {
    post({ id, type: 'progress', progress: 0.02, detail: '初始化 ORT（同源 /ort/）…' });
    await configureOrt();
    const { vocalsUrl, bassUrl, withBass } = resolveUrls({
      vocalsUrl: msg.vocalsUrl,
      bassUrl: msg.bassUrl,
      useBass,
    });

    const v = await loadAsset(vocalsUrl, id, 'vocals.onnx', 0.05, 0.25);
    let bassBuf: ArrayBuffer | null = null;
    let bassSource: CacheSource | 'skipped' = 'skipped';
    if (withBass) {
      const b = await loadAsset(bassUrl, id, 'bass.onnx', 0.25, 0.4);
      bassBuf = b.buf;
      bassSource = b.source;
    }

    post({ id, type: 'progress', progress: 0.42, detail: '建立 ONNX session（vocals）…' });
    const vocalsSession = await getOrCreateSession(vocalsUrl, v.buf);
    let bassSession: OrtSession | null = null;
    if (bassBuf) {
      post({ id, type: 'progress', progress: 0.44, detail: '建立 ONNX session（bass）…' });
      bassSession = await getOrCreateSession(bassUrl, bassBuf);
    }

    post({ id, type: 'progress', progress: 0.46, detail: '執行 UMX 分離…' });
    const stems = await withTimeout(
      separateWithUmx(samples, sampleRate, {
        ort: ort as unknown as import('@chord-ai/engine').OrtLike,
        vocalsSession,
        bassSession,
        sessionOptions: {
          executionProviders: ['wasm'],
          graphOptimizationLevel: 'basic',
          enableCpuMemArena: false,
          enableMemPattern: false,
        },
        onProgress: (p) => {
          post({
            id,
            type: 'progress',
            progress: 0.46 + p.progress * 0.5,
            detail: p.detail || p.phase,
            fromCache: v.source !== 'network' && bassSource !== 'network',
          });
        },
      }),
      240_000,
      'UMX separation',
    );

    post({
      id,
      type: 'progress',
      progress: 1,
      detail: '分離完成',
      fromCache: v.source !== 'network' && bassSource !== 'network',
    });
    post({
      id,
      ok: true,
      sources: { vocals: v.source, bass: bassSource, ort: 'memory' },
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
