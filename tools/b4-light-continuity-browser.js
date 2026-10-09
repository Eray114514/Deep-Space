// Compare the actual bound cache and its physical fallback at identical points.
export async function compareCloudLight({badControl=false,center=null,extent=null}={}) {
  const T=NMS._THREE,r=NMS._renderer,p=NMS._planet(0),m=p.volCloudMat;
  const bank=p.cloudLightBank;
  if(!bank || m.uniforms.uSunCacheReady.value<.5)throw Error('Live light bank is not ready');
  const width=16,height=16;
  const u={...m.uniforms,uProbeCenter:{value:center?new T.Vector3().fromArray(center):bank.center.clone()},
    uProbeBasis:{value:bank.maps.values().next().value.frames[2]},
    uProbeExtent:{value:extent??bank.size*bank.spacing*.8},uProbeMode:{value:0},
    uSunCacheReady:{value:1}};
  let prefix=m.fragmentShader.slice(0,m.fragmentShader.lastIndexOf('void main()'))
    .replace('vec3 cloudCombinedSource(', 'vec4 probeCombinedDepths;\nvec3 cloudCombinedSource(')
    .replace('cloudVerticalAbove=depths.z;', 'probeCombinedDepths=depths;cloudVerticalAbove=depths.z;');
  if(badControl)prefix=prefix.replace(
    /float pathDepth=0\.0;[\s\S]*?depths\[path\]=pathDepth;/,
    'if(!cloudCachedLight(local,path,depths[path]))depths[path]=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);');
  const material=new T.ShaderMaterial({defines:{...m.defines},uniforms:u,
    vertexShader:'varying vec3 vDirection,vViewDirection;void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:prefix+`uniform vec3 uProbeCenter;uniform mat3 uProbeBasis;
      uniform float uProbeExtent,uProbeMode;
      void main(){vec2 xy=(gl_FragCoord.xy/16.0-.5)*uProbeExtent;
        vec3 point=uProbeCenter+uProbeBasis*vec3(xy,0.0);
        if(uProbeMode<.5){gl_FragColor=vec4(cloudCombinedSource(point,-normalize(point),0.0,uRout-uRin,0.0),cloudExtinctionAt(point,0.0));}
        else if(uProbeMode>1.5){vec3 unused=cloudCombinedSource(point,-normalize(point),0.0,uRout-uRin,0.0);gl_FragColor=probeCombinedDepths+vec4(unused,0.0)*0.0;}
        else {vec4 depths=vec4(0);for(int path=0;path<4;path++){
          vec3 direction=path==0?normalize(uSunDir):path==1?normalize(uSecondarySunDir):path==2?normalize(point):-normalize(point);
          if(uSunCacheReady<.5 || !cloudCachedLight(point,path,depths[path])) depths[path]=cloudSunOpticalDepthLimit(point,direction,0.0,path<2?12.0:128.0);
        }gl_FragColor=depths;}}
      `,depthTest:false,depthWrite:false,blending:T.NoBlending});
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const geometry=new T.PlaneGeometry(2,2),mesh=new T.Mesh(geometry,material),scene=new T.Scene(),camera=new T.Camera();scene.add(mesh);
  const saved=r.getRenderTarget(),outputs=[];
  try {
    for(const mode of [0,1,2])for(const enabled of [0,1]) {
      u.uProbeMode.value=mode;u.uSunCacheReady.value=enabled;
      r.setRenderTarget(target);r.render(scene,camera);
      const pixels=new Float32Array(width*height*4);r.readRenderTargetPixels(target,0,0,width,height,pixels);
      outputs.push(Array.from(pixels));
    }
  } finally {r.setRenderTarget(saved);target.dispose();geometry.dispose();material.dispose();}
  const records=Array.from({length:width*height},(_,i)=>({i,
    sourceFull:outputs[0].slice(i*4,i*4+3),sourceCache:outputs[1].slice(i*4,i*4+3),
    extinction:outputs[0][i*4+3],full:outputs[2].slice(i*4,i*4+4),cache:outputs[3].slice(i*4,i*4+4),
    combinedFull:outputs[4].slice(i*4,i*4+4),combinedCache:outputs[5].slice(i*4,i*4+4)}));
  for(const item of records)item.error=Math.max(...item.sourceFull.map((v,j)=>Math.abs(v-item.sourceCache[j])));
  records.sort((a,b)=>b.error-a.error);
  return {badControl,center:bank.center.toArray(),spacing:bank.spacing,ready:m.uniforms.uSunCacheReady.value,
    cacheDirections:[...bank.maps.values()][0].directions.map(d=>d.toArray()),sun:m.uniforms.uSunDir.value.toArray(),
    maximumError:records[0].error,occupied:records.filter(v=>v.extinction>.0001).length,records};
}
