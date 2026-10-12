#!/usr/bin/env node
/**
 * Verify UMX/ORT assets are served from Cache Storage on 2nd use and after reload.
 * Requires: google-chrome, playwright-core, `npm run dev -w @chord-ai/web` on :5173
 *   (or set BASE_URL).
 *
 * Usage: node scripts/verify-model-cache.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

function isModelOrOrt(url) {
  return (
    /\.onnx(\?|$)/i.test(url) ||
    /onnxruntime-web@/i.test(url) ||
    /ort-wasm/i.test(url)
  );
}

async function waitForVite(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 200) return;
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  throw new Error(`Vite not reachable at ${url}`);
}

async function main() {
  let viteProc = null;
  if (!process.env.BASE_URL) {
    viteProc = spawn('npm', ['run', 'dev', '-w', '@chord-ai/web'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'pipe',
      env: { ...process.env, FORCE_COLOR: '0' },
    });
  }
  try {
    await waitForVite(BASE);
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    const net = [];
    page.on('request', (req) => {
      const u = req.url();
      if (isModelOrOrt(u) && req.resourceType() !== 'xhr' || isModelOrOrt(u)) {
        // count all model/ort requests
        if (isModelOrOrt(u)) net.push({ url: u, ts: Date.now(), phase: page.__phase || '?' });
      }
    });

    async function countSince(phase, fn) {
      page.__phase = phase;
      const before = net.length;
      await fn();
      const slice = net.slice(before);
      return slice;
    }

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi);

    // Start clean
    await page.evaluate(() => window.__chordAi.clearModelCache());
    await sleep(300);

    console.log('Phase A: first prefetch (expect network downloads)…');
    const first = await countSince('A', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    const firstOnnx = first.filter((r) => /\.onnx/i.test(r.url));
    console.log(`  network model/ort requests: ${first.length} (onnx: ${firstOnnx.length})`);
    if (firstOnnx.length < 1) {
      throw new Error('Expected at least one .onnx network download on first prefetch');
    }
    const statusA = await page.evaluate(() => window.__chordAi.getModelCacheStatus({ useBass: true }));
    console.log('  cache allCached=', statusA.allCached, 'bytes=', statusA.totalBytes);
    if (!statusA.allCached) throw new Error('Models not fully cached after first prefetch');

    console.log('Phase B: second prefetch same session (expect 0 network)…');
    const second = await countSince('B', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    console.log(`  network model/ort requests: ${second.length}`);
    if (second.length !== 0) {
      console.error(second);
      throw new Error('Second prefetch hit the network — cache/memory failed');
    }

    console.log('Phase C: short separate() then again (long-lived worker)…');
    const sine = await page.evaluate(async () => {
      const sr = 44100;
      const n = sr; // 1s
      const samples = new Float32Array(n);
      for (let i = 0; i < n; i++) samples[i] = 0.2 * Math.sin((2 * Math.PI * 440 * i) / sr);
      const r1 = await window.__chordAi.separateInWorker(samples, sr, {
        preferWebGpu: false,
        useBass: true,
      });
      const r2 = await window.__chordAi.separateInWorker(samples, sr, {
        preferWebGpu: false,
        useBass: true,
      });
      return { s1: r1.sources, s2: r2.sources };
    });
    console.log('  sources run1', sine.s1);
    console.log('  sources run2', sine.s2);
    if (sine.s2.vocals === 'network' || sine.s2.bass === 'network') {
      throw new Error('Second analysis re-downloaded models');
    }

    // Count network during the two separates — onnx should be 0 (already cached in B)
    // (requests were recorded live; filter phase C by checking last entries after the evaluate)
    // Re-run with explicit counter:
    const sepNet = await countSince('C2', async () => {
      await page.evaluate(async () => {
        const sr = 44100;
        const n = sr;
        const samples = new Float32Array(n);
        for (let i = 0; i < n; i++) samples[i] = 0.1 * Math.sin((2 * Math.PI * 220 * i) / sr);
        await window.__chordAi.separateInWorker(samples, sr, {
          preferWebGpu: false,
          useBass: true,
        });
      });
    });
    const sepOnnx = sepNet.filter((r) => /\.onnx/i.test(r.url));
    console.log(`  analysis network onnx: ${sepOnnx.length}`);
    if (sepOnnx.length !== 0) {
      console.error(sepOnnx);
      throw new Error('Analysis after cache still downloaded .onnx');
    }

    console.log('Phase D: reload page, prefetch again (expect 0 network)…');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi);
    const afterReload = await countSince('D', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    console.log(`  network model/ort requests after reload: ${afterReload.length}`);
    if (afterReload.length !== 0) {
      console.error(afterReload);
      throw new Error('After reload, prefetch still hit the network');
    }
    const statusD = await page.evaluate(() => window.__chordAi.getModelCacheStatus({ useBass: true }));
    if (!statusD.allCached) throw new Error('Cache missing after reload');

    console.log('OK — model cache persists across analyses and reload');
    await browser.close();
  } finally {
    if (viteProc) viteProc.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
