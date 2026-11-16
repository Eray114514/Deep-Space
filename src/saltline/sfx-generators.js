// Saltline's synthesized sound library: every effect is rendered offline from
// noise, modal resonators and filtered bursts — there are no audio files.
//
// Produced by
//   node tools/saltline/extract.mjs r_ --rename "r_=renderSound,Go=SOUND_TABLE,ki=SR_HI,Xn=SR_MID,pl=SR_LO,ao=seededRandom,Kb=soundSeed,s_=isGenerator"
// and kept as generated (the generator bodies are synthesis recipes; treat
// their local names as data). See docs/saltline-reuse.md.
//
// renderSound(name, variant = 0, sampleRate?) -> { sr, ch: Float32Array[], loop }
//   channels are peak-normalised to the table's `peak`; SOUND_TABLE lists every
//   name with its variant count `n`, bus, voice limit `max` and priority.
var vt = Math.PI * 2;
function seededRandom(i) {
  let e = i >>> 0;
  return () => {
    e |= 0, e = e + 1831565813 | 0;
    let t = Math.imul(e ^ e >>> 15, 1 | e);
    return t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t, ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function soundSeed(i) {
  let e = 2166136261;
  for (let t = 0; t < i.length; t++) e ^= i.charCodeAt(t), e = Math.imul(e, 16777619);
  return e >>> 0;
}
var St = (i, e) => new Float32Array(Math.max(1, Math.round(i * e))), Xt = (i, e, t) => e + (t - e) * i(), Ns = (i) => 440 * Math.pow(2, (i - 69) / 12);
function Qn(i, e, t) {
  let n = St(i, e);
  for (let s = 0; s < n.length; s++) n[s] = t() * 2 - 1;
  return n;
}
function Av(i, e, t, n) {
  let s = vt * Math.max(10, Math.min(e, n * 0.47)) / n, o = Math.cos(s), r = Math.sin(s), a = r / (2 * t), l, c, u, h = 1 + a, f = -2 * o, p = 1 - a;
  return i === "lp" ? (l = (1 - o) / 2, c = 1 - o, u = l) : i === "hp" ? (l = (1 + o) / 2, c = -(1 + o), u = l) : (l = a, c = 0, u = -a), [l / h, c / h, u / h, f / h, p / h];
}
function tn(i, e, t, n, s) {
  let [o, r, a, l, c] = Av(e, t, n, s), u = 0, h = 0;
  for (let f = 0; f < i.length; f++) {
    let p = i[f], d = o * p + u;
    u = r * p - l * d + h, h = a * p - c * d, i[f] = d;
  }
  return i;
}
function di(i, e, t, n, s, o = 1) {
  let r = i.length;
  for (let a = 0; a < o; a++) {
    let l = 0, c = 0, u = null;
    a > 0 && (l = di.z1, c = di.z2);
    let h = a === o - 1 ? i : null;
    for (let f = 0; f < r; f++) {
      (f & 31) === 0 && (u = Av(e, t(f / r), typeof n == "function" ? n(f / r) : n, s));
      let p = i[f], d = u[0] * p + l;
      l = u[1] * p - u[3] * d + c, c = u[2] * p - u[4] * d, h && (h[f] = d);
    }
    di.z1 = l, di.z2 = c;
  }
  return i;
}
var Vo = (i, e, t = 1) => (n) => i * Math.pow(e / i, Math.pow(n, t));
function lo(i, e, t) {
  for (let n = 0; n < i.length; n++) i[n] *= t(n / e);
  return i;
}
var co = (i, e = 0) => e > 0 ? (t) => (1 - Math.exp(-t / e)) * Math.exp(-t / i) : (t) => Math.exp(-t / i);
function Se(i, e, t, n, s) {
  let o = Math.round(t * s), r = Math.min(e.length, i.length - o);
  for (let a = Math.max(0, -o); a < r; a++) i[o + a] += e[a] * n;
  return i;
}
function Us(i, e, t, n, s) {
  let o = i.length, r = Math.round(t * s) % o;
  r < 0 && (r += o);
  for (let a = 0; a < e.length; a++) i[r] += e[a] * n, ++r >= o && (r = 0);
  return i;
}
function Qb(i) {
  let e = 0;
  for (let t = 0; t < i.length; t++) {
    let n = Math.abs(i[t]);
    n > e && (e = n);
  }
  return e;
}
function ml(i, e) {
  for (let t = 0; t < i.length; t++) i[t] *= e;
  return i;
}
function Wo(i, e) {
  let t = 1 / Math.tanh(e);
  for (let n = 0; n < i.length; n++) i[n] = Math.tanh(i[n] * e) * t;
  return i;
}
function em(i, e, t, n) {
  let s = Math.min(i.length >> 1, Math.round(t * e)), o = Math.min(i.length >> 1, Math.round(n * e));
  for (let r = 0; r < s; r++) i[r] *= r / s;
  for (let r = 0; r < o; r++) {
    let a = r / o;
    i[i.length - 1 - r] *= a * a;
  }
  return i;
}
function at(i, e, t, n, s = {}) {
  let o = Qn(i, t, e);
  s.hp && tn(o, "hp", s.hp, 0.707, i), s.lp && tn(o, "lp", s.lp, 0.707, i), s.bp && tn(o, "bp", s.bp, s.q || 1, i), lo(o, i, co(n, s.att || 0));
  let r = Qb(o);
  return r > 0 ? ml(o, 1 / r) : o;
}
function ei(i, e, t, n, s, o, r = 6e-4) {
  let a = St(i, e), l = 0;
  for (let c = 0; c < a.length; c++) {
    let u = c / i;
    l += vt * (n + (t - n) * Math.exp(-u / s)) / i, a[c] = Math.sin(l) * Math.exp(-u / o) * (1 - Math.exp(-u / r));
  }
  return a;
}
function jc(i, e, t, n, s = true) {
  let o = St(i, e), r = 0, a = o.length;
  for (let l = 0; l < a; l++) {
    let c = l / a;
    r += vt * t * Math.pow(n / t, c) / i, o[l] = Math.sin(r) * (s ? Math.sin(Math.PI * c) : 1);
  }
  return o;
}
function dn(i, e, t, n) {
  let s = St(i, e);
  for (let [r, a, l] of t) {
    if (r > i * 0.46) continue;
    let c = vt * r / i, u = n ? n() * vt : 0, h = Math.exp(-1 / (a * i)), f = l;
    for (let p = 0; p < s.length && (s[p] += Math.sin(c * p + u) * f, f *= h, !(f < 1e-5)); p++) ;
  }
  let o = Math.min(s.length, Math.round(4e-4 * i));
  for (let r = 0; r < o; r++) s[r] *= r / o;
  return s;
}
function Jc(i, e, t, n, s = {}) {
  let o = St(i, t), r = s.from || 0, a = s.fall || 1;
  for (let l = 0; l < n; l++) {
    let c = r + (t - r - 0.02) * Math.pow(e(), a), u = Math.round(c * i), h = Math.round(Xt(e, s.minLen || 1e-3, s.maxLen || 4e-3) * i), f = Xt(e, 0.2, 1) * (s.ampFall ? Math.exp(-c / s.ampFall) : 1);
    for (let p = 0; p < h && u + p < o.length; p++) o[u + p] += (e() * 2 - 1) * f * Math.exp(-4 * p / h);
  }
  return s.hp && tn(o, "hp", s.hp, 0.707, i), s.lp && tn(o, "lp", s.lp, 0.707, i), s.bp && tn(o, "bp", s.bp, s.q || 1, i), o;
}
function Rv(i, e, t) {
  let n = i.length - e, s = new Float32Array(e);
  s.set(i.subarray(0, e));
  for (let o = 0; o < n; o++) {
    let r = (o + 0.5) / n, a = t ? Math.sin(r * Math.PI / 2) : r, l = t ? Math.cos(r * Math.PI / 2) : 1 - r;
    s[o] = i[o] * a + i[e + o] * l;
  }
  return s;
}
function Zc(i, e, t, n, s = 0.4) {
  let o = Qn(i, e + s, t);
  return n(o), Rv(o, Math.round(i * e), true);
}
function Q1(i, ...e) {
  let t = new Float32Array(i);
  for (let [n, s] of e) for (let o = 0; o < Math.min(i, n.length); o++) t[o] += n[o] * s;
  return t;
}
function KR(i, e, t) {
  let n = [1, 0.955, 1.045, 0.985][t & 3], s = [1, 1.12, 0.9, 1.05][t & 3], o = St(i, 0.32);
  Se(o, at(i, e, 0.012, 11e-4, { hp: 2600 * s }), 0, 2.6, i), Se(o, at(i, e, 0.02, 3e-3, { hp: 1200, lp: 8e3 }), 2e-4, 1.2, i), Se(o, ei(i, 0.11, 160 * n, 45 * n, 0.024, 0.03, 3e-3), 0, 0.62, i), Se(o, at(i, e, 0.22, 0.03, { hp: 300 * n, lp: 2500 * n * s, att: 12e-4 }), 0, 1.5, i), Se(o, at(i, e, 0.09, 0.016, { bp: 760 * n, q: 2.2, att: 1e-3 }), 0, 0.9, i), Se(o, at(i, e, 0.16, 0.04, { hp: 4800 }), 1e-3, 0.34, i);
  let r = 0.035 + (t - 1.5) * 15e-4;
  return Se(o, dn(i, 0.05, [[2150 * n, 7e-3, 1], [3420 * n, 6e-3, 0.7], [5230, 4e-3, 0.5], [880 * n, 0.012, 0.5]], e), r, 0.26, i), Se(o, at(i, e, 0.012, 2e-3, { bp: 3100, q: 1.2 }), r, 0.3, i), Se(o, dn(i, 0.05, [[1780 * n, 8e-3, 1], [2890 * n, 6e-3, 0.6], [640 * n, 0.02, 0.5]], e), r + 0.027, 0.17, i), Se(o, at(i, e, 0.01, 2e-3, { bp: 2400, q: 1.2 }), r + 0.027, 0.16, i), Se(o, dn(i, 0.2, [[712 * n, 0.05, 1], [1466 * n, 0.03, 0.4]], e), r + 0.03, 0.035, i), Wo(ml(o, 0.46), 1.5);
}
function QR(i, e, t) {
  let n = (o) => {
    let r = seededRandom(o), a = St(i, 1.55), l = t ? [[0.058, 0.5, 4200], [0.097, 0.4, 3300], [0.139, 0.28, 2500], [0.176, 0.2, 1900], [0.262, 0.1, 1300]] : [[0.066, 0.52, 4600], [0.088, 0.34, 3600], [0.124, 0.3, 2700], [0.169, 0.22, 2e3], [0.231, 0.12, 1400]];
    for (let [h, f, p] of l) Se(a, at(i, r, 0.09, 0.016, { hp: 420, lp: p }), h + Xt(r, -4e-3, 4e-3), f * Xt(r, 0.8, 1.1), i);
    let c = Qn(i, 1.5, r);
    di(c, "lp", Vo(3400, 380, 0.6), 0.6, i), tn(c, "hp", 130, 0.7, i), Se(a, lo(c, i, co(0.3, 0.05)), 0.03, 0.55, i);
    let u = Qn(i, 1.2, r);
    return tn(u, "lp", 150, 0.7, i), Se(a, lo(u, i, co(0.26, 0.03)), 0.02, 0.9, i), a;
  }, s = Math.floor(e() * 1e9);
  return [n(s), n(s + 77)];
}
function* e8(i, e, t) {
  let n = function* (o) {
    let r = seededRandom(o), a = St(i, 2.3), l = Qn(i, 2.25, r);
    di(l, "lp", Vo(2400, 260, 0.5), 0.7, i), Se(a, lo(l, i, co(0.42, 0.012)), 8e-3, 0.6, i);
    for (let [u, h] of [[54, 1], [81, 0.8], [117, 0.6], [163, 0.45], [228, 0.3]]) {
      let f = Qn(i, 2.2, r);
      tn(f, "bp", u * (t ? 1.06 : 1), 9, i), Se(a, lo(f, i, co(0.5, 0.02)), 0.01, h * 2.4, i), yield;
    }
    let c = t ? 0.051 : 0.044;
    for (let u = 1; u < 9; u++) Se(a, at(i, r, 0.05, 9e-3, { hp: 500, lp: 3800 / (1 + u * 0.35) }), c * u + Xt(r, -3e-3, 3e-3), 0.42 * Math.pow(0.74, u), i);
    return a;
  }, s = Math.floor(e() * 1e9);
  return [yield* n(s), yield* n(s + 131)];
}
function t8(i, e) {
  let t = St(i, 0.13);
  return Se(t, dn(i, 0.05, [[2840, 4e-3, 1], [4130, 4e-3, 0.7], [6320, 3e-3, 0.5], [1210, 8e-3, 0.4]], e), 0, 0.7, i), Se(t, at(i, e, 6e-3, 12e-4, { hp: 2e3 }), 0, 0.6, i), Se(t, dn(i, 0.08, [[930, 0.018, 1], [1870, 0.012, 0.5]], e), 0.016, 0.16, i), Se(t, at(i, e, 4e-3, 1e-3, { hp: 3e3 }), 0.018, 0.2, i), t;
}
function e_(i, e, t, n, s, o) {
  let r = Qn(i, t, e);
  di(r, "bp", Vo(n, s), 1.6, i);
  let a = 0.5, l = 0.5;
  for (let c = 0; c < r.length; c++) {
    c % Math.round(i / o) === 0 && (l = 0.25 + e() * 0.75), a += (l - a) * 0.02;
    let u = c / r.length;
    r[c] *= a * Math.sin(Math.PI * Math.pow(u, 0.7));
  }
  return r;
}
function n8(i, e) {
  let t = St(i, 0.46);
  return Se(t, dn(i, 0.03, [[3300, 4e-3, 1], [5100, 3e-3, 0.6]], e), 4e-3, 0.45, i), Se(t, at(i, e, 5e-3, 1e-3, { hp: 2500 }), 4e-3, 0.35, i), Se(t, e_(i, e, 0.17, 1700, 3400, 190), 0.03, 0.5, i), Se(t, at(i, e, 0.06, 0.012, { lp: 950 }), 0.2, 0.8, i), Se(t, dn(i, 0.12, [[415, 0.03, 1], [1140, 0.018, 0.6], [2290, 0.01, 0.4], [3470, 6e-3, 0.25]], e), 0.2, 0.42, i), Se(t, at(i, e, 0.08, 0.02, { bp: 2600, q: 0.8 }), 0.215, 0.14, i), t;
}
function i8(i, e) {
  let t = St(i, 0.5);
  return Se(t, e_(i, e, 0.14, 1250, 2900, 240), 0, 0.55, i), Se(t, dn(i, 0.03, [[2600, 4e-3, 1], [4300, 3e-3, 0.5]], e), 0.05, 0.2, i), Se(t, ei(i, 0.07, 190, 88, 0.02, 0.022), 0.15, 0.8, i), Se(t, at(i, e, 0.05, 8e-3, { lp: 1600 }), 0.15, 0.8, i), Se(t, dn(i, 0.1, [[655, 0.024, 1], [1710, 0.014, 0.6], [3120, 8e-3, 0.4]], e), 0.15, 0.4, i), Se(t, dn(i, 0.04, [[3650, 5e-3, 1], [5600, 4e-3, 0.6], [2100, 7e-3, 0.5]], e), 0.187, 0.42, i), Se(t, at(i, e, 5e-3, 1e-3, { hp: 3e3 }), 0.187, 0.36, i), t;
}
function s8(i, e) {
  let t = St(i, 0.38);
  Se(t, dn(i, 0.03, [[2900, 5e-3, 1], [4600, 4e-3, 0.6]], e), 0, 0.3, i), Se(t, at(i, e, 0.03, 0.01, { bp: 2200, q: 0.8 }), 4e-3, 0.25, i);
  let n = 0.03;
  return Se(t, at(i, e, 0.02, 4e-3, { hp: 1200 }), n, 1, i), Se(t, ei(i, 0.06, 230, 105, 0.012, 0.018), n, 0.8, i), Se(t, dn(i, 0.15, [[1310, 0.03, 1], [2460, 0.024, 0.8], [3920, 0.016, 0.6], [5640, 0.01, 0.45], [7900, 6e-3, 0.3]], e), n, 0.36, i), Se(t, dn(i, 0.3, [[722, 0.075, 1], [1451, 0.05, 0.35]], e), n + 2e-3, 0.1, i), Wo(t, 1.3);
}
function o8(i, e, t) {
  let n = St(i, 0.55), s = [1, 1.09, 0.93][t % 3], o = 0, r = 1, a = 2 + (t !== 1 ? 1 : 0);
  for (let l = 0; l < a; l++) {
    let c = s * Xt(e, 0.96, 1.05);
    Se(n, dn(i, 0.22, [[4180 * c, Xt(e, 0.03, 0.055), 1], [6830 * c, 0.03, 0.7], [9760 * c, 0.02, 0.5], [11900 * c, 0.012, 0.3], [2470 * c, 0.012, 0.3]], e), o, r * 0.5, i), Se(n, at(i, e, 4e-3, 8e-4, { hp: 3500 }), o, r * 0.5, i), o += Xt(e, 0.085, 0.15) * (l ? 0.75 : 1), r *= Xt(e, 0.45, 0.62);
  }
  return n;
}
function r8(i, e, t) {
  let n = St(i, 0.3), s = [1, 1.07, 0.94, 1.03][t & 3];
  Se(n, ei(i, 0.06, 112 * s, 58 * s, 0.018, 0.02, 2e-3), 0, 0.75, i), Se(n, at(i, e, 0.06, 0.016, { lp: 720 * s }), 0, 0.9, i), Se(n, at(i, e, 0.1, 0.028, { bp: 2500 * s, q: 0.7, att: 4e-3 }), 0.012, 0.22, i);
  let o = at(i, e, 0.2, 0.05, { hp: 3800, att: 0.01 }), r = 1;
  for (let a = 0; a < o.length; a++) a % 70 === 0 && (r = 0.3 + e() * 0.7), o[a] *= r;
  return Se(n, o, 0.02, 0.16, i), n;
}
function t_(i, e, t, n) {
  let s = St(i, t), o = Qn(i, t * 0.9, e);
  di(o, "bp", Vo(1500, 520), 0.8, i), Se(s, lo(o, i, co(0.085 * n, 7e-3)), 0, 0.9, i), Se(s, at(i, e, t * 0.8, 0.07 * n, { hp: 3e3, att: 0.012 }), 0.01, 0.25, i);
  let r = Math.round(5 * n);
  for (let a = 0; a < r; a++) {
    let l = Xt(e, 500, 1700);
    Se(s, jc(i, Xt(e, 8e-3, 0.02), l, l * Xt(e, 1.3, 1.9)), Xt(e, 0.03, t * 0.6), Xt(e, 0.1, 0.3), i);
  }
  return s;
}
function a8(i, e, t) {
  let n = t_(i, e, 0.46, 1 + t * 0.08);
  return Se(n, ei(i, 0.06, 100, 55, 0.02, 0.02, 2e-3), 0, 0.5, i), n;
}
function l8(i, e, t) {
  let n = St(i, 0.38), s = [1, 1.08, 0.92][t % 3];
  return Se(n, ei(i, 0.06, 120, 62, 0.018, 0.02, 2e-3), 0, 0.6, i), Se(n, at(i, e, 0.04, 8e-3, { lp: 2400 }), 0, 0.6, i), Se(n, dn(i, 0.36, [[178 * s, 0.09, 1], [412 * s, 0.075, 0.8], [733 * s, 0.06, 0.55], [1214 * s, 0.045, 0.4], [1958 * s, 0.03, 0.3], [3130 * s, 0.016, 0.18]], e), 1e-3, 0.3, i), Se(n, at(i, e, 0.08, 0.02, { bp: 3e3, q: 0.8, att: 3e-3 }), 0.01, 0.1, i), n;
}
function c8(i, e) {
  let t = St(i, 0.45);
  Se(t, ei(i, 0.14, 124, 44, 0.03, 0.045, 2e-3), 0, 1, i), Se(t, at(i, e, 0.14, 0.035, { lp: 520 }), 0, 1, i), Se(t, at(i, e, 0.2, 0.06, { bp: 1500, q: 0.7, att: 0.01 }), 0.01, 0.16, i);
  for (let n of [0.022, 0.05, 0.088]) Se(t, at(i, e, 0.012, 3e-3, { bp: Xt(e, 2200, 4200), q: 2 }), n, Xt(e, 0.1, 0.22), i);
  return Se(t, at(i, e, 0.2, 0.05, { hp: 3500, att: 0.01 }), 0.015, 0.1, i), Wo(t, 1.2);
}
function u8(i, e) {
  let t = St(i, 0.26);
  return Se(t, at(i, e, 0.2, 0.05, { bp: 900, q: 0.7, att: 0.02 }), 0, 0.6, i), Se(t, at(i, e, 0.1, 0.025, { bp: 2600, q: 0.8, att: 4e-3 }), 5e-3, 0.35, i), Se(t, ei(i, 0.05, 95, 60, 0.02, 0.018, 3e-3), 0, 0.4, i), t;
}
function h8(i, e) {
  let t = St(i, 0.5);
  return Se(t, ei(i, 0.25, 92, 38, 0.04, 0.06, 15e-4), 0, 1.1, i), Se(t, at(i, e, 0.2, 0.04, { lp: 320 }), 0, 1.2, i), Se(t, at(i, e, 0.06, 0.01, { bp: 820, q: 1 }), 0, 0.55, i), Se(t, at(i, e, 0.03, 4e-3, { hp: 1800, lp: 5e3 }), 0, 0.2, i), Wo(t, 1.6);
}
function f8(i) {
  let e = St(i, 2.4);
  for (let t = 0; t < e.length; t++) {
    let n = t / i;
    e[t] = (Math.sin(vt * 3150 * n) + 0.7 * Math.sin(vt * 4013 * n + 1) + 0.35 * Math.sin(vt * 5310 * n + 2)) * (1 - Math.exp(-n / 0.12)) * Math.exp(-n / 0.55);
  }
  return e;
}
function d8(i, e, t) {
  let n = St(i, 0.5), s = [640, 880, 745][t % 3] * Xt(e, 0.97, 1.03);
  return Se(n, at(i, e, 0.015, 3e-3, { hp: 1500 }), 0, 1, i), Se(n, at(i, e, 0.04, 8e-3, { lp: 1800 }), 0, 0.6, i), Se(n, dn(i, 0.48, [1, 1.58, 2.24, 2.92, 3.71, 4.93, 6.31, 8.1].map((r, a) => [s * r, 0.13 / (1 + a * 0.55), 1 / (1 + a * 0.5)]), e), 5e-4, 0.42, i), n;
}
function p8(i, e, t) {
  let n = St(i, 0.36), s = [1, 1.1, 0.9][t % 3];
  return Se(n, at(i, e, 0.06, 0.013, { lp: 950 * s }), 0, 1.1, i), Se(n, ei(i, 0.05, 150 * s, 70, 0.012, 0.016), 0, 0.6, i), Se(n, at(i, e, 0.012, 2e-3, { hp: 2e3 }), 0, 0.6, i), Se(n, at(i, e, 0.12, 0.024, { bp: 3500 * s, q: 0.7 }), 3e-3, 0.3, i), Se(n, Jc(i, e, 0.34, 16, { from: 0.03, fall: 1.8, hp: 1800, ampFall: 0.1 }), 0, 0.35, i), n;
}
function m8(i, e, t) {
  let n = St(i, 0.26), s = t ? 1.14 : 1;
  return Se(n, dn(i, 0.2, [[238 * s, 0.03, 1], [512 * s, 0.022, 0.8], [893 * s, 0.016, 0.6], [1410 * s, 0.01, 0.4]], e), 0, 0.6, i), Se(n, at(i, e, 0.03, 6e-3, { lp: 2100 }), 0, 0.8, i), Se(n, at(i, e, 0.01, 2e-3, { hp: 3e3 }), 0, 0.5, i), Se(n, Jc(i, e, 0.2, 6, { from: 0.01, fall: 2, bp: 2600, q: 1.5 }), 0, 0.3, i), n;
}
function g8(i, e, t) {
  let n = t_(i, e, 0.5, 0.8 + t * 0.2);
  return Se(n, jc(i, 0.035, 420, 1150), 0, 0.5, i), n;
}
function v8(i, e, t) {
  let n = St(i, 0.3), s = [1, 1.12, 0.9][t % 3];
  Se(n, at(i, e, 0.03, 7e-3, { hp: 4e3 }), 0, 0.9, i), Se(n, dn(i, 0.12, [[2920 * s, 0.022, 1], [4730 * s, 0.018, 0.8], [7310 * s, 0.012, 0.6], [1180 * s, 0.03, 0.5]], e), 0, 0.4, i), Se(n, at(i, e, 0.05, 0.012, { bp: 320 * s, q: 1.5 }), 0, 0.9, i);
  let o = Qn(i, 0.06, e);
  tn(o, "bp", 2400, 1, i);
  for (let r = 0; r < o.length; r++) {
    let a = r / i;
    o[r] *= (Math.sin(vt * 118 * a) > 0.2 ? 1 : 0.1) * Math.exp(-a / 0.02);
  }
  return Se(n, o, 4e-3, 0.5, i), Se(n, Jc(i, e, 0.28, 10, { from: 0.02, fall: 1.6, hp: 5e3, ampFall: 0.08 }), 0, 0.3, i), n;
}
function x8(i, e) {
  let t = St(i, 0.45);
  Se(t, at(i, e, 0.01, 2e-3, { hp: 2500 }), 0, 1, i);
  for (let n = 0; n < 9; n++) {
    let s = Xt(e, 3200, 9500);
    Se(t, dn(i, 0.1, [[s, Xt(e, 0.01, 0.03), 1], [s * 1.47, 0.01, 0.5]], e), Math.pow(e(), 2) * 0.3, Xt(e, 0.1, 0.35), i);
  }
  return t;
}
function y8(i, e, t) {
  let n = St(i, 0.75), s = [3300, 2700, 3900][t % 3], o = [820, 1100, 700][t % 3], r = 0, a = Qn(i, 0.75, e);
  for (let l = 0; l < n.length; l++) {
    let c = l / i, u = o + (s - o) * Math.exp(-c / 0.16), h = 1 + 0.035 * Math.sin(vt * (18 + 30 * c) * c);
    r += vt * u * h / i, n[l] = (Math.sin(r) + 0.3 * Math.sin(2 * r)) * (1 - Math.exp(-c / 4e-3)) * Math.exp(-c / 0.19);
  }
  return di(a, "bp", (l) => o + (s - o) * Math.exp(-l * 0.75 / 0.16), 6, i), Se(n, lo(a, i, co(0.15, 3e-3)), 0, 1.6, i), Se(n, at(i, e, 0.01, 2e-3, { hp: 2500 }), 0, 0.7, i), n;
}
function b8(i, e, t) {
  let n = St(i, 0.3), s = Qn(i, 0.28, e), o = [5200, 4300, 6100][t % 3], r = [1300, 1e3, 1700][t % 3];
  di(s, "bp", Vo(o, r, 0.8), 3.5, i);
  for (let l = 0; l < s.length; l++) {
    let c = (l / i - 0.05) / (l / i < 0.05 ? 0.018 : 0.05);
    s[l] *= Math.exp(-c * c);
  }
  Se(n, s, 0, 1, i), Se(n, at(i, e, 6e-3, 8e-4, { hp: 3e3 }), 0.048, 0.25, i);
  let a = jc(i, 0.2, o * 0.5, r * 0.6);
  return Se(n, a, 0, 0.03, i), n;
}
var Tv = (i, e) => Math.round(i * e) / e;
function* _8(i, e) {
  let n = i * 2, s = new Float32Array(n), o = [[184, 2.5], [207.5, 3.5], [233, 2], [258.5, 4.5]];
  for (let [l, c] of o) {
    let u = Tv(l, 2), h = Tv(c, 2), f = e() * vt, p = e() * vt;
    for (let d = 0; d < n; d++) {
      let v = d / i, g = vt * u * v + f;
      s[d] += (Math.sin(g) + 0.5 * Math.sin(2 * g + 1) + 0.3 * Math.sin(3 * g + 2) + 0.16 * Math.sin(4 * g) + 0.08 * Math.sin(6 * g)) * (0.72 + 0.28 * Math.sin(vt * h * v + p)) * 0.25;
    }
    yield;
  }
  let r = Zc(i, 2, e, (l) => {
    tn(l, "hp", 1100, 0.7, i), tn(l, "lp", 5200, 0.7, i);
  }, 0.25), a = Tv(46, 2);
  for (let l = 0; l < n; l++) s[l] += r[l] * (0.55 + 0.45 * Math.sin(vt * a * l / i)) * 0.5;
  return s;
}
function M8(i, e) {
  let n = i * 2, s = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let a = r / i, l = 1.1 * Math.sin(vt * 0.5 * a) + 0.5 * Math.sin(vt * 1.5 * a + 1), c = vt * 310 * a + l, u = 0.7 + 0.3 * Math.sin(vt * 1.5 * a), h = (Math.sin(c) + 0.45 * Math.sin(2 * c + l) + 0.2 * Math.sin(4 * c + 0.5)) * 0.3 * u, f = vt * 62 * a;
    h += (Math.sin(f) + 0.5 * Math.sin(2 * f) + 0.33 * Math.sin(3 * f) + 0.2 * Math.sin(5 * f)) * 0.28, s[r] = h;
  }
  let o = Zc(i, 2, e, (r) => {
    tn(r, "hp", 2800, 0.7, i), tn(r, "lp", 7e3, 0.7, i);
  }, 0.25);
  for (let r = 0; r < n; r++) s[r] += o[r] * 0.12 * (0.6 + 0.4 * Math.sin(vt * 1.5 * r / i + 2));
  return s;
}
function w8(i, e) {
  let n = i * 2, s = new Float32Array(n);
  for (let r = 0; r < n; r++) {
    let a = r / i, l = vt * 50 * a;
    s[r] = (Math.sin(l) * 0.5 + Math.sin(2 * l + 0.4) + 0.5 * Math.sin(3 * l + 1) + 0.3 * Math.sin(4 * l) + 0.22 * Math.sin(6 * l + 2) + 0.12 * Math.sin(10 * l)) * 0.3 * (0.9 + 0.1 * Math.sin(vt * 0.5 * a)) + Math.sin(vt * 4100 * a) * 0.012 * (0.6 + 0.4 * Math.sin(vt * 1 * a)) + Math.sin(vt * 1250 * a + 0.6 * Math.sin(vt * 2 * a)) * 0.02;
  }
  let o = Zc(i, 2, e, (r) => tn(r, "bp", 2100, 1.2, i), 0.25);
  for (let r = 0; r < n; r++) s[r] += o[r] * 0.16 * Math.pow(0.5 + 0.5 * Math.sin(vt * 100 * r / i), 3);
  return s;
}
function E8(i, e, t) {
  let n = St(i, 0.3), s = t ? 1.07 : 1, o = 0;
  Se(n, at(i, e, 8e-3, 12e-4, { hp: 3200 }), 0, 1.1, i);
  let r = St(i, 0.12);
  for (let a = 0; a < r.length; a++) {
    let l = a / i, c = (380 + 620 * Math.exp(-l / 0.018)) * s;
    o += c / i;
    let u = 2 * (o - Math.floor(o)) - 1;
    r[a] = (u + 0.5 * Math.sign(Math.sin(vt * o * 2.02))) * Math.exp(-l / 0.024);
  }
  return tn(r, "bp", 1500 * s, 0.9, i), Se(n, r, 0, 1.5, i), Se(n, at(i, e, 0.08, 0.014, { bp: 2400 * s, q: 1.4 }), 0, 0.7, i), Se(n, ei(i, 0.05, 240, 120, 0.012, 0.014), 0, 0.5, i), Se(n, dn(i, 0.05, [[3400 * s, 6e-3, 1], [5200, 5e-3, 0.6], [1900, 8e-3, 0.5]], e), 0.021, 0.2, i), Se(n, at(i, e, 0.15, 0.04, { hp: 6e3 }), 2e-3, 0.1, i), Wo(ml(n, 0.6), 1.6);
}
function S8(i, e, t) {
  let n = St(i, 0.48), s = t ? 0.94 : 1;
  return Se(n, at(i, e, 0.012, 2e-3, { hp: 1500, lp: 6e3 }), 0, 0.7, i), Se(n, ei(i, 0.3, 112 * s, 37 * s, 0.035, 0.07), 0, 1.4, i), Se(n, at(i, e, 0.3, 0.045, { hp: 90, lp: 900 * s }), 0, 1.2, i), Se(n, at(i, e, 0.12, 0.024, { bp: 420 * s, q: 1.6 }), 0, 1.2, i), Se(n, dn(i, 0.12, [[310 * s, 0.03, 1], [642 * s, 0.022, 0.7], [985 * s, 0.016, 0.5], [2200, 6e-3, 0.3]], e), 0.055, 0.3, i), Se(n, at(i, e, 0.02, 4e-3, { bp: 1800, q: 1 }), 0.055, 0.25, i), Wo(ml(n, 0.42), 1.8);
}
function T8(i, e, t) {
  let n = St(i, 0.42), s = [1, 1.07, 0.93][t % 3];
  Se(n, jc(i, 0.035, 920 * s, 610 * s), 0, 0.06, i);
  let o = 0.03;
  return Se(n, ei(i, 0.2, 84 * s, 41, 0.03, 0.05, 2e-3), o, 1.1, i), Se(n, at(i, e, 0.12, 0.03, { lp: 360 }), o, 1.1, i), Se(n, at(i, e, 0.03, 6e-3, { lp: 2600, hp: 500 }), o, 0.4, i), Se(n, dn(i, 0.12, [[522 * s, 0.026, 1], [1133 * s, 0.02, 0.7], [1871 * s, 0.014, 0.5], [3040 * s, 8e-3, 0.3]], e), o, 0.2, i), Se(n, at(i, e, 0.14, 0.04, { hp: 3e3, att: 6e-3 }), o + 0.01, 0.06, i), Wo(n, 1.5);
}
function A8(i, e) {
  let t = St(i, 1.5), n = [0, 0, 0, 0];
  Se(t, at(i, e, 0.02, 4e-3, { hp: 2500 }), 0, 0.9, i);
  let s = [184, 207, 233, 258];
  for (let a = 0; a < Math.round(1.1 * i); a++) {
    let l = a / i, c = Math.pow(0.16, l / 1) * (1 + 0.06 * Math.sin(vt * (9 - 5 * l) * l)), u = 0;
    for (let f = 0; f < 4; f++) n[f] += vt * s[f] * c / i, u += Math.sin(n[f]) + 0.5 * Math.sin(2 * n[f]) + 0.3 * Math.sin(3 * n[f]);
    let h = 0.6 + 0.4 * Math.sign(Math.sin(vt * (26 - 16 * l) * l));
    t[a] += u * 0.16 * h * Math.exp(-l / 0.55) * (1 - Math.exp(-l / 0.01));
  }
  let o = Qn(i, 1, e);
  di(o, "bp", Vo(3200, 500), 1, i), Se(t, lo(o, i, co(0.35, 0.01)), 0, 0.3, i);
  let r = 0.72;
  return Se(t, at(i, e, 0.2, 0.035, { lp: 3e3 }), r, 1, i), Se(t, ei(i, 0.12, 130, 55, 0.02, 0.035), r, 0.8, i), Se(t, dn(i, 0.4, [[705, 0.07, 1], [1490, 0.05, 0.7], [2610, 0.035, 0.5], [4020, 0.02, 0.3]], e), r, 0.28, i), Se(t, Jc(i, e, 0.7, 26, { from: 0.02, fall: 1.7, hp: 1500, ampFall: 0.2, maxLen: 8e-3 }), r, 0.5, i), Se(t, dn(i, 0.2, [[1900, 0.03, 1], [3350, 0.02, 0.6]], e), r + 0.19, 0.14, i), Wo(t, 1.4);
}
function R8(i, e) {
  let t = St(i, 1.9), n = 0, s = 0, o = St(i, 1.3);
  for (let r = 0; r < o.length; r++) {
    let a = r / i, l = 30 + 112 * Math.pow(1 - a / 1.3, 1.6);
    n += l / i, s += (180 + 1050 * Math.exp(-a / 0.3)) / i, o[r] = (2 * (n - Math.floor(n)) - 1) * (1 - Math.exp(-a / 0.02)) * Math.pow(1 - a / 1.3, 0.7) + Math.sin(vt * s) * 0.25 * Math.exp(-a / 0.4);
  }
  di(o, "lp", Vo(1100, 160), 2.5, i), Se(t, o, 0, 0.55, i), Se(t, at(i, e, 0.03, 6e-3, { hp: 2e3 }), 0, 0.5, i);
  for (let [r, a, l] of [[0.62, 1, 1], [0.84, 0.75, 1.22], [0.98, 0.5, 0.86], [1.17, 0.42, 1.4], [1.33, 0.22, 1.1]]) Se(t, ei(i, 0.1, 105 * l, 48, 0.02, 0.035), r, a * 0.9, i), Se(t, at(i, e, 0.08, 0.016, { lp: 2400 }), r, a * 0.8, i), Se(t, dn(i, 0.3, [[388 * l, 0.07, 1], [861 * l, 0.05, 0.7], [1540 * l, 0.035, 0.5], [2750 * l, 0.02, 0.35]], e), r, a * 0.3, i);
  return Se(t, Jc(i, e, 1, 22, { from: 0, fall: 1.2, hp: 1800, ampFall: 0.4, maxLen: 7e-3 }), 0.62, 0.3, i), Wo(ml(t, 0.55), 1.5);
}
function C8(i, e, t) {
  let n = St(i, 0.52), s = t ? 622 : 1320, o = s * 1.4142, r = 0, a = (l, c, u, h) => {
    let f = Math.round(c * i), p = Math.round(l * i);
    for (let d = 0; d < f; d++) {
      let v = d / f, g = d / i;
      r += vt * u * (1 + h * v) / i;
      let x = Math.sin(r + 1.6 * Math.sin(r * 0.25) + 0.4 * Math.sin(vt * 71 * g));
      n[p + d] += Math.tanh(x * 2.2) * Math.min(1, d / (4e-3 * i), (f - d) / (0.012 * i));
    }
  };
  return a(0, 0.09, s, 0), a(0.12, 0.17, o, -0.05), t && a(0.3, 0.2, s * 0.5, 0.5), tn(n, "bp", t ? 1100 : 2100, 0.6, i), Se(n, at(i, e, 0.4, 0.2, { hp: 4e3, att: 0.02 }), 0, 0.03, i), n;
}
function P8(i, e, t) {
  let n = St(i, 0.6), s = n.length, o = 0.55, r = 0, a = 0;
  for (let c = 0; c < s; c++) {
    let u = c / i, h = Math.min(1, u / o), f = Math.pow(h, 1.4) * (u < o ? 1 : Math.exp(-(u - o) / 8e-3));
    if (t) {
      r += (170 + 380 * h * h) / i, a += (680 + 900 * h) / i;
      let p = 2 * (r - Math.floor(r)) - 1;
      n[c] = (p * (0.7 + 0.3 * Math.sin(vt * 38 * u)) + 0.35 * Math.sin(vt * a)) * f;
    } else r += (620 + 1900 * h * h * h) / i, a += (1240 + 3800 * h * h * h) * 1.003 / i, n[c] = (Math.sin(vt * r) + 0.4 * Math.sin(vt * a) + 0.25 * Math.sign(Math.sin(vt * r * 0.5))) * f * (0.8 + 0.2 * Math.sin(vt * (20 + 60 * h) * u));
  }
  tn(n, "lp", t ? 2600 : 7e3, 0.7, i), tn(n, "hp", t ? 120 : 400, 0.7, i);
  let l = t ? 7 : 5;
  for (let c = 0; c < l; c++) {
    let u = o * Math.sqrt(c / l);
    Se(n, dn(i, 0.03, [[t ? 1500 : 3800, 4e-3, 1], [t ? 2600 : 6100, 3e-3, 0.6]], e), u, 0.12 + 0.2 * c / l, i);
  }
  return n;
}
function I8(i, e, t) {
  let n = St(i, 3), s = t ? 0.9 : 1;
  Se(n, at(i, e, 0.03, 6e-3, { hp: 1500 }), 0, 1.8, i), Se(n, ei(i, 1.6, 96 * s, 27, 0.16, 0.36, 1e-3), 0, 0.85, i);
  let o = Qn(i, 1.6, e);
  di(o, "lp", Vo(2800, 260, 0.5), 0.7, i), Se(n, lo(o, i, co(0.26, 2e-3)), 0, 3.2, i);
  let r = Qn(i, 2.6, e);
  tn(r, "lp", 120, 0.7, i), Se(n, lo(r, i, co(0.7, 0.03)), 0, 2.2, i), Se(n, at(i, e, 0.5, 0.09, { bp: 520 * s, q: 1.2 }), 0, 1.3, i), Se(n, Jc(i, e, 2.5, 120, { from: 0.25, fall: 1.5, hp: 1500, lp: 9e3, ampFall: 0.8, maxLen: 0.01 }), 0, 0.5, i);
  for (let a = 0; a < 7; a++) {
    let l = Xt(e, 900, 3600);
    Se(n, dn(i, 0.2, [[l, Xt(e, 0.02, 0.06), 1], [l * 1.61, 0.02, 0.5]], e), Xt(e, 0.4, 1.9), Xt(e, 0.03, 0.09), i);
  }
  return Wo(ml(n, 0.36), 1.7);
}
function z8(i, e) {
  let t = St(i, 1.7);
  Se(t, at(i, e, 0.01, 2e-3, { hp: 2500 }), 0, 1, i);
  let n = Qn(i, 0.5, e);
  tn(n, "bp", 3e3, 0.8, i);
  let s = 1;
  for (let l = 0; l < n.length; l++) {
    let c = l / i;
    l % 220 === 0 && (s = e() < 0.55 + 0.4 * (1 - c / 0.5) ? 1 : 0), n[l] = (n[l] * (Math.sin(vt * 100 * c) > -0.2 ? 1 : 0.15) + 0.35 * Math.sign(Math.sin(vt * 100 * c)) * (e() - 0.3)) * s * Math.exp(-c / 0.3);
  }
  Se(t, n, 5e-3, 0.8, i);
  let o = St(i, 1.25), r = 0, a = 0;
  for (let l = 0; l < o.length; l++) {
    let c = l / i, u = Math.pow(0.22, c / 1.2);
    r += vt * 100 * u / i, a += vt * (150 + 1900 * Math.pow(1 - c / 1.25, 2.2)) / i, o[l] = ((Math.sin(r) + 0.6 * Math.sin(2 * r) + 0.4 * Math.sin(3 * r) + 0.25 * Math.sin(5 * r)) * 0.5 + Math.sin(a) * 0.22) * Math.pow(1 - c / 1.25, 1.2) * (1 - Math.exp(-c / 0.03));
  }
  return Se(t, o, 0.4, 0.8, i), Se(t, ei(i, 0.12, 140, 60, 0.03, 0.04), 0.4, 0.5, i), Wo(t, 1.3);
}
function* D8(i, e, t) {
  let n = St(i, 6.5), s = Qn(i, 6.4, e);
  yield, di(s, "lp", Vo(t ? 520 : 380, 70, 0.6), 0.7, i), yield;
  let o = [];
  for (let a = 0; a < 9; a++) o.push([Xt(e, 0.05, 3.6), Xt(e, 0.12, 0.5), Xt(e, 0.4, 1)]);
  for (let a = 0; a < s.length; a++) {
    let l = a / i, c = 0;
    for (let [u, h, f] of o) {
      let p = (l - u) / h;
      c += f * Math.exp(-p * p);
    }
    s[a] *= (0.25 + c) * Math.exp(-l / 1.9) * (1 - Math.exp(-l / 0.05));
  }
  Se(n, s, 0, 1, i), yield;
  let r = Qn(i, 6, e);
  return tn(r, "bp", 48, 1.2, i), Se(n, lo(r, i, co(2, 0.2)), 0.05, 3, i), t && Se(n, at(i, e, 0.3, 0.06, { hp: 300, lp: 2500 }), 0.02, 0.25, i), n;
}
var jb = [0, 1, 0.435, 0.268, 0.19, 0.145, 0.116, 0.097];
function L8(i, e) {
  let t = St(i, 5), n = t.length;
  for (let s = 0; s < n; s++) {
    let o = s / i, r = 25e-4 * Math.sin(vt * 4.3 * o), a = Math.min(1, o / 0.45) * Math.min(1, (5 - o) / 1.5) * (o < 3.2 ? 1 : Math.exp(-(o - 3.2) / 0.7)), l = 0;
    for (let c = 1; c <= 7; c++) l += Math.sin(vt * 92.5 * c * o * (1 + r) + c) * jb[c];
    for (let c = 1; c <= 4; c++) l += 0.45 * Math.sin(vt * 138.6 * c * o + c * 2) * jb[c];
    t[s] = l * a;
  }
  return tn(t, "lp", 520, 0.7, i), t;
}
function k8(i, e, t) {
  let n = St(i, 1.4), s = t ? 3 : 4, o = 0.02;
  for (let r = 0; r < s; r++) {
    let a = Xt(e, 0.17, 0.26) * (t ? 1.4 : 1), l = Math.round(a * i), c = Math.round(o * i), u = (t ? 1250 : 1550) * (1 - r * 0.04), h = 0;
    for (let f = 0; f < l && c + f < n.length; f++) {
      let p = f / l, d = u * (1 + 0.55 * Math.sin(Math.PI * Math.pow(p, 0.6)) - 0.25 * p);
      h += vt * d / i;
      let v = 1 + 0.3 * Math.sin(vt * 63 * f / i);
      n[c + f] += (Math.sin(h) + 0.6 * Math.sin(2 * h + 0.5) + 0.35 * Math.sin(3 * h) + 0.15 * Math.sin(4 * h)) * v * Math.pow(Math.sin(Math.PI * p), 0.7) * (1 - r * 0.14);
    }
    o += a + Xt(e, 0.05, 0.12);
  }
  return tn(n, "lp", 4200, 0.7, i), n;
}
function F8(i, e, t) {
  let n = St(i, 1.1), s = t ? 1.19 : 1, o = 0.01, r = t ? 3 : 4;
  for (let a = 0; a < r; a++) Se(n, dn(i, 0.5, [[2310 * s, Xt(e, 0.06, 0.13), 1], [3740 * s, 0.07, 0.7], [5910 * s, 0.04, 0.5], [8130 * s, 0.025, 0.3], [1012 * s, 0.03, 0.3]], e), o, Xt(e, 0.35, 1), i), Se(n, at(i, e, 4e-3, 1e-3, { hp: 3e3 }), o, 0.3, i), o += Xt(e, 0.09, 0.26);
  return n;
}
function U8(i, e) {
  let t = St(i, 2.8), n = St(i, 2.2);
  return Se(n, dn(i, 2.2, [[47, 0.7, 1], [77, 0.55, 0.9], [121, 0.4, 0.7], [163, 0.3, 0.5], [214, 0.22, 0.4], [330, 0.12, 0.25]], e), 0, 0.5, i), Se(n, at(i, e, 0.5, 0.11, { lp: 420 }), 0, 1, i), Se(t, n, 0, 1, i), Se(t, n, 0.36, 0.3, i), Se(t, n, 0.61, 0.12, i), t;
}
function N8(i, e) {
  let t = St(i, 0.09);
  return Se(t, dn(i, 0.08, [[1820, 9e-3, 1], [2730, 7e-3, 0.6], [640, 0.012, 0.5]], e), 0, 1, i), Se(t, at(i, e, 4e-3, 1e-3, { hp: 2500 }), 0, 0.5, i), t;
}
function B8(i, e) {
  let t = St(i, 0.06);
  return Se(t, dn(i, 0.05, [[3200, 8e-3, 1], [4800, 5e-3, 0.3]], e), 0, 1, i), t;
}
function* O8(i, e) {
  let n = function* (s) {
    let o = Zc(i, 6, s, (u) => {
      tn(u, "hp", 900, 0.6, i), tn(u, "lp", 8500, 0.6, i);
    });
    yield;
    let r = Zc(i, 6, s, (u) => {
      tn(u, "bp", 420, 0.5, i);
    }), a = o.length, l = Q1(a, [o, 0.5], [r, 0.75]), c = new Float32Array(a);
    for (let u = 0; u < 1020; u++) {
      let h = Math.floor(s() * a), f = Math.round(Xt(s, 6e-4, 3e-3) * i), p = Math.pow(s(), 3) * 1.6 + 0.15;
      for (let d = 0; d < f; d++) c[h] += (s() * 2 - 1) * p * Math.exp(-5 * d / f), ++h >= a && (h = 0);
    }
    yield, di(c, "hp", () => 2200, 0.7, i, 2), yield;
    for (let u = 0; u < 30; u++) {
      let h = Xt(s, 700, 2100);
      Us(c, jc(i, Xt(s, 8e-3, 0.02), h, h * 1.7), s() * 6, Xt(s, 0.08, 0.3), i);
    }
    for (let u = 0; u < a; u++) l[u] += c[u] * 0.55;
    return l;
  };
  return [yield* n(seededRandom(Math.floor(e() * 1e9))), yield* n(seededRandom(Math.floor(e() * 1e9)))];
}
function* H8(i, e) {
  let n = function* (s) {
    let o = Zc(i, 6, s, (c) => {
      tn(c, "lp", 1300, 0.6, i), tn(c, "hp", 110, 0.7, i);
    }), r = o.length, a = new Float32Array(r);
    for (let c = 0; c < 1560; c++) a[Math.floor(s() * r)] += (s() * 2 - 1) * (0.2 + Math.pow(s(), 4) * 3);
    let l = Q1(r, [o, 0.8]);
    for (let [c, u, h] of [[1820, 14, 1], [2740, 16, 0.8], [4150, 18, 0.6], [6200, 14, 0.35], [940, 8, 0.7]]) {
      let f = Float32Array.from(a);
      di(f, "bp", () => c, u, i, 2);
      for (let p = 0; p < r; p++) l[p] += f[p] * h * 5;
      yield;
    }
    for (let c = 0; c < 4; c++) {
      let u = Xt(s, 900, 1600);
      Us(l, jc(i, 0.014, u, u * 1.8), s() * 6, 0.25, i);
    }
    return l;
  };
  return [yield* n(seededRandom(Math.floor(e() * 1e9))), yield* n(seededRandom(Math.floor(e() * 1e9)))];
}
function V8(i, e) {
  let s = Qn(i, 8.5, e), o = Float32Array.from(s);
  di(s, "bp", (r) => {
    let a = r * 8.5;
    return 380 + 190 * Math.sin(vt * a / 8) + 90 * Math.sin(vt * a / 2.667 + 1);
  }, 1.3, i), di(o, "bp", (r) => {
    let a = r * 8.5;
    return 1350 + 260 * Math.sin(vt * a / 4 + 2);
  }, 9, i);
  for (let r = 0; r < s.length; r++) {
    let a = r / i;
    s[r] = s[r] * (0.7 + 0.3 * Math.sin(vt * a / 8 + 0.5)) + o[r] * 0.22 * Math.pow(0.5 + 0.5 * Math.sin(vt * a / 4 + 1), 2);
  }
  return Rv(s, i * 8, true);
}
function* W8(i, e) {
  let s = Qn(i, 8.5, e), o = Qn(i, 8 + 0.5, e), r = Qn(i, 8 + 0.5, e);
  yield, tn(s, "lp", 1100, 0.6, i), tn(s, "hp", 70, 0.7, i), tn(o, "hp", 2400, 0.7, i), tn(r, "bp", 520, 1.2, i), yield;
  for (let a = 0; a < s.length; a++) {
    let l = a / i, c = l % 4 / 4, u = Math.pow(0.5 - 0.5 * Math.cos(vt * c), 1.5), h = Math.exp(-Math.pow((c - 0.5) / 0.05, 2)), f = Math.exp(-Math.pow((c - 0.68) / 0.16, 2)), p = 0.5 - 0.5 * Math.cos(vt * ((l + 1.3) % 2.667) / 2.667);
    s[a] = s[a] * (0.3 + 0.7 * u + 0.25 * p) + r[a] * h * 1.8 + o[a] * f * 0.35;
  }
  return Rv(s, i * 8, true);
}
var Fr = { bpm: 100, bar: 2.4, loopBars: 8, sr: 32e3 }, Cv = [{ root: 38, tones: [0, 3, 7, 12, 10], base: 50 }, { root: 34, tones: [0, 4, 7, 12, 11], base: 46 }, { root: 31, tones: [0, 3, 7, 12, 10], base: 43 }, { root: 33, tones: [0, 5, 7, 12, 10], base: 45 }];
function Jb(i, e, t, n, s, o, r) {
  let a = Math.round((t + s) * i), l = new Float32Array(a), c = [r(), r(), r()], u = [1 - o, 1, 1 + o * 1.1];
  for (let h = 0; h < a; h++) {
    let f = h / i, p = 0;
    for (let v = 0; v < 3; v++) c[v] += e * u[v] / i, c[v] -= Math.floor(c[v]), p += 2 * c[v] - 1;
    let d = f < t ? 1 - Math.exp(-f / n) : (1 - Math.exp(-t / n)) * Math.exp(-(f - t) / (s * 0.3));
    l[h] = p * d * 0.33;
  }
  return em(l, i, 0, 0.1), l;
}
function* G8(i, e) {
  let t = Fr.bar * 8, n = Math.round(t * i), s = function* (o) {
    let r = new Float32Array(n);
    for (let a = 0; a < 4; a++) {
      let l = Cv[a], c = a * 4.8;
      for (let [u, h] of [[0, 1], [7, 0.6], [12, 0.5], [l.tones[1] + 12, 0.28]]) Us(r, Jb(i, Ns(l.root + u), 4.6, 1.3, 1.8, 35e-4, o), c - 0.5, h * 0.3, i), yield;
    }
    return Us(r, Jb(i, Ns(26), t - 0.2, 2.5, 0.2, 2e-3, o), 0.1, 0.16, i), yield, di(r, "lp", (a) => 560 + 300 * Math.sin(vt * a * 2) + 120 * Math.sin(vt * a * 5 + 1), 0.9, i, 2), yield, r;
  };
  return [yield* s(seededRandom(Math.floor(e() * 1e9))), yield* s(seededRandom(Math.floor(e() * 1e9)))];
}
function n_(i, e, t) {
  let n = Math.round(0.42 * i), s = new Float32Array(n), o = 0, r = 0, a = 0, l = 0, c = 0;
  for (let u = 0; u < n; u++) {
    let h = u / i;
    o += e / i, o -= Math.floor(o), r += e * 0.5 / i, r -= Math.floor(r);
    let f = 2 * o - 1 + 0.4 * (r < 0.5 ? 1 : -1);
    (u & 15) === 0 && (c = 1 - Math.exp(-vt * (300 + 2600 * t * Math.exp(-h / 0.06)) / i)), a += (f - a) * c, l += (a - l) * c, s[u] = l * Math.exp(-h / 0.1) * Math.min(1, u / 40);
  }
  return em(s, i, 0, 0.03);
}
function* q8(i) {
  let e = Fr.bar * 8, t = new Float32Array(Math.round(e * i)), n = [0, 0, 2, 0, 1, 0, 2, 0, 3, 0, 2, 0, 1, 0, 4, 2], s = [1, 0.45, 0.7, 0.45, 0.85, 0.45, 0.7, 0.5, 1, 0.45, 0.7, 0.45, 0.85, 0.5, 0.8, 0.6];
  for (let o = 0; o < 128; o++) {
    let r = Cv[o >> 5 & 3], a = o & 15, l = n_(i, Ns(r.base + r.tones[n[a]]), s[a]);
    Us(t, l, o * 0.15, 0.5 * (0.5 + 0.5 * s[a]), i), Us(t, l, o * 0.15 + 0.45, 0.14, i), (o & 7) === 7 && (yield);
  }
  return t;
}
function* X8(i, e) {
  let t = Fr.bar * 4, n = new Float32Array(Math.round(t * i)), s = () => Q1(Math.round(0.9 * i), [ei(i, 0.9, 74, 34, 0.07, 0.24, 2e-3), 1], [at(i, e, 0.4, 0.07, { lp: 240 }), 1.2], [at(i, e, 0.05, 8e-3, { bp: 1400, q: 0.8 }), 0.25]), o = (a) => Q1(Math.round(0.5 * i), [ei(i, 0.5, a, a * 0.55, 0.05, 0.12, 2e-3), 1], [at(i, e, 0.1, 0.02, { lp: 600 }), 0.5]), r = (a) => at(i, e, 0.06, 8e-3 + a * 0.01, { hp: 6500 });
  for (let a = 0; a < 4; a++) {
    let l = a * 2.4;
    Us(n, s(), l, 1, i), Us(n, o(104), l + 1.5, 0.55, i), a % 2 === 1 && Us(n, s(), l + 2.1, 0.6, i);
    for (let c = 0; c < 16; c++) Us(n, r(c % 4 === 2 ? 1 : 0), l + c * 0.15, c % 4 === 2 ? 0.34 : c % 2 ? 0.11 : 0.2, i);
    yield;
  }
  for (let [a, l] of [[12, 120], [13, 104], [14, 88], [15, 74]]) Us(n, o(l), 7.2 + a * 0.15, 0.6, i);
  return Wo(n, 1.3);
}
function $c(i, e, t) {
  let n = Math.round(t * i), s = new Float32Array(n), o = 0, r = 0, a = 0, l = 0, c = null;
  for (let u = 0; u < n; u++) {
    let h = u / i, f = u / n, p = Math.pow(Math.sin(Math.PI * Math.pow(f, 0.8)), 1.5), d = 1 + 4e-3 * Math.sin(vt * 5.1 * h) * Math.min(1, h);
    o += e * d / i, o -= Math.floor(o), r += e * 1.004 * d / i, r -= Math.floor(r), (u & 31) === 0 && (c = Av("lp", 240 + 1700 * p * p, 1.1, i));
    let v = 2 * o - 1 + (2 * r - 1), g = c[0] * v + a;
    a = c[1] * v - c[3] * g + l, l = c[2] * v - c[4] * g, s[u] = g * p * 0.5;
  }
  return s;
}
function* Y8(i) {
  let e = Fr.bar * 8, t = new Float32Array(Math.round(e * i));
  for (let n = 0; n < 4; n++) {
    let s = Cv[n];
    for (let [o, r] of [[12, 1], [19, 0.7], [24 + s.tones[1], 0.5], [24, 0.4]]) Us(t, $c(i, Ns(s.root + o), 4.7), n * 4.8 + 0.05, r * 0.3, i), yield;
  }
  return t;
}
function Pf(i, e, t) {
  let n = dn(i, t, [[e, t * 0.3, 1], [e * 2.003, t * 0.18, 0.4], [e * 3.01, t * 0.1, 0.18], [e * 4.2, t * 0.05, 0.1], [e * 0.5, t * 0.3, 0.25]]), s = Math.round(6e-3 * i);
  for (let o = 0; o < s; o++) n[o] *= o / s;
  return em(n, i, 0, 0.2);
}
function* $8(i) {
  let e = Fr.bar * 8, t = new Float32Array(Math.round(e * i)), n = (s, o, r) => {
    let a = Pf(i, Ns(o), 3.2);
    Us(t, a, s, r, i), Us(t, a, s + 0.45, r * 0.28, i), Us(t, a, s + 0.9, r * 0.1, i);
  };
  for (let [s, o] of [[0, 62], [0.9, 69], [1.8, 70], [3, 65]]) n(s, o, 0.5), yield;
  for (let [s, o] of [[0, 62], [0.9, 69], [1.8, 72], [3, 67]]) n(9.6 + s, o, 0.42), yield;
  return t;
}
function* Z8(i) {
  let e = St(i, 2.8);
  [57, 62, 65, 69].forEach((t, n) => {
    Se(e, Pf(i, Ns(t), 1.6), n * 0.15, 0.45 + n * 0.08, i), Se(e, n_(i, Ns(t), 1), n * 0.15, 0.3, i);
  }), Se(e, ei(i, 0.8, 73.4, 36.7, 0.1, 0.25, 2e-3), 0.45, 0.7, i);
  for (let t of [50, 57, 62, 64]) Se(e, $c(i, Ns(t), 2.2), 0.45, 0.14, i), yield;
  return e;
}
function* j8(i) {
  let e = St(i, 4.2);
  Se(e, ei(i, 1, 73.4, 36.7, 0.1, 0.3, 2e-3), 0, 0.9, i), Se(e, ei(i, 1, 73.4, 36.7, 0.1, 0.3, 2e-3), 0.6, 0.7, i);
  for (let t of [50, 57, 62, 65]) Se(e, $c(i, Ns(t), 1.5), 0, 0.16, i), yield;
  for (let t of [48, 55, 60, 64]) Se(e, $c(i, Ns(t), 1.4), 0.6, 0.16, i), yield;
  for (let t of [50, 57, 62, 65, 69]) Se(e, $c(i, Ns(t), 2.9), 1.2, 0.17, i), yield;
  return [62, 65, 69, 74].forEach((t, n) => Se(e, Pf(i, Ns(t), 2), 1.2 + n * 0.15, 0.4, i)), e;
}
function* J8(i) {
  let e = St(i, 6);
  Se(e, ei(i, 1.4, 73.4, 36.7, 0.15, 0.4, 3e-3), 0, 0.9, i);
  for (let [t, n] of [[38, 1], [50, 0.8], [57, 0.7], [62, 0.7], [66, 0.7], [69, 0.5]]) Se(e, $c(i, Ns(t), 5.6), 0, 0.14 * n, i), yield;
  return [62, 66, 69, 74, 78, 81].forEach((t, n) => {
    Se(e, Pf(i, Ns(t), 3), 0.3 + n * 0.3, 0.42, i), Se(e, Pf(i, Ns(t), 3), 0.75 + n * 0.3, 0.12, i);
  }), e;
}
function K8(i, e) {
  let t = St(i, 3.8), n = t.length, s = [0, 0, 0];
  for (let o = 0; o < n; o++) {
    let r = o / i, a = Math.pow(2, -1.1 * Math.pow(r / 3.8, 0.7)), l = 0;
    [73.42, 110, 146.83].forEach((c, u) => {
      s[u] += c * a * (1 + u * 2e-3) / i, s[u] -= Math.floor(s[u]), l += (2 * s[u] - 1) * (u === 1 ? 0.6 : 1);
    }), t[o] = l * 0.3 * Math.pow(1 - r / 3.8, 1.3) * (1 - Math.exp(-r / 0.01));
  }
  return di(t, "lp", Vo(1500, 110, 0.7), 1.2, i), Se(t, ei(i, 1.2, 82, 30, 0.12, 0.35, 2e-3), 0, 1, i), Se(t, at(i, e, 0.3, 0.06, { lp: 300 }), 0, 0.8, i), t;
}
function Q8(i, e) {
  let t = (n, s) => {
    let o = St(i, 1.4), r = [[0.062, 0.55], [0.089, 0.42], [0.118, 0.36], [0.151, 0.26], [0.178, 0.2], [0.243, 0.1]];
    for (let [l, c] of r) Se(o, at(i, n, 0.01, 18e-4, { hp: 700, lp: 5500 }), l * (s ? 1.07 : 0.96) + Xt(n, 0, 6e-3), c * Xt(n, 0.6, 1.15), i);
    let a = Qn(i, 1.3, n);
    return tn(a, "hp", 300, 0.7, i), di(a, "lp", Vo(6e3, 900, 0.6), 0.7, i), Se(o, lo(a, i, co(0.27, 0.04)), 0.04, 0.045, i), o;
  };
  return [t(seededRandom(Math.floor(e() * 1e9)), 0), t(seededRandom(Math.floor(e() * 1e9)), 1)];
}
function eC(i, e) {
  let t = (n, s) => {
    let o = St(i, 2.2), r = Qn(i, 2.18, n);
    di(r, "lp", Vo(5200, 650, 0.5), 0.7, i), Se(o, lo(r, i, co(0.33, 6e-3)), 0.012, 0.3, i);
    let a = Qn(i, 2.1, n);
    tn(a, "lp", 260, 0.7, i), Se(o, lo(a, i, co(0.4, 0.01)), 0.012, 0.5, i);
    for (let [l, c] of [[0.018, 0.7], [0.031, 0.55], [0.047, 0.45], [0.093, 0.3], [0.139, 0.2]]) Se(o, at(i, n, 8e-3, 15e-4, { lp: 4500 }), l * (s ? 1.09 : 0.95), c, i);
    return o;
  };
  return [t(seededRandom(Math.floor(e() * 1e9)), 0), t(seededRandom(Math.floor(e() * 1e9)), 1)];
}
var SR_HI = 44100, SR_MID = 32e3, SR_LO = 22050, SOUND_TABLE = { rifle_shot: { gen: KR, n: 4, sr: SR_HI, peak: 0.97, bus: "near", max: 5, pri: 9, boot: 1 }, rifle_tail_out: { gen: QR, n: 2, sr: SR_MID, peak: 0.5, bus: "dry", max: 3, pri: 8, boot: 1 }, rifle_tail_in: { gen: e8, n: 2, sr: SR_MID, peak: 0.62, bus: "dry", max: 3, pri: 8, boot: 1 }, rifle_dry: { gen: t8, n: 1, sr: SR_HI, peak: 0.5, bus: "near", max: 2, pri: 6, boot: 1 }, reload_magout: { gen: n8, n: 1, sr: SR_HI, peak: 0.6, bus: "near", max: 2, pri: 6 }, reload_magin: { gen: i8, n: 1, sr: SR_HI, peak: 0.65, bus: "near", max: 2, pri: 6 }, reload_bolt: { gen: s8, n: 1, sr: SR_HI, peak: 0.8, bus: "near", max: 2, pri: 6 }, shell_bounce: { gen: o8, n: 3, sr: SR_HI, peak: 0.3, bus: "world", max: 4, pri: 1, ref: 2, roll: 1 }, step_concrete: { gen: r8, n: 4, sr: SR_MID, peak: 0.45, bus: "near", max: 3, pri: 3, boot: 1 }, step_water: { gen: a8, n: 3, sr: SR_MID, peak: 0.5, bus: "near", max: 3, pri: 3, boot: 1 }, step_metal: { gen: l8, n: 3, sr: SR_MID, peak: 0.5, bus: "near", max: 3, pri: 3, boot: 1 }, land: { gen: c8, n: 1, sr: SR_MID, peak: 0.7, bus: "near", max: 2, pri: 4 }, jump: { gen: u8, n: 1, sr: SR_MID, peak: 0.35, bus: "near", max: 2, pri: 3 }, hurt: { gen: h8, n: 1, sr: SR_MID, peak: 0.85, bus: "dry", max: 2, pri: 8 }, ear_ring: { gen: f8, n: 1, sr: SR_LO, peak: 0.2, bus: "dry", max: 1, pri: 5 }, impact_metal: { gen: d8, n: 3, sr: SR_HI, peak: 0.7, bus: "world", max: 4, pri: 4, ref: 4, roll: 0.7 }, impact_concrete: { gen: p8, n: 3, sr: SR_HI, peak: 0.7, bus: "world", max: 4, pri: 4, ref: 4, roll: 0.7 }, impact_wood: { gen: m8, n: 2, sr: SR_HI, peak: 0.7, bus: "world", max: 3, pri: 4, ref: 4, roll: 0.7 }, impact_water: { gen: g8, n: 2, sr: SR_MID, peak: 0.6, bus: "world", max: 3, pri: 4, ref: 4, roll: 0.7 }, impact_enemy: { gen: v8, n: 3, sr: SR_HI, peak: 0.75, bus: "world", max: 4, pri: 5, ref: 5, roll: 0.6 }, impact_glass: { gen: x8, n: 1, sr: SR_HI, peak: 0.6, bus: "world", max: 2, pri: 4, ref: 4, roll: 0.7 }, whiz: { gen: b8, n: 3, sr: SR_HI, peak: 0.5, bus: "world", max: 3, pri: 5, ref: 2.5, roll: 0.6 }, ricochet: { gen: y8, n: 3, sr: SR_HI, peak: 0.4, bus: "world", max: 2, pri: 3, ref: 5, roll: 0.6 }, gull_fire: { gen: E8, n: 2, sr: SR_HI, peak: 0.85, bus: "world", max: 5, pri: 7, ref: 7, roll: 0.55 }, hound_fire: { gen: S8, n: 2, sr: SR_HI, peak: 0.95, bus: "world", max: 5, pri: 7, ref: 8, roll: 0.5 }, hound_step: { gen: T8, n: 3, sr: SR_MID, peak: 0.7, bus: "world", max: 4, pri: 3, ref: 5, roll: 0.8 }, gull_die: { gen: A8, n: 1, sr: SR_MID, peak: 0.85, bus: "world", max: 3, pri: 7, ref: 7, roll: 0.5 }, hound_die: { gen: R8, n: 1, sr: SR_MID, peak: 0.9, bus: "world", max: 3, pri: 7, ref: 7, roll: 0.5 }, telegraph: { gen: P8, n: 2, sr: SR_MID, peak: 0.42, bus: "world", max: 4, pri: 6, ref: 6, roll: 0.6 }, alert: { gen: C8, n: 2, sr: SR_MID, peak: 0.5, bus: "world", max: 3, pri: 6, ref: 8, roll: 0.5 }, explosion: { gen: I8, n: 2, sr: SR_HI, peak: 0.97, bus: "world", max: 3, pri: 10, ref: 12, roll: 0.5 }, relay_cut: { gen: z8, n: 1, sr: SR_MID, peak: 0.75, bus: "world", max: 2, pri: 8, ref: 6, roll: 0.5 }, thunder: { gen: D8, n: 2, sr: SR_LO, peak: 0.8, bus: "dry", max: 2, pri: 6 }, foghorn: { gen: L8, n: 1, sr: SR_LO, peak: 0.5, bus: "world", max: 1, pri: 2 }, gull_cry: { gen: k8, n: 2, sr: SR_LO, peak: 0.4, bus: "world", max: 2, pri: 1 }, halyard: { gen: F8, n: 2, sr: SR_MID, peak: 0.3, bus: "world", max: 2, pri: 1 }, container_bang: { gen: U8, n: 1, sr: SR_LO, peak: 0.6, bus: "world", max: 1, pri: 2 }, ui_click: { gen: N8, n: 1, sr: SR_HI, peak: 0.3, bus: "dry", max: 2, pri: 9 }, ui_hover: { gen: B8, n: 1, sr: SR_HI, peak: 0.12, bus: "dry", max: 2, pri: 9 }, objective: { gen: Z8, n: 1, sr: SR_MID, peak: 0.6, bus: "music", max: 1, pri: 9 }, objective_all: { gen: j8, n: 1, sr: SR_MID, peak: 0.65, bus: "music", max: 1, pri: 9 }, complete: { gen: J8, n: 1, sr: SR_MID, peak: 0.7, bus: "music", max: 1, pri: 9 }, death: { gen: K8, n: 1, sr: SR_MID, peak: 0.75, bus: "music", max: 1, pri: 9 }, gull_rotor: { gen: _8, n: 1, sr: SR_MID, peak: 0.6, loop: 1, ref: 5, roll: 0.9 }, hound_servo: { gen: M8, n: 1, sr: SR_MID, peak: 0.42, loop: 1, ref: 4, roll: 1 }, relay_hum: { gen: w8, n: 1, sr: SR_MID, peak: 0.4, loop: 1, ref: 2.5, roll: 1.4 }, rain: { gen: O8, n: 1, sr: SR_MID, peak: 0.5, loop: 1 }, rain_interior: { gen: H8, n: 1, sr: SR_MID, peak: 0.7, loop: 1 }, wind: { gen: V8, n: 1, sr: SR_LO, peak: 0.5, loop: 1 }, sea: { gen: W8, n: 1, sr: SR_LO, peak: 0.5, loop: 1, ref: 10, roll: 0.6 }, music_drone: { gen: G8, n: 1, sr: Fr.sr, peak: 0.5, loop: 1, music: 1 }, music_ost: { gen: q8, n: 1, sr: Fr.sr, peak: 0.45, loop: 1, music: 1 }, music_perc: { gen: X8, n: 1, sr: Fr.sr, peak: 0.7, loop: 1, music: 1 }, music_brass: { gen: Y8, n: 1, sr: Fr.sr, peak: 0.45, loop: 1, music: 1 }, music_motif: { gen: $8, n: 1, sr: Fr.sr, peak: 0.45, loop: 1, music: 1 }, ir_outdoor: { gen: Q8, n: 1, sr: SR_HI, peak: 0.9, ir: 1 }, ir_shed: { gen: eC, n: 1, sr: SR_HI, peak: 0.9, ir: 1 } }, i_ = { step: "step_concrete", impact: "impact_concrete", hurt: "hurt", objective_done: "objective", extraction: "complete", enemy_alert: "alert" }, isGenerator = (i) => i && typeof i.next == "function";
function o_(i, e, t) {
  let n = Array.isArray(e) ? e : [e];
  if (!i.loop) for (let r of n) em(r, t, i.ir ? 0 : 3e-4, i.ir ? 0.05 : 0.012);
  let s = 0;
  for (let r of n) s = Math.max(s, Qb(r));
  let o = s > 0 ? i.peak / s : 1;
  for (let r of n) ml(r, o);
  return { sr: t, ch: n, loop: !!i.loop };
}
function renderSound(i, e = 0, t) {
  let n = SOUND_TABLE[i];
  if (!n) return null;
  let s = t || n.sr, o = e % n.n, r = n.gen(s, seededRandom(soundSeed(i) + o * 7919), o);
  if (isGenerator(r)) {
    let a;
    do
      a = r.next();
    while (!a.done);
    r = a.value;
  }
  return o_(n, r, s);
}

export { renderSound, SOUND_TABLE };
