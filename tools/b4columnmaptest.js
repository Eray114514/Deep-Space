// Real MRT bake, DPR invariance, analytic stratus column and state restoration.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/__column',r=>r.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__column`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('three');
    const {makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
    const renderer=new THREE.WebGLRenderer(),gl=renderer.getContext();
    const atlas=new THREE.DataTexture(new Float32Array([1,.5,0,0]),1,1,THREE.RGBAFormat,THREE.FloatType);atlas.needsUpdate=true;
    const bands=new THREE.DataArrayTexture(new Float32Array(16*4),1,1,16);
    bands.image.data.set([1,1000,1600,1]);bands.type=THREE.FloatType;bands.format=THREE.RGBAFormat;
    bands.minFilter=bands.magFilter=THREE.LinearFilter;bands.needsUpdate=true;
    const p={R:6000000,weatherHours:0,cloudSpinBase:0,weatherField:{windRadiansPerHour:0,surfaceRangeMeters:1},
      cloudSpeciesTex:bands,cloudBoundsTex:atlas};
    p.volCloudMat=makeCloudVolumeMaterial(p,{rIn:p.R,rOut:p.R+2000,localWeather:true,ox:0,oy:0,oz:0,cov0:.3,cov1:.7},atlas,atlas,atlas);
    const noise=new THREE.Data3DTexture(new Uint8Array([128,128]),1,1,1);
    noise.format=THREE.RGFormat;noise.needsUpdate=true;p.volCloudMat.uniforms.uNoise3.value=noise;
    const saved=new THREE.WebGLRenderTarget(16,8);saved.viewport.set(1,2,12,4);
    saved.scissor.set(2,2,8,4);saved.scissorTest=true;
    const cube=new THREE.WebGLCubeRenderTarget(16);cube.viewport.copy(saved.viewport);
    cube.scissor.copy(saved.scissor);cube.scissorTest=true;
    const records=[];
    for(const dpr of [1,1.25,2])for(const isCube of [false,true]) {
      const previous=isCube?cube:saved,face=isCube?4:0;
      renderer.setPixelRatio(dpr);renderer.setRenderTarget(previous,face,0);
      const map=new CloudColumnMap(p,{width:64,samples:128,footprintSamples:4});
      while(!map.ready)map.bakeSlice(renderer,1);
      const restored={target:renderer.getRenderTarget()===previous,face:renderer.getActiveCubeFace(),
        viewport:Array.from(gl.getParameter(gl.VIEWPORT)),
        scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),scissorTest:gl.isEnabled(gl.SCISSOR_TEST)};
      // The vendored synchronous readback cannot restore a current cube's
      // framebuffer array. Check bake restoration above, then read on 2D.
      renderer.setRenderTarget(map.target);
      const bytes=new Uint8Array(64*32*4);renderer.readRenderTargetPixels(map.target,0,0,64,32,bytes);
      const heightBytes=new Uint16Array(64*32*4);
      renderer.readRenderTargetPixels(map.target,0,0,64,32,heightBytes,undefined,1);
      renderer.setRenderTarget(previous,face,0);
      records.push({dpr,isCube,restored,bytes:Array.from(bytes),heights:Array.from(heightBytes,THREE.DataUtils.fromHalfFloat),glError:gl.getError(),snapshots:map.snapshots.length,
        materialReleased:map.material===null});map.dispose();
    }
    renderer.setRenderTarget(null);saved.dispose();cube.dispose();p.volCloudMat.dispose();bands.dispose();atlas.dispose();noise.dispose();
    disposeCloudNoiseTexture();renderer.dispose();return records;
  });
  assert.deepEqual(errors,[]);
  for(const record of result) {
    assert.equal(record.glError,0);assert.equal(record.restored.target,true);assert.equal(record.restored.scissorTest,true);
    assert.equal(record.restored.face,record.isCube?4:0);
    assert.equal(record.snapshots,0);assert.equal(record.materialReleased,true);
    assert.deepEqual(record.restored.viewport,[1,2,12,4]);assert.deepEqual(record.restored.scissor,[2,2,8,4]);
    assert.deepEqual(record.bytes,result[0].bytes,`column bake changes at DPR ${record.dpr}`);
  }
  // Constant-noise stratus has disjoint smoothstep floor/ceiling. Their exact
  // integral is 1 - bottomWidth/2 - topWidth/2; no production march is reused.
  const n=128/255,depth=600+(n*2-1)*150*.5;
  const tau=depth*.025*.2*(.45+.55*n)*(1-.14/2-.2/2),opacity=-Math.expm1(-tau);
  const base=1000+(n*2-1)*120*.5;
  const smooth=x=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
  const firstHeight=steps=>{
    const dt=depth/steps;let transmission=1,moment=0,weight=0;
    for(let k=0;k<steps;k++) {
      const h=1-(k+.5)/steps;
      const sigma=.025*.2*(.45+.55*n)*smooth(h/.14)*(1-smooth((h-.8)/.2));
      const absorbed=transmission*-Math.expm1(-sigma*dt);
      moment+=absorbed*(base+h*depth);weight+=absorbed;transmission*=Math.exp(-sigma*dt);
    }
    return moment/weight;
  };
  const referenceHeight=firstHeight(10000),heightConvergence=Math.abs(referenceHeight-firstHeight(20000));
  assert.ok(heightConvergence<.001,'independent first-interaction reference must converge');
  for(let i=0;i<result[0].bytes.length;i+=4) {
    assert.ok(Math.abs(result[0].bytes[i]/255-opacity)<.01,'analytic stratus column');
    assert.equal(result[0].bytes[i+1],0,'absent ice column');
    assert.ok(Math.abs(result[0].heights[i]-referenceHeight)<3,'visible height is the first interaction, not the extinction centroid');
    assert.ok(Math.abs(result[0].heights[i+2]-opacity)<.01,'single-deck joint opacity');
  }
  await mkdir('test-results/b4-column-map',{recursive:true});
  await writeFile('test-results/b4-column-map/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4columnmaptest.js'),
    records:result.map(({bytes,heights,...r})=>({...r,firstPixel:bytes.slice(0,4),firstHeightPixel:heights.slice(0,4)})),
    tau,opacity,referenceHeight,heightConvergence,errors},null,2));
  console.log('PASS column MRT: analytic stratus opacity/first-interaction height, DPR 1/1.25/2 and render-state restoration.');
} finally {await browser?.close();await new Promise(r=>server.close(r));}
