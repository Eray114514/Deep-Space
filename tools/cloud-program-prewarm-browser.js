// Diagnostic only. Submit the unchanged near-cloud program while the player
// remains in orbit, then verify that the actual near draw reuses that program.
export async function probeCloudProgramPrewarm({ timeoutMs = 120000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Positive preparation deadline required');
  const T = NMS._THREE, renderer = NMS._renderer;
  const planet = NMS._planet(0), pass = NMS._pipeline.volumePass;
  const material = planet?.volCloudMat;
  if (!material || !pass) throw new Error('Near cloud owner missing');
  const gl = renderer.getContext();
  if (!gl.getExtension('KHR_parallel_shader_compile')) throw new Error('Parallel compile extension required');
  const camera = NMS._internals.camera.clone();
  camera.layers.set(2);
  const group = new T.Group();
  const mesh = new T.Mesh(planet.volCloudMesh.geometry, material);
  mesh.layers.set(2); group.add(mesh);
  const savedTarget = renderer.getRenderTarget();
  const savedFace = renderer.getActiveCubeFace(), savedMip = renderer.getActiveMipmapLevel();
  const version = material.version, started = performance.now();
  const state = { stage: 'created', startedAtMs: started, timeoutMs, materialVersion: version,
    polls: 0, ticks: 0, maximumHeartbeatGapMs: 0, targetRestored: false, observerRestored: false };
  window.__foundationCloudPrewarm = state;
  let disposed = false, last = started, maximumHeartbeatGapMs = 0, ticks = 0;
  const onDispose = () => { disposed = true; };
  const heartbeat = setInterval(() => {
    const now = performance.now(); maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, now - last);
    last = now; ticks++;state.ticks = ticks;state.maximumHeartbeatGapMs = maximumHeartbeatGapMs;
  }, 20);
  material.addEventListener('dispose', onDispose);
  try {
    window.__foundationGLProbe?.mark('parallel-near-submit');
    state.stage = 'submit';
    const submitStart = performance.now();
    try {
      renderer.setRenderTarget(pass.current);
      renderer.compile(group, camera, NMS._internals.scene);
    } finally { renderer.setRenderTarget(savedTarget, savedFace, savedMip);state.targetRestored = true; }
    const submitMs = performance.now() - submitStart;
    state.submitMs = submitMs;state.stage = 'poll';
    const program = renderer.properties.get(material).currentProgram;
    if (!program?.program) throw new Error('Submitted near program missing');
    window.__foundationPrewarmProgram = program;
    state.programId = program.id;
    let polls = 0;
    for (;;) {
      if (disposed || material.version !== version) throw new Error('Near material changed during preparation');
      if (gl.isContextLost()) throw new Error('Context lost during preparation');
      if (performance.now() - started > timeoutMs) throw new Error('Parallel cloud preparation deadline exceeded');
      polls++;
      state.polls = polls;
      if (program.isReady()) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, performance.now() - last);
    const result = { submitMs, wallMs: performance.now() - started, polls, ticks,
      maximumHeartbeatGapMs, materialVersion: version, programId: program.id,
      reusedBeforePlacement: renderer.properties.get(material).currentProgram === program,
      geometryShared: mesh.geometry === planet.volCloudMesh.geometry,
      boundary: 'Unchanged program prepared before diagnostic teleport; not runtime integration or total cold-cost reduction.' };
    window.__foundationGLProbe?.mark('parallel-near-ready');
    state.stage = 'ready';
    return result;
  } catch (error) {
    state.stage = 'failed';state.error = String(error);throw error;
  } finally {
    clearInterval(heartbeat);material.removeEventListener('dispose', onDispose);group.clear();
    state.wallMs = performance.now() - started;
    state.maximumHeartbeatGapMs = Math.max(maximumHeartbeatGapMs, performance.now() - last);
    state.observerRestored = true;
  }
}
