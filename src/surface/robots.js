// HALCYON survey units & Outpost robot patrols / combat AI.
//
// `robots-engine.js` contains the articulated "hound" quadruped and "gull"
// quad-duct drone rigs together with their full state-machine AI (vision cone,
// acoustic alert radius, patrol -> investigate -> engage -> search, attack
// token quota, weakpoint hitboxes, plasma bolts, and crash wrecks).
//
// This adapter bridges local flat tangent Y-up space to any spherical planet:
//  - builds a local tangent basis (E, N, F) at the ship pad or outpost anchor;
//  - samples `planet.height` (cached) for walkable ground, slope, water, and
//    ray-marched line-of-sight;
//  - supports both peaceful HALCYON survey mode (`passive: true`, 1 hound +
//    1 gull around the parked ship) and outpost patrol / full combat encounters
//    (`deployOutpost`, `raycastWorld`, `applyShotWorld`, `applyExplosionWorld`,
//    `notifyWeaponFireWorld`).

import * as THREE from 'three';
import { createRobotFleet, ROBOT_TUNE } from './robots-engine.js';
import { SOUND_TABLE } from '../audio/sfx-generators.js';

const NOOP = () => {};
const MAX_SLOPE_RISE = 0.65;

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _q = new THREE.Quaternion();

function emitter() {
  const handlers = new Map();
  return {
    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    emit(type, data) {
      for (const fn of handlers.get(type) || []) {
        try { fn(data); } catch { /* listener */ }
      }
    },
  };
}

export class SurveyUnits {
  constructor({
    scene,
    materials,
    getSfx = () => null,
    getEnvironment = () => null,
    onPlayerDamage = null,
    onFx = null,
    poolGulls = 1,
    poolHounds = 1,
    clearanceRadius = 12,
    name = 'survey-units',
    seed = 4207,
  }) {
    this.getEnvironment = getEnvironment;
    this.onPlayerDamage = onPlayerDamage;
    this.onFx = onFx;
    this.poolGulls = poolGulls;
    this.poolHounds = poolHounds;
    this.clearanceRadius = clearanceRadius;
    this.envMaterials = new Set();
    this.scene = scene;
    this.materials = materials;
    this.getSfx = getSfx;
    this.seed = seed;
    this.root = new THREE.Group();
    this.root.name = name;
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    // Layer-0-only world subtree: let ForegroundPass skip the whole robot
    // hierarchy during weapon/ship foreground layer passes.
    this.root.userData.worldLayerOnly = true;
    scene.add(this.root);
    this.fleet = null;
    this.events = null;
    this.planet = null;
    this.friendly = true;
    this.origin = new THREE.Vector3();      // planet-local anchor point
    this.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]; // planet-local e, n, f
    this.worldAxes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    this.worldOrigin = new THREE.Vector3();
    this.heights = new Map();
    this.voices = new Set();
    this.camera = { position: new THREE.Vector3() };
    this.cameraQuat = new THREE.Quaternion();
    this.player = {
      pos: new THREE.Vector3(),
      eye: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      speed: 0,
      alive: true,
      crouching: false,
      damage: (amount, fromLocal) => {
        if (!this.onPlayerDamage) return;
        const fromWorld = fromLocal ? this.localToWorldPoint(fromLocal, new THREE.Vector3()) : null;
        this.onPlayerDamage(amount, fromWorld);
      },
    };
    this.lastEye = new THREE.Vector3();
    this.units = [];
  }

  get deployed() { return !!this.planet; }

  // --------------------------------------------------------------- coordinate transforms

  localToPlanet(x, y, z, out) {
    const [e, n, f] = this.axes;
    return out.copy(this.origin).addScaledVector(e, x).addScaledVector(n, y).addScaledVector(f, z);
  }

  worldToLocalPoint(worldPt, out = new THREE.Vector3()) {
    const [E, N, F] = this.worldAxes;
    _v.copy(worldPt).sub(this.worldOrigin);
    return out.set(_v.dot(E), _v.dot(N), _v.dot(F));
  }

  worldToLocalDir(worldDir, out = new THREE.Vector3()) {
    const [E, N, F] = this.worldAxes;
    return out.set(worldDir.dot(E), worldDir.dot(N), worldDir.dot(F)).normalize();
  }

  localToWorldPoint(localPt, out = new THREE.Vector3()) {
    const [E, N, F] = this.worldAxes;
    return out.copy(this.worldOrigin)
      .addScaledVector(E, localPt.x)
      .addScaledVector(N, localPt.y)
      .addScaledVector(F, localPt.z);
  }

  localToWorldDir(localDir, out = new THREE.Vector3()) {
    const [E, N, F] = this.worldAxes;
    return out.set(0, 0, 0)
      .addScaledVector(E, localDir.x)
      .addScaledVector(N, localDir.y)
      .addScaledVector(F, localDir.z)
      .normalize();
  }

  groundHeight(x, z) {
    const key = `${Math.round(x * 4)}|${Math.round(z * 4)}`;
    let h = this.heights.get(key);
    if (h === undefined) {
      const p = this.planet;
      if (!p) return 0;
      const dir = this.localToPlanet(x, 0, z, _v).normalize();
      const r = p.R + p.height(dir, p.fullMaxFreq);
      h = _w.copy(dir).multiplyScalar(r).sub(this.origin).dot(this.axes[1]);
      if (this.heights.size > 40000) this.heights.clear();
      this.heights.set(key, h);
    }
    return h;
  }

  underwater(x, z) {
    const p = this.planet;
    if (!p || !p.hasLiquid) return false;
    const dir = this.localToPlanet(x, 0, z, _v).normalize();
    return p.height(dir, p.fullMaxFreq) < p.seaLevel + 0.1;
  }

  makePhysics() {
    const self = this;
    const walkable = (x, z) => {
      if (self.clearanceRadius > 0 && Math.hypot(x, z) < self.clearanceRadius) return false;
      const h = self.groundHeight(x, z);
      const slope = Math.max(
        Math.abs(self.groundHeight(x + 0.5, z) - h),
        Math.abs(self.groundHeight(x, z + 0.5) - h),
      ) * 2;
      if (slope > MAX_SLOPE_RISE) return false;
      return !self.underwater(x, z);
    };
    const clearOfPad = (a, b) => {
      if (self.clearanceRadius <= 0) return true;
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / len2));
      return Math.hypot(a.x + dx * t, a.z + dz * t) >= self.clearanceRadius;
    };
    const raycast = (from, dir, max = 500) => {
      const step = 0.35;
      let prevAbove = from.y - self.groundHeight(from.x, from.z);
      if (prevAbove < 0) return null;
      for (let d = step; d <= Math.min(max, 140); d += step) {
        const x = from.x + dir.x * d, y = from.y + dir.y * d, z = from.z + dir.z * d;
        const above = y - self.groundHeight(x, z);
        if (above <= 0) {
          const hit = d - step * (above / (above - prevAbove));
          const point = new THREE.Vector3(from.x + dir.x * hit, from.y + dir.y * hit, from.z + dir.z * hit);
          const hx = self.groundHeight(point.x + 0.25, point.z) - self.groundHeight(point.x - 0.25, point.z);
          const hz = self.groundHeight(point.x, point.z + 0.25) - self.groundHeight(point.x, point.z - 0.25);
          return {
            dist: hit,
            point,
            normal: new THREE.Vector3(-hx * 2, 1, -hz * 2).normalize(),
            surface: 'concrete',
            box: null,
          };
        }
        prevAbove = above;
      }
      return null;
    };
    return {
      groundHeight: (x, z) => self.groundHeight(x, z),
      raycast,
      lineOfSight(a, b) {
        _v.subVectors(b, a);
        const len = _v.length();
        return len < 1e-4 ? true : !raycast(a, _v.multiplyScalar(1 / len), len - 0.05);
      },
      nav: {
        cell: 0.5,
        isWalkable: walkable,
        findPath(from, to) {
          if (!walkable(to.x, to.z) || !clearOfPad(from, to)) return null;
          return [new THREE.Vector3(to.x, 0, to.z)];
        },
        randomPoint(center, radius) {
          for (let i = 0; i < 24; i++) {
            const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
            const x = center.x + Math.cos(a) * r, z = center.z + Math.sin(a) * r;
            if (walkable(x, z)) return new THREE.Vector3(x, 0, z);
          }
          return new THREE.Vector3(center.x, 0, center.z);
        },
        clearLine: (a, b) => clearOfPad(a, b),
      },
    };
  }

  makeAudio() {
    const self = this;
    return {
      loop(name, { pos, gain = 1 } = {}) {
        const def = SOUND_TABLE[name] || {};
        const entry = {
          name,
          pos: new THREE.Vector3().copy(pos || _v.set(0, 0, 0)),
          gain,
          pitch: 1,
          voice: null,
          ref: def.ref || 4,
          roll: def.roll || 1,
        };
        self.voices.add(entry);
        return {
          setPos: (p) => entry.pos.copy(p),
          setGain: (g) => { entry.gain = g; },
          setPitch: (p) => { entry.pitch = p; },
          stop: () => { entry.voice?.stop(); self.voices.delete(entry); },
        };
      },
    };
  }

  playOneShotLocal(name, localPos, { gain = 0.85, pitch = 1 } = {}) {
    const sfx = this.getSfx();
    if (!sfx) return;
    const def = SOUND_TABLE[name] || {};
    let att = 1;
    if (localPos) {
      const dist = Math.max(0.8, localPos.distanceTo(this.camera.position));
      att = Math.min(1, Math.pow((def.ref || 6) / dist, def.roll || 1));
    }
    if (att * gain < 0.015) return;
    sfx.play(name, { gain: gain * att, pitch });
  }

  makeFxHooks() {
    const self = this;
    return {
      sparks(pos, dirOrNrm, count = 10) {
        if (!self.onFx || !pos) return;
        self.onFx('sparks', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          normal: dirOrNrm ? self.localToWorldDir(dirOrNrm, new THREE.Vector3()) : new THREE.Vector3(0, 1, 0),
          count,
        });
      },
      smoke(pos, opts = {}) {
        if (!self.onFx || !pos) return;
        self.onFx('smoke', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          ...opts,
        });
      },
      explosion(pos, scale = 1.2) {
        if (!self.onFx || !pos) return;
        self.onFx('explosion', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          scale,
        });
      },
      debris(pos, opts = {}) {
        if (!self.onFx || !pos) return;
        self.onFx('sparks', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          normal: self.worldAxes[1].clone(),
          count: (opts.count || 3) * 3,
        });
      },
      muzzleFlash(pos, dir, opts = {}) {
        if (!self.onFx || !pos) return;
        self.onFx('muzzleFlash', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          dir: dir ? self.localToWorldDir(dir, new THREE.Vector3()) : null,
          ...opts,
        });
      },
      tracer(from, to, opts = {}) {
        if (!self.onFx || !from || !to) return;
        self.onFx('tracer', {
          from: self.localToWorldPoint(from, new THREE.Vector3()),
          to: self.localToWorldPoint(to, new THREE.Vector3()),
          ...opts,
        });
      },
      dust(pos, normal) {
        if (!self.onFx || !pos) return;
        self.onFx('impact', {
          point: self.localToWorldPoint(pos, new THREE.Vector3()),
          normal: normal ? self.localToWorldDir(normal, new THREE.Vector3()) : self.worldAxes[1].clone(),
          surface: 'dirt',
          scale: 0.65,
        });
      },
    };
  }

  makeCombatHooks(physics) {
    const self = this;
    return {
      enemyShot(muzzleLocal, dirLocal, { damage = 7, range = 200 } = {}) {
        const hitTerrain = physics.raycast(muzzleLocal, dirLocal, range);
        const maxDist = hitTerrain ? hitTerrain.dist : range;
        const p = self.player;
        if (p && p.alive) {
          _a.copy(p.pos);
          _a.y += 1.0;
          const along = _a.sub(muzzleLocal).dot(dirLocal);
          if (along > 0 && along < maxDist) {
            _b.copy(muzzleLocal).addScaledVector(dirLocal, along);
            const dy = Math.abs(_b.y - (p.pos.y + 0.92));
            const dr = Math.hypot(_b.x - p.pos.x, _b.z - p.pos.z);
            if (dr < 0.42 && dy < 0.95) {
              p.damage(damage, muzzleLocal);
              return true;
            }
            if (dr < 1.9 && dy < 1.8) {
              self.playOneShotLocal('whiz', _b, { gain: 0.55, pitch: 0.95 + Math.random() * 0.12 });
            }
          }
        }
        if (hitTerrain && self.onFx) {
          self.onFx('impact', {
            point: self.localToWorldPoint(hitTerrain.point, new THREE.Vector3()),
            normal: self.localToWorldDir(hitTerrain.normal, new THREE.Vector3()),
            surface: 'concrete',
            scale: 0.8,
          });
        }
        return false;
      },
      explode(posLocal, radius = 5, damage = 65) {
        self.playOneShotLocal('explosion', posLocal, { gain: 0.95 });
        const p = self.player;
        if (p && p.alive) {
          const d = _a.copy(p.pos).setY(p.pos.y + 1).distanceTo(posLocal);
          if (d < radius) p.damage(damage * 0.45 * (1 - d / radius), posLocal);
        }
      },
    };
  }

  ensureFleet() {
    if (this.fleet) return;
    const t0 = performance.now();
    ROBOT_TUNE.poolGulls = this.poolGulls;
    ROBOT_TUNE.poolHounds = this.poolHounds;
    this.events = emitter();
    const physics = this.makePhysics();
    this.fleet = createRobotFleet({
      params: { eseed: this.seed },
      scene: this.root,
      mats: this.materials,
      events: this.events,
      player: this.player,
      physics,
      camera: this.camera,
      render: null,
      fx: this.makeFxHooks(),
      combat: this.makeCombatHooks(physics),
      audio: this.makeAudio(),
      level: { coverPoints: [] },
    });

    // Wire synthesized robot foley events
    this.events.on('enemy:alert', (e) => {
      this.playOneShotLocal('alert', e?.enemy?.pos, { gain: 0.72 });
    });
    this.events.on('enemy:telegraph', (e) => {
      this.playOneShotLocal('telegraph', e?.pos, { gain: 0.78 });
    });
    this.events.on('enemy:fire', (e) => {
      const sound = e?.type === 'gull' ? 'gull_fire' : 'hound_fire';
      this.playOneShotLocal(sound, e?.pos, { gain: 0.85, pitch: 0.96 + Math.random() * 0.08 });
    });
    this.events.on('enemy:melee', (e) => {
      this.playOneShotLocal('hound_fire', e?.pos, { gain: 0.9, pitch: 0.82 });
      this.player.damage(18, e?.pos);
    });
    this.events.on('enemy:step', (e) => {
      if (e?.type === 'hound') {
        this.playOneShotLocal('hound_step', e?.pos, { gain: e.crash ? 0.8 : 0.35, pitch: 0.94 + Math.random() * 0.12 });
      }
    });
    this.events.on('enemy:killed', (e) => {
      const sound = e?.type === 'gull' ? 'gull_die' : 'hound_die';
      this.playOneShotLocal(sound, e?.pos, { gain: 0.95 });
    });

    console.info(`[${this.root.name}] robots built in ${(performance.now() - t0).toFixed(0)} ms`);
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (m?.isMeshStandardMaterial) {
          m.userData.surveyBaseEnv = m.envMapIntensity ?? 1;
          this.envMaterials.add(m);
        }
      }
    });
  }

  async prewarm({ renderer, camera, scene, target = null, prepare = null }) {
    if (this.fleet || this.prewarming || !this.materials) return;
    this.prewarming = true;
    try {
      await this.materials.prepareAsync?.(['armor_white', 'gunmetal']);
      if (!this.fleet) this.ensureFleet();
      if (renderer?.compileAsync && !this.deployed) {
        const compileFleet = () => {
          const hidden = [];
          const prevTarget = target ? renderer.getRenderTarget?.() : null;
          const prevFace = target ? renderer.getActiveCubeFace?.() : 0;
          const prevMip = target ? renderer.getActiveMipmapLevel?.() : 0;
          this.root.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
          try {
            if (target && renderer.setRenderTarget) renderer.setRenderTarget(target);
            return renderer.compileAsync(this.root, camera, scene);
          } finally {
            if (target && renderer.setRenderTarget) renderer.setRenderTarget(prevTarget, prevFace, prevMip);
            for (const o of hidden) o.visible = false;
          }
        };
        await (typeof prepare === 'function' ? prepare(compileFleet) : compileFleet());
      }
    } catch (error) {
      console.warn('[survey] prewarm failed (robots will build on landing)', error);
    } finally {
      this.prewarming = false;
    }
  }

  _anchorFrame(planet, anchorLocal) {
    this.planet = planet;
    this.origin.copy(anchorLocal);
    const [e, n, f] = this.axes;
    n.copy(anchorLocal).normalize();
    e.crossVectors(Math.abs(n.y) < 0.9 ? _v.set(0, 1, 0) : _v.set(1, 0, 0), n).normalize();
    f.crossVectors(e, n).normalize();
    this.heights.clear();
  }

  // Deploy friendly HALCYON survey units around the parked ship.
  deploy(planet, padLocal) {
    if (this.planet === planet && this.origin.distanceToSquared(padLocal) < 1) return;
    this.recall();
    this.friendly = true;
    this._anchorFrame(planet, padLocal);
    this.ensureFleet();
    this.units = [
      this.fleet.spawn('hound', new THREE.Vector3(17, 0, 5), { passive: true, patrolRadius: 7, yaw: 1.2 }),
      this.fleet.spawn('gull', new THREE.Vector3(-17, this.groundHeight(-17, 9) + 5, 9), { passive: true, patrolRadius: 5 }),
    ].filter(Boolean);
    this.root.visible = true;
  }

  // Deploy outpost patrol / combat fleet around a surface site or encounter point.
  deployOutpost(planet, anchorLocal, {
    hounds = 2,
    gulls = 2,
    passive = false,
    friendly = false,
    patrolRadius = 22,
  } = {}) {
    this.recall();
    this.friendly = friendly;
    this._anchorFrame(planet, anchorLocal);
    this.ensureFleet();
    const spawned = [];
    const totalHounds = Math.min(hounds, this.poolHounds);
    const totalGulls = Math.min(gulls, this.poolGulls);
    for (let i = 0; i < totalHounds; i++) {
      const ang = (i / Math.max(1, totalHounds)) * Math.PI * 2 + 0.4;
      const dist = Math.max(this.clearanceRadius + 4, 12 + i * 6);
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const u = this.fleet.spawn('hound', new THREE.Vector3(x, 0, z), {
        passive,
        patrolRadius,
        yaw: ang + Math.PI * 0.5,
      });
      if (u) spawned.push(u);
    }
    for (let i = 0; i < totalGulls; i++) {
      const ang = (i / Math.max(1, totalGulls)) * Math.PI * 2 + 1.9;
      const dist = Math.max(this.clearanceRadius + 5, 15 + i * 7);
      const x = Math.cos(ang) * dist, z = Math.sin(ang) * dist;
      const u = this.fleet.spawn('gull', new THREE.Vector3(x, this.groundHeight(x, z) + 6.5 + i * 1.5, z), {
        passive,
        patrolRadius: patrolRadius * 0.85,
      });
      if (u) spawned.push(u);
    }
    this.units = spawned;
    this.root.visible = spawned.length > 0;
    return spawned.length;
  }

  // Raycast active robot hitboxes (weakpoint + armor) in camera-relative world space.
  raycastWorld(originWorld, dirWorld, maxDist = 220) {
    if (!this.deployed || !this.fleet || !this.root.visible) return null;
    const origL = this.worldToLocalPoint(originWorld, _a);
    const dirL = this.worldToLocalDir(dirWorld, _b);
    const hit = this.fleet.raycast(origL, dirL, maxDist);
    if (!hit) return null;
    return {
      dist: hit.dist,
      point: this.localToWorldPoint(hit.point, new THREE.Vector3()),
      normal: hit.normal ? this.localToWorldDir(hit.normal, new THREE.Vector3()) : dirWorld.clone().negate(),
      part: hit.part || 'body',
      weak: hit.part === 'weak',
      enemy: hit.enemy,
      localPoint: hit.point.clone(),
      localDir: dirL.clone(),
    };
  }

  applyShotWorld(originWorld, dirWorld, { damage = 28, range = 220 } = {}) {
    const hit = this.raycastWorld(originWorld, dirWorld, range);
    if (!hit) return null;
    // Friendly ship survey units spark harmlessly without dying or turning hostile
    if (this.friendly) {
      this.playOneShotLocal('impact_metal', hit.localPoint, { gain: 0.7 });
      return {
        point: hit.point,
        normal: hit.normal,
        dist: hit.dist,
        surface: 'metal',
        part: hit.part,
        weak: false,
        killed: false,
        friendly: true,
      };
    }
    // Outpost patrol units wake up and engage if shot!
    if (hit.enemy.passive) {
      for (const u of this.units) if (u.alive) u.passive = false;
      this.fleet.alert(this.player.pos, 65);
    }
    const mult = hit.weak ? 2.2 : 1;
    const killed = hit.enemy.damage(damage * mult, hit.localPoint, hit.localDir, hit.part) === true;
    this.playOneShotLocal('impact_enemy', hit.localPoint, { gain: 0.85, pitch: hit.weak ? 1.18 : 1.0 });
    return {
      point: hit.point,
      normal: hit.normal,
      dist: hit.dist,
      surface: 'enemy',
      part: hit.part,
      weak: hit.weak,
      killed,
      friendly: false,
    };
  }

  applyExplosionWorld(centerWorld, radius = 6, damage = 95) {
    if (!this.deployed || !this.fleet || this.friendly) return 0;
    const cLocal = this.worldToLocalPoint(centerWorld, new THREE.Vector3());
    let hits = 0;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = u.pos.distanceTo(cLocal);
      if (d < radius) {
        u.passive = false;
        const dir = u.pos.clone().sub(cLocal).normalize();
        u.damage(damage * (1 - d / radius * 0.75), u.pos, dir, 'body');
        hits++;
      }
    }
    this.events?.emit('explosion', { pos: cLocal });
    return hits;
  }

  notifyWeaponFireWorld(originWorld) {
    if (!this.deployed || !this.events || this.friendly) return;
    const origL = this.worldToLocalPoint(originWorld, new THREE.Vector3());
    this.events.emit('weapon:fire', { origin: origL });
  }

  recall() {
    this.fleet?.clear();
    for (const entry of this.voices) entry.voice?.stop();
    this.voices.clear();
    this.units = [];
    this.planet = null;
    this.root.visible = false;
  }

  update(dt, { navPos, cameraWorld, cameraQuat, crouching = false, paused = false } = {}) {
    const p = this.planet;
    if (!p || !this.fleet) return;
    p.localPositionToWorld(this.origin, this.worldOrigin).sub(navPos);
    for (let i = 0; i < 3; i++) p.localOffsetToWorld(this.axes[i], this.worldAxes[i]).normalize();
    const [E, N, F] = this.worldAxes;
    this.root.matrix.makeBasis(E, N, F).setPosition(this.worldOrigin);
    this.root.matrixWorldNeedsUpdate = true;
    if (cameraQuat) this.cameraQuat.copy(cameraQuat);

    _v.copy(cameraWorld).sub(this.worldOrigin);
    this.camera.position.set(_v.dot(E), _v.dot(N), _v.dot(F));
    this.player.eye.copy(this.camera.position);
    this.player.pos.copy(this.camera.position);
    this.player.pos.y -= crouching ? 1.08 : 1.7;
    this.player.crouching = !!crouching;
    if (dt > 0) {
      this.player.vel.subVectors(this.player.eye, this.lastEye).multiplyScalar(1 / dt);
      this.player.speed = Math.hypot(this.player.vel.x, this.player.vel.z);
    }
    this.lastEye.copy(this.player.eye);

    const env = this.getEnvironment();
    if (env?.texture) {
      for (const m of this.envMaterials) {
        if (m.envMap !== env.texture) { m.envMap = env.texture; m.needsUpdate = true; }
        m.envMapIntensity = m.userData.surveyBaseEnv * (env.intensity ?? 1);
      }
    }
    if (!paused) this.fleet.update(dt);
    this.updateVoices(cameraQuat, paused);
  }

  updateVoices(cameraQuat, paused) {
    const sfx = this.getSfx();
    if (!sfx) return;
    const [E, N, F] = this.worldAxes;
    _w.set(1, 0, 0).applyQuaternion(cameraQuat || _q.identity());
    const rx = _w.dot(E), ry = _w.dot(N), rz = _w.dot(F);
    for (const entry of this.voices) {
      if (!entry.voice) entry.voice = sfx.voice(entry.name);
      if (!entry.voice) continue;
      _v.copy(entry.pos).sub(this.camera.position);
      const dist = Math.max(0.5, _v.length());
      const att = Math.min(1, Math.pow(entry.ref / dist, entry.roll));
      entry.voice.setGain(paused ? 0 : entry.gain * att);
      entry.voice.setPitch(entry.pitch);
      entry.voice.setPan((_v.x * rx + _v.y * ry + _v.z * rz) / dist * 0.8);
    }
  }

  stats() {
    return {
      deployed: this.deployed,
      friendly: this.friendly,
      alive: this.fleet ? this.fleet.aliveCount() : 0,
      units: this.units.map((u) => ({
        type: u.type,
        mode: u.mode,
        alive: u.alive !== false,
        hp: u.hp,
        pos: u.pos.toArray().map((v) => +v.toFixed(2)),
      })),
      voices: this.voices.size,
      tris: this.fleet?.debug?.tris || null,
    };
  }

  dispose() {
    this.recall();
    this.scene.remove(this.root);
  }
}
