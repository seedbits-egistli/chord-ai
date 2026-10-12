/**
 * Node HTDemucs separator for validation (onnxruntime-node).
 * Model cached under CHORD_AI_MODEL_DIR (default /tmp/chord-ai-models).
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import { DemucsProcessor, CONSTANTS } from 'demucs-web';
import {
  DEMUCS_MODEL_URL,
  DEMUCS_SAMPLE_RATE,
  resampleLinear,
  type SeparationStems,
  type SeparateProgress,
} from '../src/separate.js';

export async function ensureDemucsModel(
  onProgress?: (loaded: number, total: number) => void,
): Promise<ArrayBuffer> {
  const dir = process.env.CHORD_AI_MODEL_DIR || '/tmp/chord-ai-models';
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'htdemucs_embedded.onnx');
  if (existsSync(path)) {
    const buf = readFileSync(path);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  }
  const url = process.env.CHORD_AI_DEMUCS_URL || DEMUCS_MODEL_URL;
  console.log('Downloading Demucs ONNX (~172MB)…', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed: ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body) {
    const ab = await res.arrayBuffer();
    writeFileSync(path, Buffer.from(ab));
    return ab;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total || loaded);
  }
  const combined = new Uint8Array(loaded);
  let off = 0;
  for (const c of chunks) {
    combined.set(c, off);
    off += c.length;
  }
  writeFileSync(path, combined);
  console.log('Saved model to', path);
  return combined.buffer;
}

export async function separateMonoNode(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (p: SeparateProgress) => void,
): Promise<SeparationStems> {
  onProgress?.({ phase: 'download', progress: 0.02, detail: 'model' });
  const model = await ensureDemucsModel((loaded, total) => {
    onProgress?.({
      phase: 'download',
      progress: total ? (loaded / total) * 0.3 : 0.15,
      detail: `${(loaded / 1e6).toFixed(1)}MB`,
    });
  });

  onProgress?.({ phase: 'load', progress: 0.32, detail: 'onnx session' });
  const processor = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'basic',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
    onProgress: ({ progress }) => {
      onProgress?.({
        phase: 'infer',
        progress: 0.35 + progress * 0.6,
        detail: 'segments',
      });
    },
    onLog: (phase, msg) => console.log(`[demucs:${phase}] ${msg}`),
  });
  await processor.loadModel(model);

  // Resample to 44.1 kHz stereo (duplicate mono)
  let left = samples;
  if (sampleRate !== DEMUCS_SAMPLE_RATE) {
    left = resampleLinear(samples, sampleRate, DEMUCS_SAMPLE_RATE);
  }
  const right = left;

  onProgress?.({ phase: 'infer', progress: 0.4, detail: 'separate' });
  const result = await processor.separate(left, right);
  onProgress?.({ phase: 'done', progress: 1 });

  return {
    drums: result.drums,
    bass: result.bass,
    other: result.other,
    vocals: result.vocals,
    sampleRate: CONSTANTS.SAMPLE_RATE,
  };
}
