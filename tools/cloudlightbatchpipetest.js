import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const trace=process.argv.includes('--trace');
const forcedJitter=process.argv.find(arg=>arg.startsWith('--jitter='))?.slice(9);
const out='test-results/cloud-light-batch/'+(trace?'lifecycle-trace':'lifecycle-pipeline'),before=await evidenceFingerprint('tools/cloudlightbatchpipetest.js');
await mkdir(out,{recursive:true});
const {server,port}=await startServer(0);let browser;const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted&&NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(({trace,forcedJitter})=>{
    NMS.setAdaptiveQualityLocked(true);
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass;
    const target=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.HalfFloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const original=vp.render;
    window._batchPipe={records:[],glErrors:[],phase:'initial',target,original,sourceGeometry:NMS._planet(0).volCloudMesh.geometry,
      sourceNoise:NMS._planet(0).volCloudMat.uniforms.uNoise3.value};
    const state=window._batchPipe,rawRender=r.render,rawClear=r.clear;
    const gl=r.getContext(),rawLink=gl.linkProgram,rawBatch=vp.renderLightBatches;
    state.submissions=[];state.links=0;
    state.trace=[];state.draws=[];state.glTotals={};const traceRestores=[];
    const nativeMethods=new Set();
    for(let prototype=Object.getPrototypeOf(gl);prototype&&prototype!==Object.prototype;prototype=Object.getPrototypeOf(prototype))
      for(const [name,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(prototype)))
        if(name!=='constructor'&&typeof descriptor.value==='function')nativeMethods.add(name);
    if(trace)for(const name of nativeMethods) {
      const raw=gl[name];gl[name]=function(...args){if(!state.inBatch)return raw.apply(this,args);
        const started=performance.now();try{return raw.apply(this,args);}finally{
          const cpuMs=performance.now()-started;
          const total=state.glTotals[name]||={calls:0,cpuMs:0};total.calls++;total.cpuMs+=cpuMs;
          if(cpuMs>1)state.trace.push({phase:state.phase,name,cpuMs,material:state.drawMaterial});
        }};traceRestores.push(()=>{gl[name]=raw;});
    }
    gl.linkProgram=function(...args){if(state.inBatch)state.links++;return rawLink.apply(this,args);};
    vp.renderLightBatches=function(...args) {
      const started=performance.now(),links=state.links;state.inBatch=true;
      try{return rawBatch.apply(this,args);}finally {
        state.inBatch=false;
        state.submissions.push({phase:state.phase,cpuMs:performance.now()-started,links:state.links-links,reason:this.lightBatchStatus.reason,
          programIds:this.lightBatch?.materials.map(material=>r.properties.get(material).currentProgram?.id),
          ready:this.lightBatch?.programsReady});
      }
    };
    const checkDraw=where=>{
      const gl=r.getContext(),code=gl.getError();if(!code)return;
      const rt=r.getRenderTarget();
      state.glErrors.push({phase:state.phase,where,code,target:rt?.texture?.name,width:rt?.width,height:rt?.height,
        depth:rt?.depthTexture?.image,framebufferStatus:gl.checkFramebufferStatus(gl.FRAMEBUFFER)});
    };
    r.render=function(...args){state.drawMaterial=args[0].children?.[0]?.material?.name;
      const started=performance.now(),result=rawRender.apply(this,args);
      if(trace&&state.inBatch)state.draws.push({phase:state.phase,material:state.drawMaterial,cpuMs:performance.now()-started});
      checkDraw('renderer.render');return result;};
    r.clear=function(...args){const result=rawClear.apply(this,args);checkDraw('renderer.clear');return result;};
    const profilePhase=vp.profilePhase;
    state.restoreRenderer=()=>{r.render=rawRender;r.clear=rawClear;gl.linkProgram=rawLink;vp.renderLightBatches=rawBatch;
      vp.profilePhase=profilePhase;traceRestores.forEach(restore=>restore());};
    vp.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});
    vp.profilePhase=function(name,work,options) {
      if(name==='volume-current'&&forcedJitter!==undefined&&state.phase==='initial')
        NMS._planet(0).volCloudMat.uniforms.uFrame.value=Number(forcedJitter);
      return profilePhase.call(this,name,work,options);
    };
    vp.render=function(...args) {
      const state=window._batchPipe,gl=r.getContext();
      const check=where=>{const code=gl.getError();if(code)state.glErrors.push({phase:state.phase,where,code});};
      check('before-volume');const result=original.apply(this,args);check('after-volume');
      if(!this.lightBatchStatus.submitted) {state.records.push({phase:state.phase,reason:this.lightBatchStatus.reason});return result;}
      if(state.records.filter(record=>record.phase===state.phase).length>=16)return result;
      target.setSize(this.width,this.height);
      const current=new Uint16Array(this.width*this.height*4),reference=new Uint16Array(current.length);
      r.readRenderTargetPixels(this.current,0,0,this.width,this.height,current);
      check('read-current');
      const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
      const mask=this.camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
      try {
        this.camera.layers.set(2);r.autoClear=false;r.setClearColor(0,0);r.setRenderTarget(target);r.clear(true,false,false);
        r.render(this.scene,this.camera);check('draw-reference');r.readRenderTargetPixels(target,0,0,this.width,this.height,reference);check('read-reference');
      }finally {this.camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);}
      check('restore-reference-target');
      const channels=[0,0,0,0];let maximumError=0;
      for(let i=0;i<current.length;i++)if(current[i]!==reference[i]) {
        channels[i%4]++;maximumError=Math.max(maximumError,Math.abs(T.DataUtils.fromHalfFloat(current[i])-T.DataUtils.fromHalfFloat(reference[i])));
      }
      let occupied=0;for(let i=3;i<reference.length;i+=4)if(T.DataUtils.fromHalfFloat(reference[i])>.004)occupied++;
      if(maximumError>=.002) {
        const originals=reference.slice(),mesh=NMS._planet(0).volCloudMesh;
        const input=()=>JSON.stringify({camera:this.camera.matrixWorld.elements,matrix:mesh.matrixWorld.elements,
          uniforms:Object.fromEntries(Object.entries(mesh.material.uniforms).map(([name,{value}])=>[name,
            value?.isTexture?[value.uuid,value.version,value.source.version]:value]))});
        const before=input(),diagnostic={phase:state.phase,jitter:mesh.material.uniforms.uFrame.value,originals:[]};
        const compare=(a,b)=>{let error=0,changed=0;for(let i=0;i<a.length;i++)if(a[i]!==b[i]){
          changed++;error=Math.max(error,Math.abs(T.DataUtils.fromHalfFloat(a[i])-T.DataUtils.fromHalfFloat(b[i])));
        }return {changed,maximumError:error};};
        const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),auto=r.autoClear;
        const mask=this.camera.layers.mask,color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
        try {
          this.camera.layers.set(2);r.autoClear=false;r.setClearColor(0,0);
          for(let i=0;i<2;i++) {
            r.setRenderTarget(target);r.clear(true,false,false);r.render(this.scene,this.camera);
            r.readRenderTargetPixels(target,0,0,this.width,this.height,reference);diagnostic.originals.push(compare(originals,reference));
          }
          this.lightBatch.render(r,this.camera,mesh,target);r.readRenderTargetPixels(target,0,0,this.width,this.height,reference);
          diagnostic.batch=compare(current,reference);diagnostic.inputsChanged=before!==input();
          diagnostic.matrixChanged=this.lightBatch.mesh.matrixWorld.elements.some((value,i)=>value!==mesh.matrixWorld.elements[i]);
          (state.repeatDiagnostics||=[]).push(diagnostic);
        }finally{this.camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved,face,mip);}
      }
      if(state.phase==='new-owner'&&state.staleOwnerControl===undefined) {
        const mesh=NMS._planet(0).volCloudMesh,owner=mesh.material;
        const saved=r.getRenderTarget(),auto=r.autoClear,mask=this.camera.layers.mask;
        const color=r.getClearColor(new T.Color()),alpha=r.getClearAlpha();
        try {
          mesh.material=state.oldOwner;this.camera.layers.set(2);r.autoClear=false;r.setClearColor(0,0);
          r.setRenderTarget(target);r.clear(true,false,false);r.render(this.scene,this.camera);
          r.readRenderTargetPixels(target,0,0,this.width,this.height,reference);
          let error=0;for(let i=0;i<current.length;i++)error=Math.max(error,Math.abs(T.DataUtils.fromHalfFloat(current[i])-T.DataUtils.fromHalfFloat(reference[i])));
          state.staleOwnerControl=error;
        }finally{mesh.material=owner;this.camera.layers.mask=mask;r.autoClear=auto;r.setClearColor(color,alpha);r.setRenderTarget(saved);}
      }
      state.records.push({phase:state.phase,reason:this.lightBatchStatus.reason,channels,maximumError,occupied,position:NMS.pos(),
        jitter:NMS._planet(0).volCloudMat.uniforms.uFrame.value,plan:this.lightBatch.plan});
    };
  },{trace,forcedJitter});
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='initial'&&record.channels),null,{timeout:180000});
  const initial=await page.evaluate(()=>window._batchPipe.records.at(-1));assert.equal(initial.reason,'same-frame');
  await page.evaluate(()=>{const state=window._batchPipe;state.first=NMS._pipeline.volumePass.lightBatch;
    state.firstPrograms=[...state.first.materials];});
  await page.screenshot({path:`${out}/initial-player.png`});
  await page.evaluate(()=>{window._batchPipe.phase='movement';window._batchPipe.start=NMS.pos();});
  await page.keyboard.down('w');
  await page.waitForFunction(()=>window._batchPipe.records.filter(record=>record.phase==='movement'&&record.channels).length>=12,null,{timeout:120000});
  await page.keyboard.up('w');await page.screenshot({path:`${out}/moving-player.png`});
  const movement=await page.evaluate(()=>({start:window._batchPipe.start,end:NMS.pos()}));
  assert.ok(movement.end.some((value,i)=>Math.abs(value-movement.start[i])>.01),'Normal flight input must actually move');
  await page.evaluate(()=>{window._batchPipe.phase='budget';window._batchPipe.previous=NMS._pipeline.volumePass.lightBatch;
    NMS._pipeline.volumePass.setLightBatchesEnabled(true,{budgetBytes:1024*1024});});
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='budget'&&record.reason==='budget'));
  assert.equal(await page.evaluate(()=>window._batchPipe.previous.disposed),false);
  assert.equal(await page.evaluate(()=>window._batchPipe.previous.targets.length),0);
  await page.evaluate(()=>{window._batchPipe.phase='resize';NMS._pipeline.volumePass.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});});
  await page.setViewportSize({width:960,height:540});
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='resize'&&record.channels),null,{timeout:180000});
  await page.screenshot({path:`${out}/resized-player.png`});
  assert.equal(await page.evaluate(()=>{const state=window._batchPipe,stage=NMS._pipeline.volumePass.lightBatch;
    return stage===state.first&&stage.materials.every((material,i)=>material===state.firstPrograms[i]);}),true);
  await page.evaluate(()=>{window._batchPipe.phase='original-resize';NMS._pipeline.volumePass.lightBatchesEnabled=false;});
  await page.waitForFunction(()=>window._batchPipe.records.filter(record=>record.phase==='original-resize').length>=3);
  await page.evaluate(()=>{NMS._pipeline.volumePass.lightBatchesEnabled=true;});
  await page.evaluate(()=>{
    const T=NMS._THREE,state=window._batchPipe;state.phase='foreign-owner';state.previous=NMS._pipeline.volumePass.lightBatch;
    state.foreign=new T.Mesh(new T.PlaneGeometry(1,1),new T.MeshBasicMaterial());state.foreign.layers.set(2);
    state.foreign.frustumCulled=false;NMS._pipeline.volumePass.scene.add(state.foreign);
  });
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='foreign-owner'&&record.reason==='multiple-volume-owners'));
  const foreignDisposed=await page.evaluate(()=>{
    const state=window._batchPipe,disposed=state.previous.disposed;
    NMS._pipeline.volumePass.scene.remove(state.foreign);state.foreign.geometry.dispose();state.foreign.material.dispose();state.phase='return';return disposed;
  });assert.equal(foreignDisposed,false);
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='return'&&record.channels),null,{timeout:180000});
  await page.evaluate(()=>{
    const state=window._batchPipe,mesh=NMS._planet(0).volCloudMesh;state.phase='callback';state.afterCalls=0;
    state.originalAfter=mesh.onAfterRender;mesh.onAfterRender=()=>{state.afterCalls++;};
  });
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='callback'&&record.reason==='custom-render-callback'));
  await page.evaluate(()=>{const state=window._batchPipe;NMS._planet(0).volCloudMesh.onAfterRender=state.originalAfter;});
  await page.evaluate(()=>{
    const state=window._batchPipe,p=NMS._planet(0);state.phase='new-owner';state.oldOwner=p.volCloudMat;
    state.retained=NMS._pipeline.volumePass.lightBatch;state.retainedPrograms=[...state.retained.materials];
    state.newOwner=state.oldOwner.clone();state.newOwner.uniforms={...state.oldOwner.uniforms,uTint:{value:new NMS._THREE.Color(.3,.8,.4)}};
    p.volCloudMat=state.newOwner;p.volCloudMesh.material=state.newOwner;
  });
  await page.waitForFunction(()=>window._batchPipe.records.filter(record=>record.phase==='new-owner'&&record.channels).length>=3,null,{timeout:180000});
  assert.equal(await page.evaluate(()=>{const state=window._batchPipe,stage=NMS._pipeline.volumePass.lightBatch;
    return stage===state.retained&&stage.materials.every((material,i)=>material===state.retainedPrograms[i])
      &&stage.prepare.uniforms.uTint===state.newOwner.uniforms.uTint;}),true);
  await page.evaluate(()=>{const state=window._batchPipe,p=NMS._planet(0);p.volCloudMat=state.oldOwner;p.volCloudMesh.material=state.oldOwner;
    state.phase='owner-return';});
  await page.waitForFunction(()=>window._batchPipe.records.filter(record=>record.phase==='owner-return'&&record.channels).length>=3,null,{timeout:180000});
  await page.evaluate(()=>window._batchPipe.newOwner.dispose());
  const result=await page.evaluate(()=>{
    const state=window._batchPipe,vp=NMS._pipeline.volumePass,r=NMS._renderer;
    vp.render=state.original;state.restoreRenderer();vp.setLightBatchesEnabled(false);state.target.dispose();
    return {records:state.records,submissions:state.submissions,trace:state.trace,draws:state.draws,glTotals:state.glTotals,
      glErrors:state.glErrors,repeatDiagnostics:state.repeatDiagnostics,afterCalls:state.afterCalls,staleOwnerControl:state.staleOwnerControl,
      movement:{start:state.start,end:NMS.pos()},status:vp.lightBatchStatus,released:vp.lightBatch===null,
      sourceGeometryIntact:NMS._planet(0).volCloudMesh.geometry===state.sourceGeometry&&state.sourceGeometry.attributes.position.count>0,
      sourceNoiseIntact:NMS._planet(0).volCloudMat.uniforms.uNoise3.value===state.sourceNoise,gl:r.getContext().getError()};
  });
  const after=await evidenceFingerprint('tools/cloudlightbatchpipetest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(before.verifierDigest,after.verifierDigest);
  assert.deepEqual(errors,[]);assert.deepEqual(result.glErrors,[]);assert.equal(result.gl,0);assert.equal(result.released,true);
  assert.equal(result.sourceGeometryIntact,true);assert.equal(result.sourceNoiseIntact,true);
  assert.ok(result.afterCalls>0,'Fallback must preserve the original source render callbacks');
  assert.ok(result.staleOwnerControl>.002,'A stale owner must fail the unchanged physical-radiance gate');
  for(const phase of ['movement','budget','resize','return','callback','new-owner','owner-return'])
    assert.ok(result.submissions.filter(record=>record.phase===phase).every(record=>record.links===0),'Compatible migration must not relink: '+phase);
  for(const record of result.records.filter(record=>record.channels)) {
    // Keep the existing physical-radiance gate in a moving real scene. The
    // separate fixed-input R32F suite additionally requires bit-exact HDR.
    assert.ok(record.maximumError<.002,'Actual scene must preserve same-frame physical radiance');
    assert.equal(record.channels[3],0);assert.ok(record.occupied>1000);assert.ok(record.plan.residentBytes<=record.plan.budgetBytes);
  }
  console.log(`PASS actual player pipeline, moving HDR, program/scratch lifetime, resize, new owner, callbacks and final release: ${out}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
