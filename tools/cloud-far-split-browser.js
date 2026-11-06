// Single real-body numerical prototype, intentionally outside the runtime.
export async function probeCloudFarSplit({union=1,referenceFirst=false}={}) {
  const T=await import('three');
  const {Planet,setVolumetricCloudsEnabled}=await import('/src/planet.js');
  const {sampleProductionMedium}=await import('/src/cloud/production-shape.js');
  const {AtmospherePass}=await import('/src/atmosphere-pass-webgl.js');
  const {createMultipleScatteringLut}=await import('/src/atmosphere-multiple-scattering.js');
  const {compilePrograms}=await import('/src/program-preparation.js');
  const {installProgramRetirement}=await import('/src/program-retirement.js');
  const {cloudFarSplitShaders}=await import('/tools/cloud-far-split-shaders.js');
  const require=(condition,message)=>{if(!condition)throw Error(message);};
  require(union===0||union===1,'Explicit UNION0 or UNION1 control');
  require(typeof referenceFirst==='boolean','Explicit reference preparation order');
  const width=32,height=24,hdrTolerance=.002,compileLimitMs=120000,referenceLimitMs=240000;
  const renderer=new T.WebGLRenderer({antialias:false});renderer.setSize(width,height);
  renderer.autoClear=false;
  const gl=renderer.getContext(),retirement=installProgramRetirement(renderer);
  require(gl.getExtension('EXT_color_buffer_float'),'RGBA32F scratch required');
  require(gl.getExtension('KHR_parallel_shader_compile'),'KHR readiness required');
  const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const materials=[],targets=[],textures=[],queries=new Set(),nativeSources=[],records=[],preparations=[];
  const originalShaderSource=gl.shaderSource;
  gl.shaderSource=function(shader,source){nativeSources.push({type:gl.getShaderParameter(shader,gl.SHADER_TYPE),source});return originalShaderSource.call(this,shader,source);};
  const result={width,height,hdrTolerance,compileLimitMs,referenceLimitMs,union,referenceFirst,records,preparations,nativeSources,
    boundary:'Single controlled real Planet/full production cloud kernel and actual AtmospherePass optical/multiple LUTs. Constructed column/cache resources. No multi-body sorting/fade ownership, temporal pipeline, normal player or 2K budget acceptance. '
      +(union===1?'Both paths enable complete multi-occluder UNION1.':'UNION0 retains the existing production Far multi-occluder omission on both paths; it does not validate UNION1 optical transport.')};
  window.__cloudFarSplit={result,status:'setup'};
  const camera=new T.PerspectiveCamera(3,width/height,.1,1e9),scene=new T.Scene();
  let planet,atmosphere,multiple;
  const allocate=(type=T.FloatType,depth=false)=>{
    const rt=new T.WebGLRenderTarget(width,height,{type,depthBuffer:depth,
      depthTexture:depth?new T.DepthTexture(width,height,T.UnsignedIntType):null,
      minFilter:T.NearestFilter,magFilter:T.NearestFilter});targets.push(rt);return rt;
  };
  const texture=(values,w=4,h=2)=>{
    const data=new Float32Array(w*h*4);for(let i=0;i<w*h;i++)data.set(values,i*4);
    const tex=new T.DataTexture(data,w,h,T.RGBAFormat,T.FloatType);tex.wrapS=T.RepeatWrapping;
    tex.minFilter=tex.magFilter=T.NearestFilter;tex.needsUpdate=true;textures.push(tex);return tex;
  };
  const read=rt=>{const raw=rt.texture.type===T.FloatType?new Float32Array(width*height*4):new Uint16Array(width*height*4);
    renderer.readRenderTargetPixels(rt,0,0,width,height,raw);
    const values=raw instanceof Float32Array?Array.from(raw):Array.from(raw,T.DataUtils.fromHalfFloat);
    require(values.every(Number.isFinite),'Finite native pixels');return {raw:Array.from(raw),values};};
  const difference=(a,b)=>{let changed=0,maximumError=0;for(let i=0;i<a.length;i++){
    if(a[i]!==b[i])changed++;maximumError=Math.max(maximumError,Math.abs(a[i]-b[i]));}return {changed,maximumError};};
  const clear=(rt,color=[0,0,0],alpha=0)=>{renderer.setRenderTarget(rt);renderer.setClearColor(new T.Color(...color),alpha);renderer.clear(true,true,false);};
  let mesh;
  async function prepare(name,material,limit=compileLimitMs){
    window.__cloudFarSplit.status='compile '+name;mesh.material=material;renderer.setRenderTarget(pointRT);
    const begin=performance.now();await compilePrograms(renderer,mesh,camera,scene,{timeoutMs:limit});
    const durationMs=performance.now()-begin,program=renderer.properties.get(material).currentProgram.program;
    const linked=gl.getProgramParameter(program,gl.LINK_STATUS),uniforms=gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);
    require(linked,'Linked '+name);const row={name,durationMs,limit,originalDeadlinePassed:durationMs<compileLimitMs,linked,uniforms};preparations.push(row);
    if(name!=='reference')require(row.originalDeadlinePassed,'Candidate original 120s deadline '+name);
  }
  const pointRT=allocate(),cachedRT=allocate(),floatRT=allocate(),halfRT=allocate(T.HalfFloatType),depthRT=allocate(T.HalfFloatType,true);
  const image=(name,values)=>{const row=document.createElement('div');row.className='row';
    const label=document.createElement('p');label.textContent=name;row.append(label);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d'),data=ctx.createImageData(width,height);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const from=((height-y-1)*width+x)*4,to=(y*width+x)*4;
      for(let c=0;c<3;c++)data.data[to+c]=Math.round(255*Math.pow(Math.max(0,Math.min(1,values[from+c])),1/2.2));data.data[to+3]=255;}
    ctx.putImageData(data,0,0);row.append(canvas);document.body.append(row);};
  try {
    setVolumetricCloudsEnabled(true);
    planet=new Planet({seed:'far-split-full-kernel',name:'Controlled Far split',type:'lush',radius:6e6,posUniv:new T.Vector3(),
      ringSystem:{present:false},tuning:{cloudCoverage:.8,weatherStyle:'temperate-synoptic'}});
    require(planet.volCloudFarMat?.defines.PRODUCTION_CLOUD_MEDIUM===1,'Real production Planet material');
    const u=planet.volCloudMat.uniforms;
    u.uSpin.value.setFromMatrix4(new T.Matrix4().makeRotationY(-planet.cloudSpinBase));
    let best={density:0};
    for(let lat=-60;lat<=60;lat+=30)for(let lon=0;lon<360;lon+=30)for(const altitude of [1500,3500,5500,8500,11500]){
      const phi=lat*Math.PI/180,theta=lon*Math.PI/180,radial=new T.Vector3(Math.cos(phi)*Math.cos(theta),Math.sin(phi),Math.cos(phi)*Math.sin(theta));
      const sample=sampleProductionMedium(planet,radial.clone().multiplyScalar(planet.R+altitude));
      if(sample.extinctionPerMeter>(best.extinctionPerMeter||0))best={radial:radial.toArray(),altitude,...sample};
    }
    require(best.extinctionPerMeter>0,'A nonempty production cloud column');result.selectedDensity=best;
    const radial=new T.Vector3(...best.radial),tangent=new T.Vector3().crossVectors(radial,new T.Vector3(0,1,0)).normalize();
    const primary=radial.clone().multiplyScalar(.9).addScaledVector(tangent,.3).normalize();
    const secondary=radial.clone().multiplyScalar(.65).addScaledVector(tangent,-.75).normalize();
    const sources=[{direction:primary.toArray(),color:[1,.98,.94],distance:1e12,radius:2e10,irradianceFraction:.65},
      {direction:secondary.toArray(),color:[.8,.9,1],distance:1.2e12,radius:2.4e10,irradianceFraction:.35}];
    planet.setStellarLights({sources,radianceScale:3.2});
    const surface=radial.clone().multiplyScalar(planet.R+5000),blockers=[];
    for(const direction of [primary,secondary]){
      const across=new T.Vector3().crossVectors(direction,radial).normalize();
      for(const offset of [-180000,180000])blockers.push({centerLocal:surface.clone().addScaledVector(direction,2e7).addScaledVector(across,offset),radius:180000});
    }
    planet.setStellarOccluders(blockers);
    camera.position.copy(radial).multiplyScalar(planet.R+600000);camera.lookAt(surface);camera.updateMatrixWorld(true);
    atmosphere=new AtmospherePass(camera);atmosphere.setActivePlanet(planet,new T.Vector3());
    // Use the exact producer called by AtmospherePass.render, without drawing
    // an unrelated full-screen atmosphere program before cloud preparation.
    const createMultipleLut=()=>{
      const begin=performance.now();window.__cloudFarSplit.status='actual multiple-scattering LUT';
      multiple=createMultipleScatteringLut(renderer,atmosphere.material.uniforms);
      atmosphere.material.uniforms.tMultipleScattering.value=multiple.texture;atmosphere.material.uniforms.uMultipleEnabled.value=1;
      result.multipleLutSubmitMs=performance.now()-begin;
    };
    if(!referenceFirst)createMultipleLut();
    for(const [name,uniform]of Object.entries(atmosphere.material.uniforms))if(name.startsWith('u')||name==='tOpticalDepth'||name==='tMultipleScattering')u['air_'+name]=uniform;
    u.uCameraLocal.value.copy(camera.position);u.uEngage.value=1;u.uFrame.value=0;u.uVolumeSize.value.set(width,height);u.uCameraFar.value=camera.far;
    u.uDepthViewToLocal.value.setFromMatrix4(camera.matrixWorld);u.uDepthInvProjection.value.copy(camera.projectionMatrixInverse);
    u.tSceneDepth.value=depthRT.depthTexture;u.uDepthReady.value=0;
    const low=Math.max(1000,planet.volCloudBand.rIn-planet.R+500),high=Math.min(planet.volCloudBand.rOut-planet.R-500,low+6500);
    require(high>low+1000,'Distinct low/high cloud decks');
    const columns=texture([.55,.36,Math.log(2.5)/Math.log(129),Math.log(1.8)/Math.log(129)]),heights=texture([low,high,.75,0]);
    u.uOpticalColumns.value=columns;u.uOpticalColumnsNext.value=columns;u.uColumnHeights.value=heights;u.uColumnHeightsNext.value=heights;
    u.uColumnMix.value=.375;u.uColumnsJointReady.value=1;
    u.uSunTransport.value=texture([.3,0,0,1],32,1);u.uSunCacheDepth.value=1;u.uSunCacheReady.value=1;
    u.uSunCacheValidA.value.set(1,1,1,1);u.uSunCacheValidB.value.set(1,1,1,1);
    for(const field of ['uSunCacheMatrixA','uSunCacheMatrixB'])for(const matrix of u[field].value)
      matrix.set(0,0,0,.5,0,0,0,.5,0,0,0,.5,0,0,0,1);
    result.fixture={radius:planet.R,band:{...planet.volCloudBand},camera:camera.position.toArray(),sources,
      blockers:blockers.map(b=>[...b.centerLocal.toArray(),b.radius]),columns:[.55,.36,1.5,.8],heights:[low,high],jointOpacity:.75,
      lightCache:'Controlled constant .3 optical depth for all four fields; one case forces the unchanged physical beam fallback.'};
    const referenceSource=planet.volCloudFarMat.fragmentShader,split=cloudFarSplitShaders(referenceSource);
    result.sources={reference:referenceSource,...split};
    const make=source=>{const m=planet.volCloudFarMat.clone();m.fragmentShader=source;m.uniforms={...u};
      m.defines={...m.defines,CLOUD_FAR_VIEW:1,CLOUD_FAR_CACHE:0,STELLAR_UNION_OCCLUSION:union};
      m.uniforms.uSplitPoint={value:pointRT.texture};m.uniforms.uSplitCached={value:cachedRT.texture};m.toneMapped=false;
      materials.push(m);return m;};
    const reference=make(referenceSource),point=make(split.point),cached=make(split.cached),combine=make(split.combine),wrong=make(split.wrongOver),coverage=make(split.coverage);
    for(const m of [point,cached,coverage])m.blending=T.NoBlending;
    mesh=new T.Mesh(planet.volCloudMesh.geometry,point);mesh.frustumCulled=false;scene.add(mesh);
    if(referenceFirst){await prepare('reference',reference,referenceLimitMs);createMultipleLut();}
    for(const [name,m]of [['point',point],['cached',cached],['combine',combine],['wrong-over',wrong],['coverage',coverage]])await prepare(name,m);
    if(!referenceFirst)await prepare('reference',reference,referenceLimitMs);
    const depthScene=new T.Scene(),depthCamera=new T.Camera(),depthGeometry=new T.PlaneGeometry(2,2);
    const depthMaterial=new T.ShaderMaterial({depthTest:true,depthWrite:true,uniforms:{far:{value:camera.far},distance:{value:600000-(low+high)*.5}},
      vertexShader:'void main(){gl_Position=vec4(position.xy,0.,1.);}',fragmentShader:`uniform float far,distance;
        void main(){float d=gl_FragCoord.x<16.?distance:900000.;gl_FragDepth=log2(1.+d)/log2(1.+far);gl_FragColor=vec4(0);}`});
    materials.push(depthMaterial);depthScene.add(new T.Mesh(depthGeometry,depthMaterial));
    clear(depthRT);renderer.render(depthScene,depthCamera);depthGeometry.dispose();
    function draw(material,rt){mesh.material=material;renderer.setRenderTarget(rt);renderer.render(scene,camera);}
    function render(mode,rt,blend=false){clear(rt,blend?[.08,.13,.21]:[0,0,0],blend?.25:0);
      reference.blending=combine.blending=wrong.blending=blend?T.NormalBlending:T.NoBlending;
      if(mode==='reference')draw(reference,rt);
      else {clear(pointRT);draw(point,pointRT);clear(cachedRT);draw(cached,cachedRT);draw(mode==='wrong'?wrong:combine,rt);}
      return read(rt);
    }
    const transitionName=`transition-union${union}-gap`;
    const configs=[
      {name:'no-columns-point',fov:3,ready:0},
      {name:'ready-resolved-point',fov:1,ready:1},
      {name:transitionName,fov:3,ready:1,transition:true},
      {name:'fully-cached-gap',fov:10,ready:1},
      {name:'transition-depth-cutoff',fov:3,ready:1,depth:true},
      {name:'transition-fading',fov:3,ready:1,engage:.37},
      {name:'transition-physical-beams',fov:3,ready:1,physical:true},
      {name:'transition-clear-occluders',fov:3,ready:1,clearOccluders:true},
      {name:'transition-single-star',fov:3,ready:1,singleStar:true},
    ];
    const positive=new Map();
    for(const config of configs){window.__cloudFarSplit.status=config.name;
      camera.fov=config.fov;camera.updateProjectionMatrix();u.uDepthInvProjection.value.copy(camera.projectionMatrixInverse);
      u.uColumnsReady.value=config.ready;u.uEngage.value=config.engage??1;u.uDepthReady.value=Number(!!config.depth);u.uSunCacheReady.value=config.physical?0:1;
      u.uLocalOccluderCount.value=u.air_uLocalOccluderCount.value=config.clearOccluders?0:blockers.length;
      u.uSecondarySunEnergy.value=u.air_uSunEnergy1.value=config.singleStar?0:.35;
      clear(floatRT);draw(coverage,floatRT);const mask=read(floatRT).values;
      const weights=mask.filter((_,i)=>i%4===0),covered=mask.filter((_,i)=>i%4===2).filter(v=>v>0).length;
      const row={...config,covered,weights:{minimum:Math.min(...weights),maximum:Math.max(...weights),transition:weights.filter(w=>w>0&&w<1).length},formats:[]};
      require(covered>0,'Visible shell '+config.name);if(config.transition)require(row.weights.transition>0,'Actual intermediate footprint');
      for(const [format,rt,blend]of [['float32',floatRT,false],['half-over',halfRT,true]]){
        const a=render('reference',rt,blend),a2=render('reference',rt,blend),b=render('split',rt,blend),b2=render('split',rt,blend);
        require(difference(a.raw,a2.raw).changed===0&&difference(b.raw,b2.raw).changed===0,'Both native repetitions '+config.name+' '+format);
        const comparison=difference(a.values,b.values);require(comparison.maximumError<=hdrTolerance,'Original HDR tolerance '+config.name+' '+format);
        row.formats.push({format,comparison,nativeChanged:difference(a.raw,b.raw).changed,reference:a.raw,candidate:b.raw,repeatChanged:0});
        if(format==='float32'){positive.set(config.name,a.values);require(a.values.some((v,i)=>i%4===3&&v>.004),'Nonempty cloud alpha '+config.name);
          if(config.transition){const negative=render('wrong',rt,false);row.wrongOver=difference(a.values,negative.values);
            require(row.wrongOver.maximumError>hdrTolerance,'Incorrect over negative must fail original gate');image(config.name+' reference',a.values);image(config.name+' split',b.values);image('Incorrect sequential over negative',negative.values);}}
      }
      row.gl=gl.getError();row.lost=gl.isContextLost();require(row.gl===0&&!row.lost,'Healthy frame');records.push(row);
    }
    const partial=positive.get(transitionName);
    result.controls={occluderEffect:difference(partial,positive.get('transition-clear-occluders')),
      secondaryEffect:difference(partial,positive.get('transition-single-star'))};
    if(union===1)require(result.controls.occluderEffect.maximumError>1e-6,'Actual union blockers affect radiance');
    else require(result.controls.occluderEffect.maximumError===0,'UNION0 known multi-occluder omission remains identical');
    require(result.controls.secondaryEffect.maximumError>1e-6,'Actual secondary contributes');
    // Small-work timer only; includes both scratch draws and final combine.
    result.timing=[];
    if(timer){u.uLocalOccluderCount.value=u.air_uLocalOccluderCount.value=blockers.length;u.uSecondarySunEnergy.value=u.air_uSunEnergy1.value=.35;
      async function timed(mode){clear(floatRT);const q=gl.createQuery();queries.add(q);gl.beginQuery(timer.TIME_ELAPSED_EXT,q);
        reference.blending=combine.blending=T.NoBlending;
        if(mode==='reference')draw(reference,floatRT);else{clear(pointRT);draw(point,pointRT);clear(cachedRT);draw(cached,cachedRT);draw(combine,floatRT);}
        gl.endQuery(timer.TIME_ELAPSED_EXT);const deadline=performance.now()+30000;
        while(!gl.getQueryParameter(q,gl.QUERY_RESULT_AVAILABLE)){require(performance.now()<deadline,'Timer result deadline');await new Promise(r=>setTimeout(r,10));}
        require(!gl.getParameter(timer.GPU_DISJOINT_EXT),'Valid timer');const ms=gl.getQueryParameter(q,gl.QUERY_RESULT)/1e6;gl.deleteQuery(q);queries.delete(q);return ms;}
      for(let round=0;round<3;round++)result.timing.push({round,referenceMs:await timed('reference'),splitAllThreeDrawsMs:await timed('split')});
    }
    const debug=gl.getExtension('WEBGL_debug_renderer_info');result.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null;
    result.scratchBytes=width*height*16*2;result.gl=gl.getError();result.lost=gl.isContextLost();result.passed=true;
  }catch(error){result.failure={message:String(error),stack:error.stack};throw error;
  }finally{
    for(const q of queries)gl.deleteQuery(q);for(const material of materials)material.dispose();for(const target of targets)target.dispose();for(const tex of textures)tex.dispose();
    multiple?.dispose();atmosphere?.dispose();planet?.dispose();renderer.dispose();
    for(let i=0;i<1000&&retirement.snapshot().pending;i++)await new Promise(r=>setTimeout(r,10));
    result.retirement=retirement.snapshot();result.finalGL=gl.getError();result.finalLost=gl.isContextLost();
    if(!result.failure){require(!result.retirement.pending&&!result.retirement.faults.length,'Completed native program retirement');
      require(!result.finalGL&&!result.finalLost,'Healthy teardown');}
  }
  window.__cloudFarSplit.status='complete';return result;
}
