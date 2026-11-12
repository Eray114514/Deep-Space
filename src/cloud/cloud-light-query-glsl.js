// Shared exact queries. Partial cached radiance is never displayed where
// a physical beam is needed; a tile without complete pages uses the original.
const beamCall='if(!cached)pathDepth=cloudSunOpticalDepthLimit(local,direction,sigma,path<2?12.0:128.0);';
const cacheCall='bool cached=cloudCachedLight(local,path,pathDepth);';
export const lightPageDeclarations=/* glsl */`
  #define PAGE_LIGHT_COMPOSITION 1
  precision highp usampler2D;
  uniform sampler2D tPageRay,tPageCached,tPageMask,tPageOpacity,tPage0,tPage1,tPage2,tPage3,tPageLight;
  uniform usampler2D tPageMetaJobs,tPageLightJobs,tPageMetaMap,tPageLightMap;
  uniform ivec2 uPageSize;
  uniform int uPageTilesX,uPageMetaColumns,uPageLightColumns;
  int pageMask(ivec2 pixel){return int(round(texelFetch(tPageMask,pixel,0).r*255.0));}
  ivec2 pageTile(ivec2 pixel){return pixel/16;}
  bool pageReady(ivec2 pixel,int mask){
    if(texelFetch(tPageMetaMap,pageTile(pixel),0).r==0u)return false;
    uvec4 slots=texelFetch(tPageLightMap,pageTile(pixel),0);
    for(int field=0;field<4;field++)if((mask&(1<<field))!=0 && slots[field]==0u)return false;
    return true;
  }
  uvec4 pageJob(usampler2D jobs,int index){ivec2 size=textureSize(jobs,0);if(index>=size.x*size.y)return uvec4(0);
    return texelFetch(jobs,ivec2(index%size.x,index/size.x),0);}
  ivec2 pageOriginal(int tile,ivec2 within){return ivec2(tile%uPageTilesX,tile/uPageTilesX)*16+within;}
  ivec2 pageMetadataPixel(int slot,ivec2 pixel){int columns=max(1,textureSize(tPage0,0).x/16);
    return ivec2(slot%columns,slot/columns)*16+pixel%16;}
  float pageAnchor(int slot,ivec2 pixel,int bin){ivec2 cell=pageMetadataPixel(slot,pixel);
    vec4 group=bin<4?texelFetch(tPage0,cell,0):bin<8?texelFetch(tPage1,cell,0):bin<12?texelFetch(tPage2,cell,0):texelFetch(tPage3,cell,0);
    return group[bin%4];}
  float rawPageBeamDepth(ivec2 pixel,int field,int bin){
    int slot=int(texelFetch(tPageLightMap,pageTile(pixel),0)[field])-1;
    int columns=max(1,textureSize(tPageLight,0).x/16);
    ivec2 cell=ivec2(slot%columns*16,slot/columns*256+bin*16)+pixel%16;
    return texelFetch(tPageLight,cell,0).r;
  }
  float pageBeamDepth(ivec2 pixel,int field,int bin){
    float d=rawPageBeamDepth(pixel,field,bin);
    if(d>=-0.5)return d;
    int meta=int(texelFetch(tPageMetaMap,pageTile(pixel),0).r)-1,k0=(bin/5)*5;
    float a0=pageAnchor(meta,pixel,k0),a1=pageAnchor(meta,pixel,k0+5),a=pageAnchor(meta,pixel,bin);
    return mix(rawPageBeamDepth(pixel,field,k0),rawPageBeamDepth(pixel,field,k0+5),clamp((a-a0)/max(a1-a0,1e-3),0.0,1.0));
  }
`;
const declarations=lightPageDeclarations;
function checkedReplace(source,from,to) {
  if(!source.includes(from))throw Error('Light-page source contract changed: '+from);
  return source.replace(from,to);
}
function replaceFunctionBody(source,name,body) {
  const start=source.indexOf(name+'('),brace=source.indexOf('{',start);let end=brace+1,depth=1;
  if(start<0||brace<0)throw Error('Missing light-page helper: '+name);
  while(depth&&end<source.length){const c=source[end++];if(c==='{')depth++;if(c==='}')depth--;}
  if(depth)throw Error('Unterminated light-page helper');
  return source.slice(0,brace+1)+body+source.slice(end-1);
}
export function cloudLightPageShaders(source) {
  const start=source.indexOf('        vec3 correction=vec3(0);'),end=source.indexOf('        #else',start);
  if(start<0||end<0)throw Error('Light-page quantile boundary changed');
  const prefix=source.slice(0,source.lastIndexOf('void main()'));
  let prepare=checkedReplace(source,beamCall,'if(!cached)queryMissMask|=(1<<path);');
  prepare=checkedReplace(prepare,'vec3 cloudCombinedSource(',
    'int queryMissMask=0;float queryOpaqueLimit=1e20;\nvec3 cloudCombinedSource(');
  prepare=checkedReplace(prepare,'t1 = min(t1, sceneRayLimit());','queryOpaqueLimit=sceneRayLimit();t1=min(t1,queryOpaqueLimit);');
  prepare=checkedReplace(prepare,'gl_FragColor = vec4(correction * uEngage, alpha);',
    'gl_FragColor=vec4(correction*uEngage,alpha);queryRay=vec4(dir,queryOpaqueLimit);'+
    'queryMask=vec4(float(queryMissMask)/255.0);queryOpacity=vec4(totalOpacity);');
  prepare=prepare.replaceAll('gl_FragColor','queryCached');
  prepare='layout(location=0) out vec4 queryRay;layout(location=1) out vec4 queryCached;'+
    'layout(location=2) out vec4 queryMask;layout(location=3) out vec4 queryOpacity;\n'+prepare;

  let metadata=source.slice(0,start)+
    'page0=vec4(anchors[0],anchors[1],anchors[2],anchors[3]);page1=vec4(anchors[4],anchors[5],anchors[6],anchors[7]);'+
    'page2=vec4(anchors[8],anchors[9],anchors[10],anchors[11]);page3=vec4(anchors[12],anchors[13],anchors[14],anchors[15]);\n'+source.slice(end);
  metadata=checkedReplace(metadata,'vec3 dir = normalize(vDirection);','vec3 dir=queryRay.xyz;');
  metadata=replaceFunctionBody(metadata,'sceneRayLimit','return queryRay.w;');
  metadata=metadata.replaceAll('gl_FragColor','page0').replaceAll('gl_FragCoord','queryPixel');
  metadata=checkedReplace(metadata,'void main()','void queryMain()');
  metadata=declarations+'vec4 queryPixel,queryRay;\n'+metadata+/* glsl */`
    void main(){ivec2 pixel=ivec2(gl_FragCoord.xy),cell=pixel/16;
      int columns=uPageMetaColumns,slot=cell.y*columns+cell.x;
      int tile=int(pageJob(tPageMetaJobs,slot).r)-1;if(tile<0)discard;
      ivec2 original=pageOriginal(tile,pixel%16);if(any(greaterThanEqual(original,uPageSize)))discard;
      queryRay=texelFetch(tPageRay,original,0);if(dot(queryRay.xyz,queryRay.xyz)<.5 || pageMask(original)==0)discard;
      queryPixel=vec4(vec2(original)+.5,gl_FragCoord.zw);queryMain();
    }`;
  metadata='layout(location=0) out vec4 page0;layout(location=1) out vec4 page1;'+
    'layout(location=2) out vec4 page2;layout(location=3) out vec4 page3;\n'+metadata;

  const beams=prefix+declarations+/* glsl */`
    void main(){ivec2 pixel=ivec2(gl_FragCoord.xy),cell=ivec2(pixel.x/16,pixel.y/256);
      int columns=uPageLightColumns,slot=cell.y*columns+cell.x;
      uvec4 job=pageJob(tPageLightJobs,slot);int tile=int(job.r)-1;if(tile<0)discard;
      int field=int(job.g),meta=int(job.b)-1,bin=(pixel.y%256)/16;
      ivec2 original=pageOriginal(tile,ivec2(pixel.x%16,pixel.y%16));
      if(any(greaterThanEqual(original,uPageSize)) || (pageMask(original)&(1<<field))==0)discard;
      vec4 ray=texelFetch(tPageRay,original,0);
      float anchorDistance=pageAnchor(meta,original,bin);
      cloudBeamLodScale=clamp(anchorDistance/3200.0,1.0,240.0);
      vec3 local=uCameraLocal+ray.xyz*anchorDistance;
      vec3 direction=field==0?normalize(uSunDir):field==1?normalize(uSecondarySunDir):field==2?normalize(local):-normalize(local);
      if(field==1 && uSecondarySunEnergy<=0.0)discard;
      if(field<2){float radius=length(local),muSun=dot(local/radius,direction);
        float horizon=-sqrt(max(0.0,1.0-uGroundR*uGroundR/(radius*radius)));
        if(muSun<=horizon-0.018 || eclipseVisibility(local,direction)<=0.0)discard;}
      float depth=0.0;bool cached=cloudCachedLight(local,field,depth);
      if(!cached && clamp(uLightQuadratureSteps,4,32)==16) {
        int k0=(bin/5)*5;
        float ka0=pageAnchor(meta,original,k0);
        if(bin!=k0 && pageAnchor(meta,original,k0+5)-ka0<3000.0+ka0*0.5) {
          gl_FragColor=vec4(-1.0,0,0,1);return;
        }
      }
      if(!cached)depth=cloudSunOpticalDepthLimit(local,direction,0.0,field<2?12.0:128.0);
      gl_FragColor=vec4(depth,0,0,1);
    }`;
  let composePrefix=checkedReplace(prefix,beamCall,'if(!cached)pathDepth=pageBeamDepth(ivec2(gl_FragCoord.xy),path,queryBin);');
  composePrefix=checkedReplace(composePrefix,'vec3 cloudCombinedSource(',declarations+'int queryBin=0;\nvec3 cloudCombinedSource(');
  let loop=source.slice(start,end);
  loop=checkedReplace(loop,'float distance=anchors[bin];','queryBin=bin;float distance=pageAnchor(meta,pixel,bin);');
  const compose=composePrefix+/* glsl */`
    void main(){ivec2 pixel=ivec2(gl_FragCoord.xy);int mask=pageMask(pixel);
      if(mask==0 || !pageReady(pixel,mask))discard;
      int meta=int(texelFetch(tPageMetaMap,pageTile(pixel),0).r)-1;
      vec3 dir=texelFetch(tPageRay,pixel,0).xyz;
      float totalOpacity=texelFetch(tPageOpacity,pixel,0).r,alpha=totalOpacity*uEngage;
      float thick=uRout-uRin,sigma=3.80/thick;int bins=clamp(uLightQuadratureSteps,4,32);
      vec2 airBounds=air_sphereHits(uCameraLocal,air_uTopR,dir);
      ${loop}
    }`;
  const overflow=checkedReplace(source,'float rayCone=max(length(dFdx(dir)),length(dFdy(dir)));',
    'float rayCone=max(length(dFdx(dir)),length(dFdy(dir)));'+
    'ivec2 pixel=ivec2(gl_FragCoord.xy);int mask=pageMask(pixel);if(mask==0 || pageReady(pixel,mask))discard;');
  const base=declarations+'void main(){ivec2 pixel=ivec2(gl_FragCoord.xy);if(pageMask(pixel)!=0)discard;gl_FragColor=texelFetch(tPageCached,pixel,0);}';
  const reduce=declarations+/* glsl */`
    void main(){ivec2 tile=ivec2(gl_FragCoord.xy);int mask=0;
      for(int y=0;y<16;y++)for(int x=0;x<16;x++){
        ivec2 pixel=tile*16+ivec2(x,y);if(any(greaterThanEqual(pixel,uPageSize)))continue;
        mask|=pageMask(pixel);if(mask==15)break;
      }gl_FragColor=vec4(float(mask)/255.0,0,0,1);
    }`;
  const badFields=checkedReplace(checkedReplace(source,beamCall,''),cacheCall,'bool cached=false;');
  return {prepare,metadata,beams,compose,overflow:declarations+overflow,base,reduce,
    badCached:declarations+'void main(){gl_FragColor=texelFetch(tPageCached,ivec2(gl_FragCoord.xy),0);}',badFields};
}
