// Same-page physical cloud integration against the previous interval kernel.
// Pin jitter and pause RAF only for the isolated comparison; normal-player
// asynchronous phase evidence and screenshots are collected separately.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const reference='8092cdf',out='test-results/cloud-air-performance';
const privateScene=!process.argv.includes('--live-scene-control');
const currentOnly=process.argv.includes('--current-only-control');
const noFallback=process.argv.includes('--no-fallback');
const historical=true;
const resetState=process.argv.includes('--reset-state-control');
const scanOnly=process.argv.includes('--scan-only-control');
const before=await evidenceFingerprint('tools/cloudairperftest.js');
const old=execFileSync('git',['show',`${reference}:src/clouds-webgl.js`],{encoding:'utf8'});
const start=old.indexOf('      void cloudAirGap(vec3 origin, vec3 dir, float a, float b,'),end=old.indexOf('      // Pixel columns retain',start);
if(start<0||end<0)throw Error('Old air helper boundaries changed');const oldKernel=old.slice(start,end);
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());else if(m.text().startsWith('Interval:'))console.log(m.text());});
  await page.route('**/src/cloud-air-reference.js',r=>r.fulfill({contentType:'text/javascript',body:'export const oldKernel='+JSON.stringify(oldKernel)+';'}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>NMS.setAdaptiveQualityLocked(true));
  await page.waitForFunction(()=>NMS._pipeline.volumePass.activePlanet===NMS._planet(0) && NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(()=>NMS._pipeline.startProfiling({every:1,history:100}));
  await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=32,null,{timeout:180000});
  await page.screenshot({path:`${out}/player.png`});
  const player=await page.evaluate(()=>({profile:NMS._pipeline.performanceSnapshot(),stats:NMS.stats(),pose:NMS.referenceState(),gl:NMS._renderer.getContext().getError()}));
  await page.evaluate(()=>NMS._pipeline.stopProfiling());
  // Composer reuses its depth attachment after the volume stage. Freeze the
  // actual opaque depth at that stage, not the stale texture after a full frame.
  await page.evaluate(()=>new Promise(resolve=>{
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass;
    const target=new T.WebGLRenderTarget(r.domElement.width,r.domElement.height,
      {type:T.FloatType,format:T.RedFormat,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const material=new T.ShaderMaterial({uniforms:{tDepth:{value:null}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tDepth;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tDepth,vUV).r,0,0,1);}',depthTest:false,depthWrite:false});
    scene.add(new T.Mesh(geometry,material));const original=vp.render;
    vp.render=function(renderer,writeBuffer,readBuffer) {
      vp.render=original;
      const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
      material.uniforms.tDepth.value=vp.sceneDepthSource?.sceneDepthTexture||readBuffer.depthTexture;
      if(!material.uniforms.tDepth.value)throw Error('Actual volume depth is unavailable');
      try {r.autoClear=true;r.setRenderTarget(target);r.render(scene,camera);}
      finally {r.setRenderTarget(saved,face,mip);r.autoClear=auto;geometry.dispose();material.dispose();}
      NMS._intervalDepth=target;
      const result=original.apply(this,arguments);resolve();return result;
    };
  }));
  console.log('Interval: normal-player phase baseline captured; comparing frozen physical integrations.');
  const result=await page.evaluate(async ({historical,resetState,scanOnly,noFallback,currentOnly,privateScene})=>{
    const {cloudAirTransportGLSL:current}=await import('/src/cloud/cloud-air-transport-glsl.js');
    const {oldKernel}=await import('/src/cloud-air-reference.js');
    const T=NMS._THREE,r=NMS._renderer,scene=NMS._internals.scene,camera=NMS._internals.camera;
    const p=NMS._pipeline.volumePass.activePlanet,production=p.volCloudMat;
    const mesh=privateScene?new T.Mesh(p.volCloudMesh.geometry,production):p.volCloudMesh;
    const drawScene=privateScene?new T.Scene():scene;
    if(privateScene){mesh.layers.set(2);mesh.frustumCulled=false;mesh.matrixAutoUpdate=false;mesh.matrix.copy(p.volCloudMesh.matrixWorld);drawScene.add(mesh);drawScene.updateMatrixWorld(true);}
    const gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw Error('Hardware GPU timer required');
    const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,pending=new Map();let id=-1;
    window.requestAnimationFrame=callback=>{const key=id--;pending.set(key,callback);return key;};
    window.cancelAnimationFrame=key=>{if(!pending.delete(key))cancel.call(window,key);};
    await new Promise(resolve=>request.call(window,resolve));
    const original=mesh.material,saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
    const mask=camera.layers.mask,auto=r.autoClear,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
    const messages=[],worker=p.weatherStream?.worker,receive=worker?.onmessage;
    if(worker)worker.onmessage=event=>messages.push(event);
    const materials=[false,currentOnly?false:true].map(old=>{
      const material=production.clone();material.uniforms={...production.uniforms,uFrame:{value:0},tSceneDepth:{value:NMS._intervalDepth.texture}};
      if(!material.fragmentShader.includes(current))throw Error('Production interval kernel missing');
      if(old){material.fragmentShader=material.fragmentShader.replace(current,oldKernel);
        const call='cloudAirTransport(uCameraLocal,dir,previousAnchor,nextAnchor,bin>0,\n            airCellEnd,airCellExt,airCellSource,gapLight,gapTransmission);';
        if(!material.fragmentShader.includes(call))throw Error('Anchor dispatch changed');
        material.fragmentShader=material.fragmentShader.replace(call,'if(bin==0)cloudAirGap(uCameraLocal,dir,previousAnchor,nextAnchor,gapLight,gapTransmission);\n          else cloudAirAdvance(uCameraLocal,dir,previousAnchor,nextAnchor,airCellEnd,airCellExt,airCellSource,gapLight,gapTransmission);');}
      if(noFallback)material.fragmentShader=material.fragmentShader.replace('if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);','');
      material.needsUpdate=true;return material;
    });
    const vp=NMS._pipeline.volumePass,target=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.HalfFloatType,depthBuffer:false});
    const readTarget=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.FloatType,depthBuffer:false});
    const geometry=new T.PlaneGeometry(2,2),readScene=new T.Scene(),readCamera=new T.Camera();
    const readMaterial=new T.ShaderMaterial({uniforms:{tInput:{value:target.texture}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tInput;varying vec2 vUV;void main(){gl_FragColor=texture2D(tInput,vUV);}',
      depthTest:false,depthWrite:false});readScene.add(new T.Mesh(geometry,readMaterial));
    const records=[],byImplementation=[],nativeByImplementation=[];let expected=null,nativeExpected=null,changed=0,nativeChanged=0,maximumError=0,occupied=0;
    const inputState=()=>JSON.stringify({geometry:mesh.geometry.uuid,matrix:Array.from(mesh.matrixWorld.elements),uniforms:Object.fromEntries(Object.entries(mesh.material.uniforms).filter(([name])=>name!=='uDiagnosticRadiusPruning').map(([name,{value}])=>
      [name,value?.isTexture?{uuid:value.uuid,version:value.version,sourceVersion:value.source.version}:value]))});
    let firstInputs=null,firstGPU=null;
    const textureIds=new WeakMap();let nextTextureId=0;
    const textureId=value=>{if(!value)return null;if(!textureIds.has(value))textureIds.set(value,++nextTextureId);return textureIds.get(value);};
    const draws=[],draw=r.renderBufferDirect;
    r.renderBufferDirect=function(...args){draws.push({object:args[4].id,name:args[4].name,material:args[3].uuid,own:args[4]===mesh});return draw.apply(this,args);};
    try {
      camera.layers.set(2);r.autoClear=true;r.setClearColor(0,0);
      for(let round=0;round<4;round++)for(const index of round%2?[1,0]:[0,1]) {
        mesh.material=materials[index];mesh.material.uniformsNeedUpdate=true;
        if(resetState)r.resetState();
        const inputs=inputState();firstInputs||=inputs;
        r.setRenderTarget(target);r.clear(true,false,false);
        const query=gl.createQuery(),started=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
        try {r.render(drawScene,camera);} finally {gl.endQuery(ext.TIME_ELAPSED_EXT);}
        const properties=r.properties.get(mesh.material),program=properties.currentProgram.program;
        const gpuInputs={};
        const savedUnit=gl.getParameter(gl.ACTIVE_TEXTURE);
        for(let i=0;i<gl.getProgramParameter(program,gl.ACTIVE_UNIFORMS);i++) {
          const {name,type}=gl.getActiveUniform(program,i);if(name==='uDiagnosticRadiusPruning')continue;
          const value=gl.getUniform(program,gl.getUniformLocation(program,name));
          gpuInputs[name]=ArrayBuffer.isView(value)?Array.from(value):value;
          const binding=type===gl.SAMPLER_2D||type===gl.UNSIGNED_INT_SAMPLER_2D||type===gl.INT_SAMPLER_2D?gl.TEXTURE_BINDING_2D:type===gl.SAMPLER_3D?gl.TEXTURE_BINDING_3D:
            type===gl.SAMPLER_2D_ARRAY||type===gl.UNSIGNED_INT_SAMPLER_2D_ARRAY?gl.TEXTURE_BINDING_2D_ARRAY:null;
          if(binding){gl.activeTexture(gl.TEXTURE0+value);gpuInputs[name+'Texture']=textureId(gl.getParameter(binding));}
        }
        gl.activeTexture(savedUnit);
        firstGPU||=gpuInputs;
        const gpuChanged=Object.keys(gpuInputs).filter(name=>JSON.stringify(gpuInputs[name])!==JSON.stringify(firstGPU[name]));
        const cpuMs=performance.now()-started;gl.flush();
        while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))await new Promise(resolve=>setTimeout(resolve,5));
        if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint timer');
        const gpuMs=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(query);
        const native=new Uint16Array(target.width*target.height*4);
        r.readRenderTargetPixels(target,0,0,target.width,target.height,native);
        let nativeRepeatChanged=0;
        if(nativeExpected) {
          for(let i=0;i<native.length;i++)if(native[i]!==nativeExpected[i])nativeChanged++;
        } else nativeExpected=native;
        if(nativeByImplementation[index])for(let i=0;i<native.length;i++)if(native[i]!==nativeByImplementation[index][i])nativeRepeatChanged++;
        nativeByImplementation[index]||=native;
        r.setRenderTarget(readTarget);r.render(readScene,readCamera);
        const pixels=new Float32Array(target.width*target.height*4);r.readRenderTargetPixels(readTarget,0,0,target.width,target.height,pixels);
        if(!expected){expected=pixels;for(let i=3;i<pixels.length;i+=4)if(pixels[i]>.004)occupied++;}
        else for(let i=0;i<pixels.length;i++){const error=Math.abs(pixels[i]-expected[i]);if(error)changed++;maximumError=Math.max(maximumError,error);}
        let sameImplementationChanged=0,sameImplementationMaximum=0;const repeatChannels=[0,0,0,0];
        if(byImplementation[index])for(let i=0;i<pixels.length;i++) {
          const error=Math.abs(pixels[i]-byImplementation[index][i]);if(error){sameImplementationChanged++;repeatChannels[i%4]++;}
          sameImplementationMaximum=Math.max(sameImplementationMaximum,error);
        }
        byImplementation[index]||=pixels;
        records.push({round,implementation:index?'reference':'current',cpuMs,gpuMs,sameImplementationChanged,sameImplementationMaximum,nativeRepeatChanged,inputsChanged:inputs!==firstInputs,gpuChanged,repeatChannels});
        console.log('Interval: '+JSON.stringify(records.at(-1)));
      }
      let alphaChanged=0;if(byImplementation[0]&&byImplementation[1])for(let i=3;i<byImplementation[0].length;i+=4)if(byImplementation[0][i]!==byImplementation[1][i])alphaChanged++;
      return {records,alphaChanged,changed,nativeChanged,maximumError,occupied,width:target.width,height:target.height,gl:gl.getError(),draws,noFallback,currentOnly,privateScene,queuedWeatherMessages:messages.length,
        scope:'Actual occupied rays; fixed jitter; isolated RAF/depth only in tool. Independent 8092cdf air helper and dispatch. Optional no-fallback deliberately wrong-radiance attribution. Normal player screenshot before isolation keeps full production lighting.'};
    } finally {
      r.renderBufferDirect=draw;mesh.material=original;camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);
      materials.forEach(m=>m.dispose());target.dispose();readTarget.dispose();geometry.dispose();readMaterial.dispose();
      NMS._intervalDepth.dispose();delete NMS._intervalDepth;
      if(worker){worker.onmessage=receive;for(const event of messages)receive?.call(worker,event);}
      window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;
      for(const callback of pending.values())request.call(window,callback);
    }
  },{historical,resetState,scanOnly,noFallback,currentOnly,privateScene});
  const after=await evidenceFingerprint('tools/cloudairperftest.js');
  await writeFile(`${out}/${privateScene?'private-':''}${currentOnly?'current-only':noFallback?'no-fallback':'report'}.json`,JSON.stringify({reference,before,after,player,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);assert.equal(player.gl,0);assert.equal(result.gl,0);
  assert.ok(result.occupied>1000);assert.equal(result.alphaChanged,0,'Cloud opacity must remain exact');
  for(const draw of result.records){assert.equal(draw.nativeRepeatChanged,0);assert.equal(draw.sameImplementationChanged,0);assert.equal(draw.inputsChanged,false);assert.deepEqual(draw.gpuChanged,[]);}
  if(currentOnly){assert.equal(result.nativeChanged,0);assert.equal(result.changed,0);}
    console.log(`PASS: repeated native HDR, unchanged opacity and warm GPU attribution; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
