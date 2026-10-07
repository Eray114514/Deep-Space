// Compact production weather forecasts. Terrain bytes are the same regional
// Planet.height source as the initial atlas, never the standalone fake terrain.
import { createWeatherSystem, sampleWeather } from './weather-system.js';
import { sampleWeatherAtlas } from './weather-atlas.js';
import { buildProductionBands } from './production-bands.js';

let system, descriptor;
const rotate = (d, a) => ({ x: Math.cos(a)*d.x+Math.sin(a)*d.z,
  y:d.y, z:-Math.sin(a)*d.x+Math.cos(a)*d.z });
const clamp = x => Math.max(0,Math.min(1,x));
self.onmessage = ({ data }) => {
  try {
    if(data.type === 'init') {
      descriptor = data.descriptor;
      system = createWeatherSystem(descriptor.seed, { ...descriptor.options,
        calibrationSamples: 64, calibrationIterations: 1,
        terrain(d) { const [elevationMeters,elevation01,oceanic]=sampleWeatherAtlas(descriptor.terrain,d);
          return { elevationMeters,elevation01,oceanic }; } });
      // Initialization calibration belongs to the field owner, not each job.
      system.coverageBias=descriptor.coverageBias;
      system.advectionRadiansPerHour=descriptor.angularSpeed;
      return;
    }
    const { token, hours, width, surfaceRange }=data;
    system.lightDirectionsAt=()=>data.stellarDirections;
    const height=width/2, low=new Float32Array(width*height*4), high=new Float32Array(low.length);
    const wind=new Float32Array(low.length);
    for(let y=0;y<height;y++) for(let x=0;x<width;x++) {
      const latitude=((y+.5)/height-.5)*Math.PI,longitude=(x+.5)/width*Math.PI*2;
      const direction={x:Math.cos(latitude)*Math.cos(longitude),y:Math.sin(latitude),z:Math.cos(latitude)*Math.sin(longitude)};
      const physical=rotate(direction,hours*descriptor.angularSpeed);
      const w=sampleWeather(system,physical,hours),k=(y*width+x)*4;
      wind.set([w.windVector.x*w.windSpeedMs,w.windVector.y*w.windSpeedMs,w.windVector.z*w.windSpeedMs,
        Math.min(1,(w.speciesWeights.nimbostratus||0)*.8+(w.speciesWeights.cumulonimbus||0)+(w.speciesWeights.cumulusCongestus||0)*.5)],k);
      low.set([clamp(.5+w.lowPotential/4),w.convective,w.stability*(1-w.convective),w.humidity],k);
      const surface=sampleWeatherAtlas(descriptor.terrain,direction)[0];
      high.set([clamp(.5+w.highPotential/4),clamp(.5+surface/(2*surfaceRange)),
        w.convective,clamp((w.lclMeters-350)/3850)],k);
    }
    const packed=buildProductionBands(d=>sampleWeather(system,rotate(d,hours*descriptor.angularSpeed),hours),128,descriptor.terrain,
      {spin:hours*descriptor.angularSpeed,angularGuard:Math.abs(descriptor.angularSpeed)*data.frameHours});
    const bands=packed.data,bounds=packed.bounds,candidates=packed.candidates;
    self.postMessage({ token,hours,width,height,low,high,bands,wind,bounds,candidates },[low.buffer,high.buffer,bands.buffer,wind.buffer,bounds.buffer,candidates.buffer]);
  } catch(error) { self.postMessage({ token:data.token,hours:data.hours,error:String(error.stack||error) }); }
};
