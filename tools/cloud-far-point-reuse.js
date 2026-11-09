import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { farPointReuseShader } from './cloud-far-point-reuse-shader.js';

const policies = [
  {name:'dense',stride:1,distance:0,opacity:0,spread:0},
  {name:'loose2',stride:2,distance:10000,opacity:1,spread:128},
  {name:'guarded2',stride:2,distance:256,opacity:.12,spread:.08},
  {name:'tight2',stride:2,distance:96,opacity:.05,spread:.02},
  {name:'guarded4',stride:4,distance:256,opacity:.12,spread:.08},
];
const perPathPolicies = [
  policies[0],
  {name:'individual2',stride:2,distance:256,opacity:.12,spread:.08,individual:true},
  {name:'transmission2',stride:2,distance:256,opacity:.12,spread:.08,individual:true,solarSpread:.002},
  {name:'wider2',stride:2,distance:1200,opacity:.25,spread:.08,individual:true,solarSpread:.002},
  {name:'individual4',stride:4,distance:256,opacity:.12,spread:.08,individual:true,solarSpread:.002},
];

export async function measureFarPointReuse(game, perPath=false) {
  const T = game._THREE, renderer = game._renderer, pipeline = game._pipeline;
  const pass = pipeline.volumePass, {farSplit:split,scene,camera,current} = pass;
  const planet = pass.activePlanet, mesh = planet.volCloudMesh, {point,combine} = split.materials;
  const gl = renderer.getContext(), timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer || gl.getParameter(gl.MAX_DRAW_BUFFERS)<3 || gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)<3)
    throw Error('Far reuse needs GPU timers and three color attachments');
  const {width,height} = current;
  const target = (type,count=1) => new T.WebGLRenderTarget(width,height,{
    type,count,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter,
  });
  const field = target(T.FloatType,3), payload = target(T.FloatType), hdr = target(T.HalfFloatType);
  const material = new T.ShaderMaterial().copy(Object.assign(Object.create(point),{uniforms:{}}));
  material.glslVersion = T.GLSL3;
  material.fragmentShader = farPointReuseShader(point.fragmentShader);
  const uniforms = material.uniforms;
  Object.assign(uniforms,point.uniforms,Object.fromEntries(Object.entries({
    uProbeMode:0,uProbeStride:1,uProbeDistance:0,uProbeOpacity:0,uProbeSpread:0,uProbeIndividual:0,uProbeSolarSpread:0,
    tProbeBeams:null,tProbeGeometry:null,
  }).map(([name,value])=>[name,{value}])));
  const proxy = new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);
  const profile = pass.profilePhase, queries = [];
  const state = window.__farPointReuse = {dimensions:[width,height],perPath,scratchBytes:width*height*72,parity:[],timing:[]};
  const cases = perPath ? perPathPolicies : policies;
  let hook, deadline;

  function submit(shader, output, timed=false) {
    const saved = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const autoClear = renderer.autoClear, previous = mesh.material;
    let query;
    if (timed) {
      if (gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)) throw Error('Far reuse timer overlap');
      query = gl.createQuery();
      if (!query) throw Error('Far reuse could not allocate timer');
      queries.push(query);
      gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    }
    try {
      renderer.autoClear = false;
      renderer.setRenderTarget(output);
      renderer.clear(true,false,false);
      mesh.material = shader;
      shader.uniformsNeedUpdate = true;
      renderer.render(scene,camera);
    } finally {
      mesh.material = previous;
      renderer.autoClear = autoClear;
      renderer.setRenderTarget(saved,face,mip);
      if (query && !gl.isContextLost()) gl.endQuery(timer.TIME_ELAPSED_EXT);
    }
    return query;
  }

  function draw(mode,policy,output,timed=false) {
    Object.assign(uniforms,point.uniforms);
    uniforms.uProbeMode.value = mode;
    uniforms.uProbeStride.value = policy.stride;
    uniforms.uProbeDistance.value = policy.distance;
    uniforms.uProbeOpacity.value = policy.opacity;
    uniforms.uProbeSpread.value = policy.spread;
    uniforms.uProbeIndividual.value = policy.individual ? 1 : 0;
    uniforms.uProbeSolarSpread.value = policy.solarSpread ?? 0;
    // Active sampler bindings must never alias a currently attached texture,
    // even when a uniform branch makes the sampling unreachable.
    uniforms.tProbeBeams.value = mode>=2 ? field.textures[1] : null;
    uniforms.tProbeGeometry.value = mode>=2 ? field.textures[2] : null;
    return submit(material,output,timed);
  }

  function read(output, ArrayType, attachment=0) {
    const pixels = new ArrayType(width*height*4);
    renderer.readRenderTargetPixels(output,0,0,width,height,pixels,undefined,attachment);
    const error = gl.getError();
    if (error) throw Error(`Far reuse readback GL ${error}`);
    return pixels;
  }

  function compose(source,attachment=0) {
    const uniform = combine.uniforms.uSplitPoint, saved = uniform.value;
    uniform.value = source.textures[attachment];
    try { submit(combine,hdr); }
    finally { uniform.value = saved;combine.uniformsNeedUpdate = true; }
    return read(hdr,Uint16Array);
  }

  function compare(a,b,half=false) {
    const convert = half ? T.DataUtils.fromHalfFloat : value => value;
    const diff = {changed:0,alphaChanged:0,rgbAboveGate:0,maximumRgb:0,maximumAlpha:0};
    for (let i=0;i<a.length;i++) {
      const va = convert(a[i]), vb = convert(b[i]);
      if (!Number.isFinite(va) || !Number.isFinite(vb)) throw Error('Non-finite Far reuse output');
      if (a[i]===b[i]) continue;
      const error = Math.abs(va-vb);
      diff.changed++;
      if (i%4===3) {
        diff.alphaChanged++;
        diff.maximumAlpha = Math.max(diff.maximumAlpha,error);
      } else {
        if (error>.002) diff.rgbAboveGate++;
        diff.maximumRgb = Math.max(diff.maximumRgb,error);
      }
    }
    return diff;
  }

  function parity(policy) {
    const original = read(split.scratch[0],Float32Array);
    const originalHdr = read(current,Uint16Array);
    // Same-material replay and half HDR compose control for the live oracle.
    submit(point,payload);
    const repeat = compare(original,read(payload,Float32Array));
    const composeRepeat = compare(originalHdr,compose(payload),true);
    if (repeat.changed || composeRepeat.changed) throw Error('Far reuse changed the live reference during replay');
    draw(0,policies[0],field);
    let firstOracle;
    if (policy.stride===1) {
      firstOracle = {point:compare(original,read(field,Float32Array)),hdr:compare(originalHdr,compose(field),true)};
      draw(0,policies[0],field);
    }
    const reference = read(field,Float32Array), referenceHdr = compose(field);
    const oraclePoint = compare(original,reference), oracleHdr = compare(originalHdr,referenceHdr,true);
    let repeatAfterOracle;
    if (oraclePoint.changed || oracleHdr.changed) {
      submit(point,payload);
      repeatAfterOracle = compare(original,read(payload,Float32Array));
    }
    const geometry = read(field,Float32Array,2);
    const beams = read(field,Float32Array,1);
    let supported=0, exactSamples=0, nonzero=[0,0,0,0];
    for (let i=0;i<geometry.length;i+=4) if (geometry[i+1]>=.004) {
      supported++;
      const pixel = i/4;
      if ((pixel%width)%policy.stride===0 && Math.floor(pixel/width)%policy.stride===0) exactSamples++;
      for (let path=0;path<4;path++) if (beams[i+path]>0) nonzero[path]++;
    }
    if (!supported) throw Error('Far point reuse oracle is empty');
    const qualified = !oraclePoint.changed && !oracleHdr.changed;
    if (!state.neighbors || !state.neighbors.qualified && qualified)
      state.neighbors = {frame:pass.frame,hours:planet.weatherHours,qualified,...summarizeNeighbors(geometry,beams,width,height)};
    if (qualified && !state.denseQualified) {
      draw(2,policies[0],payload);
      state.denseQualified = {frame:pass.frame,point:compare(original,read(payload,Float32Array)),
        hdr:compare(originalHdr,compose(payload),true)};
    }
    if (policy.stride>1) draw(1,policy,field);
    draw(2,policy,payload);
    const candidate = read(payload,Float32Array), candidateHdr = compose(payload);
    draw(3,policy,payload);
    const mask = read(payload,Float32Array);
    let reused=0;
    const paths=[0,0,0,0];
    for (let i=0;i<mask.length;i+=4) if (geometry[i+1]>=.004) {
      let accepted=0;
      for (let path=0;path<4;path++) if (mask[i+path]===1) {paths[path]++;accepted++;}
      if (accepted===4) reused++;
    }
    return {
      ...policy,frame:pass.frame,hours:planet.weatherHours,supported,exactSamples,reused,paths,nonzero,repeat,composeRepeat,firstOracle,
      repeatAfterOracle,
      oraclePoint,oracleHdr,
      reusedPoint:compare(reference,candidate),reusedHdr:compare(referenceHdr,candidateHdr,true),
      actualPoint:compare(original,candidate),actualHdr:compare(originalHdr,candidateHdr,true),
    };
  }

  try {
    const at = performance.now();
    await pipeline.prepare(() => {
      const saved = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
      try {
        renderer.setRenderTarget(field);
        return compilePrograms(renderer,proxy,createCompileCamera(camera,VOLUME_LAYER),scene);
      } finally { renderer.setRenderTarget(saved,face,mip); }
    },{label:'far-point-reuse-oracle'});
    state.prepareMs = performance.now()-at;
    const epoch = readGpuDisjointEpoch(gl,timer);
    const measured = perPath ? ['transmission2','wider2'] : ['guarded2','guarded4'];
    const timing = [...measured,...measured,...measured];
    await new Promise((resolve,reject) => {
      deadline = setTimeout(() => reject(Error('Far reuse did not receive enough mixed frames')),60000);
      hook = function(name,work,options) {
        const result = profile.call(this,name,work,options);
        if (name!=='volume-current' || !split.plan || split.lastRoute!=='combine' || state.timing.length===timing.length) return result;
        try {
          if (pass.current!==current || pass.activePlanet!==planet || split.materials.point!==point
            || split.plan.mesh!==mesh || planet.volCloudMat.uniforms.uColumnsReady.value!==1)
            throw Error('Far point reuse inputs changed');
          if (state.parity.length<cases.length) {
            state.parity.push(parity(cases[state.parity.length]));
            return result;
          }
          const index = state.timing.length, policy = cases.find(p=>p.name===timing[index]);
          const row = {name:policy.name,frame:pass.frame,hours:planet.weatherHours,queries:{}};
          const originalFirst = Math.floor(index/2)%2===0;
          if (originalFirst) row.queries.original = submit(point,payload,true);
          row.queries.field = draw(1,policy,field,true);
          row.queries.resolve = draw(2,policy,payload,true);
          if (!originalFirst) row.queries.original = submit(point,payload,true);
          state.timing.push(row);
          if (state.timing.length===timing.length) resolve();
        } catch(error) { reject(error); }
        return result;
      };
      pass.profilePhase = hook;
    });
    pass.profilePhase = profile;
    const end = performance.now()+30000;
    while (queries.some(query=>!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
      if (performance.now()>end || gl.isContextLost()) throw Error('Far reuse timers did not complete');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if (readGpuDisjointEpoch(gl,timer)!==epoch) throw Error('Far reuse timers became disjoint');
    for (const row of state.timing) {
      row.gpuMs = Object.fromEntries(Object.entries(row.queries).map(([name,query])=>
        [name,gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6]));
      delete row.queries;
    }
    return {...state,gl:gl.getError(),lost:gl.isContextLost()};
  } finally {
    clearTimeout(deadline);
    if (pass.profilePhase===hook) pass.profilePhase = profile;
    if (!gl.isContextLost()) for (const query of queries) gl.deleteQuery(query);
    material.dispose();field.dispose();payload.dispose();hdr.dispose();
  }
}

function summarizeNeighbors(geometry,beams,width,height) {
  const result = {pairs:0,geometryCompatible:0,opticalWithin08:[0,0,0,0],
    compatibleOpticalWithin08:[0,0,0,0],solarTransmissionWithin002:[0,0],
    compatibleSolarTransmissionWithin002:[0,0]};
  function compare(a,b) {
    if (geometry[a+1]<.004 || geometry[b+1]<.004) return;
    result.pairs++;
    const compatible = Math.abs(geometry[a]-geometry[b])<=256 && Math.abs(geometry[a+1]-geometry[b+1])<=.12;
    if (compatible) result.geometryCompatible++;
    for (let path=0;path<4;path++) {
      if (Math.abs(beams[a+path]-beams[b+path])<=.08) {
        result.opticalWithin08[path]++;
        if (compatible) result.compatibleOpticalWithin08[path]++;
      }
      if (path<2 && Math.abs(Math.exp(-beams[a+path])-Math.exp(-beams[b+path]))<=.002) {
        result.solarTransmissionWithin002[path]++;
        if (compatible) result.compatibleSolarTransmissionWithin002[path]++;
      }
    }
  }
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const i = (y*width+x)*4;
    if (x+1<width) compare(i,i+4);
    if (y+1<height) compare(i,i+width*4);
  }
  return result;
}
