// Actual-player walk/PAC-9/ADS/input and native submission observation. Clouds are
// explicitly disabled to isolate auxiliary ownership; this is not cloud art or
// whole-frame performance acceptance. Observers add no native readiness polls.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/auxiliaryframeplaytest.js';
const out = `test-results/auxiliary-frame-player/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const report = { scope: 'Actual game walk/PAC-9/ADS/input, PMREM and scope draws in the shared frame ticket; vclouds=0, no performance or cloud-art acceptance',
  before: await evidenceFingerprint(verifier), errors: [], driverWarnings: [] };
const { server, port } = await startServer(0);let browser, page;
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined, headless: true });
  report.browserVersion = browser.version();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on('pageerror', error => report.errors.push(String(error)));
  page.on('console', message => {
    const text = message.text();
    if (message.type() === 'error') report.errors.push(text);
    if (/GL_INVALID|CONTEXT_LOST|Program object expected|INVALID_(?:ENUM|VALUE|OPERATION)|GL_OUT_OF_MEMORY/i.test(text)) report.driverWarnings.push(text);
  });
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=0&farflora=0&post=1&freeze=1`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 120000 });
  await page.evaluate(async () => {
    const { SurfaceWeapons } = await import('/src/surface-weapons.js');
    const { WeaponLighting } = await import('/src/weapon-lighting.js');
    const pipeline = NMS._pipeline, renderer = NMS._renderer, gl = renderer.getContext();
    const data = window.__auxiliaryObserver = { phase: 'unpaced', records: [], dropped: 0, outsideDraws: 0,
      draws: 0, maintenanceDraws: 0, fences: 0, scopeCalls: 0, lightingCalls: 0, pmremTargets: 0, restored: false, naturalTimeouts: 0 };
    const restores = [];let submission = null;
    const wrap = (object, name, factory) => {
      const original = object[name], wrapper = factory(original);object[name] = wrapper;
      restores.push(() => { if (object[name] !== wrapper) throw Error(`Observer restore conflict: ${name}`);object[name] = original; });
    };
    const counters = () => ({ draws: data.draws, fences: data.fences, scopeCalls: data.scopeCalls, lightingCalls: data.lightingCalls,
      timeouts: data.naturalTimeouts, sequence: pipeline.frameState.sequence,
      preparations: pipeline.preparations.snapshot().stats.executed });
    for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) wrap(gl, name, original => function(...args) {
      data.draws++;
      if (!pipeline.frameSubmissionActive) data.outsideDraws++;
      else if (!submission) data.maintenanceDraws++;
      return original.apply(this, args);
    });
    wrap(gl, 'fenceSync', original => function(...args) { data.fences++;return original.apply(this, args); });
    wrap(gl, 'clientWaitSync', original => function(...args) {
      const result = original.apply(this, args);if (result === gl.TIMEOUT_EXPIRED) data.naturalTimeouts++;return result;
    });
    wrap(SurfaceWeapons.prototype, 'renderScopeView', original => function(...args) { data.scopeCalls++;return original.apply(this, args); });
    wrap(WeaponLighting.prototype, 'prepareEnvironment', original => function(...args) {
      data.lightingCalls++;const result = original.apply(this, args);
      if (this.skyProbe.target) data.pmremTargets++;return result;
    });
    wrap(pipeline, 'submitFrame', original => function(...args) {
      if (submission) throw Error('Unexpected nested submission');
      const row = { phase: data.phase, before: counters(), atMs: performance.now(), paced: Boolean(this.framePacer) };submission = row;
      try { row.accepted = original.apply(this, args);return row.accepted; }
      finally {
        row.after = counters();row.endMs = performance.now();submission = null;
        if (data.records.length < 4096) data.records.push(row);else data.dropped++;
      }
    });
    window.__restoreAuxiliaryObserver = () => { restores.reverse().forEach(restore => restore());data.restored = true; };
    NMS.land(0, 0, 'meadow');NMS.setLocalSunAltitude(0, 32);NMS.surfaceWeapon(0);
  });
  await page.waitForFunction(() => NMS.state === 'walk' && NMS.surfaceWeaponState().index === 0 && NMS.surfaceWeaponState().rendered,
    null, { timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${out}/unpaced-pac9.png`, timeout: 90000 });
  await page.evaluate(() => { __auxiliaryObserver.phase = 'paced';NMS._pipeline.startFramePacing();NMS.resetPerformanceStats(); });
  await page.waitForTimeout(8000);
  report.beforeInput = await page.evaluate(() => ({ pos: NMS.pos(), state: NMS.surfaceWeaponState(), stats: NMS.stats() }));
  await page.keyboard.down('KeyW');await page.waitForTimeout(3000);await page.keyboard.up('KeyW');
  report.afterInput = await page.evaluate(() => ({ pos: NMS.pos(), state: NMS.surfaceWeaponState(), stats: NMS.stats() }));
  await page.mouse.move(640, 360);await page.mouse.down({ button: 'right' });
  await page.waitForFunction(() => NMS.surfaceWeaponState().ads, null, { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/paced-pac9-ads.png`, timeout: 90000 });
  await page.mouse.up({ button: 'right' });
  await page.keyboard.press('Escape');await page.waitForFunction(() => NMS.stats().paused);
  await page.waitForTimeout(500);await page.keyboard.press('Escape');await page.waitForFunction(() => !NMS.stats().paused);
  report.result = await page.evaluate(() => {
    const pipeline = NMS._pipeline, pacer = pipeline.framePacer, gl = NMS._renderer.getContext();
    const result = { observer: __auxiliaryObserver, scope: NMS.surfaceScopeSample(), state: NMS.surfaceWeaponState(), stats: NMS.stats(),
      beforeStop: pacer.snapshot(), gl: gl.getError(), lost: gl.isContextLost() };
    pipeline.stopFramePacing();window.__retiredAuxiliaryPacer = pacer;__restoreAuxiliaryObserver();return result;
  });
  await page.waitForFunction(() => __retiredAuxiliaryPacer.snapshot().released, null, { timeout: 15000 });
  report.retired = await page.evaluate(() => ({ pacing: NMS._pipeline.framePacer, owner: __retiredAuxiliaryPacer.snapshot(),
    gl: NMS._renderer.getContext().getError(), lost: NMS._renderer.getContext().isContextLost() }));
  await page.screenshot({ path: `${out}/resumed-pac9.png`, timeout: 90000 });
  const data = report.result.observer, preparations = data.records.filter(row => row.after.preparations > row.before.preparations),
    rejected = data.records.filter(row => row.accepted === false && row.after.preparations === row.before.preparations),
    paced = data.records.filter(row => row.paced && row.accepted);
  assert.equal(data.restored, true);assert.equal(data.dropped, 0);assert.equal(data.outsideDraws, 0);
  assert.ok(data.pmremTargets > 0 && data.draws > 0 && rejected.length > 0 && paced.length > 0);
  assert.ok(rejected.every(row => row.after.draws === row.before.draws && row.after.fences === row.before.fences
    && row.after.scopeCalls === row.before.scopeCalls && row.after.lightingCalls === row.before.lightingCalls
    && row.after.sequence === row.before.sequence && row.after.timeouts > row.before.timeouts));
  assert.ok(paced.every(row => row.after.fences === row.before.fences + 1 && row.after.sequence === row.before.sequence + 1));
  assert.ok(preparations.every(row => !row.accepted && row.after.preparations === row.before.preparations + 1
    && row.after.scopeCalls === row.before.scopeCalls && row.after.lightingCalls === row.before.lightingCalls
    && (!row.paced || row.after.fences === row.before.fences + 1)));
  assert.ok(report.afterInput.pos.some((value, index) => Math.abs(value - report.beforeInput.pos[index]) > .1));
  assert.ok(report.result.scope.litPixels > 0);assert.equal(report.result.gl, 0);assert.equal(report.result.lost, false);
  assert.equal(report.retired.owner.released, true);assert.equal(report.retired.owner.pending, 0);assert.equal(report.retired.owner.fault, null);
  assert.equal(report.retired.pacing, null);assert.equal(report.retired.gl, 0);assert.equal(report.retired.lost, false);
  assert.deepEqual(report.errors, []);assert.deepEqual(report.driverWarnings, []);
  report.summary = { rejected: rejected.length, paced: paced.length, preparations: preparations.length,
    maintenanceDraws: data.maintenanceDraws, draws: data.draws, pmremFrames: data.pmremTargets, outsideDraws: data.outsideDraws };
  report.passed = true;
} catch (error) {
  report.passed = false;report.error = String(error);process.exitCode = 1;
} finally {
  report.after = await evidenceFingerprint(verifier);
  if (report.before.sourceDigest !== report.after.sourceDigest || report.before.verifierDigest !== report.after.verifierDigest) {
    report.passed = false;report.unstableInputs = true;process.exitCode = 1;
  }
  await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ out, passed: report.passed, error: report.error, ...report.summary }));
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
