import assert from 'node:assert/strict';
import { installColumnAdmissionProbe } from './column-admission-probe.js';

let passed = 0;
const test = (name, work) => { work(); passed++; };
function fixture(limit = 16) {
  let calls = 0, available = false, status = 8, external = 0;
  const sync = {}, query = {}, ticket = { sync, query, units: 2, estimatedMs: 3, record: { frame: 1 } };
  const gl = { ALREADY_SIGNALED: 8, CONDITION_SATISFIED: 9, QUERY_RESULT_AVAILABLE: 4,
    clientWaitSync(...args) { calls++; assert.equal(this, gl); assert.equal(args[0], sync); return status; },
    getQueryParameter(...args) { calls++; assert.equal(this, gl); assert.equal(args[0], query); return available; } };
  const budget = { gl, frame: 2, remainingMs: 6, frameUnits: 0, pending: [ticket],
    run(key, callback) { return { granted: 2, units: callback(2), reason: 'admitted', key, receiver: this }; },
    poll() { external++; if (gl.clientWaitSync(sync, 0, 0) === 8) return gl.getQueryParameter(query, 4); return 'waiting'; } };
  const originals = { run: budget.run, poll: budget.poll, wait: gl.clientWaitSync, query: gl.getQueryParameter };
  const probe = installColumnAdmissionProbe(budget, { limit, now: () => 7 });
  return { gl, budget, ticket, sync, query, originals, probe, get calls() { return calls; }, get polls() { return external; },
    set available(value) { available = value; }, set status(value) { status = value; } };
}
test('observation adds no native calls or polls and preserves return identity', () => {
  const f = fixture(), key = {}, result = f.budget.run(key, n => n);
  assert.equal(result.key, key); assert.equal(result.receiver, f.budget); assert.equal(f.calls, 0); assert.equal(f.polls, 0);
  assert.equal(f.probe.snapshot().runs[0].units, 2); f.probe.snapshot(); assert.equal(f.calls, 0); f.probe.restore();
});
test('signaled but unreadable timing is distinguished from pending GPU work', () => {
  const f = fixture(); assert.equal(f.budget.poll(), false); assert.equal(f.calls, 2);
  let s = f.probe.snapshot(); assert.equal(s.stats.completeFencesHeldForTiming, 1); assert.equal(s.events.length, 2);
  f.available = true; assert.equal(f.budget.poll(), true); assert.equal(f.calls, 4);
  s = f.probe.snapshot(); assert.equal(s.stats.queryPolls, 2); assert.equal(s.stats.completeFencesHeldForTiming, 1); f.probe.restore();
});
test('ordinary unsignaled fence is never called a timing hold', () => {
  const f = fixture(); f.status = 7; assert.equal(f.budget.poll(), 'waiting');
  assert.equal(f.calls, 1); assert.equal(f.probe.snapshot().stats.completeFencesHeldForTiming, 0); f.probe.restore();
});
test('measurement waiting after fence release does not count as held work', () => {
  const f = fixture(); f.probe.restore();
  f.budget.poll = function() {
    f.gl.clientWaitSync(f.sync, 0, 0); f.budget.pending = []; f.ticket.sync = null;
    f.budget.measurements = [f.ticket]; return f.gl.getQueryParameter(f.query, 4);
  };
  const p = installColumnAdmissionProbe(f.budget); f.budget.poll();
  assert.equal(p.snapshot().stats.completeFenceTimingUnavailable, 1);
  assert.equal(p.snapshot().stats.completeFencesHeldForTiming, 0); p.restore();
});
test('zero grant outcomes and their original reasons remain visible', () => {
  const f = fixture(); f.probe.restore();
  f.budget.run = (key, callback) => ({ granted: 0, units: callback(0), reason: 'in-flight-limit' });
  const p = installColumnAdmissionProbe(f.budget); f.budget.run({}, n => n);
  assert.equal(p.snapshot().stats.zero, 1); assert.equal(p.snapshot().runs[0].reason, 'in-flight-limit'); p.restore();
});
test('unrelated native calls outside budget poll are ignored', () => {
  const f = fixture(); f.gl.clientWaitSync(f.sync); f.gl.getQueryParameter(f.query, 4);
  assert.equal(f.calls, 2); assert.equal(f.probe.snapshot().events.length, 0); f.probe.restore();
});
test('borrowed methods preserve the original receiver and callback value', () => {
  const f = fixture(), other = {}, result = f.budget.run.call(other, {}, () => 1);
  assert.equal(result.receiver, other); assert.equal(result.units, 1); f.probe.restore();
});
test('callback throws preserve identity including falsy values', () => {
  for (const error of [new Error('expected'), null, 0]) {
    const f = fixture(); let caught = false;
    try { f.budget.run({}, () => { throw error; }); } catch (actual) { assert.equal(actual, error); caught = true; }
    assert.ok(caught); assert.equal(f.probe.snapshot().runs[0].error, String(error)); f.probe.restore();
  }
});
test('native throws do not trigger another native call or hide the exception', () => {
  const f = fixture(); f.probe.restore(); const error = new Error('native'); let calls = 0;
  f.gl.clientWaitSync = () => { calls++; throw error; };
  const p = installColumnAdmissionProbe(f.budget); assert.throws(() => f.budget.poll(), e => e === error);
  assert.equal(calls, 1); p.restore();
});
test('nested admissions retain both calls without changing their semantics', () => {
  const f = fixture(); const result = f.budget.run({}, () => f.budget.run({}, () => 1).units);
  assert.equal(result.units, 1); assert.equal(f.probe.snapshot().runs.length, 2); assert.equal(f.calls, 0); f.probe.restore();
});
test('record caps expose overflow without dropping counters', () => {
  const f = fixture(1); for (let i = 0; i < 3; i++) { f.budget.run({}, n => n); f.budget.poll(); }
  const s = f.probe.snapshot(); assert.equal(s.runs.length, 1); assert.equal(s.events.length, 1);
  assert.equal(s.dropped.runs, 2); assert.equal(s.dropped.events, 5); assert.equal(s.stats.runs, 3); assert.equal(f.calls, 6); f.probe.restore();
});
test('restore returns exact function identities and is idempotent', () => {
  const f = fixture(); f.probe.restore(); f.probe.restore(); assert.equal(f.probe.snapshot().restored, true);
  assert.equal(f.budget.run, f.originals.run); assert.equal(f.budget.poll, f.originals.poll);
  assert.equal(f.gl.clientWaitSync, f.originals.wait); assert.equal(f.gl.getQueryParameter, f.originals.query);
  const before = f.probe.snapshot(); f.budget.run({}, n => n); assert.deepEqual(f.probe.snapshot(), before);
});
test('restore never overwrites a later wrapper and deactivates retained wrappers', () => {
  const f = fixture(), installed = f.budget.run;
  const later = function(...args) { return installed.apply(this, args); }; f.budget.run = later;
  f.probe.restore(); assert.equal(f.budget.run, later); assert.equal(f.probe.snapshot().restored, false);
  assert.ok(f.probe.snapshot().faults.includes('Restore conflict: run'));
  f.budget.run({}, n => n); assert.equal(f.probe.snapshot().runs.length, 0);
});
test('late measurements survive budget history rotation without leaking mutable records', () => {
  const f = fixture(); f.probe.restore(); f.budget.records = [];
  f.budget.run = function(_key, submit) {
    this.records.push({ frame: this.frame++, gpuMs: null });
    return { granted: 1, units: submit(1), reason: 'admitted' };
  };
  const probe = installColumnAdmissionProbe(f.budget);
  f.budget.run({}, n => n); const first = f.budget.records[0];
  f.budget.run({}, n => n); f.budget.records.shift(); first.gpuMs = 205.087392;
  const snapshot = probe.snapshot(); assert.equal(snapshot.runs[0].measurement.gpuMs, 205.087392);
  snapshot.runs[0].measurement.gpuMs = 0;
  assert.equal(first.gpuMs, 205.087392); assert.equal(probe.snapshot().runs[0].measurement.gpuMs, 205.087392);
  assert.equal(f.calls, 0); probe.restore();
});

test('invalid limits fail before any wrapping', () => {
  const f = fixture(); f.probe.restore();
  for (const limit of [0, -1, .5, Infinity]) assert.throws(() => installColumnAdmissionProbe(f.budget, { limit }));
  assert.equal(f.budget.run, f.originals.run);
});
console.log(JSON.stringify({ passed: true, cases: passed,
  scope: 'CPU observer semantics, bounded capture and zero extra native calls only; no GPU or performance acceptance.' }));
