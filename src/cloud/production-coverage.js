import { CLOUD_SPECIES } from './cloud-species.js';
import { fibonacciDirections, sampleWeather } from './weather-system.js';
import { writeProductionBands,PRODUCTION_PARAMETER_LAYERS } from './production-bands.js';
import { productionCondensate,absoluteProductionBand,productionAreaBand } from './production-shape.js';
import { sampleWeatherAtlas } from './weather-atlas.js';
import { cloudNoiseImage } from './cloud-noise.js';

// Initialization only. Calibrate AREA using the production condensate and
// extinction, including the atlas's bilinear support. This never changes
// optical coefficients or recalibrates an advancing weather frame.
export function calibrateProductionCoverage(system, offsets, { samples=512, iterations=10 }={}) {
  const width=128,height=64,stride=width*height*4;
  const data=new Float32Array(stride*PRODUCTION_PARAMETER_LAYERS);
  const directions=fibonacciDirections(samples),cells=new Map();
  const columns=directions.map(direction=>{
    const longitude=((Math.atan2(direction.z,direction.x)/(2*Math.PI))%1+1)%1;
    const v=.5-Math.asin(direction.y)/Math.PI;
    const x=Math.floor(longitude*width-.5),y=Math.floor(v*height-.5);
    for(let dy=0;dy<2;dy++)for(let dx=0;dx<2;dx++) {
      const xx=(x+dx+width)%width,yy=Math.max(0,Math.min(height-1,y+dy));
      const lat=(.5-(yy+.5)/height)*Math.PI,lon=(xx+.5)/width*2*Math.PI;
      cells.set(yy*width+xx,{x:Math.cos(lat)*Math.cos(lon),y:Math.sin(lat),z:Math.cos(lat)*Math.sin(lon)});
    }
    const d=[direction.x,direction.y,direction.z];
    const axis=[.8*d[0]-.48*d[1]+.36*d[2],.6*d[0]+.64*d[1]-.48*d[2],.6*d[1]+.8*d[2]];
    return {direction,axis,frame:axis.map((n,i)=>n*system.radiusMeters+offsets[i]*11000)};
  });
  const noise={image:cloudNoiseImage()};
  let low=-2.6,high=2.6,measured=0;
  const started=performance.now();
  for(let iteration=0;iteration<iterations;iteration++) {
    system.coverageBias=(low+high)*.5;
    for(const [cell,direction] of cells) {
      const x=cell%width,north=Math.floor(cell/width);
      writeProductionBands(data,width,height,x,height-1-north,sampleWeather(system,direction,0),direction);
    }
    let occupied=0;
    for(const {direction,axis,frame} of columns) {
      let tau=0;
      const surface=sampleWeather(system,direction,0).elevationMeters;
      for(let i=0;i<CLOUD_SPECIES.length && tau<Math.LN2;i++) {
        const species=CLOUD_SPECIES[i];if(species.family==='special')continue;
        const band=absoluteProductionBand(species,sampleWeatherAtlas({width,height,data:data.subarray(i*stride,(i+1)*stride),scale:1,northFirst:true},direction),surface);
        if(band[0]<.00001 || band[3]<=.12)continue;
        const guard=(species.baseJitter+species.depthJitter)*.5;
        const bottom=Math.max(surface,band[1]-guard),top=band[2]+guard;
        const steps=Math.max(16,Math.ceil((top-bottom)/80)),dt=(top-bottom)/steps;
        const region=productionAreaBand({image:{width,height,data}},direction,0,i);
        for(let k=0;k<steps && tau<Math.LN2;k++) {
          const altitude=bottom+(k+.5)*dt;
          tau+=productionCondensate(species,band,frame,axis,altitude,noise,region).condensate
            *species.extinctionPerKm/1000*dt;
        }
      }
      occupied+=tau>=Math.LN2;
    }
    measured=occupied/samples;
    if(Math.abs(measured-system.targetCoverage)<.01)break;
    if(measured<system.targetCoverage)low=system.coverageBias;else high=system.coverageBias;
  }
  system.measuredCoverage=measured;
  return {kind:'production-optical-area',hours:0,samples,measured,target:system.targetCoverage,
    bias:system.coverageBias,milliseconds:performance.now()-started};
}
