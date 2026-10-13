/** Node validation of the in-browser v2 pipeline (same TS code, onnxruntime-node). Writes predictions for score-v2.mts. */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { loadAudioFile } from '../src/loadAudio.ts';
import { trackBeatsBeatThis } from '../src/v2/beatThis.ts';
import { detectChordsBtc, btcNames, type BtcModel } from '../src/v2/btc.ts';
import type { OnnxRun } from '../src/v2/types.ts';
const M = process.env.MODELS ?? '/workspace/models-v2';
const OUT = process.env.OUT ?? '/workspace/proto-v2/out/ts-v2';
mkdirSync(OUT, { recursive: true });
async function sess(f: string): Promise<OnnxRun> {
  const s = await ort.InferenceSession.create(`${M}/${f}`, { executionProviders: ['cpu'] });
  return async (feeds) => {
    const f2: Record<string, ort.Tensor> = {};
    for (const [k, v] of Object.entries(feeds)) f2[k] = new ort.Tensor('float32', v.data, v.dims as number[]);
    const o = await s.run(f2);
    const r: Record<string, { data: Float32Array; dims: number[] }> = {};
    for (const [k, v] of Object.entries(o)) r[k] = { data: v.data as Float32Array, dims: v.dims as number[] };
    return r;
  };
}
const models = {
  majmin: { run: await sess('btc-majmin.onnx'), mean: -2.2279364109039306, std: 0, names: btcNames(false) } as BtcModel,
  large: { run: await sess('btc-large.onnx'), mean: 0, std: 0, names: btcNames(true) } as BtcModel,
};
const stats = JSON.parse(readFileSync('/workspace/proto-v2/onnx/btc-majmin.json', 'utf8'));
const statsL = JSON.parse(readFileSync('/workspace/proto-v2/onnx/btc-large.json', 'utf8'));
models.majmin.mean = stats.mean; models.majmin.std = stats.std; models.large.mean = statsL.mean; models.large.std = statsL.std;
const beatRun = await sess('beat-this-small.onnx');
const songs: Record<string, string> = { hey_jude: '/tmp/chord-ai-test-audio/hey_jude.mp3' };
for (const k of ['knockin', 'let_it_be', 'riptide', 'someone_like_you', 'stand_by_me', 'wonderwall-v2']) songs[k] = `/workspace/bench-audio/${k}.mp3`;
const only = process.argv[2]?.split(',');
for (const [key, path] of Object.entries(songs)) {
  if (only && !only.includes(key)) continue;
  const mix = loadAudioFile(path, 22050).samples;
  let t = Date.now();
  const { beats, downbeats } = await trackBeatsBeatThis(mix, beatRun);
  const tBeats = Date.now() - t;
  // UMX-HQ stems (same as the browser's precise mode) cached by bench2.mts, first 60 s @ 44.1 kHz
  const meta = JSON.parse(readFileSync(`/workspace/bench/cache/${key}.json`, 'utf8'));
  const buf = readFileSync(`/workspace/bench/cache/${key}.bin`);
  const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = meta.n;
  const src = process.env.SRC ?? 'umx';
  let acc: Float32Array;
  if (src === 'umx') {
    acc = new Float32Array(Math.floor(n / 2));
    for (let i = 0; i < acc.length; i++) {
      let s = 0;
      for (const j of [2 * i, 2 * i + 1]) s += all[2 * n + j]! + all[3 * n + j]! + all[4 * n + j]! + all[5 * n + j]!;
      acc[i] = s / 4;
    }
  } else if (src === 'mix') {
    acc = mix;
  } else {
    const w = readFileSync(`/workspace/proto-v2/out/${key}-umxacc22k.f32`);
    acc = new Float32Array(w.buffer, w.byteOffset, w.byteLength / 4);
  }
  t = Date.now();
  const r = await detectChordsBtc(acc, beats, downbeats, models);
  const tCh = Date.now() - t;
  writeFileSync(`${OUT}/${key}.json`, JSON.stringify({ bpm: r.bpm, key: '', chords: r.chords }));
  writeFileSync(`${OUT}/${key}-beats.json`, JSON.stringify({ beats, downbeats }));
  console.log(key, r.model, 'ext', r.extendedShare.toFixed(2), 'conf', r.confidence.majmin.toFixed(3), r.confidence.large.toFixed(3), 'bpm', r.bpm.toFixed(1), 'beatsMs', tBeats, 'chordsMs(60s)', tCh, 'mixDur', (mix.length / 22050).toFixed(0));
}
