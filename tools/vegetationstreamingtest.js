// Vegetation streaming under continuous movement (hardware GPU Chrome).
//
// Reported bug: flying low, trees ahead appear, vanish as you approach and
// only come back after waiting; grass is sometimes missing until you stop.
// This flies straight and level across woodland, frame by frame through the
// ordinary update path, and records how many plants are drawn near the
// camera. A healthy stream never drops the near levels to nothing while the
// ground below is wooded.
//
//   node tools/vegetationstreamingtest.js [--alt 60] [--speed 120] [--seconds 14] [--walk]
//
// --walk runs the grass check on foot (6 m/s) instead of in flight.

import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer } from './server.js';
import { resolveSystemChromePath } from './browser.js';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};
const WALK = args.includes('--walk');
const ALT = option('alt', 60);
const SPEED = option('speed', WALK ? 6 : 120);
const SECONDS = option('seconds', 17);
const OUT = 'test-results/vegetation-streaming';

await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || resolveSystemChromePath(),
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
await page.goto(`http://127.0.0.1:${port}/?nohero=1&weather=clear`);
await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 180000 });
await page.evaluate(`NMS.land(0, 0, 'meadow'); NMS.setSunAltitude(0, 40); NMS.setTimeFrozen(true)`);

// a straight 2+ km line that stays over woodland
const route = await page.evaluate(({ walk }) => {
  const p = NMS._ff.planet || null;
  const ref = NMS.referenceState();
  const planet = p || null;
  const len = Math.hypot(...ref.playerLocal);
  const V = NMS._THREE.Vector3;
  const up = new V(...ref.playerLocal.map((v) => v / len));
  const P = planet;
  const wooded = (d) => P.biomeAt(d, P.height(d, P.fullMaxFreq)) === 'forest';
  const e1 = new V(-up.z, 0, up.x).normalize(), e2 = new V().crossVectors(up, e1);
  for (let ring = 1; ring < 300; ring++) {
    for (let k = 0; k < 16; k++) {
      const a = k / 16 * Math.PI * 2, r = ring * 1200;
      const start = up.clone().addScaledVector(e1, Math.cos(a) * r / P.R).addScaledVector(e2, Math.sin(a) * r / P.R).normalize();
      if (start.dot(P.sunDirLocal) < 0.4) continue;
      for (let h = 0; h < 8; h++) {
        const ha = h / 8 * Math.PI * 2;
        const f1 = new V(-start.z, 0, start.x).normalize(), f2 = new V().crossVectors(start, f1);
        const fwd = f1.clone().multiplyScalar(Math.cos(ha)).addScaledVector(f2, Math.sin(ha));
        let ok = 0;
        for (let s = 0; s <= 12; s++) {
          if (wooded(start.clone().addScaledVector(fwd, (s * (walk ? 15 : 200)) / P.R).normalize())) ok++;
        }
        if (ok >= 11) return { start: start.toArray(), forward: fwd.toArray(), R: P.R };
      }
    }
  }
  return null;
}, { walk: WALK });
if (!route) throw new Error('no straight wooded route found');

// leave walking mode: the continuous fixture only drives the flight camera
await page.evaluate(({ route, alt }) => {
  const p = NMS._ff.planet;
  const dir = new NMS._THREE.Vector3(...route.start);
  NMS.teleport(0, (p.height(dir, p.fullMaxFreq) + alt) / p.R, { dir: route.start, horizon: true, pitch: -0.2 });
}, { route, alt: ALT });
await page.waitForTimeout(500);

const frames = Math.round(SECONDS * 60);
const samples = [];
for (let f = 0; f < frames; f++) {
  const sample = await page.evaluate(({ route, f, speed, alt, walk }) => {
    const V = NMS._THREE.Vector3;
    const start = new V(...route.start), fwd = new V(...route.forward);
    const travelled = Math.max(0, f - 300) / 60 * speed;   // five seconds of hover: a teleport is a cold start
    const dir = start.clone().addScaledVector(fwd, travelled / route.R).normalize();
    const p = NMS._ff.planet;
    const ground = p ? p.height(dir, p.fullMaxFreq) : 0;
    NMS.setContinuousAtmosphereAltitude(0, (p ? ground : 0) + alt, {
      dir: dir.toArray(), forward: fwd.toArray(), pitch: walk ? -0.05 : -0.22,
    });
    return new Promise((resolve) => requestAnimationFrame(() => {
      const ff = NMS._ff.debugStats();
      const grass = NMS.stats().grassField;
      // how far the planted grass ring trails the camera
      const cam = NMS.referenceState().playerLocal;
      const lag = Math.hypot(...grass.origin.map((v, i) => v - cam[i] * (Math.hypot(...grass.origin) / Math.hypot(...cam))));
      resolve({ f, travelled, treeLag: ff.sortLag ?? 0, levels: ff.levels, pending: ff.pending, grass: grass.total, grassPending: grass.pending, grassLag: lag });
    }));
  }, { route, f, speed: SPEED, alt: ALT, walk: WALK });
  samples.push(sample);
}

const moving = samples.filter((s) => s.f > 360);
const near = (s) => (s.levels.far || 0) + (s.levels.mid || 0) + (s.levels.near || 0);
const steadyTrees = Math.max(...samples.slice(240, 300).map(near));
const steadyGrass = Math.max(...samples.slice(240, 300).map((s) => s.grass));
const treeDrops = moving.filter((s) => near(s) < steadyTrees * 0.25).length;
const grassDrops = moving.filter((s) => s.grass < steadyGrass * 0.25).length;
const report = {
  alt: ALT, speed: SPEED, walk: WALK, frames, steadyTrees, steadyGrass,
  movingFrames: moving.length,
  treeDropFrames: treeDrops, grassDropFrames: grassDrops,
  minNearTrees: Math.min(...moving.map(near)), minGrass: Math.min(...moving.map((s) => s.grass)),
  maxGrassLag: Math.round(Math.max(...moving.map((s) => s.grassLag))),
  maxTreeLag: Math.round(Math.max(...moving.map((s) => s.treeLag))),
  errors,
};
await writeFile(`${OUT}/${WALK ? 'walk' : 'flight'}-${ALT}m-${SPEED}ms.json`, JSON.stringify({ report, samples }, null, 1));
console.log(JSON.stringify(report));
await browser.close();
server.close();
// near levels are re-sorted every 24 m; trailing the camera by more than a
// mid-level band (140 m) means trees in front are drawn by no level at all
const maxTreeLag = Math.max(...moving.map((s) => s.treeLag));
const treeBad = steadyTrees > 0 && (treeDrops > moving.length * 0.02 || maxTreeLag > 100);
// the grass ring reaches ~45 m: trailing it by more than ~20 m leaves bare ground ahead
const maxLag = Math.max(...moving.map((s) => s.grassLag));
const grassBad = ALT < 30 && steadyGrass > 0 && (grassDrops > moving.length * 0.02 || maxLag > 20);
if (errors.length || treeBad || grassBad) {
  console.log('FAIL: vegetation drops out while moving');
  process.exitCode = 1;
} else {
  console.log('PASS: vegetation keeps up with continuous movement');
}
