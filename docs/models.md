# Model licenses (source separation)

Chord AI’s core chord detector is original MIT code (no ML weights). Optional **source separation** (UI: **進階模式**, default **off**) improves real-recording accuracy by removing vocals before chroma matching and using a bass stem for root emphasis.

## UMX-HQ (advanced-mode separator)

| Item | Detail |
|---|---|
| Architecture | Open-Unmix **UMX-HQ** (half-width LSTM vs UMX-L) — [sigsep/open-unmix-pytorch](https://github.com/sigsep/open-unmix-pytorch) |
| ONNX | Spectrogram nets only; host STFT/iSTFT in `@chord-ai/engine` (`n_fft=4096`, `hop=1024`, periodic Hann) |
| Runtime | [`onnxruntime-web`](https://onnxruntime.ai/) / `onnxruntime-node` (MIT) · WebGPU with WASM fallback |
| Weights (lazy) | Vocals `edgetools/umx-hq` `vocals.onnx` (~17 MiB) + bass from export commit `2cc0d6a` (~17 MiB) → **~34 MiB total** |
| Upstream license | **MIT** (Zenodo 3370489 / open-unmix-pytorch). UMX-L weights are **CC BY-NC-SA 4.0** — not used. |
| Stems used | `vocals`, `bass`; `other` ≈ residual; `drums` empty |

**Redistribution:** weights are **not** vendored in git. Clients download on first advanced-mode use (`CHORD_AI_MODEL_DIR` in Node). Mirror on R2 with `VITE_UMX_VOCALS_URL` / `VITE_UMX_BASS_URL`.

**ORT wasm:** loaded from jsDelivr CDN (`ort.env.wasm.wasmPaths`); `*.wasm` is listed in `web/dist/.assetsignore` so Cloudflare Workers’ 25 MiB asset limit is not breached (the jsep build alone is ~28 MiB).

**Client persistence:** a single long-lived `separateWorker` keeps warm ONNX sessions in memory. Model ONNX + ORT wasm/mjs bytes are also stored in **Cache Storage** (`chord-ai-ml-v1`, keyed by absolute URL). Reloads and later analyses load `ArrayBuffer` from cache before any network fetch; the UI shows 已快取 / 尚未下載 and offers **清除模型快取**.

**Chord pipeline use:**

- Chroma / templates ← `bass + other` (vocals excluded)
- Bass chroma / root prior ← `bass` stem

## Accuracy vs size

| Option | Size | Role |
|---|---:|---|
| Off (default) | 0 | Full-mix chroma — fast path |
| UMX-HQ vocals+bass | ~34 MiB | Current advanced mode |
| HTDemucs ONNX (removed) | ~172 MiB | Higher quality, too large for frontend default |

See measured before/after numbers in [`docs/validation.md`](./validation.md).

## Alternatives considered

| Model | Why not default |
|---|---|
| HTDemucs (`demucs-web`) | ~172 MiB ONNX; also pulled ORT jsep wasm (~28 MiB) into Pages assets |
| Open-Unmix **UMX-L** | Weights **CC BY-NC-SA 4.0** |
| MixDirective UMX-HQ single-stem ONNX | ~35 MiB **per** stem — vocals+bass would exceed 40 MiB |
| UVR MDX-Net Voc_FT | ~65 MiB; 2-stem only (no dedicated bass) |

## Privacy

Separation and chord analysis run **entirely in the browser (or local Node harness)**. Audio is never uploaded. Only static ONNX weights (and ORT wasm from the CDN) are fetched.
