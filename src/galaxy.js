// The universe: an infinite lattice of procedurally placed star systems.
// Only the current system is fully instantiated (sun + planets + moons);
// every other star is a clickable point of light whose system will be
// generated, identically every time, from its lattice coordinates.

import * as THREE from 'three';
import { makeRng, strHash32, hash3i, hashFloat } from './rng.js';
import { clamp } from './noise.js';
import { Planet, TYPES } from './planet.js';
import { systemName, planetName, moonName } from './names.js';

export const CELL = 6e7;               // metres between star lattice cells
const STAR_PROB = 0.42;
// the visible star field: a galactic disc (dense) with a sparse halo above
// and below — every rendered dot is a real, warpable system
const FIELD_XZ = 22;                   // cells of radius in the disc plane
const DISC_Y = 6;                      // dense disc half-thickness (cells)
const HALO_Y = 30;                     // sparse halo half-thickness (cells)
const HALO_PROB = 0.10;                // halo keeps this fraction of stars

// seamless interstellar flight: approaching a star instantiates its system
// while its planets are still sub-pixel; the system you leave lingers until
// it is genuinely out of sight
const APPROACH_DIST = 1.2e8;
const FADE_DIST = 1.5e8;

const STAR_CLASSES = [
  { c: 0xfff4e0, w: 4 },   // warm white
  { c: 0xffd9a0, w: 3 },   // yellow-orange
  { c: 0xffb070, w: 2 },   // orange
  { c: 0xff8060, w: 1.2 }, // red
  { c: 0xcfe0ff, w: 1.5 }, // blue-white
];

const _v = new THREE.Vector3();

// Every star in the sky is a real lattice star. Apparent size and brightness
// fall off with true distance (computed in view space, where the f64 group
// offset has already been applied).
function makeStarPointsMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      uDim: { value: 0 },               // 1 inside a bright daytime atmosphere
      uPixelRatio: { value: Math.min(typeof window !== 'undefined' ? window.devicePixelRatio : 1, 2) },
      uProj: { value: 600 },            // height / (2·tan(fov/2)) — set by main
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
        // a star's sprite tracks the TRUE angular size of its sun
        // (radius = aSize * 3e5 m), so flying close resolves the dot into
        // the same disc the real sun mesh has when the system instantiates
        float discPx = 2.0 * 3.0e5 * aSize * uProj / dist;
        gl_PointSize = clamp(max(2.2 * aSize, discPx), 2.2, 34.0) * uPixelRatio;
        // apparent magnitude falls with distance; only the very edge fades out
        vBright = clamp(3.0e8 / dist, 0.5, 1.0)
                * (1.0 - smoothstep(1.15e9, 1.38e9, dist));
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

export class Universe {
  constructor(seedStr, scene) {
    this.seed = seedStr;
    this.scene = scene;
    this.galaxySeed = strHash32(seedStr + ':galaxy');
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

    this.homeStar = this.starAt(0, 0, 0, true);
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

  // Deterministic star lookup for a lattice cell. force=true for the home cell.
  starAt(ix, iy, iz, force = false) {
    const h = hash3i(ix, iy, iz, this.galaxySeed);
    // above/below the galactic disc only a sparse halo of stars survives
    const prob = STAR_PROB * (Math.abs(iy) > DISC_Y ? HALO_PROB : 1);
    if (!force && hashFloat(h, 0) > prob) return null;
    const pos = new THREE.Vector3(
      (ix + 0.12 + hashFloat(h, 0) * 0.76) * CELL,
      (iy + 0.12 + hashFloat(h, 1) * 0.76) * CELL * 0.5,   // flattened disc feel
      (iz + 0.12 + hashFloat(h, 2) * 0.76) * CELL,
    );
    let wsum = 0; for (const s of STAR_CLASSES) wsum += s.w;
    let pickv = (hashFloat(h, 1) * 0.999) * wsum, color = STAR_CLASSES[0].c;
    for (const s of STAR_CLASSES) { pickv -= s.w; if (pickv <= 0) { color = s.c; break; } }
    return {
      id: `${ix},${iy},${iz}`,
      ix, iy, iz, pos,
      color: new THREE.Color(color),
      radius: 2e5 + hashFloat(h, 2) * 2e5,
    };
  }

  buildSkybox() {
    const rand = makeRng(this.seed + ':skybox');
    // nebulae: big soft additive sprites at infinity (purely scenery — unlike
    // the stars, which are all real places)
    this.nebulas = new THREE.Group();
    const nCount = 4 + ((rand() * 3) | 0);
    for (let i = 0; i < nCount; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTex, transparent: true, opacity: 0.10 + rand() * 0.10,
        color: new THREE.Color().setHSL(rand(), 0.7, 0.55),
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const spr = new THREE.Sprite(mat);
      _v.set(rand() * 2 - 1, (rand() * 2 - 1) * 0.5, rand() * 2 - 1).normalize().multiplyScalar(1.8e9);
      spr.position.copy(_v);
      const s = (1.2 + rand() * 2.2) * 6.5e8;
      spr.scale.set(s, s, 1);
      this.nebulas.add(spr);
    }
    // the Milky Way: a faint glowing band along the galactic disc plane
    const bandTilt = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((rand() - 0.5) * 0.35, 0, (rand() - 0.5) * 0.35));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(1.6e9, 4.5e8),
        new THREE.MeshBasicMaterial({
          map: this.glowTex, transparent: true, opacity: 0.045 + rand() * 0.035,
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
    this.system = new StarSystem(this, star, { deferred });
    this.rebuildNearStars(star.pos);
    if (this.onSystemChange) this.onSystemChange(this.system);
    return this.system;
  }

  disposeFading() {
    if (!this.fadingSystem) return;
    if (this.onBeforeSystemDispose && this.onBeforeSystemDispose(this.fadingSystem) === false) return;
    this.fadingSystem.dispose();
    this.fadingSystem = null;
  }

  // Gather every real star around the camera — the entire night sky.
  // Dense galactic disc + sparse halo, ~15–18k stars, all warpable.
  rebuildNearStars(camPos) {
    this.lastStarRebuild.copy(camPos);
    const cx = Math.round(camPos.x / CELL);
    const cy = Math.round(camPos.y / (CELL * 0.5));
    const cz = Math.round(camPos.z / CELL);
    const list = [];
    for (let dz = -FIELD_XZ; dz <= FIELD_XZ; dz++) {
      for (let dy = -HALO_Y; dy <= HALO_Y; dy++) {
        for (let dx = -FIELD_XZ; dx <= FIELD_XZ; dx++) {
          const s = this.starAt(cx + dx, cy + dy, cz + dz);
          if (s && s.id !== this.system.star.id) list.push(s);
        }
      }
    }
    this.nearStarsList = list;
    // stars worth proximity-checking every frame for manual approach
    this.candidates = list.filter((s) => s.pos.distanceTo(camPos) < 3.5e8);

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
      siz[i] = s.radius / 3e5;           // 0.66..1.33 apparent-size jitter
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
      if (dist < 4e6) continue;
      const ang = _v.normalize().angleTo(dir);
      const limit = dist < 3e8 ? 0.018 : 0.008;
      if (ang < limit && ang < bestAng) { bestAng = ang; best = s; }
    }
    return best;
  }

  update(camPos, allowSwap = false) {
    this.camPos.copy(camPos);
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
    sys.sunGroup.position.copy(sys.star.pos).sub(camPos);
    sys.sunLight.position.copy(sys.sunGroup.position);
    const d = camPos.distanceTo(sys.star.pos);
    // each sun lights its own neighbourhood; it fades for a camera leaving it
    sys.sunLight.intensity = 3.2 * clamp((FADE_DIST - d) / 5e7, 0, 1);
    // the corona blooms only on approach: from afar the sun mesh is the same
    // small disc as its star sprite, so the handoff has nothing to pop
    const tg = clamp((1.1e8 - d) / 5e7, 0, 1);
    sys.sunGlow.material.opacity = tg * tg * (3 - 2 * tg);
    for (const p of sys.planets) {
      p.group.position.copy(p.posUniv).sub(camPos);
    }
  }

  updateRelative(camPos) {
    this.relativizeSystem(this.system, camPos);
    if (this.fadingSystem) this.relativizeSystem(this.fadingSystem, camPos);
    if (this.nearStarsMesh) this.nearStarsMesh.position.copy(camPos).negate();
  }

  setStarDimming(f) {
    // f: 0 in deep space -> 1 inside a bright daytime atmosphere
    if (this.starMaterial) this.starMaterial.uniforms.uDim.value = f;
    for (const n of this.nebulas.children) {
      n.material.opacity = n.userData.baseOp === undefined
        ? (n.userData.baseOp = n.material.opacity)
        : n.userData.baseOp * (1 - f);
    }
  }

  dispose() {
    if (this.fadingSystem) this.fadingSystem.dispose();
    this.fadingSystem = null;
    if (this.system) this.system.dispose();
    this.scene.remove(this.group, this.nebulas);
    if (this.nearStarsMesh) {
      this.scene.remove(this.nearStarsMesh);
      this.nearStarsMesh.geometry.dispose();
    }
    if (this.starMaterial) this.starMaterial.dispose();
    for (const n of this.nebulas.children) {
      n.material.dispose();
      if (n.geometry) n.geometry.dispose();
    }
    this.glowTex.dispose();
    this.glowTexTight.dispose();
  }
}

// ============================================================================

export class StarSystem {
  constructor(universe, star, { deferred = false } = {}) {
    this.universe = universe;
    this.star = star;
    const rand = makeRng(universe.seed + ':sys:' + star.id);
    this.name = systemName(rand);
    this.isHome = star.id === '0,0,0';

    // --- the sun ---
    this.sunGroup = new THREE.Group();
    // HDR disc: values above 1 make bloom do the blowout, and screen-space
    // bloom is properly occluded by planets — no giant sprite to wash them
    const sunMat = new THREE.MeshBasicMaterial({
      color: star.color.clone().multiplyScalar(4), fog: false,
    });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(star.radius, 48, 32), sunMat);
    this.sunGroup.add(this.sunMesh);
    this.sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: universe.glowTexTight, color: star.color.clone().lerp(new THREE.Color(0xffffff), 0.3),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    this.sunGlow.scale.setScalar(star.radius * 7);
    this.sunGroup.add(this.sunGlow);
    this.sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0);
    this.sunLight.color.copy(star.color.clone().lerp(new THREE.Color(0xffffff), 0.7));
    universe.group.add(this.sunGroup, this.sunLight);

    // --- planets ---
    this.planets = [];
    this._specs = [];
    const count = (this.isHome ? 6 : 5) + ((rand() * 4) | 0);
    const weights = {};
    for (const k of Object.keys(TYPES)) weights[k] = TYPES[k].weight;

    const pickType = () => {
      let total = 0; for (const k in weights) total += weights[k];
      let r = rand() * total;
      for (const k in weights) {
        r -= weights[k];
        if (r <= 0) { weights[k] *= 0.3; return k; }   // discourage repeats
      }
      return 'lush';
    };

    for (let i = 0; i < count; i++) {
      // truly interplanetary spacing: hundreds of planet-radii between
      // worlds, capped so outer orbits stay inside the system's bubble
      const orbit = Math.min(9e5 * Math.pow(1.5, i) * (0.85 + rand() * 0.3), 1.25e7);
      const ang = rand() * Math.PI * 2;
      const incl = (rand() - 0.5) * 0.35;
      const pos = new THREE.Vector3(
        Math.cos(ang) * orbit,
        Math.sin(incl) * orbit * 0.5,
        Math.sin(ang) * orbit,
      ).add(star.pos);

      const type = (i === 0 && this.isHome) ? 'lush' : pickType();
      const name = planetName(rand, this.name, i);
      const seed = universe.seed + ':p:' + star.id + ':' + i;
      this._specs.push({ seed, name, pos, type, isMoon: false, orbitIndex: i, parentSpec: -1 });

      // occasional moon — the parent's radius is its seed-rng's first draw
      // (mirrors Planet's constructor so specs need no Planet instance)
      const parentR = 30000 + makeRng(seed)() * 90000;
      if (rand() < 0.28 && parentR > 55000) {
        const mAng = rand() * Math.PI * 2;
        const mPos = new THREE.Vector3(
          Math.cos(mAng), (rand() - 0.5) * 0.5, Math.sin(mAng),
        ).normalize().multiplyScalar(parentR * (3 + rand() * 2)).add(pos);
        const mType = pickType();
        this._specs.push({
          seed: universe.seed + ':m:' + star.id + ':' + i,
          name: moonName(rand, name), pos: mPos, type: mType,
          isMoon: true, orbitIndex: i, parentSpec: this._specs.length - 1,
        });
      }
    }

    // a deferred system materializes one planet per call (mid-warp); a normal
    // one is complete on construction
    this._buildIdx = 0;
    this._deferred = deferred;
    if (!deferred) while (this.buildNext());
  }

  get built() { return this._buildIdx >= this._specs.length; }

  buildNext() {
    if (this.built) return false;
    const s = this._specs[this._buildIdx++];
    const planet = new Planet({
      seed: s.seed, name: s.name, posUniv: s.pos, type: s.type, isMoon: s.isMoon,
      fadeIn: this._deferred,
    });
    planet.orbitIndex = s.orbitIndex;
    if (s.parentSpec >= 0) planet.parentPlanet = this.planets[s.parentSpec];
    planet.setSunDir(_v.copy(this.star.pos).sub(s.pos).normalize());
    this.planets.push(planet);
    this.universe.group.add(planet.group);
    return !this.built;
  }

  sunDirFrom(pos, out) {
    return out.copy(this.star.pos).sub(pos).normalize();
  }

  dispose() {
    for (const p of this.planets) {
      this.universe.group.remove(p.group);
      p.dispose();
    }
    this.universe.group.remove(this.sunGroup, this.sunLight);
    this.sunMesh.geometry.dispose();
    this.sunMesh.material.dispose();
    for (const c of this.sunGroup.children) {
      if (c.material && c.material !== this.sunMesh.material) c.material.dispose();
    }
  }
}
