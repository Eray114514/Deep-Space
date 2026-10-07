// One spherical mapping for volume, far clouds, surface shadows and CPU queries.
// CPU atlas row zero is the south pole; upload reverses rows for this UV map.
export const weatherAtlasGLSL = /* glsl */`
precision highp sampler2D;
float synopticCoverage(float encoded, float transitionWidth) {
  return smoothstep(-transitionWidth, transitionWidth, (encoded - 0.5) * 4.0);
}
// Driver atan/acos approximations can shift steep regional terrain by metres.
// Reduce atan to |x| <= tan(pi/8), then use the convergent odd series. This
// preserves the authored atlas mapping at Float32 precision on ANGLE/D3D11.
float weatherAtan2(float y,float x) {
  vec2 a=abs(vec2(x,y));
  float ratio=min(a.x,a.y)/max(max(a.x,a.y),1e-30);
  bool reduce=ratio>0.414213562373095;
  float t=reduce?(ratio-1.0)/(ratio+1.0):ratio,z=t*t;
  float angle=t*(1.0+z*(-1.0/3.0+z*(1.0/5.0+z*(-1.0/7.0+z*(1.0/9.0
    +z*(-1.0/11.0+z*(1.0/13.0+z*(-1.0/15.0+z*(1.0/17.0+z*(-1.0/19.0))))))))));
  if(reduce)angle+=0.7853981633974483;
  if(a.y>a.x)angle=1.5707963267948966-angle;
  if(x<0.0)angle=3.141592653589793-angle;
  return y<0.0?-angle:angle;
}
vec2 weatherAtlasUV(vec3 direction) {
  vec3 d = normalize(direction);
  // Longitude is undefined at the poles; use the same meridian on CPU/GPU.
  float u = dot(d.xz, d.xz) < 1e-12 ? 0.5 : 0.5 + weatherAtan2(-d.z, -d.x) * 0.15915494309189535;
  return vec2(u,
    weatherAtan2(length(d.xz),d.y) * 0.3183098861837907);
}
vec4 weatherAtlasSample(sampler2D atlas, vec3 direction) {
  ivec2 size = textureSize(atlas, 0);
  vec2 p = weatherAtlasUV(direction) * vec2(size) - 0.5;
  ivec2 cell = ivec2(floor(p));
  vec2 f = fract(p);
  int x0 = (cell.x % size.x + size.x) % size.x;
  int x1 = (x0 + 1) % size.x;
  int y0 = clamp(cell.y, 0, size.y - 1);
  int y1 = clamp(cell.y + 1, 0, size.y - 1);
  return mix(mix(texelFetch(atlas, ivec2(x0,y0),0), texelFetch(atlas,ivec2(x1,y0),0),f.x),
    mix(texelFetch(atlas,ivec2(x0,y1),0),texelFetch(atlas,ivec2(x1,y1),0),f.x),f.y);
}
`;

export function decodeSynopticCoverage(encoded, transitionWidth = 0.12) {
  const t = Math.max(0, Math.min(1, ((encoded - 0.5) * 4 + transitionWidth) / (2 * transitionWidth)));
  return t * t * (3 - 2 * t);
}

export function sampleWeatherAtlas(atlas, direction, spin = 0) {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (!(length > 0) || !Number.isFinite(length) || !Number.isFinite(spin)) {
    throw new RangeError('Weather atlas needs a finite nonzero direction and spin');
  }
  const c = Math.cos(spin), s = Math.sin(spin);
  const x = (c * direction.x - s * direction.z) / length;
  const z = (s * direction.x + c * direction.z) / length;
  const u = x * x + z * z < 1e-12 ? 0.5 : 0.5 + Math.atan2(-z, -x) / (2 * Math.PI);
  const v = Math.acos(Math.max(-1, Math.min(1, direction.y / length))) / Math.PI;
  const px = u * atlas.width - 0.5, py = (1 - v) * atlas.height - 0.5;
  const ix = Math.floor(px), iy = Math.floor(py), fx = px - ix, fy = py - iy;
  const result = [0, 0, 0, 0];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const col = ((ix + dx) % atlas.width + atlas.width) % atlas.width;
      let row = Math.max(0, Math.min(atlas.height - 1, iy + dy));
      if(atlas.northFirst) row=atlas.height-1-row;
      const offset = (row * atlas.width + col) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      for (let k = 0; k < 4; k++) result[k] += atlas.data[offset + k] / (atlas.scale ?? 255) * weight;
    }
  }
  return result;
}
