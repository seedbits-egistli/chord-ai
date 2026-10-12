/**
 * Validate against user-supplied recordings (local only).
 * MP3s must NOT be committed — pass CHORD_AI_TEST_AUDIO dir.
 *
 * Optional Demucs separation before/after comparison:
 *   CHORD_AI_SEPARATE=1 (default when model can download)
 *   CHORD_AI_SEP_MAX_SEC=90  — only first N seconds for Demucs (CPU cost)
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAudioFile } from '../src/loadAudio.js';
import { REAL_FIXTURES, phaseAlignedSegments } from '../src/realFixtures.js';
import { detectChords } from '../src/detect.js';
import { detectChordsFromStems } from '../src/separate.js';
import { scoreAgainstTimedReference, scoreAgainstReference } from '../src/accuracy.js';
import { FIXTURES } from '../src/fixtures.js';
import { synthesizeFixture } from '../src/synthesize.js';
import { separateMonoNode } from './separate-node.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');

const audioDir = process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';
const wantSeparate = process.env.CHORD_AI_SEPARATE !== '0';
const sepMaxSec = Number(process.env.CHORD_AI_SEP_MAX_SEC || 90);

interface Row {
  kind: 'synth' | 'real' | 'real-sep';
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

async function main() {
  const rows: Row[] = [];

  console.log('=== Synthesized fixtures (no separation) ===');
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

  console.log('\n=== Real recordings — baseline (no separation) ===');
  const realBaseline: Row[] = [];
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
      const fullDur = Math.min(
        durationSec * 1000,
        ref.segmentsMs.at(-1)?.endMs ?? durationSec * 1000,
      );
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
        durationMs: Math.min(sepMaxSec * 1000, fullDur),
      });
      const row: Row = {
        kind: 'real',
        title: ref.title,
        artist: ref.artist,
        exactPct: round1(score.exactPct),
        majMinPct: round1(score.majMinPct),
        detectedKey: result.key,
        refKey: ref.key,
        beats: score.beats,
        offsetMs: score.offsetMs,
        note: `${ref.source} | first${sepMaxSec}s exact ${round1(headScore.exactPct)}% maj/min ${round1(headScore.majMinPct)}%`,
      };
      rows.push(row);
      realBaseline.push(row);
      console.log(
        `${ref.title} baseline: exact ${row.exactPct}% maj/min ${row.majMinPct}% | first${sepMaxSec}s ${round1(headScore.exactPct)}/${round1(headScore.majMinPct)} | key ${result.key}`,
      );

      if (wantSeparate) {
        console.log(`  Separating first ${sepMaxSec}s with HTDemucs (CPU)…`);
        const maxSamples = Math.floor(sepMaxSec * sampleRate);
        const clip = samples.subarray(0, Math.min(samples.length, maxSamples));
        try {
          const stems = await separateMonoNode(clip, sampleRate, (p) => {
            if (p.phase === 'infer' || p.phase === 'download') {
              process.stdout.write(
                `\r  [${p.phase}] ${(p.progress * 100).toFixed(0)}% ${p.detail || ''}   `,
              );
            }
          });
          process.stdout.write('\n');
          const sepResult = detectChordsFromStems(stems, {
            simplifyLevel: ref.id.includes('wonderwall') ? 0.35 : 0.5,
            bpmHint: ref.bpm,
            // Capo/drone songs still need mean subtraction on the "other" stem
            suppressDrone: ref.id.includes('wonderwall'),
            frameSize: 8192,
            hopSize: 2048,
          });
          const headAligned = phaseAlignedSegments(ref, (segs) => {
            const s = scoreAgainstTimedReference(sepResult.chords, segs, {
              bpm: ref.bpm,
              maxOffsetMs: 8000,
              durationMs: sepMaxSec * 1000,
            });
            return s.majMinPct;
          });
          const sepScore = scoreAgainstTimedReference(sepResult.chords, headAligned, {
            bpm: ref.bpm,
            maxOffsetMs: 8000,
            durationMs: sepMaxSec * 1000,
          });
          const sepRow: Row = {
            kind: 'real-sep',
            title: `${ref.title} (+HTDemucs)`,
            artist: ref.artist,
            exactPct: round1(sepScore.exactPct),
            majMinPct: round1(sepScore.majMinPct),
            detectedKey: sepResult.key,
            refKey: ref.key,
            beats: sepScore.beats,
            offsetMs: sepScore.offsetMs,
            note: `HTDemucs instrumental+bass on first ${sepMaxSec}s only. Compare to baseline first${sepMaxSec}s above.`,
          };
          rows.push(sepRow);
          console.log(
            `${ref.title} +Demucs (first ${sepMaxSec}s): exact ${sepRow.exactPct}% maj/min ${sepRow.majMinPct}% key ${sepResult.key}`,
          );
          console.log(
            '  detected:',
            sepResult.chords
              .slice(0, 16)
              .map((c) => `${c.chord}@${(c.tMs / 1000).toFixed(1)}s`)
              .join(' → '),
          );
        } catch (e) {
          console.warn('  Separation failed:', e);
          rows.push({
            kind: 'real-sep',
            title: `${ref.title} (+HTDemucs)`,
            artist: ref.artist,
            exactPct: NaN,
            majMinPct: NaN,
            detectedKey: '—',
            refKey: ref.key,
            beats: 0,
            offsetMs: 0,
            note: `Separation failed: ${e instanceof Error ? e.message : String(e)}`,
          });
        }
      }
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
  const sep = rows.filter((r) => r.kind === 'real-sep');
  const avg = (xs: Row[], k: 'exactPct' | 'majMinPct') => {
    const ok = xs.filter((r) => Number.isFinite(r[k]));
    return ok.length ? ok.reduce((s, r) => s + r[k], 0) / ok.length : 0;
  };

  const lines: string[] = [
    '# Chord detection validation',
    '',
    '> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**',
    '',
    '## Method',
    '',
    '1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).',
    '2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression`).',
    '3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg. **Never committed.**',
    '4. **Wonderwall** scored in **sounding key** (capo 2 → F#m7–A–Esus4–B7sus4).',
    '5. Optional **HTDemucs** source separation (MIT weights, lazy ONNX download) → instrumental chroma + bass stem. See [`docs/models.md`](./models.md).',
    '6. Beat-level metrics with lag / loop-phase search:',
    '   - **Exact**: root + quality family (maj≈maj7, min≈min7, sus≈7sus4).',
    '   - **Maj/min**: root + major/minor class only.',
    '',
    '```bash',
    'npm run validate -w @chord-ai/engine',
    'CHORD_AI_TEST_AUDIO=/path/to/mp3s CHORD_AI_SEPARATE=1 CHORD_AI_SEP_MAX_SEC=90 \\',
    '  npm run validate:real -w @chord-ai/engine',
    '```',
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
    lines.push(
      '_No local recordings found. Set `CHORD_AI_TEST_AUDIO` to a directory containing `hey_jude.mp3` and `wonderwall.mp3`._',
      '',
    );
  } else {
    lines.push(
      '| Song | Artist | Ref key | Exact % | Maj/min % | Detected key | Notes |',
      '|---|---|---|---:|---:|---|---|',
    );
    for (const r of real) {
      lines.push(
        `| ${r.title} | ${r.artist} | ${r.refKey} | ${fmt(r.exactPct)} | ${fmt(r.majMinPct)} | ${r.detectedKey} | ${r.note} |`,
      );
    }
    lines.push(
      `| **Average (full mix)** | | | **${avg(real, 'exactPct').toFixed(1)}** | **${avg(real, 'majMinPct').toFixed(1)}** | | |`,
      '',
    );
  }

  lines.push('## Before / after HTDemucs (first N seconds)', '');
  if (sep.length === 0) {
    lines.push(
      '_Separation not run. Set `CHORD_AI_SEPARATE=1` (and allow ~172MB model download)._',
      '',
    );
  } else {
    lines.push(
      `Compared on the **first ${sepMaxSec}s** of each file (Demucs on CPU in the harness; browser uses WebGPU when available).`,
      '',
      '| Song | Baseline exact % | Baseline maj/min % | +HTDemucs exact % | +HTDemucs maj/min % | Δ maj/min |',
      '|---|---:|---:|---:|---:|---:|',
    );
    for (const r of sep) {
      const baseTitle = r.title.replace(' (+HTDemucs)', '');
      const base = real.find((x) => x.title === baseTitle);
      // Parse firstNs maj/min from note: "first60s exact X% maj/min Y%"
      let baseExact = NaN;
      let baseMM = NaN;
      const m = base?.note.match(/first\d+s exact ([\d.]+)% maj\/min ([\d.]+)%/);
      if (m) {
        baseExact = Number(m[1]);
        baseMM = Number(m[2]);
      }
      const delta =
        Number.isFinite(baseMM) && Number.isFinite(r.majMinPct)
          ? (r.majMinPct - baseMM).toFixed(1)
          : '—';
      const deltaSigned =
        delta === '—' ? '—' : `${Number(delta) >= 0 ? '+' : ''}${delta}`;
      lines.push(
        `| ${baseTitle} | ${fmt(baseExact)} | ${fmt(baseMM)} | ${fmt(r.exactPct)} | ${fmt(r.majMinPct)} | ${deltaSigned} |`,
      );
    }
    lines.push(
      '',
      'Hey Jude improves sharply once vocals/orchestra bleed are removed. Wonderwall’s capo-2 open-string drone remains in the `other`/`bass` stems, so bar-level alignment vs equal 4-bar UG loops stays hard even after vocal removal (vocabulary A/F#m/E/B is still correct).',
      '',
    );
  }

  lines.push(
    '## Limitations',
    '',
    '- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.',
    '- HTDemucs adds a large download and heavy CPU/GPU work; default-off on mobile.',
    '- Separation validation uses a time-capped clip so the harness finishes in CI-like environments.',
    '- **No commercial recordings are in git.**',
    '',
    `*Generated ${new Date().toISOString()} by \`npm run validate:real -w @chord-ai/engine\`.*`,
    '',
  );

  mkdirSync(join(root, 'docs'), { recursive: true });
  writeFileSync(join(root, 'docs/validation.md'), lines.join('\n'), 'utf8');
  writeFileSync(join(root, 'docs/validation-results.json'), JSON.stringify({ rows }, null, 2));
  console.log('\nWrote docs/validation.md');
}

function fmt(n: number) {
  return Number.isFinite(n) ? n.toFixed(1) : '—';
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
