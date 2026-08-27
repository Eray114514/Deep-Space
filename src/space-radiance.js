import * as THREE from 'three';
import { makeRng } from './rng.js';

const PI2 = Math.PI * 2;

function hash3(x, y, z, seed) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)
    ^ Math.imul(z | 0, 2147483647) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
function mix(a, b, t) { return a + (b - a) * t; }

function noise3(x, y, z, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = fade(x - ix), fy = fade(y - iy), fz = fade(z - iz);
  const x00 = mix(hash3(ix, iy, iz, seed), hash3(ix + 1, iy, iz, seed), fx);
  const x10 = mix(hash3(ix, iy + 1, iz, seed), hash3(ix + 1, iy + 1, iz, seed), fx);
  const x01 = mix(hash3(ix, iy, iz + 1, seed), hash3(ix + 1, iy, iz + 1, seed), fx);
  const x11 = mix(hash3(ix, iy + 1, iz + 1, seed), hash3(ix + 1, iy + 1, iz + 1, seed), fx);
  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz);
}

function fbm3(x, y, z, seed, octaves = 4) {
  let value = 0, amplitude = 0.56, norm = 0;
  for (let octave = 0; octave < octaves; octave++) {
    value += noise3(x, y, z, seed + octave * 1013) * amplitude;
    norm += amplitude;
    x = x * 2.03 + 7.1;
    y = y * 2.03 - 4.7;
    z = z * 2.03 + 2.9;
    amplitude *= 0.48;
  }
  return value / norm;
}

function seedInt(seed) {
  let h = 2166136261;
  for (const c of String(seed)) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function fingerprint(values) {
  let hash = 2166136261;
  const stride = Math.max(4, Math.floor(values.length / 8192 / 4) * 4);
  for (let i = 0; i < values.length; i += stride) {
    hash ^= Math.round(Math.min(1, values[i]) * 65535);
    hash = Math.imul(hash, 16777619);
    hash ^= Math.round(Math.min(1, values[i + 1]) * 65535);
    hash = Math.imul(hash, 16777619);
    hash ^= Math.round(Math.min(1, values[i + 2]) * 65535);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function generateSpaceRadianceData(seed, width = 512, height = Math.round(width / 2)) {
  const data = new Float32Array(width * height * 4);
  const rand = makeRng(`${seed}:space-radiance:v1`);
  const nSeed = seedInt(`${seed}:space-radiance:v1`);
  const plane = new THREE.Vector3((rand() - 0.5) * 0.38, 1, (rand() - 0.5) * 0.38).normalize();
  const tintShift = rand();
  let total = 0, totalBand = 0, totalOutside = 0, bandSamples = 0, outsideSamples = 0;
  let minLuma = Infinity, maxLuma = 0;

  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    const latitude = (v - 0.5) * Math.PI;
    const cosLat = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width - 0.5) * PI2;
      const dx = Math.cos(longitude) * cosLat;
      const dy = Math.sin(latitude);
      const dz = Math.sin(longitude) * cosLat;
      const low = fbm3(dx * 1.45 + 4.2, dy * 1.45 - 1.8, dz * 1.45 + 8.3, nSeed, 4);
      const warp = (fbm3(dx * 3.1 - 5.4, dy * 3.1 + 9.7, dz * 3.1 + 1.2,
        nSeed ^ 0x6ac1e743, 3) - 0.5) * 0.20;
      const signedPlane = dx * plane.x + dy * plane.y + dz * plane.z + warp;
      const band = Math.exp(-Math.pow(Math.abs(signedPlane) / 0.115, 1.62));
      const filament = fbm3(dx * 8.2 + 17.0, dy * 8.2 - 2.0, dz * 8.2 + 6.0,
        nSeed ^ 0x2c9277b5, 4);
      const dust = Math.pow(Math.max(0, 1 - Math.abs(signedPlane) / 0.075), 1.7)
        * Math.pow(fbm3(dx * 13.0, dy * 13.0, dz * 13.0,
          nSeed ^ 0x51ed270b, 3), 2.2);
      const floor = 0.72 + low * 0.90;
      const galaxy = band * (0.28 + filament * filament * 1.12) * (1 - dust * 0.64);
      const warm = 0.35 + 0.65 * fbm3(dx * 4.4, dy * 4.4, dz * 4.4,
        nSeed ^ 0x3141592, 3);

      // Keep every direction above the display black floor while leaving an
      // order of magnitude of headroom for the authored Milky Way sprites.
      let r = 0.00330 * floor + galaxy * (0.027216 + warm * 0.022032);
      let g = 0.0044375 * floor + galaxy * (0.023328 + warm * 0.01242);
      let b = 0.00735 * floor + galaxy * (0.043524 - warm * 0.010368);
      if (tintShift > 0.5) {
        r *= 0.94; b *= 1.05;
      } else {
        r *= 1.04; b *= 0.97;
      }
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 1;
      const luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
      total += luma;
      minLuma = Math.min(minLuma, luma);
      maxLuma = Math.max(maxLuma, luma);
      if (band > 0.5) { totalBand += luma; bandSamples++; }
      if (band < 0.08) { totalOutside += luma; outsideSamples++; }
    }
  }

  return {
    data,
    width,
    height,
    stats: Object.freeze({
      minLuma,
      maxLuma,
      meanLuma: total / (width * height),
      bandMeanLuma: totalBand / Math.max(1, bandSamples),
      outsideMeanLuma: totalOutside / Math.max(1, outsideSamples),
      fingerprint: fingerprint(data),
    }),
  };
}

function toHalfTexture(generated) {
  const half = new Uint16Array(generated.data.length);
  for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(generated.data[i]);
  const texture = new THREE.DataTexture(
    half, generated.width, generated.height, THREE.RGBAFormat, THREE.HalfFloatType,
  );
  texture.name = 'space-radiance-equirect';
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.colorSpace = THREE.LinearSRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

export class SpaceRadiance {
  constructor(renderer, seed, { width = 1024, visible = true } = {}) {
    const generated = generateSpaceRadianceData(seed, width, Math.round(width / 2));
    this.stats = generated.stats;
    this.texture = toHalfTexture(generated);
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const target = pmrem.fromEquirectangular(this.texture);
    this.environmentMap = target.texture;
    this.environmentMap.name = 'space-radiance-pmrem';
    this.environmentTarget = target;
    pmrem.dispose();

    this.material = new THREE.ShaderMaterial({
      name: 'SpaceRadianceMaterial',
      uniforms: {
        uMap: { value: this.texture },
        uDim: { value: 0 },
      },
      vertexShader: /* glsl */`
        varying vec3 vDirection;
        void main() {
          vDirection = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uMap;
        uniform float uDim;
        varying vec3 vDirection;
        const float RECIP_PI = 0.31830988618;
        const float RECIP_PI2 = 0.15915494309;
        void main() {
          vec3 dir = normalize(vDirection);
          vec2 uv = vec2(atan(dir.z, dir.x) * RECIP_PI2 + 0.5,
            asin(clamp(dir.y, -1.0, 1.0)) * RECIP_PI + 0.5);
          vec3 radiance = texture2D(uMap, uv).rgb * (1.0 - uDim * 0.965);
          gl_FragColor = vec4(radiance, 1.0);
        }`,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(5e10, 40, 24), this.material);
    this.mesh.name = 'space-radiance-background';
    this.mesh.renderOrder = -30;
    this.mesh.frustumCulled = false;
    this.mesh.visible = visible;
  }

  setDimming(value) {
    this.material.uniforms.uDim.value = THREE.MathUtils.clamp(value, 0, 1);
  }

  setVisible(value) { this.mesh.visible = Boolean(value); }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.environmentTarget.dispose();
  }
}
