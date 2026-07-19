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
  }

  // vel: true velocity vector (m/s); intensity = warp, boost = local pulse
  update(dt, vel, intensity, boost = 0) {
    const lineIntensity = Math.max(intensity, boost * 0.34);
    if (lineIntensity <= 0.01) {
      this.lines.visible = false;
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

    if (intensity <= 0.01) return;
    this.foldTunnel.position.copy(_dir).multiplyScalar(24500);
    this.foldTunnel.quaternion.setFromUnitVectors(Y, _dir);
    this.foldTunnel.scale.setScalar(0.9 + intensity * 0.22);
    this.foldTunnel.material.opacity = intensity * 0.018;
  }

  dispose() {
    this.lines.geometry.dispose();
    this.lines.material.dispose();
    this.foldTunnel.geometry.dispose();
    this.foldTunnel.material.dispose();
    if (this.lines.parent) this.lines.parent.remove(this.lines);
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
// The ship: the Asterion S-9 GLB flies just ahead of the camera whenever
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
    g.layers.enable(SHIP_FOREGROUND_LAYER);
    this.group = g;
    scene.add(g);

    this.smQuat = new THREE.Quaternion();
    this.roll = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
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
      console.error('ASTERION S-9 GLB failed to load; ship will be invisible until it loads', error);
    });
  }

  setParked(posUniv, quat) {
    this.parkedPosUniv = posUniv.clone();
    this.parkedQuat.copy(quat);
  }

  update(dt, nav, state, speed, warp, boost = 0, flightInput = null) {
    const wantsPark = (state === 'walk' || state === 'landing' || state === 'boarding') && !!this.parkedPosUniv;
    this.parkAmt += ((wantsPark ? 1 : 0) - this.parkAmt) * (1 - Math.exp(-dt * 2.0));

    // The hull's mass response is driven by raw pilot intent, never by speed
    // or by the final camera quaternion. Therefore a zero-speed mouse turn
    // still has weight, while passive planet-frame rotation remains stable.
    const yawInput = flightInput?.yaw || 0;
    const pitchInput = flightInput?.pitch || 0;
    const throttleInput = flightInput?.throttle || 0;
    const strafeInput = flightInput?.strafe || 0;
    const yawTarget = yawInput * 0.07;
    const pitchTarget = pitchInput * 0.052 - throttleInput * 0.018;
    this.lookYaw ??= 0;
    this.lookPitch ??= 0;
    const lookActive = Math.abs(yawInput) + Math.abs(pitchInput) > 0.03;
    const lookResponse = lookActive ? 13 : 6.2;
    this.lookYaw += (yawTarget - this.lookYaw) * (1 - Math.exp(-dt * lookResponse));
    this.lookPitch += (pitchTarget - this.lookPitch) * (1 - Math.exp(-dt * lookResponse));

    const rollTarget = THREE.MathUtils.clamp(
      yawInput * 0.17 - strafeInput * 0.3, -0.55, 0.55);
    const rollResponse = Math.abs(rollTarget) > Math.abs(this.roll) ? 9 : 7;
    this.roll += (rollTarget - this.roll) * (1 - Math.exp(-dt * rollResponse));

    // smQuat is now the passive frame anchor. All visible lag is a bounded
    // local offset below, so it cannot feed back into the navigation state.
    this.smQuat.copy(nav.quat);
    _sf.set(0, 0, -1).applyQuaternion(nav.quat);   // forward
    _su.set(0, 1, 0).applyQuaternion(nav.quat);
    this.thrustPose = this.thrustPose ?? 0;
    this.thrustPose += (boost - this.thrustPose) * (1 - Math.exp(-dt * 4.2));
    // During acceleration the ship visibly lunges away from the camera. This
    // gives thrust a foreground reference instead of making only the universe
    // appear to slide toward a stationary model.
    _sv.copy(_sf).multiplyScalar(19 + this.thrustPose * 3.2)
      .addScaledVector(_su, -4.6 + this.thrustPose * 0.35);   // formation offset
    _sr.set(1, 0, 0).applyQuaternion(nav.quat);
    _sv.addScaledVector(_sr, -this.lookYaw * 8.5)
      .addScaledVector(_su, this.lookPitch * 5.5);
    const formQuat = _sq2.copy(nav.quat)
      .multiply(_sq.setFromAxisAngle(Y, this.lookYaw))
      .multiply(_sq.setFromAxisAngle(X, this.lookPitch))
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
    for (const material of this.loadedEmissives) {
      material.emissiveIntensity = 1.15 + Math.min(3.2, speed / 7e5 + warp * 2.2 + boost * 1.2) * burnK;
    }
    const gearVisible = this.parkAmt > 0.42;
    const rampVisible = state === 'walk' && this.parkAmt > 0.88;
    for (const part of this.loadedGear) part.visible = gearVisible;
    for (const part of this.loadedRamp) part.visible = rampVisible;
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
