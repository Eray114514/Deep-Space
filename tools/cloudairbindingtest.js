// CPU regression for production cloud/atmosphere ownership transitions.
// Uses real Planet.update, AtmospherePass.setActivePlanet and VolumetricPass.render.
// The renderer double records eligible submissions; it does not execute shaders.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { Planet, setVolumetricCloudsEnabled } from '../src/planet.js';
import { AtmospherePass } from '../src/atmosphere-pass-webgl.js';
import { VolumetricPass as CurrentVolumetricPass, VOLUME_LAYER } from '../src/volumetric-pass-webgl.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/cloudairbindingtest.js';
assert.ok(process.argv.slice(2).every(value => value === '--reference'), 'Only --reference is supported');
const reference = process.argv.includes('--reference'), referenceCommit = '5bc09dd';
const out = `test-results/cloud-air-binding/${reference ? 'reference-' : 'current-'}${new Date().toISOString().replace(/[:.]/g, '-')}`;
const before = await evidenceFingerprint(verifier);
const sources = ['src/planet.js', 'src/stellar-occlusion.js', 'src/clouds-webgl.js',
  'src/atmosphere-pass-webgl.js', 'src/atmosphere-uniforms.js',
  'src/atmosphere-transport-glsl.js', 'src/cloud/cloud-air-transport-glsl.js',
  'src/volumetric-pass-webgl.js', 'src/render-frame-state.js', 'src/main.js', verifier];
const frozen = new Map(await Promise.all(sources.map(async file => [file, await readFile(file)])));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await mkdir(out, { recursive: true });
for (const [file, bytes] of frozen) await writeFile(`${out}/${file.replaceAll('/', '__')}`, bytes);
let VolumetricPass = CurrentVolumetricPass, referenceSource = null, importedReferenceSource = null;
if (reference) {
  referenceSource = execFileSync('git', ['show', `${referenceCommit}:src/volumetric-pass-webgl.js`], { encoding: 'utf8' });
  // Rewrite only static import specifiers so the complete old class executes
  // from a data URL. Its methods, including actual render, remain byte-for-byte.
  const base = new URL('../src/volumetric-pass-webgl.js', import.meta.url);
  importedReferenceSource = referenceSource.replace(/(\bfrom\s*['"])([^'"]+)(['"])/g,
    (_match, left, specifier, right) => left + (specifier.startsWith('.')
      ? new URL(specifier, base).href : import.meta.resolve(specifier)) + right);
  const imported = await import(`data:text/javascript;base64,${Buffer.from(importedReferenceSource).toString('base64')}`);
  VolumetricPass = imported.VolumetricPass;assert.equal(imported.VOLUME_LAYER, VOLUME_LAYER);
  await writeFile(`${out}/reference-volumetric-pass-webgl.js`, referenceSource);
  await writeFile(`${out}/reference-import-rewritten.js`, importedReferenceSource);
}

const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(80, 1, .1, 1e9);
camera.updateMatrixWorld(true);
const volume = new VolumetricPass(scene, camera), atmosphere = new AtmospherePass(camera);
volume.setSize(32, 32);volume.sceneDepthSource = atmosphere;
const readBuffer = { texture: { name: 'CPU input color' }, depthTexture: { name: 'CPU input depth' } };
const writeBuffer = { name: 'CPU output' }, planets = [], frames = [];
const rendererState = { target: null, face: 0, mip: 0, color: new THREE.Color(.1, .2, .3), alpha: 1 };
let frame = null;
const vector = value => value?.toArray() || null;
const uniformIds = new WeakMap();let nextUniformId = 1;
function uniformId(uniform) {
  if (!uniformIds.has(uniform)) uniformIds.set(uniform, nextUniformId++);
  return uniformIds.get(uniform);
}
function observation(planet, material) {
  const u = material.uniforms, a = atmosphere.material.uniforms;
  const sample = new THREE.Vector3(0, planet.R + 10000, 0);
  const activeSample = atmosphere.activePlanet?.worldPositionToLocal(planet.localPositionToWorld(sample));
  return {
    planet: planet.name, activeCloud: planet === volume.activePlanet,
    activeAtmosphere: atmosphere.activePlanet?.name || null,
    material: material === planet.volCloudFarMat ? 'far' : 'near',
    unionDefine: material.defines.STELLAR_UNION_OCCLUSION,
    visible: planet.volCloudMesh.visible, engage: u.uEngage.value,
    volumeLayer: planet.volCloudMesh.layers.isEnabled(VOLUME_LAYER),
    cameraLayerMaskAtSubmission: camera.layers.mask,
    frustumCulled: planet.volCloudMesh.frustumCulled,
    centerNdc: planet.group.getWorldPosition(new THREE.Vector3()).project(camera).toArray(),
    plainCount: u.uLocalOccluderCount.value, airCount: u.air_uLocalOccluderCount.value,
    plainBlockers: u.uLocalOccluders.value.slice(0, u.uLocalOccluderCount.value).map(vector),
    airBlockers: u.air_uLocalOccluders.value.slice(0, u.air_uLocalOccluderCount.value).map(vector),
    airEnabled: u.air_uEnabled.value,
    airEnabledUniformId: uniformId(u.air_uEnabled),
    airEnabledAliasesSharedAtmosphere: u.air_uEnabled === a.uEnabled,
    airCountAliasesSharedAtmosphere: u.air_uLocalOccluderCount === a.uLocalOccluderCount,
    airCameraAliasesSharedAtmosphere: u.air_uCameraLocal === a.uCameraLocal,
    airOpticalDepthAliasesSharedAtmosphere: u.air_tOpticalDepth === a.tOpticalDepth,
    plainCameraLocal: vector(u.uCameraLocal.value), airCameraLocal: vector(u.air_uCameraLocal.value),
    ownLocalSample: vector(sample), sampleInActiveAtmosphereFrame: vector(activeSample),
    sampleFrameDifferenceMeters: activeSample ? sample.distanceTo(activeSample) : null,
    planetAtmospherePointerIsCurrent: planet.atmosphereTransportUniforms === a,
  };
}
// No pass method or material is replaced. This is only the terminal renderer
// interface, following Three's visibility/layer eligibility. Real cloud meshes
// have frustumCulled=false; their center projections additionally lie on-screen.
const renderer = {
  autoClear: true,
  getRenderTarget: () => rendererState.target,
  getActiveCubeFace: () => rendererState.face,
  getActiveMipmapLevel: () => rendererState.mip,
  setRenderTarget(target, face = 0, mip = 0) { Object.assign(rendererState, { target, face, mip }); },
  getClearColor: out => out.copy(rendererState.color),
  getClearAlpha: () => rendererState.alpha,
  setClearColor(color, alpha = rendererState.alpha) { rendererState.color.set(color);rendererState.alpha = alpha; },
  clear() {},
  render(object, drawCamera) {
    if (rendererState.target !== volume.current) return;
    assert.equal(object, scene);assert.equal(drawCamera, camera);
    scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
    scene.traverseVisible(mesh => {
      if (!mesh.isMesh || !mesh.layers.test(drawCamera.layers)) return;
      const planet = planets.find(value => value.volCloudMesh === mesh);
      if (!planet) return;
      assert.equal(mesh.frustumCulled, false);
      for (const material of [mesh.material].flat()) if (material.visible) frame.draws.push(observation(planet, material));
    });
  },
};

function makePlanet(name, x, angle, blockers, clouds = true) {
  setVolumetricCloudsEnabled(clouds);
  const planet = new Planet({ seed: `air-binding-${name}`, name,
    posUniv: new THREE.Vector3(x, 0, -2e7), type: 'lush', radius: 6e6,
    ringSystem: { present: false },
    tuning: { cloudCoverage: .64, weatherStyle: 'temperate-synoptic' } });
  planets.push(planet);scene.add(planet.group);
  planet.setFrame(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
  planet.setStellarLights({ sources: [
    { direction: [0, 1, 0], color: [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: 1 },
  ], radianceScale: 3.2 });
  planet.setStellarOccluders(Array.from({ length: blockers }, (_, i) => ({
    centerLocal: new THREE.Vector3(x * .1 + i * 5e5, 2e7 + i * 1e5, 3e5), radius: 2e5,
  })));
  assert.ok(planet.atmoMesh);assert.equal(!!planet.volCloudMesh, clouds);
  // The constructor has not requested any GPU weather forecast. Keeping the
  // real updateCloudColumns path without one avoids GPU producers in this test.
  assert.equal(planet.weatherStream, undefined);
  return planet;
}
function draw(name, active, nav, dt = 1 / 60, atmosphereOwner = active) {
  frame = { name, focused: active?.name || null, nav: nav.toArray(), draws: [] };
  for (const planet of planets) {
    planet.group.position.copy(planet.posUniv).sub(nav);
    // Match main.js: all planets update; only the nearest is focused. This
    // executes the actual exponential volume fade, not a manually set flag.
    planet.update(nav.clone().sub(planet.posUniv), dt, planet === active, 0);
  }
  atmosphere.setActivePlanet(atmosphereOwner, nav);
  volume.setActivePlanet(active, nav);
  frame.active = volume.activePlanet?.name || null;
  frame.atmosphereOwner = atmosphere.activePlanet?.name || null;
  const cloudRequests = volume.requiredProgramRequests(nav);
  frame.programRequests = cloudRequests.map(request => ({
    planet: planets.find(planet => planet.volCloudMesh === request.mesh)?.name,
    family: request.material.defines.CLOUD_FAR_VIEW ? 'far' : 'near',
    cacheVariants: request.cacheVariants,
  }));
  volume.render(renderer, writeBuffer, readBuffer);
  assert.equal(camera.layers.mask, 1, 'Production pass must restore camera layers');
  assert.equal(volume.frameState.pending, false);
  frames.push(frame);return frame;
}

let result, error;
try {
  setVolumetricCloudsEnabled(true);
  const a = makePlanet('A', -7e6, 0, 1), b = makePlanet('B', 7e6, .6, 3);
  // A real atmosphere-bearing body without a volume is reachable in the normal
  // setter: AtmospherePass accepts it while VolumetricPass selects active=null.
  const c = makePlanet('C cloud-free', 0, -.2, 2, false);c.posUniv.y = 18e6;
  const aUniforms = a.volCloudMat.uniforms, sharedAtmosphere = atmosphere.material.uniforms;
  const originalAtmosphereObjects = { ...sharedAtmosphere };
  const cloudUniforms = new Map([[a, a.volCloudMat.uniforms], [b, b.volCloudMat.uniforms]]);
  const disabledObjects = new Map();
  function verify(frame) {
    assert.equal(atmosphere.material.uniforms, sharedAtmosphere);
    for (const [name, uniform] of Object.entries(originalAtmosphereObjects)) assert.equal(sharedAtmosphere[name], uniform);
    assert.equal(sharedAtmosphere.uEnabled.value, atmosphere.activePlanet ? 1 : 0,
      'Cloud binding must never disable the shared atmosphere owner');
    for (const [planet, uniforms] of cloudUniforms) {
      assert.equal(planet.volCloudMat.uniforms, uniforms);
      assert.equal(planet.volCloudFarMat.uniforms, uniforms);
    }
    for (const observation of frame.draws) {
      const planet = planets.find(planet => planet.name === observation.planet);
      const uniforms = planet.volCloudMat.uniforms;
      const matched = planet === volume.activePlanet && planet === atmosphere.activePlanet;
      if (matched) {
        assert.equal(observation.airEnabled, 1);
        assert.ok(observation.airEnabledAliasesSharedAtmosphere && observation.airCountAliasesSharedAtmosphere);
        assert.deepEqual(observation.plainCameraLocal, observation.airCameraLocal);
        assert.equal(observation.plainCount, observation.airCount);
      } else if (!reference) {
        assert.equal(observation.airEnabled, 0, `Foreign air enabled for ${planet.name} in ${frame.name}`);
        assert.equal(observation.airEnabledAliasesSharedAtmosphere, false);
        if (disabledObjects.has(planet)) assert.equal(uniforms.air_uEnabled, disabledObjects.get(planet),
          'Returning to disabled state must reuse its stable owned uniform object');
        else disabledObjects.set(planet, uniforms.air_uEnabled);
      }
    }
    return frame;
  }
  const first = verify(draw('A focused: initial physical bind', a, new THREE.Vector3(-1e6, 0, 0)));
  assert.deepEqual(first.draws.map(value => value.planet), ['A']);
  assert.equal(first.draws[0].plainCount, 1);assert.equal(first.draws[0].airCount, 1);
  assert.equal(first.draws[0].airEnabled, 1);
  assert.deepEqual(first.draws[0].plainCameraLocal, first.draws[0].airCameraLocal);
  const boundEnabled = aUniforms.air_uEnabled, boundCount = aUniforms.air_uLocalOccluderCount;
  const second = verify(draw('B focused: A still fading', b, new THREE.Vector3(1e6, 0, 0)));
  assert.equal(a.atmosphereTransportUniforms, null);
  assert.equal(aUniforms.air_uLocalOccluderCount, boundCount, 'The narrow policy does not detach old sampler/optical records');
  assert.deepEqual(second.draws.map(value => value.planet), ['A', 'B']);
  const old = second.draws.find(value => value.planet === 'A'), current = second.draws.find(value => value.planet === 'B');
  assert.ok(old.engage > .01 && old.engage < 1);assert.ok(current.engage > .01 && current.engage < 1);
  assert.equal(old.plainCount, 1);assert.equal(old.airCount, 3);assert.equal(old.airEnabled, reference ? 1 : 0);
  assert.deepEqual(old.airBlockers, current.plainBlockers);
  assert.notDeepEqual(old.plainCameraLocal, old.airCameraLocal);
  assert.ok(old.sampleFrameDifferenceMeters > 1e6);
  assert.equal(old.airEnabledAliasesSharedAtmosphere, reference);assert.ok(old.airCountAliasesSharedAtmosphere);
  if (reference) assert.equal(aUniforms.air_uEnabled, boundEnabled);
  else assert.notEqual(aUniforms.air_uEnabled, boundEnabled);
  assert.equal(current.plainCount, 3);assert.equal(current.airCount, 3);
  assert.deepEqual(current.plainCameraLocal, current.airCameraLocal);
  assert.ok(second.programRequests.some(value => value.planet === 'A'));
  assert.ok(second.programRequests.some(value => value.planet === 'B'));
  for (const draw of second.draws) {
    assert.equal(draw.cameraLayerMaskAtSubmission, 1 << VOLUME_LAYER);
    assert.ok(Math.abs(draw.centerNdc[0]) < 1 && Math.abs(draw.centerNdc[1]) < 1);
    assert.ok(draw.centerNdc[2] >= -1 && draw.centerNdc[2] <= 1);
  }
  const third = verify(draw('B remains focused: disabled identity stays stable', b, new THREE.Vector3(1e6, 0, 0)));
  assert.equal(third.draws.find(value => value.planet === 'A').airCount, 3);
  verify(draw('Return to A: B fades', a, new THREE.Vector3(-1e6, 0, 0)));
  verify(draw('Return to B: reuse A disabled object', b, new THREE.Vector3(1e6, 0, 0)));
  const cloudFree = verify(draw('Cloud-free C atmosphere: active volume null, A/B fading', c, new THREE.Vector3(0, 12e6, 0)));
  assert.equal(volume.activePlanet, null);assert.equal(atmosphere.activePlanet, c);
  assert.deepEqual(cloudFree.draws.map(value => value.planet), ['A', 'B']);
  assert.ok(cloudFree.draws.every(value => value.engage > .01 && value.airEnabled === (reference ? 1 : 0)));
  for (const observation of cloudFree.draws) assert.ok(Math.abs(observation.centerNdc[0]) < 1
    && Math.abs(observation.centerNdc[1]) < 1 && observation.centerNdc[2] >= -1 && observation.centerNdc[2] <= 1);
  verify(draw('B active without atmosphere', b, new THREE.Vector3(1e6, 0, 0), 1 / 60, null));
  verify(draw('Restore matched B atmosphere', b, new THREE.Vector3(1e6, 0, 0)));
  const mismatchFrame = verify(draw('Control: active B volume, active A atmosphere', b,
    new THREE.Vector3(1e6, 0, 0), 1 / 60, a));
  const mismatch = mismatchFrame.draws.find(value => value.planet === 'B');
  assert.equal(mismatch.airEnabled, 0);assert.equal(mismatch.airEnabledAliasesSharedAtmosphere, false);
  const repeatedMismatch = verify(draw('Repeat mismatch: stable disabled object', b,
    new THREE.Vector3(1e6, 0, 0), 1 / 60, a));
  const repeated = repeatedMismatch.draws.find(value => value.planet === 'B');
  assert.equal(repeated.airEnabledUniformId === mismatch.airEnabledUniformId, !reference,
    'Old source allocates a new mismatch uniform each frame; current source must reuse one');
  const empty = verify(draw('No active volume or atmosphere: both still fading', null, new THREE.Vector3(1e6, 0, 0)));
  assert.equal(volume.activePlanet, null);assert.equal(atmosphere.activePlanet, null);
  assert.deepEqual(empty.draws.map(value => value.planet), ['A', 'B']);
  assert.ok(empty.draws.every(value => value.airEnabled === 0));
  result = {
    knownLeakReproduced: reference, regressionPassed: !reference,
    issue: 'Previously active visible A cloud retains live air_ references after the shared AtmospherePass switches to B.',
    policy: 'Only the matching active cloud may enable borrowed atmosphere uniforms. Other rendered clouds use a stable owned disabled uniform.',
    coordinateContract: 'Production cloud shader passes its own uCameraLocal/local sample positions directly to air_sphereHits/cloudAirTransport. No A-to-B body-frame conversion occurs at those call sites.',
    scope: 'CPU production control flow and actual material uniform identity; renderer double records eligible submissions, not GPU pixels, shader execution, occlusion visibility or measured player impact.',
    remainingRisks: 'Inactive cloud depth uniforms and old borrowed LUT/sampler references also remain; this reproduction does not establish a full ownership solution.',
    evidenceKind: reference ? 'Mechanically imported 5bc09dd production pass; known-defect diagnostic negative control, not fixed acceptance.'
      : 'Current production pass CPU regression; no GPU image/performance acceptance.',
  };
} catch (caught) {
  error = { message: String(caught), stack: caught?.stack };
} finally {
  volume.dispose();atmosphere.dispose();
  for (const planet of planets) planet.dispose();
  setVolumetricCloudsEnabled(false);
}
const after = await evidenceFingerprint(verifier);
const report = { before, after, threeRevision: THREE.REVISION, reference,
  referenceCommit: reference ? referenceCommit : null,
  referenceSourceSha256: referenceSource ? hash(referenceSource) : null,
  referenceImportedSourceSha256: importedReferenceSource ? hash(importedReferenceSource) : null,
  sourceFiles: [...frozen].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  frames, result, error, passed: !error };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
assert.equal(before.sourceDigest, after.sourceDigest, 'Runtime sources changed during reproduction');
assert.equal(before.verifierDigest, after.verifierDigest, 'Verifier changed during reproduction');
if (error) throw new Error(`${error.message}\n${error.stack}\nEvidence: ${out}`);
console.log(`${reference ? 'REPRODUCED old ownership leak (diagnostic negative)' : 'PASS current cloud air ownership regression'} (CPU only): ${out}`);
