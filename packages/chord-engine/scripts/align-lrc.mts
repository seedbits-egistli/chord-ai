/** Alignment speed/accuracy vs LRC line starts. VAD=0 disables vocal-activity skipping. */
import { readFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { alignLyrics } from '../src/v2/ctcAlign.ts';
const M = process.env.MODELS ?? '/workspace/models-v2';
const [key, vocPath] = process.argv.slice(2) as [string, string];
const s = await ort.InferenceSession.create(`${M}/wav2vec2-base-960h-int8.onnx`, { intraOpNumThreads: 4 });
const run = async (f: Record<string, { data: Float32Array; dims: readonly number[] }>) => {
  const o = await s.run({ wav: new ort.Tensor('float32', f.wav!.data, f.wav!.dims as number[]) });
  return { logp: { data: o.logp!.data as Float32Array, dims: o.logp!.dims } };
};
const labels = JSON.parse(readFileSync(`${M}/wav2vec2-labels.json`, 'utf8'));
const b = readFileSync(vocPath);
const voc = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const txt = readFileSync(`/workspace/proto-v2/lyrics/${key}.txt`, 'utf8');
const lrc = readFileSync(`/workspace/proto-v2/lyrics/${key}.lrc`, 'utf8').split('\n')
  .map((l) => /^\[(\d+):(\d+\.\d+)\]\s*(.*)$/.exec(l)).filter((m) => m && m[3]!.trim()).map((m) => +m![1]! * 60 + +m![2]!);
const t = Date.now();
const r = await alignLyrics(voc, txt, run, labels, undefined, { vad: process.env.VAD !== '0' });
const ms = Date.now() - t;
const firstOfLine = new Map<number, number>();
for (const w of r.words) if (!firstOfLine.has(w.line) && w.start >= 0) firstOfLine.set(w.line, w.start);
const starts = [...firstOfLine.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
const n = Math.min(starts.length, lrc.length);
const d = Array.from({ length: n }, (_, i) => Math.abs(starts[i]! - lrc[i]!)).sort((a, b) => a - b);
console.log(key, 'VAD', process.env.VAD !== '0', 'ms', ms, 'lines', starts.length, '/', lrc.length, 'median', d[n >> 1]?.toFixed(2), 'within1s', ((d.filter((x) => x < 1).length / n) * 100).toFixed(0) + '%');
