import {cloudLightPageShaders,lightPageDeclarations} from './cloud-light-query-glsl.js';

const declarations=/* glsl */`
  #define PAGE_LIGHT_COMPOSITION 1
  uniform sampler2D tPageRay,tPageCached,tPageMask,tPageOpacity,tPage0,tPage1,tPage2,tPage3,tPageLight;
  uniform ivec2 uPageSize;
  uniform int uPageTilesX,uPageMetaColumns,uPageLightColumns,uBatchStart,uBatchCount;
  int pageMask(ivec2 pixel){return int(round(texelFetch(tPageMask,pixel,0).r*255.0));}
  int pageSlot(ivec2 pixel){ivec2 tile=pixel/16;return tile.y*uPageTilesX+tile.x-uBatchStart;}
  bool pageReady(ivec2 pixel,int mask){int slot=pageSlot(pixel);return slot>=0&&slot<uBatchCount;}
  ivec2 pageOriginal(int tile,ivec2 within){return ivec2(tile%uPageTilesX,tile/uPageTilesX)*16+within;}
  ivec2 pageMetadataPixel(int slot,ivec2 pixel){return ivec2(slot%uPageMetaColumns,slot/uPageMetaColumns)*16+pixel%16;}
  float pageAnchor(int slot,ivec2 pixel,int bin){ivec2 cell=pageMetadataPixel(slot,pixel);
    vec4 group=bin<4?texelFetch(tPage0,cell,0):bin<8?texelFetch(tPage1,cell,0):bin<12?texelFetch(tPage2,cell,0):texelFetch(tPage3,cell,0);
    return group[bin%4];}
  float rawPageBeamDepth(ivec2 pixel,int field,int bin){
    int slot=pageSlot(pixel)*4+field;
    ivec2 cell=ivec2(slot%uPageLightColumns*16,slot/uPageLightColumns*256+bin*16)+pixel%16;
    return texelFetch(tPageLight,cell,0).r;
  }
  float pageBeamDepth(ivec2 pixel,int field,int bin){
    float d=rawPageBeamDepth(pixel,field,bin);
    if(d>=-0.5)return d;
    int meta=pageSlot(pixel),k0=(bin/5)*5;
    float a0=pageAnchor(meta,pixel,k0),a1=pageAnchor(meta,pixel,k0+5),a=pageAnchor(meta,pixel,bin);
    return mix(rawPageBeamDepth(pixel,field,k0),rawPageBeamDepth(pixel,field,k0+5),clamp((a-a0)/max(a1-a0,1e-3),0.0,1.0));
  }
`;
const compactDeclarations=declarations
  .replace('tPageCached,tPageMask,','')
  .replace('int(round(texelFetch(tPageMask,pixel,0).r*255.0))',
    'texelFetch(tPageOpacity,pixel,0).r>0.0?15:0');
const stripeDeclarations=compactDeclarations
  .replace('  int pageMask','  uniform int uPageRow;\n  ivec2 stripePixel(ivec2 pixel){return pixel-ivec2(0,uPageRow);}\n  int pageMask')
  .replace('texelFetch(tPageOpacity,pixel,0).r','texelFetch(tPageOpacity,stripePixel(pixel),0).r')
  .replace('ivec2 cell=pageMetadataPixel(slot,pixel);','ivec2 cell=stripePixel(pixel);');

// Instanced rectangles remove empty tiles before the heavy fragment kernels.
// PAGE_MODE 0: anchors, 1: four light fields, 2: original output pixel tiles.
export const cloudLightBatchVertex=/* glsl */`
  uniform sampler2D tPageTileMask;
  uniform ivec2 uPageSize;
  uniform vec2 uPageAtlasSize;
  uniform int uPageTilesX,uPageMetaColumns,uPageLightColumns,uBatchStart,uBatchCount;
  #ifdef PAGE_STRIPE
    uniform int uPageRow;
  #endif
  varying vec3 vDirection,vViewDirection;
  void main(){
    vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);
    int slot=gl_InstanceID;
    #if PAGE_MODE == 1
      int meta=slot/4,field=slot%4;
    #else
      int meta=slot;
    #endif
    int tile=uBatchStart+meta;
    ivec2 original=ivec2(tile%uPageTilesX,tile/uPageTilesX);
    ivec2 maskTile=original;
    #ifdef PAGE_STRIPE
      maskTile.y-=uPageRow/16;
    #endif
    bool valid=meta<uBatchCount&&all(lessThan(maskTile,textureSize(tPageTileMask,0)));
    int mask=valid?int(round(texelFetch(tPageTileMask,maskTile,0).r*255.0)):0;
    #if PAGE_MODE == 1
      valid=valid&&(mask&(1<<field))!=0;
      vec2 cell=vec2(slot%uPageLightColumns,slot/uPageLightColumns)*vec2(16,256);
      vec2 pixel=cell+(position.xy*.5+.5)*vec2(16,256);
      vec2 size=uPageAtlasSize;
    #elif PAGE_MODE == 0
      valid=valid&&mask!=0;
      vec2 cell=vec2(slot%uPageMetaColumns,slot/uPageMetaColumns)*16.0;
      vec2 pixel=cell+(position.xy*.5+.5)*16.0;
      vec2 size=uPageAtlasSize;
    #else
      valid=valid&&mask!=0;
      vec2 pixel=vec2(original)*16.0+(position.xy*.5+.5)*16.0;
      vec2 size=vec2(uPageSize);
    #endif
    gl_Position=valid?vec4(pixel/size*2.0-1.0,0,1):vec4(2,2,2,1);
  }
`;

function replace(source,from,to) {
  if(!source.includes(from))throw Error('Cloud batch shader contract changed: '+from);
  return source.replace(from,to);
}

function opacityPreparation(source,legacyRadiance) {
  // A prepared ray owns only visibility and optical mass. Cached and missing
  // light paths both compose once, after anchors and complete beams exist.
  const start=source.indexOf('        vec3 correction=vec3(0);'),end=source.indexOf('        #else',start);
  if(start<0||end<0)throw Error('Cloud preparation correction boundary changed');
  const output=legacyRadiance?`
    queryRay=vec4(dir,queryOpaqueLimit);queryCached=vec4(0);
    queryMask=vec4(15.0/255.0);queryOpacity=vec4(totalOpacity);
  `:`
    queryRay=vec4(dir,queryOpaqueLimit);queryOpacity=vec4(totalOpacity);
  `;
  source=source.slice(0,start)+output+source.slice(end);
  if(!legacyRadiance)source=replace(source,
    'layout(location=1) out vec4 queryCached;layout(location=2) out vec4 queryMask;layout(location=3) out vec4 queryOpacity;',
    'layout(location=1) out vec4 queryOpacity;vec4 queryCached;');
  const anchorStart=source.indexOf('            if(pass==1 && ext>0.0) {');
  if(anchorStart<0)throw Error('Cloud preparation quantile boundary changed');
  let depth=1,anchorEnd=source.indexOf('{',anchorStart)+1;
  while(depth&&anchorEnd<source.length){const c=source[anchorEnd++];if(c==='{')depth++;if(c==='}')depth--;}
  if(depth)throw Error('Unterminated cloud preparation quantile traversal');
  source=source.slice(0,anchorStart)+source.slice(anchorEnd);
  source=replace(source,'float anchors[32];','');
  return replace(source,'for(int pass=0;pass<2;pass++) {','for(int pass=0;pass<1;pass++) {');
}

function fusedPreparation(source) {
  const start=source.indexOf('        vec3 correction=vec3(0);'),end=source.indexOf('        #else',start);
  if(start<0||end<0)throw Error('Cloud fused preparation boundary changed');
  const output=/* glsl */`
    queryOpacity=vec4(totalOpacity);
    page0=vec4(anchors[0],anchors[1],anchors[2],anchors[3]);
    page1=vec4(anchors[4],anchors[5],anchors[6],anchors[7]);
    page2=vec4(anchors[8],anchors[9],anchors[10],anchors[11]);
    page3=vec4(anchors[12],anchors[13],anchors[14],anchors[15]);
  `;
  source=source.slice(0,start)+output+source.slice(end);
  source=replace(source,
    'layout(location=0) out vec4 queryRay;layout(location=1) out vec4 queryCached;layout(location=2) out vec4 queryMask;layout(location=3) out vec4 queryOpacity;',
    'layout(location=0) out vec4 queryOpacity;layout(location=1) out vec4 page0;layout(location=2) out vec4 page1;layout(location=3) out vec4 page2;layout(location=4) out vec4 page3;vec4 queryCached;');
  source=replace(source,'vec3 dir = normalize(vDirection);',
    'ivec2 pixel=ivec2(gl_FragCoord.xy);\n        if(pixel.y>=textureSize(tPageRay,0).y)discard;\n        vec4 ray=texelFetch(tPageRay,pixel,0);\n        if(dot(ray.xyz,ray.xyz)<.5)discard;\n        vec3 dir=ray.xyz;');
  source=replace(source,'queryOpaqueLimit=sceneRayLimit();t1=min(t1,queryOpaqueLimit);','t1=min(t1,ray.w);');
  return 'uniform sampler2D tPageRay;uniform int uPageRow;\n'+source.replaceAll('gl_FragCoord','(gl_FragCoord+vec4(0,float(uPageRow),0,0))');
}

export function cloudLightBatchShaders(source,{legacyRadiance=false,fusedDensity=false}={}) {
  const shared=cloudLightPageShaders(source);
  const pageDeclarations=fusedDensity?stripeDeclarations:legacyRadiance?declarations:compactDeclarations;
  const adapt=shader=>replace(shader,lightPageDeclarations,pageDeclarations);
  let metadata=adapt(shared.metadata);
  // Preparation already owns the FP32 ray opacity. Reuse that CDF mass
  // instead of traversing the same density a third time in every batch.
  metadata=replace(metadata,'float totalOpacity=0.0;',
    'float totalOpacity=texelFetch(tPageOpacity,ivec2(queryPixel.xy),0).r;');
  metadata=replace(metadata,'for(int pass=0;pass<2;pass++) {','for(int pass=1;pass<2;pass++) {');
  metadata=replace(metadata,'int tile=int(pageJob(tPageMetaJobs,slot).r)-1;if(tile<0)discard;',
    'int tile=uBatchStart+slot;if(slot>=uBatchCount)discard;');
  let beams=adapt(shared.beams);
  beams=replace(beams,'uvec4 job=pageJob(tPageLightJobs,slot);int tile=int(job.r)-1;if(tile<0)discard;',
    'uvec4 job=uvec4(uBatchStart+slot/4+1,slot%4,slot/4+1,0);int tile=int(job.r)-1;if(slot/4>=uBatchCount)discard;');
  let compose=replace(adapt(shared.compose),'int meta=int(texelFetch(tPageMetaMap,pageTile(pixel),0).r)-1;',
    'int meta=pageSlot(pixel);');
  // One owner chooses cached versus physical depth for each anchor/field.
  // Composition reads that complete FP32 page instead of querying the cache
  // again or relying on matching cache branches in two compiled programs.
  compose=replace(compose,'bool cached=cloudCachedLight(local,path,pathDepth);','bool cached=false;');
  let reduce=adapt(shared.reduce);
  if(fusedDensity) {
    compose=replace(compose,'texelFetch(tPageOpacity,pixel,0).r','texelFetch(tPageOpacity,stripePixel(pixel),0).r');
    reduce=replace(reduce,'ivec2(gl_FragCoord.xy);int mask=0;',
      'ivec2(gl_FragCoord.xy)+ivec2(0,uPageRow/16);int mask=0;');
    reduce=replace(reduce,'for(int y=0;y<16;y++)','for(int y=0;y<16 && mask!=15;y++)');
  }
  const rayEnd=source.indexOf('        #if PRODUCTION_CLOUD_MEDIUM && CLOUD_FAR_VIEW',source.lastIndexOf('void main()'));
  if(fusedDensity&&rayEnd<0)throw Error('Cloud ray preparation boundary changed');
  const ray=fusedDensity?replace(source.slice(0,rayEnd),'t1 = min(t1, sceneRayLimit());',
    'float opaqueLimit=sceneRayLimit();t1=min(t1,opaqueLimit);')+
    'gl_FragColor=vec4(dir,opaqueLimit);\n}':null;
  return {prepare:fusedDensity?fusedPreparation(shared.prepare):opacityPreparation(shared.prepare,legacyRadiance),
    metadata,beams,compose,reduce,
    ...(ray?{ray}:{}),
    ...(legacyRadiance?{base:adapt(shared.base),badCached:adapt(shared.badCached)}:{}),badFields:shared.badFields};
}
