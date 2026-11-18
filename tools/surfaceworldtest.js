// Pure-Node verification suite for surface outpost & world systems:
//   1. src/surface/furniture.js     — 44 procedural furniture/habitation props & materials
//   2. src/surface/destructibles.js — shattering Voronoi glass panes & Verlet physics props
//   3. src/surface/k9-and-body.js   — SurveyK9, ColonistRig, FirstPersonBody

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createHabitatMaterials, createHabitatFurniture } from '../src/surface/furniture.js';
import { OutpostDestructibles } from '../src/surface/destructibles.js';
import { SurveyK9, ColonistRig, FirstPersonBody } from '../src/surface/k9-and-body.js';

let failures = 0;
const test = (name, work) => {
  try {
    work();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures++;
    console.log(`✗ ${name}\n  ${error.stack}`);
  }
};

function assertFiniteArray(arr, label) {
  for (let i = 0; i < arr.length; i++) {
    if (!Number.isFinite(arr[i])) {
      throw new Error(`${label} contains non-finite value at index ${i}: ${arr[i]}`);
    }
  }
}

function assertFiniteObject3D(root, label) {
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    assertFiniteArray(obj.matrix.elements, `${label}:${obj.name || obj.type}.matrix`);
    assertFiniteArray(obj.matrixWorld.elements, `${label}:${obj.name || obj.type}.matrixWorld`);
    if (obj.isSkinnedMesh && obj.skeleton) {
      for (let i = 0; i < obj.skeleton.bones.length; i++) {
        const b = obj.skeleton.bones[i];
        assertFiniteArray(b.matrix.elements, `${label}:bone[${i}].matrix`);
        assertFiniteArray(b.matrixWorld.elements, `${label}:bone[${i}].matrixWorld`);
      }
    }
  });
}

const REQUIRED_PROPS = [
  'sofa', 'armchair', 'loungeChair', 'diningChair', 'barStool', 'officeChair',
  'coffeeTable', 'sideTable', 'diningTable', 'conferenceTable', 'desk', 'nightstand',
  'tv', 'painting', 'rug', 'books', 'laptop', 'receptionBell',
  'floorLamp', 'tableLamp', 'pendantLamp', 'wallSconce', 'chandelier', 'exitSign',
  'planter', 'vase', 'piano', 'speaker', 'elevatorDoor', 'luggageCart', 'suitcase',
  'cushion', 'sunLounger', 'parasol', 'bed', 'kitchenCounter', 'stove', 'fridge',
  'shelfRack', 'pot', 'extinguisher', 'serviceTrolley', 'trashBin', 'wetFloorSign',
];

const slopedGround = (x, z) => Math.sin(x * 0.18) * 0.14 + Math.cos(z * 0.14) * 0.1;

// -----------------------------------------------------------------------------
// 1. Furniture & Material Library
// -----------------------------------------------------------------------------

let sharedMaterials = null;
let sharedFurniture = null;

test('createHabitatMaterials builds procedural materials & signage safely in pure Node', () => {
  assert.equal(typeof document, 'undefined', 'test runs in pure Node without DOM');
  sharedMaterials = createHabitatMaterials({ anisotropy: 4, detail: true });
  assert.ok(sharedMaterials.names.length >= 45, `expected >=45 materials, got ${sharedMaterials.names.length}`);
  for (const key of ['marbleFloor', 'walnut', 'brass', 'velvetTeal', 'leatherTan', 'onyx', 'steel']) {
    assert.ok(sharedMaterials[key]?.isMaterial, `missing material ${key}`);
  }
  const sign = sharedMaterials.makeSign('OUTPOST 04', { w: 0.8, h: 0.2 });
  assert.ok(sign.isMesh && sign.material.map?.isTexture, 'makeSign returns textured Mesh');
});

test('createHabitatFurniture builds all 44 procedural items with >0 tris, valid bounds, and non-NaN geometry', () => {
  sharedFurniture = createHabitatFurniture({ materials: sharedMaterials, anisotropy: 4 });
  for (const req of REQUIRED_PROPS) {
    assert.ok(sharedFurniture.names.includes(req), `missing expected furniture item "${req}"`);
  }
  assert.ok(sharedFurniture.names.length >= 42, `expected >=42 furniture items, got ${sharedFurniture.names.length}`);

  const box = new THREE.Box3();
  const boxSize = new THREE.Vector3();
  let totalTriangles = 0;

  for (const name of sharedFurniture.names) {
    const group = sharedFurniture.create(name);
    assert.ok(group instanceof THREE.Group, `${name} is not a THREE.Group`);
    assert.equal(group.castShadow, true, `${name} group.castShadow should be true`);
    assert.equal(group.receiveShadow, true, `${name} group.receiveShadow should be true`);
    assert.equal(group.userData.propName, name, `${name} userData.propName mismatch`);
    assert.equal(typeof group.userData.surface, 'string', `${name} missing userData.surface`);
    assert.equal(typeof group.userData.dynamic, 'boolean', `${name} missing boolean userData.dynamic`);
    assert.ok(
      Array.isArray(group.userData.size) &&
      group.userData.size.length === 3 &&
      group.userData.size.every((v) => Number.isFinite(v) && v > 0),
      `${name} invalid userData.size: ${JSON.stringify(group.userData.size)}`
    );

    let propTris = 0;
    group.traverse((child) => {
      if (child.isMesh) {
        const pos = child.geometry.attributes.position;
        const nrm = child.geometry.attributes.normal;
        assert.ok(pos && pos.count > 0, `${name} mesh has empty positions`);
        assert.ok(nrm && nrm.count === pos.count, `${name} mesh missing matching normals`);
        assertFiniteArray(pos.array, `${name}.position`);
        assertFiniteArray(nrm.array, `${name}.normal`);
        propTris += child.geometry.index ? child.geometry.index.count / 3 : pos.count / 3;
      }
    });
    assert.ok(propTris > 0, `${name} produced 0 triangles`);
    totalTriangles += propTris;

    box.setFromObject(group);
    assert.ok(!box.isEmpty(), `${name} bounding box is empty`);
    box.getSize(boxSize);
    assert.ok(boxSize.x > 0 && boxSize.y > 0 && boxSize.z > 0, `${name} degenerate bounding size`);
  }

  assert.ok(totalTriangles > 100000, `expected rich procedural mesh detail, got ${totalTriangles} triangles`);
});

// -----------------------------------------------------------------------------
// 2. OutpostDestructibles (Glass Panes, Shards & Verlet Physics Props)
// -----------------------------------------------------------------------------

test('OutpostDestructibles raycasts, cracks & shatters glass into tumbling shards, knocks/explodes props, and steps 60 frames cleanly', () => {
  const root = new THREE.Group();
  const audioEvents = [];
  const fxEvents = [];
  const destructibles = new OutpostDestructibles({
    root,
    groundHeight: slopedGround,
    onAudio: (ev) => audioEvents.push(ev.event),
    onFx: (ev) => fxEvents.push(ev.event),
    seed: 2026,
  });

  // Add two architectural glass panes (one straight, one yaw-rotated near explosive extinguisher)
  const mainPane = destructibles.addGlassPane({
    center: [0, 1.3, -4],
    width: 2.2,
    height: 2.0,
    yaw: 0,
    hp: 35,
  });
  const sidePane = destructibles.addGlassPane({
    center: [4.2, 1.3, -3.5],
    width: 1.8,
    height: 1.8,
    yaw: 0.45,
    hp: 35,
  });

  // Add physics props: laptop (knockable), trashBin (knockable), extinguisher (explosive)
  const laptopMesh = sharedFurniture.create('laptop');
  const laptopProp = destructibles.addPhysicsProp(laptopMesh, {
    pos: [-2.5, slopedGround(-2.5, -3) + 0.02, -3],
    yaw: 0.3,
    mass: 1.5,
    breakable: false,
    surface: 'metal',
  });

  const extinguisherMesh = sharedFurniture.create('extinguisher');
  const extinguisherProp = destructibles.addPhysicsProp(extinguisherMesh, {
    pos: [3.2, slopedGround(3.2, -3) + 0.02, -3],
    yaw: -0.2,
    mass: 6,
    explosive: true,
    hp: 24,
    surface: 'metal',
  });

  const breakableLaptop = destructibles.addPhysicsProp(sharedFurniture.create('laptop'), {
    pos: [2.4, slopedGround(2.4, -3.2) + 0.02, -3.2],
    mass: 1.5,
    breakable: true,
    surface: 'plastic',
  });

  // 1) Raycast & crack glass pane on first shot, shatter on second shot
  const glassHit1 = destructibles.raycast([0, 1.3, 0], [0, 0, -1], 20);
  assert.ok(glassHit1 && glassHit1.kind === 'glass', 'expected raycast to hit main glass pane');
  assert.equal(glassHit1.surface, 'glass');
  assert.ok(Math.abs(glassHit1.dist - 4.0) < 1e-3, `unexpected glass hit dist ${glassHit1.dist}`);

  const res1 = destructibles.damageAt(glassHit1, 18, [0, 0, -1], 6);
  assert.equal(res1.cracked, true, 'first shot should crack glass pane');
  assert.equal(res1.shattered, false, '18 dmg against 35 hp should not full-shatter yet');
  assert.ok(destructibles.activeShards > 0, 'chipping hole in glass spawns initial shards');

  const glassHit2 = destructibles.raycast([0.45, 1.5, 0], [0, 0, -1], 20);
  assert.ok(glassHit2 && glassHit2.kind === 'glass', 'second off-center raycast hits intact glass region');
  const res2 = destructibles.damageAt(glassHit2, 25, [0, 0, -1], 8);
  assert.equal(res2.shattered, true, 'cumulative damage >= 35 shatters glass pane');
  assert.ok(destructibles.activeShards >= 10, `expected cascading glass shards, got ${destructibles.activeShards}`);

  // 2) Raycast & shoot laptop prop -> wakes and flies/spins under bullet impulse
  const laptopStartPos = laptopProp.obj.position.clone();
  const laptopHit = destructibles.raycast([-2.5, laptopProp.cy, 0], [0, 0, -1], 20);
  assert.ok(laptopHit && laptopHit.kind === 'prop' && laptopHit.target === laptopProp, 'expected raycast to hit laptop prop');
  destructibles.damageAt(laptopHit, 20, [0, 0.15, -1], 7);
  assert.equal(laptopProp.sleeping, false, 'shot physics prop wakes up');

  // 3) Raycast & shoot pressurized extinguisher -> explodes, spawns debris chunks, breaks nearby prop & shatters sidePane!
  const extHit = destructibles.raycast([3.2, extinguisherProp.cy, 0], [0, 0, -1], 20);
  assert.ok(extHit && extHit.kind === 'prop' && extHit.target === extinguisherProp, 'expected raycast to hit extinguisher');
  const extRes = destructibles.damageAt(extHit, 30, [0, 0, -1], 8);
  assert.equal(extRes.exploded, true, 'extinguisher should detonate when hp reaches 0');
  assert.ok(destructibles.activeChunks >= 20, 'explosion spawns 3D instanced debris chunks');
  assert.equal(breakableLaptop.broken, true, 'nearby breakable laptop shattered by blast');
  assert.equal(sidePane.shattered, true, 'nearby rotated glass pane shattered by extinguisher blast');

  // 4) Step simulation over 60 frames and verify non-NaN state everywhere
  for (let step = 0; step < 60; step++) {
    destructibles.update(1 / 60);
  }

  assert.ok(
    laptopProp.obj.position.distanceTo(laptopStartPos) > 0.15,
    'knocked laptop should travel under Verlet physics'
  );
  assertFiniteObject3D(root, 'OutpostDestructibles.root');
  assertFiniteArray(destructibles._shardPosAttr.array, 'glassShards.position');
  assertFiniteArray(destructibles._shardNrmAttr.array, 'glassShards.normal');
  assertFiniteArray(destructibles.chunkMesh.instanceMatrix.array, 'debrisChunks.instanceMatrix');
  assert.ok(audioEvents.includes('glassShatter') && audioEvents.includes('propExplode'), 'audio callbacks fired');
  assert.ok(fxEvents.includes('explosion'), 'fx callbacks fired');

  destructibles.clear();
  assert.equal(destructibles.panes.length, 0);
  assert.equal(destructibles.props.length, 0);
  assert.equal(destructibles.activeShards, 0);
  destructibles.dispose();
});

// -----------------------------------------------------------------------------
// 3. SurveyK9, ColonistRig & FirstPersonBody
// -----------------------------------------------------------------------------

test('SurveyK9 instantiates halcyon & rogue variants, raycasts head weakpoint, barks, walks/trots/gallops over 60 steps without NaN', () => {
  const k9 = new SurveyK9({
    variant: 'halcyon',
    position: [0, 0, 0],
    yaw: 0,
    hp: 180,
    groundHeight: slopedGround,
    seed: 7,
  });
  const rogue = new SurveyK9({
    variant: 'rogue',
    position: [4, 0, 2],
    yaw: Math.PI * 0.5,
    hp: 180,
    groundHeight: slopedGround,
    seed: 19,
  });

  assert.ok(k9.mesh.isSkinnedMesh && k9.skeleton instanceof THREE.Skeleton, 'K9 has SkinnedMesh + Skeleton');
  assert.ok(k9.visorMesh?.isSkinnedMesh, 'K9 has glowing visor SkinnedMesh');
  assert.equal(k9.legs.length, 4, 'K9 has 4 articulated 3-joint legs');
  assert.ok(k9.core && k9.neck && k9.head && k9.jaw && k9.ears.length === 2, 'K9 exposes core/neck/head/jaw/ears');
  assert.ok(k9.triangles > 15000, `expected detailed K9 mesh, got ${k9.triangles} triangles`);

  // Raycast K9 head weakpoint from directly in front (-Z -> +Z)
  const headCenter = new THREE.Vector3().addVectors(k9.hitboxes.head.a, k9.hitboxes.head.b).multiplyScalar(0.5);
  const headOrigin = headCenter.clone().add(new THREE.Vector3(0, 0, -1.0));
  const headHit = k9.raycast(headOrigin, [0, 0, 1], 5);
  assert.ok(headHit && headHit.part === 'head' && headHit.weakpoint === true, 'front raycast hits K9 head weakpoint');

  // Trigger bark jaw animation + 60 steps of locomotion across sloped terrain
  const barkDur = k9.bark();
  assert.ok(barkDur > 0, 'bark() returns positive duration');

  const seenGaits = new Set();
  for (let i = 0; i < 60; i++) {
    k9.update(1 / 60, {
      targetPos: [0, 0, -14],
      groundHeight: slopedGround,
      lookAt: [1.5, 1.4, -16],
    });
    rogue.update(1 / 60, {
      targetPos: [6, 0, 2],
      groundHeight: slopedGround,
      speed: 1.5,
    });
    seenGaits.add(k9.gait);
  }

  assert.ok(
    seenGaits.has('walk') || seenGaits.has('trot') || seenGaits.has('gallop'),
    `expected K9 locomotion gait, saw: ${[...seenGaits].join(', ')}`
  );
  assertFiniteObject3D(k9.root, 'SurveyK9.halcyon');
  assertFiniteObject3D(rogue.root, 'SurveyK9.rogue');

  // Damage & death animation
  const dmg1 = k9.damage(60, { hitDir: [0, 0, 1] });
  assert.equal(dmg1.hp, 120);
  assert.equal(dmg1.alive, true);
  const dmg2 = k9.damage(200, { hitDir: [0, 0, 1] });
  assert.equal(dmg2.alive, false);
  assert.equal(dmg2.killed, true);
  for (let i = 0; i < 20; i++) k9.update(1 / 60);
  assertFiniteObject3D(k9.root, 'SurveyK9.dead');

  k9.dispose();
  rogue.dispose();
});

test('ColonistRig instantiates explorer, engineer & security palettes and animates idle/walk/patrol/crouch over 60 steps', () => {
  const roles = ['explorer', 'engineer', 'security'];
  const poses = ['idle', 'walk', 'patrol', 'crouch'];

  for (let r = 0; r < roles.length; r++) {
    const rig = new ColonistRig({
      role: roles[r],
      position: [r * 2, 0, 0],
      yaw: 0.25 * r,
      pose: 'idle',
      groundHeight: slopedGround,
      seed: 100 + r,
    });

    assert.ok(rig.body.isSkinnedMesh && rig.skeleton instanceof THREE.Skeleton);
    assert.ok(rig.triangles > 20000, `ColonistRig ${roles[r]} triangles: ${rig.triangles}`);
    assert.equal(rig.hitboxes.length, 3, 'ColonistRig exposes head/torso/legs hitboxes');

    for (let step = 0; step < 60; step++) {
      const pose = poses[Math.floor(step / 15) % poses.length];
      rig.update(1 / 60, {
        pose,
        targetPos: pose === 'walk' ? [r * 2, 0, -6] : null,
        lookAt: [0, 1.6, -8],
        groundHeight: slopedGround,
      });
    }

    assertFiniteObject3D(rig.root, `ColonistRig.${roles[r]}`);
    for (const hb of rig.hitboxes) {
      assertFiniteArray(hb.a.toArray(), `ColonistRig.${roles[r]}.hitbox.${hb.part}.a`);
      assertFiniteArray(hb.b.toArray(), `ColonistRig.${roles[r]}.hitbox.${hb.part}.b`);
    }
    rig.dispose();
  }
});

test('FirstPersonBody culls upper body, aligns to planetary up normal across walk/sprint/jump/crouch/slide, and hides in cockpit/skydive/scope', () => {
  const colonistRef = new ColonistRig({ role: 'explorer' });
  const fullTris = colonistRef.triangles;
  colonistRef.dispose();

  const fp = new FirstPersonBody({
    role: 'explorer',
    groundHeight: slopedGround,
  });

  assert.ok(fp.mesh.isSkinnedMesh && fp.skeleton instanceof THREE.Skeleton);
  assert.ok(
    fp.triangles > 10000 && fp.triangles < fullTris - 8000,
    `expected FirstPersonBody to cull head/neck/shoulders/arms (${fp.triangles} vs full ${fullTris})`
  );

  // Tilted spherical-planet local surface normal
  const planetUp = new THREE.Vector3(0.31, 0.91, -0.27).normalize();
  const pos = new THREE.Vector3(10, 4, -5);

  for (let step = 0; step < 60; step++) {
    const sprint = step >= 15 && step < 30;
    const airborne = step >= 30 && step < 40;
    const crouch = step >= 40 && step < 50;
    const slide = step >= 50;
    const speed = slide ? 6.5 : sprint ? 5.8 : crouch ? 1.8 : 3.2;
    pos.z -= speed * (1 / 60);

    fp.update(1 / 60, {
      state: 'walk',
      pos,
      yaw: 0.35,
      pitch: -0.55,
      up: planetUp,
      onGround: !airborne,
      vy: airborne ? 2.4 - (step - 30) * 0.5 : 0,
      sprint,
      crouch,
      slide,
      groundHeight: slopedGround,
    });
  }

  assert.equal(fp.root.visible, true, 'FirstPersonBody visible while walking on foot');
  const rootUp = new THREE.Vector3(0, 1, 0).applyQuaternion(fp.root.quaternion);
  assert.ok(rootUp.distanceTo(planetUp) < 1e-4, 'FirstPersonBody +Y aligns with planet local up normal');
  assertFiniteObject3D(fp.root, 'FirstPersonBody');

  // Auto-hide gates: cockpit, skydiving, non-walk flight state, magnified scope ADS
  fp.update(1 / 60, { state: 'walk', pos, inCockpit: true });
  assert.equal(fp.root.visible, false, 'hides inside cockpit seat');

  fp.update(1 / 60, { state: 'walk', pos, skydiving: true });
  assert.equal(fp.root.visible, false, 'hides while skydiving');

  fp.update(1 / 60, { state: 'fly', pos });
  assert.equal(fp.root.visible, false, 'hides when game state !== walk');

  fp.update(1 / 60, { state: 'walk', pos, ads: 0.75, hasScope: true });
  assert.equal(fp.root.visible, false, 'hides when zoomed into magnified scope (ads > 0.6 && hasScope)');

  fp.update(1 / 60, { state: 'walk', pos, ads: 0.75, hasScope: false });
  assert.equal(fp.root.visible, true, 'stays visible during iron-sight/reflex ADS without magnified scope');

  fp.dispose();
});

// Cleanup shared furniture & materials
if (sharedFurniture) sharedFurniture.dispose();
if (sharedMaterials) sharedMaterials.dispose();

if (failures > 0) {
  console.error(`\n${failures} test(s) failed.`);
  process.exit(1);
} else {
  console.log('\nPASS: all surface world tests passed.');
}
