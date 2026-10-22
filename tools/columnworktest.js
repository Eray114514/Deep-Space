// Actual resumable producer classes with CPU renderer/resource doubles only.
// No WebGL context, shader execution, native parity or GPU-budget acceptance.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CloudColumnScratch, CloudColumnTileMap } from '../src/cloud/cloud-column-tile-map.js';
import { CloudColumnBank } from '../src/cloud/cloud-column-bank.js';
import { PlanetWeatherStream } from '../src/cloud/planet-weather-stream.js';

const fixtures=[],results=[],disposeCounts=new WeakMap();
function watch(resource) {
  if(resource&&!disposeCounts.has(resource)) {
    disposeCounts.set(resource,0);
    resource.addEventListener('dispose',()=>disposeCounts.set(resource,disposeCounts.get(resource)+1));
  }
  return resource;
}
const disposed=resource=>disposeCounts.get(resource)||0;
function rendererDouble({dpr=2,drawBuffers=3,float=true}={}) {
  let lost=false;
  const listeners=new Map(),host=watch(new THREE.WebGLCubeRenderTarget(16));
  host.viewport.set(1,2,10,8);host.scissor.set(2,3,7,5);host.scissorTest=true;
  const state={target:host,face:4,mip:2,viewport:host.viewport.toArray(),scissor:host.scissor.toArray(),scissorTest:true};
  const initialized=[],capabilityCalls=[];
  const forbidden=()=>{throw Error('CPU work producer must not wait, query completion, or read GPU output');};
  const gl={MAX_DRAW_BUFFERS:0x8824,isContextLost:()=>lost,
    getParameter(name){assert.equal(name,this.MAX_DRAW_BUFFERS);capabilityCalls.push('MAX_DRAW_BUFFERS');return drawBuffers;},
    getExtension(name){assert.equal(name,'EXT_color_buffer_float');capabilityCalls.push(name);return float?{}:null;},
    beginQuery:forbidden,endQuery:forbidden,getQueryParameter:forbidden,clientWaitSync:forbidden,finish:forbidden,readPixels:forbidden};
  const renderer={autoClear:true,domElement:{
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
    removeEventListener(name,fn){listeners.get(name)?.delete(fn);}},
    getContext:()=>gl,getPixelRatio:()=>dpr,getRenderTarget:()=>state.target,
    getActiveCubeFace:()=>state.face,getActiveMipmapLevel:()=>state.mip,
    initRenderTarget(target){initialized.push(target);},
    setRenderTarget(target,face=0,mip=0) {
      state.target=target;state.face=face;state.mip=mip;
      state.viewport=target.viewport.toArray();state.scissor=target.scissor.toArray();state.scissorTest=target.scissorTest;
    },
    setViewport:()=>{throw Error('Physical RT regions must not use DPR-scaled renderer.setViewport');},
    setScissor:()=>{throw Error('Physical RT regions must not use DPR-scaled renderer.setScissor');}};
  const capture=()=>({target:state.target,face:state.face,mip:state.mip,viewport:[...state.viewport],
    scissor:[...state.scissor],scissorTest:state.scissorTest,autoClear:renderer.autoClear,dpr:renderer.getPixelRatio()});
  return {renderer,state,host,initialized,capabilityCalls,capture,
    restored(before){assert.deepEqual(capture(),before,'Restore target/face/mip/physical viewport/scissor/autoClear/DPR');},
    lose(){lost=true;for(const fn of [...listeners.get('webglcontextlost')||[]])fn();},
    restore(){lost=false;for(const fn of [...listeners.get('webglcontextrestored')||[]])fn();},
    listenerCount(){return [...listeners.values()].reduce((sum,set)=>sum+set.size,0);},
    setCapabilities(buffers,extension){drawBuffers=buffers;float=extension;}};
}
function fixture(options) {
  const render=rendererDouble(options),atlas=watch(new THREE.DataTexture(new Float32Array([1,.5,0,1]),1,1,THREE.RGBAFormat,THREE.FloatType));
  const bands=watch(new THREE.DataArrayTexture(new Float32Array(16*4),1,1,16));
  bands.type=THREE.FloatType;bands.format=THREE.RGBAFormat;bands.image.data.set([1,1000,1800,1]);
  const stream={anchor:.25,frameHours:1,ready:true,frames:new Map(),generations:new WeakMap(),generation:0,disposed:false,
    revisionAt:PlanetWeatherStream.prototype.revisionAt};
  for(const hours of [.25,1.25,2.25])stream.frames.set(hours,{hours,low:atlas.image.data.slice(),high:atlas.image.data.slice(),
    bands:bands.image.data.slice(),bounds:atlas.image.data.slice()});
  const planet={weatherHours:.25,cloudSpinBase:0,weatherField:{windRadiansPerHour:0},weatherStream:stream,
    volCloudMat:{defines:{PRODUCTION_CLOUD_MEDIUM:1,CLOUD_FAR_VIEW:0,CLOUD_FAR_CACHE:0},uniforms:{
      uSpeciesMask:{value:-1},uWeatherMap:{value:atlas},uWeatherMapHi:{value:atlas},uSpeciesMap:{value:bands},uBandBounds:{value:atlas},
      uColumnsReady:{value:0},uColumnsJointReady:{value:0},uColumnMix:{value:0},
      uOpticalColumns:{value:atlas},uOpticalColumnsNext:{value:atlas},uColumnHeights:{value:atlas},uColumnHeightsNext:{value:atlas}}}};
  const f={...render,planet,stream,maps:[],scratches:[],owners:new Set(),draws:[],hook:null,
    scratch(width=8,rows=2) {
      const value=new CloudColumnScratch(width,rows);this.scratches.push(value);
      value.targets.forEach(watch);return value;
    },map(options={}) {
      const map=new CloudColumnTileMap(planet,options);
      return this.track(map,options.programOwner);
    },track(map,programOwner=map.programOwner) {
      const handles={map,work:watch(map.material),final:watch(map.finalMaterial),target:watch(map.target),
        snapshots:map.snapshots.map(watch),geometry:watch(map.quad._mesh.geometry)};
      map.scratch.targets.forEach(watch);this.maps.push(handles);if(programOwner)this.owners.add(programOwner);
      const quad=map.quad;
      quad.render=renderer=>{
        assert.equal(renderer,this.renderer);const material=quad.material,u=material.uniforms,target=this.state.target;
        const final=material.defines.COLUMN_TILE_FINAL===1;
        const previous=[u.uColumnPreviousTotal.value,u.uColumnPreviousMoments.value,u.uColumnPreviousJoint.value];
        assert.ok(previous.every(texture=>!target.textures.includes(texture)),'Never sample a current output attachment');
        const record={map,final,start:u.uColumnFootprintStart.value,count:u.uColumnFootprintCount.value,
          footprintSamples:u.uFootprintSamples.value,samples:u.uColumnSamples.value,size:u.uColumnSize.value.toArray(),
          tileOrigin:u.uColumnTileOrigin.value.toArray(),targetOrigin:u.uColumnTargetOrigin.value.toArray(),
          target,previous,viewport:target.viewport.toArray(),scissor:target.scissor.toArray(),
          scissorTest:target.scissorTest,autoClear:renderer.autoClear};
        this.draws.push(record);this.hook?.(map,record);
      };
      return handles;
    },work(map,grant=1,renderer=this.renderer) {
      const before=this.capture();
      try {return map.bakeWork(renderer,grant);} finally {this.restored(before);}
    },close() {
      for(const entry of this.maps)entry.map.dispose();
      for(const scratch of this.scratches)scratch.dispose();
      for(const owner of this.owners)for(const material of Object.values(owner))if(!disposed(material))material.dispose();
      atlas.dispose();bands.dispose();this.host.dispose();
      assert.equal(this.listenerCount(),0,'All scratch event subscriptions must retire');
    }};
  fixtures.push(f);return f;
}
function test(name,run) {
  const first=fixtures.length;let failure;
  try {run();} catch(error) {failure={message:error.message,stack:error.stack};}
  finally {
    for(const f of fixtures.slice(first))try {f.close();} catch(error) {failure||={message:error.message,stack:error.stack};}
  }
  results.push({name,passed:!failure,...failure&&{failure}});
}

test('formal defaults, physical scratch payload, zero/invalid grants do no work',()=>{
  const f=fixture(),{map}=f.map();
  assert.equal(map.width,1024);assert.equal(map.height,512);assert.equal(map.samples,128);
  assert.equal(map.footprintSamples,64);assert.equal(map.tileRows,2);assert.equal(map.footprintBatch,8);
  assert.equal(map.scratch.bytes,147456);assert.equal(map.scratch.targets.length,2);
  assert.equal(map.scratch.bytes,2*1024*2*(4+4+1)*Float32Array.BYTES_PER_ELEMENT);
  assert.ok(map.scratch.targets.every(target=>target.width===1024&&target.height===2&&target.textures.length===3
    &&target.textures.every(texture=>texture.type===THREE.FloatType&&texture.minFilter===THREE.NearestFilter)));
  for(const target of map.scratch.targets)
    assert.deepEqual(target.textures.map(texture=>texture.format),[THREE.RGBAFormat,THREE.RGBAFormat,THREE.RedFormat]);
  const snapshots=map.snapshots.slice(),zero=f.work(map,0);
  assert.deepEqual(zero,{draws:0,committedRows:0,row:0,footprintCursor:0,ready:false,invalidated:false,disposed:false,blocked:false});
  assert.equal(map.scratch.owner,null);assert.equal(f.initialized.length,0);assert.equal(f.capabilityCalls.length,0);
  assert.equal(f.draws.length,0);assert.equal(map.uploadMs.length,0);assert.equal(f.listenerCount(),0);
  assert.ok(snapshots.every(texture=>disposed(texture)===0));
  for(const grant of [-1,.5,NaN,Infinity])assert.throws(()=>f.work(map,grant),/nonnegative draw count/);
});

test('work/final share the exact immutable input and uniform owners',()=>{
  const f=fixture(),entry=f.map({width:8});
  assert.equal(entry.final.uniforms,entry.work.uniforms,'Clone must not create untracked weather/noise/parameter texture wrappers');
  for(const name of ['uWeatherMap','uWeatherMapHi','uSpeciesMap','uBandBounds'])
    assert.equal(entry.final.uniforms[name].value,entry.work.uniforms[name].value);
});

test('8-footprint ranges commit only final tiles and release only after the last canonical tile',()=>{
  const f=fixture(),entry=f.map({width:8}),{map}=entry;
  for(let index=0;index<16;index++) {
    const result=f.work(map,1),draw=f.draws.at(-1),final=index%8===7;
    assert.equal(result.draws,1);assert.equal(result.committedRows,final?2:0);
    assert.equal(result.row,Math.floor((index+1)/8)*2);assert.equal(result.footprintCursor,(index+1)%8*8);
    assert.equal(draw.start,index%8*8);assert.equal(draw.count,8);assert.equal(draw.final,final);
    assert.equal(draw.footprintSamples,64);assert.equal(draw.samples,128);assert.deepEqual(draw.size,[8,4]);
    assert.deepEqual(draw.tileOrigin,[0,Math.floor(index/8)*2]);
    assert.deepEqual(draw.targetOrigin,[0,final?Math.floor(index/8)*2:0]);
    assert.equal(draw.autoClear,false);assert.equal(draw.scissorTest,true);
    assert.equal(draw.target.textures.length,final?2:3);
    assert.equal(result.ready,index===15);
    if(index<15) {
      assert.ok(entry.snapshots.every(texture=>disposed(texture)===0));assert.equal(disposed(entry.geometry),0);
      assert.equal(map.material,entry.work);assert.equal(map.finalMaterial,entry.final);
    }
  }
  assert.equal(map.row,4);assert.equal(map.footprintCursor,0);assert.equal(map.lease,null);assert.equal(map.scratch.owner,null);
  assert.equal(map.scratch.disposed,true);assert.equal(map.snapshots.length,0);assert.equal(map.material,null);
  assert.equal(map.finalMaterial,null);assert.equal(map.quad,null);assert.equal(disposed(entry.geometry),1);
  assert.ok(entry.snapshots.every(texture=>disposed(texture)===1));assert.equal(disposed(entry.target),0);
  assert.equal(disposed(entry.work),1);assert.equal(disposed(entry.final),1);
  const draws=f.draws.length;assert.equal(f.work(map,8).draws,0);assert.equal(f.draws.length,draws);
});

test('shared A/B lease exclusion, cancellation and stale release cannot clear a new lease',()=>{
  const f=fixture(),scratch=f.scratch(),a=f.map({width:8,scratch}).map,b=f.map({width:8,scratch}).map;
  f.work(a);const token=a.lease;
  const blocked=f.work(b,8);assert.equal(blocked.blocked,true);assert.equal(blocked.draws,0);assert.equal(b.footprintCursor,0);
  assert.equal(scratch.owner.map,a);a.invalidate('cancel');assert.equal(a.footprintCursor,0);assert.equal(scratch.owner,null);
  f.work(b);const nextToken=b.lease;assert.notEqual(nextToken,token);assert.equal(scratch.owner.map,b);
  scratch.release(a,token);a.dispose();assert.equal(scratch.owner.map,b);assert.equal(scratch.owner.token,nextToken);
  f.work(b);assert.equal(f.draws.at(-1).start,8);assert.equal(b.footprintCursor,16);assert.equal(scratch.disposed,false);
});

for(const failureStart of [0,8,56])test(`throw at p${failureStart} retries the whole tile at p0`,()=>{
  const f=fixture(),{map}=f.map({width:4});
  f.work(map,failureStart/8);let once=true;
  f.hook=(_map,draw)=>{if(once){once=false;assert.equal(draw.start,failureStart);throw Error('uncertain draw');}};
  assert.throws(()=>f.work(map,1),/uncertain draw/);
  assert.equal(map.row,0);assert.equal(map.footprintCursor,0);assert.equal(map.scratchIndex,-1);
  assert.equal(map.lease,null);assert.equal(map.scratch.owner,null);assert.equal(map.ready,false);assert.equal(map.invalidated,false);
  f.hook=null;f.work(map);assert.equal(f.draws.at(-1).start,0);assert.equal(map.footprintCursor,8);
  assert.equal(f.work(map,7).ready,true);
});

test('throw on the last canonical draw preserves previously committed rows',()=>{
  const f=fixture(),{map}=f.map({width:8});f.work(map,15);assert.equal(map.row,2);assert.equal(map.footprintCursor,56);
  f.hook=()=>{throw Error('final draw');};assert.throws(()=>f.work(map),/final draw/);
  assert.equal(map.row,2);assert.equal(map.ready,false);assert.equal(map.footprintCursor,0);
  f.hook=null;const result=f.work(map,8);assert.equal(result.row,4);assert.equal(result.ready,true);
});

for(const change of ['field','mask','frame-revision','stream-replacement','stream-null','stream-disposed'])
  test(`source ${change} invalidates and releases partial work before another draw`,()=>{
    const f=fixture(),{map}=f.map({width:8});f.work(map);const count=f.draws.length;
    if(change==='field')f.planet.weatherField={windRadiansPerHour:0};
    else if(change==='mask')f.planet.volCloudMat.uniforms.uSpeciesMask.value=3;
    else if(change==='frame-revision')f.stream.frames.set(.25,{...f.stream.frames.get(.25)});
    else if(change==='stream-replacement')f.planet.weatherStream={...f.stream,generations:new WeakMap(),generation:0};
    else if(change==='stream-null')f.planet.weatherStream=null;
    else f.stream.disposed=true;
    const result=f.work(map,8);
    assert.equal(result.invalidated,true);assert.equal(result.draws,0);assert.equal(result.ready,false);
    assert.equal(result.footprintCursor,0);assert.equal(map.scratch.owner,null);assert.equal(f.draws.length,count);
    assert.equal(f.work(map,8).draws,0);
  });

test('source replacement during final submission never commits or publishes that tile',()=>{
  const f=fixture(),{map}=f.map({width:4});f.work(map,7);
  f.hook=()=>{f.planet.weatherField={windRadiansPerHour:0};};
  const result=f.work(map);assert.equal(result.draws,1);assert.equal(result.row,0);
  assert.equal(result.ready,false);assert.equal(result.invalidated,true);assert.equal(map.footprintCursor,0);
});

test('loss invalidates the lease, restore reinitializes scratch, and old epochs cannot resume',()=>{
  const f=fixture(),scratch=f.scratch(),a=f.map({width:8,scratch}).map;
  f.work(a);assert.equal(scratch.epoch,0);assert.equal(f.initialized.length,2);f.lose();
  assert.equal(a.invalidated,true);assert.equal(a.reason,'context-lost');assert.equal(a.footprintCursor,0);assert.equal(scratch.owner,null);
  const b=f.map({width:8,scratch}).map;assert.throws(()=>f.work(b),/context is lost/);f.restore();
  f.work(b);assert.equal(b.contextEpoch,1);assert.equal(f.initialized.length,4);assert.equal(f.work(a).draws,0);
  b.dispose();const c=f.map({width:8,scratch}).map;f.work(c,8);assert.equal(c.row,2);assert.equal(scratch.owner,null);
  f.lose();f.restore();assert.equal(c.invalidated,false,'No lease was active during this second loss');
  const count=f.draws.length,result=f.work(c);
  assert.equal(result.invalidated,true);assert.equal(c.reason,'context-epoch');assert.equal(f.draws.length,count);
});

test('renderer identity rejects migration, including a reused free scratch',()=>{
  const f=fixture(),other=rendererDouble(),scratch=f.scratch(),a=f.map({width:8,scratch}).map;
  try {
    f.work(a);assert.throws(()=>a.bakeWork(other.renderer),/cannot cross renderers/);
    assert.equal(scratch.owner.map,a);assert.equal(other.initialized.length,0);
    a.invalidate('handoff');const b=f.map({width:8,scratch}).map;
    const before=other.capture();assert.throws(()=>b.bakeWork(other.renderer),/cannot cross renderers/);other.restored(before);
    assert.equal(b.footprintCursor,0);assert.equal(scratch.owner,null);assert.equal(other.initialized.length,0);
  } finally {other.host.dispose();}
});

test('nondivisible footprint range and three-row tail retain original sample indices and physical rectangles',()=>{
  const f=fixture({dpr:1.25}),{map}=f.map({width:10,tileRows:3,footprintSamples:10,footprintBatch:8});
  const result=f.work(map,20);assert.equal(result.draws,4);assert.equal(result.row,5);assert.equal(result.ready,true);
  assert.deepEqual(f.draws.map(draw=>[draw.start,draw.count,draw.final]),[[0,8,false],[8,2,true],[0,8,false],[8,2,true]]);
  assert.deepEqual(f.draws.map(draw=>draw.scissor),[[0,0,10,3],[0,0,10,3],[0,0,10,2],[0,3,10,2]]);
  assert.deepEqual(f.draws.map(draw=>draw.viewport),[[0,0,10,3],[0,0,10,5],[0,0,10,3],[0,0,10,5]]);
  assert.deepEqual(f.draws.map(draw=>draw.tileOrigin),[[0,0],[0,0],[0,3],[0,3]]);
  assert.deepEqual(f.draws.map(draw=>draw.targetOrigin),[[0,0],[0,0],[0,0],[0,3]]);
  assert.ok(f.draws.every(draw=>draw.footprintSamples===10&&draw.samples===128));
});

for(const capabilities of [{drawBuffers:2},{float:false}])test(`unsupported float MRT restores state and can retry (${JSON.stringify(capabilities)})`,()=>{
  const f=fixture(capabilities),{map}=f.map({width:8});
  assert.throws(()=>f.work(map),/requires float MRT/);assert.equal(map.lease,null);assert.equal(map.footprintCursor,0);
  assert.equal(f.initialized.length,0);assert.equal(f.draws.length,0);
  f.setCapabilities(3,true);assert.equal(f.work(map).draws,1);
});

test('disposing shared scratch invalidates its borrower and leaves no subscription or target lease',()=>{
  const f=fixture(),scratch=f.scratch(),{map}=f.map({width:8,scratch});f.work(map);scratch.dispose();scratch.dispose();
  assert.equal(map.invalidated,true);assert.equal(map.reason,'scratch-disposed');assert.equal(map.lease,null);
  assert.equal(scratch.owner,null);assert.equal(f.work(map).draws,0);assert.equal(f.listenerCount(),0);
  assert.ok(scratch.targets.every(target=>disposed(target)===1));
});

test('both program leases retain empty dictionaries once, later maps release their own materials',()=>{
  const f=fixture(),owner={},first=f.map({width:4,programOwner:owner});f.work(first.map,8);
  assert.equal(owner.tileWork,first.work);assert.equal(owner.tileFinal,first.final);
  assert.deepEqual(Object.keys(first.work.uniforms),[]);assert.deepEqual(Object.keys(first.final.uniforms),[]);
  assert.equal(disposed(first.work),0);assert.equal(disposed(first.final),0);
  const second=f.map({width:4,programOwner:owner});f.work(second.map,8);
  assert.equal(owner.tileWork,first.work);assert.equal(owner.tileFinal,first.final);
  assert.equal(disposed(second.work),1);assert.equal(disposed(second.final),1);
  second.map.dispose();first.map.dispose();assert.equal(disposed(first.work),0);assert.equal(disposed(first.final),0);
  assert.equal(disposed(first.target),1);assert.equal(disposed(second.target),1);
  owner.tileWork.dispose();owner.tileFinal.dispose();assert.equal(disposed(first.work),1);assert.equal(disposed(first.final),1);
});

test('cancelled partials release snapshots while retaining both clean program owners',()=>{
  const f=fixture(),owner={},entry=f.map({width:8,programOwner:owner});f.work(entry.map);entry.map.dispose();entry.map.dispose();
  assert.equal(owner.tileWork,entry.work);assert.equal(owner.tileFinal,entry.final);
  assert.ok(entry.snapshots.every(texture=>disposed(texture)===1));assert.equal(disposed(entry.geometry),1);
  assert.deepEqual(Object.keys(entry.work.uniforms),[]);assert.deepEqual(Object.keys(entry.final.uniforms),[]);
  assert.equal(entry.map.scratch.owner,null);assert.equal(entry.map.scratch.disposed,true);
});

test('synchronous disposal during the final draw cannot revive progress or ready',()=>{
  const f=fixture(),{map}=f.map({width:4});f.work(map,7);f.hook=()=>map.dispose();
  const result=f.work(map);assert.equal(result.disposed,true);assert.equal(map.disposed,true);assert.equal(map.ready,false);
  assert.equal(map.row,0);assert.equal(map.footprintCursor,0);
  assert.equal(map.scratch.owner,null);const draws=f.draws.length;
  assert.equal(f.work(map,8).draws,0);assert.equal(f.draws.length,draws);
});

test('same-map reentry must block or reject before duplicating a footprint range',()=>{
  const f=fixture(),{map}=f.map({width:8});let nested=false,nestedResult,nestedError;
  f.hook=()=>{
    if(nested)return;nested=true;
    try {nestedResult=map.bakeWork(f.renderer);} catch(error) {nestedError=error;}
  };
  const result=f.work(map);
  assert.ok(nestedError||(nestedResult.blocked&&nestedResult.draws===0),'Reentrant work must not submit');
  assert.equal(result.draws,1);assert.equal(f.draws.length,1);assert.equal(map.footprintCursor,8);
});

for(const cancellation of ['invalidate','dispose'])test(`A ${cancellation} inside draw cannot lend scratch to reentrant B`,()=>{
  const f=fixture(),scratch=f.scratch(),a=f.map({width:8,scratch}),b=f.map({width:8,scratch});
  let blocked,oldToken;
  if(cancellation==='dispose')for(const resource of [a.target,a.work,a.final,a.geometry,...a.snapshots])
    resource.addEventListener('dispose',()=>assert.equal(f.state.target,f.host,'Map resources retire after the caller target is restored'));
  f.hook=(map)=>{
    assert.equal(map,a.map);oldToken=map.lease;assert.equal(scratch.drawing,map);
    if(cancellation==='dispose')map.dispose();else map.invalidate('cancel-inside-draw');
    assert.equal(scratch.owner,null);assert.equal(scratch.drawing,map);
    assert.ok([a.target,a.work,a.final,a.geometry,...a.snapshots].every(resource=>disposed(resource)===0),
      'Cancellation must keep every resource alive until the draw returns');
    blocked=f.work(b.map,1);assert.equal(blocked.blocked,true);assert.equal(blocked.draws,0);
    assert.equal(b.map.footprintCursor,0);assert.equal(scratch.drawing,map);assert.equal(f.draws.length,1);
  };
  f.work(a.map,1);assert.equal(scratch.drawing,null);assert.equal(scratch.owner,null);
  assert.equal(a.map.row,0);assert.equal(a.map.ready,false);assert.equal(a.map.footprintCursor,0);
  if(cancellation==='dispose')assert.ok([a.target,a.work,a.final,a.geometry,...a.snapshots].every(resource=>disposed(resource)===1));
  f.hook=null;f.work(b.map,1);assert.equal(scratch.owner.map,b.map);assert.equal(b.map.footprintCursor,8);
  scratch.release(a.map,oldToken);a.map.dispose();assert.equal(scratch.owner.map,b.map);
  assert.equal(scratch.disposed,false);
});

for(const throws of [false,true])test(`scratch disposal inside draw defers target release until endDraw (${throws?'throw':'return'})`,()=>{
  const f=fixture(),scratch=f.scratch(),{map}=f.map({width:8,scratch});let returnedFromQuad=false;
  const render=map.quad.render;
  map.quad.render=function(renderer){try{return render.call(this,renderer);}finally{returnedFromQuad=true;}};
  for(const target of scratch.targets)target.addEventListener('dispose',()=>{
    assert.equal(returnedFromQuad,true,'Working attachments must survive the complete draw call');
    assert.equal(scratch.drawing,null);
  });
  f.hook=()=>{
    assert.equal(scratch.drawing,map);scratch.dispose();scratch.dispose();
    assert.equal(scratch.released,false);assert.equal(scratch.owner,null);
    assert.equal(map.invalidated,true);assert.ok(scratch.targets.every(target=>disposed(target)===0));
    if(throws)throw Error('draw after scratch disposal');
  };
  if(throws)assert.throws(()=>f.work(map),/draw after scratch disposal/);else f.work(map);
  assert.equal(scratch.drawing,null);assert.equal(scratch.released,true);
  assert.ok(scratch.targets.every(target=>disposed(target)===1));
  assert.equal(map.row,0);assert.equal(map.footprintCursor,0);assert.equal(map.ready,false);
  assert.equal(f.listenerCount(),0);assert.equal(f.work(map).draws,0);
});

test('bank disposal during a map draw must not revive abandoned program leases',()=>{
  const f=fixture(),bank=new CloudColumnBank(f.planet,{producer:'tile',width:4,workQuanta:0});
  f.scratches.push(bank.scratch);
  try {
    bank.update(f.renderer);const map=bank.maps.get(.25),entry=f.track(map),owner=bank.programs;
    f.hook=()=>bank.dispose();bank.update(f.renderer,{workQuanta:1});
    assert.equal(bank.disposed,true);assert.equal(map.disposed,true);assert.equal(map.resourcesReleased,true);
    assert.equal(disposed(entry.work),1,'An ended retired owner must dispose late work material instead of retaining it');
    assert.equal(disposed(entry.final),1,'An ended retired owner must dispose late final material instead of retaining it');
    assert.equal(map.ready,false);assert.equal(map.row,0);assert.equal(bank.maps.size,0);
    assert.notEqual(bank.programs,owner);assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
  } finally {bank.dispose();}
});

for(const reset of ['field','context-epoch'])test(`bank ${reset} reset during draw must retire the deferred map program owner`,()=>{
  const f=fixture(),bank=new CloudColumnBank(f.planet,{producer:'tile',width:4,workQuanta:0});
  f.scratches.push(bank.scratch);
  try {
    bank.update(f.renderer);const map=bank.maps.get(.25),entry=f.track(map),owner=bank.programs;
    f.hook=()=>{
      if(reset==='field')f.planet.weatherField={windRadiansPerHour:0};
      else {f.lose();f.restore();}
      bank.update(f.renderer,{workQuanta:0});
      assert.equal(disposed(entry.work),0,'The active draw still owns its material until finally');
    };
    bank.update(f.renderer,{workQuanta:1});
    assert.equal(map.row,0);assert.equal(map.ready,false);assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
    f.hook=null;bank.update(f.renderer,{workQuanta:0});
    assert.notEqual(bank.programs,owner);assert.equal(map.disposed,true);
    assert.equal(map.resourcesReleased,true);assert.equal(disposed(entry.work),1);assert.equal(disposed(entry.final),1);
    assert.equal(map.row,0);assert.equal(map.ready,false);assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
    assert.notEqual(bank.maps.get(.25),map);assert.equal(bank.maps.get(.25).ready,false);
  } finally {bank.dispose();}
});

function readyBank(f) {
  const bank=new CloudColumnBank(f.planet,{producer:'tile',width:4,workQuanta:0});f.scratches.push(bank.scratch);
  bank.update(f.renderer);const first=f.track(bank.maps.get(.25));f.work(first.map,8);
  bank.update(f.renderer);const second=f.track(bank.maps.get(1.25));f.work(second.map,8);
  bank.update(f.renderer);const forecast=f.track(bank.maps.get(2.25));f.work(forecast.map,8);
  assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,1);
  return {bank,first,second,forecast};
}

function trackBankMaps(f,bank) {
  for(const map of bank.maps.values())if(!f.maps.some(entry=>entry.map===map))f.track(map);
}

function assertBankResources(f,bank) {
  const retained=new Set(Object.values(bank.programs));
  for(const map of bank.maps.values())for(const material of [map.material,map.finalMaterial])if(material)retained.add(material);
  for(const entry of f.maps) {
    assert.ok(entry.map.disposed||bank.maps.get(entry.map.generation)===entry.map,
      'Every live replacement must remain owned by the bank or be disposed before removal');
    for(const material of [entry.work,entry.final]) {
      assert.ok(disposed(material)<=1,'A material must never be disposed twice during nested retirement');
      if(!retained.has(material))assert.equal(disposed(material),1,'No material may survive in an abandoned program pool');
    }
  }
}

function assertBankUnbound(f) {
  const u=f.planet.volCloudMat.uniforms;
  assert.equal(u.uColumnsReady.value,0);assert.equal(u.uColumnsJointReady.value,0);
  for(const name of ['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'])
    assert.equal(u[name].value,u.uWeatherMap.value,'Retired endpoints must be unbound even behind the disabled ready branch');
}

test('single-map retirement cannot orphan a same-hour replacement created by a dispose listener',()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0;
  try {
    first.target.addEventListener('dispose',()=>{
      callbacks++;bank.update(f.renderer,{workQuanta:0});
      trackBankMaps(f,bank);
    });
    f.stream.frames.set(.25,{...f.stream.frames.get(.25)});bank.update(f.renderer,{workQuanta:0});
    assert.equal(callbacks,1);assert.equal(first.map.disposed,true);
    assertBankResources(f,bank);
    assert.ok(bank.maps.get(.25));assert.notEqual(bank.maps.get(.25),first.map);
    assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
  } finally {bank.dispose();}
});

test('whole-bank retirement cannot republish a disposing endpoint through an update listener',()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0,duringReady;
  try {
    first.target.addEventListener('dispose',()=>{
      callbacks++;bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
      duringReady=f.planet.volCloudMat.uniforms.uColumnsReady.value;
    });
    bank.retireMaps();
    assert.equal(callbacks,1);assert.equal(duringReady,0,'A disposing endpoint must never become sampleable again');
    assert.equal(bank.maps.size,0);assertBankUnbound(f);
    assertBankResources(f,bank);
  } finally {bank.dispose();}
});

for(const reentry of ['update','retireMaps','dispose'])test(`bank.dispose listener reentry into ${reentry} is idempotent and owns no new resources`,()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0;
  try {
    first.target.addEventListener('dispose',()=>{
      callbacks++;
      if(reentry==='update')bank.update(f.renderer,{workQuanta:0});else bank[reentry]();
      trackBankMaps(f,bank);
    });
    bank.dispose();assert.equal(callbacks,1);assert.equal(bank.disposed,true);assert.equal(bank.maps.size,0);
    assert.equal(bank.scratch,null);assertBankUnbound(f);
    assertBankResources(f,bank);
  } finally {bank.dispose();}
});

for(const reset of ['field','mask','context-epoch'])test(`bank ${reset} reset cannot abandon replacements or program pools through a dispose listener`,()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0;
  try {
    first.target.addEventListener('dispose',()=>{
      callbacks++;bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
    });
    if(reset==='field')f.planet.weatherField={windRadiansPerHour:0};
    else if(reset==='mask')f.planet.volCloudMat.uniforms.uSpeciesMask.value=3;
    else {f.lose();f.restore();}
    bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
    assert.equal(callbacks,1);assertBankResources(f,bank);
    assert.ok(bank.maps.get(.25));assert.notEqual(bank.maps.get(.25),first.map);
    assert.equal(bank.maps.get(.25).programOwner,bank.programs,'A new map must borrow the currently owned program pool');
    assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
  } finally {bank.dispose();}
});

test('program material disposal listener cannot dispose its old pool twice or steal the replacement pool',()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0,once=false;
  try {
    first.work.addEventListener('dispose',()=>{
      callbacks++;if(once)return;once=true;
      bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
    });
    f.planet.weatherField={windRadiansPerHour:0};bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
    assert.equal(callbacks,1);assertBankResources(f,bank);
    for(const map of bank.maps.values())assert.equal(map.programOwner,bank.programs);
  } finally {bank.dispose();}
});

for(const reset of ['frame-revision','field','context-epoch'])test(`disposing the bank from a ${reset} retirement listener stops the outer update`,()=>{
  const f=fixture(),{bank,first}=readyBank(f);let callbacks=0;
  try {
    first.target.addEventListener('dispose',()=>{callbacks++;bank.dispose();});
    if(reset==='frame-revision')f.stream.frames.set(.25,{...f.stream.frames.get(.25)});
    else if(reset==='field')f.planet.weatherField={windRadiansPerHour:0};
    else {f.lose();f.restore();}
    bank.update(f.renderer,{workQuanta:0});trackBankMaps(f,bank);
    assert.equal(callbacks,1);assert.equal(bank.disposed,true);assert.equal(bank.maps.size,0,
      'An outer update must not construct another producer after a listener disposed its bank');
    assert.equal(bank.scratch,null);assertBankUnbound(f);
    assertBankResources(f,bank);
  } finally {bank.dispose();}
});

test('zero admission retires stale sources without copying a new immutable snapshot',()=>{
  const f=fixture(),bank=new CloudColumnBank(f.planet,{producer:'tile',width:4,workQuanta:0});
  f.scratches.push(bank.scratch);
  try {
    for(const frame of f.stream.frames.values())for(const value of Object.values(frame))if(ArrayBuffer.isView(value)) {
      value.slice=()=>{throw Error('Zero-admission snapshot copy');};
    }
    bank.update(f.renderer,{workQuanta:0,allowCreate:false});
    assert.equal(bank.maps.size,0);assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);
    assert.equal(bank.scratch.owner,null);
  } finally {bank.dispose();}
});

test('zero admission can publish an existing pair and unbind a replaced revision without reconstruction',()=>{
  const f=fixture(),{bank,first}=readyBank(f);
  try {
    bank.update(f.renderer,{workQuanta:0,allowCreate:false});
    assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,1);
    f.stream.frames.set(.25,{...f.stream.frames.get(.25)});
    bank.update(f.renderer,{workQuanta:0,allowCreate:false});
    assert.equal(first.map.disposed,true);assert.equal(bank.maps.has(.25),false);
    assert.equal(f.planet.volCloudMat.uniforms.uColumnsReady.value,0);assertBankResources(f,bank);
  } finally {bank.dispose();}
});

test('absolute production plans distinguish first use from retirement and report partial draw work',()=>{
  const f=fixture(),bank=new CloudColumnBank(f.planet,{producer:'tile',width:4,tileRows:2,footprintBatch:8,workQuanta:0});
  f.scratches.push(bank.scratch);
  try {
    const before=bank.plan(),forecast=before.jobs[2];
    assert.equal(bank.maps.size,0);assert.equal(forecast.firstNeededHours,before.anchor+before.frameHours);
    assert.equal(forecast.retiresAtHours,forecast.hours+before.frameHours);assert.equal(forecast.remainingDraws,8);
    bank.update(f.renderer,{workQuanta:0});const map=bank.maps.get(.25);f.track(map);
    const submitted=bank.update(f.renderer,{workQuanta:1,allowCreate:false});assert.equal(submitted.draws,1);
    const partial=bank.plan().jobs[0];assert.equal(partial.footprintCursor,8);assert.equal(partial.remainingDraws,7);
    assert.equal(partial.ready,false);assert.notEqual(partial.revision,null);
  } finally {bank.dispose();}
});

console.log(JSON.stringify({passed:results.every(result=>result.passed),cases:results.length,results,
  scope:'Pure CPU contracts: actual TileMap/Scratch/material/revision classes, recorded uniforms/targets/rectangles and resource events. No shader execution, actual GPU completion, native parity, throughput or dynamic-budget acceptance.'},null,2));
assert.equal(results.filter(result=>!result.passed).length,0,'Column work contracts failed; see individual cases above');
