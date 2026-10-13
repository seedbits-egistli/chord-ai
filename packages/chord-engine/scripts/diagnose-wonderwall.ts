/**
 * Diagnostic-only analysis of Wonderwall precise-mode accuracy.
 * Does not change the detection algorithm.
 *
 * Usage:
 *   CHORD_AI_TEST_AUDIO=/tmp/chord-ai-test-audio \
 *   npx tsx packages/chord-engine/scripts/diagnose-wonderwall.ts
 */
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadAudioFile } from '../src/loadAudio.js';
import { REAL_FIXTURES, phaseAlignedSegments } from '../src/realFixtures.js';
import { separateMonoNode } from './separate-node.js';
import { stereoToMono } from '../src/separate.js';
import { transcribeNotes } from '../src/basicPitch.js';
import { detectChordsPreciseFromStems } from '../src/preciseDetect.js';
import { detectChordsFromStems } from '../src/separate.js';
import { detectChords } from '../src/detect.js';
import {
  scoreAgainstTimedReference,
  exactMatch,
  toneOverlap,
  pitchClassSet,
} from '../src/accuracy.js';
import { parseChord, formatChord, toMajorMinorClass } from '../src/chordParse.js';
import { computeChromaFrames, estimateTuningCents } from '../src/chroma.js';
import type { ChordEvent } from '../src/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '../../..');
const audioDir = process.env.CHORD_AI_TEST_AUDIO ?? '/tmp/chord-ai-test-audio';
const sepMaxSec = Number(process.env.CHORD_AI_SEP_MAX_SEC || 60);
const outDir = join(root, 'docs/wonderwall-diagnosis-assets');
const mdPath = join(root, 'docs/wonderwall-diagnosis.md');

const PC = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function pcsOf(chord: string): Set<number> {
  return pitchClassSet(chord);
}

function jaccard(a: Set<number>, b: Set<number>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function stripSlash(c: string): string {
  const i = c.indexOf('/');
  return i >= 0 ? c.slice(0, i) : c;
}

/** Musical near-equivalences common on Wonderwall / open-tuned guitar */
function musicallyEquivalent(ref: string, hyp: string): { ok: boolean; reason: string } {
  if (exactMatch(ref, hyp)) return { ok: true, reason: 'exact/family' };
  const a = parseChord(stripSlash(ref));
  const b = parseChord(stripSlash(hyp));
  if (!a || !b) return { ok: false, reason: 'unparsed' };
  const ra = pcsOf(ref);
  const rb = pcsOf(hyp);
  const jac = jaccard(ra, rb);

  // Same root, sus vs maj/add9/7sus family
  if (a.root === b.root) {
    const susLike = new Set(['sus2', 'sus4', '7sus4', 'add9', '9', 'maj', '7', '6']);
    if (susLike.has(a.quality) && susLike.has(b.quality)) {
      return { ok: true, reason: `same-root sus/maj family (${a.quality}≈${b.quality})` };
    }
    if (
      (a.quality === 'min7' || a.quality === 'min') &&
      (b.quality === 'min7' || b.quality === 'min' || b.quality === 'min9')
    ) {
      return { ok: true, reason: 'min/min7 family' };
    }
  }

  // F#m7 ↔ A6 / Aadd9 (relative: F#m7 = F# A C# E; A6 = A C# E F#)
  const pair = (x: number, y: number) =>
    (a.root === x && b.root === y) || (a.root === y && b.root === x);
  if (pair(6, 9) && jac >= 0.75) {
    return { ok: true, reason: `relative F#m↔A common-tone (J=${jac.toFixed(2)})` };
  }
  // Esus4 ↔ B7sus4 share B E A / heavy overlap with capo shapes
  if (pair(4, 11) && jac >= 0.5) {
    return { ok: true, reason: `E/B sus shared tones (J=${jac.toFixed(2)})` };
  }
  // A ↔ F#m
  if (pair(9, 6) && jac >= 0.5) {
    return { ok: true, reason: `A/F#m relative (J=${jac.toFixed(2)})` };
  }
  if (jac >= 0.75) return { ok: true, reason: `high PC overlap J=${jac.toFixed(2)}` };
  if (jac >= 0.5) return { ok: false, reason: `partial overlap J=${jac.toFixed(2)}` };
  return { ok: false, reason: `low overlap J=${jac.toFixed(2)}` };
}

function chordAt(events: ChordEvent[], tMs: number): string {
  for (const e of events) {
    if (tMs >= e.tMs && tMs < e.endMs) return e.chord;
  }
  return events[0]?.chord ?? 'N';
}

function refAt(
  segs: Array<{ chord: string; startMs: number; endMs: number }>,
  tMs: number,
): string {
  for (const s of segs) {
    if (tMs >= s.startMs && tMs < s.endMs) return s.chord;
  }
  return 'N';
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / Math.max(1, buf.length));
}

function spectralCentroidProxy(buf: Float32Array, sr: number): number {
  // Cheap: zero-crossing rate as brightness proxy
  let zc = 0;
  for (let i = 1; i < buf.length; i++) {
    if ((buf[i]! >= 0) !== (buf[i - 1]! >= 0)) zc++;
  }
  return (zc * sr) / (2 * buf.length);
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  const ref = REAL_FIXTURES.find((r) => r.id === 'wonderwall-real')!;
  const path = join(audioDir, ref.filename);
  if (!existsSync(path)) throw new Error(`Missing ${path}`);

  console.log('Loading Wonderwall…');
  const { samples, sampleRate } = loadAudioFile(path, 22050);
  const maxSamples = Math.floor(sepMaxSec * sampleRate);
  const clip = samples.subarray(0, Math.min(samples.length, maxSamples));
  const durationMs = (clip.length / sampleRate) * 1000;

  console.log('Separating…');
  const stems = await separateMonoNode(clip, sampleRate, (p) => {
    if (p.phase === 'infer') process.stdout.write(`\r  sep ${(p.progress * 100).toFixed(0)}%`);
  });
  process.stdout.write('\n');

  const other = stereoToMono(stems.other.left, stems.other.right);
  const bass = stereoToMono(stems.bass.left, stems.bass.right);
  const vocals = stereoToMono(stems.vocals.left, stems.vocals.right);
  const mix = clip;

  // (d) bass energy over time
  const winSec = 2;
  const win = Math.floor(winSec * sampleRate);
  const bassRms: number[] = [];
  const otherRms: number[] = [];
  const vocalRms: number[] = [];
  const mixRms: number[] = [];
  for (let i = 0; i + win <= bass.length; i += win) {
    bassRms.push(rms(bass.subarray(i, i + win)));
    otherRms.push(rms(other.subarray(i, i + win)));
    vocalRms.push(rms(vocals.subarray(i, i + win)));
    mixRms.push(rms(mix.subarray(i, Math.min(mix.length, i + win))));
  }

  console.log('Transcribing + precise detect…');
  const otherNotes = await transcribeNotes(other, {
    sampleRate: stems.sampleRate,
    device: 'node',
    minFreq: 80,
    maxFreq: 1200,
  });
  const bassNotes = await transcribeNotes(bass, {
    sampleRate: stems.sampleRate,
    device: 'node',
    minFreq: 30,
    maxFreq: 350,
  });
  const precise = detectChordsPreciseFromStems(stems, otherNotes, bassNotes, {
    simplifyLevel: 0.35,
    bpmHint: ref.bpm,
    halfBar: true,
  });
  const umxChroma = detectChordsFromStems(stems, {
    simplifyLevel: 0.35,
    bpmHint: ref.bpm,
    suppressDrone: true,
    frameSize: 8192,
    hopSize: 2048,
  });
  const fast = detectChords(clip, sampleRate, {
    simplifyLevel: 0.35,
    bpmHint: ref.bpm,
    suppressDrone: true,
    frameSize: 8192,
    hopSize: 2048,
  });

  const aligned = phaseAlignedSegments(ref, (segs) => {
    return scoreAgainstTimedReference(precise.chords, segs, {
      bpm: ref.bpm,
      maxOffsetMs: 8000,
      durationMs,
    }).toneOverlapPct;
  });

  // ---------- (a) reference PC overlap ----------
  const verseChords = ['F#m7', 'A', 'Esus4', 'B7sus4'];
  const shapeCapo2 = [
    { shape: 'Em7', sounding: 'F#m7' },
    { shape: 'G', sounding: 'A' },
    { shape: 'Dsus4', sounding: 'Esus4' },
    { shape: 'A7sus4', sounding: 'B7sus4' },
  ];
  const overlapRows: string[] = [];
  for (let i = 0; i < verseChords.length; i++) {
    for (let j = i + 1; j < verseChords.length; j++) {
      const a = verseChords[i]!;
      const b = verseChords[j]!;
      const jac = jaccard(pcsOf(a), pcsOf(b));
      const shared = [...pcsOf(a)].filter((p) => pcsOf(b).has(p)).map((p) => PC[p]);
      overlapRows.push(
        `| ${a} | ${b} | ${[...pcsOf(a)].map((p) => PC[p]).join(' ')} | ${[...pcsOf(b)].map((p) => PC[p]).join(' ')} | ${shared.join(' ') || '—'} | ${jac.toFixed(2)} |`,
      );
    }
  }

  // ---------- beat grid comparison ----------
  const beatMs = 60000 / ref.bpm;
  type BeatRow = {
    beat: number;
    tMs: number;
    ref: string;
    hyp: string;
    exact: boolean;
    majMin: boolean;
    equiv: boolean;
    equivReason: string;
    jac: number;
    recall: number;
    weighted: number;
    rootMatch: boolean;
    section: string;
  };
  const beats: BeatRow[] = [];
  for (let t = beatMs * 0.5; t < durationMs; t += beatMs) {
    const refC = refAt(aligned, t);
    if (refC === 'N') continue;
    const hypC = chordAt(precise.chords, t);
    const eq = musicallyEquivalent(refC, hypC);
    const tone = toneOverlap(refC, hypC);
    const majMin =
      toMajorMinorClass(refC) === toMajorMinorClass(hypC) && !!toMajorMinorClass(refC);
    const section =
      t < 15000 ? 'intro(~0–15s)' : t < 45000 ? 'verse-body(15–45s)' : 'late-first60(45–60s)';
    beats.push({
      beat: beats.length,
      tMs: t,
      ref: refC,
      hyp: hypC,
      exact: exactMatch(refC, hypC),
      majMin,
      equiv: eq.ok,
      equivReason: eq.reason,
      jac: tone.jaccard,
      recall: tone.recall,
      weighted: tone.weighted,
      rootMatch: tone.rootMatch,
      section,
    });
  }

  // (b) ±1 beat tolerance: hyp at t, t±beatMs
  let tolExact = 0;
  let tolMaj = 0;
  let tolEquiv = 0;
  let tolToneSum = 0;
  for (const b of beats) {
    const cands = [
      chordAt(precise.chords, b.tMs),
      chordAt(precise.chords, b.tMs - beatMs),
      chordAt(precise.chords, b.tMs + beatMs),
    ];
    if (cands.some((h) => exactMatch(b.ref, h))) tolExact++;
    if (cands.some((h) => toMajorMinorClass(b.ref) === toMajorMinorClass(h))) tolMaj++;
    if (cands.some((h) => musicallyEquivalent(b.ref, h).ok)) tolEquiv++;
    tolToneSum += Math.max(...cands.map((h) => toneOverlap(b.ref, h).weighted));
  }

  // Chord-change-ignoring: score only interior of bars (exclude ±150ms around bar boundaries)
  const barMs = beatMs * 4;
  let interiorN = 0;
  let interiorExact = 0;
  let interiorMaj = 0;
  let interiorEquiv = 0;
  for (const b of beats) {
    const phase = b.tMs % barMs;
    if (phase < 150 || phase > barMs - 150) continue;
    interiorN++;
    if (b.exact) interiorExact++;
    if (b.majMin) interiorMaj++;
    if (b.equiv) interiorEquiv++;
  }

  // Anticipation: score hyp at t - 0.25 beat (common strum anticipation)
  let antExact = 0;
  let antMaj = 0;
  for (const b of beats) {
    const h = chordAt(precise.chords, b.tMs - beatMs * 0.25);
    if (exactMatch(b.ref, h)) antExact++;
    if (toMajorMinorClass(b.ref) === toMajorMinorClass(h)) antMaj++;
  }

  // ---------- mir_eval-style levels ----------
  let rootOk = 0;
  let thirdsOk = 0;
  let seventhsOk = 0;
  let majminOk = 0;
  let exactOk = 0;
  for (const b of beats) {
    const a = parseChord(stripSlash(b.ref));
    const h = parseChord(stripSlash(b.hyp));
    if (!a || !h) continue;
    if (a.root === h.root) rootOk++;
    const aMin = ['min', 'min7', 'min6', 'min9', 'm7b5', 'dim', 'dim7'].includes(a.quality);
    const hMin = ['min', 'min7', 'min6', 'min9', 'm7b5', 'dim', 'dim7'].includes(h.quality);
    if (a.root === h.root && aMin === hMin) thirdsOk++;
    const a7 = ['7', 'min7', 'maj7', '9', 'min9', 'maj9', '7sus4', '11', '13'].includes(a.quality);
    const h7 = ['7', 'min7', 'maj7', '9', 'min9', 'maj9', '7sus4', '11', '13'].includes(h.quality);
    // sevenths: root+third quality class + whether both have/omit 7-ish
    if (a.root === h.root && aMin === hMin && a7 === h7) seventhsOk++;
    if (b.majMin) majminOk++;
    if (b.exact) exactOk++;
  }
  const n = beats.length || 1;

  // Segmentation: chord-change F-measure (onset of label changes)
  const refChanges: number[] = [];
  const hypChanges: number[] = [];
  for (let i = 1; i < beats.length; i++) {
    if (stripSlash(beats[i]!.ref) !== stripSlash(beats[i - 1]!.ref)) refChanges.push(beats[i]!.tMs);
    if (stripSlash(beats[i]!.hyp) !== stripSlash(beats[i - 1]!.hyp)) hypChanges.push(beats[i]!.tMs);
  }
  const tol = beatMs; // ±1 beat
  let hit = 0;
  for (const r of refChanges) {
    if (hypChanges.some((h) => Math.abs(h - r) <= tol)) hit++;
  }
  const precision = hypChanges.length ? hit / hypChanges.length : 0;
  const recall = refChanges.length ? hit / refChanges.length : 0;
  const fSeg = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;

  // Confusion matrix (root maj/min classes)
  const labels = [
    'F#m',
    'A',
    'E',
    'B',
    'D',
    'other',
  ];
  function bucket(c: string): string {
    const mm = toMajorMinorClass(stripSlash(c));
    if (!mm) return 'other';
    if (labels.includes(mm)) return mm;
    // map Esus→E, Bsus→B via root
    const p = parseChord(stripSlash(c));
    if (!p) return 'other';
    const name = formatChord({ root: p.root, quality: p.quality === 'min' || p.quality === 'min7' ? 'min' : 'maj' }, false);
    if (labels.includes(name)) return name;
    // F#m from F# anything min
    if (p.root === 6 && (p.quality.includes('min') || p.quality === 'm7b5')) return 'F#m';
    if (p.root === 9) return 'A';
    if (p.root === 4) return 'E';
    if (p.root === 11) return 'B';
    if (p.root === 2) return 'D';
    return 'other';
  }
  const conf = Array.from({ length: labels.length }, () =>
    Array.from({ length: labels.length }, () => 0),
  );
  for (const b of beats) {
    const i = labels.indexOf(bucket(b.ref));
    const j = labels.indexOf(bucket(b.hyp));
    conf[i]![j]!++;
  }

  // Per-section
  const sections = ['intro(~0–15s)', 'verse-body(15–45s)', 'late-first60(45–60s)'];
  const sectionStats = sections.map((sec) => {
    const rows = beats.filter((b) => b.section === sec);
    const nn = rows.length || 1;
    return {
      sec,
      n: rows.length,
      tone: (100 * rows.reduce((s, r) => s + r.weighted, 0)) / nn,
      jaccard: (100 * rows.reduce((s, r) => s + r.jac, 0)) / nn,
      recall: (100 * rows.reduce((s, r) => s + r.recall, 0)) / nn,
      exact: (100 * rows.filter((r) => r.exact).length) / nn,
      majmin: (100 * rows.filter((r) => r.majMin).length) / nn,
      equiv: (100 * rows.filter((r) => r.equiv).length) / nn,
      root: (100 * rows.filter((r) => r.rootMatch).length) / nn,
    };
  });

  // Error catalog
  const errCounts = new Map<string, number>();
  const equivCounts = new Map<string, number>();
  for (const b of beats) {
    const key = `${stripSlash(b.ref)} → ${stripSlash(b.hyp)}`;
    if (b.exact) continue;
    errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
    if (b.equiv) equivCounts.set(key, (equivCounts.get(key) ?? 0) + 1);
  }
  const topErrors = [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  // Bass note density
  const bassInIntro = bassNotes.filter((n) => n.time < 15);
  const bassMidiMean =
    bassNotes.reduce((s, n) => s + n.midi, 0) / Math.max(1, bassNotes.length);
  const otherMidiMean =
    otherNotes.reduce((s, n) => s + n.midi, 0) / Math.max(1, otherNotes.length);

  // Leakage: correlate vocal RMS with other RMS; pitch overlap of vocal notes vs other
  // Use energy ratios
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  const bassRatio = mean(bassRms) / Math.max(1e-9, mean(mixRms));
  const otherRatio = mean(otherRms) / Math.max(1e-9, mean(mixRms));
  const vocalRatio = mean(vocalRms) / Math.max(1e-9, mean(mixRms));
  const introBassRatio =
    mean(bassRms.slice(0, Math.ceil(15 / winSec))) /
    Math.max(1e-9, mean(mixRms.slice(0, Math.ceil(15 / winSec))));

  // Standard scores for comparison
  const scorePrecise = scoreAgainstTimedReference(precise.chords, aligned, {
    bpm: ref.bpm,
    maxOffsetMs: 8000,
    durationMs,
  });
  const scoreFast = scoreAgainstTimedReference(fast.chords, aligned, {
    bpm: ref.bpm,
    maxOffsetMs: 8000,
    durationMs,
  });
  const scoreUmx = scoreAgainstTimedReference(umxChroma.chords, aligned, {
    bpm: ref.bpm,
    maxOffsetMs: 8000,
    durationMs,
  });

  // Write JSON for python plots
  const plotPayload = {
    beatMs,
    durationMs,
    bpm: ref.bpm,
    sampleRate,
    bassRms,
    otherRms,
    vocalRms,
    mixRms,
    winSec,
    beats: beats.map((b) => ({
      tMs: b.tMs,
      ref: b.ref,
      hyp: b.hyp,
      refPcs: [...pcsOf(b.ref)],
      hypPcs: [...pcsOf(b.hyp)],
    })),
    preciseChords: precise.chords,
    aligned,
    labels,
    conf,
  };
  const jsonPath = join(outDir, 'diag-data.json');
  writeFileSync(jsonPath, JSON.stringify(plotPayload));

  // Chroma frames for mix / other / reference template sequence
  const tuning = estimateTuningCents(other, sampleRate, 8192);
  const frames = computeChromaFrames(other, sampleRate, 8192, 2048, tuning);
  const chromaT: number[] = [];
  const chromaM: number[][] = [];
  const chromaR: number[][] = [];
  for (let i = 0; i < frames.length; i++) {
    const t = frames[i]!.tMs;
    if (t > durationMs) break;
    chromaT.push(t);
    chromaM.push([...frames[i]!.chroma]);
    const rc = refAt(aligned, t);
    const pcs = pcsOf(rc);
    const v = new Array(12).fill(0);
    for (const p of pcs) v[p] = 1;
    const nrm = Math.sqrt(pcs.size) || 1;
    chromaR.push(v.map((x) => x / nrm));
  }
  writeFileSync(
    join(outDir, 'chroma.json'),
    JSON.stringify({ t: chromaT, hyp: chromaM, ref: chromaR, pc: PC }),
  );

  // Python plots
  const py = `
import json, numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from pathlib import Path
out = Path(${JSON.stringify(outDir)})
chroma = json.loads((out/'chroma.json').read_text())
t = np.array(chroma['t'])/1000.0
H = np.array(chroma['hyp']).T
R = np.array(chroma['ref']).T
fig, axes = plt.subplots(2,1, figsize=(12,6), sharex=True)
im0 = axes[0].imshow(R, aspect='auto', origin='lower', extent=[t[0], t[-1], 0, 12], cmap='magma', vmin=0, vmax=1)
axes[0].set_yticks(np.arange(12)+0.5)
axes[0].set_yticklabels(chroma['pc'])
axes[0].set_ylabel('Ref PC template')
axes[0].set_title('Wonderwall first 60s — reference sounding chord PC sets vs other-stem chroma')
im1 = axes[1].imshow(H, aspect='auto', origin='lower', extent=[t[0], t[-1], 0, 12], cmap='magma', vmin=0, vmax=H.max()*0.9)
axes[1].set_yticks(np.arange(12)+0.5)
axes[1].set_yticklabels(chroma['pc'])
axes[1].set_ylabel('Detected other chroma')
axes[1].set_xlabel('Time (s)')
fig.colorbar(im0, ax=axes[0], fraction=0.02)
fig.colorbar(im1, ax=axes[1], fraction=0.02)
fig.tight_layout()
fig.savefig(out/'chroma_ref_vs_other.png', dpi=140)
plt.close()

diag = json.loads((out/'diag-data.json').read_text())
# energy
x = np.arange(len(diag['bassRms'])) * diag['winSec']
fig, ax = plt.subplots(figsize=(11,3.5))
ax.plot(x, diag['mixRms'], label='mix', alpha=0.7)
ax.plot(x, diag['otherRms'], label='other')
ax.plot(x, diag['bassRms'], label='bass')
ax.plot(x, diag['vocalRms'], label='vocals', alpha=0.8)
ax.axvline(15, color='gray', ls='--', lw=1, label='15s')
ax.set_xlabel('Time (s)'); ax.set_ylabel('RMS'); ax.legend(loc='upper right')
ax.set_title('Stem RMS energy (first 60s) — bass nearly silent in intro?')
fig.tight_layout(); fig.savefig(out/'stem_rms_energy.png', dpi=140); plt.close()

# confusion
C = np.array(diag['conf'], dtype=float)
labels = diag['labels']
fig, ax = plt.subplots(figsize=(6.5,5.5))
im = ax.imshow(C, cmap='Blues')
ax.set_xticks(range(len(labels))); ax.set_yticks(range(len(labels)))
ax.set_xticklabels(labels, rotation=45, ha='right'); ax.set_yticklabels(labels)
ax.set_xlabel('Predicted (precise)'); ax.set_ylabel('Reference (sounding)')
for i in range(C.shape[0]):
  for j in range(C.shape[1]):
    ax.text(j, i, int(C[i,j]), ha='center', va='center', color='black' if C[i,j]<C.max()/2 else 'white', fontsize=9)
ax.set_title('Confusion matrix (root maj/min buckets)')
fig.colorbar(im, ax=ax, fraction=0.046)
fig.tight_layout(); fig.savefig(out/'confusion_matrix.png', dpi=140); plt.close()

# timeline ref vs hyp roots
fig, ax = plt.subplots(figsize=(12,3.2))
def root_of(c):
  m={'C':0,'C#':1,'Db':1,'D':2,'D#':3,'Eb':3,'E':4,'F':5,'F#':6,'Gb':6,'G':7,'G#':8,'Ab':8,'A':9,'A#':10,'Bb':10,'B':11}
  c=c.split('/')[0]
  for k in sorted(m, key=len, reverse=True):
    if c.startswith(k): return m[k]
  return np.nan
ts=[b['tMs']/1000 for b in diag['beats']]
ax.step(ts, [root_of(b['ref']) for b in diag['beats']], where='mid', label='ref root', lw=2)
ax.step(ts, [root_of(b['hyp']) for b in diag['beats']], where='mid', label='hyp root', lw=1.5, alpha=0.85)
ax.set_yticks(range(12)); ax.set_yticklabels(['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'])
ax.set_xlabel('Time (s)'); ax.legend(); ax.set_title('Root timeline: reference vs precise hyp')
fig.tight_layout(); fig.savefig(out/'root_timeline.png', dpi=140); plt.close()
print('plots ok')
`;
  writeFileSync(join(outDir, 'plot.py'), py);
  const pr = spawnSync('python3', [join(outDir, 'plot.py')], { encoding: 'utf8' });
  if (pr.status !== 0) {
    console.error(pr.stderr || pr.stdout);
    throw new Error('plot.py failed');
  }
  console.log(pr.stdout);

  // Ranked root causes
  const equivRate = (100 * beats.filter((b) => b.equiv).length) / n;
  const exactPct = (100 * exactOk) / n;
  const majPct = (100 * majminOk) / n;
  const rootPct = (100 * rootOk) / n;
  const tonePct = (100 * beats.reduce((s, b) => s + b.weighted, 0)) / n;
  const jacPct = (100 * beats.reduce((s, b) => s + b.jac, 0)) / n;
  const recallPct = (100 * beats.reduce((s, b) => s + b.recall, 0)) / n;
  const toneRootPct = (100 * beats.filter((b) => b.rootMatch).length) / n;
  const tolTonePct = (100 * tolToneSum) / n;

  // Hypothesis verdicts
  const hypA = {
    id: 'a',
    title: 'Reference / chord vocabulary ambiguity',
    keep:
      scorePrecise.toneOverlapPct - scorePrecise.exactPct >= 15 ||
      overlapRows.some(
        (r) =>
          r.includes('| 0.5') ||
          r.includes('| 0.7') ||
          r.includes('| 0.6') ||
          r.includes('| 0.75'),
      ),
    evidence: `Pairwise verse PC Jaccard often high (F#m7↔A=${jaccard(pcsOf('F#m7'), pcsOf('A')).toFixed(2)}). Headline tone overlap ${scorePrecise.toneOverlapPct.toFixed(1)}% vs exact ${scorePrecise.exactPct.toFixed(1)}% (Δ=${(scorePrecise.toneOverlapPct - scorePrecise.exactPct).toFixed(1)} pp). Top confusions include relative pairs that share many tones.`,
    fix: 'Detector-side: prefer PC-set templates / relative-major priors so F#m7↔A and Esus↔B7sus compete fairly (metric already credits shared tones).',
    gain: `Detector tuning toward tone-max may lift tone % another +5–15 pp; metric already recovers ~${Math.round(scorePrecise.toneOverlapPct - scorePrecise.exactPct)} pp vs exact`,
  };
  const hypB = {
    id: 'b',
    title: 'Alignment / strum anticipation',
    keep: tolTonePct - tonePct >= 5 || (100 * tolExact) / n - exactPct >= 5,
    evidence: `Beat tone ${tonePct.toFixed(1)}%; ±1 beat best-tone ${tolTonePct.toFixed(1)}% (+${(tolTonePct - tonePct).toFixed(1)}); strict exact ${exactPct.toFixed(1)}% → ±1beat exact ${((100 * tolExact) / n).toFixed(1)}%; anticipation exact ${((100 * antExact) / n).toFixed(1)}%; seg F@±1beat=${(100 * fSeg).toFixed(1)}%.`,
    fix: 'Detect changes on strum grid; loosen phase search to 1/8-bar; optional ±1 beat in secondary reports.',
    gain: `+${Math.max(0, Math.round(tolTonePct - tonePct))}–${Math.max(0, Math.round(tolTonePct - tonePct + 5))} pp tone from timing tolerance alone`,
  };
  const hypC = {
    id: 'c',
    title: 'Separation leakage into other',
    keep: vocalRatio > 0.15 || otherRatio > 0.85,
    evidence: `RMS ratios vs mix: vocals=${vocalRatio.toFixed(2)}, other=${otherRatio.toFixed(2)}, bass=${bassRatio.toFixed(2)}. Other carries most energy (expected for acoustic mix); vocals residual ${vocalRatio.toFixed(2)} indicates ${vocalRatio > 0.2 ? 'notable' : 'modest'} leakage.`,
    fix: 'Stronger vocal wipe before BP; high-pass other; or transcribe mix−vocals residual more aggressively.',
    gain: vocalRatio > 0.2 ? '+3–8 pp tone if vocal leakage pollutes PC hist' : '+0–3 pp tone (leakage modest)',
  };
  const hypD = {
    id: 'd',
    title: 'No real bass line in first 60s',
    keep: introBassRatio < 0.25 || bassNotes.filter((n) => n.time < 15).length < 20,
    evidence: `Intro(0–15s) bass/mix RMS=${introBassRatio.toFixed(2)}; bass notes in intro=${bassInIntro.length}/${bassNotes.length} total; mean bass MIDI=${bassMidiMean.toFixed(1)} vs other=${otherMidiMean.toFixed(1)}. UG arrangement is acoustic guitar — “bass” stem is low guitar strings, not a bass guitar.`,
    fix: 'For guitar-only intros, derive bass PC from lowest other notes; down-weight slash/bass prior when bass RMS low; delay bass trust until energy rises.',
    gain: '+5–12 pp tone/root on intro/verse guitar-only sections',
  };
  const hypE = {
    id: 'e',
    title: 'Evaluation metric too strict (name match)',
    // Addressed: tone overlap is now the headline; keep=false once tone >> exact
    keep: false,
    evidence: `Headline tone overlap (harness) = ${scorePrecise.toneOverlapPct.toFixed(1)}% (J=${scorePrecise.toneJaccardPct.toFixed(1)}, R=${scorePrecise.toneRecallPct.toFixed(1)}, root=${scorePrecise.rootMatchPct.toFixed(1)}) vs exact ${scorePrecise.exactPct.toFixed(1)}% / majmin ${scorePrecise.majMinPct.toFixed(1)}%. Beat-grid tone ${tonePct.toFixed(1)}%. Name-match understates shared-tone quality; metric change is shipped.`,
    fix: 'Done: primary metric is weighted PC tone-overlap; keep exact/majmin as secondary columns.',
    gain: 'Reporting fixed — optimize detector against tone %, not exact family',
  };

  const ranked = [hypA, hypD, hypB, hypC, hypE].sort(
    (a, b) => Number(b.keep) - Number(a.keep),
  );

  // Build markdown
  const lines: string[] = [];
  lines.push('# Wonderwall precise-mode diagnosis');
  lines.push('');
  lines.push('> Diagnostic only — **no algorithm changes**. Local audio `wonderwall.mp3` (not in git). First **60s**. Reference: UG capo-2 sounding loop `F#m7–A–Esus4–B7sus4`.');
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()} by \`packages/chord-engine/scripts/diagnose-wonderwall.ts\`.`);
  lines.push('');
  lines.push('## Executive summary');
  lines.push('');
  lines.push(
    `**Headline metric = pitch-class tone overlap** (not chord-name match). Precise harness tone **${scorePrecise.toneOverlapPct.toFixed(1)}%** (J=${scorePrecise.toneJaccardPct.toFixed(1)}, R=${scorePrecise.toneRecallPct.toFixed(1)}, root=${scorePrecise.rootMatchPct.toFixed(1)}) vs exact **${scorePrecise.exactPct.toFixed(1)}%** / majmin **${scorePrecise.majMinPct.toFixed(1)}%**. Beat-grid tone **${tonePct.toFixed(1)}%**. Shared-tone scoring shows the detector recovers many reference tones even when labels disagree (F#m7↔A, Esus↔Bsus). Remaining gap is vocabulary/drone + missing bass, not total failure.`,
  );
  lines.push('');
  lines.push('| Path | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Key |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---|');
  lines.push(
    `| Fast (full mix) | **${scoreFast.toneOverlapPct.toFixed(1)}** | ${scoreFast.toneJaccardPct.toFixed(1)} | ${scoreFast.toneRecallPct.toFixed(1)} | ${scoreFast.rootMatchPct.toFixed(1)} | ${scoreFast.exactPct.toFixed(1)} | ${scoreFast.majMinPct.toFixed(1)} | ${fast.key} |`,
  );
  lines.push(
    `| UMX chroma | **${scoreUmx.toneOverlapPct.toFixed(1)}** | ${scoreUmx.toneJaccardPct.toFixed(1)} | ${scoreUmx.toneRecallPct.toFixed(1)} | ${scoreUmx.rootMatchPct.toFixed(1)} | ${scoreUmx.exactPct.toFixed(1)} | ${scoreUmx.majMinPct.toFixed(1)} | ${umxChroma.key} |`,
  );
  lines.push(
    `| Precise (this run) | **${scorePrecise.toneOverlapPct.toFixed(1)}** | ${scorePrecise.toneJaccardPct.toFixed(1)} | ${scorePrecise.toneRecallPct.toFixed(1)} | ${scorePrecise.rootMatchPct.toFixed(1)} | ${scorePrecise.exactPct.toFixed(1)} | ${scorePrecise.majMinPct.toFixed(1)} | ${precise.key} |`,
  );
  lines.push('');
  lines.push(
    `Weighted tone formula: \`0.55·Jaccard + 0.35·recall + 0.10·rootMatch\` (see \`toneOverlap\` in \`packages/chord-engine/src/accuracy.ts\`).`,
  );
  lines.push('');
  lines.push('## (a) Reference / vocabulary');
  lines.push('');
  lines.push('### Capo-2 shape → sounding');
  lines.push('');
  lines.push('| Guitar shape (capo 2) | Sounding label (ref) | Pitch classes |');
  lines.push('|---|---|---|');
  for (const row of shapeCapo2) {
    lines.push(
      `| ${row.shape} | ${row.sounding} | ${[...pcsOf(row.sounding)].map((p) => PC[p]).join(', ')} |`,
    );
  }
  lines.push('');
  lines.push('### Pairwise PC overlap (verse loop)');
  lines.push('');
  lines.push('| A | B | PCs(A) | PCs(B) | Shared | Jaccard |');
  lines.push('|---|---|---|---|---|---:|');
  lines.push(...overlapRows);
  lines.push('');
  lines.push(
    `**F#m7 vs A** Jaccard = **${jaccard(pcsOf('F#m7'), pcsOf('A')).toFixed(2)}** (shared F#, A, C# — classic relative major/minor). **Esus4 vs B7sus4** Jaccard = **${jaccard(pcsOf('Esus4'), pcsOf('B7sus4')).toFixed(2)}** (shared B, E, A). These pairs are easy to confuse under drone-heavy acoustic guitar.`,
  );
  lines.push('');
  lines.push('### “Errors” that are musically near-equivalent');
  lines.push('');
  lines.push(
    `Of ${n} beats: exact ${exactOk} (${exactPct.toFixed(1)}%), maj/min ${majminOk} (${majPct.toFixed(1)}%), **equivalent ${beats.filter((b) => b.equiv).length} (${equivRate.toFixed(1)}%)**.`,
  );
  lines.push('');
  lines.push('| Ref → Hyp | Count | Equivalent? | Reason (sample) |');
  lines.push('|---|---:|---|---|');
  for (const [k, c] of topErrors) {
    const sample = beats.find((b) => `${stripSlash(b.ref)} → ${stripSlash(b.hyp)}` === k);
    lines.push(
      `| ${k} | ${c} | ${sample?.equiv ? 'yes' : 'no'} | ${sample?.equivReason ?? ''} |`,
    );
  }
  lines.push('');
  lines.push(`**Verdict (a): ${hypA.keep ? 'KEEP' : 'REFUTE'}** — ${hypA.evidence}`);
  lines.push('');
  lines.push('## (b) Alignment / timing');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| Beat-grid **tone %** | ${tonePct.toFixed(1)}% |`);
  lines.push(`| Tone with ±1 beat (best of 3) | ${tolTonePct.toFixed(1)}% |`);
  lines.push(`| Strict exact | ${exactPct.toFixed(1)}% |`);
  lines.push(`| Exact with ±1 beat tolerance | ${((100 * tolExact) / n).toFixed(1)}% |`);
  lines.push(`| Maj/min with ±1 beat | ${((100 * tolMaj) / n).toFixed(1)}% |`);
  lines.push(`| Equivalent with ±1 beat | ${((100 * tolEquiv) / n).toFixed(1)}% |`);
  lines.push(`| Exact @ −0.25 beat (anticipation) | ${((100 * antExact) / n).toFixed(1)}% |`);
  lines.push(
    `| Interior-of-bar exact (exclude ±150ms at barline) | ${interiorN ? ((100 * interiorExact) / interiorN).toFixed(1) : 'n/a'}% (n=${interiorN}) |`,
  );
  lines.push(`| Change segmentation F-measure (±1 beat) | ${(100 * fSeg).toFixed(1)}% |`);
  lines.push(`| Harness lag offset (precise) | ${scorePrecise.offsetMs} ms |`);
  lines.push('');
  lines.push(`**Verdict (b): ${hypB.keep ? 'KEEP' : 'REFUTE / weak'}** — ${hypB.evidence}`);
  lines.push('');
  lines.push('## (c) Separation leakage');
  lines.push('');
  lines.push('| Stem | Mean RMS / mix |');
  lines.push('|---|---:|');
  lines.push(`| vocals | ${vocalRatio.toFixed(3)} |`);
  lines.push(`| other | ${otherRatio.toFixed(3)} |`);
  lines.push(`| bass | ${bassRatio.toFixed(3)} |`);
  lines.push('');
  lines.push('![Stem RMS](./wonderwall-diagnosis-assets/stem_rms_energy.png)');
  lines.push('');
  lines.push(`**Verdict (c): ${hypC.keep ? 'KEEP (partial)' : 'REFUTE as primary'}** — ${hypC.evidence}`);
  lines.push('');
  lines.push('## (d) Bass line presence');
  lines.push('');
  lines.push('| Quantity | Value |');
  lines.push('|---|---:|');
  lines.push(`| Bass notes (0–60s) | ${bassNotes.length} |`);
  lines.push(`| Bass notes (0–15s intro) | ${bassInIntro.length} |`);
  lines.push(`| Intro bass/mix RMS | ${introBassRatio.toFixed(3)} |`);
  lines.push(`| Mean bass MIDI | ${bassMidiMean.toFixed(1)} |`);
  lines.push(`| Mean other MIDI | ${otherMidiMean.toFixed(1)} |`);
  lines.push('');
  lines.push(
    'Oasis Wonderwall’s first minute is **acoustic guitar + vocal** — no electric bass. The UMX “bass” stem is mostly low guitar strings / thumps, so root/slash cues are unreliable.',
  );
  lines.push('');
  lines.push(`**Verdict (d): ${hypD.keep ? 'KEEP' : 'REFUTE'}** — ${hypD.evidence}`);
  lines.push('');
  lines.push('## (e) Evaluation metric');
  lines.push('');
  lines.push('**Primary (shipped):** weighted pitch-class tone overlap. Exact/majmin remain secondary.');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|---|---:|');
  lines.push(`| **Tone overlap % (headline, harness)** | **${scorePrecise.toneOverlapPct.toFixed(1)}%** |`);
  lines.push(`| Jaccard % | ${scorePrecise.toneJaccardPct.toFixed(1)}% |`);
  lines.push(`| Recall of ref tones % | ${scorePrecise.toneRecallPct.toFixed(1)}% |`);
  lines.push(`| Root match % | ${scorePrecise.rootMatchPct.toFixed(1)}% |`);
  lines.push(`| Beat-grid tone / J / R / root | ${tonePct.toFixed(1)} / ${jacPct.toFixed(1)} / ${recallPct.toFixed(1)} / ${toneRootPct.toFixed(1)} |`);
  lines.push(`| mir_eval root / thirds / sevenths | ${((100 * rootOk) / n).toFixed(1)} / ${((100 * thirdsOk) / n).toFixed(1)} / ${((100 * seventhsOk) / n).toFixed(1)} |`);
  lines.push(`| Exact / majmin / equiv | ${exactPct.toFixed(1)} / ${majPct.toFixed(1)} / ${equivRate.toFixed(1)} |`);
  lines.push(`| Segmentation F (±1 beat) | ${(100 * fSeg).toFixed(1)}% |`);
  lines.push('');
  lines.push(`**Verdict (e): ${hypE.keep ? 'KEEP' : 'ADDRESSED / refute as blocker'}** — ${hypE.evidence}`);
  lines.push('');
  lines.push('## Confusion matrix');
  lines.push('');
  lines.push('![Confusion matrix](./wonderwall-diagnosis-assets/confusion_matrix.png)');
  lines.push('');
  lines.push('| ref \\ hyp | ' + labels.join(' | ') + ' |');
  lines.push('|---|' + labels.map(() => '---:').join('|') + '|');
  for (let i = 0; i < labels.length; i++) {
    lines.push(`| **${labels[i]}** | ${conf[i]!.join(' | ')} |`);
  }
  lines.push('');
  lines.push('## Per-section accuracy (precise)');
  lines.push('');
  lines.push('| Section | Beats | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Equiv % |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const s of sectionStats) {
    lines.push(
      `| ${s.sec} | ${s.n} | **${s.tone.toFixed(1)}** | ${s.jaccard.toFixed(1)} | ${s.recall.toFixed(1)} | ${s.root.toFixed(1)} | ${s.exact.toFixed(1)} | ${s.majmin.toFixed(1)} | ${s.equiv.toFixed(1)} |`,
    );
  }
  lines.push('');
  lines.push('## Chroma: reference PC templates vs other-stem');
  lines.push('');
  lines.push('![Chroma](./wonderwall-diagnosis-assets/chroma_ref_vs_other.png)');
  lines.push('');
  lines.push('![Root timeline](./wonderwall-diagnosis-assets/root_timeline.png)');
  lines.push('');
  lines.push('## Ranked root causes & recommended fixes');
  lines.push('');
  lines.push('| Rank | Hypothesis | Keep? | Recommended fix | Expected gain |');
  lines.push('|---:|---|---|---|---|');
  ranked.forEach((h, idx) => {
    lines.push(
      `| ${idx + 1} | (${h.id}) ${h.title} | **${h.keep ? 'KEEP' : 'weak/refute'}** | ${h.fix} | ${h.gain} |`,
    );
  });
  lines.push('');
  lines.push('### Recommended order of work (when tuning resumes)');
  lines.push('');
  lines.push('1. **Optimize against tone %** (headline already shipped) — not exact family match.');
  lines.push('2. **Bass gating**: ignore UMX bass prior when bass RMS ≪ other (guitar-only intro).');
  lines.push('3. **Vocabulary prior**: for capo-pop, bias matcher toward F#m7↔A and Esus↔B7sus when PC overlap is high.');
  lines.push('4. **Timing**: strum-grid / anticipation-aware change detection.');
  lines.push('5. **Separation**: only if vocal RMS ratio stays high after (2)–(3).');
  lines.push('');
  lines.push('## Artifacts');
  lines.push('');
  lines.push('- `docs/wonderwall-diagnosis-assets/confusion_matrix.png`');
  lines.push('- `docs/wonderwall-diagnosis-assets/chroma_ref_vs_other.png`');
  lines.push('- `docs/wonderwall-diagnosis-assets/stem_rms_energy.png`');
  lines.push('- `docs/wonderwall-diagnosis-assets/root_timeline.png`');
  lines.push('- `docs/wonderwall-diagnosis-assets/diag-data.json` (machine-readable)');
  lines.push('');

  writeFileSync(mdPath, lines.join('\n'));
  console.log('Wrote', mdPath);
  console.log(
    JSON.stringify(
      {
        tonePct,
        jacPct,
        recallPct,
        toneRootPct,
        exactPct,
        majPct,
        rootPct,
        equivRate,
        tolTonePct,
        tolExact: (100 * tolExact) / n,
        introBassRatio,
        vocalRatio,
        scorePrecise: {
          toneOverlapPct: scorePrecise.toneOverlapPct,
          toneJaccardPct: scorePrecise.toneJaccardPct,
          toneRecallPct: scorePrecise.toneRecallPct,
          rootMatchPct: scorePrecise.rootMatchPct,
          exactPct: scorePrecise.exactPct,
          majMinPct: scorePrecise.majMinPct,
          offsetMs: scorePrecise.offsetMs,
        },
        topErrors: topErrors.slice(0, 8),
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
