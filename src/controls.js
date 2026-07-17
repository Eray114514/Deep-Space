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

export class SpaceControls {
  constructor(dom, nav, { onClick } = {}) {
    this.dom = dom;
    this.nav = nav;                  // { pos, quat, vel } — pos in universe coords
    this.onClick = onClick;
    this.enabled = true;
    this.speedScale = 1000;          // set per-frame by main from altitude
    this.atmosphereFactor = 0;
    this.surfaceUp = new THREE.Vector3(0, 1, 0);
    this.horizonAssist = 0;
    this.boosting = false;
    this.firing = false;
    this.firePressed = false;
    this.pulseDrive = false;
    this.wheelImpulse = 0;
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
    this._onBlur = () => { this.boosting = false; this.firing = false; };
    this._onWheel = (e) => this.wheel(e);
    this._onLockedMove = (e) => this.lockedMove(e);
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('pointercancel', this._onPointerUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
    document.addEventListener('mousemove', this._onLockedMove);
    window.addEventListener('pointerup', this._onGlobalPointerUp, true);
    window.addEventListener('blur', this._onBlur);
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
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
      this.nav.quat.multiply(_q.setFromAxisAngle(Y_AXIS, -dx * 0.0026));
      this.nav.quat.multiply(_q.setFromAxisAngle(X_AXIS, -dy * 0.0026));
      this.nav.quat.normalize();
    }
  }

  lockedMove(e) {
    if (!this.enabled || document.pointerLockElement !== this.dom) return;
    this.nav.quat.multiply(_q.setFromAxisAngle(Y_AXIS, -e.movementX * 0.0019));
    this.nav.quat.multiply(_q.setFromAxisAngle(X_AXIS, -e.movementY * 0.0019));
    this.nav.quat.normalize();
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
    if (this.horizonAssist > 0) {
      const response = 1 - Math.exp(-dt * (0.8 + this.horizonAssist * 5.2));
      stabilizeHorizon(nav.quat, this.surfaceUp, response * this.horizonAssist);
    }
    const boosting = this.enabled && (this.boosting || keys.ShiftLeft || keys.ShiftRight);
    const pulsing = this.enabled && this.pulseDrive;
    // Boost has its own lower drag curve. Previously the ordinary 2.4/s
    // damping cancelled most of the boost acceleration, so RMB looked active
    // while the ship barely gained speed.
    const drag = pulsing
      ? (0.18 + this.atmosphereFactor * 0.7)
      : boosting
      ? (0.42 + this.atmosphereFactor * 0.46)
      : 2.4;
    nav.vel.multiplyScalar(Math.exp(-dt * drag));
    if (this.enabled && this.wheelImpulse !== 0) {
      _f.set(0, 0, -1).applyQuaternion(nav.quat);
      const wheelGain = 0.012 * (1 - this.atmosphereFactor * 0.68);
      nav.vel.addScaledVector(_f, this.wheelImpulse * wheelGain * this.speedScale);
      this.wheelImpulse = 0;
      const maxV = this.speedScale * (18 - this.atmosphereFactor * 13);
      if (nav.vel.length() > maxV) nav.vel.setLength(maxV);
    } else {
      this.wheelImpulse = 0;
    }
    // gentle WASD strafing as a bonus in space
    if (this.enabled) {
      const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
      const r = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
      if (f || r) {
        _f.set(r, 0, -f).normalize().applyQuaternion(nav.quat);
        nav.vel.addScaledVector(_f, this.speedScale * 2.2 * dt);
      }
      if (pulsing) {
        _f.set(0, 0, -1).applyQuaternion(nav.quat);
        // Pulse cruise is an explicit 2× tier above RMB/Shift boost.
        const pulseAcceleration = this.speedScale * (20.0 + (1 - this.atmosphereFactor) * 14.2);
        nav.vel.addScaledVector(_f, pulseAcceleration * dt);
        const pulseLimit = this.speedScale * (13.92 + (1 - this.atmosphereFactor) * 8.12);
        if (nav.vel.length() > pulseLimit) nav.vel.setLength(pulseLimit);
      } else if (boosting) {
        _f.set(0, 0, -1).applyQuaternion(nav.quat);
        const boostAcceleration = this.speedScale * (10.0 + (1 - this.atmosphereFactor) * 7.1);
        nav.vel.addScaledVector(_f, boostAcceleration * dt);
        const boostLimit = this.speedScale * (6.96 + (1 - this.atmosphereFactor) * 4.06);
        if (nav.vel.length() > boostLimit) nav.vel.setLength(boostLimit);
      }
    }
    nav.pos.addScaledVector(nav.vel, dt);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('pointerup', this._onPointerUp);
    this.dom.removeEventListener('wheel', this._onWheel);
    document.removeEventListener('mousemove', this._onLockedMove);
    window.removeEventListener('pointerup', this._onGlobalPointerUp, true);
    window.removeEventListener('blur', this._onBlur);
  }
}

// ============================================================================

export class WalkControls {
  constructor(dom) {
    this.dom = dom;
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
      this.yaw += mx * 0.0024;
      this.pitch = clamp(this.pitch - my * 0.0024, -1.45, 1.45);
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

    this.updateQuat();
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointerup', this._onUp);
  }
}
