import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { nearReplayShader } from './near-cloud-replay.js';
import { createEmptyRunProbe, emptyRunShader } from './near-cloud-empty-runs.js';
import { nearCacheCountsShader, sumNearCacheCounts } from './near-cloud-cache-counts.js';
import { nearAnchorSupportShader, nearAnchorSupportSummary } from './near-cloud-anchor-support.js';
import { createFocusedNearCache, nearCacheCoverageShader, summarizeNearCoverage } from './near-cloud-cache-coverage.js';
import { compareNearNativeDraw, timeNearIndexedDraw } from './near-cloud-native-repeat.js';
import { measureNearCacheOptics, measureNearVisibleOptics } from './near-cloud-cache-optics.js';

const runtimeOpacityExit=`          if(pass==0) {
            totalOpacity=1.0-T;
            if(totalOpacity*uEngage<0.004)discard;
          }`;
const runtimeQuantileExit='            if(pass==1 && bin>=bins)break;\n';

function residualShader(source) {
  const replace=(from,to)=>{
    if(source.split(from).length!==2)throw Error('Unexpected near residual shader boundary');
    source=source.replace(from,to);
  };
  replace('      uniform int uLightQuadratureSteps;',
    '      uniform int uLightQuadratureSteps,uNearResidualMode,uNearTraversalMask;');
  replace(`            T=nextT;relativeDistance+=cellLength;
            if(T<0.0002)break;`, `            if(pass==1 && (uNearTraversalMask&2)!=0 && bin>=bins)break;
            T=nextT;relativeDistance+=cellLength;
            if(T<0.0002)break;`);
  replace('          if(pass==0)totalOpacity=1.0-T;',`          if(pass==0) {
            totalOpacity=1.0-T;
            float opacity=totalOpacity*uEngage;
            if((uNearTraversalMask&1)!=0 || uNearResidualMode==1) {
              if(opacity<0.004)discard;
              if(uNearResidualMode==1){gl_FragColor=vec4(0,0,0,opacity);return;}
            }
          }`);
  replace(`        if(alpha<0.004)discard;
        vec3 correction=vec3(0);`, `        if(alpha<0.004)discard;
        if(uNearResidualMode==2) {
          float anchorSum=0.0;
          for(int k=0;k<bins;k++)anchorSum+=anchors[k]/max(t1,1.0);
          gl_FragColor=vec4(anchorSum/float(bins),0,0,alpha);
          return;
        }
        vec3 correction=vec3(0);`);
  replace(`          vec3 gapLight,gapTransmission;
          cloudAirTransport(uCameraLocal,dir,previousAnchor,nextAnchor,bin>0,`,
    `          vec3 gapLight=vec3(0),gapTransmission=vec3(1);
          if(uNearResidualMode!=3)cloudAirTransport(uCameraLocal,dir,previousAnchor,nextAnchor,bin>0,`);
  replace('          vec3 source=cloudCombinedSource(local,dir,0.0,thick,sigma)*uTint;',
    '          vec3 source=uNearResidualMode==4?vec3(0):cloudCombinedSource(local,dir,0.0,thick,sigma)*uTint;');
  return source;
}

function difference(a,b,half) {
  let changed=0,alpha=0,maximum=0,nonempty=0;
  for(let i=0;i<a.length;i++) {
    if(i%4===3&&half(a[i])>0)nonempty++;
    if(a[i]===b[i])continue;
    changed++;
    if(i%4===3)alpha++;
    maximum=Math.max(maximum,Math.abs(half(a[i])-half(b[i])));
  }
  if(!Number.isFinite(maximum))throw Error('Non-finite near residual image');
  return {changed,alpha,maximum,nonempty};
}

export async function observeNearResidual(game,{traversal=false,replay=null,emptyRuns=null,maximumAltitude=230000,cloudyCache=false,cachePair=false,cacheSupport=false,cacheCoverage=false,cachePlacement=false,nativePlacement=false,placementOptics=false,placementR16=false,cacheNative=false,cacheNativeToggle=false}={}) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, owner=pass.activePlanet, mesh=owner.volCloudMesh, original=owner.volCloudMat;
  const gl=renderer.getContext(), timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!timer)throw Error('Near residual probe requires GPU timing');
  const material=new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
  const fragment=original.fragmentShader;
  const optimized=fragment.includes(runtimeOpacityExit)&&fragment.includes(runtimeQuantileExit);
  const baseline=fragment.replace(runtimeOpacityExit,'          if(pass==0)totalOpacity=1.0-T;')
    .replace(runtimeQuantileExit,'');
  if((traversal||replay)&&!optimized)throw Error('Near traversal probe requires the runtime early exits');
  material.fragmentShader=emptyRuns?emptyRunShader(fragment,emptyRuns):replay?nearReplayShader(fragment,replay)
    :traversal?baseline:residualShader(baseline);
  const productionPacked=Boolean(original.uniforms.uNearBandCandidates);
  const legacyScan=productionPacked&&emptyRuns==='r16';
  const emptyRunProbe=emptyRuns&&!legacyScan?createEmptyRunProbe(T,gl,emptyRuns):null;
  Object.assign(material.uniforms,original.uniforms,{uNearResidualMode:{value:0},uNearTraversalMask:{value:0}});
  const counter=cachePair||cacheSupport?new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}})):null;
  if(counter) {
    counter.fragmentShader=cacheCoverage?nearCacheCoverageShader(fragment)
      :cacheSupport?nearAnchorSupportShader(fragment):nearCacheCountsShader(fragment);
    counter.blending=T.NoBlending;
    Object.assign(counter.uniforms,original.uniforms);
    if(cacheCoverage)counter.uniforms.uNearCoverageMode={value:0};
  }
  const target=new T.WebGLRenderTarget(pass.width,pass.height,{type:cacheCoverage?T.FloatType:T.HalfFloatType,depthBuffer:false});
  const proxy=new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);
  const camera=createCompileCamera(pass.camera,VOLUME_LAYER), half=T.DataUtils.fromHalfFloat;
  const profile=pass.profilePhase, queries=[], rows=[];
  const directComparison=traversal||replay||emptyRuns;
  const arms=nativePlacement?[{name:'native-placement-1'},{name:'native-placement-2'},{name:'native-placement-3'}]
    :cacheNative?[{name:'native-repeat-1'},{name:'native-repeat-2'},{name:'native-repeat-3'}]
    :cacheSupport?[{name:'anchor-support'}]:cachePair?[
    {name:'cache-pair-1',full:true},{name:'cache-pair-2',full:true},
    {name:'cache-pair-3',full:true},{name:'cache-pair-4',full:true},
  ]:directComparison?[
    {name:'zero-1'},{name:'zero-2'},{name:'zero-3'},{name:'zero-4'},
    {name:'full-1',full:true},{name:'full-2',full:true},{name:'full-3',full:true},
  ]:[
    {name:'original-zero',native:true},
    {name:'variant-zero'},
    {name:'first-density',mode:1},
    {name:'both-density',mode:2},
    {name:'without-air',mode:3},
    {name:'without-source',mode:4},
    {name:'empty-exit',mask:1},
    {name:'quantile-exit',mask:2},
    {name:'both-exits',mask:3},
    {name:'full-control',full:true},
    {name:'full-exits',mask:3,full:true},
  ];
  let failure,epoch,emptyFrames=0,backup,terminalReport;
  let stagedPlacement,placementSetup,referenceBank,optics;

  function time(work) {
    if(gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))throw Error('Overlapping near residual GPU timer');
    const query=gl.createQuery();
    if(!query)throw Error('Missing near residual GPU query');
    queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    try {work();}
    finally {if(!gl.isContextLost())gl.endQuery(timer.TIME_ELAPSED_EXT);}
    return query;
  }
  function draw(pointMaterial,{mode=0,mask=0,paths=0,cache,measure=true,output=target}={}) {
    const uniforms=pointMaterial.uniforms;
    if(pointMaterial===counter)Object.assign(uniforms,original.uniforms);
    if(pointMaterial===material) {
      Object.assign(uniforms,original.uniforms);
      uniforms.uNearResidualMode.value=mode;
      uniforms.uNearTraversalMask.value=mask;
      if(emptyRunProbe) {
        emptyRunProbe.bind(uniforms);
        renderer.initTexture(uniforms.uBandCandidates.value);
      }
    }
    const previous=mesh.material, saved=renderer.getRenderTarget(),auto=renderer.autoClear;
    const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
    const count=uniforms.uLightPathCount, oldCount=count.value;
    const ready=uniforms.uSunCacheReady, oldReady=ready.value;
    try {
      if(cache!==undefined)ready.value=cache;
      count.value=paths;pointMaterial.uniformsNeedUpdate=true;
      mesh.material=pointMaterial;renderer.autoClear=output===pass.current?auto:false;
      renderer.setRenderTarget(output);renderer.clear(true,false,false);
      const render=()=>renderer.render(pass.scene,pass.camera);
      const query=measure?(cachePair&&output===pass.current?timeNearIndexedDraw(renderer,output,time,render):time(render)):null;
      if(!measure)render();
      return {query,pixels:read(output)};
    } finally {
      count.value=oldCount;ready.value=oldReady;pointMaterial.uniformsNeedUpdate=true;
      mesh.material=previous;renderer.autoClear=auto;renderer.setRenderTarget(saved,face,mip);
    }
  }
  function read(source) {
    const size=source.width*source.height*4;
    const pixels=source.texture.type===T.FloatType?new Float32Array(size):new Uint16Array(size);
    renderer.readRenderTargetPixels(source,0,0,source.width,source.height,pixels);
    return pixels;
  }
  function comparePlacement(coverage,published) {
    const {bank,uniforms}=createFocusedNearCache(owner,coverage.focus);
    const output=new T.WebGLRenderTarget(target.width,target.height,{type:T.HalfFloatType,depthBuffer:false});
    const alternate=new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
    const counts=new T.ShaderMaterial().copy(Object.assign(Object.create(counter),{uniforms:{}}));
    Object.assign(alternate.uniforms,original.uniforms,uniforms);
    Object.assign(counts.uniforms,original.uniforms,uniforms,{uNearCoverageMode:{value:6}});
    try {
      const baseline=draw(original,{paths:4,output});
      const control=difference(published,baseline.pixels,half);
      const begin=performance.now();
      const bakeQuery=time(()=>bank.update(renderer));
      const bakeCpuMs=performance.now()-begin;
      if(uniforms.uSunCacheReady.value!==1)throw Error('Focused cache failed to publish both endpoints');
      const candidate=draw(alternate,{paths:4,output});
      const counted=sumNearCacheCounts(draw(counts,{paths:4,measure:false}).pixels,value=>value);
      if(counted.rays!==coverage.occupied||counted.hits.some((hit,i)=>hit+counted.misses[i]!==coverage.requests[i]))
        throw Error('Focused cache changed the light-query population');
      const error=difference(baseline.pixels,candidate.pixels,half);
      const available=[uniforms.uSunCacheValidA.value,uniforms.uSunCacheValidB.value];
      const saved=available.map(value=>value.toArray());
      const fields=[];
      for(let field=0;field<4;field++) {
        available.forEach((value,index)=>value.set(0,0,0,0).setComponent(field,saved[index][field]));
        const isolated=draw(alternate,{paths:4,measure:false,output});
        fields.push({field,hits:counted.hits[field],error:difference(baseline.pixels,isolated.pixels,half)});
      }
      available.forEach(value=>value.set(0,0,0,0));
      const fallback=draw(alternate,{paths:4,measure:false,output});
      const fallbackControl=difference(baseline.pixels,fallback.pixels,half);
      return {control,fallbackControl,error,admitted:!control.changed&&!fallbackControl.changed&&!error.alpha&&error.maximum<=.002,
        counted,fields,bakeQuery,bakeCpuMs,referenceQuery:baseline.query,candidateQuery:candidate.query,
        centerAltitude:bank.center.length()-owner.R,spacing:bank.spacing,atlasBytes:bank.target.width*bank.target.height};
    } finally {bank.dispose();output.dispose();alternate.dispose();counts.dispose();}
  }
  function countNativePlacement(placement) {
    const counts=new T.ShaderMaterial().copy(Object.assign(Object.create(counter),{uniforms:{}}));
    Object.assign(counts.uniforms,original.uniforms,placement?.uniforms,{uNearCoverageMode:{value:6}});
    try {return sumNearCacheCounts(draw(counts,{paths:4,measure:false}).pixels,value=>value);}
    finally {counts.dispose();}
  }
  function blit(source,destination) {
    const readBuffer=gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const drawBuffer=gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const scissor=gl.isEnabled(gl.SCISSOR_TEST);
    const state=renderer.state;
    try {
      state.setScissorTest(false);
      state.bindFramebuffer(gl.READ_FRAMEBUFFER,renderer.properties.get(source).__webglFramebuffer);
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER,renderer.properties.get(destination).__webglFramebuffer);
      gl.blitFramebuffer(0,0,source.width,source.height,0,0,destination.width,destination.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);
    } finally {
      state.bindFramebuffer(gl.DRAW_FRAMEBUFFER,drawBuffer);
      state.bindFramebuffer(gl.READ_FRAMEBUFFER,readBuffer);
      state.setScissorTest(scissor);
    }
  }
  function ensureBackup(current) {
    if(backup)return;
    if(current.depthBuffer||current.samples||renderer.getRenderTarget()!==current)
      throw Error('Near replay needs the single-sample color target');
    backup=current.clone();
    renderer.initRenderTarget(backup);
    renderer.setRenderTarget(current);
  }
  function hook(name,work,options) {
    const eyeAltitude=original.uniforms.uCameraLocal.value.length()-owner.R;
    const matching=name==='volume-current'&&mesh.material===original&&pass.activePlanet===owner
      &&eyeAltitude<=maximumAltitude&&!failure&&rows.length<arms.length
      &&(!cloudyCache||original.uniforms.uSunCacheReady.value===1);
    const measure=matching&&directComparison&&arms[rows.length].full;
    let liveQuery,result,nativeRepeat;
    const render=renderer.render;
    if(measure)renderer.render=function(scene,camera) {
      if(scene===pass.scene&&camera===pass.camera&&renderer.getRenderTarget()===pass.current) {
        if(cachePair)ensureBackup(pass.current);
        const submit=()=>render.call(this,scene,camera);
        liveQuery=cachePair?timeNearIndexedDraw(renderer,pass.current,time,submit):time(submit);
      } else render.call(this,scene,camera);
    };
    const nativeControl=matching&&(cacheNative||nativePlacement&&stagedPlacement);
    if(nativeControl)renderer.render=function(scene,camera) {
      const current=pass.current;
      if(scene!==pass.scene||camera!==pass.camera||renderer.getRenderTarget()!==current)
        return render.call(this,scene,camera);
      ensureBackup(current);
      nativeRepeat=compareNearNativeDraw({renderer,current,backup,blit,read,
        compare:(a,b)=>difference(a,b,half),render:()=>render.call(this,scene,camera),time,
        cacheOrder:cacheNativeToggle?(rows.length%2?[0,1]:[1,0]):null,
        placement:stagedPlacement});
    };
    try {result=measure||nativeControl?work():profile.call(this,name,work,options);}
    finally {if(measure||nativeControl)renderer.render=render;}
    if(!matching)return result;
    try {
      const current=pass.current, arm=arms[rows.length];
      if(current.width!==target.width||current.height!==target.height||!pass.farSplit.soleOwner(pass.scene,mesh)
        ||original.uniforms.uLightPathCount.value!==4||original.uniforms.uLightQuadratureSteps.value!==16)
        throw Error('Near residual frame lost its original draw contract');
      if(cacheNative) {
        if(!nativeRepeat?.restored.nonempty)throw Error('Near native repeat needs visible cloud');
        rows.push({arm:arm.name,eyeAltitude,frame:pass.frame,...nativeRepeat});
        return result;
      }
      const published=read(current);
      if(cacheCoverage) {
        if(nativePlacement&&stagedPlacement) {
          const originalCounts=countNativePlacement(), focused=countNativePlacement(stagedPlacement);
          const restored=difference(published,read(current),half);
          if(restored.changed||originalCounts.rays!==restored.nonempty||focused.rays!==restored.nonempty
            ||originalCounts.hits.some((hits,field)=>hits+originalCounts.misses[field]!==focused.hits[field]+focused.misses[field]))
            throw Error('Native placement count changed the published frame or the query population');
          const {placementSamples,...repeat}=nativeRepeat;
          const sample=name=>placementSamples.find(value=>value.name===name);
          const publishedControls=['reference','restored-reference'];
          if(originalCounts.hits.every(count=>count===0))publishedControls.push('texture-only','validity-only');
          const controlPassed=repeat.nativeDelta.changed===0&&publishedControls.every(name=>!sample(name).error.changed)
            &&['focus-fallback','fallback-repeat'].every(name=>!sample(name).forcedError.changed);
          const candidate=sample('focus-full').forcedError;
          rows.push({arm:arm.name,eyeAltitude,frame:pass.frame,...repeat,originalCounts,focused,
            placementSamples,controlPassed,admitted:controlPassed&&!candidate.alpha&&candidate.maximum<=.002});
          return result;
        }
        const readMode=mode=>{
          counter.uniforms.uNearCoverageMode.value=mode;
          return draw(counter,{paths:4,measure:false}).pixels;
        };
        const groups=[0,1,2,3].map(readMode);
        const rays=readMode(4);
        const coverage=summarizeNearCoverage({groups,rays,masks:readMode(5),counts:readMode(6),
          published,half,uniforms:original.uniforms,T});
        if(nativePlacement) {
          stagedPlacement=createFocusedNearCache(owner,coverage.focus);
          if(placementR16)stagedPlacement.bank.target.texture.type=T.HalfFloatType;
          if(placementOptics) {
            referenceBank=createFocusedNearCache(owner,coverage.focus).bank;
            if(!referenceBank.create(0))throw Error('Focused optics could not snapshot the first forecast');
          }
          const start=performance.now();
          const query=time(()=>stagedPlacement.bank.update(renderer));
          const {bank,uniforms}=stagedPlacement;
          if(placementR16)uniforms.uSunCacheEncoded.value=0;
          const cpuMs=performance.now()-start;
          const visibleOptics=placementOptics?measureNearVisibleOptics(T,renderer,original,uniforms,{groups,rays},
            referenceBank.maps.get(0)):undefined;
          if(uniforms.uSunCacheReady.value!==1||difference(published,read(current),half).changed)
            throw Error('Native placement setup failed to publish privately');
          placementSetup={coverage,query,cpuMs,visibleOptics,
            centerAltitude:bank.center.length()-owner.R,spacing:bank.spacing,format:placementR16?'R16F':'R8',
            atlasBytes:bank.target.width*bank.target.height*(placementR16?2:1)};
          return result;
        }
        const placement=cachePlacement?comparePlacement(coverage,published):undefined;
        const control=difference(published,read(current),half);
        if(control.changed||control.nonempty!==coverage.occupied)
          throw Error('Near coverage changed the published target');
        rows.push({arm:'cache-coverage',eyeAltitude,frame:pass.frame,coverage,placement,control});
        return result;
      }
      if(cacheSupport) {
        const support=nearAnchorSupportSummary(draw(counter,{paths:4,measure:false}).pixels,half,owner);
        const control=difference(published,read(current),half);
        if(control.changed||control.nonempty!==support.occupiedRays)
          throw Error(`Near anchor support lost its native mask count ${JSON.stringify({control,support})}`);
        rows.push({arm:arm.name,eyeAltitude,frame:pass.frame,support,control});
        return result;
      }
      if(cachePair) {
        if(!liveQuery)throw Error('Missing production cache-pair GPU query');
        const order=[['cached-native','cached-packed','raw-packed','raw-native'],
          ['cached-packed','cached-native','raw-native','raw-packed'],
          ['raw-native','raw-packed','cached-packed','cached-native'],
          ['raw-packed','raw-native','cached-native','cached-packed']][rows.length];
        ensureBackup(current);
        blit(current,backup);
        if(difference(published,read(backup),half).changed)throw Error('Near cache pair could not save its published target');
        let samples;
        try {
          if(!rows.length) {
            // Repeat the published draw before touching the material or its uniforms.
            renderer.clear(true,false,false);
            render.call(renderer,pass.scene,pass.camera);
            const preflight=difference(published,read(current),half);
            if(preflight.changed)throw Error(`Near cache native production-target drift ${JSON.stringify(preflight)}`);
          }
          samples=new Map(order.map(key=>[key,draw(key.endsWith('native')?original:material,
            {paths:4,cache:Number(key.startsWith('cached')),output:current})]));
        } finally {
          if(!gl.isContextLost()) {
            blit(backup,current);
            if(difference(published,read(current),half).changed)throw Error('Near cache pair could not restore its published target');
          }
        }
        const cachedReference=samples.get('cached-native'),cached=samples.get('cached-packed');
        const uncachedReference=samples.get('raw-native'),uncachedCandidate=samples.get('raw-packed');
        const counts=sumNearCacheCounts(draw(counter,{paths:4,measure:false}).pixels,half);
        const control=!rows.length?sumNearCacheCounts(draw(counter,{paths:4,cache:0,measure:false}).pixels,half):null;
        if(control&&(control.rays!==counts.rays||control.hits.some((hit,field)=>hit||control.misses[field]!==counts.hits[field]+counts.misses[field])))
          throw Error('Near cache count did not conserve queries with cache off');
        if(difference(published,read(current),half).changed||original.uniforms.uSunCacheReady.value!==1)
          throw Error('Near cache pair changed production state');
        const publishedControl=difference(published,cachedReference.pixels,half);
        const controlPassed=!publishedControl.changed&&publishedControl.nonempty===counts.rays;
        const reportOrder=legacyScan?order.map(key=>key.replace('-native','-production-r16').replace('-packed','-legacy-scan')):order;
        rows.push({arm:arm.name,frame:pass.frame,eyeAltitude,counts,control,order:reportOrder,publishedControl,controlPassed,
          cachedError:difference(cachedReference.pixels,cached.pixels,half),
          uncachedError:difference(uncachedReference.pixels,uncachedCandidate.pixels,half),
          cacheDifference:difference(published,uncachedReference.pixels,half),
          liveQuery,referenceQuery:cachedReference.query,candidateQuery:cached.query,
          uncachedReferenceQuery:uncachedReference.query,uncachedCandidateQuery:uncachedCandidate.query});
        if(!controlPassed)
          throw Error(`Near cache pair lost its native control after overrides ${JSON.stringify({order:reportOrder,publishedControl,counts})}`);
        return result;
      }
      const reference=arm.full?{pixels:published,query:liveQuery}:draw(original);
      const variantReference=!directComparison&&!arm.full&&!arm.native?draw(material):null;
      const candidate=draw(arm.native?original:material,{mode:arm.mode,mask:arm.mask,paths:arm.full?4:0});
      const untouched=difference(published,read(current),half);
      if(untouched.changed)throw Error('Near residual probe changed the published target');
      const error=difference(reference.pixels,candidate.pixels,half);
      if(cloudyCache&&!error.nonempty&&!error.changed) {
        if(++emptyFrames>=8)throw Error('Both programs returned only transparent pixels at the cache probe');
        return result;
      }
      rows.push({arm:arm.name,frame:pass.frame,cacheReady:original.uniforms.uSunCacheReady.value,
        eyeAltitude,
        referenceQuery:reference.query,candidateQuery:candidate.query,variantQuery:variantReference?.query,
        error,
        variantError:variantReference?difference(variantReference.pixels,candidate.pixels,half):undefined,
        variantControl:variantReference?difference(reference.pixels,variantReference.pixels,half):undefined});
    } catch(error) {failure=error;}
    return result;
  }
  const start=performance.now();
  try {
    for(const program of cacheNative&&!emptyRuns?[]:cacheSupport?[counter]:counter?[material,counter]:[material])await pipeline.prepare(()=>{
      const previous=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      proxy.material=program;
      renderer.setRenderTarget(target);
      try {return compilePrograms(renderer,proxy,camera,pass.scene);}
      finally {renderer.setRenderTarget(previous,face,mip);}
    },{label:program===counter?'near-cache-counts':'near-residual'});
    epoch=readGpuDisjointEpoch(gl,timer);
    pass.profilePhase=hook;
  } catch(error) {material.dispose();target.dispose();counter?.dispose();throw error;}
  const prepareMs=performance.now()-start;
  const report=ms=>({prepareMs,optimized,traversal,replay,
    emptyRuns:legacyScan?{production:'r16',layout:'legacy-scan'}:emptyRunProbe?.stats(),
    cloudyCache,cachePair,cacheSupport,cacheNative,nativePlacement,dimensions:[target.width,target.height],
    ...(placementSetup?{placementSetup:{...placementSetup,query:undefined,gpuMs:ms(placementSetup.query)}}:{}),
    ...(optics?{optics}:{}),
    rows:rows.map(({referenceQuery,candidateQuery,variantQuery,uncachedReferenceQuery,uncachedCandidateQuery,liveQuery,cacheSamples,placement,placementSamples,...row})=>({...row,
      referenceGpuMs:ms(referenceQuery),variantGpuMs:ms(variantQuery),gpuMs:ms(candidateQuery),
      ...(placement?{placement:placementReport(placement,ms)}:{}),
      ...(placementSamples?{placementSamples:placementSamples.map(({query,...sample})=>({...sample,gpuMs:ms(query)}))}:{}),
      ...(cacheSamples?.length?{cacheSamples:cacheSamples.map(({query,...sample})=>({...sample,gpuMs:ms(query)}))}:{}),
      ...(cachePair?{liveGpuMs:ms(liveQuery),uncachedReferenceGpuMs:ms(uncachedReferenceQuery),uncachedGpuMs:ms(uncachedCandidateQuery)}:{})}))});
  return {
    get done() {return rows.length===arms.length||Boolean(failure);},
    get report() {return terminalReport;},
    async finish() {
      try {
        const deadline=performance.now()+20000;
        while(!gl.isContextLost()&&queries.some(query=>!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
          if(performance.now()>deadline)throw failure??Error('Near residual timer failed');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        if(gl.isContextLost()||readGpuDisjointEpoch(gl,timer)!==epoch)
          throw failure??Error('Near residual timer became disjoint');
        const ms=query=>query?gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6:null;
        if(failure)throw failure;
        if(rows.length!==arms.length)throw Error('Missing near residual samples');
        if(referenceBank) {
          const prepare=(work,label)=>pipeline.prepare(()=>{
            const target=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
            try {return work();}
            finally {renderer.setRenderTarget(target,face,mip);}
          },{label});
          optics=await measureNearCacheOptics(T,renderer,referenceBank.maps.get(0),stagedPlacement.bank.maps.get(0),prepare);
        }
        terminalReport=report(ms);
        return terminalReport;
      } catch(error) {
        terminalReport??=report(()=>null);
        throw error;
      } finally {
        if(pass.profilePhase===hook)pass.profilePhase=profile;
        if(!gl.isContextLost())for(const query of queries)gl.deleteQuery(query);
        target.dispose();backup?.dispose();material.dispose();counter?.dispose();emptyRunProbe?.dispose();
        stagedPlacement?.bank.dispose();referenceBank?.dispose();
      }
    },
  };
}

function placementReport({bakeQuery,referenceQuery,candidateQuery,...placement},ms) {
  return {...placement,bakeGpuMs:ms(bakeQuery),referenceGpuMs:ms(referenceQuery),candidateGpuMs:ms(candidateQuery)};
}
