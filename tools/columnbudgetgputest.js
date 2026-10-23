// Full native columns, real FIFO weather worker and a live wall-clock under
// competing GPU draws. This is not the whole game's foreground/frame budget.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const verifier='tools/columnbudgetgputest.js',out=`test-results/column-budget-gpu/${new Date().toISOString().replace(/[:.]/g,'-')}`;
const deadlineAware=process.argv.includes('--deadline-aware');
const requireSteady=process.argv.includes('--require-steady');
const stagedCosts=process.argv.includes('--staged-costs');
const durationArgument=process.argv.slice(2).find(arg=>arg.startsWith('--duration-ms='));
const durationMs=durationArgument?Number(durationArgument.slice('--duration-ms='.length)):30000;
const forecastArgument=process.argv.slice(2).find(arg=>arg.startsWith('--forecast-steps='));
const forecastSteps=forecastArgument?Number(forecastArgument.slice('--forecast-steps='.length)):2;
const cacheArgument=process.argv.slice(2).find(arg=>arg.startsWith('--cache-steps='));
const cacheSteps=cacheArgument?Number(cacheArgument.slice('--cache-steps='.length)):2;
const hzArgument=process.argv.slice(2).find(arg=>arg.startsWith('--frame-hz='));
const frameHz=hzArgument?Number(hzArgument.slice('--frame-hz='.length)):60;
const bodyArgument=process.argv.slice(2).find(arg=>arg.startsWith('--body='));
const bodyId=bodyArgument?bodyArgument.slice('--body='.length):'planet-0';
const untunedStress=process.argv.includes('--untuned-stress');
assert.ok(Number.isInteger(durationMs)&&durationMs>=12000&&durationMs<=120000,'Duration must be 12000..120000 ms');
assert.ok([2,3].includes(forecastSteps)&&[2,3].includes(cacheSteps)&&cacheSteps<=forecastSteps,'Bounded forecast/cache steps required');
assert.ok([30,60].includes(frameHz),'Frame cap must be 30 or 60 Hz');
assert.ok(['planet-0','planet-1'].includes(bodyId),'Select a curated terrestrial body');
assert.ok(process.argv.slice(2).every(arg=>['--deadline-aware','--require-steady','--untuned-stress','--staged-costs',durationArgument,forecastArgument,cacheArgument,hzArgument,bodyArgument].includes(arg)),'Unsupported argument');
await mkdir(out,{recursive:true});await writeFile(`${out}/verifier.js`,await readFile(verifier));
const fixtureBytes=await readFile('tools/fixtures/weather-stream-b9f6f51.json'),fixture=JSON.parse(fixtureBytes);
assert.equal(createHash('sha256').update(fixture.source).digest('hex'),fixture.sha256);
await writeFile(`${out}/weather-reference.json`,fixtureBytes);
const before=await evidenceFingerprint(verifier),errors=[],warnings=[];
const {server,port}=await startServer(0);let browser,result,page;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  page=await browser.newPage({viewport:{width:1024,height:512}});
  page.on('pageerror',error=>errors.push(String(error)));
  page.on('console',message=>{
    if(message.type()==='error')errors.push(message.text());
    if(/GL_INVALID|WebGL.*INVALID_|CONTEXT_LOST_WEBGL|Program object expected|GL_OUT_OF_MEMORY/i.test(message.text()))warnings.push(message.text());
  });
  await page.route('**/column-budget.html',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>'}));
  await page.route('**/src/cloud/weather-reference.js',route=>route.fulfill({contentType:'text/javascript',body:fixture.source}));
  await page.goto(`http://127.0.0.1:${port}/column-budget.html`);
  result=await page.evaluate(async({deadlineAware,durationMs,forecastSteps,cacheSteps,frameHz,bodyId,untunedStress,stagedCosts})=>{
    const T=await import('three'),{Planet}=await import('/src/planet.js');
    const {CelestialClock}=await import('/src/astronomy.js');
    const {canonicalHomeBody}=await import('/tools/canonical-planet-fixture.js');
    const {PlanetWeatherStream:ReferenceStream}=await import('/src/cloud/weather-reference.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
    const {CloudColumnTileMap}=await import('/src/cloud/cloud-column-tile-map.js');
    const {OwnedScreenTriangle}=await import('/src/owned-screen-triangle.js');
    const {GpuWorkBudget}=await import('/src/gpu-work-budget.js');
    const checks=[],timeline=[],native=[],parity=[],completions=[],starts=[],availability=[],workerEvents=[],work=[];
    const seenComplete=new WeakSet(),seenStart=new WeakSet(),seenAvailable=new Set(),observedFences=new Map();
    const evidence=window.__columnBudgetEvidence={checks,timeline,native,parity,completions,starts,availability,workerEvents,work};
    const check=(condition,label)=>{checks.push({label,passed:Boolean(condition)});if(!condition)throw Error(label);};
    const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const {spec,tuning,provenance}=canonicalHomeBody({bodyId,untunedStress});
    const makePlanet=()=>new Planet({seed:spec.seed,name:spec.name,catalogName:spec.catalogName,posUniv:new T.Vector3(),type:spec.type,
      isMoon:spec.isMoon,radius:spec.radius,atmosphere:spec.atmosphere,clouds:spec.clouds,
      tuning,formation:spec.formation,ringSystem:spec.ringSystem});
    let p,reference,r,bank,budget,load,quad;const warmPrograms={};
    try {
      p=makePlanet();reference=makePlanet();p.setWeatherTime(0);reference.setWeatherTime(0);
      reference.weatherStream.dispose();reference.weatherStream=new ReferenceStream(reference);reference.weatherStream.update(0,true);
      const stream=p.weatherStream,old=reference.weatherStream,step=stream.frameHours;
      evidence.input={...provenance,seed:p.seed,radius:p.R,type:p.type,namespace:p.weatherField.namespace,
        windRadiansPerHour:p.weatherField.windRadiansPerHour,weatherProfile:p.weatherProfile,frameHours:step,
        spec:{seed:spec.seed,radius:spec.radius,bodyId:spec.bodyId}};
      const timeout=performance.now()+120000;
      while(![stream,old].every(s=>s.ready&&[0,step,2*step].every(h=>s.frames.has(h))&&s.pending.size===0)) {
        check(performance.now()<timeout&&!stream.error&&!old.error,'Actual old/new workers finish real forecast');await raf();
      }
      for(const hours of [0,step,2*step])for(const key of ['low','high','bands','bounds','candidates','wind']) {
        const a=stream.frames.get(hours)[key],b=old.frames.get(hours)[key];
        const x=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),y=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);
        check(x.length===y.length&&x.every((value,i)=>value===y[i]),`Same-hour worker bytes ${hours} ${key}`);
        parity.push({hours,key,bytes:x.length,sha256:await hash(x)});
      }
      reference.dispose();reference=null;
      r=new T.WebGLRenderer({canvas:document.querySelector('#fixture')});r.setSize(1024,512,false);
      const gl=r.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
      const gpu=gl.getParameter(debug?debug.UNMASKED_RENDERER_WEBGL:gl.RENDERER);
      check(!/swiftshader|llvmpipe|software/i.test(gpu),'Hardware WebGL');
      const read=target=>{
        const optical=new Uint8Array(1024*512*4),heights=new Uint16Array(optical.length),saved=r.getRenderTarget();
        try {r.setRenderTarget(target);r.readRenderTargetPixels(target,0,0,1024,512,optical);r.readRenderTargetPixels(target,0,0,1024,512,heights,undefined,1);}
        finally {r.setRenderTarget(saved);}return {optical,heights};
      };
      const difference=(a,b)=>Object.fromEntries(['optical','heights'].map(key=>[key,a[key].reduce((count,value,i)=>count+Number(value!==b[key][i]),0)]));
      const original=new CloudColumnMap(p,{hours:0,programOwner:warmPrograms});original.bakeSlice(r,512);
      const tiled=new CloudColumnTileMap(p,{hours:0,tileRows:64,footprintBatch:2,programOwner:warmPrograms});
      while(!tiled.ready)tiled.bakeWork(r,8);
      const delta=difference(read(original.target),read(tiled.target));check(delta.optical===0&&delta.heights===0,'Warm full native/tile exact');
      original.dispose();tiled.dispose();
      load=new T.WebGLRenderTarget(512,512,{depthBuffer:false});
      const material=new T.ShaderMaterial({depthTest:false,depthWrite:false,
        vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'void main(){vec2 p=gl_FragCoord.xy*.003;float v=.1;for(int i=0;i<64;i++){v=sin(v+dot(p,vec2(.73,.31))+float(i)*.01);p+=vec2(v,-v)*.003;}gl_FragColor=vec4(vec3(v*.4+.5),1.);}'});
      quad=new OwnedScreenTriangle(material);r.setRenderTarget(load);quad.render(r);r.setRenderTarget(null);
      budget=new GpuWorkBudget(r,{budgetMs:6,maxUnits:12,maxPending:2,maxInFlightMs:12,sampleEvery:8,history:1024});
      bank=new CloudColumnBank(p,{producer:'tile',tileRows:64,footprintBatch:2,deadlineAware,forecastSteps,cacheSteps});p.cloudColumnMap=bank;
      const clock=new CelestialClock('column-budget-actual',{initialHours:0,persist:false});
      const start=performance.now();let last=start,nextFrame=start,readyFrames=0,firstReady=null,maxWorkerPending=0,maxFences=0,frames=0;
      const observedWorkers=new WeakSet();
      const watchWorker=stream=>{
        const worker=stream.worker;if(observedWorkers.has(worker))return;observedWorkers.add(worker);
        const post=worker.postMessage.bind(worker),message=worker.onmessage;
        worker.postMessage=(data,...args)=>{
          if(data.type==='frame')workerEvents.push({kind:'dispatch',hours:data.hours,token:data.token,elapsedMs:performance.now()-start});
          return post(data,...args);
        };
        worker.onmessage=event=>{
          workerEvents.push({kind:'message',hours:event.data.hours,token:event.data.token,error:event.data.error,elapsedMs:performance.now()-start});
          return message(event);
        };
      };
      const rawUsage=stream=>{
        const frames=new Set([...stream.frames.values(),stream.committedFirst,stream.committedSecond,stream.boundsFirst,stream.boundsSecond].filter(Boolean));
        const buffers=new Set();for(const frame of frames)for(const key of ['low','high','bands','bounds','candidates','wind'])if(frame[key])buffers.add(frame[key].buffer);
        return {frames:stream.frames.size,referencedFrames:frames.size,bytes:[...buffers].reduce((sum,buffer)=>sum+buffer.byteLength,0)};
      };
      const poll=budget.poll.bind(budget);
      budget.poll=()=>{
        const pending=[...budget.pending];poll();
        for(const item of pending)if(item.record.completedFrame!==null&&!observedFences.has(item.record.frame)) {
          const elapsedMs=performance.now()-start;observedFences.set(item.record.frame,elapsedMs);work.push({...item.record,fenceObservedElapsedMs:elapsedMs});
        }
      };
      while(performance.now()-start<durationMs) {
        let now;do {now=await raf();}while(now<nextFrame);
        nextFrame=now+1000/frameHz;
        const elapsed=now-start;clock.update((now-last)/1000,true);last=now;watchWorker(p.weatherStream);p.setWeatherTime(clock.hours);
        budget.beginFrame();r.setRenderTarget(load);quad.render(r);
        let outcome;
        if(stagedCosts)bank.update(r,{admit:(request,produce)=>{
          outcome=budget.run(request.key,produce,{maxUnits:request.maxUnits});return outcome.value;
        }});
        else outcome=budget.run(p.weatherField,grant=>bank.update(r,{workQuanta:grant,allowCreate:grant>0}));
        outcome||={granted:0,units:0,reason:'no-current-work'};
        r.setRenderTarget(load);quad.render(r);r.setRenderTarget(null);
        const snapshot=budget.snapshot(),ready=p.volCloudMat.uniforms.uColumnsReady.value===1;
        check(snapshot.pending<=2&&snapshot.frameUnits<=12&&!snapshot.fault,'Bounded real submitted work');
        check(p.weatherStream.pending.size<=1,'One real weather worker job in flight');
        const plan=bank.plan(),raw=rawUsage(p.weatherStream);
        check(bank.maps.size<=cacheSteps+1&&[...bank.maps.values()].filter(map=>!map.ready).length<=1,'Bounded targets and one immutable snapshot');
        check(raw.frames<=5&&raw.referencedFrames<=5,'No expired raw forecast remains pinned by upload witnesses');
        if(ready){readyFrames++;firstReady??=elapsed;}
        for(const [hours,frame] of p.weatherStream.frames) {
          const revision=p.weatherStream.revisionAt(hours),key=`${hours}:${revision}`;
          if(!seenAvailable.has(key)){seenAvailable.add(key);availability.push({hours,revision,elapsedMs:elapsed});}
        }
        for(const [hours,map] of bank.maps) {
          if((map.row>0||map.footprintCursor>0)&&!seenStart.has(map)) {seenStart.add(map);starts.push({hours,workFrame:budget.frame,elapsedMs:elapsed});}
          if(map.ready&&!seenComplete.has(map)) {
            seenComplete.add(map);completions.push({hours,workFrame:budget.frame,submittedElapsedMs:elapsed,
              firstNeededHours:hours-step,startup:hours<=step,deadlineElapsedMs:(hours-step)*3600/clock.scale*1000});
          }
        }
        maxWorkerPending=Math.max(maxWorkerPending,p.weatherStream.pending.size);maxFences=Math.max(maxFences,snapshot.pending);frames++;
        timeline.push({elapsedMs:elapsed,hours:clock.hours,anchor:p.weatherStream.anchor,ready,grant:outcome.granted,draws:outcome.units,
          pending:snapshot.pending,workerPending:p.weatherStream.pending.size,raw,plan});
      }
      const run={durationMs:performance.now()-start,clockElapsedMs:clock.hours*3600/clock.scale*1000,frames,readyFrames,firstReadyMs:firstReady,maxWorkerPending,maxFences,frameCapHz:frameHz,deadlineAware,forecastSteps,cacheSteps,stagedCosts,
        scale:clock.scale,frameHours:step,forecastRealSeconds:step*3600/clock.scale,budget:budget.snapshot()};
      const anchors=[...new Set(timeline.map(item=>item.anchor))];
      run.turnovers={anchors,transitions:Math.max(0,anchors.length-1),
        scope:'Observed live raw-bracket anchor changes; a bootstrap-only window is not continuous turnover acceptance.'};
      if(durationMs>=2*step*3600/clock.scale*1000+1000)
        check(run.turnovers.transitions>=2,'Long live window observes at least two real bracket turnovers');
      evidence.run=run;
      // Clock stops here. Draining/readback/oracles are outside live evidence.
      const drainUntil=performance.now()+15000;
      while(budget.pending.length){check(performance.now()<drainUntil,'Budget fences complete');await raf();budget.poll();}
      run.drainedBudget=budget.snapshot();
      for(const completed of completions) {
        completed.fenceObservedElapsedMs=observedFences.get(completed.workFrame)??null;
        completed.observedByDeadline=!completed.startup&&completed.fenceObservedElapsedMs!==null
          &&completed.fenceObservedElapsedMs<=completed.deadlineElapsedMs;
      }
      run.firstUse={completedFuture:completions.filter(item=>!item.startup).length,
        observedByDeadline:completions.filter(item=>item.observedByDeadline).length,
        scope:'A late fence observation is not an exact GPU finish timestamp. CompletedFuture counts finished endpoints, not every desired forecast; timeline retains all current/future availability.'};
      const due=[];
      for(let index=2;(index-1)*step*3600/clock.scale*1000<=run.clockElapsedMs+1e-6;index++) {
        const hours=index*step,deadlineElapsedMs=(index-1)*step*3600/clock.scale*1000;
        const completed=completions.find(item=>item.hours===hours);
        due.push({hours,deadlineElapsedMs,submittedElapsedMs:completed?.submittedElapsedMs??null,
          fenceObservedElapsedMs:completed?.fenceObservedElapsedMs??null,onTime:completed?.observedByDeadline||false});
      }
      const startupEndMs=4*step*3600/clock.scale*1000,steady=due.filter(item=>item.deadlineElapsedMs>=startupEndMs);
      run.deadlines={startupEndMs,due,steadyDue:steady.length,steadyOnTime:steady.filter(item=>item.onTime).length,
        scope:'All future endpoints first needed within the observed live clock, including unfinished endpoints; steady starts after four forecast intervals, fixed before the experiment. Fence observation is an upper bound on completion, not an exact GPU timestamp.'};
      run.residency={maxRawFrames:Math.max(...timeline.map(item=>item.raw.frames)),maxRawReferencedFrames:Math.max(...timeline.map(item=>item.raw.referencedFrames)),
        maxRawBytes:Math.max(...timeline.map(item=>item.raw.bytes)),maxMaps:Math.max(...timeline.map(item=>item.plan.allocatedTargetBytes/(1024*512*12))),
        maxTargetBytes:Math.max(...timeline.map(item=>item.plan.allocatedTargetBytes)),maxSnapshotBytes:Math.max(...timeline.map(item=>item.plan.snapshotBytes)),scratchBytes:bank.scratch.bytes,
        scope:'Owned raw ArrayBuffers, canonical column target capacity, one snapshot and scratch only. Excludes published textures, shared field resources, transient worker buffers and driver allocations; not total VRAM/RSS.'};
      // A future source needs its own old-worker byte oracle too. This fresh
      // reference runs after the live clock stops, never adding steady load.
      const futureHours=p.weatherStream.anchor+forecastSteps*step,sourceUntil=performance.now()+120000;
      while(!p.weatherStream.frames.has(futureHours)) {
        check(performance.now()<sourceUntil&&!p.weatherStream.error,'Furthest raw forecast finishes outside live window');await raf();
      }
      reference=makePlanet();reference.setWeatherTime(futureHours);reference.weatherStream.dispose();
      reference.weatherStream=new ReferenceStream(reference);reference.weatherStream.update(futureHours,true);
      while(!reference.weatherStream.frames.has(futureHours)) {
        check(performance.now()<sourceUntil&&!reference.weatherStream.error,'Reference worker produces same future hour');await raf();
      }
      for(const key of ['low','high','bands','bounds','candidates','wind']) {
        const a=p.weatherStream.frames.get(futureHours)[key],b=reference.weatherStream.frames.get(futureHours)[key];
        const x=new Uint8Array(a.buffer,a.byteOffset,a.byteLength),y=new Uint8Array(b.buffer,b.byteOffset,b.byteLength);
        check(x.length===y.length&&x.every((value,i)=>value===y[i]),`Future same-hour worker bytes ${futureHours} ${key}`);
        parity.push({phase:'post-live-future',hours:futureHours,key,bytes:x.length,sha256:await hash(x)});
      }
      reference.dispose();reference=null;
      for(const [hours,map] of bank.maps)if(map.ready&&p.weatherStream.frames.has(hours)) {
        const oracle=new CloudColumnMap(p,{hours,programOwner:warmPrograms});oracle.bakeSlice(r,512);
        const actual=read(map.target),expected=read(oracle.target),diff=difference(actual,expected);
        check(diff.optical===0&&diff.heights===0,`Dynamic complete endpoint native exact ${hours}`);
        const occupied=actual.optical.filter((value,i)=>i%4<2&&value>0).length;check(occupied>0,'Nonempty dynamic endpoint');
        native.push({hours,delta:diff,occupied,opticalSha256:await hash(actual.optical),heightsSha256:await hash(actual.heights)});oracle.dispose();
      }
      check(native.length>0,'At least one real complete native endpoint');
      budget.dispose();check(budget.released,'Drained admission owner released');
      bank.dispose();p.cloudColumnMap=null;
      const {GameLegacyPipeline}=await import('/src/legacy-render-pipeline.js');
      const pipeline=new GameLegacyPipeline(r,new T.Scene(),new T.PerspectiveCamera(60,2,.1,10000000),{volume:true,bloomEnabled:false});
      try {
        const managed=pipeline.startColumnWork();managed.beginFrame({allowanceMs:0});
        pipeline.volumePass.activePlanet=p;p.volCloudMat.uniforms.uCameraLocal.value.set(0,p.volCloudBand.rOut+300000,0);
        pipeline.volumePass.updateCloudColumns(r);
        check(pipeline.volumePass.columnMaps.get(p)?.maps.size===0,'Actual pipeline zero admission does not create snapshot maps');
        pipeline.volumePass.activePlanet=null;pipeline.setSize(64,32,1);pipeline.startProfiling({every:1});
        const beforeFrame=managed.frame;pipeline.render();
        check(managed.frame===beforeFrame+1,'Actual pipeline begins one admission frame');
        pipeline.stopProfiling();pipeline.stopColumnWork();check(managed.released,'Pipeline releases drained budget');
        check(pipeline.volumePass.columnWork===null&&p.cloudColumnMap===null,'Policy stop unbinds and retires banks');
      } finally {pipeline.dispose();}
      for(const m of Object.values(warmPrograms))m.dispose();
      const glState={error:gl.getError(),lost:gl.isContextLost()};check(glState.error===0&&!glState.lost,'Final GL0');
      return {input:evidence.input,gpu,checks,parity,timeline,native,completions,starts,availability,workerEvents,work,run,gl:glState,
        scope:'Real native 1024x512/128 height/64 footprint columns, actual worker forecasts and actual CelestialClock at 60x wall time. Two synthetic 512x512 competing draws each RAF; not the full production foreground, cold compilation, hard GPU deadline guarantee or player-image acceptance.'};
    } finally {
      budget?.dispose();bank?.dispose();quad?.material.dispose();quad?.dispose();load?.dispose();p?.dispose();reference?.dispose();r?.dispose();
    }
  },{deadlineAware,durationMs,forecastSteps,cacheSteps,frameHz,bodyId,untunedStress,stagedCosts});
  await page.screenshot({path:`${out}/fixture.png`});
  const after=await evidenceFingerprint(verifier);
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,fixture:{revision:fixture.revision,sha256:fixture.sha256},result,errors,warnings},null,2));
  assert.deepEqual(before,after);assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);
  assert.equal(result.gl.error,0);assert.ok(result.run.readyFrames>0,'Live workload never published a complete current pair');
  if(requireSteady)assert.ok(result.run.deadlines.steadyDue>=8&&result.run.deadlines.steadyDue===result.run.deadlines.steadyOnTime,'Not all due steady forecasts completed by first use');
  console.log(JSON.stringify({out,sourceDigest:before.sourceDigest,readyFrames:result.run.readyFrames,firstReadyMs:result.run.firstReadyMs,native:result.native.length,frames:result.run.frames}));
} catch(error) {
  result??=await page?.evaluate(()=>window.__columnBudgetEvidence).catch(()=>null);
  await writeFile(`${out}/failure.json`,JSON.stringify({before,after:await evidenceFingerprint(verifier),error:String(error.stack),result,errors,warnings},null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
