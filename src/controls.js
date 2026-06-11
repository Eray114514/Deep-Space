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

export class SpaceControls {
  constructor(dom, nav, { onClick } = {}) {
    this.dom = dom;
    this.nav = nav;                  // { pos, quat, vel } — pos in universe coords
    this.onClick = onClick;
    this.enabled = true;
    this.speedScale = 1000;          // set per-frame by main from altitude
    this.wheelImpulse = 0;
    this.focus = null;               // planet (for RMB orbit / two-finger orbit)

    // active pointers (multi-touch aware: 1 finger = look, 2 = pinch-fly + orbit)
    this.pointers = new Map();       // pointerId -> {x, y}
    this._drag = null;               // primary pointer gesture (click detection)
    this._pinchDist = 0;

    this._onPointerDown = (e) => this.pointerDown(e);
    this._onPointerMove = (e) => this.pointerMove(e);
    this._onPointerUp = (e) => this.pointerUp(e);
    this._onWheel = (e) => this.wheel(e);
    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    dom.addEventListener('pointercancel', this._onPointerUp);
    dom.addEventListener('wheel', this._onWheel, { passive: false });
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
    try { this.dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointers */ }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) {
      this._drag = {
        id: e.pointerId, button: e.button, touch: e.pointerType === 'touch',
        moved: 0, t: performance.now(),
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
      if (this._drag.button === 2 && this.focus) {
        this.orbit(dx, dy);
      } else {
        // free look
        this.nav.quat.multiply(_q.setFromAxisAngle(Y_AXIS, -dx * 0.0026));
        this.nav.quat.multiply(_q.setFromAxisAngle(X_AXIS, -dy * 0.0026));
        this.nav.quat.normalize();
      }
    }
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
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 2) {
      this._pinchDist = this.pinchDistOf([...this.pointers.values()]);
      this._pinchMid = this.midpointOf([...this.pointers.values()]);
    }
    if (!this._drag || this._drag.id !== e.pointerId) return;
    const thresh = this._drag.touch ? 14 : 7;        // fingers wobble more than mice
    const wasClick = this._drag.moved < thresh && performance.now() - this._drag.t < 500;
    const btn = this._drag.button;
    this._drag = null;
    if (wasClick && btn === 0 && this.onClick) this.onClick(e.clientX, e.clientY);
  }

  wheel(e) {
    e.preventDefault();
    if (!this.enabled) return;
    const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 120 : 1;
    this.wheelImpulse += -e.deltaY * unit;
  }

  update(dt) {
    const nav = this.nav;
    nav.vel.multiplyScalar(Math.exp(-dt * 2.4));
    if (this.enabled && this.wheelImpulse !== 0) {
      _f.set(0, 0, -1).applyQuaternion(nav.quat);
      nav.vel.addScaledVector(_f, this.wheelImpulse * 0.012 * this.speedScale);
      this.wheelImpulse = 0;
      const maxV = this.speedScale * 18;
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
    }
    nav.pos.addScaledVector(nav.vel, dt);
  }

  dispose() {
    this.dom.removeEventListener('pointerdown', this._onPointerDown);
    this.dom.removeEventListener('pointermove', this._onPointerMove);
    this.dom.removeEventListener('pointerup', this._onPointerUp);
    this.dom.removeEventListener('wheel', this._onWheel);
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
