// Actual R16F 3D sweep/cache readback against an independent constant-noise
// stratus integral, including incoming light beyond the cache's front face.
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
  await page.route('**/__sun-cache',r=>r.fulfill({contentType:'text/html',body:'<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__sun-cache`);
  const result=await page.evaluate(async()=>{
    const THREE=await import('three'),{CloudSunCache,cloudSunCacheSamplingGLSL}=await import('/src/cloud/cloud-sun-cache.js');
    const {makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const {FullScreenQuad}=await import('/vendor/jsm/postprocessing/Pass.js');
    const renderer=new THREE.WebGLRenderer(),R=6000000;
    const copy=renderer.copyTextureToTexture.bind(renderer);
    renderer.copyTextureToTexture=(...args)=>{
      const gl=renderer.getContext(),before=gl.getError();if(before)throw Error('Before cache copy WebGL '+before);
      copy(...args);const after=gl.getError();if(after)throw Error('Cache copy WebGL '+after);
    };
    const initialize=renderer.initRenderTarget.bind(renderer);
    renderer.initRenderTarget=(...args)=>{
      const gl=renderer.getContext(),before=gl.getError();if(before)throw Error('Before cache initialize WebGL '+before);
      initialize(...args);const after=gl.getError();if(after)throw Error('Cache initialize WebGL '+after);
    };
    const atlas=new THREE.DataTexture(new Float32Array([0,.5,0,0]),1,1,THREE.RGBAFormat,THREE.FloatType);atlas.needsUpdate=true;
    const bands=new THREE.DataArrayTexture(new Float32Array(16*4),1,1,16);
    bands.image.data.set([1,1000,1600,1]);bands.format=THREE.RGBAFormat;bands.type=THREE.FloatType;bands.needsUpdate=true;
    const bounds=new THREE.DataTexture(new Float32Array([800,1800,0,0]),1,1,THREE.RGBAFormat,THREE.FloatType);bounds.needsUpdate=true;
    const candidates=new THREE.DataArrayTexture(new Uint16Array([65535]),1,1,1);
    candidates.format=THREE.RedIntegerFormat;candidates.type=THREE.UnsignedShortType;candidates.internalFormat='R16UI';candidates.needsUpdate=true;
    const p={R,weatherHours:0,weatherField:{surfaceRangeMeters:1},cloudSpeciesTex:bands,cloudBoundsTex:bounds,cloudCandidatesTex:candidates};
    p.volCloudMat=makeCloudVolumeMaterial(p,{rIn:R,rOut:R+2000,localWeather:true,ox:0,oy:0,oz:0,cov0:.3,cov1:.7},
      atlas,atlas,atlas,{nearEmptyRuns:true});
    p.volCloudMat.uniforms.uNearBandCandidates.value=candidates;
    const noise=new THREE.Data3DTexture(new Uint8Array([128,128]),1,1,1);noise.format=THREE.RGFormat;noise.needsUpdate=true;
    p.volCloudMat.uniforms.uNoise3.value=noise;p.volCloudMat.uniforms.uSunDir.value.set(0,1,0);
    p.volCloudMat.uniforms.uSecondarySunDir.value.set(Math.sqrt(1-.4*.4),.4,0);
    const saved=new THREE.WebGLRenderTarget(16,8);saved.viewport.set(1,2,12,4);saved.scissor.set(2,2,8,4);saved.scissorTest=true;
    const records=[];
    for(const spacing of [50,150])for(const dpr of [1,1.25,2])for(const encoded of [false,true]) {
      const shared=new THREE.WebGLRenderTarget(16*32,16*4,{format:THREE.RedFormat,
        type:encoded?THREE.UnsignedByteType:THREE.HalfFloatType,
        minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
      let released=0;shared.addEventListener('dispose',()=>released++);
      for(const generation of [0,1]) {
      const weight=generation?.7:1;bands.image.data[0]=weight;bands.needsUpdate=true;
      renderer.setPixelRatio(dpr);renderer.setRenderTarget(saved);
      // The 800 m front/back extent deliberately ends within the cloud for
      // oblique light. Its remaining incoming extinction cannot be omitted.
      const cache=new CloudSunCache(p,new THREE.Vector3(0,R+1300,0),{size:16,depth:16,spacing,
        target:shared,tileOffset:generation*64});
      if(Object.hasOwn(cache.material.uniforms,'uNearBandCandidates'))throw Error('Solar snapshot retained the near view grid');
      let calls=0;while(!cache.ready) {cache.bakeSlice(renderer,{boundaryRows:4,slices:2});if(++calls>100)throw Error('Cache stalled');}
      const gl=renderer.getContext(),restored={target:renderer.getRenderTarget()===saved,
        viewport:Array.from(gl.getParameter(gl.VIEWPORT)),scissor:Array.from(gl.getParameter(gl.SCISSOR_BOX)),scissorTest:gl.isEnabled(gl.SCISSOR_TEST)};
      const samples=[];
      for(let field=0;field<4;field++)for(let i=0;i<16;i++) {
        const coordinate=new THREE.Vector3(.14+(i%4)*.23,.19+Math.floor(i/4)*.2,.12+((i*7)%16)*.05);
        const point=coordinate.clone().addScalar(-.5).multiply(new THREE.Vector3(16*spacing,16*spacing,16*50)).applyMatrix3(cache.frames[field]).add(cache.center);
        const direction=field<2?cache.directions[field]:point.clone().normalize().multiplyScalar(field===2?1:-1);
        samples.push({field,weight,coordinate:coordinate.toArray(),point:point.toArray(),direction:direction.toArray()});
      }
      const coords=new Float32Array(samples.flatMap(s=>[(s.coordinate[0]+s.field)/4,s.coordinate[1],s.coordinate[2]]));
      const material=new THREE.ShaderMaterial({uniforms:{uCache:{value:cache.target.texture},uCoordinates:{value:coords},uOffset:{value:generation*64},uEncoded:{value:encoded?1:0}},
        vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'uniform sampler2D uCache;uniform float uOffset,uEncoded;uniform vec3 uCoordinates[64];'+cloudSunCacheSamplingGLSL+
          'void main(){float v=sampleCloudSunCacheAt(uCache,uCoordinates[int(gl_FragCoord.x)],16.0,uOffset);gl_FragColor=vec4(uEncoded>.5?exp(-(exp(v*log(129.0))-1.0)):exp(-v),0,0,1);}',
        depthTest:false,depthWrite:false,blending:THREE.NoBlending});
      const target=new THREE.WebGLRenderTarget(64,1,{type:THREE.FloatType,depthBuffer:false}),quad=new FullScreenQuad(material);
      renderer.setRenderTarget(target);quad.render(renderer);const pixels=new Float32Array(64*4);renderer.readRenderTargetPixels(target,0,0,64,1,pixels);
      samples.forEach((s,i)=>{s.transmission=pixels[i*4];if(pixels[i*4+3]!==1)throw Error('Invalid cache readback');});
      if(generation===1) {
        material.uniforms.uOffset.value=0;quad.render(renderer);
        const older=new Float32Array(64*4);renderer.readRenderTargetPixels(target,0,0,64,1,older);
        const first=records.find(q=>q.dpr===dpr && q.spacing===spacing && q.encoded===encoded && q.generation===0);
        for(let i=0;i<64;i++)if(older[i*4]!==first.samples[i].transmission)
          throw Error('Baking the next generation overwrote the live atlas slot');
      }
      records.push({dpr,spacing,generation,encoded,calls,restored,samples,glError:gl.getError()});renderer.setRenderTarget(saved);
      quad.dispose();material.dispose();target.dispose();cache.dispose();
      if(released!==0)throw Error('A cache generation disposed the shared atlas');
      }
      shared.dispose();if(released!==1)throw Error('Shared owner did not dispose atlas exactly once');
    }
    renderer.setRenderTarget(null);saved.dispose();p.volCloudMat.dispose();
    for(const texture of [atlas,bands,bounds,candidates,noise])texture.dispose();disposeCloudNoiseTexture();renderer.dispose();return records;
  }).catch(error=>{console.error(errors);throw error;});
  const n=128/255,base=1000+(n*2-1)*120*.5,depth=600+(n*2-1)*150*.5;
  const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
  const sigma=(height,weight)=>{const h=(height-base)/depth;return h<=0 || h>=1?0:
    weight*.025*.2*(.45+.55*n)*smooth(0,.14,h)*(1-smooth(.8,1,h));};
  const reference=(s,step)=>{
    const [x,y,z]=s.point,[dx,dy,dz]=s.direction,R=6000000;
    const b=x*dx+y*dy+z*dz,r=Math.hypot(x,y,z),disc=b*b-(r-(R+2000))*(r+(R+2000));
    let end=-b+Math.sqrt(disc);
    const ground=b*b-(r-R)*(r+R);if(ground>=0) {const hit=-b-Math.sqrt(ground);if(hit>0)end=Math.min(end,hit);}
    const count=Math.ceil(end/step),dt=end/count;let od=0;
    for(let i=0;i<count;i++) {const t=(i+.5)*dt;od+=sigma(Math.hypot(x+dx*t,y+dy*t,z+dz*t)-R,s.weight)*dt;}
    return Math.exp(-od);
  };
  let maximum=0,referenceError=0;
  for(const record of result)for(const s of record.samples) {
    s.reference=reference(s,2.5);s.error=Math.abs(s.reference-s.transmission);maximum=Math.max(maximum,s.error);
    referenceError=Math.max(referenceError,Math.abs(s.reference-reference(s,5)));
  }
  await mkdir('test-results/b4-sun-cache',{recursive:true});
  await writeFile('test-results/b4-sun-cache/report.json',JSON.stringify({fingerprint:await evidenceFingerprint('tools/b4suncachetest.js'),maximum,referenceError,records:result,errors},null,2));
  console.log({maximum,referenceError,errors});assert.deepEqual(errors,[]);assert.ok(referenceError<.001);
  assert.ok(maximum<.025,'Oriented cache must preserve incoming and local extinction');
  for(const r of result) {
    assert.equal(r.glError,0);assert.equal(r.restored.target,true);assert.equal(r.restored.scissorTest,true);
    assert.deepEqual(r.restored.viewport,[1,2,12,4]);assert.deepEqual(r.restored.scissor,[2,2,8,4]);
    assert.deepEqual(r.samples.map(s=>s.transmission),result.find(q=>q.spacing===r.spacing && q.generation===r.generation && q.encoded===r.encoded).samples.map(s=>s.transmission));
  }
} finally {await browser?.close();await new Promise(r=>server.close(r));}
