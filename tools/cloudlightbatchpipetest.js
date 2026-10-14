import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const out='test-results/cloud-light-batch/pipeline',before=await evidenceFingerprint('tools/cloudlightbatchpipetest.js');
await mkdir(out,{recursive:true});
const {server,port}=await startServer(0);let browser;const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',error=>errors.push(String(error)));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted&&NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(()=>{
    NMS.setAdaptiveQualityLocked(true);
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass;
    const target=new T.WebGLRenderTarget(vp.width,vp.height,{type:T.HalfFloatType,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const original=vp.render;
    window._batchPipe={records:[],glErrors:[],phase:'initial',target,original,sourceGeometry:NMS._planet(0).volCloudMesh.geometry,
      sourceNoise:NMS._planet(0).volCloudMat.uniforms.uNoise3.value};
    const state=window._batchPipe,rawRender=r.render,rawClear=r.clear;
    const checkDraw=where=>{
      const gl=r.getContext(),code=gl.getError();if(!code)return;
      const rt=r.getRenderTarget();
      state.glErrors.push({phase:state.phase,where,code,target:rt?.texture?.name,width:rt?.width,height:rt?.height,
        depth:rt?.depthTexture?.image,framebufferStatus:gl.checkFramebufferStatus(gl.FRAMEBUFFER)});
    };
    r.render=function(...args){const result=rawRender.apply(this,args);checkDraw('renderer.render');return result;};
    r.clear=function(...args){const result=rawClear.apply(this,args);checkDraw('renderer.clear');return result;};
    state.restoreRenderer=()=>{r.render=rawRender;r.clear=rawClear;};
    vp.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});
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
      state.records.push({phase:state.phase,reason:this.lightBatchStatus.reason,channels,maximumError,occupied,position:NMS.pos(),
        jitter:NMS._planet(0).volCloudMat.uniforms.uFrame.value,plan:this.lightBatch.plan});
    };
  });
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='initial'&&record.channels),null,{timeout:180000});
  const initial=await page.evaluate(()=>window._batchPipe.records.at(-1));assert.equal(initial.reason,'same-frame');
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
  assert.equal(await page.evaluate(()=>window._batchPipe.previous.disposed),true);
  await page.evaluate(()=>{window._batchPipe.phase='resize';NMS._pipeline.volumePass.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});});
  await page.setViewportSize({width:960,height:540});
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='resize'&&record.channels),null,{timeout:180000});
  await page.screenshot({path:`${out}/resized-player.png`});
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
  });assert.equal(foreignDisposed,true);
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='return'&&record.channels),null,{timeout:180000});
  await page.evaluate(()=>{
    const state=window._batchPipe,mesh=NMS._planet(0).volCloudMesh;state.phase='callback';state.afterCalls=0;
    state.originalAfter=mesh.onAfterRender;mesh.onAfterRender=()=>{state.afterCalls++;};
  });
  await page.waitForFunction(()=>window._batchPipe.records.some(record=>record.phase==='callback'&&record.reason==='custom-render-callback'));
  await page.evaluate(()=>{const state=window._batchPipe;NMS._planet(0).volCloudMesh.onAfterRender=state.originalAfter;});
  const result=await page.evaluate(()=>{
    const state=window._batchPipe,vp=NMS._pipeline.volumePass,r=NMS._renderer;
    vp.render=state.original;state.restoreRenderer();vp.setLightBatchesEnabled(false);state.target.dispose();
    return {records:state.records,glErrors:state.glErrors,afterCalls:state.afterCalls,movement:{start:state.start,end:NMS.pos()},status:vp.lightBatchStatus,released:vp.lightBatch===null,
      sourceGeometryIntact:NMS._planet(0).volCloudMesh.geometry===state.sourceGeometry&&state.sourceGeometry.attributes.position.count>0,
      sourceNoiseIntact:NMS._planet(0).volCloudMat.uniforms.uNoise3.value===state.sourceNoise,gl:r.getContext().getError()};
  });
  const after=await evidenceFingerprint('tools/cloudlightbatchpipetest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(before.verifierDigest,after.verifierDigest);
  assert.deepEqual(errors,[]);assert.deepEqual(result.glErrors,[]);assert.equal(result.gl,0);assert.equal(result.released,true);
  assert.equal(result.sourceGeometryIntact,true);assert.equal(result.sourceNoiseIntact,true);
  assert.ok(result.afterCalls>0,'Fallback must preserve the original source render callbacks');
  for(const record of result.records.filter(record=>record.channels)) {
    // Keep the existing physical-radiance gate in a moving real scene. The
    // separate fixed-input R32F suite additionally requires bit-exact HDR.
    assert.ok(record.maximumError<.002,'Actual scene must preserve same-frame physical radiance');
    assert.equal(record.channels[3],0);assert.ok(record.occupied>1000);assert.ok(record.plan.residentBytes<=record.plan.budgetBytes);
  }
  console.log(`PASS actual player pipeline, 12 moving same-frame comparisons, jitter, budget fallback, resize, foreign owner and borrowed resources: ${out}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
