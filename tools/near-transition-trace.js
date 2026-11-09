// Passive timing. In particular, never issue extra native reflection queries.
export function installNearTransitionTrace(game, { onRestore } = {}) {
  const { _pipeline:pipeline, _renderer:renderer } = game;
  const gl = renderer.getContext(), manager = pipeline.cloudPrograms;
  const events = [], restore = [];
  const contextEvents = [], recentDraws = [];
  const started = performance.now();
  let scope = null, lastGate = null, firstNear = false, firstSweep = false, dropped = 0;
  function add(event) {
    if (events.length < 512) events.push(event);else dropped++;
  }
  function wrap(owner, name, handler) {
    const original = owner[name], own = Object.hasOwn(owner,name);
    const wrapper = function(...args) { return handler(original,this,args); };
    owner[name] = wrapper;
    restore.push(() => { if (owner[name] === wrapper) { if (own) owner[name] = original;else delete owner[name]; } });
  }
  const canvas = renderer.domElement;
  function recordContext(event) {
    const restored = event.type === 'webglcontextrestored';
    contextEvents.push({ type:event.type, at:performance.now(), status:event.statusMessage,
      sequence:pipeline.frameState.sequence, recentDraws:recentDraws.slice() });
    if (restored) onRestore?.();
  }
  for (const type of ['webglcontextlost','webglcontextrestored']) {
    canvas.addEventListener(type,recordContext,true);
    restore.push(() => canvas.removeEventListener(type,recordContext,true));
  }
  for (const name of ['linkProgram','getProgramParameter','getActiveUniform','getUniformLocation','drawElements','drawArrays']) {
    wrap(gl,name,(call,receiver,args) => {
      const at = performance.now();
      try { return call.apply(receiver,args); }
      finally {
        const ms = performance.now()-at;
        if (ms >= 30) add({ name, at, ms, scope, parameter:name==='getProgramParameter'?args[1]:null });
      }
    });
  }
  wrap(manager,'compile',(call,receiver,args) => {
    const material = args[1].material, prior = scope, at = performance.now();
    scope = { phase:'compile',material:material.id,far:material.defines.CLOUD_FAR_VIEW };
    try {
      const pending = call.apply(receiver,args), owner = scope;
      pending.then(() => add({ name:'prepared',at,ms:performance.now()-at,scope:owner }),
        error => add({ name:'preparation-error',at,ms:performance.now()-at,scope:owner,error:String(error) }));
      return pending;
    } finally { scope = prior; }
  });
  wrap(manager,'ensure',(call,receiver,args) => {
    const result = call.apply(receiver,args), snapshot = manager.snapshot();
    const key = `${snapshot.epoch}/${snapshot.pending}/${snapshot.ready}/${snapshot.prefetch?.state}/${result}`;
    if (key !== lastGate) { lastGate=key;add({ name:'gate',at:performance.now(),epoch:snapshot.epoch,
      pending:snapshot.pending,ready:snapshot.ready,prefetch:snapshot.prefetch,admitted:result }); }
    return result;
  });
  for (const owner of [pipeline,pipeline.volumePass]) wrap(owner,'profilePhase',(call,receiver,args) => {
    const prior = scope;
    scope = { phase:args[0] };
    try { return call.apply(receiver,args); } finally { scope = prior; }
  });
  wrap(renderer,'renderBufferDirect',(call,receiver,args) => {
    const material = args[3], near = material === pipeline.volumePass.activePlanet?.volCloudMat;
    const at = performance.now(), prior = scope;
    scope = { phase:near?'near-draw':'draw',material:material.id, materialName:material.name || null,
      objectName:args[4].name || null, pass:prior?.phase ?? null };
    const sweep = prior?.phase === 'cloud-cache' && material.uniforms?.uCacheBoundary;
    try { return call.apply(receiver,args); }
    finally {
      const ms = performance.now()-at;
      recentDraws.push({at,ms,scope});
      if (recentDraws.length>16) recentDraws.shift();
      if (ms >= 30 || near&&!firstNear) add({ name:'renderBufferDirect',at,ms,scope });
      if (near) firstNear=true;
      if (sweep&&!firstSweep) {
        const lease=pipeline.cloudLightPrograms.sweep;
        const active=renderer.properties.get(material).currentProgram;
        const prepared=lease&&renderer.properties.get(lease).currentProgram;
        add({name:'first-light-sweep',at,ms,scope,preparedProgramReused:!!prepared&&prepared===active,
          preparation:pipeline.cloudLightPreparation?.state});
        firstSweep=true;
      }
      scope=prior;
    }
  });
  return { finish() { for (const undo of restore.reverse()) undo();return { started, events, dropped, contextEvents }; } };
}
