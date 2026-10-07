import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
import {probeCloudLightSupport} from './cloud-light-support-browser.js';
const out='test-results/cloud-scope',before=await evidenceFingerprint('tools/cloudscopediag.js');
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});
const errors=[],scenarios=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  const inventory=await page.evaluate(()=>{
    const bodies=[];NMS._internals.scene.traverse(m=>{
      const p=m.material?.uniforms?.uSunCacheReady?NMS._pipeline.volumePass?.activePlanet:null;
      if(m.layers.mask!==4||!m.isMesh)return;
      const previous=m.onBeforeRender;m.userData.scopeDraws=0;
      m.onBeforeRender=function(...args){this.userData.scopeDraws++;previous.apply(this,args);};
      bodies.push({name:m.name,id:m.uuid,active:m===p?.volCloudMesh,position:m.position.toArray(),
        camera:m.material?.uniforms?.uCameraLocal?.value.toArray(),far:m.material?.defines?.CLOUD_FAR_VIEW,
        depth:m.material?.uniforms?.uDepthReady?.value});
    });
    NMS.setAdaptiveQualityLocked(true);return bodies;
  });
  for(const mode of process.argv.includes('--support-only')?['all']:['all','active-only','all']) {
    await page.evaluate(mode=>{
      const active=NMS._pipeline.volumePass.activePlanet;
      NMS._internals.scene.traverse(m=>{
        if(m.layers.mask!==4||!m.isMesh)return;
        m.visible=mode==='all'||m===active.volCloudMesh;m.userData.scopeDraws=0;
      });
      NMS._pipeline.startProfiling({every:1,history:100});
    },mode);
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=16,null,{timeout:180000});
    scenarios.push(await page.evaluate(mode=>{
      const draws=[];NMS._internals.scene.traverse(m=>{if(m.layers.mask===4&&m.isMesh)draws.push({id:m.uuid,count:m.userData.scopeDraws});});
      return {mode,profile:NMS._pipeline.performanceSnapshot(),draws,gl:NMS._renderer.getContext().getError()};
    },mode));
    console.log(mode,JSON.stringify(scenarios.at(-1).draws));
  }
  await page.screenshot({path:`${out}/player.png`});
  const support=await probeCloudLightSupport(page);console.log('Support',JSON.stringify(support));
  const fields=[];
  if(process.argv.includes('--fields'))for(let field=0;field<4;field++) {
    fields.push(await probeCloudLightSupport(page,{field}));console.log('Field',JSON.stringify(fields.at(-1)));
  }
  const after=await evidenceFingerprint('tools/cloudscopediag.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,inventory,scenarios,support,fields,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  for(const s of scenarios)assert.equal(s.gl,0);
  assert.equal(support.gl,0);assert.ok(support.queries>0);assert.ok(support.misses>=0&&support.misses<=support.queries);
  for(const field of fields) {
    assert.equal(field.gl,0);assert.ok(field.occupied>1000&&field.queries>0);
    assert.ok(field.misses>=0&&field.misses<=field.queries);
  }
  console.log(`PASS: cloud draw scope attribution; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
