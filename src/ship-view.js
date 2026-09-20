// Ship view & interior controller — the HALCYON's first-person layer.
//
// Ported from 3aaa-spaceship-flight-prototype/src/game/engine.ts (cockpit /
// walk / seat-move / ramp logic), re-pointed at 深空's camera-centric model:
// there, the ship was the flight body and the camera hung off it; here the
// camera (nav) is the flight body and the ship is a camera-relative model.
// The two are bridged with a ship-local camera pose:
//
//     nav  = anchor ∘ localCam        (anchor = the hull's universe pose)
//
// In cockpit view nav is primary (flight physics integrates it) and the
// anchor is derived; in interior-walk the anchor is primary (the hull keeps
// drifting on its standing velocity) and nav is derived. Both directions use
// the same identity, so mode handoffs are continuous by construction.
//
// Kept from the demo, with its original constants: the 0.8 s smootherstep
// sit/stand camera move with its +6 cm arc, the per-mode FOV targets, the
// damped ramp animation, walkable-room collision with wall sliding, head
// bob, and the mouse free-look.

import * as THREE from 'three';
import { keys } from './controls.js';

const clamp = THREE.MathUtils.clamp;
const damp = (a, b, l, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-l * dt));
/** seconds the sit / stand camera move takes (demo pacing) */
const SEAT_MOVE = 0.8;

/* walkable region, inset by the player radius */
const PR = 0.26;
function walkVolumes(def) {
  return {
    walk: def.rooms.map((r) => ({ x0: r.x0 + PR, x1: r.x1 - PR, z0: r.z0 + PR, z1: r.z1 - PR })),
    block: def.blocks.map((b) => ({ x0: b.x0 - PR, x1: b.x1 + PR, z0: b.z0 - PR, z1: b.z1 + PR })),
  };
}
function walkableIn(V, x, z) {
  let inside = false;
  for (const r of V.walk) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) { inside = true; break; }
  if (!inside) return false;
  for (const b of V.block) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return false;
  return true;
}

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _e = new THREE.Euler();
const _targetP = new THREE.Vector3();
const _targetQ = new THREE.Quaternion();

/** cameraWorld = hullWorld * cameraLocal, so hullWorld = cameraWorld * cameraLocal^-1. */
export function solveHullQuaternion(cameraWorld, cameraLocal, target = new THREE.Quaternion()) {
  return target.copy(cameraWorld).multiply(_qt.copy(cameraLocal).invert()).normalize();
}

export function cockpitShakeAmplitude(drive, atmosphere) {
  return clamp(drive, 0, 1) * (0.00016 + clamp(atmosphere, 0, 1) * 0.00335);
}

export class ShipView {
  /**
   * @param {import('./effects.js').Ship} ship
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(ship, camera) {
    this.ship = ship;
    this.camera = camera;
    this.def = ship.def;
    this.vol = walkVolumes(this.def);
    this.onHint = null;            // optional (text) => void

    /* view mode: 'chase' (third person, 深空's own) | 'cockpit' */
    this.viewMode = 'chase';
    /* interior walk active — the camera is a person inside the hull */
    this.shipwalk = false;
    /* V-toggle group-pose blend, 1 = settled */
    this.viewBlend = 1;
    this.viewBlendFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

    /* sit / stand camera move: seatT reaches 1 when it is over */
    this.seatT = 1;
    this.seatArrived = null;       // 'walk' | 'cockpit'
    this.seatFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.seatTo = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

    /* interior walk state (ship-local) */
    this.walkPos = new THREE.Vector3(0, 0, -6.4);
    this.walkYaw = Math.PI;
    this.walkPitch = 0;
    this.bob = 0;

    /* cockpit free look (RMB) + smoothed hull angular velocity for tilt */
    this.freeYaw = 0;
    this.freePitch = 0;
    this.rmb = false;
    this.angVel = new THREE.Vector3();
    this.prevQuat = new THREE.Quaternion();

    /* cargo ramp */
    this.rampT = 0;
    this.rampTarget = 0;
    this.rampMax = 1;

    /* hull anchor while the interior owns the camera */
    this.anchorPos = new THREE.Vector3();
    this.anchorQuat = new THREE.Quaternion();

    this.t = 0;
    this.bind();
  }

  bind() {
    const dom = this.camera.domElement ?? document.querySelector('canvas');
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      if (this.shipwalk && this.seatT >= 1) {
        this.walkYaw -= e.movementX * 0.0022;
        this.walkPitch = clamp(this.walkPitch - e.movementY * 0.0022, -1.4, 1.4);
      } else if (this.isCockpit() && this.rmb) {
        this.freeYaw = clamp(this.freeYaw - e.movementX * 0.003, -2.6, 2.6);
        this.freePitch = clamp(this.freePitch - e.movementY * 0.003, -1.1, 1.1);
      }
    });
    // Flight consumes pointerdown (preventDefault suppresses compatibility
    // mousedown). Capture the same physical event before its flight handler;
    // otherwise cockpit free-look silently becomes mouse boost.
    document.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && e.pointerType !== 'touch'
        && (e.target === dom || document.pointerLockElement === dom)) this.rmb = true;
    }, true);
    document.addEventListener('pointerup', (e) => {
      if (e.button === 2 || !(e.buttons & 2)) this.rmb = false;
    }, true);
    document.addEventListener('pointercancel', () => { this.rmb = false; }, true);
    document.addEventListener('pointerlockchange', () => {
      if (document.pointerLockElement !== dom) this.rmb = false;
    });
    window.addEventListener('blur', () => { this.rmb = false; });
  }

  isCockpit() { return this.viewMode === 'cockpit' && !this.shipwalk; }
  ownsCamera() { return this.shipwalk || this.viewMode === 'cockpit'; }
  /** RMB means free look in the cockpit, so it must not also read as boost. */
  rmbLookActive() { return this.isCockpit() && this.rmb; }

  setHint(text) { this.onHint?.(text); }

  /* ---- view switching ------------------------------------------------ */

  toggleView() {
    if (this.shipwalk) return;
    // Both directions start from the pose that is actually on screen. The old
    // path only captured cockpit -> chase, while its blend was unreachable;
    // chase -> cockpit therefore teleported the 27 m hull around the camera.
    this.viewBlendFrom.p.copy(this.ship.group.position);
    this.viewBlendFrom.q.copy(this.ship.group.quaternion);
    this.viewBlend = 0;
    this.viewMode = this.viewMode === 'cockpit' ? 'chase' : 'cockpit';
    if (this.viewMode === 'cockpit') {
      this.freeYaw = 0;
      this.freePitch = 0;
    }
  }

  /** Cinematics (landing / warp / flyto / takeoff) own the camera: back to chase. */
  forceChase() {
    if (this.viewMode === 'cockpit') {
      this.viewMode = 'chase';
      this.viewBlend = 1;
      this.freeYaw = 0;
      this.freePitch = 0;
    }
  }

  /* ---- F interactions ------------------------------------------------ */

  /** F in the cockpit: stand up and step back from the seat. */
  standUp(nav) {
    if (!this.isCockpit()) return false;
    const x = 0.0, z = this.def.dims.seatZ + 1.15;
    // Capture the hull exactly where it was rendered. This includes the last
    // cockpit sway frame and avoids reconstructing a subtly different anchor
    // on the first frame of the stand-up animation.
    this.anchorPos.copy(nav.pos).add(this.ship.group.position);
    this.anchorQuat.copy(this.ship.group.quaternion);
    this.prevQuat.copy(this.anchorQuat);
    this.shipwalk = true;
    this.walkPos.set(x, 0, z);
    this.walkYaw = Math.PI;
    this.walkPitch = -0.05;
    this.beginSeatMove(nav, this.walkPose(x, z, Math.PI, -0.05), 'walk');
    return true;
  }

  /**
   * F inside the hull: sit down near the seat, or toggle the cargo ramp.
   * Mirrors the demo's interact() one-to-one.
   */
  interact(nav) {
    if (!this.shipwalk || this.seatT < 1) return false;
    const p = this.walkPos;
    const dSeat = Math.hypot(p.x, p.z - this.def.dims.seatZ);
    if (dSeat < 1.9 && p.z < -5.5) {
      this.beginSeatMove(nav, this.seatedPose(), 'cockpit');
      return true;
    }
    if (p.z > 3.4) {
      this.rampTarget = this.rampTarget > 0.5 ? 0 : 1;
      return true;
    }
    return false;
  }

  /** the ship-local camera pose the cockpit view settles at */
  seatedPose() {
    return {
      p: new THREE.Vector3(0, this.def.dims.eyeY, this.def.dims.eyeZ),
      q: new THREE.Quaternion(),
    };
  }

  /** the ship-local camera pose the walk view settles at, for a given stance */
  walkPose(x, z, yaw, pitch) {
    return {
      p: new THREE.Vector3(x, 1.68, z),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
    };
  }

  /**
   * Start the sit / stand move. The mode switches immediately — flight input,
   * the HUD and the walk collision all belong to the destination the moment
   * the player commits — and only the camera is interpolated.
   */
  beginSeatMove(nav, to, arrived) {
    // Capture the pose that is actually on screen, not an ideal nav pose.
    // Camera.position may contain cockpit/atmosphere motion; preserving it in
    // the source pose removes the visible hitch on the first animation frame.
    const inv = _qi.copy(this.ship.group.quaternion).invert();
    this.seatFrom.p.copy(this.camera.position)
      .sub(this.ship.group.position).applyQuaternion(inv);
    this.seatFrom.q.copy(inv).multiply(this.camera.quaternion);
    this.seatTo = to;
    this.seatArrived = arrived;
    this.seatT = 0;
  }

  /** Boarding hands over a parked anchor and a spawn stance inside the hold. */
  enterShipwalk(anchorPos, anchorQuat, { x = 0, z = 4.6, yaw = 0 } = {}) {
    this.shipwalk = true;
    this.anchorPos.copy(anchorPos);
    this.anchorQuat.copy(anchorQuat);
    this.walkPos.set(x, 0, z);
    this.walkYaw = yaw;
    this.walkPitch = 0;
    this.bob = 0;
    this.seatT = 1;
  }

  /** Sitting back down hands the camera back to flight (nav is primary again). */
  releaseToCockpit() {
    this.shipwalk = false;
    this.viewMode = 'cockpit';
    this.freeYaw = 0;
    this.freePitch = 0;
  }

  openRamp() { this.rampTarget = 1; }
  closeRamp() { this.rampTarget = 0; }

  rampOpen() { return this.rampT > 0.5; }

  /* ---- per-frame ------------------------------------------------------ */

  /**
   * Early in the frame, before the camera is applied: animates the interior
   * state and — while the interior owns the camera — exports nav.
   * @param {number} dt
   * @param {{ nav: object, landed: boolean }} ctx
   */
  tick(dt, ctx) {
    const { nav, landed } = ctx;
    this.t += dt;

    // smoothed hull angular velocity, for the cockpit's rotational sway
    _qi.copy(nav.quat).multiply(this.prevQuat.invert());
    _e.setFromQuaternion(_qi, 'YXZ');
    const invDt = 1 / Math.max(dt, 1e-4);
    this.angVel.x = damp(this.angVel.x, _e.x * invDt, 6, dt);
    this.angVel.y = damp(this.angVel.y, _e.y * invDt, 6, dt);
    this.angVel.z = damp(this.angVel.z, _e.z * invDt, 6, dt);
    this.prevQuat.copy(nav.quat);

    /* ramp: damped open/close, with a ground clamp while parked */
    this.rampMax = landed ? this.groundClampedRampMax() : 1;
    const target = Math.min(this.rampTarget, this.rampMax);
    this.rampT = damp(this.rampT, target, 1.7, dt);
    this.ship.ext.rampPivot.rotation.x = this.rampT * 1.16;
    this.ship.rampT = this.rampT;

    if (!this.shipwalk) {
      // cockpit: free look eases back to centre when RMB is released
      if (!this.rmb) {
        this.freeYaw = damp(this.freeYaw, 0, 3.2, dt);
        this.freePitch = damp(this.freePitch, 0, 3.2, dt);
      }
      return;
    }

    /* --- the sit / stand move: input locked for its duration ------------- */
    if (this.seatT < 1) {
      this.seatT = Math.min(1, this.seatT + dt / SEAT_MOVE);
      const t = this.seatT;
      const e = t * t * t * (t * (t * 6 - 15) + 10);
      _v.lerpVectors(this.seatFrom.p, this.seatTo.p, e);
      _v.y += Math.sin(e * Math.PI) * 0.06;
      _q.slerpQuaternions(this.seatFrom.q, this.seatTo.q, e);
      if (this.seatT >= 1) {
        if (this.seatArrived === 'walk') {
          this.walkPos.set(this.seatTo.p.x, 0, this.seatTo.p.z);
          _e.setFromQuaternion(this.seatTo.q, 'YXZ');
          this.walkYaw = _e.y;
          this.walkPitch = _e.x;
        } else {
          this.releaseToCockpit();
        }
      }
      nav.pos.copy(this.anchorPos).add(_v.applyQuaternion(this.anchorQuat));
      nav.quat.copy(this.anchorQuat).multiply(_q);
      return;
    }

    /* --- standing: walk input, then export the stance --------------------- */
    this.walk(dt, ctx);

    const p = this.walkPos;
    const bobY = Math.sin(this.bob * 2) * 0.028;
    const bobX = Math.sin(this.bob) * 0.022;
    _v.set(p.x + bobX * 0.4, 1.68 + bobY, p.z);
    _q.setFromEuler(_e.set(this.walkPitch, this.walkYaw, bobX * 0.35, 'YXZ'));
    nav.pos.copy(this.anchorPos).add(_v.applyQuaternion(this.anchorQuat));
    nav.quat.copy(this.anchorQuat).multiply(_q);
  }

  /** WASD + Shift sprint with room collision and wall sliding (demo logic). */
  walk(dt) {
    if (this.seatT < 1) return;
    let f = 0, s = 0;
    if (keys.KeyW) f += 1;
    if (keys.KeyS) f -= 1;
    if (keys.KeyD) s += 1;
    if (keys.KeyA) s -= 1;
    const run = keys.ShiftLeft || keys.ShiftRight;
    const sp = (run ? 3.4 : 1.75) * dt;
    const dirX = Math.sin(this.walkYaw), dirZ = Math.cos(this.walkYaw);
    let dx = (-dirX * f + dirZ * s) * sp;
    let dz = (-dirZ * f - dirX * s) * sp;
    const p = this.walkPos;
    if (walkableIn(this.vol, p.x + dx, p.z + dz)) { p.x += dx; p.z += dz; }
    else if (walkableIn(this.vol, p.x + dx, p.z)) p.x += dx;
    else if (walkableIn(this.vol, p.x, p.z + dz)) p.z += dz;
    const moving = (f !== 0 || s !== 0) ? 1 : 0;
    this.bob += dt * (run ? 13 : 8) * moving;
    if (!moving) this.bob = damp(this.bob % (Math.PI * 2), 0, 6, dt);
  }

  /**
   * While the interior owns the camera the hull keeps drifting on its
   * standing velocity (demo behaviour); a parked hull stays put.
   */
  integrateDrift(dt, nav) {
    if (this.shipwalk) {
      this.anchorPos.addScaledVector(nav.vel, dt);
    }
  }

  /* ---- camera & hull pose --------------------------------------------- */

  /**
   * Cockpit-only camera dressing: free look plus the demo's throttle shake
   * and rotational sway. Applied after main.js copies nav.quat. `drive` is a
   * 0..1 stand-in for the demo's |throttle| (speed + boost).
   */
  applyCockpitLook(camera, drive, atmosphere = 0) {
    if (!this.isCockpit()) return;
    // Vacuum gets only a trace of engine vibration. Atmospheric turbulence
    // ramps back to the old full-strength shake as density rises.
    const shake = cockpitShakeAmplitude(drive, atmosphere);
    const lookY = this.freeYaw - this.angVel.y * 0.055;
    const lookX = this.freePitch + this.angVel.x * 0.035;
    _e.set(
      lookX + Math.sin(this.t * 27) * shake,
      lookY + Math.sin(this.t * 31) * shake,
      -this.angVel.z * 0.05,
      'YXZ',
    );
    _q.setFromEuler(_e);
    camera.quaternion.multiply(_q);
  }

  /**
   * After Ship.update has written its formation/parked pose: when the first
   * person owns the view, re-place the hull from nav ∘ localCam⁻¹.
   */
  applyShipPose(dt, nav) {
    const g = this.ship.group;
    const ownsCamera = this.ownsCamera();
    const transitioning = this.viewBlend < 1;
    if (!ownsCamera && !transitioning) return;

    if (ownsCamera) {
      // current camera-local pose (ship frame)
      if (this.shipwalk) {
        if (this.seatT < 1) {
          const t = this.seatT;
          const e = t * t * t * (t * (t * 6 - 15) + 10);
          _v.lerpVectors(this.seatFrom.p, this.seatTo.p, e);
          _v.y += Math.sin(e * Math.PI) * 0.06;
          _q.slerpQuaternions(this.seatFrom.q, this.seatTo.q, e);
        } else {
          const p = this.walkPos;
          const bobY = Math.sin(this.bob * 2) * 0.028;
          const bobX = Math.sin(this.bob) * 0.022;
          _v.set(p.x + bobX * 0.4, 1.68 + bobY, p.z);
          _q.setFromEuler(_e.set(this.walkPitch, this.walkYaw, bobX * 0.35, 'YXZ'));
        }
      } else {
        _v.set(0, this.def.dims.eyeY, this.def.dims.eyeZ);
        _q.identity();
      }

      // The old local^-1 * camera order made the solved hull rotate whenever
      // a standing player looked around. Keep the hull anchor invariant.
      solveHullQuaternion(nav.quat, _q, _targetQ);
      _targetP.copy(_v).applyQuaternion(_targetQ).negate();
    } else {
      // Ship.update has already authored the chase formation target.
      _targetP.copy(g.position);
      _targetQ.copy(g.quaternion);
    }

    if (transitioning) {
      this.viewBlend = Math.min(1, this.viewBlend + dt / 0.72);
      const t = this.viewBlend;
      const e = t * t * t * (t * (t * 6 - 15) + 10);
      g.quaternion.slerpQuaternions(this.viewBlendFrom.q, _targetQ, e);
      g.position.lerpVectors(this.viewBlendFrom.p, _targetP, e);
      return;
    }
    g.quaternion.copy(_targetQ);
    g.position.copy(_targetP);
  }

  /** Per-mode FOV offset over 深空's BASE_FOV (demo: cockpit 66, walk 72). */
  fovOffset() {
    if (this.shipwalk) {
      if (this.seatT < 1) {
        const blend = this.seatArrived === 'walk' ? this.seatT : 1 - this.seatT;
        return 4 + 6 * blend;
      }
      return 10;
    }
    if (this.isCockpit()) return 4;
    return 0;
  }

  /* ---- prompts --------------------------------------------------------- */

  /** Contextual interaction prompt for the HUD ('' when none). */
  interactPrompt(landed) {
    if (!this.shipwalk || this.seatT < 1) return '';
    const p = this.walkPos;
    const dSeat = Math.hypot(p.x, p.z - this.def.dims.seatZ);
    if (dSeat < 1.9 && p.z < -5.5) return '[F] 坐入驾驶座';
    if (p.z > 3.4) {
      if (landed) return this.rampTarget > 0.5 ? '[F] 关闭尾舱门 · [E] 离船' : '[F] 打开尾舱门 · [E] 离船';
      return this.rampTarget > 0.5 ? '[F] 关闭尾舱门' : '[F] 打开尾舱门';
    }
    return '';
  }

  /* ---- ramp ground clamp ------------------------------------------------ */

  /**
   * While landed, keep the open ramp's tip above the terrain: solve the max
   * opening fraction from the hinge/tip geometry against the ground height
   * under the tip. In flight the full 1.16 rad swing is always allowed.
   * The probe is cached — planet.height at full frequency is far too dear
   * to sample ten times a frame.
   */
  groundClampedRampMax() {
    const planet = this.ship.parkedPlanet;
    if (!planet || !this.ship.parkedLocal) return 1;
    const now = this.t;
    if (this._rampClampAt !== undefined && now - this._rampClampAt < 0.5
      && this._rampClampVal !== undefined) return this._rampClampVal;
    this._rampClampAt = now;
    const D = this.def.dims;
    const L = Math.hypot(D.rampTopZ - D.rampHingeZ, D.rampTopY - D.rampHingeY);
    const closedAngle = Math.atan2(D.rampTopY - D.rampHingeY, D.rampTopZ - D.rampHingeZ);
    const maxSwing = 1.16;
    // hinge + tip in ship-local, for a given swing θ
    let best = 0.5;
    for (let t = 1; t >= 0.5; t -= 0.05) {
      const theta = t * maxSwing;
      const tipY = D.rampHingeY + L * Math.cos(closedAngle + theta);
      const tipZ = D.rampHingeZ + L * Math.sin(closedAngle + theta);
      _v.set(0, tipY, tipZ).applyQuaternion(this.ship.parkedQuat).add(this.ship.parkedPosUniv);
      const dist = _v.distanceTo(planet.posUniv);
      const dir = _v.sub(planet.posUniv).multiplyScalar(1 / Math.max(dist, 1));
      const groundRadius = planet.R + planet.height(dir, planet.fullMaxFreq);
      if (dist >= groundRadius + 0.05) { best = t; break; }
    }
    this._rampClampVal = best;
    return best;
  }
}
