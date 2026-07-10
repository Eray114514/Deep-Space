// Boot a list of seeds headless (no landings) and print each system's
// planet types — used to find seeds carrying a wanted planet type.
import { startServer } from './server.js';
import { chromium } from 'playwright';

const SEEDS = (process.env.SEEDS || 'ATLAS,NEXUS-9,OMEGA,HILBERT,CALYPSO,ZETA,ORIGINS,PILGRIM').split(',');
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader-webgl'],
});
const page = await browser.newPage({ viewport: { width: 320, height: 200 } });
for (const seed of SEEDS) {
  await page.goto(`http://127.0.0.1:${port}/?seed=${encodeURIComponent(seed)}&nolock=1&buildms=40&post=0&vclouds=0`);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });
  const planets = await page.evaluate('window.NMS.planets()');
  console.log(seed, '→', planets.map((p) => `${p.type}${p.isMoon ? '(m)' : ''}`).join(' '));
}
await browser.close();
server.close();
process.exit(0);
