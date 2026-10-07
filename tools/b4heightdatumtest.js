// Height datum regression: terrain and weather must not be interpolated as
// one sum. A peak midway through a moving weather grid exposes the old bug.
import assert from 'node:assert/strict';
import {CLOUD_SPECIES} from '../src/cloud/cloud-species.js';
import {productionBandForWeather,productionBandBounds,productionBandCandidates,
  CANDIDATE_WIDTH,CANDIDATE_HEIGHT,CANDIDATE_LAYERS} from '../src/cloud/production-bands.js';
import {regionalSurfaceBounds} from '../src/cloud/production-bands.js';
import {sampleWeatherAtlas} from '../src/cloud/weather-atlas.js';
import {absoluteProductionBand} from '../src/cloud/production-shape.js';
const direction={x:1,y:0,z:0};
const weather={lclMeters:1200,elevationMeters:0,convective:.3,
  speciesWeights:Object.fromEntries(CLOUD_SPECIES.map(s=>[s.id,.6])),
  familyAmounts:{low:.6,mid:.6,high:.6}};
const sc=CLOUD_SPECIES.find(s=>s.id==='stratocumulus');
const sea=productionBandForWeather(sc,weather,direction);
const hill=productionBandForWeather(sc,{...weather,elevationMeters:8000},direction);
assert.deepEqual(sea,hill,'AGL weather must not encode terrain in a moving grid');
const atPeak=absoluteProductionBand(sc,sea,6000);
assert.equal(atPeak[1]-6000,sea[1]);
assert.ok(Math.abs(atPeak[2]-6000-sea[2])<1e-9);
// The old interpolation adds 4 km at this midpoint rather than the actual
// 6 km peak, placing the base two kilometres below its intended LCL.
assert.ok(Math.abs((sea[1]+4000)-atPeak[1])>1500);
const cb=CLOUD_SPECIES.find(s=>s.id==='cumulonimbus');
const cbBand=productionBandForWeather(cb,weather,direction);
assert.equal(absoluteProductionBand(cb,cbBand,6000)[2],cbBand[2],
  'A tropopause ceiling is absolute, not terrain plus tropopause');
assert.equal(absoluteProductionBand(cb,cbBand,16000)[2],
  cbBand[1]+16000+cb.minVerticalFeature,'High ground preserves the minimum resolved thickness');
const mid=CLOUD_SPECIES.find(s=>s.id==='altocumulus');
const midBand=productionBandForWeather(mid,weather,direction);
assert.deepEqual(absoluteProductionBand(mid,midBand,8000),midBand,
  'Absolute decks are clipped by terrain instead of being lifted into towers');
const width=128,height=64,stride=width*height*4;
const data=new Float32Array(stride*CLOUD_SPECIES.length);
for(let s=0;s<CLOUD_SPECIES.length;s++)for(let i=0;i<stride;i+=4)
  data.set(productionBandForWeather(CLOUD_SPECIES[s],weather,direction),s*stride+i);
const bounds=productionBandBounds(data,width,height,[-1000,16000]);
const candidates=productionBandCandidates(data,width,height,[-1000,16000]);
let checks=0;
for(let s=0;s<CLOUD_SPECIES.length;s++) {
  const genus=CLOUD_SPECIES[s];if(genus.family==='special')continue;
  for(const surface of [-1000,0,6000,16000]) {
    const band=absoluteProductionBand(genus,Array.from(data.subarray(s*stride,s*stride+4)),surface);
    for(const altitude of [band[1]-genus.baseJitter*.5,band[2]+(genus.baseJitter+genus.depthJitter)*.5]) {
      assert.ok(altitude>=bounds[0]-1e-3 && altitude<=bounds[1]+1e-3,`${genus.id} clipped by bounds`);
      const z=Math.max(0,Math.min(CANDIDATE_LAYERS-1,Math.floor(altitude/500)));
      assert.ok(candidates[z*CANDIDATE_HEIGHT*CANDIDATE_WIDTH]&(1<<s),`${genus.id} clipped by candidates`);
      checks++;
    }
  }
}
console.log('PASS moving-weather height datum:',{checks,peakBase:atPeak[1],peakAGL:atPeak[1]-6000});
const terrain={width,height,scale:1,data:new Float32Array(stride)};
for(let y=0;y<height;y++)for(let x=0;x<width;x++)
  terrain.data[(y*width+x)*4]=-1000+17000*((x*19+y*37)%71)/70;
let terrainChecks=0;
for(const spin of [-37,-3.1,0,.9,28]) {
  const support=regionalSurfaceBounds(terrain,spin,.05);
  for(let i=0;i<4096;i++) {
    const u=(i*.6180339887498949)%1,v=((i+.5)*.4142135623730951)%1;
    const x=Math.floor(u*CANDIDATE_WIDTH),y=Math.floor(v*CANDIDATE_HEIGHT);
    const [lo,hi]=support(x,y,CANDIDATE_WIDTH,CANDIDATE_HEIGHT);
    for(const advance of [-.05,0,.05]) {
      const latitude=(.5-v)*Math.PI,longitude=u*Math.PI*2-spin-advance;
      const elevation=sampleWeatherAtlas(terrain,{x:Math.cos(latitude)*Math.cos(longitude),
        y:Math.sin(latitude),z:Math.cos(latitude)*Math.sin(longitude)})[0];
      assert.ok(elevation>=lo-1e-8 && elevation<=hi+1e-8,
        `Rotating terrain escaped angular support at ${spin}/${advance}/${u}/${v}`);
      terrainChecks++;
    }
  }
}
console.log('PASS conservative terrain support across seams, poles and forecast rotation:',{terrainChecks});
