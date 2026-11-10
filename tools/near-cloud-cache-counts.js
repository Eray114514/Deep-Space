export function nearCacheCountsShader(source) {
  const lookup='          if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
  const start=source.indexOf('        vec3 correction=vec3(0);',source.indexOf('        float alpha=totalOpacity*uEngage;'));
  const output='        gl_FragColor = vec4(correction * uEngage, alpha);';
  const end=source.indexOf(output,start);
  if(source.split(lookup).length!==2||start<0||end<0)throw Error('Unexpected near cache count shader boundary');
  return ('vec4 nearCacheCounts=vec4(0.0);\n'+source.slice(0,start)+`        for(int bin=0;bin<bins;bin++) {
          vec3 local=uCameraLocal+dir*anchors[bin];
          cloudCombinedSource(local,dir,0.0,thick,sigma);
        }
        gl_FragColor=nearCacheCounts;`+source.slice(end+output.length))
    .replace(lookup,'          nearCacheCounts[path]+=cached?1.0:32.0;');
}

export function sumNearCacheCounts(pixels,half) {
  const hits=[0,0,0,0],misses=[0,0,0,0];
  let rays=0;
  for(let i=0;i<pixels.length;i+=4) {
    let occupied=false;
    for(let field=0;field<4;field++) {
      const packed=half(pixels[i+field]);
      const hit=packed%32,miss=Math.floor(packed/32);
      if(!Number.isInteger(packed)||packed<0||hit+miss>16||(field>=2&&hit+miss!==0&&hit+miss!==16))
        throw Error('Invalid near cache counter');
      hits[field]+=hit;misses[field]+=miss;occupied||=packed>0;
    }
    rays+=Number(occupied);
  }
  if(!rays||hits[2]+misses[2]!==rays*16||hits[3]+misses[3]!==rays*16)
    throw Error('Near cache count lost occupied radial rays');
  return {rays,hits,misses};
}
