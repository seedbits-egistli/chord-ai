import type { DetectionResult, DetectOptions } from '@chord-ai/engine';
import type { WorkerRequest, WorkerResponse } from '../workers/chordWorker';

let worker: Worker | null = null;
let seq = 1;

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL('../workers/chordWorker.ts', import.meta.url), {
      type: 'module',
    });
  }
  return worker;
}

export async function decodeFile(file: File): Promise<{ samples: Float32Array; sampleRate: number }> {
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
  const w = getWorker();
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
