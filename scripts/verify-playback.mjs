#!/usr/bin/env node
/**
 * Smoke-test chord playback APIs in headless Chrome (AudioContext + MIDI bytes).
 * Usage: node scripts/verify-playback.mjs
 */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.BASE_URL || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';

async function waitForVite(url, tries = 60) {
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
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'],
    });
    const page = await browser.newPage();
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => !!window.__chordAi?.playSingleChord);

    // User-gesture resume path
    await page.click('body');

    const result = await page.evaluate(async () => {
      const api = window.__chordAi;
      const midi = api.resolveChordMidi('C', 'guitar');
      const piano = api.resolveChordMidi('Am7', 'piano');
      await api.playSingleChord('C', {
        instrument: 'guitar',
        strum: 'strum',
        volume: 0.5,
        durationSec: 0.4,
      });
      const ctx = api.getChordSynth().context;
      const state = ctx?.state ?? 'missing';

      let idx = -1;
      const handle = await api.playProgression(
        [
          { tMs: 0, endMs: 300, chord: 'C' },
          { tMs: 300, endMs: 600, chord: 'G' },
          { tMs: 600, endMs: 900, chord: 'Am' },
        ],
        {
          instrument: 'piano',
          strum: 'block',
          volume: 0.4,
          rate: 2,
          onIndex: (i) => {
            if (i != null) idx = i;
          },
        },
      );
      await new Promise((r) => setTimeout(r, 600));
      handle.stop();

      const mid = api.buildMidiFile(
        [
          { tMs: 0, endMs: 500, chord: 'C' },
          { tMs: 500, endMs: 1000, chord: 'F' },
        ],
        { bpm: 100, instrument: 'ukulele', title: 'verify' },
      );
      const head = String.fromCharCode(...new Uint8Array(mid).slice(0, 4));
      return { midi, piano, state, idx, midHead: head, midBytes: mid.byteLength };
    });

    console.log(result);
    if (!result.midi?.length) throw new Error('guitar voicing empty');
    if (!result.piano?.length) throw new Error('piano voicing empty');
    if (result.state !== 'running') throw new Error(`AudioContext state=${result.state}`);
    if (result.idx < 0) throw new Error('progression never highlighted');
    if (result.midHead !== 'MThd') throw new Error('midi header bad');
    console.log('OK — playback + MIDI export');
    await browser.close();
  } finally {
    if (viteProc) viteProc.kill('SIGTERM');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
