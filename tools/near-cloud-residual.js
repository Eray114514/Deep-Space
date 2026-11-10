import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { nearReplayShader } from './near-cloud-replay.js';
import { createEmptyRunProbe, emptyRunShader } from './near-cloud-empty-runs.js';
import { nearCacheCountsShader, sumNearCacheCounts } from './near-cloud-cache-counts.js';
import { nearAnchorSupportShader, nearAnchorSupportSummary } from './near-cloud-anchor-support.js';

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

export async function observeNearResidual(game,{traversal=false,replay=null,emptyRuns=null,maximumAltitude=230000,cloudyCache=false,cachePair=false,cacheSupport=false}={}) {
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
  const emptyRunProbe=emptyRuns?createEmptyRunProbe(T,gl,emptyRuns):null;
  Object.assign(material.uniforms,original.uniforms,{uNearResidualMode:{value:0},uNearTraversalMask:{value:0}});
  const counter=cachePair||cacheSupport?new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}})):null;
  if(counter) {
    counter.fragmentShader=cacheSupport?nearAnchorSupportShader(fragment):nearCacheCountsShader(fragment);
    counter.blending=T.NoBlending;
    Object.assign(counter.uniforms,original.uniforms);
  }
  const target=new T.WebGLRenderTarget(pass.width,pass.height,{type:T.HalfFloatType,depthBuffer:false});
  const proxy=new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);
  const camera=createCompileCamera(pass.camera,VOLUME_LAYER), half=T.DataUtils.fromHalfFloat;
  const profile=pass.profilePhase, queries=[], rows=[];
  const directComparison=traversal||replay||emptyRuns;
  const arms=cacheSupport?[{name:'anchor-support'}]:cachePair?[
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
  let failure,epoch,emptyFrames=0;

  function time(work) {
    if(gl.getQuery(timer.TIME_ELAPSED_EXT,gl.CURRENT_QUERY))throw Error('Overlapping near residual GPU timer');
    const query=gl.createQuery();
    if(!query)throw Error('Missing near residual GPU query');
    queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
    try {work();}
    finally {if(!gl.isContextLost())gl.endQuery(timer.TIME_ELAPSED_EXT);}
    return query;
  }
  function draw(pointMaterial,{mode=0,mask=0,paths=0,cache,measure=true}={}) {
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
      mesh.material=pointMaterial;renderer.autoClear=false;
      renderer.setRenderTarget(target);renderer.clear(true,false,false);
      const render=()=>renderer.render(pass.scene,pass.camera);
      const query=measure?time(render):null;
      if(!measure)render();
      return {query,pixels:read(target)};
    } finally {
      count.value=oldCount;ready.value=oldReady;pointMaterial.uniformsNeedUpdate=true;
      mesh.material=previous;renderer.autoClear=auto;renderer.setRenderTarget(saved,face,mip);
    }
  }
  function read(source) {
    const pixels=new Uint16Array(source.width*source.height*4);
    renderer.readRenderTargetPixels(source,0,0,source.width,source.height,pixels);
    return pixels;
  }
  function hook(name,work,options) {
    const eyeAltitude=original.uniforms.uCameraLocal.value.length()-owner.R;
    const matching=name==='volume-current'&&mesh.material===original&&pass.activePlanet===owner
      &&eyeAltitude<=maximumAltitude&&!failure&&rows.length<arms.length
      &&(!cloudyCache||original.uniforms.uSunCacheReady.value===1);
    const measure=matching&&directComparison&&arms[rows.length].full;
    let liveQuery,result;
    const render=renderer.render;
    if(measure)renderer.render=function(scene,camera) {
      if(scene===pass.scene&&camera===pass.camera&&renderer.getRenderTarget()===pass.current)
        liveQuery=time(()=>render.call(this,scene,camera));
      else render.call(this,scene,camera);
    };
    try {result=measure?work():profile.call(this,name,work,options);}
    finally {if(measure)renderer.render=render;}
    if(!matching)return result;
    try {
      const current=pass.current, arm=arms[rows.length];
      if(current.width!==target.width||current.height!==target.height||!pass.farSplit.soleOwner(pass.scene,mesh)
        ||original.uniforms.uLightPathCount.value!==4||original.uniforms.uLightQuadratureSteps.value!==16)
        throw Error('Near residual frame lost its original draw contract');
      const published=read(current);
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
        const controlPixels=draw(original,{paths:4,measure:false}).pixels;
        const preflight=difference(published,controlPixels,half);
        if(preflight.changed)throw Error(`Near cache native preflight drift before any overrides ${JSON.stringify(preflight)}`);
        const order=[['cached-native','cached-packed','raw-packed','raw-native'],
          ['cached-packed','cached-native','raw-native','raw-packed'],
          ['raw-native','raw-packed','cached-packed','cached-native'],
          ['raw-packed','raw-native','cached-native','cached-packed']][rows.length];
        const samples=new Map(order.map(key=>[key,draw(key.endsWith('native')?original:material,
          {paths:4,cache:Number(key.startsWith('cached'))})]));
        const cachedReference=samples.get('cached-native'),cached=samples.get('cached-packed');
        const uncachedReference=samples.get('raw-native'),uncachedCandidate=samples.get('raw-packed');
        const counts=sumNearCacheCounts(draw(counter,{paths:4,measure:false}).pixels,half);
        const control=!rows.length?sumNearCacheCounts(draw(counter,{paths:4,cache:0,measure:false}).pixels,half):null;
        if(control&&(control.rays!==counts.rays||control.hits.some((hit,field)=>hit||control.misses[field]!==counts.hits[field]+counts.misses[field])))
          throw Error('Near cache count did not conserve queries with cache off');
        if(difference(published,read(current),half).changed||original.uniforms.uSunCacheReady.value!==1)
          throw Error('Near cache pair changed production state');
        const publishedControl=difference(published,cachedReference.pixels,half);
        if(publishedControl.changed||publishedControl.nonempty!==counts.rays)
          throw Error(`Near cache pair lost its native control after overrides ${JSON.stringify({order,publishedControl,counts})}`);
        rows.push({arm:arm.name,frame:pass.frame,eyeAltitude,counts,control,order,publishedControl,
          cachedError:difference(cachedReference.pixels,cached.pixels,half),
          uncachedError:difference(uncachedReference.pixels,uncachedCandidate.pixels,half),
          cacheDifference:difference(published,uncachedReference.pixels,half),
          liveQuery,referenceQuery:cachedReference.query,candidateQuery:cached.query,
          uncachedReferenceQuery:uncachedReference.query,uncachedCandidateQuery:uncachedCandidate.query});
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
    for(const program of cacheSupport?[counter]:counter?[material,counter]:[material])await pipeline.prepare(()=>{
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
  return {
    get done() {return rows.length===arms.length||Boolean(failure);},
    async finish() {
      try {
        if(failure)throw failure;
        if(rows.length!==arms.length)throw Error('Missing near residual samples');
        const deadline=performance.now()+20000;
        while(queries.some(query=>!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))) {
          if(gl.isContextLost()||performance.now()>deadline)throw Error('Near residual timer failed');
          await new Promise(resolve=>setTimeout(resolve,20));
        }
        if(readGpuDisjointEpoch(gl,timer)!==epoch)throw Error('Near residual timer became disjoint');
        const ms=query=>query?gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6:null;
        return {prepareMs,optimized,traversal,replay,emptyRuns:emptyRunProbe?.stats(),cloudyCache,cachePair,cacheSupport,dimensions:[target.width,target.height],
          rows:rows.map(({referenceQuery,candidateQuery,variantQuery,uncachedReferenceQuery,uncachedCandidateQuery,liveQuery,...row})=>({...row,
            referenceGpuMs:ms(referenceQuery),variantGpuMs:ms(variantQuery),gpuMs:ms(candidateQuery),
            ...(cachePair?{liveGpuMs:ms(liveQuery),uncachedReferenceGpuMs:ms(uncachedReferenceQuery),uncachedGpuMs:ms(uncachedCandidateQuery)}:{})}))};
      } finally {
        if(pass.profilePhase===hook)pass.profilePhase=profile;
        if(!gl.isContextLost())for(const query of queries)gl.deleteQuery(query);
        target.dispose();material.dispose();counter?.dispose();emptyRunProbe?.dispose();
      }
    },
  };
}
