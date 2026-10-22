// Opt-in, asynchronous WebGL phase attribution. Never flush or wait on GPU;
// bound pending queries and cooperate with external timer-query owners.
import { currentGpuDisjointEpoch, readGpuDisjointEpoch } from './gpu-query-state.js';

export class RenderProfiler {
  constructor(renderer,{every=30,maxPending=64,history=120,now=()=>performance.now()}={}) {
    this.renderer=renderer;this.gl=renderer.getContext();this.now=now;
    this.every=Math.max(1,Math.floor(every));this.maxPending=maxPending;this.history=history;
    this.frame=0;this.pending=[];this.records=[];this.skipped=0;this.discarded=0;
    this.active=false;this.polling=false;this.disposed=false;this.lost=false;this.epoch=0;
    this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.disjointEpoch=currentGpuDisjointEpoch(this.gl);
    this.onLost=()=>{this.lost=true;this.epoch++;this.sample=false;this.discarded+=this.pending.length;this.pending=[];};
    this.onRestored=()=>{
      this.epoch++;this.lost=false;
      if(!this.disposed)this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.disjointEpoch=currentGpuDisjointEpoch(this.gl);
    };
    renderer.domElement.addEventListener('webglcontextlost',this.onLost);
    renderer.domElement.addEventListener('webglcontextrestored',this.onRestored);
  }
  contextCurrent(epoch) {return epoch===this.epoch&&!this.lost&&!this.gl.isContextLost();}
  releaseQueries(items) {
    for(const item of items)if(this.contextCurrent(item.epoch))this.gl.deleteQuery(item.query);
  }
  poll() {
    const gl=this.gl,ext=this.ext,epoch=this.epoch;
    if(this.disposed||this.polling||!this.contextCurrent(epoch)||!ext)return;
    this.polling=true;
    try {
      const disjointEpoch=readGpuDisjointEpoch(gl,ext);
      if(!this.contextCurrent(epoch)||this.disposed)return;
      if(disjointEpoch!==this.disjointEpoch) {
        this.disjointEpoch=disjointEpoch;
        const pending=this.pending;this.pending=[];this.discarded+=pending.length;
        this.releaseQueries(pending);return;
      }
      const pending=this.pending;this.pending=[];
      for(let i=0;i<pending.length;i++) {
        const item=pending[i];
        if(!this.contextCurrent(epoch)||this.disposed) {
          if(!this.contextCurrent(epoch))this.discarded+=pending.length-i;
          this.releaseQueries(pending.slice(i));break;
        }
        if(item.epoch!==epoch||item.disjointEpoch!==disjointEpoch) {
          this.discarded++;this.releaseQueries([item]);continue;
        }
        const available=gl.getQueryParameter(item.query,gl.QUERY_RESULT_AVAILABLE);
        const elapsed=available&&this.contextCurrent(epoch)&&!this.disposed
          ?gl.getQueryParameter(item.query,gl.QUERY_RESULT):null;
        if(!this.contextCurrent(epoch)||this.disposed) {
          if(!this.contextCurrent(epoch))this.discarded+=pending.length-i;
          this.releaseQueries(pending.slice(i));break;
        }
        if(available) {
          // Result retrieval can expose a new native disjoint flag. A shared
          // generation alone cannot see a flag no observer has read yet.
          const checkedEpoch=readGpuDisjointEpoch(gl,ext);
          if(!this.contextCurrent(epoch)||this.disposed) {
            if(!this.contextCurrent(epoch))this.discarded+=pending.length-i;
            this.releaseQueries(pending.slice(i));break;
          }
          if(checkedEpoch!==disjointEpoch||checkedEpoch!==currentGpuDisjointEpoch(gl)) {
            this.disjointEpoch=currentGpuDisjointEpoch(gl);
            // Earlier unavailable queries were already requeued. They belong
            // to this invalid range too, together with its unvisited tail.
            const invalid=[...this.pending,...pending.slice(i)];this.pending=[];
            this.discarded+=invalid.length;this.releaseQueries(invalid);break;
          }
          item.record.gpuMs=elapsed/1e6;this.releaseQueries([item]);
        } else this.pending.push(item);
      }
    } finally {
      this.polling=false;
      if(this.disposed&&!this.active)this.detachContextListeners();
    }
  }
  beginFrame() {
    this.poll();this.frame++;
    this.sample=!this.disposed&&!this.lost&&this.frame%this.every===0;
    this.records=this.records.filter(r=>r.frame>this.frame-this.history);
  }
  run(name,work,{gpu=true}={}) {
    if(!this.sample||this.active)return work();
    const gl=this.gl,ext=this.ext,epoch=this.epoch,disjointEpoch=this.disjointEpoch;
    // CPU-only parents include their child CPU time, but never own a GPU
    // interval. Their GPU children can therefore be measured independently.
    const record={frame:this.frame,name,cpuMs:0,gpuMs:null,
      scope:gpu?'gpu':'cpu',cpuInclusive:true};this.records.push(record);
    let query=null;
    if(gpu&&ext&&this.contextCurrent(epoch)&&this.pending.length<this.maxPending
      &&!gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)) {
      query=gl.createQuery();if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    }
    if(gpu&&!query)this.skipped++;
    const started=this.now();if(gpu)this.active=true;
    try {return work();} finally {
      record.cpuMs=Math.max(0,this.now()-started);
      try {
        if(query) {
          const current=this.contextCurrent(epoch);
          if(current)gl.endQuery(ext.TIME_ELAPSED_EXT);
          // work() may synchronously stop profiling. That owner will never poll
          // again; release its just-ended query instead of reviving pending.
          // Loss/restoration can also reenter work or endQuery. Old-context
          // handles must never be ended, deleted or queued in the new epoch.
          if(!current||!this.contextCurrent(epoch))this.discarded++;
          else if(disjointEpoch!==currentGpuDisjointEpoch(gl)) {
            this.discarded++;gl.deleteQuery(query);
          } else if(this.disposed)gl.deleteQuery(query);
          else this.pending.push({query,record,epoch,disjointEpoch});
        }
      } finally {
        if(gpu)this.active=false;
        if(this.disposed&&!this.active&&!this.polling)this.detachContextListeners();
      }
    }
  }
  snapshot() {
    this.poll();return {supported:!!this.ext,every:this.every,frame:this.frame,
      pending:this.pending.length,skipped:this.skipped,discarded:this.discarded,
      records:this.records.map(r=>({...r}))};
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;this.sample=false;
    const pending=this.pending;this.pending=[];this.releaseQueries(pending);
    // A running interval still needs loss/restoration notifications until its
    // finally has handled the local query, even after its public owner retires.
    if(!this.active&&!this.polling)this.detachContextListeners();
  }
  detachContextListeners() {
    this.renderer.domElement.removeEventListener('webglcontextlost',this.onLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored',this.onRestored);
  }
}
