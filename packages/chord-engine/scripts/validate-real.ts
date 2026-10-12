/**
 * Validate against user-supplied recordings (local only).
 * MP3s must NOT be committed — pass CHORD_AI_TEST_AUDIO dir.
 *
 * Optional UMX-HQ separation before/after comparison (opt-in advanced mode):
 *   CHORD_AI_SEPARATE=1 (default on in this harness; set 0 to skip)
 *   CHORD_AI_SEP_MAX_SEC=60  — only first N seconds for separation (CPU cost)
 *   CHORD_AI_UMX_BASS=0      — vocals-only (~17 MiB) instead of vocals+bass (~34 MiB)
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAudioFile } from '../src/loadAudio.js';
import { REAL_FIXTURES, phaseAlignedSegments } from '../src/realFixtures.js';
import { detectChords } from '../src/detect.js';
import { detectChordsFromStems, stereoToMono } from '../src/separate.js';
import { detectChordsPreciseFromStems } from '../src/preciseDetect.js';
import { transcribeNotes } from '../src/basicPitch.js';
import {
  scoreAgainstTimedReference,
  scoreAgainstReference,
  toneOverlap,
} from '../src/accuracy.js';
import { FIXTURES } from '../src/fixtures.js';
import { synthesizeFixture } from '../src/synthesize.js';
import { separateMonoNode } from './separate-node.js';
import type { ChordEvent } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');

const audioDir = process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';
const wantSeparate = process.env.CHORD_AI_SEPARATE !== '0';
const wantPrecise = process.env.CHORD_AI_PRECISE !== '0';
const sepMaxSec = Number(process.env.CHORD_AI_SEP_MAX_SEC || 60);

/** Previous headline numbers (tone %) before tuning + weak-bass fixes — for docs before/after. */
const BEFORE_TONE = {
  'Hey Jude': { fast: 57.6, precise: 86.4 },
  Wonderwall: { fast: 42.5, precise: 42.8 },
} as const;

/** Frozen precise tone % before NNLS chroma fusion. */
const BEFORE_METRIC_TONE = {
  'Hey Jude': 94.3,
  Wonderwall: 49.7,
} as const;

/** Frozen post-tuning fast / UMX / precise (1f18a77) for historical tuning table. */
const AFTER_TUNING_TONE = {
  'Hey Jude': { fast: 48.6, umx: 92.6, precise: 86.4 },
  Wonderwall: { fast: 37.7, umx: 57.2, precise: 42.1 },
} as const;

interface SectionTone {
  name: string;
  tonePct: number;
  jaccardPct: number;
  recallPct: number;
  rootPct: number;
  n: number;
}

interface Row {
  kind: 'synth' | 'real' | 'real-sep' | 'real-precise';
  title: string;
  artist: string;
  /** Headline: mean weighted PC tone-overlap (0–100). */
  toneOverlapPct: number;
  toneJaccardPct: number;
  toneRecallPct: number;
  rootMatchPct: number;
  exactPct: number;
  majMinPct: number;
  detectedKey: string;
  refKey: string;
  beats: number;
  offsetMs: number;
  note: string;
  sections?: SectionTone[];
  /** Precise-mode estimated downbeat phase (i%4===phase → downbeat). */
  downbeatPhase?: number;
  nnlsMs?: number;
}

function chordAt(events: ChordEvent[], tMs: number): string {
  for (const e of events) {
    if (tMs >= e.tMs && tMs < e.endMs) return e.chord;
  }
  let best = events[0]?.chord ?? 'N';
  let bestDist = Infinity;
  for (const e of events) {
    const mid = (e.tMs + e.endMs) / 2;
    const d = Math.abs(mid - tMs);
    if (d < bestDist) {
      bestDist = d;
      best = e.chord;
    }
  }
  return best;
}

function refAtMs(
  segs: Array<{ chord: string; startMs: number; endMs: number }>,
  tMs: number,
): string {
  for (const s of segs) {
    if (tMs >= s.startMs && tMs < s.endMs) return s.chord;
  }
  return 'N';
}

/** Beat-grid tone overlap for time ranges (Wonderwall intro/verse). */
function sectionToneScores(
  detected: ChordEvent[],
  aligned: Array<{ chord: string; startMs: number; endMs: number }>,
  bpm: number,
  durationMs: number,
  ranges: Array<{ name: string; startMs: number; endMs: number }>,
): SectionTone[] {
  const beatMs = 60000 / bpm;
  return ranges.map((r) => {
    let tone = 0;
    let jac = 0;
    let rec = 0;
    let root = 0;
    let n = 0;
    for (let t = r.startMs + beatMs * 0.5; t < Math.min(r.endMs, durationMs); t += beatMs) {
      const ref = refAtMs(aligned, t);
      if (ref === 'N') continue;
      const hyp = chordAt(detected, t);
      const o = toneOverlap(ref, hyp);
      tone += o.weighted;
      jac += o.jaccard;
      rec += o.recall;
      if (o.rootMatch) root++;
      n++;
    }
    const d = n || 1;
    return {
      name: r.name,
      tonePct: round1((100 * tone) / d),
      jaccardPct: round1((100 * jac) / d),
      recallPct: round1((100 * rec) / d),
      rootPct: round1((100 * root) / d),
      n,
    };
  });
}

function toneFields(score: {
  toneOverlapPct: number;
  toneJaccardPct: number;
  toneRecallPct: number;
  rootMatchPct: number;
  exactPct: number;
  majMinPct: number;
  beats: number;
  offsetMs: number;
}) {
  return {
    toneOverlapPct: round1(score.toneOverlapPct),
    toneJaccardPct: round1(score.toneJaccardPct),
    toneRecallPct: round1(score.toneRecallPct),
    rootMatchPct: round1(score.rootMatchPct),
    exactPct: round1(score.exactPct),
    majMinPct: round1(score.majMinPct),
    beats: score.beats,
    offsetMs: score.offsetMs,
  };
}

function nanToneFields() {
  return {
    toneOverlapPct: NaN,
    toneJaccardPct: NaN,
    toneRecallPct: NaN,
    rootMatchPct: NaN,
    exactPct: NaN,
    majMinPct: NaN,
  };
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
      ...toneFields(score),
      detectedKey: result.key,
      refKey: fixture.key,
      note: 'synthesized from reference chart',
    });
    const last = rows.at(-1)!;
    console.log(
      `${fixture.title}: tone ${last.toneOverlapPct}% (J=${last.toneJaccardPct} R=${last.toneRecallPct} root=${last.rootMatchPct}) | exact ${last.exactPct}% maj/min ${last.majMinPct}%`,
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
        return s.toneOverlapPct;
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
      const sections =
        ref.id.includes('wonderwall')
          ? sectionToneScores(
              result.chords,
              aligned,
              ref.bpm,
              Math.min(sepMaxSec * 1000, fullDur),
              [
                { name: 'intro(0–16s)', startMs: 0, endMs: 16000 },
                { name: 'verse(16–45s)', startMs: 16000, endMs: 45000 },
                { name: 'late(45–60s)', startMs: 45000, endMs: sepMaxSec * 1000 },
              ],
            )
          : undefined;
      const row: Row = {
        kind: 'real',
        title: ref.title,
        artist: ref.artist,
        ...toneFields(score),
        detectedKey: result.key,
        refKey: ref.key,
        note: `${ref.source} | first${sepMaxSec}s tone ${round1(headScore.toneOverlapPct)}% (J=${round1(headScore.toneJaccardPct)} R=${round1(headScore.toneRecallPct)} root=${round1(headScore.rootMatchPct)}) exact ${round1(headScore.exactPct)}% maj/min ${round1(headScore.majMinPct)}%`,
        sections,
      };
      rows.push(row);
      realBaseline.push(row);
      console.log(
        `${ref.title} baseline: tone ${row.toneOverlapPct}% | exact ${row.exactPct}% maj/min ${row.majMinPct}% | first${sepMaxSec}s tone ${round1(headScore.toneOverlapPct)}% exact ${round1(headScore.exactPct)}/${round1(headScore.majMinPct)} | key ${result.key}`,
      );
      if (sections?.length) {
        console.log(
          '  sections (fast):',
          sections.map((s) => `${s.name} tone ${s.tonePct}%`).join(' | '),
        );
      }

      if (wantSeparate) {
        console.log(`  Separating first ${sepMaxSec}s with UMX-HQ (CPU)…`);
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
            return s.toneOverlapPct;
          });
          const sepScore = scoreAgainstTimedReference(sepResult.chords, headAligned, {
            bpm: ref.bpm,
            maxOffsetMs: 8000,
            durationMs: sepMaxSec * 1000,
          });
          const sepRow: Row = {
            kind: 'real-sep',
            title: `${ref.title} (+UMX-HQ)`,
            artist: ref.artist,
            ...toneFields(sepScore),
            detectedKey: sepResult.key,
            refKey: ref.key,
            note: `UMX-HQ vocals+bass (~34MiB) on first ${sepMaxSec}s only. Compare to baseline first${sepMaxSec}s above.`,
          };
          rows.push(sepRow);
          console.log(
            `${ref.title} +UMX-HQ (first ${sepMaxSec}s): tone ${sepRow.toneOverlapPct}% exact ${sepRow.exactPct}% maj/min ${sepRow.majMinPct}% key ${sepResult.key}`,
          );
          console.log(
            '  detected:',
            sepResult.chords
              .slice(0, 16)
              .map((c) => `${c.chord}@${(c.tMs / 1000).toFixed(1)}s`)
              .join(' → '),
          );

          if (wantPrecise) {
            console.log('  Precise mode: Basic Pitch on other/bass…');
            try {
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
              console.log(`  notes: other=${otherNotes.length} bass=${bassNotes.length}`);
              const preciseResult = detectChordsPreciseFromStems(
                stems,
                otherNotes,
                bassNotes,
                {
                  simplifyLevel: ref.id.includes('wonderwall') ? 0.35 : 0.45,
                  bpmHint: ref.bpm,
                  metricDecode: true,
                },
              );
              const precAligned = phaseAlignedSegments(ref, (segs) => {
                const s = scoreAgainstTimedReference(preciseResult.chords, segs, {
                  bpm: ref.bpm,
                  maxOffsetMs: 8000,
                  durationMs: sepMaxSec * 1000,
                });
                return s.toneOverlapPct;
              });
              const precScore = scoreAgainstTimedReference(
                preciseResult.chords,
                precAligned,
                {
                  bpm: ref.bpm,
                  maxOffsetMs: 8000,
                  durationMs: sepMaxSec * 1000,
                },
              );
              const sections =
                ref.id.includes('wonderwall')
                  ? sectionToneScores(
                      preciseResult.chords,
                      precAligned,
                      ref.bpm,
                      sepMaxSec * 1000,
                      [
                        { name: 'intro(0–16s)', startMs: 0, endMs: 16000 },
                        { name: 'verse(16–45s)', startMs: 16000, endMs: 45000 },
                        { name: 'late(45–60s)', startMs: 45000, endMs: sepMaxSec * 1000 },
                      ],
                    )
                  : undefined;
              const precRow: Row = {
                kind: 'real-precise',
                title: `${ref.title} (+precise)`,
                artist: ref.artist,
                ...toneFields(precScore),
                detectedKey: preciseResult.key,
                refKey: ref.key,
                note: `精準模式 UMX+NNLS+Basic Pitch on first ${sepMaxSec}s; notes other=${otherNotes.length} bass=${bassNotes.length}; downbeatPhase=${preciseResult.downbeatPhase}; nnlsMs=${preciseResult.nnlsAnalysisMs?.toFixed?.(0) ?? '—'}`,
                sections,
                downbeatPhase: preciseResult.downbeatPhase,
                nnlsMs: preciseResult.nnlsAnalysisMs,
              };
              rows.push(precRow);
              console.log(
                `${ref.title} +precise (first ${sepMaxSec}s): tone ${precRow.toneOverlapPct}% (J=${precRow.toneJaccardPct} R=${precRow.toneRecallPct} root=${precRow.rootMatchPct}) exact ${precRow.exactPct}% maj/min ${precRow.majMinPct}% key ${preciseResult.key} downbeatPhase=${preciseResult.downbeatPhase} nnlsMs=${preciseResult.nnlsAnalysisMs?.toFixed?.(0) ?? '—'}`,
              );
              if (sections?.length) {
                console.log(
                  '  sections:',
                  sections.map((s) => `${s.name} tone ${s.tonePct}% (n=${s.n})`).join(' | '),
                );
              }
              console.log(
                '  detected:',
                preciseResult.chords
                  .slice(0, 16)
                  .map((c) => `${c.chord}@${(c.tMs / 1000).toFixed(1)}s`)
                  .join(' → '),
              );
            } catch (pe) {
              console.warn('  Precise failed:', pe);
              rows.push({
                kind: 'real-precise',
                title: `${ref.title} (+precise)`,
                artist: ref.artist,
                ...nanToneFields(),
                detectedKey: '—',
                refKey: ref.key,
                beats: 0,
                offsetMs: 0,
                note: `Precise failed: ${pe instanceof Error ? pe.message : String(pe)}`,
              });
            }
          }
        } catch (e) {
          console.warn('  Separation failed:', e);
          rows.push({
            kind: 'real-sep',
            title: `${ref.title} (+UMX-HQ)`,
            artist: ref.artist,
            ...nanToneFields(),
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
  const precise = rows.filter((r) => r.kind === 'real-precise');
  type MetricKey =
    | 'toneOverlapPct'
    | 'toneJaccardPct'
    | 'toneRecallPct'
    | 'rootMatchPct'
    | 'exactPct'
    | 'majMinPct';
  const avg = (xs: Row[], k: MetricKey) => {
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
    '5. **快速模式**: full-mix chroma templates (no ML download).',
    '6. **精準模式** (UI opt-in): UMX-HQ → Basic Pitch + **NNLS chroma** (Mauch & Dixon ISMIR 2010, independent MIT) fused into beat-level metric HMM; harmonic downbeat; drone/sus-aware scoring; vocal residual control. See [`docs/models.md`](./models.md).',
    '7. Beat-level metrics with lag / loop-phase search. **Headline metric is tone overlap** (shared pitch classes), not chord-name equality:',
    '   - **Tone overlap %** (primary): mean of `0.55·Jaccard + 0.35·recall + 0.10·rootMatch` per beat, where Jaccard = `|A∩B|/|A∪B|` and recall = `|A∩B|/|A|` over reference/hypothesis pitch-class sets.',
    '   - **Jaccard / Recall / Root**: component columns (root match reported separately).',
    '   - **Exact** (secondary): root + quality family (maj≈maj7, min≈min7, sus≈7sus4).',
    '   - **Maj/min** (secondary): root + major/minor class only.',
    '',
    '```bash',
    'npm run validate -w @chord-ai/engine',
    'CHORD_AI_TEST_AUDIO=/path/to/mp3s CHORD_AI_SEPARATE=1 CHORD_AI_PRECISE=1 CHORD_AI_SEP_MAX_SEC=60 \\',
    '  npm run validate:real -w @chord-ai/engine',
    '```',
    '',
    '## Synthesized results',
    '',
    '| Song | Artist | Ref key | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Detected key |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const r of synth) {
    lines.push(
      `| ${r.title} | ${r.artist} | ${r.refKey} | **${r.toneOverlapPct.toFixed(1)}** | ${r.toneJaccardPct.toFixed(1)} | ${r.toneRecallPct.toFixed(1)} | ${r.rootMatchPct.toFixed(1)} | ${r.exactPct.toFixed(1)} | ${r.majMinPct.toFixed(1)} | ${r.detectedKey} |`,
    );
  }
  lines.push(
    `| **Average** | | | **${avg(synth, 'toneOverlapPct').toFixed(1)}** | ${avg(synth, 'toneJaccardPct').toFixed(1)} | ${avg(synth, 'toneRecallPct').toFixed(1)} | ${avg(synth, 'rootMatchPct').toFixed(1)} | ${avg(synth, 'exactPct').toFixed(1)} | ${avg(synth, 'majMinPct').toFixed(1)} | |`,
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
      '| Song | Artist | Ref key | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Detected key | Notes |',
      '|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
    );
    for (const r of real) {
      lines.push(
        `| ${r.title} | ${r.artist} | ${r.refKey} | **${fmt(r.toneOverlapPct)}** | ${fmt(r.toneJaccardPct)} | ${fmt(r.toneRecallPct)} | ${fmt(r.rootMatchPct)} | ${fmt(r.exactPct)} | ${fmt(r.majMinPct)} | ${r.detectedKey} | ${r.note} |`,
      );
    }
    lines.push(
      `| **Average (full mix)** | | | **${avg(real, 'toneOverlapPct').toFixed(1)}** | ${avg(real, 'toneJaccardPct').toFixed(1)} | ${avg(real, 'toneRecallPct').toFixed(1)} | ${avg(real, 'rootMatchPct').toFixed(1)} | ${avg(real, 'exactPct').toFixed(1)} | ${avg(real, 'majMinPct').toFixed(1)} | | |`,
      '',
    );
  }

  lines.push('## Before / after UMX-HQ (first N seconds)', '');
  if (sep.length === 0) {
    lines.push(
      '_Separation not run. Set `CHORD_AI_SEPARATE=1` (and allow ~34 MiB UMX-HQ download)._',
      '',
    );
  } else {
    lines.push(
      `Compared on the **first ${sepMaxSec}s** of each file (UMX-HQ on CPU in the harness; browser uses WebGPU when available). Headline = **tone overlap %**.`,
      '',
      '| Song | Baseline tone % | +UMX-HQ tone % | Δ tone | Baseline exact / majmin | +UMX exact / majmin |',
      '|---|---:|---:|---:|---:|---:|',
    );
    for (const r of sep) {
      const baseTitle = r.title.replace(' (+UMX-HQ)', '');
      const base = real.find((x) => x.title === baseTitle);
      let baseTone = NaN;
      let baseExact = NaN;
      let baseMM = NaN;
      const m = base?.note.match(
        /first\d+s tone ([\d.]+)% \(J=[\d.]+ R=[\d.]+ root=[\d.]+\) exact ([\d.]+)% maj\/min ([\d.]+)%/,
      );
      if (m) {
        baseTone = Number(m[1]);
        baseExact = Number(m[2]);
        baseMM = Number(m[3]);
      }
      const delta =
        Number.isFinite(baseTone) && Number.isFinite(r.toneOverlapPct)
          ? (r.toneOverlapPct - baseTone).toFixed(1)
          : '—';
      const deltaSigned =
        delta === '—' ? '—' : `${Number(delta) >= 0 ? '+' : ''}${delta}`;
      lines.push(
        `| ${baseTitle} | ${fmt(baseTone)} | ${fmt(r.toneOverlapPct)} | ${deltaSigned} | ${fmt(baseExact)} / ${fmt(baseMM)} | ${fmt(r.exactPct)} / ${fmt(r.majMinPct)} |`,
      );
    }
    lines.push(
      '',
      '### Accuracy vs size',
      '',
      '| Path | Download | License | Notes |',
      '|---|---:|---|---|',
      '| 快速 (full mix) | 0 | — | Default UI mode |',
      '| UMX-HQ chroma | **~34 MiB** | MIT | Separation + chroma templates |',
      '| **精準 (UMX + Basic Pitch)** | **~34.2 MiB** | MIT + Apache-2.0 | Note-based chords; staff unchanged |',
      '',
    );
  }

  lines.push('## Fast vs precise (first N seconds)', '');
  if (precise.length === 0) {
    lines.push(
      '_Precise not run. Set `CHORD_AI_PRECISE=1` (default on when separation runs)._',
      '',
    );
  } else {
    lines.push(
      `Compared on the **first ${sepMaxSec}s** vs Ultimate Guitar–style references. **Tone % is the headline metric.**`,
      '',
      '| Song | Fast tone % | Precise tone % | Δ tone | Fast J / R / root | Precise J / R / root | Fast exact / majmin | Precise exact / majmin | Key (precise) |',
      '|---|---:|---:|---:|---|---|---|---|---|',
    );
    for (const r of precise) {
      const baseTitle = r.title.replace(' (+precise)', '');
      const base = real.find((x) => x.title === baseTitle);
      let baseTone = NaN;
      let baseJ = NaN;
      let baseR = NaN;
      let baseRoot = NaN;
      let baseExact = NaN;
      let baseMM = NaN;
      const m = base?.note.match(
        /first\d+s tone ([\d.]+)% \(J=([\d.]+) R=([\d.]+) root=([\d.]+)\) exact ([\d.]+)% maj\/min ([\d.]+)%/,
      );
      if (m) {
        baseTone = Number(m[1]);
        baseJ = Number(m[2]);
        baseR = Number(m[3]);
        baseRoot = Number(m[4]);
        baseExact = Number(m[5]);
        baseMM = Number(m[6]);
      }
      const delta =
        Number.isFinite(baseTone) && Number.isFinite(r.toneOverlapPct)
          ? (r.toneOverlapPct - baseTone).toFixed(1)
          : '—';
      const deltaSigned =
        delta === '—' ? '—' : `${Number(delta) >= 0 ? '+' : ''}${delta}`;
      lines.push(
        `| ${baseTitle} | ${fmt(baseTone)} | **${fmt(r.toneOverlapPct)}** | ${deltaSigned} | ${fmt(baseJ)} / ${fmt(baseR)} / ${fmt(baseRoot)} | ${fmt(r.toneJaccardPct)} / ${fmt(r.toneRecallPct)} / ${fmt(r.rootMatchPct)} | ${fmt(baseExact)} / ${fmt(baseMM)} | ${fmt(r.exactPct)} / ${fmt(r.majMinPct)} | ${r.detectedKey} |`,
      );
    }
    lines.push(
      '',
      `Average precise **tone overlap**: **${avg(precise, 'toneOverlapPct').toFixed(1)}%** (J=${avg(precise, 'toneJaccardPct').toFixed(1)}, R=${avg(precise, 'toneRecallPct').toFixed(1)}, root=${avg(precise, 'rootMatchPct').toFixed(1)}; exact ${avg(precise, 'exactPct').toFixed(1)} / majmin ${avg(precise, 'majMinPct').toFixed(1)}).`,
      '',
    );

    // Historical tuning + weak-bass before/after (frozen at 1f18a77)
    lines.push('### Before / after (tuning + weak-bass)');
    lines.push('');
    lines.push(
      'Fixes: rewritten `estimateTuningCents` (many frames, parabolic peak interpolation, energy-weighted circular mean, 1¢ resolution — Wonderwall first-60s ≈ **+7¢**, Hey Jude ≈ **−9¢**, was wrongly ~+45¢); weak-bass path uses lowest sustained `other` notes / low-band chroma blend, down-weights bass prior, stronger drone subtract, aug guard against neighbor-semitone flips; no slash when bass stem is weak.',
    );
    lines.push('');
    lines.push(
      'Fast-mode first-60s drops after the tuning fix are expected (chroma was previously warped); **precise Hey Jude must not regress** (headline path). Numbers frozen at commit `1f18a77`.',
    );
    lines.push('');
    lines.push('| Song | Mode | Before tone % | After tone % | Δ |');
    lines.push('|---|---|---:|---:|---:|');
    for (const title of Object.keys(BEFORE_TONE) as (keyof typeof BEFORE_TONE)[]) {
      const before = BEFORE_TONE[title];
      const after = AFTER_TUNING_TONE[title];
      lines.push(
        `| ${title} | Fast (first ${sepMaxSec}s) | ${before.fast.toFixed(1)} | ${after.fast.toFixed(1)} | ${after.fast - before.fast >= 0 ? '+' : ''}${(after.fast - before.fast).toFixed(1)} |`,
      );
      lines.push(`| ${title} | UMX-HQ chroma | — | ${after.umx.toFixed(1)} | — |`);
      lines.push(
        `| ${title} | Precise | ${before.precise.toFixed(1)} | **${after.precise.toFixed(1)}** | ${after.precise - before.precise >= 0 ? '+' : ''}${(after.precise - before.precise).toFixed(1)} |`,
      );
    }
    lines.push('');

    // Metric HMM / downbeat before/after (live precise vs 1f18a77)
    lines.push('### Before / after (NNLS chroma + metric HMM)');
    lines.push('');
    lines.push(
      'Training-free precise decode (Mauch & Dixon ISMIR 2010, independent MIT impl. — not GPL Chordino): NNLS approximate-note-transcription chroma (log-freq 3 bins/semitone, spectral std, harmonic dictionary) fused with Basic Pitch histograms; harmonic-novelty downbeat; metric Viterbi; drone/novelty-aware sus scoring; soft vocal residual subtract. Detailed dump: [`docs/precise-metric-report.md`](./precise-metric-report.md).',
    );
    lines.push('');
    lines.push('| Song | Before tone % | After tone % | Δ | Key | Downbeat phase | NNLS ms |');
    lines.push('|---|---:|---:|---:|---|---:|---:|');
    for (const r of precise) {
      const baseTitle = r.title.replace(' (+precise)', '') as keyof typeof BEFORE_METRIC_TONE;
      const before = BEFORE_METRIC_TONE[baseTitle];
      if (before === undefined) continue;
      const d = `${r.toneOverlapPct - before >= 0 ? '+' : ''}${(r.toneOverlapPct - before).toFixed(1)}`;
      const nnls = r.nnlsMs != null && Number.isFinite(r.nnlsMs) ? r.nnlsMs.toFixed(0) : '—';
      lines.push(
        `| ${baseTitle} | ${before.toFixed(1)} | **${fmt(r.toneOverlapPct)}** | ${d} | ${r.detectedKey} | ${r.downbeatPhase ?? '—'} | ${nnls} |`,
      );
    }
    lines.push('');

    // Wonderwall per-section
    const wwFast = real.find((x) => x.title === 'Wonderwall');
    const wwPrec = precise.find((x) => x.title.startsWith('Wonderwall'));
    if (wwFast?.sections?.length || wwPrec?.sections?.length) {
      lines.push('### Wonderwall per-section (first 60s, tone %)');
      lines.push('');
      lines.push('| Section | Fast tone % | Precise tone % | Fast J / R / root | Precise J / R / root |');
      lines.push('|---|---:|---:|---|---|');
      const names = ['intro(0–16s)', 'verse(16–45s)', 'late(45–60s)'];
      for (const name of names) {
        const f = wwFast?.sections?.find((s) => s.name === name);
        const p = wwPrec?.sections?.find((s) => s.name === name);
        lines.push(
          `| ${name} | ${f ? f.tonePct.toFixed(1) : '—'} | ${p ? `**${p.tonePct.toFixed(1)}**` : '—'} | ${f ? `${f.jaccardPct} / ${f.recallPct} / ${f.rootPct}` : '—'} | ${p ? `${p.jaccardPct} / ${p.recallPct} / ${p.rootPct}` : '—'} |`,
        );
      }
      lines.push('');
    }
  }

  lines.push(
    '## Limitations',
    '',
    '- Headline accuracy is **shared chord-tone overlap**, not name match — sus/relative confusions (e.g. F#m7↔A) score partially instead of zero.',
    '- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.',
    '- 精準模式 is opt-in (default 快速): ~34 MiB UMX + ~0.2 MiB Basic Pitch + longer runtime.',
    '- Separation / precise validation uses a time-capped clip so the harness finishes in CI-like environments.',
    '- Staff notation UI is unchanged (still chord-timeline ABC); precise mode does not generate staff from notes.',
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
