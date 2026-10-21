const owners = new WeakMap();

// Own the last native deletion on this renderer's context. Chromium can keep
// an automatic KHR completion query after Three has released its program. A
// ready JS shader/draw does not prove that query has finished. Retain the native
// handle until COMPLETION_STATUS_KHR, without changing shaders or forcing link.
// This adapter owns renderer-created programs; it is not a general WebGL proxy.
export function installProgramRetirement(renderer, { pollMs = 10, maxPolls = 8 } = {}) {
  if (owners.has(renderer)) return owners.get(renderer);
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isInteger(maxPolls) || maxPolls < 1)
    throw new RangeError('Invalid program retirement poll budget');
  const gl = renderer.getContext(), canvas = renderer.domElement;
  const native = Object.fromEntries(['createProgram', 'linkProgram', 'deleteProgram', 'getProgramParameter']
    .map(name => [name, gl[name]]));
  const records = new WeakMap(), pending = new Map(), faults = [];
  let ext = gl.getExtension('KHR_parallel_shader_compile'), timer = null, stopped = false;
  let epoch = 0, polls = 0, queued = 0, nativeDeletes = 0, peak = 0, abandonedOnLoss = 0, pollable = 0;
  const own = (program, linked = false) => { if (program) records.set(program, { linked, retired: false, deleted: false, blocked: false, epoch }); };
  for (const program of renderer.info?.programs || []) own(program.program, true);
  const fault = (record, cause) => {
    if (!record.blocked && pending.has(record.program)) pollable--;
    record.blocked = true;
    if (faults.length < 8) faults.push(String(cause).slice(0, 1000));
  };
  const cleanup = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    canvas.removeEventListener('webglcontextrestored', onRestored);
  };
  const schedule = () => {
    if (timer === null && pollable > 0) timer = setTimeout(poll, pollMs);
    else if (stopped && !pending.size) cleanup();
  };
  const destroy = (program, record) => {
    native.deleteProgram.call(gl, program);record.deleted = true;
    if (pending.delete(program) && !record.blocked) pollable--;
    nativeDeletes++;
  };
  const ready = (program, record) => {
    polls++;
    const value = native.getProgramParameter.call(gl, program, ext.COMPLETION_STATUS_KHR);
    if (typeof value !== 'boolean') {
      fault(record, 'Program retirement completion query failed');return false;
    }
    return value;
  };
  function poll() {
    timer = null;
    if (gl.isContextLost()) { onLost();return; }
    let remaining = Math.min(maxPolls, pending.size);
    while (remaining-- > 0 && pending.size) {
      const [program, record] = pending.entries().next().value;
      // Round robin: one slow program must not pin later completed programs.
      pending.delete(program);pending.set(program, record);
      if (record.blocked) continue;
      try {
        const complete = ready(program, record);
        if (record.epoch !== epoch || gl.isContextLost()) break;
        if (complete) destroy(program, record);
      }
      catch (cause) { fault(record, cause); }
    }
    schedule();
  }
  function onLost() {
    epoch++;abandonedOnLoss += pending.size;pending.clear();pollable = 0;clearTimeout(timer);timer = null;
    if (stopped) cleanup();
  }
  function onRestored() { ext = gl.getExtension('KHR_parallel_shader_compile'); }
  const wrappers = {
    createProgram(...args) { const program = native.createProgram.apply(this, args);if (this === gl) own(program);return program; },
    linkProgram(program, ...args) {
      const result = native.linkProgram.call(this, program, ...args), record = records.get(program);
      if (this === gl && record && !record.retired && !record.deleted) record.linked = true;
      return result;
    },
    deleteProgram(program) {
      const record = records.get(program);
      // Preserve null/untracked/repeated native calls. Never query invalid or
      // already deleted handles merely to decide how they should be deleted.
      if (this !== gl || !record || record.deleted || record.epoch !== epoch)
        return native.deleteProgram.call(this, program);
      if (record.retired) return;
      if (!record.linked || !ext || gl.isContextLost()) {
        const result = native.deleteProgram.call(this, program);record.deleted = true;return result;
      }
      record.retired = true;
      record.program = program;record.retiredAt = performance.now();pending.set(program, record);
      pollable++;queued++;peak = Math.max(peak, pending.size);schedule();
    },
  };
  const descriptors = new Map();
  for (const [name, wrapper] of Object.entries(wrappers)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(gl, name));
    Object.defineProperty(gl, name, { configurable: true, writable: true, value: wrapper });
  }
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onRestored);
  const dispose = renderer.dispose;
  const api = {
    snapshot() {
      let oldestMs = 0;for (const record of pending.values()) oldestMs = Math.max(oldestMs, performance.now() - record.retiredAt);
      return { supported: Boolean(ext), pending: pending.size, peak, polls, queued, nativeDeletes, abandonedOnLoss,
        oldestMs, blocked: pending.size - pollable, stopped, faults: [...faults] };
    },
  };
  renderer.dispose = function(...args) {
    try { return dispose.apply(this, args); }
    finally {
      stopped = true;
      for (const [name, descriptor] of descriptors) if (gl[name] === wrappers[name]) {
        if (descriptor) Object.defineProperty(gl, name, descriptor);else delete gl[name];
      }
      // Teardown cannot turn pending native programs into unsafe deletes.
      // Only this bounded-work poll survives until completion or context loss.
      schedule();
    }
  };
  owners.set(renderer, api);return api;
}
