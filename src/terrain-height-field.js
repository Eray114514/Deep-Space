// Exact, renderer-independent terrain authority. Snapshot copies own their
// parameters and permutations; reconstruction consumes no RNG or renderer state.
import { worley3, clamp, frequencyBlend, lerp, smoothstep } from './noise.js';
import { TerrainSimplex } from './terrain-noise.js';
import { TerrainCraterField } from './terrain-crater-field.js';

const _g = { x: 0, y: 0, z: 0 };

const PARAMETERS = [
  'R', 'seaRadius', 'seaLevel', 'fullMaxFreq', 'intSeed', 'hasLiquid', 'hAmp',
  'regFreq', 'beltBias', 'warpFreq', 'warpAmp', 'contFreq', 'contAmp',
  'mountMaskLo', 'mountMaskHi', 'mountFreq', 'mountAmp', 'detailFreq',
  'detailAmp', 'plainsCalm', 'plateauAmt', 'plateauH', 'canyonAmp',
  'canyonFreq', 'canyonWidth', 'craterAmp', 'craterFreq', 'blobAmp',
  'blobFreq', 'duneAmp', 'duneFreq', 'spikeAmp', 'spikeFreq',
  // generator v2: physical-wavelength relief (see height())
  'landDatum', 'landRise', 'rangeFreq', 'rangeBias', 'ridgeFreq', 'ridgeAmp',
  'hillFreq', 'hillAmp', 'roughFreq', 'roughAmp', 'microFreq', 'microAmp',
];
const NOISE_FIELDS = ['nA', 'nB', 'nC', 'nD', 'nOceanBasin'];

export class TerrainHeightField {
  constructor() { this._craterField = new TerrainCraterField(); }

  createTerrainSnapshot() {
    return { version: 1,
      parameters: Object.fromEntries(PARAMETERS.map(key => [key, this[key]])),
      duneAxis: this.duneAxis ? { x: this.duneAxis.x, y: this.duneAxis.y, z: this.duneAxis.z } : null,
      tuning: { bathymetryScale: this.tuning?.bathymetryScale },
      noise: Object.fromEntries(NOISE_FIELDS.map(key => [key, this[key] ? {
        perm: this[key].perm.slice(), permMod12: this[key].permMod12.slice(),
      } : null])),
    };
  }

  static fromSnapshot(snapshot) {
    if (snapshot.version !== 1) throw new Error('Unsupported terrain snapshot');
    const field = new TerrainHeightField();
    for (const key of PARAMETERS) field[key] = snapshot.parameters[key];
    field.duneAxis = snapshot.duneAxis ? { ...snapshot.duneAxis } : null;
    field.tuning = { ...snapshot.tuning };
    for (const key of NOISE_FIELDS) {
      const noise = snapshot.noise[key];
      if (!noise) { field[key] = null; continue; }
      if (!(noise.perm instanceof Uint8Array) || noise.perm.length !== 512
        || !(noise.permMod12 instanceof Uint8Array) || noise.permMod12.length !== 512)
        throw new Error('Invalid terrain permutation snapshot');
      field[key] = Object.assign(Object.create(TerrainSimplex.prototype), {
        perm: noise.perm.slice(), permMod12: noise.permMod12.slice(),
      });
    }
    return field;
  }

  // Terrain v2 (2026-11). The world is described in physical wavelengths so a
  // 1,200 km planet and a 60 km moon both get mountains a few tens of
  // kilometres across, hills a few kilometres across and ground relief down
  // to metres. v1 placed every feature on unit-sphere frequencies whose finest
  // octave was about a kilometre long: the land was one uniformly lumpy sheet
  // with nothing below that scale and no contrast between plains and ranges.
  //
  //   continents  warped fBm, unchanged, so coastlines keep their layout
  //   hypsometry  land above the datum rises gently (coastal plains, interior
  //               lowlands); basins and ocean floors keep their depth
  //   ranges      ridged multifractal with slope-damped octaves, confined to
  //               belts: sharp crests, smooth carved flanks
  //   hills       slope-damped fBm everywhere, calmer on the plains
  //   roughness   outcrops, knolls and gullies; micro relief underfoot
  //
  // Every octave fades in through frequencyBlend, so a coarse LOD is the same
  // world with the short wavelengths missing.
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
    let c = this.nA.fbm(ax, ay, az, this.contFreq, 4, 0.52, 2.05, maxFreq);
    // The four continental octaves stop near 70 km. Carry the same spectrum
    // down to a few hundred metres so shores are bays, headlands and islets
    // rather than the smooth outline of the last octave.
    c += this.bandFbm(this.nA, ax + 5.3, ay - 2.1, az + 8.7,
      this.contFreq * 17.6, 9, 0.5, 2.03, maxFreq) * 0.075;

    // hypsometry: real continents sit low. Above the datum the continental
    // swell is compressed into plains; below it nothing changes.
    const raw = c * this.contAmp;
    const above = raw - this.landDatum;
    let h = above > 0
      ? this.landDatum + above * (this.landRise + 0.10 * smoothstep(0, this.contAmp * 0.7, above))
      // the shoreface drops off about twice as fast for the first few hundred
      // metres: a shelf, not a turquoise apron kilometres wide around every coast
      : raw - this.contAmp * 0.07 * (1 - Math.exp(above / (this.contAmp * 0.06)));
    // detail thins out under deep water: sea floors are smooth sediment
    const dry = smoothstep(-0.05 * this.contAmp, 0.012 * this.contAmp, above);

    // mountain belts: ranges are long ridged bands inside the rugged
    // provinces, not a mask that covers every interior
    const foothills = smoothstep(this.mountMaskLo - 0.1, this.mountMaskHi, c);
    const range = this.nD.ridged(x - 23.7, y + 8.1, z + 41.9, this.rangeFreq, 3, 0.5, 2.1, maxFreq, 0.1);
    const mMask = foothills * smoothstep(this.rangeBias, this.rangeBias + 0.34, range * 0.62 + belt * 0.38);

    if (mMask > 0.002) {
      h += (this.ridgedEroded(x, y, z, maxFreq) * 0.86 + 0.14 * mMask) * this.ridgeAmp * mMask;
    }

    // hills: slope-damped fBm. Strong in the foothills and rugged provinces,
    // a low swell on the calm plains
    const hilliness = (0.36 + 0.64 * Math.max(mMask, belt * 0.55))
      * (1 - this.plainsCalm * 0.5 * (1 - belt)) * (0.25 + 0.75 * dry);
    h += this.hillsEroded(x, y, z, maxFreq) * this.hillAmp * hilliness;

    // ground roughness: outcrops and gullies on steep country, soft
    // undulation elsewhere; then the relief you feel on foot
    if (maxFreq > this.roughFreq) {
      const rugged = 0.3 + 0.7 * mMask;
      h += this.bandFbm(this.nB, x + 3.1, y + 7.7, z - 1.3, this.roughFreq, 6, 0.52, 2.17, maxFreq)
        * this.roughAmp * rugged * (0.2 + 0.8 * dry);
      if (maxFreq > this.microFreq) {
        h += this.bandFbm(this.nC, x - 9.2, y + 0.6, z + 4.4, this.microFreq, 4, 0.5, 2.2, maxFreq)
          * this.microAmp * (0.7 + 0.3 * rugged) * (0.3 + 0.7 * dry);
      }
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
      if (this.hasLiquid) {
        const band = smoothstep(this.seaLevel - this.hAmp * 0.45, this.seaLevel + 4, h)
          * (1 - smoothstep(this.seaLevel + this.hAmp * 0.035,
            this.seaLevel + this.hAmp * 0.09, h));
        // A river is a broad alluvial valley with a much narrower wet
        // channel. The old single profile drove the entire strip directly to
        // sea level; from orbit its steep banks became dotted black ink lines.
        // Both widths expand at coarse LOD so the carved volume remains
        // resolvable and converges continuously during approach.
        const valleyWidth = Math.max(this.canyonWidth * 2.5, 4 / maxFreq);
        const valleyT = 1 - Math.abs(cv) / valleyWidth;
        if (valleyT > 0) {
          const valleyShape = valleyT * valleyT * (3 - 2 * valleyT);
          const valleyDepth = Math.min(this.hAmp * 0.012,
            Math.max(0, h - this.seaLevel) * 0.55 + this.hAmp * 0.002);
          h -= valleyShape * valleyDepth * band;
        }
        const channelWidth = Math.max(this.canyonWidth * 0.72, 2.5 / maxFreq);
        const channelT = 1 - Math.abs(cv) / channelWidth;
        if (channelT > 0) {
          const channelShape = channelT * channelT * (3 - 2 * channelT);
          const channelTarget = this.seaLevel - this.hAmp * 0.018;
          h = lerp(h, Math.min(h, channelTarget), channelShape * band * 0.9);
        }
      } else {
        // Dry slot canyons retain their sharper geology.
        const cw = Math.max(this.canyonWidth, 2.5 / maxFreq);
        const depthScale = this.canyonWidth / cw;
        const t = 1 - Math.abs(cv) / cw;
        if (t > 0) {
          const tt = t * t * (3 - 2 * t) * depthScale;
          // dry slot canyons through the midlands
          const band = smoothstep(-this.hAmp * 0.3, 0, h)
            * (1 - smoothstep(this.hAmp * 0.45, this.hAmp * 0.8, h));
          h -= tt * this.canyonAmp * band;
        }
      }

      // tributaries: a finer branching carve feeding the main channels,
      // so valleys form dendritic drainage networks like real watersheds
      const cv2 = this.nD.fbm(x + 7.7, y - 3.3, z + 1.1, this.canyonFreq * 3.1, 3, 0.5, 2.25, maxFreq);
      const cw2 = Math.max(this.canyonWidth * (this.hasLiquid ? 0.82 : 0.55),
        2.5 / maxFreq);
      const t2 = 1 - Math.abs(cv2) / cw2;
      if (t2 > 0) {
        const tt2 = t2 * t2 * (3 - 2 * t2) * (this.canyonWidth * 0.55 / cw2);
        if (this.hasLiquid) {
          const band2 = smoothstep(this.seaLevel - this.hAmp * 0.35, this.seaLevel + 3, h) *
                        (1 - smoothstep(this.seaLevel + this.hAmp * 0.02, this.seaLevel + this.hAmp * 0.05, h));
          const tributaryTarget = this.seaLevel - this.hAmp * 0.008;
          const floodplain = Math.min(this.hAmp * 0.006, Math.max(0, h - this.seaLevel) * 0.4 + this.hAmp * 0.001);
          h -= tt2 * floodplain * band2;
          h = lerp(h, Math.min(h, tributaryTarget), tt2 * band2 * 0.68);
        } else {
          const band2 = smoothstep(-this.hAmp * 0.25, 0, h) * (1 - smoothstep(this.hAmp * 0.4, this.hAmp * 0.7, h));
          h -= tt2 * this.canyonAmp * 0.4 * band2;
        }
      }
    }

    if (this.craterAmp > 0) {
      const craterBlend = frequencyBlend(this.craterFreq * 2, maxFreq);
      if (craterBlend > 0) {
        h += this.craters(x, y, z, this.craterFreq, this.craterAmp, 0) * craterBlend;
      }
      const craterDetailBlend = frequencyBlend(this.craterFreq * 8, maxFreq);
      if (craterDetailBlend > 0) {
        h += this.craters(x, y, z, this.craterFreq * 4.7, this.craterAmp * 0.3, 1)
          * craterDetailBlend;
      }
    }

    const blobBlend = this.blobAmp > 0 ? frequencyBlend(this.blobFreq, maxFreq) : 0;
    if (blobBlend > 0) {
      const b = this.nD.billow(x + 31, y, z, this.blobFreq, 4, 0.5, 2.1, maxFreq);
      h += Math.max(0, b) * this.blobAmp * blobBlend;
    }

    const duneBlend = this.duneAmp > 0 ? frequencyBlend(this.duneFreq / 1.5, maxFreq) : 0;
    if (duneBlend > 0) {
      const wob = this.nC.noise(x * 9, y * 9, z * 9) * 2.5;
      const tdt = (x * this.duneAxis.x + y * this.duneAxis.y + z * this.duneAxis.z) * this.duneFreq + wob;
      const flat = 1 - smoothstep(this.hAmp * 0.25, this.hAmp * 0.6, Math.abs(h));
      h += (1 - Math.abs(Math.sin(tdt))) * this.duneAmp * flat * duneBlend;
    }

    const spikeBlend = this.spikeAmp > 0 ? frequencyBlend(this.spikeFreq * 3, maxFreq) : 0;
    if (spikeBlend > 0) {
      const w = worley3(x * this.spikeFreq, y * this.spikeFreq, z * this.spikeFreq, (this.intSeed ^ 0x51ce) | 0);
      const sp = Math.max(0, 1 - w.d * 1.45);
      if ((w.h & 7) < 3) {
        h += sp * sp * sp * this.spikeAmp * (0.4 + (w.h % 97) / 97 * 0.6) * spikeBlend;
      }
    }

    if (this.nOceanBasin && this.hasLiquid && h < this.seaLevel) {
      // The curated pelagic world is water-dominated but deliberately not a
      // kilometres-deep featureless bowl. An independent namespace lifts broad
      // continental shelves while leaving rarer basins/trenches, preserving
      // the exact shoreline and the small island fraction selected above.
      const basin = this.nOceanBasin.fbm(
        x + 18.7, y - 41.2, z + 7.9, 1.35, 4, 0.52, 2.08, maxFreq);
      const basinWeight = smoothstep(-0.28, 0.48, basin);
      const baseScale = Number.isFinite(this.tuning.bathymetryScale)
        ? clamp(this.tuning.bathymetryScale, 0.08, 0.7)
        : 0.24;
      const depthScale = lerp(baseScale * 0.55, baseScale * 1.55, basinWeight);
      h = this.seaLevel - (this.seaLevel - h) * depthScale;
    }

    return h;
  }

  // fBm whose every octave (the first included) waits for the sampling grid
  // to resolve it. Simplex.fbm always admits its first octave, which is right
  // for continental shapes and wrong for a detail band that starts at 300 m.
  bandFbm(noise, x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      if (maxFreq > f) {
        sum += amp * frequencyBlend(f, maxFreq) * noise.noise(x * f, y * f + o * 17.3, z * f);
      }
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return sum / norm;
  }

  // Ridged multifractal with erosion-style damping (the derivative-noise idea
  // described by Inigo Quilez): each octave is attenuated where the terrain
  // built so far is already steep, so detail collects on crests and spurs
  // while the flanks run smooth into the valleys. Only the tangential part of
  // the gradient counts: the radial part is not a slope on a sphere. Returns
  // roughly [0, 1].
  ridgedEroded(x, y, z, maxFreq) {
    let sum = 0, amp = 0.5, norm = 0, f = this.ridgeFreq, weight = 1;
    // Unwarped ridged noise closes into cell-like loops. Bending the domain
    // with a field a little longer than the ridges pulls them into ranges.
    const wf = f * 0.43, wa = 0.55 / f;
    const wx = this.nC.noise(x * wf + 11.1, y * wf, z * wf) * wa;
    const wy = this.nC.noise(x * wf, y * wf + 27.4, z * wf) * wa;
    const wz = this.nC.noise(x * wf, y * wf, z * wf + 43.9) * wa;
    x += wx; y += wy; z += wz;
    let gx = 0, gy = 0, gz = 0;
    for (let o = 0; o < 11; o++) {
      const blend = o === 0 ? 1 : frequencyBlend(f, maxFreq);
      if (blend <= 0) {
        // the remaining octaves are all above the cutoff: finish the
        // full-spectrum normalizer without sampling them
        norm += amp * (1 - Math.pow(0.56, 11 - o)) / 0.44;
        break;
      }
      const n = this.nB.noiseD(x * f, y * f - o * 13.7, z * f, _g);
      const an = Math.abs(n), sign = n < 0 ? 1 : -1;
      // C1 crest: the abs() cusp is rounded over a narrow band
      let ridge, slopeK;
      if (an < 0.12) { ridge = 1 - (0.06 + an * an / 0.24); slopeK = an / 0.12; }
      else { ridge = 1 - an; slopeK = 1; }
      const dk = 2 * ridge * slopeK * sign * weight * blend;
      const radial = _g.x * x + _g.y * y + _g.z * z;
      gx += (_g.x - radial * x) * dk;
      gy += (_g.y - radial * y) * dk;
      gz += (_g.z - radial * z) * dk;
      const v = ridge * ridge * weight;
      weight = Math.min(1, Math.max(0, v * 2));
      sum += v * amp * blend * (o === 0 ? 1 : 1 / (1 + 0.07 * (gx * gx + gy * gy + gz * gz)));
      norm += amp;
      amp *= 0.56;
      f *= 2.07;
    }
    return sum / norm;
  }

  // Slope-damped fBm for hill country, roughly [-1, 1].
  hillsEroded(x, y, z, maxFreq) {
    let sum = 0, amp = 1, norm = 0, f = this.hillFreq;
    let gx = 0, gy = 0, gz = 0;
    for (let o = 0; o < 7; o++) {
      const blend = frequencyBlend(f, maxFreq);
      if (blend <= 0) {
        norm += amp * 2 * (1 - Math.pow(0.5, 7 - o));
        break;
      }
      const n = this.nC.noiseD(x * f, y * f + o * 19.19, z * f, _g);
      const radial = _g.x * x + _g.y * y + _g.z * z;
      gx += (_g.x - radial * x) * blend;
      gy += (_g.y - radial * y) * blend;
      gz += (_g.z - radial * z) * blend;
      sum += amp * blend * n / (1 + 0.55 * (gx * gx + gy * gy + gz * gz));
      norm += amp;
      amp *= 0.5;
      f *= 2.13;
    }
    return sum / norm;
  }

  craters(x, y, z, freq, amp, lane) {
    x *= freq; y *= freq; z *= freq;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    const seed = this.intSeed + lane * 7919;
    const sites = this._craterField.neighbourhood(cx, cy, cz, seed, lane);
    let site = 0;
    let sum = 0;
    // Sum compact features instead of selecting the nearest center. Switching
    // nearest owners also switched radius/amplitude and cut cliffs across the
    // Voronoi bisectors. The largest support is < 0.67, so 27 cells suffice.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ix = cx + dx, iy = cy + dy, iz = cz + dz;
          const px = x - ix - sites[site++];
          const py = y - iy - sites[site++];
          const pz = z - iz - sites[site++];
          const radius = sites[site++];
          const weight = sites[site++];
          const distanceSquared = px * px + py * py + pz * pz;
          if (distanceSquared >= radius * radius * 2.56) continue;
          const t = Math.sqrt(distanceSquared) / radius;
          const amplitude = amp * weight;
          // Zero slope at the bowl center, raised rim, and outer support keeps
          // lighting normals continuous as well as the sampled height.
          sum += amplitude * (t < 1
            ? -1 + 1.35 * smoothstep(0, 1, t)
            : 0.35 * (1 - smoothstep(1, 1.6, t)));
        }
      }
    }
    return sum;
  }

}
