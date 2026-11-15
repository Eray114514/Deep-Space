// HALCYON VII, as authored in Blender (tools/blender/build_halcyon.py).
//
// The hull, flight deck and cabin are modelled, bevelled and baked offline and
// arrive as one meshopt-compressed GLB.  This module turns that file into the
// same { ext, int } contract the procedural builders used to return, so the
// flight model, ship view, ramp, engine FX and radiance zones are untouched:
//
//   ext.group / ext.rampPivot / ext.plumes / ext.glowRings / ext.strobes / ext.gear
//   int.group / int.barrier / int.lights / int.cockpit { group, holo, glass, screens }
//
// Node contract with the exporter is documented in tools/blender/halcyon/export.py.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { screenTexture } from '../textures.js';
import { makeCanopyGlass, bindGlass } from './cockpit/glass.js';
import { buildInstruments } from './cockpit/holo.js';
import {
  barrierMaterial, haloMaterial, nozzleGlowGeometry, plumeGeometry, plumeMaterial,
} from './fx.js';
import { createSurfaceLibrary } from './surfaces.js';

export const SHIP_MODEL_URL = '/assets/halcyon/halcyon.glb';

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

export function loadShipModel(url = SHIP_MODEL_URL) {
  return loader.loadAsync(url);
}

/* the bell lip sits this many radii aft of the engine node (see build_engine) */
const BELL_LIP = 0.625;
const SCREEN_KIND = { radar: 0, attitude: 1, nav: 2, systems: 3, comms: 4 };

/* Cabin fixtures.  Positions follow the lamps modelled in Blender, so the
   dynamic highlights land where the emissive strips are. */
const CABIN_LIGHTS = [
  [0, 1.95, -8.1, 0xffd9b0, 2.6, 4.2],
  [0, 1.15, -9.05, 0x8fd0ff, 1.5, 3.0],
  [0, 2.02, -4.1, 0xffdcb4, 5.2, 6.0],
  [0, 2.02, -2.3, 0xffdcb4, 5.2, 6.0],
  [0, 2.32, 1.0, 0xdfeaff, 6.0, 7.0],
  [0, 2.32, 3.8, 0xdfeaff, 6.0, 7.0],
  [0, 1.3, 6.7, 0x66aaff, 6.0, 5.0],
];

const lamp = (a, b, hexColor, gain, sig) => ({
  a: new THREE.Vector3(...a),
  b: new THREE.Vector3(...b),
  c: new THREE.Color(hexColor).convertSRGBToLinear().multiplyScalar(gain),
  sig,
});

/* what the canopy glass reflects: the panel flood strip, the overhead spots
   and the three main displays */
const CANOPY_LAMPS = [
  lamp([-0.75, 1.03, -9.27], [0.75, 1.03, -9.27], 0xfff0da, 0.16, 0.20),
  lamp([-0.30, 2.0, -8.14], [0.30, 2.0, -8.14], 0xffd7b0, 0.9, 0.07),
  lamp([-0.8, 0.83, -9.17], [0.8, 0.83, -9.17], 0x7fd8ff, 0.22, 0.16),
];

/* Baked cabin light arrives as sqrt(E / 8) in 8 bits (tools/blender/halcyon/bake.py). */
const IRRADIANCE_RANGE = 8;
const IRRADIANCE_GAIN = 0.40;

function prepareBakedLight(geometry) {
  const baked = geometry.getAttribute('_irradiance');
  if (!baked) return false;
  const values = new Float32Array(baked.count * 3);
  for (let i = 0; i < baked.count; i++) {
    const r = baked.getX(i), g = baked.getY(i), b = baked.getZ(i);
    values[i * 3] = r * r * IRRADIANCE_RANGE * IRRADIANCE_GAIN;
    values[i * 3 + 1] = g * g * IRRADIANCE_RANGE * IRRADIANCE_GAIN;
    values[i * 3 + 2] = b * b * IRRADIANCE_RANGE * IRRADIANCE_GAIN;
  }
  geometry.setAttribute('aCabinIrradiance', new THREE.BufferAttribute(values, 3));
  geometry.deleteAttribute('_irradiance');
  return true;
}

function preparePaint(geometry) {
  const color = geometry.getAttribute('color');
  if (color) {
    geometry.setAttribute('aPaint', color);
    geometry.deleteAttribute('color');
  } else if (!geometry.getAttribute('aPaint')) {
    const count = geometry.getAttribute('position').count;
    const data = new Uint8Array(count * 4);
    for (let i = 0; i < count; i++) data.set([128, 0, 0, 255], i * 4);
    geometry.setAttribute('aPaint', new THREE.BufferAttribute(data, 4, true));
  }
}

export function assembleShip(gltf, def) {
  const surface = createSurfaceLibrary();
  const root = gltf.scene;
  const take = (name) => {
    const node = root.getObjectByName(name);
    if (!node) throw new Error(`halcyon.glb is missing node "${name}"`);
    return node;
  };

  const strobes = [];
  const glassPanes = [];
  let glass = null;
  let bakedLight = false;
  const glassMaterial = makeCanopyGlass(CANOPY_LAMPS, {
    spanU: 2.6, spanV: 2.0, rim: 0.30, envGain: 0.92,
    lamp: 1.15, cover: 0.23, coverLum: 0.76, sheen: 1.12,
  });
  root.traverse((object) => {
    if (!object.isMesh) return;
    const name = object.material?.name || '';
    if (name === 'glass') {
      object.material = glassMaterial;
      object.renderOrder = 6;
      bindGlass(object, glassMaterial);
      glassPanes.push(object);
      if (!glass || object.geometry.getAttribute('position').count
        > glass.geometry.getAttribute('position').count) glass = object;
      return;
    }
    preparePaint(object.geometry);
    if (prepareBakedLight(object.geometry)) bakedLight = true;
    if (object.material?.isMeshStandardMaterial) object.material = surface(object.material);
    const emissive = object.material.emissiveIntensity > 0 && object.material.color.r < 0.05;
    object.castShadow = !emissive;
    object.receiveShadow = !emissive;
    if (name === 'strobe') strobes.push(object);
  });
  if (glass) glass.name = 'canopy-glazing';
  /* Seen from the seat the canopy must stay out of the way; seen from outside
     it is a dark, coated, reflective shell.  So the pane is drawn twice: the
     cockpit shader on its inner face only, and a tinted coat on the outer. */
  glassMaterial.side = THREE.BackSide;
  const glassCoat = new THREE.MeshPhysicalMaterial({
    name: 'glass-coat', color: 0x06090d, metalness: 0.0, roughness: 0.05,
    transparent: true, opacity: 0.80, depthWrite: false, side: THREE.FrontSide,
    envMapIntensity: 1.6, clearcoat: 1, clearcoatRoughness: 0.03,
  });
  for (const pane of glassPanes) {
    const coat = new THREE.Mesh(pane.geometry, glassCoat);
    coat.name = 'canopy-coat';
    coat.renderOrder = 7;
    pane.parent.add(coat);
  }

  /* ------------------------------------------------------------ exterior */
  const extGroup = new THREE.Group();
  extGroup.name = 'exterior';
  extGroup.add(take('exterior'));
  const rampPivot = take('ramp');
  extGroup.add(rampPivot);
  const gear = ['gear-nose', 'gear-main-stbd', 'gear-main-port'].map((name) => {
    const node = take(name);
    node.userData.deployedY = node.position.y;
    extGroup.add(node);
    return node;
  });

  const engines = [];
  for (let i = 0; ; i++) {
    const node = root.getObjectByName(`engine-${i}`);
    if (!node) break;
    engines.push({ x: node.position.x, y: node.position.y, z: node.position.z, r: node.scale.x });
  }
  const plumeRoot = (engine) => new THREE.Vector3(
    engine.x, engine.y, engine.z + engine.r * (BELL_LIP - 0.01));
  const plumeRotation = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  const instanceMatrix = new THREE.Matrix4();
  const instanceScale = new THREE.Vector3();
  const addInstances = (geometry, material, name, order, inThroat = false) => {
    const mesh = new THREE.InstancedMesh(geometry, material, engines.length);
    mesh.name = name;
    mesh.renderOrder = order;
    mesh.frustumCulled = false;
    engines.forEach((engine, index) => {
      const origin = inThroat
        ? new THREE.Vector3(engine.x, engine.y, engine.z + engine.r * (BELL_LIP + 0.025))
        : plumeRoot(engine);
      instanceScale.setScalar(engine.r);
      instanceMatrix.compose(origin, inThroat ? new THREE.Quaternion() : plumeRotation, instanceScale);
      mesh.setMatrixAt(index, instanceMatrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.userData.nozzleRoots = engines.map((engine) => plumeRoot(engine).toArray());
    mesh.userData.engineRadii = engines.map((engine) => engine.r);
    extGroup.add(mesh);
    return mesh;
  };
  const plumes = [addInstances(plumeGeometry(), plumeMaterial(), 'engine-plume-volume', 3)];
  const glowRings = [addInstances(nozzleGlowGeometry(), haloMaterial(), 'engine-plume-throat', 5, true)];

  /* ------------------------------------------------------------ interior */
  const intGroup = new THREE.Group();
  intGroup.name = 'interior';
  intGroup.add(take('interior'));

  const cockpitGroup = new THREE.Group();
  cockpitGroup.name = 'cockpit';
  cockpitGroup.add(take('cockpit'));
  intGroup.add(cockpitGroup);

  const screenMaterials = [0, 1, 2, 3, 4, 5].map((kind) => {
    const texture = screenTexture(kind);
    return new THREE.MeshStandardMaterial({
      name: `screen-${kind}`,
      map: texture, emissiveMap: texture, emissive: 0xffffff, emissiveIntensity: 2.4,
      color: 0x000000, metalness: 0, roughness: 0.9,
    });
  });
  const screens = [];
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (const child of [...root.children]) {
    const match = /^mfd-(\d+)-(\w+)$/.exec(child.name);
    if (!match) continue;
    const kind = SCREEN_KIND[match[2]] ?? Number(match[1]);
    child.traverse((object) => {
      if (!object.isMesh) return;
      object.material = screenMaterials[kind % screenMaterials.length];
      object.castShadow = false;
      object.receiveShadow = false;
    });
    child.updateMatrix();
    child.matrix.decompose(position, quaternion, scale);
    screens.push({
      m: new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1)),
      w: scale.x, h: scale.z, kind,
      role: match[2] === 'attitude' ? 'mfd-centre' : match[2] === 'systems' ? 'pedestal' : `mfd-${match[2]}`,
    });
    cockpitGroup.add(child);
  }
  const holo = buildInstruments(screens);
  cockpitGroup.add(holo.group);

  const lights = [];
  const fixtureGain = bakedLight ? 0.22 : 1;
  for (const [x, y, z, color, intensity, distance] of CABIN_LIGHTS) {
    const light = new THREE.PointLight(color, intensity * fixtureGain, distance, 2);
    light.position.set(x, y, z);
    intGroup.add(light);
    lights.push(light);
  }
  /* two downward casters put the seat, consoles and crates ON the deck */
  for (const [x, y, z, color, intensity, distance, angle] of [
    [0, 2.20, -7.30, 0xffe6c8, 9.0, 4.4, 0.95],
    [0, 2.44, 2.60, 0xdfeaff, 12.0, 5.2, 1.05],
  ]) {
    if (bakedLight) break;
    const light = new THREE.SpotLight(color, intensity, distance, angle, 0.55, 2);
    light.position.set(x, y, z);
    light.target.position.set(x, 0, z);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 0.3;
    light.shadow.camera.far = distance;
    light.shadow.bias = -0.0009;
    light.shadow.normalBias = 0.022;
    intGroup.add(light, light.target);
  }

  const dims = def.dims;
  const barrier = new THREE.Mesh(
    new THREE.PlaneGeometry(dims.rampHalfW * 2 - 0.10, dims.rampTopY - 0.10, 1, 1),
    barrierMaterial(),
  );
  barrier.position.set(0, dims.rampTopY / 2, dims.holdEndZ - 0.07);
  barrier.renderOrder = 8;
  barrier.frustumCulled = false;
  intGroup.add(barrier);

  return {
    ext: { group: extGroup, rampPivot, plumes, glowRings, strobes, gear, engines },
    bakedLight,
    int: {
      group: intGroup, barrier, lights,
      cockpit: { group: cockpitGroup, holo, glass, screens, lights: [] },
    },
    mats: { ...Object.fromEntries(surface.materials), screens: screenMaterials, glass: glassMaterial },
  };
}
