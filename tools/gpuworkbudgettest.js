// Pure CPU contracts for the actual column-work admission/query owners.
// Native doubles forbid blocking waits, flush, finish, getError and early results.
// This is not a whole-frame GPU budget or hardware-performance acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const files=['src/gpu-work-budget.js','src/gpu-query-state.js','tools/gpuworkbudgettest.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(new URL(`../${path}`,import.meta.url))])));
// Read before importing: a concurrent source edit during module loading must
// fail the final byte check instead of archiving newer bytes than the class used.
const { GpuWorkBudget }=await import('../src/gpu-work-budget.js');
const { currentGpuDisjointEpoch,readGpuDisjointEpoch }=await import('../src/gpu-query-state.js');
const out=`test-results/gpu-work-budget/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],fixtures=[];
const nativeTimers={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
const scheduled=new Map();let timerId=0;
globalThis.setTimeout=(work,ms)=>{const id=++timerId;scheduled.set(id,{work,ms});return id;};
globalThis.clearTimeout=id=>scheduled.delete(id);
const tick=()=>{const batch=[...scheduled];scheduled.clear();for(const [,item] of batch)item.work();};

function fixture(options={},supported=true) {
  let epoch=0,lost=false,disjoint=false,current=null,nextId=0,draws=0,failQuery=false,failFence=false;
  const queries=[],syncs=[],calls=[],listeners=new Map(),hooks=new Map(),beforeHooks=new Map();
  const ext={TIME_ELAPSED_EXT:1,GPU_DISJOINT_EXT:2};
  const emit=name=>{for(const listener of [...(listeners.get(name)||[])])listener();};
  const call=(name,work,args=[])=>{
    calls.push({name});const before=beforeHooks.get(name);
    if(before){beforeHooks.delete(name);before({args});}
    const value=work();const hook=hooks.get(name);
    if(hook){hooks.delete(name);hook({value,args});}return value;
  };
  const valid=(handle,kind)=>{
    assert.equal(lost,false,`${kind} touched while context lost`);assert.ok(handle,`Missing ${kind}`);
    assert.equal(handle.epoch,epoch,`Old-context ${kind} touched`);assert.equal(handle.deleted,false,`Deleted ${kind} touched`);
  };
  const gl={CURRENT_QUERY:3,QUERY_RESULT_AVAILABLE:4,QUERY_RESULT:5,SYNC_GPU_COMMANDS_COMPLETE:6,
    TIMEOUT_EXPIRED:7,ALREADY_SIGNALED:8,CONDITION_SATISFIED:9,WAIT_FAILED:10,
    getExtension:()=>supported?ext:null,isContextLost:()=>lost,
    getParameter:p=>call('disjoint',()=>{assert.equal(p,ext.GPU_DISJOINT_EXT);const value=disjoint;disjoint=false;return value;}),
    getQuery:()=>call('getQuery',()=>current),
    createQuery:()=>call('createQuery',()=>{if(failQuery){failQuery=false;return null;}
      const q={id:++nextId,epoch,deleted:false,available:false,ns:1000000};queries.push(q);return q;}),
    beginQuery:(_target,q)=>call('beginQuery',()=>{valid(q,'query');assert.equal(current,null,'Nested native timer');current=q;}),
    endQuery:()=>call('endQuery',()=>{valid(current,'query');current=null;}),
    deleteQuery:q=>call('deleteQuery',()=>{valid(q,'query');assert.notEqual(current,q);q.deleted=true;}),
    getQueryParameter:(q,kind)=>call(kind===4?'available':'result',()=>{
      valid(q,'query');if(kind===4)return q.available;
      assert.equal(kind,5);assert.equal(q.available,true,'Synchronous unavailable result read');return q.ns;
    },[q,kind]),
    fenceSync:()=>call('fenceSync',()=>{if(failFence){failFence=false;return null;}
      const s={id:++nextId,epoch,deleted:false,status:7};syncs.push(s);return s;}),
    clientWaitSync:(s,flags,timeout)=>call('clientWaitSync',()=>{
      valid(s,'sync');assert.equal(flags,0);assert.equal(timeout,0,'Only nonblocking fence polling allowed');return s.status;
    },[s]),
    deleteSync:s=>call('deleteSync',()=>{valid(s,'sync');s.deleted=true;}),
    drawArrays:()=>call('draw',()=>{assert.equal(lost,false);draws++;}),
    finish:()=>assert.fail('finish forbidden'),flush:()=>assert.fail('flush forbidden'),getError:()=>assert.fail('getError forbidden'),
    waitSync:()=>assert.fail('server wait forbidden')};
  const renderer={getContext:()=>gl,domElement:{
    addEventListener(name,listener){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(listener);},
    removeEventListener(name,listener){listeners.get(name)?.delete(listener);}}};
  const f={gl,ext,renderer,calls,queries,syncs,hooks,
    get draws(){return draws;},get current(){return current;},get listenerCount(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);},
    count:name=>calls.filter(call=>call.name===name).length,
    on(name,work){assert.equal(hooks.has(name),false);hooks.set(name,work);},
    before(name,work){assert.equal(beforeHooks.has(name),false);beforeHooks.set(name,work);},
    lose(){lost=true;epoch++;current=null;emit('webglcontextlost');},
    restore(){lost=false;emit('webglcontextrestored');},
    loseRestore(){f.lose();f.restore();},markDisjoint(){disjoint=true;},
    failNextQuery(){failQuery=true;},failNextFence(){failFence=true;},
    complete({gpuMs=1,available=true,status=gl.CONDITION_SATISFIED}={}) {
      for(const q of queries)if(q.epoch===epoch&&!q.deleted){q.available=available;q.ns=gpuMs*1e6;}
      for(const s of syncs)if(s.epoch===epoch&&!s.deleted)s.status=status;
    },
    work(grant,actual=grant){for(let i=0;i<actual;i++)gl.drawArrays();return {draws:actual};},
    external(){assert.equal(current,null);const q={external:true,epoch,deleted:false};current=q;return q;},
    endExternal(){current=null;},
    createBudget(config={}){const p=new GpuWorkBudget(renderer,config);f.budgets.push(p);return p;},
    cleanup(){hooks.clear();beforeHooks.clear();f.lose();for(const p of f.budgets)p.dispose();}};
  f.p=new GpuWorkBudget(renderer,options);f.budgets=[f.p];fixtures.push(f);return f;
}

function test(name,work) {
  const begin=fixtures.length;
  try {work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),actual:error.actual,expected:error.expected,stack:error.stack});}
  finally {for(const f of fixtures.slice(begin)){try{f.cleanup();}catch{}}scheduled.clear();}
}

try {
  test('unknown work calibrates one draw and measured GPU safety controls later grants',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();
    const first=p.run(key,grant=>f.work(grant));assert.equal(first.granted,1);assert.equal(first.units,1);
    assert.equal(p.snapshot().records[0].gpuMs,null);assert.equal(f.count('result'),0);
    f.complete({gpuMs:.5});p.poll();assert.equal(p.snapshot().stats.observed,1);
    p.beginFrame();const next=p.run(key,grant=>f.work(grant));
    assert.equal(next.granted,5,'4ms / (0.5ms native x 1.5 safety) admits only five draws');
    assert.ok(p.snapshot().remainingMs>=0);assert.equal(p.snapshot().frameUnits,5);
    assert.equal(p.snapshot().records.at(-1).estimatedMs,3.75);
  });
  test('slow feedback blocks an oversized atomic draw rather than rounding up',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:4});p.poll();
    p.beginFrame();let housekeeping=0;const next=p.run(key,grant=>{assert.equal(grant,0);housekeeping++;return {draws:0};});
    assert.equal(next.granted,0);assert.equal(housekeeping,1);assert.equal(f.draws,1);
  });
  test('frame draw cap and estimated millisecond cap remain independent',()=>{
    const f=fixture({maxUnits:3,sampleEvery:1}),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));
    f.complete({gpuMs:.01});p.poll();p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,3);
    let zero=0;p.run(key,grant=>{assert.equal(grant,0);zero++;return {draws:0};});assert.equal(zero,1);
    const snapshot=p.snapshot();assert.equal(snapshot.frameUnits,3);assert.ok(snapshot.remainingMs>=0&&snapshot.remainingMs<=4);
  });
  test('partial actual draw count stays conservative and zero actual draws refund admission',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:.25});p.poll();
    p.beginFrame();const prior=p.snapshot(),partial=p.run(key,grant=>{assert.ok(grant>1);return f.work(grant,1);});
    assert.equal(partial.units,1);assert.ok(p.snapshot().frameUnits>=1&&p.snapshot().frameUnits<=p.maxUnits);
    f.complete({gpuMs:.25});p.poll();p.beginFrame();const before=p.snapshot();
    const none=p.run(key,()=>({draws:0}));assert.equal(none.units,0);
    assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().remainingMs,before.remainingMs);
    assert.equal(p.snapshot().frameUnits,before.frameUnits);assert.ok(prior.remainingMs>0);
  });
  test('zero allowance performs housekeeping without queries fences or draws',()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});const count=f.calls.length;let cleaned=0;
    const result=p.run({},grant=>{assert.equal(grant,0);cleaned++;return {draws:0};});
    assert.equal(result.granted,0);assert.equal(cleaned,1);assert.equal(f.calls.length,count);assert.equal(f.draws,0);
    assert.equal(p.snapshot().pending,0);
  });
  test('two in-flight fences survive bank cancellation and block new admissions',()=>{
    const f=fixture(),p=f.p,bank={cancelled:false};p.beginFrame();
    p.run(bank,grant=>f.work(grant));p.run({},grant=>f.work(grant));assert.equal(p.snapshot().pending,2);
    bank.cancelled=true;p.beginFrame();let cleaned=0;
    const blocked=p.run(bank,grant=>{assert.equal(grant,0);cleaned++;return {draws:0};});
    assert.equal(blocked.granted,0);assert.equal(cleaned,1);assert.equal(p.snapshot().pending,2);
    assert.ok(p.snapshot().inFlightEstimatedMs>0);assert.equal(p.snapshot().stats.completed,0);
    assert.equal(p.snapshot().stats.peakPending,2);assert.equal(f.count('fenceSync'),2);
  });
  test('estimated in-flight millisecond credit blocks before the fence-count cap',()=>{
    const f=fixture({maxInFlightMs:3}),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));
    const blocked=p.run({},grant=>{assert.equal(grant,0);return {draws:0};});
    assert.equal(blocked.granted,0);assert.equal(p.snapshot().pending,1);assert.equal(f.draws,1);
  });
  test('retirement retains the renderer owner until asynchronous fence completion',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));p.dispose();
    assert.equal(p.snapshot().disposed,true);assert.equal(p.snapshot().released,false);
    assert.throws(()=>f.createBudget(),/already/);assert.ok(scheduled.size>0);
    const reads=f.count('result');tick();assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().released,false);
    f.complete({available:false});tick();assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().released,true);
    assert.equal(f.count('result'),reads,'Retired owners need the fence, never a timer result');
    assert.equal(f.listenerCount,0);const next=f.createBudget();next.dispose();assert.equal(next.snapshot().released,true);
  });
  test('a signaled fence with unavailable timing never blocks for the result',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete({available:false});p.poll();
    assert.equal(f.count('result'),0);assert.ok(p.snapshot().stats.completed<=1);
    f.complete({gpuMs:1});p.poll();assert.equal(p.snapshot().pending,0);assert.equal(f.count('result'),1);
  });
  test('missing timer support stays at one calibration draw and only uses fences',()=>{
    const f=fixture({},false),p=f.p,key={};
    for(let i=0;i<3;i++){p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);f.complete();p.poll();}
    assert.equal(f.count('createQuery'),0);assert.equal(f.count('result'),0);assert.equal(p.snapshot().stats.observed,0);
  });
  test('external elapsed query is never ended or read by the budget',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();const external=f.external();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1);assert.equal(f.current,external);
    assert.equal(f.count('createQuery'),0);assert.equal(f.count('endQuery'),0);assert.equal(f.count('result'),0);
    f.endExternal();f.complete();p.poll();assert.equal(p.snapshot().pending,0);p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1,'An untimed external interval cannot teach a cheap cost');
  });
  test('query allocation failure preserves the draw fence without learning a cost',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();f.failNextQuery();p.run(key,grant=>f.work(grant));
    assert.equal(p.snapshot().pending,1);assert.equal(f.count('beginQuery'),0);f.complete();p.poll();
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
  });
  test('sparse timer sampling and stale cost force bounded re-calibration',()=>{
    const f=fixture({sampleEvery:8,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:.5});p.poll();
    p.beginFrame();const before=f.count('createQuery');assert.ok(p.run(key,grant=>f.work(grant)).granted>1);
    assert.equal(f.count('createQuery'),before);f.complete();p.poll();p.beginFrame();p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1);assert.equal(f.count('createQuery'),before+1);
  });
  test('one valid stale re-calibration replaces an expired high peak and restores bounded admission',()=>{
    const f=fixture({budgetMs:6,initialUnitMs:2,maxUnits:12,sampleEvery:1,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
    f.complete({gpuMs:15});p.poll();assert.equal(p.snapshot().stats.observed,1);
    for(let i=0;i<2;i++) {
      p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,0,'A fresh 22.5ms safe peak must block a 6ms allowance');
    }
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1,'Expired cost permits exactly one calibration draw');
    f.complete({gpuMs:.5});p.poll();assert.equal(p.snapshot().stats.observed,2);
    p.beginFrame();const next=p.run(key,grant=>f.work(grant));
    assert.equal(next.granted,8,'A valid 0.5ms x 1.5 safety calibration must replace the expired peak, not refresh it');
    assert.equal(next.units,8);assert.equal(p.snapshot().frameUnits,8);assert.equal(p.snapshot().remainingMs,0);
    assert.equal(p.snapshot().records.at(-1).estimatedMs,6);assert.ok(p.snapshot().pending<=2);
  });
  test('fresh same-key high cost remains conservative after a cheaper valid sample',()=>{
    const f=fixture({budgetMs:6,maxUnits:12,sampleEvery:1,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:2});p.poll();
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant,1)).granted,2);
    f.complete({gpuMs:.25});p.poll();p.beginFrame();
    const next=p.run(key,grant=>f.work(grant));assert.equal(next.granted,2,'Fresh peak retains the existing conservative decay');
    assert.ok(p.snapshot().records.at(-1).estimatedMs>5.8);assert.ok(p.snapshot().remainingMs>=0);
  });
  for(const gpuMs of [0,-1,NaN,Infinity])test(`invalid stale calibration cannot replace a high peak with cheap work (${gpuMs})`,()=>{
    const f=fixture({budgetMs:6,maxUnits:12,sampleEvery:1,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:15});p.poll();
    for(let i=0;i<3;i++)p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1);f.complete({gpuMs});p.poll();
    assert.equal(p.snapshot().stats.observed,1);assert.equal(p.snapshot().records.at(-1).gpuMs,null);
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1,'Invalid evidence keeps the key in one-draw calibration');
  });
  test('disjoint stale calibration cannot authorize a larger batch',()=>{
    const f=fixture({budgetMs:6,maxUnits:12,sampleEvery:1,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:15});p.poll();
    for(let i=0;i<3;i++)p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1);f.complete({gpuMs:.01});f.markDisjoint();p.poll();
    assert.equal(p.snapshot().stats.observed,1);assert.equal(p.snapshot().pending,0);
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1,'Disjoint timing loses trust rather than learning a low price');
  });
  test('failed stale calibration cannot publish a cheap replacement',()=>{
    const f=fixture({budgetMs:6,maxUnits:12,sampleEvery:1,maxSampleAge:2}),p=f.p,key={};
    p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:15});p.poll();
    for(let i=0;i<3;i++)p.beginFrame();
    assert.throws(()=>p.run(key,grant=>{assert.equal(grant,1);f.work(grant);throw Error('calibration callback failed');}),/calibration callback failed/);
    f.complete({gpuMs:.01});p.poll();assert.equal(p.snapshot().stats.observed,1);
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
  });
  test('same-key history is bounded while identities remain independent',()=>{
    const f=fixture({history:2}),p=f.p,a={},b={};p.beginFrame();p.run(a,grant=>f.work(grant));
    f.complete({gpuMs:.1});p.poll();p.beginFrame();assert.ok(p.run(a,grant=>f.work(grant)).granted>1);
    f.complete();p.poll();p.beginFrame();assert.equal(p.run(b,grant=>f.work(grant)).granted,1);
    assert.equal(p.snapshot().records.length,2);
  });
  test('failed callback is never a calibration sample',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();
    assert.throws(()=>p.run(key,()=>{throw Error('before actual draw');}),/before actual draw/);
    assert.equal(f.draws,0);assert.equal(p.snapshot().pending,1);
    f.complete({gpuMs:0});p.poll();assert.equal(p.snapshot().records[0].failed,true);
    p.beginFrame();const next=p.run(key,grant=>f.work(grant));
    assert.equal(next.granted,1,'An empty/failed interval cannot calibrate unknown real work as free');
  });
  test('dispose during fence poll cannot recursively retire the same ticket',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete();
    f.on('clientWaitSync',()=>p.dispose());
    assert.doesNotThrow(()=>p.poll(),'Dispose must defer to the current poll transaction');
    assert.equal(f.count('deleteQuery'),1);assert.equal(f.count('deleteSync'),1);
    assert.equal(p.snapshot().stats.completed,1);assert.equal(p.snapshot().released,true);
  });
  for(const invalid of [grant=>grant+1,()=>-1,()=>NaN,()=>1.5])test(`invalid draw count never calibrates (${String(invalid)})`,()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();assert.throws(()=>p.run(key,grant=>({draws:invalid(grant)})),/draw|grant/);
    f.complete({gpuMs:.01});p.poll();assert.equal(p.snapshot().stats.observed,0);
    p.beginFrame();const result=p.run(key,grant=>f.work(grant));assert.ok(result.granted<=1);
  });
  for(const gpuMs of [0,-1,NaN,Infinity])test(`nonpositive or nonfinite timing cannot grant large work (${gpuMs})`,()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs});p.poll();
    assert.equal(p.snapshot().stats.observed,0);p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
  });
  test('disjoint drops only timing trust and retains unfinished fence credit',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.markDisjoint();p.poll();
    assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().stats.completed,0);assert.equal(f.count('deleteQuery'),1);
    assert.ok(p.snapshot().inFlightEstimatedMs>0);f.complete();p.poll();assert.equal(p.snapshot().stats.observed,0);
    p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
  });
  test('another observer consumes disjoint without hiding it from budget polling',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));const before=currentGpuDisjointEpoch(f.gl);
    f.markDisjoint();assert.equal(readGpuDisjointEpoch(f.gl,f.ext),before+1);
    assert.equal(readGpuDisjointEpoch(f.gl,f.ext),before+1,'Consumed flag must still retain the shared generation');
    f.complete({gpuMs:.01});p.poll();assert.equal(p.snapshot().stats.observed,0);assert.equal(p.snapshot().pending,0);
  });
  test('shared disjoint epoch change after beginFrame invalidates admission cost immediately',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:.01});p.poll();
    p.beginFrame();f.markDisjoint();readGpuDisjointEpoch(f.gl,f.ext);
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1,'A stale shared-epoch estimate is not calibration');
  });
  test('disjoint observed during result delivery cannot publish cheap timing',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:.01});
    f.on('result',()=>{f.markDisjoint();readGpuDisjointEpoch(f.gl,f.ext);});p.poll();
    assert.equal(p.snapshot().stats.observed,0);p.beginFrame();assert.equal(p.run(key,grant=>f.work(grant)).granted,1);
  });
  test('native disjoint arising during result delivery is checked before publishing timing',()=>{
    const f=fixture(),p=f.p,key={};p.beginFrame();p.run(key,grant=>f.work(grant));f.complete({gpuMs:.01});
    f.on('result',()=>f.markDisjoint());p.poll();
    assert.equal(p.snapshot().stats.observed,0,'A result read cannot publish trust after a new native disjoint');
    assert.equal(p.snapshot().records[0].gpuMs,null);
  });
  test('fence wait failure is not completion and never releases the renderer owner',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete({status:f.gl.WAIT_FAILED});p.poll();
    assert.ok(p.snapshot().fault);assert.equal(p.snapshot().stats.completed,0);assert.equal(p.snapshot().pending,1);
    p.dispose();tick();assert.equal(p.snapshot().released,false);assert.throws(()=>f.createBudget(),/already/);
    f.lose();assert.equal(p.snapshot().stats.completed,0);assert.equal(p.snapshot().released,true);assert.equal(f.count('deleteSync'),0);
  });
  test('fence allocation failure cannot pretend the submission completed',()=>{
    const f=fixture(),p=f.p;p.beginFrame();f.failNextFence();p.run({},grant=>f.work(grant));
    assert.ok(p.snapshot().fault);assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().stats.completed,0);
    p.beginFrame();assert.equal(p.run({},grant=>{assert.equal(grant,0);return {draws:0};}).granted,0);
    p.dispose();assert.equal(p.snapshot().released,false);assert.throws(()=>f.createBudget(),/already/);
  });
  test('positive-grant reentry does not call nested work or reset the frame',()=>{
    const f=fixture(),p=f.p;p.beginFrame();let nested=0;
    p.run({},grant=>{assert.throws(()=>p.beginFrame(),/inside|active|submission/);
      const result=p.run({},()=>{nested++;return {draws:1};});assert.equal(result.granted,0);return f.work(grant);});
    assert.equal(nested,0);assert.equal(f.draws,1);assert.equal(f.count('fenceSync'),1);
  });
  test('zero-grant housekeeping also protects against recursive submission',()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});let nested=0;
    p.run({},grant=>{assert.equal(grant,0);const result=p.run({},()=>{nested++;return {draws:0};});assert.equal(result.granted,0);
      assert.throws(()=>p.beginFrame(),/inside|active|submission/);return {draws:0};});assert.equal(nested,0);
  });
  test('zero-grant callback must not report positive GPU draws',()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});assert.throws(()=>p.run({},()=>({draws:1})),/draw|grant/);
    assert.equal(p.snapshot().stats.completed,0);
  });
  for(const throws of [false,true])test(`observable zero-grant submission retains credit and owner, throws=${throws}`,()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});
    assert.throws(()=>p.run({},()=>{f.work(1);if(throws)throw Error('zero callback failed after draw');return {draws:1};}),
      throws?/zero callback failed/:/draw|grant/);
    assert.equal(f.draws,1);assert.ok(p.snapshot().fault);assert.equal(p.snapshot().pending,1);
    assert.equal(p.snapshot().stats.completed,0);assert.equal(p.snapshot().stats.observed,0);
    const tickets=p.snapshot().pending;p.run({},grant=>{assert.equal(grant,0);return {draws:0};});
    assert.equal(p.snapshot().pending,tickets);p.dispose();assert.equal(p.snapshot().released,false);
    assert.throws(()=>f.createBudget(),/already/);f.complete({available:false});tick();
    assert.equal(p.snapshot().released,true);assert.equal(p.snapshot().stats.observed,0);
    assert.equal(p.snapshot().records.at(-1).failed,true);
  });
  for(const throws of [false,true])for(const restore of [false,true])test(`zero-grant fence changes context, callbackThrows=${throws}, restore=${restore}`,()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});
    f.on('fenceSync',()=>{f.lose();if(restore)f.restore();});
    assert.throws(()=>p.run({},()=>{f.work(1);if(throws)throw Error('zero callback failed after draw');return {draws:1};}),
      throws?/zero callback failed/:/draw|grant/);
    assert.equal(p.active,false);assert.equal(p.snapshot().pending,0,'Old zero-grant fence must not reappear after loss');
    assert.equal(p.snapshot().stats.completed,0);assert.equal(f.count('deleteSync'),0);
    if(restore){p.beginFrame();assert.equal(p.run({},grant=>f.work(grant)).granted,1);}
  });
  test('zero-grant fence failure preserves quarantine until context loss',()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});f.failNextFence();
    assert.throws(()=>p.run({},()=>f.work(1)),/draw|grant/);assert.ok(p.snapshot().fault);
    assert.equal(p.snapshot().pending,1);p.dispose();tick();assert.equal(p.snapshot().released,false);
    assert.equal(p.snapshot().stats.completed,0);assert.throws(()=>f.createBudget(),/already/);
    f.lose();assert.equal(p.snapshot().released,true);
  });
  test('dispose inside a zero-grant violating callback cannot release its in-flight draw',()=>{
    const f=fixture(),p=f.p;p.beginFrame({allowanceMs:0});
    assert.throws(()=>p.run({},()=>{f.work(1);p.dispose();return {draws:1};}),/draw|grant/);
    assert.equal(p.snapshot().disposed,true);assert.equal(p.snapshot().released,false);assert.equal(p.snapshot().pending,1);
    f.complete({available:false});tick();assert.equal(p.snapshot().released,true);
  });
  for(const throws of [false,true])test(`terminal released owner never resurrects native tickets, housekeepingThrows=${throws}`,()=>{
    const f=fixture(),p=f.p;p.dispose();assert.equal(p.snapshot().released,true);const calls=f.calls.length;
    assert.throws(()=>p.run({},grant=>{assert.equal(grant,0);if(throws)throw Error('retired housekeeping');return {draws:1};}),
      throws?/retired housekeeping/:/draw|grant/);
    assert.equal(p.snapshot().pending,0,'A released owner cannot schedule or retire a new fence');
    assert.equal(f.calls.length,calls,'Terminal housekeeping cannot create native resources');
    const next=f.createBudget();next.dispose();assert.equal(next.snapshot().released,true);
  });
  for(const stage of ['getQuery','createQuery','beginQuery'])test(`dispose inside ${stage} prevents later work`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();let called=0;f.on(stage,()=>p.dispose());
    assert.doesNotThrow(()=>p.run({},()=>{called++;return f.work(1);}));
    assert.equal(called,0);assert.equal(f.draws,0);
    assert.equal(p.active,false);assert.equal(f.current,null);assert.equal(p.snapshot().released,true);
    assert.equal(f.count('fenceSync'),0);
  });
  for(const throws of [false,true])test(`dispose inside actual draw keeps pending ownership (${throws})`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();const work=()=>p.run({},grant=>{f.work(grant);p.dispose();if(throws)throw Error('draw disposed');return {draws:grant};});
    if(throws)assert.throws(work,/draw disposed/);else work();
    assert.equal(p.active,false);assert.equal(f.current,null);assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().released,false);
    assert.throws(()=>f.createBudget(),/already/);f.complete({available:false});tick();assert.equal(p.snapshot().released,true);
    assert.equal(f.count('deleteSync'),1);
  });
  test('dispose inside zero-actual work leaves no restored allowance',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},()=>{p.dispose();return {draws:0};});
    assert.equal(p.snapshot().remainingMs,0);assert.equal(p.snapshot().released,true);assert.equal(p.active,false);
  });
  for(const stage of ['createQuery','beginQuery','endQuery','fenceSync'])for(const restore of [false,true])test(`context change inside ${stage}, restore=${restore}`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();f.on(stage,()=>{f.lose();if(restore)f.restore();});
    assert.doesNotThrow(()=>p.run({},grant=>f.work(grant)));
    assert.equal(p.active,false);assert.equal(p.snapshot().pending,0);assert.equal(f.current,null);
    if(restore){p.beginFrame();assert.equal(p.run({},grant=>f.work(grant)).granted,1);}
  });
  for(const restore of [false,true])test(`context change in final getQuery never ends an old native query, restore=${restore}`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();
    assert.doesNotThrow(()=>p.run({},grant=>{f.work(grant);f.on('getQuery',()=>{f.lose();if(restore)f.restore();});return {draws:grant};}));
    assert.equal(p.active,false);assert.equal(p.snapshot().pending,0);assert.equal(f.count('endQuery'),0);assert.equal(f.current,null);
  });
  for(const stage of ['clientWaitSync','available','result','deleteQuery','deleteSync','disjoint'])test(`poll context loss/restoration at ${stage} never resurrects old tickets`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete();
    f.on(stage,()=>f.loseRestore());assert.doesNotThrow(()=>p.poll());
    assert.equal(p.snapshot().pending,0);assert.equal(p.active,false);
    p.beginFrame();assert.equal(p.run({},grant=>f.work(grant)).granted,1);
  });
  for(const stage of ['available','result','deleteQuery','deleteSync'])test(`dispose at poll ${stage} retires exactly once`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete();
    f.on(stage,()=>p.dispose());assert.doesNotThrow(()=>p.poll());assert.equal(p.snapshot().pending,0);
    assert.equal(p.snapshot().released,true);assert.equal(f.count('deleteQuery'),1);assert.equal(f.count('deleteSync'),1);
    assert.equal(p.snapshot().stats.completed,1);
  });
  for(const stage of ['clientWaitSync','available','result','deleteQuery','deleteSync'])test(`poll exception at ${stage} cannot retry a consumed native handle`,()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete();
    f.on(stage,()=>{throw Error(`native ${stage} failed`);});let exposed=false;
    try {p.poll();}catch(error){exposed=true;assert.match(String(error),/native .* failed/);}
    assert.equal(p.polling,false);assert.equal(p.active,false);assert.ok(exposed||p.snapshot().fault,'Failure must be observable');
    assert.doesNotThrow(()=>p.dispose(),'Cleanup must not retry a query/sync whose deletion already ran');
    assert.ok(p.snapshot().stats.completed<=1);
  });
  test('snapshot is passive and zero maxUnits still invokes bounded housekeeping',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));const before=f.calls.length;
    p.snapshot();assert.equal(f.calls.length,before);let cleaned=0;
    p.run({},grant=>{assert.equal(grant,0);cleaned++;return 0;},{maxUnits:0});
    assert.equal(cleaned,1);assert.equal(f.calls.length,before);
  });
  test('frame allowance clamps to configured budget and a function key retains identity',()=>{
    const f=fixture({budgetMs:3}),p=f.p,key=()=>{};p.beginFrame({allowanceMs:999});assert.equal(p.snapshot().remainingMs,3);
    assert.equal(p.run(key,grant=>f.work(grant)).granted,1);f.complete({gpuMs:.5});p.poll();p.beginFrame();
    assert.equal(p.run(key,grant=>f.work(grant)).granted,4);
  });
  test('poll reentry cannot submit or reset a frame within result delivery',()=>{
    const f=fixture(),p=f.p;p.beginFrame();p.run({},grant=>f.work(grant));f.complete();let calls=0;
    f.on('result',()=>{p.poll();assert.throws(()=>p.beginFrame(),/poll|active|inside/);
      const result=p.run({},()=>{calls++;return {draws:1};});assert.equal(result.granted,0);});
    assert.doesNotThrow(()=>p.poll());assert.equal(calls,0);assert.equal(p.snapshot().stats.completed,1);
  });
  test('a throwing endQuery clears active admission while retaining uncertainty',()=>{
    const f=fixture(),p=f.p;p.beginFrame();f.on('endQuery',()=>{throw Error('native end failed');});
    assert.throws(()=>p.run({},grant=>f.work(grant)),/native end failed/);
    assert.equal(p.active,false);assert.ok(p.snapshot().fault);assert.equal(p.snapshot().stats.completed,0);
    assert.equal(p.snapshot().pending,1);p.dispose();assert.equal(p.snapshot().released,false);
    assert.throws(()=>f.createBudget(),/already/);f.complete({available:false});tick();assert.equal(p.snapshot().released,true);
  });
  test('endQuery failing before native completion quarantines its owner until context loss',()=>{
    const f=fixture(),p=f.p;p.beginFrame();f.before('endQuery',()=>{throw Error('end did not execute');});
    assert.throws(()=>p.run({},grant=>f.work(grant)),/end did not execute/);
    assert.equal(p.active,false);assert.ok(p.snapshot().fault);assert.equal(p.snapshot().pending,1);
    assert.ok(f.current,'The native query still owns its scope');p.dispose();f.complete();tick();
    assert.equal(p.snapshot().released,false);assert.equal(p.snapshot().stats.completed,0);
    assert.throws(()=>f.createBudget(),/already/);f.lose();assert.equal(p.snapshot().released,true);
  });
  test('native query ownership theft fails closed without ending the external query',()=>{
    const f=fixture(),p=f.p;p.beginFrame();let external;
    p.run({},grant=>{f.work(grant);f.endExternal();external=f.external();return {draws:grant};});
    assert.equal(f.current,external);assert.ok(p.snapshot().fault);assert.equal(f.count('endQuery'),0);
    f.endExternal();f.complete();p.poll();p.beginFrame();assert.equal(p.run({},grant=>{assert.equal(grant,0);return {draws:0};}).granted,0);
  });
  test('invalid keys limits and allowances are rejected without taking another owner',()=>{
    const f=fixture(),p=f.p;assert.throws(()=>f.createBudget(),/already/);
    for(const key of [null,0,'mutable-id'])assert.throws(()=>p.run(key,()=>0),/key/);
    for(const maxUnits of [-1,.5,NaN])assert.throws(()=>p.run({},()=>0,{maxUnits}),/draw limit/);
    for(const allowanceMs of [-1,NaN,Infinity])assert.throws(()=>p.beginFrame({allowanceMs}),/allowance/);
    p.dispose();for(const config of [{budgetMs:0},{safety:.5},{maxPending:0},{sampleEvery:.5}])assert.throws(()=>f.createBudget(config),/Invalid/);
    f.createBudget().dispose();
  });
} finally {
  globalThis.setTimeout=nativeTimers.setTimeout;globalThis.clearTimeout=nativeTimers.clearTimeout;
}

const sourceChecks=[];
for(const [path,bytes] of frozen){const after=await readFile(new URL(`../${path}`,import.meta.url));sourceChecks.push({path,
  beforeSha256:sha256(bytes),afterSha256:sha256(after),bytes:bytes.length,stable:bytes.equals(after)});}
const failed=cases.filter(row=>!row.passed),stable=sourceChecks.every(row=>row.stable);
const report={passed:failed.length===0&&stable,scope:'Pure CPU actual-class admission/fence/query contracts only. No GPU hardware, elapsed performance, player path or whole-foreground-frame budget acceptance.',
  sourceChecks,cases,counts:{passed:cases.length-failed.length,failed:failed.length},forbidden:['finish','flush','getError','waitSync','clientWaitSync timeout > 0','unavailable query result']};
await writeFile(`${out}/report.json`,JSON.stringify(report,null,2));
console.log(JSON.stringify({out,passed:report.passed,counts:report.counts,failures:failed.map(row=>({name:row.name,error:row.error})),sourceStable:stable}));
if(!report.passed)process.exitCode=1;
