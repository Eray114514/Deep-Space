// Offline 48 kHz stereo PCM weapon & foley sound synthesizers ported and adapted
// from Golden Hour (`eZ` in `dist/game.js`), matching the exact `{ sr, ch, loop }`
// contract of `renderSound` in `src/saltline/sfx-generators.js`.

const TAU = Math.PI * 2;
const SR_DEFAULT = 48000;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Deterministic mulberry32 PRNG & FNV-1a string seed (identical to Golden Hour's `Pg` / `Iw`)
function makePrng(seed) {
  let t = seed >>> 0;
  const next = () => {
    t = (t + 0x6d2b79f5) | 0;
    let e = Math.imul(t ^ (t >>> 15), 1 | t);
    e = (e + Math.imul(e ^ (e >>> 7), 61 | e)) ^ e;
    return ((e ^ (e >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (a, b) => a + (b - a) * next();
  next.int = (a, b) => Math.floor(a + (b - a + 1) * next());
  return next;
}

function hashSeed(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function whiteNoise(len, rng) {
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = rng() * 2 - 1;
  return out;
}

function brownNoise(len, rng) {
  const out = new Float32Array(len);
  let acc = 0;
  let peak = 1e-6;
  for (let i = 0; i < len; i++) {
    acc = (acc + 0.025 * (rng() * 2 - 1)) / 1.025;
    out[i] = acc;
    const a = Math.abs(acc);
    if (a > peak) peak = a;
  }
  const g = 0.92 / peak;
  for (let i = 0; i < len; i++) out[i] *= g;
  return out;
}

// Zero-delay-feedback State Variable Filter (`rn` from Golden Hour):
// mode: 0 = LP, 1 = HP, 2 = BP, 3 = Peaking
const SVF_LP = 0;
const SVF_HP = 1;
const SVF_BP = 2;
const SVF_PEAK = 3;

function svfFilter(buf, sr, mode, f0, q = 0.707, f1 = 0, sweepDur = 0, peakGain = 0) {
  const n = buf.length;
  const k = 1 / Math.max(0.05, q);
  const nyq = sr * 0.45;
  const sweeping = f1 > 0 && sweepDur > 0;
  const decay = sweeping ? Math.exp(-16 / (sr * sweepDur)) : 1;
  let ic1 = 0, ic2 = 0, g = 0, a1 = 0, a2 = 0, a3 = 0;
  let df = sweeping ? f0 - f1 : 0;

  const setFreq = (hz) => {
    g = Math.tan((Math.PI * clamp(hz, 12, nyq)) / sr);
    a1 = 1 / (1 + g * (g + k));
    a2 = g * a1;
    a3 = g * a2;
  };
  setFreq(f0);

  for (let i = 0; i < n; i++) {
    if (sweeping && (i & 15) === 0) {
      setFreq(f1 + df);
      df *= decay;
    }
    const v3 = buf[i] - ic2;
    const v1 = a1 * ic1 + a2 * v3;
    const v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1;
    ic2 = 2 * v2 - ic2;
    buf[i] = mode === SVF_LP ? v2
      : mode === SVF_HP ? buf[i] - k * v1 - v2
      : mode === SVF_BP ? k * v1
      : buf[i] + peakGain * k * v1;
  }
  return buf;
}

function peakAbs(buf) {
  let m = 0;
  for (let i = 0; i < buf.length; i++) {
    const a = Math.abs(buf[i]);
    if (a > m) m = a;
  }
  return m;
}

function rmsSlice(buf, start = 0, end = buf.length) {
  let sum = 0;
  for (let i = start; i < end; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / Math.max(1, end - start));
}

function scaleInPlace(buf, gain) {
  for (let i = 0; i < buf.length; i++) buf[i] *= gain;
  return buf;
}

function applyADEnv(buf, sr, atk, dec, tailDec = 0, tailMix = 0) {
  const kA = atk > 0 ? Math.exp(-1 / (sr * atk)) : 0;
  const kD = Math.exp(-1 / (sr * Math.max(1e-5, dec)));
  const kT = tailDec > 0 ? Math.exp(-1 / (sr * tailDec)) : 0;
  let a = 1;
  let d = 1 - tailMix;
  let t = tailMix;
  for (let i = 0; i < buf.length; i++) {
    buf[i] *= (1 - a) * (d + t);
    a *= kA;
    d *= kD;
    t *= kT;
  }
  return buf;
}

function mixInto(dst, src, gain = 1, offset = 0) {
  const end = Math.min(src.length, dst.length - offset);
  for (let i = 0; i < end; i++) dst[offset + i] += src[i] * gain;
}

function addModalSine(bufL, sr, offset, hz, dec, gainL, bufR = null, gainR = 0) {
  if (hz > sr * 0.45 || offset >= bufL.length || offset < 0) return;
  const w = (TAU * hz) / sr;
  const r = Math.exp(-1 / (sr * Math.max(1e-5, dec)));
  const a1 = 2 * r * Math.cos(w);
  const a2 = r * r;
  const len = Math.min(bufL.length - offset, Math.ceil(sr * dec * 7));
  let y1 = 0;
  let y0 = Math.sin(w);
  for (let i = 0; i < len; i++) {
    bufL[offset + i] += y0 * gainL;
    if (bufR) bufR[offset + i] += y0 * gainR;
    const yn = a1 * y0 - a2 * y1;
    y1 = y0;
    y0 = yn;
  }
}

function softDrive(buf, drive, normRef) {
  if (normRef <= 1e-9) return buf;
  const invTanh = 1 / Math.tanh(drive);
  const k = drive / normRef;
  for (let i = 0; i < buf.length; i++) buf[i] = Math.tanh(buf[i] * k) * invTanh;
  return buf;
}

function fadeEdges(buf, sr, fadeInSec = 0.0003, fadeOutSec = 0.014) {
  const nIn = Math.min(buf.length, Math.floor(sr * fadeInSec));
  const nOut = Math.min(buf.length, Math.floor(sr * fadeOutSec));
  for (let i = 0; i < nIn; i++) buf[i] *= i / nIn;
  for (let i = 0; i < nOut; i++) buf[buf.length - 1 - i] *= i / nOut;
  return buf;
}

// ------------------------------------------------ Golden Hour gun profiles (`gu` / `I$`)

const GUN_PROFILES = {
  ar: {
    len: 0.48, width: 0.32, pulseT: 21e-5, pulse: 1, atk: 12e-5, drive: 2.23,
    bands: [
      [250, 800, 0.026, 0.492, 0.065, 0.3],
      [800, 2500, 0.014, 0.574, 0.04, 0.15],
      [2500, 6000, 0.0065, 0.995, 0.02, 0.1],
      [6000, 15000, 0.0032, 0.0339, 0, 0],
    ],
    res: [[540, 1.3, 0.9], [1350, 1.6, 0.5]],
    th: { f0: 172, f1: 72, ft: 0.017, a: 0.0042, d: 0.055, g: 0.359 },
    boom: { f: 230, d: 0.055, g: 0.179 },
    mech: [
      { t: 0.027, g: 0.085, f: [2150, 3420, 5300], d: 0.0065, click: 3500, thunk: 0.6, ring: 1830 },
      { t: 0.061, g: 0.05, f: [2700, 4300], d: 0.0045, click: 4300, thunk: 0.25 },
    ],
    spring: { f: 742, d: 0.055, g: 0.012 },
    sup: {
      len: 0.38, atk: 0.0011, drive: 2.43, mech: 2.6,
      bands: [
        [250, 800, 0.0162, 0.655, 0.0455, 0.35],
        [800, 2500, 0.0108, 0.756, 0.039, 0.3],
        [2500, 6000, 0.005, 0.08, 0.04, 0.2],
      ],
      th: { f0: 235, f1: 128, ft: 0.01, a: 0.0015, d: 0.022, g: 0.36 },
    },
  },
  smg: {
    len: 0.38, width: 0.3, pulseT: 17e-5, pulse: 1, atk: 1e-4, drive: 2.3,
    bands: [
      [250, 800, 0.017, 0.573, 0.035, 0.2],
      [800, 2500, 0.0105, 0.56, 0.028, 0.15],
      [2500, 6000, 0.005, 0.958, 0.014, 0.1],
      [6000, 15000, 0.0026, 0.0515, 0, 0],
    ],
    res: [[820, 1.5, 0.8], [1900, 1.8, 0.55]],
    th: { f0: 215, f1: 104, ft: 0.012, a: 0.003, d: 0.036, g: 0.224 },
    boom: { f: 300, d: 0.034, g: 0.0865 },
    mech: [
      { t: 0.022, g: 0.1, f: [1650, 2850, 4500], d: 0.006, click: 3000, thunk: 0.8, ring: 1420 },
      { t: 0.047, g: 0.06, f: [2400, 3900], d: 0.004, click: 3900, thunk: 0.3 },
    ],
    sup: {
      len: 0.34, atk: 0.001, drive: 2.5, mech: 2.4,
      bands: [
        [250, 800, 0.0121, 0.584, 0.0338, 0.35],
        [800, 2500, 0.0088, 0.812, 0.0286, 0.3],
        [2500, 6000, 0.004, 0.075, 0.035, 0.2],
      ],
      th: { f0: 270, f1: 150, ft: 0.01, a: 0.0015, d: 0.016, g: 0.29 },
    },
  },
  shotgun: {
    len: 0.86, width: 0.36, pulseT: 42e-5, pulse: 1.5, atk: 2e-4, drive: 2.95,
    bands: [
      [250, 800, 0.04, 0.722, 0.11, 0.3],
      [800, 2500, 0.022, 0.462, 0.07, 0.2],
      [2500, 6000, 0.011, 0.91, 0.03, 0.1],
      [6000, 15000, 0.0055, 0.04, 0, 0],
    ],
    res: [[330, 1.2, 1], [880, 1.4, 0.5]],
    th: { f0: 132, f1: 61, ft: 0.03, a: 0.005, d: 0.085, g: 0.527 },
    boom: { f: 170, d: 0.11, g: 0.35 },
    mech: [{ t: 0.034, g: 0.045, f: [640, 1210, 2150], d: 0.03, click: 1800, thunk: 1.2, ring: 0 }],
    far: {
      len: 0.86, atk: 0.002, drive: 1.8,
      bands: [
        [60, 250, 0.08, 0.667, 0.2, 0.35],
        [250, 800, 0.07, 0.556, 0.18, 0.35],
        [800, 2500, 0.03, 0.496, 0.09, 0.2],
      ],
      th: { f0: 92, f1: 48, ft: 0.04, a: 0.009, d: 0.12, g: 0.467 },
    },
  },
  pistol: {
    len: 0.38, width: 0.28, pulseT: 24e-5, pulse: 1, atk: 1e-4, drive: 2.35,
    bands: [
      [250, 800, 0.018, 0.576, 0.038, 0.2],
      [800, 2500, 0.011, 0.617, 0.03, 0.15],
      [2500, 6000, 0.0052, 0.921, 0.015, 0.1],
      [6000, 15000, 0.0027, 0.045, 0, 0],
    ],
    res: [[700, 1.6, 1], [1650, 1.8, 0.5]],
    th: { f0: 205, f1: 96, ft: 0.013, a: 0.0032, d: 0.04, g: 0.3 },
    boom: { f: 280, d: 0.038, g: 0.107 },
    mech: [
      { t: 0.019, g: 0.085, f: [2800, 4600, 6900], d: 0.005, click: 4200, thunk: 0.5, ring: 2300 },
      { t: 0.043, g: 0.06, f: [3300, 5200], d: 0.004, click: 5000, thunk: 0.3 },
    ],
  },
};

function addGunMechLayer(mid, side, sr, rng, spec, mechScale, sideWidth) {
  const len = mid.length;
  const start = Math.floor(sr * (spec.t + (rng() - 0.5) * 0.005)) + 2;
  const gain = spec.g * mechScale * (0.8 + 0.4 * rng());
  if (start >= len) return;

  const clickLen = Math.min(len - start, Math.floor(sr * 0.012));
  const click = whiteNoise(clickLen, rng);
  svfFilter(click, sr, SVF_BP, spec.click * (0.94 + 0.12 * rng()), 1.5);
  applyADEnv(click, sr, 8e-5, 0.0011);
  mixInto(mid, click, gain * 2.6, start);
  if (side) mixInto(side, click, -gain * 2.6 * sideWidth, start);

  for (let i = 0; i < spec.f.length; i++) {
    const g = (gain * (0.55 + 0.45 * rng())) / Math.sqrt(i + 1);
    addModalSine(
      mid,
      sr,
      start,
      spec.f[i] * (0.97 + 0.06 * rng()),
      spec.d * (0.7 + 0.6 * rng()),
      g,
      side,
      -g * sideWidth * rng()
    );
  }

  if (spec.ring) {
    const f0 = spec.ring * (0.97 + 0.06 * rng());
    const fMod = f0 * 1.4142;
    const rLen = Math.min(len - start, Math.floor(sr * spec.d * 10));
    const kIdx = Math.exp(-1 / (sr * 0.003));
    const kAmp = Math.exp(-1 / (sr * spec.d * 1.6));
    let idx = 2.6;
    let amp = gain * 0.5;
    for (let i = 0; i < rLen; i++) {
      const t = i / sr;
      mid[start + i] += amp * Math.sin(TAU * f0 * t + idx * Math.sin(TAU * fMod * t));
      idx *= kIdx;
      amp *= kAmp;
    }
  }

  if (spec.thunk) {
    const tLen = Math.min(len - start, Math.floor(sr * 0.07));
    const kF = Math.exp(-1 / (sr * 0.012));
    const kA = Math.exp(-1 / (sr * 0.011));
    const kAtk = Math.exp(-1 / (sr * 0.0006));
    let ph = 0, df = 95, amp = gain * spec.thunk * 1.3, atk = 1;
    for (let i = 0; i < tLen; i++) {
      ph += (TAU * (165 + df)) / sr;
      mid[start + i] += (1 - atk) * amp * Math.sin(ph);
      df *= kF;
      amp *= kA;
      atk *= kAtk;
    }
  }
}

function synthGunshotMS(sr, gunKey, mode, variant) {
  const base = GUN_PROFILES[gunKey];
  const prof = mode === 'near' ? base : base[mode];
  const rng = makePrng(hashSeed(`${gunKey}:${mode}:${variant}`));
  const jit = (amt) => 1 + amt * (rng() * 2 - 1);
  const offset = 2;
  const len = Math.floor(sr * prof.len);
  const mid = new Float32Array(len);
  const side = new Float32Array(len);

  let normAcc = 0;
  for (const b of prof.bands) normAcc += b[3] * b[3];
  normAcc = 2.4 * Math.sqrt(normAcc);

  if (mode === 'near') {
    const pSamples = base.pulseT * jit(0.08) * sr;
    const pLen = Math.min(len - offset, Math.ceil(pSamples * 10));
    const pGain = base.pulse;
    mid[offset - 1] += 0.38 * pGain;
    for (let i = 0; i < pLen; i++) {
      const u = i / pSamples;
      mid[offset + i] += pGain * (1 - u) * Math.exp(-u);
    }
    normAcc += pGain * 0.6;
  }

  // Multi-band blast noise
  for (const [fLo, fHi, dec, gain, tailDec, tailMix] of prof.bands) {
    const bLen = Math.min(len - offset - 8, Math.floor(sr * Math.max(dec, tailDec || 0) * 8.5));
    const d0 = dec * jit(0.1);
    const d1 = (tailDec || 0) * jit(0.1);
    const g0 = gain * jit(0.1);
    for (const target of [mid, fLo >= 250 ? side : null]) {
      if (!target) continue;
      const nBuf = whiteNoise(bLen, rng);
      svfFilter(nBuf, sr, SVF_HP, fLo, 0.7);
      svfFilter(nBuf, sr, SVF_LP, fHi, 0.7);
      if (target === mid && mode === 'near' && base.res) {
        for (const [rf, rq, rg] of base.res) {
          if (rf > fLo * 0.8 && rf < fHi * 1.25) {
            svfFilter(nBuf, sr, SVF_PEAK, rf * jit(0.05), rq, 0, 0, rg);
          }
        }
      }
      const r = rmsSlice(nBuf);
      if (r > 1e-8) scaleInPlace(nBuf, 1 / r);
      applyADEnv(nBuf, sr, prof.atk, d0, d1, tailMix || 0);
      mixInto(target, nBuf, target === mid ? g0 : g0 * base.width, offset);
    }
  }

  // Sub-bass chest thump
  {
    const th = prof.th;
    const fEnd = th.f1 * jit(0.04);
    const kF = Math.exp(-1 / (sr * th.ft));
    const kA = Math.exp(-1 / (sr * th.a));
    const kD = Math.exp(-1 / (sr * th.d * jit(0.08)));
    const g = th.g * jit(0.08);
    let ph = 0, df = th.f0 * jit(0.05) - fEnd, atk = 1, dec = 1;
    for (let i = offset; i < len; i++) {
      ph += (TAU * (fEnd + df)) / sr;
      df *= kF;
      mid[i] += g * (1 - atk) * dec * (Math.sin(ph) + 0.1 * Math.sin(2 * ph));
      atk *= kA;
      dec *= kD;
    }
  }

  if (prof.boom) {
    const bLen = Math.floor(sr * Math.min(prof.len - 0.02, prof.boom.d * 8));
    const bBuf = whiteNoise(bLen, rng);
    svfFilter(bBuf, sr, SVF_LP, prof.boom.f * jit(0.06), 0.6);
    svfFilter(bBuf, sr, SVF_LP, prof.boom.f * 1.4, 0.6);
    svfFilter(bBuf, sr, SVF_HP, 42, 0.7);
    const r = rmsSlice(bBuf);
    if (r > 1e-8) scaleInPlace(bBuf, 1 / r);
    applyADEnv(bBuf, sr, 0.004, prof.boom.d * jit(0.1));
    mixInto(mid, bBuf, prof.boom.g * jit(0.1), offset);
  }

  // Suppressed high-pressure baffle gas hiss
  if (mode === 'sup') {
    for (const target of [mid, side]) {
      const hiss = whiteNoise(Math.floor(sr * 0.24), rng);
      svfFilter(hiss, sr, SVF_BP, 2400 * jit(0.1), 0.75);
      svfFilter(hiss, sr, SVF_LP, 4800, 0.7);
      const r = rmsSlice(hiss);
      if (r > 1e-8) scaleInPlace(hiss, 1 / r);
      applyADEnv(hiss, sr, 0.003, 0.042);
      mixInto(target, hiss, (target === mid ? 1 : base.width * 1.2) * 0.16, offset);
    }
  }

  softDrive(mid, prof.drive, normAcc);

  // Stereo side energy calibration
  {
    const win = Math.min(len, Math.floor(sr * 0.04));
    const sideGain = (base.width * 0.6 * rmsSlice(mid, 0, win)) / Math.max(1e-9, rmsSlice(side, 0, win));
    const kAtk = Math.exp(-1 / (sr * 0.003));
    let a = 1;
    for (let i = 0; i < len; i++) {
      side[i] *= sideGain * (1 - a);
      a *= kAtk;
    }
  }

  if (mode !== 'far') {
    for (const m of base.mech) {
      addGunMechLayer(mid, side, sr, rng, m, mode === 'sup' ? prof.mech : 1, 0.38);
    }
    if (base.spring) {
      addModalSine(
        mid,
        sr,
        offset + Math.floor(sr * 0.03),
        base.spring.f * jit(0.03),
        base.spring.d,
        base.spring.g * (mode === 'sup' ? 2 : 1),
        side,
        base.spring.g * 0.25
      );
    }
  }

  svfFilter(mid, sr, SVF_HP, 24, 0.7);
  const chL = new Float32Array(len);
  const chR = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    chL[i] = mid[i] + side[i];
    chR[i] = mid[i] - side[i];
  }
  return [chL, chR];
}

// ------------------------------------------------ Offline Foley Voice Builder
// Offline PCM port of Golden Hour's procedural WebAudio voice (`T` + `F`, `P`, `z`, `k`, `G`, `Z0`).

function createOfflineVoice(sr, durSec, rng) {
  const len = Math.max(64, Math.floor(sr * durSec));
  const L = new Float32Array(len);
  const R = new Float32Array(len);

  const panGains = (pan = 0) => {
    const p = clamp(pan, -1, 1) * 0.25 + 0.5;
    return [Math.cos(p * Math.PI * 0.5), Math.sin(p * Math.PI * 0.5)];
  };

  const voice = {
    L,
    R,
    noise({
      t = 0,
      buf = 'white',
      type = 'bandpass',
      f = 1200,
      f1 = 0,
      ft = 0,
      q = 1,
      a = 0.0005,
      d = 0.03,
      g = 1,
      pan = (rng() - 0.5) * 0.35,
    }) {
      const start = Math.floor(sr * t);
      if (start >= len) return;
      const nLen = Math.min(len - start, Math.max(32, Math.floor(sr * (a + d * 6.5))));
      const src = buf === 'brown' ? brownNoise(nLen, rng) : whiteNoise(nLen, rng);
      const mode = type === 'lowpass' ? SVF_LP : type === 'highpass' ? SVF_HP : SVF_BP;
      svfFilter(src, sr, mode, f, q, f1, ft);
      applyADEnv(src, sr, a, d);
      const [gL, gR] = panGains(pan);
      mixInto(L, src, g * gL, start);
      mixInto(R, src, g * gR, start);
    },

    tone({
      t = 0,
      type = 'sine',
      f = 440,
      f1 = 0,
      ft = 0.04,
      a = 0.0006,
      d = 0.04,
      g = 0.5,
      pan = (rng() - 0.5) * 0.25,
    }) {
      const start = Math.floor(sr * t);
      if (start >= len) return;
      const nLen = Math.min(len - start, Math.max(32, Math.floor(sr * (a + d * 6.5))));
      const fEnd = f1 > 0 ? f1 : f;
      const kF = f1 > 0 && ft > 0 ? Math.exp(-1 / (sr * ft)) : 0;
      const kA = a > 0 ? Math.exp(-1 / (sr * a)) : 0;
      const kD = Math.exp(-1 / (sr * Math.max(1e-5, d)));
      const [gL, gR] = panGains(pan);
      let ph = 0, df = f - fEnd, envA = 1, envD = 1;
      for (let i = 0; i < nLen; i++) {
        ph += (fEnd + df) / sr;
        ph -= Math.floor(ph);
        df *= kF;
        const w = type === 'triangle'
          ? 1 - 4 * Math.abs(ph - 0.5)
          : type === 'sawtooth' ? 2 * ph - 1 : Math.sin(TAU * ph);
        const s = w * (1 - envA) * envD * g;
        L[start + i] += s * gL;
        R[start + i] += s * gR;
        envA *= kA;
        envD *= kD;
      }
    },

    partials(baseHz, ratios, gain, dec, t = 0) {
      const start = Math.floor(sr * t);
      for (let i = 0; i < ratios.length; i++) {
        const g = gain / Math.pow(i + 1, 0.72);
        const pan = (rng() - 0.5) * 0.45;
        const [gL, gR] = panGains(pan);
        addModalSine(L, sr, start, baseHz * ratios[i], dec / (1 + i * 0.22), g * gL, R, g * gR);
      }
    },

    fm({ t = 0, f = 1400, ratio = 1.41, index = 1.5, id = 0.01, d = 0.05, g = 0.2, pan = 0 }) {
      const start = Math.floor(sr * t);
      if (start >= len) return;
      const nLen = Math.min(len - start, Math.max(32, Math.floor(sr * d * 6.5)));
      const kIdx = Math.exp(-1 / (sr * Math.max(1e-4, id)));
      const kAmp = Math.exp(-1 / (sr * Math.max(1e-4, d)));
      const [gL, gR] = panGains(pan);
      let idx = index, amp = g;
      for (let i = 0; i < nLen; i++) {
        const sec = i / sr;
        const s = amp * Math.sin(TAU * f * sec + idx * Math.sin(TAU * f * ratio * sec));
        L[start + i] += s * gL;
        R[start + i] += s * gR;
        idx *= kIdx;
        amp *= kAmp;
      }
    },

    click(t, hz, gain) {
      this.noise({ t, type: 'bandpass', f: hz, q: 4, a: 0.0004, d: 0.012, g: gain });
      this.tone({ t, type: 'triangle', f: hz * 0.83, a: 0.0004, d: 0.02, g: gain * 0.22 });
    },

    clack(t, gain, pitch = 1, ringDur = 0.035) {
      this.noise({ t, type: 'lowpass', f: 3400 * pitch, a: 0.0004, d: 0.02, g: 0.9 * gain });
      this.noise({ t, type: 'highpass', f: 4200, a: 0.0003, d: 0.004, g: 0.35 * gain });
      this.tone({ t, f: 250 * pitch, f1: 150 * pitch, ft: 0.03, a: 0.0005, d: 0.035, g: 0.6 * gain });
      this.fm({ t, f: 1870 * pitch * rng.range(0.97, 1.03), ratio: 1.41, index: 1.6, id: 0.006, d: ringDur, g: 0.18 * gain });
      this.tone({ t, f: 3150 * pitch * rng.range(0.97, 1.03), a: 0.0005, d: ringDur * 0.6, g: 0.08 * gain });
    },

    polyThud(t, gain, hz = 620) {
      this.noise({ t, type: 'bandpass', f: hz, q: 3.5, a: 0.0006, d: 0.028, g: 3.2 * gain });
      this.noise({ t, type: 'bandpass', f: hz * 2.3, q: 3, a: 0.0005, d: 0.014, g: 1.3 * gain });
      this.tone({ t, f: hz * 0.42, f1: hz * 0.3, ft: 0.03, a: 0.0008, d: 0.035, g: 0.42 * gain });
    },

    slideSweep(t, f0, f1, dur, gain, q = 1.6) {
      this.noise({ t, type: 'bandpass', f: f0, f1, ft: dur, q, a: dur * 0.3, d: dur * 0.7, g: gain });
      this.noise({ t, type: 'highpass', f: 5000, a: dur * 0.3, d: dur * 0.6, g: gain * 0.1 });
    },

    rattle(t, count, gain) {
      for (let i = 0; i < count; i++) {
        this.click(t + rng.range(0, 0.08), rng.range(2400, 4600), gain * rng.range(0.45, 1));
      }
    },
  };
  return voice;
}

// ------------------------------------------------ Glass & Explosion (`H$` / `F$`)

function synthGlass(sr, mode, variant) {
  const rng = makePrng(hashSeed(`glass:${mode}:${variant}`));
  const dur = mode === 'crash' ? 1.85 : mode === 'debris' ? 1.0 : 0.48;
  const len = Math.floor(sr * dur);
  const L = new Float32Array(len);
  const R = new Float32Array(len);

  const shardPing = (tSec, hz, dec, gain) => {
    const p = rng();
    const start = Math.floor(sr * tSec);
    addModalSine(L, sr, start, hz, dec, gain * Math.cos(p * Math.PI * 0.5), R, gain * Math.sin(p * Math.PI * 0.5));
  };
  const logRand = (lo, hi) => lo * Math.pow(hi / lo, rng());

  if (mode === 'crash') {
    for (const ch of [L, R]) {
      const burst = whiteNoise(Math.floor(sr * 1.15), rng);
      svfFilter(burst, sr, SVF_HP, 1300, 0.7);
      svfFilter(burst, sr, SVF_PEAK, 4600, 0.8, 0, 0, 1);
      applyADEnv(burst, sr, 0.0008, 0.035, 0.24, 0.22);
      mixInto(ch, burst, 0.5, 2);

      const thump = whiteNoise(Math.floor(sr * 0.32), rng);
      svfFilter(thump, sr, SVF_BP, 340, 1.1);
      applyADEnv(thump, sr, 0.001, 0.048);
      mixInto(ch, thump, 1.45, 2);
    }
    for (let i = 0; i < 380; i++) {
      const u = Math.pow(rng(), 2.3);
      const t = 0.004 + 1.45 * u;
      shardPing(t, logRand(2300, 13000), 0.005 + 0.055 * rng() * rng(), (0.022 + 0.07 * rng()) * (1 - 0.75 * u));
    }
    for (let i = 0; i < 30; i++) {
      const u = Math.pow(rng(), 1.6);
      const t = 0.01 + 1.15 * u;
      const hz = logRand(1100, 3600);
      const g = (0.05 + 0.08 * rng()) * (1 - 0.6 * u);
      const d = 0.03 + 0.085 * rng();
      shardPing(t, hz, d, g);
      shardPing(t, hz * 1.47, d * 0.6, g * 0.5);
      shardPing(t, hz * 2.09, d * 0.4, g * 0.35);
    }
  } else {
    for (const ch of [L, R]) {
      const snap = whiteNoise(Math.floor(sr * 0.02), rng);
      svfFilter(snap, sr, SVF_HP, 3800, 0.7);
      applyADEnv(snap, sr, 5e-5, 0.0016);
      mixInto(ch, snap, 0.9, 2);

      const body = whiteNoise(Math.floor(sr * 0.05), rng);
      svfFilter(body, sr, SVF_BP, 2300, 1.2);
      applyADEnv(body, sr, 2e-4, 0.006);
      mixInto(ch, body, 0.7, 2);

      for (let i = 0; i < 9; i++) {
        const off = Math.floor(sr * (0.004 + 0.075 * Math.pow(rng(), 1.5)));
        const tick = whiteNoise(Math.floor(sr * 0.003), rng);
        svfFilter(tick, sr, SVF_HP, 5000, 0.7);
        applyADEnv(tick, sr, 4e-5, 0.0005);
        mixInto(ch, tick, 0.25 + 0.3 * rng(), off);
      }
    }
    shardPing(0.0005, 4300 + 900 * rng(), 0.03, 0.3);
    shardPing(0.0005, 7100 + 1200 * rng(), 0.022, 0.22);
    for (let i = 0; i < 10; i++) {
      shardPing(0.012 + 0.26 * Math.pow(rng(), 1.6), logRand(3400, 10500), 0.02 + 0.07 * rng(), 0.05 + 0.1 * rng());
    }
  }
  return [L, R];
}

function synthGrenadeExplosion(sr, variant) {
  const rng = makePrng(hashSeed(`exp:${variant}`));
  const len = Math.floor(sr * 2.8);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  const offset = 2;

  // Initial supersonic shockwave impulse
  {
    const pSamples = 0.0011 * sr;
    const pLen = Math.ceil(pSamples * 10);
    L[offset - 1] += 0.4;
    R[offset - 1] += 0.4;
    for (let i = 0; i < pLen; i++) {
      const u = i / pSamples;
      const v = (1 - u) * Math.exp(-u);
      L[offset + i] += v;
      R[offset + i] += v;
    }
  }

  // High-frequency blast crack + sweeping mid roar (stereo decorrelated)
  for (let chIdx = 0; chIdx < 2; chIdx++) {
    const dst = chIdx === 0 ? L : R;
    const crack = whiteNoise(Math.floor(sr * 0.08), rng);
    svfFilter(crack, sr, SVF_HP, 900, 0.7);
    svfFilter(crack, sr, SVF_PEAK, 2800, 0.8, 0, 0, 0.8);
    applyADEnv(crack, sr, 1e-4, 0.005, 0.02, 0.3);
    mixInto(dst, crack, 0.78, offset);

    const rLen = Math.floor(sr * 1.6);
    const roar = whiteNoise(rLen, rng);
    svfFilter(roar, sr, SVF_LP, 5200, 0.7, 210, 0.11);
    svfFilter(roar, sr, SVF_HP, 60, 0.7);
    const lowRoar = Float32Array.from(roar);
    svfFilter(lowRoar, sr, SVF_LP, 380, 0.6);
    for (let i = 0; i < rLen; i++) roar[i] = roar[i] * 0.55 + lowRoar[i] * 2.6;
    applyADEnv(roar, sr, 0.0008, 0.045, 0.3, 0.42);
    mixInto(dst, roar, 0.75, offset);

    const rumble = whiteNoise(Math.floor(sr * 2.3), rng);
    svfFilter(rumble, sr, SVF_LP, 135, 0.6);
    svfFilter(rumble, sr, SVF_LP, 175, 0.6);
    svfFilter(rumble, sr, SVF_HP, 26, 0.7);
    applyADEnv(rumble, sr, 0.012, 0.42);
    mixInto(dst, rumble, 5.2, offset);
  }

  // Deep sub-bass detonation wave (`85 -> 27 Hz`)
  {
    const kF = Math.exp(-1 / (sr * 0.09));
    const kA = Math.exp(-1 / (sr * 0.006));
    const kD = Math.exp(-1 / (sr * 0.24));
    let ph = 0, df = 58, atk = 1, dec = 1;
    for (let i = offset; i < len; i++) {
      ph += (TAU * (27 + df)) / sr;
      df *= kF;
      const v = (1 - atk) * dec * (Math.sin(ph) + 0.15 * Math.sin(2 * ph));
      L[i] += v;
      R[i] += v;
      atk *= kA;
      dec *= kD;
    }
  }

  const ref = Math.max(peakAbs(L), peakAbs(R));
  softDrive(L, 2.55, ref);
  softDrive(R, 2.55, ref);

  // Scattered shrapnel & falling rock debris tail
  const debrisCount = 48 + Math.floor(rng() * 14);
  for (let i = 0; i < debrisCount; i++) {
    const tSec = 0.22 + 1.55 * Math.pow(rng(), 1.5);
    const start = Math.floor(sr * tSec);
    const g = (0.014 + 0.042 * rng()) * (1 - 0.5 * (tSec - 0.22) / 1.55);
    const pan = rng();
    const gL = g * Math.cos(pan * Math.PI * 0.5);
    const gR = g * Math.sin(pan * Math.PI * 0.5);
    if (rng() < 0.32) {
      addModalSine(L, sr, start, 1800 + 4200 * rng(), 0.008 + 0.03 * rng(), gL * 0.85, R, gR * 0.85);
    } else {
      const clat = whiteNoise(Math.floor(sr * (0.01 + 0.03 * rng())), rng);
      svfFilter(clat, sr, SVF_BP, 700 + 3600 * rng() * rng(), 1.3);
      applyADEnv(clat, sr, 0.0003, 0.004 + 0.01 * rng());
      mixInto(L, clat, gL * 3, start);
      mixInto(R, clat, gR * 3, start);
    }
  }

  svfFilter(L, sr, SVF_HP, 20, 0.7);
  svfFilter(R, sr, SVF_HP, 20, 0.7);
  return [L, R];
}

// ------------------------------------------------ Individual Sound Generators

function genKr7Shot(sr, _rng, v) {
  return synthGunshotMS(sr, 'ar', 'near', v);
}

function genSuppressedShot(sr, _rng, v) {
  return synthGunshotMS(sr, 'ar', 'sup', v);
}

function genVesperShot(sr, _rng, v) {
  const sup = synthGunshotMS(sr, 'smg', 'sup', v);
  const pop = synthGunshotMS(sr, 'smg', 'near', v);
  const len = Math.max(sup[0].length, pop[0].length);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  mixInto(L, sup[0], 0.85);
  mixInto(R, sup[1], 0.85);
  mixInto(L, pop[0], 0.32);
  mixInto(R, pop[1], 0.32);
  return [L, R];
}

function genShotgunShot(sr, _rng, v) {
  const near = synthGunshotMS(sr, 'shotgun', 'near', v);
  const far = synthGunshotMS(sr, 'shotgun', 'far', v);
  const len = Math.max(near[0].length, far[0].length);
  const L = new Float32Array(len);
  const R = new Float32Array(len);
  mixInto(L, near[0], 0.9);
  mixInto(R, near[1], 0.9);
  const slapDelay = Math.floor(sr * 0.028);
  mixInto(L, far[0], 0.36, Math.min(slapDelay, len - 1));
  mixInto(R, far[1], 0.34, Math.min(slapDelay + Math.floor(sr * 0.006), len - 1));
  return [L, R];
}

function genShotgunPumpBack(sr, rng) {
  const v = createOfflineVoice(sr, 0.24, rng);
  v.click(0, 2100, 0.65);
  v.slideSweep(0.008, 1000, 2400, 0.075, 1.3, 1.2);
  v.rattle(0.02, 2, 0.18);
  v.clack(0.082, 1.0, 0.88, 0.038);
  return [v.L, v.R];
}

function genShotgunPumpFwd(sr, rng) {
  const v = createOfflineVoice(sr, 0.26, rng);
  v.slideSweep(0, 2500, 1000, 0.065, 1.3, 1.2);
  v.clack(0.07, 1.7, 0.72, 0.052);
  v.partials(640, [1, 1.89, 3.36], 0.14, 0.075, 0.07);
  return [v.L, v.R];
}

function genShotgunShell(sr, rng) {
  const v = createOfflineVoice(sr, 0.22, rng);
  v.polyThud(0, 0.8, 760);
  v.slideSweep(0.012, 900, 1500, 0.045, 1.05, 2.0);
  v.click(0.06, 2600, 1.35);
  v.tone({ t: 0.06, f: 300, f1: 210, ft: 0.025, d: 0.032, g: 0.62 });
  v.partials(640, [1, 1.89], 0.08, 0.055, 0.06);
  return [v.L, v.R];
}

function genPistolShot(sr, _rng, v) {
  return synthGunshotMS(sr, 'pistol', 'near', v);
}

function genPistolSlide(sr, rng) {
  const v = createOfflineVoice(sr, 0.20, rng);
  v.slideSweep(0, 2600, 3700, 0.055, 0.95, 2.0);
  v.clack(0.062, 0.9, 1.5, 0.042);
  return [v.L, v.R];
}

function genGrenadePin(sr, rng) {
  const v = createOfflineVoice(sr, 0.28, rng);
  v.partials(3200, [1, 1.47, 2.09], 0.26, 0.13, 0);
  v.click(0, 4200, 0.45);
  v.click(0.05, 2600, 0.3);
  v.fm({ t: 0.06, f: 1500, ratio: 2.3, index: 1.5, id: 0.01, d: 0.055, g: 0.14 });
  return [v.L, v.R];
}

function genGrenadeBounce(sr, rng) {
  const v = createOfflineVoice(sr, 0.34, rng);
  const f0 = rng.range(520, 820);
  v.partials(f0, [1, 2.32, 3.9, 5.6], 0.48, 0.16, 0);
  v.noise({ t: 0, type: 'bandpass', f: 2400, q: 2, a: 0.0005, d: 0.016, g: 1.1 });
  v.tone({ t: 0, f: 155, f1: 88, ft: 0.03, d: 0.05, g: 0.62 });
  const t2 = rng.range(0.085, 0.13);
  v.partials(f0 * 1.07, [1, 2.32, 3.9], 0.22, 0.11, t2);
  v.noise({ t: t2, type: 'highpass', f: 2800, a: 0.0004, d: 0.01, g: 0.42 });
  return [v.L, v.R];
}

function genGrenadeExplode(sr, _rng, v) {
  return synthGrenadeExplosion(sr, v);
}

function genBulletImpactRock(sr, rng) {
  const v = createOfflineVoice(sr, 0.32, rng);
  v.noise({ type: 'highpass', f: 2600, a: 0.0003, d: 0.005, g: 1.0 });
  v.noise({ type: 'lowpass', f: 1600, a: 0.0005, d: 0.05, g: 1.9 });
  v.noise({ type: 'bandpass', f: 1350, q: 1.2, a: 0.0005, d: 0.022, g: 1.6 });
  v.tone({ f: 145, f1: 78, ft: 0.03, d: 0.045, g: 0.42 });
  const chips = rng.int(4, 6);
  for (let i = 0; i < chips; i++) {
    v.noise({
      t: rng.range(0.01, 0.14),
      type: 'highpass',
      f: 2600,
      a: 0.0004,
      d: 0.012,
      g: rng.range(0.18, 0.42),
    });
  }
  return [v.L, v.R];
}

function genBulletImpactMetal(sr, rng) {
  const v = createOfflineVoice(sr, 0.55, rng);
  v.noise({ type: 'highpass', f: 2600, a: 0.0003, d: 0.005, g: 1.05 });
  v.partials(rng.range(1150, 2300), [1, 1.59, 2.31, 3.17, 4.2], 0.48, rng.range(0.24, 0.42), 0);
  v.fm({ f: rng.range(720, 1080), ratio: 2.76, index: 2.0, id: 0.02, d: 0.12, g: 0.2 });
  v.tone({ f: 240, f1: 150, ft: 0.025, d: 0.032, g: 0.42 });
  return [v.L, v.R];
}

function genBulletRicochet(sr, rng) {
  const dur = rng.range(0.32, 0.46);
  const v = createOfflineVoice(sr, dur + 0.12, rng);
  const fStart = rng.range(2700, 4100);
  const fEnd = fStart * rng.range(0.19, 0.3);
  v.noise({ type: 'highpass', f: 3000, a: 0.0003, d: 0.0045, g: 0.8 });
  v.tone({ t: 0.002, type: 'triangle', f: fStart, f1: fEnd, ft: dur * 0.65, a: 0.004, d: dur * 0.65, g: 0.55 });
  v.tone({ t: 0.002, f: fStart * 1.51, f1: fStart * 0.33, ft: dur * 0.55, a: 0.004, d: dur * 0.48, g: 0.22 });
  v.noise({ t: 0.002, type: 'bandpass', f: fStart, f1: fStart * 0.25, ft: dur * 0.65, q: 9, a: 0.004, d: dur * 0.65, g: 1.25 });
  return [v.L, v.R];
}

function genGlassCrack(sr, _rng, v) {
  return synthGlass(sr, 'crack', v);
}

function genGlassShatter(sr, _rng, v) {
  return synthGlass(sr, 'crash', v);
}

function genHitmarker(sr, rng, v) {
  const voice = createOfflineVoice(sr, 0.18, rng);
  const pitch = v % 2 === 1 ? 1.08 : 1.0;
  voice.tone({ type: 'triangle', f: 1900 * pitch, a: 0.0005, d: 0.026, g: 0.65, pan: -0.08 });
  voice.tone({ type: 'triangle', f: 2850 * pitch, a: 0.0005, d: 0.02, g: 0.38, pan: 0.08 });
  voice.noise({ type: 'highpass', f: 5000, a: 0.0004, d: 0.004, g: 0.72, pan: 0 });
  if (v % 2 === 1) {
    voice.partials(2640, [1, 1.5, 2.25, 2.81], 0.32, 0.09, 0.002);
  }
  return [voice.L, voice.R];
}

// ------------------------------------------------ Sound Table & Renderer

export const GH_SOUND_TABLE = {
  kr7_shot: { gen: genKr7Shot, n: 4, sr: SR_DEFAULT, peak: 0.96, bus: 'near', max: 5, pri: 9 },
  suppressed_shot: { gen: genSuppressedShot, n: 4, sr: SR_DEFAULT, peak: 0.82, bus: 'near', max: 5, pri: 9 },
  vesper_shot: { gen: genVesperShot, n: 4, sr: SR_DEFAULT, peak: 0.86, bus: 'near', max: 6, pri: 9 },
  shotgun_shot: { gen: genShotgunShot, n: 3, sr: SR_DEFAULT, peak: 0.98, bus: 'near', max: 4, pri: 10 },
  shotgun_pump_back: { gen: genShotgunPumpBack, n: 2, sr: SR_DEFAULT, peak: 0.72, bus: 'near', max: 2, pri: 7 },
  shotgun_pump_fwd: { gen: genShotgunPumpFwd, n: 2, sr: SR_DEFAULT, peak: 0.78, bus: 'near', max: 2, pri: 7 },
  shotgun_shell: { gen: genShotgunShell, n: 3, sr: SR_DEFAULT, peak: 0.68, bus: 'near', max: 3, pri: 6 },
  pistol_shot: { gen: genPistolShot, n: 4, sr: SR_DEFAULT, peak: 0.94, bus: 'near', max: 5, pri: 9 },
  pistol_slide: { gen: genPistolSlide, n: 2, sr: SR_DEFAULT, peak: 0.72, bus: 'near', max: 2, pri: 6 },
  grenade_pin: { gen: genGrenadePin, n: 2, sr: SR_DEFAULT, peak: 0.66, bus: 'near', max: 2, pri: 7 },
  grenade_bounce: { gen: genGrenadeBounce, n: 3, sr: SR_DEFAULT, peak: 0.58, bus: 'world', max: 4, pri: 5, ref: 3, roll: 1 },
  grenade_explode: { gen: genGrenadeExplode, n: 3, sr: SR_DEFAULT, peak: 0.98, bus: 'world', max: 3, pri: 10, ref: 12, roll: 0.5 },
  bullet_impact_rock: { gen: genBulletImpactRock, n: 3, sr: SR_DEFAULT, peak: 0.72, bus: 'world', max: 4, pri: 4, ref: 4, roll: 0.7 },
  bullet_impact_metal: { gen: genBulletImpactMetal, n: 3, sr: SR_DEFAULT, peak: 0.75, bus: 'world', max: 4, pri: 4, ref: 4, roll: 0.7 },
  bullet_ricochet: { gen: genBulletRicochet, n: 3, sr: SR_DEFAULT, peak: 0.54, bus: 'world', max: 3, pri: 4, ref: 5, roll: 0.6 },
  glass_crack: { gen: genGlassCrack, n: 3, sr: SR_DEFAULT, peak: 0.68, bus: 'world', max: 3, pri: 5, ref: 4, roll: 0.8 },
  glass_shatter: { gen: genGlassShatter, n: 2, sr: SR_DEFAULT, peak: 0.9, bus: 'world', max: 3, pri: 8, ref: 6, roll: 0.7 },
  hitmarker: { gen: genHitmarker, n: 2, sr: SR_DEFAULT, peak: 0.62, bus: 'dry', max: 3, pri: 9 },
};

export function renderGoldenHourSound(name, variant = 0, sampleRate) {
  const def = GH_SOUND_TABLE[name];
  if (!def) return null;
  const sr = sampleRate || def.sr || SR_DEFAULT;
  const v = ((variant | 0) % def.n + def.n) % def.n;
  const rng = makePrng(hashSeed(`${name}:${v}`));
  const raw = def.gen(sr, rng, v);
  const ch = Array.isArray(raw) ? raw : [raw, Float32Array.from(raw)];

  let maxPeak = 0;
  for (const buf of ch) {
    fadeEdges(buf, sr, 0.00025, 0.012);
    for (let i = 0; i < buf.length; i++) {
      if (!Number.isFinite(buf[i])) buf[i] = 0;
      const a = Math.abs(buf[i]);
      if (a > maxPeak) maxPeak = a;
    }
  }
  const targetPeak = Math.min(1, def.peak || 0.85);
  const scale = maxPeak > 1e-9 ? targetPeak / maxPeak : 1;
  for (const buf of ch) scaleInPlace(buf, scale);

  return { sr, ch, loop: !!def.loop };
}
