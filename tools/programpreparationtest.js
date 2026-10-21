import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile('src/program-preparation.js', 'utf8');
const vendor = await readFile('vendor/three.module.js', 'utf8');
const oldStart = vendor.indexOf('this.compileAsync = function ( scene, camera, targetScene = null ) {');
const oldEnd = vendor.indexOf('// Animation Loop', oldStart);
assert.ok(oldStart > 0 && oldEnd > oldStart);
const oldSource = vendor.slice(oldStart, oldEnd);
class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set());this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  emit(type) { for (const fn of [...this.listeners.get(type) || []]) fn(); }
  get count() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0); }
}
function fixture() {
  let now = 0, id = 0, queries = 0, submissions = 0, lost = false;
  const timers = new Map(), material = new Events(), canvas = new Events(), signal = new Events();
  const program = { program: {}, ready: false, isReady() { queries++;return this.ready; } };
  let records = new Map([[material, { programs: new Map([['a', program]]), currentProgram: program }]]);
  const registry = { has: m => records.has(m), get(m) { if (!records.has(m)) records.set(m, {});return records.get(m); } };
  const renderer = { domElement: canvas, properties: registry, getContext: () => ({ isContextLost: () => lost }),
    compile() { submissions++;return new Set([material]); } };
  const env = { performance: { now: () => now }, setTimeout(fn, ms) { timers.set(++id, { fn, at: now + ms });return id; },
    clearTimeout: n => timers.delete(n), properties: registry, extensions: { get: () => ({}) } };
  const compile = vm.runInNewContext(`${source.replace('export function', 'function')}\ncompilePrograms`, env);
  // Evaluate the real vendored method against the same clock and registry.
  const old = vm.runInNewContext(`(function(){${oldSource};return this.compileAsync;})`, env).call(renderer);
  const state = promise => { const value = { status: 'pending' };promise.then(v => { value.status = 'resolved';value.value = v; }, e => { value.status = 'rejected';value.error = e; });return value; };
  const tick = async (ms = 10) => {
    now += ms;
    for (const [n, task] of [...timers]) if (task.at <= now) { timers.delete(n);task.fn(); }
    await Promise.resolve();await Promise.resolve();
  };
  return { renderer, material, canvas, signal, program, registry, old, compile, state, tick, timers,
    get props() { return registry.get(material); }, get queries() { return queries; }, get submissions() { return submissions; },
    spend(ms) { now += ms; }, reset() { records = new Map(); }, lose(event = true) { lost = true;if (event) canvas.emit('webglcontextlost'); },
    clean() { assert.equal(timers.size, 0);assert.equal(material.count + canvas.count + signal.count, 0); } };
}

// Negative controls use the actual vendor polling method, not a recreation.
{
  const f = fixture(), old = f.state(f.old.call(f.renderer, 'old', {}));
  f.props.currentProgram = { program: {}, isReady: () => true };
  await f.tick();assert.equal(old.status, 'resolved');assert.equal(f.program.ready, false);
}
{
  const f = fixture(), old = f.state(f.old.call(f.renderer, 'old', {}));
  f.reset();f.material.emit('dispose');
  await f.tick(1000000);assert.equal(old.status, 'pending');assert.equal(f.timers.size, 1);
  f.timers.clear();
}
{
  const f = fixture(), retained = { program: {}, ready: false, isReady() { return this.ready; } };
  f.props.programs.set('retained-backface', retained);
  const result = f.state(f.compile(f.renderer, 'new', {}));
  f.props.currentProgram = { program: {}, isReady() { throw Error('Must not follow a later variant'); } };
  f.props.programs.set('later', f.props.currentProgram);
  f.program.ready = true;await f.tick();assert.equal(result.status, 'pending');
  retained.ready = true;await f.tick();assert.equal(result.status, 'resolved');assert.equal(result.value, 'new');f.clean();
  f.material.emit('dispose');assert.equal(result.status, 'resolved');
}
for (const [code, invalidate] of [
  ['material-disposed', f => f.material.emit('dispose')],
  ['aborted', f => { f.signal.aborted = true;f.signal.emit('abort'); }],
  ['context-lost', f => f.lose()],
  ['context-lost', f => f.lose(false)],
  ['program-released', f => { f.program.program = undefined; }],
  ['registry-reset', f => f.reset()],
  ['registry-reset', f => { f.reset();f.registry.get(f.material); }],
  ['registry-reset', f => { f.renderer.properties = { ...f.registry }; }],
]) {
  const f = fixture(), result = f.state(f.compile(f.renderer, {}, {}, null, { signal: f.signal }));
  invalidate(f);await f.tick();assert.equal(result.status, 'rejected');assert.equal(result.error.code, code);
  assert.equal(f.queries, 0, `${code} must be rejected before querying a stale program`);f.clean();
}
for (const code of ['aborted', 'context-lost']) {
  const f = fixture();if (code === 'aborted') f.signal.aborted = true;else f.lose(false);
  const result = f.state(f.compile(f.renderer, {}, {}, null, { signal: f.signal }));
  await f.tick();assert.equal(result.error.code, code);assert.equal(f.submissions, 0);f.clean();
}
for (const mode of ['never-ready', 'slow-compile', 'slow-query']) {
  const f = fixture();
  if (mode === 'slow-compile') f.renderer.compile = () => { f.spend(25);return new Set([f.material]); };
  if (mode === 'slow-query') f.program.isReady = () => { f.spend(25);return true; };
  if (mode === 'slow-query') f.props.programs.set('next', { program: {}, isReady() { assert.fail('Do not query another program after deadline'); } });
  const result = f.state(f.compile(f.renderer, {}, {}, null, { timeoutMs: 20 }));
  await f.tick();await f.tick();assert.equal(result.error.code, 'timeout');f.clean();
}
for (const mode of ['throw', 'null']) {
  const f = fixture();f.program.isReady = () => { if (mode === 'throw') throw Error('query fault');return null; };
  const result = f.state(f.compile(f.renderer, {}, {}));await f.tick();
  assert.equal(result.status, 'rejected');assert.match(result.error.message, mode === 'throw' ? /query fault/ : /query failed/);f.clean();
}
{
  const f = fixture();f.renderer.compile = () => { throw Error('sync failure'); };
  assert.throws(() => f.compile(f.renderer, {}, {}, null, { signal: f.signal }), /sync failure/);f.clean();
  for (const timeoutMs of [0, -1, Infinity, NaN]) assert.throws(() => f.compile(f.renderer, {}, {}, null, { timeoutMs }), /timeout/);
}
console.log('PASS: real vendor wrong-variant and disposed infinite-poll controls; captured retained variants; abort/context/material/registry/program guards; sync throws; slow submission/query deadlines; cleanup.');
