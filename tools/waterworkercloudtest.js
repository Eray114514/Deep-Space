// Default cloud-path integration, not cloud art/performance acceptance.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';
import { execFileSync } from 'node:child_process';

const out=`test-results/water-worker-cloud/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/waterworkercloudtest.js');
const {server,port}=await startServer(0);
const browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
const errors=[];
const reference=process.argv.includes('--reference');
const checkpoints=[];
let page;
try {
  const context=await browser.newContext({viewport:{width:1280,height:720},recordVideo:{dir:out,size:{width:1280,height:720}}});
  page=await context.newPage();
  if(reference)await page.route('**/src/near-water-patch.js',route=>route.fulfill({contentType:'text/javascript',
    body:execFileSync('git',['show','93e934f:src/near-water-patch.js'],{encoding:'utf8'})}));
  const checkpoint=async label=>{const state=await page.evaluate(()=>({gl:NMS._renderer.getContext().getError(),
    lost:NMS._renderer.getContext().isContextLost(),near:NMS.waterState(0)?.near}));
    checkpoints.push({label,...state});console.log(JSON.stringify({label,...state}));};
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&quality=balanced&vclouds=1&farflora=0&post=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:120000});
  await checkpoint('boot-before-placement');
  await page.evaluate(()=>{
    const p=NMS._planet(0);NMS.setBuildBudget(40);
    NMS.teleport(0,(p.seaLevel+40)/p.R,{dir:[.34669147556655305,.07291666666666663,-.9351407276403421],horizon:true,pitch:0});
    NMS.setLocalSunAltitude(0,32);NMS.shipViewDebug.setViewMode('chase');NMS.lookPitch(-10);
    window.__waterWorkerLost=0;NMS._renderer.domElement.addEventListener('webglcontextlost',()=>__waterWorkerLost++);
  });
  await page.waitForFunction(reference=>{const p=NMS.waterState(0)?.near;return (reference||p?.worker)&&p?.visible&&!p.pending;},reference,{timeout:120000});
  await checkpoint('initial-complete');
  const initial=await page.evaluate(()=>{
    NMS.setBuildBudget(0);NMS._pipeline.startProfiling({every:1,history:1000});
    return {water:NMS.waterState(0),position:NMS._internals.nav.pos.toArray()};
  });
  // Controlled relocation triggers a real replacement while the full default
  // cloud pass runs. It is an integration fixture, not the normal-flight gate.
  await page.evaluate(()=>{
    const p=NMS._planet(0),T=NMS._THREE;
    const d=new T.Vector3(.34669147556655305,.07291666666666663,-.9351407276403421).normalize();
    d.addScaledVector(new T.Vector3().crossVectors(d,new T.Vector3(0,1,0)).normalize(),350/p.seaRadius).normalize();
    NMS.teleport(0,(p.seaLevel+40)/p.R,{dir:d.toArray(),horizon:true,pitch:0});
  });
  await page.waitForFunction(rebuilds=>{const p=NMS.waterState(0)?.near;return p?.rebuilds>rebuilds&&!p.pending;},initial.water.near.rebuilds,{timeout:45000});
  await checkpoint('replacement-complete');
  await page.keyboard.down('KeyW');await page.waitForTimeout(8000);await page.keyboard.up('KeyW');
  await page.waitForTimeout(3000);
  const state=await page.evaluate(()=>({stats:NMS.stats(),water:NMS.waterState(0),profile:NMS._pipeline.performanceSnapshot(),
    position:NMS._internals.nav.pos.toArray(),gl:NMS._renderer.getContext().getError(),lost:NMS._renderer.getContext().isContextLost(),events:__waterWorkerLost}));
  await page.screenshot({path:`${out}/cloud-player.png`,timeout:90000});
  await page.evaluate(()=>{NMS._pipeline.stopProfiling();NMS.teleport(0,3);});
  await page.waitForFunction(()=>!NMS.waterState(0)?.near?.worker,null,{timeout:30000});
  const hidden=await page.evaluate(()=>NMS.waterState(0)?.near);
  const after=await evidenceFingerprint('tools/waterworkercloudtest.js');
  const report={...before,reference,checkpoints,initial,state,hidden,errors,stableSource:before.sourceDigest===after.sourceDigest&&before.verifierDigest===after.verifierDigest,
    boundary:'720p Balanced, normal HUD/post, default clouds on, far flora disabled. Controlled 350 m relocation and 8 s W integration only; does not replace 1080p 150 m/s input/CPU-contact gates or full 2K cloud acceptance.'};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,near:state.water.near,gl:state.gl,lost:state.lost,errors,stableSource:report.stableSource}));
  assert.ok(report.stableSource);assert.deepEqual(errors,[]);assert.equal(state.gl,0);assert.equal(state.lost,false);assert.equal(state.events,0);
  assert.ok(checkpoints.every(p=>p.gl===0&&!p.lost),'Earlier GL errors must not be erased by checkpoints');
  if(!reference){assert.equal(state.water.near.workerError,null);assert.ok(state.water.near.worker);}
  assert.ok(!hidden.worker);assert.equal(hidden.pending,false);
  await context.close();
} catch(error) {
  const state=await page?.evaluate(()=>({stats:window.NMS?.stats?.(),water:window.NMS?.waterState?.(0),
    gl:window.NMS?._renderer?.getContext().getError(),lost:window.NMS?._renderer?.getContext().isContextLost(),events:window.__waterWorkerLost})).catch(captureError=>({captureError:String(captureError)}));
  await page?.screenshot({path:`${out}/failure-player.png`,timeout:30000}).catch(()=>{});
  await writeFile(`${out}/failure.json`,JSON.stringify({...before,reference,checkpoints,state,errors,error:String(error)},null,2));
  console.error(JSON.stringify({out,state,errors,error:String(error)}));
  throw error;
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
