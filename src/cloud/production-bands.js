// Plain-data cloud parameters. Renderers and gameplay read the same uploaded
// bands; formation/height decisions do not depend on a camera or quality tier.
import { CLOUD_SPECIES, speciesAltitudeBand } from './cloud-species.js';
import {sampleWeatherAtlas} from './weather-atlas.js';

export const PRODUCTION_BAND_VERSION = 5;
export const PRODUCTION_BAND_COUNT = CLOUD_SPECIES.length;
export const PRODUCTION_PARAMETER_LAYERS = PRODUCTION_BAND_COUNT+8;
export function productionStorageLayers(width,height=width/2) {
  return PRODUCTION_PARAMETER_LAYERS+Math.ceil(CANDIDATE_WIDTH*CANDIDATE_HEIGHT*CANDIDATE_LAYERS/(width*height*4))+2;
}
export function packProductionAcceleration(data,width,height,bounds,candidates) {
  const stride=width*height*4;
  data.set(candidates,PRODUCTION_PARAMETER_LAYERS*stride);
  data.set(bounds,(productionStorageLayers(width,height)-2)*stride);
}
export function buildProductionBands(sample,width=128,terrain=null,{spin=0,angularGuard=0.05}={}) {
  const height=width/2,layers=productionStorageLayers(width,height);
  const data=new Float32Array(width*height*4*layers);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const latitude=((y+.5)/height-.5)*Math.PI,longitude=(x+.5)/width*Math.PI*2;
    const direction={x:Math.cos(latitude)*Math.cos(longitude),y:Math.sin(latitude),z:Math.cos(latitude)*Math.sin(longitude)};
    writeProductionBands(data,width,height,x,y,sample(direction),direction);
    if(terrain)data.set(sampleWeatherAtlas(terrain,direction),
      ((layers-1)*width*height+(height-1-y)*width+x)*4);
  }
  const surfaceBounds=terrain?regionalSurfaceBounds(terrain,spin,angularGuard):[0,0];
  const bounds=productionBandBounds(data,width,height,surfaceBounds),candidates=productionBandCandidates(data,width,height,surfaceBounds);
  packProductionAcceleration(data,width,height,bounds,candidates);
  return {data,width,height,layers,bounds,candidates};
}
export const CANDIDATE_WIDTH=64,CANDIDATE_HEIGHT=32,CANDIDATE_LAYERS=64,CANDIDATE_METERS=500;
export function regionalSurfaceBounds(terrain,spin,angularGuard) {
  if(!Number.isFinite(spin)||!Number.isFinite(angularGuard)||angularGuard<0)
    throw new RangeError('Terrain support needs finite rotation and nonnegative guard');
  const {width,height,data}=terrain;
  const shift=spin/(Math.PI*2),margin=angularGuard/(Math.PI*2);
  return (x,y,columns,rows,pad=0)=>{
    const left=Math.floor(((x-pad)/columns-shift-margin)*width-.5);
    const right=Math.ceil(((x+1+pad)/columns-shift+margin)*width-.5);
    const bottom=Math.floor((y-pad)/rows*height-.5);
    const top=Math.ceil((y+1+pad)/rows*height-.5);
    let lo=Infinity,hi=-Infinity;
    for(let yy=bottom;yy<=top;yy++)for(let xx=left;xx<=right;xx++) {
      const north=Math.max(0,Math.min(height-1,yy));
      const value=data[((height-1-north)*width+(xx%width+width)%width)*4];
      lo=Math.min(lo,value);hi=Math.max(hi,value);
    }
    return [lo,hi];
  };
}
export function productionBandCandidates(data,width,height,surfaceBounds=[0,0]) {
  const result=new Uint16Array(CANDIDATE_WIDTH*CANDIDATE_HEIGHT*CANDIDATE_LAYERS);
  const stride=width*height*4;
  for(let y=0;y<CANDIDATE_HEIGHT;y++)for(let x=0;x<CANDIDATE_WIDTH;x++) {
    const surface=typeof surfaceBounds==='function'?surfaceBounds(x,y,CANDIDATE_WIDTH,CANDIDATE_HEIGHT):surfaceBounds;
    const ranges=[];
    for(let species=0;species<CLOUD_SPECIES.length;species++) {
      const s=CLOUD_SPECIES[species];if(s.family==='special')continue;
      const guard=(s.baseJitter+s.depthJitter)*.5+2;let lo=Infinity,hi=-Infinity,occupied=false;
      // Whole coarse cell, all fine bilinear support, and its boundaries.
      for(let yy=Math.floor(y*height/CANDIDATE_HEIGHT)-1;yy<=Math.ceil((y+1)*height/CANDIDATE_HEIGHT);yy++)
        for(let xx=Math.floor(x*width/CANDIDATE_WIDTH)-1;xx<=Math.ceil((x+1)*width/CANDIDATE_WIDTH);xx++) {
          const k=species*stride+(Math.max(0,Math.min(height-1,yy))*width+(xx+width)%width)*4;
          occupied ||= data[k]>0;
          lo=Math.min(lo,data[k+1]-guard);hi=Math.max(hi,data[k+2]+guard);
        }
      [lo,hi]=absoluteBandRange(s,lo,hi,surface);
      if(occupied && lo<=hi)ranges.push([species,Math.max(0,Math.min(63,Math.floor(lo/CANDIDATE_METERS))),
        Math.max(0,Math.min(63,Math.floor(hi/CANDIDATE_METERS)))]);
    }
    for(const [species,lo,hi] of ranges)for(let z=lo;z<=hi;z++)
      result[(z*CANDIDATE_HEIGHT+y)*CANDIDATE_WIDTH+x]|=1<<species;
  }
  return result;
}
// AGL bands move over fixed terrain while the weather atlas advects. Support
// includes the whole physical angular footprint and forecast rotation margin.
// Clipping still uses the original regional sample, never these broad bounds.
function absoluteBandRange(species,lo,hi,[minimum,maximum]) {
  if(species.baseReference!=='lcl' && species.id!=='fog')return [lo,hi];
  return [lo+minimum,typeof species.topAbsolute==='number'
    ?Math.max(hi,hi+maximum+species.minVerticalFeature):hi+maximum];
}
export function productionBandBounds(data,width,height,surfaceBounds=[0,0]) {
  const stride=width*height*4,bounds=new Float32Array(stride);
  // Include the full bilinear footprint plus one surrounding cell. The ray
  // may move a quarter of a cell while skipping an empty height interval.
  for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
    const surface=typeof surfaceBounds==='function'?surfaceBounds(x,y,width,height,1):surfaceBounds;
    const result=[1e6,-1e6,1e6,-1e6];
    for(let layer=0;layer<CLOUD_SPECIES.length;layer++) {
      const species=CLOUD_SPECIES[layer];if(species.id==='noctilucent')continue;
      const guard=(species.baseJitter+species.depthJitter)*.5+2;
      let lo=Infinity,hi=-Infinity,occupied=false;
      for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++) {
        const k=layer*stride+(Math.max(0,Math.min(height-1,y+dy))*width+(x+dx+width)%width)*4;
        occupied ||= data[k]>0;
        // Zero-weight heights still enter bilinear interpolation beside a
        // nonempty texel. Excluding them can clip the interpolated cloud.
        lo=Math.min(lo,data[k+1]-guard);hi=Math.max(hi,data[k+2]+guard);
      }
      if(!occupied)continue;
      [lo,hi]=absoluteBandRange(species,lo,hi,surface);
      const offset=species.id==='fog'?2:0;
      result[offset]=Math.min(result[offset],lo);result[offset+1]=Math.max(result[offset+1],hi);
    }
    bounds.set(result,(y*width+x)*4);
  }
  return bounds;
}
export function productionBandForWeather(species, weather, direction) {
  const baseJitter = .5 + .25 * Math.sin(direction.x * 13 + direction.z * 7);
  const depthJitter = .5 + .25 * Math.sin(direction.y * 17 - direction.x * 5);
  const band = speciesAltitudeBand(species, weather.lclMeters, baseJitter, depthJitter,
    { convective: weather.convective });
  // Store LCL/fog heights relative to the surface. Adding terrain before
  // interpolation smooths its knots again and sinks clouds into high ground.
  // Absolute mid/high bands are clipped at query time, not lifted into towers.
  const base = band.base;
  const top = band.top;
  const amount = species.family === 'special' ? weather.speciesWeights[species.id]
    : weather.familyAmounts[species.family];
  return [weather.speciesWeights[species.id] || 0, base, Math.max(base + 1, top), amount || 0];
}
export function writeProductionBands(data, width, height, x, y, weather, direction) {
  for (let layer = 0; layer < CLOUD_SPECIES.length; layer++) {
    const species = CLOUD_SPECIES[layer];
    const offset = ((layer * height + height - 1 - y) * width + x) * 4;
    // Height is always valid, including absent texels: interpolation cannot
    // drag an occupied deck to height zero at a coverage boundary.
    data.set(productionBandForWeather(species, weather, direction), offset);
  }
  // Each family partitions the same horizontal region, independent of the
  // queried altitude. Keep the original amount/height/optics bands intact.
  const stride=width*height*4;
  if(data.length<PRODUCTION_PARAMETER_LAYERS*stride)return;
  const sum={low:0,mid:0,high:0};
  for(let layer=0;layer<CLOUD_SPECIES.length;layer++) {
    const species=CLOUD_SPECIES[layer];if(species.family==='special')continue;
    const amount=weather.familyAmounts[species.family]||0;
    const left=sum[species.family];
    sum[species.family]+=amount>0?(weather.speciesWeights[species.id]||0)/amount:0;
    const offset=(PRODUCTION_BAND_COUNT+Math.floor(layer/2))*stride+
      ((height-1-y)*width+x)*4+(layer%2)*2;
    data[offset]=left;data[offset+1]=Math.min(1,sum[species.family]);
  }
}
