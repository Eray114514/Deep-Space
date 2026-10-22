// Execute the actual pipeline profiling hooks and volume render method with a
// CPU renderer/query double. This checks attribution, call order and rollback,
// not GPU execution, image parity or performance.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GameLegacyPipeline } from '../src/legacy-render-pipeline.js';
import { VolumetricPass } from '../src/volumetric-pass-webgl.js';

const phases=['cloud-columns','volume-current','volume-resolve','volume-composite'];
let cases=0;
function fixture({profile=false,failure=null,batched=false}={}) {
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1.6,.1,1e9);
  camera.layers.mask=19;
  const pass=new VolumetricPass(scene,camera);pass.clear=true;
  const originalRender=pass.render,events=[],listeners=new Map();
  const initialTarget={name:'original-target'},readBuffer={texture:{},depthTexture:{}},writeBuffer={name:'write-buffer'};
  const state={target:initialTarget,face:3,mip:2,color:new THREE.Color(.2,.3,.4),alpha:.75};
  let time=0,query=null,queryStarts=0,queryEnds=0,queryReads=0,queryDeletes=0;
  const ext={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2};
  const gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,
    getExtension:()=>ext,isContextLost:()=>false,getParameter:()=>false,getQuery:()=>query,
    createQuery:()=>({}),beginQuery:(_target,value)=>{assert.equal(query,null);query=value;queryStarts++;},
    endQuery:()=>{assert.ok(query);query=null;queryEnds++;},deleteQuery:()=>queryDeletes++,
    getQueryParameter:(_value,kind)=>{
      if(kind===4)return true;
      assert.equal(kind,5);queryReads++;return 1000000;
    }};
  const label=target=>target?.texture?.name||target?.name||'screen';
  const renderer={autoClear:false,getContext:()=>gl,domElement:{
    addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)},
    getRenderTarget:()=>state.target,getActiveCubeFace:()=>state.face,getActiveMipmapLevel:()=>state.mip,
    setRenderTarget(target,face=0,mip=0){state.target=target;state.face=face;state.mip=mip;events.push(`target:${label(target)}`);},
    getClearAlpha:()=>state.alpha,getClearColor:out=>out.copy(state.color),
    setClearColor(color,alpha=state.alpha){state.color.set(color);state.alpha=alpha;events.push('clear-state');},
    clear(...args){events.push(`clear:${label(state.target)}:${args.join(',')}`);time+=.25;},
    render(){
      const phase=state.target===pass.current?'volume-current':state.target===pass.historyWrite?'volume-resolve':'volume-composite';
      events.push(`draw:${phase}:layers=${camera.layers.mask}`);time+=2;
      if(failure===phase)throw Error(phase);
    }};
  pass.updateCloudColumns=context=>{
    assert.equal(context,renderer);events.push('columns');time++;
    if(failure==='cloud-columns')throw Error(failure);
  };
  const originalBatches=pass.renderLightBatches;
  pass.renderLightBatches=function(context) {
    events.push('batch-check');
    if(batched) {
      events.push('batched-draw');time+=2;
      if(failure==='volume-current')throw Error(failure);
      return true;
    }
    return originalBatches.call(this,context);
  };
  // No pipeline constructor or renderer is needed: these are the production
  // methods, with only their composer pass list and timer owner supplied.
  const pipeline=Object.create(GameLegacyPipeline.prototype);
  class OpaqueFixture {render(){events.push('opaque');time++;return 'opaque-result';}}
  const opaque=new OpaqueFixture(),opaqueRender=opaque.render;
  Object.assign(pipeline,{renderer,volumePass:pass,composer:{passes:[opaque,pass]},profiler:null});
  if(profile)pipeline.startProfiling({every:1,now:()=>time});
  const initial={target:state.target,face:state.face,mip:state.mip,color:state.color.toArray(),alpha:state.alpha,
    autoClear:renderer.autoClear,mask:camera.layers.mask,read:pass.historyRead,write:pass.historyWrite};
  function restored() {
    assert.equal(state.target,initial.target);assert.equal(state.face,initial.face);assert.equal(state.mip,initial.mip);
    assert.deepEqual(state.color.toArray(),initial.color);assert.equal(state.alpha,initial.alpha);
    assert.equal(renderer.autoClear,initial.autoClear);assert.equal(camera.layers.mask,initial.mask);
    assert.equal(query,null,'Every child timer must close even on a failing render');
  }
  return {pipeline,pass,events,originalRender,opaque,opaqueRender,initial,
    get queryStarts(){return queryStarts;},get queryEnds(){return queryEnds;},get queryReads(){return queryReads;},
    get queryDeletes(){return queryDeletes;},get listeners(){return listeners.size;},
    draw(){pipeline.profiler?.beginFrame();return pass.render(renderer,writeBuffer,readBuffer);},restored,
    close(){pipeline.stopProfiling();assert.equal(pass.profiler,null);assert.equal(pass.render,originalRender);
      assert.equal(opaque.render,opaqueRender);pass.dispose();assert.equal(listeners.size,0);}};
}

for(const batched of [false,true]) {
  let baseline;
  for(const profile of [false,true]) {
    const f=fixture({profile,batched});
    try {
      f.draw();f.restored();
      assert.equal(f.pass.frame,1);assert.equal(f.pass.frameState.sequence,1);assert.equal(f.pass.frameState.pending,false);
      assert.equal(f.pass.historyRead,f.initial.write);assert.equal(f.pass.historyWrite,f.initial.read);
      if(!profile) {
        baseline=f.events.slice();assert.equal(f.queryStarts,0);assert.equal(f.queryEnds,0);assert.equal(f.queryReads,0);
      } else {
        assert.deepEqual(f.events,baseline,'Profiling must preserve renderer and draw call order');
        const p=f.pipeline.profiler,records=p.records;
        assert.deepEqual(records.map(row=>row.name),['1:VolumetricPass',...phases]);
        assert.equal(records[0].scope,'cpu');assert.equal(records[0].cpuInclusive,true);assert.equal(records[0].gpuMs,null);
        assert.ok(records.slice(1).every(row=>row.scope==='gpu'&&row.cpuInclusive));
        assert.equal(p.skipped,0);assert.equal(f.queryStarts,4);assert.equal(f.queryEnds,4);
        assert.equal(p.active,false);assert.equal(f.queryReads,0,'Queries are not polled between draws');
        const snapshot=p.snapshot();
        assert.equal(snapshot.records[0].gpuMs,null);
        assert.ok(snapshot.records.slice(1).every(row=>row.gpuMs===1));
        assert.equal(f.queryReads,4);assert.equal(f.queryDeletes,4);
      }
      cases++;
    } finally {f.close();}
  }
}

for(const failure of phases)for(const profile of [false,true]) {
  const f=fixture({profile,failure});
  try {
    assert.throws(()=>f.draw(),new RegExp(failure));f.restored();
    assert.equal(f.pass.historyValid,false);assert.equal(f.pass.frame,0);assert.equal(f.pass.frameState.sequence,0);
    assert.equal(f.pass.frameState.pending,false);assert.equal(f.pass.frameState.valid,false);
    assert.equal(f.pass.historyRead,f.initial.read);assert.equal(f.pass.historyWrite,f.initial.write);
    if(profile) {
      assert.deepEqual(f.pipeline.profiler.records.map(row=>row.name),
        ['1:VolumetricPass',...phases.slice(0,phases.indexOf(failure)+1)]);
      assert.equal(f.queryStarts,phases.indexOf(failure)+1);assert.equal(f.queryEnds,f.queryStarts);
      assert.equal(f.pipeline.profiler.active,false);
    } else assert.equal(f.queryStarts,0);
    cases++;
  } finally {f.close();}
}

const repeated=fixture();
try {
  repeated.pipeline.startProfiling({every:1});const old=repeated.pipeline.profiler;
  assert.equal(repeated.pass.profiler,old);assert.notEqual(repeated.pass.render,repeated.originalRender);
  repeated.pipeline.startProfiling({every:1});
  assert.equal(old.disposed,true);assert.notEqual(repeated.pipeline.profiler,old);
  assert.equal(repeated.pass.profiler,repeated.pipeline.profiler);
  repeated.pipeline.profiler.beginFrame();
  assert.equal(repeated.opaque.render(),'opaque-result');
  assert.equal(repeated.pipeline.profiler.records[0].scope,'gpu','Other composer parents retain GPU ownership');
  repeated.pipeline.stopProfiling();repeated.pipeline.stopProfiling();
  assert.equal(repeated.pass.profiler,null);assert.equal(repeated.pass.render,repeated.originalRender);
  assert.equal(repeated.opaque.render,repeated.opaqueRender);
  const queries=repeated.queryStarts;repeated.draw();assert.equal(repeated.queryStarts,queries);
  repeated.restored();cases++;
} finally {repeated.close();}
console.log(JSON.stringify({passed:true,cases,
  scope:'CPU doubles only: actual profiling hooks and volume render, original order with profiling off/on, inclusive parent and four disjoint GPU children, batch dispatch, every draw failure restoring state/history, restart/stop and detached profiler. No GPU/image/performance acceptance.'}));
