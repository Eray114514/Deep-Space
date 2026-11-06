// Serialized before navigation. No GL query, fence, readback, flush or draw.
// The served main module attaches this before its first synchronous frame().
export function installFoundationFirstDrawProbe() {
  'use strict';
  const host = window, now = () => performance.now();
  host.__foundationFirstDrawProbe?.dispose?.();
  const state = { version: 1, limitMs: 120000, timeOrigin: performance.timeOrigin,
    installedAtMs: now(), attachedAtMs: null, readyObservedAtMs: null,
    startupEndedAtMs: null, disposed: false, restored: false, faults: [],
    counts: { submissions: 0, auxiliaryOnly: 0, blockedWorld: 0, failedSubmissions: 0,
      committedWorld: 0, readySubmissions: 0, volumeReturns: 0, cloudDrawReturns: 0 },
    firstWorld: null, firstCloudWorld: null, firstReadyWorld: null,
    firstReadyCloudWorld: null, firstPostCloudTaskAtMs: null,
    boundary: 'Navigation-relative CPU submission return and next event-loop task only. A world result requires its draw capability, committed frame sequence and successful outer submission; cloud result also requires a volume-scope cloud renderBufferDirect that increments the renderer CPU draw count. No GPU completion, display presentation, true input response or whole-session FPS acceptance.' };
  const bindings = [];
  let pipeline = null, active = null, inVolume = 0, readReady = null, task = null;
  const fault = error => { if (state.faults.length < 8) state.faults.push(String(error)); };
  const observe = work => { try { return work(); } catch (error) { fault(error); return undefined; } };
  const noteReady = () => { if (state.readyObservedAtMs === null) state.readyObservedAtMs = now(); };
  const isReady = () => {
    const ready = readReady?.() === true;
    if (ready) noteReady();
    return ready;
  };
  const wrap = (owner, key, make) => {
    const descriptor = Object.getOwnPropertyDescriptor(owner, key), original = owner[key];
    if (typeof original !== 'function') throw Error(`Missing first-draw observation method: ${key}`);
    const wrapper = make(original);
    Object.defineProperty(owner, key, descriptor ? { ...descriptor, value: wrapper }
      : { configurable: true, enumerable: true, writable: true, value: wrapper });
    bindings.push({ owner, key, descriptor, original, wrapper });
  };
  const finish = row => {
    if (state.disposed || state.startupEndedAtMs !== null) return;
    state.counts.committedWorld++;
    state.firstWorld ??= row;
    if (row.cloudDraws > 0) state.firstCloudWorld ??= row;
    if (row.readyAtStart) {
      state.firstReadyWorld ??= row;
      if (row.cloudDraws > 0 && !state.firstReadyCloudWorld) {
        state.firstReadyCloudWorld = row;
        task = host.setTimeout(() => {
          task = null;
          if (!state.disposed && state.startupEndedAtMs === null) state.firstPostCloudTaskAtMs = now();
        }, 0);
      }
    }
  };
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    if (task !== null) { host.clearTimeout(task); task = null; }
    let restored = true;
    for (const binding of bindings.reverse()) observe(() => {
      const { owner, key, descriptor, wrapper } = binding;
      if (owner[key] !== wrapper) { restored = false; fault(`Foreign replacement retained: ${key}`); return; }
      if (descriptor) Object.defineProperty(owner, key, descriptor);
      else delete owner[key];
    });
    state.restored = restored && state.faults.length === 0;
  };
  const attach = (owner, ready) => {
    if (pipeline || state.disposed) throw Error('First-draw probe attachment is one-shot');
    pipeline = owner; readReady = ready;
    const volume = owner.volumePass, renderer = owner.renderer;
    try {
      wrap(renderer, 'renderBufferDirect', original => function (...args) {
        const row = active, cloud = !!row && inVolume > 0
          && args[3]?.defines?.CLOUD_FAR_VIEW !== undefined;
        const calls = cloud ? renderer.info.render.calls : 0;
        const result = original.apply(this, args);
        if (cloud) observe(() => {
          const count = renderer.info.render.calls - calls;
          if (count > 0) { row.cloudDraws += count; state.counts.cloudDrawReturns += count; }
        });
        return result;
      });
      wrap(volume, 'render', original => function (...args) {
        const row = active;
        if (!row || this !== volume) return original.apply(this, args);
        inVolume++;
        try {
          const result = original.apply(this, args);
          observe(() => { row.volumeReturns++; state.counts.volumeReturns++; });
          return result;
        } finally { inVolume--; }
      });
      wrap(owner, 'submitFrame', original => function (work, ...args) {
        if (this !== owner || state.disposed || state.startupEndedAtMs !== null || typeof work !== 'function')
          return original.call(this, work, ...args);
        const row = { beginAtMs: now(), endedAtMs: null, readyAtStart: observe(isReady) === true,
          sequenceBefore: owner.frameState.sequence, sequenceAfter: null, worldDraws: 0,
          volumeReturns: 0, cloudDraws: 0, worldReturned: false };
        state.counts.submissions++;
        if (row.readyAtStart) state.counts.readySubmissions++;
        let completed = false;
        try {
          const result = original.call(this, function (draw, ...rest) {
            return work.call(this, function (...options) {
              row.worldDraws++;
              const previous = active; active = row;
              try { const rendered = draw.apply(this, options); row.worldReturned = rendered === true; return rendered; }
              finally { active = previous; }
            }, ...rest);
          }, ...args);
          completed = true;
          observe(() => {
            row.endedAtMs = now(); row.sequenceAfter = owner.frameState.sequence;
            if (!row.worldDraws) state.counts.auxiliaryOnly++;
            else if (row.worldReturned && row.sequenceAfter > row.sequenceBefore && result !== false) finish(row);
            else state.counts.blockedWorld++;
          });
          return result;
        } finally { if (!completed) state.counts.failedSubmissions++; }
      });
      state.attachedAtMs = now();
    } catch (error) { fault(error); dispose(); throw error; }
  };
  const snapshot = () => {
    const cloud = state.firstReadyCloudWorld, response = state.firstPostCloudTaskAtMs;
    const passed = state.attachedAtMs !== null && state.faults.length === 0
      && cloud !== null && cloud.endedAtMs <= state.limitMs
      && response !== null && response <= state.limitMs;
    return JSON.parse(JSON.stringify({ ...state, deadline: { limitMs: state.limitMs,
      scope: 'Ready-state actual cloud world submission plus subsequent event-loop task, measured from navigation timeOrigin',
      passed, firstReadyCloudReturnedAtMs: cloud?.endedAtMs ?? null,
      nextTaskAtMs: response, failure: passed ? null : !cloud ? 'no-ready-cloud-world'
        : cloud.endedAtMs > state.limitMs ? 'cloud-world-return-after-deadline'
          : response === null ? 'no-post-cloud-task' : response > state.limitMs ? 'post-cloud-task-after-deadline' : 'observer-fault' } }));
  };
  host.__foundationFirstDrawProbe = { attach, noteReady, snapshot, dispose,
    endStartup() { state.startupEndedAtMs ??= now(); return snapshot(); } };
}
