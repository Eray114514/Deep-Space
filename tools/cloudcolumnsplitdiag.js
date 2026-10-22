// Tool-only experiment: retain every production footprint and its serial
// addition order, but carry nine accumulator floats across smaller draws.
// --static exercises shader generation/contracts without a browser or GPU.
// The 48 MiB full-size working pingpong is intentionally not a shipping budget.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import * as THREE from 'three';
import {CloudColumnMap} from '../src/cloud/cloud-column-map.js';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

// Closure-free: the browser applies this exact generator to an actual
// homePlanet CloudColumnMap material, rather than a copied production shader.
function splitColumnFragment(original) {
  const require=(condition,message)=>{if(!condition)throw new Error(message);};
  const once=(source,needle,replacement,label)=>{
    require(source.split(needle).length===2,`${label}: expected one exact anchor`);
    return source.replace(needle,replacement);
  };
  const closeBrace=(source,open)=>{
    let depth=0,lineComment=false,blockComment=false;
    for(let i=open;i<source.length;i++) {
      if(lineComment) {if(source[i]==='\n')lineComment=false;continue;}
      if(blockComment) {if(source[i]==='*'&&source[i+1]==='/'){blockComment=false;i++;}continue;}
      if(source[i]==='/'&&source[i+1]==='/'){lineComment=true;i++;continue;}
      if(source[i]==='/'&&source[i+1]==='*'){blockComment=true;i++;continue;}
      if(source[i]==='{')depth++;
      else if(source[i]==='}'&&--depth===0)return i;
    }
    throw new Error('Unbalanced production shader body');
  };
  const loop='for(int p=0;p<uFootprintSamples;p++) {';
  const splitLoop='for(int p=uFootprintStart;p<uFootprintStart+uFootprintCount;p++) {';
  const initial='vec4 total=vec4(0);vec2 altitudeMoment=vec2(0),weightMoment=vec2(0);float jointOpacity=0.0;';
  const tail=`total/=float(uFootprintSamples);
          optical=vec4(total.xy,log(vec2(1)+total.zw)/log(129.0));
          heights=vec4(altitudeMoment/max(weightMoment,vec2(0.000001)),jointOpacity/float(uFootprintSamples),1);`;
  const output='layout(location=1) out vec4 heights;';
  require(!/uFootprintStart|uFootprintCount|uSplitPrevious|COLUMN_SPLIT_FINAL|splitCarry/.test(original),
    'Production shader already contains split-experiment identifiers');
  require(original.split(loop).length===2,'Original footprint loop changed');
  const loopStart=original.indexOf(loop),open=loopStart+loop.length-1,close=closeBrace(original,open);
  const body=original.slice(open+1,close);
  require(body.includes('(float(p)+0.5)/float(uFootprintSamples)'), 'Global footprint denominator changed');
  require(body.includes('fract((float(p)+0.5)*0.61803398875)'), 'Global footprint index changed');
  require(body.includes('total+=vec4(opacity,tau);')&&body.includes('jointOpacity+=1.0-exp(-tau.x-tau.y);')
    &&body.includes('altitudeMoment+=moment;weightMoment+=opacity;'), 'Raw serial accumulation changed');
  const declarations=`${output}
        #if COLUMN_SPLIT_FINAL == 0
          layout(location=2) out vec4 splitCarry;
        #endif
        uniform int uFootprintStart,uFootprintCount;
        uniform sampler2D uSplitPreviousTotal,uSplitPreviousMoments,uSplitPreviousJoint;`;
  const restore=`${initial}
          if(uFootprintStart>0) {
            ivec2 cell=ivec2(gl_FragCoord.xy);
            total=texelFetch(uSplitPreviousTotal,cell,0);
            vec4 savedMoments=texelFetch(uSplitPreviousMoments,cell,0);
            altitudeMoment=savedMoments.xy;weightMoment=savedMoments.zw;
            jointOpacity=texelFetch(uSplitPreviousJoint,cell,0).x;
          }`;
  const finish=`#if COLUMN_SPLIT_FINAL == 1
          ${tail}
          #else
            optical=total;
            heights=vec4(altitudeMoment,weightMoment);
            splitCarry=vec4(jointOpacity,0.0,0.0,0.0);
          #endif`;
  let source=once(original,output,declarations,'MRT declarations');
  source=once(source,initial,restore,'Accumulator initialization');
  source=once(source,loop,splitLoop,'Consecutive footprint range');
  source=once(source,tail,finish,'Only final draw normalizes');
  const splitStart=source.indexOf(splitLoop),splitOpen=splitStart+splitLoop.length-1;
  require(source.slice(splitOpen+1,closeBrace(source,splitOpen))===body,'Per-footprint body changed');
  require(source.includes(tail)&&source.split(tail).length===2,'Final production expressions changed');
  // Reversibility also guards the density prefix, height loop, and every
  // expression outside the four narrowly defined wrapper replacements.
  let reversed=once(source,finish,tail,'Reverse final wrapper');
  reversed=once(reversed,splitLoop,loop,'Reverse loop wrapper');
  reversed=once(reversed,restore,initial,'Reverse initialization wrapper');
  reversed=once(reversed,declarations,output,'Reverse MRT wrapper');
  require(reversed===original,'Unexpected production text mutation');
  const schedules={};
  for(const count of [8,16]) {
    const ranges=Array.from({length:64/count},(_,index)=>({start:index*count,count,final:(index+1)*count===64}));
    const indices=ranges.flatMap(range=>Array.from({length:range.count},(_,index)=>range.start+index));
    require(indices.length===64&&indices.every((value,index)=>value===index),'Dropped/reordered footprint');
    schedules[count]=ranges;
  }
  return {source,body,tail,schedules,proof:{exactReplacementCount:4,productionTextReversible:true,
    perFootprintBodyUnchanged:true,normalizationUnchanged:true,globalIndexAndDenominatorUnchanged:true,
    accumulatorFloats:9,workingAttachments:3,canonicalAttachments:2}};
}

function staticShaderContract() {
  const atlas=new THREE.DataTexture(new Float32Array([1,.5,0,0]),1,1,THREE.RGBAFormat,THREE.FloatType);
  const species=new THREE.DataArrayTexture(new Float32Array(16*4),1,1,16);
  species.type=THREE.FloatType;species.format=THREE.RGBAFormat;
  const planet={weatherHours:0,cloudSpinBase:0,weatherField:{windRadiansPerHour:0},volCloudMat:{
    defines:{PRODUCTION_CLOUD_MEDIUM:1,CLOUD_FAR_VIEW:0,CLOUD_FAR_CACHE:0},uniforms:{
      uSpeciesMask:{value:-1},uWeatherMap:{value:atlas},uWeatherMapHi:{value:atlas},
      uSpeciesMap:{value:species},uBandBounds:{value:atlas}}}};
  const map=new CloudColumnMap(planet,{width:1024,samples:128,footprintSamples:64});
  try {
    const original=map.material.fragmentShader,derived=splitColumnFragment(original);
    const digest=source=>createHash('sha256').update(source).digest('hex');
    assert.equal(map.width,1024);assert.equal(map.height,512);assert.equal(map.samples,128);assert.equal(map.footprintSamples,64);
    // Deliberately corrupt one unique anchor. A drifting producer must stop
    // generation, rather than silently producing a different experiment.
    assert.throws(()=>splitColumnFragment(original.replace('total/=float(uFootprintSamples);','total*=1.0/64.0;')));
    assert.throws(()=>splitColumnFragment(original.replace('for(int p=0;p<uFootprintSamples;p++) {','for(int p=1;p<uFootprintSamples;p++) {')));
    return {mode:'static-only, no GL context',proof:derived.proof,schedules:derived.schedules,
      originalSha256:digest(original),splitSha256:digest(derived.source),bodySha256:digest(derived.body),tailSha256:digest(derived.tail)};
  } finally {map.dispose();atlas.dispose();species.dispose();}
}

assert.ok(process.argv.slice(2).every(value=>value==='--static'),'Only --static is supported');
const staticContract=staticShaderContract();
if(process.argv.includes('--static')) {
  console.log(JSON.stringify({status:'static-contract-passed',...staticContract},null,2));
} else {
  const verifier='tools/cloudcolumnsplitdiag.js';
  const out=`test-results/cloud-column-split/${new Date().toISOString().replace(/[:.]/g,'-')}`;
  await mkdir(out,{recursive:true});
  const report={status:'running',before:await evidenceFingerprint(verifier),staticContract,errors:[],warnings:[],driverWarnings:[],
    scope:'Four actual homePlanet formal-size two-row windows, two native repetitions per variant. No complete atlas, player image, forecast deadline, or production GPU-budget acceptance.',
    floatingPointRisk:'The original per-footprint arithmetic and serial addition order remain exact text. Cross-draw RGBA32F writes introduce explicit float32 boundaries and a different compiled program; register precision, contraction and loop optimization can still change native bits. Any optical RGBA8 or heights RGBA16F bit difference rejects this candidate.',
    timingScope:'Each real draw has a separate non-nested GPU query; all intervals end before target/state restoration or cleanup. Fence/query completion and readback are outside those intervals. Query counts and inter-draw gaps differ, so interval sums or local quantum costs are not a throughput comparison or whole-frame budget.'};
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
        if(/GL_INVALID|GL_CONTEXT_LOST|Program object expected|WebGL.*(?:error|lost)/i.test(message.text()))report.driverWarnings.push(message.text());
      }
    });
    await page.addInitScript({content:`globalThis.__splitColumnFragment=(${splitColumnFragment.toString()});`});
    await page.route('**/column-split.html',route=>route.fulfill({contentType:'text/html',body:
      '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>'}));
    await page.goto(`http://127.0.0.1:${port}/column-split.html`);
    report.result=await page.evaluate(async()=>{
      const T=await import('three'),{Planet}=await import('/src/planet.js');
      const {GalaxyCatalog,HOME_SYSTEM_ID}=await import('/src/galaxy-layout.js');
      const {generateSystemSpec}=await import('/src/astronomy.js');
      const {ACTIVE_GALAXY_ID,getGalaxyConfig,resolveBodyTuning,applySystemBodyTuning}=await import('/src/world-config.js');
      const {createGameRenderer}=await import('/src/renderer-runtime.js');
      const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
      const result={options:{width:1024,height:512,heightSamples:128,footprintSamples:64,rows:2,
        rowWindows:[0,192,256,384],chunkSizes:[8,16],repetitions:2},gl:[],shaderErrors:[],contextLosses:0,
        firstMeasurements:[],runs:[],parity:[],workingMemory:{groups:2,attachmentsPerGroup:3,type:'RGBA32F',
          bytes:2*3*1024*512*4*4,MiB:48,scope:'Working render targets only; canonical targets, source snapshots, programs and driver allocation are additional. A shipping design needs a local working tile.'}};
      const maps=[],extraMaterials=[],working=[],pendingQueries=new Set();
      let p,r,gl,ext,queryOpen=false;
      const require=(condition,message)=>{if(!condition)throw new Error(message);};
      const checkpoint=label=>{
        const errors=[];
        for(let i=0;i<16;i++){const code=gl.getError();if(!code)break;errors.push(code);}
        const state={label,errors,lost:gl.isContextLost()};result.gl.push(state);
        require(errors.length===0&&!state.lost,`${label}: GL/context failure ${errors}`);return state;
      };
      const hash=async view=>{
        const bytes=typeof view==='string'?new TextEncoder().encode(view):new Uint8Array(view.buffer,view.byteOffset,view.byteLength);
        return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
      };
      // Wait for every query together, with one explicit fence after the last
      // submitted draw. Per-query first observation times are not serialized.
      async function complete(draws,label) {
        require(!queryOpen,'A GPU query remained open at completion');
        const submittedAt=performance.now(),deadline=submittedAt+120000;
        let sync=null,fenceObservedMs=null;
        try {
          sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);require(sync,'Fence allocation failed');gl.flush();
          while(fenceObservedMs===null||draws.some(draw=>draw.gpuMs===undefined)) {
            require(!gl.isContextLost()&&performance.now()<deadline,`${label}: GPU completion unavailable`);
            require(!gl.getParameter(ext.GPU_DISJOINT_EXT),`${label}: GPU disjoint invalidates the entire group`);
            const now=performance.now();
            if(fenceObservedMs===null) {
              const status=gl.clientWaitSync(sync,0,0);
              require(status!==gl.WAIT_FAILED,`${label}: fence wait failed`);
              if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)fenceObservedMs=now-submittedAt;
            }
            for(const draw of draws)if(draw.gpuMs===undefined&&gl.getQueryParameter(draw.query,gl.QUERY_RESULT_AVAILABLE)) {
              draw.availableObservedMs=now-submittedAt;
              draw.gpuMs=gl.getQueryParameter(draw.query,gl.QUERY_RESULT)/1e6;
              require(Number.isFinite(draw.gpuMs)&&draw.gpuMs>=0,`${label}: invalid GPU timer`);
            }
            if(fenceObservedMs===null||draws.some(draw=>draw.gpuMs===undefined))await new Promise(resolve=>setTimeout(resolve,5));
          }
          require(!gl.getParameter(ext.GPU_DISJOINT_EXT),`${label}: final disjoint`);
          checkpoint(`${label} completed`);
          return {fenceObservedMs,pollIntervalMs:5,completionWallMs:performance.now()-submittedAt};
        } finally {
          if(sync)gl.deleteSync(sync);
          for(const draw of draws){gl.deleteQuery(draw.query);pendingQueries.delete(draw);delete draw.query;}
        }
      }
      try {
        const seed=getGalaxyConfig(ACTIVE_GALAXY_ID).seed,star=new GalaxyCatalog(seed).getSystem(HOME_SYSTEM_ID);
        const spec=applySystemBodyTuning(generateSystemSpec(seed,star),id=>resolveBodyTuning(ACTIVE_GALAXY_ID,star.id,id)).bodies[0];
        p=new Planet({seed:spec.seed,name:spec.name,catalogName:spec.catalogName,posUniv:new T.Vector3(),
          type:spec.type,isMoon:spec.isMoon,radius:spec.radius,atmosphere:spec.atmosphere,clouds:spec.clouds,
          tuning:resolveBodyTuning(ACTIVE_GALAXY_ID,star.id,spec.bodyId),formation:spec.formation,ringSystem:spec.ringSystem});
        ({renderer:r}=await createGameRenderer({},{canvas:document.querySelector('#fixture')}));
        r.setPixelRatio(1);r.setSize(64,64,false);r.info.autoReset=false;
        gl=r.getContext();ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');
        require(ext&&gl.getExtension('EXT_color_buffer_float'),'Native GPU timers and float color targets are required');
        require(gl.getParameter(gl.MAX_DRAW_BUFFERS)>=3&&gl.getParameter(gl.MAX_COLOR_ATTACHMENTS)>=3,'Three working MRT attachments required');
        const debug=gl.getExtension('WEBGL_debug_renderer_info');
        result.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
        require(!/swiftshader|llvmpipe|software/i.test(result.gpu),'Native hardware adapter required');
        result.fragmentHighp=(()=>{const info=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);
          return {precision:info.precision,rangeMin:info.rangeMin,rangeMax:info.rangeMax};})();
        r.domElement.addEventListener('webglcontextlost',()=>result.contextLosses++);
        r.debug.onShaderError=(context,program,vertex,fragment)=>result.shaderErrors.push({
          program:context.getProgramInfoLog(program),vertex:context.getShaderInfoLog(vertex),fragment:context.getShaderInfoLog(fragment)});
        require(p.weatherHours===0&&!p.weatherStream&&p.weatherField.synoptic&&p.volCloudMat,'Actual constructor-published production homePlanet required');
        require(p.volCloudMat.uniforms.uSpeciesPartition.value===1&&p.volCloudMat.uniforms.uSpeciesMask.value===-1,'All-species production partition required');
        result.identity={seed,systemId:star.id,bodyId:spec.bodyId,bodySeed:spec.seed,type:p.type,radius:p.R};
        const inputDigest=async()=>({kind:'Actual authored constructor-published homePlanet textures',hours:p.weatherHours,
          partition:p.volCloudMat.uniforms.uSpeciesPartition.value,speciesMask:p.volCloudMat.uniforms.uSpeciesMask.value,
          fields:await Promise.all(['uWeatherMap','uWeatherMapHi','uSpeciesMap','uBandBounds','uNoise3','uSpeciesParameters'].map(async name=>{
            const texture=p.volCloudMat.uniforms[name].value,image=texture.image;
            return {name,width:image.width,height:image.height,depth:image.depth??1,type:texture.type,
              bytes:image.data.byteLength,sha256:await hash(image.data)};
          }))});
        result.inputBefore=await inputDigest();
        const options={width:1024,samples:128,footprintSamples:64,hours:0};
        const native=new CloudColumnMap(p,options);maps.push(native);
        const original=native.material.fragmentShader,derived=globalThis.__splitColumnFragment(original);
        result.shaders={original,split:derived.source,proof:derived.proof,schedules:derived.schedules,
          originalSha256:await hash(original),splitSha256:await hash(derived.source),bodySha256:await hash(derived.body),tailSha256:await hash(derived.tail)};
        const variants={native:{map:native}};
        for(const count of [8,16]) {
          const map=new CloudColumnMap(p,options);maps.push(map);
          require(map.material.fragmentShader===original,'Variant source shader changed');
          map.material.fragmentShader=derived.source;map.material.defines.COLUMN_SPLIT_FINAL=0;
          Object.assign(map.material.uniforms,{uFootprintStart:{value:0},uFootprintCount:{value:count},
            uSplitPreviousTotal:{value:null},uSplitPreviousMoments:{value:null},uSplitPreviousJoint:{value:null}});
          const final=map.material.clone();final.uniforms=map.material.uniforms;final.defines.COLUMN_SPLIT_FINAL=1;
          extraMaterials.push(final);variants[`split${count}`]={map,work:map.material,final,count};
        }
        for(let group=0;group<2;group++) {
          const target=new T.WebGLRenderTarget(1024,512,{count:3,type:T.FloatType,format:T.RGBAFormat,
            minFilter:T.NearestFilter,magFilter:T.NearestFilter,depthBuffer:false,stencilBuffer:false});
          for(const texture of target.textures) {
            texture.type=T.FloatType;texture.format=T.RGBAFormat;texture.internalFormat='RGBA32F';
            texture.minFilter=texture.magFilter=T.NearestFilter;texture.generateMipmaps=false;texture.colorSpace=T.NoColorSpace;
          }
          working.push(target);
        }
        require(new Set(working.flatMap(target=>target.textures)).size===6,'Pingpong textures must have distinct ownership');
        const allocationStarted=performance.now();
        for(const target of [...working,...maps.map(map=>map.target)]) {
          r.initRenderTarget(target);r.setRenderTarget(target);r.clear(true,false,false);
          require(gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE,'Incomplete initialized framebuffer');
        }
        r.setRenderTarget(null);result.targetInitializationMs=performance.now()-allocationStarted;
        checkpoint('All working/canonical allocations outside timer');

        function measuredDraw(variant,row,target,material,range) {
          const map=variant.map,quad=map.quad,render=quad.render,originalTarget=map.target,originalMaterial=quad.material;
          const record={row,rows:2,start:range.start,count:range.count,final:range.final,
            targetAttachments:target.textures.length,queryEndsBeforeBakeStateRestore:true,resourceCleanupAfterFence:true};
          const oldCalls=r.info.render.calls;
          require(!map.disposed&&!map.ready&&map.width===1024&&map.height===512&&map.samples===128
            &&material.uniforms.uFootprintSamples.value===64,'Formal production samples/dimensions changed');
          map.row=row;map.target=target;quad.material=material;
          quad.render=function(...args) {
            require(!queryOpen&&gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)===null,'Nested GPU query');
            const query=gl.createQuery();require(query,'Query allocation failed');
            record.query=query;pendingQueries.add(record);
            gl.beginQuery(ext.TIME_ELAPSED_EXT,query);queryOpen=true;
            const started=performance.now();let output;
            try {output=render.apply(this,args);}
            finally {record.drawSubmitMs=performance.now()-started;gl.endQuery(ext.TIME_ELAPSED_EXT);queryOpen=false;}
            // Reflection/FBO queries are outside the GPU interval, while this
            // draw's actual target is still bound by production bakeSlice.
            const program=r.properties.get(material).currentProgram;
            require(program?.program,'Missing native program after draw');
            record.programId=program.id;
            record.outputs={optical:gl.getFragDataLocation(program.program,'optical'),heights:gl.getFragDataLocation(program.program,'heights'),
              splitCarry:gl.getFragDataLocation(program.program,'splitCarry')};
            record.drawBuffers=[0,1,2].map(index=>gl.getParameter(gl.DRAW_BUFFER0+index));
            record.framebufferComplete=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
            require(record.framebufferComplete&&record.outputs.optical===0&&record.outputs.heights===1,'Invalid dual canonical outputs');
            if(target.textures.length===3)require(record.outputs.splitCarry===2&&record.drawBuffers[2]===gl.COLOR_ATTACHMENT2,'Missing working carry attachment');
            else require(record.outputs.splitCarry===-1&&record.drawBuffers[2]===gl.NONE,'Final program must not write an unattached third output');
            return output;
          };
          const started=performance.now();
          try {map.bakeSlice(r,2);}
          finally {quad.render=render;quad.material=originalMaterial;map.target=originalTarget;}
          record.bakeSubmitMs=performance.now()-started;record.drawCalls=r.info.render.calls-oldCalls;
          require(record.drawCalls===1&&map.row===row+2&&!map.ready,'Each quantum must submit one two-row draw');
          checkpoint(`Submitted row ${row} p${range.start}+${range.count}`);
          return record;
        }
        async function run(name,row,repetition,phase) {
          const variant=variants[name],draws=[],started=performance.now();
          require(!gl.getParameter(ext.GPU_DISJOINT_EXT),'GPU disjoint before group');
          if(name==='native')draws.push(measuredDraw(variant,row,variant.map.target,variant.map.material,{start:0,count:64,final:true}));
          else {
            const u=variant.work.uniforms;
            for(const range of derived.schedules[variant.count]) {
              const index=range.start/variant.count,output=working[index%2],previous=working[(index+1)%2];
              require(output!==previous,'Working read/write feedback');
              u.uFootprintStart.value=range.start;u.uFootprintCount.value=range.count;
              u.uSplitPreviousTotal.value=previous.textures[0];u.uSplitPreviousMoments.value=previous.textures[1];
              u.uSplitPreviousJoint.value=previous.textures[2];
              draws.push(measuredDraw(variant,row,range.final?variant.map.target:output,range.final?variant.final:variant.work,range));
            }
          }
          const enqueueMs=performance.now()-started,completion=await complete(draws,`${phase} ${name} row ${row}`);
          return {name,row,repetition,phase,queryCount:draws.length,enqueueMs,...completion,draws,
            observedIntervalSumMs:draws.reduce((sum,draw)=>sum+draw.gpuMs,0),
            largestObservedQuantumMs:Math.max(...draws.map(draw=>draw.gpuMs)),
            warning:'Separate per-draw intervals plus diagnostic query/fence pacing; neither sum nor wall time proves native-equivalent throughput.'};
        }
        function read(map,row) {
          const optical=new Uint8Array(1024*2*4),heights=new Uint16Array(1024*2*4);
          const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
          try {
            r.setRenderTarget(map.target);r.readRenderTargetPixels(map.target,0,row,1024,2,optical);
            r.readRenderTargetPixels(map.target,0,row,1024,2,heights,undefined,1);
          } finally {r.setRenderTarget(saved,face,mip);}
          checkpoint(`Read native bits row ${row}`);
          let nonfinite=0,invalidAlpha=0,occupied=0;
          for(let i=0;i<heights.length;i++)if((heights[i]&0x7c00)===0x7c00)nonfinite++;
          for(let i=3;i<heights.length;i+=4)if(heights[i]!==0x3c00)invalidAlpha++;
          for(let i=0;i<optical.length;i+=4)if(optical[i]||optical[i+1])occupied++;
          require(nonfinite===0&&invalidAlpha===0,'Nonfinite/incomplete canonical native output');
          return {optical,heights,occupied,nonfinite,invalidAlpha};
        }
        const metadata=async data=>({occupied:data.occupied,nonfinite:data.nonfinite,invalidAlpha:data.invalidAlpha,
          optical:{storage:'RGBA8 native bytes',elements:data.optical.length,sha256:await hash(data.optical)},
          heights:{storage:'RGBA16F native Uint16 bits',elements:data.heights.length,sha256:await hash(data.heights)}});
        const difference=(a,b)=>Object.fromEntries(['optical','heights'].map(name=>{
          require(a[name].length===b[name].length,'Native readback size changed');
          let changed=0;const first=[];
          for(let i=0;i<a[name].length;i++)if(a[name][i]!==b[name][i]) {
            changed++;if(first.length<8)first.push({index:i,reference:a[name][i],candidate:b[name][i]});
          }
          return [name,{changed,first}];
        }));
        // These are variant-first measurements, not a fresh-driver cold-start
        // claim. They prime both work and final programs before repeated rows.
        for(const name of ['native','split8','split16'])result.firstMeasurements.push(await run(name,0,-1,'first-measurement'));
        for(const row of result.options.rowWindows) {
          const captures={native:[],split8:[],split16:[]};
          for(let repetition=0;repetition<2;repetition++) {
            const order=repetition===0?['native','split8','split16']:['split16','split8','native'];
            for(const name of order) {
              const sample=await run(name,row,repetition,'repeated-row');
              const data=read(variants[name].map,row);sample.native=await metadata(data);
              result.runs.push(sample);captures[name].push(data);
            }
          }
          result.parity.push({row,nativeRepeat:difference(captures.native[0],captures.native[1]),
            candidates:[8,16].map(count=>({count,repeat:difference(captures[`split${count}`][0],captures[`split${count}`][1]),
              versusNative:captures[`split${count}`].map((data,index)=>difference(captures.native[index],data))}))});
        }
        result.inputAfter=await inputDigest();checkpoint('Final row-window result');
      } catch(error) {result.failure={message:String(error.message||error),stack:String(error.stack||error)};}
      finally {
        const faults=[];
        const cleanup=(label,action)=>{
          try {action();} catch(error) {faults.push({label,message:String(error.message||error),stack:String(error.stack||error)});}
        };
        cleanup('Close active query',()=>{if(queryOpen){gl.endQuery(ext.TIME_ELAPSED_EXT);queryOpen=false;}});
        // An invalid timer/fence must not skip disposal of unrelated resources.
        try {if(pendingQueries.size&&!gl.isContextLost())await complete([...pendingQueries],'failure cleanup drain');}
        catch(error) {faults.push({label:'GPU drain',message:String(error.message||error),stack:String(error.stack||error)});}
        for(const draw of pendingQueries)cleanup('Delete remaining query',()=>{gl.deleteQuery(draw.query);delete draw.query;});
        pendingQueries.clear();
        cleanup('Unbind target',()=>r?.setRenderTarget(null));
        for(const material of extraMaterials)cleanup('Dispose final material',()=>material.dispose());
        for(const map of maps)cleanup('Dispose column map',()=>map.dispose());
        for(const target of working)cleanup('Dispose working target',()=>target.dispose());
        cleanup('Dispose homePlanet',()=>p?.dispose());
        cleanup('Dispose renderer',()=>r?.dispose());
        cleanup('Final GL checkpoint',()=>{if(gl)checkpoint('After resource cleanup');});
        result.cleanup={pendingQueries:pendingQueries.size,queryOpen,mapsDisposed:maps.every(map=>map.disposed)};
        if(faults.length)result.cleanupFailure={faults};
      }
      return result;
    });
    report.after=await evidenceFingerprint(verifier);
    const shaders=report.result.shaders;
    if(shaders) {
      await writeFile(`${out}/original.frag`,shaders.original);
      await writeFile(`${out}/split.frag`,shaders.split);
      delete shaders.original;delete shaders.split;
    }
    const zero=value=>value.optical.changed===0&&value.heights.changed===0;
    const parity=report.result.parity;
    report.exactRowWindowParity=parity.length===4&&parity.every(row=>zero(row.nativeRepeat)
      &&row.candidates.every(candidate=>zero(candidate.repeat)&&candidate.versusNative.every(zero)));
    report.status=report.result.failure||report.result.cleanupFailure?'invalid-diagnostic':'captured-pending-validation';
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
    assert.deepEqual(report.before,report.after,'Source/verifier changed during capture');
    assert.deepEqual(report.errors,[]);assert.deepEqual(report.driverWarnings,[]);
    assert.equal(report.result.failure,undefined,report.result.failure?.stack);
    assert.equal(report.result.cleanupFailure,undefined,report.result.cleanupFailure?.stack);
    assert.deepEqual(report.result.shaderErrors,[]);assert.equal(report.result.contextLosses,0);
    assert.ok(report.result.gl.length>0&&report.result.gl.every(state=>state.errors.length===0&&!state.lost));
    assert.deepEqual(report.result.inputBefore,report.result.inputAfter,'Actual production inputs changed');
    assert.equal(shaders.originalSha256,staticContract.originalSha256,'Browser source differs from statically checked producer');
    assert.equal(shaders.splitSha256,staticContract.splitSha256,'Browser generator differs from static contract');
    assert.equal(report.result.firstMeasurements.length,3);assert.equal(report.result.runs.length,24);
    assert.ok(report.result.runs.some(run=>run.native.occupied>0),'Windows must exercise actual occupied cloud output');
    assert.deepEqual(report.result.cleanup,{pendingQueries:0,queryOpen:false,mapsDisposed:true});
    report.captureValid=true;
    report.status=report.exactRowWindowParity?'accepted-exact-row-windows-only':'rejected-native-bit-difference';
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
    assert.equal(report.exactRowWindowParity,true,'Any native optical/height bit difference rejects the split experiment');
    console.log(JSON.stringify({status:report.status,report:`${out}/report.json`,scope:report.scope,
      quantumObservations:report.result.runs.map(run=>({name:run.name,row:run.row,repetition:run.repetition,
        queryCount:run.queryCount,largestObservedQuantumMs:run.largestObservedQuantumMs,observedIntervalSumMs:run.observedIntervalSumMs}))},null,2));
  } catch(error) {
    if(!report.captureValid||report.status!=='rejected-native-bit-difference')report.status='invalid-diagnostic';
    report.failure={message:String(error.message||error),stack:String(error.stack||error)};
    await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));throw error;
  } finally {
    try {await browser?.close();} finally {await new Promise(resolve=>server.close(resolve));}
  }
}
