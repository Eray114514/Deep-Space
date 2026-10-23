// Diagnostic control: one completed foreground frame before another is queued.
// This changes submission pacing and is never a passive observer or runtime policy.
export function installColumnFrameGate(pipeline) {
  const renderer=pipeline.renderer,gl=renderer.getContext(),original=pipeline.render;
  const data={calls:0,rendered:0,skipped:0,polls:0,completed:0,peakPending:0,fault:null,finalizeFault:null,restored:false};
  let sync=null,active=false,stopped=false;
  const wrapper=function(...args) {
    if(stopped)return original.apply(this,args);
    data.calls++;
    if(active)throw Error('Frame gate reentrancy');
    if(data.fault)throw Error(data.fault);
    active=true;
    try {
      if(gl.isContextLost())throw Error('Frame gate context lost');
      if(sync) {
        data.polls++;const status=gl.clientWaitSync(sync,0,0);
        if(status===gl.WAIT_FAILED)throw Error('Frame gate wait failed');
        if(status!==gl.ALREADY_SIGNALED&&status!==gl.CONDITION_SATISFIED){data.skipped++;return;}
        gl.deleteSync(sync);sync=null;data.completed++;
      }
      let result,failed=false;
      try {result=original.apply(this,args);data.rendered++;}
      catch(error) {failed=true;throw error;}
      finally {
        try {
          if(!gl.isContextLost()) {
            sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
            if(!sync)throw Error('Frame gate fence creation failed');
            data.peakPending=1;
          }
        } catch(error) {data.finalizeFault=String(error);if(!failed)throw error;}
      }
      return result;
    } catch(error) {data.fault=String(error);throw error;}
    finally {active=false;}
  };
  pipeline.render=wrapper;
  return {
    snapshot:()=>({...data,pending:Number(Boolean(sync))}),
    restore() {
      if(stopped)return;stopped=true;
      if(pipeline.render===wrapper){pipeline.render=original;data.restored=true;}
      else data.fault='Frame gate restore conflict';
      if(sync&&!gl.isContextLost())gl.deleteSync(sync);sync=null;
    },
  };
}
