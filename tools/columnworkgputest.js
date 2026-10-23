// Tiny real-forecast integration for the explicit tile bank. Full formal
// native parity and throughput are separate cloudcolumntilediag experiments.
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {startServer} from './server.js';
import {launchHardwareBrowser,resolveSystemChromePath} from './browser.js';
import {evidenceFingerprint} from './evidence-fingerprint.js';

const verifier='tools/columnworkgputest.js';
const out=`test-results/column-work-gpu/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});await writeFile(`${out}/verifier.js`,await readFile(verifier));
await writeFile(`${out}/canonical-planet-fixture.js`,await readFile(new URL('./canonical-planet-fixture.js',import.meta.url)));
const report={before:await evidenceFingerprint(verifier),errors:[],warnings:[],driverWarnings:[],
  scope:'Real immutable forecast and actual tile-bank lifecycle on a tiny 16x8 canonical target. Not formal throughput, physical cloud rendering, player visual acceptance or a dynamic deadline claim.'};
const {server,port}=await startServer(0);let browser;
try {
  browser=await launchHardwareBrowser({executablePath:resolveSystemChromePath()||undefined});
  report.browserVersion=browser.version();const page=await browser.newPage();
  page.on('pageerror',error=>report.errors.push(String(error)));
  page.on('console',message=>{
    if(message.type()==='error')report.errors.push(message.text());
    if(message.type()==='warning')report.warnings.push(message.text());
    if(/GL_INVALID|WebGL.*INVALID_|CONTEXT_LOST_WEBGL|Program object expected|GL_OUT_OF_MEMORY/i.test(message.text()))report.driverWarnings.push(message.text());
  });
  await page.route('**/column-work.html',route=>route.fulfill({contentType:'text/html',body:
    '<link rel="icon" href="data:,"><script type="importmap">{"imports":{"three":"/vendor/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script><canvas id="fixture"></canvas>'}));
  await page.goto(`http://127.0.0.1:${port}/column-work.html`);
  report.result=await page.evaluate(async()=>{
    const T=await import('three'),{Planet}=await import('/src/planet.js');
    const {canonicalHomeBody}=await import('/tools/canonical-planet-fixture.js');
    const {CloudColumnBank}=await import('/src/cloud/cloud-column-bank.js');
    const {CloudColumnMap}=await import('/src/cloud/cloud-column-map.js');
    const result={checks:[],gl:[],disposedTargets:[],failures:[],contextEvents:[]};
    const check=(condition,label)=>{result.checks.push({label,pass:Boolean(condition)});if(!condition)throw Error(label);};
    let p,r,bank,guard;const references=[];
    try {
      const {spec,tuning,provenance}=canonicalHomeBody();result.provenance=provenance;
      p=new Planet({seed:spec.seed,name:spec.name,catalogName:spec.catalogName,posUniv:new T.Vector3(),type:spec.type,
        isMoon:spec.isMoon,radius:spec.radius,atmosphere:spec.atmosphere,clouds:spec.clouds,
        tuning,formation:spec.formation,ringSystem:spec.ringSystem});
      p.setWeatherTime(0);const stream=p.weatherStream,frameHours=stream.frameHours;
      const deadline=performance.now()+120000;
      while(!(stream.ready&&[0,frameHours,frameHours*2].every(hours=>stream.frames.has(hours)))) {
        check(!stream.error&&performance.now()<deadline,'Actual worker forecast available');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      stream.worker.terminate();
      r=new T.WebGLRenderer({canvas:document.querySelector('#fixture')});r.setSize(64,64,false);r.setPixelRatio(2);
      const gl=r.getContext(),debug=gl.getExtension('WEBGL_debug_renderer_info');
      result.gpu=debug?gl.getParameter(debug.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
      check(!/swiftshader|llvmpipe|software/i.test(result.gpu),'Hardware WebGL required');
      r.debug.checkShaderErrors=true;r.domElement.addEventListener('webglcontextlost',()=>result.contextEvents.push('lost'));
      const checkpoint=label=>{
        const state={label,error:gl.getError(),lost:gl.isContextLost()};result.gl.push(state);
        check(state.error===0&&!state.lost,label+' GL0');
      };
      const samplerNames=['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'],u=p.volCloudMat.uniforms;
      const safe=()=>samplerNames.every(name=>!result.disposedTargets.includes(u[name].value.uuid));
      const tracked=new WeakSet();
      function track() {
        for(const map of bank.maps.values())if(!tracked.has(map)) {
          tracked.add(map);const textures=map.target.textures;
          map.target.addEventListener('dispose',()=>{
            check(samplerNames.every(name=>!textures.includes(u[name].value)),'Unbind every retired sampler before dispose');
            result.disposedTargets.push(...textures.map(texture=>texture.uuid));
          });
        }
      }
      function update(quanta=1) {
        bank.update(r,{workQuanta:quanta});track();check(safe(),'No disposed target remains bound');
        check([...bank.maps.values()].filter(map=>!map.ready).length<=1,'Single partial map');
      }
      bank=new CloudColumnBank(p,{producer:'tile',width:16,tileRows:3,footprintSamples:16,footprintBatch:4});p.cloudColumnMap=bank;
      guard=new T.WebGLCubeRenderTarget(8,{generateMipmaps:true});r.setRenderTarget(guard,3,1);r.autoClear=false;
      update(0);const a=bank.maps.get(0);check(a.row===0&&a.footprintCursor===0,'Zero grant preserves row/cursor');
      for(let i=0;i<3;i++) {update();check(a.row===0&&a.footprintCursor===(i+1)*4,'Intermediate draw does not publish canonical rows');}
      update();check(a.row===3&&a.footprintCursor===0&&!a.ready,'Only final draw commits first tile');
      check(r.getRenderTarget()===guard&&r.getActiveCubeFace()===3&&r.getActiveMipmapLevel()===1&&!r.autoClear,
        'RT face/mip and autoClear restored at DPR2');
      for(let i=0;i<8;i++)update();check(a.ready&&u.uColumnsReady.value===0,'First complete endpoint cannot publish pair');
      for(let i=0;i<12;i++)update();check(u.uColumnsReady.value===1&&u.uColumnsJointReady.value===1,'Second endpoint publishes actual complete pair');
      checkpoint('Initial native bank pair');
      const read=target=>{
        const optical=new Uint8Array(16*8*4),heights=new Uint16Array(16*8*4),saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
        try {r.setRenderTarget(target);r.readRenderTargetPixels(target,0,0,16,8,optical);r.readRenderTargetPixels(target,0,0,16,8,heights,undefined,1);}
        finally {r.setRenderTarget(saved,face,mip);}
        return {optical,heights};
      };
      const differences=(x,y)=>Object.fromEntries(['optical','heights'].map(name=>[name,x[name].reduce((n,v,i)=>n+Number(v!==y[name][i]),0)]));
      result.native=[];
      for(const hours of [0,frameHours]) {
        const reference=new CloudColumnMap(p,{width:16,samples:128,footprintSamples:16,hours});references.push(reference);
        reference.bakeSlice(r,8);const delta=differences(read(reference.target),read(bank.maps.get(hours).target));
        result.native.push({hours,revision:stream.revisionAt(hours),delta});check(Object.values(delta).every(v=>v===0),'Tile endpoint matches full native integration');
      }
      // Partially compute c, then replace a with equal bytes/new real revision.
      update();const forecastPartial=bank.maps.get(frameHours*2);check(forecastPartial.footprintCursor===4,'Forecast c starts on same scratch');
      const old=stream.frames.get(0),oldRevision=stream.revisionAt(0);stream.frames.set(0,{...old,low:old.low.slice()});
      update();check(stream.revisionAt(0)!==oldRevision&&a.disposed&&u.uColumnsReady.value===0,'Revision replacement retires and unbinds ready a');
      check(bank.scratch.owner.map===forecastPartial,'Unrelated forecast partial retains its scratch lease');
      for(let i=0;i<11;i++)update();for(let i=0;i<12;i++)update();
      check(u.uColumnsReady.value===1,'Replacement pair recovers after complete real endpoints');
      checkpoint('Revision replacement recovery');
      // Stop a failed final tile draw before its canonical write; retry from p0.
      bank.dispose();bank=new CloudColumnBank(p,{producer:'tile',width:16,tileRows:3,footprintSamples:16,footprintBatch:4});p.cloudColumnMap=bank;
      update(3);const retry=bank.maps.get(0),quad=retry.quad,draw=quad.render;
      quad.render=()=>{throw Error('injected-final-draw');};
      let failed=false;try {update();}catch(error){failed=/injected-final-draw/.test(String(error));}
      quad.render=draw;check(failed&&retry.row===0&&retry.footprintCursor===0&&!bank.scratch.owner,'Failed final restarts tile without publishing');
      for(let i=0;i<24;i++)update();check(u.uColumnsReady.value===1,'Retried pair completes');
      checkpoint('Final-draw retry');
      // Invalidation during an actual forecast draw must not republish ready a/b.
      update(0);const c=bank.maps.get(frameHours*2),render=c.quad.render;
      c.quad.render=function(...args){render.apply(this,args);p.weatherField={...p.weatherField};};
      update();check(c.invalidated&&u.uColumnsReady.value===0,'Field replaced during draw prevents pair publication');
      update(0);check(c.disposed&&bank.scratch.owner===null,'Invalidated owner retired before replacement');
      checkpoint('Mid-draw field replacement');
      bank.dispose();check(u.uColumnsReady.value===0&&p.cloudColumnMap===null,'Bank disposal unbinds and detaches');
      // A real loss invalidates complete endpoints and a partial carry. This
      // controlled extension event is separate from unexpected context loss.
      bank=new CloudColumnBank(p,{producer:'tile',width:16,tileRows:3,footprintSamples:16,footprintBatch:4});p.cloudColumnMap=bank;
      r.setRenderTarget(null);update(12);update(12);update();
      const beforeLoss=[...bank.maps.values()],partial=bank.maps.get(frameHours*2),oldPrograms=Object.values(bank.programs);
      check(u.uColumnsReady.value===1&&partial.footprintCursor===4,'Actual loss starts with ready pair and partial forecast');
      const loss=gl.getExtension('WEBGL_lose_context');check(loss,'Controlled context extension required');
      const waitEvent=(name,trigger)=>new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(Error(name+' event unavailable')),15000);
        r.domElement.addEventListener(name,event=>{if(name==='webglcontextlost')event.preventDefault();clearTimeout(timer);resolve();},{once:true});
        trigger();
      });
      await waitEvent('webglcontextlost',()=>loss.loseContext());
      check(bank.scratch.lost&&partial.invalidated,'Loss invalidates the active carry');
      update(0);check(bank.maps.size===0&&u.uColumnsReady.value===0&&beforeLoss.every(map=>map.disposed),
        'Lost epoch unbinds and retires complete and partial endpoints');
      check(Object.keys(bank.programs).length===0,'Lost epoch drops old empty program leases');
      // The fixture owns these other pre-loss GPU resources too. Retire their
      // old renderer listeners while lost; source CPU images remain intact.
      for(const reference of references)reference.dispose();references.length=0;
      guard.dispose();guard=null;
      const inputs=new Set(Object.values(u).map(uniform=>uniform.value).filter(value=>value?.isTexture));
      for(const texture of inputs)texture.dispose();
      result.contextResourceBoundary='Fixture retires all its old input-texture/oracle/guard GPU owners while lost. Only the actual bank/scratch epoch recovery is under test; not a full-game restore.';
      // Let dispatch finish before asking the browser to restore this context.
      await new Promise(resolve=>setTimeout(resolve,100));
      await waitEvent('webglcontextrestored',()=>loss.restoreContext());result.contextEvents.push('restored');
      check(!bank.scratch.lost&&bank.scratch.epoch===1,'Scratch observes restored epoch');
      r.setRenderTarget(null);update(12);update(12);
      check(u.uColumnsReady.value===1&&Object.values(bank.programs).every(material=>!oldPrograms.includes(material)),
        'Restored complete pair owns new native programs');
      result.restoredNative=[];
      for(const hours of [0,frameHours]) {
        const reference=new CloudColumnMap(p,{width:16,samples:128,footprintSamples:16,hours});references.push(reference);
        reference.bakeSlice(r,8);const delta=differences(read(reference.target),read(bank.maps.get(hours).target));
        result.restoredNative.push({hours,delta});check(Object.values(delta).every(v=>v===0),'Restored pair matches fresh native integration');
      }
      checkpoint('Controlled context recovery');bank.dispose();
      checkpoint('Final');result.scratchBytes=2*16*3*9*4;
      result.forecast={frameHours,ready:stream.ready,hours:[0,frameHours,frameHours*2],revisions:[0,frameHours,frameHours*2].map(hours=>stream.revisionAt(hours))};
    } catch(error) {result.failure={message:String(error),stack:String(error.stack)};}
    finally {
      try {r?.setRenderTarget(null);bank?.dispose();for(const map of references)map.dispose();guard?.dispose();p?.dispose();r?.dispose();}
      catch(error){result.cleanupFailure=String(error);}
      if(r)result.cleanup={error:r.getContext().getError(),lost:r.getContext().isContextLost()};
    }
    return result;
  });
  report.after=await evidenceFingerprint(verifier);await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
  assert.deepEqual(report.before,report.after);assert.deepEqual(report.errors,[]);assert.deepEqual(report.driverWarnings,[]);
  assert.equal(report.result.failure,undefined,report.result.failure?.stack);assert.equal(report.result.cleanupFailure,undefined);
  assert.deepEqual(report.result.cleanup,{error:0,lost:false});
  assert.deepEqual(report.result.contextEvents,['lost','restored']);assert.ok(report.result.checks.every(row=>row.pass));
  console.log(`PASS: tiny real-forecast tile-bank lifecycle and native output (${report.result.checks.length} checks); ${out}/report.json`);
} catch(error) {
  report.failure={message:String(error),stack:String(error.stack)};await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));throw error;
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
