// The consumer must retain physical light paths when the cache is unavailable.
// This checks the real compiled combination, not only each helper in isolation.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
const before=await evidenceFingerprint('tools/b4lightcontinuitytest.js');
const oldCallControl=process.argv.includes('--old-call-control');
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction('window.NMS?.booted',null,{timeout:180000});
  console.log('Game booted; preparing the actual near-cloud light bank.');
  await page.evaluate(()=>NMS.setAtmosphereAltitude(0,3000,
    {dir:[-.7817630820403421,.6181640625,.08197362619941498],pitch:-1.1}));
  await page.waitForFunction(()=>NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value>.5,null,{timeout:180000});
  console.log('Light bank ready; comparing compiled source and independent path calls.');
  const result=await page.evaluate(async oldCallControl=>{
    const {compareCloudLight}=await import('/tools/b4-light-continuity-browser.js');
    const current=await compareCloudLight(),control=oldCallControl?await compareCloudLight({badControl:true}):null;
    const p=NMS._planet(0),bank=p.cloudLightBank,stream=p.weatherStream;
    const {CloudLightBank}=await import('/src/cloud/cloud-light-bank.js');
    const originalCreate=CloudLightBank.prototype.create;
    const snapshots={maxPending:0,maxRetainedBytes:0,creations:0};
    CloudLightBank.prototype.create=function(...args) {
      const result=originalCreate.apply(this,args);
      if(this.planet===p && result) {
        snapshots.creations++;
        const pending=[...this.maps.values()].filter(cache=>!cache.ready);
        snapshots.maxPending=Math.max(snapshots.maxPending,pending.length);
        snapshots.maxRetainedBytes=Math.max(snapshots.maxRetainedBytes,pending.reduce((n,cache)=>
          n+cache.snapshots.reduce((bytes,t)=>bytes+t.image.data.byteLength,0),0));
      }
      return result;
    };
    const hours=bank.maps.values().next().value.weatherSources.frames[0].hours;
    const forecast=stream.frames.get(hours);
    if(!forecast)throw Error('Snapshot source is unavailable for replacement control');
    // Replace identity with identical bytes. This must invalidate the snapshot,
    // rebuild it through the actual pipeline and preserve physical consumers.
    stream.frames.set(hours,{...forecast});stream.update(p.weatherHours,true);
    const invalidated=bank.needsReset();
    try {NMS._pipeline.updateCloudLighting();} finally {CloudLightBank.prototype.create=originalCreate;}
    const replacement={invalidated,oldDisposed:bank.disposed,
      changed:p.cloudLightBank!==bank,ready:p.volCloudMat.uniforms.uSunCacheReady.value};
    const rebuilt=await compareCloudLight();
    return {current,control,replacement,snapshots,rebuilt,glError:NMS._renderer.getContext().getError()};
  },oldCallControl);
  const difference=records=>Math.max(...records.flatMap(r=>r.full.map((v,i)=>Math.abs(v-r.combinedFull[i]))));
  const metrics={cases:result.current.records.length,occupied:result.current.occupied,
    combinationDepthError:difference(result.current.records),
    oldCallDepthError:result.control?difference(result.control.records):null,
    occupiedSourceCacheError:Math.max(...result.current.records.filter(r=>r.extinction>.0001).map(r=>r.error))};
  await mkdir('test-results/b4-light-continuity',{recursive:true});
  const after=await evidenceFingerprint('tools/b4lightcontinuitytest.js');
  metrics.rebuiltCombinationDepthError=difference(result.rebuilt.records);
  metrics.rebuiltSourceCacheError=Math.max(...result.rebuilt.records.filter(r=>r.extinction>.0001).map(r=>r.error));
  await writeFile('test-results/b4-light-continuity/report.json',JSON.stringify({fingerprint:before,after,metrics,result,errors},null,2));
  console.log(JSON.stringify({metrics,glError:result.glError,errors},null,2));
  assert.deepEqual(errors,[]);assert.equal(result.glError,0);assert.ok(metrics.occupied>16);
  assert.ok(metrics.combinationDepthError<.0001,'Compiled source lost fallback optical depth');
  assert.ok(metrics.occupiedSourceCacheError<.05,'The live cache changed occupied-point source radiance');
  assert.equal(before.sourceDigest,after.sourceDigest);
  assert.deepEqual(result.replacement,{invalidated:true,oldDisposed:true,changed:true,ready:1});
  assert.equal(result.snapshots.maxPending,1);assert.equal(result.snapshots.creations,2);
  assert.ok(result.snapshots.maxRetainedBytes>1000000);
  assert.ok(metrics.rebuiltCombinationDepthError<.0001);
  assert.ok(metrics.rebuiltSourceCacheError<.05);
  // ANGLE-specific old-call reproduction is reported, rather than required on
  // drivers which compile that legal GLSL call correctly.
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
