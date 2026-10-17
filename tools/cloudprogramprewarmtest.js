// Ownership/cancellation contracts for the diagnostic prewarm experiment.
// Mock success does not accept driver compilation or a responsive real page.
import assert from 'node:assert/strict';
import { probeCloudProgramPrewarm } from './cloud-program-prewarm-browser.js';

const savedWindow = globalThis.window, savedNMS = globalThis.NMS;
globalThis.window = globalThis;
let cases = 0;
async function run(kind) {
  const listeners = new Set(), groups = [], compileCalls = [], targetCalls = [];
  const liveCamera = { layers: { mask: 7 }, clone() {
    return { layers: { mask: 7, set(layer) { this.mask = 1 << layer; } } };
  } };
  const material = { version: 3,
    addEventListener(type, fn) { assert.equal(type, 'dispose');listeners.add(fn); },
    removeEventListener(type, fn) { assert.equal(type, 'dispose');listeners.delete(fn); } };
  const geometry = {}, scene = {}, target = {}, originalTarget = {};
  let currentTarget = originalTarget, readyCalls = 0, lost = false;
  const program = { id: 42, program: {}, isReady() {
    readyCalls++;
    if (kind === 'dispose' || kind === 'version' || kind === 'context') {
      if (kind === 'dispose') for (const fn of [...listeners]) fn();
      if (kind === 'version') material.version++;
      if (kind === 'context') lost = true;
      return false;
    }
    return kind !== 'deadline' && (kind !== 'pending' || readyCalls > 1);
  } };
  const gl = { getExtension(name) { assert.equal(name, 'KHR_parallel_shader_compile');return kind === 'unsupported' ? null : {}; },
    isContextLost() { return lost; } };
  const renderer = { getContext: () => gl, getRenderTarget: () => currentTarget,
    getActiveCubeFace: () => 4, getActiveMipmapLevel: () => 2,
    setRenderTarget(value, face, mip) { currentTarget = value;targetCalls.push([value, face, mip]); },
    properties: { get(value) { assert.equal(value, material);return { currentProgram: program }; } },
    compile(group, camera, targetScene) {
      compileCalls.push({ group, camera, targetScene });
      assert.equal(currentTarget, target);
      assert.notEqual(camera, liveCamera);assert.equal(camera.layers.mask, 4);
      assert.equal(targetScene, scene);
      assert.equal(group.children[0].material, material);
      assert.equal(group.children[0].geometry, geometry);
      if (kind === 'compile-error') throw new Error('controlled compile failure');
    } };
  const T = { Group: class {
    constructor() { this.children = [];groups.push(this); }
    add(mesh) { this.children.push(mesh); }
    clear() { this.children.length = 0; }
  }, Mesh: class {
    constructor(g, m) { this.geometry = g;this.material = m;this.layers = { set() {} }; }
  } };
  globalThis.NMS = { _THREE: T, _renderer: renderer,
    _planet: () => ({ volCloudMat: material, volCloudMesh: { geometry } }),
    _pipeline: { volumePass: { current: target } }, _internals: { camera: liveCamera, scene } };
  delete globalThis.__foundationCloudPrewarm;
  try {
    if (['ready', 'pending'].includes(kind)) {
      const result = await probeCloudProgramPrewarm();
      assert.equal(result.programId, 42);assert.equal(result.reusedBeforePlacement, true);
      assert.equal(result.geometryShared, true);assert.equal(result.polls, readyCalls);
      assert.equal(__foundationCloudPrewarm.stage, 'ready');
    } else {
      const expected = { dispose: /changed/, version: /changed/, context: /Context lost/,
        deadline: /deadline exceeded/, unsupported: /extension required/, 'compile-error': /controlled compile failure/ };
      await assert.rejects(probeCloudProgramPrewarm(kind === 'deadline' ? { timeoutMs: 1 } : {}), expected[kind]);
    }
    assert.equal(liveCamera.layers.mask, 7);
    assert.equal(currentTarget, originalTarget);
    assert.equal(listeners.size, 0);
    assert.ok(groups.every(group => group.children.length === 0));
    if (kind === 'unsupported') assert.equal(compileCalls.length, 0);
    else {
      assert.deepEqual(targetCalls.at(-1), [originalTarget, 4, 2]);
      assert.equal(__foundationCloudPrewarm.targetRestored, true);
      assert.equal(__foundationCloudPrewarm.observerRestored, true);
      if (['dispose', 'version', 'context'].includes(kind)) assert.equal(readyCalls, 1);
    }
    cases++;
  } finally {
    delete globalThis.__foundationCloudPrewarm;delete globalThis.__foundationPrewarmProgram;
  }
}
try {
  for (const kind of ['ready', 'pending', 'dispose', 'version', 'context', 'deadline', 'compile-error', 'unsupported']) await run(kind);
  await assert.rejects(probeCloudProgramPrewarm({ timeoutMs: NaN }), /Positive preparation deadline/);
  console.log(`PASS cloud prewarm ownership/cancellation: ${cases} mocked cases; no GPU acceptance`);
} finally {
  if (savedWindow === undefined) delete globalThis.window;else globalThis.window = savedWindow;
  if (savedNMS === undefined) delete globalThis.NMS;else globalThis.NMS = savedNMS;
}
