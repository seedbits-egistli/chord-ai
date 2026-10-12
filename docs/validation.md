# Chord detection validation

> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**

## Method

1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).
2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression`).
3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg. **Never committed.**
4. **Wonderwall** scored in **sounding key** (capo 2 → F#m7–A–Esus4–B7sus4).
5. Optional **HTDemucs** source separation (MIT weights, lazy ONNX download) → instrumental chroma + bass stem. See [`docs/models.md`](./models.md).
6. Beat-level metrics with lag / loop-phase search:
   - **Exact**: root + quality family (maj≈maj7, min≈min7, sus≈7sus4).
   - **Maj/min**: root + major/minor class only.

```bash
npm run validate -w @chord-ai/engine
CHORD_AI_TEST_AUDIO=/path/to/mp3s CHORD_AI_SEPARATE=1 CHORD_AI_SEP_MAX_SEC=90 \
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

## Before / after HTDemucs (first N seconds)

Compared on the **first 60s** of each file (Demucs on CPU in the harness; browser uses WebGPU when available).

| Song | Baseline exact % | Baseline maj/min % | +HTDemucs exact % | +HTDemucs maj/min % | Δ maj/min |
|---|---:|---:|---:|---:|---:|
| Hey Jude | 32.9 | 32.9 | 88.2 | 88.2 | +55.3 |
| Wonderwall | 20.7 | 37.8 | 21.3 | 28.0 | -9.8 |

Hey Jude improves sharply once vocals/orchestra bleed are removed. Wonderwall’s capo-2 open-string drone remains in the `other`/`bass` stems, so bar-level alignment vs equal 4-bar UG loops stays hard even after vocal removal (vocabulary A/F#m/E/B is still correct).

## Limitations

- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.
- HTDemucs adds a large download and heavy CPU/GPU work; default-off on mobile.
- Separation validation uses a time-capped clip so the harness finishes in CI-like environments.
- **No commercial recordings are in git.**

*Generated 2026-10-12T12:05:36.513Z by `npm run validate:real -w @chord-ai/engine`.*
