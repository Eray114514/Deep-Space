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
const supplyOption = process.argv.find(arg => arg.startsWith('--supply-rows='));
const supplyRows = supplyOption ? Number(supplyOption.split('=')[1]) : null;
assert.ok(supplyRows === null || supplyRows === 0, 'Supply observation uses the runtime batch. Pass --supply-rows=0.');
const runDescent = process.argv.includes('--descent');
const nearTrace = process.argv.includes('--near-trace');
const skipResize = process.argv.includes('--skip-resize');
const nearPairRequested = process.argv.includes('--near-pair');
const viewport = process.argv.includes('--2k') ? {width:2560,height:1440} : {width:960,height:540};
assert.ok(!nearPairRequested || runDescent, '--near-pair requires --descent');
const requireSupply = process.argv.includes('--require-supply');
assert.ok(!requireSupply || supplyRows !== null && !fixedWeather);
const out = `test-results/cloud-split-runtime/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const { server, port } = await startServer(0);
let browser, page, failure, supply, descent, livePair, nearPair, transition;
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
      lightPreparation:pipeline?.cloudLightPreparation?.state,
      active: pass?.activePlanet?.name, eye: pass?.activePlanet?.volCloudMat?.uniforms.uCameraLocal.value.length() };
  }, label);
  checkpoints.push({ label, ...state });console.log(JSON.stringify({ label, ...state }));return state;
}
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  page = await browser.newPage({ viewport });
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  console.log(JSON.stringify({ out, started: true }));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1&cloudsplit=1`);
  await page.waitForFunction(() => window.NMS?._planet(0)?.volCloudBand && NMS._pipeline.volumePass.farSplit,
    null, { timeout: 120000 });
  const initial = await capture('before-orbit-placement');
  if (nearTrace) await page.evaluate(async () => {
    const { installNearTransitionTrace } = await import('/tools/near-transition-trace.js');
    window.__nearTransitionTrace = installNearTransitionTrace(NMS);
  });
  if (audit) {
    await page.evaluate(installFoundationGLProbe);
    await page.evaluate(() => { window.__foundationGLProbe.mark('split-orbit');window.__foundationGLProbe.armErrors(); });
  }
  await page.evaluate(({fixedWeather,supplyRows}) => {
    const planet = NMS._planet(0);
    const star = planet.stellarDirectionsAt(planet.weatherHours).sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
    NMS.setAdaptiveQualityLocked();
    if (fixedWeather) NMS.setTimeFrozen();
    if (supplyRows !== null) {
      const pass = NMS._pipeline.volumePass, update = pass.updateCloudColumns;
      const records = [];
      window.__columnSupply = records;
      pass.updateCloudColumns = function(renderer) {
        update.call(this,renderer);
        const bank = this.columnMaps.get(this.activePlanet);
        if (!bank) return;
        if (records.length < 20000) {
          const planet = this.activePlanet, stream = planet.weatherStream;
          records.push({ atMs:performance.now(), frame:this.frame, hours:planet.weatherHours, batch:bank.rows,
            anchor:stream.anchor, step:stream.frameHours, ready:planet.volCloudMat.uniforms.uColumnsReady.value,
            worker:bank.endpointHours().map(hour => [hour,stream.revisionAt(hour)]),
            maps:[...bank.maps].map(([hour,map]) => [hour,map.row,map.ready]) });
        }
      };
    }
    NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+600000)/planet.R, { dir: star.direction, horizon: false });
  }, {fixedWeather,supplyRows});
  await page.waitForFunction(previous => {
    const pipeline = NMS._pipeline, pass = pipeline.volumePass;
    return pass.farSplit.frames > previous + 1 && pass.previousSplitDraw && pass.historyValid
      && pass.historySequence + 1 === pipeline.frameState.sequence && pass.resolveMaterial.uniforms.uHistoryValid.value === 1;
  }, initial.frames, { timeout: 120000 });
  let orbit = await capture('split-history');
  await page.screenshot({ path: `${out}/orbit.png`, timeout: 90000 });
  if (supplyRows !== null) {
    await page.evaluate(() => NMS._pipeline.startProfiling({every:8,history:2000}));
    await page.waitForTimeout(68000);
    supply = await page.evaluate(start => ({ records:window.__columnSupply.filter(row => row.atMs >= start),
      profile:NMS._pipeline.performanceSnapshot() }), orbit.atMs);
    await capture('natural-weather-supply');
    await page.screenshot({ path: `${out}/supply.png`, timeout: 90000 });
    if (requireSupply) {
      const first = supply.records.findIndex(row => row.ready === 1);
      assert.ok(first >= 0, 'Natural weather never published a complete column pair');
      const steady = supply.records.slice(first);
      assert.ok(new Set(steady.map(row => row.anchor)).size >= 3, 'Observe two natural anchor transitions after first publication');
      assert.ok(steady.every(row => row.ready === 1), 'Lost published columns during steady forecast turnover');
    }
  }
  if (requireMixed) {
    // The normal rows producer needs up to 512 world submissions for two
    // 512-row endpoints at two rows per submission. This is a warm observation
    // window, independent of the 120-second first-draw check above.
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'combine', null, { timeout: 240000 });
    orbit = await capture('split-mixed');
    await page.screenshot({ path: `${out}/orbit-mixed.png`, timeout: 90000 });
  }
  if (!skipResize) {
    await page.setViewportSize({ width: 1008, height: 576 });
    await page.waitForFunction(({ frames, size }) => {
      const pass = NMS._pipeline.volumePass;
      return pass.farSplit.frames > frames && pass.previousSplitDraw && pass.historyValid
        && (pass.width !== size[0] || pass.height !== size[1]);
    }, orbit, { timeout: 120000 });
    await capture('split-resized');
  }
  if (requireMixed) {
    await page.evaluate(() => {
      const planet = NMS._planet(0);
      const star = planet.stellarDirectionsAt(planet.weatherHours).sort((a,b) => b.irradianceFraction-a.irradianceFraction)[0];
      NMS.teleport(0, (planet.volCloudBand.rOut-planet.R+3000000)/planet.R, { dir: star.direction, horizon: false });
    });
    await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'cachedDirect', null, { timeout: 120000 });
    await capture('split-cached');
  }
  if (runDescent) {
    if (nearTrace) {
      await page.waitForFunction(() => NMS._pipeline.volumePass.farSplit.lastRoute === 'combine', null, { timeout:30000 });
    }
    if (requireSupply) {
      livePair = await page.evaluate(async () => {
        const { compareLiveCloudPayloads } = await import('/tools/cloud-split-live-compare.js');
        return compareLiveCloudPayloads(NMS);
      });
      console.log(JSON.stringify({ livePair }));
      assert.equal(livePair.gl,0);
      assert.ok(livePair.pairs[0].maximumError <= .002, 'Actual volume HDR parity with the unmasked split');
    }
    await page.evaluate(() => {
      NMS._pipeline.startProfiling({every:1,history:240});
      const planet = NMS._planet(0), THREE = NMS._THREE;
      const coast = NMS.setWade(0, { depth: .9, overview: true });
      if (!coast?.direction || !coast?.landward) throw Error('Continuous descent coast unavailable');
      const land = new THREE.Vector3(...coast.landward);
      const landmark = new THREE.Vector3(...coast.direction).addScaledVector(land, 2000/planet.R).normalize();
      const pipeline = NMS._pipeline, volume = pipeline.volumePass;
      const from = 600000, to = 1200, count = 60;
      NMS.teleport(0, from/planet.R, { dir:coast.direction });
      const state = window.__splitDescent = { startedAt:performance.now(), rows:[], done:false, coast };
      let index = 0, sequence = pipeline.frameState.sequence;
      function place(altitude) {
        const ratio = THREE.MathUtils.smoothstep(altitude,150000,220000)*1.13+.32;
        const direction = landmark.clone().addScaledVector(land,-Math.max(3200,altitude*ratio)/planet.R).normalize();
        NMS.setContinuousAtmosphereAltitude(0,altitude,{dir:direction.toArray(),forward:coast.landward,
          surfaceTargetDirection:landmark.toArray()});
      }
      let altitude = from;
      place(altitude);
      function observe(atMs) {
        if (pipeline.frameState.sequence !== sequence) {
          const far = planet.volCloudMesh.material === planet.volCloudFarMat;
          state.rows.push({ altitude, atMs, sequence:pipeline.frameState.sequence,
            route:volume.previousSplitDraw?volume.farSplit.lastRoute:far?'far-legacy':'near',
            history:volume.resolveMaterial.uniforms.uHistoryValid.value });
          sequence = pipeline.frameState.sequence;
          if (++index > count) { state.done = true;return; }
          altitude = index === count ? to : from*(to/from)**(index/count);
          place(altitude);
        }
        requestAnimationFrame(observe);
      }
      requestAnimationFrame(observe);
    });
    for (const altitude of [400000,180000,30000,1200]) {
      await page.waitForFunction(target => window.__splitDescent?.rows.at(-1)?.altitude <= target, altitude,
        { timeout:180000, polling:100 });
      await page.screenshot({ path:`${out}/descent-${altitude}.png`, timeout:90000 });
    }
    descent = await page.evaluate(() => ({...window.__splitDescent, profile:NMS._pipeline.performanceSnapshot()}));
    assert.ok(descent.done && descent.rows.some(row => row.route === 'near'));
    const end = await capture('descent-low-flight');
    assert.equal(end.gl,0);assert.equal(end.lost,false);assert.equal(end.ready.failed,false);
  }
  if (nearPairRequested) {
    nearPair = await page.evaluate(async () => {
      NMS._pipeline.stopProfiling();
      const { compareLiveNearCloud } = await import('/tools/cloud-near-live-compare.js');
      return compareLiveNearCloud(NMS);
    });
    console.log(JSON.stringify({ nearPair }));
    assert.equal(nearPair.gl,0);assert.equal(nearPair.lost,false);assert.equal(nearPair.disjoint,false);
    for (const {altitude,rows} of nearPair.poses) {
      const parity = rows[0];
      assert.ok(parity.cloudPixels > 0 && parity.maximumError <= .002 && parity.alphaChanged === 0,
        JSON.stringify({altitude,parity}));
      assert.ok(rows.every(row => row.depthReady === 1 && row.sunCacheReady === 1));
      assert.ok(rows.slice(1).every(row => row.gpuMs.original > 0 && row.gpuMs.split > 0));
    }
  }
  for (const state of checkpoints.slice(1)) {
    assert.equal(state.gl,0);assert.equal(state.lost,false);assert.equal(state.ready.failed,false);
    assert.ok(!state.firstError, JSON.stringify(state.firstError));
    if (state.label !== 'descent-low-flight')
      assert.ok(state.hdr?.cloudPixels > 0 && state.hdr?.maxAlpha > 0 && state.hdr?.stableUniforms, JSON.stringify(state.hdr));
    if (state.route === 'combine') assert.deepEqual(state.scratch, [state.size, state.size]);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  failure = String(error);
    if (page && runDescent && !descent) try { descent = await page.evaluate(() => window.__splitDescent); } catch {}
  if (page && nearPairRequested && !nearPair) try { nearPair = await page.evaluate(() => window.__nearLivePair); } catch {}
  if (page) try { await capture('failure'); } catch {}
  throw error;
} finally {
  try {
    if (nearTrace && page) try { transition = await page.evaluate(() => window.__nearTransitionTrace?.finish()); } catch {}
    const after = await evidenceFingerprint(verifier);
    await writeFile(`${out}/report.json`, JSON.stringify({ before, after, viewport, audit, requireMixed, fixedWeather, supplyRows, supply, livePair, nearPair, descent, transition, checkpoints, errors, failure, passed: !failure }, null, 2));
    assert.deepEqual(after, before);
  } finally { await browser?.close();server.close(); }
}
