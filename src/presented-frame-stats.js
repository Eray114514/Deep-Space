// Count submitted player frames, not animation callbacks skipped by GPU pacing.
export class PresentedFrameStats {
  constructor({initialTime=0,window=600,paused=false}={}) {
    if(!Number.isInteger(window)||window<1)throw Error('Invalid frame statistics window');
    this.window=window;this.reset(initialTime,{paused});
  }
  reset(at=0,{paused=this.paused||false}={}) {
    if(!Number.isFinite(at))throw Error('Invalid frame statistics time');
    this.lastAt=at;this.observedAt=at;this.paused=!!paused;
    this.pausedMs=0;this.pauseStartedAt=this.paused?at:null;
    this.times=[];this.longFrames=0;
  }
  setPaused(paused,at) {
    if(!Number.isFinite(at)||at<this.observedAt)return false;
    this.observedAt=at;paused=!!paused;
    if(paused===this.paused)return true;
    if(paused)this.pauseStartedAt=at;
    else {this.pausedMs+=at-this.pauseStartedAt;this.pauseStartedAt=null;}
    this.paused=paused;return true;
  }
  // The opaque map excludes the entire current interval. If it leaves the
  // game paused, account for the remaining pause from this new origin.
  suspend(at) {
    if(!Number.isFinite(at)||at<this.observedAt)return false;
    this.lastAt=at;this.observedAt=at;this.pausedMs=0;
    this.pauseStartedAt=this.paused?at:null;return true;
  }
  present(at) {
    if(!Number.isFinite(at)||at<=this.lastAt||at<this.observedAt)return null;
    const elapsedMs=at-this.lastAt;
    const pausedMs=this.pausedMs+(this.paused?at-this.pauseStartedAt:0);
    const activeMs=Math.max(0,elapsedMs-pausedMs),recorded=!this.paused&&activeMs>0;
    this.lastAt=at;this.observedAt=at;this.pausedMs=0;
    this.pauseStartedAt=this.paused?at:null;
    if(recorded) {
      this.times.push(activeMs);if(activeMs>50)this.longFrames++;
      if(this.times.length>this.window&&this.times.shift()>50)this.longFrames--;
    }
    // Submitted cadence remains wall time, including pauses. The active sample
    // is separate so skipped RAFs cannot hide pause/resume boundaries.
    return {elapsedMs,activeMs,recorded};
  }
  snapshot() {
    const count=this.times.length;
    if(!count)return {averageFps:0,low1Fps:0,longFrames:0,longFrameRatio:0,
      performanceFrames:0,performanceWindowSeconds:0,maximumFrameMs:0};
    const sorted=[...this.times].sort((a,b)=>a-b),total=this.times.reduce((sum,value)=>sum+value,0);
    const p99=sorted[Math.min(count-1,Math.floor(count*.99))];
    return {averageFps:Math.round(10000/(total/count))/10,low1Fps:Math.round(10000/Math.max(.1,p99))/10,
      longFrames:this.longFrames,longFrameRatio:Math.round(this.longFrames/count*10000)/10000,
      performanceFrames:count,performanceWindowSeconds:Math.round(total)/1000,
      maximumFrameMs:Math.round(sorted.at(-1)*100)/100};
  }
}
