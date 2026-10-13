import type { OnnxRun, Progress } from './types';

/** HT-Demucs (MIT, facebookresearch/demucs; ONNX export StemSplitio/htdemucs-onnx, MIT). Fixed 7.8 s segments @ 44.1 kHz. */
export const HTDEMUCS_SR = 44100;
export const HTDEMUCS_SEG = 343980;

export interface HtdemucsStems {
  /** (bass + other) mono, 44.1 kHz — what the chord model listens to */
  acc: Float32Array;
  /** vocals mono, 44.1 kHz — for lyric alignment */
  vocals: Float32Array;
}

/**
 * Overlap-add chunked separation (25 % overlap, linear cross-fade), same as StemSplit's infer.py.
 * Peak memory is one segment's input/output (~11 MB) plus the two mono outputs, so a full song stays small;
 * the ONNX session itself must be created with graph optimisation disabled (constant folding blows RSS up to GBs).
 */
export async function separateHtdemucs(
  left: Float32Array,
  right: Float32Array,
  run: OnnxRun,
  onProgress?: Progress,
  signal?: { aborted: boolean },
): Promise<HtdemucsStems> {
  const N = HTDEMUCS_SEG;
  const total = left.length;
  const overlap = N >> 2;
  const stride = N - overlap;
  const nChunks = Math.max(1, Math.ceil(total / stride));
  const win = new Float32Array(N).fill(1);
  for (let i = 0; i < overlap; i++) {
    const f = (i + 1) / (overlap + 1);
    win[i] = f;
    win[N - 1 - i] = f;
  }
  const acc = new Float32Array(total);
  const voc = new Float32Array(total);
  const wsum = new Float32Array(total);
  const x = new Float32Array(2 * N);
  for (let c = 0; c < nChunks; c++) {
    if (signal?.aborted) throw new Error('aborted');
    const start = c * stride;
    const end = Math.min(start + N, total);
    const len = end - start;
    x.fill(0);
    x.set(left.subarray(start, end), 0);
    x.set(right.subarray(start, end), N);
    const out = (await run({ mix: { data: x, dims: [1, 2, N] } })).stems!.data;
    // stems [1,4,2,N]: drums, bass, other, vocals
    const B = 1 * 2 * N, O = 2 * 2 * N, V = 3 * 2 * N;
    for (let i = 0; i < len; i++) {
      const w = win[i]!;
      const j = start + i;
      acc[j] += w * 0.5 * (out[B + i]! + out[B + N + i]! + out[O + i]! + out[O + N + i]!);
      voc[j] += w * 0.5 * (out[V + i]! + out[V + N + i]!);
      wsum[j] += w;
    }
    onProgress?.((c + 1) / nChunks);
  }
  for (let j = 0; j < total; j++) {
    const w = Math.max(wsum[j]!, 1e-8);
    acc[j] /= w;
    voc[j] /= w;
  }
  return { acc, vocals: voc };
}
