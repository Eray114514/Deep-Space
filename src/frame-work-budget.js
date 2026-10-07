// One ledger for synchronous scene generation/commit work. Reservations keep
// focused terrain progressing; actual overruns reduce subsequent grants.
export class FrameWorkBudget {
  constructor(now=()=>performance.now()) {this.now=now;this.begin(0);}
  begin(totalMs,reservations={}) {
    this.totalMs=Math.max(0,totalMs);this.spentMs=0;this.records=[];
    this.reservations={...reservations};return this;
  }
  run(name,preferredMs,work) {
    delete this.reservations[name];
    const reserved=Object.values(this.reservations).reduce((a,b)=>a+Math.max(0,b),0);
    const grantMs=Math.max(0,Math.min(preferredMs,this.totalMs-this.spentMs-reserved));
    const started=this.now();
    try {return work(grantMs);} finally {
      const elapsedMs=Math.max(0,this.now()-started);this.spentMs+=elapsedMs;
      this.records.push({name,grantMs,elapsedMs,overrunMs:Math.max(0,elapsedMs-grantMs)});
    }
  }
  snapshot() {return {totalMs:this.totalMs,spentMs:this.spentMs,
    overrunMs:Math.max(0,this.spentMs-this.totalMs),records:this.records.map(r=>({...r}))};}
}
