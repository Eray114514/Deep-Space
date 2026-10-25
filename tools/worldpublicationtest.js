// Actual synchronous delta capture and publication state machine. These tests
// exercise visibility/owner/revision contracts, not rendering or GPU readiness.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import * as THREE from 'three';
import {captureWorldPublication} from '../src/world-publication.js';

const files=['src/world-publication.js','tools/worldpublicationtest.js'];
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(path)])));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const out=`test-results/world-publication/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],publications=[],unhandled=[];
const onUnhandled=error=>unhandled.push(error);process.on('unhandledRejection',onUnhandled);
const root=(name,visible=true)=>{const object=new THREE.Group();object.name=name;object.visible=visible;return object;};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const observe=promise=>{const state={status:'pending'};promise.then(value=>{state.status='resolved';state.value=value;},error=>{state.status='rejected';state.error=error;});return state;};
const microtasks=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
async function rejects(promise,error) {const state=observe(promise);await microtasks();assert.equal(state.status,'rejected');assert.equal(state.error,error);}
async function test(name,work) {
  const before=publications.length;
  try {await work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),stack:error?.stack});}
  finally {for(const publication of publications.slice(before))publication.abandon();await microtasks();}
}
function capture(system,options) {const publication=captureWorldPublication(system,options);publications.push(publication);return publication;}
function system() {return {planets:[],compactObjects:[],artificialSites:[]};}
function fixture() {
  const world=system(),a=root('new-body-a'),b=root('new-body-b'),site=root('authored-hidden-site',false);let current=true,allowed=true,revision='r1',builds=0,prepares=0;
  const publication=capture(world,{build(){builds++;world.planets.push({group:a},{group:b});world.artificialSites.push({group:site,parentBody:null});}});
  return {world,a,b,site,publication,get builds(){return builds;},get prepares(){return prepares;},
    set current(value){current=value;},set allowed(value){allowed=value;},set revision(value){revision=value;},
    options:{isCurrent:()=>current,canPublish:()=>allowed,getRevision:()=>revision},
    prepare(){prepares++;return revision;},hidden(){for(const object of [a,b,site])assert.equal(object.visible,false);},
  };
}

await test('capture quarantines every new body/site and old-body direct attachment from one synchronous content build',async()=>{
  const world=system(),oldBody={group:root('old-body')},oldOwned=root('old-owned'),oldSite=root('old-site');oldBody.group.add(oldOwned);
  world.planets.push(oldBody);world.artificialSites.push({group:oldSite,parentBody:null});
  const planet=root('new-planet',false),compact=root('new-compact'),station=root('new-orphan'),city=root('new-floating-city'),
    cityLight=new THREE.Points(new THREE.BufferGeometry(),new THREE.PointsMaterial());cityLight.name='hero-city-lights';
  try {
    const publication=capture(world,{build(){
      world.planets.push({group:planet});world.compactObjects.push({group:compact});world.artificialSites.push({group:station,parentBody:null},{group:city,parentBody:oldBody});
      oldBody.group.add(city,cityLight);
    }});
    assert.equal(publication.state,'pending');assert.equal(publication.system,world);assert.equal(publication.visibility.size,5);
    for(const object of [planet,compact,station,city,cityLight]){assert.equal(publication.visibility.get(object),true);assert.equal(object.visible,false);}
    assert.equal(oldBody.group.visible,true);assert.equal(oldOwned.visible,true);assert.equal(oldSite.visible,true);
    assert.equal(city.parent,oldBody.group);assert.equal(cityLight.parent,oldBody.group);
  } finally {cityLight.geometry.dispose();cityLight.material.dispose();}
});
await test('body/site/direct-child aliases deduplicate by root and body desired visibility wins',async()=>{
  const world=system(),oldBody={group:root('old')},shared=root('shared-new-root',false),hiddenSite=root('hidden-site',false);world.planets.push(oldBody);
  const publication=capture(world,{build(){
    world.planets.push({group:shared});world.compactObjects.push({group:shared});world.artificialSites.push({group:shared},{group:hiddenSite},{group:hiddenSite});oldBody.group.add(shared);
  }});
  assert.equal(publication.visibility.size,2);assert.equal(publication.visibility.get(shared),true);assert.equal(publication.visibility.get(hiddenSite),false);
  assert.equal(shared.visible,false);assert.equal(hiddenSite.visible,false);
});
await test('explicit prebuilt body is quarantined without regenerating content and publishes as a body',async()=>{
  const world=system(),body={group:root('prebuilt',false)};world.planets.push(body);
  const publication=capture(world,{body});assert.equal(publication.visibility.get(body.group),true);assert.equal(publication.visibility.size,1);
  assert.equal(await publication.publish(()=>'r',{isCurrent:()=>true,getRevision:()=>'r'}),true);assert.equal(body.group.visible,true);
});
await test('replacing an old body root and appending several new bodies captures all new group identities',async()=>{
  const world=system(),body={group:root('before')},old=body.group,one=root('replacement'),two=root('second'),three=root('third');world.planets.push(body);
  const publication=capture(world,{build(){body.group=one;world.planets.push({group:two});world.compactObjects.push({group:three});}});
  assert.deepEqual(new Set(publication.visibility.keys()),new Set([one,two,three]));assert.equal(old.visible,true);
});
for(const error of [Error('build'),null,undefined,false,0,''])await test(`a partial build throwing ${String(error)} quarantines its delta and cannot auto-regenerate`,async()=>{
  const world=system(),old={group:root('old-body')},child=root('new-city'),body=root('new-body'),site=root('new-site');world.planets.push(old);let builds=0,prepares=0;
  const publication=capture(world,{build(){builds++;world.planets.push({group:body});world.artificialSites.push({group:site});old.group.add(child);throw error;}});
  assert.equal(publication.state,'build-failed');assert.equal(publication.lastError,error);assert.equal(publication.snapshot().hasError,true);
  assert.equal(publication.snapshot().buildFailed,true);for(const object of [child,body,site])assert.equal(object.visible,false);assert.equal(old.group.visible,true);
  assert.equal(await publication.publish(()=>{prepares++;throw Error('Cannot retry build');}),false);assert.equal(builds,1);assert.equal(prepares,0);
});
await test('initial quarantine failure continues hiding other roots and permanently blocks publication',async()=>{
  const world=system(),bad=root('cannot-hide'),other=root('other');Object.defineProperty(bad,'visible',{get:()=>true,set(){throw false;}});
  const publication=capture(world,{build(){world.planets.push({group:bad},{group:other});}});
  assert.equal(other.visible,false);assert.equal(publication.state,'build-failed');assert.equal(publication.lastError,false);
  assert.equal(publication.snapshot().hasError,true);assert.equal(publication.snapshot().rollbackFailed,true);assert.equal(await publication.publish(()=>assert.fail('Cannot prepare')) ,false);
});
await test('a real build error stays primary when later quarantine also fails',async()=>{
  const world=system(),bad=root('cannot-hide');Object.defineProperty(bad,'visible',{get:()=>true,set(){throw Error('secondary quarantine');}});
  const publication=capture(world,{build(){world.planets.push({group:bad});throw 0;}});
  assert.equal(publication.state,'build-failed');assert.equal(publication.lastError,0);assert.equal(publication.snapshot().hasError,true);
});
await test('a throwing build-result then getter still quarantines the partial build and preserves its falsy error',async()=>{
  const world=system(),body=root('new-body');const publication=capture(world,{build(){world.planets.push({group:body});return Object.defineProperty({},'then',{get(){throw null;}});}});
  assert.equal(publication.state,'build-failed');assert.equal(publication.lastError,null);assert.equal(publication.snapshot().hasError,true);assert.equal(body.visible,false);
});
await test('an accidental asynchronous build is not accepted as captured content and its late rejection is consumed',async()=>{
  const world=system(),body=root('sync-prefix'),ready=deferred();const publication=capture(world,{build(){world.planets.push({group:body});return ready.promise;}});
  assert.equal(publication.state,'build-failed');assert.equal(publication.lastError.code,'asynchronous-build');assert.equal(body.visible,false);
  ready.reject(Error('late build'));await microtasks();assert.equal(await publication.publish(()=>assert.fail('Cannot prepare')),false);
});
await test('capture rejects malformed inputs before invoking any content builder',async()=>{
  assert.throws(()=>captureWorldPublication(null),TypeError);assert.throws(()=>captureWorldPublication(system(),{build:7}),TypeError);
});
await test('roots stay hidden throughout readiness and publish authored false roots without losing that authorship',async()=>{
  const f=fixture(),ready=deferred(),result=observe(f.publication.publish(()=>ready.promise,f.options));
  f.hidden();assert.equal(f.publication.state,'preparing');assert.equal(f.publication.snapshot().inFlight,true);assert.equal(f.publication.attempts,1);
  await microtasks();assert.equal(result.status,'pending');f.hidden();ready.resolve('r1');await microtasks();
  assert.equal(result.status,'resolved');assert.equal(result.value,true);assert.equal(f.a.visible,true);assert.equal(f.b.visible,true);assert.equal(f.site.visible,false);
  assert.equal(f.publication.state,'committed');assert.equal(f.publication.system,null);assert.equal(f.publication.visibility.size,0);assert.equal(f.publication.snapshot().inFlight,false);
});
await test('successful and obsolete batches return safe false without invoking another preparation',async()=>{
  const f=fixture();assert.equal(await f.publication.publish(f.prepare,f.options),true);
  assert.equal(await f.publication.publish(()=>assert.fail('Committed batch prepared again')),false);
  const g=fixture();g.publication.abandon();assert.equal(await g.publication.publish(()=>assert.fail('Abandoned batch prepared again')),false);
});
await test('source revision mismatch retains a hidden pending batch and a later valid retry publishes without rebuilding',async()=>{
  const f=fixture(),ready=deferred(),pending=f.publication.publish(()=>ready.promise,f.options);f.revision='r2';ready.resolve('r1');
  assert.equal(await pending,false);assert.equal(f.publication.state,'pending');f.hidden();assert.equal(f.publication.visibility.size,3);
  assert.equal(await f.publication.publish(f.prepare,f.options),true);assert.equal(f.builds,1);assert.equal(f.prepares,1);assert.equal(f.publication.attempts,2);
});
await test('a temporarily closed presentation gate retains the same batch until a later permitted turn',async()=>{
  const f=fixture();f.allowed=false;const visibility=f.publication.visibility;assert.equal(await f.publication.publish(f.prepare,f.options),false);
  f.hidden();assert.equal(f.publication.state,'pending');assert.equal(f.publication.visibility,visibility);assert.equal(f.publication.snapshot().hasError,false);
  f.allowed=true;assert.equal(await f.publication.publish(f.prepare,f.options),true);assert.equal(f.builds,1);
});
await test('owner loss before preparation abandons without any new content or shader work',async()=>{
  const f=fixture();f.current=false;assert.equal(await f.publication.publish(f.prepare,f.options),false);assert.equal(f.prepares,0);
  f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.system,null);assert.equal(f.publication.visibility.size,0);
});
await test('owner loss during readiness prevents obsolete roots from becoming visible even after ownership later changes back',async()=>{
  const f=fixture(),ready=deferred(),pending=f.publication.publish(()=>ready.promise,f.options);f.current=false;ready.resolve('r1');
  assert.equal(await pending,false);f.hidden();assert.equal(f.publication.state,'obsolete');f.current=true;
  assert.equal(await f.publication.publish(()=>assert.fail('Obsolete roots prepared again'),f.options),false);f.hidden();
});
await test('an obsolete owner wins over an already failed preparation and releases the old batch',async()=>{
  const f=fixture(),ready=deferred(),pending=f.publication.publish(()=>ready.promise,f.options);f.current=false;ready.reject(Error('old program'));
  assert.equal(await pending,false);f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.visibility.size,0);
});
for(const error of [Error('prepare'),null,undefined,false,0,''])await test(`preparation rejection retains original ${String(error)} and a hidden retryable batch`,async()=>{
  const f=fixture();await rejects(f.publication.publish(()=>{throw error;},f.options),error);
  f.hidden();assert.equal(f.publication.state,'pending');assert.equal(f.publication.lastError,error);assert.equal(f.publication.snapshot().hasError,true);
  assert.equal(f.publication.snapshot().inFlight,false);assert.equal(await f.publication.publish(f.prepare,f.options),true);assert.equal(f.builds,1);
});
await test('concurrent publication of one batch is explicitly rejected without a second prepare or attempt',async()=>{
  const f=fixture(),ready=deferred(),first=f.publication.publish(()=>ready.promise,f.options);let called=0;
  await assert.rejects(f.publication.publish(()=>{called++;return 'r1';},f.options),{code:'publication-busy'});
  assert.equal(called,0);assert.equal(f.publication.attempts,1);f.hidden();ready.resolve('r1');assert.equal(await first,true);
});
await test('abandon promptly resolves an indefinitely waiting publication and consumes its late compiler error',async()=>{
  const f=fixture(),ready=deferred(),state=observe(f.publication.publish(()=>ready.promise,f.options));await microtasks();assert.equal(state.status,'pending');
  assert.equal(f.publication.abandon(),true);await microtasks();assert.equal(state.status,'resolved');assert.equal(state.value,false);f.hidden();
  assert.equal(f.publication.snapshot().inFlight,false);assert.equal(f.publication.system,null);assert.equal(f.publication.visibility.size,0);
  ready.reject(Error('late old compiler'));await microtasks();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.abandon(),false);
});
await test('a readiness thenable accessor throwing false is a retryable real error rather than an unresolved publication',async()=>{
  const f=fixture();await rejects(f.publication.publish(()=>Object.defineProperty({},'then',{get(){throw false;}}),f.options),false);
  f.hidden();assert.equal(f.publication.state,'pending');assert.equal(f.publication.lastError,false);assert.equal(f.publication.snapshot().inFlight,false);
});
await test('abandon releases registration but never changes authored visibility on its own',async()=>{
  const f=fixture();f.a.visible=true;assert.equal(f.publication.abandon(),true);assert.equal(f.a.visible,true);assert.equal(f.b.visible,false);
  assert.equal(f.publication.snapshot().rootCount,0);assert.equal(f.publication.snapshot().initialRootCount,3);
});
for(const afterSet of [false,true])await test(`commit setter failure ${afterSet?'after':'before'} its write hides the complete batch, preserves the first error and permits retry`,async()=>{
  const f=fixture(),error=afterSet?false:0;let value=false,armed=true;
  Object.defineProperty(f.b,'visible',{get:()=>value,set(next){if(next&&armed){if(afterSet)value=next;throw error;}value=next;}});
  await rejects(f.publication.publish(f.prepare,f.options),error);f.hidden();assert.equal(f.publication.state,'pending');assert.equal(f.publication.lastError,error);
  assert.equal(f.publication.snapshot().hasError,true);assert.equal(f.publication.snapshot().inFlight,false);armed=false;
  assert.equal(await f.publication.publish(f.prepare,f.options),true);assert.equal(f.a.visible,true);assert.equal(f.b.visible,true);assert.equal(f.site.visible,false);
});
await test('a rollback setter failure cannot replace the original commit exception and permanently closes the uncertain batch',async()=>{
  const f=fixture();let a=false,armed=false,siteHides=0;
  Object.defineProperty(f.a,'visible',{get:()=>a,set(next){if(!next&&armed)throw Error('secondary hide');a=next;}});
  Object.defineProperty(f.b,'visible',{get:()=>false,set(next){if(next){armed=true;throw undefined;}}});
  Object.defineProperty(f.site,'visible',{get:()=>false,set(next){if(!next)siteHides++;}});
  await rejects(f.publication.publish(f.prepare,f.options),undefined);assert.equal(f.publication.lastError,undefined);assert.equal(f.publication.snapshot().hasError,true);
  assert.equal(f.publication.state,'build-failed');assert.equal(f.publication.snapshot().rollbackFailed,true);assert.ok(siteHides>0);
  assert.equal(await f.publication.publish(()=>assert.fail('Cannot retry uncertain batch'),f.options),false);
});
await test('abandon from a commit setter cannot resurrect the batch or leave already-written roots published',async()=>{
  const f=fixture();let value=false;
  Object.defineProperty(f.a,'visible',{get:()=>value,set(next){value=next;if(next)f.publication.abandon();}});
  assert.equal(await f.publication.publish(f.prepare,f.options),false);f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.visibility.size,0);
});
await test('owner loss caused by a visibility setter rolls the whole committed prefix back before reporting obsolete',async()=>{
  const f=fixture();let value=false;Object.defineProperty(f.a,'visible',{get:()=>value,set(next){value=next;if(next)f.current=false;}});
  assert.equal(await f.publication.publish(f.prepare,f.options),false);f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.visibility.size,0);
});
await test('a setter error stays primary even if that setter also invalidates the world owner',async()=>{
  const f=fixture();let value=false;Object.defineProperty(f.a,'visible',{get:()=>value,set(next){value=next;if(next){f.current=false;throw 0;}}});
  await rejects(f.publication.publish(f.prepare,f.options),0);f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.snapshot().hasError,true);
});
for(const phase of ['owner','gate','revision'])await test(`abandon from the ${phase} callback stays terminal rather than being reset to pending/committed`,async()=>{
  const f=fixture();let ownerCalls=0;const options={...f.options};
  if(phase==='owner')options.isCurrent=()=>{if(++ownerCalls===2)f.publication.abandon();return true;};
  if(phase==='gate')options.canPublish=()=>{f.publication.abandon();return false;};
  if(phase==='revision')options.getRevision=()=>{f.publication.abandon();return 'r1';};
  assert.equal(await f.publication.publish(f.prepare,options),false);f.hidden();assert.equal(f.publication.state,'obsolete');assert.equal(f.publication.snapshot().inFlight,false);
});
await test('required owner/revision proofs and scalar callback results cannot be silently omitted',async()=>{
  const f=fixture();await assert.rejects(f.publication.publish(f.prepare),TypeError);assert.equal(f.publication.attempts,0);f.hidden();
  await assert.rejects(f.publication.publish(()=>'r1',{...f.options,isCurrent:()=>undefined}),TypeError);f.hidden();
  await assert.rejects(f.publication.publish(()=>undefined,f.options),TypeError);f.hidden();
  await assert.rejects(f.publication.publish(f.prepare,{...f.options,getRevision:()=>undefined}),TypeError);f.hidden();
  await assert.rejects(f.publication.publish(f.prepare,{...f.options,canPublish:()=>undefined}),TypeError);f.hidden();
});
await test('revision and owner callback failures remain real falsy failures with no publication',async()=>{
  const f=fixture();await rejects(f.publication.publish(f.prepare,{...f.options,getRevision(){throw null;}}),null);f.hidden();assert.equal(f.publication.lastError,null);
  await rejects(f.publication.publish(f.prepare,{...f.options,isCurrent(){throw false;}}),false);f.hidden();assert.equal(f.publication.lastError,false);
});
for(const name of ['isCurrent','canPublish','getRevision'])await test(`an accidentally async ${name} proof rejects clearly and consumes its already-started rejection`,async()=>{
  const f=fixture();await assert.rejects(f.publication.publish(f.prepare,{...f.options,[name]:()=>Promise.reject(Error(`async ${name}`))}),TypeError);
  f.hidden();assert.equal(f.publication.state,'pending');assert.equal(f.publication.snapshot().inFlight,false);
});
await test('empty revision strings are still explicit matching identities rather than truthy checks',async()=>{
  const f=fixture();assert.equal(await f.publication.publish(()=>'',{...f.options,getRevision:()=>''}),true);
});
await test('snapshot returns detached plain metadata without touching live roots or error accessors',async()=>{
  const f=fixture();let reads=0;const error=Object.defineProperty({},'message',{get(){reads++;throw Error('error getter');}});
  await rejects(f.publication.publish(()=>{throw error;},f.options),error);Object.defineProperty(f.a,'visible',{get(){reads++;throw Error('root getter');},set(){}});
  const a=f.publication.snapshot(),b=f.publication.snapshot();a.error.type='changed';assert.equal(b.error.type,'object');assert.equal(reads,0);
  assert.doesNotThrow(()=>JSON.stringify(b));assert.equal(b.hasError,true);
});
await test('independent batches can wait concurrently without conflating their owners or roots',async()=>{
  const a=fixture(),b=fixture(),readyA=deferred(),readyB=deferred();const first=a.publication.publish(()=>readyA.promise,a.options),second=b.publication.publish(()=>readyB.promise,b.options);
  readyB.resolve('r1');assert.equal(await second,true);a.hidden();readyA.resolve('r1');assert.equal(await first,true);
});
await test('an empty captured delta still requires owner/readiness/revision proof before committing',async()=>{
  const publication=capture(system()),ready=deferred(),pending=observe(publication.publish(()=>ready.promise,{isCurrent:()=>true,getRevision:()=>'empty'}));
  await microtasks();assert.equal(pending.status,'pending');assert.equal(publication.state,'preparing');ready.resolve('empty');await microtasks();
  assert.equal(pending.status,'resolved');assert.equal(pending.value,true);assert.equal(publication.state,'committed');
});
await test('late rejected compiler/build promises and invalid asynchronous proofs leave no unhandled rejection behind',async()=>{
  await new Promise(resolve=>setTimeout(resolve,0));assert.deepEqual(unhandled,[]);
});
process.removeListener('unhandledRejection',onUnhandled);

const sources=[];for(const [path,bytes] of frozen){const after=await readFile(path);sources.push({path,bytes:bytes.length,sha256:sha(bytes),stable:sha(bytes)===sha(after)});}
const report={kind:'cpu-contracts',scope:'Actual world delta capture/visibility publication; controlled readiness/owner/revision; no native GPU or performance acceptance',
  passed:cases.filter(item=>item.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,passed:report.passed,total:report.total,failures:cases.filter(item=>!item.passed)},null,2));
assert.ok(sources.every(source=>source.stable),'World publication inputs changed during execution');assert.equal(report.passed,report.total);
