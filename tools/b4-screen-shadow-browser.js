// Read the actual screen transport against full physical beams at opaque
// points. Near/resolved and far/unresolved errors are reported separately.
export async function probeSurfaceCloudShadow({count=512}={}) {
  const T=NMS._THREE,r=NMS._renderer,p=NMS._pipeline.volumePass.activePlanet;
  const cache=NMS._pipeline.cloudSurfaceShadow;
  if(!cache.ready || cache.owner!==p)throw Error('No current screen shadow owner');
  const {surfaceCloudGLSL,surfaceCloudUniforms,bindSurfaceClouds}=await import('/src/cloud/surface-clouds.js?screen-probe=1');
  const {weatherAtlasGLSL}=await import('/src/cloud/weather-atlas.js');
  const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
  const u=surfaceCloudUniforms(p);bindSurfaceClouds(u,p,r,cache.camera);
  Object.assign(u,{tProbeDepth:{value:cache.material.uniforms.tOpaqueDepth.value},
    uProbeSize:{value:cache.viewport},uProbeRotation:{value:cache.receiverTransforms?.get(p)?.clone()
      || cache.material.uniforms.uViewToLocal.value.clone()},
    uProbeInvProjection:cache.material.uniforms.uInvProjection,uProbeCount:{value:count},uProbeStar:{value:0}});
  const material=new T.ShaderMaterial({defines:{SURFACE_CLOUD_MEDIUM:1},uniforms:u,
    depthTest:false,depthWrite:false,vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`${weatherAtlasGLSL}\n${surfaceCloudGLSL}
      uniform sampler2D tProbeDepth;uniform vec2 uProbeSize;uniform mat3 uProbeRotation;
      uniform mat4 uProbeInvProjection;uniform float uProbeCount;uniform int uProbeStar;
      vec3 pointAt(ivec2 pixel) {
        float z=texelFetch(tProbeDepth,pixel,0).r;
        vec2 uv=(vec2(pixel)+.5)/uProbeSize;
        vec4 v=uProbeInvProjection*vec4(uv*2.0-1.0,1,1);
        return cloud_uCameraLocal+uProbeRotation*(v.xyz/abs(v.z))*(pow(cloud_uCameraFar+1.0,z)-1.0);
      }
      void main() {
        float i=floor(gl_FragCoord.x);
        vec2 uv=vec2(fract((i+.5)*.61803398875),fract((i+.5)*.41421356237));
        ivec2 pixel=clamp(ivec2(uv*uProbeSize),ivec2(0),ivec2(uProbeSize)-1);
        float depth=texelFetch(tProbeDepth,pixel,0).r;
        if(depth>=.999999){gl_FragColor=vec4(1,1,-1,0);return;}
        vec3 point=pointAt(pixel);
        float cached;bool hit=cloudScreenShadowAt((vec2(pixel)+.5)/uProbeSize,depth,uProbeStar,cached);
        vec3 direction=normalize(uProbeStar==0?cloud_uSunDir:cloud_uSecondarySunDir);
        float physical=exp(-cloudSunOpticalDepth(point,direction,0.0));
        float footprint=length(pointAt(min(pixel+ivec2(1,0),ivec2(uProbeSize)-1))-point);
        gl_FragColor=vec4(cached,physical,hit?footprint:-1.0,1);
      }`});
  scene.add(new T.Mesh(geometry,material));
  const target=new T.WebGLRenderTarget(count,1,{type:T.FloatType,depthBuffer:false});
  const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
  const records=[],raw=[];
  try {
    // Composer targets are reused and their depth is cleared by later passes.
    // Read while the current prepass depth is valid, before main composition.
    await new Promise((resolve,reject)=>{
      const original=cache.render;
      cache.render=function(...args) {
        cache.render=original;
        const result=original.apply(this,args),old=r.getRenderTarget();
        try {
          bindSurfaceClouds(u,p,r,cache.camera);
          u.tProbeDepth.value=cache.material.uniforms.tOpaqueDepth.value;
          u.uProbeRotation.value.copy(cache.receiverTransforms?.get(p)||cache.material.uniforms.uViewToLocal.value);
          for(let star=0;star<2;star++) {
            u.uProbeStar.value=star;r.setRenderTarget(target);r.render(scene,camera);
            const pixels=new Float32Array(count*4);r.readRenderTargetPixels(target,0,0,count,1,pixels);
            const gl=r.getContext(),program=r.properties.get(material).currentProgram;
            raw.push({star,first:Array.from(pixels.slice(0,32)),last:Array.from(pixels.slice(-16)),
              maximumAlpha:Math.max(...pixels.filter((_,i)=>i%4===3)),error:gl.getError(),
              linked:program&&gl.getProgramParameter(program.program,gl.LINK_STATUS),
              programLog:program&&gl.getProgramInfoLog(program.program),
              fragmentLog:program&&gl.getShaderInfoLog(program.fragmentShader)});
            if(!program || !gl.getProgramParameter(program.program,gl.LINK_STATUS))
              throw Error('Screen shadow probe did not link: '+raw.at(-1).fragmentLog);
            for(let i=0;i<count;i++)if(pixels[i*4+3]===1)records.push({star,i,
              cached:pixels[i*4],physical:pixels[i*4+1],footprint:pixels[i*4+2]});
          }
          resolve();
        } catch(error) {reject(error);} finally {r.setRenderTarget(old);}
        return result;
      };
    });
  } finally {
    r.setRenderTarget(saved,face,mip);geometry.dispose();material.dispose();target.dispose();
  }
  const summarise=a=>({count:a.length,maxError:Math.max(0,...a.map(x=>Math.abs(x.cached-x.physical))),
    meanError:a.reduce((sum,x)=>sum+Math.abs(x.cached-x.physical),0)/Math.max(1,a.length)});
  if(records.length<16)throw Error('Screen shadow probe must contain opaque samples');
  return {records,raw,summary:{body:p.bodyId,hours:p.weatherHours,grid:[cache.target.width,cache.target.height],raw,
    opaque:records.length,hits:records.filter(x=>x.footprint>=0).length,
    resolved:summarise(records.filter(x=>x.footprint>=0&&x.footprint<=50)),
    unresolved:summarise(records.filter(x=>x.footprint>50))}};
}
