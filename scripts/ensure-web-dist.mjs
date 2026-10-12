#!/usr/bin/env node
/**
 * Ensure `web/dist` exists for `wrangler dev` on a fresh clone, and strip any
 * onnxruntime *.wasm that would exceed the Cloudflare Workers 25 MiB asset limit.
 * ORT wasm is loaded from the jsDelivr CDN at runtime (see separateWorker.ts).
 */
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
  unlinkSync,
  statSync,
  readFileSync,
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

writeFileSync(
  join(dist, '.assetsignore'),
  `# ORT wasm is served from CDN — never upload to Workers assets (25 MiB limit)
*.wasm
**/*.wasm
`,
);

stripWasm(dist);

function stripWasm(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) stripWasm(p);
    else if (name.endsWith('.wasm')) {
      console.log(`[ensure-web-dist] removing ${p} (${(st.size / 1e6).toFixed(1)} MB)`);
      unlinkSync(p);
    }
  }
}
