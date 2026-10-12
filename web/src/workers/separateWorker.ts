/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web';
import { DemucsProcessor, CONSTANTS } from 'demucs-web';
import {
  DEMUCS_MODEL_URL,
  DEMUCS_SAMPLE_RATE,
  resampleLinear,
  type SeparationStems,
} from '@chord-ai/engine';

export type SeparateRequest = {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  modelUrl?: string;
  preferWebGpu?: boolean;
};

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
    }
  | { id: number; ok: false; error: string }
  | { id: number; type: 'progress'; progress: number; detail: string };

let cachedSession: DemucsProcessor | null = null;
let cachedUrl: string | null = null;

async function getProcessor(
  modelUrl: string,
  preferWebGpu: boolean,
  id: number,
): Promise<DemucsProcessor> {
  if (cachedSession && cachedUrl === modelUrl) return cachedSession;

  const providers: string[] = preferWebGpu ? ['webgpu', 'wasm'] : ['wasm'];
  try {
    ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
  } catch {
    /* ignore */
  }

  const processor = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: providers,
      graphOptimizationLevel: 'basic',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
    onDownloadProgress: (loaded: number, total: number) => {
      const p = total ? loaded / total : 0;
      post({
        id,
        type: 'progress',
        progress: p * 0.35,
        detail: `下載模型 ${(loaded / 1e6).toFixed(1)}/${(total / 1e6).toFixed(1)} MB`,
      });
    },
    onProgress: ({ progress }: { progress: number }) => {
      post({
        id,
        type: 'progress',
        progress: 0.4 + progress * 0.55,
        detail: `分離音軌 ${(progress * 100).toFixed(0)}%`,
      });
    },
    onLog: (phase: string, msg: string) => {
      post({ id, type: 'progress', progress: 0.36, detail: `${phase}: ${msg}` });
    },
  });

  post({ id, type: 'progress', progress: 0.05, detail: '載入 HTDemucs ONNX…' });
  await processor.loadModel(modelUrl);
  cachedSession = processor;
  cachedUrl = modelUrl;
  return processor;
}

function post(msg: SeparateResponse) {
  (self as DedicatedWorkerGlobalScope).postMessage(msg);
}

self.onmessage = async (ev: MessageEvent<SeparateRequest>) => {
  const { id, samples, sampleRate, modelUrl, preferWebGpu } = ev.data;
  try {
    const url =
      modelUrl ||
      (typeof import.meta !== 'undefined' &&
        (import.meta as ImportMeta & { env?: { VITE_DEMUCS_MODEL_URL?: string } }).env
          ?.VITE_DEMUCS_MODEL_URL) ||
      DEMUCS_MODEL_URL;

    const processor = await getProcessor(url, preferWebGpu !== false, id);
    let left = samples;
    if (sampleRate !== DEMUCS_SAMPLE_RATE) {
      left = resampleLinear(samples, sampleRate, DEMUCS_SAMPLE_RATE);
    }
    const right = left;
    const result = await processor.separate(left, right);
    const stems: SeparationStems = {
      drums: result.drums,
      bass: result.bass,
      other: result.other,
      vocals: result.vocals,
      sampleRate: CONSTANTS.SAMPLE_RATE,
    };
    post({
      id,
      ok: true,
      stems: {
        drumsL: stems.drums.left,
        drumsR: stems.drums.right,
        bassL: stems.bass.left,
        bassR: stems.bass.right,
        otherL: stems.other.left,
        otherR: stems.other.right,
        vocalsL: stems.vocals.left,
        vocalsR: stems.vocals.right,
        sampleRate: stems.sampleRate,
      },
    });
  } catch (e) {
    post({
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
};
