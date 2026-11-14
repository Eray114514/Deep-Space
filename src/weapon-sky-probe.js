import * as THREE from 'three';
import { getSharedPmremGenerator, isSharedPmremGenerator } from './shared-pmrem.js';

// Low-frequency outdoor radiance only: no solar disk (direct lights own it),
// no display exposure, and no artificial multiplier on the night-sky map.
export function weaponSkyPixels(environment, up, width = 64, height = 32) {
  const data = new Float32Array(width * height * 4);
  const daylight = THREE.MathUtils.clamp(environment.day ?? 1, 0, 1);
  const air = THREE.MathUtils.clamp(environment.atmosphere ?? 0, 0, 1);
  const sky = Math.max(0, environment.skyIrradiance ?? daylight * air);
  const sunset = THREE.MathUtils.clamp(environment.sunset ?? 0, 0, 1);
  const energy = daylight * air * (0.3 + sky * 1.4);
  const vertical = up.clone().normalize();
  const zenith = new THREE.Color().setRGB(0.44, 0.66, 1.0);
  const horizon = new THREE.Color().setRGB(0.82, 0.9, 1.0);
  horizon.lerp(new THREE.Color().setRGB(1.0, 0.46, 0.19), sunset * 0.75);
  const ground = new THREE.Color().setRGB(0.18, 0.16, 0.12);
  for (let y = 0; y < height; y++) {
    const latitude = ((y + 0.5) / height - 0.5) * Math.PI;
    const cosLat = Math.cos(latitude);
    for (let x = 0; x < width; x++) {
      const longitude = ((x + 0.5) / width - 0.5) * Math.PI * 2;
      const elevation = Math.cos(longitude) * cosLat * vertical.x
        + Math.sin(latitude) * vertical.y + Math.sin(longitude) * cosLat * vertical.z;
      const color = elevation >= 0
        ? horizon.clone().lerp(zenith, Math.sqrt(elevation))
        : ground.clone().lerp(horizon, Math.exp(elevation * 12) * 0.35);
      const offset = (y * width + x) * 4;
      data[offset] = color.r * energy;
      data[offset + 1] = color.g * energy;
      data[offset + 2] = color.b * energy;
      data[offset + 3] = 1;
    }
  }
  return { data, width, height };
}

export class WeaponSkyProbe {
  constructor() {
    this.generator = null;
    this.target = null;
    this.key = '';
  }

  update(renderer, environment, up) {
    if (!renderer) return null;
    const quantize = (value) => Math.round((value || 0) * 64);
    const key = [environment.day, environment.atmosphere, environment.skyIrradiance,
      environment.sunset, up.x, up.y, up.z].map(quantize).join(':');
    if (this.target && key === this.key) return this.target.texture;
    this.renderer = renderer;
    this.generator ||= getSharedPmremGenerator(renderer);
    const pixels = weaponSkyPixels(environment, up);
    const half = new Uint16Array(pixels.data.length);
    for (let i = 0; i < half.length; i++) half[i] = THREE.DataUtils.toHalfFloat(pixels.data[i]);
    const source = new THREE.DataTexture(half, pixels.width, pixels.height,
      THREE.RGBAFormat, THREE.HalfFloatType);
    source.mapping = THREE.EquirectangularReflectionMapping;
    source.colorSpace = THREE.LinearSRGBColorSpace;
    source.minFilter = THREE.LinearFilter;
    source.magFilter = THREE.LinearFilter;
    source.needsUpdate = true;
    let next;
    try { next = this.generator.fromEquirectangular(source); }
    finally { source.dispose(); }
    next.texture.name = 'weapon-outdoor-sky-pmrem';
    this.target?.dispose();
    this.target = next;
    this.key = key;
    return next.texture;
  }

  dispose() {
    this.target?.dispose();
    if (this.generator && !isSharedPmremGenerator(this.renderer, this.generator)) {
      this.generator.dispose?.();
    }
    this.target = null;
    this.generator = null;
    this.renderer = null;
  }
}
