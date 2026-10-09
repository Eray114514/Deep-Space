// Attribution only: selectively suppress uncached physical paths. These
// deliberately incorrect radiance variants must never become runtime options.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const airStudy=process.argv.includes('--air');
const residual=airStudy||process.argv.includes('--residual');
const out=airStudy?'test-results/cloud-air-cost':residual?'test-results/cloud-residual-cost':'test-results/cloud-light-cost';
const before=await evidenceFingerprint('tools/cloudlightcostdiag.js');
const {server,port}=await startServer(0);let browser;
const errors=[],scenarios=[];
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  if(airStudy) {
    const previous=execFileSync('git',['show','ec966fa:src/atmosphere-transport-glsl.js'],{encoding:'utf8'});
    await page.route('**/src/atmosphere-cost-reference.js',r=>r.fulfill({contentType:'text/javascript',body:previous}));
  }
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>{NMS.setAdaptiveQualityLocked(true);});
  console.log('Normal lowflight booted; isolating uncached solar and radial beams.');
  const modes=airStudy?[['production',null],['no-fallback-current',0],['no-fallback-old-air',0,0,0,0,1],
    ['no-fallback-no-gap-kernel',0,0,2],['no-fallback-no-advance-kernel',0,0,3],
    ['no-fallback-current-repeat',0],['no-fallback-old-air-repeat',0,0,0,0,1],['production-repeat',null]]:
    residual?[['production',null],['no-fallback',0],['no-fallback-no-cache',0,1],
    ['no-fallback-no-air',0,0,1],['density-quantiles-only',0,1,1,1],
    ['no-fallback-repeat',0],['production-repeat',null]]:
    [['production',null],['all-paths',15],['no-fallback',0],
      ['solar-fallback-only',3],['radial-fallback-only',12],['all-paths-repeat',15],['production-repeat',null]];
  for(const [label,mask,noCache=0,noAir=0,noSource=0,oldAir=0] of modes) {
    await page.evaluate(async({mask,noCache,noAir,noSource,oldAir,residual})=>{
      const p=NMS._pipeline.volumePass.activePlanet;
      if(!window.__lightCost) {
        const original=p.volCloudMat,probe=original.clone();
        probe.uniforms={...original.uniforms,uDiagnosticFallbackMask:{value:15}};
        const call='if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
        if(!probe.fragmentShader.includes(call))throw Error('Physical fallback call changed; update the diagnostic');
        probe.fragmentShader=probe.fragmentShader.replace('vec3 cloudCombinedSource(',
          'uniform int uDiagnosticFallbackMask;\nvec3 cloudCombinedSource(').replace(call,
          'if(!cached && (uDiagnosticFallbackMask & (1 << path))!=0)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);');
        probe.needsUpdate=true;window.__lightCost={p,original,probe,variants:new Map()};
      }
      const {original,probe,variants}=window.__lightCost;
      let selected=probe;
      if(residual && mask!==null) {
        const key=[noCache,noAir,noSource,oldAir].join(':');
        if(!variants.has(key)) {
          const material=original.clone();material.uniforms=original.uniforms;
          const replace=(from,to)=>{
            if(!material.fragmentShader.includes(from))throw Error('Cost diagnostic drift: '+from);
            material.fragmentShader=material.fragmentShader.replace(from,to);
          };
          replace('if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);','');
          if(noCache)replace('bool cached=cloudCachedLight(local,path,pathDepth);','bool cached=false;');
          if(oldAir) {
            const {cloudAtmosphereGLSL:current}=await import('/src/atmosphere-transport-glsl.js');
            const {cloudAtmosphereGLSL:previous}=await import('/src/atmosphere-cost-reference.js');
            if(!material.fragmentShader.includes(current))throw Error('Air transport prefix changed');
            material.fragmentShader=material.fragmentShader.replace(current,previous);
          }
          if(noAir===1||noAir===2)replace('if (air_uEnabled < 0.5 || b <= a) return;', 'if (true) return;');
          if(noAir===1||noAir===3)replace('if(air_uEnabled<0.5 || b<=a)return;', 'if(true)return;');
          if(noSource) {
            const start=material.fragmentShader.indexOf('vec3 cloudCombinedSource(');
            if(start<0)throw Error('Cost diagnostic source function changed');
            const brace=material.fragmentShader.indexOf('{',start);let end=brace+1,depth=1;
            while(depth && end<material.fragmentShader.length) {
              const c=material.fragmentShader[end++];if(c==='{')depth++;if(c==='}')depth--;
            }
            if(depth)throw Error('Unterminated source function');
            // Depend on the interaction position so the compiler must retain
            // the quantile traversal even though physical lighting is gone.
            material.fragmentShader=material.fragmentShader.slice(0,brace)+
              '{return local/uBodyR;}'+material.fragmentShader.slice(end);
          }
          material.needsUpdate=true;variants.set(key,material);
        }
        selected=variants.get(key);
      }
      probe.uniforms.uDiagnosticFallbackMask.value=mask??15;p.volCloudMat=mask===null?original:selected;
      p.volCloudMesh.material=p.volCloudMat;NMS._pipeline.volumePass.historyValid=false;
      NMS._pipeline.startProfiling({every:1,history:80});
    },{mask,noCache,noAir,noSource,oldAir,residual});
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=28,null,{timeout:180000});
    const data=await page.evaluate(()=>({profile:NMS._pipeline.performanceSnapshot(),pose:NMS.referenceState(),
      volume:NMS.volumeState(),gpu:NMS.stats().gpu,air:Object.fromEntries(
        ['air_uEnabled','air_uViewSteps','air_uMieScaleHeight','air_uRayleighScaleHeight','air_uLocalOccluderCount']
          .map(name=>[name,NMS._pipeline.volumePass.activePlanet.volCloudMat.uniforms[name]?.value])),
      gl:NMS._renderer.getContext().getError()}));
    if(mask===null)await page.screenshot({path:`${out}/${label}.png`});
    scenarios.push({label,mask,noCache,noAir,noSource,oldAir,...data});
    const times=data.profile.records.filter(v=>v.frame>8 && v.name.includes('Volumetric')&&v.gpuMs!==null)
      .map(v=>v.gpuMs).sort((a,b)=>a-b);
    console.log(JSON.stringify({label,samples:times.length,p50:times[Math.floor(times.length*.5)],p95:times[Math.floor(times.length*.95)]}));
  }
  await page.evaluate(()=>{
    const {p,original,probe,variants}=window.__lightCost;p.volCloudMat=original;p.volCloudMesh.material=original;
    NMS._pipeline.stopProfiling();NMS._pipeline.volumePass.historyValid=false;probe.dispose();
    for(const material of variants.values())material.dispose();delete window.__lightCost;
  });
  const after=await evidenceFingerprint('tools/cloudlightcostdiag.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,scenarios,errors,
    residual,airStudy,reference:airStudy?'ec966fa':null,scope:'Frozen 1280x720 Balanced, same player composition and density/quantile traversal. Mask bits keep uncached physical paths: 0/1 solar, 2/3 radial. Residual mode uses separate static variants to remove cache queries, view-air integration, or all cloud source evaluation. noAir 1 disables both view air kernels, 2 gap only, 3 advance only. Source-air LUTs remain enabled. Air study substitutes the independent ec966fa LUT shader on the same page. Position-dependent diagnostic source preserves quantile anchors. Suppressed radiance is deliberately wrong. Program compilation/optimization differs: differences are non-additive attribution, not independent costs, a shipped optimization, quality gate or full-frame speedup. Screenshots show production only.'},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  for(const s of scenarios) {
    assert.equal(s.gl,0);assert.equal(s.volume.sunlightCacheReady,1);
    assert.ok(s.profile.records.filter(v=>v.frame>8 && v.name.includes('Volumetric') && v.gpuMs>0).length>=14,
      'Need at least 14 completed warm GPU samples');
  }
  console.log(`PASS attribution health; ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
