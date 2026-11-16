// Fixed-camera surface captures for the planet-surface rewrite (batch T).
// One hardware-GPU Chrome page walks the same ladder every run — far orbit,
// approach, high and low flight, standing on the ground — so before/after
// pairs line up shot for shot. See docs/planet-surface-rewrite.md.
//
//   node tools/surface-shots.js [--out test-results/surface-shots/<name>]
//     [--planet 0] [--only orbit,walk] [--hud] [--clouds] [--query "a=1&b=2"]
//
// The clear-sky weather fixture is the default: this tool judges the ground.
// (vclouds=0 is not a substitute, it brings back the opaque legacy cloud shell.)

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { resolveSystemChromePath } from './browser.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const OUT = option('out', `test-results/surface-shots/${new Date().toISOString().replace(/[:.]/g, '-')}`);
const PLANET = Number(option('planet', 0));
const ONLY = option('only', '').split(',').filter(Boolean);
const WIDTH = Number(option('width', 1600));
const HEIGHT = Number(option('height', 900));

// metres are above the terrain under the camera; pitch is radians (negative
// looks down from the horizon)
const flight = (metres, pitch) => (i, site) => {
  const altFactor = (site.terrainRadius - site.R + metres) / site.R;
  const opts = JSON.stringify({ dir: site.dir, horizon: true, pitch });
  return `NMS.teleport(${i}, ${altFactor}, ${opts})`;
};
const SCENES = [
  { name: '01-orbit-disk', js: (i) => `NMS.teleport(${i}, 1.6)` },
  { name: '02-orbit-300km', js: flight(300000, -1.2) },
  { name: '03-orbit-100km', js: flight(100000, -0.9) },
  { name: '04-high-30km', js: flight(30000, -0.5) },
  { name: '05-flight-8km', js: flight(8000, -0.32) },
  { name: '06-flight-2km', js: flight(2000, -0.22) },
  { name: '07-flight-400m', js: flight(400, -0.14) },
  { name: '08-walk', js: (i) => `NMS.land(${i}, 0, 'meadow')` },
  { name: '09-walk-turn', js: (i) => `NMS.land(${i}, 140, 'meadow')` },
];

await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || resolveSystemChromePath();
if (!executablePath) throw new Error('No system Chrome/Edge found; set PLAYWRIGHT_EXECUTABLE_PATH');
const browser = await chromium.launch({
  executablePath,
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
const errors = [];
page.on('pageerror', (error) => { errors.push(String(error)); console.error('PAGEERROR:', String(error).split('\n')[0]); });

const query = ['nohero=1', flag('clouds') ? '' : 'weather=clear', option('query', '')].filter(Boolean).join('&');
await page.goto(`http://127.0.0.1:${port}/?${query}`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 180000 });
if (!flag('hud')) {
  await page.addStyleTag({ content: 'body > *:not(#app) { visibility: hidden !important; }' });
}

// every flight shot hangs over the same inland meadow the walk shots stand on
await page.evaluate(`NMS.land(${PLANET}, 0, 'meadow')`);
await page.waitForTimeout(500);
// mid-afternoon light, frozen: relief reads through its shadows and every run matches
await page.evaluate(`NMS.setSunAltitude(${PLANET}, ${Number(option('sun', 38))}); NMS.setTimeFrozen(true)`);
const site = await page.evaluate(`(() => {
  const ref = NMS.referenceState();
  const len = Math.hypot(...ref.playerLocal);
  return {
    dir: ref.playerLocal.map((v) => v / len),
    terrainRadius: ref.terrainRadius,
    R: NMS.planets()[${PLANET}].R,
  };
})()`);

const report = [];
for (const scene of SCENES) {
  if (ONLY.length && !ONLY.some((part) => scene.name.includes(part))) continue;
  const ok = await page.evaluate(scene.js(PLANET, site));
  if (ok === false) { console.warn(`${scene.name}: scene unavailable`); continue; }
  try {
    await page.waitForFunction('window.NMS.idle()', null, { timeout: 90000 });
  } catch {
    console.warn(`${scene.name}: settle timeout (continuing)`);
  }
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/${scene.name}.png` });
  const stats = await page.evaluate('window.NMS.stats()');
  report.push({ scene: scene.name, draws: stats.calls, tris: stats.tris, chunks: stats.chunks, alt: Math.round(stats.alt) });
  console.log(`ok ${scene.name}  draws=${stats.calls} tris=${(stats.tris / 1e6).toFixed(2)}M chunks=${stats.chunks} alt=${Math.round(stats.alt)}`);
}

await writeFile(`${OUT}/report.json`, JSON.stringify({ query, planet: PLANET, width: WIDTH, height: HEIGHT, site, report, errors }, null, 2));
await browser.close();
server.close();
console.log(`saved to ${OUT}`);
if (errors.length) process.exitCode = 1;
