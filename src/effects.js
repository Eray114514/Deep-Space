// Warp-flight visuals. The old world-space LineSegments and a separate DOM
// pulse overlay never formed one image: lines crossed depth layers while the
// screen tint sat above the ship. This shader is inserted before the foreground
// ship pass, so warp and local pulse share one coherent camera-space tunnel.

import * as THREE from 'three';
import { SHIP_INTERIOR_LAYER, SKY_BACKDROP_LAYER } from './render-layers.js';

import { buildEnvironment } from './halcyon/materials.js';
import { assembleShip } from './halcyon/ship/model.js';
import { shipAmbient, shipEngine } from './halcyon/ship/surfaces.js';
import { applyInteriorIrradiance, bakeInteriorIrradiance } from './halcyon/gfx/interior-irradiance.js';
import { SHIPS } from './halcyon/ship/registry.js';
import { setMaterialEnvironmentIntensity } from './pbr-materials.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const SKY_SUNSET_TINT = new THREE.Color(1.35, 0.22, 0.035);
const _fallbackSunColor = new THREE.Color(1.0, 0.93, 0.84);

// The hero ship is authored in Blender (tools/blender/build_halcyon.py) and
// shipped as assets/halcyon/halcyon.glb. main.js awaits loadShipModel() under
// the loading veil and hands the parsed glTF to the Ship constructor, so
// construction itself stays synchronous.

// One authored size contract drives landing clearance and walk collision.
// Values follow the HALCYON VII definition (src/halcyon/ship/ships/halcyon.js):
// 27.9 m long (pitot z -16.5 .. nozzle lips 11.7), 21.6 m span (tip rails at
// x ±10.8), hull belly at y -1.05, fin tip at y ~6.55. The ship flies at 1:1
// scale; y = 0 is the interior deck, so the belly sits ~1 m under the deck and
// the landing gear pads reach y -1.60 (belly minus groundClearance).
export const SHIP_LANDING_PROFILE = Object.freeze({
  scale: 1,
  bounds: Object.freeze({
    minY: -1.05,
    maxY: 7.3,
    halfX: 10.7,
    halfZ: 15.6,
  }),
  groundClearance: 0.55,
  footprint: Object.freeze([
    Object.freeze([0, -15.6]),
    Object.freeze([-2.2, -12.0]), Object.freeze([2.2, -12.0]),
    Object.freeze([-3.6, -3.0]), Object.freeze([3.6, -3.0]),
    Object.freeze([-3.4, 6.2]), Object.freeze([3.4, 6.2]),
    Object.freeze([-10.7, 7.3]), Object.freeze([10.7, 7.3]),
    Object.freeze([-10.7, 2.0]), Object.freeze([10.7, 2.0]),
    Object.freeze([0, 11.3]),
  ]),
  colliders: Object.freeze([
    // Raised central fuselage plus wings and nacelles. Their upper faces are
    // real walking surfaces, while the volumes stop the player ghosting
    // through the parked ship. Coordinates are in the ship's own frame
    // (nose at -Z, deck at y=0).
    Object.freeze({ center: Object.freeze([0, 1.15, -2.15]), half: Object.freeze([3.7, 2.2, 13.45]) }),
    Object.freeze({ center: Object.freeze([6.9, 0.45, 6.3]), half: Object.freeze([3.8, 0.75, 4.4]) }),
    Object.freeze({ center: Object.freeze([-6.9, 0.45, 6.3]), half: Object.freeze([3.8, 0.75, 4.4]) }),
    Object.freeze({ center: Object.freeze([3.6, 0.7, 5.2]), half: Object.freeze([1.25, 1.25, 6.1]) }),
    Object.freeze({ center: Object.freeze([-3.6, 0.7, 5.2]), half: Object.freeze([1.25, 1.25, 6.1]) }),
  ]),
});

// Fast initial descent with a long, readable touchdown settle.
export function landingDescentProgress(t) {
  const k = THREE.MathUtils.clamp(t, 0, 1);
  return 1 - Math.pow(1 - k, 2.35);
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
// The ship: the HALCYON VII corvette flies just ahead of the camera whenever
// you're in flight — banks into turns, engines burn with speed, fades out
// when you step onto a planet. We are no longer a disembodied camera.
// ============================================================================

const _sq = new THREE.Quaternion();
const _sv = new THREE.Vector3();
const _sf = new THREE.Vector3();
const _su = new THREE.Vector3();
const _sr = new THREE.Vector3();

export const SHIP_FOREGROUND_LAYER = 3;
export { SHIP_INTERIOR_LAYER } from './render-layers.js';

export class Ship {
  constructor(scene, { anisotropy = 1, renderer = null, radiance = null, model = null, probes = null } = {}) {
    this.probes = probes;
    const g = new THREE.Group();
    g.layers.set(SHIP_FOREGROUND_LAYER);
    this.group = g;
    this.foregroundOnly = true;
    scene.add(g);

    this.smQuat = new THREE.Quaternion();
    this.roll = 0;
    this.lookYaw = 0;
    this.lookPitch = 0;
    this.anisotropy = anisotropy;
    this.heroLoaded = false;
    this.heroLoadSettled = false;
    this.heroLoadFailed = false;

    // The flown vessel. HALCYON VII — long range exploration corvette.
    this.def = SHIPS[0];
    this.rampT = 0;
    this.rampTarget = 0;
    this.enginePower = 0.1;
    this.t = 0;

    this.mountShip(scene, renderer, radiance, model);

    // when you land, the ship sets down on a pad beside you and waits
    this.parkedPosUniv = null;
    this.parkedQuat = new THREE.Quaternion();
    this.parkAmt = 0;
    this.landingPose = null;
    // Hero start cinematic: a camera-relative offset that fades to zero as the
    // pull-back runs, so the ship slides into formation from off-screen.
    this.introOffset = new THREE.Vector3();
  }

  /**
   * Build the hull, dress it with the baked-PBR material library, bake the
   * cavity shadow attribute over the finished assembly, and stand up the
   * ship-scoped lighting rig.
   *
   * Everything (materials included) lives on the foreground layer so the
   * main scene pass never pays for it and the ship's lights never leak onto
   * planets or terrain.
   */
  mountShip(scene, renderer, radiance = null, model = null) {
    if (!model) throw new Error('Ship needs the loaded HALCYON model (loadShipModel)');
    this.separateInterior = Boolean(radiance?.enabled);
    const built = assembleShip(model, this.def);
    this.mats = built.mats;
    this.ext = built.ext;
    this.int = built.int;
    this.bakedLight = built.bakedLight;
    // nozzle positions come from the model (engine-N empties), not the def
    this.def.engines = this.ext.engines;
    if (renderer && !radiance?.enabled) {
      // The demo's deep-space PMREM probe drives all hull specular. It is
      // assigned per-material rather than as scene.environment so the rest
      // of this project's universe materials are untouched.
      this.envMap = buildEnvironment(renderer, this.def.id || this.def.name);
      for (const v of Object.values(this.mats)) {
        if (v instanceof THREE.Material) v.envMap = this.envMap;
        else if (Array.isArray(v)) v.forEach((m) => { if (m instanceof THREE.Material) m.envMap = this.envMap; });
      }
    }

    this.group.add(this.ext.group);
    this.group.add(this.int.group);
    /* night watch lighting: dim red fill that takes over when the cabin
       lights are switched down (see toggleCabinLights) */
    for (const [x, y, z, intensity] of [[0, 1.85, -7.4, 1.6], [0, 2.0, -3.0, 2.4], [0, 2.3, 2.6, 3.2]]) {
      const light = new THREE.PointLight(0xff2a12, intensity, 6.5, 2);
      light.position.set(x, y, z);
      light.userData.night = true;
      this.int.group.add(light);
    }
    this.cabinNight = false;
    this.cabinLightT = 1;
    this.animT = 0;
    this.interiorLights = [];
    this.int.group.traverse((object) => {
      if (!object.isLight) return;
      object.userData.radianceBaseIntensity = object.intensity;
      this.interiorLights.push(object);
    });

    this.zoneMaterials = new Set();
    this.exteriorMaterials = new Set();
    this.cabinMaterials = new Set();
    this.cockpitMaterials = new Set();
    if (radiance?.enabled) {
      // the cabin's light is baked in Blender; the runtime estimate is only
      // the fallback for a model exported without it
      if (!this.bakedLight) bakeInteriorIrradiance(this.int.group);
      this.configureMaterialZones(radiance);
    } else {
      this.ext.group.traverse((object) => {
        const list = Array.isArray(object.material) ? object.material
          : object.material ? [object.material] : [];
        for (const material of list) if (material.envMapIntensity !== undefined) {
          this.exteriorMaterials.add(material);
        }
      });
    }

    this.group.traverse((object) => {
      object.layers.set(SHIP_FOREGROUND_LAYER);
    });
    this.int.group.traverse((object) => object.layers.set(
      this.separateInterior ? SHIP_INTERIOR_LAYER : SHIP_FOREGROUND_LAYER));

    // The interior spotlight rigs are rigid relative to the hull they light,
    // so their shadow maps are frame-invariant: render once and freeze.
    // This removes two 1024² shadow passes from every frame at zero visual
    // cost (see the perf note in the halcyon port plan).
    this.group.traverse((object) => {
      if (object.isSpotLight && object.castShadow) {
        object.shadow.autoUpdate = false;
        object.shadow.needsUpdate = true;
      }
    });

    this.buildShipLights(scene);
    this.buildHardpoints();

    this.heroLoaded = true;
    this.heroLoadSettled = true;
  }

  configureMaterialZones(radiance) {
    const cloneZone = (root, environment, target) => {
      const clones = new WeakMap();
      root.traverse((object) => {
        if (!object.isMesh || !object.material) return;
        const clone = (source) => {
          if (!source?.isMeshStandardMaterial && !source?.isMeshPhysicalMaterial) return source;
          if (!clones.has(source)) {
            const material = source.clone();
            material.envMap = environment;
            material.userData.baseEnvMapIntensity = material.envMapIntensity ?? 1;
            applyInteriorIrradiance(material);
            clones.set(source, material);
            this.zoneMaterials.add(material);
            target.add(material);
          }
          return clones.get(source);
        };
        object.material = Array.isArray(object.material)
          ? object.material.map(clone) : clone(object.material);
      });
    };

    this.ext.group.traverse((object) => {
      const list = Array.isArray(object.material) ? object.material
        : object.material ? [object.material] : [];
      for (const material of list) {
        if (material.envMapIntensity === undefined) continue;
        material.envMap = radiance.spaceEnvironment;
        material.userData.baseEnvMapIntensity ??= material.envMapIntensity;
        this.exteriorMaterials.add(material);
      }
    });
    cloneZone(this.int.group, this.probes?.cabin ?? radiance.cabinProbe?.texture, this.cabinMaterials);
    cloneZone(this.int.cockpit.group, this.probes?.cockpit ?? radiance.cockpitProbe?.texture, this.cockpitMaterials);
    this.radiance = radiance;
  }

  setSpaceEnvironment(environment) {
    for (const material of this.exteriorMaterials) {
      material.envMap = environment;
      material.needsUpdate = true;
    }
  }

  /**
   * Ship-scoped lighting: a key light with a tight shadow frustum that
   * follows the hull, a cool fill from the opposite side, and a weak
   * ambient. 深空's own sun/terrain lights are planet-scale and live on the
   * default layer, so they can neither shadow nor tint the foreground ship;
   * these are the demo's exact light recipe (materials.ts review), driven
   * each frame by the active star instead of a fixed world direction.
   */
  buildShipLights(scene) {
    this.sun = new THREE.DirectionalLight(0xffffff, 1.4);
    this.sun.userData.shipSun = true;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 140;
    this.sun.shadow.camera.left = this.sun.shadow.camera.bottom = -34;
    this.sun.shadow.camera.right = this.sun.shadow.camera.top = 34;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.05;
    this.sun.layers.set(SHIP_FOREGROUND_LAYER);
    this.sun.target.layers.set(SHIP_FOREGROUND_LAYER);
    scene.add(this.sun, this.sun.target);

    this.secondarySun = new THREE.DirectionalLight(0xffffff, 0);
    this.secondarySun.userData.shipSun = true;
    this.secondarySun.castShadow = false;
    this.secondarySun.layers.set(SHIP_FOREGROUND_LAYER);
    this.secondarySun.target.layers.set(SHIP_FOREGROUND_LAYER);
    scene.add(this.secondarySun, this.secondarySun.target);

    /* Ambient and fill are deliberately weak. Neither casts, and a
       non-shadowing light lights every surface facing it regardless of what
       is in front of it — so inside the hull they would flood the cabin with
       unoccluded light no wall could block (see the materials.ts review).
       They only keep the exterior's shadow side from going to black. */
    this.ambient = new THREE.AmbientLight(0x4a5f7a, 0.20);
    this.ambient.layers.set(SHIP_FOREGROUND_LAYER);
    scene.add(this.ambient);
    this.fill = new THREE.DirectionalLight(0x5f86c8, 0.40);
    this.fill.layers.set(SHIP_FOREGROUND_LAYER);
    this.fill.target.layers.set(SHIP_FOREGROUND_LAYER);
    scene.add(this.fill, this.fill.target);
  }

  /** Weapon hardpoints: the muzzles of the two underwing cannon. */
  buildHardpoints() {
    this.hardpoints = [];
    for (const sx of [-1, 1]) {
      const hp = new THREE.Object3D();
      hp.position.set(sx * 5.2, 0.10, 0.78);
      hp.name = sx > 0 ? 'hardpoint-stbd' : 'hardpoint-port';
      hp.layers.set(SHIP_FOREGROUND_LAYER);
      this.group.add(hp);
      this.hardpoints.push(hp);
    }
  }

  /** Backward-compatible single-star adapter for isolated tests. */
  updateSun(dir, intensity) {
    if (!this.sun) return;
    const origin = this.group.position;
    this.sun.color.copy(_fallbackSunColor);
    this.sun.intensity = 1.4 * intensity;
    this.sun.position.copy(origin).addScaledVector(dir, 80);
    this.sun.target.position.copy(origin);
    this.secondarySun.intensity = 0;
    this.secondarySun.visible = false;
    this.ambient.intensity = 0.20;
    this.fill.intensity = 0.40;
    _sv.set(0.62, -0.26, 0.80).normalize();
    this.fill.position.copy(origin).addScaledVector(_sv, 60);
    this.fill.target.position.copy(origin);
  }

  /**
   * The hemisphere the hull sits in: sky above, ground bounce or planetshine
   * below.  `up` points away from the nearest body (null in deep space),
   * `proximity` is that body's radius over the ship's distance from its centre.
   */
  updateAmbient(environment, up, proximity = 0) {
    const sky = shipAmbient.uShipHemiSky.value, ground = shipAmbient.uShipHemiGround.value;
    const day = environment?.day ?? 1;
    const air = Math.min(1, environment?.skyIrradiance ?? 0);
    if (up) shipAmbient.uShipHemiUp.value.copy(up);
    // starlight floor, then the lit atmosphere overhead
    sky.setRGB(0.020 + air * 0.30, 0.024 + air * 0.38, 0.034 + air * 0.52);
    // a sunlit world fills roughly proximity^2 of the lower hemisphere
    const shine = up ? Math.min(1, proximity * proximity) * day : 0;
    ground.setRGB(0.012 + shine * 0.30, 0.012 + shine * 0.28, 0.014 + shine * 0.26);
  }

  updateLighting(radiance) {
    if (!this.sun) return;
    const origin = this.group.position;
    const lights = [this.sun, this.secondarySun];
    for (let i = 0; i < lights.length; i++) {
      const light = lights[i], source = radiance?.sources?.[i];
      const intensity = source
        ? (i === 0 ? 1.62 : 1.25) * source.irradiance * (radiance.directScale ?? 1)
        : 0;
      light.intensity = intensity > 0.001 ? intensity : 0;
      if (source?.color) light.color.copy(source.color);
      if (source?.direction) light.position.copy(origin).addScaledVector(source.direction, 80);
      light.target.position.copy(origin);
      // Keep light visibility bound strictly to foreground ownership so
      // entering/exiting planetary umbra never changes NUM_DIR_LIGHTS or
      // USE_SHADOWMAP across the 7 Halcyon PBR materials (~1.6 s recompile).
      light.visible = this.foregroundOnly;
      if (light.shadow) {
        light.shadow.autoUpdate = this.foregroundOnly && intensity > 0.001;
        if (!light.shadow.map) light.shadow.needsUpdate = true;
      }
    }
    this.ambient.intensity = radiance?.exteriorAmbient ?? 0.07;
    this.fill.intensity = radiance?.exteriorFill ?? 0.16;
    this.ambient.visible = this.foregroundOnly;
    this.fill.visible = this.foregroundOnly;
    _sv.set(0.62, -0.26, 0.80).normalize();
    this.fill.position.copy(origin).addScaledVector(_sv, 60);
    this.fill.target.position.copy(origin);
    const envScale = THREE.MathUtils.clamp(
      0.78 + (radiance?.environmentIntensity ?? 0.18) * 1.1, 0.72, 1.16,
    );
    for (const material of this.exteriorMaterials) {
      setMaterialEnvironmentIntensity(material,
        radiance?.components?.reflections === false ? 0 : envScale);
    }
    for (const material of [...this.cabinMaterials, ...this.cockpitMaterials]) {
      // the zone probes were rendered with the cabin lit: dim them with it
      setMaterialEnvironmentIntensity(material,
        radiance?.components?.reflections === false ? 0 : THREE.MathUtils.lerp(0.12, 1, this.cabinLightT ?? 1));
      if (material.userData?.interiorIndirectScale) {
        material.userData.interiorIndirectScale.value = (radiance?.components?.indirect === false ? 0 : 1)
          * THREE.MathUtils.lerp(0.10, 1, this.cabinLightT ?? 1);
      }
    }
    const cabin = this.cabinLightT ?? 1;
    for (const light of this.interiorLights || []) {
      const level = light.userData.night ? 1 - cabin : THREE.MathUtils.lerp(0.08, 1, cabin);
      light.intensity = (light.userData.radianceBaseIntensity ?? light.intensity)
        * (radiance?.components?.localLights === false ? 0 : 1) * level;
    }
    for (const material of [...(this.cabinMaterials || []), ...(this.cockpitMaterials || [])]) {
      if (material.userData.lampBase === undefined || !/^lamp(Warm|Cool|Strip)$/.test(material.name)) continue;
      material.emissiveIntensity = material.userData.lampBase * THREE.MathUtils.lerp(0.04, 1, cabin);
    }
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
    const layer = enabled ? SHIP_FOREGROUND_LAYER : 0;
    this.group.layers.set(layer);
    this.ext?.group.traverse((object) => object.layers.set(layer));
    for (const hardpoint of this.hardpoints || []) hardpoint.layers.set(layer);
    this.int?.group.traverse((object) => object.layers.set(
      this.separateInterior ? SHIP_INTERIOR_LAYER : layer));
    // the light rig is absent on headless test doubles
    this.sun?.layers.set(layer);
    this.sun?.target.layers.set(layer);
    this.secondarySun?.layers.set(layer);
    this.secondarySun?.target.layers.set(layer);
    this.fill?.layers.set(layer);
    this.fill?.target.layers.set(layer);
    this.ambient?.layers.set(layer);
    const exteriorRigVisible = enabled;
    if (this.sun) this.sun.visible = exteriorRigVisible;
    if (this.secondarySun) this.secondarySun.visible = exteriorRigVisible;
    if (this.fill) this.fill.visible = exteriorRigVisible;
    if (this.ambient) this.ambient.visible = exteriorRigVisible;
  }

  /**
   * Engine power for the plume / halo / core emissive, mapped from 深空's
   * flight state onto the demo's 0..1.7 throttle-power scale.
   */
  updateEngineFx(dt, speed, warp, boost) {
    // the FX rig is absent on headless test doubles
    if (!this.ext) return;
    const targetPower = THREE.MathUtils.clamp(
      speed / 7e5 * 0.8 + boost * 1.0 + warp * 1.12, 0.1, 1.7);
    // Turbopumps spool up quickly and decay with stored pressure.  Smoothing
    // the render state removes single-frame flame pops without delaying input
    // or feeding anything back into the flight simulation.
    const powerResponse = targetPower > this.enginePower ? 9.5 : 3.2;
    const power = THREE.MathUtils.lerp(this.enginePower, targetPower,
      1 - Math.exp(-Math.max(0, dt) * powerResponse));
    this.enginePower = power;
    // All plume phase multipliers are integer cycles, so a 2π wrap is visually
    // seamless and keeps the GPU uniform precise during arbitrarily long runs.
    this.t = (this.t + Math.max(0, dt)) % (Math.PI * 2);
    const t = this.t;

    /* Two shared instanced rigs (integrated plume/throat) replace per-engine mesh
       scaling.  Their nozzle roots never move; length, pressure cells and
       camera-axis safety are evaluated analytically in the shaders. */
    for (const p of this.ext.plumes) {
      const m = p.material;
      m.uniforms.uTime.value = t;
      m.uniforms.uPower.value = power;
    }
    for (const r of this.ext.glowRings) {
      r.material.uniforms.uPower.value = power;
      r.material.uniforms.uTime.value = t;
    }
    if (this.mats.engineCore) this.mats.engineCore.emissiveIntensity = 0.72 + power * 0.88;
    shipEngine.uShipEnginePower.value = power;

    /* strobes — kept modest so the bloom chain never saturates */
    const blink = (t % 1.3) < 0.09 ? 3.2 : 0.05;
    for (const s of this.ext.strobes) s.material.emissiveIntensity = blink;
    for (const glow of this.ext.strobeGlows || []) glow.material.opacity = blink > 1 ? 0.95 : 0;

    /* cargo-ramp containment field ticks even while closed so opening it
       never starts from a frozen lattice */
    const bm = this.int.barrier.material;
    bm.uniforms.uTime.value = t;
    bm.uniforms.uOpen.value = THREE.MathUtils.clamp((this.rampT - 0.15) / 0.6, 0, 1);
    this.int.barrier.visible = this.rampT > 0.02;

    /* the holo instruments: sweep rate and plot gain follow live flight */
    this.int.cockpit.holo.update(t, speed, power);
  }

  /** Landing gear follows the parking blend: stowed inside the belly in
   *  flight, extended for the last half of the descent. */
  updateGear(dt) {
    if (!this.ext?.gear) return;
    const want = THREE.MathUtils.smoothstep(this.parkAmt, 0.35, 0.85);
    this.gearT = THREE.MathUtils.lerp(this.gearT ?? want, want, 1 - Math.exp(-Math.max(0, dt) * 3.2));
    /* bay doors swing first, then the leg drops and unfolds; retraction runs
       the same timeline backwards, so the doors shut behind the stowed leg */
    const doorT = THREE.MathUtils.smoothstep(this.gearT, 0.0, 0.35);
    const legT = THREE.MathUtils.smoothstep(this.gearT, 0.3, 1.0);
    for (const leg of this.ext.gear) {
      const stowed = 1 - legT;
      leg.visible = doorT > 0.04;
      leg.position.y = leg.userData.deployedY + stowed * 0.55;
      if (leg.userData.nose) leg.rotation.set(stowed * 0.9, 0, 0);
      else leg.rotation.set(-stowed * 0.35, 0, -leg.userData.side * stowed * 0.55);
      for (const door of leg.userData.doors) {
        _gq.setFromAxisAngle(_gz, door.userData.side * -1.815 * (1 - doorT));
        door.quaternion.copy(door.userData.baseQuat).premultiply(_gq);
      }
    }
  }

  /** petals, ailerons and the sensor turret */
  updateMotion(dt) {
    if (!this.ext) return;
    this.animT = (this.animT ?? 0) + Math.max(0, dt);
    const iris = 0.93 + 0.08 * THREE.MathUtils.clamp(this.enginePower / 1.7, 0, 1);
    for (const ring of this.ext.petals || []) ring.scale.set(iris, iris, 1);
    // ailerons follow the visual bank and pitch; they droop when parked
    for (const flap of this.ext.flaps || []) {
      const angle = THREE.MathUtils.clamp(
        flap.userData.side * this.roll * 2.6 + (this.lookPitch ?? 0) * 9 - this.parkAmt * 0.22, -0.4, 0.4);
      this.flapAngles ??= new Map();
      const prev = this.flapAngles.get(flap) ?? angle;
      const eased = THREE.MathUtils.lerp(prev, angle, 1 - Math.exp(-Math.max(0, dt) * 8));
      this.flapAngles.set(flap, eased);
      flap.quaternion.setFromAxisAngle(flap.userData.axis, eased);
    }
    if (this.ext.sensor) {
      const t = this.animT;
      this.ext.sensor.rotation.set(0, Math.sin(t * 0.23) * 1.3 + Math.sin(t * 0.61) * 0.3, 0);
    }
  }

  /** switch the cabin between normal and night-watch lighting */
  toggleCabinLights() {
    this.cabinNight = !this.cabinNight;
    return this.cabinNight;
  }

  /**
   * Everything inside that moves: doors that open for the walker, fans,
   * the crane hook swinging with the ship, the light switch, the stick and
   * throttle, and the live displays.
   */
  updateInterior(dt, view, telemetry = null) {
    if (!this.int) return;
    const step = Math.max(0, dt);
    this.cabinLightT = THREE.MathUtils.lerp(this.cabinLightT ?? 1, this.cabinNight ? 0 : 1, 1 - Math.exp(-step * 2.5));
    const walking = !!view?.shipwalk;
    const p = view?.walkPos;
    for (const door of this.int.doors || []) {
      const near = walking && p && Math.hypot(p.x, p.z - door.position.z) < 2.1;
      const open = THREE.MathUtils.lerp(door.userData.openT ?? 0, near ? 1 : 0, 1 - Math.exp(-step * (near ? 7 : 3.5)));
      door.userData.openT = open;
      door.position.x = door.userData.closedX + door.userData.side * door.userData.travel * open * open * (3 - 2 * open);
    }
    for (const fan of this.int.fans || []) fan.rotation.y += step * 11;
    // crane hook: a damped pendulum driven by the hull's apparent motion
    if (this.int.hook) {
      const h = this.hookState ??= { x: 0, z: 0, vx: 0, vz: 0 };
      const tx = THREE.MathUtils.clamp(-(this.thrustPose ?? 0) * 0.35 + (this.lookPitch ?? 0) * 6, -0.5, 0.5);
      const tz = THREE.MathUtils.clamp(this.roll * 2.2, -0.5, 0.5);
      for (const [a, v, target] of [['x', 'vx', tx], ['z', 'vz', tz]]) {
        h[v] += ((target - h[a]) * 9.0 - h[v] * 0.6) * step;
        h[a] += h[v] * step;
      }
      this.int.hook.rotation.set(h.x, 0, h.z);
    }
    if (this.int.lightSwitch) this.int.lightSwitch.rotation.z = THREE.MathUtils.lerp(-0.3, 0.3, this.cabinLightT);
    const input = this.lastInput;
    const cockpit = this.int.cockpit;
    if (cockpit?.stick) {
      const sx = THREE.MathUtils.clamp(input?.pitch || 0, -1, 1), sz = THREE.MathUtils.clamp(input?.yaw || 0, -1, 1);
      this.stickPose = this.stickPose ?? new THREE.Vector2();
      this.stickPose.lerp(_sv2.set(sx, sz), 1 - Math.exp(-step * 12));
      cockpit.stick.rotation.set(this.stickPose.x * 0.22, 0, -this.stickPose.y * 0.22);
    }
    if (cockpit?.throttle) {
      const thrust = THREE.MathUtils.clamp((input?.throttle || 0) * 0.5 + (this.thrustPose ?? 0) * 0.5, -1, 1);
      cockpit.throttle.rotation.x = THREE.MathUtils.lerp(cockpit.throttle.rotation.x, -thrust * 0.45, 1 - Math.exp(-step * 8));
    }
    this.updateDisplays(step, telemetry, walking || view?.isCockpit?.());
  }

  /** redraw the cockpit pages from live telemetry, a page at a time */
  updateDisplays(dt, telemetry, active) {
    const pages = (this.mats?.screens || []).filter((material) => material.map?.userData?.redraw);
    if (!active || !pages.length) return;
    this.displayClock = (this.displayClock ?? 0) + dt;
    if (this.displayClock < 0.1) return;
    this.displayClock = 0;
    this.displayTick = (this.displayTick ?? 0) + 1;
    const attitude = pages.find((material) => material.name === 'screen-attitude');
    const others = pages.filter((material) => material !== attitude);
    const page = attitude && this.displayTick % 2 === 0 ? attitude : others[(this.displayTick >> 1) % others.length];
    if (!page) return;
    page.map.userData.redraw({ ...(telemetry || {}), power: this.enginePower, time: this.animT });
  }

  update(dt, nav, state, speed, warp, boost = 0, flightInput = null, camera = null) {
    this.frameNo = (this.frameNo ?? 0) + 1;
    const cinematicLanding = state === 'landing' && !!this.landingPose;
    const wantsPark = (state === 'walk' || state === 'landing' || state === 'boarding' || state === 'shipwalk') && !!this.parkedPosUniv;
    if (cinematicLanding) this.parkAmt = this.landingPose.progress;
    else this.parkAmt += ((wantsPark ? 1 : 0) - this.parkAmt) * (1 - Math.exp(-dt * 2.0));
    const foregroundOnly = !cinematicLanding && (['space', 'flyto', 'warp', 'takeoff'].includes(state)
      || (state === 'shipwalk' && !this.parkedPosUniv)
      || (state === 'landing' && this.parkAmt < 0.58));
    this.setForegroundOnly(foregroundOnly);

    // The hull's mass response is driven by raw pilot intent, never by speed
    // or by the final camera quaternion. Therefore a zero-speed mouse turn
    // still has weight, while passive planet-frame rotation remains stable.
    const yawInput = flightInput?.yaw || 0;
    const pitchInput = flightInput?.pitch || 0;
    const throttleInput = flightInput?.throttle || 0;
    const strafeInput = flightInput?.strafe || 0;
    const yawTarget = yawInput * 0.018;
    const pitchTarget = pitchInput * 0.014 - throttleInput * 0.008;
    this.lookYaw ??= 0;
    this.lookPitch ??= 0;
    const lookActive = Math.abs(yawInput) + Math.abs(pitchInput) > 0.03;
    const lookResponse = lookActive ? 5.2 : 3.0;
    this.lookYaw += (yawTarget - this.lookYaw) * (1 - Math.exp(-dt * lookResponse));
    this.lookPitch += (pitchTarget - this.lookPitch) * (1 - Math.exp(-dt * lookResponse));

    const rollTarget = THREE.MathUtils.clamp(
      yawInput * 0.025 - strafeInput * 0.075, -0.12, 0.12);
    const rollResponse = Math.abs(rollTarget) > Math.abs(this.roll) ? 4.2 : 3.2;
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
    // appear to slide toward a stationary model. The formation offset is
    // tuned for the 27 m HALCYON hull so it frames like the old 13 m hero did
    // at 19 units (a touch closer, so the bigger ship reads as an upgrade).
    _sv.copy(_sf).multiplyScalar(30 + this.thrustPose * 3.2)
      .addScaledVector(_su, -6.5 + this.thrustPose * 0.35);   // formation offset
    _sr.set(1, 0, 0).applyQuaternion(nav.quat);
    _sv.addScaledVector(_sr, -this.lookYaw * 3.2)
      .addScaledVector(_su, this.lookPitch * 2.4);
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

    this.lastInput = flightInput;
    this.updateEngineFx(dt, speed, warp, boost);
    this.updateGear(dt);
    this.updateMotion(dt);
    // the cabin probes are baked in ship space: turn them with the hull
    if (this.probes) {
      _probeEuler.setFromQuaternion(_sq.copy(this.group.quaternion).invert());
      for (const material of this.cabinMaterials) material.envMapRotation.copy(_probeEuler);
      for (const material of this.cockpitMaterials) material.envMapRotation.copy(_probeEuler);
    }

    // Sun-shadow cadence: live while flying; while parked the hull cannot
    // move under its own power, so the map re-renders only often enough to
    // track the planet's slow rotation (the parked ship still gets crisp
    // self-shadowing, software rasterisers get three fewer ship passes).
    if (this.sun) {
      // live while the hull can actually move (flight states, the landing
      // descent, or an interior walk mid-flight); frozen + periodic refresh
      // once it is parked on a pad
      const flying = ['space', 'flyto', 'warp', 'takeoff', 'landing'].includes(state)
        || (state === 'shipwalk' && !this.parkedPosUniv);
      if (this.sun.shadow.autoUpdate !== flying) {
        this.sun.shadow.autoUpdate = flying;
        this.sun.shadow.needsUpdate = true;
      } else if (!flying && this.frameNo % 90 === 0) {
        this.sun.shadow.needsUpdate = true;
      }
    }
  }
}
const _sq2 = new THREE.Quaternion();
const _gq = new THREE.Quaternion();
const _gz = new THREE.Vector3(0, 0, 1);
const _sv2 = new THREE.Vector2();
const _probeEuler = new THREE.Euler();
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
    const muzzleSpeed = Math.max(780, speedScale * 10.5) * weaponPower;

    // The HALCYON's named wing hardpoints win when present; the legacy
    // formation-relative offsets stay as the fallback.
    const hardpoints = ship?.hardpoints;
    if (Array.isArray(hardpoints) && hardpoints.length === 2) {
      for (let i = 0; i < 2; i++) {
        const bolt = this.bolts[this.cursor];
        this.cursor = (this.cursor + 1) % this.maxBolts;
        hardpoints[i].updateWorldMatrix(true, false);
        bolt.pos.copy(_weaponPos)
          .add(_weaponDir.setFromMatrixPosition(hardpoints[i].matrixWorld));
        bolt.vel.copy(nav.vel).addScaledVector(_weaponForward, muzzleSpeed);
        bolt.life = bolt.maxLife = 1.65 * Math.max(.65, weaponPower);
        bolt.length = THREE.MathUtils.clamp(muzzleSpeed * 0.0018, 1.0, 2.4);
      }
      this.shotsFired++;
      return;
    }
    // The rebuilt hull's paired emitters sit just inboard of the wingtips.
    _weaponPos.addScaledVector(_weaponForward, 1.35).addScaledVector(_weaponUp, -0.15);

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
