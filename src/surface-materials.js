import * as THREE from 'three';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';

function pixel(r, g, b, a = 255, colorSpace = THREE.NoColorSpace) {
  const texture = new THREE.DataTexture(new Uint8Array([r, g, b, a]), 1, 1);
  texture.colorSpace = colorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}

function slot(texture) {
  return { value: texture, listeners: new Set(), ready: false, error: null };
}

export const surfaceMaterialSlots = {
  grassColor: slot(pixel(128, 128, 128, 255, THREE.SRGBColorSpace)),
  grassNormal: slot(pixel(128, 128, 255)),
  grassOrm: slot(pixel(255, 210, 0)),
  rockColor: slot(pixel(128, 128, 128, 255, THREE.SRGBColorSpace)),
  rockNormal: slot(pixel(128, 128, 255)),
  rockRoughness: slot(pixel(210, 210, 210)),
};

const files = {
  grassColor: 'sparse_grass_diff_1k.ktx2',
  grassNormal: 'sparse_grass_nor_gl_1k.ktx2',
  grassOrm: 'sparse_grass_arm_1k.ktx2',
  rockColor: 'rock_ground_diff_1k.ktx2',
  rockNormal: 'rock_ground_nor_gl_1k.ktx2',
  rockRoughness: 'rock_ground_rough_1k.ktx2',
};

let configured = false;

export function watchSurfaceTexture(name, listener) {
  const target = surfaceMaterialSlots[name];
  if (!target) throw new Error(`Unknown surface texture slot: ${name}`);
  target.listeners.add(listener);
  listener(target.value);
  return () => target.listeners.delete(listener);
}

export function configureSurfaceMaterials(renderer) {
  if (configured || typeof document === 'undefined') return;
  configured = true;
  const loader = new KTX2Loader()
    .setTranscoderPath('/assets/vendor/basis/')
    .detectSupport(renderer);
  for (const [name, file] of Object.entries(files)) {
    loader.load(`/assets/surfaces/${file}`, (texture) => {
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = Math.min(8, renderer.capabilities?.getMaxAnisotropy?.() || 4);
      texture.colorSpace = name.endsWith('Color') ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      const target = surfaceMaterialSlots[name];
      target.value = texture;
      target.ready = true;
      for (const listener of target.listeners) listener(texture);
    }, undefined, (error) => {
      // Neutral procedural placeholders are intentional fallbacks: a missing
      // KTX2 can never turn terrain white, black or invisible.
      surfaceMaterialSlots[name].error = String(error?.message || error);
      console.warn(`surface material fallback: ${file}`, error);
    });
  }
}

export function surfaceMaterialStatus() {
  const entries = Object.values(surfaceMaterialSlots);
  return {
    ready: entries.filter((entry) => entry.ready).length,
    total: entries.length,
    errors: entries.filter((entry) => entry.error).map((entry) => entry.error),
  };
}
