import { CloudColumnMap } from './cloud-column-map.js';
import { CloudColumnScratch, CloudColumnTileMap } from './cloud-column-tile-map.js';
import { weatherSourcesCurrent } from './weather-sources.js';

export function setCloudFarCacheEnabled(planet,enabled) {
  const material=planet?.volCloudFarMat;
  if(!material)return;
  const value=Number(Boolean(enabled));
  material.defines ||= {};
  if(material.defines.CLOUD_FAR_CACHE!==value) {
    material.defines.CLOUD_FAR_CACHE=value;material.needsUpdate=true;
  }
}

// Two immutable sampling endpoints and one forecast under construction. A
// partially baked target is never sampled, including after a clock jump.
export class CloudColumnBank {
  constructor(planet,{width=1024,rows=2,footprintSamples=64,producer='rows',
    tileRows=2,footprintBatch=8,workQuanta=1,deadlineAware=false}={}) {
    if(!['rows','tile'].includes(producer)||!Number.isInteger(workQuanta)||workQuanta<0)throw Error('Invalid column producer');
    this.planet=planet;this.maps=new Map();this.disposed=false;this.updating=false;this.retiring=false;
    this.width=width;this.rows=rows;this.footprintSamples=footprintSamples;
    // Explicit opt-in until dynamic deadlines and the whole-frame GPU budget
    // are accepted. Default routing and row submissions stay unchanged.
    this.producer=producer;this.tileRows=tileRows;this.footprintBatch=footprintBatch;this.workQuanta=workQuanta;
    this.deadlineAware=deadlineAware&&producer==='tile';this.service=null;this.deferFirst=false;
    this.scratch=producer==='tile'?new CloudColumnScratch(width,tileRows):null;
    this.scratchEpoch=this.scratch?.epoch;
    this.programs={};
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
  }
  // Read-only production plan: absolute forecast identity and first use are
  // separate from retirement. No snapshot allocation or GPU submission here.
  plan() {
    const p=this.planet,stream=p.weatherStream,anchor=stream?.anchor,step=stream?.frameHours;
    const hours=[anchor,anchor+step,anchor+2*step].filter(Number.isFinite);
    return {anchor,frameHours:step,weatherHours:p.weatherHours,producer:this.producer,
      deadlineAware:this.deadlineAware,deferFirst:this.deferFirst,serviceRate:this.service?.rate??null,
      pair:hours.slice(0,2),jobs:hours.map(hour=>{
        const revision=stream.revisionAt(hour),map=this.maps.get(hour);
        const current=this.fieldOwner===p.weatherField&&this.speciesMask===p.volCloudMat.uniforms.uSpeciesMask.value
          &&!map?.invalidated&&weatherSourcesCurrent(map?.weatherSources,stream);
        const ready=Boolean(current&&map.ready),row=current?map.row:0,cursor=current?(map.footprintCursor||0):0;
        const remainingDraws=ready?0:this.producer==='tile'
          ?Math.ceil((this.width/2-row)/this.tileRows)*Math.ceil(this.footprintSamples/this.footprintBatch)-Math.floor(cursor/this.footprintBatch)
          :Math.ceil((this.width/2-row)/this.rows);
        return {hours:hour,revision,available:revision!==null,ready,row,footprintCursor:cursor,
          firstNeededHours:hour-step,retiresAtHours:hour+step,remainingDraws};
      })};
  }
  observeService(stream) {
    if(!this.deadlineAware)return;
    const hours=this.planet.weatherHours,last=this.service,delta=hours-last?.hours;
    if(!last||last.stream!==stream||!Number.isFinite(delta)||delta<0||delta>stream.frameHours*3) {
      this.service={stream,hours,lastDraws:0,rate:0,samples:0};return;
    }
    if(delta>0) {
      const rate=last.lastDraws/delta;
      last.rate=last.samples?last.rate*.9+rate*.1:rate;last.samples++;
      last.hours=hours;last.lastDraws=0;
    }
  }
  update(renderer,{workQuanta=this.workQuanta,allowCreate=true}={}) {
    // Resource dispose events are synchronous. Nested updates must not create
    // replacements inside the outer transaction's retirement/iteration.
    if(this.disposed||this.updating||this.retiring)return;
    this.updating=true;
    try {
      const p=this.planet,stream=p.weatherStream,u=p.volCloudMat.uniforms;
      // Invalidation also runs while a replacement stream is still loading.
      // No retired target may remain bound, even behind a disabled branch.
      this.unbind();
      if(this.fieldOwner!==p.weatherField || this.speciesMask!==u.uSpeciesMask.value
        ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch)) {
        this.retireMaps();
        if(this.disposed)return;
        this.fieldOwner=p.weatherField;this.speciesMask=u.uSpeciesMask.value;
        this.scratchEpoch=this.scratch?.epoch;
      }
      const a=stream?.anchor,b=a+stream?.frameHours,c=b+stream?.frameHours;
      // Detach before callbacks; a key must never refer to both a retired map
      // and a replacement created by a synchronous resource event.
      for(const [hours,map] of this.maps)if((hours!==a && hours!==b && hours!==c)
        || !weatherSourcesCurrent(map.weatherSources,stream)||map.invalidated
        ||(this.scratch&&map.contextEpoch!==null&&map.contextEpoch!==this.scratch.epoch)) {
        this.maps.delete(hours);map.dispose();
        if(this.disposed)return;
      }
      if(!stream || stream.disposed||stream!==p.weatherStream||a!==stream.anchor||this.scratch?.lost
        ||this.fieldOwner!==p.weatherField||this.speciesMask!==u.uSpeciesMask.value
        ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch))return;
      this.observeService(stream);
      const plan=this.deadlineAware?this.plan():null;
      // A missed current endpoint is not a successful forecast. If measured
      // admission cannot finish the current pair in this bracket, protect the
      // next pair instead of repeatedly spending its window on obsolete a.
      this.deferFirst=Boolean(plan&&this.service.samples>=8&&this.service.rate>0
        &&plan.jobs.slice(0,2).reduce((sum,job)=>sum+job.remainingDraws,0)/this.service.rate>b-p.weatherHours);
      // A real forecast endpoint can bake before the sampling pair is ready.
      // Finish the existing snapshot first, including when an earlier missing
      // endpoint arrives, so there is never more than one generation in flight.
      let pending=[...this.maps.values()].find(map=>!map.ready);
      if(this.deferFirst&&pending&&pending===this.maps.get(a)) {
        this.maps.delete(a);pending.dispose();pending=null;
        if(this.disposed)return;
        if(stream.disposed||stream!==p.weatherStream||a!==stream.anchor||this.fieldOwner!==p.weatherField
          ||this.speciesMask!==u.uSpeciesMask.value||this.scratch?.lost
          ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch))return;
      }
      if(!pending&&allowCreate) {
        const hours=(this.deferFirst?[b,c]:[a,b,c]).find(hours=>Number.isFinite(hours) && !this.maps.has(hours)
          && stream.frames.has(hours) && stream.revisionAt(hours)!=null);
        if(hours!==undefined) {
          const MapProducer=this.producer==='tile'?CloudColumnTileMap:CloudColumnMap;
          pending=new MapProducer(p,{hours,width:this.width,footprintSamples:this.footprintSamples,
            programOwner:this.programs,tileRows:this.tileRows,footprintBatch:this.footprintBatch,scratch:this.scratch});
          this.maps.set(hours,pending);
        }
      }
      let submission;
      if(this.producer==='tile')submission=pending?.bakeWork(renderer,workQuanta);
      else pending?.bakeSlice(renderer,this.rows);
      if(this.service&&stream===p.weatherStream&&this.fieldOwner===p.weatherField)this.service.lastDraws+=submission?.draws||0;
      const first=this.maps.get(a),second=this.maps.get(b);
      const current=stream===p.weatherStream&&a===stream.anchor&&!stream.disposed
        &&this.fieldOwner===p.weatherField&&this.speciesMask===u.uSpeciesMask.value;
      const pairCurrent=first&&second&&!first.invalidated&&!second.invalidated
        &&weatherSourcesCurrent(first.weatherSources,stream)&&weatherSourcesCurrent(second.weatherSources,stream)
        &&(!this.scratch||(first.contextEpoch===this.scratch.epoch&&second.contextEpoch===this.scratch.epoch&&!this.scratch.lost));
      u.uColumnsReady.value=current&&pairCurrent&&stream.ready&&first.ready&&second.ready?1:0;
      if(u.uColumnsReady.value) {
        u.uOpticalColumns.value=first.target.textures[0];u.uOpticalColumnsNext.value=second.target.textures[0];
        u.uColumnHeights.value=first.target.textures[1];u.uColumnHeightsNext.value=second.target.textures[1];
        u.uColumnMix.value=Math.max(0,Math.min(1,(p.weatherHours-a)/stream.frameHours));
        u.uColumnsJointReady.value=1;
      }
      return submission;
    } finally {
      this.updating=false;
    }
  }
  unbind() {
    const u=this.planet.volCloudMat.uniforms;
    u.uColumnsReady.value=0;
    u.uColumnsJointReady.value=0;
    for(const name of ['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext']) {
      u[name].value=u.uWeatherMap.value;
    }
  }
  retireMaps() {
    if(this.retiring)return;
    this.unbind();
    const maps=[...this.maps.values()],programs=this.programs;
    // A draw can synchronously retire the bank. Its map releases resources
    // after that draw returns and must not hand programs to an abandoned pool.
    Object.defineProperty(programs,'retired',{value:true,configurable:true});
    this.maps.clear();this.programs={};this.retiring=true;
    this.service=null;this.deferFirst=false;
    try {
      for(const map of maps)map.dispose();
      for(const material of Object.values(programs))material.dispose();
    } finally {
      this.retiring=false;
    }
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;this.unbind();
    setCloudFarCacheEnabled(this.planet,false);
    const scratch=this.scratch;this.scratch=null;
    this.retireMaps();
    scratch?.dispose();
    if(this.planet.cloudColumnMap===this)this.planet.cloudColumnMap=null;
  }
}
