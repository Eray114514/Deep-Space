import { nearCacheCountsShader, sumNearCacheCounts } from './near-cloud-cache-counts.js';
import { CloudLightBank } from '../src/cloud/cloud-light-bank.js';
import { cloudLightCacheUniforms } from '../src/cloud/cloud-light-cache-glsl.js';

export function nearCacheCoverageShader(fragment) {
  const source=nearCacheCountsShader(fragment);
  const loop='        for(int bin=0;bin<bins;bin++) {\n          vec3 local=uCameraLocal+dir*anchors[bin];';
  const output='        gl_FragColor=nearCacheCounts;';
  const count='          nearCacheCounts[path]+=cached?1.0:32.0;';
  for(const boundary of [loop,output,count]) {
    if(source.split(boundary).length!==2)throw Error('Unexpected near coverage shader boundary');
  }
  return ('uniform int uNearCoverageMode;\nint coverageBin;\nuvec2 solarMasks=uvec2(0);\n'+source)
    .replace(loop,`        if(uNearCoverageMode<4) {
          int first=uNearCoverageMode*4;
          gl_FragColor=vec4(anchors[first],anchors[first+1],anchors[first+2],anchors[first+3]);
          return;
        }
        if(uNearCoverageMode==4) {gl_FragColor=vec4(dir,1.0);return;}
${loop}
          coverageBin=bin;`)
    .replace(count,`${count}
          if(path<2)solarMasks[path]|=1u<<uint(coverageBin);`)
    .replace(output,'        gl_FragColor=uNearCoverageMode==5?vec4(vec2(solarMasks),0,0):nearCacheCounts;');
}

const widths=[12800,25600,51200];
const depthMeters=6400;
const budgetsMiB=[24,48,96];
const fieldPageMiB=6; // 128^3 R8 samples × three rotating time slots.

function recordCell(pages,x,y,z,width) {
  // Three signed cell indices, each well inside 16 bits for this body's scale.
  const key=Math.floor(x/width)*4294967296+Math.floor(y/width)*65536+Math.floor(z/depthMeters);
  pages.set(key,(pages.get(key)||0)+1);
}

export function summarizeNearCoverage({groups,rays,masks,counts,published,half,uniforms,T}) {
  const camera=uniforms.uCameraLocal.value, up=camera.clone().normalize();
  const helper=Math.abs(up.y)<.9?new T.Vector3(0,1,0):new T.Vector3(1,0,0);
  const x=new T.Vector3().crossVectors(helper,up).normalize();
  const y=new T.Vector3().crossVectors(up,x).normalize();
  const fields=[uniforms.uSunDir.value,uniforms.uSecondarySunDir.value].map(value=>{
    const direction=value.clone().normalize(), mu=direction.dot(up);
    return Math.abs(mu)<.08?null:[direction.dot(x)/mu,direction.dot(y)/mu];
  });
  const native=sumNearCacheCounts(counts,value=>value);
  const requests=[0,0,0,0];
  // Independent field pages. The grid uses curved height and ignores both
  // endpoint drift and interpolation margins. This is an idealized capacity
  // model for a fixed tiling, not a proposed sampler or an error guarantee.
  const grids=widths.map(width=>({width,fieldMaps:Array.from({length:4},()=>new Map())}));
  const sum=[0,0,0];
  let occupied=0;
  for(let pixel=0;pixel<rays.length;pixel+=4) {
    const visible=half(published[pixel+3])>0;
    if(rays[pixel+3]!==Number(visible))throw Error('Near coverage changed the published visibility mask');
    if(!visible)continue;
    occupied++;
    const dx=rays[pixel],dy=rays[pixel+1],dz=rays[pixel+2];
    if(Math.abs(Math.hypot(dx,dy,dz)-1)>1e-5)throw Error('Invalid near coverage view ray');
    const mask0=masks[pixel],mask1=masks[pixel+1];
    if(![mask0,mask1].every(value=>Number.isInteger(value)&&value>=0&&value<=65535))
      throw Error('Invalid near solar admission mask');
    let last=0;
    for(let bin=0;bin<16;bin++) {
      const distance=groups[bin>>2][pixel+(bin&3)];
      if(!Number.isFinite(distance)||distance<last)throw Error('Invalid near coverage anchor order');
      last=distance;
      const px=camera.x+dx*distance,py=camera.y+dy*distance,pz=camera.z+dz*distance;
      sum[0]+=px;sum[1]+=py;sum[2]+=pz;
      const u=px*x.x+py*x.y+pz*x.z, v=px*y.x+py*y.y+pz*y.z;
      const h=Math.hypot(px,py,pz)-uniforms.uBodyR.value;
      const w=(px-camera.x)*up.x+(py-camera.y)*up.y+(pz-camera.z)*up.z;
      for(let field=0;field<4;field++) {
        if(field===0&&!(mask0&(1<<bin))||field===1&&!(mask1&(1<<bin)))continue;
        requests[field]++;
        const shear=fields[field];
        if(shear===null)continue;
        const sx=shear?u-shear[0]*w:u, sy=shear?v-shear[1]*w:v;
        for(const {width,fieldMaps} of grids)recordCell(fieldMaps[field],sx,sy,h,width);
      }
    }
  }
  if(!occupied||occupied!==native.rays||requests.some((count,field)=>count!==native.hits[field]+native.misses[field]))
    throw Error('Near coverage masks did not conserve the production queries');
  return {occupied,requests,native,focus:sum.map(value=>value/requests[2]),fieldPageMiB,depthMeters,plans:grids.map(({width,fieldMaps})=>{
    const cells=fieldMaps.map(map=>map.size);
    const ranked=fieldMaps.flatMap((map,field)=>[...map.values()].map(count=>({field,count})))
      .sort((a,b)=>b.count-a.count);
    return {width,cells,budgets:budgetsMiB.map(mib=>{
      const queries=[0,0,0,0], pages=[0,0,0,0];
      for(const {field,count} of ranked.slice(0,mib/fieldPageMiB)) {
        queries[field]+=count;pages[field]++;
      }
      return {mib,pages,queries};
    })};
  })};
}

export function createFocusedNearCache(owner,focus) {
  const source=owner.volCloudMat.uniforms;
  const uniforms=cloudLightCacheUniforms(source.uWeatherMapHi.value);
  // Borrow the frozen source data. Every lighting-cache binding and the bank
  // lifecycle belong to the private view, so baking cannot replace live slots.
  const probeOwner=Object.create(owner);
  probeOwner.volCloudMat={uniforms:{...source,...uniforms}};
  probeOwner.cloudLightBank=null;
  const bank=new CloudLightBank(probeOwner);
  bank.center.fromArray(focus);
  bank.spacing=200;
  return {bank,uniforms};
}
