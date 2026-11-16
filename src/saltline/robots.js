// HALCYON survey units: one Saltline "hound" quadruped and one "gull" drone
// that deploy around the parked ship and patrol it while the player is on the
// surface. The robot code (robots-engine.js) is Saltline's, run in passive mode
// (patrol only, no sensing or combat); this adapter gives it the flat world it
// was written for:
//
//  - a local tangent frame at the ship pad: x/z on the ground plane, y along
//    the planet normal. The robots' root group is re-placed in world space
//    every frame (the game keeps the camera at the origin).
//  - "physics": groundHeight from the planet height function (cached), a
//    marching raycast against it, slope/sea walkability with the ship's
//    footprint blocked, straight-line paths that refuse to cross the ship.
//  - the player as seen in that frame (robots glance at you), positional
//    rotor/servo loops, and no-op fx/combat hooks.
import * as THREE from 'three';
import { createRobotFleet, ROBOT_TUNE } from './robots-engine.js';
import { SOUND_TABLE } from './sfx-generators.js';

const NOOP = () => {};
const NOOP_HOOKS = new Proxy({}, { get: () => NOOP });
const SHIP_CLEARANCE = 12;      // m around the pad the robots keep out of (the HALCYON is ~20 m long)
const MAX_SLOPE_RISE = 0.6;     // m of rise over 1 m: steeper ground is blocked

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion();

function emitter() {
  const handlers = new Map();
  return {
    on(type, fn) { if (!handlers.has(type)) handlers.set(type, []); handlers.get(type).push(fn); },
    emit(type, data) { for (const fn of handlers.get(type) || []) { try { fn(data); } catch { /* listener */ } } },
  };
}

export class SurveyUnits {
  // getSfx(): the SaltlineSfx instance once WebAudio is unlocked (or null)
  // getEnvironment(): { texture, intensity } for reflections (the weapon's
  // outdoor sky probe); Saltline's materials are mostly metal and go black
  // under the dark space environment world objects otherwise get.
  constructor({ scene, materials, getSfx = () => null, getEnvironment = () => null, seed = 4207 }) {
    this.getEnvironment = getEnvironment;
    this.envMaterials = new Set();
    this.scene = scene;
    this.materials = materials;
    this.getSfx = getSfx;
    this.seed = seed;
    this.root = new THREE.Group();
    this.root.name = 'survey-units';
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    scene.add(this.root);
    this.fleet = null;
    this.planet = null;
    this.origin = new THREE.Vector3();      // planet-local pad point
    this.axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]; // planet-local e, n, f
    this.worldAxes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    this.worldOrigin = new THREE.Vector3();
    this.heights = new Map();
    this.voices = new Set();
    this.camera = { position: new THREE.Vector3() };
    this.player = {
      pos: new THREE.Vector3(), eye: new THREE.Vector3(), vel: new THREE.Vector3(),
      speed: 0, alive: true, crouching: false, damage: NOOP,
    };
    this.lastEye = new THREE.Vector3();
    this.units = [];
  }

  get deployed() { return !!this.planet; }

  // --------------------------------------------------------------- frame

  localToPlanet(x, y, z, out) {
    const [e, n, f] = this.axes;
    return out.copy(this.origin).addScaledVector(e, x).addScaledVector(n, y).addScaledVector(f, z);
  }

  groundHeight(x, z) {
    const key = `${Math.round(x * 4)}|${Math.round(z * 4)}`;
    let h = this.heights.get(key);
    if (h === undefined) {
      const p = this.planet;
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
    if (!p.hasLiquid) return false;
    const dir = this.localToPlanet(x, 0, z, _v).normalize();
    return p.height(dir, p.fullMaxFreq) < p.seaLevel + 0.1;
  }

  makePhysics() {
    const self = this;
    const walkable = (x, z) => {
      if (Math.hypot(x, z) < SHIP_CLEARANCE) return false;
      const h = self.groundHeight(x, z);
      const slope = Math.max(Math.abs(self.groundHeight(x + 0.5, z) - h), Math.abs(self.groundHeight(x, z + 0.5) - h)) * 2;
      if (slope > MAX_SLOPE_RISE) return false;
      return !self.underwater(x, z);
    };
    const clearOfShip = (a, b) => {
      // closest approach of segment a-b to the pad centre
      const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1e-6;
      const t = Math.max(0, Math.min(1, -(a.x * dx + a.z * dz) / len2));
      return Math.hypot(a.x + dx * t, a.z + dz * t) >= SHIP_CLEARANCE;
    };
    const raycast = (from, dir, max = 500) => {
      const step = 0.35;
      let prevAbove = from.y - self.groundHeight(from.x, from.z);
      if (prevAbove < 0) return null;
      for (let d = step; d <= Math.min(max, 120); d += step) {
        const x = from.x + dir.x * d, y = from.y + dir.y * d, z = from.z + dir.z * d;
        const above = y - self.groundHeight(x, z);
        if (above <= 0) {
          const hit = d - step * (above / (above - prevAbove));
          const point = new THREE.Vector3(from.x + dir.x * hit, from.y + dir.y * hit, from.z + dir.z * hit);
          const hx = self.groundHeight(point.x + 0.25, point.z) - self.groundHeight(point.x - 0.25, point.z);
          const hz = self.groundHeight(point.x, point.z + 0.25) - self.groundHeight(point.x, point.z - 0.25);
          return { dist: hit, point, normal: new THREE.Vector3(-hx * 2, 1, -hz * 2).normalize(), surface: 'concrete', box: null };
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
          if (!walkable(to.x, to.z) || !clearOfShip(from, to)) return null;
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
        clearLine: (a, b) => clearOfShip(a, b),
      },
    };
  }

  makeAudio() {
    const self = this;
    return {
      loop(name, { pos, gain = 1 } = {}) {
        const def = SOUND_TABLE[name] || {};
        const entry = { name, pos: new THREE.Vector3().copy(pos || _v.set(0, 0, 0)), gain, pitch: 1, voice: null, ref: def.ref || 4, roll: def.roll || 1 };
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

  ensureFleet() {
    if (this.fleet) return;
    const t0 = performance.now();
    // Saltline pre-allocates combat pools (10 drones, 8 hounds); the survey
    // detail needs one of each.
    ROBOT_TUNE.poolGulls = 1;
    ROBOT_TUNE.poolHounds = 1;
    this.events = emitter();
    this.fleet = createRobotFleet({
      params: { eseed: this.seed },
      scene: this.root,
      mats: this.materials,
      events: this.events,
      player: this.player,
      physics: this.makePhysics(),
      camera: this.camera,
      render: null,
      fx: NOOP_HOOKS,
      combat: NOOP_HOOKS,
      audio: this.makeAudio(),
      level: { coverPoints: [] },
    });
    console.info(`[survey] robots built in ${(performance.now() - t0).toFixed(0)} ms`);
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

  // Build the robots ahead of the first landing without a hitch: bake their
  // texture sets behind a parallel shader compile, build the rigs (hidden),
  // then compile their render programs asynchronously against the real scene.
  async prewarm({ renderer, camera, scene }) {
    if (this.fleet || this.prewarming || !this.materials) return;
    this.prewarming = true;
    try {
      await this.materials.prepareAsync?.(['armor_white', 'gunmetal']);
      if (!this.fleet) this.ensureFleet();
      if (renderer?.compileAsync && !this.deployed) {
        const hidden = [];
        this.root.traverse((o) => { if (!o.visible) { hidden.push(o); o.visible = true; } });
        let pending;
        try { pending = renderer.compileAsync(this.root, camera, scene); }
        finally { for (const o of hidden) o.visible = false; }
        await pending;
      }
    } catch (error) {
      console.warn('[survey] prewarm failed (robots will build on landing)', error);
    } finally {
      this.prewarming = false;
    }
  }

  // Deploy around a parked ship. `localQuat` (the ship's parked orientation)
  // only picks which way the units start.
  deploy(planet, padLocal) {
    if (this.planet === planet && this.origin.distanceToSquared(padLocal) < 1) return;
    this.recall();
    this.planet = planet;
    this.origin.copy(padLocal);
    const [e, n, f] = this.axes;
    n.copy(padLocal).normalize();
    e.crossVectors(Math.abs(n.y) < 0.9 ? _v.set(0, 1, 0) : _v.set(1, 0, 0), n).normalize();
    f.crossVectors(e, n).normalize();
    this.heights.clear();
    this.ensureFleet();
    this.units = [
      this.fleet.spawn('hound', new THREE.Vector3(17, 0, 5), { passive: true, patrolRadius: 7, yaw: 1.2 }),
      // the drone patrols well clear of the hull, at mast height
      this.fleet.spawn('gull', new THREE.Vector3(-17, this.groundHeight(-17, 9) + 5, 9), { passive: true, patrolRadius: 5 }),
    ].filter(Boolean);
    this.root.visible = true;
  }

  recall() {
    this.fleet?.clear();
    for (const entry of this.voices) entry.voice?.stop();
    this.voices.clear();
    this.units = [];
    this.planet = null;
    this.root.visible = false;
  }

  // navPos: the camera's universe position (scene space is universe minus
  // navPos); cameraWorld: the camera's scene-space position (usually ~0).
  update(dt, { navPos, cameraWorld, cameraQuat, paused = false } = {}) {
    const p = this.planet;
    if (!p || !this.fleet) return;
    // place the local frame in world space (camera-relative world)
    p.localPositionToWorld(this.origin, this.worldOrigin).sub(navPos);
    for (let i = 0; i < 3; i++) p.localOffsetToWorld(this.axes[i], this.worldAxes[i]).normalize();
    const [E, N, F] = this.worldAxes;
    this.root.matrix.makeBasis(E, N, F).setPosition(this.worldOrigin);
    this.root.matrixWorldNeedsUpdate = true;

    // camera / player in the local frame
    _v.copy(cameraWorld).sub(this.worldOrigin);
    this.camera.position.set(_v.dot(E), _v.dot(N), _v.dot(F));
    this.player.eye.copy(this.camera.position);
    this.player.pos.copy(this.camera.position);
    this.player.pos.y -= 1.7;
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
    // camera right vector in the local frame
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
      units: this.units.map((u) => ({ type: u.type, mode: u.mode, pos: u.pos.toArray().map((v) => +v.toFixed(2)) })),
      voices: this.voices.size,
      tris: this.fleet?.debug?.tris || null,
    };
  }

  dispose() {
    this.recall();
    this.scene.remove(this.root);
  }
}
