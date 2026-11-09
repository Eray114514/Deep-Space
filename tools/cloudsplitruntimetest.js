import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { installFoundationGLProbe } from './foundation-gl-probe.js';

const verifier = 'tools/cloudsplitruntimetest.js';
const before = await evidenceFingerprint(verifier);
const audit = process.argv.includes('--gl-audit');
const requireMixed = process.argv.includes('--require-mixed');
const fixedWeather = process.argv.includes('--fixed-weather');
const out = `test-results/cloud-split-runtime/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
let browser, page, failure;
const errors = [], checkpoints = [];
async function capture(label) {
  const state = await page.evaluate(label => {
    const game = window.NMS, pipeline = game?._pipeline, pass = pipeline?.volumePass;
    const split = pass?.farSplit, gl = game?._renderer.getContext();
    let hdr;
    if (pass?.previousSplitDraw && label !== 'failure') {
      const pixels = new Uint16Array(pass.width * pass.height * 4);
      game._renderer.readRenderTargetPixels(pass.current, 0, 0, pass.width, pass.height, pixels);
      let cloudPixels = 0, maxAlpha = 0;
      for (let i = 3; i < pixels.length; i += 4) {
        const alpha = game._THREE.DataUtils.fromHalfFloat(pixels[i]);
        if (alpha > 0) cloudPixels++;
        maxAlpha = Math.max(maxAlpha, alpha);
      }
      const stages = split.lastRoute === 'combine' ? ['point', 'cached', 'combine'] : [split.lastRoute];
      hdr = { cloudPixels, maxAlpha, stableUniforms: stages.every(stage => {
        const material = split.materials[stage];
        return game._renderer.properties.get(material).uniforms === material.uniforms;
      }) };
    }
    const bank = pass?.columnMaps.get(pass.activePlanet);
    return { atMs: performance.now(), booted: game?.booted, gl: gl?.getError(), lost: gl?.isContextLost(), hdr,
      columns: bank && { rows: bank.rows, anchor: pass.activePlanet.weatherStream.anchor,
        ready: pass.activePlanet.volCloudMat.uniforms.uColumnsReady.value,
        maps: [...bank.maps.values()].map(map => ({ generation: map.generation, row: map.row, ready: map.ready })) },
      ready: pipeline?.cloudPrograms.snapshot(), frames: split?.frames, route: split?.lastRoute,
      sequence: pipeline?.frameState.sequence, historySequence: pass?.historySequence,
      historyValid: pass?.historyValid, historyUsed: pass?.resolveMaterial.uniforms.uHistoryValid.value,
      splitPublished: pass?.previousSplitDraw, size: pass && [pass.width, pass.height],
      scratch: split?.scratch?.map(target => [target.width, target.height]) ?? null,
      firstError: window.__foundationGLProbe?.snapshot().firstError,
      active: pass?.activePlanet?.name, eye: pass?.activePlanet?.volCloudMat?.uniforms.uCameraLocal.value.length() };
  }, label);
  checkpoints.push({ label, ...state });console.log(JSON.stringify({ label, ...state }));return state;
}
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  console.log(JSON.stringify({ out, started: true }));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1&cloudsplit=1`);
  await page.waitForFunction(() => window.NMS?._planet(0)?.volCloudBand && NMS._pipeline.volumePass.farSplit,
    null, { timeout: 120000 });
  const initial = await capture('before-orbit-placement');
  if (audit) {
    await page.evaluate(installFoundationGLProbe);
    await page.evaluate(() => { window.__foundationGLProbe.mark('split-orbit');window.__foundationGLProbe.armErrors(); });
  }
  await page.evaluate(fixedWeather => {
    const planet = NMS._planet(0);
    const star = planet.stellarDirectionsAt(planet.weatherHours).sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
    NMS.setAdaptiveQualityLocked();
    if (fixedWeather) {
      NMS.setTimeFrozen();
      // Test the real producer and publication with fixed source revisions.
      // Larger row slices shorten this integration fixture's warm replay.
      const pass = NMS._pipeline.volumePass, update = pass.updateCloudColumns;
      pass.updateCloudColumns = function(renderer) {
        update.call(this,renderer);
        const bank = this.columnMaps.get(this.activePlanet);
        if (bank) bank.rows = 16;
      };
    }
    NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+600000)/planet.R, { dir: star.direction, horizon: false });
  }, fixedWeather);
  await page.waitForFunction(previous => {
    const pipeline = NMS._pipeline, pass = pipeline.volumePass;
    return pass.farSplit.frames > previous + 1 && pass.previousSplitDraw && pass.historyValid
      && pass.historySequence + 1 === pipeline.frameState.sequence && pass.resolveMaterial.uniforms.uHistoryValid.value === 1;
  }, initial.frames, { timeout: 120000 });
  let orbit = await capture('split-history');
  await page.screenshot({ path: `${out}/orbit.png`, timeout: 90000 });
  if (requireMixed) {
    // The normal rows producer needs up to 512 world submissions for two
    // 512-row endpoints at two rows per submission. This is a warm observation
    // window, independent of the 120-second first-draw check above.
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'combine', null, { timeout: 240000 });
    orbit = await capture('split-mixed');
    await page.screenshot({ path: `${out}/orbit-mixed.png`, timeout: 90000 });
  }
  await page.setViewportSize({ width: 1008, height: 576 });
  await page.waitForFunction(({ frames, size }) => {
    const pass = NMS._pipeline.volumePass;
    return pass.farSplit.frames > frames && pass.previousSplitDraw && pass.historyValid
      && (pass.width !== size[0] || pass.height !== size[1]);
  }, orbit, { timeout: 120000 });
  await capture('split-resized');
  if (requireMixed) {
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      const star = planet.stellarDirectionsAt(planet.weatherHours).sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
      NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+3000000)/planet.R, { dir: star.direction, horizon: false });
    });
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'cachedDirect', null, { timeout: 120000 });
    await capture('split-cached');
  }
  for (const state of checkpoints.slice(1)) {
    assert.equal(state.gl,0);assert.equal(state.lost,false);assert.equal(state.ready.failed,false);
    assert.ok(!state.firstError, JSON.stringify(state.firstError));
    assert.ok(state.hdr?.cloudPixels > 0 && state.hdr?.maxAlpha > 0 && state.hdr?.stableUniforms, JSON.stringify(state.hdr));
    if (state.route === 'combine') assert.deepEqual(state.scratch, [state.size, state.size]);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
  if (page) try { await capture('failure'); } catch {}
  throw error;
} finally {
  try {
    const after = await evidenceFingerprint(verifier);
    await writeFile(`${out}/report.json`, JSON.stringify({ before, after, audit, requireMixed, fixedWeather, checkpoints, errors, failure, passed: !failure }, null, 2));
    assert.deepEqual(after, before);
  } finally { await browser?.close();server.close(); }
}
