// Real module worker vs frozen 93e934f main-thread geometry. No frame-rate claim.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const out=`test-results/water-worker/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const fingerprint=await evidenceFingerprint('tools/waterworkerplaytest.js');
const original=execFileSync('git',['show','93e934f:src/near-water-patch.js'],{encoding:'utf8'});
const {server,port}=await startServer(0);
const browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
const errors=[];
try {
  const page=await browser.newPage();
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/water-worker-fixture.html',route=>route.fulfill({contentType:'text/html',body:
    '<script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'}));
  await page.route('**/water-original.js',route=>route.fulfill({contentType:'text/javascript',body:original}));
  await page.goto(`http://127.0.0.1:${port}/water-worker-fixture.html`);
  const result=await page.evaluate(async()=>{
    const T=await import('three');
    const {Planet}=await import('/src/planet.js');
    const {NearWaterPatch}=await import('/src/near-water-patch.js');
    const {NearWaterPatch:Original}=await import('/water-original.js');
    const {generateSystemSpec}=await import('/src/astronomy.js');
    const {GalaxyCatalog,HOME_SYSTEM_ID}=await import('/src/galaxy-layout.js');
    const {getGalaxyConfig,resolveBodyTuning}=await import('/src/world-config.js');
    const galaxy=getGalaxyConfig(),catalog=new GalaxyCatalog(galaxy.seed);
    const system=generateSystemSpec(galaxy.seed,catalog.getSystem(HOME_SYSTEM_ID));
    const body=system.bodies.find(b=>b.bodyId==='planet-0');
    const planet=new Planet({...body,posUniv:new T.Vector3(),tuning:resolveBodyTuning({
      galaxyId:galaxy.id,seed:galaxy.seed,systemId:system.systemId,bodyId:body.bodyId})});
    const material=new T.MeshBasicMaterial(),runs=[];
    for(const [cells,radius,d] of [[32,6000000,[1,2,-3]],[64,20000000,[.00001,1,-.00001]],
      [512,planet.seaRadius,[.34669147556655305,.07291666666666663,-.9351407276403421]]]) {
      const owner=Object.assign(Object.create(planet),{seaRadius:radius,group:new T.Group()});
      const original=new Original(owner,material,{cells});
      const patch=new NearWaterPatch(owner,material,{cells});
      const dir=new T.Vector3(...d).normalize();
      original._begin(dir);while(original.build)original._buildRows(Infinity);
      const started=performance.now();let heartbeats=0;
      const heartbeat=setInterval(()=>heartbeats++,10);
      patch._begin(dir);
      try {
        while(!patch.build?.ready) {
          if(patch.workerError)throw Error(patch.workerError);
          if(performance.now()-started>30000)throw Error('Worker completion deadline');
          await new Promise(resolve=>setTimeout(resolve,10));
        }
        const before=patch.mesh.geometry;
        patch._buildRows(0);
        if(patch.mesh.geometry!==before)throw Error('Published without grant');
        const commit=performance.now();patch._buildRows(4);
        const commitMs=performance.now()-commit;
        let bytes=0;
        for(const [key,attribute]of Object.entries(original.mesh.geometry.attributes)) {
          const expected=new Uint8Array(attribute.array.buffer),actual=new Uint8Array(patch.mesh.geometry.attributes[key].array.buffer);
          if(expected.length!==actual.length)throw Error(`Length ${key}`);
          for(let i=0;i<expected.length;i++)if(expected[i]!==actual[i])throw Error(`${cells} ${key} byte ${i}`);
          bytes+=actual.length;
        }
        runs.push({cells,radius,bytes,heartbeats,wallMs:performance.now()-started,
          workerCpuMs:patch.lastWorkerCpuMs,workerWallMs:patch.lastWorkerWallMs,commitMs,
          zeroGrantHeld:true,byteExact:true});
      } finally {clearInterval(heartbeat);original.dispose();patch.dispose();}
    }
    material.dispose();return {runs};
  });
  const finalFingerprint=await evidenceFingerprint('tools/waterworkerplaytest.js');
  const report={...fingerprint,...result,errors,reference:'93e934f',
    referenceSha256:createHash('sha256').update(original).digest('hex'),
    stableSource:finalFingerprint.sourceDigest===fingerprint.sourceDigest
      &&finalFingerprint.verifierDigest===fingerprint.verifierDigest};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({out,...result,errors,stableSource:report.stableSource},null,2));
  assert.ok(report.stableSource);assert.deepEqual(errors,[]);
  assert.ok(result.runs.every(r=>r.byteExact&&r.heartbeats>0));
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
