// Registered WORLD publication, exercising actual main/capture implementations.
// Reference mode runs the old real main block; a missing new API is not a red control.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';
import { StarSystem } from '../src/galaxy.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const reference = process.argv.find(value => value.startsWith('--reference-main='))?.slice('--reference-main='.length);
const readMain = async () => reference ? execFileSync('git', ['show', `${reference}:src/main.js`]) : readFile('src/main.js');
// Source anchors below are LF; a CRLF checkout (core.autocrlf) must not hide them.
const bytes = await readMain(), main = bytes.toString().replace(/\r\n/g, '\n'), verifier = await readFile(new URL(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const out = `test-results/deferred-publication/${new Date().toISOString().replace(/[:.]/g, '-')}`;
await mkdir(out, { recursive: true });await writeFile(`${out}/main.js`, bytes);await writeFile(`${out}/verifier.js`, verifier);
const cases = [], functions = {};
function load(name, context) {
  const signature = main.includes(`async function ${name}(`) ? `async function ${name}(` : `function ${name}(`;
  const start = main.indexOf(signature), end = start + main.slice(start).search(/\n}(?=\r?\n)/);
  assert.ok(start >= 0 && end > start, name);const source = main.slice(start, end + 2);
  functions[name] = { sha256: hash(source), bytes: Buffer.byteLength(source) };return vm.runInNewContext(`(${source})`, context);
}
async function test(name, work) {
  try { await work();cases.push({ name, passed: true }); }
  catch (error) { cases.push({ name, passed: false, error: String(error), stack: error.stack }); }
}
const microtasks = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
// GLTF completion is a later, independent resource-publication producer. Keep
// it pending while the real synchronous civilization constructor runs on CPU.
const originalLoadAsync = GLTFLoader.prototype.loadAsync;
GLTFLoader.prototype.loadAsync = () => new Promise(() => {});
function producer(type = 'hero-city-world') {
  const base = (id, gas = false) => ({ bodyId: id, type: gas ? 'gasGiant' : 'lush', isGasGiant: gas,
    R: 100000, atmoHeight: 1000, group: new THREE.Group(), posUniv: new THREE.Vector3(),
    frameOrientation: new THREE.Quaternion(), frameVelocity: new THREE.Vector3(), skyColor: new THREE.Color(), skyColorLin: new THREE.Color(),
    sunDirWorld: new THREE.Vector3(1, 0, 0), sunDirLocal: new THREE.Vector3(1, 0, 0), pal: {},
    surfaceRadius: () => 100000, localPositionToWorld: (value, out) => out.copy(value),
  });
  const parent = base('parent', type === 'hero-floating-city'), last = base('last'), root = new THREE.Group();root.add(parent.group);
  const site = { id: 'site', systemId: 'SYS', type, bodyId: parent.bodyId, seed: 'publication-cpu', landingZone: { normal: [0, 1, 0] } };
  let builds = 0;
  const system = { universe: { group: root, civilizationSites: [site] }, star: { id: 'SYS', pos: new THREE.Vector3() },
    bodyById: new Map([[parent.bodyId, parent]]), planets: [parent], compactObjects: [], artificialSites: [], built: false,
    buildNext() { builds++;this.planets.push(last);this.bodyById.set(last.bodyId, last);root.add(last.group);
      this.built = true;StarSystem.prototype.buildCivilization.call(this);return false; },
  };
  return { system, parent, last, get builds() { return builds; }, roots() {
    return [...system.planets.filter(body => body !== parent).map(body => body.group),
      ...system.artificialSites.flatMap(entry => [entry.group, entry.group.userData.planetLights].filter(Boolean))];
  }, hidden() { for (const object of this.roots()) assert.equal(object.visible, false, `Unpublished ${object.type} must stay hidden`); },
  published() { for (const object of this.roots()) assert.equal(object.visible, true, `Registered ${object.type} must commit together`); } };
}
function deferredBlock(context) {
  const start = main.indexOf("if (state !== 'warp' && performance.now() >= systemBuildResumeAt"), end = main.indexOf('\n\n  const nearTerrain', start);
  assert.ok(start >= 0 && end > start, 'Actual normal deferred frame block');const source = main.slice(start, end);
  functions.deferredFrameBlock = { sha256: hash(source), bytes: Buffer.byteLength(source) };return () => vm.runInNewContext(source, context);
}

if (reference) {
  for (const type of ['hero-city-world', 'hero-floating-city']) {
    const f = producer(type), context = { state: 'space', performance: { now: () => 1000 }, systemBuildResumeAt: 0,
      universe: { system: f.system }, deferredSystemBuildActive: false, deferredSystemWarmQueue: [],
      prewarmWorldMaterials: () => Promise.reject(Error('controlled preparation failure')), console: { error() {} } };
    context.finishDeferredSystemMaterialPreparation = load('finishDeferredSystemMaterialPreparation', context);
    deferredBlock(context)();const during = f.roots().map(object => ({ type: object.type, visible: object.visible }));
    await test(`reference ${type}: all registered products remain hidden during preparation`, () => f.hidden());
    await microtasks();const afterFailure = f.roots().map(object => ({ type: object.type, visible: object.visible }));
    await test(`reference ${type}: rejected preparation never reveals registered products`, () => f.hidden());
    cases[cases.length - 2].observed = during;cases[cases.length - 1].observed = afterFailure;
  }
}

let publicationBytes;
if (!reference) {
  publicationBytes = await readFile('src/world-publication.js');await writeFile(`${out}/world-publication.js`, publicationBytes);
  const { captureWorldPublication } = await import('../src/world-publication.js');
  function fixture(type) {
    const f = producer(type), jobs = [], readiness = [], captures = [], compiled = [], errors = [];
    let executing = false, revision = 'world-A', now = 1000;
    const context = { THREE, state: 'space', contextLost: false, universe: { system: f.system, group: f.system.universe.group },
      scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), renderer: {}, ship: { group: new THREE.Group() }, sunShadow: new THREE.DirectionalLight(),
      deferredSystemBuildActive: false, deferredWorldPublication: null, lastWorldPublicationSnapshot: null,
      deferredSystemWarmQueue: [], systemBuildResumeAt: 0, performance: { now: () => now },
      console: { error(...args) { errors.push(args); }, warn(...args) { errors.push(args); } },
      captureWorldPublication(system, options) { const publication = captureWorldPublication(system, options);captures.push(publication);return publication; },
      worldPublicationRevision: () => revision,
      compileWorldPublicationVariant(renderer, config) {
        assert.equal(executing, true, 'Compilation belongs to the admitted queue callback');assert.equal(renderer, context.renderer);
        assert.equal(config.publication.system, f.system);assert.equal(config.target, context.nodePipeline.composer.readBuffer);
        compiled.push({ ...config });if (context.compileFault) throw context.compileFault;
        let resolve, reject;const promise = new Promise((yes, no) => { resolve = yes;reject = no; });
        const ready = { settled: false, resolve(value = revision) { ready.settled = true;resolve(value); }, reject(error) { ready.settled = true;reject(error); } };
        readiness.push(ready);return promise;
      },
    };
    const valid = job => !job.options.signal?.aborted && (!job.options.isCurrent || job.options.isCurrent());
    context.nodePipeline = { programPreparation: new AbortController(), composer: { readBuffer: {} }, prepare(work, options) {
      return new Promise((resolve, reject) => jobs.push({ work, options, resolve, reject }));
    } };
    const admit = () => {
      const job = jobs.shift();assert.ok(job, 'Expected queued WORLD family');
      if (!valid(job)) { job.reject(Object.assign(Error('controlled obsolete'), { code: 'obsolete' }));return; }
      let result;executing = true;
      try { result = job.work(); } catch (error) { job.reject(error);return; } finally { executing = false; }
      Promise.resolve(result).then(value => {
        if (valid(job)) job.resolve(value);else job.reject(Object.assign(Error('controlled obsolete'), { code: 'obsolete' }));
      }, job.reject);
    };
    for (const name of ['worldPublicationConfig', 'finishDeferredSystemMaterialPreparation', 'prepareWorldPublication', 'runDeferredSystemPublication']) context[name] = load(name, context);
    return { ...f, context, jobs, readiness, captures, compiled, errors, admit, get builds() { return f.builds; },
      run(body = null) { return context.runDeferredSystemPublication(f.system, body); },
      setRevision(value) { revision = value; }, setNow(value) { now = value; },
      async drain() { for (let pass = 0; pass < 16; pass++) {
        while (jobs.length) admit();for (const ready of readiness) if (!ready.settled) ready.resolve();await microtasks();
      }assert.equal(jobs.length, 0); },
    };
  }
  for (const type of ['hero-city-world', 'hero-floating-city']) await test(`${type} publishes every synchronous product atomically after both WORLD families`, async () => {
    const f = fixture(type), pending = f.run();await microtasks();assert.equal(f.builds, 1);assert.equal(f.captures.length, 1);
    f.hidden();assert.equal(f.parent.group.visible, true);assert.equal(f.jobs.length, 1);assert.equal(f.compiled.length, 0);
    f.admit();f.hidden();assert.equal(f.compiled[0].shadows, false);assert.equal(f.jobs.length, 0);
    f.readiness[0].resolve();await microtasks();f.hidden();assert.equal(f.jobs.length, 1);
    f.admit();assert.equal(f.compiled[1].shadows, true);f.hidden();f.readiness[1].resolve();assert.equal(await pending, true);
    f.published();assert.equal(f.context.deferredWorldPublication, null);assert.equal(f.context.deferredSystemBuildActive, false);
  });
  for (const fault of ['sync', 'async']) await test(`${fault} preparation failure retains hidden products and retries the same built=true batch`, async () => {
    const f = fixture();if (fault === 'sync') f.context.compileFault = Error('controlled synchronous preparation failure');
    const pending = f.run();await microtasks();f.admit();
    if (fault === 'async') f.readiness[0].reject(Error('controlled asynchronous preparation failure'));
    assert.equal(await pending, false);f.hidden();assert.equal(f.system.built, true);assert.equal(f.builds, 1);assert.equal(f.captures.length, 1);
    assert.ok(f.context.deferredWorldPublication);assert.equal(f.context.deferredSystemBuildActive, false);
    f.context.compileFault = null;const retry = f.run();await f.drain();assert.equal(await retry, true);f.published();
    assert.equal(f.builds, 1);assert.equal(f.captures.length, 1);
  });
  await test('the actual normal frame retries pending publication even after the producer is built', async () => {
    const f = fixture(), pending = f.run();await microtasks();f.admit();f.readiness[0].reject(Error('first attempt'));
    assert.equal(await pending, false);f.hidden();f.setNow(1300);
    const realRun = f.context.runDeferredSystemPublication;let retry;
    f.context.runDeferredSystemPublication = (...args) => { retry = realRun(...args);return retry; };
    deferredBlock(f.context)();await microtasks();assert.ok(retry, 'built=true must not strand a retained batch');
    await f.drain();assert.equal(await retry, true);f.published();assert.equal(f.builds, 1);assert.equal(f.captures.length, 1);
  });
  await test('a prebuilt adoption-queue body is published without rerunning generation', async () => {
    const f = fixture();f.system.buildNext();f.last.group.visible = false;const before = f.builds;
    const pending = f.run(f.last);await microtasks();assert.equal(f.last.group.visible, false);await f.drain();assert.equal(await pending, true);
    assert.equal(f.last.group.visible, true);assert.equal(f.builds, before);assert.equal(f.captures.length, 1);
  });
  await test('owner replacement rejects a late batch without revealing it or rewriting the new cooldown', async () => {
    const f = fixture(), pending = f.run();await microtasks();f.admit();f.context.universe.system = {};f.context.systemBuildResumeAt = 9000;
    const nextSnapshot = { owner: 'next' };f.context.lastWorldPublicationSnapshot = nextSnapshot;
    f.readiness[0].resolve();assert.equal(await pending, false);f.hidden();assert.equal(f.context.systemBuildResumeAt, 9000);
    assert.equal(f.context.lastWorldPublicationSnapshot, nextSnapshot);
    assert.equal(f.context.deferredSystemBuildActive, false);assert.equal(f.context.deferredWorldPublication, null);assert.equal(f.jobs.length, 0);
  });
  for (const change of ['warp', 'context-lost']) await test(`${change} while queued performs no compiler work and retains a retryable batch`, async () => {
    const f = fixture(), pending = f.run();await microtasks();
    if (change === 'warp') f.context.state = 'warp';else f.context.contextLost = true;
    f.admit();assert.equal(await pending, false);f.hidden();assert.equal(f.compiled.length, 0);assert.ok(f.context.deferredWorldPublication);
    f.context.state = 'space';f.context.contextLost = false;const retry = f.run();await f.drain();assert.equal(await retry, true);assert.equal(f.builds, 1);
  });
  for (const change of ['warp', 'context-lost']) await test(`${change} after the last family becomes ready postpones publication`, async () => {
    const f = fixture(), pending = f.run();await microtasks();f.admit();f.readiness[0].resolve();await microtasks();f.admit();
    f.readiness[1].resolve();queueMicrotask(() => { if (change === 'warp') f.context.state = 'warp';else f.context.contextLost = true; });
    assert.equal(await pending, false);f.hidden();assert.ok(f.context.deferredWorldPublication);assert.equal(f.context.deferredSystemBuildActive, false);
    f.context.state = 'space';f.context.contextLost = false;const retry = f.run();await f.drain();assert.equal(await retry, true);assert.equal(f.builds, 1);
  });
  await test('a revision change between off/on families rejects their mixed result and retries the same roots', async () => {
    const f = fixture(), pending = f.run();await microtasks();f.admit();f.readiness[0].resolve('world-A');await microtasks();
    f.setRevision('world-B');f.admit();f.readiness[1].resolve('world-B');assert.equal(await pending, false);f.hidden();
    assert.ok(f.context.deferredWorldPublication);assert.equal(f.captures.length, 1);
    const retry = f.run();await f.drain();assert.equal(await retry, true);f.published();assert.equal(f.builds, 1);
  });
  await test('a revision change after final readiness prevents a stale commit', async () => {
    const f = fixture(), pending = f.run();await microtasks();f.admit();f.readiness[0].resolve();await microtasks();f.admit();
    f.readiness[1].resolve();queueMicrotask(() => f.setRevision('world-B'));assert.equal(await pending, false);f.hidden();
    assert.ok(f.context.deferredWorldPublication);const retry = f.run();await f.drain();assert.equal(await retry, true);assert.equal(f.captures.length, 1);
  });
  await test('capture failure quarantines partial products and never reruns a consumed producer', async () => {
    const f = fixture(), build = f.system.buildNext;f.system.buildNext = function () { build.call(this);throw Error('controlled build failure'); };
    assert.equal(await f.run(), false);f.hidden();assert.equal(f.captures[0].state, 'build-failed');assert.equal(f.jobs.length, 0);
    assert.equal(await f.run(), false);assert.equal(f.builds, 1);assert.equal(f.captures.length, 1);f.hidden();
  });
  await test('failed preparation preserves a longer cooldown and never substitutes finally for commit', async () => {
    const f = fixture();f.context.systemBuildResumeAt = 9000;f.context.compileFault = Error('controlled failure');
    const pending = f.run();await microtasks();f.admit();assert.equal(await pending, false);f.hidden();
    assert.equal(f.context.systemBuildResumeAt, 9000);assert.equal(f.context.deferredSystemBuildActive, false);
  });
  await test('a pending or failed habitat cannot capture nearest-body ownership before its publication commits', async () => {
    const f = fixture('hero-floating-city'), pending = f.run();await microtasks();
    const habitat = f.system.planets.find(body => body.type === 'artificialHabitat'), position = habitat.posUniv.clone(), before = position.clone();
    const nearest = load('nearestPublishedBody', f.context);
    assert.equal(nearest(f.system.planets, position), f.parent);assert.ok(position.equals(before));
    f.admit();f.readiness[0].reject(Error('controlled habitat preparation failure'));assert.equal(await pending, false);
    assert.equal(nearest(f.system.planets, position), f.parent);f.hidden();
    const retry = f.run();await f.drain();assert.equal(await retry, true);
    assert.equal(nearest(f.system.planets, position), habitat);assert.ok(position.equals(before));assert.equal(f.builds, 1);
  });
  await test('direct nondeferred visible bodies retain nearest-surface selection rather than nearest-center selection', () => {
    const nearest = load('nearestPublishedBody', {}), position = new THREE.Vector3(1, 2, 3), before = position.clone();
    const small = { posUniv: new THREE.Vector3(11, 2, 3), R: 1, group: new THREE.Group() };
    const large = { posUniv: new THREE.Vector3(31, 2, 3), R: 25, group: new THREE.Group() };
    assert.equal(nearest([small, large], position), large);assert.ok(position.equals(before));
    large.group.visible = false;assert.equal(nearest([small, large], position), small);assert.ok(position.equals(before));
  });
  await test('nearest published body returns null for empty or entirely hidden candidates without changing position', () => {
    const nearest = load('nearestPublishedBody', {}), position = new THREE.Vector3(3, 4, 5), before = position.clone();
    const hidden = { posUniv: position.clone(), R: 100, group: new THREE.Group() };hidden.group.visible = false;
    assert.equal(nearest([], position), null);assert.equal(nearest([hidden], position), null);assert.ok(position.equals(before));
  });
}

GLTFLoader.prototype.loadAsync = originalLoadAsync;
const failures = cases.filter(row => !row.passed), sourceStable = (await readMain()).equals(bytes)
  && (await readFile(new URL(import.meta.url))).equals(verifier)
  && (!publicationBytes || (await readFile('src/world-publication.js')).equals(publicationBytes));
const report = { passed: !failures.length && sourceStable, sourceStable, reference: reference || null,
  scope: 'Actual-main/capture CPU publication contracts; no GPU/image/cost acceptance', mainSha256: hash(bytes), verifierSha256: hash(verifier),
  worldPublicationSha256: publicationBytes ? hash(publicationBytes) : null, functions, counts: { passed: cases.length - failures.length, failed: failures.length }, cases };
await writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));console.log(JSON.stringify({ directory: out, passed: report.passed, sourceStable,
  counts: report.counts, failures: failures.map(row => ({ name: row.name, error: row.error })) }));if (!report.passed) process.exitCode = 1;
