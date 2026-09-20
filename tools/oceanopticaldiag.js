// Component attribution only: no aesthetic PASS and no alternative player view.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const name = process.env.OCEAN_OPTICAL_CASE || 'violet';
const candidate = process.env.OCEAN_OPTICAL_CANDIDATE === '1';
const candidateFiles = ['tools/ocean-micro-wave-candidate.js', 'tools/ocean-optics-candidate.js'];
const candidateDigests = async () => Object.fromEntries(await Promise.all(candidateFiles.map(async (file) =>
  [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
assert.ok(['jade', 'violet'].includes(name));
const fixture = name === 'jade'
  ? { bodyId: 'planet-0', composition: 'jade-shelf', dir: [0.34669148, 0.07291667, -0.93514073] }
  : { bodyId: 'planet-1', composition: 'mineral-violet', dir: [-0.75368646, 0.30208333, -0.58369716] };
const out = `test-results/ocean-optical/${name}-${new Date().toISOString().replaceAll(':', '-')}`;
await mkdir(out, { recursive: true });
const fingerprint = await evidenceFingerprint('tools/oceanopticaldiag.js');
const { server, port } = await startServer(0);
const browser = await launchHardwareBrowser({ headless: true });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
const page = await context.newPage();
const report = { ...fingerprint, fixture, captures: [], errors: [],
  scope: 'Frozen optical attribution, normal HUD/post/clouds/farflora. No view relocation after initialization. Reflection-weight mode changes only the existing gradient reflection coefficient, not its directional environment source or PBR energy ownership. Unrelated scene animations/cloud temporal history may evolve. Not subjective acceptance.' };
if (candidate) {
  report.candidateDigests = await candidateDigests();
  report.candidateScope = 'Analytic optical micro-gradient, no geometry/collision displacement. Crest foam is a height/slope heuristic, not a measured Gerstner Jacobian. Existing macro/interaction gradients and distance fade retained.';
}
page.on('pageerror', (error) => report.errors.push(String(error)));
page.on('console', (message) => { if (message.type() === 'error') report.errors.push(message.text()); });
const location = () => page.evaluate((index) => {
  const p = NMS._planet(index), { nav } = NMS._internals;
  const local = p.worldPositionToLocal(nav.pos, new NMS._THREE.Vector3());
  return { stats: NMS.stats(), water: NMS.waterState(index), state: NMS.state,
    actualSeaClearance: local.length() - p.seaRadius, local: local.toArray(),
    nav: nav.pos.toArray(), velocity: nav.vel.toArray(), time: NMS.time() };
}, fixture.index);
try {
  await page.goto(`http://127.0.0.1:${port}/?quality=ultra&nohero=1&post=1&vclouds=1&farflora=1&buildms=80`);
  await page.waitForFunction(() => NMS?.booted, null, { timeout: 120000 });
  fixture.index = await page.evaluate(({ bodyId, composition, dir }) => {
    const planets = NMS._internals.universe.system.planets;
    const index = planets.findIndex((p) => p.bodyId === bodyId);
    const p = planets[index];
    if (!p?.hasLiquid || !p.nearWaterPatch || p.oceanClimate?.composition !== composition) {
      throw new Error(`Invalid optical fixture ${bodyId}/${index}: expected ${composition} liquid`);
    }
    if (p.seaLevel - p.height(new NMS._THREE.Vector3(...dir).normalize(), p.fullMaxFreq) < 10) {
      throw new Error('Optical fixture must be above actual deep water');
    }
    return index;
  }, fixture);
  await page.evaluate(({ index, dir }) => {
    const p = NMS._planet(index);
    NMS.teleport(index, (p.seaLevel + 24) / p.R, { dir, horizon: true, pitch: -0.04 });
    NMS.setLocalSunAltitude(index, 34);
  }, fixture);
  report.initialAfterLight = await location();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  report.initialAfterFrames = await location();
  // The lighting search changes ephemeris/frame state. Let normal reference
  // ownership consume that change, then establish the sole final QA pose.
  await page.evaluate(({ index, dir }) => {
    const p = NMS._planet(index);
    NMS.teleport(index, (p.seaLevel + 24) / p.R, { dir, horizon: true, pitch: -0.04 });
  }, fixture);
  report.finalFixture = await location();
  await page.waitForFunction((index) => {
    const w = NMS.waterState(index);
    return w?.near?.visible && !w.near.pending && w.global.pending === 0;
  }, fixture.index, { timeout: 180000 });
  await page.waitForTimeout(4000);
  report.hold = await page.evaluate(async ({ index, candidate }) => {
    const p = NMS._planet(index), material = p.liquidMat, pipeline = NMS._pipeline;
    const { renderer, camera } = NMS._internals;
    const clockFrozen = NMS.time().frozen;
    NMS.setTimeFrozen(true);
    const held = { material, compile: material.onBeforeCompile, key: material.customProgramCacheKey,
      render: pipeline.render, clockFrozen, position: camera.position.clone(), quaternion: camera.quaternion.clone(),
      exposure: renderer.toneMappingExposure, gradeTime: pipeline.grade.uniforms.uTime.value,
      hours: NMS.time().hours, waveTime: material.userData.shader.uniforms.uTime.value,
      oceanTime: material.userData.waterUniforms.uOceanTime.value, shaders: new Set(), draws: 0 };
    if (candidate) {
      const micro = await import('/tools/ocean-micro-wave-candidate.js');
      held.applyOptics = (await import('/tools/ocean-optics-candidate.js')).applyOceanOpticsCandidate;
      const mainShortest = Math.min(...p.oceanSurface.waveField.modes.map((m) => Math.PI * 2 / m.k));
      held.microField = micro.createOceanMicroCandidate(p.seed, {
        gravity: p.gravity, maxWavelength: Math.max(0.8, Math.min(20, mainShortest * 0.7)) });
      held.microAnchor = material.userData.waterUniforms.uNearPatchCenter.value.clone();
      held.microPhaseValues = micro.oceanMicroCandidatePhases(held.microField, held.microAnchor, held.oceanTime);
      held.microGLSL = micro.oceanMicroCandidateGLSL(held.microField);
      held.microUniforms = {
        uMicroModes: { value: held.microField.modes.map((m) => new NMS._THREE.Vector4(...m.axis, m.k)) },
        uMicroPhases: { value: held.microPhaseValues.map((phase) => new NMS._THREE.Vector2(...phase)) },
        uMicroStrength: { value: 1 },
      };
      held.originalDetailOffsets = material.userData.waterUniforms.uOceanDetailOffsets.value
        .map((v) => v.toArray());
    }
    window.oceanOpticalHold = held;
    pipeline.render = function (...args) {
      camera.position.copy(held.position); camera.quaternion.copy(held.quaternion); camera.updateMatrixWorld(true);
      renderer.toneMappingExposure = held.exposure;
      pipeline.grade.uniforms.uTime.value = held.gradeTime;
      for (const shader of held.shaders) {
        shader.uniforms.uTime.value = held.waveTime;
      }
      if (held.originalDetailOffsets) {
        const offsets = material.userData.waterUniforms.uOceanDetailOffsets.value;
        for (let i = 0; i < 2; i++) {
          const old = held.originalDetailOffsets[i];
          const next = held.mode === 'metre-scale-crest-foam'
            ? old.map((v, axis) => {
              const bias = axis === 2 ? 0.37 : axis === 3 ? 0.19 : 0;
              const value = (v - bias) * 8 + bias;
              return value - Math.floor(value);
            }) : old;
          offsets[i].fromArray(next);
        }
      }
      const result = held.render.apply(this, args);
      held.draws++;
      held.lastDraw = { hours: NMS.time().hours, exposure: renderer.toneMappingExposure,
        gradeTime: pipeline.grade.uniforms.uTime.value,
        waveTime: material.userData.shader.uniforms.uTime.value,
        oceanTime: material.userData.waterUniforms.uOceanTime.value,
        cameraPosition: camera.position.toArray(), cameraQuaternion: camera.quaternion.toArray() };
      if (held.microUniforms) {
        held.lastDraw.microAnchor = material.userData.waterUniforms.uNearPatchCenter.value.toArray();
        held.lastDraw.microPhases = held.microUniforms.uMicroPhases.value.map((v) => v.toArray());
      }
      return result;
    };
    return { hours: held.hours, exposure: held.exposure, gradeTime: held.gradeTime,
      waveTime: held.waveTime, oceanTime: held.oceanTime,
      ...(candidate ? { microAnchor: held.microAnchor.toArray(), microPhases: held.microPhaseValues } : {}),
      cameraPosition: held.position.toArray(), cameraQuaternion: held.quaternion.toArray() };
  }, { index: fixture.index, candidate });
  if (candidate) report.microField = await page.evaluate(() => window.oceanOpticalHold.microField);
  const modes = candidate
    ? ['identity', 'texture-sharp-crest-foam', 'metre-scale-crest-foam', 'restored']
    : ['identity', 'openWhitecap-off', 'facetEmission-off', 'microSlope-off', 'reflection-weight-unit-F', 'restored'];
  for (const [sequence, mode] of modes.entries()) {
    await page.evaluate(({ mode, sequence }) => {
      const h = window.oceanOpticalHold;
      h.mode = mode; h.draws = 0;
      h.marker = `oceanOpticalDiagnosticMode${sequence}`;
      h.material.onBeforeCompile = (shader) => {
        h.compile(shader);
        const replace = (from, to) => {
          if (from === 'vec2 g = (gWaterDetail - 0.5) * 1.04;'
              && !shader.fragmentShader.includes(from)) from = 'vec2 g = (gWaterDetail - 0.5) * 2.2;';
          if (!shader.fragmentShader.includes(from)) throw new Error(`Missing optical marker ${mode}: ${from}`);
          shader.fragmentShader = shader.fragmentShader.replace(from, to);
        };
        replace('#include <common>', `#include <common>\nconst float ${h.marker} = ${sequence}.0;`);
        if (mode.startsWith('analytic-micro')) {
          Object.assign(shader.uniforms, h.microUniforms);
          replace('#include <common>', `#include <common>\n${h.microGLSL}`);
          replace('vec2 g = (gWaterDetail - 0.5) * 1.04;',
            `float microFootprint = max(length(dFdx(vOceanRelative)), length(dFdy(vOceanRelative)));
          OceanMicroSample opticalMicro = oceanMicroSample(vOceanRelative, upL, microFootprint);
          // Existing composition applies g * 0.5; compensate so the analytic
          // gradient, not an arbitrary half-amplitude spectrum, reaches N.
          vec2 g = (gWaterDetail - 0.5) * 1.6
            + vec2(dot(opticalMicro.gradient, tanL), dot(opticalMicro.gradient, bitL)) * 0.6;`);
          replace('g += capillary * 0.8;', 'g += capillary * 0.0;');
          if (mode.includes('crest-foam')) h.applyOptics(shader, 'crest-foam');
          if (mode.includes('no-facet')) h.applyOptics(shader, 'volume-no-facet-emission');
        }
        if (mode === 'texture-sharp-crest-foam') {
          replace('vec2 g = (gWaterDetail - 0.5) * 1.04;',
            'vec2 g = (gWaterDetail - 0.5) * 2.2;');
          h.applyOptics(shader, 'crest-foam');
        }
        if (mode === 'metre-scale-crest-foam') {
          for (const name of ['A', 'B']) replace(
            `float oceanDetail${name}(vec3 relativePosition, vec2 drift) {`,
            `float oceanDetail${name}(vec3 relativePosition, vec2 drift) {\nrelativePosition *= 8.0;`);
          replace('vec2 g = (gWaterDetail - 0.5) * 1.04;',
            'vec2 g = (gWaterDetail - 0.5) * 2.2;');
          h.applyOptics(shader, 'crest-foam');
        }
        if (mode === 'openWhitecap-off') replace(
          'float openWhitecap = ', 'float openWhitecap = 0.0 * ');
        if (mode === 'facetEmission-off') replace(
          'totalEmissiveRadiance += mix(uDeepC, uShallowC, gWaterShallow)',
          'totalEmissiveRadiance += vec3(0.0) * mix(uDeepC, uShallowC, gWaterShallow)');
        if (mode === 'microSlope-off') {
          replace('vec2 g = (gWaterDetail - 0.5) * 1.04;', 'vec2 g = vec2(0.0);');
          replace('g += capillary * 0.8;', 'g += capillary * 0.0;');
        }
        if (mode === 'reflection-weight-unit-F') replace(
          '(0.016 + gWaterShallow * 0.035\n              + fresnel * (0.16 + uDay * 0.24))', '(fresnel)');
        shader.uniforms.uTime.value = h.waveTime;
        h.shaders.add(shader);
      };
      h.material.customProgramCacheKey = () => `optical-attribution-${mode}-${sequence}`;
      h.material.needsUpdate = true;
    }, { mode, sequence });
    await page.waitForFunction(() => window.oceanOpticalHold.draws >= 8);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${out}/${mode}.png` });
    const draw = await page.evaluate(() => {
      const h = window.oceanOpticalHold, renderer = NMS._renderer, gl = renderer.getContext();
      const programs = [...(renderer.properties.get(h.material).programs?.values() || [])];
      const compiled = programs.map((p) => gl.getShaderSource(p.fragmentShader))
        .filter((source) => source?.includes(h.marker));
      return { ...h.lastDraw, marker: h.marker, compiled, compiledCount: compiled.length,
        draws: h.draws, gpu: NMS.stats().gpu };
    });
    report.captures.push({ mode, image: `${mode}.png`, ...draw, compiled: undefined });
    await writeFile(`${out}/${mode}-compiled.json`, JSON.stringify(draw.compiled, null, 2));
    assert.ok(draw.compiledCount > 0, `Actual compiled program missing ${draw.marker}`);
    for (const [key, expected] of Object.entries(report.hold)) assert.deepEqual(draw[key], expected, `${mode}: hold ${key}`);
  }
  assert.deepEqual(report.errors, []);
} catch (error) {
  report.failure = String(error.stack || error);
  report.failureState = await location().catch((failure) => ({ error: String(failure) }));
  await page.screenshot({ path: `${out}/failure-player.png` }).catch(() => {});
} finally {
  await page.evaluate(() => {
    const h = window.oceanOpticalHold;
    if (!h) return;
    h.material.onBeforeCompile = h.compile; h.material.customProgramCacheKey = h.key; h.material.needsUpdate = true;
    NMS._pipeline.render = h.render; NMS.setTimeFrozen(h.clockFrozen);
    delete window.oceanOpticalHold;
  }).catch(() => {});
  const end = await evidenceFingerprint('tools/oceanopticaldiag.js');
  report.stableSource = fingerprint.sourceDigest === end.sourceDigest;
  if (candidate) {
    report.finalCandidateDigests = await candidateDigests();
    report.stableCandidates = JSON.stringify(report.candidateDigests) === JSON.stringify(report.finalCandidateDigests);
    if (!report.stableCandidates) report.failure ||= 'Candidate module changed during evidence';
  }
  await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
  await context.close(); await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
console.log(JSON.stringify({ out, stableSource: report.stableSource, failure: report.failure || null,
  captures: report.captures.map(({ mode, compiledCount }) => ({ mode, compiledCount })) }, null, 2));
assert.ok(!report.failure && report.stableSource, 'Attribution execution/hold failed; inspect report.');
