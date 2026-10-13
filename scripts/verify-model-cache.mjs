#!/usr/bin/env node
/**
 * Verify UMX ONNX models persist in Cache Storage (2nd use + reload).
 * ORT runtime is same-origin /ort/ (not Cache-Storaged).
 *
 * Usage: npm run sync:ort && node scripts/verify-model-cache.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

function isOnnx(url) {
  return /\.onnx(\?|$)/i.test(url);
}

async function waitForVite(url, tries = 80) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
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
    viteProc = spawn(
      'npm',
      ['run', 'dev', '-w', '@chord-ai/web', '--', '--host', 'localhost', '--port', '5173'],
      {
        cwd: new URL('..', import.meta.url).pathname,
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '0' },
      },
    );
  }
  try {
    await waitForVite(BASE);
    const browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
    const page = await browser.newPage();

    const onnxNet = [];
    page.on('request', (req) => {
      const u = req.url();
      if (isOnnx(u)) onnxNet.push({ url: u, phase: page.__phase || '?' });
    });

    async function countOnnxSince(phase, fn) {
      page.__phase = phase;
      const before = onnxNet.length;
      await fn();
      return onnxNet.slice(before);
    }

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi);
    await page.evaluate(() => window.__chordAi.clearModelCache());
    await sleep(300);

    console.log('Phase A: first prefetch (expect ONNX network)…');
    const first = await countOnnxSince('A', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    console.log(`  onnx network: ${first.length}`);
    if (first.length < 1) throw new Error('Expected .onnx download on first prefetch');
    const statusA = await page.evaluate(() =>
      window.__chordAi.getModelCacheStatus({ useBass: true }),
    );
    console.log('  cache allCached=', statusA.allCached, 'bytes=', statusA.totalBytes);
    if (!statusA.allCached) throw new Error('Models not fully cached after first prefetch');

    console.log('Phase B: second prefetch (expect 0 ONNX network)…');
    const second = await countOnnxSince('B', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    console.log(`  onnx network: ${second.length}`);
    if (second.length !== 0) throw new Error('Second prefetch hit ONNX network');

    console.log('Phase C: reload + prefetch (expect 0 ONNX network)…');
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi);
    const afterReload = await countOnnxSince('C', async () => {
      await page.evaluate(async () => {
        await window.__chordAi.prefetchModels({ preferWebGpu: false, useBass: true });
      });
    });
    console.log(`  onnx network after reload: ${afterReload.length}`);
    if (afterReload.length !== 0) throw new Error('After reload, ONNX still downloaded');

    console.log('OK — ONNX Cache Storage persists; ORT stays same-origin /ort/');
    await browser.close();
  } finally {
    if (viteProc) viteProc.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
