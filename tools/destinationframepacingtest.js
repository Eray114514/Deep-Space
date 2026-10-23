// Actual main.js destination functions, extracted like preparationscopetest.
// CPU state/pacing doubles only: no WebGL work or performance acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as THREE from 'three';

const mainBytes=await readFile('src/main.js'),main=mainBytes.toString();
const verifierBytes=await readFile(new URL(import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const out=`test-results/destination-frame-pacing/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
await writeFile(`${out}/main.js`,mainBytes);await writeFile(`${out}/verifier.js`,verifierBytes);
const functions={};
function load(name,context){
  const signature=`async function ${name}(`,start=main.indexOf(signature),end=main.indexOf('\n}',start);
  assert.equal(main.split(signature).length-1,1,`Unique actual ${name}`);assert.ok(start>=0&&end>start,name);
  const source=main.slice(start,end+2);functions[name]={sha256:sha(source),bytes:Buffer.byteLength(source)};
  return vm.runInNewContext(`(${source})`,context);
}
const results=[];
async function test(name,work){try{await work();results.push({name,passed:true});}
  catch(error){results.push({name,passed:false,error:String(error),stack:error.stack});}}
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};

function fixture({pacer=true,mrt=true,volume=true,fault=null,renderResult=true}={}){
  let allowed=!pacer,active=true,target={name:'player-target'},currentMrt={name:'player-mrt'},faultUsed=false;
  let volumePlanet={name:'live-volume',syncAtmoMaterial(){},syncVolCloudMaterial(){}},atmospherePlanet={name:'live-atmosphere'};
  const events=[],touches=[],rafs=[],cells=[],errors=[];
  const borrow=name=>{touches.push(name);assert.ok(allowed,`Borrowed ${name} before a healthy current pacing owner was ready`);};
  const fail=name=>{if(fault===name&&!faultUsed){faultUsed=true;throw Error(`expected ${name}`);}};
  const visible=(name,value)=>{
    const cell={name,raw:value};cells.push(cell);
    return Object.defineProperty({},'visible',{enumerable:true,get(){borrow(`${name}.visible.read`);return cell.raw;},
      set(next){borrow(`${name}.visible.write`);cell.raw=next;}});
  };
  const oldStar={group:visible('old-star',true),light:visible('old-light',false)};
  const fadeStar={group:visible('fade-star',false),light:visible('fade-light',true)};
  const destinationStar={group:visible('destination-star',false),light:visible('destination-light',false)};
  const targetBody={group:visible('destination-body',false),posUniv:new THREE.Vector3(),
    syncAtmoMaterial(){events.push('target-atmosphere');fail('target-atmosphere');},
    syncVolCloudMaterial(){events.push('target-volume');fail('target-volume');},update(){}};
  const otherBody={group:visible('destination-other',true)};
  const oldBody={group:visible('old-body',true)},fadeBody={group:visible('fade-body',false)};
  const riftGroup=visible('rift',true);
  const prepared={starViews:[destinationStar],planets:[targetBody,otherBody],compactObjects:[],updateCelestial(){}};
  const universeBase={system:{starViews:[oldStar],planets:[oldBody],compactObjects:[]},
    fadingSystem:{starViews:[fadeStar],planets:[fadeBody],compactObjects:[]},relativizeSystem(){}};
  const universe=new Proxy(universeBase,{get(owner,name){if(name==='system'||name==='fadingSystem')borrow(`universe.${name}`);return owner[name];}});
  const rawCamera=new THREE.PerspectiveCamera(63,1.6,.2,1e6);rawCamera.position.set(1,2,3);rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0),.3);
  const camera=new Proxy(rawCamera,{get(owner,name){borrow(`camera.${String(name)}`);return Reflect.get(owner,name);},
    set(owner,name,value){borrow(`camera.${String(name)}.write`);return Reflect.set(owner,name,value);}});
  const shadowRaw={visible:true,intensity:7},sunShadow=new Proxy(shadowRaw,{get(owner,name){borrow(`shadow.${String(name)}`);return owner[name];},
    set(owner,name,value){borrow(`shadow.${String(name)}.write`);owner[name]=value;return true;}});
  const renderer={getRenderTarget(){borrow('render-target.read');return target;},
    setRenderTarget(value){borrow('render-target.write');events.push(value===context.surfaceBootstrapTarget?'private-target':'restore-target');
      fail(value===context.surfaceBootstrapTarget?'private-target':'restore-target');target=value;}};
  if(mrt){renderer.getMRT=()=>{borrow('mrt.read');return currentMrt;};renderer.setMRT=value=>{borrow('mrt.write');fail(value===null?'private-mrt':'restore-mrt');currentMrt=value;};}
  const volumePass=volume?{get activePlanet(){borrow('volume-owner.read');return volumePlanet;},
    setActivePlanet(body,origin){borrow('volume-owner.write');assert.ok(origin===route.target.entry||origin===context.nav.pos);volumePlanet=body;}}:null;
  const atmospherePass={get activePlanet(){borrow('atmosphere-owner.read');return atmospherePlanet;}};
  const route={warpRequested:false,bodyId:'destination',target:{entry:new THREE.Vector3(5,6,7),center:new THREE.Vector3(0,0,0)}};
  const pipeline={framePacer:null,renderCalls:0,
    stopFramePacing(){this.framePacer=null;allowed=true;},
    setActiveAtmosphere(body,origin){borrow('atmosphere-owner.write');assert.ok(origin===route.target.entry||origin===context.nav.pos);atmospherePlanet=body;},
    bindVolumeDepth(body){borrow('volume-depth');events.push(body===targetBody?'private-depth':'restore-depth');fail(body===targetBody?'private-depth':'restore-depth');},
    render(){borrow('render');this.renderCalls++;events.push('render');
      assert.equal(target,context.surfaceBootstrapTarget);if(mrt)assert.equal(currentMrt,null);
      assert.equal(atmospherePlanet,targetBody);if(volume)assert.equal(volumePlanet,targetBody);
      assert.equal(shadowRaw.visible,false);assert.equal(shadowRaw.intensity,0);
      assert.equal(cells.find(cell=>cell.name==='old-body').raw,false);
      assert.equal(cells.find(cell=>cell.name==='destination-body').raw,true);
      assert.equal(cells.find(cell=>cell.name==='destination-other').raw,false);
      // Model private production work changing its borrowed camera/shadow so
      // missing finally restoration cannot pass merely because values stayed
      // untouched in the double.
      rawCamera.position.set(91,92,93);rawCamera.fov=17;rawCamera.updateProjectionMatrix();
      rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),.9);shadowRaw.intensity=44;
      fail('render');return renderResult;
    },
    invalidateVolumeHistory(reason){borrow('history');assert.equal(reason,'private-prewarm');events.push('history');},
  };
  const context={THREE,universe,camera,sunShadow,renderer,volumePass,atmospherePass,nodePipeline:pipeline,
    nav:{pos:new THREE.Vector3(20,30,40),quat:new THREE.Quaternion()},surfaceBootstrapTarget:{name:'private-target'},
    spatialRift:{group:riftGroup,setTransform(){}},
    lookQuatAt(_from,_to,out){return out.setFromAxisAngle(new THREE.Vector3(1,0,0),.6);},
    preparedDestinationIsActive(token,receivedRoute,receivedPrepared){assert.equal(token,4);assert.equal(receivedRoute,route);assert.equal(receivedPrepared,prepared);return active;},
    requestAnimationFrame(callback){assert.ok(rafs.length<8,'Bounded controlled RAF');events.push('raf');rafs.push(callback);},
    warpPreparedRiftWarmState:'idle',warpPreparedRiftWarmError:null,warpPreparedRiftStructurePromise:Promise.resolve(),
    uploadPreparedLodMeshes:async()=>{},celestialClock:{hours:1},RIFT_SPAWN_DISTANCE:25,
    renderRiftDestinationPortal(){events.push('portal');},console:{error(...args){errors.push(args);}},};
  const warm=load('renderPreparedDestinationWarmFrame',context);context.renderPreparedDestinationWarmFrame=warm;
  const portal=load('prewarmPreparedRiftPortal',context);
  const makePacer=({ready=false,status={},poll,snapshot}={})=>{
    const owner={polls:0,snapshots:0,ready,status,
      poll(){assert.equal(this,owner);owner.polls++;events.push('poll');const value=poll?poll(owner):owner.ready;
        if(pipeline.framePacer===owner)allowed=Boolean(value);return value;},
      snapshot(){assert.equal(this,owner);owner.snapshots++;return snapshot?snapshot(owner):owner.status;}};
    return owner;
  };
  if(pacer)pipeline.framePacer=makePacer();
  const capture=()=>({visibility:cells.map(cell=>[cell.name,cell.raw]),camera:{position:rawCamera.position.toArray(),quaternion:rawCamera.quaternion.toArray(),fov:rawCamera.fov,
    projection:rawCamera.projectionMatrix.toArray(),inverseProjection:rawCamera.projectionMatrixInverse.toArray()},
    shadow:{...shadowRaw},target,mrt:currentMrt,volume:volumePlanet,atmosphere:atmospherePlanet});
  return {context,pipeline,route,prepared,targetBody,events,touches,rafs,errors,rawCamera,shadowRaw,cells,makePacer,capture,
    run(){const promise=warm(targetBody,route,prepared,4);promise.catch(()=>{});return promise;},
    portal(){const promise=portal(targetBody,4,route,prepared);promise.catch(()=>{});return promise;},
    cancel(){active=false;},allow(value){allowed=value;},
    setLiveState(){rawCamera.position.set(11,12,13);rawCamera.quaternion.setFromAxisAngle(new THREE.Vector3(0,0,1),.7);rawCamera.fov=31;rawCamera.updateProjectionMatrix();
      shadowRaw.visible=false;shadowRaw.intensity=11;target={name:'later-player'};currentMrt={name:'later-mrt'};
      for(const cell of cells)cell.raw=!cell.raw;volumePlanet={name:'later-volume'};atmospherePlanet={name:'later-atmosphere'};},
    async resume(){assert.equal(rafs.length,1);rafs.shift()(100);await microtasks();},
    restored(expected){assert.deepEqual(capture(),expected);},
  };
}

await test('busy waits never borrow world visibility camera shadow targets or medium owners',async()=>{
  const f=fixture(),owner=f.pipeline.framePacer,before=f.capture(),promise=f.run();
  assert.equal(f.rafs.length,1);assert.equal(f.touches.length,0);f.restored(before);
  await f.resume();assert.equal(f.rafs.length,1);assert.equal(f.touches.length,0);assert.equal(f.pipeline.renderCalls,0);
  owner.ready=true;await f.resume();assert.equal(await promise,true);assert.equal(f.pipeline.renderCalls,1);f.restored(before);
});

await test('state is borrowed only after readiness so live changes while waiting survive restoration',async()=>{
  const f=fixture(),promise=f.run();assert.equal(f.touches.length,0);f.setLiveState();const later=f.capture();
  f.pipeline.framePacer.ready=true;await f.resume();assert.equal(await promise,true);f.restored(later);
});

for(const cancel of ['token','warp-request'])await test(`${cancel} during RAF wait returns false without any state borrowing`,async()=>{
  const f=fixture(),before=f.capture(),promise=f.run();if(cancel==='token')f.cancel();else f.route.warpRequested=true;
  await f.resume();assert.equal(await promise,false);assert.equal(f.touches.length,0);assert.equal(f.pipeline.renderCalls,0);f.restored(before);
});

for(const cancel of ['token','warp-request'])await test(`an already cancelled ${cancel} does not even poll an owner`,async()=>{
  const f=fixture();if(cancel==='token')f.cancel();else f.route.warpRequested=true;
  assert.equal(await f.run(),false);assert.equal(f.pipeline.framePacer.polls,0);assert.equal(f.touches.length,0);
});

await test('no frame pacer preserves synchronous private warm submission and restoration',async()=>{
  const f=fixture({pacer:false}),before=f.capture(),pending=f.run();
  assert.equal(f.pipeline.renderCalls,1);assert.equal(f.rafs.length,0);f.restored(before);assert.equal(await pending,true);
});

await test('only the healthy ready owner permits private submission',async()=>{
  const f=fixture(),owner=f.pipeline.framePacer,before=f.capture();owner.ready=true;
  assert.equal(await f.run(),true);assert.equal(owner.polls,1);assert.equal(owner.snapshots,0);f.restored(before);
});

for(const status of [{disposed:true},{fault:'wait-failed'}])await test(`unavailable owner terminates before borrowing (${JSON.stringify(status)})`,async()=>{
  const f=fixture();f.pipeline.framePacer.status=status;
  await assert.rejects(f.run(),/Destination frame pacing unavailable/);assert.equal(f.rafs.length,0);assert.equal(f.touches.length,0);
});

await test('a lost owner waits passively and can resume after restoration',async()=>{
  const f=fixture();f.pipeline.framePacer.status={lost:true};const pending=f.run();assert.equal(f.touches.length,0);
  await f.resume();assert.equal(f.touches.length,0);f.pipeline.framePacer.status={lost:false};f.pipeline.framePacer.ready=true;
  await f.resume();assert.equal(await pending,true);assert.equal(f.pipeline.renderCalls,1);
});

await test('poll callback stopping pacing cannot dereference a detached owner',async()=>{
  const f=fixture();const old=f.makePacer({poll(){f.pipeline.stopFramePacing();return false;},snapshot(){assert.fail('Detached owner snapshot');}});
  f.pipeline.framePacer=old;const before=f.capture();assert.equal(await f.run(),true);
  assert.equal(old.snapshots,0);assert.equal(f.rafs.length,0);assert.equal(f.pipeline.renderCalls,1);f.restored(before);
});

await test('poll callback replacing an owner re-polls the replacement instead of snapshotting it prematurely',async()=>{
  const f=fixture(),replacement=f.makePacer({ready:true,snapshot(){assert.fail('Ready replacement needs no failure snapshot');}});
  const old=f.makePacer({poll(){f.pipeline.framePacer=replacement;return false;},snapshot(){assert.fail('Old owner snapshot');}});
  f.pipeline.framePacer=old;assert.equal(await f.run(),true);assert.equal(replacement.polls,1);assert.equal(old.snapshots,0);assert.equal(f.rafs.length,0);
});

await test('readiness from a replaced owner cannot bypass a busy replacement',async()=>{
  const f=fixture(),replacement=f.makePacer(),old=f.makePacer({poll(){f.pipeline.framePacer=replacement;return true;}});
  f.pipeline.framePacer=old;const pending=f.run();assert.equal(replacement.polls,1);assert.equal(f.touches.length,0);
  replacement.ready=true;await f.resume();assert.equal(await pending,true);assert.equal(f.pipeline.renderCalls,1);
});

for(const cancel of ['token','warp-request'])await test(`ready poll callback ${cancel} is rechecked before borrowing`,async()=>{
  const f=fixture();f.pipeline.framePacer=f.makePacer({poll(){if(cancel==='token')f.cancel();else f.route.warpRequested=true;return true;}});
  assert.equal(await f.run(),false);assert.equal(f.touches.length,0);assert.equal(f.pipeline.renderCalls,0);
});

await test('native poll errors preserve identity and do not borrow destination state',async()=>{
  const f=fixture(),error=Error('native poll');f.pipeline.framePacer=f.makePacer({poll(){throw error;}});
  await assert.rejects(f.run(),value=>value===error);assert.equal(f.touches.length,0);assert.equal(f.rafs.length,0);
});

for(const fault of ['target-atmosphere','target-volume','private-depth','private-target','private-mrt','render'])
await test(`private ${fault} failure restores the original finally-owned state`,async()=>{
  const f=fixture({pacer:false,fault}),before=f.capture();await assert.rejects(f.run(),new RegExp(`expected ${fault}`));
  f.restored(before);assert.equal(f.events.filter(event=>event==='history').length,1);
});

await test('false production render rejects after restoring state and cannot report a successful warm frame',async()=>{
  const f=fixture({pacer:false,renderResult:false}),before=f.capture();await assert.rejects(f.run(),/was not submitted/);
  f.restored(before);assert.equal(f.events.filter(event=>event==='history').length,1);
});

await test('optional MRT and absent volume owner retain the existing restoration contract',async()=>{
  const f=fixture({pacer:false,mrt:false,volume:false}),before=f.capture();assert.equal(await f.run(),true);f.restored(before);
});

await test('actual portal preparation marks a false warm submission failed rather than complete',async()=>{
  const f=fixture({pacer:false,renderResult:false}),before=f.capture();await f.portal();
  assert.equal(f.context.warpPreparedRiftWarmState,'failed');assert.match(f.context.warpPreparedRiftWarmError,/was not submitted/);
  assert.equal(f.errors.length,1);assert.equal(f.pipeline.renderCalls,1);f.restored(before);
});

await test('actual portal preparation can complete only after the healthy private warm draw',async()=>{
  const f=fixture({pacer:false}),before=f.capture();await f.portal();assert.equal(f.context.warpPreparedRiftWarmState,'complete');
  assert.equal(f.context.warpPreparedRiftWarmError,null);assert.equal(f.pipeline.renderCalls,1);f.restored(before);
});

for(const cancel of ['token','warp-request'])await test(`actual portal ${cancel} during warm pacing wait never marks completion`,async()=>{
  const f=fixture(),before=f.capture(),pending=f.portal();await microtasks();
  assert.equal(f.rafs.length,1);assert.equal(f.touches.length,0);assert.equal(f.context.warpPreparedRiftWarmState,'compiling');
  if(cancel==='token')f.cancel();else f.route.warpRequested=true;
  await f.resume();await pending;assert.notEqual(f.context.warpPreparedRiftWarmState,'complete');
  assert.equal(f.pipeline.renderCalls,0);assert.equal(f.errors.length,0);f.restored(before);
});

const mainAfter=await readFile('src/main.js'),verifierAfter=await readFile(new URL(import.meta.url));
const sourceStable=mainAfter.equals(mainBytes)&&verifierAfter.equals(verifierBytes),failed=results.filter(row=>!row.passed);
const report={passed:!failed.length&&sourceStable,scope:'Pure CPU actual-main-function contracts with explicit state/RAF/pacer doubles. No GL calls, actual frame pacing hardware, visual or performance acceptance.',
  sourceStable,mainSha256:sha(mainBytes),verifierSha256:sha(verifierBytes),functions,counts:{passed:results.length-failed.length,failed:failed.length},results};
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({out,passed:report.passed,sourceStable,counts:report.counts,failures:failed.map(row=>({name:row.name,error:row.error}))}));
if(!report.passed)process.exitCode=1;
