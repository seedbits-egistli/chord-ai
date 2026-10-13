/** Node: full-song HT-Demucs separation with the same TS overlap-add as the browser. Writes <out>/<key>-acc22k.f32 / -voc16k.f32. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { separateHtdemucs } from '../src/v2/htdemucs.ts';
const OUT = process.env.OUT ?? '/workspace/bench/htd';
const MODEL = process.env.HTD ?? '/workspace/models-v2/htdemucs_fp16weights.onnx';
mkdirSync(OUT, { recursive: true });
const s = await ort.InferenceSession.create(MODEL, { intraOpNumThreads: Number(process.env.THREADS ?? 8), graphOptimizationLevel: 'disabled', enableCpuMemArena: false, enableMemPattern: false });
const run = async (f: Record<string, { data: Float32Array; dims: readonly number[] }>) => {
  const o = await s.run({ mix: new ort.Tensor('float32', f.mix!.data, f.mix!.dims as number[]) });
  return { stems: { data: o.stems!.data as Float32Array, dims: o.stems!.dims } };
};
const ff = (args: string[], input?: Buffer) => execFileSync('ffmpeg', ['-loglevel', 'error', ...args], { input, maxBuffer: 2 ** 31 });
for (const path of process.argv.slice(2)) {
  const key = path.split('/').pop()!.replace(/\.[^.]+$/, '');
  if (existsSync(`${OUT}/${key}-acc22k.f32`)) { console.log(key, 'cached'); continue; }
  const raw = ff(['-i', path, '-f', 'f32le', '-ac', '2', '-ar', '44100', '-']);
  const st = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = st.length / 2;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = st[2 * i]!; R[i] = st[2 * i + 1]!; }
  const t = Date.now();
  let peak = 0;
  const iv = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
  const { acc, vocals } = await separateHtdemucs(L, R, run);
  clearInterval(iv);
  const ms = Date.now() - t;
  const res = (x: Float32Array, sr: number) => ff(['-f', 'f32le', '-ar', '44100', '-ac', '1', '-i', '-', '-f', 'f32le', '-ar', String(sr), '-'], Buffer.from(x.buffer));
  writeFileSync(`${OUT}/${key}-acc22k.f32`, res(acc, 22050));
  writeFileSync(`${OUT}/${key}-voc16k.f32`, res(vocals, 16000));
  console.log(key, 'dur', (n / 44100).toFixed(0), 's sepMs', ms, 'RTF', (ms / 1000 / (n / 44100)).toFixed(2), 'peakRSS MB', (peak / 1e6) | 0);
}
