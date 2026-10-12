# Model licenses (source separation)

Chord AI’s core chord detector is original MIT code (no ML weights). Optional **source separation** improves real-recording accuracy by removing vocals/drums before chroma matching and using the bass stem for root emphasis.

## HTDemucs (default separator)

| Item | Detail |
|---|---|
| Architecture | Hybrid Transformer Demucs (`htdemucs`) — Meta / facebookresearch/demucs |
| ONNX package | [`demucs-web`](https://github.com/timcsy/demucs-web) (MIT) |
| Runtime | [`onnxruntime-web`](https://onnxruntime.ai/) (MIT) · WebGPU with WASM fallback |
| Weights URL (lazy) | `https://huggingface.co/timcsy/demucs-web-onnx/resolve/main/htdemucs_embedded.onnx` (~172 MB) |
| Upstream license | Demucs code **and** released pretrained models: **MIT** ([facebookresearch/demucs](https://github.com/facebookresearch/demucs/blob/main/LICENSE), HF `adefossez/HTDemucs-ft` `license: mit`) |
| Stems | `drums`, `bass`, `other`, `vocals` |

**Redistribution:** weights are **not** vendored in this git repo. Clients download on first use (browser Cache Storage / Node `CHORD_AI_MODEL_DIR`). For production you may mirror the same ONNX on Cloudflare R2 and set `VITE_DEMUCS_MODEL_URL`.

**Chord pipeline use:**

- Chroma / templates ← `bass + other + light drums` (vocals excluded)
- Bass chroma / root prior ← `bass` stem

## Alternatives considered

| Model | Why not default |
|---|---|
| Open-Unmix **UMX-HQ** (MIT, Zenodo) | Smaller vocals ONNX (~36 MB) available; needs custom STFT/Wiener host code and separate bass ONNX for 4-stem parity |
| Open-Unmix **UMX-L** | Weights **CC BY-NC-SA 4.0** — not suitable for unrestricted MIT redistribution |
| UVR MDX-Net Voc_FT | Strong vocal remover (~65 MB, MIT claimed) but only 2-stem (no dedicated bass) |

## Privacy

Separation and chord analysis run **entirely in the browser (or local Node harness)**. Audio is never uploaded. Only the static ONNX weight file is fetched from the model host / R2.
