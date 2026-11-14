import * as THREE from 'three';

const sharedGenerators = new WeakMap();

export function getSharedPmremGenerator(renderer) {
  if (!renderer) return null;
  let pmrem = sharedGenerators.get(renderer);
  if (!pmrem) {
    pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    sharedGenerators.set(renderer, pmrem);
    const canvas = renderer.domElement;
    if (canvas && typeof canvas.addEventListener === 'function') {
      canvas.addEventListener('webglcontextlost', () => {
        sharedGenerators.delete(renderer);
      }, { once: true });
    }
  }
  return pmrem;
}

export function isSharedPmremGenerator(renderer, generator) {
  return Boolean(renderer && generator && sharedGenerators.get(renderer) === generator);
}
