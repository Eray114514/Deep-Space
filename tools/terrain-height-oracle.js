// Frozen pre-extraction authority from 93e934f; deliberately uncached crater sum.
import { worley3, clamp, frequencyBlend, lerp, smoothstep } from '../src/noise.js';
import { hash3i, hashFloat } from '../src/rng.js';
export class TerrainHeightOracle {
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
    // Mountain provinces used to exclude 61.7% of the globe and vary their
    // amplitude by 8.3×, producing isolated "mountain islands" separated by
    // featureless plains. Broaden the continental foothill mask and keep a
    // meaningful ruggedness floor so ranges form connected regional chains.
    const foothills = smoothstep(this.mountMaskLo - 0.18, this.mountMaskHi, c);
    const mMask = foothills * (0.34 + 0.66 * belt);
    const m = this.nB.ridged(x, y, z, this.mountFreq, 6, 0.55, 2.1, maxFreq, 0.12);
    h += m * this.mountAmp * mMask;

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
      if (this.hasLiquid) {
        const band = smoothstep(this.seaLevel - this.hAmp * 0.45, this.seaLevel + 4, h)
          * (1 - smoothstep(this.seaLevel + this.hAmp * 0.30,
            this.seaLevel + this.hAmp * 0.7, h));
        // A river is a broad alluvial valley with a much narrower wet
        // channel. The old single profile drove the entire strip directly to
        // sea level; from orbit its steep banks became dotted black ink lines.
        // Both widths expand at coarse LOD so the carved volume remains
        // resolvable and converges continuously during approach.
        const valleyWidth = Math.max(this.canyonWidth * 2.5, 4 / maxFreq);
        const valleyT = 1 - Math.abs(cv) / valleyWidth;
        if (valleyT > 0) {
          const valleyShape = valleyT * valleyT * (3 - 2 * valleyT);
          const valleyDepth = this.hAmp * 0.035
            + Math.max(0, h - this.seaLevel) * 0.16;
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
                        (1 - smoothstep(this.seaLevel + this.hAmp * 0.22, this.seaLevel + this.hAmp * 0.5, h));
          const tributaryTarget = this.seaLevel - this.hAmp * 0.008;
          const floodplain = Math.max(0, h - this.seaLevel) * 0.1 + this.hAmp * 0.012;
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

  craters(x, y, z, freq, amp, lane) {
    x *= freq; y *= freq; z *= freq;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    const seed = this.intSeed + lane * 7919;
    let sum = 0;
    // Sum compact features instead of selecting the nearest center. Switching
    // nearest owners also switched radius/amplitude and cut cliffs across the
    // Voronoi bisectors. The largest support is < 0.67, so 27 cells suffice.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ix = cx + dx, iy = cy + dy, iz = cz + dz;
          const hash = hash3i(ix, iy, iz, seed);
          const px = x - ix - hashFloat(hash, 0);
          const py = y - iy - hashFloat(hash, 1);
          const pz = z - iz - hashFloat(hash, 2);
          const radius = 0.16 + ((hash >>> 4) % 64) / 64 * 0.26;
          const distanceSquared = px * px + py * py + pz * pz;
          if (distanceSquared >= radius * radius * 2.56) continue;
          const t = Math.sqrt(distanceSquared) / radius;
          const amplitude = amp * (0.35 + ((hash >>> 10) % 64) / 64 * 0.65);
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
