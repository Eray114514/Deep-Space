// Diagnose the full-cloud idle gate separately from terrain precision. A busy
// queue remains OPEN in the report; legal draws/movement cannot close it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/terrain-detail', reference = '1a77e44';
await mkdir(out,{recursive:true});
const before = await evidenceFingerprint('tools/terraindetailcloudtest.js');
const oldShader = execFileSync('git',['show',`${reference}:src/shaders-webgl.js`],{encoding:'utf8'});
const referenceDigest = createHash('sha256').update(oldShader).digest('hex');
const {server,port} = await startServer(0);
let browser;
const cases = [], errors = [];
try {
  browser = await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  for(const implementation of ['current','reference']) {
    const page = await browser.newPage({viewport:{width:2560,height:1440}});
    page.on('pageerror',e=>errors.push({implementation,error:String(e)}));
    page.on('console',m=>{if(m.type()==='error')errors.push({implementation,error:m.text()});});
    if(implementation==='reference')await page.route('**/src/shaders-webgl.js*',route=>route.fulfill({contentType:'text/javascript',body:oldShader}));
    await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&planet=0&bias=meadow`
      +'&scene=lowflight&alt=400&quality=ultra&vclouds=1&farflora=1&post=1');
    await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:180000});
    await page.evaluate(()=>{
      NMS.setAdaptiveQualityLocked(true);NMS.setLocalSunAltitude(0,35);NMS.lookPitch(-16);
      window.__terrainCloud={draws:0};
      const material=NMS._planet(0).terrainMaterial, previous=material.onBeforeRender;
      material.onBeforeRender=function(...args){__terrainCloud.draws++;previous.apply(this,args);};
    });
    const snapshot = () => page.evaluate(()=>({time:performance.now(),idle:NMS.idle(),warmup:NMS.surfaceWarmupState(),
      stats:NMS.stats(),pose:NMS.referenceState(),budget:NMS.sceneBuildState(),
      nearWater:NMS._planet(0).nearWaterPatch?.debugStats(),draws:__terrainCloud.draws,
      terrainDetailEnabled:!!NMS._planet(0).terrainMaterial.userData.terrainDetailUniforms,
      gl:NMS._renderer.getContext().getError()}));
    const samples=[await snapshot()];
    console.log(`${implementation} initial`,JSON.stringify({idle:samples[0].idle,nearWater:samples[0].nearWater,
      terrainPending:samples[0].stats.terrainPending,waterPending:samples[0].stats.waterPending}));
    for(let step=0;step<15;step++) {
      await page.waitForTimeout(2000);samples.push(await snapshot());
    }
    await page.screenshot({path:`${out}/cloud-${implementation}-start.png`});
    await page.evaluate(()=>{
      __terrainCloud.start=NMS.referenceState();__terrainCloud.frames=[];__terrainCloud.previous=null;__terrainCloud.running=true;
      NMS._pipeline.startProfiling({every:5,history:3000});
      function tick(now){const s=__terrainCloud;if(!s.running)return;if(s.previous!==null)s.frames.push(now-s.previous);
        s.previous=now;requestAnimationFrame(tick);}requestAnimationFrame(tick);
    });
    await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
    const moving=[];
    for(let step=0;step<4;step++) {
      await page.waitForTimeout(2000);moving.push(await snapshot());
      await page.screenshot({path:`${out}/cloud-${implementation}-move-${step}.png`});
    }
    await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
    const motion=await page.evaluate(()=>{
      __terrainCloud.running=false;const profile=NMS._pipeline.performanceSnapshot();NMS._pipeline.stopProfiling();
      return {start:__terrainCloud.start,end:NMS.referenceState(),frames:__terrainCloud.frames,profile};
    });
    motion.distance=Math.hypot(...motion.end.playerLocal.map((v,i)=>v-motion.start.playerLocal[i]));
    const entry={implementation,samples,moving,motion,idleGateObserved:samples.some(s=>s.idle),
      observationMs:samples.at(-1).time-samples[0].time};cases.push(entry);
    await writeFile(`${out}/cloud-partial.json`,JSON.stringify({before,reference,referenceDigest,cases,errors},null,2));
    console.log(JSON.stringify({implementation,idleGateObserved:entry.idleGateObserved,observationMs:entry.observationMs,
      distance:motion.distance,lastNearWater:samples.at(-1).nearWater,gl:moving.map(s=>s.gl)}));
    await page.close();
  }
  const after=await evidenceFingerprint('tools/terraindetailcloudtest.js');
  const stableSource=before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest;
  await writeFile(`${out}/cloud.json`,JSON.stringify({before,after,stableSource,reference,referenceDigest,cases,errors,
    scope:'2K Ultra frozen celestial/weather low flight, full default clouds/HUD/post/vegetation; current/reference independent pages, 30 s queue observation then 8 s normal input. GL queries/snapshots/screenshots/profiling add overhead; timing is diagnostic, not stable performance acceptance. Idle failure remains open.'},null,2));
  assert.equal(stableSource,true);assert.deepEqual(errors,[]);
  for(const entry of cases) {
    assert.ok(entry.samples.every(s=>s.gl===0)&&entry.moving.every(s=>s.gl===0));
    assert.ok(entry.moving.at(-1).draws>100);assert.ok(entry.motion.distance>128);
    assert.equal(entry.samples[0].terrainDetailEnabled,entry.implementation==='current');
  }
  console.log('PASS: full-cloud actual terrain draws/normal movement/GL. Idle readiness remains a separate reported gate.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
