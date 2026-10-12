#!/usr/bin/env node
/**
 * E2E: real UMX separation in Chromium (wasm EP, same-origin /ort/).
 * Asserts ok:true and no fallback — fails if worker returns an error.
 *
 * Usage: npm run sync:ort && npm run verify:separation
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const root = new URL('..', import.meta.url).pathname;

async function waitForVite(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const ort = await fetch(new URL('/ort/ort-wasm-simd-threaded.mjs', url));
        if (ort.ok) return;
        console.log('waiting for /ort/ …', ort.status);
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`Vite/ort not reachable at ${url}`);
}

async function main() {
  if (!existsSync(join(root, 'web/public/ort/ort-wasm-simd-threaded.wasm'))) {
    console.log('syncing ORT runtime…');
    await new Promise((resolve, reject) => {
      const p = spawn('node', ['scripts/sync-ort-runtime.mjs'], {
        cwd: root,
        stdio: 'inherit',
      });
      p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('sync:ort failed'))));
    });
  }

  let viteProc = null;
  if (!process.env.BASE_URL) {
    viteProc = spawn('npm', ['run', 'dev', '-w', '@chord-ai/web', '--', '--host', 'localhost', '--port', '5173'], {
      cwd: root,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    viteProc.stderr?.on('data', (d) => process.stderr.write(d));
  }

  try {
    await waitForVite(BASE);
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--enable-features=SharedArrayBuffer',
      ],
    });
    const page = await browser.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi?.separateInWorker);
    await page.click('body');

    // Clear any poisoned v1 cache from older builds
    await page.evaluate(async () => {
      await window.__chordAi.clearModelCache();
    });

    console.log('Running separation (vocals+bass, ~2s sine)…');
    const result = await page.evaluate(async () => {
      const sr = 44100;
      const n = Math.floor(sr * 2);
      const samples = new Float32Array(n);
      // Mix: 110 Hz “bass” + 440 Hz + 880 Hz “vocal-ish”
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        samples[i] =
          0.35 * Math.sin(2 * Math.PI * 110 * t) +
          0.25 * Math.sin(2 * Math.PI * 440 * t) +
          0.15 * Math.sin(2 * Math.PI * 880 * t);
      }
      const progress = [];
      try {
        const stems = await window.__chordAi.separateInWorker(samples, sr, {
          preferWebGpu: false,
          useBass: true,
          onProgress: (p, detail, fromCache) => {
            progress.push({ p, detail, fromCache });
          },
        });
        const energy = (ch) => {
          let s = 0;
          const x = ch.left;
          for (let i = 0; i < x.length; i++) s += x[i] * x[i];
          return s;
        };
        return {
          ok: true,
          sources: stems.sources,
          sampleRate: stems.sampleRate,
          lengths: {
            vocals: stems.vocals.left.length,
            bass: stems.bass.left.length,
            other: stems.other.left.length,
          },
          energy: {
            vocals: energy(stems.vocals),
            bass: energy(stems.bass),
            other: energy(stems.other),
          },
          progressTail: progress.slice(-5),
          ortProbe: await fetch('/ort/ort-wasm-simd-threaded.mjs').then((r) => r.status),
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          progressTail: progress.slice(-8),
        };
      }
    });

    console.log(JSON.stringify(result, null, 2));
    if (consoleErrors.length) {
      console.log('console errors:', consoleErrors.slice(0, 10));
    }

    if (!result.ok) {
      throw new Error(`Separation failed: ${result.error}`);
    }
    if (/no available backend|initWasm|Failed to fetch dynamically imported/i.test(
      JSON.stringify(result),
    )) {
      throw new Error('ORT backend error signature in result');
    }
    if (result.lengths.vocals < 1000) throw new Error('stems too short');
    // Second run must hit memory/cache for models
    console.log('Second separation (expect cache/memory model sources)…');
    const second = await page.evaluate(async () => {
      const sr = 44100;
      const n = Math.floor(sr * 1.5);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr);
      const stems = await window.__chordAi.separateInWorker(samples, sr, {
        preferWebGpu: false,
        useBass: true,
      });
      return stems.sources;
    });
    console.log('second sources', second);
    if (second.vocals === 'network' || second.bass === 'network') {
      throw new Error('Second run re-downloaded ONNX (cache broken)');
    }

    console.log('OK — separation succeeded without fallback; ONNX cache works');
    await browser.close();
  } finally {
    if (viteProc) viteProc.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
