// Absolute-time forecasts blended in potential space. The two existing atlas
// textures commit together; every renderer/gameplay consumer sees those bytes.
import * as THREE from 'three';
import {PRODUCTION_PARAMETER_LAYERS,packProductionAcceleration} from './production-bands.js';

export class PlanetWeatherStream {
  constructor(planet) {
    this.planet=planet; this.frames=new Map(); this.pending=new Set();
    this.generations=new WeakMap();this.generation=0;
    this.token=0; this.disposed=false; this.error=null; this.lastUpdate=-Infinity;
    const angularSpeed=Math.abs(planet.weatherField.windRadiansPerHour);
    this.frameHours=.5/2**Math.max(0,Math.ceil(Math.log2(angularSpeed*.5/.05)));
    this.worker=new Worker(new URL('./planet-weather-worker.js',import.meta.url),{type:'module'});
    this.worker.postMessage({type:'init',descriptor:planet.weatherField.streamDescriptor});
    this.worker.onmessage=({data}) => {
      if(this.disposed || data.token!==this.token) return;
      this.pending.delete(data.hours);
      if(data.error) { this.error=data.error; return; }
      this.frames.set(data.hours,data);
      this.update(this.planet.weatherHours,true);
    };
    this.worker.onerror=e => { this.error=e.message; };
  }
  request(hours) {
    if(this.frames.has(hours) || this.pending.has(hours)) return;
    this.pending.add(hours);
    this.worker.postMessage({type:'frame',token:this.token,hours,
      stellarDirections:this.planet.stellarDirectionsAt?.(hours),
      width:this.planet.cloudAtlasWidth,surfaceRange:this.planet.weatherField.surfaceRangeMeters,frameHours:this.frameHours});
  }
  revisionAt(hours) {
    const frame=this.frames.get(hours);
    if(!frame)return null;
    if(!this.generations.has(frame))this.generations.set(frame,++this.generation);
    return this.generations.get(frame);
  }
  update(hours,force=false) {
    if(this.disposed) return;
    const FRAME_HOURS=this.frameHours;
    const a=Math.floor(hours/FRAME_HOURS)*FRAME_HOURS,b=a+FRAME_HOURS;
    // Forecast ahead of the normal clock; a jump drops obsolete queued jobs.
    if(this.anchor!==a) {
      const distant=this.anchor!==undefined && Math.abs(a-this.anchor)>FRAME_HOURS*3;
      if(distant && this.pending.size) {
        this.dispose();
        this.planet.weatherStream=new PlanetWeatherStream(this.planet);
        this.planet.weatherStream.update(hours,true); return;
      }
      this.anchor=a;
      for(const h of this.frames.keys()) if(h<a-FRAME_HOURS || h>b+FRAME_HOURS*2) this.frames.delete(h);
    }
    for(const h of [a,b,b+FRAME_HOURS]) this.request(h);
    const first=this.frames.get(a),second=this.frames.get(b);
    this.ready=Boolean(first&&second);
    // A prefetched third frame must not re-upload an unchanged active pair.
    // Worker completion forces a ready pair to commit immediately, but does
    // not make identical absolute-time bytes a new rendering transaction.
    if(this.ready && hours===this.lastUpdate && first===this.committedFirst && second===this.committedSecond)return;
    if(!this.ready || (!force && Math.abs(hours-this.lastUpdate)<1/300)) return;
    this.lastUpdate=hours;
    const mix=(hours-a)/FRAME_HOURS, p=this.planet;
    // Commit the micro-density phase with the same absolute-time transaction.
    // Read-only probes and CPU consumers need not wait for a render-loop tick
    // to receive the new family advection phase.
    if(p.volCloudMat?.uniforms.uCloudAdvectionPhase)
      p.volCloudMat.uniforms.uCloudAdvectionPhase.value=hours*p.weatherField.windRadiansPerHour;
    this.windData ||= new Float32Array(first.wind.length);
    for(let i=0;i<this.windData.length;i++) this.windData[i]=first.wind[i]*(1-mix)+second.wind[i]*mix;
    p.weatherField.bindWind({width:first.width,height:first.height,data:this.windData,scale:1,hours});
    const bandData=p.cloudSpeciesTex?.image.data;
    if(bandData) {
      const length=p.cloudSpeciesTex.image.width*p.cloudSpeciesTex.image.height*4*PRODUCTION_PARAMETER_LAYERS;
      for(let i=0;i<length;i++) bandData[i]=first.bands[i]*(1-mix)+second.bands[i]*mix;
      p.cloudSpeciesTex.needsUpdate=true;
      p.cloudSpeciesTex.userData.hours=hours;
    }
    if(p.cloudBoundsTex && (this.boundsAnchor!==a || this.boundsFirst!==first || this.boundsSecond!==second)) {
      this.boundsAnchor=a;
      this.boundsFirst=first;this.boundsSecond=second;
      const data=p.cloudBoundsTex.image.data;
      for(let i=0;i<data.length;i++) data[i]=i%2===0
        ? Math.min(first.bounds[i],second.bounds[i]) : Math.max(first.bounds[i],second.bounds[i]);
      p.cloudBoundsTex.needsUpdate=true;
      const candidates=p.cloudCandidatesTex?.image.data;
      if(candidates) {
        for(let i=0;i<candidates.length;i++)candidates[i]=first.candidates[i]|second.candidates[i];
        p.cloudCandidatesTex.needsUpdate=true;
      }
      if(bandData)packProductionAcceleration(bandData,p.cloudSpeciesTex.image.width,
        p.cloudSpeciesTex.image.height,data,candidates);
    }
    for(const [texture,key] of [[p.cloudShadowTex,'low'],[p.cloudWeatherHiTex,'high']]) {
      const atlas=texture.userData.weatherAtlas;
      if(!(atlas.data instanceof Float32Array)) {
        atlas.data=new Float32Array(first[key].length); atlas.scale=1;
        texture.image.data=new Float32Array(atlas.data.length);
        texture.type=THREE.FloatType;
        texture.minFilter=THREE.NearestFilter; texture.magFilter=THREE.NearestFilter;
        texture.generateMipmaps=false; texture.needsUpdate=true;
      }
      for(let i=0;i<atlas.data.length;i++) atlas.data[i]=first[key][i]*(1-mix)+second[key][i]*mix;
      // The GPU's north-first texture and CPU's south-first atlas share values.
      for(let y=0;y<atlas.height;y++) texture.image.data.set(
        atlas.data.subarray(y*atlas.width*4,(y+1)*atlas.width*4),
        (atlas.height-1-y)*atlas.width*4);
      atlas.hours=hours; texture.needsUpdate=true;
    }
    p.weatherField.bindAtlases(p.cloudShadowTex.userData.weatherAtlas,p.cloudWeatherHiTex.userData.weatherAtlas);
    this.committedFirst=first;this.committedSecond=second;
    this.revision=`${p.weatherField.namespace}:${a}:${b}`;
  }
  dispose() {
    if(this.disposed) return;this.disposed=true;this.worker.terminate();this.frames.clear();this.pending.clear();
    this.committedFirst=null;this.committedSecond=null;
    this.boundsFirst=null;this.boundsSecond=null;
  }
}
