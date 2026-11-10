import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';

const sampler=`      uniform int uGateField;
      vec2 probeLightVariation(vec3 local) {
        int field=uGateField;
        if(field<2) {
          if(field==1 && uSecondarySunEnergy<=0.0)return vec2(0);
          vec3 direction=normalize(field==0?uSunDir:uSecondarySunDir);
          float radius=length(local),muSun=dot(local/radius,direction);
          float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(radius*radius)));
          if(muSun<=horizon-0.018 || eclipseVisibility(local,direction)<=0.0)return vec2(0);
        }
        vec3 uv=(uSunCacheMatrixA[field]*vec4(local,1)).xyz;
        float margin=uSunCacheMarginA[field],mz=.5/uSunCacheDepth;
        if(any(lessThan(uv,vec3(margin,margin,mz)))
          ||any(greaterThan(uv,vec3(1.0-margin,1.0-margin,1.0-mz))))return vec2(0);
        int size=textureSize(uSunTransport,0).x/32,depth=int(uSunCacheDepth);
        ivec3 base=ivec3(floor(uv*vec3(float(size),float(size),float(depth))-.5));
        float lo=1e10,hi=0.0;
        // Include the entire bilinear × cubic stencil, not just the eight
        // corners between which the interpolation is evaluated.
        for(int z=-1;z<=2;z++) {
          int tile=field*depth+clamp(base.z+z,0,depth-1);
          ivec2 origin=ivec2(tile%32,tile/32)*size;
          for(int y=0;y<2;y++)for(int x=0;x<2;x++){
            ivec2 p=clamp(base.xy+ivec2(x,y),ivec2(0),ivec2(size-1));
            float depthValue=texelFetch(uSunTransport,origin+p,0).r;
            float value=field<2?exp(-depthValue):depthValue;
            lo=min(lo,value);hi=max(hi,value);
          }
        }
        return vec2(hi-lo,1);
      }
`;

const end=`        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);`;

export function makeFarLightGate(T,original,mesh,pass) {
  const entry='      vec4 cloudFarColumn(vec3 dir, float start, float end) {';
  const shader=original.fragmentShader;
  if(shader.split(entry).length!==2||shader.split(end).length!==2)
    throw Error('Missing Far light variation boundary');
  const material=new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
  material.fragmentShader=shader.replace(entry,sampler+entry).replace(end,
    '        return vec4(probeLightVariation(local),0,moment);');
  Object.assign(material.uniforms,original.uniforms,{uGateField:{value:0}});
  const proxy=new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);
  const camera=createCompileCamera(pass.camera,VOLUME_LAYER);
  return {material,compile:renderer=>compilePrograms(renderer,proxy,camera,pass.scene),
    dispose:()=>material.dispose()};
}

export function summarizeFarLightGate(field,probe,point,original,candidate,fromHalf) {
  const limits=field<2?[.002,.005,.01,.02,.05,.1,.2,.5]:[.005,.01,.025,.05,.1,.25,.5,1,2,4];
  const thresholds=limits.map(limit=>({limit,admitted:0,overGate:0,maxError:0}));
  const result={field,nonempty:0,supported:0,maskDisagreement:0,pointAlphaChanged:0,
    outsideChanges:0,supportedOverGate:0,thresholds};
  for(let i=0;i<point.length;i+=4) {
    const occupied=point[i+3]>0, support=probe[i+1]===1;
    if(occupied)result.nonempty++;
    if(occupied!==(probe[i+3]>0))result.maskDisagreement++;
    if(point[i+3]!==probe[i+3])result.pointAlphaChanged++;
    let error=0;
    for(let c=0;c<3;c++)error=Math.max(error,Math.abs(fromHalf(original[i+c])-fromHalf(candidate[i+c])));
    if(!Number.isFinite(error))throw Error('Non-finite Far light gate image');
    if(!support) {if(error>0)result.outsideChanges++;continue;}
    const variation=probe[i];
    if(!Number.isFinite(variation)||variation<0)throw Error('Invalid Far light gate variation');
    result.supported++;
    if(error>.002)result.supportedOverGate++;
    for(const row of thresholds)if(variation<=row.limit) {
      row.admitted++;
      if(error>.002)row.overGate++;
      row.maxError=Math.max(row.maxError,error);
    }
  }
  return result;
}
