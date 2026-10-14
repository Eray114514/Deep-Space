// Bounded exact-query pages with a complete cached path and complete original
// transport on overflow. Synchronous mask readback remains tool-only.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const caseName=process.argv.find(arg=>arg.startsWith('--case='))?.slice(7)||'lowflight';
assert.ok(['lowflight','lowflight-2k','near-cloud'].includes(caseName),'Unknown query scenario');
const viewport=caseName==='lowflight-2k'?{width:2560,height:1440}:{width:1280,height:720};
const quality=caseName==='near-cloud'?'ultra':'balanced';
const budgetMiB=Number(process.argv.find(arg=>arg.startsWith('--budget='))?.slice(9)??64);
const beamBytes=process.argv.includes('--half')?2:4;
const jitterFrame=Number(process.argv.find(arg=>arg.startsWith('--jitter='))?.slice(9)??0);
const out=`test-results/cloud-light-batch/${caseName}-${budgetMiB}-${beamBytes}-${jitterFrame}`,before=await evidenceFingerprint('tools/cloudlightbatchtest.js');
const dependencies=['tools/cloud-light-batch-browser.js'];
const helperBefore=await Promise.all(dependencies.map(file=>evidenceFingerprint(file)));
const {server,port}=await startServer(0);let browser;
const errors=[];await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  const page=await browser.newPage({viewport});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());else if(m.text().startsWith('Page:'))console.log(m.text());});
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=${quality}&vclouds=1&post=1`);
  await page.waitForFunction(()=>NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>NMS.setAdaptiveQualityLocked(true));
  if(caseName==='near-cloud')await page.evaluate(()=>NMS.setAtmosphereAltitude(0,3000,
    {dir:[-.7817630820403421,.6181640625,.08197362619941498],pitch:-1.1}));
  console.log('Page: production booted; waiting for actual near-light endpoints.');
  await page.waitForFunction(()=>NMS._pipeline.volumePass.activePlanet===NMS._planet(0)
    && NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  await page.evaluate(()=>new Promise(resolve=>{
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass;
    const target=new T.WebGLRenderTarget(r.domElement.width,r.domElement.height,
      {type:T.FloatType,format:T.RedFormat,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const material=new T.ShaderMaterial({uniforms:{tDepth:{value:null}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tDepth;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tDepth,vUV).r,0,0,1);}',depthTest:false,depthWrite:false});
    scene.add(new T.Mesh(geometry,material));const original=vp.render;
    vp.render=function(renderer,writeBuffer,readBuffer) {
      vp.render=original;const saved=r.getRenderTarget(),auto=r.autoClear;
      material.uniforms.tDepth.value=vp.sceneDepthSource?.sceneDepthTexture||readBuffer.depthTexture;
      if(!material.uniforms.tDepth.value)throw Error('Actual volume depth is unavailable');
      try {r.autoClear=true;r.setRenderTarget(target);r.render(scene,camera);}
      finally {r.setRenderTarget(saved);r.autoClear=auto;geometry.dispose();material.dispose();}
      NMS._queryDepth=target;const result=original.apply(this,arguments);resolve();return result;
    };
  }));
  await page.screenshot({path:`${out}/player.png`});
  const player=await page.evaluate(()=>({pose:NMS.referenceState(),volume:NMS.volumeState(),stats:NMS.stats()}));
  assert.equal(player.volume.representation,'near-volume','Prototype must exercise the actually selected near representation');
  const result=await page.evaluate(async options=>{
    const {probeLightBatches}=await import('/tools/cloud-light-batch-browser.js');return probeLightBatches(options);
  },{budgetBytes:budgetMiB*1024*1024,beamBytes,jitterFrame}).catch(error=>{console.error(errors.map(e=>e.slice(0,5000)));throw error;});
  assert.equal(result.forbiddenCalls,0,'No readback/wait may occur in batch submission');
  const after=await evidenceFingerprint('tools/cloudlightbatchtest.js');
  const helperAfter=await Promise.all(dependencies.map(file=>evidenceFingerprint(file)));
  await writeFile(`${out}/report.json`,JSON.stringify({caseName,viewport,quality,before,after,helperBefore,helperAfter,player,result,errors},null,2));
  for(let i=0;i<helperBefore.length;i++)assert.equal(helperBefore[i].verifierDigest,helperAfter[i].verifierDigest);
  assert.equal(before.verifierDigest,after.verifierDigest);
  assert.equal(before.sourceDigest,after.sourceDigest);assert.deepEqual(errors,[]);assert.equal(result.gl,0);
  assert.equal(result.inputsChanged,false,'Camera, geometry and common physical inputs must stay fixed');
  assert.ok(result.occupied>1000);
  assert.equal(result.comparison.alphaChanged,0);
  assert.ok(result.comparison.maximumError<.002,'Paged transport must preserve physical radiance');
  if(beamBytes===4)assert.equal(result.comparison.maximumError,0,'R32F exact-query paging must match reference HDR');
  assert.ok(result.plan.residentBytes<=result.budgetBytes,'Actual padded intermediate texture allocations must fit');
  assert.ok(result.badFieldsControl.maximumError>.002,'Wrong light fields must fail the same radiance gate');
  if(caseName!=='near-cloud'&&!result.plan.direct)assert.ok(result.badCachedControl.maximumError>.002,'Lowflight must require uncached beams');
  for(const record of result.records)assert.equal(record.nativeRepeatChanged,0,'Each implementation must repeat exactly');
  console.log(`PASS scoped numerical/repeat gates; performance and representation are findings: ${out}`);
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
