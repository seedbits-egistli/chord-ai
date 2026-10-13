import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import {
  writeFileSync,
  readdirSync,
  unlinkSync,
  statSync,
  existsSync,
  createReadStream,
  readFileSync,
} from 'node:fs';
import { syncOrtRuntime } from '../scripts/sync-ort-runtime.mjs';

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

/**
 * Always materialize /ort/ from node_modules and never SPA-fallback those URLs
 * to index.html (that made ORT "succeed" the fetch probe then hang on import).
 * Covers `npm run dev -w @chord-ai/web` which skips root `predev`.
 */
function ensureOrtRuntime(): Plugin {
  const publicOrt = path.resolve(__dirname, 'public/ort');
  const nmOrt = path.resolve(__dirname, '../node_modules/onnxruntime-web/dist');

  const sync = () => {
    try {
      const r = syncOrtRuntime({ quiet: false });
      if (r.copied.length) {
        console.log(`[ensure-ort-runtime] synced ${r.copied.join(', ')}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ensure-ort-runtime] ${msg}`);
      throw e;
    }
  };

  return {
    name: 'ensure-ort-runtime',
    buildStart() {
      sync();
    },
    configureServer(server) {
      sync();
      // Register before Vite internals so missing /ort/* never becomes index.html
      server.middlewares.use((req, res, next) => {
        const raw = req.url?.split('?')[0] ?? '';
        if (!raw.startsWith('/ort/')) {
          next();
          return;
        }
        const name = decodeURIComponent(raw.slice('/ort/'.length));
        if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
          res.statusCode = 404;
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          res.end('ORT runtime path not found');
          return;
        }
        const candidates = [path.join(publicOrt, name), path.join(nmOrt, name)];
        for (const file of candidates) {
          if (!existsSync(file) || !statSync(file).isFile()) continue;
          const ext = path.extname(file).toLowerCase();
          const type =
            ext === '.wasm'
              ? 'application/wasm'
              : ext === '.mjs' || ext === '.js'
                ? 'text/javascript; charset=utf-8'
                : 'application/octet-stream';
          const size = statSync(file).size;
          res.statusCode = 200;
          res.setHeader('Content-Type', type);
          res.setHeader('Content-Length', String(size));
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
          // pthread workers are spawned from this script and must be cross-origin isolated themselves.
          res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
          res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
          if (req.method === 'HEAD') {
            res.end();
            return;
          }
          createReadStream(file).pipe(res);
          return;
        }
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(
          `ORT runtime missing: ${name}. ` +
            'Install onnxruntime-web and restart Vite (ensureOrtRuntime copies into web/public/ort).',
        );
      });
    },
  };
}

/**
 * Dev-only: serve v2 ONNX models from a local folder at /models/ (production uses VITE_MODEL_BASE_URL,
 * e.g. the R2 bucket). Folder: $CHORD_AI_MODELS_DIR or <repo>/models-v2 (gitignored).
 */
function serveLocalModels(): Plugin {
  const dir = path.resolve(process.env.CHORD_AI_MODELS_DIR ?? path.resolve(__dirname, '../models-v2'));
  return {
    name: 'serve-local-models',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const raw = req.url?.split('?')[0] ?? '';
        if (!raw.startsWith('/models/')) return next();
        const name = decodeURIComponent(raw.slice('/models/'.length));
        const file = path.join(dir, name);
        if (!name || name.includes('..') || !existsSync(file) || !statSync(file).isFile()) {
          res.statusCode = 404;
          res.end(`model not found: ${name} (put files in ${dir})`);
          return;
        }
        res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : name.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream');
        res.setHeader('Content-Length', String(statSync(file).size));
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
  };
}

/**
 * Dev only: serve onnxruntime-web's ort.wasm.min.mjs untransformed. Vite injects `/@vite/client`
 * into it, and ORT re-loads its own script URL inside the emscripten pthread workers, which then
 * deadlocks InferenceSession.create whenever numThreads > 1.
 */
function rawOrtInDev(): Plugin {
  return {
    name: 'raw-ort-in-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const u = (req.url || '').split('?')[0];
        if (!u.endsWith('/onnxruntime-web/dist/ort.wasm.min.mjs')) return next();
        res.setHeader('Content-Type', 'text/javascript');
        res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        res.end(readFileSync(ortWasmExtern));
      });
    },
  };
}

const ortWasmExtern = path.resolve(
  __dirname,
  '../node_modules/onnxruntime-web/dist/ort.wasm.min.mjs',
);

export default defineConfig({
  plugins: [rawOrtInDev(), react(), ensureOrtRuntime(), serveLocalModels(), stripBundledOrtWasm()],
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
