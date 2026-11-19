// Actual pipeline, frame pacer and preparation queue. Only renderer/GPU work is
// doubled: these contracts prove scheduling/lease ownership, never GPU timing.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as THREE from 'three';
import { GameLegacyPipeline } from '../src/legacy-render-pipeline.js';
import { lightBatchNoLongerPrepared } from '../src/volumetric-pass-webgl.js';

const files = ['src/legacy-render-pipeline.js', 'src/gpu-preparation-queue.js', 'src/gpu-frame-pacer.js',
  'src/render-frame-state.js', 'src/program-preparation.js', 'tools/preparationpipelinetest.js'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const frozen = new Map(await Promise.all(files.map(async path => [path, await readFile(path)])));
const out = `test-results/preparation-pipeline/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });
for (const [path, bytes] of frozen) await writeFile(`${out}/${path.split('/').at(-1)}`, bytes);
const original = Object.fromEntries(['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout', 'clearTimeout', 'matchMedia'].map(name => [name, globalThis[name]]));
const rafs = new Map(), timers = new Map();let nextTimer = 0;
globalThis.requestAnimationFrame = work => { const id = ++nextTimer;rafs.set(id, work);return id; };
globalThis.cancelAnimationFrame = id => rafs.delete(id);
globalThis.setTimeout = (work, ms) => { const id = ++nextTimer;timers.set(id, { work, ms });return id; };
globalThis.clearTimeout = id => timers.delete(id);
globalThis.matchMedia = () => ({ matches: true });
const microtasks = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const frameTick = () => { const batch = [...rafs];for (const [id, work] of batch) if (rafs.delete(id)) work(); };
const timerTick = () => { const batch = [...timers];for (const [id, entry] of batch) if (timers.delete(id)) entry.work(); };
const deferred = () => { let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });return { promise, resolve, reject }; };
const observe = promise => {
  const result = { settled: false, success: null, value: undefined };
  result.done = promise.then(value => Object.assign(result, { settled: true, success: true, value }),
    value => Object.assign(result, { settled: true, success: false, value }));return result;
};
const fixtures = [], cases = [];
function caught(work) { let didThrow = false, value;try { work(); } catch (error) { didThrow = true;value = error; }assert.ok(didThrow);return value; }
function fixture() {
  let lost = false, epoch = 0, target = { name: 'caller' }, face = 4, mip = 2, nullFence = false;
  const initial = { target, face, mip }, events = [], listeners = new Map(), syncs = [], hooks = new Map(), properties = new Map();
  const invoke = (name, work) => { events.push(name);const hook = hooks.get(name);if (hook) { hooks.delete(name);hook(); }return work(); };
  const emit = name => { for (const work of [...listeners.get(name) || []]) work(); };
  const gl = { SYNC_GPU_COMMANDS_COMPLETE: 1, TIMEOUT_EXPIRED: 2, CONDITION_SATISFIED: 3, ALREADY_SIGNALED: 4, WAIT_FAILED: 5,
    isContextLost: () => invoke('context', () => lost),
    fenceSync: (condition, flags) => invoke('fence', () => {
      assert.equal(condition, 1);assert.equal(flags, 0);if (nullFence) { nullFence = false;return null; }
      const sync = { status: 2, epoch, deleted: false };syncs.push(sync);return sync;
    }),
    clientWaitSync: (sync, flags, timeout) => invoke('wait', () => { assert.equal(flags, 0);assert.equal(timeout, 0);assert.equal(sync.epoch, epoch);return sync.status; }),
    deleteSync: sync => invoke('delete', () => { assert.equal(sync.deleted, false);sync.deleted = true; }),
    flush() { assert.fail('No flush'); }, finish() { assert.fail('No finish'); }, waitSync() { assert.fail('No server wait'); } };
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const material = new THREE.MeshBasicMaterial(), program = { program: {}, isReady: () => true };
  properties.set(material, { currentProgram: program, programs: new Map([[0, program]]) });
  const renderer = { getPixelRatio: () => 1, getContext: () => gl, info: {}, properties,
    domElement: { addEventListener(name, work) { if (!listeners.has(name)) listeners.set(name, new Set());listeners.get(name).add(work); },
      removeEventListener(name, work) { listeners.get(name)?.delete(work); } },
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => mip,
    setRenderTarget(value, nextFace = 0, nextMip = 0) { return invoke('target', () => { target = value;face = nextFace;mip = nextMip; }); },
    compile(source, compileCamera, targetScene) { return invoke('compile', () => { assert.equal(source, scene);assert.equal(compileCamera, camera);assert.equal(targetScene, null);return new Set([material]); }); } };
  const pipeline = new GameLegacyPipeline(renderer, scene, camera, { volume: false });
  // The graph is a CPU draw double; supply the budget's teardown recipient
  // without constructing the unrelated volume targets/shaders in these tests.
  pipeline.volumePass = { activePlanet: null, configureColumnWork() {}, resetHistory() {}, releaseTargets() {}, dispose() {} };
  if (pipeline.cloudSurfaceShadow) pipeline.cloudSurfaceShadow.render = () => {};
  pipeline.composer.render = () => invoke('graph', () => renderer.setRenderTarget(null));
  const budget = { frame: 0, beginFrame() { this.frame++; }, dispose() {} };
  const profiler = { frame: 0, beginFrame() { this.frame++; }, run(_name, work) { return work(); }, dispose() {} };
  pipeline.columnWorkBudget = budget;pipeline.profiler = profiler;
  const f = { pipeline, renderer, gl, scene, camera, properties, events, syncs, initial, budget, profiler,
    hook(name, work) { assert.equal(hooks.has(name), false);hooks.set(name, work); },
    complete() { for (const sync of syncs) if (sync.epoch === epoch) sync.status = gl.CONDITION_SATISFIED; },
    lose() { lost = true;epoch++;emit('webglcontextlost'); }, restore() { lost = false;emit('webglcontextrestored'); },
    nullFence() { nullFence = true; },
    restored() { assert.deepEqual({ target, face, mip }, initial); },
    state() { return { sequence: pipeline.frameState.sequence, valid: pipeline.frameState.valid,
      budget: budget.frame, profiler: profiler.frame, graphs: events.filter(event => event === 'graph').length }; },
    cleanup() { hooks.clear();f.lose();pipeline.dispose();material.dispose(); } };
  fixtures.push(f);return f;
}
async function test(name, work) {
  const start = fixtures.length;
  try { await work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), stack: error?.stack }); }
  finally { for (const f of fixtures.slice(start)) try { f.cleanup(); } catch {}rafs.clear();timers.clear();await microtasks(); }
}
try {
  await test('preparations take one complete slot each and alternate with player graphs in FIFO order', async () => {
    const f = fixture(), p = f.pipeline, order = [];
    const a = observe(p.prepare(() => { order.push('a');return 11; })), b = observe(p.prepare(() => { order.push('b');return 22; }));
    assert.deepEqual(order, []);assert.equal(p.render(), false);assert.deepEqual(order, ['a']);assert.equal(p.frameState.sequence, 0);
    await microtasks();assert.equal(a.success, true);assert.equal(a.value, 11);assert.equal(b.settled, false);
    assert.equal(p.render(), true);assert.equal(p.render(), false);assert.deepEqual(order, ['a', 'b']);assert.equal(p.render(), true);
    await microtasks();assert.equal(b.value, 22);assert.deepEqual(f.state(), { sequence: 2, valid: true, budget: 2, profiler: 2, graphs: 2 });f.restored();
  });
  await test('readiness never holds a scene lease or blocks a later preparation/player graph', async () => {
    const f = fixture(), p = f.pipeline, readiness = deferred();let borrowed = false;
    const job = observe(p.prepare(() => { borrowed = true;try { return readiness.promise; } finally { borrowed = false; } }));
    assert.equal(p.render(), false);assert.equal(borrowed, false);await microtasks();assert.equal(job.settled, false);
    const next = observe(p.prepare(() => 7));assert.equal(p.render(), true);assert.equal(p.render(), false);assert.equal(p.render(), true);
    await microtasks();assert.equal(next.value, 7);assert.equal(job.settled, false);readiness.resolve(9);await job.done;assert.equal(job.value, 9);f.restored();
  });
  await test('native busy prevents queued callbacks and another fence; completion admits exactly one preparation', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing();assert.equal(p.render(), true);let calls = 0;
    const job = observe(p.prepare(() => { calls++;return true; }));const before = f.state(), fences = f.syncs.length;
    for (let i = 0; i < 4; i++) assert.equal(p.render(), false);
    assert.equal(calls, 0);assert.deepEqual(f.state(), before);assert.equal(f.syncs.length, fences);
    f.complete();assert.equal(p.render(), false);assert.equal(calls, 1);assert.equal(f.syncs.length, fences + 1);assert.equal(pacer.snapshot().pending, 1);
    assert.deepEqual(f.state(), before);await job.done;assert.equal(job.success, true);f.complete();assert.equal(p.render(), true);assert.equal(f.syncs.length, fences + 2);f.restored();
  });
  await test('private preparation graph uses the admitted one-use draw without publishing a caller frame', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing(), privateTarget = {}, privateOrigin = new THREE.Vector3(7, 8, 9);let escaped;
    const playerOrigin = new THREE.Vector3(2, 3, 4);
    assert.equal(p.render({ origin: playerOrigin, context: f.scene }),true);f.complete();
    const job = observe(p.prepare(draw => {
      escaped = draw;f.renderer.setRenderTarget(privateTarget);
      assert.equal(draw({ origin: privateOrigin, context: 'private' }), true);return 'prepared';
    }));
    let playerCalls = 0;assert.equal(p.submitFrame(() => { playerCalls++; }), false);assert.equal(playerCalls, 0);assert.equal(p.frameState.sequence, 1);
    assert.equal(p.frameState.valid, false);assert.equal(p.frameState.pending, false);
    assert.equal(p.frameState.reason, 'private-prewarm');assert.ok(p.frameState.previous.origin.equals(playerOrigin));
    assert.equal(p.frameState.previous.context,f.scene);
    assert.equal(pacer.snapshot().stats.submitted, 2);f.restored();await job.done;
    assert.equal(job.value, 'prepared');assert.match(String(caught(() => escaped())), /no longer active/);
    f.complete();assert.equal(p.render(), true);assert.equal(p.frameState.sequence, 2);assert.equal(p.frameState.previous.context, f.scene);f.restored();
  });
  await test('maintenance pump shares the same owner without requiring a running main loop', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing();let calls = 0;
    const job = observe(p.prepare(() => ++calls));assert.equal(calls, 0);frameTick();await job.done;
    assert.equal(job.value, 1);assert.equal(p.frameState.sequence, 0);assert.equal(pacer.snapshot().stats.submitted, 1);assert.equal(f.syncs.length, 1);f.restored();
  });
  await test('prepared batch skips the direct gate and a late route change requires the direct gate before publication', () => {
    const f=fixture(),p=f.pipeline,requests=[{}],seen=[];
    let directReady=false;
    Object.assign(p.volumePass,{enabled:true,lightBatchesEnabled:true,
      requiredProgramRequests:()=>requests,usesPreparedLightBatch:()=>true,prefetchLightBatches(){}});
    p.cloudProgramsEnabled=true;
    p.cloudPrograms.ensure=config=>{
      seen.push(config.requests);
      return !config.requests.length||directReady;
    };
    f.hook('graph',()=>{
      assert.equal(p.volumePass.requirePreparedLightBatch,true);
      throw lightBatchNoLongerPrepared;
    });
    assert.equal(p.render(),false);
    assert.equal(p.frameState.sequence,0);
    assert.equal(p.frameState.pending,false);
    assert.equal(p.volumePass.requirePreparedLightBatch,false);
    f.restored();
    assert.equal(p.render(),false);
    assert.equal(p.frameState.sequence,0);
    directReady=true;
    assert.equal(p.render(),true);
    assert.equal(p.frameState.sequence,1);
    assert.equal(p.render(),true);
    assert.equal(p.frameState.sequence,2);
    assert.deepEqual(seen,[[],requests,requests,[]]);
    f.restored();
  });
  await test('maintenance lets active foreground attempts run first rather than adding a second submission', async () => {
    const f = fixture(), p = f.pipeline;p.render();const job = observe(p.prepare(() => 'ready'));
    frameTick();assert.equal(job.settled, false);assert.equal(p.preparations.snapshot().stats.yielded, 1);
    assert.equal(p.render(), false);await job.done;assert.equal(job.value, 'ready');assert.equal(p.frameState.sequence, 1);f.restored();
  });
  await test('queued abort performs no temporary state mutation and permits the next player graph', async () => {
    const f = fixture(), p = f.pipeline, abort = new AbortController();let calls = 0;
    const job = observe(p.prepare(() => calls++, { signal: abort.signal }));abort.abort();await job.done;
    assert.equal(job.value.code, 'aborted');assert.equal(calls, 0);assert.equal(p.render(), true);assert.equal(p.preparations.snapshot().pending, 0);f.restored();
  });
  await test('admission revalidates source after a native wait callback changes its owner', async () => {
    const f = fixture(), p = f.pipeline;p.startFramePacing();p.render();f.complete();let current = true, calls = 0;
    const job = observe(p.prepare(() => calls++, { isCurrent: () => current }));f.hook('wait', () => { current = false; });
    assert.equal(p.render(), true);await job.done;assert.equal(job.value.code, 'obsolete');assert.equal(calls, 0);assert.equal(p.frameState.sequence, 2);f.restored();
  });
  await test('abort inside a preparation cancels publication but retains its real captured GPU fence', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing(), abort = new AbortController();
    const job = observe(p.prepare(() => { abort.abort();return 99; }, { signal: abort.signal }));assert.equal(p.render(), false);await job.done;
    assert.equal(job.value.code, 'aborted');assert.equal(pacer.snapshot().pending, 1);assert.equal(pacer.snapshot().released, false);assert.equal(p.render(), false);f.restored();
  });
  await test('context loss rejects readiness and restore cannot publish its old promise into new jobs', async () => {
    const f = fixture(), p = f.pipeline, ready = deferred();const old = observe(p.prepare(() => ready.promise));p.render();
    f.lose();await old.done;assert.equal(old.value.code, 'context-lost');f.restore();ready.resolve(99);await microtasks();
    const fresh = observe(p.prepare(() => 3));assert.equal(p.render(), true);assert.equal(p.render(), false);await fresh.done;
    assert.equal(fresh.value, 3);assert.equal(old.success, false);assert.equal(p.preparations.snapshot().epoch, 1);f.restored();
  });
  await test('stop during preparation fences its captured retiring owner without waiting for readiness', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing(), ready = deferred();
    const job = observe(p.prepare(() => { p.stopFramePacing();return ready.promise; }));assert.equal(p.render(), false);
    assert.equal(p.framePacer, null);assert.equal(pacer.snapshot().pending, 1);assert.equal(pacer.snapshot().disposed, true);assert.throws(() => p.startFramePacing(), /already has/);
    assert.equal(job.settled, false);f.complete();timerTick();assert.equal(pacer.snapshot().released, true);ready.resolve('linked');await job.done;assert.equal(job.value, 'linked');f.restored();
  });
  await test('a missing preparation fence quarantines ownership and cannot resolve readiness as success', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing();const job = observe(p.prepare(() => 'compiled'));f.nullFence();
    assert.equal(p.render(), false);await job.done;assert.equal(job.success, false);assert.match(String(job.value), /fence failed/);
    assert.equal(pacer.snapshot().fault, 'fence-create-failed');assert.equal(pacer.snapshot().pending, 1);assert.equal(p.render(), false);f.restored();
  });
  await test('a throwing completion fence rejects both the caller and an otherwise successful preparation', async () => {
    const f = fixture(), p = f.pipeline;p.startFramePacing();const error = Error('fence throw'), job = observe(p.prepare(() => 9));
    f.hook('fence', () => { throw error; });assert.equal(caught(() => p.render()), error);await job.done;assert.equal(job.value, error);f.restored();
  });
  await test('permanent owner fault rejects queued work instead of scheduling an endless busy pump', async () => {
    const f = fixture(), p = f.pipeline;p.startFramePacing();f.nullFence();p.render();let calls = 0;
    const job = observe(p.prepare(() => calls++));assert.equal(p.render(), false);await job.done;
    assert.equal(job.success, false);assert.equal(calls, 0);assert.equal(p.preparations.snapshot().pending, 0);assert.equal(p.preparations.snapshot().scheduled, false);f.restored();
  });
  await test('pipeline disposal rejects both queued and submitted readiness without releasing an in-flight owner', async () => {
    const f = fixture(), p = f.pipeline, pacer = p.startFramePacing(), ready = deferred();
    const active = observe(p.prepare(() => ready.promise)), queued = observe(p.prepare(() => assert.fail('Disposed job ran')));p.render();p.dispose();await microtasks();
    assert.equal(active.value.code, 'disposed');assert.equal(queued.value.code, 'disposed');assert.equal(pacer.snapshot().released, false);
    ready.reject(Error('late link failure'));await microtasks();assert.equal(active.success, false);f.complete();timerTick();assert.equal(pacer.snapshot().released, true);f.restored();
  });
  await test('preparation errors including falsy values reject the job and leave following player frames usable', async () => {
    for (const error of [null, undefined, false, 0, Error('compile')]) {
      const f = fixture(), p = f.pipeline, job = observe(p.prepare(() => { throw error; }));assert.equal(p.render(), false);await job.done;
      assert.equal(job.success, false);assert.equal(job.value, error);assert.equal(p.render(), true);assert.equal(p.frameState.sequence, 1);f.restored();
    }
  });
  await test('a failed private graph aborts history without reporting a completed destination draw', async () => {
    const f = fixture(), p = f.pipeline, error = Error('private graph');p.startFramePacing();f.hook('graph', () => { throw error; });
    const job = observe(p.prepare(draw => draw()));assert.equal(p.render(), false);await job.done;
    assert.equal(job.value, error);assert.equal(p.frameState.sequence, 0);assert.equal(p.frameState.valid, false);assert.equal(p.framePacer.snapshot().pending, 1);f.restored();
  });
  await test('public compileAsync submits actual compilePrograms only within a queued preparation scope', async () => {
    const f = fixture(), p = f.pipeline, job = observe(p.compileAsync());assert.equal(f.events.includes('compile'), false);
    assert.equal(p.render(), false);assert.equal(f.events.filter(name => name === 'compile').length, 1);assert.equal(p.frameState.sequence, 0);
    timerTick();await microtasks();assert.equal(job.success, true);assert.equal(p.preparations.snapshot().pending, 0);assert.equal(p.render(), true);f.restored();
  });
} finally {
  for (const [name, value] of Object.entries(original)) { if (value === undefined) delete globalThis[name];else globalThis[name] = value; }
}
const sources = [];
for (const [path, bytes] of frozen) sources.push({ path, bytes: bytes.length, sha256: hash(bytes), stable: hash(bytes) === hash(await readFile(path)) });
const report = { kind: 'actual-pipeline-cpu', scope: 'Scheduling/ownership with CPU renderer; no native image or performance claim',
  passed: cases.filter(item => item.passed).length, total: cases.length, sources, cases };
await writeFile(`${out}/report.json`, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ out, passed: report.passed, total: report.total, failures: cases.filter(item => !item.passed), stable: sources.every(item => item.stable) }, null, 2));
assert.equal(report.passed, report.total);assert.ok(sources.every(item => item.stable), 'Preparation runtime changed during this capture');
