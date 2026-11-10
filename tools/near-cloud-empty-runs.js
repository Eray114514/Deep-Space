import { nearProductionCloudGLSL, productionCloudGLSL } from '../src/cloud/production-medium-glsl.js';

// Keep the species mask intact. The second channel records the nearest
// occupied layer on each side, using layer + 1 so zero means no neighbour.
export function packEmptyRuns(masks,width,height,depth,packed,last) {
  const plane=width*height;
  const single=packed.length===masks.length;
  last.fill(0);
  for(let z=0;z<depth;z++)for(let cell=0;cell<plane;cell++) {
    const i=z*plane+cell,mask=masks[i];
    if(single)packed[i]=mask||(0x8000|last[cell]);
    else {
      packed[2*i]=mask;
      packed[2*i+1]=last[cell];
    }
    if(mask)last[cell]=z+1;
  }
  last.fill(0);
  for(let z=depth-1;z>=0;z--)for(let cell=0;cell<plane;cell++) {
    const i=z*plane+cell;
    if(!single)packed[2*i+1]|=last[cell]<<7;
    else if(!masks[i])packed[i]|=last[cell]<<7;
    if(masks[i])last[cell]=z+1;
  }
}

export function emptyRunShader(source,layout) {
  if(source.includes(nearProductionCloudGLSL)) {
    source=source.replace(nearProductionCloudGLSL,productionCloudGLSL);
    if(layout==='r16')return source;
  }
  const start=source.indexOf('    if(texelFetch(uBandCandidates,ivec3(cell,layer),0).r!=0u)return 0.0;');
  const end=source.indexOf('    float distance=min(radius-below,above-radius);',start);
  if(start<0||end<0||!source.slice(start,end).includes('int index=layer+k;'))
    throw Error('Unexpected empty run shader boundary');
  const decode=layout==='r16'?`    uint candidate=texelFetch(uBandCandidates,ivec3(cell,layer),0).r;
    if((candidate&32768u)==0u)return 0.0;
    uint lower=candidate&127u,upper=(candidate>>7u)&127u;
`:`    uvec2 candidate=texelFetch(uBandCandidates,ivec3(cell,layer),0).rg;
    if(candidate.r!=0u)return 0.0;
    uint lower=candidate.g&127u,upper=candidate.g>>7u;
`;
  source=source.slice(0,start)+decode+`    float below=lower==0u?uRin:max(uRin,uBodyR+float(lower)*500.0);
    float above=upper==0u?uRout:min(uRout,uBodyR+float(upper-1u)*500.0);
`+source.slice(end);
  if(layout==='r16') {
    const fetch='      candidates=texelFetch(uBandCandidates,ivec3(cell,clamp(int(floor(altitude/500.0)),0,size.z-1)),0).r;';
    if(source.split(fetch).length!==2)throw Error('Unexpected empty run density boundary');
    source=source.replace(fetch,`${fetch}\n      if((candidates&32768u)!=0u)return vec2(0);`);
  }
  return source;
}

export function createEmptyRunProbe(T,gl,layout) {
  let texture,source,version,last,updates=0,cpuMs=0;
  const uniform={value:null};
  const single=layout==='r16';
  return {
    bind(uniforms) {
      const input=uniforms.uBandCandidates.value;
      const {data,width,height,depth}=input?.image??{};
      if(!(data instanceof Uint16Array)||depth!==64||width*height*depth!==data.length
        ||uniforms.uCandidateLayers.value!==depth||uniforms.uCandidatesReady.value!==1)
        throw Error('Empty run probe needs the live 64-layer candidate grid');
      if(!texture) {
        texture=new T.DataArrayTexture(new Uint16Array(data.length*(single?1:2)),width,height,depth);
        texture.format=single?T.RedIntegerFormat:T.RGIntegerFormat;texture.type=T.UnsignedShortType;
        texture.internalFormat=single?'R16UI':'RG16UI';texture.unpackAlignment=1;
        last=new Uint8Array(width*height);
      }
      if(texture.image.width!==width||texture.image.height!==height)throw Error('Empty run grid resized');
      if(source!==input||version!==input.version) {
        const start=performance.now();
        if(single&&data.some(mask=>(mask&0xc000)!==0))throw Error('Occupied layer uses a reserved candidate bit');
        packEmptyRuns(data,width,height,depth,texture.image.data,last);
        cpuMs+=performance.now()-start;updates++;
        texture.needsUpdate=true;
        source=input;version=input.version;
      }
      uniform.value=texture;
      uniforms.uBandCandidates=uniform;
    },
    stats() {return {layout,updates,cpuMs,bytes:texture?.image.data.byteLength??0};},
    dispose() {if(!gl.isContextLost())texture?.dispose();},
  };
}
