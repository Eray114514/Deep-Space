import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { cloudNearSplitShaders } from './cloud-near-split-shaders.js';

export async function compareLiveNearCloud(game) {
  const T = game._THREE, renderer = game._renderer, pipeline = game._pipeline;
  const pass = pipeline.volumePass, {scene, camera, current} = pass;
  const planet = pass.activePlanet, mesh = planet.volCloudMesh, original = planet.volCloudMat;
  const gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer || gl.getParameter(gl.MAX_DRAW_BUFFERS) < 5 || gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) < 5
    || !renderer.extensions.has('EXT_color_buffer_float')) throw Error('Near comparison requires GPU timers and five float attachments');
  const {width,height} = current;
  const shaders = cloudNearSplitShaders(original.fragmentShader);
  const scratch = new T.WebGLRenderTarget(width,height,{type:T.FloatType,count:5,depthBuffer:false,
    minFilter:T.NearestFilter,magFilter:T.NearestFilter});
  scratch.textures[4].format = T.RedFormat;
  const make = fragmentShader => {
    const material = new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
    material.fragmentShader = fragmentShader;
    Object.assign(material.uniforms,original.uniforms);
    return material;
  };
  const density = make(shaders.density), light = make(shaders.light);
  density.glslVersion = T.GLSL3;
  density.blending = T.NoBlending;
  shaders.names.forEach((name,index) => { light.uniforms[name] = {value:scratch.textures[index]}; });
  const profile = pass.profilePhase, queries = [], altitude = 90000;
  const pose = {altitude,rows:[]}, poses = [pose];
  const observation = window.__nearLivePair = {dimensions:[width,height],poses};
  let hook, deadline;
  try {
    const coast = game.setWade(0,{depth:.9,overview:true});
    if (!coast?.direction || !coast?.landward) throw Error('Missing near comparison coast');
    game.setTimeFrozen();
    game.setContinuousAtmosphereAltitude(0,altitude,{dir:coast.direction,forward:coast.landward,pitch:-1.15});
    observation.sun = game.setLocalSunAltitude(0,35,{azimuthHint:coast.landward});
    const prepareAt = performance.now();
    const compileCamera = createCompileCamera(camera,VOLUME_LAYER);
    await pipeline.prepare(async () => {
      const compiling = [[density,scratch],[light,current]].map(([material,target]) => {
        const proxy = new T.Mesh(mesh.geometry,material);
        proxy.layers.set(VOLUME_LAYER);
        const previous = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
        try {
          renderer.setRenderTarget(target);
          return compilePrograms(renderer,proxy,compileCamera,scene);
        } finally { renderer.setRenderTarget(previous,face,mip); }
      });
      await Promise.all(compiling);
    },{label:'compare-live-near-transport'});
    const prepareMs = observation.prepareMs = performance.now()-prepareAt;
    const epoch = readGpuDisjointEpoch(gl,timer);
    const uniforms = original.uniforms;
    function verifyGL(phase) {
      const error = gl.getError();
      if (error) throw Error(`Near comparison GL ${error} at ${phase}`);
    }

    function draw(material,target) {
      mesh.material = material;
      renderer.setRenderTarget(target);
      renderer.clear(true,false,false);
      material.uniformsNeedUpdate = true;
      renderer.render(scene,camera);
    }

    function render(split,timed) {
      let query = null;
      if (timed) {
        if (gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)) throw Error('GPU timer already active');
        query = gl.createQuery();
        queries.push(query);
        gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
      }
      const autoClear = renderer.autoClear;
      renderer.autoClear = false;
      try {
        if (split) draw(density,scratch);
        draw(split?light:original,current);
      } finally {
        mesh.material = original;
        renderer.setRenderTarget(current);
        renderer.autoClear = autoClear;
        if (query) gl.endQuery(timer.TIME_ELAPSED_EXT);
      }
      return query;
    }

    function read() {
      const pixels = new Uint16Array(width*height*4);
      renderer.readRenderTargetPixels(current,0,0,width,height,pixels);
      return pixels;
    }

    // Qualify the real scene binding above the clouds before attempting
    // expensive, lower-altitude timing where cache misses are common.
    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error(`Live Near comparison did not receive matched frames at ${altitude} m`)),130000);
      hook = function(name,work,options) {
        const result = profile.call(this,name,work,options);
        if (name !== 'volume-current' || mesh.material !== original || pass.activePlanet !== planet
          || !uniforms.uSunCacheReady.value || pose.rows.length >= 5) return result;
        try {
          if (pass.current !== current || !pass.farSplit.soleOwner(scene,mesh)
            || uniforms.uLightQuadratureSteps.value !== 16) throw Error('Near comparison lost its single owner or sixteen anchors');
          // The volume pass can replace entries when the active atmosphere
          // changes. Keep each material dictionary and refresh its bindings.
          Object.assign(density.uniforms,uniforms);
          Object.assign(light.uniforms,uniforms);
          if (Object.keys(original.defines).some(key => density.defines[key] !== original.defines[key]))
            throw Error('Near comparison source variant changed');
          const timed = pose.rows.length !== 0;
          if (!timed) verifyGL('production frame');
          const order = pose.rows.length%2 ? ['original','split'] : ['split','original'];
          const row = {order, frame:pass.frame, weatherHours:planet.weatherHours,
            depthReady:uniforms.uDepthReady.value, sunCacheReady:uniforms.uSunCacheReady.value, queries:{}};
          const pixels = {};
          if (!timed) pixels.production = read();
          for (const path of order) {
            row.queries[path] = render(path==='split',timed);
            if (!timed) {
              verifyGL(path+' draw');
              pixels[path] = read();
              verifyGL(path+' readback');
            }
          }
          if (order.at(-1) === 'split') render(false,false);
          if (!timed) {
            row.changed = 0;row.alphaChanged = 0;row.cloudPixels = 0;row.maximumError = 0;row.referenceChanged = 0;
            const half = T.DataUtils.fromHalfFloat;
            for (let i=0;i<pixels.original.length;i++) {
              const a = pixels.original[i], b = pixels.split[i], alpha = i%4===3;
              if (a !== pixels.production[i]) row.referenceChanged++;
              if (alpha && half(a)>0) row.cloudPixels++;
              if (a !== b) {
                row.changed++;
                if (alpha) row.alphaChanged++;
                row.maximumError = Math.max(row.maximumError,Math.abs(half(a)-half(b)));
              }
            }
          }
          pose.rows.push(row);
          if (!timed && (row.referenceChanged || !row.cloudPixels || row.maximumError > .002 || row.alphaChanged))
            throw Error('Near candidate failed same-frame HDR parity');
          if (pose.rows.length === 5) resolve();
        } catch (error) {
          reject(error);
        }
        return result;
      };
      pass.profilePhase = hook;
    });
    pass.profilePhase = profile;
    clearTimeout(deadline);
    const end = performance.now()+30000;
    while (queries.some(query => !gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
      if (performance.now()>end) throw Error('Near paired GPU timing expired');
      await new Promise(resolve => setTimeout(resolve,20));
    }
    const disjoint = readGpuDisjointEpoch(gl,timer) !== epoch;
    for (const row of pose.rows) {
      row.gpuMs = Object.fromEntries(Object.entries(row.queries).map(([name,query])=>[
        name,query&&!disjoint?gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6:null,
      ]));
      delete row.queries;
    }
    return {prepareMs, sun:observation.sun, dimensions:[width,height],scratchBytes:width*height*68, poses,
      gl:gl.getError(),lost:gl.isContextLost(),disjoint};
  } finally {
    clearTimeout(deadline);
    if (pass.profilePhase === hook) pass.profilePhase = profile;
    for (const query of queries) gl.deleteQuery(query);
    density.dispose();light.dispose();scratch.dispose();
  }
}
