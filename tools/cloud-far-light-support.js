import { compilePrograms } from '../src/program-preparation.js';
import { createCompileCamera } from '../src/render-prewarm.js';
import { VOLUME_LAYER } from '../src/render-layers.js';

function diagnosticShader(source) {
  function replace(from,to) {
    if (source.split(from).length !== 2) throw Error('Expected one Far lighting support anchor');
    source = source.replace(from,to);
  }
  replace('      vec3 cloudCombinedSource(', '      int lightSupport=0;\n      vec3 cloudCombinedSource(');
  replace('          if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);',`          int state=1;
          if(uSunCacheReady>.5) {
            if(uSunCacheValidA[path]<.5 || uSunCacheValidB[path]<.5)state=2;
            else if(cached)state=3;
            else {
              vec3 a=(uSunCacheMatrixA[path]*vec4(local,1)).xyz;
              vec3 b=(uSunCacheMatrixB[path]*vec4(local,1)).xyz;
              float ma=uSunCacheMarginA[path],mb=uSunCacheMarginB[path],mz=.5/uSunCacheDepth;
              bool xy=any(lessThan(a.xy,vec2(ma)))||any(greaterThan(a.xy,vec2(1.0-ma)))
                ||any(lessThan(b.xy,vec2(mb)))||any(greaterThan(b.xy,vec2(1.0-mb)));
              bool z=a.z<mz||a.z>1.0-mz||b.z<mz||b.z>1.0-mz;
              state=4+int(z)+2*int(xy);
            }
          }
          lightSupport|=state<<(path*3);`);
  replace(`        vec3 source=cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);
        vec2 air=air_sphereHits(uCameraLocal,air_uTopR,dir);
        vec3 light,transmission;
        airIntegrate(uCameraLocal,dir,max(0.0,air.x),min(t,air.y),light,transmission);
        return vec4((light+transmission*source*uTint)*moment,moment);`,`        cloudCombinedSource(local,dir,0.0,uRout-uRin,0.0);
        return vec4(local,float(lightSupport+4096));`);
  return source;
}

function summarize(pixels, point, eye, radius) {
  const fields = Array.from({length:4},()=>({
    skipped:0,unbound:0,invalid:0,hit:0,unclassified:0,vertical:0,horizontal:0,both:0,
  }));
  const keys = Object.keys(fields[0]), heights=[], distance=[];
  const up=eye.clone().normalize(), middle=up.clone().multiplyScalar(radius);
  let occupied=0, maskDisagreements=0;
  for (let i=0;i<pixels.length;i+=4) {
    const valid=pixels[i+3]>=4096;
    if (valid!==(point[i+3]>0)) maskDisagreements++;
    if (!valid) continue;
    const bits=pixels[i+3]-4096;
    if (!Number.isInteger(bits) || bits>=4096) throw Error('Invalid light support bit mask');
    occupied++;
    heights.push(Math.hypot(pixels[i],pixels[i+1],pixels[i+2])-radius);
    const x=pixels[i]-middle.x,y=pixels[i+1]-middle.y,z=pixels[i+2]-middle.z;
    const axis=x*up.x+y*up.y+z*up.z;
    distance.push(Math.hypot(x-axis*up.x,y-axis*up.y,z-axis*up.z));
    for (let path=0;path<4;path++) fields[path][keys[(bits>>(path*3))&7]]++;
  }
  if (!occupied || maskDisagreements) throw Error(`Light support occupancy mismatch (${maskDisagreements})`);
  const quantiles=values=>{
    values.sort((a,b)=>a-b);
    return [0,.5,.9,.99,1].map(p=>values[Math.floor(p*(values.length-1))]);
  };
  return {occupied,maskDisagreements,fields,quantiles:[0,.5,.9,.99,1],
    altitudeMeters:quantiles(heights),tangentDistanceMeters:quantiles(distance)};
}

// A single private draw with the actual Far geometry, depth, density moment,
// light visibility and cache support predicate. No optical fallback is drawn.
export async function measureFarLightSupport(game) {
  const { _pipeline:pipeline,_renderer:renderer,_THREE:T }=game;
  const pass=pipeline.volumePass, {farSplit:split,scene,camera,current}=pass;
  const {mesh}=split.plan??{mesh:pass.activePlanet.volCloudMesh};
  const original=split.materials.point, owner=pass.activePlanet;
  const material=new T.ShaderMaterial().copy(Object.assign(Object.create(original),{uniforms:{}}));
  const source=new T.Group(),proxy=new T.Mesh(mesh.geometry,material);
  proxy.layers.set(VOLUME_LAYER);source.add(proxy);
  const target=new T.WebGLRenderTarget(current.width,current.height,{type:T.FloatType,depthBuffer:false});
  const profile=pass.profilePhase, gl=renderer.getContext();
  let deadline, hook;
  try {
    material.fragmentShader=diagnosticShader(original.fragmentShader);
    Object.assign(material.uniforms,original.uniforms);
    await pipeline.prepare(()=>{
      const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
      renderer.setRenderTarget(target);
      try { return compilePrograms(renderer,source,createCompileCamera(camera,VOLUME_LAYER),scene); }
      finally { renderer.setRenderTarget(saved,face,mip); }
    },{label:'far-light-support'});
    return await new Promise((resolve,reject)=>{
      deadline=setTimeout(()=>reject(Error('No matching live Far support frame')),30000);
      hook=function(name,work,options) {
        const result=profile.call(this,name,work,options);
        if(name!=='volume-current'||split.lastRoute!=='combine'||split.plan?.mesh!==mesh) return result;
        pass.profilePhase=profile;
        const previous=mesh.material, saved=renderer.getRenderTarget();
        const face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel(),auto=renderer.autoClear;
        try {
          if(pass.activePlanet!==owner || pass.current!==current || split.materials.point!==original)
            throw Error('Far support inputs changed');
          const points=new Float32Array(target.width*target.height*4), pixels=new Float32Array(points.length);
          renderer.readRenderTargetPixels(split.scratch[0],0,0,target.width,target.height,points);
          Object.assign(material.uniforms,original.uniforms);
          material.uniformsNeedUpdate=true;mesh.material=material;
          renderer.setRenderTarget(target);renderer.autoClear=false;
          renderer.clear(true,false,false);renderer.render(scene,camera);
          renderer.readRenderTargetPixels(target,0,0,target.width,target.height,pixels);
          const uniforms=material.uniforms, eye=uniforms.uCameraLocal.value;
          resolve({frame:pass.frame,dimensions:[target.width,target.height],hours:owner.weatherHours,
            eyeAltitude:eye.length()-owner.R,cacheReady:uniforms.uSunCacheReady.value,
            bank:owner.cloudLightBank ? {size:owner.cloudLightBank.size,spacing:owner.cloudLightBank.spacing} : null,
            ...summarize(pixels,points,eye,owner.R),gl:gl.getError(),lost:gl.isContextLost()});
        } catch(error) { reject(error); }
        finally { mesh.material=previous;renderer.autoClear=auto;renderer.setRenderTarget(saved,face,mip); }
        return result;
      };
      pass.profilePhase=hook;
    });
  } finally {
    clearTimeout(deadline);
    if(pass.profilePhase===hook) pass.profilePhase=profile;
    material.dispose();target.dispose();
  }
}
