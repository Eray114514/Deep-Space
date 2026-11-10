import { CloudSunCache } from '../src/cloud/cloud-sun-cache.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { directFarLightGrid, compareFarLightGrid } from './cloud-far-light-grid.js';
import { createEncodedFarLight } from './cloud-far-light-encoded.js';
import { makeFarLightGate, summarizeFarLightGate } from './cloud-far-light-gate.js';

// Frozen live orbit only. Bind a single world-space tile at both endpoints
// of the actual point material, then restore every binding before history.
export async function measureFarLightTile(game, spacing=200, representation=false, encodedOutput=false, gateOutput=false) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, split=pass.farSplit, planet=pass.activePlanet;
  const mesh=planet.volCloudMesh, material=split.materials.point;
  const native=renderer.getContext(), timer=native.getExtension('EXT_disjoint_timer_query_webgl2');
  if (!timer || !planet.weatherStream.ready || planet.cloudLightBank || material.uniforms.uSunCacheReady.value)
    throw Error('Expected a live uncached orbit with weather and GPU timers');
  const uniforms=material.uniforms, hours=planet.weatherHours;
  // The flight camera can settle differently across boots. Anchor both
  // lattices in the same body-local coordinates at the frozen weather hour.
  const star=planet.stellarDirectionsAt(hours).sort((a,b)=>b.irradianceFraction-a.irradianceFraction)[0];
  const anchor=new T.Vector3(...star.direction).normalize().multiplyScalar(planet.R+5200);
  // Hold the physical support fixed when refining the horizontal lattice.
  const size=12800/spacing;
  const cache=new CloudSunCache(planet,anchor,{size,depth:128,spacing,programOwner:pipeline.cloudLightPrograms});
  const observation=window.__farLightTile={hours,anchor:anchor.toArray(),
    basis:cache.frames.map(frame=>frame.toArray()),spacing,rejectedControls:[]};
  const current=pass.current, {width,height}=current;
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const hdr=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
  const profile=pass.profilePhase, queries=[], submissions=[];
  let deadline,hook,pacer,encoded,encodeQuery,gate;
  const epoch=readGpuDisjointEpoch(native,timer);
  function prepare(work,label) {
    return pipeline.prepare(()=>{
      checkInputs();
      const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      try {return work();}
      finally {renderer.setRenderTarget(saved,face,mip);}
    },{label});
  }

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
  function renderPoint(bindings,pointMaterial) {
    if(pointMaterial!==material)Object.assign(pointMaterial.uniforms,uniforms);
    const active=pointMaterial.uniforms;
    const old=Object.entries(bindings).map(([key,value])=>[active[key],active[key].value,value]);
    const previous=mesh.material, saved=renderer.getRenderTarget();
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),auto=renderer.autoClear;
    try {
      for(const [binding,,value] of old) binding.value=value;
      mesh.material=pointMaterial;pointMaterial.uniformsNeedUpdate=true;renderer.autoClear=false;
      renderer.setRenderTarget(target);renderer.clear(true,false,false);
      return timed(()=>renderer.render(pass.scene,pass.camera));
    } finally {
      for(const [binding,value] of old) binding.value=value;
      mesh.material=previous;pointMaterial.uniformsNeedUpdate=true;renderer.autoClear=auto;
      renderer.setRenderTarget(saved,face,mip);
    }
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
    const directGrid=await directFarLightGrid(T,renderer,cache,prepare);
    while(!cache.ready) {
      const at=performance.now();
      const query=await prepare(()=>timed(()=>cache.bakeSlice(renderer,{boundaryRows:64,slices:16})),'far-light-tile');
      submissions.push({waitMs:performance.now()-at,query});
      if(submissions.length>64) throw Error('Far tile bake made no progress');
    }
    const measured=await compareFarLightGrid(T,renderer,cache,directGrid,prepare,representation?material:null);
    const grid=observation.grid=measured.rows;
    if(representation)observation.representations=measured.representations;
    let arms=['control',...grid.filter(field=>field.available).map(field=>field.field),'all'];
    if(gateOutput) {
      gate=makeFarLightGate(T,material,mesh,pass);
      await prepare(()=>{
        renderer.setRenderTarget(target);
        return gate.compile(renderer);
      },'far-light-gate-program');
      observation.gates=[];
      arms=grid.filter(field=>field.available).map(field=>field.field);
    }
    if(encodedOutput) {
      encoded=createEncodedFarLight(T,cache,material,mesh,pass.camera,pass.scene);
      const at=performance.now();
      await prepare(()=>encoded.compile(renderer,target),'far-light-encoded-program');
      observation.encodedPrepareMs=performance.now()-at;
      encodeQuery=await prepare(()=>timed(()=>encoded.encode(renderer)),'far-light-encode');
      observation.encodedBytes=encoded.solar.width*encoded.solar.height*2+encoded.radial.width*encoded.radial.height*8;
      arms=['all','depth-solar','depth-radial','encoded-control','encoded-solar','encoded-radial','encoded-all'];
    }
    const margins=new T.Vector4().fromArray(cache.interiorMargins);
    const comparison=await new Promise((resolve,reject)=>{
      const rows=[];
      deadline=setTimeout(()=>reject(Error('No live frozen Far tile frame')),encodedOutput?45000:30000);
      hook=function(name,work,options) {
        const result=profile.call(this,name,work,options);
        if(name!=='volume-current'||split.lastRoute!=='combine'||split.plan?.mesh!==mesh)return result;
        try {
          checkInputs();
          const point=split.scratch[0], original=read(point), originalHdr=read(current,Uint16Array);
          const half=T.DataUtils.fromHalfFloat;
          const arm=arms[rows.length];
          function rejectControl(kind,error,errorHdr) {
            observation.rejectedControls.push({kind,arm,frame:pass.frame,error,errorHdr});
            if(observation.rejectedControls.filter(row=>row.arm===arm&&row.kind===kind).length===3)
              throw Error(`Far tile ${arm} ${kind} changed on three frames`);
          }
          let referenceQuery;
          if(encodedOutput||gateOutput) {
            referenceQuery=renderPoint({},material);
            const reference=difference(original,read(target)), referenceHdr=difference(originalHdr,compose(),half);
            if(reference.changedPixels||referenceHdr.changedPixels) {
              rejectControl('reference',reference,referenceHdr);
              return result;
            }
          }
          const useEncoded=arm.startsWith('encoded-'), control=arm.endsWith('control');
          const solar=arm.endsWith('-solar')||arm==='encoded-all';
          const radial=arm.endsWith('-radial')||arm==='encoded-all';
          const enabled=(field,i)=>Number(field.available&&(arm==='all'||field.field===arm
            ||i<2&&solar||i>=2&&radial&&!useEncoded));
          const valid=new T.Vector4().fromArray(grid.map(enabled));
          const bindings=control?{}:{
            uSunTransport:useEncoded&&solar?encoded.solar.texture:cache.target.texture,
            uSunCacheReady:1,uSunCacheDepth:cache.depth,
            uSunCacheMix:0,uSunCacheOffsets:new T.Vector2(),uSunCacheEncoded:useEncoded&&solar?2:0,
            uSunCacheMatrixA:cache.transforms,uSunCacheMatrixB:cache.transforms,
            uSunCacheValidA:valid,uSunCacheValidB:valid,uSunCacheMarginA:margins,uSunCacheMarginB:margins,
          };
          if(useEncoded)bindings.uEncodedRadialReady=radial;
          const query=renderPoint(bindings,useEncoded?encoded.material:material);
          const tiled=read(target);
          const composed=compose();
          const error=difference(original,tiled), errorHdr=difference(originalHdr,composed,half);
          if(gate) {
            const field=grid.findIndex(entry=>entry.field===arm);
            renderPoint({...bindings,uGateField:field},gate.material);
            observation.gates.push({arm,frame:pass.frame,alphaChanged:errorHdr.alphaChanged,
              ...summarizeFarLightGate(field,read(target),original,originalHdr,composed,half)});
          }
          const untouched=difference(original,read(point)), untouchedHdr=difference(originalHdr,read(current,Uint16Array),half);
          if(untouched.changedPixels||untouchedHdr.changedPixels)throw Error('Far tile modified a published target');
          if(control&&(error.changedPixels||errorHdr.changedPixels)) {
            rejectControl('variant',error,errorHdr);
            return result;
          }
          if(arm==='all'&&!error.changedPixels)throw Error('Far lighting tile had no visible effect');
          rows.push({arm,frame:pass.frame,error,errorHdr,untouched,untouchedHdr,query,referenceQuery});
          if(rows.length===arms.length) {
            pass.profilePhase=profile;
            resolve(rows);
          }
        } catch(error) {pass.profilePhase=profile;reject(error);}
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
    const ms=query=>native.getQueryParameter(query,native.QUERY_RESULT)/1e6;
    return {...observation,comparison:comparison.map(({query,referenceQuery,...row})=>({...row,
      gpuMs:ms(query),referenceGpuMs:referenceQuery?ms(referenceQuery):undefined})),
      encodeGpuMs:encodeQuery?ms(encodeQuery):undefined,dimensions:[width,height],available:cache.available,
      extentMeters:[cache.size*spacing,cache.size*spacing,cache.depth*cache.verticalSpacing],
      tileBytes:cache.target.width*cache.target.height*2,
      batches:submissions.map(({waitMs,query})=>({waitMs,gpuMs:native.getQueryParameter(query,native.QUERY_RESULT)/1e6})),
      gl:native.getError(),lost:native.isContextLost()};
  } finally {
    clearTimeout(deadline);
    if(pass.profilePhase===hook)pass.profilePhase=profile;
    if(pacer&&pipeline.framePacer===pacer)pipeline.stopFramePacing();
    if(!native.isContextLost())for(const query of queries)native.deleteQuery(query);
    gate?.dispose();encoded?.dispose();target.dispose();hdr.dispose();cache.dispose();
  }
}
