/** Node check of the in-browser lyric aligner vs the Python prototype (same vocal stem). */
import { readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { loadAudioFile } from '../src/loadAudio.ts';
import { alignLyrics } from '../src/v2/ctcAlign.ts';
const M = process.env.MODELS ?? '/workspace/models-v2';
const key = process.argv[2]!;
const vocPath = process.argv[3] ?? `/workspace/proto-v2/out/${key}-vocals.wav`;
const s = await ort.InferenceSession.create(`${M}/wav2vec2-base-960h-int8.onnx`, { executionProviders: ['cpu'] });
const run = async (feeds: Record<string, { data: Float32Array; dims: readonly number[] }>) => {
  const o = await s.run({ wav: new ort.Tensor('float32', feeds.wav!.data, feeds.wav!.dims as number[]) });
  return { logp: { data: o.logp!.data as Float32Array, dims: o.logp!.dims } };
};
const labels = JSON.parse(readFileSync(`${M}/wav2vec2-labels.json`, 'utf8'));
const voc = vocPath.endsWith('.f32') ? (() => { const b = readFileSync(vocPath); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); })() : loadAudioFile(vocPath, 16000).samples;
const t = Date.now();
const r = await alignLyrics(voc, readFileSync(`/workspace/proto-v2/lyrics/${key}.txt`, 'utf8'), run, labels);
const ms = Date.now() - t;
writeFileSync(process.env.ALIGN_OUT ?? `/workspace/proto-v2/out/${key}-align-ts.json`, JSON.stringify(r));
const py = JSON.parse(readFileSync(`/workspace/proto-v2/out/${key}-align.json`, 'utf8')).words;
const d = r.words.map((w, i) => Math.abs(w.start - py[i].t)).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
console.log(key, 'ms', ms, 'words', r.words.length, 'vs python median |Δ|', d[d.length >> 1]?.toFixed(3), 'p90', d[Math.floor(d.length * 0.9)]?.toFixed(3));
console.log(r.words.slice(0, 8).map((w) => `${w.word}@${w.start}`).join(' '));
