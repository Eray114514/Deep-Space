import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';
import { createCloudSunSweepMaterial } from '../src/cloud/cloud-sun-programs.js';
import { cloudSunCacheSamplingGLSL } from '../src/cloud/cloud-sun-cache.js';

const span=10;
const names=['primary','secondary','outward','inward'];

function centralGrid(T,cache) {
  const x=cache.size/2-span/2, z=cache.depth/2-span/2;
  const points=(midpoint)=>{
    const result=[];
    // A midpoint's cubic interpolation needs one extra plane at each end.
    for(let k=midpoint?1:0;k<span-(midpoint?2:0);k++)
      for(let j=0;j<span-midpoint;j++)
        for(let i=0;i<span-midpoint;i++)
          result.push(new T.Vector3(x+i+midpoint/2,x+j+midpoint/2,z+k+midpoint/2));
    return result;
  };
  return {nodes:points(0),midpoints:points(1),x,z};
}

// Same native production beam used by the cache for its incoming boundaries.
// Force it at interior nodes and half-cell offsets with the same basis math.
export async function directFarLightGrid(T,renderer,cache,prepare) {
  const grid=centralGrid(T,cache);
  const uniforms=Object.fromEntries(Object.entries(cache.material.uniforms)
    .map(([name,uniform])=>[name,{value:uniform.value}]));
  const material=createCloudSunSweepMaterial(uniforms), quad=new OwnedScreenTriangle(material);
  const target=new T.WebGLRenderTarget(cache.size,cache.size,{type:T.FloatType,depthBuffer:false});
  const fields=[];
  try {
    uniforms.uCacheBoundary.value=1;
    for(let field=0;field<4;field++) {
      if(!cache.available[field]) {fields.push(null);continue;}
      const readPlanes=(midpoint)=>{
        const side=span-midpoint, pixels=new Float32Array(side*side*4), values=[];
        target.scissor.set(grid.x,grid.x,side,side);target.scissorTest=true;
        renderer.setRenderTarget(target);
        uniforms.uCacheSize.value=cache.size-midpoint;
        for(let k=midpoint?1:0;k<span-(midpoint?2:0);k++) {
          uniforms.uCacheLayer.value=grid.z+k+midpoint/2;
          material.uniformsNeedUpdate=true;quad.render(renderer);
          renderer.readRenderTargetPixels(target,grid.x,grid.x,side,side,pixels);
          for(let i=0;i<pixels.length;i+=4)values.push(pixels[i]);
        }
        return values;
      };
      fields.push(await prepare(()=>{
        uniforms.uCacheBasis.value=cache.frames[field];
        uniforms.uCacheInverse.value=cache.inverseFrames[field];
        uniforms.uCacheDirection.value=cache.directions[field];
        uniforms.uCacheRadial.value=Math.max(0,field-1);
        return {nodes:readPlanes(0),midpoints:readPlanes(1)};
      },'far-light-grid-direct'));
    }
    return {grid,fields};
  } finally {quad.dispose();material.dispose();target.dispose();}
}

function interpolatedMidpoints(nodes) {
  const values=[];
  for(let k=1;k<span-2;k++)for(let y=0;y<span-1;y++)for(let x=0;x<span-1;x++) {
    const plane=(layer)=>{
      const a=(layer*span+y)*span+x;
      return (nodes[a]+nodes[a+1]+nodes[a+span]+nodes[a+span+1])*.25;
    };
    const a=plane(k-1),b=plane(k),c=plane(k+1),d=plane(k+2),delta=c-b;
    const tangent=slope=>Math.abs(delta)<.000001?0:Math.max(0,Math.min(3,slope/delta))*delta;
    values.push(Math.max(0,(b+c)*.5+(tangent((c-a)*.5)-tangent((d-b)*.5))*.125));
  }
  return values;
}

function errorStats(a,b) {
  if(a.length!==b.length||!a.length)throw Error('Unmatched optical depth grid');
  const errors=[],transmission=[];
  let nonzero=0;
  for(let i=0;i<a.length;i++) {
    if(!Number.isFinite(a[i])||!Number.isFinite(b[i])||a[i]<0||b[i]<0)throw Error('Invalid optical depth grid');
    if(a[i]>0||b[i]>0)nonzero++;
    errors.push(Math.abs(a[i]-b[i]));
    transmission.push(Math.abs(Math.exp(-a[i])-Math.exp(-b[i])));
  }
  const summary=values=>{
    values.sort((x,y)=>x-y);
    return {p95:values[Math.ceil(.95*values.length)-1],max:values.at(-1)};
  };
  return {samples:a.length,nonzero,tau:summary(errors),transmission:summary(transmission)};
}

export async function compareFarLightGrid(T,renderer,cache,{grid,fields},prepare) {
  if(!renderer.extensions.has('OES_texture_float_linear'))
    throw Error('Direct optical-depth atlas requires linear Float32 sampling');
  const pointCount=grid.nodes.length+grid.midpoints.length;
  const points=[...grid.nodes,...grid.midpoints];
  const width=64,height=Math.ceil(pointCount/width),textureBytes=new Float32Array(width*height*4);
  points.forEach((p,i)=>textureBytes.set([(p.x+.5)/cache.size,(p.y+.5)/cache.size,(p.z+.5)/cache.depth,1],4*i));
  const positions=new T.DataTexture(textureBytes,width,height,T.RGBAFormat,T.FloatType);
  positions.needsUpdate=true;
  // Put the exact nodes in the production atlas layout. The query and its
  // entire four-plane stencil stay inside the filled central subgrid.
  const atlasWidth=cache.target.width, atlasHeight=cache.target.height;
  const exactBytes=new Float32Array(atlasWidth*atlasHeight);
  fields.forEach((field,path)=>{
    if(!field)return;
    for(let k=0;k<span;k++)for(let y=0;y<span;y++) {
      const tile=path*cache.depth+grid.z+k;
      const row=(Math.floor(tile/32)*cache.size+grid.x+y)*atlasWidth;
      const column=(tile%32)*cache.size+grid.x;
      exactBytes.set(field.nodes.slice((k*span+y)*span,(k*span+y+1)*span),row+column);
    }
  });
  const exactAtlas=new T.DataTexture(exactBytes,atlasWidth,atlasHeight,T.RedFormat,T.FloatType);
  exactAtlas.minFilter=exactAtlas.magFilter=T.LinearFilter;exactAtlas.needsUpdate=true;
  const material=new T.ShaderMaterial({
    uniforms:{uCache:{value:cache.target.texture},uPositions:{value:positions},uDepth:{value:cache.depth}},
    vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`uniform sampler2D uCache,uPositions;uniform float uDepth;
      ${cloudSunCacheSamplingGLSL}
      void main(){
        vec3 p=texelFetch(uPositions,ivec2(gl_FragCoord.xy),0).xyz;
        vec4 depths=vec4(0);
        for(int field=0;field<4;field++){
          vec3 q=vec3((float(field)+p.x)/4.0,p.yz);
          depths[field]=sampleCloudSunCacheAt(uCache,q,uDepth,0.0);
        }
        gl_FragColor=depths;
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(material);
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  try {
    const [pixels,exactPixels]=await prepare(()=>[cache.target.texture,exactAtlas].map(texture=>{
      const output=new Float32Array(width*height*4);
      material.uniforms.uCache.value=texture;material.uniformsNeedUpdate=true;
      renderer.setRenderTarget(target);quad.render(renderer);
      renderer.readRenderTargetPixels(target,0,0,width,height,output);
      return output;
    }),'far-light-grid-sampled');
    return fields.map((direct,field)=>{
      if(!direct)return {field:names[field],available:false};
      const sampled=points.map((_,i)=>pixels[4*i+field]);
      const nodes=sampled.slice(0,grid.nodes.length),midpoints=sampled.slice(grid.nodes.length);
      const exactSampled=points.map((_,i)=>exactPixels[4*i+field]);
      const exactNodes=exactSampled.slice(0,grid.nodes.length),exactMidpoints=exactSampled.slice(grid.nodes.length);
      const nodeControl=errorStats(direct.nodes,exactNodes);
      const lookupControl=errorStats(interpolatedMidpoints(direct.nodes),exactMidpoints);
      if(nodeControl.tau.max!==0||lookupControl.tau.max>.002)
        throw Error(`Exact grid lookup control failed for ${names[field]}: ${JSON.stringify({nodeControl,lookupControl})}`);
      const common=grid.midpoints.map(p=>[p.x,p.y].every(axis=>{
        const meters=(axis+.5-cache.size/2)*cache.spacing;
        return Math.abs(meters)<=400&&meters%200===0;
      }));
      const commonError=(a,b)=>errorStats(a.filter((_,i)=>common[i]),b.filter((_,i)=>common[i]));
      return {field:names[field],available:true,
        bakeAtNodes:errorStats(direct.nodes,nodes),
        interpolateExactNodes:errorStats(direct.midpoints,exactMidpoints),
        combinedAtMidpoints:errorStats(direct.midpoints,midpoints),
        common:{interpolation:commonError(direct.midpoints,exactMidpoints),
          combined:commonError(direct.midpoints,midpoints)},
        storedLookup:errorStats(interpolatedMidpoints(nodes),midpoints),nodeControl,lookupControl};
    });
  } finally {target.dispose();quad.dispose();material.dispose();positions.dispose();exactAtlas.dispose();}
}
