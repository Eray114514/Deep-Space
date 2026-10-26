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
import {installFoundationBootProbe} from './foundation-boot-probe.js';
import {probeCloudProgramPrewarm} from './cloud-program-prewarm-browser.js';

const trace=process.argv.includes('--trace'),errorsProbe=process.argv.includes('--errors');
const errorsFromBoot=process.argv.includes('--errors-from-boot');
const ownerModes=process.argv.includes('--owner-modes');
const historySweep=process.argv.includes('--history-sweep');
const historyTransitions=process.argv.includes('--history-transitions')||historySweep;
const receiverStartup=process.argv.includes('--receiver-startup');
const probeFromNavigation=process.argv.includes('--probe-from-navigation');
const columnWork=process.argv.includes('--column-work');
const columnDaySide=process.argv.includes('--column-day-side');
const columnOrbitProfile=process.argv.includes('--column-orbit-profile');
const columnFrameGate=process.argv.includes('--column-frame-gate');
const framePacing=process.argv.includes('--frame-pacing');
const observeAfterBootTimeout=process.argv.includes('--observe-after-boot-timeout');
const pauseControl=process.argv.includes('--pause-control');
const cloudIdleControl=process.argv.includes('--cloud-idle-control');
const cloudFlushControl=process.argv.includes('--cloud-flush-control');
const cloudPrograms=process.argv.includes('--cloud-programs');
assert.ok((!cloudIdleControl&&!cloudFlushControl)||cloudPrograms,'Cloud submission controls require explicit experimental programs');
assert.ok(!pauseControl||framePacing,'Pause control requires explicit frame pacing');
assert.ok(!framePacing||!columnFrameGate,'Isolate runtime pacing from the diagnostic frame wrapper');
const orbitArgument=process.argv.slice(2).find(arg=>arg.startsWith('--column-orbit-ms='));
const columnOrbitMs=orbitArgument?Number(orbitArgument.slice('--column-orbit-ms='.length)):30000;
assert.ok(Number.isInteger(columnOrbitMs)&&columnOrbitMs>=30000&&columnOrbitMs<=120000,'Column orbit window must be 30000..120000 ms');
assert.ok(columnWork||!columnDaySide&&!orbitArgument&&!columnOrbitProfile&&!columnFrameGate,'Column orbit controls require explicit column work');
const parallelNearControl=process.argv.includes('--parallel-near-control');
const viewLoopControl=process.argv.includes('--view-loop-control');
const beamLoopControl=process.argv.includes('--beam-loop-control');
const extinctionCallControl=process.argv.includes('--extinction-call-control');
const legacyColdControl=process.argv.includes('--legacy-cold-control');
assert.ok([viewLoopControl,beamLoopControl,extinctionCallControl,legacyColdControl,parallelNearControl].filter(Boolean).length<=1,'Isolate one program control per experiment');
assert.ok(!columnWork||![viewLoopControl,beamLoopControl,extinctionCallControl,legacyColdControl,parallelNearControl,ownerModes].some(Boolean),'Isolate admitted columns from other experimental routes');
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
await writeFile(`${out}/verifier.js`,await readFile('tools/foundationdefaultdiag.js'));
const before=await evidenceFingerprint('tools/foundationdefaultdiag.js');
const admissionHelperBefore=columnWork?await evidenceFingerprint('tools/column-admission-probe.js'):null;
if(columnWork)await writeFile(`${out}/column-admission-probe.js`,await readFile('tools/column-admission-probe.js'));
const frameGateHelperBefore=columnFrameGate?await evidenceFingerprint('tools/column-frame-gate.js'):null;
if(columnFrameGate)await writeFile(`${out}/column-frame-gate.js`,await readFile('tools/column-frame-gate.js'));
const helperBefore=await evidenceFingerprint('tools/foundation-gl-probe.js');
const bootHelperBefore=await evidenceFingerprint('tools/foundation-boot-probe.js');
const contextHelperBefore=await evidenceFingerprint('tools/foundation-context-probe.js');
const warmHelperBefore=await evidenceFingerprint('tools/cloud-program-prewarm-browser.js');
const {server,port}=await startServer(0);
let browser;
const errors=[],warnings=[],driverWarnings=[],checkpoints=[],workerEvents=[],networkFailures=[];
const nativeLogs=[];let nativeLogsDropped=0,browserInfo=null;
let warningDropped=0,driverWarningCount=0,page,cdp,traceStarted=false,report,ownerModesResult=null;
let parallelNearResult=null;
let bootDeadline=null;
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
  const logSession=await page.context().newCDPSession(page);
  logSession.on('Log.entryAdded',({entry})=>{
    if(entry.source!=='rendering')return;
    if(nativeLogs.length<256)nativeLogs.push({receivedAtEpochMs:Date.now(),entry});else nativeLogsDropped++;
  });
  await logSession.send('Log.enable');
  const browserSession=await browser.newBrowserCDPSession();
  browserInfo={version:await browserSession.send('Browser.getVersion'),
    system:await browserSession.send('SystemInfo.getInfo').catch(error=>({error:String(error)}))};
  await browserSession.detach();
  await page.addInitScript(installFoundationContextProbe);
  if(cloudFlushControl)await page.addInitScript(()=>{
    const get=HTMLCanvasElement.prototype.getContext,seen=new WeakSet();
    HTMLCanvasElement.prototype.getContext=function(...args){
      const gl=get.apply(this,args);
      if(gl&&args[0]==='webgl2'&&!seen.has(gl)){
        seen.add(gl);const link=gl.linkProgram;
        gl.linkProgram=function(...values){const result=link.apply(this,values);gl.flush();return result;};
      }return gl;
    };
  });
  if(cloudIdleControl)await page.addInitScript(()=>{
    // Diagnostic scheduling control, never a quality or shader override.
    // Preserve RAF handles/cancellation while limiting only the main loop
    // when its cloud gate cannot submit a world frame.
    const request=window.requestAnimationFrame.bind(window),cancel=window.cancelAnimationFrame.bind(window),pending=new Map();
    window.requestAnimationFrame=callback=>{
      const id=request(time=>{
        const row=pending.get(id);if(!row)return;
        if(callback.name==='frame'&&window.NMS?._pipeline.cloudPrograms?.snapshot().blocked) {
          row.timer=setTimeout(()=>{pending.delete(id);callback(performance.now());},20);
        }else{pending.delete(id);callback(time);}
      });pending.set(id,{timer:null});return id;
    };
    window.cancelAnimationFrame=id=>{const row=pending.get(id);if(row?.timer!==null)clearTimeout(row?.timer);pending.delete(id);cancel(id);};
  });
  if(probeFromNavigation)await page.addInitScript(`(${installFoundationBootProbe})(${installFoundationGLProbe})`);
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
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1${cloudPrograms?'&cloudprograms=1':''}`);
  try {
    await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:120000});
    bootDeadline={limitMs:120000,passed:true,readyAtEpochMs:Date.now()};
  } catch(error) {
    bootDeadline={limitMs:120000,passed:false,error:String(error),failedAtEpochMs:Date.now()};
    if(!observeAfterBootTimeout)throw error;
    console.log(JSON.stringify({bootDeadline,observationOnly:'Continue another bounded window; original boot failure remains an exit failure.'}));
    await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:120000});
    bootDeadline.observedReadyAtEpochMs=Date.now();
  }
  if(probeFromNavigation)await page.evaluate(()=>{
    if(!window.__foundationBootProbe?.installed)throw Error('Navigation-time GL probe failed');
    if(window.__foundationContextProbe.idForCanvas(NMS._renderer.domElement)!==1)
      throw Error('Navigation-time probe must observe the game context');
    window.__foundationGLProbe.attachPipeline();
  });else await page.evaluate(installFoundationGLProbe);
  if(receiverStartup)await page.evaluate(async()=>{
    const {surfaceCloudOwner}=await import('/src/cloud/surface-clouds.js');
    const pass=NMS._pipeline.cloudSurfaceShadow,original=pass.render;
    const data=window.__foundationReceiverStartup={records:[],restored:false};
    const summary=body=>body?{id:body.id??body.name,streamReady:!!body.weatherStream?.ready,
      hasBands:!!body.cloudSpeciesTex,hasVolume:!!body.volCloudMat,
      bandsReady:body.volCloudMat?.uniforms.uBandsReady?.value,
      visual:body.cloudVisualEnabled!==false}:null;
    const wrapper=function(...args){
      if(data.records.length>=16)return original.apply(this,args);
      const materials=new Set();this.scene.traverseVisible(object=>{
        for(const material of [object.material].flat())if(material)materials.add(material);
      });
      const row={atMs:performance.now(),active:summary(args[2]),
        discovered:[...materials].filter(m=>surfaceCloudOwner(m)).map(m=>summary(surfaceCloudOwner(m))),
        surfaceVariants:[...materials].filter(m=>m.customProgramCacheKey?.().match(/terrain-layered|water-regional/))
          .map(m=>({type:m.type,compiled:!!m.userData.shader,owner:!!surfaceCloudOwner(m),screen:m.defines?.SURFACE_CLOUD_SCREEN}))};
      data.records.push(row);
      try{return original.apply(this,args);}
      finally{row.ready=this.ready;row.receivers=[...this.receiverIds.keys()].map(summary);row.wallMs=performance.now()-row.atMs;}
    };
    pass.render=wrapper;window.__foundationReceiverStartupRestore=()=>{
      if(pass.render===wrapper){pass.render=original;data.restored=true;}
    };
  });
  if(historyTransitions)await page.evaluate(()=>{
    const pass=NMS._pipeline.volumePass,object=pass.resolveQuad._mesh,original=object.onBeforeRender;
    const data={phase:null,records:[],counts:{},restored:false};window.__foundationHistory=data;
    const wrapper=function(...args) {
      original.apply(this,args);
      if(!data.phase)return;
      const count=data.counts[data.phase]=(data.counts[data.phase]||0)+1;
      if(count<=8)data.records.push({phase:data.phase,valid:pass.resolveMaterial.uniforms.uHistoryValid.value,
        depthReady:pass.resolveMaterial.uniforms.uDepthReady?.value,
        stationary:pass.resolveMaterial.uniforms.uStationaryHistory?.value,motion:pass.motion,
        sequence:NMS._pipeline.frameState.sequence,historySequence:pass.historySequence,
        epoch:NMS._pipeline.frameState.epoch,reason:NMS._pipeline.frameState.reason,
        bodyMatches:NMS._pipeline.frameState.current.body===pass.activePlanet,
        timeEpoch:NMS._pipeline.frameState.current.timeEpoch});
    };
    object.onBeforeRender=wrapper;
    window.__foundationHistoryRestore=()=>{if(object.onBeforeRender===wrapper){object.onBeforeRender=original;data.restored=true;}};
  });
  if(errorsFromBoot)await page.evaluate(()=>{window.__foundationGLProbe.mark('boot-error-attribution');window.__foundationGLProbe.armErrors();});
  if(columnWork)await page.evaluate(async()=>{
    const {installColumnAdmissionProbe}=await import('/tools/column-admission-probe.js');
    const pipeline=NMS._pipeline,pass=pipeline.volumePass,original=pass.updateCloudColumns;
    const data=window.__foundationColumnWork={records:[],dropped:0,restored:false,phase:'boot'};
    pipeline.startColumnWork({budgetMs:6,maxUnits:12,maxPending:2,maxInFlightMs:12,sampleEvery:8});
    const admission=installColumnAdmissionProbe(pipeline.columnWorkBudget);
    const wrapper=function(...args) {
      const result=original.apply(this,args),budget=pipeline.columnWorkBudget;
      if(data.records.length<4096) {
        const {records,...status}=budget.snapshot(),p=this.activePlanet,bank=this.columnMaps.get(p);
        data.records.push({atMs:performance.now(),phase:data.phase,hours:p?.weatherHours,anchor:p?.weatherStream?.anchor,
          body:p?{seed:p.seed,radius:p.R,type:p.type,frameHours:p.weatherStream?.frameHours,
            stellarDirections:typeof p.stellarDirectionsAt==='function'}:null,
          ready:p?.volCloudMat?.uniforms.uColumnsReady.value,cacheOnly:p?.volCloudFarMat?.defines.CLOUD_FAR_CACHE,
          budget:status,plan:bank?.plan()||null});
      } else data.dropped++;
      return result;
    };
    pass.updateCloudColumns=wrapper;window.__foundationColumnWorkRestore=()=>{
      if(pass.updateCloudColumns===wrapper){pass.updateCloudColumns=original;data.restored=true;}
      admission.restore();data.admission=admission.snapshot();
    };
  });
  if(framePacing)await page.evaluate(()=>{
    NMS._pipeline.startFramePacing();
    window.__foundationFramePacingStart={atMs:performance.now(),pacer:NMS._pipeline.framePacer.snapshot()};
  });
  const checkpoint=async label=>{
    const state=await page.evaluate(label=>{
      performance.mark(`foundation-default-${label}`);window.__foundationGLProbe.mark(label);
      return {gl:NMS._renderer.getContext().getError(),lost:NMS._renderer.getContext().isContextLost(),
        near:NMS.waterState(0)?.near,stats:NMS.stats(),atEpochMs:performance.timeOrigin+performance.now(),
        retirement:NMS._renderer.programRetirement?.snapshot()};
    },label);checkpoints.push({label,...state});
    console.log(JSON.stringify({label,gl:state.gl,near:state.near}));
  };
  await checkpoint('boot-before-placement');
  if(columnWork) {
    if(columnOrbitProfile)await page.evaluate(()=>NMS._pipeline.startProfiling({every:8,history:2000}));
    if(columnFrameGate)await page.evaluate(async()=>{
      const {installColumnFrameGate}=await import('/tools/column-frame-gate.js');
      window.__foundationColumnFrameGate=installColumnFrameGate(NMS._pipeline);
    });
    await page.evaluate(columnDaySide=>{
      window.__foundationColumnWork.phase='orbit';
      const p=NMS._planet(0),star=p.stellarDirectionsAt(p.weatherHours).slice().sort((a,b)=>b.irradianceFraction-a.irradianceFraction)[0];
      const direction=columnDaySide?star.direction:[.34669147556655305,.07291666666666663,-.9351407276403421];
      window.__foundationColumnWork.orbitCamera={daySide:columnDaySide,hours:p.weatherHours,direction,primaryStar:star};
      NMS.teleport(0,(p.volCloudBand.rOut-p.R+3000000)/p.R,{dir:direction,horizon:false});
      NMS.resetPerformanceStats();
      window.__foundationColumnWork.orbitStart={atMs:performance.now(),sequence:NMS._pipeline.frameState.sequence,
        pacer:NMS._pipeline.framePacer?.snapshot()||null};
    },columnDaySide);
    await page.waitForTimeout(columnOrbitMs);
    await page.evaluate(()=>{
      const data=window.__foundationColumnWork;
      data.orbitEnd={atMs:performance.now(),sequence:NMS._pipeline.frameState.sequence,
        pacer:NMS._pipeline.framePacer?.snapshot()||null,stats:NMS.stats()};
      data.orbitProfile=NMS._pipeline.performanceSnapshot();
    });
    await checkpoint('column-orbit-complete');
    await page.screenshot({path:`${out}/column-orbit.png`,timeout:90000});
    await page.evaluate(()=>{
      const data=window.__foundationColumnWork;
      const gate=window.__foundationColumnFrameGate;
      if(gate){gate.restore();data.frameGate=gate.snapshot();delete window.__foundationColumnFrameGate;}
      data.phase='near';
    });
  }
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
  // A worker completing during a cold draw is not evidence that the temporal
  // consumer has seen a subsequent settled frame. Keep the same phase until
  // the existing recovery assertion can actually be observed, before teleport.
  if(historyTransitions)await page.waitForFunction(()=>window.__foundationHistory?.records.some(
    row=>row.phase==='initial'&&row.valid===1),null,{timeout:45000});
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
  if(historyTransitions)await page.waitForFunction(()=>window.__foundationHistory?.records.some(
    row=>row.phase==='replacement'&&row.valid===1),null,{timeout:45000});
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
  if(historySweep) {
    // Controlled orientation changes on consecutive real player renders. This
    // is a debug-camera integration check, not physical mouse-input acceptance
    // or proof of cloud advection / full TAA. Keep the original worker gates.
    await page.screenshot({path:`${out}/sweep-00.png`,timeout:90000});
    for(let step=0;step<32;step++) {
      const phase=`sweep-${step}`;
      await page.evaluate(({phase,degrees})=>{
        const data=window.__foundationHistory;data.phase=phase;
        NMS.lookYaw(degrees);
      },{phase,degrees:step<16?1.5:-1.5});
      await page.waitForFunction(phase=>window.__foundationHistory.records.some(row=>row.phase===phase),phase,{timeout:15000});
      if((step+1)%8===0)await page.screenshot({path:`${out}/sweep-${String(step+1).padStart(2,'0')}.png`,timeout:90000});
    }
    await checkpoint('history-sweep-complete');
  }
  const state=await page.evaluate(()=>({stats:NMS.stats(),water:NMS.waterState(0),
    profile:NMS._pipeline.performanceSnapshot(),probe:window.__foundationGLProbe.snapshot(),lostEvents:__foundationLost,
    workers:window.__foundationWorkers}));
  await page.screenshot({path:`${out}/player.png`,timeout:90000});
  if(pauseControl) {
    // A controlled caller rejection exercises the actual main loop and pause
    // UI. Native GPU busy proof remains the separate pipeline GPU fixture.
    await page.evaluate(async()=>{
      const {PresentedFrameStats}=await import('/src/presented-frame-stats.js');
      const pipeline=NMS._pipeline,prototype=PresentedFrameStats.prototype;
      const submitFrame=pipeline.submitFrame,present=prototype.present,setPaused=prototype.setPaused;
      const data=window.__foundationPauseControl={kind:'Controlled submitFrame(false) caller integration; not native fence/performance evidence',
        edges:[],rejected:0,restored:false,phase:'reject'};
      NMS.resetPerformanceStats();
      const rejected=function(){data.rejected++;return false;};pipeline.submitFrame=rejected;
      const edge=function(value,at){const result=setPaused.call(this,value,at);data.edges.push({paused:value,at});return result;};
      const sample=function(...args){
        const result=present.apply(this,args);
        if(data.phase==='released'&&result&&!data.first) {
          data.first={...result,stats:this.snapshot(),devFpsBeforeUpdate:document.getElementById('dev-fps')?.textContent};
          queueMicrotask(()=>{data.first.devFpsAfterUpdate=document.getElementById('dev-fps')?.textContent;});
        }
        return result;
      };
      prototype.setPaused=edge;prototype.present=sample;
      window.__foundationPauseRelease=()=>{
        if(pipeline.submitFrame!==rejected)throw Error('Pause submission wrapper ownership changed');
        pipeline.submitFrame=submitFrame;data.phase='released';
      };
      window.__foundationPauseRestore=()=>{
        if(pipeline.submitFrame===rejected)pipeline.submitFrame=submitFrame;
        if(prototype.present!==sample||prototype.setPaused!==edge)throw Error('Pause statistics wrapper ownership changed');
        prototype.present=present;prototype.setPaused=setPaused;data.restored=true;
      };
    });
    try {
      await page.keyboard.press('Escape');await page.waitForFunction(()=>NMS.stats().paused);
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape');await page.waitForFunction(()=>!NMS.stats().paused);
      await page.waitForTimeout(100);
      await page.evaluate(()=>{window.__foundationPauseControl.beforeRelease=NMS.stats();window.__foundationPauseRelease();});
      await page.waitForFunction(()=>window.__foundationPauseControl.first,{},{timeout:15000});
    } finally {await page.evaluate(()=>window.__foundationPauseRestore());}
    await checkpoint('pause-control-complete');
  }
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
      workers:window.__foundationWorkers,probe:window.__foundationGLProbe.snapshot(),
      retirement:NMS._renderer.programRetirement?.snapshot()};
    if(window.__foundationColumnWork) {
      window.__foundationColumnWorkRestore();final.columnWork=window.__foundationColumnWork;
      final.columnWork.finalBudget=NMS._pipeline.columnWorkBudget.snapshot();NMS._pipeline.stopColumnWork();
    }
    if(NMS._pipeline.framePacer) {
      const pacer=NMS._pipeline.framePacer;
      final.framePacing={start:window.__foundationFramePacingStart,beforeStop:pacer.snapshot(),stats:NMS.stats()};
      NMS._pipeline.stopFramePacing();window.__foundationRetiredFramePacer=pacer;
      final.framePacing.afterStop=pacer.snapshot();
    }
    final.bootProbe=window.__foundationBootProbe??null;
    final.pauseControl=window.__foundationPauseControl??null;
    window.__foundationHistoryRestore?.();final.history=window.__foundationHistory??null;
    window.__foundationReceiverStartupRestore?.();final.receiverStartup=window.__foundationReceiverStartup??null;
    final.mainContextId=window.__foundationContextProbe.idForCanvas(NMS._renderer.domElement);
    window.__foundationContextProbe.dispose();
    final.contexts=window.__foundationContextProbe.snapshot();
    window.__foundationGLProbe.dispose();return final;
  });
  if(framePacing) {
    await page.waitForFunction(()=>window.__foundationRetiredFramePacer?.snapshot().released,{},{timeout:15000});
    finalState.framePacing.retired=await page.evaluate(()=>({pacer:window.__foundationRetiredFramePacer.snapshot(),
      gl:NMS._renderer.getContext().getError(),lost:NMS._renderer.getContext().isContextLost(),enabled:!!NMS._pipeline.framePacer}));
  }
  const after=await evidenceFingerprint('tools/foundationdefaultdiag.js'),helperAfter=await evidenceFingerprint('tools/foundation-gl-probe.js');
  const contextHelperAfter=await evidenceFingerprint('tools/foundation-context-probe.js');
  const warmHelperAfter=await evidenceFingerprint('tools/cloud-program-prewarm-browser.js');
  const bootHelperAfter=await evidenceFingerprint('tools/foundation-boot-probe.js');
  const admissionHelperAfter=columnWork?await evidenceFingerprint('tools/column-admission-probe.js'):null;
  const frameGateHelperAfter=columnFrameGate?await evidenceFingerprint('tools/column-frame-gate.js'):null;
  report={...before,helperBefore,helperAfter,contextHelperBefore,contextHelperAfter,warmHelperBefore,warmHelperAfter,cloudPrograms,cloudIdleControl,cloudFlushControl,parallelNearControl,parallelNearResult,trace,errorsProbe,errorsFromBoot,ownerModes,ownerModesResult,historyTransitions,viewLoopControl,cloudOverride,checkpoints,state,finalState,errors,warnings,
    warningDropped,driverWarningCount,driverWarnings,workerEvents,networkFailures,historySweep,receiverStartup,nativeLogs,nativeLogsDropped,browserInfo,
    probeFromNavigation,columnWork,columnDaySide,columnOrbitMs,columnOrbitProfile,columnFrameGate,framePacing,observeAfterBootTimeout,pauseControl,bootDeadline,frameGateHelperBefore,frameGateHelperAfter,admissionHelperBefore,admissionHelperAfter,bootHelperBefore,bootHelperAfter,
    stableSource:before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest&&helperBefore.verifierDigest===helperAfter.verifierDigest&&contextHelperBefore.verifierDigest===contextHelperAfter.verifierDigest&&warmHelperBefore.verifierDigest===warmHelperAfter.verifierDigest&&bootHelperBefore.verifierDigest===bootHelperAfter.verifierDigest&&admissionHelperBefore?.verifierDigest===admissionHelperAfter?.verifierDigest&&frameGateHelperBefore?.verifierDigest===frameGateHelperAfter?.verifierDigest,
    boundary:`${columnWork?'Explicit raw3/cache2 column admission plus an additional orbit interval; not default runtime acceptance.':'Default'} 720p Balanced clouds, HUD/post, no far flora. Passive GL timing is diagnostic, not FPS acceptance. --errors adds per-call synchronization after replacement; --errors-from-boot starts it at probe installation. Optional --owner-modes adds real clear/production fixture draws after the player snapshot; its 45/180 s gates do not change the original 120/45 s worker gates. First errors and driver warnings remain failures even if later checkpoints are clean.`};
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
  assert.equal(bootHelperBefore.verifierDigest,bootHelperAfter.verifierDigest);
  if(parallelNearControl)assert.equal(parallelNearResult.actualNear.reused,true,'Actual near draw must reuse the prepared program');
  assert.equal(finalState.gl,0,'Post-screenshot/teardown GL error must remain a failure');
  assert.equal(finalState.lost,false);assert.equal(finalState.lostEvents,0);
  if(framePacing) {
    const paced=finalState.framePacing;
    assert.equal(paced.beforeStop.fault,null);assert.ok(paced.beforeStop.pending<=1);
    assert.ok(paced.beforeStop.stats.submitted>0&&paced.beforeStop.stats.skipped>0);
    assert.equal(paced.beforeStop.stats.begun,paced.beforeStop.stats.submitted);
    assert.equal(paced.retired.pacer.released,true);assert.equal(paced.retired.pacer.pending,0);
    assert.equal(paced.retired.pacer.fault,null);assert.equal(paced.retired.enabled,false);
    assert.equal(paced.retired.gl,0);assert.equal(paced.retired.lost,false);
  }
  if(pauseControl) {
    const control=finalState.pauseControl;
    assert.ok(control.restored&&control.rejected>0);assert.equal(control.beforeRelease.performanceFrames,0);
    assert.deepEqual(control.edges.map(edge=>edge.paused),[true,false]);
    const pausedMs=control.edges[1].at-control.edges[0].at;
    assert.ok(pausedMs>=2000&&control.first.recorded);
    assert.ok(Math.abs(control.first.elapsedMs-control.first.activeMs-pausedMs)<.001,'Active time excludes exact UI pause edges');
    assert.equal(control.first.stats.performanceFrames,1);
    assert.equal(control.first.stats.maximumFrameMs,Math.round(control.first.activeMs*100)/100);
  }
  if(columnWork) {
    if(columnFrameGate) {
      assert.ok(finalState.columnWork.frameGate.restored);assert.equal(finalState.columnWork.frameGate.fault,null);
      assert.equal(finalState.columnWork.frameGate.pending,0);assert.equal(finalState.columnWork.frameGate.peakPending,1);
      assert.ok(finalState.columnWork.frameGate.rendered>0&&finalState.columnWork.frameGate.skipped>0);
    }
    if(framePacing) {
      const {orbitStart:start,orbitEnd:end}=finalState.columnWork,submitted=end.sequence-start.sequence;
      assert.ok(submitted>0);assert.equal(end.pacer.stats.submitted-start.pacer.stats.submitted,submitted);
      assert.equal(end.stats.performanceFrames,Math.min(600,submitted),'FPS samples count actual player submissions');
    }
    assert.equal(finalState.columnWork.restored,true);
    assert.equal(finalState.columnWork.admission.restored,true);assert.deepEqual(finalState.columnWork.admission.faults,[]);
    assert.ok(finalState.columnWork.records.some(record=>record.phase==='orbit'&&record.plan?.forecastSteps===3&&record.plan.cacheSteps===2),'Actual orbit must execute the opted-in column bank');
    assert.ok(finalState.columnWork.records.every(record=>!record.budget.fault&&record.budget.pending<=2));
    assert.ok(finalState.columnWork.records.every(record=>!record.plan||record.plan.allocatedTargetBytes<=18*1024*1024));
  }
  assert.ok(finalState.contexts.installed&&finalState.contexts.disposed&&finalState.contexts.wrapperRestored);
  assert.deepEqual(finalState.contexts.faults,[]);
  assert.equal(finalState.contexts.dropped.contexts,0);
  assert.equal(finalState.contexts.dropped.events,0);
  assert.ok(Number.isInteger(finalState.mainContextId),'Early observer must identify the actual main canvas');
  assert.equal(finalState.contexts.contexts.find(row=>row.contextId===finalState.mainContextId)?.lostEvents,0);
  assert.equal(finalState.probe.firstError,null,'Intrusive trace errors must not be erased by checkpoints or screenshot frames');
  assert.ok(finalState.probe.errorArms.every(arm=>arm.preexisting===0));assert.deepEqual(finalState.probe.faults,[]);
  assert.deepEqual(finalState.probe.lifetimeFaults,[],'Deleted programs must not be queried');
  assert.deepEqual(finalState.probe.programQueryFailures,[],'Fast invalid program queries remain failures');
  assert.ok(checkpoints.filter(p=>p.label!=='boot-before-placement'&&p.label!=='column-orbit-complete')
    .every(p=>p.near?.worker&&!p.near.workerError),'Cloud/near-water integration must retain its actual worker');
  assert.ok(finalState.workers.every(event=>event.kind!=='error'&&event.kind!=='messageerror'));
  assert.equal(driverWarningCount,0,'Driver GL warnings must not be hidden by a clean final getError');
  if(finalState.retirement) {
    assert.deepEqual(finalState.retirement.faults,[]);assert.equal(finalState.retirement.blocked,0);
    assert.ok(finalState.retirement.nativeDeletes>0,'Production must exercise guarded program retirement');
  }
  if(historyTransitions) {
    assert.ok(finalState.history.restored);
    assert.ok(finalState.history.records.every(row=>row.bodyMatches));
    for(const phase of ['initial','replacement','time','small-teleport','resize','resize-return']) {
      const rows=finalState.history.records.filter(row=>row.phase===phase);
      assert.equal(rows[0]?.valid,0,`First actual ${phase} resolve must reject stale history`);
      assert.ok(rows.some(row=>row.valid===1),`${phase} must recover history on a subsequent player frame`);
    }
  }
  if(historySweep) {
    for(let step=0;step<32;step++) {
      const row=finalState.history.records.find(row=>row.phase===`sweep-${step}`);
      assert.equal(row?.depthReady,1,'Real player resolve must borrow opaque depth');
      assert.equal(row?.valid,1,'Continuous controlled turn must retain valid history');
      assert.equal(row?.stationary,0,'Real turn must not take the stationary shortcut');
    }
  }
  if(receiverStartup)assert.ok(finalState.receiverStartup.restored);
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
  report.functionalChecksPassed=true;
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.ok(bootDeadline.passed,'Original 120 s boot gate failed; extended observation does not turn it green');
} catch(error) {
  const state=await page?.evaluate(()=>({stats:window.NMS?.stats?.(),water:window.NMS?.waterState?.(0),
    profile:window.NMS?._pipeline?.performanceSnapshot(),probe:window.__foundationGLProbe?.snapshot(),workers:window.__foundationWorkers,
    ownerModes:window.__foundationOwnerModes,history:window.__foundationHistory,receiverStartup:window.__foundationReceiverStartup,parallelPreparation:window.__foundationCloudPrewarm,contexts:window.__foundationContextProbe?.snapshot(),
    columnWork:window.__foundationColumnWork,frameGate:window.__foundationColumnFrameGate?.snapshot(),framePacing:window.NMS?._pipeline?.framePacer?.snapshot(),pauseControl:window.__foundationPauseControl,
    mainContextId:window.__foundationContextProbe?.idForCanvas(window.NMS?._renderer?.domElement)})).catch(captureError=>({captureError:String(captureError)}));
  await page?.screenshot({path:`${out}/failure-player.png`,timeout:30000}).catch(()=>{});
  await writeFile(`${out}/failure.json`,JSON.stringify({...before,helperBefore,contextHelperBefore,warmHelperBefore,parallelNearControl,parallelNearResult,ownerModes,ownerModesResult,viewLoopControl,cloudOverride,traceState,checkpoints,state,errors,warnings,
    warningDropped,driverWarningCount,driverWarnings,workerEvents,networkFailures,nativeLogs,nativeLogsDropped,browserInfo,
    cloudPrograms,cloudIdleControl,cloudFlushControl,framePacing,observeAfterBootTimeout,bootDeadline,error:String(error)},null,2));
  await finishTrace();console.error(JSON.stringify({out,error:String(error)}));throw error;
} finally {
  try {await browser?.close();}
  finally {await new Promise(resolve=>server.close(resolve));}
}
