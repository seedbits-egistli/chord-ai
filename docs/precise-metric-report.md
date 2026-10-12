# Precise metric / downbeat report

Generated 2026-10-12T15:16:18.415Z by `packages/chord-engine/scripts/metric-precise-report.ts`.

## Before / after (precise first 60s)

| Song | Before tone % (1f18a77) | After tone % | Δ | Key | Downbeat phase |
|---|---:|---:|---:|---|---:|
| Hey Jude | 86.4 | **94.3** | +7.9 | F | 0 |
| Wonderwall | 42.1 | **49.7** | +7.6 | A | 3 |

## Wonderwall per-section (tone %, fixed ref phase 3 + best-phase harness)

| Section | Tone % (phase 3) | Tone % (best harness phase) |
|---|---:|---:|
| intro(0–16s) | 22.6 | 37.5 |
| verse(16–45s) | 47.0 | 45.1 |
| late(45–60s) | 41.1 | 40.5 |

## Wonderwall: raw chord-change times vs barlines

BPM 87, bar ≈ 2759 ms. Downbeat phase **3** (beats[i] downbeat when i%4===phase). Beat-grid first beat @ 460 ms.

| Change t (s) | Chord | Nearest barline (s) | Δ to barline (ms) | Beat-in-bar |
|---:|---|---:|---:|---:|
| 0.46 | D | 2.53 | -2069 | 1 |
| 1.84 | C#sus2 | 2.53 | -690 | 3 |
| 2.53 | A | 2.53 | 0 | 0 |
| 8.05 | G | 8.05 | 0 | 0 |
| 14.94 | F#m | 16.32 | -1379 | 2 |
| 19.08 | Bsus4 | 19.08 | 0 | 0 |
| 21.84 | F#m | 21.84 | 0 | 0 |
| 23.22 | A | 21.84 | 1379 | 2 |
| 24.60 | Bm | 24.60 | 0 | 0 |
| 27.36 | F#m | 27.36 | 0 | 0 |
| 28.74 | A | 30.11 | -1379 | 2 |
| 30.11 | E | 30.11 | 0 | 0 |
| 31.49 | F#m | 30.11 | 1379 | 2 |
| 34.25 | A | 32.87 | 1379 | 2 |
| 35.63 | Bsus4 | 35.63 | 0 | 0 |
| 37.70 | F#m | 38.39 | -690 | 3 |
| 39.77 | A | 38.39 | 1379 | 2 |
| 42.53 | Bm | 43.91 | -1379 | 2 |
| 43.91 | F#m | 43.91 | 0 | 0 |
| 45.29 | A | 43.91 | 1379 | 2 |
| 48.05 | F#m | 46.67 | 1379 | 2 |
| 50.80 | A | 52.18 | -1379 | 2 |
| 52.18 | Em | 52.18 | 0 | 0 |
| 53.56 | A | 52.18 | 1379 | 2 |
| 54.94 | D | 54.94 | 0 | 0 |
| 56.32 | Em | 54.94 | 1379 | 2 |
| 57.70 | Bm | 57.70 | 0 | 0 |

## Wonderwall per-bar table (fixed reference phase 3 = A in bar 0)

| Time | Reference | Ref tones | Detected | Detected tones | Overlap |
|---|---|---|---|---|---:|
| 0.00–0.00 | F#m7 | F# A C# E | D | D F# A | 40% |
| 0.00–2.76 | A | A C# E | D | D F# A | 23% |
| 2.76–5.52 | Esus4 | E A B | A | A C# E | 51% |
| 5.52–8.28 | B7sus4 | B E F# A | A | A C# E | 40% |
| 8.28–11.03 | F#m7 | F# A C# E | G | G B D | 0% |
| 11.03–13.79 | A | A C# E | G | G B D | 0% |
| 13.79–16.55 | Esus4 | E A B | F#m | F# A C# | 23% |
| 16.55–19.31 | B7sus4 | B E F# A | F#m | F# A C# | 40% |
| 19.31–22.07 | F#m7 | F# A C# E | Bsus4 | B E F# | 40% |
| 22.07–24.83 | A | A C# E | A | A C# E | 100% |
| 24.83–27.59 | Esus4 | E A B | Bm | B D F# | 23% |
| 27.59–30.34 | B7sus4 | B E F# A | A | A C# E | 40% |
| 30.34–33.10 | F#m7 | F# A C# E | F#m | F# A C# | 78% |
| 33.10–35.86 | A | A C# E | A | A C# E | 100% |
| 35.86–38.62 | Esus4 | E A B | Bsus4 | B E F# | 51% |
| 38.62–41.38 | B7sus4 | B E F# A | A | A C# E | 40% |
| 41.38–44.14 | F#m7 | F# A C# E | Bm | B D F# | 18% |
| 44.14–46.90 | A | A C# E | A | A C# E | 100% |
| 46.90–49.66 | Esus4 | E A B | F#m | F# A C# | 23% |
| 49.66–52.41 | B7sus4 | B E F# A | A | A C# E | 40% |
| 52.41–55.17 | F#m7 | F# A C# E | A | A C# E | 68% |
| 55.17–57.93 | A | A C# E | Em | E G B | 23% |
| 57.93–60.00 | Esus4 | E A B | Bm | B D F# | 23% |

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

## Findings (G/F/D/C out-of-key)

- **Intro 0–16s (`other`)**: only **2** Basic Pitch notes (mass 0.11). UMX puts almost no guitar into `other` until ~16.4s (verse onset).
- **Intro bass stem**: **17** notes, PC mass **G=81.5%** (mostly **G1**), F=5.5%. The classic intro G/F labels were driven by **real low G/F MIDI in the bass stem** (leakage / mis-separated guitar), not FFT harmonics — and not by `other` (nearly empty). Precise path now falls back to instrumental audio chroma when accompaniment notes are empty.
- **Ending 52–60s (`other`)**: real **G2 (MIDI 43)** and **D3 (MIDI 50)** (~4–5% weight) — open-string / non-chord fundamentals, not harmonic leakage. PC mass G=4.5%, D=6.2%. Bass stem also heavy G/D.
- Detected downbeat phase **3** (matches fixed reference phase 3). Many verse changes land on beat-in-bar 0; residual half-bar (beat 2) flips remain.
