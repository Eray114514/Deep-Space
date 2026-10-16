import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out = 'test-results/terrain-detail', reference = '1a77e44';
await mkdir(out, { recursive: true });
const before = await evidenceFingerprint('tools/terraindetailplaytest.js');
const oldShader = execFileSync('git', ['show', `${reference}:src/shaders-webgl.js`], { encoding: 'utf8' });
const referenceDigest = createHash('sha256').update(oldShader).digest('hex');
const { server, port } = await startServer(0);
const errors = [], cases = [];
let browser;
const median = values => { const a = [...values].sort((a,b)=>a-b), n=a.length; return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2; };
try {
  browser = await launchHardwareBrowser({ executablePath: resolveSystemChromePath() || undefined });
  for (const [index, implementation] of ['reference', 'current', 'reference', 'cloud-current'].entries()) {
    const clouds = implementation === 'cloud-current';
    const page = await browser.newPage({ viewport: clouds ? { width: 2560, height: 1440 } : { width: 1280, height: 720 } });
    page.on('pageerror', error => errors.push({implementation,error:String(error)}));
    page.on('console', message => {if(message.type()==='error')errors.push({implementation,error:message.text()});});
    if (implementation === 'reference') {
      await page.route('**/src/shaders-webgl.js*', route => route.fulfill({contentType:'text/javascript',body:oldShader}));
    }
    await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&planet=0&bias=meadow`
      + `&scene=${clouds?'lowflight&alt=400':'walk'}&quality=${clouds?'ultra':'balanced'}&vclouds=${clouds?1:0}&farflora=1&post=1`);
    await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:180000});
    console.log(`Booted ${index}: ${implementation}`);
    await page.evaluate(clouds=>{NMS.setAdaptiveQualityLocked(true);NMS.setLocalSunAltitude(0,35);
      NMS.lookPitch(clouds?-16:-24);if(!clouds)NMS.lookYaw(180);},clouds);
    await page.waitForFunction(()=>NMS.idle()&&NMS.surfaceWarmupState().ready,null,{timeout:150000});
    await page.waitForFunction(async()=>{
      const {surfaceMaterialStatus}=await import('/src/surface-materials.js');return surfaceMaterialStatus().ready===6;
    },null,{timeout:90000});
    console.log(`Ready ${index}: ${implementation}`);
    await page.screenshot({path:`${out}/${index}-${implementation}-start.png`});
    await page.evaluate(()=>{
      window.__terrainPlayer={frames:[],poses:[],running:true,previous:null};
      NMS._pipeline.startProfiling({every:1,history:3000});
      function tick(now) {
        const s=__terrainPlayer;if(!s.running)return;
        if(s.previous!==null)s.frames.push(now-s.previous);s.previous=now;
        requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    });
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=90,null,{timeout:90000});
    const still=await page.evaluate(()=>({frames:__terrainPlayer.frames.slice(),profile:NMS._pipeline.performanceSnapshot(),
      stats:NMS.stats(),pose:NMS.referenceState(),gl:NMS._renderer.getContext().getError()}));
    let movement = null;
    if(implementation==='current'||clouds) {
      await page.evaluate(()=>{__terrainPlayer.frames=[];__terrainPlayer.previous=null;__terrainPlayer.start=NMS.referenceState();
        NMS._pipeline.startProfiling({every:2,history:3000});});
      await page.keyboard.down('KeyW');await page.keyboard.down('ShiftLeft');
      for(let step=0;step<4;step++) {
        await page.waitForTimeout(2000);
        await page.evaluate(()=>__terrainPlayer.poses.push({pose:NMS.referenceState(),stats:NMS.stats(),gl:NMS._renderer.getContext().getError()}));
        await page.screenshot({path:`${out}/${index}-${implementation}-move-${step}.png`});
      }
      await page.keyboard.up('ShiftLeft');await page.keyboard.up('KeyW');
      movement=await page.evaluate(()=>({start:__terrainPlayer.start,end:NMS.referenceState(),frames:__terrainPlayer.frames.slice(),
        poses:__terrainPlayer.poses,profile:NMS._pipeline.performanceSnapshot(),gl:NMS._renderer.getContext().getError()}));
      movement.distance=Math.hypot(...movement.end.playerLocal.map((v,i)=>v-movement.start.playerLocal[i]));
    }
    const phases = Object.fromEntries([...new Set(still.profile.records.map(r=>r.name))].map(name=>{
      const records=still.profile.records.filter(r=>r.name===name&&r.gpuMs!==null&&r.frame>=10);
      return [name,{samples:records.length,gpuMedianMs:median(records.map(r=>r.gpuMs)),cpuMedianMs:median(records.map(r=>r.cpuMs))}];
    }));
    const entry={implementation,still,movement,phases};cases.push(entry);
    await writeFile(`${out}/player-partial.json`,JSON.stringify({before,reference,referenceDigest,cases,errors},null,2));
    if(movement) {
      assert.ok(movement.distance>(clouds?128:20),`Normal input must traverse terrain: ${movement.distance} m`);
      assert.equal(movement.gl,0);assert.ok(movement.poses.every(p=>p.gl===0));
    }
    console.log(JSON.stringify({implementation,phases,distance:movement?.distance,frameMedian:median(still.frames.slice(10))}));
    await page.evaluate(()=>{__terrainPlayer.running=false;NMS._pipeline.stopProfiling();});
    await page.close();
  }
  const after=await evidenceFingerprint('tools/terraindetailplaytest.js');
  const stableSource=before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest;
  const report={before,after,stableSource,reference,referenceDigest,cases,errors,
    scope:'Reference/current/reference sequential real GPU pages: 720p Balanced normal HUD/post, vegetation on, clouds off for terrain isolation. Current also has 8 s normal input and 1440p Ultra clouds-on low flight. Frozen celestial/weather time; profiling/readback/screenshot overhead included; not full matrix or final art acceptance.'};
  await writeFile(`${out}/player.json`,JSON.stringify(report,null,2));
  assert.equal(stableSource,true);assert.deepEqual(errors,[]);
  for(const entry of cases) {assert.equal(entry.still.gl,0);assert.ok(entry.still.profile.records.some(r=>r.gpuMs>0));}
  console.log(`PASS: normal-player rendering/movement and asynchronous phase timing; ${out}/player.json`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
