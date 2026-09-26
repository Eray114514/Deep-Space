// One spherical mapping for volume, far clouds, surface shadows and CPU queries.
// Canvas atlases are uploaded flipY=true: row zero is the south pole.
export const weatherAtlasGLSL = /* glsl */`
vec2 weatherAtlasUV(vec3 direction) {
  vec3 d = normalize(direction);
  // Longitude is undefined at the poles; use the same meridian on CPU/GPU.
  float u = dot(d.xz, d.xz) < 1e-12 ? 0.5 : 0.5 + atan(-d.z, -d.x) * 0.15915494309189535;
  return vec2(u,
    acos(clamp(d.y, -1.0, 1.0)) * 0.3183098861837907);
}
`;

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
      const row = Math.max(0, Math.min(atlas.height - 1, iy + dy));
      const offset = (row * atlas.width + col) * 4;
      const weight = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      for (let k = 0; k < 4; k++) result[k] += atlas.data[offset + k] / (atlas.scale ?? 255) * weight;
    }
  }
  return result;
}
