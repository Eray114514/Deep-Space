// Foreground frames have one completion owner per renderer. This does not
// estimate GPU time: a new frame waits for proof that the last one completed.
const owners=new WeakMap();

export class GpuFramePacer {
  constructor(renderer) {
    if(!renderer||(typeof renderer!=='object'&&typeof renderer!=='function'))throw Error('Invalid GPU frame renderer');
    if(owners.has(renderer))throw Error('Renderer already has a GPU frame pacer');
    this.renderer=renderer;this.gl=null;this.canvas=null;
    this.epoch=0;this.lost=false;this.disposed=false;this.released=false;
    this.active=null;this.pending=null;this.operating=false;this.fault=null;this.timer=null;
    this.stats={begun:0,submitted:0,skipped:0,completed:0,abandoned:0};
    this.onLost=()=>{
      if(this.released)return;
      this.lost=true;this.epoch++;
      this.abandon(this.active);this.abandon(this.pending);this.pending=null;
      this.tryRelease();
    };
    this.onRestored=()=>{
      if(this.released)return;
      // A restoration without an observed loss still invalidates old handles.
      if(!this.lost) {
        this.epoch++;this.abandon(this.active);this.abandon(this.pending);this.pending=null;
      }
      this.lost=false;this.fault=null;this.tryRelease();
    };
    // Reserve before invoking renderer/DOM methods: constructor reentry must
    // not install another owner while the first is still being initialized.
    owners.set(renderer,this);
    let listeningLost=false,listeningRestored=false;
    try {
      this.gl=renderer.getContext();this.canvas=renderer.domElement;
      if(!this.gl||!['isContextLost','fenceSync','clientWaitSync','deleteSync'].every(name=>typeof this.gl[name]==='function')
        ||!this.canvas||typeof this.canvas.addEventListener!=='function'||typeof this.canvas.removeEventListener!=='function') {
        throw Error('GPU frame pacer requires a WebGL2 renderer');
      }
      listeningLost=true;this.canvas.addEventListener('webglcontextlost',this.onLost);
      listeningRestored=true;this.canvas.addEventListener('webglcontextrestored',this.onRestored);
      this.live();
    } catch(error) {
      this.disposed=true;this.released=true;
      if(owners.get(renderer)===this)owners.delete(renderer);
      // Cleanup must preserve the original constructor/native exception.
      try {if(listeningLost)this.canvas.removeEventListener('webglcontextlost',this.onLost);} catch {}
      try {if(listeningRestored)this.canvas.removeEventListener('webglcontextrestored',this.onRestored);} catch {}
      throw error;
    }
  }
  abandon(frame) {
    if(frame&&!frame.abandoned){frame.abandoned=true;this.stats.abandoned++;}
  }
  live(epoch=this.epoch) {
    if(this.released||this.lost||epoch!==this.epoch)return false;
    const lost=this.gl.isContextLost();
    if(this.released||this.lost||epoch!==this.epoch)return false;
    if(lost){this.onLost();return false;}
    return true;
  }
  skip() {this.stats.skipped++;return false;}
  beginFrame() {
    if(this.released||this.disposed||this.operating||this.active||this.lost||this.fault)return this.skip();
    const epoch=this.epoch;let failed=false;this.operating=true;
    try {
      this.pollPending();
      if(epoch!==this.epoch||this.disposed||this.lost||this.fault||this.pending||!this.live(epoch))return this.skip();
      // Context events or native callbacks may retire the owner during live().
      if(this.disposed||this.released||this.lost||this.fault||this.pending)return this.skip();
      this.active={epoch:this.epoch,sync:null,submitted:false,abandoned:false,failed:false};
      this.stats.begun++;return true;
    } catch(error) {
      failed=true;
      if(epoch===this.epoch&&!this.lost&&!this.fault)this.fault='context-state-failed';
      if(this.pending)this.pending.failed=true;
      throw error;
    } finally {
      this.finishOperation(failed);
    }
  }
  endFrame() {
    if(this.operating)return false;
    const frame=this.active;
    if(!frame)throw Error('GPU frame end requires a successful begin');
    let failed=false;this.operating=true;
    try {
      if(frame.abandoned||frame.epoch!==this.epoch||this.lost)return false;
      // Retain a ticket before any native call, even if fence creation throws
      // or returns null after foreground commands were already submitted.
      frame.submitted=true;this.stats.submitted++;this.pending=frame;
      if(!this.live(frame.epoch))return false;
      const sync=this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE,0);
      if(frame.epoch!==this.epoch||this.lost||frame.abandoned)return false;
      frame.sync=sync;
      if(!sync){frame.failed=true;this.fault='fence-create-failed';return false;}
      return true;
    } catch(error) {
      failed=true;
      if(frame.epoch===this.epoch&&!this.lost&&!frame.abandoned) {
        frame.failed=true;this.pending=frame;this.fault='frame-finalize-failed';
      }
      throw error;
    } finally {
      if(this.active===frame)this.active=null;
      this.finishOperation(failed);
    }
  }
  pollPending() {
    const frame=this.pending;
    if(!frame||frame.failed||this.fault)return;
    let phase='context-state-failed';
    try {
      if(!this.live(frame.epoch))return;
      phase='fence-wait-failed';
      const status=this.gl.clientWaitSync(frame.sync,0,0);
      if(frame.epoch!==this.epoch||this.lost||frame.abandoned)return;
      if(status===this.gl.TIMEOUT_EXPIRED)return;
      if(status===this.gl.WAIT_FAILED){frame.failed=true;this.fault='fence-wait-failed';return;}
      if(status!==this.gl.ALREADY_SIGNALED&&status!==this.gl.CONDITION_SATISFIED) {
        frame.failed=true;this.fault='fence-status-invalid';return;
      }
      phase='context-state-failed';
      if(!this.live(frame.epoch))return;
      // Do not retry a deletion that may have executed before throwing.
      phase='fence-delete-failed';frame.failed=true;
      this.gl.deleteSync(frame.sync);
      if(frame.epoch!==this.epoch||this.lost||frame.abandoned)return;
      if(this.pending===frame){this.pending=null;this.stats.completed++;}
    } catch(error) {
      if(frame.epoch===this.epoch&&!this.lost&&!frame.abandoned) {
        frame.failed=true;this.fault=phase;
      }
      throw error;
    }
  }
  poll() {
    if(this.released||this.operating||this.active)return false;
    const epoch=this.epoch;let failed=false;this.operating=true;
    try {
      this.pollPending();
      if(epoch!==this.epoch||this.disposed||this.lost||this.fault||this.pending||!this.live(epoch))return false;
      // Readiness is observational: only beginFrame reserves the next frame.
      return epoch===this.epoch&&!this.disposed&&!this.released&&!this.lost&&!this.fault&&!this.pending;
    } catch(error) {
      failed=true;
      if(epoch===this.epoch&&!this.lost&&!this.fault)this.fault='context-state-failed';
      if(this.pending)this.pending.failed=true;
      throw error;
    }
    finally {this.finishOperation(failed);}
  }
  snapshot() {
    return {epoch:this.epoch,lost:this.lost,disposed:this.disposed,released:this.released,
      active:!!this.active,pending:Number(!!this.pending),fault:this.fault,stats:{...this.stats}};
  }
  tryRelease() {
    if(!this.disposed||this.released||this.operating||this.active||this.pending)return;
    this.released=true;
    let failed=false,error;
    const cleanup=work=>{try {work();} catch(cause){if(!failed){failed=true;error=cause;}}};
    const timer=this.timer;this.timer=null;
    if(timer!==null)cleanup(()=>clearTimeout(timer));
    cleanup(()=>this.canvas.removeEventListener('webglcontextlost',this.onLost));
    cleanup(()=>this.canvas.removeEventListener('webglcontextrestored',this.onRestored));
    if(owners.get(this.renderer)===this)owners.delete(this.renderer);
    if(failed)throw error;
  }
  finishOperation(preserveError) {
    this.operating=false;
    try {this.tryRelease();this.drainLater();}
    catch(error){if(!preserveError)throw error;}
  }
  drainLater() {
    if(!this.disposed||this.released||this.operating||this.active||this.timer!==null||!this.pending||this.pending.failed)return;
    this.timer=setTimeout(()=>{
      this.timer=null;
      try {this.poll();} catch { /* The fault keeps uncertain ownership quarantined. */ }
    },50);
  }
  dispose() {
    if(this.disposed)return;
    this.disposed=true;this.tryRelease();this.drainLater();
  }
}
