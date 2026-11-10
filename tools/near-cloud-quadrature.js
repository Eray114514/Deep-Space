import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';

// Same material and native program. One private draw per live 16-bin frame,
// then restore the count before the volume history consumes the public HDR.
export function observeNearQuadrature(game) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, profile=pass.profilePhase, gl=renderer.getContext();
  const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!timer)throw Error('Quadrature probe requires GPU timing');
  const epoch=readGpuDisjointEpoch(gl,timer), arms=[16,8,4], rows=[];
  const queries=[];
  let scratch, failure;
  function time(work) {
    if(gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))throw Error('Overlapping near quadrature GPU query');
    const query=gl.createQuery();
    if(!query)throw Error('Could not create near quadrature GPU query');
    queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    try {work();}
    finally {if(!gl.isContextLost())gl.endQuery(timer.TIME_ELAPSED_EXT);}
    return query;
  }
  function hook(name,work,options) {
    const planet=pass.activePlanet, mesh=planet?.volCloudMesh, current=pass.current;
    if(name!=='volume-current'||!mesh||mesh.material!==planet.volCloudMat||rows.length===arms.length||failure)
      return profile.call(this,name,work,options);
    const material=mesh.material, uniforms=material.uniforms, bins=arms[rows.length];
    const render=renderer.render;
    let original, result;
    renderer.render=function(scene,camera) {
      if(scene===pass.scene&&camera===pass.camera&&renderer.getRenderTarget()===current)
        original=time(()=>render.call(this,scene,camera));
      else render.call(this,scene,camera);
    };
    try {result=work();}
    finally {renderer.render=render;}
    try {
      if(!original||!pass.farSplit.soleOwner(pass.scene,mesh)||uniforms.uLightQuadratureSteps.value!==16)
        throw Error('Expected original single-owner near quadrature draw');
      scratch??=new T.WebGLRenderTarget(current.width,current.height,{type:T.HalfFloatType,depthBuffer:false});
      if(scratch.width!==current.width||scratch.height!==current.height)throw Error('Quadrature target changed');
      const read=target=>{
        const pixels=new Uint16Array(target.width*target.height*4);
        renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
        return pixels;
      };
      const program=renderer.properties.get(material).currentProgram;
      const reference=read(current), saved=renderer.getRenderTarget(),auto=renderer.autoClear;
      const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      let candidate;
      try {
        uniforms.uLightQuadratureSteps.value=bins;material.uniformsNeedUpdate=true;
        renderer.setRenderTarget(scratch);renderer.autoClear=false;renderer.clear(true,false,false);
        candidate=time(()=>render.call(renderer,pass.scene,pass.camera));
      } finally {
        uniforms.uLightQuadratureSteps.value=16;material.uniformsNeedUpdate=true;
        renderer.setRenderTarget(saved,face,mip);renderer.autoClear=auto;
      }
      if(renderer.properties.get(material).currentProgram!==program)throw Error('Quadrature count changed native program');
      const pixels=read(scratch), published=read(current), half=T.DataUtils.fromHalfFloat;
      const row={bins,frame:pass.frame,cacheReady:uniforms.uSunCacheReady.value,dimensions:[current.width,current.height],
        queries:{original,candidate},changed:0,alphaChanged:0,maxRgb:0,pixelsOverRgbGate:0,cloudPixels:0};
      for(let i=0;i<pixels.length;i+=4) {
        if(published[i]!==reference[i]||published[i+1]!==reference[i+1]
          ||published[i+2]!==reference[i+2]||published[i+3]!==reference[i+3])
          throw Error('Quadrature probe changed published HDR');
        if(half(reference[i+3])>0)row.cloudPixels++;
        if(pixels[i+3]!==reference[i+3])row.alphaChanged++;
        const error=Math.max(...[0,1,2].map(channel=>Math.abs(half(reference[i+channel])-half(pixels[i+channel]))));
        if(!Number.isFinite(error))throw Error('Invalid quadrature color');
        if(error>0)row.changed++;
        if(error>.002)row.pixelsOverRgbGate++;
        row.maxRgb=Math.max(row.maxRgb,error);
      }
      if(!row.cloudPixels||bins===16&&(row.changed||row.alphaChanged))throw Error('Near quadrature control failed');
      rows.push(row);
    } catch(error) {failure=error;}
    return result;
  }
  pass.profilePhase=hook;
  return {
    get done() {return rows.length===arms.length||Boolean(failure);},
    async finish() {
      try {
        if(failure)throw failure;
        if(rows.length!==arms.length)throw Error('Missing near quadrature samples');
        const end=performance.now()+20000;
        while(queries.some(query=>!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
          if(gl.isContextLost()||performance.now()>end)throw Error('Near quadrature timer failed');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        if(readGpuDisjointEpoch(gl,timer)!==epoch)throw Error('Near quadrature timer became disjoint');
        return rows.map(({queries,...row})=>({...row,gpuMs:Object.fromEntries(
          Object.entries(queries).map(([name,query])=>[name,gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6]))}));
      } finally {
        if(pass.profilePhase===hook)pass.profilePhase=profile;
        if(!gl.isContextLost())for(const query of queries)gl.deleteQuery(query);
        scratch?.dispose();
      }
    },
  };
}
