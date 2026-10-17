// Diagnostic only: compare explicitly supported complete near-cloud programs.
// Traversals and physical nodes stay fixed; same-count loop controls also
// require exact native HDR in addition to the common physical error gate.
export async function probeCloudExtinctionCall({warmRounds=3,expectedQuality=null,expectedSize=null,
  referenceFragmentShader=null,includeSources=false}={}) {
  const T=NMS._THREE,r=NMS._renderer,camera=NMS._internals.camera;
  const vp=NMS._pipeline.volumePass,p=vp?.activePlanet,production=p?.volCloudMat;
  const gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!ext)throw Error('Hardware timer required');
  if(!production||production.defines.PRODUCTION_CLOUD_MEDIUM!==1||production.defines.CLOUD_FAR_VIEW)
    throw Error('Production near-cloud medium required');
  if(production.uniforms.uLocalBands?.value!==1)throw Error('Production local bands must remain enabled');
  if(!NMS._queryDepth?.texture)throw Error('Runner must provide frozen actual opaque depth');
  if(!Number.isSafeInteger(warmRounds)||warmRounds<3||warmRounds>20)throw Error('Warm rounds must be an integer from 3 to 20');
  const stats=NMS.stats(),width=vp.width,height=vp.height;
  if(expectedQuality!==null&&stats.quality!==expectedQuality)throw Error('Unexpected actual quality');
  if(expectedSize!==null&&(expectedSize[0]!==width||expectedSize[1]!==height))throw Error('Unexpected actual volume size');
  const source=production.fragmentShader;
  if(source.split('float framePhase = mod(uFrame, 16.0);').length!==2)
    throw Error('Temporal phase authority changed; update distinct-phase controls');
  const oldWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        if (uLocalBands < 0.5) return densityAt(local) * legacySigma;
        vec2 layers = cloudLayersAt(local);
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
      }`;
  const sharedWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        vec2 layers = cloudLayersAt(local);
        if (uLocalBands < 0.5) return max(layers.x, layers.y * 0.06) * legacySigma;
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
      }`;
  const specializedWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        #if PRODUCTION_CLOUD_MEDIUM == 1
        vec2 layers = cloudLayersAt(local);
        return layers.x * 0.025 + layers.y * 0.0006;
        #else
        if (uLocalBands < 0.5) return densityAt(local) * legacySigma;
        vec2 layers = cloudLayersAt(local);
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
        #endif
      }`;
  const supported=[['shared-call',sharedWrapper],['production-specialized',specializedWrapper]];
  const matches=supported.filter(([,wrapper])=>source.includes(wrapper));
  let candidateKind,reference;
  if(source.includes('for(int star=0;star<uCloudSourceCount;star++)')) {
    const changes=[['for(int star=0;star<uCloudSourceCount;star++)','for(int star=0;star<2;star++)'],
      ['      uniform int uCloudSourceCount;\n','']];
    reference=source;candidateKind='uniform-star-loop';
    for(const [from,to] of changes) {
      if(reference.split(from).length!==2)throw Error('Star loop reference requires exactly one supported change');
      reference=reference.replace(from,to);
    }
    if(!source.includes(oldWrapper)||production.uniforms.uCloudSourceCount?.value!==2)
      throw Error('Star loop must preserve the original extinction and two sources');
  } else {
    if(matches.length!==1||source.split(matches[0][1]).length!==2)
      throw Error('Expected exactly one explicitly supported complete extinction wrapper');
    [candidateKind]=matches[0];reference=source.replace(matches[0][1],oldWrapper);
  }
  if(typeof referenceFragmentShader!=='string'||reference!==referenceFragmentShader)
    throw Error('Reconstructed old shader differs from the frozen reference');
  const productionOwnershipInvariant={verified:true,PRODUCTION_CLOUD_MEDIUM:production.defines.PRODUCTION_CLOUD_MEDIUM,
    uLocalBands:production.uniforms.uLocalBands.value,actualDrawLocalBandsRequired:1,
    relation:'Production is defined only with local bands enabled. The runner verifies constructor and Planet.setWeatherFixture ownership; all positive actual GPU draws must upload uLocalBands=1.',
    legacyBranch:'This matrix exercises production near mode; exact full-shader reconstruction bounds the edit, not legacy fixture acceptance.'};
  const head='float cloudExtinctionAt(vec3 local, float legacySigma) {';
  const begin=source.indexOf(head),open=source.indexOf('{',begin);
  if(begin<0||source.indexOf(head,begin+1)!==-1)throw Error('Expected one extinction wrapper');
  let close=open+1,nesting=1;
  while(nesting&&close<source.length){const c=source[close++];if(c==='{')nesting++;if(c==='}')nesting--;}
  if(nesting)throw Error('Unterminated extinction wrapper');
  const zeroSource=source.slice(0,open+1)+'return 0.0;'+source.slice(close-1);

  const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();
  const saved={target:r.getRenderTarget(),face:r.getActiveCubeFace(),mip:r.getActiveMipmapLevel(),
    auto:r.autoClear,mask:camera.layers.mask,color:r.getClearColor(new T.Color()),alpha:r.getClearAlpha(),
    shaderChecks:r.debug.checkShaderErrors};
  const resources=[],materials=[],queries=new Set(),messages=[];
  let id=-1,worker=null,receive=null,held=false;
  window.requestAnimationFrame=callback=>{const key=id--;pending.set(key,callback);return key;};
  window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel.call(window,key);};
  try {
    // Let the previously scheduled game callback finish once. Subsequent RAFs
    // and weather transactions wait until the whole paired capture is done.
    await new Promise(resolve=>request.call(window,resolve));
    worker=p.weatherStream?.worker;receive=worker?.onmessage;
    if(worker){worker.onmessage=event=>messages.push(event);held=true;}
    p.volCloudMesh.updateWorldMatrix(true,false);camera.updateMatrixWorld(true);
    const uniforms={...production.uniforms,
      uFrame:{value:0},
      tSceneDepth:{value:NMS._queryDepth.texture},uDepthReady:{value:1},
      uSunCacheReady:{value:production.uniforms.uSunCacheReady.value},
      uSecondarySunEnergy:{value:0},uSecondarySunDir:{value:new T.Vector3()},
      uSecondarySunC:{value:new T.Color(1,1,1)},
      uLocalStarCount:{value:2},
      uLocalStars:{value:production.uniforms.uLocalStars.value.map(value=>value.clone())},
      air_uSunEnergy1:{value:0},air_uSunDirection1:{value:new T.Vector3()},
      air_uSunColor1:{value:new T.Color(1,1,1)},
      air_uLocalStarCount:{value:2},
      air_uLocalStars:{value:production.uniforms.air_uLocalStars.value.map(value=>value.clone())},
      uSunCacheValidA:{value:production.uniforms.uSunCacheValidA.value.clone()},
      uSunCacheValidB:{value:production.uniforms.uSunCacheValidB.value.clone()}};
    const cacheReady=production.uniforms.uSunCacheReady.value;
    if(cacheReady<.5)throw Error('Runner must wait for a complete real light cache');
    const radial=production.uniforms.uCameraLocal.value.clone().normalize();
    const tangent=new T.Vector3().crossVectors(radial,Math.abs(radial.y)<.9
      ?new T.Vector3(0,1,0):new T.Vector3(1,0,0)).normalize();
    // Place the controlled star above the real camera's horizon. Rotating the
    // primary by an arbitrary tangent can put the second source underground.
    const second=radial.clone().multiplyScalar(.7).addScaledVector(tangent,.7).normalize();
    const primary=uniforms.uLocalStars.value[0];
    const starDistance=Math.hypot(primary.x,primary.y,primary.z),starRadius=primary.w;
    if(!(starDistance>0)||!(starRadius>0))throw Error('Synthetic star needs the real primary distance and radius');
    uniforms.uLocalStars.value[1].set(second.x*starDistance,second.y*starDistance,second.z*starDistance,starRadius);
    uniforms.air_uLocalStars.value[1].copy(uniforms.uLocalStars.value[1]);
    uniforms.air_uSunDirection1.value.copy(second);
    const syntheticStar={direction:second.toArray(),position:uniforms.uLocalStars.value[1].toArray(),
      distance:starDistance,radius:starRadius,cameraRadialCosine:second.dot(radial),color:[1,1,1],
      source:'Controlled second star; real primary distance/radius, overhead direction shared by cloud/air and stellar occlusion.'};
    const scene=new T.Scene(),mesh=new T.Mesh(p.volCloudMesh.geometry);
    mesh.layers.set(2);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;
    mesh.matrix.copy(p.volCloudMesh.matrixWorld);scene.add(mesh);scene.updateMatrixWorld(true);
    const make=(fragmentShader,name,overrides={})=>{
      const m=new T.ShaderMaterial({name,defines:{...production.defines},
        uniforms:{...uniforms,...overrides},vertexShader:production.vertexShader,fragmentShader,
        side:production.side,transparent:production.transparent,premultipliedAlpha:production.premultipliedAlpha,
        blending:production.blending,blendSrc:production.blendSrc,blendDst:production.blendDst,
        blendEquation:production.blendEquation,blendSrcAlpha:production.blendSrcAlpha,
        blendDstAlpha:production.blendDstAlpha,blendEquationAlpha:production.blendEquationAlpha,
        depthTest:production.depthTest,depthWrite:production.depthWrite,depthFunc:production.depthFunc,
        toneMapped:production.toneMapped});
      materials.push(m);return m;
    };
    const old=make(reference,'separate-extinction-call-reference');
    const current=make(source,candidateKind+'-extinction-call-production');
    const wrong=make(zeroSource,'zero-extinction-negative-control');
    const wrongStars=candidateKind==='uniform-star-loop'
      ?make(source,'zero-source-count-negative-control',{uCloudSourceCount:{value:0}}):null;
    const output=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false,
      minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const floatOutput=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false,
      minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    resources.push(output,floatOutput);
    const copyGeometry=new T.PlaneGeometry(2,2);resources.push(copyGeometry);
    const copyMaterial=new T.ShaderMaterial({uniforms:{tInput:{value:output.texture}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tInput;void main(){gl_FragColor=texelFetch(tInput,ivec2(gl_FragCoord.xy),0);}',
      depthTest:false,depthWrite:false,blending:T.NoBlending});materials.push(copyMaterial);
    const copyScene=new T.Scene(),copyCamera=new T.Camera();copyScene.add(new T.Mesh(copyGeometry,copyMaterial));
    r.debug.checkShaderErrors=true;r.autoClear=true;r.setClearColor(0,0);camera.layers.set(2);

    const bytesHash=data=>{
      const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);let hash=2166136261;
      for(let i=0;i<bytes.length;i++)hash=Math.imul(hash^bytes[i],16777619);
      return (hash>>>0).toString(16).padStart(8,'0');
    };
    const encode=value=>{
      if(value===null||typeof value!=='object')return value;
      if(value.isTexture){
        const image=value.image;
        return {texture:value.uuid,version:value.version,sourceVersion:value.source?.version,
          width:image?.width,height:image?.height,depth:image?.depth,
          data:image?.data&&ArrayBuffer.isView(image.data)?bytesHash(image.data):null};
      }
      if(ArrayBuffer.isView(value))return {type:value.constructor.name,length:value.length,hash:bytesHash(value)};
      if(Array.isArray(value))return value.map(encode);
      if(typeof value.toArray==='function')return value.toArray();
      return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,encode(item)]));
    };
    const snapshot=()=>{
      const value={geometry:mesh.geometry.uuid,matrix:mesh.matrixWorld.elements.slice(),
        camera:camera.matrixWorld.elements.slice(),projection:camera.projectionMatrix.elements.slice(),
        uniforms:Object.fromEntries(Object.entries(uniforms).map(([name,{value}])=>[name,encode(value)]))};
      const text=JSON.stringify(value);let hash=2166136261;
      for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);
      return {hash:(hash>>>0).toString(16).padStart(8,'0'),value};
    };
    const check=label=>{const code=gl.getError();if(code)throw Error(label+': GL '+code);};
    const draw=material=>{
      r.setRenderTarget(output);r.clear(true,false,false);mesh.material=material;
      // These are distinct explicit ShaderMaterial owners. Upload each one's
      // frozen input dictionary before its actual draw.
      material.uniformsNeedUpdate=true;r.render(scene,camera);
    };
    const localBandsUniform=material=>{
      const program=r.properties.get(material).currentProgram?.program;
      if(!program)throw Error('No actual draw program');
      const location=gl.getUniformLocation(program,'uLocalBands');
      return location===null?null:gl.getUniform(program,location);
    };
    const actualUniforms=material=>{
      const program=r.properties.get(material).currentProgram?.program;
      const names=['uCloudSourceCount','uLocalBands','uSecondarySunEnergy','uSecondarySunDir','uSecondarySunC','uLocalStarCount',
        'uLocalStars[0]','uLocalStars[1]','air_uSunEnergy1','air_uSunDirection1','air_uSunColor1',
        'air_uLocalStarCount','air_uLocalStars[0]','air_uLocalStars[1]'];
      return Object.fromEntries(names.map(name=>{
        const location=gl.getUniformLocation(program,name),value=location===null?null:gl.getUniform(program,location);
        return [name,ArrayBuffer.isView(value)?Array.from(value):value];
      }));
    };
    const capture=material=>{
      const begin=performance.now();draw(material);const submitted=performance.now();
      // A native readback, rather than the return from finish(), establishes
      // completion here. Keep query-based warm GPU costs separate from this
      // diagnostic draw + readback/copy wall time.
      gl.finish();const finishReturned=performance.now();check('Cold/capture draw '+material.name);
      const native=new Uint16Array(width*height*4);r.readRenderTargetPixels(output,0,0,width,height,native);
      const nativeReadbackCompleted=performance.now();
      r.setRenderTarget(floatOutput);r.clear(true,false,false);r.render(copyScene,copyCamera);
      const pixels=new Float32Array(native.length);r.readRenderTargetPixels(floatOutput,0,0,width,height,pixels);
      const copiedReadbackCompleted=performance.now();
      check('Native/float capture '+material.name);
      let finite=true,nativeCopyChanged=0,maximumNativeCopyError=0,occupied=0;
      let maximumRGB=0,minimumRGB=0,maximumAbsRGB=0,nonzeroRGBComponents=0,nonzeroRGBPixels=0;
      for(let i=0;i<native.length;i++){
        const decoded=T.DataUtils.fromHalfFloat(native[i]);
        if(!Number.isFinite(decoded)||!Number.isFinite(pixels[i]))finite=false;
        else if(decoded!==pixels[i]){nativeCopyChanged++;maximumNativeCopyError=Math.max(maximumNativeCopyError,Math.abs(decoded-pixels[i]));}
        if(i%4===3&&decoded>.004)occupied++;
        if(i%4!==3&&Number.isFinite(decoded)){
          maximumRGB=Math.max(maximumRGB,decoded);minimumRGB=Math.min(minimumRGB,decoded);
          maximumAbsRGB=Math.max(maximumAbsRGB,Math.abs(decoded));if(decoded!==0)nonzeroRGBComponents++;
        }
        if(i%4===0&&(pixels[i]!==0||pixels[i+1]!==0||pixels[i+2]!==0))nonzeroRGBPixels++;
      }
      return {native,pixels,summary:{submissionMs:submitted-begin,finishReturnedMs:finishReturned-begin,
        nativeReadbackCompletedMs:nativeReadbackCompleted-begin,copiedReadbackCompletedMs:copiedReadbackCompleted-begin,
        localBandsUniform:localBandsUniform(material),finite,nativeCopyChanged,maximumNativeCopyError,occupied,
        maximumRGB,minimumRGB,maximumAbsRGB,nonzeroRGBComponents,nonzeroRGBPixels,
        actualUniforms:actualUniforms(material),nativeHash:bytesHash(native)}};
    };
    const compare=(a,b)=>{
      const channels=[0,0,0,0];let maximumError=0,nonfinite=0,nativeChanged=0;
      for(let i=0;i<a.native.length;i++){
        if(a.native[i]!==b.native[i])nativeChanged++;
        if(!Number.isFinite(a.pixels[i])||!Number.isFinite(b.pixels[i])){nonfinite++;continue;}
        const error=Math.abs(a.pixels[i]-b.pixels[i]);
        if(error){channels[i%4]++;maximumError=Math.max(maximumError,error);}
      }
      return {nativeChanged,channelChanges:channels,alphaChanged:channels[3],maximumError,nonfinite,
        passed:nonfinite===0&&channels[3]===0&&maximumError<.002};
    };
    const timed=async material=>{
      if(gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))throw Error('Another GPU timer is active');
      const query=gl.createQuery();if(!query)throw Error('Could not create GPU timer');queries.add(query);
      gl.beginQuery(ext.TIME_ELAPSED_EXT,query);const begin=performance.now();
      try{draw(material);}finally{gl.endQuery(ext.TIME_ELAPSED_EXT);}
      const cpuMs=performance.now()-begin;gl.flush();
      const deadline=performance.now()+30000;
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)){
        if(performance.now()>deadline)throw Error('Warm GPU timer deadline');
        await new Promise(resolve=>setTimeout(resolve,5));
      }
      if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('GPU timer disjoint');
      const gpuMs=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(query);queries.delete(query);
      check('Warm draw '+material.name);return {cpuMs,gpuMs,localBandsUniform:localBandsUniform(material)};
    };
    const records=[];let zeroSecondary=null;
    // The shader folds uFrame modulo 16: historical 0/192 cases sampled the
    // same temporal phase. Use distinct phases for future candidates; retain
    // the old raw reports as repeated phase-zero controls, not phase coverage.
    for(const jitter of [0,7])for(const cache of [true,false])for(const secondaryEnergy of [0,.35]){
      uniforms.uFrame.value=jitter;uniforms.uSunCacheReady.value=cache?cacheReady:0;
      uniforms.uSecondarySunEnergy.value=secondaryEnergy;uniforms.uSecondarySunDir.value.copy(second);
      uniforms.air_uSunEnergy1.value=secondaryEnergy;
      uniforms.uSunCacheValidA.value.copy(production.uniforms.uSunCacheValidA.value);
      uniforms.uSunCacheValidB.value.copy(production.uniforms.uSunCacheValidB.value);
      // The synthetic star uses a new direction, so the old direction's field
      // is not a valid cache hit. Primary and radial fields retain real cache.
      uniforms.uSunCacheValidA.value.y=0;uniforms.uSunCacheValidB.value.y=0;
      const before=snapshot(),captures=[];
      for(const material of [old,current,old,current])captures.push(capture(material));
      let secondaryEffect=null;
      if(secondaryEnergy===0)zeroSecondary=captures[0];
      else {secondaryEffect=compare(zeroSecondary,captures[0]);zeroSecondary=null;}
      const originalRepeat=compare(captures[0],captures[2]),currentRepeat=compare(captures[1],captures[3]);
      const comparisons=[compare(captures[0],captures[1]),compare(captures[2],captures[3])];
      const warm=[];
      for(let round=0;round<warmRounds;round++)for(const material of round%2?[current,old]:[old,current])
        warm.push({round,implementation:material===old?'separate':'shared',...await timed(material)});
      const negative=capture(wrong),negativeComparison=compare(captures[0],negative);
      const negativeRejected=!negative.summary.finite||negativeComparison.nonfinite>0
        ||negativeComparison.alphaChanged>0||negativeComparison.maximumError>=.002;
      const sourceCountNegative=wrongStars?compare(captures[0],capture(wrongStars)):null;
      const sourceCountRejected=!sourceCountNegative||(sourceCountNegative.nonfinite===0
        &&sourceCountNegative.alphaChanged===0&&sourceCountNegative.maximumError>=.002);
      const sourceCountUploaded=candidateKind!=='uniform-star-loop'
        ||[captures[1],captures[3]].every(c=>c.summary.actualUniforms.uCloudSourceCount===2);
      const nativeExactRequired=candidateKind==='uniform-star-loop';
      const nativeQualityAccepted=!nativeExactRequired||comparisons.every(c=>c.nativeChanged===0);
      const restored=capture(current),after=snapshot(),restoreRepeat=compare(captures[1],restored);
      const inputsStable=before.hash===after.hash&&JSON.stringify(before.value)===JSON.stringify(after.value);
      const uploadedDirection=values=>Array.isArray(values)&&values.length===3
        &&values.every((value,i)=>value===Math.fround(second.getComponent(i)));
      const uploadedEnergy=value=>value!==null&&Math.abs(value-secondaryEnergy)<1e-6;
      const starUploadsValid=captures.every(({summary:{actualUniforms:u}})=>
        uploadedEnergy(u.uSecondarySunEnergy)&&uploadedDirection(u.uSecondarySunDir)&&u.uLocalStarCount===2
        &&uploadedEnergy(u.air_uSunEnergy1)&&uploadedDirection(u.air_uSunDirection1)&&u.air_uLocalStarCount===2
        &&Array.isArray(u['uLocalStars[1]'])&&u['uLocalStars[1]'].every((value,i)=>
          value===Math.fround(uniforms.uLocalStars.value[1].getComponent(i)))
        &&Array.isArray(u['air_uLocalStars[1]'])&&u['air_uLocalStars[1]'].every((value,i)=>
          value===Math.fround(uniforms.air_uLocalStars.value[1].getComponent(i))));
      const lit=captures.every(c=>c.summary.maximumRGB>0&&c.summary.nonzeroRGBPixels>1000);
      const passed=inputsStable&&captures.every(c=>c.summary.finite&&c.summary.nativeCopyChanged===0)
        &&originalRepeat.nativeChanged===0&&currentRepeat.nativeChanged===0&&restoreRepeat.nativeChanged===0
        &&comparisons.every(c=>c.passed)&&captures.every(c=>c.summary.localBandsUniform===1)
        &&captures[0].summary.occupied>1000&&lit&&starUploadsValid&&negativeRejected
        &&sourceCountRejected&&sourceCountUploaded&&nativeQualityAccepted
        &&(!secondaryEffect||(secondaryEffect.nonfinite===0&&secondaryEffect.alphaChanged===0));
      const violations=[];
      if(!inputsStable)violations.push('Frozen inputs changed inside the case');
      if(captures.some(c=>!c.summary.finite||c.summary.nativeCopyChanged!==0))violations.push('Invalid native HDR or Float32 copy');
      if(originalRepeat.nativeChanged!==0)violations.push('Old program native repeat changed');
      if(currentRepeat.nativeChanged!==0||restoreRepeat.nativeChanged!==0)violations.push('New program native repeat changed');
      if(comparisons.some(c=>!c.passed))violations.push('Original/new HDR or alpha gate failed');
      if(captures.some(c=>c.summary.localBandsUniform!==1))violations.push('Actual draw local-bands uniform is not one');
      if(captures[0].summary.occupied<=1000)violations.push('Need more than 1000 occupied production pixels');
      if(!lit)violations.push('Need positive nonzero cloud RGB at more than 1000 pixels');
      if(!starUploadsValid)violations.push('Actual GPU secondary-star inputs do not match the controlled fixture');
      if(!negativeRejected)violations.push('Zero-extinction negative control was not rejected');
      if(!sourceCountRejected)violations.push('Zero-source-count negative control was not rejected');
      if(!sourceCountUploaded)violations.push('Actual GPU source count must remain two');
      if(!nativeQualityAccepted)violations.push('Same-count star loop changed native HDR');
      if(secondaryEffect&&(secondaryEffect.nonfinite||secondaryEffect.alphaChanged))violations.push('Secondary control changed opacity or became nonfinite');
      records.push({jitter,framePhase:jitter%16,cache,secondaryEnergy,secondaryDirection:second.toArray(),inputHash:before.hash,
        inputsStable,captures:captures.map(c=>c.summary),originalRepeat,currentRepeat,comparisons,warm,
        negative:{...negative.summary,comparison:negativeComparison,rejected:negativeRejected},restoreRepeat,
        occupied:captures[0].summary.occupied,secondaryEffect,sourceCountNegative,sourceCountRejected,sourceCountUploaded,nativeExactRequired,nativeQualityAccepted,starUploadsValid,lit,passed,violations});
      console.log('Extinction call: '+JSON.stringify({jitter,cache,secondaryEnergy,passed,comparisons,
        negativeRejected,cold:captures.slice(0,2).map(c=>c.summary)}));
    }
    const debug=gl.getExtension('WEBGL_debug_renderer_info');check('Final extinction probe');
    const secondaryExercised=records.some(record=>record.secondaryEffect?.nativeChanged>0
      &&record.secondaryEffect.nonfinite===0&&record.secondaryEffect.alphaChanged===0);
    const violations=records.flatMap(({jitter,cache,secondaryEnergy,violations})=>
      violations.map(reason=>({jitter,cache,secondaryEnergy,reason})));
    if(!secondaryExercised)violations.push({reason:'Synthetic secondary star never changed native radiance'});
    return {width,height,warmRounds,candidateKind,productionOwnershipInvariant,quality:stats.quality,steps:production.uniforms.uMaxSteps.value,
      maximumViewSteps:production.uniforms.uViewCapacity.value,bins:production.uniforms.uLightQuadratureSteps.value,
      body:p.bodyId,cameraLocal:production.uniforms.uCameraLocal.value.toArray(),syntheticStar,records,
      passed:records.every(record=>record.passed)&&secondaryExercised,secondaryExercised,violations,queuedWeatherMessages:messages.length,
      reconstructionVerified:referenceFragmentShader!==null,gl:0,
      gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
      ...(includeSources?{shaders:{separate:reference,shared:source,negative:zeroSource}}:{}),
      scope:`Frozen actual near-cloud geometry, camera, opaque depth and weather; all nodes and quality steps retained. Candidate ${candidateKind} versus the exact frozen full reference shader. Production ownership requires PRODUCTION_CLOUD_MEDIUM=1 and uLocalBands=1; this is not legacy fixture acceptance. Frames 0/7 are distinct modulo-16 phases; same-count star-loop controls also require exact native HDR. Native HalfFloat repeats and Float32 copies; ${warmRounds} interleaved warm GPU samples per implementation in every case, separate from cold captures/readbacks. Synthetic secondary star always takes its own full physical beam. Tool waits/RAF holds are diagnostic, not player FPS or cold whole-page acceptance.`};
  } finally {
    for(const query of queries)if(!gl.isContextLost())gl.deleteQuery(query);
    r.debug.checkShaderErrors=saved.shaderChecks;camera.layers.mask=saved.mask;
    r.autoClear=saved.auto;r.setClearColor(saved.color,saved.alpha);r.setRenderTarget(saved.target,saved.face,saved.mip);
    materials.forEach(material=>material.dispose());resources.forEach(resource=>resource.dispose());
    // The frozen depth belongs to the runner; it can be reused or disposed
    // after the returned report has been checked.
    window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
    try {if(held&&worker){worker.onmessage=receive;for(const event of messages)receive?.call(worker,event);}}
    finally {for(const callback of pending.values())request.call(window,callback);}
  }
}
