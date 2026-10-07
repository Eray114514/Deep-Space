// Same-page GPU equivalence and cost attribution for the shared density kernel.
// Full boundary batches distinguish actual beam cost from adaptive draw overhead.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const reference='140c969',out='test-results/cloud-kernel';
const badSupportControl=process.argv.includes('--bad-support-control');
const livePumpControl=process.argv.includes('--live-pump-control');
const before=await evidenceFingerprint('tools/cloudkernelperftest.js');
const original=execFileSync('git',['show',`${reference}:src/cloud/production-shape.js`],{encoding:'utf8'});
const {server,port}=await startServer(0);let browser;
await mkdir(out,{recursive:true});
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath(),headless:true});
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.route('**/src/cloud/production-shape-reference.js',route=>route.fulfill({contentType:'text/javascript',body:original}));
  await page.goto(`http://127.0.0.1:${port}/?nohero=1&freeze=1&time=9.5&quality=ultra&vclouds=1&post=1&nolock=1`);
  await page.waitForFunction(()=>window.NMS?.booted,null,{timeout:180000});
  await page.evaluate(()=>{NMS._savedKernelRender=NMS._pipeline.render;NMS._pipeline.render=()=>{};});
  await page.waitForFunction(()=>NMS._planet(0).weatherStream?.ready,null,{timeout:60000});
  console.log('Real home weather ready; comparing density and formal-size caches.');
  const result=await page.evaluate(async({badSupportControl,livePumpControl})=>{
    const {productionSpeciesGLSL:current}=await import('/src/cloud/production-shape.js');
    const {productionSpeciesGLSL:reference}=await import('/src/cloud/production-shape-reference.js');
    const {CloudSunCache}=await import('/src/cloud/cloud-sun-cache.js');
    const T=NMS._THREE,r=NMS._renderer,p=NMS._planet(0),gl=r.getContext();
    const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
    if(!ext)throw Error('Real GPU timer required');
    const replace=shader=>{
      if(!shader.includes(current))throw Error('Production consumer did not include the shared kernel');
      return shader.replace(current,reference);
    };
    const timed=async work=>{
      const query=gl.createQuery(),start=performance.now();gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
      try {work();} finally {gl.endQuery(ext.TIME_ELAPSED_EXT);}
      const cpuMs=performance.now()-start;gl.flush();
      // Diagnostic only: never add this wait to the runtime scheduler.
      while(!gl.getQueryParameter(query,gl.QUERY_RESULT_AVAILABLE))await new Promise(resolve=>setTimeout(resolve,5));
      if(gl.getParameter(ext.GPU_DISJOINT_EXT))throw Error('Disjoint timing');
      const gpuMs=gl.getQueryParameter(query,gl.QUERY_RESULT)/1e6;gl.deleteQuery(query);
      return {cpuMs,gpuMs};
    };
    const saved=r.getRenderTarget(),geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const u={...p.volCloudMat.uniforms,uProbeLayer:{value:0}};
    const prefix=p.volCloudMat.fragmentShader.slice(0,p.volCloudMat.fragmentShader.lastIndexOf('void main()'));
    const shader=prefix+`uniform float uProbeLayer,uProbeMask,uProbeCandidates;
      void main(){float index=floor(gl_FragCoord.x),y=1.0-2.0*(index+.5)/64.0,phi=index*2.399963229728653;
        vec3 direction=vec3(sqrt(1.0-y*y)*cos(phi),y,sqrt(1.0-y*y)*sin(phi));
        float height=uProbeLayer<.5?-1000.0+gl_FragCoord.y*260.0:uProbeLayer<1.5?71000.0+gl_FragCoord.y*160.0:-1000.0+gl_FragCoord.y*48.0;
        gl_FragColor=vec4(productionSpeciesAt(direction*(uBodyR+height)),0,1);}`;
    const testedShader=badSupportControl?shader.replace(
      'if(!speciesHasSupport(altitude,band,parameters.y,parameters.z))continue;',
      'if(true)continue;'):shader;
    const materials=[replace(shader),testedShader].map(fragmentShader=>new T.ShaderMaterial({
      uniforms:u,defines:p.volCloudMat.defines,fragmentShader,
      vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
      depthTest:false,depthWrite:false,blending:T.NoBlending}));
    const mesh=new T.Mesh(geometry,materials[0]);scene.add(mesh);
    const target=new T.WebGLRenderTarget(64,128,{type:T.FloatType,depthBuffer:false});
    const density={cases:0,samples:0,occupied:0,maximumError:0,changed:0};
    const oldLayer=u.uMediumLayer.value,oldMask=u.uSpeciesMask.value,oldCandidates=u.uCandidatesReady.value;
    try {
      for(const layer of [0,1,2])for(const mask of [-1,...Array.from({length:16},(_,i)=>i)])for(const candidates of [0,1]) {
        u.uMediumLayer.value=layer;u.uSpeciesMask.value=mask;u.uCandidatesReady.value=candidates;
        u.uProbeLayer.value=layer;
        const outputs=[];
        for(const material of materials) {
          mesh.material=material;r.setRenderTarget(target);r.render(scene,camera);
          const pixels=new Float32Array(64*128*4);r.readRenderTargetPixels(target,0,0,64,128,pixels);outputs.push(pixels);
        }
        density.cases++;density.samples+=64*128;
        for(let i=0;i<outputs[0].length;i++) {
          if(!Number.isFinite(outputs[1][i]))throw Error('Nonfinite density');
          const error=Math.abs(outputs[0][i]-outputs[1][i]);
          density.maximumError=Math.max(density.maximumError,error);if(error)density.changed++;
          if(i%4<2 && outputs[0][i]>0)density.occupied++;
        }
      }
    } finally {
      u.uMediumLayer.value=oldLayer;u.uSpeciesMask.value=oldMask;u.uCandidatesReady.value=oldCandidates;
      r.setRenderTarget(saved);target.dispose();materials.forEach(m=>m.dispose());
    }
    if(badSupportControl) {
      geometry.dispose();r.setRenderTarget(saved);
      return {density,pixels:{changed:0},records:[],glError:gl.getError()};
    }
    // Main render is not the only renderer user: terrain prewarming and
    // resource uploads also run on RAF. Pause the entire diagnostic pump,
    // preserving and later replaying callbacks rather than sharing GL state.
    const requestFrame=window.requestAnimationFrame,cancelFrame=window.cancelAnimationFrame;
    const deferred=new Map();let frameToken=0;
    if(!livePumpControl) {
      window.requestAnimationFrame=callback=>{const id=--frameToken;deferred.set(id,callback);return id;};
      window.cancelAnimationFrame=id=>{if(!deferred.delete(id))cancelFrame.call(window,id);};
      await new Promise(resolve=>setTimeout(resolve,40));
    }
    // Freeze the complete density input, including texture Source objects.
    // ?freeze stops simulation time, but the live page still owns uniforms
    // and asynchronous weather/resource transactions while queries await.
    const pinned=Object.create(p),pinnedTextures=[];
    const textureNames=new Set(['uSpeciesMap','uBandBounds','uBandCandidates','uWeatherMapHi','uNoise3','uSpeciesParameters']);
    const pinnedUniforms=Object.fromEntries(Object.entries(p.volCloudMat.uniforms).map(([name,{value}])=>{
      if(textureNames.has(name)) {
        const texture=value.clone();texture.source=new T.Source({...value.image,data:value.image.data.slice()});
        if('wrapR' in value)texture.wrapR=value.wrapR;
        texture.needsUpdate=true;pinnedTextures.push(texture);value=texture;
      } else if(value?.clone)value=value.clone();
      return [name,{value}];
    }));
    pinned.volCloudMat={uniforms:pinnedUniforms};pinned.weatherHours=p.weatherHours;
    const readCopy=cache=>{
      const target=new T.WebGLRenderTarget(cache.target.width,cache.target.height,{depthBuffer:false});
      const material=new T.ShaderMaterial({uniforms:{tCache:{value:cache.target.texture}},
        vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
        fragmentShader:'uniform sampler2D tCache;varying vec2 vUV;void main(){gl_FragColor=vec4(texture2D(tCache,vUV).rrr,1);}',depthTest:false,depthWrite:false});
      mesh.material=material;r.setRenderTarget(target);r.render(scene,camera);
      const pixels=new Uint8Array(target.width*target.height*4);r.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
      r.setRenderTarget(saved);target.dispose();material.dispose();return pixels;
    };
    const readback={changed:0,maximumError:0};
    const read=cache=>{
      r.setRenderTarget(cache.target);
      const pixels=new Uint8Array(cache.target.width*cache.target.height*4);
      gl.readPixels(0,0,cache.target.width,cache.target.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      r.setRenderTarget(saved);
      if(gl.getError())throw Error('Native cache byte read failed');
      const copied=readCopy(cache);
      for(let i=0;i<pixels.length;i+=4) {
        const error=Math.abs(pixels[i]-copied[i]);readback.maximumError=Math.max(readback.maximumError,error);
        if(error)readback.changed++;
      }
      return pixels;
    };
    const records=[],pixels={changed:0,maximumError:0,comparisons:0};
    // Each sun angle warms both programs, then reverses the measured ordering.
    for(const cosine of [1,.4]) {
      const sun=pinnedUniforms.uSunDir.value.clone().normalize();
      const tangent=new T.Vector3().crossVectors(sun,new T.Vector3(0,1,0)).normalize();
      const radial=sun.clone().multiplyScalar(cosine).addScaledVector(tangent,Math.sqrt(1-cosine*cosine));
      const center=radial.clone().multiplyScalar(p.R+Math.max(0,p.weatherField.surfaceAt(radial))+3000);
      let expected;const sameImplementation=[];
      const leases=[{},{}];
      try {
        for(let run=0;run<5;run++)for(const implementation of run%2?[1,0]:[0,1]) {
          const cache=new CloudSunCache(pinned,center,{size:128,depth:128,encodeOpticalDepth:true,programOwner:leases[implementation]});
          if(!implementation)cache.material.fragmentShader=replace(cache.material.fragmentShader);
          const batches=[];
          while(!cache.ready) {
            const field=cache.field,boundary=cache.boundaryRow,layer=cache.layer;
            const timing=await timed(()=>cache.bakeSlice(r,{boundaryRows:128,slices:128}));
            batches.push({field,boundary,layer,...timing});
          }
          const bytes=read(cache);
          let occupied=0;for(let i=0;i<bytes.length;i+=4)if(bytes[i])occupied++;
          const difference={changed:0,maximumError:0,sameImplementationChanged:0,examples:[]};
          if(expected)for(let i=0;i<bytes.length;i++) {
            const error=Math.abs(bytes[i]-expected[i]);pixels.maximumError=Math.max(pixels.maximumError,error);
            difference.maximumError=Math.max(difference.maximumError,error);
            if(error) {
              pixels.changed++;difference.changed++;
              if(i%4===0 && difference.examples.length<8)difference.examples.push({pixel:i/4,expected:expected[i],actual:bytes[i]});
            }
          }
          else expected=bytes;
          if(sameImplementation[implementation]) {
            for(let i=0;i<bytes.length;i++)if(bytes[i]!==sameImplementation[implementation][i])difference.sameImplementationChanged++;
          } else sameImplementation[implementation]=bytes;
          pixels.comparisons++;
          records.push({cosine,run,implementation:implementation?'current':'reference',batches,
            cpuMs:batches.reduce((s,b)=>s+b.cpuMs,0),gpuMs:batches.reduce((s,b)=>s+b.gpuMs,0),bytes:bytes.length,occupied,difference,
            hours:p.weatherHours,spin:p.volCloudMat.uniforms.uSpin.value.toArray(),sun:cache.directions.map(d=>d.toArray())});
          cache.dispose();
        }
      } finally {leases.forEach(owner=>Object.values(owner).forEach(m=>m.dispose()));}
    }
    pinnedTextures.forEach(t=>t.dispose());geometry.dispose();r.setRenderTarget(saved);
    window.requestAnimationFrame=requestFrame;window.cancelAnimationFrame=cancelFrame;
    for(const callback of deferred.values())requestFrame.call(window,callback);
    NMS._pipeline.render=NMS._savedKernelRender;delete NMS._savedKernelRender;
    return {density,pixels,readback,records,deferredFrames:deferred.size,glError:gl.getError(),renderer:gl.getParameter(gl.getExtension('WEBGL_debug_renderer_info').UNMASKED_RENDERER_WEBGL)};
  },{badSupportControl,livePumpControl});
  const after=await evidenceFingerprint('tools/cloudkernelperftest.js');
  const report={reference,before,after,result,errors,badSupportControl,livePumpControl};
  const name=badSupportControl?'bad-support-control':livePumpControl?'live-pump-control':'report';
  await writeFile(`${out}/${name}.json`,JSON.stringify(report,null,2));
  console.log(JSON.stringify({density:result.density,pixels:result.pixels,records:result.records.map(({batches,...r})=>r),gl:result.glError,errors},null,2));
  assert.equal(before.sourceDigest,after.sourceDigest,'Runtime changed during attribution');
  assert.deepEqual(errors,[]);assert.equal(result.glError,0);
  assert.ok(result.density.occupied>100,'Density test needs occupied samples');
  assert.ok(result.density.maximumError<.000001,'Shared kernel density changed');
  assert.equal(result.pixels.changed,0,'Formal-size cache bytes changed');
  assert.ok(result.records.every(r=>r.occupied>1000),'Nonempty formal-size cache required');
  if(!livePumpControl) {
    await page.evaluate(()=>NMS.setAtmosphereAltitude(0,3000,{dir:[-.7817630820403421,.6181640625,.08197362619941498],pitch:-1.1}));
    await page.waitForFunction(()=>NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value>.5,null,{timeout:180000});
    await page.screenshot({path:`${out}/player.png`});
    report.player=await page.evaluate(()=>({glError:NMS._renderer.getContext().getError(),
      ready:NMS._planet(0).volCloudMat.uniforms.uSunCacheReady.value,
      pose:NMS.referenceState(),screenshot:'player.png',scope:'frozen 1280x720 HUD/post near cloud; no continuous-flight or FPS acceptance'}));
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
    assert.equal(report.player.glError,0);assert.equal(report.player.ready,1);assert.deepEqual(errors,[]);
  }
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
