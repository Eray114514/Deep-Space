import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';

// Measure the three actual Far draws in natural weather after a complete
// column pair has published. The outer phase timer is bypassed on these
// frames so its query cannot overlap the per-draw queries.
export async function measureLiveFarStages(game) {
  const pass = game._pipeline.volumePass, split = pass.farSplit, renderer = game._renderer;
  const gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer) throw Error('Far stage timing requires WebGL GPU timers');
  const epoch = readGpuDisjointEpoch(gl,timer), stages = ['point','cached','combine'];
  const originalRender = renderer.render, profile = pass.profilePhase;
  const rows = [], queries = [], dimensions = [pass.width,pass.height];
  let active, deadline;

  function timedRender(scene,camera) {
    const material = split.plan?.mesh.material;
    const stage = active && stages.find(name => material === split.materials[name]);
    if (!stage) return originalRender.call(this,scene,camera);
    if (gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)) throw Error('Another GPU timer is active');
    const query = gl.createQuery();
    if (!query) throw Error('Could not create Far stage query');
    queries.push(query);
    active.queries[stage] = query;
    gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    try { return originalRender.call(this,scene,camera); }
    finally { if (!gl.isContextLost()) gl.endQuery(timer.TIME_ELAPSED_EXT); }
  }

  try {
    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Timed out waiting for six mixed Far frames')),45000);
      renderer.render = timedRender;
      pass.profilePhase = function(name,work,options) {
        if (name !== 'volume-current' || split.lastRoute !== 'combine' || !split.plan
          || split.plan.cachedOnly || split.plan.material.uniforms.uColumnsReady.value < .5 || rows.length >= 6)
          return profile.call(this,name,work,options);
        const row = {frame:pass.frame,hours:pass.activePlanet.weatherHours,queries:{}};
        active = row;
        try {
          const result = work();
          if (!stages.every(stage => row.queries[stage])) throw Error('Far mixed frame changed route during timing');
          rows.push(row);
          if (rows.length === 6) resolve();
          return result;
        } catch(error) { reject(error);throw error; }
        finally { active = null; }
      };
    });
    renderer.render = originalRender;
    pass.profilePhase = profile;
    const end = performance.now()+30000;
    while (queries.some(query => !gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
      if (performance.now()>end || gl.isContextLost()) throw Error('Far stage timing did not complete on the live context');
      await new Promise(resolve => setTimeout(resolve,20));
    }
    if (readGpuDisjointEpoch(gl,timer) !== epoch) throw Error('Far stage timing became disjoint');
    return {dimensions,gl:gl.getError(),lost:gl.isContextLost(),
      rows:rows.map(({queries:timings,...row}) => ({...row,gpuMs:Object.fromEntries(stages.map(stage => [
        stage,gl.getQueryParameter(timings[stage],gl.QUERY_RESULT)/1e6,
      ]))}))};
  } finally {
    clearTimeout(deadline);
    renderer.render = originalRender;
    pass.profilePhase = profile;
    if (!gl.isContextLost()) for (const query of queries) gl.deleteQuery(query);
  }
}
