// Batch A root-cause harness (no browser): quantifies the terrain/LOD/noise
// claims in docs/optimization-roadmap.md 2.1 and 2.3 against the canonical
// home planet so the roadmap's "推测根因" can be confirmed or refuted with
// numbers instead of guesses. `node tools/terrainnoisediag.js`

import * as THREE from 'three';
import { Planet } from '../src/planet.js';
import { Simplex } from '../src/noise.js';
import { makeRng } from '../src/rng.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';

const F3 = 1 / 3;
const G3 = 1 / 6;

// ---------------------------------------------------------------------------
// A gradient-table-parameterised clone of src/noise.js Simplex. With the stock
// 12-vector table it must reproduce src/noise.js bit-for-bit; larger tables let
// us A/B the "12 gradients cause directional bias" hypothesis on an identical
// permutation so the only variable is the gradient set.
// ---------------------------------------------------------------------------
class SimplexTable {
  constructor(rand, grad) {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = (rand() * (i + 1)) | 0;
      const t = p[i]; p[i] = p[j]; p[j] = t;
    }
    this.perm = new Uint8Array(512);
    this.gradCount = grad.length / 3;
    this.permModN = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permModN[i] = this.perm[i] % this.gradCount;
    }
    this.grad = grad;
  }

  noise(xin, yin, zin) {
    const perm = this.perm, permModN = this.permModN, GRAD = this.grad;
    let n0 = 0, n1 = 0, n2 = 0, n3 = 0;
    const s = (xin + yin + zin) * F3;
    const i = Math.floor(xin + s), j = Math.floor(yin + s), k = Math.floor(zin + s);
    const t = (i + j + k) * G3;
    const x0 = xin - (i - t), y0 = yin - (j - t), z0 = zin - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const x1 = x0 - i1 + G3, y1 = y0 - j1 + G3, z1 = z0 - k1 + G3;
    const x2 = x0 - i2 + 2 * G3, y2 = y0 - j2 + 2 * G3, z2 = z0 - k2 + 2 * G3;
    const x3 = x0 - 1 + 3 * G3, y3 = y0 - 1 + 3 * G3, z3 = z0 - 1 + 3 * G3;
    const ii = i & 255, jj = j & 255, kk = k & 255;

    let t0 = 0.6 - x0 * x0 - y0 * y0 - z0 * z0;
    if (t0 > 0) {
      t0 *= t0;
      const g = permModN[ii + perm[jj + perm[kk]]] * 3;
      n0 = t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0 + GRAD[g + 2] * z0);
    }
    let t1 = 0.6 - x1 * x1 - y1 * y1 - z1 * z1;
    if (t1 > 0) {
      t1 *= t1;
      const g = permModN[ii + i1 + perm[jj + j1 + perm[kk + k1]]] * 3;
      n1 = t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1 + GRAD[g + 2] * z1);
    }
    let t2 = 0.6 - x2 * x2 - y2 * y2 - z2 * z2;
    if (t2 > 0) {
      t2 *= t2;
      const g = permModN[ii + i2 + perm[jj + j2 + perm[kk + k2]]] * 3;
      n2 = t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2 + GRAD[g + 2] * z2);
    }
    let t3 = 0.6 - x3 * x3 - y3 * y3 - z3 * z3;
    if (t3 > 0) {
      t3 *= t3;
      const g = permModN[ii + 1 + perm[jj + 1 + perm[kk + 1]]] * 3;
      n3 = t3 * t3 * (GRAD[g] * x3 + GRAD[g + 1] * y3 + GRAD[g + 2] * z3);
    }
    return 32.0 * (n0 + n1 + n2 + n3);
  }

  ridged(x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) {
    let sum = 0, amp = 0.5, norm = 0, f = baseFreq, weight = 1;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      let n = 1 - Math.abs(this.noise(x * f, y * f - o * 13.7, z * f));
      n *= n;
      n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp;
      norm += amp;
      amp *= gain;
      f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

const GRAD12 = new Float32Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

// Fibonacci-sphere gradients scaled to |g| = sqrt(2) so the noise keeps the
// same output range as the stock 12-vector edge-midpoint table.
function fibonacciGrad(count) {
  const out = new Float32Array(count * 3);
  const golden = Math.PI * (3 - Math.sqrt(5));
  const r = Math.SQRT2;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2;
    const rad = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    out[i * 3] = Math.cos(theta) * rad * r;
    out[i * 3 + 1] = y * r;
    out[i * 3 + 2] = Math.sin(theta) * rad * r;
  }
  return out;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function seededDirs(count, seed = 991) {
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(seed);
  const out = [];
  while (out.length < count) {
    const v = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
    const l = v.lengthSq();
    if (l < 0.01 || l > 1) continue;
    out.push(v.normalize());
  }
  return out;
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return {
    mean, sd: Math.sqrt(variance),
    p5: sorted[(n * 0.05) | 0],
    p50: sorted[(n * 0.5) | 0], p95: sorted[(n * 0.95) | 0],
    p99: sorted[(n * 0.99) | 0], max: sorted[n - 1],
  };
}

function pad(text, width) { return String(text).padEnd(width); }
function num(value, digits = 1, width = 9) {
  return String(Number(value).toFixed(digits)).padStart(width);
}

function heading(text) {
  console.log('\n' + '='.repeat(78));
  console.log(text);
  console.log('='.repeat(78));
}

// ---------------------------------------------------------------------------
// canonical home planet
// ---------------------------------------------------------------------------
const galaxy = getGalaxyConfig();
const catalog = new GalaxyCatalog(galaxy.seed);
const homeSystem = generateSystemSpec(galaxy.seed, catalog.getSystem(HOME_SYSTEM_ID));
const homeBody = homeSystem.bodies.find((b) => b.bodyId === 'planet-0');
const home = new Planet({
  seed: homeBody.seed,
  name: homeBody.name,
  posUniv: new THREE.Vector3(),
  type: homeBody.type,
  isMoon: homeBody.isMoon,
  radius: homeBody.radius,
  atmosphere: homeBody.atmosphere,
  clouds: homeBody.clouds,
  formation: homeBody.formation,
  ringSystem: homeBody.ringSystem,
  tuning: resolveBodyTuning({
    galaxyId: galaxy.id, seed: galaxy.seed,
    systemId: homeSystem.systemId, bodyId: homeBody.bodyId,
  }),
});

heading(`HOME PLANET  seed=${galaxy.seed} system=${homeSystem.systemId} body=${homeBody.bodyId}`);
console.log(`type=${home.type}  R=${home.R.toFixed(0)} m  hAmp=${home.hAmp.toFixed(0)} m  `
  + `sea=${home.seaLevel.toFixed(0)} m  contAmp=${home.contAmp.toFixed(0)} m  mountAmp=${home.mountAmp.toFixed(0)} m`);
console.log(`gridCells=${home.gridCells}  canonicalGridCells=${home.canonicalGridCells}  `
  + `maxLevel=${home.maxLevel}  canonicalMaxLevel=${home.canonicalMaxLevel}  orbitLevelCap=${home.orbitLevelCap}`);
console.log(`fullMaxFreq=${home.fullMaxFreq.toFixed(1)}  regFreq=${home.regFreq.toFixed(2)}  `
  + `contFreq=${home.contFreq.toFixed(2)}  mountFreq=${home.mountFreq.toFixed(2)}  detailFreq=${home.detailFreq.toFixed(2)}`);

// ---------------------------------------------------------------------------
// PROBE 1 — the LOD frequency ladder: how much terrain exists at each level,
// and how large the level-to-level height step (the morph amplitude) is.
// ---------------------------------------------------------------------------
heading('PROBE 1 — LOD ladder: detail retention and level-to-level height step');
{
  const dirs = seededDirs(3000, 7);
  const full = dirs.map((d) => home.height(d, home.fullMaxFreq));
  const fullStats = stats(full);
  const ladder = [];
  for (let level = 0; level <= home.maxLevel; level++) {
    const freq = home.freqAtLevel(level);
    const h = dirs.map((d) => home.height(d, freq));
    const cellRad = (Math.PI / 2) / Math.pow(2, level) / home.gridCells;
    const cellM = cellRad * home.R;
    const previous = ladder[level - 1]?.h;
    const maxMorphDelta = previous
      ? Math.max(...h.map((value, index) => Math.abs(value - previous[index])))
      : 0;
    const skirtDrop = Math.max(6, maxMorphDelta * 1.25 + 2);
    ladder.push({ level, freq, cellM, skirtDrop, h, sd: stats(h).sd });
  }
  console.log(pad('lvl', 5) + pad('maxFreq', 10) + pad('cell(m)', 11) + pad('skirt(m)', 11)
    + pad('sd(m)', 10) + pad('sd/full', 9) + pad('|Δ vs lvl-1| rms', 18) + pad('p99', 10) + 'max');
  for (let i = 0; i < ladder.length; i++) {
    const row = ladder[i];
    let deltaText = pad('-', 18) + pad('-', 10) + '-';
    if (i > 0) {
      const deltas = row.h.map((v, k) => Math.abs(v - ladder[i - 1].h[k]));
      const rms = Math.sqrt(deltas.reduce((a, b) => a + b * b, 0) / deltas.length);
      const s = stats(deltas);
      deltaText = num(rms, 1, 18) + num(s.p99, 1, 10) + num(s.max, 1, 9);
    }
    console.log(pad(row.level, 5) + num(row.freq, 1, 10) + num(row.cellM, 1, 11)
      + num(row.skirtDrop, 1, 11) + num(row.sd, 1, 10)
      + num(row.sd / fullStats.sd, 3, 9) + deltaText);
  }
  console.log(`\nfull-detail height sd = ${fullStats.sd.toFixed(1)} m  (range ${fullStats.p50.toFixed(0)} p50 / ${fullStats.max.toFixed(0)} max)`);
  const orbit = ladder[home.orbitLevelCap];
  console.log(`orbit cap level ${home.orbitLevelCap}: retains ${(orbit.sd / fullStats.sd * 100).toFixed(1)}% of the height sd, `
    + `cell ${orbit.cellM.toFixed(0)} m, skirt ${orbit.skirtDrop.toFixed(0)} m`);
  // How much of the *shape* survives: correlation with the full field.
  const oMean = orbit.h.reduce((a, b) => a + b, 0) / orbit.h.length;
  const fMean = fullStats.mean;
  let cov = 0, vo = 0, vf = 0;
  for (let i = 0; i < full.length; i++) {
    cov += (orbit.h[i] - oMean) * (full[i] - fMean);
    vo += (orbit.h[i] - oMean) ** 2; vf += (full[i] - fMean) ** 2;
  }
  console.log(`orbit-vs-full height correlation r = ${(cov / Math.sqrt(vo * vf)).toFixed(4)}`);
}

// ---------------------------------------------------------------------------
// PROBE 2 — maxFreq is a hard per-octave gate (`if (o > 0 && f > maxFreq) break`).
// Sweep maxFreq continuously and look for step discontinuities in height.
// ---------------------------------------------------------------------------
heading('PROBE 2 — hard octave cutoff: height discontinuity across a continuous maxFreq sweep');
{
  const dirs = seededDirs(400, 31);
  const lo = Math.log2(home.freqAtLevel(0));
  const hi = Math.log2(home.fullMaxFreq);
  const steps = 900;
  let worstJump = 0, worstFreq = 0;
  const jumpsByFreq = [];
  const prev = dirs.map((d) => home.height(d, Math.pow(2, lo)));
  let last = prev;
  for (let s = 1; s <= steps; s++) {
    const freq = Math.pow(2, lo + (hi - lo) * (s / steps));
    const cur = dirs.map((d) => home.height(d, freq));
    let sum = 0, mx = 0;
    for (let i = 0; i < cur.length; i++) {
      const dv = Math.abs(cur[i] - last[i]);
      sum += dv * dv; if (dv > mx) mx = dv;
    }
    const rms = Math.sqrt(sum / cur.length);
    jumpsByFreq.push({ freq, rms, mx });
    if (rms > worstJump) { worstJump = rms; worstFreq = freq; }
    last = cur;
  }
  const significant = jumpsByFreq.filter((j) => j.rms > home.hAmp * 0.002)
    .sort((a, b) => b.rms - a.rms).slice(0, 12);
  console.log(`sweep ${home.freqAtLevel(0).toFixed(1)} → ${home.fullMaxFreq.toFixed(0)} in ${steps} log steps`);
  console.log(`largest single-step rms jump = ${worstJump.toFixed(1)} m at maxFreq=${worstFreq.toFixed(1)} `
    + `(= ${(worstJump / home.hAmp * 100).toFixed(2)}% of hAmp)`);
  console.log('top discontinuities (maxFreq → rms Δh, max Δh):');
  for (const j of significant) {
    console.log(`  f=${num(j.freq, 1, 9)}   rms=${num(j.rms, 2, 8)} m   max=${num(j.mx, 1, 8)} m`);
  }
  const levelFreqs = [];
  for (let l = 0; l <= home.maxLevel; l++) levelFreqs.push(home.freqAtLevel(l));
  console.log('level maxFreq ladder: ' + levelFreqs.map((f) => f.toFixed(1)).join(', '));
}

// ---------------------------------------------------------------------------
// PROBE 3 — simplex directional bias. Gradient-orientation histogram of the
// noise field on a tangent plane, decomposed into angular harmonics. An
// isotropic field has |c_k|/c_0 ≈ 0 for all k > 0; a k-fold-biased lattice
// shows a peak at that k.
// ---------------------------------------------------------------------------
heading('PROBE 3 — noise directional bias (gradient-orientation harmonics)');
{
  const BINS = 180;
  function harmonics(sampler, { freq = 1, patches = 24, N = 220, seed = 5 }) {
    const bins = new Float64Array(BINS);
    const rnd = (s => () => (s = (s * 48271) % 2147483647) / 2147483647)(seed);
    for (let p = 0; p < patches; p++) {
      const centre = new THREE.Vector3(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      if (centre.lengthSq() < 0.05) { p--; continue; }
      centre.normalize();
      const ref = Math.abs(centre.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const tx = new THREE.Vector3().crossVectors(ref, centre).normalize();
      const ty = new THREE.Vector3().crossVectors(centre, tx).normalize();
      const span = 6 / freq;              // ~6 feature wavelengths per patch
      const step = span / N;
      const v = new THREE.Vector3();
      const at = (u, w) => {
        v.copy(centre).addScaledVector(tx, u).addScaledVector(ty, w);
        return sampler(v.x, v.y, v.z);
      };
      for (let iy = 1; iy < N - 1; iy++) {
        for (let ix = 1; ix < N - 1; ix++) {
          const u = (ix - N / 2) * step, w = (iy - N / 2) * step;
          const gx = at(u + step, w) - at(u - step, w);
          const gy = at(u, w + step) - at(u, w - step);
          const mag = Math.hypot(gx, gy);
          if (mag < 1e-9) continue;
          // gradient orientation is mod π (a ridge has no sign)
          let a = Math.atan2(gy, gx);
          if (a < 0) a += Math.PI;
          if (a >= Math.PI) a -= Math.PI;
          bins[Math.min(BINS - 1, (a / Math.PI * BINS) | 0)] += mag;
        }
      }
    }
    const c0 = bins.reduce((a, b) => a + b, 0) / BINS;
    const harm = {};
    for (const k of [2, 3, 4, 6, 8, 12]) {
      let re = 0, im = 0;
      for (let i = 0; i < BINS; i++) {
        // orientation is π-periodic: k harmonics of the π-period signal
        const ang = (i + 0.5) / BINS * Math.PI * 2 * k;
        re += bins[i] * Math.cos(ang); im += bins[i] * Math.sin(ang);
      }
      harm[k] = Math.hypot(re, im) / BINS / c0;
    }
    const mn = Math.min(...bins), mx = Math.max(...bins);
    return { harm, spread: (mx - mn) / c0 };
  }

  const rows = [];
  for (const count of [12, 24, 48, 96]) {
    const grad = count === 12 ? GRAD12 : fibonacciGrad(count);
    const s = new SimplexTable(makeRng('diag:grad'), grad);
    if (count === 12) {
      // sanity: the 12-entry clone must equal src/noise.js exactly
      const ref = new Simplex(makeRng('diag:grad'));
      let worst = 0;
      for (let i = 0; i < 5000; i++) {
        const x = i * 0.137, y = i * 0.211, z = i * 0.077;
        worst = Math.max(worst, Math.abs(ref.noise(x, y, z) - s.noise(x, y, z)));
      }
      console.log(`clone check vs src/noise.js Simplex: max |Δ| = ${worst.toExponential(2)} (must be 0)`);
    }
    const rawFreq = home.mountFreq;
    const raw = harmonics((x, y, z) => s.noise(x * rawFreq, y * rawFreq, z * rawFreq), { freq: rawFreq });
    const rid = harmonics((x, y, z) => s.ridged(x, y, z, home.mountFreq, 6, 0.55, 2.1, 1e9),
      { freq: home.mountFreq });
    rows.push({ count, raw, rid });
  }
  const fmt = (h) => [2, 3, 4, 6, 8, 12].map((k) => `c${k}=${(h.harm[k] * 100).toFixed(2)}%`).join(' ');
  console.log('\nraw simplex noise, gradient-orientation harmonics (lower = more isotropic):');
  for (const r of rows) console.log(`  grads=${pad(r.count, 4)} spread=${num(r.raw.spread * 100, 1, 7)}%  ${fmt(r.raw)}`);
  console.log('\nridged() multifractal (the mountain-crest field):');
  for (const r of rows) console.log(`  grads=${pad(r.count, 4)} spread=${num(r.rid.spread * 100, 1, 7)}%  ${fmt(r.rid)}`);
}

// ---------------------------------------------------------------------------
// PROBE 4 — province mask hardness. `belt` gates where mountains exist; if the
// mask boundary is a sharp isoline the mountain field terminates on a curve.
// ---------------------------------------------------------------------------
heading('PROBE 4 — province (belt) mask: boundary sharpness and mountain termination');
{
  const smoothstep = (a, b, v) => {
    const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const beltAt = (d) => {
    const reg = home.nD.fbm(d.x + 53.1, d.y - 17.7, d.z + 29.3, home.regFreq, 2, 0.5, 2.1, home.fullMaxFreq);
    return { reg, belt: smoothstep(-0.32 + home.beltBias, 0.34 + home.beltBias, reg) };
  };
  const dirs = seededDirs(20000, 17);
  const belts = dirs.map((d) => beltAt(d).belt);
  const inBand = belts.filter((b) => b > 0.02 && b < 0.98).length / belts.length;
  const hard0 = belts.filter((b) => b <= 0.02).length / belts.length;
  const hard1 = belts.filter((b) => b >= 0.98).length / belts.length;
  console.log(`belt: ${(hard0 * 100).toFixed(1)}% fully calm, ${(hard1 * 100).toFixed(1)}% fully rugged, `
    + `${(inBand * 100).toFixed(1)}% in the transition band`);
  console.log(`beltBias=${home.beltBias.toFixed(3)}  regFreq=${home.regFreq.toFixed(3)}  `
    + `→ smoothstep window ${(-0.32 + home.beltBias).toFixed(3)} … ${(0.34 + home.beltBias).toFixed(3)}`);

  // transition width in metres along the surface: walk a great circle and
  // measure the arc length spent inside the 0.05–0.95 band.
  const probe = new THREE.Vector3();
  const widths = [];
  for (let t = 0; t < 40; t++) {
    const base = dirs[t * 97 % dirs.length];
    const ref = Math.abs(base.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const axis = new THREE.Vector3().crossVectors(ref, base).normalize();
    let prev = null, entered = null;
    for (let s = 0; s < 4000; s++) {
      const ang = s * 4e-4;
      probe.copy(base).applyAxisAngle(axis, ang);
      const b = beltAt(probe).belt;
      if (prev !== null) {
        if (prev < 0.05 && b >= 0.05) entered = ang;
        if (entered !== null && prev < 0.95 && b >= 0.95) {
          widths.push((ang - entered) * home.R); entered = null;
        }
        if (entered !== null && b < 0.05) entered = null;
      }
      prev = b;
    }
  }
  if (widths.length) {
    const s = stats(widths);
    console.log(`belt 5%→95% transition width along the surface: median ${(s.p50 / 1000).toFixed(1)} km, `
      + `mean ${(s.mean / 1000).toFixed(1)} km, min ${(Math.min(...widths) / 1000).toFixed(1)} km  (n=${widths.length})`);
  } else {
    console.log('belt transition width: no crossings sampled');
  }

  // Mountain amplitude is mMask-gated. Report how abruptly the *height* the
  // mountains contribute falls off across the belt boundary.
  const mMaskAt = (d) => {
    const { belt } = beltAt(d);
    const wf = home.warpFreq, wa = home.warpAmp;
    const ax = d.x + home.nB.noise(d.x * wf + 31.4, d.y * wf, d.z * wf) * wa;
    const ay = d.y + home.nB.noise(d.x * wf, d.y * wf + 47.2, d.z * wf) * wa;
    const az = d.z + home.nB.noise(d.x * wf, d.y * wf, d.z * wf + 71.7) * wa;
    const c = home.nA.fbm(ax, ay, az, home.contFreq, 4, 0.52, 2.05, home.fullMaxFreq);
    return smoothstep(home.mountMaskLo - 0.18, home.mountMaskHi, c) * (0.34 + 0.66 * belt);
  };
  const masks = dirs.slice(0, 6000).map(mMaskAt);
  const mStats = stats(masks);
  console.log(`mMask: mean ${mStats.mean.toFixed(3)}, p50 ${mStats.p50.toFixed(3)}, p95 ${mStats.p95.toFixed(3)}, `
    + `max ${mStats.max.toFixed(3)}; ${(masks.filter((m) => m <= 0.002).length / masks.length * 100).toFixed(1)}% effectively mountain-free`);
  console.log(`mountain height at mMask=1 is ${home.mountAmp.toFixed(0)} m; the belt term alone scales it `
    + `between ${(home.mountAmp * 0.34).toFixed(0)} m and ${home.mountAmp.toFixed(0)} m (2.9× swing)`);
}

// ---------------------------------------------------------------------------
// PROBE 5 — the ocean seen from orbit. Depth-driven absorption saturates; once
// it does, every deep-water pixel resolves to one constant colour.
// ---------------------------------------------------------------------------
heading('PROBE 5 — ocean: depth absorption saturation and orbital colour spread');
{
  const dirs = seededDirs(20000, 61);
  const depths = [];
  for (const d of dirs) {
    const h = home.height(d, home.fullMaxFreq);
    if (h < home.seaLevel) depths.push(home.seaLevel - h);
  }
  const s = stats(depths);
  console.log(`ocean covers ${(depths.length / dirs.length * 100).toFixed(1)}% of the sphere; `
    + `depth median ${s.p50.toFixed(0)} m, p95 ${s.p95.toFixed(0)} m, max ${s.max.toFixed(0)} m`);
  // shaders-node.js applyWaterWaves: absorption = 1 - exp(-0.05 * depth)
  const absorption = (depth) => 1 - Math.exp(-0.05 * depth);
  for (const q of [0.9, 0.99, 0.999]) {
    const dq = -Math.log(1 - q) / 0.05;
    console.log(`  absorption reaches ${(q * 100).toFixed(1)}% at depth ${dq.toFixed(1)} m `
      + `→ ${(depths.filter((d) => d >= dq).length / depths.length * 100).toFixed(1)}% of the ocean is past it`);
  }
  const a = depths.map(absorption);
  console.log(`  absorption over the real depth field: mean ${stats(a).mean.toFixed(4)}, `
    + `sd ${stats(a).sd.toExponential(2)} → the deep/shallow colour lerp is effectively constant`);
  // The water LOD samples only sea-floor depth; its own surface is height 0.
  console.log(`  waterLod canonical grid = ${home.waterLod ? home.waterLod.planet.canonicalGridCells : 'n/a'}, `
    + `surface height() is the constant 0 shell (planet.js), so the ocean mesh carries no relief at any level`);
  // bakeDepth caps the sampled frequency at 128 (planet.js) — check what that
  // does to the depth attribute the shader shades with.
  const coarse = [];
  for (const d of dirs.slice(0, 6000)) {
    const hFull = home.height(d, home.fullMaxFreq);
    if (hFull >= home.seaLevel) continue;
    coarse.push(Math.max(0, home.seaLevel - home.height(d, 128)));
  }
  console.log(`  aDepth is baked at maxFreq=128: median ${stats(coarse).p50.toFixed(0)} m `
    + `vs ${s.p50.toFixed(0)} m at full detail`);
}

// ---------------------------------------------------------------------------
// PROBE 6 — crest sharpness. `ridged()` builds crests from `1 - |n|`, a C0
// crease: the derivative flips sign across a curve of zero width, at EVERY
// octave including the coarsest. A triangle mesh can only render such a crest
// as a zigzag between whichever vertices happen to straddle it — which is what
// a "sawtooth ridge" is. Measure it as midpoint interpolation error: a
// band-limited field interpolates cheaply, a creased one does not.
// A/B against a smooth-abs crest, `1 - sqrt(n² + k²)` renormalised, where k is
// tied to the sampling rate.
// ---------------------------------------------------------------------------
heading('PROBE 6 — crest sharpness: midpoint interpolation error of the mountain field');
{
  const nB = home.nB;
  const ridgedSmooth = (x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq, soft) => {
    let sum = 0, amp = 0.5, norm = 0, f = baseFreq, weight = 1;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      const raw = nB.noise(x * f, y * f - o * 13.7, z * f);
      // smooth-abs: identical to |n| away from the crest, rounded within `soft`
      const softAbs = Math.sqrt(raw * raw + soft * soft) - soft;
      let n = 1 - softAbs / (1 - soft);
      n *= n; n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp; norm += amp; amp *= gain; f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  };

  const measure = (field, level) => {
    const cellAngle = (Math.PI / 2) / Math.pow(2, level) / home.gridCells;
    const errors = [], values = [];
    const a = new THREE.Vector3(), b = new THREE.Vector3(), m = new THREE.Vector3();
    const bases = seededDirs(120, 3 + level);
    for (const base of bases) {
      const ref = Math.abs(base.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      const axis = new THREE.Vector3().crossVectors(ref, base).normalize();
      for (let s = 0; s < 60; s++) {
        a.copy(base).applyAxisAngle(axis, s * cellAngle);
        b.copy(base).applyAxisAngle(axis, (s + 1) * cellAngle);
        m.copy(base).applyAxisAngle(axis, (s + 0.5) * cellAngle);
        const va = field(a), vb = field(b), vm = field(m);
        errors.push(Math.abs(vm - (va + vb) / 2));
        values.push(vm);
      }
    }
    return { err: stats(errors), sd: stats(values).sd };
  };

  console.log(pad('lvl', 5) + pad('cell(m)', 10) + pad('field', 26)
    + pad('mid-err rms/sd', 16) + pad('p99/sd', 10) + 'peak err (m of relief)');
  for (const level of [2, 4, 6, 8]) {
    const cellAngle = (Math.PI / 2) / Math.pow(2, level) / home.gridCells;
    const maxFreq = home.freqAtLevel(level);
    const variants = [
      ['ridged() as shipped', (d) => home.nB.ridged(d.x, d.y, d.z, home.mountFreq, 6, 0.55, 2.1, maxFreq)],
      ['smooth-abs soft=0.03', (d) => ridgedSmooth(d.x, d.y, d.z, home.mountFreq, 6, 0.55, 2.1, maxFreq, 0.03)],
      ['smooth-abs soft=0.10', (d) => ridgedSmooth(d.x, d.y, d.z, home.mountFreq, 6, 0.55, 2.1, maxFreq, 0.10)],
    ];
    for (const [label, field] of variants) {
      const r = measure(field, level);
      console.log(pad(level, 5) + num(cellAngle * home.R, 0, 10) + '  ' + pad(label, 24)
        + num(r.err.mean / r.sd, 4, 16) + num(r.err.p99 / r.sd, 4, 10)
        + num(r.err.max * home.mountAmp, 0, 12) + ' m');
    }
  }
  console.log('\nA band-limited field interpolates almost exactly (err/sd → 0). A creased one does not:');
  console.log('the residual is the vertical zigzag the mesh renders along every crest line.');
}

// ---------------------------------------------------------------------------
// PROBE 7 — the hard octave gate vs a smooth octave fade. `if (f > maxFreq)
// break` admits an octave at 100% amplitude and then drops it to 0%. Fading the
// last octave over one octave of headroom should collapse the LOD pop measured
// in PROBE 2 without touching the coarse shape.
// ---------------------------------------------------------------------------
heading('PROBE 7 — hard octave gate vs smooth octave fade (candidate fix A/B)');
{
  const nB = home.nB, nC = home.nC;
  const ridgedHard = (x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) => {
    let sum = 0, amp = 0.5, norm = 0, f = baseFreq, weight = 1;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      let n = 1 - Math.abs(nB.noise(x * f, y * f - o * 13.7, z * f));
      n *= n; n *= weight;
      weight = Math.min(1, Math.max(0, n * 2));
      sum += n * amp; norm += amp; amp *= gain; f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  };
  const fbmHard = (x, y, z, baseFreq, octaves, gain, lacunarity, maxFreq) => {
    let sum = 0, amp = 1, norm = 0, f = baseFreq;
    for (let o = 0; o < octaves; o++) {
      if (o > 0 && f > maxFreq) break;
      sum += amp * nC.noise(x * f, y * f + o * 19.19, z * f);
      norm += amp; amp *= gain; f *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  };

  const sweep = (field, label, amp) => {
    const dirs = seededDirs(500, 77);
    const lo = Math.log2(home.freqAtLevel(0)), hi = Math.log2(home.fullMaxFreq);
    const steps = 700;
    let last = dirs.map((d) => field(d, Math.pow(2, lo)));
    let worstRms = 0, worstMax = 0, worstFreq = 0;
    for (let s = 1; s <= steps; s++) {
      const freq = Math.pow(2, lo + (hi - lo) * (s / steps));
      const cur = dirs.map((d) => field(d, freq));
      let sum = 0, mx = 0;
      for (let i = 0; i < cur.length; i++) {
        const dv = Math.abs(cur[i] - last[i]);
        sum += dv * dv; if (dv > mx) mx = dv;
      }
      const rms = Math.sqrt(sum / cur.length);
      if (rms > worstRms) { worstRms = rms; worstFreq = freq; worstMax = mx; }
      last = cur;
    }
    console.log(`  ${pad(label, 34)} worst step: rms ${num(worstRms * amp, 2, 9)} m  `
      + `max ${num(worstMax * amp, 1, 9)} m  at f=${worstFreq.toFixed(1)}`);
    return worstRms * amp;
  };

  console.log('mountain field (ridged, amplitude ' + home.mountAmp.toFixed(0) + ' m):');
  const rHard = sweep((d, f) => ridgedHard(d.x, d.y, d.z, home.mountFreq, 6, 0.55, 2.1, f),
    'old hard gate', home.mountAmp);
  const rSoft = sweep((d, f) => home.nB.ridged(d.x, d.y, d.z, home.mountFreq, 6, 0.55, 2.1, f),
    'fixed intact weight chain + fade', home.mountAmp);
  console.log(`  → ${(100 - rSoft / rHard * 100).toFixed(1)}% reduction in the worst LOD step\n`);

  const detailAmp = home.detailAmp * 1.25;
  console.log('detail field (fbm on nC, amplitude ' + detailAmp.toFixed(0) + ' m):');
  const dHard = sweep((d, f) => fbmHard(d.x, d.y, d.z, home.detailFreq, 6, 0.5, 2.2, f),
    'old hard gate', detailAmp);
  const dSoft = sweep((d, f) => home.nC.fbm(d.x, d.y, d.z, home.detailFreq, 6, 0.5, 2.2, f),
    'fixed smooth octave fade', detailAmp);
  console.log(`  → ${(100 - dSoft / dHard * 100).toFixed(1)}% reduction in the worst LOD step`);
}

// ---------------------------------------------------------------------------
// PROBE 8 — what the orbital screenshot actually shows. Two candidates the
// roadmap never considered: the relief is enormous relative to the radius (so
// the silhouette is a crumpled ball at ANY LOD), and the land is shattered into
// archipelagos rather than continents.
// ---------------------------------------------------------------------------
heading('PROBE 8 — relief-to-radius ratio and silhouette roughness');
{
  const dirs = seededDirs(30000, 137);
  let hMin = Infinity, hMax = -Infinity;
  for (const d of dirs) {
    const h = home.height(d, home.fullMaxFreq);
    if (h < hMin) hMin = h;
    if (h > hMax) hMax = h;
  }
  const relief = hMax - hMin;
  console.log(`home: R = ${(home.R / 1000).toFixed(1)} km, relief = ${(relief / 1000).toFixed(2)} km `
    + `→ relief/R = ${(relief / home.R * 100).toFixed(2)}%`);
  const REAL = [
    ['Earth', 6371000, 8848 + 10935], ['Mars', 3389500, 21900 + 7150],
    ['Moon', 1737400, 10800 + 9060], ['Vesta (small, lumpy)', 262700, 22500],
  ];
  for (const [name, r, rel] of REAL) {
    console.log(`  ${pad(name, 22)} R = ${pad((r / 1000).toFixed(0) + ' km', 10)} `
      + `relief/R = ${(rel / r * 100).toFixed(3)}%   (home is ${(relief / home.R / (rel / r)).toFixed(1)}× this)`);
  }

  // Silhouette: from a camera at 1.72 R (the orbit screenshot distance), walk
  // the limb great circle and convert the radius wobble into screen pixels.
  const camDist = home.R * 1.72;
  const fovY = 60 * Math.PI / 180, screenH = 1080;
  const pxPerRad = screenH / (2 * Math.tan(fovY / 2));
  const base = new THREE.Vector3(0, 0, 1), axis = new THREE.Vector3(0, 1, 0);
  const limb = new THREE.Vector3();
  const angles = [];
  for (let i = 0; i < 2000; i++) {
    limb.set(Math.cos(i / 2000 * Math.PI * 2), Math.sin(i / 2000 * Math.PI * 2), 0).normalize();
    const r = home.R + home.height(limb, home.fullMaxFreq);
    angles.push(Math.asin(Math.min(1, r / camDist)));
  }
  void base; void axis;
  const aStats = stats(angles);
  const pk = (Math.max(...angles) - Math.min(...angles)) * pxPerRad;
  console.log(`\nsilhouette at ${(camDist / 1000).toFixed(0)} km (1080p, 60° FOV):`);
  console.log(`  disc radius ≈ ${(aStats.mean * pxPerRad).toFixed(0)} px, `
    + `limb wobble sd = ${(aStats.sd * pxPerRad).toFixed(1)} px, peak-to-peak = ${pk.toFixed(1)} px`);
  console.log(`  → the horizon deviates from a circle by ±${(pk / 2).toFixed(0)} px on a `
    + `${(aStats.mean * pxPerRad * 2).toFixed(0)} px disc (${(pk / (aStats.mean * pxPerRad * 2) * 100).toFixed(1)}% of the diameter)`);
  const earthPk = (10935 + 8848) / 6371000 * Math.asin(1 / 1.72) * 0 + 0;
  void earthPk;
  console.log(`  Earth at the same framing would wobble ≈ `
    + `${((8848 + 10935) / 6371000 * aStats.mean * pxPerRad / Math.tan(aStats.mean)).toFixed(2)} px`);
}

heading('PROBE 9 — land fragmentation: are there continents or archipelagos?');
{
  // Equirectangular land mask with longitude wraparound and polar row merging.
  const W = 720, H = 360;
  const land = new Uint8Array(W * H);
  const area = new Float64Array(H);
  const d = new THREE.Vector3();
  for (let y = 0; y < H; y++) {
    const lat = (0.5 - (y + 0.5) / H) * Math.PI;
    area[y] = Math.cos(lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2;
      d.set(Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      land[y * W + x] = home.height(d, home.freqAtLevel(4)) > home.seaLevel ? 1 : 0;
    }
  }
  const seen = new Int32Array(W * H).fill(-1);
  const masses = [];
  const stack = [];
  for (let i = 0; i < W * H; i++) {
    if (!land[i] || seen[i] >= 0) continue;
    const id = masses.length;
    let a = 0, cells = 0;
    stack.length = 0; stack.push(i); seen[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const py = (p / W) | 0, px = p % W;
      a += area[py]; cells++;
      const neighbours = [
        py * W + (px + 1) % W, py * W + (px + W - 1) % W,
        py > 0 ? (py - 1) * W + px : -1, py < H - 1 ? (py + 1) * W + px : -1,
      ];
      for (const n of neighbours) {
        if (n < 0 || !land[n] || seen[n] >= 0) continue;
        seen[n] = id; stack.push(n);
      }
    }
    masses.push({ a, cells });
  }
  const totalLand = masses.reduce((s, m) => s + m.a, 0);
  const totalArea = area.reduce((s, v) => s + v, 0) * W;
  masses.sort((x, y) => y.a - x.a);
  console.log(`land covers ${(totalLand / totalArea * 100).toFixed(1)}% of the surface, `
    + `split into ${masses.length} disconnected landmasses`);
  console.log('largest landmasses as a share of all land:');
  let cum = 0;
  for (let i = 0; i < Math.min(8, masses.length); i++) {
    cum += masses[i].a / totalLand;
    console.log(`  #${i + 1}: ${(masses[i].a / totalLand * 100).toFixed(1)}%  (cumulative ${(cum * 100).toFixed(1)}%)`);
  }
  const tiny = masses.filter((m) => m.a / totalLand < 0.002).length;
  console.log(`${tiny} of ${masses.length} landmasses are each below 0.2% of the land area `
    + `(${(masses.filter((m) => m.a / totalLand < 0.002).reduce((s, m) => s + m.a, 0) / totalLand * 100).toFixed(1)}% of land in specks)`);
  console.log('\nEarth for scale: 7 continents hold ~94% of land; the largest (Afro-Eurasia) is ~57%.');
}

// ---------------------------------------------------------------------------
// PROBE 10 — verification of the 2.3 fix. Re-runs PROBE 5's measurement against
// the per-channel transfer now in shaders-node.js applyWaterWaves, over the
// same real depth field, and reports the colour actually produced at each depth
// quantile. The old model's failure was a *spread* failure (sd 0.0722), so the
// pass criterion is spread, not any particular hue.
// ---------------------------------------------------------------------------
heading('PROBE 10 — ocean colour after the per-channel rewrite');
{
  const dirs = seededDirs(20000, 61);
  const depths = [];
  for (const d of dirs) {
    const h = home.height(d, home.fullMaxFreq);
    if (h < home.seaLevel) depths.push(home.seaLevel - h);
  }
  depths.sort((a, b) => a - b);

  // Mirror of shaders-node.js applyWaterWaves, exactly as written.
  const deep = home.pal?.sea?.[0]?.c?.clone()
    .lerp(home.liquidColor, 0.35) || new THREE.Color(0x061b35);
  const shallow = home.pal?.sea?.length
    ? home.pal.sea[home.pal.sea.length - 1].c.clone()
    : home.liquidColor.clone().lerp(new THREE.Color(1, 1, 1), 0.12);
  const depthScale = Math.max(60,
    (home.seaLevel + home.hAmp * 0.6) * (home.waterStyle?.clarity || 1));
  const k = [1.8, 1.2, 0.6].map((c) => c * 2.3 / (0.9 * depthScale));
  const transmit = (depth) => {
    const clampedDepth = Math.max(0, depth);
    const hazeT = Math.min(1, clampedDepth / (depthScale * 0.4));
    const depthHaze = hazeT * hazeT * (3 - 2 * hazeT) * 0.9;
    return k.map((kc) => Math.exp(-2 * kc * clampedDepth) * (1 - depthHaze));
  };
  const bodyWater = (depth) => {
    const t = transmit(depth);
    return [
      deep.r + (shallow.r - deep.r) * t[0],
      deep.g + (shallow.g - deep.g) * t[1],
      deep.b + (shallow.b - deep.b) * t[2],
    ];
  };
  console.log(`depthScale ${depthScale.toFixed(0)} m (measured max depth ${depths[depths.length - 1].toFixed(0)} m); `
    + `k = [${k.map((c) => c.toExponential(2)).join(', ')}] /m`);
  console.log(`e-fold depth per channel: R ${(1 / (2 * k[0])).toFixed(1)} m, `
    + `G ${(1 / (2 * k[1])).toFixed(1)} m, B ${(1 / (2 * k[2])).toFixed(0)} m`);
  for (const ch of [0, 1, 2]) {
    const t = depths.map((d) => transmit(d)[ch]);
    const st = stats(t);
    const name = 'RGB'[ch];
    const d99 = -Math.log(0.01) / (2 * k[ch]);
    console.log(`  ${name}: transmit mean ${st.mean.toFixed(4)}, sd ${st.sd.toFixed(4)}, `
      + `p5 ${st.p5.toFixed(4)}, p95 ${st.p95.toFixed(4)}; 99% absorbed at ${d99.toFixed(0)} m `
      + `→ ${(depths.filter((d) => d >= d99).length / depths.length * 100).toFixed(1)}% of the ocean past it`);
  }
  // The roadmap target is stated on the single mixing factor the old model had.
  // Its like-for-like successor is the luminance of the effective water-column
  // transfer (spectral absorption plus the shader's suspended-particle haze).
  const lum = depths.map((d) => {
    const t = transmit(d);
    return 0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2];
  });
  const ls = stats(lum.map((v) => 1 - v));
  console.log(`  combined (1 − luminance of effective transmit), the direct analogue of the old scalar: `
    + `mean ${ls.mean.toFixed(4)}, sd ${ls.sd.toFixed(4)}  [target sd ≥ 0.25]`);
  const q = (f) => depths[Math.min(depths.length - 1, Math.floor(f * depths.length))];
  console.log('  colour at depth quantiles (linear RGB, before sky/Fresnel/foam):');
  for (const f of [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0]) {
    const d = q(f), c = bodyWater(d);
    console.log(`    p${(f * 100).toFixed(0).padStart(3)} = ${d.toFixed(0).padStart(4)} m  `
      + `rgb(${c.map((v) => v.toFixed(3)).join(', ')})`);
  }
  // Perceptual separation between quantiles: with the old model every pair was
  // ~0 apart. Report the worst adjacent-quantile gap so a regression shows up.
  const cs = [0, 0.05, 0.25, 0.5, 0.75, 0.95, 1.0].map((f) => bodyWater(q(f)));
  let worst = Infinity;
  for (let i = 1; i < cs.length; i++) {
    const dist = Math.hypot(cs[i][0] - cs[i - 1][0], cs[i][1] - cs[i - 1][1], cs[i][2] - cs[i - 1][2]);
    worst = Math.min(worst, dist);
  }
  console.log(`  smallest gap between adjacent quantile colours: ${worst.toFixed(4)} `
    + `(linear-RGB euclidean; the old model gave ~0 across the whole p25–p100 range)`);
  // Swell geometry: what the displacement is worth in screen pixels near ground.
  const seaState = home.waterStyle?.swell || 1;
  const A = (2.2 + 1.1 + 0.5) * seaState;
  console.log(`\nswell peak displacement ${A.toFixed(1)} m (was 0.47 m); `
    + `max slope ${(2 * Math.PI * 2.2 * seaState / 393 * 100).toFixed(1)}% for the 393 m component`);
}

home.dispose();
console.log('\nterrainnoisediag: done\n');
