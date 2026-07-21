import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { makeRng } from './rng.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const heroAssetCache = new Map();
const heroAssetLoader = new GLTFLoader();
heroAssetLoader.setMeshoptDecoder(MeshoptDecoder);

function attachHeroAsset(group, site) {
  const path = site.type === 'hero-city-world'
    ? '/assets/civilization/city-terminal.glb'
    : site.type === 'hero-floating-city' ? '/assets/civilization/aerostat-core.glb' : null;
  if (!path) return;
  if (!heroAssetCache.has(path)) heroAssetCache.set(path, heroAssetLoader.loadAsync(path));
  heroAssetCache.get(path).then((gltf) => {
    if (!group.parent) return;
    const asset = gltf.scene.clone(true);
    asset.name = `hero-asset:${site.type}`;
    asset.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry = object.geometry.clone();
      object.material = Array.isArray(object.material)
        ? object.material.map((entry) => entry.clone()) : object.material.clone();
      object.castShadow = true; object.receiveShadow = true;
    });
    group.add(asset);
    group.userData.heroAssetReady = true;
  }).catch((error) => {
    group.userData.heroAssetError = String(error);
    console.warn(`Hero asset failed to load: ${path}`, error);
  });
}

function material(color, metalness = 0.72, roughness = 0.34, emissive = 0) {
  const glow = emissive || (metalness > 0.6 ? color : 0);
  return new THREE.MeshStandardMaterial({
    color, metalness, roughness, emissive: glow,
    emissiveIntensity: emissive ? 2.4 : metalness > 0.6 ? 0.065 : 0,
  });
}

function mesh(geometry, mat, parent, position = null) {
  const object = new THREE.Mesh(geometry, mat);
  if (position) object.position.copy(position);
  object.castShadow = true;
  object.receiveShadow = true;
  parent.add(object);
  return object;
}

function modulePalette() {
  return {
    hull: material(0x8d969b, 0.78, 0.3),
    dark: material(0x1d292e, 0.88, 0.25),
    ceramic: material(0xc4c8c2, 0.5, 0.42),
    glass: material(0x17384a, 0.45, 0.16, 0x4fc3ff),
    amber: material(0x50341b, 0.5, 0.28, 0xff9f40),
    red: material(0x3b1714, 0.6, 0.3, 0xff4c32),
  };
}

function addPad(group, mats, radius = 42) {
  const pad = mesh(new THREE.CylinderGeometry(radius, radius * 1.06, 3.2, 32), mats.dark, group);
  const inset = mesh(new THREE.RingGeometry(radius * 0.36, radius * 0.82, 48), mats.amber, group);
  inset.rotation.x = -Math.PI / 2;
  inset.position.y = 1.7;
  const beacon = new THREE.PointLight(0xff9f40, 12, radius * 3.5, 2);
  beacon.position.y = 7;
  group.add(beacon);
  group.userData.landingPad = pad;
}

function addTruss(group, mats, length, radius = 5) {
  const truss = mesh(new THREE.CylinderGeometry(radius, radius, length, 8), mats.hull, group);
  truss.rotation.z = Math.PI / 2;
  return truss;
}

function cityCluster(site, scale = 1) {
  const rand = makeRng(`${site.seed}:city-cluster`);
  const group = new THREE.Group();
  const mats = modulePalette();
  addPad(group, mats, 52 * scale);
  for (let i = 0; i < 54; i++) {
    const angle = rand() * Math.PI * 2;
    const radius = (70 + Math.pow(rand(), 0.62) * 430) * scale;
    const width = (16 + rand() * 38) * scale;
    const height = (20 + Math.pow(rand(), 2.1) * 310) * scale;
    const tower = mesh(new THREE.BoxGeometry(width, height, width * (0.72 + rand() * 0.5)),
      i % 7 === 0 ? mats.glass : i % 5 === 0 ? mats.ceramic : mats.hull, group,
      new THREE.Vector3(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius));
    tower.rotation.y = -angle + (rand() - 0.5) * 0.3;
    if (height > 150 * scale) {
      const mast = mesh(new THREE.CylinderGeometry(1.2 * scale, 2.4 * scale, height * 0.26, 6), mats.red, tower);
      mast.position.y = height * 0.62;
    }
  }
  for (let i = 0; i < 9; i++) {
    const road = mesh(new THREE.BoxGeometry(720 * scale, 1.4 * scale, 7 * scale), mats.amber, group);
    road.position.y = 0.9 * scale;
    road.rotation.y = i * Math.PI / 9;
  }
  group.userData.materials = Object.values(mats);
  return group;
}

function cityLights(site, body) {
  const rand = makeRng(`${site.seed}:night-network`);
  const count = 2200;
  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const longitude = rand() * Math.PI * 2;
    const latitude = Math.asin((rand() * 2 - 1) * 0.76);
    const corridor = Math.sin(longitude * 7 + latitude * 11 + rand() * 0.35);
    const radius = body.R * 1.004;
    positions[i * 3] = Math.cos(latitude) * Math.cos(longitude) * radius;
    positions[i * 3 + 1] = Math.sin(latitude) * radius;
    positions[i * 3 + 2] = Math.cos(latitude) * Math.sin(longitude) * radius;
    const warmth = 0.72 + 0.28 * Math.max(0, corridor);
    colors[i * 3] = 1; colors[i * 3 + 1] = 0.42 + warmth * 0.32; colors[i * 3 + 2] = 0.16;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(geometry, new THREE.PointsMaterial({
    size: Math.max(110, body.R * 0.0022), sizeAttenuation: true, vertexColors: true,
    transparent: true, opacity: 0.82, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
}

function floatingCity(site, body) {
  const group = new THREE.Group();
  const mats = modulePalette();
  const rand = makeRng(`${site.seed}:aerostat`);
  const deckRadius = Math.max(180, body.R * 0.008);
  mesh(new THREE.CylinderGeometry(deckRadius, deckRadius * 0.9, deckRadius * 0.12, 48), mats.dark, group);
  mesh(new THREE.TorusGeometry(deckRadius * 0.78, deckRadius * 0.07, 12, 72), mats.hull, group).rotation.x = Math.PI / 2;
  addPad(group, mats, deckRadius * 0.24);
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI * 2 / 12;
    const radial = deckRadius * (0.48 + rand() * 0.18);
    const height = deckRadius * (0.3 + rand() * 0.9);
    const tower = mesh(new THREE.CylinderGeometry(deckRadius * 0.035, deckRadius * 0.065, height, 8),
      i % 3 === 0 ? mats.glass : mats.ceramic, group,
      new THREE.Vector3(Math.cos(angle) * radial, height / 2 + deckRadius * 0.06, Math.sin(angle) * radial));
    tower.rotation.y = angle;
  }
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3;
    const engine = mesh(new THREE.CylinderGeometry(deckRadius * 0.08, deckRadius * 0.12, deckRadius * 0.35, 16), mats.hull, group,
      new THREE.Vector3(Math.cos(angle) * deckRadius * 0.88, -deckRadius * 0.18, Math.sin(angle) * deckRadius * 0.88));
    const glow = mesh(new THREE.ConeGeometry(deckRadius * 0.09, deckRadius * 0.42, 14, 1, true), mats.amber, engine);
    glow.position.y = -deckRadius * 0.38;
    glow.rotation.x = Math.PI;
  }
  group.userData.materials = Object.values(mats);
  const fill = new THREE.HemisphereLight(0x9ccde7, 0x322015, 1.35);
  fill.position.y = deckRadius;
  group.add(fill);
  for (const x of [-1, 1]) {
    const flood = new THREE.PointLight(x < 0 ? 0x8edcff : 0xffb45f, 220000, deckRadius * 5, 2);
    flood.position.set(x * deckRadius * 0.48, deckRadius * 0.58, deckRadius * 0.16);
    group.add(flood);
  }
  return group;
}

function orbitalStation(site) {
  const group = new THREE.Group();
  const mats = modulePalette();
  const rand = makeRng(`${site.seed}:station`);
  const scale = 90000;
  if (site.type === 'ring-station') {
    mesh(new THREE.TorusGeometry(scale, scale * 0.075, 12, 96), mats.hull, group);
    addTruss(group, mats, scale * 2.7, scale * 0.04);
  } else if (site.type === 'spine-dock') {
    addTruss(group, mats, scale * 3.4, scale * 0.08);
    for (let i = -3; i <= 3; i++) {
      const dock = mesh(new THREE.BoxGeometry(scale * 0.65, scale * 0.12, scale * 0.16), mats.dark, group);
      dock.position.x = i * scale * 0.42;
      dock.position.z = (i % 2 ? -1 : 1) * scale * 0.24;
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const angle = i * Math.PI * 2 / 7;
      const node = mesh(new THREE.IcosahedronGeometry(scale * (0.22 + rand() * 0.12), 1), i % 2 ? mats.hull : mats.glass, group,
        new THREE.Vector3(Math.cos(angle) * scale, Math.sin(angle * 2) * scale * 0.18, Math.sin(angle) * scale));
      node.rotation.set(rand(), rand(), rand());
    }
  }
  group.userData.materials = Object.values(mats);
  return group;
}

function surfaceOutpost(site) {
  const group = new THREE.Group();
  const mats = modulePalette();
  const rand = makeRng(`${site.seed}:outpost`);
  addPad(group, mats, 28);
  for (let i = 0; i < 7; i++) {
    const angle = i * Math.PI * 2 / 7;
    const module = mesh(new THREE.CapsuleGeometry(7 + rand() * 5, 18 + rand() * 20, 5, 10), i % 3 ? mats.hull : mats.ceramic, group,
      new THREE.Vector3(Math.cos(angle) * 62, 9, Math.sin(angle) * 62));
    module.rotation.z = Math.PI / 2;
    module.rotation.y = -angle;
  }
  if (site.type === 'relay-outpost') {
    const dish = mesh(new THREE.SphereGeometry(35, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.33), mats.ceramic, group);
    dish.scale.y = 0.28; dish.position.set(96, 42, -35); dish.rotation.z = 0.42;
  } else if (site.type === 'mining-outpost') {
    addTruss(group, mats, 180, 5).position.set(-70, 28, 30);
  }
  group.userData.materials = Object.values(mats);
  return group;
}

function orientSurface(group, site, body, altitude = 0) {
  const normal = new THREE.Vector3(...site.landingZone.normal).normalize();
  const radius = body.surfaceRadius ? body.surfaceRadius(normal) : body.R + body.atmoHeight * 0.48;
  group.position.copy(normal).multiplyScalar(radius + altitude);
  group.quaternion.setFromUnitVectors(Y_AXIS, normal);
  group.userData.surfaceNormal = normal;
  group.userData.surfaceRadius = radius;
  site.landingZone.normal = normal.toArray();
}

export function createCivilizationVisual(site, body = null) {
  let group;
  if (site.type === 'hero-city-world') {
    group = cityCluster(site, Math.max(1, body.R / 800000));
    orientSurface(group, site, body, 3);
    const lights = cityLights(site, body);
    body.group.add(lights);
    group.userData.planetLights = lights;
  } else if (site.type === 'hero-floating-city') {
    group = floatingCity(site, body);
    // The synthetic habitat is already anchored in the giant's upper
    // atmosphere. Its local radius is the physical flight deck, so keep the
    // visible pad and the walk/landing collision surface coincident.
    orientSurface(group, site, body,
      body.type === 'artificialHabitat' ? -body.deckTop : body.atmoHeight * 0.48);
  } else if (site.type.endsWith('outpost')) {
    group = surfaceOutpost(site);
    if (body) orientSurface(group, site, body, 2);
  } else {
    group = orbitalStation(site);
  }
  group.name = `civilization:${site.id}:${site.type}`;
  group.userData.site = site;
  attachHeroAsset(group, site);
  return group;
}

// A floating city is a real landing target rather than a flag that makes the
// gas giant itself solid.  This compact local-gravity frame travels with the
// parent giant and supplies the same surface contract used by walking and
// boarding, while the atmosphere below remains non-landable.
export class ArtificialHabitat {
  constructor(site, parentBody, positionUniv, orientation = new THREE.Quaternion()) {
    this.site = site; this.parentPlanet = parentBody; this.bodyId = `site:${site.id}`;
    this.seed = site.seed; this.name = '云海浮城'; this.catalogName = site.id;
    this.type = 'artificialHabitat'; this.typeLabel = '人工浮空栖居地';
    this.isGasGiant = false; this.isMoon = false; this.landable = true;
    this.R = 1250; this.gravity = 4.8; this.atmoHeight = 5000; this.atmoDensity = 0.58;
    this.deckTop = Math.max(180, this.R * 0.008) * 0.06;
    this.hasLiquid = false; this.liquid = null; this.seaLevel = -1e9; this.seaRadius = 0;
    this.posUniv = positionUniv.clone(); this.frameVelocity = new THREE.Vector3();
    this.frameOrientation = orientation.clone(); this._invFrame = orientation.clone().invert();
    this.parentDistance = positionUniv.distanceTo(parentBody.posUniv);
    this.parentDirectionWorld = positionUniv.clone().sub(parentBody.posUniv).normalize();
    this.group = new THREE.Group(); this.group.name = `artificial-habitat:${site.id}`;
    this.group.quaternion.copy(this.frameOrientation);
    this.terrainMaterial = new THREE.MeshBasicMaterial({ visible: false });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(this.R, 16, 12), this.terrainMaterial);
    this.mesh.visible = false; this.group.add(this.mesh);
    this.skyColor = parentBody.skyColor.clone(); this.skyColorLin = parentBody.skyColorLin.clone();
    this.sunDirWorld = parentBody.sunDirWorld.clone(); this.sunDirLocal = parentBody.sunDirLocal.clone();
    this.pal = parentBody.pal; this.spec = { bodyId: this.bodyId, type: this.type, landable: true };
    this.fullMaxFreq = 1; this.lod = { countChunks: () => 0 };
  }
  height() { return this.deckTop; }
  surfaceRadius() { return this.R + this.deckTop; }
  altitudeAt(worldOffset) { return worldOffset.length() - this.surfaceRadius(); }
  cloudTransit() { return 0; }
  biomeAt() { return 'barren'; }
  scenicDir() { return new THREE.Vector3(...this.site.landingZone.normal).normalize(); }
  setFrame(orientation) { this.frameOrientation.copy(orientation); this._invFrame.copy(orientation).invert(); this.group.quaternion.copy(orientation); }
  setSunDir(direction) { this.sunDirWorld.copy(direction); this.sunDirLocal.copy(direction).applyQuaternion(this._invFrame); }
  update() {}
  updateVisual() {}
  followParent() {
    // Thruster-stabilized aerostats hold an inertial longitude instead of
    // inheriting a gas giant's extremely fast cloud-deck rotation. This keeps
    // approach, landing and takeoff continuous while the parent still carries
    // the city along its orbit.
    this.posUniv.copy(this.parentPlanet.posUniv)
      .addScaledVector(this.parentDirectionWorld, this.parentDistance);
    this.frameVelocity.copy(this.parentPlanet.frameVelocity);
  }
  worldOffsetToLocal(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this._invFrame); }
  localOffsetToWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.frameOrientation); }
  localPositionToWorld(v, out = new THREE.Vector3()) { return out.copy(v).applyQuaternion(this.frameOrientation).add(this.posUniv); }
  worldPositionToLocal(v, out = new THREE.Vector3()) { return out.copy(v).sub(this.posUniv).applyQuaternion(this._invFrame); }
  dispose() { disposeCivilizationVisual(this.group); }
}

export function disposeCivilizationVisual(group) {
  const textures = new Set(), materials = new Set(), geometries = new Set();
  group.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const mat of list) {
      materials.add(mat);
      for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((mat) => mat.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}
