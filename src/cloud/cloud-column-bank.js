import { CloudColumnMap } from './cloud-column-map.js';
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
    if(!stream || stream.disposed)return;
    // A real forecast endpoint can bake before the sampling pair is ready.
    // Finish the existing snapshot first, including when an earlier missing
    // endpoint arrives, so there is never more than one generation in flight.
    let pending=[...this.maps.values()].find(map=>!map.ready);
    if(!pending) {
      const hours=[a,b,c].find(hours=>Number.isFinite(hours) && !this.maps.has(hours)
        && stream.frames.has(hours) && stream.revisionAt(hours)!=null);
      if(hours!==undefined) {
        pending=new CloudColumnMap(p,{hours,width:this.width,footprintSamples:this.footprintSamples,
          programOwner:this.programs});
        this.maps.set(hours,pending);
      }
    }
    pending?.bakeSlice(renderer,this.rows);
    const first=this.maps.get(a),second=this.maps.get(b);
    u.uColumnsReady.value=stream.ready&&first?.ready&&second?.ready?1:0;
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
    setCloudFarCacheEnabled(this.planet,false);
    for(const map of this.maps.values())map.dispose();this.maps.clear();
    for(const material of Object.values(this.programs))material.dispose();this.programs={};
    if(this.planet.cloudColumnMap===this)this.planet.cloudColumnMap=null;
  }
}
