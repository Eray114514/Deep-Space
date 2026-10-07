import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const out='test-results/foundation-flight',before=await evidenceFingerprint('tools/foundationflightperftest.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});
const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&farflora=1&vclouds=0&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  console.log('Booted; awaiting surface warmup, then measuring live streaming.');
  await page.waitForFunction(()=>NMS.surfaceWarmupState().ready,null,{timeout:90000});
  await page.evaluate(()=>{NMS.setAdaptiveQualityLocked(true);NMS.lookPitch(0);});
  const cdp=await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');await cdp.send('Profiler.setSamplingInterval',{interval:1000});
  await cdp.send('Profiler.start');
  await page.evaluate(()=>NMS._pipeline.startProfiling({every:10,history:4000}));
  // Installing CPU instrumentation and receiving its first sample is itself
  // disruptive. Separate that setup from the following normal input interval.
  await page.waitForTimeout(2000);
  await page.evaluate(()=>{
    window.__flight={frames:[],longTasks:[],start:NMS.referenceState(),startStats:NMS.stats(),settledAtStart:NMS.idle(),
      measurementStart:performance.now(),instrumentationWarmupMs:2000,running:true};
    const observer=new PerformanceObserver(list=>{for(const e of list.getEntries())__flight.longTasks.push({start:e.startTime,duration:e.duration});});
    observer.observe({type:'longtask',buffered:false});__flight.observer=observer;
    let previous=null;
    function sample(now) {
      if(!__flight.running)return;
      if(previous!==null)__flight.frames.push({time:now,spanMs:now-previous,budget:NMS.sceneBuildState(),flora:NMS._ff.debugStats(),
        altitude:NMS.stats().altitude});previous=now;requestAnimationFrame(sample);
    }
    requestAnimationFrame(sample);
  });
  await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
  await page.waitForTimeout(20000);
  await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
  const {profile}=await cdp.send('Profiler.stop');await cdp.send('Profiler.disable');
  const result=await page.evaluate(()=>{
    __flight.running=false;__flight.observer.disconnect();delete __flight.observer;
    return {...__flight,end:NMS.referenceState(),profile:NMS._pipeline.performanceSnapshot(),gl:NMS._renderer.getContext().getError()};
  });
  const nodes=new Map(profile.nodes.map(n=>[n.id,n])),sampleTime=new Map();
  profile.samples.forEach((id,i)=>sampleTime.set(id,(sampleTime.get(id)||0)+(profile.timeDeltas[i]||0)));
  const cpu=[...sampleTime].map(([id,us])=>({ms:us/1000,...nodes.get(id).callFrame})).sort((a,b)=>b.ms-a.ms).slice(0,40);
  await page.screenshot({path:`${out}/player.png`});
  const after=await evidenceFingerprint('tools/foundationflightperftest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,result,cpu,errors,
    scope:'20 s normal W+Shift flight, 1280x720 Balanced HUD/post, far vegetation on; frozen weather and volume clouds off. JS sampling and opt-in phase timers add overhead; not full effects or 2K acceptance.'},null,2));
  await writeFile(`${out}/cpu-profile.json`,JSON.stringify(profile));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(result.gl,0);assert.deepEqual(errors,[]);
  const start=result.start.playerLocal,end=result.end.playerLocal;
  const distance=Math.hypot(...end.map((v,i)=>v-start[i]));assert.ok(distance>1024,'Flight must cross a far vegetation cell');
  const spans=result.frames.map(f=>f.spanMs).sort((a,b)=>a-b);
  console.log(JSON.stringify({frames:spans.length,distance,frameP50:spans[Math.floor(spans.length*.5)],
    frameP95:spans[Math.floor(spans.length*.95)],frameMax:spans.at(-1),longTasks:result.longTasks,cpu:cpu.slice(0,8)},null,2));
  console.log(`PASS: continuous normal input and CPU/GPU attribution; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
