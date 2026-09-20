// Runtime/evidence collection only. Screenshots and video still need visual
// review; successful navigation and an error-free renderer are not art PASS.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { OCEAN_SECONDS_PER_WORLD_HOUR } from '../src/ocean-clock.js';

const cases = [
  { key: 'jade', systemId: '0,0,0', bodyId: 'planet-0', composition: 'jade-shelf',
    direction: [0.34669147556655305, 0.07291666666666663, -0.9351407276403421] },
  { key: 'violet', systemId: '0,0,0', bodyId: 'planet-1', composition: 'mineral-violet',
    direction: [-0.7536864633453159, 0.30208333333333337, -0.5836971600858205] },
  { key: 'blue', systemId: 'MW-0903', bodyId: 'planet-0', composition: 'temperate-blue',
    direction: [-0.8598862931776247, -0.5104166666666667, -0.008389826823769618] },
  { key: 'copper', systemId: 'MW-0957', bodyId: 'planet-0', composition: 'copper-brine',
    direction: [-0.7587166966546532, -0.17708333333333326, 0.6268895175970057] },
  { key: 'bio', systemId: 'MW-0865', bodyId: 'planet-0', composition: 'bioluminescent',
    direction: [0.4335201018252923, 0.48958333333333337, 0.7565503823511098] },
  { key: 'tidal', systemId: 'MW-0493', bodyId: 'planet-5', composition: 'mineral-violet' },
];
const selected = process.env.OCEAN_WORLD_CASE;
assert.ok(!selected || cases.some((item) => item.key === selected), 'Unknown OCEAN_WORLD_CASE');
const run = cases.filter((item) => !selected || item.key === selected);
const out = `test-results/ocean-world/${selected || 'all'}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/oceanworldtest.js');
const report = { ...fingerprint, status: 'running', scope: 'runtime-only; visual acceptance pending',
  cases: [], errors: [], warnings: [] };
const { server, port } = await startServer(0);
let browser, context, page, video;
try {
  browser = await launchHardwareBrowser({ headless: true });
  assert.ok(browser, 'Hardware system browser is required');
  context = await browser.newContext({ viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: out, size: { width: 1920, height: 1080 } } });
  page = await context.newPage();
  video = page.video();
  page.on('pageerror', (error) => report.errors.push(String(error)));
  page.on('console', (message) => {
    const text = message.text();
    const lines = text.replaceAll('\0', '').split('\n').map((line) => line.trim()).filter(Boolean);
    const harmless = lines.length > 0 && lines.every((line) =>
      /^(?:THREE\.WebGLProgram: Program Info Log: )?\(\d+,\d+(?:-\d+)?\): warning X4122: sum of .* cannot be represented accurately in double precision$/.test(line));
    if (harmless) report.warnings.push(text);
    else if (message.type() === 'error' || /shader error|GPUValidationError/i.test(text)) report.errors.push(text);
  });
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&nohero=1&nolock=1&post=1&vclouds=1&farflora=1&buildms=80`);
  await page.waitForFunction(() => window.NMS?.booted, null, { timeout: 90000 });

  for (const item of run) {
    const evidence = { ...item, navigation: [], captures: [] };
    report.cases.push(evidence);
    if (await page.evaluate(() => NMS.system().id) !== item.systemId) {
      // Use the same full-catalogue selection controller as a star-map label,
      // then the real planet glyph, route choice and warp button. Never adopt
      // a replacement universe/system or teleport across star systems.
      const target = await page.evaluate(({ systemId, bodyId }) => {
        NMS.setTimeFrozen(false);
        NMS.openStarMap();
        const map = NMS._internals.starMap;
        const star = map.globalCandidates().find((candidate) => candidate.id === systemId);
        if (!star) throw new Error(`Catalogue target unavailable: ${systemId}`);
        map.selectStar(star, false);
        const body = map.systemPreview(star).bodies.find((candidate) => candidate.bodyId === bodyId);
        if (!body) throw new Error(`Catalogue body unavailable: ${bodyId}`);
        return { systemId, bodyId, glyphIndex: body.index, selection: 'starMap.selectStar (catalogue label controller)' };
      }, item);
      await page.locator(`#sm-systemGlyph [data-glyph-index="${target.glyphIndex}"]`).click({ force: true });
      await page.waitForFunction(() => document.querySelector('#sm-planetLeft')?.classList.contains('active'));
      await page.locator('#sm-routeAction').click();
      await page.waitForFunction(() => !document.querySelector('#route-choice')?.classList.contains('hidden'),
        null, { timeout: 60000 });
      await page.screenshot({ path: `${out}/${item.key}-route-choice.png` });
      const preparation = await page.evaluate(() => NMS.warpPreparationState());
      await page.locator('#route-warp-btn').click();
      await page.waitForFunction(() => NMS.state === 'warp', null, { timeout: 15000 });
      await page.waitForFunction((systemId) => NMS.system().id === systemId
        && NMS.state === 'space' && !document.body.classList.contains('travel-cinematic'),
      item.systemId, { timeout: 180000 });
      evidence.navigation.push({ ...target, preparation, arrival: await page.evaluate(() => NMS.system()) });
      await page.screenshot({ path: `${out}/${item.key}-warp-arrival.png` });
    }
    await page.waitForFunction((bodyId) => NMS._internals.universe.system.planets
      .some((planet) => planet.bodyId === bodyId), item.bodyId, { timeout: 90000 });
    const fixture = await page.evaluate(async ({ item, oceanScale }) => {
      const { universe, nav } = NMS._internals;
      const index = universe.system.planets.findIndex((planet) => planet.bodyId === item.bodyId);
      const planet = NMS._planet(index);
      const THREE = NMS._THREE;
      NMS.setTimeFrozen(true);
      let direction = item.direction && new THREE.Vector3(...item.direction);
      let event = structuredClone(planet.oceanClimate.event), eventField = null, selectedPeak = null, selectedSun = null;
      if (item.key === 'tidal') {
        event = structuredClone(planet.oceanClimate.event);
        if (!event) throw new Error('Selected real world no longer carries a tidal event');
        const { createOceanTidalEvent } = await import('/src/ocean-tidal-event.js');
        eventField = createOceanTidalEvent(event, { radius: planet.seaRadius, gravity: planet.gravity });
        direction = new THREE.Vector3(...eventField.up).multiplyScalar(planet.seaRadius)
          .addScaledVector(new THREE.Vector3(...eventField.axis), 900).normalize();
      }
      const altitude = 24;
      const place = () => {
        NMS.teleport(index, (planet.seaLevel + altitude) / planet.R,
          { dir: direction.toArray(), horizon: true, pitch: -0.08 });
        if (eventField) {
          const target = planet.localPositionToWorld(new THREE.Vector3(...eventField.up)
            .multiplyScalar(planet.seaRadius + event.height * 0.45), new THREE.Vector3());
          const up = planet.localOffsetToWorld(direction, new THREE.Vector3()).normalize();
          nav.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(nav.pos, target, up));
        }
      };
      place();
      const lighting = NMS.setLocalSunAltitude(index, item.key === 'bio' ? -12 : 28);
      if (eventField) {
        // Sun selection changes the persisted clock. Search actual event peaks
        // afterwards, then restore the chosen real clock and camera pose.
        const nowSeconds = NMS.stats().cosmicHours * oceanScale;
        const firstCycle = Math.ceil((nowSeconds - event.epoch) / event.period - 0.5);
        let best = -Infinity;
        for (let i = 0; i < 96; i++) {
          const peak = event.epoch + (firstCycle + i + 0.5) * event.period;
          NMS.setTime(peak / oceanScale);
          const elevation = direction.dot(planet.sunDirLocal);
          if (elevation > best) { best = elevation; selectedPeak = peak; }
          if (elevation > 0.45) break;
        }
        NMS.setTime((selectedPeak - 6) / oceanScale);
        selectedSun = Math.asin(Math.max(-1, Math.min(1, direction.dot(planet.sunDirLocal)))) * 180 / Math.PI;
      }
      place();
      NMS.shipViewDebug.setViewMode('chase');
      return { index, systemId: NMS.system().id, bodyId: planet.bodyId, name: planet.name,
        seed: planet.seed, type: planet.type, composition: planet.oceanClimate.composition,
        direction: direction.toArray(), altitude, depth: planet.seaLevel - planet.height(direction, planet.fullMaxFreq),
        event, eventField, selectedPeakOceanSeconds: selectedPeak, selectedSolarElevationDegrees: selectedSun,
        tidalNightScene: selectedSun !== null && selectedSun <= 0, lighting,
        clock: NMS.stats().cosmicHours, source: 'canonical generated world; QA camera positioning only' };
    }, { item, oceanScale: OCEAN_SECONDS_PER_WORLD_HOUR });
    evidence.fixture = fixture;
    assert.equal(fixture.composition, item.composition);
    assert.equal(fixture.systemId, item.systemId);
    assert.ok(fixture.depth > 10, 'Reference camera must be above actual deep water');
    await page.waitForFunction((index) => {
      const p = NMS._planet(index);
      const water = NMS.waterState(index);
      return water?.near?.visible && !water.near.pending && water.global.pending === 0
        && p.lod.debugStats().pending === 0 && water.global.activeMorphs === 0;
    }, fixture.index, { timeout: 180000, polling: 250 });
    await page.waitForTimeout(2500);
    await page.evaluate(() => { NMS.resetPerformanceStats(); NMS.setTimeFrozen(false); });
    for (const [label, delay] of [['early', 1000], ['moving', 5000], ['settled', 4000]]) {
      await page.waitForTimeout(delay);
      const image = `${item.key}-${label}.png`;
      await page.screenshot({ path: `${out}/${image}` });
      const state = await page.evaluate((index) => {
        const p = NMS._planet(index), { nav, camera } = NMS._internals;
        const local = p.worldPositionToLocal(nav.pos, new NMS._THREE.Vector3());
        return { stats: NMS.stats(), system: NMS.system(), water: NMS.waterState(index),
          bodyId: p.bodyId, seed: p.seed, event: p.oceanClimate.event,
          localPosition: local.toArray(), altitudeAboveSea: local.length() - p.seaRadius,
          cameraQuaternion: camera.quaternion.toArray(), navPosition: NMS.pos() };
      }, fixture.index);
      assert.equal(state.system.id, item.systemId);
      assert.equal(state.bodyId, item.bodyId);
      assert.equal(state.stats.rendererBackend, 'webgl2');
      assert.ok(Number.isFinite(state.altitudeAboveSea) && state.altitudeAboveSea > 0,
        'QA camera drifted below the sea; this is not the intended surface capture');
      assert.equal(state.stats.paused, false, 'Capture must retain the active gameplay render chain');
      assert.ok(!/SwiftShader|llvmpipe|software/i.test(state.stats.gpu), 'Hardware renderer required');
      assert.deepEqual(state.event, fixture.event || null,
        'Generated event content must never be modified for a capture');
      evidence.captures.push({ image, ...state });
    }
    if (item.key === 'tidal') {
      evidence.playerTraversal = { input: 'KeyW for 20 seconds; no post-placement camera or clock changes', samples: [] };
      await page.evaluate(() => NMS.setBuildBudget(0));
      await page.keyboard.down('KeyW');
      try {
        for (let second = 1; second <= 20; second++) {
          await page.waitForTimeout(1000);
          const sample = await page.evaluate((index) => {
            const p = NMS._planet(index), { nav } = NMS._internals;
            const local = p.worldPositionToLocal(nav.pos, new NMS._THREE.Vector3());
            const surface = p.sampleWaterSurface(local, p.weatherHours, { normal: false });
            return { localPosition: local.toArray(), speed: nav.vel.length(),
              clearance: surface?.clearance, waveHeight: surface?.waveHeight,
              tidalHeight: surface?.tidalHeight,
              wet: surface?.wet, stats: NMS.stats(), fixtureActive: NMS.waterWakeDebug() !== null };
          }, fixture.index);
          evidence.playerTraversal.samples.push({ second, ...sample });
          if (second % 4 === 0) await page.screenshot({ path: `${out}/tidal-player-${second}s.png` });
        }
      } finally { await page.keyboard.up('KeyW'); }
      const samples = evidence.playerTraversal.samples;
      assert.ok(samples.some((s) => s.speed > 30), 'Tidal traversal must exercise real flight input');
      assert.ok(samples.every((s) => !s.fixtureActive && s.wet && Number.isFinite(s.clearance)),
        'Real tidal crossing must retain finite production water contact, without a wake fixture');
      assert.ok(samples.some((s) => s.tidalHeight > fixture.event.height * 0.35),
        'Player must actually traverse the large wave, not merely view it from afar');
      const immersed = samples.findIndex((s) => s.stats.environment.underwater);
      assert.ok(immersed >= 0 && samples.slice(immersed + 1).some((s) => !s.stats.environment.underwater),
        'Real giant-wave crossing must enter and leave the displaced water volume');
    }
    if (item.key === 'bio' && process.env.OCEAN_BIO_DIAGNOSTIC === '1') {
      evidence.bioDiagnostic = { scope: 'Optical attribution only; normal HUD/post retained, camera/time/exposure held by harness.', captures: [] };
      evidence.bioDiagnostic.held = await page.evaluate((index) => {
        NMS.setTimeFrozen(true);
        const p = NMS._planet(index), { camera, renderer } = NMS._internals;
        const material = p.liquidMat, pipeline = NMS._pipeline;
        const uniforms = material.userData.waterUniforms || material.userData.shader.uniforms;
        const held = { index, material, compile: material.onBeforeCompile,
          key: material.customProgramCacheKey, render: pipeline.render,
          cameraPosition: camera.position.clone(), cameraQuaternion: camera.quaternion.clone(),
          exposure: renderer.toneMappingExposure, gradeTime: pipeline.grade?.uniforms.uTime.value,
          waveTime: uniforms.uTime.value, activity: uniforms.uBiologicalActivity.value,
          day: uniforms.uDay.value, nutrients: NMS.waterState(index).ocean.nutrients, mode: 'bio-identity' };
        window.__oceanBioDiagnostic = held;
        pipeline.render = function (...args) {
          // Apply holds immediately before the real production compositor:
          // ordinary frame updates cannot advance grade/exposure/camera here.
          camera.position.copy(held.cameraPosition); camera.quaternion.copy(held.cameraQuaternion);
          camera.updateMatrixWorld(true);
          renderer.toneMappingExposure = held.exposure;
          if (pipeline.grade) pipeline.grade.uniforms.uTime.value = held.gradeTime;
          const u = material.userData.waterUniforms || material.userData.shader.uniforms;
          u.uTime.value = held.waveTime; u.uDay.value = held.day;
          u.uBiologicalActivity.value = held.mode === 'bio-population' ? held.nutrients : held.activity;
          return held.render.apply(this, args);
        };
        return { cosmicHours: NMS.stats().cosmicHours, cameraPosition: camera.position.toArray(),
          cameraQuaternion: camera.quaternion.toArray(), exposure: held.exposure, gradeTime: held.gradeTime,
          waveTime: held.waveTime, uDay: held.day, uBiologicalActivity: held.activity, nutrients: held.nutrients,
          caveat: 'Unrelated particles/session animations may still move; not a pixel-exact whole-scene acceptance test.' };
      }, fixture.index);
      try {
        for (const mode of ['bio-identity', 'bio-off', 'bio-only', 'bio-population']) {
          await page.evaluate((mode) => {
            const held = window.__oceanBioDiagnostic, material = held.material;
            held.mode = mode;
            material.onBeforeCompile = (shader) => {
              held.compile(shader);
              const marker = 'totalEmissiveRadiance += vec3(0.015, 0.62, 0.48)';
              if (!shader.fragmentShader.includes(marker)) throw new Error('Biological emission diagnostic marker changed.');
              shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>', '#include <common>\nvec3 diagnosticBiologicalEmission = vec3(0.0);')
                .replace(marker, 'diagnosticBiologicalEmission = vec3(0.015, 0.62, 0.48)');
              const end = '* uBiologicalActivity * biologicalAgitation * biologicalNight * 2.0;';
              if (!shader.fragmentShader.includes(end)) throw new Error('Biological emission diagnostic expression changed.');
              shader.fragmentShader = shader.fragmentShader.replace(end,
                `${end}\n totalEmissiveRadiance += ${mode === 'bio-off' ? 'vec3(0.0)' : 'diagnosticBiologicalEmission'};`);
              if (mode === 'bio-only') shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>',
                'outgoingLight = diagnosticBiologicalEmission;\n#include <opaque_fragment>');
            };
            material.customProgramCacheKey = () => `diagnostic-${mode}`;
            material.needsUpdate = true;
          }, mode);
          await page.waitForTimeout(1200);
          const image = `${mode}.png`;
          await page.screenshot({ path: `${out}/${image}` });
          const draw = await page.evaluate(() => {
            const held = window.__oceanBioDiagnostic;
            const u = held.material.userData.shader.uniforms;
            return { uDay: u.uDay.value, uBiologicalActivity: u.uBiologicalActivity.value,
              waveTime: u.uTime.value, gradeTime: NMS._pipeline.grade?.uniforms.uTime.value,
              exposure: NMS._renderer.toneMappingExposure, cosmicHours: NMS.stats().cosmicHours,
              cameraPosition: NMS._internals.camera.position.toArray(),
              cameraQuaternion: NMS._internals.camera.quaternion.toArray() };
          });
          evidence.bioDiagnostic.captures.push({ mode, image, draw });
          for (const key of ['waveTime', 'gradeTime', 'exposure', 'cosmicHours']) {
            assert.equal(draw[key], evidence.bioDiagnostic.held[key], `Bio attribution hold drifted: ${key}`);
          }
          assert.deepEqual(draw.cameraPosition, evidence.bioDiagnostic.held.cameraPosition);
          assert.deepEqual(draw.cameraQuaternion, evidence.bioDiagnostic.held.cameraQuaternion);
        }
      } finally {
        await page.evaluate(() => {
          const held = window.__oceanBioDiagnostic;
          if (!held) return;
          held.material.onBeforeCompile = held.compile;
          held.material.customProgramCacheKey = held.key;
          held.material.needsUpdate = true;
          NMS._pipeline.render = held.render;
          delete window.__oceanBioDiagnostic;
          NMS.setTimeFrozen(false);
        });
      }
    }
    if (item.key === 'bio' && process.env.OCEAN_SKY_DIAGNOSTIC === '1') {
      evidence.skyDiagnostic = { scope: 'Sky attribution only; normal HUD/post, held camera/clock/exposure.', captures: [] };
      evidence.skyDiagnostic.held = await page.evaluate((index) => {
        NMS.setTimeFrozen(true);
        const p = NMS._planet(index), pipeline = NMS._pipeline;
        const { camera, renderer } = NMS._internals;
        const held = { index, render: pipeline.render, shader: pipeline.atmospherePass.material.fragmentShader,
          atmosphereVisible: pipeline.atmospherePass.visualEnabled, cloudsVisible: p.cloudVisualEnabled,
          position: camera.position.clone(), quaternion: camera.quaternion.clone(),
          exposure: renderer.toneMappingExposure, gradeTime: pipeline.grade?.uniforms.uTime.value,
          oceanTime: p.liquidMat.userData.shader.uniforms.uTime.value };
        held.cloudMaterials = [];
        p.group.traverse((object) => {
          const material = object.material;
          if (material?.uniforms?.uRin && !held.cloudMaterials.some((entry) => entry.material === material)) {
            held.cloudMaterials.push({ material, shader: material.fragmentShader,
              rIn: material.uniforms.uRin.value, rOut: material.uniforms.uRout.value });
          }
        });
        window.__oceanSkyDiagnostic = held;
        pipeline.render = function (...args) {
          camera.position.copy(held.position); camera.quaternion.copy(held.quaternion); camera.updateMatrixWorld(true);
          renderer.toneMappingExposure = held.exposure;
          if (pipeline.grade) pipeline.grade.uniforms.uTime.value = held.gradeTime;
          p.liquidMat.userData.shader.uniforms.uTime.value = held.oceanTime;
          return held.render.apply(this, args);
        };
        return { cosmicHours: NMS.stats().cosmicHours, exposure: held.exposure, gradeTime: held.gradeTime,
          oceanTime: held.oceanTime, cameraPosition: held.position.toArray(), cameraQuaternion: held.quaternion.toArray(),
          planetRadius: p.R, seaRadius: p.seaRadius, cloudRenderLayer: p.cloudRenderLayer,
          caveat: 'Cloud temporal jitter and unrelated particles may still evolve; numerical sky attribution, not pixel-exact full-scene acceptance.' };
      }, fixture.index);
      try {
        for (const mode of ['sky-identity', 'sky-clouds-off-atmo20', 'sky-clouds-off-atmo80', 'sky-atmo-off-clouds-on',
          'sky-clouds-thin', 'sky-clouds-isotropic', 'sky-clouds-thin-isotropic']) {
          await page.evaluate((mode) => {
            const held = window.__oceanSkyDiagnostic, pipeline = NMS._pipeline;
            const atmosphere = pipeline.atmospherePass.material;
            if (!/#define VIEW_STEPS\s+20\b/.test(held.shader)) throw new Error('Sky diagnostic expects production VIEW_STEPS=20; review fixture.');
            atmosphere.fragmentShader = mode === 'sky-clouds-off-atmo80'
              ? held.shader.replace(/#define VIEW_STEPS\s+20\b/, '#define VIEW_STEPS 80') : held.shader;
            atmosphere.needsUpdate = true;
            for (const entry of held.cloudMaterials) {
              entry.material.fragmentShader = entry.shader;
              entry.material.uniforms.uRout.value = mode.includes('thin')
                ? entry.rIn + (entry.rOut - entry.rIn) / 3 : entry.rOut;
              if (mode.includes('isotropic')) {
                const target = 'vec3(0.37, 0.71, 0.53) * (h * 2.7)';
                if (!entry.shader.includes(target)) throw new Error('Missing cloud noise frame diagnostic target');
                entry.material.fragmentShader = entry.shader.replace(target,
                  'uSpin * radial * ((r - uRin) / 118000.0)');
              }
              entry.material.needsUpdate = true;
            }
            NMS.setAtmosphereVisible(mode !== 'sky-atmo-off-clouds-on');
            NMS.setCloudsVisible(!mode.startsWith('sky-clouds-off'), held.index);
            if (pipeline.volumePass) pipeline.volumePass.historyValid = false;
          }, mode);
          await page.waitForTimeout(1500);
          const image = `${mode}.png`;
          await page.screenshot({ path: `${out}/${image}` });
          const draw = await page.evaluate(() => {
            const held = window.__oceanSkyDiagnostic, pipeline = NMS._pipeline, p = NMS._planet(held.index);
            const serialize = (uniforms) => Object.fromEntries(Object.entries(uniforms || {}).flatMap(([key, uniform]) => {
              const value = uniform.value;
              if (typeof value === 'number' || typeof value === 'boolean') return [[key, value]];
              if (value?.toArray && !value.isTexture) return [[key, value.toArray()]];
              return [];
            }));
            const cloudDraws = [];
            p.group.traverse((object) => {
              const m = object.material;
              if (m?.uniforms?.uRin) cloudDraws.push({ name: object.name, visible: object.visible, uniforms: serialize(m.uniforms) });
            });
            return { cosmicHours: NMS.stats().cosmicHours, exposure: NMS._renderer.toneMappingExposure,
              gradeTime: pipeline.grade?.uniforms.uTime.value,
              cameraPosition: NMS._internals.camera.position.toArray(), cameraQuaternion: NMS._internals.camera.quaternion.toArray(),
              viewSteps: Number(pipeline.atmospherePass.material.fragmentShader.match(/#define VIEW_STEPS\s+(\d+)/)[1]),
              cloudsVisible: p.cloudVisualEnabled, volumeActive: !!pipeline.volumePass?.activePlanet,
              atmosphere: serialize(pipeline.atmospherePass.material.uniforms), clouds: cloudDraws };
          });
          evidence.skyDiagnostic.captures.push({ mode, image, draw });
          for (const key of ['cosmicHours', 'exposure', 'gradeTime']) assert.equal(draw[key], evidence.skyDiagnostic.held[key]);
          assert.deepEqual(draw.cameraPosition, evidence.skyDiagnostic.held.cameraPosition);
          assert.deepEqual(draw.cameraQuaternion, evidence.skyDiagnostic.held.cameraQuaternion);
        }
      } finally {
        await page.evaluate(() => {
          const held = window.__oceanSkyDiagnostic;
          if (!held) return;
          const pipeline = NMS._pipeline;
          pipeline.atmospherePass.material.fragmentShader = held.shader;
          pipeline.atmospherePass.material.needsUpdate = true;
          for (const entry of held.cloudMaterials) {
            entry.material.fragmentShader = entry.shader;
            entry.material.uniforms.uRout.value = entry.rOut;
            entry.material.needsUpdate = true;
          }
          NMS.setAtmosphereVisible(held.atmosphereVisible);
          NMS.setCloudsVisible(held.cloudsVisible !== false, held.index);
          pipeline.render = held.render;
          if (pipeline.volumePass) pipeline.volumePass.historyValid = false;
          delete window.__oceanSkyDiagnostic;
          NMS.setTimeFrozen(false);
        });
      }
    }
    await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  }
  assert.deepEqual(report.errors, [], report.errors.join('\n'));
  const finalFingerprint = await evidenceFingerprint('tools/oceanworldtest.js');
  report.stableSource = finalFingerprint.sourceDigest === fingerprint.sourceDigest;
  assert.ok(report.stableSource, 'Runtime source changed during world traversal');
  report.status = 'runtime-only-complete';
  console.log(`Runtime evidence collected at ${out}; visual acceptance remains pending.`);
} catch (error) {
  report.status = 'runtime-failed';
  report.failure = String(error.stack || error);
  if (page) await page.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await context?.close();
  if (video) report.video = await video.path();
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
