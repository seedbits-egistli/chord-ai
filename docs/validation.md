# Chord detection validation

> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**

## Method

1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).
2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression`).
3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg. **Never committed.**
4. **Wonderwall** scored in **sounding key** (capo 2 → F#m7–A–Esus4–B7sus4).
5. **快速模式**: full-mix chroma templates (no ML download).
6. **精準模式** (UI opt-in): UMX-HQ separation → Basic Pitch (Apache-2.0, ~226 KiB ONNX) on `other`/`bass` → note-based chords (duration×velocity PC histogram, bass root/slash, drone suppress, key-aware Viterbi). No staff generation. See [`docs/models.md`](./models.md).
7. Beat-level metrics with lag / loop-phase search:
   - **Exact**: root + quality family (maj≈maj7, min≈min7, sus≈7sus4).
   - **Maj/min**: root + major/minor class only.

```bash
npm run validate -w @chord-ai/engine
CHORD_AI_TEST_AUDIO=/path/to/mp3s CHORD_AI_SEPARATE=1 CHORD_AI_PRECISE=1 CHORD_AI_SEP_MAX_SEC=60 \
  npm run validate:real -w @chord-ai/engine
```

## Synthesized results

| Song | Artist | Ref key | Exact % | Maj/min % | Detected key |
|---|---|---|---:|---:|---|
| Hey Jude | The Beatles | F | 100.0 | 100.0 | F |
| Wonderwall | Oasis | Em | 75.0 | 100.0 | D |
| Let It Be | The Beatles | C | 100.0 | 100.0 | C |
| Hotel California | Eagles | Bm | 96.9 | 96.9 | D |
| No Woman, No Cry | Bob Marley | C | 93.8 | 93.8 | C |
| Stand By Me | Ben E. King | A | 100.0 | 100.0 | A |
| With or Without You | U2 | D | 100.0 | 100.0 | D |
| **Average** | | | **95.1** | **98.7** | |

## Real recording results (local files, not in repo)

| Song | Artist | Ref key | Exact % | Maj/min % | Detected key | Notes |
|---|---|---|---:|---:|---|---|
| Hey Jude | The Beatles | F | 53.7 | 53.7 | F | Ultimate Guitar–style / Drew Bentley (F): verse F–C–C–F–Bb–F–C–F; coda F–Eb–Bb–F. Phase-aligned loops. Local audio only. | first60s exact 32.9% maj/min 32.9% |
| Wonderwall | Oasis | F#m | 24.2 | 29.0 | A | Ultimate Guitar Wonderwall capo 2; sounding F#m7–A–Esus4–B7sus4 (verse) / D–F#m7–A (chorus). Phase-aligned. Local audio only. | first60s exact 20.7% maj/min 37.8% |
| **Average (full mix)** | | | **39.0** | **41.4** | | |

## Before / after UMX-HQ (first N seconds)

Compared on the **first 60s** of each file (UMX-HQ on CPU in the harness; browser uses WebGPU when available).

| Song | Baseline exact % | Baseline maj/min % | +UMX-HQ exact % | +UMX-HQ maj/min % | Δ maj/min |
|---|---:|---:|---:|---:|---:|
| Hey Jude | 32.9 | 32.9 | 92.6 | 92.6 | +59.7 |
| Wonderwall | 20.7 | 37.8 | 10.5 | 24.4 | -13.4 |

### Accuracy vs size

| Path | Download | License | Notes |
|---|---:|---|---|
| 快速 (full mix) | 0 | — | Default UI mode |
| UMX-HQ chroma | **~34 MiB** | MIT | Separation + chroma templates |
| **精準 (UMX + Basic Pitch)** | **~34.2 MiB** | MIT + Apache-2.0 | Note-based chords; staff unchanged |

## Fast vs precise (first N seconds)

Compared on the **first 60s** vs Ultimate Guitar–style references.

| Song | Fast (first Ns) exact % | Fast maj/min % | Precise exact % | Precise maj/min % | Δ maj/min | Detected key (precise) |
|---|---:|---:|---:|---:|---:|---|
| Hey Jude | 32.9 | 32.9 | 82.4 | 82.4 | +49.5 | F |
| Wonderwall | 20.7 | 37.8 | 33.8 | 33.8 | -4.0 | F#m |

Average precise maj/min: **58.1%** (fast first-60s baseline from table notes).

## Limitations

- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.
- 精準模式 is opt-in (default 快速): ~34 MiB UMX + ~0.2 MiB Basic Pitch + longer runtime.
- Separation / precise validation uses a time-capped clip so the harness finishes in CI-like environments.
- Staff notation UI is unchanged (still chord-timeline ABC); precise mode does not generate staff from notes.
- **No commercial recordings are in git.**

*Generated 2026-10-12T13:33:41.119Z by `npm run validate:real -w @chord-ai/engine`.*
