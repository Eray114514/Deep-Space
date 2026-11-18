import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { makeRng } from './rng.js';
import { createPbrMaterial, normalizeImportedPbrMaterial } from './pbr-materials.js';
import { createSaltlineProps } from './saltline/props.js';
import { patchShaderWithRainWetness, RAIN_WET_UNIFORMS } from './saltline/wet-ground.js';
import { createGoldenHourFurniture } from './golden-hour/furniture.js';

const Y_AXIS = new THREE.Vector3(0, 1, 0);
const heroAssetCache = new Map();
const heroAssetLoader = new GLTFLoader();
heroAssetLoader.setMeshoptDecoder(MeshoptDecoder);

let _sharedOutpostProps = null;
let _sharedOutpostFurniture = null;

function markSharedAssets(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.userData.sharedPropAsset = true;
    const mats = Array.isArray(obj.material) ? obj.material : obj.material ? [obj.material] : [];
    for (const m of mats) m.userData.sharedPropAsset = true;
  });
  return root;
}

function getOutpostProps() {
  if (!_sharedOutpostProps) {
    _sharedOutpostProps = createSaltlineProps({ materials: null, palette: 'frontier' });
  }
  return _sharedOutpostProps;
}

function getOutpostFurniture() {
  if (!_sharedOutpostFurniture) {
    _sharedOutpostFurniture = createGoldenHourFurniture({ anisotropy: 4 });
  }
  return _sharedOutpostFurniture;
}

function placeProp(parent, colliders, lib, name, x, y, z, yaw = 0, opts = {}) {
  try {
    const obj = markSharedAssets(lib.create(name, opts));
    obj.position.set(x, y, z);
    obj.rotation.y = yaw;
    parent.add(obj);
    const sz = obj.userData.size || [1.2, 1.2, 1.2];
    if (colliders) {
      colliders.push({
        name,
        x,
        y,
        z,
        yaw,
        hw: sz[0] * 0.5,
        h: sz[1],
        hd: sz[2] * 0.5,
        surface: obj.userData.surface || 'metal',
      });
    }
    return obj;
  } catch {
    return null;
  }
}

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
        ? object.material.map((entry) => normalizeImportedPbrMaterial(entry.clone()))
        : normalizeImportedPbrMaterial(object.material.clone());
      object.castShadow = true; object.receiveShadow = true;
    });
    group.add(asset);
    group.userData.heroAssetReady = true;
  }).catch((error) => {
    group.userData.heroAssetError = String(error);
    console.warn(`Hero asset failed to load: ${path}`, error);
  });
}

function withRainWetness(mat) {
  if (!mat || !mat.isMeshStandardMaterial || mat.transparent) return mat;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (typeof prev === 'function') prev(shader, renderer);
    patchShaderWithRainWetness(shader, RAIN_WET_UNIFORMS);
  };
  const prevKey = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `${prevKey ? prevKey() : 'site-pbr'}:rainwet-v1`;
  return mat;
}

function material(color, profile, options = {}) {
  return withRainWetness(createPbrMaterial(profile, { color, ...options }));
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
    hull: material(0x8d969b, 'paintedDielectric'),
    dark: material(0x252d31, 'polymer'),
    ceramic: material(0xc4c8c2, 'ceramic'),
    glass: createPbrMaterial('glass', {
      color: 0x17384a, emissive: 0x183f55, emissiveIntensity: 0.32, opacity: 0.68,
    }),
    amber: material(0x50341b, 'polymer', {
      emissive: 0xff9f40, emissiveIntensity: 2.1,
    }),
    red: material(0x3b1714, 'polymer', {
      emissive: 0xff4c32, emissiveIntensity: 2.2,
    }),
  };
}

function addPad(group, mats, radius = 42) {
  const pad = mesh(new THREE.CylinderGeometry(radius, radius * 1.06, 3.2, 32), mats.dark, group);
  const inset = mesh(new THREE.RingGeometry(radius * 0.36, radius * 0.82, 48), mats.amber, group);
  inset.rotation.x = -Math.PI / 2;
  inset.position.y = 1.7;
  group.userData.landingPad = pad;
}

function addTruss(group, mats, length, radius = 5) {
  const truss = mesh(new THREE.CylinderGeometry(radius, radius, length, 8), mats.hull, group);
  truss.rotation.z = Math.PI / 2;
  return truss;
}

// Build an open-front command/habitation pavilion furnished with Golden Hour
// interior items so outposts feel inhabited up close.
function buildCommandPavilion(parent, mats, colliders, x, y, z, yaw = 0) {
  const bay = new THREE.Group();
  bay.name = 'command-pavilion';
  bay.position.set(x, y, z);
  bay.rotation.y = yaw;
  parent.add(bay);

  // Foundation plinth, floor slab, roof canopy, rear wall, and corner columns (front left open for walk-in)
  mesh(new THREE.BoxGeometry(11.4, 2.8, 7.4), mats.dark, bay, new THREE.Vector3(0, -1.4, 0));
  mesh(new THREE.BoxGeometry(11.6, 0.36, 7.6), mats.dark, bay, new THREE.Vector3(0, 0.18, 0));
  mesh(new THREE.BoxGeometry(12.0, 0.34, 8.0), mats.hull, bay, new THREE.Vector3(0, 3.65, 0));
  mesh(new THREE.BoxGeometry(11.4, 3.3, 0.24), mats.ceramic, bay, new THREE.Vector3(0, 1.85, -3.65));
  mesh(new THREE.BoxGeometry(0.24, 3.3, 7.4), mats.ceramic, bay, new THREE.Vector3(-5.65, 1.85, 0));
  mesh(new THREE.BoxGeometry(10.6, 0.12, 0.16), mats.amber, bay, new THREE.Vector3(0, 3.42, 3.72));
  for (const [cx, cz] of [[-5.6, 3.6], [5.6, 3.6], [5.6, -3.6]]) {
    mesh(new THREE.BoxGeometry(0.32, 3.3, 0.32), mats.hull, bay, new THREE.Vector3(cx, 1.85, cz));
  }

  const furn = getOutpostFurniture();
  const baseY = 0.36;
  placeProp(bay, null, furn, 'desk', -2.6, baseY, -2.1, 0);
  placeProp(bay, null, furn, 'officeChair', -2.6, baseY, -1.1, Math.PI);
  placeProp(bay, null, furn, 'laptop', -2.4, baseY + 0.76, -2.15, 0.15);
  placeProp(bay, null, furn, 'conferenceTable', 1.8, baseY, -1.6, 0);
  placeProp(bay, null, furn, 'diningChair', 0.9, baseY, -0.7, Math.PI * 0.9);
  placeProp(bay, null, furn, 'diningChair', 2.7, baseY, -0.7, -Math.PI * 0.9);
  placeProp(bay, null, furn, 'shelfRack', -4.8, baseY, 0.6, Math.PI * 0.5);
  placeProp(bay, null, furn, 'fridge', 4.6, baseY, -2.5, -Math.PI * 0.5);
  placeProp(bay, null, furn, 'sofa', -2.2, baseY, 1.8, Math.PI * 0.5);
  placeProp(bay, null, furn, 'floorLamp', -4.4, baseY, -2.6, 0);
  placeProp(bay, null, furn, 'extinguisher', 5.2, baseY, 3.1, 0);
  placeProp(bay, null, furn, 'serviceTrolley', 3.6, baseY, 1.6, -0.4);
  placeProp(bay, null, furn, 'luggageCart', 4.6, baseY, 2.5, 0.3);

  if (colliders) {
    // Rear & side wall colliders in outpost space
    colliders.push({ name: 'pavilion_slab', x, y, z, yaw, hw: 5.8, h: 0.36, hd: 3.8, walkableTop: true, surface: 'metal' });
  }
  return bay;
}

function dressOutpostYard(group, mats, site, padRadius = 28) {
  const rand = makeRng(`${site.seed}:saltline-props`);
  const props = getOutpostProps();
  const colliders = [];
  const deckY = 1.6;
  const palette = site.type === 'mining-outpost' ? 'industrial' : 'frontier';

  // Apron lighting masts, guard booth, and perimeter safety barriers around the pad
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI * 0.5 + Math.PI * 0.25;
    const r = padRadius + 4.5;
    placeProp(group, colliders, props, 'light_mast', Math.cos(a) * r, 0, Math.sin(a) * r, -a, { seed: i + 1, palette });
    placeProp(group, colliders, props, 'bollard_post', Math.cos(a + 0.16) * (padRadius + 1.5), deckY, Math.sin(a + 0.16) * (padRadius + 1.5), 0, { palette: 'halcyon' });
  }
  placeProp(group, colliders, props, 'guard_booth', padRadius + 7.5, 0, -5.5, -Math.PI * 0.5, { seed: 11, palette: 'halcyon' });
  placeProp(group, colliders, props, 'gate_arm', padRadius + 7.5, 0, 1.2, -Math.PI * 0.5, { seed: 12, palette });
  placeProp(group, colliders, props, 'generator', padRadius + 11, 0, -11.5, 0.2, { seed: 13, palette });
  placeProp(group, colliders, props, 'forklift', -(padRadius + 8.5), 0, 6.0, 0.85, { seed: 14, palette });

  // Cargo yard ring (containers, totes, crates, barrels, sandbags, floodlights)
  const yardPool = [
    'container20', 'container40', 'reefer_unit', 'ibc_tote', 'crate_stack',
    'pallet_stack', 'tarp_cargo', 'barrel', 'gas_cylinders', 'sandbags',
    'cable_reel', 'toolbox_cart', 'floodlight_stand', 'relay_node', 'jersey_barrier',
  ];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + (rand() - 0.5) * 0.18;
    // Leave an open approach lane at +Z
    if (Math.abs(Math.atan2(Math.sin(a), Math.cos(a)) - Math.PI * 0.5) < 0.24) continue;
    const dist = padRadius + 11 + rand() * 24;
    const pick = yardPool[Math.floor(rand() * yardPool.length)];
    placeProp(group, colliders, props, pick, Math.cos(a) * dist, 0, Math.sin(a) * dist, -a + Math.PI * 0.5, {
      seed: 20 + i,
      palette: i % 4 === 0 ? 'halcyon' : palette,
    });
  }

  // Site-specific Saltline megastructure landmark
  if (site.type === 'relay-outpost') {
    placeProp(group, colliders, props, 'comms_tower', -46, 0, -34, 0.4, { seed: 71, palette: 'halcyon' });
    placeProp(group, colliders, props, 'relay_node', -38, 0, -28, 0.6, { seed: 72, palette: 'halcyon' });
  } else if (site.type === 'mining-outpost') {
    placeProp(group, colliders, props, 'rtg_crane', 48, 0, -32, 0.3, { seed: 81, palette: 'industrial' });
    placeProp(group, colliders, props, 'pipe_stack', 38, 0, -18, 0.3, { seed: 82, palette: 'industrial' });
    placeProp(group, colliders, props, 'dumpster', 34, 0, -24, -0.5, { seed: 83, palette: 'industrial' });
  } else {
    placeProp(group, colliders, props, 'comms_tower', 46, 0, -34, -0.3, { seed: 91, palette: 'frontier' });
  }

  // Furnished walk-in Command & Habitation Pavilion
  buildCommandPavilion(group, mats, colliders, 0, 0, -(padRadius + 13), 0);
  group.userData.propColliders = colliders;
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
  // Dress the hero city's spaceport apron with Saltline cranes & cargo stacks
  const props = getOutpostProps();
  const colliders = [];
  const padR = 52 * scale;
  placeProp(group, colliders, props, 'port_crane', padR + 28, 1.5, -24, 0.4, { seed: 301, palette: 'halcyon' });
  placeProp(group, colliders, props, 'comms_tower', -(padR + 24), 1.5, -28, -0.3, { seed: 302, palette: 'halcyon' });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2;
    placeProp(group, colliders, props, i % 2 === 0 ? 'container40' : 'light_mast',
      Math.cos(a) * (padR + 12), 1.5, Math.sin(a) * (padR + 12), -a, { seed: 310 + i, palette: 'halcyon' });
  }
  buildCommandPavilion(group, mats, colliders, 0, 1.5, -(padR + 14), 0);
  group.userData.propColliders = colliders;
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
  const deckTopY = deckRadius * 0.06;
  mesh(new THREE.CylinderGeometry(deckRadius, deckRadius * 0.9, deckRadius * 0.12, 48), mats.dark, group);
  mesh(new THREE.TorusGeometry(deckRadius * 0.78, deckRadius * 0.07, 12, 72), mats.hull, group).rotation.x = Math.PI / 2;
  const padR = deckRadius * 0.24;
  addPad(group, mats, padR);
  for (let i = 0; i < 12; i++) {
    const angle = i * Math.PI * 2 / 12;
    const radial = deckRadius * (0.48 + rand() * 0.18);
    const height = deckRadius * (0.3 + rand() * 0.9);
    const tower = mesh(new THREE.CylinderGeometry(deckRadius * 0.035, deckRadius * 0.065, height, 8),
      i % 3 === 0 ? mats.glass : mats.ceramic, group,
      new THREE.Vector3(Math.cos(angle) * radial, height / 2 + deckTopY, Math.sin(angle) * radial));
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
  // Dress the aerostat flight deck with Saltline & Golden Hour props
  const props = getOutpostProps();
  const furn = getOutpostFurniture();
  const colliders = [];
  placeProp(group, colliders, props, 'comms_tower', padR + 18, deckTopY, -16, 0.3, { seed: 401, palette: 'halcyon' });
  placeProp(group, colliders, props, 'guard_booth', padR + 8, deckTopY, 6, -Math.PI * 0.5, { seed: 402, palette: 'halcyon' });
  placeProp(group, colliders, props, 'forklift', -(padR + 9), deckTopY, 8, 0.9, { seed: 403, palette: 'halcyon' });
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + 0.4;
    placeProp(group, colliders, props, i % 2 === 0 ? 'light_mast' : 'container20',
      Math.cos(a) * (padR + 11), deckTopY, Math.sin(a) * (padR + 11), -a, { seed: 410 + i, palette: 'halcyon' });
  }
  // Aerostat terrace lounge
  for (let i = -1; i <= 1; i++) {
    placeProp(group, null, furn, 'sunLounger', i * 3.2, deckTopY, padR + 10, Math.PI);
    placeProp(group, null, furn, 'planter', i * 4.5, deckTopY, padR + 7.5, 0);
  }
  placeProp(group, null, furn, 'parasol', 0, deckTopY, padR + 10.5, 0);
  buildCommandPavilion(group, mats, colliders, 0, deckTopY, -(padR + 12), 0);
  group.userData.propColliders = colliders;

  group.userData.materials = Object.values(mats);
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
  dressOutpostYard(group, mats, site, 28);
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
    if (object.geometry && !object.geometry.userData?.sharedPropAsset) geometries.add(object.geometry);
    const list = Array.isArray(object.material) ? object.material : object.material ? [object.material] : [];
    for (const mat of list) {
      if (mat.userData?.sharedPropAsset) continue;
      materials.add(mat);
      for (const value of Object.values(mat)) if (value?.isTexture) textures.add(value);
    }
  });
  textures.forEach((texture) => texture.dispose());
  materials.forEach((mat) => mat.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}
