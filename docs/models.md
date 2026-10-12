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

**ORT wasm:** the separate worker imports `onnxruntime-web/wasm` (non-jsep) and loads runtime files **same-origin** from `/ort/` (~14 MiB `ort-wasm-simd-threaded.{wasm,mjs}`). Files are synced by `npm run sync:ort` **and** by the Vite `ensureOrtRuntime` plugin on every `vite`/`vite build` start (so `npm run dev -w @chord-ai/web` works even when root `predev` did not run). The plugin also serves `/ort/*` from `node_modules` and returns a plain **404** (never SPA `index.html`) if missing. `ort.env.wasm.wasmPaths` = `${origin}/ort/` and `numThreads` is forced to `1` so ORT does not fetch→`blob:`→`import()` the `.mjs` under COOP/COEP. The worker rejects HTML probes, times out stuck ONNX init, and the UI surfaces separation failures then falls back to full-mix detection with progress at 100%. The jsep/WebGPU build is **not** shipped (Workers 25 MiB limit); see `.assetsignore`.

**Client persistence:** a single long-lived `separateWorker` keeps warm ONNX sessions in memory. **ONNX model** bytes are stored in **Cache Storage** (`chord-ai-ml-v2`, keyed by absolute URL). ORT runtime files are **not** Cache-Storaged (that path produced `blob:` imports and `no available backend`). Reloads load ONNX from cache; the UI shows 已快取 / 尚未下載 and offers **清除模型快取**.

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
