/**
 * Open-Unmix UMX-HQ ONNX host (STFT outside the graph).
 * Vocals (~17 MiB) + bass (~17 MiB) ≈ 34 MiB — under the 40 MiB frontend budget.
 */

import {
  istftMasked,
  istftResidual,
  magnitudeShape,
  packMagnitudeNchw,
  stftChannels,
  UMX_HOP,
  UMX_N_FFT,
} from './stft.js';
import type { SeparationStems, SeparateProgress } from './separate.js';
import { resampleLinear } from './separate.js';

/** Pinned MIT UMX-HQ vocals export (spectrogram net only). */
export const UMX_VOCALS_URL =
  'https://huggingface.co/edgetools/umx-hq/resolve/main/vocals.onnx';

/**
 * Bass stem from the same UMX-HQ export set (commit that still published all four stems).
 * ~17 MiB — kept so total advanced-mode download stays ≤40 MiB with vocals.
 */
export const UMX_BASS_URL =
  'https://huggingface.co/edgetools/umx-hq/resolve/2cc0d6a71963504e3ef32156ea900dd54a1a9502/bass.onnx';

export const UMX_SAMPLE_RATE = 44100;

/** Approx download size when both stems are used. */
export const UMX_TOTAL_MB = 34;

export type OrtLike = {
  Tensor: new (
    type: 'float32',
    data: Float32Array,
    dims: number[],
  ) => { data: Float32Array; dims: number[] };
  InferenceSession: {
    create: (
      model: string | ArrayBuffer | Uint8Array,
      options?: Record<string, unknown>,
    ) => Promise<OrtSession>;
  };
};

export type OrtSession = {
  inputNames: string[];
  outputNames: string[];
  run: (
    feeds: Record<string, unknown>,
  ) => Promise<Record<string, { data: Float32Array }>>;
};

export interface UmxSeparateOptions {
  ort: OrtLike;
  /** Required unless `vocalsSession` is provided. */
  vocalsModel?: string | ArrayBuffer | Uint8Array;
  bassModel?: string | ArrayBuffer | Uint8Array | null;
  /** Reuse a warm InferenceSession (avoids re-parse on every analysis). */
  vocalsSession?: OrtSession;
  bassSession?: OrtSession | null;
  sessionOptions?: Record<string, unknown>;
  onProgress?: (p: SeparateProgress) => void;
}

function zerosLike(n: number): { left: Float32Array; right: Float32Array } {
  return { left: new Float32Array(n), right: new Float32Array(n) };
}

async function runStem(
  session: OrtSession,
  ort: OrtLike,
  mag: Float32Array,
  shape: number[],
): Promise<Float32Array> {
  const inputName = session.inputNames[0] ?? 'mag';
  const outputName = session.outputNames[0] ?? 'estimate';
  const tensor = new ort.Tensor('float32', mag, shape);
  const out = await session.run({ [inputName]: tensor });
  const t = out[outputName];
  if (!t) throw new Error(`UMX missing output ${outputName}`);
  return t.data instanceof Float32Array ? t.data : new Float32Array(t.data);
}

/**
 * Separate mono (or already-mixed) audio with UMX-HQ vocals (+ optional bass).
 * Returns Demucs-compatible stem layout; drums are empty; other ≈ residual.
 */
export async function separateWithUmx(
  samples: Float32Array,
  sampleRate: number,
  options: UmxSeparateOptions,
): Promise<SeparationStems> {
  const { ort, onProgress } = options;
  onProgress?.({ phase: 'load', progress: 0.05, detail: 'UMX-HQ session' });

  let mono = samples;
  if (sampleRate !== UMX_SAMPLE_RATE) {
    mono = resampleLinear(samples, sampleRate, UMX_SAMPLE_RATE);
  }
  // Duplicate mono → stereo (UMX expects 2ch)
  const left = mono;
  const right = mono;

  onProgress?.({ phase: 'infer', progress: 0.15, detail: 'STFT' });
  const spec = stftChannels([left, right], { nFft: UMX_N_FFT, hop: UMX_HOP });
  const mag = packMagnitudeNchw(spec);
  const shape = magnitudeShape(spec);

  const sessionOpts = {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'basic',
    ...options.sessionOptions,
  };

  onProgress?.({ phase: 'infer', progress: 0.25, detail: 'vocals ONNX' });
  let vocalsSession = options.vocalsSession;
  if (!vocalsSession) {
    if (options.vocalsModel == null) throw new Error('UMX vocalsModel or vocalsSession required');
    vocalsSession = await ort.InferenceSession.create(options.vocalsModel, sessionOpts);
  }
  const vocalsMag = await runStem(vocalsSession, ort, mag, shape);

  let bassL: Float32Array;
  let bassR: Float32Array;
  const wantBass = options.bassSession != null || options.bassModel != null;
  if (wantBass) {
    onProgress?.({ phase: 'infer', progress: 0.55, detail: 'bass ONNX' });
    let bassSession = options.bassSession ?? null;
    if (!bassSession) {
      bassSession = await ort.InferenceSession.create(options.bassModel!, sessionOpts);
    }
    const bassMag = await runStem(bassSession, ort, mag, shape);
    const bassCh = istftMasked(spec, bassMag);
    bassL = bassCh[0]!;
    bassR = bassCh[1]!;
  } else {
    // Soft low-shelf proxy from residual when bass model omitted
    const residual = istftResidual(spec, vocalsMag);
    bassL = lowpassMono(residual[0]!, UMX_SAMPLE_RATE, 250);
    bassR = lowpassMono(residual[1]!, UMX_SAMPLE_RATE, 250);
  }

  onProgress?.({ phase: 'infer', progress: 0.8, detail: 'iSTFT' });
  const vocalsCh = istftMasked(spec, vocalsMag);
  const otherCh = istftResidual(spec, vocalsMag);
  // Remove bass energy from "other" when we have a real bass stem (approx)
  const n = left.length;
  if (wantBass) {
    for (let i = 0; i < n; i++) {
      otherCh[0]![i] = otherCh[0]![i]! - bassL[i]! * 0.35;
      otherCh[1]![i] = otherCh[1]![i]! - bassR[i]! * 0.35;
    }
  }

  const empty = zerosLike(n);
  onProgress?.({ phase: 'done', progress: 1 });

  return {
    drums: empty,
    bass: { left: bassL, right: bassR },
    other: { left: otherCh[0]!, right: otherCh[1]! },
    vocals: { left: vocalsCh[0]!, right: vocalsCh[1]! },
    sampleRate: UMX_SAMPLE_RATE,
  };
}

/** One-pole lowpass for bass proxy. */
function lowpassMono(input: Float32Array, sampleRate: number, cutoffHz: number): Float32Array {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const a = dt / (rc + dt);
  const out = new Float32Array(input.length);
  let y = 0;
  for (let i = 0; i < input.length; i++) {
    y = y + a * (input[i]! - y);
    out[i] = y;
  }
  return out;
}
