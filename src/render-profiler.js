// Opt-in, asynchronous WebGL phase attribution. Never flush or wait on GPU;
// bound pending queries and cooperate with external timer-query owners.
export class RenderProfiler {
  constructor(renderer,{every=30,maxPending=64,history=120,now=()=>performance.now()}={}) {
    this.renderer=renderer;this.gl=renderer.getContext();this.now=now;
    this.every=Math.max(1,Math.floor(every));this.maxPending=maxPending;this.history=history;
    this.frame=0;this.pending=[];this.records=[];this.skipped=0;this.discarded=0;
    this.active=false;this.disposed=false;this.lost=false;
    this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.onLost=()=>{this.lost=true;this.discarded+=this.pending.length;this.pending=[];};
    this.onRestored=()=>{this.lost=false;this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');};
    renderer.domElement.addEventListener('webglcontextlost',this.onLost);
    renderer.domElement.addEventListener('webglcontextrestored',this.onRestored);
  }
  poll() {
    const gl=this.gl,ext=this.ext;
    if(this.lost||gl.isContextLost()||!ext)return;
    if(gl.getParameter(ext.GPU_DISJOINT_EXT)) {
      for(const item of this.pending)gl.deleteQuery(item.query);
      this.discarded+=this.pending.length;this.pending=[];return;
    }
    this.pending=this.pending.filter(item=>{
      if(!gl.getQueryParameter(item.query,gl.QUERY_RESULT_AVAILABLE))return true;
      item.record.gpuMs=gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6;
      gl.deleteQuery(item.query);return false;
    });
  }
  beginFrame() {
    this.poll();this.frame++;
    this.sample=!this.disposed&&!this.lost&&this.frame%this.every===0;
    this.records=this.records.filter(r=>r.frame>this.frame-this.history);
  }
  run(name,work,{gpu=true}={}) {
    if(!this.sample||this.active)return work();
    const gl=this.gl,ext=this.ext;
    // CPU-only parents include their child CPU time, but never own a GPU
    // interval. Their GPU children can therefore be measured independently.
    const record={frame:this.frame,name,cpuMs:0,gpuMs:null,
      scope:gpu?'gpu':'cpu',cpuInclusive:true};this.records.push(record);
    let query=null;
    if(gpu&&ext&&!gl.isContextLost()&&this.pending.length<this.maxPending
      &&!gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)) {
      query=gl.createQuery();if(query)gl.beginQuery(ext.TIME_ELAPSED_EXT,query);
    }
    if(gpu&&!query)this.skipped++;
    const started=this.now();if(gpu)this.active=true;
    try {return work();} finally {
      record.cpuMs=Math.max(0,this.now()-started);if(gpu)this.active=false;
      if(query&&!gl.isContextLost()) {
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        // work() may synchronously stop profiling. That owner will never poll
        // again; release its just-ended query instead of reviving pending.
        if(this.disposed) {if(!gl.isContextLost())gl.deleteQuery(query);}
        else this.pending.push({query,record});
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
    if(!this.gl.isContextLost())for(const item of this.pending)this.gl.deleteQuery(item.query);
    this.pending=[];
    this.renderer.domElement.removeEventListener('webglcontextlost',this.onLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored',this.onRestored);
  }
}
