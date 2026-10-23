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

// Immutable current endpoints and a bounded forecast window, with at most one
// snapshot under construction. Partial targets are never sampled.
export class CloudColumnBank {
  constructor(planet,{width=1024,rows=2,footprintSamples=64,producer='rows',
    tileRows=2,footprintBatch=8,workQuanta=1,deadlineAware=false,forecastSteps=2,cacheSteps=2}={}) {
    if(!['rows','tile'].includes(producer)||!Number.isInteger(workQuanta)||workQuanta<0
      ||![2,3].includes(forecastSteps)||![2,3].includes(cacheSteps)||cacheSteps>forecastSteps)throw Error('Invalid column producer');
    this.planet=planet;this.maps=new Map();this.disposed=false;this.updating=false;this.retiring=false;
    this.width=width;this.rows=rows;this.footprintSamples=footprintSamples;
    // Explicit opt-in until dynamic deadlines and the whole-frame GPU budget
    // are accepted. Default routing and row submissions stay unchanged.
    this.producer=producer;this.tileRows=tileRows;this.footprintBatch=footprintBatch;this.workQuanta=workQuanta;
    this.deadlineAware=deadlineAware&&producer==='tile';this.service=null;this.deferFirst=false;
    this.forecastSteps=forecastSteps;this.cacheSteps=cacheSteps;this.forecastStream=null;
    this.resetAdmission();
    this.scratch=producer==='tile'?new CloudColumnScratch(width,tileRows):null;
    this.scratchEpoch=this.scratch?.epoch;
    this.programs={};
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
  }
  // Read-only production plan: absolute forecast identity and first use are
  // separate from retirement. No snapshot allocation or GPU submission here.
  endpointHours(stream=this.planet.weatherStream) {
    return Array.from({length:this.cacheSteps+1},(_,index)=>stream?.anchor+index*stream?.frameHours).filter(Number.isFinite);
  }
  syncForecast(stream) {
    if(this.forecastStream===stream)return;
    const previous=this.forecastStream;this.forecastStream=null;previous?.releaseForecast(this);
    if(!this.disposed&&stream&&!stream.disposed&&this.forecastSteps>2&&stream.retainForecast(this,this.forecastSteps))this.forecastStream=stream;
  }
  resetAdmission() {
    // Each immutable source has one-use initialization keys. Only recurring
    // draws share the production estimate; cold intervals remain measured.
    this.admissionKeys=new WeakMap();this.nextStartKey={phase:this.footprintSamples<=this.footprintBatch?'initialize-final':'initialize-work'};
    this.productionKey={phase:'production'};this.idleKey={phase:'idle'};
    this.recoveryPair=null;
  }
  plan() {
    const p=this.planet,stream=p.weatherStream,anchor=stream?.anchor,step=stream?.frameHours;
    const hours=this.endpointHours(stream),targetBytes=this.width*this.width/2*12;
    return {anchor,frameHours:step,weatherHours:p.weatherHours,producer:this.producer,
      forecastSteps:this.forecastSteps,cacheSteps:this.cacheSteps,maxMaps:this.cacheSteps+1,targetCapacityBytes:(this.cacheSteps+1)*targetBytes,
      allocatedTargetBytes:this.maps.size*targetBytes,
      snapshotBytes:[...this.maps.values()].reduce((sum,map)=>sum+(map.snapshots||[]).reduce((bytes,texture)=>bytes+(texture.image?.data?.byteLength||0),0),0),
      deadlineAware:this.deadlineAware,deferFirst:this.deferFirst,serviceRate:this.service?.rate??null,
      recovery:this.recoveryPair?{hours:[this.recoveryPair.first,this.recoveryPair.second],
        revisions:this.recoveryPair.sources.frames.map(frame=>frame.revision),
        finishHours:this.recoveryPair.finishHours,feasible:this.recoveryPair.feasible}:null,
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
      this.service={stream,hours,lastDraws:0,rate:0,samples:0};this.recoveryPair=null;return;
    }
    if(delta>0) {
      const rate=last.lastDraws/delta;
      last.rate=last.samples?last.rate*.9+rate*.1:rate;last.samples++;
      last.hours=hours;last.lastDraws=0;
    }
  }
  selectRecoveryPair(stream,hours,pending) {
    const now=this.planet.weatherHours,step=stream.frameHours,anchor=stream.anchor;
    // Planning never expands endpointHours(), which also bounds retirement and
    // allocation. A raw fourth endpoint may only describe a future pair.
    if(!Number.isFinite(now)||!Number.isFinite(anchor)||!Number.isFinite(step)||step<=0||anchor+step<=anchor
      ||now<anchor||now>=anchor+step){this.recoveryPair=null;return null;}
    const trained=this.service?.samples>=8,rate=this.service?.rate;
    const known=trained&&Number.isFinite(rate)&&rate>0;
    const full=Math.ceil((this.width/2)/this.tileRows)*Math.ceil(this.footprintSamples/this.footprintBatch);
    const remaining=hour=>{
      const map=this.maps.get(hour);
      if(!map)return full;
      if(map.ready)return 0;
      return Math.ceil((this.width/2-map.row)/this.tileRows)*Math.ceil(this.footprintSamples/this.footprintBatch)
        -Math.floor((map.footprintCursor||0)/this.footprintBatch);
    };
    const candidates=[];
    for(const first of hours) {
      const second=first+step,revision=stream.revisionAt(first),next=stream.revisionAt(second);
      if(revision===null||next===null||!stream.frames.has(first)||!stream.frames.has(second))continue;
      const firstWork=remaining(first),secondWork=remaining(second);
      if(!firstWork&&!secondWork)continue;
      const finishHours=known?Math.max(now+firstWork/rate,second-this.cacheSteps*step)+secondWork/rate:null;
      candidates.push({first,second,sources:{stream,frames:[{hours:first,revision},{hours:second,revision:next}]},
        epoch:this.scratch.epoch,finishHours,feasible:known&&finishHours<first+step});
    }
    const previous=this.recoveryPair;
    const current=previous&&previous.epoch===this.scratch.epoch
      &&weatherSourcesCurrent(previous.sources,stream)
      ?candidates.find(pair=>pair.first===previous.first&&pair.second===previous.second):null;
    const contains=pair=>pending&&(pair.first===pending.generation||pair.second===pending.generation);
    // Keep useful partial work before considering a restart. Only a feasible
    // alternative can justify cancellation; an unknown/zero rate is not proof
    // that a partial map should be thrown away.
    const feasible=candidates.filter(pair=>pair.feasible);
    const selected=(current?.feasible&&contains(current)?current:null)
      ||feasible.find(contains)||(current?.feasible?current:null)||feasible[0]||current;
    if(selected&&current===selected) {
      previous.finishHours=selected.finishHours;previous.feasible=selected.feasible;
      this.recoveryPair=previous;
    } else this.recoveryPair=selected||null;
    return this.recoveryPair;
  }
  update(renderer,{workQuanta=this.workQuanta,allowCreate=true,admit=null}={}) {
    if(admit!==null&&(typeof admit!=='function'||this.producer!=='tile'))throw Error('Invalid column admission');
    // Resource dispose events are synchronous. Nested updates must not create
    // replacements inside the outer transaction's retirement/iteration.
    if(this.disposed||this.updating||this.retiring)return;
    this.updating=true;
    try {
      const p=this.planet,stream=p.weatherStream,u=p.volCloudMat.uniforms;
      // Invalidation also runs while a replacement stream is still loading.
      // No retired target may remain bound, even behind a disabled branch.
      this.unbind();
      this.syncForecast(stream);
      if(this.disposed)return;
      // The admission callback may observe loss/restoration before the first
      // target exists. Register epochs without initializing GPU resources.
      if(admit)this.scratch.observeRenderer(renderer);
      if(this.fieldOwner!==p.weatherField || this.speciesMask!==u.uSpeciesMask.value
        ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch)) {
        this.retireMaps();
        if(this.disposed)return;
        this.fieldOwner=p.weatherField;this.speciesMask=u.uSpeciesMask.value;
        this.scratchEpoch=this.scratch?.epoch;
      }
      const hours=this.endpointHours(stream),[a,b]=hours;
      // Detach before callbacks; a key must never refer to both a retired map
      // and a replacement created by a synchronous resource event.
      for(const [hour,map] of this.maps)if(!hours.includes(hour)
        || !weatherSourcesCurrent(map.weatherSources,stream)||map.invalidated
        ||(this.scratch&&map.contextEpoch!==null&&map.contextEpoch!==this.scratch.epoch)) {
        this.maps.delete(hour);map.dispose();
        if(this.disposed)return;
      }
      if(!stream || stream.disposed||stream!==p.weatherStream||a!==stream.anchor||this.scratch?.lost
        ||this.fieldOwner!==p.weatherField||this.speciesMask!==u.uSpeciesMask.value
        ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch))return;
      this.observeService(stream);
      // A real forecast endpoint can bake before the sampling pair is ready.
      // Finish the existing snapshot first, including when an earlier missing
      // endpoint arrives, so there is never more than one generation in flight.
      let pending=[...this.maps.values()].find(map=>!map.ready);
      const admissionOwner=this.admissionKeys,weatherHours=p.weatherHours;
      const recovery=this.deadlineAware?this.selectRecoveryPair(stream,hours,pending):null;
      this.deferFirst=Boolean(recovery&&recovery.first>a);
      if(pending&&recovery?.feasible&&pending.generation!==recovery.first&&pending.generation!==recovery.second) {
        this.maps.delete(pending.generation);pending.dispose();pending=null;
        if(this.disposed)return;
        if(stream.disposed||stream!==p.weatherStream||a!==stream.anchor||this.fieldOwner!==p.weatherField
          ||this.speciesMask!==u.uSpeciesMask.value||this.scratch?.lost
          ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch)||this.admissionKeys!==admissionOwner
          ||p.weatherHours!==weatherHours)return;
      }
      const choices=recovery?[recovery.first,recovery.second]:hours;
      const validClock=!this.deadlineAware||(p.weatherHours>=a&&p.weatherHours<a+stream.frameHours);
      const hour=!pending&&allowCreate&&validClock?choices.find(hour=>hours.includes(hour)&&!this.maps.has(hour)
        &&stream.frames.has(hour)&&stream.revisionAt(hour)!=null):undefined;
      const frame=stream.frames.get(hour);
      const phase=pending?.admission?.()||(hour!==undefined?{phase:this.nextStartKey.phase,maxUnits:1}:{phase:'idle',maxUnits:0});
      const keys=pending&&this.admissionKeys.get(pending);
      const request={...phase,key:phase.phase==='production'?this.productionKey:phase.phase==='idle'?this.idleKey
        :phase.phase==='initialize-final'?keys?.final||this.nextStartKey:keys?.start||this.nextStartKey};
      let submission;
      // Admission stays inside the lifecycle transaction, after cancellations
      // and before snapshot allocation. A deferred callback cannot spend it.
      let open=true,called=false;
      const produce=grant=>{
        if(!open||called)throw Error('Column admission must submit once synchronously');
        called=true;
        if(admit&&(!Number.isInteger(grant)||grant<0||grant>request.maxUnits))throw Error('Invalid column admission grant');
        if(this.disposed||stream.disposed||stream!==p.weatherStream||a!==stream.anchor||this.fieldOwner!==p.weatherField
          ||this.speciesMask!==u.uSpeciesMask.value||this.scratch?.lost
          ||(this.scratch&&this.scratchEpoch!==this.scratch.epoch)
          ||(this.deadlineAware&&(!validClock||p.weatherHours!==weatherHours||this.admissionKeys!==admissionOwner)))return;
        if(!pending&&allowCreate&&(!admit||grant>0)&&hour!==undefined&&stream.frames.get(hour)===frame) {
          const MapProducer=this.producer==='tile'?CloudColumnTileMap:CloudColumnMap;
          pending=new MapProducer(p,{hours:hour,width:this.width,footprintSamples:this.footprintSamples,
            programOwner:this.programs,tileRows:this.tileRows,footprintBatch:this.footprintBatch,scratch:this.scratch});
          this.admissionKeys.set(pending,{start:this.nextStartKey,
            final:this.nextStartKey.phase==='initialize-final'?this.nextStartKey:{phase:'initialize-final'}});
          this.nextStartKey={phase:this.nextStartKey.phase};this.maps.set(hour,pending);
        }
        if(this.producer==='tile')return submission=pending?.bakeWork(renderer,grant);
        pending?.bakeSlice(renderer,this.rows);
      };
      try {
        const outcome=admit?admit(request,produce):produce(workQuanta);
        if(outcome&&typeof outcome.then==='function')throw Error('Column admission must be synchronous');
      } finally {open=false;}
      if(this.service&&stream===p.weatherStream&&this.fieldOwner===p.weatherField)this.service.lastDraws+=submission?.draws||0;
      const first=this.maps.get(a),second=this.maps.get(b);
      const current=stream===p.weatherStream&&a===stream.anchor&&!stream.disposed
        &&this.fieldOwner===p.weatherField&&this.speciesMask===u.uSpeciesMask.value
        &&(!this.deadlineAware||(validClock&&p.weatherHours===weatherHours&&this.admissionKeys===admissionOwner));
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
      try {
        if(this.forecastStream&&(this.forecastStream!==this.planet.weatherStream||this.forecastStream.disposed))this.syncForecast(null);
      } finally {this.updating=false;}
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
    this.unbind();this.resetAdmission();
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
    this.syncForecast(null);
    setCloudFarCacheEnabled(this.planet,false);
    const scratch=this.scratch;this.scratch=null;
    this.retireMaps();
    scratch?.dispose();
    if(this.planet.cloudColumnMap===this)this.planet.cloudColumnMap=null;
  }
}
