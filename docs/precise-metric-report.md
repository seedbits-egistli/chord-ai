# Precise metric / downbeat report

> **Test audio change (2026-10-13):** Wonderwall test audio is now the official remaster, "Wonderwall (Remastered)" by Oasis, https://www.youtube.com/watch?v=FVdjZYfDuLE (4:19; local file `wonderwall.mp3`, never committed). Music starts at 0 s (tuning ≈ +3 ¢). The previous upload had a ~16 s near-silent lead-in (≈ −21 dB), which caused the "intro" errors reported earlier. With the corrected 2-beat reference starting at 0 s, precise mode (no BPM hint, first 60 s) gives **66.2 % tone / 66.5 % strict**, tempo 86.2 BPM. The 0:36–0:44 span (detected Em–D–Em–G vs. the verse loop) is **unverified** pending an ear check.

> **Correction (2026-10-13):** the `wonderwall-real` reference used one chord per 4-beat bar. Confirmed by ear: the Wonderwall verse changes chord every **2 beats** (F#m7 A Esus4 B7sus4, half-bar each). All Wonderwall scores in this document dated before this note were computed against the wrong (per-bar) reference and understate accuracy; e.g. the 54.0 % of commit `2cda79f` is **68.0 %** against the corrected reference (strict 61.4 %). Some "late by one bar / early by 0.5 s" diagnoses were artefacts of that reference.

Generated 2026-10-12T17:02:16.009Z by `packages/chord-engine/scripts/metric-precise-report.ts`.

## Before / after (precise first 60s)

| Song | Before tone % | After tone % | Δ | Key | Downbeat phase | NNLS ms |
|---|---:|---:|---:|---|---:|---:|
| Hey Jude | 94.3 | **94.3** | +0.0 | F | 0 | 0 |
| Wonderwall | 49.7 | **56.2** | +6.5 | E | 1 | 651 |

## Wonderwall per-section (tone %, fixed ref phase 3 + best-phase harness)

| Section | Tone % (phase 3) | Tone % (best harness phase) |
|---|---:|---:|
| intro(0–16s) | 16.8 | 16.8 |
| verse(16–45s) | 52.2 | 52.2 |
| late(45–60s) | 63.1 | 63.1 |

## Wonderwall: raw chord-change times vs barlines

BPM 87, bar ≈ 2759 ms. Downbeat phase **1** (beats[i] downbeat when i%4===phase). Beat-grid first beat @ 316 ms.

| Change t (s) | Chord | Nearest barline (s) | Δ to barline (ms) | Beat-in-bar |
|---:|---|---:|---:|---:|
| 0.32 | Gm | 1.01 | -690 | 3 |
| 1.01 | C# | 1.01 | 0 | 0 |
| 3.08 | Bsus4 | 3.76 | -689 | 3 |
| 5.14 | A# | 6.52 | -1379 | 2 |
| 6.52 | Em | 6.52 | 0 | 0 |
| 7.90 | G | 6.52 | 1379 | 2 |
| 16.18 | F#m | 14.80 | 1379 | 2 |
| 18.94 | Esus4 | 20.32 | -1379 | 2 |
| 21.70 | F#m | 20.32 | 1379 | 2 |
| 23.76 | Esus4 | 23.07 | 689 | 1 |
| 27.21 | F#m | 28.59 | -1379 | 2 |
| 28.59 | A | 28.59 | 0 | 0 |
| 29.97 | Esus4 | 28.59 | 1379 | 2 |
| 32.73 | F#m | 31.35 | 1379 | 2 |
| 34.11 | Esus4 | 34.11 | 0 | 0 |
| 37.56 | F#m | 36.87 | 689 | 1 |
| 41.01 | Esus4 | 42.38 | -1379 | 2 |
| 43.76 | F#m | 42.38 | 1379 | 2 |
| 45.14 | A | 45.14 | 0 | 0 |
| 47.90 | Bsus4 | 47.90 | 0 | 0 |
| 49.28 | F#m | 50.66 | -1379 | 2 |
| 50.66 | A | 50.66 | 0 | 0 |
| 54.80 | Asus4 | 53.42 | 1379 | 2 |
| 56.18 | Esus4 | 56.18 | 0 | 0 |

## Wonderwall per-bar table (fixed reference phase 3 = A in bar 0)

| Time | Reference | Ref tones | Detected | Detected tones | Overlap |
|---|---|---|---|---|---:|
| 0.00–0.00 | F#m7 | F# A C# E | Gm | G A# D | 0% |
| 0.00–2.76 | A | A C# E | C# | C# F G# | 23% |
| 2.76–5.52 | Esus4 | E A B | Bsus4 | B E F# | 51% |
| 5.52–8.28 | B7sus4 | B E F# A | Em | E G B | 40% |
| 8.28–11.03 | F#m7 | F# A C# E | G | G B D | 0% |
| 11.03–13.79 | A | A C# E | G | G B D | 0% |
| 13.79–16.55 | Esus4 | E A B | G | G B D | 23% |
| 16.55–19.31 | B7sus4 | B E F# A | F#m | F# A C# | 40% |
| 19.31–22.07 | F#m7 | F# A C# E | Esus4 | E A B | 40% |
| 22.07–24.83 | A | A C# E | F#m | F# A C# | 51% |
| 24.83–27.59 | Esus4 | E A B | Esus4 | E A B | 100% |
| 27.59–30.34 | B7sus4 | B E F# A | A | A C# E | 40% |
| 30.34–33.10 | F#m7 | F# A C# E | Esus4 | E A B | 40% |
| 33.10–35.86 | A | A C# E | Esus4 | E A B | 51% |
| 35.86–38.62 | Esus4 | E A B | Esus4 | E A B | 100% |
| 38.62–41.38 | B7sus4 | B E F# A | F#m | F# A C# | 40% |
| 41.38–44.14 | F#m7 | F# A C# E | Esus4 | E A B | 40% |
| 44.14–46.90 | A | A C# E | A | A C# E | 100% |
| 46.90–49.66 | Esus4 | E A B | Bsus4 | B E F# | 51% |
| 49.66–52.41 | B7sus4 | B E F# A | A | A C# E | 40% |
| 52.41–55.17 | F#m7 | F# A C# E | A | A C# E | 68% |
| 55.17–57.93 | A | A C# E | Esus4 | E A B | 51% |
| 57.93–60.00 | Esus4 | E A B | Esus4 | E A B | 100% |

## Wonderwall note histograms

Pitch-class / MIDI dumps from Basic Pitch (duration×velocity) on UMX stems. Explains intro G/F and late G/D detections.

Intro note counts: other=2/808, bass=17/211.

### Intro 0–16s (other stem) (0–16s)

| PC | Rel energy (L2 chroma) | Raw weight share |
|---|---:|---:|
| C# | 0.748 | 53.0% |
| D# | 0.664 | 47.0% |

Top MIDI notes (duration×velocity weight):

| MIDI | Note | Weight share | Count-ish |
|---:|---|---:|---:|
| 61 | C#4 | 53.0% | 0.06 |
| 63 | D#4 | 47.0% | 0.05 |

Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: D#

### Intro 0–16s (bass stem) (0–16s)

| PC | Rel energy (L2 chroma) | Raw weight share |
|---|---:|---:|
| G | 0.992 | 81.5% |
| E | 0.080 | 6.5% |
| F | 0.067 | 5.5% |
| A | 0.063 | 5.2% |

Top MIDI notes (duration×velocity weight):

| MIDI | Note | Weight share | Count-ish |
|---:|---|---:|---:|
| 31 | G1 | 76.3% | 3.86 |
| 29 | F1 | 5.5% | 0.28 |
| 43 | G2 | 5.2% | 0.26 |
| 33 | A1 | 5.2% | 0.26 |
| 28 | E1 | 3.0% | 0.15 |
| 40 | E2 | 2.3% | 0.12 |
| 48 | C3 | 1.3% | 0.06 |
| 52 | E3 | 1.2% | 0.06 |

Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: G

### Intro 0–16s (other+bass) (0–16s)

| PC | Rel energy (L2 chroma) | Raw weight share |
|---|---:|---:|
| G | 0.992 | 79.8% |
| E | 0.080 | 6.4% |
| F | 0.067 | 5.4% |
| A | 0.063 | 5.1% |

Top MIDI notes (duration×velocity weight):

| MIDI | Note | Weight share | Count-ish |
|---:|---|---:|---:|
| 31 | G1 | 74.7% | 3.86 |
| 29 | F1 | 5.4% | 0.28 |
| 43 | G2 | 5.1% | 0.26 |
| 33 | A1 | 5.1% | 0.26 |
| 28 | E1 | 3.0% | 0.15 |
| 40 | E2 | 2.2% | 0.12 |
| 48 | C3 | 1.2% | 0.06 |
| 52 | E3 | 1.2% | 0.06 |
| 61 | C#4 | 1.1% | 0.06 |
| 63 | D#4 | 1.0% | 0.05 |

Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: G

### Ending 52–60s (other stem) (52–60s)

| PC | Rel energy (L2 chroma) | Raw weight share |
|---|---:|---:|
| B | 0.555 | 25.8% |
| E | 0.554 | 25.8% |
| A | 0.544 | 25.3% |
| F# | 0.247 | 11.5% |
| D | 0.134 | 6.2% |
| G | 0.097 | 4.5% |

Top MIDI notes (duration×velocity weight):

| MIDI | Note | Weight share | Count-ish |
|---:|---|---:|---:|
| 57 | A3 | 17.4% | 3.02 |
| 47 | B2 | 16.0% | 2.78 |
| 52 | E3 | 15.0% | 2.60 |
| 54 | F#3 | 11.1% | 1.93 |
| 64 | E4 | 10.8% | 1.88 |
| 59 | B3 | 9.5% | 1.65 |
| 43 | G2 | 4.5% | 0.78 |
| 50 | D3 | 4.1% | 0.71 |
| 45 | A2 | 4.0% | 0.69 |
| 69 | A4 | 3.0% | 0.52 |
| 62 | D4 | 2.1% | 0.37 |
| 81 | A5 | 0.9% | 0.16 |
| 75 | D#5 | 0.9% | 0.15 |
| 42 | F#2 | 0.4% | 0.06 |
| 83 | B5 | 0.3% | 0.05 |

Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: G

### Ending 52–60s (bass stem) (52–60s)

| PC | Rel energy (L2 chroma) | Raw weight share |
|---|---:|---:|
| G | 0.710 | 37.7% |
| B | 0.518 | 27.5% |
| D | 0.459 | 24.4% |
| E | 0.123 | 6.5% |
| F# | 0.037 | 1.9% |
| C | 0.031 | 1.6% |

Top MIDI notes (duration×velocity weight):

| MIDI | Note | Weight share | Count-ish |
|---:|---|---:|---:|
| 43 | G2 | 33.2% | 2.30 |
| 47 | B2 | 20.4% | 1.41 |
| 50 | D3 | 15.3% | 1.06 |
| 62 | D4 | 9.1% | 0.63 |
| 59 | B3 | 7.1% | 0.50 |
| 55 | G3 | 4.5% | 0.31 |
| 52 | E3 | 4.4% | 0.30 |
| 64 | E4 | 2.2% | 0.15 |
| 54 | F#3 | 1.9% | 0.13 |
| 48 | C3 | 0.9% | 0.06 |
| 60 | C4 | 0.8% | 0.05 |
| 33 | A1 | 0.3% | 0.02 |

Out-of-key (vs F#m/A diatonic) PCs with chroma >0.08: G

## Findings (G/F/D/C out-of-key + vocal leakage)

- **Intro 0–16s (`other`)**: only **2** Basic Pitch notes (mass 0.11). UMX puts almost no guitar into `other` until ~16.4s (verse onset).
- **Intro bass stem**: **17** notes, PC mass **G=81.5%** (mostly **G1**), F=5.5%. Intro G/F labels were driven by **real low G/F MIDI in the bass stem** (mis-separated guitar), not FFT harmonics. NNLS on instrumental (~650 ms / 60 s clip) is auto-enabled on this weak-bass mix to supply treble chroma when `other` is empty.
- **Ending 52–60s (`other`)**: real **G2 (MIDI 43)** and **D3 (MIDI 50)** (~4–5% weight). Bass stem also heavy G/D (G2 33%, D3 15%). These are **not purely vocal leakage** into `other` — they appear as sustained guitar-register fundamentals; soft vocal residual subtract (α≈0.22) + vocal-correlated note down-weight still help late-section tone (**63.1%** harness), with several bars now decoding as **Esus4** (100% overlap).
- **Sus progress**: verse/late now hit **Esus4** repeatedly (was almost never). **B7sus4** still often collapses to A / F#m (shared tones + drone E/B).
- Downbeat phase **1** (reference table uses fixed phase **3**). NNLS analysis ≈ **0.65 s** on Wonderwall first 60 s; Hey Jude skips NNLS (strong bass) so added cost is **0 ms**.
