import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const out='test-results/cloud-light-batch/activation',before=await evidenceFingerprint('tools/cloudlightbatchactivationtest.js');
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
    const vp=NMS._pipeline.volumePass,r=NMS._renderer,gl=r.getContext(),ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw Error('Hardware timer required');
    const state=window._batchActivation={phase:'original',frames:[],submissions:[],queries:[],started:performance.now(),stopped:false};
    let previous=null,previousPhase=null;
    const frame=timestamp=>{
      if(state.stopped)return;
      if(previous!==null)state.frames.push({phase:state.phase,previousPhase,deltaMs:timestamp-previous,elapsedMs:performance.now()-state.started});
      previous=timestamp;previousPhase=state.phase;state.raf=requestAnimationFrame(frame);
    };state.raf=requestAnimationFrame(frame);
    const original=vp.renderLightBatches;state.original=original;
    vp.renderLightBatches=function(...args) {
      const measured=this.lightBatch?.programsReady&&!this.lightBatch.plan.direct&&state.queries.length<8;
      const query=measured?gl.createQuery():null;if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
      const started=performance.now();let submitted;
      try {submitted=original.apply(this,args);return submitted;}finally {
        const cpuMs=performance.now()-started;if(query){gl.endQuery(ext.TIME_ELAPSED_EXT);state.queries.push({query,submitted});}
        state.submissions.push({phase:state.phase,cpuMs,reason:this.lightBatchStatus.reason,submitted,elapsedMs:performance.now()-state.started});
      }
    };
  });
  await page.waitForTimeout(8000);
  await page.evaluate(()=>{window._batchActivation.phase='activation';NMS._pipeline.volumePass.setLightBatchesEnabled(true,{budgetBytes:8*1024*1024});});
  await page.waitForTimeout(40000);
  const result=await page.evaluate(async()=>{
    const state=window._batchActivation,vp=NMS._pipeline.volumePass,r=NMS._renderer,gl=r.getContext();
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    state.stopped=true;cancelAnimationFrame(state.raf);vp.renderLightBatches=state.original;
    const queries=[];
    for(const {query,submitted} of state.queries) {
      const deadline=performance.now()+10000;
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE)) {
        if(performance.now()>deadline)throw Error('Activation timer deadline');
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      queries.push({submitted,gpuMs:gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6});gl.deleteQuery(query);
    }
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    return {frames:state.frames,submissions:state.submissions,queries,gl:gl.getError(),disjoint:gl.getParameter(ext.GPU_DISJOINT_EXT),
      status:vp.lightBatchStatus,elapsedMs:performance.now()-state.started,gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,
      scope:'Normal HUD/post, stationary lowflight and locked balanced quality. No per-draw errors, readbacks or timer polling during measurement. RAF cadence is whole-page scheduling, not display presentation or long-flight acceptance.'};
  });
  await page.screenshot({path:`${out}/player.png`});
  const after=await evidenceFingerprint('tools/cloudlightbatchactivationtest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(before.verifierDigest,after.verifierDigest);
  assert.deepEqual(errors,[]);assert.equal(result.gl,0);assert.equal(result.disjoint,false);
  assert.equal(result.status.reason,'same-frame');assert.ok(result.submissions.filter(record=>record.submitted).length>10);
  console.log(`PASS passive activation, whole-page RAF cadence and outside-kernel GPU timers: ${out}`);
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
