// Planet: a fully procedural world defined by ONE seeded height function and
// ONE color function over unit-sphere directions. Terrain chunks at every LOD,
// the walking controller, the landing logic and the scatter system all sample
// these same functions — which is what keeps a planet consistent whether it is
// a dot across the system or the ground under your feet.

import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { Simplex, worley3, clamp, lerp, smoothstep } from './noise.js';
import { ChunkedLOD, GRID_CELLS } from './quadtree.js';
import { applyTerrainDetail, applyWaterWaves, applyCloudField, cloudDensityCPU } from './shaders.js';

export const TYPES = {
  lush:   { label: 'Lush',      weight: 3.0, relief: 0.034, liquid: 'water', seaQ: -0.05, atmo: 0x69b4ff, sky: 0x7fc3ff, atmoDensity: 1.0, clouds: 0.62 },
  ocean:  { label: 'Oceanic',   weight: 2.0, relief: 0.020, liquid: 'water', seaQ: 0.30,  atmo: 0x55aaff, sky: 0x6fb9ff, atmoDensity: 1.0, clouds: 0.7 },
  desert: { label: 'Desert',    weight: 2.0, relief: 0.040, liquid: null,    seaQ: null,  atmo: 0xffc380, sky: 0xf7c089, atmoDensity: 0.85, clouds: 0.15 },
  ice:    { label: 'Frozen',    weight: 2.0, relief: 0.030, liquid: 'ice',   seaQ: 0.05,  atmo: 0xbfdfff, sky: 0xcfe5ff, atmoDensity: 0.9, clouds: 0.3 },
  lava:   { label: 'Volcanic',  weight: 1.4, relief: 0.038, liquid: 'lava',  seaQ: -0.42, atmo: 0xff8a50, sky: 0xb96a4a, atmoDensity: 0.7, clouds: 0 },
  barren: { label: 'Barren',    weight: 1.8, relief: 0.042, liquid: null,    seaQ: null,  atmo: 0x9aa3a8, sky: 0x6f7a80, atmoDensity: 0.25, clouds: 0 },
  toxic:  { label: 'Toxic',     weight: 1.4, relief: 0.032, liquid: 'toxic', seaQ: 0.02,  atmo: 0xa9e84e, sky: 0x9fd455, atmoDensity: 0.95, clouds: 0.3 },
  exotic: { label: 'Exotic',    weight: 1.0, relief: 0.046, liquid: null,    seaQ: null,  atmo: 0xe87ae8, sky: 0xd98ae0, atmoDensity: 0.8, clouds: 0.12 },
};

const _c = new THREE.Color();

function col(hex) { return new THREE.Color(hex); }

function jitterColor(c, rand, dh, ds, dl) {
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL(
    (hsl.h + dh + 1) % 1,
    clamp(hsl.s * ds, 0, 1),
    clamp(hsl.l * dl, 0.02, 0.98),
  );
  return c;
}

function stops(arr) {
  // arr: [[t, hexOrColor], ...] -> sorted stop list with THREE.Color
  return arr.map(([t, c]) => ({ t, c: c instanceof THREE.Color ? c : col(c) }));
}

function sampleStops(st, t, out) {
  if (t <= st[0].t) return out.copy(st[0].c);
  for (let i = 1; i < st.length; i++) {
    if (t <= st[i].t) {
      const a = st[i - 1], b = st[i];
      return out.copy(a.c).lerp(b.c, (t - a.t) / Math.max(1e-6, b.t - a.t));
    }
  }
  return out.copy(st[st.length - 1].c);
}

export class Planet {
  constructor({ seed, name, posUniv, type, isMoon = false, radius = null, fadeIn = false }) {
    this.appear = fadeIn ? 0 : 1;   // planets born mid-flight fade in, never pop
    this.seed = seed;
    this.name = name;
    this.isMoon = isMoon;
    this.posUniv = posUniv.clone();
    const rand = makeRng(seed);
    this.rand = rand;
    this.intSeed = strHash32(seed);

    this.type = type;
    this.cfg = TYPES[type];

    // ---- dimensions: real worlds, tens of kilometres across ---------------
    const baseR = isMoon ? 8000 + rand() * 12000 : 30000 + rand() * 90000;
    this.R = radius || baseR;
    // relief grows with the world but tops out at alpine scale
    this.hAmp = Math.min(this.R * this.cfg.relief * (0.85 + rand() * 0.5), 2400 + rand() * 1200);
    this.gravity = 9.81 * clamp(this.R / 70000, 0.55, 1.5);
    this.atmoDensity = this.cfg.atmoDensity * (0.7 + rand() * 0.6);

    // ---- noise fields -----------------------------------------------------
    this.nA = new Simplex(makeRng(seed + ':A'));
    this.nB = new Simplex(makeRng(seed + ':B'));
    this.nC = new Simplex(makeRng(seed + ':C'));
    this.nD = new Simplex(makeRng(seed + ':D'));

    // ---- terrain parameters ----------------------------------------------
    this.contFreq = 1.1 + rand() * 1.5;
    this.contAmp = this.hAmp * 0.62;
    this.mountFreq = 4.5 + rand() * 4.0;
    this.mountAmp = this.hAmp * (0.55 + rand() * 0.45);
    this.detailFreq = 16 + rand() * 10;
    this.detailAmp = this.hAmp * 0.16;

    // ---- regional personality: planets are NOT the same everywhere -------
    // a very low-frequency field divides the world into provinces; each
    // landform reads it differently, so one hemisphere can be an alpine
    // belt while another is plains or terraced mesa country
    this.regFreq = 0.7 + rand() * 0.9;
    this.beltBias = (rand() - 0.5) * 0.5;           // how much of the world is rugged
    this.plainsCalm = 0.45 + rand() * 0.45;          // how flat the calm provinces are
    this.warpAmp = 0.22 + rand() * 0.5;              // domain warp breaks noise blobbiness
    this.warpFreq = 1.3 + rand() * 1.9;
    const mesaProne = type === 'desert' || type === 'barren' || type === 'exotic';
    this.plateauAmt = mesaProne ? 0.55 + rand() * 0.45 : (rand() < 0.3 ? 0.3 + rand() * 0.4 : 0);
    this.plateauH = this.hAmp * (0.22 + rand() * 0.2);

    // liquids
    this.liquid = this.cfg.liquid;
    this.hasLiquid = this.liquid !== null;
    this.seaLevel = this.hasLiquid ? this.cfg.seaQ * this.contAmp + (rand() - 0.5) * 0.1 * this.contAmp : -1e9;
    this.seaRadius = this.hasLiquid ? this.R + this.seaLevel : 0;
    // mountains grow from terrain above the waterline
    const seaC = this.hasLiquid ? this.seaLevel / this.contAmp : -0.25;
    this.mountMaskLo = seaC + 0.05;
    this.mountMaskHi = seaC + 0.45;

    // type extras
    this.craterAmp = 0; this.duneAmp = 0; this.canyonAmp = 0;
    this.blobAmp = 0; this.spikeAmp = 0;
    if (type === 'barren') { this.craterAmp = this.hAmp * 0.55; this.craterFreq = 5 + rand() * 3; }
    if (type === 'ice' && rand() < 0.5) { this.craterAmp = this.hAmp * 0.2; this.craterFreq = 7 + rand() * 4; }
    if (type === 'desert') {
      this.duneAmp = 2.2 + rand() * 2.5; this.duneFreq = 320 + rand() * 260;
      this.duneAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
      this.canyonAmp = this.hAmp * 0.5; this.canyonFreq = 2.6 + rand() * 1.6; this.canyonWidth = 0.07 + rand() * 0.05;
    }
    if (type === 'lush' || type === 'ocean' || type === 'toxic') {
      // rivers: channels carved below the waterline so they flood
      this.canyonAmp = this.hAmp * 0.42; this.canyonFreq = 3.0 + rand() * 1.8; this.canyonWidth = 0.05 + rand() * 0.035;
    }
    if (type === 'toxic') { this.blobAmp = this.hAmp * 0.3; this.blobFreq = 14 + rand() * 10; }
    if (type === 'exotic') {
      this.blobAmp = this.hAmp * 0.35; this.blobFreq = 9 + rand() * 7;
      this.spikeAmp = this.hAmp * (1.1 + rand() * 0.9); this.spikeFreq = 22 + rand() * 16;
      this.stripeFreq = 14 + rand() * 22;
      this.stripeAxis = new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize();
    }

    // LOD limits: finest cells ≈ 1.5 m even on 120 km worlds
    const rootCell = (Math.PI / 2) * this.R / GRID_CELLS;
    this.maxLevel = clamp(Math.round(Math.log2(rootCell / 1.5)), 4, 13);
    this.freqAtLevel = (lvl) => 0.4 * GRID_CELLS * Math.pow(2, lvl) / (Math.PI / 2);
    this.fullMaxFreq = this.freqAtLevel(this.maxLevel);

    // ---- palette ----------------------------------------------------------
    this.buildPalette(rand);

    // axis tilt (rings, clouds, stripes)
    this.axisQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler((rand() - 0.5) * 0.9, rand() * Math.PI * 2, (rand() - 0.5) * 0.9));

    // ---- scene objects ----------------------------------------------------
    this.group = new THREE.Group();
    this.group.name = 'planet:' + name;
    // no vertex colors: the palette is evaluated per-pixel in the shader
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      roughness: 1.0, metalness: 0.0,
    });
    // close-up grain (albedo + micro-normals): rocky worlds get more of it;
    // living worlds get stronger continental tint drift (dry-brown swathes)
    const detailK = { desert: 0.3, barren: 0.34, lava: 0.3, exotic: 0.26, ice: 0.18 }[type] ?? 0.22;
    const macroK = { lush: 0.5, ocean: 0.45, ice: 0.2, toxic: 0.35 }[type] ?? 0.3;
    applyTerrainDetail(this.terrainMaterial, this, detailK, macroK);
    this.lod = new ChunkedLOD(this);
    this.buildEffects(rand);
    this.cloudSpin = rand() * Math.PI * 2;

    // materials touched by the fade-in
    this._fades = [{ mat: this.terrainMaterial, base: 1 }];
    if (this.liquidMat) this._fades.push({ mat: this.liquidMat, base: this.liquidMat.opacity });
    if (this.cloudMesh) this._fades.push({ mat: this.cloudMesh.material, base: this.cloudMesh.material.opacity });
    if (this.ringMesh) this._fades.push({ mat: this.ringMesh.material, base: this.ringMesh.material.opacity });
    this._atmoBaseDensity = this.atmoMesh ? this.atmoMesh.material.uniforms.density.value : 0;
    if (this.appear < 1) this.applyAppear();
  }

  applyAppear() {
    const a = this.appear;
    for (const f of this._fades) {
      f.mat.opacity = f.base * a;
      f.mat.transparent = a < 1 || f.base < 1;
    }
    if (this.atmoMesh) this.atmoMesh.material.uniforms.density.value = this._atmoBaseDensity * a;
  }

  // ======================================================================
  // THE height function. dir must be a unit vector (planet-local).
  // maxFreq caps angular detail for LOD; features finer than the sampling
  // grid are skipped, everything coarser is identical at every LOD.
  // Returns meters relative to base radius R.
  // ======================================================================
  height(dir, maxFreq = 1e9) {
    const x = dir.x, y = dir.y, z = dir.z;

    // provinces: a very low-frequency field that decides the character of
    // each region (rugged belt vs calm plains). Constant across LODs.
    const reg = this.nD.fbm(x + 53.1, y - 17.7, z + 29.3, this.regFreq, 2, 0.5, 2.1, maxFreq);
    const belt = smoothstep(-0.32 + this.beltBias, 0.34 + this.beltBias, reg);

    // continents are sampled through a warped domain — kills the uniform
    // "simplex blob" look and gives coastlines real character
    const wf = this.warpFreq, wa = this.warpAmp;
    const ax = x + this.nB.noise(x * wf + 31.4, y * wf, z * wf) * wa;
    const ay = y + this.nB.noise(x * wf, y * wf + 47.2, z * wf) * wa;
    const az = z + this.nB.noise(x * wf, y * wf, z * wf + 71.7) * wa;
    const c = this.nA.fbm(ax, ay, az, this.contFreq, 4, 0.52, 2.05, maxFreq);
    let h = c * this.contAmp;

    // mountains/detail keep their first octave at every LOD (fractals cut
    // octaves internally) so the mean elevation never jumps between levels.
    // Ranges cluster into the rugged provinces instead of covering the globe.
    const mMask = smoothstep(this.mountMaskLo, this.mountMaskHi, c) * (0.12 + 0.88 * belt);
    if (mMask > 0.002) {
      const m = this.nB.ridged(x, y, z, this.mountFreq, 6, 0.55, 2.1, maxFreq);
      h += m * this.mountAmp * mMask;
    }

    {
      // eroded hillsides: rugged crests, smooth carved flanks —
      // rough in the belts, long calm plains elsewhere
      const d = this.nC.fbmEroded(x, y, z, this.detailFreq, 6, 0.5, 2.2, maxFreq, 3.2);
      h += d * this.detailAmp * 1.25 * (0.45 + 0.55 * mMask) * (1 - this.plainsCalm * (1 - belt));
    }

    // mesa country: whole provinces terraced into flat-topped plateaus
    if (this.plateauAmt > 0) {
      const pz = smoothstep(0.12, 0.5,
        this.nC.fbm(x - 91.7, y + 33.3, z - 57.9, this.regFreq * 1.4, 2, 0.5, 2.1, maxFreq));
      if (pz > 0.01) {
        const base = this.hasLiquid ? this.seaLevel + 2 : -this.contAmp * 0.4;
        const land = smoothstep(base, base + this.hAmp * 0.12, h);
        if (land > 0.01) {
          const t = h / this.plateauH;
          const f = Math.floor(t);
          // cliff sharpness is LOD-gated: coarse levels see gentle ramps,
          // close up the mesa edges crispen
          const w = Math.min(0.5, 0.2 + 10 / maxFreq);
          const terraced = (f + smoothstep(0.5 - w, 0.5 + w, t - f)) * this.plateauH;
          h = lerp(h, terraced, this.plateauAmt * pz * land);
        }
      }
    }

    if (this.canyonAmp > 0) {
      const cv = this.nD.fbm(x, y, z, this.canyonFreq, 4, 0.5, 2.3, maxFreq);
      // a coarse LOD cannot resolve a sharp gorge: widen the channel and
      // shallow it in proportion, so the carved volume (and the silhouette)
      // stays consistent while the slopes stay below the sampling rate
      const cw = Math.max(this.canyonWidth, 2.5 / maxFreq);
      const depthScale = this.canyonWidth / cw;
      const t = 1 - Math.abs(cv) / cw;
      if (t > 0) {
        const tt = t * t * (3 - 2 * t) * depthScale;
        let band;
        if (this.hasLiquid) {
          // carve channels from just above the sea up into the lowlands -> rivers/lakes
          band = smoothstep(this.seaLevel - this.hAmp * 0.45, this.seaLevel + 4, h) *
                 (1 - smoothstep(this.seaLevel + this.hAmp * 0.30, this.seaLevel + this.hAmp * 0.7, h));
          h -= tt * (Math.max(0, h - this.seaLevel) + this.hAmp * 0.06) * band;
        } else {
          // dry slot canyons through the midlands
          band = smoothstep(-this.hAmp * 0.3, 0, h) * (1 - smoothstep(this.hAmp * 0.45, this.hAmp * 0.8, h));
          h -= tt * this.canyonAmp * band;
        }
      }

      // tributaries: a finer branching carve feeding the main channels,
      // so valleys form dendritic drainage networks like real watersheds
      const cv2 = this.nD.fbm(x + 7.7, y - 3.3, z + 1.1, this.canyonFreq * 3.1, 3, 0.5, 2.25, maxFreq);
      const cw2 = Math.max(this.canyonWidth * 0.55, 2.5 / maxFreq);
      const t2 = 1 - Math.abs(cv2) / cw2;
      if (t2 > 0) {
        const tt2 = t2 * t2 * (3 - 2 * t2) * (this.canyonWidth * 0.55 / cw2);
        if (this.hasLiquid) {
          const band2 = smoothstep(this.seaLevel - this.hAmp * 0.35, this.seaLevel + 3, h) *
                        (1 - smoothstep(this.seaLevel + this.hAmp * 0.22, this.seaLevel + this.hAmp * 0.5, h));
          h -= tt2 * (Math.max(0, h - this.seaLevel) * 0.55 + this.hAmp * 0.02) * band2;
        } else {
          const band2 = smoothstep(-this.hAmp * 0.25, 0, h) * (1 - smoothstep(this.hAmp * 0.4, this.hAmp * 0.7, h));
          h -= tt2 * this.canyonAmp * 0.4 * band2;
        }
      }
    }

    if (this.craterAmp > 0 && this.craterFreq * 2 <= maxFreq) {
      h += this.craters(x, y, z, this.craterFreq, this.craterAmp, 0);
      if (this.craterFreq * 8 <= maxFreq) {
        h += this.craters(x, y, z, this.craterFreq * 4.7, this.craterAmp * 0.3, 1);
      }
    }

    if (this.blobAmp > 0 && this.blobFreq <= maxFreq) {
      const b = this.nD.billow(x + 31, y, z, this.blobFreq, 4, 0.5, 2.1, maxFreq);
      h += Math.max(0, b) * this.blobAmp;
    }

    if (this.duneAmp > 0 && this.duneFreq <= maxFreq * 1.5) {
      const wob = this.nC.noise(x * 9, y * 9, z * 9) * 2.5;
      const tdt = (x * this.duneAxis.x + y * this.duneAxis.y + z * this.duneAxis.z) * this.duneFreq + wob;
      const flat = 1 - smoothstep(this.hAmp * 0.25, this.hAmp * 0.6, Math.abs(h));
      h += (1 - Math.abs(Math.sin(tdt))) * this.duneAmp * flat;
    }

    if (this.spikeAmp > 0 && this.spikeFreq * 3 <= maxFreq) {
      const w = worley3(x * this.spikeFreq, y * this.spikeFreq, z * this.spikeFreq, (this.intSeed ^ 0x51ce) | 0);
      const sp = Math.max(0, 1 - w.d * 1.45);
      if ((w.h & 7) < 3) h += sp * sp * sp * this.spikeAmp * (0.4 + (w.h % 97) / 97 * 0.6);
    }

    return h;
  }

  craters(x, y, z, freq, amp, lane) {
    const w = worley3(x * freq, y * freq, z * freq, this.intSeed + lane * 7919);
    const rc = 0.16 + ((w.h >>> 4) % 64) / 64 * 0.26;
    const cAmp = amp * (0.35 + ((w.h >>> 10) % 64) / 64 * 0.65);
    const t = w.d / rc;
    if (t < 1) return (t * t * 1.35 - 1) * cAmp;          // bowl, raised rim at edge
    if (t < 1.6) return 0.35 * (1 - (t - 1) / 0.6) * cAmp; // rim falloff
    return 0;
  }

  surfaceRadius(dir, maxFreq = this.fullMaxFreq) {
    return this.R + this.height(dir, maxFreq);
  }

  // ======================================================================
  // THE color function. Same contract as height(): unit dir + the LOD
  // frequency cap. `h` is the already-computed height, slope is 1-dot(n,up).
  // ======================================================================
  colorAt(dir, h, slope, maxFreq, out) {
    const x = dir.x, y = dir.y, z = dir.z;
    const p = this.pal;

    if (this.hasLiquid && h < this.seaLevel && this.liquid !== 'lava') {
      const depth = clamp((this.seaLevel - h) / (this.hAmp * 0.85), 0, 1);
      sampleStops(p.sea, 1 - depth, out);
    } else {
      const t0 = this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85;
      const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);
      sampleStops(p.land, tl, out);

      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);

      if (p.forest && tl > 0.04 && tl < 0.55) {
        const f = smoothstep(0.05, 0.3, moist) * smoothstep(0.04, 0.1, tl) * (1 - smoothstep(0.4, 0.55, tl));
        out.lerp(p.forest, f * 0.85);
      }
      if (p.blotch) {
        const b = this.nD.billow(x - 17, y + 5, z, 5.5, 3, 0.5, 2.1, maxFreq);
        out.lerp(p.blotch, smoothstep(0.18, 0.5, b) * 0.7);
      }
      if (p.strata) {
        const s = Math.sin(h * 0.55 + moist * 2.0);
        const m = 1 + s * 0.09;
        out.r *= m; out.g *= m; out.b *= m;
      }
      if (p.crevasse) {
        const r = this.nB.ridged(x, y, z, 11, 3, 0.55, 2.1, maxFreq);
        out.lerp(p.crevasse, smoothstep(0.52, 0.8, r) * 0.6);
      }
      if (p.stripes) {
        const d = x * this.stripeAxis.x + y * this.stripeAxis.y + z * this.stripeAxis.z;
        const s = Math.sin(d * this.stripeFreq + this.nA.noise(x * 4, y * 4, z * 4) * 1.9) * 0.5 + 0.5;
        sampleStops(p.stripes, s, _c);
        out.lerp(_c, 0.55);
      }
      if (this.liquid === 'lava') {
        const f = 1 - smoothstep(this.seaLevel + 2, this.seaLevel + this.hAmp * 0.22, h);
        if (f > 0) out.lerp(p.ember, f * f);
      }

      // steep ground turns to bare rock
      out.lerp(p.rock, smoothstep(p.slopeLo, p.slopeHi, slope));

      // NOTE: the snowline is applied per-FRAGMENT in the terrain shader
      // (see shaders.js) — per-vertex snow quantized into visible blocks
      // at orbital LODs. Same formula, evaluated per-pixel.
    }

    // fine tonal speckle, LOD-gated like everything else
    if (maxFreq >= 230) {
      const v = this.nB.noise(x * 230, y * 230, z * 230);
      const m = 1 + v * 0.06;
      out.r *= m; out.g *= m; out.b *= m;
    }
    return out;
  }

  // Low-frequency tint masks baked per-vertex (they're smooth, so vertex
  // resolution is fine): x=forest, y=blotch, z=stripe phase, w=ember/
  // crevasse/strata. The fragment shader applies the actual colors.
  extrasAt(dir, h, maxFreq, out) {
    out.set(0, 0, 0, 0);
    const p = this.pal;
    if (this.hasLiquid && h < this.seaLevel && this.liquid !== 'lava') return out;
    const x = dir.x, y = dir.y, z = dir.z;
    const t0 = this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85;
    const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);

    if (p.forest && tl > 0.04 && tl < 0.55) {
      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);
      out.x = smoothstep(0.05, 0.3, moist) * smoothstep(0.04, 0.1, tl)
        * (1 - smoothstep(0.4, 0.55, tl)) * 0.85;
    }
    if (p.blotch) {
      const b = this.nD.billow(x - 17, y + 5, z, 5.5, 3, 0.5, 2.1, maxFreq);
      out.y = smoothstep(0.18, 0.5, b) * 0.7;
    }
    if (p.stripes) {
      const d = x * this.stripeAxis.x + y * this.stripeAxis.y + z * this.stripeAxis.z;
      out.z = Math.sin(d * this.stripeFreq + this.nA.noise(x * 4, y * 4, z * 4) * 1.9) * 0.5 + 0.5;
    }
    if (this.liquid === 'lava') {
      const f = 1 - smoothstep(this.seaLevel + 2, this.seaLevel + this.hAmp * 0.22, h);
      out.w = f * f;
    } else if (p.crevasse) {
      out.w = smoothstep(0.52, 0.8, this.nB.ridged(x, y, z, 11, 3, 0.55, 2.1, maxFreq)) * 0.6;
    } else if (p.strata) {
      const moist = this.nC.fbm(x + 11.3, y - 4.1, z + 7.7, 2.4, 3, 0.5, 2.15, maxFreq);
      out.w = Math.sin(h * 0.55 + moist * 2.0) * 0.5 + 0.5;
    }
    return out;
  }

  buildPalette(rand) {
    // vivid types can drift far; living worlds keep believable hues
    const hueSpan = (this.type === 'lush' || this.type === 'ocean') ? 0.05 : 0.13;
    const dh = (rand() - 0.5) * hueSpan;
    const ds = 0.82 + rand() * 0.45;
    const dl = 0.88 + rand() * 0.26;
    const J = (hex) => jitterColor(col(hex), rand, dh, ds, dl);

    const p = { slopeLo: 0.22, slopeHi: 0.5, snow: null, snowLine: 1e9, capLat: 0 };
    switch (this.type) {
      case 'lush':
        // remote-sensing greens: olive, sage, moss — never crayon
        p.sea = stops([[0, J('#050f26')], [0.45, J('#0a2f55')], [0.8, J('#175a75')], [1, J('#4e8f83')]]);
        p.land = stops([[0, J('#b3a478')], [0.06, J('#8f9459')], [0.22, J('#5f7a42')], [0.45, J('#4a5f38')],
                        [0.62, J('#6b6a48')], [0.78, J('#77695a')], [1, J('#877e6f')]]);
        p.forest = J('#2e4527'); p.rock = J('#6b6156');
        p.snow = J('#eef2f6'); p.snowLine = this.hAmp * (0.55 + rand() * 0.2); p.capLat = 0.8;
        break;
      case 'ocean':
        p.sea = stops([[0, J('#041124')], [0.5, J('#082c52')], [0.82, J('#135273')], [1, J('#3f8f88')]]);
        p.land = stops([[0, J('#c2b183')], [0.12, J('#a29a62')], [0.3, J('#657e49')], [0.6, J('#4c5f3d')], [1, J('#6c6b56')]]);
        p.forest = J('#2f4a2c'); p.rock = J('#6f685c');
        p.snow = J('#e8eef4'); p.snowLine = this.hAmp * 0.7; p.capLat = 0.74;
        break;
      case 'desert':
        p.land = stops([[0, J('#d8b069')], [0.2, J('#cf9a52')], [0.42, J('#bd7d40')], [0.6, J('#a26035')],
                        [0.8, J('#84502e')], [1, J('#6e4226')]]);
        p.rock = J('#7c4e2c'); p.strata = true;
        break;
      case 'ice':
        p.sea = stops([[0, J('#9cc2dd')], [0.6, J('#b9d8ec')], [1, J('#d8ecf8')]]);
        p.land = stops([[0, J('#cfe2f0')], [0.35, J('#ddeefa')], [0.65, J('#c4dcf0')], [1, J('#f0f8ff')]]);
        p.rock = J('#5d6b7a'); p.crevasse = J('#7fa8d8');
        p.slopeLo = 0.3; p.slopeHi = 0.6;
        break;
      case 'lava':
        p.land = stops([[0, J('#221b1d')], [0.3, J('#392c2e')], [0.6, J('#4a3a36')], [1, J('#5d4a40')]]);
        p.rock = J('#2b2225'); p.ember = col('#ff5a16');
        break;
      case 'barren':
        p.land = stops([[0, J('#8f8b84')], [0.35, J('#79746d')], [0.65, J('#99948b')], [1, J('#67625b')]]);
        p.rock = J('#57534d');
        break;
      case 'toxic':
        p.sea = stops([[0, J('#274d11')], [0.6, J('#4d7a1c')], [1, J('#7fb52e')]]);
        p.land = stops([[0, J('#5d7c30')], [0.28, J('#6f9437')], [0.52, J('#4e6f2a')], [0.78, J('#665a85')], [1, J('#7a6a9a')]]);
        p.blotch = J('#8a4aa0'); p.rock = J('#46552f');
        break;
      case 'exotic': {
        const h1 = rand(), h2 = (h1 + 0.33 + rand() * 0.2) % 1;
        const c1 = new THREE.Color().setHSL(h1, 0.75, 0.55);
        const c2 = new THREE.Color().setHSL(h2, 0.7, 0.45);
        const c3 = new THREE.Color().setHSL((h1 + 0.5) % 1, 0.5, 0.7);
        p.land = stops([[0, c1.clone().multiplyScalar(0.5)], [0.4, c1], [0.75, c2], [1, c3]]);
        p.stripes = stops([[0, c2.clone().multiplyScalar(0.7)], [1, c3]]);
        p.rock = c1.clone().multiplyScalar(0.35);
        break;
      }
    }
    // colors authored in sRGB, shaded in linear
    const lin = (c) => c && c.convertSRGBToLinear();
    for (const s of p.land) lin(s.c);
    if (p.sea) for (const s of p.sea) lin(s.c);
    if (p.stripes) for (const s of p.stripes) lin(s.c);
    for (const k of ['forest', 'rock', 'snow', 'blotch', 'crevasse', 'ember']) lin(p[k]);
    this.pal = p;

    // the palette as shader uniforms: the terrain fragment shader evaluates
    // the full gradient per-PIXEL, so coastlines and rock bands stay crisp
    // from orbit and colors can't pop between LODs
    const MAXS = 7;
    const pad = (stops) => {
      const t = new Array(MAXS).fill(1);
      const c = [];
      for (let i = 0; i < MAXS; i++) {
        const s = stops[Math.min(i, stops.length - 1)];
        t[i] = s.t;
        c.push(s.c);
      }
      return { t, c, n: stops.length };
    };
    const landU = pad(p.land);
    const seaU = pad(p.sea || p.land);
    const black = new THREE.Color(0, 0, 0);
    this.palU = {
      landT: landU.t, landC: landU.c, landN: landU.n,
      seaT: seaU.t, seaC: seaU.c, seaN: seaU.n,
      hasSea: this.hasLiquid && this.liquid !== 'lava' ? 1 : 0,
      rock: p.rock,
      slopeLo: p.slopeLo, slopeHi: p.slopeHi,
      t0: this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85,
      tSpan: this.hAmp * 1.15 - (this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85),
      seaDepthSpan: this.hAmp * 0.85,
      forest: p.forest || black,
      blotch: p.blotch || black,
      stripeA: p.stripes ? p.stripes[0].c : black,
      stripeB: p.stripes ? p.stripes[p.stripes.length - 1].c : black,
      stripeK: p.stripes ? 0.55 : 0,
      extraC: this.liquid === 'lava' ? p.ember : (p.crevasse || black),
      extraMode: this.liquid === 'lava' || p.crevasse ? 1 : (p.strata ? 3 : 0),
    };

    // liquid & atmosphere colors
    this.atmoColor = col(this.cfg.atmo).convertSRGBToLinear();
    this.skyColor = col(this.cfg.sky);
    switch (this.liquid) {
      case 'water': this.liquidColor = col('#15527e'); this.liquidOpacity = 0.66; break;
      case 'toxic': this.liquidColor = col('#6fcc22'); this.liquidOpacity = 0.82; break;
      case 'ice':   this.liquidColor = col('#cfe6f5'); this.liquidOpacity = 1.0; break;
      case 'lava':  this.liquidColor = col('#3a1404'); this.liquidOpacity = 1.0; break;
    }
  }

  // Biome classification for the prop scatter system. CRITICAL: this must
  // mirror the same elevation/moisture bands that colorAt paints, or the
  // ground you see from orbit lies about what grows on it up close.
  biomeAt(dir, h) {
    if (this.hasLiquid && h < this.seaLevel + 1.5) return 'shore';
    switch (this.type) {
      case 'lush': case 'ocean': {
        if (this.pal.snowLine < 1e8 && h > this.pal.snowLine * 0.92) return 'snow';
        const t0 = this.seaLevel;
        const tl = clamp((h - t0) / (this.hAmp * 1.15 - t0), 0, 1);
        if (tl > 0.6) return 'rock';                 // olive-brown high country: bare
        const moist = this.nC.fbm(dir.x + 11.3, dir.y - 4.1, dir.z + 7.7, 2.4, 3, 0.5, 2.15, 64);
        if (tl > 0.45) return moist > 0.25 ? 'grass' : 'rock';
        // forests only where the palette actually darkens green
        if (moist > 0.14 && tl > 0.05) return 'forest';
        return moist > -0.12 ? 'grass' : 'dryland';  // tan zones get dry tufts
      }
      case 'desert': {
        const tl = h + this.contAmp * 0.85;
        return tl > this.hAmp * 1.1 ? 'rock' : 'sand';
      }
      case 'ice': return 'ice';
      case 'lava': return h < this.seaLevel + this.hAmp * 0.2 ? 'ember' : 'ash';
      case 'barren': return 'regolith';
      case 'toxic': return 'slime';
      case 'exotic': return 'weird';
    }
    return 'rock';
  }

  // ---- visual extras ------------------------------------------------------
  buildEffects(rand) {
    const R = this.R;

    if (this.hasLiquid) {
      let mat;
      if (this.liquid === 'lava') {
        mat = new THREE.MeshStandardMaterial({
          color: this.liquidColor, emissive: col('#ff4d0a'), emissiveIntensity: 1.5, roughness: 0.55,
        });
      } else if (this.liquid === 'ice') {
        mat = new THREE.MeshStandardMaterial({ color: this.liquidColor, roughness: 0.32, metalness: 0.05 });
      } else {
        mat = new THREE.MeshPhysicalMaterial({
          color: this.liquidColor, transparent: true, opacity: this.liquidOpacity,
          roughness: 0.13, metalness: 0.0, side: THREE.DoubleSide, depthWrite: false,
        });
      }
      this.liquidMat = mat;
      if (this.liquid === 'water' || this.liquid === 'toxic') applyWaterWaves(mat);
      // seas are a second (flat, morph-less) chunked LOD: a uniform sphere
      // mesh would sag metres between vertices at 100 km radius
      this.waterLod = new ChunkedLOD({
        R: this.seaRadius, hAmp: 2, noMorph: true, noSkirt: true, noShadow: true,
        gridCells: 12,
        maxLevel: Math.min(this.maxLevel - 3, 8),
        freqAtLevel: this.freqAtLevel,
        height: () => 0,
        colorAt: (dir, h, slope, f, out) => out.setRGB(1, 1, 1),
        group: this.group,
        terrainMaterial: mat,
      });
    }

    if (this.atmoDensity > 0.05) {
      const atmoR = R + Math.max(this.hAmp * 2.2, R * 0.05);
      this.atmoMesh = new THREE.Mesh(
        new THREE.SphereGeometry(atmoR, 96, 64),
        makeAtmosphereMaterial(this.atmoColor, this.atmoDensity),
      );
      this.atmoMesh.renderOrder = 3;
      this.group.add(this.atmoMesh);
      this.atmoHeight = atmoR - R;
    } else {
      this.atmoHeight = Math.max(this.hAmp * 2.2, R * 0.03);
    }

    // clouds are a roll of the dice per planet, with their own coverage —
    // plenty of worlds have clear skies
    this.cloudBands = [];
    if (this.cfg.clouds > 0.05 && rand() < this.cfg.clouds) {
      const coverage = 0.3 + rand() * 0.55;
      // the visible clouds are shader-procedural (resolution-independent);
      // this small texture only serves the terrain's cast cloud shadows
      this.cloudShadowTex = makeCloudTexture(this.nD, coverage);
      const cloudR = R + Math.max(this.hAmp * 1.7 + 90, R * 0.02);
      const cmat = new THREE.MeshLambertMaterial({
        color: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
        transparent: true, depthWrite: false, opacity: 0.92,
      });
      const o1 = [rand() * 7, rand() * 7, rand() * 7];
      applyCloudField(cmat, coverage, o1[0], o1[1], o1[2]);
      this.cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(cloudR, 96, 64), cmat);
      this.cloudMesh.renderOrder = 2;
      this.group.add(this.cloudMesh);
      this.cloudBands.push({
        r: cloudR, mesh: this.cloudMesh, opacity: 0.92,
        cov0: 0.55 - coverage * 0.24, cov1: 0.86 - coverage * 0.14,
        ox: o1[0], oy: o1[1], oz: o1[2],
      });
      // a second, thinner deck drifting at its own pace gives depth
      if (coverage > 0.45) {
        const cmat2 = new THREE.MeshLambertMaterial({
          color: 0xffffff, transparent: true, depthWrite: false, opacity: 0.5,
        });
        const o2 = [rand() * 7, rand() * 7, rand() * 7];
        applyCloudField(cmat2, coverage * 0.6, o2[0], o2[1], o2[2]);
        this.cloudMesh2 = new THREE.Mesh(
          new THREE.SphereGeometry(cloudR + this.hAmp * 0.9, 96, 64), cmat2);
        this.cloudMesh2.renderOrder = 2;
        this.group.add(this.cloudMesh2);
        this.cloudSpin2 = rand() * Math.PI * 2;
        this.cloudBands.push({
          r: cloudR + this.hAmp * 0.9, mesh: this.cloudMesh2, opacity: 0.5,
          cov0: 0.55 - coverage * 0.6 * 0.24, cov1: 0.86 - coverage * 0.6 * 0.14,
          ox: o2[0], oy: o2[1], oz: o2[2],
        });
      }
    }

    if (!this.isMoon && rand() < 0.24) {
      const inner = R * (1.55 + rand() * 0.4), outer = inner + R * (0.5 + rand() * 0.7);
      const geo = new THREE.RingGeometry(inner, outer, 160, 1);
      // map UV.x to radius for the band texture
      const pos = geo.attributes.position, uv = geo.attributes.uv;
      for (let i = 0; i < uv.count; i++) {
        const r = Math.hypot(pos.getX(i), pos.getY(i));
        uv.setXY(i, (r - inner) / (outer - inner), 0.5);
      }
      const ringTint = this.pal.land[Math.min(2, this.pal.land.length - 1)].c;
      this.ringMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: makeRingTexture(makeRng(this.seed + ':ring'), ringTint),
        transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85,
      }));
      this.ringMesh.quaternion.copy(this.axisQuat);
      this.ringMesh.rotateX(Math.PI / 2);
      this.ringMesh.renderOrder = 2;
      this.group.add(this.ringMesh);
    }
  }

  setSunDir(dirLocal) {
    this.sunDirLocal = dirLocal.clone();
    if (this.atmoMesh) this.atmoMesh.material.uniforms.sunDir.value.copy(dirLocal);
  }

  // How deep in a cloud the camera is (0..1): drives transit white-out fog.
  // Samples the same field the shader draws, in the deck's rotated frame.
  cloudTransit(camLocal) {
    if (!this.cloudBands.length) return 0;
    const camR = camLocal.length();
    let t = 0;
    for (const b of this.cloudBands) {
      const prox = 1 - Math.min(1, Math.abs(camR - b.r) / 900);
      if (prox <= 0) continue;
      _dir.copy(camLocal).multiplyScalar(1 / camR)
        .applyQuaternion(_q2.copy(b.mesh.quaternion).invert());
      const d = cloudDensityCPU(_dir, b.cov0, b.cov1, b.ox, b.oy, b.oz);
      t = Math.max(t, prox * d * b.opacity);
    }
    return t;
  }

  // camLocal: camera position in planet-local coords (f64 Vector3)
  update(camLocal, dt, focused) {
    this.lod.update(camLocal, dt);
    if (this.waterLod) this.waterLod.update(camLocal, dt);
    // shells vanish near their own altitude so you fly through, not pop through
    if (this.cloudBands.length) {
      const camR = camLocal.length();
      for (const b of this.cloudBands) {
        const sh = b.mesh.material.userData.shader;
        if (sh) {
          const x = Math.min(1, Math.max(0, (Math.abs(camR - b.r) - 200) / 1400));
          sh.uniforms.uCamProx.value = x * x * (3 - 2 * x);
        }
      }
    }
    if (this.appear < 1) {
      this.appear = Math.min(1, this.appear + dt / 1.2);
      this.applyAppear();
    }
    if (this.cloudMesh) {
      this.cloudSpin += dt * 0.0045;
      this.cloudMesh.quaternion.copy(this.axisQuat)
        .multiply(_q.setFromAxisAngle(_yAxis, this.cloudSpin));
      // keep terrain cloud-shadows tracking the drifting deck
      const sh = this.terrainMaterial.userData.shader;
      if (sh) {
        _m4.makeRotationFromQuaternion(_q2.copy(this.cloudMesh.quaternion).invert());
        sh.uniforms.uCloudMat.value.setFromMatrix4(_m4);
      }
    }
    if (this.cloudMesh2) {
      this.cloudSpin2 += dt * 0.0028;
      this.cloudMesh2.quaternion.copy(this.axisQuat)
        .multiply(_q.setFromAxisAngle(_yAxis, this.cloudSpin2));
    }
  }

  altitudeAt(camLocal) {
    const r = camLocal.length();
    _dir.copy(camLocal).multiplyScalar(1 / r);
    return r - this.surfaceRadius(_dir);
  }

  get typeLabel() { return this.cfg.label; }

  // a pleasant landing spot: dry, gentle ground, daylight if preferDir is
  // given (the sun direction), and ideally a view — relief or a shoreline.
  scenicDir(preferDir = null) {
    const rand = makeRng(this.seed + ':scenic');
    let best = null, bestScore = -1e9;
    const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), s = new THREE.Vector3();
    for (let i = 0; i < 200; i++) {
      _dir.set(rand() * 2 - 1, rand() * 2 - 1, rand() * 2 - 1);
      if (_dir.lengthSq() < 0.05 || _dir.lengthSq() > 1) continue;
      _dir.normalize();
      const h = this.height(_dir, 64);
      let score = 0;
      if (this.hasLiquid) {
        const above = h - this.seaLevel;
        if (above < 2) { continue; }                              // underwater: no
        score -= Math.abs(above - this.hAmp * 0.15) * 1.5;        // low ground…
        score += Math.max(0, 1 - above / (this.hAmp * 0.5)) * this.hAmp * 0.8; // …near the shore
      } else {
        score -= Math.abs(h) * 0.5;
      }
      // nearby relief = something to look at
      if (Math.abs(_dir.y) < 0.93) e1.set(-_dir.z, 0, _dir.x).normalize();
      else e1.set(1, 0, 0).projectOnPlane(_dir).normalize();
      e2.crossVectors(_dir, e1);
      let hMin = h, hMax = h;
      for (let k = 0; k < 4; k++) {
        s.copy(_dir).addScaledVector(k < 2 ? e1 : e2, (k % 2 ? 1 : -1) * 0.06).normalize();
        const hs = this.height(s, 64);
        hMin = Math.min(hMin, hs); hMax = Math.max(hMax, hs);
      }
      score += (hMax - hMin) * 1.4;
      score -= Math.abs(_dir.y) * this.hAmp * 0.3;                // temperate latitudes
      if (preferDir) score += _dir.dot(preferDir) * this.hAmp * 3.0; // land in daylight
      if (score > bestScore) { bestScore = score; best = _dir.clone(); }
    }
    return best || new THREE.Vector3(1, 0, 0);
  }

  dispose() {
    this.lod.dispose();
    if (this.waterLod) this.waterLod.dispose();
    if (this.cloudShadowTex) this.cloudShadowTex.dispose();
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        if (o.material.alphaMap) o.material.alphaMap.dispose();
        o.material.dispose();
      }
    });
    this.terrainMaterial.dispose();
  }
}

const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m4 = new THREE.Matrix4();
const _yAxis = new THREE.Vector3(0, 1, 0);

function makeAtmosphereMaterial(color, density) {
  return new THREE.ShaderMaterial({
    uniforms: {
      atmoColor: { value: color },
      density: { value: density },
      sunDir: { value: new THREE.Vector3(0, 1, 0) },   // planet-local, set by the system
    },
    vertexShader: /* glsl */`
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vObjNormal;
      void main() {
        vNormal = normalMatrix * normal;
        vObjNormal = normal;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vViewPos = mv.xyz;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 atmoColor;
      uniform float density;
      uniform vec3 sunDir;
      varying vec3 vNormal;
      varying vec3 vViewPos;
      varying vec3 vObjNormal;
      void main() {
        vec3 n = normalize(vNormal);
        vec3 v = normalize(-vViewPos);
        float rim = pow(1.0 - abs(dot(n, v)), 3.3);
        // glow belongs to the day side
        float lit = clamp(dot(normalize(vObjNormal), sunDir) * 0.8 + 0.42, 0.04, 1.0);
        gl_FragColor = vec4(atmoColor, 1.0) * rim * lit * density * 0.85;
      }`,
    side: THREE.BackSide,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
}

function makeCloudTexture(simplex, coverage) {
  const W = 512, H = 256;
  const canvas = (typeof document !== 'undefined') ? document.createElement('canvas') : null;
  if (!canvas) return null;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, H);
  const d = img.data;
  for (let j = 0; j < H; j++) {
    const phi = (j / H - 0.5) * Math.PI;
    const cy = Math.sin(phi), cr = Math.cos(phi);
    for (let i = 0; i < W; i++) {
      const th = (i / W) * Math.PI * 2;
      const cx = Math.cos(th) * cr, cz = Math.sin(th) * cr;
      // cap octaves at the texture's own resolution: finer noise would
      // alias into hard per-texel blocks once thresholded
      let v = simplex.fbm(cx + 5, cy + 5, cz - 5, 4.2, 6, 0.55, 2.3, 45);
      v = smoothstep(0.62 - coverage * 0.22, 0.88 - coverage * 0.15, v * 0.5 + 0.5);
      v = Math.pow(v, 1.35);              // cauliflower edges, puffy cores
      const k = (j * W + i) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = (v * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  // soften: thresholded noise leaves near-binary texels that read as hard
  // squares from orbit; a subpixel blur turns them back into vapour
  ctx.filter = 'blur(1.4px)';
  ctx.drawImage(canvas, 0, 0);
  ctx.filter = 'none';
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

function makeRingTexture(rand, tint) {
  if (typeof document === 'undefined') return null;
  const W = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = 1;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(W, 1);
  const d = img.data;
  const r = tint.r * 255, g = tint.g * 255, b = tint.b * 255;
  let a = 0;
  for (let i = 0; i < W; i++) {
    if (i % 8 === 0) a = rand() * rand();
    const edge = smoothstep(0, 0.08, i / W) * (1 - smoothstep(0.85, 1, i / W));
    d[i * 4] = lerp(200, r, 0.5);
    d[i * 4 + 1] = lerp(190, g, 0.5);
    d[i * 4 + 2] = lerp(180, b, 0.5);
    d[i * 4 + 3] = a * edge * 200;
  }
  ctx.putImageData(img, 0, 0);
  return new THREE.CanvasTexture(canvas);
}
