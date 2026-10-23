import assert from 'node:assert/strict';
import {installColumnFrameGate} from './column-frame-gate.js';
let passed=0;
const test=work=>{work();passed++;};
function fixture() {
  const calls=[],fence={};let status=3,lost=false,result={},error=null,throws=false,finalizeError=null;
  const gl={ALREADY_SIGNALED:1,CONDITION_SATISFIED:2,WAIT_FAILED:4,SYNC_GPU_COMMANDS_COMPLETE:8,
    isContextLost:()=>lost,clientWaitSync(...args){calls.push(['poll',...args]);return status;},
    fenceSync(...args){calls.push(['fence',...args]);if(finalizeError)throw finalizeError;return fence;},
    deleteSync(value){calls.push(['delete',value]);}};
  const original=function(...args){calls.push(['render',this,args]);if(throws)throw error;return result;};
  const pipeline={renderer:{getContext:()=>gl},render:original},gate=installColumnFrameGate(pipeline);
  return {pipeline,original,gl,gate,calls,fence,result,set status(value){status=value;},set lost(value){lost=value;},
    throw(value){throws=true;error=value;},set finalizeError(value){finalizeError=value;}};
}
test(()=>{const f=fixture(),receiver={};assert.equal(f.pipeline.render.call(receiver,1,2),f.result);
  assert.deepEqual(f.calls[0],['render',receiver,[1,2]]);assert.deepEqual(f.calls[1],['fence',8,0]);f.gate.restore();});
test(()=>{const f=fixture();f.pipeline.render();f.pipeline.render();f.pipeline.render();
  assert.equal(f.gate.snapshot().skipped,2);assert.equal(f.calls.filter(x=>x[0]==='render').length,1);
  assert.ok(f.calls.filter(x=>x[0]==='poll').every(x=>x[1]===f.fence&&x[2]===0&&x[3]===0));f.gate.restore();});
test(()=>{for(const status of [1,2]){const f=fixture();f.pipeline.render();f.status=status;f.pipeline.render();
  assert.equal(f.gate.snapshot().completed,1);assert.equal(f.gate.snapshot().rendered,2);assert.equal(f.gate.snapshot().peakPending,1);f.gate.restore();}});
test(()=>{const f=fixture();f.pipeline.render();f.status=4;assert.throws(()=>f.pipeline.render(),/wait failed/);
  assert.throws(()=>f.pipeline.render(),/wait failed/);assert.equal(f.gate.snapshot().rendered,1);f.gate.restore();});
test(()=>{const f=fixture();f.lost=true;assert.throws(()=>f.pipeline.render(),/context lost/);
  assert.equal(f.calls.length,0);f.gate.restore();});
test(()=>{for(const error of [new Error('render'),0,null]){const f=fixture();f.throw(error);let caught=false;
  try{f.pipeline.render();}catch(actual){caught=true;assert.equal(actual,error);}assert.ok(caught);
  assert.equal(f.gate.snapshot().pending,1);assert.equal(f.gate.snapshot().fault,String(error));f.gate.restore();}});
test(()=>{const f=fixture(),error=new Error('finalize');f.finalizeError=error;
  assert.throws(()=>f.pipeline.render(),value=>value===error);assert.equal(f.gate.snapshot().finalizeFault,String(error));f.gate.restore();});
test(()=>{const f=fixture(),error=new Error('render');f.throw(error);f.finalizeError=new Error('finalize');
  assert.throws(()=>f.pipeline.render(),value=>value===error);assert.equal(f.gate.snapshot().finalizeFault,'Error: finalize');f.gate.restore();});
test(()=>{const f=fixture();f.pipeline.render();f.gate.restore();f.gate.restore();assert.equal(f.pipeline.render,f.original);
  assert.equal(f.gate.snapshot().pending,0);assert.ok(f.gate.snapshot().restored);assert.equal(f.calls.filter(x=>x[0]==='delete').length,1);});
test(()=>{const f=fixture(),other=()=>{};f.pipeline.render=other;f.gate.restore();assert.equal(f.pipeline.render,other);
  assert.equal(f.gate.snapshot().restored,false);assert.equal(f.gate.snapshot().fault,'Frame gate restore conflict');});
console.log(JSON.stringify({passed:true,cases:passed,scope:'Diagnostic frame gate semantics; not runtime or timing acceptance.'}));
