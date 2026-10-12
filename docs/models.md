# Model licenses (source separation & precise mode)

Chord AI’s core chord detector is original MIT code (no ML weights). The UI offers **快速** (default, no ML download) and **精準** modes. Precise mode runs **UMX-HQ** separation, then **Basic Pitch** transcription on `other`/`bass` stems, then note-based chord inference (no staff generation from notes — existing ABC staff UI unchanged).

## UMX-HQ (separator)

| Item | Detail |
|---|---|
| Architecture | Open-Unmix **UMX-HQ** (half-width LSTM vs UMX-L) — [sigsep/open-unmix-pytorch](https://github.com/sigsep/open-unmix-pytorch) |
| ONNX | Spectrogram nets only; host STFT/iSTFT in `@chord-ai/engine` (`n_fft=4096`, `hop=1024`, periodic Hann) |
| Runtime | [`onnxruntime-web`](https://onnxruntime.ai/) / `onnxruntime-node` (MIT) · WASM EP (same-origin `/ort/`) |
| Weights (lazy) | Vocals `edgetools/umx-hq` `vocals.onnx` (~17 MiB) + bass from export commit `2cc0d6a` (~17 MiB) → **~34 MiB total** |
| Upstream license | **MIT** (Zenodo 3370489 / open-unmix-pytorch). UMX-L weights are **CC BY-NC-SA 4.0** — not used. |
| Stems used | `vocals`, `bass`; `other` ≈ residual; `drums` empty |

**Redistribution:** weights are **not** vendored in git. Clients download on first precise-mode use (`CHORD_AI_MODEL_DIR` in Node). Mirror on R2 with `VITE_UMX_VOCALS_URL` / `VITE_UMX_BASS_URL`.

## Basic Pitch (precise-mode transcription)

| Item | Detail |
|---|---|
| Model | Spotify **Basic Pitch** ICASSP 2022 ONNX (`nmp.onnx`, ~226 KiB) |
| Package | [`@audio/neural-transcribe`](https://www.npmjs.com/package/@audio/neural-transcribe) (Apache-2.0 port) |
| Upstream | [spotify/basic-pitch](https://github.com/spotify/basic-pitch) **Apache-2.0** |
| Stems transcribed | `other` (accompaniment), `bass` |
| Cache | Same Cache Storage as UMX (`chord-ai-ml-v2`); warm ORT session in `preciseWorker` |

## ORT wasm (same-origin)

The separate / precise workers import `onnxruntime-web/wasm` (non-jsep) and load runtime files **same-origin** from `/ort/` (~14 MiB). Files are synced by `npm run sync:ort` **and** by the Vite `ensureOrtRuntime` plugin on every `vite` start. `numThreads` is forced to `1` under COOP/COEP. JSEP/WebGPU builds are not shipped (Workers 25 MiB limit).

**Client persistence:** ONNX model bytes (UMX + Basic Pitch) in **Cache Storage** (`chord-ai-ml-v2`). ORT runtime files are **not** Cache-Storaged.

## Precise chord pipeline

1. UMX-HQ → stems  
2. Basic Pitch → note events on `other` + `bass`  
3. Per half-bar: duration×velocity pitch-class histogram; lowest bass MIDI → root/slash; suppress persistent drone PCs; key-aware Viterbi; full quality vocabulary + slash chords  

## Accuracy vs size

| Option | Size | Role |
|---|---:|---|
| 快速 (default) | 0 | Full-mix chroma |
| UMX-HQ chroma | ~34 MiB | Separation + chroma templates |
| **精準 (UMX + Basic Pitch)** | **~34.2 MiB** | Note-based chords |
| HTDemucs ONNX (removed) | ~172 MiB | Too large for frontend default |

See measured fast vs precise numbers in [`docs/validation.md`](./validation.md).

## Alternatives considered

| Model | Why not default |
|---|---|
| HTDemucs (`demucs-web`) | ~172 MiB ONNX; also pulled ORT jsep wasm (~28 MiB) into Pages assets |
| Open-Unmix **UMX-L** | Weights **CC BY-NC-SA 4.0** |
| MixDirective UMX-HQ single-stem ONNX | ~35 MiB **per** stem — vocals+bass would exceed 40 MiB |
| `@spotify/basic-pitch` (tfjs) | Heavier TF.js runtime; ONNX port fits existing ORT stack |

## Privacy

Separation, transcription, and chord analysis run **entirely in the browser (or local Node harness)**. Audio is never uploaded. Only static ONNX weights (and same-origin ORT wasm) are fetched.
