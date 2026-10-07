// Real MRT lifecycle: prefetch the next complete generation, then cross an
// epoch without sampling partial or disposed targets. This is not a cost gate.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/__bank',route=>route.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__bank`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('three');
    const {makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const renderer=new THREE.WebGLRenderer(),gl=renderer.getContext();
    const atlas=new THREE.DataTexture(new Float32Array([1,.5,0,0]),1,1,THREE.RGBAFormat,THREE.FloatType);atlas.needsUpdate=true;
    const bands=new THREE.DataArrayTexture(new Float32Array(16*4),1,1,16);
    bands.image.data.set([1,1000,1600,1]);bands.type=THREE.FloatType;bands.format=THREE.RGBAFormat;
    bands.minFilter=bands.magFilter=THREE.LinearFilter;bands.needsUpdate=true;
    const frames=new Map();
    const p={R:6000000,weatherHours:0,cloudSpinBase:0,weatherField:{windRadiansPerHour:0,surfaceRangeMeters:1},
      weatherStream:{ready:true,anchor:0,frameHours:1,frames},cloudSpeciesTex:bands,cloudBoundsTex:atlas};
    p.volCloudMat=makeCloudVolumeMaterial(p,{rIn:p.R,rOut:p.R+2000,localWeather:true,ox:0,oy:0,oz:0,cov0:.3,cov1:.7},atlas,atlas,atlas);
    const noise=new THREE.Data3DTexture(new Uint8Array([128,128]),1,1,1);noise.format=THREE.RGFormat;noise.needsUpdate=true;
    p.volCloudMat.uniforms.uNoise3.value=noise;
    const frame=()=>({low:atlas.image.data.slice(),high:atlas.image.data.slice(),bands:bands.image.data.slice(),bounds:atlas.image.data.slice()});
    for(const hours of [0,1,2])frames.set(hours,frame());
    const bank=new CloudColumnBank(p,{width:8,rows:1,footprintSamples:1}),u=p.volCloudMat.uniforms;
    bank.update(renderer);
    const partialRejected=u.uColumnsReady.value===0;
    for(let i=0;i<11;i++)bank.update(renderer);
    const warm=[...bank.maps].map(([hours,map])=>({hours,ready:map.ready}));
    const oldest=bank.maps.get(0),next=bank.maps.get(1),prefetch=bank.maps.get(2);
    p.weatherHours=1;p.weatherStream.anchor=1;frames.set(3,frame());bank.update(renderer);
    const crossed=u.uColumnsReady.value===1 && u.uOpticalColumns.value===next.target.textures[0]
      && u.uOpticalColumnsNext.value===prefetch.target.textures[0] && oldest.disposed;
    const countAfterCross=bank.maps.size;
    p.weatherHours=10;p.weatherStream.anchor=10;frames.clear();
    frames.set(10,frame());frames.set(11,frame());bank.update(renderer);
    const jumpRejected=u.uColumnsReady.value===0 && u.uOpticalColumns.value===u.uWeatherMap.value;
    const missingForecastNotBuilt=!bank.maps.has(12);
    frames.set(12,frame());bank.update(renderer);
    const delayedForecastCreated=bank.maps.has(12);
    const retired=[...bank.maps.values()];bank.dispose();bank.dispose();
    const disposed=bank.maps.size===0 && retired.every(map=>map.disposed)
      && u.uColumnsReady.value===0 && u.uColumnsJointReady.value===0
      && u.uOpticalColumns.value===u.uWeatherMap.value;
    const gpuError=gl.getError();p.volCloudMat.dispose();bands.dispose();atlas.dispose();noise.dispose();
    disposeCloudNoiseTexture();renderer.dispose();
    return {partialRejected,warm,crossed,countAfterCross,jumpRejected,missingForecastNotBuilt,delayedForecastCreated,disposed,gpuError};
  });
  await mkdir('test-results/b4-column-bank',{recursive:true});
  await writeFile('test-results/b4-column-bank/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4columnbanktest.js'),result,errors},null,2));
  assert.deepEqual(errors,[]);assert.equal(result.gpuError,0);
  assert.equal(result.countAfterCross,3);assert.ok(result.warm.length===3 && result.warm.every(map=>map.ready));
  for(const key of ['partialRejected','crossed','jumpRejected','missingForecastNotBuilt','delayedForecastCreated','disposed'])assert.equal(result[key],true,key);
  console.log('PASS column forecast handoff, partial/missing generation rejection, jump and idempotent release.');
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
