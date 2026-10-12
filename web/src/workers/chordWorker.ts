/// <reference lib="webworker" />
import { detectChords, type DetectOptions, type DetectionResult } from '@chord-ai/engine';

export type WorkerRequest = {
  id: number;
  samples: Float32Array;
  sampleRate: number;
  options?: DetectOptions;
};

export type WorkerResponse =
  | { id: number; ok: true; result: DetectionResult }
  | { id: number; ok: false; error: string };

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { id, samples, sampleRate, options } = ev.data;
  try {
    const result = detectChords(samples, sampleRate, options);
    const res: WorkerResponse = { id, ok: true, result };
    (self as DedicatedWorkerGlobalScope).postMessage(res);
  } catch (e) {
    const res: WorkerResponse = {
      id,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    (self as DedicatedWorkerGlobalScope).postMessage(res);
  }
};
