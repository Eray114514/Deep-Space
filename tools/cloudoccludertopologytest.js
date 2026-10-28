// Actual Planet constructor/setter and real Three materials, without a renderer.
// Uniform/variant ownership only: native shader output and player acceptance
// require separate GPU controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { Planet, setVolumetricCloudsEnabled } from '../src/planet.js';
import { MAX_STELLAR_OCCLUDERS, bindStellarOcclusion } from '../src/stellar-occlusion.js';
import { cloudOcclusionCandidateSource } from './cloud-occlusion-candidate.js';

const files = ['src/planet.js', 'src/stellar-occlusion.js', 'src/clouds-webgl.js',
  'tools/cloudoccludertopologytest.js', 'tools/cloud-occlusion-candidate.js'];
const frozen = new Map(await Promise.all(files.map(async file => [file, await readFile(file)])));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const out = `test-results/cloud-occluder-topology/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
for (const [file, bytes] of frozen) await writeFile(`${out}/${file.split('/').at(-1)}`, bytes);
const candidate = process.argv.includes('--candidate'), originalSetter = Planet.prototype.setStellarOccluders;
let candidateSource = null;
if (candidate) {
  const module = cloudOcclusionCandidateSource(frozen.get('src/planet.js').toString('utf8'));
  const start = module.indexOf('  setStellarOccluders('), end = module.indexOf('\n  setEclipseOccluder(', start);
  assert.ok(start > 0 && end > start);candidateSource = module.slice(start, end).trim();
  Planet.prototype.setStellarOccluders = new Function('bindStellarOcclusion', `return ({${candidateSource}}).setStellarOccluders;`)(bindStellarOcclusion);
  await writeFile(`${out}/candidate-setter.js`, candidateSource);
}
const cases = [], planets = [];
function test(name, work) {
  try { work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), stack: error?.stack }); }
}
const blocker = (x, y = 2e7, radius = 8e5) => ({ centerLocal: new THREE.Vector3(x, y, 2.5e5), radius });
const versions = planet => [planet.volCloudMat.version, planet.volCloudFarMat.version];
const union = planet => [planet.volCloudMat.defines.STELLAR_UNION_OCCLUSION,
  planet.volCloudFarMat.defines.STELLAR_UNION_OCCLUSION];
const serialized = value => [value.centerLocal.x, value.centerLocal.y, value.centerLocal.z, value.radius];
function makePlanet(clouds = true) {
  setVolumetricCloudsEnabled(clouds);
  const planet = new Planet({ seed: 'far-occluder-topology', name: 'CPU cloud topology',
    posUniv: new THREE.Vector3(), type: clouds ? 'lush' : 'barren', radius: 6e6,
    tuning: { cloudCoverage: clouds ? .64 : 0, weatherStyle: 'temperate-synoptic' } });
  planets.push(planet);
  planet.setStellarLights({ sources: [
    { direction: [0, 1, 0], color: [1, .98, .94], distance: 1e12, radius: 2e10, irradianceFraction: .7 },
    { direction: [1, 0, 0], color: [.8, .9, 1], distance: 2e12, radius: 3e10, irradianceFraction: .3 },
  ], radianceScale: 3.2 });
  return planet;
}
function assertUploads(planet, expected) {
  const uniforms = planet.volCloudMat.uniforms;
  assert.equal(uniforms.uLocalStarCount.value, 2);
  assert.equal(uniforms.uLocalOccluderCount.value, expected.length);
  expected.forEach((value, i) => assert.deepEqual(uniforms.uLocalOccluders.value[i].toArray(), serialized(value)));
}

try {
  const planet = makePlanet(), near = planet.volCloudMat, far = planet.volCloudFarMat;
  const definitions = [near.defines, far.defines], uniforms = near.uniforms;
  const shaderSources = [near.vertexShader, near.fragmentShader, far.vertexShader, far.fragmentShader];
  const uniformObjects = Object.fromEntries(Object.entries(uniforms).map(([name, value]) => [name, value]));
  const cloudDefines = material => Object.fromEntries(Object.entries(material.defines).filter(([name]) => name !== 'STELLAR_UNION_OCCLUSION'));
  const cloudState = [cloudDefines(near), cloudDefines(far)];
  test('real Planet owns near/far materials with shared uniforms and separate topology definitions', () => {
    assert.ok(near.isShaderMaterial && far.isShaderMaterial);
    assert.equal(near.uniforms, far.uniforms);assert.notEqual(near.defines, far.defines);
    assert.equal(near.defines.CLOUD_FAR_VIEW, 0);assert.equal(far.defines.CLOUD_FAR_VIEW, 1);
    assert.deepEqual(union(planet), [0, 0]);
  });
  test('zero occluders preserves both shader families without requesting recompilation', () => {
    const before = versions(planet);planet.setStellarOccluders([]);
    assert.deepEqual(union(planet), [0, 0]);assert.deepEqual(versions(planet), before);assertUploads(planet, []);
  });
  test('single occluder updates the shared physical input without changing topology', () => {
    const before = versions(planet), input = [blocker(-350000)];planet.setStellarOccluders(input);
    assert.deepEqual(union(planet), [0, 0]);assert.deepEqual(versions(planet), before);assertUploads(planet, input);
  });
  test('two occluders select the union branch for both near and far, once each', () => {
    const before = versions(planet), input = [blocker(-350000), blocker(350000)];planet.setStellarOccluders(input);
    assert.deepEqual(union(planet), [1, 1]);
    assert.deepEqual(versions(planet), before.map(value => value + 1));assertUploads(planet, input);
  });
  test('changing two to three occluders keeps the compiled union topology', () => {
    const before = versions(planet), input = [blocker(-500000), blocker(0), blocker(500000)];planet.setStellarOccluders(input);
    assert.deepEqual(union(planet), [1, 1]);assert.deepEqual(versions(planet), before);assertUploads(planet, input);
  });
  test('same-count replacement uploads new members without recompilation', () => {
    const before = versions(planet), input = [blocker(-700000, 3e7, 9e5), blocker(123000, 4e7, 7e5), blocker(700000, 5e7, 6e5)];
    planet.setStellarOccluders(input);assert.deepEqual(union(planet), [1, 1]);
    assert.deepEqual(versions(planet), before);assertUploads(planet, input);
    assert.ok(planet.stellarOccluders.every((value, i) => value !== input[i] && value.centerLocal !== input[i].centerLocal));
  });
  test('moving existing members changes uniform inputs without requesting a new program', () => {
    const before = versions(planet), input = planet.stellarOccluders.map(value => ({ ...value, centerLocal: value.centerLocal.clone().addScalar(12345) }));
    planet.setStellarOccluders(input);assert.deepEqual(versions(planet), before);assertUploads(planet, input);
  });
  test('the full supported occluder count uploads every member and preserves union topology', () => {
    const before = versions(planet), input = Array.from({ length: MAX_STELLAR_OCCLUDERS }, (_, i) => blocker(i * 50000, 2e7 + i * 1000, 3e5 + i));
    planet.setStellarOccluders(input);assert.deepEqual(union(planet), [1, 1]);
    assert.deepEqual(versions(planet), before);assertUploads(planet, input);
  });
  test('returning to one occluder changes both topology definitions exactly once', () => {
    const before = versions(planet), input = [blocker(0)];planet.setStellarOccluders(input);
    assert.deepEqual(union(planet), [0, 0]);assert.deepEqual(versions(planet), before.map(value => value + 1));assertUploads(planet, input);
  });
  test('returning from one to zero needs no new family and publishes count zero', () => {
    const before = versions(planet);planet.setStellarOccluders([]);
    assert.deepEqual(union(planet), [0, 0]);assert.deepEqual(versions(planet), before);assertUploads(planet, []);
  });
  test('caller mutations cannot rewrite captured occluders or their uploaded values', () => {
    const input = [blocker(170000)], expected = serialized(input[0]);planet.setStellarOccluders(input);
    input[0].centerLocal.set(1, 2, 3);input[0].radius = 4;
    assert.deepEqual(serialized(planet.stellarOccluders[0]), expected);
    assert.deepEqual(uniforms.uLocalOccluders.value[0].toArray(), expected);
  });
  test('an independently stale far definition is repaired without recompiling the current near family', () => {
    planet.setStellarOccluders([blocker(-350000), blocker(350000)]);
    far.defines.STELLAR_UNION_OCCLUSION = 0;const before = versions(planet);
    planet.setStellarOccluders(planet.stellarOccluders);
    assert.deepEqual(union(planet), [1, 1]);assert.deepEqual(versions(planet), [before[0], before[1] + 1]);
  });
  test('cloud definitions, uniforms, shader source, and family identities are retained', () => {
    assert.equal(planet.volCloudMat, near);assert.equal(planet.volCloudFarMat, far);
    assert.equal(near.defines, definitions[0]);assert.equal(far.defines, definitions[1]);
    assert.deepEqual([cloudDefines(near), cloudDefines(far)], cloudState);
    assert.equal(near.uniforms, uniforms);assert.equal(far.uniforms, uniforms);
    for (const [name, value] of Object.entries(uniformObjects)) assert.equal(uniforms[name], value);
    assert.deepEqual([near.vertexShader, near.fragmentShader, far.vertexShader, far.fragmentShader], shaderSources);
  });
  test('a real cloud-free Planet accepts all supported topology transitions', () => {
    const dry = makePlanet(false);assert.equal(dry.volCloudMat, undefined);assert.equal(dry.volCloudFarMat, undefined);
    for (const input of [[], [blocker(0)], [blocker(-350000), blocker(350000)], []]) {
      dry.setStellarOccluders(input);assert.equal(dry.stellarOccluders.length, input.length);
      input.forEach((value, i) => assert.deepEqual(serialized(dry.stellarOccluders[i]), serialized(value)));
    }
  });
} finally {
  for (const planet of planets) planet.dispose();
  setVolumetricCloudsEnabled(false);
  Planet.prototype.setStellarOccluders = originalSetter;
}
for (const [file, bytes] of frozen) assert.deepEqual(await readFile(file), bytes, `Changed during verification: ${file}`);
const report = { candidate, installedInRuntime: false, candidateSetterSha256: candidateSource ? hash(candidateSource) : null,
  scope: candidate ? 'Experimental source-transformed actual Planet setter; full physical far readiness failed, candidate not installed. CPU topology only.'
    : 'Current actual Planet setter negative control: known far topology mismatch remains. No native shader/visual/performance acceptance.',
  sourceFiles: [...frozen].map(([path, bytes]) => ({ path, sha256: hash(bytes) })),
  cases, passed: cases.every(value => value.passed) };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
for (const value of cases) console.log(`${value.passed ? 'PASS' : 'FAIL'}: ${value.name}${value.error ? `: ${value.error}` : ''}`);
console.log(JSON.stringify({ out, passed: report.passed, cases: cases.length }));
assert.ok(report.passed, 'Cloud occluder topology ownership failed');
