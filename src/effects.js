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
    const r = 400 + Math.random() * 9000;
    const a = Math.random() * Math.PI * 2;
    const z = -8000 + Math.random() * 48000;
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
    const len = Math.min(300 + speed * 0.0022, 14000) * Math.max(0.25, intensity);

    for (let i = 0; i < this.count; i++) {
      const s = this.streaks[i];
      s.addScaledVector(_dir, -step);
      if (s.dot(_dir) < -9000) this.scatter(s);
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

// ============================================================================
// Sky dome: a camera-centred gradient hemisphere — horizon glow, zenith
// depth, a sun halo — blended in by atmosphere density and daylight.
// Painted first with no depth test, so it sits behind the world but over
// the stars (which fade out via their own dimming).
// ============================================================================

export class SkyDome {
  constructor(scene) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uUp: { value: new THREE.Vector3(0, 1, 0) },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uHorizon: { value: new THREE.Color(0x88bbff) },
        uZenith: { value: new THREE.Color(0x224488) },
        uSunTint: { value: new THREE.Color(1.0, 0.92, 0.78) },
        uAlpha: { value: 0 },
      },
      vertexShader: /* glsl */`
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <logdepthbuf_pars_fragment>
        uniform vec3 uUp, uSunDir, uHorizon, uZenith, uSunTint;
        uniform float uAlpha;
        varying vec3 vDir;
        void main() {
          #include <logdepthbuf_fragment>
          vec3 dir = normalize(vDir);
          float u = dot(dir, uUp);
          float t = pow(clamp(1.0 - max(u, 0.0), 0.0, 1.0), 3.2);
          vec3 col = mix(uZenith, uHorizon * 0.92, t);
          float sd = max(dot(dir, uSunDir), 0.0);
          col += uSunTint * (pow(sd, 700.0) * 1.3 + pow(sd, 16.0) * 0.16);
          float a = uAlpha * (u < 0.0 ? max(0.0, 1.0 + u * 2.4) : 1.0);
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
        }`,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      // proper depth test (log-depth aware): terrain must occlude the sky —
      // transparent materials draw after opaque, so without this the dome
      // would wash over the whole world
      depthTest: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4e5, 48, 32), this.mat);
    this.mesh.renderOrder = -7;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(up, sunDir, horizon, zenith, alpha) {
    const u = this.mat.uniforms;
    u.uUp.value.copy(up);
    u.uSunDir.value.copy(sunDir);
    u.uHorizon.value.copy(horizon);
    u.uZenith.value.copy(zenith);
    u.uAlpha.value = alpha;
    this.mesh.visible = alpha > 0.01;
  }
}

// ============================================================================
// The ship: a low-poly craft flying just ahead of the camera whenever
// you're in flight — banks into turns, engines glow with speed, fades out
// when you step onto a planet. We are no longer a disembodied camera.
// ============================================================================

const _sq = new THREE.Quaternion();
const _sv = new THREE.Vector3();
const _sf = new THREE.Vector3();
const _su = new THREE.Vector3();
const _sr = new THREE.Vector3();

export class Ship {
  constructor(scene) {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.6, roughness: 0.38 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb8452a, metalness: 0.4, roughness: 0.5 });
    const canopy = new THREE.MeshStandardMaterial({ color: 0x16242e, metalness: 0.3, roughness: 0.12 });
    const engineGlowMat = new THREE.MeshStandardMaterial({
      color: 0x143040, emissive: new THREE.Color(0x66ddff), emissiveIntensity: 2.2,
    });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.scale.set(sx, sy, sz);
      g.add(m);
      return m;
    };

    // fuselage points down -Z (three.js forward)
    add(new THREE.CylinderGeometry(0.5, 1.05, 6.6, 8), hull, 0, 0, 0.4, -Math.PI / 2);
    add(new THREE.ConeGeometry(0.5, 2.6, 8), hull, 0, 0, -3.6, -Math.PI / 2);
    add(new THREE.SphereGeometry(0.62, 14, 10), canopy, 0, 0.55, -1.4, 0, 0, 0, 1, 0.62, 1.5);
    // swept wings with a touch of dihedral
    add(new THREE.BoxGeometry(4.2, 0.12, 1.9), hull, 2.6, -0.1, 1.5, 0, 0.32, 0.07);
    add(new THREE.BoxGeometry(4.2, 0.12, 1.9), hull, -2.6, -0.1, 1.5, 0, -0.32, -0.07);
    add(new THREE.BoxGeometry(0.12, 1.5, 1.6), accent, 0, 0.85, 3.0, 0.18);
    // wingtip accents
    add(new THREE.BoxGeometry(0.5, 0.3, 1.6), accent, 4.45, 0.05, 2.2, 0, 0.32, 0);
    add(new THREE.BoxGeometry(0.5, 0.3, 1.6), accent, -4.45, 0.05, 2.2, 0, -0.32, 0);
    // engines + glow
    add(new THREE.CylinderGeometry(0.42, 0.5, 1.7, 8), hull, 1.15, -0.2, 3.1, -Math.PI / 2);
    add(new THREE.CylinderGeometry(0.42, 0.5, 1.7, 8), hull, -1.15, -0.2, 3.1, -Math.PI / 2);
    this.glowA = add(new THREE.CylinderGeometry(0.3, 0.36, 0.3, 8), engineGlowMat, 1.15, -0.2, 4.0, -Math.PI / 2);
    this.glowB = add(new THREE.CylinderGeometry(0.3, 0.36, 0.3, 8), engineGlowMat, -1.15, -0.2, 4.0, -Math.PI / 2);

    g.visible = false;
    this.group = g;
    scene.add(g);

    this.smQuat = new THREE.Quaternion();
    this.roll = 0;
    this.vis = 0;
    this.engineMat = engineGlowMat;
  }

  update(dt, nav, state, speed, warp) {
    const flying = state === 'space' || state === 'flyto' || state === 'warp'
      || state === 'takeoff' || state === 'landing';
    this.vis = Math.max(0, Math.min(1, this.vis + (flying ? 1 : -1) * dt * 2.5));
    this.group.visible = this.vis > 0.02;
    if (!this.group.visible) return;

    // the ship's nose lags the camera a touch, which reads as mass
    this.smQuat.slerp(nav.quat, 1 - Math.exp(-dt * 6));
    // bank into turns: how much yaw is still pending between ship and camera
    _sq.copy(this.smQuat).invert().multiply(nav.quat);
    const rollTarget = Math.max(-0.55, Math.min(0.55, -_sq.y * 14));
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-dt * 5));

    _sf.set(0, 0, -1).applyQuaternion(this.smQuat);   // forward
    _su.set(0, 1, 0).applyQuaternion(this.smQuat);
    this.group.position.copy(_sf).multiplyScalar(19).addScaledVector(_su, -4.6);
    this.group.quaternion.copy(this.smQuat)
      .multiply(_sq.setFromAxisAngle(_sv.set(0, 0, 1), this.roll));
    this.group.scale.setScalar(this.vis);

    const burn = 1.2 + Math.min(1.6, speed / 1.5e6 + warp * 1.4) * 2.6;
    this.engineMat.emissiveIntensity = burn;
    const stretch = 1 + Math.min(8, speed / 4e5 + warp * 7);
    this.glowA.scale.set(1, stretch, 1);
    this.glowB.scale.set(1, stretch, 1);
  }
}
