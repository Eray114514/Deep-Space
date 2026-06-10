// Planet: a fully procedural world defined by ONE seeded height function and
// ONE color function over unit-sphere directions. Terrain chunks at every LOD,
// the walking controller, the landing logic and the scatter system all sample
// these same functions — which is what keeps a planet consistent whether it is
// a dot across the system or the ground under your feet.

import * as THREE from 'three';
import { makeRng, strHash32 } from './rng.js';
import { Simplex, worley3, clamp, lerp, smoothstep } from './noise.js';
import { ChunkedLOD, GRID_CELLS } from './quadtree.js';

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
  constructor({ seed, name, posUniv, type, isMoon = false, radius = null }) {
    this.seed = seed;
    this.name = name;
    this.isMoon = isMoon;
    this.posUniv = posUniv.clone();
    const rand = makeRng(seed);
    this.rand = rand;
    this.intSeed = strHash32(seed);

    this.type = type;
    this.cfg = TYPES[type];

    // ---- dimensions -------------------------------------------------------
    const baseR = isMoon ? 550 + rand() * 450 : 1300 + rand() * 1500;
    this.R = radius || baseR;
    this.hAmp = this.R * this.cfg.relief * (0.85 + rand() * 0.5);
    this.gravity = 9.81 * clamp(this.R / 2100, 0.45, 1.5);

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

    // LOD limits: finest cells ≈ 1.4 m
    const rootCell = (Math.PI / 2) * this.R / GRID_CELLS;
    this.maxLevel = clamp(Math.round(Math.log2(rootCell / 1.4)), 4, 9);
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
    this.terrainMaterial = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 1.0, metalness: 0.0,
    });
    this.lod = new ChunkedLOD(this);
    this.buildEffects(rand);
    this.cloudSpin = rand() * Math.PI * 2;
  }

  // ======================================================================
  // THE height function. dir must be a unit vector (planet-local).
  // maxFreq caps angular detail for LOD; features finer than the sampling
  // grid are skipped, everything coarser is identical at every LOD.
  // Returns meters relative to base radius R.
  // ======================================================================
  height(dir, maxFreq = 1e9) {
    const x = dir.x, y = dir.y, z = dir.z;

    const c = this.nA.fbm(x, y, z, this.contFreq, 4, 0.52, 2.05, maxFreq);
    let h = c * this.contAmp;

    // mountains/detail keep their first octave at every LOD (fractals cut
    // octaves internally) so the mean elevation never jumps between levels
    const mMask = smoothstep(this.mountMaskLo, this.mountMaskHi, c);
    if (mMask > 0.002) {
      const m = this.nB.ridged(x, y, z, this.mountFreq, 6, 0.55, 2.1, maxFreq);
      h += m * this.mountAmp * mMask;
    }

    {
      const d = this.nC.fbm(x, y, z, this.detailFreq, 7, 0.5, 2.2, maxFreq);
      h += d * this.detailAmp * (0.45 + 0.55 * mMask);
    }

    if (this.canyonAmp > 0) {
      const cv = this.nD.fbm(x, y, z, this.canyonFreq, 4, 0.5, 2.3, maxFreq);
      const t = 1 - Math.abs(cv) / this.canyonWidth;
      if (t > 0) {
        const tt = t * t * (3 - 2 * t);
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

    if (this.duneAmp > 0 && this.duneFreq <= maxFreq * 5) {
      const wob = this.nC.noise(x * 9, y * 9, z * 9) * 2.5;
      const tdt = (x * this.duneAxis.x + y * this.duneAxis.y + z * this.duneAxis.z) * this.duneFreq + wob;
      const flat = 1 - smoothstep(this.hAmp * 0.25, this.hAmp * 0.6, Math.abs(h));
      h += (1 - Math.abs(Math.sin(tdt))) * this.duneAmp * flat;
    }

    if (this.spikeAmp > 0 && this.spikeFreq * 2 <= maxFreq) {
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

      // snowline (lower near the poles), then polar caps
      if (p.snow) {
        const lat = Math.abs(y) + this.nA.noise(x * 3.1 + 9, y * 3.1, z * 3.1) * 0.06;
        const sl = p.snowLine * (1 - 0.65 * smoothstep(0.45, 0.95, lat));
        let f = smoothstep(sl, sl + this.hAmp * 0.1, h);
        if (p.capLat) f = Math.max(f, smoothstep(p.capLat, p.capLat + 0.07, lat));
        f *= 1 - smoothstep(0.55, 0.8, slope) * 0.85;
        out.lerp(p.snow, f);
      }
    }

    // fine tonal speckle, LOD-gated like everything else
    if (maxFreq >= 230) {
      const v = this.nB.noise(x * 230, y * 230, z * 230);
      const m = 1 + v * 0.06;
      out.r *= m; out.g *= m; out.b *= m;
    }
    return out;
  }

  buildPalette(rand) {
    const dh = (rand() - 0.5) * 0.07;
    const ds = 0.9 + rand() * 0.3;
    const dl = 0.92 + rand() * 0.18;
    const J = (hex) => jitterColor(col(hex), rand, dh, ds, dl);

    const p = { slopeLo: 0.22, slopeHi: 0.5, snow: null, snowLine: 1e9, capLat: 0 };
    switch (this.type) {
      case 'lush':
        p.sea = stops([[0, J('#04173a')], [0.45, J('#0a3f74')], [0.8, J('#16638a')], [1, J('#3fa18e')]]);
        p.land = stops([[0, J('#cabb7c')], [0.05, J('#88b04b')], [0.22, J('#549337')], [0.45, J('#3f7a30')],
                        [0.62, J('#737d4a')], [0.78, J('#7d7266')], [1, J('#8d8377')]]);
        p.forest = J('#2e7227'); p.rock = J('#6b6358');
        p.snow = J('#f4f8fb'); p.snowLine = this.hAmp * (0.55 + rand() * 0.2); p.capLat = 0.8;
        break;
      case 'ocean':
        p.sea = stops([[0, J('#031430')], [0.5, J('#08366b')], [0.82, J('#15648e')], [1, J('#49b3ac')]]);
        p.land = stops([[0, J('#d8c98c')], [0.12, J('#bdb168')], [0.3, J('#5d9c46')], [0.6, J('#47753a')], [1, J('#6f6f5a')]]);
        p.forest = J('#2f6b33'); p.rock = J('#6f685c');
        p.snow = J('#eef4f8'); p.snowLine = this.hAmp * 0.7; p.capLat = 0.74;
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

  // simple biome classification used by the prop scatter system
  biomeAt(dir, h) {
    if (this.hasLiquid && h < this.seaLevel + 1.5) return 'shore';
    const tl = h - (this.hasLiquid ? this.seaLevel : -this.contAmp * 0.85);
    switch (this.type) {
      case 'lush': case 'ocean': {
        if (this.pal.snowLine < 1e8 && h > this.pal.snowLine) return 'snow';
        const moist = this.nC.fbm(dir.x + 11.3, dir.y - 4.1, dir.z + 7.7, 2.4, 3, 0.5, 2.15, 64);
        return moist > 0.12 ? 'forest' : 'grass';
      }
      case 'desert': return tl > this.hAmp * 0.5 ? 'rock' : 'sand';
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
      this.liquidLow = new THREE.SphereGeometry(this.seaRadius, 48, 32);
      this.liquidHigh = new THREE.SphereGeometry(this.seaRadius, 192, 128);
      this.liquidMesh = new THREE.Mesh(this.liquidLow, mat);
      this.liquidMesh.renderOrder = 1;
      this.group.add(this.liquidMesh);
    }

    if (this.cfg.atmoDensity > 0.05) {
      const atmoR = R + Math.max(this.hAmp * 2.2, R * 0.05);
      this.atmoMesh = new THREE.Mesh(
        new THREE.SphereGeometry(atmoR, 64, 48),
        makeAtmosphereMaterial(this.atmoColor, this.cfg.atmoDensity),
      );
      this.atmoMesh.renderOrder = 3;
      this.group.add(this.atmoMesh);
      this.atmoHeight = atmoR - R;
    } else {
      this.atmoHeight = Math.max(this.hAmp * 2.2, R * 0.03);
    }

    if (this.cfg.clouds > 0.05 && rand() < 0.9) {
      const tex = makeCloudTexture(this.nD, this.cfg.clouds);
      const cloudR = R + Math.max(this.hAmp * 1.7 + 90, R * 0.02);
      this.cloudMesh = new THREE.Mesh(
        new THREE.SphereGeometry(cloudR, 64, 48),
        new THREE.MeshLambertMaterial({
          color: this.type === 'toxic' ? 0xc8e890 : 0xffffff,
          transparent: true, alphaMap: tex, depthWrite: false, opacity: 0.92,
        }),
      );
      this.cloudMesh.renderOrder = 2;
      this.group.add(this.cloudMesh);
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

  // camLocal: camera position in planet-local coords (f64 Vector3)
  update(camLocal, dt, focused) {
    this.lod.update(camLocal);
    if (this.cloudMesh) {
      this.cloudSpin += dt * 0.0045;
      this.cloudMesh.quaternion.copy(this.axisQuat)
        .multiply(_q.setFromAxisAngle(_yAxis, this.cloudSpin));
    }
    if (this.liquidMesh) {
      const want = focused ? this.liquidHigh : this.liquidLow;
      if (this.liquidMesh.geometry !== want) this.liquidMesh.geometry = want;
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
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        if (o.material.map) o.material.map.dispose();
        if (o.material.alphaMap) o.material.alphaMap.dispose();
        o.material.dispose();
      }
    });
    if (this.liquidLow) this.liquidLow.dispose();
    if (this.liquidHigh) this.liquidHigh.dispose();
    this.terrainMaterial.dispose();
  }
}

const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
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
  const W = 384, H = 192;
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
      let v = simplex.fbm(cx + 5, cy + 5, cz - 5, 4.2, 5, 0.55, 2.3, 1e9);
      v = smoothstep(0.62 - coverage * 0.22, 0.85 - coverage * 0.15, v * 0.5 + 0.5);
      const k = (j * W + i) * 4;
      d[k] = d[k + 1] = d[k + 2] = 255;
      d[k + 3] = (v * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
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
