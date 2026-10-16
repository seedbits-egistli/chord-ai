/**
 * Fast layout check of the 五線譜 view from a saved analysis JSON (dumped by verify-song-analysis.mjs).
 * Usage: BASE=... node scripts/verify-staff.mjs <audio> <analysis.json> <outPrefix>
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';
const [audio, json, out] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
for (const [tag, vw] of [['1280', 1280], ['390', 390]]) {
  const page = await browser.newPage({ viewport: { width: vw, height: 1000 }, deviceScaleFactor: vw < 500 ? 2 : 1 });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error('[console]', m.text().slice(0, 200)); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.getByTestId('audio-file').setInputFiles(audio);
  await page.evaluate((j) => window.__saLoad(JSON.parse(j)), readFileSync(json, 'utf8'));
  await page.getByTestId('view-staff').click();
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => { const s = document.querySelector('[data-testid=staff-view] svg'); return s ? { w: s.getAttribute('width'), h: s.getAttribute('height') } : null; });
  console.log(tag, 'svg', JSON.stringify(info));
  await page.getByTestId('staff-view').screenshot({ path: `${out}-staff-${tag}.png` });
  // playback: seek to ~70 s, play muted, check highlight + scroll
  await page.evaluate(() => { const a = document.querySelector('[data-testid=song-audio]'); a.muted = true; a.currentTime = 70; return a.play(); });
  await page.waitForTimeout(2500);
  const st = await page.evaluate(() => ({ scroll: document.querySelector('[data-testid=staff-view]').scrollTop, hl: document.querySelectorAll('.sa-staff-cur').length, rect: [...document.querySelectorAll('[data-testid=staff-view] rect[visibility=visible]')].length }));
  console.log(tag, 'playing', JSON.stringify(st));
  await page.screenshot({ path: `${out}-playing-${tag}.png`, fullPage: false });
  await page.getByTestId('staff-view').screenshot({ path: `${out}-staff-playing-${tag}.png` });
  await page.close();
}
await browser.close();
