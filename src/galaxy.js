// The universe: a finite catalogue of 1,024 reachable star systems. Only the
// current system is fully instantiated (sun + planets + moons); the catalogue
// keeps every destination stable without manufacturing new stars beyond the
// authored galactic boundary.

import * as THREE from 'three';
import { PointsNodeMaterial } from 'three/webgpu';
import {
  attribute, clamp as nodeClamp, float, length as nodeLength, mix,
  positionView, smoothstep as nodeSmoothstep, uniform, vertexColor,
} from 'three/tsl';
import { makeRng } from './rng.js';
import { clamp } from './noise.js';
import { Planet } from './planet.js';
import { GasGiant } from './gas-giant.js';
import { BlackHole } from './black-hole.js';
import { BodyFrame, generateStellarSpec, generateSystemSpec, orbitalPosition, orbitalVelocity, orientationAt as bodyOrientationAt } from './astronomy.js';
import { buildGalaxyBackdrop, CELL, GalaxyCatalog, HOME_SYSTEM_ID } from './galaxy-layout.js';
import { buildCivilizationSites, civilizationSitesForSystem } from './civilization.js';
import { ArtificialHabitat, createCivilizationVisual, disposeCivilizationVisual } from './artificial-sites.js';
import { rendererParamsForSettings, resolveGraphicsSettings } from './graphics-settings.js';
import { resolveRendererPolicy } from './renderer-policy.js';
import { applySystemBodyTuning } from './world-config.js';
import { blackbodyLinearRgb, buildStellarLightField } from './stellar-radiometry.js';

export { CELL } from './galaxy-layout.js';

// seamless interstellar flight: approaching a star instantiates its system
// while its planets are still sub-pixel; the system you leave lingers until
// it is genuinely out of sight
const APPROACH_DIST = 7e9;
const FADE_DIST = 9e9;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _extC = new THREE.Color();
const rendererParams = typeof location !== 'undefined'
  ? new URLSearchParams(location.search) : new URLSearchParams();
const rendererSettings = resolveGraphicsSettings({ params: rendererParams });
const USE_NODE_MATERIALS = resolveRendererPolicy(
  rendererParamsForSettings(rendererSettings, rendererParams)).backend === 'webgpu';

// Every star in the sky is a real lattice star. Apparent size and brightness
// fall off with true distance (computed in view space, where the f64 group
// offset has already been applied).
function makeStarPointsMaterial() {
  if (!USE_NODE_MATERIALS) {
    return new THREE.ShaderMaterial({
      uniforms: {
        uDim: { value: 0 },
        uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
        uProj: { value: 600 },
      },
      vertexShader: /* glsl */`
        uniform float uPixelRatio;
        uniform float uProj;
        attribute float aSize;
        varying vec3 vColor;
        varying float vBright;
        void main() {
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float dist = length(mv.xyz);
          float discPx = 1.2e7 * aSize * uProj / max(dist, 1.0);
          gl_PointSize = clamp(max(1.8 + aSize * 0.55, discPx), 1.8, 28.0) * uPixelRatio;
          vBright = clamp(2.2e10 / max(dist, 1.0), 0.42, 1.0)
            * (1.0 - smoothstep(7.5e10, 9.2e10, dist));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform float uDim;
        varying vec3 vColor;
        varying float vBright;
        void main() {
          float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
          float a = smoothstep(1.0, 0.15, r);
          gl_FragColor = vec4(vColor * (1.0 + 0.5 * (1.0 - r)), 1.0)
            * a * vBright * (1.0 - uDim * 0.97);
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  const nodes = {
    uDim: uniform(0),
    uPixelRatio: uniform(Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2)),
    uProj: uniform(600),
  };
  const starSize = attribute('aSize', 'float');
  const distance = nodeLength(positionView);
  const discPx = starSize.mul(1.2e7).mul(nodes.uProj).div(distance.max(1));
  const pointSize = nodeClamp(discPx.max(float(1.8).add(starSize.mul(0.55))), 1.8, 28)
    .mul(nodes.uPixelRatio);
  const brightness = nodeClamp(float(2.2e10).div(distance.max(1)), 0.42, 1)
    .mul(nodeSmoothstep(9.2e10, 7.5e10, distance))
    .mul(float(1).sub(nodes.uDim.mul(0.97)));
  const material = new PointsNodeMaterial({
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.sizeNode = pointSize;
  // pointUV/gl_PointCoord currently has no portable WGSL path in r185.1.
  // Keep the finite star field backend-neutral; bloom supplies the soft halo.
  material.colorNode = vertexColor().mul(1.2);
  material.opacityNode = brightness;
  material.uniforms = nodes;
  return material;
}

function makeBackdropPointsMaterial() {
  if (!USE_NODE_MATERIALS) {
    return new THREE.ShaderMaterial({
      uniforms: { uDim: { value: 0 } },
      vertexShader: /* glsl */`
        attribute float aSize;
        attribute float aAlpha;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          vColor = color;
          vAlpha = aAlpha;
          gl_PointSize = aSize;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: /* glsl */`
        uniform float uDim;
        varying vec3 vColor;
        varying float vAlpha;
        void main() {
          float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
          float a = smoothstep(1.0, 0.1, r);
          gl_FragColor = vec4(vColor * 0.78, a * vAlpha * (1.0 - uDim * 0.985));
        }`,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }
  const nodes = { uDim: uniform(0) };
  const material = new PointsNodeMaterial({
    sizeAttenuation: false,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  material.sizeNode = attribute('aSize', 'float');
  material.colorNode = vertexColor().mul(0.78);
  material.opacityNode = attribute('aAlpha', 'float').mul(float(1).sub(nodes.uDim.mul(0.985)));
  material.uniforms = nodes;
  return material;
}

function glowTexture(size = 128, inner = 0.0, tight = false) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.02, size / 2, size / 2, size / 2);
  if (tight) {
    // a compact corona: bright core, fast falloff — the star's blowout is
    // bloom's job, and bloom is correctly occluded by planets
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.12, 'rgba(255,255,255,0.6)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
  } else {
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
    g.addColorStop(0.5, `rgba(255,255,255,${0.18 + inner})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(canvas);
}

// cloudy blotch texture: dozens of soft blobs accumulated, then masked so
// the rim fades out — reads as nebula gas / a galaxy streak instead of the
// perfect-circle lens halo a plain radial gradient produces
function cloudTexture(rand, size = 256, band = false) {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = band ? size / 2 : size;
  const H = canvas.height;
  const ctx = canvas.getContext('2d');
  const blobs = band ? 110 : 55;
  for (let i = 0; i < blobs; i++) {
    const bx = rand() * size;
    const by = band ? H * (0.5 + (rand() - 0.5) * 0.6) : rand() * H;
    const br = (band ? 0.04 + rand() * 0.1 : 0.06 + rand() * 0.15) * size;
    const g = ctx.createRadialGradient(bx, by, 0, bx, by, br);
    g.addColorStop(0, `rgba(255,255,255,${0.05 + rand() * 0.1})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, H);
  }
  ctx.globalCompositeOperation = 'destination-in';
  if (band) {
    let g = ctx.createLinearGradient(0, 0, 0, H);      // soft vertical profile
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, H);
    g = ctx.createLinearGradient(0, 0, size, 0);       // ends fade → segments blend
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.25, 'rgba(0,0,0,1)');
    g.addColorStop(0.75, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, H);
  } else {
    const g = ctx.createRadialGradient(size / 2, H / 2, size * 0.08, size / 2, H / 2, size * 0.5);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, H);
  }
  return new THREE.CanvasTexture(canvas);
}

export class Universe {
  constructor(seedStr, scene, { galaxyId = 'milky-way', bodyTuning = null, blackHoleSystem = null } = {}) {
    this.seed = seedStr;
    this.galaxyId = galaxyId;
    this.bodyTuning = bodyTuning;
    this.blackHoleSystem = blackHoleSystem;
    this.scene = scene;
    this.group = new THREE.Group();           // current system lives here
    this.group.name = 'universe';
    scene.add(this.group);

    this.glowTex = glowTexture();
    this.glowTexTight = glowTexture(128, 0, true);
    this.buildSkybox();

    this.nearStarsMesh = null;
    this.nearStarsList = [];
    this.candidates = [];              // stars close enough to fly to manually
    this.lastStarRebuild = new THREE.Vector3(Infinity, 0, 0);
    this.camPos = new THREE.Vector3();
    this.timeHours = 0;
    this.catalog = new GalaxyCatalog(seedStr);
    this.civilizationSites = buildCivilizationSites(seedStr, this.catalog);
    const civilizationBySystem = new Map(this.civilizationSites.map((site) => [site.systemId, site]));
    for (const record of this.catalog.allSystems()) {
      record.civilizationTag = civilizationBySystem.get(record.id)?.type || null;
    }
    this.catalogStars = this.catalog.allSystems().map((record) => this.starFromRecord(record));
    this.catalogStarById = new Map(this.catalogStars.map((star) => [star.id, star]));
    this.buildFiniteBackdrop();

    this.specialDestinations = blackHoleSystem ? [{
      ...blackHoleSystem,
      kind: 'blackHole',
      pos: new THREE.Vector3(
        blackHoleSystem.positionCells[0] * CELL,
        blackHoleSystem.positionCells[1] * CELL,
        blackHoleSystem.positionCells[2] * CELL,
      ),
      color: new THREE.Color(0xffa45f),
      radius: 1.45e7,
    }] : [];

    this.homeStar = this.catalogStarById.get(HOME_SYSTEM_ID);
    this.system = null;
    this.fadingSystem = null;          // the system being left behind
    this.setSystem(this.homeStar);
  }

  // all live planets (current system + the one fading behind us)
  planets() {
    return this.fadingSystem
      ? this.system.planets.concat(this.fadingSystem.planets)
      : this.system.planets;
  }

  starFromRecord(record) {
    const pos = new THREE.Vector3(
      record.positionCells[0] * CELL,
      record.positionCells[1] * CELL,
      record.positionCells[2] * CELL,
    );
    const stellar = generateStellarSpec(this.seed, record);
    const primary = stellar.stars[0];
    return {
      ...record,
      pos,
      color: new THREE.Color(primary.color),
      radius: primary.radiusRender,
    };
  }

  starById(id) { return this.catalogStarById.get(id) || null; }
  allStars() { return this.catalogStars; }

  buildFiniteBackdrop() {
    const cellPositions = buildGalaxyBackdrop(this.seed, 20000, this.catalog.allSystems());
    const positions = new Float32Array(cellPositions.length);
    const colors = new Float32Array(cellPositions.length);
    const sizes = new Float32Array(cellPositions.length / 3);
    const alphas = new Float32Array(cellPositions.length / 3);
    const rand = makeRng(`${this.seed}:space-backdrop:v1`);
    const tint = new THREE.Color();
    for (let i = 0; i < sizes.length; i++) {
      positions[i * 3] = cellPositions[i * 3] * CELL;
      positions[i * 3 + 1] = cellPositions[i * 3 + 1] * CELL;
      positions[i * 3 + 2] = cellPositions[i * 3 + 2] * CELL;
      const warm = rand();
      tint.setHSL(warm < 0.72 ? 0.58 + rand() * 0.08 : 0.04 + rand() * 0.08,
        0.18 + rand() * 0.38, 0.62 + rand() * 0.32);
      colors[i * 3] = tint.r;
      colors[i * 3 + 1] = tint.g;
      colors[i * 3 + 2] = tint.b;
      sizes[i] = rand() < 0.94 ? 1 : 1.45 + rand() * 0.8;
      alphas[i] = 0.26 + Math.pow(rand(), 2.4) * 0.68;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(alphas, 1));
    this.backdropMaterial = makeBackdropPointsMaterial();
    this.backdropMesh = new THREE.Points(geometry, this.backdropMaterial);
    this.backdropMesh.frustumCulled = false;
    this.backdropMesh.renderOrder = -10;
    this.scene.add(this.backdropMesh);
  }

  buildSkybox() {
    const rand = makeRng(this.seed + ':skybox');
    // nebulae: big soft additive sprites at infinity (purely scenery — unlike
    // the stars, which are all real places)
    this.nebulas = new THREE.Group();
    const nCount = 4 + ((rand() * 3) | 0);
    for (let i = 0; i < nCount; i++) {
      // each nebula gets its own blotchy texture — a shared radial gradient
      // made them read as identical circular halos pinned to the sky
      const mat = new THREE.SpriteMaterial({
        map: cloudTexture(rand), transparent: true, opacity: 0.08 + rand() * 0.08,
        color: new THREE.Color().setHSL(rand(), 0.7, 0.55),
        rotation: rand() * Math.PI * 2,
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const spr = new THREE.Sprite(mat);
      _v.set(rand() * 2 - 1, (rand() * 2 - 1) * 0.5, rand() * 2 - 1).normalize().multiplyScalar(1.8e9);
      spr.position.copy(_v);
      const s = (1.2 + rand() * 2.2) * 6.5e8;
      spr.scale.set(s, s * (0.55 + rand() * 0.5), 1);   // gas clouds aren't round
      this.nebulas.add(spr);
    }
    // the Milky Way: a faint streaky band along the galactic disc plane —
    // segments share one noise texture whose ends fade so they blend into a
    // continuous river of light instead of a ring of separate blobs
    const bandTex = cloudTexture(rand, 256, true);
    const bandTilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((rand() - 0.5) * 0.35, 0, (rand() - 0.5) * 0.35));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6e9, 4.2e8),
        new THREE.MeshBasicMaterial({
          map: bandTex, transparent: true, opacity: 0.055 + rand() * 0.035,
          color: new THREE.Color().setHSL(0.08 + rand() * 0.5, 0.25, 0.72),
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          side: THREE.DoubleSide,
        }),
      );
      mesh.position.set(Math.cos(a) * 2.2e9, (rand() - 0.5) * 6e7, Math.sin(a) * 2.2e9)
        .applyQuaternion(bandTilt);
      mesh.lookAt(0, 0, 0);
      this.nebulas.add(mesh);
    }
    this.nebulas.renderOrder = -9;
    this.scene.add(this.nebulas);
  }

  // deferred=true: the sun appears now, planets materialize one per
  // buildNext() call — spreads the cost over warp/approach frames
  setSystem(star, deferred = false) {
    // returning to the system we were just leaving? promote it back
    if (this.fadingSystem && this.fadingSystem.star.id === star.id) {
      const f = this.fadingSystem;
      this.fadingSystem = this.system;
      this.system = f;
      this.rebuildNearStars(star.pos);
      if (this.onSystemChange) this.onSystemChange(this.system);
      return this.system;
    }
    if (this.system) {
      this.disposeFading();
      if (this.camPos.distanceTo(this.system.star.pos) < FADE_DIST) {
        this.fadingSystem = this.system;     // still visible behind us
      } else {
        this.system.dispose();
      }
    }
    this.system = new StarSystem(this, star, { deferred, timeHours: this.timeHours });
    this.rebuildNearStars(star.pos);
    if (this.onSystemChange) this.onSystemChange(this.system);
    return this.system;
  }

  // Promote a system that was already built for a spatial-window preview.
  // Reusing the same scene graph keeps the destination planet's scale, LOD
  // and ephemeris continuous across the threshold instead of destroying it
  // and briefly showing an empty deferred system after traversal.
  adoptSystem(prepared) {
    if (!prepared || prepared.universe !== this) throw new Error('Cannot adopt a foreign star system');
    if (prepared === this.system) return prepared;
    if (this.system) {
      this.disposeFading();
      this.fadingSystem = this.system;
    }
    this.system = prepared;
    this.rebuildNearStars(prepared.star.pos);
    if (this.onSystemChange) this.onSystemChange(prepared);
    return prepared;
  }

  disposeFading() {
    if (!this.fadingSystem) return;
    if (this.onBeforeSystemDispose && this.onBeforeSystemDispose(this.fadingSystem) === false) return;
    this.fadingSystem.dispose();
    this.fadingSystem = null;
  }

  // Gather the finite catalogue. At 1,024 points it is cheaper and more stable
  // to keep the whole barred spiral visible than to rebuild a moving lattice.
  rebuildNearStars(camPos) {
    this.lastStarRebuild.copy(camPos);
    const list = this.catalogStars.filter((star) => star.id !== this.system.star.id);
    for (const destination of this.specialDestinations) {
      if (destination.id !== this.system.star.id && !list.some((star) => star.id === destination.id)) {
        list.push(destination);
      }
    }
    this.nearStarsList = list;
    // stars worth proximity-checking every frame for manual approach
    this.candidates = list.filter((s) => s.pos.distanceTo(camPos) < 1.2e10);

    if (this.nearStarsMesh) {
      this.scene.remove(this.nearStarsMesh);
      this.nearStarsMesh.geometry.dispose();
    }
    const pos = new Float32Array(list.length * 3);
    const col = new Float32Array(list.length * 3);
    const siz = new Float32Array(list.length);
    list.forEach((s, i) => {
      pos[i * 3] = s.pos.x; pos[i * 3 + 1] = s.pos.y; pos[i * 3 + 2] = s.pos.z;
      col[i * 3] = s.color.r; col[i * 3 + 1] = s.color.g; col[i * 3 + 2] = s.color.b;
      siz[i] = s.radius / 6e6;           // true stellar radius scale
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    if (!this.starMaterial) this.starMaterial = makeStarPointsMaterial();
    this.nearStarsMesh = new THREE.Points(geo, this.starMaterial);
    this.nearStarsMesh.frustumCulled = false;
    this.nearStarsMesh.renderOrder = -8;
    this.scene.add(this.nearStarsMesh);
  }

  // ray pick a distant star (by angular proximity; near bright stars are
  // forgiving targets, far pinpricks demand more precision)
  pickStar(origin, dir) {
    let best = null, bestAng = Infinity;
    for (const s of this.nearStarsList) {
      _v.copy(s.pos).sub(origin);
      const dist = _v.length();
      if (dist < 4e8) continue;
      const ang = _v.normalize().angleTo(dir);
      const limit = dist < 3e10 ? 0.018 : 0.008;
      if (ang < limit && ang < bestAng) { bestAng = ang; best = s; }
    }
    return best;
  }

  update(camPos, allowSwap = false, timeHours = this.timeHours) {
    this.timeHours = timeHours;
    this.camPos.copy(camPos);
    this.system?.updateCelestial(timeHours);
    this.fadingSystem?.updateCelestial(timeHours);
    if (camPos.distanceTo(this.lastStarRebuild) > CELL * 0.5) {
      this.rebuildNearStars(camPos);
    }
    // the system behind us slips out of range
    if (this.fadingSystem && camPos.distanceTo(this.fadingSystem.star.pos) > FADE_DIST) {
      this.disposeFading();
    }
    // flying up to a dot makes it a real place: nearest star wins the camera
    if (allowSwap) {
      let best = null, bestD = Infinity;
      for (const s of this.candidates) {
        const d = camPos.distanceTo(s.pos);
        if (d < bestD) { bestD = d; best = s; }
      }
      const curD = camPos.distanceTo(this.system.star.pos);
      if (best && best.id !== this.system.star.id && bestD < APPROACH_DIST && bestD < curD * 0.75) {
        this.setSystem(best, true);
      }
    }
  }

  // camera-relative placement: camera sits at scene origin, the universe moves
  relativizeSystem(sys, camPos) {
    const d = camPos.distanceTo(sys.star.pos);
    const tg = clamp((4.2e9 - d) / 2.2e9, 0, 1);
    const stellarField = sys.stellarLightFieldFrom(camPos);
    const totalLuminosity = sys.starViews.reduce(
      (sum, view) => sum + view.spec.luminositySolar, 0);
    const systemIntensity = 3.2 * clamp(Math.sqrt(totalLuminosity), 0.7, 2.2)
      * clamp((FADE_DIST - d) / 3e9, 0, 1);
    for (let index = 0; index < sys.starViews.length; index++) {
      const starView = sys.starViews[index];
      starView.group.position.copy(starView.positionUniv).sub(camPos);
      starView.light.position.copy(starView.group.position);
      starView.light.intensity = systemIntensity
        * (stellarField.sources[index]?.irradianceFraction || 0);
      starView.glow.material.opacity = tg * tg * (3 - 2 * tg) * (starView.glowExt ?? 1);
    }
    for (const p of [...sys.planets, ...sys.compactObjects]) {
      p.group.position.copy(p.posUniv).sub(camPos);
      p.updateVisual?.(performance.now() * 0.001);
    }
    for (const site of sys.artificialSites || []) {
      if (!site.parentBody) site.group.position.copy(site.posUniv).sub(camPos);
    }
  }

  updateRelative(camPos) {
    this.relativizeSystem(this.system, camPos);
    if (this.fadingSystem) this.relativizeSystem(this.fadingSystem, camPos);
    if (this.nearStarsMesh) this.nearStarsMesh.position.copy(camPos).negate();
    if (this.backdropMesh) this.backdropMesh.position.copy(camPos).negate();
    // nebula/band opacity = star dimming × (for the band PLANES) an edge-on
    // fade — an additive plane viewed edge-on concentrates into a hard
    // bright line slicing the sky
    const dim = 1 - (this._starDim || 0);
    for (const n of this.nebulas.children) {
      if (n.userData.baseOp === undefined) n.userData.baseOp = n.material.opacity;
      let k = 1;
      if (n.isMesh) {
        _v.copy(n.position).sub(camPos).normalize();
        _v2.set(0, 0, 1).applyQuaternion(n.quaternion);
        const face = Math.abs(_v.dot(_v2));
        k = face * face;
      }
      n.material.opacity = n.userData.baseOp * k * dim;
    }
  }

  // x: 0 in space → 1 with the sun on the horizon seen through atmosphere.
  // Extinction pulls the HDR disc under the bloom threshold and reddens it —
  // a horizon sun is an ember, not a flashbulb.
  setSunExtinction(x) {
    if (this.system) this.system.setSunExtinction(x);
    if (this.fadingSystem) this.fadingSystem.setSunExtinction(0);
  }

  setStarDimming(f) {
    // f: 0 in deep space -> 1 inside a bright daytime atmosphere
    // (nebula/band opacity is applied per-frame in updateRelative)
    if (this.starMaterial) this.starMaterial.uniforms.uDim.value = f;
    if (this.backdropMaterial) this.backdropMaterial.uniforms.uDim.value = f;
    this._starDim = f;
  }

  dispose() {
    if (this.fadingSystem) this.fadingSystem.dispose();
    this.fadingSystem = null;
    if (this.system) this.system.dispose();
    this.scene.remove(this.group, this.nebulas, this.backdropMesh);
    if (this.nearStarsMesh) {
      this.scene.remove(this.nearStarsMesh);
      this.nearStarsMesh.geometry.dispose();
    }
    if (this.starMaterial) this.starMaterial.dispose();
    if (this.backdropMesh) this.backdropMesh.geometry.dispose();
    if (this.backdropMaterial) this.backdropMaterial.dispose();
    const seenTex = new Set();
    for (const n of this.nebulas.children) {
      const tex = n.material.map;
      if (tex && tex !== this.glowTex && !seenTex.has(tex)) { seenTex.add(tex); tex.dispose(); }
      n.material.dispose();
      if (n.geometry) n.geometry.dispose();
    }
    this.glowTex.dispose();
    this.glowTexTight.dispose();
  }
}

// ============================================================================

export class StarSystem {
  constructor(universe, star, { deferred = false, fadeInPlanets = deferred, timeHours = 0 } = {}) {
    this.universe = universe;
    this.star = star;
    this.spec = applySystemBodyTuning(
      generateSystemSpec(universe.seed, star),
      (bodyId) => universe.bodyTuning?.(star.id, bodyId) || null,
    );
    this.name = this.spec.name;
    this.catalogId = this.spec.catalogId;
    this.isHome = this.spec.isHome;
    this.starViews = this.spec.stars.map((spec) => {
      const group = new THREE.Group();
      const color = new THREE.Color().fromArray(blackbodyLinearRgb(spec.temperatureK));
      const material = new THREE.MeshBasicMaterial({ color: color.clone().multiplyScalar(4), fog: false });
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(spec.radiusRender, 48, 32), material);
      group.add(mesh);
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: universe.glowTexTight, color: color.clone().lerp(new THREE.Color(0xffffff), 0.3),
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      }));
      glow.scale.setScalar(spec.radiusRender * 7); group.add(glow);
      const light = new THREE.PointLight(color, 3.2, 0, 0);
      universe.group.add(group, light);
      return { spec, group, mesh, glow, light, baseColor: material.color.clone(), glowBase: glow.material.color.clone(), glowExt: 1, positionUniv: star.pos.clone() };
    });
    const primary = this.starViews[0];
    this.sunGroup = primary.group; this.sunMesh = primary.mesh; this.sunGlow = primary.glow; this.sunLight = primary.light;
    this.sunBaseC = primary.baseColor; this.glowBaseC = primary.glowBase; this.glowExt = 1;
    this._ext = -1;
    this.planets = [];
    this.compactObjects = [];
    this._specs = [...this.spec.bodies, ...(this.spec.compactObjects || [])];
    this.frames = new Map(this._specs.map((body) => [body.bodyId, new BodyFrame(body)]));
    this.bodyById = new Map();
    this.artificialSites = [];
    this._civilizationBuilt = false;
    this._buildIdx = 0;
    this._deferred = deferred;
    this._fadeInPlanets = fadeInPlanets;
    this.updateCelestial(timeHours);
    if (!deferred) while (this.buildNext());
  }

  get built() { return this._buildIdx >= this._specs.length; }

  buildNext() {
    if (this.built) return false;
    const s = this._specs[this._buildIdx++];
    const frame = this.frames.get(s.bodyId);
    if (s.type === 'blackHole') {
      const blackHole = new BlackHole({ spec: s, posUniv: frame.position, fadeIn: this._fadeInPlanets });
      blackHole.orbit = s.orbit;
      blackHole.orbitPeriodHours = s.orbit.periodHours;
      blackHole.positionAt = (time, out = new THREE.Vector3()) => this.positionAt(s.bodyId, time, out);
      blackHole.velocityAt = (time, out = new THREE.Vector3()) => this.velocityAt(s.bodyId, time, out);
      blackHole.frameVelocity.copy(frame.velocity);
      this.compactObjects.push(blackHole);
      this.bodyById.set(s.bodyId, blackHole);
      this.universe.group.add(blackHole.group);
      if (this.built) this.buildCivilization();
      return !this.built;
    }
    const Ctor = s.type === 'gasGiant' || s.type === 'iceGiant' ? GasGiant : Planet;
    const planet = new Ctor({
      seed: s.seed, name: s.name, catalogName: s.catalogName,
      posUniv: frame.position, type: s.type, isMoon: s.isMoon, radius: s.radius,
      atmosphere: s.atmosphere, clouds: s.clouds,
      fadeIn: this._fadeInPlanets, sunDir: this.sunDirFrom(frame.position, _v).clone(),
      tuning: this.universe.bodyTuning?.(this.star.id, s.bodyId) || null,
      formation: s.formation, ringSystem: s.ringSystem,
    });
    planet.bodyId = s.bodyId; planet.catalogName = s.catalogName; planet.properName = s.properName;
    planet.orbit = s.orbit; planet.rotationPeriodHours = s.rotationPeriodHours;
    planet.orbitPeriodHours = s.orbit.periodHours; planet.axialTilt = s.axialTilt;
    planet.equilibriumK = s.equilibriumK; planet.landable = s.landable; planet.frameVelocity = frame.velocity.clone();
    planet.spec = s;
    planet.positionAt = (time, out = new THREE.Vector3()) => this.positionAt(s.bodyId, time, out);
    planet.velocityAt = (time, out = new THREE.Vector3()) => this.velocityAt(s.bodyId, time, out);
    planet.orientationAt = (time, out = new THREE.Quaternion()) => bodyOrientationAt(s, time, out);
    planet.orbitIndex = s.orbitIndex;
    if (s.parentId) planet.parentPlanet = this.bodyById.get(s.parentId) || null;
    planet.setFrame(frame.orientation);
    planet.setStellarLights?.(this.stellarLightFieldFrom(frame.position));
    this.planets.push(planet);
    this.bodyById.set(s.bodyId, planet);
    this.universe.group.add(planet.group);
    if (this.built) this.buildCivilization();
    return !this.built;
  }

  buildCivilization() {
    if (this._civilizationBuilt) return;
    this._civilizationBuilt = true;
    const records = civilizationSitesForSystem(this.universe.civilizationSites, this.star.id);
    for (const site of records) {
      let body = site.bodyId ? this.bodyById.get(site.bodyId) || null : null;
      if (site.type === 'hero-floating-city' && body?.isGasGiant) {
        const normal = new THREE.Vector3(...site.landingZone.normal).normalize();
        const offset = normal.multiplyScalar(body.R + body.atmoHeight * 0.52);
        const position = body.localPositionToWorld(offset, new THREE.Vector3());
        const habitat = new ArtificialHabitat(site, body, position, body.frameOrientation);
        habitat.parentOffset = offset;
        habitat.frameVelocity.copy(body.frameVelocity);
        this.planets.push(habitat);
        this.bodyById.set(habitat.bodyId, habitat);
        this.universe.group.add(habitat.group);
        body = habitat;
      }
      const visual = createCivilizationVisual(site, body);
      const entry = { site, group: visual, parentBody: body, posUniv: this.star.pos.clone() };
      if (body) {
        body.group.add(visual);
        body.civilizationSite = site;
        body.civilizationVisual = visual;
      } else {
        const angle = (site.id.charCodeAt(site.id.length - 1) % 13) / 13 * Math.PI * 2;
        entry.posUniv.add(new THREE.Vector3(
          Math.cos(angle) * 2.4e8,
          Math.sin(angle * 1.7) * 4e7,
          Math.sin(angle) * 2.4e8,
        ));
        this.universe.group.add(visual);
      }
      this.artificialSites.push(entry);
    }
  }

  positionAt(bodyId, timeHours, out = new THREE.Vector3()) {
    const spec = this._specs.find((body) => body.bodyId === bodyId);
    if (!spec) return out.copy(this.star.pos);
    orbitalPosition(spec.orbit, timeHours, out);
    if (spec.parentId) out.add(this.positionAt(spec.parentId, timeHours, new THREE.Vector3()));
    else out.add(this.star.pos);
    return out;
  }

  velocityAt(bodyId, timeHours, out = new THREE.Vector3()) {
    const spec = this._specs.find((body) => body.bodyId === bodyId);
    if (!spec) return out.set(0, 0, 0);
    orbitalVelocity(spec.orbit, timeHours, out);
    if (spec.parentId) out.add(this.velocityAt(spec.parentId, timeHours, new THREE.Vector3()));
    return out;
  }

  updateCelestial(timeHours) {
    if (this.spec.isBlackHoleSystem) {
      for (const view of this.starViews) {
        orbitalPosition(view.spec.orbit, timeHours, view.positionUniv).add(this.star.pos);
      }
    } else if (this.starViews.length === 1) {
      this.starViews[0].positionUniv.copy(this.star.pos);
    } else {
      const separation = orbitalPosition(this.spec.binaryOrbit, timeHours, _v);
      const a = this.starViews[0], b = this.starViews[1];
      const total = a.spec.massSolar + b.spec.massSolar;
      a.positionUniv.copy(this.star.pos).addScaledVector(separation, -b.spec.massSolar / total);
      b.positionUniv.copy(this.star.pos).addScaledVector(separation, a.spec.massSolar / total);
    }
    for (const spec of this._specs) {
      const frame = this.frames.get(spec.bodyId);
      const parentFrame = spec.parentId ? this.frames.get(spec.parentId) : null;
      frame.update(timeHours, parentFrame ? parentFrame.position : this.star.pos, parentFrame ? parentFrame.velocity : null);
      const body = this.bodyById.get(spec.bodyId);
      if (!body) continue;
      body.posUniv.copy(frame.position); body.frameVelocity.copy(frame.velocity);
      body.setFrame(frame.orientation);
      body.setStellarLights?.(this.stellarLightFieldFrom(body.posUniv));
      body.setWeatherTime?.(timeHours);
    }
    for (const habitat of this.planets.filter((body) => body instanceof ArtificialHabitat)) {
      habitat.followParent();
    }
  }

  setSunExtinction(x) {
    if (Math.abs(x - this._ext) < 0.004) return;   // colors only change on need
    this._ext = x;
    for (const view of this.starViews) {
      view.mesh.material.color.copy(view.baseColor).multiplyScalar(1 - 0.82 * x)
        .lerp(_extC.setRGB(1.35, 0.42, 0.12), x * 0.75);
      view.glow.material.color.copy(view.glowBase).lerp(_extC.setRGB(1.0, 0.45, 0.18), x * 0.8);
      view.glowExt = 1 - 0.75 * x;
    }
  }

  sunDirFrom(pos, out) {
    return out.copy(this.dominantStarFrom(pos).positionUniv).sub(pos).normalize();
  }

  stellarLightFieldFrom(pos, visibility = null) {
    return buildStellarLightField(this.starViews.map((view, index) => ({
      id: view.spec.starId || `${this.catalogId}:star-${index}`,
      positionUniv: view.positionUniv,
      luminositySolar: view.spec.luminositySolar,
      temperatureK: view.spec.temperatureK,
      visibility: Array.isArray(visibility) ? visibility[index] ?? 1 : 1,
    })), pos);
  }

  dominantStarFrom(pos) {
    let best = this.starViews[0], bestFlux = -Infinity;
    for (const view of this.starViews) {
      const d2 = Math.max(1, view.positionUniv.distanceToSquared(pos));
      const flux = view.spec.luminositySolar / d2;
      if (flux > bestFlux) { bestFlux = flux; best = view; }
    }
    return best;
  }

  dispose() {
    for (const site of this.artificialSites) {
      if (!site.parentBody) {
        this.universe.group.remove(site.group);
        disposeCivilizationVisual(site.group);
      }
    }
    for (const p of this.planets) {
      this.universe.group.remove(p.group);
      p.dispose();
    }
    for (const view of this.starViews) {
      this.universe.group.remove(view.group, view.light);
      view.mesh.geometry.dispose(); view.mesh.material.dispose(); view.glow.material.dispose();
    }
    for (const object of this.compactObjects) {
      this.universe.group.remove(object.group);
      object.dispose();
    }
  }
}
