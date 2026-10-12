#!/usr/bin/env node
/**
 * E2E: real UMX separation in Chromium (wasm EP, same-origin /ort/).
 * Asserts ok:true and no fallback — fails if worker returns an error.
 *
 * Starts Vite via `npm run dev -w @chord-ai/web` (skips root predev) and
 * relies on the ensureOrtRuntime Vite plugin to populate /ort/.
 *
 * Usage: npm run verify:separation
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const root = new URL('..', import.meta.url).pathname;
/** When starting our own Vite, delete public/ort first to prove the plugin. */
const PROVE_PLUGIN = process.env.PROVE_ORT_PLUGIN !== '0';

async function assertOrtIsJs(url) {
  const ort = await fetch(new URL('/ort/ort-wasm-simd-threaded.mjs', url));
  if (!ort.ok) throw new Error(`/ort/...mjs HTTP ${ort.status}`);
  const ct = (ort.headers.get('content-type') || '').toLowerCase();
  const body = await ort.text();
  const head = body.trimStart().slice(0, 120);
  if (ct.includes('text/html') || head.startsWith('<!DOCTYPE') || head.startsWith('<html')) {
    throw new Error(
      `/ort/ort-wasm-simd-threaded.mjs returned HTML (SPA fallback). content-type=${ct}`,
    );
  }
  if (!/export|function|const|let|var|import/i.test(head)) {
    throw new Error(`/ort/...mjs does not look like JavaScript: ${head.slice(0, 60)}`);
  }
  const wasm = await fetch(new URL('/ort/ort-wasm-simd-threaded.wasm', url), {
    method: 'HEAD',
  });
  if (!wasm.ok) {
    const g = await fetch(new URL('/ort/ort-wasm-simd-threaded.wasm', url));
    if (!g.ok) throw new Error(`/ort/...wasm HTTP ${g.status}`);
    await g.body?.cancel?.();
  }
}

async function waitForVite(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        await assertOrtIsJs(url);
        return;
      }
    } catch (e) {
      if (i % 10 === 9) console.log('waiting…', e instanceof Error ? e.message : e);
    }
    await sleep(500);
  }
  throw new Error(`Vite/ort not reachable at ${url}`);
}

async function main() {
  let viteProc = null;
  if (!process.env.BASE_URL) {
    if (PROVE_PLUGIN) {
      const ortDir = join(root, 'web/public/ort');
      for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm']) {
        const p = join(ortDir, f);
        if (existsSync(p)) {
          rmSync(p);
          console.log('removed', p, '(prove ensureOrtRuntime plugin)');
        }
      }
    }
    // Free the port so Vite does not silently move to 5174 while we poll 5173.
    try {
      spawn('fuser', ['-k', '5173/tcp'], { stdio: 'ignore' });
    } catch {
      /* ignore */
    }
    await sleep(500);
    viteProc = spawn(
      'npm',
      [
        'run',
        'dev',
        '-w',
        '@chord-ai/web',
        '--',
        '--host',
        'localhost',
        '--port',
        '5173',
        '--strictPort',
      ],
      {
        cwd: root,
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );
    viteProc.stderr?.on('data', (d) => process.stderr.write(d));
    viteProc.stdout?.on('data', (d) => process.stdout.write(d));
  }

  try {
    await waitForVite(BASE);
    console.log('ORT /ort/ OK (JavaScript, not SPA HTML)');

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
    const failedRequests = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (e) => consoleErrors.push(String(e)));
    page.on('requestfailed', (req) => {
      failedRequests.push(`${req.failure()?.errorText || 'fail'} ${req.url()}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) failedRequests.push(`${res.status()} ${res.url()}`);
    });

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
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        samples[i] =
          0.35 * Math.sin(2 * Math.PI * 110 * t) +
          0.25 * Math.sin(2 * Math.PI * 440 * t) +
          0.15 * Math.sin(2 * Math.PI * 880 * t);
      }
      const progress = [];
      let maxP = 0;
      try {
        const stems = await window.__chordAi.separateInWorker(samples, sr, {
          preferWebGpu: false,
          useBass: true,
          onProgress: (p, detail, fromCache) => {
            maxP = Math.max(maxP, p);
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
          maxProgress: maxP,
          progressTail: progress.slice(-5),
          ortProbe: await fetch('/ort/ort-wasm-simd-threaded.mjs').then(async (r) => {
            const t = await r.text();
            return {
              status: r.status,
              ct: r.headers.get('content-type'),
              html: /^\s*</.test(t),
            };
          }),
        };
      } catch (e) {
        return {
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          maxProgress: maxP,
          progressTail: progress.slice(-8),
        };
      }
    });

    console.log(JSON.stringify(result, null, 2));
    if (consoleErrors.length) {
      console.log('console errors:', consoleErrors.slice(0, 10));
    }
    const ortRelatedFail = failedRequests.filter(
      (u) =>
        /ort-wasm|jsep|onnxruntime|\/ort\//i.test(u) &&
        !/ERR_ABORTED|ERR_CACHE/i.test(u),
    );
    if (ortRelatedFail.length) {
      console.log('ORT-related failed requests:', ortRelatedFail.slice(0, 10));
      throw new Error(`ORT asset request failed: ${ortRelatedFail[0]}`);
    }

    if (!result.ok) {
      throw new Error(`Separation failed: ${result.error}`);
    }
    if (result.ortProbe?.html) {
      throw new Error('ORT mjs served as HTML during separation');
    }
    if (result.maxProgress < 0.9) {
      throw new Error(`Progress never reached ~100% (max=${result.maxProgress})`);
    }
    if (
      /no available backend|initWasm|Failed to fetch dynamically imported|jsep|timed out|SPA fallback/i.test(
        JSON.stringify(result),
      )
    ) {
      throw new Error('ORT backend error signature in result');
    }
    if (result.lengths.vocals < 1000) throw new Error('stems too short');

    console.log('Second separation (expect cache/memory model sources)…');
    const second = await page.evaluate(async () => {
      const sr = 44100;
      const n = Math.floor(sr * 1.5);
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / sr);
      let maxP = 0;
      const progress = [];
      const stems = await window.__chordAi.separateInWorker(samples, sr, {
        preferWebGpu: false,
        useBass: true,
        onProgress: (p, detail, fromCache) => {
          maxP = Math.max(maxP, p);
          progress.push({ p, detail, fromCache });
        },
      });
      return { sources: stems.sources, maxProgress: maxP, progressTail: progress.slice(-4) };
    });
    console.log('second', second);
    if (second.sources.vocals === 'network' || second.sources.bass === 'network') {
      throw new Error('Second run re-downloaded ONNX (cache broken)');
    }
    if (second.maxProgress < 0.9) {
      throw new Error(`Cached run progress stuck (max=${second.maxProgress})`);
    }

    console.log('OK — separation succeeded without fallback; ONNX cache works; progress → 100%');
    await browser.close();
    process.exit(0);
  } finally {
    if (viteProc) {
      viteProc.kill('SIGTERM');
      setTimeout(() => {
        try {
          viteProc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, 1500).unref?.();
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
