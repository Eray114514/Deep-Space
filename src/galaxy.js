// The universe: an infinite lattice of procedurally placed star systems.
// Only the current system is fully instantiated (sun + planets + moons);
// every other star is a clickable point of light whose system will be
// generated, identically every time, from its lattice coordinates.

import * as THREE from 'three';
import { makeRng, strHash32, hash3i, hashFloat } from './rng.js';
import { Planet, TYPES } from './planet.js';
import { systemName, planetName, moonName } from './names.js';

export const CELL = 900000;            // metres between star lattice cells
const STAR_PROB = 0.42;
const NEAR_CELLS = 3;                  // clickable star radius (in cells)

const STAR_CLASSES = [
  { c: 0xfff4e0, w: 4 },   // warm white
  { c: 0xffd9a0, w: 3 },   // yellow-orange
  { c: 0xffb070, w: 2 },   // orange
  { c: 0xff8060, w: 1.2 }, // red
  { c: 0xcfe0ff, w: 1.5 }, // blue-white
];

const _v = new THREE.Vector3();

function glowTexture(size = 128, inner = 0.0) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, size * 0.02, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.5, `rgba(255,255,255,${0.18 + inner})`);
  g.addColorStop(1, 'rgba(255,255,255,0)');
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
    this.buildSkybox();

    this.nearStarsMesh = null;
    this.nearStarsList = [];
    this.lastStarRebuild = new THREE.Vector3(Infinity, 0, 0);

    this.homeStar = this.starAt(0, 0, 0, true);
    this.system = null;
    this.setSystem(this.homeStar);
  }

  // Deterministic star lookup for a lattice cell. force=true for the home cell.
  starAt(ix, iy, iz, force = false) {
    const h = hash3i(ix, iy, iz, this.galaxySeed);
    if (!force && hashFloat(h, 0) > STAR_PROB) return null;
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
      radius: 4500 + hashFloat(h, 2) * 4500,
    };
  }

  buildSkybox() {
    const rand = makeRng(this.seed + ':skybox');
    const COUNT = 9000;
    const pos = new Float32Array(COUNT * 3);
    const col = new Float32Array(COUNT * 3);
    const RAD = 5.5e6;
    const bandQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(rand() * 1.2, rand() * 3, rand() * 1.2));
    for (let i = 0; i < COUNT; i++) {
      const inBand = rand() < 0.55;
      _v.set(rand() * 2 - 1, (rand() * 2 - 1) * (inBand ? 0.18 : 1), rand() * 2 - 1);
      if (_v.lengthSq() < 0.01) _v.x = 1;
      _v.normalize();
      if (inBand) _v.applyQuaternion(bandQ);
      pos[i * 3] = _v.x * RAD; pos[i * 3 + 1] = _v.y * RAD; pos[i * 3 + 2] = _v.z * RAD;
      const b = 0.35 + rand() * 0.65;
      const tint = rand();
      col[i * 3] = b * (tint < 0.12 ? 1.0 : tint < 0.24 ? 0.75 : 0.92);
      col[i * 3 + 1] = b * 0.9;
      col[i * 3 + 2] = b * (tint < 0.12 ? 0.75 : 1.0);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.skybox = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 1, depthWrite: false, fog: false,
    }));
    this.skybox.renderOrder = -10;
    this.skybox.frustumCulled = false;
    this.scene.add(this.skybox);

    // nebulae: big soft additive sprites at infinity
    this.nebulas = new THREE.Group();
    const nCount = 4 + ((rand() * 3) | 0);
    for (let i = 0; i < nCount; i++) {
      const mat = new THREE.SpriteMaterial({
        map: this.glowTex, transparent: true, opacity: 0.10 + rand() * 0.10,
        color: new THREE.Color().setHSL(rand(), 0.7, 0.55),
        blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
      });
      const spr = new THREE.Sprite(mat);
      _v.set(rand() * 2 - 1, (rand() * 2 - 1) * 0.5, rand() * 2 - 1).normalize().multiplyScalar(4.5e6);
      spr.position.copy(_v);
      const s = (1.2 + rand() * 2.2) * 1.8e6;
      spr.scale.set(s, s, 1);
      this.nebulas.add(spr);
    }
    this.nebulas.renderOrder = -9;
    this.scene.add(this.nebulas);
  }

  setSystem(star) {
    if (this.system) this.system.dispose();
    this.system = new StarSystem(this, star);
    this.rebuildNearStars(star.pos);
    return this.system;
  }

  rebuildNearStars(camPos) {
    this.lastStarRebuild.copy(camPos);
    const cx = Math.round(camPos.x / CELL), cy = Math.round(camPos.y / (CELL * 0.5)), cz = Math.round(camPos.z / CELL);
    const list = [];
    for (let dz = -NEAR_CELLS; dz <= NEAR_CELLS; dz++) {
      for (let dy = -NEAR_CELLS; dy <= NEAR_CELLS; dy++) {
        for (let dx = -NEAR_CELLS; dx <= NEAR_CELLS; dx++) {
          const s = this.starAt(cx + dx, cy + dy, cz + dz);
          if (s && s.id !== this.system.star.id) list.push(s);
        }
      }
    }
    this.nearStarsList = list;

    if (this.nearStarsMesh) {
      this.scene.remove(this.nearStarsMesh);
      this.nearStarsMesh.geometry.dispose();
      this.nearStarsMesh.material.dispose();
    }
    const pos = new Float32Array(list.length * 3);
    const col = new Float32Array(list.length * 3);
    list.forEach((s, i) => {
      pos[i * 3] = s.pos.x; pos[i * 3 + 1] = s.pos.y; pos[i * 3 + 2] = s.pos.z;
      col[i * 3] = s.color.r; col[i * 3 + 1] = s.color.g; col[i * 3 + 2] = s.color.b;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.nearStarsMesh = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 5, sizeAttenuation: false, vertexColors: true, map: this.glowTex,
      transparent: true, depthWrite: false, fog: false,
    }));
    this.nearStarsMesh.frustumCulled = false;
    this.nearStarsMesh.renderOrder = -8;
    this.scene.add(this.nearStarsMesh);
  }

  // ray pick a distant star (by angular proximity)
  pickStar(origin, dir) {
    let best = null, bestAng = 0.018;
    for (const s of this.nearStarsList) {
      _v.copy(s.pos).sub(origin);
      const dist = _v.length();
      const ang = _v.normalize().angleTo(dir);
      if (ang < bestAng && dist > 60000) { bestAng = ang; best = s; }
    }
    return best;
  }

  update(camPos) {
    if (camPos.distanceTo(this.lastStarRebuild) > CELL * 0.5) {
      this.rebuildNearStars(camPos);
    }
  }

  // camera-relative placement: camera sits at scene origin, the universe moves
  updateRelative(camPos) {
    const sys = this.system;
    sys.sunGroup.position.copy(sys.star.pos).sub(camPos);
    sys.sunLight.position.copy(sys.sunGroup.position);
    for (const p of sys.planets) {
      p.group.position.copy(p.posUniv).sub(camPos);
    }
    if (this.nearStarsMesh) this.nearStarsMesh.position.copy(camPos).negate();
  }

  setStarDimming(f) {
    // f: 0 in deep space -> 1 inside a bright daytime atmosphere
    this.skybox.material.opacity = 1 - f * 0.97;
    if (this.nearStarsMesh) this.nearStarsMesh.material.opacity = 1 - f * 0.9;
    for (const n of this.nebulas.children) {
      n.material.opacity = n.userData.baseOp === undefined
        ? (n.userData.baseOp = n.material.opacity)
        : n.userData.baseOp * (1 - f);
    }
  }

  dispose() {
    if (this.system) this.system.dispose();
    this.scene.remove(this.group, this.skybox, this.nebulas);
    if (this.nearStarsMesh) {
      this.scene.remove(this.nearStarsMesh);
      this.nearStarsMesh.geometry.dispose();
      this.nearStarsMesh.material.dispose();
    }
    this.skybox.geometry.dispose();
    this.skybox.material.dispose();
    for (const n of this.nebulas.children) n.material.dispose();
    this.glowTex.dispose();
  }
}

// ============================================================================

export class StarSystem {
  constructor(universe, star) {
    this.universe = universe;
    this.star = star;
    const rand = makeRng(universe.seed + ':sys:' + star.id);
    this.name = systemName(rand);
    this.isHome = star.id === '0,0,0';

    // --- the sun ---
    this.sunGroup = new THREE.Group();
    const sunMat = new THREE.MeshBasicMaterial({ color: star.color, fog: false });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(star.radius, 48, 32), sunMat);
    this.sunGroup.add(this.sunMesh);
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: universe.glowTex, color: star.color.clone().lerp(new THREE.Color(0xffffff), 0.3),
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
    }));
    glow.scale.setScalar(star.radius * 14);
    this.sunGroup.add(glow);
    this.sunLight = new THREE.PointLight(0xffffff, 3.2, 0, 0);
    this.sunLight.color.copy(star.color.clone().lerp(new THREE.Color(0xffffff), 0.7));
    universe.group.add(this.sunGroup, this.sunLight);

    // --- planets ---
    this.planets = [];
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
      const orbit = 30000 * Math.pow(1.42, i) * (0.85 + rand() * 0.3);
      const ang = rand() * Math.PI * 2;
      const incl = (rand() - 0.5) * 0.35;
      const pos = new THREE.Vector3(
        Math.cos(ang) * orbit,
        Math.sin(incl) * orbit * 0.5,
        Math.sin(ang) * orbit,
      ).add(star.pos);

      const type = (i === 0 && this.isHome) ? 'lush' : pickType();
      const name = planetName(rand, this.name, i);
      const planet = new Planet({
        seed: universe.seed + ':p:' + star.id + ':' + i,
        name, posUniv: pos, type,
      });
      planet.orbitIndex = i;
      planet.setSunDir(_v.copy(star.pos).sub(pos).normalize());
      this.planets.push(planet);
      universe.group.add(planet.group);

      // occasional moon
      if (rand() < 0.28 && planet.R > 1500) {
        const mAng = rand() * Math.PI * 2;
        const mPos = new THREE.Vector3(
          Math.cos(mAng), (rand() - 0.5) * 0.5, Math.sin(mAng),
        ).normalize().multiplyScalar(planet.R * (5 + rand() * 3)).add(pos);
        const mType = pickType();
        const moon = new Planet({
          seed: universe.seed + ':m:' + star.id + ':' + i,
          name: moonName(rand, name), posUniv: mPos, type: mType, isMoon: true,
        });
        moon.orbitIndex = i;
        moon.parentPlanet = planet;
        moon.setSunDir(_v.copy(star.pos).sub(mPos).normalize());
        this.planets.push(moon);
        universe.group.add(moon.group);
      }
    }
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
