import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';
import { cloudSunCacheSamplingGLSL } from '../src/cloud/cloud-sun-cache.js';
import { directFarLightGrid } from './cloud-far-light-grid.js';
import { interpolateLightMidpoints } from './cloud-light-representation.js';

const logDepth=Math.log(129);
const encode=tau=>Math.log1p(tau)/logDepth;
const decode=value=>Math.expm1(value*logDepth);
const quantize=value=>Math.round(255*value)/255;

function errors(reference,candidate) {
  let nonzero=0;
  const tau=[],transmission=[];
  for(let i=0;i<reference.length;i++) {
    const a=reference[i],b=candidate[i];
    if(!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<0)throw Error('Invalid focused optical depth');
    nonzero+=Number(a>0||b>0);
    tau.push(Math.abs(a-b));
    transmission.push(Math.abs(Math.exp(-a)-Math.exp(-b)));
  }
  const stats=values=>{
    values.sort((a,b)=>a-b);
    return {p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1)};
  };
  return {samples:tau.length,nonzero,tau:stats(tau),transmission:stats(transmission)};
}

// Evaluate the exact weather snapshot of the first focused endpoint against
// its actual R8 atlas, independently of the production HDR replay controls.
export async function measureNearCacheOptics(T,renderer,reference,baked,prepare) {
  if(reference.hours!==baked.hours||reference.size!==baked.size||reference.depth!==baked.depth
    ||reference.center.distanceToSquared(baked.center)!==0||!baked.ready)
    throw Error('Focused optics needs the same baked endpoint');
  const {grid,fields}=await directFarLightGrid(T,renderer,reference,prepare);
  const encoded=baked.encodeOpticalDepth;
  const pack=encoded?encode:value=>value;
  const unpack=encoded?decode:value=>value;
  const span=Math.round(Math.cbrt(grid.nodes.length));
  const points=[...grid.nodes,...grid.midpoints], width=64,height=Math.ceil(points.length/width);
  const positions=new Float32Array(width*height*4);
  points.forEach((p,i)=>positions.set([(p.x+.5)/baked.size,(p.y+.5)/baked.size,(p.z+.5)/baked.depth,1],i*4));
  const coordinates=new T.DataTexture(positions,width,height,T.RGBAFormat,T.FloatType);
  coordinates.needsUpdate=true;
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  const material=new T.ShaderMaterial({
    uniforms:{uCache:{value:baked.target.texture},uPositions:{value:coordinates},
      uDepth:{value:baked.depth},uOffset:{value:baked.tileOffset}},
    vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`uniform sampler2D uCache,uPositions;uniform float uDepth,uOffset;
      ${cloudSunCacheSamplingGLSL}
      void main(){
        vec3 p=texelFetch(uPositions,ivec2(gl_FragCoord.xy),0).xyz;
        vec4 values=vec4(0);
        for(int field=0;field<4;field++)
          values[field]=sampleCloudSunCacheAt(uCache,vec3((float(field)+p.x)/4.0,p.yz),uDepth,uOffset);
        gl_FragColor=values;
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(material);
  try {
    const pixels=await prepare(()=>{
      const data=new Float32Array(width*height*4);
      renderer.setRenderTarget(target);quad.render(renderer);
      renderer.readRenderTargetPixels(target,0,0,width,height,data);
      return data;
    },'near-focused-optical-readback');
    return {hours:baked.hours,spacing:baked.spacing,encoded,center:baked.center.toArray(),fields:fields.map((field,index)=>{
      if(!field)return null;
      const observed=points.map((_,i)=>unpack(pixels[i*4+index]));
      const nodes=observed.slice(0,grid.nodes.length),midpoints=observed.slice(grid.nodes.length);
      const exactStored=field.nodes.map(pack);
      const storedInterpolation=interpolateLightMidpoints(nodes.map(pack),span);
      const lookupDelta=Math.max(...storedInterpolation.map((value,i)=>Math.abs(value-pack(midpoints[i]))));
      if(lookupDelta>(encoded?1.5/255:.002))throw Error('Focused atlas lookup disagrees with its stored nodes');
      return {field:index,
        lookupDelta,
        quantizationAtNodes:errors(field.nodes,encoded?exactStored.map(value=>decode(quantize(value)))
          :exactStored.map(value=>T.DataUtils.fromHalfFloat(T.DataUtils.toHalfFloat(value)))),
        bakeAtNodes:errors(field.nodes,nodes),
        interpolationOfExactNodes:errors(field.midpoints,interpolateLightMidpoints(exactStored,span).map(unpack)),
        combinedAtMidpoints:errors(field.midpoints,midpoints)};
    })};
  } finally {quad.dispose();material.dispose();coordinates.dispose();target.dispose();}
}

// Stratify by the visible ray order and sample the front, middle, and back
// of each selected ray. Reconstruct the exact shader position on the GPU.
export function measureNearVisibleOptics(T,renderer,source,uniforms,{groups,rays}) {
  const occupied=[];
  for(let i=0;i<rays.length;i+=4)if(rays[i+3]===1)occupied.push(i);
  if(!occupied.length)throw Error('No visible near lighting samples');
  const raysToSample=Math.min(256,occupied.length),bins=[0,7,15],width=raysToSample*bins.length;
  const inputs=new Float32Array(width*4);
  for(let i=0;i<raysToSample;i++) {
    const pixel=occupied[Math.floor((i+.5)*occupied.length/raysToSample)];
    bins.forEach((bin,index)=>inputs.set([rays[pixel],rays[pixel+1],rays[pixel+2],groups[bin>>2][pixel+(bin&3)]],
      (i*bins.length+index)*4));
  }
  const samples=new T.DataTexture(inputs,width,1,T.RGBAFormat,T.FloatType);
  samples.needsUpdate=true;
  const target=new T.WebGLRenderTarget(width,4,{type:T.FloatType,depthBuffer:false});
  const prefix=source.fragmentShader.slice(0,source.fragmentShader.lastIndexOf('void main()'));
  const material=new T.ShaderMaterial({
    defines:{...source.defines},uniforms:{...source.uniforms,...uniforms,uOpticalProbePoints:{value:samples}},
    vertexShader:`varying vec3 vDirection,vViewDirection;
      void main(){vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1);}`,
    fragmentShader:prefix+`uniform sampler2D uOpticalProbePoints;
      void main(){
        int path=int(gl_FragCoord.y);
        vec4 ray=texelFetch(uOpticalProbePoints,ivec2(int(gl_FragCoord.x),0),0);
        vec3 local=uCameraLocal+ray.xyz*ray.w;
        vec3 direction=path==0?normalize(uSunDir):path==1?normalize(uSecondarySunDir)
          :path==2?normalize(local):-normalize(local);
        if(path==1 && uSecondarySunEnergy<=0.0){gl_FragColor=vec4(0);return;}
        if(path<2) {
          float radius=length(local),muSun=dot(local/radius,direction);
          float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(radius*radius)));
          if(muSun<=horizon-0.018 || eclipseVisibility(local,direction)<=0.0){gl_FragColor=vec4(0);return;}
        }
        float cached=0.0;
        bool hit=cloudCachedLight(local,path,cached);
        float direct=0.0;
        if(hit)direct=cloudSunOpticalDepthLimit(local,direction,0.0,path<2?12.0:128.0);
        gl_FragColor=vec4(direct,cached,float(hit),1.0);
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(material);
  const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
  try {
    renderer.setRenderTarget(target);quad.render(renderer);
    const pixels=new Float32Array(width*4*4);
    renderer.readRenderTargetPixels(target,0,0,width,4,pixels);
    const fields=Array.from({length:4},(_,field)=>{
      const direct=[],cached=[];
      let requested=0,worst=null;
      for(let i=0;i<width;i++) {
        const index=(field*width+i)*4;
        const [a,b,hit,request]=pixels.subarray(index,index+4);
        if(request!==0&&request!==1||hit!==0&&hit!==1||hit>request)
          throw Error('Invalid visible optical query markers');
        requested+=request;
        if(!hit)continue;
        direct.push(a);cached.push(b);
        const transmission=Math.abs(Math.exp(-a)-Math.exp(-b));
        if(!worst||transmission>worst.transmission)worst={direct:a,cached:b,transmission,bin:bins[i%bins.length]};
      }
      return {field,requested,hit:direct.length,worst,error:direct.length?errors(direct,cached):null};
    });
    if(fields[2].requested!==width||fields[3].requested!==width||!fields.some(row=>row.hit>0))
      throw Error('Visible optical probe missed the actual query population');
    return {sampledRays:raysToSample,bins,cacheMix:uniforms.uSunCacheMix.value,fields};
  } finally {
    renderer.setRenderTarget(saved,face,mip);
    target.dispose();quad.dispose();material.dispose();samples.dispose();
  }
}
