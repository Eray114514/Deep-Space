import {CloudLightBatchRenderer} from '../src/cloud/cloud-light-batch-renderer.js';
import {cloudLightBatchShaders} from '../src/cloud/cloud-light-batch-glsl.js';

export async function probeLightBatches({budgetBytes=64*1024*1024,beamBytes=4,rounds=7,jitterFrame=0}={}) {
  const T=NMS._THREE,r=NMS._renderer,camera=NMS._internals.camera,vp=NMS._pipeline.volumePass,p=vp.activePlanet;
  const production=p.volCloudMat,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext)throw Error('Actual hardware GPU timer required');
  const width=vp.width,height=vp.height,request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let id=-1;
  window.requestAnimationFrame=callback=>{const key=id--;pending.set(key,callback);return key;};
  window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel.call(window,key);};
  await new Promise(resolve=>request.call(window,resolve));
  const worker=p.weatherStream?.worker,receive=worker?.onmessage,messages=[];
  if(worker)worker.onmessage=event=>messages.push(event);
  const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
  const mask=camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
  const options={depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter};
  const output=new T.WebGLRenderTarget(width,height,{...options,type:T.HalfFloatType});
  const readback=new T.WebGLRenderTarget(width,height,{...options,type:T.FloatType});
  const common={...production.uniforms,uFrame:{value:jitterFrame},tSceneDepth:{value:NMS._queryDepth.texture}};
  const make=fragment=>new T.ShaderMaterial({defines:{...production.defines},uniforms:{...common},
    vertexShader:production.vertexShader,fragmentShader:fragment,side:production.side,depthTest:false,depthWrite:false,
    blending:T.NoBlending,premultipliedAlpha:production.premultipliedAlpha});
  const original=make(production.fragmentShader),shaders=cloudLightBatchShaders(production.fragmentShader),badFields=make(shaders.badFields);
  const scene=new T.Scene(),mesh=new T.Mesh(p.volCloudMesh.geometry,original);mesh.layers.set(2);mesh.frustumCulled=false;
  mesh.matrixAutoUpdate=false;mesh.matrix.copy(p.volCloudMesh.matrixWorld);scene.add(mesh);scene.updateMatrixWorld(true);
  const quadGeometry=new T.PlaneGeometry(2,2),quadScene=new T.Scene(),quadCamera=new T.Camera(),quad=new T.Mesh(quadGeometry);quadScene.add(quad);
  const vertex='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
  const copy=new T.ShaderMaterial({uniforms:{tInput:{value:output.texture}},vertexShader:vertex,depthTest:false,depthWrite:false,
    fragmentShader:'uniform sampler2D tInput;void main(){gl_FragColor=texelFetch(tInput,ivec2(gl_FragCoord.xy),0);}',blending:T.NoBlending});
  let batches=null,badCached=null,forbiddenCalls=0;
  const inputState=()=>JSON.stringify({matrix:mesh.matrixWorld.elements,camera:camera.matrixWorld.elements,projection:camera.projectionMatrix.elements,
    uniforms:Object.fromEntries(Object.entries(common).map(([key,{value}])=>[key,
      value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:value]))});
  const firstInputs=inputState(),records=[],nativeExpected=[],pixelsExpected=[];
  const timed=async work=>{
    const query=gl.createQuery(),started=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try {
      try{work();}finally{gl.endQuery(ext.TIME_ELAPSED_EXT);}
      const cpuSubmitMs=performance.now()-started,error=gl.getError();if(error)throw Error('Cloud batch GL '+error);
      const deadline=performance.now()+60000;gl.flush();
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)) {
        if(performance.now()>deadline)throw Error('Cloud batch timer deadline');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Cloud batch disjoint timer');
      return {cpuSubmitMs,gpuMs:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6};
    }finally{gl.deleteQuery(query);}
  };
  const drawOriginal=material=>{r.setRenderTarget(output);r.clear(true,false,false);mesh.material=material;r.render(scene,camera);mesh.material=original;};
  const pixels=()=>{
    r.setRenderTarget(readback);quad.material=copy;r.render(quadScene,quadCamera);
    const data=new Float32Array(width*height*4);r.readRenderTargetPixels(readback,0,0,width,height,data);return data;
  };
  const submit=()=>{
    const replacements=[];
    for(const [object,name] of [[r,'readRenderTargetPixels'],[r,'readRenderTargetPixelsAsync'],[gl,'readPixels'],
      [gl,'finish'],[gl,'clientWaitSync'],[gl,'getQueryParameter']]) {
      const fn=object[name];object[name]=()=>{forbiddenCalls++;throw Error('Forbidden in same-frame batch submission: '+name);};
      replacements.push(()=>{object[name]=fn;});
    }
    try{return batches.render(r,camera,mesh,output);}finally{for(const restore of replacements)restore();}
  };
  try {
    camera.layers.set(2);r.autoClear=false;r.setClearColor(0,0);
    batches=new CloudLightBatchRenderer(original,{width,height,budgetBytes,beamBytes,maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE)});
    for(let round=0;round<rounds;round++)for(const index of round%2?[0,1]:[1,0]) {
      const drawCalls=r.info.render.calls;
      const timing=await timed(()=>{if(index===0||batches.plan.direct)drawOriginal(original);else if(submit()!==true)throw Error('Batch submission must be synchronous and complete');});
      const calls=r.info.render.calls-drawCalls;
      const native=new Uint16Array(width*height*4);r.readRenderTargetPixels(output,0,0,width,height,native);
      let nativeRepeatChanged=0;if(nativeExpected[index])for(let i=0;i<native.length;i++)if(native[i]!==nativeExpected[index][i])nativeRepeatChanged++;
      nativeExpected[index]||=native;pixelsExpected[index]||=pixels();
      records.push({round,implementation:index?'batched':'production',...timing,drawCalls:calls,nativeRepeatChanged});
      console.log('Page: '+JSON.stringify(records.at(-1)));
    }
    const compare=data=>{const channels=[0,0,0,0];let maximumError=0;
      for(let i=0;i<data.length;i++){const error=Math.abs(data[i]-pixelsExpected[0][i]);if(error)channels[i%4]++;maximumError=Math.max(maximumError,error);}
      return {channels,maximumError,alphaChanged:channels[3]};};
    let badCachedControl=null;
    if(!batches.plan.direct) {
      badCached=new T.ShaderMaterial({uniforms:{tPageCached:{value:batches.frame.textures[1]}},vertexShader:vertex,
        fragmentShader:'uniform sampler2D tPageCached;void main(){gl_FragColor=texelFetch(tPageCached,ivec2(gl_FragCoord.xy),0);}',
        depthTest:false,depthWrite:false,blending:T.NoBlending});
      r.setRenderTarget(output);r.clear(true,false,false);quad.material=badCached;r.render(quadScene,quadCamera);badCachedControl=compare(pixels());
    }
    drawOriginal(badFields);const badFieldsControl=compare(pixels());
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    return {width,height,budgetBytes,beamBytes,jitterFrame,records,plan:batches.plan,comparison:compare(pixelsExpected[1]),
      forbiddenCalls,badCachedControl,badFieldsControl,occupied:Array.from(pixelsExpected[0]).filter((v,i)=>i%4===3&&v>.004).length,
      inputsChanged:inputState()!==firstInputs,inputs:JSON.parse(firstInputs),gl:gl.getError(),gpu:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null,
      scope:'One complete same-frame command sequence, GPU mask clips empty tile/field rectangles, fixed pages reused for every batch. No readback or wait inside submission. Timers/readbacks only outside the kernel. Static private scene, not continuous or whole-frame acceptance.'};
  } finally {
    batches?.dispose();original.dispose();badFields.dispose();badCached?.dispose();copy.dispose();quadGeometry.dispose();output.dispose();readback.dispose();
    r.autoClear=auto;camera.layers.mask=mask;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
    NMS._queryDepth.dispose();delete NMS._queryDepth;
    if(worker){worker.onmessage=receive;for(const event of messages)receive?.call(worker,event);}
    window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;for(const callback of pending.values())request.call(window,callback);
  }
}
