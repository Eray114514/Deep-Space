import { VOLUME_LAYER } from '../src/render-layers.js';
import { readGpuDisjointEpoch } from '../src/gpu-query-state.js';
import { CloudLightBatchRenderer } from '../src/cloud/cloud-light-batch-renderer.js';

function stagedNearClipShader(fragment) {
  const start='      void main() {\n        cloudFootprint = 0.0;';
  const ray='        float rayCone=max(length(dFdx(dir)),length(dFdy(dir)));';
  if(fragment.split(start).length!==2||fragment.split(ray).length!==2)
    throw Error('Missing near clip shader boundary');
  return fragment.replace(start,`      uniform vec2 uStagedBand;
${start}`).replace(ray,`${ray}
        if(gl_FragCoord.y<uStagedBand.x || gl_FragCoord.y>=uStagedBand.y)discard;`);
}

// Freeze one real draw at the first near-cloud pose. Preparation jobs retire
// one scissor band each, without publishing partial volume or changing bins.
export async function verifyStagedNearFrame(game,{compareWhole=false,mode='scissor',freezeDepth=false,primeBatch=false,microBatch=false,splitMicroBatch=false}={}) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, gl=renderer.getContext();
  const timer=gl.getExtension('EXT_disjoint_timer_query_webgl2');
  if(!timer)throw Error('Staged near proof needs GPU timer queries');
  const owner=pipeline.framePacer??pipeline.startFramePacing();
  const originalSubmit=pipeline.submitFrame, profile=pass.profilePhase;
  const halted={}, queries=[];
  let input,target,microTarget,depthCopy,material,comparisonMaterial,batch,probeBatch,snapshot,captureError,armed=false,blocked=false;
  let resolveCapture;
  const captured=new Promise(resolve=>{resolveCapture=resolve;});
  function submit(work) {
    if(blocked)return false;
    try {return originalSubmit.call(this,work);}
    catch(error) {if(error!==halted)throw error;return false;}
  }
  pipeline.submitFrame=submit;
  function profileHook(name,work,options) {
    if(!armed||name!=='volume-current')return profile.call(this,name,work,options);
    const render=renderer.render;
    renderer.render=function(scene,camera) {
      const planet=pass.activePlanet, mesh=planet?.volCloudMesh;
      if(scene!==pass.scene||camera!==pass.camera||renderer.getRenderTarget()!==pass.current
        ||!mesh||mesh.material!==planet.volCloudMat||!pass.farSplit.soleOwner(scene,mesh))
        return render.call(this,scene,camera);
      const u=mesh.material.uniforms;
      if(u.uLightQuadratureSteps.value!==16||u.uLightPathCount.value!==4||u.uSunCacheReady.value!==0) {
        captureError=Error('Staged proof needs the uncached, full-quality four-light draw');
        blocked=true;resolveCapture();throw halted;
      }
      const cloneValue=value=>Array.isArray(value)?value.map(cloneValue)
        :value?.isTexture?value:ArrayBuffer.isView(value)?value.slice():value?.clone?.()??value;
      material=new T.ShaderMaterial().copy(Object.assign(Object.create(mesh.material),{uniforms:{}}));
      material.uniforms=Object.fromEntries(Object.entries(u).map(([key,{value}])=>[key,{value:cloneValue(value)}]));
      if(freezeDepth) {
        try {
          const source=u.tSceneDepth.value;
          if(!source?.isDepthTexture)throw Error('Staged depth snapshot requires a live depth attachment');
          const {width,height}=source.image;
          const ownedDepth=new T.DepthTexture(width,height,source.type);
          ownedDepth.format=source.format;
          ownedDepth.minFilter=source.minFilter;ownedDepth.magFilter=source.magFilter;
          depthCopy=new T.WebGLRenderTarget(width,height,{depthTexture:ownedDepth,
            stencilBuffer:source.format===T.DepthStencilFormat});
          renderer.initRenderTarget(depthCopy);
          try {renderer.copyTextureToTexture(source,ownedDepth);}
          finally {renderer.setRenderTarget(pass.current);}
          if(gl.getError()!==gl.NO_ERROR)throw Error('Could not blit opaque depth into private staged attachment');
          material.uniforms.tSceneDepth.value=ownedDepth;
        } catch(error) {captureError=error;blocked=true;resolveCapture();throw halted;}
      }
      if(mode==='fragment') {
        if(compareWhole) {
          comparisonMaterial=new T.ShaderMaterial().copy(Object.assign(Object.create(mesh.material),{uniforms:{}}));
          comparisonMaterial.uniforms={...material.uniforms};
        }
        material.fragmentShader=stagedNearClipShader(material.fragmentShader);
        material.uniforms.uStagedBand={value:new T.Vector2()};
      } else if(mode==='batch'&&!compareWhole) {
        comparisonMaterial=new T.ShaderMaterial().copy(Object.assign(Object.create(mesh.material),{uniforms:{}}));
        comparisonMaterial.fragmentShader=stagedNearClipShader(material.fragmentShader);
        comparisonMaterial.uniforms={...material.uniforms,uStagedBand:{value:new T.Vector2()}};
      }
      const privateMesh=new T.Mesh(mesh.geometry,material), privateScene=new T.Scene();
      privateMesh.matrixAutoUpdate=false;privateMesh.matrix.copy(mesh.matrixWorld);
      privateMesh.frustumCulled=false;privateMesh.layers.set(VOLUME_LAYER);
      privateScene.add(privateMesh);
      const privateCamera=camera.clone();
      privateCamera.matrixAutoUpdate=false;privateCamera.matrix.copy(camera.matrixWorld);
      privateCamera.layers.set(VOLUME_LAYER);privateCamera.updateMatrixWorld(true);
      const textures=new Map();
      for(const {value} of Object.values(material.uniforms))
        if(value?.isTexture)textures.set(value,value.version);
      snapshot={scene:privateScene,mesh:privateMesh,camera:privateCamera,textures};
      input={size:[pass.width,pass.height],altitude:u.uCameraLocal.value.length()-planet.R,
        phase:u.uFrame.value,bins:u.uLightQuadratureSteps.value,paths:u.uLightPathCount.value,
        depth:u.uDepthReady.value,freezeDepth,sequence:pipeline.frameState.sequence,history:pass.historyRead};
      blocked=true;resolveCapture();
      // The main pass has cleared its scratch output but never submits a near
      // draw, resolve, or screen composite for this interrupted frame.
      throw halted;
    };
    try {return profile.call(this,name,work,options);}
    finally {renderer.render=render;}
  }
  pass.profilePhase=profileHook;
  const planet=game._planet(0), coast=game.setWade(0,{depth:.9,overview:true});
  const land=new T.Vector3(...coast.landward);
  const landmark=new T.Vector3(...coast.direction).addScaledVector(land,2000/planet.R).normalize();
  const altitude=212972.2;
  const ratio=T.MathUtils.smoothstep(altitude,150000,220000)*1.13+.32;
  const direction=landmark.clone().addScaledVector(land,-altitude*ratio/planet.R).normalize();
  const start=game.time().hours;
  let best=null;
  for(let k=0;k<=360;k++) {
    const hours=start+k*planet.rotationPeriodHours/360;
    const star=planet.stellarDirectionsAt(hours).sort((a,b)=>b.irradianceFraction-a.irradianceFraction)[0];
    const cosine=landmark.dot(new T.Vector3(...star.direction));
    if(!best||cosine>best.cosine)best={hours,cosine};
  }
  const noCapture=setTimeout(()=>resolveCapture(),90000);
  try {
    game.setTime(best.hours);game.setTimeFrozen();
    game.teleport(0,.12,{dir:coast.direction});
    const deadline=performance.now()+30000;
    while(!planet.weatherStream?.ready) {
      if(gl.isContextLost()||performance.now()>deadline)throw Error('Staged weather bracket did not become ready');
      await new Promise(resolve=>setTimeout(resolve,30));
    }
    armed=true;
    game.setContinuousAtmosphereAltitude(0,altitude,{dir:direction.toArray(),forward:coast.landward,
      surfaceTargetDirection:landmark.toArray()});
    await captured;
    if(captureError)throw captureError;
    if(!input||best.cosine<=.5||!input.depth)throw Error('Expected a lit near draw with live opaque depth');
    const [width,height]=input.size, epoch=readGpuDisjointEpoch(gl,timer);
    target=new T.WebGLRenderTarget(width,height,{type:T.HalfFloatType,depthBuffer:false});
    const render=renderer.render, cases=[];
    const sameInputs=()=>pipeline.frameState.sequence===input.sequence&&pass.historyRead===input.history
      &&[...snapshot.textures].every(([texture,version])=>texture.version===version);
    async function drawPartition(bands,program=material,batched=false) {
      const first=queries.length, stride=Math.ceil(height/(bands*2))*2;
      const started=performance.now();
      const cpuMs=[];
      let previousCompleted;
      for(let y=0;y<height;y+=stride) {
        await pipeline.prepare(()=>{
          if(!sameInputs()||gl.isContextLost())throw Error('Staged input changed between native bands');
          const completed=owner.snapshot().stats.completed;
          if(previousCompleted!==undefined&&completed<=previousCompleted)throw Error('Next band entered before native fence retirement');
          previousCompleted=completed;
          const saved=renderer.getRenderTarget(), face=renderer.getActiveCubeFace(), mip=renderer.getActiveMipmapLevel();
          const clear=renderer.getClearColor(new T.Color()), alpha=renderer.getClearAlpha(), auto=renderer.autoClear;
          try {
            renderer.autoClear=false;
            if(y===0) {
              target.scissorTest=false;renderer.setRenderTarget(target);renderer.setClearColor(0,0);
              renderer.clear(true,false,false);
            }
            const top=Math.min(y+stride,height);
            const clip=program.uniforms.uStagedBand;
            snapshot.mesh.material=program;
            if(clip) {
              clip.value.set(y,top);
              program.uniformsNeedUpdate=true;
            } else if(!batched) {
              target.scissorTest=true;target.scissor.set(0,y,width,top-y);
            }
            renderer.setRenderTarget(target);
            const query=gl.createQuery();queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
            const submitStarted=performance.now();
            try {
              if(batched) {
                if(!batch.render(renderer,snapshot.camera,snapshot.mesh,target))throw Error('Frozen cloud batch did not submit');
              } else render.call(renderer,snapshot.scene,snapshot.camera);
            }
            finally {
              cpuMs.push(performance.now()-submitStarted);
              if(!gl.isContextLost())gl.endQuery(timer.TIME_ELAPSED_EXT);
            }
            if(gl.getError()!==gl.NO_ERROR)throw Error('Staged near band generated a WebGL error');
          } finally {
            target.scissorTest=false;renderer.autoClear=auto;
            renderer.setClearColor(clear,alpha);renderer.setRenderTarget(saved,face,mip);
          }
        },{label:'staged-near-band'});
      }
      const pixels=new Uint16Array(width*height*4);
      await pipeline.prepare(()=>{
        if(!sameInputs()||gl.isContextLost()||owner.snapshot().stats.completed<=previousCompleted)
          throw Error('Staged readback entered before final retirement or with stale inputs');
        renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
      },{label:'staged-near-readback'});
      const gpuMs=queries.slice(first).map(query=>{
        if(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))throw Error('Retired band timer unavailable');
        return gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;
      });
      let programLabel='unmodified';
      if(batched)programLabel='batch';
      else if(program.uniforms.uStagedBand)programLabel='fragment';
      cases.push({bands,program:programLabel,submissions:gpuMs.length,gpuMs,cpuMs,wallMs:performance.now()-started});
      return pixels;
    }
    const half=T.DataUtils.fromHalfFloat;
    function compare(a,b) {
      let changed=0,alpha=0,nonempty=0,maximum=0,nonfinite=0;
      for(let i=0;i<a.length;i++) {
        const x=half(a[i]),y=half(b[i]);
        nonfinite+=Number(!Number.isFinite(x)||!Number.isFinite(y));
        if(i%4===3&&x>0)nonempty++;
        if(a[i]===b[i])continue;
        changed++;alpha+=Number(i%4===3);
        maximum=Math.max(maximum,Math.abs(x-y));
      }
      return {changed,alpha,nonempty,maximum,nonfinite};
    }
    let comparisons, preparationMs, micro, repeatAgainstReference;
    const primed=[];
    if(mode==='batch') {
      const layout={width,height,budgetBytes:32*1024*1024,maxTextureSize:renderer.capabilities.maxTextureSize};
      batch=new CloudLightBatchRenderer(material,layout);
      const reference=comparisonMaterial??material, bands=compareWhole?1:16;
      const first=await drawPartition(bands,reference);
      const start=performance.now();
      const ready=await pipeline.prepare(()=>batch.prepareAsync(renderer,snapshot.camera,snapshot.mesh,target),
        {label:'frozen-cloud-batch-programs'});
      preparationMs=performance.now()-start;
      if(!ready)throw Error('Frozen cloud batch preparation: '+batch.preparationError);
      if(primeBatch)for(const stage of batch.materials) {
        await pipeline.prepare(()=>{
          const program=renderer.properties.get(stage).currentProgram;
          if(!program?.program||gl.isContextLost())throw Error('Frozen program was retired before reflection');
          const started=performance.now();
          program.getUniforms();
          primed.push({stage:stage.name,cpuMs:performance.now()-started});
        },{label:'frozen-cloud-batch-reflection'});
      }
      if(microBatch||splitMicroBatch) {
        if(splitMicroBatch) {
          microTarget=target.clone();
          probeBatch=new CloudLightBatchRenderer(material,layout);
        }
        const executor=probeBatch??batch;
        async function microDraw(selected) {
          const started=performance.now(), names=[];
          let query, submitted, completedBefore;
          await pipeline.prepare(()=>{
            if(!sameInputs())throw Error('Micro batch inputs changed before submission');
            completedBefore=owner.snapshot().stats.completed;
            const tileCount=executor.plan.tileCount;
            const raw=renderer.render, clear=renderer.clear;
            let ordinal=0;
            const admitted=()=>selected===null||selected===ordinal;
            renderer.clear=function(...args) {
              if(admitted())return clear.apply(this,args);
            };
            renderer.render=function(scene,camera) {
              const enabled=admitted();
              ordinal++;
              if(!enabled)return;
              names.push(scene.children[0]?.material?.name);
              const target=this.getRenderTarget(), oldScissor=target.scissor.clone(), oldTest=target.scissorTest;
              try {
                target.scissor.set(0,0,Math.min(16,target.width),Math.min(16,target.height));
                target.scissorTest=true;this.setRenderTarget(target);
                return raw.call(this,scene,camera);
              } finally {target.scissor.copy(oldScissor);target.scissorTest=oldTest;this.setRenderTarget(target);}
            };
            executor.plan.tileCount=1;
            snapshot.mesh.material=material;
            query=gl.createQuery();queries.push(query);gl.beginQuery(timer.TIME_ELAPSED_EXT,query);
            const submitStarted=performance.now();
            try {
              if(!executor.render(renderer,snapshot.camera,snapshot.mesh,microTarget??target)||ordinal!==executor.materials.length
                ||names.length!==(selected===null?ordinal:1))throw Error('Micro batch stage count changed');
            } finally {
              submitted=performance.now()-submitStarted;
              if(!gl.isContextLost())gl.endQuery(timer.TIME_ELAPSED_EXT);
              renderer.render=raw;renderer.clear=clear;executor.plan.tileCount=tileCount;
            }
            if(gl.getError()!==gl.NO_ERROR)throw Error('Micro batch generated a WebGL error');
          },{label:'frozen-cloud-batch-micro-draw'});
          return pipeline.prepare(()=>{
            if(owner.snapshot().stats.completed<=completedBefore||!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))
              throw Error('Micro batch retirement proof unavailable');
            return {stages:names,cpuMs:submitted,gpuMs:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6,wallMs:performance.now()-started};
          },{label:'frozen-cloud-batch-micro-retired'});
        }
        if(splitMicroBatch) {
          micro={cold:[],warm:[]};
          for(const samples of [micro.cold,micro.warm])
            for(let stage=0;stage<executor.materials.length;stage++)samples.push(await microDraw(stage));
          // The probe shares linked GPU programs with the parity draw, but
          // owns its materials, geometry state, and scratch attachments.
          await pipeline.prepare(()=>{
            const program=shader=>renderer.properties.get(shader).currentProgram?.program;
            micro.sharedPrograms=batch.materials.every((shader,i)=>program(shader)&&program(shader)===program(probeBatch.materials[i]));
            if(!micro.sharedPrograms)throw Error('Micro batch used different native programs');
            probeBatch.dispose();probeBatch=null;
            microTarget.dispose();microTarget=null;
          },{label:'frozen-cloud-batch-micro-release'});
        } else micro=await microDraw(null);
      }
      const second=await drawPartition(1,material,true);
      const firstRepeat=await drawPartition(bands,reference), secondRepeat=await drawPartition(1,material,true);
      comparisons={batch:compare(first,second),firstControl:compare(first,firstRepeat),
        secondControl:compare(second,secondRepeat)};
      repeatAgainstReference=compare(first,secondRepeat);
    } else {
      const firstBands=compareWhole?1:16, secondBands=compareWhole?16:24;
      const first=await drawPartition(firstBands), second=await drawPartition(secondBands);
      const firstRepeat=await drawPartition(firstBands), secondRepeat=await drawPartition(secondBands);
      comparisons={partition:compare(first,second),firstControl:compare(first,firstRepeat),
        secondControl:compare(second,secondRepeat)};
      if(comparisonMaterial)comparisons.production=compare(await drawPartition(1,comparisonMaterial),second);
    }
    if(gl.isContextLost()||gl.getError()!==gl.NO_ERROR||readGpuDisjointEpoch(gl,timer)!==epoch||!sameInputs())
      throw Error('Staged GPU proof lost its input or measurement epoch');
    return {...input,history:undefined,sunCosine:best.cosine,mode,cases,comparisons,repeatAgainstReference,
      preparationMs,primed,micro,batch:batch?.plan,
      passed:Object.entries(comparisons).every(([key,row])=>!row.nonfinite&&row.nonempty>0
        &&(key==='batch'?row.alpha===0&&row.maximum<=.002:row.changed===0))};
  } finally {
    clearTimeout(noCapture);pass.profilePhase=profile;
    try {game.teleport(0,.12,{dir:coast.direction});}
    finally {pipeline.submitFrame=originalSubmit;}
    if(!gl.isContextLost())for(const query of queries)gl.deleteQuery(query);
    batch?.dispose();probeBatch?.dispose();target?.dispose();microTarget?.dispose();depthCopy?.dispose();
    material?.dispose();comparisonMaterial?.dispose();
  }
}
