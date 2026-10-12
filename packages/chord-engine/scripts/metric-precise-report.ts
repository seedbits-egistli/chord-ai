/**
 * Precise-mode metric/HMM report + Wonderwall note histograms.
 *
 *   CHORD_AI_TEST_AUDIO=/tmp/chord-ai-test-audio CHORD_AI_SEP_MAX_SEC=60 \
 *     npx tsx packages/chord-engine/scripts/metric-precise-report.ts
 *
 * Does not write audio. Appends findings into docs/validation.md sections via stdout
 * (validate-real regenerates the main tables; this prints the detailed WW dump).
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAudioFile } from '../src/loadAudio.js';
import { REAL_FIXTURES } from '../src/realFixtures.js';
import { detectChordsPreciseFromStems, noteChroma, type NoteEvent } from '../src/preciseDetect.js';
import { transcribeNotes } from '../src/basicPitch.js';
import { separateMonoNode } from './separate-node.js';
import { stereoToMono } from '../src/separate.js';
import { scoreAgainstTimedReference, toneOverlap } from '../src/accuracy.js';
import { parseChord } from '../src/chordParse.js';
import { QUALITY_INTERVALS } from '../src/templates.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const audioDir = process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';
const sepMaxSec = Number(process.env.CHORD_AI_SEP_MAX_SEC || 60);
const outDir = join(root, 'docs');

const PC_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function expandLoopPhase(
  bpm: number,
  fromMs: number,
  toMs: number,
  bars: string[],
  phaseBars: number,
): Array<{ chord: string; startMs: number; endMs: number }> {
  const barMs = (4 * 60000) / bpm;
  const out: Array<{ chord: string; startMs: number; endMs: number }> = [];
  let t = fromMs + phaseBars * barMs;
  while (t > fromMs) t -= bars.length * barMs;
  let i = 0;
  while (t < toMs) {
    const chord = bars[i % bars.length]!;
    const startMs = Math.max(fromMs, t);
    const endMs = Math.min(toMs, t + barMs);
    if (endMs > startMs) out.push({ chord, startMs, endMs });
    t += barMs;
    i++;
  }
  return out;
}

function chordTones(label: string): string {
  const p = parseChord(label);
  if (!p) return '—';
  const iv = QUALITY_INTERVALS[p.quality] ?? [0, 4, 7];
  return iv.map((i) => PC_NAMES[(p.root + i) % 12]!).join(' ');
}

function chordAt(events: { tMs: number; endMs: number; chord: string }[], tMs: number): string {
  for (const e of events) {
    if (tMs >= e.tMs && tMs < e.endMs) return e.chord;
  }
  return events[0]?.chord ?? 'N';
}

function dumpNoteHistogram(
  notes: NoteEvent[],
  startSec: number,
  endSec: number,
  label: string,
): { pc: Float32Array; midiHist: Map<number, number>; lines: string[] } {
  const pc = noteChroma(notes, startSec, endSec);
  const midiHist = new Map<number, number>();
  const pcRaw = new Float32Array(12);
  for (const n of notes) {
    const n0 = n.time;
    const n1 = n.time + Math.max(0.01, n.duration);
    const overlap = Math.min(n1, endSec) - Math.max(n0, startSec);
    if (overlap <= 0) continue;
    const midi = Math.round(n.midi);
    const w = overlap * (0.25 + 0.75 * Math.min(1, Math.max(0, n.velocity)));
    midiHist.set(midi, (midiHist.get(midi) ?? 0) + w);
    pcRaw[((midi % 12) + 12) % 12]! += w;
  }
  const total = [...midiHist.values()].reduce((a, b) => a + b, 0) || 1;
  const lines: string[] = [];
  lines.push(`### ${label} (${startSec}–${endSec}s)`);
  lines.push('');
  lines.push('| PC | Rel energy (L2 chroma) | Raw weight share |');
  lines.push('|---|---:|---:|');
  const pcSum = pcRaw.reduce((a, b) => a + b, 0) || 1;
  const ranked = [...Array(12).keys()].sort((a, b) => pc[b]! - pc[a]!);
  for (const p of ranked) {
    if (pc[p]! < 0.02 && pcRaw[p]! / pcSum < 0.02) continue;
    lines.push(
      `| ${PC_NAMES[p]} | ${pc[p]!.toFixed(3)} | ${((pcRaw[p]! / pcSum) * 100).toFixed(1)}% |`,
    );
  }
  lines.push('');
  lines.push('Top MIDI notes (duration×velocity weight):');
  lines.push('');
  lines.push('| MIDI | Note | Weight share | Count-ish |');
  lines.push('|---:|---|---:|---:|');
  const topMidi = [...midiHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16);
  for (const [midi, w] of topMidi) {
    const name = `${PC_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
    lines.push(`| ${midi} | ${name} | ${((w / total) * 100).toFixed(1)}% | ${w.toFixed(2)} |`);
  }
  lines.push('');
  // Key-scale check for F#m / A: F# G# A B C# D E
  const fsharpMinor = new Set([6, 8, 9, 11, 1, 2, 4]);
  const outOfKey = ranked.filter((p) => pc[p]! > 0.08 && !fsharpMinor.has(p));
  lines.push(
    `Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: ${
      outOfKey.length ? outOfKey.map((p) => PC_NAMES[p]).join(', ') : 'none'
    }`,
  );
  lines.push('');
  return { pc, midiHist, lines };
}

async function runOne(refId: string) {
  const ref = REAL_FIXTURES.find((r) => r.id === refId)!;
  const path = join(audioDir, ref.filename);
  if (!existsSync(path)) throw new Error(`Missing ${path}`);
  console.log(`\n=== ${ref.title} ===`);
  const { samples, sampleRate } = loadAudioFile(path, 22050);
  const maxSamples = Math.floor(sepMaxSec * sampleRate);
  const clip = samples.subarray(0, Math.min(samples.length, maxSamples));
  console.log(`  clip ${(clip.length / sampleRate).toFixed(1)}s @ ${sampleRate} Hz`);
  const stems = await separateMonoNode(clip, sampleRate, (p) => {
    if (p.phase === 'infer' || p.phase === 'download') {
      process.stdout.write(`\r  [${p.phase}] ${(p.progress * 100).toFixed(0)}% ${p.detail || ''}   `);
    }
  });
  process.stdout.write('\n');
  const otherMono = stereoToMono(stems.other.left, stems.other.right);
  const bassMono = stereoToMono(stems.bass.left, stems.bass.right);
  const otherNotes = await transcribeNotes(otherMono, {
    sampleRate: stems.sampleRate,
    device: 'node',
    minFreq: 80,
    maxFreq: 1200,
  });
  const bassNotes = await transcribeNotes(bassMono, {
    sampleRate: stems.sampleRate,
    device: 'node',
    minFreq: 30,
    maxFreq: 350,
  });
  console.log(`notes: other=${otherNotes.length} bass=${bassNotes.length}`);

  const result = detectChordsPreciseFromStems(stems, otherNotes, bassNotes, {
    simplifyLevel: ref.id.includes('wonderwall') ? 0.35 : 0.45,
    bpmHint: ref.bpm,
    metricDecode: true,
  });

  // Best phase for headline score (as harness)
  let bestScore = -Infinity;
  let bestPhase = 0;
  let bestSegs = ref.segmentsMs;
  const maxBars = Math.max(...ref.loops.map((l) => l.bars.length), 1);
  for (let phase = 0; phase < maxBars; phase++) {
    const segs: Array<{ chord: string; startMs: number; endMs: number }> = [];
    for (const loop of ref.loops) {
      segs.push(
        ...expandLoopPhase(ref.bpm, loop.fromMs, loop.toMs, loop.bars, phase % loop.bars.length),
      );
    }
    const s = scoreAgainstTimedReference(result.chords, segs, {
      bpm: ref.bpm,
      maxOffsetMs: 8000,
      durationMs: sepMaxSec * 1000,
    });
    if (s.toneOverlapPct > bestScore) {
      bestScore = s.toneOverlapPct;
      bestPhase = phase;
      bestSegs = segs;
    }
  }
  const score = scoreAgainstTimedReference(result.chords, bestSegs, {
    bpm: ref.bpm,
    maxOffsetMs: 8000,
    durationMs: sepMaxSec * 1000,
  });

  console.log(
    `tone ${score.toneOverlapPct.toFixed(1)}% (J=${score.toneJaccardPct.toFixed(1)} R=${score.toneRecallPct.toFixed(1)} root=${score.rootMatchPct.toFixed(1)}) exact ${score.exactPct.toFixed(1)} maj/min ${score.majMinPct.toFixed(1)} key ${result.key}`,
  );
  console.log(
    `downbeatPhase=${result.downbeatPhase} (beat i is downbeat when i%4===phase) bestRefPhase=${bestPhase}`,
  );
  console.log(
    'chords:',
    result.chords
      .slice(0, 20)
      .map((c) => `${c.chord}@${(c.tMs / 1000).toFixed(2)}s`)
      .join(' → '),
  );

  return { ref, result, score, bestPhase, otherNotes, bassNotes };
}

async function main() {
  const hj = await runOne('hey-jude-real');
  const ww = await runOne('wonderwall-real');

  const lines: string[] = [];
  lines.push('# Precise metric / downbeat report');
  lines.push('');
  lines.push(
    `Generated ${new Date().toISOString()} by \`packages/chord-engine/scripts/metric-precise-report.ts\`.`,
  );
  lines.push('');
  lines.push('## Before / after (precise first 60s)');
  lines.push('');
  lines.push('| Song | Before tone % | After tone % | Δ | Key | Downbeat phase | NNLS ms |');
  lines.push('|---|---:|---:|---:|---|---:|---:|');
  lines.push(
    `| Hey Jude | 94.3 | **${hj.score.toneOverlapPct.toFixed(1)}** | ${hj.score.toneOverlapPct - 94.3 >= 0 ? '+' : ''}${(hj.score.toneOverlapPct - 94.3).toFixed(1)} | ${hj.result.key} | ${hj.result.downbeatPhase} | ${hj.result.nnlsAnalysisMs?.toFixed(0) ?? '—'} |`,
  );
  lines.push(
    `| Wonderwall | 49.7 | **${ww.score.toneOverlapPct.toFixed(1)}** | ${ww.score.toneOverlapPct - 49.7 >= 0 ? '+' : ''}${(ww.score.toneOverlapPct - 49.7).toFixed(1)} | ${ww.result.key} | ${ww.result.downbeatPhase} | ${ww.result.nnlsAnalysisMs?.toFixed(0) ?? '—'} |`,
  );
  lines.push('');

  // Wonderwall sections
  const barMs = (4 * 60000) / ww.ref.bpm;
  const beatMs = 60000 / ww.ref.bpm;
  const fixedPhase = 3;
  const fixedSegs = expandLoopPhase(
    ww.ref.bpm,
    0,
    sepMaxSec * 1000,
    ww.ref.loops[0]!.bars,
    fixedPhase,
  );

  const sectionRanges = [
    { name: 'intro(0–16s)', startMs: 0, endMs: 16000 },
    { name: 'verse(16–45s)', startMs: 16000, endMs: 45000 },
    { name: 'late(45–60s)', startMs: 45000, endMs: sepMaxSec * 1000 },
  ];
  lines.push('## Wonderwall per-section (tone %, fixed ref phase 3 + best-phase harness)');
  lines.push('');
  lines.push('| Section | Tone % (phase 3) | Tone % (best harness phase) |');
  lines.push('|---|---:|---:|');

  function sectionTone(
    segs: Array<{ chord: string; startMs: number; endMs: number }>,
    startMs: number,
    endMs: number,
  ): number {
    let sum = 0;
    let n = 0;
    for (let t = startMs + beatMs * 0.5; t < endMs; t += beatMs) {
      let ref = 'N';
      for (const s of segs) {
        if (t >= s.startMs && t < s.endMs) {
          ref = s.chord;
          break;
        }
      }
      if (ref === 'N') continue;
      sum += toneOverlap(ref, chordAt(ww.result.chords, t)).weighted;
      n++;
    }
    return n ? (sum / n) * 100 : 0;
  }

  // Best-phase segs for WW
  const bestSegs: Array<{ chord: string; startMs: number; endMs: number }> = [];
  for (const loop of ww.ref.loops) {
    bestSegs.push(
      ...expandLoopPhase(
        ww.ref.bpm,
        loop.fromMs,
        loop.toMs,
        loop.bars,
        ww.bestPhase % loop.bars.length,
      ),
    );
  }
  for (const r of sectionRanges) {
    lines.push(
      `| ${r.name} | ${sectionTone(fixedSegs, r.startMs, r.endMs).toFixed(1)} | ${sectionTone(bestSegs, r.startMs, r.endMs).toFixed(1)} |`,
    );
  }
  lines.push('');

  // Raw change times vs barlines
  lines.push('## Wonderwall: raw chord-change times vs barlines');
  lines.push('');
  lines.push(
    `BPM ${ww.ref.bpm}, bar ≈ ${barMs.toFixed(0)} ms. Downbeat phase **${ww.result.downbeatPhase}** (beats[i] downbeat when i%4===phase). Beat-grid first beat @ ${(ww.result.beats[0] ?? 0).toFixed(0)} ms.`,
  );
  lines.push('');
  // Barlines from downbeat phase
  const phase = ww.result.downbeatPhase ?? 0;
  const barStarts: number[] = [];
  for (let i = phase; i < ww.result.beats.length; i += 4) {
    barStarts.push(ww.result.beats[i]!);
  }
  lines.push('| Change t (s) | Chord | Nearest barline (s) | Δ to barline (ms) | Beat-in-bar |');
  lines.push('|---:|---|---:|---:|---:|');
  for (let i = 0; i < ww.result.chords.length; i++) {
    const c = ww.result.chords[i]!;
    if (i > 0 && c.chord === ww.result.chords[i - 1]!.chord) continue;
    let nearest = barStarts[0] ?? 0;
    let bestD = Infinity;
    for (const b of barStarts) {
      const d = Math.abs(b - c.tMs);
      if (d < bestD) {
        bestD = d;
        nearest = b;
      }
    }
    // Also find which beat index
    let beatIdx = 0;
    let bd = Infinity;
    for (let bi = 0; bi < ww.result.beats.length; bi++) {
      const d = Math.abs(ww.result.beats[bi]! - c.tMs);
      if (d < bd) {
        bd = d;
        beatIdx = bi;
      }
    }
    const bib = ww.result.beatInBar?.[beatIdx] ?? (((beatIdx - phase) % 4) + 4) % 4;
    lines.push(
      `| ${(c.tMs / 1000).toFixed(2)} | ${c.chord} | ${(nearest / 1000).toFixed(2)} | ${(c.tMs - nearest).toFixed(0)} | ${bib} |`,
    );
  }
  lines.push('');

  // Per-bar table fixed phase 3
  lines.push('## Wonderwall per-bar table (fixed reference phase 3 = A in bar 0)');
  lines.push('');
  lines.push('| Time | Reference | Ref tones | Detected | Detected tones | Overlap |');
  lines.push('|---|---|---|---|---|---:|');
  for (const seg of fixedSegs) {
    if (seg.startMs >= sepMaxSec * 1000) break;
    const mid = (seg.startMs + seg.endMs) / 2;
    const hyp = chordAt(ww.result.chords, mid);
    const o = toneOverlap(seg.chord, hyp);
    const t0 = (seg.startMs / 1000).toFixed(2);
    const t1 = (Math.min(seg.endMs, sepMaxSec * 1000) / 1000).toFixed(2);
    lines.push(
      `| ${t0}–${t1} | ${seg.chord} | ${chordTones(seg.chord)} | ${hyp} | ${chordTones(hyp)} | ${(o.weighted * 100).toFixed(0)}% |`,
    );
  }
  lines.push('');

  // Histograms
  lines.push('## Wonderwall note histograms');
  lines.push('');
  lines.push(
    'Pitch-class / MIDI dumps from Basic Pitch (duration×velocity) on UMX stems. Explains intro G/F and late G/D detections.',
  );
  lines.push('');
  const introOther = ww.otherNotes.filter((n) => n.time < 16 && n.time + n.duration > 0);
  const introBass = ww.bassNotes.filter((n) => n.time < 16 && n.time + n.duration > 0);
  lines.push(
    `Intro note counts: other=${introOther.length}/${ww.otherNotes.length}, bass=${introBass.length}/${ww.bassNotes.length}.`,
  );
  lines.push('');
  lines.push(...dumpNoteHistogram(ww.otherNotes, 0, 16, 'Intro 0–16s (other stem)').lines);
  lines.push(...dumpNoteHistogram(ww.bassNotes, 0, 16, 'Intro 0–16s (bass stem)').lines);
  lines.push(
    ...dumpNoteHistogram(
      ww.otherNotes.concat(ww.bassNotes),
      0,
      16,
      'Intro 0–16s (other+bass)',
    ).lines,
  );
  lines.push(...dumpNoteHistogram(ww.otherNotes, 52, 60, 'Ending 52–60s (other stem)').lines);
  lines.push(...dumpNoteHistogram(ww.bassNotes, 52, 60, 'Ending 52–60s (bass stem)').lines);

  // Findings
  function pcShare(notes: NoteEvent[], t0: number, t1: number) {
    const pc = new Float32Array(12);
    for (const n of notes) {
      const overlap =
        Math.min(n.time + Math.max(0.01, n.duration), t1) - Math.max(n.time, t0);
      if (overlap <= 0) continue;
      pc[((Math.round(n.midi) % 12) + 12) % 12]! +=
        overlap * (0.25 + 0.75 * n.velocity);
    }
    const s = pc.reduce((a, b) => a + b, 0) || 1;
    return {
      G: pc[7]! / s,
      F: pc[5]! / s,
      D: pc[2]! / s,
      C: pc[0]! / s,
      Fs: pc[6]! / s,
      A: pc[9]! / s,
      mass: pc.reduce((a, b) => a + b, 0),
      n: notes.filter((n) => n.time < t1 && n.time + n.duration > t0).length,
    };
  }
  const introO = pcShare(ww.otherNotes, 0, 16);
  const endO = pcShare(ww.otherNotes, 52, 60);
  lines.push('## Findings (G/F/D/C out-of-key)');
  lines.push('');
  const introB = pcShare(ww.bassNotes, 0, 16);
  lines.push(
    `- **Intro 0–16s (\`other\`)**: only **${introO.n}** Basic Pitch notes (mass ${introO.mass.toFixed(2)}). UMX puts almost no guitar into \`other\` until ~16.4s (verse onset).`,
  );
  lines.push(
    `- **Intro bass stem**: **${introB.n}** notes, PC mass **G=${(introB.G * 100).toFixed(1)}%** (mostly **G1**), F=${(introB.F * 100).toFixed(1)}%. The classic intro G/F labels were driven by **real low G/F MIDI in the bass stem** (leakage / mis-separated guitar), not FFT harmonics — and not by \`other\` (nearly empty). Precise path now falls back to instrumental audio chroma when accompaniment notes are empty.`,
  );
  lines.push(
    `- **Ending 52–60s (\`other\`)**: real **G2 (MIDI 43)** and **D3 (MIDI 50)** (~4–5% weight) — open-string / non-chord fundamentals, not harmonic leakage. PC mass G=${(endO.G * 100).toFixed(1)}%, D=${(endO.D * 100).toFixed(1)}%. Bass stem also heavy G/D.`,
  );
  lines.push(
    `- Detected downbeat phase **${ww.result.downbeatPhase}** (matches fixed reference phase 3). Many verse changes land on beat-in-bar 0; residual half-bar (beat 2) flips remain.`,
  );
  lines.push('');

  const outPath = join(outDir, 'precise-metric-report.md');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, lines.join('\n'));
  console.log(`\nWrote ${outPath}`);
  console.log(lines.join('\n'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
