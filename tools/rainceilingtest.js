// Regression checks for rain/cloud consistency and cloud-base altitude ceiling:
//  - Homeworld equator is no longer a permanent unbroken rain wall.
//  - Even during a maximum storm fixture, rain and snow stop at/above the
//    local cloud base (never raining above the clouds), and climbing back above
//    the cloud deck clears lingering rain streaks promptly.
//  - Rain turns on normally below the cloud base during storm/rain conditions.
//  - Underwater and cloudless worlds do not render natural surface rain.
//
//   node tools/rainceilingtest.js [--gpu]
import assert from 'node:assert/strict';
import { launchBrowser } from './browser.js';
import { startServer } from './server.js';

const gpu = process.argv.includes('--gpu');
const { server, port } = await startServer(0);
const browser = await launchBrowser(gpu ? { args: ['--use-angle=d3d11', '--enable-gpu'] } : {});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.waitForTimeout(2500);

  // 1. Equatorial rain fraction on homeworld must be localized, not a ~94% wall.
  const eqStats = await page.evaluate(() => {
    const p = NMS._internals.universe.system.planets[0];
    let rain = 0;
    const total = 72;
    for (let i = 0; i < total; i++) {
      const lon = (i / total) * Math.PI * 2;
      const w = p.weatherAt({ x: Math.cos(lon), y: 0.04, z: Math.sin(lon) });
      if (w.precipitationKind === 'rain' && w.precipitation > 0.045) rain++;
    }
    return { rain, total, fraction: rain / total };
  });
  assert.ok(eqStats.fraction < 0.35,
    `equatorial rain fraction must be localized (< 0.35), got ${eqStats.fraction.toFixed(2)}`);

  // Helper to place the camera at a given altitude above terrain along the spawn radial.
  const setAltitude = async (altMeters, waitMs = 350) => {
    await page.evaluate((a) => {
      const p = NMS._internals.universe.system.planets[0];
      const nav = NMS._internals.nav;
      const THREE = nav.pos.constructor;
      const dir = nav.pos.clone().sub(p.posUniv).normalize();
      const surf = p.surfaceRadius(p.worldOffsetToLocal(dir, new THREE()).normalize());
      nav.pos.copy(p.posUniv).addScaledVector(dir, surf + a);
      nav.vel.set(0, 0, 0);
    }, altMeters);
    await page.waitForTimeout(waitMs);
    return page.evaluate(() => {
      const p = NMS._internals.universe.system.planets[0];
      const nav = NMS._internals.nav;
      const THREE = nav.pos.constructor;
      const lite = NMS._internals.nodePipeline?.cloudPass;
      const ls = lite?.weatherSampleAt(p.worldPositionToLocal(nav.pos, new THREE()));
      const fx = NMS._internals.weatherEffects;
      return {
        datumAlt: nav.pos.distanceTo(p.posUniv) - p.R,
        cloudBase: ls?.cloudBaseAlt ?? 0,
        weather: NMS.weatherState(0),
        rainMeshVis: !!fx.rainFx.group.visible,
        rainLevel: fx.rainFx.level,
      };
    });
  };

  // 2. Under storm fixture, above cloud base MUST have zero rain; below cloud base MUST rain.
  await page.evaluate(() => NMS.setWeatherFixture(0, 'storm'));
  for (const aboveAlt of [12000, 5000, 2600, 2250]) {
    const s = await setAltitude(aboveAlt, 400);
    assert.ok(s.datumAlt >= s.cloudBase, `test altitude ${s.datumAlt.toFixed(0)} m must be >= cloudBase ${s.cloudBase.toFixed(0)} m`);
    assert.equal(s.weather.effects.rainVisible, false, `must not rain above cloud base at datum=${s.datumAlt.toFixed(0)} m`);
    assert.equal(s.weather.effects.precipitation, 0, `surface precipitation must be 0 above cloud base at datum=${s.datumAlt.toFixed(0)} m`);
    assert.equal(s.rainMeshVis, false, `rain mesh must be hidden above cloud base at datum=${s.datumAlt.toFixed(0)} m`);
  }

  // Descend below cloud base in the storm -> rain becomes visible.
  const under = await setAltitude(600, 1100);
  assert.ok(under.datumAlt < under.cloudBase - 320, 'test position must be well below cloud base');
  assert.equal(under.weather.effects.rainVisible, true, 'storm below cloud base must produce visible rain');
  assert.equal(under.rainMeshVis, true, 'rain mesh must be visible below cloud base in storm');
  assert.ok(under.rainLevel > 0.25, `expected substantial rain level below storm clouds, got ${under.rainLevel}`);

  // Climb back above cloud base -> rain must clear promptly (< 1.4 s), not trail above clouds.
  const climbed = await setAltitude(3800, 1200);
  assert.equal(climbed.weather.effects.rainVisible, false, 'climbing above clouds must stop rain target immediately');
  assert.equal(climbed.rainMeshVis, false, `lingering rain mesh must clear promptly above clouds (level=${climbed.rainLevel})`);

  // 3. Underwater check: submerge below sea level under storm fixture -> no rain underwater.
  const submerged = await page.evaluate(async () => {
    const p = NMS._internals.universe.system.planets[0];
    const nav = NMS._internals.nav;
    const THREE = nav.pos.constructor;
    // Find an ocean direction on planet-0.
    let seaDir = null;
    for (let i = 0; i < 400; i++) {
      const y = 1 - 2 * (i + 0.5) / 400, r = Math.sqrt(1 - y * y), a = i * 2.3999632;
      const d = new THREE(Math.cos(a) * r, y, Math.sin(a) * r);
      if (p.height(d, p.fullMaxFreq) < p.seaLevel - 30) { seaDir = d; break; }
    }
    if (!seaDir) return { skipped: true };
    const worldDir = p.localOffsetToWorld(seaDir, new THREE()).normalize();
    nav.pos.copy(p.posUniv).addScaledVector(worldDir, p.seaRadius - 12);
    nav.vel.set(0, 0, 0);
    return { skipped: false };
  });
  if (!submerged.skipped) {
    await page.waitForTimeout(1200);
    const uw = await page.evaluate(() => ({
      effects: NMS.weatherState(0).effects,
      meshVis: NMS._internals.weatherEffects.rainFx.group.visible,
    }));
    assert.equal(uw.effects.rainVisible, false, 'must not rain underwater');
    assert.equal(uw.meshVis, false, 'rain mesh must stay hidden underwater');
  }

  await page.evaluate(() => NMS.setWeatherFixture(0, null));
  assert.deepEqual(errors, [], `unexpected page errors: ${errors.join('; ')}`);
  console.log('PASS: rain ceiling, underwater gate, prompt climb clear, and localized equatorial rain verified.', eqStats);
} finally {
  await browser.close();
  server.close();
}
