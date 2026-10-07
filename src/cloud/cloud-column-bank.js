import { CloudColumnMap } from './cloud-column-map.js';

// Two immutable sampling endpoints and one forecast under construction. A
// partially baked target is never sampled, including after a clock jump.
export class CloudColumnBank {
  constructor(planet,{width=1024,rows=2,footprintSamples=64}={}) {
    this.planet=planet;this.maps=new Map();this.disposed=false;
    this.width=width;this.rows=rows;this.footprintSamples=footprintSamples;
    this.fieldOwner=planet.weatherField;this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
  }
  update(renderer) {
    if(this.disposed)return;
    const p=this.planet,stream=p.weatherStream,u=p.volCloudMat.uniforms;
    if(this.fieldOwner!==p.weatherField || this.speciesMask!==u.uSpeciesMask.value) {
      this.unbind();for(const map of this.maps.values())map.dispose();this.maps.clear();
      this.fieldOwner=p.weatherField;this.speciesMask=u.uSpeciesMask.value;
    }
    if(!stream?.ready){u.uColumnsReady.value=0;u.uColumnsJointReady.value=0;return;}
    const a=stream.anchor,b=a+stream.frameHours,c=b+stream.frameHours;
    // A retired render target must never remain bound as a sampler, even when
    // the shader's ready branch is disabled (drivers still validate bindings).
    this.unbind();
    for(const hours of this.maps.keys())if(hours!==a && hours!==b && hours!==c) {
      this.maps.get(hours).dispose();this.maps.delete(hours);
    }
    for(const hours of [a,b,c])if(!this.maps.has(hours) && stream.frames.has(hours))
      this.maps.set(hours,new CloudColumnMap(p,{hours,width:this.width,footprintSamples:this.footprintSamples}));
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
  dispose() {if(this.disposed)return;this.unbind();this.disposed=true;for(const map of this.maps.values())map.dispose();this.maps.clear();}
}
