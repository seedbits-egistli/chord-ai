/**
 * Basic Pitch transcription helpers (Apache-2.0 model via @audio/neural-transcribe).
 * Node uses onnxruntime-node; browser workers pass a custom ORT session.
 */

import transcribe, { MODEL as BASIC_PITCH_MODEL_URL } from '@audio/neural-transcribe';
import type { NoteEvent } from './preciseDetect.js';

export { BASIC_PITCH_MODEL_URL };

export const BASIC_PITCH_MODEL_MB = 0.23;

export interface TranscribeNotesOptions {
  sampleRate: number;
  /** ONNX bytes or URL (default: Spotify icassp_2022 nmp.onnx). */
  model?: string | Uint8Array;
  /** 'node' | 'wasm' | 'webgpu' — ignored when `session` is set. */
  device?: string;
  /** Custom session factory (browser: wire onnxruntime-web/wasm + wasmPaths). */
  session?: (
    model: string | Uint8Array,
    opts: TranscribeNotesOptions,
  ) => Promise<{
    run: (
      feeds: Record<string, { data: Float32Array; dims: number[]; type: string }>,
    ) => Promise<Record<string, { data: Float32Array; dims: number[] }>>;
    inputs?: { name: string }[];
    free?: () => void;
  }>;
  onsetThreshold?: number;
  frameThreshold?: number;
  minDuration?: number;
  minFreq?: number;
  maxFreq?: number;
}

export async function transcribeNotes(
  samples: Float32Array,
  options: TranscribeNotesOptions,
): Promise<NoteEvent[]> {
  const notes = await transcribe(samples, {
    sampleRate: options.sampleRate,
    model: options.model ?? BASIC_PITCH_MODEL_URL,
    device: options.device,
    session: options.session as never,
    onsetThreshold: options.onsetThreshold ?? 0.45,
    frameThreshold: options.frameThreshold ?? 0.28,
    minDuration: options.minDuration ?? 0.09,
    minFreq: options.minFreq,
    maxFreq: options.maxFreq,
    batch: 4,
  });
  return notes.map((n) => ({
    time: n.time,
    duration: n.duration,
    midi: n.midi,
    velocity: n.velocity,
  }));
}
