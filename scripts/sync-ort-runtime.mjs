#!/usr/bin/env node
/**
 * Copy onnxruntime-web WASM runtime (non-jsep) into web/public/ort/ for
 * same-origin loading. JSEP (~28 MiB) is intentionally omitted — it exceeds
 * the Cloudflare Workers 25 MiB asset limit and breaks under blob: dynamic
 * import in Vite workers with COOP/COEP.
 *
 * Also imported by the Vite `ensureOrtRuntime` plugin so `npm run dev -w web`
 * (which skips root `predev`) still gets a working `/ort/` tree.
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'node_modules/onnxruntime-web/dist');
const destDir = join(root, 'web/public/ort');

export const ORT_RUNTIME_FILES = [
  'ort-wasm-simd-threaded.wasm',
  'ort-wasm-simd-threaded.mjs',
];

/**
 * Ensure web/public/ort has the non-jsep runtime files.
 * @returns {{ destDir: string, srcDir: string, copied: string[], skipped: string[] }}
 */
export function syncOrtRuntime({ quiet = false } = {}) {
  if (!existsSync(join(srcDir, ORT_RUNTIME_FILES[0]))) {
    throw new Error(
      '[sync-ort-runtime] onnxruntime-web not installed; run npm install',
    );
  }

  mkdirSync(destDir, { recursive: true });
  const copied = [];
  const skipped = [];
  for (const f of ORT_RUNTIME_FILES) {
    const from = join(srcDir, f);
    const to = join(destDir, f);
    if (!existsSync(from)) {
      throw new Error(`[sync-ort-runtime] missing ${from}`);
    }
    const srcSize = statSync(from).size;
    if (existsSync(to) && statSync(to).size === srcSize) {
      skipped.push(f);
      continue;
    }
    copyFileSync(from, to);
    copied.push(f);
    if (!quiet) {
      const mb = (srcSize / (1024 * 1024)).toFixed(1);
      console.log(`[sync-ort-runtime] ${f} → web/public/ort/ (${mb} MiB)`);
    }
  }

  writeFileSync(
    join(destDir, 'README.md'),
    `# ORT wasm runtime (generated)

Copied from \`onnxruntime-web\` by \`scripts/sync-ort-runtime.mjs\`
(or the Vite \`ensureOrtRuntime\` plugin on \`npm run dev\`).
Do not commit large \`.wasm\` binaries; regenerate via \`npm run sync:ort\`.

Same-origin \`/ort/\` paths are required so the separate Worker can
\`import()\` the \`.mjs\` under COOP/COEP (CDN → blob: URLs fail).
`,
  );

  writeFileSync(
    join(destDir, '.gitignore'),
    `*.wasm
*.mjs
!README.md
!.gitignore
`,
  );

  return { destDir, srcDir, copied, skipped };
}

export function ortSrcPath(filename) {
  return join(srcDir, filename);
}

export function ortDestPath(filename) {
  return join(destDir, filename);
}

const isMain =
  !!process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    syncOrtRuntime();
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
