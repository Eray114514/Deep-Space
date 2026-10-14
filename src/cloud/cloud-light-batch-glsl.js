import {cloudLightPageShaders,lightPageDeclarations} from './cloud-light-query-glsl.js';

const declarations=/* glsl */`
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
  float pageBeamDepth(ivec2 pixel,int field,int bin){
    int slot=pageSlot(pixel)*4+field;
    ivec2 cell=ivec2(slot%uPageLightColumns*16,slot/uPageLightColumns*256+bin*16)+pixel%16;
    return texelFetch(tPageLight,cell,0).r;
  }
`;

// Instanced rectangles remove empty tiles before the heavy fragment kernels.
// PAGE_MODE 0: anchors, 1: four light fields, 2: original output pixel tiles.
export const cloudLightBatchVertex=/* glsl */`
  uniform sampler2D tPageTileMask;
  uniform ivec2 uPageSize;
  uniform vec2 uPageAtlasSize;
  uniform int uPageTilesX,uPageMetaColumns,uPageLightColumns,uBatchStart,uBatchCount;
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
    bool valid=meta<uBatchCount&&all(lessThan(original,textureSize(tPageTileMask,0)));
    int mask=valid?int(round(texelFetch(tPageTileMask,original,0).r*255.0)):0;
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

export function cloudLightBatchShaders(source) {
  const shared=cloudLightPageShaders(source);
  const adapt=shader=>replace(shader,lightPageDeclarations,declarations);
  let metadata=adapt(shared.metadata);
  metadata=replace(metadata,'int tile=int(pageJob(tPageMetaJobs,slot).r)-1;if(tile<0)discard;',
    'int tile=uBatchStart+slot;if(slot>=uBatchCount)discard;');
  let beams=adapt(shared.beams);
  beams=replace(beams,'uvec4 job=pageJob(tPageLightJobs,slot);int tile=int(job.r)-1;if(tile<0)discard;',
    'uvec4 job=uvec4(uBatchStart+slot/4+1,slot%4,slot/4+1,0);int tile=int(job.r)-1;if(slot/4>=uBatchCount)discard;');
  const compose=replace(adapt(shared.compose),'int meta=int(texelFetch(tPageMetaMap,pageTile(pixel),0).r)-1;',
    'int meta=pageSlot(pixel);');
  return {prepare:shared.prepare,metadata,beams,compose,base:adapt(shared.base),reduce:adapt(shared.reduce),
    badCached:adapt(shared.badCached),badFields:shared.badFields};
}
