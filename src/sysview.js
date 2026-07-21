// System preview scene (星系预览): a data-driven twin of the hand-tuned
// reference UI. Every mesh, texture and orbit is generated from the real
// deterministic system spec — the preview is the same sky the player flies
// through, only framed like a survey chart.

import * as THREE from '../vendor/three.webgpu.js';
import {
  Fn, cameraPosition, color, cos, exp, float, floor, fract, length, luminance,
  max, mix, mx_atan2, mx_fractal_noise_float, normalWorld, pass, positionLocal,
  positionWorld, pow, screenUV, sin, smoothstep, texture, uniform, uv, vec2,
  vec3, vec4,
} from '../vendor/three.tsl.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { makeRng, strHash32 } from './rng.js';
import { orbitalPosition } from './astronomy.js';

const ORBIT_PLANE_Y = 0.18;
const STAR_CENTER_Y = 1.12;

// ---------------------------------------------------------------------------
// deterministic JS-side value noise (texture generation)
// ---------------------------------------------------------------------------
function noise2(x, y, seed = 1) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123;
  return s - Math.floor(s);
}
function smoothNoise(x, y, seed = 1) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = noise2(ix, iy, seed), b = noise2(ix + 1, iy, seed);
  const c = noise2(ix, iy + 1, seed), d = noise2(ix + 1, iy + 1, seed);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, u), THREE.MathUtils.lerp(c, d, u), v);
}
function fbm2(x, y, seed = 1) {
  let n = 0, a = 0.55, f = 1;
  for (let i = 0; i < 5; i++) { n += smoothNoise(x * f, y * f, seed + i * 13) * a; f *= 2.03; a *= 0.5; }
  return n;
}
function ridged2(x, y, seed = 1) {
  const n = fbm2(x, y, seed);
  return 1 - Math.abs(2 * n - 1);
}

function makeRadialTexture(size = 512, inner = '#fff', mid = 'rgba(255,170,60,.55)', outer = 'rgba(255,120,20,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.18, mid);
  g.addColorStop(1, outer);
  x.fillStyle = g;
  x.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// procedural body textures — one painter per world type, all seeded
// ---------------------------------------------------------------------------
const textureCache = new Map();
const TEXTURE_CACHE_LIMIT = 72;

function cachedTexture(key, builder) {
  if (textureCache.has(key)) return textureCache.get(key);
  const texture = builder();
  if (textureCache.size >= TEXTURE_CACHE_LIMIT) {
    const oldest = textureCache.keys().next().value;
    textureCache.get(oldest)?.dispose?.();
    textureCache.delete(oldest);
  }
  textureCache.set(key, texture);
  return texture;
}

function paintBodyTexture(body, w, h) {
  const rand = makeRng(body.seed + ':tex');
  const seedNum = 1 + (strHash32(body.seed) % 977);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const emissiveC = document.createElement('canvas');
  emissiveC.width = w;
  emissiveC.height = h;
  const ectx = emissiveC.getContext('2d');
  const eimg = ctx.createImageData(w, h);
  const ed = eimg.data;
  let hasEmissive = false;

  const type = body.type;
  // gas giants pick a band palette per seed so systems don't repeat themselves
  const gasPalettes = [
    [[152, 102, 76], [218, 168, 121], [232, 205, 168]],
    [[170, 148, 112], [226, 208, 172], [240, 228, 198]],
    [[86, 128, 142], [158, 196, 205], [214, 230, 228]],
    [[126, 96, 88], [196, 152, 128], [224, 188, 158]],
  ];
  const gasPalette = gasPalettes[Math.floor(rand() * gasPalettes.length)];
  const stormU = 0.55 + rand() * 0.3, stormV = 0.55 + rand() * 0.18;
  const hasStorm = rand() < 0.72;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w, v = y / h, lat = Math.abs(v - 0.5) * 2;
      const n = fbm2(u * 8, v * 8, seedNum);
      const n2 = fbm2(u * 22, v * 12, seedNum + 33);
      const n3 = fbm2(u * 40, v * 24, seedNum + 91);
      const ridge = ridged2(u * 13, v * 9, seedNum + 57);
      let r, g, b, er = 0, eg = 0, eb = 0;

      if (type === 'gasGiant' || type === 'iceGiant') {
        const soft = type === 'iceGiant' ? 0.45 : 1;
        const bands = 0.5 + 0.5 * Math.sin(v * (type === 'iceGiant' ? 46 : 82) + fbm2(u * 3, v * 8, seedNum + 7) * 7);
        const [dark, mid, light] = gasPalette;
        const mixK = THREE.MathUtils.smoothstep(bands, 0.15, 0.85);
        r = THREE.MathUtils.lerp(dark[0], mid[0], mixK);
        g = THREE.MathUtils.lerp(dark[1], mid[1], mixK);
        b = THREE.MathUtils.lerp(dark[2], mid[2], mixK);
        const lightK = Math.pow(Math.max(0, bands - 0.62) / 0.38, 1.6) * soft;
        r = THREE.MathUtils.lerp(r, light[0], lightK);
        g = THREE.MathUtils.lerp(g, light[1], lightK);
        b = THREE.MathUtils.lerp(b, light[2], lightK);
        if (hasStorm) {
          const storm = Math.exp(-(((u - stormU) ** 2) / 0.007 + ((v - stormV) ** 2) / 0.014));
          r += (type === 'iceGiant' ? 40 : 55) * storm;
          g += (type === 'iceGiant' ? 44 : 22) * storm;
          b += (type === 'iceGiant' ? 46 : 12) * storm;
        }
        r += (n3 - 0.5) * 26 * soft; g += (n3 - 0.5) * 24 * soft; b += (n3 - 0.5) * 22 * soft;
      } else if (type === 'lush' || type === 'ocean') {
        const threshold = type === 'ocean' ? 0.62 : 0.56;
        const land = n + 0.16 * n2 - threshold;
        const ice = THREE.MathUtils.smoothstep(lat, 0.74, 0.95);
        if (land > 0) {
          const dry = THREE.MathUtils.clamp(0.5 + 0.5 * Math.sin(lat * 5.1 + n2 * 3.0), 0, 1);
          r = 52 + 52 * n + 44 * dry;
          g = 83 + 88 * n - 8 * dry;
          b = 50 + 43 * n - 18 * dry;
          if (land < 0.045) { r += 42; g += 34; b += 8; }       // sunlit shallows ring
        } else {
          const depth = THREE.MathUtils.clamp(-land * 4, 0, 1);
          r = 18 + 20 * n - 6 * depth;
          g = 44 + 48 * n - 12 * depth;
          b = 76 + 88 * n - 16 * depth;
        }
        r = THREE.MathUtils.lerp(r, 214, ice);
        g = THREE.MathUtils.lerp(g, 223, ice);
        b = THREE.MathUtils.lerp(b, 220, ice);
      } else if (type === 'desert') {
        r = 168 + 48 * n; g = 128 + 42 * n; b = 88 + 30 * n;
        if (n2 < 0.44) { r *= 0.66; g *= 0.64; b *= 0.66; }      // maria
        const canyon = Math.pow(Math.max(0, 0.05 - Math.abs(ridge - 0.62)), 0.5) * 90;
        r -= canyon * 0.7; g -= canyon * 0.62; b -= canyon * 0.5;
        const polar = THREE.MathUtils.smoothstep(lat, 0.82, 0.98);
        r = THREE.MathUtils.lerp(r, 226, polar);
        g = THREE.MathUtils.lerp(g, 214, polar);
        b = THREE.MathUtils.lerp(b, 196, polar);
      } else if (type === 'ice') {
        r = 136 + 84 * n; g = 146 + 86 * n; b = 150 + 84 * n;
        const crack = Math.pow(Math.max(0, 0.08 - Math.abs(n2 - 0.48)), 0.55) * 118;
        r -= crack * 0.72; g -= crack * 0.4; b -= crack * 0.12;  // blue-shadowed cracks
        if (n3 > 0.62) { r -= 22; g -= 6; b += 10; }             // frozen mineral bloom
      } else if (type === 'lava') {
        r = 26 + 22 * n; g = 20 + 16 * n; b = 22 + 15 * n;
        const crack = Math.pow(Math.max(0, 0.085 - Math.abs(ridge - 0.5)) / 0.085, 1.7);
        const glow = THREE.MathUtils.clamp(crack * (0.55 + 0.45 * n2), 0, 1);
        r += glow * 70; g += glow * 14; b += glow * 4;
        er = 255 * glow; eg = 96 * glow; eb = 22 * glow;
        hasEmissive = true;
      } else if (type === 'toxic') {
        r = 106 + 42 * n; g = 118 + 46 * n; b = 52 + 26 * n;
        if (n2 > 0.6) { r *= 0.62; g *= 0.74; b *= 0.7; }
        const vein = Math.pow(Math.max(0, ridge - 0.88) / 0.12, 2);
        r += vein * 70; g += vein * 80; b += vein * 18;
      } else if (type === 'exotic') {
        const swirl = fbm2(u * 3 + n * 1.6, v * 6 - n2 * 1.2, seedNum + 11);
        r = 66 + 60 * swirl; g = 38 + 34 * swirl; b = 92 + 78 * swirl;
        const vein = Math.pow(Math.max(0, ridge - 0.86) / 0.14, 1.6);
        r += vein * 130; g += vein * 40; b += vein * 150;
        er = 120 * vein; eg = 30 * vein; eb = 150 * vein;
        hasEmissive = true;
      } else { // barren & fallback rock
        r = 76 + 96 * n; g = 68 + 82 * n; b = 63 + 68 * n;
        const crater = Math.pow(Math.max(0, 0.12 - Math.abs(n3 - 0.38)), 0.72) * 86;
        r -= crater; g -= crater; b -= crater;
      }

      const i = (y * w + x) * 4;
      d[i] = Math.max(0, Math.min(255, r));
      d[i + 1] = Math.max(0, Math.min(255, g));
      d[i + 2] = Math.max(0, Math.min(255, b));
      d[i + 3] = 255;
      ed[i] = er; ed[i + 1] = eg; ed[i + 2] = eb; ed[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const map = new THREE.CanvasTexture(c);
  map.colorSpace = THREE.SRGBColorSpace;
  map.wrapS = THREE.RepeatWrapping;
  let emissiveMap = null;
  if (hasEmissive) {
    ectx.putImageData(eimg, 0, 0);
    emissiveMap = new THREE.CanvasTexture(emissiveC);
    emissiveMap.colorSpace = THREE.SRGBColorSpace;
    emissiveMap.wrapS = THREE.RepeatWrapping;
  }
  return { map, emissiveMap };
}

function bodyTextures(body, anisotropy) {
  const small = body.isMoon;
  // Preview worlds never occupy enough screen pixels to justify the old
  // 448px maps. Keeping the same seeded painter at a display-matched size
  // roughly halves the synchronous work performed when a system opens.
  const w = small ? 224 : 352, h = small ? 112 : 176;
  const key = `${body.seed}:${body.type}:${w}`;
  const tex = cachedTexture(key, () => paintBodyTexture(body, w, h));
  tex.map.anisotropy = anisotropy;
  return tex;
}

function makeCloudTexture(body) {
  const seedNum = 71 + (strHash32(body.seed) % 331);
  const key = `${body.seed}:cloud`;
  return cachedTexture(key, () => {
    const w = 352, h = 176;
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h), d = img.data;
    const threshold = { lush: 0.55, ocean: 0.5, toxic: 0.46, desert: 0.62, ice: 0.58 }[body.type] ?? 0.56;
    const tint = body.type === 'toxic' ? [204, 214, 148] : body.type === 'desert' ? [224, 204, 164] : [232, 239, 241];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const n = fbm2(x / w * 13, y / h * 9, seedNum);
        const a = Math.max(0, Math.min(1, (n - threshold) * 3.1));
        const i = (y * w + x) * 4;
        d[i] = tint[0]; d[i + 1] = tint[1]; d[i + 2] = tint[2]; d[i + 3] = a * 172;
      }
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  });
}

const CLOUD_TYPES = new Set(['lush', 'ocean', 'toxic', 'desert', 'ice']);
const ATMO_STYLES = {
  lush: [0x63b8e8, 0.56], ocean: [0x4ea7ff, 0.52], desert: [0xd8b98a, 0.3],
  ice: [0xb7d4d2, 0.42], lava: [0xff6a3a, 0.34], toxic: [0xb5e45d, 0.42],
  exotic: [0xe47cff, 0.44], iceGiant: [0x68c7df, 0.34],
};

function atmosphereMaterial(color, opacity = 0.45) {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.BackSide, blending: THREE.AdditiveBlending,
  });
  const viewDirection = cameraPosition.sub(positionWorld).normalize();
  const fresnel = pow(viewDirection.dot(normalWorld).clamp(0, 1).oneMinus(), 2.8);
  material.colorNode = colorNode(color);
  material.opacityNode = fresnel.mul(opacity);
  return material;
}

function colorNode(value) {
  return color(new THREE.Color(value));
}

function makePreviewAccretionMaterial(innerRadius, outerRadius, temperatureK = 4300) {
  const uniforms = { uTime: uniform(0), uIntensity: uniform(1) };
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
  material.uniforms = uniforms;
  const radius = length(positionLocal.xy);
  const angle = mx_atan2(positionLocal.y, positionLocal.x);
  const edge = smoothstep(innerRadius, innerRadius * 1.12, radius)
    .mul(smoothstep(outerRadius, outerRadius * 0.92, radius));
  const lanes = sin(radius.mul(7.6).sub(angle.mul(5)).add(uniforms.uTime.mul(0.9))).mul(0.55).add(0.45);
  const cells = fract(sin(floor(angle.mul(32)).mul(127.1).add(floor(radius.mul(4).add(uniforms.uTime.mul(0.2))).mul(311.7))).mul(43758.5453));
  const density = edge.mul(lanes.mul(0.32).add(cells.mul(0.18)).add(0.20));
  const heat = float(outerRadius).sub(radius).div(Math.max(0.001, outerRadius - innerRadius)).clamp(0, 1);
  const temperatureShift = THREE.MathUtils.clamp((temperatureK - 3000) / 5000, 0, 1);
  const discColor = mix(vec3(1.7, 0.18, 0.025), vec3(1.5, 0.78, 0.26), heat.mul(0.8).add(temperatureShift * 0.2));
  material.colorNode = discColor.mul(density).mul(cos(angle.sub(0.6)).mul(0.48).add(0.72)).mul(uniforms.uIntensity);
  material.opacityNode = density.mul(0.78);
  return material;
}

function makePreviewPhotonMaterial() {
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  });
  const viewDirection = cameraPosition.sub(positionWorld).normalize();
  const rim = pow(viewDirection.dot(normalWorld).abs().oneMinus(), 5.2);
  material.colorNode = mix(vec3(1.1, 0.28, 0.025), vec3(2.4, 1.45, 0.72), rim);
  material.opacityNode = rim.mul(0.28);
  return material;
}

function ringMaterial(seedStr, tint) {
  const rand = makeRng(seedStr + ':ring');
  const freq = 26 + rand() * 22, gapAt = 0.5 + rand() * 0.24, warp = 2 + rand() * 3;
  const c = new THREE.Color(tint).multiplyScalar(0.72);
  const material = new THREE.MeshBasicNodeMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  const p = uv().mul(2).sub(1);
  const radius = length(p);
  const bands = sin(radius.mul(freq).add(sin(radius.mul(7)).mul(warp))).mul(0.55).add(0.45);
  const edge = smoothstep(0.28, 0.38, radius).mul(smoothstep(0.9, 1, radius).oneMinus());
  const gap = smoothstep(0, 0.07, radius.sub(gapAt).abs()).oneMinus();
  material.colorNode = colorNode(c);
  material.opacityNode = edge.mul(bands.mul(0.23).add(0.17)).mul(gap);
  return material;
}

// ---------------------------------------------------------------------------
// star surface shader (animated granulation, parameterized by spectral color)
// ---------------------------------------------------------------------------
function starSurfaceMaterial(color) {
  const base = color.clone();
  const warm = THREE.MathUtils.clamp(base.r - base.b, 0, 1);
  const deep = base.clone().multiplyScalar(0.5)
    .lerp(new THREE.Color().setRGB(1.0, 0.35, 0.09), warm * 0.5)
    .lerp(new THREE.Color().setRGB(0.16, 0.3, 1.0), (1 - warm) * 0.4);
  const uniforms = { uTime: uniform(0) };
  const material = new THREE.MeshBasicNodeMaterial({
    toneMapped: false,
  });
  material.uniforms = uniforms;
  const localNormal = positionLocal.normalize();
  const displacementNoise = mx_fractal_noise_float(localNormal.mul(4.3)
    .add(vec3(uniforms.uTime.mul(0.16), uniforms.uTime.mul(0.09), uniforms.uTime.mul(-0.12))), 5);
  material.positionNode = positionLocal.add(localNormal.mul(displacementNoise.sub(0.46)).mul(0.28));
  const surfaceNoise = mx_fractal_noise_float(localNormal.mul(5.1)
    .add(vec3(uniforms.uTime.mul(0.20), uniforms.uTime.mul(-0.12), uniforms.uTime.mul(0.14))), 5);
  const hot = smoothstep(0.42, 0.88, surfaceNoise);
  const rim = pow(normalWorld.normalize().dot(cameraPosition.sub(positionWorld).normalize()).clamp(0, 1).oneMinus(), 2.1);
  material.colorNode = mix(colorNode(deep), colorNode(base.clone().multiplyScalar(1.05)), smoothstep(0.16, 0.74, surfaceNoise))
    .mix(colorNode(base.clone().lerp(new THREE.Color(1, 1, 1), 0.82).multiplyScalar(1.35)), pow(hot, 2.6))
    .add(colorNode(deep).mul(rim).mul(0.34));
  return { material, uniforms };
}

// ---------------------------------------------------------------------------
// gravity-well contour backdrop: the survey-chart signature of the reference
// ---------------------------------------------------------------------------
function buildContourField(masses, fieldRadius, compactObject = false) {
  function potentialField(x, z) {
    let f = 0;
    for (const m of masses) {
      const dx = x - m.x, dz = z - m.z;
      const ell = ((dx * dx) * m.anisX + (dz * dz) * m.anisZ) / (m.s * m.s);
      f += m.a * Math.exp(-ell);
    }
    f += 0.14 * Math.exp(-((x + 2.2) * (x + 2.2) + (z - 1.2) * (z - 1.2)) / 220.0);
    return f;
  }
  function contourElevation(x, z) {
    const f = potentialField(x, z);
    const shear = 0.15 * Math.sin(z * 0.18 + x * 0.05) + 0.08 * Math.sin(x * 0.09 - z * 0.13);
    return -1.78 - f * 0.62 + shear;
  }
  const group = new THREE.Group();
  const ringCount = compactObject
    ? Math.round(THREE.MathUtils.clamp(fieldRadius * 0.68, 30, 42))
    : Math.round(THREE.MathUtils.clamp(fieldRadius * 0.88, 36, 54));
  for (let i = 0; i < ringCount; i++) {
    const base = THREE.MathUtils.lerp(4.08, fieldRadius, i / Math.max(1, ringCount - 1));
    const phase = i * 0.27;
    const pts = [];
    const samples = 300;
    for (let j = 0; j < samples; j++) {
      const a = j / samples * Math.PI * 2;
      const ripple = 1.0 + 0.030 * Math.sin(a * 3.0 + phase) + 0.015 * Math.sin(a * 7.0 - phase * 0.6);
      const rx = base * (1.035 + 0.024 * Math.sin(i * 0.23));
      const rz = base * (0.86 + 0.028 * Math.cos(i * 0.17));
      let x = Math.cos(a) * rx * ripple;
      let z = Math.sin(a) * rz * ripple;
      for (const m of masses.slice(1)) {
        const ma = Math.atan2(m.z, m.x);
        let dAng = a - ma;
        dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
        const mr = Math.hypot(m.x, m.z);
        const radial = Math.exp(-Math.pow((base - mr) / 2.6, 2));
        const angular = Math.exp(-Math.pow(dAng / 0.42, 2));
        const pull = radial * angular * (0.42 + m.a * 0.28);
        x += Math.cos(ma) * pull;
        z += Math.sin(ma) * pull;
      }
      const y = contourElevation(x, z) + 0.10;
      pts.push(new THREE.Vector3(x, y, z));
    }
    pts.push(pts[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: compactObject ? 0xc78352 : 0xcbd4d2,
      transparent: true,
      opacity: compactObject
        ? 0.045 + (i / ringCount) * 0.065
        : 0.075 + (i / ringCount) * 0.085,
      depthWrite: false,
      depthTest: true,
    });
    const line = new THREE.Line(geo, mat);
    line.renderOrder = -1;
    group.add(line);
  }
  return group;
}

function createSelectionReticle(scene) {
  const group = new THREE.Group();
  const material = new THREE.LineBasicMaterial({
    color: 0x8abec7, transparent: true, opacity: 0.58, depthWrite: false, depthTest: false,
  });
  const arcLength = 0.48;
  for (let i = 0; i < 4; i++) {
    const center = i * Math.PI * 0.5 + Math.PI * 0.25;
    const pts = [];
    for (let j = 0; j <= 18; j++) {
      const a = center - arcLength * 0.5 + arcLength * j / 18;
      pts.push(new THREE.Vector3(Math.cos(a), Math.sin(a), 0));
    }
    const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material.clone());
    arc.renderOrder = 50;
    group.add(arc);
  }
  group.visible = false;
  group.renderOrder = 50;
  scene.add(group);
  return group;
}

// ---------------------------------------------------------------------------
// SystemView
// ---------------------------------------------------------------------------
export class SystemView {
  constructor({ host, labelHost, navArrow, nameTag, onSelect }) {
    this.host = host;
    this.labelHost = labelHost;
    this.navArrow = navArrow;
    this.nameTag = nameTag;
    this.onSelect = onSelect || (() => {});

    const rendererMode = new URLSearchParams(location.search).get('renderer');
    this.renderer = new THREE.WebGPURenderer({
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
      forceWebGL: rendererMode === 'webgl',
    });
    this.rendererReady = false;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x111717, 0.0045);
    this.camera = new THREE.PerspectiveCamera(37, 1, 0.1, 260);
    this.cameraTarget = new THREE.Vector3(0, 1.1, 0);
    this.defaultView = { azimuth: 0, elevation: 0.557, distance: 40 };
    this.cameraAzimuth = this.defaultView.azimuth;
    this.cameraElevation = this.defaultView.elevation;
    this.cameraDistance = this.defaultView.distance;
    this.responsiveFraming = 1;

    const scenePass = pass(this.scene, this.camera);
    const sceneColor = scenePass.getTextureNode('output');
    const lensUniforms = {
      uCenter: uniform(new THREE.Vector2(0.5, 0.5)),
      uRadius: uniform(0.16),
      uAspect: uniform(1),
      uStrength: uniform(0.12),
      uEnabled: uniform(0),
    };
    const lensNode = Fn(() => {
      const delta = screenUV.sub(lensUniforms.uCenter);
      const metric = vec2(delta.x.mul(lensUniforms.uAspect), delta.y);
      const normalizedRadius = length(metric).div(max(lensUniforms.uRadius, 0.0001));
      const shell = smoothstep(0.16, 1, normalizedRadius).oneMinus();
      const coreGuard = smoothstep(0.08, 0.24, normalizedRadius);
      const deflection = lensUniforms.uStrength.mul(shell).mul(coreGuard)
        .div(normalizedRadius.add(0.32)).mul(lensUniforms.uEnabled);
      const warped = lensUniforms.uCenter.add(delta.mul(deflection.add(1)));
      const tangent = vec2(metric.y.negate().div(lensUniforms.uAspect), metric.x).add(vec2(0.00001)).normalize();
      const ca = deflection.mul(0.006);
      const base = sceneColor.sample(warped);
      return vec4(
        sceneColor.sample(warped.add(tangent.mul(ca))).r,
        base.g,
        sceneColor.sample(warped.sub(tangent.mul(ca))).b,
        1,
      );
    })();
    const lensPass = { uniforms: lensUniforms };
    Object.defineProperty(lensPass, 'enabled', {
      get: () => lensUniforms.uEnabled.value > 0.5,
      set: (value) => { lensUniforms.uEnabled.value = value ? 1 : 0; },
    });
    lensPass.enabled = false;
    this.lensPass = lensPass;
    this.bloom = bloom(sceneColor, 0.3, 0.26, 0.82);
    this.renderPipeline = new THREE.RenderPipeline(this.renderer);
    this.renderPipeline.outputNode = lensNode.add(this.bloom);
    this.readyPromise = this.renderer.init().then(() => {
      this.rendererReady = true;
      this.renderer.domElement.dataset.backend = this.renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
      this.resize();
    }).catch((error) => {
      this.renderer.domElement.dataset.backend = 'failed';
      console.error('SystemView renderer initialization failed', error);
    });

    this.scene.add(new THREE.HemisphereLight(0xa8b8bc, 0x0e1517, 0.62));
    this.fillLight = new THREE.DirectionalLight(0xe6edf2, 0.45);
    this.fillLight.position.set(-12, 8, 10);
    this.scene.add(this.fillLight);
    this.starLight = new THREE.PointLight(0xffe1b4, 860, 86, 1.6);
    this.starLight.position.set(0, STAR_CENTER_Y, 0);
    this.scene.add(this.starLight);

    this.world = new THREE.Group();
    this.scene.add(this.world);
    this.reticle = createSelectionReticle(this.scene);

    this.bodies = [];          // primary planet view-records
    this.moons = [];
    this.markers = [];
    this.pickMeshes = [];
    this.starUniformsList = [];
    this.selected = null;
    this.labelsVisible = true;
    this.preview = null;
    this.blackHoleRecord = null;
    this.timeHours = 0;
    this.retiredSystems = new Set();
    this.cleanupPromise = null;

    this._elapsed = 0;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._drag = null;
    this._bindInput();
    this.resize();
  }

  _bindInput() {
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => {
      this._drag = { x: e.clientX, y: e.clientY, moved: 0 };
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this._drag) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.moved += Math.hypot(dx, dy);
      this._drag.x = e.clientX;
      this._drag.y = e.clientY;
      this.cameraAzimuth -= dx * 0.0052;
      this.cameraElevation = THREE.MathUtils.clamp(this.cameraElevation + dy * 0.0038, 0.16, 1.22);
      this.updateCamera();
    });
    el.addEventListener('pointerup', (e) => {
      const drag = this._drag;
      this._drag = null;
      if (!drag || drag.moved > 5) return;
      this._pick(e);
    });
    el.addEventListener('pointercancel', () => { this._drag = null; });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.cameraDistance *= Math.exp(e.deltaY * 0.00072);
      this.cameraDistance = THREE.MathUtils.clamp(this.cameraDistance, this.defaultView.distance * 0.55, this.defaultView.distance * 1.65);
      this.updateCamera();
    }, { passive: false });
  }

  _pick(event) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (!rect.width) return;
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.pickMeshes, false);
    if (hits.length) {
      const record = hits[0].object.userData.record;
      if (record?.kind === 'planet') {
        this.onSelect(record.body);
        return;
      }
    }
    this.onSelect(null);
  }

  updateCamera() {
    const effectiveDistance = this.cameraDistance * this.responsiveFraming;
    const horizontal = Math.cos(this.cameraElevation) * effectiveDistance;
    this.camera.position.set(
      this.cameraTarget.x + Math.sin(this.cameraAzimuth) * horizontal,
      this.cameraTarget.y + Math.sin(this.cameraElevation) * effectiveDistance,
      this.cameraTarget.z + Math.cos(this.cameraAzimuth) * horizontal,
    );
    this.camera.lookAt(this.cameraTarget);
  }

  resetView() {
    this.cameraAzimuth = this.defaultView.azimuth;
    this.cameraElevation = this.defaultView.elevation;
    this.cameraDistance = this.defaultView.distance;
    this.updateCamera();
  }

  setLabelsVisible(visible) {
    this.labelsVisible = visible;
    for (const marker of this.markers) marker.el.style.display = visible ? 'block' : 'none';
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth || innerWidth);
    const h = Math.max(1, this.host.clientHeight || innerHeight);
    this.renderer.setSize(w, h);
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
    const aspect = w / h;
    this.responsiveFraming = 1 + Math.max(0, 1.55 - aspect) * 0.16;
    this.camera.fov = THREE.MathUtils.clamp(37 + Math.max(0, 1.55 - aspect) * 8, 37, 43);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.updateCamera();
  }

  // -- system construction ---------------------------------------------------
  _disposeSystemObjects(objects) {
    for (const root of objects) root.traverse((object) => {
      // Sprite geometry is a shared Three.js singleton, not an owned buffer.
      // Destroying one halo's geometry invalidates every later Sprite draw.
      if (object.geometry && !object.isSprite) object.geometry.dispose();
      if (object.material) {
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const value of Object.values(material.uniforms || {})) {
            if (value?.value?.isTexture) value.value.dispose();
          }
          if (material.map && !material.map.userData?.cached) material.map.dispose();
          material.dispose();
        }
      }
    });
  }

  _retireSystemObjects(objects) {
    if (!objects.length) return;
    this.retiredSystems.add({ objects });
  }

  clearSystem({ immediate = false } = {}) {
    const retiredObjects = [...this.world.children];
    this.world.clear();
    if (immediate) this._disposeSystemObjects(retiredObjects);
    else this._retireSystemObjects(retiredObjects);
    for (const marker of this.markers) marker.el.remove();
    this.markers = [];
    this.bodies = [];
    this.moons = [];
    this.pickMeshes = [];
    this.starUniformsList = [];
    this.selected = null;
    this.blackHoleRecord = null;
    this.lensPass.enabled = false;
    this.reticle.visible = false;
    if (this.navArrow) this.navArrow.style.display = 'none';
    if (this.nameTag) this.nameTag.style.display = 'none';
  }

  suspend() {
    // StarMap switches its frame loop away from SystemView before calling this.
    // That gives resource destruction a real ownership boundary: detach the
    // old scene, fence all submissions that could reference it, then release.
    if (this.world.children.length || this.markers.length) this.clearSystem();
    if (this.cleanupPromise) return this.cleanupPromise;
    if (!this.retiredSystems.size) return Promise.resolve();
    this.renderer._renderLists?.dispose?.();
    this.renderer._renderContexts?.dispose?.();
    const queue = this.renderer.backend?.device?.queue;
    const fence = queue?.onSubmittedWorkDone ? queue.onSubmittedWorkDone() : Promise.resolve();
    this.cleanupPromise = fence.catch(() => {}).then(() => {
      for (const retired of this.retiredSystems) this._disposeSystemObjects(retired.objects);
      this.retiredSystems.clear();
    }).finally(() => { this.cleanupPromise = null; });
    return this.cleanupPromise;
  }

  buildSystem(preview, timeHours) {
    this.clearSystem();
    this.preview = preview;
    this.timeHours = timeHours;
    const rand = makeRng(preview.star.id + ':sysview');
    const anisotropy = Math.min(8, this.renderer.getMaxAnisotropy?.() || 1);

    this._buildBackdrop(rand);
    const primaryRecords = this._buildStars(preview, timeHours);
    this._buildOrbits(preview, timeHours, anisotropy, rand);
    const outermost = Math.max(14, this.starOrbitRadiusMax || 0, ...this.bodies.map((b) => b.orbitRadius));
    this._buildContours(outermost, preview.isBlackHoleSystem);

    // frame the whole system: outermost orbit decides the default distance
    this.defaultView.elevation = preview.isBlackHoleSystem ? 0.34 : 0.557;
    this.defaultView.distance = THREE.MathUtils.clamp(outermost * 1.42, 34, 72);
    this.resetView();
    return primaryRecords;
  }

  _buildBackdrop(rand) {
    // starfield
    const count = 4800;
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 58 + Math.pow(rand(), 0.28) * 98, a = rand() * Math.PI * 2, y = (rand() - 0.5) * 76;
      pos[i * 3] = Math.cos(a) * r;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = Math.sin(a) * r;
      const v = 0.40 + rand() * 0.48;
      col[i * 3] = v * 0.76;
      col[i * 3 + 1] = v * 0.84;
      col[i * 3 + 2] = v * 0.84;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 0.075, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.88, depthWrite: false,
    });
    this.world.add(new THREE.Points(g, m));

    // warm dust sheet under the orbital plane
    const dustTex = makeRadialTexture(768, 'rgba(255,232,198,.18)', 'rgba(174,139,103,.07)', 'rgba(70,55,40,0)');
    const dust = new THREE.Mesh(
      new THREE.PlaneGeometry(66, 55),
      new THREE.MeshBasicMaterial({ map: dustTex, transparent: true, opacity: 0.06, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    dust.rotation.x = -Math.PI / 2;
    dust.position.y = -2.55;
    dust.renderOrder = -3;
    this.world.add(dust);
  }

  _buildStars(preview, timeHours) {
    const records = [];
    const stars = preview.stars;
    const totalMass = stars.reduce((sum, star) => sum + star.massSolar, 0);
    let separation = null;
    if (!preview.isBlackHoleSystem && stars.length > 1 && preview.binaryOrbit) {
      separation = orbitalPosition(preview.binaryOrbit, timeHours, new THREE.Vector3());
    }
    const sepScale = stars.length > 1 && preview.binaryOrbit
      ? 7.4 / Math.max(preview.binaryOrbit.renderRadius, 1)
      : 0;
    const maxCapturedOrbit = preview.isBlackHoleSystem
      ? Math.max(...stars.map((star) => star.orbit?.renderRadius || 1))
      : 1;
    this.starOrbitRadiusMax = 0;

    stars.forEach((starSpec, index) => {
      const color = new THREE.Color(starSpec.color);
      const radius = preview.isBlackHoleSystem
        ? 1.1 + Math.min(0.65, starSpec.radiusRender / 7e6)
        : stars.length > 1
        ? 2.35 + Math.min(1.05, starSpec.radiusRender / 5.5e6)
        : 4.15;
      const group = new THREE.Group();
      group.position.set(0, STAR_CENTER_Y, 0);
      let capturedScale = 0;
      if (preview.isBlackHoleSystem && starSpec.orbit) {
        const orbitRadius = 15 + starSpec.orbit.renderRadius / maxCapturedOrbit * 24;
        capturedScale = orbitRadius / starSpec.orbit.renderRadius;
        this.starOrbitRadiusMax = Math.max(this.starOrbitRadiusMax, orbitRadius);
        const position = orbitalPosition(starSpec.orbit, timeHours, new THREE.Vector3());
        group.position.set(position.x * capturedScale, position.y * capturedScale + STAR_CENTER_Y, position.z * capturedScale);
        const points = [];
        for (let sample = 0; sample < 180; sample++) {
          const t = timeHours + starSpec.orbit.periodHours * sample / 180;
          const p = orbitalPosition(starSpec.orbit, t, new THREE.Vector3());
          points.push(new THREE.Vector3(p.x * capturedScale, p.y * capturedScale + STAR_CENTER_Y, p.z * capturedScale));
        }
        points.push(points[0].clone());
        this.world.add(new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(points),
          new THREE.LineBasicMaterial({ color: 0xffb071, transparent: true, opacity: 0.18, depthWrite: false }),
        ));
      } else if (separation) {
        const share = (index === 0 ? -stars[1].massSolar : stars[0].massSolar) / totalMass;
        group.position.addScaledVector(separation, share * sepScale);
      }
      this.world.add(group);

      const { material, uniforms } = starSurfaceMaterial(color);
      this.starUniformsList.push(uniforms);
      const core = new THREE.Mesh(new THREE.IcosahedronGeometry(radius, 6), material);
      core.userData.record = { kind: 'star' };
      group.add(core);
      this.pickMeshes.push(core);

      const haloTex = makeRadialTexture(768,
        `#${color.clone().lerp(new THREE.Color(0xffffff), 0.86).getHexString()}`,
        `rgba(${Math.round(color.r * 255)},${Math.round(color.g * 255)},${Math.round(color.b * 255)},.16)`,
        'rgba(255,105,20,0)');
      const halo1 = new THREE.Sprite(new THREE.SpriteMaterial({
        map: haloTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.5,
      }));
      halo1.scale.set(radius * 2.33, radius * 2.33, 1);
      group.add(halo1);
      const halo2 = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeRadialTexture(512, `rgba(${Math.round(color.r * 255)},${Math.round(Math.min(255, color.g * 220))},${Math.round(Math.min(255, color.b * 150))},.10)`, 'rgba(255,130,35,.05)', 'rgba(255,90,20,0)'),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.22,
      }));
      halo2.scale.set(radius * 2.87, radius * 2.87, 1);
      group.add(halo2);

      // prominences
      const prominences = new THREE.Group();
      const prand = makeRng(preview.star.id + ':prom:' + index);
      for (let j = 0; j < 7; j++) {
        const a = prand() * Math.PI * 2, span = 0.34 + prand() * 0.5;
        const rad = radius * 0.96, lift = 0.6 + prand() * 1.05;
        const axis = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
        const tangent = new THREE.Vector3(-Math.sin(a), 0, Math.cos(a));
        const pts = [];
        for (let i = 0; i < 18; i++) {
          const t = i / 17;
          const theta = (t - 0.5) * span;
          const surf = axis.clone().multiplyScalar(Math.cos(theta) * rad)
            .add(tangent.clone().multiplyScalar(Math.sin(theta) * rad));
          surf.y += Math.sin(t * Math.PI) * lift + (prand() - 0.5) * 0.08;
          pts.push(surf);
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        const tubeColor = color.clone().lerp(new THREE.Color(0xffe2a0), j % 3 ? 0.35 : 0.72);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(curve, 48, 0.026 + prand() * 0.038, 4, false),
          new THREE.MeshBasicMaterial({ color: tubeColor, transparent: true, opacity: 0.56, blending: THREE.AdditiveBlending, depthWrite: false }),
        );
        prominences.add(tube);
      }
      group.add(prominences);

      records.push({ group, core, halo1, halo2, prominences, radius, uniforms, orbit: starSpec.orbit, orbitScale: capturedScale });
    });

    // light follows the primary, tinted by its spectral class
    const primaryColor = new THREE.Color(stars[0].color);
    this.starLight.color.copy(primaryColor).lerp(new THREE.Color(0xffffff), 0.42);
    if (preview.isBlackHoleSystem) {
      this.starLight.position.copy(records[0].group.position);
    } else if (stars.length > 1 && records[1]) {
      this.starLight.position.copy(records[0].group.position).lerp(records[1].group.position, 0.5);
    } else {
      this.starLight.position.set(0, STAR_CENTER_Y, 0);
    }
    this.starRecords = records;
    return records;
  }

  _buildOrbits(preview, timeHours, anisotropy, rand) {
    const primaries = preview.bodies.filter((body) => !body.isMoon);
    const maxOrbit = Math.max(...primaries.map((body) => body.orbit), 1);
    const bodyMeshes = new Map();
    primaries.forEach((body, i) => this._buildPrimaryBody(body, i, {
      maxOrbit, timeHours, anisotropy, rand, bodyMeshes,
    }));
    // moons ride their parent's group so the whole system stays coherent
    for (const moon of preview.bodies.filter((b) => b.isMoon)) {
      const parent = bodyMeshes.get(moon.parentSpec);
      if (!parent) continue;
      this._buildMoon(moon, parent, { timeHours, anisotropy });
    }
  }

  // One primary body (star, planet, or black hole) with its orbit track,
  // mesh, clouds, atmosphere shell, ring and accretion structure. Black-hole
  // bodies short-circuit with `return` after assembling the compact-object
  // visual — the planet branch below only runs for non-black-hole primaries.
  _buildPrimaryBody(body, i, ctx) {
    const { maxOrbit, timeHours, anisotropy, rand, bodyMeshes } = ctx;
    const isBlackHole = body.type === 'blackHole';
    const orbitRadius = isBlackHole ? 0 : 9 + Math.log1p(body.orbit / 4e7) / Math.log1p(maxOrbit / 4e7) * 36;
    const k = isBlackHole ? 0 : orbitRadius / body.orbitSpec.renderRadius;
    // true elliptical track, sampled from the same ephemeris the game uses
    if (!isBlackHole) {
      const pts = [];
      const samples = 200;
      for (let sIdx = 0; sIdx < samples; sIdx++) {
        const t = timeHours + body.orbitSpec.periodHours * sIdx / samples;
        const p = orbitalPosition(body.orbitSpec, t, new THREE.Vector3());
        pts.push(new THREE.Vector3(p.x * k, p.y * k + ORBIT_PLANE_Y, p.z * k));
      }
      pts.push(pts[0].clone());
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0xe1e6e5, transparent: true, opacity: 0.12 + (i % 4) * 0.02, depthWrite: false, depthTest: true }),
      );
      line.renderOrder = 1;
      this.world.add(line);
    }

    const visualRadius = isBlackHole ? 2.7 : 0.55 + Math.min(1.05, body.radius / 310_000) * 1.05;
    const group = new THREE.Group();
    const pos = orbitalPosition(body.orbitSpec, timeHours, new THREE.Vector3());
    group.position.set(pos.x * k, pos.y * k + ORBIT_PLANE_Y, pos.z * k);
    this.world.add(group);

    if (isBlackHole) {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius, 72, 48),
        new THREE.MeshBasicMaterial({ color: 0x000000, fog: false }),
      );
      mesh.userData.record = { kind: 'planet', body };
      mesh.renderOrder = 8;
      group.add(mesh);
      this.pickMeshes.push(mesh);

      // A real spatial accretion structure replaces the old camera-facing
      // sprite.  Dragging the system view now reveals its inclination,
      // thickness and fixed orbital plane instead of rotating a flat image
      // to face the viewer.
      const discInner = visualRadius * 1.78;
      const discOuter = visualRadius * 5.35;
      const discMaterial = makePreviewAccretionMaterial(discInner, discOuter, body.blackHole?.discTemperatureK || 4300);
      discMaterial.uniforms.uIntensity.value = 0.46;
      const disc = new THREE.Mesh(
        new THREE.RingGeometry(discInner, discOuter, 256, 28),
        discMaterial,
      );
      disc.rotation.x = -Math.PI / 2;
      disc.rotation.z = (body.axialTilt || 0) + 0.08;
      disc.renderOrder = 6;
      group.add(disc);

      const photonShell = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius * 1.72, 80, 56),
        makePreviewPhotonMaterial(),
      );
      photonShell.renderOrder = 10;
      group.add(photonShell);

      const photonRing = new THREE.Mesh(
        new THREE.TorusGeometry(visualRadius * 1.58, visualRadius * 0.032, 10, 192),
        new THREE.MeshBasicMaterial({
          color: 0xffd39b, transparent: true, opacity: 0.38,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        }),
      );
      photonRing.rotation.x = Math.PI / 2;
      photonRing.renderOrder = 11;
      group.add(photonRing);

      // Two lifted far-side traces show the same disc light bending around
      // the compact object. They stay in world space, so the distortion has
      // parallax when the player rotates the preview.
      for (const side of [-1, 1]) {
        for (let lane = 0; lane < 4; lane++) {
          const points = [];
          for (let sample = 0; sample <= 96; sample++) {
            const a = THREE.MathUtils.lerp(-1.22, 1.22, sample / 96);
            const spread = 1 + lane * 0.085;
            const x = Math.sin(a) * visualRadius * 2.12 * spread;
            const y = side * (visualRadius * (1.10 + lane * 0.10) + Math.cos(a) * visualRadius * 0.55);
            const z = -Math.cos(a) * visualRadius * (0.28 + lane * 0.035);
            points.push(new THREE.Vector3(x, y, z));
          }
          const trace = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints(points),
            new THREE.LineBasicMaterial({
              color: side > 0 ? 0xffd6a0 : 0xff7a28,
              transparent: true, opacity: (side > 0 ? 0.28 : 0.17) * (1 - lane * 0.14),
              blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
            }),
          );
          trace.rotation.y = 0.08;
          trace.renderOrder = 9;
          group.add(trace);
        }
      }
      const record = { kind: 'planet', body, group, mesh, cloud: null, radius: visualRadius, orbitRadius, spin: 0.00018, moonPivots: [] };
      this.bodies.push(record);
      this.blackHoleRecord = record;
      this.lensPass.enabled = true;
      bodyMeshes.set(body.index, record);
      this._addMarker(record);
      return;
    }

    const { map, emissiveMap } = bodyTextures(body, anisotropy);
    map.userData.cached = true;
    const material = new THREE.MeshStandardMaterial({
      map,
      roughness: body.type === 'ice' ? 0.72 : 0.9,
      metalness: 0,
    });
    if (emissiveMap) {
      emissiveMap.userData.cached = true;
      material.emissiveMap = emissiveMap;
      material.emissive = new THREE.Color(body.type === 'lava' ? 0xff7a26 : 0xa04fd8);
      material.emissiveIntensity = body.type === 'lava' ? 1.9 : 0.6;
    }
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(visualRadius, 64, 44), material);
    mesh.rotation.y = rand() * Math.PI * 2;
    mesh.rotation.z = (body.axialTilt || 0) * 0.5;
    mesh.userData.record = { kind: 'planet', body };
    group.add(mesh);
    this.pickMeshes.push(mesh);

    let cloud = null;
    if (CLOUD_TYPES.has(body.type)) {
      const cloudTex = makeCloudTexture(body);
      cloudTex.userData.cached = true;
      cloud = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius * 1.018, 56, 38),
        new THREE.MeshStandardMaterial({ map: cloudTex, transparent: true, opacity: 0.62, depthWrite: false, roughness: 1 }),
      );
      group.add(cloud);
    }
    const atmo = ATMO_STYLES[body.type];
    if (atmo) {
      const shell = new THREE.Mesh(
        new THREE.SphereGeometry(visualRadius * 1.115, 48, 32),
        atmosphereMaterial(atmo[0], atmo[1]),
      );
      group.add(shell);
    }
    const giant = body.type === 'gasGiant' || body.type === 'iceGiant';
    const ringChance = body.type === 'gasGiant' ? 0.55 : body.type === 'iceGiant' ? 0.22 : 0;
    if (rand() < ringChance) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(visualRadius * 1.45, visualRadius * (2.3 + rand() * 0.8), 160, 2),
        ringMaterial(body.seed, 0xc28a68),
      );
      ring.rotation.x = Math.PI / (2.35 + rand() * 0.5);
      ring.rotation.z = (rand() - 0.5) * 0.4;
      group.add(ring);
    }

    const record = {
      kind: 'planet', body, group, mesh, cloud, radius: visualRadius,
      orbitRadius,
      spin: 0.00055 + (strHash32(body.seed) % 1000) / 1000 * 0.00025,
      moonPivots: [],
    };
    this.bodies.push(record);
    bodyMeshes.set(body.index, record);
    this._addMarker(record);
  }

  // One moon: pivot + mesh + faint orbit track. Rides the parent's group so
  // the whole system stays coherent as the primary moves along its ephemeris.
  _buildMoon(moon, parent, ctx) {
    const { timeHours, anisotropy } = ctx;
    const moonOrbit = parent.radius + 0.85 + Math.min(1.9, moon.orbit / 1.3e6);
    const km = moonOrbit / moon.orbitSpec.renderRadius;
    const moonSize = 0.1 + Math.min(0.2, moon.radius / 300_000 * 0.2);
    const pivot = new THREE.Group();
    parent.group.add(pivot);
    const { map } = bodyTextures(moon, anisotropy);
    map.userData.cached = true;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(moonSize, 32, 22),
      new THREE.MeshStandardMaterial({ map, roughness: 1, metalness: 0 }),
    );
    const pos = orbitalPosition(moon.orbitSpec, timeHours, new THREE.Vector3());
    mesh.position.set(pos.x * km, pos.y * km * 0.6, pos.z * km);
    pivot.add(mesh);
    // faint moon track
    const ringPts = [];
    for (let sIdx = 0; sIdx <= 72; sIdx++) {
      const t = timeHours + moon.orbitSpec.periodHours * sIdx / 72;
      const p = orbitalPosition(moon.orbitSpec, t, new THREE.Vector3());
      ringPts.push(new THREE.Vector3(p.x * km, p.y * km * 0.6, p.z * km));
    }
    const ring = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(ringPts),
      new THREE.LineBasicMaterial({ color: 0x9db8bc, transparent: true, opacity: 0.1, depthWrite: false }),
    );
    pivot.add(ring);
    parent.moonPivots.push({ pivot, speed: 0.05 + (strHash32(moon.seed) % 100) * 0.001 });
    this.moons.push({ body: moon, mesh, parent });
  }

  _buildContours(outermost, compactObject = false) {
    const masses = [{ x: 0, z: 0, a: 8.8, s: 8.0, anisX: 0.76, anisZ: 1.18 }];
    for (const record of this.bodies) {
      masses.push({
        x: record.group.position.x,
        z: record.group.position.z,
        a: 0.34 + record.radius * 0.5,
        s: 1.9 + record.radius * 0.5,
        anisX: 1, anisZ: 1,
      });
    }
    this.world.add(buildContourField(masses, outermost * 1.12, compactObject));
  }

  _addMarker(record) {
    const el = document.createElement('div');
    el.className = 'worldLabel';
    el.innerHTML = '<div class="diamond"></div>';
    this.labelHost.appendChild(el);
    this.markers.push({ record, el, offset: new THREE.Vector3(0, record.radius + 0.78, 0) });
    el.style.display = this.labelsVisible ? 'block' : 'none';
  }

  selectBody(body) {
    this.selected = this.bodies.find((record) => record.body === body) || null;
    for (const marker of this.markers) {
      marker.el.classList.toggle('target', marker.record === this.selected);
    }
    if (!this.selected) {
      this.reticle.visible = false;
      if (this.navArrow) this.navArrow.style.display = 'none';
      if (this.nameTag) this.nameTag.style.display = 'none';
      return;
    }
    this.reticle.visible = true;
    if (this.navArrow) this.navArrow.style.display = 'block';
    if (this.nameTag) {
      this.nameTag.textContent = this.selected.body.name;
      this.nameTag.style.display = 'block';
    }
  }

  frame(dt) {
    this._elapsed = (this._elapsed || 0) + dt;
    const t = this._elapsed;
    for (const uniforms of this.starUniformsList) uniforms.uTime.value = t;
    for (const star of this.starRecords || []) {
      star.core.rotation.y = t * 0.032;
      star.core.rotation.z = t * 0.012;
      star.prominences.rotation.y = t * 0.05;
      star.halo1.material.rotation = t * 0.018;
      star.halo2.material.rotation = -t * 0.012;
      if (star.orbit && star.orbitScale) {
        const position = orbitalPosition(star.orbit, this.timeHours + t * 18, new THREE.Vector3());
        star.group.position.set(position.x * star.orbitScale, position.y * star.orbitScale + STAR_CENTER_Y, position.z * star.orbitScale);
      }
    }
    for (const record of this.bodies) {
      record.mesh.rotation.y += record.spin * 60 * dt;
      if (record.body.type === 'blackHole') {
        for (const child of record.group.children) {
          if (child.material?.uniforms?.uTime) child.material.uniforms.uTime.value = t;
        }
      }
      if (record.cloud) record.cloud.rotation.y += record.spin * 80 * dt;
      for (const moon of record.moonPivots) moon.pivot.rotation.y += moon.speed * dt;
    }
    if (this.blackHoleRecord && this.lensPass.enabled) {
      const center = this.blackHoleRecord.group.position.clone().project(this.camera);
      const distance = this.camera.position.distanceTo(this.blackHoleRecord.group.position);
      const verticalFraction = this.blackHoleRecord.radius * 3.4
        / (2 * Math.max(1, distance) * Math.tan(THREE.MathUtils.degToRad(this.camera.fov * 0.5)));
      this.lensPass.uniforms.uCenter.value.set(center.x * 0.5 + 0.5, center.y * 0.5 + 0.5);
      this.lensPass.uniforms.uRadius.value = THREE.MathUtils.clamp(verticalFraction, 0.075, 0.24);
      this.lensPass.uniforms.uAspect.value = this.camera.aspect;
    }
    this._updateMarkers(t);
    if (this.rendererReady) this.renderPipeline.render();
  }

  _updateMarkers(t) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const w = rect.width, h = rect.height;
    if (!w || !h) return;
    const temp = new THREE.Vector3();
    const center = new THREE.Vector3();
    const view = new THREE.Vector3();
    for (const marker of this.markers) {
      center.copy(marker.record.group.position);
      view.copy(center).applyMatrix4(this.camera.matrixWorldInverse);
      center.project(this.camera);
      temp.copy(marker.record.group.position).add(marker.offset).project(this.camera);
      const x = (temp.x * 0.5 + 0.5) * w;
      const y = (-temp.y * 0.5 + 0.5) * h;
      const centerX = (center.x * 0.5 + 0.5) * w;
      const centerY = (-center.y * 0.5 + 0.5) * h;
      const visible = view.z < -this.camera.near && center.z > -1 && center.z < 1
        && centerX > 0 && centerX < w && centerY > 0 && centerY < h;
      marker.el.style.transform = `translate(${x}px,${y}px) translate(-50%,-50%)`;
      marker.el.style.opacity = visible ? '1' : '0';
    }
    if (this.selected) {
      this.reticle.position.copy(this.selected.group.position);
      this.reticle.quaternion.copy(this.camera.quaternion);
      this.reticle.scale.setScalar(this.selected.radius * 1.30 * (1 + Math.sin(t * 1.35) * 0.006));

      temp.copy(this.selected.group.position)
        .add(new THREE.Vector3(0, -this.selected.radius - 0.72, 0)).project(this.camera);
      if (this.navArrow) {
        this.navArrow.style.left = ((temp.x * 0.5 + 0.5) * w - 4) + 'px';
        this.navArrow.style.top = ((-temp.y * 0.5 + 0.5) * h - 4) + 'px';
      }
      temp.copy(this.selected.group.position)
        .add(new THREE.Vector3(this.selected.radius * 0.72, -this.selected.radius * 0.48, 0)).project(this.camera);
      if (this.nameTag) {
        this.nameTag.style.left = ((temp.x * 0.5 + 0.5) * w) + 'px';
        this.nameTag.style.top = ((-temp.y * 0.5 + 0.5) * h) + 'px';
      }
    }
  }

  dispose() {
    this.clearSystem();
    this.renderPipeline.dispose?.();
    this.renderer.dispose();
    for (const retired of this.retiredSystems) this._disposeSystemObjects(retired.objects);
    this.retiredSystems.clear();
    this.renderer.domElement.remove();
  }
}
