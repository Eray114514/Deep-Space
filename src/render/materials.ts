import * as THREE from 'three/webgpu';
import { mulberry32 } from '../simulation/Galaxy';
import type { Biome } from '../game/types';

function tileNoise(u: number, v: number, cells: number, seed: number): number {
  const gx = u * cells, gy = v * cells, x0 = Math.floor(gx), y0 = Math.floor(gy);
  const tx0 = gx - x0, ty0 = gy - y0, tx = tx0 * tx0 * (3 - 2 * tx0), ty = ty0 * ty0 * (3 - 2 * ty0);
  const wrap = (n: number): number => ((n % cells) + cells) % cells;
  const hash = (x: number, y: number): number => { const n = Math.sin(x * 127.1 + y * 311.7 + seed * .0137) * 43758.5453123; return n - Math.floor(n); };
  const a = hash(wrap(x0), wrap(y0)), b = hash(wrap(x0 + 1), wrap(y0)), c = hash(wrap(x0), wrap(y0 + 1)), d = hash(wrap(x0 + 1), wrap(y0 + 1));
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

export function createPlanetTexture(seed: number, primary: number, secondary: number, size = 2048): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size / 2;
  const ctx = canvas.getContext('2d')!; const image = ctx.createImageData(canvas.width, canvas.height);
  const a = new THREE.Color(primary), b = new THREE.Color(secondary), c = new THREE.Color(0x111820);
  for (let y = 0; y < canvas.height; y += 1) {
    const v = y / canvas.height; const lat = Math.sin(v * Math.PI);
    for (let x = 0; x < canvas.width; x += 1) {
      const u = x / canvas.width;
      const macro = tileNoise(u, v, 4, seed), continent = tileNoise(u, v, 11, seed + 11), ridge = tileNoise(u, v, 37, seed + 27), detail = tileNoise(u, v, 137, seed + 83);
      const elevation = macro * .34 + continent * .31 + ridge * .22 + detail * .13;
      const shelf = THREE.MathUtils.smoothstep(elevation, .42, .62); const highland = THREE.MathUtils.smoothstep(elevation, .63, .82);
      const col = a.clone().lerp(b, shelf * .84).lerp(new THREE.Color(0xc7b29a), highland * .12).lerp(c, Math.max(0, .2 - lat) * 1.65);
      const strata = (tileNoise(u, v, 89, seed + 173) - .5) * .13; col.offsetHSL(strata * .04, 0, strata);
      const i = (y * canvas.width + x) * 4;
      image.data[i] = col.r * 255; image.data[i + 1] = col.g * 255; image.data[i + 2] = col.b * 255; image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 16; return texture;
}

export function createCloudTexture(seed: number, size = 2048): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size / 2;
  const ctx = canvas.getContext('2d')!; const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y += 1) for (let x = 0; x < canvas.width; x += 1) {
    const u = x / canvas.width, v = y / canvas.height;
    const latitudeFade = Math.pow(Math.sin(v * Math.PI), .28);
    const warpU = (tileNoise(u, v, 11, seed + 301) - .5) * .13 + Math.sin(v * Math.PI * 8 + seed) * .012;
    const warpV = (tileNoise(u, v, 13, seed + 337) - .5) * .09 + Math.sin(u * Math.PI * 10 - seed) * .01;
    const cu = u + warpU, cv = v + warpV;
    const macro = tileNoise(cu, cv, 5, seed + 19) * .29 + tileNoise(cu, cv, 17, seed + 31) * .27;
    const body = tileNoise(cu, cv, 53, seed + 47) * .24 + tileNoise(cu, cv, 157, seed + 91) * .14;
    const erosion = (tileNoise(cu, cv, 383, seed + 211) - .5) * .18;
    const bands = Math.sin(v * 74 + tileNoise(cu, cv, 19, seed + 121) * 11 + Math.sin(u * Math.PI * 6) * 1.4) * .023;
    const weather = (macro + body + erosion + bands) * latitudeFade;
    const core = THREE.MathUtils.smoothstep(weather, .51, .67);
    const tornEdge = THREE.MathUtils.smoothstep(tileNoise(cu, cv, 521, seed + 419), .18, .88);
    const alpha = Math.pow(core, 1.28) * (155 + tornEdge * 70);
    const light = 226 + tornEdge * 22;
    const i = (y * canvas.width + x) * 4; image.data[i] = light; image.data[i + 1] = light + 3; image.data[i + 2] = Math.min(255, light + 6); image.data[i + 3] = alpha;
  }
  ctx.putImageData(image, 0, 0); const texture = new THREE.CanvasTexture(canvas); texture.wrapS = THREE.RepeatWrapping; texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

export function createPanelTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#697276'; ctx.fillRect(0, 0, size, size);
  const gradient = ctx.createLinearGradient(0, 0, size, size); gradient.addColorStop(0, 'rgba(255,255,255,.18)'); gradient.addColorStop(.5, 'rgba(0,0,0,.04)'); gradient.addColorStop(1, 'rgba(0,0,0,.18)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(10,14,16,.8)'; ctx.lineWidth = 5;
  for (let y = 0; y < size; y += 128) for (let x = 0; x < size; x += 128) { ctx.strokeRect(x + 5, y + 5, 118, 118); ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x + 13, y + 13, 4, 4); ctx.fillRect(x + 106, y + 106, 4, 4); }
  ctx.fillStyle = 'rgba(231,174,69,.8)'; ctx.fillRect(0, 328, size, 18); ctx.fillStyle = 'rgba(8,10,11,.8)'; for (let x = -20; x < size; x += 42) { ctx.save(); ctx.translate(x, 328); ctx.rotate(-.65); ctx.fillRect(0, -8, 16, 42); ctx.restore(); }
  const image = ctx.getImageData(0, 0, size, size); for (let i = 0; i < 5000; i += 1) { const p = Math.floor(Math.random() * size * size) * 4; image.data[p] *= .5; image.data[p + 1] *= .45; image.data[p + 2] *= .4; } ctx.putImageData(image, 0, 0);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; return texture;
}

export function createTerrainTexture(biome: Biome, seed: number, size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!; const image = ctx.createImageData(size, size);
  const palette = biome === 'basalt'
    ? [new THREE.Color(0x302522), new THREE.Color(0x795044), new THREE.Color(0xb27b5e)]
    : biome === 'ice'
      ? [new THREE.Color(0x304953), new THREE.Color(0x7ba5ae), new THREE.Color(0xd8edf0)]
      : [new THREE.Color(0x102924), new THREE.Color(0x28584a), new THREE.Color(0x6ca958)];
  const hash = (x: number, y: number): number => {
    const n = Math.sin((x * 127.1 + y * 311.7 + seed * .0137)) * 43758.5453123; return n - Math.floor(n);
  };
  const fade = (t: number): number => t * t * (3 - 2 * t);
  const noise = (u: number, v: number, cells: number): number => {
    const gx = u * cells, gy = v * cells, x0 = Math.floor(gx), y0 = Math.floor(gy), tx = fade(gx - x0), ty = fade(gy - y0);
    const wrap = (n: number): number => ((n % cells) + cells) % cells;
    const a = hash(wrap(x0), wrap(y0)), b = hash(wrap(x0 + 1), wrap(y0)), c = hash(wrap(x0), wrap(y0 + 1)), d = hash(wrap(x0 + 1), wrap(y0 + 1));
    return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
  };
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    const u = x / size, v = y / size;
    const n4 = noise(u, v, 4), n12 = noise(u, v, 12), n32 = noise(u, v, 32), n96 = noise(u, v, 96);
    const t = THREE.MathUtils.clamp(n4 * .4 + n12 * .29 + n32 * .2 + n96 * .11, 0, 1);
    const ridge = Math.abs(n32 - .5); const crack = (1 - THREE.MathUtils.smoothstep(ridge, 0, .028)) * (0.25 + n96 * .2);
    const color = palette[0].clone().lerp(palette[1], THREE.MathUtils.smoothstep(t, .12, .68)).lerp(palette[2], THREE.MathUtils.smoothstep(t, .62, 1));
    color.multiplyScalar(1 - crack);
    const i = (y * size + x) * 4; image.data[i] = color.r * 255; image.data[i + 1] = color.g * 255; image.data[i + 2] = color.b * 255; image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0); const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(11, 11); texture.anisotropy = 8; return texture;
}

export function createSurfaceCloudTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size;
  const ctx = canvas.getContext('2d')!; ctx.clearRect(0, 0, size, size);
  const puffs = [
    [0.25, 0.58, 0.24], [0.42, 0.44, 0.31], [0.58, 0.48, 0.34], [0.73, 0.59, 0.24],
    [0.48, 0.64, 0.36], [0.34, 0.68, 0.23], [0.63, 0.67, 0.26],
  ];
  for (const [x, y, r] of puffs) {
    const gradient = ctx.createRadialGradient(x * size, y * size, 0, x * size, y * size, r * size);
    gradient.addColorStop(0, 'rgba(240,248,250,.42)'); gradient.addColorStop(.42, 'rgba(220,235,240,.22)'); gradient.addColorStop(1, 'rgba(190,215,225,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  }
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}

export function createWarpVeilTexture(size = 512): THREE.CanvasTexture {
  const canvas = document.createElement('canvas'); canvas.width = size; canvas.height = size; const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size * .5, size * .5, 0, size * .5, size * .5, size * .5); gradient.addColorStop(0, 'rgba(225,252,255,.98)'); gradient.addColorStop(.42, 'rgba(110,226,255,.82)'); gradient.addColorStop(.76, 'rgba(66,167,220,.36)'); gradient.addColorStop(1, 'rgba(20,77,125,0)'); ctx.fillStyle = gradient; ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; return texture;
}
