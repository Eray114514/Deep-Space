import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';

// Pair the old and current payloads inside one real volume frame, with the
// production depth, meshes, atmosphere and column endpoints held constant.
export async function compareLiveCloudPayloads(game) {
  const pipeline = game._pipeline, pass = pipeline.volumePass, renderer = game._renderer;
  const { farSplit:split, scene, camera, current } = pass;
  const materials = split.materials, source = new game._THREE.Group(), full = {};
  const gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const mesh = pass.activePlanet.volCloudMesh;
  const mask = {
    point:'          if(uColumnsReady>0.5 && rayCone*t0>2400.0)discard;\n',
    cached:'          if(uColumnsReady<=0.5 || rayCone*t0<=900.0)discard;\n',
  };
  const queries = [], results = [], state = { pairs:[], dimensions:[pass.width,pass.height] };
  const profile = pass.profilePhase;
  let hook, deadline;
  try {
    for (const stage of ['point','cached']) {
      const original = materials[stage];
      if (!original.fragmentShader.includes(mask[stage])) throw Error('Live comparison needs the masked payload');
      const material = new game._THREE.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
      material.fragmentShader = original.fragmentShader.replace(mask[stage],'');
      Object.assign(material.uniforms,original.uniforms);
      full[stage] = material;
      const proxy = new game._THREE.Mesh(mesh.geometry,material);
      proxy.layers.set(VOLUME_LAYER);source.add(proxy);
    }
    const prepareAt = performance.now();
    await pipeline.prepare(() => {
      const target = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      try {
        renderer.setRenderTarget(current);
        return compilePrograms(renderer,source,createCompileCamera(camera,VOLUME_LAYER),scene);
      } finally { renderer.setRenderTarget(target,face,mip); }
    }, { label:'compare-full-cloud-payloads' });
    state.prepareMs = performance.now()-prepareAt;
    const disjointEpoch = readGpuDisjointEpoch(gl,timer);
    function draw(useFull, timed) {
      const frames = split.frames, route = split.lastRoute;
      const query = timed && timer && !gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY) ? gl.createQuery() : null;
      if (query) { queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query); }
      if (useFull) split.materials = { ...materials,...full };
      try {
        renderer.setRenderTarget(current);renderer.clear(true,false,false);
        if (!split.render(scene,camera,current,pass.columnMaps.get(pass.activePlanet))) throw Error('Live comparison lost split plan');
      } finally {
        split.materials = materials;split.frames = frames;split.lastRoute = route;
        if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
      }
      return query;
    }
    function read() {
      const result = new Uint16Array(pass.width*pass.height*4);
      renderer.readRenderTargetPixels(current,0,0,pass.width,pass.height,result);
      return result;
    }
    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Live paired volume comparison did not receive four mixed frames')),30000);
      hook = function(name,work,options) {
        const value = profile.call(this,name,work,options);
        if (name !== 'volume-current' || split.lastRoute !== 'combine' || !split.plan || state.pairs.length >= 4) return value;
        try {
          if (split.materials !== materials || pass.current !== current) throw Error('Live comparison resources changed');
          const firstPair = state.pairs.length === 0, order = state.pairs.length%2 ? ['masked','full'] : ['full','masked'];
          const row = { order, weatherHours:pass.activePlanet.weatherHours, frame:pass.frame, queries:{}, changed:null, maximumError:null };
          const pixels = {};
          for (const variant of order) {
            row.queries[variant] = draw(variant==='full',!firstPair);
            if (firstPair) pixels[variant] = read();
          }
          if (firstPair) {
            row.changed = 0;row.maximumError = 0;
            const half = game._THREE.DataUtils.fromHalfFloat;
            for (let i=0;i<pixels.full.length;i++) if (pixels.full[i] !== pixels.masked[i]) {
              row.changed++;
              row.maximumError = Math.max(row.maximumError,Math.abs(half(pixels.full[i])-half(pixels.masked[i])));
            }
          }
          if (order.at(-1) === 'full') draw(false,false);
          state.pairs.push(row);
          if (state.pairs.length === 4) resolve();
        } catch(error) { reject(error);throw error; }
        return value;
      };
      pass.profilePhase = hook;
    });
    pass.profilePhase = profile;
    const end = performance.now()+30000;
    while (queries.some(query => !gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
      if (performance.now()>end) throw Error('Live paired GPU timing expired');
      await new Promise(resolve => setTimeout(resolve,20));
    }
    const disjoint = readGpuDisjointEpoch(gl,timer) !== disjointEpoch;
    for (const row of state.pairs) {
      const gpuMs = Object.fromEntries(Object.entries(row.queries).map(([name,query])=>[
        name,query&&!disjoint?gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6:null,
      ]));
      const { queries:unused, ...values } = row;
      results.push({ ...values,gpuMs });
    }
    return { ...state,pairs:results,gl:gl.getError(),disjoint:!!disjoint };
  } finally {
    clearTimeout(deadline);
    if (pass.profilePhase === hook) pass.profilePhase = profile;
    for (const query of queries) gl.deleteQuery(query);
    for (const material of Object.values(full)) material.dispose();
  }
}
