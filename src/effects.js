// Warp-flight visuals: hyperspace streak lines that rush past the camera.
// Streaks live in render space (camera at origin) inside a cylinder around
// the flight path; their parallax is scaled way down so at ~3,000 km/s they
// read as a light tunnel instead of single-frame noise.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const _dir = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _p = new THREE.Vector3();
const _warpQ = new THREE.Quaternion();
const _warpM = new THREE.Matrix4();
const _warpScale = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const Z = new THREE.Vector3(0, 0, 1);

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

    this.ringCount = 18;
    this.ringTravel = 0;
    const ringGeometry = new THREE.TorusGeometry(1, 0.022, 6, 72);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: 0x8cecff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    this.rings = new THREE.InstancedMesh(ringGeometry, ringMaterial, this.ringCount);
    this.rings.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 5;
    this.rings.visible = false;
    scene.add(this.rings);

    this.foldTunnel = new THREE.Mesh(
      new THREE.CylinderGeometry(1800, 11000, 52000, 72, 16, true),
      new THREE.MeshBasicMaterial({
        color: 0x276b8a,
        transparent: true,
        opacity: 0,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
      }),
    );
    this.foldTunnel.frustumCulled = false;
    this.foldTunnel.renderOrder = 4;
    this.foldTunnel.visible = false;
    scene.add(this.foldTunnel);
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
    this.ringTravel = 0;
  }

  // vel: true velocity vector (m/s); intensity = warp, boost = local pulse
  update(dt, vel, intensity, boost = 0) {
    const lineIntensity = Math.max(intensity, boost * 0.34);
    if (lineIntensity <= 0.01) {
      this.lines.visible = false;
      this.rings.visible = false;
      this.foldTunnel.visible = false;
      this.wasActive = false;
      return;
    }
    const speed = vel.length();
    if (speed < 1) { this.lines.visible = false; return; }
    if (!this.wasActive) this.reset(_dir.copy(vel).multiplyScalar(1 / speed));
    this.wasActive = true;
    this.lines.visible = true;
    this.lines.material.opacity = Math.min(1, lineIntensity) * 0.8;
    this.rings.visible = intensity > 0.01;
    this.foldTunnel.visible = intensity > 0.01;

    _dir.copy(vel).multiplyScalar(1 / speed);
    _e1.crossVectors(_dir, Math.abs(_dir.y) < 0.9 ? Y : X).normalize();
    _e2.crossVectors(_dir, _e1);
    const step = speed * dt * PARALLAX;
    const len = Math.min(300 + speed * 0.0022, 14000) * Math.max(0.22, lineIntensity);

    for (let i = 0; i < this.count; i++) {
      const s = this.streaks[i];
      s.addScaledVector(_dir, -step);
      if (s.dot(_dir) < -9000) this.scatter(s);
      this.positions[i * 6] = s.x; this.positions[i * 6 + 1] = s.y; this.positions[i * 6 + 2] = s.z;
      _p.copy(s).addScaledVector(_dir, -len);
      this.positions[i * 6 + 3] = _p.x; this.positions[i * 6 + 4] = _p.y; this.positions[i * 6 + 5] = _p.z;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;

    _warpQ.setFromUnitVectors(Z, _dir);
    if (intensity <= 0.01) return;
    this.ringTravel += dt * (2200 + intensity * 12500);
    const ringRange = 48000;
    for (let i = 0; i < this.ringCount; i++) {
      const base = (i / this.ringCount) * ringRange;
      const distance = 900 + ((base - this.ringTravel) % ringRange + ringRange) % ringRange;
      const radius = 260 + distance * (0.065 + intensity * 0.045);
      _p.copy(_dir).multiplyScalar(distance);
      _warpScale.setScalar(radius);
      _warpM.compose(_p, _warpQ, _warpScale);
      this.rings.setMatrixAt(i, _warpM);
    }
    this.rings.instanceMatrix.needsUpdate = true;
    this.rings.material.opacity = intensity * 0.16;

    this.foldTunnel.position.copy(_dir).multiplyScalar(24500);
    this.foldTunnel.quaternion.setFromUnitVectors(Y, _dir);
    this.foldTunnel.scale.setScalar(0.85 + intensity * 0.3);
    this.foldTunnel.material.opacity = intensity * 0.028;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.rings.geometry.dispose();
    this.rings.material.dispose();
    this.foldTunnel.geometry.dispose();
    this.foldTunnel.material.dispose();
    if (this.lines.parent) this.lines.parent.remove(this.lines);
    if (this.rings.parent) this.rings.parent.remove(this.rings);
    if (this.foldTunnel.parent) this.foldTunnel.parent.remove(this.foldTunnel);
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
        #include <common>
        #include <logdepthbuf_pars_vertex>
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          #include <logdepthbuf_vertex>
        }`,
      fragmentShader: /* glsl */`
        #include <common>
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

  update(up, sunDir, horizon, zenith, alpha, sunset = 0) {
    const u = this.mat.uniforms;
    u.uUp.value.copy(up);
    u.uSunDir.value.copy(sunDir);
    u.uHorizon.value.copy(horizon);
    u.uZenith.value.copy(zenith);
    u.uAlpha.value = alpha;
    u.uSunTint.value.setRGB(1.0, 0.92 - sunset * 0.6, 0.78 - sunset * 0.68);
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

export const SHIP_FOREGROUND_LAYER = 3;

export class Ship {
  constructor(scene, { anisotropy = 1 } = {}) {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0xc9ced8, metalness: 0.6, roughness: 0.38 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xb8452a, metalness: 0.4, roughness: 0.5 });
    const canopy = new THREE.MeshStandardMaterial({ color: 0x16242e, metalness: 0.3, roughness: 0.12 });
    const engineGlowMat = new THREE.MeshStandardMaterial({
      color: 0x143040, emissive: new THREE.Color(0x66ddff), emissiveIntensity: 2.2,
    });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) => {
      const m = new THREE.Mesh(geo, mat);
      m.layers.enable(SHIP_FOREGROUND_LAYER);
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

    g.layers.enable(SHIP_FOREGROUND_LAYER);
    g.traverse((m) => { m.castShadow = true; m.layers.enable(SHIP_FOREGROUND_LAYER); });
    this.group = g;
    scene.add(g);

    this.smQuat = new THREE.Quaternion();
    this.roll = 0;
    this.engineMat = engineGlowMat;
    this.loadedEmissives = [];
    this.loadedGear = [];
    this.loadedRamp = [];
    this.anisotropy = anisotropy;
    this.loadHeroShip();

    // when you land, the ship sets down on a pad beside you and waits
    this.parkedPosUniv = null;
    this.parkedQuat = new THREE.Quaternion();
    this.parkAmt = 0;
  }

  loadHeroShip() {
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    loader.load('/assets/asterion-s9-rebuilt-20260716.glb', (gltf) => {
      const hero = gltf.scene;
      this.loadedEmissives = [];
      this.loadedGear = [];
      this.loadedRamp = [];
      hero.traverse((object) => {
        object.layers.enable(SHIP_FOREGROUND_LAYER);
        if (/^(LANDING_GEAR_ROOT|Gear_)/.test(object.name)) this.loadedGear.push(object);
        if (/^(BOARDING_RAMP_ROOT|Ramp_)/.test(object.name)) this.loadedRamp.push(object);
        if (!object.isMesh) return;
        object.castShadow = true;
        object.receiveShadow = true;
        object.material = Array.isArray(object.material)
          ? object.material.map((material) => material.clone())
          : object.material.clone();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) {
          for (const slot of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) {
            const texture = material[slot];
            if (!texture) continue;
            texture.anisotropy = Math.max(texture.anisotropy || 1, this.anisotropy);
            texture.needsUpdate = true;
          }
          if (!material.isMeshStandardMaterial) continue;
          material.color.multiplyScalar(0.72);
          material.roughness = Math.max(material.roughness, 0.3);
          if (material.emissiveMap || /Engine|Emission/i.test(material.name)) {
            material.toneMapped = true;
            this.loadedEmissives.push(material);
          }
        }
      });
      hero.rotation.y = Math.PI;
      hero.scale.setScalar(0.48);
      this.group.clear();
      this.group.add(hero);
      for (const part of this.loadedGear) part.visible = false;
      for (const part of this.loadedRamp) part.visible = false;
      this.heroLoaded = true;
    }, undefined, (error) => {
      console.error('ASTERION S-9 failed to load; keeping procedural fallback', error);
    });
  }

  setParked(posUniv, quat) {
    this.parkedPosUniv = posUniv.clone();
    this.parkedQuat.copy(quat);
  }

  update(dt, nav, state, speed, warp, boost = 0) {
    const wantsPark = (state === 'walk' || state === 'landing' || state === 'boarding') && !!this.parkedPosUniv;
    this.parkAmt += ((wantsPark ? 1 : 0) - this.parkAmt) * (1 - Math.exp(-dt * 2.0));

    // formation pose: nose lags the camera a touch, which reads as mass
    this.smQuat.slerp(nav.quat, 1 - Math.exp(-dt * 6));
    _sq.copy(this.smQuat).invert().multiply(nav.quat);
    const rollTarget = Math.max(-0.55, Math.min(0.55, -_sq.y * 14));
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-dt * 5));
    _sf.set(0, 0, -1).applyQuaternion(this.smQuat);   // forward
    _su.set(0, 1, 0).applyQuaternion(this.smQuat);
    this.thrustPose = this.thrustPose ?? 0;
    this.thrustPose += (boost - this.thrustPose) * (1 - Math.exp(-dt * 4.2));
    // During acceleration the ship visibly lunges away from the camera. This
    // gives thrust a foreground reference instead of making only the universe
    // appear to slide toward a stationary model.
    _sv.copy(_sf).multiplyScalar(19 + this.thrustPose * 3.2)
      .addScaledVector(_su, -4.6 + this.thrustPose * 0.35);   // formation offset
    const formQuat = _sq2.copy(this.smQuat)
      .multiply(_sq.setFromAxisAngle(_sr.set(0, 0, 1), this.roll));

    if (this.parkedPosUniv && this.parkAmt > 0.002) {
      // glide between flying formation and the landing pad
      _sp.copy(this.parkedPosUniv).sub(nav.pos);      // camera-relative pad
      const e = this.parkAmt * this.parkAmt * (3 - 2 * this.parkAmt);
      this.group.position.lerpVectors(_sv, _sp, e);
      this.group.quaternion.copy(formQuat).slerp(this.parkedQuat, e);
    } else {
      this.group.position.copy(_sv);
      this.group.quaternion.copy(formQuat);
    }

    const burnK = 1 - this.parkAmt;
    this.engineMat.emissiveIntensity = 0.15 + (1.2 + Math.min(1.8, speed / 1.5e6 + warp * 1.4 + boost * 0.7) * 2.6) * burnK;
    for (const material of this.loadedEmissives) {
      material.emissiveIntensity = 1.15 + Math.min(3.2, speed / 7e5 + warp * 2.2 + boost * 1.2) * burnK;
    }
    const gearVisible = this.parkAmt > 0.42;
    const rampVisible = state === 'walk' && this.parkAmt > 0.88;
    for (const part of this.loadedGear) part.visible = gearVisible;
    for (const part of this.loadedRamp) part.visible = rampVisible;
    const stretch = 1 + Math.min(9, speed / 4e5 + warp * 7 + boost * 2.8) * burnK;
    this.glowA.scale.set(1, stretch, 1);
    this.glowB.scale.set(1, stretch, 1);
  }
}
const _sq2 = new THREE.Quaternion();
const _sp = new THREE.Vector3();

// ============================================================================
// Twin energy cannons. Bolts live in universe coordinates and are packed into
// one instanced draw each frame, so holding LMB does not allocate meshes or
// create a draw call per projectile.
// ============================================================================

const _weaponForward = new THREE.Vector3();
const _weaponRight = new THREE.Vector3();
const _weaponUp = new THREE.Vector3();
const _weaponPos = new THREE.Vector3();
const _weaponDir = new THREE.Vector3();
const _weaponQuat = new THREE.Quaternion();
const _weaponScale = new THREE.Vector3();
const _weaponMatrix = new THREE.Matrix4();
const WEAPON_AXIS = new THREE.Vector3(0, 0, 1);

export class ShipWeapons {
  constructor(scene, maxBolts = 40) {
    this.maxBolts = maxBolts;
    this.cursor = 0;
    this.shotsFired = 0;
    this.bolts = Array.from({ length: maxBolts }, () => ({
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      life: 0,
      maxLife: 1,
      length: 1,
    }));

    // A short, needle-like tracer reads as a projectile. The previous tapered
    // cylinder could stretch to almost 100 m and looked like an energy cone.
    const glowGeometry = new THREE.BoxGeometry(0.12, 0.12, 3.4);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0x32dfff,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.glowMesh = new THREE.InstancedMesh(glowGeometry, glowMaterial, maxBolts);
    this.glowMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.glowMesh.frustumCulled = false;
    this.glowMesh.renderOrder = 4;
    this.glowMesh.count = 0;
    scene.add(this.glowMesh);

    const coreGeometry = new THREE.BoxGeometry(0.035, 0.035, 2.8);
    const coreMaterial = new THREE.MeshBasicMaterial({
      color: 0xf4feff,
      transparent: true,
      opacity: 0.98,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.coreMesh = new THREE.InstancedMesh(coreGeometry, coreMaterial, maxBolts);
    this.coreMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.coreMesh.frustumCulled = false;
    this.coreMesh.renderOrder = 5;
    this.coreMesh.count = 0;
    scene.add(this.coreMesh);
  }

  fire(nav, speedScale, ship) {
    // Bind the hardpoints to the rendered ship, including its smoothing, bank
    // and acceleration lunge. Universe position = camera + relative ship pose.
    const shipQuat = ship?.group?.quaternion || nav.quat;
    _weaponForward.set(0, 0, -1).applyQuaternion(shipQuat).normalize();
    _weaponRight.set(1, 0, 0).applyQuaternion(shipQuat).normalize();
    _weaponUp.set(0, 1, 0).applyQuaternion(shipQuat).normalize();
    _weaponPos.copy(nav.pos);
    if (ship?.group) _weaponPos.add(ship.group.position);
    else _weaponPos.addScaledVector(_weaponForward, 19).addScaledVector(_weaponUp, -4.6);
    // The rebuilt Asterion's paired emitters sit just inboard of the wingtips.
    _weaponPos.addScaledVector(_weaponForward, 1.35).addScaledVector(_weaponUp, -0.15);
    const muzzleSpeed = Math.max(780, speedScale * 10.5);

    for (const side of [-1, 1]) {
      const bolt = this.bolts[this.cursor];
      this.cursor = (this.cursor + 1) % this.maxBolts;
      bolt.pos.copy(_weaponPos).addScaledVector(_weaponRight, side * 2.5);
      bolt.vel.copy(nav.vel).addScaledVector(_weaponForward, muzzleSpeed);
      bolt.life = bolt.maxLife = 1.65;
      bolt.length = THREE.MathUtils.clamp(muzzleSpeed * 0.0018, 1.0, 2.4);
    }
    this.shotsFired++;
  }

  update(dt, nav, planet = null) {
    let active = 0;
    for (const bolt of this.bolts) {
      if (bolt.life <= 0) continue;
      bolt.life -= dt;
      if (bolt.life <= 0) continue;
      bolt.pos.addScaledVector(bolt.vel, dt);
      if (planet) {
        _weaponPos.copy(bolt.pos).sub(planet.posUniv);
        // Cheap ocean/core interception only. Sampling procedural terrain for
        // every projectile at 60 fps would cost more than the weapon itself.
        if (_weaponPos.length() <= planet.R + Math.max(0, planet.seaLevel || 0)) {
          bolt.life = 0;
          continue;
        }
      }
      _weaponPos.copy(bolt.pos).sub(nav.pos);
      _weaponDir.copy(bolt.vel).normalize();
      _weaponQuat.setFromUnitVectors(WEAPON_AXIS, _weaponDir);
      const fade = THREE.MathUtils.clamp(bolt.life / 0.16, 0, 1);
      _weaponScale.set(fade, fade, bolt.length);
      _weaponMatrix.compose(_weaponPos, _weaponQuat, _weaponScale);
      this.glowMesh.setMatrixAt(active, _weaponMatrix);
      this.coreMesh.setMatrixAt(active++, _weaponMatrix);
    }
    this.glowMesh.count = active;
    this.coreMesh.count = active;
    if (active) {
      this.glowMesh.instanceMatrix.needsUpdate = true;
      this.coreMesh.instanceMatrix.needsUpdate = true;
    }
    return active;
  }
}
