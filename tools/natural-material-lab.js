import * as THREE from 'three';
import { MeshBasicNodeMaterial, WebGPURenderer } from 'three/webgpu';
import { GasGiant } from '../src/gas-giant.js';
import { BlackHole } from '../src/black-hole.js';
import { makeCloudVolumeMaterial } from '../src/clouds.js';
import { applyTerrainDetail, applyWaterWaves } from '../src/shaders.js';
import { SkyDome } from '../src/effects.js';

const renderer = new WebGPURenderer({ antialias: false, forceWebGL: new URLSearchParams(location.search).get('backend') === 'webgl' });
renderer.setSize(640, 360);
document.body.appendChild(renderer.domElement);

try {
  await renderer.init();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(55, 640 / 360, 0.01, 100);
  camera.position.set(0, 1, 8);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x17243a, 2));
  const sun = new THREE.DirectionalLight(0xffddbb, 3); sun.position.set(4, 3, 5); scene.add(sun);

  const giant = new GasGiant({
    seed: 'node-lab', name: 'Node Giant', catalogName: 'N-1',
    posUniv: new THREE.Vector3(), type: 'gasGiant', radius: 1,
    ringSystem: { present: true, innerRadiusRatio: 1.35, outerRadiusRatio: 2.1,
      opticalDepth: 0.7, iceFraction: 0.6, gaps: [0.42, 0.73] },
  });
  giant.group.position.x = -2.7; scene.add(giant.group);

  const blackHole = new BlackHole({
    spec: { seed: 'node-hole', bodyId: 'bh', name: 'BH', properName: 'BH', catalogName: 'BH',
      radius: 0.38, accretionRadius: 1.4, axialTilt: 0.1, blackHole: { discTemperatureK: 4400 } },
    posUniv: new THREE.Vector3(),
  });
  blackHole.group.position.x = 2.5; scene.add(blackHole.group);

  const cloud = makeCloudVolumeMaterial({ R: 1, seaLevel: 0 }, {
    rIn: 1.01, rOut: 1.08, cov0: 0.38, cov1: 0.66,
    ox: 1.2, oy: 2.3, oz: 3.4, tint: 0xffffff,
  }, null);
  cloud.uniforms.uEngage.value = 1;
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.08, 32, 20), cloud);
  scene.add(cloudMesh);

  const terrainPlanet = {
    R: 1, hAmp: 0.15,
    pal: { land: [{ c: new THREE.Color(0x27462c) }, { c: new THREE.Color(0xb29a72) }],
      rock: new THREE.Color(0x625b54), forest: new THREE.Color(0x173c25), blotch: new THREE.Color(0x755d38) },
    palU: { t0: -0.05, tSpan: 0.2 },
  };
  const terrainGeometry = new THREE.SphereGeometry(1, 32, 20);
  terrainGeometry.setAttribute('aLocal', terrainGeometry.attributes.position.clone());
  terrainGeometry.setAttribute('aMat', new THREE.BufferAttribute(new Float32Array(terrainGeometry.attributes.position.count * 3).fill(0.6), 3));
  terrainGeometry.setAttribute('aExtra', new THREE.BufferAttribute(new Float32Array(terrainGeometry.attributes.position.count * 4).fill(0.2), 4));
  const terrain = new THREE.Mesh(terrainGeometry,
    applyTerrainDetail(new THREE.MeshStandardMaterial(), terrainPlanet));
  terrain.position.y = -2.3; scene.add(terrain);

  const waterGeometry = terrainGeometry.clone();
  waterGeometry.setAttribute('aDepth', new THREE.BufferAttribute(new Float32Array(waterGeometry.attributes.position.count).fill(16), 1));
  const water = new THREE.Mesh(waterGeometry, applyWaterWaves(new THREE.MeshPhysicalMaterial({ transparent: true, opacity: 0.8 }), {
    pal: { sea: [{ c: new THREE.Color(0x061b35) }] }, liquidColor: new THREE.Color(0x3b8fad), skyColor: new THREE.Color(0x729fd3),
  }));
  water.position.set(2.5, -2.3, 0); scene.add(water);

  // Scope optics use the renderer-neutral RenderTarget, sampled by a node
  // material on the weapon glass in both backends.
  const scopeTarget = new THREE.RenderTarget(64, 64, { depthBuffer: true });
  const optic = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.8),
    new MeshBasicNodeMaterial({ map: scopeTarget.texture }));
  optic.position.set(0, 2.2, 0); scene.add(optic);

  const sky = new SkyDome(scene); sky.update(new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 0).normalize(),
    new THREE.Color(0x88bbff), new THREE.Color(0x224488), 0.25);
  await renderer.compileAsync(scene, camera);
  renderer.setRenderTarget(scopeTarget);
  renderer.setClearColor(0x2a6b85, 1);
  renderer.clear();
  renderer.setRenderTarget(null);
  renderer.render(scene, camera);
  window.NMS_NATURAL_LAB = { ready: true, backend: renderer.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2' };
} catch (error) {
  console.error(error);
  window.NMS_NATURAL_LAB = { ready: false, error: String(error), stack: error.stack };
}
