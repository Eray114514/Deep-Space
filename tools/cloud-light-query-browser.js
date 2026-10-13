// Tool-only prototype: R32F optical depth per actual visible anchor/field.
// This does not reduce density resolution, share neighbouring queries, or
// truncate fallback beams. Its allocation/update cost is included in timings.
export function cloudLightQueryPreparation(source) {
  const start=source.indexOf('        vec3 correction=vec3(0);'),end=source.indexOf('        #else',start);
  if(start<0||end<0)throw Error('Production anchor boundary changed');
  const rays=source.slice(0,start)+'gl_FragColor=vec4(dir,sigma);\n'+source.slice(end);
  const anchors=('layout(location=0) out vec4 query0;layout(location=1) out vec4 query1;'+
    'layout(location=2) out vec4 query2;layout(location=3) out vec4 query3;\n'+source.slice(0,start)+
    'query0=vec4(anchors[0],anchors[1],anchors[2],anchors[3]);query1=vec4(anchors[4],anchors[5],anchors[6],anchors[7]);'+
    'query2=vec4(anchors[8],anchors[9],anchors[10],anchors[11]);query3=vec4(anchors[12],anchors[13],anchors[14],anchors[15]);\n'+source.slice(end))
    .replaceAll('gl_FragColor','query0');
  return {rays,anchors};
}

export async function probeLightQueries() {
  const T=NMS._THREE,r=NMS._renderer,camera=NMS._internals.camera;
  const vp=NMS._pipeline.volumePass,p=vp.activePlanet,production=p.volCloudMat;
  const gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const checkShaderErrors=r.debug.checkShaderErrors;r.debug.checkShaderErrors=true;
  if(!ext)throw Error('Hardware GPU timer required');
  const width=vp.width,height=vp.height,bins=production.uniforms.uLightQuadratureSteps.value;
  if(bins!==16 || production.defines.CLOUD_FAR_VIEW)throw Error('Prototype requires actual 16-anchor near view');
  if(width*4>gl.getParameter(gl.MAX_TEXTURE_SIZE)||height*bins>gl.getParameter(gl.MAX_TEXTURE_SIZE))
    throw Error('Query atlas exceeds device dimensions');
  const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let id=-1;
  window.requestAnimationFrame=callback=>{const key=id--;pending.set(key,callback);return key;};
  window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel.call(window,key);};
  await new Promise(resolve=>request.call(window,resolve));
  const worker=p.weatherStream?.worker,receive=worker?.onmessage,messages=[];
  if(worker)worker.onmessage=event=>messages.push(event);
  const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
  const auto=r.autoClear,mask=camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
  const uniforms={...production.uniforms,uFrame:{value:0},tSceneDepth:{value:NMS._queryDepth.texture}};
  const scene=new T.Scene(),mesh=new T.Mesh(p.volCloudMesh.geometry,production);
  mesh.layers.set(2);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;
  mesh.matrix.copy(p.volCloudMesh.matrixWorld);scene.add(mesh);scene.updateMatrixWorld(true);
  const options={type:T.FloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter};
  const anchors=new T.WebGLRenderTarget(width,height,{...options,count:4});
  const rays=new T.WebGLRenderTarget(width,height,options);
  const beams=new T.WebGLRenderTarget(width*4,height*bins,{...options,format:T.RedFormat});
  const halfBeams=new T.WebGLRenderTarget(width*4,height*bins,{...options,type:T.HalfFloatType,format:T.RedFormat});
  const output=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
  const readback=new T.WebGLRenderTarget(width,height,options);
  const materials=[],targets=[anchors,rays,beams,halfBeams,output,readback],geometry=new T.PlaneGeometry(2,2);
  const quadScene=new T.Scene(),quadCamera=new T.Camera(),quad=new T.Mesh(geometry);quadScene.add(quad);
  const make=(shader,vertex=production.vertexShader,more={})=>{
    const m=new T.ShaderMaterial({defines:{...production.defines},uniforms:{...uniforms,...more},
      vertexShader:vertex,fragmentShader:shader,depthTest:false,depthWrite:false,blending:T.NoBlending,
      side:vertex===production.vertexShader?production.side:T.DoubleSide});materials.push(m);return m;
  };
  const prefix=production.fragmentShader.slice(0,production.fragmentShader.lastIndexOf('void main()'));
  const fullscreen='varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}';
  const declarations='uniform sampler2D tQuery0,tQuery1,tQuery2,tQuery3,tQueryRay,tQueryBeam;uniform ivec2 uQuerySize;';
  const queryUniforms={tQuery0:{value:anchors.textures[0]},tQuery1:{value:anchors.textures[1]},
    tQuery2:{value:anchors.textures[2]},tQuery3:{value:anchors.textures[3]},tQueryRay:{value:rays.texture},
    tQueryBeam:{value:beams.texture},uQuerySize:{value:new T.Vector2(width,height)}};
  const preparationShaders=cloudLightQueryPreparation(production.fragmentShader);
  const rayMaterial=make(preparationShaders.rays);
  // GLSL3 provides explicit multiple render targets. Three still expands the
  // historical texture/varying aliases, but gl_FragColor must be declared for
  // the retained (compile-time pruned) legacy/far branches.
  const anchorMaterial=make(preparationShaders.anchors);
  anchorMaterial.glslVersion=T.GLSL3;
  anchorMaterial.name='query-anchors';rayMaterial.name='query-rays';
  const beamMaterial=make(prefix+declarations+`
    void main(){ivec2 pixel=ivec2(gl_FragCoord.xy),cell=pixel%uQuerySize;
      int field=pixel.x/uQuerySize.x,bin=pixel.y/uQuerySize.y;
      vec4 ray=texelFetch(tQueryRay,cell,0);
      if(dot(ray.xyz,ray.xyz)<.5){gl_FragColor=vec4(0);return;}
      vec4 group=bin<4?texelFetch(tQuery0,cell,0):bin<8?texelFetch(tQuery1,cell,0):bin<12?texelFetch(tQuery2,cell,0):texelFetch(tQuery3,cell,0);
      float distance=group[bin%4];vec3 local=uCameraLocal+ray.xyz*distance;
      vec3 direction=field==0?normalize(uSunDir):field==1?normalize(uSecondarySunDir):field==2?normalize(local):-normalize(local);
      if(field==1 && uSecondarySunEnergy<=0.0){gl_FragColor=vec4(0);return;}
      if(field<2){float radius=length(local),muSun=dot(local/radius,direction);
        float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(radius*radius)));
        if(muSun<=horizon-0.018 || eclipseVisibility(local,direction)<=0.0){gl_FragColor=vec4(0);return;}}
      float depth=0.0;bool cached=cloudCachedLight(local,field,depth);
      if(!cached)depth=cloudSunOpticalDepthLimit(local,direction,ray.w,field<2?12.0:128.0);
      gl_FragColor=vec4(depth,0,0,1);
    }`,fullscreen,queryUniforms);
  const original=make(production.fragmentShader);
  const call='if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
  if(!production.fragmentShader.includes(call))throw Error('Physical beam call changed');
  const consumer=make(production.fragmentShader.replace('vec3 cloudCombinedSource(',declarations+'\nint queryBin=0;\nvec3 cloudCombinedSource(')
    .replace(call,'if(!cached)pathDepth=texelFetch(tQueryBeam,ivec2(gl_FragCoord.xy)+ivec2(path*uQuerySize.x,queryBin*uQuerySize.y),0).r;')
    .replace('vec3 source=cloudCombinedSource(local,dir,0.0,thick,sigma)*uTint;',
      'queryBin=bin;vec3 source=cloudCombinedSource(local,dir,0.0,thick,sigma)*uTint;'),production.vertexShader,queryUniforms);
  const copy=make('uniform sampler2D tInput;void main(){gl_FragColor=texelFetch(tInput,ivec2(gl_FragCoord.xy),0);}',fullscreen,{tInput:{value:output.texture}});
  const zeroAllFields=make(consumer.fragmentShader.replace('bool cached=cloudCachedLight(local,path,pathDepth);',
    'bool cached=false;'),production.vertexShader,queryUniforms);
  const timed=async work=>{
    const query=gl.createQuery(),started=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    try{work();}finally{gl.endQuery(ext.TIME_ELAPSED_EXT);}const cpuMs=performance.now()-started;gl.flush();
    while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))await new Promise(resolve=>setTimeout(resolve,5));
    if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint timer');
    const gpuMs=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(query);return {cpuMs,gpuMs};
  };
  const draw=(target,material,full=false)=>{
    const previous=gl.getError();if(previous)throw Error(`Before query draw: GL ${previous}`);
    r.setRenderTarget(target);r.clear(true,false,false);
    const setup=gl.getError();if(setup)throw Error(`Query setup ${material.name}: GL ${setup}`);
    if(full){quad.material=material;r.render(quadScene,quadCamera);}else{mesh.material=material;r.render(scene,camera);}
    const error=gl.getError();if(error){
      const program=r.properties.get(material).currentProgram.program,samplers=[];
      for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++){
        const u=gl.getActiveUniform(program,i);
        if([gl.SAMPLER_2D,gl.SAMPLER_3D,gl.SAMPLER_2D_ARRAY,gl.UNSIGNED_INT_SAMPLER_2D_ARRAY].includes(u.type))
          samplers.push({name:u.name,type:u.type,unit:gl.getUniform(program,gl.getUniformLocation(program,u.name))});
      }
      throw Error(`Query draw ${material.name||material.id}: GL ${error}; FBO ${gl.checkFramebufferStatus(gl.FRAMEBUFFER)}; link ${gl.getProgramInfoLog(program)}; samplers ${JSON.stringify(samplers)}`);
    }
  };
  const records=[],nativeExpected=[],pixelsExpected=[];let occupied=0;
  const inputState=()=>JSON.stringify({geometry:mesh.geometry.uuid,matrix:mesh.matrixWorld.elements,
    cameraWorld:camera.matrixWorld.elements,projection:camera.projectionMatrix.elements,
    uniforms:Object.fromEntries(Object.entries(uniforms).map(([name,{value}])=>[name,
      value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:value]))});
  const firstInputs=inputState();
  try {
    camera.layers.set(2);r.autoClear=true;r.setClearColor(0,0);
    for(let round=0;round<7;round++)for(const index of round%2?[0,2,1]:[1,2,0]) {
      const split=index>0,selectedBeams=index===2?halfBeams:beams;
      queryUniforms.tQueryBeam.value=selectedBeams.texture;
      let preparation=null,transport=null,composition=null;
      if(split){preparation=await timed(()=>{draw(anchors,anchorMaterial);draw(rays,rayMaterial);});
        transport=await timed(()=>draw(selectedBeams,beamMaterial,true));}
      composition=await timed(()=>draw(output,split?consumer:original));
      const native=new Uint16Array(width*height*4);r.readRenderTargetPixels(output,0,0,width,height,native);
      let nativeRepeatChanged=0;
      if(nativeExpected[index])for(let i=0;i<native.length;i++)if(native[i]!==nativeExpected[index][i])nativeRepeatChanged++;
      nativeExpected[index]||=native;
      draw(readback,copy,true);const pixels=new Float32Array(width*height*4);r.readRenderTargetPixels(readback,0,0,width,height,pixels);
      pixelsExpected[index]||=pixels;
      records.push({round,implementation:index===2?'split-half':split?'split-float':'production',preparation,transport,composition,
        gpuMs:composition.gpuMs+(preparation?.gpuMs||0)+(transport?.gpuMs||0),nativeRepeatChanged});
      console.log('Query: '+JSON.stringify(records.at(-1)));
    }
    const compare=pixels=>{
      const channelChanges=[0,0,0,0];let maximumError=0;
      for(let i=0;i<pixels.length;i++){
        const error=Math.abs(pixelsExpected[0][i]-pixels[i]);if(error)channelChanges[i%4]++;
        maximumError=Math.max(maximumError,error);
      }return {channelChanges,maximumError,alphaChanged:channelChanges[3]};
    };
    for(let i=3;i<pixelsExpected[0].length;i+=4)if(pixelsExpected[0][i]>.004)occupied++;
    const comparisons=[1,2].map(index=>({implementation:index===1?'split-float':'split-half',...compare(pixelsExpected[index]),
      intermediateBytes:width*height*(80+(index===1?4:2)*4*bins)}));
    // Deliberately wrong radiance: clearing every physical query must be
    // distinguishable from the valid consumer. This is never a runtime mode.
    queryUniforms.tQueryBeam.value=beams.texture;r.setRenderTarget(beams);r.clear(true,false,false);
    draw(output,consumer);draw(readback,copy,true);
    const wrong=new Float32Array(width*height*4);r.readRenderTargetPixels(readback,0,0,width,height,wrong);
    const zeroBeamControl=compare(wrong);
    draw(output,zeroAllFields);draw(readback,copy,true);
    r.readRenderTargetPixels(readback,0,0,width,height,wrong);
    const zeroAllFieldsControl=compare(wrong);
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {width,height,bins,records,occupied,comparisons,zeroBeamControl,zeroAllFieldsControl,gl:gl.getError(),queuedWeatherMessages:messages.length,
      inputs:JSON.parse(firstInputs),inputsChanged:inputState()!==firstInputs,
      maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),maxDrawBuffers:gl.getParameter(gl.MAX_DRAW_BUFFERS),
      gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
      prototypeIntermediateBytes:width*height*(80+6*4*bins),
      scope:'Tool-only per-visible-query splitting. 16 FP32 anchor distances and FP32 rays; separate R32F/R16F optical-depth representations with their own error/memory gates. Same physical cached/missed paths and ordered air/cloud composition. All per-frame preparation/transport/composition GPU costs included; static private scene, frozen real depth/jitter. Single 2K pose is not full 2K/motion/dynamic acceptance. Clear-fallback and zero-all-fields controls deliberately wrong, not shipped; a fallback-insensitive pose only tests metadata/cached composition and cost.'};
  } finally {
    r.debug.checkShaderErrors=checkShaderErrors;camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
    materials.forEach(m=>m.dispose());targets.forEach(t=>t.dispose());geometry.dispose();
    NMS._queryDepth.dispose();delete NMS._queryDepth;
    if(worker){worker.onmessage=receive;for(const event of messages)receive?.call(worker,event);}
    window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
    for(const callback of pending.values())request.call(window,callback);
  }
}
