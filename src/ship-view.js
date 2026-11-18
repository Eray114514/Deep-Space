// Ship view & interior controller — the HALCYON's first-person & parked-view layer.
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
// anchor is derived; in interior-walk and parked states the anchor is primary
// (locked to the planet pad when landed, or drifting in space) and nav is
// derived. Both directions use the same identity, so mode handoffs are
// continuous by construction.

import * as THREE from 'three';
import { keys } from './controls.js';

const clamp = THREE.MathUtils.clamp;
const smoothstep = THREE.MathUtils.smoothstep;
const damp = (a, b, l, dt) => THREE.MathUtils.lerp(a, b, 1 - Math.exp(-l * dt));
/** seconds the sit / stand camera move takes */
const SEAT_MOVE = 0.8;
/** eye height while standing/walking, matched to WalkControls.eyeHeight (1.7 m) */
export const SHIP_WALK_EYE_HEIGHT = 1.70;
/** maximum cargo-ramp swing (rad); 1.23 rad brings the tip flush to flat ground */
export const RAMP_MAX_SWING = 1.23;

/* walkable region, inset by the player radius */
const PR = 0.26;
function isRampThresholdBlock(b) {
  return b.z0 > 5.5 && Math.abs(b.x0 + b.x1) < 0.1;
}
function walkVolumes(def) {
  return {
    walk: (def.rooms || []).map((r) => ({ x0: r.x0 + PR, x1: r.x1 - PR, z0: r.z0 + PR, z1: r.z1 - PR })),
    block: (def.blocks || []).filter((b) => !isRampThresholdBlock(b))
      .map((b) => ({ x0: b.x0 - PR, x1: b.x1 + PR, z0: b.z0 - PR, z1: b.z1 + PR })),
    rampGate: (def.blocks || []).filter(isRampThresholdBlock)
      .map((b) => ({ x0: b.x0 - PR, x1: b.x1 + PR, z0: b.z0 - PR, z1: b.z1 + PR })),
  };
}
function walkableIn(V, x, z, allowRampExit = false, rampHalfW = 1.42, rampMaxZ = 6.0) {
  let inside = false;
  for (const r of V.walk) if (x > r.x0 && x < r.x1 && z > r.z0 && z < r.z1) { inside = true; break; }
  if (!inside && allowRampExit && Math.abs(x) < rampHalfW && z > 5.2 && z < rampMaxZ) {
    inside = true;
  }
  if (!inside) return false;
  for (const b of V.block) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return false;
  if (!allowRampExit) {
    for (const b of V.rampGate) if (x > b.x0 && x < b.x1 && z > b.z0 && z < b.z1) return false;
  }
  return true;
}

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qi = new THREE.Quaternion();
const _qt = new THREE.Quaternion();
const _m = new THREE.Matrix4();
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

const smootherstep01 = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
};

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
    this.onStep = null;            // optional () => void (metal deck footstep)

    /* view mode: 'chase' (third person, 深空's own) | 'cockpit' */
    this.viewMode = 'chase';
    /* interior walk active — the camera is a person inside the hull */
    this.shipwalk = false;
    /* seated in a parked hull on a landing pad */
    this.parkedSeated = false;
    /* V-toggle group-pose blend in flight, 1 = settled */
    this.viewBlend = 1;
    this.viewBlendFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    /* V-toggle ship-local camera blend while parked / taking off, 1 = settled */
    this.parkedCamBlend = 1;
    this.parkedCamFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.parkedOrbitYaw = 0;
    this.parkedOrbitPitch = 0;

    /* sit / stand camera move: seatT reaches 1 when it is over */
    this.seatT = 1;
    this.seatArrived = null;       // 'walk' | 'cockpit'
    this.seatFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
    this.seatTo = { p: new THREE.Vector3(), q: new THREE.Quaternion() };

    /* interior walk state (ship-local) */
    this.walkPos = new THREE.Vector3(0, 0, -6.4);
    this.touchMove = new THREE.Vector2();
    this.walkYaw = Math.PI;
    this.walkPitch = 0;
    this.rollCarry = 0;
    this.eyeOffset = 0;
    this.bob = 0;
    this.stepCount = 0;
    this.pendingSurfaceExit = false;
    this.rampPush = 0;

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
    let cabinTouch = null;
    dom.addEventListener('pointerdown', e => {
      if (this.shipwalk && e.pointerType === 'touch' && cabinTouch === null) {
        cabinTouch = { id: e.pointerId, x: e.clientX, y: e.clientY };
        dom.setPointerCapture(e.pointerId);
      }
    });
    dom.addEventListener('pointermove', e => {
      if (!this.shipwalk || e.pointerId !== cabinTouch?.id) return;
      this.walkYaw -= (e.clientX - cabinTouch.x) * .004;
      this.walkPitch = clamp(this.walkPitch - (e.clientY - cabinTouch.y) * .004, -1.4, 1.4);
      cabinTouch.x = e.clientX;
      cabinTouch.y = e.clientY;
    });
    dom.addEventListener('lostpointercapture', e => { if (e.pointerId === cabinTouch?.id) cabinTouch = null; });
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return;
      if (this.shipwalk && this.seatT >= 1) {
        this.walkYaw -= e.movementX * 0.0022;
        this.walkPitch = clamp(this.walkPitch - e.movementY * 0.0022, -1.4, 1.4);
      } else if (this.isCockpit() && this.rmb) {
        this.freeYaw = clamp(this.freeYaw - e.movementX * 0.003, -2.6, 2.6);
        this.freePitch = clamp(this.freePitch - e.movementY * 0.003, -1.1, 1.1);
      } else if (this.parkedSeated && this.viewMode === 'chase') {
        this.parkedOrbitYaw = clamp(this.parkedOrbitYaw - e.movementX * 0.0024, -2.8, 2.8);
        this.parkedOrbitPitch = clamp(this.parkedOrbitPitch + e.movementY * 0.0020, -0.24, 0.62);
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

  /** Current camera pose expressed in the ship's own local frame. */
  captureShipLocalCamera(outP = new THREE.Vector3(), outQ = new THREE.Quaternion()) {
    const inv = _qi.copy(this.ship.group.quaternion).invert();
    outP.copy(this.camera.position).sub(this.ship.group.position).applyQuaternion(inv);
    outQ.copy(inv).multiply(this.camera.quaternion).normalize();
    return { p: outP, q: outQ };
  }

  toggleView({ scriptedHull = false } = {}) {
    if (this.shipwalk) return;
    // V selects a camera mount. Interpolating between these mounts crosses
    // the rear bulkhead before reaching the pilot's eye.
    this.viewBlend = 1;
    this.parkedCamBlend = 1;
    this.viewMode = this.viewMode === 'cockpit' ? 'chase' : 'cockpit';
    if (this.viewMode === 'cockpit') {
      this.freeYaw = 0;
      this.freePitch = 0;
    } else if (this.parkedSeated || scriptedHull) {
      this.parkedOrbitYaw = 0;
      this.parkedOrbitPitch = 0;
    }
  }

  /** Cinematics like star-map fly-to own the camera: back to chase. */
  forceChase() {
    if (this.viewMode === 'cockpit') {
      this.viewMode = 'chase';
      this.viewBlend = 1;
      this.parkedCamBlend = 1;
      this.freeYaw = 0;
      this.freePitch = 0;
    }
  }

  /* ---- ramp geometry ------------------------------------------------- */

  rampTipAt(swingFraction = this.rampT) {
    const D = this.def.dims;
    if (!D) return { y: -1.5, z: 9.4 };
    const dy = D.rampTopY - D.rampHingeY;
    const dz = D.rampTopZ - D.rampHingeZ;
    const theta = clamp(swingFraction, 0, 1) * RAMP_MAX_SWING;
    const c = Math.cos(theta);
    const s = Math.sin(theta);
    return {
      y: D.rampHingeY + dy * c - dz * s,
      z: D.rampHingeZ + dy * s + dz * c,
    };
  }

  rampSwing() {
    const max = Math.max(1e-4, this.rampMax ?? 1);
    const u = clamp(this.rampT / max, 0, 1);
    return smootherstep01(u) * max;
  }

  rampTipLocal() {
    return this.rampTipAt(this.rampSwing());
  }

  rampOpenThreshold() {
    return Math.max(0.46, (this.rampMax ?? 1) * 0.82);
  }

  rampWalkable(landed = true) {
    return Boolean(landed && this.rampTarget > 0.5 && this.rampT >= this.rampOpenThreshold());
  }

  rampFloorY(z) {
    const D = this.def.dims;
    if (!D || z <= D.rampHingeZ) return 0;
    const tip = this.rampTipLocal();
    const u = clamp((z - D.rampHingeZ) / Math.max(0.25, tip.z - D.rampHingeZ), 0, 1);
    return u * tip.y;
  }

  toggleRamp() {
    this.rampTarget = this.rampTarget > 0.5 ? 0 : 1;
    this.ship.emit?.(this.rampTarget > 0.5 ? 'ramp-open' : 'ramp-close', [0, 1.2, 6.6]);
    return this.rampTarget > 0.5;
  }

  /* ---- F interactions ------------------------------------------------ */

  /** F in the pilot's seat (or parked chase view): stand up and step back. */
  standUp(nav, { landed = false } = {}) {
    if (this.shipwalk) return false;
    if (!landed && !this.isCockpit()) return false;
    const seatZ = this.def.dims?.seatZ ?? -7.35;
    const x = 0.0, z = seatZ + 1.15;
    if (landed && this.ship.parkedPosUniv) {
      this.anchorPos.copy(this.ship.parkedPosUniv);
      this.anchorQuat.copy(this.ship.parkedQuat);
    } else {
      // Capture the hull exactly where it was rendered in space.
      this.anchorPos.copy(nav.pos).add(this.ship.group.position);
      this.anchorQuat.copy(this.ship.group.quaternion);
    }
    this.prevQuat.copy(this.anchorQuat);
    this.parkedSeated = false;
    this.parkedCamBlend = 1;
    this.viewMode = 'cockpit';
    this.shipwalk = true;
    this.walkPos.set(x, 0, z);
    this.walkYaw = Math.PI;
    this.walkPitch = -0.05;
    this.rollCarry = 0;
    this.eyeOffset = 0;
    this.pendingSurfaceExit = false;
    this.beginSeatMove(nav, this.walkPose(x, z, Math.PI, -0.05), 'walk');
    return true;
  }

  /**
   * F inside the hull: sit down near the seat, toggle the cargo ramp, or use
   * nearby cabin fixtures.
   */
  interact(nav) {
    if (!this.shipwalk || this.seatT < 1) return false;
    const p = this.walkPos;
    const seatZ = this.def.dims?.seatZ ?? -7.35;
    const dSeat = Math.hypot(p.x, p.z - seatZ);
    if (dSeat < 1.9 && p.z < -5.5) {
      this.beginSeatMove(nav, this.seatedPose(), 'cockpit');
      return true;
    }
    if (p.z > 3.2) {
      this.toggleRamp();
      return true;
    }
    const near = this.nearestInteractable();
    if (near) {
      near.act();
      return true;
    }
    return false;
  }

  /** the closest thing within reach that the walker can use */
  nearestInteractable() {
    const p = this.walkPos;
    let best = null, bestD = Infinity;
    for (const item of this.ship.interactables || []) {
      const d = Math.hypot(p.x - item.x, p.z - item.z);
      if (d < item.reach && d < bestD) { best = item; bestD = d; }
    }
    return best;
  }

  /** the ship-local camera pose the cockpit view settles at */
  seatedPose() {
    const D = this.def.dims;
    return {
      p: new THREE.Vector3(0, D?.eyeY ?? 1.50, D?.eyeZ ?? -7.70),
      q: new THREE.Quaternion(),
    };
  }

  /** the ship-local chase pose behind a parked ship (matches flight formation) */
  parkedChasePose(planet = null) {
    const yaw = this.parkedOrbitYaw;
    const pitch = this.parkedOrbitPitch;
    if (Math.abs(yaw) < 1e-4 && Math.abs(pitch) < 1e-4) {
      return {
        p: new THREE.Vector3(0, 6.5, 30),
        q: new THREE.Quaternion(),
      };
    }
    const pivotY = 1.2, pivotZ = -1.5;
    const dist = 31.8;
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    const localP = new THREE.Vector3(
      Math.sin(yaw) * cosP * dist,
      pivotY + 5.3 + sinP * dist * 0.72,
      pivotZ + Math.cos(yaw) * cosP * dist,
    );
    if (planet && this.ship.parkedPosUniv) {
      _v2.copy(localP).applyQuaternion(this.ship.parkedQuat).add(this.ship.parkedPosUniv);
      const r = _v2.distanceTo(planet.posUniv);
      const dir = _v.copy(_v2).sub(planet.posUniv).multiplyScalar(1 / Math.max(r, 1));
      const minR = planet.surfaceRadius(dir) + 2.2;
      if (r < minR) localP.y += (minR - r);
    }
    _m.lookAt(localP, _v2.set(0, pivotY, pivotZ - 4.0), _v.set(0, 1, 0));
    const localQ = new THREE.Quaternion().setFromRotationMatrix(_m);
    return { p: localP, q: localQ };
  }

  /** Solve current ship-local camera pose during parked/takeoff view blends. */
  evalParkedCameraLocal(planet = null, outP = new THREE.Vector3(), outQ = new THREE.Quaternion()) {
    const target = this.viewMode === 'cockpit' ? this.seatedPose() : this.parkedChasePose(planet);
    if (this.parkedCamBlend < 1) {
      const e = smootherstep01(this.parkedCamBlend);
      outP.lerpVectors(this.parkedCamFrom.p, target.p, e);
      outQ.slerpQuaternions(this.parkedCamFrom.q, target.q, e);
    } else {
      outP.copy(target.p);
      outQ.copy(target.q);
    }
    return { p: outP, q: outQ };
  }

  /** the ship-local camera pose the walk view settles at, for a given stance */
  walkPose(x, z, yaw, pitch) {
    return {
      p: new THREE.Vector3(x, SHIP_WALK_EYE_HEIGHT + this.rampFloorY(z), z),
      q: new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')),
    };
  }

  /**
   * Start the sit / stand move. The mode switches immediately — flight input,
   * the HUD and the walk collision all belong to the destination the moment
   * the player commits — and only the camera is interpolated.
   */
  beginSeatMove(nav, to, arrived) {
    this.captureShipLocalCamera(this.seatFrom.p, this.seatFrom.q);
    this.seatTo = to;
    this.seatArrived = arrived;
    this.seatT = 0;
  }

  /** Boarding hands over a parked anchor and a spawn stance inside the hold. */
  enterShipwalk(anchorPos, anchorQuat, { x = 0, z = 4.6, yaw = 0, pitch = 0 } = {}) {
    this.shipwalk = true;
    this.parkedSeated = false;
    this.anchorPos.copy(anchorPos);
    this.anchorQuat.copy(anchorQuat);
    this.walkPos.set(x, 0, z);
    this.walkYaw = yaw;
    this.walkPitch = pitch;
    this.rollCarry = 0;
    this.eyeOffset = 0;
    this.bob = 0;
    this.pendingSurfaceExit = false;
    this.seatT = 1;
  }

  /** Continuous handoff when walking up the open cargo ramp from the surface. */
  enterFromRamp(anchorPos, anchorQuat, { x = 0, z = 8.4, yaw = 0, pitch = 0, roll = 0, eyeOffset = 0 } = {}) {
    this.shipwalk = true;
    this.parkedSeated = false;
    this.anchorPos.copy(anchorPos);
    this.anchorQuat.copy(anchorQuat);
    this.walkPos.set(x, 0, z);
    this.walkYaw = yaw;
    this.walkPitch = pitch;
    this.rollCarry = roll;
    this.eyeOffset = eyeOffset;
    this.bob = 0;
    this.pendingSurfaceExit = false;
    this.seatT = 1;
  }

  /** Sitting back down hands the camera back to cockpit controls. */
  releaseToCockpit() {
    this.shipwalk = false;
    this.viewMode = 'cockpit';
    this.parkedCamBlend = 1;
    this.freeYaw = 0;
    this.freePitch = 0;
  }

  openRamp() { this.rampTarget = 1; }
  closeRamp() { this.rampTarget = 0; }

  rampOpen() { return this.rampT > 0.5; }

  /* ---- per-frame ------------------------------------------------------ */

  /**
   * Early in the frame, before the camera is applied: animates the interior
   * state and — while the interior or parked seat owns the camera — exports nav.
   * @param {number} dt
   * @param {{ nav: object, landed: boolean, seatedOnPad?: boolean, planet?: object }} ctx
   */
  tick(dt, ctx) {
    const { nav, landed, seatedOnPad = false, planet = null } = ctx;
    this.t += dt;
    this.parkedSeated = Boolean(seatedOnPad);

    // Keep the hull anchor glued to the rotating/orbiting planet pad.
    if (landed && this.ship.parkedPosUniv) {
      this.anchorPos.copy(this.ship.parkedPosUniv);
      this.anchorQuat.copy(this.ship.parkedQuat);
    }

    // smoothed hull angular velocity, for the cockpit's rotational sway
    _qi.copy(nav.quat).multiply(this.prevQuat.invert());
    _e.setFromQuaternion(_qi, 'YXZ');
    const invDt = 1 / Math.max(dt, 1e-4);
    this.angVel.x = damp(this.angVel.x, _e.x * invDt, 6, dt);
    this.angVel.y = damp(this.angVel.y, _e.y * invDt, 6, dt);
    this.angVel.z = damp(this.angVel.z, _e.z * invDt, 6, dt);
    this.prevQuat.copy(nav.quat);

    /* ramp: S-curve hydraulic actuator, with a planet-local ground clamp while parked */
    this.rampMax = landed ? this.groundClampedRampMax() : 1;
    const target = Math.min(this.rampTarget, this.rampMax);
    const step = dt / 1.10;
    if (this.rampT < target) this.rampT = Math.min(target, this.rampT + step);
    else if (this.rampT > target) this.rampT = Math.max(target, this.rampT - step);
    const swing = this.rampSwing();
    if (this.ship.ext?.rampPivot) {
      this.ship.ext.rampPivot.rotation.x = swing * RAMP_MAX_SWING;
    }
    this.ship.rampT = swing;

    if (this.parkedCamBlend < 1) {
      this.parkedCamBlend = Math.min(1, this.parkedCamBlend + dt / 0.70);
    }

    if (!this.shipwalk) {
      // cockpit: free look eases back to centre when RMB is released
      if (!this.rmb) {
        this.freeYaw = damp(this.freeYaw, 0, 3.2, dt);
        this.freePitch = damp(this.freePitch, 0, 3.2, dt);
      }
      if (seatedOnPad && this.ship.parkedPosUniv) {
        this.evalParkedCameraLocal(planet, _v, _q);
        nav.pos.copy(this.ship.parkedPosUniv).add(_v.applyQuaternion(this.ship.parkedQuat));
        nav.quat.copy(this.ship.parkedQuat).multiply(_q);
      }
      return;
    }

    /* --- the sit / stand move: input locked for its duration ------------- */
    if (this.seatT < 1) {
      this.seatT = Math.min(1, this.seatT + dt / SEAT_MOVE);
      const e = smootherstep01(this.seatT);
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
    this.walk(dt, landed);
    this.rollCarry = damp(this.rollCarry, 0, 10, dt);
    this.eyeOffset = damp(this.eyeOffset, 0, 8, dt);

    const p = this.walkPos;
    const rampY = this.rampFloorY(p.z);
    const tip = this.rampTipLocal();
    // Fade bob roll right at the foot of the ramp so surface handoff is level.
    const bobScale = p.z > 6.2 ? 1 - smoothstep(p.z, tip.z - 0.9, tip.z + 0.1) : 1;
    const bobY = Math.sin(this.bob * 2) * 0.028 * bobScale;
    const bobX = Math.sin(this.bob) * 0.022 * bobScale;
    const jumpRamp = this.ship.hoverMode === 'high' && this.rampWalkable(landed);
    const lip = tip.z - .72;
    this.rampPush = jumpRamp ? smoothstep(p.z, lip - 1.65, lip) : 0;
    const plant = jumpRamp ? smoothstep(p.z, lip - 1.05, lip - .32) : 0;
    const drive = jumpRamp ? smoothstep(p.z, lip - .32, lip) : 0;
    const crouch = plant * (1 - drive);
    _v.set(p.x + bobX * 0.4, SHIP_WALK_EYE_HEIGHT + rampY + this.eyeOffset + bobY - .17 * crouch + .065 * drive, p.z);
    _q.setFromEuler(_e.set(this.walkPitch - .13 * crouch + .035 * drive, this.walkYaw, bobX * 0.35 + this.rollCarry, 'YXZ'));
    nav.pos.copy(this.anchorPos).add(_v.applyQuaternion(this.anchorQuat));
    nav.quat.copy(this.anchorQuat).multiply(_q);

    if (this.rampWalkable(landed) && p.z > (jumpRamp ? lip : tip.z + .16)) {
      this.pendingSurfaceExit = true;
    }
  }

  /** WASD + Shift sprint with room collision, wall sliding and open-ramp walkout. */
  walk(dt, landed = false) {
    if (this.seatT < 1) return;
    let f = this.touchMove.y, s = this.touchMove.x;
    if (keys.KeyW) f += 1;
    if (keys.KeyS) f -= 1;
    if (keys.KeyD) s += 1;
    if (keys.KeyA) s -= 1;
    const run = keys.ShiftLeft || keys.ShiftRight;
    const sp = (run ? 3.6 : 1.85) * dt;
    const dirX = Math.sin(this.walkYaw), dirZ = Math.cos(this.walkYaw);
    const dx = (-dirX * f + dirZ * s) * sp;
    const dz = (-dirZ * f - dirX * s) * sp;
    const p = this.walkPos;
    const allowRamp = this.rampWalkable(landed);
    const D = this.def.dims;
    const rampHalfW = Math.max(0.8, (D?.rampHalfW ?? 1.78) - PR - 0.10);
    const rampMaxZ = allowRamp ? this.rampTipLocal().z + 0.55 : 6.0;
    if (walkableIn(this.vol, p.x + dx, p.z + dz, allowRamp, rampHalfW, rampMaxZ)) { p.x += dx; p.z += dz; }
    else if (walkableIn(this.vol, p.x + dx, p.z, allowRamp, rampHalfW, rampMaxZ)) p.x += dx;
    else if (walkableIn(this.vol, p.x, p.z + dz, allowRamp, rampHalfW, rampMaxZ)) p.z += dz;
    const moving = (f !== 0 || s !== 0) ? 1 : 0;
    if (moving) {
      const prevStep = Math.floor(this.bob / (Math.PI * 0.5));
      this.bob += dt * (run ? 12.5 : 8.2);
      const nextStep = Math.floor(this.bob / (Math.PI * 0.5));
      if (nextStep > prevStep && (nextStep % 2 === 1)) this.onStep?.();
    } else {
      this.bob = damp(this.bob % (Math.PI * 2), 0, 6, dt);
    }
  }

  /**
   * While the interior owns the camera in space, the hull keeps drifting on its
   * standing velocity; a parked hull is locked to its planet pad instead.
   */
  integrateDrift(dt, nav) {
    if (this.shipwalk && !this.ship.parkedPosUniv) {
      this.anchorPos.addScaledVector(nav.vel, dt);
    }
  }

  /* ---- camera & hull pose --------------------------------------------- */

  /**
   * Cockpit-only camera dressing: free look plus the demo's throttle shake
   * and rotational sway. Applied after main.js copies nav.quat.
   */
  applyCockpitLook(camera, drive, atmosphere = 0) {
    if (!this.isCockpit()) return;
    const blendWeight = this.parkedCamBlend < 1 ? smootherstep01(this.parkedCamBlend) : 1;
    const shake = cockpitShakeAmplitude(drive, atmosphere) * blendWeight;
    const lookY = (this.freeYaw - this.angVel.y * 0.055) * blendWeight;
    const lookX = (this.freePitch + this.angVel.x * 0.035) * blendWeight;
    _e.set(
      lookX + Math.sin(this.t * 27) * shake,
      lookY + Math.sin(this.t * 31) * shake,
      -this.angVel.z * 0.05 * blendWeight,
      'YXZ',
    );
    _q.setFromEuler(_e);
    camera.quaternion.multiply(_q);
  }

  /** Fade the outer dark canopy coat smoothly as the camera crosses the glass. */
  syncCanopyCoat() {
    const coat = this.ship.mats?.glassCoat;
    if (!coat) return;
    _qi.copy(this.ship.group.quaternion).invert();
    _v.copy(this.camera.position).sub(this.ship.group.position).applyQuaternion(_qi);
    const D = this.def.dims;
    const eyeY = D?.eyeY ?? 1.50;
    const eyeZ = D?.eyeZ ?? -7.70;
    const dist = Math.hypot(_v.x, _v.y - (eyeY - 0.12), (_v.z - eyeZ) * 0.62);
    const fade = smoothstep(dist, 1.35, 3.4);
    coat.opacity = 0.80 * fade;
    coat.visible = coat.opacity > 0.01;
  }

  /**
   * After Ship.update has written its formation/parked pose: when the first
   * person owns the view in free flight, re-place the hull from nav ∘ localCam⁻¹.
   * When parked or riding a landing/liftoff trajectory, the hull's world pose
   * is already authoritative.
   */
  applyShipPose(dt, nav, state = 'space') {
    const g = this.ship.group;
    if (this.ship.orbitalStandby && !this.ship.landingPose) return;
    const scriptedOrParked = !!this.ship.landingPose
      || state === 'landing' || state === 'takeoff' || state === 'landed'
      || state === 'walk' || state === 'skydive' || state === 'boarding'
      || (this.shipwalk && !!this.ship.parkedPosUniv && this.ship.parkAmt > 0.98);
    if (scriptedOrParked) {
      if (!this.ship.landingPose
        && (state === 'landed' || state === 'boarding'
          || (state === 'walk' && (!this.ship.hoverMode || this.ship.suppressHoverSway))
          || (this.shipwalk && this.ship.parkAmt > 0.98))
        && this.ship.parkedPosUniv) {
        g.position.copy(this.ship.parkedPosUniv).sub(nav.pos);
        g.quaternion.copy(this.ship.parkedQuat);
      }
      this.syncCanopyCoat();
      return;
    }

    const ownsCamera = this.ownsCamera();
    const transitioning = this.viewBlend < 1;
    if (!ownsCamera && !transitioning) {
      this.syncCanopyCoat();
      return;
    }

    if (ownsCamera) {
      if (this.shipwalk) {
        if (this.seatT < 1) {
          const e = smootherstep01(this.seatT);
          _v.lerpVectors(this.seatFrom.p, this.seatTo.p, e);
          _v.y += Math.sin(e * Math.PI) * 0.06;
          _q.slerpQuaternions(this.seatFrom.q, this.seatTo.q, e);
        } else {
          const p = this.walkPos;
          const bobY = Math.sin(this.bob * 2) * 0.028;
          const bobX = Math.sin(this.bob) * 0.022;
          _v.set(p.x + bobX * 0.4, SHIP_WALK_EYE_HEIGHT + bobY, p.z);
          _q.setFromEuler(_e.set(this.walkPitch, this.walkYaw, bobX * 0.35, 'YXZ'));
        }
      } else {
        const D = this.def.dims;
        _v.set(0, D?.eyeY ?? 1.50, D?.eyeZ ?? -7.70);
        _q.identity();
      }

      solveHullQuaternion(nav.quat, _q, _targetQ);
      _targetP.copy(_v).applyQuaternion(_targetQ).negate();
    } else {
      _targetP.copy(g.position);
      _targetQ.copy(g.quaternion);
    }

    if (transitioning) {
      this.viewBlend = Math.min(1, this.viewBlend + dt / 0.72);
      const e = smootherstep01(this.viewBlend);
      g.quaternion.slerpQuaternions(this.viewBlendFrom.q, _targetQ, e);
      g.position.lerpVectors(this.viewBlendFrom.p, _targetP, e);
      this.syncCanopyCoat();
      return;
    }
    g.quaternion.copy(_targetQ);
    g.position.copy(_targetP);
    this.syncCanopyCoat();
  }

  /** Per-mode FOV offset over 深空's BASE_FOV (cockpit +4, cabin walk +8). */
  fovOffset() {
    if (this.shipwalk) {
      if (this.seatT < 1) {
        const blend = this.seatArrived === 'walk' ? this.seatT : 1 - this.seatT;
        return 4 + 4 * blend;
      }
      return 8;
    }
    if (this.parkedCamBlend < 1) {
      const e = smootherstep01(this.parkedCamBlend);
      return this.viewMode === 'cockpit' ? 4 * e : 4 * (1 - e);
    }
    if (this.isCockpit()) return 4;
    return 0;
  }

  /* ---- prompts --------------------------------------------------------- */

  /** Contextual interaction prompt for the HUD ('' when none). */
  interactPrompt(landed) {
    if (!this.shipwalk || this.seatT < 1) return '';
    const p = this.walkPos;
    const seatZ = this.def.dims?.seatZ ?? -7.35;
    const dSeat = Math.hypot(p.x, p.z - seatZ);
    if (dSeat < 1.9 && p.z < -5.5) return '[F] 坐入驾驶座';
    if (p.z > 3.2) {
      if (this.ship.hoverMode === 'high') {
        if (this.rampTarget > 0.5) {
          return this.rampWalkable(true)
            ? '跳伞尾舱门已开启 · 向前跃出舱门开始高空跳伞 · [F] 关闭尾舱门'
            : '正在开启尾舱门…';
        }
        return '[F] 打开跳伞尾舱门';
      }
      if (landed) {
        if (this.rampTarget > 0.5) {
          return this.rampWalkable(true)
            ? '尾舱门已开启 · 沿坡道步行离船 · [F] 关闭尾舱门'
            : '正在开启尾舱门…';
        }
        return '[F] 打开尾舱门';
      }
      return this.rampTarget > 0.5 ? '[F] 关闭尾舱门' : '[F] 打开尾舱门';
    }
    const near = this.nearestInteractable();
    return near ? near.prompt() : '';
  }

  /* ---- ramp ground clamp ------------------------------------------------ */

  /**
   * While landed, keep the open ramp's tip flush above the terrain: solve the
   * max opening fraction from the hinge/tip geometry against the ground height
   * under the tip. Cached to avoid per-frame high-frequency terrain sampling.
   */
  groundClampedRampMax() {
    if (this.ship.hoverMode === 'high') return 0.58;
    const planet = this.ship.parkedPlanet;
    const D = this.def.dims;
    if (!planet || !this.ship.parkedLocal || !this.ship.parkedLocalQuat || !D) return 1;
    const now = this.t;
    if (this._rampClampAt !== undefined && now - this._rampClampAt < 0.4
      && this._rampClampVal !== undefined
      && this._rampClampMode === this.ship.hoverMode) return this._rampClampVal;
    this._rampClampAt = now;
    this._rampClampMode = this.ship.hoverMode;
    const clearance = this.ship.hoverMode === 'extract' ? 0.12 : -0.04;
    let best = 0.54;
    for (let t = 1; t >= 0.54; t -= 0.02) {
      const tip = this.rampTipAt(t);
      _v.set(0, tip.y, tip.z)
        .applyQuaternion(this.ship.parkedLocalQuat)
        .add(this.ship.parkedLocal);
      const dist = _v.length();
      const dir = _v.multiplyScalar(1 / Math.max(dist, 1));
      const groundRadius = planet.surfaceRadius(dir);
      if (dist >= groundRadius + clearance) { best = t; break; }
    }
    this._rampClampVal = best;
    return best;
  }
}
