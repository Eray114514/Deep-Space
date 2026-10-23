// Observe existing admission/native calls only. No query, poll, wait or snapshot
// is added to the measured path. All records and overflow counts are bounded.
export function installColumnAdmissionProbe(budget, { limit = 16384, now = () => performance.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || typeof now !== 'function') throw new TypeError('Invalid admission probe');
  const gl = budget.gl, identities = new WeakMap(), signaledQueries = new WeakSet();
  const data = { runs: [], events: [], faults: [], dropped: { runs: 0, events: 0, faults: 0 },
    stats: { runs: 0, zero: 0, fencePolls: 0, signaled: 0, queryPolls: 0, timingUnavailable: 0,
      completeFenceTimingUnavailable: 0, completeFencesHeldForTiming: 0 }, restored: false };
  let nextId = 0, pollDepth = 0, active = true;
  const id = value => {
    if (!value || !['object', 'function'].includes(typeof value)) return null;
    if (!identities.has(value)) identities.set(value, ++nextId);
    return identities.get(value);
  };
  const push = (kind, value) => {
    if (data[kind].length < limit) data[kind].push(value); else data.dropped[kind]++;
  };
  const observe = work => {
    if (!active) return;
    try { work(); } catch (error) { push('faults', String(error)); }
  };
  const items = () => [...(budget.pending || []), ...(budget.measurements || [])];
  const state = () => ({ frame: budget.frame, remainingMs: budget.remainingMs, frameUnits: budget.frameUnits,
    pending: (budget.pending || []).length, measurements: (budget.measurements || []).length,
    tickets: items().map(item => ({ id: id(item), frame: item.record?.frame, units: item.units,
      estimatedMs: item.estimatedMs, fence: Boolean(item.sync), query: Boolean(item.query) })) });
  const replace = (owner, name, wrap) => {
    const original = owner[name], wrapped = wrap(original); owner[name] = wrapped;
    return () => {
      if (owner[name] === wrapped) { owner[name] = original; return true; }
      push('faults', `Restore conflict: ${name}`); return false;
    };
  };
  const restores = [];
  try {
    restores.push(replace(gl, 'clientWaitSync', original => function(...args) {
      const result = original.apply(this, args);
      observe(() => {
        if (!pollDepth) return;
        const item = items().find(item => item.sync === args[0]); if (!item) return;
        const signaled = result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED;
        data.stats.fencePolls++; if (signaled) { data.stats.signaled++; if (item.query) signaledQueries.add(item.query); }
        push('events', { atMs: now(), frame: budget.frame, kind: 'fence', ticket: id(item), submittedFrame: item.record?.frame, signaled, result });
      });
      return result;
    }));
    restores.push(replace(gl, 'getQueryParameter', original => function(...args) {
      const result = original.apply(this, args);
      observe(() => {
        if (!pollDepth || args[1] !== gl.QUERY_RESULT_AVAILABLE) return;
        const item = items().find(item => item.query === args[0]); if (!item) return;
        const complete = signaledQueries.has(args[0]), held = complete && Boolean(item.sync) && budget.pending.includes(item);
        data.stats.queryPolls++;
        if (!result) {
          data.stats.timingUnavailable++;
          if (complete) data.stats.completeFenceTimingUnavailable++;
          if (held) data.stats.completeFencesHeldForTiming++;
        }
        push('events', { atMs: now(), frame: budget.frame, kind: 'query-available', ticket: id(item),
          submittedFrame: item.record?.frame, available: Boolean(result), fenceComplete: complete, holdsFence: held });
      });
      return result;
    }));
    restores.push(replace(budget, 'poll', original => function(...args) {
      pollDepth++;
      try { return original.apply(this, args); } finally { pollDepth--; }
    }));
    restores.push(replace(budget, 'run', original => function(...args) {
      let before, started, result, error, recordBefore, threw = false;
      observe(() => { before = state(); started = now(); recordBefore = budget.records?.at(-1); });
      try { result = original.apply(this, args); return result; }
      catch (caught) { threw = true; error = caught; throw caught; }
      finally {
        observe(() => {
          data.stats.runs++; if (result?.granted === 0) data.stats.zero++;
          const record=budget.records?.at(-1);
          push('runs', { atMs: started, endMs: now(), key: id(args[0]), phase: args[0]?.phase ?? null, before, after: state(),
            granted: result?.granted ?? null, units: result?.units ?? null, reason: result?.reason ?? null,
            measurement: record&&record!==recordBefore?record:null,
            error: threw ? String(error) : null });
        });
      }
    }));
  } catch (error) { active = false; for (const restore of restores.reverse()) restore(); throw error; }
  return {
    snapshot() { return { ...data, runs: data.runs.map(run=>({...run,measurement:run.measurement?{...run.measurement}:null})), events: data.events.slice(), faults: data.faults.slice(),
      stats: { ...data.stats }, dropped: { ...data.dropped } }; },
    restore() {
      if (!active) return; active = false;
      data.restored = restores.reverse().map(restore => restore()).every(Boolean);
    },
  };
}
