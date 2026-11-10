import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';
import { createCloudSunSweepMaterial } from '../src/cloud/cloud-sun-programs.js';
import { cloudSunCacheSamplingGLSL } from '../src/cloud/cloud-sun-cache.js';

function interpolate(nodes,[x,y,z]) {
  const mix=(a,b,t)=>a+(b-a)*t;
  const plane=k=>mix(mix(nodes[4*k],nodes[4*k+1],x),mix(nodes[4*k+2],nodes[4*k+3],x),y);
  const [a,b,c,d]=[0,1,2,3].map(plane), delta=c-b;
  const tangent=slope=>Math.abs(delta)<1e-6?0:Math.max(0,Math.min(3,slope/delta))*delta;
  const z2=z*z,z3=z2*z;
  return Math.max(0,(2*z3-3*z2+1)*b+(z3-2*z2+z)*tangent((c-a)*.5)
    +(-2*z3+3*z2)*c+(z3-z2)*tangent((d-b)*.5));
}

// Sample the actual 2x2x4 interpolation stencil of each selected radial ray.
// The frozen arm differs only in the source data read by the same beam code.
export function measureNearNeighbors(T,renderer,source,cacheUniforms,reference,inputs,selected) {
  if(cacheUniforms.uSunCacheMix.value!==0||selected.length===0)
    throw Error('Near neighbor decomposition needs a single endpoint with visible radial hits');
  const matrices=cacheUniforms.uSunCacheMatrixA.value;
  if(!matrices[2].equals(matrices[3])||!reference.frames[2].equals(reference.frames[3]))
    throw Error('Near radial fields do not share a grid');
  const height=selected.length,width=18;
  const bytes=new Float32Array(height*8);
  selected.forEach(({sample,field},i)=>{
    bytes.set(inputs.subarray(sample*4,sample*4+4),8*i);
    bytes[8*i+4]=field;
  });
  const points=new T.DataTexture(bytes,2,height,T.RGBAFormat,T.FloatType);
  points.needsUpdate=true;
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const beamTarget=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const snapshot=reference.material.uniforms;
  const uniforms={...cacheUniforms,uCameraLocal:source.uniforms.uCameraLocal,uNeighborPoints:{value:points},
    uNeighborOrigin:{value:reference.center},uNeighborBasis:{value:reference.frames[2]},
    uNeighborProjection:{value:matrices[2]},
    uNeighborSize:{value:reference.size},uNeighborSpacing:{value:reference.spacing},
    uNeighborVertical:{value:reference.verticalSpacing},uNeighborDepth:{value:reference.depth},
    uNeighborReadAtlas:{value:1}};
  const material=new T.ShaderMaterial({
    uniforms,
    vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`
      uniform sampler2D uNeighborPoints,uSunTransport;
      uniform vec2 uSunCacheOffsets;
      uniform float uSunCacheDepth;
      uniform vec3 uCameraLocal;
      uniform vec3 uNeighborOrigin;
      uniform mat3 uNeighborBasis;
      uniform mat4 uNeighborProjection;
      uniform float uNeighborSize,uNeighborSpacing,uNeighborVertical,uNeighborDepth,uNeighborReadAtlas;
      ${cloudSunCacheSamplingGLSL}
      void main(){
        int row=int(gl_FragCoord.y), lane=int(gl_FragCoord.x);
        vec4 ray=texelFetch(uNeighborPoints,ivec2(0,row),0);
        int path=int(texelFetch(uNeighborPoints,ivec2(1,row),0).x);
        vec3 local=uCameraLocal+ray.xyz*ray.w;
        vec3 coordinate=(uNeighborProjection*vec4(local,1)).xyz;
        vec3 size=vec3(vec2(uNeighborSize),uNeighborDepth);
        vec3 grid=coordinate*size-.5;
        if(lane==17){gl_FragColor=vec4(fract(grid),1);return;}
        float stored=0.0;
        if(lane==0){
          if(uNeighborReadAtlas>.5)stored=sampleCloudSunCacheAt(uSunTransport,
            vec3((float(path)+coordinate.x)/4.0,coordinate.yz),uSunCacheDepth,uSunCacheOffsets.x);
        } else {
          int tap=lane-1;
          vec3 index=clamp(floor(grid)+vec3(tap%2,tap/2%2,tap/4-1),vec3(0),size-1.0);
          vec3 uv=(index+.5)/size;
          local=uNeighborOrigin+uNeighborBasis*((index+.5-size*.5)
            *vec3(vec2(uNeighborSpacing),uNeighborVertical));
          if(uNeighborReadAtlas>.5)stored=cloudSunCachePlaneAt(uSunTransport,
            vec3((float(path)+uv.x)/4.0,uv.yz),uSunCacheDepth,index.z,uSunCacheOffsets.x);
        }
        gl_FragColor=vec4(local,stored);
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(material);
  const beamUniforms={...source.uniforms,uNeighborPoints:{value:points},uNeighborPositions:{value:target.texture}};
  const beam=createCloudSunSweepMaterial(beamUniforms);
  beam.fragmentShader=beam.fragmentShader.slice(0,beam.fragmentShader.lastIndexOf('void main()'))+`
    uniform sampler2D uNeighborPoints,uNeighborPositions;
    void main(){
      ivec2 pixel=ivec2(gl_FragCoord.xy);
      if(pixel.x==17){gl_FragColor=vec4(0);return;}
      float path=texelFetch(uNeighborPoints,ivec2(1,pixel.y),0).x;
      vec3 local=texelFetch(uNeighborPositions,pixel,0).xyz;
      float direct=cloudSunOpticalDepthLimit(local,normalize(local)*(path==2.0?1.0:-1.0),0.0,128.0);
      gl_FragColor=vec4(direct,0.0,1.0,0.0);
    }`;
  const beamQuad=new OwnedScreenTriangle(beam);
  const gl=renderer.getContext();
  const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
  const mode=cacheUniforms.uSunCacheEncoded.value>.5, log=Math.log(129);
  const encode=mode?v=>Math.log1p(v)/log:v=>v;
  const decode=mode?v=>Math.expm1(v*log):v=>v;
  const check=label=>{
    const error=gl.getError();
    if(error)throw Error('Near neighbor '+label+' WebGL '+error);
  };
  const draw=(label,outputTarget,screen)=>{
    const output=new Float32Array(width*height*4);
    renderer.setRenderTarget(outputTarget);screen.render(renderer);
    check(label+' draw');
    renderer.readRenderTargetPixels(outputTarget,0,0,width,height,output);
    check(label+' read');
    return output;
  };
  const keys=['uSpin','uCloudAdvectionPhase','uSpeciesMap','uBandBounds','uBandCandidates','uWeatherMapHi'];
  try {
    check('before draw');
    const geometry=draw('atlas',target,quad);
    const live=draw('live',beamTarget,beamQuad);
    for(const key of keys)beamUniforms[key]=snapshot[key];
    beam.uniformsNeedUpdate=true;
    const frozen=draw('frozen',beamTarget,beamQuad);
    const original=selected.map((entry,row)=>{
      const start=row*width*4, fraction=Array.from(geometry.subarray(start+68,start+71));
      const exact=[],stored=[];
      for(let lane=1;lane<17;lane++) {
        const i=start+lane*4;
        if(live[i+2]!==1||frozen[i+2]!==1)throw Error('Near neighbor direct query was not drawn');
        exact.push(encode(frozen[i]));stored.push(geometry[i+3]);
      }
      const reconstructed=interpolate(stored,fraction);
      if(Math.abs(reconstructed-geometry[start+3])>(mode?1.5/255:.002))
        throw Error('Near neighbor interpolation did not reproduce the actual atlas query');
      return {...entry,fraction,liveDirect:live[start],frozenDirect:frozen[start],
        exactNodes:decode(interpolate(exact,fraction)),stored:decode(geometry[start+3])};
    });
    uniforms.uNeighborReadAtlas.value=0;
    for(const [horizontal,vertical] of [[2,1],[4,1],[8,1],[1,2]]) {
      uniforms.uNeighborSize.value=reference.size*horizontal;
      uniforms.uNeighborDepth.value=reference.depth*vertical;
      uniforms.uNeighborSpacing.value=reference.spacing/horizontal;
      uniforms.uNeighborVertical.value=reference.verticalSpacing/vertical;
      material.uniformsNeedUpdate=true;
      const positions=draw('refined grid',target,quad),direct=draw('refined direct',beamTarget,beamQuad);
      original.forEach((entry,row)=>{
        const start=row*width*4,fraction=Array.from(positions.subarray(start+68,start+71));
        if(direct[start]!==entry.frozenDirect)throw Error('Grid refinement changed the query position');
        const exact=Array.from({length:16},(_,tap)=>encode(direct[start+(tap+1)*4]));
        (entry.refined??=[]).push({horizontalMeters:uniforms.uNeighborSpacing.value,
          verticalMeters:uniforms.uNeighborVertical.value,exactNodes:decode(interpolate(exact,fraction))});
      });
    }
    return original;
  } finally {
    renderer.setRenderTarget(saved,face,mip);
    quad.dispose();material.dispose();target.dispose();points.dispose();
    beamQuad.dispose();beam.dispose();beamTarget.dispose();
  }
}
