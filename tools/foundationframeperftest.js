// Whole production chain attribution with asynchronous timers. No timer waits
// between phases/frames; snapshots retain CPU/GPU as separate measurements.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const reference='518fe4f',out='test-results/foundation-frame';
const before=await evidenceFingerprint('tools/foundationframeperftest.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});
const errors=[],warmups=[],scenarios=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  for(const implementation of ['current','reference','current']) {
    const page=await browser.newPage({viewport:{width:1280,height:720}});
    page.on('pageerror',e=>errors.push(String(e)));
    page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
    if(implementation==='reference') {
      let source=execFileSync('git',['show',`${reference}:src/main.js`],{encoding:'utf8'});
      const first=source.indexOf('function finishSurfaceBootstrap()'),last=source.indexOf('function prewarmSurfacePipelines(',first);
      let section=source.slice(first,last);
      section=section.replace('renderer.render(scene, camera);',`const started=performance.now(),calls=renderer.info.render.calls;
        renderer.render(scene,camera);
        window.__warmup={cpuMs:performance.now()-started,calls:renderer.info.render.calls-calls,
          meshes:surfaceBootstrapMeshes.length,shadowMapSizes:[sunShadow.shadow.mapSize.toArray()],privateScene:false};`);
      source=source.slice(0,first)+section+source.slice(last);
      await page.route('**/src/main.js*',route=>route.fulfill({contentType:'text/javascript',body:source}));
    }
    await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=walk&planet=0&bias=meadow&quality=balanced&vclouds=0&post=1`);
    await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
    await page.waitForFunction(()=>window.__warmup||NMS.surfaceWarmupState?.().stats,null,{timeout:90000});
    warmups.push({implementation,...await page.evaluate(()=>window.__warmup||NMS.surfaceWarmupState().stats)});
    console.log('Warmup',JSON.stringify(warmups.at(-1)));
    if(implementation==='current'&&warmups.length===3) {
      await page.waitForFunction(()=>NMS.idle(),null,{timeout:150000});
      await page.evaluate(()=>{NMS.setAdaptiveQualityLocked(true);NMS._pipeline.startProfiling({every:1,history:200});});
      await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=60,null,{timeout:120000});
      await page.screenshot({path:`${out}/meadow.png`});
      scenarios.push(await page.evaluate(()=>({label:'meadow-clouds-off',profile:NMS._pipeline.performanceSnapshot(),
        budget:NMS.sceneBuildState(),stats:NMS.stats(),pose:NMS.referenceState(),gl:NMS._renderer.getContext().getError()})));
    }
    await page.close();
  }
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>{NMS.setAdaptiveQualityLocked(true);NMS._pipeline.startProfiling({every:1,history:200});});
  await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=40,null,{timeout:180000});
  await page.screenshot({path:`${out}/lowflight-clouds.png`});
  scenarios.push(await page.evaluate(()=>({label:'400m-clouds-on',profile:NMS._pipeline.performanceSnapshot(),
    budget:NMS.sceneBuildState(),stats:NMS.stats(),pose:NMS.referenceState(),gl:NMS._renderer.getContext().getError(),
    cloudBanks:[...NMS._pipeline.cloudLightBanks.values()].map(b=>({initialized:b.initialized,
      ready:b.planet.volCloudMat.uniforms.uSunCacheReady.value,submissions:b.submissions}))})));
  await page.close();
  const after=await evidenceFingerprint('tools/foundationframeperftest.js');
  await writeFile(`${out}/report.json`,JSON.stringify({reference,before,after,warmups,scenarios,errors,
    scope:'Real GPU 1280x720 Balanced normal HUD/post; frozen poses and separate boot pages. Local warmup CPU is order/driver sensitive; not continuous-flight or final visual acceptance.'},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  assert.ok(warmups.filter(w=>w.implementation==='current').every(w=>w.skipped||(w.privateScene&&w.shadowMapSizes.every(s=>s.every(v=>v===2)))));
  assert.ok(warmups.find(w=>w.implementation==='reference').calls>warmups[0].calls);
  for(const s of scenarios) {
    assert.equal(s.gl,0);assert.equal(s.profile.supported,true);
    assert.ok(s.profile.records.some(r=>r.gpuMs>0),'Need completed, nonempty asynchronous GPU results');
    console.log(s.label,JSON.stringify(Object.fromEntries([...new Set(s.profile.records.map(r=>r.name))].map(name=>{
      const rows=s.profile.records.filter(r=>r.name===name&&r.gpuMs!==null);
      return [name,{samples:rows.length,cpuMean:rows.reduce((n,r)=>n+r.cpuMs,0)/rows.length,
        gpuMean:rows.reduce((n,r)=>n+r.gpuMs,0)/rows.length,gpuMax:Math.max(...rows.map(r=>r.gpuMs))}];
    }))));
  }
  console.log(`PASS: bounded asynchronous production phase timing and isolated surface warmup; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
