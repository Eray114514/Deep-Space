// Tiny native WebGL integration of the actual profiler hooks and volume pass.
// Diagnostic signed HDR volume input + production resolve/composite shaders;
// an 8x4, one-species column fixture is not formal column throughput, physical
// cloud equivalence, a normal-player test, or whole-page cold acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const verifier='tools/volumeprofilinggputest.js';
const directory=`test-results/volume-profiling/${new Date().toISOString().replace(/[:.]/g,'-')}`;
// Freeze the actual verifier before launch, so failures retain their own tool
// rather than requiring a later copy of a possibly repaired working tree.
const verifierBytes=await readFile(new URL(import.meta.url));
await mkdir(directory,{recursive:true});await writeFile(`${directory}/verifier.js`,verifierBytes);
const report={scope:'Small deterministic native HDR integration only: actual VolumetricPass render, GameLegacyPipeline profiling hooks, production resolve/composite, and an actual 8x4 one-species column producer. Diagnostic volume source and frozen synthetic forecasts; not physical cloud parity, formal column throughput, default-player, cold-start or performance acceptance.',
  verifierArchive:{path:`${directory}/verifier.js`,bytes:verifierBytes.length,
    sha256:createHash('sha256').update(verifierBytes).digest('hex')},
  before:await evidenceFingerprint(verifier),errors:[],warnings:[],driverWarnings:[]};
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
      if(/GL_INVALID|GL_CONTEXT_LOST|WebGL.*(?:error|lost)|Program object expected/i.test(message.text()))
        report.driverWarnings.push(message.text());
    }
  });
  await page.route('**/__volume-profiling',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>'}));
  await page.goto(`http://127.0.0.1:${port}/__volume-profiling`);
  report.result=await page.evaluate(async()=>{
    const T=await import('three');
    const {VolumetricPass,VOLUME_LAYER}=await import('/src/volumetric-pass-webgl.js');
    const {GameLegacyPipeline}=await import('/src/legacy-render-pipeline.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {PlanetWeatherStream}=await import('/src/cloud/planet-weather-stream.js');
    const result={checks:[],gl:[],shaderErrors:[],contextLosses:0,cases:[],comparisons:[],
      input:{width:32,height:32,volumeScale:.5,framesPerCase:10,columnWidth:8,columnRows:1,
        columnFootprintSamples:1,columnSpecies:1,columnSampleCap:128,frozenHours:.25,
        opaqueDepth:.5,opaqueDepthScope:'Real constant non-sky depth, so the full-field source-change control has matching low-resolution depth support.'}};
    const check=(name,condition)=>{
      result.checks.push({name,pass:Boolean(condition)});if(!condition)throw Error(name);
    };
    let renderer,gl,pass,pipeline,near,far,geometry,readBuffer,writeBuffer,rawBegin,rawEnd;
    const textures=[],materials=[],banks=[];
    let timerTarget,activeQuery=null,begins=0,ends=0,nested=0;
    const checkpoint=name=>{
      const errors=[];
      for(let i=0;i<16;i++){const value=gl.getError();if(!value)break;errors.push(value);}
      const lost=gl.isContextLost();result.gl.push({name,errors,lost});
      check(`GL0/context at ${name}`,errors.length===0&&!lost);
    };
    const sha256=async view=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',view.buffer))]
      .map(value=>value.toString(16).padStart(2,'0')).join('');
    const read=async target=>{
      const bits=new Uint16Array(target.width*target.height*4);
      renderer.readRenderTargetPixels(target,0,0,target.width,target.height,bits);
      let nonfinite=0,negativeRGB=0,hdrRGB=0,nonzeroRGB=0,maximumRGB=-Infinity;
      for(let i=0;i<bits.length;i++) {
        if((bits[i]&0x7c00)===0x7c00)nonfinite++;
        if(i%4===3)continue;
        const value=T.DataUtils.fromHalfFloat(bits[i]);
        if(value<0)negativeRGB++;if(value>1)hdrRGB++;if(value!==0)nonzeroRGB++;
        maximumRGB=Math.max(maximumRGB,value);
      }
      return {bits,metadata:{type:'Uint16Array/RGBA16F native bits',width:target.width,height:target.height,
        elements:bits.length,sha256:await sha256(bits),nonfinite,negativeRGB,hdrRGB,nonzeroRGB,maximumRGB}};
    };
    const compare=(a,b)=>{
      check('Compared native arrays have identical dimensions',a.length===b.length);
      let changed=0,alphaChanged=0,maximumError=0;
      for(let i=0;i<a.length;i++)if(a[i]!==b[i]) {
        changed++;if(i%4===3)alphaChanged++;
        maximumError=Math.max(maximumError,Math.abs(T.DataUtils.fromHalfFloat(a[i])-T.DataUtils.fromHalfFloat(b[i])));
      }
      return {changed,alphaChanged,maximumError};
    };
    try {
      renderer=new T.WebGLRenderer({antialias:false});renderer.setPixelRatio(1);renderer.setSize(32,32,false);
      renderer.toneMapping=T.NoToneMapping;gl=renderer.getContext();
      renderer.domElement.addEventListener('webglcontextlost',()=>result.contextLosses++);
      renderer.debug.onShaderError=(context,program,vertex,fragment)=>result.shaderErrors.push({
        program:context.getProgramInfoLog(program),vertex:context.getShaderInfoLog(vertex),fragment:context.getShaderInfoLog(fragment)});
      const debug=gl.getExtension('WEBGL_debug_renderer_info');
      result.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      result.userAgent=navigator.userAgent;
      check('Native hardware WebGL2',renderer.capabilities.isWebGL2&&!/swiftshader|llvmpipe|software/i.test(result.gpu));
      check('Half-float render targets supported',Boolean(gl.getExtension('EXT_color_buffer_float')));
      const ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');check('Native asynchronous GPU timers supported',Boolean(ext));
      timerTarget=ext.TIME_ELAPSED_EXT;rawBegin=gl.beginQuery;rawEnd=gl.endQuery;
      gl.beginQuery=function(target,query) {
        if(target===timerTarget) {
          if(activeQuery||gl.getQuery(target,gl.CURRENT_QUERY))nested++;
          check('GPU intervals never nest',nested===0);activeQuery=query;begins++;
        }
        return rawBegin.call(this,target,query);
      };
      gl.endQuery=function(target) {
        if(target===timerTarget) {check('GPU end owns an active interval',Boolean(activeQuery));activeQuery=null;ends++;}
        return rawEnd.call(this,target);
      };

      const texture=(data,width=1,height=1)=>{
        const value=new T.DataTexture(data,width,height,T.RGBAFormat,T.FloatType);
        value.minFilter=value.magFilter=T.NearestFilter;value.needsUpdate=true;textures.push(value);return value;
      };
      const low=texture(new Float32Array([1,.5,0,1])),high=texture(new Float32Array([1,.5,0,1]));
      const bounds=texture(new Float32Array([1000,1800,0,0]));
      const bands=new T.DataArrayTexture(new Float32Array(16*4),1,1,16);
      bands.image.data.set([1,1000,1800,1]);bands.format=T.RGBAFormat;bands.type=T.FloatType;
      bands.minFilter=bands.magFilter=T.LinearFilter;bands.needsUpdate=true;textures.push(bands);
      const parameters=new Float32Array(16*4*4);
      parameters.set([1000,0,0,.001],0);parameters.set([0,0,0,0],16*4);parameters.set([1,1,0,0],32*4);
      for(let i=0;i<64;i++)parameters[48*4+i]=i/63;
      const parameterTexture=texture(parameters,16,4);
      const noise=new T.Data3DTexture(new Uint8Array([128,128]),1,1,1);
      noise.format=T.RGFormat;noise.needsUpdate=true;textures.push(noise);
      const R=1000000,uniforms={
        uWeatherMap:{value:low},uWeatherMapHi:{value:high},uSpeciesMap:{value:bands},uBandBounds:{value:bounds},
        uNoise3:{value:noise},uSpeciesParameters:{value:parameterTexture},uSpeciesCount:{value:1},uSpeciesPartition:{value:0},
        uSpeciesMask:{value:-1},uBandsReady:{value:1},uCandidatesReady:{value:0},uCandidateLayers:{value:0},uMediumLayer:{value:0},
        uCloudAdvectionPhase:{value:0},uSpin:{value:new T.Matrix3()},uCOff:{value:new T.Vector3()},
        uBodyR:{value:R},uSurfaceRange:{value:1},uRin:{value:R},uRout:{value:R+5000},
        uColumnsReady:{value:0},uColumnsJointReady:{value:0},uColumnMix:{value:0},
        uOpticalColumns:{value:low},uOpticalColumnsNext:{value:low},uColumnHeights:{value:low},uColumnHeightsNext:{value:low},
        uCameraLocal:{value:new T.Vector3()},tSceneDepth:{value:null},uDepthReady:{value:0},uCameraFar:{value:1e8},
        uVolumeSize:{value:new T.Vector2()},uDepthInvProjection:{value:new T.Matrix4()},uDepthViewToLocal:{value:new T.Matrix3()},
        uOpaqueMinR:{value:R-1000},uOpaqueMaxR:{value:R+1000},uVariantShift:{value:0}};
      const vertexShader='varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0.0,1.0);}';
      near=new T.ShaderMaterial({uniforms,defines:{PRODUCTION_CLOUD_MEDIUM:1,CLOUD_FAR_VIEW:0,CLOUD_FAR_CACHE:0},vertexShader,
        fragmentShader:`varying vec2 vUv;uniform float uColumnsReady,uVariantShift;uniform sampler2D uOpticalColumns;
          void main(){float witness=uColumnsReady>.5?texture2D(uOpticalColumns,vUv).r:0.0;
            gl_FragColor=vec4(.625+vUv.x*.25+witness*.125+uVariantShift,-.125+vUv.y*.0625,.7,.35);}`,
        depthTest:false,depthWrite:false,blending:T.NoBlending});
      far=near.clone();far.uniforms=uniforms;far.defines.CLOUD_FAR_VIEW=1;
      geometry=new T.PlaneGeometry(2,2);
      const mesh=new T.Mesh(geometry,near);mesh.layers.set(VOLUME_LAYER);mesh.frustumCulled=false;
      const scene=new T.Scene();scene.add(mesh);
      const camera=new T.PerspectiveCamera(50,1,.1,1e8);camera.position.set(0,0,R+600000);camera.updateMatrixWorld(true);
      const stream={anchor:0,frameHours:1,ready:true,disposed:false,frames:new Map(),generations:new WeakMap(),generation:0,
        revisionAt:PlanetWeatherStream.prototype.revisionAt};
      for(const hours of [0,1,2])stream.frames.set(hours,{hours,low:low.image.data.slice(),high:high.image.data.slice(),
        bands:bands.image.data.slice(),bounds:bounds.image.data.slice()});
      const planet={R,posUniv:new T.Vector3(),weatherHours:.25,cloudSpinBase:0,weatherStream:stream,
        weatherField:{synoptic:true,windRadiansPerHour:0},volCloudBand:{rIn:R,rOut:R+5000},volCloudMat:near,volCloudFarMat:far,volCloudMesh:mesh};
      readBuffer=new T.WebGLRenderTarget(32,32,{type:T.HalfFloatType,depthBuffer:true,
        depthTexture:new T.DepthTexture(32,32,T.UnsignedIntType)});
      readBuffer.depthTexture.format=T.DepthFormat;
      writeBuffer=new T.WebGLRenderTarget(32,32,{type:T.HalfFloatType,depthBuffer:false});
      const baseMaterial=new T.ShaderMaterial({vertexShader,fragmentShader:`varying vec2 vUv;
        void main(){gl_FragDepth=.5;gl_FragColor=vec4(2.75+vUv.x,1.4+vUv.y,.9,1.0);}`});materials.push(baseMaterial);
      const baseScene=new T.Scene();baseScene.add(new T.Mesh(geometry,baseMaterial));
      renderer.setRenderTarget(readBuffer);renderer.render(baseScene,camera);renderer.setRenderTarget(null);
      pass=new VolumetricPass(scene,camera,{scale:.5});pass.setSize(32,32);pass.setActivePlanet(planet,new T.Vector3(),0);
      const originalRender=pass.render;
      // Only the real hooks are needed here. Constructing the complete game
      // composer would introduce unrelated atmosphere/post/light work.
      pipeline=Object.create(GameLegacyPipeline.prototype);
      Object.assign(pipeline,{renderer,volumePass:pass,composer:{passes:[pass]},profiler:null});
      const phases=['cloud-columns','volume-current','volume-resolve','volume-composite'];
      const captures=[];
      for(const [index,enabled] of [false,true,false,true].entries()) {
        pipeline.stopProfiling();
        for(const bank of pass.columnMaps.values())bank.dispose();pass.columnMaps.clear();
        const bank=new CloudColumnBank(planet,{width:8,rows:1,footprintSamples:1});banks.push(bank);
        pass.columnMaps.set(planet,bank);planet.cloudColumnMap=bank;
        pass.resetHistory();pass.frameState.invalidate('independent-profiler-case');
        if(enabled)pipeline.startProfiling({every:1,maxPending:128,history:100});
        const startsBefore=begins,endsBefore=ends;
        for(let frame=0;frame<result.input.framesPerCase;frame++) {
          pipeline.profiler?.beginFrame();pass.render(renderer,writeBuffer,readBuffer);
        }
        check(`case ${index}: complete real pair`,uniforms.uColumnsReady.value===1&&bank.maps.get(0)?.ready&&bank.maps.get(1)?.ready);
        check(`case ${index}: actual temporal branch enabled`,pass.resolveMaterial.uniforms.uHistoryValid.value===1
          &&pass.resolveMaterial.uniforms.uStationaryHistory.value===1);
        const capture={current:await read(pass.current),resolved:await read(pass.historyRead),final:await read(writeBuffer)};
        check(`case ${index}: signed current and HDR final occupied`,capture.current.metadata.negativeRGB>0
          &&capture.final.metadata.hdrRGB>0&&capture.final.metadata.nonzeroRGB>1000);
        check(`case ${index}: all native targets finite`,Object.values(capture).every(value=>value.metadata.nonfinite===0));
        let profile=null;
        if(enabled) {
          const deadline=performance.now()+10000;
          do {
            profile=pipeline.performanceSnapshot();if(!profile.pending)break;
            if(performance.now()>deadline)throw Error('Asynchronous profiler query completion deadline');
            await new Promise(resolve=>setTimeout(resolve,0));
          } while(true);
          check(`case ${index}: no skipped/discarded queries`,profile.skipped===0&&profile.discarded===0);
          for(const frame of new Set(profile.records.map(row=>row.frame))) {
            const rows=profile.records.filter(row=>row.frame===frame);
            check(`case ${index}, frame ${frame}: exact parent/children`,rows.map(row=>row.name).join('|')
              ===['0:VolumetricPass',...phases].join('|'));
            check(`case ${index}, frame ${frame}: inclusive CPU-only parent`,rows[0].scope==='cpu'
              &&rows[0].cpuInclusive===true&&rows[0].gpuMs===null&&Number.isFinite(rows[0].cpuMs));
            check(`case ${index}, frame ${frame}: complete nonnegative GPU children`,rows.slice(1).every(row=>row.scope==='gpu'
              &&row.cpuInclusive===true&&Number.isFinite(row.gpuMs)&&row.gpuMs>=0));
          }
          check(`case ${index}: all ten frame records`,new Set(profile.records.map(row=>row.frame)).size===10);
        }
        const started=begins-startsBefore,ended=ends-endsBefore;
        check(`case ${index}: query count`,started===(enabled?40:0)&&ended===started&&!activeQuery);
        const columnPixel=new Uint8Array(4);renderer.readRenderTargetPixels(bank.maps.get(0).target,0,0,1,1,columnPixel);
        check(`case ${index}: actual column optical output occupied`,columnPixel[0]>0);
        const stopped=pipeline.profiler;pipeline.stopProfiling();
        check(`case ${index}: stop detaches/restores`,pass.profiler===null&&pass.render===originalRender
          &&(!stopped||stopped.disposed));
        result.cases.push({index,profiling:enabled,profile,queries:{started,ended},columnPixel:Array.from(columnPixel),
          targets:Object.fromEntries(Object.entries(capture).map(([name,value])=>[name,value.metadata]))});
        captures.push(capture);checkpoint(`case ${index}`);
      }
      for(const [a,b,label] of [[0,1,'off/on'],[0,2,'off native repeat'],[1,3,'on native repeat'],[2,3,'repeat off/on']]) {
        const stages=Object.fromEntries(['current','resolved','final'].map(stage=>[stage,compare(captures[a][stage].bits,captures[b][stage].bits)]));
        result.comparisons.push({label,stages});
        check(`${label}: native HDR bit-exact at all three targets`,Object.values(stages).every(delta=>delta.changed===0));
      }
      const beforeNegative=begins;uniforms.uVariantShift.value=.25;pass.resetHistory();pass.render(renderer,writeBuffer,readBuffer);
      const negative={current:await read(pass.current),resolved:await read(pass.historyRead),final:await read(writeBuffer)};
      const program=renderer.properties.get(mesh.material).currentProgram;
      const shiftLocation=program?.program&&gl.getUniformLocation(program.program,'uVariantShift');
      result.negative={...compare(captures[3].final.bits,negative.final.bits),
        requestedShift:uniforms.uVariantShift.value,
        uploadedShift:shiftLocation?gl.getUniform(program.program,shiftLocation):null,
        stages:Object.fromEntries(['current','resolved','final'].map(stage=>[stage,{
          ...compare(captures[3][stage].bits,negative[stage].bits),...negative[stage].metadata}]))};
      check('Changed source uniform actually uploaded',result.negative.uploadedShift===.25);
      check('Changed source reaches current and production resolve',result.negative.stages.current.changed===16*16
        &&result.negative.stages.resolved.changed===16*16
        &&['current','resolved'].every(stage=>result.negative.stages[stage].alphaChanged===0));
      check('Changed signed HDR source is detected',Object.values(negative).every(value=>value.metadata.nonfinite===0)
        &&result.negative.changed>1000&&result.negative.alphaChanged===0);
      check('Stopped profiler emits no queries',begins===beforeNegative&&pass.profiler===null);
      result.queries={begins,ends,nested,active:Boolean(activeQuery)};
      check('All native GPU intervals balanced/non-nested',begins===ends&&nested===0&&!activeQuery);checkpoint('final');
    } catch(error) {result.failure={message:String(error.message||error),stack:String(error.stack||error)};}
    finally {
      try {
        pipeline?.stopProfiling();pass?.dispose();for(const bank of banks)bank.dispose();
        renderer?.setRenderTarget(null);readBuffer?.dispose();writeBuffer?.dispose();
        near?.dispose();far?.dispose();geometry?.dispose();materials.forEach(value=>value.dispose());textures.forEach(value=>value.dispose());
        if(gl&&rawBegin){gl.beginQuery=rawBegin;gl.endQuery=rawEnd;}
        renderer?.dispose();if(gl)checkpoint('cleanup');
      } catch(error) {result.cleanupFailure={message:String(error.message||error),stack:String(error.stack||error)};}
    }
    return result;
  });
  report.after=await evidenceFingerprint(verifier);
  await mkdir(directory,{recursive:true});await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));
  assert.equal(report.after.sourceDigest,report.before.sourceDigest,'Runtime changed during GPU capture');
  assert.equal(report.after.verifierDigest,report.before.verifierDigest,'Verifier changed during GPU capture');
  assert.deepEqual(report.errors,[]);assert.deepEqual(report.driverWarnings,[]);
  assert.equal(report.result.failure,undefined,report.result.failure?.stack);
  assert.equal(report.result.cleanupFailure,undefined,report.result.cleanupFailure?.stack);
  assert.deepEqual(report.result.shaderErrors,[]);assert.equal(report.result.contextLosses,0);
  assert.equal(report.result.cases.length,4);assert.equal(report.result.comparisons.length,4);
  assert.ok(report.result.gl.length>=6&&report.result.gl.every(row=>row.errors.length===0&&!row.lost));
  assert.ok(report.result.checks.every(row=>row.pass));
  console.log(`PASS: native HDR off/on/repeat, real GPU profiler stages and restored hooks; ${directory}/report.json`);
} catch(error) {
  report.failure={message:String(error.message||error),stack:String(error.stack||error)};
  await mkdir(directory,{recursive:true});await writeFile(`${directory}/report.json`,JSON.stringify(report,null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
