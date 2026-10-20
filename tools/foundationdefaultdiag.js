// Default production cloud path. Passive GL timing before placement; optional
// first-error attribution from boot or after replacement. Route/prewarm controls
// are explicitly experimental and must not be presented as runtime acceptance.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir,open,readFile,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
import {installFoundationGLProbe} from './foundation-gl-probe.js';
import {installFoundationContextProbe} from './foundation-context-probe.js';
import {probeCloudProgramPrewarm} from './cloud-program-prewarm-browser.js';

const trace=process.argv.includes('--trace'),errorsProbe=process.argv.includes('--errors');
const errorsFromBoot=process.argv.includes('--errors-from-boot');
const ownerModes=process.argv.includes('--owner-modes');
const historyTransitions=process.argv.includes('--history-transitions');
const parallelNearControl=process.argv.includes('--parallel-near-control');
const viewLoopControl=process.argv.includes('--view-loop-control');
const beamLoopControl=process.argv.includes('--beam-loop-control');
const extinctionCallControl=process.argv.includes('--extinction-call-control');
const legacyColdControl=process.argv.includes('--legacy-cold-control');
assert.ok([viewLoopControl,beamLoopControl,extinctionCallControl,legacyColdControl,parallelNearControl].filter(Boolean).length<=1,'Isolate one program control per experiment');
const traceCategories='gpu,devtools.timeline,blink.user_timing';
let cloudOverride=null,cloudOverrideBody=null,legacyLutBody=null;
if(viewLoopControl||beamLoopControl||extinctionCallControl||legacyColdControl) {
  const original=await readFile('src/clouds-webgl.js','utf8');
  cloudOverrideBody=legacyColdControl?execFileSync('git',['show','bc340db:src/clouds-webgl.js'],{encoding:'utf8'}):original;
  if(legacyColdControl)legacyLutBody=execFileSync('git',['show','bc340db:src/atmosphere-multiple-scattering.js'],{encoding:'utf8'});
  const replacements=viewLoopControl||legacyColdControl?[
    ['uViewCapacity: { value: 8192 },','uViewCapacity: { value: 8192 },\n      uOpticalMassPasses: { value: 2 },'],
    ['uniform float uViewCapacity;','uniform float uViewCapacity;\n      uniform int uOpticalMassPasses;'],
    ['for(int pass=0;pass<2;pass++)','for(int pass=0;pass<uOpticalMassPasses;pass++)'],
  ]:extinctionCallControl?[
    ['if (uLocalBands < 0.5) return densityAt(local) * legacySigma;\n        vec2 layers = cloudLayersAt(local);',
      'vec2 layers = cloudLayersAt(local);\n        if (uLocalBands < 0.5) return max(layers.x, layers.y * 0.06) * legacySigma;'],
  ]:[
    ['uViewCapacity: { value: 8192 },','uViewCapacity: { value: 8192 },\n      uPhysicalBeamIterations: { value: 8192 },'],
    ['uniform float uViewCapacity;','uniform float uViewCapacity;\n      uniform int uPhysicalBeamIterations;'],
    ['${cloudBeamGLSL}',"${cloudBeamGLSL.replace('for(int j=0;j<8192;j++)','for(int j=0;j<uPhysicalBeamIterations;j++)')}"],
  ];
  for(const [from,to] of replacements) {
    assert.equal(cloudOverrideBody.split(from).length-1,1,`Experimental cloud override must match exactly once: ${from}`);
    cloudOverrideBody=cloudOverrideBody.replace(from,to);
  }
  const digest=value=>createHash('sha256').update(value).digest('hex');
  cloudOverride={module:'src/clouds-webgl.js',kind:legacyColdControl?'legacy-view-loop-cold-control':extinctionCallControl?'route-only-extinction-call-control':beamLoopControl?'route-only-beam-loop-control':'route-only-view-loop-control',
    originalSha256:digest(original),modifiedSha256:digest(cloudOverrideBody),replacements:replacements.length,
    ...(legacyColdControl?{reference:'bc340db',companionModule:'src/atmosphere-multiple-scattering.js',companionSha256:digest(legacyLutBody)}:{}),
    boundary:`Experimental served module with ${extinctionCallControl?'one density callsite in extinction':beamLoopControl?'uniform physical beam bound of 8192':'uniform optical mass pass bound of 2'}${legacyColdControl?' and old LUT for historical warning reproduction':''}; repository runtime bytes unchanged. This is not production-source acceptance.`};
}
const out=`test-results/foundation-default/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/foundationdefaultdiag.js');
const helperBefore=await evidenceFingerprint('tools/foundation-gl-probe.js');
const contextHelperBefore=await evidenceFingerprint('tools/foundation-context-probe.js');
const warmHelperBefore=await evidenceFingerprint('tools/cloud-program-prewarm-browser.js');
const {server,port}=await startServer(0);
let browser;
const errors=[],warnings=[],driverWarnings=[],checkpoints=[],workerEvents=[],networkFailures=[];
let warningDropped=0,driverWarningCount=0,page,cdp,traceStarted=false,report,ownerModesResult=null;
let parallelNearResult=null;
let traceState={requested:trace,categories:traceCategories,completed:false};
async function finishTrace() {
  if(!traceStarted)return;traceStarted=false;
  let stream,file,bytes=0,chunks=0,failure;
  let completeHandler,completeTimer;
  try {
    const complete=new Promise((resolve,reject)=>{
      completeHandler=resolve;cdp.once('Tracing.tracingComplete',completeHandler);
      completeTimer=setTimeout(()=>reject(new Error('Tracing.tracingComplete timed out')),30000);
    });
    await cdp.send('Tracing.end');({stream}=await complete);clearTimeout(completeTimer);
    file=await open(`${out}/chrome-trace.json`,'w');
    for(;;) {
      const chunk=await cdp.send('IO.read',{handle:stream,size:1024*1024});
      const buffer=Buffer.from(chunk.data,chunk.base64Encoded?'base64':'utf8');
      for(let offset=0;offset<buffer.length;) {
        const result=await file.write(buffer,offset,buffer.length-offset);
        if(result.bytesWritten<=0)throw new Error('Trace file write made no progress');
        offset+=result.bytesWritten;bytes+=result.bytesWritten;
      }
      chunks++;if(chunk.eof)break;
    }
  } catch(error) {failure=error;}
  finally {
    clearTimeout(completeTimer);if(completeHandler)cdp.off('Tracing.tracingComplete',completeHandler);
    try {await file?.close();} catch(error) {failure??=error;}
    if(stream)try {await cdp.send('IO.close',{handle:stream});} catch(error) {failure??=error;}
    traceState={...traceState,completed:!failure,bytes,chunks,rawFile:'chrome-trace.json',
      summary:'Raw trace streamed in bounded 1 MiB reads; no full-file JSON parse. GL probe is the method-attribution record.',
      ...(failure?{error:String(failure)}:{})};
    await writeFile(`${out}/trace-summary.json`,JSON.stringify(traceState,null,2));
  }
  if(failure)throw failure;
}
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  page=await browser.newPage({viewport:{width:1280,height:720}});
  await page.addInitScript(installFoundationContextProbe);
  await page.addInitScript(()=>{
    const records=[];window.__foundationWorkers=records;
    const record=value=>{if(records.length<128)records.push({atMs:performance.now(),...value});};
    window.Worker=new Proxy(window.Worker,{construct(target,args,newTarget){
      const worker=Reflect.construct(target,args,newTarget),url=String(args[0]);
      if(url.includes('near-water-worker.js')) {
        record({kind:'created',url,stack:String(new Error().stack).slice(0,5000)});
        worker.addEventListener('error',event=>record({kind:'error',url,eventClass:event.constructor.name,
          type:event.type,isTrusted:event.isTrusted,ownProperties:Object.getOwnPropertyNames(event),
          hasMessage:'message' in event,message:event.message??null,filename:event.filename??null,
          lineno:event.lineno??null,colno:event.colno??null,error:String(event.error?.stack||event.error||'')}));
        worker.addEventListener('messageerror',event=>record({kind:'messageerror',url,type:event.type}));
      }
      return worker;
    }});
  });
  page.on('worker',worker=>{
    if(workerEvents.length<128)workerEvents.push({kind:'created',url:worker.url(),at:Date.now()});
    worker.on('close',()=>{if(workerEvents.length<128)workerEvents.push({kind:'closed',url:worker.url(),at:Date.now()});});
  });
  page.context().on('requestfailed',request=>{if(networkFailures.length<128)networkFailures.push({
    url:request.url(),type:request.resourceType(),failure:request.failure()});});
  page.context().on('response',response=>{if(response.status()>=400&&networkFailures.length<128)networkFailures.push({
    url:response.url(),status:response.status(),type:response.request().resourceType()});});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{
    if(m.type()==='error')errors.push(m.text());
    if(m.type()==='warning') {
      const message=m.text();
      if(warnings.length<100)warnings.push(message);else warningDropped++;
      if(/GL_INVALID_|CONTEXT_LOST/.test(message)) {
        driverWarningCount++;if(driverWarnings.length<128)driverWarnings.push(message);
      }
    }
  });
  if(trace){cdp=await page.context().newCDPSession(page);await cdp.send('Tracing.start',{
    categories:traceCategories,
    transferMode:'ReturnAsStream'});traceStarted=true;}
  if(cloudOverrideBody)await page.route('**/src/clouds-webgl.js',route=>route.fulfill({contentType:'text/javascript',body:cloudOverrideBody}));
  if(legacyLutBody)await page.route('**/src/atmosphere-multiple-scattering.js',route=>route.fulfill({contentType:'text/javascript',body:legacyLutBody}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:120000});
  await page.evaluate(installFoundationGLProbe);
  if(historyTransitions)await page.evaluate(()=>{
    const pass=NMS._pipeline.volumePass,object=pass.resolveQuad._mesh,original=object.onBeforeRender;
    const data={phase:null,records:[],counts:{},restored:false};window.__foundationHistory=data;
    const wrapper=function(...args) {
      original.apply(this,args);
      if(!data.phase)return;
      const count=data.counts[data.phase]=(data.counts[data.phase]||0)+1;
      if(count<=8)data.records.push({phase:data.phase,valid:pass.resolveMaterial.uniforms.uHistoryValid.value,
        sequence:NMS._pipeline.frameState.sequence,historySequence:pass.historySequence,
        epoch:NMS._pipeline.frameState.epoch,reason:NMS._pipeline.frameState.reason,
        bodyMatches:NMS._pipeline.frameState.current.body===pass.activePlanet,
        timeEpoch:NMS._pipeline.frameState.current.timeEpoch});
    };
    object.onBeforeRender=wrapper;
    window.__foundationHistoryRestore=()=>{if(object.onBeforeRender===wrapper){object.onBeforeRender=original;data.restored=true;}};
  });
  if(errorsFromBoot)await page.evaluate(()=>{window.__foundationGLProbe.mark('boot-error-attribution');window.__foundationGLProbe.armErrors();});
  const checkpoint=async label=>{
    const state=await page.evaluate(label=>{
      performance.mark(`foundation-default-${label}`);window.__foundationGLProbe.mark(label);
      return {gl:NMS._renderer.getContext().getError(),lost:NMS._renderer.getContext().isContextLost(),
        near:NMS.waterState(0)?.near,stats:NMS.stats()};
    },label);checkpoints.push({label,...state});
    console.log(JSON.stringify({label,gl:state.gl,near:state.near}));
  };
  await checkpoint('boot-before-placement');
  if(parallelNearControl) {
    parallelNearResult=await page.evaluate(probeCloudProgramPrewarm);
    console.log(JSON.stringify({parallelNearResult}));
  }
  await page.evaluate(()=>{
    NMS._pipeline.startProfiling({every:1,history:2000});
    if(window.__foundationHistory)window.__foundationHistory.phase='initial';
    window.__foundationGLProbe.mark('initial-placement');performance.mark('foundation-default-placement');
    const p=NMS._planet(0);NMS.setBuildBudget(40);
    NMS.teleport(0,(p.seaLevel+40)/p.R,{dir:[.34669147556655305,.07291666666666663,-.9351407276403421],horizon:true,pitch:0});
    NMS.setLocalSunAltitude(0,32);NMS.shipViewDebug.setViewMode('chase');NMS.lookPitch(-10);
    window.__foundationLost=0;NMS._renderer.domElement.addEventListener('webglcontextlost',()=>__foundationLost++);
  });
  await page.waitForFunction(()=>{const n=NMS.waterState(0)?.near;return n?.visible&&!n.pending;},null,{timeout:120000});
  await checkpoint('initial-complete');
  if(parallelNearControl)parallelNearResult.actualNear=await page.evaluate(()=>{
    const material=NMS._planet(0).volCloudMat,program=NMS._renderer.properties.get(material).currentProgram;
    return {programId:program?.id,reused:program===window.__foundationPrewarmProgram,
      nativeHandlePresent:Boolean(program?.program),materialVersion:material.version};
  });
  const initial=await page.evaluate(()=>{NMS.setBuildBudget(0);return NMS.waterState(0);});
  await page.evaluate(()=>{
    window.__foundationGLProbe.mark('replacement');
    if(window.__foundationHistory)window.__foundationHistory.phase='replacement';
    const p=NMS._planet(0),T=NMS._THREE;
    const d=new T.Vector3(.34669147556655305,.07291666666666663,-.9351407276403421).normalize();
    d.addScaledVector(new T.Vector3().crossVectors(d,new T.Vector3(0,1,0)).normalize(),350/p.seaRadius).normalize();
    NMS.teleport(0,(p.seaLevel+40)/p.R,{dir:d.toArray(),horizon:true,pitch:0});
  });
  await page.waitForFunction(rebuilds=>{const n=NMS.waterState(0)?.near;return n?.rebuilds>rebuilds&&!n.pending;},initial.near.rebuilds,{timeout:45000});
  await checkpoint('replacement-complete');
  await page.evaluate(armed=>{
    window.__foundationGLProbe.mark(armed?'input-error-attribution':'input-passive');
    if(armed)window.__foundationGLProbe.armErrors();
  },errorsProbe&&!errorsFromBoot);
  await page.keyboard.down('KeyW');await page.waitForTimeout(8000);await page.keyboard.up('KeyW');await page.waitForTimeout(3000);
  await checkpoint('input-complete');
  if(historyTransitions) {
    for(const phase of ['time','small-teleport','resize','resize-return']) {
      await page.evaluate(phase=>{
        const data=window.__foundationHistory;
        data.phase=phase.startsWith('resize')?null:phase;
        if(phase.startsWith('resize'))window.addEventListener('resize',()=>{data.phase=phase;},{once:true});
        if(phase==='time')NMS.setTime(NMS.time().hours);
        if(phase==='small-teleport')NMS.setPosition(...NMS.pos());
      },phase);
      if(phase==='resize'||phase==='resize-return')await page.setViewportSize({width:phase==='resize'?1296:1280,height:720});
      await page.waitForFunction(phase=>window.__foundationHistory.records.some(row=>row.phase===phase&&row.valid===1),phase,{timeout:15000});
    }
    await checkpoint('history-transitions-complete');
  }
  const state=await page.evaluate(()=>({stats:NMS.stats(),water:NMS.waterState(0),
    profile:NMS._pipeline.performanceSnapshot(),probe:window.__foundationGLProbe.snapshot(),lostEvents:__foundationLost,
    workers:window.__foundationWorkers}));
  await page.screenshot({path:`${out}/player.png`,timeout:90000});
  if(ownerModes) {
    try {
      await page.evaluate(()=>{
        const p=NMS._planet(0),r=NMS._renderer,vp=NMS._pipeline.volumePass;
        if(!p.volCloudMat||!p.volCloudFarMat||!p.volCloudMesh)throw Error('Owner roundtrip needs both real cloud materials');
        const data={transitions:[],draws:[],faults:[],observedDraws:0,droppedDraws:0,
          sampleLimit:32,phase:null,restored:false};
        window.__foundationOwnerModes=data;
        const original=r.renderBufferDirect;
        const wrapper=function(...args) {
          const watched=args[4]===p.volCloudMesh&&vp.activePlanet===p&&this.getRenderTarget()===vp.current;
          const callsBefore=watched?this.info.render.calls:0;
          const result=original.apply(this,args);
          if(watched&&data.phase&&this.info.render.calls>callsBefore) {
            data.observedDraws++;
            try {
              const material=args[3],properties=this.properties.get(material),program=properties.currentProgram;
              const draw={phase:data.phase,atMs:performance.now(),frame:vp.frame,
                representation:material===p.volCloudMat?'near':material===p.volCloudFarMat?'far':'foreign',
                materialVersion:material.version,uploadedVersion:properties.__version,
                define:material.defines.PRODUCTION_CLOUD_MEDIUM,localBands:material.uniforms.uLocalBands.value,
                shared:p.volCloudMat.uniforms===p.volCloudFarMat.uniforms,
                programId:program?.id??null,programPresent:!!program?.program,
                cacheReady:p.volCloudMat.uniforms.uSunCacheReady.value,
                weatherReady:!!p.weatherStream?.ready,bankMatchesField:p.cloudLightBank?.fieldOwner===p.weatherField,
                drawCalls:this.info.render.calls-callsBefore};
              // Keep the first actual draw of each program/version/readiness
              // state. A slow cache cannot grow the diagnostic without bound.
              const duplicate=data.draws.some(old=>old.phase===draw.phase&&old.programId===draw.programId
                &&old.materialVersion===draw.materialVersion&&old.cacheReady===draw.cacheReady
                &&old.weatherReady===draw.weatherReady&&old.bankMatchesField===draw.bankMatchesField);
              if(!duplicate) {
                if(data.draws.length<data.sampleLimit)data.draws.push(draw);else data.droppedDraws++;
              }
            } catch(error) {if(data.faults.length<8)data.faults.push(String(error));}
          }
          return result;
        };
        r.renderBufferDirect=wrapper;
        window.__foundationOwnerRestore=()=>{
          if(r.renderBufferDirect===wrapper) {r.renderBufferDirect=original;data.restored=true;}
        };
        window.__foundationOwnerTransition=(fixture,expected,phase)=>{
          const previous={near:p.volCloudMat.version,far:p.volCloudFarMat.version};
          window.__foundationGLProbe.mark(`owner-${phase}`);
          p.setWeatherFixture(fixture);
          const transition={fixture,expected,phase,atMs:performance.now(),frame:vp.frame,
            previous,nearVersion:p.volCloudMat.version,farVersion:p.volCloudFarMat.version,
            nearDefine:p.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM,
            farDefine:p.volCloudFarMat.defines.PRODUCTION_CLOUD_MEDIUM,
            localBands:p.volCloudMat.uniforms.uLocalBands.value,
            shared:p.volCloudMat.uniforms===p.volCloudFarMat.uniforms};
          transition.synchronized=transition.nearDefine===expected&&transition.farDefine===expected
            &&transition.localBands===expected&&transition.shared
            &&transition.nearVersion>previous.near&&transition.farVersion>previous.far;
          data.transitions.push(transition);data.phase=phase;
          if(!transition.synchronized)throw Error(`Cloud owner transition is not atomic: ${phase}`);
          return transition;
        };
        window.__foundationOwnerTransition('clear',0,'legacy');
      });
      await page.waitForFunction(()=>{
        const p=NMS._planet(0),vp=NMS._pipeline.volumePass,data=window.__foundationOwnerModes;
        const transition=data.transitions.find(item=>item.phase==='legacy');
        return vp.activePlanet===p&&data.draws.some(draw=>draw.phase==='legacy'
          &&draw.materialVersion===transition.nearVersion&&draw.uploadedVersion===draw.materialVersion
          &&draw.representation==='near'&&draw.define===0&&draw.localBands===0&&draw.shared
          &&Number.isInteger(draw.programId)&&draw.programPresent&&draw.drawCalls>0);
      },null,{timeout:45000});
      await checkpoint('owner-legacy-complete');
      await page.evaluate(()=>window.__foundationOwnerTransition(null,1,'production'));
      await page.waitForFunction(()=>{
        const p=NMS._planet(0),vp=NMS._pipeline.volumePass,data=window.__foundationOwnerModes;
        const transition=data.transitions.find(item=>item.phase==='production');
        return vp.activePlanet===p&&data.draws.some(draw=>draw.phase==='production'
          &&draw.materialVersion===transition.nearVersion&&draw.uploadedVersion===draw.materialVersion
          &&draw.representation==='near'&&draw.define===1&&draw.localBands===1&&draw.shared
          &&Number.isInteger(draw.programId)&&draw.programPresent&&draw.drawCalls>0
          &&draw.cacheReady===1&&draw.weatherReady&&draw.bankMatchesField);
      },null,{timeout:180000});
      await checkpoint('owner-production-complete');
    } finally {
      ownerModesResult=await page.evaluate(()=>{
        window.__foundationOwnerRestore?.();
        delete window.__foundationOwnerTransition;delete window.__foundationOwnerRestore;
        return window.__foundationOwnerModes??null;
      });
    }
  }
  // Capture once more after screenshot-driven frames and profiler teardown.
  // An armed probe can consume a late GL error; the earlier player snapshot
  // must not be the final error record. No RAF can run inside this transaction.
  const finalState=await page.evaluate(()=>{
    window.__foundationGLProbe.mark('final-capture-after-screenshot');
    NMS._pipeline.stopProfiling();
    const gl=NMS._renderer.getContext();
    const final={gl:gl.getError(),lost:gl.isContextLost(),lostEvents:__foundationLost,
      workers:window.__foundationWorkers,probe:window.__foundationGLProbe.snapshot()};
    window.__foundationHistoryRestore?.();final.history=window.__foundationHistory??null;
    final.mainContextId=window.__foundationContextProbe.idForCanvas(NMS._renderer.domElement);
    window.__foundationContextProbe.dispose();
    final.contexts=window.__foundationContextProbe.snapshot();
    window.__foundationGLProbe.dispose();return final;
  });
  const after=await evidenceFingerprint('tools/foundationdefaultdiag.js'),helperAfter=await evidenceFingerprint('tools/foundation-gl-probe.js');
  const contextHelperAfter=await evidenceFingerprint('tools/foundation-context-probe.js');
  const warmHelperAfter=await evidenceFingerprint('tools/cloud-program-prewarm-browser.js');
  report={...before,helperBefore,helperAfter,contextHelperBefore,contextHelperAfter,warmHelperBefore,warmHelperAfter,parallelNearControl,parallelNearResult,trace,errorsProbe,errorsFromBoot,ownerModes,ownerModesResult,historyTransitions,viewLoopControl,cloudOverride,checkpoints,state,finalState,errors,warnings,
    warningDropped,driverWarningCount,driverWarnings,workerEvents,networkFailures,
    stableSource:before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest&&helperBefore.verifierDigest===helperAfter.verifierDigest&&contextHelperBefore.verifierDigest===contextHelperAfter.verifierDigest&&warmHelperBefore.verifierDigest===warmHelperAfter.verifierDigest,
    boundary:'Default 720p Balanced clouds, HUD/post, no far flora. Passive GL timing is diagnostic, not FPS acceptance. --errors adds per-call synchronization after replacement; --errors-from-boot starts it at probe installation. Optional --owner-modes adds real clear/production fixture draws after the player snapshot; its 45/180 s gates do not change the original 120/45 s worker gates. First errors and driver warnings remain failures even if later checkpoints are clean.'};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));await finishTrace();
  console.log(JSON.stringify({out,stableSource:report.stableSource,viewLoopControl,cloudOverride,traceState,
    errors,warnings: warnings.length,warningDropped,driverWarningCount,maxFrame:state.stats.maximumFrameMs,
    finalGl:finalState.gl,finalLost:finalState.lost,mainContextId:finalState.mainContextId,
    earlyContexts:finalState.contexts.contexts.length,earlyContextEvents:finalState.contexts.events.length,
    probe:{mode:finalState.probe.mode,firstError:finalState.probe.firstError,errorArms:finalState.probe.errorArms,
      slowCalls:finalState.probe.slowCalls.length,shaders:finalState.probe.shaders.length,programs:finalState.probe.programs.length,
      dropped:finalState.probe.dropped,faults:finalState.probe.faults}}));
  assert.ok(report.stableSource);assert.deepEqual(errors,[]);assert.ok(checkpoints.every(p=>p.gl===0&&!p.lost));assert.equal(state.lostEvents,0);
  assert.equal(warmHelperBefore.verifierDigest,warmHelperAfter.verifierDigest);
  if(parallelNearControl)assert.equal(parallelNearResult.actualNear.reused,true,'Actual near draw must reuse the prepared program');
  assert.equal(finalState.gl,0,'Post-screenshot/teardown GL error must remain a failure');
  assert.equal(finalState.lost,false);assert.equal(finalState.lostEvents,0);
  assert.ok(finalState.contexts.installed&&finalState.contexts.disposed&&finalState.contexts.wrapperRestored);
  assert.deepEqual(finalState.contexts.faults,[]);
  assert.equal(finalState.contexts.dropped.contexts,0);
  assert.equal(finalState.contexts.dropped.events,0);
  assert.ok(Number.isInteger(finalState.mainContextId),'Early observer must identify the actual main canvas');
  assert.equal(finalState.contexts.contexts.find(row=>row.contextId===finalState.mainContextId)?.lostEvents,0);
  assert.equal(finalState.probe.firstError,null,'Intrusive trace errors must not be erased by checkpoints or screenshot frames');
  assert.ok(finalState.probe.errorArms.every(arm=>arm.preexisting===0));assert.deepEqual(finalState.probe.faults,[]);
  assert.deepEqual(finalState.probe.lifetimeFaults,[],'Deleted programs must not be queried');
  assert.ok(checkpoints.slice(1).every(p=>p.near?.worker&&!p.near.workerError),'Cloud/near-water integration must retain its actual worker');
  assert.ok(finalState.workers.every(event=>event.kind!=='error'&&event.kind!=='messageerror'));
  assert.equal(driverWarningCount,0,'Driver GL warnings must not be hidden by a clean final getError');
  if(historyTransitions) {
    assert.ok(finalState.history.restored);
    assert.ok(finalState.history.records.every(row=>row.bodyMatches));
    for(const phase of ['initial','replacement','time','small-teleport','resize','resize-return']) {
      const rows=finalState.history.records.filter(row=>row.phase===phase);
      assert.equal(rows[0]?.valid,0,`First actual ${phase} resolve must reject stale history`);
      assert.ok(rows.some(row=>row.valid===1),`${phase} must recover history on a subsequent player frame`);
    }
  }
  if(ownerModes) {
    assert.ok(ownerModesResult?.restored,'Owner draw observer must restore renderBufferDirect');
    assert.deepEqual(ownerModesResult.faults,[]);assert.equal(ownerModesResult.droppedDraws,0);
    assert.equal(ownerModesResult.transitions.length,2);
    assert.deepEqual(ownerModesResult.transitions.map(item=>item.expected),[0,1]);
    assert.ok(ownerModesResult.transitions.every(item=>item.synchronized));
    for(const transition of ownerModesResult.transitions)assert.ok(ownerModesResult.draws.some(draw=>
      draw.phase===transition.phase&&draw.representation==='near'&&draw.define===transition.expected
      &&draw.localBands===transition.expected&&draw.shared&&draw.programPresent&&Number.isInteger(draw.programId)
      &&draw.materialVersion===transition.nearVersion&&draw.uploadedVersion===draw.materialVersion&&draw.drawCalls>0
      &&(transition.expected===0||draw.cacheReady===1&&draw.weatherReady&&draw.bankMatchesField)));
  }
} catch(error) {
  const state=await page?.evaluate(()=>({stats:window.NMS?.stats?.(),water:window.NMS?.waterState?.(0),
    profile:window.NMS?._pipeline?.performanceSnapshot(),probe:window.__foundationGLProbe?.snapshot(),workers:window.__foundationWorkers,
    ownerModes:window.__foundationOwnerModes,history:window.__foundationHistory,parallelPreparation:window.__foundationCloudPrewarm,contexts:window.__foundationContextProbe?.snapshot(),
    mainContextId:window.__foundationContextProbe?.idForCanvas(window.NMS?._renderer?.domElement)})).catch(captureError=>({captureError:String(captureError)}));
  await page?.screenshot({path:`${out}/failure-player.png`,timeout:30000}).catch(()=>{});
  await writeFile(`${out}/failure.json`,JSON.stringify({...before,helperBefore,contextHelperBefore,warmHelperBefore,parallelNearControl,parallelNearResult,ownerModes,ownerModesResult,viewLoopControl,cloudOverride,traceState,checkpoints,state,errors,warnings,
    warningDropped,driverWarningCount,driverWarnings,workerEvents,networkFailures,error:String(error)},null,2));
  await finishTrace();console.error(JSON.stringify({out,error:String(error)}));throw error;
} finally {
  try {await browser?.close();}
  finally {await new Promise(resolve=>server.close(resolve));}
}
