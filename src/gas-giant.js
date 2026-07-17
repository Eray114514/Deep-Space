import * as THREE from 'three';
import { makeRng } from './rng.js';

function makeBands(seed, type) {
  const rand = makeRng(`${seed}:gas-bands`);
  const canvas = document.createElement('canvas');
  canvas.width = 1024; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const ice = type === 'iceGiant';
  const palette = ice
    ? [[30, 104, 150], [51, 151, 192], [117, 205, 222], [25, 80, 133]]
    : [[173, 118, 73], [224, 190, 133], [121, 83, 63], [235, 220, 181], [190, 145, 99]];
  let y = 0;
  while (y < canvas.height) {
    const band = 7 + rand() * 34;
    const c = palette[Math.floor(rand() * palette.length)];
    const g = ctx.createLinearGradient(0, y, 0, y + band);
    const shade = () => Math.round((rand() - 0.5) * 24);
    const col = (k = 0) => `rgb(${Math.max(0, c[0] + k)},${Math.max(0, c[1] + k)},${Math.max(0, c[2] + k)})`;
    g.addColorStop(0, col(shade())); g.addColorStop(0.5, col(shade())); g.addColorStop(1, col(shade()));
    ctx.fillStyle = g; ctx.fillRect(0, y, canvas.width, band + 1); y += band;
  }
  // Long-lived anticyclonic storms provide scale and a recognisable landmark.
  for (let i = 0; i < (ice ? 2 : 5); i++) {
    const x = rand() * canvas.width, sy = canvas.height * (0.2 + rand() * 0.6);
    const rx = 34 + rand() * 95, ry = rx * (0.22 + rand() * 0.18);
    ctx.save(); ctx.translate(x, sy); ctx.scale(1, ry / rx);
    const g = ctx.createRadialGradient(0, 0, 2, 0, 0, rx);
    g.addColorStop(0, ice ? 'rgba(220,245,255,.85)' : 'rgba(177,65,43,.85)');
    g.addColorStop(0.65, ice ? 'rgba(56,133,177,.45)' : 'rgba(227,172,116,.45)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, rx, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.anisotropy = 4;
  return texture;
}

function atmosphereMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uSunDir: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: `varying vec3 vN; varying vec3 vLN; varying vec3 vP; void main(){vLN=normalize(normal); vN=normalize(normalMatrix*normal); vec4 p=modelViewMatrix*vec4(position,1.); vP=p.xyz; gl_Position=projectionMatrix*p;}`,
    fragmentShader: `uniform vec3 uColor; uniform vec3 uSunDir; varying vec3 vN; varying vec3 vLN; varying vec3 vP; void main(){vec3 v=normalize(-vP); float rim=pow(1.-max(dot(v,vN),0.),2.4); float day=.06+.94*max(dot(vLN,normalize(uSunDir)),0.); gl_FragColor=vec4(uColor*(.28+day)*rim,rim*.72);}`,
    side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

export class GasGiant {
  constructor({ seed, name, catalogName, posUniv, type, radius, atmosphere = null, fadeIn = false }) {
    this.seed = seed; this.name = name; this.catalogName = catalogName;
    this.type = type; this.isGasGiant = true; this.isMoon = false; this.landable = false;
    this.atmosphere = atmosphere;
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
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      map: makeBands(seed, type), roughness: 0.82, metalness: 0,
      color: 0xffffff, transparent: fadeIn, opacity: this.appear,
    });
    this.terrainMaterial.userData.shader = null;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.terrainMaterial);
    this.mesh.receiveShadow = true; this.group.add(this.mesh);
    this.hazeMaterial = atmosphereMaterial(this.skyColor);
    this.haze = new THREE.Mesh(new THREE.SphereGeometry(radius * 1.09, 72, 48), this.hazeMaterial);
    this.group.add(this.haze);
    const rand = makeRng(`${seed}:ring`);
    if (rand() < 0.58) {
      const inner = radius * (1.38 + rand() * 0.2), outer = radius * (2.15 + rand() * 0.65);
      const ring = new THREE.RingGeometry(inner, outer, 160, 1);
      const pos = ring.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const rr = Math.hypot(pos.getX(i), pos.getY(i));
        const band = 0.25 + 0.55 * Math.abs(Math.sin(rr / radius * 41 + rand() * 2));
        colors[i * 3] = band; colors[i * 3 + 1] = band * 0.9; colors[i * 3 + 2] = band * 0.72;
      }
      ring.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      this.ringMesh = new THREE.Mesh(ring, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.62, side: THREE.DoubleSide, depthWrite: false }));
      this.ringMesh.rotation.x = Math.PI / 2; this.group.add(this.ringMesh);
    }
    this.sunDirLocal = new THREE.Vector3(0, 1, 0); this.sunDirWorld = new THREE.Vector3(0, 1, 0);
    this.frameOrientation = new THREE.Quaternion(); this._invFrame = new THREE.Quaternion();
    this.lod = { countChunks: () => 0 };
  }
  get typeLabel() { return this.type === 'iceGiant' ? '冰巨星' : '气态巨星'; }
  setFrame(orientation) { this.frameOrientation.copy(orientation); this._invFrame.copy(orientation).invert(); this.group.quaternion.copy(orientation); }
  setSunDir(worldDir) {
    this.sunDirWorld.copy(worldDir);
    this.sunDirLocal.copy(worldDir).applyQuaternion(this._invFrame);
    this.hazeMaterial.uniforms.uSunDir.value.copy(this.sunDirLocal);
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
  update(_camWorld, dt, _focused, animDt = dt) {
    this.mesh.rotation.y += animDt * (this.type === 'iceGiant' ? 0.012 : 0.021);
    if (this.ringMesh) this.ringMesh.rotation.z += animDt * 0.0002;
    if (this.appear < 1) { this.appear = Math.min(1, this.appear + dt / 1.2); this.terrainMaterial.opacity = this.appear; }
  }
  dispose() {
    this.mesh.geometry.dispose(); this.terrainMaterial.map?.dispose(); this.terrainMaterial.dispose();
    this.haze.geometry.dispose(); this.hazeMaterial.dispose();
    if (this.ringMesh) { this.ringMesh.geometry.dispose(); this.ringMesh.material.dispose(); }
  }
}
