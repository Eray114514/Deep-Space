// Unified surface gameplay coordinator:
//  - Surface raycast hit model (robots, K9, Voronoi destructible glass, Verlet
//    physics props, static outpost props, ocean water, and planetary terrain)
//  - GPU impact/explosion/decal FX (`fx.js`) with floating-origin shifts
//  - Frontier Survey & Habitation Outpost (industrial props, furnished pavilion,
//    shootable destructible glass & explosive props, Colonist crew & K9 unit)
//  - Outpost robot patrols & active Hound/Gull combat encounters (`robots.js`)
//  - First-person explorer lower body (`FirstPersonBody` from `k9-and-body.js`)
//  - Throwable Frag Grenades (`KeyQ`) with terrain bounce & blast physics
//  - Walk-mode tactical HUD (`CombatHud`) & surface footsteps/wind/sea audio

import * as THREE from 'three';
import { createSurfaceFx } from './fx.js';
import { createOutpostProps } from './props.js';
import { RAIN_WET_UNIFORMS, patchShaderWithRainWetness } from '../weather/wet-ground.js';
import { SurveyUnits } from './robots.js';
import { CombatHud } from './combat-hud.js';
import { createHabitatFurniture } from './furniture.js';
import { OutpostDestructibles } from './destructibles.js';
import { SurveyK9, ColonistRig, FirstPersonBody } from './k9-and-body.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();

function buildDefaultGrenadeMesh() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.036, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0x3b4732, roughness: 0.62, metalness: 0.25 }),
  );
  body.scale.y = 1.18;
  constspoon = new THREE.Mesh(
    new THREE.BoxGeometry(0.012, 0.055, 0.018),
    new THREE.MeshStandardMaterial({ color: 0x8a9298, roughness: 0.35, metalness: 0.85 }),
  );
  constspoon.position.set(0.018, 0.015, 0);
  g.add(body, constspoon);
  return g;
}
let constspoon;

export class SurfaceGameplay {
  constructor({
    scene,
    camera,
    materials = null,
    getAudio = () => null,
    getEnvironment = () => null,
    grenadeFactory = null,
  }) {
    this.scene = scene;
    this.camera = camera;
    this.materials = materials;
    this.getAudio = getAudio;
    this.getEnvironment = getEnvironment;
    this.grenadeFactory = grenadeFactory || buildDefaultGrenadeMesh;

    this.fx = createSurfaceFx({ scene, maxParticles: 640, maxDecals: 140 });
    this.hud = new CombatHud();

    // First-person lower body (legs & boots when looking down on foot)
    this.fpBody = new FirstPersonBody({ team: 0 });
    this.scene.add(this.fpBody.root);

    // Outpost / Combat encounter robot fleet (separate from ship's 2 friendly survey units)
    this.outpostRobots = new SurveyUnits({
      scene,
      materials,
      name: 'outpost-robots',
      poolGulls: 3,
      poolHounds: 3,
      clearanceRadius: 0,
      seed: 8813,
      getSfx: () => {
        const a = this.getAudio();
        return a?.ready ? a.sfx : null;
      },
      getEnvironment,
      onPlayerDamage: (amount, fromWorld) => this.applyPlayerDamage(amount, fromWorld),
      onFx: (kind, data) => this._handleRobotFx(kind, data),
    });

    // Forward Frontier Camp in local tangent frame
    this.campRoot = new THREE.Group();
    this.campRoot.name = 'frontier-camp';
    this.campRoot.matrixAutoUpdate = false;
    this.campRoot.visible = false;
    // Layer-0-only world subtree: let ForegroundPass skip the whole camp
    // hierarchy during weapon/ship foreground layer passes.
    this.campRoot.userData.worldLayerOnly = true;
    this.scene.add(this.campRoot);

    this.campPlanet = null;
    this.campOriginLocal = new THREE.Vector3();
    this.campAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    this.campWorldAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    this.campWorldOrigin = new THREE.Vector3();
    this.campBuilt = false;
    this.campColliders = [];
    this.campHeights = new Map();
    this.destructibles = null;
    this.colonists = [];
    this.k9Companion = null;
    this.rogueK9s = [];
    this.envMaterials = new Set();

    // Live thrown grenades in planet-local coordinates so floating-origin never drifts them
    this.grenades = [];
    this.grenadeCount = 3;
    this.maxGrenades = 3;
    this.grenadeCooldown = 0;

    // Suit shield & state tracking
    this.suitShield = 100;
    this.maxSuitShield = 100;
    this.sinceDamaged = 99;
    this.lastNavPos = new THREE.Vector3();
    this.hasLastNav = false;
    this.wasWalking = false;

    this._propsLib = null;
    this._furnLib = null;
  }

  setGrenadeFactory(fn) {
    if (typeof fn === 'function') this.grenadeFactory = fn;
  }

  _playSfx(name, opts = {}) {
    const audio = this.getAudio();
    if (!audio?.ready || !audio.sfx || audio.paused) return;
    audio.sfx.play(name, opts);
  }

  _handleRobotFx(kind, data) {
    if (kind === 'sparks') this.fx.sparks(data.point, data.normal, data.count || 10);
    else if (kind === 'explosion') this.fx.explosion(data.point, (data.scale || 1) * 3.2);
    else if (kind === 'impact') this.fx.impact(data);
    else if (kind === 'muzzleFlash' && data.point && data.dir) this.fx.muzzleSmoke(data.point, data.dir);
    else if (kind === 'smoke' && data.point) this.fx.muzzleSmoke(data.point, _up.set(0, 1, 0));
  }

  // --------------------------------------------------- camp local coordinate transforms

  campLocalToPlanet(x, y, z, out = new THREE.Vector3()) {
    const [e, n, f] = this.campAxes;
    return out.copy(this.campOriginLocal).addScaledVector(e, x).addScaledVector(n, y).addScaledVector(f, z);
  }

  campGroundHeight(x, z) {
    const p = this.campPlanet;
    if (!p) return 0;
    const key = `${Math.round(x * 2)}|${Math.round(z * 2)}`;
    let h = this.campHeights.get(key);
    if (h === undefined) {
      const dir = this.campLocalToPlanet(x, 0, z, _v1).normalize();
      const r = p.R + p.height(dir, p.fullMaxFreq);
      h = _v2.copy(dir).multiplyScalar(r).sub(this.campOriginLocal).dot(this.campAxes[1]);
      if (this.campHeights.size > 20000) this.campHeights.clear();
      this.campHeights.set(key, h);
    }
    return h;
  }

  worldToCampPoint(worldPt, out = new THREE.Vector3()) {
    const [E, N, F] = this.campWorldAxes;
    _v1.copy(worldPt).sub(this.campWorldOrigin);
    return out.set(_v1.dot(E), _v1.dot(N), _v1.dot(F));
  }

  worldToCampDir(worldDir, out = new THREE.Vector3()) {
    const [E, N, F] = this.campWorldAxes;
    return out.set(worldDir.dot(E), worldDir.dot(N), worldDir.dot(F)).normalize();
  }

  campToWorldPoint(localPt, out = new THREE.Vector3()) {
    const [E, N, F] = this.campWorldAxes;
    return out.copy(this.campWorldOrigin)
      .addScaledVector(E, localPt.x)
      .addScaledVector(N, localPt.y)
      .addScaledVector(F, localPt.z);
  }

  campToWorldDir(localDir, out = new THREE.Vector3()) {
    const [E, N, F] = this.campWorldAxes;
    return out.set(0, 0, 0)
      .addScaledVector(E, localDir.x)
      .addScaledVector(N, localDir.y)
      .addScaledVector(F, localDir.z)
      .normalize();
  }

  // --------------------------------------------------- forward frontier camp builder

  _ensureCampAssets() {
    if (this.campBuilt) return;
    this.campBuilt = true;
    this._propsLib = createOutpostProps({ materials: null, palette: 'halcyon' });
    this._furnLib = createHabitatFurniture({ anisotropy: 4 });
    this._campStaticItems = null;
    this._campPhysItems = null;
    this._campYardItems = null;

    this.destructibles = new OutpostDestructibles({
      root: this.campRoot,
      groundHeight: (x, z) => {
        // Pavilion slab sits at y = 0.28 inside [-6.2..6.2, -4.2..4.2]
        const gh = this.campGroundHeight(x, z);
        if (Math.abs(x) < 6.2 && Math.abs(z) < 4.2) return Math.max(gh, 0.28);
        return gh;
      },
      onAudio: (event) => {
        if (event === 'glassCrack' || event === 'glass_crack') this._playSfx('glass_crack', { gain: 0.8 });
        else if (event === 'glassShatter' || event === 'glass_shatter') this._playSfx('glass_shatter', { gain: 0.9 });
        else if (event === 'explode' || event === 'explosion') this._playSfx('grenade_explode', { gain: 0.95 });
        else this._playSfx('impact_metal', { gain: 0.55 });
      },
      onFx: (event, payload) => {
        if (!payload?.point && !payload?.pos) return;
        const ptWorld = this.campToWorldPoint(payload.point || payload.pos, new THREE.Vector3());
        if (event === 'explode' || event === 'explosion') {
          this.fx.explosion(ptWorld, 4.2);
          this.outpostRobots.applyExplosionWorld(ptWorld, 6, 85);
        } else {
          this.fx.sparks(ptWorld, this.campWorldAxes[1], 10);
        }
      },
    });

    const slabMat = new THREE.MeshStandardMaterial({ color: 0x2a3137, roughness: 0.68, metalness: 0.22 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x8f9aa2, roughness: 0.42, metalness: 0.58 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xcbd0cc, roughness: 0.55, metalness: 0.08 });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x4b3118, emissive: 0xff9b3d, emissiveIntensity: 1.9, roughness: 0.4,
    });
    for (const m of [slabMat, frameMat, wallMat]) {
      m.onBeforeCompile = (sh) => patchShaderWithRainWetness(sh, RAIN_WET_UNIFORMS);
      m.customProgramCacheKey = () => 'camp-pbr-rainwet-v1';
    }

    this.staticGroup = new THREE.Group();
    this.campRoot.add(this.staticGroup);

    // Pavilion structure (12 x 8 m): open +Z entrance, rear wall -Z, glass windows on +X, -X, and front-left!
    const addBox = (w, h, d, mat, x, y, z) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      this.staticGroup.add(m);
      return m;
    };
    // Deep foundation plinth so the pavilion anchors cleanly into sloped terrain
    addBox(12.2, 2.8, 8.2, slabMat, 0, -1.4, 0);
    addBox(12.4, 0.28, 8.4, slabMat, 0, 0.14, 0);
    addBox(12.8, 0.30, 8.8, frameMat, 0, 3.55, 0);
    addBox(12.2, 3.15, 0.24, wallMat, 0, 1.85, -4.05);
    addBox(12.4, 0.10, 0.14, trimMat, 0, 3.36, 4.18);
    for (const [cx, cz] of [[-6.0, -4.0], [6.0, -4.0], [-6.0, 4.0], [6.0, 4.0], [-1.8, 4.0]]) {
      addBox(0.28, 3.15, 0.28, frameMat, cx, 1.85, cz);
    }
    // Warm interior ceiling light fixture (emissive only, avoids mutating Layer-0 PointLight count)
    addBox(1.8, 0.08, 0.36, trimMat, 0, 3.38, 0);

    // Colonists & K9 companion
    const eng = new ColonistRig({ palette: 'engineer' });
    const exp = new ColonistRig({ palette: 'explorer' });
    this.campRoot.add(eng.root, exp.root);
    this.colonists = [
      { rig: eng, homeX: 9.5, homeZ: -3.5, mode: 'idle', phase: 0 },
      { rig: exp, homeX: -3.5, homeZ: 6.5, mode: 'patrol', phase: 1.4 },
    ];

    this.k9Companion = new SurveyK9({ variant: 'halcyon' });
    this.campRoot.add(this.k9Companion.root);
  }

  _populateCampDynamicProps() {
    this.destructibles.clear();
    this.campColliders.length = 0;
    if (!this.propItemsGroup) {
      this.propItemsGroup = new THREE.Group();
      this.campRoot.add(this.propItemsGroup);
    }

    const gh = (x, z) => this.campGroundHeight(x, z);
    const groundAtOrigin = gh(0, 0);
    this.staticGroup.position.y = groundAtOrigin;

    // Walkable pavilion floor collider
    this.campColliders.push({
      x: 0, y: groundAtOrigin, z: 0, yaw: 0, hw: 6.2, h: 0.28, hd: 4.2, walkableTop: true, surface: 'metal',
    });
    // Rear wall collider
    this.campColliders.push({
      x: 0, y: groundAtOrigin + 0.28, z: -4.05, yaw: 0, hw: 6.1, h: 3.15, hd: 0.2, walkableTop: false, surface: 'concrete',
    });

    // 3 Voronoi-destructible glass observation windows!
    const winBase = groundAtOrigin + 0.28;
    this.destructibles.addGlassPane({ center: new THREE.Vector3(-6.0, winBase + 1.55, 0), width: 7.4, height: 2.75, yaw: Math.PI * 0.5, hp: 30 });
    this.destructibles.addGlassPane({ center: new THREE.Vector3(6.0, winBase + 1.55, 0), width: 7.4, height: 2.75, yaw: Math.PI * 0.5, hp: 30 });
    this.destructibles.addGlassPane({ center: new THREE.Vector3(-3.9, winBase + 1.55, 4.0), width: 3.9, height: 2.75, yaw: 0, hp: 30 });

    const interiorSpecs = [
      ['desk', -3.2, 0, -2.2, 0, true],
      ['officeChair', -3.2, 0, -1.15, Math.PI, false],
      ['conferenceTable', 2.2, 0, -1.7, 0, true],
      ['sofa', -2.6, 0, 1.5, Math.PI * 0.5, true],
      ['shelfRack', -5.1, 0, -2.6, Math.PI * 0.5, true],
      ['fridge', 4.8, 0, -2.8, -Math.PI * 0.5, true],
      ['floorLamp', 4.9, 0, 2.6, 0, false],
      ['planter', 5.0, 0, 3.3, 0, false],
      ['serviceTrolley', 3.6, 0, 1.8, -0.35, true],
    ];
    if (!this._campStaticItems) {
      this._campStaticItems = interiorSpecs.map(([name, x, yOff, z, yaw, addCol]) => {
        const mesh = this._furnLib.create(name);
        this.propItemsGroup.add(mesh);
        return { mesh, name, x, yOff, z, yaw, addCol };
      });
    }
    for (const item of this._campStaticItems) {
      const y = winBase + item.yOff;
      item.mesh.visible = true;
      item.mesh.position.set(item.x, y, item.z);
      item.mesh.rotation.set(0, item.yaw, 0);
      if (item.addCol) {
        const sz = item.mesh.userData.size || [1, 1, 1];
        this.campColliders.push({
          name: item.name, x: item.x, y, z: item.z, yaw: item.yaw, hw: sz[0] * 0.5, h: sz[1], hd: sz[2] * 0.5,
          walkableTop: sz[1] < 1.35 && (item.name.includes('container') || item.name.includes('crate') || item.name.includes('pallet')),
          surface: item.mesh.userData.surface || 'metal',
        });
      }
    }

    // Shootable / Explosive Verlet physics props!
    const physSpecs = [
      ['extinguisher', 5.4, 0.35, 3.5, 0, false, { mass: 3.5, explosive: true, breakable: true, hp: 24, surface: 'metal' }],
      ['extinguisher', 8.2, 0.35, -2.2, 0.5, true, { mass: 3.5, explosive: true, breakable: true, hp: 24, surface: 'metal' }],
      ['laptop', -3.1, 0.82, -2.2, 0.1, false, { mass: 1.4, breakable: true, hp: 18, surface: 'metal' }],
      ['trashBin', -1.8, 0.25, -2.2, 0, false, { mass: 1.5, breakable: false, surface: 'metal' }],
      ['suitcase', -1.2, 0.3, 2.4, 0.4, false, { mass: 2.2, breakable: false, surface: 'wood' }],
      ['wetFloorSign', 1.2, 0.32, 3.2, -0.25, false, { mass: 1.1, breakable: true, hp: 20, surface: 'rubber' }],
    ];
    if (!this._campPhysItems) {
      this._campPhysItems = physSpecs.map(([name, x, yOff, z, yaw, onGround, cfg]) => ({
        mesh: this._furnLib.create(name),
        x, yOff, z, yaw, onGround, cfg,
      }));
    }
    for (const item of this._campPhysItems) {
      item.mesh.visible = true;
      const y = (item.onGround ? gh(item.x, item.z) : winBase) + item.yOff;
      this.destructibles.addPhysicsProp(item.mesh, {
        pos: new THREE.Vector3(item.x, y, item.z),
        yaw: item.yaw,
        size: item.mesh.userData.size,
        ...item.cfg,
      });
    }

    // Exterior industrial yard props placed on real planet groundHeight!
    const yardSpecs = [
      ['guard_booth', -9.2, 4.8, 0.35, 'halcyon'],
      ['generator', 10.6, -3.5, -0.4, 'industrial'],
      ['forklift', -11.5, -2.5, 0.8, 'industrial'],
      ['container20', 13.5, 3.2, -1.35, 'halcyon'],
      ['ibc_tote', 8.8, 2.6, 0.2, 'frontier'],
      ['crate_stack', -8.8, -5.8, 0.5, 'industrial'],
      ['sandbags', -4.2, 8.2, 0.1, 'industrial'],
      ['sandbags', 3.8, 8.2, -0.1, 'industrial'],
      ['gas_cylinders', 9.2, -6.2, 0.0, 'industrial'],
      ['floodlight_stand', -7.2, 7.6, 0.6, 'halcyon'],
      ['floodlight_stand', 7.4, 7.4, -0.6, 'halcyon'],
      ['barrel', 7.8, 4.2, 0.0, 'frontier'],
      ['relay_node', -7.8, -2.0, 0.9, 'halcyon'],
      ['toolbox_cart', 8.4, -1.0, -0.8, 'industrial'],
      ['comms_tower', 0.0, -14.5, 0.0, 'halcyon'],
    ];
    if (!this._campYardItems) {
      this._campYardItems = yardSpecs.map(([name, x, z, yaw, palette], i) => {
        const mesh = this._propsLib.create(name, { seed: 500 + i, palette });
        this.propItemsGroup.add(mesh);
        return { mesh, name, x, z, yaw };
      });
    }
    for (const item of this._campYardItems) {
      const y = gh(item.x, item.z);
      item.mesh.visible = true;
      item.mesh.position.set(item.x, y, item.z);
      item.mesh.rotation.set(0, item.yaw, 0);
      const sz = item.mesh.userData.size || [1, 1, 1];
      this.campColliders.push({
        name: item.name, x: item.x, y, z: item.z, yaw: item.yaw, hw: sz[0] * 0.5, h: sz[1], hd: sz[2] * 0.5,
        walkableTop: sz[1] < 1.35 && (item.name.includes('container') || item.name.includes('crate') || item.name.includes('pallet')),
        surface: item.mesh.userData.surface || 'metal',
      });
    }

    // Collect metallic materials for outdoor reflection envMap
    if (!this.envMaterials.size) {
      this.campRoot.traverse((o) => {
        if (!o.isMesh) return;
        o.frustumCulled = false;
        const list = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
        for (const m of list) {
          if (m?.isMeshStandardMaterial) {
            if (m.userData.baseEnvIntensity === undefined) m.userData.baseEnvIntensity = m.envMapIntensity ?? 1;
            this.envMaterials.add(m);
          }
        }
      });
    }
  }

  deployForwardCamp(planet, shipPadLocal) {
    if (!planet || planet.isGasGiant) return false;
    if (this.campPlanet === planet && this.campOriginLocal.distanceToSquared(shipPadLocal) < 9000) {
      this.campRoot.visible = true;
      return true;
    }
    this._ensureCampAssets();
    this.campPlanet = planet;
    this.campHeights.clear();

    // Pick the flattest dry spot ~54 m from the ship pad
    _up.copy(shipPadLocal).normalize();
    _east.crossVectors(Math.abs(_up.y) < 0.9 ? _v1.set(0, 1, 0) : _v1.set(1, 0, 0), _up).normalize();
    _north.crossVectors(_up, _east).normalize();

    let bestScore = Infinity;
    let bestDir = _v3.copy(shipPadLocal).addScaledVector(_north, 54).normalize();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const candidate = _v1.copy(shipPadLocal)
        .addScaledVector(_east, Math.cos(a) * 54)
        .addScaledVector(_north, Math.sin(a) * 54)
        .normalize();
      const h0 = planet.height(candidate, planet.fullMaxFreq);
      if (planet.hasLiquid && h0 < planet.seaLevel + 1.8) continue;
      const h1 = planet.height(_v2.copy(candidate).addScaledVector(_east, 6 / planet.R).normalize(), planet.fullMaxFreq);
      const h2 = planet.height(_v2.copy(candidate).addScaledVector(_north, 6 / planet.R).normalize(), planet.fullMaxFreq);
      const slope = Math.abs(h1 - h0) + Math.abs(h2 - h0);
      if (slope < bestScore) {
        bestScore = slope;
        bestDir.copy(candidate);
      }
    }
    const r = planet.R + planet.height(bestDir, planet.fullMaxFreq);
    this.campOriginLocal.copy(bestDir).multiplyScalar(r);

    // Orient camp +Z (+F) toward the ship pad so the open pavilion entrance faces the player!
    const [e, n, f] = this.campAxes;
    n.copy(bestDir).normalize();
    f.copy(shipPadLocal).sub(this.campOriginLocal).projectOnPlane(n);
    if (f.lengthSq() < 1e-4) f.copy(_north);
    f.normalize();
    e.crossVectors(n, f).normalize();
    f.crossVectors(e, n).normalize();

    this._populateCampDynamicProps();
    this.campRoot.visible = true;
    return true;
  }

  recallForwardCamp() {
    this.campPlanet = null;
    this.campRoot.visible = false;
  }

  // Spawn an active robot combat encounter around the camp or ahead of the player
  spawnCombatEncounter({ planet, playerLocal, hounds = 2, gulls = 2, passive = false } = {}) {
    if (!planet || !playerLocal) return 0;
    const anchor = this.campPlanet === planet
      ? this.campOriginLocal
      : playerLocal;
    return this.outpostRobots.deployOutpost(planet, anchor, {
      hounds,
      gulls,
      passive,
      friendly: false,
      patrolRadius: 20,
    });
  }

  // --------------------------------------------------- player collision with camp props

  resolveWalkCollision(walkCtl) {
    if (!this.campPlanet || walkCtl.planet !== this.campPlanet || !this.campRoot.visible) return;
    const p = walkCtl.planet;
    const [e, n, f] = this.campAxes;
    const rel = _v1.copy(walkCtl.posLocal).sub(this.campOriginLocal);
    const lx = rel.dot(e), ly = rel.dot(n), lz = rel.dot(f);
    if (lx * lx + lz * lz > 65 * 65) return;

    const footY = ly - walkCtl.eyeHeight;
    let floorOverride = -Infinity;
    let pushX = 0, pushZ = 0;
    const rad = 0.36;

    for (const c of this.campColliders) {
      const dx = lx - c.x, dz = lz - c.z;
      const cy = Math.cos(-c.yaw), sy = Math.sin(-c.yaw);
      const bx = dx * cy - dz * sy;
      const bz = dx * sy + dz * cy;
      const ex = c.hw + rad, ez = c.hd + rad;
      if (Math.abs(bx) >= ex || Math.abs(bz) >= ez) continue;
      const topY = c.y + c.h;
      if (c.walkableTop && footY >= topY - 0.55 && walkCtl.vR <= 0.5) {
        floorOverride = Math.max(floorOverride, topY);
        continue;
      }
      if (footY < topY - 0.15 && ly > c.y + 0.1) {
        const ox = ex - Math.abs(bx);
        const oz = ez - Math.abs(bz);
        let px = 0, pz = 0;
        if (ox < oz) px = bx >= 0 ? ox : -ox;
        else pz = bz >= 0 ? oz : -oz;
        const c2 = Math.cos(c.yaw), s2 = Math.sin(c.yaw);
        pushX += px * c2 - pz * s2;
        pushZ += px * s2 + pz * c2;
      }
    }

    if (pushX !== 0 || pushZ !== 0) {
      walkCtl.posLocal.addScaledVector(e, pushX).addScaledVector(f, pushZ);
    }
    if (floorOverride > -1e8) {
      const newEyeY = floorOverride + walkCtl.eyeHeight;
      if (ly <= newEyeY + 0.04) {
        walkCtl.posLocal.addScaledVector(n, newEyeY - ly);
        walkCtl.vR = Math.max(0, walkCtl.vR);
        walkCtl.grounded = true;
      }
    }
    void p;
  }

  // --------------------------------------------------- unified surface hit model

  _raycastCampColliders(origLocal, dirLocal, maxDist) {
    let best = null;
    for (const c of this.campColliders) {
      const cy = Math.cos(-c.yaw), sy = Math.sin(-c.yaw);
      const ox = (origLocal.x - c.x) * cy - (origLocal.z - c.z) * sy;
      const oy = origLocal.y - (c.y + c.h * 0.5);
      const oz = (origLocal.x - c.x) * sy + (origLocal.z - c.z) * cy;
      const dx = dirLocal.x * cy - dirLocal.z * sy;
      const dy = dirLocal.y;
      const dz = dirLocal.x * sy + dirLocal.z * cy;
      const hx = c.hw, hy = c.h * 0.5, hz = c.hd;

      let tmin = 0, tmax = maxDist;
      let hitAxis = 0, hitSign = 1;
      const axes = [[ox, dx, hx, 0], [oy, dy, hy, 1], [oz, dz, hz, 2]];
      let miss = false;
      for (const [o, d, h, axisIdx] of axes) {
        if (Math.abs(d) < 1e-7) {
          if (Math.abs(o) > h) { miss = true; break; }
        } else {
          let t1 = (-h - o) / d, t2 = (h - o) / d;
          let s = -1;
          if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
          if (t1 > tmin) { tmin = t1; hitAxis = axisIdx; hitSign = s; }
          if (t2 < tmax) tmax = t2;
          if (tmin > tmax) { miss = true; break; }
        }
      }
      if (miss || tmin <= 0.05 || tmin >= (best ? best.dist : maxDist)) continue;
      const nxB = hitAxis === 0 ? hitSign : 0;
      const nyB = hitAxis === 1 ? hitSign : 0;
      const nzB = hitAxis === 2 ? hitSign : 0;
      const c2 = Math.cos(c.yaw), s2 = Math.sin(c.yaw);
      best = {
        dist: tmin,
        point: origLocal.clone().addScaledVector(dirLocal, tmin),
        normal: new THREE.Vector3(nxB * c2 - nzB * s2, nyB, nxB * s2 + nzB * c2).normalize(),
        surface: c.surface || 'metal',
      };
    }
    return best;
  }

  _raycastTerrainWorld(planet, navPos, originWorld, dirWorld, maxDist = 180) {
    if (!planet || planet.isGasGiant) return null;
    const seaR = planet.hasLiquid ? planet.R + planet.seaLevel : -Infinity;
    let prevDist = 0.25;
    let step = 0.5;
    const sample = (d) => {
      _v1.copy(originWorld).addScaledVector(dirWorld, d).add(navPos);
      planet.worldPositionToLocal(_v1, _v2);
      const r = _v2.length();
      const dir = _v3.copy(_v2).multiplyScalar(1 / Math.max(1e-6, r));
      const h = planet.height(dir, planet.fullMaxFreq);
      const surfR = Math.max(planet.R + h, seaR);
      return { r, surfR, h, isWater: planet.hasLiquid && planet.liquid !== 'lava' && seaR > planet.R + h + 0.02, dir: dir.clone() };
    };
    let prev = sample(prevDist);
    for (let d = prevDist + step; d <= maxDist; d += step) {
      const cur = sample(d);
      const prevAbove = prev.r - prev.surfR;
      const curAbove = cur.r - cur.surfR;
      if (curAbove <= 0 && prevAbove >= -0.5) {
        const frac = prevAbove / Math.max(1e-4, prevAbove - curAbove);
        const hitDist = prevDist + (d - prevDist) * THREE.MathUtils.clamp(frac, 0, 1);
        const point = originWorld.clone().addScaledVector(dirWorld, hitDist);
        const normal = planet.localOffsetToWorld(cur.dir, new THREE.Vector3()).normalize();
        let surface = 'dirt';
        if (cur.isWater) surface = 'water';
        else if (planet.type === 'artificialHabitat') surface = 'metal';
        else if (planet.type === 'barren' || planet.type === 'lava' || planet.type === 'ice') surface = 'rock';
        return { dist: hitDist, point, normal, surface };
      }
      prev = cur;
      prevDist = d;
      step = Math.min(3.5, 0.45 + d * 0.03);
    }
    return null;
  }

  resolveShot(eyeWorld, dirWorld, {
    planet = null,
    navPos = null,
    surveyUnits = null,
    damage = 28,
    impulse = 6,
    maxRange = 180,
  } = {}) {
    let bestDist = maxRange;
    let bestHit = null;

    // 1. Outpost / combat robots
    if (this.outpostRobots.deployed) {
      const rHit = this.outpostRobots.raycastWorld(eyeWorld, dirWorld, bestDist);
      if (rHit && rHit.dist < bestDist) {
        bestDist = rHit.dist;
        bestHit = { kind: 'outpostRobot', raw: rHit };
      }
    }

    // 2. Friendly ship survey units
    if (surveyUnits?.deployed) {
      const sHit = surveyUnits.raycastWorld(eyeWorld, dirWorld, bestDist);
      if (sHit && sHit.dist < bestDist) {
        bestDist = sHit.dist;
        bestHit = { kind: 'surveyUnit', raw: sHit };
      }
    }

    // 3. Camp destructibles (Voronoi glass & Verlet physics props) + static camp colliders
    if (this.campPlanet && this.campPlanet === planet && this.campRoot.visible && this.destructibles) {
      const origC = this.worldToCampPoint(eyeWorld, new THREE.Vector3());
      const dirC = this.worldToCampDir(dirWorld, new THREE.Vector3());
      const dHit = this.destructibles.raycast(origC, dirC, bestDist);
      if (dHit && dHit.dist < bestDist) {
        bestDist = dHit.dist;
        bestHit = { kind: 'destructible', raw: dHit, dirC };
      }
      const cHit = this._raycastCampColliders(origC, dirC, bestDist);
      if (cHit && cHit.dist < bestDist) {
        bestDist = cHit.dist;
        bestHit = { kind: 'campProp', raw: cHit };
      }
    }

    // 4. Planetary terrain / ocean
    if (planet && navPos) {
      const tHit = this._raycastTerrainWorld(planet, navPos, eyeWorld, dirWorld, bestDist);
      if (tHit && tHit.dist < bestDist) {
        bestDist = tHit.dist;
        bestHit = { kind: 'terrain', raw: tHit };
      }
    }

    // Alert nearby combat robots to gunfire
    this.outpostRobots.notifyWeaponFireWorld(eyeWorld);

    if (!bestHit) return null;

    if (bestHit.kind === 'outpostRobot') {
      const res = this.outpostRobots.applyShotWorld(eyeWorld, dirWorld, { damage, range: bestDist + 0.5 });
      if (res) {
        this.fx.impact({ point: res.point, normal: res.normal, surface: 'enemy', dir: dirWorld });
        this.hud.triggerHit({ weakpoint: res.weak, killed: res.killed });
        this._playSfx('hitmarker', { gain: res.killed ? 0.75 : 0.5, pitch: res.weak ? 1.2 : 1.0 });
        return res.point;
      }
    } else if (bestHit.kind === 'surveyUnit') {
      const res = surveyUnits.applyShotWorld(eyeWorld, dirWorld, { damage: 0, range: bestDist + 0.5 });
      if (res) {
        this.fx.impact({ point: res.point, normal: res.normal, surface: 'metal', dir: dirWorld });
        return res.point;
      }
    } else if (bestHit.kind === 'destructible') {
      const dHit = bestHit.raw;
      this.destructibles.damageAt(dHit, damage, bestHit.dirC, impulse);
      const ptW = this.campToWorldPoint(dHit.point, new THREE.Vector3());
      const nrmW = this.campToWorldDir(dHit.normal || _up.set(0, 1, 0), new THREE.Vector3());
      this.fx.impact({
        point: ptW,
        normal: nrmW,
        surface: dHit.kind === 'glass' ? 'glass' : (dHit.surface || 'metal'),
        dir: dirWorld,
      });
      this.hud.triggerHit({ weakpoint: false, killed: dHit.kind === 'glass' });
      this._playSfx('hitmarker', { gain: 0.42 });
      return ptW;
    } else if (bestHit.kind === 'campProp') {
      const cHit = bestHit.raw;
      const ptW = this.campToWorldPoint(cHit.point, new THREE.Vector3());
      const nrmW = this.campToWorldDir(cHit.normal, new THREE.Vector3());
      this.fx.impact({ point: ptW, normal: nrmW, surface: cHit.surface, dir: dirWorld });
      this._playImpactSound(cHit.surface, bestDist, dirWorld, nrmW);
      return ptW;
    } else if (bestHit.kind === 'terrain') {
      const tHit = bestHit.raw;
      this.fx.impact({ point: tHit.point, normal: tHit.normal, surface: tHit.surface, dir: dirWorld });
      this._playImpactSound(tHit.surface, bestDist, dirWorld, tHit.normal);
      return tHit.point;
    }
    return null;
  }

  _playImpactSound(surface, dist, dirWorld, normalWorld) {
    const att = Math.min(1, 14 / Math.max(3, dist));
    if (att < 0.05) return;
    const map = {
      metal: 'impact_metal',
      water: 'impact_water',
      wood: 'impact_wood',
      glass: 'impact_glass',
      rock: 'impact_concrete',
      concrete: 'impact_concrete',
      dirt: 'impact_concrete',
      rubber: 'impact_wood',
    };
    const snd = map[surface] || 'impact_concrete';
    this._playSfx(snd, { gain: 0.65 * att, pitch: surface === 'dirt' ? 0.78 : 0.96 + Math.random() * 0.08 });
    // Grazing ricochet on rock or metal
    if ((surface === 'metal' || surface === 'rock' || surface === 'concrete')
      && Math.abs(dirWorld.dot(normalWorld)) < 0.36 && Math.random() < 0.45) {
      this._playSfx('ricochet', { gain: 0.45 * att, delay: 0.03 });
    }
  }

  // --------------------------------------------------- throwable frag grenades (KeyQ)

  throwGrenade({ planet, navPos, eyeWorld, dirWorld, playerVelLocal = null }) {
    if (!planet || planet.isGasGiant || this.grenadeCount <= 0 || this.grenadeCooldown > 0) return false;
    this.grenadeCount--;
    this.grenadeCooldown = 0.65;
    this._playSfx('grenade_pin', { gain: 0.75 });

    const built = this.grenadeFactory();
    const mesh = built?.isObject3D ? built : built.root;
    mesh.frustumCulled = false;
    this.scene.add(mesh);

    // Convert world throw origin & velocity into planet-local coordinates
    const startUniv = _v1.copy(eyeWorld).addScaledVector(dirWorld, 0.45).add(navPos);
    const posLocal = planet.worldPositionToLocal(startUniv, new THREE.Vector3());
    const upLocal = posLocal.clone().normalize();
    const dirLocal = planet.worldOffsetToLocal(dirWorld, new THREE.Vector3()).normalize();
    const velLocal = dirLocal.multiplyScalar(19.5).addScaledVector(upLocal, 3.8);
    if (playerVelLocal) velLocal.addScaledVector(playerVelLocal, 0.55);

    this.grenades.push({
      planet,
      mesh,
      posLocal,
      velLocal,
      spin: new THREE.Vector3(9, 13, 6),
      fuse: 2.15,
      bounces: 0,
    });
    return true;
  }

  _updateGrenades(dt, navPos) {
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const p = g.planet;
      g.fuse -= dt;
      const r = g.posLocal.length();
      const up = _v1.copy(g.posLocal).multiplyScalar(1 / Math.max(1e-6, r));
      g.velLocal.addScaledVector(up, -p.gravity * dt);
      g.posLocal.addScaledVector(g.velLocal, dt);

      const newR = g.posLocal.length();
      const dir = _v2.copy(g.posLocal).multiplyScalar(1 / Math.max(1e-6, newR));
      const surfR = p.R + p.height(dir, p.fullMaxFreq) + 0.04;
      if (newR <= surfR) {
        g.posLocal.copy(dir).multiplyScalar(surfR);
        const vn = g.velLocal.dot(dir);
        if (vn < -0.6) {
          g.velLocal.addScaledVector(dir, -1.42 * vn);
          g.velLocal.multiplyScalar(0.62);
          if (g.bounces < 4) {
            this._playSfx('grenade_bounce', { gain: Math.min(0.7, -vn * 0.08), pitch: 0.95 + g.bounces * 0.06 });
          }
          g.bounces++;
        } else {
          g.velLocal.multiplyScalar(Math.max(0, 1 - dt * 8));
        }
      }

      p.localPositionToWorld(g.posLocal, g.mesh.position).sub(navPos);
      g.mesh.rotation.x += g.spin.x * dt;
      g.mesh.rotation.y += g.spin.y * dt;
      g.mesh.rotation.z += g.spin.z * dt;

      if (g.fuse <= 0) {
        const blastWorld = g.mesh.position.clone();
        const blastNorm = p.localOffsetToWorld(dir, new THREE.Vector3()).normalize();
        this.fx.setLighting({ up: blastNorm });
        this.fx.explosion(blastWorld, 5.2);
        this._playSfx('grenade_explode', { gain: 1.0 });
        this._playSfx('explosion', { gain: 0.75 });
        this.outpostRobots.applyExplosionWorld(blastWorld, 8.5, 130);
        if (this.campPlanet === p && this.destructibles) {
          const cLocal = this.worldToCampPoint(blastWorld, new THREE.Vector3());
          this.destructibles.explode(cLocal, 8.5, 15);
        }
        const playerDist = blastWorld.length();
        if (playerDist < 8.5) {
          this.applyPlayerDamage(52 * (1 - playerDist / 8.5), blastWorld);
        }
        this.scene.remove(g.mesh);
        this.grenades.splice(i, 1);
      }
    }
  }

  // --------------------------------------------------- player suit shield & foley

  applyPlayerDamage(amount, fromWorld = null) {
    if (amount <= 0) return;
    this.suitShield = Math.max(0, this.suitShield - amount);
    this.sinceDamaged = 0;
    this._playSfx('hurt', { gain: Math.min(0.85, 0.35 + amount / 60) });
    let relAngle = 0;
    if (fromWorld) {
      _v1.copy(fromWorld).applyQuaternion(_v2 && this.camera.quaternion.clone().invert());
      relAngle = Math.atan2(_v1.x, -_v1.z);
    }
    this.hud.triggerDamage(relAngle, Math.min(1, amount / 45));
  }

  onWalkStep({ running = false, crouching = false, posLocal = null, planet = null } = {}) {
    if (!planet || !posLocal) return;
    const gain = running ? 0.38 : crouching ? 0.16 : 0.25;
    const pitch = 0.94 + Math.random() * 0.12;

    // Check shallow water
    if (planet.hasLiquid && planet.liquid !== 'lava') {
      const dir = _v1.copy(posLocal).normalize();
      const h = planet.height(dir, planet.fullMaxFreq);
      if (h < planet.seaLevel + 0.25) {
        this._playSfx('step_water', { gain: gain * 1.15, pitch });
        return;
      }
    }
    // Check artificial habitat or camp pavilion floor
    if (planet.type === 'artificialHabitat') {
      this._playSfx('step_metal', { gain, pitch });
      return;
    }
    if (this.campPlanet === planet && this.campRoot.visible) {
      const rel = _v1.copy(posLocal).sub(this.campOriginLocal);
      const lx = rel.dot(this.campAxes[0]), lz = rel.dot(this.campAxes[2]);
      if (Math.abs(lx) < 6.4 && Math.abs(lz) < 4.4) {
        this._playSfx('step_metal', { gain, pitch });
        return;
      }
      if (lx * lx + lz * lz < 20 * 20) {
        this._playSfx('step_concrete', { gain, pitch });
        return;
      }
    }
    this._playSfx('step_concrete', { gain: gain * 0.82, pitch: pitch * 0.84 });
  }

  onWalkJump() {
    this._playSfx('jump', { gain: 0.34, pitch: 0.96 + Math.random() * 0.08 });
  }

  onWalkLand(impact01 = 0.4) {
    this._playSfx('land', { gain: 0.24 + impact01 * 0.38, pitch: 0.95 + Math.random() * 0.08 });
  }

  onWalkSlide(phase) {
    const audio = this.getAudio();
    if (!audio?.ready) return;
    if (phase === 'start') {
      audio.noiseBurst?.({ duration: 0.46, gain: 0.065, from: 1900, to: 460, q: 0.75 });
    }
  }

  // --------------------------------------------------- per-frame update

  update(dt, {
    state = 'space',
    paused = false,
    planet = null,
    navPos,
    walkCtl = null,
    ship = null,
    recallInFlight = false,
    surfaceWeapons = null,
    weaponsList = null,
    weather = null,
    rainWetness = 0,
    sunDirWorld = null,
    sunColor = null,
    skyColor = null,
  } = {}) {
    // Update shared rain-wetness uniforms for outposts & pads
    RAIN_WET_UNIFORMS.uRainWet.value = rainWetness;
    if (!paused) RAIN_WET_UNIFORMS.uRainTime.value += dt;

    // Floating-origin shift for world-space particles & bullet decals
    if (navPos) {
      if (this.hasLastNav) {
        _v1.subVectors(navPos, this.lastNavPos);
        if (_v1.lengthSq() > 1e-8) this.fx.shiftOrigin(_v1);
      } else {
        this.hasLastNav = true;
      }
      this.lastNavPos.copy(navPos);
    }

    const walking = state === 'walk' && !!planet && !!walkCtl;
    if (!walking && this.wasWalking) {
      // Boarding ship replenishes grenades & suit shield
      this.grenadeCount = this.maxGrenades;
      this.suitShield = this.maxSuitShield;
    }
    this.wasWalking = walking;

    // Deploy / recall the forward frontier camp alongside a ground-landed ship
    // (never spawn a surface camp underneath an airborne hover-skydive or extraction ship).
    if (ship?.parkedPlanet && ship.parkedLocal && !ship.orbitalStandby
      && !ship.hoverMode && !recallInFlight && (ship.parkAmt ?? 1) > 0.95
      && (state === 'walk' || state === 'shipwalk' || state === 'landed')) {
      this.deployForwardCamp(ship.parkedPlanet, ship.parkedLocal);
    } else if (this.campPlanet && (ship?.hoverMode || recallInFlight || (state !== 'walk' && state !== 'shipwalk' && state !== 'landed'))) {
      this.recallForwardCamp();
    }

    // Auto-deploy outpost patrol robots when near a planet's civilizationSite
    if (walking && planet.civilizationSite && !this.outpostRobots.deployed) {
      const siteNorm = new THREE.Vector3(...planet.civilizationSite.landingZone.normal).normalize();
      const siteLocal = siteNorm.multiplyScalar(planet.surfaceRadius(siteNorm));
      if (walkCtl.posLocal.distanceToSquared(siteLocal) < 550 * 550) {
        const isRogue = planet.civilizationSite.type === 'mining-outpost';
        this.outpostRobots.deployOutpost(planet, siteLocal, {
          hounds: 2,
          gulls: 2,
          passive: !isRogue,
          friendly: false,
          patrolRadius: 26,
        });
      }
    } else if (this.outpostRobots.deployed && (!planet || this.outpostRobots.planet !== planet
      || (state !== 'walk' && state !== 'shipwalk' && state !== 'landed'))) {
      this.outpostRobots.recall();
    }

    const camWorld = this.camera.getWorldPosition(_v3);

    // Update Forward Camp transform, destructibles, colonists, and K9 companion
    if (this.campPlanet && this.campRoot.visible && navPos) {
      const cp = this.campPlanet;
      cp.localPositionToWorld(this.campOriginLocal, this.campWorldOrigin).sub(navPos);
      for (let i = 0; i < 3; i++) cp.localOffsetToWorld(this.campAxes[i], this.campWorldAxes[i]).normalize();
      const [E, N, F] = this.campWorldAxes;
      _mat4.makeBasis(E, N, F).setPosition(this.campWorldOrigin);
      this.campRoot.matrix.copy(_mat4);
      this.campRoot.matrixWorldNeedsUpdate = true;

      const env = this.getEnvironment();
      if (env?.texture) {
        for (const m of this.envMaterials) {
          if (m.envMap !== env.texture) { m.envMap = env.texture; m.needsUpdate = true; }
          m.envMapIntensity = (m.userData.baseEnvIntensity ?? 1) * (env.intensity ?? 1);
        }
      }

      if (!paused) {
        this.destructibles?.update(dt);
        const playerCamp = this.worldToCampPoint(camWorld, new THREE.Vector3());
        const tNow = RAIN_WET_UNIFORMS.uRainTime.value;
        for (const c of this.colonists) {
          if (c.mode === 'patrol') {
            const tx = c.homeX + Math.sin(tNow * 0.35 + c.phase) * 3.8;
            const tz = c.homeZ + Math.cos(tNow * 0.35 + c.phase) * 2.6;
            c.rig.update(dt, {
              pos: new THREE.Vector3(tx, this.campGroundHeight(tx, tz), tz),
              yaw: Math.atan2(Math.cos(tNow * 0.35 + c.phase) * 3.8, -Math.sin(tNow * 0.35 + c.phase) * 2.6),
              mode: 'walk',
              speed: 1.4,
              groundHeight: (x, z) => this.campGroundHeight(x, z),
            });
          } else {
            c.rig.update(dt, {
              pos: new THREE.Vector3(c.homeX, this.campGroundHeight(c.homeX, c.homeZ), c.homeZ),
              yaw: Math.atan2(playerCamp.x - c.homeX, playerCamp.z - c.homeZ),
              mode: 'idle',
              speed: 0,
              groundHeight: (x, z) => this.campGroundHeight(x, z),
            });
          }
        }
        if (this.k9Companion) {
          const k9Target = new THREE.Vector3(
            Math.cos(tNow * 0.42) * 5.2,
            0,
            6.8 + Math.sin(tNow * 0.42) * 3.4,
          );
          this.k9Companion.update(dt, {
            targetPos: k9Target,
            lookAt: playerCamp,
            groundHeight: (x, z) => this.campGroundHeight(x, z),
          });
        }
      }
    }

    // Update Outpost / Combat Robots
    if (this.outpostRobots.deployed && navPos) {
      this.outpostRobots.update(dt, {
        navPos,
        cameraWorld: camWorld,
        cameraQuat: this.camera.quaternion,
        crouching: walkCtl?.crouching || false,
        paused,
      });
    }

    // Update First-Person Lower Body
    if (walking && navPos) {
      const upLocal = _v1.copy(walkCtl.posLocal).normalize();
      const upWorld = planet.localOffsetToWorld(upLocal, new THREE.Vector3()).normalize();
      walkCtl.frame(upLocal, _east, _north);
      const fwdLocal = _v2.copy(_north).multiplyScalar(Math.cos(walkCtl.yaw)).addScaledVector(_east, Math.sin(walkCtl.yaw));
      const fwdWorld = planet.localOffsetToWorld(fwdLocal, new THREE.Vector3()).normalize();
      const velWorld = planet.localOffsetToWorld(walkCtl.hSpeed, new THREE.Vector3());
      const footWorld = _v3.copy(camWorld).addScaledVector(upWorld, -walkCtl.eyeHeight);
      const slideDirWorld = walkCtl.sliding
        ? planet.localOffsetToWorld(walkCtl.slideDir, new THREE.Vector3()).normalize()
        : null;
      const curWeaponDef = weaponsList && surfaceWeapons ? weaponsList[surfaceWeapons.index] : null;
      const curVm = surfaceWeapons?.models?.[surfaceWeapons.index]?.viewmodel;
      this.fpBody.update(paused ? 0 : dt, {
        state: 'walk',
        renderPos: footWorld,
        up: upWorld,
        forward: fwdWorld,
        pitch: walkCtl.pitch,
        eyeHeight: walkCtl.eyeHeight,
        velocity: velWorld,
        vy: walkCtl.vR,
        onGround: walkCtl.grounded,
        crouch: walkCtl.crouching,
        slide: walkCtl.sliding,
        slideDir: slideDirWorld,
        sprint: walkCtl.running,
        ads: curVm?.ads || 0,
        hasScope: !!curWeaponDef?.hasScope,
      });
    } else {
      this.fpBody.root.visible = false;
    }

    // Grenades, FX, Shield & Environmental Audio
    if (!paused) {
      this.grenadeCooldown = Math.max(0, this.grenadeCooldown - dt);
      if (this.grenades.length && navPos) this._updateGrenades(dt, navPos);

      this.sinceDamaged += dt;
      if (this.sinceDamaged > 3.8 && this.suitShield < this.maxSuitShield) {
        this.suitShield = Math.min(this.maxSuitShield, this.suitShield + dt * 22);
      }

      if (walking && planet) {
        const upLocal = _v1.copy(walkCtl.posLocal).normalize();
        const upWorld = planet.localOffsetToWorld(upLocal, new THREE.Vector3()).normalize();
        this.fx.setLighting({
          sunDir: sunDirWorld || planet.sunDirWorld,
          sunColor,
          skyColor: skyColor || planet.skyColorLin,
          up: upWorld,
        });
      }
      this.fx.update(dt, camWorld);
    }

    // Surface wind & ocean surf loops via ProceduralSfx
    const audio = this.getAudio();
    if (audio?.ready && audio.sfx) {
      let windGain = 0;
      let seaGain = 0;
      if (walking && !paused && planet) {
        const windSpd = weather?.wind?.speed || 4;
        windGain = Math.min(0.42, 0.05 + (windSpd / 28) * 0.3 + (weather?.gust || 0) * 0.12);
        if (planet.hasLiquid && planet.liquid !== 'lava') {
          const h = planet.height(_v1.copy(walkCtl.posLocal).normalize(), planet.fullMaxFreq);
          const shoreAlt = Math.max(0, h - planet.seaLevel);
          if (shoreAlt < 26) seaGain = (1 - shoreAlt / 26) * 0.36;
        }
      }
      audio.sfx.loop('wind', windGain, 0.9);
      audio.sfx.loop('sea', seaGain, 1.1);
    }

    // Update Walk-Mode Tactical HUD
    const activeIdx = surfaceWeapons ? surfaceWeapons.index : 0;
    const activeDef = weaponsList ? weaponsList[activeIdx] : null;
    const activeVm = surfaceWeapons?.models?.[activeIdx]?.viewmodel;
    this.hud.update(dt, {
      active: walking,
      paused,
      holstered: Boolean(activeVm && (activeVm.isHolstered() || activeVm.isHolstering())),
      reloading: Boolean(activeVm && activeVm.isReloading()),
      ads: activeVm ? activeVm.ads : 0,
      spread: activeVm ? activeVm.spread : 0.015,
      isShotgun: Boolean(activeDef?.isShotgun),
      shield: this.suitShield / this.maxSuitShield,
      grenades: this.grenadeCount,
      stance: walkCtl ? walkCtl.stance : 'stand',
      weapons: weaponsList,
      weaponIndex: activeIdx,
    });
  }

  stats() {
    return {
      campDeployed: Boolean(this.campPlanet && this.campRoot.visible),
      campColliders: this.campColliders.length,
      colonists: this.colonists.length,
      k9Deployed: Boolean(this.k9Companion && this.campRoot.visible),
      outpostRobots: this.outpostRobots.stats(),
      fpBodyVisible: this.fpBody.root.visible,
      grenades: this.grenadeCount,
      liveGrenades: this.grenades.length,
      suitShield: Math.round(this.suitShield),
      fx: this.fx.stats ? this.fx.stats() : null,
    };
  }

  dispose() {
    this.recallForwardCamp();
    this.outpostRobots.dispose();
    this.destructibles?.dispose();
    this._propsLib?.dispose();
    this._furnLib?.dispose();
    this.fpBody.dispose?.();
    this.fx.dispose();
    this.hud.dispose();
    this.scene.remove(this.campRoot, this.fpBody.root);
  }
}
