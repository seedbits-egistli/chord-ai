/**
 * Stereo STFT / iSTFT matching Open-Unmix / torch.stft defaults used by UMX-HQ:
 * n_fft=4096, hop=1024, periodic Hann, centered (reflect pad n_fft/2).
 */

export const UMX_N_FFT = 4096;
export const UMX_HOP = 1024;
export const UMX_BINS = (UMX_N_FFT >> 1) + 1; // 2049

/** Periodic Hann: cos(2π i / N), not the symmetric (N-1) form. */
export function periodicHann(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / size));
  }
  return w;
}

function reflectPad(input: Float32Array, pad: number): Float32Array {
  const n = input.length;
  const out = new Float32Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    // reflect without repeating edge: input[1], input[2], ...
    const src = Math.min(n - 1, 1 + i);
    out[pad - 1 - i] = input[src]!;
  }
  out.set(input, pad);
  for (let i = 0; i < pad; i++) {
    const src = Math.max(0, n - 2 - i);
    out[pad + n + i] = input[src]!;
  }
  return out;
}

/** In-place Cooley–Tukey FFT on interleaved complex [re,im,...]. */
export function fftComplex(buf: Float32Array): void {
  const n = buf.length >>> 1;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const ri = i << 1;
      const rj = j << 1;
      const tr = buf[ri]!;
      const ti = buf[ri + 1]!;
      buf[ri] = buf[rj]!;
      buf[ri + 1] = buf[rj + 1]!;
      buf[rj] = tr;
      buf[rj + 1] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const u = (i + j) << 1;
        const v = (i + j + len / 2) << 1;
        const uRe = buf[u]!;
        const uIm = buf[u + 1]!;
        const vRe = buf[v]! * wRe - buf[v + 1]! * wIm;
        const vIm = buf[v]! * wIm + buf[v + 1]! * wRe;
        buf[u] = uRe + vRe;
        buf[u + 1] = uIm + vIm;
        buf[v] = uRe - vRe;
        buf[v + 1] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

/** Inverse FFT (interleaved complex). */
export function ifftComplex(buf: Float32Array): void {
  const n = buf.length >>> 1;
  for (let i = 0; i < n; i++) {
    buf[(i << 1) + 1]! *= -1;
  }
  fftComplex(buf);
  const inv = 1 / n;
  for (let i = 0; i < buf.length; i++) buf[i]! *= inv;
  for (let i = 0; i < n; i++) {
    buf[(i << 1) + 1]! *= -1;
  }
}

export interface ComplexSpectrogram {
  /** Interleaved complex frames: length = channels * bins * frames * 2, layout [ch][bin][frame] as re,im */
  re: Float32Array;
  im: Float32Array;
  /** Magnitude [ch][bin][frame] packed as ch-major: index ((ch * bins + bin) * frames + frame) */
  mag: Float32Array;
  channels: number;
  bins: number;
  frames: number;
  nFft: number;
  hop: number;
  /** Original (unpadded) length per channel */
  length: number;
}

function frameCount(paddedLen: number, nFft: number, hop: number): number {
  return Math.floor((paddedLen - nFft) / hop) + 1;
}

/**
 * Centered STFT for mono or stereo. `channels` is an array of equal-length channel buffers.
 */
export function stftChannels(
  channels: Float32Array[],
  options: { nFft?: number; hop?: number } = {},
): ComplexSpectrogram {
  const nFft = options.nFft ?? UMX_N_FFT;
  const hop = options.hop ?? UMX_HOP;
  const bins = (nFft >> 1) + 1;
  const chN = channels.length;
  const length = channels[0]!.length;
  const pad = nFft >> 1;
  const window = periodicHann(nFft);
  const padded = channels.map((c) => reflectPad(c, pad));
  const frames = frameCount(padded[0]!.length, nFft, hop);

  const re = new Float32Array(chN * bins * frames);
  const im = new Float32Array(chN * bins * frames);
  const mag = new Float32Array(chN * bins * frames);
  const buf = new Float32Array(nFft * 2);

  for (let ch = 0; ch < chN; ch++) {
    const sig = padded[ch]!;
    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      buf.fill(0);
      for (let i = 0; i < nFft; i++) {
        buf[i << 1] = sig[start + i]! * window[i]!;
      }
      fftComplex(buf);
      for (let b = 0; b < bins; b++) {
        const idx = (ch * bins + b) * frames + f;
        const r = buf[b << 1]!;
        const imv = buf[(b << 1) + 1]!;
        re[idx] = r;
        im[idx] = imv;
        mag[idx] = Math.hypot(r, imv);
      }
    }
  }

  return { re, im, mag, channels: chN, bins, frames, nFft, hop, length };
}

/** Pack magnitudes as float32 [1, channels, bins, frames] for UMX ONNX. */
export function packMagnitudeNchw(spec: ComplexSpectrogram): Float32Array {
  const { channels, bins, frames, mag } = spec;
  // Already stored as [ch][bin][frame] which matches NCHW with N=1.
  return mag;
}

export function magnitudeShape(spec: ComplexSpectrogram): number[] {
  return [1, spec.channels, spec.bins, spec.frames];
}

/**
 * Apply ratio mask to mixture complex STFT and invert.
 * `estimateMag` same layout as `spec.mag` (or NCHW flat [1,C,B,F]).
 */
export function istftMasked(
  spec: ComplexSpectrogram,
  estimateMag: Float32Array,
  options: { softMask?: boolean } = {},
): Float32Array[] {
  const { channels, bins, frames, nFft, hop, length, re, im, mag } = spec;
  const soft = options.softMask !== false;
  const outRe = new Float32Array(channels * bins * frames);
  const outIm = new Float32Array(channels * bins * frames);

  for (let i = 0; i < mag.length; i++) {
    const m = mag[i]!;
    let mask = m > 1e-8 ? estimateMag[i]! / m : 0;
    if (soft) mask = Math.min(1, Math.max(0, mask));
    outRe[i] = re[i]! * mask;
    outIm[i] = im[i]! * mask;
  }

  return istftChannels({ ...spec, re: outRe, im: outIm }, length);
}

/** Residual = mix * (1 - clip(est/mix)). */
export function istftResidual(
  spec: ComplexSpectrogram,
  estimateMag: Float32Array,
): Float32Array[] {
  const { channels, bins, frames, mag, re, im, length } = spec;
  const outRe = new Float32Array(channels * bins * frames);
  const outIm = new Float32Array(channels * bins * frames);
  for (let i = 0; i < mag.length; i++) {
    const m = mag[i]!;
    let mask = m > 1e-8 ? estimateMag[i]! / m : 0;
    mask = Math.min(1, Math.max(0, mask));
    const keep = 1 - mask;
    outRe[i] = re[i]! * keep;
    outIm[i] = im[i]! * keep;
  }
  return istftChannels({ ...spec, re: outRe, im: outIm }, length);
}

export function istftChannels(
  spec: Pick<ComplexSpectrogram, 're' | 'im' | 'channels' | 'bins' | 'frames' | 'nFft' | 'hop'>,
  outLength: number,
): Float32Array[] {
  const { channels, bins, frames, nFft, hop, re, im } = spec;
  const pad = nFft >> 1;
  const window = periodicHann(nFft);
  const paddedLen = (frames - 1) * hop + nFft;
  const outputs: Float32Array[] = [];
  const buf = new Float32Array(nFft * 2);
  const windowSq = new Float32Array(nFft);
  for (let i = 0; i < nFft; i++) windowSq[i] = window[i]! * window[i]!;

  for (let ch = 0; ch < channels; ch++) {
    const acc = new Float32Array(paddedLen);
    const norm = new Float32Array(paddedLen);
    for (let f = 0; f < frames; f++) {
      buf.fill(0);
      for (let b = 0; b < bins; b++) {
        const idx = (ch * bins + b) * frames + f;
        buf[b << 1] = re[idx]!;
        buf[(b << 1) + 1] = im[idx]!;
      }
      // Hermitian symmetry for negative freqs
      for (let b = 1; b < bins - 1; b++) {
        const conj = nFft - b;
        buf[conj << 1] = buf[b << 1]!;
        buf[(conj << 1) + 1] = -buf[(b << 1) + 1]!;
      }
      ifftComplex(buf);
      const start = f * hop;
      for (let i = 0; i < nFft; i++) {
        acc[start + i]! += buf[i << 1]! * window[i]!;
        norm[start + i]! += windowSq[i]!;
      }
    }
    const mono = new Float32Array(outLength);
    for (let i = 0; i < outLength; i++) {
      const pi = i + pad;
      const n = norm[pi]! || 1e-8;
      mono[i] = acc[pi]! / n;
    }
    outputs.push(mono);
  }
  return outputs;
}
