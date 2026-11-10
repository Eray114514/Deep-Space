// Current fading-cloud depth/sampler regression; --reference reproduces the
// ab79588 defects with mechanically imported original production classes.
// Real Planet, AtmospherePass (including LUT construction/disposal), and
// VolumetricPass execute against a CPU renderer recorder. No GPU is created.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import * as currentPlanets from '../src/planet.js';
import { AtmospherePass as CurrentAtmospherePass } from '../src/atmosphere-pass-webgl.js';
import { VolumetricPass as CurrentVolumetricPass, VOLUME_LAYER } from '../src/volumetric-pass-webgl.js';
import { CANDIDATE_WIDTH, CANDIDATE_HEIGHT, CANDIDATE_LAYERS } from '../src/cloud/production-bands.js';
import { nearProductionCloudGLSL, productionCloudGLSL } from '../src/cloud/production-medium-glsl.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier = 'tools/cloudfadingresourcetest.js';
assert.ok(process.argv.slice(2).every(value => value === '--reference'), 'Only --reference is supported');
const reference = process.argv.includes('--reference'), referenceCommit = 'ab79588';
const out = `test-results/cloud-fading-resources/${reference ? 'reference-' : 'current-'}${new Date().toISOString().replace(/[:.]/g, '-')}`;
const before = await evidenceFingerprint(verifier);
const files = [verifier, 'src/planet.js', 'src/volumetric-pass-webgl.js',
  'src/atmosphere-pass-webgl.js', 'src/atmosphere-multiple-scattering.js',
  'src/clouds-webgl.js', 'src/atmosphere-transport-glsl.js', 'vendor/three.module.js'];
const frozen = new Map(await Promise.all(files.map(async path => [path, await readFile(path)])));
const hash = value => createHash('sha256').update(value).digest('hex');
await mkdir(out, { recursive: true });
for (const [path, bytes] of frozen) await writeFile(`${out}/${path.replaceAll('/', '__')}`, bytes);
let { Planet, setVolumetricCloudsEnabled } = currentPlanets;
let VolumetricPass = CurrentVolumetricPass, AtmospherePass = CurrentAtmospherePass;
const references = [];
if (reference) {
  const load = async (path, overrides = {}) => {
    const source = execFileSync('git', ['show', `${referenceCommit}:${path}`], { encoding: 'utf8' });
    const base = new URL(`../${path}`, import.meta.url);
    const rewritten = source.replace(/(\bfrom\s*['"])([^'"]+)(['"])/g,
      (_match, left, specifier, right) => left + (overrides[specifier]
        || (specifier.startsWith('.') ? new URL(specifier, base).href : import.meta.resolve(specifier))) + right);
    const url = `data:text/javascript;base64,${Buffer.from(rewritten).toString('base64')}`;
    references.push({ path, sourceSha256: hash(source), importedSha256: hash(rewritten) });
    await writeFile(`${out}/reference__${path.replaceAll('/', '__')}`, source);
    await writeFile(`${out}/reference-import__${path.replaceAll('/', '__')}`, rewritten);
    return { module: await import(url), url };
  };
  const cloud = await load('src/clouds-webgl.js');
  // clouds.js only reexports these same factory exports. Route the unchanged
  // original Planet import to the frozen factory, not the current working one.
  ({ Planet, setVolumetricCloudsEnabled } = (await load('src/planet.js', { './clouds.js': cloud.url })).module);
  ({ AtmospherePass } = (await load('src/atmosphere-pass-webgl.js')).module);
  const volumeModule = (await load('src/volumetric-pass-webgl.js')).module;
  VolumetricPass = volumeModule.VolumetricPass;assert.equal(volumeModule.VOLUME_LAYER, VOLUME_LAYER);
}

const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(80, 1, .1, 1e9);
const volume = new VolumetricPass(scene, camera), air = new AtmospherePass(camera);
volume.setSize(32, 32);volume.sceneDepthSource = air;
const planets = [], targets = [], frames = [], samplerUploads = [];
const resources = new WeakMap(), ids = new WeakMap();let nextId = 1, frame = null;
const disabledUniforms = new WeakMap();
const identify = object => {
  if (!object) return null;
  if (!ids.has(object)) ids.set(object, nextId++);
  return ids.get(object);
};
function track(resource, name) {
  if (!resource || resources.has(resource)) return;
  const entry = { id: identify(resource), name, disposeEvents: 0 };
  resources.set(resource, entry);
  resource.addEventListener('dispose', () => entry.disposeEvents++);
}
function textureRecord(texture) {
  if (!texture) return null;
  const tracked = resources.get(texture), owner = targets.find(target => target.depthTexture === texture || target.texture === texture);
  return { id: identify(texture), name: texture.name || tracked?.name || '',
    textureDisposeEvents: tracked?.disposeEvents || 0,
    renderTargetOwner: owner ? { ...resources.get(owner) } : null,
    imageWidth: texture.image?.width, imageHeight: texture.image?.height };
}
function target(name, width = 64, height = 64, depth = true) {
  const rt = new THREE.WebGLRenderTarget(width, height, { type: THREE.HalfFloatType,
    depthBuffer: depth, depthTexture: depth ? new THREE.DepthTexture(width, height, THREE.UnsignedIntType) : null });
  rt.texture.name = `${name}.color`;if (rt.depthTexture) rt.depthTexture.name = `${name}.depth`;
  targets.push(rt);track(rt, name);track(rt.texture, `${name}.color`);track(rt.depthTexture, `${name}.depth`);
  return rt;
}
const maxDifference = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
function opaquePosition(cameraLocal, inverseProjection, viewToLocal, uv, forwardZ) {
  const projected = new THREE.Vector4(uv[0] * 2 - 1, uv[1] * 2 - 1, 1, 1).applyMatrix4(inverseProjection);
  const ray = new THREE.Vector3(projected.x, projected.y, projected.z).normalize();
  return cameraLocal.clone().addScaledVector(ray.clone().applyMatrix3(viewToLocal).normalize(), forwardZ / Math.max(-ray.z, .035));
}
function observation(planet, material) {
  const uniforms = material.uniforms;
  const transform = planet.volCloudMesh.matrixWorld.clone().invert().multiply(camera.matrixWorld);
  const expectedEye = new THREE.Vector3().setFromMatrixPosition(transform);
  const expectedRotation = new THREE.Matrix3().setFromMatrix4(transform);
  const pixel = [volume.width * .75 + .5, volume.height * .75 + .5];
  const actualUv = pixel.map((value, i) => Math.min(1, Math.max(0, value / uniforms.uVolumeSize.value.getComponent(i))));
  const expectedUv = [pixel[0] / volume.width, pixel[1] / volume.height];
  const actualPoint = opaquePosition(uniforms.uCameraLocal.value, uniforms.uDepthInvProjection.value,
    uniforms.uDepthViewToLocal.value, [.4, .6], 1.5e7);
  const expectedPoint = opaquePosition(expectedEye, camera.projectionMatrixInverse, expectedRotation, [.4, .6], 1.5e7);
  return { planet: planet.name, active: planet === volume.activePlanet,
    engage: uniforms.uEngage.value, airEnabled: uniforms.air_uEnabled.value,
    family: material === planet.volCloudFarMat ? 'far' : 'near', layerMask: camera.layers.mask,
    depth: textureRecord(uniforms.tSceneDepth.value), expectedDepth: textureRecord(frame.depth),
    depthMatches: uniforms.tSceneDepth.value === frame.depth,
    depthReady: uniforms.uDepthReady.value, expectedDepthReady: frame.depth ? 1 : 0,
    volumeSize: uniforms.uVolumeSize.value.toArray(), expectedVolumeSize: [volume.width, volume.height],
    actualUv, expectedUv, far: uniforms.uCameraFar.value, expectedFar: camera.far,
    inverseProjectionError: maxDifference(uniforms.uDepthInvProjection.value.elements, camera.projectionMatrixInverse.elements),
    viewToLocalError: maxDifference(uniforms.uDepthViewToLocal.value.elements, expectedRotation.elements),
    cameraLocalErrorMeters: uniforms.uCameraLocal.value.distanceTo(expectedEye),
    opaquePositionErrorMeters: actualPoint.distanceTo(expectedPoint),
    opaqueBounds: [uniforms.uOpaqueMinR.value, uniforms.uOpaqueMaxR.value],
    expectedOpaqueBounds: [planet.R - Math.max(1000, (planet.hAmp || 0) * 2),
      planet.R + Math.max(1000, (planet.hAmp || 0) * 2)],
    airOptical: textureRecord(uniforms.air_tOpticalDepth.value),
    airMultiple: textureRecord(uniforms.air_tMultipleScattering.value),
    opticalAliasesSharedObject: uniforms.air_tOpticalDepth === air.material.uniforms.tOpticalDepth,
    multipleAliasesSharedObject: uniforms.air_tMultipleScattering === air.material.uniforms.tMultipleScattering };
}
const state = { target: null, face: 0, mip: 0, scissor: false, color: new THREE.Color(.2, .3, .4), alpha: .6 };
const listeners = new Map();
const renderer = { autoClear: true,
  domElement: { addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: name => listeners.delete(name) },
  getRenderTarget: () => state.target, getActiveCubeFace: () => state.face, getActiveMipmapLevel: () => state.mip,
  setRenderTarget(value, face = 0, mip = 0) { state.target = value;state.face = face;state.mip = mip; },
  getClearColor: out => out.copy(state.color), getClearAlpha: () => state.alpha,
  setClearColor(value, alpha = state.alpha) { state.color.set(value);state.alpha = alpha; },
  getScissorTest: () => state.scissor, setScissorTest: value => { state.scissor = value; }, clear() {},
  render(object, drawCamera) {
    if (state.target !== volume.current) return;
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
function makePlanet(name, x, radius, angle, clouds = true) {
  setVolumetricCloudsEnabled(clouds);
  const planet = new Planet({ seed: `fading-resources-${name}`, name,
    posUniv: new THREE.Vector3(x, 0, -2e7), type: 'lush', radius,
    ringSystem: { present: false }, tuning: { cloudCoverage: clouds ? .64 : 0, weatherStyle: 'temperate-synoptic' } });
  planets.push(planet);scene.add(planet.group);
  planet.setFrame(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle));
  assert.ok(planet.atmoMesh);assert.equal(!!planet.volCloudMesh, clouds);
  assert.equal(planet.weatherStream, undefined);
  return planet;
}
function draw(name, active, nav, input, atmosphericOutput, renderAtmosphere = true) {
  frame = { name, active: active?.name || null, draws: [] };
  for (const planet of planets) {
    planet.group.position.copy(planet.posUniv).sub(nav);
    planet.update(nav.clone().sub(planet.posUniv), 1 / 60, planet === active, 0);
  }
  if (renderAtmosphere) {
    air.setActivePlanet(active, nav);
    // This is the actual LUT factory/render path; renderer.render only records
    // CPU submissions, so no shader or texture upload is performed here.
    air.render(renderer, atmosphericOutput, input);
    track(air.lutTexture, `optical:${active?.name || 'none'}`);
    if (air.activeCache?.multiple) {
      const multiple = air.activeCache.multiple;
      if (!targets.includes(multiple)) targets.push(multiple);
      track(multiple, `multiple:${active?.name || 'none'}`);track(multiple.texture, `multiple:${active?.name || 'none'}.texture`);
    }
  }
  volume.setActivePlanet(active, nav);
  frame.depth = volume.sceneDepthSource?.sceneDepthTexture || atmosphericOutput.depthTexture || null;
  volume.render(renderer, input, atmosphericOutput);
  if (!reference) for (const record of frame.draws) {
    const planet = planets.find(value => value.name === record.planet), uniforms = planet.volCloudMat.uniforms;
    assert.equal(planet.volCloudFarMat.uniforms, uniforms, 'Near/Far share the same stable dictionary');
    assert.ok(record.depthMatches, `Current depth mismatch for ${record.planet}: ${name}`);
    assert.equal(record.depthReady, record.expectedDepthReady);
    assert.deepEqual(record.volumeSize, record.expectedVolumeSize);assert.equal(record.far, record.expectedFar);
    assert.ok(record.inverseProjectionError < 1e-12 && record.viewToLocalError < 1e-12);
    assert.ok(record.cameraLocalErrorMeters < 1e-6 && record.opaquePositionErrorMeters < 1e-6);
    assert.deepEqual(record.opaqueBounds, record.expectedOpaqueBounds);
    const matched = renderAtmosphere && planet === volume.activePlanet && planet === air.activePlanet;
    if (matched) {
      assert.equal(record.airEnabled, 1);
      assert.equal(uniforms.air_tOpticalDepth, air.material.uniforms.tOpticalDepth);
      assert.equal(uniforms.air_tMultipleScattering, air.material.uniforms.tMultipleScattering);
      assert.equal(uniforms.air_uMultipleEnabled, air.material.uniforms.uMultipleEnabled);
    } else {
      assert.equal(record.airEnabled, 0);assert.equal(uniforms.air_uMultipleEnabled.value, 0);
      assert.equal(uniforms.air_tOpticalDepth.value, null);assert.equal(uniforms.air_tMultipleScattering.value, null);
      assert.notEqual(uniforms.air_tOpticalDepth, air.material.uniforms.tOpticalDepth);
      assert.notEqual(uniforms.air_tMultipleScattering, air.material.uniforms.tMultipleScattering);
      const owned = [uniforms.air_uEnabled, uniforms.air_uMultipleEnabled, uniforms.air_tOpticalDepth, uniforms.air_tMultipleScattering];
      if (disabledUniforms.has(uniforms)) owned.forEach((value, i) => assert.equal(value, disabledUniforms.get(uniforms)[i],
        'Disable/re-enable cycles must reuse stable disabled uniforms'));
      else disabledUniforms.set(uniforms, owned);
    }
  }
  delete frame.depth;frames.push(frame);return frame;
}

// Mechanically extract the exact vendored sampler setter and upload loop. The
// synthetic active-uniform list explicitly assumes these declared samplers are
// active in the linked program; it does not claim to perform GPU reflection.
const vendor = frozen.get('vendor/three.module.js').toString('utf8');
const setterStart = vendor.indexOf('function setValueT1( gl, v, textures ) {');
const setterEnd = vendor.indexOf('\nfunction setValueT3D1(', setterStart);
const uploadStart = vendor.indexOf('\tstatic upload( gl, seq, values, textures ) {');
const uploadEnd = vendor.indexOf('\n\tstatic seqWithValue(', uploadStart);
assert.ok(setterStart > 0 && setterEnd > setterStart && uploadStart > 0 && uploadEnd > uploadStart);
const samplerSetterSource = vendor.slice(setterStart, setterEnd);
const uploadSource = vendor.slice(uploadStart, uploadEnd);
const samplerSetter = new Function('emptyTexture', 'emptyShadowTexture', 'GreaterEqualCompare', 'LessEqualCompare',
  `${samplerSetterSource};return setValueT1;`)(new THREE.Texture(), new THREE.DepthTexture(), THREE.GreaterEqualCompare, THREE.LessEqualCompare);
const vendorUpload = new Function(`return class ExtractedUpload {${uploadSource}};`)().upload;
function sampleUpload(label, uniforms) {
  const names = ['air_tOpticalDepth', 'air_tMultipleScattering'];let unit = 0;
  const uploaded = [];
  const gl = { SAMPLER_2D_SHADOW: 35682, uniform1i() {} };
  const textures = { allocateTextureUnit: () => unit++, setTexture2D: texture => uploaded.push(textureRecord(texture)) };
  const seq = names.map(id => ({ id, type: 35678, addr: {}, cache: [], setValue: samplerSetter }));
  vendorUpload(gl, seq, uniforms, textures);
  samplerUploads.push({ label, airEnabled: uniforms.air_uEnabled.value, names, uploaded });
  return uploaded;
}

let result, error, airDisposed = false;
try {
  const a = makePlanet('A', -7e6, 6e6, 0), b = makePlanet('B', 7e6, 5e6, .6);
  if (!reference) {
    const near = a.volCloudMat, direct = a.getDirectCloudMaterial();
    assert.equal(a.getDirectCloudMaterial(), direct);
    assert.equal(direct.uniforms, near.uniforms);
    assert.equal(direct.fragmentShader, a.volCloudFarMat.fragmentShader);
    assert.ok(direct.fragmentShader.includes(productionCloudGLSL));
    assert.ok(near.fragmentShader.includes(nearProductionCloudGLSL));
    const uniforms = near.uniforms, rawBinding = uniforms.uBandCandidates, ready = uniforms.uCandidatesReady;
    const savedRaw = rawBinding.value, savedReady = ready.value;
    const plane = CANDIDATE_WIDTH * CANDIDATE_HEIGHT;
    const data = new Uint16Array(plane * CANDIDATE_LAYERS);
    const raw = new THREE.DataArrayTexture(data, CANDIDATE_WIDTH, CANDIDATE_HEIGHT, CANDIDATE_LAYERS);
    try {
      rawBinding.value = raw;
      ready.value = 1;
      data[plane] = 4;
      const used = new Set();
      volume.bindNearCandidates(uniforms, used);
      const derived = uniforms.uNearBandCandidates.value, version = derived.version;
      assert.equal(derived.image.data[0], 0x8100);
      assert.equal(data[0], 0);
      volume.bindNearCandidates(uniforms, used);
      assert.equal(derived.version, version);
      data[plane] = 0;
      raw.needsUpdate = true;
      volume.bindNearCandidates(uniforms, used);
      assert.equal(uniforms.uNearBandCandidates.value, derived);
      assert.equal(derived.version, version + 1);
      assert.equal(derived.image.data[0], 0x8000);
      track(derived, 'near candidate grid');
      volume.releaseNearCandidates(used);
      assert.equal(resources.get(derived).disposeEvents, 0);
      volume.releaseNearCandidates(new Set());
      assert.equal(resources.get(derived).disposeEvents, 1);
      assert.equal(uniforms.uNearBandCandidates.value, null);
    } finally {
      rawBinding.value = savedRaw;
      ready.value = savedReady;
      raw.dispose();
    }
  }
  if (!reference) for (const planet of [a, b]) {
    assert.equal(planet.volCloudMat.uniforms.uOpaqueMinR.value, planet.R - Math.max(1000, planet.hAmp * 2));
    assert.equal(planet.volCloudMat.uniforms.uOpaqueMaxR.value, planet.R + Math.max(1000, planet.hAmp * 2));
  }
  const firstInput = target('first opaque'), firstOutput = target('first atmosphere');
  const navA = new THREE.Vector3(-1e6, 0, 0), navB = new THREE.Vector3(3e6, 0, 0);
  const first = draw('A active: initialize current depth and borrowed samplers', a, navA, firstInput, firstOutput);
  assert.deepEqual(first.draws.map(value => value.planet), ['A']);
  assert.ok(first.draws[0].depthMatches && first.draws[0].cameraLocalErrorMeters < 1e-7);
  const aOptical = air.lutTexture, aMultiple = air.activeCache.multiple;
  camera.position.set(17, -3, 5);camera.rotation.set(.07, .11, -.03);
  const moved = draw('B active: camera motion only, unchanged render targets', b, navB, firstInput, firstOutput);
  const movedA = moved.draws.find(value => value.planet === 'A');
  assert.ok(movedA.depthMatches, 'Motion-only control must keep the same real depth texture');
  if (reference) assert.ok(movedA.viewToLocalError > 1e-3 && movedA.cameraLocalErrorMeters > 10);
  camera.fov = 68;camera.aspect = 1.5;camera.far = 2e9;camera.updateProjectionMatrix();
  volume.setSize(96, 64);
  // Real RT disposal/replacement, as a composer reset or owner rebuild does.
  // Without WebGLRenderer, dispose events prove owner retirement, not native
  // deletion; GPU reupload/fallback behavior remains outside this CPU proof.
  firstInput.dispose();firstOutput.dispose();
  const nextInput = target('replacement opaque', 96, 64), nextOutput = target('replacement atmosphere', 96, 64);
  const changed = draw('B active: camera/viewport/RT changed while A fades', b, navB, nextInput, nextOutput);
  const old = changed.draws.find(value => value.planet === 'A'), current = changed.draws.find(value => value.planet === 'B');
  assert.deepEqual(changed.draws.map(value => value.planet), ['A', 'B']);
  assert.ok(old.engage > .01 && old.engage < 1);assert.equal(old.airEnabled, 0);
  if (reference) {
    assert.equal(old.depthMatches, false);assert.equal(old.depthReady, 1);
    assert.ok(old.depth.renderTargetOwner.disposeEvents > 0);
    assert.notDeepEqual(old.volumeSize, old.expectedVolumeSize);assert.notEqual(old.far, old.expectedFar);
    assert.ok(old.inverseProjectionError > 1e-3 && old.viewToLocalError > 1e-3);
    assert.ok(old.cameraLocalErrorMeters > 10 && old.opaquePositionErrorMeters > 100000);
  }
  assert.ok(current.depthMatches && current.depthReady === 1 && current.cameraLocalErrorMeters < 1e-6);
  assert.ok(current.inverseProjectionError < 1e-12 && current.viewToLocalError < 1e-12);
  assert.equal(old.opticalAliasesSharedObject, reference);assert.equal(old.multipleAliasesSharedObject, reference);
  assert.equal(a.volCloudMat.uniforms.air_tOpticalDepth.value, reference ? air.lutTexture : null);
  assert.notEqual(air.lutTexture, aOptical, 'Different physical profiles must select different real LUTs');
  const liveUpload = sampleUpload('Inactive A samplers with air disabled', a.volCloudMat.uniforms);
  if (reference) {
    assert.equal(liveUpload[0].id, identify(air.lutTexture));assert.equal(liveUpload[1].id, identify(air.activeCache.multiple.texture));
  } else assert.ok(liveUpload.every(value => !value.renderTargetOwner && value.id !== identify(air.lutTexture)));

  const colorInput = target('depthless opaque', 96, 64, false), colorOutput = target('depthless atmosphere', 96, 64, false);
  const depthless = draw('B active: no current scene depth, A stale ready remains1', b, navB, colorInput, colorOutput);
  assert.equal(depthless.draws.find(value => value.planet === 'A').depthReady, reference ? 1 : 0);
  assert.equal(depthless.draws.find(value => value.planet === 'B').depthReady, 0);
  assert.equal(depthless.draws.find(value => value.planet === 'A').expectedDepth, null);
  draw('Return to A: restore matching samplers and current depth', a, navA, nextInput, nextOutput);
  draw('Return to B: stable owned null samplers for A', b, navB, nextInput, nextOutput);

  // Normal LRU turnover is a counter-control: stale clouds follow the current
  // shared sampler object, so they do not pin their former A LUT forever.
  for (let i = 0; i < 3; i++) {
    const p = makePlanet(`cloud-free-${i}`, 0, 4e6 - i * 4e5, .1, false);
    draw(`Physical LUT LRU turnover ${i + 1}`, p, navB, nextInput, nextOutput);
  }
  assert.equal(air.profileCache.size, 4);
  assert.ok(resources.get(aOptical).disposeEvents > 0 && resources.get(aMultiple).disposeEvents > 0);
  assert.notEqual(a.volCloudMat.uniforms.air_tOpticalDepth.value, aOptical);
  assert.notEqual(a.volCloudMat.uniforms.air_tMultipleScattering.value, aMultiple.texture);
  const lastMultiple = air.activeCache.multiple;
  air.dispose();airDisposed = true;volume.sceneDepthSource = null;
  if (!reference) {
    assert.equal(air.material.uniforms.tMultipleScattering.value, null);
    assert.equal(air.material.uniforms.uMultipleEnabled.value, 0);
    assert.equal(air.sceneDepthTexture, null);
  }
  const retired = draw('Explicit atmosphere owner disposal; surviving cloud consumer remains', null, navB,
    colorInput, colorOutput, false);
  assert.ok(resources.get(lastMultiple).disposeEvents > 0);
  assert.ok(retired.draws.every(value => value.airEnabled === 0));
  assert.equal(a.volCloudMat.uniforms.air_tOpticalDepth.value, null);
  assert.equal(a.volCloudMat.uniforms.air_tMultipleScattering.value, reference ? lastMultiple.texture : null);
  const retiredUpload = sampleUpload('Conditional surviving-consumer draw after owner disposal', a.volCloudMat.uniforms);
  if (reference) {
    assert.equal(retiredUpload[1].id, identify(lastMultiple.texture));
    assert.ok(retiredUpload[1].renderTargetOwner.disposeEvents > 0);
  } else assert.ok(retiredUpload.every(value => !value.renderTargetOwner));
  result = { knownDepthDefectReproduced: reference, currentRegressionPassed: !reference, samplerOwnershipObserved: true,
    confirmed: reference ? [
      'Actual visible fading A retains old depth/ready/viewport/far/projection/view-to-local after camera and target changes.',
      'Planet.update supplies nav-only local eye to inactive A; the active-only render override includes camera offset only for B.',
      'Depthless current frame resets only active B; fading A remains ready with its old depth target.',
      'Normal A-to-B and LRU turnover update shared sampler values; inactive A follows current LUT and does not permanently pin its former LUT.',
      'The vendored active-uniform upload loop binds sampler objects independently of air_uEnabled.',
      'AtmospherePass.dispose clears optical but leaves multiple-scattering sampler referencing a retired render target.',
    ] : [
      'Every visible fading and active cloud receives current depth/ready/viewport/far/projection/local camera state.',
      'Camera-only movement with unchanged targets, later FOV/viewport/target replacement, and absent depth all preserve the current-frame contract.',
      'Opaque radius bounds match the real Planet before any active draw.',
      'Matched active clouds borrow current samplers; disabled clouds use stable owned null samplers and multipleEnabled0.',
      'Returning to an active body restores sharing, and repeated disabling reuses the same disabled uniform objects.',
      'Atmosphere owner disposal clears multiple-scattering and scene-depth references; surviving disabled consumers submit fallback samplers.',
    ],
    limitations: [
      'CPU renderer does not execute GL/shaders, initialize native textures, or prove image error/feedback/invalid-native-use.',
      'Retired-target records are actual dispose events; CPU Three does not itself invoke WebGLTextures native cleanup.',
      'The extracted sampler upload uses an explicit active-uniform list, not live native reflection.',
      'Default pipeline teardown also disposes volume; a later draw with a surviving consumer after atmosphere disposal is conditional lifecycle evidence, not demonstrated normal gameplay.',
      'Ordinary composer ping-pong may update both depth attachments in a frame; texture identity mismatch alone does not prove stale depth pixels.',
    ],
    kind: reference ? 'Diagnostic negative: passing means frozen ab79588 depth defects and sampler behavior were reproduced; not fixed acceptance.'
      : 'Current CPU production control-flow regression; not GPU pixels, native sampler reflection or performance acceptance.',
  };
} catch (caught) { error = { message: String(caught), stack: caught?.stack }; }
finally {
  volume.dispose();if (!airDisposed) air.dispose();
  for (const planet of planets) planet.dispose();
  for (const rt of targets) rt.dispose();
  setVolumetricCloudsEnabled(false);
}
const after = await evidenceFingerprint(verifier);
await writeFile(`${out}/report.json`, JSON.stringify({ before, after, threeRevision: THREE.REVISION,
  reference, referenceCommit: reference ? referenceCommit : null, references,
  sourceFiles: [...frozen].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  vendorExtracts: { samplerSetterSha256: hash(samplerSetterSource), uploadSha256: hash(uploadSource) },
  frames, samplerUploads, result, error, passed: !error }, null, 2));
assert.equal(before.sourceDigest, after.sourceDigest, 'Runtime changed during diagnostic');
assert.equal(before.verifierDigest, after.verifierDigest, 'Verifier changed during diagnostic');
if (error) throw new Error(`${error.message}\n${error.stack}\nEvidence: ${out}`);
console.log(`${reference ? 'REPRODUCED frozen defects (diagnostic negative)' : 'PASS current fading-cloud depth/sampler regression'} (CPU only): ${out}`);
