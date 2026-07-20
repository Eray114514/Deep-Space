// Exploration pass: many seeds × many settings. Complements tools/screenshot.js
// (the fixed regression suite) with breadth — every planet type in several
// systems seen from orbit, low flight AND from the ground, plus special
// lighting/setting scenes: sunset landing, night side with the headlamp,
// underwater on the seabed, moon surfaces, a shoreline skim over the shallows.
// Usage: node tools/explore.js   (env: SEEDS=A,B  OUT=screenshots/explore)

import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const SEEDS = (process.env.SEEDS || 'EUCLID,ATLAS-7,VOYAGER-3').split(',');
const OUT = process.env.OUT || 'screenshots/explore';
const LANDS_PER_SEED = Number(process.env.LANDS || 3);   // full landings are the slow part under SwiftShader
const SKIP_ORBITS = process.env.SKIP_ORBITS === '1';     // reshoots: orbits rarely change

const { server, port } = await startServer(0);
const browser = await launchBrowser();

const errors = [];
const landedTypes = new Set();   // across all seeds: walk each type only once
let dove = false, moonShot = false;

for (const seed of SEEDS) {
  const dir = `${OUT}/${seed}`;
  await mkdir(dir, { recursive: true });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (e) => { errors.push(`[${seed}] ${e}`); console.error('PAGEERROR:', String(e).split('\n')[0]); });
  page.on('console', (m) => { if (m.type() === 'error') console.error('CONSOLE:', m.text().slice(0, 300)); });

  console.log(`\n=== ${seed} → http://127.0.0.1:${port} ===`);
  // headless doesn't care about frame pacing: let terrain builds eat most of
  // every frame so big systems actually settle inside the shot timeout
  await page.goto(`http://127.0.0.1:${port}/?worldlab=1&seed=${encodeURIComponent(seed)}&nolock=1&buildms=120`);
  await page.waitForFunction('window.NMS && window.NMS.booted', null, { timeout: 90000 });

  async function shot(name, timeout = 240000) {
    try {
      await page.waitForFunction('window.NMS.idle()', null, { timeout });
    } catch {
      const st = await page.evaluate('window.NMS.stats()');
      console.warn(`${name}: settle timeout (continuing, ${st.pending} queued)`);
    }
    // on foot, give the scatter props a beat to finish their grow-in
    const walking = await page.evaluate('window.NMS.state');
    await page.waitForTimeout(walking === 'walk' ? 1300 : 350);
    await page.screenshot({ path: `${dir}/${name}.png` });
    const stats = await page.evaluate('window.NMS.stats()');
    console.log(`✓ ${seed}/${name}  [${stats.calls} draws, ${(stats.tris / 1e6).toFixed(2)}Mtri, alt=${Math.round(stats.alt)}]`);
  }

  const planets = await page.evaluate('window.NMS.planets()');
  console.log('system:', planets.map((p) => `${p.i}:${p.type}${p.isMoon ? '(moon)' : ''}${p.liquid ? `[${p.liquid}]` : ''}`).join(' '));

  await shot('00-system-vista');

  // one representative of each planet type in this system
  const seen = new Set();
  const reps = planets.filter((p) => {
    const key = p.type + (p.isMoon ? '-moon' : '');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  let n = 1, lands = 0;
  for (const p of reps) {
    const tag = `${String(n).padStart(2, '0')}-${p.type}${p.isMoon ? '-moon' : ''}`;
    n++;
    if (!SKIP_ORBITS) {
      await page.evaluate(`NMS.teleport(${p.i}, 0.5)`);
      await shot(`${tag}-orbit`);
    }
    const landKey = p.type + (p.isMoon ? '-moon' : '');   // a moon is its own setting
    if (!landedTypes.has(landKey) && lands < LANDS_PER_SEED) {
      landedTypes.add(landKey);
      lands++;
      await page.evaluate(`NMS.teleport(${p.i}, 0.06, {horizon: true})`);
      await shot(`${tag}-low`);
      await page.evaluate(`NMS.land(${p.i})`);
      await shot(`${tag}-surface`);
      // second angle: the parked ship — always something in frame, and it
      // shows the landing pad in every biome
      await page.evaluate('NMS.faceShip()');
      await shot(`${tag}-surface-ship`);
    }
  }

  // ---- special settings, distributed across the seeds ----
  const idx = SEEDS.indexOf(seed);
  const wet = planets.find((p) => p.liquid === 'water' && !p.isMoon) || planets.find((p) => p.liquid === 'water');
  const divable = planets.find((p) => p.liquid === 'toxic') || wet;
  const moon = planets.find((p) => p.isMoon);

  // the shoreline skim: depth-graded shallows seen from the air (any seed
  // with water) — coast() hunts an actual sunlit coastline, facing seaward
  if (wet) {
    await page.evaluate(`NMS.coast(${wet.i})`);
    await shot('80-shoreline-skim');
  }

  if (idx === 0) {
    const s = reps.find((p) => !p.isMoon) || planets[0];
    await page.evaluate(`NMS.land(${s.i}, 0, 'sunset')`);
    await shot('81-sunset-landing');
    await page.evaluate('NMS.lookYaw(120)');
    await shot('81-sunset-landing-b');
    if (divable) {
      dove = true;
      await page.evaluate(`NMS.dive(${divable.i})`);
      await shot(`82-underwater-${divable.liquid}`);
      await page.evaluate('NMS.lookYaw(180); NMS.lookPitch(-25);');
      await shot('82-underwater-b');
    }
  } else if (idx === 1) {
    const s = planets.find((p) => !p.isMoon) || planets[0];
    await page.evaluate(`NMS.land(${s.i}, 0, 'night')`);
    await shot('83-night-headlamp');
    // pitch into the lamp pool — the first angle faces open (unlit) horizon
    await page.evaluate('NMS.lookPitch(-32); NMS.lookYaw(20);');
    await shot('83-night-headlamp-b');
  } else {
    if (divable && (!dove || divable.liquid === 'toxic')) {
      dove = true;
      await page.evaluate(`NMS.dive(${divable.i})`);
      await shot(`85-underwater-${divable.liquid}`);
    }
    const s = reps.find((p) => p.hasLiquid && !p.isMoon) || planets[0];
    await page.evaluate(`NMS.land(${s.i}, 0, 'sunset')`);
    await shot('86-sunset-shore');
  }

  // a moon surface, whichever seed first has one (they're their own worlds:
  // tiny radius, sharp horizon, usually airless skies)
  if (moon && !moonShot) {
    moonShot = true;
    await page.evaluate(`NMS.land(${moon.i})`);
    await shot(`84-moon-${moon.type}-surface`);
    await page.evaluate('NMS.faceShip()');
    await shot('84-moon-surface-ship');
  }

  await page.close();
}

console.log(errors.length ? `\nDONE WITH ${errors.length} PAGE ERROR(S)` : '\nDONE — no page errors');
for (const e of errors) console.error(' ', e.split('\n')[0]);
await browser.close();
server.close();
process.exit(errors.length ? 1 : 0);
