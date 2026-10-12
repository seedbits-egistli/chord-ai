# ORT wasm runtime (generated)

Copied from `onnxruntime-web` by `scripts/sync-ort-runtime.mjs`.
Do not commit large `.wasm` binaries; regenerate via `npm run sync:ort`.

Same-origin `/ort/` paths are required so the separate Worker can
`import()` the `.mjs` under COOP/COEP (CDN → blob: URLs fail).
