// Actual cloud preparation manager + program adapter + shared preparation
// queue with CPU renderer/native-readiness doubles. No GPU/cold timing claim.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { CloudProgramPreparation } from '../src/cloud-program-preparation.js';
import { GpuPreparationQueue } from '../src/gpu-preparation-queue.js';

const files = ['src/cloud-program-preparation.js', 'src/program-preparation.js', 'src/render-prewarm.js',
  'src/render-layers.js', 'src/gpu-preparation-queue.js', 'tools/cloudprogrampreparationtest.js'];
const frozen = new Map(await Promise.all(files.map(async file => [file, await readFile(file)])));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const out = `test-results/cloud-program-preparation/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });for (const [file, bytes] of frozen) await writeFile(`${out}/${file.split('/').at(-1)}`, bytes);
const original = { setTimeout, clearTimeout }, timers = new Map();let nextTimer = 0;
globalThis.setTimeout = work => { const id = ++nextTimer;timers.set(id, work);return id; };
globalThis.clearTimeout = id => timers.delete(id);
const microtasks = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const tick = async () => { const batch = [...timers];for (const [id, work] of batch) if (timers.delete(id)) work();await microtasks(); };
const cases = [], fixtures = [];
async function test(name, work) {
  const first = fixtures.length;
  try { await work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), stack: error?.stack }); }
  finally { for (const fixture of fixtures.slice(first)) fixture.dispose();await microtasks(); }
}

function fixture({ variants = [0, 1], instance = false, maxIdleEntries = 32 } = {}) {
  const canvas = new EventTarget(), source = new AbortController(), records = [], programs = [], scheduled = new Map();
  let lost = false, ready = false, nativeQueries = 0, programQueries = 0, nextSchedule = 0, compileError = null, bindError = null, restoreError = null;
  let target, face = 3, mip = 1;
  const caller = new THREE.WebGLCubeRenderTarget(8), hdr = new THREE.WebGLRenderTarget(32, 32, { type: THREE.HalfFloatType });target = caller;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();camera.layers.set(7);camera.position.set(9, 8, 7);camera.updateMatrixWorld();
  const rig = new THREE.Group();rig.clone = () => assert.fail('Attached camera rig cloned');camera.add(rig);
  const material = new THREE.ShaderMaterial({ vertexShader: 'void main(){gl_Position=vec4(position,1.0);}', fragmentShader: 'void main(){gl_FragColor=vec4(1.0);}',
    defines: { CLOUD_FAR_VIEW: 1, CLOUD_FAR_CACHE: 0 }, uniforms: { uFrame: { value: 0 }, uTexture: { value: new THREE.Texture() } } });
  const geometry = new THREE.BoxGeometry(), mesh = instance ? new THREE.InstancedMesh(geometry, material, 2) : new THREE.Mesh(geometry, material);
  mesh.layers.set(2);mesh.name = 'actual-volume';mesh.clone = () => assert.fail('Live mesh or instance data cloned');scene.add(mesh);
  const lightFrame = new THREE.Group(), light = new THREE.PointLight();lightFrame.position.set(100, 200, 300);light.position.set(1, 2, 3);light.layers.set(2);lightFrame.add(light);scene.add(lightFrame);
  const hiddenLight = new THREE.PointLight();hiddenLight.visible = false;hiddenLight.layers.set(2);scene.add(hiddenLight);
  scene.updateMatrixWorld(true);light.updateWorldMatrix = () => assert.fail('Live light world matrix updated');light.updateMatrixWorld = () => assert.fail('Live light matrix updated');
  const properties = new Map();
  const family = (material, mesh) => JSON.stringify([material.vertexShader, material.fragmentShader, material.defines, Object.keys(mesh.geometry.attributes), !!mesh.instanceColor]);
  const renderer = { domElement: canvas, properties, capabilities: { logarithmicDepthBuffer: true, precision: 'highp' }, shadowMap: { enabled: true, type: THREE.PCFShadowMap },
    outputColorSpace: THREE.SRGBColorSpace, toneMapping: THREE.NoToneMapping,
    getContext() { nativeQueries++;return { isContextLost: () => lost }; },
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) { target = value;face = nextFace;mip = nextMip;if (value === hdr && bindError) throw bindError;if (value === caller && restoreError) throw restoreError; },
    compile(source, compileCamera, lighting) {
      const selected = [], lights = [];source.traverse(object => { if (object.isMesh) selected.push(object); });lighting.traverseVisible(object => { if (object.isLight) lights.push(object); });
      const selectedMaterial = selected[0]?.material || material;
      records.push({ source, camera: compileCamera, lighting, selected, lights, lightPositions: lights.map(object => object.position.toArray()),
        variant: selectedMaterial.defines.CLOUD_FAR_CACHE, defines: selectedMaterial.defines, uniformObject: selectedMaterial.uniforms, texture: selectedMaterial.uniforms.uTexture?.value, target, face, mip });
      if (compileError) throw compileError;
      for (const object of selected) {
        let props = renderer.properties.get(object.material);if (!props) { props = { programs: new Map() };renderer.properties.set(object.material, props); }
        const key = family(object.material, object);let program = props.programs.get(key);
        if (!program?.program) { program = { id: programs.length, program: {}, isReady() { programQueries++;return ready; } };programs.push(program);props.programs.set(key, program); }
        props.currentProgram = program;props.version = object.material.version;
      }
      f.onCompile?.();return new Set(selected.map(object => object.material));
    },
    draw() { const props = renderer.properties.get(material);if (props.version !== material.version) { props.currentProgram = props.programs.get(family(material, mesh));props.version = material.version; }return props.currentProgram; },
  };
  const queue = new GpuPreparationQueue(renderer, { submit: () => false, schedule: work => { const id = ++nextSchedule;scheduled.set(id, work);return id; }, cancel: id => scheduled.delete(id) });
  const manager = new CloudProgramPreparation(renderer, { prepare: (work, options) => queue.enqueue(work, options), signal: source.signal, maxIdleEntries });
  const request = { mesh, material, cacheVariants: variants }, config = { scene, camera, target: hdr, requests: [request] };
  const f = { manager, queue, renderer, scene, camera, mesh, material, geometry, hdr, caller, request, config, records, programs, source, light, hiddenLight,
    run({ finish = true } = {}) { const ticket = queue.runNext(() => assert.fail('Compiler must not draw'));if (finish) queue.finish(ticket);return ticket; },
    finish(ticket, options) { queue.finish(ticket, options); },
    async complete() { ready = true;for (let i = 0; i < 12; i++) { while (queue.hasQueued && !queue.active) f.run();await tick();if (!queue.snapshot().pending) break; }await microtasks(); },
    set ready(value) { ready = value; }, get nativeQueries() { return nativeQueries; }, get programQueries() { return programQueries; },
    set compileError(value) { compileError = value; }, set bindError(value) { bindError = value; }, set restoreError(value) { restoreError = value; },
    lose() { lost = true;canvas.dispatchEvent(new Event('webglcontextlost')); }, restore() { lost = false;renderer.properties = new Map();canvas.dispatchEvent(new Event('webglcontextrestored')); },
    tuple() { return [target, face, mip]; }, dispose() { manager.dispose();queue.dispose();material.dispose();geometry.dispose();hdr.dispose();caller.dispose(); },
  };fixtures.push(f);return f;
}

try {
  await test('constructor and empty requests perform zero native queries and no queue work', async () => {
    const f = fixture();assert.equal(f.nativeQueries, 0);assert.equal(f.manager.ensure({ requests: [] }), true);assert.equal(f.nativeQueries, 0);assert.equal(f.queue.snapshot().pending, 0);
  });
  await test('required CACHE families enqueue once and readiness does not hold target/defines/scene lease', async () => {
    const f = fixture(), defines = f.material.defines, originalVersion = f.material.version, parent = f.mesh.parent, matrices = f.mesh.matrixWorld.toArray();
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.records.length, 0);assert.equal(f.queue.snapshot().queued, 2);
    f.run();assert.deepEqual(f.tuple(), [f.caller, 3, 1]);assert.equal(f.material.defines, defines);assert.equal(defines.CLOUD_FAR_CACHE, 0);assert.ok(f.material.version > originalVersion);
    assert.equal(f.mesh.parent, parent);assert.deepEqual(f.mesh.matrixWorld.toArray(), matrices);assert.equal(f.manager.snapshot().pending, 2);
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().submitted, 2);f.run();await f.complete();assert.equal(f.manager.ensure(f.config), true);
  });
  await test('compiler view uses actual mesh, uniforms, textures and nonrecursive VOLUME camera', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();const row = f.records[0];
    assert.equal(row.selected.length, 1);assert.equal(Object.getPrototypeOf(row.selected[0]), f.mesh);assert.equal(row.selected[0].geometry, f.geometry);assert.equal(row.selected[0].material, f.material);assert.equal(row.uniformObject, f.material.uniforms);assert.equal(row.texture, f.material.uniforms.uTexture.value);
    assert.notEqual(row.camera, f.camera);assert.equal(row.camera.layers.mask, 4);assert.equal(row.camera.children.length, 0);assert.equal(f.camera.layers.mask, 128);assert.equal(row.target, f.hdr);
    assert.equal(row.lights.length, 1);assert.notEqual(row.lights[0], f.light);assert.deepEqual(row.lightPositions, [[101, 202, 303]]);assert.equal(row.lighting.children.length, 0);
  });
  await test('actual instancing/count/attribute arrays are borrowed without copying', async () => {
    const f = fixture({ instance: true });f.mesh.count = 0;f.mesh.setColorAt(0, new THREE.Color(1, 0, 0));const matrix = f.mesh.instanceMatrix, color = f.mesh.instanceColor;
    f.manager.ensure(f.config);f.run();assert.equal(Object.getPrototypeOf(f.records[0].selected[0]), f.mesh);assert.equal(f.records[0].selected[0].instanceMatrix, matrix);assert.equal(f.records[0].selected[0].instanceColor, color);assert.equal(f.mesh.instanceMatrix, matrix);assert.equal(f.mesh.instanceColor, color);assert.equal(f.mesh.count, 0);
  });
  await test('future far material compiles while live sphere still owns near material', async () => {
    const f = fixture({ variants: [0] }), near = f.mesh.material;
    const far = new THREE.ShaderMaterial({ vertexShader: near.vertexShader, fragmentShader: near.fragmentShader,
      uniforms: near.uniforms, defines: { ...near.defines, CLOUD_FAR_VIEW: 1 } });
    try {
      f.config.requests = [{ mesh: f.mesh, material: far, cacheVariants: [0, 1] }];assert.equal(f.manager.ensure(f.config), false);f.run();f.run();await f.complete();
      assert.equal(f.mesh.material, near);assert.ok(f.records.every(row => row.selected[0].material === far));assert.deepEqual(f.records.map(row => row.variant), [0, 1]);
      assert.equal(f.manager.ensure(f.config), true);assert.equal(f.manager.snapshot().submitted, 2);assert.equal(near.defines.CLOUD_FAR_CACHE, 0);assert.equal(far.uniforms, near.uniforms);
    } finally { far.dispose(); }
  });
  await test('restoring CACHE forces a real subsequent draw to select the original compiled family', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();f.run();await f.complete();
    const props = f.renderer.properties.get(f.material), temporary = props.currentProgram;assert.equal(temporary, f.programs.at(-1));assert.notEqual(f.renderer.draw(), temporary);assert.equal(f.renderer.draw(), f.programs[0]);
  });
  await test('ready ensure reuses same closure indefinitely without native readiness polls or resubmission', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure(f.config), true);const queries = f.programQueries, submitted = f.manager.snapshot().submitted;
    for (let i = 0; i < 30; i++) assert.equal(f.manager.ensure(f.config), true);assert.equal(f.programQueries, queries);assert.equal(f.manager.snapshot().submitted, submitted);
  });
  await test('uniform values, bare version, CACHE, camera pose/projection and target dimensions do not change closure', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure(f.config), true);
    f.material.uniforms.uFrame.value = 777;f.material.uniforms.uTexture.value = new THREE.Texture();f.material.needsUpdate = true;f.material.defines.CLOUD_FAR_CACHE = 1;
    f.camera.position.set(4, 5, 6);f.camera.fov = 72;f.camera.near = 4;f.camera.far = 9e10;f.camera.updateProjectionMatrix();f.hdr.width = 64;f.hdr.height = 16;
    assert.equal(f.manager.ensure(f.config), true);assert.equal(f.manager.snapshot().submitted, 2);
  });
  await test('custom keys inspecting this.defines ignore only CACHE and do not mutate live defines', async () => {
    const f = fixture();f.material.customProgramCacheKey = function() { return JSON.stringify(this.defines); };f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure(f.config), true);
    f.material.defines.CLOUD_FAR_CACHE = 1;assert.equal(f.manager.ensure(f.config), true);f.material.defines.OTHER = 3;assert.equal(f.manager.ensure(f.config), false);
  });
  for (const [name, change] of [
    ['fragment source', f => { f.material.fragmentShader += '\n// structural'; }],
    ['vertex source', f => { f.material.vertexShader += '\n// structural'; }],
    ['non-CACHE define', f => { f.material.defines.PRODUCTION_CLOUD_MEDIUM = 0; }],
    ['custom shader key', f => { f.material.customProgramCacheKey = () => 'different'; }],
    ['geometry layout', f => { f.geometry.setAttribute('extra', new THREE.Float32BufferAttribute([0, 0, 0], 3)); }],
    ['renderer tone mapping', f => { f.renderer.toneMapping = THREE.ACESFilmicToneMapping; }],
    ['HDR format', f => { f.hdr.texture.type = THREE.FloatType; }],
    ['camera ABI', f => { f.config.camera = new THREE.OrthographicCamera(); }],
    ['visible VOLUME light family', f => { const light = new THREE.HemisphereLight();light.layers.set(2);f.scene.add(light); }],
    ['scene fog family', f => { f.scene.fog = new THREE.FogExp2(); }],
    ['material structural flags', f => { f.material.premultipliedAlpha = !f.material.premultipliedAlpha; }],
  ]) await test(`${name} invalidates prepared closure`, async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure(f.config), true);change(f);assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().submitted, 4);
  });
  await test('vertex data contents and light uniform values do not invalidate layout', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();f.geometry.attributes.position.array[0] += 4;f.geometry.attributes.position.needsUpdate = true;f.light.intensity = 17;f.light.position.x += 5;
    assert.equal(f.manager.ensure(f.config), true);
  });
  await test('request order/duplicates do not create new epochs or compile work', async () => {
    const f = fixture();f.config.requests.push({ ...f.request, cacheVariants: [1, 0, 1] });f.manager.ensure(f.config);const epoch = f.manager.snapshot().epoch;
    f.config.requests.reverse();f.manager.ensure(f.config);assert.equal(f.manager.snapshot().epoch, epoch);assert.equal(f.manager.snapshot().submitted, 2);
  });
  await test('plan change cancels queued and readiness work; late completion cannot mark old closure ready', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();assert.equal(f.queue.snapshot().waiting, 1);f.material.fragmentShader += '\n// next epoch';
    f.manager.ensure(f.config);await microtasks();assert.equal(f.manager.snapshot().cancelled, 2);assert.equal(f.manager.snapshot().pending, 2);await f.complete();assert.equal(f.manager.ensure(f.config), true);assert.equal(f.manager.snapshot().submitted, 4);
  });
  await test('empty plan cancels old queued work then reuses still-live ready shape on return', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure({ requests: [] }), true);assert.equal(f.manager.ensure(f.config), true);assert.equal(f.manager.snapshot().submitted, 2);
  });
  await test('abandoning pending plan with empty requests does not wait on native readiness', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();assert.equal(f.manager.ensure({ requests: [] }), true);await microtasks();assert.equal(f.queue.snapshot().pending, 0);assert.equal(f.manager.snapshot().required, 0);
  });
  await test('native completion owner must finish even when shader readiness is ready', async () => {
    const f = fixture({ variants: [0] });f.ready = true;f.manager.ensure(f.config);const ticket = f.run({ finish: false });await tick();assert.equal(f.manager.ensure(f.config), false);
    f.finish(ticket);await microtasks();assert.equal(f.manager.ensure(f.config), true);
  });
  await test('failed completion fence cannot falsely publish ready shaders', async () => {
    const f = fixture({ variants: [0] });f.ready = true;f.manager.ensure(f.config);const ticket = f.run({ finish: false });await tick();f.finish(ticket, { failed: true, error: Error('fence failed') });await microtasks();
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().failed, true);assert.match(f.manager.snapshot().failures[0].message, /fence failed/);
  });
  await test('compile failure is explicit and fail-closed without every-frame retries', async () => {
    const f = fixture({ variants: [0] });f.compileError = Error('actual compile failed');f.manager.ensure(f.config);f.run();await microtasks();
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().failed, true);assert.equal(f.manager.snapshot().submitted, 1);assert.deepEqual(f.tuple(), [f.caller, 3, 1]);assert.equal(f.material.defines.CLOUD_FAR_CACHE, 0);
  });
  await test('readiness exception cannot mark entry ready', async () => {
    const f = fixture({ variants: [0] });f.manager.ensure(f.config);f.run();f.programs[0].isReady = () => { throw Error('driver query failed'); };await tick();
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().failed, true);assert.equal(f.manager.snapshot().ready, 0);
  });
  await test('target bind failure still restores original tuple/defines and reports failure', async () => {
    const f = fixture({ variants: [1] });f.bindError = Error('bind failed');f.manager.ensure(f.config);f.run();await microtasks();assert.deepEqual(f.tuple(), [f.caller, 3, 1]);
    assert.equal(f.material.defines.CLOUD_FAR_CACHE, 0);assert.equal(f.manager.snapshot().failed, true);
  });
  await test('target restoration failure is not successful preparation', async () => {
    const f = fixture({ variants: [1] });f.restoreError = Error('restore failed');f.manager.ensure(f.config);f.run();await microtasks();assert.equal(f.material.defines.CLOUD_FAR_CACHE, 0);
    assert.equal(f.manager.snapshot().failed, true);assert.match(f.manager.snapshot().failures[0].message, /restore failed/);
  });
  await test('material disposal during readiness cancels publication and old queued callback', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();f.material.dispose();await microtasks();assert.equal(f.manager.snapshot().ready, 0);assert.equal(f.manager.snapshot().blocked, true);await f.complete();assert.equal(f.manager.snapshot().ready, 0);
  });
  await test('renderer registry replacement invalidates ready cache', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();f.renderer.properties = new Map();assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().submitted, 4);
  });
  await test('properties identity replacement invalidates ready cache even when program remains alive', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();const old = f.renderer.properties.get(f.material);f.renderer.properties.set(f.material, { ...old });assert.equal(f.manager.ensure(f.config), false);
  });
  await test('released native program handle invalidates cache and cannot pass ensure', async () => {
    const f = fixture();f.manager.ensure(f.config);await f.complete();f.programs[0].program = null;assert.equal(f.manager.ensure(f.config), false);
  });
  await test('native handle replaced during readiness is not trusted as the awaited handle', async () => {
    const f = fixture({ variants: [0] });f.manager.ensure(f.config);f.run();f.programs[0].program = {};await f.complete();
    assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().failed, true);assert.equal(f.manager.snapshot().ready, 0);
  });
  await test('registry replaced inside compile rejects without an unhandled readiness promise', async () => {
    const f = fixture({ variants: [0] });f.manager.ensure(f.config);f.onCompile = () => { f.renderer.properties = new Map(); };f.run();await tick();
    assert.equal(f.manager.snapshot().failed, true);assert.equal(f.manager.snapshot().ready, 0);
  });
  await test('live target resize/disposal cancels old generation and permits reallocation', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();f.hdr.setSize(64, 64);await microtasks();assert.equal(f.manager.snapshot().ready, 0);assert.equal(f.manager.ensure(f.config), false);await f.complete();assert.equal(f.manager.ensure(f.config), true);
  });
  await test('context loss cancels old work and restored registry requires fresh preparation', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();f.lose();await microtasks();assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().contextLost, true);
    f.restore();assert.equal(f.manager.ensure(f.config), false);await f.complete();assert.equal(f.manager.ensure(f.config), true);
  });
  await test('owner abort/dispose rejects required frame and ignores late native readiness', async () => {
    const f = fixture();f.manager.ensure(f.config);f.run();f.source.abort();await f.complete();assert.equal(f.manager.ensure(f.config), false);assert.equal(f.manager.snapshot().disposed, true);assert.equal(f.manager.snapshot().cached, 0);
  });
  await test('structural mutation inside compile cannot publish the stale key', async () => {
    const f = fixture({ variants: [0] });f.manager.ensure(f.config);f.onCompile = () => { f.material.defines.NEW_LAYOUT = 1; };f.run();await f.complete();assert.equal(f.manager.snapshot().ready, 0);
    f.onCompile = null;assert.equal(f.manager.ensure(f.config), false);await f.complete();assert.equal(f.manager.ensure(f.config), true);
  });
  await test('inactive cache is bounded while currently required family remains reusable', async () => {
    const f = fixture({ maxIdleEntries: 1, variants: [0] });for (let i = 0; i < 5; i++) { f.material.defines.REVISION = i;f.manager.ensure(f.config);await f.complete();assert.equal(f.manager.ensure(f.config), true); }
    assert.ok(f.manager.snapshot().cached <= 2);
    assert.equal(f.manager.ensure({ requests: [] }), true);assert.ok(f.manager.snapshot().cached <= 1);
  });
  await test('invalid request is explicit fail-closed without native compilation', async () => {
    const f = fixture();assert.equal(f.manager.ensure({ ...f.config, requests: [{ ...f.request, cacheVariants: [2] }] }), false);assert.equal(f.manager.snapshot().failed, true);assert.equal(f.records.length, 0);
  });
  await test('invalid replacement plan cancels previous queued jobs', async () => {
    const f = fixture();f.manager.ensure(f.config);assert.equal(f.manager.ensure({ ...f.config, requests: [{ ...f.request, cacheVariants: [2] }] }), false);
    await microtasks();assert.equal(f.queue.snapshot().pending, 0);assert.equal(f.manager.snapshot().failed, true);assert.equal(f.records.length, 0);
  });
} finally { globalThis.setTimeout = original.setTimeout;globalThis.clearTimeout = original.clearTimeout; }
const stability = [];
for (const [file, bytes] of frozen) { const after = await readFile(file);stability.push({ file, before: sha(bytes), after: sha(after) }); }
const report = { scope: 'Actual CloudProgramPreparation, compilePrograms and GpuPreparationQueue with CPU renderer/native completion/readiness doubles. No shader compilation, native HDR, driver latency or player-performance acceptance.', cases,
  source: stability, passed: cases.every(row => row.passed) && stability.every(row => row.before === row.after) };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ out, passed: report.passed, checks: cases.length, failures: cases.filter(row => !row.passed).map(row => ({ name: row.name, error: row.error })) }));
assert.ok(report.passed, `Cloud program preparation failed: ${out}/report.json`);
