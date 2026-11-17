// Fixed-camera surface captures for the planet-surface rewrite (batch T).
// One hardware-GPU Chrome page walks the same ladder every run — far orbit,
// approach, high and low flight, standing on the ground — so before/after
// pairs line up shot for shot. See docs/planet-surface-rewrite.md.
//
//   node tools/surface-shots.js [--out test-results/surface-shots/<name>]
//     [--planet 0] [--only orbit,walk] [--hud] [--clouds] [--query "a=1&b=2"]
//
// Reuse a captured forest location with --site forest --site-report path/to/report.json.
// The clear-sky weather fixture is the default: this tool judges the ground.
// (vclouds=0 is not a substitute, it brings back the opaque legacy cloud shell.)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
  { name: '07b-flight-15m', js: flight(15, -0.18) },
  { name: '08-walk', js: (i) => `NMS.land(${i}, 0, 'meadow')` },
  { name: '09-walk-turn', js: (i) => `NMS.land(${i}, 140, 'meadow')` },
  { name: '10-walk-ground', js: (i) => `NMS.land(${i}, 60, 'meadow'); NMS.lookPitch(-55)` },
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

// --site forest: move every shot to closed woodland near the meadow, in the
// same daylight, and add shots from inside the trees with the ship hidden
if (option('site', 'meadow') === 'forest') {
  const prior = option('site-report', '');
  const forest = prior ? JSON.parse(await readFile(prior, 'utf8')).site : await page.evaluate(`(() => {
    const p = NMS._ff.planet;
    if (!p) return null;
    const base = ${JSON.stringify(site.dir)};
    const V = p.sunDirLocal.constructor;
    const up = new V(...base), e1 = new V(-up.z, 0, up.x).normalize(), e2 = new V().crossVectors(up, e1);
    const at = (x, y) => new V().copy(up).addScaledVector(e1, x / p.R).addScaledVector(e2, y / p.R).normalize();
    const wooded = (d) => { const h = p.height(d, p.fullMaxFreq); return p.biomeAt(d, h) === 'forest' ? h : null; };
    for (let ring = 1; ring < 400; ring++) {
      for (let k = 0; k < 12; k++) {
        const a = k / 12 * Math.PI * 2 + ring * 0.7, r = ring * 1500;
        const x = Math.cos(a) * r, y = Math.sin(a) * r, d = at(x, y), h = wooded(d);
        if (h == null || d.dot(p.sunDirLocal) < 0.45) continue;
        if ([[400, 0], [-400, 0], [0, 400], [0, -400]].every(([ox, oy]) => wooded(at(x + ox, y + oy)) != null)) {
          return { dir: d.toArray(), terrainRadius: p.R + h, R: p.R };
        }
      }
    }
    return null;
  })()`);
  if (!forest) throw new Error('no sunlit woodland found near the landing site');
  Object.assign(site, forest);
  SCENES.push({ name: '11-forest-down-8km', js: flight(8000, -1.44) },
    { name: '12-forest-down-2km', js: flight(2000, -1.44) },
    { name: '13-forest-down-400m', js: flight(400, -1.44) });
  SCENES.splice(SCENES.findIndex((scene) => scene.name === '08-walk'), 2,
    { name: '08-canopy-60m', js: flight(60, -0.3) },
    { name: '09-eye-level', js: (i, s) => 'NMS.shipVisible(false); ' + flight(2.2, 0)(i, s) },
    { name: '10-eye-level-up', js: flight(2.2, 0.35) });
}

// --landing: land in the chosen site with the real L-key flow and record the
// downwash: mid-descent, from the ramp after touchdown, and the scar from above
if (flag('landing')) {
  const shoot = async (name) => {
    await page.screenshot({ path: `${OUT}/${name}.png` });
    console.log('ok', name);
  };
  await page.evaluate(flight(110, -0.55)(PLANET, site));
  try { await page.waitForFunction('window.NMS.idle()', null, { timeout: 90000 }); } catch {}
  await page.waitForTimeout(1500);
  await shoot('L1-before');
  await page.keyboard.press('KeyL');
  await page.waitForTimeout(1900);
  await shoot('L2-descent');
  await page.waitForTimeout(3200);
  await shoot('L3-touchdown');
  const pad = await page.evaluate(() => NMS.referenceState().shipLocal);
  if (pad) {
    const len = Math.hypot(...pad);
    const padSite = { ...site, dir: pad.map((v) => v / len) };
    await page.evaluate('NMS.shipVisible(false); ' + flight(60, -1.35)(PLANET, padSite));
    await page.waitForTimeout(3000);
    await shoot('L4-scar-above');
    const side = { ...padSite, dir: padSite.dir.map((v, i) => v + [0.7, -0.4, 0.3][i] * 55 / site.R) };
    await page.evaluate('NMS.shipVisible(false); ' + flight(6, -0.1)(PLANET, side));
    await page.waitForTimeout(3000);
    await shoot('L5-scar-side');
  }
  await browser.close();
  server.close();
  process.exit(errors.length ? 1 : 0);
}

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
  // frames presented over two seconds (headless Chrome is capped at 60)
  const fps = await page.evaluate(() => new Promise((resolve) => {
    let frames = 0; const start = performance.now();
    const tick = () => { frames++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else resolve(frames / 2); };
    requestAnimationFrame(tick);
  }));
  stats.fps = fps;
  report.push({ scene: scene.name, fps, draws: stats.calls, tris: stats.tris, chunks: stats.chunks, alt: Math.round(stats.alt) });
  console.log(`ok ${scene.name}  fps=${fps} draws=${stats.calls} tris=${(stats.tris / 1e6).toFixed(2)}M chunks=${stats.chunks} alt=${Math.round(stats.alt)}`);
}

await writeFile(`${OUT}/report.json`, JSON.stringify({ query, planet: PLANET, width: WIDTH, height: HEIGHT, site, report, errors }, null, 2));
await browser.close();
server.close();
console.log(`saved to ${OUT}`);
if (errors.length) process.exitCode = 1;
