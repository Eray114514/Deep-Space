// CPU ownership contracts for the real foreground-frame pacer. These doubles
// prohibit blocking waits, timer queries and explicit GPU flushes. They make no
// claim about hardware latency, frame rate, or a hard GPU millisecond limit.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';

const files=['src/gpu-frame-pacer.js','tools/gpuframepacertest.js'];
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const frozen=new Map(await Promise.all(files.map(async path=>[path,await readFile(new URL(`../${path}`,import.meta.url))])));
const {GpuFramePacer}=await import('../src/gpu-frame-pacer.js');
const out=`test-results/gpu-frame-pacer/${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
for(const [path,bytes] of frozen)await writeFile(`${out}/${path.split('/').at(-1)}`,bytes);
const cases=[],fixtures=[],scheduled=new Map();let timerId=0;
const timers={setTimeout:globalThis.setTimeout,clearTimeout:globalThis.clearTimeout};
globalThis.setTimeout=(work,ms)=>{const id=++timerId;scheduled.set(id,{work,ms});return id;};
globalThis.clearTimeout=id=>scheduled.delete(id);
const tick=()=>{
  const batch=[...scheduled];scheduled.clear();
  for(const [,item] of batch){assert.equal(item.ms,50,'Retirement is an asynchronous 50 ms poll');item.work();}
};
function thrown(work) {
  let caught=false,result;
  try {work();} catch(error){caught=true;result=error;}
  assert.equal(caught,true,'Expected an exception');return result;
}
function fixture({create=true}={}) {
  let epoch=0,lost=false,nextId=0,nullFence=false;
  const syncs=[],calls=[],listeners=new Map(),beforeHooks=new Map(),afterHooks=new Map(),pacers=[];
  const emit=name=>{for(const listener of [...(listeners.get(name)||[])])listener();};
  const invoke=(name,work,args=[])=>{
    calls.push({name,args});
    const before=beforeHooks.get(name);if(before){beforeHooks.delete(name);before({args});}
    const value=work();
    const after=afterHooks.get(name);if(after){afterHooks.delete(name);after({args,value});}
    return value;
  };
  const valid=sync=>{
    assert.ok(sync,'A null fence must never be polled or deleted');
    assert.equal(lost,false,'Sync API entered while context was lost');
    assert.equal(sync.epoch,epoch,'Sync API entered with an old-context fence');
    assert.equal(sync.deleted,false,'Sync API entered with a deleted fence');
  };
  const forbidden=name=>()=>assert.fail(`${name} is forbidden for frame pacing`);
  const gl={SYNC_GPU_COMMANDS_COMPLETE:1,TIMEOUT_EXPIRED:2,ALREADY_SIGNALED:3,CONDITION_SATISFIED:4,WAIT_FAILED:5,
    isContextLost:()=>invoke('isContextLost',()=>lost),
    fenceSync:(condition,flags)=>invoke('fenceSync',()=>{
      assert.equal(condition,gl.SYNC_GPU_COMMANDS_COMPLETE);assert.equal(flags,0);
      if(nullFence){nullFence=false;return null;}
      const sync={id:++nextId,epoch,deleted:false,status:gl.TIMEOUT_EXPIRED};syncs.push(sync);return sync;
    },[condition,flags]),
    clientWaitSync:(sync,flags,timeout)=>{
      valid(sync);assert.equal(flags,0);assert.equal(timeout,0,'Only a zero-timeout client poll is allowed');
      return invoke('clientWaitSync',()=>sync.status,[sync,flags,timeout]);
    },
    deleteSync:sync=>{
      valid(sync);
      return invoke('deleteSync',()=>{if(!lost&&sync.epoch===epoch)sync.deleted=true;},[sync]);
    },
    getExtension:forbidden('getExtension'),getParameter:forbidden('getParameter'),
    createQuery:forbidden('createQuery'),getQuery:forbidden('getQuery'),beginQuery:forbidden('beginQuery'),
    endQuery:forbidden('endQuery'),getQueryParameter:forbidden('getQueryParameter'),deleteQuery:forbidden('deleteQuery'),
    finish:forbidden('finish'),flush:forbidden('flush'),waitSync:forbidden('waitSync'),getError:forbidden('getError')};
  const renderer={getContext:()=>invoke('getContext',()=>gl),domElement:{
    addEventListener(name,listener){return invoke(`add:${name}`,()=>{
      if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(listener);
    });},
    removeEventListener(name,listener){return invoke(`remove:${name}`,()=>listeners.get(name)?.delete(listener));}}};
  const f={gl,renderer,calls,syncs,pacers,
    count:name=>calls.filter(item=>item.name===name).length,
    get listenerCount(){return [...listeners.values()].reduce((n,set)=>n+set.size,0);},
    before(name,work){assert.equal(beforeHooks.has(name),false);beforeHooks.set(name,work);},
    after(name,work){assert.equal(afterHooks.has(name),false);afterHooks.set(name,work);},
    nullNextFence(){nullFence=true;},
    lose({notify=true}={}){lost=true;epoch++;if(notify)emit('webglcontextlost');},
    restore({notify=true}={}){lost=false;if(notify)emit('webglcontextrestored');},
    cycle(){f.lose();f.restore();},
    restoreOnly(){emit('webglcontextrestored');},
    complete(status=gl.CONDITION_SATISFIED){for(const sync of syncs)if(sync.epoch===epoch&&!sync.deleted)sync.status=status;},
    createPacer(){const p=new GpuFramePacer(renderer);pacers.push(p);return p;},
    submit(){assert.equal(f.p.beginFrame(),true);assert.equal(f.p.endFrame(),true);return syncs.at(-1);},
    cleanup(){beforeHooks.clear();afterHooks.clear();f.lose();for(const p of pacers){
      if(p.snapshot().active)p.endFrame();p.dispose();
    }}};
  fixtures.push(f);if(create)f.p=f.createPacer();return f;
}
function test(name,work) {
  const begin=fixtures.length;
  try {work();cases.push({name,passed:true});}
  catch(error){cases.push({name,passed:false,error:String(error),actual:error?.actual,expected:error?.expected,stack:error?.stack});}
  finally {for(const f of fixtures.slice(begin)){try {f.cleanup();} catch {}}scheduled.clear();}
}
try {
  test('a successful begin and end create one foreground completion fence',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);assert.equal(p.snapshot().active,true);
    assert.equal(f.count('fenceSync'),0);assert.equal(p.endFrame(),true);
    assert.deepEqual(p.snapshot().stats,{begun:1,submitted:1,skipped:0,completed:0,abandoned:0});
    assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().active,false);assert.equal(f.count('fenceSync'),1);
  });
  test('late completion blocks admission without allocating fences or forgetting work',()=>{
    const f=fixture(),p=f.p,sync=f.submit();
    for(let i=0;i<200;i++)assert.equal(p.beginFrame(),false);
    assert.equal(p.snapshot().pending,1);assert.equal(f.count('fenceSync'),1);assert.equal(f.count('deleteSync'),0);
    assert.equal(p.snapshot().stats.skipped,200);sync.status=f.gl.ALREADY_SIGNALED;
    assert.equal(p.beginFrame(),true);assert.equal(f.count('deleteSync'),1);assert.equal(sync.deleted,true);
    assert.equal(p.snapshot().stats.completed,1);p.endFrame();
  });
  test('both legal signaled statuses delete exactly once before admitting another frame',()=>{
    for(const status of [3,4]) {
      const f=fixture(),p=f.p,sync=f.submit();f.complete(status);p.poll();p.poll();
      assert.equal(sync.deleted,true);assert.equal(f.count('deleteSync'),1);assert.equal(p.snapshot().pending,0);
      assert.equal(p.snapshot().stats.completed,1);assert.equal(p.beginFrame(),true);p.endFrame();
    }
  });
  test('an active frame rejects a second begin and does not poll incomplete frame commands',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);const calls=f.calls.length;
    assert.equal(p.beginFrame(),false);p.poll();assert.equal(f.calls.length,calls);p.endFrame();
    assert.equal(p.snapshot().stats.begun,1);assert.equal(p.snapshot().stats.skipped,1);
  });
  test('end without a successful begin and a double end cannot insert fences',()=>{
    const f=fixture(),p=f.p;assert.throws(()=>p.endFrame(),/successful begin/);assert.equal(f.count('fenceSync'),0);
    f.submit();assert.throws(()=>p.endFrame(),/successful begin/);assert.equal(f.count('fenceSync'),1);
  });
  test('snapshots are detached observations and never poll or read native state',()=>{
    const f=fixture(),p=f.p;f.submit();const calls=f.calls.length,snapshot=p.snapshot();
    snapshot.stats.completed=999;snapshot.pending=0;p.snapshot();p.snapshot();
    assert.equal(f.calls.length,calls);assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().stats.completed,0);
  });
  test('poll reports healthy readiness without reserving a frame or allocating a fence',()=>{
    const f=fixture(),p=f.p;assert.equal(p.poll(),true);assert.equal(p.poll(),true);
    assert.equal(p.snapshot().active,false);assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().stats.begun,0);
    assert.equal(f.count('fenceSync'),0);assert.equal(p.beginFrame(),true);p.endFrame();assert.equal(p.poll(),false);
    f.complete();assert.equal(p.poll(),true);assert.equal(p.snapshot().stats.begun,1);assert.equal(p.snapshot().stats.completed,1);
  });
  test('active, lost, faulted and retired owners never advertise poll readiness',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);const calls=f.calls.length;
    assert.equal(p.poll(),false);assert.equal(f.calls.length,calls);p.endFrame();f.lose();assert.equal(p.poll(),false);
    f.restore();assert.equal(p.poll(),true);f.nullNextFence();p.beginFrame();p.endFrame();assert.equal(p.poll(),false);
    p.dispose();assert.equal(p.poll(),false);f.lose();assert.equal(p.snapshot().released,true);assert.equal(p.poll(),false);
  });
  test('empty readiness polling checks context state and quarantines native exceptions',()=>{
    const f=fixture(),p=f.p,error=new Error('readiness native state');
    f.before('isContextLost',()=>{throw error;});assert.equal(thrown(()=>p.poll()),error);
    assert.equal(p.snapshot().fault,'context-state-failed');assert.equal(p.poll(),false);assert.equal(p.beginFrame(),false);
    f.cycle();assert.equal(p.poll(),true);assert.equal(p.snapshot().stats.begun,0);
  });
  test('readiness never crosses a synchronous loss and restore or retirement callback',()=>{
    const f=fixture(),p=f.p;f.after('isContextLost',()=>f.cycle());assert.equal(p.poll(),false);
    assert.equal(p.poll(),true);f.after('isContextLost',()=>p.dispose());assert.equal(p.poll(),false);
    assert.equal(p.snapshot().released,true);assert.equal(p.snapshot().stats.begun,0);
  });
  test('an old-epoch native exception cannot quarantine the restored context after readiness returns',()=>{
    const f=fixture(),p=f.p,error=new Error('old epoch native state');
    f.after('isContextLost',()=>{f.cycle();throw error;});assert.equal(thrown(()=>p.poll()),error);
    assert.equal(p.snapshot().fault,null);assert.equal(p.poll(),true);assert.equal(p.beginFrame(),true);p.endFrame();
  });
  test('the full lifecycle needs no timer query, explicit flush, finish or blocking wait',()=>{
    const f=fixture(),p=f.p;f.submit();p.beginFrame();f.complete();assert.equal(p.beginFrame(),true);p.endFrame();
    p.dispose();f.complete();tick();assert.equal(p.snapshot().released,true);
    for(const call of f.calls.filter(item=>item.name==='clientWaitSync'))assert.deepEqual(call.args.slice(1),[0,0]);
  });
  test('one renderer has one owner and a clean retirement permits replacement',()=>{
    const f=fixture(),p=f.p,calls=f.calls.length;assert.throws(()=>f.createPacer(),/already/);
    assert.equal(f.calls.length,calls);p.dispose();assert.equal(p.snapshot().released,true);
    assert.equal(f.listenerCount,0);const next=f.createPacer();assert.equal(next.beginFrame(),true);next.endFrame();
  });
  test('different renderers keep independent active frames and pending completions',()=>{
    const a=fixture(),b=fixture();a.submit();b.submit();a.complete();assert.equal(a.p.beginFrame(),true);
    assert.equal(b.p.beginFrame(),false);assert.equal(b.p.snapshot().pending,1);a.p.endFrame();
  });
  test('constructor reentry cannot acquire the renderer lease before native context lookup returns',()=>{
    const f=fixture({create:false});f.after('getContext',()=>assert.throws(()=>f.createPacer(),/already/));
    f.p=f.createPacer();assert.equal(f.count('getContext'),1);assert.equal(f.listenerCount,2);
  });
  test('a native constructor failure preserves its exception and removes the reserved lease',()=>{
    const f=fixture({create:false}),error=new Error('native context lookup');f.before('isContextLost',()=>{throw error;});
    assert.equal(thrown(()=>f.createPacer()),error);assert.equal(f.listenerCount,0);
    f.p=f.createPacer();assert.equal(f.p.beginFrame(),true);f.p.endFrame();
  });
  test('partial listener registration failure removes both exact callbacks before replacement',()=>{
    const f=fixture({create:false}),error=new Error('listener registration');
    f.after('add:webglcontextrestored',()=>{throw error;});assert.equal(thrown(()=>f.createPacer()),error);
    assert.equal(f.listenerCount,0);f.p=f.createPacer();assert.equal(f.listenerCount,2);
  });
  test('dispose with no work releases immediately and later begins stay closed without native calls',()=>{
    const f=fixture(),p=f.p;p.dispose();const calls=f.calls.length;
    assert.equal(p.beginFrame(),false);p.poll();p.dispose();assert.equal(f.calls.length,calls);
    assert.equal(p.snapshot().released,true);assert.equal(scheduled.size,0);
  });
  test('dispose during an active frame keeps its lease until end and asynchronous completion',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);const calls=f.calls.length;p.dispose();
    assert.equal(f.calls.length,calls);assert.equal(scheduled.size,0);assert.equal(p.snapshot().released,false);
    assert.throws(()=>f.createPacer(),/already/);assert.equal(p.endFrame(),true);assert.equal(scheduled.size,1);
    tick();assert.equal(p.snapshot().released,false);f.complete();tick();assert.equal(p.snapshot().released,true);
    assert.equal(f.listenerCount,0);f.createPacer();
  });
  test('retirement polls at 50 ms without an inline native wait and holds late completion',()=>{
    const f=fixture(),p=f.p;f.submit();const waits=f.count('clientWaitSync');p.dispose();
    assert.equal(f.count('clientWaitSync'),waits);assert.equal(scheduled.size,1);
    for(let i=0;i<20;i++){tick();assert.equal(p.snapshot().released,false);assert.equal(scheduled.size,1);}
    f.complete();tick();assert.equal(p.snapshot().released,true);assert.equal(scheduled.size,0);
    assert.equal(f.count('deleteSync'),1);assert.equal(p.snapshot().stats.completed,1);
  });
  test('repeated dispose calls cannot duplicate retirement timers or sync deletion',()=>{
    const f=fixture(),p=f.p;f.submit();p.dispose();p.dispose();p.dispose();assert.equal(scheduled.size,1);
    f.complete();tick();p.dispose();tick();assert.equal(f.count('deleteSync'),1);assert.equal(f.listenerCount,0);
  });
  test('a null fence quarantines already submitted work until context loss',()=>{
    const f=fixture(),p=f.p;f.nullNextFence();assert.equal(p.beginFrame(),true);assert.equal(p.endFrame(),false);
    assert.equal(p.snapshot().fault,'fence-create-failed');assert.equal(p.snapshot().pending,1);
    assert.equal(p.beginFrame(),false);p.poll();p.dispose();assert.equal(scheduled.size,0);
    assert.throws(()=>f.createPacer(),/already/);f.lose();assert.equal(p.snapshot().released,true);
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(f.count('clientWaitSync'),0);
  });
  test('native fence exceptions preserve the original value and uncertain ownership',()=>{
    for(const error of [new Error('fence native error'),null,undefined,false]) {
      const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.before('fenceSync',()=>{throw error;});
      assert.equal(thrown(()=>p.endFrame()),error);assert.equal(p.snapshot().pending,1);
      assert.equal(p.snapshot().fault,'frame-finalize-failed');assert.equal(p.snapshot().active,false);
      assert.equal(p.beginFrame(),false);p.dispose();assert.equal(p.snapshot().released,false);assert.equal(scheduled.size,0);
    }
  });
  test('WAIT_FAILED preserves the ticket and does not retry an uncertain fence',()=>{
    const f=fixture(),p=f.p;f.submit();f.complete(f.gl.WAIT_FAILED);p.poll();const waits=f.count('clientWaitSync');
    p.poll();assert.equal(p.beginFrame(),false);p.dispose();tick();assert.equal(f.count('clientWaitSync'),waits);
    assert.equal(p.snapshot().fault,'fence-wait-failed');assert.equal(p.snapshot().pending,1);
    assert.equal(f.count('deleteSync'),0);assert.equal(p.snapshot().released,false);assert.equal(scheduled.size,0);
  });
  test('an unknown native wait status quarantines completion rather than opening the queue',()=>{
    for(const status of [-1,null,undefined,NaN]) {
      const f=fixture(),p=f.p,sync=f.submit();sync.status=status;p.poll();
      assert.equal(p.snapshot().fault,'fence-status-invalid');assert.equal(p.beginFrame(),false);
      assert.equal(p.snapshot().pending,1);assert.equal(f.count('deleteSync'),0);
    }
  });
  test('client wait exceptions preserve identity and prevent repeated native polling',()=>{
    const f=fixture(),p=f.p,error=new Error('native wait');f.submit();f.before('clientWaitSync',()=>{throw error;});
    assert.equal(thrown(()=>p.poll()),error);const waits=f.count('clientWaitSync');p.poll();
    assert.equal(f.count('clientWaitSync'),waits);assert.equal(p.snapshot().fault,'fence-wait-failed');
    assert.equal(p.beginFrame(),false);assert.equal(p.snapshot().pending,1);
  });
  test('delete exceptions retain ownership and never retry a possibly deleted handle',()=>{
    for(const when of ['before','after']) {
      const f=fixture(),p=f.p,error=new Error(`native delete ${when}`);f.submit();f.complete();
      f[when]('deleteSync',()=>{throw error;});assert.equal(thrown(()=>p.poll()),error);
      assert.equal(p.snapshot().fault,'fence-delete-failed');assert.equal(p.snapshot().pending,1);
      p.poll();p.dispose();tick();assert.equal(f.count('deleteSync'),1);assert.equal(p.snapshot().released,false);
      f.lose();assert.equal(p.snapshot().released,true);assert.equal(p.snapshot().stats.abandoned,1);
    }
  });
  test('a begin context-state exception admits no work and recovers only with a fresh context epoch',()=>{
    const f=fixture(),p=f.p,error=new Error('context state');f.before('isContextLost',()=>{throw error;});
    assert.equal(thrown(()=>p.beginFrame()),error);assert.equal(p.snapshot().stats.begun,0);
    assert.equal(p.snapshot().fault,'context-state-failed');assert.equal(p.beginFrame(),false);
    f.cycle();assert.equal(p.snapshot().fault,null);assert.equal(p.beginFrame(),true);p.endFrame();
  });
  test('an end context-state exception retains a ticket for foreground work already performed',()=>{
    const f=fixture(),p=f.p,error=new Error('end state');assert.equal(p.beginFrame(),true);
    f.before('isContextLost',()=>{throw error;});assert.equal(thrown(()=>p.endFrame()),error);
    assert.equal(f.count('fenceSync'),0);assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().stats.submitted,1);
    p.dispose();assert.equal(p.snapshot().released,false);f.lose();assert.equal(p.snapshot().released,true);
  });
  test('context loss observed without its event still abandons the old pending handle',()=>{
    const f=fixture(),p=f.p;f.submit();f.lose({notify:false});assert.equal(p.beginFrame(),false);
    assert.equal(p.snapshot().lost,true);assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().epoch,1);
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(f.count('clientWaitSync'),0);assert.equal(f.count('deleteSync'),0);
    f.restore();assert.equal(p.beginFrame(),true);p.endFrame();
  });
  test('loss and restoration between begin and end cannot fence the old frame in the new context',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.cycle();const calls=f.calls.length;
    assert.equal(p.endFrame(),false);assert.equal(f.calls.length,calls);assert.equal(f.count('fenceSync'),0);
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.snapshot().stats.submitted,0);
    assert.equal(p.beginFrame(),true);p.endFrame();assert.equal(f.count('fenceSync'),1);
  });
  test('loss drops old sync handles without deleting or reusing them after restoration',()=>{
    const f=fixture(),p=f.p,old=f.submit();f.cycle();assert.equal(p.snapshot().pending,0);assert.equal(old.deleted,false);
    assert.equal(f.count('deleteSync'),0);assert.equal(p.beginFrame(),true);p.endFrame();f.complete();p.poll();
    assert.equal(f.count('deleteSync'),1);assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.snapshot().stats.completed,1);
  });
  test('loss and restoration inside native fence creation never adopt its ambiguous returned handle',()=>{
    for(const when of ['before','after']) {
      const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f[when]('fenceSync',()=>f.cycle());
      assert.equal(p.endFrame(),false);assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().fault,null);
      assert.equal(p.snapshot().stats.abandoned,1);assert.equal(f.count('deleteSync'),0);
      assert.equal(p.beginFrame(),true);p.endFrame();f.complete();p.poll();assert.equal(f.count('deleteSync'),1);
    }
  });
  test('loss and restoration in end validation stop before any fence creation',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.after('isContextLost',()=>f.cycle());
    assert.equal(p.endFrame(),false);assert.equal(f.count('fenceSync'),0);assert.equal(p.snapshot().pending,0);
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.beginFrame(),true);p.endFrame();
  });
  test('loss and restoration inside native wait cannot admit from the same begin call',()=>{
    for(const when of ['before','after']) {
      const f=fixture(),p=f.p;f.submit();f.complete();f[when]('clientWaitSync',()=>f.cycle());
      assert.equal(p.beginFrame(),false);assert.equal(p.snapshot().pending,0);assert.equal(f.count('deleteSync'),0);
      assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.beginFrame(),true);p.endFrame();
    }
  });
  test('loss during native deletion abandons that epoch instead of counting it as current completion',()=>{
    for(const when of ['before','after']) {
      const f=fixture(),p=f.p;f.submit();f.complete();f[when]('deleteSync',()=>f.cycle());p.poll();
      assert.equal(p.snapshot().pending,0);assert.equal(p.snapshot().stats.completed,0);
      assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.beginFrame(),true);p.endFrame();
    }
  });
  test('disposal reentry inside fence creation keeps the renderer lease until completion',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.after('fenceSync',()=>{
      p.dispose();assert.equal(p.snapshot().released,false);assert.equal(p.snapshot().active,true);
      assert.throws(()=>f.createPacer(),/already/);assert.equal(scheduled.size,0);
    });assert.equal(p.endFrame(),true);assert.equal(scheduled.size,1);f.complete();tick();assert.equal(p.snapshot().released,true);
  });
  test('disposal reentry during wait cannot release the owner before native sync deletion returns',()=>{
    const f=fixture(),p=f.p;f.submit();f.complete();f.after('clientWaitSync',()=>p.dispose());
    f.after('deleteSync',()=>{assert.equal(p.snapshot().released,false);assert.throws(()=>f.createPacer(),/already/);});
    p.poll();assert.equal(p.snapshot().released,true);assert.equal(scheduled.size,0);f.createPacer();
  });
  test('native fence callbacks cannot recursively begin, end, or poll another submission',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.after('fenceSync',()=>{
      const calls=f.calls.length;assert.equal(p.beginFrame(),false);assert.equal(p.endFrame(),false);p.poll();
      assert.equal(f.calls.length,calls);assert.throws(()=>f.createPacer(),/already/);
    });assert.equal(p.endFrame(),true);assert.equal(f.count('fenceSync'),1);assert.equal(p.snapshot().pending,1);
  });
  test('native wait callbacks cannot recursively begin, end, or poll another frame',()=>{
    const f=fixture(),p=f.p;f.submit();f.complete();f.after('clientWaitSync',()=>{
      const calls=f.calls.length;assert.equal(p.beginFrame(),false);assert.equal(p.endFrame(),false);p.poll();
      assert.equal(f.calls.length,calls);
    });p.poll();assert.equal(p.snapshot().pending,0);assert.equal(f.count('clientWaitSync'),1);assert.equal(f.count('deleteSync'),1);
  });
  test('disposal plus a context cycle during end holds the active lease until end returns',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.after('fenceSync',()=>{
      p.dispose();f.cycle();assert.equal(p.snapshot().released,false);assert.throws(()=>f.createPacer(),/already/);
    });assert.equal(p.endFrame(),false);assert.equal(p.snapshot().released,true);assert.equal(f.count('deleteSync'),0);
    assert.equal(p.snapshot().stats.abandoned,1);f.createPacer();
  });
  test('a faulted retiring owner releases on loss and does not affect its replacement',()=>{
    const f=fixture(),p=f.p;f.nullNextFence();p.beginFrame();p.endFrame();p.dispose();f.lose();
    assert.equal(p.snapshot().released,true);const next=f.createPacer();assert.equal(next.beginFrame(),false);
    f.restore();assert.equal(next.beginFrame(),true);next.endFrame();f.complete();next.poll();
    assert.equal(next.snapshot().stats.completed,1);assert.equal(p.snapshot().stats.abandoned,1);
  });
  test('restoration without an observed loss invalidates any pending handles and old active token',()=>{
    const f=fixture(),p=f.p;f.submit();f.restoreOnly();assert.equal(p.snapshot().epoch,1);assert.equal(p.snapshot().pending,0);
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.beginFrame(),true);f.restoreOnly();
    assert.equal(p.endFrame(),false);assert.equal(p.snapshot().stats.abandoned,2);assert.equal(f.count('fenceSync'),1);
  });
  test('background drain faults retain ownership without unhandled asynchronous exceptions',()=>{
    const f=fixture(),p=f.p,error=new Error('background wait');f.submit();p.dispose();
    f.before('clientWaitSync',()=>{throw error;});tick();assert.equal(p.snapshot().fault,'fence-wait-failed');
    assert.equal(p.snapshot().released,false);assert.equal(scheduled.size,0);assert.throws(()=>f.createPacer(),/already/);
    f.lose();assert.equal(p.snapshot().released,true);
  });
  test('a throwing renderer body can still fence its submitted commands from a finally block',()=>{
    const f=fixture(),p=f.p,error=new Error('render failed');
    assert.equal(thrown(()=>{assert.equal(p.beginFrame(),true);try {throw error;} finally {p.endFrame();}}),error);
    assert.equal(p.snapshot().pending,1);assert.equal(p.snapshot().active,false);assert.equal(p.beginFrame(),false);
    f.complete();p.poll();assert.equal(p.snapshot().stats.completed,1);
  });
  test('listener removal errors cannot strand a released lease or leave the second callback registered',()=>{
    const f=fixture(),p=f.p,error=new Error('listener cleanup');f.after('remove:webglcontextlost',()=>{throw error;});
    assert.equal(thrown(()=>p.dispose()),error);assert.equal(p.snapshot().released,true);assert.equal(f.listenerCount,0);
    f.createPacer();
  });
  test('cleanup failure after a native end exception cannot replace that original exception',()=>{
    const f=fixture(),p=f.p,error=new Error('original native fence'),cleanup=new Error('cleanup');assert.equal(p.beginFrame(),true);
    f.after('fenceSync',()=>{p.dispose();f.cycle();throw error;});f.after('remove:webglcontextlost',()=>{throw cleanup;});
    assert.equal(thrown(()=>p.endFrame()),error);assert.equal(p.snapshot().released,true);assert.equal(f.listenerCount,0);
    f.createPacer();
  });
  test('repeated loss events count an active or pending frame as abandoned only once',()=>{
    const f=fixture(),p=f.p;assert.equal(p.beginFrame(),true);f.lose();f.lose();f.restore();f.lose();f.restore();
    assert.equal(p.snapshot().stats.abandoned,1);assert.equal(p.endFrame(),false);f.submit();f.lose();f.lose();
    assert.equal(p.snapshot().stats.abandoned,2);assert.equal(p.snapshot().pending,0);assert.equal(f.count('deleteSync'),0);
  });
  test('retirement during admission context validation prevents allocation of a new frame',()=>{
    const f=fixture(),p=f.p;f.after('isContextLost',()=>p.dispose());assert.equal(p.beginFrame(),false);
    assert.equal(p.snapshot().stats.begun,0);assert.equal(p.snapshot().released,true);assert.equal(f.count('fenceSync'),0);
  });
  test('retirement during a completed pending-frame poll cannot admit the next foreground frame',()=>{
    const f=fixture(),p=f.p;f.submit();f.complete();f.after('clientWaitSync',()=>p.dispose());
    assert.equal(p.beginFrame(),false);assert.equal(p.snapshot().stats.begun,1);assert.equal(p.snapshot().stats.completed,1);
    assert.equal(p.snapshot().released,true);assert.equal(f.count('fenceSync'),1);
  });
  test('a constructor context cycle is observed before the first accepted frame',()=>{
    const f=fixture({create:false});f.after('isContextLost',()=>f.cycle());f.p=f.createPacer();
    assert.equal(f.p.snapshot().epoch,1);assert.equal(f.p.snapshot().lost,false);assert.equal(f.p.beginFrame(),true);f.p.endFrame();
  });
} finally {
  globalThis.setTimeout=timers.setTimeout;globalThis.clearTimeout=timers.clearTimeout;
}
const sources=[];
for(const [path,bytes] of frozen) {
  const after=await readFile(new URL(`../${path}`,import.meta.url));
  sources.push({path,bytes:bytes.length,sha256:sha256(bytes),stable:sha256(bytes)===sha256(after)});
}
const report={kind:'cpu-contracts',scope:'foreground completion ownership; no hardware performance or hard frame deadline claim',
  passed:cases.filter(item=>item.passed).length,total:cases.length,sources,cases};
await writeFile(`${out}/report.json`,`${JSON.stringify(report,null,2)}\n`);
console.log(JSON.stringify({out,...report},null,2));
assert.equal(sources.every(item=>item.stable),true,'Frame pacer source changed during its contract run');
assert.equal(report.passed,report.total,'GPU frame pacer contracts failed');
