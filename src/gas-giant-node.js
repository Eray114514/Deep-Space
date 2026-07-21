import * as THREE from 'three';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import {
  abs, attribute, clamp, color, dot, float, mix, mx_fractal_noise_float,
  normalLocal, normalView, positionLocal, positionViewDirection, pow, sin,
  smoothstep, uniform, vec3,
} from 'three/tsl';
import { makeRng } from './rng.js';

function giantMaterial(seed, type) {
  const rand = makeRng(`${seed}:gas-weather:v2`);
  const ice = type === 'iceGiant';
  const colors = ice
    ? [0x0c4167, 0x207ea7, 0x70c5d9, 0x174d7f]
    : [0x6b3827, 0xb87542, 0xe1bd78, 0x7b5744];
  const seedOffset = rand() * 19 + rand() * 37;
  const nodes = {
    uTime: uniform(0),
    uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
  };
  const n = normalLocal.normalize();
  const lat = n.y;
  const jet = sin(lat.mul(52).add(nodes.uTime.mul(0.025)));
  const broad = mx_fractal_noise_float(positionLocal.normalize().mul(vec3(5, 36, 5))
    .add(vec3(nodes.uTime.mul(0.012), seedOffset, nodes.uTime.mul(-0.009))), 4);
  const fine = mx_fractal_noise_float(positionLocal.normalize().mul(vec3(18, 116, 18))
    .add(vec3(seedOffset * 0.7, nodes.uTime.mul(-0.018), seedOffset)), 3);
  const zones = smoothstep(-0.65, 0.72, jet.mul(0.72).add(broad.mul(0.82)));
  let surface = mix(color(colors[0]), color(colors[1]), zones);
  surface = mix(surface, color(colors[2]), smoothstep(0.38, 0.82, fine).mul(float(0.3).add(zones.mul(0.35))));
  const storm = smoothstep(0.62, 0.94, broad.mul(0.55).add(fine.mul(0.8)))
    .mul(smoothstep(0.78, 0.18, abs(lat.sub(ice ? 0.35 : -0.18))));
  surface = mix(surface, color(colors[3]), storm.mul(ice ? 0.42 : 0.7));
  surface = mix(surface, color(colors[2]), smoothstep(0.74, 0.98, abs(lat)).mul(0.32));
  const day = float(0.035).add(dot(n, nodes.uSunDir.normalize()).max(0).mul(0.965));
  const limb = pow(float(1).sub(dot(normalView.normalize(), positionViewDirection).abs()), 2.2);
  surface = surface.mul(day.mul(float(1).sub(limb.mul(0.32))).add(vec3(0.035, 0.06, 0.085).mul(limb)));
  const material = new MeshStandardNodeMaterial({ roughness: 0.94, metalness: 0 });
  material.colorNode = surface;
  material.uniforms = nodes;
  return material;
}

function atmosphereMaterial(color) {
  const nodes = { uColor: uniform(color.clone()), uSunDir: uniform(new THREE.Vector3(0, 1, 0)) };
  const rim = pow(float(1).sub(dot(normalView.normalize(), positionViewDirection).abs()), 2.4);
  const day = float(0.06).add(dot(normalLocal.normalize(), nodes.uSunDir.normalize()).max(0).mul(0.94));
  const material = new MeshBasicNodeMaterial({
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  material.colorNode = nodes.uColor.mul(float(0.28).add(day)).mul(rim);
  material.opacityNode = rim.mul(0.72);
  material.uniforms = nodes;
  return material;
}

function ringMaterial(ringSystem, color) {
  const nodes = {
    uColor: uniform(color),
    uOpacity: uniform(Math.min(0.92, 0.2 + ringSystem.opticalDepth * 0.72)),
    uGap0: uniform(ringSystem.gaps[0] ?? 0.43),
    uGap1: uniform(ringSystem.gaps[1] ?? 0.72),
  };
  const r = attribute('aRadius', 'float');
  const edge = smoothstep(0, 0.035, r).mul(smoothstep(1, 0.955, r));
  const bands = float(0.42).add(abs(sin(r.mul(96))).mul(0.42)).add(sin(r.mul(371)).mul(0.18));
  const gaps = smoothstep(0.026, 0.012, abs(r.sub(nodes.uGap0)))
    .mul(smoothstep(0.019, 0.008, abs(r.sub(nodes.uGap1))));
  const material = new MeshBasicNodeMaterial({
    transparent: true, side: THREE.DoubleSide, depthWrite: false,
  });
  material.colorNode = nodes.uColor.mul(float(0.62).add(bands.mul(0.45)));
  material.opacityNode = edge.mul(bands).mul(gaps).mul(nodes.uOpacity);
  material.uniforms = nodes;
  return material;
}

function buildRing(body, ringSystem, seed) {
  const inner = body.R * ringSystem.innerRadiusRatio;
  const outer = body.R * ringSystem.outerRadiusRatio;
  const geometry = new THREE.RingGeometry(inner, outer, 256, 8);
  const position = geometry.attributes.position;
  const radius = new Float32Array(position.count);
  for (let i = 0; i < position.count; i++) radius[i] = (Math.hypot(position.getX(i), position.getY(i)) - inner) / (outer - inner);
  geometry.setAttribute('aRadius', new THREE.BufferAttribute(radius, 1));
  const tint = new THREE.Color().setRGB(
    0.58 + ringSystem.iceFraction * 0.28,
    0.5 + ringSystem.iceFraction * 0.34,
    0.42 + ringSystem.iceFraction * 0.42,
  );
  const ringMesh = new THREE.Mesh(geometry, ringMaterial(ringSystem, tint));
  ringMesh.rotation.x = Math.PI / 2;
  ringMesh.renderOrder = 2;

  const rand = makeRng(`${seed}:ring-particles:v2`);
  const count = 420;
  const particleGeometry = new THREE.IcosahedronGeometry(Math.max(24, body.R * 0.00022), 0);
  const particles = new THREE.InstancedMesh(particleGeometry, new THREE.MeshStandardMaterial({ color: tint, roughness: 0.82, metalness: 0.05 }), count);
  const matrix = new THREE.Matrix4(), p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  for (let i = 0; i < count; i++) {
    const angle = rand() * Math.PI * 2;
    const r = inner + Math.pow(rand(), 0.92) * (outer - inner);
    p.set(Math.cos(angle) * r, (rand() - 0.5) * body.R * 0.004, Math.sin(angle) * r);
    q.setFromEuler(new THREE.Euler(rand() * 6, rand() * 6, rand() * 6));
    const scale = 0.35 + Math.pow(rand(), 2.4) * 3.2;
    s.set(scale, scale * (0.55 + rand()), scale);
    matrix.compose(p, q, s); particles.setMatrixAt(i, matrix);
  }
  particles.visible = false;
  return { ringMesh, particles, outer };
}

export class GasGiant {
  constructor({ seed, name, catalogName, posUniv, type, radius, atmosphere = null, fadeIn = false, formation = null, ringSystem = null }) {
    this.seed = seed; this.name = name; this.catalogName = catalogName;
    this.type = type; this.isGasGiant = true; this.isMoon = false; this.landable = false;
    this.atmosphere = atmosphere; this.formation = formation; this.ringSystem = ringSystem;
    this.posUniv = posUniv.clone(); this.R = radius;
    this.atmoHeight = radius * 0.38; this.atmoDensity = type === 'iceGiant' ? 0.82 : 1.16;
    this.gravity = type === 'iceGiant' ? 12.5 : 21.5;
    this.hasLiquid = false; this.liquid = null; this.seaLevel = -1e9; this.seaRadius = 0;
    this.appear = fadeIn ? 0 : 1;
    const ice = type === 'iceGiant';
    this.skyColor = new THREE.Color(ice ? 0x59b7df : 0xd7a071);
    this.skyColorLin = this.skyColor.clone().convertSRGBToLinear();
    this.pal = { land: [{ c: this.skyColor.clone().multiplyScalar(0.35) }, { c: this.skyColor.clone() }, { c: this.skyColor.clone().multiplyScalar(0.55) }] };
    this.group = new THREE.Group(); this.group.name = `gas-giant:${name}`;
    this.terrainMaterial = giantMaterial(seed, type);
    this.terrainMaterial.transparent = fadeIn; this.terrainMaterial.opacity = this.appear;
    this.terrainMaterial.userData.shader = null;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 80), this.terrainMaterial);
    this.mesh.receiveShadow = true; this.group.add(this.mesh);
    this.hazeMaterial = atmosphereMaterial(this.skyColor);
    this.haze = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.09, 96, 64), this.hazeMaterial);
    this.group.add(this.haze);
    if (ringSystem?.present) {
      const ring = buildRing(this, ringSystem, seed);
      this.ringMesh = ring.ringMesh; this.ringParticles = ring.particles; this.ringOuterRadius = ring.outer;
      this.group.add(this.ringMesh, this.ringParticles);
    }
    this.sunDirLocal = new THREE.Vector3(0, 1, 0); this.sunDirWorld = new THREE.Vector3(0, 1, 0);
    this.frameOrientation = new THREE.Quaternion(); this._invFrame = new THREE.Quaternion();
    this.lod = { countChunks: () => 0 };
  }
  get typeLabel() { return this.type === 'iceGiant' ? '冰巨星' : '气态巨星'; }
  setFrame(orientation) { this.frameOrientation.copy(orientation); this._invFrame.copy(orientation).invert(); this.group.quaternion.copy(orientation); }
  setSunDir(worldDir) {
    this.sunDirWorld.copy(worldDir); this.sunDirLocal.copy(worldDir).applyQuaternion(this._invFrame);
    this.hazeMaterial.uniforms.uSunDir.value.copy(this.sunDirLocal);
    this.terrainMaterial.uniforms.uSunDir.value.copy(this.sunDirLocal);
  }
  worldOffsetToLocal(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this._invFrame); }
  localOffsetToWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.frameOrientation); }
  localPositionToWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.frameOrientation).add(this.posUniv); }
  worldPositionToLocal(v, out = new THREE.Vector3()) { return out.copy(v).sub(this.posUniv).applyQuaternion(this._invFrame); }
  altitudeAt(worldOffset) { return worldOffset.length() - this.R; }
  cloudTransit(worldOffset) {
    const alt = worldOffset.length() - this.R;
    if (alt > this.atmoHeight || alt < -this.R * 0.32) return 0;
    return Math.max(0, Math.min(1, 1 - alt / this.atmoHeight));
  }
  update(camWorld, dt, _focused, animDt = dt) {
    this.terrainMaterial.uniforms.uTime.value += animDt;
    this.mesh.rotation.y += animDt * (this.type === 'iceGiant' ? 0.002 : 0.0035);
    if (this.ringMesh) this.ringMesh.rotation.z += animDt * 0.0002;
    if (this.ringParticles) {
      const distance = camWorld?.distanceTo ? camWorld.distanceTo(this.posUniv) : Infinity;
      this.ringParticles.visible = distance < this.R * 5.5;
      this.ringParticles.rotation.y += animDt * 0.006;
    }
    if (this.appear < 1) { this.appear = Math.min(1, this.appear + dt / 1.2); this.terrainMaterial.opacity = this.appear; }
  }
  dispose() {
    const materials = new Set(), geometries = new Set(), textures = new Set();
    this.group.traverse((object) => {
      if (object.geometry) geometries.add(object.geometry);
      const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
      for (const mat of list) {
        materials.add(mat);
        for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
      }
    });
    textures.forEach((texture) => texture.dispose()); geometries.forEach((geometry) => geometry.dispose()); materials.forEach((mat) => mat.dispose());
  }
}


