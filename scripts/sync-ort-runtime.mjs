#!/usr/bin/env node
/**
 * Copy onnxruntime-web WASM runtime (non-jsep) into web/public/ort/ for
 * same-origin loading. JSEP (~28 MiB) is intentionally omitted — it exceeds
 * the Cloudflare Workers 25 MiB asset limit and breaks under blob: dynamic
 * import in Vite workers with COOP/COEP.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const srcDir = join(root, 'node_modules/onnxruntime-web/dist');
const destDir = join(root, 'web/public/ort');

const FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

if (!existsSync(join(srcDir, FILES[0]))) {
  console.error('[sync-ort-runtime] onnxruntime-web not installed; run npm install');
  process.exit(1);
}

mkdirSync(destDir, { recursive: true });
for (const f of FILES) {
  const from = join(srcDir, f);
  const to = join(destDir, f);
  copyFileSync(from, to);
  const mb = (statSync(to).size / (1024 * 1024)).toFixed(1);
  console.log(`[sync-ort-runtime] ${f} → web/public/ort/ (${mb} MiB)`);
}

writeFileSync(
  join(destDir, 'README.md'),
  `# ORT wasm runtime (generated)

Copied from \`onnxruntime-web\` by \`scripts/sync-ort-runtime.mjs\`.
Do not commit large \`.wasm\` binaries; regenerate via \`npm run sync:ort\`.

Same-origin \`/ort/\` paths are required so the separate Worker can
\`import()\` the \`.mjs\` under COOP/COEP (CDN → blob: URLs fail).
`,
);

// Keep gitignore of wasm under public/ort
writeFileSync(
  join(destDir, '.gitignore'),
  `*.wasm
*.mjs
!README.md
!.gitignore
`,
);
