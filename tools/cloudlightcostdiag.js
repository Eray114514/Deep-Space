// Attribution only: selectively suppress uncached physical paths. These
// deliberately incorrect radiance variants must never become runtime options.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const out='test-results/cloud-light-cost',before=await evidenceFingerprint('tools/cloudlightcostdiag.js');
const {server,port}=await startServer(0);let browser;
const errors=[],scenarios=[];
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>{NMS.setAdaptiveQualityLocked(true);});
  console.log('Normal lowflight booted; isolating uncached solar and radial beams.');
  for(const [label,mask] of [['production',null],['all-paths',15],['no-fallback',0],
    ['solar-fallback-only',3],['radial-fallback-only',12],['all-paths-repeat',15],['production-repeat',null]]) {
    await page.evaluate(mask=>{
      const p=NMS._pipeline.volumePass.activePlanet;
      if(!window.__lightCost) {
        const original=p.volCloudMat,probe=original.clone();
        probe.uniforms={...original.uniforms,uDiagnosticFallbackMask:{value:15}};
        const call='if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
        if(!probe.fragmentShader.includes(call))throw Error('Physical fallback call changed; update the diagnostic');
        probe.fragmentShader=probe.fragmentShader.replace('vec3 cloudCombinedSource(',
          'uniform int uDiagnosticFallbackMask;\nvec3 cloudCombinedSource(').replace(call,
          'if(!cached && (uDiagnosticFallbackMask & (1 << path))!=0)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);');
        probe.needsUpdate=true;window.__lightCost={p,original,probe};
      }
      const {original,probe}=window.__lightCost;
      probe.uniforms.uDiagnosticFallbackMask.value=mask??15;p.volCloudMat=mask===null?original:probe;
      p.volCloudMesh.material=p.volCloudMat;NMS._pipeline.volumePass.historyValid=false;
      NMS._pipeline.startProfiling({every:1,history:80});
    },mask);
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=28,null,{timeout:180000});
    const data=await page.evaluate(()=>({profile:NMS._pipeline.performanceSnapshot(),pose:NMS.referenceState(),
      volume:NMS.volumeState(),gl:NMS._renderer.getContext().getError()}));
    if(mask===null)await page.screenshot({path:`${out}/${label}.png`});
    scenarios.push({label,mask,...data});
    const times=data.profile.records.filter(v=>v.frame>8 && v.name.includes('Volumetric')&&v.gpuMs!==null)
      .map(v=>v.gpuMs).sort((a,b)=>a-b);
    console.log(JSON.stringify({label,samples:times.length,p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)]}));
  }
  await page.evaluate(()=>{
    const {p,original,probe}=window.__lightCost;p.volCloudMat=original;p.volCloudMesh.material=original;
    NMS._pipeline.stopProfiling();NMS._pipeline.volumePass.historyValid=false;probe.dispose();delete window.__lightCost;
  });
  const after=await evidenceFingerprint('tools/cloudlightcostdiag.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,scenarios,errors,
    scope:'Frozen 1280x720 Balanced, same player composition and density/quantile traversal. Mask bits keep uncached physical paths: 0/1 solar, 2/3 radial. Cached paths and air stay enabled. Suppressed-path radiance is deliberately wrong. Differences are non-additive attribution, not a shipped optimization, quality gate or full-frame speedup. Screenshots show production only.'},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  for(const s of scenarios) {
    assert.equal(s.gl,0);assert.equal(s.volume.sunlightCacheReady,1);
    assert.ok(s.profile.records.some(v=>v.frame>8 && v.name.includes('Volumetric') && v.gpuMs>0));
  }
  console.log(`PASS attribution health; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
