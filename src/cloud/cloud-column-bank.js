import { CloudColumnMap } from './cloud-column-map.js';
import { weatherSourcesCurrent } from './weather-sources.js';

// Two immutable sampling endpoints and one forecast under construction. A
// partially baked target is never sampled, including after a clock jump.
export class CloudColumnBank {
  constructor(planet,{width=1024,rows=2,footprintSamples=64}={}) {
    this.planet=planet;this.maps=new Map();this.disposed=false;
    this.width=width;this.rows=rows;this.footprintSamples=footprintSamples;
    this.programs={};
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
  }
  update(renderer) {
    if(this.disposed)return;
    const p=this.planet,stream=p.weatherStream,u=p.volCloudMat.uniforms;
    // Invalidation also runs while a replacement stream is still loading.
    // No retired target may remain bound, even behind a disabled branch.
    this.unbind();
    if(this.fieldOwner!==p.weatherField || this.speciesMask!==u.uSpeciesMask.value) {
      for(const map of this.maps.values())map.dispose();this.maps.clear();
      for(const material of Object.values(this.programs))material.dispose();this.programs={};
      this.fieldOwner=p.weatherField;this.speciesMask=u.uSpeciesMask.value;
    }
    const a=stream?.anchor,b=a+stream?.frameHours,c=b+stream?.frameHours;
    // A retired render target must never remain bound as a sampler, even when
    // the shader's ready branch is disabled (drivers still validate bindings).
    for(const [hours,map] of this.maps)if((hours!==a && hours!==b && hours!==c)
      || !weatherSourcesCurrent(map.weatherSources,stream)) {
      map.dispose();this.maps.delete(hours);
    }
    if(!stream?.ready || stream.disposed)return;
    // Only one generation can make progress this tick. Defer later snapshots
    // until that slot is available instead of copying three forecasts at once.
    const hours=[a,b,c].find(hours=>!this.maps.get(hours)?.ready);
    if(hours!==undefined && !this.maps.has(hours) && stream.frames.has(hours))
      this.maps.set(hours,new CloudColumnMap(p,{hours,width:this.width,footprintSamples:this.footprintSamples,
        programOwner:this.programs}));
    const first=this.maps.get(a),second=this.maps.get(b);
    const pending=[first,second,this.maps.get(c)].find(map=>map && !map.ready);
    pending?.bakeSlice(renderer,this.rows);
    u.uColumnsReady.value=first?.ready&&second?.ready?1:0;
    if(u.uColumnsReady.value) {
      u.uOpticalColumns.value=first.target.textures[0];u.uOpticalColumnsNext.value=second.target.textures[0];
      u.uColumnHeights.value=first.target.textures[1];u.uColumnHeightsNext.value=second.target.textures[1];
      u.uColumnMix.value=Math.max(0,Math.min(1,(p.weatherHours-a)/stream.frameHours));
      u.uColumnsJointReady.value=1;
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
  dispose() {
    if(this.disposed)return;this.unbind();this.disposed=true;
    for(const map of this.maps.values())map.dispose();this.maps.clear();
    for(const material of Object.values(this.programs))material.dispose();this.programs={};
    if(this.planet.cloudColumnMap===this)this.planet.cloudColumnMap=null;
  }
}
