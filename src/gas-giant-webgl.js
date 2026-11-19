import * as THREE from 'three';
import { makeRng } from './rng.js';
import { resolveAtmosphereModel } from './atmosphere-chemistry.js';
import { makeAtmosphereMaterialWebGL } from './atmosphere-webgl.js';

const _camLocal = new THREE.Vector3();

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

export class GasGiant {
  constructor({ seed, name, catalogName, posUniv, type, radius, atmosphere = null, equilibriumK = null, fadeIn = false }) {
    this.seed = seed; this.name = name; this.catalogName = catalogName;
    this.type = type; this.isGasGiant = true; this.isMoon = false; this.landable = false;
    this.atmosphere = atmosphere;
    this.equilibriumK = Number.isFinite(equilibriumK) ? equilibriumK : null;
    this.posUniv = posUniv.clone(); this.R = radius;
    this.atmoHeight = radius * 0.38; this.atmoDensity = type === 'iceGiant' ? 0.92 : 1.05;
    this.gravity = type === 'iceGiant' ? 12.5 : 21.5;
    this.hasLiquid = false; this.liquid = null; this.seaLevel = -1e9; this.seaRadius = 0;
    this.appear = fadeIn ? 0 : 1;

    const atmoModel = resolveAtmosphereModel(this);
    this.atmoModel = atmoModel;
    this.skyColor = new THREE.Color(atmoModel.appearance.skyHex);
    this.skyColorLin = this.skyColor.clone();   // Color(hex) already decoded to linear
    this.atmoColor = new THREE.Color(atmoModel.appearance.atmoHex);
    this.pal = { land: [{ c: this.skyColor.clone().multiplyScalar(0.35) }, { c: this.skyColor.clone() }, { c: this.skyColor.clone().multiplyScalar(0.55) }] };
    this.group = new THREE.Group(); this.group.name = `gas-giant:${name}`;
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      map: makeBands(seed, type), roughness: 0.82, metalness: 0,
      color: 0xffffff, transparent: fadeIn, opacity: this.appear,
    });
    this.terrainMaterial.userData.shader = null;
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 64), this.terrainMaterial);
    this.mesh.receiveShadow = true; this.group.add(this.mesh);

    const opticalR = atmoModel.profile.topRadiusMeters;
    this.hazeTopR = opticalR;
    this.hazeMaterial = makeAtmosphereMaterialWebGL(this.atmoColor, this.atmoDensity, radius, opticalR, atmoModel);
    this.hazeMaterial.fog = false;
    this.haze = new THREE.Mesh(new THREE.SphereGeometry(opticalR, 96, 64), this.hazeMaterial);
    this.haze.renderOrder = 1;
    this.haze.frustumCulled = false;
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
  setFrame(orientation) {
    this.frameOrientation.copy(orientation);
    this._invFrame.copy(orientation).invert();
    this.group.quaternion.copy(orientation);
    this.sunDirLocal.copy(this.sunDirWorld).applyQuaternion(this._invFrame);
    if (this.stellarLightField?.sources) {
      for (const source of this.stellarLightField.sources) {
        source.localDirection.copy(source.worldDirection).applyQuaternion(this._invFrame);
      }
      this.setStellarLights(this.stellarLightField);
    } else {
      const u = this.hazeMaterial.uniforms;
      u.sunDir.value.copy(this.sunDirLocal);
      u.uStellarDirections0.value.copy(this.sunDirLocal);
    }
  }
  setSunDir(worldDir) {
    this.sunDirWorld.copy(worldDir);
    this.sunDirLocal.copy(worldDir).applyQuaternion(this._invFrame);
    const u = this.hazeMaterial.uniforms;
    u.sunDir.value.copy(this.sunDirLocal);
    u.uStellarDirections0.value.copy(this.sunDirLocal);
  }
  setStellarLights(field) {
    if (!field?.sources?.length) return this.setSunDir(this.sunDirWorld);
    const ordered = [...field.sources];
    const dominant = Math.max(0, Math.min(ordered.length - 1, field.dominantIndex ?? 0));
    if (dominant !== 0) [ordered[0], ordered[dominant]] = [ordered[dominant], ordered[0]];
    this.stellarLightField = {
      ...field,
      sources: ordered.map((source) => ({
        ...source,
        worldDirection: new THREE.Vector3().fromArray(source.direction).normalize(),
        localDirection: new THREE.Vector3().fromArray(source.direction)
          .applyQuaternion(this._invFrame).normalize(),
        colorValue: new THREE.Color().fromArray(source.color || [1, 1, 1]),
      })),
      dominantIndex: 0,
    };
    const primary = this.stellarLightField.sources[0];
    const secondary = this.stellarLightField.sources[1] || null;
    this.sunDirWorld.copy(primary.worldDirection);
    this.sunDirLocal.copy(primary.localDirection);
    const u = this.hazeMaterial.uniforms;
    u.uRadianceScale.value = this.stellarLightField.radianceScale ?? 3.2;
    u.sunDir.value.copy(primary.localDirection);
    u.uStellarDirections0.value.copy(primary.localDirection);
    u.uStellarRadiance0.value.copy(primary.colorValue);
    u.uStarIrradiance0.value = primary.irradianceFraction ?? 1;
    if (secondary) {
      u.uStellarDirections1.value.copy(secondary.localDirection);
      u.uStellarRadiance1.value.copy(secondary.colorValue);
      u.uStarIrradiance1.value = secondary.irradianceFraction ?? 0;
    } else {
      u.uStarIrradiance1.value = 0;
    }
  }
  setEclipseOccluder(occluder = null) {
    const u = this.hazeMaterial.uniforms;
    if (!occluder) { u.uEclipseEnabled.value = 0; return; }
    u.uEclipseCenter.value.copy(occluder.centerLocal);
    u.uEclipseRadius.value = Math.max(1, occluder.radius || 1);
    u.uEclipseStarAngle.value = Math.max(0, occluder.starAngularRadius || 0);
    u.uEclipseEnabled.value = 1;
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
  applyAppear() {
    this.terrainMaterial.opacity = this.appear;
    this.hazeMaterial.uniforms.density.value = this.appear;
  }
  update(camWorld, dt, _focused, animDt = dt) {
    this.mesh.rotation.y += animDt * (this.type === 'iceGiant' ? 0.012 : 0.021);
    if (this.ringMesh) this.ringMesh.rotation.z += animDt * 0.0002;
    if (camWorld) {
      this.worldOffsetToLocal(camWorld, _camLocal);
      this.hazeMaterial.uniforms.uCameraLocal.value.copy(_camLocal);
      const wantedSide = _camLocal.length() < this.hazeTopR * 1.04 ? THREE.BackSide : THREE.FrontSide;
      if (this.hazeMaterial.side !== wantedSide) this.hazeMaterial.side = wantedSide;
    }
    if (this.appear < 1) { this.appear = Math.min(1, this.appear + dt / 1.2); this.applyAppear(); }
  }
  dispose() {
    this.mesh.geometry.dispose(); this.terrainMaterial.map?.dispose(); this.terrainMaterial.dispose();
    this.haze.geometry.dispose(); this.hazeMaterial.dispose();
    if (this.ringMesh) { this.ringMesh.geometry.dispose(); this.ringMesh.material.dispose(); }
  }
}
