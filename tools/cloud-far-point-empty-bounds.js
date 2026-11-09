// Precompute the same nearest occupied radial bins read by productionEmptyRadius.
// A zero byte means the ray never hits an occupied bin on that side of its cell.
export function pointEmptyBounds({data,width,height,depth}) {
  const layerSize = width*height;
  if (depth > 255 || data.length !== layerSize*depth) throw Error('Unexpected Far candidate volume');
  const bounds = new Uint8Array(data.length*2);
  for (let cell=0;cell<layerSize;cell++) {
    let below = 0, above = 0;
    for (let z=0;z<depth;z++) {
      const index = z*layerSize+cell;
      bounds[index*2] = below;
      if (data[index]) below = z+1;
    }
    for (let z=depth-1;z>=0;z--) {
      const index = z*layerSize+cell;
      bounds[index*2+1] = above;
      if (data[index]) above = z+1;
    }
  }
  return bounds;
}

export function farPointEmptyBoundsShader(source) {
  const begin = '    for(int k=1;k<int(uCandidateLayers);k++) {';
  const end = '    float distance=min(radius-below,above-radius);';
  const a = source.indexOf(begin), b = source.indexOf(end);
  if (a < 0 || b <= a || source.slice(a,b).split(begin).length !== 3)
    throw Error('Missing Far empty-radius radial search');
  return 'uniform highp usampler2DArray tPointEmptyBounds;\n'+source.slice(0,a)+`    uvec2 occupied=texelFetch(tPointEmptyBounds,ivec3(cell,layer),0).rg;
    if(occupied.x!=0u && layer+1-int(occupied.x)<int(uCandidateLayers))
      below=max(below,uBodyR+float(occupied.x)*500.0);
    if(occupied.y!=0u && int(occupied.y)-1-layer<int(uCandidateLayers))
      above=min(above,uBodyR+float(occupied.y-1u)*500.0);
`+source.slice(b);
}
