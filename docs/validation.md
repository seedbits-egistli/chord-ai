# Chord detection validation

> **Test audio change (2026-10-13):** Wonderwall test audio is now the official remaster, "Wonderwall (Remastered)" by Oasis, https://www.youtube.com/watch?v=FVdjZYfDuLE (4:19; local file `wonderwall.mp3`, never committed). Music starts at 0 s (tuning ≈ +3 ¢). The previous upload had a ~16 s near-silent lead-in (≈ −21 dB), which caused the "intro" errors reported earlier. With the corrected 2-beat reference starting at 0 s, precise mode (no BPM hint, first 60 s) gives **66.2 % tone / 66.5 % strict**, tempo 86.2 BPM. The 0:36–0:44 span (detected Em–D–Em–G vs. the verse loop) is **unverified** pending an ear check.

> **Correction (2026-10-13):** the `wonderwall-real` reference used one chord per 4-beat bar. Confirmed by ear: the Wonderwall verse changes chord every **2 beats** (F#m7 A Esus4 B7sus4, half-bar each). All Wonderwall scores in this document dated before this note were computed against the wrong (per-bar) reference and understate accuracy; e.g. the 54.0 % of commit `2cda79f` is **68.0 %** against the corrected reference (strict 61.4 %). Some "late by one bar / early by 0.5 s" diagnoses were artefacts of that reference.

> **Copyright / ToS:** Real commercial recordings used for local validation are **not** stored in this repository and must not be redistributed. Synthesized rows render chords only (no copyrighted audio). **Commercial / streaming audio was never downloaded by this project for CI — only optional local files supplied by the developer.**

## Method

1. **Reference chords** from public educational / Ultimate Guitar–style charts (not audio).
2. **Synthesized audio**: additive guitar-like tones at fixture BPM (`synthesizeChordProgression`).
3. **Real audio (local only)**: `hey_jude.mp3` / `wonderwall.mp3` via `CHORD_AI_TEST_AUDIO` + ffmpeg. **Never committed.**
4. **Wonderwall** scored in **sounding key** (capo 2 → F#m7–A–Esus4–B7sus4).
5. **快速模式**: full-mix chroma templates (no ML download).
6. **精準模式** (UI opt-in): UMX-HQ → Basic Pitch + **NNLS chroma** (Mauch & Dixon ISMIR 2010, independent MIT) fused into beat-level metric HMM; harmonic downbeat; drone/sus-aware scoring; vocal residual control. See [`docs/models.md`](./models.md).
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
| Wonderwall | Oasis | F#m | **49.0** | 48.1 | 55.1 | 33.2 | 24.6 | 27.7 | A | Ultimate Guitar Wonderwall capo 2; sounding F#m7–A–Esus4–B7sus4 (verse) / D–F#m7–A (chorus). Phase-aligned. Local audio only. | first60s tone 39.5% (J=38.3 R=44.1 root=30.3) exact 22.4% maj/min 30.3% |
| **Average (full mix)** | | | **57.8** | 57.0 | 62.7 | 45.2 | 40.9 | 42.4 | | |

## Before / after UMX-HQ (first N seconds)

Compared on the **first 60s** of each file (UMX-HQ on CPU in the harness; browser uses WebGPU when available). Headline = **tone overlap %**.

| Song | Baseline tone % | +UMX-HQ tone % | Δ tone | Baseline exact / majmin | +UMX exact / majmin |
|---|---:|---:|---:|---:|---:|
| Hey Jude | 48.6 | 92.6 | +44.0 | 24.3 / 24.3 | 88.2 / 88.2 |
| Wonderwall | 39.5 | 57.2 | +17.7 | 22.4 / 30.3 | 20.3 / 21.6 |

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
| Hey Jude | 48.6 | **94.3** | +45.7 | 47.8 / 56.8 / 24.3 | 94.1 / 95.1 / 92.6 | 24.3 / 24.3 | 92.6 / 92.6 | F |
| Wonderwall | 39.5 | **56.2** | +16.7 | 38.3 / 44.1 / 30.3 | 56.7 / 62.6 / 31.1 | 22.4 / 30.3 | 31.1 / 31.1 | E |

Average precise **tone overlap**: **75.3%** (J=75.4, R=78.8, root=61.8; exact 61.8 / majmin 61.8).

### Before / after (tuning + weak-bass)

Fixes: rewritten `estimateTuningCents` (many frames, parabolic peak interpolation, energy-weighted circular mean, 1¢ resolution — Wonderwall first-60s ≈ **+7¢**, Hey Jude ≈ **−9¢**, was wrongly ~+45¢); weak-bass path uses lowest sustained `other` notes / low-band chroma blend, down-weights bass prior, stronger drone subtract, aug guard against neighbor-semitone flips; no slash when bass stem is weak.

Fast-mode first-60s drops after the tuning fix are expected (chroma was previously warped); **precise Hey Jude must not regress** (headline path). Numbers frozen at commit `1f18a77`.

| Song | Mode | Before tone % | After tone % | Δ |
|---|---|---:|---:|---:|
| Hey Jude | Fast (first 60s) | 57.6 | 48.6 | -9.0 |
| Hey Jude | UMX-HQ chroma | — | 92.6 | — |
| Hey Jude | Precise | 86.4 | **86.4** | +0.0 |
| Wonderwall | Fast (first 60s) | 42.5 | 37.7 | -4.8 |
| Wonderwall | UMX-HQ chroma | — | 57.2 | — |
| Wonderwall | Precise | 42.8 | **42.1** | -0.7 |

### Before / after (NNLS chroma + metric HMM)

Training-free precise decode (Mauch & Dixon ISMIR 2010, independent MIT impl. — not GPL Chordino): NNLS approximate-note-transcription chroma (log-freq 3 bins/semitone, spectral std, harmonic dictionary) fused with Basic Pitch histograms; harmonic-novelty downbeat; metric Viterbi; drone/novelty-aware sus scoring; soft vocal residual subtract. Detailed dump: [`docs/precise-metric-report.md`](./precise-metric-report.md).

| Song | Before tone % | After tone % | Δ | Key | Downbeat phase | NNLS ms |
|---|---:|---:|---:|---|---:|---:|
| Hey Jude | 94.3 | **94.3** | +0.0 | F | 0 | 0 |
| Wonderwall | 49.7 | **56.2** | +6.5 | E | 1 | 676 |

### Wonderwall per-section (first 60s, tone %)

| Section | Fast tone % | Precise tone % | Fast J / R / root | Precise J / R / root |
|---|---:|---:|---|---|
| intro(0–16s) | 0.0 | **16.8** | 0 / 0 / 0 | 15.9 / 22.8 / 0 |
| verse(16–45s) | 49.1 | **52.2** | 47.3 / 55.2 / 38.1 | 52.4 / 61.5 / 19 |
| late(45–60s) | 33.2 | **63.1** | 31.9 / 40.9 / 13.6 | 63.4 / 71.6 / 31.8 |

## Limitations

- Headline accuracy is **shared chord-tone overlap**, not name match — sus/relative confusions (e.g. F#m7↔A) score partially instead of zero.
- Non-ML template matching on commercial mixes trails ML; editor + simplify remain essential.
- 精準模式 is opt-in (default 快速): ~34 MiB UMX + ~0.2 MiB Basic Pitch + longer runtime.
- Separation / precise validation uses a time-capped clip so the harness finishes in CI-like environments.
- Staff notation UI is unchanged (still chord-timeline ABC); precise mode does not generate staff from notes.
- **No commercial recordings are in git.**

*Generated 2026-10-12T16:55:11.579Z by `npm run validate:real -w @chord-ai/engine`.*

## Precise mode: tempo / no-bass root / sus-slash (7-song local bench)

Commits `063908c` (audio-domain tempo + Ellis DP beats), `2b1c848` (per-beat bass reliability + lowest-note root evidence), `2cda79f` (sus margin, sustained-bass slash). Baseline `2f72ac1`. First 60 s, **no bpmHint** (real user path), local audio only (never committed). Tone % = `scoreAgainstTimedReference` with ±8 s offset + reference loop-phase search. **Strict** = same but offset search limited to ±1 beat (closer to what a user sees on the detected grid).

| Song | Ref BPM | BPM before | BPM after | Tone % before | +tempo | +no-bass root | +sus/slash (final) | Strict before → after |
|---|---:|---:|---:|---:|---:|---:|---:|---|
| Let It Be | 72 | 76 | 73.8 | 68.6 | 79.4 | 79.4 | **79.4** | 64.3 → 76.4 |
| Knockin' on Heaven's Door | 68 | 117.5 | 69 | 93.6 | 91.8 | 91.8 | **93.4** | 86.7 → 86.1 |
| Stand By Me | 118 | 107.7 | 120.2 | 89 | 96.2 | 96.2 | **96.4** | 85.8 → 94.8 |
| Someone Like You | 67.5 | 117.5 | 67.2 | 91 | 92.4 | 92.9 | **97.6** | 88.6 → 97 |
| Riptide | 102 | 107.7 | 101.4 | 83.7 | 85.1 | 83.9 | **81.6** | 78.4 → 71.1 |
| Hey Jude | 74.5 | 76 | 74.9 | 90.9 | 89.8 | 92 | **94.3** | 84.1 → 86.1 |
| Wonderwall | 87 | 117.5 | 87.6 | 55 | 54 | 54 | **54** | 50.9 → 50.1 |

With bpmHint (legacy harness for HJ/WW): Hey Jude 94.3 → 94.3, Wonderwall 56.2 → 54

Tempo: 7/7 songs now at the reference metrical level (was 2/7 within 5%). Method: log-magnitude spectral-flux onset envelopes (full band, <180 Hz bass band, chroma-change novelty) at ~86 fps; ACF tempogram with harmonic summation; metrical hierarchy (×2^k, ternary ×3/2 only with own evidence); level chosen by a log-normal prior (90 BPM, σ = 0.6 oct) × relative salience^0.3; Ellis 2007 DP beat tracking (tightness 100). Sensitivity: prior centre 85 flips Stand By Me to 60, 100 flips Knockin'/Someone Like You to 136 — 2:1 is inherently ambiguous, so the prior is the deciding knob. Synthetic tests (`tests/beats.test.ts`): 68/90/120 exact incl. syncopation; 60 → 120 and 150 → 75 (octave-equivalent, accepted); drift followed.

Known regressions / open issues (status after follow-ups):
- Riptide ukulele-intro Fm lock: mitigated by song-level vocabulary prior (`1cfba94`) — 81.6 → **83.7** (strict 71.1 → **75.8**). See “Intros without bass” below.
- Wonderwall reference was wrong (1 chord / 4-beat bar). Ear-verified 2 beats/chord; fixture corrected (`21320ba`). With official remaster audio (no 16 s pre-roll): **66.2 %** tone / **66.5 %** strict. B7sus4 still often absorbed into F#m/Bm/Asus2; 0:36–0:44 Em/D/G unverified.
- Sus margin (0.03) remains a no-op on this set; most spurious sus/slash removal comes from slash/bass gating (slash labels: SLY 10 → 1, SBM 4 → 0, Riptide 4 → 0).

### Intros without bass (commit after `21320ba`)

Investigation (first 60 s, local audio):
- **Wonderwall**: the file has a ~16 s near-silent lead-in (mix RMS ≈ −21 dB vs body; file 4:39 vs album 4:18, upload pre-roll). The other stem has 2 notes in 0–16 s; the bass stem is essentially empty for the whole first minute (RMS ≈ 0.0012 constant, also in the verse), so the G1/F1 "bass" notes are low-level separation noise — not cello, not mis-separated guitar. Music starts ≈16 s and is detected F#m–A–Esus4/B7sus4 from there. The "intro errors" are on non-music; scoring still counts that span because the reference loop starts at 0. A mix-level silence gate (`silenceGate`, emits N) is implemented but **off by default** (0.12 cost Stand By Me −1.9, no metric gain).
- **Riptide**: the intro is real music (vocals + ukulele; instrumental is only ~7 % of the loud level because vocals dominate). Tuning ≈ −33 ¢. Ukulele notes are F4-dominant; per-beat candidates rank Bbm/Db/Ab/Fm closely, and the HMM self-transition bias locked onto Fm (the common-tone "average").
- **Fix**: song-level vocabulary prior — chords decoded on loud beats (≥50 % of 90th-pct level) re-rank candidates on clearly quiet beats (<25 %), weight 0.3 × (1 − rel/0.25). Two-pass Viterbi; candidates only re-ranked, never added.

| Song | Tone % before → after | Strict before → after |
|---|---|---|
| Let It Be | 79.4 → 79.4 | 76.4 → 76.4 |
| Knockin' | 93.4 → 93.4 | 86.1 → 86.1 |
| Stand By Me | 96.4 → 96.4 | 94.8 → 94.8 |
| Someone Like You | 97.6 → 97.6 | 97.0 → 97.0 |
| Riptide | 81.6 → **83.7** | 71.1 → **75.8** |
| Hey Jude | 94.3 → 94.3 | 86.1 → 86.1 |
| Wonderwall (2-beat ref) | 68.0 → 68.0 | 61.4 → 61.4 |

A gentler always-on version (weight scaled by 1 − rel) cost Hey Jude −6.8, so the prior is restricted to clearly quiet passages.

### 7-song bench with official Wonderwall remaster (no bpmHint, first 60 s)

| Song | Ref BPM | Detected BPM | Tone % | Strict % |
|---|---:|---:|---:|---:|
| Let It Be | 72 | 73.8 | 79.4 | 76.4 |
| Knockin' on Heaven's Door | 68 | 69.0 | 93.4 | 86.1 |
| Stand By Me | 118 | 120.2 | 96.4 | 94.8 |
| Someone Like You | 67.5 | 67.2 | 97.6 | 97.0 |
| Riptide | 102 | 101.4 | 83.7 | 75.8 |
| Hey Jude | 74.5 | 74.9 | 94.3 | 86.1 |
| Wonderwall (remaster) | 87 | 86.2 | 66.2 | 66.5 |

Wonderwall: bars 1–13 lock to the verse loop (F#m7→F#m, A→A, Esus4→E/A); B7sus4 is never detected (absorbed into F#m/Bm/Asus2). 0:36–0:44 detected Em/D/Em/G — unverified.

## 7th / sus colour-tone pass (chordExtensions.ts)

Post-decode, training-free: each decoded triad run (≥2 beats) averages its pre-drone-discount chroma, subtracts the median-bin noise floor, and upgrades to m7/7 (b7 ≥ 0.9× triad mean), sus4/sus2/7sus4 (suspended tone ≥ 0.8× root+5th mean and ≥ 1.4× the 3rd, or 3rd essentially absent), never changing the root. maj7 is off by default (every maj7 emitted on the bench was vocal/melody leakage). Option `extensions: false` disables it.

| Song | Tone before | Tone after | Strict before | Strict after |
|---|---:|---:|---:|---:|
| Let It Be | 79.4 | 79.1 | 76.4 | 76.2 |
| Knockin' on Heaven's Door | 93.4 | 93.4 | 86.1 | 86.1 |
| Stand By Me | 96.4 | 96.4 | 94.8 | 94.8 |
| Someone Like You | 97.6 | 97.6 | 97.0 | 97.0 |
| Riptide | 83.7 | 83.7 | 75.8 | 75.4 |
| Hey Jude | 94.3 | 94.3 | 86.1 | 86.1 |
| Wonderwall (remaster) | 66.2 | 68.3 | 66.5 | 68.6 |

Limit: Wonderwall's F#m7 never appears because the separated "other" stem chroma carries almost no E during F#m beats (0.03–0.18 vs F# ≈ 0.9); B7sus4 is mostly decoded with a different root (F#m/Bm), and this pass never changes roots.

## 精準 v2（瀏覽器內：Beat This! small + BTC + wav2vec2 int8）

全部以 onnxruntime-web（wasm EP）在瀏覽器 Web Worker 執行，無伺服器。前 60 秒，tone % / strict %。

| Song | 現行引擎 | Python 原型（UMX 60s + small0 + 自製 CQT） | TS 移植（同輸入） | TS 全曲 UMX（真實瀏覽器路徑） |
|---|---:|---:|---:|---:|
| Let It Be | 79.4 / 76.2 | 76.1 | 76.1 / 70.8 | 75.0 |
| Knockin' on Heaven's Door | 93.4 / 86.1 | 97.0 | 97.0 / 90.2 | 97.0 |
| Stand By Me | 96.4 / 94.8 | 92.4 | 91.7 / 89.6 | 96.5 |
| Someone Like You | 97.6 / 97.0 | 88.0 | 88.0 / 88.0 | 90.1 |
| Riptide | 83.7 / 75.8 | 82.1 | 85.1 / 81.3 | 76.2 |
| Hey Jude | 94.3 / 86.1 | 91.3 | 91.8 / 87.6 | 96.7 |
| Wonderwall (remaster) | 68.3 / 68.6 | 85.6 | 85.6 / 83.9 | 66.7 |
| 平均 tone | 87.6 | 87.5 | 87.9 | 85.5 |

- TS 移植與 Python 在相同輸入下差距 ≤1 分（Riptide +3）。
- 瓶頸是分離品質：全曲 UMX-HQ 讓 Wonderwall 的延伸和弦比例掉到 0.17（htdemucs 為 0.42）→ 選到 maj/min 模型 → 66.7。Python + htdemucs 平均 89.8–90.5。
- htdemucs ONNX（StemSplitio, fp16 權重 166 MB）：onnxruntime-node 單執行緒每 7.8 s 片段約 7.8–8.2 s（≈1× 即時），RSS 3.4–5.6 GB，超過 wasm32 4 GB 上限 → 目前無法在瀏覽器實用執行。
