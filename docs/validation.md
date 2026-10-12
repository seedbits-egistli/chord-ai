# Chord detection validation

> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**

## Method

1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).
2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression`).
3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg. **Never committed.**
4. **Wonderwall** scored in **sounding key** (capo 2 → F#m7–A–Esus4–B7sus4).
5. **快速模式**: full-mix chroma templates (no ML download).
6. **精準模式** (UI opt-in): UMX-HQ separation → Basic Pitch (Apache-2.0, ~226 KiB ONNX) on `other`/`bass` → note-based chords (duration×velocity PC histogram, bass root/slash, drone suppress, key-aware Viterbi). No staff generation. See [`docs/models.md`](./models.md).
7. Beat-level metrics with lag / loop-phase search. **Headline metric is tone overlap** (shared pitch classes), not chord-name equality:
   - **Tone overlap %** (primary): mean of `0.55·Jaccard + 0.35·recall + 0.10·rootMatch` per beat, where Jaccard = `|A∩B|/|A∪B|` and recall = `|A∩B|/|A|` over reference/hypothesis pitch-class sets.
   - **Jaccard / Recall / Root**: component columns (root match reported separately).
   - **Exact** (secondary): root + quality family (maj≈maj7, min≈min7, sus≈7sus4).
   - **Maj/min** (secondary): root + major/minor class only.

```bash
npm run validate -w @chord-ai/engine
CHORD_AI_TEST_AUDIO=/path/to/mp3s CHORD_AI_SEPARATE=1 CHORD_AI_PRECISE=1 CHORD_AI_SEP_MAX_SEC=60 \
  npm run validate:real -w @chord-ai/engine
```

## Synthesized results

| Song | Artist | Ref key | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Detected key |
|---|---|---|---:|---:|---:|---:|---:|---:|---|
| Hey Jude | The Beatles | F | **100.0** | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | F |
| Wonderwall | Oasis | Em | **87.4** | 85.0 | 87.5 | 100.0 | 75.0 | 100.0 | D |
| Let It Be | The Beatles | C | **100.0** | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | C |
| Hotel California | Eagles | Bm | **97.6** | 97.5 | 97.9 | 96.9 | 96.9 | 96.9 | D |
| No Woman, No Cry | Bob Marley | C | **93.8** | 93.8 | 93.8 | 93.8 | 93.8 | 93.8 | C |
| Stand By Me | Ben E. King | A | **100.0** | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | A |
| With or Without You | U2 | D | **100.0** | 100.0 | 100.0 | 100.0 | 100.0 | 100.0 | D |
| **Average** | | | **97.0** | 96.6 | 97.0 | 98.7 | 95.1 | 98.7 | |

## Real recording results (local files, not in repo)

| Song | Artist | Ref key | **Tone %** | Jaccard % | Recall % | Root % | Exact % | Maj/min % | Detected key | Notes |
|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| Hey Jude | The Beatles | F | **66.6** | 65.9 | 70.3 | 57.1 | 57.1 | 57.1 | Bb | Ultimate Guitar–style / Drew Bentley (F): verse F–C–C–F–Bb–F–C–F; coda F–Eb–Bb–F. Phase-aligned loops. Local audio only. | first60s tone 48.6% (J=47.8 R=56.8 root=24.3) exact 24.3% maj/min 24.3% |
| Wonderwall | Oasis | F#m | **48.7** | 47.8 | 54.8 | 31.9 | 23.9 | 26.8 | A | Ultimate Guitar Wonderwall capo 2; sounding F#m7–A–Esus4–B7sus4 (verse) / D–F#m7–A (chorus). Phase-aligned. Local audio only. | first60s tone 37.7% (J=36.4 R=42.3 root=29.4) exact 21.2% maj/min 29.4% |
| **Average (full mix)** | | | **57.6** | 56.9 | 62.5 | 44.5 | 40.5 | 42.0 | | |

## Before / after UMX-HQ (first N seconds)

Compared on the **first 60s** of each file (UMX-HQ on CPU in the harness; browser uses WebGPU when available). Headline = **tone overlap %**.

| Song | Baseline tone % | +UMX-HQ tone % | Δ tone | Baseline exact / majmin | +UMX exact / majmin |
|---|---:|---:|---:|---:|---:|
| Hey Jude | 48.6 | 92.6 | +44.0 | 24.3 / 24.3 | 88.2 / 88.2 |
| Wonderwall | 37.7 | 57.2 | +19.5 | 21.2 / 29.4 | 20.3 / 21.6 |

### Accuracy vs size

| Path | Download | License | Notes |
|---|---:|---|---|
| 快速 (full mix) | 0 | — | Default UI mode |
| UMX-HQ chroma | **~34 MiB** | MIT | Separation + chroma templates |
| **精準 (UMX + Basic Pitch)** | **~34.2 MiB** | MIT + Apache-2.0 | Note-based chords; staff unchanged |

## Fast vs precise (first N seconds)

Compared on the **first 60s** vs Ultimate Guitar–style references. **Tone % is the headline metric.**

| Song | Fast tone % | Precise tone % | Δ tone | Fast J / R / root | Precise J / R / root | Fast exact / majmin | Precise exact / majmin | Key (precise) |
|---|---:|---:|---:|---|---|---|---|---|
| Hey Jude | 48.6 | **86.4** | +37.8 | 47.8 / 56.8 / 24.3 | 85.9 / 88.2 / 82.4 | 24.3 / 24.3 | 82.4 / 82.4 | F |
| Wonderwall | 37.7 | **42.1** | +4.4 | 36.4 / 42.3 / 29.4 | 40.1 / 47.9 / 32.9 | 21.2 / 29.4 | 30.3 / 32.9 | F#m |

Average precise **tone overlap**: **64.3%** (J=63.0, R=68.0, root=57.7; exact 56.4 / majmin 57.7).

### Before / after (tuning + weak-bass)

Fixes: rewritten `estimateTuningCents` (many frames, parabolic peak interpolation, energy-weighted circular mean, 1¢ resolution — Wonderwall first-60s ≈ **+7¢**, Hey Jude ≈ **−9¢**, was wrongly ~+45¢); weak-bass path uses lowest sustained `other` notes / low-band chroma blend, down-weights bass prior, stronger drone subtract, aug guard against neighbor-semitone flips; no slash when bass stem is weak.

Fast-mode first-60s drops after the tuning fix are expected (chroma was previously warped); **precise Hey Jude must not regress** (headline path).

| Song | Mode | Before tone % | After tone % | Δ |
|---|---|---:|---:|---:|
| Hey Jude | Fast (first 60s) | 57.6 | 48.6 | -9.0 |
| Hey Jude | UMX-HQ chroma | — | 92.6 | — |
| Hey Jude | Precise | 86.4 | **86.4** | +0.0 |
| Wonderwall | Fast (first 60s) | 42.5 | 37.7 | -4.8 |
| Wonderwall | UMX-HQ chroma | — | 57.2 | — |
| Wonderwall | Precise | 42.8 | **42.1** | -0.7 |

### Wonderwall per-section (first 60s, tone %)

| Section | Fast tone % | Precise tone % | Fast J / R / root | Precise J / R / root |
|---|---:|---:|---|---|
| intro(0–16s) | 0.0 | **18.9** | 0 / 0 / 0 | 18.1 / 23.2 / 8.7 |
| verse(16–45s) | 43.5 | **43.3** | 42.6 / 53.8 / 11.9 | 41.8 / 52 / 21.4 |
| late(45–60s) | 43.1 | **30.5** | 42.3 / 51.5 / 18.2 | 29.8 / 36.4 / 13.6 |

## Limitations

- Headline accuracy is **shared chord-tone overlap**, not name match — sus/relative confusions (e.g. F#m7↔A) score partially instead of zero.
- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.
- 精準模式 is opt-in (default 快速): ~34 MiB UMX + ~0.2 MiB Basic Pitch + longer runtime.
- Separation / precise validation uses a time-capped clip so the harness finishes in CI-like environments.
- Staff notation UI is unchanged (still chord-timeline ABC); precise mode does not generate staff from notes.
- **No commercial recordings are in git.**

*Generated 2026-10-12T14:15:23.128Z by `npm run validate:real -w @chord-ai/engine`.*
