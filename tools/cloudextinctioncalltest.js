// Compare the complete original/new near-cloud draw on frozen real inputs.
// Diagnostic GPU waits are outside runtime submission and never ship.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const caseName=process.argv.find(x=>x.startsWith('--case='))?.slice(7)||'lowflight';
const quality=process.argv.find(x=>x.startsWith('--quality='))?.slice(10)||'balanced';
const warmRounds=Number(process.argv.find(x=>x.startsWith('--warm-rounds='))?.slice(14)??3);
const experimental=process.argv.includes('--experimental-call');
const productionExtinctionControl=process.argv.includes('--production-extinction-control');
const starLoopControl=process.argv.includes('--star-loop-control');
assert.ok(['lowflight','near-cloud','lowflight-2k'].includes(caseName));
assert.ok(['performance','balanced','ultra'].includes(quality));
assert.ok([experimental,productionExtinctionControl,starLoopControl].filter(Boolean).length<=1,'Choose one cloud program control');
assert.ok(Number.isSafeInteger(warmRounds)&&warmRounds>=3&&warmRounds<=20,
  '--warm-rounds must be an integer from 3 to 20');
const viewport=caseName==='lowflight-2k'?{width:2560,height:1440}:{width:1280,height:720};
const out=`test-results/cloud-extinction-call/${caseName}-${quality}-${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const before=await evidenceFingerprint('tools/cloudextinctioncalltest.js');
const helperBefore=await evidenceFingerprint('tools/cloud-extinction-call-browser.js');
const reference='bc340db',referenceSource=execFileSync('git',['show',`${reference}:src/clouds-webgl.js`],{encoding:'utf8'});
const referenceDigest=createHash('sha256').update(referenceSource).digest('hex');
const oldWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        if (uLocalBands < 0.5) return densityAt(local) * legacySigma;
        vec2 layers = cloudLayersAt(local);
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
      }`;
const sharedWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        vec2 layers = cloudLayersAt(local);
        if (uLocalBands < 0.5) return max(layers.x, layers.y * 0.06) * legacySigma;
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
      }`;
const specializedWrapper=`      float cloudExtinctionAt(vec3 local, float legacySigma) {
        #if PRODUCTION_CLOUD_MEDIUM == 1
        vec2 layers = cloudLayersAt(local);
        return layers.x * 0.025 + layers.y * 0.0006;
        #else
        if (uLocalBands < 0.5) return densityAt(local) * legacySigma;
        vec2 layers = cloudLayersAt(local);
        // Per-metre liquid and ice extinction. Condensate remains a separate
        // dimensionless field; the shell thickness cannot change this value.
        return layers.x * 0.025 + layers.y * 0.0006;
        #endif
      }`;
const runtimeSource=await readFile('src/clouds-webgl.js','utf8');
const planetSource=await readFile('src/planet.js','utf8');
const ownershipInputs=[
  [runtimeSource,'defines: { PRODUCTION_CLOUD_MEDIUM: band.localWeather ? 1 : 0,'],
  [runtimeSource,'uLocalBands: { value: band.localWeather ? 1 : 0 }'],
  [planetSource.replace(/\r\n/g,'\n'),
    '        this.volCloudMat.uniforms.uLocalBands.value = this.weatherField.synoptic ? 1 : 0;\n'
    +'        this.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM = this.weatherField.synoptic ? 1 : 0;\n'
    +'        this.volCloudMat.needsUpdate = true;'],
];
for(const [source,expected] of ownershipInputs)
  assert.equal(source.split(expected).length-1,1,'Production/local-bands ownership contract changed');
const productionOwnershipInvariant={verified:true,
  relation:'The constructor derives PRODUCTION_CLOUD_MEDIUM and uLocalBands from band.localWeather; Planet.setWeatherFixture synchronizes both from weatherField.synoptic before needsUpdate.',
  requiredNearProduction:{PRODUCTION_CLOUD_MEDIUM:1,uLocalBands:1},
  legacyBranch:'This matrix exercises production near mode. Complete candidate-source reconstruction bounds the edit; it does not accept legacy fixture optics.',
  planetSourceDigest:createHash('sha256').update(planetSource).digest('hex')};
let experimentalSource=null;
let candidateKind=null,candidateModuleFile=null;
if(experimental) {
  assert.equal(runtimeSource.split(oldWrapper).length-1,1,'Expected one complete old extinction wrapper');
  experimentalSource=runtimeSource.replace(oldWrapper,sharedWrapper);
  candidateKind='shared-call';candidateModuleFile='experimental-clouds-webgl.js';
} else if(starLoopControl) {
  experimentalSource=runtimeSource;
  for(const [from,to] of [
    ['uLightPathCount: { value: 4 },','uLightPathCount: { value: 4 },\n      uCloudSourceCount: { value: 2 },'],
    ['uniform int uLightPathCount;','uniform int uLightPathCount;\n      uniform int uCloudSourceCount;'],
    ['for(int star=0;star<2;star++)','for(int star=0;star<uCloudSourceCount;star++)'],
  ]) {
    assert.equal(experimentalSource.split(from).length-1,1,'Star loop change must match once');
    experimentalSource=experimentalSource.replace(from,to);
  }
  candidateKind='uniform-star-loop';candidateModuleFile='uniform-star-loop-clouds-webgl.js';
} else if(productionExtinctionControl) {
  const matches=[oldWrapper,sharedWrapper].filter(wrapper=>runtimeSource.includes(wrapper));
  assert.equal(matches.length,1,'Expected exactly one explicitly supported extinction wrapper');
  assert.equal(runtimeSource.split(matches[0]).length-1,1,'Expected one complete extinction wrapper');
  experimentalSource=runtimeSource.replace(matches[0],specializedWrapper);
  assert.equal(experimentalSource.replace(specializedWrapper,matches[0]),runtimeSource,
    'Candidate changed more than the extinction wrapper');
  assert.equal(experimentalSource.replace(specializedWrapper,oldWrapper),referenceSource,
    'Complete candidate module cannot reconstruct frozen bc340db');
  candidateKind='production-specialized';candidateModuleFile='production-extinction-clouds-webgl.js';
}
const experimentalDigest=experimentalSource?createHash('sha256').update(experimentalSource).digest('hex'):null;
const candidateModule=experimentalSource?{kind:candidateKind,file:candidateModuleFile,sha256:experimentalDigest,
  productionOwnershipInvariant}:null;
if(experimentalSource) {
  if(candidateKind!=='uniform-star-loop')assert.equal(experimentalSource.split(candidateKind==='shared-call'?sharedWrapper:specializedWrapper).length-1,1);
  await writeFile(`${out}/${candidateModuleFile}`,experimentalSource);
  await writeFile(`${out}/candidate-module.json`,JSON.stringify(candidateModule,null,2));
}
await writeFile(`${out}/reference-clouds-webgl.js`,referenceSource);
const {server,port}=await startServer(0);let browser,page;const errors=[];
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());if(m.text().startsWith('Extinction call:'))console.log(m.text());});
  await page.route('**/src/clouds-view-reference.js',r=>r.fulfill({contentType:'text/javascript',body:referenceSource}));
  if(experimentalSource)await page.route('**/src/clouds-webgl.js',r=>r.fulfill({contentType:'text/javascript',body:experimentalSource}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&nolock=1&freeze=1&time=9.5&scene=lowflight&alt=400&planet=0&bias=meadow&quality=${quality}&vclouds=1&post=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>NMS.setAdaptiveQualityLocked(true));
  if(caseName==='near-cloud')await page.evaluate(()=>NMS.setAtmosphereAltitude(0,3000,
    {dir:[-.7817630820403421,.6181640625,.08197362619941498],pitch:-1.1}));
  await page.waitForFunction(()=>NMS._pipeline.volumePass.activePlanet===NMS._planet(0)
    &&NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value===1,null,{timeout:180000});
  // Snapshot actual opaque depth at the volume entry, before composer reuse.
  await page.evaluate(()=>new Promise(resolve=>{
    const T=NMS._THREE,r=NMS._renderer,vp=NMS._pipeline.volumePass;
    const target=new T.WebGLRenderTarget(r.domElement.width,r.domElement.height,
      {type:T.FloatType,format:T.RedFormat,depthBuffer:false,minFilter:T.NearestFilter,magFilter:T.NearestFilter});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const material=new T.ShaderMaterial({uniforms:{tDepth:{value:null}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tDepth;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tDepth,vUV).r,0,0,1);}',depthTest:false,depthWrite:false});
    scene.add(new T.Mesh(geometry,material));const original=vp.render;
    vp.render=function(renderer,write,read){
      vp.render=original;const saved=r.getRenderTarget(),auto=r.autoClear;
      material.uniforms.tDepth.value=vp.sceneDepthSource?.sceneDepthTexture||read.depthTexture;
      if(!material.uniforms.tDepth.value)throw Error('Actual cloud depth missing');
      try{r.autoClear=true;r.setRenderTarget(target);r.render(scene,camera);}
      finally{r.setRenderTarget(saved);r.autoClear=auto;geometry.dispose();material.dispose();}
      NMS._queryDepth=target;const result=original.apply(this,arguments);resolve();return result;
    };
  }));
  await page.screenshot({path:`${out}/player.png`,timeout:90000});
  const player=await page.evaluate(()=>({stats:NMS.stats(),pose:NMS.referenceState(),volume:NMS.volumeState()}));
  const result=await page.evaluate(async warmRounds=>{
    const {makeCloudVolumeMaterial}=await import('/src/clouds-view-reference.js');
    const p=NMS._planet(0),band={rIn:p.R,rOut:p.R+40000,localWeather:true,ox:0,oy:0,oz:0};
    const reference=makeCloudVolumeMaterial(p,band,null,null,null);
    const referenceFragmentShader=reference.fragmentShader;reference.dispose();
    const {probeCloudExtinctionCall}=await import('/tools/cloud-extinction-call-browser.js');
    return probeCloudExtinctionCall({referenceFragmentShader,includeSources:true,warmRounds});
  },warmRounds);
  const after=await evidenceFingerprint('tools/cloudextinctioncalltest.js'),helperAfter=await evidenceFingerprint('tools/cloud-extinction-call-browser.js');
  const report={caseName,quality,warmRounds,viewport,reference,referenceDigest,experimental,experimentalDigest,
    productionExtinctionControl,starLoopControl,candidateModule,productionOwnershipInvariant,before,after,helperBefore,helperAfter,player,result,errors};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.equal(before.sourceDigest,after.sourceDigest);assert.equal(before.verifierDigest,after.verifierDigest);
  assert.equal(helperBefore.verifierDigest,helperAfter.verifierDigest);assert.deepEqual(errors,[]);
  assert.equal(player.volume.representation,'near-volume');
  assert.equal(result.quality,quality);assert.ok(result.records.every(record=>record.occupied>1000));
  assert.equal(result.warmRounds,warmRounds);
  assert.equal(result.productionOwnershipInvariant.verified,true);
  if(candidateKind)assert.equal(result.candidateKind,candidateKind);
  assert.ok(result.records.every(record=>['separate','shared'].every(implementation=>
    record.warm.filter(sample=>sample.implementation===implementation).length===warmRounds)));
  // The helper checks physical, repeat, negative-control and actual uniform gates.
  assert.equal(result.gl,0);assert.equal(result.passed,true);
  if(starLoopControl)assert.ok(result.records.every(record=>record.comparisons.every(c=>c.nativeChanged===0)),
    'Same-count star-loop candidate must retain exact native HDR');
  console.log(`PASS near cloud extinction-call matrix; ${out}`);
} catch(error) {
  await page?.screenshot({path:`${out}/failure-player.png`,timeout:30000}).catch(()=>{});
  await writeFile(`${out}/failure.json`,JSON.stringify({before,helperBefore,reference,referenceDigest,experimental,experimentalDigest,
    productionExtinctionControl,starLoopControl,candidateModule,productionOwnershipInvariant,warmRounds,errors,error:String(error)},null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
