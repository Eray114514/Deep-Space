// Warp-flight visuals: hyperspace streak lines that rush past the camera.
// Streaks live in render space (camera at origin) inside a cylinder around
// the flight path; their parallax is scaled way down so at ~3,000 km/s they
// read as a light tunnel instead of single-frame noise.

import * as THREE from 'three';

const _dir = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

const PARALLAX = 0.012;            // fraction of true speed applied to streaks

export class WarpStreaks {
  constructor(scene, count = 340) {
    this.count = count;
    this.streaks = [];               // camera-relative positions
    for (let i = 0; i < count; i++) this.streaks.push(new THREE.Vector3());
    this.positions = new Float32Array(count * 2 * 3);
    const colors = new Float32Array(count * 2 * 3);
    for (let i = 0; i < count; i++) {
      const w = 0.55 + Math.random() * 0.45;
      colors[i * 6] = 0.72 * w; colors[i * 6 + 1] = 0.84 * w; colors[i * 6 + 2] = 1.0 * w;  // head
      colors[i * 6 + 3] = 0.02; colors[i * 6 + 4] = 0.03; colors[i * 6 + 5] = 0.05;          // tail
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 6;
    this.lines.visible = false;
    scene.add(this.lines);
  }

  scatter(streak) {
    const r = 180 + Math.random() * 3800;
    const a = Math.random() * Math.PI * 2;
    const z = -3000 + Math.random() * 18000;
    streak.copy(_dir).multiplyScalar(z)
      .addScaledVector(_e1, Math.cos(a) * r)
      .addScaledVector(_e2, Math.sin(a) * r);
  }

  reset(velDir) {
    _dir.copy(velDir).normalize();
    _e1.crossVectors(_dir, Math.abs(_dir.y) < 0.9 ? Y : X).normalize();
    _e2.crossVectors(_dir, _e1);
    for (const s of this.streaks) this.scatter(s);
  }

  // vel: true velocity vector (m/s); intensity 0..1
  update(dt, vel, intensity) {
    if (intensity <= 0.01) { this.lines.visible = false; return; }
    const speed = vel.length();
    if (speed < 1) { this.lines.visible = false; return; }
    this.lines.visible = true;
    this.lines.material.opacity = Math.min(1, intensity) * 0.8;

    _dir.copy(vel).multiplyScalar(1 / speed);
    _e1.crossVectors(_dir, Math.abs(_dir.y) < 0.9 ? Y : X).normalize();
    _e2.crossVectors(_dir, _e1);
    const step = speed * dt * PARALLAX;
    const len = Math.min(200 + speed * 0.0022, 6500) * Math.max(0.25, intensity);

    for (let i = 0; i < this.count; i++) {
      const s = this.streaks[i];
      s.addScaledVector(_dir, -step);
      if (s.dot(_dir) < -4000) this.scatter(s);
      this.positions[i * 6] = s.x; this.positions[i * 6 + 1] = s.y; this.positions[i * 6 + 2] = s.z;
      _p.copy(s).addScaledVector(_dir, -len);
      this.positions[i * 6 + 3] = _p.x; this.positions[i * 6 + 4] = _p.y; this.positions[i * 6 + 5] = _p.z;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    if (this.lines.parent) this.lines.parent.remove(this.lines);
  }
}
