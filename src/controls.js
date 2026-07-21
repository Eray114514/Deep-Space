// Input controllers. SpaceControls: free-look + scroll-wheel flight where
// speed scales with altitude (orbit→treetops on one wheel). WalkControls:
// first-person on a sphere — gravity points at the planet core and the
// ground is the planet's own height function, not a mesh raycast.

import * as THREE from 'three';
import { clamp } from './noise.js';

export const keys = {};
if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => { keys[e.code] = true; });
  window.addEventListener('keyup', (e) => { keys[e.code] = false; });
  window.addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
}

const _f = new THREE.Vector3();
const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// A pulse is a discrete displacement owned by the flight state, not a second
// cruise tier. It starts at full authority and brakes through the burst.
export function pulseBurstProgress(t) {
  const k = clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 3);
}

export function pulseBurstDistance(speedScale, altitude = Infinity, hasBody = false) {
  let distance = clamp(Math.max(0, speedScale) * 10, 90, 1.2e6);
  if (hasBody && Number.isFinite(altitude)) {
    // Near terrain the pulse stays useful but short enough for the existing
    // swept clearance probe to catch ridges. Atmosphere itself is not a ban.
    distance = Math.min(distance, Math.max(80, Math.max(0, altitude) * 0.3 + 100));
  }
  return distance;
}

// The RMB boost governor is also the HUD's full-scale mark. Keep this as one
// pure contract so flight physics and the cockpit pointer cannot drift apart.
export function flightBoostSpeedLimit(speedScale, atmosphereFactor = 0, gravityPower = 1) {
  const atmosphere = clamp(atmosphereFactor, 0, 1);
  return Math.max(0, speedScale)
    * (8.4 + (1 - atmosphere) * 2.62)
    * Math.max(0, gravityPower);
}

// Remove only roll around the current viewing direction. Forward/pitch remain
// untouched, so planetary horizon assist never steals aiming from the player.
export function stabilizeHorizon(quat, surfaceUp, amount = 1) {
  _f.set(0, 0, -1).applyQuaternion(quat).normalize();
  _u.set(0, 1, 0).applyQuaternion(quat).projectOnPlane(_f);
  _v.copy(surfaceUp).projectOnPlane(_f);
  if (_u.lengthSq() < 1e-8 || _v.lengthSq() < 1e-8) return 0;
  _u.normalize();
  _v.normalize();
  const sin = clamp(_f.dot(_v2.crossVectors(_u, _v)), -1, 1);
  const cos = clamp(_u.dot(_v), -1, 1);
  const error = Math.atan2(sin, cos);
  const correction = error * clamp(amount, 0, 1);
  if (Math.abs(correction) > 1e-7) {
    quat.premultiply(_q.setFromAxisAngle(_f, correction)).normalize();
  }
  return Math.abs(error);
}

// Keep an approach on the line the player is actually aiming along. The old
// limiter removed only the inward component of velocity; at an oblique polar
// entry that preserved all sideways momentum and bent a planet-bound path
// into an apparent climb/fly-by. Scaling the whole vector preserves its
// direction, while the heading convergence makes arcade flight follow the
// crosshair whenever that crosshair ray genuinely intersects the planet.
export function guidePlanetApproach(velocity, forward, radialOut,
  centerDistance, targetRadius, maxInwardSpeed, dt = 0) {
  _f.copy(forward).normalize();
  _u.copy(radialOut).normalize();
  const b = centerDistance * _u.dot(_f);
  const discriminant = b * b - centerDistance * centerDistance + targetRadius * targetRadius;
  const intersects = b < 0 && discriminant >= 0;

  if (intersects && dt > 0 && velocity.lengthSq() > 1e-6) {
    const forwardSpeed = velocity.dot(_f);
    if (forwardSpeed > 0) {
      _v.copy(velocity).addScaledVector(_f, -forwardSpeed);
      const proximity = 1 - clamp((centerDistance / Math.max(targetRadius, 1) - 1) / 5, 0, 1);
      const align = 1 - Math.exp(-dt * (1.4 + proximity * 7.2));
      velocity.copy(_f).multiplyScalar(forwardSpeed).addScaledVector(_v, 1 - align);
    }
  }

  const inwardSpeed = -velocity.dot(_u);
  if (inwardSpeed > maxInwardSpeed && maxInwardSpeed > 0) {
    velocity.multiplyScalar(maxInwardSpeed / inwardSpeed);
  }
  return intersects;
}

export function applyFlightThrusters(velocity, quat, throttle, strafe, speedScale, dt,
  gravityPower = 1, navigationPower = 1) {
  if (throttle) {
    _f.set(0, 0, -1).applyQuaternion(quat);
    velocity.addScaledVector(_f, throttle * speedScale * 3.0 * gravityPower * dt);
  }
  if (strafe) {
    _r.set(1, 0, 0).applyQuaternion(quat);
    velocity.addScaledVector(_r, strafe * speedScale * 4.2 * navigationPower * dt);
  }
  return velocity;
}

export class SpaceControls {
  constructor(dom, nav, { onClick } = {}) {
    this.dom = dom;
    this.nav = nav;                  // { pos, quat, vel } — pos in universe coords
    this.onClick = onClick;
    this.enabled = true;
    this.speedScale = 1000;          // set per-frame by main from altitude
    this.gravityPower = 1;
    this.navigationPower = 1;
    this.atmosphereFactor = 0;
    this.surfaceUp = new THREE.Vector3(0, 1, 0);
    this.horizonAssist = 0;
    this.boosting = false;
    this.firing = false;
    this.firePressed = false;
    this.wheelImpulse = 0;
    this.throttleInput = 0;
    this.strafeInput = 0;
    this.lookInput = { yaw: 0, pitch: 0 };
    this.focus = null;               // planet (for RMB orbit / two-finger orbit)

    // active pointers (multi-touch aware: 1 finger = look, 2 = pinch-fly + orbit)
    this.pointers = new Map();       // pointerId -> {x, y}
    this._drag = null;               // primary pointer gesture (click detection)
    this._pinchDist = 0;

    this._onPointerDown = (e) => this.pointerDown(e);
    this._onPointerMove = (e) => this.pointerMove(e);
    this._onPointerUp = (e) => this.pointerUp(e);
    this._onGlobalPointerUp = (e) => {
      if (e.button === 2 || !(e.buttons & 2)) this.boosting = false;
      if (e.button === 0 || !(e.buttons & 1)) this.firing = false;
    };
    this._onBlur = () => {
      this.boosting = false;
      this.firing = false;
      this.clearTransientInput();
    };
    this._onWheel = (e) => this.wheel(e);
    this._onLockedMove = (e) => this.lockedMove(e);
    this._onContextMenu = (e) => e.preventDefault();
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('pointercancel', this._onPointerUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('mousemove', this._onLockedMove);
    window.addEventListener('pointerup', this._onGlobalPointerUp, true);
    window.addEventListener('blur', this._onBlur);
    dom.addEventListener('contextmenu', this._onContextMenu);
  }

  midpointOf(ids) {
    let mx = 0, my = 0;
    for (const p of ids) { mx += p.x; my += p.y; }
    return { x: mx / ids.length, y: my / ids.length };
  }

  pinchDistOf(ids) {
    const [a, b] = ids;
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  pointerDown(e) {
    if (!this.enabled) return;
    if (e.button === 2) {
      e.preventDefault();
      this.boosting = true;
    }
    if (e.button === 0 && e.pointerType !== 'touch') {
      this.firing = true;
      this.firePressed = true;
    }
    if (!window.NMS_NOLOCK && e.pointerType !== 'touch' && document.pointerLockElement !== this.dom) {
      this.dom.requestPointerLock();
    }
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this._drag = {
        id: e.pointerId, button: e.button, touch: e.pointerType === 'touch',
        moved: 0,
      };
    } else {
      this._drag = null;             // a second finger means it's not a tap
      if (this.pointers.size === 2) {
        this._pinchDist = this.pinchDistOf([...this.pointers.values()]);
        this._pinchMid = this.midpointOf([...this.pointers.values()]);
      }
    }
  }

  pointerMove(e) {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    if (e.pointerType !== 'touch') {
      this.boosting = !!(e.buttons & 2);
      this.firing = !!(e.buttons & 1);
    }
    if (document.pointerLockElement === this.dom && e.pointerType !== 'touch') return;
    const prev = this.pointers.get(e.pointerId);
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    prev.x = e.clientX; prev.y = e.clientY;

    if (this.pointers.size === 2) {
      // pinch: spread = fly forward, squeeze = fly back (the touch "wheel")
      const pts = [...this.pointers.values()];
      const dist = this.pinchDistOf(pts);
      this.wheelImpulse += (dist - this._pinchDist) * 1.0;
      this._pinchDist = dist;
      // two-finger drag orbits the focused planet
      const mid = this.midpointOf(pts);
      if (this.focus) this.orbit((mid.x - this._pinchMid.x) * 0.7, (mid.y - this._pinchMid.y) * 0.7);
      this._pinchMid = mid;
      return;
    }

    if (this._drag && this._drag.id === e.pointerId) {
      this._drag.moved += Math.abs(dx) + Math.abs(dy);
      // drag-look fallback for nolock mode and touch.
      this.nav.quat.multiply(_q.setFromAxisAngle(Y_AXIS, -dx * 0.0026 * this.navigationPower));
      this.nav.quat.multiply(_q.setFromAxisAngle(X_AXIS, -dy * 0.0026 * this.navigationPower));
      this.nav.quat.normalize();
      this.captureLookInput(dx * this.navigationPower, dy * this.navigationPower);
    }
  }

  lockedMove(e) {
    if (!this.enabled || document.pointerLockElement !== this.dom) return;
    this.nav.quat.multiply(_q.setFromAxisAngle(Y_AXIS, -e.movementX * 0.0019 * this.navigationPower));
    this.nav.quat.multiply(_q.setFromAxisAngle(X_AXIS, -e.movementY * 0.0019 * this.navigationPower));
    this.nav.quat.normalize();
    this.captureLookInput(e.movementX * this.navigationPower, e.movementY * this.navigationPower);
  }

  captureLookInput(dx, dy) {
    // This is a short-lived presentation signal, not another steering system.
    // It lets the visible hull react only to deliberate player motion instead
    // of mistaking horizon assist or planetary rotation for pilot input.
    this.lookInput.yaw = clamp(this.lookInput.yaw + dx * 0.038, -1, 1);
    this.lookInput.pitch = clamp(this.lookInput.pitch + dy * 0.038, -1, 1);
  }

  clearTransientInput() {
    this.throttleInput = 0;
    this.strafeInput = 0;
    this.lookInput.yaw = 0;
    this.lookInput.pitch = 0;
  }

  orbit(dx, dy) {
    const center = _v.copy(this.focus.posUniv);
    _v2.copy(this.nav.pos).sub(center);
    _u.set(0, 1, 0).applyQuaternion(this.nav.quat);
    _r.set(1, 0, 0).applyQuaternion(this.nav.quat);
    _v2.applyQuaternion(_q.setFromAxisAngle(_u, -dx * 0.004));
    _v2.applyQuaternion(_q.setFromAxisAngle(_r, -dy * 0.004));
    this.nav.pos.copy(center).add(_v2);
    _m.lookAt(this.nav.pos, center, _u);
    this.nav.quat.setFromRotationMatrix(_m);
  }

  pointerUp(e) {
    if (e.button === 2) this.boosting = false;
    if (e.button === 0) this.firing = false;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 2) {
      this._pinchDist = this.pinchDistOf([...this.pointers.values()]);
      this._pinchMid = this.midpointOf([...this.pointers.values()]);
    }
    if (!this._drag || this._drag.id !== e.pointerId) return;
    // press-and-release without movement IS a click, however long it took —
    // time-based windows get inflated by slow frames and eat valid taps
    const thresh = this._drag.touch ? 14 : 7;        // fingers wobble more than mice
    const wasClick = this._drag.moved < thresh;
    const wasTouch = this._drag.touch;
    const btn = this._drag.button;
    this._drag = null;
    // Desktop LMB belongs exclusively to weapons. Keeping the old target-click
    // side effect here could switch to fly-to before a quick shot reached the
    // next simulation frame. Touch taps still mark/select planets.
    if (wasClick && btn === 0 && wasTouch && this.onClick) {
      this.onClick(e.clientX, e.clientY);
    }
  }

  wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 120 : 1;
    this.wheelImpulse += -e.deltaY * unit;
  }

  update(dt) {
    const nav = this.nav;
    const lookDecay = Math.exp(-dt * 7.5);
    this.lookInput.yaw *= lookDecay;
    this.lookInput.pitch *= lookDecay;
    if (this.horizonAssist > 0) {
      const response = 1 - Math.exp(-dt * (0.8 + this.horizonAssist * 5.2));
      stabilizeHorizon(nav.quat, this.surfaceUp, response * this.horizonAssist);
    }
    const boosting = this.enabled && (this.boosting || keys.ShiftLeft || keys.ShiftRight);
    // Boost has its own lower drag curve. Previously the ordinary 2.4/s
    // damping cancelled most of the boost acceleration, so RMB looked active
    // while the ship barely gained speed.
    const drag = boosting
      ? (0.42 + this.atmosphereFactor * 0.46)
      // Keep some inertia in open space, while dense air still settles the
      // ship promptly enough for a precise landing approach.
      : (1.65 + this.atmosphereFactor * 0.75);
    nav.vel.multiplyScalar(Math.exp(-dt * drag));
    if (this.enabled && this.wheelImpulse !== 0) {
      _f.set(0, 0, -1).applyQuaternion(nav.quat);
      const wheelGain = 0.012 * (1 - this.atmosphereFactor * 0.55);
      nav.vel.addScaledVector(_f, this.wheelImpulse * wheelGain * this.speedScale * this.gravityPower);
      this.wheelImpulse = 0;
      // Loosen the atmospheric cruise cap a touch: the old 18→5 drop (−72%)
      // felt like hitting a wall. 18→8 keeps space top speed intact while
      // letting dense-air flight breathe.
      const maxV = this.speedScale * (18 - this.atmosphereFactor * 10) * this.gravityPower;
      if (nav.vel.length() > maxV) nav.vel.setLength(maxV);
    } else {
      this.wheelImpulse = 0;
    }
    // Keyboard thrusters complement mouse steering. A/D used to share the
    // same weak acceleration as W/S, so lateral motion was almost invisible
    // against a planet or at orbital speed. Give the lateral jets their own
    // stronger authority and expose the axes to the ship presentation.
    if (this.enabled) {
      const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      this.throttleInput = f;
      this.strafeInput = r;
      applyFlightThrusters(nav.vel, nav.quat, f, r, this.speedScale, dt,
        this.gravityPower, this.navigationPower);
      if (boosting) {
        _f.set(0, 0, -1).applyQuaternion(nav.quat);
        const boostAcceleration = this.speedScale * (10.0 + (1 - this.atmosphereFactor) * 7.1)
          * this.gravityPower;
        nav.vel.addScaledVector(_f, boostAcceleration * dt);
        // Raise the atmospheric floor (6.96 → 8.4) and trim the space bonus
        // (4.06 → 2.62) so vacuum top speed is unchanged at 11.02.
        const boostLimit = flightBoostSpeedLimit(
          this.speedScale,
          this.atmosphereFactor,
          this.gravityPower,
        );
        if (nav.vel.length() > boostLimit) nav.vel.setLength(boostLimit);
      }
    } else {
      this.throttleInput = 0;
      this.strafeInput = 0;
    }
    nav.pos.addScaledVector(nav.vel, dt);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('pointerup', this._onPointerUp);
    this.dom.removeEventListener('pointercancel', this._onPointerUp);
    this.dom.removeEventListener('wheel', this._onWheel);
    this.dom.removeEventListener('contextmenu', this._onContextMenu);
    document.removeEventListener('mousemove', this._onLockedMove);
    window.removeEventListener('pointerup', this._onGlobalPointerUp, true);
    window.removeEventListener('blur', this._onBlur);
  }
}

// ============================================================================

export class WalkControls {
  constructor(dom, { lookScale = () => 1, onLook = null, resolveCollision = null } = {}) {
    this.dom = dom;
    this.lookScale = lookScale;
    this.onLook = onLook;
    this.resolveCollision = resolveCollision;
    this.active = false;
    this.planet = null;
    this.posLocal = new THREE.Vector3();   // eye position, planet-local
    this.yaw = 0;
    this.pitch = 0;
    this.vR = 0;                            // radial (vertical) velocity
    this.grounded = false;
    this.eyeHeight = 1.7;
    this.hSpeed = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.previousPosLocal = new THREE.Vector3();

    // analog input (virtual joystick): x strafe, y forward, set by the UI
    this.touchMove = { x: 0, y: 0 };
    this.touchJump = false;

    this._drag = null;
    this._onMove = (e) => {
      if (!this.active) return;
      let mx = 0, my = 0;
      if (document.pointerLockElement) { mx = e.movementX; my = e.movementY; }
      else if (this._drag && this._drag.id === e.pointerId) {
        mx = e.clientX - this._drag.x; my = e.clientY - this._drag.y;
        this._drag.x = e.clientX; this._drag.y = e.clientY;
      } else return;
      const scale = this.lookScale();
      this.yaw += mx * 0.0024 * scale;
      this.pitch = clamp(this.pitch - my * 0.0024 * scale, -1.45, 1.45);
      this.onLook?.(mx, my);
    };
    this._onDown = (e) => {
      if (this.active && !document.pointerLockElement && !this._drag) {
        try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
        this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    };
    this._onUp = (e) => { if (this._drag && this._drag.id === e.pointerId) this._drag = null; };
    dom.addEventListener('pointermove', this._onMove);
    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointerup', this._onUp);
    dom.addEventListener('pointercancel', this._onUp);
  }

  // frame vectors for the point we are standing on
  frame(up, east, north) {
    if (Math.abs(up.y) < 0.93) east.crossVectors(Y_AXIS, up).normalize();
    else east.crossVectors(X_AXIS, up).normalize();
    north.crossVectors(up, east);
  }

  enter(planet, posLocal, viewDir) {
    this.active = true;
    this.planet = planet;
    this.posLocal.copy(posLocal);
    this.vR = 0;
    this.hSpeed.set(0, 0, 0);
    _u.copy(posLocal).normalize();
    this.frame(_u, _r, _f);                       // east in _r, north in _f
    _v.copy(viewDir).projectOnPlane(_u).normalize();
    if (_v.lengthSq() < 0.1) _v.copy(_f);
    this.yaw = Math.atan2(_v.dot(_r), _v.dot(_f));
    this.pitch = clamp(Math.asin(clamp(viewDir.dot(_u), -1, 1)), -1.2, 1.2);
    this.updateQuat();
  }

  exit() {
    this.active = false;
    this.planet = null;
  }

  updateQuat() {
    _u.copy(this.posLocal).normalize();
    this.frame(_u, _r, _f);
    // view direction from yaw/pitch in the local frame
    _v.copy(_f).multiplyScalar(Math.cos(this.yaw)).addScaledVector(_r, Math.sin(this.yaw));
    _v2.copy(_v).multiplyScalar(Math.cos(this.pitch)).addScaledVector(_u, Math.sin(this.pitch)); // viewDir
    _r.crossVectors(_v2, _u);
    if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
    _r.normalize();
    _f.crossVectors(_r, _v2);                     // camera-up
    _m.makeBasis(_r, _f, _v.copy(_v2).negate());
    this.quat.setFromRotationMatrix(_m);
    return _v2; // viewDir (in _v2)
  }

  update(dt) {
    if (!this.active || !this.planet) return;
    const p = this.planet;
    this.previousPosLocal.copy(this.posLocal);
    _u.copy(this.posLocal).normalize();
    this.frame(_u, _r, _f);

    const fwd = _v.copy(_f).multiplyScalar(Math.cos(this.yaw)).addScaledVector(_r, Math.sin(this.yaw));
    const right = _v2.crossVectors(fwd, _u).normalize();

    const fIn = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + this.touchMove.y;
    const rIn = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + this.touchMove.x;
    const stickMag = Math.hypot(this.touchMove.x, this.touchMove.y);
    const run = keys.ShiftLeft || keys.ShiftRight || stickMag > 0.92;  // slam the stick to run
    const speed = run ? 18 : 7;
    _f.set(0, 0, 0).addScaledVector(fwd, fIn).addScaledVector(right, rIn);
    if (_f.lengthSq() > 1) _f.normalize();          // keep analog magnitudes
    _f.multiplyScalar(speed);
    // smooth accelerate / decelerate
    this.hSpeed.lerp(_f, 1 - Math.exp(-dt * 10));
    this.posLocal.addScaledVector(this.hSpeed, dt);

    // vertical: gravity toward the core, ground = the height function
    let r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / r);
    this.vR -= p.gravity * dt;
    if (this.grounded && (keys.Space || this.touchJump)) {
      this.vR = Math.sqrt(2 * p.gravity * 1.4);
      this.grounded = false;
      this.touchJump = false;   // latched: a quick tap survives slow frames
    }
    r += this.vR * dt;
    const groundR = p.R + p.height(_u, p.fullMaxFreq) + this.eyeHeight;
    if (r <= groundR) { r = groundR; this.vR = 0; this.grounded = true; }
    else if (r > groundR + 0.01) this.grounded = false;
    this.posLocal.copy(_u).multiplyScalar(r);

    // Optional authored props share the same planet-local frame as terrain.
    // The resolver may push the capsule out of a volume or replace the terrain
    // floor with a walkable top face.
    this.resolveCollision?.(this, this.previousPosLocal);

    this.updateQuat();
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointercancel', this._onUp);
  }
}
