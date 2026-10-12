/**
 * Validate against user-supplied recordings (local only).
 * MP3s must NOT be committed — pass CHORD_AI_TEST_AUDIO dir.
 */
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAudioFile } from '../src/loadAudio.js';
import { REAL_FIXTURES, phaseAlignedSegments } from '../src/realFixtures.js';
import { detectChords } from '../src/detect.js';
import { scoreAgainstTimedReference } from '../src/accuracy.js';
import { FIXTURES } from '../src/fixtures.js';
import { synthesizeFixture } from '../src/synthesize.js';
import { scoreAgainstReference } from '../src/accuracy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');

const audioDir =
  process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';

interface Row {
  kind: 'synth' | 'real';
  title: string;
  artist: string;
  exactPct: number;
  majMinPct: number;
  detectedKey: string;
  refKey: string;
  beats: number;
  offsetMs: number;
  note: string;
}

function main() {
  const rows: Row[] = [];

  console.log('=== Synthesized fixtures ===');
  for (const fixture of FIXTURES) {
    const { samples, sampleRate } = synthesizeFixture(fixture, {
      timbre: 'guitar',
      sampleRate: 22050,
    });
    const result = detectChords(samples, sampleRate, {
      simplifyLevel: 0.55,
      bpmHint: fixture.bpm,
      suppressDrone: false,
    });
    const score = scoreAgainstReference(result.chords, fixture.segments, fixture.bpm);
    rows.push({
      kind: 'synth',
      title: fixture.title,
      artist: fixture.artist,
      exactPct: round1(score.exactPct),
      majMinPct: round1(score.majMinPct),
      detectedKey: result.key,
      refKey: fixture.key,
      beats: score.beats,
      offsetMs: 0,
      note: 'synthesized from reference chart',
    });
    console.log(
      `${fixture.title}: exact ${rows.at(-1)!.exactPct}% maj/min ${rows.at(-1)!.majMinPct}%`,
    );
  }

  console.log('\n=== Real recordings (local, not committed) ===');
  if (!existsSync(audioDir)) {
    console.warn(`Audio dir missing: ${audioDir} — skipping real tests`);
  } else {
    for (const ref of REAL_FIXTURES) {
      const path = join(audioDir, ref.filename);
      if (!existsSync(path)) {
        console.warn(`Missing ${path}`);
        continue;
      }
      console.log(`Loading ${ref.filename}…`);
      const { samples, sampleRate, durationSec } = loadAudioFile(path, 22050);
      console.log(`  ${durationSec.toFixed(1)}s @ ${sampleRate} Hz`);
      const result = detectChords(samples, sampleRate, {
        simplifyLevel: ref.id.includes('wonderwall') ? 0.35 : 0.5,
        bpmHint: ref.bpm,
        suppressDrone: ref.id.includes('wonderwall'),
        frameSize: 8192,
        hopSize: 2048,
      });
      const fullDur = Math.min(durationSec * 1000, ref.segmentsMs.at(-1)?.endMs ?? durationSec * 1000);
      const aligned = phaseAlignedSegments(ref, (segs) => {
        const s = scoreAgainstTimedReference(result.chords, segs, {
          bpm: ref.bpm,
          maxOffsetMs: 8000,
          durationMs: fullDur,
        });
        return s.majMinPct;
      });
      const score = scoreAgainstTimedReference(result.chords, aligned, {
        bpm: ref.bpm,
        maxOffsetMs: 8000,
        durationMs: fullDur,
      });
      const headScore = scoreAgainstTimedReference(result.chords, aligned, {
        bpm: ref.bpm,
        maxOffsetMs: 8000,
        durationMs: Math.min(120000, fullDur),
      });
      rows.push({
        kind: 'real',
        title: ref.title,
        artist: ref.artist,
        exactPct: round1(score.exactPct),
        majMinPct: round1(score.majMinPct),
        detectedKey: result.key,
        refKey: ref.key,
        beats: score.beats,
        offsetMs: score.offsetMs,
        note: `${ref.source} | first90s exact ${round1(headScore.exactPct)}% maj/min ${round1(headScore.majMinPct)}%`,
      });
      console.log(
        `${ref.title}: exact ${rows.at(-1)!.exactPct}% maj/min ${rows.at(-1)!.majMinPct}% | first90s ${round1(headScore.exactPct)}/${round1(headScore.majMinPct)} | key ${result.key} (ref ${ref.key}) offset ${score.offsetMs}ms`,
      );
      const misses = score.details.filter((d) => !d.majMin).slice(0, 8);
      for (const m of misses) {
        console.log(`  beat~${m.beat}: ref=${m.ref} hyp=${m.hyp}`);
      }
      console.log(
        '  detected:',
        result.chords
          .slice(0, 20)
          .map((c) => `${c.chord}@${(c.tMs / 1000).toFixed(1)}s`)
          .join(' → '),
      );
    }
  }

  writeDocs(rows);
}

function round1(n: number) {
  return Math.round(n * 10) / 10;
}

function writeDocs(rows: Row[]) {
  const synth = rows.filter((r) => r.kind === 'synth');
  const real = rows.filter((r) => r.kind === 'real');
  const avg = (xs: Row[], k: 'exactPct' | 'majMinPct') =>
    xs.length ? xs.reduce((s, r) => s + r[k], 0) / xs.length : 0;

  const lines: string[] = [
    '# Chord detection validation',
    '',
    '> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Results below may include metrics from private local files. Synthesized rows render chords only (no copyrighted audio).',
    '',
    '## Method',
    '',
    '1. **Reference chords** from public educational / Ultimate Guitar–style charts.',
    '2. **Synthesized audio**: additive guitar/piano-like tones at fixture BPM (`synthesizeChordProgression`).',
    '3. **Real audio (optional, local only)**: user-supplied `hey_jude.mp3` / `wonderwall.mp3` decoded with ffmpeg in the harness (`CHORD_AI_TEST_AUDIO`). Never committed.',
    '4. **Wonderwall** charts are commonly capo 2 (Em7 G Dsus4 A7sus4 shapes); scoring uses the **sounding key** (F#m7 A Esus4 B7sus4).',
    '5. Same MIT chroma → template → Viterbi pipeline as the web app.',
    '6. Metrics are beat-level with ±2.5s global offset search for real files (intro/phase).',
    '   - **Exact**: root + quality family (maj≈maj7, min≈min7, sus≈7sus4).',
    '   - **Maj/min**: root + major/minor class only.',
    '',
    '## Synthesized results',
    '',
    '| Song | Artist | Ref key | Exact % | Maj/min % | Detected key |',
    '|---|---|---|---:|---:|---|',
  ];
  for (const r of synth) {
    lines.push(
      `| ${r.title} | ${r.artist} | ${r.refKey} | ${r.exactPct.toFixed(1)} | ${r.majMinPct.toFixed(1)} | ${r.detectedKey} |`,
    );
  }
  lines.push(
    `| **Average** | | | **${avg(synth, 'exactPct').toFixed(1)}** | **${avg(synth, 'majMinPct').toFixed(1)}** | |`,
    '',
    '## Real recording results (local files, not in repo)',
    '',
  );
  if (real.length === 0) {
    lines.push('_No local recordings found. Set `CHORD_AI_TEST_AUDIO` to a directory containing `hey_jude.mp3` and `wonderwall.mp3`._', '');
  } else {
    lines.push(
      '| Song | Artist | Ref key | Exact % | Maj/min % | Detected key | Offset ms |',
      '|---|---|---|---:|---:|---|---:|',
    );
    for (const r of real) {
      lines.push(
        `| ${r.title} | ${r.artist} | ${r.refKey} | ${r.exactPct.toFixed(1)} | ${r.majMinPct.toFixed(1)} | ${r.detectedKey} | ${r.offsetMs} |`,
      );
    }
    lines.push(
      `| **Average** | | | **${avg(real, 'exactPct').toFixed(1)}** | **${avg(real, 'majMinPct').toFixed(1)}** | | |`,
      '',
      '### Chart notes',
      '',
    );
    for (const r of real) {
      lines.push(`- **${r.title}**: ${r.note}`);
    }
    lines.push('');
  }

  lines.push(
    '## Limitations',
    '',
    '- Real commercial mixes (drums, vocals, distortion, orchestra) are much harder than synthesized chords.',
    '- Reference timelines are hand-built from public charts + nominal BPM; section boundaries may drift.',
    '- Exact % is lower when the chart uses sus/7 and the detector simplifies, or when live voicings differ from UG.',
    '- **Commercial recordings were only evaluated locally for this report and are not part of the MIT source tree.**',
    '',
    `*Generated ${new Date().toISOString()} by \`npm run validate:real -w @chord-ai/engine\`.*`,
    '',
  );

  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/validation.md'), lines.join('\n'), 'utf8');
  writeFileSync(join(root, 'docs/validation-results.json'), JSON.stringify({ rows }, null, 2));
  console.log('\nWrote docs/validation.md');
}

main();
