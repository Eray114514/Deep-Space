import { CLOUD_SPECIES } from './cloud-species.js';
import { sampleWeatherAtlas } from './weather-atlas.js';
import { cloudNoiseDistribution } from './cloud-noise.js';

const modes = { sheet: 0, cellular: 1, cauliflower: 2, tower: 3, wispy: 4, lens: 5, veil: 6 };
const peaks = [0.20, 0.24, 0.28, 0.35, 0.22, 0.24, 0.15];
const stretches = [2.5, .65, .45, .2, .12, 1.6, 2.0];
export const PRODUCTION_SHAPE_VERSION = 10;
const clamp = x => Math.max(0, Math.min(1, x));
const smooth = (a,b,x) => { const t=clamp((x-a)/(b-a)); return t*t*(3-2*t); };
export const productionAdvectionScale = species => species.family==='mid'?1.25
  :species.family==='high'?1.65:species.id==='noctilucent'?1.18:1;
// Parameters come from the authoritative species table. Each genus has
// its own band, scale, optical coefficient and transfer curve, rather than a
// label attached to the original two decks.
export const productionSpeciesGLSL = /* glsl */`
  precision highp sampler2DArray;
  uniform sampler2DArray uSpeciesMap;
  precision highp usampler2DArray;
  uniform usampler2DArray uBandCandidates;
  uniform float uCandidatesReady,uCandidateLayers;
  uniform sampler2D uBandBounds;
  uniform float uBandsReady, uSpeciesMask;
  uniform float uSpeciesCount;
  uniform sampler2D uSpeciesParameters;
  uniform float uCloudAdvectionPhase;
  uniform float uSpeciesPartition;
  uniform int uMediumLayer;
  vec4 speciesOpticsAt(int i) {return texelFetch(uSpeciesParameters,ivec2(i,0),0);}
  vec4 speciesShapeAt(int i) {return texelFetch(uSpeciesParameters,ivec2(i,1),0);}
  vec4 speciesStructureAt(int i) {return texelFetch(uSpeciesParameters,ivec2(i,2),0);}
  void productionSpeciesFrame(vec3 weatherRadial,int species,out vec3 axis,out vec3 frame) {
    float phase=(speciesStructureAt(species).y-1.0)*uCloudAdvectionPhase;
    float c=cos(phase),s=sin(phase);
    vec3 shifted=vec3(c*weatherRadial.x-s*weatherRadial.z,weatherRadial.y,s*weatherRadial.x+c*weatherRadial.z);
    mat3 rotation=mat3(0.80,0.60,0.0,-0.48,0.64,0.60,0.36,-0.48,0.80);
    axis=rotation*shifted;frame=axis*uBodyR+uCOff*11000.0;
  }
  vec4 productionBandAt(vec2 uv,int layer) {
    ivec3 size=textureSize(uSpeciesMap,0);
    vec2 p=uv*vec2(size.xy)-0.5;
    ivec2 cell=ivec2(floor(p));vec2 f=fract(p);
    int x0=(cell.x%size.x+size.x)%size.x,x1=(x0+1)%size.x;
    int y0=clamp(cell.y,0,size.y-1),y1=clamp(cell.y+1,0,size.y-1);
    return mix(mix(texelFetch(uSpeciesMap,ivec3(x0,y0,layer),0),
      texelFetch(uSpeciesMap,ivec3(x1,y0,layer),0),f.x),
      mix(texelFetch(uSpeciesMap,ivec3(x0,y1,layer),0),
      texelFetch(uSpeciesMap,ivec3(x1,y1,layer),0),f.x),f.y);
  }
  vec2 productionAreaBand(vec2 uv,int species) {
    if(uSpeciesPartition<0.5 || species>=14)return vec2(-1.0);
    vec4 data=productionBandAt(uv,16+species/2);
    return species%2==0?data.xy:data.zw;
  }
  float productionNoiseCDF(float value) {
    float p=clamp(value,0.0,1.0)*63.0;int a=int(floor(p)),b=min(63,a+1);
    float left=texelFetch(uSpeciesParameters,ivec2(a/4,3),0)[a%4];
    float right=texelFetch(uSpeciesParameters,ivec2(b/4,3),0)[b%4];
    return mix(left,right,fract(p));
  }
  float productionAreaWeight(vec3 frame,vec2 region) {
    float selector=productionNoiseCDF(cloudNoiseAt(frame+vec3(43.7,11.3,91.9)*300000.0,300000.0).r);
    float lower=region.x<0.000001?1.0:smoothstep(region.x-0.01,region.x+0.01,selector);
    float upper=region.y>0.999999?0.0:smoothstep(region.y-0.01,region.y+0.01,selector);
    return max(0.0,lower-upper);
  }
  float productionFamilyCoverage(vec3 frame,float coverage) {
    float value=cloudNoiseAt(frame+vec3(7.9,83.1,17.3)*900000.0,900000.0).r;
    float selector=productionNoiseCDF(value);
    if(coverage<=0.0)return 0.0;
    if(coverage>=1.0)return 1.0;
    return 1.0-smoothstep(coverage-0.01,coverage+0.01,selector);
  }
  vec4 speciesAbsoluteBand(vec4 band,vec4 shape,float surface) {
    if(shape.w>0.5)band.gb+=surface;
    else if(shape.w<0.0) {
      band.g+=surface;
      band.b=max(band.b,band.g-shape.w);
    }
    return band;
  }
  float productionSurfaceAt(vec3 radial) {
    ivec3 size=textureSize(uSpeciesMap,0);
    if(size.z<=16)return (weatherAtlasSample(uWeatherMapHi,radial).g*2.0-1.0)*uSurfaceRange;
    vec2 p=weatherAtlasUV(radial)*vec2(size.xy)-0.5;
    ivec2 cell=ivec2(floor(p));vec2 f=fract(p);
    int x0=(cell.x%size.x+size.x)%size.x,x1=(x0+1)%size.x;
    int y0=clamp(cell.y,0,size.y-1),y1=clamp(cell.y+1,0,size.y-1),layer=size.z-1;
    return mix(mix(texelFetch(uSpeciesMap,ivec3(x0,y0,layer),0).r,
      texelFetch(uSpeciesMap,ivec3(x1,y0,layer),0).r,f.x),
      mix(texelFetch(uSpeciesMap,ivec3(x0,y1,layer),0).r,
      texelFetch(uSpeciesMap,ivec3(x1,y1,layer),0).r,f.x),f.y);
  }
  vec2 productionAltitudeBounds(vec3 radial) {
    vec4 bounds=textureLod(uBandBounds,weatherAtlasUV(uSpin*radial),0.0);
    return uMediumLayer==0?bounds.xy:uMediumLayer==2?bounds.zw:vec2(72000,90000);
  }
  // Radius of an empty ball, bounded by the current angular cell and the
  // nearest occupied radial bins. Radius/plane/cone distances are independent
  // of beam direction, so a curved altitude trajectory cannot leave support.
  float productionEmptyRadius(vec3 local) {
    if(uCandidatesReady<0.5 || uMediumLayer!=0)return 0.0;
    vec3 point=uSpin*local;
    float radius=length(point),altitude=radius-uBodyR;
    ivec3 size=textureSize(uBandCandidates,0);
    vec2 uv=weatherAtlasUV(point);
    ivec2 cell=clamp(ivec2(floor(uv*vec2(size.xy))),ivec2(0),size.xy-1);
    int layer=clamp(int(floor(altitude/500.0)),0,size.z-1);
    if(texelFetch(uBandCandidates,ivec3(cell,layer),0).r!=0u)return 0.0;
    float below=uRin,above=uRout;
    for(int k=1;k<int(uCandidateLayers);k++) {
      int index=layer-k;
      if(index<0)break;
      if(texelFetch(uBandCandidates,ivec3(cell,index),0).r!=0u) {
        below=max(below,uBodyR+float(index+1)*500.0);break;
      }
    }
    for(int k=1;k<int(uCandidateLayers);k++) {
      int index=layer+k;
      if(index>=size.z)break;
      if(texelFetch(uBandCandidates,ivec3(cell,index),0).r!=0u) {
        above=min(above,uBodyR+float(index)*500.0);break;
      }
    }
    float distance=min(radius-below,above-radius);
    float theta=weatherAtan2(length(point.xz),point.y);
    for(int side=0;side<2;side++) {
      float latitude=float(cell.y+side)*3.14159265359/float(size.y);
      distance=min(distance,radius*abs(sin(theta-latitude)));
      float longitude=float(cell.x+side)*6.28318530718/float(size.x);
      distance=min(distance,abs(dot(point,vec3(-sin(longitude),0,cos(longitude)))));
    }
    return max(0.0,distance*0.99);
  }
  bool speciesHasSupport(float altitude,vec4 band,float baseJitter,float depthJitter) {
    return !(band.r<0.00001 || band.a<0.00001
      || altitude<band.g-baseJitter*0.5 || altitude>band.b+(baseJitter+depthJitter)*0.5);
  }
  float speciesCondensate(vec3 frame,vec3 axis,float altitude,vec4 band,
    float feature,float baseJitter,float depthJitter,int mode,float minimumDepth,vec2 region) {
    if(!speciesHasSupport(altitude,band,baseJitter,depthJitter))return 0.0;
    float share=region.x>=0.0?productionAreaWeight(frame,region):band.r/max(band.a,0.00001);
    if(share<=0.0)return 0.0;
    float coverage=region.x>=0.0?productionFamilyCoverage(frame,clamp(band.a,0.0,1.0))
      :smoothstep(0.12,0.68,band.a);
    float amount=coverage*share;
    if(amount<=0.0)return 0.0;
    float tile=feature*6.0;
    vec2 fine=cloudNoiseAt(frame+axis*altitude*0.31,tile);
    float base=band.g+(fine.g*2.0-1.0)*baseJitter*0.5;
    float depth=max(1.0,band.b-band.g+(fine.r*2.0-1.0)*depthJitter*0.5);
    if(mode==1) {
      float cellTop=cloudNoiseAt(frame,tile).r;
      depth=max(minimumDepth,depth*mix(0.4,1.0,smoothstep(0.35,0.70,cellTop)));
    }
    float h=(altitude-base)/depth;
    if(h<=0.0 || h>=1.0) return 0.0;
    float stretch=mode==0?2.5:mode==1?0.65:mode==2?0.45:mode==3?0.2:mode==4?0.12:mode==5?1.6:2.0;
    vec3 q=frame+axis*(altitude-base)*stretch;
    if(mode==4) q=frame*vec3(0.16,1.0,0.48)+axis*(altitude-base)*stretch;
    vec2 n=cloudNoiseAt(q,tile);
    float profile=smoothstep(0.0,0.10,h)*(1.0-smoothstep(0.36,1.0,h));
    float shape;
    if(mode==0 || mode==6) {
      profile=smoothstep(0.0,0.14,h)*(1.0-smoothstep(0.80,1.0,h));
      shape=0.45+0.55*n.r;
    } else if(mode==5) {
      profile=pow(sin(h*3.14159265359),1.2);
      shape=smoothstep(0.48,0.68,n.r)*(0.5+0.5*n.g);
    } else if(mode==4) {
      profile=smoothstep(0.0,0.15,h)*(1.0-smoothstep(0.8,1.0,h));
      shape=smoothstep(0.48,0.69,n.r+n.g*0.14);
    } else {
      // A rounded vertical support changes the cloud boundary, rather than
      // merely dimming a full column up to a shared flat ceiling. The coverage
      // -> shape remap follows three-geospatial's separated weather/shape
      // construction; our metre-scale field and extinction remain authoritative.
      float rounded=1.0-pow(clamp(2.0*pow(h,0.35)-1.0,-1.0,1.0),2.0);
      float envelope=rounded*smoothstep(0.0,0.08,h);
      // Raw Perlin-Worley noise has a positive floor. Using it directly makes
      // every horizontal column intersect the maximum of the envelope: a
      // continuous ceiling with dimples instead of separated cells. The
      // measured CDF provides an explicit empty tail and a full shape range.
      float emptyTail=mode==1?0.10:mode==2?0.35:0.20;
      float cell=pow(max(0.0,(productionNoiseCDF(n.r)-emptyTail)/(1.0-emptyTail)),0.65);
      if(cell<=0.0)return 0.0;
      shape=clamp((envelope-(1.0-cell))/cell,0.0,1.0);
      profile=smoothstep(0.0,0.08,h);
      float erosion=cloudNoiseAt(q*3.7+vec3(1.7,5.3,9.1)*tile,tile).g;
      shape=max(0.0,shape-(1.0-erosion)*0.10*(1.0-rounded));
    }
    float peak=mode==0?0.20:mode==1?0.24:mode==2?0.28:mode==3?0.35:mode==4?0.22:mode==5?0.24:0.15;
    return amount*shape*profile*peak;
  }
  vec2 productionSpeciesAt(vec3 local) {
    float radius=length(local),altitude=radius-uBodyR;
    vec3 radial=local/radius;
    vec2 bounds=productionAltitudeBounds(radial);
    if(altitude<bounds.x || altitude>bounds.y) return vec2(0);
    vec3 weatherRadial=uSpin*radial;
    vec2 uv=weatherAtlasUV(weatherRadial);
    uint candidates=65535u;
    if(uCandidatesReady>0.5 && uMediumLayer==0) {
      ivec3 size=textureSize(uBandCandidates,0);
      ivec2 cell=clamp(ivec2(floor(uv*vec2(size.xy))),ivec2(0),size.xy-1);
      candidates=texelFetch(uBandCandidates,ivec3(cell,clamp(int(floor(altitude/500.0)),0,size.z-1)),0).r;
    }
    if(candidates==0u)return vec2(0);
    float surface=productionSurfaceAt(radial);
    if(altitude<surface) return vec2(0);
    vec2 total=vec2(0);
    for(int i=0;i<int(uSpeciesCount);i++) {
      if((candidates&(1u<<uint(i)))==0u)continue;
      vec4 parameters=speciesOpticsAt(i),shape=speciesShapeAt(i);
      if(uMediumLayer!=int(shape.z) || (uSpeciesMask>=0.0 && abs(uSpeciesMask-float(i))>0.5)) continue;
      vec4 band=productionBandAt(uv,i);
      band=speciesAbsoluteBand(band,shape,surface);
      // Reject the same zero support as speciesCondensate before computing
      // the species frame and fetching its independent area partition.
      if(!speciesHasSupport(altitude,band,parameters.y,parameters.z))continue;
      vec3 axis,frame;productionSpeciesFrame(weatherRadial,i,axis,frame);
      float d=speciesCondensate(frame,axis,altitude,band,parameters.x,parameters.y,parameters.z,int(shape.x),speciesStructureAt(i).x,productionAreaBand(uv,i));
      if(shape.y<0.5)total.x+=d*parameters.w/0.025;
      else total.y+=d*parameters.w/0.0006;
    }
    return total;
  }
`;

export function productionSpeciesParameters() {
  return CLOUD_SPECIES.map(s=>({
    optics:[s.horizontalFeature,s.baseJitter,s.depthJitter,s.extinctionPerKm/1000],
    shape:[modes[s.morphology],s.family==='high'||s.id==='noctilucent'?1:0,
      s.id==='noctilucent'?1:s.id==='fog'?2:0,
      s.baseReference==='lcl'||s.id==='fog' ? typeof s.topAbsolute==='number'?-s.minVerticalFeature:1 : 0],
    structure:[s.minVerticalFeature,productionAdvectionScale(s),0,0],
  }));
}

function noiseSample(texture,p,tile) {
  const { data,width:size }=texture.image;
  const c=p.map(x=>((x/tile%1+1)%1)*size-.5),i=c.map(Math.floor),frac=c.map((v,k)=>v-i[k]);
  const result=[0,0];
  for(let z=0;z<2;z++)for(let y=0;y<2;y++)for(let x=0;x<2;x++) {
    const index=((((i[2]+z+size)%size)*size+(i[1]+y+size)%size)*size+(i[0]+x+size)%size)*2;
    const w=(x?frac[0]:1-frac[0])*(y?frac[1]:1-frac[1])*(z?frac[2]:1-frac[2]);
    result[0]+=data[index]/255*w; result[1]+=data[index+1]/255*w;
  }
  return result;
}
export function productionAreaBand(texture,direction,spin,index) {
  const {width,height,data}=texture.image,stride=width*height*4;
  const values=sampleWeatherAtlas({width,height,data:data.subarray((16+Math.floor(index/2))*stride,(17+Math.floor(index/2))*stride),scale:1,northFirst:true},direction,spin);
  return index%2===0?values.slice(0,2):values.slice(2,4);
}
function areaWeight(frame,region,noise) {
  const value=noiseSample(noise,frame.map((v,i)=>v+[43.7,11.3,91.9][i]*300000),300000)[0];
  const p=clamp(value)*63,a=Math.floor(p),cdf=cloudNoiseDistribution();
  const selector=cdf[a]*(1-(p-a))+cdf[Math.min(63,a+1)]*(p-a);
  const lower=region[0]<.000001?1:smooth(region[0]-.01,region[0]+.01,selector);
  const upper=region[1]>.999999?0:smooth(region[1]-.01,region[1]+.01,selector);
  return Math.max(0,lower-upper);
}
function familyCoverage(frame,coverage,noise) {
  if(coverage<=0)return 0;
  if(coverage>=1)return 1;
  const value=noiseSample(noise,frame.map((v,i)=>v+[7.9,83.1,17.3][i]*900000),900000)[0];
  const p=clamp(value)*63,a=Math.floor(p),cdf=cloudNoiseDistribution();
  const selector=cdf[a]*(1-(p-a))+cdf[Math.min(63,a+1)]*(p-a);
  return 1-smooth(coverage-.01,coverage+.01,selector);
}
export function productionCondensate(species,band,frame,axis,altitude,noise,region=null) {
  const mode=modes[species.morphology],tile=species.horizontalFeature*6;
  if(band[0]<.00001 || band[3]<.00001 || altitude<band[1]-species.baseJitter*.5
    || altitude>band[2]+(species.baseJitter+species.depthJitter)*.5)
    return {condensate:0,base:band[1],top:band[2]};
  const share=region?areaWeight(frame,region,noise):band[0]/Math.max(band[3],.00001);
  const coverage=region?familyCoverage(frame,clamp(band[3]),noise):smooth(.12,.68,band[3]);
  const amount=coverage*share;
  if(amount<=0)return {condensate:0,base:band[1],top:band[2]};
  const fine=noiseSample(noise,frame.map((v,i)=>v+axis[i]*altitude*.31),tile);
  const base=band[1]+(fine[1]*2-1)*species.baseJitter*.5;
  let depth=Math.max(1,band[2]-band[1]+(fine[0]*2-1)*species.depthJitter*.5);
  if(mode===1)depth=Math.max(species.minVerticalFeature,depth*(.4+.6*smooth(.35,.70,noiseSample(noise,frame,tile)[0])));
  const h=(altitude-base)/depth;
  if(h<=0 || h>=1) return {condensate:0,base,top:base+depth};
  const q=frame.map((v,i)=>v*(mode===4?[.16,1,.48][i]:1)+axis[i]*(altitude-base)*stretches[mode]);
  const n=noiseSample(noise,q,tile);
  let profile=smooth(0,.1,h)*(1-smooth(.36,1,h)),shape;
  if(mode===0 || mode===6) {profile=smooth(0,.14,h)*(1-smooth(.8,1,h));shape=.45+.55*n[0];}
  else if(mode===5) {profile=Math.pow(Math.sin(h*Math.PI),1.2);shape=smooth(.48,.68,n[0])*(.5+.5*n[1]);}
  else if(mode===4) {profile=smooth(0,.15,h)*(1-smooth(.8,1,h));shape=smooth(.48,.69,n[0]+n[1]*.14);}
  else {
    const rounded=1-Math.pow(Math.max(-1,Math.min(1,2*Math.pow(h,.35)-1)),2);
    const envelope=rounded*smooth(0,.08,h),p=clamp(n[0])*63,a=Math.floor(p),cdf=cloudNoiseDistribution();
    const selector=cdf[a]*(1-(p-a))+cdf[Math.min(63,a+1)]*(p-a);
    const emptyTail=mode===1?.10:mode===2?.35:.20;
    const cell=Math.pow(Math.max(0,(selector-emptyTail)/(1-emptyTail)),.65);
    if(cell<=0)return {condensate:0,base,top:base+depth};
    shape=clamp((envelope-(1-cell))/cell);
    profile=smooth(0,.08,h);
    const erosion=noiseSample(noise,q.map((v,i)=>v*3.7+[1.7,5.3,9.1][i]*tile),tile)[1];
    shape=Math.max(0,shape-(1-erosion)*.1*(1-rounded));
  }
  const condensate=amount*shape*profile*peaks[mode];
  return {condensate,base,top:base+depth};
}
export function absoluteProductionBand(species,band,surface) {
  const result=band.slice();
  if(species.baseReference==='lcl'||species.id==='fog') {
    result[1]+=surface;
    result[2]=typeof species.topAbsolute==='number'
      ?Math.max(result[2],result[1]+species.minVerticalFeature):result[2]+surface;
  }
  return result;
}
export function sampleProductionMedium(planet,position,{speciesMask=-1,mediumLayer=0}={}) {
  const material=planet.volCloudMat,texture=planet.cloudSpeciesTex;
  if(!texture || !material) return { density:0,extinctionPerMeter:0,components:[] };
  const radius=Math.hypot(position.x,position.y,position.z),altitude=radius-planet.R;
  const radial={x:position.x/radius,y:position.y/radius,z:position.z/radius};
  const surface=planet.weatherField.surfaceAt(radial);
  if(altitude<surface) return {density:0,extinctionPerMeter:0,components:[]};
  const spin=planet.cloudSpinBase+planet.weatherHours*planet.weatherField.windRadiansPerHour;
  const c=Math.cos(spin),s=Math.sin(spin),d=[c*radial.x-s*radial.z,radial.y,s*radial.x+c*radial.z];
  const off=material.uniforms.uCOff.value.toArray();
  const {width,height,data}=texture.image, stride=width*height*4;
  const components=[];let extinctionPerMeter=0,density=0;
  for(let index=0;index<CLOUD_SPECIES.length;index++) {
    const species=CLOUD_SPECIES[index],layer=species.id==='noctilucent'?1:species.id==='fog'?2:0;
    if(layer!==mediumLayer || (speciesMask>=0 && index!==speciesMask)) continue;
    // Array texture rows are north first, unlike the public weather atlas.
    const band=absoluteProductionBand(species,sampleWeatherAtlas({width,height,data:data.subarray(index*stride,(index+1)*stride),scale:1,northFirst:true},radial,spin),surface);
    if(band[0]<.00001 || band[3]<.00001) continue;
    const phase=(productionAdvectionScale(species)-1)*planet.weatherHours*planet.weatherField.windRadiansPerHour;
    const cc=Math.cos(phase),ss=Math.sin(phase),shifted=[cc*d[0]-ss*d[2],d[1],ss*d[0]+cc*d[2]];
    const axis=[.8*shifted[0]-.48*shifted[1]+.36*shifted[2],
      .6*shifted[0]+.64*shifted[1]-.48*shifted[2],.6*shifted[1]+.8*shifted[2]];
    const frame=axis.map((v,i)=>v*planet.R+off[i]*11000);
    const region=material.uniforms.uSpeciesPartition.value>.5 && layer===0
      ?productionAreaBand(texture,radial,spin,index):null;
    const {condensate,base,top}=productionCondensate(species,band,frame,axis,altitude,material.uniforms.uNoise3.value,region);
    const extinction=condensate*species.extinctionPerKm/1000;
    density=1-(1-density)*(1-condensate);extinctionPerMeter+=extinction;
    if(extinction>0) components.push({speciesId:species.id,density:condensate,extinctionPerMeter:extinction,base,top});
  }
  return {density,extinctionPerMeter,components};
}
