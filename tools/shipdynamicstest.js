// HALCYON VII moving parts: one boot, then every animated node is driven and
// measured.  Doors open for a walker and close behind them, fans turn, the
// light switch takes the cabin to night watch and back, the cockpit pages
// redraw from telemetry, the gear is stowed in flight, the ailerons answer
// the bank, the nozzle petals iris with power.
import { mkdir } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchBrowser } from './browser.js';

const OUT = 'screenshots/ship-dynamics';
await mkdir(OUT, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
let failures = 0;
const check = (ok, label) => {
  console.log(`${ok ? '✓' : '✗'} ${label}`);
  if (!ok) failures++;
};
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });

try {
  await page.goto(`http://127.0.0.1:${port}/?renderer=webgl&nolock=1&nohero=1&farflora=0&buildms=25`);
  await page.waitForFunction('window.NMS?.booted', null, { timeout: 120000 });
  await page.waitForTimeout(800);

  const nodes = await page.evaluate(() => {
    const { ship } = NMS._internals;
    return {
      petals: ship.ext.petals?.length, flaps: ship.ext.flaps?.length, sensor: !!ship.ext.sensor,
      gearDoors: ship.ext.gear.reduce((n, leg) => n + leg.userData.doors.length, 0),
      doors: ship.int.doors?.length, fans: ship.int.fans?.length, hook: !!ship.int.hook,
      lightSwitch: !!ship.int.lightSwitch, stick: !!ship.int.cockpit.stick, throttle: !!ship.int.cockpit.throttle,
      gearVisible: ship.ext.gear.map((leg) => leg.visible), gearT: ship.gearT,
    };
  });
  check(nodes.petals === 4 && nodes.flaps === 2 && nodes.sensor && nodes.gearDoors === 6,
    `exterior movers present (${JSON.stringify(nodes)})`);
  check(nodes.doors === 4 && nodes.fans === 3 && nodes.hook && nodes.lightSwitch && nodes.stick && nodes.throttle,
    'interior movers present');
  check(nodes.gearT < 0.05 && nodes.gearVisible.every((v) => !v), `gear stowed and hidden in flight (gearT ${nodes.gearT?.toFixed(3)})`);

  // ailerons answer the bank, petals iris with power
  const flight = await page.evaluate(async () => {
    const { ship } = NMS._internals;
    const flap = ship.ext.flaps[0];
    const before = flap.quaternion.clone();
    ship.roll = 0.12;
    const original = ship.updateEngineFx.bind(ship);
    ship.updateEngineFx = (dt) => original(dt, 9e5, 0, 1);
    await new Promise((r) => setTimeout(r, 900));
    ship.roll = 0.12;
    const result = { flapAngle: before.angleTo(flap.quaternion), iris: ship.ext.petals[0].scale.x };
    ship.updateEngineFx = original;
    return result;
  });
  check(flight.flapAngle > 0.05, `aileron deflects with the bank (${flight.flapAngle.toFixed(3)} rad)`);
  check(flight.iris > 0.97, `nozzle petals open under power (scale ${flight.iris.toFixed(3)})`);

  // stand up and walk to the flight-deck door
  await page.keyboard.press('KeyV');
  await page.waitForFunction('NMS.shipViewState().viewBlend >= 0.999', null, { timeout: 30000 });
  await page.waitForTimeout(300);
  /* headless Chromium renders a frame or two a second: wait on state, not time */
  const v0 = await page.evaluate(() => NMS._internals.ship.mats.screens.find((m) => m.name === 'screen-attitude').map.version);
  const redrawn = await page.waitForFunction((v) => NMS._internals.ship.mats.screens
    .find((m) => m.name === 'screen-attitude').map.version >= v + 3, v0, { timeout: 30000 }).then(() => true, () => false);
  check(redrawn, 'attitude display redraws live in the cockpit');

  await page.keyboard.press('KeyF');
  await page.waitForFunction('NMS.shipViewState().seatT >= 0.999 && NMS.shipViewState().shipwalk', null, { timeout: 30000 });
  const doors = await page.evaluate(async () => {
    const { ship, shipView } = NMS._internals;
    const door = ship.int.doors.find((d) => d.name === 'door-1-stbd');
    const closed = door.userData.closedX;
    shipView.walkPos.set(0, 0, -6.2);
    await new Promise((r) => setTimeout(r, 1200));
    const open = door.position.x;
    const fan = ship.int.fans[0], f0 = fan.rotation.y;
    shipView.walkPos.set(0, 0, -2.2);
    await new Promise((r) => setTimeout(r, 400));
    return { closed, open, fanTurn: Math.abs(fan.rotation.y - f0) };
  });
  check(doors.open - doors.closed > 0.6, `flight-deck door slides open for the walker (${(doors.open - doors.closed).toFixed(2)} m)`);
  check(doors.fanTurn > 1, `extractor fans turn (${doors.fanTurn.toFixed(1)} rad)`);
  const shut = await page.waitForFunction(() => NMS._internals.ship.int.doors
    .find((d) => d.name === 'door-1-stbd').userData.openT < 0.05, null, { timeout: 30000 }).then(() => true, () => false);
  check(shut, 'flight-deck door closes behind the walker');
  await page.evaluate(() => { NMS._internals.shipView.walkPos.set(0, 0, -5.0); NMS._internals.shipView.walkYaw = 0; });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/01-door-open.png` });

  // light switch: night watch and back
  const prompt = await page.evaluate(() => {
    const { shipView } = NMS._internals;
    shipView.walkPos.set(-0.9, 0, -1.45);
    shipView.walkYaw = Math.PI / 2;
    return shipView.interactPrompt(false);
  });
  check(/夜间/.test(prompt), `light-switch prompt appears at the environment panel (${prompt})`);
  await page.keyboard.press('KeyF');
  await page.waitForFunction(() => NMS._internals.ship.cabinLightT < 0.15, null, { timeout: 30000 }).catch(() => {});
  const night = await page.evaluate(() => {
    const { ship } = NMS._internals;
    const red = ship.interiorLights.filter((l) => l.userData.night).reduce((s, l) => s + l.intensity, 0);
    const white = ship.interiorLights.filter((l) => !l.userData.night).reduce((s, l) => s + l.intensity, 0);
    return { night: ship.cabinNight, t: ship.cabinLightT, red, white };
  });
  check(night.night && night.t < 0.2 && night.red > 1, `night watch dims the cabin and brings up red (${JSON.stringify(night)})`);
  await page.evaluate(() => { const { shipView } = NMS._internals; shipView.walkPos.set(0, 0, -1.2); shipView.walkYaw = Math.PI; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-night-watch-hold.png` });
  await page.evaluate(() => { const { shipView } = NMS._internals; shipView.walkPos.set(0, 0, -1.2); shipView.walkYaw = 0; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/03-night-watch-forward.png` });
  await page.evaluate(() => NMS._internals.ship.toggleCabinLights());
  await page.waitForFunction(() => NMS._internals.ship.cabinLightT > 0.85, null, { timeout: 30000 }).catch(() => {});
  const day = await page.evaluate(() => NMS._internals.ship.cabinLightT);
  check(day > 0.8, `switching back restores normal lighting (${day.toFixed(2)})`);
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.slice(0, 3).join(' | ') : ''}`);
  await browser.close();
  server.close();
}
console.log(failures ? `FAIL: ${failures} check(s)` : 'PASS: ship dynamics');
process.exitCode = failures ? 1 : 0;
