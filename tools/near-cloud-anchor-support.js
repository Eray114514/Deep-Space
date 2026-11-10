import { nearCacheCountsShader } from './near-cloud-cache-counts.js';

export function nearAnchorSupportShader(fragment) {
  const source=nearCacheCountsShader(fragment);
  const output=`        for(int bin=0;bin<bins;bin++) {
          vec3 local=uCameraLocal+dir*anchors[bin];
          cloudCombinedSource(local,dir,0.0,thick,sigma);
        }
        gl_FragColor=nearCacheCounts;`;
  if(source.split(output).length!==2)throw Error('Unexpected near anchor support shader boundary');
  return source.replace(output,`        vec4 range=vec4(1e6,-1e6,1e6,-1e6);
        vec3 radial=normalize(uCameraLocal);
        for(int bin=0;bin<bins;bin++) {
          vec3 local=uCameraLocal+dir*anchors[bin];
          float height=(length(local)-uBodyR)*.001;
          float tangent=length(local-radial*dot(local,radial))*.001;
          range=vec4(min(range.x,height),max(range.y,height),min(range.z,tangent),max(range.w,tangent));
        }
        gl_FragColor=range;`);
}

export function nearAnchorSupportSummary(pixels,half,owner) {
  const bank=owner.cloudLightBank;
  const maps=[...bank.maps.values()].filter(map=>map.ready).map(map=>({hours:map.hours,
    centerKm:(map.center.length()-owner.R)/1000,verticalKm:map.depth*map.verticalSpacing/1000,
    widthKm:map.size*map.spacing/1000,available:map.available,margins:map.interiorMargins}));
  if(maps.length<2)throw Error('Near anchor support needs two published cache endpoints');
  const samples=[[],[],[],[]];
  const horizontalKm=maps[0].widthKm*(.5-maps[0].margins[2])*Math.SQRT2;
  let possiblyWithinRadialFootprint=0;
  for(let i=0;i<pixels.length;i+=4) {
    if(!pixels[i+3])continue;
    for(let k=0;k<4;k++) {
      const value=half(pixels[i+k]);
      if(!Number.isFinite(value))throw Error('Invalid near anchor range');
      samples[k].push(value);
    }
    if(samples[2].at(-1)<=horizontalKm)possiblyWithinRadialFootprint++;
  }
  const quantiles=values=>{
    values.sort((a,b)=>a-b);
    return [0,.05,.5,.95,1].map(p=>values[Math.round((values.length-1)*p)]);
  };
  if(!samples[0].length)throw Error('Missing near cloud anchor ranges');
  return {maps,outerKm:(owner.volCloudMat.uniforms.uRout.value-owner.R)/1000,
    occupiedRays:samples[0].length,quantiles:[0,.05,.5,.95,1],
    minHeightKm:quantiles(samples[0]),maxHeightKm:quantiles(samples[1]),
    minTangentKm:quantiles(samples[2]),maxTangentKm:quantiles(samples[3]),horizontalKm,possiblyWithinRadialFootprint};
}
