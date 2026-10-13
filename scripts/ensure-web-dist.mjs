#!/usr/bin/env node
/**
 * Ensure `web/dist` exists for `wrangler dev` on a fresh clone.
 * Does NOT delete `/ort/*.wasm` (same-origin ORT runtime, ~14 MiB).
 * Strips only oversized jsep/asyncify variants if present.
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const dist = join(root, 'web/dist');
const assets = join(dist, 'assets');

mkdirSync(assets, { recursive: true });

if (!existsSync(join(dist, 'index.html'))) {
  writeFileSync(
    join(dist, 'index.html'),
    `<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="utf-8" />
    <title>Chord AI</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <p>Run <code>npm run dev -w @chord-ai/web</code> (Vite on :5173) or <code>npm run build -w @chord-ai/web</code>.</p>
  </body>
</html>
`,
  );
}

const headersSrc = join(root, 'web/public/_headers');
const headersDst = join(dist, '_headers');
if (existsSync(headersSrc) && !existsSync(headersDst)) {
  copyFileSync(headersSrc, headersDst);
}

// Copy same-origin ORT runtime into dist if public/ort was synced
const ortSrc = join(root, 'web/public/ort');
const ortDst = join(dist, 'ort');
if (existsSync(ortSrc)) {
  mkdirSync(ortDst, { recursive: true });
  for (const name of readdirSync(ortSrc)) {
    if (name.endsWith('.wasm') || name.endsWith('.mjs')) {
      copyFileSync(join(ortSrc, name), join(ortDst, name));
    }
  }
}

writeFileSync(
  join(dist, '.assetsignore'),
  `# Oversized ORT variants; keep /ort/ort-wasm-simd-threaded.wasm (~14 MiB)
**/*jsep*.wasm
**/*asyncify*.wasm
**/*jspi*.wasm
`,
);

stripOversizedWasm(dist);

function stripOversizedWasm(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      stripOversizedWasm(p);
      continue;
    }
    if (!name.endsWith('.wasm')) continue;
    const oversized =
      name.includes('jsep') || name.includes('asyncify') || name.includes('jspi');
    // Also strip hashed copies under assets/ (bundle leakage)
    const underAssets = p.includes(`${join('dist', 'assets')}`) || p.includes('/assets/');
    if (oversized || underAssets) {
      console.log(`[ensure-web-dist] removing ${p} (${(st.size / 1e6).toFixed(1)} MB)`);
      unlinkSync(p);
    }
  }
}
