// Warp-flight visuals. The old world-space LineSegments and a separate DOM
// pulse overlay never formed one image: lines crossed depth layers while the
// screen tint sat above the ship. This shader is inserted before the foreground
// ship pass, so warp and local pulse share one coherent camera-space tunnel.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);

export const WarpDriveShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uWarp: { value: 0 },
    uPulse: { value: 0 },
    uArrival: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uWarp;
    uniform float uPulse;
    uniform float uArrival;
    uniform float uAspect;
    varying vec2 vUv;

    const float TAU = 6.28318530718;

    float hash11(float p) {
      p = fract(p * .1031);
      p *= p + 33.33;
      p *= p + p;
      return fract(p);
    }

    float hash21(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
    }

    float noise21(vec2 p) {
      vec2 i = floor(p);
      vec2 f = fract(p);
      f = f * f * (3.0 - 2.0 * f);
      return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
        mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0)), f.x), f.y);
    }

    float flowNoise(vec2 p) {
      return noise21(p) * .57 + noise21(p * 2.07 + 7.3) * .29
        + noise21(p * 4.13 - 3.7) * .14;
    }

    vec3 spectrum(float h) {
      vec3 rainbow = .56 + .44 * cos(TAU * (h + vec3(0.00, .69, .37)));
      vec3 ion = mix(vec3(.18, .80, 1.35), vec3(1.25, .26, 1.10), step(.56, h));
      return mix(ion, rainbow * 1.25, .68);
    }

    vec3 rayLayer(vec2 p, float bins, float radialScale, float speed, float seed) {
      float radius = length(p);
      float angle = atan(p.y, p.x);
      float bend = sin(radius * mix(5.0, 9.0, seed) - uTime * .22 + seed * 17.0)
        * mix(.0012, .0042, smoothstep(.08, .8, radius));
      float wedge = (angle / TAU + .5 + bend) * bins;
      float id = floor(wedge);
      float rnd = hash11(id + seed * 71.7);
      float fine = hash11(id * 5.31 + seed * 19.1);
      float width = mix(.012, .044, rnd * rnd) * mix(.68, 1.1, smoothstep(.04, .76, radius));
      float across = abs(fract(wedge) - .5);
      float core = exp(-pow(across / max(width, .001), 2.0) * 2.4);
      float glow = exp(-pow(across / max(width * 3.2, .001), 2.0) * 1.35);
      float phase = fract(radius * radialScale - uTime * speed * mix(.72, 1.4, rnd) + fine);
      float segment = smoothstep(.025, .13, phase) * (1.0 - smoothstep(.58, .96, phase));
      float taper = mix(.42, 1.0, smoothstep(.04, .42, phase));
      float gate = step(.43, fine) * smoothstep(.018, .105, radius);
      float flare = mix(.32, 1.34, smoothstep(.055, .92, radius));
      vec3 cool = mix(vec3(.24, .72, 1.12), vec3(.74, .94, 1.08), rnd);
      float accentAmount = smoothstep(.58, .92, hash11(id * 2.73 + seed * 31.0));
      vec3 tint = mix(cool, spectrum(fract(rnd * .74 + seed * .29)), accentAmount * .72);
      vec3 hotCore = mix(tint, vec3(1.12, 1.16, 1.18), .46);
      return (tint * glow * .19 + hotCore * core * taper) * segment * gate * flare;
    }

    void main() {
      float strength = clamp(max(uWarp, uPulse), 0.0, 1.0);
      vec2 p = vUv - .5;
      p.x *= uAspect;
      float radius = length(p);
      vec2 direction = p / max(radius, .0001);
      float stretch = strength * (.0015 + uWarp * .0065 + uPulse * .0035)
        * smoothstep(.035, .82, radius);
      vec2 shift = vec2(direction.x / uAspect, direction.y) * stretch;
      vec2 uvR = clamp(vUv - shift * .72, vec2(.001), vec2(.999));
      vec2 uvG = clamp(vUv - shift * .24, vec2(.001), vec2(.999));
      vec2 uvB = clamp(vUv + shift * .2, vec2(.001), vec2(.999));
      vec3 original = texture2D(tDiffuse, vUv).rgb;
      vec3 dispersed = vec3(
        texture2D(tDiffuse, uvR).r,
        texture2D(tDiffuse, uvG).g,
        texture2D(tDiffuse, uvB).b
      );
      vec3 scene = mix(original, dispersed, strength * (.14 + uWarp * .12));

      float rayStrength = strength * mix(.62, 1.0, strength) * smoothstep(.025, .14, radius);
      vec3 rays = rayLayer(p, 61.0, 1.38, .86 + uPulse * 1.18, .13);
      rays += rayLayer(p * 1.07, 97.0, 2.17, 1.33 + uPulse * 1.42, .47) * .68;
      rays += rayLayer(p * .94, 139.0, 3.28, 1.82 + uPulse * 1.68, .81) * .34;
      float coreFade = smoothstep(.012, .082, radius);
      float edgeFade = 1.0 - smoothstep(.78, 1.02, radius);
      rays *= rayStrength * coreFade * edgeFade * (1.0 + uWarp * .22);

      float tunnel = smoothstep(.08, .92, radius) * (1.0 - smoothstep(.88, 1.14, radius));
      float turbulence = flowNoise(p * 3.7 + direction * (uTime * .075));
      vec3 haze = mix(vec3(.012, .036, .075), vec3(.025, .115, .21), turbulence)
        * (.12 + tunnel * .88) * strength * (uWarp * .64 + uPulse * .22);
      vec3 arrival = vec3(.06, .19, .42) * exp(-radius * radius * 14.0) * uArrival * .52;
      float centerFlash = exp(-radius * radius * 110.0) * uArrival;
      arrival += vec3(.68, .84, 1.04) * centerFlash * .68;

      gl_FragColor = vec4(scene * (1.0 - strength * .028) + haze + rays + arrival, 1.0);
    }
  `,
};

function hermite(t, p0, p1, m0, m1, span) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (2 * t3 - 3 * t2 + 1) * p0
    + (t3 - 2 * t2 + t) * m0 * span
    + (-2 * t3 + 3 * t2) * p1
    + (t3 - t2) * m1 * span;
}

// Staged motion keeps the opening charge, covers most of the route at speed,
// then brakes hard into a brief final settle instead of spending the last
// quarter of the jump in an indistinct smootherstep slowdown.
export function warpTravelProgress(t) {
  const k = THREE.MathUtils.clamp(t, 0, 1);
  const stops = [
    [0.00, 0.000, 0.00],
    [0.16, 0.040, 0.65],
    [0.72, 0.820, 1.80],
    [0.88, 0.985, 0.35],
    [1.00, 1.000, 0.00],
  ];
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1], b = stops[i];
    if (k <= b[0]) return hermite((k - a[0]) / (b[0] - a[0]), a[1], b[1], a[2], b[2], b[0] - a[0]);
  }
  return 1;
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
    g.layers.set(SHIP_FOREGROUND_LAYER);
    this.group = g;
    this.foregroundOnly = true;
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
    // Hero start cinematic: a camera-relative offset that fades to zero as the
    // pull-back runs, so the ship slides into formation from off-screen.
    this.introOffset = new THREE.Vector3();
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
        object.layers.set(this.foregroundOnly ? SHIP_FOREGROUND_LAYER : 0);
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

  setForegroundOnly(enabled) {
    if (this.foregroundOnly === enabled) return;
    this.foregroundOnly = enabled;
    this.group.traverse((object) => object.layers.set(enabled ? SHIP_FOREGROUND_LAYER : 0));
  }

  update(dt, nav, state, speed, warp, boost = 0, flightInput = null) {
    const wantsPark = (state === 'walk' || state === 'landing' || state === 'boarding') && !!this.parkedPosUniv;
    this.parkAmt += ((wantsPark ? 1 : 0) - this.parkAmt) * (1 - Math.exp(-dt * 2.0));
    const foregroundOnly = ['space', 'flyto', 'warp', 'takeoff'].includes(state)
      || (state === 'landing' && this.parkAmt < 0.58);
    this.setForegroundOnly(foregroundOnly);

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
    // Start cinematic: slide in from off-screen until the offset decays to 0.
    if (this.introOffset) {
      _sv.addScaledVector(_sr, this.introOffset.x)
        .addScaledVector(_su, this.introOffset.y)
        .addScaledVector(_sf, this.introOffset.z);
    }
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
