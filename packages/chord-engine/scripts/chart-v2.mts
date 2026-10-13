/** Render a v2 chart (UG text + ChordPro) from bench-v2 predictions + aligner output. */
import { readFileSync } from 'node:fs';
import { buildLyricChart, renderUgText, renderChordPro, mapChordSpans } from '../src/v2/lyricChart.ts';
import { keyFromChords, respellForKey } from '../src/v2/pipeline.ts';
const [key, t0, t1, alignFile] = process.argv.slice(2);
const pred = JSON.parse(readFileSync(`/workspace/proto-v2/out/${process.env.PRED ?? 'ts-v2'}/${key}.json`, 'utf8'));
const al = JSON.parse(readFileSync(alignFile ?? `/workspace/proto-v2/out/${key}-align-ts.json`, 'utf8'));
const k = keyFromChords(pred.chords);
const chords = mapChordSpans(respellForKey(pred.chords, k), (c) => c);
const words = al.words.filter((w: any) => w.start >= +t0! && w.start < +t1!);
const lines = al.lines.map((l: any) => ({ text: l.text, section: l.section }));
const rows = buildLyricChart(lines, words, chords, { beatSec: 60 / pred.bpm });
console.log(`key ${k}, ${pred.bpm.toFixed(1)} BPM\n== UG\n` + renderUgText(rows) + '\n== ChordPro\n' + renderChordPro(rows));
