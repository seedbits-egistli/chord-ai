import {
  detectChordsFromStems,
  type DetectionResult,
  type DetectOptions,
  type SeparationStems,
} from '@chord-ai/engine';
import type { WorkerRequest, WorkerResponse } from '../workers/chordWorker';
import type { SeparateRequest, SeparateResponse } from '../workers/separateWorker';

let chordWorker: Worker | null = null;
let separateWorker: Worker | null = null;
let seq = 1;

function getChordWorker() {
  if (!chordWorker) {
    chordWorker = new Worker(new URL('../workers/chordWorker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return chordWorker;
}

function getSeparateWorker() {
  if (!separateWorker) {
    separateWorker = new Worker(new URL('../workers/separateWorker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return separateWorker;
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
  const id = seq++;
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

export function separateInWorker(
  samples: Float32Array,
  sampleRate: number,
  options: {
    preferWebGpu?: boolean;
    modelUrl?: string;
    onProgress?: (progress: number, detail: string) => void;
  } = {},
): Promise<SeparationStems> {
  const w = getSeparateWorker();
  const id = seq++;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent<SeparateResponse>) => {
      const data = ev.data;
      if (data.id !== id) return;
      if ('type' in data && data.type === 'progress') {
        options.onProgress?.(data.progress, data.detail);
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
      });
    };
    w.addEventListener('message', onMsg);
    const msg: SeparateRequest = {
      id,
      samples,
      sampleRate,
      preferWebGpu: options.preferWebGpu,
      modelUrl: options.modelUrl,
    };
    w.postMessage(msg);
  });
}

/** Separate (optional) then detect — all in workers / local. */
export async function analyzeAudio(
  samples: Float32Array,
  sampleRate: number,
  options: {
    separate: boolean;
    preferWebGpu?: boolean;
    detect?: DetectOptions;
    onProgress?: (progress: number, detail: string) => void;
  },
): Promise<DetectionResult & { usedSeparation: boolean }> {
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
    options.onProgress?.(0.95, '以人聲／鼓分離後的伴奏辨識和弦…');
    // Run stem detection on main thread via engine (fast vs Demucs); could also post to chord worker
    const result = detectChordsFromStems(stems, options.detect);
    options.onProgress?.(1, '完成（已啟用 HTDemucs 分離）');
    return { ...result, usedSeparation: true };
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
