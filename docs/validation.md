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
| Hey Jude | The Beatles | F | **64.8** | 64.0 | 69.2 | 53.7 | 53.7 | 53.7 | F | Ultimate Guitar–style / Drew Bentley (F): verse F–C–C–F–Bb–F–C–F; coda F–Eb–Bb–F. Phase-aligned loops. Local audio only. | first60s tone 57.6% (J=57 R=65.7 root=32.9) exact 32.9% maj/min 32.9% |
| Wonderwall | Oasis | F#m | **48.6** | 47.4 | 54.6 | 34.9 | 24.3 | 28.7 | A | Ultimate Guitar Wonderwall capo 2; sounding F#m7–A–Esus4–B7sus4 (verse) / D–F#m7–A (chorus). Phase-aligned. Local audio only. | first60s tone 42.5% (J=40.4 R=46.9 root=38.2) exact 26.3% maj/min 38.2% |
| **Average (full mix)** | | | **56.7** | 55.7 | 61.9 | 44.3 | 39.0 | 41.2 | | |

## Before / after UMX-HQ (first N seconds)

Compared on the **first 60s** of each file (UMX-HQ on CPU in the harness; browser uses WebGPU when available). Headline = **tone overlap %**.

| Song | Baseline tone % | +UMX-HQ tone % | Δ tone | Baseline exact / majmin | +UMX exact / majmin |
|---|---:|---:|---:|---:|---:|
| Hey Jude | 57.6 | 94.3 | +36.7 | 32.9 / 32.9 | 92.6 / 92.6 |
| Wonderwall | 42.5 | 45.8 | +3.3 | 26.3 / 38.2 | 13.4 / 23.2 |

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
| Hey Jude | 57.6 | **86.4** | +28.8 | 57.0 / 65.7 / 32.9 | 85.9 / 88.2 / 82.4 | 32.9 / 32.9 | 82.4 / 82.4 | F |
| Wonderwall | 42.5 | **42.8** | +0.3 | 40.4 / 46.9 / 38.2 | 40.4 / 49.2 / 32.9 | 26.3 / 38.2 | 30.3 / 32.9 | F#m |

Average precise **tone overlap**: **64.6%** (J=63.2, R=68.7, root=57.7; exact 56.4 / majmin 57.7).

## Limitations

- Headline accuracy is **shared chord-tone overlap**, not name match — sus/relative confusions (e.g. F#m7↔A) score partially instead of zero.
- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.
- 精準模式 is opt-in (default 快速): ~34 MiB UMX + ~0.2 MiB Basic Pitch + longer runtime.
- Separation / precise validation uses a time-capped clip so the harness finishes in CI-like environments.
- Staff notation UI is unchanged (still chord-timeline ABC); precise mode does not generate staff from notes.
- **No commercial recordings are in git.**

*Generated 2026-10-12T13:43:53.287Z by `npm run validate:real -w @chord-ai/engine`.*
