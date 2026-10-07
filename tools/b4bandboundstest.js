// Conservative acceleration must cover interpolated geometry, including
// zero-weight neighbors whose heights still participate in interpolation.
import assert from 'node:assert/strict';
import {CLOUD_SPECIES} from '../src/cloud/cloud-species.js';
import {productionBandBounds,productionBandCandidates,CANDIDATE_WIDTH,CANDIDATE_HEIGHT,
  CANDIDATE_LAYERS,CANDIDATE_METERS,productionStorageLayers,packProductionAcceleration,PRODUCTION_PARAMETER_LAYERS} from '../src/cloud/production-bands.js';
const width=128,height=64,stride=width*height*4;
const data=new Float32Array(stride*CLOUD_SPECIES.length);
for(let species=0;species<CLOUD_SPECIES.length;species++)for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
  const s=CLOUD_SPECIES[species],occupied=(x+3*y+species)%7===0;
  const base=occupied?300+species*220:5000+((x+5*y+species)%13)*700;
  data.set([occupied?.7:0,base,base+(s.depth||s.minVerticalFeature*3),.7],species*stride+(y*width+x)*4);
}
const bounds=productionBandBounds(data,width,height),candidates=productionBandCandidates(data,width,height);
let checked=0,absentGeometry=0;
for(let i=0;i<50000;i++) {
  const u=(i*.6180339887498949)%1,v=((i+.5)*.4142135623730951)%1;
  const x=u*width-.5,y=v*height-.5,ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy;
  const species=i%14,s=CLOUD_SPECIES[species];if(s.family==='special')continue;
  const band=[0,0,0,0];let hasAbsent=false;
  for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
    const k=species*stride+(Math.max(0,Math.min(height-1,iy+dy))*width+(ix+dx+width)%width)*4;
    const weight=(dx?fx:1-fx)*(dy?fy:1-fy);hasAbsent ||= data[k]===0;
    for(let n=0;n<4;n++)band[n]+=data[k+n]*weight;
  }
  if(band[0]<.00001)continue;
  const k=(Math.min(height-1,Math.floor(v*height))*width+Math.floor(u*width))*4;
  const guard=(s.baseJitter+s.depthJitter)*.5;
  for(const altitude of [band[1]-s.baseJitter*.5,band[1],(band[1]+band[2])*.5,band[2]+guard]) {
    assert.ok(altitude>=bounds[k]-1e-4 && altitude<=bounds[k+1]+1e-4,
      `interpolated genus ${species} at ${u}/${v}/${altitude} outside conservative bounds`);
    const z=Math.max(0,Math.min(CANDIDATE_LAYERS-1,Math.floor(altitude/CANDIDATE_METERS)));
    const cx=Math.min(CANDIDATE_WIDTH-1,Math.floor(u*CANDIDATE_WIDTH));
    const cy=Math.min(CANDIDATE_HEIGHT-1,Math.floor(v*CANDIDATE_HEIGHT));
    assert.ok(candidates[(z*CANDIDATE_HEIGHT+cy)*CANDIDATE_WIDTH+cx]&(1<<species),
      `candidate mask clipped genus ${species}`);checked++;
  }
  if(hasAbsent)absentGeometry++;
}
assert.ok(checked>100000 && absentGeometry>10000);
console.log('PASS conservative interpolated cloud acceleration:',{checked,absentGeometry});
// Float32 carries every sixteen-bit mask exactly. Packed slices must remain
// outside the interpolated genus range and preserve every radial/angular cell.
for(const size of [64,128,256]) {
  const rows=size/2,layerStride=size*rows*4;
  const packed=new Float32Array(layerStride*productionStorageLayers(size,rows));
  const before=Float32Array.from({length:PRODUCTION_PARAMETER_LAYERS*layerStride},(_,i)=>i%17*.01);
  packed.set(before);
  const atlas=Float32Array.from({length:layerStride},(_,i)=>i%4<2?-150+i:90000-i);
  packProductionAcceleration(packed,size,rows,atlas,candidates);
  assert.deepEqual(packed.subarray(0,before.length),before);
  for(let index=0;index<candidates.length;index++) {
    const pixel=Math.floor(index/4),layer=PRODUCTION_PARAMETER_LAYERS+Math.floor(pixel/(size*rows));
    const y=Math.floor(pixel/size)%rows,x=pixel%size;
    assert.equal(packed[(layer*size*rows+y*size+x)*4+index%4],candidates[index]);
  }
  const boundsOffset=(productionStorageLayers(size,rows)-2)*layerStride;
  assert.deepEqual(packed.subarray(boundsOffset,boundsOffset+layerStride),atlas);
  assert.ok(packed.subarray(boundsOffset+layerStride).every(x=>x===0));
}
console.log('PASS packed surface acceleration: all masks/bounds at widths 64/128/256.');
