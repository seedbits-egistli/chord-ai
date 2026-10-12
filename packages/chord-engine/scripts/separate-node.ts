/**
 * Node UMX-HQ separator for validation (onnxruntime-node).
 * Models cached under CHORD_AI_MODEL_DIR (default /tmp/chord-ai-models).
 */
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';
import {
  UMX_BASS_URL,
  UMX_VOCALS_URL,
  separateWithUmx,
} from '../src/umx.js';
import type { SeparationStems, SeparateProgress } from '../src/separate.js';

async function ensureModel(
  filename: string,
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const dir = process.env.CHORD_AI_MODEL_DIR || '/tmp/chord-ai-models';
  mkdirSync(dir, { recursive: true });
  const path = join(dir, filename);
  if (existsSync(path)) {
    return new Uint8Array(readFileSync(path));
  }
  console.log(`Downloading ${filename}…`, url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Model download failed (${filename}): ${res.status}`);
  const total = Number(res.headers.get('content-length') || 0);
  if (!res.body) {
    const ab = await res.arrayBuffer();
    const u8 = new Uint8Array(ab);
    writeFileSync(path, u8);
    return u8;
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
  return combined;
}

export async function separateMonoNode(
  samples: Float32Array,
  sampleRate: number,
  onProgress?: (p: SeparateProgress) => void,
): Promise<SeparationStems> {
  const wantBass = process.env.CHORD_AI_UMX_BASS !== '0';
  onProgress?.({ phase: 'download', progress: 0.02, detail: 'vocals.onnx' });
  const vocals = await ensureModel(
    'umx_hq_vocals.onnx',
    process.env.CHORD_AI_UMX_VOCALS_URL || UMX_VOCALS_URL,
    (loaded, total) => {
      onProgress?.({
        phase: 'download',
        progress: total ? (loaded / total) * 0.2 : 0.1,
        detail: `vocals ${(loaded / 1e6).toFixed(1)}MB`,
      });
    },
  );

  let bass: Uint8Array | null = null;
  if (wantBass) {
    onProgress?.({ phase: 'download', progress: 0.22, detail: 'bass.onnx' });
    bass = await ensureModel(
      'umx_hq_bass.onnx',
      process.env.CHORD_AI_UMX_BASS_URL || UMX_BASS_URL,
      (loaded, total) => {
        onProgress?.({
          phase: 'download',
          progress: 0.22 + (total ? (loaded / total) * 0.2 : 0.1),
          detail: `bass ${(loaded / 1e6).toFixed(1)}MB`,
        });
      },
    );
  }

  return separateWithUmx(samples, sampleRate, {
    ort: ort as unknown as import('../src/umx.js').OrtLike,
    vocalsModel: vocals,
    bassModel: bass,
    sessionOptions: {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'basic',
      enableCpuMemArena: false,
      enableMemPattern: false,
    },
    onProgress,
  });
}
