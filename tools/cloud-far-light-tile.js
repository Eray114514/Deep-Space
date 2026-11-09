import { CloudSunCache } from '../src/cloud/cloud-sun-cache.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';

// Frozen live orbit only. Bind a single world-space tile at both endpoints
// of the actual point material, then restore every binding before history.
export async function measureFarLightTile(game, spacing=200) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, split=pass.farSplit, planet=pass.activePlanet;
  const mesh=planet.volCloudMesh, material=split.materials.point;
  const native=renderer.getContext(), timer=native.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer || !planet.weatherStream.ready || planet.cloudLightBank || material.uniforms.uSunCacheReady.value)
    throw Error('Expected a live uncached orbit with weather and GPU timers');
  const uniforms=material.uniforms, hours=planet.weatherHours;
  const anchor=uniforms.uCameraLocal.value.clone().normalize().multiplyScalar(planet.R+5200);
  const cache=new CloudSunCache(planet,anchor,{size:64,depth:128,spacing,programOwner:pipeline.cloudLightPrograms});
  const current=pass.current, {width,height}=current;
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const hdr=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
  const profile=pass.profilePhase, queries=[], submissions=[];
  let deadline,hook,pacer;
  const epoch=readGpuDisjointEpoch(native,timer);

  function timed(work) {
    if(native.getQuery(timer.TIME_ELAPSED_EXT,native.CURRENT_QUERY)) throw Error('Overlapping tile GPU timer');
    const query=native.createQuery();
    if(!query) throw Error('Could not time Far lighting tile');
    queries.push(query);
    native.beginQuery(timer.TIME_ELAPSED_EXT,query);
    try { work(); }
    finally { if(!native.isContextLost()) native.endQuery(timer.TIME_ELAPSED_EXT); }
    return query;
  }
  function read(source,ArrayType=Float32Array) {
    const data=new ArrayType(width*height*4);
    renderer.readRenderTargetPixels(source,0,0,width,height,data);
    return data;
  }
  function renderPoint(bindings) {
    const old=Object.entries(bindings).map(([key,value])=>[uniforms[key],uniforms[key].value,value]);
    const previous=mesh.material, saved=renderer.getRenderTarget();
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),auto=renderer.autoClear;
    try {
      for(const [binding,,value] of old) binding.value=value;
      mesh.material=material;material.uniformsNeedUpdate=true;renderer.autoClear=false;
      renderer.setRenderTarget(target);renderer.clear(true,false,false);
      renderer.render(pass.scene,pass.camera);
    } finally {
      for(const [binding,value] of old) binding.value=value;
      mesh.material=previous;material.uniformsNeedUpdate=true;renderer.autoClear=auto;
      renderer.setRenderTarget(saved,face,mip);
    }
    return read(target);
  }
  function compose() {
    const combine=split.materials.combine, binding=combine.uniforms.uSplitPoint;
    const original=binding.value, previous=mesh.material, saved=renderer.getRenderTarget();
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),auto=renderer.autoClear;
    try {
      binding.value=target.texture;combine.uniformsNeedUpdate=true;mesh.material=combine;
      renderer.setRenderTarget(hdr);renderer.autoClear=false;
      renderer.clear(true,false,false);renderer.render(pass.scene,pass.camera);
    } finally {
      binding.value=original;combine.uniformsNeedUpdate=true;mesh.material=previous;renderer.autoClear=auto;
      renderer.setRenderTarget(saved,face,mip);
    }
    return read(hdr,Uint16Array);
  }
  function difference(a,b,decode=value=>value) {
    const result={changedPixels:0,alphaChanged:0,maxRgb:0,maxAlpha:0,pixelsOverRgbGate:0};
    for(let i=0;i<a.length;i+=4) {
      const rgb=Math.max(Math.abs(decode(a[i])-decode(b[i])),Math.abs(decode(a[i+1])-decode(b[i+1])),
        Math.abs(decode(a[i+2])-decode(b[i+2])));
      const alpha=Math.abs(decode(a[i+3])-decode(b[i+3]));
      if(!Number.isFinite(rgb)||!Number.isFinite(alpha))throw Error('Non-finite Far lighting tile comparison');
      if(rgb>0||alpha>0)result.changedPixels++;
      if(alpha>0)result.alphaChanged++;
      if(rgb>.002)result.pixelsOverRgbGate++;
      result.maxRgb=Math.max(rgb,result.maxRgb);result.maxAlpha=Math.max(alpha,result.maxAlpha);
    }
    return result;
  }
  function checkInputs() {
    if(native.isContextLost() || pass.activePlanet!==planet || pass.current!==current
      || split.materials.point!==material || planet.weatherHours!==hours)
      throw Error('Far tile scene changed during frozen comparison');
  }

  try {
    if(!pipeline.framePacer)pacer=pipeline.startFramePacing();
    while(!cache.ready) {
      const at=performance.now();
      const query=await pipeline.prepare(()=>{
        checkInputs();
        return timed(()=>cache.bakeSlice(renderer,{boundaryRows:64,slices:16}));
      },{label:'far-light-tile'});
      submissions.push({waitMs:performance.now()-at,query});
      if(submissions.length>64) throw Error('Far tile bake made no progress');
    }
    const comparison=await new Promise((resolve,reject)=>{
      deadline=setTimeout(()=>reject(Error('No live frozen Far tile frame')),30000);
      hook=function(name,work,options) {
        const result=profile.call(this,name,work,options);
        if(name!=='volume-current'||split.lastRoute!=='combine'||split.plan?.mesh!==mesh)return result;
        pass.profilePhase=profile;
        try {
          checkInputs();
          const point=split.scratch[0], original=read(point), originalHdr=read(current,Uint16Array);
          const half=T.DataUtils.fromHalfFloat;
          const control=difference(original,renderPoint({})), controlHdr=difference(originalHdr,compose(),half);
          if(control.changedPixels||controlHdr.changedPixels)throw Error('Far tile original control changed');
          const valid=new T.Vector4().fromArray(cache.available.map(Number));
          const margins=new T.Vector4().fromArray(cache.interiorMargins);
          const tiled=renderPoint({
            uSunTransport:cache.target.texture,uSunCacheReady:1,uSunCacheDepth:cache.depth,
            uSunCacheMix:0,uSunCacheOffsets:new T.Vector2(),uSunCacheEncoded:0,
            uSunCacheMatrixA:cache.transforms,uSunCacheMatrixB:cache.transforms,
            uSunCacheValidA:valid,uSunCacheValidB:valid,uSunCacheMarginA:margins,uSunCacheMarginB:margins,
          });
          const error=difference(original,tiled), errorHdr=difference(originalHdr,compose(),half);
          const untouched=difference(original,read(point)), untouchedHdr=difference(originalHdr,read(current,Uint16Array),half);
          if(untouched.changedPixels||untouchedHdr.changedPixels)throw Error('Far tile modified a published target');
          if(!error.changedPixels)throw Error('Far lighting tile had no visible effect');
          resolve({frame:pass.frame,control,controlHdr,error,errorHdr,untouched,untouchedHdr});
        } catch(error) { reject(error); }
        return result;
      };
      pass.profilePhase=hook;
    });
    const end=performance.now()+30000;
    while(queries.some(query=>!native.getQueryParameter(query,native.QUERY_RESULT_AVAILABLE))) {
      if(performance.now()>end||native.isContextLost())throw Error('No usable Far lighting tile timings');
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    if(readGpuDisjointEpoch(native,timer)!==epoch)throw Error('Far lighting tile became disjoint');
    return {...comparison,hours,dimensions:[width,height],anchor:anchor.toArray(),available:cache.available,
      extentMeters:[cache.size*spacing,cache.size*spacing,cache.depth*cache.verticalSpacing],
      tileBytes:cache.target.width*cache.target.height*2,
      batches:submissions.map(({waitMs,query})=>({waitMs,gpuMs:native.getQueryParameter(query,native.QUERY_RESULT)/1e6})),
      gl:native.getError(),lost:native.isContextLost()};
  } finally {
    clearTimeout(deadline);
    if(pass.profilePhase===hook)pass.profilePhase=profile;
    if(pacer&&pipeline.framePacer===pacer)pipeline.stopFramePacing();
    if(!native.isContextLost())for(const query of queries)native.deleteQuery(query);
    target.dispose();hdr.dispose();cache.dispose();
  }
}
