/**
 * Headless check of 精準 v2 in Chromium: upload a local audio file (+ optional local lyrics),
 * record per-stage timings, then screenshot the desktop (UG) and mobile (ChordPro) chart during playback.
 * Usage: BASE=http://localhost:5180 node scripts/verify-v2.mjs <audio> [lyrics.txt] [outDir]
 * Audio and lyrics stay local; nothing is committed.
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'node:fs';

const [audio, lyricsPath, outDir = '/tmp'] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:5173';
const CHROME = process.env.CHROME_PATH || '/usr/local/bin/google-chrome';
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const log = [];
page.on('console', (m) => { if (m.type() !== 'debug') console.error('[console]', m.type(), m.text().slice(0, 300)); if (m.type() === 'error') log.push(m.text()); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('worker', (w) => console.error('[worker]', w.url()));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByTestId('mode-v2').check();
if (lyricsPath) await page.getByTestId('lyrics-input').fill(readFileSync(lyricsPath, 'utf8'));
const t0 = Date.now();
const dump = setInterval(async () => { try { console.error('[t+' + ((Date.now() - t0) / 1000).toFixed(0) + 's]', (await page.getByTestId('staged-progress').innerText()).replace(/\n/g, ' | '), '||', await page.locator('.status').first().innerText()); } catch (e) { console.error('[dump]', e.message.slice(0, 100)); } }, 20_000);
const marks = {};
const poll = setInterval(async () => {
  try {
    const txt = await page.getByTestId('staged-progress').innerText();
    for (const s of ['下載模型', '分離人聲', '偵測節拍', '辨識和弦', '對齊歌詞']) {
      const m = new RegExp(`${s}\\s*\\n?\\s*完成`).test(txt);
      if (m && !marks[s]) marks[s] = (Date.now() - t0) / 1000;
    }
  } catch { /* not rendered yet */ }
}, 250);
await page.locator('input[type=file]').setInputFiles(audio);
await page.waitForTimeout(20_000);
await page.screenshot({ path: `${outDir}/v2-progress.png` });
await page.locator('p.status', { hasText: /和弦完成/ }).waitFor({ timeout: 900_000 });
marks.chordsVisible = (Date.now() - t0) / 1000;
if (lyricsPath) {
  await page.locator('p.status', { hasText: /歌詞已對齊/ }).waitFor({ timeout: 900_000 });
  marks.lyricsVisible = (Date.now() - t0) / 1000;
}
clearInterval(poll);
clearInterval(dump);
const status = await page.locator('.status').first().innerText();
// karaoke: seek & play the local audio
await page.evaluate(async () => {
  const a = document.querySelector('[data-testid=local-audio]');
  a.currentTime = 9.5;
  a.muted = true;
  await a.play();
});
await page.waitForTimeout(1500);
const chart = page.locator('.accomp');
await chart.scrollIntoViewIfNeeded();
await page.screenshot({ path: `${outDir}/v2-desktop.png`, fullPage: false, clip: await chart.boundingBox().then((b) => ({ x: 0, y: b.y, width: 1280, height: Math.min(1400, b.height) })) });
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(800);
const b2 = await chart.boundingBox();
await page.screenshot({ path: `${outDir}/v2-mobile.png`, clip: { x: 0, y: b2.y, width: 390, height: Math.min(1600, b2.height) } });
console.log(JSON.stringify({ marks, status, errors: log.slice(0, 5) }, null, 1));
await browser.close();
