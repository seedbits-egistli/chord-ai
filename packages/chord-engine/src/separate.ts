/**
 * Source-separation helpers for chord detection.
 *
 * Model integration (Demucs HTDemucs ONNX via demucs-web) lives in the
 * browser Worker / Node validation harness. This module only mixes stems
 * and feeds them into the detector.
 */

import { detectChords } from './detect.js';
import type { DetectOptions, DetectionResult } from './types.js';

export interface StemChannels {
  left: Float32Array;
  right: Float32Array;
}

export interface SeparationStems {
  drums: StemChannels;
  bass: StemChannels;
  other: StemChannels;
  vocals: StemChannels;
  sampleRate: number;
}

export interface SeparateProgress {
  phase: 'download' | 'load' | 'infer' | 'done';
  /** 0–1 overall-ish progress */
  progress: number;
  detail?: string;
}

/** Default public model URL (lazy-loaded, not committed). */
export const DEMUCS_MODEL_URL =
  'https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx';

export const DEMUCS_SAMPLE_RATE = 44100;

export function stereoToMono(left: Float32Array, right?: Float32Array): Float32Array {
  if (!right || right === left) return left;
  const n = Math.min(left.length, right.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (left[i]! + right[i]!) * 0.5;
  return out;
}

/**
 * Harmonic instrumental for chroma: bass + other (no vocals, no drums).
 * Optionally blend a little drums (0–1) if the mix feels too thin.
 */
export function buildInstrumental(
  stems: SeparationStems,
  options: { drumBlend?: number } = {},
): Float32Array {
  const drumBlend = options.drumBlend ?? 0.15;
  const bass = stereoToMono(stems.bass.left, stems.bass.right);
  const other = stereoToMono(stems.other.left, stems.other.right);
  const drums = stereoToMono(stems.drums.left, stems.drums.right);
  const n = Math.min(bass.length, other.length, drums.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = bass[i]! + other[i]! + drums[i]! * drumBlend;
  }
  // Soft normalize
  let peak = 1e-6;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(out[i]!));
  const g = Math.min(1, 0.95 / peak);
  for (let i = 0; i < n; i++) out[i]! *= g;
  return out;
}

export function buildBassMono(stems: SeparationStems): Float32Array {
  return stereoToMono(stems.bass.left, stems.bass.right);
}

/** Linear resample (adequate for analysis, not mastering). */
export function resampleLinear(
  input: Float32Array,
  fromRate: number,
  toRate: number,
): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLen = Math.max(1, Math.floor(input.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i / ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = input[i0]! * (1 - frac) + input[i1]! * frac;
  }
  return out;
}

/**
 * Detect chords from Demucs stems: chroma on instrumental, bass chroma from bass stem.
 */
export function detectChordsFromStems(
  stems: SeparationStems,
  options: DetectOptions = {},
): DetectionResult {
  const instrumental = buildInstrumental(stems);
  const bass = buildBassMono(stems);
  return detectChords(instrumental, stems.sampleRate, {
    ...options,
    bassSamples: bass,
    // After vocal/drum removal, less drone suppression needed
    suppressDrone: options.suppressDrone ?? false,
  });
}
