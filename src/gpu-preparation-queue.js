// A preparation owns only its synchronous submission/restore scope. Its result
// may be asynchronous program readiness; neither that promise nor cancellation
// releases the renderer's GPU completion owner.
const problem=(code,message)=>Object.assign(new Error(message),{code});

export class GpuPreparationQueue {
  constructor(renderer,{submit,schedule=work=>requestAnimationFrame(work),cancel=handle=>cancelAnimationFrame(handle),maxPending=64}={}) {
    const canvas=renderer?.domElement;
    if(!canvas||typeof canvas.addEventListener!=='function'||typeof canvas.removeEventListener!=='function'
      ||typeof submit!=='function'||typeof schedule!=='function'||typeof cancel!=='function')throw new TypeError('Invalid GPU preparation driver');
    if(!Number.isInteger(maxPending)||maxPending<1)throw new RangeError('Invalid GPU preparation capacity');
    this.canvas=canvas;this.submit=submit;this.schedule=schedule;this.cancel=cancel;this.maxPending=maxPending;
    this.queue=[];this.pending=new Set();this.active=null;this.running=false;this.checking=0;this.scheduled=null;
    this.epoch=0;this.lost=false;this.disposed=false;this.fault=null;this.foreground=0;this.observedForeground=0;
    this.stats={enqueued:0,executed:0,resolved:0,rejected:0,cancelled:0,obsolete:0,overflow:0,pumps:0,yielded:0,busy:0};
    this.onLost=()=>{
      if(this.disposed)return;
      this.lost=true;this.epoch++;this.rejectAll(problem('context-lost','GPU preparation context lost'),'cancelled');
    };
    this.onRestored=()=>{
      if(this.disposed)return;
      if(!this.lost){this.epoch++;this.rejectAll(problem('context-restored','GPU preparation context changed'),'cancelled');}
      this.lost=false;this.fault=null;
    };
    let listeningLost=false,listeningRestored=false;
    try {
      listeningLost=true;canvas.addEventListener('webglcontextlost',this.onLost);
      listeningRestored=true;canvas.addEventListener('webglcontextrestored',this.onRestored);
    } catch(error) {
      this.disposed=true;
      try {if(listeningLost)canvas.removeEventListener('webglcontextlost',this.onLost);} catch {}
      try {if(listeningRestored)canvas.removeEventListener('webglcontextrestored',this.onRestored);} catch {}
      throw error;
    }
  }

  get hasQueued() {return this.queue.length>0;}
  noteForeground() {this.foreground++;}

  enqueue(work,{signal,isCurrent,label='preparation'}={}) {
    if(typeof work!=='function'||(isCurrent!==undefined&&typeof isCurrent!=='function')
      ||(signal&&(!signal.addEventListener||!signal.removeEventListener)))return Promise.reject(new TypeError('Invalid GPU preparation job'));
    if(this.disposed)return Promise.reject(problem('disposed','GPU preparation queue disposed'));
    if(this.lost)return Promise.reject(problem('context-lost','GPU preparation context lost'));
    if(this.pending.size>=this.maxPending){this.stats.overflow++;return Promise.reject(problem('capacity','GPU preparation queue capacity exceeded'));}
    return new Promise((resolve,reject)=>{
      const job={work,signal,isCurrent,label,resolve,reject,epoch:this.epoch,done:false,finished:false,resultReady:false,
        resultFailed:false,result:undefined,workFailed:false,abort:null,listening:false};
      this.pending.add(job);this.queue.push(job);this.stats.enqueued++;
      job.abort=()=>this.rejectJob(job,problem('aborted','GPU preparation cancelled'),'cancelled');
      try {
        if(signal){job.listening=true;signal.addEventListener('abort',job.abort);}
        if(this.validate(job))this.ensurePump();
      } catch(error) {this.rejectJob(job,error);}
    });
  }

  validate(job) {
    if(job.done)return false;
    const current=()=>!this.disposed&&!this.lost&&job.epoch===this.epoch;
    this.checking++;
    try {
      if(!current()){this.rejectJob(job,problem(this.disposed?'disposed':'context-lost','GPU preparation owner changed'),'cancelled');return false;}
      if(job.signal?.aborted){job.abort();return false;}
      if(job.isCurrent) {
        const valid=job.isCurrent();
        if(typeof valid!=='boolean')throw new TypeError('GPU preparation validity must be boolean');
        if(!valid){this.rejectJob(job,problem('obsolete','GPU preparation source changed'),'obsolete');return false;}
      }
      // Predicates and signal access may synchronously cancel/retire the queue.
      if(job.done)return false;
      if(!current()){this.rejectJob(job,problem(this.disposed?'disposed':'context-lost','GPU preparation owner changed'),'cancelled');return false;}
      if(job.signal?.aborted){job.abort();return false;}
      return !job.done;
    } catch(error) {this.rejectJob(job,error);return false;}
    finally {this.checking--;}
  }

  runNext(draw) {
    if(this.active||this.running||this.checking||this.disposed||this.lost)return null;
    this.running=true;
    try {
      // Predicates may enqueue work too. Only the bounded original FIFO is
      // eligible here; new jobs cannot recursively extend this submission.
      const eligible=new Set(this.queue);
      while(this.queue.length&&eligible.has(this.queue[0])) {
        const job=this.queue.shift();
        if(!this.validate(job))continue;
        this.active=job;this.stats.executed++;
        const work=job.work;job.work=null;
        try {
          const result=work(draw);
          // Attach both outcomes immediately, even if work cancelled this job.
          // A late rejection is consumed, but cannot publish an obsolete result.
          Promise.resolve(result).then(value=>this.ready(job,false,value),error=>this.ready(job,true,error));
        } catch(error) {
          if(!job.done){job.workFailed=true;job.resultReady=true;job.resultFailed=true;job.result=error;}
        }
        return job;
      }
      if(!this.hasQueued)this.cancelPump();return null;
    } finally {
      this.running=false;
    }
  }

  ready(job,failed,value) {
    if(job.done)return;
    job.resultReady=true;job.resultFailed=failed;job.result=value;
    this.complete(job);
  }

  finish(ticket,{failed=false,error}={}) {
    // A foreign or repeated ticket cannot end the current submission scope.
    if(!ticket||this.active!==ticket)return;
    this.active=null;ticket.finished=true;
    if(!ticket.done) {
      if(failed&&!ticket.workFailed)this.rejectJob(ticket,error);
      else if(ticket.workFailed||(ticket.resultReady&&ticket.resultFailed))this.complete(ticket);
      // A synchronous submit callback may have switched the world without
      // aborting its compiler. Reject that obsolete lease now, even while
      // readiness is pending, rather than retaining it until the deadline.
      else if(this.validate(ticket))this.complete(ticket);
    }
    this.ensurePump();
  }

  complete(job) {
    if(job.done||!job.finished||!job.resultReady)return;
    if(job.resultFailed)this.rejectJob(job,job.result);
    else if(this.validate(job))this.settle(job,true,job.result);
  }

  rejectJob(job,error,kind=null) {
    if(job.done)return;
    if(kind==='cancelled')this.stats.cancelled++;
    if(kind==='obsolete')this.stats.obsolete++;
    this.settle(job,false,error);
  }

  settle(job,success,value) {
    if(job.done)return;
    job.done=true;this.pending.delete(job);
    const queued=this.queue.indexOf(job);if(queued>=0)this.queue.splice(queued,1);
    const resolve=job.resolve,reject=job.reject;
    try {if(job.listening)job.signal.removeEventListener('abort',job.abort);}
    catch {this.fault||='listener-cleanup-failed';}
    job.work=null;job.signal=null;job.isCurrent=null;job.abort=null;job.resolve=null;job.reject=null;job.result=undefined;
    if(success){this.stats.resolved++;resolve(value);}else {this.stats.rejected++;reject(value);}
    if(!this.hasQueued)this.cancelPump();
  }

  rejectAll(error,kind=null) {
    this.cancelPump();for(const job of [...this.pending])this.rejectJob(job,error,kind);
  }

  fail(error) {
    this.fault='submission-failed';
    this.rejectAll(arguments.length?error:problem('submission-failed','GPU preparation submission failed'));
  }

  ensurePump() {
    if(this.scheduled||!this.hasQueued||this.disposed||this.lost)return;
    const token={handle:null,assigned:false};this.scheduled=token;
    let scheduling=true,synchronous=false;
    try {
      const handle=this.schedule(()=>{
        if(scheduling){synchronous=true;return;}
        if(this.scheduled!==token)return;
        this.scheduled=null;this.pump();
      });
      scheduling=false;token.handle=handle;token.assigned=true;
      if(synchronous)throw problem('scheduler-synchronous','GPU preparation scheduler must yield');
      if(this.scheduled!==token)try {this.cancel(handle);} catch {this.fault||='scheduler-cancel-failed';}
    } catch(error) {
      scheduling=false;if(this.scheduled===token)this.scheduled=null;
      this.fault='scheduler-failed';this.rejectAll(error);
    }
  }

  cancelPump() {
    const token=this.scheduled;this.scheduled=null;
    if(token?.assigned)try {this.cancel(token.handle);} catch {this.fault||='scheduler-cancel-failed';}
  }

  pump() {
    if(!this.hasQueued||this.disposed||this.lost)return;
    if(this.foreground!==this.observedForeground) {
      this.observedForeground=this.foreground;this.stats.yielded++;this.ensurePump();return;
    }
    if(this.active||this.running){this.ensurePump();return;}
    this.stats.pumps++;
    try {if(this.submit()===false)this.stats.busy++;}
    catch(error){this.fail(error);}
    this.ensurePump();
  }

  snapshot() {
    return {epoch:this.epoch,lost:this.lost,disposed:this.disposed,fault:this.fault,queued:this.queue.length,
      pending:this.pending.size,active:!!this.active,waiting:[...this.pending].filter(job=>job.work===null&&!job.done).length,
      scheduled:!!this.scheduled,maxPending:this.maxPending,stats:{...this.stats}};
  }

  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.epoch++;this.rejectAll(problem('disposed','GPU preparation queue disposed'),'cancelled');
    try {this.canvas.removeEventListener('webglcontextlost',this.onLost);} catch {this.fault||='listener-cleanup-failed';}
    try {this.canvas.removeEventListener('webglcontextrestored',this.onRestored);} catch {this.fault||='listener-cleanup-failed';}
  }
}
