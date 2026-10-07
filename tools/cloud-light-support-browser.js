// Diagnostic only: retain real quantile positions and cache support tests,
// replace missed beams with zero, and output counters instead of radiance.
// No variant of this shader is shipped in the runtime.
export async function probeCloudLightSupport(page) {
  return page.evaluate(async()=>{
    const T=NMS._THREE,r=NMS._renderer,p=NMS._pipeline.volumePass.activePlanet;
    const original=p.volCloudMat,probe=original.clone();probe.uniforms=original.uniforms;
    probe.fragmentShader=probe.fragmentShader
      .replace('vec3 cloudCombinedSource(', 'float diagnosticMisses=0.0,diagnosticQueries=0.0,diagnosticVertical=0.0,diagnosticHorizontal=0.0;\nvec3 cloudCombinedSource(')
      .replace('if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);',
        `diagnosticQueries+=1.0;if(!cached) {
          diagnosticMisses+=1.0;
          vec3 diagnosticA=(uSunCacheMatrixA[path]*vec4(local,1)).xyz;
          vec3 diagnosticB=(uSunCacheMatrixB[path]*vec4(local,1)).xyz;
          float ma=uSunCacheMarginA[path],mb=uSunCacheMarginB[path],mz=.5/uSunCacheDepth;
          if(diagnosticA.z<mz||diagnosticA.z>1.0-mz||diagnosticB.z<mz||diagnosticB.z>1.0-mz)diagnosticVertical+=1.0;
          if(any(lessThan(diagnosticA.xy,vec2(ma)))||any(greaterThan(diagnosticA.xy,vec2(1.0-ma)))
            ||any(lessThan(diagnosticB.xy,vec2(mb)))||any(greaterThan(diagnosticB.xy,vec2(1.0-mb))))diagnosticHorizontal+=1.0;
        }`)
      .replace('void main() {','void diagnosticOriginalMain() {')
      +'\nvoid main(){diagnosticOriginalMain();gl_FragColor=vec4(diagnosticMisses,diagnosticQueries,diagnosticVertical,diagnosticHorizontal);}';
    probe.blending=T.NoBlending;probe.needsUpdate=true;
    const target=new T.WebGLRenderTarget(NMS._pipeline.volumePass.width,NMS._pipeline.volumePass.height,
      {type:T.FloatType,depthBuffer:false});
    const geometry=new T.PlaneGeometry(2,2),scene=new T.Scene(),camera=new T.Camera();
    const material=new T.ShaderMaterial({uniforms:{tInput:{value:NMS._pipeline.volumePass.current.texture}},
      vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=vec4(position.xy,0,1);}',
      fragmentShader:'uniform sampler2D tInput;varying vec2 vUV;void main(){gl_FragColor=texture2D(tInput,vUV);}',
      depthTest:false,depthWrite:false});scene.add(new T.Mesh(geometry,material));
    p.volCloudMat=probe;NMS._pipeline.volumePass.historyValid=false;
    try {
      const frame=NMS._pipeline.volumePass.frame;
      while(NMS._pipeline.volumePass.frame<frame+3)await new Promise(resolve=>requestAnimationFrame(resolve));
      // Read inside one RAF callback so the production frame cannot overwrite
      // the counters between the conversion draw and readback.
      return await new Promise(resolve=>requestAnimationFrame(()=>{
        const saved=r.getRenderTarget(),face=r.getActiveCubeFace(),mip=r.getActiveMipmapLevel();
        r.setRenderTarget(target);r.render(scene,camera);
        const bytes=new Float32Array(target.width*target.height*4);
        r.readRenderTargetPixels(target,0,0,target.width,target.height,bytes);r.setRenderTarget(saved,face,mip);
        let occupied=0,queries=0,misses=0,verticalRejects=0,horizontalRejects=0,allMissPixels=0,allHitPixels=0;
        for(let i=0;i<bytes.length;i+=4)if(bytes[i+1]>0) {
          occupied++;queries+=bytes[i+1];misses+=bytes[i];
          verticalRejects+=bytes[i+2];horizontalRejects+=bytes[i+3];
          if(bytes[i]===bytes[i+1])allMissPixels++;if(bytes[i]===0)allHitPixels++;
        }
        const bank=p.cloudLightBank,u=original.uniforms;
        resolve({width:target.width,height:target.height,occupied,queries,misses,verticalRejects,horizontalRejects,
          missRatio:misses/queries,allMissPixels,allHitPixels,gl:r.getContext().getError(),
          cache:{ready:u.uSunCacheReady.value,validA:u.uSunCacheValidA.value.toArray(),validB:u.uSunCacheValidB.value.toArray(),
            cameraAltitude:u.uCameraLocal.value.length()-p.R,centerAltitude:bank?.center.length()-p.R,
            size:bank?.size,spacing:bank?.spacing,depth:bank?.depth,verticalSpacing:50,outerAltitude:p.volCloudBand.rOut-p.R},
          scope:'Active production cloud quantile/light support on visible occupied rays; missed beams suppressed only in this counter diagnostic, not visual or accuracy evidence.'});
      }));
    } finally {
      p.volCloudMat=original;p.volCloudMesh.material=original;
      NMS._pipeline.volumePass.historyValid=false;
      probe.dispose();target.dispose();geometry.dispose();material.dispose();
    }
  });
}
