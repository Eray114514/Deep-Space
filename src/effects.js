// Warp-flight visuals. The old world-space LineSegments and a separate DOM
// pulse overlay never formed one image: lines crossed depth layers while the
// screen tint sat above the ship. This shader is inserted before the foreground
// ship pass, so warp and local pulse share one coherent camera-space tunnel.

import * as THREE from 'three';
import { MeshBasicNodeMaterial } from 'three/webgpu';
import {
  Fn, If, abs, atan, cameraProjectionMatrixInverse, cameraWorldMatrix, clamp,
  color, cos, dot, exp, float, floor, fract, length, max, mix, normalLocal,
  normalize, positionLocal, pow, screenUV, sin,
  smoothstep, step, uniform, vec2, vec3, vec4,
} from 'three/tsl';
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import { SKY_BACKDROP_LAYER } from './render-layers.js';

const rendererParams = typeof location !== 'undefined'
  ? new URLSearchParams(location.search) : new URLSearchParams();
const rendererSettings = resolveGraphicsSettings({ params: rendererParams });
const USE_NODE_MATERIALS = resolveRendererPolicy(
  rendererParamsForSettings(rendererSettings, rendererParams)).backend === 'webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const SKY_SUNSET_TINT = new THREE.Color(1.35, 0.22, 0.035);

// Eager preload: start fetching the hero ship GLB the moment this module is
// imported, so the network/decode overlap with main.js's heavy universe,
// renderer, and scene setup. The ship itself stays off-screen (via
// ship.introOffset) during the hero interface — this only front-loads the
// asset fetch so the pull-back cinematic can begin the instant the user
// clicks start, instead of stalling on the GLB the constructor used to kick
// off late. Skipped under Node (test harness) where the URL has no origin.
const HERO_SHIP_URL = '/assets/asterion-s9-rebuilt-20260716.glb';
const heroShipLoader = new GLTFLoader();
heroShipLoader.setMeshoptDecoder(MeshoptDecoder);
const heroShipPromise = typeof location !== 'undefined'
  ? heroShipLoader.loadAsync(HERO_SHIP_URL).catch((error) => {
    console.error('ASTERION S-9 GLB failed to preload', error);
    return null;
  })
  : Promise.resolve(null);

// One authored size contract drives landing clearance and walk collision. The
// source GLB bounds are [-14, -4.40003, -12.70865] to
// [14, 3.17674, 11.87912]; the hero is rotated 180 degrees around Y and shown
// at this scale. Keep collision deliberately simpler than the render mesh, but
// never let it disagree about the ship's overall footprint or belly height.
export const SHIP_LANDING_PROFILE = Object.freeze({
  scale: 0.48,
  bounds: Object.freeze({
    minY: -4.40003 * 0.48,
    maxY: 3.17674 * 0.48,
    halfX: 12.70865 * 0.48,
    halfZ: 14 * 0.48,
  }),
  groundClearance: 0.22,
  footprint: Object.freeze([
    Object.freeze([0, 0]),
    Object.freeze([-5.7, -5.9]), Object.freeze([0, -6.5]), Object.freeze([5.7, -5.9]),
    Object.freeze([-5.9, 0]), Object.freeze([5.9, 0]),
    Object.freeze([-5.7, 5.9]), Object.freeze([0, 6.5]), Object.freeze([5.7, 5.9]),
  ]),
  colliders: Object.freeze([
    // Raised central fuselage plus a lower wing/tail volume. Their upper faces
    // are real walking surfaces, while the volumes stop the player ghosting
    // through the parked ship.
    Object.freeze({ center: Object.freeze([0, -0.27, 0]), half: Object.freeze([2.45, 1.78, 5.85]) }),
    Object.freeze({ center: Object.freeze([0, -0.62, 0.35]), half: Object.freeze([5.95, 0.76, 3.35]) }),
    Object.freeze({ center: Object.freeze([0, -0.68, 5.05]), half: Object.freeze([4.6, 0.66, 1.45]) }),
  ]),
});

// Fast initial descent with a long, readable touchdown settle.
export function landingDescentProgress(t) {
  const k = THREE.MathUtils.clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 2.35);
}

// WebGPURenderer post-processing node. The input is a pass texture node and
// the returned uniforms deliberately mirror the old pass controls.
export function createWarpDriveNode(inputNode) {
  const controls = {
    time: uniform(0), warp: uniform(0), pulse: uniform(0),
    arrival: uniform(0), aspect: uniform(1),
  };
  const tau = 6.28318530718;
  const hash11 = Fn(([source]) => {
    const p0 = fract(source.mul(.1031));
    const p1 = p0.mul(p0.add(33.33));
    return fract(p1.mul(p1.add(p1)));
  });
  const spectrum = Fn(([h]) => {
    const rainbow = vec3(.56).add(cos(h.add(vec3(0, .69, .37)).mul(tau)).mul(.44));
    const ion = mix(vec3(.18, .80, 1.35), vec3(1.25, .26, 1.10), step(.56, h));
    return mix(ion, rainbow.mul(1.25), .68);
  });
  const rayLayer = Fn(([p, bins, radialScale, speed, seed]) => {
    const radius = length(p);
    const angle = atan(p.y, p.x);
    const wedge = angle.div(tau).add(.5).mul(bins);
    const id = floor(wedge);
    const random = hash11(id.add(seed.mul(71.7)));
    const fine = hash11(id.mul(5.31).add(seed.mul(19.1)));
    const across = abs(fract(wedge).sub(.5));
    const acrossDistance = across.mul(tau).div(bins).mul(radius);
    const width = mix(.00062, .0019, random.mul(random)).mul(mix(.82, 1.18, fine));
    const core = exp(pow(acrossDistance.div(max(width, .00035)), 2).mul(-2.65));
    const glow = exp(pow(acrossDistance.div(max(width.mul(4.2), .001)), 2).mul(-1.25));
    const phase = fract(radius.mul(radialScale).sub(controls.time.mul(speed)
      .mul(mix(.72, 1.4, random))).add(fine));
    const segment = smoothstep(.018, .085, phase)
      .mul(float(1).sub(smoothstep(.68, .965, phase)));
    const head = exp(pow(abs(phase.sub(.16)).div(.085), 2).mul(-2.2));
    const taper = mix(.46, 1, smoothstep(.035, .34, phase)).add(head.mul(.72));
    const gate = step(.52, fine).mul(smoothstep(.022, .115, radius));
    const flare = mix(.38, 1.28, smoothstep(.06, .94, radius));
    const cool = mix(vec3(.24, .72, 1.12), vec3(.74, .94, 1.08), random);
    const accent = smoothstep(.58, .92, hash11(id.mul(2.73).add(seed.mul(31))));
    const tint = mix(cool, spectrum(fract(random.mul(.74).add(seed.mul(.29)))),
      accent.mul(.62).add(.18));
    const hotCore = mix(tint, vec3(1.12, 1.16, 1.18), .30);
    return tint.mul(glow).mul(.15).add(hotCore.mul(core).mul(taper).mul(.78))
      .mul(segment).mul(gate).mul(flare);
  });
  const outputNode = Fn(() => {
    const strength = clamp(controls.warp.max(controls.pulse), 0, 1);
    const base = inputNode.sample(screenUV);
    const result = vec4(base.rgb, 1).toVar();
    const activity = max(strength, controls.arrival);
    If(activity.greaterThan(.001), () => {
      const centered = screenUV.sub(0.5);
      const p = vec2(centered.x.mul(controls.aspect), centered.y);
      const radius = length(p);
      const direction = p.div(max(radius, .0001));
      const stretch = strength.mul(float(.0015).add(controls.warp.mul(.0065))
        .add(controls.pulse.mul(.0035))).mul(smoothstep(.035, .82, radius));
      const shift = vec2(direction.x.div(controls.aspect), direction.y).mul(stretch);
      const red = inputNode.sample(clamp(screenUV.sub(shift.mul(.72)), .001, .999));
      const green = inputNode.sample(clamp(screenUV.sub(shift.mul(.24)), .001, .999));
      const blue = inputNode.sample(clamp(screenUV.add(shift.mul(.20)), .001, .999));
      const dispersed = vec3(red.r, green.g, blue.b);
      const scene = mix(base.rgb, dispersed,
        strength.mul(float(.14).add(controls.warp.mul(.12))));
      const rayStrength = strength.mul(mix(.54, .88, strength))
        .mul(smoothstep(.025, .14, radius));
      const layeredRays = rayLayer(p, float(31), float(1.05),
        float(2.15).add(controls.pulse.mul(2.35)), float(.13))
        .add(rayLayer(p.mul(1.03), float(53), float(1.82),
          float(2.85).add(controls.pulse.mul(3.1)), float(.47)).mul(.68))
        .add(rayLayer(p.mul(.97), float(89), float(3.12),
          float(3.65).add(controls.pulse.mul(3.9)), float(.81)).mul(.38))
        .add(rayLayer(p.mul(1.08), float(137), float(5.25),
          float(4.8).add(controls.pulse.mul(4.7)), float(.29)).mul(.18));
      const rays = layeredRays.mul(rayStrength).mul(smoothstep(.012, .082, radius))
        .mul(float(1).sub(smoothstep(.98, 1.2, radius)))
        .mul(float(1).add(controls.warp.mul(.18)));
      const tunnel = smoothstep(.08, .92, radius)
        .mul(float(1).sub(smoothstep(.88, 1.14, radius)));
      const turbulence = sin(dot(p, vec2(18.7, 31.9)).add(controls.time.mul(.17)))
        .mul(.5).add(.5);
      const haze = mix(vec3(.012, .036, .075), vec3(.025, .115, .21), turbulence)
        .mul(float(.12).add(tunnel.mul(.88))).mul(strength)
        .mul(controls.warp.mul(.64).add(controls.pulse.mul(.22)));
      const arrival = vec3(.06, .19, .42).mul(exp(radius.mul(radius).mul(-14)))
        .mul(controls.arrival).mul(.52)
        .add(vec3(.68, .84, 1.04).mul(exp(radius.mul(radius).mul(-110)))
          .mul(controls.arrival).mul(.68));
      result.assign(vec4(scene.mul(float(1).sub(strength.mul(.028)))
        .add(haze).add(rays).add(arrival), 1));
    });
    return result;
  })();
  return { outputNode, uniforms: controls };
}

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
    [0.08, 0.045, 1.20],
    [0.62, 0.790, 1.55],
    [0.86, 0.982, 0.38],
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
    if (!USE_NODE_MATERIALS) {
      this.mat = new THREE.ShaderMaterial({
        uniforms: {
          uUp: { value: new THREE.Vector3(0, 1, 0) },
          uSunDir: { value: new THREE.Vector3(0, 1, 0) },
          uHorizon: { value: new THREE.Color(0x88bbff) },
          uZenith: { value: new THREE.Color(0x224488) },
          uSunTint: { value: new THREE.Color(1.0, 0.92, 0.78) },
          uSecondarySunDir: { value: new THREE.Vector3(0, -1, 0) },
          uSecondarySunTint: { value: new THREE.Color(1.0, 0.92, 0.78) },
          uSecondarySunEnergy: { value: 0 },
          uAlpha: { value: 0 },
          uHorizonOnly: { value: 0 },
          uSunset: { value: 0 },
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
          uniform vec3 uSecondarySunDir, uSecondarySunTint;
          uniform float uAlpha, uHorizonOnly, uSecondarySunEnergy, uSunset;
          varying vec3 vDir;
          void main() {
            #include <logdepthbuf_fragment>
            vec3 dir = normalize(vDir);
            float u = dot(dir, uUp);
            float t = pow(clamp(1.0 - max(u, 0.0), 0.0, 1.0), 3.2);
            vec3 col = mix(uZenith, uHorizon * 0.92, t);
            float sd = max(dot(dir, uSunDir), 0.0);
            float duskBand = uSunset * pow(clamp(1.0 - abs(u), 0.0, 1.0), 1.7);
            float forwardDusk = pow(sd, 2.2);
            float antiDusk = pow(max(dot(dir, -uSunDir), 0.0), 1.5);
            vec3 dusk = mix(vec3(0.105, 0.018, 0.075),
              vec3(1.05, 0.13, 0.012), forwardDusk);
            dusk += vec3(0.055, 0.014, 0.105) * antiDusk;
            col = mix(col, dusk, duskBand * 0.68);
            col += uSunTint * (pow(sd, 700.0) * 1.3 + pow(sd, 16.0) * 0.16);
            float sd2 = max(dot(dir, uSecondarySunDir), 0.0);
            col += uSecondarySunTint * (pow(sd2, 700.0) * 1.3
              + pow(sd2, 16.0) * 0.16) * uSecondarySunEnergy;
            float directional = mix(1.0, pow(1.0 - abs(u), 3.0), uHorizonOnly);
            float a = uAlpha * directional * (u < 0.0 ? max(0.0, 1.0 + u * 2.4) : 1.0);
            gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
          }`,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        depthTest: false,
        fog: false,
      });
      this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4e5, 48, 32), this.mat);
      this.mesh.renderOrder = -7;
      this.mesh.layers.set(SKY_BACKDROP_LAYER);
      this.mesh.frustumCulled = false;
      this.mesh.visible = false;
      scene.add(this.mesh);
      return;
    }
    const nodes = {
      uUp: uniform(new THREE.Vector3(0, 1, 0)),
      uSunDir: uniform(new THREE.Vector3(0, 1, 0)),
      uHorizon: uniform(new THREE.Color(0x88bbff)),
      uZenith: uniform(new THREE.Color(0x224488)),
      uSunTint: uniform(new THREE.Color(1.0, 0.92, 0.78)),
      uSecondarySunDir: uniform(new THREE.Vector3(0, -1, 0)),
      uSecondarySunTint: uniform(new THREE.Color(1.0, 0.92, 0.78)),
      uSecondarySunEnergy: uniform(0),
      uAlpha: uniform(0),
      uHorizonOnly: uniform(0),
      uSunset: uniform(0),
    };
    // Reconstruct the world-space sky ray per fragment. Normalizing the
    // interpolated position of a 48×32 sphere made every coarse triangle its
    // own patch of zenith colour and sun radiance, most obvious through broken
    // cloud cover. The dome is only a raster envelope; its tessellation must
    // never define the sky field.
    const clipRay = vec4(screenUV.mul(2).sub(1), 1, 1);
    const viewRayPoint = cameraProjectionMatrixInverse.mul(clipRay);
    const viewRay = viewRayPoint.xyz.div(viewRayPoint.w.max(0.000001));
    const dir = cameraWorldMatrix.mul(vec4(viewRay, 0)).xyz.normalize();
    const upDot = dot(dir, nodes.uUp);
    const horizonMix = pow(clamp(float(1).sub(upDot.max(0)), 0, 1), 3.2);
    const sunDot = dot(dir, nodes.uSunDir).max(0);
    const duskBand = nodes.uSunset.mul(pow(clamp(float(1).sub(abs(upDot)), 0, 1), 1.7));
    const forwardDusk = pow(sunDot, 2.2);
    const antiDusk = pow(dot(dir, nodes.uSunDir.negate()).max(0), 1.5);
    const dusk = mix(vec3(0.105, 0.018, 0.075), vec3(1.05, 0.13, 0.012), forwardDusk)
      .add(vec3(0.055, 0.014, 0.105).mul(antiDusk));
    const sky = mix(mix(nodes.uZenith, nodes.uHorizon.mul(0.92), horizonMix),
      dusk, duskBand.mul(0.68))
      .add(nodes.uSunTint.mul(pow(sunDot, 700).mul(1.3).add(pow(sunDot, 16).mul(0.16))));
    const secondaryDot = dot(dir, nodes.uSecondarySunDir).max(0);
    const multiStarSky = sky.add(nodes.uSecondarySunTint
      .mul(pow(secondaryDot, 700).mul(1.3).add(pow(secondaryDot, 16).mul(0.16)))
      .mul(nodes.uSecondarySunEnergy));
    const belowFade = mix(float(1), clamp(float(1).add(upDot.mul(2.4)), 0, 1), upDot.lessThan(0));
    this.mat = new MeshBasicNodeMaterial({
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: false,
      fog: false,
    });
    this.mat.colorNode = multiStarSky;
    const directionalAlpha = mix(float(1), pow(float(1).sub(abs(upDot)), 3), nodes.uHorizonOnly);
    this.mat.opacityNode = nodes.uAlpha.mul(directionalAlpha).mul(belowFade);
    this.mat.uniforms = Object.fromEntries(Object.entries(nodes).map(([key, node]) => [key, node]));
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(4e5, 48, 32), this.mat);
    this.mesh.renderOrder = -7;
    this.mesh.layers.set(SKY_BACKDROP_LAYER);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  update(up, sunDir, horizon, zenith, alpha, sunset = 0, horizonOnly = 0,
    stellarField = null) {
    const u = this.mat.uniforms;
    u.uUp.value.copy(up);
    u.uSunDir.value.copy(sunDir);
    u.uHorizon.value.copy(horizon);
    u.uZenith.value.copy(zenith);
    u.uAlpha.value = alpha;
    u.uHorizonOnly.value = horizonOnly;
    u.uSunset.value = sunset;
    const primary = stellarField?.sources?.[0];
    const secondary = stellarField?.sources?.[1];
    if (primary?.colorValue) {
      u.uSunTint.value.copy(primary.colorValue).lerp(SKY_SUNSET_TINT, sunset * 0.82);
    }
    else u.uSunTint.value.setRGB(1.0, 0.92 - sunset * 0.6, 0.78 - sunset * 0.68);
    if (secondary) {
      u.uSecondarySunDir.value.copy(secondary.worldDirection || sunDir);
      if (secondary.colorValue) u.uSecondarySunTint.value.copy(secondary.colorValue);
      u.uSecondarySunEnergy.value = secondary.irradianceFraction || 0;
    } else {
      u.uSecondarySunEnergy.value = 0;
    }
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
    this.heroLoaded = false;
    this.heroLoadSettled = false;
    this.heroLoadFailed = false;
    this.loadHeroShip();

    // when you land, the ship sets down on a pad beside you and waits
    this.parkedPosUniv = null;
    this.parkedQuat = new THREE.Quaternion();
    this.parkAmt = 0;
    this.landingPose = null;
    // Hero start cinematic: a camera-relative offset that fades to zero as the
    // pull-back runs, so the ship slides into formation from off-screen.
    this.introOffset = new THREE.Vector3();
  }

  loadHeroShip() {
    // Consumes the module-level heroShipPromise (started at import time) so
    // the GLB fetch overlaps with main.js init. If the preload failed, the
    // promise resolves to null and the ship stays invisible — the error was
    // already logged by the preload's catch handler.
    heroShipPromise.then((gltf) => {
      if (!gltf) {
        this.heroLoadFailed = true;
        this.heroLoadSettled = true;
        return;
      }
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
      hero.scale.setScalar(SHIP_LANDING_PROFILE.scale);
      this.group.clear();
      this.group.add(hero);
      for (const part of this.loadedGear) part.visible = false;
      for (const part of this.loadedRamp) part.visible = false;
      this.heroLoaded = true;
      this.heroLoadSettled = true;
    }).catch((error) => {
      // The module-level promise normally resolves null on failure. Keep this
      // final guard so startup readiness can never wait forever if later asset
      // processing itself throws.
      this.heroLoadFailed = true;
      this.heroLoadSettled = true;
      console.error('ASTERION S-9 GLB processing failed', error);
    });
  }

  setParked(posUniv, quat) {
    this.parkedPosUniv = posUniv.clone();
    this.parkedQuat.copy(quat);
  }

  setLandingPose(posUniv, quat, progress) {
    this.landingPose ??= {
      posUniv: new THREE.Vector3(),
      quat: new THREE.Quaternion(),
      progress: 0,
    };
    this.landingPose.posUniv.copy(posUniv);
    this.landingPose.quat.copy(quat);
    this.landingPose.progress = THREE.MathUtils.clamp(progress, 0, 1);
  }

  finishLanding() {
    this.landingPose = null;
    this.parkAmt = 1;
  }

  setForegroundOnly(enabled) {
    if (this.foregroundOnly === enabled) return;
    this.foregroundOnly = enabled;
    this.group.traverse((object) => object.layers.set(enabled ? SHIP_FOREGROUND_LAYER : 0));
  }

  update(dt, nav, state, speed, warp, boost = 0, flightInput = null) {
    const cinematicLanding = state === 'landing' && !!this.landingPose;
    const wantsPark = (state === 'walk' || state === 'landing' || state === 'boarding') && !!this.parkedPosUniv;
    if (cinematicLanding) this.parkAmt = this.landingPose.progress;
    else this.parkAmt += ((wantsPark ? 1 : 0) - this.parkAmt) * (1 - Math.exp(-dt * 2.0));
    const foregroundOnly = !cinematicLanding && (['space', 'flyto', 'warp', 'takeoff'].includes(state)
      || (state === 'landing' && this.parkAmt < 0.58));
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
    const driveThrust = Math.max(boost, warp * 1.12);
    this.thrustPose += (driveThrust - this.thrustPose) * (1 - Math.exp(-dt * 5.8));
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

    if (cinematicLanding) {
      // During landing the camera is an independent third-person observer.
      // Keep the hull in universe space instead of tying it to flight-camera
      // formation coordinates.
      this.group.position.copy(this.landingPose.posUniv).sub(nav.pos);
      this.group.quaternion.copy(this.landingPose.quat);
    } else if (this.parkedPosUniv && this.parkAmt > 0.002) {
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

  fire(nav, speedScale, ship, weaponPower = 1) {
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
    const muzzleSpeed = Math.max(780, speedScale * 10.5) * weaponPower;

    for (const side of [-1, 1]) {
      const bolt = this.bolts[this.cursor];
      this.cursor = (this.cursor + 1) % this.maxBolts;
      bolt.pos.copy(_weaponPos).addScaledVector(_weaponRight, side * 2.5);
      bolt.vel.copy(nav.vel).addScaledVector(_weaponForward, muzzleSpeed);
      bolt.life = bolt.maxLife = 1.65 * Math.max(.65, weaponPower);
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
