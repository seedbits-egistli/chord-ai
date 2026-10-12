# Chord detection validation

> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**

## Method

1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).
2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression` in `@chord-ai/engine`).
3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg decode. **Never committed.**
4. **Wonderwall** is commonly capo 2 (Em7–G–Dsus4–A7sus4 shapes); scoring uses the **sounding key** (F#m7–A–Esus4–B7sus4).
5. Same MIT chroma → template → Viterbi pipeline as the web app (`detectChords`).
6. Beat-level metrics with lag / loop-phase search for real files:
   - **Exact**: root + quality family (maj≈maj7, min≈min7, sus≈7sus4).
   - **Maj/min**: root + major/minor class only.

```bash
npm run validate -w @chord-ai/engine
CHORD_AI_TEST_AUDIO=/path/to/mp3s npm run validate:real -w @chord-ai/engine
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

Wonderwall exact &lt; maj/min because `A7sus4` is often labeled `Asus4`/`A` under mid simplify; maj/min still matches.

## Real recording results (local files, not in repo)

| Song | Artist | Ref key | Exact % | Maj/min % | Detected key | Notes |
|---|---|---|---:|---:|---|---|
| Hey Jude | The Beatles | F | 53.7 | 53.7 | F | Full mix ~7:05; coda region alone ≈ **69.5%** maj/min |
| Wonderwall | Oasis | F#m (sounding) | 24.2 | 29.0 | A | Capo-2 drone (open strings) biases toward A; first 2 min maj/min ≈ **35%** |
| **Average** | | | **39.0** | **41.4** | | |

### Chart notes

- **Hey Jude**: UG-style / Drew Bentley in F — verse `F C C F Bb F C F`; coda `F Eb Bb F`. Detector histogram dominated by F / Bb / Eb / C (correct vocabulary). Key detection: **F**.
- **Wonderwall**: UG capo 2; evaluated as sounding `F#m7 A Esus4 B7sus4`. Detector spends time on A / F#m / E / B / D (correct vocabulary) but bar-level alignment vs equal 4-bar loops is hard because sus/drone voicings blur E vs B vs A.

### Algorithm iterations (summary)

1. Baseline chroma templates + Viterbi on synth → ~95%+ maj/min.
2. Real mp3 path via ffmpeg; timed UG refs; offset search.
3. Tuning estimate, HPCP-style harmonic weighting, bass-weighted matching (helps F vs Am).
4. Drone suppression (running-mean chroma) for capo songs; hold-last on flat frames.
5. Phase-aligned looping refs + majority-vote beat scoring; BPM hint.

## Limitations

- Non-ML template matching on commercial mixes (drums, vocals, orchestra, distortion) is expected to trail ML models; the editor + “simplify chords” control are part of the product answer.
- Hand-built UG timelines + nominal BPM are imperfect; phase search mitigates but does not eliminate structure mismatch.
- **No commercial recordings are in git.** Do not add them.

*Regenerate with `CHORD_AI_TEST_AUDIO=… npm run validate:real -w @chord-ai/engine`.*
