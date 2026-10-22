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
    tileRows=2,footprintBatch=8,workQuanta=1}={}) {
    if(!['rows','tile'].includes(producer)||!Number.isInteger(workQuanta)||workQuanta<0)throw Error('Invalid column producer');
    this.planet=planet;this.maps=new Map();this.disposed=false;this.updating=false;this.retiring=false;
    this.width=width;this.rows=rows;this.footprintSamples=footprintSamples;
    // Explicit opt-in until dynamic deadlines and the whole-frame GPU budget
    // are accepted. Default routing and row submissions stay unchanged.
    this.producer=producer;this.tileRows=tileRows;this.footprintBatch=footprintBatch;this.workQuanta=workQuanta;
    this.scratch=producer==='tile'?new CloudColumnScratch(width,tileRows):null;
    this.scratchEpoch=this.scratch?.epoch;
    this.programs={};
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
  }
  update(renderer,{workQuanta=this.workQuanta}={}) {
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
      // A real forecast endpoint can bake before the sampling pair is ready.
      // Finish the existing snapshot first, including when an earlier missing
      // endpoint arrives, so there is never more than one generation in flight.
      let pending=[...this.maps.values()].find(map=>!map.ready);
      if(!pending) {
        const hours=[a,b,c].find(hours=>Number.isFinite(hours) && !this.maps.has(hours)
          && stream.frames.has(hours) && stream.revisionAt(hours)!=null);
        if(hours!==undefined) {
          const MapProducer=this.producer==='tile'?CloudColumnTileMap:CloudColumnMap;
          pending=new MapProducer(p,{hours,width:this.width,footprintSamples:this.footprintSamples,
            programOwner:this.programs,tileRows:this.tileRows,footprintBatch:this.footprintBatch,scratch:this.scratch});
          this.maps.set(hours,pending);
        }
      }
      if(this.producer==='tile')pending?.bakeWork(renderer,workQuanta);
      else pending?.bakeSlice(renderer,this.rows);
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
