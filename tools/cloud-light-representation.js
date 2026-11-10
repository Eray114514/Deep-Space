import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';

const clamp=value=>Math.max(0,Math.min(1,value));
const transmission=depth=>Math.exp(-depth);

export function interpolateLightMidpoints(nodes,span) {
  const values=[];
  for(let k=1;k<span-2;k++)for(let y=0;y<span-1;y++)for(let x=0;x<span-1;x++) {
    const plane=layer=>{
      const a=(layer*span+y)*span+x;
      return (nodes[a]+nodes[a+1]+nodes[a+span]+nodes[a+span+1])*.25;
    };
    const a=plane(k-1),b=plane(k),c=plane(k+1),d=plane(k+2),delta=c-b;
    const tangent=slope=>Math.abs(delta)<.000001?0:Math.max(0,Math.min(3,slope/delta))*delta;
    values.push(Math.max(0,(b+c)*.5+(tangent((c-a)*.5)-tangent((d-b)*.5))*.125));
  }
  return values;
}

function opticalCoordinates(above,below) {
  const total=above+below;
  return [Math.acos(1-2*clamp(above/Math.max(total,.0001)))/Math.PI,clamp(Math.log1p(total)/Math.log(129))];
}

function scatteringSampler(T,texture) {
  const {data,width,height,depth}=texture.image;
  if(!(data instanceof Uint16Array)||width!==64||height!==16||depth!==32)
    throw Error('Unexpected production scattering LUT layout');
  return (depthFraction,logDepth,sun)=>{
    const x=clamp(depthFraction)*(width-1), y=clamp((sun-.01)/.99)*(height-1), z=clamp(logDepth)*(depth-1);
    const i=Math.floor(x),j=Math.floor(y),k=Math.floor(z);
    const lerp=(a,b,t)=>a+(b-a)*t;
    const value=(a,b,c)=>T.DataUtils.fromHalfFloat(data[((c*height+b)*width+a)*4]);
    const plane=c=>{
      const row=b=>lerp(value(i,b,c),value(Math.min(i+1,width-1),b,c),x-i);
      return lerp(row(j),row(Math.min(j+1,height-1)),y-j);
    };
    return lerp(plane(k),plane(Math.min(k+1,depth-1)),z-k);
  };
}

function errorStats(reference,candidate) {
  if(!reference.length||reference.length!==candidate.length)throw Error('Unmatched light representation samples');
  const errors=reference.map((value,i)=>Math.abs(value-candidate[i]));
  if(!errors.every(Number.isFinite))throw Error('Non-finite light representation error');
  errors.sort((a,b)=>a-b);
  return {samples:errors.length,p95:errors[Math.ceil(errors.length*.95)-1],max:errors.at(-1)};
}

async function checkScatteringSampler(T,renderer,material,prepare,texture,sample,controls) {
  const source=material.fragmentShader;
  const start=source.indexOf('      float cloudMultipleSource(');
  const end=source.indexOf('      float cloudVerticalAbove=',start);
  if(start<0||end<=start)throw Error('Missing production scattering closure');
  const width=64,height=Math.ceil(controls.length/width);
  const bytes=new Float32Array(width*height*4);
  controls.forEach((row,i)=>bytes.set(row,i*4));
  const inputs=new T.DataTexture(bytes,width,height,T.RGBAFormat,T.FloatType);
  inputs.needsUpdate=true;
  const shader=new T.ShaderMaterial({
    uniforms:{uInputs:{value:inputs},uCloudScattering:{value:texture}},
    vertexShader:'void main(){gl_Position=vec4(position.xy,0,1);}',
    fragmentShader:`precision highp sampler3D;uniform sampler3D uCloudScattering;uniform sampler2D uInputs;
      ${source.slice(start,end)}
      void main(){
        vec3 p=texelFetch(uInputs,ivec2(gl_FragCoord.xy),0).rgb;
        gl_FragColor=vec4(cloudMultipleSource(p.x,p.x+p.y,p.z),0,0,1);
      }`,
    depthTest:false,depthWrite:false,blending:T.NoBlending,
  });
  const quad=new OwnedScreenTriangle(shader);
  const target=new T.WebGLRenderTarget(width,height,{type:T.FloatType,depthBuffer:false});
  try {
    const output=await prepare(()=>{
      renderer.setRenderTarget(target);quad.render(renderer);
      const pixels=new Float32Array(bytes.length);
      renderer.readRenderTargetPixels(target,0,0,width,height,pixels);
      return pixels;
    },'far-light-closure-control');
    const expected=controls.map((_,i)=>sample(...opticalCoordinates(bytes[i*4],bytes[i*4+1]),bytes[i*4+2]));
    const control=errorStats(expected,controls.map((_,i)=>output[i*4]));
    if(control.max>.002)throw Error(`Production scattering LUT control diverged: ${JSON.stringify(control)}`);
    return control;
  } finally {quad.dispose();shader.dispose();inputs.dispose();target.dispose();}
}

// Re-encode the same four fields, preserving the grid, support and sampler.
// Exact nodes isolate encoding. Swept nodes include existing bake error.
export async function compareLightRepresentations(T,renderer,cache,{grid,fields},span,swept,material,prepare) {
  if(!fields.every(Boolean))throw Error('Representation probe needs all four optical fields');
  if(!cache.frames[2].equals(cache.frames[3]))throw Error('Radial fields do not share a physical grid');
  const texture=material.uniforms.uCloudScattering.value, sample=scatteringSampler(T,texture);
  const sunAngles=points=>points.map(p=>{
    const local=new T.Vector3((p.x+.5-cache.size/2)*cache.spacing,(p.y+.5-cache.size/2)*cache.spacing,
      (p.z+.5-cache.depth/2)*cache.verticalSpacing)
      .applyMatrix3(cache.frames[2]).add(cache.center).normalize();
    return cache.directions.slice(0,2).map(direction=>local.dot(direction));
  });
  const nodeSun=sunAngles(grid.nodes), midSun=sunAngles(grid.midpoints);
  const control=await checkScatteringSampler(T,renderer,material,prepare,texture,sample,
    midSun.flatMap((angles,i)=>angles.map(sun=>[fields[2].midpoints[i],fields[3].midpoints[i],sun])));
  const interpolate=nodes=>interpolateLightMidpoints(nodes,span);
  const exact=fields.map(field=>field.nodes);
  function compare(nodes,bakedMidpoints) {
    const depth=bakedMidpoints??nodes.map(interpolate);
    const solar=[0,1].map(field=>{
      const reference=fields[field].midpoints.map(transmission);
      return {depth:errorStats(reference,depth[field].map(transmission)),
        transmission:errorStats(reference,interpolate(nodes[field].map(transmission)))};
    });
    const nodeCoordinates=nodes[2].map((above,i)=>opticalCoordinates(above,nodes[3][i]));
    const warp=interpolate(nodeCoordinates.map(coordinates=>coordinates[0]));
    const log=interpolate(nodeCoordinates.map(coordinates=>coordinates[1]));
    const reference=fields[2].midpoints.map((above,i)=>opticalCoordinates(above,fields[3].midpoints[i]));
    const closure=[0,1].map(star=>{
      const expected=reference.map((uv,i)=>sample(...uv,midSun[i][star]));
      return {depth:errorStats(expected,depth[2].map((above,i)=>sample(...opticalCoordinates(above,depth[3][i]),midSun[i][star]))),
        lutInput:errorStats(expected,warp.map((x,i)=>sample(x,log[i],midSun[i][star]))),
        lutOutput:errorStats(expected,interpolate(nodeCoordinates.map((uv,i)=>sample(...uv,nodeSun[i][star]))))};
    });
    const ambient=fields[2].midpoints.map(transmission);
    return {solar,closure,ambient:{depth:errorStats(ambient,depth[2].map(transmission)),
      transmission:errorStats(ambient,interpolate(nodes[2].map(transmission)))}};
  }
  return {control,exact:compare(exact,null),swept:compare(swept.map(field=>field.nodes),swept.map(field=>field.midpoints))};
}
