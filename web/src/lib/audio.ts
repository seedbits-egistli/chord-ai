import {
  detectChordsFromStems,
  type DetectionResult,
  type DetectOptions,
  type SeparationStems,
} from '@chord-ai/engine';
import type { WorkerRequest, WorkerResponse } from '../workers/chordWorker';
import type {
  SeparateRequest,
  SeparateResponse,
  WorkerRequest as SeparateWorkerRequest,
} from '../workers/separateWorker';
import type { CacheSource, CachedAssetInfo } from './assetCache';

type ChordGlobal = typeof globalThis & {
  __chordAiChordWorker?: Worker;
  __chordAiSeparateWorker?: Worker;
  __chordAiSeq?: number;
};

const g = globalThis as ChordGlobal;

function nextId(): number {
  g.__chordAiSeq = (g.__chordAiSeq ?? 0) + 1;
  return g.__chordAiSeq;
}

function getChordWorker() {
  if (!g.__chordAiChordWorker) {
    const w = new Worker(new URL('../workers/chordWorker.ts', import.meta.url), {
      type: 'module',
    });
    w.addEventListener('error', () => {
      if (g.__chordAiChordWorker === w) g.__chordAiChordWorker = undefined;
    });
    g.__chordAiChordWorker = w;
  }
  return g.__chordAiChordWorker;
}

/** Single long-lived separation worker (survives HMR via globalThis). */
export function getSeparateWorker() {
  if (!g.__chordAiSeparateWorker) {
    const w = new Worker(new URL('../workers/separateWorker.ts', import.meta.url), {
      type: 'module',
    });
    w.addEventListener('error', () => {
      if (g.__chordAiSeparateWorker === w) g.__chordAiSeparateWorker = undefined;
    });
    g.__chordAiSeparateWorker = w;
  }
  return g.__chordAiSeparateWorker;
}

export async function decodeFile(
  file: File,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const ctx = new AudioContext();
  try {
    const buf = await file.arrayBuffer();
    const audio = await ctx.decodeAudioData(buf.slice(0));
    const samples = mixToMono(audio);
    return { samples, sampleRate: audio.sampleRate };
  } finally {
    await ctx.close();
  }
}

function mixToMono(audio: AudioBuffer): Float32Array {
  const len = audio.length;
  const out = new Float32Array(len);
  const channels = audio.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) out[i]! += data[i]! / channels;
  }
  return out;
}

export function detectInWorker(
  samples: Float32Array,
  sampleRate: number,
  options?: DetectOptions,
): Promise<DetectionResult> {
  const w = getChordWorker();
  const id = nextId();
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<WorkerResponse>) => {
      if (ev.data.id !== id) return;
      w.removeEventListener('message', onMsg);
      if (ev.data.ok) resolve(ev.data.result);
      else reject(new Error(ev.data.error));
    };
    w.addEventListener('message', onMsg);
    const msg: WorkerRequest = { id, samples, sampleRate, options };
    w.postMessage(msg);
  });
}

export type SeparateSources = {
  vocals: CacheSource;
  bass: CacheSource | 'skipped';
  ort: CacheSource;
};

export function separateInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: {
    preferWebGpu?: boolean;
    vocalsUrl?: string;
    bassUrl?: string;
    useBass?: boolean;
    onProgress?: (progress: number, detail: string, fromCache?: boolean) => void;
  } = {},
): Promise<SeparationStems & { sources: SeparateSources }> {
  const w = getSeparateWorker();
  const id = nextId();
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<SeparateResponse>) => {
      const data = ev.data;
      if (data.id !== id) return;
      if ('type' in data && data.type === 'progress') {
        options.onProgress?.(data.progress, data.detail, data.fromCache);
        return;
      }
      w.removeEventListener('message', onMsg);
      if ('ok' in data && data.ok === false) {
        reject(new Error(data.error));
        return;
      }
      if (!('ok' in data) || !data.ok) {
        reject(new Error('Unexpected worker response'));
        return;
      }
      const stems = data.stems;
      resolve({
        drums: { left: stems.drumsL, right: stems.drumsR },
        bass: { left: stems.bassL, right: stems.bassR },
        other: { left: stems.otherL, right: stems.otherR },
        vocals: { left: stems.vocalsL, right: stems.vocalsR },
        sampleRate: stems.sampleRate,
        sources: data.sources,
      });
    };
    w.addEventListener('message', onMsg);
    const msg: SeparateRequest = {
      type: 'separate',
      id,
      samples,
      sampleRate,
      preferWebGpu: options.preferWebGpu,
      vocalsUrl: options.vocalsUrl,
      bassUrl: options.bassUrl,
      useBass: options.useBass,
    };
    w.postMessage(msg);
  });
}

export interface ModelCacheStatus {
  cacheName: string;
  cacheVersion: string;
  entries: CachedAssetInfo[];
  allCached: boolean;
  totalBytes: number;
}

function workerRpc<T extends SeparateResponse>(
  request: SeparateWorkerRequest,
): Promise<T> {
  const w = getSeparateWorker();
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<SeparateResponse>) => {
      if (ev.data.id !== request.id) return;
      if ('type' in ev.data && ev.data.type === 'progress') return;
      w.removeEventListener('message', onMsg);
      if ('ok' in ev.data && ev.data.ok === false) {
        reject(new Error(ev.data.error));
        return;
      }
      resolve(ev.data as T);
    };
    w.addEventListener('message', onMsg);
    w.postMessage(request);
  });
}

export async function getModelCacheStatus(options: {
  vocalsUrl?: string;
  bassUrl?: string;
  useBass?: boolean;
} = {}): Promise<ModelCacheStatus> {
  const res = await workerRpc<Extract<SeparateResponse, { type: 'cacheStatus' }>>({
    type: 'cacheStatus',
    id: nextId(),
    ...options,
  });
  return {
    cacheName: res.cacheName,
    cacheVersion: res.cacheVersion,
    entries: res.entries,
    allCached: res.allCached,
    totalBytes: res.totalBytes,
  };
}

export async function clearModelCache(): Promise<void> {
  await workerRpc({ type: 'clearCache', id: nextId() });
}

export async function prefetchModels(options: {
  preferWebGpu?: boolean;
  vocalsUrl?: string;
  bassUrl?: string;
  useBass?: boolean;
  onProgress?: (progress: number, detail: string, fromCache?: boolean) => void;
} = {}): Promise<Record<string, CacheSource>> {
  const w = getSeparateWorker();
  const id = nextId();
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<SeparateResponse>) => {
      const data = ev.data;
      if (data.id !== id) return;
      if ('type' in data && data.type === 'progress') {
        options.onProgress?.(data.progress, data.detail, data.fromCache);
        return;
      }
      w.removeEventListener('message', onMsg);
      if ('ok' in data && data.ok === false) {
        reject(new Error(data.error));
        return;
      }
      if ('type' in data && data.type === 'prefetchDone') {
        resolve(data.sources);
        return;
      }
      reject(new Error('Unexpected prefetch response'));
    };
    w.addEventListener('message', onMsg);
    w.postMessage({
      type: 'prefetch',
      id,
      preferWebGpu: options.preferWebGpu,
      vocalsUrl: options.vocalsUrl,
      bassUrl: options.bassUrl,
      useBass: options.useBass,
    } satisfies SeparateWorkerRequest);
  });
}

function formatSources(sources: SeparateSources): string {
  const part = (s: CacheSource | 'skipped') =>
    s === 'network' ? '網路' : s === 'skipped' ? '略過' : '快取';
  return `模型：vocals ${part(sources.vocals)}、bass ${part(sources.bass)}、ORT ${part(sources.ort)}`;
}

/** Separate (optional) then detect — all in workers / local. */
export async function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  options: {
    separate: boolean;
    preferWebGpu?: boolean;
    detect?: DetectOptions;
    onProgress?: (progress: number, detail: string, fromCache?: boolean) => void;
  },
): Promise<DetectionResult & { usedSeparation: boolean; separateSources?: SeparateSources }> {
  if (!options.separate) {
    options.onProgress?.(0.2, '和弦辨識中…');
    const result = await detectInWorker(samples, sampleRate, options.detect);
    options.onProgress?.(1, '完成');
    return { ...result, usedSeparation: false };
  }

  try {
    const stems = await separateInWorker(samples, sampleRate, {
      preferWebGpu: options.preferWebGpu,
      onProgress: options.onProgress,
    });
    options.onProgress?.(0.95, '以人聲分離後的伴奏辨識和弦…');
    const result = detectChordsFromStems(stems, options.detect);
    options.onProgress?.(1, `完成（UMX-HQ；${formatSources(stems.sources)}）`);
    return { ...result, usedSeparation: true, separateSources: stems.sources };
  } catch (e) {
    console.warn('Separation failed, falling back to full mix', e);
    options.onProgress?.(0.5, '分離失敗，改用完整混音…');
    const result = await detectInWorker(samples, sampleRate, options.detect);
    return { ...result, usedSeparation: false };
  }
}

/** Record from microphone until stop() is called. */
export async function recordMicrophone(
  onChunk?: (level: number) => void,
): Promise<{
  stop: () => Promise<{ samples: Float32Array; sampleRate: number }>;
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
    },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    if (onChunk) {
      let energy = 0;
      for (let i = 0; i < input.length; i++) energy += input[i]! * input[i]!;
      onChunk(Math.sqrt(energy / input.length));
    }
  };
  source.connect(processor);
  processor.connect(ctx.destination);

  return {
    stop: async () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      const sampleRate = ctx.sampleRate;
      await ctx.close();
      let total = 0;
      for (const c of chunks) total += c.length;
      const samples = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        samples.set(c, off);
        off += c.length;
      }
      return { samples, sampleRate };
    },
  };
}
