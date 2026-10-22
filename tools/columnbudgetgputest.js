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
const durationArgument=process.argv.slice(2).find(arg=>arg.startsWith('--duration-ms='));
const durationMs=durationArgument?Number(durationArgument.slice('--duration-ms='.length)):30000;
assert.ok(Number.isInteger(durationMs)&&durationMs>=12000&&durationMs<=120000,'Duration must be 12000..120000 ms');
assert.ok(process.argv.slice(2).every(arg=>arg==='--deadline-aware'||arg===durationArgument),'Unsupported argument');
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
  result=await page.evaluate(async({deadlineAware,durationMs})=>{
    const T=await import('three'),{Planet}=await import('/src/planet.js');
    const {GalaxyCatalog,HOME_SYSTEM_ID}=await import('/src/galaxy-layout.js');
    const {generateSystemSpec,CelestialClock}=await import('/src/astronomy.js');
    const {ACTIVE_GALAXY_ID,getGalaxyConfig,resolveBodyTuning,applySystemBodyTuning}=await import('/src/world-config.js');
    const {PlanetWeatherStream:ReferenceStream}=await import('/src/cloud/weather-reference.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
    const {CloudColumnTileMap}=await import('/src/cloud/cloud-column-tile-map.js');
    const {OwnedScreenTriangle}=await import('/src/owned-screen-triangle.js');
    const {GpuWorkBudget}=await import('/src/gpu-work-budget.js');
    const checks=[],timeline=[],native=[],parity=[],completions=[],seenComplete=new WeakSet(),observedFences=new Map();
    const evidence=window.__columnBudgetEvidence={checks,timeline,native,parity,completions};
    const check=(condition,label)=>{checks.push({label,passed:Boolean(condition)});if(!condition)throw Error(label);};
    const raf=()=>new Promise(resolve=>requestAnimationFrame(resolve));
    const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(x=>x.toString(16).padStart(2,'0')).join('');
    const seed=getGalaxyConfig(ACTIVE_GALAXY_ID).seed,star=new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID);
    const spec=applySystemBodyTuning(generateSystemSpec(seed,star),id=>resolveBodyTuning(ACTIVE_GALAXY_ID,star.id,id)).bodies[0];
    const makePlanet=()=>new Planet({seed:spec.seed,name:spec.name,catalogName:spec.catalogName,posUniv:new T.Vector3(),type:spec.type,
      isMoon:spec.isMoon,radius:spec.radius,atmosphere:spec.atmosphere,clouds:spec.clouds,
      tuning:resolveBodyTuning(ACTIVE_GALAXY_ID,star.id,spec.bodyId),formation:spec.formation,ringSystem:spec.ringSystem});
    let p,reference,r,bank,budget,load,quad;const warmPrograms={};
    try {
      p=makePlanet();reference=makePlanet();p.setWeatherTime(0);reference.setWeatherTime(0);
      reference.weatherStream.dispose();reference.weatherStream=new ReferenceStream(reference);reference.weatherStream.update(0,true);
      const stream=p.weatherStream,old=reference.weatherStream,step=stream.frameHours;
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
      bank=new CloudColumnBank(p,{producer:'tile',tileRows:64,footprintBatch:2,deadlineAware});p.cloudColumnMap=bank;
      const clock=new CelestialClock('column-budget-actual',{initialHours:0,persist:false});
      const start=performance.now();let last=start,nextFrame=start,readyFrames=0,firstReady=null,maxWorkerPending=0,maxFences=0,frames=0;
      const poll=budget.poll.bind(budget);
      budget.poll=()=>{
        const pending=[...budget.pending];poll();
        for(const item of pending)if(item.record.completedFrame!==null&&!observedFences.has(item.record.frame))
          observedFences.set(item.record.frame,performance.now()-start);
      };
      while(performance.now()-start<durationMs) {
        let now;do {now=await raf();}while(now<nextFrame);
        nextFrame=now+1000/60;
        const elapsed=now-start;clock.update((now-last)/1000,true);last=now;p.setWeatherTime(clock.hours);
        budget.beginFrame();r.setRenderTarget(load);quad.render(r);
        const outcome=budget.run(p.weatherField,grant=>bank.update(r,{workQuanta:grant,allowCreate:grant>0}));
        r.setRenderTarget(load);quad.render(r);r.setRenderTarget(null);
        const snapshot=budget.snapshot(),ready=p.volCloudMat.uniforms.uColumnsReady.value===1;
        check(snapshot.pending<=2&&snapshot.frameUnits<=12&&!snapshot.fault,'Bounded real submitted work');
        check(p.weatherStream.pending.size<=1,'One real weather worker job in flight');
        if(ready){readyFrames++;firstReady??=elapsed;}
        for(const [hours,map] of bank.maps)if(map.ready&&!seenComplete.has(map)) {
          seenComplete.add(map);completions.push({hours,workFrame:budget.frame,submittedElapsedMs:elapsed,
            firstNeededHours:hours-step,startup:hours<=step,deadlineElapsedMs:(hours-step)*3600/clock.scale*1000});
        }
        maxWorkerPending=Math.max(maxWorkerPending,p.weatherStream.pending.size);maxFences=Math.max(maxFences,snapshot.pending);frames++;
        timeline.push({elapsedMs:elapsed,hours:clock.hours,anchor:p.weatherStream.anchor,ready,grant:outcome.granted,draws:outcome.units,
          pending:snapshot.pending,workerPending:p.weatherStream.pending.size,plan:bank.plan()});
      }
      const run={durationMs:performance.now()-start,frames,readyFrames,firstReadyMs:firstReady,maxWorkerPending,maxFences,frameCapHz:60,deadlineAware,
        scale:clock.scale,frameHours:step,forecastRealSeconds:step*3600/clock.scale,budget:budget.snapshot()};
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
      return {gpu,checks,parity,timeline,native,completions,run,gl:glState,
        scope:'Real native 1024x512/128 height/64 footprint columns, actual worker forecasts and actual CelestialClock at 60x wall time. Two synthetic 512x512 competing draws each RAF; not the full production foreground, cold compilation, hard GPU deadline guarantee or player-image acceptance.'};
    } finally {
      budget?.dispose();bank?.dispose();quad?.material.dispose();quad?.dispose();load?.dispose();p?.dispose();reference?.dispose();r?.dispose();
    }
  },{deadlineAware,durationMs});
  await page.screenshot({path:`${out}/fixture.png`});
  const after=await evidenceFingerprint(verifier);
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,fixture:{revision:fixture.revision,sha256:fixture.sha256},result,errors,warnings},null,2));
  assert.deepEqual(before,after);assert.deepEqual(errors,[]);assert.deepEqual(warnings,[]);
  assert.equal(result.gl.error,0);assert.ok(result.run.readyFrames>0,'Live workload never published a complete current pair');
  console.log(JSON.stringify({out,sourceDigest:before.sourceDigest,readyFrames:result.run.readyFrames,firstReadyMs:result.run.firstReadyMs,native:result.native.length,frames:result.run.frames}));
} catch(error) {
  result??=await page?.evaluate(()=>window.__columnBudgetEvidence).catch(()=>null);
  await writeFile(`${out}/failure.json`,JSON.stringify({before,after:await evidenceFingerprint(verifier),error:String(error.stack),result,errors,warnings},null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
