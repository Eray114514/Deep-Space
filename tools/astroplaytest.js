// Browser-level proof for the dynamic astronomy upgrade.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};

const proofDir = join(process.cwd(), 'test-results', 'astronomy');
await mkdir(proofDir, { recursive: true });

try {
  await page.goto(`http://127.0.0.1:${port}/?worldlab=1&seed=ASTRO-0&time=0&nolock=1&nohero=1&quality=low&post=0&vclouds=0&farflora=0&buildms=60`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 90000 });

  const system = await page.evaluate('NMS.system()');
  check(/[\u3400-\u9fff].*星系$/.test(system.name), `Chinese system proper name is primary (${system.name})`);
  check(/^AF J/.test(system.catalogId), `fictional research catalogue is secondary (${system.catalogId})`);
  check(system.stars.length === 2, 'fixed QA seed exposes both stars of a binary system');
  check(system.bodies.some((body) => body.type === 'gasGiant' || body.type === 'iceGiant'), 'system contains a generated giant planet');
  const cloudyIndex = (await page.evaluate('NMS.planets()')).find((body) => body.cloudAlt > 0 && !body.isGasGiant)?.i;
  const cloudAudit = cloudyIndex == null ? null : await page.evaluate((index) => NMS.cloudAudit(index), cloudyIndex);
  check(cloudAudit && cloudAudit.lost === 0 && cloudAudit.gained > 20
      && cloudAudit.enhancedCloud >= cloudAudit.baseCloud,
    `large weather systems add coverage without removing base clouds (${cloudAudit?.baseCloud ?? 0} base / ${cloudAudit?.enhancedCloud ?? 0} total / ${cloudAudit?.lost ?? 0} lost)`);
  const center = system.stars.reduce((sum, star) => sum.map((value, i) => value + star.position[i]), [0, 0, 0])
    .map((value) => value / system.stars.length);
  const starStandOff = Math.max(...system.stars.map((star) => star.radiusRender)) * 12;
  await page.evaluate(({ center: c, distance }) => NMS.setPosition(c[0], c[1] + distance * 0.18, c[2] + distance, ...c),
    { center, distance: starStandOff });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(proofDir, 'binary-stars.png') });

  const clockStart = await page.evaluate(() => ({ hours: NMS.time().hours, now: performance.now() }));
  await page.waitForTimeout(1200);
  const clockEnd = await page.evaluate(() => ({ hours: NMS.time().hours, now: performance.now() }));
  const clockElapsed = (clockEnd.now - clockStart.now) / 1000;
  const clockDelta = clockEnd.hours - clockStart.hours;
  const expectedClockDelta = clockElapsed / 60;
  check(Math.abs(clockDelta - expectedClockDelta) < 0.012,
    `clock advances at 60× (${clockDelta.toFixed(4)} h / ${clockElapsed.toFixed(2)} s)`);
  await page.evaluate('NMS.openStarMap()');
  await page.waitForTimeout(300);
  const mapT0 = (await page.evaluate('NMS.time()')).hours;
  await page.waitForTimeout(700);
  const mapT1 = (await page.evaluate('NMS.time()')).hours;
  check(Math.abs(mapT1 - mapT0) < 1e-7, 'star map freezes the celestial clock');
  await page.evaluate('NMS.closeStarMap()');
  await page.keyboard.press('KeyH');
  const photoT0 = (await page.evaluate('NMS.time()')).hours;
  await page.waitForTimeout(500);
  const photoT1 = (await page.evaluate('NMS.time()')).hours;
  check(Math.abs(photoT1 - photoT0) < 1e-7, 'photo mode freezes celestial and environment animation');
  await page.keyboard.press('KeyH');

  await page.evaluate('NMS.land(0)');
  const first = (await page.evaluate('NMS.planets()'))[0];
  const sunrise = await page.evaluate(`NMS.nextEvent(${JSON.stringify(first.bodyId)}, 'sunrise')`);
  check(Number.isFinite(sunrise), 'next sunrise is calculable from the body frame');
  const quarter = first.rotationPeriodHours / 4;
  const samples = [];
  for (const hours of [sunrise + quarter, sunrise - quarter]) {
    await page.evaluate((time) => NMS.setTime(time), hours);
    await page.waitForTimeout(200);
    samples.push({ hours, stats: await page.evaluate('NMS.stats()') });
  }
  samples.sort((a, b) => a.stats.dayLight - b.stats.dayLight);
  const [night, day] = samples;
  check(day.stats.dayLight > 0.75 && night.stats.dayLight < 0.2,
    `surface lighting follows the sun (${night.stats.dayLight.toFixed(2)} night / ${day.stats.dayLight.toFixed(2)} day)`);
  await page.evaluate((time) => NMS.setTime(time), day.hours);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, 'surface-day.png') });
  await page.evaluate((time) => NMS.setTime(time), night.hours);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, 'surface-night.png') });
  await page.evaluate((time) => NMS.setTime(time), day.hours);
  await page.evaluate("NMS.land(0, 0, 'sunset')");
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(proofDir, 'sun-on-horizon.png') });

  const snow = await page.evaluate('NMS.snowAudit(0, 2400)');
  check(snow.snow > 0 && snow.violations === 0 && snow.treePotential === 0,
    `snow mask rejects vegetation (${snow.snow} snow samples, ${snow.violations} violations)`);
  check(await page.evaluate("NMS.land(0, 0, 'snow')"), 'debug landing resolves a snow-covered QA site');
  await page.waitForFunction(() => {
    const surface = NMS.referenceState();
    return surface?.lod.visibleMaxLevel >= surface?.lod.maxLevel - 1
      && surface.renderedEyeClearance !== null
      && Math.abs(surface.renderedEyeClearance - surface.eyeClearance) < 0.35;
  }, null, { timeout: 150000, polling: 500 });
  const snowSurface = await page.evaluate('NMS.referenceState()');
  check(snowSurface.eyeClearance > 1.55 && snowSurface.eyeClearance < 1.9
      && Math.abs(snowSurface.renderedEyeClearance - snowSurface.eyeClearance) < 0.35,
    `snowfield camera is above matching rendered terrain (${snowSurface.eyeClearance.toFixed(2)} m analytic / ${snowSurface.renderedEyeClearance.toFixed(2)} m rendered)`);
  await page.screenshot({ path: join(proofDir, 'snowfield-no-flora.png') });

  // A rotating/orbiting planet changes universe-space coordinates by design,
  // but the walker and parked ship must retain their body-local coordinates.
  const referenceBefore = await page.evaluate('NMS.referenceState()');
  const rotationHours = (await page.evaluate('NMS.planets()'))[0].rotationPeriodHours;
  await page.evaluate((hours) => NMS.advanceTime(hours), rotationHours / 2);
  await page.waitForTimeout(350);
  const referenceAfter = await page.evaluate('NMS.referenceState()');
  const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));
  const localDrift = distance(referenceBefore.playerLocal, referenceAfter.playerLocal);
  const shipLocalDrift = distance(referenceBefore.shipLocal, referenceAfter.shipLocal);
  const worldTravel = distance(referenceBefore.playerWorld, referenceAfter.playerWorld);
  check(localDrift < 0.05 && shipLocalDrift < 0.001,
    `walker and parked ship stay body-local through half a rotation (${localDrift.toFixed(4)} m / ${shipLocalDrift.toFixed(4)} m drift)`);
  check(worldTravel > 1000,
    `their universe-space position moves with the planet (${Math.round(worldTravel).toLocaleString()} m)`);

  const gasIndex = (await page.evaluate('NMS.planets()')).find((body) => body.isGasGiant).i;
  check(await page.evaluate((index) => NMS.land(index), gasIndex) === false, 'gas giants never accept landing');
  await page.evaluate((index) => NMS.teleport(index, 1.35), gasIndex);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(proofDir, 'gas-giant-orbit.png') });
  await page.evaluate((index) => NMS.teleport(index, -0.2), gasIndex);
  await page.waitForTimeout(500);
  const gas = (await page.evaluate('NMS.planets()'))[gasIndex];
  check(await page.evaluate('NMS.alt()') > -gas.R * 0.101, 'pressure autopilot pulls the ship above the critical layer');
  await page.screenshot({ path: join(proofDir, 'gas-giant-clouds.png') });

  await page.evaluate((index) => NMS.teleport(index, 1.35), gasIndex);
  await page.setViewportSize({ width: 430, height: 900 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(proofDir, 'mobile-hud.png') });
} finally {
  await browser.close();
  server.close();
}

console.log(errors.length || failures
  ? `DONE: ${failures} check failure(s), ${errors.length} browser error(s)`
  : `DONE - astronomy browser proof passed; screenshots in ${proofDir}`);
if (errors.length) console.error(errors.join('\n'));
process.exit(errors.length || failures ? 1 : 0);
