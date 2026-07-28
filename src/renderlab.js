import * as THREE from 'three/webgpu';
import { color, float, mix, mx_fractal_noise_float, positionLocal, time, vec3 } from 'three/tsl';
import { resolveRendererPolicy } from './renderer-policy.js';
import { createGameRenderer, installDeviceRecovery } from './renderer-runtime.js';

const params = new URLSearchParams(location.search);
const policy = resolveRendererPolicy(params);
const status = document.getElementById('status');
const runtime = await createGameRenderer(policy, { antialias: true });
const renderer = runtime.renderer;
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

try {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02060b);
  const camera = new THREE.PerspectiveCamera(52, innerWidth / innerHeight, 0.1, 100);
  camera.position.set(0, 0.4, 4.6);
  const material = new THREE.MeshStandardNodeMaterial({ roughness: 0.58, metalness: 0.08 });
  const weather = mx_fractal_noise_float(positionLocal.mul(vec3(1.8, 8.0, 1.8)).add(time.mul(float(0.045))), 5);
  material.colorNode = mix(color(0x153b70), color(0xd69a5e), weather.smoothstep(0.28, 0.76));
  material.roughnessNode = mix(float(0.38), float(0.84), weather);
  const planet = new THREE.Mesh(new THREE.SphereGeometry(1.25, 128, 80), material);
  scene.add(planet, new THREE.HemisphereLight(0x9fc9ff, 0x1b1611, 1.6));
  const sun = new THREE.DirectionalLight(0xffe4c0, 4.4); sun.position.set(3, 2, 4); scene.add(sun);
  const backend = runtime.backend;
  status.textContent = `WebGPURenderer · ${backend} · TSL node material`;
  window.NMS_RENDERLAB = {
    ready: true, backend, reason: runtime.reason, renderer,
    material: 'MeshStandardNodeMaterial', adapterInfo: runtime.adapterInfo,
  };
  installDeviceRecovery(renderer, (state, detail) => {
    if (state !== 'lost') return;
    status.textContent = `device lost: ${detail || 'recovering on reload'}`;
    window.NMS_RENDERLAB.deviceLost = true;
  });
  renderer.setAnimationLoop(() => { planet.rotation.y += 0.0025; renderer.render(scene, camera); });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight);
  });
} catch (error) {
  status.textContent = `renderer init failed: ${error.message}`;
  window.NMS_RENDERLAB = { ready: false, error: String(error) };
  throw error;
}
