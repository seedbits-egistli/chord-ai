import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { writeFileSync, readdirSync, unlinkSync, statSync, existsSync } from 'node:fs';

/** Drop ORT wasm from the bundle and write .assetsignore for Cloudflare Workers. */
function stripOrtWasmAssets(): Plugin {
  return {
    name: 'strip-ort-wasm-assets',
    generateBundle(_opts, bundle) {
      for (const key of Object.keys(bundle)) {
        if (key.endsWith('.wasm')) {
          delete bundle[key];
        }
      }
    },
    closeBundle() {
      const dist = path.resolve(__dirname, 'dist');
      writeFileSync(
        path.join(dist, '.assetsignore'),
        `# ORT wasm is served from CDN (see separateWorker.ts)
*.wasm
**/*.wasm
`,
      );
      stripWasmDir(dist);
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

export default defineConfig({
  plugins: [react(), stripOrtWasmAssets()],
  resolve: {
    alias: {
      '@chord-ai/engine': path.resolve(__dirname, '../packages/chord-engine/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      // credentialless lets CDN ORT wasm load under COOP without CORP on every host
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
      },
    },
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@chord-ai/engine', 'onnxruntime-web'],
  },
  build: {
    // Do not emit wasm as hashed assets; runtime loads from jsDelivr.
    assetsInlineLimit: 0,
  },
});
