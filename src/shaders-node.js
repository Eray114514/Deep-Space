// Procedural material nodes shared by terrain, water, cloud decks and flora.
// These materials compile through WebGPURenderer on both WebGPU and WebGL2.

import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, acos, atan, attribute, color, cos, dot, exp, float, fract, instanceIndex, length, mix,
  mx_fractal_noise_float, normalLocal, normalView, normalViewGeometry, positionLocal,
  positionView, positionViewDirection, pow, select, sign, sin, smoothstep, texture, time,
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
  let surface = U.hasSea ? select(h.lessThan(U.t0), seaSurface, landSurface) : landSurface;

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

  let snowWeight = float(0);
  if (planet.pal?.snow) {
    const latitude = abs(direction.y).add(texture(detailMap, direction.xz.mul(2).add(direction.y)).r.sub(0.5).mul(0.12));
    const snowLine = float(planet.pal.snowLine).mul(float(1).sub(smoothstep(0.45, 0.95, latitude).mul(0.65)));
    snowWeight = smoothstep(snowLine, snowLine.add(planet.hAmp * 0.1), h)
      .max(smoothstep(planet.pal.capLat, planet.pal.capLat + 0.07, latitude))
      .mul(float(1).sub(smoothstep(0.55, 0.8, slope).mul(0.85)));
    surface = mix(surface, uniform(planet.pal.snow), snowWeight);
  }

  const cloudMap = planet.cloudShadowTex || blankTexture();
  const cloudMatrix = uniform(new THREE.Matrix3());
  const cloudDirection = cloudMatrix.mul(direction);
  const cloudU = float(0.5).add(atan(cloudDirection.z, cloudDirection.x.negate()).mul(0.15915494));
  const cloudV = float(1).sub(acos(cloudDirection.y.clamp(-1, 1)).mul(0.31830988));
  const cloudK = uniform(planet.cloudMesh ? 0.42 : 0);
  surface = surface.mul(float(1).sub(texture(cloudMap, vec2(cloudU, cloudV)).a.mul(cloudK)));
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
    const uMistColor = uniform((planet.skyColor || new THREE.Color(0x7894b8))
      .clone().convertSRGBToLinear());
    const mistHeight = h.sub(U.t0 || 0);
    const mistFactor = smoothstep(uMistH, float(0), mistHeight)
      .mul(float(1).sub(positionView.z.negate().mul(3.2e-4).exp()));
    const mist = uMistK.mul(mistFactor).clamp(0, 0.6);
    material.colorNode = mix(material.colorNode, uMistColor, mist);
  }

  // NodeMaterial normalNode consumes a tangent-space perturbation. Supplying
  // a planet-local radial vector here made the WebGPU path reinterpret object
  // coordinates as tangent coordinates, blacking out most of the lit
  // hemisphere. Keep the geometric normal authoritative until the detail
  // gradient has been converted through a proper TBN node below the 15 m
  // micro-detail range.
  {
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
    material.normalNode = vec3(gx.mul(detailStrength).add(scanNormal.x),
      gy.mul(detailStrength).add(scanNormal.y), 1).normalize();
  }

  material.userData.shader = { uniforms: { uCloudMat: cloudMatrix, uCloudK: cloudK } };
  material.userData.nodeMaterial = 'terrain-layered-pbr-v6-ktx2';
  source.dispose?.();
  return material;
}

export function applyWaterWaves(source, planet, waveScale = 1 / 14) {
  const material = copyMaterialFlags(source, new MeshPhysicalNodeMaterial({
    roughness: source.roughness, metalness: source.metalness,
  }));
  // The ocean is a closed spherical LOD surface. It must write its nearest
  // depth even while blending, or far-side chunks and the sky repeatedly
  // accumulate through the near surface as bright cloud-shaped patches.
  material.depthWrite = true;
  const local = attribute('aLocal', 'vec3'), depth = attribute('aDepth', 'float').max(0);
  const deep = planet?.pal?.sea?.[0]?.c?.clone()
    .lerp(planet.liquidColor.clone().convertSRGBToLinear(), 0.35) || new THREE.Color(0x061b35);
  const shallow = planet?.liquidColor?.clone().convertSRGBToLinear()
    .lerp(new THREE.Color(1, 1, 1), 0.12) || new THREE.Color(0.32, 0.68, 0.76);
  const absorption = float(1).sub(pow(2.71828, depth.mul(-0.05)));
  const wave = mx_fractal_noise_float(local.mul(waveScale).add(vec3(time.mul(0.021), 0, time.mul(-0.013))), 4);
  const fresnel = pow(float(1).sub(abs(dot(normalView.normalize(), positionViewDirection))), 5);
  const sky = planet?.skyColor?.clone().convertSRGBToLinear().multiplyScalar(1.15)
    || new THREE.Color(0.25, 0.4, 0.55);
  const up = local.normalize();
  const tangent = up.cross(vec3(0, 1, 0)).add(vec3(1e-4, 0, 1e-4)).normalize();
  const bitangent = up.cross(tangent);
  const phase1 = local.x.add(local.z).mul(0.016).add(time.mul(0.82));
  const phase2 = local.z.sub(local.y.mul(0.7)).mul(0.027).sub(time.mul(1.07));
  const phase3 = local.x.mul(0.55).add(local.y).mul(0.043).add(time.mul(1.34));
  const waveGradient = vec3(cos(phase1).mul(0.00416).add(cos(phase3).mul(0.00166)),
    cos(phase2).mul(-0.00265).add(cos(phase3).mul(0.00301)),
    cos(phase1).mul(0.00416).add(cos(phase2).mul(0.00378)));
  const waveTangent = dot(waveGradient, tangent).mul(5.2);
  const waveBitangent = dot(waveGradient, bitangent).mul(5.2);
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
  const shoreFoam = float(1).sub(smoothstep(0.25, 3.2, depth))
    .mul(float(0.55).add(sin(depth.mul(7).add(time.mul(1.8))).mul(0.45)));
  const foam = shoreFoam.mul(0.42).add(wakeFoam).clamp(0, 0.92);
  const skyResponse = float(0.28).add(fresnel.mul(0.62)).clamp(0, 0.88);
  const baseWater = mix(mix(uniform(shallow), uniform(deep), absorption), uniform(sky), skyResponse)
    .mul(float(0.91).add(wave.mul(0.12)));
  const waterDebugStrength = uniform(waterInteraction.data[0]).z.clamp(0, 1);
  material.colorNode = mix(mix(baseWater, vec3(0.92, 0.97, 1), foam),
    vec3(1, 0, 0), waterDebugStrength);
  const opacity = uniform(source.opacity ?? 1);
  // Only the first metres remain translucent. Deep ocean must become opaque;
  // otherwise the high-frequency sea-floor terrain reads like white cloud
  // noise painted on the water surface.
  const depthOpacity = float(1).sub(exp(depth.mul(-0.09)));
  const waterAlpha = mix(opacity.mul(0.42), opacity.max(0.92), depthOpacity);
  material.opacityNode = mix(waterAlpha, waterAlpha.mul(2.2).add(0.25).min(1), fresnel);
  material.roughnessNode = mix(mix(0.08, 0.2, wave), 0.34, foam);
  // A NodeMaterial custom normal is already in view space.  Feeding it a
  // tangent-space `(x,y,1)` locked the highlight to the camera and made the
  // entire ocean look like a flat blue card.  Build the radial object-space
  // normal, bend it along the local surface basis, then transform it once.
  const normalObject = up
    .sub(tangent.mul(waveTangent.mul(0.82).add(rippleGradient.x.mul(0.55))))
    .sub(bitangent.mul(waveBitangent.mul(0.82).add(rippleGradient.y.mul(0.55))))
    .normalize();
  material.normalNode = transformNormalToView(normalObject);
  const macroWave = sin(phase1).mul(0.26).add(sin(phase2).mul(0.14)).add(sin(phase3).mul(0.07));
  material.positionNode = positionLocal.add(up.mul(macroWave));
  material.userData.nodeMaterial = 'water-tangent-wakes-v2';
  material.userData.opacityNodeUniform = opacity;
  source.dispose?.();
  return material;
}

export function applyCloudField(source, coverage, offX, offY, offZ, relief = 0, weatherMap = null) {
  const material = copyMaterialFlags(source, new MeshBasicNodeMaterial());
  const detailMap = detailTexture();
  // The analytic WebGL deck combines a planet-locked FBM with this octahedral
  // storm atlas. Reusing the unrelated baked shadow texture here made the
  // WebGPU cloud footprint a set of opaque white islands with black oceans.
  const stableWeatherMap = cloudSystemTexture(offX, offY, offZ);
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
    const octDirection = direction.div(abs(direction.x).add(abs(direction.y)).add(abs(direction.z)));
    const octBase = octDirection.xz;
    const oct = select(octDirection.y.lessThan(0),
      vec2(1).sub(abs(octBase.yx)).mul(sign(octBase.xy)), octBase);
    const system = texture(stableWeatherMap, oct.mul(0.5).add(0.5)).r
      .mul(smoothstep(0.24, 0.68, fine)).mul(0.86);
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
  }));
  const grow = uniform(GROW.value).onFrameUpdate(() => GROW.value);
  const clock = uniform(TIME.value).onFrameUpdate(() => TIME.value);
  const phase = fract(float(instanceIndex).mul(0.6180339)).mul(6.28318);
  const height = positionLocal.y.max(0);
  const sway = sin(clock.mul(1.6).add(phase)).add(sin(clock.mul(3.7).add(phase.mul(1.7))).mul(0.4))
    .mul(amount).mul(height);
  const anchor = attribute('iAnchor', 'vec3');
  let pressure = float(0);
  for (let i = 0; i < surfaceInteraction.positions.length; i++) {
    const centre = uniform(surfaceInteraction.positions[i]);
    const data = uniform(surfaceInteraction.data[i]);
    const falloff = float(1).sub(smoothstep(0, centre.w, length(anchor.sub(centre.xyz))))
      .mul(data.y).mul(exp(data.x.negate()));
    pressure = pressure.max(falloff);
  }
  const tip = smoothstep(0, 0.65, height);
  const push = pressure.mul(tip);
  material.positionNode = positionLocal.mul(grow)
    .add(vec3(sway.add(sin(phase).mul(push).mul(0.7)),
      height.mul(push).mul(-0.68), sway.mul(0.7).add(cos(phase).mul(push).mul(0.7))));
  material.colorNode = source.vertexColors ? vertexColor() : uniform(source.color?.clone() || new THREE.Color(1, 1, 1));
  if (foliageLighting) material.normalNode = normalViewGeometry;
  if (source.emissive) material.emissiveNode = uniform(source.emissive.clone())
    .mul(source.vertexColors ? vertexColor() : 1);
  material.userData.nodeMaterial = 'wind-sway-v2-interaction';
  source.dispose?.();
  return material;
}
