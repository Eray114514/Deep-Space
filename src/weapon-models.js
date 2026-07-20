import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const SHARED_MATERIALS = createMaterials();

function createMaterials() {
  const graphite = new THREE.MeshStandardMaterial({
    color: 0x15191b,
    metalness: 0.82,
    roughness: 0.3,
  });
  const blackPolymer = new THREE.MeshStandardMaterial({
    color: 0x0a0c0d,
    metalness: 0.12,
    roughness: 0.72,
  });
  const gunmetal = new THREE.MeshStandardMaterial({
    color: 0x343a3c,
    metalness: 0.93,
    roughness: 0.2,
  });
  const edgeMetal = new THREE.MeshStandardMaterial({
    color: 0x626b6d,
    metalness: 0.95,
    roughness: 0.18,
  });
  const tan = new THREE.MeshStandardMaterial({
    color: 0x6b6250,
    metalness: 0.15,
    roughness: 0.64,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: 0xc6ff38,
    emissive: 0x1e2e03,
    emissiveIntensity: 0.45,
    metalness: 0.28,
    roughness: 0.36,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xb58a3b,
    metalness: 0.9,
    roughness: 0.24,
  });
  const lens = new THREE.MeshPhysicalMaterial({
    color: 0x8acbd4,
    metalness: 0,
    roughness: 0.05,
    transmission: 0.88,
    transparent: true,
    opacity: 0.34,
    thickness: 0.008,
    ior: 1.48,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const lensAmber = lens.clone();
  lensAmber.color.setHex(0xc4a96a);
  lensAmber.opacity = 0.28;
  const rubber = new THREE.MeshStandardMaterial({
    color: 0x050607,
    metalness: 0.02,
    roughness: 0.92,
  });
  return { graphite, blackPolymer, gunmetal, edgeMetal, tan, accent, brass, lens, lensAmber, rubber };
}

function box(
  parent,
  size,
  position,
  material,
  radius = 0.012,
  rotation = [0, 0, 0],
) {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(size[0], size[1], size[2], 3, Math.min(radius, ...size.map((v) => v / 3))),
    material,
  );
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function cylinderZ(
  parent,
  radius,
  length,
  position,
  material,
  radialSegments = 24,
) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function openCylinderZ(
  parent,
  radius,
  length,
  position,
  material,
  radialSegments = 32,
) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, radialSegments, 1, true), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.set(...position);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

function screw(
  parent,
  position,
  material,
  side = 1,
) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.006, 12), material);
  mesh.rotation.z = Math.PI / 2;
  mesh.position.set(position[0] * side, position[1], position[2]);
  mesh.castShadow = true;
  parent.add(mesh);
  const slot = box(
    parent,
    [0.004, 0.003, 0.016],
    [position[0] * side + 0.004 * side, position[1], position[2]],
    material,
    0.001,
  );
  slot.rotation.z = Math.PI / 2;
}

function rail(parent, z, count, spacing, material, y) {
  box(parent, [0.075, 0.015, count * spacing + 0.02], [0, y - 0.01, z], material, 0.003);
  for (let i = 0; i < count; i += 1) {
    box(parent, [0.108, 0.027, 0.026], [0, y, z - ((count - 1) * spacing) / 2 + i * spacing], material, 0.004);
  }
}

function vent(parent, x, y, z, material, rot = 0) {
  const cut = box(parent, [0.012, 0.036, 0.1], [x, y, z], material, 0.005, [rot, 0, 0]);
  cut.scale.z = 1;
  return cut;
}

function triggerAssembly(parent, z, mats) {
  const guard = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.009, 8, 22, Math.PI), mats.graphite);
  guard.position.set(0, -0.185, z);
  guard.rotation.set(0, Math.PI / 2, 0);
  guard.scale.y = 0.72;
  parent.add(guard);
  const trigger = box(parent, [0.012, 0.07, 0.015], [0, -0.168, z - 0.012], mats.edgeMetal, 0.004, [-0.28, 0, 0]);
  trigger.castShadow = true;
}

function buildHoloSight(parent, z, y, mats, compact = false) {
  const sight = new THREE.Group();
  sight.position.set(0, y, z);
  parent.add(sight);
  const width = compact ? 0.105 : 0.13;
  const height = compact ? 0.085 : 0.12;
  box(sight, [width, 0.035, 0.15], [0, 0, 0.015], mats.graphite, 0.009);
  box(sight, [0.025, height, 0.045], [-width / 2 + 0.01, height / 2, -0.02], mats.graphite, 0.007);
  box(sight, [0.025, height, 0.045], [width / 2 - 0.01, height / 2, -0.02], mats.graphite, 0.007);
  box(sight, [width, 0.022, 0.045], [0, height, -0.02], mats.graphite, 0.006);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(width - 0.043, height - 0.025), mats.lens);
  glass.position.set(0, height / 2 + 0.012, -0.022);
  sight.add(glass);
  const reticleMaterial = new THREE.LineBasicMaterial({ color: 0xcaff4a, transparent: true, opacity: 0.72 });
  const curve = new THREE.EllipseCurve(0, 0, 0.015, 0.015, 0, Math.PI * 2);
  const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(curve.getPoints(30)), reticleMaterial);
  ring.position.set(0, height / 2 + 0.012, -0.024);
  sight.add(ring);
  screw(sight, [width / 2 + 0.002, 0.012, 0.018], mats.edgeMetal);
  const weapon = parent;
  weapon.userData.opticGlass = glass;
  weapon.userData.aimPoint = new THREE.Vector3(0, y + height / 2 + 0.012, z - 0.024);
  return sight;
}

function buildScope(parent, z, y, mats) {
  const scope = new THREE.Group();
  scope.position.set(0, y, z);
  parent.add(scope);
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.061, 0.061, 0.44, 32, 1, true), mats.graphite);
  body.rotation.x = Math.PI / 2;
  scope.add(body);
  // Both ocular housings are open tubes. The lens surfaces remain visibly transparent.
  openCylinderZ(scope, 0.078, 0.09, [0, 0, -0.23], mats.graphite, 32);
  openCylinderZ(scope, 0.07, 0.08, [0, 0, 0.225], mats.rubber, 32);
  for (const [radius, ringZ] of [[0.078, -0.276], [0.07, 0.266]]) {
    const rim = new THREE.Mesh(new THREE.TorusGeometry(radius - 0.006, 0.006, 8, 32), mats.edgeMetal);
    rim.position.z = ringZ;
    scope.add(rim);
  }
  for (const ringZ of [-0.13, 0.11]) {
    cylinderZ(scope, 0.069, 0.036, [0, 0, ringZ], mats.edgeMetal, 32);
    box(scope, [0.11, 0.065, 0.026], [0, -0.078, ringZ], mats.graphite, 0.006);
  }
  // Front lens is a faintly tinted protective window. The player never looks through it directly.
  const frontLens = new THREE.Mesh(
    new THREE.CircleGeometry(0.058, 48),
    new THREE.MeshPhysicalMaterial({
      color: 0xbfd7df,
      metalness: 0,
      roughness: 0.04,
      transmission: 0.9,
      transparent: true,
      opacity: 0.22,
      ior: 1.45,
      thickness: 0.004,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  frontLens.position.z = -0.277;
  scope.add(frontLens);

  // Use Three's built-in colour-managed map path for the live scope image.
  // A custom sampling shader bypassed the renderer/composer output contract
  // and turned otherwise valid render-target pixels into a black lens.
  const rearLensMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    side: THREE.DoubleSide,
    toneMapped: true,
    depthWrite: true,
  });
  const rearLens = new THREE.Mesh(new THREE.CircleGeometry(0.052, 64), rearLensMaterial);
  rearLens.position.z = 0.267;
  rearLens.renderOrder = 2;
  scope.add(rearLens);

  // Physical crosshair sits a hair in front of the lens so it reads as etched glass.
  const reticleOverlay = new THREE.Group();
  reticleOverlay.position.z = 0.27;
  reticleOverlay.renderOrder = 3;
  scope.add(reticleOverlay);
  const reticleMat = new THREE.LineBasicMaterial({ color: 0x0a0a0a, fog: false, toneMapped: false, transparent: true, opacity: 0.92 });
  const reticlePoints = [
    new THREE.Vector3(-0.05, 0, 0), new THREE.Vector3(-0.008, 0, 0),
    new THREE.Vector3(0.008, 0, 0), new THREE.Vector3(0.05, 0, 0),
    new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0, -0.008, 0),
    new THREE.Vector3(0, 0.008, 0), new THREE.Vector3(0, 0.05, 0),
  ];
  const reticleLines = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(reticlePoints), reticleMat);
  reticleOverlay.add(reticleLines);
  const reticleRing = new THREE.LineLoop(
    new THREE.BufferGeometry().setFromPoints(new THREE.EllipseCurve(0, 0, 0.016, 0.016, 0, Math.PI * 2).getPoints(48)),
    reticleMat,
  );
  reticleOverlay.add(reticleRing);
  const reticleDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.0025, 16),
    new THREE.MeshBasicMaterial({ color: 0x0a0a0a, fog: false, toneMapped: false }),
  );
  reticleOverlay.add(reticleDot);
  const elevation = cylinderZ(scope, 0.035, 0.055, [0, 0.08, -0.015], mats.graphite, 20);
  elevation.rotation.set(0, 0, 0);
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * Math.PI * 2;
    box(scope, [0.008, 0.012, 0.055], [Math.cos(a) * 0.035, 0.08 + Math.sin(a) * 0.035, -0.015], mats.edgeMetal, 0.002, [0, 0, a]);
  }
  const windage = cylinderZ(scope, 0.028, 0.05, [0.082, 0, -0.015], mats.graphite, 18);
  windage.rotation.set(0, 0, Math.PI / 2);
  const weapon = parent;
  weapon.userData.opticGlass = rearLens;
  weapon.userData.aimPoint = new THREE.Vector3(0, y, z + 0.267);
  return scope;
}

function addSelectorMarks(parent, z, mats) {
  const selector = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.024, 0.012, 18), mats.edgeMetal);
  selector.rotation.z = Math.PI / 2;
  selector.position.set(0.087, -0.045, z);
  parent.add(selector);
  box(parent, [0.016, 0.009, 0.052], [0.098, -0.034, z - 0.016], mats.edgeMetal, 0.002, [0.3, 0, 0]);
  for (let i = 0; i < 3; i += 1) {
    box(parent, [0.005, 0.005, 0.018], [0.099, -0.01 - i * 0.018, z - 0.065 + i * 0.01], mats.accent, 0.001);
  }
}

function createCarbine() {
  const mats = SHARED_MATERIALS;
  const gun = new THREE.Group();
  gun.name = "KX-9 Cerberus";
  gun.userData.muzzle = new THREE.Vector3(0, 0.04, -1.52);
  gun.userData.eject = new THREE.Vector3(0.12, 0.08, -0.16);

  // Upper and lower receivers use overlapping chamfered shells to catch edge light.
  box(gun, [0.19, 0.16, 0.48], [0, 0.015, -0.12], mats.graphite, 0.025);
  box(gun, [0.166, 0.13, 0.43], [0, 0.085, -0.14], mats.gunmetal, 0.012);
  box(gun, [0.158, 0.18, 0.29], [0, -0.09, 0.015], mats.blackPolymer, 0.022, [-0.05, 0, 0]);
  box(gun, [0.115, 0.042, 0.39], [0, 0.178, -0.14], mats.graphite, 0.008);
  rail(gun, -0.47, 15, 0.044, mats.graphite, 0.165);

  // Free-floating handguard, vent inserts, and independent barrel.
  box(gun, [0.158, 0.146, 0.66], [0, 0.055, -0.67], mats.graphite, 0.025);
  box(gun, [0.138, 0.122, 0.62], [0, 0.055, -0.68], mats.blackPolymer, 0.02);
  for (let i = 0; i < 5; i += 1) {
    const z = -0.48 - i * 0.11;
    vent(gun, 0.071, 0.055, z, mats.rubber);
    vent(gun, -0.071, 0.055, z, mats.rubber);
    box(gun, [0.048, 0.012, 0.076], [0, -0.01, z], mats.rubber, 0.005);
  }
  cylinderZ(gun, 0.027, 0.62, [0, 0.055, -1.12], mats.gunmetal, 28);
  cylinderZ(gun, 0.04, 0.12, [0, 0.055, -1.44], mats.graphite, 24);
  for (let i = 0; i < 4; i += 1) {
    box(gun, [0.086, 0.018, 0.025], [0, 0.055, -1.405 - i * 0.029], mats.rubber, 0.004, [0, 0, i % 2 ? Math.PI / 4 : 0]);
  }
  const muzzle = new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.016, 24), mats.rubber);
  muzzle.position.set(0, 0.055, -1.505);
  muzzle.rotation.x = Math.PI / 2;
  gun.add(muzzle);

  // Stock assembly has a visible buffer tube and two-piece cheek rest.
  cylinderZ(gun, 0.035, 0.55, [0, 0.075, 0.42], mats.edgeMetal, 20);
  box(gun, [0.15, 0.145, 0.35], [0, 0.045, 0.55], mats.blackPolymer, 0.025, [-0.08, 0, 0]);
  box(gun, [0.135, 0.05, 0.33], [0, 0.13, 0.5], mats.rubber, 0.016);
  box(gun, [0.145, 0.21, 0.055], [0, -0.015, 0.72], mats.rubber, 0.015);
  box(gun, [0.098, 0.035, 0.09], [0, -0.105, 0.55], mats.graphite, 0.008);

  const grip = box(gun, [0.13, 0.31, 0.15], [0, -0.275, 0.145], mats.blackPolymer, 0.025, [-0.18, 0, 0]);
  for (let i = 0; i < 5; i += 1) {
    box(grip, [0.134, 0.014, 0.11], [0, -0.08 - i * 0.052, 0.018], mats.rubber, 0.003, [0, 0, 0]);
  }
  triggerAssembly(gun, -0.02, mats);

  const magazine = new THREE.Group();
  magazine.position.set(0, -0.24, -0.12);
  gun.add(magazine);
  for (let i = 0; i < 5; i += 1) {
    box(magazine, [0.135, 0.075, 0.18], [0, -i * 0.064, i * 0.014], mats.graphite, 0.014, [-0.03 * i, 0, 0]);
  }
  box(magazine, [0.145, 0.035, 0.19], [0, -0.34, 0.065], mats.rubber, 0.009);
  for (let i = 0; i < 4; i += 1) {
    box(magazine, [0.01, 0.23, 0.012], [0.054 - i * 0.036, -0.16, 0.101], mats.edgeMetal, 0.002);
  }
  gun.userData.magazine = magazine;
  gun.userData.magazineHome = magazine.position.clone();

  const bolt = box(gun, [0.018, 0.064, 0.2], [0.098, 0.06, -0.13], mats.edgeMetal, 0.004);
  box(gun, [0.023, 0.045, 0.095], [0.11, 0.105, -0.03], mats.graphite, 0.005);
  gun.userData.bolt = bolt;
  addSelectorMarks(gun, 0.07, mats);
  for (const z of [-0.3, -0.12, 0.08]) screw(gun, [0.099, 0.04, z], mats.edgeMetal);
  buildHoloSight(gun, -0.23, 0.22, mats);
  gun.userData.aimDepth = -0.81;
  box(gun, [0.025, 0.05, 0.085], [0.075, 0.155, -0.75], mats.accent, 0.005);
  return gun;
}

function createMarksman() {
  const mats = SHARED_MATERIALS;
  const gun = new THREE.Group();
  gun.name = "M77 Sentinel";
  gun.userData.muzzle = new THREE.Vector3(0, 0.075, -1.78);
  gun.userData.eject = new THREE.Vector3(0.13, 0.105, -0.12);

  box(gun, [0.205, 0.18, 0.58], [0, 0.03, -0.1], mats.gunmetal, 0.028);
  box(gun, [0.184, 0.13, 0.51], [0, 0.105, -0.12], mats.graphite, 0.016);
  box(gun, [0.18, 0.19, 0.32], [0, -0.09, 0.04], mats.tan, 0.024);
  rail(gun, -0.3, 13, 0.052, mats.graphite, 0.202);
  box(gun, [0.185, 0.17, 0.79], [0, 0.072, -0.78], mats.tan, 0.028);
  box(gun, [0.16, 0.143, 0.75], [0, 0.072, -0.79], mats.blackPolymer, 0.022);
  for (let i = 0; i < 6; i += 1) {
    const z = -0.48 - i * 0.115;
    vent(gun, 0.078, 0.075, z, mats.rubber);
    vent(gun, -0.078, 0.075, z, mats.rubber);
    box(gun, [0.055, 0.015, 0.086], [0, -0.008, z], mats.rubber, 0.005);
  }
  rail(gun, -0.83, 15, 0.047, mats.graphite, 0.178);
  cylinderZ(gun, 0.031, 0.78, [0, 0.075, -1.36], mats.gunmetal, 30);
  cylinderZ(gun, 0.048, 0.16, [0, 0.075, -1.7], mats.graphite, 30);
  for (let i = 0; i < 3; i += 1) {
    box(gun, [0.105, 0.019, 0.04], [0, 0.075, -1.65 - i * 0.046], mats.rubber, 0.004, [0, 0, i * Math.PI / 3]);
  }

  // Precision stock with an adjustable cheek riser and monopod rail.
  cylinderZ(gun, 0.04, 0.45, [0, 0.09, 0.4], mats.edgeMetal, 24);
  box(gun, [0.18, 0.22, 0.48], [0, 0.005, 0.55], mats.tan, 0.035, [-0.04, 0, 0]);
  box(gun, [0.16, 0.06, 0.38], [0, 0.155, 0.48], mats.rubber, 0.018);
  box(gun, [0.18, 0.245, 0.065], [0, -0.03, 0.78], mats.rubber, 0.02);
  box(gun, [0.075, 0.035, 0.19], [0, -0.14, 0.55], mats.graphite, 0.008);
  const cheekKnob = new THREE.Mesh(new THREE.CylinderGeometry(0.027, 0.027, 0.205, 18), mats.edgeMetal);
  cheekKnob.rotation.z = Math.PI / 2;
  cheekKnob.position.set(0, 0.095, 0.56);
  gun.add(cheekKnob);

  box(gun, [0.14, 0.32, 0.16], [0, -0.28, 0.17], mats.blackPolymer, 0.028, [-0.2, 0, 0]);
  triggerAssembly(gun, -0.01, mats);
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.25, -0.12);
  gun.add(magazine);
  box(magazine, [0.16, 0.31, 0.24], [0, -0.11, 0.01], mats.graphite, 0.02, [-0.08, 0, 0]);
  box(magazine, [0.17, 0.035, 0.25], [0, -0.27, 0.025], mats.rubber, 0.009);
  for (let i = 0; i < 5; i += 1) {
    box(magazine, [0.012, 0.25, 0.012], [-0.056 + i * 0.028, -0.11, 0.135], mats.edgeMetal, 0.002);
  }
  gun.userData.magazine = magazine;
  gun.userData.magazineHome = magazine.position.clone();

  const bolt = box(gun, [0.022, 0.076, 0.24], [0.112, 0.08, -0.08], mats.edgeMetal, 0.005);
  box(gun, [0.028, 0.055, 0.13], [0.125, 0.135, 0.06], mats.graphite, 0.006);
  gun.userData.bolt = bolt;
  for (const z of [-0.31, -0.08, 0.14]) screw(gun, [0.108, 0.035, z], mats.edgeMetal);
  addSelectorMarks(gun, 0.11, mats);
  buildScope(gun, -0.24, 0.315, mats);
  gun.userData.aimDepth = -0.51;
  return gun;
}

function buildMicroDotSight(parent, z, y, mats) {
  const optic = new THREE.Group();
  optic.position.set(0, y, z);
  parent.add(optic);
  box(optic, [0.118, 0.025, 0.105], [0, 0, 0], mats.graphite, 0.006);
  box(optic, [0.024, 0.09, 0.052], [-0.047, 0.045, 0.01], mats.graphite, 0.006);
  box(optic, [0.024, 0.09, 0.052], [0.047, 0.045, 0.01], mats.graphite, 0.006);
  box(optic, [0.112, 0.018, 0.052], [0, 0.086, 0.01], mats.graphite, 0.005);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(0.07, 0.066), mats.lens);
  glass.position.set(0, 0.048, 0.038);
  optic.add(glass);
  const dot = new THREE.Mesh(
    new THREE.CircleGeometry(0.006, 16),
    new THREE.MeshBasicMaterial({ color: 0xcaff4a, transparent: true, opacity: 0.92, depthWrite: false }),
  );
  dot.position.set(0, 0.048, 0.04);
  optic.add(dot);
  const weapon = parent;
  weapon.userData.opticGlass = glass;
  weapon.userData.aimPoint = new THREE.Vector3(0, y + 0.048, z + 0.04);
  return optic;
}

function createSubmachineGun() {
  const mats = SHARED_MATERIALS;
  const gun = new THREE.Group();
  gun.name = "CX-5 Marauder";
  gun.userData.muzzle = new THREE.Vector3(0, 0.055, -1.38);
  gun.userData.eject = new THREE.Vector3(0.122, 0.09, -0.19);

  // Compact roller-delayed pattern with a separate receiver shell, handguard, and telescoping stock.
  box(gun, [0.19, 0.18, 0.54], [0, 0.025, -0.11], mats.graphite, 0.025);
  box(gun, [0.17, 0.135, 0.47], [0, 0.09, -0.12], mats.gunmetal, 0.012);
  box(gun, [0.18, 0.18, 0.31], [0, -0.1, 0.01], mats.blackPolymer, 0.024);
  // Receiver/handguard collar hides the rounded-box seam that read as two
  // floating assemblies from the oblique hip-fire view.
  box(gun, [0.184, 0.152, 0.085], [0, 0.045, -0.37], mats.graphite, 0.018);
  rail(gun, -0.33, 12, 0.045, mats.graphite, 0.18);
  box(gun, [0.172, 0.145, 0.55], [0, 0.055, -0.65], mats.blackPolymer, 0.025);
  box(gun, [0.15, 0.118, 0.51], [0, 0.055, -0.66], mats.graphite, 0.018);
  for (let i = 0; i < 5; i += 1) {
    const z = -0.45 - i * 0.095;
    vent(gun, 0.079, 0.055, z, mats.rubber);
    vent(gun, -0.079, 0.055, z, mats.rubber);
    box(gun, [0.052, 0.013, 0.065], [0, -0.012, z], mats.rubber, 0.004);
  }
  cylinderZ(gun, 0.027, 0.58, [0, 0.055, -1.05], mats.gunmetal, 28);
  cylinderZ(gun, 0.043, 0.12, [0, 0.055, -1.34], mats.graphite, 24);
  for (let i = 0; i < 4; i += 1) {
    box(gun, [0.094, 0.015, 0.022], [0, 0.055, -1.3 - i * 0.025], mats.rubber, 0.004, [0, 0, i * Math.PI / 4]);
  }

  // Symmetric telescoping rails. The previous diagonal pair crossed the gun's
  // center line and visibly pierced the stock block.
  cylinderZ(gun, 0.018, 0.48, [-0.062, 0.065, 0.39], mats.edgeMetal, 16);
  cylinderZ(gun, 0.018, 0.48, [0.062, 0.065, 0.39], mats.edgeMetal, 16);
  box(gun, [0.17, 0.17, 0.3], [0, 0.02, 0.625], mats.blackPolymer, 0.03);
  box(gun, [0.18, 0.2, 0.055], [0, -0.02, 0.81], mats.rubber, 0.015);
  box(gun, [0.13, 0.045, 0.22], [0, 0.12, 0.59], mats.rubber, 0.012);

  box(gun, [0.14, 0.31, 0.16], [0, -0.28, 0.16], mats.blackPolymer, 0.028, [-0.18, 0, 0]);
  triggerAssembly(gun, -0.015, mats);
  const magazine = new THREE.Group();
  magazine.position.set(0, -0.215, -0.11);
  gun.add(magazine);
  box(magazine, [0.145, 0.42, 0.19], [0, -0.16, 0.02], mats.graphite, 0.018, [-0.04, 0, 0]);
  box(magazine, [0.16, 0.045, 0.22], [0, -0.37, 0.05], mats.rubber, 0.01);
  for (let i = 0; i < 6; i += 1) {
    box(magazine, [0.013, 0.31, 0.012], [-0.055 + i * 0.022, -0.15, 0.11], mats.edgeMetal, 0.002);
  }
  gun.userData.magazine = magazine;
  gun.userData.magazineHome = magazine.position.clone();
  const bolt = box(gun, [0.022, 0.07, 0.22], [0.11, 0.075, -0.13], mats.edgeMetal, 0.004);
  box(gun, [0.032, 0.055, 0.11], [0.12, 0.12, -0.02], mats.graphite, 0.005);
  gun.userData.bolt = bolt;
  addSelectorMarks(gun, 0.08, mats);
  for (const z of [-0.28, -0.06, 0.16]) screw(gun, [0.105, 0.035, z], mats.edgeMetal);
  buildHoloSight(gun, -0.2, 0.22, mats, true);
  gun.userData.aimDepth = -0.75;
  return gun;
}

function createLegacyMiningLaser() {
  const mats = SHARED_MATERIALS;
  const gun = new THREE.Group();
  gun.name = 'HLX-3 Prospector';
  gun.userData.muzzle = new THREE.Vector3(0, 0.07, -1.61);
  gun.userData.eject = new THREE.Vector3(0.12, 0.08, -0.08);

  const industrial = new THREE.MeshStandardMaterial({
    color: 0xb8a04a,
    metalness: 0.72,
    roughness: 0.34,
  });
  const ceramic = new THREE.MeshStandardMaterial({
    color: 0xd9e2df,
    metalness: 0.08,
    roughness: 0.42,
  });
  const copper = new THREE.MeshStandardMaterial({
    color: 0xb56636,
    metalness: 0.92,
    roughness: 0.2,
  });
  const energy = new THREE.MeshStandardMaterial({
    color: 0x73f3ff,
    emissive: 0x20cde0,
    emissiveIntensity: 4.2,
    metalness: 0.05,
    roughness: 0.16,
    toneMapped: false,
  });
  const energyGlass = new THREE.MeshPhysicalMaterial({
    color: 0x6beeff,
    emissive: 0x109daf,
    emissiveIntensity: 2.3,
    transmission: 0.58,
    transparent: true,
    opacity: 0.74,
    roughness: 0.08,
    metalness: 0,
    thickness: 0.025,
    depthWrite: false,
    toneMapped: false,
  });

  // Layered industrial receiver: structural shell, service panel, and ceramic
  // electrical isolation blocks all have separate depths and material reads.
  box(gun, [0.23, 0.22, 0.67], [0, 0.035, -0.08], mats.gunmetal, 0.034);
  box(gun, [0.195, 0.165, 0.61], [0, 0.105, -0.1], mats.graphite, 0.022);
  box(gun, [0.205, 0.085, 0.46], [0, -0.09, -0.08], industrial, 0.018);
  box(gun, [0.168, 0.022, 0.43], [0, 0.218, -0.12], ceramic, 0.006);
  rail(gun, -0.16, 10, 0.05, mats.graphite, 0.25);

  // Side service covers, fasteners, charge indicators, and insulated conduits.
  for (const side of [-1, 1]) {
    box(gun, [0.018, 0.13, 0.36], [side * 0.122, 0.045, -0.09], ceramic, 0.005);
    for (const z of [-0.23, -0.08, 0.07]) screw(gun, [0.134, 0.08, z], mats.edgeMetal, side);
    const conduit = new THREE.Mesh(new THREE.TorusGeometry(0.23, 0.013, 10, 42, Math.PI * 0.82), copper);
    conduit.position.set(side * 0.13, -0.025, -0.23);
    conduit.rotation.set(Math.PI / 2, 0, side > 0 ? 0.28 : Math.PI + 0.28);
    conduit.scale.set(0.48, 1, 1);
    gun.add(conduit);
  }

  // Visible field-stabilizer chamber. The luminous core is protected by a
  // transparent sleeve and clamped into the receiver rather than floating.
  const chamber = new THREE.Group();
  chamber.position.set(0, 0.04, -0.46);
  gun.add(chamber);
  cylinderZ(chamber, 0.09, 0.37, [0, 0, 0], mats.edgeMetal, 32);
  cylinderZ(chamber, 0.071, 0.385, [0, 0, 0], energyGlass, 32);
  cylinderZ(chamber, 0.034, 0.4, [0, 0, 0], energy, 24);
  for (const z of [-0.19, -0.095, 0, 0.095, 0.19]) {
    const clampRing = new THREE.Mesh(new THREE.TorusGeometry(0.092, 0.009, 8, 28), industrial);
    clampRing.position.z = z;
    chamber.add(clampRing);
  }

  // Long emitter shroud with alternating heat sinks and exposed copper coils.
  box(gun, [0.19, 0.17, 0.66], [0, 0.07, -0.84], mats.blackPolymer, 0.03);
  box(gun, [0.154, 0.132, 0.61], [0, 0.07, -0.86], mats.graphite, 0.022);
  cylinderZ(gun, 0.052, 0.76, [0, 0.07, -1.12], mats.edgeMetal, 32);
  cylinderZ(gun, 0.033, 0.8, [0, 0.07, -1.14], ceramic, 28);
  const coils = [];
  for (let i = 0; i < 8; i++) {
    const z = -0.74 - i * 0.105;
    const coil = new THREE.Mesh(new THREE.TorusGeometry(0.071, 0.008, 8, 30), i % 2 ? copper : energy);
    coil.position.set(0, 0.07, z);
    gun.add(coil);
    coils.push(coil);
    for (const side of [-1, 1]) {
      box(gun, [0.026, 0.205, 0.045], [side * 0.102, 0.07, z], mats.gunmetal, 0.005, [0, 0, side * 0.08]);
    }
  }

  // Three-stage focusing head: armored collar, ceramic insulator, recessed
  // lens and four field vanes establish a purpose-built mining silhouette.
  cylinderZ(gun, 0.105, 0.17, [0, 0.07, -1.5], industrial, 36);
  cylinderZ(gun, 0.083, 0.13, [0, 0.07, -1.57], ceramic, 36);
  openCylinderZ(gun, 0.064, 0.095, [0, 0.07, -1.605], mats.rubber, 36);
  const emitterLens = new THREE.Mesh(new THREE.CircleGeometry(0.052, 40), energyGlass);
  emitterLens.position.set(0, 0.07, -1.657);
  gun.add(emitterLens);
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2;
    const vane = box(gun, [0.025, 0.18, 0.16], [Math.cos(a) * 0.105, 0.07 + Math.sin(a) * 0.105, -1.54], mats.graphite, 0.006);
    vane.rotation.z = a;
  }

  // Two-piece shoulder assembly and damped industrial grip.
  cylinderZ(gun, 0.037, 0.46, [-0.065, 0.085, 0.43], mats.edgeMetal, 20);
  cylinderZ(gun, 0.037, 0.46, [0.065, 0.085, 0.43], mats.edgeMetal, 20);
  box(gun, [0.21, 0.2, 0.38], [0, 0.025, 0.58], mats.blackPolymer, 0.035);
  box(gun, [0.205, 0.225, 0.06], [0, -0.005, 0.81], mats.rubber, 0.018);
  box(gun, [0.16, 0.055, 0.29], [0, 0.15, 0.55], ceramic, 0.016);
  const grip = box(gun, [0.15, 0.33, 0.18], [0, -0.285, 0.15], mats.blackPolymer, 0.03, [-0.19, 0, 0]);
  for (let i = 0; i < 6; i++) box(grip, [0.154, 0.014, 0.13], [0, -0.09 - i * 0.048, 0.018], mats.rubber, 0.003);
  triggerAssembly(gun, -0.015, mats);

  // Foregrip, status screen and compact optic finish the close-up read.
  box(gun, [0.12, 0.28, 0.14], [0, -0.205, -0.64], mats.blackPolymer, 0.024, [0.14, 0, 0]);
  box(gun, [0.124, 0.022, 0.12], [0, -0.345, -0.62], mats.rubber, 0.005);
  const screen = box(gun, [0.012, 0.092, 0.19], [0.127, 0.045, 0.16], energyGlass, 0.004, [0, 0, -0.04]);
  screen.renderOrder = 2;
  for (let i = 0; i < 4; i++) box(gun, [0.014, 0.012, 0.025 + i * 0.018], [0.137, 0.01 + i * 0.021, 0.115], energy, 0.002);
  buildHoloSight(gun, -0.18, 0.255, mats, true);

  gun.userData.aimDepth = -0.72;
  gun.userData.laserCoils = coils;
  gun.userData.energyMaterial = energy;
  return gun;
}

function createMiningLaser() {
  const modelScale = 0.65;
  const gun = new THREE.Group();
  gun.name = 'HLX-3 Prospector';
  gun.userData.muzzle = new THREE.Vector3(0, 0.075 * modelScale, -1.63 * modelScale);
  gun.userData.eject = new THREE.Vector3(0, 0, 0);
  gun.userData.aimPoint = new THREE.Vector3(0, 0.49, -0.06);
  gun.userData.aimDepth = -0.72;
  gun.userData.energyMaterials = [];

  new GLTFLoader().load('/assets/hlx-3-prospector.glb', (gltf) => {
    const model = gltf.scene;
    model.name = 'HLX3_Model';
    model.scale.setScalar(modelScale);
    model.traverse((child) => {
      child.layers.set(3);
      if (!child.isMesh) return;
      child.castShadow = false;
      child.receiveShadow = false;
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      for (const material of materials) {
        if (material?.name === 'HLX Energy' || material?.name === 'HLX Lens') {
          material.toneMapped = false;
          gun.userData.energyMaterials.push(material);
        }
      }
    });
    gun.add(model);
    gun.userData.loaded = true;
  }, undefined, (error) => {
    console.error('HLX-3 model failed to load:', error);
    const legacy = createLegacyMiningLaser();
    gun.add(legacy);
  });

  return gun;
}

export function createWeaponModel(id) {
  switch (id) {
    case "KX9": return createCarbine();
    case "M77": return createMarksman();
    case "CX5": return createSubmachineGun();
    case 'HLX3': return createMiningLaser();
  }
}
