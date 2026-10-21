import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile('src/program-retirement.js', 'utf8');
function fixture({ khr = true, maxPolls = 2 } = {}) {
  let now = 0, id = 0, lost = false, queries = [], deletes = [], timerId = 0;
  const timers = new Map(), listeners = new Map();
  const canvas = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); } };
  const ext = { COMPLETION_STATUS_KHR: 1 };
  const gl = { getExtension: () => khr ? ext : null, isContextLost: () => lost,
    createProgram() { assert.equal(this, gl);return { id: ++id, ready: false, linked: false }; },
    linkProgram(p) { assert.equal(this, gl);p.linked = true;p.ready = false; },
    deleteProgram(p) { assert.equal(this, gl);deletes.push(p); },
    getProgramParameter(p, parameter) { assert.equal(this, gl);assert.equal(parameter, 1);queries.push(p);return p.ready; } };
  const original = { ...gl }, renderer = { getContext: () => gl, domElement: canvas, info: { programs: [] },
    dispose() { if (this.deleteOnDispose) gl.deleteProgram(this.deleteOnDispose); } };
  const install = vm.runInNewContext(`${source.replace('export function', 'function')}\ninstallProgramRetirement`, {
    performance: { now: () => now }, setTimeout(fn, ms) { timers.set(++timerId, { fn, at: now + ms });return timerId; }, clearTimeout: n => timers.delete(n),
  });
  const service = install(renderer, { maxPolls });
  return { gl, renderer, service, install, original, timers, listeners,
    get queries() { return queries; }, get deletes() { return deletes; },
    program() { const p = gl.createProgram();gl.linkProgram(p);return p; },
    tick() { now += 10;for (const [n, task] of [...timers]) if (task.at <= now) { timers.delete(n);task.fn(); } },
    lose() { lost = true;listeners.get('webglcontextlost')?.(); }, restore(enabled = khr) { lost = false;khr = enabled;listeners.get('webglcontextrestored')?.(); },
  };
}
{
  const f = fixture(), programs = Array.from({ length: 5 }, () => f.program());
  for (const p of programs) { f.gl.deleteProgram(p);f.gl.deleteProgram(p); }
  assert.equal(f.queries.length, 0, 'Bulk retirement must not issue inline GL queries');assert.equal(f.deletes.length, 0);
  assert.equal(f.service.snapshot().pending, 5);assert.equal(f.service.snapshot().queued, 5);
  programs.slice(2).forEach(p => { p.ready = true; });
  f.tick();assert.equal(f.queries.length, 2);f.tick();f.tick();
  assert.deepEqual(f.deletes.map(p => p.id).sort(), [3, 4, 5], 'Pending queue head must not starve later ready programs');
  programs[0].ready = programs[1].ready = true;f.tick();
  assert.equal(f.service.snapshot().pending, 0);assert.equal(f.timers.size, 0);
  f.gl.deleteProgram(programs[0]);assert.equal(f.queries.length, 8);assert.equal(f.deletes.length, 6);
  f.renderer.dispose();assert.equal(f.listeners.size, 0);assert.equal(f.gl.deleteProgram, f.original.deleteProgram);
}
{
  const f = fixture(), p = f.program();f.gl.deleteProgram(p);f.lose();
  assert.equal(f.service.snapshot().pending, 0);assert.equal(f.service.snapshot().abandonedOnLoss, 1);
  assert.equal(f.timers.size, 0);f.restore();const next = f.program();next.ready = true;f.gl.deleteProgram(next);f.tick();
  assert.deepEqual(f.queries, [next]);assert.deepEqual(f.deletes, [next]);f.renderer.dispose();
}
{
  const f = fixture(), p = f.program();f.gl.deleteProgram(p);f.renderer.dispose();
  assert.equal(f.service.snapshot().stopped, true);assert.equal(f.gl.createProgram, f.original.createProgram);
  assert.equal(f.service.snapshot().pending, 1);p.ready = true;f.tick();assert.deepEqual(f.deletes, [p]);assert.equal(f.listeners.size, 0);
}
{
  const f = fixture(), p = f.program();f.renderer.deleteOnDispose=p;f.renderer.dispose();
  assert.equal(f.service.snapshot().pending,1,'Renderer cleanup must execute before hooks are removed');
  p.ready=true;f.tick();assert.deepEqual(f.deletes,[p]);assert.equal(f.listeners.size,0);
}
{
  const f = fixture({ khr: false }), p = f.program(), unlinked = f.gl.createProgram(), unknown = {};
  f.gl.deleteProgram(p);f.gl.deleteProgram(unlinked);f.gl.deleteProgram(null);f.gl.deleteProgram(unknown);
  assert.equal(f.queries.length, 0);assert.deepEqual(f.deletes, [p, unlinked, null, unknown]);
  f.lose();f.restore(true);const next = f.program();next.ready = true;f.gl.deleteProgram(next);f.tick();
  assert.deepEqual(f.queries, [next]);f.renderer.dispose();
}
{
  const f = fixture(), p = f.program();f.gl.deleteProgram(p);p.ready = null;f.tick();
  assert.equal(f.service.snapshot().blocked, 1);assert.equal(f.service.snapshot().faults.length, 1);
  assert.equal(f.timers.size, 0);assert.equal(f.deletes.length, 0, 'An invalid status is not permission to delete');
  f.lose();f.renderer.dispose();assert.equal(f.listeners.size, 0);
}
{
  const f = fixture(), p = f.program();p.ready = true;f.gl.linkProgram(p);f.gl.deleteProgram(p);f.tick();
  assert.equal(f.deletes.length, 0, 'Relink must not reuse a former completed state');p.ready = true;f.tick();
  assert.equal(f.deletes.length, 1);assert.equal(f.install(f.renderer), f.service);f.renderer.dispose();
}
console.log('PASS: completion-aware renderer program retirement; zero inline queries, per-tick budget/fairness, repeated/null/untracked/no-KHR calls, context epochs, disposal drain and invalid-status quarantine.');
