// Procedural material nodes shared by terrain, water, cloud decks and flora.
// These materials compile through WebGPURenderer on both WebGPU and WebGL2.

import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, acos, atan, attribute, color, cos, cross, dot, exp, float, fract,
  instanceIndex, length, mix, mx_fractal_noise_float,
  normalLocal, normalView, normalViewGeometry, positionGeometry, positionLocal,
  positionView, positionViewDirection, pow, reflect, select, sign, sin, smoothstep, texture,
  transformNormalToView, uniform,
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
  const local = attribute('aLocal', 'vec3');
  const matWeights = attribute('aMat', 'vec3');
  const extra = attribute('aExtra', 'vec4');
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
  const slope = float(1).sub(dot(normalLocal.normalize(), direction).clamp(0, 1));
  const axis = abs(normalLocal.normalize());
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
  const weights0 = pow(abs(normalLocal.normalize()), vec3(4));
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
    snowWeight = smoothstep(snowLine, snowLine.add(planet.hAmp * 0.1), h)
      .max(smoothstep(planet.pal.capLat, planet.pal.capLat + 0.07, latitude))
      .mul(float(1).sub(smoothstep(0.55, 0.8, slope).mul(0.85)));
    // Snow retains blue-grey self-shadow, wind-packed grain and exposed-rock
    // modulation. A pure white constant clipped under ACES and turned entire
    // mountain ranges into flat unlit polygons at 45–140 km.
    const snowGrain = triDetail(local, 1 / 42, 'g').sub(0.5)
      .add(triDetail(local, 1 / 9, 'r').sub(0.5).mul(0.38));
    const snowShade = float(0.78).add(snowGrain.mul(0.22))
      .sub(slope.mul(0.28)).clamp(0.5, 0.94);
    const snowSurface = uniform(planet.pal.snow)
      .mul(vec3(0.78, 0.84, 0.92)).mul(snowShade);
    surface = mix(surface, snowSurface, snowWeight.mul(0.92));
  }

  const cloudMap = texture(planet.cloudShadowTex || blankTexture());
  const cloudMatrix = uniform(new THREE.Matrix3());
  const cloudDirection = cloudMatrix.mul(direction);
  const cloudU = float(0.5).add(atan(cloudDirection.z, cloudDirection.x.negate()).mul(0.15915494));
  const cloudV = float(1).sub(acos(cloudDirection.y.clamp(-1, 1)).mul(0.31830988));
  const cloudK = uniform(planet.cloudMesh ? 0.42 : 0);
  surface = surface.mul(float(1).sub(cloudMap.sample(vec2(cloudU, cloudV)).r.mul(cloudK)));
  material.colorNode = surface;
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
    const nrm = normalLocal.normalize();
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

  material.userData.shader = { uniforms: { uCloudMat: cloudMatrix, uCloudK: cloudK } };
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
  const local = attribute('aLocal', 'vec3');
  const vertexBathymetry = attribute('aDepth', 'float').max(0);
  // LOD-matched bathymetry comes from the same deterministic height authority
  // as collision. Framebuffer depth exposed terrain T-junctions as dark lines
  // through otherwise clear water.
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
  };
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
  // Clarity is normalised to each planet's own bathymetry so shallow and
  // abyssal worlds are both well exposed: blue reaches ~90% extinction at 45%
  // of the deepest water (this planet's measured p90 sits at 43.8% of max).
  const clarity = planet?.waterStyle?.clarity || 1;
  const depthScale = Math.max(60, ((planet?.seaLevel ?? 0) + (planet?.hAmp ?? 1200) * 0.6) * clarity);
  // The green and blue bands intentionally retain energy over hundreds to
  // thousands of metres. This produces measurable colour separation through
  // the real bathymetry instead of saturating every open-ocean pixel.
  const extinction = uniform(new THREE.Vector3(1.8, 1.2, 0.6)
    .multiplyScalar(2.3 / (0.9 * depthScale)));
  const transmit = exp(extinction.mul(depth.mul(-2)));
  // Suspended particles add a non-linear depth haze on top of molecular
  // absorption. It acts on the surviving sea-floor light, so it preserves
  // clear shallows while preventing kilometres-deep water from retaining an
  // implausibly bright floor contribution.
  const depthHaze = smoothstep(0, depthScale * 0.4, depth).mul(0.9);
  const bodyTransmit = transmit.mul(float(1).sub(depthHaze));
  const wave = mx_fractal_noise_float(
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
  // Swell: wavelengths 393 / 233 / 146 m. Amplitudes were 0.26 / 0.14 / 0.07 m
  // — a peak displacement of 0.47 m on a 286 km planet, i.e. geometrically
  // flat. Real swell of these wavelengths runs metres high; 2.2 / 1.1 / 0.5 m
  // gives a max slope of 3.5%, well below the 1/7 breaking limit.
  const seaState = planet?.waterStyle?.swell || 1;
  const A1 = 2.2 * seaState, A2 = 1.1 * seaState, A3 = 0.5 * seaState;
  const phase1 = local.x.add(local.z).mul(0.016).add(clock.mul(0.82));
  const phase2 = local.z.sub(local.y.mul(0.7)).mul(0.027).sub(clock.mul(1.07));
  const phase3 = local.x.mul(0.55).add(local.y).mul(0.043).add(clock.mul(1.34));
  // Analytic gradient of the swell sum, sharing the amplitudes and the
  // ∂phase/∂local coefficients above so the shading normal can never drift out
  // of agreement with the displaced geometry.
  const waveGradient = vec3(
    cos(phase1).mul(A1 * 0.016).add(cos(phase3).mul(A3 * 0.02365)),
    cos(phase2).mul(A2 * -0.0189).add(cos(phase3).mul(A3 * 0.043)),
    cos(phase1).mul(A1 * 0.016).add(cos(phase2).mul(A2 * 0.027)));
  // The geometry now carries the true slope, so the normal uses the gradient at
  // unit strength instead of the old 5.2× exaggeration that stood in for a
  // displacement of almost zero.
  const waveTangent = dot(waveGradient, tangent);
  const waveBitangent = dot(waveGradient, bitangent);
  // Capillary and short wind waves live in the shading normal: putting
  // two-to-ten metre wavelengths in a ~29 m geometry grid would alias, while
  // omitting them leaves the surface as polished plastic between swells.
  const windPhase1 = dot(local, tangent).mul(1.7)
    .add(dot(local, bitangent).mul(0.43)).add(clock.mul(2.7));
  const windPhase2 = dot(local, tangent).mul(-0.61)
    .add(dot(local, bitangent).mul(2.35)).sub(clock.mul(3.4));
  const windTangent = cos(windPhase1).mul(0.052).sub(cos(windPhase2).mul(0.028));
  const windBitangent = cos(windPhase1).mul(0.013).add(cos(windPhase2).mul(0.067));
  let rippleGradient = vec2(0), wakeFoam = float(0);
  for (let i = 0; i < waterInteraction.capacity; i++) {
    const impulsePosition = uniform(waterInteraction.positions[i]);
    const impulse = uniform(waterInteraction.data[i]);
    const delta = local.sub(impulsePosition);
    const planar = vec2(dot(delta, tangent), dot(delta, bitangent));
    const distance = length(planar).max(0.05);
    const ring = distance.sub(impulse.x.mul(impulse.y));
    const envelope = abs(ring).mul(-0.24).sub(impulse.x.mul(0.42)).exp().mul(impulse.z);
    rippleGradient = rippleGradient.add(planar.div(distance).mul(cos(ring.mul(1.4))).mul(envelope).mul(0.72));
    const crest = float(0.32).add(sin(ring.mul(1.4)).max(0).mul(0.68));
    wakeFoam = wakeFoam.add(envelope.mul(impulse.w).mul(crest).mul(1.75));
  }
  // The previous derivative-based widening operated on vertex-baked depth.
  // At low grazing angles one triangle could span hundreds of metres, turning
  // its derivative into a screen-sized foam polygon. Pixel depth gives a
  // continuous physical breaking zone without exposing the water mesh.
  const breakingBand = pow(float(1).sub(smoothstep(0.08, 3.8, depth)), 0.72);
  const shorePulse = sin(depth.mul(1.35).sub(clock.mul(1.8)).add(wave.mul(5)))
    .mul(0.5).add(0.5);
  const shoreFoam = breakingBand.mul(float(0.42).add(shorePulse.mul(0.58)))
    .mul(planet?.waterStyle?.foam || 1);
  const foam = shoreFoam.mul(0.84).add(wakeFoam).clamp(0, 0.96);
  // Swell is suppressed where it would intersect the beach, and faded out with
  // distance: the water grid's finest cell is ~146 m, so beyond a few km the
  // 393 m swell is sampled below Nyquist and its per-vertex normal degenerates
  // into noise across the whole ocean. 2.2 m subtends well under a pixel at
  // that range anyway, so fading it costs nothing and removes the aliasing.
  const swell = smoothstep(0.5, 12, vertexBathymetry)
    .mul(float(1).sub(smoothstep(3000, 25000, viewDist)));
  // A NodeMaterial custom normal is already in view space.  Feeding it a
  // tangent-space `(x,y,1)` locked the highlight to the camera and made the
  // entire ocean look like a flat blue card.  Build the radial object-space
  // normal, bend it along the local surface basis, then transform it once.
  const normalObject = up
    .sub(tangent.mul(waveTangent.mul(swell).add(windTangent).add(rippleGradient.x.mul(0.55))))
    .sub(bitangent.mul(waveBitangent.mul(swell).add(windBitangent).add(rippleGradient.y.mul(0.55))))
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
  const baseWater = bodyWater.mul(float(0.93).add(wave.mul(0.1)));
  material.colorNode = mix(baseWater, vec3(0.92, 0.97, 1), foam);
  // Reflected radiance is not diffuse albedo: putting it in colorNode caused
  // the lighting pass to darken sunsets a second time. Keep the water body in
  // the physical BRDF and feed live sky/cloud/sun radiance through emissive.
  material.emissiveNode = reflectedSky.min(vec3(1.4)).mul(skyResponse.mul(0.28))
    .add(vec3(0.88, 0.95, 1).mul(foam.mul(1.05)));
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
  material.roughnessNode = mix(mix(0.16, 0.34, wave), 0.46, foam)
    .add(orbital.mul(0.12)).clamp(0.14, 0.68);

  const macroWave = sin(phase1).mul(A1).add(sin(phase2).mul(A2)).add(sin(phase3).mul(A3));
  // A sub-metre shore overlap makes the transparent water cover the opaque
  // terrain silhouette's antialias samples. It is depth-tested, so dry land
  // still wins immediately inland; visually this becomes the wet swash/foam
  // edge instead of a one-pixel clear-black crack.
  // A centimetre-scale bias avoids coplanar flicker at the exact zero contour
  // without lifting water metres through low beaches and inland terrain.
  const shoreOverlap = float(0.12);
  material.positionNode = positionLocal.add(up.mul(macroWave.mul(swell).add(shoreOverlap)));
  material.userData.shader = { uniforms: nodes };
  material.userData.waterCloudTexture = waterCloudTexture;
  material.userData.waterProfile = {
    depthScale,
    extinction: [1.8, 1.2, 0.6],
    depthHaze: { distance: depthScale * 0.4, strength: 0.9 },
    swellMetres: [A1, A2, A3],
    transmission: true,
    dynamicSky: true,
    cloudReflection: true,
    radianceReflection: true,
    wetShore: true,
    deterministicBathymetry: true,
  };
  material.userData.nodeMaterial = 'water-spectral-refraction-v5';
  material.userData.opacityNodeUniform = opacity;
  source.dispose?.();
  return material;
}

export function applyCloudField(source, coverage, offX, offY, offZ, relief = 0, weatherMap = null) {
  const material = copyMaterialFlags(source, new MeshBasicNodeMaterial());
  const detailMap = detailTexture();
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
    float(0.5).add(atan(d.z, d.x.negate()).mul(0.15915494)),
    float(1).sub(acos(d.y.clamp(-1, 1)).mul(0.31830988)),
  );
  const cloudAmount = (d) => {
    const direction = d.normalize();
    const scale = mix(1, 5.4, nodes.uSurfaceView);
    const fine = texture(detailMap, direction.xy.mul(scale.mul(0.55)).add(nodes.uCOff.xy)).g.mul(0.5)
      .add(texture(detailMap, direction.yz.mul(scale.mul(1.15)).add(nodes.uCOff.yz)).r.mul(0.25))
      .add(texture(detailMap, direction.zx.mul(scale.mul(2.35)).add(nodes.uCOff.zx)).g.mul(0.125))
      .add(texture(detailMap, direction.xy.mul(scale.mul(4.8)).sub(nodes.uCOff.xz)).r.mul(0.0625))
      .div(0.9375);
    const base = smoothstep(nodes.uCov0.sub(nodes.uSurfaceView.mul(0.02)),
      nodes.uCov1.sub(nodes.uSurfaceView.mul(0.10)), fine);
    const system = smoothstep(0.24, 0.76,
      weatherTextureNode.sample(weatherUV(direction)).r)
      .mul(smoothstep(0.32, 0.72, fine)).mul(0.78);
    return base.max(system);
  };
  const amount = cloudAmount(direction);
  const sunAmount = cloudAmount(direction.add(nodes.uCSun.normalize().mul(0.05)).normalize());
  const selfShadow = float(1).sub(sunAmount.sub(amount).mul(2.4)).clamp(0.36, 1.16);
  const day = smoothstep(-0.18, 0.24, dot(direction, nodes.uCSun.normalize()));
  const edge = smoothstep(0.03, 0.28, amount).mul(float(1).sub(smoothstep(0.62, 0.96, amount)));
  const baseColor = source.color?.clone() || new THREE.Color(0xffffff);
  material.colorNode = uniform(baseColor)
    .mul(mix(0.42, 1.03, day)).mul(selfShadow).mul(float(1).sub(amount.mul(0.22)))
    .add(vec3(0.18, 0.24, 0.34).mul(edge).mul(day));
  material.opacityNode = pow(amount, mix(0.95, 0.72, nodes.uSurfaceView))
    .mul(nodes.uCamProx).mul(nodes.uOpacity);
  material.positionNode = positionLocal.add(direction.mul(nodes.uCloudRelief).mul(pow(amount, 1.15)));
  material.uniforms = nodes;
  material.userData.weatherSystemTexture = stableWeatherMap;
  material.userData.weatherSystemTextureNode = weatherTextureNode;
  material.userData.shader = { uniforms: nodes };
  material.userData.nodeMaterial = 'cloud-deck-v2-faithful';
  material.userData.opacityNodeUniform = nodes.uOpacity;
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
