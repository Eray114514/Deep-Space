import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out='test-results/ocean-render-frame',reference='a0a2bc6';await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/oceanrenderframeplaytest.js');
const oldShader=execFileSync('git',['show',`${reference}:src/shaders-webgl.js`],{encoding:'utf8'});
const referenceDigest=createHash('sha256').update(oldShader).digest('hex');
const {server,port}=await startServer(0);let browser;
const errors=[],cases=[];
const median=values=>{const a=[...values].sort((a,b)=>a-b),n=a.length;return n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;};
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  for(const [index,implementation] of ['reference','current','reference','cloud-current'].entries()) {
    const clouds=implementation==='cloud-current';
    const page=await browser.newPage({viewport:{width:1280,height:720}});
    page.setDefaultTimeout(90000);
    page.on('pageerror',error=>errors.push({implementation,error:String(error)}));
    page.on('console',m=>{if(m.type()==='error')errors.push({implementation,error:m.text()});});
    if(implementation==='reference')await page.route('**/src/shaders-webgl.js*',route=>route.fulfill({contentType:'text/javascript',body:oldShader}));
    await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&quality=balanced&vclouds=${clouds?1:0}&farflora=0&post=1`);
    await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:180000});
    await page.evaluate(()=>{
      const p=NMS._planet(0);NMS.setAdaptiveQualityLocked(true);NMS.setBuildBudget(40);
      NMS.teleport(0,(p.seaLevel+40)/p.R,{dir:[.34669147556655305,.07291666666666663,-.9351407276403421],horizon:true,pitch:0});
      NMS.setLocalSunAltitude(0,32);NMS.shipViewDebug.setViewMode('chase');NMS.lookPitch(-10);
      window.__oceanFrameLost=0;NMS._renderer.domElement.addEventListener('webglcontextlost',()=>__oceanFrameLost++);
    });
    console.log(`Booted ${index}: ${implementation}`);
    await page.waitForFunction(()=>{const w=NMS.waterState(0);return w?.near?.visible&&!w.near.pending&&w.global.pending===0;},null,{timeout:180000});
    await page.evaluate(()=>{NMS.setBuildBudget(0);NMS._pipeline.startProfiling({every:1,history:1000});});
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=80,null,{timeout:90000});
    const state=await page.evaluate(()=>({stats:NMS.stats(),water:NMS.waterState(0),profile:NMS._pipeline.performanceSnapshot(),
      anchor:NMS._planet(0).liquidMat.userData.oceanSamplingAnchor?.toArray()||null,
      gl:NMS._renderer.getContext().getError(),lost:NMS._renderer.getContext().isContextLost(),lostEvents:__oceanFrameLost}));
    const phases=Object.fromEntries([...new Set(state.profile.records.map(r=>r.name))].map(name=>{
      const rows=state.profile.records.filter(r=>r.name===name&&r.frame>=10&&r.gpuMs!==null);
      return [name,{samples:rows.length,gpuMedianMs:median(rows.map(r=>r.gpuMs)),cpuMedianMs:median(rows.map(r=>r.cpuMs))}];
    }));
    await page.screenshot({path:`${out}/${index}-${implementation}.png`,timeout:90000});
    const entry={implementation,state,phases};cases.push(entry);
    await writeFile(`${out}/player-partial.json`,JSON.stringify({before,reference,referenceDigest,cases,errors},null,2));
    console.log(JSON.stringify({implementation,phases,pending:state.stats.terrainPending,waterPending:state.stats.waterPending,gl:state.gl,lost:state.lost}));
    assert.equal(state.gl,0);assert.equal(state.lost,false);assert.equal(state.lostEvents,0);
    assert.equal(!!state.anchor,implementation!=='reference');
    await page.evaluate(()=>NMS._pipeline.stopProfiling());await page.close();
  }
  const after=await evidenceFingerprint('tools/oceanrenderframeplaytest.js');
  const stable=before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest;
  await writeFile(`${out}/player.json`,JSON.stringify({before,after,stable,reference,referenceDigest,cases,errors,
    scope:'720p Balanced frozen sea camera, normal HUD/post, reference/current/reference clouds-off for cost isolation; current also default clouds on. Patch and global water generation must complete; terrain queue separately recorded. Still captures do not replace real-input nearwaterplaytest or art acceptance.'},null,2));
  assert.equal(stable,true);assert.deepEqual(errors,[]);
  console.log(`PASS: static sea cost/draw gates; ${out}/player.json`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
