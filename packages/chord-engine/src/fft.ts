/** Compact radix-2 real FFT → magnitude spectrum (MIT). */

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

export function hannWindow(size: number): Float32Array {
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
  }
  return w;
}

/**
 * In-place Cooley–Tukey FFT on interleaved complex buffer [re0,im0,re1,im1,...]
 * length must be power of 2 * 2 (i.e. n complex samples).
 */
function fftComplex(buf: Float32Array): void {
  const n = buf.length >>> 1;
  // Bit reversal
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

/** Real FFT magnitudes for frame (zero-padded to pow2). Returns length/2 bins. */
export function rfftMagnitudes(frame: Float32Array, window?: Float32Array): Float32Array {
  const n = nextPow2(frame.length);
  const buf = new Float32Array(n * 2);
  for (let i = 0; i < frame.length; i++) {
    const w = window ? window[i]! : 1;
    buf[i << 1] = frame[i]! * w;
  }
  fftComplex(buf);
  const half = n >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    const re = buf[i << 1]!;
    const im = buf[(i << 1) + 1]!;
    mag[i] = Math.hypot(re, im);
  }
  return mag;
}
