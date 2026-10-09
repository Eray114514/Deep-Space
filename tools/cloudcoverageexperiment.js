// Test a wider four-field footprint without coarsening the 100 m / 50 m grid.
// This is an experiment, not a production configuration or an acceptance gate.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
import {probeCloudLightSupport} from './cloud-light-support-browser.js';

const out='test-results/cloud-coverage',before=await evidenceFingerprint('tools/cloudcoverageexperiment.js');
const {server,port}=await startServer(0);let browser;
const errors=[],scenarios=[];
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}});
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=balanced&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>NMS.setAdaptiveQualityLocked(true));
  console.log('Production lowflight booted; comparing 128 / 256 / 128 footprints.');
  for(const size of [128,256,128]) {
    const setup=await page.evaluate(async size=>{
      const {CloudLightBank}=await import('/src/cloud/cloud-light-bank.js');
      const pipeline=NMS._pipeline,p=pipeline.volumePass.activePlanet,r=NMS._renderer,gl=r.getContext();
      pipeline.stopProfiling();pipeline.cloudLightBanks.get(p)?.dispose();
      const started=performance.now(),bank=new CloudLightBank(p,{size});
      pipeline.cloudLightBanks.set(p,bank);p.cloudLightBank=bank;bank.update(r);
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      return {size,spacing:bank.spacing,depth:bank.depth,intervalHours:bank.interval,
        residentBytes:bank.target.width*bank.target.height,bootstrapCpuMs:performance.now()-started,
        target:[bank.target.width,bank.target.height],maxTextureSize:gl.getParameter(gl.MAX_TEXTURE_SIZE),
        gpu:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null};
    },size);
    await page.evaluate(()=>NMS._pipeline.startProfiling({every:1,history:100}));
    await page.waitForFunction(()=>NMS._pipeline.performanceSnapshot().frame>=36,null,{timeout:180000});
    const profile=await page.evaluate(()=>({profile:NMS._pipeline.performanceSnapshot(),
      pose:NMS.referenceState(),volume:NMS.volumeState(),gl:NMS._renderer.getContext().getError()}));
    const index=scenarios.length;
    await page.screenshot({path:`${out}/player-${index}-${size}.png`});
    await page.evaluate(()=>NMS._pipeline.stopProfiling());
    const support=await probeCloudLightSupport(page),fields=[];
    for(let field=0;field<4;field++)fields.push(await probeCloudLightSupport(page,{field}));
    const physical=await page.evaluate(async()=>{
      const {compareCloudLight}=await import('/tools/b4-light-continuity-browser.js');
      const p=NMS._planet(0),radial=p.cloudLightBank.center.clone().normalize(),layers=[];
      // The cache's central plane can be clear. Probe the same physical
      // footprint/heights for both sizes, including occupied distant cells.
      for(const height of [500,1500,3000,6000,10000,20000]) {
        const rows=await compareCloudLight({center:radial.clone().multiplyScalar(p.R+height).toArray(),extent:40000});
        layers.push({height,points:rows.records.length,occupied:rows.occupied,
          occupiedSourceError:rows.occupied?Math.max(...rows.records.filter(v=>v.extinction>.0001).map(v=>v.error)):null,
          combinationError:Math.max(...rows.records.flatMap(v=>v.full.map((n,i)=>Math.abs(n-v.combinedFull[i]))))});
      }
      return {layers,occupied:layers.reduce((n,v)=>n+v.occupied,0),
        occupiedSourceError:Math.max(...layers.filter(v=>v.occupied).map(v=>v.occupiedSourceError)),
        combinationError:Math.max(...layers.map(v=>v.combinationError))};
    });
    scenarios.push({setup,...profile,support,fields,physical,screenshot:`player-${index}-${size}.png`});
    console.log(JSON.stringify({setup,missRatio:support.missRatio,physical}));
  }
  const after=await evidenceFingerprint('tools/cloudcoverageexperiment.js');
  await writeFile(`${out}/report.json`,JSON.stringify({before,after,scenarios,errors,
    scope:'One real GPU, frozen 1280x720 Balanced HUD/post, 128/256/128 same page. Wider grid keeps physical spacing. Counter shaders suppress missed beams only for support counts. Production timing/screenshots and physical point probes retain the fallback. No dynamic deadline, 2K, continuous-flight or visual acceptance.'},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);
  for(const s of scenarios) {
    assert.equal(s.gl,0);assert.equal(s.support.gl,0);assert.ok(s.support.occupied>1000);
    assert.equal(s.setup.spacing,100);assert.equal(s.physical.combinationError,0);assert.ok(s.physical.occupied>16);
    assert.ok(s.profile.records.some(r=>r.name.includes('Volumetric')&&r.gpuMs>0));
  }
  console.log(`PASS experiment integrity; candidate accuracy, memory and timing are findings, not waived gates: ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
