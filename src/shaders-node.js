// Procedural material nodes shared by terrain, water, cloud decks and flora.
// These materials compile through WebGPURenderer on both WebGPU and WebGL2.

import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, acos, atan, attribute, color, cos, cross, dot, exp, float, fract,
  instanceIndex, length, mix, mx_fractal_noise_float,
  normalLocal, normalView, normalViewGeometry, positionGeometry, positionLocal,
  positionView, positionViewDirection, pow, reference, reflect, select, sign, sin, smoothstep, texture,
  transformNormalToView, uniform, sqrt,
  vec2, vec3, vertexColor,
} from 'three/tsl';
import { Simplex } from './noise.js';
import { makeRng } from './rng.js';
import { waterInteraction } from './water-interaction.js';
import { surfaceInteraction } from './surface-interaction.js';
import { surfaceMaterialSlots, watchSurfaceTexture } from './surface-materials.js';

export const TIME = { value: 0 };
export function tickShaders(dt) { TIME.value += dt; }
export const WIND = new THREE.Vector4(1, 0, 0.25, 0);
export function setWeatherWind(direction = null, strength = 0, gust = 0) {
  const x = Number(direction?.x) || 0;
  const z = Number(direction?.z) || 0;
  const inverse = 1 / Math.max(1e-6, Math.hypot(x, z));
  WIND.x = x * inverse;
  WIND.y = z * inverse;
  WIND.z = THREE.MathUtils.clamp(strength, 0, 2);
  WIND.w = THREE.MathUtils.clamp(gust, 0, 1);
}

let _detailTex = null;
let _detailData = null;
const DETAIL_SIZE = 512;

function analyticEclipseVisibility(localPosition, sunDirection, nodes) {
  const toOccluder = nodes.uEclipseCenter.sub(localPosition);
  const along = dot(toOccluder, sunDirection.normalize()).max(0);
  const perpendicular = sqrt(dot(toOccluder, toOccluder)
    .sub(along.mul(along)).max(0));
  // The stellar angular radius expands the penumbra with distance from the
  // occluder. This is a real spherical shadow field evaluated at each surface
  // sample, not a camera-facing black decal.
  const penumbra = along.mul(nodes.uEclipseStarAngle).max(0.5);
  const visibility = smoothstep(nodes.uEclipseRadius.sub(penumbra),
    nodes.uEclipseRadius.add(penumbra), perpendicular);
  const inFront = dot(toOccluder, sunDirection.normalize()).greaterThan(0);
  return mix(float(1), select(inFront, visibility, float(1)),
    nodes.uEclipseEnabled.clamp(0, 1));
}

export function sampleDetailCPU(u, v, ch) {
  if (!_detailData) return 0.5;
  const S = DETAIL_SIZE;
  const x = (u - Math.floor(u)) * S, y = (v - Math.floor(v)) * S;
  const x0 = x | 0, y0 = y | 0, x1 = (x0 + 1) % S, y1 = (y0 + 1) % S;
  const fx = x - x0, fy = y - y0, c = ch === 0 ? 0 : 1;
  const a = _detailData[(y0 * S + x0) * 4 + c], b = _detailData[(y0 * S + x1) * 4 + c];
  const d = _detailData[(y1 * S + x0) * 4 + c], e = _detailData[(y1 * S + x1) * 4 + c];
  return ((a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy) / 255;
}

export function detailTexture() {
  if (_detailTex || typeof document === 'undefined') return _detailTex;
  const S = DETAIL_SIZE, canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d'), image = ctx.createImageData(S, S);
  const n1 = new Simplex(makeRng('detail:1')), n2 = new Simplex(makeRng('detail:2'));
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const a = x / S * Math.PI * 2, b = y / S * Math.PI * 2;
    const cx = Math.cos(a), sx = Math.sin(a), cy = Math.cos(b), sy = Math.sin(b);
    const v1 = n1.fbm(cx + 3, sx + cy, sy - cx, 1.5, 4, 0.55, 2.2, 1e9);
    const v2 = n2.fbm(cy - 1, sy + sx, cx + 2, 3.1, 4, 0.55, 2.2, 1e9);
    const k = (y * S + x) * 4;
    image.data[k] = (v1 * 0.5 + 0.5) * 255;
    image.data[k + 1] = (v2 * 0.5 + 0.5) * 255;
    image.data[k + 2] = 128; image.data[k + 3] = 255;
  }
  ctx.putImageData(image, 0, 0); _detailData = image.data;
  _detailTex = new THREE.CanvasTexture(canvas);
  _detailTex.wrapS = _detailTex.wrapT = THREE.RepeatWrapping;
  _detailTex.colorSpace = THREE.NoColorSpace;
  return _detailTex;
}

export function disposeDetailTexture() {
  if (_detailTex) { _detailTex.dispose(); _detailTex = null; }
  _detailData = null;
}

function smooth01(lo, hi, value) {
  const t = Math.min(1, Math.max(0, (value - lo) / Math.max(hi - lo, 1e-6)));
  return t * t * (3 - 2 * t);
}

function normalized(x, y, z) {
  const k = 1 / Math.max(Math.hypot(x, y, z), 1e-6);
  return { x: x * k, y: y * k, z: z * k };
}

function stormAtCPU(d, center, phase, radius) {
  const ref = Math.abs(center.y) < 0.88 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const ta = normalized(ref.y * center.z - ref.z * center.y,
    ref.z * center.x - ref.x * center.z, ref.x * center.y - ref.y * center.x);
  const tb = normalized(center.y * ta.z - center.z * ta.y,
    center.z * ta.x - center.x * ta.z, center.x * ta.y - center.y * ta.x);
  const dc = Math.min(1, Math.max(-1, d.x * center.x + d.y * center.y + d.z * center.z));
  const x = d.x * ta.x + d.y * ta.y + d.z * ta.z;
  const y = d.x * tb.x + d.y * tb.y + d.z * tb.z;
  const inv = 1 / Math.max(x * x + y * y, 1e-5);
  const r = Math.sqrt(Math.max(0, 2 * (1 - dc))) / radius;
  const shield = (1 - smooth01(0.08, 0.5, r)) * 0.58;
  const turn = phase - r * 13;
  const arms = smooth01(0.66, 0.94,
    0.5 + 0.5 * (2 * x * y * inv * Math.cos(turn) + (x * x - y * y) * inv * Math.sin(turn)))
    * smooth01(0.1, 0.24, r) * (1 - smooth01(0.62, 1, r));
  return Math.max(shield, arms);
}

function cloudSystemCPU(d, ox, oy, oz) {
  const c1 = normalized(Math.sin(ox * 1.31 + 0.4), Math.sin(oy * 1.17 - 1.2) * 0.72,
    Math.cos(oz * 1.43 + 0.7));
  const ref = Math.abs(c1.y) < 0.8 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
  const cross = normalized(c1.y * ref.z - c1.z * ref.y,
    c1.z * ref.x - c1.x * ref.z, c1.x * ref.y - c1.y * ref.x);
  const c2 = normalized(cross.x + c1.x * 0.16, cross.y + c1.y * 0.16, cross.z + c1.z * 0.16);
  return Math.max(stormAtCPU(d, c1, oz, 0.92), stormAtCPU(d, c2, ox + oy, 0.68) * 0.72);
}

function cloudSystemTexture(ox, oy, oz) {
  const width = 192, height = 192;
  const data = new Uint8Array(width * height);
  const d = { x: 0, y: 0, z: 0 };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let px = ((x + 0.5) / width) * 2 - 1;
      let pz = ((y + 0.5) / height) * 2 - 1;
      const py = 1 - Math.abs(px) - Math.abs(pz);
      if (py < 0) {
        const oldX = px;
        px = (1 - Math.abs(pz)) * Math.sign(oldX || 1);
        pz = (1 - Math.abs(oldX)) * Math.sign(pz || 1);
      }
      const inv = 1 / Math.max(Math.hypot(px, py, pz), 1e-6);
      d.x = px * inv; d.y = py * inv; d.z = pz * inv;
      data[y * width + x] = Math.round(cloudSystemCPU(d, ox, oy, oz) * 255);
    }
  }
  const map = new THREE.DataTexture(data, width, height, THREE.RedFormat);
  map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
  map.minFilter = map.magFilter = THREE.LinearFilter;
  map.colorSpace = THREE.NoColorSpace;
  map.needsUpdate = true;
  return map;
}

let _blankTex = null;
function blankTexture() {
  if (!_blankTex) {
    _blankTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1);
    _blankTex.needsUpdate = true;
  }
  return _blankTex;
}

export function cloudDensityCPU(d, cov0, cov1, ox, oy, oz) {
  let f = sampleDetailCPU(d.x * 0.55 + ox, d.y * 0.55 + oy, 1) * 0.5;
  f += sampleDetailCPU(d.y * 1.15 + oy, d.z * 1.15 + oz, 0) * 0.25;
  f += sampleDetailCPU(d.z * 2.35 + oz, d.x * 2.35 + ox, 1) * 0.125;
  f += sampleDetailCPU(d.x * 4.8 - ox, d.y * 4.8 - oz, 0) * 0.0625;
  f /= 0.9375;
  return Math.max(Math.pow(smooth01(cov0, cov1, f), 1.3),
    cloudSystemCPU(d, ox, oy, oz) * smooth01(0.24, 0.68, f) * 0.86);
}

export function cloudBaseDensityCPU(d, cov0, cov1, ox, oy, oz) {
  let f = sampleDetailCPU(d.x * 0.55 + ox, d.y * 0.55 + oy, 1) * 0.5;
  f += sampleDetailCPU(d.y * 1.15 + oy, d.z * 1.15 + oz, 0) * 0.25;
  f += sampleDetailCPU(d.z * 2.35 + oz, d.x * 2.35 + ox, 1) * 0.125;
  f += sampleDetailCPU(d.x * 4.8 - ox, d.y * 4.8 - oz, 0) * 0.0625;
  return Math.pow(smooth01(cov0, cov1, f / 0.9375), 1.3);
}

function copyMaterialFlags(source, target) {
  for (const key of ['transparent', 'opacity', 'side', 'depthWrite', 'depthTest',
    'vertexColors', 'flatShading', 'alphaTest', 'blending', 'forceSinglePass']) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  return target;
}

function paletteEnds(planet) {
  const land = planet.pal?.land || [];
  return {
    low: land[0]?.c || new THREE.Color(0x3d4a3f),
    high: land[land.length - 1]?.c || new THREE.Color(0xb0a58c),
    rock: planet.pal?.rock || new THREE.Color(0x5f5c58),
  };
}

function dynamicSurfaceTexture(name) {
  const node = texture(surfaceMaterialSlots[name].value);
  watchSurfaceTexture(name, (value) => { node.value = value; });
  return node;
}

export function applyTerrainDetail(source, planet, strength = 0.2, macroK = 0.4) {
  const material = copyMaterialFlags(source, new MeshStandardNodeMaterial({ roughness: 1, metalness: 0 }));
  // Geometry morphing alone still leaves a rectangular material boundary:
  // the child occupies its parent's shape while height, snow and biome masks
  // already use child values. These per-object references share the exact
  // quadtree morph factor, so position and every semantic field transition as
  // one surface. All terrain geometries provide zero delta attributes at root.
  const lodMorph = reference('userData.lodMorph', 'float');
  const morphedPosition = positionLocal
    .add(attribute('aPositionDelta', 'vec3').mul(lodMorph));
  const surfaceNormal = normalLocal
    .add(attribute('aNormalDelta', 'vec3').mul(lodMorph)).normalize();
  const local = attribute('aLocal', 'vec3')
    .add(attribute('aPositionDelta', 'vec3').mul(lodMorph));
  const matWeights = attribute('aMat', 'vec3')
    .add(attribute('aMatDelta', 'vec3').mul(lodMorph));
  const extra = attribute('aExtra', 'vec4')
    .add(attribute('aExtraDelta', 'vec4').mul(lodMorph));
  const h = length(local).sub(planet.R);
  const U = planet.palU || {};
  const heightMix = h.sub(U.t0 || 0).div(Math.max(1, U.tSpan || planet.hAmp)).clamp(0, 1);
  const palette = paletteEnds(planet);
  let landSurface = uniform(U.landC?.[0] || palette.low);
  const landCount = U.landC ? U.landN : 1;
  for (let i = 1; i < landCount; i++) {
    landSurface = mix(landSurface, uniform(U.landC[i]),
      heightMix.sub(U.landT[i - 1]).div(Math.max(U.landT[i] - U.landT[i - 1], 1e-5)).clamp(0, 1));
  }
  let seaSurface = uniform(U.seaC?.[0] || palette.low);
  const seaMix = float(1).sub(float(U.t0 || 0).sub(h).div(Math.max(1, U.seaDepthSpan || planet.hAmp))).clamp(0, 1);
  const seaCount = U.seaC ? U.seaN : 1;
  for (let i = 1; i < seaCount; i++) {
    seaSurface = mix(seaSurface, uniform(U.seaC[i]),
      seaMix.sub(U.seaT[i - 1]).div(Math.max(U.seaT[i] - U.seaT[i - 1], 1e-5)).clamp(0, 1));
  }
  landSurface = mix(landSurface, uniform(U.forest || palette.low), extra.x);
  landSurface = mix(landSurface, uniform(U.blotch || palette.rock), extra.y);
  if ((U.stripeK || 0) > 0.001) {
    landSurface = mix(landSurface, mix(uniform(U.stripeA), uniform(U.stripeB), extra.z), U.stripeK);
  }
  if ((U.extraMode || 0) > 2.5) landSurface = landSurface.mul(float(1).add(extra.w.sub(0.5).mul(0.2)));
  else if ((U.extraMode || 0) > 0.5) landSurface = mix(landSurface, uniform(U.extraC), extra.w);
  const direction = local.normalize();
  const eclipseNodes = {
    uEclipseCenter: uniform(new THREE.Vector3()),
    uEclipseRadius: uniform(1),
    uEclipseStarAngle: uniform(0),
    uEclipseEnabled: uniform(0),
    uEclipseSunDir: uniform(planet?.sunDirLocal?.clone() || new THREE.Vector3(0, 1, 0)),
  };
  const eclipseVisibility = analyticEclipseVisibility(
    local, eclipseNodes.uEclipseSunDir, eclipseNodes);
  const slope = float(1).sub(dot(surfaceNormal, direction).clamp(0, 1));
  const axis = abs(surfaceNormal);
  const surfaceUv = select(axis.x.greaterThan(axis.y).and(axis.x.greaterThan(axis.z)), local.yz,
    select(axis.y.greaterThan(axis.z), local.zx, local.xy)).mul(0.085);
  const grassColorMap = dynamicSurfaceTexture('grassColor');
  const grassNormalMap = dynamicSurfaceTexture('grassNormal');
  const grassOrmMap = dynamicSurfaceTexture('grassOrm');
  const rockColorMap = dynamicSurfaceTexture('rockColor');
  const rockNormalMap = dynamicSurfaceTexture('rockNormal');
  const rockRoughnessMap = dynamicSurfaceTexture('rockRoughness');
  landSurface = mix(landSurface, uniform(U.rock || palette.rock),
    smoothstep(U.slopeLo ?? 0.08, U.slopeHi ?? 0.34, slope));
  // The geological coast is a material transition with wet sediment and
  // suspended shallows, not a binary height branch. A hard select exposed the
  // dark seabed in one antialiased pixel and read as a black ink outline.
  const coastWidth = Math.max(6, planet.hAmp * 0.0018);
  const coastMaterial = smoothstep((U.t0 || 0) - coastWidth,
    (U.t0 || 0) + coastWidth, h);
  let surface = U.hasSea ? mix(seaSurface, landSurface, coastMaterial) : landSurface;

  const detailMap = detailTexture();
  const weights0 = pow(abs(surfaceNormal), vec3(4));
  const weights = weights0.div(weights0.x.add(weights0.y).add(weights0.z).max(1e-5));
  const triDetail = (p, scale, channel = 'r') => {
    const a = texture(detailMap, p.yz.mul(scale));
    const b = texture(detailMap, p.zx.mul(scale));
    const c = texture(detailMap, p.xy.mul(scale));
    return a[channel].mul(weights.x).add(b[channel].mul(weights.y)).add(c[channel].mul(weights.z));
  };
  const grain = triDetail(local, 1 / 26, 'r').sub(0.5)
    .add(triDetail(local, 1 / 3.2, 'g').sub(0.5).mul(0.8));
  const strat = texture(detailMap, vec2(length(local).mul(0.055), 0.31)).r.sub(0.5);
  let detail = mix(grain, grain.mul(0.5).add(strat.mul(1.15)), matWeights.x);
  detail = detail.add(triDetail(local, (1 / 3.2) * 0.32, 'r').sub(0.5).mul(matWeights.y).mul(0.75));
  surface = surface.mul(float(1).add(detail.mul(strength)));
  const pbrNear = float(1).sub(smoothstep(18, 92, positionView.z.negate()));
  const pbrRock = smoothstep(U.slopeLo ?? 0.08, U.slopeHi ?? 0.34, slope);
  const pbrGrass = grassColorMap.sample(surfaceUv).rgb;
  const pbrStone = rockColorMap.sample(surfaceUv.mul(0.78).add(0.17)).rgb;
  const pbrSample = mix(pbrGrass, pbrStone, pbrRock);
  const pbrLum = dot(pbrSample, vec3(0.2126, 0.7152, 0.0722));
  const earthLike = planet.type === 'lush' || planet.type === 'ocean' ? 0.42 : 0;
  const pbrStructure = mix(vec3(pbrLum), pbrSample, earthLike).mul(1.45).clamp(0.58, 1.42);
  surface = surface.mul(mix(vec3(1), pbrStructure, pbrNear.mul(0.48)));
  const macro = triDetail(local, 0.0013, 'r').add(triDetail(local, 0.00028, 'g')).sub(1);
  const macroWeight = macro.mul(1.5).add(0.5).clamp(0, 1).mul(macroK);
  surface = surface.mul(mix(vec3(1), vec3(1.09, 0.99, 0.84), macroWeight));

  // Satellite-scale mineral, moisture and drainage structure. The previous
  // shader jumped directly from continental height colours to sub-kilometre
  // grain, leaving 5–40 km regions as smooth pastel polygons. These
  // triplanar bands remain continuous across chunk and cube-face boundaries
  // and survive the orbital pixel footprint without becoming a painted map.
  const provinceMineral = triDetail(local, 1 / 18000, 'r')
    .mul(0.58).add(triDetail(local, 1 / 7200, 'g').mul(0.42));
  const drainage = triDetail(local, 1 / 10500, 'g')
    .sub(triDetail(local, 1 / 3200, 'r').mul(0.34));
  const exposedMineral = smoothstep(0.54, 0.82, provinceMineral)
    .mul(float(0.35).add(slope.mul(1.6))).clamp(0, 0.72);
  const humidLowland = smoothstep(0.62, 0.28, drainage)
    .mul(float(1).sub(smoothstep(0.22, 0.5, slope))).clamp(0, 0.48);
  surface = mix(surface, surface.mul(vec3(0.72, 0.78, 0.76)),
    exposedMineral.mul(0.42));
  surface = mix(surface, surface.mul(vec3(0.68, 0.86, 0.72)),
    humidLowland.mul(earthLike));

  // mid-scale patchiness (~100–500 m): soil and moisture variation — the
  // octave between micro grain and continental swathes that uniform game
  // terrain lacks. Damp hollows darken and cool slightly.
  const pch = triDetail(local, 0.0035, 'g').add(triDetail(local, 0.0012, 'r')).sub(1);
  surface = surface.mul(float(1).add(pch.mul(float(0.30).add(matWeights.z.mul(0.20))).mul(float(0.5).add(macroK))));
  surface = mix(surface, surface.mul(vec3(0.88, 0.97, 0.92)), pch.mul(-1.8).clamp(0, 0.5).mul(macroK));

  surface = mix(surface.mul(vec3(0.78, 0.82, 0.9)), surface, matWeights.z);

  // A shoreline is a zone, not one elevation contour. Darken the terrain in
  // an irregular 1–9 m band above sea level; the same mid-scale field varies
  // its reach so the transition never reads as a ruler-straight colour line.
  if (U.hasSea) {
    const shoreHeight = h.sub(U.t0 || 0);
    const wetReach = triDetail(local, 0.018, 'g').mul(12).add(4);
    const aboveWater = smoothstep(-0.35, 0.45, shoreHeight);
    const wetBand = aboveWater.mul(float(1).sub(smoothstep(0.35, wetReach, shoreHeight)));
    // Wet sand darkens and cools, but must remain a material transition. The
    // former 42% red multiplier collapsed pale beaches into a near-black
    // contour at grazing angles—the apparent "outline" in the user capture.
    surface = mix(surface, surface.mul(vec3(0.76, 0.82, 0.86)), wetBand.mul(0.52));
  }

  let snowWeight = float(0);
  if (planet.pal?.snow) {
    const latitude = abs(direction.y).add(texture(detailMap, direction.xz.mul(2).add(direction.y)).r.sub(0.5).mul(0.12));
    const snowLine = float(planet.pal.snowLine).mul(float(1).sub(smoothstep(0.45, 0.95, latitude).mul(0.65)));
    // A broad accumulation interval avoids converting interpolated orbital
    // height into hard white polygons. Latitude establishes climate, while
    // wind packing and exposed mineral decide where snow actually remains.
    snowWeight = smoothstep(snowLine, snowLine.add(planet.hAmp * 0.2), h)
      .max(smoothstep(planet.pal.capLat, planet.pal.capLat + 0.085, latitude))
      .mul(float(1).sub(smoothstep(0.42, 0.72, slope).mul(0.92)));
    const windPack = triDetail(local, 1 / 8800, 'g').mul(0.58)
      .add(triDetail(local, 1 / 2600, 'r').mul(0.42));
    const scouredRock = smoothstep(0.56, 0.82, provinceMineral)
      .mul(smoothstep(0.12, 0.5, slope));
    snowWeight = snowWeight
      .mul(float(0.18).add(smoothstep(0.25, 0.76, windPack).mul(0.82)))
      .mul(float(1).sub(scouredRock.mul(0.76)));
    // Snow retains blue-grey self-shadow, wind-packed grain and exposed-rock
    // modulation. A pure white constant clipped under ACES and turned entire
    // mountain ranges into flat unlit polygons at 45–140 km.
    const snowGrain = triDetail(local, 1 / 42, 'g').sub(0.5)
      .add(triDetail(local, 1 / 9, 'r').sub(0.5).mul(0.38));
    const snowShade = float(0.72).add(snowGrain.mul(0.2))
      .sub(slope.mul(0.34)).clamp(0.44, 0.88);
    const snowSurface = uniform(planet.pal.snow)
      .mul(mix(vec3(0.48, 0.56, 0.67), vec3(0.68, 0.75, 0.84), windPack))
      .mul(snowShade);
    surface = mix(surface, snowSurface, snowWeight.mul(0.72));
  }

  // Real soil, vegetation and snow albedos sit well below one. Keeping the
  // globe inside that energy range preserves relief under ACES instead of
  // clipping broad biomes into flat white/green cut-outs.
  const orbitalSurface = smoothstep(18000, 180000, positionView.z.negate());
  if (planet.type === 'lush' || planet.type === 'ocean') {
    const remoteLuma = dot(surface, vec3(0.2126, 0.7152, 0.0722));
    surface = mix(surface, vec3(remoteLuma), orbitalSurface.mul(0.1))
      .mul(mix(0.78, 0.68, orbitalSurface));
  } else {
    surface = surface.mul(0.86);
  }

  const cloudMap = texture(planet.cloudShadowTex || blankTexture());
  const cloudMatrix = uniform(new THREE.Matrix3());
  const cloudDirection = cloudMatrix.mul(direction);
  const cloudU = float(0.5).add(atan(cloudDirection.z, cloudDirection.x.negate()).mul(0.15915494));
  const cloudV = float(1).sub(acos(cloudDirection.y.clamp(-1, 1)).mul(0.31830988));
  const cloudK = uniform(planet.cloudMesh ? 0.42 : 0);
  surface = surface.mul(float(1).sub(cloudMap.sample(vec2(cloudU, cloudV)).r.mul(cloudK)));
  // Retain diffuse sky/ground bounce inside totality while removing the
  // impossible fully lit patch. The local field provides a continuous moving
  // umbra/penumbra across the spherical terrain.
  material.colorNode = surface.mul(mix(float(0.38), float(1), eclipseVisibility));
  const pbrRoughness = mix(grassOrmMap.sample(surfaceUv).g,
    rockRoughnessMap.sample(surfaceUv.mul(0.78).add(0.17)).r, pbrRock);
  material.roughnessNode = mix(float(1).sub(snowWeight.mul(0.34)).add(pch.mul(0.12)).clamp(0.38, 1),
    pbrRoughness.clamp(0.38, 1), pbrNear.mul(0.35));

  // valley mist: haze pools in the low country and thickens with distance —
  // the depth cue that sells scale from altitude. Mirrors the fog_fragment
  // injection in shaders-webgl.js.
  {
    const mistBase = planet.liquid === 'lava' ? 0.05 : (planet.hasLiquid ? 0.26 : 0.1);
    const uMistK = uniform(mistBase * Math.min(planet.atmoDensity || 0.4, 1));
    const uMistH = uniform(planet.hAmp * 0.12);
    // Already linear: THREE.Color(hex) decodes sRGB on construction.
    const uMistColor = uniform((planet.skyColor || new THREE.Color(0x7894b8)).clone());
    const mistHeight = h.sub(U.t0 || 0);
    const mistFactor = smoothstep(uMistH, float(0), mistHeight)
      .mul(float(1).sub(positionView.z.negate().mul(3.2e-4).exp()));
    const mist = uMistK.mul(mistFactor).clamp(0, 0.6);
    material.colorNode = mix(material.colorNode, uMistColor, mist);
  }

  // Micro-relief: bend the shading normal with the detail gradient and the
  // KTX2 surface normal maps. A proper TBN (tangent/bitangent from the
  // geometric normal) carries the perturbation into the same space the
  // PBR N·L uses; transformNormalToView hands the result to NodeMaterial's
  // view-space normal slot. The earlier tangent-space (gx, gy, 1) shortcut
  // made the ground black when looking up (N·L→0 at oblique angles).
  {
    const nrm = surfaceNormal;
    const tang = nrm.cross(vec3(0, 1, 0)).add(vec3(1e-4, 1e-4, 1e-4)).normalize();
    const bitn = nrm.cross(tang);
    const dx = vec3(0.35, 0, 0), dy = vec3(0, 0.35, 0);
    const gx = triDetail(local.add(dx), 1 / 3.2, 'g')
      .sub(triDetail(local.sub(dx), 1 / 3.2, 'g'));
    const gy = triDetail(local.add(dy), 1 / 3.2, 'g')
      .sub(triDetail(local.sub(dy), 1 / 3.2, 'g'));
    const detailStrength = float(strength).mul(float(1.7).add(matWeights.x.mul(1.5)));
    const scanNear = float(1).sub(smoothstep(8, 72, positionView.z.negate()));
    const grassNormal = grassNormalMap.sample(surfaceUv).xy.mul(2).sub(1);
    const rockNormal = rockNormalMap.sample(surfaceUv.mul(0.78).add(0.17)).xy.mul(2).sub(1);
    const scanNormal = mix(grassNormal, rockNormal, pbrRock).mul(scanNear).mul(0.34);
    const bend = tang.mul(gx.add(scanNormal.x)).add(bitn.mul(gy.add(scanNormal.y)))
      .mul(detailStrength);
    material.normalNode = transformNormalToView(nrm.add(bend).normalize());
  }

  // Geometry follows the same per-object morph authority as its height,
  // biome and snow fields. Custom attributes avoid WebGPU's per-chunk native
  // morph-target textures while retaining the exact parent triangle.
  material.positionNode = morphedPosition;
  material.userData.shader = {
    uniforms: { uCloudMat: cloudMatrix, uCloudK: cloudK, ...eclipseNodes },
  };
  material.userData.cloudShadowTextureNode = cloudMap;
  material.userData.nodeMaterial = 'terrain-layered-pbr-v6-ktx2';
  source.dispose?.();
  return material;
}

export function applyWaterWaves(source, planet, waveScale = 1 / 14) {
  const material = copyMaterialFlags(source, new MeshPhysicalNodeMaterial({
    roughness: source.roughness, metalness: source.metalness,
  }));
  const clock = uniform(TIME.value).onFrameUpdate(() => TIME.value);
  // The ocean is a closed spherical LOD surface. It must write its nearest
  // depth even while blending, or far-side chunks and the sky repeatedly
  // accumulate through the near surface as bright cloud-shaped patches.
  material.depthWrite = true;
  // The water shell sits at the physical sea radius. Pulling it toward the
  // camera with polygon offset defeats terrain occlusion at grazing angles
  // and reveals the bathymetry triangles as a black coastline.
  material.polygonOffset = false;
  const lodMorph = reference('userData.lodMorph', 'float');
  const morphedPosition = positionLocal
    .add(attribute('aPositionDelta', 'vec3').mul(lodMorph));
  const local = attribute('aLocal', 'vec3')
    .add(attribute('aPositionDelta', 'vec3').mul(lodMorph));
  const vertexBathymetry = attribute('aDepth', 'float')
    .add(attribute('aDepthDelta', 'float').mul(lodMorph)).max(0);
  // Bathymetry follows the exact parent triangle while a child relaxes into
  // detail. A hard aDepth swap made kilometres of absorption, foam and shore
  // colour change along a square even though the spherical water positions
  // themselves appeared continuous.
  const depth = vertexBathymetry;
  const nodes = {
    uSkyZenith: uniform((planet?.skyColor || new THREE.Color(0x6faee0)).clone().multiplyScalar(0.72)),
    uSkyHorizon: uniform((planet?.skyColor || new THREE.Color(0x6faee0)).clone()),
    uSunDir: uniform(planet?.sunDirLocal?.clone() || new THREE.Vector3(0, 1, 0)),
    uSecondarySunDir: uniform(new THREE.Vector3(0, -1, 0)),
    uSecondarySunColor: uniform(new THREE.Color(1, 0.98, 0.94)),
    uSecondarySunEnergy: uniform(0),
    uCameraLocal: uniform(new THREE.Vector3(0, 0, (planet?.R || 1000) * 2)),
    uCloudMat: uniform(new THREE.Matrix3()),
    uCloudK: uniform(0),
    uDay: uniform(1),
    uSunset: uniform(0),
    uEclipseCenter: uniform(new THREE.Vector3()),
    uEclipseRadius: uniform(1),
    uEclipseStarAngle: uniform(0),
    uEclipseEnabled: uniform(0),
  };
  const eclipseVisibility = analyticEclipseVisibility(local, nodes.uSunDir, nodes);
  const waterCloudTexture = texture(blankTexture());
  // The authored `pal.sea` ramp already carries this world's art direction for
  // depth: stop 0 is the abyss, the last stop is the shallows. `colorAt` reads
  // it the same way for the sea floor, so surface and floor stay in one hue
  // family as the water turns opaque with depth.
  const seaStops = planet?.pal?.sea;
  const liquid = planet?.liquidColor || new THREE.Color(0x15527e);
  const deep = (seaStops?.[0]?.c?.clone() || new THREE.Color(0x061b35)).lerp(liquid, 0.35);
  // The final terrain sea stop is the *sea floor* (often pale sand), not the
  // water column. Reusing it made every shallow lake an opaque grey sheet.
  const shallow = liquid.clone().lerp(new THREE.Color(0.72, 0.96, 1), 0.28);
  // ---- ocean colour: per-channel radiative transfer ------------------------
  // This replaced a single scalar `1 - exp(-0.05 * depth)` feeding one lerp.
  // Measured over this planet's real bathymetry (median depth 946 m, 95% of
  // the ocean deeper than 92 m) that term had mean 0.9895 and sd 0.0722 — the
  // whole open ocean was pinned to one colour. See docs/optimization-roadmap.md 2.3.
  //
  // Single-scatter form: what leaves the surface is the water column's own
  // upwelling radiance plus whatever survives a round trip to the sea floor,
  //   colour = deep·(1 − T) + shallow·T,   T = exp(−2·k·depth)
  // evaluated per channel. k carries an authored approximation of water's
  // wavelength response: red attenuates three times faster than blue while
  // green bridges the transition. That difference in *rate* produces a
  // continuous turquoise → cyan → blue → indigo ramp instead of a single fill.
  //
  const clarity = planet?.waterStyle?.clarity || 1;
  const depthScale = Math.max(60, ((planet?.seaLevel ?? 0) + (planet?.hAmp ?? 1200) * 0.6) * clarity);
  // Meter-scaled clear-water attenuation. Red light is almost gone after
  // about 20 m of round-trip travel, green after ~65 m and blue after ~190 m.
  // The retired planet-normalized coefficients let red survive for kilometres,
  // which is why a genuinely deep lake still looked like pale knee-deep glass.
  const extinctionValues = [0.11, 0.035, 0.012]
    .map((value) => value / Math.max(0.45, clarity));
  const extinction = uniform(new THREE.Vector3(...extinctionValues));
  const transmit = exp(extinction.mul(depth.mul(-2)));
  // Suspended particles add a non-linear depth haze on top of molecular
  // absorption. It acts on the surviving sea-floor light, so it preserves
  // clear shallows while preventing kilometres-deep water from retaining an
  // implausibly bright floor contribution.
  const depthHaze = smoothstep(0, depthScale * 0.4, depth).mul(0.9);
  const bodyTransmit = transmit.mul(float(1).sub(depthHaze));
  const surfaceVariation = mx_fractal_noise_float(
    local.mul(waveScale).add(vec3(clock.mul(0.021), 0, clock.mul(-0.013))), 4);
  const up = local.normalize();
  const tangent = up.cross(vec3(0, 1, 0)).add(vec3(1e-4, 0, 1e-4)).normalize();
  const bitangent = up.cross(tangent);
  // A pixel of ocean seen from orbit covers kilometres of sea surface, so the
  // slope distribution inside it is far wider than the point-sampled normal
  // suggests. Widening both the Fresnel falloff and the specular lobe with
  // distance is what turns one pinpoint highlight into a real sun glint.
  const viewDist = positionView.z.negate();
  const orbital = smoothstep(30000, 250000, viewDist);
  const fresnel = pow(float(1).sub(abs(dot(normalView.normalize(), positionViewDirection))),
    mix(float(5), float(3.2), orbital));
  // ---- directional ocean spectrum ---------------------------------------
  // The retired shader was three coherent sine bands. From any low flight
  // angle those bands locked into identical parallel streaks and made the
  // entire ocean read as a flat animated card. This deterministic spectrum
  // follows the same cascade split as the local reference implementation:
  // long swell, gravity/wind sea, then short gravity/capillary detail.
  //
  // It is deliberately evaluated as analytic waves rather than a sampled
  // normal texture: geometry displacement, normals, crest compression and
  // whitecaps therefore all come from one phase authority. Short bands fade
  // before they fall below a pixel, integrating their mean-square slope into
  // roughness instead of aliasing into orbit-scale stripes.
  const seaState = THREE.MathUtils.clamp(planet?.waterStyle?.swell || 1, 0.35, 2.4);
  const spectrumRng = makeRng(`${planet?.seed || 'water'}:directional-spectrum:v3`);
  const baseHeading = spectrumRng() * Math.PI * 2;
  const crossHeading = baseHeading
    + (spectrumRng() > 0.5 ? 1 : -1) * (0.82 + spectrumRng() * 0.48);
  const wavelengths = [680, 470, 330, 235, 168, 121, 88, 64, 46, 33, 23, 16, 11, 7.5, 4.8, 3.0];
  const amplitudes = [1.06, 0.82, 0.61, 0.45, 0.33, 0.24, 0.175, 0.126,
    0.09, 0.064, 0.044, 0.03, 0.019, 0.012, 0.007, 0.004];
  const phaseWarp = mx_fractal_noise_float(local.mul(1 / 1900)
    .add(vec3(clock.mul(0.004), 0, clock.mul(-0.003))), 3).sub(0.5);
  let macroWave = float(0);
  let choppyOffset = vec3(0);
  let waveGradient = vec3(0);
  let crestCompression = float(0);
  let resolvedSlope = float(0);
  for (let i = 0; i < wavelengths.length; i++) {
    const wavelength = wavelengths[i];
    const k = Math.PI * 2 / wavelength;
    const omega = Math.sqrt(9.81 * k);
    const amplitude = amplitudes[i] * seaState;
    // A real sea combines a dominant wind sea, one or more remote swells and
    // almost isotropic short gravity/capillary waves. The old hand-authored
    // +/- sequence kept every energetic long band nearly parallel, producing
    // the repeated ruled-paper pattern visible from low flight.
    let heading;
    if (i < 4) {
      heading = (i % 2 === 0 ? baseHeading : crossHeading)
        + (spectrumRng() - 0.5) * 0.16;
    } else if (i < 12) {
      heading = baseHeading + (spectrumRng() - 0.5) * 1.35;
    } else {
      heading = spectrumRng() * Math.PI * 2;
    }
    // A small non-coplanar component prevents a single preferred axis from
    // collapsing at the sphere's poles; projection below restores tangency.
    const globalDirection = new THREE.Vector3(
      Math.cos(heading),
      (spectrumRng() - 0.5) * 0.52,
      Math.sin(heading),
    ).normalize();
    const direction = vec3(globalDirection.x, globalDirection.y, globalDirection.z);
    const projectedDirection = direction.sub(up.mul(dot(direction, up)))
      .add(tangent.mul(0.0001)).normalize();
    const phaseOffset = spectrumRng() * Math.PI * 2;
    // Wrap spatial cycles before converting to radians. On 900 km worlds this
    // preserves metre-scale phase precision in float32 shader arithmetic.
    const spatialPhase = fract(dot(local, direction).mul(1 / wavelength)
      .add(phaseOffset / (Math.PI * 2))).mul(Math.PI * 2);
    const phase = spatialPhase
      .add(phaseWarp.mul(i < 4 ? 0.75 : 1.8))
      .sub(clock.mul(omega * (i % 3 === 1 ? -1 : 1)));
    // At orbital pixel footprints even 500 m swell is unresolved. Preserve
    // its statistical roughness, not its phase; otherwise the last surviving
    // two bands turn into kilometre-long identical diagonal hatch marks.
    const visibility = float(1).sub(smoothstep(wavelength * 22,
      wavelength * 120, viewDist));
    const shallowSuppression = smoothstep(0.45, Math.min(18, wavelength * 0.12 + 3), depth);
    const shoaling = float(1).add(float(1).sub(smoothstep(3, 34, depth)).mul(0.24));
    const response = visibility.mul(shallowSuppression).mul(shoaling);
    const sinPhase = sin(phase);
    const cosPhase = cos(phase);
    const slope = amplitude * k;
    waveGradient = waveGradient.add(projectedDirection.mul(cosPhase)
      .mul(slope).mul(response));
    resolvedSlope = resolvedSlope.add(abs(cosPhase).mul(slope).mul(visibility));
    crestCompression = crestCompression.add(sinPhase.max(0)
      .mul(slope * (i < 8 ? 1.15 : 0.72)).mul(response));
    if (i < 8) {
      macroWave = macroWave.add(sinPhase.mul(amplitude).mul(response));
      const chop = i < 3 ? 0.72 : 0.9;
      choppyOffset = choppyOffset.add(projectedDirection.mul(cosPhase)
        .mul(amplitude * chop).mul(response));
    }
  }
  const waveTangent = dot(waveGradient, tangent);
  const waveBitangent = dot(waveGradient, bitangent);
  let rippleGradient = vec2(0), interactionHeight = float(0), wakeFoam = float(0);
  for (let i = 0; i < waterInteraction.capacity; i++) {
    const impulsePosition = uniform(waterInteraction.positions[i]);
    const impulse = uniform(waterInteraction.data[i]);
    const impulseDirection = uniform(waterInteraction.directions[i]);
    const delta = local.sub(impulsePosition);
    const planar = vec2(dot(delta, tangent), dot(delta, bitangent));
    const distance = length(planar).max(0.05);
    const ring = distance.sub(impulse.x.mul(impulse.y));
    const impactEnvelope = abs(ring).mul(-0.24).sub(impulse.x.mul(0.42))
      .exp().mul(impulse.z);
    const impactGradient = planar.div(distance).mul(cos(ring.mul(1.4)))
      .mul(impactEnvelope).mul(0.72);
    const impactCrest = float(0.32).add(sin(ring.mul(1.4)).max(0).mul(0.68));
    const impactFoam = impactEnvelope.mul(impulse.w).mul(impactCrest).mul(1.75);

    // Directional hull wake: two divergent Kelvin arms plus a narrow,
    // aerated turbulent centre. Repeated impulses form a continuous trail;
    // they never expand into the fake concentric circles used for footsteps.
    const wakeAxis = impulseDirection.xyz.sub(up.mul(dot(impulseDirection.xyz, up)))
      .add(tangent.mul(0.0001)).normalize();
    const wakeSide = cross(up, wakeAxis).normalize();
    const along = dot(delta, wakeAxis);
    const lateral = dot(delta, wakeSide);
    const aft = float(1).sub(smoothstep(-2, 8, along));
    const trailDistance = along.negate().max(0);
    // Each injected segment owns only a short patch of the wake. The moving
    // source lays those patches along the flight path; allowing every old
    // segment to grow a full speed×age wedge stacked a dozen giant white
    // triangles on top of one another.
    const trailLength = impulse.x.mul(impulse.y).mul(0.55).add(18);
    const tailEnd = float(1).sub(smoothstep(trailLength, trailLength.add(14), trailDistance));
    const forwardFade = exp(along.max(0).mul(-0.34));
    const ageFade = exp(impulse.x.mul(-0.34));
    const wakeEnvelope = aft.mul(tailEnd).mul(forwardFade).mul(ageFade).mul(impulse.z);
    const armTarget = trailDistance.min(40).mul(0.16).add(4.2);
    const armDistance = abs(abs(lateral).sub(armTarget));
    const armEnvelope = exp(armDistance.mul(-0.72)).mul(wakeEnvelope);
    const centreEnvelope = exp(abs(lateral).mul(-0.18))
      .mul(exp(along.max(0).mul(-0.4))).mul(wakeEnvelope);
    const armOscillation = cos(armDistance.mul(2.1).sub(impulse.x.mul(4.2)));
    const wakeGradientObject = wakeSide.mul(sign(lateral).mul(armOscillation)
      .mul(armEnvelope).mul(0.72))
      .sub(wakeAxis.mul(centreEnvelope.mul(0.08)));
    const wakeGradient = vec2(dot(wakeGradientObject, tangent),
      dot(wakeGradientObject, bitangent));
    const bowPressure = exp(abs(lateral).mul(-0.2))
      .mul(exp(abs(along).mul(-0.24))).mul(wakeEnvelope);
    const directionalFoam = armEnvelope.mul(1.15)
      .add(centreEnvelope.mul(0.5))
      .add(bowPressure.mul(0.7))
      .mul(impulse.w).mul(3.2);
    const isWake = smoothstep(0.5, 0.51, impulseDirection.w);
    rippleGradient = rippleGradient.add(mix(impactGradient, wakeGradient, isWake));
    const impactHeight = sin(ring.mul(1.4)).mul(impactEnvelope).mul(0.58);
    const wakeHeight = armOscillation.mul(armEnvelope).mul(0.68)
      .add(bowPressure.mul(0.42))
      .sub(centreEnvelope.mul(0.16));
    interactionHeight = interactionHeight.add(mix(impactHeight, wakeHeight, isWake));
    wakeFoam = wakeFoam.add(mix(impactFoam, directionalFoam, isWake));
  }
  // The previous derivative-based widening operated on vertex-baked depth.
  // At low grazing angles one triangle could span hundreds of metres, turning
  // its derivative into a screen-sized foam polygon. Pixel depth gives a
  // continuous physical breaking zone without exposing the water mesh.
  const breakingBand = pow(float(1).sub(smoothstep(0.08, 3.8, depth)), 0.72);
  const shorePulse = sin(depth.mul(1.35).sub(clock.mul(1.8)).add(surfaceVariation.mul(5)))
    .mul(0.5).add(0.5);
  const shoreFoam = breakingBand.mul(float(0.42).add(shorePulse.mul(0.58)))
    .mul(planet?.waterStyle?.foam || 1);
  const whitecapNoise = mx_fractal_noise_float(local.mul(0.045)
    .add(vec3(clock.mul(0.08), 0, clock.mul(-0.05))), 3);
  const openWaterWhitecap = smoothstep(0.075, 0.24, crestCompression)
    .mul(smoothstep(5, 32, depth))
    .mul(smoothstep(0.38, 0.76, whitecapNoise))
    .mul(planet?.waterStyle?.foam || 1);
  const foam = shoreFoam.mul(0.84).add(openWaterWhitecap).add(wakeFoam).clamp(0, 0.96);
  // A NodeMaterial custom normal is already in view space.  Feeding it a
  // tangent-space `(x,y,1)` locked the highlight to the camera and made the
  // entire ocean look like a flat blue card.  Build the radial object-space
  // normal, bend it along the local surface basis, then transform it once.
  const normalObject = up
    .sub(tangent.mul(waveTangent.add(rippleGradient.x.mul(0.55))))
    .sub(bitangent.mul(waveBitangent.add(rippleGradient.y.mul(0.55))))
    .normalize();
  material.normalNode = transformNormalToView(normalObject);

  // Planet-local view and reflection vectors keep the result stable while the
  // body rotates. The reflected sky is the same live zenith/horizon state used
  // by the atmospheric dome, and the deterministic weather atlas adds moving
  // cloud shapes instead of a fixed blue wash.
  const viewDirLocal = nodes.uCameraLocal.sub(local).normalize();
  const reflected = reflect(viewDirLocal.negate(), normalObject).normalize();
  const skyElevation = dot(reflected, up).clamp(0, 1);
  let reflectedSky = mix(nodes.uSkyHorizon, nodes.uSkyZenith, pow(skyElevation, 0.42))
    .mul(float(0.18).add(nodes.uDay.mul(0.82)));
  const reflectedCloudDir = up.add(reflected.sub(up.mul(dot(reflected, up))).mul(0.16)).normalize();
  const cloudDirection = nodes.uCloudMat.mul(reflectedCloudDir);
  const cloudU = float(0.5).add(atan(cloudDirection.z, cloudDirection.x.negate()).mul(0.15915494));
  const cloudV = float(1).sub(acos(cloudDirection.y.clamp(-1, 1)).mul(0.31830988));
  const reflectedCloud = waterCloudTexture.sample(vec2(cloudU, cloudV)).r.mul(nodes.uCloudK);
  const cloudTint = mix(vec3(0.76, 0.82, 0.9), nodes.uSkyHorizon,
    nodes.uSunset.mul(0.52));
  reflectedSky = mix(reflectedSky, cloudTint, reflectedCloud.mul(0.78));
  const horizonReflection = float(1).sub(smoothstep(0.05, 0.58, skyElevation));
  reflectedSky = reflectedSky.add(nodes.uSkyHorizon
    .mul(nodes.uSunset.mul(horizonReflection).mul(0.58)));

  // The broad, distance-aware solar lobe is evaluated against the displaced
  // normal. It therefore travels across the waves and warms naturally with
  // the live sunset horizon colour.
  const sunHalf = nodes.uSunDir.normalize().add(viewDirLocal).normalize();
  const sunGlint = pow(dot(normalObject, sunHalf).max(0), mix(float(520), float(86), orbital))
    .mul(smoothstep(-0.04, 0.22, dot(up, nodes.uSunDir)))
    .mul(float(0.4).add(nodes.uDay.mul(0.6)));
  // MeshPhysicalNodeMaterial already evaluates the real near-field stellar
  // highlight. The authored broad lobe exists only to keep an unresolved sun
  // glint readable from orbit; adding it at the surface double-counted the
  // star and formed a white vertical stripe across the horizon.
  reflectedSky = reflectedSky.add(nodes.uSkyHorizon
    .mul(sunGlint.mul(orbital).mul(3.2)));
  const secondaryHalf = nodes.uSecondarySunDir.normalize().add(viewDirLocal).normalize();
  const secondaryGlint = pow(dot(normalObject, secondaryHalf).max(0),
    mix(float(520), float(86), orbital))
    .mul(smoothstep(-0.04, 0.22, dot(up, nodes.uSecondarySunDir)))
    .mul(nodes.uSecondarySunEnergy);
  reflectedSky = reflectedSky.add(nodes.uSecondarySunColor
    .mul(secondaryGlint.mul(orbital).mul(3.2)));

  // Schlick reflection (n≈1.33) plus per-channel body transmission. Shallow
  // water remains transparent enough for the physical transmission pass to
  // refract the seabed; deep water becomes its own radiating body colour.
  const skyResponse = float(0.025).add(fresnel.mul(0.875)).clamp(0, 0.92);
  const bodyWater = mix(uniform(deep), uniform(shallow), bodyTransmit);
  // Thin crests transmit forward-scattered skylight while troughs retain
  // denser body colour. This is subtle in plan view but gives low flight a
  // readable wave silhouette even under an evenly overcast sky.
  const crestHeight = smoothstep(0.25, Math.max(1.2, seaState * 2.2), macroWave);
  const backlit = float(1).sub(dot(up, nodes.uSunDir).abs()).mul(0.18)
    .add(dot(normalObject, nodes.uSunDir).negate().max(0).mul(0.22));
  const crestScatter = crestHeight.mul(float(0.16).add(backlit))
    .mul(float(1).sub(orbital));
  const baseWater = bodyWater.mul(float(0.9).add(surfaceVariation.mul(0.09)))
    .add(uniform(shallow).mul(crestScatter));
  // Open water has very little Lambertian albedo. Most of what the eye reads
  // is reflected sky plus depth-dependent volume scattering; treating the
  // water body as a bright diffuse sheet erased both wave contrast and depth.
  const bodyDiffuse = mix(float(0.72), float(0.3), smoothstep(2, 120, depth));
  material.colorNode = mix(baseWater.mul(bodyDiffuse), vec3(0.92, 0.97, 1), foam)
    .mul(mix(float(0.5), float(1), eclipseVisibility));
  // Reflected radiance is not diffuse albedo: putting it in colorNode caused
  // the lighting pass to darken sunsets a second time. Keep the water body in
  // the physical BRDF and feed live sky/cloud/sun radiance through emissive.
  material.emissiveNode = reflectedSky.min(vec3(1.4)).mul(skyResponse.mul(0.52))
    .mul(mix(float(0.72), float(1), eclipseVisibility))
    // Foam is bright because it is diffuse aerated water, not a light source.
    // Keeping only a small skylight term avoids the former full-screen white
    // disk when several wake segments overlapped under bloom.
    .add(vec3(0.88, 0.95, 1).mul(foam.mul(0.05)));
  const opacity = uniform(source.opacity ?? 1);
  const depthOpacity = float(1).sub(exp(depth.mul(-0.055)));
  // The sea is a continuous physical shell. Dry terrain is already outside
  // that radius and wins the depth test; using vertex-baked bathymetry as an
  // alpha cutout made a single orbit triangle decide kilometres of coastline.
  // Depth still controls absorption, foam and transmission, never existence.
  // Even optically shallow water is a refractive participating surface, not a
  // 32%-alpha overlay. Keeping it mostly present prevents the opaque terrain
  // silhouette from leaking the renderer's clear-black resolve through the
  // first swash pixels; transmission still carries the visible sea floor.
  const waterAlpha = mix(opacity.mul(0.78), opacity.max(0.96), depthOpacity);
  material.opacityNode = mix(waterAlpha, waterAlpha.mul(2.1).add(0.2).min(1), fresnel)
    .max(0.72);
  material.alphaTest = 0;
  material.transmissionNode = bodyTransmit.b.mul(float(1).sub(fresnel))
    // Direct seabed visibility belongs to genuinely shallow water. Letting
    // 50–140 m columns transmit exposed terrain LOD boundaries and made deep
    // lakes read as knee-deep glass.
    .mul(float(1).sub(smoothstep(6, 32, depth))).mul(0.62);
  material.thicknessNode = depth.min(42).mul(0.28);
  material.iorNode = float(1.333);
  material.attenuationColor = deep.clone();
  material.attenuationDistance = Math.max(35, depthScale * 0.08);
  // A wind-driven ocean is not a polished mirror. The former 0.07 minimum
  // collapsed the entire low-angle sea into a white sunset sheet and a hard
  // vertical sun stripe. Keep individual glints, but integrate the unresolved
  // capillary slope distribution into a broader physically plausible lobe.
  // Bands filtered below pixel resolution survive as mean-square slope. This
  // widens distant glints without resurrecting their periodic phase pattern.
  const slopeRoughness = smoothstep(0.035, 0.24, resolvedSlope).mul(0.18);
  material.roughnessNode = float(0.13).add(slopeRoughness)
    .add(surfaceVariation.mul(0.08)).add(foam.mul(0.26))
    .add(orbital.mul(0.11)).clamp(0.12, 0.68);

  // A sub-metre shore overlap makes the transparent water cover the opaque
  // terrain silhouette's antialias samples. It is depth-tested, so dry land
  // still wins immediately inland; visually this becomes the wet swash/foam
  // edge instead of a one-pixel clear-black crack.
  // A centimetre-scale bias avoids coplanar flicker at the exact zero contour
  // without lifting water metres through low beaches and inland terrain.
  const shoreOverlap = float(0.12);
  material.positionNode = morphedPosition.add(up.mul(
    macroWave.add(interactionHeight).add(shoreOverlap),
  ))
    .add(choppyOffset);
  material.userData.shader = { uniforms: nodes };
  material.userData.waterCloudTexture = waterCloudTexture;
  material.userData.waterProfile = {
    depthScale,
    extinction: extinctionValues,
    extinctionUnits: 'inverse-metres',
    depthHaze: { distance: depthScale * 0.4, strength: 0.9 },
    spectrum: {
      model: 'directional-jonswap-inspired',
      wavelengths,
      amplitudes: amplitudes.map((amplitude) => amplitude * seaState),
      cascades: ['swell', 'wind-sea', 'short-gravity-capillary'],
      choppyDisplacement: true,
      jacobianWhitecaps: true,
      meanSquareSlopeFiltering: true,
    },
    interactiveDisplacement: true,
    transmission: true,
    dynamicSky: true,
    cloudReflection: true,
    radianceReflection: true,
    wetShore: true,
    deterministicBathymetry: true,
  };
  material.userData.nodeMaterial = 'water-cross-sea-spectrum-v7';
  material.userData.opacityNodeUniform = opacity;
  source.dispose?.();
  return material;
}

export function applyCloudField(source, coverage, offX, offY, offZ,
  relief = 0, weatherMap = null, family = 'low') {
  const material = copyMaterialFlags(source, new MeshBasicNodeMaterial());
  // The analytic distant deck and close volume consume the same authored
  // equirectangular Lo/Hi weather atlas. A procedural fallback remains only
  // for standalone material tests that do not construct a Planet.
  const stableWeatherMap = weatherMap || cloudSystemTexture(offX, offY, offZ);
  const weatherTextureNode = texture(stableWeatherMap);
  const nodes = {
    uCov0: uniform(0.55 - coverage * 0.24), uCov1: uniform(0.86 - coverage * 0.14),
    uCOff: uniform(new THREE.Vector3(offX, offY, offZ)),
    uCloudRelief: uniform(relief), uCamProx: uniform(1), uSurfaceView: uniform(0),
    uCSun: uniform(new THREE.Vector3(0, 1, 0)), uOpacity: uniform(source.opacity ?? 1),
  };
  const direction = positionLocal.normalize();
  // One equirectangular weather atlas is authoritative at every distance and
  // on every renderer. The previous triplanar field changed frequency with
  // camera radius, so clouds visibly rearranged while the player orbited.
  const weatherUV = (d) => vec2(
    float(0.5).add(atan(d.z.negate(), d.x.negate()).mul(0.15915494)),
    acos(d.y.clamp(-1, 1)).mul(0.31830988),
  );
  const cloudSample = (d) => {
    const sampleDirection = d.normalize();
    const uv = weatherUV(sampleDirection);
    const weather = weatherTextureNode.sample(uv);
    // The 1024x512 CPU atlas already contains deterministic four-octave
    // erosion. Sampling another periodic detail field in the fragment shader
    // duplicated work, painted latitude stripes and let noise create clouds
    // where the weather authority was clear. Orbit now costs one atlas lookup
    // for shape plus one displaced lookup for directional self-shadow.
    const density = weather.r;
    const cloudType = weather.g;
    const stratus = family === 'high' ? float(0) : weather.b;
    const convective = family === 'high' ? weather.b : cloudType;
    const scatter = weather.a;
    const macro = family === 'high'
      ? smoothstep(0.075, 0.36, density)
      : smoothstep(
        mix(0.31, 0.14, stratus).sub(cloudType.mul(0.025)),
        mix(0.6, 0.5, stratus).sub(cloudType.mul(0.018)),
        density,
      );
    const cellular = pow(macro, mix(1.48, 0.96, cloudType));
    const sheet = smoothstep(0.11, 0.57, density);
    const amount = family === 'high'
      ? cellular.mul(mix(0.68, 1, convective)).clamp(0, 1)
      : mix(cellular, sheet, stratus.mul(0.84)).clamp(0, 1);
    return {
      density,
      amount,
      macro,
      cloudType,
      stratus,
      convective,
      scatter,
    };
  };
  const cloud = cloudSample(direction);
  const amount = cloud.amount;
  // Reconstruct a cloud-top normal from the same occupied weather field that
  // displaces the shell. A radial sphere normal makes even a 14 km relief map
  // shade like a painted film; two neighbouring atlas samples recover the
  // kilometre-scale slopes visible in oblique orbital photography.
  const tangentEast = vec3(direction.z.negate(), 0.0001, direction.x).normalize();
  const tangentNorth = cross(direction, tangentEast).normalize();
  const gradientStep = mix(0.0048, 0.0028, nodes.uSurfaceView);
  const eastCloud = cloudSample(
    direction.add(tangentEast.mul(gradientStep)).normalize());
  const northCloud = cloudSample(
    direction.add(tangentNorth.mul(gradientStep)).normalize());
  const reliefSlope = mix(1.15, 2.45, cloud.cloudType)
    .mul(mix(1, 0.52, cloud.stratus));
  const cloudTopNormal = direction
    .sub(tangentEast.mul(eastCloud.amount.sub(amount)).mul(reliefSlope))
    .sub(tangentNorth.mul(northCloud.amount.sub(amount)).mul(reliefSlope))
    .normalize();
  const sunCloud = cloudSample(
    direction.add(nodes.uCSun.normalize().mul(mix(0.026, 0.012, nodes.uSurfaceView)))
      .normalize(),
  );
  const selfShadow = float(1)
    // Preserve the atlas density gradient instead of comparing two saturated
    // coverage masks. This exposes the sunward cauliflower relief inside a
    // storm shield, not just along its outer silhouette.
    .sub(sunCloud.density.sub(cloud.density).max(0).mul(2.8))
    .sub(smoothstep(0.28, 0.82, cloud.density).mul(0.24))
    .add(cloud.scatter.mul(0.12))
    .clamp(0.32, 1.04);
  const day = smoothstep(-0.18, 0.24, dot(direction, nodes.uCSun.normalize()));
  const topLight = smoothstep(-0.2, 0.72,
    dot(cloudTopNormal, nodes.uCSun.normalize()))
    .mul(day);
  const edge = smoothstep(0.025, 0.24, amount)
    .mul(float(1).sub(smoothstep(0.52, 0.94, amount)));
  const denseCore = smoothstep(0.3, 0.84, cloud.density)
    .mul(smoothstep(0.28, 0.9, amount));
  const baseColor = source.color?.clone() || new THREE.Color(0xffffff);
  material.colorNode = uniform(baseColor)
    .mul(mix(0.2, mix(0.46, 1.18, topLight), day)).mul(selfShadow)
    .mul(mix(1, 0.7, denseCore))
    .add(vec3(0.15, 0.19, 0.27).mul(cloud.scatter)
      .mul(day).mul(mix(0.32, 0.16, denseCore)))
    .add(vec3(0.32, 0.39, 0.5).mul(edge).mul(day).mul(0.34))
    .add(vec3(0.025, 0.04, 0.075).mul(denseCore)
      .mul(float(1).sub(day)).mul(0.8));
  // Water clouds become optically opaque after only a short occupied column.
  // Coverage is now calibrated spatially, so opacity can describe real column
  // depth without being abused to hide an overcast white shell.
  const opticalDepth = amount.mul(family === 'high'
    ? mix(0.34, 0.88, cloud.convective)
    : mix(0.82, 2.45, cloud.cloudType))
    .mul(mix(1, 0.64, cloud.stratus));
  material.opacityNode = float(1).sub(exp(opticalDepth.negate()))
    .mul(mix(family === 'high' ? 0.24 : 0.56, 1, cloud.macro))
    .mul(nodes.uCamProx).mul(nodes.uOpacity);
  const verticalShape = pow(amount, mix(1.42, 0.92, cloud.cloudType))
    .mul(mix(0.42, 1, cloud.cloudType))
    .mul(mix(1, 0.16, cloud.stratus));
  material.positionNode = positionLocal.add(
    direction.mul(nodes.uCloudRelief).mul(verticalShape),
  );
  material.uniforms = nodes;
  material.userData.weatherSystemTexture = stableWeatherMap;
  material.userData.weatherSystemTextureNode = weatherTextureNode;
  material.userData.shader = { uniforms: nodes };
  material.userData.nodeMaterial = family === 'high'
    ? 'cloud-deck-v3-high-weather-relief'
    : 'cloud-deck-v3-low-weather-relief';
  material.userData.cloudFamily = family;
  material.userData.opacityNodeUniform = nodes.uOpacity;
  source.dispose?.();
  return material;
}

export function applyNoctilucentField(source, coverage, offX, offY, offZ,
  weatherMap = null) {
  const material = copyMaterialFlags(source, new MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  }));
  const detailMap = detailTexture();
  const highWeather = texture(weatherMap || cloudSystemTexture(offX, offY, offZ));
  const nodes = {
    uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
    uOpacity: uniform(source.opacity ?? 0.12),
    uOffset: uniform(new THREE.Vector3(offX, offY, offZ)),
  };
  const direction = positionLocal.normalize();
  const uv = vec2(
    float(0.5).add(atan(direction.z, direction.x.negate()).mul(0.15915494)),
    float(1).sub(acos(direction.y.clamp(-1, 1)).mul(0.31830988)),
  );
  const system = highWeather.sample(uv).r;
  const filaments = texture(detailMap,
    uv.mul(vec2(96, 18)).add(nodes.uOffset.xy.mul(0.13))).g.mul(0.62)
    .add(texture(detailMap,
      uv.mul(vec2(211, 37)).sub(nodes.uOffset.zx.mul(0.09))).r.mul(0.38));
  const wisps = smoothstep(0.32, 0.68, system)
    .mul(smoothstep(0.46, 0.72, filaments))
    .mul(coverage);
  const sunElevation = dot(direction, nodes.uSunDir.normalize());
  // Mesospheric ice remains sunlit after the ground has entered shadow. Limit
  // it to the terminator belt so it appears as the real silver-blue hairline
  // seen from orbit, never as another daytime painted cloud shell.
  const twilight = smoothstep(-0.42, -0.08, sunElevation)
    .mul(smoothstep(0.14, -0.035, sunElevation));
  const grazing = pow(float(1).sub(abs(dot(normalView.normalize(),
    positionViewDirection))), 2.2);
  material.colorNode = mix(vec3(0.18, 0.42, 0.78), vec3(0.72, 0.9, 1.18),
    filaments).mul(float(0.48).add(grazing.mul(0.8)));
  material.opacityNode = wisps.mul(twilight).mul(nodes.uOpacity)
    .mul(float(0.25).add(grazing.mul(0.95))).clamp(0, 0.22);
  material.positionNode = positionLocal.add(direction.mul(filaments.sub(0.5).mul(260)));
  material.uniforms = nodes;
  material.userData.shader = { uniforms: nodes };
  material.userData.opacityNodeUniform = nodes.uOpacity;
  material.userData.nodeMaterial = 'noctilucent-mesosphere-v1';
  source.dispose?.();
  return material;
}

export const GROW = { value: 1 };

export function applyWindSway(source, amount, foliageLighting = false) {
  const material = copyMaterialFlags(source, new MeshStandardNodeMaterial({
    roughness: source.roughness, metalness: source.metalness,
    emissive: source.emissive?.clone?.() || new THREE.Color(),
    emissiveIntensity: source.emissiveIntensity ?? 1,
  }));
  const grow = uniform(GROW.value).onFrameUpdate(() => GROW.value);
  const clock = uniform(TIME.value).onFrameUpdate(() => TIME.value);
  const windX = uniform(WIND.x).onFrameUpdate(() => WIND.x);
  const windZ = uniform(WIND.y).onFrameUpdate(() => WIND.y);
  const windStrength = uniform(WIND.z).onFrameUpdate(() => WIND.z);
  const gustStrength = uniform(WIND.w).onFrameUpdate(() => WIND.w);
  // Phase based on instance position (via positionLocal, which carries the
  // instance translation) — matches the WebGL deck's
  // ph = ip.x*0.61 + ip.y*0.53 + ip.z*0.47. Using instanceIndex gave every
  // neighbouring blade a random phase, so the whole field oscillated
  // out-of-sync and read as "earthquake jitter".
  const phase = positionLocal.x.mul(0.61)
    .add(positionLocal.y.mul(0.53))
    .add(positionLocal.z.mul(0.47));
  // positionGeometry is the raw attribute — untouched by instancing — so its
  // y gives the true 0–5 m local height the sway was tuned against. Using
  // positionLocal.y would read the world-space coordinate (~90k) and produce
  // enormous sway offsets (the "plants flying into the sky" bug).
  const height = positionGeometry.y.max(0);
  const tipWeight = smoothstep(0, 0.65, height);
  // Five nested scales: prevailing lean, trunk/grass sway, branch response,
  // secondary crosswind and (for foliage) leaf flutter. Gusts modulate only
  // amplitude; their value never changes any oscillator frequency.
  const gustEnvelope = float(1).add(gustStrength.mul(float(0.52)
    .add(sin(clock.mul(0.23).add(phase.mul(0.11))).mul(0.48))));
  const primary = sin(clock.mul(0.82).add(phase)).mul(0.56);
  const branch = sin(clock.mul(1.9).add(phase.mul(1.67))).mul(0.29);
  const secondary = sin(clock.mul(3.4).add(phase.mul(0.73))).mul(0.13);
  const flutter = foliageLighting
    ? sin(clock.mul(7.6).add(phase.mul(2.31))).mul(0.08) : float(0);
  const along = primary.add(branch).add(flutter).mul(gustEnvelope)
    .add(windStrength.mul(0.34));
  const across = secondary.mul(gustEnvelope);
  const windScale = windStrength.mul(amount).mul(height).mul(grow);
  const swayX = windX.mul(along).sub(windZ.mul(across)).mul(windScale);
  const swayZ = windZ.mul(along).add(windX.mul(across)).mul(windScale);
  // Surface interaction pressure (landing/collision push). positionLocal is
  // used here (not positionGeometry) because the anchor attribute is in
  // instance-local space and the instance matrix is already applied.
  const anchor = attribute('iAnchor', 'vec3');
  let pressure = float(0);
  for (let i = 0; i < surfaceInteraction.positions.length; i++) {
    const centre = uniform(surfaceInteraction.positions[i]);
    const data = uniform(surfaceInteraction.data[i]);
    const falloff = float(1).sub(smoothstep(0, centre.w, length(anchor.sub(centre.xyz))))
      .mul(data.y).mul(exp(data.x.negate()));
    pressure = pressure.max(falloff);
  }
  const tip = tipWeight;
  const push = pressure.mul(tip);
  // Do NOT multiply positionLocal by grow: it includes the instance
  // translation, so scaling it would drag every plant toward the world
  // origin. Grow only modulates sway strength; visibility is handled by
  // scatter via mesh.visible.
  material.positionNode = positionLocal
    .add(vec3(swayX.add(sin(phase).mul(push).mul(0.7)),
      height.mul(push).mul(-0.68), swayZ.add(cos(phase).mul(push).mul(0.7))));
  material.colorNode = source.vertexColors ? vertexColor() : uniform(source.color?.clone() || new THREE.Color(1, 1, 1));
  if (foliageLighting) material.normalNode = normalViewGeometry;
  // emissive is already set via constructor (emissive/emissiveIntensity).
  // For vertex-coloured flora, multiply emissive by vertex colour to match
  // the WebGL deck's totalEmissiveRadiance *= vColor.rgb.
  if (source.vertexColors && source.emissive) {
    material.emissiveNode = uniform(source.emissive.clone()).mul(vertexColor());
  }
  material.userData.nodeMaterial = 'wind-sway-v3-weather-hierarchy';
  source.dispose?.();
  return material;
}
