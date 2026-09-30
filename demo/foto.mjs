// Saca fotos del cerebro en momentos exactos (modo captura, sin depender de la pantalla).
// Uso: node foto.mjs 1,3,6,10   (segundos)   — con el servidor corriendo.
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL = process.env.URL || 'http://127.0.0.1:7777/?capture';
const times = (process.argv[2] || '1,2.5,4,6,9').split(',').map(Number);
const OUT = process.argv[3] || 'fotos';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--window-size=1920,1080', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('console', m => { if (['error', 'warning'].includes(m.type()) && !m.text().includes('Clock')) console.log('console:', m.text()); });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(URL, { waitUntil: 'load' });
await page.waitForFunction(() => window.cerebro?.brain?.graph && window.__cerebroStep, { timeout: 30000 });
fs.mkdirSync(OUT, { recursive: true });
if (process.env.SETUP) await page.evaluate(process.env.SETUP);
let t = 0;
const t0 = Date.now();
for (const target of times) {
  t = await page.evaluate(async target => { let t = 0; while ((t = window.__cerebroStep(1 / 30)) < target); return t; }, target);
  await page.screenshot({ path: `${OUT}/t_${String(target).padStart(5, '0')}.jpg`, type: 'jpeg', quality: 88 });
  console.log('foto', target.toFixed(2), 's', ((Date.now() - t0) / 1000).toFixed(1) + 's reales');
}
await browser.close();
