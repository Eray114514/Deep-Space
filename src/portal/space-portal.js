// A fold between two places in the universe, usable at any scale: the large
// 弦界航道 lane, a race gate, or a person-sized door onto a planet surface.
//
// The portal is a pair of frames (source and target, each a universe-space
// position and orientation) and a shaped opening. Everything that is seen
// through it is rendered by the production pipeline from the mapped camera
// (portal-view.js) and composited per pixel (portal-composite-pass.js). This
// module owns the geometry, the opening/closing choreography and the mapping
// between the two spaces; it renders nothing itself.

import * as THREE from 'three';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// Shape and character of an opening. Every field can be overridden per portal.
export const DEFAULT_PORTAL_PROFILE = Object.freeze({
  // 'sphere': a wormhole mouth (lensing ball, crossed through a short throat);
  // 'plane': a fold seam with a shaped opening (doors, gates).
  shape: 'plane',
  radius: 400, // metres, sphere mouths
  halfWidth: 380, // metres, plane seams
  halfHeight: 300,
  // contour = 1 + Σ amp·sin(k·θ + phase + speed·t); four harmonics
  harmonics: Object.freeze([
    Object.freeze({ k: 3, amp: 0.055, phase: 0.7, speed: 0.12 }),
    Object.freeze({ k: 5, amp: 0.032, phase: 2.1, speed: -0.2 }),
    Object.freeze({ k: 7, amp: 0.018, phase: 4.0, speed: 0.3 }),
    Object.freeze({ k: 11, amp: 0.010, phase: 1.3, speed: 0.5 }),
  ]),
  living: 1, // animate the contour harmonics
  rimWidth: 0.003, // seam filament width, fraction of the smaller half size
  rimIntensity: 4.5,
  rimColor: Object.freeze([0.78, 0.9, 1.0]),
  lensing: 0.9, // how strongly light bends around the seam
  lensWidth: 0.16, // reach of the bend, fraction of the smaller half size
  openSeconds: 2.6,
  closeSeconds: 1.5,
  seamFraction: 0.36, // share of the opening spent as a thin seam before it tears
  bidirectional: true,
  persistent: false, // stay open after a crossing (race gates, doors)
});

export function createPortalProfile(options = {}) {
  const profile = { ...DEFAULT_PORTAL_PROFILE, ...options };
  profile.harmonics = (options.harmonics || DEFAULT_PORTAL_PROFILE.harmonics).map((h) => ({ ...h }));
  profile.rimColor = [...(options.rimColor || DEFAULT_PORTAL_PROFILE.rimColor)];
  return profile;
}

// The 弦界 lane: a wormhole mouth that forms ahead of the ship.
export function wormholePortalProfile(options = {}) {
  return createPortalProfile({
    shape: 'sphere', radius: 420, rimIntensity: 2.2, lensing: 1.0, openSeconds: 1.5,
    closeSeconds: 1.4, seamFraction: 0.18, ...options,
  });
}

// A person-sized door: tighter, calmer contour, brighter relative seam.
export function doorPortalProfile(options = {}) {
  return createPortalProfile({
    halfWidth: 1.4, halfHeight: 2.3, rimWidth: 0.012, lensing: 0.6, lensWidth: 0.22,
    openSeconds: 1.2, closeSeconds: 0.7, seamFraction: 0.3, persistent: true,
    harmonics: [
      { k: 3, amp: 0.025, phase: 0.7, speed: 0.4 },
      { k: 5, amp: 0.015, phase: 2.1, speed: -0.6 },
      { k: 9, amp: 0.008, phase: 4.0, speed: 0.9 },
      { k: 13, amp: 0.004, phase: 1.3, speed: 1.4 },
    ],
    ...options,
  });
}

// Opening choreography as pure functions of normalised time: a thin bright
// seam draws itself across the full width, holds under rising tension, then
// tears open vertically with a slight overshoot.
export function portalOpening(u, seamFraction = DEFAULT_PORTAL_PROFILE.seamFraction) {
  const k = clamp01(u);
  const seam = seamFraction;
  const x = smoothstep(0, seam * 0.75, k);
  const tear = clamp01((k - seam) / (1 - seam));
  const eased = tear < 1 ? 1 - Math.pow(1 - tear, 3) : 1;
  const overshoot = Math.sin(Math.PI * clamp01(tear * 1.15)) * 0.045 * (1 - tear);
  const y = k < seam ? 0.012 * x : 0.012 + (1 - 0.012) * eased + overshoot;
  const tension = smoothstep(seam * 0.4, seam, k) * (1 - smoothstep(seam, seam + 0.25, k));
  const flash = Math.exp(-Math.pow((k - seam - 0.02) / 0.05, 2));
  return { x, y: Math.min(1.06, y), tension, flash };
}

export function portalClosing(u) {
  const k = clamp01(u);
  // the opening relaxes vertically back into a seam, then the seam heals
  const y = 1 - smoothstep(0, 0.7, k);
  const x = 1 - smoothstep(0.55, 1, k);
  return { x, y: Math.max(0.012 * x, y), tension: Math.sin(Math.PI * k) * 0.6, flash: 0 };
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _ray = new THREE.Vector3();

export class SpacePortal {
  constructor(profile = {}) {
    this.profile = createPortalProfile(profile);
    this.source = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this.target = { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
    this.phase = 'closed'; // closed | opening | open | closing
    this.clock = 0;
    this.open = { x: 0, y: 0, tension: 0, flash: 0 };
    this.time = 0;
  }

  get shape() { return this.profile.shape; }
  get radius() { return this.profile.radius; }
  get halfWidth() { return this.profile.halfWidth; }
  get halfHeight() { return this.profile.halfHeight; }
  get isVisible() { return this.phase !== 'closed'; }
  get isOpen() { return this.phase === 'open'; }
  get openness() { return this.open.y; }

  setFrames(sourcePosition, sourceQuaternion, targetPosition, targetQuaternion) {
    this.source.position.copy(sourcePosition);
    this.source.quaternion.copy(sourceQuaternion);
    this.target.position.copy(targetPosition);
    this.target.quaternion.copy(targetQuaternion);
  }

  // After a crossing the far side becomes the near side.
  swapSides() {
    const s = this.source;
    this.source = this.target;
    this.target = s;
  }

  beginOpening() {
    this.phase = 'opening';
    this.clock = 0;
  }

  beginClosing() {
    if (this.phase === 'closed' || this.phase === 'closing') return;
    this.phase = 'closing';
    this.clock = 0;
  }

  update(dt, time) {
    this.time = time;
    if (this.phase === 'opening') {
      this.clock += dt;
      const u = this.clock / this.profile.openSeconds;
      this.open = portalOpening(u, this.profile.seamFraction);
      if (u >= 1) {
        this.phase = 'open';
        this.open = { x: 1, y: 1, tension: 0, flash: 0 };
      }
    } else if (this.phase === 'closing') {
      this.clock += dt;
      const u = this.clock / this.profile.closeSeconds;
      this.open = portalClosing(u);
      if (u >= 1) {
        this.phase = 'closed';
        this.open = { x: 0, y: 0, tension: 0, flash: 0 };
      }
    } else if (this.phase === 'open') {
      this.open = { x: 1, y: 1, tension: 0, flash: 0 };
    }
    return this.open;
  }

  contour(angle, time = this.time) {
    let r = 1;
    for (const h of this.profile.harmonics) {
      r += h.amp * Math.sin(h.k * angle + h.phase + h.speed * time * this.profile.living);
    }
    // The banks separate first at the middle. The tips remain pinned
    // during the snap, then relax to the authored contour.
    return r - this.open.tension * .20 * Math.abs(Math.sin(2 * angle));
  }

  // Universe-space point -> source-frame local coordinates.
  toSourceLocal(point, out = new THREE.Vector3()) {
    _q.copy(this.source.quaternion).invert();
    return out.copy(point).sub(this.source.position).applyQuaternion(_q);
  }

  // Map a universe-space pose through the opening to the far side.
  mapPosition(point, out = new THREE.Vector3()) {
    this.toSourceLocal(point, out);
    // Through a mouth you leave by the far surface of the other mouth, so the
    // throat is traversed front to back instead of landing inside the ball.
    if (this.profile.shape === 'sphere') out.z = -out.z;
    return out.applyQuaternion(this.target.quaternion).add(this.target.position);
  }

  mapQuaternion(quaternion, out = new THREE.Quaternion()) {
    _q.copy(this.source.quaternion).invert();
    _q.premultiply(this.target.quaternion);
    return out.copy(quaternion).premultiply(_q);
  }

  mapDirection(direction, out = new THREE.Vector3()) {
    _q.copy(this.source.quaternion).invert();
    return out.copy(direction).applyQuaternion(_q).applyQuaternion(this.target.quaternion);
  }

  // Did the segment prev -> curr (universe space) pass through the opening?
  // Returns the crossing fraction along the segment, or -1.
  crossing(prev, curr) {
    if (this.open.y < 0.9) return -1;
    if (this.profile.shape === 'sphere') {
      // first entry of the segment into the mouth
      const R = this.radius * this.open.y;
      const a = this.toSourceLocal(prev, new THREE.Vector3());
      const b = this.toSourceLocal(curr, new THREE.Vector3());
      if (a.length() <= R) return -1;
      const d = b.clone().sub(a);
      const A = d.dot(d), B = 2 * a.dot(d), C = a.dot(a) - R * R;
      const disc = B * B - 4 * A * C;
      if (A < 1e-12 || disc < 0) return -1;
      const t = (-B - Math.sqrt(disc)) / (2 * A);
      return t >= 0 && t <= 1 ? t : -1;
    }
    const a = this.toSourceLocal(prev, new THREE.Vector3());
    const b = this.toSourceLocal(curr, new THREE.Vector3());
    if (Math.sign(a.z) === Math.sign(b.z) || a.z === b.z) return -1;
    const t = a.z / (a.z - b.z);
    const x = (a.x + (b.x - a.x) * t) / (this.halfWidth * this.open.x);
    const y = (a.y + (b.y - a.y) * t) / (this.halfHeight * this.open.y);
    const inside = Math.hypot(x, y) <= this.contour(Math.atan2(y, x)) * 0.985;
    return inside ? t : -1;
  }

  // After handoff only draw the previous system if the camera can see it.
  // Four forward corner rays bound the whole screen on the portal plane.
  needsBackView(eye, camera, eyeAcross) {
    if (this.shape !== 'plane') return true;
    this.toSourceLocal(eye, _eye);
    const inner = 1 - this.profile.harmonics.reduce((sum, h) => sum + Math.abs(h.amp), 0)
      - .2 * this.open.tension;
    const rx = this.halfWidth * this.open.x, ry = this.halfHeight * this.open.y;
    for (const x of [-1, 1]) for (const y of [-1, 1]) {
      _ray.set(x, y, .5).applyMatrix4(camera.projectionMatrixInverse)
        .applyQuaternion(camera.quaternion).applyQuaternion(_q);
      const t = -_eye.z / _ray.z;
      if (!eyeAcross) {
        if (t > 0) return true;
      } else if (!(t > 0) || Math.hypot((_eye.x + t*_ray.x) / rx, (_eye.y + t*_ray.y) / ry) >= inner) {
        return true;
      }
    }
    return false;
  }

  // Signed distance (metres, + in front of the source face) and normalised
  // radial position of a universe point relative to the opening.
  locate(point) {
    const local = this.toSourceLocal(point, _v);
    if (this.profile.shape === 'sphere') {
      return { z: local.length() - this.radius, radial: Math.hypot(local.x, local.y) / this.radius, local: local.clone() };
    }
    const x = local.x / this.halfWidth, y = local.y / this.halfHeight;
    return { z: local.z, radial: Math.hypot(x, y) / this.contour(Math.atan2(y, x)), local: local.clone() };
  }

  // Composite uniforms in render space (universe minus the camera origin).
  writeComposite(uniforms, renderOrigin, profileUniforms = true) {
    const u = uniforms;
    u.uCenter.value.copy(this.source.position).sub(renderOrigin);
    _m.makeRotationFromQuaternion(this.source.quaternion);
    u.uRight.value.setFromMatrixColumn(_m, 0);
    u.uUp.value.setFromMatrixColumn(_m, 1);
    u.uNormal.value.setFromMatrixColumn(_m, 2);
    u.uHalf.value.set(this.halfWidth, this.halfHeight);
    u.uShape.value = this.profile.shape === 'sphere' ? 1 : 0;
    u.uRadius.value = this.radius;
    u.uOpen.value.set(this.open.x, this.open.y);
    u.uTension.value = this.open.tension;
    u.uFlash.value = this.open.flash;
    u.uTime.value = this.time;
    if (!profileUniforms) return;
    const p = this.profile;
    const h = p.harmonics;
    u.uHarmK.value.set(h[0].k, h[1].k, h[2].k, h[3].k);
    u.uHarmA.value.set(h[0].amp, h[1].amp, h[2].amp, h[3].amp);
    u.uHarmP.value.set(h[0].phase, h[1].phase, h[2].phase, h[3].phase);
    u.uHarmS.value.set(h[0].speed, h[1].speed, h[2].speed, h[3].speed);
    u.uLiving.value = p.living;
    u.uRimWidth.value = p.rimWidth;
    u.uRimIntensity.value = p.rimIntensity;
    u.uRimColor.value.setRGB(...p.rimColor);
    u.uLensing.value = p.lensing;
    u.uLensWidth.value = p.lensWidth;
  }
}
