// Tiny native WebGL routing/lifetime contract. This deliberately replaces the
// volume raymarch with a diagnostic shader; it is not physical HDR equivalence,
// a visual acceptance test, a performance gate, or a whole-page cold-start test.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const verifier='tools/columnroutinggputest.js';
const directory=`test-results/column-routing/${new Date().toISOString().replaceAll(':','-').replaceAll('.','-')}`;
const fingerprint=await evidenceFingerprint(verifier);
const report={scope:'Native program routing and real column-bank safety only; diagnostic volume shader, not physical HDR or global cold startup.',
  fingerprint,errors:[],warnings:[],driverWarnings:[]};
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined,headless:true});
  report.browserVersion=browser.version();
  const page=await browser.newPage({viewport:{width:64,height:64},deviceScaleFactor:1});
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{
    if(message.type()==='error')report.errors.push(message.text());
    else if(message.type()==='warning') {
      report.warnings.push(message.text());
      // ReadPixels can report an expected synchronization stall. Preserve
      // that observation without treating explicit readback as a GL error.
      if(/GL_INVALID|GL_CONTEXT_LOST|WebGL.*(?:error|lost)|Program object expected/i.test(message.text()))
        report.driverWarnings.push(message.text());
    }
  });
  await page.route('**/__column-routing',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__column-routing`);
  report.result=await page.evaluate(async()=>{
    const THREE=await import('three');
    const {VolumetricPass}=await import('/src/volumetric-pass-webgl.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {PlanetWeatherStream}=await import('/src/cloud/planet-weather-stream.js');
    const {createWeatherSystem}=await import('/src/cloud/weather-system.js');
    const {productionStorageLayers,CANDIDATE_WIDTH,CANDIDATE_HEIGHT,CANDIDATE_LAYERS}=await import('/src/cloud/production-bands.js');
    const {makeCloudVolumeMaterial,disposeCloudNoiseTexture}=await import('/src/clouds-webgl.js');
    const result={records:[],checks:[],gl:[],shaderErrors:[],contextLosses:0,
      bankOptions:{width:8,rows:1,footprintSamples:1},disposals:0,unsafeDisposals:0};
    const textures=[],banks=[],watched=new WeakSet(),disposedTextures=new WeakSet();
    const samplers=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'];
    let renderer,gl,stream,p,geometry,target,pass;
    const check=(name,condition)=>{
      result.checks.push({name,pass:Boolean(condition)});
      if(!condition)throw new Error(name);
    };
    const glCheckpoint=name=>{
      if(!gl)return;
      const errors=[];
      for(let i=0;i<16;i++) {const code=gl.getError();if(!code)break;errors.push(code);}
      result.gl.push({name,errors,lost:gl.isContextLost()});
      if(errors.length || gl.isContextLost())throw new Error(`GL/context failure at ${name}: ${errors}`);
    };
    try {
      // Real production worker frames are prepared before any GL work. Hold
      // delivery, not frame manufacture, to expose a deterministic missing
      // partner; PlanetWeatherStream's real handler owns readiness/commit.
      const width=8,height=4,bandWidth=128,bandHeight=64,R=6000000;
      const terrain={width,height,data:new Float32Array(width*height*4),scale:1};
      for(let i=0;i<terrain.data.length;i+=4)terrain.data[i+2]=1;
      const options={radiusMeters:R,targetCoverage:.65,temperatureK:289,polarCoolingK:52,
        windSpeed:15,weatherSpeed:1,diurnalRangeK:0};
      const system=createWeatherSystem('column-routing-native', {...options,
        terrain:()=>({elevationMeters:0,elevation01:0,oceanic:1}),calibrationSamples:64,calibrationIterations:1});
      const atlas=()=>{
        const texture=new THREE.DataTexture(new Float32Array(width*height*4),width,height,THREE.RGBAFormat,THREE.FloatType);
        texture.userData.weatherAtlas={width,height,data:new Float32Array(width*height*4),scale:1};
        texture.minFilter=texture.magFilter=THREE.NearestFilter;
        texture.wrapS=THREE.RepeatWrapping;texture.needsUpdate=true;textures.push(texture);return texture;
      };
      const layers=productionStorageLayers(bandWidth,bandHeight);
      const species=new THREE.DataArrayTexture(new Float32Array(bandWidth*bandHeight*4*layers),bandWidth,bandHeight,layers);
      species.format=THREE.RGBAFormat;species.type=THREE.FloatType;
      species.minFilter=species.magFilter=THREE.LinearFilter;species.needsUpdate=true;textures.push(species);
      const bounds=new THREE.DataTexture(new Float32Array(bandWidth*bandHeight*4),bandWidth,bandHeight,THREE.RGBAFormat,THREE.FloatType);
      bounds.needsUpdate=true;textures.push(bounds);
      const candidates=new THREE.DataArrayTexture(new Uint16Array(CANDIDATE_WIDTH*CANDIDATE_HEIGHT*CANDIDATE_LAYERS),
        CANDIDATE_WIDTH,CANDIDATE_HEIGHT,CANDIDATE_LAYERS);
      candidates.format=THREE.RedIntegerFormat;candidates.type=THREE.UnsignedShortType;
      candidates.internalFormat='R16UI';candidates.needsUpdate=true;textures.push(candidates);
      p={R,weatherHours:.25,cloudSpinBase:0,cloudAtlasWidth:width,posUniv:new THREE.Vector3(),
        cloudShadowTex:atlas(),cloudWeatherHiTex:atlas(),cloudSpeciesTex:species,cloudBoundsTex:bounds,cloudCandidatesTex:candidates,
        weatherField:{synoptic:true,namespace:'column-routing-native',windRadiansPerHour:0,surfaceRangeMeters:1000,
          streamDescriptor:{seed:'column-routing-native',terrain,coverageBias:system.coverageBias,angularSpeed:0,options},
          bindWind(){},bindAtlases(){}}};
      p.volCloudBand={rIn:R,rOut:R+32000,localWeather:true,ox:0,oy:0,oz:0,cov0:.3,cov1:.7};
      p.volCloudMat=makeCloudVolumeMaterial(p,p.volCloudBand,p.cloudShadowTex,p.cloudShadowTex,p.cloudWeatherHiTex);
      const noise=new THREE.Data3DTexture(new Uint8Array([128,128]),1,1,1);
      noise.format=THREE.RGFormat;noise.needsUpdate=true;textures.push(noise);
      p.volCloudMat.uniforms.uNoise3.value=noise;
      const held=new Map();stream=new PlanetWeatherStream(p);p.weatherStream=stream;
      const deliver=stream.worker.onmessage;
      stream.worker.onmessage=event=>{
        if(event.data.error)deliver(event);else held.set(event.data.hours,event);
      };
      stream.update(p.weatherHours);
      const frameDeadline=performance.now()+120000;
      while(held.size<3) {
        if(stream.error)throw new Error(stream.error);
        if(performance.now()>frameDeadline)throw new Error('Production weather worker frame deadline');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      const a=stream.anchor,b=a+stream.frameHours,c=b+stream.frameHours;
      result.weatherFrames=[a,b,c].map(hours=>{
        const frame=held.get(hours).data;
        return {hours,width:frame.width,height:frame.height,low:frame.low.length,bands:frame.bands.length,
          bounds:frame.bounds.length,candidates:frame.candidates.length};
      });
      deliver(held.get(a));
      check('real stream has only the first endpoint',stream.frames.has(a)&&!stream.frames.has(b)&&!stream.ready);

      renderer=new THREE.WebGLRenderer({antialias:false});renderer.setPixelRatio(1);renderer.setSize(2,2,false);
      gl=renderer.getContext();
      renderer.domElement.addEventListener('webglcontextlost',()=>result.contextLosses++);
      renderer.debug.onShaderError=(context,program,vertex,fragment)=>result.shaderErrors.push({
        program:context.getProgramInfoLog(program),vertex:context.getShaderInfoLog(vertex),fragment:context.getShaderInfoLog(fragment)});
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      result.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      result.userAgent=navigator.userAgent;
      check('native WebGL2 adapter',renderer.capabilities.isWebGL2&&!/swiftshader|llvmpipe|software/i.test(result.gpu));
      check('real half-float column target support',Boolean(gl.getExtension('EXT_color_buffer_float')));
      const vertexShader='void main(){gl_Position=vec4(position.xy,0.0,1.0);}';
      // CACHE1 intentionally has no uColumnsReady fallback, like production.
      // Red proves that program ran; blue also witnesses all four real MRT
      // samplers. Green is far physical routing; blue-only is the near route.
      const fragmentShader=`uniform sampler2D uOpticalColumns,uOpticalColumnsNext,uColumnHeights,uColumnHeightsNext;
        void main(){
          #if CLOUD_FAR_VIEW == 0
            gl_FragColor=vec4(0.0,0.0,1.0,1.0);
          #elif CLOUD_FAR_CACHE == 1
            vec2 uv=vec2(0.5625,0.625);
            float witness=texture2D(uOpticalColumns,uv).r+texture2D(uOpticalColumnsNext,uv).r
              +texture2D(uColumnHeights,uv).b+texture2D(uColumnHeightsNext,uv).b;
            gl_FragColor=vec4(1.0,0.0,0.125+0.125*witness,1.0);
          #else
            gl_FragColor=vec4(0.0,1.0,0.0,1.0);
          #endif
        }`;
      Object.assign(p.volCloudMat,{vertexShader,fragmentShader,transparent:false,premultipliedAlpha:false,
        side:THREE.FrontSide,depthTest:false,depthWrite:false,blending:THREE.NoBlending});
      p.volCloudMat.needsUpdate=true;
      p.volCloudFarMat=p.volCloudMat.clone();p.volCloudFarMat.uniforms=p.volCloudMat.uniforms;
      p.volCloudFarMat.defines.CLOUD_FAR_VIEW=1;p.volCloudFarMat.needsUpdate=true;
      geometry=new THREE.PlaneGeometry(2,2);p.volCloudMesh=new THREE.Mesh(geometry,p.volCloudMat);
      p.volCloudMesh.frustumCulled=false;
      const scene=new THREE.Scene();scene.add(p.volCloudMesh);
      const camera=new THREE.PerspectiveCamera(50,2,1,1e9),u=p.volCloudMat.uniforms;
      target=new THREE.WebGLRenderTarget(2,2,{depthBuffer:false});
      pass=Object.create(VolumetricPass.prototype);
      Object.assign(pass,{activePlanet:p,camera,width:8,height:4,columnMaps:new Map(),columnRelease:new Map(),frame:0,
        center:new THREE.Vector3(),nav:new THREE.Vector3(),historyValid:false});
      u.uCameraLocal.value.set(R+2000000,0,0);
      const fallback=()=>samplers.every(name=>u[name].value===u.uWeatherMap.value);
      const watchBank=bank=>{
        for(const map of bank.maps.values())if(!watched.has(map)) {
          watched.add(map);map.target.addEventListener('dispose',()=>{
            result.disposals++;
            if(samplers.some(name=>map.target.textures.includes(u[name].value)))result.unsafeDisposals++;
            for(const texture of map.target.textures)disposedTextures.add(texture);
          });
        }
      };
      const installBank=()=>{
        const bank=new CloudColumnBank(p,result.bankOptions);
        banks.push(bank);pass.columnMaps.set(p,bank);p.cloudColumnMap=bank;return bank;
      };
      const update=name=>{
        pass.updateCloudColumns(renderer);
        for(const bank of pass.columnMaps.values())watchBank(bank);
        glCheckpoint(name);
      };
      const endpointPixel=map=>{
        const optical=new Uint8Array(4),heights=new Uint16Array(4);
        renderer.readRenderTargetPixels(map.target,4,2,1,1,optical);
        renderer.readRenderTargetPixels(map.target,4,2,1,1,heights,undefined,1);
        return {optical:Array.from(optical),heights:Array.from(heights,THREE.DataUtils.fromHalfFloat)};
      };
      const draw=name=>{
        const bank=pass.columnMaps.get(p),material=p.volCloudMesh.material;
        renderer.setRenderTarget(target);renderer.render(scene,camera);
        const bytes=new Uint8Array(4);renderer.readRenderTargetPixels(target,0,0,1,1,bytes);
        const program=renderer.properties.get(material).currentProgram;
        const record={name,pixel:Array.from(bytes),material:material===p.volCloudFarMat?'far':'near',
          macro:p.volCloudFarMat.defines.CLOUD_FAR_CACHE,materialVersion:material.version,
          programId:program?.id,linked:Boolean(program?.program&&gl.getProgramParameter(program.program,gl.LINK_STATUS)),
          draws:renderer.info.render.calls,ready:u.uColumnsReady.value,jointReady:u.uColumnsJointReady.value,
          streamReady:p.weatherStream?.ready??null,bankPresent:Boolean(bank),bankDisposed:bank?.disposed??null,
          maps:bank?[...bank.maps].map(([hours,map])=>({hours,row:map.row,ready:map.ready,disposed:map.disposed})):[],
          fallback:fallback(),samplers:samplers.map(key=>({key,uuid:u[key].value?.uuid,disposed:disposedTextures.has(u[key].value)}))};
        if(record.macro===1 && record.ready===1) {
          record.endpoints=[endpointPixel(bank.maps.get(a)),endpointPixel(bank.maps.get(b))];
          record.expectedBlue=Math.round(255*(.125+.125*record.endpoints.reduce((sum,pixel)=>sum+pixel.optical[0]/255+pixel.heights[2],0)));
        }
        result.records.push(record);glCheckpoint(`draw ${name}`);
        check(`${name}: linked real draw`,record.linked&&record.draws===1);
        check(`${name}: no disposed sampler`,record.samplers.every(sampler=>!sampler.disposed));
        return record;
      };
      const physical=(name,record)=>check(`${name}: far physical native pixel`,record.material==='far'
        &&record.macro===0&&record.pixel[0]===0&&record.pixel[1]===255&&record.pixel[2]===0&&record.pixel[3]===255);
      const cached=(name,record)=>check(`${name}: cached native pixel and four MRT bindings`,record.material==='far'
        &&record.macro===1&&record.ready===1&&record.jointReady===1&&!record.fallback
        &&record.pixel[0]===255&&record.pixel[1]===0&&record.pixel[3]===255
        &&Number.isFinite(record.expectedBlue)&&Math.abs(record.pixel[2]-record.expectedBlue)<=2);
      const warm=(name)=>{
        for(let i=0;i<16 && u.uColumnsReady.value!==1;i++)update(`${name} slice ${i}`);
        const record=draw(name);cached(name,record);return record;
      };

      const original=installBank();
      update('first endpoint slice 0');
      const pending=draw('first endpoint pending');physical(pending.name,pending);
      check('pending first endpoint remains unbound',!original.maps.get(a).ready&&pending.ready===0&&pending.fallback);
      for(let i=1;i<4;i++)update(`first endpoint slice ${i}`);
      const firstOnly=draw('first ready, partner absent');physical(firstOnly.name,firstOnly);
      check('ready endpoint cannot publish without its partner',original.maps.get(a).ready&&!original.maps.has(b)
        &&firstOnly.ready===0&&firstOnly.fallback);
      deliver(held.get(b));
      update('second endpoint slice 0');
      const secondPending=draw('second endpoint pending');physical(secondPending.name,secondPending);
      check('partial second endpoint remains unbound',original.maps.get(a).ready&&!original.maps.get(b).ready
        &&secondPending.ready===0&&secondPending.fallback);
      const ready=warm('ready pair');
      const endpoints=[original.maps.get(a),original.maps.get(b)];
      deliver(held.get(c));

      stream.ready=false;
      update('retained bank stream not ready');
      const loading=draw('retained bank stream not ready');physical(loading.name,loading);
      check('unready stream retains its bank and endpoints but unbinds them',pass.columnMaps.get(p)===original&&!original.disposed
        &&endpoints.every((map,i)=>original.maps.get([a,b][i])===map&&!map.disposed)
        &&loading.ready===0&&loading.jointReady===0&&loading.fallback);
      check('native program changes with cache macro',loading.programId!==ready.programId);
      stream.update(p.weatherHours,true);
      update('restore retained pair');
      const restored=draw('restore retained pair');cached(restored.name,restored);
      check('restored pair reuses the cache program',restored.programId===ready.programId&&pass.columnMaps.get(p)===original);

      u.uCameraLocal.value.set(p.volCloudBand.rOut+1000,0,0);
      update('near view');
      const near=draw('near view');
      check('near route disposes bank and uses native near program',original.disposed&&!pass.columnMaps.has(p)
        &&near.macro===0&&near.material==='near'&&near.ready===0&&near.fallback
        &&near.pixel.every((value,i)=>value===[0,0,255,255][i]));
      u.uCameraLocal.value.set(R+2000000,0,0);
      installBank();warm('ready before outgoing retirement');
      const outgoing=pass.columnMaps.get(p);
      pass.setActivePlanet(null,new THREE.Vector3());
      check('actual owner handoff queues outgoing bank',pass.activePlanet===null&&pass.columnRelease.get(p)===2);
      outgoing.dispose();
      pass.updateCloudColumns(renderer); // No active planet can repair its macro.
      const retired=draw('outgoing bank disposed');physical(retired.name,retired);
      check('outgoing bank itself resets macro and bindings',outgoing.disposed&&retired.ready===0&&retired.fallback&&p.cloudColumnMap===null);

      pass.setActivePlanet(p,new THREE.Vector3());installBank();warm('ready before null stream');
      const beforeNull=pass.columnMaps.get(p);p.weatherStream=null;
      update('null stream');
      const missing=draw('null stream');physical(missing.name,missing);
      check('null stream retires targets safely',beforeNull.disposed&&!pass.columnMaps.has(p)&&missing.ready===0&&missing.fallback);
      p.weatherStream=stream;installBank();warm('ready before disposed stream');
      const beforeDisposed=pass.columnMaps.get(p);stream.dispose();
      update('disposed stream');
      const disposed=draw('disposed stream');physical(disposed.name,disposed);
      check('disposed stream retires targets safely',beforeDisposed.disposed&&!pass.columnMaps.has(p)
        &&disposed.ready===0&&disposed.jointReady===0&&disposed.fallback);
      const version=p.volCloudFarMat.version;update('stable unavailable route');
      check('stable physical route does not dirty the material',p.volCloudFarMat.version===version);
      check('no target was disposed while still bound',result.disposals>0&&result.unsafeDisposals===0);
      check('shared production material uniforms preserved',p.volCloudMat.uniforms===p.volCloudFarMat.uniforms
        &&p.volCloudMat.defines.PRODUCTION_CLOUD_MEDIUM===1&&p.volCloudFarMat.defines.PRODUCTION_CLOUD_MEDIUM===1);
    } catch(error) {
      result.failure={message:String(error.message||error),stack:String(error.stack||error)};
    } finally {
      try {
        stream?.dispose();
        for(const bank of banks)bank.dispose();
        pass?.columnMaps.clear();pass?.columnRelease.clear();
        renderer?.setRenderTarget(null);target?.dispose();geometry?.dispose();
        p?.volCloudFarMat?.dispose();p?.volCloudMat?.dispose();
        for(const texture of textures)texture.dispose();
        disposeCloudNoiseTexture();renderer?.dispose();
        if(gl)glCheckpoint('after cleanup');
        result.cleanup={streamDisposed:stream?.disposed??null,banksDisposed:banks.every(bank=>bank.disposed)};
      } catch(error) {result.cleanupFailure={message:String(error.message||error),stack:String(error.stack||error)};}
    }
    return result;
  });
  report.finalFingerprint=await evidenceFingerprint(verifier);
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  assert.equal(report.finalFingerprint.sourceDigest,fingerprint.sourceDigest,'Runtime changed during capture');
  assert.equal(report.finalFingerprint.verifierDigest,fingerprint.verifierDigest,'Verifier changed during capture');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.driverWarnings,[]);
  assert.equal(report.result.failure,undefined,report.result.failure?.stack);
  assert.equal(report.result.cleanupFailure,undefined,report.result.cleanupFailure?.stack);
  assert.deepEqual(report.result.shaderErrors,[]);assert.equal(report.result.contextLosses,0);
  assert.ok(report.result.gl.length>0&&report.result.gl.every(check=>!check.lost&&check.errors.length===0));
  assert.ok(report.result.checks.length>=35&&report.result.checks.every(check=>check.pass));
  assert.equal(report.result.unsafeDisposals,0);
  assert.deepEqual(report.result.cleanup,{streamDisposed:true,banksDisposed:true});
  console.log(`PASS native column routing, real worker endpoints, safe bank handoff and sampler retirement. ${directory}/report.json`);
} catch(error) {
  report.failure={message:String(error.message||error),stack:String(error.stack||error)};
  await mkdir(directory,{recursive:true});
  await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  throw error;
} finally {
  try {await browser?.close();} finally {await new Promise(resolve=>server.close(resolve));}
}
