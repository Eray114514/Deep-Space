import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as THREE from 'three';
import { installSurfaceAtmosphere, prepareSurfaceAtmosphere } from '../src/surface-atmosphere.js';
import { hasSurfaceCloudMedium } from '../src/cloud/surface-clouds.js';
import { withSurfaceWarmupVariant } from '../src/render-prewarm.js';

// CPU ownership contract, not GPU compile/performance or native HDR acceptance.
// Run the vendored key routines with fixed unrelated render parameters, then
// invoke the production installer in the vendor's key-before-callback order.
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const vendor = fs.readFileSync('vendor/three.module.js', 'utf8');
const consumers = fs.readFileSync('src/shaders-webgl.js', 'utf8');
function extract(name) {
  const start = vendor.indexOf(`\tfunction ${name}(`), end = vendor.indexOf('\n\tfunction ', start + 1);
  assert.ok(start >= 0 && end > start, `Vendored ${name} boundary`);
  return vendor.slice(start, end);
}
const cacheKey = vm.runInNewContext(['getProgramCacheKey', 'getProgramCacheKeyParameters', 'getProgramCacheKeyBooleans']
  .map(extract).join('\n') + '\ngetProgramCacheKey',
{ renderer: { outputColorSpace: THREE.SRGBColorSpace }, _programLayers: new THREE.Layers() });
function consumerKey(name, planet, tidalField = null) {
  const start = consumers.indexOf(`export function ${name}(`);
  assert.ok(start >= 0, name);
  const next = consumers.indexOf('\nexport function ', start + 1);
  const body = consumers.slice(start, next < 0 ? undefined : next);
  const assignment = body.match(/material\.customProgramCacheKey = ([^\r\n]+);/);
  assert.ok(assignment, `${name} has an explicit topology key`);
  assert.ok(body.includes('installSurfaceAtmosphere(material, planet, shader)'), `${name} consumes the installer`);
  return vm.runInNewContext(`(${assignment[1]})`, { planet, hasSurfaceCloudMedium, tidalField });
}
const resources = [], rows = [], failures = [];
function check(name, work) {
  const evidence = { name };
  try { work(evidence);evidence.passed = true;console.log(`PASS: ${name}`); }
  catch (error) { evidence.passed = false;evidence.error = error.message;failures.push(evidence);console.error(`FAIL: ${name}: ${error.message}`); }
  rows.push(evidence);
}
function owner(production) {
  const bands = {}, noise = {}, uniforms = { uSpeciesMap: { value: bands }, uBandsReady: { value: 1 },
    uNoise3: { value: noise }, uWeatherMapHi: { value: noise } };
  return { R: 6e6, cloudSpeciesTex: production ? bands : null, volCloudUniforms: uniforms,
    volCloudMat: { defines: { PRODUCTION_CLOUD_MEDIUM: Number(production) }, uniforms },
    volCloudMesh: {}, sunDirLocal: new THREE.Vector3(0, 1, 0), stellarOccluders: [] };
}
function material(planet, name, defines, tidalField) {
  const value = new THREE.MeshStandardMaterial();value.defines = defines;resources.push(value);
  value.customProgramCacheKey = consumerKey(name, planet, tidalField);
  value.onBeforeCompile = shader => installSurfaceAtmosphere(value, planet, shader);
  prepareSurfaceAtmosphere(value, planet);return value;
}
function parameters(material) {
  return { shaderID: 'physical', isRawShaderMaterial: false, precision: 'highp',
    outputColorSpace: THREE.LinearSRGBColorSpace, defines: material.defines,
    customProgramCacheKey: material.customProgramCacheKey(), uniforms: {},
    vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
}
function emitted(shader) {
  return Object.entries(shader.defines).map(([name, value]) => `#define ${name} ${value}`).join('\n')
    + '\n' + shader.vertexShader + '\n' + shader.fragmentShader;
}
function submit(material) {
  const shader = parameters(material), beforeKey = cacheKey(shader), beforeDefines = { ...material.defines };
  material.onBeforeCompile(shader);
  return { shader, beforeDefines, afterDefines: { ...material.defines }, beforeKey,
    afterKey: cacheKey(parameters(material)), emitted: emitted(shader) };
}

try {
  for (const name of ['applyTerrainDetail', 'applyWaterWaves']) {
    for (const production of [false, true]) {
      check(`${name} medium=${Number(production)} keeps keyed defines immutable and same-value compilation stable`, evidence => {
        const planet = owner(production), original = { STELLAR_UNION_OCCLUSION: 0, SURFACE_CLOUD_SCREEN: 1 };
        const m = material(planet, name, original), first = submit(m), second = submit(m);
        Object.assign(evidence, { beforeDefines: first.beforeDefines, afterDefines: first.afterDefines,
          customProgramCacheKey: m.customProgramCacheKey(), beforeKeySha256: sha256(first.beforeKey),
          afterKeySha256: sha256(first.afterKey), secondKeySha256: sha256(second.beforeKey),
          firstShaderSha256: sha256(first.emitted), secondShaderSha256: sha256(second.emitted),
          sameEmittedShader: first.emitted === second.emitted, keySplit: first.beforeKey !== second.beforeKey,
          materialDefinesIdentityRetained: m.defines === original, shaderDefinesIsolated: first.shader.defines !== original });
        assert.equal(first.shader.defines.SURFACE_CLOUD_MEDIUM, Number(production), 'Shader keeps the actual owner medium');
        assert.equal(first.emitted, second.emitted, 'Repeated actual installer output is identical');
        assert.equal(m.defines, original, 'Material retains its defines dictionary identity');
        assert.deepEqual(first.afterDefines, first.beforeDefines, 'onBeforeCompile must not mutate the already-keyed material defines');
        assert.notEqual(first.shader.defines, original, 'Compile-local medium topology needs an isolated shader dictionary');
        assert.equal(first.beforeKey, first.afterKey, 'Callback does not change the next material selection key');
        assert.equal(first.beforeKey, second.beforeKey, 'Same-value preparation retains the same key');
        assert.equal(first.shader.uniforms.uSurfaceViewToLocal, second.shader.uniforms.uSurfaceViewToLocal,
          'Lazy medium uniforms remain material-owned across program variants');
      });
    }
  }
  check('Temporary SCREEN scope does not leak compile-local MEDIUM or change later selection', evidence => {
    const planet = owner(true), original = { STELLAR_UNION_OCCLUSION: 0 }, m = material(planet, 'applyTerrainDetail', original);
    const geometry = new THREE.BoxGeometry(), group = new THREE.Group();resources.push(geometry);
    group.add(new THREE.Mesh(geometry, m));const attempts = [];
    for (let i = 0; i < 2; i++) withSurfaceWarmupVariant(group, () => attempts.push(submit(m)));
    Object.assign(evidence, { afterScopeDefines: { ...m.defines }, keySplit: attempts[0].beforeKey !== attempts[1].beforeKey,
      attempts: attempts.map(value => ({ beforeDefines: value.beforeDefines, afterDefines: value.afterDefines,
        keySha256: sha256(value.beforeKey), shaderSha256: sha256(value.emitted) })) });
    assert.equal(m.defines, original);
    assert.deepEqual(m.defines, { STELLAR_UNION_OCCLUSION: 0 }, 'Restored SCREEN scope leaves original material topology alone');
    assert.equal(attempts[0].beforeKey, attempts[1].beforeKey);
    assert.equal(attempts[0].emitted, attempts[1].emitted);
  });
  check('Frozen keyed material defines can compile a surface-owned shader', evidence => {
    const planet = owner(true), original = Object.freeze({ STELLAR_UNION_OCCLUSION: 0, SURFACE_CLOUD_SCREEN: 1 });
    const m = material(planet, 'applyTerrainDetail', original), submitted = submit(m);
    evidence.shaderMedium = submitted.shader.defines.SURFACE_CLOUD_MEDIUM;
    assert.equal(evidence.shaderMedium, 1);assert.equal(m.defines, original);
  });
  for (const name of ['applyTerrainDetail', 'applyWaterWaves']) {
    check(`${name} custom topology key changes with actual publication, independently of callback source`, evidence => {
      const planet = owner(false), m = material(planet, name, { STELLAR_UNION_OCCLUSION: 0, SURFACE_CLOUD_SCREEN: 1 });
      const first = submit(m);planet.cloudSpeciesTex = planet.volCloudUniforms.uSpeciesMap.value;
      const second = submit(m);
      Object.assign(evidence, { firstCustomKey: first.shader.customProgramCacheKey, secondCustomKey: second.shader.customProgramCacheKey });
      assert.notEqual(first.shader.customProgramCacheKey, second.shader.customProgramCacheKey);
      assert.notEqual(first.beforeKey, second.beforeKey);
      assert.equal(first.shader.defines.SURFACE_CLOUD_MEDIUM, 0);
      assert.equal(second.shader.defines.SURFACE_CLOUD_MEDIUM, 1);
    });
  }
} finally { for (const resource of resources) resource.dispose(); }
const report = { passed: failures.length === 0, scope: 'CPU define/key and lazy-uniform ownership, not GPU compile/native HDR/performance',
  sourceFiles: Object.fromEntries(['src/surface-atmosphere.js', 'src/shaders-webgl.js', 'src/render-prewarm.js',
    'src/cloud/surface-clouds.js', 'vendor/three.module.js'].map(file => [file, sha256(fs.readFileSync(file))])),
  groups: rows.length, failed: failures.length, rows };
const reportPath = process.argv.find(value => value.startsWith('--report='))?.slice('--report='.length);
if (reportPath) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ passed: report.passed, groups: report.groups, failed: report.failed }));
if (!report.passed) process.exitCode = 1;
