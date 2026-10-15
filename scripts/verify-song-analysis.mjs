/**
 * Headless check of 歌曲分析: upload local audio (+ optional local lyrics), wait for sections, play, screenshot,
 * dump the analysis JSON. Usage: BASE=http://localhost:5180 node scripts/verify-song-analysis.mjs <audio> [lyrics.txt] [outDir] [name]
 * Audio and lyrics stay local; nothing is committed.
 */
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';

const [audio, lyricsPath, outDir = '/tmp', name = 'song'] = process.argv.slice(2);
const BASE = process.env.BASE || 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/local/bin/google-chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
page.on('console', (m) => { const t = m.text(); if (m.type() === 'error' || /\[v2w\]|\[sa\]/.test(t)) console.error('[console]', m.type(), t.slice(0, 300)); });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.exposeFunction('__dump', (s) => writeFileSync(`${outDir}/${name}.json`, s));
await page.getByTestId('audio-file').setInputFiles(audio);
if (lyricsPath && lyricsPath !== '-') await page.getByTestId('lyrics-input').fill(readFileSync(lyricsPath, 'utf8'));
const t0 = Date.now();
await page.getByTestId('analyze').click();
await page.waitForTimeout(15000);
await page.screenshot({ path: `${outDir}/${name}-progress.png` });
const iv = setInterval(async () => { try { console.error('[t+' + ((Date.now() - t0) / 1000).toFixed(0) + 's]', (await page.getByTestId('staged-progress').innerText()).replace(/\n/g, ' | ')); } catch {} }, 30000);
await page.locator('.sa-sec').first().waitFor({ timeout: 1_200_000 });
clearInterval(iv);
console.error('done in', (Date.now() - t0) / 1000, 's');
await page.evaluate(() => window.__saDump && window.__dump(JSON.stringify(window.__saDump())));
if (process.env.DUMP_VOCALS) {
  const b64 = await page.evaluate(() => { const v = globalThis.__saVoc16k; const u = new Uint8Array(v.buffer); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); });
  writeFileSync(`${outDir}/${name}.voc16k.f32`, Buffer.from(b64, 'base64'));
}
const secs = await page.locator('.sa-sec').evaluateAll((els) => els.map((e) => e.getAttribute('title')));
console.log(secs.join('\n'));
// play from the 3rd section, synth on
const third = page.locator('.sa-sec').nth(Math.min(2, secs.length - 1));
await page.getByTestId('synth-toggle').check();
await third.click();
await page.evaluate(() => { const a = document.querySelector('[data-testid=song-audio]'); a.muted = true; });
await page.getByTestId('play').click();
await page.waitForTimeout(4000);
console.log('now:', await page.getByTestId('now').innerText(), await page.getByTestId('clock').innerText());
await page.screenshot({ path: `${outDir}/${name}-playing.png`, fullPage: true });
await page.getByTestId('rep-toggle').check();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/${name}-rep.png`, fullPage: true });
await browser.close();
