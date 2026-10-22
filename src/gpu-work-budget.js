import {currentGpuDisjointEpoch,readGpuDisjointEpoch} from './gpu-query-state.js';

// One admission owner per renderer. Retirement keeps the lease until submitted
// work completes, including when a bank/job is cancelled before its fence.
const owners=new WeakMap();

export class GpuWorkBudget {
  constructor(renderer,{budgetMs=4,initialUnitMs=2,maxUnits=8,maxPending=2,
    maxInFlightMs=budgetMs*2,sampleEvery=8,safety=1.5,maxSampleAge=120,history=64}={}) {
    if(owners.has(renderer))throw Error('Renderer already has a GPU work budget');
    if(![budgetMs,initialUnitMs,maxInFlightMs,safety].every(x=>Number.isFinite(x)&&x>0)
      ||safety<1||![maxUnits,maxPending,sampleEvery,maxSampleAge,history].every(x=>Number.isInteger(x)&&x>0))throw Error('Invalid GPU work budget');
    this.renderer=renderer;this.gl=renderer.getContext();
    Object.assign(this,{budgetMs,initialUnitMs,maxUnits,maxPending,maxInFlightMs,sampleEvery,safety,maxSampleAge,history});
    this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.disjointEpoch=readGpuDisjointEpoch(this.gl,this.ext);
    this.epoch=0;this.lost=this.gl.isContextLost();this.disposed=false;this.released=false;
    this.active=false;this.polling=false;this.frame=0;this.remainingMs=0;this.frameUnits=0;
    this.pending=[];this.estimates=new WeakMap();this.records=[];this.fault=null;this.timer=null;
    this.stats={submitted:0,completed:0,peakPending:0,observed:0,skippedTimers:0,discarded:0,abandoned:0};
    this.onLost=()=>{
      if(this.released)return;
      this.lost=true;this.epoch++;this.stats.abandoned+=this.pending.length;
      this.pending=[];this.estimates=new WeakMap();this.remainingMs=0;
      this.tryRelease();
    };
    this.onRestored=()=>{
      if(this.released)return;
      this.lost=false;this.fault=null;this.ext=this.gl.getExtension('EXT_disjoint_timer_query_webgl2');
      this.disjointEpoch=readGpuDisjointEpoch(this.gl,this.ext);this.estimates=new WeakMap();
    };
    renderer.domElement.addEventListener('webglcontextlost',this.onLost);
    renderer.domElement.addEventListener('webglcontextrestored',this.onRestored);
    owners.set(renderer,this);
  }
  live(epoch=this.epoch) {return epoch===this.epoch&&!this.lost&&!this.gl.isContextLost();}
  beginFrame({allowanceMs=this.budgetMs}={}) {
    if(this.active||this.polling)throw Error('Cannot begin GPU work frame inside a submission or poll');
    if(!Number.isFinite(allowanceMs)||allowanceMs<0)throw Error('Invalid GPU work allowance');
    this.poll();this.frame++;this.frameUnits=0;
    this.remainingMs=this.disposed?0:Math.min(this.budgetMs,allowanceMs);
  }
  poll() {
    if(this.polling||this.released)return;
    this.polling=true;
    try {this.pollPending();} catch(error) {
      this.fault='poll-failed';for(const item of this.pending)item.failed=true;throw error;
    } finally {
      this.polling=false;this.tryRelease();if(this.disposed)this.drainLater();
    }
  }
  pollPending() {
    if(this.fault==='poll-failed')return;
    if(!this.live()){this.tryRelease();return;}
    const gl=this.gl,epoch=this.epoch,disjoint=readGpuDisjointEpoch(gl,this.ext);
    if(!this.live(epoch))return;
    if(disjoint!==this.disjointEpoch) {
      this.disjointEpoch=disjoint;this.estimates=new WeakMap();
      for(const item of this.pending)if(item.query) {
        gl.deleteQuery(item.query);item.query=null;this.stats.discarded++;
        if(!this.live(epoch))return;
      }
    }
    // Snapshot iteration: context/dispose events must not reinsert old tickets.
    for(const item of [...this.pending]) {
      if(!this.live(epoch))return;
      if(item.failed)continue;
      const status=gl.clientWaitSync(item.sync,0,0);
      if(!this.live(epoch))return;
      if(status===gl.WAIT_FAILED) {item.failed=true;this.fault='fence-wait-failed';continue;}
      if(status!==gl.ALREADY_SIGNALED&&status!==gl.CONDITION_SATISFIED)continue;
      if(item.query&&!this.disposed&&!item.record.failed&&item.disjointEpoch===this.disjointEpoch) {
        if(!gl.getQueryParameter(item.query,gl.QUERY_RESULT_AVAILABLE))continue;
        if(!this.live(epoch))return;
        const gpuMs=gl.getQueryParameter(item.query,gl.QUERY_RESULT)/1e6;
        if(!this.live(epoch))return;
        const measuredEpoch=readGpuDisjointEpoch(gl,this.ext);
        if(!this.live(epoch))return;
        if(measuredEpoch!==this.disjointEpoch){this.disjointEpoch=measuredEpoch;this.estimates=new WeakMap();}
        if(!this.disposed&&measuredEpoch===item.disjointEpoch&&Number.isFinite(gpuMs)&&gpuMs>0) {
          const previous=this.estimates.get(item.key);
          const unitMs=gpuMs/Math.max(1,item.units)*this.safety;
          this.estimates.set(item.key,{unitMs:Math.max(unitMs,(previous?.unitMs||0)*.98),frame:this.frame});
          item.record.gpuMs=gpuMs;this.stats.observed++;
        } else this.stats.discarded++;
      }
      if(item.query)gl.deleteQuery(item.query);
      if(!this.live(epoch))return;
      gl.deleteSync(item.sync);
      if(!this.live(epoch))return;
      const index=this.pending.indexOf(item);if(index!==-1)this.pending.splice(index,1);
      item.record.completedFrame=this.frame;this.stats.completed++;
    }
    this.tryRelease();
  }
  run(key,work,{maxUnits=this.maxUnits}={}) {
    if(!key||(typeof key!=='object'&&typeof key!=='function'))throw Error('GPU work key must have stable object identity');
    if(!Number.isInteger(maxUnits)||maxUnits<0)throw Error('Invalid GPU work draw limit');
    if(this.active||this.polling)return {granted:0,units:0,reason:'reentrant'};
    if(currentGpuDisjointEpoch(this.gl)!==this.disjointEpoch)this.estimates=new WeakMap();
    const estimate=this.estimates.get(key),fresh=estimate&&this.frame-estimate.frame<=this.maxSampleAge;
    const unitMs=fresh?estimate.unitMs:this.initialUnitMs;
    const credit=Math.max(0,this.maxInFlightMs-this.pending.reduce((sum,item)=>sum+item.estimatedMs,0));
    let grant=Math.min(maxUnits,this.maxUnits-this.frameUnits,Math.floor(Math.min(this.remainingMs,credit)/Math.max(unitMs,.000001)));
    if(!fresh)grant=Math.min(1,grant); // One calibration draw, never an unknown large batch.
    let reason='admitted';
    if(this.disposed||!this.live()) {grant=0;reason=this.disposed?'disposed':'context-lost';}
    else if(this.fault){grant=0;reason=this.fault;}
    else if(this.pending.length>=this.maxPending){grant=0;reason='in-flight-limit';}
    else if(!grant)reason='allowance';
    if(!grant) {
      this.active=true;let quarantined=false;
      try {
        const value=work(0),units=value?.draws??value??0;
        if(units!==0) {
          this.fault='draw-grant-violation';
          this.quarantineZero(key,units);quarantined=true;
          throw Error('GPU work exceeded its draw grant');
        }
        return {granted:0,units:0,reason,value};
      } catch(error) {
        if(!quarantined){this.fault='zero-work-failed';this.quarantineZero(key,null);}throw error;
      } finally {this.active=false;this.tryRelease();if(this.disposed)this.drainLater();}
    }
    const gl=this.gl,ext=this.ext,epoch=this.epoch,estimatedMs=grant*unitMs;
    this.remainingMs-=estimatedMs;this.frameUnits+=grant;this.active=true;
    let query=null,began=false,value,units=grant,failed=true;
    const record={frame:this.frame,granted:grant,units:null,estimatedMs,gpuMs:null,completedFrame:null};
    const disjointEpoch=currentGpuDisjointEpoch(gl);
    try {
      if(ext&&(!fresh||this.frame%this.sampleEvery===0)
        &&!gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY)&&this.live(epoch)&&!this.disposed) {
        query=gl.createQuery();
        if(query&&this.live(epoch)&&!this.disposed){gl.beginQuery(ext.TIME_ELAPSED_EXT,query);began=true;}
      }
      if(!query)this.stats.skippedTimers++;
      if(!this.live(epoch)||this.disposed) {
        units=0;failed=false;return {granted:grant,units:0,reason:this.disposed?'disposed':'context-lost'};
      }
      value=work(grant);units=value?.draws??value??0;
      if(!Number.isInteger(units)||units<0||units>grant)throw Error('GPU work exceeded its draw grant');
      failed=false;return {granted:grant,units,reason,value};
    } finally {
      record.units=units;record.failed=failed;
      let enqueued=false;
      try {
        if(query&&this.live(epoch)) {
          if(began) {
            const current=gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY);
            if(this.live(epoch)) {
              if(current===query)gl.endQuery(ext.TIME_ELAPSED_EXT);
              else {this.fault='timer-owner-changed';record.failed=true;}
            }
          } else {gl.deleteQuery(query);query=null;}
        }
        if(this.live(epoch)) {
          if(units||failed) {
            const sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);
            if(this.live(epoch)) {
              const item={sync,query,key,units,estimatedMs,record,disjointEpoch,failed:!sync};
              if(!sync)this.fault='fence-create-failed';
              this.pending.push(item);this.stats.submitted++;
              enqueued=true;
              this.stats.peakPending=Math.max(this.stats.peakPending,this.pending.length);
            }
          } else {
            if(query)gl.deleteQuery(query);
            if(!this.disposed)this.remainingMs+=estimatedMs;this.frameUnits-=grant;
          }
        }
      } catch(error) {
        record.failed=true;this.fault='submission-finalize-failed';
        // If completion/ownership cannot be established, keep a failed ticket
        // until context loss. Never forget uncertain submitted work to reopen
        // admission. A successfully ended timer can use a normal drain fence.
        if(this.live(epoch)&&!enqueued) {
          let sync=null,uncertain=true;
          try {
            const current=ext?gl.getQuery(ext.TIME_ELAPSED_EXT,gl.CURRENT_QUERY):null;
            if(this.live(epoch)&&(!query||current!==query)) {
              if(query)gl.deleteQuery(query);
              if(this.live(epoch)){sync=gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE,0);uncertain=!sync;}
            }
          } catch { /* Fault and ownership lease remain until a new context. */ }
          if(this.live(epoch)) {
            this.pending.push({sync,query:null,key,units,estimatedMs,record,disjointEpoch,failed:uncertain});
            this.stats.submitted++;this.stats.peakPending=Math.max(this.stats.peakPending,this.pending.length);
          }
        }
        throw error;
      } finally {
        this.records.push(record);if(this.records.length>this.history)this.records.shift();
        this.active=false;this.tryRelease();if(this.disposed)this.drainLater();
      }
    }
  }
  snapshot() {
    return {frame:this.frame,budgetMs:this.budgetMs,remainingMs:this.remainingMs,frameUnits:this.frameUnits,
      pending:this.pending.length,inFlightEstimatedMs:this.pending.reduce((sum,item)=>sum+item.estimatedMs,0),
      timerSupported:!!this.ext,epoch:this.epoch,lost:this.lost,disposed:this.disposed,released:this.released,
      fault:this.fault,stats:{...this.stats},records:this.records.map(record=>({...record}))};
  }
  quarantineZero(key,units) {
    const epoch=this.epoch;if(this.released||!this.live(epoch))return;
    let sync=null;try {sync=this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE,0);} catch { /* Unknown completion. */ }
    if(!this.live(epoch))return;
    const record={frame:this.frame,granted:0,units,estimatedMs:0,gpuMs:null,failed:true,completedFrame:null};
    this.pending.push({sync,query:null,key,units,estimatedMs:0,record,failed:!sync});
    this.stats.submitted++;this.stats.peakPending=Math.max(this.stats.peakPending,this.pending.length);
    this.records.push(record);if(this.records.length>this.history)this.records.shift();
  }
  tryRelease() {
    if(!this.disposed||this.active||this.polling||this.pending.length||this.released)return;
    this.released=true;if(this.timer!==null)clearTimeout(this.timer);this.timer=null;
    this.renderer.domElement.removeEventListener('webglcontextlost',this.onLost);
    this.renderer.domElement.removeEventListener('webglcontextrestored',this.onRestored);
    if(owners.get(this.renderer)===this)owners.delete(this.renderer);
  }
  drainLater() {
    if(this.released||this.active||this.timer!==null||!this.pending.some(item=>!item.failed))return;
    this.timer=setTimeout(()=>{
      this.timer=null;
      try {this.poll();} catch { /* poll records the fault and quarantines ownership. */ }
      this.drainLater();
    },50);
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;this.remainingMs=0;
    if(!this.active)this.poll();this.tryRelease();this.drainLater();
  }
}
