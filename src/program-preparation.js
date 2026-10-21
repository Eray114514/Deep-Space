// WebGL2 adapter for the vendored renderer. compile() returns materials, not
// programs; each material retains a Map of variants (including DoubleSide and
// instanced variants). Wait on that conservative superset captured at submission,
// never on a later frame's mutable currentProgram. This is not a draw warm-up.
export function compilePrograms(renderer, source, camera, targetScene = null, {
  signal, timeoutMs = 120000,
} = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError('Invalid shader preparation timeout');
  const started = performance.now(), canvas = renderer.domElement, registry = renderer.properties;
  const materials = new Map(), programs = new Set();
  let timer = null, finish = null, failure = null;
  const error = (code, message) => Object.assign(new Error(message), { code });
  const cleanup = () => {
    clearTimeout(timer);timer = null;
    signal?.removeEventListener('abort', onAbort);
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const material of materials.keys()) material.removeEventListener('dispose', onDispose);
    materials.clear();programs.clear();
  };
  const fail = reason => { failure ||= reason;finish?.(failure); };
  const onAbort = () => fail(error('aborted', 'Shader preparation cancelled'));
  const onLost = () => fail(error('context-lost', 'Shader preparation context lost'));
  const onDispose = () => fail(error('material-disposed', 'Shader preparation material disposed'));
  if (signal?.aborted) return Promise.reject(error('aborted', 'Shader preparation cancelled'));
  if (renderer.getContext().isContextLost()) return Promise.reject(error('context-lost', 'Shader preparation context lost'));
  signal?.addEventListener('abort', onAbort);
  canvas.addEventListener('webglcontextlost', onLost);
  try {
    for (const material of renderer.compile(source, camera, targetScene)) {
      material.addEventListener('dispose', onDispose);
      const properties = registry.get(material);
      materials.set(material, properties);
      for (const program of properties.programs?.values() || []) programs.add(program);
      if (properties.currentProgram) programs.add(properties.currentProgram);
      if (!properties.currentProgram) throw error('program-missing', 'Shader preparation produced no current program');
    }
  } catch (cause) {
    cleanup();throw cause;
  }
  return new Promise((resolve, reject) => {
    finish = reason => {
      if (!finish) return;
      finish = null;cleanup();
      if (reason) reject(reason);else resolve(source);
    };
    const check = () => {
      timer = null;
      try {
        if (failure) { finish(failure);return; }
        if (renderer.getContext().isContextLost()) { onLost();return; }
        for (const [material, properties] of materials) {
          if (renderer.properties !== registry || !registry.has(material) || registry.get(material) !== properties) {
            finish(error('registry-reset', 'Shader preparation registry reset'));return;
          }
        }
        const remaining = timeoutMs - (performance.now() - started);
        if (remaining <= 0) {
          finish(error('timeout', 'Shader preparation deadline exceeded'));return;
        }
        for (const program of programs) {
          if (performance.now() - started >= timeoutMs) {
            finish(error('timeout', 'Shader preparation deadline exceeded'));return;
          }
          // destroy() clears this public handle but isReady() retains the old
          // native handle in its closure. Never query it after release.
          if (!program.program) {
            finish(error('program-released', 'Shader preparation program released'));return;
          }
          const ready = program.isReady();
          if (!finish) return;
          if (performance.now() - started >= timeoutMs) {
            finish(error('timeout', 'Shader preparation deadline exceeded'));return;
          }
          if (typeof ready !== 'boolean') {
            finish(error('program-query-failed', 'Shader preparation readiness query failed'));return;
          }
          if (ready) programs.delete(program);
        }
        if (!programs.size) { finish();return; }
        timer = setTimeout(check, Math.min(10, remaining));
      } catch (cause) { finish(cause); }
    };
    // Yield as compileAsync did. Without KHR the vendor reports readiness
    // immediately, without verifying link completion. Neither mode warms draws.
    // The deadline bounds JS polling, not synchronous driver calls.
    if (failure) finish(failure);
    else timer = setTimeout(check, Math.min(10, timeoutMs));
  });
}
