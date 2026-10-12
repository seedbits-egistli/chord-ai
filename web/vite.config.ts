import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { writeFileSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs';

/**
 * Drop ORT wasm that Vite may emit into hashed /assets/ (from onnxruntime-web
 * imports). Keep web/public/ort/ (copied as /ort/) — those are ~14 MiB and
 * under the Workers 25 MiB limit.
 */
function stripBundledOrtWasm(): Plugin {
  return {
    name: 'strip-bundled-ort-wasm',
    generateBundle(_opts, bundle) {
      for (const key of Object.keys(bundle)) {
        // Only strip rollup-emitted wasm under assets/, not public/ort copies
        if (key.endsWith('.wasm') && key.includes('assets/')) {
          delete bundle[key];
        }
      }
    },
    closeBundle() {
      const dist = path.resolve(__dirname, 'dist');
      const assetsDir = path.join(dist, 'assets');
      if (existsSync(assetsDir)) stripWasmDir(assetsDir);
      writeFileSync(
        path.join(dist, '.assetsignore'),
        `# Ignore oversized ORT variants if present; keep /ort/simd-threaded (~14MiB)
**/*jsep*.wasm
**/*asyncify*.wasm
**/*jspi*.wasm
`,
      );
    },
  };
}

function stripWasmDir(dir: string) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) stripWasmDir(p);
    else if (name.endsWith('.wasm')) unlinkSync(p);
  }
}

const ortWasmExtern = path.resolve(
  __dirname,
  '../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
);

export default defineConfig({
  plugins: [react(), stripBundledOrtWasm()],
  resolve: {
    // Prefer extern-wasm build so ort.env.wasm.wasmPaths (/ort/) is used —
    // not the default bundle that resolves .wasm via import.meta.url.
    conditions: ['onnxruntime-web-use-extern-wasm', 'import', 'module', 'browser', 'default'],
    alias: {
      '@chord-ai/engine': path.resolve(__dirname, '../packages/chord-engine/src/index.ts'),
      'onnxruntime-web/wasm': ortWasmExtern,
    },
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: 4173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@chord-ai/engine', 'onnxruntime-web', 'onnxruntime-web/wasm'],
  },
  build: {
    assetsInlineLimit: 0,
  },
});
