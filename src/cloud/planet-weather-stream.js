// Absolute-time forecasts blended in potential space. The two existing atlas
// textures commit together; every renderer/gameplay consumer sees those bytes.
import * as THREE from 'three';
import {PRODUCTION_PARAMETER_LAYERS,packProductionAcceleration,encodeCandidateEmptyRuns} from './production-bands.js';

export class PlanetWeatherStream {
  constructor(planet) {
    this.planet=planet; this.frames=new Map(); this.pending=new Set();
    this.desired=[];this.inFlight=null;this.failedHours=new Set();this.workerFailed=false;
    this.forecastRequests=new Map();
    this.generations=new WeakMap();this.generation=0;
    this.publicationOwner={};
    this.token=0; this.disposed=false; this.error=null; this.lastUpdate=-Infinity;
    const angularSpeed=Math.abs(planet.weatherField.windRadiansPerHour);
    this.frameHours=.5/2**Math.max(0,Math.ceil(Math.log2(angularSpeed*.5/.05)));
    this.startWorker();
  }
  get forecastSteps() {
    let steps=2;for(const requested of this.forecastRequests.values())steps=Math.max(steps,requested);
    return steps;
  }
  retainForecast(owner,steps=3) {
    if(!owner||!['object','function'].includes(typeof owner)||![2,3].includes(steps))throw Error('Invalid weather forecast lease');
    if(this.disposed)return false;
    this.forecastRequests.set(owner,steps);return true;
  }
  releaseForecast(owner) {return this.forecastRequests.delete(owner);}
  startWorker() {
    let worker;this.workerFailed=false;
    try {
      worker=new Worker(new URL('./planet-weather-worker.js',import.meta.url),{type:'module'});
      this.worker=worker;
      worker.onmessage=({data}) => {
        if(this.disposed || this.workerFailed || worker!==this.worker)return;
        // The unchanged worker reports init failures before any frame token
        // exists. Treat that protocol response as a failed worker, not a job.
        if(data.error&&data.token===undefined&&data.hours===undefined){this.failWorker(data.error);return;}
        if(data.token!==this.token)return;
        const active=this.inFlight?.hours===data.hours&&this.inFlight.token===data.token;
        // Existing-hour replacement is a real revision transaction, but must
        // never release a different request's slot or accept an old token.
        if(!active&&!this.frames.has(data.hours))return;
        if(active){this.pending.delete(data.hours);this.inFlight=null;}
        if(data.error) {
          if(!active)return;
          this.error=data.error;this.failedHours.add(data.hours);
          this.advance(this.planet.weatherHours,true);return;
        }
        const a=Math.floor(this.planet.weatherHours/this.frameHours)*this.frameHours;
        if(data.hours>=a-this.frameHours&&data.hours<=a+this.frameHours*3)this.frames.set(data.hours,data);
        this.failedHours.delete(data.hours);if(!this.failedHours.size)this.error=null;
        this.advance(this.planet.weatherHours,true);
      };
      worker.onerror=e => {if(!this.disposed&&!this.workerFailed&&worker===this.worker)this.failWorker(e.message);};
      worker.postMessage({type:'init',descriptor:this.planet.weatherField.streamDescriptor});
    } catch(error) {
      this.worker=worker;this.failWorker(String(error));
    }
  }
  failWorker(error) {
    this.error=error;this.workerFailed=true;this.pending.clear();this.inFlight=null;
    this.worker?.terminate();
  }
  dispatch() {
    if(this.disposed||this.workerFailed||this.inFlight)return;
    const hours=this.desired.find(hours=>!this.frames.has(hours)&&!this.failedHours.has(hours));
    if(hours===undefined)return;
    const token=++this.token;this.inFlight={hours,token};this.pending.add(hours);
    try {
      this.worker.postMessage({type:'frame',token,hours,
        stellarDirections:this.planet.stellarDirectionsAt?.(hours),
        width:this.planet.cloudAtlasWidth,surfaceRange:this.planet.weatherField.surfaceRangeMeters,frameHours:this.frameHours});
    } catch(error) {this.failWorker(String(error));}
  }
  revisionAt(hours) {
    const frame=this.frames.get(hours);
    if(!frame)return null;
    if(!this.generations.has(frame))this.generations.set(frame,++this.generation);
    return this.generations.get(frame);
  }
  update(hours,force=false) {
    if(this.disposed)return;
    // Only an external tick retries failed jobs/workers. Error completions
    // can drain the remaining desired hours without creating a retry spin.
    this.failedHours.clear();
    if(this.workerFailed)this.startWorker();
    return this.advance(hours,force);
  }
  advance(hours,force=false) {
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
    // These are upload deduplication witnesses, not owners of expired or
    // replaced raw forecasts. Replacement can happen within the same anchor.
    // Keep published texture/atlas bytes intact while a new pair loads.
    for(const key of ['committedFirst','committedSecond','boundsFirst','boundsSecond']) {
      const frame=this[key];if(frame&&this.frames.get(frame.hours)!==frame)this[key]=null;
    }
    // Keep the desired set on the main thread. At most one frame has entered
    // the worker FIFO; a completion re-evaluates this absolute-time bracket.
    this.desired=Array.from({length:this.forecastSteps+1},(_,index)=>a+index*FRAME_HOURS);this.dispatch();
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
        const nearTex=p.volCloudMat?.uniforms?.uNearBandCandidates?.value;
        if(nearTex?.userData?.rawCandidates===p.cloudCandidatesTex && nearTex.image.data.length===candidates.length) {
          nearTex.image.data.set(candidates);
          encodeCandidateEmptyRuns(nearTex.image.data);
          nearTex.needsUpdate=true;
          nearTex.userData.rawVersion=p.cloudCandidatesTex.version;
        }
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
    if(first!==this.committedFirst||second!==this.committedSecond) {
      // Temporal consumers keep identities, never references to worker arrays.
      p.cloudWeatherPublication={owner:this.publicationOwner,first:this.revisionAt(a),second:this.revisionAt(b)};
    }
    this.committedFirst=first;this.committedSecond=second;
    this.revision=`${p.weatherField.namespace}:${a}:${b}`;
  }
  dispose() {
    if(this.disposed) return;this.disposed=true;this.ready=false;this.worker?.terminate();this.frames.clear();this.pending.clear();
    this.desired=[];this.inFlight=null;this.failedHours.clear();
    this.forecastRequests.clear();
    this.committedFirst=null;this.committedSecond=null;
    this.boundsFirst=null;this.boundsSecond=null;
  }
}
