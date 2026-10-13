import {planLightPages} from './cloud-light-page-layout.js';
import {cloudLightPageShaders} from './cloud-light-page-shaders.js';

export async function probeLightPages({budgetBytes=64*1024*1024,beamBytes=4,rounds=7}={}) {
  const T=NMS._THREE,r=NMS._renderer,camera=NMS._internals.camera,vp=NMS._pipeline.volumePass;
  const p=vp.activePlanet,production=p.volCloudMat,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext||gl.getParameter(gl.MAX_DRAW_BUFFERS)<4)throw Error('Hardware timer and four MRT attachments required');
  if(production.defines.CLOUD_FAR_VIEW||production.defines.PRODUCTION_CLOUD_MEDIUM!==1
    ||production.uniforms.uLightQuadratureSteps.value!==16)throw Error('Exact-page prototype requires production 16-anchor near view');
  const shaders=cloudLightPageShaders(production.fragmentShader),width=vp.width,height=vp.height;
  const tilesX=Math.ceil(width/16),tilesY=Math.ceil(height/16),maxTextureSize=gl.getParameter(gl.MAX_TEXTURE_SIZE);
  const initial=planLightPages({width,height,tileMasks:new Uint8Array(tilesX*tilesY),budgetBytes,beamBytes,maxTextureSize});
  const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let id=-1;
  window.requestAnimationFrame=callback=>{const key=id--;pending.set(key,callback);return key;};
  window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel.call(window,key);};
  await new Promise(resolve=>request.call(window,resolve));
  const worker=p.weatherStream?.worker,receive=worker?.onmessage,messages=[];
  if(worker)worker.onmessage=event=>messages.push(event);
  const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
  const mask=camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha(),debug=r.debug.checkShaderErrors;
  const materials=[],targets=[],textures=[],geometry=new T.PlaneGeometry(2,2);
  const options={type:T.FloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter};
  const rt=(w,h,extra={})=>{const target=new T.WebGLRenderTarget(w,h,{...options,...extra});targets.push(target);return target;};
  const scene=new T.Scene(),mesh=new T.Mesh(p.volCloudMesh.geometry);scene.add(mesh);
  mesh.layers.set(2);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;mesh.matrix.copy(p.volCloudMesh.matrixWorld);scene.updateMatrixWorld(true);
  const quadScene=new T.Scene(),quadCamera=new T.Camera(),quad=new T.Mesh(geometry);quadScene.add(quad);
  const fullscreen='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
  const common={...production.uniforms,uFrame:{value:0},tSceneDepth:{value:NMS._queryDepth.texture}};
  const page={uPageSize:{value:new T.Vector2(width,height)},uPageTilesX:{value:tilesX},
    uPageMetaColumns:{value:1},uPageLightColumns:{value:1}};
  const make=(shader,full=false,mrt=false)=>{
    const material=new T.ShaderMaterial({defines:{...production.defines},uniforms:{...common,...page},
      vertexShader:full?fullscreen:production.vertexShader,fragmentShader:shader,glslVersion:mrt?T.GLSL3:null,
      depthTest:false,depthWrite:false,blending:T.NoBlending,side:full?T.DoubleSide:production.side});
    materials.push(material);return material;
  };
  const timed=async work=>{
    const query=gl.createQuery(),started=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try{work();}finally{gl.endQuery(ext.TIME_ELAPSED_EXT);}
    const cpuSubmitMs=performance.now()-started,deadline=performance.now()+60000;gl.flush();
    try{
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
        if(performance.now()>deadline)throw Error('Light-page timer deadline');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint GPU timer');
      return {cpuSubmitMs,gpuMs:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6};
    }finally{gl.deleteQuery(query);}
  };
  const draw=(target,material,full=false,clear=true)=>{
    r.setRenderTarget(target);if(clear)r.clear(true,false,false);
    const oldAuto=r.autoClear;r.autoClear=false;
    try{if(full){quad.material=material;r.render(quadScene,quadCamera);}else{mesh.material=material;r.render(scene,camera);}}
    finally{r.autoClear=oldAuto;}
    const error=gl.getError();if(error){
      const program=r.properties.get(material).currentProgram.program,samplers=[];
      for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){
        const u=gl.getActiveUniform(program,i);
        if([gl.SAMPLER_2D,gl.SAMPLER_3D,gl.SAMPLER_2D_ARRAY,gl.UNSIGNED_INT_SAMPLER_2D].includes(u.type))
          samplers.push({name:u.name,type:u.type,unit:gl.getUniform(program,gl.getUniformLocation(program,u.name))});
      }
      const props=r.properties.get(material);
      throw Error('Light-page draw '+material.name+' GL '+error+' link '+gl.getProgramInfoLog(program)+' samplers '+JSON.stringify(samplers)+
        ' keys '+JSON.stringify(Object.keys(props.uniforms||{}))+' seq '+props.uniformsList?.length+
        ' programMatches '+(gl.getParameter(gl.CURRENT_PROGRAM)===program));
    }
  };
  const table=(data,w,h,rgba=false)=>{
    const texture=new T.DataTexture(data,w,h,rgba?T.RGBAIntegerFormat:T.RedIntegerFormat,T.UnsignedIntType);
    texture.internalFormat=rgba?'RGBA32UI':'R32UI';texture.minFilter=texture.magFilter=T.NearestFilter;
    texture.needsUpdate=true;textures.push(texture);return texture;
  };
  const inputState=()=>JSON.stringify({matrix:mesh.matrixWorld.elements,camera:camera.matrixWorld.elements,projection:camera.projectionMatrix.elements,
    uniforms:Object.fromEntries(Object.entries(common).map(([key,{value}])=>[key,
      value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:value]))});
  const firstInputs=inputState(),records=[],nativeExpected=[],pixelsExpected=[];let plan=null,maskExpected=null,frame=null,tileMask=null;
  let metadata=null,light=null,prepare=null,reduce=null,compose=null,overflow=null,base=null,badCached=null;
  try {
    r.debug.checkShaderErrors=true;camera.layers.set(2);r.autoClear=true;r.setClearColor(0,0);
    const output=rt(width,height,{type:T.HalfFloatType}),readback=rt(width,height);
    const original=make(production.fragmentShader),badFields=make(shaders.badFields);
    const copy=new T.ShaderMaterial({uniforms:{tInput:{value:output.texture}},depthTest:false,depthWrite:false,blending:T.NoBlending,
      vertexShader:fullscreen,fragmentShader:'uniform sampler2D tInput;void main(){gl_FragColor=texelFetch(tInput,ivec2(gl_FragCoord.xy),0);}'});
    materials.push(copy);
    if(!initial.direct){
      frame=rt(width,height,{count:4});
      frame.textures[1].type=T.HalfFloatType;
      frame.textures[2].type=T.UnsignedByteType;frame.textures[2].format=T.RedFormat;
      frame.textures[3].format=T.RedFormat;
      tileMask=rt(tilesX,tilesY,{type:T.UnsignedByteType});
      Object.assign(page,{tPageRay:{value:frame.textures[0]},tPageCached:{value:frame.textures[1]},
        tPageMask:{value:frame.textures[2]},tPageOpacity:{value:frame.textures[3]}});
      prepare=make(shaders.prepare,false,true);reduce=make(shaders.reduce,true);prepare.name='prepare';reduce.name='reduce';
      base=make(shaders.base,true);badCached=make(shaders.badCached,true);
    }
    const setupPages=next=>{
      metadata=rt(next.metadata.width,next.metadata.height,{count:4});
      light=rt(next.light.width,next.light.height,{type:beamBytes===2?T.HalfFloatType:T.FloatType,format:T.RedFormat});
      Object.assign(page,{tPage0:{value:metadata.textures[0]},tPage1:{value:metadata.textures[1]},
        tPage2:{value:metadata.textures[2]},tPage3:{value:metadata.textures[3]},tPageLight:{value:light.texture},
        tPageMetaMap:{value:table(next.metaMap,tilesX,tilesY)},tPageLightMap:{value:table(next.lightMap,tilesX,tilesY,true)},
        tPageMetaJobs:{value:table(next.metadataTable,next.metaTable.width,next.metaTable.height)},
        tPageLightJobs:{value:table(next.lightJobTable,next.lightTable.width,next.lightTable.height,true)}});
      page.uPageMetaColumns.value=Math.max(1,next.metadata.width/16);page.uPageLightColumns.value=Math.max(1,next.light.width/16);
      metadata.material=make(shaders.metadata,true,true);light.material=make(shaders.beams,true);
      compose=make(shaders.compose,true);overflow=make(shaders.overflow);compose.name='compose';overflow.name='overflow';
    };
    for(let round=0;round<rounds;round++)for(const index of round%2?[0,1]:[1,0]){
      let preparation=null,reduction=null,transport=null,composition=null,readbackCpuMs=0,planningCpuMs=0;
      if(index===0||initial.direct)composition=await timed(()=>draw(output,original));
      else {
        preparation=await timed(()=>draw(frame,prepare));reduction=await timed(()=>draw(tileMask,reduce,true));
        const bytes=new Uint8Array(tilesX*tilesY*4),readStarted=performance.now();
        r.readRenderTargetPixels(tileMask,0,0,tilesX,tilesY,bytes);readbackCpuMs=performance.now()-readStarted;
        const masks=Uint8Array.from({length:tilesX*tilesY},(_,i)=>bytes[i*4]);
        if(maskExpected && masks.some((value,i)=>value!==maskExpected[i]))throw Error('Light-page masks changed with fixed inputs');
        maskExpected||=masks;
        const started=performance.now(),next=planLightPages({width,height,tileMasks:masks,budgetBytes,beamBytes,maxTextureSize});
        planningCpuMs=performance.now()-started;
        if(!plan){plan=next;setupPages(plan);}
        if(next.metadataCount!==plan.metadataCount||next.lightCount!==plan.lightCount)throw Error('Unstable exact-page plan');
        transport=await timed(()=>{
          if(plan.metadataCount){draw(metadata,metadata.material,true);draw(light,light.material,true);}
        });
        composition=await timed(()=>{
          draw(output,base,true);
          if(plan.metadataCount)draw(output,compose,true,false);
          if(plan.overflowTiles)draw(output,overflow,false,false);
        });
      }
      const native=new Uint16Array(width*height*4);r.readRenderTargetPixels(output,0,0,width,height,native);
      let nativeRepeatChanged=0;if(nativeExpected[index])for(let i=0;i<native.length;i++)if(native[i]!==nativeExpected[index][i])nativeRepeatChanged++;
      nativeExpected[index]||=native;
      draw(readback,copy,true);const pixels=new Float32Array(width*height*4);r.readRenderTargetPixels(readback,0,0,width,height,pixels);
      pixelsExpected[index]||=pixels;
      records.push({round,implementation:index?'paged':'production',preparation,reduction,transport,composition,readbackCpuMs,planningCpuMs,
        gpuMs:[preparation,reduction,transport,composition].reduce((sum,stage)=>sum+(stage?.gpuMs||0),0),nativeRepeatChanged});
      console.log('Page: '+JSON.stringify(records.at(-1)));
    }
    const compare=pixels=>{const channels=[0,0,0,0];let maximumError=0;
      for(let i=0;i<pixels.length;i++){const error=Math.abs(pixels[i]-pixelsExpected[0][i]);if(error)channels[i%4]++;maximumError=Math.max(maximumError,error);}
      return {channels,maximumError,alphaChanged:channels[3]};};
    let badCachedControl=null;
    if(!initial.direct){draw(output,badCached,true);draw(readback,copy,true);const pixels=new Float32Array(width*height*4);
      r.readRenderTargetPixels(readback,0,0,width,height,pixels);badCachedControl=compare(pixels);}
    draw(output,badFields);draw(readback,copy,true);const wrong=new Float32Array(width*height*4);
    r.readRenderTargetPixels(readback,0,0,width,height,wrong);
    const occupied=Array.from(pixelsExpected[0]).filter((v,i)=>i%4===3&&v>.004).length;
    const chosen=initial.direct?initial:plan;
    const {metaMap,lightMap,metadataTable,lightJobTable,...summary}=chosen;
    const info=gl.getExtension('WEBGL_debug_renderer_info');
    return {width,height,budgetBytes,beamBytes,records,plan:summary,comparison:compare(pixelsExpected[1]),occupied,
      badCachedControl,badFieldsControl:compare(wrong),inputsChanged:inputState()!==firstInputs,inputs:JSON.parse(firstInputs),
      gl:gl.getError(),queuedWeatherMessages:messages.length,gpu:info?gl.getParameter(info.UNMASKED_RENDERER_WEBGL):null,
      scope:'Exact-query sparse tiles, complete cached radiance first, bounded intermediate texture bytes and original full transport on whole-tile overflow. Includes GPU reduction and synchronous CPU mask readback/planning. Static private scene; not a production async scheduler, complete frame acceptance or spatial interpolated light cache.'};
  }finally{
    r.debug.checkShaderErrors=debug;camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
    materials.forEach(m=>m.dispose());targets.forEach(t=>t.dispose());textures.forEach(t=>t.dispose());geometry.dispose();
    NMS._queryDepth.dispose();delete NMS._queryDepth;
    if(worker){worker.onmessage=receive;for(const event of messages)receive?.call(worker,event);}
    window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;for(const callback of pending.values())request.call(window,callback);
  }
}
