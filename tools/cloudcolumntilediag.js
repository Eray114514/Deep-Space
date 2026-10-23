// Real full-atlas equivalence first; timings describe this isolated producer.
// Default: three actual weather cases, two fresh repeats, whole/unqueried runs.
// --quanta adds independent row windows; never sum those intervals as throughput.
// --origin-control-only runs just a deliberately wrong work-origin control.
// --tiles=16x1,32x2 selects tileRows x footprintBatch; --home-only skips off/forecast.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchHardwareBrowser, resolveSystemChromePath } from './browser.js';
import { evidenceFingerprint } from './evidence-fingerprint.js';

const options={mode:'both',rounds:2,quanta:false,originControlOnly:false,homeOnly:false,
  tiles:[{rows:2,batch:8},{rows:2,batch:16},{rows:3,batch:8},{rows:3,batch:16}],pollMs:20,timeoutMs:300000};
for(const argument of process.argv.slice(2)) {
  if(argument==='--quanta')options.quanta=true;
  else if(argument==='--origin-control-only')options.originControlOnly=true;
  else if(argument==='--home-only')options.homeOnly=true;
  else if(argument.startsWith('--mode='))options.mode=argument.slice(7);
  else if(argument.startsWith('--rounds='))options.rounds=Number(argument.slice(9));
  else if(argument.startsWith('--tiles='))options.tiles=argument.slice(8).split(',').map(value=>{
    const match=/^(\d+)x(\d+)$/.exec(value);
    assert.ok(match,`Invalid tile configuration ${value}; expected tileRows x footprintBatch`);
    const rows=Number(match[1]),batch=Number(match[2]);
    assert.ok(Number.isInteger(rows)&&rows>=1&&rows<=512,`Tile rows outside 1..512: ${value}`);
    assert.ok(Number.isInteger(batch)&&batch>=1&&batch<=64,`Footprint batch outside 1..64: ${value}`);
    return {rows,batch};
  });
  else throw Error(`Unknown argument ${argument}`);
}
assert.ok(['whole','unqueried','both'].includes(options.mode));
assert.ok(Number.isInteger(options.rounds)&&options.rounds>=2&&options.rounds<=4);
assert.ok(!options.originControlOnly||!options.quanta,'Origin control and quantum observations are independent runs');
assert.equal(new Set(options.tiles.map(({rows,batch})=>`${rows}x${batch}`)).size,options.tiles.length,'Duplicate tile configurations');
options.modes=options.mode==='both'?['whole','unqueried']:[options.mode];
options.caseNames=options.originControlOnly||options.homeOnly?['constructor-partition-on']:
  ['constructor-partition-on','constructor-partition-off','actual-worker-immutable-forecast-partition-on'];
options.quantumWindows=options.tiles.flatMap(({rows,batch})=>[...new Set([0,255,Math.floor(511/rows)*rows])]
  .map(row=>({rows,batch,row,stopRow:Math.min(512,row+rows)})));
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const toolPath='tools/cloudcolumntilediag.js',fixturePath='tools/fixtures/cloud-column-work-original.json';
const snapshotPaths=[toolPath,fixturePath,'tools/browser.js','tools/server.js','tools/evidence-fingerprint.js','tools/canonical-planet-fixture.js',
  'src/cloud/cloud-column-map.js','src/cloud/cloud-column-tile-map.js',
  'src/cloud/cloud-column-material.js','src/cloud/cloud-column-shader.js'];
const frozen=new Map(await Promise.all(snapshotPaths.map(async path=>[path,await readFile(new URL(`../${path}`,import.meta.url))])));
const fixture=JSON.parse(frozen.get(fixturePath).toString('utf8'));
assert.equal(fixture.revision,'fa9ce1c');
assert.equal(fixture.path,'src/cloud/cloud-column-map.js');
assert.equal(fixture.sha256,'38b5eafb41c3cd859a955c956e86e87389690e72d49701a45cd684242ecb7ef6');
assert.equal(sha256(fixture.source),fixture.sha256);assert.equal(Buffer.byteLength(fixture.source),fixture.bytes);
const out=`test-results/cloud-column-tile/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(`${out}/source-snapshots`,{recursive:true});
const sources=[];
for(const [path,bytes] of frozen) {
  const snapshot=`source-snapshots/${path.replaceAll('/','__')}`;
  await writeFile(`${out}/${snapshot}`,bytes);sources.push({path,snapshot,bytes:bytes.length,sha256:sha256(bytes)});
}
await writeFile(`${out}/verifier.js`,frozen.get(toolPath));
await writeFile(`${out}/original-fixture.json`,frozen.get(fixturePath));
await writeFile(`${out}/original-source.js`,fixture.source);
const before=await evidenceFingerprint(toolPath);
const {server,port}=await startServer(0);
let browser,browserInfo,result;
const errors=[],driverWarnings=[];let droppedErrors=0,droppedWarnings=0;
try {
  const executablePath=resolveSystemChromePath()||undefined;
  browser=await launchHardwareBrowser({executablePath});
  const session=await browser.newBrowserCDPSession();
  browserInfo={executablePath,browserVersion:browser.version(),version:await session.send('Browser.getVersion'),
    system:await session.send('SystemInfo.getInfo').catch(error=>({error:String(error)}))};
  const page=await browser.newPage({viewport:{width:1000,height:570}});
  const addError=value=>{if(errors.length<200)errors.push(String(value).slice(0,4000));else droppedErrors++;};
  page.on('pageerror',addError);
  page.on('console',message=>{
    const text=message.text();if(message.type()==='error')addError(text);
    if(/GL_INVALID|GL_OUT_OF_MEMORY|Program object expected|CONTEXT_LOST_WEBGL/i.test(text)) {
      if(driverWarnings.length<200)driverWarnings.push(text.slice(0,2000));else droppedWarnings++;
    }
  });
  await page.route('**/column-tile.html*',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><style>body{margin:16px;background:#111;color:#ddd;font:14px sans-serif}canvas{width:960px;height:480px}p{margin:8px 0}</style><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><p id="caption">Complete cloud column atlas diagnostic — opacity R/G; isolated producer, not player performance</p><canvas id="fixture"></canvas>'}));
  await page.route('**/src/cloud/tile-original.js',route=>route.fulfill({contentType:'text/javascript',body:fixture.source}));
  await page.goto(`http://127.0.0.1:${port}/column-tile.html?vclouds=1`);
  result=await page.evaluate(async options=>{
    const T=await import('three'),{Planet}=await import('/src/planet.js');
    const {canonicalHomeBody}=await import('/tools/canonical-planet-fixture.js');
    const {createGameRenderer}=await import('/src/renderer-runtime.js');
    const {OwnedScreenTriangle}=await import('/src/owned-screen-triangle.js');
    const constructors={old:(await import('/src/cloud/tile-original.js')).CloudColumnMap,
      native:(await import('/src/cloud/cloud-column-map.js')).CloudColumnMap,
      tile:(await import('/src/cloud/cloud-column-tile-map.js')).CloudColumnTileMap};
    const check=(condition,message)=>{if(!condition)throw Error(message);};
    const sleep=()=>new Promise(resolve=>setTimeout(resolve,options.pollMs));
    const hash=async view=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',
      view.buffer.slice(view.byteOffset,view.byteOffset+view.byteLength)))].map(value=>value.toString(16).padStart(2,'0')).join('');
    const textHash=text=>hash(new TextEncoder().encode(text));
    const {seed,star,spec,tuning,provenance}=canonicalHomeBody();
    const p=new Planet({seed:spec.seed,name:spec.name,catalogName:spec.catalogName,posUniv:new T.Vector3(),
      type:spec.type,isMoon:spec.isMoon,radius:spec.radius,atmosphere:spec.atmosphere,clouds:spec.clouds,
      tuning,formation:spec.formation,ringSystem:spec.ringSystem});
    const {renderer:r}=await createGameRenderer({},{canvas:document.querySelector('#fixture')});
    r.setSize(960,480);r.info.autoReset=false;
    const gl=r.getContext(),contextEvents=[];
    r.domElement.addEventListener('webglcontextlost',()=>contextEvents.push({type:'lost',at:performance.now()}));
    r.domElement.addEventListener('webglcontextrestored',()=>contextEvents.push({type:'restored',at:performance.now()}));
    const needsTimer=!options.originControlOnly&&(options.modes.includes('whole')||options.quanta);
    const ext=needsTimer?gl.getExtension('EXT_disjoint_timer_query_webgl2'):null;
    check(ext||!needsTimer,'Hardware timer extension required');
    const debug=gl.getExtension('WEBGL_debug_renderer_info');
    const gpu={vendor:gl.getParameter(gl.VENDOR),renderer:gl.getParameter(gl.RENDERER),version:gl.getParameter(gl.VERSION),
      shadingLanguage:gl.getParameter(gl.SHADING_LANGUAGE_VERSION),unmaskedVendor:debug?gl.getParameter(debug.UNMASKED_VENDOR_WEBGL):null,
      unmaskedRenderer:debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):null,timerExtensionUsed:Boolean(ext),
      dpr:r.getPixelRatio(),performanceTimeOrigin:performance.timeOrigin,
      fragmentHighp:(()=>{const f=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT);return {precision:f.precision,rangeMin:f.rangeMin,rangeMax:f.rangeMax};})()};
    check(!/swiftshader|llvmpipe|software rasterizer/i.test(gpu.unmaskedRenderer||gpu.renderer),'Hardware adapter required');
    const checkpoint=label=>{
      const error=gl.getError(),lost=gl.isContextLost();
      check(error===0&&!lost&&contextEvents.length===0,`${label}: GL ${error}, lost ${lost}`);return {error,lost};
    };
    checkpoint('Initial');
    const variants=[{name:'old-native',kernel:'old',rows:2},{name:'default-native',kernel:'native',rows:2},
      ...options.tiles.map(({rows,batch})=>({name:`tile${batch}-rows${rows}`,kernel:`tile${batch}`,rows,batch}))];
    const owners={old:{},native:{},originControl:{}};
    for(const variant of variants)owners[variant.kernel]||={};
    const programIds={},shaders={},cases=[],quantumWindows=[],positiveControls=[];
    const output={options,gpu,provenance,format:{width:1024,height:512,heightSamples:128,footprintSamples:64,
      canonical:['RGBA8','RGBA16F'],scratch:'two local three-attachment targets: RGBA32F, RGBA32F, R32F',
      scratchPayloadFloats:9,scratchStorageChannelsPerTexel:9,
      scratchAttachmentFormats:['RGBA32F','RGBA32F','R32F'],
      scratchPayload:{optical:'raw total.xyzw',heights:'altitudeMoment.xy, weightMoment.xy',
        joint:'jointOpacity in .r; unchanged vec4 output and .r read'},
      scratchAllocationExamples:{rows2:{bytes:147456,KiB:144},rows32:{bytes:2359296,MiB:2.25},rows64:{bytes:4718592,MiB:4.5}}},
      identity:{seed,systemId:star.id,bodyId:spec.bodyId,bodySeed:spec.seed,type:p.type,radius:p.R},
      variants,cases,selectedCases:options.caseNames,quantumWindows,positiveControls,contextEvents,programIds,shaders,
      scope:'Full formal-size isolated atlas equivalence/submission fixture, only for selectedCases and listed variants. No unselected-weather, player image, frame budget, forecast deadline, portable-device or cold-driver-cache acceptance.',
      timingScope:{whole:'One non-nested query from immediately before the first actual draw until immediately after the last actual draw, before finish releases. Includes intervening submission/state gaps. Initialization/readback/final cleanup are outside.',
        unqueried:'No diagnostic timer query; continuous submission and one final asynchronous fence. Wall is not GPU busy time.',
        quanta:'Optional independent local row windows; per-draw intervals collected after the complete window fence. No interval sum or throughput claim.',
        fence:'Final fence after finish/cleanup, flush, then clientWaitSync(sync,0,0) asynchronous polling. Wall includes queueing, cleanup and polling granularity.',
        cold:'First measured fresh maps identify retained program leases; this does not establish an empty driver disk cache.',
        instrumentation:'bakeWork(renderer,1), state assertions and a rolling boundary hash are inside enqueue CPU observations; not production CPU cost.'}};
    const displayMaterial=new T.ShaderMaterial({uniforms:{tMap:{value:null}},
      vertexShader:'varying vec2 vUv;void main(){vUv=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tMap;varying vec2 vUv;void main(){gl_FragColor=vec4(texture2D(tMap,vUv).xy,0,1);}',
      depthTest:false,depthWrite:false});
    const displayQuad=new OwnedScreenTriangle(displayMaterial);
    const names=['uWeatherMap','uWeatherMapHi','uSpeciesMap','uBandBounds'];
    const frameKeys=['low','high','bands','bounds'];
    async function inputState(hours) {
      const stream=p.weatherStream,frame=stream?.frames.get(hours),fields={};
      for(let i=0;i<names.length;i++) {
        const view=frame?frame[frameKeys[i]]:p.volCloudMat.uniforms[names[i]].value.image.data;
        fields[frameKeys[i]]={bytes:view.byteLength,sha256:await hash(view)};
      }
      return {hours,kind:frame?'actual worker immutable frame':'authored constructor textures',
        frameRevision:frame?stream.revisionAt(hours):null,partition:p.volCloudMat.uniforms.uSpeciesPartition.value,
        speciesMask:p.volCloudMat.uniforms.uSpeciesMask.value,speciesCount:p.volCloudMat.uniforms.uSpeciesCount.value,
        cloudSpinBase:p.cloudSpinBase,windRadiansPerHour:p.weatherField.windRadiansPerHour,fields};
    }
    async function snapshotOwnership(map,hours,isTile) {
      const frame=p.weatherStream?.frames.get(hours),bindings=[];
      check(map.snapshots.length===4,'Each map must own four immutable snapshots');
      check(!isTile||map.material.uniforms===map.finalMaterial.uniforms,'Tile work/final must share one owned binding dictionary');
      for(let i=0;i<names.length;i++) {
        const source=p.volCloudMat.uniforms[names[i]].value,texture=map.material.uniforms[names[i]].value;
        check(texture===map.snapshots[i]&&texture!==source&&texture.image.data!==source.image.data,`Unowned/aliased ${names[i]} snapshot`);
        let expected=frame?frame[frameKeys[i]]:source.image.data;
        if(frame&&i<2) {
          const flipped=new Float32Array(expected.length),width=source.image.width,height=source.image.height;
          for(let y=0;y<height;y++)flipped.set(expected.subarray(y*width*4,(y+1)*width*4),(height-1-y)*width*4);
          expected=flipped;
        }
        const actualSha256=await hash(texture.image.data),expectedSha256=await hash(expected);
        check(actualSha256===expectedSha256,`Incorrect immutable/oriented snapshot ${names[i]}`);
        bindings.push({uniform:names[i],bytes:texture.image.data.byteLength,sha256:actualSha256,
          expectedSha256,owned:true,orientation:frame&&i<2?'worker frame vertically flipped':'source order'});
      }
      const revision=map.weatherSources?.frames[0]?.revision??null;
      check(frame?map.weatherSources?.stream===p.weatherStream&&revision===p.weatherStream.revisionAt(hours):map.weatherSources===null,
        'Map dependency token does not identify its actual source frame');
      return {bindings,frameRevision:revision,sharedTileUniformDictionary:isTile?true:null};
    }
    async function saveShader(role,material) {
      const source={vertex:material.vertexShader,fragment:material.fragmentShader,defines:{...material.defines}};
      if(shaders[role])check(JSON.stringify(shaders[role].source)===JSON.stringify(source),`Shader changed within ${role}`);
      else shaders[role]={source,vertexSha256:await textHash(source.vertex),fragmentSha256:await textHash(source.fragment)};
    }
    function readNative(target,row=0,rows=512,requireOccupied=true) {
      const optical=new Uint8Array(1024*rows*4),heights=new Uint16Array(1024*rows*4);
      const old=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel(),started=performance.now();
      try {
        r.setRenderTarget(target);r.readRenderTargetPixels(target,0,row,1024,rows,optical);
        r.readRenderTargetPixels(target,0,row,1024,rows,heights,undefined,1);
      } finally {r.setRenderTarget(old,face,mip);}
      const readMs=performance.now()-started,state=checkpoint('Native readback');
      let nonfinite=0,invalidAlpha=0,occupied=0;
      for(const word of heights)if((word&0x7c00)===0x7c00)nonfinite++;
      for(let i=3;i<heights.length;i+=4)if(heights[i]!==0x3c00)invalidAlpha++;
      for(let i=0;i<optical.length;i+=4)if(optical[i]||optical[i+1])occupied++;
      check(nonfinite===0&&invalidAlpha===0&&(!requireOccupied||occupied>0),`Nonfinite/incomplete/empty output ${nonfinite}/${invalidAlpha}/${occupied}`);
      return {optical,heights,row,rows,readMs,nonfinite,invalidAlpha,occupied,gl:state};
    }
    const compare=(left,right)=>Object.fromEntries(['optical','heights'].map(name=>{
      check(left[name].length===right[name].length,'Native dimensions differ');
      let changed=0,first=-1;for(let i=0;i<left[name].length;i++)if(left[name][i]!==right[name][i]){changed++;if(first<0)first=i;}
      return [name,{changed,first}];
    }));
    const zero=delta=>delta.optical.changed===0&&delta.heights.changed===0;
    const region=(full,row,rows)=>Object.fromEntries(['optical','heights'].map(name=>[name,full[name].subarray(row*1024*4,(row+rows)*1024*4)]));
    async function nativeSummary(data) {
      return {row:data.row,rows:data.rows,optical:{encoding:'native RGBA8 Uint8',elements:data.optical.length,sha256:await hash(data.optical)},
        heights:{encoding:'native RGBA16F Uint16 bits',elements:data.heights.length,sha256:await hash(data.heights),
          nonfinite:data.nonfinite,invalidAlpha:data.invalidAlpha},occupied:data.occupied,readMs:data.readMs,gl:data.gl};
    }
    async function collect(sync,queries,origin,enqueueEnd) {
      const deadline=enqueueEnd+options.timeoutMs;let fenceAt=null,polls=0,availabilityRounds=0;
      while(fenceAt===null) {
        check(!gl.isContextLost()&&contextEvents.length===0&&performance.now()<deadline,'Fence deadline/context loss');
        const status=gl.clientWaitSync(sync,0,0);polls++;check(status!==gl.WAIT_FAILED,'Fence wait failed');
        if(status===gl.ALREADY_SIGNALED||status===gl.CONDITION_SATISFIED)fenceAt=performance.now();else await sleep();
      }
      let remaining=queries.length;
      while(remaining) {
        check(!gl.isContextLost()&&performance.now()<deadline,'Query availability deadline');availabilityRounds++;
        for(const entry of queries)if(entry.elapsedMs===null&&gl.getQueryParameter(entry.query,gl.QUERY_RESULT_AVAILABLE)) {
          entry.elapsedMs=gl.getQueryParameter(entry.query,gl.QUERY_RESULT)/1e6;entry.observedAt=performance.now();remaining--;
          check(Number.isFinite(entry.elapsedMs)&&entry.elapsedMs>=0,'Invalid elapsed result');
        }
        if(remaining)await sleep();
      }
      const disjoint=queries.length?gl.getParameter(ext.GPU_DISJOINT_EXT):null;check(!disjoint,'Disjoint elapsed range');
      return {fencePolls:polls,availabilityRounds,fenceFromFirstDrawMs:fenceAt-origin,
        fenceAfterEnqueueMs:fenceAt-enqueueEnd,queryAvailabilityPolledAfterFenceOnly:true,disjoint};
    }
    async function showAtlas(target,caption) {
      document.querySelector('#caption').textContent=`${caption} — complete 1024×512 atlas, R/G opacity; not a player capture`;
      displayMaterial.uniforms.tMap.value=target.textures[0];r.setRenderTarget(null);displayQuad.render(r);
      const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);check(sync,'Display fence allocation');gl.flush();
      try {await collect(sync,[],performance.now(),performance.now());}finally{gl.deleteSync(sync);}
    }
    async function measure(variant,mode,phase,round,hours,{wrongOrigin=false,windowRow=null,display=false}={}) {
      const isTile=Boolean(variant.batch),ownerKey=wrongOrigin?'originControl':variant.kernel,owner=owners[ownerKey];
      const roleKeys=isTile?(variant.batch<64?['tileWork','tileFinal']:['tileFinal']):['columns'];
      const programWarm=roleKeys.every(key=>owner[key])&&programIds[ownerKey]!==undefined;
      const started=performance.now(),Class=isTile?constructors.tile:constructors[variant.kernel];
      const map=new Class(p,{width:1024,samples:128,footprintSamples:64,hours,programOwner:owner,
        ...(isTile?{tileRows:variant.rows,footprintBatch:variant.batch}:{})});
      try {
        const constructedMs=performance.now()-started,ownership=await snapshotOwnership(map,hours,isTile);
        await saveShader(isTile?'tileWork':variant.kernel,map.material);
        if(isTile)await saveShader('tileFinal',map.finalMaterial);
        check(map.width===1024&&map.height===512&&map.samples===128&&map.footprintSamples===64,'Formal dimensions changed');
        if(windowRow!==null){check(isTile,'Only tile quanta have independent windows');map.row=windowRow;}
        const rowStart=map.row,stopRow=windowRow===null?map.height:Math.min(map.height,rowStart+variant.rows);
        const rowsTotal=stopRow-rowStart,expectedDraws=Math.ceil(rowsTotal/variant.rows)*(isTile?Math.ceil(64/variant.batch):1);
        const initAt=performance.now();r.initRenderTarget(map.target);if(isTile)map.scratch.prepare(r);
        const targetInitializationMs=performance.now()-initAt;
        checkpoint('Target initialization');
        const scratchBytes=isTile?map.scratch.bytes:0;
        check(!isTile||scratchBytes===2*1024*variant.rows*(4+4+1)*4,'Unexpected nine-channel local scratch allocation');
        check(!isTile||map.scratch.targets.length===2&&map.scratch.targets.every(target=>target.textures.length===3
          &&target.textures.every((texture,index)=>texture.type===T.FloatType
            &&texture.format===(index===2?T.RedFormat:T.RGBAFormat))),
          'Nine-float payload requires two pingpong targets, each RGBA/Float, RGBA/Float, Red/Float');
        const quad=map.quad,draw=quad.render,queries=[],calls=r.info.render.calls;
        let active=false,sync=null,firstDrawAt=null,lastDrawAt=null,draws=0,commits=0,oddOrigins=0,carryReadDraws=0;
        let firstBoundary=null,lastBoundary=null,boundaryHash=2166136261;
        const selectedPrograms={};
        const hashWord=value=>{for(let shift=0;shift<32;shift+=8){boundaryHash^=value>>>shift&255;boundaryHash=Math.imul(boundaryHash,16777619)>>>0;}};
        const begin=boundary=>{
          check(!active&&!gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY),'Nested elapsed query');
          const query=gl.createQuery();check(query,'Query allocation failed');
          queries.push({query,boundary,elapsedMs:null,observedAt:null});gl.beginQuery(ext.TIME_ELAPSED_EXT,query);active=true;
        };
        const end=()=>{gl.endQuery(ext.TIME_ELAPSED_EXT);active=false;};
        try {
          if(mode!=='unqueried')check(!gl.getParameter(ext.GPU_DISJOINT_EXT),'Disjoint before submission');
          quad.render=function(...args) {
            const row=map.row,start=isTile?map.footprintCursor:0,count=isTile?Math.min(variant.batch,64-start):64;
            const final=start+count===64,rows=Math.min(variant.rows,map.height-row),last=final&&row+rows===stopRow;
            const material=this.material,role=isTile?(final?'tileFinal':'tileWork'):'columns';
            const boundary={row,rows,start,count,final,targetAttachments:final?2:3,
              globalOrigin:isTile?material.uniforms.uColumnTileOrigin.value.y:null,
              targetOrigin:isTile?material.uniforms.uColumnTargetOrigin.value.y:null};
            check(!isTile||boundary.globalOrigin===row&&boundary.targetOrigin===(final?row:0),'Incorrect actual tile origin before injection');
            if(wrongOrigin&&!final){material.uniforms.uColumnTileOrigin.value.y=0;boundary.injectedWorkOrigin=0;}
            if(firstDrawAt===null)firstDrawAt=performance.now();
            if(mode==='quanta'||mode==='whole'&&draws===0)begin(boundary);
            try {return draw.apply(this,args);}finally {
              draws++;if(final){commits++;if(row%2)oddOrigins++;}
              if(isTile&&start>0)carryReadDraws++;
              if(mode==='quanta'||mode==='whole'&&last)end();
              for(const word of [row,rows,start,count,Number(final),boundary.targetAttachments])hashWord(word);
              if(!firstBoundary)firstBoundary=boundary;lastBoundary=boundary;
              if(selectedPrograms[role]===undefined)selectedPrograms[role]=r.properties.get(material).currentProgram?.id??null;
              if(last)lastDrawAt=performance.now();
            }
          };
          const enqueueStart=performance.now();
          // No waits, readbacks, result polling or per-draw getError here.
          while(map.row<stopRow&&!map.ready) {
            const row=map.row,cursor=isTile?map.footprintCursor:0;
            const count=isTile?Math.min(variant.batch,64-cursor):64,final=cursor+count===64;
            const rows=Math.min(variant.rows,map.height-row);
            if(isTile) {
              const work=map.bakeWork(r,1);
              check(work.draws===1&&!work.blocked&&!work.invalidated,'Grant must submit exactly one real draw');
              check(map.row===(final?row+rows:row)&&map.footprintCursor===(final?0:cursor+count),'Tile commit/cursor progression changed');
              check(work.committedRows===(final?rows:0),'Non-final work published canonical rows');
            } else {map.bakeSlice(r,variant.rows);check(map.row===row+rows,'Native progression changed');}
          }
          const enqueueEnd=performance.now(),enqueueMs=enqueueEnd-enqueueStart;
          check(draws===expectedDraws&&r.info.render.calls-calls===draws,'Draw grant/count mismatch');
          check(map.row===stopRow&&(!isTile||map.footprintCursor===0)&&!active&&lastDrawAt!==null,'Incomplete tile/range');
          if(windowRow===null)check(map.ready&&map.row===512,'Full atlas never became ready');
          check(queries.length===(mode==='whole'?1:mode==='quanta'?draws:0),'Unexpected diagnostic query count');
          if(windowRow===null) {
            check(roleKeys.every(key=>owner[key]),'Completed map did not preserve its program leases');
            check(!isTile||map.scratch.disposed&&map.scratch.owner===null,'Owned scratch was not released after final tile');
          }
          check(Object.values(selectedPrograms).every(id=>id!==null),'Actual program identity unavailable');
          if(programIds[ownerKey])check(JSON.stringify(programIds[ownerKey])===JSON.stringify(selectedPrograms),'Unexpected program recompile/variant');
          else programIds[ownerKey]={...selectedPrograms};
          sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);check(sync,'Fence allocation failed');
          const flushAt=performance.now();gl.flush();const flushMs=performance.now()-flushAt;
          const completion=await collect(sync,queries,firstDrawAt,enqueueEnd);
          completion.fenceFromEnqueueStartMs=enqueueMs+completion.fenceAfterEnqueueMs;
          const native=readNative(map.target,rowStart,rowsTotal,windowRow===null),metadata=await nativeSummary(native);
          const record={variant:variant.name,kernel:variant.kernel,programOwnerKey:ownerKey,tileRows:isTile?variant.rows:null,
            nativeRows:isTile?null:variant.rows,footprintBatch:variant.batch??64,queryMode:mode,phase,round,hours,
            programWarm,programIds:selectedPrograms,constructedMs,targetInitializationMs,enqueueMs,flushMs,
            cpuRangeSubmissionMs:lastDrawAt-firstDrawAt,postRangeEnqueueTailMs:enqueueEnd-lastDrawAt,
            continuousEnqueue:true,drawCalls:draws,workDrawCalls:draws-commits,finalDrawCalls:commits,
            carryReadDrawCalls:carryReadDraws,committedTiles:commits,rowStart,row:map.row,footprintCursor:map.footprintCursor??null,
            completeAtlas:windowRow===null&&map.ready,readyMeaning:'ordered submission, not completion; fence observed separately',
            finalReleaseOutsideGpuRange:true,programLeaseRetained:windowRow===null?true:null,
            scratchBytes,scratchMiB:scratchBytes/1048576,scratchOwned:isTile?map.ownsScratch:null,
            boundaryCount:draws,boundaryHashFNV1a32:boundaryHash.toString(16).padStart(8,'0'),firstBoundary,lastBoundary,oddCanonicalTileOrigins:oddOrigins,
            queryCount:queries.length,gpuRangeMs:mode==='whole'?queries[0].elapsedMs:null,
            quanta:mode==='quanta'?queries.map(entry=>({boundary:entry.boundary,gpuMs:entry.elapsedMs,
              availabilityObservedAfterFirstDrawMs:entry.observedAt-firstDrawAt})):null,
            completion,native:metadata,ownership,wrongWorkOrigin:wrongOrigin,sourceRevision:ownership.frameRevision};
          if(display)await showAtlas(map.target,`${variant.name}; ${phase}`);
          return {record,native};
        } finally {
          quad.render=draw;
          if(active&&!gl.isContextLost())end();
          if(!gl.isContextLost()){if(sync)gl.deleteSync(sync);for(const entry of queries)gl.deleteQuery(entry.query);}
        }
      } finally {map.dispose();}
    }
    async function originControl(reference,hours) {
      const control=await measure({name:'wrong-work-origin-zero-tile8-rows3',kernel:'originControl',rows:3,batch:8},
        'unqueried','independent-origin-positive-control',0,hours,{wrongOrigin:true,display:options.originControlOnly});
      control.record.deltaReference=compare(reference,control.native);
      control.record.scope='Intentional work-pass global-origin error only; separate complete map, no throughput or candidate timing comparison.';
      positiveControls.push(control.record);
      check(!zero(control.record.deltaReference),'Wrong-origin positive control failed to produce a native difference');
    }
    async function quanta(reference,hours) {
      for(const {rows,batch,row,stopRow} of options.quantumWindows) {
        const variant={name:`tile${batch}-rows${rows}`,kernel:`tile${batch}`,rows,batch};
        const measured=await measure(variant,'quanta','independent-window-quanta',0,hours,{windowRow:row});
        check(measured.record.row===stopRow,'Truncated quantum window end differs from map dimensions');
        measured.record.deltaReference=compare(region(reference,row,stopRow-row),measured.native);
        measured.record.scope='Only this local row window is initialized; no complete-map or throughput acceptance.';
        check(zero(measured.record.deltaReference),'Quantum window differs from full native reference');quantumWindows.push(measured.record);
      }
    }
    async function runCase(name,hours) {
      document.querySelector('#caption').textContent=`Running ${name}: full 1024×512 old/default native and selected tile configurations`;
      const inputBefore=await inputState(hours),baseline=[],samples=[],previous=new Map();
      const reference=await measure(variants[0],options.originControlOnly?'unqueried':options.modes[0],'first-measured-reference',-1,hours);
      reference.record.deltaReference=compare(reference.native,reference.native);baseline.push(reference.record);
      const caseResult={name,hours,inputBefore,baseline,samples,reference:{variant:'old-native',native:reference.record.native},
        retainedComparisonBytesAtMost:(2+variants.length*options.modes.length)*1024*512*12,
        coldScope:'First map in each kernel identifies actual programWarm; new case/map does not imply a cold driver cache.',
        warmScope:'Fresh snapshots/targets and owned scratch each repeat; only program leases retained. Orders reverse on alternate rounds; descriptive, no stable percentile.'};
      cases.push(caseResult);
      if(!options.originControlOnly) {
        for(const variant of variants.slice(1)) {
          const measured=await measure(variant,options.modes[0],'first-measured-variant',-1,hours);
          measured.record.deltaReference=compare(reference.native,measured.native);baseline.push(measured.record);
          check(zero(measured.record.deltaReference),'First complete variant differs from frozen native');
        }
        for(let round=0;round<options.rounds;round++) {
          const order=round%2?[...variants].reverse():variants,modes=round%2?[...options.modes].reverse():options.modes;
          for(const mode of modes)for(const variant of order) {
            const measured=await measure(variant,mode,'warm-program-fresh-atlas',round,hours,
              {display:round===options.rounds-1&&mode===modes.at(-1)&&variant.name===variants.at(-1).name});
            const key=`${variant.name}:${mode}`,prior=previous.get(key);
            measured.record.deltaReference=compare(reference.native,measured.native);
            measured.record.nativeRepeat=prior?compare(prior,measured.native):null;
            check(measured.record.programWarm&&zero(measured.record.deltaReference)&&(!prior||zero(measured.record.nativeRepeat)),
              'Warm full-atlas/rebuilt-repeat native difference');
            samples.push(measured.record);
            if(round===options.rounds-1)previous.delete(key);else previous.set(key,measured.native);
          }
        }
      }
      if(name==='constructor-partition-on') {
        await originControl(reference.native,hours);
        if(options.quanta)await quanta(reference.native,hours);
      }
      caseResult.inputAfter=await inputState(hours);
      check(JSON.stringify(inputBefore)===JSON.stringify(caseResult.inputAfter),'Weather/frame inputs mutated during atlas measurements');
      if(inputBefore.frameRevision!==null)check([...baseline,...samples].every(sample=>sample.sourceRevision===inputBefore.frameRevision),
        'Producer source revision differs from actual immutable forecast');
      checkpoint(`Completed ${name}`);
    }
    try {
      check(p.weatherHours===0&&!p.weatherStream,'Constructor weather must precede worker creation');
      check(p.volCloudMat.uniforms.uSpeciesPartition.value>=0.5,'Actual home constructor production partition required');
      p.volCloudMat.uniforms.uSpeciesMask.value=-1;
      await runCase('constructor-partition-on',0);
      if(!options.originControlOnly&&!options.homeOnly) {
        p.volCloudMat.uniforms.uSpeciesPartition.value=0;
        await runCase('constructor-partition-off',0);
        p.volCloudMat.uniforms.uSpeciesPartition.value=1;
        const started=performance.now();p.setWeatherTime(0);const stream=p.weatherStream;
        check(stream&&!stream.disposed,'Actual forecast worker stream required');
        const hours=stream.frameHours;p.setWeatherTime(hours);
        const deadline=performance.now()+options.timeoutMs;
        while(!(stream.ready&&stream.frames.has(hours)&&stream.frames.has(hours+stream.frameHours)&&stream.pending.size===0)) {
          check(p.weatherStream===stream&&!stream.error&&!stream.disposed&&performance.now()<deadline,`Forecast unavailable: ${String(stream.error)}`);await sleep();
        }
        stream.worker.terminate();
        output.forecast={hours,frameHours:stream.frameHours,preparationMs:performance.now()-started,
          pending:stream.pending.size,ready:stream.ready,workerStoppedBeforeMeasurements:true,
          revision:stream.revisionAt(hours)};
        await runCase('actual-worker-immutable-forecast-partition-on',hours);
      }
      output.referenceValid=true;
      output.nativeAccepted=!options.originControlOnly;
      output.nativeAcceptedScope=options.originControlOnly?null:{cases:cases.map(row=>row.name),
        variants:variants.map(variant=>variant.name),modes:options.modes,rounds:options.rounds,width:1024,height:512,
        heightSamples:128,footprintSamples:64};
      output.positiveControlRejected=true;
      output.final=checkpoint('Final measurements');
    } catch(error) {output.failure={error:String(error),stack:error.stack};}
    finally {
      try {
        displayQuad.dispose();displayMaterial.dispose();
        for(const owner of Object.values(owners))for(const material of Object.values(owner))material.dispose();
        p.dispose();output.cleanup={programOwnersDisposed:true,planetDisposed:true,gl:checkpoint('After cleanup')};
      } catch(error) {output.cleanupFailure={error:String(error),stack:error.stack};}
      r.dispose();
    }
    return output;
  },options);
  await page.screenshot({path:`${out}/atlas.png`});
  const after=await evidenceFingerprint(toolPath),sourceChecks=[];
  for(const [path,bytes] of frozen) {
    const actual=await readFile(new URL(`../${path}`,import.meta.url));
    sourceChecks.push({path,beforeSha256:sha256(bytes),afterSha256:sha256(actual),stable:bytes.equals(actual)});
  }
  for(const [role,shader] of Object.entries(result.shaders||{})) {
    await writeFile(`${out}/${role}.vertex.glsl`,shader.source.vertex);
    await writeFile(`${out}/${role}.fragment.glsl`,shader.source.fragment);
    shader.defines=shader.source.defines;delete shader.source;
  }
  const summary=result.cases.map(row=>({name:row.name,baselineMaps:row.baseline.length,freshRepeatMaps:row.samples.length,
    observations:row.samples.map(sample=>({variant:sample.variant,tileRows:sample.tileRows,footprintBatch:sample.footprintBatch,
      round:sample.round,mode:sample.queryMode,
      enqueueMs:sample.enqueueMs,gpuRangeMs:sample.gpuRangeMs,fenceWallMs:sample.completion.fenceFromEnqueueStartMs,
      drawCalls:sample.drawCalls,workDrawCalls:sample.workDrawCalls,carryReadDrawCalls:sample.carryReadDrawCalls,
      deltaReference:sample.deltaReference,nativeRepeat:sample.nativeRepeat}))}));
  const externallyValid=sourceChecks.every(row=>row.stable)&&JSON.stringify(before)===JSON.stringify(after)
    &&errors.length===0&&driverWarnings.length===0&&droppedErrors===0&&droppedWarnings===0;
  const report={status:result.failure||result.cleanupFailure||!externallyValid?'rejected':options.originControlOnly?'accepted-origin-control-only':'accepted-native-scope-only',before,after,options,
    sources,fixture:{path:fixturePath,revision:fixture.revision,sourceSha256:fixture.sha256,bytes:fixture.bytes},sourceChecks,
    browserInfo,result,summary,errors,driverWarnings,droppedErrors,droppedWarnings};
  await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.deepEqual(before,after);assert.ok(sourceChecks.every(row=>row.stable),'Tool/fixture/runtime snapshots changed');
  assert.deepEqual(errors,[]);assert.deepEqual(driverWarnings,[]);assert.equal(droppedErrors,0);assert.equal(droppedWarnings,0);
  assert.equal(result.failure,undefined);assert.equal(result.cleanupFailure,undefined);
  assert.equal(result.referenceValid,true);assert.equal(result.nativeAccepted,!options.originControlOnly);
  assert.equal(result.positiveControlRejected,true);assert.deepEqual(result.contextEvents,[]);
  assert.equal(result.final.error,0);assert.equal(result.final.lost,false);assert.equal(result.cleanup.gl.error,0);
  assert.deepEqual(result.cases.map(row=>row.name),options.caseNames);
  if(!options.originControlOnly) {
    assert.deepEqual(result.nativeAcceptedScope.cases,options.caseNames);
    assert.deepEqual(result.nativeAcceptedScope.variants,result.variants.map(variant=>variant.name));
  }
  const zero=delta=>delta.optical.changed===0&&delta.heights.changed===0;
  for(const row of result.cases) {
    assert.deepEqual(row.inputBefore,row.inputAfter);
    assert.equal(row.baseline.length,options.originControlOnly?1:result.variants.length);
    assert.equal(row.samples.length,options.originControlOnly?0:result.variants.length*options.modes.length*options.rounds);
    for(const sample of [...row.baseline,...row.samples]) {
      assert.ok(sample.completeAtlas&&sample.row===512&&sample.continuousEnqueue&&zero(sample.deltaReference));
      assert.equal(sample.native.optical.elements,1024*512*4);assert.equal(sample.native.heights.elements,1024*512*4);
      assert.equal(sample.native.heights.nonfinite,0);assert.equal(sample.native.heights.invalidAlpha,0);assert.ok(sample.native.occupied>0);
      assert.equal(sample.native.gl.error,0);assert.equal(sample.queryCount,sample.queryMode==='whole'?1:0);
      assert.equal(sample.drawCalls,Math.ceil(512/(sample.tileRows||sample.nativeRows))*Math.ceil(64/sample.footprintBatch));
      assert.equal(sample.committedTiles,Math.ceil(512/(sample.tileRows||sample.nativeRows)));
      assert.equal(sample.workDrawCalls,sample.drawCalls-sample.committedTiles);
      assert.equal(sample.carryReadDrawCalls,sample.tileRows?sample.drawCalls-sample.committedTiles:0);
      const rows=sample.tileRows||sample.nativeRows,lastRow=Math.floor(511/rows)*rows;
      assert.equal(sample.lastBoundary.row,lastRow);assert.equal(sample.lastBoundary.rows,512-lastRow);
      assert.equal(sample.oddCanonicalTileOrigins,rows%2?Math.floor(Math.ceil(512/rows)/2):0);
      if(sample.phase==='warm-program-fresh-atlas')assert.ok(sample.programWarm&&(!sample.nativeRepeat||zero(sample.nativeRepeat)));
    }
    assert.equal(row.samples.filter(sample=>sample.nativeRepeat).length,options.originControlOnly?0:result.variants.length*options.modes.length*(options.rounds-1));
  }
  assert.equal(result.positiveControls.length,1);
  assert.ok(!zero(result.positiveControls[0].deltaReference));
  assert.equal(result.positiveControls[0].queryCount,0);
  assert.equal(result.quantumWindows.length,options.quanta?options.quantumWindows.length:0);
  assert.ok(result.quantumWindows.every(sample=>zero(sample.deltaReference)&&sample.gpuRangeMs===null&&sample.queryCount===sample.drawCalls));
  console.log(JSON.stringify({out,nativeAccepted:result.nativeAccepted,positiveControlRejected:true,cases:result.cases.length,
    quantumWindows:result.quantumWindows.length,sourceDigest:before.sourceDigest,
    selectedCases:options.caseNames,selectedTiles:options.tiles,
    scope:options.originControlOnly?'Independent wrong-origin rejection only':'Full native/repeat equality only for selected cases/tiles; no production budget/deadline/player acceptance'}));
} catch(error) {
  await writeFile(`${out}/failure.json`,JSON.stringify({before,sources,options,browserInfo,errors,driverWarnings,droppedErrors,droppedWarnings,
    resultAvailable:Boolean(result),error:String(error),stack:error.stack},null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
