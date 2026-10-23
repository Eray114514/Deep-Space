// Execute the real pipeline constructor/render/lifecycle, frame transaction and
// pacer with a CPU renderer. Composer/shadow draws are doubles: these contracts
// check admission, ownership and rollback, not GPU latency or image parity.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import * as THREE from 'three';

const files=['src/legacy-render-pipeline.js','src/gpu-frame-pacer.js','src/render-frame-state.js','tools/renderframepacingtest.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(new URL(`../${path}`,import.meta.url))])));
const {GameLegacyPipeline}=await import('../src/legacy-render-pipeline.js');
const {GpuFramePacer}=await import('../src/gpu-frame-pacer.js');
const out=`test-results/render-frame-pacing/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],fixtures=[],scheduled=new Map();let timerId=0;
const original={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout,matchMedia:globalThis.matchMedia};
globalThis.setTimeout=(work,ms)=>{const id=++timerId;scheduled.set(id,{work,ms});return id;};
globalThis.clearTimeout=id=>scheduled.delete(id);
// The coarse-pointer constructor path omits SMAA's browser image loading.
globalThis.matchMedia=()=>({matches:true});
const tick=()=>{const batch=[...scheduled];scheduled.clear();for(const [,item] of batch){assert.equal(item.ms,50);item.work();}};
function thrown(work) {
  let caught=false,value;
  try {work();} catch(error){caught=true;value=error;}
  assert.equal(caught,true,'Expected an exception');return value;
}
function fixture({volume=true,tracking=true}={}) {
  let epoch=0,lost=false,nextId=0,target={name:'caller-target'},face=3,mip=2,composerHook=null,nullFence=false;
  const events=[],syncs=[],listeners=new Map(),beforeHooks=new Map(),afterHooks=new Map(),pacers=[];
  const counts={};
  const invoke=(name,work,args=[])=>{
    events.push(name);counts[name]=(counts[name]||0)+1;
    const before=beforeHooks.get(name);if(before){beforeHooks.delete(name);before(...args);}
    const value=work();const after=afterHooks.get(name);if(after){afterHooks.delete(name);after(value,...args);}return value;
  };
  const emit=name=>{for(const listener of [...(listeners.get(name)||[])])listener();};
  const valid=sync=>{assert.equal(lost,false);assert.ok(sync);assert.equal(sync.epoch,epoch);assert.equal(sync.deleted,false);};
  const forbidden=name=>()=>assert.fail(`${name} is outside a frame pacer's CPU contract`);
  const gl={SYNC_GPU_COMMANDS_COMPLETE:1,TIMEOUT_EXPIRED:2,ALREADY_SIGNALED:3,CONDITION_SATISFIED:4,WAIT_FAILED:5,
    isContextLost:()=>invoke('native.context',()=>lost),
    fenceSync:(condition,flags)=>invoke('native.fence',()=>{
      assert.equal(condition,1);assert.equal(flags,0);if(nullFence){nullFence=false;return null;}
      const sync={id:++nextId,epoch,status:2,deleted:false};syncs.push(sync);return sync;
    }),
    clientWaitSync:(sync,flags,timeout)=>{valid(sync);assert.equal(flags,0);assert.equal(timeout,0);
      return invoke('native.wait',()=>sync.status);},
    deleteSync:sync=>{valid(sync);return invoke('native.delete',()=>{if(!lost&&sync.epoch===epoch)sync.deleted=true;});},
    getExtension:forbidden('GPU extension lookup'),createQuery:forbidden('timer query'),
    flush:forbidden('flush'),finish:forbidden('finish'),waitSync:forbidden('server wait'),getError:forbidden('getError')};
  const renderer={getContext:()=>invoke('native.getContext',()=>gl),getPixelRatio:()=>1,info:{autoReset:true},
    domElement:{addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},
      removeEventListener(name,fn){listeners.get(name)?.delete(fn);}},
    getRenderTarget:()=>invoke('target.get',()=>target),getActiveCubeFace:()=>invoke('target.face',()=>face),
    getActiveMipmapLevel:()=>invoke('target.mip',()=>mip),
    render:(view,viewCamera)=>invoke('aux.draw',()=>{assert.equal(viewCamera,camera);events.push(`aux-view:${view.name}`);}),
    setRenderTarget(value,nextFace=0,nextMip=0){return invoke('target.set',()=>{target=value;face=nextFace;mip=nextMip;},[value,nextFace,nextMip]);}};
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(60,1.6,.1,1e9);
  const pipeline=new GameLegacyPipeline(renderer,scene,camera,{volume});
  const body={posUniv:new THREE.Vector3(1e12,-2e12,3e12),weatherField:{},
    volCloudMat:{uniforms:{uCameraLocal:{value:new THREE.Vector3()}}}};
  const nav=body.posUniv.clone().add(new THREE.Vector3(1,6000100,2));
  if(pipeline.volumePass){pipeline.volumePass.nav=nav;pipeline.volumePass.activePlanet=body;}
  pipeline.atmospherePass.activePlanet=body;
  pipeline.atmospherePass.material.uniforms.uCameraLocal={value:new THREE.Vector3()};
  for(const method of ['begin','localEye','commit','abort']) {
    const originalMethod=pipeline.frameState[method];
    pipeline.frameState[method]=function(...args){return invoke(`frame.${method}`,()=>originalMethod.apply(this,args),args);};
  }
  if(pipeline.volumePass) {
    const reset=pipeline.volumePass.resetHistory;
    pipeline.volumePass.resetHistory=function(...args){return invoke('volume.reset',()=>reset.apply(this,args),args);};
  }
  const lighting=pipeline.updateCloudLighting;
  pipeline.updateCloudLighting=function(...args){return invoke('cloud.update',()=>lighting.apply(this,args),args);};
  pipeline.cloudSurfaceShadow.render=(r,write)=>invoke('shadow.draw',()=>{assert.equal(r,renderer);renderer.setRenderTarget(write,1,0);});
  pipeline.composer.render=()=>invoke('composer.draw',()=>{
    renderer.setRenderTarget(null);if(composerHook)composerHook();
  });
  if(tracking) {
    pipeline.profiler={beginFrame:()=>invoke('profiler.begin',()=>{}),
      run:(name,work)=>invoke(`profiler.${name}`,work),dispose:()=>invoke('profiler.dispose',()=>{})};
    pipeline.columnWorkBudget={beginFrame:()=>invoke('budget.begin',()=>{}),dispose:()=>invoke('budget.dispose',()=>{})};
  }
  const initial={target,face,mip},f={pipeline,renderer,gl,scene,camera,body,nav,counts,events,syncs,pacers,initial,
    count:name=>counts[name]||0,
    before(name,work){assert.equal(beforeHooks.has(name),false);beforeHooks.set(name,work);},
    after(name,work){assert.equal(afterHooks.has(name),false);afterHooks.set(name,work);},
    get listenerCount(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);},
    set composerHook(value){composerHook=value;},
    nullNextFence(){nullFence=true;},
    complete(status=4){for(const sync of syncs)if(sync.epoch===epoch&&!sync.deleted)sync.status=status;},
    lose(){lost=true;epoch++;emit('webglcontextlost');},restore(){lost=false;emit('webglcontextrestored');},
    start(){const pacer=pipeline.startFramePacing();pacers.push(pacer);
      for(const name of ['beginFrame','endFrame','dispose']) {
        const method=pacer[name];pacer[name]=function(...args){return invoke(`pacer.${name}`,()=>method.apply(this,args),args);};
      }return pacer;},
    restored(){assert.equal(target,initial.target);assert.equal(face,initial.face);assert.equal(mip,initial.mip);},
    workState(){
      const frame=pipeline.frameState,v=pipeline.volumePass;
      return {counts:Object.fromEntries(Object.entries(counts).filter(([name])=>!name.startsWith('native.')&&!name.startsWith('pacer.'))),
        target,face,mip,cloudLightFrame:pipeline.cloudLightFrame,frame:{sequence:frame.sequence,epoch:frame.epoch,pending:frame.pending,
          valid:frame.valid,reason:frame.reason,currentOrigin:frame.current.origin.toArray(),previousOrigin:frame.previous.origin.toArray(),
          previousProjection:frame.previous.projection.toArray(),previousCamera:frame.previous.cameraWorld.toArray()},
        volume:v?{frame:v.frame,valid:v.historyValid,read:v.historyRead,write:v.historyWrite}:null,
        cloudEye:body.volCloudMat.uniforms.uCameraLocal.value.toArray(),
        airEye:pipeline.atmospherePass.material.uniforms.uCameraLocal.value.toArray()};
    },
    cleanup(){beforeHooks.clear();afterHooks.clear();composerHook=null;
      f.lose();for(const pacer of pacers){if(pacer.snapshot().active)pacer.endFrame();pacer.dispose();}
      pipeline.dispose();}};
  fixtures.push(f);return f;
}
function test(name,work) {
  const begin=fixtures.length;
  try {work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),actual:error?.actual,expected:error?.expected,stack:error?.stack});}
  finally {for(const f of fixtures.slice(begin)){try {f.cleanup();} catch {}}scheduled.clear();}
}
function graphState(f) {
  const {frame,volume,cloudEye,airEye,cloudLightFrame}=f.workState();
  return {frame,volume,cloudEye,airEye,cloudLightFrame};
}
try {
  test('the actual constructor leaves pacing disabled and ordinary renders return true without native fences',()=>{
    const f=fixture(),p=f.pipeline;assert.equal(p.framePacer,null);assert.equal(f.count('native.getContext'),0);
    assert.equal(p.render(),true);assert.equal(p.render(),true);assert.equal(p.frameState.sequence,2);f.restored();
    assert.equal(f.count('native.fence'),0);assert.equal(f.count('native.wait'),0);assert.equal(f.count('budget.begin'),2);
  });
  test('pacing starts independently of existing profiling and column-work owners',()=>{
    const f=fixture(),p=f.pipeline,profiler=p.profiler,budget=p.columnWorkBudget,pacer=f.start();
    assert.ok(pacer instanceof GpuFramePacer);assert.equal(p.framePacer,pacer);
    assert.equal(p.profiler,profiler);assert.equal(p.columnWorkBudget,budget);assert.throws(()=>p.startFramePacing(),/already enabled/);
    assert.equal(f.count('native.getContext'),1);p.stopFramePacing();assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().released,true);
    assert.equal(p.profiler,profiler);assert.equal(p.columnWorkBudget,budget);
  });
  test('an admitted frame preserves transaction and phase order before inserting its completion fence',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();f.events.length=0;assert.equal(p.render(),true);f.restored();
    const order=f.events.filter(name=>!name.startsWith('native.')&&!name.startsWith('target.')&&!name.startsWith('frame.localEye'));
    assert.deepEqual(order,['pacer.beginFrame','frame.begin','profiler.begin','budget.begin','profiler.cloud-cache',
      'cloud.update','shadow.draw','composer.draw','frame.commit','pacer.endFrame']);
    assert.ok(f.events.indexOf('native.fence')>f.events.indexOf('frame.commit'));
    assert.equal(p.frameState.sequence,1);assert.equal(pacer.snapshot().pending,1);assert.equal(f.count('native.fence'),1);
  });
  test('a busy skip changes no render target, history, uniforms, budget, profiler or phase count',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();p.render();const state=f.workState(),ends=f.count('pacer.endFrame');
    f.camera.position.set(23,45,67);f.nav.x+=800;
    for(let i=0;i<8;i++)assert.equal(p.render({timeEpoch:99}),false);
    assert.deepEqual(f.workState(),state);assert.equal(f.count('pacer.endFrame'),ends);assert.equal(f.count('native.fence'),1);
    assert.equal(pacer.snapshot().stats.skipped,8);assert.equal(pacer.snapshot().stats.begun,1);
  });
  test('completion permits the next real frame and retains the previous committed correspondence across skips',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();p.render();const old=p.frameState.previous.origin.clone();
    f.nav.x+=50;assert.equal(p.render(),false);assert.ok(p.frameState.previous.origin.equals(old));f.complete();
    assert.equal(p.render(),true);f.restored();assert.equal(p.frameState.sequence,2);assert.equal(f.count('budget.begin'),2);
    assert.equal(pacer.snapshot().stats.completed,1);assert.equal(pacer.snapshot().stats.submitted,2);
  });
  test('pacer readiness polling never commits a pipeline frame or invokes its budget',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();assert.equal(pacer.poll(),true);const before=f.workState();
    assert.equal(pacer.poll(),true);assert.deepEqual(f.workState(),before);p.render();f.complete();
    const rendered=f.workState();assert.equal(pacer.poll(),true);assert.deepEqual(f.workState(),rendered);
    assert.equal(p.frameState.sequence,1);assert.equal(f.count('composer.draw'),1);
  });
  test('composer failures restore the caller target, abort history and still fence submitted work',()=>{
    for(const error of [new Error('composer'),null,undefined,false,0]) {
      const f=fixture(),p=f.pipeline,pacer=f.start();p.render();f.complete();const previous=p.frameState.previous.origin.clone();
      f.nav.z+=20;f.composerHook=()=>{throw error;};assert.equal(thrown(()=>p.render()),error);f.restored();
      assert.equal(p.frameState.sequence,1);assert.equal(p.frameState.pending,false);assert.equal(p.frameState.valid,false);
      assert.ok(p.frameState.previous.origin.equals(previous));assert.equal(f.count('frame.abort'),1);assert.equal(f.count('volume.reset'),1);
      assert.equal(f.count('pacer.endFrame'),2);assert.equal(pacer.snapshot().pending,1);assert.equal(pacer.snapshot().active,false);
    }
  });
  test('a pacer end exception cannot replace any original render exception including falsy values',()=>{
    for(const error of [new Error('render'),null,undefined,false,0]) {
      const f=fixture(),p=f.pipeline,pacer=f.start(),endError=new Error('native finalization');
      f.composerHook=()=>{throw error;};f.before('native.fence',()=>{throw endError;});
      assert.equal(thrown(()=>p.render()),error);f.restored();assert.equal(p.frameState.sequence,0);
      assert.equal(f.count('frame.abort'),1);assert.equal(f.count('volume.reset'),1);
      assert.equal(pacer.snapshot().fault,'frame-finalize-failed');assert.equal(pacer.snapshot().pending,1);
      const before=f.workState();assert.equal(p.render(),false);assert.deepEqual(f.workState(),before);
    }
  });
  test('an otherwise successful render exposes its native end exception and keeps the uncertain lease',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('native fence');f.before('native.fence',()=>{throw error;});
    assert.equal(thrown(()=>p.render()),error);f.restored();assert.equal(p.frameState.sequence,1);
    assert.equal(pacer.snapshot().pending,1);assert.equal(pacer.snapshot().fault,'frame-finalize-failed');
    assert.equal(f.count('frame.abort'),0);assert.equal(f.count('volume.reset'),0);
  });
  test('a null completion fence counts the actual rendered frame but isolates all later admissions',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();f.nullNextFence();assert.equal(p.render(),true);
    assert.equal(pacer.snapshot().fault,'fence-create-failed');assert.equal(pacer.snapshot().pending,1);
    const before=f.workState();assert.equal(p.render(),false);assert.deepEqual(f.workState(),before);f.restored();
  });
  test('errors before transaction setup still end the admitted foreground ownership exactly once',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('target getter');f.before('target.get',()=>{throw error;});
    assert.equal(thrown(()=>p.render()),error);assert.equal(f.count('frame.begin'),0);assert.equal(f.count('pacer.endFrame'),1);
    assert.equal(pacer.snapshot().pending,1);assert.equal(f.count('budget.begin'),0);assert.equal(f.count('target.set'),0);
  });
  test('a begin exception happens before target reads and does not call end without admission',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('native begin');const before=f.workState();
    f.before('native.context',()=>{throw error;});assert.equal(thrown(()=>p.render()),error);
    assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.endFrame'),0);assert.equal(pacer.snapshot().active,false);
    assert.equal(pacer.snapshot().stats.begun,0);assert.equal(pacer.snapshot().fault,'context-state-failed');
  });
  test('a shadow-stage failure preserves rollback and never reaches composer or commit',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('shadow');f.after('shadow.draw',()=>{throw error;});
    assert.equal(thrown(()=>p.render()),error);f.restored();assert.equal(f.count('composer.draw'),0);
    assert.equal(f.count('frame.commit'),0);assert.equal(f.count('frame.abort'),1);assert.equal(f.count('volume.reset'),1);
    assert.equal(pacer.snapshot().pending,1);assert.equal(f.count('pacer.endFrame'),1);
  });
  test('synchronous stop during a successful draw fences the captured retiring owner',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();f.composerHook=()=>{
      p.stopFramePacing();assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().released,false);assert.equal(pacer.snapshot().active,true);
      assert.throws(()=>p.startFramePacing(),/already has/);
    };assert.equal(p.render(),true);f.restored();assert.equal(pacer.snapshot().pending,1);assert.equal(pacer.snapshot().disposed,true);
    assert.equal(f.count('pacer.endFrame'),1);assert.equal(scheduled.size,1);f.complete();tick();assert.equal(pacer.snapshot().released,true);
    f.composerHook=null;const next=f.start();assert.notEqual(next,pacer);assert.equal(p.render(),true);
  });
  test('synchronous stop and render failure preserve the original exception and captured owner',()=>{
    for(const error of [null,undefined,false,new Error('stopped render')]) {
      const f=fixture(),p=f.pipeline,pacer=f.start();f.composerHook=()=>{p.stopFramePacing();throw error;};
      assert.equal(thrown(()=>p.render()),error);f.restored();assert.equal(p.framePacer,null);assert.equal(f.count('pacer.endFrame'),1);
      assert.equal(pacer.snapshot().pending,1);assert.equal(pacer.snapshot().disposed,true);assert.equal(p.frameState.valid,false);
    }
  });
  test('synchronous pipeline disposal still finalizes the captured active owner',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();f.composerHook=()=>{
      p.dispose();assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().active,true);assert.equal(pacer.snapshot().released,false);
    };assert.equal(p.render(),true);f.restored();assert.equal(f.count('pacer.endFrame'),1);assert.equal(pacer.snapshot().pending,1);
    assert.equal(pacer.snapshot().disposed,true);f.complete();tick();assert.equal(pacer.snapshot().released,true);
  });
  test('pipeline disposal retires pacing before a later teardown method can fail',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('later teardown');p.render();
    const stop=p.stopProfiling;p.stopProfiling=()=>{throw error;};assert.equal(thrown(()=>p.dispose()),error);p.stopProfiling=stop;
    assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().disposed,true);assert.equal(pacer.snapshot().pending,1);
    assert.equal(pacer.snapshot().released,false);f.complete();tick();assert.equal(pacer.snapshot().released,true);
  });
  test('a stopped pending owner keeps the renderer lease until asynchronous retirement finishes',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();p.render();p.stopFramePacing();const waits=f.count('native.wait');
    assert.equal(p.framePacer,null);assert.equal(f.count('native.wait'),waits);assert.throws(()=>p.startFramePacing(),/already has/);
    tick();assert.equal(pacer.snapshot().released,false);f.complete();tick();assert.equal(pacer.snapshot().released,true);
    const next=f.start();assert.notEqual(next,pacer);assert.equal(p.render(),true);assert.equal(f.count('budget.begin'),2);
  });
  test('stop without pacing is harmless and no-volume pipelines retain the same admission contract',()=>{
    const f=fixture({volume:false,tracking:false}),p=f.pipeline;p.stopFramePacing();assert.equal(p.render(),true);
    const pacer=f.start();assert.equal(p.render(),true);const before=f.workState();assert.equal(p.render(),false);
    assert.deepEqual(f.workState(),before);f.complete();assert.equal(p.render(),true);assert.equal(pacer.snapshot().stats.completed,1);f.restored();
  });
  test('explicit render correspondence options are committed only on an actual admitted frame',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),origin=new THREE.Vector3(8,9,10),context={private:true};
    assert.equal(p.render({origin,context,timeEpoch:7}),true);assert.ok(p.frameState.previous.origin.equals(origin));
    assert.equal(p.frameState.previous.context,context);assert.equal(p.frameState.previous.timeEpoch,7);
    const before=f.workState();assert.equal(p.render({origin:new THREE.Vector3(1,2,3),context:{},timeEpoch:8}),false);
    assert.deepEqual(f.workState(),before);assert.equal(pacer.snapshot().stats.begun,1);
  });
  test('lost or faulted owners reject before any pipeline mutation',()=>{
    for(const mode of ['lost','fault']) {
      const f=fixture(),p=f.pipeline,pacer=f.start();p.render();
      if(mode==='lost')f.lose();else {f.complete(f.gl.WAIT_FAILED);pacer.poll();}
      const before=f.workState(),ends=f.count('pacer.endFrame');assert.equal(p.render(),false);
      assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.endFrame'),ends);assert.equal(f.count('native.fence'),1);
    }
  });
  test('a context cycle during a throwing draw never fences its old frame in the restored context',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('old context render');
    f.composerHook=()=>{f.lose();f.restore();throw error;};assert.equal(thrown(()=>p.render()),error);f.restored();
    assert.equal(f.count('pacer.endFrame'),1);assert.equal(f.count('native.fence'),0);assert.equal(pacer.snapshot().pending,0);
    assert.equal(pacer.snapshot().stats.abandoned,1);assert.equal(pacer.snapshot().active,false);assert.equal(p.frameState.valid,false);
    f.composerHook=null;assert.equal(p.render(),true);assert.equal(f.count('native.fence'),1);
  });
  test('default render failures keep their rollback behavior with pacing disabled',()=>{
    const f=fixture(),p=f.pipeline,error=null;f.composerHook=()=>{throw error;};
    assert.equal(thrown(()=>p.render()),error);f.restored();assert.equal(p.frameState.pending,false);assert.equal(p.frameState.sequence,0);
    assert.equal(f.count('frame.abort'),1);assert.equal(f.count('volume.reset'),1);assert.equal(f.count('native.fence'),0);
  });
  // Keep the original 23 contracts above. The synchronous submission capability
  // adds auxiliary views around the same actual graph; it is not a copied graph.
  test('the public render entry delegates its exact options through submitFrame once',()=>{
    const f=fixture(),p=f.pipeline,options={origin:f.nav,context:{explicit:true},timeEpoch:4},originalSubmit=p.submitFrame;
    let called=0,drawn=0;
    p.submitFrame=work=>{called++;work(value=>{assert.equal(value,options);drawn++;return true;});return 'delegated';};
    assert.equal(p.render(options),'delegated');assert.equal(called,1);assert.equal(drawn,1);assert.equal(f.count('frame.begin'),0);
    p.submitFrame=originalSubmit;
  });
  test('one admission covers auxiliary views before and after one actual production graph',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),aux={name:'aux-target'};f.events.length=0;
    assert.equal(p.submitFrame(draw=>{
      f.renderer.setRenderTarget(aux,5,6);f.renderer.render({name:'before'},f.camera);
      assert.equal(draw(),true);assert.equal(f.renderer.getRenderTarget(),aux);
      assert.equal(f.renderer.getActiveCubeFace(),5);assert.equal(f.renderer.getActiveMipmapLevel(),6);
      f.renderer.render({name:'after'},f.camera);
    }),true);f.restored();
    const order=f.events.filter(name=>name.startsWith('aux-view:')||['pacer.beginFrame','frame.begin','frame.commit','pacer.endFrame','native.fence'].includes(name));
    assert.deepEqual(order,['pacer.beginFrame','aux-view:before','frame.begin','frame.commit','aux-view:after','pacer.endFrame','native.fence']);
    assert.equal(f.count('aux.draw'),2);assert.equal(f.count('budget.begin'),1);assert.equal(f.count('profiler.begin'),1);
    assert.equal(f.count('composer.draw'),1);assert.equal(pacer.snapshot().stats.submitted,1);assert.equal(pacer.snapshot().pending,1);
  });
  test('a busy submission does not even enter auxiliary work or consume its draw capability',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();p.render();const before=f.workState();let called=0;
    assert.equal(p.submitFrame(draw=>{called++;f.renderer.render({name:'forbidden'},f.camera);draw();}),false);
    assert.equal(called,0);assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.endFrame'),1);
    assert.equal(pacer.snapshot().stats.submitted,1);assert.equal(pacer.snapshot().stats.skipped,1);
  });
  test('auxiliary-only work is fenced while leaving previous history, budget and profiler untouched',()=>{
    const f=fixture(),p=f.pipeline;p.render();const before=graphState(f),budget=f.count('budget.begin'),profile=f.count('profiler.begin'),pacer=f.start();
    assert.equal(p.submitFrame(()=>{f.renderer.setRenderTarget({name:'startup-view'},7,4);f.renderer.render({name:'startup'},f.camera);}),true);
    f.restored();assert.deepEqual(graphState(f),before);assert.equal(f.count('budget.begin'),budget);assert.equal(f.count('profiler.begin'),profile);
    assert.equal(f.count('composer.draw'),1);assert.equal(f.count('frame.abort'),0);assert.equal(f.count('volume.reset'),0);
    assert.equal(pacer.snapshot().stats.begun,1);assert.equal(pacer.snapshot().stats.submitted,1);assert.equal(f.count('native.fence'),1);
  });
  test('default auxiliary-only scopes also restore the caller tuple without allocating a native pacer',()=>{
    const f=fixture(),p=f.pipeline,before=graphState(f);assert.equal(p.submitFrame(()=>{
      f.renderer.setRenderTarget({name:'default-aux'},6,9);f.renderer.render({name:'default'},f.camera);
    }),true);f.restored();assert.deepEqual(graphState(f),before);assert.equal(f.count('frame.begin'),0);
    assert.equal(f.count('budget.begin'),0);assert.equal(f.count('profiler.begin'),0);assert.equal(f.count('native.fence'),0);
    assert.equal(f.count('native.getContext'),0);assert.equal(p.framePacer,null);
  });
  test('auxiliary-only failures preserve already committed player history and still close one fence',()=>{
    for(const error of [new Error('auxiliary'),null,undefined,false,0]) {
      const f=fixture(),p=f.pipeline;p.render();const before=graphState(f),pacer=f.start();
      assert.equal(thrown(()=>p.submitFrame(()=>{
        f.renderer.setRenderTarget({name:'failed-aux'},4,8);f.renderer.render({name:'failing'},f.camera);throw error;
      })),error);f.restored();assert.deepEqual(graphState(f),before);assert.equal(f.count('frame.abort'),0);
      assert.equal(f.count('volume.reset'),0);assert.equal(f.count('pacer.endFrame'),1);assert.equal(pacer.snapshot().pending,1);
    }
  });
  test('an auxiliary exception after graph success preserves that completed graph correspondence',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('post graph auxiliary');
    assert.equal(thrown(()=>p.submitFrame(draw=>{assert.equal(draw(),true);throw error;})),error);f.restored();
    assert.equal(p.frameState.sequence,1);assert.equal(p.frameState.valid,true);assert.equal(p.frameState.pending,false);
    assert.equal(f.count('frame.abort'),0);assert.equal(f.count('volume.reset'),0);assert.equal(pacer.snapshot().pending,1);
  });
  test('work exceptions including falsy values outrank outer target restoration and end failures',()=>{
    for(const error of [new Error('work'),null,undefined,false,0]) {
      const f=fixture(),p=f.pipeline,pacer=f.start(),restoreError=new Error('outer restore'),endError=new Error('scope end'),before=graphState(f);
      f.before('native.fence',()=>{throw endError;});assert.equal(thrown(()=>p.submitFrame(()=>{
        f.renderer.setRenderTarget({name:'aux-target'},4,2);f.after('target.set',()=>{throw restoreError;});throw error;
      })),error);f.restored();assert.deepEqual(graphState(f),before);assert.equal(f.count('pacer.endFrame'),1);
      assert.equal(pacer.snapshot().fault,'frame-finalize-failed');assert.equal(pacer.snapshot().pending,1);
    }
  });
  test('an isolated outer target restoration exception surfaces and still fences admitted work',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('restore only'),before=graphState(f);
    assert.equal(thrown(()=>p.submitFrame(()=>{
      f.renderer.setRenderTarget({name:'aux-target'},4,2);f.after('target.set',()=>{throw error;});
    })),error);f.restored();assert.deepEqual(graphState(f),before);assert.equal(pacer.snapshot().pending,1);
    assert.equal(f.count('pacer.endFrame'),1);assert.equal(f.count('frame.abort'),0);
  });
  test('graph failures outrank the inner target restoration exception and final fence exception',()=>{
    for(const error of [new Error('graph'),null,undefined,false,0]) {
      const f=fixture(),p=f.pipeline,pacer=f.start(),restoreError=new Error('graph target restore'),endError=new Error('graph end');
      f.before('native.fence',()=>{throw endError;});f.composerHook=()=>{f.after('target.set',()=>{throw restoreError;});throw error;};
      assert.equal(thrown(()=>p.submitFrame(draw=>draw())),error);f.restored();assert.equal(f.count('frame.abort'),1);
      assert.equal(f.count('volume.reset'),1);assert.equal(p.frameState.sequence,0);assert.equal(p.frameState.pending,false);
      assert.equal(pacer.snapshot().fault,'frame-finalize-failed');assert.equal(pacer.snapshot().pending,1);
    }
  });
  test('invalid work is rejected before native admission, target reads, or history changes',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),before=f.workState(),begins=f.count('pacer.beginFrame');
    for(const value of [undefined,null,false,0,[],{},'work'])assert.throws(()=>p.submitFrame(value),TypeError);
    assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.beginFrame'),begins);assert.equal(f.count('pacer.endFrame'),0);
    assert.equal(pacer.snapshot().stats.begun,0);
  });
  test('thenable work results are rejected synchronously without invoking their asynchronous continuation',()=>{
    for(const pacing of [false,true]) {
      const f=fixture(),p=f.pipeline,pacer=pacing?f.start():null,before=graphState(f);let thenCalls=0;
      assert.throws(()=>p.submitFrame(()=>{f.renderer.setRenderTarget({name:'thenable'},3,5);return {then(){thenCalls++;}};}),TypeError);
      assert.equal(thenCalls,0);f.restored();assert.deepEqual(graphState(f),before);assert.equal(f.count('frame.begin'),0);
      assert.equal(f.count('native.fence'),Number(pacing));if(pacer)assert.equal(pacer.snapshot().pending,1);
    }
  });
  test('a throwing then getter is treated as the original work error without publishing history',()=>{
    for(const error of [null,undefined,false,new Error('then getter')]) {
      const f=fixture(),p=f.pipeline,pacer=f.start(),before=graphState(f);
      assert.equal(thrown(()=>p.submitFrame(()=>({get then(){throw error;}}))),error);f.restored();
      assert.deepEqual(graphState(f),before);assert.equal(pacer.snapshot().pending,1);assert.equal(f.count('frame.abort'),0);
    }
  });
  test('nested submissions and reentrant render throw before a second admission in both default and paced scopes',()=>{
    for(const pacing of [false,true]) {
      const f=fixture(),p=f.pipeline,pacer=pacing?f.start():null;let nestedWork=0;
      assert.equal(p.submitFrame(draw=>{
        const begins=f.count('pacer.beginFrame'),gets=f.count('target.get');
        assert.throws(()=>p.submitFrame(()=>nestedWork++),/already active/);assert.throws(()=>p.render(),/already active/);
        assert.equal(f.count('pacer.beginFrame'),begins);assert.equal(f.count('target.get'),gets);assert.equal(draw(),true);
      }),true);assert.equal(nestedWork,0);assert.equal(f.count('composer.draw'),1);f.restored();
      assert.equal(f.count('native.fence'),Number(pacing));if(pacer)assert.equal(pacer.snapshot().stats.skipped,0);
    }
  });
  test('stopping the pacer inside work does not bypass the submission reentry guard',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();assert.equal(p.submitFrame(draw=>{
      p.stopFramePacing();assert.equal(p.framePacer,null);assert.throws(()=>p.render(),/already active/);assert.equal(draw(),true);
    }),true);assert.equal(f.count('composer.draw'),1);assert.equal(f.count('pacer.endFrame'),1);
    assert.equal(pacer.snapshot().disposed,true);assert.equal(pacer.snapshot().pending,1);f.restored();
  });
  test('draw is a one-use capability and a second call cannot enter the graph',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();assert.equal(p.submitFrame(draw=>{
      assert.equal(draw(),true);const before=f.workState();assert.throws(()=>draw(),/already been drawn/);assert.deepEqual(f.workState(),before);
    }),true);assert.equal(f.count('frame.begin'),1);assert.equal(f.count('frame.commit'),1);
    assert.equal(f.count('budget.begin'),1);assert.equal(pacer.snapshot().stats.submitted,1);f.restored();
  });
  test('a graph failure consumes draw even when work catches that failure and tries again',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),error=new Error('caught graph failure');f.composerHook=()=>{throw error;};
    assert.equal(p.submitFrame(draw=>{
      assert.equal(thrown(()=>draw()),error);const begins=f.count('frame.begin');assert.throws(()=>draw(),/already been drawn/);
      assert.equal(f.count('frame.begin'),begins);
    }),true);assert.equal(f.count('frame.begin'),1);assert.equal(f.count('frame.abort'),1);
    assert.equal(p.frameState.sequence,0);assert.equal(pacer.snapshot().pending,1);f.restored();
  });
  test('a draw escaping a completed scope cannot mutate history, targets, budgets, or admission',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();let escaped;
    assert.equal(p.submitFrame(draw=>{escaped=draw;}),true);const before=f.workState();assert.throws(()=>escaped(),/no longer active/);
    assert.deepEqual(f.workState(),before);assert.equal(f.count('frame.begin'),0);assert.equal(f.count('native.fence'),1);
    assert.equal(pacer.snapshot().pending,1);f.restored();
  });
  test('a capability from an older scope stays expired while a new scope is active',()=>{
    for(const pacing of [false,true]) {
      const f=fixture(),p=f.pipeline,pacer=pacing?f.start():null;let old;
      p.submitFrame(draw=>{old=draw;});if(pacer){f.complete();assert.equal(pacer.poll(),true);}
      assert.equal(p.submitFrame(draw=>{assert.throws(()=>old(),/no longer active/);assert.equal(draw(),true);}),true);
      assert.equal(f.count('frame.begin'),1);assert.equal(f.count('frame.commit'),1);assert.equal(f.count('native.fence'),pacing?2:0);f.restored();
    }
  });
  test('draw is already expired during outer target cleanup and native completion-fence callbacks',()=>{
    const f=fixture(),p=f.pipeline;f.start();let escaped,restoreObserved=0,fenceObserved=0;
    f.after('native.fence',()=>{assert.throws(()=>escaped(),/no longer active/);fenceObserved++;});
    assert.equal(p.submitFrame(draw=>{escaped=draw;f.after('target.set',()=>{assert.throws(()=>escaped(),/no longer active/);restoreObserved++;});}),true);
    assert.equal(restoreObserved,1);assert.equal(fenceObserved,1);assert.equal(f.count('frame.begin'),0);f.restored();
  });
  test('a captured end callback after synchronous stop cannot reenter an unpaced production graph',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();let callback=0;
    f.after('native.fence',()=>{
      const before=f.workState();assert.equal(p.framePacer,null);assert.throws(()=>p.render(),/already active/);
      assert.throws(()=>p.submitFrame(()=>assert.fail('nested work ran')),/already active/);assert.deepEqual(f.workState(),before);callback++;
    });
    assert.equal(p.submitFrame(()=>p.stopFramePacing()),true);assert.equal(callback,1);f.restored();
    assert.equal(f.count('frame.begin'),0);assert.equal(f.count('native.fence'),1);assert.equal(pacer.snapshot().pending,1);
    f.complete();tick();assert.equal(pacer.snapshot().released,true);assert.equal(p.render(),true);assert.equal(f.count('frame.begin'),1);
  });
  test('stopping the owner during pending-fence admission cannot reenter an unpaced production graph',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();p.render();const before=f.workState(),ends=f.count('pacer.endFrame');
    let callbacks=0,nestedResult,nestedError,outerWork=0;
    f.before('native.wait',()=>{
      callbacks++;p.stopFramePacing();
      try {nestedResult=p.render();} catch(error){nestedError=error;}
    });
    assert.equal(p.submitFrame(()=>outerWork++),false);assert.equal(callbacks,1);assert.equal(outerWork,0);
    assert.match(nestedError?.message||'',/already active/,
      `An incomplete old fence must not allow a stopped-owner nested draw: ${JSON.stringify({nestedResult,
        extraDraws:f.count('composer.draw')-(before.counts['composer.draw']||0),oldOwner:pacer.snapshot()})}`);
    assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.endFrame'),ends);assert.equal(p.frameSubmissionActive,false);
    assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().disposed,true);assert.equal(pacer.snapshot().pending,1);
    assert.equal(pacer.snapshot().stats.completed,0);assert.equal(pacer.snapshot().released,false);f.restored();
    f.complete();tick();assert.equal(pacer.snapshot().released,true);f.start();assert.equal(p.render(),true);
    assert.equal(f.count('frame.begin'),2);
  });
  test('stopping the owner during initial context admission cannot reenter an unpaced production graph',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),before=f.workState();
    let callbacks=0,nestedResult,nestedError,outerWork=0;
    f.before('native.context',()=>{
      callbacks++;p.stopFramePacing();
      try {nestedResult=p.render();} catch(error){nestedError=error;}
    });
    assert.equal(p.submitFrame(()=>outerWork++),false);assert.equal(callbacks,1);assert.equal(outerWork,0);
    assert.match(nestedError?.message||'',/already active/,
      `Admission must own the scope before native callbacks can detach pacing: ${JSON.stringify({nestedResult,
        extraDraws:f.count('composer.draw')-(before.counts['composer.draw']||0),oldOwner:pacer.snapshot()})}`);
    assert.deepEqual(f.workState(),before);assert.equal(f.count('pacer.endFrame'),0);assert.equal(p.frameSubmissionActive,false);
    assert.equal(p.framePacer,null);assert.equal(pacer.snapshot().stats.begun,0);assert.equal(pacer.snapshot().released,true);
    assert.equal(f.count('native.fence'),0);f.restored();f.start();assert.equal(p.render(),true);assert.equal(f.count('frame.begin'),1);
  });
  test('auxiliary-only stop still creates exactly one captured-owner fence before asynchronous retirement',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start(),before=graphState(f);assert.equal(p.submitFrame(()=>{
      f.renderer.render({name:'retiring-aux'},f.camera);p.stopFramePacing();assert.equal(pacer.snapshot().active,true);
    }),true);f.restored();assert.deepEqual(graphState(f),before);assert.equal(p.framePacer,null);
    assert.equal(f.count('pacer.endFrame'),1);assert.equal(pacer.snapshot().pending,1);assert.equal(pacer.snapshot().released,false);
    f.complete();tick();assert.equal(pacer.snapshot().released,true);
  });
  test('auxiliary-only pipeline disposal keeps the captured active owner until its final fence',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();assert.equal(p.submitFrame(()=>{
      f.renderer.render({name:'disposed-aux'},f.camera);p.dispose();assert.equal(pacer.snapshot().active,true);assert.equal(pacer.snapshot().released,false);
    }),true);f.restored();assert.equal(f.count('frame.begin'),0);assert.equal(f.count('pacer.endFrame'),1);
    assert.equal(pacer.snapshot().disposed,true);assert.equal(pacer.snapshot().pending,1);f.complete();tick();assert.equal(pacer.snapshot().released,true);
  });
  test('an auxiliary context cycle abandons the old scope without publishing a world frame or fencing its new context',()=>{
    const f=fixture(),p=f.pipeline,pacer=f.start();assert.equal(p.submitFrame(()=>{f.renderer.render({name:'old-epoch'},f.camera);f.lose();f.restore();}),true);
    f.restored();assert.equal(f.count('frame.begin'),0);assert.equal(f.count('frame.commit'),0);assert.equal(f.count('native.fence'),0);
    assert.equal(pacer.snapshot().stats.abandoned,1);assert.equal(pacer.snapshot().active,false);assert.equal(pacer.snapshot().pending,0);
  });
} finally {
  globalThis.setTimeout=original.setTimeout;globalThis.clearTimeout=original.clearTimeout;
  if(original.matchMedia===undefined)delete globalThis.matchMedia;else globalThis.matchMedia=original.matchMedia;
}
const sources=[];
for(const [path,bytes] of frozen) {
  const after=await readFile(new URL(`../${path}`,import.meta.url));sources.push({path,bytes:bytes.length,sha256:sha256(bytes),
    afterSha256:sha256(after),stable:sha256(bytes)===sha256(after)});
}
const report={kind:'cpu-contracts',scope:'actual pipeline/frame-state/pacer with CPU render doubles; original 23 contracts plus synchronous auxiliary/graph capability ownership; no GPU timing or image claim',
  threeRevision:THREE.REVISION,passed:cases.filter(item=>item.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);console.log(JSON.stringify({out,...report},null,2));
assert.equal(sources.every(item=>item.stable),true,'Frame-pacing source changed during its contract run');
assert.equal(report.passed,report.total,'Pipeline frame-pacing contracts failed');
