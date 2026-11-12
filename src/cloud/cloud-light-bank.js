import * as THREE from 'three';
import {CloudSunCache} from './cloud-sun-cache.js';
import {sampleProductionMedium} from './production-shape.js';
import {captureWeatherSources,weatherSourcesCurrent} from './weather-sources.js';

function cloudAnchor(planet,position) {
  const radial=position.clone().normalize(),surface=planet.weatherField.surfaceAt(radial);
  const cameraHeight=position.length()-planet.R;
  let bottom=Infinity,top=-Infinity;
  const outer=planet.volCloudBand.rOut-planet.R;
  const scanDirection=dir=>{
    for(let i=0;i<64;i++) {
      const height=surface+(outer-surface)*(i+.5)/64;
      const medium=sampleProductionMedium(planet,dir.clone().multiplyScalar(planet.R+height));
      if(medium.extinctionPerMeter>.0003){bottom=Math.min(bottom,height);top=Math.max(top,height);}
    }
  };
  scanDirection(radial);
  if(top<bottom && cameraHeight>outer*0.35) {
    const ref=Math.abs(radial.y)<0.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0);
    const tangent=new THREE.Vector3().crossVectors(ref,radial).normalize();
    const bitangent=new THREE.Vector3().crossVectors(radial,tangent).normalize();
    for(const offset of [0.002,-0.002]) {
      scanDirection(radial.clone().addScaledVector(tangent,offset).normalize());
      scanDirection(radial.clone().addScaledVector(bitangent,offset).normalize());
      if(top>=bottom)break;
    }
  }
  const maxAnchorHeight=Math.max(surface+3000,outer-3200);
  const fallbackHeight=Math.min(cameraHeight,maxAnchorHeight);
  const preferred=top>=bottom && cameraHeight>top?(bottom+top)*.5:fallbackHeight;
  const height=Math.min(maxAnchorHeight,Math.max(surface+3000,preferred));
  const horizontalSpan=cameraHeight>height?(cameraHeight-height)*1.4
    :(height-cameraHeight>1500?23040:12800);
  return {center:radial.multiplyScalar(planet.R+height),cameraHeight,
    spacing:Math.max(100,Math.min(400,Math.round(horizontalSpan/128)))};
}

// Complete absolute-time fields in a three-slot atlas. Both interpolation
// endpoints remain immutable while the third slot is baked. Invalid time or
// spatial support always falls back to the physical beam; never extrapolate.
export class CloudLightBank {
  constructor(planet,{size=128,depth=128,interval=.025,programOwner=null}={}) {
    this.planet=planet;this.size=size;this.depth=depth;this.interval=interval;
    this.maps=new Map();this.disposed=false;this.baseHours=planet.weatherHours;
    this.programs=programOwner||{};this.ownsPrograms=!programOwner;
    this.fieldOwner=planet.weatherField;this.lightIds=planet.stellarLightField.sources.map(s=>s.id).join('|');
    this.speciesMask=planet.volCloudMat.uniforms.uSpeciesMask.value;
    const position=planet.volCloudMat.uniforms.uCameraLocal.value;
    const anchor=cloudAnchor(planet,position);
    this.center=anchor.center;this.spacing=anchor.spacing;this.cameraHeight=anchor.cameraHeight;
    this.target=new THREE.WebGLRenderTarget(size*32,size*Math.ceil(depth*4*3/32),{
      format:THREE.RedFormat,type:THREE.UnsignedByteType,
      minFilter:THREE.LinearFilter,magFilter:THREE.LinearFilter,depthBuffer:false});
    this.initialized=false;this.submissions=[];this.generation=0;
    this.forecastStream=planet.weatherStream?.retainForecast?.(this,3)?planet.weatherStream:null;
  }
  needsReset() {
    const p=this.planet,hours=p.weatherHours;
    if(this.fieldOwner!==p.weatherField || this.speciesMask!==p.volCloudMat.uniforms.uSpeciesMask.value || hours<this.baseHours
      || this.lightIds!==p.stellarLightField.sources.map(s=>s.id).join('|'))return true;
    for(const cache of this.maps.values()) {
      const sources=cache.weatherSources;
      if(sources && !weatherSourcesCurrent(sources,p.weatherStream))return true;
    }
    const position=p.volCloudMat.uniforms.uCameraLocal.value,radial=position.clone().normalize();
    if(Math.abs(position.length()-p.R-this.cameraHeight)>Math.max(2000,this.size*this.spacing*.2))return true;
    const height=this.center.length()-p.R;
    const desired=radial.multiplyScalar(p.R+height);
    const advected=this.center.clone().applyMatrix4(new THREE.Matrix4().makeRotationY(
      (hours-this.baseHours)*p.weatherField.windRadiansPerHour));
    return advected.distanceTo(desired)>this.size*this.spacing*.3;
  }
  create(index) {
    const p=this.planet,hours=this.baseHours+index*this.interval,stream=p.weatherStream;
    const anchor=Math.floor(hours/stream.frameHours)*stream.frameHours;
    const first=stream.frames.get(anchor),second=stream.frames.get(anchor+stream.frameHours);
    if(!first || !second)return null;
    const actual=p.stellarDirectionsAt(hours);
    const directions=p.stellarLightField.sources.map(s=>actual.find(a=>a.id===s.id));
    if(directions.some(d=>!d))return null;
    const forecast={first,second,mix:(hours-anchor)/stream.frameHours,directions};
    const rotation=new THREE.Matrix4().makeRotationY((hours-this.baseHours)*p.weatherField.windRadiansPerHour);
    const cache=new CloudSunCache(p,this.center.clone().applyMatrix4(rotation),{
      size:this.size,depth:this.depth,spacing:this.spacing,hours,forecast,target:this.target,
      tileOffset:(index%3+3)%3*this.depth*4,programOwner:this.programs});
    cache.weatherSources=captureWeatherSources(stream,[anchor,anchor+stream.frameHours]);
    this.maps.set(index,cache);return cache;
  }
  update(renderer) {
    if(this.disposed)return;
    const p=this.planet,hours=p.weatherHours,u=p.volCloudMat.uniforms;
    if(this.forecastStream!==p.weatherStream) {
      this.forecastStream?.releaseForecast?.(this);
      this.forecastStream=p.weatherStream?.retainForecast?.(this,3)?p.weatherStream:null;
    }
    u.uSunCacheReady.value=0;
    const started=performance.now();
    const index=Math.floor((hours-this.baseHours)/this.interval+1e-8);
    for(const [key,cache] of this.maps)if(key<index || key>index+2) {
      cache.dispose();this.maps.delete(key);
    }
    // Bootstrap once before the first scene draw. Steady updates are sliced;
    // startup and steady costs are reported separately by runtime validation.
    if(!this.initialized) {
      // Copy and finish each bootstrap endpoint before allocating the next
      // snapshot. Completed endpoints retain only their atlas and metadata.
      for(const key of [index,index+1]) {
        const cache=this.maps.get(key)||this.create(key);
        if(!cache)break;
        while(!cache.ready)cache.bakeSlice(renderer,{boundaryRows:this.size,slices:this.depth});
      }
      this.initialized=Boolean(this.maps.get(index)?.ready && this.maps.get(index+1)?.ready);
    } else {
      // Preserve endpoint priority, but never allocate three baking snapshots
      // when only one can be submitted this update (also after a clock jump).
      const key=[index,index+1,index+2].find(key=>!this.maps.get(key)?.ready);
      const pending=key===undefined?null:this.maps.get(key)||this.create(key);
      if(pending)for(let pass=0;pass<2 && !pending.ready;pass++)
        pending.bakeSlice(renderer,{boundaryRows:this.size,slices:64});
    }
    this.submissions.push(performance.now()-started);
    if(this.submissions.length>120)this.submissions.shift();
    const a=this.maps.get(index),b=this.maps.get(index+1);
    if(!a?.ready || !b?.ready || hours<a.hours-1e-9 || hours>b.hours+1e-9)return;
    u.uSunTransport.value=this.target.texture;u.uSunCacheEncoded.value=1;
    u.uSunCacheDepth.value=this.depth;u.uSunCacheMix.value=(hours-a.hours)/(b.hours-a.hours);
    u.uSunCacheOffsets.value.set(a.tileOffset,b.tileOffset);
    for(const [cache,suffix] of [[a,'A'],[b,'B']]) {
      const flow=new THREE.Matrix4().makeRotationY((cache.hours-hours)*p.weatherField.windRadiansPerHour);
      for(let field=0;field<4;field++)u['uSunCacheMatrix'+suffix].value[field].copy(cache.transforms[field]).multiply(flow);
      u['uSunCacheValid'+suffix].value.fromArray(cache.available.map(v=>v?1:0));
      u['uSunCacheMargin'+suffix].value.fromArray(cache.interiorMargins);
    }
    u.uSunCacheReady.value=1;
  }
  unbind() {
    const u=this.planet.volCloudMat?.uniforms;
    if(u?.uSunCacheReady) {
      u.uSunCacheReady.value=0;u.uSunTransport.value=u.uWeatherMapHi.value;
    }
  }
  dispose() {
    if(this.disposed)return;this.disposed=true;this.unbind();
    this.forecastStream?.releaseForecast?.(this);this.forecastStream=null;
    for(const cache of this.maps.values())cache.dispose();this.maps.clear();this.target.dispose();
    if(this.ownsPrograms)for(const material of Object.values(this.programs))material.dispose();
    this.programs={};
    if(this.planet.cloudLightBank===this)this.planet.cloudLightBank=null;
  }
}
