// Golden Hour articulated K9 robotic quadruped, Colonist humanoid rig, and
// First-Person lower-body controller (`fpbody`) ported for Deep Space.
//
// Extracted from Golden Hour (Ht0, Bt0, TB, Gt0, pU / R7, oC, n7, lB / X7)
// via tools/saltline/extract.mjs. Pure-Node safe and logarithmic-depth
// compatible (all meshes use `MeshStandardMaterial` / `ShaderMaterial` with
// `#include <logdepthbuf_...>` preserved).

import * as THREE from 'three';
import { mergeGeometries, mergeVertices, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

const Vn = mergeGeometries;
const a9 = mergeVertices;
const th = toCreasedNormals;

var Vt = Math.PI * 2, jn = Math.PI / 180, Zt = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, ns = (o2) => o2 < 0 ? 0 : o2 > 1 ? 1 : o2, Ht = (o2, t, e) => o2 + (t - o2) * e, EY = (o2, t, e) => ns((e - o2) / (t - o2));
var Fo = (o2, t, e) => {
  let s = EY(o2, t, e);
  return s * s * (3 - 2 * s);
}, Ee = (o2, t, e, s) => Ht(o2, t, 1 - Math.exp(-e * s)), TL = (o2) => 1 - Math.pow(1 - ns(o2), 3), db = (o2) => (o2 = ns(o2), o2 * o2 * (3 - 2 * o2));
function E1(o2, t) {
  let e = (t - o2) % Vt;
  return e > Math.PI ? e -= Vt : e < -Math.PI && (e += Vt), e;
}
var Fm = (o2, t, e, s) => o2 + E1(o2, t) * (1 - Math.exp(-e * s));
function Re(o2 = 1) {
  let t = o2 >>> 0, e = () => {
    t = t + 1831565813 >>> 0;
    let s = t;
    return s = Math.imul(s ^ s >>> 15, s | 1), s ^= s + Math.imul(s ^ s >>> 7, s | 61), ((s ^ s >>> 14) >>> 0) / 4294967296;
  };
  return e.range = (s, n) => s + (n - s) * e(), e.int = (s, n) => Math.floor(s + (n - s + 1) * e()), e.pick = (s) => s[Math.floor(e() * s.length)], e.sign = () => e() < 0.5 ? -1 : 1, e;
}
function we(o2, t = o2) {
  if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
    const e = document.createElement('canvas');
    e.width = o2;
    e.height = t;
    return e;
  }
  return null;
}
function _n(o2 = 1) {
  let t = Re(o2), e = new Uint8Array(512), s = Array.from({ length: 256 }, (c, h) => h);
  for (let c = 255; c > 0; c--) {
    let h = Math.floor(t() * (c + 1));
    [s[c], s[h]] = [s[h], s[c]];
  }
  for (let c = 0; c < 512; c++) e[c] = s[c & 255];
  let n = new Float32Array(256);
  for (let c = 0; c < 256; c++) n[c] = t();
  let i = (c, h) => n[e[(c & 255) + e[h & 255]] & 255], a = (c) => c * c * c * (c * (c * 6 - 15) + 10);
  function r(c, h, f = 0) {
    let u = Math.floor(c), d = Math.floor(h), m = a(c - u), p = a(h - d), x = u + 1, g = d + 1;
    f && (u = (u % f + f) % f, d = (d % f + f) % f, x = (x % f + f) % f, g = (g % f + f) % f);
    let b = i(u, d), v = i(x, d), y = i(u, g), M = i(x, g);
    return Ht(Ht(b, v, m), Ht(y, M, m), p);
  }
  function l(c, h, f = 4, u = 0, d = 0.5, m = 2) {
    let p = 0.5, x = 0, g = 0, b = u;
    for (let v = 0; v < f; v++) x += p * r(c, h, b), g += p, c *= m, h *= m, b *= m, p *= d;
    return x / g;
  }
  return { noise: r, fbm: l };
}
var wb = new THREE.Vector3();
function ih(o2, t, e, s, n, i) {
  let a = 2 * Math.PI * n / 4, r = Math.max(i - 2 * n, 0), l = Math.PI / 4;
  wb.copy(t), wb[s] = 0, wb.normalize();
  let c = 0.5 * a / (a + r), h = 1 - wb.angleTo(o2) / l;
  return Math.sign(wb[e]) === 1 ? h * c : r / (a + r) + c + c * (1 - h);
}
var Ll = class o extends THREE.BoxGeometry {
  constructor(t = 1, e = 1, s = 1, n = 2, i = 0.1) {
    let a = n * 2 + 1;
    if (i = Math.min(t / 2, e / 2, s / 2, i), super(1, 1, 1, a, a, a), this.type = "RoundedBoxGeometry", this.parameters = { width: t, height: e, depth: s, segments: n, radius: i }, a === 1) return;
    let r = this.toNonIndexed();
    this.index = null, this.attributes.position = r.attributes.position, this.attributes.normal = r.attributes.normal, this.attributes.uv = r.attributes.uv;
    let l = new THREE.Vector3(), c = new THREE.Vector3(), h = new THREE.Vector3(t, e, s).divideScalar(2).subScalar(i), f = this.attributes.position.array, u = this.attributes.normal.array, d = this.attributes.uv.array, m = f.length / 6, p = new THREE.Vector3(), x = 0.5 / a;
    for (let g = 0, b = 0; g < f.length; g += 3, b += 2) switch (l.fromArray(f, g), c.copy(l), c.x -= Math.sign(c.x) * x, c.y -= Math.sign(c.y) * x, c.z -= Math.sign(c.z) * x, c.normalize(), f[g + 0] = h.x * Math.sign(l.x) + c.x * i, f[g + 1] = h.y * Math.sign(l.y) + c.y * i, f[g + 2] = h.z * Math.sign(l.z) + c.z * i, u[g + 0] = c.x, u[g + 1] = c.y, u[g + 2] = c.z, Math.floor(g / m)) {
      case 0:
        p.set(1, 0, 0), d[b + 0] = ih(p, c, "z", "y", i, s), d[b + 1] = 1 - ih(p, c, "y", "z", i, e);
        break;
      case 1:
        p.set(-1, 0, 0), d[b + 0] = 1 - ih(p, c, "z", "y", i, s), d[b + 1] = 1 - ih(p, c, "y", "z", i, e);
        break;
      case 2:
        p.set(0, 1, 0), d[b + 0] = 1 - ih(p, c, "x", "z", i, t), d[b + 1] = ih(p, c, "z", "x", i, s);
        break;
      case 3:
        p.set(0, -1, 0), d[b + 0] = 1 - ih(p, c, "x", "z", i, t), d[b + 1] = 1 - ih(p, c, "z", "x", i, s);
        break;
      case 4:
        p.set(0, 0, 1), d[b + 0] = 1 - ih(p, c, "x", "y", i, t), d[b + 1] = 1 - ih(p, c, "y", "x", i, e);
        break;
      case 5:
        p.set(0, 0, -1), d[b + 0] = ih(p, c, "x", "y", i, t), d[b + 1] = 1 - ih(p, c, "y", "x", i, e);
        break;
    }
  }
  static fromJSON(t) {
    return new o(t.width, t.height, t.depth, t.segments, t.radius);
  }
};
var $Z = _n(5519), kR = Math.PI * 2, dE = new THREE.Vector3(), pE = new THREE.Vector3(), $b = new THREE.Color(), QI = new THREE.Matrix3(), xE = () => ({ p: [], n: [], uv: [], idx: [] }), Zb = [];
function np(o2, t, e, s, { dir: n = [0, 1, 0], face: i = null, depth: a = 0.02, color: r = 2105376, shrink: l = 0, opts: c = {} } = {}) {
  let h = [], f = [];
  for (let u = 0; u < s; u++) {
    let d = t + e + u;
    h.push([o2.p[d * 3], o2.p[d * 3 + 1], o2.p[d * 3 + 2]]), f.push([o2.si[d * 4], o2.sw[d * 4], o2.si[d * 4 + 1], o2.sw[d * 4 + 1]]);
  }
  Zb.push({ ring: h, skin: f, dir: n, face: i || n, depth: a, color: r, shrink: l, opts: c });
}
function JI(o2) {
  for (let t of Zb) {
    let e = t.ring.length, s = t.dir, n = 0, i = 0, a = 0;
    for (let h of t.ring) n += h[0], i += h[1], a += h[2];
    n /= e, i /= e, a /= e;
    let r = 3, l = uh(r, e, (h, f, u) => {
      let d = t.ring[f % e], m = h / r, p = Math.cos(m * Math.PI / 2) * (1 - t.shrink * Math.min(1, h)), x = t.depth * Math.sin(m * Math.PI / 2);
      u[0] = n + (d[0] - n) * p + s[0] * x, u[1] = i + (d[1] - i) * p + s[1] * x, u[2] = a + (d[2] - a) * p + s[2] * x;
    }, { wrapJ: true });
    {
      let h = [l.p[0], l.p[1], l.p[2]], f = e + 1, u = [l.p[f * 3], l.p[f * 3 + 1], l.p[f * 3 + 2]], d = [l.p[3], l.p[4], l.p[5]], m = u[0] - h[0], p = u[1] - h[1], x = u[2] - h[2], g = d[0] - h[0], b = d[1] - h[1], v = d[2] - h[2], y = t.face;
      if ((p * v - x * b) * y[0] + (x * g - m * v) * y[1] + (m * b - p * g) * y[2] < 0) {
        for (let w = 0; w < l.idx.length; w += 3) {
          let T = l.idx[w + 1];
          l.idx[w + 1] = l.idx[w + 2], l.idx[w + 2] = T;
        }
        for (let w = 0; w < l.n.length; w++) l.n[w] = -l.n[w];
      }
    }
    let c = e + 1;
    o2.add(l, { color: t.color, rough: 0.92, nrm: 0.6, surf: 0, ao: 0.55, ...t.opts, weights: (h, f, u, d, m) => {
      let p = t.skin[m % c % e];
      d[0] = p[0], d[1] = p[1], d[2] = p[2], d[3] = p[3];
    } });
  }
  Zb.length = 0;
}
function bE(o2, t = 1) {
  let e = xE(), s = o2.attributes.position, n = o2.attributes.normal, i = o2.attributes.uv;
  for (let a = 0; a < s.count; a++) e.p.push(s.getX(a), s.getY(a), s.getZ(a)), e.n.push(n.getX(a), n.getY(a), n.getZ(a)), e.uv.push(i ? i.getX(a) * t : 0, i ? i.getY(a) * t : 0);
  if (o2.index) {
    let a = o2.index;
    for (let r = 0; r < a.count; r++) e.idx.push(a.getX(r));
  } else for (let a = 0; a < s.count; a++) e.idx.push(a);
  return o2.dispose(), e;
}
function yE(o2, t) {
  let e = t.determinant() < 0;
  QI.getNormalMatrix(t);
  for (let s = 0; s < o2.p.length; s += 3) dE.set(o2.p[s], o2.p[s + 1], o2.p[s + 2]).applyMatrix4(t), o2.p[s] = dE.x, o2.p[s + 1] = dE.y, o2.p[s + 2] = dE.z, pE.set(o2.n[s], o2.n[s + 1], o2.n[s + 2]).applyMatrix3(QI).normalize(), o2.n[s] = pE.x, o2.n[s + 1] = pE.y, o2.n[s + 2] = pE.z;
  if (e) for (let s = 0; s < o2.idx.length; s += 3) {
    let n = o2.idx[s + 1];
    o2.idx[s + 1] = o2.idx[s + 2], o2.idx[s + 2] = n;
  }
  return o2;
}
var ZZ = new THREE.Euler(), QZ = new THREE.Quaternion();
function JZ(o2 = 0, t = 0, e = 0, s = 0, n = 0, i = 0, a = 1, r = 1, l = 1) {
  return new THREE.Matrix4().compose(new THREE.Vector3(o2, t, e), QZ.setFromEuler(ZZ.set(s, n, i, "YXZ")), new THREE.Vector3(a, r, l));
}
var ti = (o2, ...t) => yE(o2, JZ(...t));
function tH(o2) {
  let t = { p: o2.p.slice(), n: o2.n.slice(), uv: o2.uv.slice(), idx: o2.idx.slice() };
  for (let e = 0; e < t.p.length; e += 3) t.p[e] = -t.p[e], t.n[e] = -t.n[e];
  for (let e = 0; e < t.idx.length; e += 3) {
    let s = t.idx[e + 1];
    t.idx[e + 1] = t.idx[e + 2], t.idx[e + 2] = s;
  }
  return t;
}
function tQ(o2, t, e, s = 4e-3) {
  s = Math.min(s, o2 * 0.4, t * 0.4, e * 0.4);
  let n = xE(), i = o2 / 2, a = t / 2, r = e / 2, l = {}, c = (u, d, m, p) => {
    let x = "" + u + d + m + p;
    if (l[x] !== void 0) return l[x];
    let g = u * (i - (p === 0 ? 0 : s)), b = d * (a - (p === 1 ? 0 : s)), v = m * (r - (p === 2 ? 0 : s));
    return n.p.push(g, b, v), n.n.push(p === 0 ? u : 0, p === 1 ? d : 0, p === 2 ? m : 0), n.uv.push(p === 0 ? v : g, p === 1 ? v : b), l[x] = n.p.length / 3 - 1;
  }, h = (u, d, m, p, x) => {
    let g = n.p, b = g[d * 3] - g[u * 3], v = g[d * 3 + 1] - g[u * 3 + 1], y = g[d * 3 + 2] - g[u * 3 + 2], M = g[m * 3] - g[u * 3], w = g[m * 3 + 1] - g[u * 3 + 1], T = g[m * 3 + 2] - g[u * 3 + 2];
    (v * T - y * w) * x[0] + (y * M - b * T) * x[1] + (b * w - v * M) * x[2] >= 0 ? (n.idx.push(u, d, m), p !== void 0 && n.idx.push(u, m, p)) : (n.idx.push(u, m, d), p !== void 0 && n.idx.push(u, p, m));
  }, f = [-1, 1];
  for (let u = 0; u < 3; u++) for (let d of f) {
    let m = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, g]) => {
      let b = [0, 0, 0];
      return b[u] = d, b[(u + 1) % 3] = x, b[(u + 2) % 3] = g, c(b[0], b[1], b[2], u);
    }), p = [0, 0, 0];
    p[u] = d, h(m[0], m[1], m[2], m[3], p);
  }
  for (let u = 0; u < 3; u++) for (let d of f) for (let m of f) {
    let p = (u + 1) % 3, x = (u + 2) % 3, g = [0, 0, 0], b = [0, 0, 0];
    g[u] = -1, g[p] = d, g[x] = m, b[u] = 1, b[p] = d, b[x] = m;
    let v = [0, 0, 0];
    v[p] = d, v[x] = m, h(c(g[0], g[1], g[2], p), c(b[0], b[1], b[2], p), c(b[0], b[1], b[2], x), c(g[0], g[1], g[2], x), v);
  }
  for (let u of f) for (let d of f) for (let m of f) h(c(u, d, m, 0), c(u, d, m, 1), c(u, d, m, 2), void 0, [u, d, m]);
  return n;
}
var en = (o2, t, e, s = 8e-3, n = 1) => n === 1 && Math.max(o2, t, e) < 0.075 ? tQ(o2, t, e, s * 0.7) : bE(new Ll(o2, t, e, n, Math.min(s, o2 * 0.49, t * 0.49, e * 0.49)), Math.max(o2, t, e)), Xg = (o2, t, e) => bE(new THREE.BoxGeometry(o2, t, e), Math.max(o2, t, e)), l5 = (o2, t, e, s = 10, n = false, i = 0, a = kR) => bE(new THREE.CylinderGeometry(o2, t, e, s, 1, n, i, a), e), eH = (o2, t = 12, e = 8, s = 0, n = kR, i = 0, a = Math.PI) => bE(new THREE.SphereGeometry(o2, t, e, s, n, i, a), o2 * 3);
var mE = [0, 0, 0], AR = [0, 0];
function uh(o2, t, e, { wrapJ: s = false, flip: n = false, uvFn: i = null } = {}) {
  let a = xE(), r = t + 1, l = new Float32Array((o2 + 1) * r * 3);
  for (let g = 0; g <= o2; g++) for (let b = 0; b <= t; b++) {
    e(g, s && b === t ? 0 : b, mE);
    let v = (g * r + b) * 3;
    l[v] = mE[0], l[v + 1] = mE[1], l[v + 2] = mE[2];
  }
  let c = (g, b, v) => {
    let y = (g * r + b) * 3;
    return v.set(l[y], l[y + 1], l[y + 2]);
  }, h = new THREE.Vector3(), f = new THREE.Vector3(), u = new THREE.Vector3(), d = new THREE.Vector3(), m = new THREE.Vector3(), p = 0, x = new Float32Array(r);
  for (let g = 0; g <= o2; g++) {
    for (let b = 0; b <= t; b++) {
      let v = Math.max(g - 1, 0), y = Math.min(g + 1, o2), M = b - 1, w = b + 1;
      if (s ? (M < 0 && (M = t - 1), w > t && (w = 1)) : (M = Math.max(M, 0), w = Math.min(w, t)), u.subVectors(c(y, b, h), c(v, b, f)), d.subVectors(c(g, w, h), c(g, M, f)), m.crossVectors(u, d), m.lengthSq() < 1e-16) {
        let S = g === 0 ? 1 : g === o2 ? o2 - 1 : g;
        u.subVectors(c(Math.min(S + 1, o2), b, h), c(Math.max(S - 1, 0), b, f)), d.subVectors(c(S, w, h), c(S, M, f)), m.crossVectors(u, d), m.lengthSq() < 1e-16 && m.set(0, 1, 0);
      }
      m.normalize(), n && m.multiplyScalar(-1);
      let T = (g * r + b) * 3;
      a.p.push(l[T], l[T + 1], l[T + 2]), a.n.push(m.x, m.y, m.z), i ? (i(g, b, AR), a.uv.push(AR[0], AR[1])) : (b > 0 ? x[b] = x[b - 1] + c(g, b, h).distanceTo(c(g, b - 1, f)) : x[0] = 0, a.uv.push(x[b], p));
    }
    g < o2 && (p += c(g + 1, t >> 1, h).distanceTo(c(g, t >> 1, f)));
  }
  for (let g = 0; g < o2; g++) for (let b = 0; b < t; b++) {
    let v = g * r + b, y = v + r, M = v + 1, w = y + 1;
    n ? a.idx.push(v, M, y, M, w, y) : a.idx.push(v, y, M, M, y, w);
  }
  return a;
}
function Tu(o2, t, { closed: e = false, capA: s = true, capB: n = true } = {}) {
  let i = xE(), a = o2.length, r = [], l = 0;
  for (let u = 0; u < a; u++) {
    let d = o2[u], m = t(u), p = m.length;
    u > 0 && (l += Math.hypot(d.p[0] - o2[u - 1].p[0], d.p[1] - o2[u - 1].p[1], d.p[2] - o2[u - 1].p[2]));
    let x = 0;
    for (let g = 0; g <= p; g++) {
      let b = m[g % p];
      if (g > 0) {
        let T = m[g - 1];
        x += Math.hypot(b[0] - T[0], b[1] - T[1]);
      }
      i.p.push(d.p[0] + d.b[0] * b[0] + d.n[0] * b[1], d.p[1] + d.b[1] * b[0] + d.n[1] * b[1], d.p[2] + d.b[2] * b[0] + d.n[2] * b[1]);
      let v = d.b[0] * b[2] + d.n[0] * b[3], y = d.b[1] * b[2] + d.n[1] * b[3], M = d.b[2] * b[2] + d.n[2] * b[3], w = Math.hypot(v, y, M) || 1;
      i.n.push(v / w, y / w, M / w), i.uv.push(l, x);
    }
    r.push(m);
  }
  let c = r[0].length, h = c + 1, f = e ? a : a - 1;
  for (let u = 0; u < f; u++) {
    let d = (u + 1) % a;
    for (let m = 0; m < c; m++) {
      let p = u * h + m, x = d * h + m, g = p + 1, b = x + 1;
      i.idx.push(p, g, x, g, b, x);
    }
  }
  if (!e) {
    let u = (d, m) => {
      let p = o2[d], x = r[d], g = i.p.length / 3, b = [p.b[1] * p.n[2] - p.b[2] * p.n[1], p.b[2] * p.n[0] - p.b[0] * p.n[2], p.b[0] * p.n[1] - p.b[1] * p.n[0]], v = 0, y = 0;
      for (let w of x) v += w[0], y += w[1];
      v /= c, y /= c;
      let M = (w, T) => {
        i.p.push(p.p[0] + p.b[0] * w + p.n[0] * T, p.p[1] + p.b[1] * w + p.n[1] * T, p.p[2] + p.b[2] * w + p.n[2] * T), i.n.push(b[0] * m, b[1] * m, b[2] * m), i.uv.push(w, T);
      };
      M(v, y);
      for (let w of x) M(w[0], w[1]);
      for (let w = 0; w < c; w++) {
        let T = g + 1 + w, S = g + 1 + (w + 1) % c;
        m > 0 ? i.idx.push(g, T, S) : i.idx.push(g, S, T);
      }
    };
    s && u(0, -1), n && u(a - 1, 1);
  }
  return i;
}
function Yg(o2, t, e, s, n, i = 2) {
  n = Math.min(n, (t - o2) * 0.49, (s - e) * 0.49);
  let a = [], r = (l, c, h) => {
    for (let f = 0; f <= i; f++) {
      let u = h + Math.PI / 2 * (f / i), d = Math.cos(u), m = Math.sin(u);
      a.push([l + d * n, c + m * n, d, m]);
    }
  };
  return r(t - n, s - n, 0), r(o2 + n, s - n, Math.PI / 2), r(o2 + n, e + n, Math.PI), r(t - n, e + n, Math.PI * 1.5), a;
}
function CR(o2, t = 6, e = 0, s = 0, n = 1) {
  let i = [];
  for (let a = 0; a < t; a++) {
    let r = kR * a / t, l = Math.cos(r), c = Math.sin(r);
    i.push([e + l * o2 * n, s + c * o2, l, c]);
  }
  return i;
}
function dh(o2, t, e = 6, s = true) {
  let n = [], i = o2.length, a = new THREE.Vector3(), r = new THREE.Vector3(), l = new THREE.Vector3(), c = new THREE.Vector3(0, 1, 0);
  for (let f = 0; f < i; f++) {
    let u = o2[Math.max(f - 1, 0)], d = o2[Math.min(f + 1, i - 1)];
    a.set(d[0] - u[0], d[1] - u[1], d[2] - u[2]).normalize(), f === 0 ? (Math.abs(a.y) > 0.9 && c.set(1, 0, 0), r.crossVectors(a, c).normalize()) : r.addScaledVector(a, -r.dot(a)).normalize(), l.crossVectors(a, r), n.push({ p: o2[f], b: [r.x, r.y, r.z], n: [l.x, l.y, l.z] });
  }
  let h = typeof t == "function" ? t : () => t;
  return Tu(n, (f) => CR(h(f / (i - 1)), e), { capA: s, capB: s });
}
function l2(o2) {
  let t = o2.length, e = o2[0].length;
  return (s, n) => {
    let i = 0;
    for (; i < t - 2 && s > o2[i + 1][0]; ) i++;
    let a = o2[Math.max(i - 1, 0)], r = o2[i], l = o2[i + 1], c = o2[Math.min(i + 2, t - 1)], h = l[0] - r[0], f = Math.min(Math.max((s - r[0]) / h, 0), 1), u = f * f, d = u * f;
    for (let m = 1; m < e; m++) {
      let p = i > 0 ? (l[m] - a[m]) / (l[0] - a[0]) * h : l[m] - r[m], x = i < t - 2 ? (c[m] - r[m]) / (c[0] - r[0]) * h : l[m] - r[m];
      n[m - 1] = (2 * d - 3 * u + 1) * r[m] + (d - 2 * u + f) * p + (-2 * d + 3 * u) * l[m] + (d - u) * x;
    }
    return n;
  };
}
function tf(o2, t, e, s, n, i = 2.2) {
  let a = t >= 0 ? s : n;
  return Math.pow(Math.pow(Math.abs(o2) / e, i) + Math.pow(Math.abs(t) / a, i), -1 / i);
}
var gE = class {
  constructor() {
    this.p = [], this.n = [], this.uv = [], this.col = [], this.aux = [], this.aux2 = [], this.si = [], this.sw = [], this.idx = [], this.fp = [];
  }
  get count() {
    return this.p.length / 3;
  }
  add(t, { color: e = 8421504, rough: s = 0.85, metal: n = 0, glow: i = 0, nrm: a = 1, camo: r = 0, surf: l = 1, bone: c = 0, weights: h = null, m: f = null, ao: u = 1, mottle: d = 0.14, fp: m = 0 } = {}) {
    let p = f ? t.p.slice() : t.p;
    f && yE(t, f);
    let x = this.count, g = t.p.length / 3, b = [0, 1, 0, 0], v = typeof e == "number";
    v && $b.setHex(e);
    for (let y = 0; y < g; y++) {
      let M = p[y * 3], w = p[y * 3 + 1], T = p[y * 3 + 2];
      this.p.push(t.p[y * 3], t.p[y * 3 + 1], t.p[y * 3 + 2]), this.n.push(t.n[y * 3], t.n[y * 3 + 1], t.n[y * 3 + 2]), this.uv.push(t.uv[y * 2] || 0, t.uv[y * 2 + 1] || 0), v || $b.setHex(e(M, w, T, y));
      let S = t.p[y * 3], E = t.p[y * 3 + 1], _ = t.p[y * 3 + 2], R = i > 0 ? 1 : 1 + d * ($Z.fbm(S * 19 + _ * 11 + 3.1, E * 19 - _ * 13 + 7.7, 3) - 0.5) * 2;
      this.col.push($b.r * R, $b.g * R, $b.b * R), this.aux.push(i, Math.min(1, s * (i > 0 ? 1 : 1.04 - 0.5 * (R - 1))), n, typeof u == "function" ? u(M, w, T, y) : u), this.aux2.push(a, r, l), this.fp.push(m), h ? (b[0] = 0, b[1] = 1, b[2] = 0, b[3] = 0, h(M, w, T, b, y), this.si.push(b[0], b[2], 0, 0), this.sw.push(b[1], b[3], 0, 0)) : (this.si.push(c, 0, 0, 0), this.sw.push(1, 0, 0, 0));
    }
    for (let y = 0; y < t.idx.length; y++) this.idx.push(t.idx[y] + x);
    return this;
  }
  bakeAO({ cell: t = 0.016, strength: e = 1.25 } = {}) {
    let s = this.p, n = this.n, i = this.count, a = 1e9, r = 1e9, l = 1e9, c = -1e9, h = -1e9, f = -1e9;
    for (let T = 0; T < s.length; T += 3) a = Math.min(a, s[T]), c = Math.max(c, s[T]), r = Math.min(r, s[T + 1]), h = Math.max(h, s[T + 1]), l = Math.min(l, s[T + 2]), f = Math.max(f, s[T + 2]);
    let u = 0.1;
    a -= u, r -= u, l -= u;
    let d = Math.ceil((c + u - a) / t), m = Math.ceil((h + u - r) / t), p = Math.ceil((f + u - l) / t), x = new Float32Array(d * m * p), g = new Float32Array(d * m * p), b = (T, S, E, _) => {
      let R = Math.floor((T - a) / t), C = Math.floor((S - r) / t), L = Math.floor((E - l) / t);
      R >= 0 && C >= 0 && L >= 0 && R < d && C < m && L < p && (x[(L * m + C) * d + R] += _);
    }, v = this.idx, y = t * t;
    for (let T = 0; T < v.length; T += 3) {
      let S = v[T] * 3, E = v[T + 1] * 3, _ = v[T + 2] * 3, R = s[E] - s[S], C = s[E + 1] - s[S + 1], L = s[E + 2] - s[S + 2], A = s[_] - s[S], O = s[_ + 1] - s[S + 1], H = s[_ + 2] - s[S + 2], F = 0.5 * Math.hypot(C * H - L * O, L * A - R * H, R * O - C * A), P = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(F / y) * 1.5))), z = F / y / (P * (P + 1) / 2);
      for (let k = 0; k < P; k++) for (let I = 0; I < P - k; I++) {
        let G = (k + 0.33) / P, K = (I + 0.33) / P;
        b(s[S] + R * G + A * K, s[S + 1] + C * G + O * K, s[S + 2] + L * G + H * K, z);
      }
    }
    for (let T = 0; T < x.length; T++) x[T] = Math.min(x[T], 1.5);
    let M = (T, S, E, _, R) => {
      for (let C = 0; C < T.length; C++) {
        let L = Math.floor(C / E) % _, A = L > 0 ? T[C - E] : 0, O = L < _ - 1 ? T[C + E] : 0;
        S[C] = (A + 2 * T[C] + O) * 0.25;
      }
    };
    for (let T = 0; T < 2; T++) {
      M(x, g, 1, d), M(g, x, d, m), M(x, g, d * m, p);
      let S = x;
      x = g, g = S;
    }
    let w = (T, S, E) => {
      let _ = (T - a) / t - 0.5, R = (S - r) / t - 0.5, C = (E - l) / t - 0.5, L = Math.floor(_), A = Math.floor(R), O = Math.floor(C);
      if (L < 0 || A < 0 || O < 0 || L >= d - 1 || A >= m - 1 || O >= p - 1) return 0;
      let H = _ - L, F = R - A, P = C - O, z = (O * m + A) * d + L, k = d * m, I = x[z] * (1 - H) + x[z + 1] * H, G = x[z + d] * (1 - H) + x[z + d + 1] * H, K = x[z + k] * (1 - H) + x[z + k + 1] * H, $ = x[z + k + d] * (1 - H) + x[z + k + d + 1] * H;
      return (I * (1 - F) + G * F) * (1 - P) + (K * (1 - F) + $ * F) * P;
    };
    for (let T = 0; T < i; T++) {
      let S = s[T * 3], E = s[T * 3 + 1], _ = s[T * 3 + 2], R = n[T * 3], C = n[T * 3 + 1], L = n[T * 3 + 2], A = 0;
      A += w(S + R * 0.03, E + C * 0.03, _ + L * 0.03) * 1, A += w(S + R * 0.055, E + C * 0.055, _ + L * 0.055) * 0.8, A += w(S + R * 0.09, E + C * 0.09, _ + L * 0.09) * 0.6, A += w(S + R * 0.05, E + C * 0.05 + 0.04, _ + L * 0.05) * 0.5;
      let O = Math.max(0.3, 1 - Math.max(A - 0.1, 0) * e);
      this.aux[T * 4 + 3] *= O;
    }
    return this;
  }
  build() {
    let t = new THREE.BufferGeometry();
    return t.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3)), t.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3)), t.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2)), t.setAttribute("color", new THREE.Float32BufferAttribute(this.col, 3)), t.setAttribute("aux", new THREE.Float32BufferAttribute(this.aux, 4)), t.setAttribute("aux2", new THREE.Float32BufferAttribute(this.aux2, 3)), t.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(this.si, 4)), t.setAttribute("skinWeight", new THREE.Float32BufferAttribute(this.sw, 4)), t.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1)), t.computeBoundingSphere(), t.computeBoundingBox(), t.userData.fp = Uint8Array.from(this.fp), t;
  }
};
var fs = { head: 0, neck: 1, chest: 2, pelvis: 3, lShoulder: 4, lElbow: 5, lHand: 6, rShoulder: 7, rElbow: 8, rHand: 9, lHip: 10, lKnee: 11, lFoot: 12, rHip: 13, rKnee: 14, rFoot: 15 }, Ue = fs, h2 = 0.34, f2 = 0.2, u5 = 0.14, Yc = 0.19, AE = 0.14, Pi = 0.095, lf = 0.05, Ca = 0.3, mh = 0.31, ey = 0.255, qr = 0.44, rf = 0.42, hp = qr + rf, Sn = 0.095, Qg = 0.058, u2 = 0.125;
var nf = [[0, 1.685, 0], [0, 1.545, 0], [0, 1.345, 0], [0, 1.005, 0], [-Yc, 1.485, 0], [-0.21, 1.1857, 0], [-0.22, 0.8759, 0], [Yc, 1.485, 0], [0.21, 1.1857, 0], [0.22, 0.8759, 0], [-Pi, 0.955, 0], [-0.1, 0.515, 0], [-0.1, 0.095, 0], [Pi, 0.955, 0], [0.1, 0.515, 0], [0.1, 0.095, 0]], ph = Math.SQRT1_2, h5 = [[0, 1.685, 0], [0, 1.545, 0], [0, 1.345, 0], [0, 1.005, 0], [-Yc, 1.485, 0], [-Yc - Ca * ph, 1.485 - Ca * ph, 0], [-Yc - (Ca + mh) * ph, 1.485 - (Ca + mh) * ph, 0], [Yc, 1.485, 0], [Yc + Ca * ph, 1.485 - Ca * ph, 0], [Yc + (Ca + mh) * ph, 1.485 - (Ca + mh) * ph, 0], [-Pi, 0.955, 0], [-Pi, 0.515, 0], [-Pi, 0.095, 0], [Pi, 0.955, 0], [Pi, 0.515, 0], [Pi, 0.095, 0]], eQ = (o2, t) => Math.hypot(nf[o2][0] - nf[t][0], nf[o2][1] - nf[t][1], nf[o2][2] - nf[t][2]), pH = [[Ue.pelvis, Ue.chest, h2], [Ue.chest, Ue.neck, f2], [Ue.neck, Ue.head, u5], [Ue.lShoulder, Ue.lElbow, Ca], [Ue.lElbow, Ue.lHand, mh], [Ue.rShoulder, Ue.rElbow, Ca], [Ue.rElbow, Ue.rHand, mh], [Ue.lHip, Ue.lKnee, qr], [Ue.lKnee, Ue.lFoot, rf], [Ue.rHip, Ue.rKnee, qr], [Ue.rKnee, Ue.rFoot, rf], ...[[Ue.chest, Ue.lShoulder], [Ue.chest, Ue.rShoulder], [Ue.neck, Ue.lShoulder], [Ue.neck, Ue.rShoulder], [Ue.lShoulder, Ue.rShoulder], [Ue.pelvis, Ue.lHip], [Ue.pelvis, Ue.rHip], [Ue.lHip, Ue.rHip], [Ue.lShoulder, Ue.pelvis], [Ue.rShoulder, Ue.pelvis], [Ue.lHip, Ue.chest], [Ue.rHip, Ue.chest], [Ue.head, Ue.chest], [Ue.lShoulder, Ue.rHip], [Ue.rShoulder, Ue.lHip]].map(([o2, t]) => [o2, t, eQ(o2, t)])], mH = new Float32Array([0.12, 0.07, 0.16, 0.15, 0.08, 0.06, 0.055, 0.08, 0.06, 0.055, 0.1, 0.07, 0.07, 0.1, 0.07, 0.07]), Ve = { pelvis: 0, spine: 1, chest: 2, neck: 3, head: 4, shH: 5, uarm0: 6, uarm: 7, elbH: 8, farm: 9, farmTw: 10, hand: 11, hipH: 19, thigh0: 20, thigh: 21, kneeH: 22, shin: 23, foot: 24, toe: 25, mag: 33 }, Ru = 7, d5 = 7, kE = 34, gH = THREE.Vector3, dn = () => new gH(), sH = new gH(0, 1, 0), vE = dn(), Qb = dn(), ME = dn(), wE = dn(), op = dn(), c2 = dn(), nH = dn(), ef = dn(), sf = dn(), oH = dn(), PR = dn(), iH = dn(), EE = dn(), ip = dn(), zR = dn(), aH = dn(), TE = dn(), SE = dn(), of = dn(), af = dn(), ty = dn(), ja = dn(), Gr = dn(), lp = dn(), Zg = dn(), ap = dn(), rH = dn(), c5 = dn(), lH = dn(), f5 = dn(), cp = dn(), jg = dn(), A1 = dn(), Aa = dn(), Bl = dn(), cH = dn(), rp = dn(), _E = dn(), ka = dn(), hH = dn(), Vr = dn(), $g = dn(), Jb = new THREE.Quaternion(), qa0 = new THREE.Quaternion(), fH = new THREE.Matrix4();
function Wr(o2, t, e) {
  let s = t * 3;
  return e.set(o2[s], o2[s + 1], o2[s + 2]);
}
function Su(o2, t) {
  let e = o2.lengthSq();
  return e < 1e-12 ? o2.copy(t) : o2.multiplyScalar(1 / Math.sqrt(e));
}
function _u(o2, t, e) {
  return o2.addScaledVector(t, -o2.dot(t)), o2.lengthSq() < 1e-6 && (o2.copy(e).addScaledVector(t, -e.dot(t)), o2.lengthSq() < 1e-6 && (o2.set(1, 0, 0).addScaledVector(t, -t.x), o2.lengthSq() < 1e-6 && o2.set(0, 0, 1).addScaledVector(t, -t.z))), o2.normalize();
}
function xc(o2, t, e, s, n) {
  let i = o2.elements;
  i[0] = t.x, i[1] = t.y, i[2] = t.z, i[3] = 0, i[4] = e.x, i[5] = e.y, i[6] = e.z, i[7] = 0, i[8] = s.x, i[9] = s.y, i[10] = s.z, i[11] = 0, i[12] = n.x, i[13] = n.y, i[14] = n.z, i[15] = 1;
}
function RE(o2, t, e, s) {
  let n = o2.dot(t);
  if (n < -0.9995) {
    rp.set(o2.y, -o2.x, 0), rp.lengthSq() < 1e-6 && rp.set(0, o2.z, -o2.y), rp.normalize();
    let u = 2 * rp.dot(e);
    return s.set(rp.x * u - e.x, rp.y * u - e.y, rp.z * u - e.z);
  }
  let i = o2.y * t.z - o2.z * t.y, a = o2.z * t.x - o2.x * t.z, r = o2.x * t.y - o2.y * t.x, l = (i * e.x + a * e.y + r * e.z) / (1 + n), c = e.x * n + (a * e.z - r * e.y) + i * l, h = e.y * n + (r * e.x - i * e.z) + a * l, f = e.z * n + (i * e.y - a * e.x) + r * l;
  return s.set(c, h, f);
}
function LR(o2, t) {
  let e = Math.abs(o2);
  return e <= t ? o2 : Math.sign(o2) * t * (Math.PI - e) / (Math.PI - t);
}
var DR = (o2, t, e) => {
  let s = Math.min(Math.max((e - o2) / (t - o2), 0), 1);
  return s * s * (3 - 2 * s);
};
function uH(o2, t, e, s, n, i, a) {
  let r = o2.elements, l = a - 1, c = i.dot(t) * l;
  r[0] = t.x + i.x * c, r[1] = t.y + i.y * c, r[2] = t.z + i.z * c, r[3] = 0, c = i.dot(e) * l, r[4] = e.x + i.x * c, r[5] = e.y + i.y * c, r[6] = e.z + i.z * c, r[7] = 0, c = i.dot(s) * l, r[8] = s.x + i.x * c, r[9] = s.y + i.y * c, r[10] = s.z + i.z * c, r[11] = 0, r[12] = n.x, r[13] = n.y, r[14] = n.z, r[15] = 1;
}
function dH(o2, t, e, s, n, i, a, r) {
  Wr(o2, t, of), Wr(o2, e, af), Wr(o2, s, ty), Su(ja.subVectors(af, of), lp), Su(Gr.subVectors(ty, af), ja), Su(A1.addVectors(lp, ja), ja), RE(lp, A1, Zg, ka), _u(ka, A1, Zg), Vr.crossVectors(ka, A1);
  let l = Math.max(lp.dot(A1), 0.8);
  _E.subVectors(ja, lp), _E.lengthSq() > 1e-8 ? (_E.normalize(), uH(a[r], ka, A1, Vr, of, _E, 1 / l)) : xc(a[r], ka, A1, Vr, of), RE(lp, ja, Zg, ap), _u(ap, ja, Zg), rH.crossVectors(ap, ja), xc(a[r + 1], ap, ja, rH, of), n ? jg.crossVectors(Gr, ja) : jg.crossVectors(ja, Gr);
  let c = jg.length(), h = 0;
  c > 1e-4 && (jg.multiplyScalar(1 / c), h = LR(Math.atan2(Aa.crossVectors(ap, jg).dot(ja), ap.dot(jg)), i) * DR(0.02, 0.2, c));
  let f = Math.cos(h), u = Math.sin(h);
  Aa.crossVectors(ja, ap), c5.copy(ap).multiplyScalar(f).addScaledVector(Aa, u), lH.crossVectors(c5, ja), xc(a[r + 2], c5, ja, lH, of), RE(ja, Gr, c5, f5), _u(f5, Gr, c5), cp.crossVectors(f5, Gr), Su(A1.addVectors(ja, Gr), ja), RE(ja, A1, c5, ka), _u(ka, A1, c5), Vr.crossVectors(ka, A1);
  let d = Math.max(ja.dot(A1), 0.64);
  uH(a[r + 3], ka, A1, Vr, af, Vr, 1 / d), xc(a[r + 4], f5, Gr, cp, af);
}
function CE(o2, t, e) {
  Wr(o2, Ue.pelvis, vE), Wr(o2, Ue.chest, Qb), Wr(o2, Ue.neck, ME), Wr(o2, Ue.head, wE), Su(sf.subVectors(ME, Qb), sH), Wr(o2, Ue.lShoulder, of), Wr(o2, Ue.rShoulder, af), _u(ef.subVectors(af, of), sf, Aa.set(1, 0, 0)), oH.crossVectors(ef, sf), Su(c2.subVectors(Qb, vE), sf), Wr(o2, Ue.lHip, of), Wr(o2, Ue.rHip, af), _u(op.subVectors(af, of), c2, ef), nH.crossVectors(op, c2), xc(e[Ve.pelvis], op, c2, nH, vE), Aa.copy(ef).addScaledVector(c2, -ef.dot(c2));
  let s = Aa.length(), n = 0;
  s > 1e-4 && (n = LR(Math.atan2(Bl.crossVectors(op, Aa).dot(c2), op.dot(Aa)), 2) * 0.5 * DR(0.05, 0.4, s)), Bl.crossVectors(c2, op), PR.copy(op).multiplyScalar(Math.cos(n)).addScaledVector(Bl, Math.sin(n)), iH.crossVectors(PR, c2), xc(e[Ve.spine], PR, c2, iH, vE), xc(e[Ve.chest], ef, sf, oH, Qb), Su(ip.subVectors(wE, ME), sf), ip.add(sf), Su(ip, sf), _u(EE.copy(ef), ip, ef), zR.crossVectors(EE, ip), xc(e[Ve.neck], EE, ip, zR, ME), t && t.headFwd ? (SE.copy(t.headFwd).multiplyScalar(-1), TE.copy(t.headUp), _u(TE, SE, ip), aH.crossVectors(TE, SE), xc(e[Ve.head], aH, TE, SE, wE)) : xc(e[Ve.head], EE, ip, zR, wE);
  for (let i = 0; i < 2; i++) {
    let a = i ? 1 : -1, r = Ve.shH + i * Ru;
    lp.copy(ef).multiplyScalar(a * ph).addScaledVector(sf, -ph), Zg.copy(ef).multiplyScalar(ph).addScaledVector(sf, a * ph), dH(o2, i ? Ue.rShoulder : Ue.lShoulder, i ? Ue.rElbow : Ue.lElbow, i ? Ue.rHand : Ue.lHand, false, 2.3, e, r), ka.copy(cp).multiplyScalar(a), Vr.copy(f5).multiplyScalar(-a), $g.copy(ty);
    let l = t ? t.handW[i] : 0;
    l > 1e-3 ? (fH.makeBasis(ka, Gr, Vr), Jb.setFromRotationMatrix(fH), Jb.slerp(t.handQ[i], l), ka.set(1, 0, 0).applyQuaternion(Jb), hH.set(0, 1, 0).applyQuaternion(Jb), Vr.set(0, 0, 1).applyQuaternion(Jb), $g.lerp(t.handP[i], l), xc(e[r + 6], ka, hH, Vr, $g)) : xc(e[r + 6], ka, Gr, Vr, $g), Aa.copy(ka).multiplyScalar(a), Aa.addScaledVector(Gr, -Aa.dot(Gr));
    let c = Aa.length(), h = 0;
    c > 0.05 && (h = LR(Math.atan2(Bl.crossVectors(cp, Aa).dot(Gr), cp.dot(Aa)), 2) * 0.55 * DR(0.05, 0.4, c));
    let f = Math.cos(h), u = Math.sin(h);
    Bl.crossVectors(Gr, f5), ka.copy(f5).multiplyScalar(f).addScaledVector(Bl, u), Vr.crossVectors(ka, Gr), xc(e[r + 5], ka, Gr, Vr, af);
  }
  for (let i = 0; i < 2; i++) {
    let a = Ve.hipH + i * d5;
    lp.copy(c2).multiplyScalar(-1), Zg.copy(op), dH(o2, i ? Ue.rHip : Ue.lHip, i ? Ue.rKnee : Ue.lKnee, i ? Ue.rFoot : Ue.lFoot, true, 1.75, e, a);
    let r = 0.94, l = 0.342;
    Aa.copy(cp).multiplyScalar(r).addScaledVector(Gr, l), Bl.copy(Gr).multiplyScalar(-r).addScaledVector(cp, l);
    let c = 0;
    if (t && t.footW > 1e-3) {
      let h = t.footW;
      Aa.lerp(t.footF[i], h), Bl.lerp(t.footU[i], h), Su(Bl, sH), c = t.toeBend[i] * h;
    }
    if (_u(Aa, Bl, cp), Vr.copy(Aa).multiplyScalar(-1), ka.crossVectors(Bl, Vr), xc(e[a + 5], ka, Bl, Vr, ty), $g.copy(ty).addScaledVector(Aa, u2).addScaledVector(Bl, -Sn + 0.03), c !== 0) {
      let h = Math.cos(c), f = Math.sin(c);
      cH.copy(Aa).multiplyScalar(h).addScaledVector(Bl, f), Bl.multiplyScalar(h).addScaledVector(Aa, -f), Vr.copy(cH).multiplyScalar(-1);
    }
    xc(e[a + 6], ka, Bl, Vr, $g);
  }
  return t && t.magM ? e[Ve.mag].copy(t.magM) : e[Ve.mag].makeScale(0, 0, 0).setPosition(Qb), e;
}
function PE() {
  let o2 = new Float32Array(48);
  for (let e = 0; e < 16; e++) o2[e * 3] = h5[e][0], o2[e * 3 + 1] = h5[e][1], o2[e * 3 + 2] = h5[e][2];
  let t = [];
  for (let e = 0; e < kE; e++) t.push(new THREE.Matrix4());
  CE(o2, null, t);
  for (let e = 0; e < 2; e++) {
    let s = Ve.hipH + e * d5, n = h5[e ? Ue.rFoot : Ue.lFoot];
    t[s + 5].makeTranslation(n[0], n[1], n[2]), t[s + 6].makeTranslation(n[0], n[1] - Sn + 0.03, n[2] - u2);
  }
  return t[Ve.mag].identity(), t;
}
var LE = Math.PI * 2, ny = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, Gn = (o2, t, e) => {
  let s = ny((e - o2) / (t - o2), 0, 1);
  return s * s * (3 - 2 * s);
}, d2 = (o2, t) => Math.exp(-(o2 * o2) / (t * t)), oy = _n(4107), t4 = [
  { camoA: 0xcfd5da, camoB: 0x8d9aa5, camoC: 0xe3e7ea, camoD: 0x5d7280, shirt: 0xd4d9dd, gaiter: 0x3b4d59, mask: 0x1b242c, gear: 0x2c3e4a, gearLt: 0x455c6b, gearDk: 0x19232b, web: 0x3d515e, helmet: 0xdce2e6, hard: 0x1a222a, boot: 0x262c32, sole: 0x0d1014, glove: 0x242c34, knuckle: 0x435360, metal: 0x62707a, pad: 0x2c3c48, mag: 0x1c242b, lens: 0x35e0ff, glow: 0x35e0ff, glowK: 4.2, dust: 0x8f8a80 },
  { camoA: 0xb97e2e, camoB: 0x7a5320, camoC: 0xd1983e, camoD: 0x4e463c, shirt: 0xb57729, gaiter: 0x453d34, mask: 0x1e1c1a, gear: 0x383632, gearLt: 0x545048, gearDk: 0x1c1b18, web: 0x4a453c, helmet: 0xd69d2c, hard: 0x1d1c1a, boot: 0x332b22, sole: 0x0e0d0c, glove: 0x2e2923, knuckle: 0x4c443a, metal: 0x686258, pad: 0x36322c, mag: 0x22201d, lens: 0xffaa2b, glow: 0xffaa2b, glowK: 4.5, dust: 0x928572 },
  { camoA: 0x2b313b, camoB: 0x1b2028, camoC: 0x3a424f, camoD: 0x232830, shirt: 0x242932, gaiter: 0x2d323c, mask: 0x12151a, gear: 0x1e222a, gearLt: 0x323844, gearDk: 0x111419, web: 0x2a2f3a, helmet: 0x222730, hard: 0x101318, boot: 0x191c22, sole: 0x0a0b0e, glove: 0x1a1e24, knuckle: 0x2e3440, metal: 0x48505c, pad: 0x1f242d, mag: 0x15181f, lens: 0xff4d2a, glow: 0xff4d2a, glowK: 5.2, dust: 0x7c7872 }
], sQ = [[0.834, 4e-3, 4e-3, 5e-3, 4e-3, 2], [0.842, 4e-3, 0.046, 0.054, 0.044, 2], [0.87, 4e-3, 0.098, 0.09, 0.072, 2.1], [0.905, 4e-3, 0.15, 0.118, 0.094, 2.2], [0.94, 4e-3, 0.174, 0.128, 0.106, 2.3], [0.99, 2e-3, 0.171, 0.12, 0.11, 2.3], [1.045, 0, 0.16, 0.106, 0.11, 2.3], [1.09, 0, 0.154, 0.1, 0.108, 2.3]], nQ = [[1.05, 0, 0.153, 0.099, 0.107, 2.3], [1.13, 0, 0.15, 0.1, 0.108, 2.3], [1.21, 2e-3, 0.157, 0.108, 0.114, 2.4], [1.29, 4e-3, 0.167, 0.116, 0.124, 2.5], [1.37, 6e-3, 0.173, 0.12, 0.128, 2.5], [1.43, 8e-3, 0.176, 0.118, 0.12, 2.4], [1.48, 0.01, 0.168, 0.108, 0.098, 2.3], [1.515, 0.01, 0.12, 0.094, 0.078, 2.2], [1.545, 8e-3, 0.074, 0.074, 0.064, 2], [1.57, 6e-3, 0.06, 0.062, 0.058, 2]], oQ = [[1.56, 4e-3, 0.056, 0.06, 0.056, 2], [1.59, -4e-3, 0.06, 0.062, 0.07, 2], [1.606, -8e-3, 0.064, 0.066, 0.09, 2.1], [1.626, -0.01, 0.07, 0.074, 0.098, 2.2], [1.65, -0.01, 0.075, 0.084, 0.101, 2.2], [1.676, -0.01, 0.078, 0.094, 0.1, 2.2], [1.705, -0.01, 0.079, 0.1, 0.099, 2.2], [1.74, -8e-3, 0.078, 0.101, 0.098, 2.1], [1.775, -6e-3, 0.068, 0.092, 0.084, 2], [1.798, -4e-3, 0.044, 0.06, 0.054, 2], [1.808, -4e-3, 4e-3, 6e-3, 6e-3, 2]], bH = l2(sQ), IR = l2(nQ), yH = l2(oQ), Lo = [0, 0, 0, 0, 0];
function HR(o2, t, e, s, n) {
  o2(t, Lo);
  let i = (m, p) => {
    let x = Math.sin(m), g = -Math.cos(m), b = tf(x, g, Lo[1], Lo[2], Lo[3], Lo[4]);
    p[0] = b * x, p[1] = Lo[0] + b * g;
  }, a = [0, 0], r = [0, 0], l = [0, 0];
  i(e, a), i(e - 0.02, r), i(e + 0.02, l);
  let c = l[0] - r[0], h = l[1] - r[1], f = Math.hypot(c, h) || 1;
  c /= f, h /= f;
  let u = h, d = -c;
  return n[0] = a[0] + u * s, n[1] = t, n[2] = a[1] + d * s, n[3] = u, n[4] = d, n;
}
function DE(o2, t) {
  let e = (i) => {
    IR(i, Lo);
    let a = t - Lo[0], r = a >= 0 ? Lo[2] : Lo[3];
    return Math.pow(Math.abs(o2) / Lo[1], Lo[4]) + Math.pow(Math.abs(a) / r, Lo[4]) <= 1;
  }, s = 1.4, n = 1.57;
  if (!e(s)) return s;
  for (let i = 0; i < 16; i++) {
    let a = (s + n) / 2;
    e(a) ? s = a : n = a;
  }
  return s;
}
var io = (o2, t, e, s) => HR(o2 < 1.07 ? bH : IR, o2, t, e, s), vH = (o2, t, e, s) => HR(yH, o2, t, e, s);
function ku(o2, t, e, s, n, i = null) {
  let a = [], r = [0, 0, 0, 0, 0];
  for (let l = 0; l <= s; l++) {
    let c = e + (t - e) * (l / s);
    i ? HR(i, o2, c, n, r) : io(o2, c, n, r), a.push({ p: [r[0], r[1], r[2]], b: [0, 1, 0], n: [r[3], 0, r[4]], az: c });
  }
  return a;
}
var iQ = [[-0.075, -4e-3, 0, 0.084, 0.086, 0.094], [0, 4e-3, -4e-3, 0.097, 0.098, 0.106], [0.08, 4e-3, 0, 0.096, 0.1, 0.099], [0.2, 2e-3, 4e-3, 0.088, 0.095, 0.088], [0.32, 0, 4e-3, 0.077, 0.083, 0.075], [0.4, 0, 4e-3, 0.069, 0.074, 0.067], [0.44, 0, 4e-3, 0.067, 0.071, 0.065], [0.5, 0, 0, 0.065, 0.065, 0.068], [0.58, 0, -4e-3, 0.064, 0.058, 0.074], [0.68, 0, -2e-3, 0.059, 0.055, 0.066], [0.722, 0, 0, 0.058, 0.056, 0.062], [0.755, 0, 2e-3, 0.063, 0.063, 0.065], [0.775, 0, 2e-3, 0.059, 0.059, 0.06], [0.788, 0, 2e-3, 0.047, 0.047, 0.048]], aQ = [[-0.055, -0.01, 0, 0.044, 0.05, 0.05], [0, 4e-3, 0, 0.058, 0.062, 0.061], [0.06, 3e-3, 0, 0.058, 0.061, 0.06], [0.15, 0, 2e-3, 0.055, 0.058, 0.056], [0.25, 0, 0, 0.049, 0.05, 0.051], [0.3, 0, -2e-3, 0.047, 0.046, 0.051], [0.36, 0, 0, 0.047, 0.048, 0.047], [0.45, 0, 0, 0.041, 0.04, 0.04], [0.515, 0, 0, 0.036, 0.034, 0.034], [0.545, 0, 0, 0.035, 0.033, 0.033]], MH = l2(iQ), wH = l2(aQ);
function EH(o2, t, e, s, n, i) {
  o2(t, Lo);
  let a = Math.cos(e), r = Math.sin(e), l = tf(a, r, Lo[2], Lo[3], Lo[4], 2.1) + n;
  return i[0] = Lo[0] * s + l * a, i[1] = t, i[2] = Lo[1] + l * r, i[3] = a, i[4] = r, i;
}
var e4 = (o2, t, e, s, n) => EH(MH, o2, t, e, s, n), iy = (o2, t, e, s, n) => EH(wH, o2, t, e, s, n), yc = (o2, t, e) => ny((e - o2) / (t - o2), 0, 1);
function vc(o2, t, e, s) {
  s = s * s * (3 - 2 * s), o2[0] = t, o2[1] = 1 - s, o2[2] = e, o2[3] = s;
}
function FR(o2, t, e) {
  let s = t * d5, n = qr;
  o2 < 0 ? vc(e, Ve.pelvis, Ve.hipH + s, yc(-0.06, 0, o2)) : o2 < 0.085 ? vc(e, Ve.hipH + s, Ve.thigh0 + s, yc(0, 0.085, o2)) : o2 < n - 0.085 ? vc(e, Ve.thigh0 + s, Ve.thigh + s, yc(0.1, 0.3, o2)) : o2 < n ? vc(e, Ve.thigh + s, Ve.kneeH + s, yc(n - 0.08, n, o2)) : vc(e, Ve.kneeH + s, Ve.shin + s, yc(n, n + 0.08, o2));
}
function OR(o2, t, e) {
  let s = t * Ru, n = Ca;
  o2 < -0.012 ? vc(e, Ve.shH + s, Ve.uarm0 + s, yc(-0.055, -0.012, o2)) : o2 < n - 0.07 ? vc(e, Ve.uarm0 + s, Ve.uarm + s, yc(0.09, 0.21, o2)) : o2 < n ? vc(e, Ve.uarm + s, Ve.elbH + s, yc(n - 0.065, n, o2)) : o2 < n + 0.07 ? vc(e, Ve.elbH + s, Ve.farm + s, yc(n, n + 0.065, o2)) : vc(e, Ve.farm + s, Ve.farmTw + s, yc(n + 0.08, n + 0.2, o2));
}
function xH(o2, t) {
  o2 < 1.125 ? vc(t, Ve.pelvis, Ve.spine, yc(1.03, 1.11, o2)) : o2 < 1.5 ? vc(t, Ve.spine, Ve.chest, yc(1.2, 1.34, o2)) : vc(t, Ve.chest, Ve.neck, yc(1.525, 1.57, o2));
}
function sy(o2, t) {
  return (e, s) => {
    let n = Math.sin(s), i = Math.cos(s), a = s / LE, r = (oy.fbm(e * 13 + t, a * 8, 3, 8) - 0.5) * 35e-4;
    for (let l = 0; l < o2.length; l++) {
      let c = o2[l], h = c.mask(e, n, i);
      if (h < 2e-3) continue;
      let f = (oy.noise(e * (c.wf || 9) + t * 1.7 + l * 3.1, a * 8, 8) - 0.5) * c.warp, u = 0.5 + 0.5 * Math.sin(LE * (e / c.lam + c.k * a + f));
      r += c.amp * h * (Math.pow(u, c.sharp || 1.6) - 0.42);
    }
    return r;
  };
}
function bc(o2, t, e) {
  let s = [], n = Math.max(1, Math.round((t - o2) / e));
  for (let i = 0; i <= n; i++) s.push(o2 + (t - o2) * i / n);
  return s;
}
function zE(o2, t, e, s) {
  let n = h5[o2], i = h5[t], a = new THREE.Vector3(i[0] - n[0], i[1] - n[1], i[2] - n[2]).normalize(), r = new THREE.Vector3(0, 0, -1), l = new THREE.Vector3().crossVectors(a, r);
  return new THREE.Matrix4().makeBasis(l, a, r).setPosition(n[0], n[1], n[2]);
}
var Au = { legL: zE(fs.lHip, fs.lKnee), legR: zE(fs.rHip, fs.rKnee), armL: zE(fs.lShoulder, fs.lElbow), armR: zE(fs.rShoulder, fs.rElbow) };
function Jg(o2, t, e, { side: s = 1, seam: n = 0, disp: i = null, e: a = 2.1, torso: r = false } = {}) {
  let l = [], c = [], h = uh(t.length - 1, e, (f, u, d) => {
    let m = t[f];
    o2(m, Lo);
    let p = n + LE * u / e, x = Math.cos(p), g = Math.sin(p), b, v = 0;
    r ? b = tf(x, g, Lo[1], Lo[2], Lo[3], Lo[4]) : b = tf(x, g, Lo[2], Lo[3], Lo[4], a), i && (v = i(m, p), b += v), r ? (d[0] = b * x, d[1] = m, d[2] = Lo[0] + b * g) : (d[0] = Lo[0] * s + b * x, d[1] = m, d[2] = Lo[1] + b * g);
  }, { wrapJ: true });
  for (let f = 0; f < t.length; f++) for (let u = 0; u <= e; u++) {
    let d = t[f], m = n + LE * (u % e) / e;
    c.push(d), l.push(i ? i(d, m) : 0);
  }
  return h.s = c, h.d = l, h;
}
function TH(o2, t) {
  Zb.length = 0;
  let e = new THREE.Color(t.shirt).multiplyScalar(0.7).getHex(), s = (i, a = 26) => (r, l, c, h) => ny(0.86 + a * i.d[h], 0.55, 1), n = (i, a, r) => {
    let l = new THREE.Color(i), c = new THREE.Color(a);
    return l.lerp(c, r), l.getHex();
  };
  {
    let i = sy([{ amp: 5e-3, lam: 0.045, k: 0, warp: 0.9, mask: (l, c) => Gn(0.9, 0.96, l) * Gn(1.05, 1, l) * (0.5 + 0.5 * Math.max(-c, 0)) }, { amp: 4e-3, lam: 0.06, k: 2, warp: 0.7, mask: (l) => Gn(0.86, 0.92, l) * Gn(1, 0.94, l) }], 3.3), a = Jg(bH, bc(0.834, 1.09, 0.0142), 32, { torso: true, seam: Math.PI / 2, disp: i }), r = o2.count;
    o2.add(a, { color: 16777215, camo: 1, surf: 0, rough: 0.9, ao: s(a), weights: (l, c, h, f) => xH(c, f) }), np(o2, r, a.p.length / 3 - 33, 32, { dir: [0, -1, 0], face: [0, 1, 0], depth: 0.035, shrink: 0.06, color: e });
  }
  {
    let i = sy([{ amp: 6e-3, lam: 0.038, k: 0, warp: 1, mask: (l) => Gn(1.07, 1.1, l) * Gn(1.22, 1.15, l) }, { amp: 4e-3, lam: 0.07, k: 1, warp: 0.8, mask: (l) => Gn(1.2, 1.3, l) * Gn(1.5, 1.42, l) }], 7.1), a = Jg(IR, bc(1.05, 1.57, 0.02), 30, { torso: true, seam: Math.PI / 2, disp: i }), r = o2.count;
    o2.add(a, { color: t.shirt, camo: 0, surf: 0, rough: 0.92, nrm: 0.7, ao: s(a), weights: (l, c, h, f) => xH(c, f) }), np(o2, r, a.p.length / 3 - 31, 30, { dir: [0, 1, 0], depth: 0.02, color: t.shirt, opts: { nrm: 0.7 } });
  }
  for (let i = 0; i < 2; i++) {
    let a = i ? 1 : -1, r = qr, l = sy([{ amp: 75e-4, lam: 0.034, k: 0, warp: 0.9, sharp: 1.4, mask: (p, x) => d2(p - r, 0.085) * (0.25 + 0.75 * Gn(0.25, -0.5, x)) }, { amp: 5e-3, lam: 0.03, k: 0, warp: 0.7, mask: (p, x) => d2(p - (r - 0.1), 0.045) * Gn(0, 0.6, x) }, { amp: 55e-4, lam: 0.15, k: a, warp: 1.1, wf: 6, sharp: 2, mask: (p) => Gn(0.03, 0.12, p) * Gn(r - 0.04, r - 0.14, p) }, { amp: 6e-3, lam: 0.05, k: -2 * a, warp: 0.6, mask: (p, x, g) => Gn(-0.05, 0.02, p) * Gn(0.17, 0.08, p) * Gn(-0.2, 0.5, x) }, { amp: 5e-3, lam: 0.12, k: -a, warp: 1, wf: 6, sharp: 1.8, mask: (p) => Gn(r + 0.07, r + 0.14, p) * Gn(0.7, 0.62, p) }, { amp: 75e-4, lam: 0.027, k: 0, warp: 1.1, sharp: 1.3, mask: (p) => Gn(0.63, 0.7, p) * Gn(0.785, 0.765, p) }], 11 + i * 5.3), c = [...bc(-0.075, 0.06, 0.027), ...bc(0.078, 0.33, 0.0194), ...bc(0.345, 0.54, 0.0139), ...bc(0.556, 0.665, 0.0218), ...bc(0.68, 0.788, 0.0135)], h = Jg(MH, c, 26, { side: a, seam: i ? Math.PI : 0, disp: l }), f = (p, x, g, b) => {
      let v = h.s[b], y = 0.28 * d2(v - r, 0.07) * Gn(-0.02, 0.05, g) + 0.22 * Gn(0.6, 0.78, v) + 0.1 * (oy.fbm(v * 9 + i * 7, p * 30, 2) - 0.5);
      return n(16777215, t.dust, ny(y, 0, 0.5));
    }, u = i ? Au.legR : Au.legL, d = h.s, m = o2.count;
    o2.add(h, { color: f, camo: 1, surf: 0, rough: 0.9, ao: s(h), m: u, weights: (p, x, g, b, v) => FR(d[v], i, b) }), np(o2, m, 0, 26, { dir: [0, 1, 0], depth: 0.03, color: 16777215, opts: { camo: 1, rough: 0.9 } });
  }
  for (let i = 0; i < 2; i++) {
    let a = i ? 1 : -1, r = Ca, l = sy([{ amp: 6e-3, lam: 0.03, k: 0, warp: 0.9, sharp: 1.4, mask: (d, m) => d2(d - r, 0.07) * (0.3 + 0.7 * Gn(-0.3, 0.5, m)) }, { amp: 45e-4, lam: 0.11, k: a, warp: 1, wf: 7, sharp: 1.9, mask: (d) => Gn(0.04, 0.1, d) * Gn(r - 0.03, r - 0.1, d) }, { amp: 4e-3, lam: 0.09, k: -a, warp: 1, wf: 7, sharp: 1.8, mask: (d) => Gn(r + 0.05, r + 0.1, d) * Gn(0.5, 0.44, d) }, { amp: 5e-3, lam: 0.024, k: 0, warp: 1, mask: (d) => Gn(0.44, 0.48, d) * Gn(0.545, 0.525, d) }, { amp: 5e-3, lam: 0.04, k: 2 * a, warp: 0.7, mask: (d) => Gn(-0.05, 0, d) * Gn(0.09, 0.03, d) }], 23 + i * 3.7), c = [...bc(-0.055, 0.06, 0.0192), ...bc(0.076, 0.22, 0.018), ...bc(0.232, 0.37, 0.0125), ...bc(0.384, 0.545, 0.0161)], h = Jg(wH, c, 20, { side: a, seam: i ? Math.PI : 0, disp: l }), f = h.s, u = (d, m, p, x) => n(16777215, t.dust, ny(0.22 * d2(f[x] - r, 0.06) * Gn(-0.01, -0.04, p) + 0.08 * (oy.fbm(f[x] * 11 + i * 3, d * 40, 2) - 0.5), 0, 0.4));
    o2.add(h, { color: u, camo: 1, surf: 0, rough: 0.9, ao: s(h), m: i ? Au.armR : Au.armL, weights: (d, m, p, x, g) => OR(f[g], i, x) });
  }
  {
    let i = (r, l) => {
      let c = -Math.sin(l), h = Math.abs(Math.cos(l)), f = Math.max(c, 0), u = 0.021 * d2(r - 1.668, 0.021) * Math.pow(f, 14);
      return u += 4e-3 * d2(r - 1.642, 0.012) * Math.pow(f, 6), u += 6e-3 * d2(r - 1.612, 0.016) * Math.pow(f, 5), u -= 8e-3 * d2(r - 1.694, 0.016) * Math.pow(f, 2) * Gn(0.25, 0.6, h) * Gn(0.95, 0.7, h), u += 4e-3 * d2(r - 1.68, 0.03) * Gn(0.2, 0.7, f) * Gn(0.2, 0.6, h), u += (oy.fbm(r * 40, l * 3, 2, 0) - 0.5) * 2e-3, u += 18e-4 * Math.sin(r * 160 + h * 14) * d2(r - 1.63, 0.03) * Gn(0.2, 0.8, f), u;
    }, a = Jg(yH, [...bc(1.56, 1.6, 0.02), ...bc(1.608, 1.7, 92e-4), ...bc(1.715, 1.808, 0.0155)], 30, { torso: true, seam: Math.PI / 2, disp: i });
    o2.add(a, { fp: 1, color: t.mask, camo: 0, surf: 0, rough: 0.88, nrm: 0.8, weights: (r, l, c, h) => vc(h, Ve.neck, Ve.head, yc(1.575, 1.61, l)) });
  }
  {
    let i = [[1.5, 6e-3, 0.086, 0.078, 0.09, 2], [1.522, 4e-3, 0.098, 0.09, 0.108, 2], [1.552, 2e-3, 0.096, 0.09, 0.11, 2], [1.582, 0, 0.086, 0.084, 0.102, 2], [1.606, -2e-3, 0.076, 0.076, 0.094, 2], [1.622, -4e-3, 0.066, 0.068, 0.084, 2]], a = sy([{ amp: 0.011, lam: 0.034, k: 1, warp: 1.5, wf: 14, sharp: 1.3, mask: () => 1 }, { amp: 6e-3, lam: 0.021, k: -2, warp: 1.2, wf: 20, mask: () => 1 }], 41), r = Jg(l2(i), bc(1.5, 1.622, 87e-4), 34, { torso: true, seam: Math.PI / 2, disp: a });
    o2.add(r, { fp: 1, color: t.gaiter, camo: 0.55, surf: 0, rough: 0.95, ao: s(r, 22), weights: (l, c, h, f) => {
      vc(f, Ve.chest, Ve.neck, yc(1.55, 1.64, c));
    } });
  }
}
var Ze = (o2) => o2 * Math.PI / 180, Bt = (o2, t, e) => new THREE.Vector3(o2, t, e), Gt = (o2, t, e) => new THREE.Vector3(o2, t, -e), C1 = false, p4 = new THREE.Matrix4(), hr0 = new THREE.Quaternion(), fr0 = new THREE.Vector3(), ur0 = new THREE.Vector3(0, 1, 0);
function Qe(o2) {
  o2.index && (o2 = o2.toNonIndexed()), o2.attributes.normal || o2.computeVertexNormals();
  let t = o2.attributes.position.count;
  o2.attributes.uv || o2.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t * 2), 2));
  for (let e of Object.keys(o2.attributes)) e !== "position" && e !== "normal" && e !== "uv" && e !== "color" && o2.deleteAttribute(e);
  return o2.attributes.color || o2.setAttribute("color", new THREE.BufferAttribute(new Float32Array(t * 3).fill(1), 3)), o2.clearGroups(), o2;
}
var KH = (o2) => {
  let t = 0;
  for (let e = 0; e < o2.length; e++) {
    let s = o2[e], n = o2[(e + 1) % o2.length];
    t += s[0] * n[1] - n[0] * s[1];
  }
  return t;
};
function XH(o2, t) {
  let e = t.length;
  for (let s = 0; s < e; s++) {
    let n = t[s], i = t[(s + e - 1) % e], a = t[(s + 1) % e], r = C1 && (n[2] || 0) < 8e-3 ? 0 : n[2] || 0;
    if (r > 0) {
      let l = Math.hypot(i[0] - n[0], i[1] - n[1]), c = Math.hypot(a[0] - n[0], a[1] - n[1]), h = Math.min(r, l * 0.48), f = Math.min(r, c * 0.48), u = n[0] + (i[0] - n[0]) * h / l, d = n[1] + (i[1] - n[1]) * h / l, m = n[0] + (a[0] - n[0]) * f / c, p = n[1] + (a[1] - n[1]) * f / c;
      s === 0 ? o2.moveTo(u, d) : o2.lineTo(u, d), o2.quadraticCurveTo(n[0], n[1], m, p);
    } else s === 0 ? o2.moveTo(n[0], n[1]) : o2.lineTo(n[0], n[1]);
  }
  o2.closePath();
}
function PQ(o2, t) {
  KH(o2) < 0 && (o2 = o2.slice().reverse());
  let e = new THREE.Shape();
  if (XH(e, o2), t) for (let s of t) {
    KH(s) > 0 && (s = s.slice().reverse());
    let n = new THREE.Path();
    XH(n, s), e.holes.push(n);
  }
  return e;
}
function zQ(o2) {
  let t = o2.attributes.position, e = t.count, s = new Float32Array(e * 3).fill(1), n = new THREE.Vector3(), i = new THREE.Vector3(), a = new THREE.Vector3();
  for (let r = 0; r < e; r += 3) {
    n.fromBufferAttribute(t, r), i.fromBufferAttribute(t, r + 1), a.fromBufferAttribute(t, r + 2), i.sub(n), a.sub(n), i.cross(a);
    let l = i.length();
    if (l < 1e-12) continue;
    let c = Math.abs(i.z / l);
    c > 0.12 && c < 0.985 && s.fill(2, r * 3, r * 3 + 9);
  }
  o2.setAttribute("color", new THREE.BufferAttribute(s, 3));
}
function bp(o2, t, e) {
  let s = C1 ? 0 : Math.min(e.b ?? 8e-4, t * 0.45), n = new THREE.ExtrudeGeometry(PQ(o2, C1 && !e.keepHoles ? null : e.holes), { depth: t - 2 * s, steps: 1, curveSegments: C1 ? 1 : e.cs ?? 4, bevelEnabled: s > 0, bevelThickness: s, bevelSize: s, bevelOffset: -s, bevelSegments: e.bs ?? 1 });
  return s > 0 && zQ(n), e.soft && !C1 && (n = th(n, e.soft === true ? 0.85 : e.soft)), n.userData.b = s, n.userData.depth = t - 2 * s, n;
}
function us(o2, t, e = {}) {
  let s = bp(o2, t, e);
  return p4.set(0, 0, 1, (e.x || 0) - s.userData.depth / 2, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1), Qe(s.applyMatrix4(p4));
}
function si(o2, t, e = {}) {
  let s = (i) => i.map((a) => [-a[0], a[1], a[2]]), n = bp(s(o2), t, { ...e, holes: e.holes ? e.holes.map(s) : null });
  if (p4.set(-1, 0, 0, e.x || 0, 0, 1, 0, e.y || 0, 0, 0, -1, -((e.u || 0) + n.userData.b), 0, 0, 0, 1), e.swapUV) {
    let i = n.attributes.uv;
    for (let a = 0; a < i.count; a++) i.setXY(a, i.getY(a), i.getX(a));
  }
  return Qe(n.applyMatrix4(p4));
}
function jc(o2, t, e = {}) {
  let s = bp(o2, t, e);
  return p4.set(1, 0, 0, 0, 0, 0, 1, (e.y || 0) + s.userData.b, 0, -1, 0, 0, 0, 0, 0, 1), Qe(s.applyMatrix4(p4));
}
var Hs = Math.PI / 180, Pn = Math.PI * 2, nF = new THREE.Quaternion(), JH = new THREE.Euler(), DQ = new THREE.Vector3(), IQ = new THREE.Matrix4(), tF = new THREE.Vector3(), by = new THREE.Vector3(), yy = new THREE.Vector3(), HQ = new THREE.Vector3(0, 0, -1), wr = (o2, t, e = {}) => us(o2, t, { b: 0.5, ...e }), jo = (o2, t, e = {}) => si(o2, t, { b: 0.5, ...e }), oF = (o2, t, e = {}) => jc(o2, t, { b: 0.5, ...e }), gl = (o2, t, e = 0, s = 0, n = 0) => [[s - o2 / 2, n - t / 2, e], [s + o2 / 2, n - t / 2, e], [s + o2 / 2, n + t / 2, e], [s - o2 / 2, n + t / 2, e]], yh = (o2, t, e = 0, s = 0, n = 0) => Array.from({ length: o2 }, (i, a) => [s + Math.cos(e + a / o2 * Pn) * t, n + Math.sin(e + a / o2 * Pn) * t]);
function b4(o2, t, e) {
  return e && (JH.set(e[0] * Hs, e[1] * Hs, e[2] * Hs, "XYZ"), o2.applyQuaternion(nF.setFromEuler(JH))), t && o2.translate(t[0], t[1], -t[2]), o2;
}
var FQ = { "x+": [1, 0, 0], "x-": [-1, 0, 0], "y+": [0, 1, 0], "y-": [0, -1, 0], "u+": [0, 0, -1], "u-": [0, 0, 1] };
function _c(o2, t, e) {
  let s = typeof t == "string" ? FQ[t] : t;
  return o2.applyQuaternion(nF.setFromUnitVectors(HQ, DQ.set(s[0], s[1], s[2]).normalize())), e && o2.translate(e[0], e[1], -e[2]), o2;
}
var OQ = { L: [[-1, 0, 0], [0, 1, 0]], R: [[1, 0, 0], [0, 1, 0]], T: [[0, 1, 0], [0, 0, -1]], B: [[0, 0, 1], [0, 1, 0]], F: [[0, 0, -1], [0, 1, 0]], D: [[0, -1, 0], [0, 0, -1]] };
function Ie(o2, t, e, s = 0) {
  let [n, i] = typeof e == "string" ? OQ[e] : e;
  return yy.set(n[0], n[1], n[2]).normalize(), by.set(i[0], i[1], i[2]), by.addScaledVector(yy, -by.dot(yy)).normalize(), tF.crossVectors(by, yy), s && o2.rotateZ(s * Hs), o2.applyMatrix4(IQ.makeBasis(tF, by, yy)), t && o2.translate(t[0], t[1], -t[2]), o2;
}
var tA = [0, 0], $c = class {
  constructor() {
    this.p = [], this.n = [], this.t = [], this.c = [];
  }
  tri(t, e, s, n, i, a = 1) {
    let r = e[0] - t[0], l = e[1] - t[1], c = e[2] - t[2], h = s[0] - t[0], f = s[1] - t[1], u = s[2] - t[2], d = l * u - c * f, m = c * h - r * u, p = r * f - l * h, x = Math.hypot(d, m, p);
    if (x < 1e-7) return;
    this.p.push(t[0], t[1], t[2], e[0], e[1], e[2], s[0], s[1], s[2]), n ? this.n.push(n[0][0], n[0][1], n[0][2], n[1][0], n[1][1], n[1][2], n[2][0], n[2][1], n[2][2]) : (d /= x, m /= x, p /= x, this.n.push(d, m, p, d, m, p, d, m, p));
    let g = i ? i[0] : tA, b = i ? i[1] : tA, v = i ? i[2] : tA;
    this.t.push(g[0], g[1], b[0], b[1], v[0], v[1]), this.c.push(a, a, a, a, a, a, a, a, a);
  }
  quad(t, e, s, n, i, a, r = 1) {
    this.tri(t, e, n, i && [i[0], i[1], i[3]], a && [a[0], a[1], a[3]], r), this.tri(e, s, n, i && [i[1], i[2], i[3]], a && [a[1], a[2], a[3]], r);
  }
  quadFacing(t, e, s, n, i, a = 1, r = false) {
    let l = e[0] - t[0], c = e[1] - t[1], h = e[2] - t[2], f = n[0] - t[0], u = n[1] - t[1], d = n[2] - t[2], m = c * d - h * u, p = h * f - l * d, x = l * u - c * f;
    m * (i[0] - t[0]) + p * (i[1] - t[1]) + x * (i[2] - t[2]) >= 0 !== r ? this.quad(t, e, s, n, null, null, a) : this.quad(t, n, s, e, null, null, a);
  }
  geo() {
    let t = new THREE.BufferGeometry();
    return t.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.p), 3)), t.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(this.n), 3)), t.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(this.t), 2)), t.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.c), 3)), t;
  }
};
function cn(o2, t = {}) {
  let e = t.flute || null, s = e ? e.trap ? [0, 0, 1, 1] : [0, 1] : [0], n = e ? e.n * s.length : t.seg || 24, i = o2.length, a = Math.cos((t.crease ?? 32) * Hs), r = [];
  for (let p = 0; p < i - 1; p++) {
    let x = o2[p + 1][0] - o2[p][0], g = o2[p + 1][1] - o2[p][1], b = Math.hypot(x, g) || 1;
    r.push([-g / b, x / b]);
  }
  let l = 0;
  for (let p of o2) l = Math.max(l, p[1]);
  let c = new $c(), h = t.x || 0, f = t.y || 0, u = (p, x) => {
    let g = o2[p], b = Math.max(0, g[1] - (g[3] || 0) * s[x % s.length]), v = x / n * Pn;
    return [h + b * Math.cos(v), f + b * Math.sin(v), -g[0]];
  }, d = (p, x) => {
    let g = p[0] + x[0], b = p[1] + x[1], v = Math.hypot(g, b) || 1;
    return [g / v, b / v];
  }, m = 0;
  for (let p = 0; p < i - 1; p++) {
    let x = o2[p], g = o2[p + 1], b = Math.hypot(g[0] - x[0], g[1] - x[1]), v = e && ((x[3] || 0) > 0 || (g[3] || 0) > 0), y = r[p], M = r[p];
    p > 0 && r[p - 1][0] * r[p][0] + r[p - 1][1] * r[p][1] > a && (y = d(r[p - 1], r[p])), p < i - 2 && r[p + 1][0] * r[p][0] + r[p + 1][1] * r[p][1] > a && (M = d(r[p + 1], r[p]));
    for (let w = 0; w < n; w++) {
      let T = u(p, w), S = u(p + 1, w), E = u(p + 1, w + 1), _ = u(p, w + 1), R = w / n * Pn, C = (w + 1) / n * Pn, L = [[R * l, m], [R * l, m + b], [C * l, m + b], [C * l, m]], A = g[2] ? 2 : 1, O = null;
      if (v) e.wear && s[w % s.length] === 0 && s[(w + 1) % s.length] === 0 && (A = 2);
      else if (!t.flat) {
        let H = Math.cos(R), F = Math.sin(R), P = Math.cos(C), z = Math.sin(C);
        O = [[y[1] * H, y[1] * F, -y[0]], [M[1] * H, M[1] * F, -M[0]], [M[1] * P, M[1] * z, -M[0]], [y[1] * P, y[1] * z, -y[0]]];
      }
      c.quad(T, S, E, _, O, L, A);
    }
    m += b;
  }
  return c.geo();
}
function Mh(o2, t, e = {}) {
  let s = new THREE.CatmullRomCurve3(o2.map((i) => new THREE.Vector3(i[0], i[1], -i[2])), false, "centripetal"), n = new THREE.TubeGeometry(s, e.seg || o2.length * 4, t, e.radial || 6, false);
  return Qe(n);
}
var _f = Math.PI * 2, lo = Math.PI, JT = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, _2 = (o2, t, e) => {
  let s = JT((e - o2) / (t - o2), 0, 1);
  return s * s * (3 - 2 * s);
}, XT = (o2, t) => Math.exp(-(o2 * o2) / (t * t)), ct0 = (o2, t, e) => JT((e - o2) / (t - o2), 0, 1), ZT = (o2) => (o2 = (o2 + lo) % _f, o2 < 0 && (o2 += _f), o2 - lo), ht0 = _n(905), ro = [0, 0, 0, 0, 0], Rs = [0, 0, 0, 0, 0, 0], ON = (o2, t, e, s) => [[t, s, 0.7, 0.7], [o2, s, -0.7, 0.7], [o2, e, -0.7, -0.7], [t, e, 0.7, -0.7]];
function mo(o2, t, e = 0, s = 0, n = 0, i = 0) {
  return ti(o2, t[0] + t[3] * e, t[1], t[2] + t[4] * e, s, Math.atan2(-t[3], -t[4]) + i, n);
}
function YT(o2, t, e, s = 0) {
  let n = new THREE.Vector3(-e[0], -e[1], -e[2]).normalize(), i = new THREE.Vector3(0, 1, 0), a = new THREE.Vector3().crossVectors(i, n).normalize(), r = new THREE.Vector3().crossVectors(n, a);
  return yE(o2, new THREE.Matrix4().makeBasis(a, r, n).setPosition(t[0] + e[0] * s, t[1] + e[1] * s, t[2] + e[2] * s));
}
function G5(o2, t, e, s, n, i = 0, a = _f) {
  let r = [], l = a - i >= _f - 1e-6, c = l ? n : n + 1;
  for (let h = 0; h < c; h++) {
    let f = a - (a - i) * (h / n), u = o2(t, f, e, s, [0, 0, 0, 0, 0]);
    r.push({ p: [u[0], u[1], u[2]], b: [0, 1, 0], n: [u[3], 0, u[4]] });
  }
  return r;
}
var jl = { yc: 1.706, cz: 4e-3, a: 0.109, bb: 0.134, bf: 0.13, ry: 0.122 };
function Sf(o2, t, e, s) {
  let n = Math.sin(o2), i = -Math.cos(o2), a = tf(n, i, jl.a, jl.bb, jl.bf, 2.25), r = Math.pow(Math.max(Math.cos(t), 0), 0.85), l = Math.sin(t), c = a * r * n, h = jl.ry * l, f = a * r * i, u = c / (jl.a * jl.a), d = h / (jl.ry * jl.ry), m = f / (i >= 0 ? jl.bb * jl.bb : jl.bf * jl.bf), p = Math.hypot(u, d, m) || 1;
  return u /= p, d /= p, m /= p, s[0] = c + u * e, s[1] = jl.yc + h + d * e, s[2] = jl.cz + f + m * e, s[3] = u, s[4] = d, s[5] = m, s;
}
var q4 = (o2) => {
  let t = Math.abs(ZT(o2));
  return 1.744 - 8e-3 * _2(0.6, 1.2, t) - 0.062 * _2(1.95, 2.5, t);
}, QT = (o2) => Math.asin(JT((o2 - jl.yc) / jl.ry, -0.99, 0.99));
function jT(o2, t, e, s, n, i = 3, a = 4) {
  return uh(i, a, (r, l, c) => {
    Sf(o2 + (t - o2) * l / a, e + (s - e) * r / i, n, Rs), c[0] = Rs[0], c[1] = Rs[1], c[2] = Rs[2];
  });
}
function $T(o2, t, e, s, n) {
  let i = [];
  for (let a = 0; a <= e; a++) {
    let r = t + (o2 - t) * (a / e);
    Sf(r, QT(s(r)), n, Rs);
    let l = Math.hypot(Rs[3], Rs[5]) || 1;
    i.push({ p: [Rs[0], Rs[1], Rs[2]], b: [0, 1, 0], n: [Rs[3] / l, 0, Rs[5] / l] });
  }
  return i;
}
var Xy = [];
function NN(o2, t, e, s, n, i, a) {
  let r = s + 1, l = [];
  for (let g = 0; g <= s; g++) l.push(g);
  for (let g = 1; g <= e; g++) l.push(g * r + s);
  for (let g = s - 1; g >= 0; g--) l.push(e * r + g);
  for (let g = e - 1; g >= 1; g--) l.push(g * r);
  let c = (g) => [t.p[g * 3], t.p[g * 3 + 1], t.p[g * 3 + 2]], h = (g) => [t.n[g * 3], t.n[g * 3 + 1], t.n[g * 3 + 2]], f = 0, u = 0, d = 0;
  for (let g of l) {
    let b = c(g);
    f += b[0], u += b[1], d += b[2];
  }
  f /= l.length, u /= l.length, d /= l.length;
  let m = { p: [], n: [], uv: [], idx: [] }, p = [];
  for (let g = 0; g < l.length; g++) {
    let b = l[g], v = l[(g + 1) % l.length], y = c(b), M = c(v), w = h(b), T = h(v), S = [M[0] - T[0] * i, M[1] - T[1] * i, M[2] - T[2] * i], E = [y[0] - w[0] * i, y[1] - w[1] * i, y[2] - w[2] * i], _ = M[0] - y[0], R = M[1] - y[1], C = M[2] - y[2], L = E[0] - y[0], A = E[1] - y[1], O = E[2] - y[2], H = R * O - C * A, F = C * L - _ * O, P = _ * A - R * L, z = Math.hypot(H, F, P) || 1;
    H /= z, F /= z, P /= z;
    let k = H * ((y[0] + M[0]) / 2 - f) + F * ((y[1] + M[1]) / 2 - u) + P * ((y[2] + M[2]) / 2 - d) >= 0, I = k ? 1 : -1, G = m.p.length / 3;
    for (let K of [y, M, S, E]) m.p.push(K[0], K[1], K[2]), m.n.push(H * I, F * I, P * I), m.uv.push(0, 0);
    p.push(b, v, v, b), k ? m.idx.push(G, G + 1, G + 2, G, G + 2, G + 3) : m.idx.push(G, G + 2, G + 1, G, G + 3, G + 2);
  }
  let x = p.map((g) => [o2.si[(n + g) * 4], o2.sw[(n + g) * 4], o2.si[(n + g) * 4 + 1], o2.sw[(n + g) * 4 + 1]]);
  return { pt: m, opts: { ...a, weights: (g, b, v, y, M) => {
    let w = x[M];
    y[0] = w[0], y[1] = w[1], y[2] = w[2], y[3] = w[3];
  } } };
}
function BN(o2, t) {
  JI(o2);
  for (let e of Xy) o2.add(e.pt, e.opts);
  Xy.length = 0;
}
function UN(o2, t) {
  Xy.length = 0;
  let e = PE(), s = (d, m) => o2.add(d, m), n = (d, m) => ({ color: d, rough: 0.82, surf: 1, nrm: 1, ...m }), i = (d, m) => ({ color: d, rough: 0.5, surf: 1, nrm: 0.12, ...m }), a = (d) => ({ color: t.glow, glow: t.glowK, rough: 0.3, nrm: 0, ...d }), r = { knit: 2895665, suede: 7298373, panel: 8021321, rubber: 1250067 }, l = (d, m, p, x, g, b = 4e-3, v = 1, y) => Tu(d, () => b > 0 ? Yg(m, p, x, g, b, v) : ON(m, p, x, g), y), c = { bone: Ve.chest }, h = 1.33, f = 6e-3, u = 0.032;
  {
    let d = (p, x, g) => {
      let b = ku(h, p - 1.06, p + 1.06, 16, f);
      return Tu(b, (v) => {
        let y = Math.abs(ZT(b[v].az - p));
        return Yg(x - h, g - 0.085 * _2(0.45, 1.06, y) - h, 0, u, 0.011, 2);
      });
    };
    s(d(0, 1.15, 1.47), n(t.gear, c)), s(d(lo, 1.145, 1.474), n(t.gear, c));
    for (let p of [1, -1]) {
      let x = p > 0 ? 0.98 : -(lo - 0.98), g = p > 0 ? lo - 0.98 : -0.98;
      s(l(ku(1.235, x, g, 10, 3e-3), -0.078, 0.072, 0, 0.015, 5e-3, 1), n(t.gear, c));
      for (let b of [1.185, 1.225, 1.265]) s(l(ku(1.235, x + 0.06, g - 0.06, 8, 0.018), b - 1.235 - 0.012, b - 1.235 + 0.012, 0, 32e-4, 0), n(t.web, c));
      s(mo(en(0.03, 0.046, 0.012, 4e-3), io(1.235, p * 1.09, 0.022, ro)), i(t.hard, c));
    }
    for (let p = 0; p < 5; p++) {
      let x = 1.185 + p * 0.042;
      s(l(ku(h, lo - 0.9, lo + 0.9, 8, f + u), x - h - 0.0125, x - h + 0.0125, 0, 34e-4, 0), n(t.web, c));
    }
    {
      io(h, lo, f + u, ro);
      let p = [];
      for (let x = 0; x <= 8; x++) {
        let g = x / 8, b = -0.05 + 0.1 * g, v = 0.014 * Math.sin(lo * g);
        p.push({ p: [b, 1.432 + v * 0.5, ro[2] + 2e-3 + v], b: [0, 1, 0], n: [0, 0, 1] });
      }
      s(l(p, -0.013, 0.013, 0, 5e-3, 2e-3, 1), n(t.gearDk, c)), s(mo(en(0.15, 0.04, 6e-3, 2e-3), io(1.398, lo, f + u + 3e-3, ro)), n(t.gearDk, { ...c, surf: 0 })), s(mo(Xg(0.125, 0.022, 4e-3), io(1.398, lo, f + u + 7e-3, ro)), a(c));
    }
    s(l(ku(h, -0.6, 0.6, 8, f + u), 1.385 - h, 1.452 - h, 0, 4e-3, 2e-3, 1), n(t.gearDk, { ...c, surf: 0 })), s(mo(Xg(0.085, 0.018, 4e-3), io(1.425, 0.26, f + u + 55e-4, ro)), a(c)), s(mo(en(0.05, 0.03, 5e-3, 2e-3), io(1.418, -0.26, f + u + 55e-4, ro)), n(t.gearLt, c)), s(l(ku(h, -0.92, 0.92, 10, f + u), 1.158 - h, 1.325 - h, 0, 6e-3, 3e-3, 1), n(t.gearLt, c));
    let m = { ...c, fp: 2 };
    for (let p of [-0.52, 0, 0.52]) {
      let x = f + u + 6e-3;
      s(mo(en(0.071, 0.112, 0.036, 9e-3), io(1.222, p, x + 0.017, ro)), n(t.gear, m)), s(mo(en(0.071, 0.018, 0.038, 4e-3), io(1.174, p, x + 0.018, ro)), n(t.gearDk, m)), s(mo(en(0.058, 0.062, 0.021, 5e-3), io(1.294, p, x + 0.018, ro), 0, -0.05), i(t.mag, { ...m, rough: 0.42 })), s(mo(Xg(0.05, 4e-3, 0.0225), io(1.307, p, x + 0.018, ro), 0, -0.05), i(t.metal, { ...m, rough: 0.35, metal: 0.6 }));
      let g = io(1.276, p, x, [0, 0, 0, 0, 0]), b = [];
      for (let v = 0; v <= 6; v++) {
        let y = v / 6, M = lo * y;
        b.push([0, 0.058 * Math.sin(M) * 1.02, -0.0185 - 0.0185 * Math.cos(M)]);
      }
      s(mo(dh(b, 26e-4, 4, false), g, 0, 0, 0), n(t.hard, m)), s(mo(en(0.014, 0.024, 4e-3, 15e-4), io(1.348, p, x + 0.018, ro), 0, -0.25), n(t.web, m));
    }
    for (let p of [1, -1]) {
      let x = p * 0.094, g = io(1.452, p * 0.62, f + u * 0.5, [0, 0, 0, 0, 0]), b = io(1.455, lo - p * 0.62, f + u * 0.5, [0, 0, 0, 0, 0]), v = [[1.44, g[2] - 4e-3], [1.476, g[2] + 0.01]];
      for (let w = 0; w <= 7; w++) {
        let T = g[2] + 0.034 + (b[2] - 0.034 - (g[2] + 0.034)) * w / 7;
        v.push([DE(Math.abs(x), T) + 2e-3, T]);
      }
      v.push([1.48, b[2] - 0.01], [1.44, b[2] + 4e-3]);
      let y = [];
      for (let w = 0; w < v.length * 2 - 1; w++) {
        let T = v[w >> 1], S = v[Math.min(w + 1 >> 1, v.length - 1)];
        y.push({ y: (T[0] + S[0]) / 2, z: (T[1] + S[1]) / 2 });
      }
      let M = y.map((w, T) => {
        let S = y[Math.max(T - 1, 0)], E = y[Math.min(T + 1, y.length - 1)], _ = E.y - S.y, R = E.z - S.z, C = Math.hypot(_, R) || 1;
        _ /= C, R /= C;
        let L = _2(1.47, 1.5, w.y), A = Math.atan((DE(Math.abs(x) + 0.02, w.z) - DE(Math.abs(x) - 0.02, w.z)) / 0.04) * p * L * 0.85, O = Math.cos(A), H = Math.sin(A);
        return { p: [x, w.y, w.z], b: [O, H, 0], n: [-R * H, R * O, -_ * O] };
      });
      s(l(M, -0.028, 0.028, 0, 9e-3, 3e-3, 1), n(t.gear, c)), s(l(M.slice(5, M.length - 5), -0.031, 0.031, 6e-3, 0.015, 5e-3, 1), n(t.gearDk, c)), s(ti(en(0.044, 0.026, 0.012, 4e-3), x, 1.468, g[2] - 6e-3, -0.45, 0, 0), i(t.hard, c)), s(ti(en(0.03, 0.05, 5e-3, 2e-3), x, 1.428, g[2] - 0.017, -0.12, 0, 0), n(t.web, c));
    }
    {
      let p = io(1.275, -2.06, 0.018, [0, 0, 0, 0, 0]);
      s(mo(en(0.064, 0.14, 0.038, 8e-3), p, 0.02), n(t.gear, c)), s(mo(en(0.056, 0.05, 0.036, 6e-3), io(1.352, -2.06, 0.018, ro), 0.02), i(t.hard, c));
      let x = p[0] + p[3] * 0.02 - 0.012, g = p[2] + p[4] * 0.02;
      s(ti(l5(7e-3, 8e-3, 0.03, 7), x, 1.39, g), i(t.hard, c)), s(ti(l5(6e-3, 6e-3, 0.014, 7), x + 0.03, 1.384, g), i(t.metal, { ...c, metal: 0.5 })), s(dh([[x, 1.4, g], [x - 2e-3, 1.47, g + 4e-3], [x - 8e-3, 1.56, g + 0.016], [x - 0.02, 1.66, g + 0.04]], (b) => 42e-4 - 18e-4 * b, 5), i(t.hard, { ...c, rough: 0.6, fp: 1 }));
    }
    s(mo(en(0.055, 0.095, 0.036, 0.01), io(1.245, 2.02, 0.036, ro)), n(t.gearLt, c)), s(mo(en(0.057, 0.03, 0.038, 6e-3), io(1.283, 2.02, 0.037, ro)), n(t.gear, c)), s(mo(ti(l5(0.029, 0.029, 0.105, 12), 0, 0, 0), io(1.25, 1.42, 0.047, ro)), n(t.gear, c)), s(mo(ti(l5(0.021, 0.024, 0.02, 10), 0, 0.062, 0), io(1.25, 1.42, 0.047, ro)), i(t.metal, { ...c, metal: 0.5, rough: 0.4 })), s(ti(en(0.034, 0.046, 0.02, 6e-3), -0.094, 1.405, -0.158, -0.2, 0.1, 0), i(t.hard, c));
  }
  {
    let d = { bone: Ve.pelvis }, m = (p) => {
      let x = ku(1.062, -lo, lo, 40, p);
      return x.pop(), x;
    };
    s(l(m(2e-3), -0.036, 0.036, 0, 9e-3, 4e-3, 1, { closed: true }), n(t.gearDk, d)), s(l(m(0.011), -0.024, 0.024, 0, 6e-3, 2e-3, 1, { closed: true }), n(t.gear, d)), s(mo(en(0.054, 0.042, 0.014, 5e-3), io(1.062, 0, 0.022, ro)), i(t.metal, { ...d, metal: 0.7, rough: 0.38 })), s(mo(en(0.024, 0.03, 0.017, 4e-3), io(1.062, 0, 0.023, ro)), i(t.hard, d)), s(l(ku(1.062, lo - 0.34, lo + 0.34, 5, 0.0175), -9e-3, 9e-3, 0, 3e-3, 0), a(d));
    {
      let p = io(1.03, 1.5, 0.017, [0, 0, 0, 0, 0]);
      s(mo(en(0.07, 0.1, 0.012, 4e-3), p, 6e-3, 0, 0), i(t.hard, d)), s(mo(ti(en(0.088, 0.165, 0.042, 0.012), 8e-3, -0.085, 0, 0, 0, 0.14), p, 0.034), i(t.hard, { ...d, rough: 0.42 })), s(mo(ti(en(0.04, 0.085, 0.03, 8e-3), 0.045, 0.045, 0, 0, 0, 0.34), p, 0.034), i(t.mag, { ...d, rough: 0.55 })), s(mo(ti(en(0.105, 0.03, 0.027, 6e-3), 5e-3, 0.012, 0, 0, 0, 0.14), p, 0.034), i(t.metal, { ...d, metal: 0.6, rough: 0.35 })), s(mo(ti(en(0.02, 0.05, 0.05, 4e-3), -0.02, -0.03, 0, 0, 0, 0.14), p, 0.056), i(t.hard, d));
    }
    for (let p of [-0.6, -0.93]) s(mo(en(0.031, 0.082, 0.027, 6e-3), io(1.048, p, 0.031, ro)), i(t.hard, { ...d, rough: 0.45 })), s(mo(en(0.023, 0.022, 0.015, 3e-3), io(1.096, p, 0.031, ro)), i(t.mag, d));
    s(mo(en(0.078, 0.118, 0.034, 8e-3), io(1.036, -1.52, 0.034, ro)), n(t.gear, d)), s(mo(en(0.062, 0.04, 0.022, 4e-3), io(1.108, -1.52, 0.034, ro)), i(t.mag, { ...d, rough: 0.42 })), s(mo(ti(l5(0.034, 0.034, 0.115, 10), 0, 0, 0, 0, 0, lo / 2), io(1.02, -2.5, 0.045, ro)), n(t.gearLt, d)), s(mo(en(0.03, 0.075, 6e-3, 2e-3), io(1.03, -2.5, 0.082, ro)), n(t.web, d)), s(mo(en(0.13, 0.09, 0.058, 0.016), io(1.04, 2.56, 0.046, ro)), n(t.gearLt, d)), s(mo(en(0.132, 0.02, 0.06, 6e-3), io(1.058, 2.56, 0.047, ro)), n(t.gear, d)), s(mo(en(0.022, 0.03, 4e-3, 1e-3), io(1.03, 2.56, 0.078, ro)), n(6954262, d));
  }
  for (let d = 0; d < 2; d++) {
    let m = d ? 1 : -1, p = d ? Au.legR : Au.legL, x = qr, g = d * d5, b = [0, 0, 0, 0, 0], v = (w, T, S, E) => FR(T, d, E), y = (w, T, S) => uh(6, 7, (E, _, R) => {
      let C = -1 + 2 * _ / 7, L = -1 + 2 * E / 6, A = Math.pow(Math.max(1 - Math.pow(Math.abs(C), 2.6), 0), 0.5) * Math.pow(Math.max(1 - Math.pow(Math.abs(L), 2.6), 0), 0.5);
      e4(x + 2e-3 + L * 0.058 * w, lo / 2 + C * 0.84 * w, m, T + S * A * (1 + 0.45 * Math.exp(-C * C / 0.1) * (1 - L * L)), b), R[0] = b[0], R[1] = b[1], R[2] = b[2];
    });
    {
      let w = y(1, 5e-3, 0.013), T = o2.count;
      s(w, i(t.pad, { m: p, weights: v, rough: 0.62, nrm: 0.3 })), Xy.push(NN(o2, w, 6, 7, T, 9e-3, i(t.pad, { rough: 0.7, nrm: 0.3, ao: 0.7 })));
      let S = y(1.12, 25e-4, 6e-3), E = o2.count;
      s(S, n(t.gearDk, { m: p, weights: v })), Xy.push(NN(o2, S, 6, 7, E, 65e-4, n(t.gearDk, { ao: 0.6 })));
    }
    s(l(G5(e4, x + 0.074, m, 3e-3, 18), -0.011, 0.011, 0, 4e-3, 0), n(t.gearDk, { m: p, weights: v }));
    let M = d ? 0 : lo;
    s(l(G5(e4, 0.235, m, 2e-3, 7, M - 0.82, M + 0.82), -0.075, 0.075, 0, 0.02, 8e-3, 1), { color: 16777215, camo: 1, surf: 0, rough: 0.9, m: p, weights: v }), s(l(G5(e4, 0.18, m, 0.018, 7, M - 0.86, M + 0.86), -0.026, 0.026, 0, 7e-3, 3e-3, 1), { color: 15263976, camo: 1, surf: 0, rough: 0.9, m: p, weights: v }), s(l(G5(e4, 0.18, m, 0.0255, 5, M - 0.62, M + 0.62), -8e-3, 8e-3, 0, 3e-3, 0), a({ m: p, weights: v }));
  }
  for (let d = 0; d < 2; d++) {
    let m = d ? 1 : -1, p = d ? Au.armR : Au.armL, x = Ca, g = d * Ru, b = [0, 0, 0, 0, 0], v = (w, T, S, E) => OR(T, d, E), y = (w, T, S) => uh(5, 6, (E, _, R) => {
      let C = -1 + 2 * _ / 6, L = -1 + 2 * E / 5, A = Math.pow(Math.max(1 - Math.pow(Math.abs(C), 2.6), 0), 0.5) * Math.pow(Math.max(1 - Math.pow(Math.abs(L), 2.6), 0), 0.5);
      iy(x + 8e-3 + L * 0.046 * w, -lo / 2 + C * 0.8 * w, m, T + S * A, b), R[0] = b[0], R[1] = b[1], R[2] = b[2];
    });
    s(y(1, 45e-4, 0.01), i(t.pad, { m: p, weights: v, rough: 0.62, nrm: 0.3 })), s(y(1.1, 25e-4, 5e-3), n(t.gearDk, { m: p, weights: v }));
    let M = d ? 0 : lo;
    s(l(G5(iy, 0.118, m, 2e-3, 7, M - 1, M + 1), -0.052, 0.052, 0, 7e-3, 3e-3, 1), { color: 15790320, camo: 1, surf: 0, rough: 0.9, m: p, weights: v }), s(l(G5(iy, 0.105, m, 9e-3, 7, M - 0.92, M + 0.92), -0.033, 0.033, 0, 3e-3, 0), n(t.gearDk, { surf: 0, m: p, weights: v })), s(l(G5(iy, 0.105, m, 0.012, 6, M - 0.8, M + 0.8), -0.021, 0.021, 0, 35e-4, 0), a({ m: p, weights: v }));
  }
  for (let d = 0; d < 2; d++) {
    let m = e[Ve.hand + d * Ru], p = { bone: Ve.hand + d * Ru, m }, x = d ? { f: [[40, 62, 30], [62, 88, 48], [64, 90, 50], [66, 92, 52]], th: [[0.036, -0.02, -4e-3], [0.054, 4e-3, 0.016], [0.052, 0.034, 0.034], [0.042, 0.058, 0.042]] } : { f: [[52, 74, 40], [60, 82, 44], [62, 84, 46], [64, 86, 48]], th: [[0.036, -0.02, -4e-3], [0.056, 2e-3, 0.018], [0.057, 0.032, 0.038], [0.05, 0.058, 0.05]] }, g = (S) => d ? S : tH(S), b = [[0.031, 0.046], [95e-4, 0.05], [-0.0125, 0.047], [-0.033, 0.04]], v = [[0.045, 0.027, 0.023], [0.05, 0.03, 0.024], [0.046, 0.028, 0.023], [0.036, 0.022, 0.021]], y = [5, 0, -4, -10];
    s(g(ti(en(0.088, 0.102, 0.031, 0.013), 0, -4e-3, -0.0125)), { color: (S, E, _) => _ > -0.0125 ? r.suede : r.knit, rough: 0.95, surf: 0, nrm: 0.9, ...p }), s(g(ti(en(0.078, 0.024, 8e-3, 4e-3), 0, 0.037, -0.0295)), i(r.rubber, { ...p, rough: 0.78 })), s(g(ti(en(0.05, 0.032, 5e-3, 2e-3), 2e-3, -0.02, -0.0295)), n(r.panel, { ...p, surf: 0, rough: 0.95 }));
    for (let S = 0; S < 4; S++) {
      let E = [], _ = 0.0125 - S * 4e-4, R = y[S] * lo / 180, C = b[S][1], L = -0.012, A = b[S][0], O = 0;
      E.push([A, C - 0.012, L]), E.push([A, C, L]);
      for (let H = 0; H < 3; H++) {
        let F = O + x.f[S][H] * lo / 180, P = v[S][H], z = (O + F) / 2, k = [Math.sin(R) * Math.cos(z), Math.cos(R) * Math.cos(z), Math.sin(z)];
        A += k[0] * 6e-3, C += k[1] * 6e-3, L += k[2] * 6e-3, E.push([A, C, L]);
        let I = [Math.sin(R) * Math.cos(F), Math.cos(R) * Math.cos(F), Math.sin(F)];
        A += I[0] * (P - 6e-3), C += I[1] * (P - 6e-3), L += I[2] * (P - 6e-3), E.push([A, C, L]), O = F;
      }
      s(g(dh(E, (H) => _ * (1 - 0.2 * H), 7, true)), { color: S === 0 ? r.panel : r.knit, rough: 0.92, surf: 0, nrm: 0.9, ...p });
    }
    {
      let S = x.th;
      s(g(dh([[0.02, -0.036, -0.012], S[0], S[1], S[2], S[3]], (E) => 0.0155 - 45e-4 * E, 7, true)), { color: r.suede, rough: 0.95, surf: 0, nrm: 0.8, ...p });
    }
    let M = (S, E, _, R) => {
      let C = ct0(-0.09, -0.045, E);
      R[0] = Ve.farmTw + d * Ru, R[1] = 1 - C, R[2] = Ve.hand + d * Ru, R[3] = C;
    }, w = l2([[-0.105, 0, 0, 0.0385, 0.037, 0.037], [-0.085, 0, 0, 0.04, 0.038, 0.038], [-0.055, 0, 0, 0.036, 0.031, 0.031], [-0.04, 0, 0, 0.038, 0.022, 0.022]]), T = uh(5, 12, (S, E, _) => {
      let R = -0.105 + 0.065 * S / 5, C = _f * E / 12, L = [0, 0, 0, 0, 0];
      w(R, L);
      let A = Math.cos(C), O = Math.sin(C), H = tf(A, O, L[2], L[3], L[4], 2.2);
      _[0] = H * A, _[1] = R, _[2] = -0.012 + H * O;
    }, { wrapJ: true });
    s(g(T), { color: r.knit, rough: 0.92, surf: 0, nrm: 1, m, weights: M }), s(g(ti(en(0.034, 0.026, 6e-3, 2e-3), 0, -0.078, -0.051)), n(r.panel, { m, weights: M, surf: 0 }));
  }
  for (let d = 0; d < 2; d++) {
    let m = d ? Pi : -Pi, p = d * d5, x = Ve.foot + p, g = Ve.toe + p, b = Ve.shin + p, v = (z, k, I, G) => {
      if (k > 0.1) {
        let K = _2(0.1, 0.165, k);
        G[0] = x, G[1] = 1 - K, G[2] = b, G[3] = K;
      } else {
        let K = _2(-(u2 - 0.03), -(u2 + 0.03), I);
        G[0] = x, G[1] = 1 - K, G[2] = g, G[3] = K;
      }
    }, y = l2([[-0.214, 0.01, 0.02], [-0.198, 0.034, 0.04], [-0.165, 0.046, 0.05], [-0.115, 0.05, 0.056], [-0.065, 0.048, 0.078], [-0.025, 0.045, 0.108], [0.03, 0.043, 0.112], [0.066, 0.036, 0.104], [0.084, 0.012, 0.06]]), M = [];
    for (let z = 0; z <= 16; z++) M.push(-0.214 + 0.298 * (z / 16));
    let w = [0, 0], T = uh(16, 12, (z, k, I) => {
      y(M[z], w);
      let G = _f * k / 12, K = Math.cos(G), $ = Math.sin(G), n0 = w[1], e0 = w[0], p0 = tf(K, $, e0, n0 * 0.72, n0 * 0.28, 2.5);
      I[0] = m + p0 * K, I[1] = 0.022 + n0 * 0.28 + p0 * $, I[2] = M[z];
    }, { wrapJ: true, flip: true }), S = (z, k, I) => I < -0.148 + 0.01 * Math.cos((z - m) * 60) || I > 0.04 && k < 0.095 ? t.sole : t.boot;
    {
      let z = o2.count;
      s(T, { color: S, rough: 0.62, surf: 0, nrm: 0.45, weights: v }), np(o2, z, 0, 12, { dir: [0, 0, -1], depth: 6e-3, color: t.sole }), np(o2, z, 16 * 13, 12, { dir: [0, 0, 1], depth: 6e-3, color: t.boot });
    }
    let E = l2([[0.085, 0.01, 0.045, 0.052, 0.06, 2.2], [0.12, 0.011, 0.045, 0.051, 0.054, 2.2], [0.16, 0.012, 0.046, 0.05, 0.049, 2.2], [0.2, 0.012, 0.049, 0.051, 0.048, 2.2], [0.218, 0.012, 0.052, 0.054, 0.051, 2.2], [0.229, 0.012, 0.047, 0.049, 0.046, 2.2]]), _ = [0.085, 0.105, 0.125, 0.145, 0.165, 0.185, 0.2, 0.21, 0.218, 0.224, 0.229], R = [0, 0, 0, 0, 0], C = uh(_.length - 1, 14, (z, k, I) => {
      E(_[z], R);
      let G = _f * k / 14, K = Math.cos(G), $ = Math.sin(G), n0 = tf(K, $, R[1], R[2], R[3], R[4]);
      I[0] = m + n0 * K, I[1] = _[z], I[2] = R[0] + n0 * $;
    }, { wrapJ: true });
    {
      let z = o2.count;
      s(C, { color: (k, I) => I > 0.205 ? t.gearDk : t.boot, rough: 0.66, surf: 0, nrm: 0.45, weights: v }), np(o2, z, (_.length - 1) * 15, 14, { dir: [0, -1, 0], face: [0, 1, 0], depth: 0.012, shrink: 0.05, color: t.gearDk });
    }
    let A = [-0.218, -0.21, -0.19, -0.15, -0.1, -0.05, -0.036, -0.03, 6e-3, 0.012, 0.04, 0.07, 0.082, 0.088].slice().reverse().map((z) => ({ p: [m, 0, z], b: [-1, 0, 0], n: [0, 1, 0], z })), O = Tu(A, (z) => {
      let k = A[z].z;
      y(JT(k, -0.214, 0.084), w);
      let I = Math.max(w[0] + 5e-3, 0.012) * (k < -0.212 || k > 0.085 ? 0.6 : 1), G = 0.014 * _2(-0.15, -0.218, k) + (k > -0.033 && k < 9e-3 ? 0.011 : 0);
      return Yg(-I, I, G, 0.03 + 0.012 * _2(-0.17, -0.218, k), 6e-3, 1);
    });
    s(O, { color: t.sole, rough: 0.95, nrm: 0.5, surf: 1, weights: v });
    for (let z of [-1, 1]) for (let k of [-0.185, -0.155, -0.125, -0.095, -0.065, 0.025, 0.05, 0.073]) y(k, w), s(ti(Xg(8e-3, 0.016, 0.017), m + z * (w[0] + 6e-3), 9e-3 + 0.012 * _2(-0.15, -0.218, k), k), { color: t.sole, rough: 0.95, nrm: 0.3, weights: v });
    let H = (z, k) => {
      if (z < 0.45) {
        let I = -0.118 + z / 0.45 * 0.088;
        y(I, w), k[0] = m, k[1] = 0.022 + w[1] + 15e-4, k[2] = I, k[3] = 0, k[4] = 0.5;
      } else {
        let I = 0.128 + (z - 0.45) / 0.55 * 0.082;
        E(I, R), k[0] = m, k[1] = I, k[2] = R[0] - R[3] - 2e-3, k[3] = 1, k[4] = 0;
      }
      return k;
    }, F = [0, 0, 0, 0, 0], P = [0, 0, 0, 0, 0];
    for (let z = 0; z < 8; z++) {
      H(z / 8, F), H((z + 1) / 8, P);
      let k = 0.016, I = 0.016;
      for (let G of [-1, 1]) s(dh([[m + G * k, F[1] - 3e-3, F[2]], [m, (F[1] + P[1]) / 2 + 2e-3 * F[4], (F[2] + P[2]) / 2 - 3e-3 * F[3]], [m - G * I, P[1] - 3e-3, P[2]]], 21e-4, 4, false), { color: t.hard, rough: 0.8, nrm: 0.4, weights: v });
    }
    s(dh([[m, 0.2, 0.064], [m, 0.218, 0.073], [m, 0.236, 0.066], [m, 0.226, 0.058]], 35e-4, 4, false), n(t.gearDk, { weights: v }));
  }
  {
    let d = { bone: Ve.head }, m = 9, p = 34, x = uh(m, p, (g, b, v) => {
      let y = _f * b / p, M = QT(q4(y)), w = g / m, T = M + (lo / 2 - 0.02 - M) * (1 - Math.pow(1 - w, 1.25));
      Sf(y, T, 0, Rs);
      let S = 25e-4 * XT(Math.abs(ZT(y)) - 1.45, 0.5) * XT(T - 0.45, 0.25);
      v[0] = Rs[0] + Rs[3] * S, v[1] = Rs[1] + Rs[4] * S, v[2] = Rs[2] + Rs[5] * S;
    }, { wrapJ: true });
    s(x, { color: (g, b, v) => {
      let y = ht0.fbm(g * 22 + 3, (b + v) * 22, 3);
      return y > 0.56 ? t.gearLt : y < 0.4 ? t.gearDk : t.helmet;
    }, rough: 0.62, surf: 1, nrm: 0.25, ...d });
    {
      let g = $T(-lo, lo, 40, q4, 5e-4);
      g.pop(), s(Tu(g, () => CR(48e-4, 5), { closed: true }), i(t.hard, { ...d, rough: 0.7 }));
    }
    s(uh(1, p, (g, b, v) => {
      let y = _f * b / p;
      Sf(y, QT(q4(y)) + 0, -g * 0.014, Rs), v[0] = Rs[0], v[1] = Rs[1] - g * 4e-3, v[2] = Rs[2];
    }, { wrapJ: true, flip: true }), i(t.hard, { ...d, rough: 0.9 }));
    for (let g of [1, -1]) {
      let b = g > 0 ? 0.78 : -2.05, v = g > 0 ? 2.05 : -0.78;
      s(l($T(b, v, 9, (y) => q4(y) + 0.019, 1e-3), -0.012, 0.012, 0, 9e-3, 3e-3, 1), i(t.hard, d)), s(l($T(g > 0 ? 1 : -1.85, g > 0 ? 1.85 : -1, 6, (y) => q4(y) + 0.019, 95e-4), -4e-3, 4e-3, 0, 2e-3, 0), i(t.metal, d)), Sf(g * 1.93, QT(q4(g * 1.93) + 0.019), 0.011, Rs), s(YT(Xg(0.046, 0.013, 4e-3), Rs, [Rs[3], Rs[4], Rs[5]]), a(d)), s(jT(g * 1.1, g * 1.78, 0.42, 0.78, 18e-4), n(t.gearDk, { ...d, surf: 0 }));
    }
    s(jT(-0.42, 0.42, 0.96, 1.36, 18e-4, 3, 5), n(t.gearDk, { ...d, surf: 0 })), s(jT(lo - 0.4, lo + 0.4, 0.5, 0.86, 18e-4, 3, 5), n(t.gearDk, { ...d, surf: 0 })), Sf(0, 0.6, 0, Rs), s(YT(en(0.046, 0.052, 0.014, 5e-3), Rs, [Rs[3], Rs[4], Rs[5]], 5e-3), i(t.hard, d)), s(YT(en(0.03, 0.03, 0.016, 3e-3), Rs, [Rs[3], Rs[4], Rs[5]], 6e-3), i(t.metal, { ...d, metal: 0.5, rough: 0.4 }));
    for (let g of [-1, 1]) {
      Sf(g * 0.2, 0.6 + 0.2, 0, Rs);
      let b = [Rs[0], Rs[1], Rs[2]];
      Sf(g * 0.95, 0.5, 2e-3, Rs), s(dh([[b[0], b[1], b[2] - 4e-3], [(b[0] + Rs[0]) / 2, (b[1] + Rs[1]) / 2 + 8e-3, (b[2] + Rs[2]) / 2 - 0.012], [Rs[0], Rs[1], Rs[2]]], 2e-3, 4, false), i(t.hard, { ...d, rough: 0.8 }));
    }
    Sf(lo, 0.36, 0, Rs), s(YT(en(0.088, 0.05, 0.026, 9e-3), Rs, [Rs[3], Rs[4], Rs[5]], 0.011), n(t.gear, d)), Sf(lo, 0.02, 4e-3, Rs), s(jT(lo - 0.36, lo + 0.36, -0.085, 0.085, 35e-4, 2, 5), a(d));
    for (let g of [1, -1]) s(ti(en(0.036, 0.088, 0.068, 0.015, 2), g * 0.1015, 1.688, 0.016), i(t.hard, { ...d, rough: 0.48 })), s(ti(en(0.016, 0.074, 0.056, 7e-3), g * 0.082, 1.688, 0.016), n(t.gearDk, { ...d, surf: 0 })), s(ti(en(6e-3, 0.05, 0.036, 2e-3), g * 0.121, 1.69, 0.016), i(t.metal, { ...d, rough: 0.42 })), s(ti(l5(6e-3, 6e-3, 0.012, 6), g * 0.118, 1.664, 0.036, 0, 0, lo / 2), i(t.metal, d)), s(dh([[g * 0.106, 1.728, 0.016], [g * 0.112, 1.745, 0.02], [g * 0.111, 1.757, 0.022]], 4e-3, 5, false), i(t.hard, d));
    s(dh([[-0.108, 1.668, -0.012], [-0.106, 1.652, -0.05], [-0.088, 1.642, -0.086], [-0.05, 1.638, -0.108]], 3e-3, 5, false), i(t.hard, d)), s(ti(eH(0.011, 8, 6), -0.044, 1.638, -0.11, 0, 0, 0, 1.3, 1, 1), n(t.hard, { ...d, surf: 0, rough: 0.95 }));
    {
      let g = [];
      for (let w = 0; w <= 16; w++) {
        let T = 1.13 - 2.26 * w / 16;
        vH(1.699, T, 3e-3, ro), g.push({ p: [ro[0], ro[1], ro[2]], b: [0, 1, 0], n: [ro[3], 0, ro[4]], az: T });
      }
      let b = (w) => 1 - 0.55 * _2(0.75, 1.13, Math.abs(w));
      s(Tu(g, (w) => {
        let T = g[w].az, S = b(T);
        return Yg((-0.031 + 0.013 * XT(T, 0.17)) * S, 0.031 * S, 0, 0.021, 8e-3, 2);
      }), i(t.hard, { ...d, rough: 0.55 }));
      let v = g.slice(1, 16);
      s(Tu(v, (w) => {
        let T = v[w].az, S = b(T);
        return Yg((-0.021 + 0.013 * XT(T, 0.17)) * S, 0.022 * S, 0.019, 0.0232, 2e-3, 1);
      }), { color: 461067, rough: 0.1, nrm: 0, ...d });
      let y = g.slice(2, 15);
      s(Tu(y, (w) => {
        let T = b(y[w].az);
        return ON(35e-4 * T, 0.0165 * T, 0.0228, 0.0246);
      }), { color: t.lens, glow: t.glowK, rough: 0.2, nrm: 0, ...d });
      let M = $T(1.22, _f - 1.22, 22, (w) => 1.712 + 0.036 * _2(1.2, 1.7, Math.abs(ZT(w))), 3e-3);
      s(l(M, -0.014, 0.014, 0, 3e-3, 0), n(t.gearDk, { ...d, surf: 0 }));
      for (let w of [1, -1]) s(ti(en(0.012, 0.034, 0.03, 4e-3), w * 0.094, 1.703, -0.052, 0, w * -0.5, 0), i(t.hard, d));
    }
    for (let g of [1, -1]) s(dh([[g * 0.088, 1.735, -0.03], [g * 0.086, 1.69, -0.052], [g * 0.074, 1.645, -0.064], [g * 0.045, 1.612, -0.082], [g * 0.016, 1.603, -0.094]], 32e-4, 5, false), n(t.gearDk, d)), s(dh([[g * 0.09, 1.7, 0.07], [g * 0.084, 1.655, 0.03], [g * 0.074, 1.645, -0.064]], 28e-4, 4, false), n(t.gearDk, d));
    s(ti(en(0.05, 0.02, 0.03, 8e-3), 0, 1.602, -0.094, 0.25, 0, 0), n(t.gearDk, d)), s(ti(en(0.016, 0.022, 8e-3, 2e-3), -0.078, 1.652, -0.062, 0, 0.9, 0), i(t.hard, d));
  }
  s(en(0.022, 0.118, 0.06, 5e-3), i(t.mag, { bone: Ve.mag, rough: 0.42 }));
}
var Yy = Math.PI * 2, jy = (o2, t, e) => {
  let s = Math.min(Math.max((e - o2) / (t - o2), 0), 1);
  return s * s * (3 - 2 * s);
};
function VN(o2, t, e, s, n) {
  for (let i = 0; i < t; i++) for (let a = 0; a < t; a++) {
    let r = (a + t - 1) % t, l = (a + 1) % t, c = (i + t - 1) % t, h = (i + 1) % t, f = (o2[i * t + l] - o2[i * t + r]) * e, u = (o2[h * t + a] - o2[c * t + a]) * e, d = 1 / Math.hypot(f, u, 1), m = (i * t + a) * 4 + n;
    s[m] = Math.round((-f * d * 0.5 + 0.5) * 255), s[m + 1] = Math.round((-u * d * 0.5 + 0.5) * 255);
  }
}
var Bk = null;
function ft0() {
  if (Bk) return Bk;
  let o2 = 1024, t = new Uint8Array(o2 * o2 * 4), e = new Float32Array(o2 * o2), s = _n(311);
  for (let i = 0; i < o2; i++) for (let a = 0; a < o2; a++) {
    let r = a / o2, l = i / o2, c = 0.3 * Math.sin(Yy * (a + i) / 6) + 0.22 * Math.sin(Yy * a / 4) * Math.sin(Yy * i / 4), h = a % 32, f = i % 32;
    c += 0.75 * Math.max(Math.max(0, 1 - Math.abs(h - 1.5) / 1.6), Math.max(0, 1 - Math.abs(f - 1.5) / 1.6));
    let u = s.fbm(r * 7, l * 7, 4, 7), d = s.fbm(r * 13 + 5.3, l * 13 + 1.7, 3, 13);
    c += 5.5 * (1 - Math.abs(2 * u - 1)) + 2.2 * d, e[i * o2 + a] = c;
  }
  VN(e, o2, 0.55, t, 0);
  for (let i = 0; i < o2; i++) for (let a = 0; a < o2; a++) {
    let r = a / o2, l = i / o2, c = 8, h = Math.floor(a / c), f = Math.floor(i / c), u = a % c / c - 0.5, d = i % c / c - 0.5, p = h + f & 1 ? Math.cos(Math.PI * d) * (0.75 + 0.25 * Math.cos(Yy * u)) : Math.cos(Math.PI * u) * (0.75 + 0.25 * Math.cos(Yy * d));
    p = p * 1.5 + 1.4 * s.fbm(r * 24 + 9.1, l * 24 + 4.4, 3, 24) + 2 * s.fbm(r * 5 + 2.1, l * 5 + 7.7, 3, 5), e[i * o2 + a] = p;
  }
  VN(e, o2, 0.6, t, 2);
  let n = new THREE.DataTexture(t, o2, o2, THREE.RGBAFormat);
  return n.wrapS = n.wrapT = THREE.RepeatWrapping, n.repeat.set(4, 4), n.generateMipmaps = true, n.minFilter = THREE.LinearMipmapLinearFilter, n.magFilter = THREE.LinearFilter, n.anisotropy = 8, n.needsUpdate = true, Bk = n;
}
var Uk = [null, null, null];
function ut0(o2, t) {
  if (Uk[o2]) return Uk[o2];
  let e = 512, s = new Uint8Array(e * e * 4), n = _n(71 + o2 * 13), i = [t.camoA, t.camoB, t.camoC, t.camoD].map((h) => [h >> 16 & 255, h >> 8 & 255, h & 255]);
  for (let h = 0; h < e; h++) for (let f = 0; f < e; f++) {
    let u = f / e, d = h / e, m = n.fbm(u * 4 + 3.1, d * 4 + 8.2, 3, 4) - 0.5, p = n.fbm(u * 4 + 9.4, d * 4 + 2.6, 3, 4) - 0.5, x = n.fbm(u * 5 + m * 1.6, d * 9 + p * 1.6, 4, 0), g = n.fbm(u * 8 + 4.7 + p * 1.2, d * 13 + 1.3 + m * 1.2, 3, 0), b = n.fbm(u * 26 + 2.2, d * 34 + 6.1, 2, 0), v = i[0][0], y = i[0][1], M = i[0][2], w = (E, _) => {
      v += (E[0] - v) * _, y += (E[1] - y) * _, M += (E[2] - M) * _;
    };
    w(i[2], jy(0.565, 0.585, x)), w(i[3], jy(0.57, 0.59, g)), w(i[1], jy(0.435, 0.415, x)), w(i[1], jy(0.69, 0.71, b) * 0.9), w(i[2], jy(0.27, 0.25, b) * 0.8);
    let T = (h * e + f) * 4, S = 0.94 + 0.12 * n.fbm(u * 3 + 1.1, d * 3 + 5.5, 3, 3);
    s[T] = Math.min(255, v * S), s[T + 1] = Math.min(255, y * S), s[T + 2] = Math.min(255, M * S), s[T + 3] = Math.round(255 * Math.min(1, Math.max(0, 0.5 + 1.6 * (n.fbm(u * 9 + 7.7, d * 9 + 3.3, 4, 9) - 0.5))));
  }
  let a = 40, r = s.slice(), l = (h, f, u) => r[((f + e) % e * e + (h + e) % e) * 4 + u];
  for (let h = 0; h < e; h++) for (let f = 0; f < e; f++) {
    let u = f < a ? 0.5 * (1 - f / a) : f >= e - a ? 0.5 * (1 - (e - 1 - f) / a) : 0, d = h < a ? 0.5 * (1 - h / a) : h >= e - a ? 0.5 * (1 - (e - 1 - h) / a) : 0;
    if (!(u === 0 && d === 0)) for (let m = 0; m < 4; m++) {
      let p = l(f, h, m), x = l(e - 1 - f, h, m), g = l(f, e - 1 - h, m), b = l(e - 1 - f, e - 1 - h, m);
      s[(h * e + f) * 4 + m] = (p * (1 - u) + x * u) * (1 - d) + (g * (1 - u) + b * u) * d;
    }
  }
  let c = new THREE.DataTexture(s, e, e, THREE.RGBAFormat);
  return c.colorSpace = THREE.SRGBColorSpace, c.wrapS = c.wrapT = THREE.RepeatWrapping, c.repeat.set(1 / 0.44, 1 / 0.44), c.generateMipmaps = true, c.minFilter = THREE.LinearMipmapLinearFilter, c.magFilter = THREE.LinearFilter, c.anisotropy = 8, c.needsUpdate = true, Uk[o2] = c;
}
function Wk(o2) {
  return o2.onBeforeCompile = (t) => {
    if (t.uniforms.ghRim = o2.userData.rim, t.uniforms.ghFill = o2.userData.fill, o2.userData.fp) {
      let e = o2.userData.fp;
      t.uniforms.ghFpFill = e.fill, t.uniforms.ghFpRim = e.rim, t.uniforms.ghFpSky = e.sky, t.uniforms.ghFpGnd = e.gnd, t.uniforms.ghFpSun = e.sun;
    }
    t.vertexShader = t.vertexShader.replace("#include <common>", `#include <common>
attribute vec4 aux;
attribute vec3 aux2;
varying vec4 vAux;
varying vec3 vAux2;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vAux = aux; vAux2 = aux2;`), t.fragmentShader = t.fragmentShader.replace("#include <common>", `#include <common>
varying vec4 vAux;
varying vec3 vAux2;
uniform vec4 ghRim;
uniform vec3 ghFill;
#ifdef GH_FP
uniform vec3 ghFpFill, ghFpRim, ghFpSky, ghFpGnd;
uniform float ghFpSun;
#endif
vec3 ghCharacterFill( vec3 N, vec3 V, vec3 albedo, float ao ) {
  #ifdef GH_FP
    // the player's own body: the first-person rig of the weapon and sleeves (render/vmlight.js: over-the-shoulder key,
    // cool rim, hemisphere, all in camera space) at the levels that rig has this frame, so cloth meets cloth
    float f = saturate( dot( N, vec3( 0.332, 0.730, 0.597 ) ) ), r = saturate( dot( N, vec3( -0.684, 0.456, 0.570 ) ) );
    return albedo * ( ghFpFill * f + ghFpRim * r + mix( ghFpGnd, ghFpSky, 0.5 + 0.5 * N.y ) ) * RECIPROCAL_PI * mix( 1.0, ao, 0.8 );
  #endif
  float nv = saturate( dot( N, V ) );
  float up = 0.5 + 0.5 * inverseTransformDirection( N, viewMatrix ).y;
  return ( albedo * ghFill * ( 0.3 + 0.7 * nv ) * ( 0.55 + 0.45 * up ) + ghRim.rgb * pow( 1.0 - nv, ghRim.w ) * ( 0.35 + 0.65 * up ) ) * ao;
}`).replace("#include <map_fragment>", `
        float ghGrime = 0.5;
        #ifdef USE_MAP
          vec4 ghCamo = texture2D( map, vMapUv );
          diffuseColor.rgb *= mix( vec3( 1.0 ), ghCamo.rgb, vAux2.y );
          ghGrime = ghCamo.a;
        #endif
        diffuseColor.rgb *= mix( 1.0, vAux.w, 0.5 ) * mix( 0.9, 1.08, ghGrime );`).replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp( roughness * vAux.y * mix( 0.86, 1.12, ghGrime ), 0.04, 1.0 );").replace("#include <metalnessmap_fragment>", "float metalnessFactor = metalness * vAux.z;").replace("#include <normal_fragment_maps>", `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec4 ghN = texture2D( normalMap, vNormalMapUv );
          vec2 ghXY = ( mix( ghN.rg, ghN.ba, vAux2.z ) * 2.0 - 1.0 ) * normalScale * vAux2.x;
          normal = normalize( tbn * vec3( ghXY, sqrt( max( 1.0 - dot( ghXY, ghXY ), 0.05 ) ) ) );
        #endif`).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += vColor.rgb * vAux.x;`).replace("#include <aomap_fragment>", `
        #ifdef GH_FP
          reflectedLight.directDiffuse *= ghFpSun; reflectedLight.directSpecular *= ghFpSun;
        #endif
        reflectedLight.indirectDiffuse *= vAux.w;
        reflectedLight.indirectSpecular *= mix( 1.0, vAux.w, 0.85 );
        // character light: a soft camera-side fill and a cool sky rim keep operators readable in unlit rooms
        // (both are tiny next to real sunlight, so lit areas are unaffected)
        reflectedLight.indirectDiffuse += ghCharacterFill( normal, normalize( vViewPosition ), diffuseColor.rgb * ( 1.0 - metalnessFactor ), vAux.w );`);
  }, o2.customProgramCacheKey = () => "gh-operator-5", o2;
}
var qk = { value: new THREE.Vector3(0.34, 0.39, 0.43) }, Kk = { value: new THREE.Vector4(0.05, 0.064, 0.078, 2.8) }, dt0 = typeof document > "u", Vk = [null, null, null];
function makeNodeFlatTex(r, g, b, srgb = false) {
  const arr = new Uint8Array(16 * 16 * 4);
  for (let i = 0; i < 16 * 16 * 4; i += 4) {
    arr[i] = r; arr[i + 1] = g; arr[i + 2] = b; arr[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(arr, 16, 16, THREE.RGBAFormat);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}
function Xk(o2, t) {
  if (Vk[o2]) return Vk[o2];
  const e = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  if (dt0) {
    const c = t.camoA;
    e.map = makeNodeFlatTex((c >> 16) & 255, (c >> 8) & 255, c & 255, true);
    e.normalMap = makeNodeFlatTex(128, 128, 128, false);
  } else {
    e.map = ut0(o2, t);
    e.normalMap = ft0();
  }
  e.userData.rim = Kk;
  e.userData.fill = qk;
  Vk[o2] = Wk(e);
  return Vk[o2];
}
var Up = { fill: { value: new THREE.Vector3() }, rim: { value: new THREE.Vector3() }, sky: { value: new THREE.Vector3(0.05, 0.05, 0.05) }, gnd: { value: new THREE.Vector3(0.03, 0.03, 0.03) }, sun: { value: 1 } }, Gk = [null, null, null];
function GN(o2, t) {
  if (Gk[o2]) return Gk[o2];
  let e = Xk(o2, t), s = e.clone();
  return s.userData.rim = e.userData.rim, s.userData.fill = e.userData.fill, s.userData.fp = Up, s.defines = { ...s.defines || {}, GH_FP: 1 }, Gk[o2] = Wk(s);
}
function WN(o2) {
  let t = o2.clone();
  return t.userData.rim = o2.userData.rim, t.userData.fill = o2.userData.fill, t.transparent = true, t.depthWrite = true, Wk(t);
}
var ba = fs, Ji = THREE.Vector3, Yk = 0.4, jk = 0.26, $k = 0.945, qN = 0.5, pt0 = 0.565, t7 = mh - ey, sC = [0, 0.5, 1, 1.4, 1.8, 2.4, 3, 3.6, 4.5, 5.5, 6.5, 8], jN = [0.66, 0.64, 0.6, 0.56, 0.48, 0.4, 0.345, 0.305, 0.26, 0.228, 0.205, 0.18], $N = [0.75, 0.85, 1.05, 1.28, 1.42, 1.5, 1.54, 1.58, 1.64, 1.74, 1.86, 2.05], R2 = [0.6, 1.4, 2.4, 4.5, 6.5], ZN = [0.17, 0.2, 0.28, 0.4, 0.5], QN = [0.125, 0.135, 0.2, 0.31, 0.39], JN = [0.11, 0.115, 0.15, 0.195, 0.235], tB = [0.02, 0.04, 0.055, 0.07, 0.085], eB = [0.1, 0.1, 0.02, -0.03, -0.04], sB = [0.03, 0.03, 0.03, 0.04, 0.08], nB = [0.2, 0.26, 0.16, 0.08, -0.05], oB = [0.6, 0.8, 0.95, 1.08, 1.15], mt0 = [0.908, 0.905, 0.915, 0.93, 0.925], iB = [0.47, 0.46, 0.36, 0.3, 0.27];
function G1(o2, t, e) {
  if (e <= o2[0]) return t[0];
  for (let s = 1; s < o2.length; s++) if (e <= o2[s]) return t[s - 1] + (t[s] - t[s - 1]) * (e - o2[s - 1]) / (o2[s] - o2[s - 1]);
  return t[t.length - 1];
}
var Ao = (o2) => (o2 = o2 < 0 ? 0 : o2 > 1 ? 1 : o2, o2 * o2 * (3 - 2 * o2)), Vp = [0, 0.3, 0.55, 0.84, 1], Zk = [null, null, null], Qk = null;
function aB(o2) {
  if (Zk[o2]) return Zk[o2];
  let t = new gE(), e = t4[o2];
  TH(t, e), UN(t, e), t.bakeAO();
  let s = t.idx.length;
  BN(t, e);
  let n = t.build();
  return n.setDrawRange(0, s), n.userData.triangles = s / 3, Zk[o2] = n;
}
function gt0() {
  return Qk || (Qk = PE().map((o2) => o2.clone().invert())), Qk;
}
var On = new Ji(0, 1, 0), Jk = new Ji(1, 1, 1), xt0 = new THREE.Matrix4(), Me = () => new Ji(), At = { fwd: Me(), right: Me(), pf: Me(), pr: Me(), D: Me(), aimUp: Me(), velDir: Me(), lat: Me(), home: Me(), base: Me(), lean: Me(), spine: Me(), nd: Me(), hd: Me(), m: Me(), mr: Me(), F: Me(), Rv: Me(), cdir: Me(), ndir: Me(), hdir: Me(), sh: Me(), hip: Me(), mid: Me(), dirT: Me(), SL: Me(), SR: Me(), HL: Me(), HR: Me(), kL: Me(), kR: Me(), fL: Me(), fR: Me(), eL: Me(), eR: Me(), wL: Me(), wR: Me(), pocket: Me(), Ga: Me(), Gs: Me(), gx: Me(), gy: Me(), gz: Me(), cu: Me(), cfw: Me(), pole: Me(), mag: Me(), pouch: Me(), palmL: Me(), palmR: Me(), a0: Me(), a1: Me(), v0: Me(), v1: Me(), v2: Me(), eye: Me() }, Rf = Me(), W5 = Me(), Yu = new THREE.Quaternion(), Gp = new THREE.Quaternion(), K4 = new THREE.Quaternion(), X5 = new THREE.Matrix4(), Qr = [0, 0], $y = [0, 0, 0], KN = new THREE.Box3(), XN = () => typeof performance < "u" ? performance.now() : Date.now(), e7 = { ar: { imp: 42, back: 0.032, rise: 0.045, sh: 0.01, rock: 0.35, pump: false }, smg: { imp: 30, back: 0.02, rise: 0.03, sh: 6e-3, rock: 0.2, pump: false }, shotgun: { imp: 78, back: 0.05, rise: 0.1, sh: 0.022, rock: 2.2, pump: true }, pistol: { imp: 46, back: 0.02, rise: 0.15, sh: 4e-3, rock: 0.25, pump: false } }, tC = [Ve.head, Ve.hand, Ve.hand + 7, Ve.foot, Ve.foot + 7, Ve.toe, Ve.toe + 7];
function Qy() {
  return { P: Me(), C: Me(), N: Me(), H: Me(), sh: Me(), hip: Me(), AL: Me(), AR: Me(), KL: Me(), KR: Me() };
}
var Wp = ["P", "C", "N", "H", "sh", "hip", "AL", "AR", "KL", "KR"], bt0 = Qy(), yt0 = Qy(), vt0 = Qy(), Mt0 = Qy(), wt0 = Qy();
function A2(o2, t) {
  let e = o2.lengthSq();
  return e < 1e-10 ? o2.copy(t) : o2.multiplyScalar(1 / Math.sqrt(e));
}
function nC(o2, t, e) {
  return o2.addScaledVector(t, -o2.dot(t)), o2.lengthSq() < 1e-6 && (o2.copy(e).addScaledVector(t, -e.dot(t)), o2.lengthSq() < 1e-6 && (o2.set(1, 0, 0).addScaledVector(t, -t.x), o2.lengthSq() < 1e-6 && o2.set(0, 0, 1).addScaledVector(t, -t.z))), o2.normalize();
}
function Zy(o2, t, e, s, n, i, a, r, l = 0) {
  Rf.subVectors(t, o2);
  let c = Rf.length();
  c < 1e-5 ? (Rf.set(0, -1, 0), c = 1e-5) : Rf.multiplyScalar(1 / c);
  let h = Zt(c, Math.max(Math.abs(e - s) + 0.03, (e + s) * l), (e + s) * r), f = (e * e - s * s + h * h) / (2 * h), u = Math.sqrt(Math.max(e * e - f * f, 0));
  W5.copy(n).addScaledVector(Rf, -n.dot(Rf)), W5.lengthSq() < 1e-8 && (W5.set(Rf.y, -Rf.x, 0), W5.lengthSq() < 1e-8 && W5.set(0, 0, 1)), W5.normalize(), i.copy(o2).addScaledVector(Rf, f).addScaledVector(W5, u), a.copy(o2).addScaledVector(Rf, h);
}
function $l(o2, t, e) {
  let s = t * 3;
  o2[s] = e.x, o2[s + 1] = e.y, o2[s + 2] = e.z;
}
function q5(o2, t, e, s) {
  return X5.makeBasis(t, e, s), o2.setFromRotationMatrix(X5);
}
function K5(o2, t) {
  if (o2 >= 0) {
    let e = Math.cos(o2), s = Math.sin(o2);
    t[0] = -Qg + Qg * e - Sn * s, t[1] = Qg * s + Sn * e;
  } else {
    let e = Math.cos(o2), s = -Math.sin(o2);
    t[0] = u2 - u2 * e + Sn * s, t[1] = u2 * s + Sn * e;
  }
  return t;
}
function s7(o2, t, e, s, n) {
  let i = 0;
  for (; i < 3 && s > Vp[i + 1]; ) i++;
  let a = Vp[i + 1] - Vp[i], r = (s - Vp[i]) / a, l = r * r, c = l * r, h = i === 0 ? t : (o2[i + 1] - o2[i - 1]) / (Vp[i + 1] - Vp[i - 1]), f = i === 3 ? e : (o2[i + 2] - o2[i]) / (Vp[i + 2] - Vp[i]);
  return n !== void 0 && (i === 3 ? h = n : i === 2 && (f = n)), (2 * c - 3 * l + 1) * o2[i] + (c - 2 * l + r) * h * a + (-2 * c + 3 * l) * o2[i + 1] + (c - l) * f * a;
}
var YN = () => ({ mode: 0, plant: Me(), dir: new Ji(0, 0, -1), pitch: 0, toe: 0, ankle: Me(), off: Me(), u0: 0, pitchOff: 0, dir0: new Ji(0, 0, -1), gy0: 0, from: Me(), to: Me(), fromPitch: 0, t: 1, dur: 0.2, lift: 0.06, k0: 0, pitch0: 0, rel: Me(), prevA: Me(), bo: Me(), X: new Float32Array(5), Y: new Float32Array(5), Pk: new Float32Array(5), mx0: 0, my0: 0, mx1: 0, my1: 0, l0: 0, l1: 0, stance: false, ext: 0, knee: 0, k: 0 }), oC = class {
  constructor({ team: t = 0, gunFactory: e = null, ground: s = null, seed: seedVal = 1 } = {}) {
    this.ground = s, this.team = Math.max(0, Math.min(2, t | 0)), this._seed = seedVal, this.gunFactory = e, this.root = new THREE.Group(), this.root.name = "operator", this.joints = new Float32Array(48), this.bones = pH, this.JOINT_RADIUS = mH, this.hit = [{ part: "head", a: Me(), b: Me(), r: 0.13 }, { part: "torso", a: Me(), b: Me(), r: 0.24 }, { part: "legs", a: Me(), b: Me(), r: 0.2 }], this._mat = Xk(this.team, t4[this.team]), this._fadeMat = null, this._opacity = 1, this._mats = [], this._bones = [];
    for (let i = 0; i < kE; i++) {
      this._mats.push(new THREE.Matrix4());
      let a = new THREE.Bone();
      a.matrixAutoUpdate = false, this.root.add(a), this._bones.push(a);
    }
    let n = this.body = new THREE.SkinnedMesh(aB(this.team), this._mat);
    n.name = "body", n.castShadow = true, n.receiveShadow = true, n.frustumCulled = false, n.matrixAutoUpdate = false, n.bind(new THREE.Skeleton(this._bones, gt0().map((i) => i.clone())), xt0), this.root.add(n), this.triangles = n.geometry.userData.triangles, this.gun = null, this.weaponId = null, this.gunPos = Me(), this.gunQuat = new THREE.Quaternion(), this._gripR = new Ji(0.017, -0.04, 0.012), this._gripL = new Ji(-0.03, 0.01, -0.3), this._muzzle = new Ji(0, 0.04, -0.6), this._gripRq = new THREE.Quaternion(), this._gripLq = new THREE.Quaternion(), this._sight = new Ji(0, 0.11, -0.05), this._stock = 0.28, this._pistol = false, this.jointVel = new Float32Array(48), this._pj = new Float32Array(48), this._pjOk = false, this._yo = 0, this._py = 0, this.wEngage = 1, this._hy = 0, this._hp = 0, this._br = ((this._seed * 1.6180339) % 1) * 6, this._exert = 0, this._pumpT = -1, this._throwT = -1, this._airT = 0, this._aimX = 0, this._aimZ = -1, this._peak = 0, this._resOn = 0, this._res = { t0: 0, q: [], p: [], last: [] };
    for (let i = 0; i < 7; i++) this._res.q.push(new THREE.Quaternion()), this._res.p.push(Me()), this._res.last.push(new THREE.Matrix4());
    this._defaultGrips(), this._hint = { headFwd: new Ji(0, 0, -1), headUp: new Ji(0, 1, 0), handQ: [new THREE.Quaternion(), new THREE.Quaternion()], handP: [Me(), Me()], handW: [0, 0], footF: [new Ji(0, 0, -1), new Ji(0, 0, -1)], footU: [new Ji(0, 1, 0), new Ji(0, 1, 0)], footW: 0, toeBend: [0, 0], magM: null }, this._magM = new THREE.Matrix4(), this.time = ((this._seed * 2.7182818) % 1) * 10, this._live = false, this._hinted = false, this._wasDP = false, this._wasAir = false, this._prev = Me(), this.vel = Me(), this.acc = Me(), this.off = jk, this.back = false, this.phase = 0, this.gaitOn = false, this.stepCool = 0, this.feet = [YN(), YN()], this.wCrouch = 0, this.wSlide = 0, this.wDive = 0, this.wProne = 0, this.wSprint = 0, this.wAir = 0, this.wReload = 0, this.wMove = 0, this.reloadT = 0, this.axis = new Ji(0, 0, -1), this._kick = { x: 0, v: 0 }, this._land = { x: 0, v: 0 }, this.drop = 0, this.vy = 0, this._leanX = { x: 0, v: 0 }, this._leanZ = { x: 0, v: 0 }, this._flX = { x: 0, v: 0 }, this._flZ = { x: 0, v: 0 }, this._flT = { x: 0, v: 0 }, this._shift = 0, this._ground = 0, this._pvd = new Ji(0, 0, -1), this._warp = -1, this.g = { duty: 0.6, f: 1, Lc: 0.5, xl: 0.2, thHS: 0.2, phO: 0.8, k1: 0.2, k2: 0.5, ya: 0.2, yb: 0.13, yc: 0.11, re: 0.04, xa: 0.1, xb: 0.03, rk: 0, dsw: 0.5, moveK: 0 };
    for (let i = 0; i < 16; i++) this.joints[i * 3] = nf[i][0], this.joints[i * 3 + 1] = nf[i][1], this.joints[i * 3 + 2] = nf[i][2];
    this.renderFromJoints();
  }
  _defaultGrips() {
    let t = new Ji(0, -0.37, -0.93).normalize(), e = new Ji(-1, 0, 0), s = new Ji().crossVectors(t, e);
    q5(this._gripRq, s, t, e);
    let n = new Ji(0.62, 0, -0.78).normalize(), i = new Ji(0.25, 0.97, 0);
    i.addScaledVector(n, -i.dot(n)).normalize(), q5(this._gripLq, new Ji().crossVectors(n, i), n, i);
  }
  setWeapon(t) {
    if (this.gun && (this._restoreGunMaterials(), this.root.remove(this.gun.root), this.gun = null), this.weaponId = t, !this.gunFactory) return;
    let e = this.gunFactory(t);
    if (!e || !e.root) return;
    e.root.position.set(0, 0, 0), e.root.quaternion.identity(), e.root.scale.set(1, 1, 1), e.root.updateMatrix(), e.root.updateMatrixWorld(true), KN.setFromObject(e.root), this._stock = Zt(KN.max.z, 0.22, 0.34), this.root.add(e.root), e.root.updateWorldMatrix(true, true);
    let s = e.anchors || {};
    this._defaultGrips();
    let n = X5.copy(e.root.matrixWorld).invert(), i = e.root.getWorldQuaternion(K4).invert(), a = false;
    if (s.gripR) {
      s.gripR.getWorldPosition(this._gripR).applyMatrix4(n);
      let r = s.gripR.quaternion;
      Math.abs(r.lengthSq() - 1) < 1e-3 && Math.abs(r.w) < 0.9999 && this._gripRq.copy(r);
    }
    if (s.gripL) {
      s.gripL.getWorldPosition(this._gripL).applyMatrix4(n);
      let r = s.gripL.quaternion;
      Math.abs(r.lengthSq() - 1) < 1e-3 && Math.abs(r.w) < 0.9999 && (this._gripLq.copy(r), a = true);
    }
    if (s.muzzle && this._muzzle.copy(s.muzzle), s.sight ? this._sight.copy(s.sight) : this._sight.set(0, 0.11, -0.05), this._pistol = this._gripL.distanceTo(this._gripR) < 0.12, this._pistol && !a) {
      let r = At.v0.set(0, -0.68, -0.73).normalize(), l = At.v1.set(1, 0, 0);
      l.addScaledVector(r, -l.dot(r)).normalize(), q5(this._gripLq, At.v2.crossVectors(r, l), r, l);
    }
    e.root.matrixAutoUpdate = false, e.root.traverse((r) => {
      r.isMesh && (r.castShadow = true);
    }), this.gun = e, this._placeGun(), this._opacity < 1 && this.setOpacity(this._opacity);
  }
  dropWeapon() {
    let t = this.gun;
    return t ? (this._restoreGunMaterials(), this.root.remove(t.root), t.root.matrixAutoUpdate = true, t.root.position.copy(this.gunPos), t.root.quaternion.copy(this.gunQuat), t.root.scale.set(1, 1, 1), t.root.updateMatrix(), this.gun = null, t.root) : null;
  }
  _placeGun() {
    if (!this.gun) return;
    let t = this.gun.root;
    t.matrix.compose(this.gunPos, this.gunQuat, Jk), t.matrixWorldNeedsUpdate = true;
  }
  kick() {
    let t = e7[this.weaponId] || e7.ar;
    this._kick.v = Math.min(this._kick.v + t.imp, t.imp * 1.7), this._flX.v -= this._aimX * t.rock, this._flZ.v -= this._aimZ * t.rock, t.pump && (this._pumpT = 0);
  }
  throwGrenade() {
    return this._throwT < 0 && (this._throwT = 0), 0.3;
  }
  flinch(t, e = 1) {
    let s = Zt(e, 0, 2) * 5.5, n = 0, i = 0;
    if (t) {
      let a = Math.hypot(t.x, t.z);
      a > 1e-4 && (n = t.x / a, i = t.z / a);
    }
    if (n === 0 && i === 0) {
      let a = ((this.time * 12.9898) % 1) * Vt;
      n = Math.cos(a), i = Math.sin(a);
    }
    this._flX.v += n * s, this._flZ.v += i * s, this._flT.v += (((this.time * 78.233) % 1) < 0.5 ? -1 : 1) * s * 0.8;
  }
  reset() {
    this._live = false, this._wasDP = false, this._wasAir = false, this.wCrouch = this.wSlide = this.wDive = this.wProne = this.wSprint = this.wAir = this.wReload = this.wMove = 0, this._pumpT = this._throwT = -1, this._yo = 0, this._hy = this._hp = 0, this._resOn = 0, this._pjOk = false, this.wEngage = 1, this._exert = 0, this.reloadT = 0, this.drop = 0, this._kick.x = this._kick.v = 0, this._land.x = this._land.v = 0, this._leanX.x = this._leanX.v = this._leanZ.x = this._leanZ.v = 0, this._flX.x = this._flX.v = this._flZ.x = this._flZ.v = this._flT.x = this._flT.v = 0, this._shift = 0;
  }
  getMuzzle(t) {
    return t.copy(this._muzzle).applyQuaternion(this.gunQuat).add(this.gunPos);
  }
  getHead(t) {
    return Wr(this.joints, ba.head, t);
  }
  setOpacity(t) {
    if (t = Zt(t, 0, 1), this._opacity = t, t >= 1) {
      this.body.material = this._mat, this._restoreGunMaterials();
      return;
    }
    this._fadeMat || (this._fadeMat = WN(this._mat)), this._fadeMat.opacity = t, this.body.material = this._fadeMat, this.gun && this.gun.root.traverse((e) => {
      !e.isMesh || Array.isArray(e.material) || (e.userData._ghSolid || (e.userData._ghSolid = e.material, e.material = e.material.clone(), e.material.transparent = true), e.material.opacity = t);
    });
  }
  _restoreGunMaterials() {
    this.gun && this.gun.root.traverse((t) => {
      t.isMesh && t.userData._ghSolid && (t.material.dispose(), t.material = t.userData._ghSolid, delete t.userData._ghSolid);
    });
  }
  dispose() {
    this._restoreGunMaterials(), this.root.parent && this.root.parent.remove(this.root), this._fadeMat && (this._fadeMat.dispose(), this._fadeMat = null), this.body.skeleton.dispose(), this.gun = null;
  }
  _gy(t, e, s) {
    if (!this.ground) return s;
    let n = this.ground(t, e, s + 0.5);
    return n > s - 0.7 && n < s + 0.52 ? n : s;
  }
  _homeFoot(t, e, s, n, i, a) {
    let r = t ? 1 : -1, l = t ? Ht(-0.12, -0.22, i) : Ht(0.13, 0.2, i);
    return a.copy(e).addScaledVector(n, r * Ht(0.15, 0.17, i)).addScaledVector(s, l);
  }
  _teleport(t, e, s) {
    let n = t.speed || 0;
    this._prev.copy(t.pos), this.vel.set(0, 0, 0).addScaledVector(e, -(t.moveZ || 0) * n).addScaledVector(s, (t.moveX || 0) * n), this.acc.set(0, 0, 0), this.vy = 0, this.gaitOn = false, this.back = false, this.off = jk, this.drop = 0;
    let i = Math.cos(this.off), a = Math.sin(this.off);
    At.pf.copy(e).multiplyScalar(i).addScaledVector(s, a), At.pr.copy(s).multiplyScalar(i).addScaledVector(e, -a);
    for (let r = 0; r < 2; r++) {
      let l = this.feet[r];
      this._homeFoot(r, t.pos, At.pf, At.pr, t.stance === "crouch" ? 1 : 0, l.plant), l.dir.copy(At.pf), l.mode = 0, l.pitch = 0, l.toe = 0, l.t = 1, l.plant.y = this._gy(l.plant.x, l.plant.z, t.pos.y), l.ankle.copy(l.plant), l.ankle.y += Sn;
    }
    this.axis.copy(e), this._live = true;
  }
  _gaitParams(t, e, s, n, i) {
    let a = this.g, r = G1(sC, jN, t), l = G1(sC, $N, t);
    e > 1e-3 && (r = Ht(r, Math.max(r, 0.54), e), l *= 1 + 0.1 * e), l *= 1 + 0.26 * n + 0.45 * i, a.duty = r, a.f = l, a.Lc = t * r / l, a.dsw = t * (1 - r) / l, a.rk = Fo(0.53, 0.4, r), a.moveK = Fo(0.3, 1.2, t);
    let c = (1 - 0.45 * e) * (1 - 0.4 * n);
    return a.xl = a.Lc * (G1(R2, iB, t) + 0.25 * n + 0.12 * i), a.thHS = G1(R2, nB, t) * a.moveK, a.phO = G1(R2, oB, t) * a.moveK * (1 - 0.25 * e), a.k1 = Ht(0.2, 0.14, a.rk), a.k2 = Ht(0.52, 0.34, a.rk), a.ya = G1(R2, ZN, t) * c + 0.05 * s, a.yb = G1(R2, QN, t) * c + 0.04 * s, a.yc = G1(R2, JN, t) * c, a.re = G1(R2, tB, t) * (1 - 0.6 * n), a.xa = G1(R2, eB, t), a.xb = G1(R2, sB, t), a;
  }
  _stPitch(t, e) {
    let s = this.g, n = e > 0 ? e : 0, i = e < 0 ? -e : 0, a = s.thHS * n - 0.24 * i * s.moveK;
    return t < s.k1 ? a * (1 - Ao(t / s.k1)) : t < s.k2 ? 0 : -s.phO * Ht(0.4, 1, n) * Math.pow((t - s.k2) / (1 - s.k2), 1.6);
  }
  _buildSwing(t, e, s) {
    let n = this.g, i = 0.02, a = (1 - n.duty) / n.duty, r = this._stPitch(1, e), l = this._stPitch(1 - i, e), c = this._stPitch(0, e), h = this._stPitch(i, e);
    K5(r, Qr);
    let f = Qr[0], u = Qr[1];
    K5(l, Qr);
    let d = Qr[0], m = Qr[1];
    K5(c, Qr);
    let p = Qr[0], x = Qr[1];
    K5(h, Qr);
    let g = Qr[0], b = Qr[1], v = n.xl - n.Lc, y = v + f * e, M = u, w = n.xl + p * e, T = x;
    t.mx0 = Math.max((y - (v + n.Lc * i + d * e)) / i * a, -0.9), t.my0 = (u - m) / i * a, t.mx1 = (n.xl - n.Lc * i + g * e - w) / i * a * 0.55, t.my1 = (b - x) / i * a - 0.25;
    let S = Math.max(e, 0);
    t.X[0] = y, t.Y[0] = M, t.X[1] = y + n.xa * Ht(0.4, 1, S) + 0.06 * (1 - S), t.Y[1] = Math.max(n.ya * Ht(0.55, 1, S), M + 0.025), t.X[2] = n.xb, t.Y[2] = Math.max(n.yb * Ht(0.6, 1, S), Sn + 0.03), t.X[3] = w + n.re * Ht(0.3, 1, S), t.Y[3] = Math.max(n.yc * Ht(0.75, 1, S), T + 0.015), t.X[4] = w, t.Y[4] = T, t.Pk[0] = r, t.Pk[1] = r - (0.1 + 0.25 * n.rk) * S, t.Pk[2] = Ht(-0.15, -0.6, n.rk) * Ht(0.3, 1, S), t.Pk[3] = Ht(c + 0.03, -0.1, n.rk * S), t.Pk[4] = c, t.l0 = f * s, t.l1 = p * s;
  }
  _evalSwing(t, e, s) {
    return s[0] = s7(t.X, t.mx0, t.mx1, e, 0), s[1] = s7(t.Y, t.my0, t.my1, e), s[2] = s7(t.Pk, 0, 0, e), s;
  }
  update(t, e) {
    if (!e || e.dead || !e.pos) return;
    t = Zt(t, 1e-4, 0.05), this.time += t;
    let s = this.wEngage = Ee(this.wEngage, e.engage === void 0 || e.engage ? 1 : 0, 6, t);
    this._pumpT >= 0 && (this._pumpT += t, this._pumpT > 0.62 && (this._pumpT = -1)), this._throwT >= 0 && (this._throwT += t, this._throwT > 0.85 && (this._throwT = -1));
    let n = e.pos, i = e.yaw || 0, a = Zt(e.pitch || 0, -1.45, 1.45), r = e.stance || "stand", l = Math.sin(i), c = Math.cos(i), h = At.fwd.set(-l, 0, -c), f = At.right.set(c, 0, -l);
    (!this._live || n.distanceToSquared(this._prev) > 2.25) && (this._teleport(e, h, f), this._yo = 0, this._py = n.y, this._pjOk = false);
    {
      let z0 = n.y - this._py;
      this._py = n.y, !e.airborne && !this._wasAir && Math.abs(z0) > 0.03 && Math.abs(z0) < 0.6 && (this._yo = Zt(this._yo - z0, -0.45, 0.45)), this._yo = Ee(this._yo, 0, this._yo > 0 ? 16 : 10, t);
    }
    this._ground = n.y;
    let u = this.vel, d = (n.x - this._prev.x) / t, m = (n.z - this._prev.z) / t, p = Zt((n.y - this._prev.y) / t, -14, 14);
    this.vy = Ee(this.vy, p, 14, t), this._prev.copy(n);
    let x = u.x, g = u.z, b = 1 - Math.exp(-22 * t);
    u.x += (d - u.x) * b, u.z += (m - u.z) * b;
    let v = 1 - Math.exp(-7 * t);
    this.acc.x += (Zt((u.x - x) / t, -30, 30) - this.acc.x) * v, this.acc.z += (Zt((u.z - g) / t, -30, 30) - this.acc.z) * v;
    let y = Math.hypot(u.x, u.z);
    this._peak = Math.max(y, Ee(this._peak, y, 6, t));
    let M = r !== "dive" && r !== "prone" && r !== "slide", w = !!e.airborne && M, T = this.wAir = Ee(this.wAir, w ? 1 : 0, w ? 14 : 18, t), S = this.wCrouch = Ee(this.wCrouch, r === "crouch" ? 1 : 0, 11, t), E = this.wSprint = Ee(this.wSprint, e.sprint && r === "stand" && y > 2.5 ? 1 : 0, 8, t);
    this.wSlide = Ee(this.wSlide, r === "slide" ? 1 : 0, 13, t), this.wDive = Ee(this.wDive, r === "dive" ? 1 : 0, 13, t), this.wProne = Ee(this.wProne, r === "prone" ? 1 : 0, 10, t);
    let _ = this.wReload = Ee(this.wReload, e.reloading ? 1 : 0, 9, t);
    e.reloading ? this.reloadT += t : _ < 0.02 && (this.reloadT = 0), this._exert = Ee(this._exert, E > 0.5 ? 1 : 0, E > 0.5 ? 0.45 : 0.16, t), this._br += (1.9 + 2.6 * this._exert) * t;
    let R = this.wSlide, C = this.wDive, L = this.wProne, A = R + C + L;
    A > 1 && (R /= A, C /= A, L /= A, A = 1);
    let O = 1 - A, H = u.x * h.x + u.z * h.z, F = u.x * f.x + u.z * f.z, P = this.wMove = Fo(0.4, 1.4, y), z = Fo(2, 4, y), k = jk * (1 - E);
    if (y > 0.5) {
      let z0 = Math.atan2(F, H), I0 = Math.abs(z0);
      this.back ? I0 < 1.75 && (this.back = false) : I0 > 2.05 && (this.back = true);
      let vt = Ht(0.72, 1.35, E), wt = this.back ? Zt(E1(Math.PI, z0), -0.72, 0.72) : Zt(z0, -vt, vt);
      k = Ht(k, wt, P);
    } else this.back = false;
    this.off = Fm(this.off, k, 9, t);
    let I = Math.cos(this.off), G = Math.sin(this.off), K = At.pf.copy(h).multiplyScalar(I).addScaledVector(f, G), $ = At.pr.copy(f).multiplyScalar(I).addScaledVector(h, -G), n0 = At.velDir;
    y > 0.05 ? n0.set(u.x / y, 0, u.z / y) : n0.copy(K);
    let e0 = At.lat.set(-n0.z, 0, n0.x), p0 = this.back ? P : 0, t0 = Math.cos(a), M0 = Math.sin(a), f0 = At.D.copy(h).multiplyScalar(t0).addScaledVector(On, M0), _0 = At.aimUp.crossVectors(f, f0), F0 = r === "dive" || r === "prone";
    e.axis ? this.axis.copy(e.axis) : F0 && !this._wasDP ? this.axis.copy(y > 0.8 ? n0 : h) : r === "dive" && y > 1.5 && (At.v0.copy(this.axis).lerp(n0, 1 - Math.exp(-6 * t)), At.v0.lengthSq() > 1e-4 && this.axis.copy(At.v0).normalize()), this._wasDP = F0;
    let m0 = P * (1 - Math.abs(K.dot(n0))), S0 = this._gaitParams(y, S, E, p0, m0), T0 = S0.duty, j0 = O > 0.5 && !w, Z0 = this.feet;
    if (w && !this._wasAir) {
      for (let z0 = 0; z0 < 2; z0++) {
        let I0 = Z0[z0];
        I0.rel.subVectors(I0.ankle, n), I0.mode = 0;
      }
      this.gaitOn = false, this._airT = 0;
    }
    if (w && (this._airT += t), !w && this._wasAir) {
      this._land.v -= Zt(-this.vy, 0, 11) * 0.5 + 0.3;
      for (let z0 = 0; z0 < 2; z0++) {
        let I0 = Z0[z0], vt = this._gy(I0.ankle.x, I0.ankle.z, n.y);
        I0.mode = 3, I0.from.copy(I0.ankle), I0.fromPitch = I0.pitch, I0.t = 0, I0.dur = 0.07, I0.lift = 0, I0.bo.set(0, 0, 0), I0.to.set(I0.ankle.x, vt + Sn, I0.ankle.z), I0.plant.set(I0.ankle.x, vt, I0.ankle.z);
      }
    }
    this._wasAir = w;
    let lt = this.gaitOn, H0 = this._pvd.dot(n0) < 0.9;
    if (this._pvd.copy(n0), j0 && y > (this.gaitOn ? 0.3 : 0.5)) {
      if (!this.gaitOn) {
        H0 = true;
        let z0 = (Z0[0].ankle.x - n.x) * n0.x + (Z0[0].ankle.z - n.z) * n0.z, I0 = (Z0[1].ankle.x - n.x) * n0.x + (Z0[1].ankle.z - n.z) * n0.z, vt = 0.25 * T0;
        this.phase = z0 < I0 ? (vt + 0.5) % 1 : vt, this.gaitOn = true;
      }
      if (this.phase = (this.phase + S0.f * t) % 1, this._warp >= 0) {
        let z0 = (this.phase + this._warp * 0.5) % 1;
        z0 < T0 && (this.phase = (this.phase + T0 - z0 + 2e-3) % 1, H0 = true);
      }
    } else this.gaitOn = false;
    lt && !this.gaitOn && j0 && (this._land.v -= Math.min(0.9, 0.17 * this._peak)), this._warp = -1, this.stepCool -= t;
    let Y0 = Ht(0.14, 0.05, P), et = $.dot(e0), ct = $.dot(n0), D0 = Ht(0.105, 0.072, S0.rk), u0 = (et < 0 ? -1 : 1) * Math.max(Math.abs(et), 0.068 / D0), w0 = At.home, P0 = At.base, st = At.dirT;
    for (let z0 = 0; z0 < 2; z0++) {
      let I0 = Z0[z0], vt = Z0[1 - z0], wt = z0 ? 1 : -1;
      {
        let J = Math.cos(Y0 * wt), Q = Math.sin(Y0 * wt);
        st.copy(K).multiplyScalar(J).addScaledVector($, Q);
      }
      this._homeFoot(z0, n, K, $, S, w0), w0.y = this._gy(w0.x, w0.z, n.y), I0.stance = false;
      let _t = I0.ankle.x, Pt = I0.ankle.y, bt = I0.ankle.z;
      if (!j0) {
        if (w) {
          let J = Fo(-2.5, 1.5, this.vy), Q = 1 - Ao(this._airT / 0.15), i0 = z0 === 0;
          At.a0.copy($).multiplyScalar(wt * 0.11).addScaledVector(K, i0 ? Ht(0.1, 0.2, J) : Ht(-0.04, -0.22, J)), At.a0.y = Sn + (i0 ? Ht(0.07, 0.34, J) : Ht(0.05, 0.3, J)), At.a0.y = Ht(At.a0.y, Sn + 0.03, Q), At.a0.addScaledVector(K, -0.12 * Q * (i0 ? 0.5 : 1)), I0.rel.lerp(At.a0, 1 - Math.exp(-(12 + 10 * Q) * t)), I0.ankle.copy(n).add(I0.rel), I0.pitch = Ee(I0.pitch, Ht(Ht(-0.1, -0.55, J), -0.95, Q), 14, t), I0.toe = 0, I0.dir.lerp(st, 1 - Math.exp(-10 * t)), A2(I0.dir, st);
        } else I0.plant.copy(w0), I0.dir.copy(K), I0.mode = 0, I0.pitch = 0, I0.toe = 0, I0.t = 1, I0.ankle.copy(w0), I0.ankle.y += Sn;
        I0.prevA.set(_t, Pt, bt);
        continue;
      }
      let Et = (this.phase + z0 * 0.5) % 1, zt = I0.mode === 3;
      if (this.gaitOn && !(zt && Et < T0)) {
        let J = st.dot(n0), Q = st.dot(e0);
        if (P0.copy(n).addScaledVector(e0, wt * D0 * u0).addScaledVector(n0, wt * Pi * ct), Et < T0) {
          let i0 = Et / T0;
          I0.mode !== 1 && (I0.mode === 2 && (I0.plant.copy(P0).addScaledVector(n0, S0.xl - S0.Lc * i0), I0.plant.y = this._gy(I0.plant.x, I0.plant.z, n.y), I0.dir.copy(st)), I0.mode = 1, I0.k0 = i0, I0.pitch0 = I0.pitch);
          let A0 = this._stPitch(i0, I0.dir.dot(n0));
          I0.k0 > 0.02 && (A0 = Ht(I0.pitch0, A0, Ao((i0 - I0.k0) / Math.max(1 - I0.k0, 0.05) * 3))), I0.pitch = A0, I0.toe = A0 < 0 ? Math.min(-A0, 0.95) : 0, I0.k = i0, K5(A0, Qr), I0.ankle.copy(I0.plant).addScaledVector(I0.dir, Qr[0]), I0.ankle.y += Qr[1], I0.stance = true;
        } else {
          let i0 = (Et - T0) / (1 - T0);
          this._buildSwing(I0, J, Q), this._evalSwing(I0, i0, $y);
          let A0 = I0.mode !== 2;
          A0 && (I0.mode = 2, I0.dir0.copy(I0.dir), I0.gy0 = I0.plant.y);
          let N0 = this._gy(P0.x + n0.x * S0.xl, P0.z + n0.z * S0.xl, n.y), mt = Ht(I0.gy0, N0, Ao(i0 * 1.3)) + 0.55 * Math.abs(N0 - I0.gy0) * Math.sin(Math.PI * Math.min(i0 * 1.15, 1)), xt = Ht(I0.l0, I0.l1, Ao(i0));
          At.v0.copy(P0).addScaledVector(n0, $y[0]).addScaledVector(e0, xt), At.v0.y = mt + $y[1];
          let yt = 1 - Ao((i0 - I0.u0) / Math.max(Math.min(0.5, 0.92 - I0.u0), 0.04));
          At.v1.copy(At.v0).addScaledVector(I0.off, yt), (A0 || H0) && (At.v1.copy(I0.ankle).multiplyScalar(2).sub(I0.prevA), I0.off.subVectors(At.v1, At.v0), I0.u0 = i0, I0.pitchOff = I0.pitch - $y[2], yt = 1), I0.ankle.copy(At.v1), I0.pitch = $y[2] + I0.pitchOff * yt, I0.toe = Math.max(0, -I0.pitch) * (1 - Ao(i0 / 0.18)) * 0.9, I0.dir.copy(I0.dir0).lerp(st, Ao((i0 - I0.u0) / Math.max(0.75 - I0.u0, 0.05))), A2(I0.dir, st);
        }
      } else {
        if (I0.mode === 2) {
          I0.mode = 3, I0.from.copy(I0.ankle), I0.fromPitch = I0.pitch, I0.t = 0;
          let J = Math.hypot(w0.x - I0.ankle.x, w0.z - I0.ankle.z);
          I0.dur = Zt(0.1 + J * 0.3, 0.12, 0.3), I0.lift = 0.02 + 0.06 * Math.min(J, 1), I0.bo.copy(this._pvd).multiplyScalar(Math.min(0.26, 0.055 * this._peak)), I0.to.copy(w0).add(I0.bo), I0.to.y += Sn, I0.dir0.copy(I0.dir);
        } else I0.mode === 1 && (I0.mode = 0);
        if (I0.mode === 3) {
          I0.t = Math.min(1, I0.t + t / I0.dur);
          let J = Ao(I0.t);
          !this.gaitOn && I0.lift > 0 && (I0.to.copy(w0).add(I0.bo), I0.to.y += Sn), I0.ankle.lerpVectors(I0.from, I0.to, J), I0.ankle.y += I0.lift * Math.sin(Math.PI * I0.t), I0.pitch = Ht(I0.fromPitch, 0, J) - 0.3 * I0.lift / 0.08 * Math.sin(Math.PI * I0.t), I0.toe = 0, I0.lift > 0 && (I0.dir.copy(I0.dir0).lerp(st, J), A2(I0.dir, st)), I0.t >= 1 && (I0.mode = 0, I0.pitch = 0, I0.plant.copy(I0.to), I0.plant.y -= Sn);
        } else {
          let J = z0 === 1 ? S * (1 - P) : 0;
          I0.pitch = Ee(I0.pitch, -0.8 * J, 14, t), I0.toe = Math.max(0, -I0.pitch), K5(I0.pitch, Qr), I0.ankle.copy(I0.plant).addScaledVector(I0.dir, Qr[0]), I0.ankle.y += Qr[1];
          let Q = I0.plant.x - w0.x, i0 = I0.plant.z - w0.z;
          if (!this.gaitOn && (Q * Q + i0 * i0 > 0.0225 || Math.abs(I0.plant.y - w0.y) > 0.08 || I0.dir.dot(K) < 0.82) && vt.mode === 0 && this.stepCool <= 0) {
            I0.mode = 3, I0.from.copy(I0.ankle), I0.fromPitch = I0.pitch, I0.t = 0, I0.dir0.copy(I0.dir), I0.bo.set(0, 0, 0);
            let A0 = Math.sqrt(Q * Q + i0 * i0);
            I0.dur = Zt(0.17 + A0 * 0.3, 0.18, 0.32), I0.lift = 0.045 + 0.07 * Math.min(A0, 0.6), I0.to.copy(w0), I0.to.y += Sn, this.stepCool = I0.dur + 0.06;
          }
          I0.stance = true;
        }
      }
      I0.prevA.set(_t, Pt, bt);
    }
    let J0 = bt0, q0 = Ht(G1(R2, mt0, y), pt0 + 0.045 * P, S) - (8e-3 * (1 - P) + 0.02 * p0 + 0.06 * m0) * (1 - S) + 6e-3 * E, v0 = Math.sin(this.time * 0.23 + this._br * 0.05) * (1 - P) * (1 - 0.6 * S), x0 = Math.sin(this.time * 0.63) * 8e-3 * (1 - P) + 0.017 * v0, C0 = 0, k0 = 0.03 * v0, O0 = 0;
    if (this.gaitOn) {
      let z0 = this.phase, I0 = Ht((T0 - 0.5) * 0.5, 0.45 * T0, S0.rk);
      O0 = -(Ht(0.016, 0.021 + 6e-3 * E + 3e-3 * z, S0.rk) * Math.abs(2 * S0.rk - 1) * (1 - 0.4 * S)) * Math.cos(2 * Vt * (z0 - I0)) * P;
      let wt = Math.cos(Vt * (z0 - T0 * 0.5));
      x0 -= Ht(0.022, 0.01, S0.rk) * wt * P, k0 = Ht(0.05, 0.035, S0.rk) * wt * P, C0 = Ht(0.08, 0.17 + 0.05 * E, S0.rk) * Math.cos(Vt * z0) * P * (1 - 0.5 * p0) * (et < 0 ? -1 : 1);
    }
    {
      let z0 = 0;
      this.gaitOn || (Z0[0].mode === 3 ? z0 = 0.035 : Z0[1].mode === 3 && (z0 = -0.035)), this._shift = Ee(this._shift, z0, 12, t);
    }
    {
      let z0 = this._land, I0 = -z0.x * 150 - z0.v * 17;
      z0.v += I0 * t, z0.x = Zt(z0.x + z0.v * t, -0.3, 0.05);
    }
    q0 += O0 + Math.sin(this._br) * 3e-3 * (1 - P) + this._land.x + 0.03 * (1 - s) * (1 - P) * (1 - S), J0.P.copy(n).addScaledVector($, x0 + this._shift).addScaledVector(h, -0.06 * S), J0.P.y += q0 + this._yo;
    {
      let z0 = Math.cos(C0), I0 = Math.sin(C0);
      J0.hip.copy($).multiplyScalar(z0).addScaledVector(K, -I0), J0.hip.y -= k0, J0.hip.normalize();
    }
    {
      let z0 = this._leanX, I0 = this._leanZ, vt = this._flX, wt = this._flZ, _t = this._flT, Pt = Zt(this.acc.x, -14, 14) * 95e-4, bt = Zt(this.acc.z, -14, 14) * 95e-4, Et = (Pt - z0.x) * 170 - z0.v * 13;
      z0.v += Et * t, z0.x += z0.v * t, Et = (bt - I0.x) * 170 - I0.v * 13, I0.v += Et * t, I0.x += I0.v * t, Et = -vt.x * 260 - vt.v * 17, vt.v += Et * t, vt.x = Zt(vt.x + vt.v * t, -0.3, 0.3), Et = -wt.x * 260 - wt.v * 17, wt.v += Et * t, wt.x = Zt(wt.x + wt.v * t, -0.3, 0.3), Et = -_t.x * 240 - _t.v * 16, _t.v += Et * t, _t.x = Zt(_t.x + _t.v * t, -0.35, 0.35);
    }
    let B0 = At.lean.copy(h).multiplyScalar(0.14 + 0.32 * S + 0.06 * E - 0.26 * a * (1 - 0.5 * S));
    B0.addScaledVector(n0, Math.min(y, 7) * (0.02 + 0.034 * E) * (this.back ? 0.25 : 1) * P), B0.x += this._leanX.x + this._flX.x, B0.z += this._leanZ.x + this._flZ.x;
    let ot = At.spine.copy(On).add(B0).normalize();
    J0.P.addScaledVector(B0, -0.1), J0.C.copy(J0.P).addScaledVector(ot, h2);
    let Q0 = Math.sin(this._br) * (1 + 1.9 * this._exert), nt = this._throwT, L0 = nt < 0 ? 0 : Ao(nt / 0.12) * (1 - Ao((nt - 0.6) / 0.24)), ht = nt < 0 ? 0 : Ao(nt / 0.24) * (1 - Ao((nt - 0.26) / 0.1)), pt = nt < 0 ? 0 : Ao((nt - 0.26) / 0.1) * (1 - Ao((nt - 0.5) / 0.25)), V0 = Math.max((1 - s) * (1 - E), L0 * 0.85) * (1 - _), c0 = At.nd.copy(ot).addScaledVector(On, 0.35).addScaledVector(h, -0.12 * a).normalize();
    J0.N.copy(J0.C).addScaledVector(c0, f2);
    let Z = Ht(this._pistol ? 0.1 : Yk, this.off * 0.75, E) - C0 * Ht(0.5, 1.5, E) + this._flT.x - 0.6 * ht + 0.5 * pt;
    J0.sh.copy(f).multiplyScalar(Math.cos(Z)).addScaledVector(h, -Math.sin(Z)), J0.sh.y += k0 * 0.6, J0.sh.normalize();
    let r0 = At.hd.copy(On).addScaledVector(h, 0.3 - 0.4 * a).addScaledVector(f, 0.2 * (1 - E)).normalize();
    J0.H.copy(J0.N).addScaledVector(r0, u5);
    for (let z0 = 0; z0 < 2; z0++) (z0 ? J0.AR : J0.AL).copy(Z0[z0].ankle);
    {
      let z0 = 0;
      for (let I0 = 0; I0 < 2; I0++) {
        let vt = I0 ? 1 : -1, wt = I0 ? J0.AR : J0.AL, _t = J0.P.x + J0.hip.x * vt * Pi - ot.x * lf, Pt = J0.P.z + J0.hip.z * vt * Pi - ot.z * lf, bt = J0.P.y + J0.hip.y * vt * Pi - ot.y * lf, Et = wt.x - _t, zt = wt.z - Pt, J = hp * ($k - 6e-3), Q = wt.y + Math.sqrt(Math.max(J * J - Et * Et - zt * zt, 0.02));
        bt - Q > z0 && (z0 = bt - Q), bt - Q > 0.05 && Z0[I0].mode === 1 && Z0[I0].k > 0.3 && (this._warp = I0);
      }
      z0 = Math.min(z0, 0.38) * (1 - T), this.drop = z0 > this.drop ? Math.min(z0, this.drop + Math.max(2.4 * t, (z0 - this.drop) * 0.45)) : Ee(this.drop, z0, 9, t), J0.P.y -= this.drop, J0.C.y -= this.drop, J0.N.y -= this.drop, J0.H.y -= this.drop;
    }
    let b0 = 0.2 + 0.5 * S;
    J0.KL.copy(K).addScaledVector(Z0[0].dir, 0.6).addScaledVector($, -b0).addScaledVector(On, 0.12), J0.KR.copy(K).addScaledVector(Z0[1].dir, 0.6).addScaledVector($, b0).addScaledVector(On, 0.12);
    let d0 = wt0;
    for (let z0 = 0; z0 < Wp.length; z0++) {
      let I0 = Wp[z0];
      d0[I0].copy(J0[I0]).multiplyScalar(O);
    }
    if (R > 1e-3) {
      let z0 = yt0, I0 = At.m.copy(y > 0.5 ? n0 : K), vt = At.mr.set(-I0.z, 0, I0.x);
      z0.P.copy(n).addScaledVector(I0, -0.06), z0.P.y += 0.3, At.spine.copy(On).multiplyScalar(0.8).addScaledVector(I0, -0.6).addScaledVector(h, 0.12).normalize(), z0.C.copy(z0.P).addScaledVector(At.spine, h2), At.nd.copy(At.spine).addScaledVector(On, 0.6).addScaledVector(h, 0.25).normalize(), z0.N.copy(z0.C).addScaledVector(At.nd, f2), At.hd.copy(On).addScaledVector(h, 0.3 - 0.5 * a).addScaledVector(f, 0.25).normalize(), z0.H.copy(z0.N).addScaledVector(At.hd, u5), z0.sh.copy(f).multiplyScalar(Math.cos(Yk)).addScaledVector(h, -Math.sin(Yk)), z0.hip.copy(vt), z0.AL.copy(n).addScaledVector(I0, 0.72).addScaledVector(vt, -0.07), z0.AL.y += 0.12, z0.AR.copy(n).addScaledVector(I0, 0.26).addScaledVector(vt, 0.15), z0.AR.y += 0.1, z0.KL.copy(On).multiplyScalar(0.5).addScaledVector(I0, 0.4).addScaledVector(vt, -0.3), z0.KR.copy(On).addScaledVector(I0, 0.3).addScaledVector(vt, 0.35);
      for (let wt = 0; wt < Wp.length; wt++) {
        let _t = Wp[wt];
        d0[_t].addScaledVector(z0[_t], R);
      }
    }
    if (C + L > 1e-3) {
      let z0 = this.axis, I0 = h.dot(z0), vt = At.F.copy(h).addScaledVector(z0, -I0).addScaledVector(On, -I0).normalize(), wt = At.Rv.crossVectors(vt, z0).normalize();
      if (C > 1e-3) {
        let _t = vt0, Pt = Zt(this.vy / Math.max(y, 3), -0.6, 0.6), bt = At.a0.copy(z0).addScaledVector(On, Pt).normalize();
        _t.P.copy(n).addScaledVector(z0, -0.12), _t.P.y += 0.32, At.spine.copy(bt).addScaledVector(On, 0.08).normalize(), _t.C.copy(_t.P).addScaledVector(At.spine, h2), At.nd.copy(bt).addScaledVector(On, 0.2).normalize(), _t.N.copy(_t.C).addScaledVector(At.nd, f2), At.hd.copy(bt).multiplyScalar(0.75).addScaledVector(On, 0.45).addScaledVector(h, 0.3).normalize(), _t.H.copy(_t.N).addScaledVector(At.hd, u5), _t.sh.copy(wt), _t.hip.copy(wt), _t.AL.copy(_t.P).addScaledVector(bt, -0.8).addScaledVector(wt, -0.12).addScaledVector(vt, -0.02), _t.AR.copy(_t.P).addScaledVector(bt, -0.76).addScaledVector(wt, 0.13).addScaledVector(vt, -0.11), _t.KL.copy(vt).addScaledVector(z0, 0.3), _t.KR.copy(vt).addScaledVector(z0, 0.3);
        for (let Et = 0; Et < Wp.length; Et++) {
          let zt = Wp[Et];
          d0[zt].addScaledVector(_t[zt], C);
        }
      }
      if (L > 1e-3) {
        let _t = Mt0, Pt = Math.max(0, vt.y), bt = 1 - Math.abs(vt.y);
        _t.P.copy(n).addScaledVector(z0, -0.12), _t.P.y += 0.13 + 0.04 * bt, At.spine.copy(z0).addScaledVector(On, 0.2 + 0.25 * Pt).normalize(), _t.C.copy(_t.P).addScaledVector(At.spine, h2), At.nd.copy(z0).multiplyScalar(1 - 0.4 * Pt).addScaledVector(On, 0.4 + 0.4 * Pt).normalize(), _t.N.copy(_t.C).addScaledVector(At.nd, f2), At.hd.copy(z0).multiplyScalar(0.7 - Pt).addScaledVector(On, 0.6 + 0.3 * Pt).addScaledVector(h, 0.2).normalize(), _t.H.copy(_t.N).addScaledVector(At.hd, u5), _t.sh.copy(wt), _t.hip.copy(wt);
        let Et = Ht(0.76, 0.6, Pt), zt = 0.14 + 0.05 * Pt, J = n.y + Ht(0.07, 0.09, Pt) + 0.04 * bt;
        _t.AL.copy(_t.P).addScaledVector(z0, -Et).addScaledVector(wt, -zt), _t.AL.y = J, _t.AR.copy(_t.P).addScaledVector(z0, -Et * 0.92).addScaledVector(wt, zt), _t.AR.y = J, _t.KL.copy(vt).multiplyScalar(0.3 + Pt).addScaledVector(wt, -(1 - Pt) * 0.8), _t.KR.copy(vt).multiplyScalar(0.3 + Pt).addScaledVector(wt, (1 - Pt) * 0.8);
        for (let Q = 0; Q < Wp.length; Q++) {
          let i0 = Wp[Q];
          d0[i0].addScaledVector(_t[i0], L);
        }
      }
    }
    let V = this.joints, B = n.y + 0.04, j = this._hint, s0 = A2(At.cdir.subVectors(d0.C, d0.P), On);
    d0.C.copy(d0.P).addScaledVector(s0, h2);
    let l0 = A2(At.ndir.subVectors(d0.N, d0.C), s0);
    d0.N.copy(d0.C).addScaledVector(l0, f2);
    let E0 = nC(At.sh.copy(d0.sh), l0, f), U = nC(At.hip.copy(d0.hip), s0, $), X = At.mid.copy(d0.C).addScaledVector(l0, AE), N = this._kick;
    {
      let z0 = -N.x * 300 - N.v * 34;
      N.v += z0 * t, N.x = Zt(N.x + N.v * t, -0.3, 1.6);
    }
    let q = N.x, o0 = e7[this.weaponId] || e7.ar, h0 = this._pumpT, y0 = h0 < 0 ? 0 : Ao((h0 - 0.1) / 0.15) * (1 - Ao((h0 - 0.3) / 0.2)), D = At.SL.copy(X).addScaledVector(E0, -Yc), W = At.SR.copy(X).addScaledVector(E0, Yc);
    W.addScaledVector(f0, -o0.sh * q * (1 - E)), D.addScaledVector(l0, 4e-3 * Q0), W.addScaledVector(l0, 4e-3 * Q0), At.v0.copy(d0.P).addScaledVector(s0, -lf);
    let Y = At.HL.copy(At.v0).addScaledVector(U, -Pi), R0 = At.HR.copy(At.v0).addScaledVector(U, Pi);
    Zy(Y, d0.AL, qr, rf, d0.KL, At.kL, At.fL, $k, qN), Zy(R0, d0.AR, qr, rf, d0.KR, At.kR, At.fR, $k, qN);
    let U0 = e.reloadDur || (this.weaponId === "shotgun" ? 2.6 : 2.2), $0 = this.weaponId === "shotgun", g0 = Zt(this.reloadT / (U0 - 0.12), 0, 1), G0 = _, K0 = G0 * (1 - Fo(0.86, 1, g0)), it = At.Ga;
    if (this._pistol) it.addVectors(D, W).multiplyScalar(0.5).addScaledVector(f0, 0.43 - 0.03 * q - 0.14 * K0).addScaledVector(_0, 0.165 - this._sight.y + 3e-3 * Q0 - 0.06 * K0);
    else {
      let z0 = At.pocket.copy(W).addScaledVector(E0, -0.105).addScaledVector(f0, 0.012);
      it.copy(z0).addScaledVector(f0, this._stock - 0.014 - o0.back * q - 0.04 * K0).addScaledVector(_0, 0.15 - this._sight.y + 3e-3 * Q0 - 0.05 * K0).addScaledVector(f, -0.02 * K0);
    }
    if (it.y += this._land.x * 0.35, At.gz.copy(f0).multiplyScalar(-1), q5(Yu, f, _0, At.gz), K4.setFromAxisAngle(At.v1.set(1, 0, 0), o0.rise * q + 0.3 * K0 + 0.05 * Math.sin(g0 * 40) * G0 * Fo(0.7, 0.74, g0) * Fo(0.8, 0.76, g0)), Yu.multiply(K4), K4.setFromAxisAngle(At.v1.set(0, 0, 1), -0.05 + 0.55 * K0 + 0.12 * y0), Yu.multiply(K4), E > 1e-3) {
      let z0 = At.cu.copy(l0), I0 = At.cfw.crossVectors(z0, E0), vt = this.gaitOn ? Math.sin(2 * Vt * this.phase) : 0, wt = this.gaitOn ? Math.sin(Vt * this.phase) : 0;
      At.Gs.copy(d0.C).addScaledVector(E0, 0.1 + 0.03 * wt).addScaledVector(z0, -0.05 + 0.02 * vt).addScaledVector(I0, 0.21), At.gz.copy(I0).multiplyScalar(-0.5).addScaledVector(E0, 0.62).addScaledVector(z0, -0.6 - 0.07 * wt).normalize(), At.gy.copy(z0).multiplyScalar(0.45).addScaledVector(E0, 0.55).addScaledVector(I0, -0.25), At.gx.crossVectors(At.gy, At.gz).normalize(), At.gy.crossVectors(At.gz, At.gx), q5(Gp, At.gx, At.gy, At.gz), this.gunPos.lerpVectors(it, At.Gs, E), this.gunQuat.copy(Yu).slerp(Gp, E);
    } else this.gunPos.copy(it), this.gunQuat.copy(Yu);
    V0 > 1e-3 && (At.gz.copy(h).multiplyScalar(-0.75).addScaledVector(On, 0.66).addScaledVector(f, 0.26).normalize(), At.gx.crossVectors(On, At.gz).normalize(), At.gy.crossVectors(At.gz, At.gx), q5(Gp, At.gx, At.gy, At.gz), At.Gs.copy(W).addScaledVector(E0, this._pistol ? -0.19 : -0.11).addScaledVector(On, this._pistol ? -0.24 : -0.07).addScaledVector(At.gz, -(this._pistol ? 0.3 : this._stock - 0.03)), this.gunPos.lerp(At.Gs, V0), this.gunQuat.slerp(Gp, V0));
    {
      let z0 = this._pistol ? 0 : (1 - E) * (1 - 0.6 * K0) * O * (1 - V0), I0 = At.eye.copy(this._sight).applyQuaternion(this.gunQuat).add(this.gunPos).addScaledVector(f0, -0.085);
      I0.addScaledVector(f, -0.031).addScaledVector(_0, -0.014).addScaledVector(f0, -0.086);
      let vt = A2(At.v0.subVectors(I0, d0.N), l0), wt = At.hdir.subVectors(d0.H, d0.N);
      A2(wt, l0), wt.lerp(vt, 0.85 * z0), A2(wt, l0);
      for (let bt = 0; bt < 2; bt++) {
        let Et = wt.dot(l0);
        Et < 0.8 && (wt.addScaledVector(l0, (0.8 - Et) * 1.6), wt.normalize());
      }
      d0.H.copy(d0.N).addScaledVector(wt, u5);
      let _t = 0, Pt = 0;
      e.aimYaw !== void 0 && (_t = Zt(E1(i, e.aimYaw), -0.6, 0.6)), e.look ? _t = Zt(E1(i, Math.atan2(-(e.look.x - n.x), -(e.look.z - n.z))), -1.1, 1.1) : s < 0.6 && (_t += (1 - s) * (0.5 * Math.sin(this.time * 0.47 + this._br * 0.11) + 0.18 * Math.sin(this.time * 1.31)), Pt = (1 - s) * 0.09 * Math.sin(this.time * 0.33)), this._hy = Ee(this._hy, _t, 7, t), this._hp = Ee(this._hp, Pt, 5, t);
      {
        let bt = Math.cos(this._hy), Et = Math.sin(this._hy), zt = a * Ht(0.4, 1, s) + this._hp, J = Math.cos(zt);
        j.headFwd.copy(h).multiplyScalar(bt * J).addScaledVector(f, -Et * J).addScaledVector(On, Math.sin(zt) + 0.02 * q - 0.25 * K0);
      }
      E > 0.01 && j.headFwd.lerp(At.v1.copy(n0).addScaledVector(On, -0.08), 0.5 * E), A2(j.headFwd, h), j.headUp.copy(On).addScaledVector(wt, 0.9).addScaledVector(f, 0.1 * z0), Math.abs(j.headUp.dot(j.headFwd)) > 0.98 && j.headUp.copy(wt);
    }
    let ft = this.gunQuat;
    j.handQ[1].copy(ft).multiply(this._gripRq), j.handQ[0].copy(ft).multiply(this._gripLq);
    let gt = At.palmR.copy(this._gripR).applyQuaternion(ft).add(this.gunPos), rt = At.palmL.copy(this._gripL).applyQuaternion(ft).add(this.gunPos), dt = 0;
    if (j.magM = null, G0 > 1e-3) {
      this._pistol ? At.mag.set(0, this._gripR.y - 0.085, this._gripR.z + 0.012) : At.mag.set(0, this._gripR.y - 0.105, this._gripR.z - 0.11), At.mag.applyQuaternion(ft).add(this.gunPos), At.pouch.copy(d0.P).addScaledVector(K, 0.1).addScaledVector($, -0.19).addScaledVector(s0, 0.02), At.v2.copy(d0.C).addScaledVector(E0, -0.06).addScaledVector(At.cfw.crossVectors(l0, E0), 0.2).addScaledVector(s0, -0.1), At.a1.set(-0.03, 0.02, -0.06).applyQuaternion(ft).add(this.gunPos);
      let z0 = At.v0;
      if ($0) {
        At.mag.set(0, this._gripR.y - 0.035, this._gripR.z - 0.13).applyQuaternion(ft).add(this.gunPos);
        let I0 = Zt(g0 / 0.86, 0, 0.9999) * 4, vt = I0 - Math.floor(I0);
        g0 >= 0.86 ? z0.lerpVectors(At.mag, rt, Ao((g0 - 0.86) / 0.14)) : vt < 0.42 ? z0.lerpVectors(I0 < 1 ? rt : At.mag, At.pouch, Ao(vt / 0.42)) : vt < 0.86 ? z0.lerpVectors(At.pouch, At.mag, Ao((vt - 0.42) / 0.44)) : z0.copy(At.mag).addScaledVector(At.v1.set(0, 0, -1).applyQuaternion(ft), 0.03 * Ao((vt - 0.86) / 0.14));
      } else g0 < 0.12 ? z0.lerpVectors(rt, At.mag, Ao(g0 / 0.12)) : g0 < 0.18 ? z0.copy(At.mag) : g0 < 0.36 ? z0.lerpVectors(At.mag, At.pouch, Ao((g0 - 0.18) / 0.18)) : g0 < 0.5 ? z0.lerpVectors(At.pouch, At.v2, Ao((g0 - 0.36) / 0.14)) : g0 < 0.56 ? z0.copy(At.v2) : g0 < 0.72 ? z0.lerpVectors(At.v2, At.mag, Ao((g0 - 0.56) / 0.16)) : g0 < 0.78 ? z0.copy(At.mag) : g0 < 0.86 ? z0.lerpVectors(At.mag, At.a1, Ao((g0 - 0.78) / 0.08)) : z0.lerpVectors(At.a1, rt, Ao((g0 - 0.86) / 0.14));
      dt = G0 * Fo(0.02, 0.1, g0) * (1 - Fo(0.9, 1, g0)), rt.lerp(z0, G0), !$0 && g0 > 0.5 && g0 < 0.745 && G0 > 0.5 && (Gp.copy(ft), g0 < 0.6 && Gp.slerp(K4.setFromUnitVectors(At.v1.set(0, 1, 0), s0), 1 - (g0 - 0.5) / 0.1), this._magM.compose(At.v1.copy(rt).addScaledVector(On, 0.03), Gp, Jk), j.magM = this._magM);
    }
    if (y0 > 0 && rt.addScaledVector(At.v1.set(0, 0, 1).applyQuaternion(ft), 0.085 * y0), L0 > 1e-3) {
      At.v0.copy(D).addScaledVector(h, -0.2).addScaledVector(On, 0.2).addScaledVector(E0, -0.1), At.v2.copy(D).addScaledVector(h, 0.5).addScaledVector(On, 0.22).addScaledVector(E0, 0.05), At.v1.copy(D).addScaledVector(h, 0.34).addScaledVector(On, -0.25).addScaledVector(E0, 0.12);
      let z0 = At.a1;
      nt < 0.26 ? z0.lerpVectors(rt, At.v0, Ao(nt / 0.24)) : nt < 0.36 ? z0.lerpVectors(At.v0, At.v2, (nt - 0.26) / 0.1) : nt < 0.52 ? z0.lerpVectors(At.v2, At.v1, Ao((nt - 0.36) / 0.16)) : z0.lerpVectors(At.v1, rt, Ao((nt - 0.52) / 0.3)), rt.copy(z0), dt = Math.max(dt, L0);
    }
    if (dt < 0.999 && !this._pistol) {
      let z0 = (Ca + ey) * 0.9;
      At.v1.set(0, 0, 1).applyQuaternion(ft);
      for (let I0 = 0; I0 < 3; I0++) {
        At.v2.set(0, -t7, 0).applyQuaternion(j.handQ[0]).add(rt).sub(D);
        let vt = At.v2.length();
        if (vt <= z0) break;
        let wt = At.v2.dot(At.v1) / vt;
        rt.addScaledVector(At.v1, Math.min((vt - z0) / Math.max(-wt, 0.35), 0.12) * (1 - dt));
      }
    }
    j.handW[1] = O > 0.5 ? 1 : O * 2, j.handW[0] = j.handW[1] * (1 - dt), j.handP[1].copy(gt), j.handP[0].copy(rt);
    let tt = At.wR.set(0, -t7, 0).applyQuaternion(j.handQ[1]).add(gt), X0 = At.wL.set(0, -t7, 0).applyQuaternion(j.handQ[0]).add(rt);
    dt > 1e-3 && X0.lerp(At.v1.copy(rt).addScaledVector(At.v2.subVectors(rt, D).normalize(), -t7), dt);
    let ut = C + L;
    At.pole.copy(On).multiplyScalar(-1).addScaledVector(E0, 0.62).addScaledVector(f0, -0.25), ut > 1e-3 && At.pole.lerp(At.v1.copy(l0).multiplyScalar(-1).addScaledVector(On, -0.3).addScaledVector(E0, 0.2), ut), Zy(W, tt, Ca, ey, At.pole, At.eR, At.v0, 0.985), At.v1.subVectors(At.v0, At.eR).normalize(), At.a0.copy(At.eR).addScaledVector(At.v1, mh), At.pole.copy(On).multiplyScalar(-1).addScaledVector(E0, -0.38).addScaledVector(f0, 0.05), ut > 1e-3 && At.pole.lerp(At.v1.copy(l0).multiplyScalar(-1).addScaledVector(On, -0.3).addScaledVector(E0, -0.2), ut), Zy(D, X0, Ca, ey, At.pole, At.eL, At.v0, 0.985), At.v1.subVectors(At.v0, At.eL).normalize(), At.a1.copy(At.eL).addScaledVector(At.v1, mh), At.eL.y < B && (At.eL.y = B), At.eR.y < B && (At.eR.y = B), At.kL.y < B && (At.kL.y = B), At.kR.y < B && (At.kR.y = B), $l(V, ba.head, d0.H), $l(V, ba.neck, d0.N), $l(V, ba.chest, d0.C), $l(V, ba.pelvis, d0.P), $l(V, ba.lShoulder, D), $l(V, ba.lElbow, At.eL), $l(V, ba.lHand, At.a1), $l(V, ba.rShoulder, W), $l(V, ba.rElbow, At.eR), $l(V, ba.rHand, At.a0), $l(V, ba.lHip, Y), $l(V, ba.lKnee, At.kL), $l(V, ba.lFoot, At.fL), $l(V, ba.rHip, R0), $l(V, ba.rKnee, At.kR), $l(V, ba.rFoot, At.fR), j.footW = O;
    for (let z0 = 0; z0 < 2; z0++) {
      let I0 = Z0[z0], vt = Math.cos(I0.pitch), wt = Math.sin(I0.pitch);
      j.footU[z0].copy(On).multiplyScalar(vt).addScaledVector(I0.dir, -wt), j.footF[z0].copy(I0.dir).multiplyScalar(vt).addScaledVector(On, wt), j.toeBend[z0] = I0.toe;
      let _t = z0 ? R0 : Y, Pt = z0 ? At.fR : At.fL, bt = z0 ? At.kR : At.kL;
      I0.ext = _t.distanceTo(Pt) / hp, At.v0.subVectors(_t, bt), At.v1.subVectors(Pt, bt), I0.knee = Math.acos(Zt(At.v0.dot(At.v1) / (qr * rf), -1, 1));
    }
    {
      let z0 = this.jointVel, I0 = this._pj, vt = this._pjOk ? 1 / t : 0;
      for (let wt = 0; wt < 48; wt += 3) {
        let _t = (V[wt] - I0[wt]) * vt - u.x * (vt ? 1 : 0), Pt = (V[wt + 1] - I0[wt + 1]) * vt, bt = (V[wt + 2] - I0[wt + 2]) * vt - u.z * (vt ? 1 : 0), Et = Math.hypot(_t, Pt, bt), zt = (Et > 4 ? 4 / Et : 1) * 0.7;
        z0[wt] = u.x + _t * zt, z0[wt + 1] = Pt * zt, z0[wt + 2] = u.z + bt * zt, I0[wt] = V[wt], I0[wt + 1] = V[wt + 1], I0[wt + 2] = V[wt + 2];
      }
      this._pjOk = true;
    }
    this._aimX = h.x, this._aimZ = h.z, this._hinted = true, this.renderFromJoints(), this._hinted = false;
  }
  get hints() {
    return this._hint;
  }
  renderHinted() {
    this._hinted = true, this.renderFromJoints(), this._hinted = false;
  }
  renderFromJoints() {
    let t = this.joints, e = this._hinted, s = this._mats, n = this._bones;
    if (e) CE(t, this._hint, s), this._resOn = 1;
    else {
      let c = this._res;
      if (this._resOn === 1) for (let h = 0; h < 7; h++) c.last[h].copy(s[tC[h]]);
      if (CE(t, null, s), this._resOn === 1) {
        for (let h = 0; h < 7; h++) X5.copy(s[tC[h]]).invert().multiply(c.last[h]), X5.decompose(c.p[h], c.q[h], At.v0);
        this._resOn = 2, c.t0 = XN();
      }
      if (this._resOn === 2) {
        let h = 1 - Ao((XN() - c.t0) / 340);
        if (h <= 0) this._resOn = 0;
        else for (let f = 0; f < 7; f++) Yu.identity().slerp(c.q[f], h), At.v0.copy(c.p[f]).multiplyScalar(h), X5.compose(At.v0, Yu, Jk), s[tC[f]].multiply(X5);
      }
    }
    for (let c = 0; c < kE; c++) {
      let h = n[c];
      h.matrix.copy(s[c]), h.matrixWorldNeedsUpdate = true;
    }
    this.gun && !e && (Yu.setFromRotationMatrix(s[Ve.hand + 7]), this.gunQuat.copy(Yu).multiply(Gp.copy(this._gripRq).invert()), this.gunPos.setFromMatrixPosition(s[Ve.hand + 7]).sub(At.v0.copy(this._gripR).applyQuaternion(this.gunQuat))), this._placeGun();
    let i = this.hit, a = Wr(t, ba.pelvis, At.a0), r = Wr(t, ba.neck, At.a1), l = Wr(t, ba.head, At.v0);
    At.v1.subVectors(l, r), A2(At.v1, On), i[0].a.copy(r).addScaledVector(At.v1, 0.07), i[0].b.copy(l).addScaledVector(At.v1, 0.03), i[1].a.copy(a), i[1].b.copy(r), Wr(t, ba.lFoot, At.v1), Wr(t, ba.rFoot, At.v2), i[2].a.addVectors(At.v1, At.v2).multiplyScalar(0.5), i[2].b.copy(a);
  }
};
function rB(o2) {
  const idx = Math.max(0, Math.min(2, o2 | 0));
  return GN(idx, t4[idx]);
}
var is = { ik2: Zy, rock: K5, herm5: s7, tab: G1, safeNorm: A2, ortho: nC, quatFromBasis: q5, G_V: sC, G_DUTY: jN, G_FREQ: $N, S_V: R2, S_YA: ZN, S_YB: QN, S_YC: JN, S_RE: tB, S_XA: eB, S_XB: sB, S_TH: nB, S_PH: oB, S_KL: iB }, eC = [null, null, null];
function lB(o2) {
  const idx = Math.max(0, Math.min(2, o2 | 0));
  if (eC[idx]) return eC[idx];
  const t = aB(idx);
  const e = t.index.array;
  const s = t.attributes.skinIndex.array;
  const n = t.attributes.skinWeight.array;
  const i = t.userData.fp;
  const a = (d) => {
    let m = i[d] === 1 ? 1.5 : 0;
    for (let p = 0; p < 4; p++) {
      const x = s[d * 4 + p];
      if (x === Ve.head || x === Ve.neck || x === Ve.mag || (x >= Ve.shH && x < Ve.hipH)) {
        m += n[d * 4 + p];
      }
    }
    return m;
  };
  const r = [], l = [], c = [];
  for (let d = 0; d < e.length; d += 3) {
    (a(e[d]) + a(e[d + 1]) + a(e[d + 2]) > 0.75 ? l : i[e[d]] === 2 ? c : r).push(e[d], e[d + 1], e[d + 2]);
  }
  const h = r.length;
  for (const d of c) r.push(d);
  const f = (d) => {
    const m = new THREE.BufferGeometry();
    for (const p in t.attributes) m.setAttribute(p, t.attributes[p]);
    m.setIndex(t.index.array instanceof Uint32Array ? new THREE.Uint32BufferAttribute(d, 1) : new THREE.Uint16BufferAttribute(d, 1));
    m.boundingSphere = t.boundingSphere;
    m.boundingBox = t.boundingBox;
    m.userData.triangles = d.length / 3;
    return m;
  };
  const u = { view: f(r), rest: f(l) };
  u.view.userData.core = h;
  eC[idx] = u;
  return u;
}
var ue = { bodyLen: 0.8, bodyW: 0.24, bodyH: 0.16, hipZ: 0.3, hipX: 0.125, hipOut: 0.075, upper: 0.32, lower: 0.34, foot: 0.035, stand: 0.56, rest: 0.13, tail: 0.11 }, a7 = ["FL", "FR", "HL", "HR"], Ph = (o2) => o2 % 2 === 0 ? -1 : 1, kf = (o2) => o2 < 2, $u = [{ name: "body", parent: -1, at: [0, ue.stand, 0] }, ...a7.flatMap((o2, t) => [{ name: "hip" + o2, parent: 0, at: [Ph(t) * ue.hipX, 0, kf(t) ? -ue.hipZ : ue.hipZ] }, { name: "upper" + o2, parent: 1 + t * 3, at: [Ph(t) * ue.hipOut, 0, 0] }, { name: "lower" + o2, parent: 2 + t * 3, at: [0, -ue.upper, 0] }]), { name: "neck", parent: 0, at: [0, 0.05, -0.4] }, { name: "head", parent: 13, at: [0, 0.06, -0.1] }, { name: "jaw", parent: 14, at: [0, -0.03, -0.06] }, { name: "earL", parent: 14, at: [-0.05, 0.045, 0.02] }, { name: "earR", parent: 14, at: [0.05, 0.045, 0.02] }, { name: "tail1", parent: 0, at: [0, 0.07, 0.38] }, { name: "tail2", parent: 18, at: [0, 0.07, 0.085] }, { name: "tail3", parent: 19, at: [0, 0.07, 0.085] }], xs = Object.fromEntries($u.map((o2, t) => [o2.name, t])), qc0 = $u.length, zn = { a: [-0.45, 0.9], p: [-2.7, 1.7], k: [0.08, 2.8], neckYaw: 1.2, neckPitch: [-1.1, 0.9], headYaw: 0.9, headPitch: [-0.9, 0.8], headRoll: 0.6, jaw: [0, 0.75], ear: [-0.9, 0.7] };
function r7() {
  return { pos: new THREE.Vector3(0, ue.stand, 0), quat: new THREE.Quaternion(), leg: [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], neck: [0, 0], head: [0, 0, 0], jaw: 0, ears: [0, 0], tail: [[0, 0], [0, 0], [0, 0]] };
}
function lC(o2, t) {
  o2.pos.copy(t.pos), o2.quat.copy(t.quat);
  for (let e = 0; e < 4; e++) o2.leg[e][0] = t.leg[e][0], o2.leg[e][1] = t.leg[e][1], o2.leg[e][2] = t.leg[e][2];
  o2.neck[0] = t.neck[0], o2.neck[1] = t.neck[1], o2.head[0] = t.head[0], o2.head[1] = t.head[1], o2.head[2] = t.head[2], o2.jaw = t.jaw, o2.ears[0] = t.ears[0], o2.ears[1] = t.ears[1];
  for (let e = 0; e < 3; e++) o2.tail[e][0] = t.tail[e][0], o2.tail[e][1] = t.tail[e][1];
  return o2;
}
function fB() {
  let o2 = $u.map((t) => {
    let e = new THREE.Bone();
    return e.name = t.name, e.position.set(t.at[0], t.at[1], t.at[2]), e;
  });
  return $u.forEach((t, e) => {
    t.parent >= 0 && o2[t.parent].add(o2[e]);
  }), o2;
}
var tv = new THREE.Vector3(1, 0, 0), St0 = new THREE.Vector3(0, 0, 1), aC = new THREE.Euler(0, 0, 0, "YXZ");
function cC(o2, t) {
  o2[0].position.copy(t.pos), o2[0].quaternion.copy(t.quat);
  for (let e = 0; e < 4; e++) {
    let [s, n, i] = t.leg[e], a = 1 + e * 3;
    o2[a].quaternion.setFromAxisAngle(St0, Ph(e) * s), o2[a + 1].quaternion.setFromAxisAngle(tv, n), o2[a + 2].quaternion.setFromAxisAngle(tv, i);
  }
  o2[xs.neck].quaternion.setFromEuler(aC.set(t.neck[1], t.neck[0], 0, "YXZ")), o2[xs.head].quaternion.setFromEuler(aC.set(t.head[1], t.head[0], t.head[2], "YXZ")), o2[xs.jaw].quaternion.setFromAxisAngle(tv, -t.jaw), o2[xs.earL].quaternion.setFromAxisAngle(tv, t.ears[0]), o2[xs.earR].quaternion.setFromAxisAngle(tv, t.ears[1]);
  for (let e = 0; e < 3; e++) o2[xs.tail1 + e].quaternion.setFromEuler(aC.set(t.tail[e][1], t.tail[e][0], 0, "YXZ"));
}
var Y5 = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2;
function hC(o2, t, e) {
  let s = Ph(o2), n = t[0] * s, i = t[1], a = t[1] + t[2], r = s * ue.hipOut, l = -ue.upper * Math.cos(i) - ue.lower * Math.cos(a), c = -ue.upper * Math.sin(i) - ue.lower * Math.sin(a), h = Math.cos(n), f = Math.sin(n);
  return e.set(s * ue.hipX + r * h - l * f, r * f + l * h, (kf(o2) ? -ue.hipZ : ue.hipZ) + c);
}
function ev(o2, t, e) {
  let s = Ph(o2), n = ue.upper, i = ue.lower, a = t.x - s * ue.hipX, r = t.y, l = t.z - (kf(o2) ? -ue.hipZ : ue.hipZ), c = Math.max(Math.hypot(a, r), ue.hipOut + 1e-4), h = Math.atan2(a, -r), f = s * (h - Math.asin(Y5(s * ue.hipOut / c, -1, 1)));
  f = Y5(f, zn.a[0], zn.a[1]);
  let u = -Math.sqrt(Math.max(1e-8, c * c - ue.hipOut * ue.hipOut)), d = Math.hypot(u, l), m = Y5(d, Math.abs(n - i) + 0.02, n + i - 4e-3), p = Math.atan2(-l, -u), x = Math.acos(Y5((n * n + m * m - i * i) / (2 * n * m), -1, 1)), g = Math.acos(Y5((n * n + i * i - m * m) / (2 * n * i), -1, 1));
  return e[0] = f, e[1] = Y5(p - x, zn.p[0], zn.p[1]), e[2] = Y5(Math.PI - g, zn.k[0], zn.k[1]), Math.abs(d - m);
}
var uB = new THREE.Vector3();
function dB(o2 = r7(), t = ue.stand, e = 0.02) {
  o2.pos.set(0, t, 0), o2.quat.identity();
  for (let s = 0; s < 4; s++) ev(s, uB.set(Ph(s) * (ue.hipX + ue.hipOut + e), -t + ue.foot, kf(s) ? -ue.hipZ : ue.hipZ), o2.leg[s]);
  return o2.neck[0] = 0, o2.neck[1] = 0.25, o2.head[0] = 0, o2.head[1] = -0.15, o2.head[2] = 0, o2.jaw = 0, o2.ears[0] = o2.ears[1] = 0.15, o2.tail[0][0] = o2.tail[1][0] = o2.tail[2][0] = 0, o2.tail[0][1] = 0.1, o2.tail[1][1] = 0.05, o2.tail[2][1] = 0, o2;
}
function pB(o2 = r7()) {
  o2.pos.set(0, ue.rest, 0), o2.quat.identity();
  for (let t = 0; t < 4; t++) ev(t, uB.set(Ph(t) * (ue.hipX + ue.hipOut + 0.03), -ue.rest + ue.foot, (kf(t) ? -ue.hipZ : ue.hipZ) + 0.24), o2.leg[t]);
  return o2.neck[0] = 0, o2.neck[1] = -0.3, o2.head[0] = 0, o2.head[1] = -0.15, o2.head[2] = 0, o2.jaw = 0, o2.ears[0] = o2.ears[1] = -0.8, o2.tail[0][0] = o2.tail[1][0] = o2.tail[2][0] = 0, o2.tail[0][1] = -1.5, o2.tail[1][1] = -0.9, o2.tail[2][1] = -0.5, o2;
}
var rC = [{ part: "torso", bone: "body", a: [0, 0.01, -0.29], b: [0, 0.01, 0.29], r: 0.175 }, { part: "head", bone: "head", a: [0, 0, -0.03], b: [0, 0, -0.15], r: 0.105 }];
function l7() {
  return rC.map((o2) => ({ part: o2.part, a: new THREE.Vector3(), b: new THREE.Vector3(), r: o2.r }));
}
function sv(o2, t) {
  for (let e = 0; e < rC.length; e++) {
    let s = rC[e], n = o2[xs[s.bone]].matrixWorld;
    t[e].a.set(s.a[0], s.a[1], s.a[2]).applyMatrix4(n), t[e].b.set(s.b[0], s.b[1], s.b[2]).applyMatrix4(n);
  }
  return t;
}
var h7 = Math.PI * 2, c7 = null, fC = typeof document > "u";
function gB(o2, t, e = false) {
  let s = new THREE.DataTexture(o2, t, t, THREE.RGBAFormat);
  return s.wrapS = s.wrapT = THREE.RepeatWrapping, s.generateMipmaps = true, s.minFilter = THREE.LinearMipmapLinearFilter, s.magFilter = THREE.LinearFilter, s.anisotropy = 8, e && (s.colorSpace = THREE.SRGBColorSpace), s.needsUpdate = true, s;
}
function mB(o2, t, e, s, n) {
  for (let i = 0; i < t; i++) for (let a = 0; a < t; a++) {
    let r = (a + t - 1) % t, l = (a + 1) % t, c = (i + t - 1) % t, h = (i + 1) % t, f = (o2[i * t + l] - o2[i * t + r]) * e, u = (o2[h * t + a] - o2[c * t + a]) * e, d = 1 / Math.hypot(f, u, 1), m = (i * t + a) * 4 + n;
    s[m] = Math.round((-f * d * 0.5 + 0.5) * 255), s[m + 1] = Math.round((-u * d * 0.5 + 0.5) * 255);
  }
}
function Xp(o2, t, e, s, n = 0.5) {
  let i = new Float32Array(o2 * o2), a = 1, r = 0;
  for (let l = 0; l < e; l++, t *= 2, a *= n) {
    let c = new Float32Array(t * t);
    for (let d = 0; d < c.length; d++) c[d] = s();
    let h = new Int32Array(o2), f = new Int32Array(o2), u = new Float32Array(o2);
    for (let d = 0; d < o2; d++) {
      let m = d / o2 * t, p = Math.floor(m), x = m - p;
      h[d] = p % t, f[d] = (p + 1) % t, u[d] = x * x * (3 - 2 * x);
    }
    for (let d = 0; d < o2; d++) {
      let m = h[d] * t, p = f[d] * t, x = u[d], g = d * o2;
      for (let b = 0; b < o2; b++) {
        let v = c[m + h[b]], y = c[m + f[b]], M = c[p + h[b]], w = c[p + f[b]], T = u[b], S = v + (y - v) * T;
        i[g + b] += a * (S + (M + (w - M) * T - S) * x);
      }
    }
    r += a;
  }
  for (let l = 0; l < i.length; l++) i[l] /= r;
  return i;
}
function _t0() {
  let t = new Uint8Array(262144), e = new Float32Array(256 * 256), s = Re(77), n = new Float32Array(256 * 256);
  for (let a = 0; a < n.length; a++) n[a] = s();
  {
    let a = Xp(256, 51, 2, s), r = Xp(256, 116, 1, s);
    for (let l = 0; l < e.length; l++) e[l] = a[l] * 1.5 + r[l] * 0.55 + n[l] * 0.22;
  }
  mB(e, 256, 1.5, t, 0);
  let i = 16;
  for (let a = 0; a < 256; a++) for (let r = 0; r < 256; r++) {
    let l = Math.floor(r / i), c = Math.floor(a / i), h = r % i / i - 0.5, f = a % i / i - 0.5, u = (l + c & 3) < 2, d = u ? h : f, m = u ? f : h, p = Math.cos(d * Math.PI) * 1 + 0.16 * Math.cos(m * Math.PI * 0.9) + 0.07 * Math.sin((u ? r : a) * 2.4 + n[a * 256 + r] * 2);
    e[a * 256 + r] = p + (u ? 0.12 : 0);
  }
  return mB(e, 256, 1.25, t, 2), gB(t, 256);
}
function Rt0() {
  let t = new Uint8Array(262144), e = Re(1234), s = Xp(256, 6, 4, e), n = Xp(256, 21, 3, e), i = Xp(256, 30, 3, e), a = Xp(256, 52, 2, e), r = Xp(256, 4, 4, e), l = Xp(256, 9, 3, e), c = new Float32Array(256 * 256);
  for (let m = 0; m < 150; m++) {
    let p = e() * 256, x = e() * 256, g = e() * h7, b = 5 + e() * e() * 70, v = Math.cos(g), y = Math.sin(g), M = 0.35 + e() * 0.65, w = (e() - 0.5) * 0.02, T = v, S = y;
    for (let E = 0; E < b; E++) {
      let _ = ((x | 0) + 256) % 256 * 256 + ((p | 0) + 256) % 256;
      c[_] = Math.max(c[_], M * (1 - Math.abs(E / b - 0.5) * 1.2)), p += T, x += S;
      let R = T - S * w;
      S = S + T * w, T = R;
    }
  }
  let h = 9, f = 256 / h, u = new Float32Array(h * h), d = new Float32Array(h * h);
  for (let m = 0; m < h * h; m++) u[m] = 0.15 + e() * 0.7, d[m] = 0.15 + e() * 0.7;
  for (let m = 0; m < 256; m++) for (let p = 0; p < 256; p++) {
    let x = m * 256 + p, g = x * 4, b = s[x] * 0.65 + n[x] * 0.35;
    t[g] = Math.max(0, Math.min(255, (0.5 + (b - 0.5) * 2.3) * 255));
    let v = i[x] * 0.62 + (1 - Math.abs(2 * a[x] - 1)) * 0.38, y = Math.max(0, Math.min(1, (v - 0.52) * 3 + 0.5));
    t[g + 1] = Math.max(0, Math.min(255, Math.max(y * 0.86, c[m * 256 + p]) * 255));
    let M = r[x], w = 1 - Math.abs(2 * l[x] - 1);
    t[g + 2] = Math.max(0, Math.min(255, (0.5 + (M * 0.7 + w * 0.3 - 0.5) * 2.4) * 255));
    let T = p / f, S = m / f, E = Math.floor(T), _ = Math.floor(S), R = 9, C = 9;
    for (let A = -1; A <= 1; A++) for (let O = -1; O <= 1; O++) {
      let H = ((E + O) % h + h) % h, F = ((_ + A) % h + h) % h, P = F * h + H, z = E + O + u[P] - T, k = _ + A + d[P] - S, I = Math.hypot(z, k);
      I < R ? (C = R, R = I) : I < C && (C = I);
    }
    let L = (C - R) * f;
    t[g + 3] = Math.max(0, Math.min(255, (1 - L / 1.6) * 255));
  }
  return gB(t, 256);
}
var Bo = "#e4e1d6", k2 = "#e0b21c", to = "#131313", At0 = "#c23a2a", Kp = "#9a9da1";
function kt0() {
  let e = {};
  if (fC) return { tex: null, cells: new Proxy({}, { get: () => [0, 0, 0, 0, 1] }) };
  let s = we(2048, 1024), n = s.getContext("2d", { willReadFrequently: true });
  n.clearRect(0, 0, 2048, 1024), n.textBaseline = "middle";
  let i = (g, b = 700) => `${b} ${g}px Bahnschrift, "Segoe UI", Arial, sans-serif`, a = 8, r = 8, l = 0, c = (g, b, v, y) => {
    if (a + b > 2044 && (a = 8, r += l + 8, l = 0), r + v > 1024) throw new Error("k9: marking atlas is full at " + g);
    n.save(), n.translate(a, r), n.beginPath(), n.rect(0, 0, b, v), n.clip(), n.fillStyle = Bo, n.strokeStyle = Bo, n.lineWidth = 4, n.textAlign = "left", y(b, v), n.restore(), e[g] = [a / 2048, 1 - (r + v) / 1024, (a + b) / 2048, 1 - r / 1024, b / v], a += b + 8, l = Math.max(l, v);
  }, h = (g, b, v, y, M = 700, w = null, T = 0) => {
    if (n.font = i(b, M), w && (n.fillStyle = w), T) try {
      n.letterSpacing = T + "px";
    } catch {
    }
    if (n.fillText(g, v, y), T) try {
      n.letterSpacing = "0px";
    } catch {
    }
  }, f = (g, b, v, y, M, w = 4) => {
    h(g, b, v, y, 700, Bo, w), n.save(), n.globalCompositeOperation = "destination-out";
    let T = n.measureText(g).width + w * g.length;
    for (let S = 0.5; S < g.length; S++) n.fillRect(v + T * S / g.length - b * 0.035, y - b * 0.6, b * 0.07, b * 1.2);
    n.restore();
  }, u = (g, b, v, y) => {
    n.fillStyle = y, n.beginPath(), n.moveTo(g + 0.18 * v, b - 0.5 * v), n.lineTo(g - 0.28 * v, b + 0.06 * v), n.lineTo(g - 0.02 * v, b + 0.06 * v), n.lineTo(g - 0.2 * v, b + 0.5 * v), n.lineTo(g + 0.3 * v, b - 0.1 * v), n.lineTo(g + 0.04 * v, b - 0.1 * v), n.closePath(), n.fill();
  }, d = (g, b, v, y, M) => {
    n.beginPath(), n.moveTo(g, b - v * 0.58), n.lineTo(g + v * 0.6, b + v * 0.46), n.lineTo(g - v * 0.6, b + v * 0.46), n.closePath(), n.fillStyle = y, n.fill(), n.lineJoin = "round", n.lineWidth = v * 0.09, n.strokeStyle = M, n.stroke();
  }, m = (g, b, v, y, M = 10) => {
    let w = Math.atan2(y - b, v - g);
    n.beginPath(), n.moveTo(g, b), n.lineTo(v - Math.cos(w) * M, y - Math.sin(w) * M), n.stroke(), n.beginPath(), n.moveTo(v, y), n.lineTo(v - Math.cos(w - 0.5) * M * 2, y - Math.sin(w - 0.5) * M * 2), n.lineTo(v - Math.cos(w + 0.5) * M * 2, y - Math.sin(w + 0.5) * M * 2), n.closePath(), n.fill();
  }, p = (g, b, v = 44) => {
    n.fillStyle = k2, n.fillRect(0, 0, g, b), n.fillStyle = to;
    for (let y = -b; y < g + b; y += v) n.beginPath(), n.moveTo(y, b), n.lineTo(y + v / 2, b), n.lineTo(y + v / 2 + b, 0), n.lineTo(y + b, 0), n.closePath(), n.fill();
  };
  c("brand", 760, 150, (g, b) => {
    f("GH-ARMS", 104, 6, 80, g, 5), n.fillStyle = Bo, n.fillRect(578, 26, 8, 104), h("K9", 92, 604, 62, 700, Bo), h("UNIT", 40, 608, 122, 700, Bo, 6);
  }), c("unit", 500, 190, () => {
    f("K9-07", 150, 6, 100, 0, 6);
  }), c("unitSm", 240, 84, () => {
    h("K9-07", 76, 4, 44, 700, Bo, 2);
  }), c("chev", 150, 150, () => {
    n.lineWidth = 16, n.lineJoin = "miter";
    for (let g = 0; g < 3; g++) n.beginPath(), n.moveTo(20, 46 + g * 36), n.lineTo(75, 14 + g * 36), n.lineTo(130, 46 + g * 36), n.stroke();
  }), c("plate", 520, 230, (g, b) => {
    n.fillStyle = "#b9b3a2", n.fillRect(0, 0, g, b), n.strokeStyle = to, n.lineWidth = 4, n.strokeRect(8, 8, g - 16, b - 16), h("GH-ARMS  TACTICAL ROBOTICS", 28, 22, 34, 700, to), n.fillStyle = to, n.fillRect(22, 54, g - 44, 3), h("MODEL", 19, 22, 80, 600, to), h('K9-MK2 "WARDEN"', 26, 130, 80, 700, to), h("SERIAL", 19, 22, 114, 600, to), h("GH-K9-004177", 26, 130, 114, 700, to), h("MASS", 19, 22, 148, 600, to), h("31.4 kg", 26, 130, 148, 700, to), h("IP67", 26, 300, 148, 700, to), h("BUS", 19, 22, 182, 600, to), h("58 V DC   40 A MAX", 26, 130, 182, 700, to), h("MFD 2031-08   LOT 17   PROPERTY OF GH-ARMS", 16, 22, 210, 600, to);
  }), c("hv", 440, 200, (g, b) => {
    n.fillStyle = k2, n.fillRect(0, 0, g, b), n.strokeStyle = to, n.lineWidth = 6, n.strokeRect(6, 6, g - 12, b - 12), d(84, 104, 120, k2, to), u(84, 112, 62, to), h("DANGER", 50, 168, 52, 700, to), h("HIGH VOLTAGE", 34, 168, 100, 700, to), h("50 kV SHOCK HEAD", 22, 168, 138, 600, to), h("KEEP CLEAR OF JAW", 22, 168, 166, 600, to);
  }), c("pinch", 400, 110, (g, b) => {
    n.fillStyle = k2, n.fillRect(0, 0, g, b), n.strokeStyle = to, n.lineWidth = 5, n.strokeRect(5, 5, g - 10, b - 10), d(58, 58, 78, k2, to), h("!", 44, 49, 62, 700, to), h("PINCH POINT", 34, 116, 40, 700, to), h("KEEP HANDS CLEAR", 22, 116, 78, 600, to);
  }), c("hazard", 512, 56, (g, b) => p(g, b)), c("nostep", 250, 70, () => {
    n.lineWidth = 5, n.strokeRect(4, 4, 242, 62), h("NO STEP", 44, 22, 37, 700, Bo, 3);
  }), c("lift", 240, 90, () => {
    h("LIFT", 54, 76, 30, 700, Bo, 4), h("HERE", 30, 80, 70, 700, Bo, 6), n.lineWidth = 9, m(34, 82, 34, 12, 12);
  }), c("chg", 330, 130, () => {
    n.lineWidth = 5, n.beginPath(), n.arc(58, 64, 46, 0, h7), n.stroke(), u(58, 64, 58, Bo), h("CHARGE", 44, 122, 40, 700, Bo, 2), h("58 V DC  20 A", 30, 124, 80, 700, Bo), h("DC ONLY", 22, 124, 110, 600, Bo, 3);
  }), c("batt", 440, 120, () => {
    h("BP-58", 66, 6, 38, 700, Bo, 2), h("LI-ION  58 V  12.4 Ah  720 Wh", 24, 8, 84, 600, Bo), h("GH-ARMS  \xB7  DO NOT CRUSH OR PUNCTURE", 17, 8, 108, 600, Bo), n.lineWidth = 4, n.strokeRect(330, 10, 98, 52), n.fillRect(428, 26, 8, 20), h("+", 40, 366, 36, 700, Bo);
  }), c("laser", 400, 96, (g, b) => {
    n.fillStyle = k2, n.fillRect(0, 0, g, b), n.fillStyle = to, n.fillRect(5, 5, g - 10, 30), h("CAUTION", 24, 150, 21, 700, k2, 3), h("CLASS 1 LASER PRODUCT", 23, 12, 54, 700, to), h("LIDAR 905 nm \xB7 IR ILLUMINATOR 850 nm", 16, 12, 80, 600, to);
  }), c("estop", 190, 190, (g, b) => {
    n.fillStyle = k2, n.beginPath(), n.arc(95, 95, 92, 0, h7), n.fill(), n.fillStyle = to, n.font = i(24, 700), n.textAlign = "center";
    let v = "EMERGENCY STOP \xB7 EMERGENCY STOP \xB7 ";
    for (let y = 0; y < v.length; y++) {
      let M = y / v.length * h7;
      n.save(), n.translate(95 + Math.sin(M) * 72, 95 - Math.cos(M) * 72), n.rotate(M), n.fillText(v[y], 0, 0), n.restore();
    }
  }), c("belt", 300, 60, () => {
    h("BELT TENSION  45 N", 26, 4, 20, 700, Kp), h("CHECK EVERY 200 H", 18, 4, 46, 600, Kp, 1);
  }), c("torque", 240, 40, () => {
    h("M5 \xB7 6.5 Nm \xB7 LOCTITE 243", 18, 4, 21, 600, Kp);
  }), c("sn", 300, 44, () => {
    h("SN GH-K9-004177", 28, 4, 23, 700, Kp, 1);
  }), c("gh", 150, 110, () => {
    n.lineWidth = 7, n.strokeRect(6, 6, 138, 98), h("GH", 72, 26, 58, 700, Bo);
  }), c("ghEng", 300, 70, () => {
    h("GH-ARMS", 54, 4, 38, 700, Kp, 4);
  }), c("arrowFwd", 150, 70, () => {
    n.lineWidth = 10, m(12, 35, 136, 35, 14);
  }), c("fwd", 250, 70, () => {
    h("FWD", 46, 6, 37, 700, Bo, 6), n.lineWidth = 9, m(130, 35, 240, 35, 12);
  }), c("ant", 230, 54, () => {
    h("ANT \xB7 2.4 / 5.8 GHz", 22, 4, 28, 600, Bo);
  }), c("vent", 300, 54, () => {
    h("HOT SURFACE", 30, 54, 28, 700, k2, 2), d(24, 28, 42, k2, to), h("!", 22, 19, 32, 700, to);
  }), c("idx", 60, 60, () => {
    n.fillStyle = Bo, n.beginPath(), n.moveTo(30, 6), n.lineTo(54, 54), n.lineTo(6, 54), n.closePath(), n.fill();
  }), c("white", 48, 48, (g, b) => {
    n.fillStyle = Bo, n.fillRect(0, 0, g, b);
  }), c("redLine", 48, 48, (g, b) => {
    n.fillStyle = At0, n.fillRect(0, 0, g, b);
  }), c("yel", 48, 48, (g, b) => {
    n.fillStyle = k2, n.fillRect(0, 0, g, b);
  }), c("legFL", 150, 70, () => {
    h("FL", 54, 8, 37, 700, Bo, 4);
  }), c("legFR", 150, 70, () => {
    h("FR", 54, 8, 37, 700, Bo, 4);
  }), c("legHL", 150, 70, () => {
    h("HL", 54, 8, 37, 700, Bo, 4);
  }), c("legHR", 150, 70, () => {
    h("HR", 54, 8, 37, 700, Bo, 4);
  }), c("cam", 260, 44, () => {
    h("STEREO \xB7 IR \xB7 LIDAR", 22, 4, 23, 600, Kp, 1);
  }), c("skid", 380, 60, () => {
    h("SKID PLATE  \xB7  REPLACE AT WEAR MARK", 19, 4, 20, 600, Kp), n.fillStyle = Kp, n.fillRect(4, 40, 360, 4);
  }), c("qr", 120, 120, (g, b) => {
    n.fillStyle = Bo, n.fillRect(0, 0, g, b);
    let v = Re(5);
    n.fillStyle = to;
    for (let y = 0; y < 12; y++) for (let M = 0; M < 12; M++) v() < 0.48 && n.fillRect(12 + M * 8, 12 + y * 8, 8, 8);
    for (let [y, M] of [[12, 12], [76, 12], [12, 76]]) n.fillStyle = to, n.fillRect(y, M, 32, 32), n.fillStyle = Bo, n.fillRect(y + 6, M + 6, 20, 20), n.fillStyle = to, n.fillRect(y + 11, M + 11, 10, 10);
  });
  let x = new THREE.CanvasTexture(s);
  return x.anisotropy = 8, x.colorSpace = THREE.SRGBColorSpace, x.channel = 1, x.wrapS = x.wrapT = THREE.ClampToEdgeWrapping, x.premultiplyAlpha = true, { tex: x, cells: e };
}
function f7() {
  if (c7) return c7;
  const o = typeof performance !== 'undefined' ? performance.now() : 0;
  const s = fC ? makeNodeFlatTex(128, 128, 128, false) : _t0();
  const i = fC ? makeNodeFlatTex(128, 64, 128, false) : Rt0();
  const r = kt0();
  const marksTex = r.tex || makeNodeFlatTex(0, 0, 0, true);
  if (!r.tex) marksTex.image.data.fill(0);
  c7 = {
    detail: s,
    mask: i,
    marks: marksTex,
    cells: r.cells,
    parts: [0, 0, 0],
    ms: (typeof performance !== 'undefined' ? performance.now() : 0) - o,
    bytes: 0,
  };
  return c7;
}
var wi = (o2, t, e = {}) => us(o2, t, { b: 0.8, cs: 2, ...e }), j5 = (o2, t, e = {}) => si(o2, t, { b: 0.8, cs: 2, ...e }), d7 = (o2, t, e = {}) => jc(o2, t, { b: 0.8, cs: 2, ...e }), $5 = (o2, t, e = 0, s = 0, n = 0) => [[s - o2 / 2, n - t / 2, e], [s + o2 / 2, n - t / 2, e], [s + o2 / 2, n + t / 2, e], [s - o2 / 2, n + t / 2, e]], uC = (o2, t, e = 0, s = 0, n = 0) => Array.from({ length: o2 }, (i, a) => [s + Math.cos(e + a / o2 * Pn) * t, n + Math.sin(e + a / o2 * Pn) * t]), dC = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, pC = (o2, t, e) => {
  let s = dC((e - o2) / (t - o2), 0, 1);
  return s * s * (3 - 2 * s);
};
function Nn(o2, t, e, s = {}) {
  return _c(cn(o2, { seg: 16, ...s }), t, e);
}
function h1(o2, t, e, s, n, i = {}) {
  let a = i.c ?? Math.min(1.2, o2 * 0.12), r = i.cap0 !== false, l = i.cap1 !== false, c = [];
  return r && c.push([t, i.bore || 0]), c.push([t, o2 - a], [t + a, o2, 1], [e - a, o2], [e, o2 - a, 1]), l && c.push([e, i.bore || 0]), Nn(c, s, n, i);
}
function Ct0(o2, t = {}) {
  let e = o2.length, s = o2[0].length, n = t.closed !== false, i = Math.cos((t.crease ?? 34) * Hs), a = n ? s : s - 1, r = new Float32Array((e - 1) * a * 3), l = 0, c = 0, h = 0;
  for (let x of o2) for (let g of x) l += g[0], c += g[1], h += g[2];
  l /= e * s, c /= e * s, h /= e * s;
  let f = 0;
  for (let x = 0; x < e - 1; x++) for (let g = 0; g < a; g++) {
    let b = o2[x][g], v = o2[x][(g + 1) % s], y = o2[x + 1][(g + 1) % s], M = o2[x + 1][g], w = y[0] - b[0], T = y[1] - b[1], S = y[2] - b[2], E = M[0] - v[0], _ = M[1] - v[1], R = M[2] - v[2], C = T * R - S * _, L = S * E - w * R, A = w * _ - T * E, O = Math.hypot(C, L, A) || 1;
    C /= O, L /= O, A /= O;
    let H = (x * a + g) * 3;
    r[H] = C, r[H + 1] = L, r[H + 2] = A, f += C * ((b[0] + y[0]) / 2 - l) + L * ((b[1] + y[1]) / 2 - c) + A * ((b[2] + y[2]) / 2 - h);
  }
  let u = t.flip != null ? t.flip : f < 0, d = u ? -1 : 1, m = new $c(), p = (x, g, b, v) => {
    let y = (b * a + v) * 3, M = r[y], w = r[y + 1], T = r[y + 2], S = 0, E = 0, _ = 0;
    for (let C = -1; C <= 0; C++) for (let L = -1; L <= 0; L++) {
      let A = x + C, O = g + L;
      if (A < 0 || A >= e - 1) continue;
      if (n) O = (O + a) % a;
      else if (O < 0 || O >= a) continue;
      let H = (A * a + O) * 3;
      r[H] * M + r[H + 1] * w + r[H + 2] * T > i && (S += r[H], E += r[H + 1], _ += r[H + 2]);
    }
    let R = Math.hypot(S, E, _) || 1;
    return [S / R * d, E / R * d, _ / R * d];
  };
  for (let x = 0; x < e - 1; x++) for (let g = 0; g < a; g++) {
    let b = (g + 1) % s, v = o2[x][g], y = o2[x][b], M = o2[x + 1][b], w = o2[x + 1][g], T = v[3] && w[3] || t.flagRing && t.flagRing(x) ? 2 : 1, S = [p(x, g, x, g), p(x, g + 1, x, g), p(x + 1, g + 1, x, g), p(x + 1, g, x, g)];
    u ? m.quad(v, w, M, y, [S[0], S[3], S[2], S[1]], null, T) : m.quad(v, y, M, w, S, null, T);
  }
  for (let [x, g, b] of [[t.capA, o2[0], o2[1]], [t.capB, o2[e - 1], o2[e - 2]]]) {
    if (!x) continue;
    let v = [0, 0, 0], y = [0, 0, 0];
    for (let M = 0; M < s; M++) for (let w = 0; w < 3; w++) v[w] += g[M][w] / s, y[w] += b[M][w] / s;
    for (let M = 0; M < s; M++) {
      let w = g[M], T = g[(M + 1) % s], S = w[0] - v[0], E = w[1] - v[1], _ = w[2] - v[2], R = T[0] - v[0], C = T[1] - v[1], L = T[2] - v[2], A = E * L - _ * C, O = _ * R - S * L, H = S * C - E * R;
      A * (v[0] - y[0]) + O * (v[1] - y[1]) + H * (v[2] - y[2]) >= 0 ? m.tri(v, w, T) : m.tri(v, T, w);
    }
  }
  return m.geo();
}
var Z5 = (o2, t) => Ct0(o2.map((e) => e.map((s) => [s[0], s[1], -s[2], s[3]])), t);
function ya(o2, t, e, s, n = "xy", i = 0, a = 0, r = null) {
  let l = o2 / 2, c = t / 2, h = r || [e, e, e, e];
  return [[l, c - h[0], 1], [l - h[0], c, 0], [-l + h[1], c, 1], [-l, c - h[1], 0], [-l, -c + h[2], 1], [-l + h[2], -c, 0], [l - h[3], -c, 1], [l, -c + h[3], 0]].map((u) => {
    let d = i + u[0], m = a + u[1];
    return n === "xy" ? [d, m, s, u[2]] : n === "xu" ? [d, s, m, u[2]] : [s, m, d, u[2]];
  });
}
function X4(o2, t = 6, e = {}) {
  let s = e.c ?? 1.6, n = e.half || 0, i = o2.length, a = Math.sign(o2[i - 1].u - o2[0].u) || 1, r = (u, d, m) => {
    let p = n ? u.P.map((E) => [E[0] * n, E[1]]) : [...u.P.map((E) => [E[0], E[1]]), ...u.P.slice().reverse().map((E) => [-E[0], E[1]])];
    n < 0 && p.reverse();
    let x = p.length, g = u.t ?? t, b = [];
    for (let E = 0; E < x; E++) {
      let _ = p[Math.max(0, E - 1)], R = p[Math.max(0, E - 1) + 1], C = p[Math.min(x - 2, E)], L = p[Math.min(x - 2, E) + 1], A = -(R[1] - _[1]), O = R[0] - _[0], H = -(L[1] - C[1]), F = L[0] - C[0], P = Math.hypot(A, O) || 1, z = Math.hypot(H, F) || 1;
      A /= P, O /= P, H /= z, F /= z;
      let k = A + H, I = O + F, G = Math.hypot(k, I) || 1;
      k /= G, I /= G;
      let K = g / Math.max(0.5, k * A + I * O);
      b.push([p[E][0] + k * K, p[E][1] + I * K]);
    }
    if (m) for (let E = 0; E < x; E++) {
      let _ = b[E][0] - p[E][0], R = b[E][1] - p[E][1], C = Math.hypot(_, R) || 1;
      p[E] = [p[E][0] + _ / C * m, p[E][1] + R / C * m], b[E] = [b[E][0] - _ / C * m * 0.5, b[E][1] - R / C * m * 0.5];
    }
    let v = (E, _, R) => {
      let C = _[0] - E[0], L = _[1] - E[1], A = Math.hypot(C, L) || 1;
      return [E[0] + C / A * R, E[1] + L / A * R];
    }, y = v(p[0], p[1], s), M = v(p[0], b[0], s), w = v(p[x - 1], p[x - 2], s), T = v(p[x - 1], b[x - 1], s), S = [];
    S.push([M[0], M[1], d, 1], [y[0], y[1], d, 0]);
    for (let E = 1; E < x - 1; E++) S.push([p[E][0], p[E][1], d, 0]);
    S.push([w[0], w[1], d, 1], [T[0], T[1], d, 1]);
    for (let E = x - 1; E >= 0; E--) S.push([b[E][0], b[E][1], d, E === 0 ? 1 : 0]);
    return S.m = x, S;
  }, l = [r(o2[0], o2[0].u, s)];
  for (let u = 0; u < i; u++) l.push(r(o2[u], u === 0 ? o2[0].u + a * s : u === i - 1 ? o2[u].u - a * s : o2[u].u, 0));
  l.push(r(o2[i - 1], o2[i - 1].u, s));
  let c = l.length, h = Z5(l, { crease: e.crease ?? 30, flip: a > 0, flagRing: (u) => u === 0 || u === c - 2 }), f = new $c();
  for (let [u, d] of [[l[0], -a], [l[c - 1], a]]) {
    let m = u.m, p = u.length, x = u.slice(0, m + 2), g = [u[p - 1]];
    for (let y = 0; y < m; y++) g.push(u[p - 1 - y]);
    g.push(u[m + 2]);
    let b = (y) => [y[0], y[1], -y[2]], v = [[0, 0, -d], [0, 0, -d], [0, 0, -d], [0, 0, -d]];
    for (let y = 0; y < m + 1; y++) {
      let M = b(x[y]), w = b(x[y + 1]), T = b(g[y + 1]), S = b(g[y]), E = w[0] - M[0], _ = w[1] - M[1], R = S[0] - M[0], C = S[1] - M[1];
      E * C - _ * R > 0 == -d > 0 ? f.quad(M, w, T, S, v, null, 1) : f.quad(M, S, T, w, v, null, 1);
    }
  }
  return [h, f.geo()];
}
function p7(o2, t, e, s, n, i, a = 8) {
  let r = s - o2, l = n - t, c = Math.hypot(r, l), h = Math.atan2(l, r), f = Math.acos(dC((e - i) / c, -1, 1)), u = [];
  for (let m = 0; m <= a; m++) {
    let p = h + f + (Pn - 2 * f) * m / a;
    u.push([o2 + Math.cos(p) * e, t + Math.sin(p) * e]);
  }
  let d = Math.max(2, Math.round(a * 0.75));
  for (let m = 0; m <= d; m++) {
    let p = h - f + 2 * f * m / d;
    u.push([s + Math.cos(p) * i, n + Math.sin(p) * i]);
  }
  return u;
}
function xB(o2 = 5, t = 2.2, e = 0.3) {
  let s = o2 / 2 / Math.cos(Math.PI / 6), n = new $c(), i = [0, 0, t];
  for (let a = 0; a < 6; a++) {
    let r = e + a / 6 * Pn, l = e + (a + 1) / 6 * Pn, c = [Math.cos(r) * s, Math.sin(r) * s, 0], h = [Math.cos(l) * s, Math.sin(l) * s, 0], f = [c[0] * 0.9, c[1] * 0.9, t], u = [h[0] * 0.9, h[1] * 0.9, t];
    n.quad(c, h, u, f, null, null, 2), n.tri(i, f, u, null, null, 1);
  }
  return n.geo();
}
var Pt0 = (o2) => {
  let t = new THREE.Color(o2);
  return [t.r, t.g, t.b];
}, ar = (o2, t, e, s = {}) => ({ c: Pt0(o2), m: t, r: e, nrm: 0.3, weave: 0, wear: 0.05, edge: 0.5, dust: 0.25, paint: 0, team: 0, ...s }), bB = { armor: ar(16777215, 0, 0.5, { nrm: 0.34, paint: 1, wear: 0.05, edge: 0.36, dust: 0.14 }), armorDk: ar(10132122, 0, 0.56, { nrm: 0.34, paint: 1, wear: 0.05, edge: 0.36, dust: 0.16 }), frame: ar(4540235, 0.72, 0.46, { nrm: 0.16, wear: 0.02, edge: 0.24, dust: 0.16 }), frameDk: ar(3750461, 0.6, 0.55, { nrm: 0.2, wear: 0.03, edge: 0.5, dust: 0.3 }), metal: ar(11843256, 1, 0.33, { nrm: 0.1, wear: 0, edge: 0.25, dust: 0.1 }), steel: ar(7303540, 0.95, 0.38, { nrm: 0.14, wear: 0.02, edge: 0.4, dust: 0.12 }), oxide: ar(4276804, 0.85, 0.44, { nrm: 0.14, wear: 0.04, edge: 0.4, dust: 0.1 }), carbon: ar(4013633, 0.3, 0.3, { nrm: 0, weave: 1, wear: 0.02, edge: 0.3, dust: 0.14 }), rubber: ar(3750202, 0, 0.9, { nrm: 0.8, wear: 0, edge: 0, dust: 0.3 }), sleeve: ar(3947582, 0, 0.78, { nrm: 0.7, wear: 0, edge: 0, dust: 0.2 }), hv: ar(13081118, 0, 0.55, { nrm: 0.3, wear: 0, edge: 0, dust: 0.3 }), poly: ar(4342598, 0, 0.62, { nrm: 0.4, wear: 0.03, edge: 0.3, dust: 0.18 }), glass: ar(3816770, 0, 0.06, { nrm: 0, wear: 0, edge: 0, dust: 0.08 }), coat: ar(5913190, 0.6, 0.08, { nrm: 0, wear: 0, edge: 0, dust: 0.05 }), ceramic: ar(14276300, 0, 0.28, { nrm: 0.1, wear: 0, edge: 0, dust: 0.35 }), brass: ar(12159548, 1, 0.3, { nrm: 0.1, wear: 0, edge: 0.2, dust: 0.15 }), tungsten: ar(9277331, 1, 0.26, { nrm: 0.1, wear: 0, edge: 0.2, dust: 0.05 }), red: ar(11871772, 0, 0.45, { nrm: 0.2, wear: 0.04, edge: 0.5, dust: 0.2 }), lamp: ar(5790044, 0, 0.35, { nrm: 0, wear: 0, edge: 0, dust: 0.05 }), stripe: ar(16777215, 0, 0.5, { nrm: 0.34, paint: 1, wear: 0.1, edge: 0.5, dust: 0.14, team: 1 }) }, Cf = (o2, t) => ({ ...bB[o2], ...t }), nv = 16, Da = class {
  constructor(t) {
    this.name = t, this.n = 0, this.cap = 0, this.pos = this.nrm = this.col = this.uv = this.uv1 = this.at = null, this.grow(3e3);
  }
  grow(t) {
    if (t <= this.cap) return;
    let e = Math.max(t, this.cap * 2), s = (n, i) => {
      let a = new Float32Array(e * i);
      return n && a.set(n.subarray(0, this.n * i)), a;
    };
    this.pos = s(this.pos, 3), this.nrm = s(this.nrm, 3), this.col = s(this.col, 3), this.uv = s(this.uv, 2), this.uv1 = s(this.uv1, 2), this.at = s(this.at, nv), this.cap = e;
  }
  get tris() {
    return this.n / 3;
  }
  put(t, e, s = {}) {
    let n = typeof t == "string" ? bB[t] : t;
    if (!n) throw new Error("k9: unknown look " + t);
    for (let i of Array.isArray(e) ? e : [e]) {
      if (!i) continue;
      let a = i.index ? i.toNonIndexed() : i, r = a.attributes.position, l = a.attributes.normal, c = a.attributes.color, h = a.attributes.uv, f = r.count;
      this.grow(this.n + f);
      let u = s.color || n.c;
      for (let d = 0; d < f; d++) {
        let m = this.n + d, p = r.getX(d), x = r.getY(d), g = r.getZ(d);
        this.pos[m * 3] = p, this.pos[m * 3 + 1] = x, this.pos[m * 3 + 2] = g, this.nrm[m * 3] = l.getX(d), this.nrm[m * 3 + 1] = l.getY(d), this.nrm[m * 3 + 2] = l.getZ(d);
        let b = u[0], v = u[1], y = u[2];
        if (s.tint) {
          let S = s.tint(p, x, g);
          S && (b *= S[0], v *= S[1], y *= S[2]);
        }
        this.col[m * 3] = b, this.col[m * 3 + 1] = v, this.col[m * 3 + 2] = y;
        let M = c && c.getX(d) > 1.5, w = m * nv, T = this.at;
        T[w] = s.m ?? n.m, T[w + 1] = s.r ?? n.r, T[w + 2] = s.noAO ? -(s.ao ?? 1) : s.ao ?? 1, T[w + 3] = s.nrm ?? n.nrm, T[w + 4] = Math.min(1, (s.wear ?? n.wear) + (M ? s.edge ?? n.edge : 0)), T[w + 5] = s.dust ?? n.dust, T[w + 6] = n.weave, T[w + 7] = n.paint, T[w + 8] = s.glow || 0, T[w + 9] = s.order || 0, T[w + 10] = s.alert || 0, T[w + 11] = s.self || 0, T[w + 12] = 0, T[w + 13] = s.bias || 0, T[w + 14] = s.team ?? n.team, T[w + 15] = 0, s.uv1 && (this.uv1[m * 2] = h.getX(d), this.uv1[m * 2 + 1] = h.getY(d));
      }
      for (let d = 0; d < f; d += 3) {
        let m = this.n + d, p = this.pos, x = p[m * 3 + 3] - p[m * 3], g = p[m * 3 + 4] - p[m * 3 + 1], b = p[m * 3 + 5] - p[m * 3 + 2], v = p[m * 3 + 6] - p[m * 3], y = p[m * 3 + 7] - p[m * 3 + 1], M = p[m * 3 + 8] - p[m * 3 + 2], w = Math.abs(g * M - b * y), T = Math.abs(b * v - x * M), S = Math.abs(x * y - g * v), E = w >= T && w >= S ? 0 : T >= S ? 1 : 2;
        for (let _ = 0; _ < 3; _++) {
          let R = (m + _) * 3;
          this.uv[(m + _) * 2] = E === 0 ? p[R + 2] : p[R], this.uv[(m + _) * 2 + 1] = E === 1 ? p[R + 2] : p[R + 1];
        }
      }
      this.n += f;
    }
    return this;
  }
  bakeAO(t = {}) {
    let e = yB(this.pos, this.nrm, 0, this.n, t.cell || 4, (s) => this.at[s * nv + 2] < 0, t.strength ?? 1);
    for (let s = 0; s < this.n; s++) {
      let n = s * nv + 2;
      this.at[n] = Math.abs(this.at[n]) * e[s];
    }
    return this.baked = true, this;
  }
};
function yB(o2, t, e, s, n, i, a = 1) {
  let r = new Float32Array(s).fill(1);
  if (!s) return r;
  let l = 1e9, c = 1e9, h = 1e9, f = -1e9, u = -1e9, d = -1e9;
  for (let E = e * 3, _ = (e + s) * 3; E < _; E += 3) o2[E] < l && (l = o2[E]), o2[E] > f && (f = o2[E]), o2[E + 1] < c && (c = o2[E + 1]), o2[E + 1] > u && (u = o2[E + 1]), o2[E + 2] < h && (h = o2[E + 2]), o2[E + 2] > d && (d = o2[E + 2]);
  let m = 2;
  l -= m * n, c -= m * n, h -= m * n;
  let p = Math.ceil((f - l) / n) + m + 1, x = Math.ceil((u - c) / n) + m + 1, g = Math.ceil((d - h) / n) + m + 1, b = new Uint8Array(p * x * g), v = 1 / n;
  for (let E = e; E < e + s; E += 3) {
    let _ = E * 3, R = o2[_], C = o2[_ + 1], L = o2[_ + 2], A = o2[_ + 3] - R, O = o2[_ + 4] - C, H = o2[_ + 5] - L, F = o2[_ + 6] - R, P = o2[_ + 7] - C, z = o2[_ + 8] - L, k = Math.max(Math.hypot(A, O, H), Math.hypot(F, P, z), Math.hypot(A - F, O - P, H - z)), I = Math.max(1, Math.ceil(k * v * 1.25)), G = 1 / I;
    for (let K = 0; K <= I; K++) for (let $ = 0; $ <= I - K; $++) {
      let n0 = K * G, e0 = $ * G, p0 = (R + A * n0 + F * e0 - l) * v | 0, t0 = (C + O * n0 + P * e0 - c) * v | 0, M0 = (L + H * n0 + z * e0 - h) * v | 0;
      b[(M0 * x + t0) * p + p0] = 1;
    }
  }
  let y = [[0, 0, 1, 1]];
  for (let E = 0; E < 6; E++) {
    let _ = E / 6 * Pn;
    y.push([Math.cos(_) * 0.74, Math.sin(_) * 0.74, 0.67, 0.75]);
  }
  for (let E = 0; E < 4; E++) {
    let _ = (E + 0.5) / 4 * Pn;
    y.push([Math.cos(_) * 0.38, Math.sin(_) * 0.38, 0.92, 0.9]);
  }
  let M = 0;
  for (let E of y) M += E[3];
  let w = [0.4, 1.5, 3, 5, 8], T = w.length, S = 1.75 * n;
  for (let E = 0; E < s; E++) {
    if (i && i(e + E)) continue;
    let _ = (e + E) * 3, R = t[_], C = t[_ + 1], L = t[_ + 2], A, O, H;
    Math.abs(R) < 0.8 ? (A = 0, O = -L, H = C) : (A = L, O = 0, H = -R);
    let F = Math.hypot(A, O, H) || 1;
    A /= F, O /= F, H /= F;
    let P = C * H - L * O, z = L * A - R * H, k = R * O - C * A, I = (o2[_] + R * S - l) * v, G = (o2[_ + 1] + C * S - c) * v, K = (o2[_ + 2] + L * S - h) * v, $ = 0;
    for (let n0 = 0; n0 < y.length; n0++) {
      let e0 = y[n0], p0 = A * e0[0] + P * e0[1] + R * e0[2], t0 = O * e0[0] + z * e0[1] + C * e0[2], M0 = H * e0[0] + k * e0[1] + L * e0[2];
      for (let f0 = 0; f0 < T; f0++) {
        let _0 = w[f0], F0 = I + p0 * _0 | 0, m0 = G + t0 * _0 | 0, S0 = K + M0 * _0 | 0;
        if (F0 < 0 || m0 < 0 || S0 < 0 || F0 >= p || m0 >= x || S0 >= g) break;
        if (b[(S0 * x + m0) * p + F0]) {
          $ += e0[3] * (1 - f0 / (T + 1.5));
          break;
        }
      }
    }
    r[E] = dC(1 - Math.pow($ / M, 0.85) * 1.15 * a, 0.22, 1);
  }
  return r;
}
var u7 = class {
  constructor(t) {
    this.rest = t, this.items = [], this.n = 0;
  }
  place(t, e, s = {}) {
    return this.items.push({ part: t, bone: e, mx: !!s.mx, mz: !!s.mz }), this.n += t.n, this;
  }
  build(t = [], e = []) {
    let s = this.n, n = new Float32Array(s * 3), i = new Float32Array(s * 3), a = new Float32Array(s * 3), r = new Float32Array(s * 2), l = new Float32Array(s * 2), c = new Uint8Array(s * 4), h = new Uint8Array(s * 4), f = new Uint8Array(s * 4), u = new Uint8Array(s * 4), d = new Uint8Array(s * 4), m = new Uint8Array(s * 4), p = (w) => w <= 0 ? 0 : w >= 1 ? 255 : w * 255 + 0.5 | 0, x = new Float32Array(s), g = new Uint8Array(s), b = /* @__PURE__ */ new Map(), v = 0;
    for (let w of this.items) {
      if (e.includes(w.bone) && !w.part.baked) {
        let A = b.get(w.bone) || [v, v];
        if (A[1] !== v && b.has(w.bone)) throw new Error("k9: AO group of bone " + w.bone + " is not contiguous");
        A[1] = v + w.part.n, b.set(w.bone, A);
      }
      let T = w.part, S = T.n, E = this.rest[w.bone], _ = w.mx ? -1 : 1, R = w.mz ? -1 : 1, C = w.mx !== w.mz, L = t.filter((A) => A.bone === w.bone);
      for (let A = 0; A < S; A++) {
        let O = C ? A - A % 3 + [0, 2, 1][A % 3] : A, H = v + A, F = T.pos[O * 3] * _, P = T.pos[O * 3 + 1], z = T.pos[O * 3 + 2] * R;
        n[H * 3] = F * 1e-3 + E[0], n[H * 3 + 1] = P * 1e-3 + E[1], n[H * 3 + 2] = z * 1e-3 + E[2], i[H * 3] = T.nrm[O * 3] * _, i[H * 3 + 1] = T.nrm[O * 3 + 1], i[H * 3 + 2] = T.nrm[O * 3 + 2] * R, a[H * 3] = T.col[O * 3], a[H * 3 + 1] = T.col[O * 3 + 1], a[H * 3 + 2] = T.col[O * 3 + 2], r[H * 2] = T.uv[O * 2] * 1e-3, r[H * 2 + 1] = T.uv[O * 2 + 1] * 1e-3, l[H * 2] = T.uv1[O * 2], l[H * 2 + 1] = T.uv1[O * 2 + 1];
        let k = O * nv, I = T.at;
        c[H * 4] = p(I[k]), c[H * 4 + 1] = p(I[k + 1]), x[H] = Math.abs(I[k + 2]), g[H] = I[k + 2] < 0 ? 1 : 0, c[H * 4 + 3] = p(I[k + 3]), h[H * 4] = p(I[k + 4]), h[H * 4 + 1] = p(I[k + 5]), h[H * 4 + 2] = p(I[k + 6]), h[H * 4 + 3] = p(I[k + 7]), f[H * 4] = p(I[k + 8]), f[H * 4 + 1] = p(I[k + 9]), f[H * 4 + 2] = p(I[k + 10]), f[H * 4 + 3] = p(I[k + 11]);
        let G = 0;
        for (let K of L) {
          let $ = Math.hypot(F - K.p[0], P - K.p[1], z - K.p[2]), n0 = (1 - pC(K.r * 0.3, K.r, $)) * (K.k ?? 1);
          n0 > G && (G = n0);
        }
        u[H * 4] = p(G), u[H * 4 + 1] = p(I[k + 13]), u[H * 4 + 2] = p(I[k + 14]), u[H * 4 + 3] = 0, d[H * 4] = w.bone, m[H * 4] = 255;
      }
      v += S;
    }
    for (let [, w] of b) {
      let T = yB(n, i, w[0], w[1] - w[0], 4e-3, (S) => g[S] === 1);
      for (let S = w[0]; S < w[1]; S++) x[S] *= T[S - w[0]];
    }
    for (let w = 0; w < s; w++) c[w * 4 + 2] = p(x[w]);
    let y = new THREE.BufferGeometry(), M = (w) => new THREE.BufferAttribute(w, 4, true);
    return y.setAttribute("position", new THREE.BufferAttribute(n, 3)), y.setAttribute("normal", new THREE.BufferAttribute(i, 3)), y.setAttribute("uv", new THREE.BufferAttribute(r, 2)), y.setAttribute("uv1", new THREE.BufferAttribute(l, 2)), y.setAttribute("color", new THREE.BufferAttribute(a, 3)), y.setAttribute("aMat", M(c)), y.setAttribute("aMat2", M(h)), y.setAttribute("aFx", M(f)), y.setAttribute("aFx2", M(u)), y.setAttribute("skinIndex", new THREE.BufferAttribute(d, 4, false)), y.setAttribute("skinWeight", M(m)), y;
  }
};
var m7 = { hipX: ue.hipX * 1e3, hipZ: ue.hipZ * 1e3, hipOut: ue.hipOut * 1e3, upper: ue.upper * 1e3, lower: ue.lower * 1e3, foot: ue.foot * 1e3 }, ov = (o2) => {
  let t = new THREE.Color(o2);
  return [t.r, t.g, t.b];
}, zt0 = ov(5570438), Lt0 = ov(16753210), Dt0 = ov(16722456), wB = 0.9;
function Gi(o2, t, e, s, n, i, a, r = {}) {
  let l = t[e];
  if (!l) throw new Error("k9: unknown marking " + e);
  let c = r.h || s / l[4], h = new THREE.PlaneGeometry(s, c), f = h.attributes.uv;
  for (let u = 0; u < f.count; u++) f.setXY(u, l[0] + f.getX(u) * (l[2] - l[0]), l[1] + f.getY(u) * (l[3] - l[1]));
  h.translate(0, 0, r.lift ?? 0.3), o2.put(a, Ie(Qe(h), n, i, r.roll || 0), { uv1: true, bias: 1, noAO: true, ao: r.ao ?? 1, edge: 0, ...r.put });
}
function It0(o2, t, e, s, n, i = {}) {
  let a = new THREE.PlaneGeometry(t, e);
  a.translate(0, 0, i.lift ?? 0.3), o2.put("stripe", Ie(Qe(a), s, n, i.roll || 0), { bias: 1, noAO: true, edge: 0, wear: i.wear ?? 0.16 });
}
var C2 = (o2, t, e, s = {}) => o2.put(s.look || "oxide", Ie(xB(s.af || 5, s.h || 2.2, s.rot ?? 0.3), t, e), { noAO: !!s.noAO }), vB = (o2, t, e = {}) => {
  let s = e.n || 6, n = e.a0 ?? 0, i = e.a1 ?? Math.PI, a = [];
  for (let r = 0; r <= s; r++) {
    let l = n + (i - n) * r / s;
    a.push([-Math.cos(l) * o2, Math.sin(l) * o2]);
  }
  return Nn(a, e.dir || "y+", t, { seg: e.seg || 12, crease: 60 });
}, Ia = (o2, t, e, s) => Qe(new THREE.BoxGeometry(o2, t, e)).translate(s[0], s[1], -s[2]);
function MB(o2, t, e, s, n, i, a) {
  let r = new $c(), l = [a - i / 2, s, -o2], c = [a - i / 2, s, -t], h = [a - i / 2 + i * 0.2, n, -e], f = [a + i / 2, s, -o2], u = [a + i / 2, s, -t], d = [a + i / 2 - i * 0.2, n, -e], m = [a, (s + n) / 2, -(o2 + t) / 2];
  r.quadFacing(l, c, u, f, m, 1, true), r.quadFacing(l, h, d, f, m, 2, true), r.quadFacing(c, h, d, u, m, 2, true);
  for (let [p, x, g] of [[l, c, h], [f, u, d]]) (x[1] - p[1]) * (g[2] - p[2]) - (x[2] - p[2]) * (g[1] - p[1]) > 0 == p[0] > a ? r.tri(p, x, g) : r.tri(p, g, x);
  return r.geo();
}
function Ht0(o2) {
  let t = new Da("core"), e = new Da("quad"), s = new Da("end"), n = new Da("side");
  t.put("frame", j5([[-70, -56], [-56, -70], [56, -70], [70, -56], [70, 42], [56, 56], [-56, 56], [-70, 42]], 744, { u: -372, b: 1.6 })), t.put("frame", wi([[358, -68], [386, -22, 3], [386, 22, 2], [362, 22]], 112, { b: 1.6 })), t.put("armor", wi([[400, 6, 2], [389, 6, 1.5], [340, -72, 1.5], [353, -76, 2]], 118, { b: 1.8 })), t.put("frame", wi([[-360, -66], [-390, -40, 3], [-390, 40, 3], [-362, 56]], 116, { b: 1.6 })), t.put("armor", wi([[-390, 34, 2], [-398, 30, 2], [-398, -34, 2], [-390, -40, 2]], 122, { b: 1.6 }));
  for (let p of [-1, 1]) {
    t.put("frame", wi([[366, 12], [392, 13, 5], [397, 22, 5], [393, 31, 4], [366, 37]], 11, { x: p * 50, b: 1.4, cs: 1 }));
    for (let x of [374, 388]) C2(t, [p * 55.5, 23, x], p > 0 ? "R" : "L", { af: 6, h: 2 });
  }
  t.put("frameDk", wi([[366, 10], [393, 10, 4], [393, 18], [366, 22]], 90, { b: 1, cs: 1 })), t.put("poly", Z5([ya(118, 16, 5, -200, "xy", 0, -79), ya(150, 42, 9, -178, "xy", 0, -92), ya(150, 42, 9, 178, "xy", 0, -92), ya(118, 16, 5, 200, "xy", 0, -79)], { capA: true, capB: true, crease: 40 }));
  let i = Cf("steel", { wear: 0.3, edge: 0.6, dust: 0.4, r: 0.5 });
  t.put(i, d7([[-58, -168, 14], [58, -168, 14], [66, -120], [66, 120], [58, 168, 14], [-58, 168, 14], [-66, 120], [-66, -120]], 5, { y: -118.5, b: 1.2, cs: 1, holes: [$5(12, 62, 0, 0, -92), $5(12, 62, 0, 0, 92), uC(6, 6, 0, -34, 0), uC(6, 6, 0, 34, 0)] }));
  for (let p of [-1, 1]) t.put(Cf("steel", { wear: 0.5, edge: 0.5, dust: 0.4, r: 0.48 }), wi([[-156, -118], [-144, -127, 3], [144, -127, 3], [156, -118]], 11, { x: p * 47, b: 1.5, cs: 1 }));
  for (let [p, x] of [[-56, -150], [56, -150], [-56, 150], [56, 150]]) C2(t, [p, -118.5, x], "D", { af: 7, h: 2 });
  Gi(t, o2, "skid", 96, [0, -118.5, 30], "D", i);
  let a = [[120, 31], [120, 50], [116.5, 60], [111, 68], [104.5, 73], [97, 76]];
  t.put("armor", X4([{ u: -130, P: a }, { u: 130, P: a }], 7)), t.put("poly", j5([[-57, 74], [57, 74], [57, 97, 5], [50, 104, 5], [-50, 104, 5], [-57, 97, 5]], 190, { u: -110, b: 2, cs: 1 }), { r: 0.5 }), t.put("frameDk", Ia(86, 2, 150, [0, 104.6, -17])), Gi(t, o2, "batt", 104, [0, 105.6, -26], "T", "frameDk"), Gi(t, o2, "qr", 20, [-36, 105.6, 34], "T", "frameDk");
  for (let p = 0; p < 5; p++) t.put("lamp", Ia(7, 1.6, 3.2, [-24 + p * 12, 104.4, 70]), p < 4 ? { self: 1, order: 0.04 + p * 0.05, color: zt0, noAO: true } : { noAO: true });
  t.put("red", wi([[80, 84], [86, 84, 1.5], [86, 96, 1.5], [80, 96]], 26, { b: 1, cs: 1 })), t.put("frame", Ia(44, 22, 3, [0, 89, 81.5]));
  for (let p of [-1, 1]) t.put("poly", Ia(3, 10, 9, [p * 6.5, 109, -101]));
  t.put("frame", d7([[-46, -198, 5], [46, -198, 5], [46, -142, 5], [-46, -142, 5]], 7, { y: 78, b: 1.5, cs: 1, holes: [$5(76, 42, 0, 0, -170)] })), t.put("frameDk", Ia(80, 1, 46, [0, 78.9, -170]), { ao: 0.45, noAO: true });
  let r = (p) => {
    let x = Math.exp(-(p * p) / 900);
    return [1 + 0.25 * x, 0.86 + 0.1 * (1 - x), 0.62 + 0.75 * (1 - x) * 0.5];
  };
  for (let p = 0; p < 5; p++) t.put(Cf("steel", { r: 0.34 }), wi([[-188 + p * 9.4, 80.5], [-186.4 + p * 9.4, 80.5], [-181.4 + p * 9.4, 85.6], [-183 + p * 9.4, 85.6]], 76, { b: 0.3 }), { tint: r });
  Gi(t, o2, "vent", 46, [-70, 78.3, -170], "T", "armor", { roll: 90 }), t.put(Cf("steel", { r: 0.42 }), Mh([[0, 76, -212], [0, 92, -216], [0, 101, -230], [0, 101, -306], [0, 92, -320], [0, 76, -324]], 5.2, { seg: 12, radial: 6 })), t.put("rubber", h1(7.4, -300, -236, "u+", [0, 101, 0], { seg: 8, c: 1.2 }));
  for (let p of [-212, -324]) t.put("frame", h1(10, 0, 4.5, "y+", [0, 78, p], { seg: 8, c: 1 }));
  Gi(t, o2, "lift", 40, [-32, 78.3, -268], "T", "armor", { roll: 90 }), t.put("frame", h1(15, 0, 6, "y+", [0, 71, -380], { seg: 10, c: 1.5 })), Gi(t, o2, "ant", 44, [-40, 78.3, -352], "T", "armor", { roll: 180 }), t.put("metal", Nn([[0, 19], [5, 19], [6.5, 17.5, 1], [6.5, 14], [-3, 13], [-3, 0]], "u-", [0, -4, -398], { seg: 12 })), t.put("lamp", Nn([[6.9, 17], [6.9, 14.6]], "u-", [0, -4, -398], { seg: 12 }), { self: 0.35, order: 0.3, color: Lt0, noAO: true });
  for (let p = 0; p < 3; p++) {
    let x = p / 3 * Pn + 0.5;
    t.put("brass", h1(2, -3, 3, "u-", [Math.cos(x) * 6.5, -4 + Math.sin(x) * 6.5, -398], { seg: 5, c: 0.6 }));
  }
  Gi(t, o2, "chg", 30, [41, -24, -398], "B", "armor"), t.put("red", Nn([[0, 6], [5, 6], [6, 11], [10, 12, 1], [12, 9, 1], [12, 0]], "u-", [-41, -8, -398], { seg: 10 })), Gi(t, o2, "estop", 34, [-41, -8, -398], "B", "armor"), Gi(t, o2, "plate", 36, [41, -3, -398], "B", "armor", { lift: 0.5 });
  for (let p of [-1, 1]) t.put("lamp", Ia(28, 6, 1.6, [p * 41, 23.5, -398.6]), { glow: 1, order: 0.62, noAO: true });
  let l = [[0, -0.497, -0.868], [0, 1, 0]], c = (p, x) => [p, x, 400 - 47 * (6 - x) / 82];
  Gi(t, o2, "unitSm", 54, c(0, -46), l, "armor", { lift: 0.6 });
  for (let p of [-1, 1]) t.put("glass", Ie(Nn([[0, 7], [1.6, 7], [2.2, 6.2, 1], [2.2, 0]], "u-", [0, 0, 0], { seg: 10 }), c(p * 40, -20), l));
  t.put("lamp", Ie(Qe(new THREE.BoxGeometry(62, 3.6, 1.6)), c(0, -8), l), { glow: 1, order: 0.45, noAO: true }), n.put("armorDk", wi([[-128, 27, 3], [128, 27, 3], [128, -28, 3], [106, -52, 5], [-106, -52, 5], [-128, -28, 3]], 9, { x: 115.5, b: 1.6, cs: 1, holes: [$5(62, 30, 0, -80, -10), $5(122, 7.4, 0, 44, 13)] })), n.put("frameDk", Ia(2, 38, 70, [107, -10, -80]), { ao: 0.4, noAO: true });
  for (let p = 0; p < 5; p++) {
    let x = 1 - p * 6.2;
    n.put(Cf("steel", { r: 0.36 }), j5([[108.5, x + 1.5], [118.6, x - 4.2], [118.6, x - 5.7], [108.5, x]], 60, { u: -110, b: 0.3 }), { tint: () => [1.06, 0.9, 0.74] });
  }
  n.put("lamp", Ia(3, 5.6, 120, [115.8, 13, 44]), { glow: 1, order: 0.3, noAO: true }), n.put("frameDk", Ia(1.5, 11, 126, [111.5, 13, 44]), { noAO: true, ao: 0.5 });
  for (let [p, x] of [[-120, 19], [120, 19], [-120, -24], [120, -24], [0, -44]]) C2(n, [120, x, p], "R", { af: 5.5, h: 1.8 });
  {
    let p = [[-62, 76], [-62, 80.2]];
    for (let x = -59.6; x + 5.2 < 61; x += 10) p.push([x, 80.2], [x, 83.5], [x + 5.2, 83.5], [x + 5.2, 80.2]);
    p.push([62, 80.2], [62, 76]), n.put(Cf("frame", { wear: 0.14, edge: 0.7 }), wi(p, 20.6, { x: 80, b: 0 }));
  }
  let h = m7.hipX, f = 138, u = 251;
  e.put("frame", Nn([[f, 0], [f, 35], [f + 5, 41, 1], [f + 30, 41], [f + 30, 44], [f + 56, 44], [f + 56, 40.5], [f + 66, 40.5], [f + 66, 44], [u - 15, 44]], "u+", [h, 0, 0], { seg: 14 })), e.put("metal", Nn([[u - 15, 44], [u - 15, 47], [u - 2, 47], [u, 45, 1], [u, 30]], "u+", [h, 0, 0], { seg: 14 })), e.put("frame", j5([[62, -30], [98, -36], [104, -8], [104, 30], [62, 36]], 96, { u: 146, b: 1.6 })), e.put("metal", h1(7.5, 0, 7, "u-", [h - 4, -22, f], { seg: 7, c: 1 })), e.put("sleeve", Mh([[64, -62, 96], [86, -58, 108], [108, -44, 118], [h - 4, -26, 124], [h - 4, -22, 132]], 4.6, { seg: 8, radial: 5 }));
  for (let p of [0.6, 2.2, 3.9, 5.4]) C2(e, [h + Math.cos(p) * 26, Math.sin(p) * 26, f], "B", { af: 5, h: 2 });
  let d = [[146, 42], [145, 47], [139.5, 54.5], [130, 61], [102, 72.5], [60, 78]], m = [[76, 45], [76, 56], [72, 64], [66, 71], [58, 76], [46, 78]];
  s.put("armor", X4([{ u: 136, P: d }, { u: 196, P: d }, { u: 221, P: [[104, 41], [104, 54], [97, 63], [86, 70], [71, 76], [53, 78]] }, { u: 235, P: m }, { u: 368, P: m }, { u: 390, P: [[56, 46], [56, 53], [53, 60], [48, 66], [42, 70], [34, 72]] }], 6));
  for (let p of [-1, 1]) {
    for (let x of [143, 189]) C2(s, [p * 50, 78, x], "T", { af: 6, h: 2 });
    s.put("rubber", Ie(Qe(new THREE.BoxGeometry(22, 40, 1.4)).translate(0, 0, 0.5), [p * 116, 66.75, 166], [[p * 0.38, 0.925, 0], [0, 0, -1]]), { nrm: 1 });
  }
  return s.put("armorDk", j5([[-17, 77.5], [17, 77.5], [13, 81.5], [-13, 81.5]], 96, { u: 270, b: 1 })), { core: t, quad: e, end: s, side: n };
}
function Ft0(o2, t) {
  Gi(o2, t, "brand", 132, [-120, -32, 20], "L", "armorDk"), Gi(o2, t, "brand", 132, [120, -32, -20], "R", "armorDk"), Gi(o2, t, "hazard", 60, [-120, -6, 96], "L", "armorDk", { h: 5 }), Gi(o2, t, "hazard", 60, [120, -6, 96], "R", "armorDk", { h: 5 }), Gi(o2, t, "unit", 70, [0, 78.3, 166], "T", "armor"), o2.put("lamp", Ia(8, 1.6, 70, [0, 81.9, 318]), { glow: 1, order: 0.4, noAO: true });
  for (let e of [-1, 1]) {
    for (let s of [104, -104]) Gi(o2, t, "pinch", 36, [e * 120, -22, s], e > 0 ? "R" : "L", "armorDk");
    for (let s of [166, -166]) Gi(o2, t, "nostep", 32, [e * 116, 66.75, s], [[e * 0.38, 0.925, 0], [0, 0, e > 0 ? -1 : 1]], "rubber", { roll: e > 0 ? -90 : 90, lift: 1.5 });
    for (let s of [148, -148]) {
      let n = [[146, 42], [145, 47], [139.5, 54.5], [130, 61], [102, 72.5], [60, 78], [0, 78]];
      for (let i = 0; i < n.length - 1; i++) {
        let a = n[i], r = n[i + 1], l = r[0] - a[0], c = r[1] - a[1], h = Math.hypot(l, c);
        It0(o2, 20, h, [e * (a[0] + r[0]) / 2, (a[1] + r[1]) / 2, s], [[e * c / h, -l / h, 0], [e * l / h, c / h, 0]], { lift: 0.4 });
      }
    }
  }
}
function Ot0() {
  let o2 = new Da("hip"), t = new Da("upper"), e = new Da("lower"), s = m7.upper, n = m7.lower;
  o2.put("frame", Nn([[-15, 0], [-15, 40], [-11, 45.5, 1], [28, 45.5], [28, 42.5], [33, 42.5], [33, 45.5], [36, 45.5]], "x+", [0, 0, 0], { seg: 16 })), o2.put("metal", Nn([[36, 45.5], [36, 48.5], [47, 48.5], [49.5, 46.5, 1], [49.5, 36]], "x+", [0, 0, 0], { seg: 16 })), o2.put("metal", Nn([[20, 38], [44, 38], [46.5, 42, 1], [48.5, 42]], "u-", [0, 0, 0], { seg: 12 }));
  {
    let i = [];
    for (let r = 0; r <= 8; r++) {
      let l = (-42 + 162 * r / 8) * Hs;
      i.push([Math.cos(l) * 58, Math.sin(l) * 58]);
    }
    for (let r = 8; r >= 0; r--) {
      let l = (-42 + 162 * r / 8) * Hs;
      i.push([Math.cos(l) * 52, Math.sin(l) * 52]);
    }
    o2.put(Cf("armor", { team: 0.92 }), wi(i, 58, { x: 17, b: 1.6, soft: 0.5 }));
  }
  for (let [i, a] of [[0, 20], [34, 20], [0, 100], [34, 100]]) C2(o2, [i, Math.sin(a * Hs) * 58, Math.cos(a * Hs) * 58], [[0, Math.sin(a * Hs), -Math.cos(a * Hs)], [1, 0, 0]], { af: 5.5, h: 1.8 });
  t.put("frame", Nn([[-24, 36], [-24, 44], [-21.5, 46.5, 1], [13, 46.5], [15, 44.5, 1]], "x+", [0, 0, 0], { seg: 16 })), t.put("frame", Nn([[15, 44.5], [20, 44.5], [20, 41], [26, 41], [26, 44.5], [32, 44.5], [32, 41], [38, 41], [38, 44.5], [43, 44.5], [47, 41.5, 1], [52, 38], [56, 33, 1], [56, 31.5]], "x+", [0, 0, 0], { seg: 16 })), t.put("lamp", Nn([[55.4, 31.5], [56.4, 30.6], [56.4, 25.4], [55.4, 24.5]], "x+", [0, 0, 0], { seg: 16 }), { glow: 1, order: 0.5, noAO: true }), t.put("metal", Nn([[55.4, 24.5], [57, 23], [58.5, 21, 1], [58.5, 0]], "x+", [0, 0, 0], { seg: 16 }));
  for (let i = 0; i < 5; i++) {
    let a = i / 5 * Pn + 0.3;
    C2(t, [58.5, Math.sin(a) * 14, Math.cos(a) * 14], "R", { af: 4.6, h: 1.6, noAO: true });
  }
  t.put("armor", wi(p7(0, 0, 41, 0, -s, 31, 7), 17, { x: 23, b: 1.8, soft: 0.5 })), t.put("armorDk", wi(p7(0, -34, 24, 0, -s, 19, 5), 3, { x: 32.6, b: 1.2, soft: 0.5 })), t.put("lamp", Ia(1.6, 64, 4.2, [34.6, -150, 0]), { glow: 1, order: 0.55, noAO: true });
  for (let [i, a] of [[14, -78], [-14, -78], [11, -236], [-11, -236]]) C2(t, [34.1, a, i], "R", { af: 4.6, h: 1.6 });
  t.put("metal", h1(15, 31.5, 37, "x+", [0, -s, 0], { seg: 10, c: 1.2 })), C2(t, [37, -s, 0], "R", { af: 8, h: 2.4 }), t.put("carbon", wi(p7(0, 0, 39, 0, -s, 29, 7), 12, { x: -19, b: 1.5, soft: 0.5 })), t.put("metal", h1(13, 25, 28.5, "x-", [0, -s, 0], { seg: 10, c: 1.2 })), t.put("carbon", wi([[-36, -24], [35, -24], [31, -128], [-6, -168], [-25, -262], [-33, -258]], 27.5, { x: 0.75, b: 1.2 })), t.put("sleeve", Mh([[0, -8, -41], [0, -70, -39.4], [0, -180, -37.8], [0, -256, -36.4], [0, -290, -27]], 3.5, { seg: 8, radial: 5 })), t.put("frame", Ia(27, 8, 5, [0.75, -120, -40.2])), t.put("frame", Ia(27, 8, 5, [0.75, -225, -38.6])), e.put("frame", Nn([[-13, 0], [-13, 24.5], [-11.5, 26.5, 1], [11.5, 26.5], [13, 24.5, 1], [13, 0]], "x+", [0, 0, 0], { seg: 12 })), e.put("carbon", Z5([ya(22, 42, 4, -6, "xu", 0, -1), ya(22, 55, 5, -56, "xu", 0, -9.5), ya(21, 45, 5, -138, "xu", 0, -6.5), ya(20, 29, 4, -232, "xu", 0, -0.5), ya(20, 26, 4, -296, "xu", 0, 0)], { capA: true, capB: true, crease: 40 })), e.put("armor", Z5([ya(27, 30, 5, -178, "xu", 0, 1.5), ya(31, 37, 6, -184, "xu", 0, 1.5), ya(31, 38, 6, -262, "xu", 0, 0.5), ya(28, 33, 5, -290, "xu", 0, 0)], { capA: true, capB: true, crease: 40 }), { dust: 0.35 }), e.put("lamp", Ia(1.4, 44, 3.4, [15.6, -224, 0]), { glow: 1, order: 0.7, noAO: true }), e.put("metal", Nn([[-52, 15.5], [-49, 17.5, 1], [-41, 19], [-38, 21.5], [-34, 21.5], [-32.5, 20, 1]], "y-", [0, -n, 0], { seg: 12 }));
  {
    let i = m7.foot, a = [[-33, 19.5]], r = 2.2;
    for (let [l, c] of [[56, 0], [74, 0], [92, 0], [104, 0], [106, 1], [111, 1], [113, 0], [124, 0], [126, 1], [131, 1], [133, 0], [146, 0], [160, 0], [172, 0], [180, 0]]) {
      let h = l * Hs, f = i - c * r;
      a.push([-Math.cos(h) * f, Math.max(0, Math.sin(h) * f)]);
    }
    e.put("rubber", Nn(a, "y-", [0, -n, 0], { seg: 16, crease: 50 }), { tint: (l, c) => {
      let h = pC(-n - 8, -n - 34, c);
      return [1 + 0.9 * h, 1 + 0.8 * h, 1 + 0.65 * h];
    }, dust: 0.5 });
  }
  return e.put("sleeve", Mh([[0, -12, -24], [0, -56, -40], [0, -138, -32], [0, -170, -22.5], [0, -188, -15]], 3.2, { seg: 8, radial: 5 })), e.put("frame", Ia(12, 6, 8, [0, -98, -35])), { hip: o2, upper: t, lower: e };
}
function Nt0(o2, t) {
  let e = new Da("hipMarks"), s = new Da("upperMarks"), n = Ph(o2), i = kf(o2) ? 1 : -1, a = 62 * Hs;
  return Gi(e, t, "leg" + a7[o2], 27, [n * 17, Math.sin(a) * 58, i * Math.cos(a) * 58], [[0, Math.sin(a), -i * Math.cos(a)], [0, Math.cos(a), i * Math.sin(a)]], Cf("armor", { team: 0.92 }), { lift: 0.5 }), Gi(s, t, "belt", 46, [n * 34.1, -212, 0], n > 0 ? "R" : "L", "armorDk", { roll: n > 0 ? -90 : 90, lift: 0.25 }), { hipM: e, upM: s };
}
function Bt0(o2) {
  let t = new Da("neck"), e = new Da("head"), s = new Da("jaw"), n = new Da("ear");
  t.put(Cf("frame", { r: 0.3 }), vB(38, [0, 0, 0], { dir: "x+", n: 7, seg: 12 }));
  let i = new THREE.Vector3(0, 60, -100).normalize(), a = (c) => (c.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), i)), c);
  t.put("frame", a(Z5([ya(50, 44, 9, 20, "xy"), ya(40, 38, 8, 44, "xy"), ya(28, 28, 7, 62, "xy"), ya(26, 26, 6, 80, "xy")], { capA: true, capB: true }))), t.put("armor", X4([{ u: 24, P: [[29, -6], [29, 13], [23, 23.5], [11, 27.5]] }, { u: 46, P: [[24, -5], [24, 11], [19, 19.5], [9, 23]] }, { u: 62, P: [[17.5, -4], [17.5, 7], [14, 13.5], [7, 16.5]] }], 4, { c: 1.2 }).map(a)), t.put("rubber", a(Nn([[64, 14], [68, 17], [72, 15.5], [76, 18], [80, 16.5], [82.5, 17.5], [84, 17]], "u+", [0, 0, 0], { seg: 12, crease: 80 })), { r: 0.8 });
  for (let c of [-1, 1]) t.put("sleeve", a(Mh([[c * 30, -15, 4], [c * 25, -19, 26], [c * 18, -17, 48], [c * 13, -13, 66]], 3.6, { seg: 6, radial: 5 })));
  e.put("frame", vB(38, [0, 0, 0], { dir: "x+", n: 7, seg: 14 })), e.put("frame", wi([[26, -28], [64, -28], [70, 2], [74, 4], [74, 34], [84, 37], [78, 46], [40, 50], [-8, 50], [14, 8], [14, -16]], 94, { b: 1.6, cs: 1 })), e.put("frame", wi([[-24, 50, 3], [-24, 43], [-6, 30], [0, 50]], 72, { b: 1.4, cs: 1 })), e.put("frame", wi([[0, -16], [0, 6], [16, 6], [28, -28], [10, -28]], 54, { b: 1.4 }));
  let r = [[60, -8], [60, 26], [57, 38], [50, 48], [40, 54], [26, 56]];
  e.put("armor", X4([{ u: -26, P: [[35, 46], [35.5, 47.5], [34, 50], [31, 52.5], [26, 55], [17, 56]] }, { u: -8, P: [[52, 33], [53, 38], [51.5, 43.5], [47, 49], [39, 54], [25.5, 56]] }, { u: 10, P: [[59.5, 6], [60, 26], [57, 38], [50, 48], [40, 54], [26, 56]] }, { u: 23, P: r }, { u: 38, P: r }, { u: 50, P: [[58, 33], [58, 35], [55.5, 41], [49, 48], [39, 53], [25, 55]] }, { u: 70, P: [[56, 35], [56, 37], [53, 41], [47, 46], [37, 50], [24, 52]] }, { u: 87, P: [[50, 36], [50, 37.5], [47, 40], [42, 43], [33, 46], [21, 47]] }], 5));
  for (let c of [-1, 1]) e.put("armorDk", wi([[34, -26.5, 2], [63, -26.5, 2], [68.5, 1, 2], [42, 1, 2]], 5, { x: c * 49.5, b: 1.2, cs: 1 }));
  e.put("frame", Z5([ya(82, 36, 5, 62, "xy", 0, -10), ya(70, 28, 5, 110, "xy", 0, -14), ya(58, 21, 5, 146, "xy", 0, -17.5), ya(52, 15, 5, 157, "xy", 0, -20.5)], { capA: false, capB: true, crease: 40 })), e.put("armor", X4([{ u: 71, P: [[43, -13], [43, -2], [39, 5], [30, 9.5], [16, 11]] }, { u: 110, P: [[37, -15.5], [37, -7], [33, -0.5], [25, 3], [13.5, 4.2]] }, { u: 152, P: [[31, -18], [31, -12.5], [27.5, -8], [20.5, -5.5], [11, -4.8]] }], 4, { c: 1.2 })), e.put("glass", j5($5(30, 11, 4.5, 0, -15.5), 4, { u: 155.5, b: 1.4, cs: 2 }), { noAO: true }), e.put("frameDk", Ia(92, 30, 2, [0, 19, 75]), { ao: 0.5, noAO: true });
  for (let c of [-1, 1]) {
    e.put("frame", Nn([[0, 10], [6, 10], [7.2, 8.8, 1], [7.2, 7.4]], "u+", [c * 36, 19, 75], { seg: 12 })), e.put("coat", Nn([[6.4, 7.4], [7.6, 3.8], [8, 0]], "u+", [c * 36, 19, 75], { seg: 12, crease: 80 }), { noAO: true, color: ov(3554133) });
    for (let h = 0; h < 3; h++) for (let f = 0; f < 2; f++) e.put("lamp", Ia(2.4, 2.4, 1.2, [c * (7 + h * 4), 30.6 - f * 4, 76.6]), { self: 0.06, order: 0.25, color: Dt0, noAO: true });
  }
  for (let c = 0; c < 5; c++) e.put("lamp", Ia(8.8, 3.2, 2.6, [(c - 2) * 10.2, 19, 77.3]), { glow: 1, order: 0.1 + Math.abs(c - 2) * 0.12, noAO: true });
  for (let c of [-1, 1]) e.put("lamp", Ia(1.6, 3.2, 14, [c * 46.2, 19, 66]), { glow: 0.8, order: 0.4, noAO: true });
  e.put("frame", Nn([[0, 5], [4, 5], [4.8, 4.2, 1], [4.8, 3.2]], "u+", [0, 9.5, 75], { seg: 8 })), e.put("coat", Nn([[4.4, 3.2], [4.9, 0]], "u+", [0, 9.5, 75], { seg: 8, crease: 80 }), { noAO: true, color: ov(3107672) }), e.put("metal", Nn([[0, 21.5], [2, 21.5], [3, 20, 1]], "y+", [0, 55, 8], { seg: 14 })), e.put("glass", Nn([[3, 19], [9.5, 19]], "y+", [0, 55, 8], { seg: 14 }), { noAO: true }), e.put("armor", Nn([[9.5, 20], [10.5, 20.6, 1], [11.5, 20], [13.5, 14, 1], [13.5, 5]], "y+", [0, 55, 8], { seg: 14 })), e.put("metal", h1(5, 13.5, 15, "y+", [0, 55, 8], { seg: 6, c: 0.6 }));
  for (let c of [-1, 1]) e.put("metal", h1(11, 0, 15, c > 0 ? "x+" : "x-", [c * 43, 45, -20], { seg: 10, c: 1.2 }));
  e.put("frame", wi([[62, -27], [110, -27], [110, -44.5, 3], [66, -44.5, 3]], 48, { b: 1.4, cs: 1 }), { alert: 0.02 });
  for (let c of [-1, 1]) e.put("ceramic", Nn([[0, 7], [3.5, 7], [3.5, 5.4], [7, 5.4], [7, 7], [10.5, 7], [10.5, 5.4], [13.5, 5.4], [15, 4.2], [15, 0]], "u+", [c * 16, -37, 110], { seg: 8 }), { alert: 0.03 }), e.put("tungsten", Nn([[15, 2.4], [22, 2.4], [26.5, 0.5], [26.5, 0]], "u+", [c * 16, -37, 110], { seg: 6, crease: 50 }), { alert: 1, noAO: true }), e.put("hv", Mh([[c * 26.5, -40, 104], [c * 28.5, -40, 86], [c * 28, -36, 66], [c * 27, -27, 54]], 2.6, { seg: 5, radial: 5 }));
  for (let c = 0; c < 5; c++) e.put("steel", MB(150.5, 155.5, 153, -27.8, -32.6, 7.5, (c - 2) * 10.4));
  for (let c of [-1, 1]) e.put("frame", h1(8.5, 0, 4, c > 0 ? "x+" : "x-", [c * 47, -30, 60], { seg: 8, c: 1 })), C2(e, [c * 51, -30, 60], c > 0 ? "R" : "L", { af: 6, h: 1.8 });
  for (let c of [-1, 1]) s.put("armorDk", b4(wi([[-14, -2, 3], [-14, -13, 4], [-3, -24, 4], [83, -27, 3], [98, -17, 3], [98, -3.5, 1.5], [-8, -1.5]], 6, { x: 0, b: 1.3, cs: 1 }), [c * 41, 0, 0], [0, c * 7.85, 0]));
  s.put("frame", d7([[-37, -6], [37, -6], [26, 92], [-26, 92]], 6, { y: -26.5, b: 1 }), { alert: 0.016 }), s.put("frame", wi([[86, -24], [98, -16.5], [98, -4], [92, -4], [92, -13], [84, -19.5]], 50, { b: 1 }));
  for (let c = 0; c < 4; c++) s.put("steel", MB(92.6, 97.6, 95, -4.2, 0.8, 7.5, (c - 1.5) * 10.4));
  s.put("brass", Ia(40, 1.4, 46, [0, -19.8, 42]), { alert: 0.03 });
  for (let c of [-1, 1]) s.put("metal", h1(4.6, 0, 4.6, c > 0 ? "x+" : "x-", [c * 41.5, 0, 0], { seg: 8, c: 0.8 })), C2(s, [c * 37.9, -14, 45], [[c * 0.99, 0, -0.137], [0, 1, 0]], { af: 4.5, h: 1.5 });
  let l = (c) => b4(c, null, [wB / Hs, 0, 0]);
  return n.put("armor", l(wi([[-13, -12, 6], [20, -13, 4], [100, -5, 4], [104, 3, 4], [82, 12, 6], [-6, 14, 8]], 6.5, { x: 13, b: 1.5, cs: 1 }))), n.put("glass", l(wi([[26, -7], [88, -2], [78, 5.5], [28, 7]], 1.2, { x: 16.7, b: 0.4 })), { noAO: true }), n.put("lamp", l(Ia(1.4, 2.4, 56, [16.8, 10.2, 48])), { glow: 1, order: 0.8, noAO: true }), n.put("metal", l(h1(9, 16, 18.5, "x+", [0, 0, 0], { seg: 8, c: 1 }))), n.put("frame", l(h1(12, 2.5, 9.8, "x+", [0, 0, 0], { seg: 10, c: 1 }))), { neck: t, head: e, jaw: s, ear: n };
}
function Ut0(o2, t) {
  Gi(o2, t, "laser", 30, [-34, 55, 26], [[-0.141, 0.99, 0], [0, 0, -1]], "armor", { roll: 90, lift: 0.5 }), Gi(o2, t, "ghEng", 32, [-60.3, 12, 32], "L", "armor"), Gi(o2, t, "ghEng", 32, [60.3, 12, 32], "R", "armor"), Gi(o2, t, "hv", 24, [-52.2, -13, 50], "L", "armorDk"), Gi(o2, t, "hv", 24, [52.2, -13, 50], "R", "armorDk");
}
function Vt0() {
  let o2 = new Da("tail1"), t = new Da("tail2"), e = new Da("tail3"), s = Math.hypot(70, 85), n = [0, 70 / s, 85 / s], i = [[0, 9]];
  for (let a = 0; a < 6; a++) i.push([3 + a * 5.2, 9.2], [5.6 + a * 5.2, 6.4]);
  return i.push([35, 9], [38, 6, 1], [42, 4.4]), o2.put("steel", Nn(i, n, [0, 0, 0], { seg: 10, crease: 70 }), { r: 0.36 }), o2.put("poly", Nn([[42, 3.3], [s - 6, 2.9]], n, [0, 0, 0], { seg: 7 }), { nrm: 0.2, r: 0.4 }), o2.put("metal", Nn([[s - 6, 4.6], [s + 4, 4.6]], n, [0, 0, 0], { seg: 8 })), t.put("poly", Nn([[4, 2.8], [s - 5, 2.4]], n, [0, 0, 0], { seg: 7 }), { nrm: 0.2, r: 0.4 }), t.put("metal", Nn([[s - 5, 4], [s + 3.5, 4]], n, [0, 0, 0], { seg: 8 })), e.put("poly", Nn([[3.5, 2.3], [s - 16, 1.9]], n, [0, 0, 0], { seg: 6 }), { nrm: 0.2, r: 0.4 }), e.put("metal", Nn([[s - 16, 3.4], [s - 11, 3.4]], n, [0, 0, 0], { seg: 8 })), e.put("lamp", Nn([[s - 11, 4.4], [s - 3, 4.4], [s, 2.4], [s + 0.6, 0]], n, [0, 0, 0], { seg: 8, crease: 70 }), { glow: 1, order: 0.92, noAO: true }), { t1: o2, t2: t, t3: e };
}
var gC = [{ bone: xs.body, p: [-110, 72, -180], r: 170 }, { bone: xs.body, p: [120, 0, 30], r: 150 }, { bone: xs.head, p: [-52, 34, -40], r: 90 }, { bone: xs.upperFR, p: [32, -150, 0], r: 120 }, { bone: xs.body, p: [40, 78, 250], r: 150 }, { bone: xs.lowerHL, p: [-16, -210, 0], r: 110 }, { bone: xs.body, p: [0, -118, -40], r: 150 }].map((o2, t) => ({ ...o2, k: 1 - t * 0.07, at: +(0.2 + t * 0.05).toFixed(2) })), mC = null;
function EB(o2) {
  if (mC) return mC;
  let t = typeof performance < "u" ? performance.now() : 0, e = $u.map(() => [0, 0, 0]);
  $u.forEach((d, m) => {
    let p = d.parent >= 0 ? e[d.parent] : [0, 0, 0];
    e[m] = [p[0] + d.at[0], p[1] + d.at[1], p[2] + d.at[2]];
  });
  let s = new u7(e), n = { parts: {} }, i = (d, m = 1) => (n.parts[d.name] = d.tris * m, d.tris * m), a = Ht0(o2), r = new Da("marks");
  Ft0(r, o2), s.place(a.core, xs.body), s.place(r, xs.body), s.place(a.side, xs.body), s.place(a.side, xs.body, { mx: true }), s.place(a.end, xs.body), s.place(a.end, xs.body, { mz: true });
  for (let d of [false, true]) for (let m of [false, true]) s.place(a.quad, xs.body, { mx: d, mz: m });
  n.body = i(a.core) + i(r) + i(a.side, 2) + i(a.end, 2) + i(a.quad, 4);
  let l = Ot0();
  l.hip.bakeAO(), l.upper.bakeAO(), l.lower.bakeAO();
  for (let d = 0; d < 4; d++) {
    let m = Ph(d) < 0, p = !kf(d), x = Nt0(d, o2);
    s.place(l.hip, 1 + d * 3, { mx: m, mz: p }), s.place(x.hipM, 1 + d * 3), s.place(l.upper, 2 + d * 3, { mx: m }), s.place(x.upM, 2 + d * 3), s.place(l.lower, 3 + d * 3, { mx: m });
  }
  n.legs = i(l.hip, 4) + i(l.upper, 4) + i(l.lower, 4);
  let c = Bt0(o2), h = new Da("headMarks");
  Ut0(h, o2), c.neck.bakeAO(), c.jaw.bakeAO(), c.ear.bakeAO(), s.place(c.neck, xs.neck), s.place(c.head, xs.head), s.place(h, xs.head), s.place(c.jaw, xs.jaw), s.place(c.ear, xs.earR), s.place(c.ear, xs.earL, { mx: true }), n.head = i(c.neck) + i(c.head) + i(h) + i(c.jaw) + i(c.ear, 2);
  let f = Vt0();
  s.place(f.t1, xs.tail1), s.place(f.t2, xs.tail2), s.place(f.t3, xs.tail3), n.tail = f.t1.tris + f.t2.tris + f.t3.tris;
  let u = s.build(gC, [xs.body, xs.head]);
  return n.tris = u.attributes.position.count / 3, n.ms = +((typeof performance < "u" ? performance.now() : 0) - t).toFixed(1), mC = { geometry: u, stats: n, rest: e };
}
var TB = [
  { glow: 0x35e0ff, hot: 0xd8f8ff, shell: 0xd8e2ec, stripe: 0x1b8ec7, k: 1.05 },
  { glow: 0xff591e, hot: 0xffd978, shell: 0x38363a, stripe: 0xc93b28, k: 1.25 }
], Gt0 = `
attribute vec4 aMat; attribute vec4 aMat2; attribute vec4 aFx; attribute vec4 aFx2;
varying vec4 vMat; varying vec4 vMat2; varying vec4 vFx; varying vec4 vFx2;
`, Wt0 = `
varying vec4 vMat; varying vec4 vMat2; varying vec4 vFx; varying vec4 vFx2;
uniform sampler2D uK9Mask; uniform vec4 uK9State; uniform vec3 uK9Team, uK9Hot, uK9Shell, uK9Paint; uniform float uK9Glow; uniform vec2 uK9Zap; uniform float uK9Fade;
uniform vec4 ghRim; uniform vec3 ghFill;
vec3 k9Fill( vec3 N, vec3 V, vec3 albedo, float ao ) {
  float nv = saturate( dot( N, V ) );
  float up = 0.5 + 0.5 * inverseTransformDirection( N, viewMatrix ).y;
  return ( albedo * ghFill * ( 0.3 + 0.7 * nv ) * ( 0.55 + 0.45 * up ) + ghRim.rgb * pow( 1.0 - nv, ghRim.w ) * ( 0.35 + 0.65 * up ) ) * ao;
}
`, qt0 = `
  vec3 kAlb = vColor.rgb * ( 1.0 - 0.86 * step( 0.01, vFx.w ) );       // self-lit lenses are dark until they are powered
  float kMetal = vMat.x, kRough = vMat.y, kAO = vMat.z, kNrm = vMat.w;
  float kWear = vMat2.x, kDust = vMat2.y, kWeave = vMat2.z, kPaint = vMat2.w;
  float kPower = uK9State.x, kAlert = uK9State.y, kDamage = uK9State.z, kTime = uK9State.w;
  vec2 kUv = vec2( 0.0 );
  #ifdef USE_NORMALMAP
    kUv = vNormalMapUv;
  #endif
  vec4 kA = texture2D( uK9Mask, kUv * 4.3 );
  vec4 kB = texture2D( uK9Mask, kUv * 26.0 + vec2( 0.37, 0.61 ) );
  // shell paint, team stripe, tonal breakup
  kAlb = mix( kAlb, kAlb * uK9Shell, kPaint );
  kAlb = mix( kAlb, uK9Paint, vFx2.z );
  kAlb *= mix( 1.0, 0.84 + 0.32 * kA.r, max( kPaint, vFx2.z ) );
  kRough *= mix( 1.0, ( 0.84 + 0.32 * kB.r ) * mix( 1.0, 0.78 + 0.44 * kA.b, kPaint ), step( 0.01, kNrm ) );
  // stencils / plates / labels
  #ifdef USE_MAP
    vec4 kDec = texture2D( map, vMapUv );
    kAlb = kAlb * ( 1.0 - kDec.a ) + kDec.rgb; kMetal *= 1.0 - kDec.a; kRough = mix( kRough, 0.6, kDec.a );
  #endif
  // wear: chips and scratches down to the substrate (primer on composite, bright metal on anodising)
  vec4 kC = texture2D( uK9Mask, kUv * 63.0 + vec2( 0.13, 0.71 ) );
  float kWearE = kWear * ( 0.45 + 1.1 * kA.r );
  float kChip = smoothstep( 1.0 - kWearE, 1.07 - kWearE, kB.g * 0.6 + kC.g * 0.4 + 0.06 );
  float kSubM = step( 0.45, kMetal );
  kAlb = mix( kAlb, mix( kAlb * 1.9 + vec3( 0.035, 0.034, 0.032 ), vec3( 0.36, 0.355, 0.345 ), kSubM ), kChip * 0.85 );
  kMetal = mix( kMetal, kSubM, kChip ); kRough = mix( kRough, mix( 0.66, 0.36, kSubM ), kChip );
  // dust settles in recesses and low on the legs
  float kD = clamp( kDust * 2.0 * smoothstep( 0.62, 1.15, kA.r * 0.42 + kB.r * 0.16 + ( 1.0 - kAO ) * 1.25 ), 0.0, 1.0 );
  kAlb = mix( kAlb, vec3( 0.17, 0.155, 0.135 ), kD * 0.5 ); kRough = mix( kRough, 0.93, kD * 0.8 ); kMetal *= 1.0 - kD * 0.6;
  // battle damage: scorch spreading from the hit sites, cracked coat, embers in the cores
  float kBurn = kDamage * 1.5 - ( 1.0 - vFx2.x ) * 1.08 - ( 1.0 - ( kA.b * 0.7 + kB.b * 0.3 ) ) * 1.2;
  float kSoot = smoothstep( 0.0, 0.22, kBurn ), kCore = smoothstep( 0.24, 0.5, kBurn );
  float kRing = smoothstep( -0.2, 0.0, kBurn ) * ( 1.0 - kSoot );
  float kCrack = kA.a * smoothstep( -0.32, 0.02, kBurn ) * step( 0.001, kDamage );
  kAlb = mix( kAlb, kAlb * vec3( 0.62, 0.44, 0.3 ), kRing );
  kAlb = mix( kAlb, vec3( 0.034, 0.031, 0.029 ), max( kSoot * 0.93, kCrack * 0.85 ) );
  kRough = mix( kRough, 0.96, max( kSoot, kCrack ) ); kMetal *= 1.0 - 0.85 * kSoot;
  float kHot = smoothstep( 0.55, 0.9, kA.r ) * kCore;                                  // only some cores still burn
  float kEmber = ( kHot * kCrack * 2.2 + kCore * smoothstep( 0.93, 0.99, kB.b * 0.5 + kC.r * 0.5 ) * 3.0 ) * ( 0.6 + 0.4 * sin( kTime * 7.0 + kA.r * 40.0 + kA.g * 17.0 ) );
  diffuseColor.rgb = kAlb;
  #ifdef K9_DEBUG_AO
    diffuseColor.rgb = vec3( kAO * 0.5 ); kMetal = 0.0; kRough = 1.0;
  #endif
  // lights: boot sequence by order, breathing when calm, hard and hot when hostile
  float kT = kPower - vFx.y * 0.82;
  float kOn = clamp( kT / 0.09, 0.0, 1.0 );
  float kFlash = 1.0 + 2.2 * kOn * ( 1.0 - smoothstep( 0.09, 0.3, kT ) ) * ( 1.0 - smoothstep( 0.86, 1.0, kPower ) );
  float kBreath = mix( 0.74 + 0.26 * sin( kTime * 2.1 - vFx.y * 3.0 ), 1.0 + 0.05 * sin( kTime * 37.0 ), kAlert );
  vec3 kEmis = mix( uK9Team, uK9Hot, max( kAlert * 0.55, uK9Zap.y ) ) * ( vFx.x * kOn * kFlash * kBreath * mix( 2.1, 7.0, kAlert ) * ( 1.0 + 1.2 * uK9Zap.y ) * uK9Glow );
  // electrodes (and, faintly, the mouth they light): a hint when hostile, heating while they charge, a flash per discharge
  kEmis += vec3( 0.5, 0.78, 1.0 ) * ( vFx.z * kOn * ( 0.35 * kAlert * kAlert + uK9Zap.x * uK9Zap.x * ( 6.0 + 2.5 * sin( kTime * 53.0 ) ) + uK9Zap.y * 13.0 ) );
  kEmis += vColor.rgb * ( vFx.w * kOn * kFlash * 5.0 );
  kEmis += vec3( 5.0, 1.15, 0.14 ) * kEmber * ( 0.4 + 0.6 * kPower );
  // a wreck being cleared away burns out along its own grain: holes open from the scorched patches, a hot edge ahead of them
  if ( uK9Fade < 0.999 ) {
    float kDis = 0.05 + 0.9 * clamp( ( kA.b * 0.5 + kB.r * 0.34 + kC.r * 0.16 - 0.24 ) / 0.52, 0.0, 1.0 );
    float kEdge = uK9Fade - kDis;
    if ( kEdge < 0.0 ) discard;
    kEmis += vec3( 7.0, 1.7, 0.2 ) * ( 1.0 - smoothstep( 0.0, 0.05, kEdge ) ) + vec3( 1.1, 0.18, 0.02 ) * ( 1.0 - smoothstep( 0.0, 0.15, kEdge ) );
  }
`, Kt0 = `
  #ifdef USE_NORMALMAP_TANGENTSPACE
    vec2 kXY = mix( ( texture2D( normalMap, vNormalMapUv * 57.0 ).rg * 2.0 - 1.0 ) * kNrm, ( texture2D( normalMap, vNormalMapUv * 41.666 ).ba * 2.0 - 1.0 ) * 0.5, kWeave ) * normalScale * ( 1.0 - 0.7 * kChip );
    normal = normalize( tbn * vec3( kXY, sqrt( max( 1.0 - dot( kXY, kXY ), 0.05 ) ) ) );
  #endif
`, Xt0 = `
  reflectedLight.indirectDiffuse *= kAO; reflectedLight.indirectSpecular *= mix( 1.0, kAO, 0.9 );
  reflectedLight.directDiffuse *= mix( 1.0, kAO, 0.35 ); reflectedLight.directSpecular *= mix( 1.0, kAO, 0.6 );
  reflectedLight.indirectDiffuse += k9Fill( normal, normalize( vViewPosition ), diffuseColor.rgb * ( 1.0 - metalnessFactor ), kAO );
`;
function Yt0(o2) {
  return o2.onBeforeCompile = (t) => {
    Object.assign(t.uniforms, o2.userData.u), t.vertexShader = t.vertexShader.replace("#include <common>", `#include <common>
` + Gt0).replace("#include <begin_vertex>", `#include <begin_vertex>
vMat = aMat; vMat2 = aMat2; vFx = aFx; vFx2 = aFx2;`).replace("#include <project_vertex>", `#include <project_vertex>
mvPosition.xyz *= 1.0 - 0.0018 * aFx2.y; gl_Position = projectionMatrix * mvPosition;`), t.fragmentShader = t.fragmentShader.replace("#include <common>", `#include <common>
` + Wt0).replace("#include <map_fragment>", "").replace("#include <color_fragment>", qt0).replace("#include <roughnessmap_fragment>", "float roughnessFactor = clamp( kRough, 0.045, 1.0 );").replace("#include <metalnessmap_fragment>", "float metalnessFactor = clamp( kMetal, 0.0, 1.0 );").replace("#include <normal_fragment_maps>", Kt0).replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>
totalEmissiveRadiance += kEmis;`).replace("#include <aomap_fragment>", Xt0);
  }, typeof window < "u" && window.K9_DEBUG_AO && (o2.defines = { ...o2.defines || {}, K9_DEBUG_AO: 1 }), o2.customProgramCacheKey = () => "gh-k9-main-4" + (o2.defines && o2.defines.K9_DEBUG_AO ? "ao" : ""), o2;
}
var jt0 = `
attribute vec4 aCard; varying vec4 vCard; varying vec2 vCuv;
`, $t0 = `
varying vec4 vCard; varying vec2 vCuv;
uniform vec4 uK9State; uniform vec3 uK9Team, uK9Hot; uniform float uK9Glow; uniform vec2 uK9Zap; uniform float uK9Fade;
`, Zt0 = `
  {
    float kPower = uK9State.x, kAlert = uK9State.y, kTime = uK9State.w;
    vec3 kTeam = mix( uK9Team, uK9Hot, kAlert * 0.5 ) * uK9Glow;
    if ( vCard.x < 0.5 ) {
      // visor glass: smoked, glossy; behind it a light guide that boots from the centre outwards
      vec3 kV = normalize( vViewPosition );
      float kF = pow( 1.0 - saturate( dot( normalize( vNormal ), kV ) ), 4.0 );
      float kA = mix( 0.8, 0.98, kF );
      float u = vCuv.x, v = vCuv.y;
      float kOn = clamp( ( kPower * 1.25 - abs( u ) * 0.8 - 0.12 ) / 0.1, 0.0, 1.0 );
      float kFlick = 1.0 - ( 1.0 - smoothstep( 0.8, 1.0, kPower ) ) * 0.5 * step( 0.5, fract( sin( floor( kTime * 31.0 ) * 12.9898 + floor( u * 6.0 ) ) * 43758.5453 ) );
      float kBreath = mix( 0.7 + 0.3 * sin( kTime * 2.1 ), 1.0, kAlert );
      float kW = mix( 0.42, 0.2, kAlert );
      v -= kAlert * 0.3 * ( abs( u ) - 0.45 );      // hostile: the slit knits into a shallow V, a scowl
      float kBand = exp( - v * v / ( kW * kW ) );
      float kSeg = 0.82 + 0.18 * smoothstep( 0.04, 0.12, abs( fract( u * 5.5 + 0.5 ) - 0.5 ) );
      vec3 kGlow = kTeam * kBand * kSeg * ( 1.0 - 0.35 * u * u ) * mix( 0.16, 2.2, kAlert ) * kBreath;
      // the light slit itself (the lamps behind the smoked glass are only a hint of depth)
      kGlow += kTeam * ( 1.0 - smoothstep( 0.075, 0.115, abs( vCuv.y ) ) ) * ( 1.0 - smoothstep( 0.4, 0.43, abs( u ) ) ) * ( 0.75 + 0.25 * smoothstep( 0.03, 0.06, abs( fract( u * 5.72 + 0.5 ) - 0.5 ) ) ) * 2.0 * kBreath * ( 1.0 - kAlert );
      // hostile: a hard white-hot slit with a burning core
      float kSlit = exp( - v * v / 0.012 ) * ( 0.25 + 0.75 * exp( - u * u / 0.22 ) );
      kGlow += mix( kTeam, vec3( 1.0 ), 0.75 ) * kSlit * kAlert * kAlert * 14.0;
      // calm: a soft pupil that drifts a little
      float kPu = u - 0.12 * sin( kTime * 0.6 );
      kGlow += kTeam * exp( - ( kPu * kPu * 7.0 + v * v * 3.5 ) ) * 0.22 * ( 1.0 - kAlert ) * kBreath;
      kGlow += vec3( 0.75, 0.88, 1.0 ) * ( uK9Zap.y * ( 1.2 * exp( - v * v / 0.2 ) + 6.0 * kSlit ) + uK9Zap.x * uK9Zap.x * 1.6 * kSlit );      // discharge: the visor flares white
      kGlow *= kOn * kFlick;
      gl_FragColor = vec4( outgoingLight * kA + kGlow, kA );
    } else {
      float r2 = dot( vCuv, vCuv );
      float kFall = exp( - r2 * 4.2 ) * ( 1.0 - smoothstep( 0.75, 1.0, r2 ) );
      float kFace = saturate( dot( normalize( vNormal ), normalize( vViewPosition ) ) * 1.6 + 0.25 ), kFar = smoothstep( 2.0, 9.0, length( vViewPosition ) );
      float kOn = clamp( ( kPower - 0.55 ) / 0.3, 0.0, 1.0 );
      vec3 c;
      if ( vCard.x < 1.5 ) c = uK9Team * uK9Glow * kFace * kFar * mix( 0.24, 0.85, kAlert ) * mix( 0.8 + 0.2 * sin( kTime * 2.1 ), 1.0, kAlert );
      else if ( vCard.x < 2.5 ) { float kBl = smoothstep( 0.86, 0.9, fract( kTime * 0.55 + vCard.w ) ) + 0.6 * smoothstep( 0.86, 0.9, fract( kTime * 0.55 + vCard.w + 0.12 ) ); c = kTeam * ( 0.12 + 1.6 * kBl ) * ( 0.25 + 0.75 * kFar ); }
      else c = vec3( 0.5, 0.78, 1.0 ) * ( 0.4 + 0.6 * kFace ) * ( 0.05 * kAlert * kAlert + uK9Zap.x * uK9Zap.x * ( 0.5 + 0.3 * sin( kTime * 53.0 + vCard.w * 9.0 ) ) + uK9Zap.y * 1.1 );
      gl_FragColor = vec4( c * kFall * kOn, 0.0 );
    }
    gl_FragColor *= smoothstep( 0.25, 0.8, uK9Fade );
  }
`;
function Qt0(o2) {
  return o2.onBeforeCompile = (t) => {
    Object.assign(t.uniforms, o2.userData.u), t.vertexShader = t.vertexShader.replace("#include <common>", `#include <common>
` + jt0).replace("#include <begin_vertex>", `#include <begin_vertex>
vCard = aCard; vCuv = uv;`).replace("#include <project_vertex>", `#include <project_vertex>
        if ( aCard.x > 0.5 ) { mvPosition.xyz -= normalize( mvPosition.xyz ) * min( 0.07, aCard.y * 0.6 ); mvPosition.xy += uv * aCard.yz; gl_Position = projectionMatrix * mvPosition; }`), t.fragmentShader = t.fragmentShader.replace("#include <common>", `#include <common>
` + $t0).replace("#include <opaque_fragment>", Zt0).replace("#include <premultiplied_alpha_fragment>", "");
  }, o2.customProgramCacheKey = () => "gh-k9-fx-3", o2;
}
function SB() {
  let o2 = f7(), t = { uK9State: { value: new THREE.Vector4(1, 0, 0, 0) }, uK9Team: { value: new THREE.Color() }, uK9Hot: { value: new THREE.Color() }, uK9Shell: { value: new THREE.Color() }, uK9Paint: { value: new THREE.Color() }, uK9Glow: { value: 1 }, uK9Mask: { value: o2.mask }, uK9Zap: { value: new THREE.Vector2(0, 0) }, uK9Fade: { value: 1 }, ghRim: Kk, ghFill: qk }, e = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 1 });
  o2.detail && (e.normalMap = o2.detail, e.map = o2.marks), e.userData.u = t, e.name = "k9:main", Yt0(e);
  let s = new THREE.MeshStandardMaterial({ color: 724240, roughness: 0.07, metalness: 0, transparent: true, depthWrite: false, premultipliedAlpha: true, fog: false });
  return s.userData.u = t, s.name = "k9:fx", Qt0(s), { main: e, fx: s, u: t };
}
var g7 = { y0: 2.6, y1: 35.6, rake: 5, plan: [[-58.4, 49], [-56.5, 66], [-47, 79], [-25, 86.4], [0, 88.2], [25, 86.4], [47, 79], [56.5, 66], [58.4, 49]] }, zh = [16, -37, 136.5], xC = null;
function Jt0(o2) {
  if (xC) return xC;
  let t = [], e = [], s = [], n = [], i = [], a = [], r = o2[xs.head], l = g7.plan, c = l.length, h = [0];
  for (let p = 1; p < c; p++) h.push(h[p - 1] + Math.hypot(l[p][0] - l[p - 1][0], l[p][1] - l[p - 1][1]));
  for (let p = 0; p < c; p++) {
    let x = l[Math.max(0, p - 1)], g = l[Math.min(c - 1, p + 1)], b = g[0] - x[0], v = g[1] - x[1], y = Math.hypot(b, v);
    b /= y, v /= y;
    let M = -v, w = b, T = h[p] / h[c - 1] * 2 - 1;
    for (let [S, E, _] of [[g7.y0, -1, 0], [g7.y1, 1, g7.rake]]) {
      t.push(r[0] + (l[p][0] - M * _) * 1e-3, r[1] + S * 1e-3, r[2] - (l[p][1] - w * _) * 1e-3);
      let R = 1 / Math.hypot(M, w, 0.15);
      e.push(M * R, 0.15 * R, -w * R), s.push(T, E), n.push(0, 0, 0, 0), i.push(xs.head, 0, 0, 0);
    }
    if (p < c - 1) {
      let S = p * 2;
      a.push(S, S + 1, S + 2, S + 1, S + 3, S + 2);
    }
  }
  let f = (p, x, g, b, v, y, M = [0, 0, -1]) => {
    let w = t.length / 3, T = o2[p];
    for (let [S, E] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) t.push(T[0] + x[0], T[1] + x[1], T[2] + x[2]), e.push(M[0], M[1], M[2]), s.push(S, E), n.push(g, b, v, y), i.push(p, 0, 0, 0);
    a.push(w, w + 1, w + 2, w, w + 2, w + 3);
  };
  f(xs.head, [0, 0.019, -0.09], 1, 0.12, 0.05, 0), f(xs.tail3, [0, 0.07, 0.085], 2, 0.032, 0.032, 0.37), f(xs.body, [-0.125, 0.013, -0.044], 1, 0.11, 0.035, 0, [-1, 0, 0]), f(xs.body, [0.125, 0.013, -0.044], 1, 0.11, 0.035, 0, [1, 0, 0]), f(xs.head, [-zh[0] * 1e-3, zh[1] * 1e-3, -zh[2] * 1e-3], 3, 0.017, 0.017, 0.1), f(xs.head, [zh[0] * 1e-3, zh[1] * 1e-3, -zh[2] * 1e-3], 3, 0.017, 0.017, 0.6);
  let u = new THREE.BufferGeometry(), d = t.length / 3, m = new Float32Array(d * 4);
  for (let p = 0; p < d; p++) m[p * 4] = 1;
  return u.setAttribute("position", new THREE.Float32BufferAttribute(t, 3)), u.setAttribute("normal", new THREE.Float32BufferAttribute(e, 3)), u.setAttribute("uv", new THREE.Float32BufferAttribute(s, 2)), u.setAttribute("aCard", new THREE.Float32BufferAttribute(n, 4)), u.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(i, 4)), u.setAttribute("skinWeight", new THREE.BufferAttribute(m, 4)), u.setIndex(a), xC = u;
}
var te0 = new THREE.Matrix4();
function _B(o2, t, e) {
  let s = new THREE.Sphere(new THREE.Vector3(), e), n = new THREE.Vector3();
  return Object.defineProperty(s, "center", { get: () => n.setFromMatrixPosition(t.matrixWorld).applyMatrix4(te0.copy(o2.matrixWorld).invert()) }), s;
}
var bC = () => (typeof performance < "u" ? performance.now() : Date.now()) * 1e-3;
function RB({ team: o2 = 0, bones: t }) {
  let e = bC(), s = f7(), n = EB(s.cells), i = SB(), a = n.rest, r = i.u, l = $u.map((x, g) => new THREE.Matrix4().makeTranslation(-a[g][0], -a[g][1], -a[g][2])), c = new THREE.Skeleton(t, l), h = new THREE.Matrix4(), f = new THREE.SkinnedMesh(n.geometry, i.main);
  f.name = "k9:mesh", f.bind(c, h), f.castShadow = true, f.receiveShadow = true, f.boundingSphere = _B(f, t[xs.body], 1.05), f.onBeforeRender = () => {
    r.uK9State.value.w = bC() % 4096;
  };
  let u = new THREE.SkinnedMesh(Jt0(a), i.fx);
  u.name = "k9:fx", u.bind(c, h), u.castShadow = false, u.receiveShadow = false, u.renderOrder = 3, u.boundingSphere = _B(u, t[xs.body], 1.05), t[xs.body].add(u);
  let d = (x, g, b, v, y) => {
    let M = new THREE.Object3D();
    return M.name = "k9:" + y, M.position.set(g, b, v), t[x].add(M), M;
  }, m = { visor: d(xs.head, 0, 0.019, -0.089, "visor"), prongL: d(xs.head, -zh[0] * 1e-3, zh[1] * 1e-3, -zh[2] * 1e-3, "prongL"), prongR: d(xs.head, zh[0] * 1e-3, zh[1] * 1e-3, -zh[2] * 1e-3, "prongR"), mouth: d(xs.head, 0, -0.037, -0.125, "mouth"), antennaTip: d(xs.tail3, 0, 0.07, 0.085, "antennaTip"), vents: d(xs.body, 0, 0.088, 0.17, "vents"), ventL: d(xs.body, -0.121, -0.01, 0.08, "ventL"), ventR: d(xs.body, 0.121, -0.01, 0.08, "ventR"), sparks: gC.map((x, g) => {
    let b = d(x.bone, x.p[0] * 1e-3, x.p[1] * 1e-3, x.p[2] * 1e-3, "spark" + g);
    return b.userData.threshold = x.at, b;
  }) };
  m.ventL.rotation.z = Math.PI / 2, m.ventR.rotation.z = -Math.PI / 2;
  let p = { mesh: f, extras: [u], sockets: m, skeleton: c, team: o2, triangles: n.stats.tris + u.geometry.index.count / 3, drawCalls: 2, info: { ...n.stats, textureMs: s.ms, textureParts: s.parts, textureBytes: s.bytes, buildMs: 0 }, setTeam(x) {
    let g = TB[x ? 1 : 0];
    p.team = x ? 1 : 0, r.uK9Team.value.setHex(g.glow), r.uK9Hot.value.setHex(g.hot), r.uK9Shell.value.setHex(g.shell), r.uK9Paint.value.setHex(g.stripe), r.uK9Glow.value = g.k;
  }, setPower(x) {
    r.uK9State.value.x = x < 0 ? 0 : x > 1 ? 1 : x;
  }, setAlert(x) {
    r.uK9State.value.y = x < 0 ? 0 : x > 1 ? 1 : x;
  }, setDamage(x) {
    r.uK9State.value.z = x < 0 ? 0 : x > 1 ? 1 : x;
  }, setCharge(x) {
    r.uK9Zap.value.x = x < 0 ? 0 : x > 1 ? 1 : x;
  }, setShock(x) {
    r.uK9Zap.value.y = x < 0 ? 0 : x > 1 ? 1 : x;
  }, setFade(x) {
    x = x < 0 ? 0 : x > 1 ? 1 : x, r.uK9Fade.value = x, f.castShadow = x > 0.4;
  }, dispose() {
    i.main.dispose(), i.fx.dispose(), c.dispose(), u.parent && u.parent.remove(u);
  } };
  return p.setTeam(o2), p.info.buildMs = (bC() - e) * 1e3, p;
}
var x7 = Math.PI * 2, Ys = (o2, t, e) => o2 < t ? t : o2 > e ? e : o2, iv = (o2) => o2 < 0 ? 0 : o2 > 1 ? 1 : o2, as = (o2, t, e) => o2 + (t - o2) * e, b7 = (o2) => (o2 = o2 < 0 ? 0 : o2 > 1 ? 1 : o2, o2 * o2 * (3 - 2 * o2)), Pc = (o2, t, e) => b7((e - o2) / (t - o2)), AB = (o2) => (o2 = o2 < 0 ? 0 : o2 > 1 ? 1 : o2, o2 * o2 * o2 * (o2 * (o2 * 6 - 15) + 10)), Di = (o2, t, e, s) => o2 + (t - o2) * (1 - Math.exp(-e * s)), Y4 = (o2) => o2 - Math.floor(o2), yC = (o2) => o2 - Math.floor(o2 + 0.5), Yp = (o2) => (o2 = (o2 + Math.PI) % x7, o2 < 0 && (o2 += x7), o2 - Math.PI), CB = (o2, t, e) => o2 <= t ? 0 : o2 >= e ? 1 : (o2 - t) / (e - t), Cn = (o2, t, e) => b7(CB(o2, t, e));
function Q5(o2, t, e, s = 0.5) {
  if (o2 <= t) return 0;
  let n = (o2 - t) / (e - t);
  if (n >= 2) return 1;
  let i = 4 / s, a = i * Math.sqrt(1 - s * s);
  return 1 - Math.exp(-s * i * n) * (Math.cos(a * n) + s * i / a * Math.sin(a * n));
}
function av(o2, t, e, s = 0.06) {
  let n = (o2 - t) / (e - t);
  return n <= 0 ? 0 : n < 0.8 ? (1 + s) * AB(n / 0.8) : 1 + s * (1 - AB((n - 0.8) / 0.45));
}
var f1 = (o2, t, e) => {
  let s = CB(o2, t, e), n = Math.sin(Math.PI * s);
  return n * n;
};
function J5(o2, t, e) {
  let s = o2.length;
  if (e <= o2[0]) return t[0];
  if (e >= o2[s - 1]) return t[s - 1];
  let n = 1;
  for (; o2[n] < e; ) n++;
  return t[n - 1] + (t[n] - t[n - 1]) * (e - o2[n - 1]) / (o2[n] - o2[n - 1]);
}
function Io(o2, t, e, s, n) {
  let i = 1 + 2 * n * s * e, a = n * e * e, r = n * a, l = 1 / (i + r), c = (i * o2.x + n * o2.v + r * t) * l;
  return o2.v = (o2.v + a * (t - o2.x)) * l, o2.x = c, c;
}
var co = (o2 = 0) => ({ x: o2, v: 0 }), kB = (o2) => {
  let t = Math.sin(o2 * 127.1 + 311.7) * 43758.5453;
  return t - Math.floor(t);
};
function W1(o2, t = 0) {
  let e = Math.floor(o2), s = o2 - e, n = s * s * (3 - 2 * s);
  return as(kB(e + t * 57.3), kB(e + 1 + t * 57.3), n) * 2 - 1;
}
function Bn(o2) {
  return o2.s = Math.imul(o2.s, 1103515245) + 12345 >>> 1 & 1073741823, o2.s / 1073741824;
}
var zc = (o2, t) => Math.sqrt(o2 * o2 + t * t);
var ee0 = [0.25, 0.75, 0, 0.5], se0 = [0.5, 1, 0, 0.5], ne0 = [0.62, 0.52, 0, 0.1], PB = [0, 0.3, 0.8, 1.6, 2.6], oe0 = [0.78, 0.92, 1.38, 1.92, 2.4], ie0 = [0.8, 0.78, 0.7, 0.62, 0.56], zB = [0, 1, 2, 3, 4.2, 5.5, 7], ae0 = [1.5, 1.75, 2.12, 2.48, 2.86, 3.15, 3.4], re0 = [0.58, 0.56, 0.5, 0.44, 0.38, 0.34, 0.31], LB = [4, 5.5, 7, 8.5, 9.5, 11], le0 = [2.3, 2.5, 2.75, 3, 3.15, 3.4], ce0 = [0.32, 0.27, 0.23, 0.205, 0.19, 0.175], he0 = 0.6;
function vC(o2, t, e, s) {
  let n = J5(PB, oe0, t), i = J5(zB, ae0, t), a = J5(LB, le0, t), r = J5(PB, ie0, t), l = J5(zB, re0, t), c = J5(LB, ce0, t), h = as(as(n, i, e), a, s), f = as(as(r, l, e), c, s), u = t * f / he0;
  h < u && (h = u), o2.f = h, o2.duty = f;
  let d = 0.035 + 0.03 * Math.min(1, t / 1.4), m = 0.07 + 0.035 * Math.min(1, t / 4.2), p = 0.13 + 0.05 * Math.min(1, (t - 5) / 4.5);
  o2.lift = as(as(d, m, e), p, s), o2.crouch = as(0.012 * e, 0.065, s), o2.narrow = as(0.03 * e, 0.045, s), o2.reach = 0.07 * s;
  for (let x = 0; x < 4; x++) o2.off[x] = as(as(ee0[x], se0[x], e), ne0[x], s);
  return o2;
}
var DB = () => ({ f: 1, duty: 0.7, lift: 0.05, crouch: 0, narrow: 0, reach: 0, off: [0.25, 0.75, 0, 0.5] });
var Ei = 0, j4 = 1, $4 = 2, zf = 3, Zu = 4, Z4 = ue.upper + ue.lower - 4e-3, Pf = ue.hipX + ue.hipOut, fe0 = zc(Pf, ue.hipZ), IB = Z4 * 0.93, ue0 = 0.95, MC = 0.125, HB = Math.sin(zn.a[0] + 0.035), FB = Math.cos(zn.a[0] + 0.035), Zl = THREE.Vector3, Wi = new Zl(), y7 = new Zl(), x10 = new THREE.Quaternion(), de0 = new THREE.Euler(0, 0, 0, "YXZ");
function pe0(o2, t = 0.16, e = 0.22) {
  if (o2 <= 0) return 0;
  if (o2 >= 1) return 1;
  let s = 1 / (1 - 0.5 * (t + e));
  if (o2 < t) {
    let n = o2 / t;
    return s * t * (n * n * n - 0.5 * n * n * n * n);
  }
  if (o2 > 1 - e) {
    let n = (1 - o2) / e;
    return 1 - s * e * (n * n * n - 0.5 * n * n * n * n);
  }
  return s * (o2 - 0.5 * t);
}
var v7 = 0.4, me0 = 2.3, ge0 = 1;
function wC(o2) {
  if (o2 <= 0 || o2 >= 1) return 0;
  if (o2 < v7) {
    let n = o2 / v7, i = n * n, a = i * n;
    return (a - 2 * i + n) * me0 + (-2 * a + 3 * i);
  }
  let t = (o2 - v7) / (1 - v7), e = t * t, s = e * t;
  return 2 * s - 3 * e + 1 - (s - e) * ge0;
}
var Q4 = class {
  constructor(t) {
    this.i = t, this.side = Ph(t), this.front = kf(t), this.mode = Ei, this.pos = new Zl(), this.g = 0, this.gs = 0, this.k = 0, this.u = 0, this.p0 = new Zl(), this.p1 = new Zl(), this.g0 = 0, this.g1 = 0, this.qx = 1e9, this.qz = 1e9, this.locked = false, this.lift = 0.06, this.tRem = 0, this.wait = 0, this.nog = false, this.strain = false, this.landed = false, this.from = new Zl(), this.to = new Zl(), this.t = 0, this.dur = 0.2, this.sLift = 0.04, this.over = 0, this.str = 0.2, this.hold = 0, this.rel = new Zl(), this.relV = new Zl(), this.relT = new Zl(), this.freeW = 24, this.bs = new Zl(), this.bsP = new Zl(), this.ang = [0, 0, 0], this.angV = [0, 0, 0], this.angT = [0, 0, 0], this.poseW = 14, this.floor = false, this.load = 0, this.loadK = 1, this.reach = 0, this.reachP = 0, this.miss = 0, this.inM = 1, this.home = new Zl(), this.down = false;
  }
}, M7 = class {
  constructor({ ground: t = null, clear: e = null, seed: s = 1 } = {}) {
    this.ground = t, this.clear = e, this.state = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, grounded: true, mode: "folded", lookAt: null, hp: 1, alert: 0 }, this.pose = r7(), this.P_STAND = dB(), this.P_FOLD = pB(), this.legs = [new Q4(0), new Q4(1), new Q4(2), new Q4(3)], this.G = DB(), this.rng = { s: s * 2654435761 >>> 2 & 1073741823 }, this.seed = s, this.onStep = null, this._c = new Zl(), this.live = false, this.time = s * 7.31, this.mode = "none", this.px = 0, this.py = 0, this.pz = 0, this.pyaw = 0, this.vx = 0, this.vz = 0, this.vyM = 0, this.ax = 0, this.az = 0, this.wy = 0, this.speed = 0, this.sEff = 0, this.peak = 0, this.sy = 0, this.cy = 1, this.dirx = 0, this.dirz = -1, this.gaitOn = false, this.Phi = 0, this.trotOn = false, this.gallopOn = false, this.trotK = 0, this.gallopK = 0, this.settleT = 0, this.spread = 0.02, this.brx = 0, this.brz = 0, this.cadence = 1, this.air = false, this.airT = 0, this.landT = 9, this.skid = 0, this.limpLeg = -1, this.limpK = 0, this.slopeK = 0, this.idt = 60, this.gOK = true, this.vF = 0, this.vR = 0, this.latK = 0, this.goal = { h: ue.stand, x: 0, z: 0, pitch: 0, roll: 0, yaw: 0, terrain: 1, sink: 0.2, gait: true, settle: true, idle: 1, gaze: 0, gazeW: 26, gazeYaw: 0, gazePitch: 0, neck: 0.25, stab: 1, tilt: 0, headRoll: 0, headYaw: 0, headPitch: 0, script: 0, sNeck: [0, 0], sHead: [0, 0, 0], ears: [0.15, 0.15], earW: 34, tail: [[0, 0.1], [0, 0.05], [0, 0]], tailW: 20, tailZ: 0.24, wag: 0, jaw: 0, power: 1, alert: 0, charge: 0, shock: 0 }, this.supY = co(), this.supP = co(), this.supR = co(), this.supT = 0, this.supV = 0, this.hv = co(), this.pt = co(), this.rl = co(), this.sx = co(), this.sz = co(), this.yw = co(), this.loadAvg = 0, this.gPitch = 0, this.gRoll = 0, this.gX = 0, this.aX = co(), this.aY = co(), this.aZ = co(), this.gaitK = 0, this.bobS = co(), this.slope = 0, this.io = [co(), co(), co(), co(), co(), co()], this.fin = new Float64Array(6), this.finV = new Float64Array(6), this.finS = new Float64Array(6), this.rawP = new Float64Array(6), this.blend = 0, this.ioW = 17, this.finOk = false, this.bpos = new Zl(0, ue.stand, 0), this.bq = new THREE.Quaternion(), this.bqi = new THREE.Quaternion(), this.bodyW = new Zl(0, ue.stand, 0), this.pitch = 0, this.roll = 0, this.yawOff = 0, this.free = false, this.fq = new THREE.Quaternion(), this.idleX = co(), this.idleTx = 0, this.idleT = 2 + Bn(this.rng) * 3, this.pawLeg = -1, this.pawT = 0, this.effort = 0, this.gaitName = "stand";
  }
  gy(t, e) {
    let s = this.state, n = s.y;
    if (!this.ground) return this.gOK = true, n;
    let i = zc(t - s.x, e - s.z), a = Math.min(0.2 + 0.72 * i, 0.85), r = this.ground(t, e, n + a);
    return r <= n + a + 0.06 && r >= n - Math.min(0.3 + 0.8 * i, 0.66) ? r - n > 0.24 && this.ground(0.5 * (t + s.x), 0.5 * (e + s.z), n + a) - n < 0.5 * (r - n) - 0.2 ? (this.gOK = false, n) : (this.gOK = true, r) : (this.gOK = false, n);
  }
  homeAt(t, e, s, n, i) {
    let a = Math.cos(n), r = Math.sin(n), l = this.G, c = t.side * (Pf + this.spread - l.narrow + 0.045 * this.latK), h = (t.front ? -ue.hipZ : ue.hipZ) - l.reach - 0.07 * this.slope;
    return i.x = e + c * a + h * r, i.z = s - c * r + h * a, i;
  }
  toWorld(t) {
    let e = this.state, s = t.x, n = t.z;
    return t.x = e.x + s * this.cy + n * this.sy, t.y += e.y, t.z = e.z - s * this.sy + n * this.cy, t;
  }
  toLocal(t) {
    let e = this.state, s = t.x - e.x, n = t.z - e.z;
    return t.x = s * this.cy - n * this.sy, t.y -= e.y, t.z = s * this.sy + n * this.cy, t;
  }
  footOfPose(t, e, s) {
    return this.toWorld(hC(t, e.leg[t], s).applyQuaternion(e.quat).add(e.pos));
  }
  plant(t, e, s) {
    t.mode = Ei, t.g = this.gy(e, s), t.gs = t.g, t.pos.set(e, t.g + ue.foot, s), t.k = 0.5, t.down = true;
  }
  step(t, e, s, n = 0.18, i = 0.05, a = 0, r = 0.2, l = 0) {
    t.from.copy(t.pos), t.g0 = t.mode === Ei ? t.g : t.gs, t.to.set(e, 0, s), t.g1 = this.gy(e, s), t.mode = $4, t.t = 0, t.dur = n, t.sLift = i, t.over = a, t.str = r, t.hold = l, t.down = false;
  }
  freeLeg(t, e, s, n, i = 24) {
    t.mode !== zf && (t.rel.copy(t.bs), t.relV.subVectors(t.bs, t.bsP).multiplyScalar(this.idt), t.relV.lengthSq() > 64 && t.relV.setLength(8), t.mode = zf, t.down = false), t.relT.set(e, s, n), t.freeW = i;
  }
  poseLeg(t, e, s, n, i = 14, a = false) {
    if (t.mode !== Zu) {
      let r = this.pose.leg[t.i];
      t.ang[0] = r[0], t.ang[1] = r[1], t.ang[2] = r[2], t.angV[0] = t.angV[1] = t.angV[2] = 0, t.mode = Zu, t.down = false;
    }
    t.angT[0] = e, t.angT[1] = s, t.angT[2] = n, t.poseW = i, t.floor = a;
  }
  land(t, e = 0.06, s = 0.5, n = 0, i = 0) {
    t.mode !== Ei && (t.mode === $4 && t.t > 0.5 || this.step(t, t.pos.x + n, t.pos.z + i, e, 0, 0, s));
  }
  touch(t, e) {
    if (t.mode = Ei, t.k = 0, t.down = true, t.pos.y = t.g + ue.foot, t.gs = t.g, e > 0) {
      let s = e * (0.35 + 0.65 * this.gallopK);
      this.hv.v -= 0.16 * s, this.pt.v += (t.front ? -0.5 : 0.42) * s, this.rl.v -= t.side * 0.3 * s, this.onStep && this.onStep(t.i, this._c.set(t.pos.x, t.g, t.pos.z), e);
    }
  }
  snap() {
    let t = this.state;
    this.px = t.x, this.py = t.y, this.pz = t.z, this.pyaw = t.yaw, this.vx = t.vx || 0, this.vz = t.vz || 0, this.vyM = 0, this.ax = this.az = 0, this.wy = 0, this.peak = 0, this.sy = Math.sin(t.yaw), this.cy = Math.cos(t.yaw), this.gaitOn = false, this.trotOn = this.gallopOn = false, this.trotK = this.gallopK = 0, this.slopeK = 0;
    for (let e of this.legs) e.reach = e.reachP = 0.8, e.strain = false, e.landed = false, e.nog = false;
    vC(this.G, 0, 0, 0);
    for (let e of this.legs) this.homeAt(e, t.x, t.z, t.yaw, Wi), this.plant(e, Wi.x, Wi.z), e.load = 0, e.bs.set(e.side * Pf, -ue.stand + ue.foot, e.front ? -ue.hipZ : ue.hipZ), e.bsP.copy(e.bs);
    for (let e of ["supP", "supR", "hv", "pt", "rl", "sx", "sz", "yw", "idleX", "aX", "aY", "aZ", "bobS"]) this[e].x = 0, this[e].v = 0;
    this.slope = 0, this.supY.x = t.y, this.supY.v = 0, this.supT = t.y, this.supV = 0;
    for (let e of this.io) e.x = 0, e.v = 0;
    this.loadAvg = this.gPitch = this.gRoll = this.gX = this.gaitK = 0, this.blend = 0, this.air = false, this.free = false, this.live = true, this.finOk = false;
  }
  kin(t) {
    let e = this.state;
    this.idt = 1 / t;
    let s = e.x - this.px, n = e.y - this.py, i = e.z - this.pz;
    this.sy = Math.sin(e.yaw), this.cy = Math.cos(e.yaw);
    let a = 1 - Math.exp(-30 * t), r = this.vx, l = this.vz;
    this.vx += (s / t - this.vx) * a, this.vz += (i / t - this.vz) * a;
    let c = 1 - Math.exp(-9 * t);
    this.ax += (Ys((this.vx - r) / t, -42, 42) - this.ax) * c, this.az += (Ys((this.vz - l) / t, -42, 42) - this.az) * c, this.vyM = Di(this.vyM, Ys(n / t, -15, 15), 20, t), this.wy = Di(this.wy, Ys(Yp(e.yaw - this.pyaw) / t, -12, 12), 24, t), this.px = e.x, this.py = e.y, this.pz = e.z, this.pyaw = e.yaw;
    let h = zc(this.vx, this.vz);
    if (this.speed = h, this.vF = -(this.vx * this.sy + this.vz * this.cy), this.vR = this.vx * this.cy - this.vz * this.sy, h > 0.25) {
      let m = 1 - Math.exp(-12 * t);
      this.dirx += (this.vx / h - this.dirx) * m, this.dirz += (this.vz / h - this.dirz) * m;
    }
    let f = this.peak;
    this.peak = Math.max(h, Di(f, h, 4, t));
    let u = iv((this.peak - h - 0.5) / 2) * Math.min(0.2, 0.042 * this.peak), d = zc(this.dirx, this.dirz) || 1;
    this.brx = this.dirx / d * u, this.brz = this.dirz / d * u;
  }
  gait(t) {
    let e = this.G, s = this.goal, n = this.legs, i = this.state, a = this.sEff = Math.max(this.speed, Math.abs(this.wy) * fe0 * 0.9);
    this.trotOn ? a < 1.85 && (this.trotOn = false) : a > 2.25 && (this.trotOn = true), this.gallopOn ? a < 5.2 && (this.gallopOn = false) : a > 5.9 && (this.gallopOn = true), this.trotK = Di(this.trotK, this.trotOn ? 1 : 0, 9, t), this.gallopK = Di(this.gallopK, this.gallopOn ? 1 : 0, 7, t), vC(e, a, this.trotK, this.gallopK);
    let r = Math.abs(this.wy) * e.duty / 0.95;
    if (e.f < r && (e.f = r), this.speed > 0.05) {
      let m = this.vF / this.speed, p = this.vR / this.speed, x = this.speed * e.duty * zc(m / (0.6 - 0.27 * this.slopeK), p / 0.33);
      e.f < x && (e.f = x), this.latK = Math.abs(p);
    } else this.latK = 0;
    e.f *= this.cadence;
    let l = e.f, c = e.duty, h = s.gait && !this.air && a > (this.gaitOn ? 0.1 : 0.22);
    h && !this.gaitOn ? this.gaitStart() : !h && this.gaitOn && (this.gaitOn = false, this.settleT = 0.1 + 0.02 * Math.min(this.peak, 6)), this.gaitOn && (this.Phi = Y4(this.Phi + l * t));
    let f = this.gallopK > 0.4 ? 0 : this.trotK > 0.5 ? c > 0.5 ? 2 : 0 : 2, u = 0;
    for (let m = 0; m < 4; m++) n[m].mode === Ei && u++;
    let d = this.limpK;
    for (let m = 0; m < 4; m++) {
      let p = n[m], x = m === this.limpLeg ? d : 0;
      if (this.homeAt(p, i.x, i.z, i.yaw, p.home), p.mode === Ei) if (p.gs = p.g, this.skid > 0 && (p.pos.x += this.vx * t * this.skid, p.pos.z += this.vz * t * this.skid), this.gaitOn) {
        let g = yC(Y4(this.Phi + e.off[m]) - p.k * c);
        p.k += t * l / c * (1 + Ys(g * 5, -0.6, 1.2)) * (1 + 0.9 * x);
        let b = p.k < 1 ? Math.sin(Math.PI * p.k) : 0;
        p.load = b * b * p.loadK * (1 - 0.55 * x), p.reach + Math.max(0, p.reach - p.reachP) * 1.3 > 0.972 && (p.strain = true), (p.strain || (p.k >= 1 || p.reach > ue0 && p.k > 0.3) && u - 1 >= f) && (this.liftoff(p), u--);
      } else p.load = Di(p.load, 0, 14, t), p.strain && s.settle && this.settleT > 0 && (this.settleT = 0);
      else if (p.mode === j4) {
        let g = this.gaitOn ? yC(Y4(this.Phi + e.off[m]) - (c + p.u * (1 - c))) : 0, b = x > 0 ? 1 - 0.55 * x * Math.exp(-((p.u - 0.42) * (p.u - 0.42)) / 0.012) : 1, v = Math.max(l, 1.6) / (1 - c) * (1 + Ys(g * 2.5, -0.3, 0.45)) * b;
        if (p.u += t * v, this.swing(p, (1 - p.u) / v, x), p.load = 0, p.u >= 1) if (p.nog) p.u = 0.999, p.locked = false;
        else {
          if (Math.abs(p.pos.x - p.p1.x) + Math.abs(p.pos.z - p.p1.z) > 0.02) {
            let y = this.gy(p.pos.x, p.pos.z);
            this.gOK && (p.g = y);
          }
          Wi.set(p.pos.x - this.bodyW.x, p.g + ue.foot - this.bodyW.y, p.pos.z - this.bodyW.z);
          {
            let y = Wi.x, M = Wi.z;
            Wi.x = y * this.cy - M * this.sy, Wi.z = y * this.sy + M * this.cy;
          }
          this.legD(p, Wi.applyQuaternion(this.bqi)) > Z4 * 0.968 && p.wait < 0.25 ? (p.u = 0.999, p.g1 = p.g, p.locked = false, p.wait += t) : (this.touch(p, Ys((0.2 + 0.085 * a) * (1 - 0.4 * x), 0, 1)), u++);
        }
      } else p.mode === $4 ? (this.stepLeg(p, t), p.load = 0, p.mode === Ei && u++) : (p.load = 0, p.gs = i.y);
    }
    if (!this.gaitOn && s.settle && !this.air && (this.settleT -= t, this.settleT <= 0)) {
      let m = 0.075, p = -1, x = 0;
      for (let g = 0; g < 4; g++) {
        let b = n[g];
        if (b.mode !== Ei) {
          (b.mode === $4 || b.mode === j4) && x++;
          continue;
        }
        let v = zc(b.pos.x - b.home.x, b.pos.z - b.home.z);
        (b.reach > 0.94 || b.strain) && (v += 0.2), v > m && (m = v, p = g);
      }
      if (p >= 0 && x === 0) {
        let g = n[p], b = Math.min(m, 0.4);
        this.step(g, g.home.x + (Bn(this.rng) - 0.5) * 0.02, g.home.z + (Bn(this.rng) - 0.5) * 0.02, Ys(0.15 + 0.3 * b, 0.16, 0.28), 0.03 + 0.11 * b, 0, 0.18 + 0.4 * b), this.settleT = g.dur + 0.03 + Bn(this.rng) * 0.05;
      }
    }
    this.skid = Di(this.skid, 0, 16, t), this.skid < 0.02 && (this.skid = 0), this.gaitName = this.gaitOn ? this.gallopK > 0.5 ? "gallop" : this.trotK > 0.5 ? "trot" : "walk" : "stand";
  }
  gaitStart() {
    let t = this.G, e = this.legs, s = this.state, n = t.duty, i = 1e9, a = 2;
    for (let r = 0; r < 4; r++) {
      let l = e[r];
      if (l.mode !== Ei) continue;
      let c = l.home.x - s.x, h = l.home.z - s.z, f = this.vx + this.wy * h, u = this.vz - this.wy * c, d = zc(f, u) || 1, m = ((l.pos.x - l.home.x) * f + (l.pos.z - l.home.z) * u) / d - (l.front ? 0 : 0.012) - (r === 2 ? 4e-3 : 0);
      m < i && (i = m, a = r);
    }
    this.Phi = Y4(n - t.off[a] + 1e-4);
    for (let r = 0; r < 4; r++) {
      let l = e[r];
      if (l.mode !== Ei) continue;
      let c = Y4(this.Phi + t.off[r]);
      l.k = c < n ? c / n : c - n < 0.06 ? 1 : 0.72;
    }
    this.gaitOn = true;
  }
  liftoff(t) {
    t.mode = j4, t.u = 0, t.p0.copy(t.pos), t.g0 = t.g, t.g1 = t.g, t.qx = 1e9, t.locked = false, t.down = false, t.wait = 0, t.lift = this.G.lift * (t.i === this.limpLeg ? 1 - 0.45 * this.limpK : 1);
  }
  swing(t, e, s) {
    let n = this.G, i = this.state, a = t.u;
    if (t.tRem = e > 0 ? e : 0, !t.locked) {
      let p = e + (this.gaitOn ? 0.5 * n.duty / n.f * (1 - 0.4 * s) : 0);
      this.homeAt(t, i.x + this.vx * p, i.z + this.vz * p, i.yaw + this.wy * p, t.p1), t.p1.x += this.brx, t.p1.z += this.brz;
      let x = t.p1.x - t.qx, g = t.p1.z - t.qz;
      x * x + g * g > 6e-4 && (t.g1 = this.gy(t.p1.x, t.p1.z), t.nog = !this.gOK, t.qx = t.p1.x, t.qz = t.p1.z), a > 0.8 && (t.locked = true, t.g1 = this.gy(t.p1.x, t.p1.z), t.nog = !this.gOK);
    }
    let r = t.g1 - t.g0, l = Ys(r / 0.15, -1, 1), c = Math.abs(r), h = c < 0.2 ? c : 0.2, f = this.gallopK, u = pe0(l > 0 ? (a - 0.16 * l) / (1 - 0.16 * l) : l < 0 ? a / (1 + 0.18 * l) : a, 0.16 + 0.2 * f, 0.22 + 0.12 * f);
    t.pos.x = t.p0.x + (t.p1.x - t.p0.x) * u, t.pos.z = t.p0.z + (t.p1.z - t.p0.z) * u, t.gs = r >= 0 ? t.g0 + h * Pc(0, 0.24, a) + (c - h) * Pc(0.05, 0.7, u) : t.g0 - (c - h) * Pc(0.25, 0.9, u) - h * Pc(0.72, 1, a);
    let d = Math.sin(Math.PI * a), m = f > 0.01 ? wC(a) * (1 - f) + d * d * f : wC(a);
    if (t.pos.y = t.gs + ue.foot + (t.lift + Math.min(0.11, 0.3 * Math.abs(r))) * m, r !== 0 || this.slopeK > 0.05) {
      let p = this.gy(t.pos.x, t.pos.z) + ue.foot + 0.014 * d;
      this.gOK && t.pos.y < p && (t.pos.y = p);
    }
    t.g = t.g1;
  }
  stepLeg(t, e) {
    if (t.hold > 0 && t.t >= 0.5 && (t.hold -= e, t.hold > 0)) return;
    t.t += e / t.dur;
    let s = t.t < 1 ? t.t : 1, n = b7(s), i = n + t.over * Math.sin(Math.PI * s) * n;
    t.pos.x = t.from.x + (t.to.x - t.from.x) * i, t.pos.z = t.from.z + (t.to.z - t.from.z) * i, t.gs = t.g0 + (t.g1 - t.g0) * n;
    let a = t.from.y - t.g0 - ue.foot;
    if (t.pos.y = t.gs + ue.foot + a * (1 - n) + (t.sLift + 0.45 * Math.abs(t.g1 - t.g0)) * wC(s), t.t >= 1) {
      if (t.g = t.g1, Math.abs(t.pos.x - t.to.x) + Math.abs(t.pos.z - t.to.z) > 0.02) {
        let r = this.gy(t.pos.x, t.pos.z);
        this.gOK && (t.g = r);
      }
      this.touch(t, t.str), t.k = 0.5;
    }
  }
  body(t) {
    let e = this.state, s = this.legs, n = this.G, i = this.goal, a = 0.5 * (s[0].gs + s[1].gs), r = 0.5 * (s[2].gs + s[3].gs), l = 0.5 * (s[0].gs + s[2].gs), c = 0.5 * (s[1].gs + s[3].gs);
    if (this.air) this.supY.x = e.y, this.supY.v = 0, this.supT = e.y, this.supV = 0, Io(this.supP, 0, 14, 1, t), Io(this.supR, 0, 14, 1, t);
    else {
      let K = 0.5 * (a + r), $ = 1 - Math.exp(-8 * t);
      this.supV += (Ys((K - this.supT) / t, -3, 3) - this.supV) * $, this.supT = K;
      let n0 = as(30, 11, Pc(1.5, 3.5, this.speed));
      Io(this.supY, K + this.supV * (2 / n0), n0, 1, t), Io(this.supP, Math.atan2(a - r, 2 * ue.hipZ) * 0.88, 16, 1, t), Io(this.supR, Math.atan2(c - l, 2 * Pf) * 0.32, 12, 1, t);
    }
    this.slope = Di(this.slope, this.air ? 0 : Ys((a - r) / 0.36, -1, 1), 7, t), this.slopeK = Math.abs(this.slope);
    let h = s[0].load + s[1].load, f = s[2].load + s[3].load, u = s[0].load + s[2].load, d = s[1].load + s[3].load, m = h + f;
    this.gaitK = Di(this.gaitK, this.gaitOn ? 1 : 0, this.gaitOn ? 5 : 9, t), this.loadAvg = Di(this.loadAvg, m, 1.5 * n.f, t);
    let p = this.trotK, x = this.gallopK, g = this.gaitK;
    Io(this.bobS, -as(as(8e-3, 0.014, p), 0.03, x) * (m - this.loadAvg) * g, 14 * n.f, 0.8, t), this.gPitch = Di(this.gPitch, as(as(0.016, 6e-3, p), 0.1, x) * (f - h) * g, 7 * n.f, t), this.gRoll = Di(this.gRoll, as(as(0.028, 8e-3, p), 0.018, x) * (d - u) * g, 9 * n.f, t), this.gX = Di(this.gX, as(0.016, 3e-3, Math.max(p, x)) * (d - u) * g, 6 * n.f, t);
    let b = -(this.ax * this.sy + this.az * this.cy), v = this.ax * this.cy - this.az * this.sy, y = zc(b, v), M = this.air ? 0.25 : 1;
    Io(this.pt, Ys(b * 0.0105, -0.2, 0.13) * M, 15.5, 0.42, t), Io(this.rl, Ys(-v * 0.017, -0.3, 0.3) * M, 16.5, 0.45, t), Io(this.hv, -Math.min(0.03, y * 16e-4) * M, 19, 0.42, t), Io(this.sx, Ys(-v * 11e-4, -0.03, 0.03) * M, 18, 0.5, t), Io(this.sz, Ys(b * 13e-4, -0.035, 0.035) * M, 18, 0.5, t), Io(this.yw, Ys(this.wy * 0.024, -0.13, 0.13), 17, 0.6, t);
    let w = i.idle * (1 - Pc(0.15, 0.9, this.sEff)), T = this.time;
    Io(this.idleX, this.idleTx * w, 4.2, 0.8, t);
    let S = Math.sin(T * 1.75), E = W1(T * 2.3, this.seed), _ = W1(T * 1.9 + 40, this.seed), R = w * (45e-4 * S + 13e-4 * E), C = w * (6e-3 * Math.sin(T * 1.75 - 0.9) + 4e-3 * _), L = w * 4e-3 * W1(T * 1.3 + 80, this.seed) - this.idleX.x * 1.1, A = xe0, O = i.x + this.sx.x + this.gX + this.idleX.x, H = i.z + this.sz.x;
    A[0] = e.x + O * this.cy + H * this.sy, A[1] = this.supY.x + i.h + this.bobS.x + this.hv.x + R - 0.11 * this.slopeK * i.terrain, A[2] = e.z - O * this.sy + H * this.cy, A[3] = i.pitch + this.supP.x * i.terrain + this.pt.x + this.gPitch + C, A[4] = i.roll + this.supR.x * i.terrain + this.rl.x + this.gRoll + L, A[5] = i.yaw + this.yw.x;
    let F = this.io, P = this.fin, z = this.finV, k = this.finS, I = this.rawP, G = this.finOk ? this.blend : 0;
    if (G === 2) for (let K = 0; K < 6; K++) k[K] = z[K], F[K].x = P[K] + z[K] * t - A[K], F[K].v = 0;
    else if (G === 1) for (let K = 0; K < 6; K++) F[K].v = k[K] - (A[K] - I[K]) / t;
    this.blend = G === 2 ? 1 : 0;
    for (let K = 0; K < 6; K++) {
      G !== 2 && Io(F[K], 0, this.ioW, 1, t);
      let $ = A[K] + F[K].x;
      z[K] = this.finOk ? ($ - P[K]) / t : 0, P[K] = $, I[K] = A[K];
    }
    if (this.finOk = true, !this.free && i.terrain > 0.5) {
      let K = this.supY.x + i.h - i.sink, $ = K - P[1];
      $ > 0 && (P[1] = K - 0.04 * (1 - Math.exp(-$ / 0.04)));
    }
    this.toLocal(this.bpos.set(P[0], P[1], P[2])), this.pitch = P[3], this.roll = P[4], this.yawOff = P[5], this.free ? this.bq.copy(this.fq) : this.bq.setFromEuler(de0.set(P[3], P[5], P[4], "YXZ"));
  }
  legD(t, e) {
    let s = e.x - t.side * ue.hipX, n = e.z - (t.front ? -ue.hipZ : ue.hipZ), i = s * s + e.y * e.y - ue.hipOut * ue.hipOut;
    return Math.sqrt((i > 1e-8 ? i : 1e-8) + n * n);
  }
  solve(t) {
    let e = this.legs, s = this.pose;
    for (let c = 0; c < 4; c++) {
      let h = e[c];
      if (h.mode !== zf) continue;
      let f = h.freeW, u = h.rel, d = h.relV, m = h.relT;
      Ha.x = u.x, Ha.v = d.x, Io(Ha, m.x, f, 0.82, t), u.x = Ha.x, d.x = Ha.v, Ha.x = u.y, Ha.v = d.y, Io(Ha, m.y, f, 0.82, t), u.y = Ha.x, d.y = Ha.v, Ha.x = u.z, Ha.v = d.z, Io(Ha, m.z, f, 0.82, t), u.z = Ha.x, d.z = Ha.v;
    }
    this.bqi.copy(this.bq).invert();
    let n = 0, i = 0, a = 0;
    for (let c = 0; c < 4; c++) {
      let h = e[c], f = 1;
      if (h.mode === Ei || h.mode === $4) Wi.copy(h.pos);
      else if (h.mode === j4 && h.u > 0.3 && !h.nog) Wi.set(h.p1.x - this.vx * h.tRem, h.g1 + ue.foot, h.p1.z - this.vz * h.tRem), f = Pc(0.3, 0.75, h.u);
      else continue;
      this.toLocal(Wi).sub(this.bpos).applyQuaternion(this.bqi);
      let u = this.legD(h, Wi);
      if (u <= IB) continue;
      let d = u - IB, m = (d < 0.025 ? d * d / 0.05 : Math.min(d - 0.0125, 0.2)) / u * f;
      y7.set((Wi.x - h.side * Pf) * m, Wi.y * m, (Wi.z - (h.front ? -ue.hipZ : ue.hipZ)) * m).applyQuaternion(this.bq), n += y7.x, i += y7.y, a += y7.z;
    }
    let r = 0.14, l = Math.sqrt(n * n + i * i + a * a);
    if (l > r) {
      let c = r / l;
      n *= c, i *= c, a *= c;
    }
    Io(this.aX, n, 42, 1, t), Io(this.aY, i, 42, 1, t), Io(this.aZ, a, 42, 1, t), this.bpos.x += this.aX.x, this.bpos.y += this.aY.x, this.bpos.z += this.aZ.x, s.pos.copy(this.bpos), s.quat.copy(this.bq), this.toWorld(this.bodyW.copy(this.bpos));
    for (let c = 0; c < 4; c++) {
      let h = e[c], f = s.leg[c];
      if (h.bsP.copy(h.bs), h.mode === Zu) {
        for (let u = 0; u < 3; u++) Ha.x = h.ang[u], Ha.v = h.angV[u], Io(Ha, h.angT[u], h.poseW, 0.7, t), h.ang[u] = Ha.x, h.angV[u] = Ha.v, f[u] = Ha.x;
        if (hC(c, f, h.bs), h.floor) {
          this.toWorld(Wi.copy(h.bs).applyQuaternion(this.bq).add(this.bpos));
          let u = this.gy(Wi.x, Wi.z) + ue.foot;
          Wi.y < u && (Wi.y = u, this.toLocal(Wi).sub(this.bpos).applyQuaternion(this.bqi), ev(c, Wi, f), h.bs.copy(Wi));
        }
        this.toWorld(h.pos.copy(h.bs).applyQuaternion(this.bq).add(this.bpos)), h.reach = 0;
        continue;
      }
      if (h.strain = false, h.mode === zf) {
        if (h.bs.copy(h.rel), this.fit(h, h.bs), this.toWorld(h.pos.copy(h.bs).applyQuaternion(this.bq).add(this.bpos)), this.air && this.airT > 0.15) {
          let u = this.gy(h.pos.x, h.pos.z);
          this.gOK && h.pos.y < u + ue.foot && (h.g = u, this.touch(h, 1), h.landed = true, this.skid < 0.9 && (this.skid = 0.9), this.toLocal(h.bs.copy(h.pos)).sub(this.bpos).applyQuaternion(this.bqi));
        }
      } else if (this.toLocal(h.bs.copy(h.pos)).sub(this.bpos).applyQuaternion(this.bqi), h.mode === Ei) {
        let u = this.legD(h, h.bs), d = this.inward(h, h.bs);
        (u > Z4 * 0.972 || d - (h.inM < 1 ? Math.max(0, h.inM - d) * 1.3 : 0) < 0.012) && (h.strain = true), h.inM = d;
      } else if ((h.mode === j4 || h.mode === $4) && (h.inM = 1, this.fit(h, h.bs) && (this.toWorld(h.pos.copy(h.bs).applyQuaternion(this.bq).add(this.bpos)), this.slopeK > 0.05 && h.mode === j4))) {
        let u = this.gy(h.pos.x, h.pos.z) + ue.foot;
        this.gOK && h.pos.y < u && (h.pos.y = u, this.toLocal(h.bs.copy(h.pos)).sub(this.bpos).applyQuaternion(this.bqi));
      }
      h.miss = ev(c, h.bs, f), h.reachP = h.reach, h.reach = this.legD(h, h.bs) / Z4, h.mode === Ei && (f[0] <= zn.a[0] + 1e-4 || f[0] >= zn.a[1] - 1e-4 || f[1] <= zn.p[0] + 1e-4 || f[1] >= zn.p[1] - 1e-4 || f[2] <= zn.k[0] + 1e-4 || f[2] >= zn.k[1] - 1e-4) && (h.strain = true);
    }
  }
  inward(t, e) {
    let s = -e.y;
    return s < 0.06 ? 1 : t.side * e.x - ue.hipX - (ue.hipOut * FB + (s + ue.hipOut * HB) / FB * HB);
  }
  fit(t, e) {
    let s = false;
    e.y > -0.085 && (e.y = -0.085, s = true);
    let n = this.legD(t, e);
    if (n < MC) {
      let a = t.side * Pf, r = t.front ? -ue.hipZ : ue.hipZ;
      if (n > 0.03) {
        let l = MC / n;
        e.x = a + (e.x - a) * l, e.y *= l, e.z = r + (e.z - r) * l;
      } else e.y = -MC - 0.02;
      s = true, n = this.legD(t, e);
    }
    if (n > Z4 * 0.985) {
      let a = Z4 * 0.985 / n, r = t.side * Pf, l = t.front ? -ue.hipZ : ue.hipZ;
      e.x = r + (e.x - r) * a, e.y *= a, e.z = l + (e.z - l) * a, s = true;
    }
    let i = this.inward(t, e);
    return i < 0 && (e.x -= t.side * i, s = true), s;
  }
}, xe0 = new Float64Array(6), Ha = { x: 0, v: 0 };
var BB = 0, T7 = 1, S7 = 2, J4 = 3, Qu = THREE.Vector3, Lf = new Qu(), Df = new Qu(), If = new THREE.Euler(0, 0, 0, "YXZ"), OB = new THREE.Quaternion(), w7 = new THREE.Quaternion(), E7 = new THREE.Quaternion(), NB = new Qu(0, 0.05, -0.4), be0 = new Qu(0, 0.06, -0.1), ye0 = new Qu(0, 0.07, 0.38), ve0 = [1, 0.84, 0.7], Me0 = [2.6, 3.8, 5], we0 = [0.45, 0.8, 1];
function UB(o2) {
  o2.gzY = co(), o2.gzP = co(), o2.latY = 0, o2.latP = 0, o2.gzOk = false, o2.tiltS = co(), o2.headY = 0, o2.np = 0.25, o2.hpPrev = 0, o2.hpV = 0, o2.ear = [co(0.15), co(0.15)], o2.jawS = co(), o2.tailS = [{ y: co(), p: co(0.1) }, { y: co(), p: co(0.05) }, { y: co(), p: co() }], o2.tb = new Qu(), o2.tbV = new Qu(), o2.tbA = new Qu(), o2.tbOk = false, o2.scanT = 0.4, o2.scanYaw = 0, o2.scanPitch = -0.05, o2.scanSweep = 0, o2.curious = 0, o2.curSide = 1, o2.hadLook = false, o2.twitchT = 1.5, o2.headPos = new Qu();
}
function t6(o2, t) {
  o2.gzOk = false, o2.tbOk = false, o2.ear[0].x = t.ears[0], o2.ear[1].x = t.ears[1], o2.ear[0].v = o2.ear[1].v = 0, o2.jawS.x = t.jaw, o2.jawS.v = 0;
  for (let e = 0; e < 3; e++) o2.tailS[e].y.x = t.tail[e][0], o2.tailS[e].p.x = t.tail[e][1], o2.tailS[e].y.v = o2.tailS[e].p.v = 0;
  o2.tiltS.x = o2.tiltS.v = 0, o2.np = t.neck[1], o2.curious = 0;
}
function VB(o2, t) {
  let e = o2.state, s = o2.goal, n = o2.pose, i = e.yaw + o2.yawOff;
  Lf.copy(NB).applyQuaternion(o2.bq).add(o2.bpos);
  let a, r;
  if (s.gaze === T7 && e.lookAt) {
    o2.toLocal(Df.copy(e.lookAt));
    let R = Df.x - Lf.x, C = Df.y - (Lf.y + 0.07), L = Df.z - (Lf.z - 0.08);
    a = e.yaw + Math.atan2(-R, -L), r = Math.atan2(C, zc(R, L)), !o2.hadLook && s.alert < 0.6 && (o2.curious = 1.1, o2.curSide = Bn(o2.rng) < 0.5 ? -1 : 1), o2.hadLook = true;
  } else if (o2.hadLook = false, s.gaze === S7) {
    if (o2.scanT -= t, o2.scanT <= 0) {
      let R = Bn(o2.rng);
      o2.scanYaw = R < 0.22 ? (Bn(o2.rng) - 0.5) * 0.3 : (Bn(o2.rng) - 0.5) * 1.9, o2.scanPitch = -0.1 + (Bn(o2.rng) - 0.5) * 0.3, o2.scanSweep = Bn(o2.rng) < 0.3 ? Bn(o2.rng) < 0.5 ? -0.45 : 0.45 : 0, o2.scanT = 0.55 + Bn(o2.rng) * 1.9, Bn(o2.rng) < 0.22 && (o2.curious = 0.9, o2.curSide = o2.scanYaw > 0 ? 1 : -1);
    }
    o2.scanYaw = Ys(o2.scanYaw + o2.scanSweep * t, -1.05, 1.05), a = i + o2.scanYaw, r = o2.scanPitch;
  } else s.gaze === J4 ? (a = i + s.gazeYaw, r = s.gazePitch) : (a = i + Ys(o2.wy * 0.17, -0.75, 0.75), r = -0.05 - 0.04 * o2.gallopK);
  a = i + Ys(Yp(a - i), -2, 2), r = Ys(r, -1.25, 1.1), o2.gzOk || (o2.gzY.x = o2.latY = a, o2.gzP.x = o2.latP = r, o2.gzY.v = o2.gzP.v = 0, o2.gzOk = true, o2.headY = -1e9);
  let l = s.gaze === J4 ? 0 : 0.03;
  (Math.abs(Yp(a - o2.latY)) > l || Math.abs(r - o2.latP) > l) && (o2.latY = a, o2.latP = r), Io(o2.gzY, o2.gzY.x + Yp(o2.latY - o2.gzY.x), s.gazeW, 0.68, t), Io(o2.gzP, o2.latP, s.gazeW, 0.74, t);
  {
    let R = Yp(o2.gzY.x - i);
    R > 2.05 ? o2.gzY.x = i + 2.05 : R < -2.05 && (o2.gzY.x = i - 2.05);
  }
  o2.curious = Math.max(0, o2.curious - t), Io(o2.tiltS, s.tilt + o2.curSide * 0.3 * Pc(0, 0.25, o2.curious), 15, 0.5, t), OB.setFromEuler(If.set(o2.gzP.x + s.headPitch, Yp(o2.gzY.x - e.yaw) + s.headYaw, o2.tiltS.x + s.headRoll, "YXZ")), w7.copy(o2.bqi).multiply(OB), If.setFromQuaternion(w7, "YXZ");
  let c = If.y, h = If.x;
  o2.np = Di(o2.np, s.neck, 9, t);
  let f = Ys(c * 0.5, -zn.neckYaw, zn.neckYaw), u = Ys(o2.np + 0.4 * h, zn.neckPitch[0], zn.neckPitch[1]);
  E7.setFromEuler(If.set(u, f, 0, "YXZ")), Df.copy(be0).applyQuaternion(E7).add(NB).applyQuaternion(o2.bq).add(o2.bpos);
  let d = Df.y + e.y;
  o2.headY < -1e8 && (o2.headY = d), o2.headY = Di(o2.headY, d, 7, t), s.stab > 0 && (u = Ys(u + Ys((o2.headY - d) / 0.085, -0.4, 0.4) * 0.85 * s.stab, zn.neckPitch[0], zn.neckPitch[1]), E7.setFromEuler(If.set(u, f, 0, "YXZ"))), w7.premultiply(E7.invert()), If.setFromQuaternion(w7, "YXZ");
  let m = Ys(If.y, -zn.headYaw, zn.headYaw), p = Ys(If.x, zn.headPitch[0], zn.headPitch[1]), x = Ys(If.z, -zn.headRoll, zn.headRoll), g = s.script;
  g !== 0 ? (n.neck[0] = as(f, s.sNeck[0], g), n.neck[1] = Ys(as(u, s.sNeck[1], g), zn.neckPitch[0], zn.neckPitch[1]), m = as(m, s.sHead[0], g), p = Ys(as(p, s.sHead[1], g), zn.headPitch[0], zn.headPitch[1]), x = as(x, s.sHead[2], g)) : (n.neck[0] = f, n.neck[1] = u), n.head[0] = m, n.head[1] = p, n.head[2] = x;
  let b = o2.pitch + n.neck[1] + p;
  o2.hpV = Di(o2.hpV, (b - o2.hpPrev) / t, 30, t), o2.hpPrev = b, o2.twitchT -= t, o2.twitchT <= 0 && (o2.twitchT = 1.1 + Bn(o2.rng) * 3.2, s.idle > 0.3 && (o2.ear[Bn(o2.rng) < 0.5 ? 0 : 1].v += (Bn(o2.rng) < 0.6 ? -1 : 1) * (5 + Bn(o2.rng) * 5)));
  for (let R = 0; R < 2; R++) {
    let C = o2.ear[R];
    C.v -= Ys(o2.hpV, -12, 12) * 9 * t + o2.tiltS.v * (R ? -1 : 1) * 5 * t, Io(C, s.ears[R], s.earW, 0.3, t), C.x < zn.ear[0] ? (C.x = zn.ear[0], C.v < 0 && (C.v *= -0.3)) : C.x > zn.ear[1] && (C.x = zn.ear[1], C.v > 0 && (C.v *= -0.3)), n.ears[R] = C.x;
  }
  Io(o2.jawS, s.jaw, 52, 0.6, t), n.jaw = Ys(o2.jawS.x, zn.jaw[0], zn.jaw[1]), o2.toWorld(Lf.copy(ye0).applyQuaternion(o2.bq).add(o2.bpos)), o2.tbOk || (o2.tb.copy(Lf), o2.tbV.set(0, 0, 0), o2.tbA.set(0, 0, 0), o2.tbOk = true);
  let v = (Lf.x - o2.tb.x) / t, y = (Lf.y - o2.tb.y) / t, M = (Lf.z - o2.tb.z) / t, w = 1 - Math.exp(-26 * t);
  o2.tbA.x += (Ys((v - o2.tbV.x) / t, -70, 70) - o2.tbA.x) * w, o2.tbA.y += (Ys((y - o2.tbV.y) / t, -70, 70) - o2.tbA.y) * w, o2.tbA.z += (Ys((M - o2.tbV.z) / t, -70, 70) - o2.tbA.z) * w, o2.tbV.set(v, y, M), o2.tb.copy(Lf), Df.set(o2.tbA.x * o2.cy - o2.tbA.z * o2.sy, o2.tbA.y, o2.tbA.x * o2.sy + o2.tbA.z * o2.cy).applyQuaternion(o2.bqi);
  let T = -(o2.vx * o2.sy + o2.vz * o2.cy), S = 34e-4 * T * Math.abs(T), E = s.wag, _ = o2.time * 17;
  for (let R = 0; R < 3; R++) {
    let C = o2.tailS[R], L = s.tailW * ve0[R], A = Me0[R] * (1.25 - s.tailZ);
    C.y.v += -Df.x * A * t, C.p.v += (Df.y * 0.77 - Df.z * 0.64) * A * t, Io(C.y, s.tail[R][0] + E * we0[R] * 0.42 * Math.sin(_ - R * 0.9), L, s.tailZ, t), Io(C.p, s.tail[R][1] + S * (0.5 + 0.35 * R), L, s.tailZ, t), C.y.x = Ys(C.y.x, -1.2, 1.2), C.p.x = Ys(C.p.x, -1.75, 1.3), n.tail[R][0] = C.y.x, n.tail[R][1] = C.p.x;
  }
}
var rr = { deploy: 1.7, windup: 0.28, takedown: 0.75, stagger: 0.35, die: 1.4, blast: 1.4, expire: 2.3, bark: 0.8, sit: 0.6, stand: 0.42 }, t3 = THREE.Vector3, Uo = new t3(), GB = new t3(), Fa = new t3(), e6 = new t3(), Jr = new THREE.Quaternion(), WB = new THREE.Quaternion(), TC = new THREE.Euler(0, 0, 0, "YXZ"), Lh = (o2, t, e) => o2 >= e && o2 - t < e, rv = (o2) => o2 === "idle" || o2 === "move" || o2 === "stagger", qB = (o2) => o2 ? -ue.hipZ : ue.hipZ, KB = -(ue.stand - ue.foot), Ee0 = [0, 0.09, 0.3, 0.42], $B = [2, 3, 0, 1], Te0 = [3, 2, 1, 0], Se0 = [0, 3, 1, 2], _e0 = [1, 2, 0, 3], Re0 = [0, 3, 1, 2], Ae0 = [0, 0.1, 0.32, 0.44], ke0 = [1, 1.13, 1.3, 1.43], Ce0 = [0.4, 0.2, 0.1], Pe0 = [[-0.4, 0.9, 0.5], [0.05, 0.9, 1.7], [-0.3, -1.3, 2.2], [0, -0.3, 0.9]];
function ZB(o2) {
  o2.modeT = 0, o2.prevMode = "none", o2.deployT = -1, o2.barkT = -1, o2.barkLeg = 0, o2.standT = 9, o2.dieT = -1, o2.dieKind = "shot", o2.dieSide = 1, o2.dieDur = rr.die, o2.frozen = false, o2.stillT = 0, o2.hitL = { x: 0, z: 1, ok: false }, o2.flinchT = 9, o2.blinkT = 0, o2.alertK = 0, o2.leapPitch = 0, o2.leapH = 0.45, o2.vyLast = 0, o2.scriptK = 0, o2.sig = { power: 0, alert: 0, damage: 0, charge: 0, shock: 0 }, o2.bp = new t3(), o2.bv = new t3(), o2.bw = new t3(), o2.bounces = 0, o2.blastRest = 0, o2.pawDur = 1, o2.shakeT = -1;
}
function lv(o2, t, e, s) {
  let n = o2.state;
  return s.x = n.x + t * o2.cy + e * o2.sy, s.z = n.z - t * o2.sy + e * o2.cy, s;
}
function QB(o2, t, e = 1) {
  let s = Ys(e, 0.15, 2), n = 0, i = 1;
  if (t) {
    let a = t.x * o2.cy - t.z * o2.sy, r = t.x * o2.sy + t.z * o2.cy, l = zc(a, r);
    l > 1e-4 && (n = a / l, i = r / l);
  }
  o2.hitL.x = n, o2.hitL.z = i, o2.hitL.ok = true, o2.sx.v += n * 0.85 * s, o2.sz.v += i * 0.85 * s, o2.rl.v -= n * 3.6 * s, o2.pt.v += i * 2.6 * s, o2.hv.v -= 0.4 * s, o2.yw.v += n * i * 2.2 * s, o2.gzOk && (o2.gzY.v -= n * 7 * s, o2.gzP.v -= 3.5 * s), o2.ear[0].v -= 13 * s, o2.ear[1].v -= 13 * s, o2.flinchT = 0, o2.blinkT = 0.07, o2.limpLeg < 0 && (o2.limpLeg = (i > 0.2 ? 0 : 2) + (n > 0 ? 0 : 1));
}
function JB(o2) {
  if (o2.mode !== "idle" && o2.mode !== "move") return 0;
  o2.barkT = 0;
  let t = Bn(o2.rng) < 0.5 ? 0 : 1;
  return o2.state.lookAt && (o2.toLocal(Uo.copy(o2.state.lookAt)), Math.abs(Uo.x) > 0.3 && (t = Uo.x > 0 ? 0 : 1)), o2.barkLeg = t, o2.hv.v -= 0.3, o2.pt.v -= 0.5, rr.bark;
}
function tU(o2) {
  return o2.deployT = 0, o2.dieT = -1, o2.frozen = false, rr.deploy;
}
function eU(o2, t, e = "shot") {
  if (o2.dieKind = e === "blast" || e === "expire" ? e : "shot", o2.dieT = 0, o2.frozen = false, o2.stillT = 0, o2.deadClear = 0, o2.dieDur = o2.dieKind === "blast" ? rr.blast : o2.dieKind === "expire" ? rr.expire : rr.die, t) {
    let s = t.x * o2.cy - t.z * o2.sy, n = t.x * o2.sy + t.z * o2.cy, i = zc(s, n);
    i > 1e-4 && (o2.hitL.x = s / i, o2.hitL.z = n / i, o2.hitL.ok = true);
  }
  return o2.dieSide = Math.abs(o2.hitL.x) > 0.25 && o2.hitL.ok ? o2.hitL.x > 0 ? 1 : -1 : Bn(o2.rng) < 0.5 ? -1 : 1, o2.dieInit = false, o2.dieDur;
}
function sU(o2) {
  o2.live = false, o2.mode = "none", o2.modeT = 0, o2.deployT = -1, o2.barkT = -1, o2.dieT = -1, o2.frozen = false, o2.standT = 9, o2.limpLeg = -1, o2.limpK = 0, o2.hitL.ok = false, o2.free = false, o2.air = false, o2.pawLeg = -1, o2.alertK = 0, o2.scriptK = 0, o2.sig.power = o2.sig.alert = o2.sig.damage = o2.sig.charge = o2.sig.shock = 0, o2.shakeT = -1;
}
function nU(o2, t) {
  let e = o2.state, s = o2.goal, n = e.mode;
  if (n !== o2.mode) {
    let l = o2.mode;
    o2.prevMode = l, o2.mode = n, o2.modeT = 0, Le0(o2, n, l);
  } else o2.modeT += t;
  o2.alertK = Di(o2.alertK, e.alert, 8, t), o2.flinchT += t, o2.blinkT -= t, ze0(o2);
  let i = n === "leap" || !e.grounded && rv(n);
  if (i && !o2.air) {
    o2.air = true, o2.airT = 0, o2.blend = 2, o2.leapPitch = o2.pitch, o2.leapH = o2.fin[1] - o2.supY.x;
    for (let l of o2.legs) l.landed = false;
  } else !i && o2.air && (o2.air = false, o2.blend = 2, rv(n) && Ue0(o2));
  let a = 0;
  switch (n) {
    case "deploy":
      a = We0(o2, t);
      break;
    case "sit":
      aU(o2, av(o2.modeT, 0.1, 0.52, 0.05), o2.modeT, t, true);
      break;
    case "windup":
      De0(o2, t);
      break;
    case "leap":
      rU(o2, t, 0.85, true);
      break;
    case "takedown":
      Ve0(o2, t);
      break;
    case "dead":
      a = Ke0(o2, t);
      break;
    default:
      oU(o2, t, n);
  }
  if (o2.scriptK = a >= 0 ? Di(o2.scriptK, a, 16, t) : -a, s.script = o2.scriptK, n !== "dead") {
    o2.flinchT < 0.22 && (s.ears[0] = Math.min(s.ears[0], -0.8), s.ears[1] = Math.min(s.ears[1], -0.8));
    let l = Pc(0.38, 0.16, e.hp);
    o2.limpK = Di(o2.limpK, l, 3, t), l > 0 && o2.limpLeg < 0 && (o2.limpLeg = Math.floor(Bn(o2.rng) * 4) & 3);
    let c = o2.limpK;
    if (c > 0.01 && n !== "deploy") {
      let h = o2.limpLeg & 1 ? 1 : -1;
      s.roll += h * 0.05 * c, s.x -= h * 0.016 * c, s.neck -= 0.24 * c, s.headPitch -= 0.07 * c, s.h -= 0.02 * c, s.ears[0] -= 0.35 * c, s.ears[1] -= 0.15 * c, s.tail[0][1] += 0.3 * c, s.tail[1][1] += 0.15 * c;
      let f = W1(o2.time * 21, o2.seed + 3), u = W1(o2.time * 5.3, o2.seed + 9);
      f > 0.45 - 0.25 * c && u > -0.2 && (s.power *= 0.25 + 0.3 * Bn(o2.rng));
    }
    o2.blinkT > 0 && (s.power *= 0.3), o2.shakeT >= 0 && qe0(o2, t);
  } else o2.shakeT = -1;
  let r = o2.sig;
  r.power = s.power, r.alert = s.alert, r.charge = s.charge, r.shock = s.shock, r.damage = n === "dead" ? Math.max(r.damage, o2.dieKind === "expire" ? 0 : o2.dieKind === "blast" ? 1 : 0.8) : Pc(0.8, 0.12, e.hp);
}
function ze0(o2) {
  let t = o2.goal, e = o2.state, s = o2.G, n = o2.alertK, i = o2.gallopK, a = o2.trotK;
  t.h = ue.stand - s.crouch - 0.012 * n, t.x = t.z = t.pitch = t.roll = t.yaw = 0, t.terrain = 1, t.sink = 0.2, t.gait = true, t.settle = true, t.idle = 1, t.gaze = e.lookAt ? T7 : o2.sEff > 0.45 ? BB : S7, t.gazeW = 26 + 8 * n, t.gazeYaw = t.gazePitch = 0, t.neck = 0.25 + 0.1 * n - 0.06 * a - 0.3 * i, t.stab = 1, t.tilt = 0, t.headRoll = t.headYaw = t.headPitch = 0, t.ears[0] = t.ears[1] = as(as(0.15, 0.5, n), -0.75, i), t.earW = 34, t.tail[0][0] = t.tail[1][0] = t.tail[2][0] = 0, t.tail[0][1] = as(as(0.1, -0.22, n), 0.42, i), t.tail[1][1] = 0.05 + 0.1 * i, t.tail[2][1] = 0.04 * i, t.tailW = 20, t.tailZ = 0.24, t.wag = 0, t.jaw = 0, t.power = 1, t.alert = e.alert, t.charge = 0, t.shock = 0, o2.cadence = 1, o2.spread = 0.02;
}
function Le0(o2, t, e) {
  let s = o2.state, n = o2.legs;
  if (e === "none" || e === "folded") if (o2.snap(), t === "deploy") {
    for (let i of n) o2.footOfPose(i.i, o2.P_FOLD, Uo), o2.plant(i, Uo.x, Uo.z);
    t6(o2, o2.P_FOLD), o2.scriptK = 1, o2.deployT < 0 && (o2.deployT = 0);
  } else t6(o2, o2.P_STAND), o2.scriptK = 0;
  else rv(t) && rv(e) || (o2.blend = 2);
  switch (e === "sit" && rv(t) && (o2.standT = 0), e === "deploy" && (o2.deployT = -1), t !== "idle" && t !== "move" && (o2.barkT = -1, iU(o2)), t) {
    case "windup":
      for (let i of n) i.mode !== Ei && o2.land(i, 0.05, 0.4);
      break;
    case "takedown": {
      for (let i of n) lv(o2, i.side * (i.front ? 0.29 : 0.25), i.front ? -0.55 : 0.37, Uo), o2.step(i, Uo.x, Uo.z, i.mode === Ei ? 0.09 : i.front ? 0.04 : 0.07, i.mode === Ei ? 0.03 : 0, 0, i.front ? 1 : 0.7);
      o2.hv.v -= 0.4, o2.pt.v -= 0.8, o2.finV[1] *= 0.3, o2.finV[3] *= 0.1;
      break;
    }
    case "stagger": {
      let i = o2.hitL, a = 1;
      o2.sx.v += i.x * 1.5 * a, o2.sz.v += i.z * 1.5 * a, o2.rl.v -= i.x * 4.5, o2.pt.v += i.z * 3.6, o2.hv.v -= 0.7, o2.yw.v += (Bn(o2.rng) - 0.5) * 5, o2.gzOk && (o2.gzY.v -= i.x * 10, o2.gzP.v -= 6), o2.blinkT = 0.1, o2.settleT = 0;
      break;
    }
    case "dead":
      o2.dieT < 0 && (o2.dieT = 1e3, o2.dieKind = "shot", o2.dieDur = rr.die, o2.dieInit = false);
      break;
  }
}
function oU(o2, t, e) {
  let s = o2.state, n = o2.goal, i = o2.legs;
  if (o2.air) {
    rU(o2, t, 0.5, false);
    return;
  }
  o2.landT += t;
  let a = o2.sEff < 0.15;
  if (e === "stagger") {
    let r = o2.modeT, l = rr.stagger;
    n.h -= 0.07 * f1(r, 0, l * 1.1), n.idle = 0, o2.cadence = 1.45, o2.spread = 0.05, n.ears[0] = n.ears[1] = -0.8, n.jaw = 0.32 * f1(r, 0, 0.26), n.neck -= 0.2 * f1(r, 0, l);
    for (let c = 0; c < 4; c++) if (Lh(r, t, c * 0.065)) {
      let h = o2.hitL.x >= 0 ? _e0[c] : Re0[c], f = i[h];
      f.mode === Ei && !o2.gaitOn && (lv(o2, o2.hitL.x * 0.13, o2.hitL.z * 0.13, Uo), o2.step(f, f.home.x + Uo.x - s.x, f.home.z + Uo.z - s.z, 0.1, 0.05, 0, 0.5));
    }
    (r > 0.03 && r < 0.07 || r > 0.14 && r < 0.17) && (n.power *= 0.35);
    return;
  }
  if (e === "idle" && a && o2.barkT < 0) {
    if (o2.idleT -= t, o2.idleT <= 0 && (Bn(o2.rng) < 0.5 || o2.limpK > 0.2 ? o2.idleTx = (Bn(o2.rng) < 0.5 ? -1 : 1) * (0.012 + 0.014 * Bn(o2.rng)) : o2.pawLeg < 0 && (o2.pawLeg = Bn(o2.rng) < 0.5 ? 0 : 1, o2.pawT = 0, o2.pawDur = 1 + Bn(o2.rng) * 1.4, o2.idleTx = -i[o2.pawLeg].side * 0.022), o2.idleT = 2.2 + Bn(o2.rng) * 3.8), n.gaze === S7) {
      let r = o2.scanYaw > 0 ? 0 : 1;
      n.ears[r] += 0.38, n.ears[1 - r] += 0.08;
    }
    s.lookAt && o2.alertK < 0.25 && (o2.toLocal(Uo.copy(s.lookAt)), Uo.x * Uo.x + Uo.z * Uo.z < 9 && (n.wag = 0.45, n.tail[0][1] -= 0.2));
  }
  if (o2.pawLeg >= 0) {
    let r = i[o2.pawLeg];
    o2.pawT += t, !a || e !== "idle" || o2.pawT > o2.pawDur || o2.barkT >= 0 ? iU(o2) : o2.pawT > 0.28 && (r.mode === Ei || r.mode === zf) && o2.freeLeg(r, r.side * (Pf - 5e-3), KB + 0.085, qB(true) + 0.055, 12);
  }
  if (o2.barkT >= 0) {
    o2.barkT += t;
    let r = o2.barkT, l = rr.bark, c = i[o2.barkLeg], h = 1 - Pc(0.5, 1.3, o2.sEff), f = Cn(r, 0.05, 0.2) * (1 - Cn(r, l - 0.2, l)) * h;
    n.h -= 0.075 * f, n.z -= 0.06 * f, n.pitch -= 0.045 * f, n.idle = 1 - Pc(0, 0.05, r) * (1 - Cn(r, l - 0.1, l)), h > 0.5 && (n.gait = false, n.settle = false), n.gazeW = 44, n.neck = as(n.neck, -0.14, f), n.alert = Math.max(n.alert, 1 - Cn(r, l - 0.15, l + 0.2)), n.ears[0] = n.ears[1] = 0.68, n.earW = 46, n.tail[0][1] = as(n.tail[0][1], 0.66, f), n.tail[1][1] = as(n.tail[1][1], 0.03, f), n.tail[2][1] = 0, n.tailW = 46, n.tailZ = 0.85, n.jaw = 0.45 * (f1(r, 0.03, 0.14) + f1(r, 0.2, 0.31) + f1(r, 0.37, 0.48)), r > 0.07 && r < l - 0.22 && h > 0.5 ? (c.mode === Ei || c.mode === zf) && o2.freeLeg(c, c.side * (Pf - 0.012), KB + 0.075 + 0.165, qB(true) + 0.05, 22) : c.mode === zf && o2.step(c, c.home.x, c.home.z, 0.13, 0, 0, 0.3), r >= l && (o2.barkT = -1);
  }
  o2.standT < rr.stand + 0.2 && (o2.standT += t, aU(o2, 1 - av(o2.standT, 0, rr.stand, 0.04), 0, t, false)), e === "move" && (n.idle = 0.6);
}
function iU(o2) {
  if (o2.pawLeg < 0) return;
  let t = o2.legs[o2.pawLeg];
  o2.pawLeg = -1, o2.idleTx = 0, t.mode === zf && o2.step(t, t.home.x, t.home.z, 0.15, 0, 0, 0.16);
}
function aU(o2, t, e, s, n) {
  let i = o2.goal, a = o2.legs, r = o2.state;
  if (i.h = as(i.h, 0.4, t), i.z += 0.06 * t, i.pitch += 0.62 * t, !n) return;
  i.gait = false, i.settle = false, i.idle = 0.6;
  let l = Ee0, c = $B;
  for (let h = 0; h < 4; h++) if (Lh(e, s, l[h]) || e === 0 && h === 0) {
    let f = a[c[h]];
    lv(o2, f.side * (f.front ? 0.21 : 0.25), f.front ? -0.36 : 0.22, Uo), o2.step(f, Uo.x, Uo.z, 0.13, f.mode === Ei ? 0.03 : 0, 0, 0.15);
  }
  i.neck = as(i.neck, -0.3, t), i.ears[0] = 0.42, i.ears[1] = 0.3, i.tail[0][1] = as(i.tail[0][1], -0.5, t), i.tail[1][1] = 0.1, i.tail[2][1] = 0.1, r.lookAt && o2.alertK < 0.3 && e > 0.5 && (i.wag = 0.55 + 0.45 * Math.max(0, W1(o2.time * 0.6, o2.seed + 5)), W1(o2.time * 0.33, o2.seed + 2) > 0.35 && (i.tilt = 0.26 * (W1(o2.time * 0.2, o2.seed) > 0 ? 1 : -1)));
}
function De0(o2, t) {
  let e = o2.goal, s = o2.modeT, n = iv(s / rr.windup);
  e.gait = o2.sEff > 0.7, e.idle = 0, e.h -= 0.2 * Cn(n, 0, 0.72), e.z += 0.085 * Cn(n, 0, 0.7), e.pitch += -0.065 * f1(n, 0, 0.6) + 0.2 * Cn(n, 0.42, 1), e.roll += 7e-3 * n * Math.sin(s * 138), e.gazeW = 44, e.neck = as(e.neck, -0.1, Cn(n, 0, 0.5)), e.stab = 0.5, e.ears[0] = e.ears[1] = -0.7, e.earW = 46, e.tail[0][1] = 0.62, e.tail[1][1] = 0.1, e.tail[2][1] = 0.05, e.tail[2][0] = 0.1 * n * Math.sin(s * 88), e.tailW = 40, e.tailZ = 0.6, e.jaw = 0.55 * Cn(n, 0.15, 0.9), e.charge = n, e.alert = 1;
}
var Ie0 = [0.16, -0.17, -0.82], He0 = [0.15, -0.27, -0.52], Fe0 = [0.19, -0.49, -0.61], Oe0 = [0.17, -0.27, 0.86], Ne0 = [0.17, -0.31, 0.6], Be0 = [0.2, -0.46, 0.22];
function rU(o2, t, e, s) {
  let n = o2.state, i = o2.goal, a = o2.legs;
  o2.airT += t;
  let r = n.vy !== 0 || n.vx !== 0 || n.vz !== 0 ? n.vy : o2.vyM, l = Math.max(zc(n.vx, n.vz), o2.speed);
  o2.vyLast = r;
  let c = Ys(r / 3.2, -1, 1), h = c > 0 ? c : 0, f = c < 0 ? -c : 0;
  o2.leapPitch = Di(o2.leapPitch, Ys(Math.atan2(r, Math.max(l, 1.4)) * e, -0.55, 0.72), 15, t), o2.leapH = Di(o2.leapH, 0.45, 7, t), i.pitch = o2.leapPitch, i.h = o2.leapH, i.terrain = 0, i.gait = false, i.settle = false, i.idle = 0;
  for (let u = 0; u < 4; u++) {
    let d = a[u];
    if (d.mode !== zf && (d.landed && d.reach > 0.9 && (d.landed = false), d.mode === Zu || d.landed || (d.front ? o2.airT < 0.025 : d.reach < 0.9 && o2.airT < 0.1 && d.mode === Ei))) continue;
    let m = d.front ? c >= 0 ? Ie0 : Fe0 : c >= 0 ? Oe0 : Be0, p = d.front ? He0 : Ne0, x = h + f, g = (d.side > 0 ? 0.035 : -0.035) * (d.front ? 1 : -1);
    o2.freeLeg(d, d.side * as(p[0], m[0], x), as(p[1], m[1], x), as(p[2], m[2], x) + g, s ? 30 : 22);
  }
  s && (i.gazeW = 44, i.neck = 0.02, i.stab = 0, i.jaw = 0.7 * Cn(o2.airT, 0, 0.12), i.charge = 1, i.alert = 1, i.tail[2][0] = 0.12 * Math.sin(o2.time * 70)), i.ears[0] = i.ears[1] = -0.85, i.tail[0][1] = 0.55, i.tail[1][1] = 0.15, i.tail[2][1] = 0.05, i.tailZ = 0.3;
}
function Ue0(o2) {
  let t = Ys(-Math.min(o2.vyLast, 0), 0, 9);
  for (let e of o2.legs) e.mode !== Ei && o2.land(e, e.front ? 0.03 : 0.065, 1);
  o2.hv.v -= 0.25 + 0.12 * t, o2.pt.v -= 0.5 + 0.3 * t, o2.landT = 0, o2.skid = Ys(o2.speed / 7, 0, 0.8);
}
function Ve0(o2, t) {
  let e = o2.goal, s = o2.modeT, n = rr.takedown, i = n / 0.75;
  e.gait = false, e.settle = false, e.idle = 0, e.sink = 0.09;
  let a = Math.max(f1(s, 0.09 * i, 0.23 * i), f1(s, 0.28 * i, 0.42 * i), f1(s, 0.46 * i, 0.6 * i)), r = Cn(s, n - 0.15, n);
  for (let l = 0; l < 3; l++) Lh(s, t, (0.09 + 0.19 * l) * i) && (o2.hv.v += 0.55, o2.pt.v += 0.9);
  e.h = 0.43 + 0.03 * a + 0.07 * r, e.z = -0.06 * (1 - r), e.pitch = -0.24 + 0.05 * a + 0.18 * r, e.roll = 0.03 * a * Math.sin(s * 195), e.yaw = 0.018 * a * Math.sin(s * 171), e.x = 4e-3 * a * Math.sin(s * 233), o2.spread = 0.05, e.gazeW = 44, e.neck = -0.25 + 0.3 * r, e.stab = 0, e.headYaw = 0.13 * a * Math.sin(s * 57), e.headRoll = 0.1 * a * Math.sin(s * 57 + 1.1), e.jaw = as(0.7, 0.1, Cn(s, 0.02, 0.07)) + 0.03 * a * Math.sin(s * 201) + 0.32 * f1(s, n - 0.15, n - 0.01), e.ears[0] = e.ears[1] = -0.85, e.tail[0][1] = -0.45, e.tail[1][1] = -0.1, e.tail[2][1] = 0, e.tail[1][0] = 0.1 * a * Math.sin(s * 150), e.tail[2][0] = 0.16 * a * Math.sin(s * 150 + 1), e.tailW = 46, e.tailZ = 0.5, e.shock = a, e.charge = 1 - s / n, e.alert = 1;
}
var SC = { relay: 0, whine: [0.02, 0.55], unlock: [0.1, 0.17, 0.24, 0.31], lift1: [0.36, 0.5], lift2: [0.53, 0.65], head: 0.62, ears: [0.71, 0.75], antenna: 0.78, taps: [0.8, 0.83, 0.86, 0.89], shake: [0.91, 1] }, lU = 0.4, Ge0 = 8.5;
function We0(o2, t) {
  let e = o2.state, s = o2.goal, n = o2.legs, i = rr.deploy, a = SC;
  if (o2.deployT === 0 && (o2.hv.v += 0.12), o2.deployT += t, o2.deployT >= i) return oU(o2, t, "idle"), 0;
  let r = o2.deployT / i, l = t / i;
  s.gait = false, s.settle = false, s.idle = Cn(r, 0.8, 1), s.terrain = Cn(r, 0.55, 0.75);
  let c = r < 0.02 ? 0 : r < 0.04 ? 0.55 : r < 0.065 ? 0 : r < 0.08 ? 0.8 : r < 0.12 ? 0.12 : as(0.15, 0.62, Cn(r, 0.12, 0.55));
  c = Math.max(c, Cn(r, a.head, a.head + 0.07)), s.power = c;
  let h = f1(r, 0, 0.13), f = Te0;
  for (let g = 0; g < 4; g++) if (Lh(r, l, a.unlock[g])) {
    let b = n[f[g]];
    lv(o2, b.side * 0.05, -0.035, Uo), o2.step(b, b.pos.x + Uo.x - e.x, b.pos.z + Uo.z - e.z, 0.062 * i, 0.06, 0.5, 0.16), o2.rl.v += b.side * 1.5, o2.pt.v += b.front ? 0.9 : -0.9, o2.hv.v += 0.22;
  }
  let u = av(r, a.lift1[0], a.lift1[1], 0.07), d = av(r, a.lift2[0], a.lift2[1], 0.055), m = Cn(r, 0.03, 0.1) * (1 - u);
  s.h = ue.rest + 0.022 * m + (0.33 - ue.rest) * u + (ue.stand - 0.33) * d + 3e-3 * h * Math.sin(r * 335), s.pitch = -0.3 * u + 0.3 * d + 0.012 * h * Math.sin(r * 290), s.roll = 0.022 * h * Math.sin(r * 255);
  let p = Se0, x = 0.046;
  for (let g = 0; g < 4; g++) if (Lh(r, l, a.taps[g] - x)) {
    let b = n[p[g]];
    o2.step(b, b.home.x, b.home.z, x * i, 0.05, 0, 0.26);
  }
  if (Lh(r, l, a.shake[0] - 6e-3) && (o2.shakeT = 0), s.sNeck[0] = 0, s.sNeck[1] = o2.P_FOLD.neck[1], s.sHead[0] = 0, s.sHead[1] = o2.P_FOLD.head[1], s.sHead[2] = 0, s.stab = Cn(r, 0.72, 0.8), r < 0.975 || !e.lookAt ? (s.gaze = J4, s.gazeYaw = 0, s.gazePitch = 0) : (s.gaze = T7, s.gazeW = 46), s.neck = 0.25 + 0.1 * Cn(r, 0.95, 1), s.ears[0] = r < a.ears[0] ? -0.8 : 0.4 + 0.22 * Cn(r, 0.97, 1), s.ears[1] = r < a.ears[1] ? -0.8 : 0.4 + 0.1 * Cn(r, 0.97, 1), s.earW = 48, r < a.antenna) {
    for (let g = 0; g < 3; g++) s.tail[g][1] = o2.P_FOLD.tail[g][1];
    s.tailW = 30, s.tailZ = 1;
  } else s.tail[0][1] = -0.3, s.tail[1][1] = -0.05, s.tail[2][1] = 0, s.tailW = 26, s.tailZ = as(0.09, 0.24, Cn(r, 0.86, 1));
  return Lh(r, l, a.antenna) && (o2.tailS[0].p.v += 5, o2.tailS[1].p.v += 9, o2.tailS[2].p.v += 13, o2.tailS[2].y.v += 3), s.jaw = 0.22 * f1(r, 0.66, 0.74), 1 - Q5(r, a.head, a.head + 0.13, 0.45);
}
var EC = (o2, t) => Cn(o2, t, t + 0.045) * (1 - Cn(o2, t + 0.13, t + lU - 0.08));
function qe0(o2, t) {
  let e = o2.goal, s = o2.shakeT, n = x7 * Ge0;
  if (o2.shakeT += t, s > lU + 0.12) {
    o2.shakeT = -1;
    return;
  }
  let i = EC(s, 0), a = EC(s, 0.035), r = EC(s, 0.08), l = n * s;
  e.headRoll += 0.36 * i * Math.sin(l), e.headYaw += 0.1 * i * Math.sin(l + 1.2), e.roll += 0.085 * a * Math.sin(l - 0.035 * n), e.yaw += 0.03 * a * Math.sin(l - 0.035 * n + 0.8), e.x += 6e-3 * a * Math.sin(l - 0.035 * n + 0.4), e.ears[0] += 0.35 * i * Math.sin(l + 1.6), e.ears[1] -= 0.35 * i * Math.sin(l + 1.6);
  for (let c = 0; c < 3; c++) e.tail[c][0] += 0.5 * r * Math.sin(l - 0.08 * n - c * 0.8);
}
var XB = [[-0.12, -0.08, -0.4], [0.12, -0.08, -0.4], [-0.12, 0.08, -0.4], [0.12, 0.08, -0.4], [-0.12, -0.08, 0.4], [0.12, -0.08, 0.4], [-0.12, 0.08, 0.4], [0.12, 0.08, 0.4], [-0.2, 0, -0.3, 0.062], [0.2, 0, -0.3, 0.062], [-0.2, 0, 0.3, 0.062], [0.2, 0, 0.3, 0.062]];
function cU(o2) {
  let t = 1e9;
  for (let e = 0; e < XB.length; e++) {
    let s = XB[e];
    Fa.set(s[0], s[1], s[2]).applyQuaternion(o2);
    let n = Fa.y - (s[3] || 0);
    n < t && (t = n);
  }
  return t;
}
function Ke0(o2, t) {
  let e = o2.goal;
  return o2.dieT += t, e.gait = false, e.settle = false, e.idle = 0, e.alert = o2.state.alert, e.stab = 0, o2.dieKind === "blast" ? Ze0(o2, t) : o2.dieKind === "expire" ? je0(o2, t) : Ye0(o2, t);
}
function Xe0(o2, t, e, s = -1) {
  for (let n of o2.legs) {
    if (s >= 0 && n.i !== s) continue;
    let i = n.side === t, a = n.front;
    i ? o2.poseLeg(n, 0.02, a ? 0.7 : -0.5, a ? 1.25 : 1.6, e, true) : o2.poseLeg(n, -0.42, a ? 0.25 : -0.8, a ? 0.85 : 1.25, e, true);
  }
}
function Ye0(o2, t) {
  let e = o2.goal, s = o2.legs, n = o2.dieT, i = o2.dieSide, a = rr.die / 1.6, r = n / a;
  if (!o2.dieInit) {
    o2.dieInit = true;
    for (let y of s) y.mode !== Ei && y.mode !== Zu && o2.land(y, 0.05, 0.3);
  }
  let l = Q5(r, 0.04, 0.3, 0.55), c = Q5(r, 0.24, 0.5, 0.6), h = Q5(r, 0.42, 0.62, 0.5), f = Cn(r, 0.64, 0.86) * (1 - Cn(r, 1, 1.1)), u = Q5(r, 1, 1.26, 0.5), d = Cn(r, 0.7, 0.98) * (1 - Cn(r, 1, 1.04)), m = ue.stand - 0.12 * l - 0.17 * c - 0.12 * h, p = 0.14 * l - 0.26 * c + 0.12 * h, x = -i * (0.28 * l + 0.08 * c - 0.16 * h);
  m += 0.15 * f, p += 0.36 * f, x += i * 0.1 * f, m -= 0.02 * u, x -= i * 0.86 * u;
  let g = d * (0.4 + 0.6 * W1(n * 9, o2.seed));
  if (e.h = m + 4e-3 * g * Math.sin(n * 77), e.pitch = p + 0.012 * g * Math.sin(n * 83), e.roll = x + 0.018 * g * Math.sin(n * 71), e.x = i * 0.05 * u, e.terrain = 1 - Cn(r, 0, 0.5), Lh(r, t / a, 0.52) && (o2.hv.v -= 0.5, o2.onStep && o2.onStep(s[i > 0 ? 1 : 0].i, o2._c.copy(s[i > 0 ? 1 : 0].pos), 0.9)), Lh(r, t / a, 1.16) && (o2.hv.v -= 0.35, o2.rl.v -= i * 1.2, o2.onStep && o2.onStep(s[i > 0 ? 3 : 2].i, o2._c.copy(s[i > 0 ? 3 : 2].pos), 1)), r >= 1 && Xe0(o2, i, r < 1.3 ? 11 : 7), Lh(r, t / a, 1.4)) {
    let y = s[i > 0 ? 0 : 1];
    y.angV[1] += 5, y.angV[2] -= 6;
  }
  let b = Cn(r, 1.02, 1.45);
  e.gaze = J4, e.gazeYaw = i * 0.25 * (l - f), e.gazePitch = -0.35 * c * (1 - f) + 0.3 * f, e.gazeW = 18, e.neck = 0.25 - 0.5 * c * (1 - f) + 0.2 * f, e.sNeck[0] = -i * 0.25, e.sNeck[1] = -0.75, e.sHead[0] = -i * 0.2, e.sHead[1] = -0.35, e.sHead[2] = i * 0.35, e.ears[0] = e.ears[1] = as(-0.8, -0.55, b), e.ears[i > 0 ? 1 : 0] -= 0.2, e.earW = as(34, 12, b), e.tail[0][1] = as(0.3, 0.75, u), e.tail[1][1] = as(0.1, 0.4, u), e.tail[2][1] = as(0, 0.3, u), e.tail[0][0] = -i * 0.3 * u, e.tailW = as(20, 9, u), e.tailZ = 0.4, e.jaw = 0.25 * l * (1 - f) + 0.15 * b;
  let v = W1(n * 26, o2.seed + 1);
  return e.power = r < 0.6 ? v > 0.2 ? 0.35 : 0.9 : r < 1.02 ? v > -0.1 ? 0.25 + 0.5 * d : 0.85 : (1 - Cn(r, 1.05, 1.5)) * (v > 0.3 ? 0.15 : 0.6), r > 1.52 && (e.power = 0), hU(o2, t, r > 1 ? 1 : 0, r >= 1.6), b;
}
function je0(o2, t) {
  let e = o2.state, s = o2.goal, n = o2.legs, i = rr.expire / 2.3, a = o2.dieT / i, r = t / i, l = o2.P_FOLD;
  if (!o2.dieInit) {
    o2.dieInit = true;
    for (let g of n) g.mode !== Ei && g.mode !== Zu && o2.land(g, 0.06, 0.3);
  }
  let c = iv(Q5(a, 0.08, 0.56, 0.7)), h = Cn(a, 1.12, 1.86), f = Ae0, u = $B;
  for (let g = 0; g < 4; g++) if (Lh(a, r, f[g]) || o2.dieT === t && g === 0) {
    let b = n[u[g]];
    b.mode !== Zu && (lv(o2, b.side * (b.front ? 0.21 : 0.25), b.front ? -0.36 : 0.22, Uo), o2.step(b, Uo.x, Uo.z, 0.15, 0.03, 0, 0.15));
  }
  let d = ke0;
  for (let g = 0; g < 4; g++) if (Lh(a, r, d[g])) {
    let b = n[u[g]];
    b.mode !== Zu && (o2.footOfPose(b.i, l, Uo), o2.step(b, Uo.x, Uo.z, 0.2, 0.035, 0, 0.14));
  }
  if (s.h = as(as(ue.stand, 0.4, c), ue.rest, h), s.z = 0.06 * c * (1 - h), s.pitch = 0.62 * c * (1 - h), s.terrain = 1 - h, a > 1.9) for (let g of n) o2.poseLeg(g, l.leg[g.i][0], l.leg[g.i][1], l.leg[g.i][2], 16, false);
  let m = Cn(a, 0.5, 1);
  s.gaze = J4, s.gazeYaw = 0, s.gazePitch = -0.5 * m, s.gazeW = 7, s.neck = as(0.25, -0.6, m), s.sNeck[0] = 0, s.sNeck[1] = l.neck[1], s.sHead[0] = 0, s.sHead[1] = l.head[1], s.sHead[2] = 0, s.ears[0] = s.ears[1] = as(0.1, -0.8, Cn(a, 0.5, 1.5)), s.earW = 14;
  let p = Cn(a, 1.3, 2.05);
  for (let g = 0; g < 3; g++) s.tail[g][1] = as(Ce0[g], l.tail[g][1], p), s.tail[g][0] = 0;
  s.tailW = 12, s.tailZ = 0.9;
  let x = 0.5 + 0.5 * Math.sin(a * 9);
  return s.power = a < 2 ? as(1, 0.18, Cn(a, 0, 1.6)) * (0.55 + 0.45 * x) : a < 2.1 ? 0 : a < 2.16 ? 0.4 : 0, a >= 2.3 && (s.power = 0, o2.stillT += t, o2.stillT > 0.5 && ($e0(o2), o2.frozen = true)), Cn(a, 1.5, 2);
}
function $e0(o2) {
  let t = o2.pose, e = o2.P_FOLD;
  t.pos.copy(e.pos), t.quat.copy(e.quat);
  for (let s = 0; s < 4; s++) for (let n = 0; n < 3; n++) t.leg[s][n] = e.leg[s][n];
  t.neck[0] = e.neck[0], t.neck[1] = e.neck[1], t.head[0] = e.head[0], t.head[1] = e.head[1], t.head[2] = e.head[2], t.jaw = 0, t.ears[0] = e.ears[0], t.ears[1] = e.ears[1];
  for (let s = 0; s < 3; s++) t.tail[s][0] = e.tail[s][0], t.tail[s][1] = e.tail[s][1];
}
function Ze0(o2, t) {
  let e = o2.state, s = o2.goal, n = o2.legs, i = o2.dieT, a = o2.bp, r = o2.bv, l = o2.bw, c = o2.hitL;
  if (!o2.dieInit) {
    o2.dieInit = true, a.copy(o2.bpos);
    let m = o2.vx * o2.cy - o2.vz * o2.sy, p = o2.vx * o2.sy + o2.vz * o2.cy;
    r.set(c.x * 2.5 + m * 0.45, 3.5, c.z * 2.5 + p * 0.45), o2.fq.copy(o2.bq), o2.free = true, o2.air = true, o2.bounces = 0, o2.blastRest = 0, l.set(c.z * 8.5 + (Bn(o2.rng) - 0.5) * 3, (Bn(o2.rng) - 0.5) * 6, -c.x * 8.5 + (Bn(o2.rng) - 0.5) * 3);
    for (let x of n) o2.poseLeg(x, Bn(o2.rng) * 0.7 - 0.1, Bn(o2.rng) * 2 - 1.2, 0.3 + Bn(o2.rng) * 1.6, 10, false);
    for (let x of o2.io) x.x = 0, x.v = 0;
    o2.blend = 0;
    for (let x of ["hv", "pt", "rl", "sx", "sz", "yw", "idleX"]) o2[x].x = 0, o2[x].v = 0;
  }
  let h = false;
  if (o2.blastRest < 1) {
    r.y -= 9.81 * t, o2.clear && (o2.toWorld(Fa.copy(a)), o2.toWorld(e6.set(a.x + r.x * t * 3 + Math.sign(r.x) * 0.25, a.y, a.z + r.z * t * 3 + Math.sign(r.z) * 0.25)), o2.clear(Fa, e6) || (r.x *= -0.3, r.z *= -0.3, l.multiplyScalar(0.6))), a.addScaledVector(r, t);
    let m = l.length();
    m > 1e-4 && (Jr.setFromAxisAngle(GB.copy(l).multiplyScalar(1 / m), m * t), o2.fq.premultiply(Jr).normalize()), o2.toWorld(Fa.copy(a));
    let p = o2.gy(Fa.x, Fa.z) - e.y, x = p + 0.012 - (a.y + cU(o2.fq));
    Fa.set(0, 0, -1).applyQuaternion(o2.fq), e6.set(1, 0, 0).applyQuaternion(o2.fq), WB.setFromEuler(TC.set(0, Math.atan2(-Fa.x, -Fa.z), e6.y < 0 ? -1.05 : 1.05, "YXZ")), Jr.copy(WB).multiply(GB.set(0, 0, 0) && o2.bqi.copy(o2.fq).invert()), Jr.w < 0 && (Jr.x = -Jr.x, Jr.y = -Jr.y, Jr.z = -Jr.z, Jr.w = -Jr.w);
    let g = 2 * Math.acos(Math.min(1, Jr.w)), b = Math.sqrt(1 - Math.min(1, Jr.w * Jr.w));
    if (x > 0) {
      if (h = true, a.y += x, r.y < 0) {
        let y = -r.y;
        r.y = y > 1.3 ? y * 0.28 : 0, y > 1.3 && (o2.bounces++, l.multiplyScalar(0.55), o2.onStep && o2.onStep(0, o2.toWorld(o2._c.copy(a)), 1));
      }
      let v = Math.exp(-6 * t);
      if (r.x *= v, r.z *= v, b > 1e-4) {
        let y = 55 * g / b * t;
        l.x += Jr.x * y, l.y += Jr.y * y, l.z += Jr.z * y;
      }
      l.multiplyScalar(Math.exp(-7.5 * t)), o2.bounces > 0 && r.lengthSq() < 0.09 && l.lengthSq() < 0.5 && g < 0.1 && (o2.blastRest += t * 5);
    } else l.multiplyScalar(Math.exp(-0.25 * t));
    (o2.blastRest >= 1 || i > rr.blast + 1.2) && (o2.blastRest = 1, r.set(0, 0, 0), l.set(0, 0, 0));
  } else h = true;
  s.x = a.x, s.h = a.y, s.z = a.z, s.terrain = 0;
  let f = o2.bounces > 0;
  f && (e6.set(1, 0, 0).applyQuaternion(o2.fq), Qe0(o2, e6.y < 0 ? 1 : -1));
  let u = f ? Cn(i, 0.5, 1.2) : 0;
  s.sNeck[0] = as(0.6 * Math.sin(i * 9), 0.35, u), s.sNeck[1] = as(-0.2 + 0.4 * Math.sin(i * 7), -0.55, u), s.sHead[0] = as(0.5 * Math.sin(i * 11), 0.3, u), s.sHead[1] = as(0.3 * Math.sin(i * 8), -0.3, u), s.sHead[2] = as(0.4 * Math.sin(i * 6), 0.4, u), s.ears[0] = -0.3 + 0.4 * Math.sin(i * 13) * (1 - u), s.ears[1] = -0.6, s.earW = 16, s.tail[0][1] = 0.3, s.tail[1][1] = 0.3, s.tail[2][1] = 0.2, s.tail[0][0] = 0.4, s.tailW = 10, s.tailZ = 0.3, s.jaw = 0.4;
  let d = W1(i * 31, o2.seed + 4);
  return s.power = i < 0.06 ? 1 : i < 0.9 ? (d > 0.25 ? 0.7 : 0.05) * (1 - i / 0.9) : 0, hU(o2, t, 0, o2.blastRest >= 1 && i >= rr.blast), -1;
}
function Qe0(o2, t) {
  for (let e of o2.legs) {
    let s = Pe0[t > 0 ? e.i : e.i ^ 1];
    o2.poseLeg(e, s[0], s[1], s[2], 9, true);
  }
}
function hU(o2, t, e, s) {
  o2.deadClear = Di(o2.deadClear || 0, e, 10, t), s && (o2.stillT += t, o2.stillT > 0.7 && (o2.frozen = true));
}
function fU(o2) {
  if (o2.deadClear <= 0 || o2.free) return;
  let t = 0.012 - (o2.bpos.y + cU(o2.bq));
  t > 0 && (o2.bpos.y += t * o2.deadClear);
}
var YB = new THREE.Quaternion(), jB = new THREE.Quaternion();
function uU(o2) {
  let t = o2.pose;
  for (let e = 0; e < 3; e++) {
    jB.setFromEuler(TC.set(t.neck[1], t.neck[0], 0, "YXZ")), YB.setFromEuler(TC.set(t.head[1], t.head[0], t.head[2], "YXZ"));
    let s = 1e9;
    for (let a = 0; a < 4; a++) Fa.set(a & 1 ? 0.06 : -0.06, a & 2 ? 0.05 : -0.06, -0.2).applyQuaternion(YB), Fa.x += 0, Fa.y += 0.06, Fa.z -= 0.1, Fa.applyQuaternion(jB), Fa.y += 0.05, Fa.z -= 0.4, Fa.applyQuaternion(o2.bq), Fa.y < s && (s = Fa.y);
    let n = 0.012 - (o2.bpos.y + s);
    if (n <= 1e-3) break;
    let i = Fa.set(0, 1, 0).applyQuaternion(o2.bqi.copy(o2.bq).invert());
    t.neck[1] = Ys(t.neck[1] + n / 0.28 * (i.y >= 0 ? 1 : -1) * Math.max(0.35, Math.abs(i.y)), -1.1, 0.9), Math.abs(i.x) > 0.5 && (t.neck[0] = Ys(t.neck[0] + n / 0.28 * (i.x > 0 ? -1 : 1), -1.2, 1.2));
  }
}
var dU = { walk: 1.6, trot: 4.2, gallop: 9.5 }, Je0 = 1;
function pU({ team: o2 = 0, ground: t = null, clear: e = null, seed: s = 0 } = {}) {
  let n = new THREE.Group();
  n.name = "k9", n.rotation.order = "YXZ";
  let i = fB();
  n.add(i[0]);
  let a = RB({ team: o2, bones: i });
  a.mesh && !a.mesh.parent && n.add(a.mesh);
  for (let M of a.extras || []) M && !M.parent && n.add(M);
  let r = new M7({ ground: t, clear: e, seed: s || Je0++ });
  UB(r), ZB(r);
  let l = r.state, c = r.sig, h = r.pose, f = -1, u = -1, d = -1, m = -1, p = -1, x = () => {
    Math.abs(c.power - f) > 4e-3 && a.setPower(f = c.power), Math.abs(c.alert - u) > 4e-3 && a.setAlert(u = c.alert), Math.abs(c.damage - d) > 4e-3 && a.setDamage(d = c.damage), a.setCharge && Math.abs(c.charge - m) > 4e-3 && a.setCharge(m = c.charge);
    let M = c.shock * y.shockGain;
    a.setShock && Math.abs(M - p) > 4e-3 && a.setShock(p = M);
  }, g = () => {
    lC(h, r.P_FOLD), t6(r, r.P_FOLD);
    for (let M of r.legs) M.down = false, M.mode = 4;
    c.power = c.alert = c.charge = c.shock = 0;
  };
  g(), cC(i, h);
  let b = l7(), v = (M, w = 1) => {
    QB(r, M, w);
  };
  b.forEach((M, w) => {
    v[w] = M;
  }), Object.defineProperty(v, "length", { value: b.length }), v[Symbol.iterator] = () => b[Symbol.iterator]();
  let y = { root: n, bones: i, state: l, team: o2, timing: rr, cues: SC, triangles: a.triangles, model: a, hit: v, hitVolumes: b, flinch: v, anchors: { body: i[xs.body], head: i[xs.head], jaw: i[xs.jaw], tail: i[xs.tail3] }, onStep: null, gait: "stand", effort: 0, signals: c, feet: r.legs, pose: h, _rig: r, shockGain: 1, setTeam(M) {
    y.team = M, a.setTeam(M);
  }, setOpacity(M) {
    a.setFade && a.setFade(M);
  }, reset() {
    a.setFade && a.setFade(1), sU(r), l.mode = "folded", l.hp = 1, l.alert = 0, c.damage = 0, g(), x();
  }, deploy() {
    return tU(r);
  }, bark() {
    return JB(r);
  }, die(M, w = "shot") {
    return eU(r, M, w);
  }, update(M) {
    let w = l;
    if (n.position.set(w.x, w.y, w.z), w.mode === "folded" ? n.rotation.set(w.pitch || 0, w.yaw, w.roll || 0) : n.rotation.set(0, w.yaw, 0), M > 0 ? M > 0.05 && (M = 0.05) : M = 1e-4, r.onStep = y.onStep, w.mode === "folded") r.mode !== "folded" && (r.mode = "folded", r.live = false, r.dieT = -1, r.frozen = false, g()), y.gait = "stand", y.effort = 0;
    else if (!r.frozen) {
      if (!r.live || r.mode === "folded" || r.mode === "none") r.px = w.x, r.py = w.y, r.pz = w.z, r.pyaw = w.yaw;
      else {
        let S = w.x - r.px, E = w.z - r.pz;
        S * S + E * E > 6.25 && (r.snap(), t6(r, h));
      }
      r.time += M, r.kin(M), nU(r, M), r.gait(M), r.body(M), w.mode === "dead" && fU(r), r.solve(M), VB(r, M), w.mode === "dead" && uU(r), y.gait = r.gaitName;
      let T = Math.min(1, r.sEff / 9 + (r.air ? 0.5 : 0) + c.charge * 0.5 + c.shock * 0.6 + (r.shakeT >= 0 ? 0.5 : 0) + (w.mode === "deploy" ? 0.45 : 0.04));
      y.effort = r.effort += (T - r.effort) * Math.min(1, M * 10);
    }
    x(), cC(i, h), n.updateMatrixWorld(true), sv(i, b);
  } };
  return a.setTeam(o2), x(), y;
}


// =============================================================================
// Public Deep Space Controllers: GoldenHourK9, ColonistRig, FirstPersonBody
// =============================================================================

const _tmpV0 = new THREE.Vector3();
const _tmpV1 = new THREE.Vector3();
const _tmpV2 = new THREE.Vector3();
const _tmpV3 = new THREE.Vector3();
const _tmpQ0 = new THREE.Quaternion();
const _tmpQ1 = new THREE.Quaternion();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function readVec3(src, out = new THREE.Vector3()) {
  if (!src) return out.set(0, 0, 0);
  if (Array.isArray(src)) return out.set(Number(src[0]) || 0, Number(src[1]) || 0, Number(src[2]) || 0);
  return out.set(Number(src.x) || 0, Number(src.y) || 0, Number(src.z) || 0);
}

function rayCapsuleIntersect(ro, rd, a, b, radius, maxDist) {
  // Analytical ray vs capsule [a, b] with radius
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = ro.x - a.x, oay = ro.y - a.y, oaz = ro.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * rd.x + bay * rd.y + baz * rd.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = rd.x * oax + rd.y * oay + rd.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;

  if (baba < 1e-8) {
    // Degenerate sphere at a
    const h = rdoa * rdoa - (oaoa - radius * radius);
    if (h < 0) return -1;
    const t = -rdoa - Math.sqrt(h);
    return t > 1e-3 && t <= maxDist ? t : -1;
  }

  const qa = baba - bard * bard;
  const qb = baba * rdoa - baoa * bard;
  const qc = baba * oaoa - baoa * baoa - radius * radius * baba;
  const h = qb * qb - qa * qc;
  if (h >= 0 && Math.abs(qa) > 1e-8) {
    const t = (-qb - Math.sqrt(h)) / qa;
    const y = baoa + t * bard;
    if (y > 0 && y < baba && t > 1e-3 && t <= maxDist) return t;
    const ocx = y <= 0 ? oax : ro.x - b.x;
    const ocy = y <= 0 ? oay : ro.y - b.y;
    const ocz = y <= 0 ? oaz : ro.z - b.z;
    const bCap = rd.x * ocx + rd.y * ocy + rd.z * ocz;
    const cCap = ocx * ocx + ocy * ocy + ocz * ocz - radius * radius;
    const hCap = bCap * bCap - cCap;
    if (hCap >= 0) {
      const tCap = -bCap - Math.sqrt(hCap);
      if (tCap > 1e-3 && tCap <= maxDist) return tCap;
    }
  }
  return -1;
}

// -----------------------------------------------------------------------------
// 1. GoldenHourK9 — Articulated quadrupedal K9 robot unit
// -----------------------------------------------------------------------------

export class GoldenHourK9 {
  constructor({
    variant = 'halcyon',
    position = [0, 0, 0],
    yaw = 0,
    hp = 220,
    seed = 1,
    groundHeight = null,
    startFolded = false,
  } = {}) {
    this.variant = variant === 'rogue' ? 'rogue' : 'halcyon';
    this.maxHp = Math.max(1, Number(hp) || 220);
    this.hp = this.maxHp;
    this.alive = true;
    this.seed = seed;
    this.groundHeight = typeof groundHeight === 'function' ? groundHeight : (_x, _z) => 0;

    this._unit = pU({
      team: this.variant === 'rogue' ? 1 : 0,
      ground: (x, z) => this._sampleGround(x, z),
      seed,
    });

    this.root = this._unit.root;
    this.root.name = `golden-hour-k9-${this.variant}`;
    this.root.castShadow = true;
    this.root.receiveShadow = true;

    this.mesh = this._unit.model.mesh;
    this.visorMesh = this._unit.model.extras?.[0] || null;
    this.skeleton = this._unit.model.skeleton;
    this.bones = this._unit.bones;
    this.triangles = this._unit.triangles;

    // Named articulated joints
    this.core = this.bones[xs.body];
    this.neck = this.bones[xs.neck];
    this.head = this.bones[xs.head];
    this.jaw = this.bones[xs.jaw];
    this.ears = [this.bones[xs.earL], this.bones[xs.earR]];
    this.tail = [this.bones[xs.tail1], this.bones[xs.tail2], this.bones[xs.tail3]];
    this.legs = a7.map((tag, idx) => ({
      name: tag,
      hip: this.bones[1 + idx * 3],
      upper: this.bones[2 + idx * 3],
      lower: this.bones[3 + idx * 3],
    }));
    this.parts = {
      core: this.core,
      neck: this.neck,
      head: this.head,
      jaw: this.jaw,
      ears: this.ears,
      legs: this.legs,
      tail: this.tail,
    };

    // Hitboxes ('head' weakpoint + 'body')
    this.hitboxes = {
      head: {
        part: 'head',
        weakpoint: true,
        multiplier: 2.0,
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        radius: 0.115,
      },
      body: {
        part: 'body',
        weakpoint: false,
        multiplier: 1.0,
        a: new THREE.Vector3(),
        b: new THREE.Vector3(),
        radius: 0.185,
      },
    };

    const startPos = readVec3(position);
    const groundY = this._sampleGround(startPos.x, startPos.z);
    const st = this._unit.state;
    st.x = startPos.x;
    st.y = Math.max(startPos.y, groundY);
    st.z = startPos.z;
    st.yaw = Number(yaw) || 0;
    st.vx = 0;
    st.vy = 0;
    st.vz = 0;
    st.grounded = true;
    st.hp = 1;
    st.alert = this.variant === 'rogue' ? 0.65 : 0.1;

    this._vx = 0;
    this._vz = 0;
    this.gait = 'stand';

    if (startFolded) {
      st.mode = 'folded';
      this._unit.update(1 / 60);
    } else {
      st.mode = 'idle';
      this._unit._rig.snap();
      t6(this._unit._rig, this._unit._rig.P_STAND);
      this._unit.update(1 / 60);
    }
    this._syncHitboxes();
  }

  _sampleGround(x, z) {
    const h = this.groundHeight ? this.groundHeight(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  }

  _syncHitboxes() {
    const vols = this._unit.hitVolumes;
    if (vols && vols.length >= 2) {
      this.hitboxes.body.a.copy(vols[0].a);
      this.hitboxes.body.b.copy(vols[0].b);
      this.hitboxes.head.a.copy(vols[1].a);
      this.hitboxes.head.b.copy(vols[1].b);
    }
  }

  setVariant(variant) {
    this.variant = variant === 'rogue' ? 'rogue' : 'halcyon';
    this._unit.setTeam(this.variant === 'rogue' ? 1 : 0);
  }

  deploy() {
    if (!this.alive) return 0;
    this._unit.state.mode = 'deploy';
    return this._unit.deploy();
  }

  bark() {
    if (!this.alive) return 0;
    if (this._unit.state.mode === 'folded') this._unit.state.mode = 'idle';
    return this._unit.bark();
  }

  raycast(origin, dir, maxDist = 200) {
    if (!this.alive) return null;
    const ro = readVec3(origin, _tmpV0);
    const rd = readVec3(dir, _tmpV1);
    if (rd.lengthSq() < 1e-8) return null;
    rd.normalize();

    this._syncHitboxes();
    let best = null;
    let bestT = maxDist;

    for (const hb of [this.hitboxes.head, this.hitboxes.body]) {
      const t = rayCapsuleIntersect(ro, rd, hb.a, hb.b, hb.radius, bestT);
      if (t > 0 && t < bestT) {
        bestT = t;
        const point = new THREE.Vector3().copy(ro).addScaledVector(rd, t);
        const mid = new THREE.Vector3().addVectors(hb.a, hb.b).multiplyScalar(0.5);
        const normal = new THREE.Vector3().subVectors(point, mid);
        if (normal.lengthSq() < 1e-6) normal.copy(rd).negate();
        else normal.normalize();
        best = {
          dist: t,
          point,
          normal,
          surface: 'metal',
          part: hb.part,
          weakpoint: hb.weakpoint,
          multiplier: hb.multiplier,
          target: this,
        };
      }
    }
    return best;
  }

  damage(amount = 25, opts = {}) {
    if (!this.alive) return { hp: 0, alive: false, killed: false };
    const dmg = Math.max(0, Number(amount) || 0);
    this.hp = Math.max(0, this.hp - dmg);
    const st = this._unit.state;
    st.hp = this.hp / this.maxHp;
    st.alert = Math.min(1, st.alert + 0.55);

    const hitDir = opts && opts.hitDir ? readVec3(opts.hitDir, _tmpV2) : null;
    if (this.hp <= 0) {
      this.alive = false;
      st.mode = 'dead';
      this._vx = 0;
      this._vz = 0;
      this._unit.die(hitDir, opts?.blast ? 'blast' : 'shot');
      return { hp: 0, alive: false, killed: true };
    }

    this._unit.flinch(hitDir, clampScalar(dmg / 35, 0.25, 1.8));
    return { hp: this.hp, alive: true, killed: false };
  }

  update(dt, {
    targetPos = null,
    groundHeight = null,
    lookAt = null,
    speed = null,
    alert = null,
    bark = false,
  } = {}) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (typeof groundHeight === 'function') this.groundHeight = groundHeight;
    const stepDt = Math.min(dt, 0.05);
    const st = this._unit.state;

    if (this.alive) {
      if (alert !== null && alert !== undefined) st.alert = clampScalar(Number(alert) || 0, 0, 1);
      st.lookAt = lookAt ? readVec3(lookAt, new THREE.Vector3()) : null;
      if (bark) this.bark();

      if (st.mode !== 'folded' && st.mode !== 'deploy') {
        if (targetPos) {
          const tgt = readVec3(targetPos, _tmpV0);
          const dx = tgt.x - st.x;
          const dz = tgt.z - st.z;
          const dist = Math.hypot(dx, dz);
          if (dist > 0.22) {
            // K9 forward axis is -Z in local coordinates
            const desiredYaw = Math.atan2(-dx, -dz);
            const yawErr = E1(st.yaw, desiredYaw);
            const maxTurn = (dist > 4 ? 7.5 : 10.5) * stepDt;
            st.yaw += clampScalar(yawErr, -maxTurn, maxTurn);

            const desiredSpeed = speed !== null && speed !== undefined
              ? Math.max(0, Number(speed))
              : dist > 7.5
                ? dU.gallop * 0.9
                : dist > 2.6
                  ? dU.trot
                  : dU.walk;
            const align = Math.max(0.2, Math.cos(Math.min(Math.PI * 0.5, Math.abs(yawErr))));
            const fwdSpeed = Math.min(desiredSpeed, dist * 3.2) * align;
            const tvx = -Math.sin(st.yaw) * fwdSpeed;
            const tvz = -Math.cos(st.yaw) * fwdSpeed;
            const blend = 1 - Math.exp(-14 * stepDt);
            this._vx += (tvx - this._vx) * blend;
            this._vz += (tvz - this._vz) * blend;
            st.x += this._vx * stepDt;
            st.z += this._vz * stepDt;
            st.mode = 'move';
          } else {
            const brake = Math.exp(-16 * stepDt);
            this._vx *= brake;
            this._vz *= brake;
            st.x += this._vx * stepDt;
            st.z += this._vz * stepDt;
            st.mode = Math.hypot(this._vx, this._vz) > 0.12 ? 'move' : 'idle';
          }
        } else {
          const brake = Math.exp(-14 * stepDt);
          this._vx *= brake;
          this._vz *= brake;
          st.x += this._vx * stepDt;
          st.z += this._vz * stepDt;
          if (st.mode === 'move' && Math.hypot(this._vx, this._vz) < 0.08) st.mode = 'idle';
        }
      }

      st.vx = this._vx;
      st.vz = this._vz;
      const gY = this._sampleGround(st.x, st.z);
      st.y = Ee(st.y, gY, 22, stepDt);
      st.grounded = true;
    }

    this._unit.update(stepDt);
    this.gait = this._unit.gait;
    this._syncHitboxes();
  }

  dispose() {
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    this._unit.model.dispose();
  }
}

function clampScalar(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

// -----------------------------------------------------------------------------
// 2. ColonistRig — Articulated humanoid explorer / engineer / security rig
// -----------------------------------------------------------------------------

const ROLE_TO_INDEX = {
  explorer: 0,
  engineer: 1,
  security: 2,
};

export class ColonistRig {
  constructor({
    role = 'explorer',
    position = [0, 0, 0],
    yaw = 0,
    pose = 'idle',
    patrolRadius = 4.5,
    seed = 1,
    groundHeight = null,
    armed = null,
  } = {}) {
    this.role = ROLE_TO_INDEX[role] !== undefined ? role : 'explorer';
    this.roleIndex = ROLE_TO_INDEX[this.role];
    this.armed = armed !== null ? Boolean(armed) : this.role === 'security';
    this.groundHeight = typeof groundHeight === 'function' ? groundHeight : (_x, _z) => 0;
    this.seed = seed;

    this._op = new oC({
      team: this.roleIndex,
      ground: (x, z) => this._sampleGround(x, z),
      seed,
    });

    this.root = this._op.root;
    this.root.name = `colonist-${this.role}`;
    this.body = this._op.body;
    this.skeleton = this.body.skeleton;
    this.bones = this._op._bones;
    this.triangles = this._op.triangles;
    this.hitboxes = this._op.hit;

    this.home = readVec3(position);
    this.home.y = this._sampleGround(this.home.x, this.home.z);
    this.position = this.home.clone();
    this.yaw = Number(yaw) || 0;
    this.pitch = 0;
    this.pose = pose || 'idle';
    this.patrolRadius = Math.max(0.8, Number(patrolRadius) || 4.5);

    // Deterministic patrol waypoints around home
    const prng = Re((seed * 4999 + 17) >>> 0);
    this._waypoints = Array.from({ length: 4 }, (_, idx) => {
      const ang = (idx / 4) * Math.PI * 2 + prng.range(-0.35, 0.35);
      const rad = this.patrolRadius * prng.range(0.65, 1.0);
      return new THREE.Vector3(
        this.home.x + Math.cos(ang) * rad,
        0,
        this.home.z + Math.sin(ang) * rad
      );
    });
    this._wpIndex = 0;
    this._wpWait = 0;

    this._state = {
      pos: this.position.clone(),
      yaw: this.yaw,
      pitch: 0,
      speed: 0,
      moveX: 0,
      moveZ: 0,
      stance: this.pose === 'crouch' ? 'crouch' : 'stand',
      sprint: false,
      airborne: false,
      reloading: false,
      engage: this.armed,
      look: null,
    };

    this.update(1 / 60);
  }

  _sampleGround(x, z) {
    const h = this.groundHeight ? this.groundHeight(x, z) : 0;
    return Number.isFinite(h) ? h : 0;
  }

  setPose(pose) {
    this.pose = pose || 'idle';
  }

  _applyUnarmedRelaxedArms() {
    // Give unarmed explorers/engineers natural relaxed side-hanging arms with walk pendulum swing
    const op = this._op;
    const j = op.joints;
    const crouchK = op.wCrouch;
    const moveK = op.gaitOn ? Math.min(1, op.vel.length() / 1.8) : 0;
    const swing = op.gaitOn ? Math.sin(Vt * op.phase) * 0.16 * moveK : 0;
    const breath = Math.sin(op.time * 1.4) * 0.008;

    const sy = Math.sin(this.yaw);
    const cy = Math.cos(this.yaw);
    const fwd = _tmpV0.set(-sy, 0, -cy);
    const right = _tmpV1.set(cy, 0, -sy);

    for (let side = 0; side < 2; side++) {
      const sgn = side ? 1 : -1;
      const shIdx = side ? fs.rShoulder : fs.lShoulder;
      const elIdx = side ? fs.rElbow : fs.lElbow;
      const hdIdx = side ? fs.rHand : fs.lHand;

      const sh = _tmpV2.set(j[shIdx * 3], j[shIdx * 3 + 1], j[shIdx * 3 + 2]);
      const armSwing = (side ? swing : -swing) + crouchK * 0.16;
      const outX = 0.045 + 0.03 * crouchK + breath;
      const dropY = -(Ca + mh) * (0.91 - 0.12 * crouchK);
      const wrist = _tmpV3
        .copy(sh)
        .addScaledVector(right, sgn * outX)
        .addScaledVector(fwd, armSwing)
        .setY(sh.y + dropY);

      const pole = new THREE.Vector3()
        .copy(fwd)
        .multiplyScalar(-0.7)
        .addScaledVector(right, sgn * 0.65)
        .setY(-0.2)
        .normalize();
      const elbowOut = new THREE.Vector3();
      const handOut = new THREE.Vector3();
      Zy(sh, wrist, Ca, mh, pole, elbowOut, handOut, 0.985);

      $l(j, elIdx, elbowOut);
      $l(j, hdIdx, handOut);
      op._hint.handW[side] = 0;
    }
    op.renderHinted();
  }

  update(dt, {
    pose = null,
    targetPos = null,
    lookAt = null,
    groundHeight = null,
    speed = null,
  } = {}) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (pose) this.pose = pose;
    if (typeof groundHeight === 'function') this.groundHeight = groundHeight;
    const stepDt = Math.min(dt, 0.05);

    let activePose = this.pose;
    let moveSpeed = 0;
    let moveZ = 0;

    if (activePose === 'walk') {
      const desired = speed !== null && speed !== undefined ? Math.max(0, Number(speed)) : 1.55;
      if (targetPos) {
        const tgt = readVec3(targetPos, _tmpV0);
        const dx = tgt.x - this.position.x;
        const dz = tgt.z - this.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.18) {
          const desiredYaw = Math.atan2(-dx, -dz);
          this.yaw += clampScalar(E1(this.yaw, desiredYaw), -7 * stepDt, 7 * stepDt);
          moveSpeed = Math.min(desired, dist * 3.0);
          moveZ = 1;
        }
      } else {
        moveSpeed = desired;
        moveZ = 1;
      }
    } else if (activePose === 'patrol') {
      if (this._wpWait > 0) {
        this._wpWait -= stepDt;
      } else {
        const wp = this._waypoints[this._wpIndex];
        const dx = wp.x - this.position.x;
        const dz = wp.z - this.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= 0.25) {
          this._wpIndex = (this._wpIndex + 1) % this._waypoints.length;
          this._wpWait = 1.1;
        } else {
          const desiredYaw = Math.atan2(-dx, -dz);
          this.yaw += clampScalar(E1(this.yaw, desiredYaw), -6 * stepDt, 6 * stepDt);
          moveSpeed = speed !== null && speed !== undefined ? Math.max(0, Number(speed)) : 1.45;
          moveZ = 1;
        }
      }
    }

    if (moveSpeed > 0) {
      this.position.x += -Math.sin(this.yaw) * moveSpeed * stepDt;
      this.position.z += -Math.cos(this.yaw) * moveSpeed * stepDt;
    }
    this.position.y = Ee(this.position.y, this._sampleGround(this.position.x, this.position.z), 20, stepDt);

    const st = this._state;
    st.pos.copy(this.position);
    st.yaw = this.yaw;
    st.pitch = this.pitch;
    st.speed = moveSpeed;
    st.moveX = 0;
    st.moveZ = moveZ;
    st.stance = activePose === 'crouch' ? 'crouch' : 'stand';
    st.sprint = moveSpeed > 3.6;
    st.airborne = false;
    st.engage = this.armed;
    st.look = lookAt ? readVec3(lookAt, _tmpV1).clone() : null;

    this._op.update(stepDt, st);
    if (!this.armed) this._applyUnarmedRelaxedArms();
  }

  dispose() {
    this._op.dispose();
  }
}

// -----------------------------------------------------------------------------
// 3. FirstPersonBody — First-person lower-body controller ('X7' adaptation)
// -----------------------------------------------------------------------------

const FP_GEOM = {
  backStand: 0.2,
  backKneel: 0.36,
  backCrouchMove: 0.5,
  neckLevel: 0.115,
  neckDown: 0.285,
  neckDrop: 0.158,
  standEye: 1.65,
  crouchEye: 1.12,
};

function makeFpFoot() {
  return {
    mode: 0,
    plant: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, -1),
    pitch: 0,
    toe: 0,
    ankle: new THREE.Vector3(),
    off: new THREE.Vector3(),
    u0: 0,
    pitchOff: 0,
    dir0: new THREE.Vector3(0, 0, -1),
    gy0: 0,
    gyT: 0,
    u: 0,
    from: new THREE.Vector3(),
    to: new THREE.Vector3(),
    fromPitch: 0,
    t: 1,
    dur: 0.2,
    lift: 0.06,
    k0: 0,
    pitch0: 0,
    rel: new THREE.Vector3(),
    prevA: new THREE.Vector3(),
    bo: new THREE.Vector3(),
    pEnd: 1,
    blendT: 0,
    blendFrom: new THREE.Vector3(),
    force: false,
    hx: 0,
    hy: 0,
    hz: 0,
    hyF: 0,
    d2: 0,
    X: new Float32Array(5),
    Y: new Float32Array(5),
    Pk: new Float32Array(5),
    mx0: 0,
    my0: 0,
    mx1: 0,
    my1: 0,
    l0: 0,
    l1: 0,
    stance: false,
    k: 0,
  };
}

function makeFpRigRig() {
  return {
    P: new THREE.Vector3(),
    N: new THREE.Vector3(),
    sh: new THREE.Vector3(),
    hip: new THREE.Vector3(),
    A: [new THREE.Vector3(), new THREE.Vector3()],
    Kp: [new THREE.Vector3(), new THREE.Vector3()],
    fF: [new THREE.Vector3(), new THREE.Vector3()],
    fU: [new THREE.Vector3(), new THREE.Vector3()],
    toe: [0, 0],
    pole: new THREE.Vector3(),
  };
}

function zeroFpRig(r) {
  r.P.set(0, 0, 0);
  r.N.set(0, 0, 0);
  r.sh.set(0, 0, 0);
  r.hip.set(0, 0, 0);
  r.pole.set(0, 0, 0);
  for (let i = 0; i < 2; i++) {
    r.A[i].set(0, 0, 0);
    r.Kp[i].set(0, 0, 0);
    r.fF[i].set(0, 0, 0);
    r.fU[i].set(0, 0, 0);
    r.toe[i] = 0;
  }
}

function addScaledFpRig(dst, src, w) {
  dst.P.addScaledVector(src.P, w);
  dst.N.addScaledVector(src.N, w);
  dst.sh.addScaledVector(src.sh, w);
  dst.hip.addScaledVector(src.hip, w);
  dst.pole.addScaledVector(src.pole, w);
  for (let i = 0; i < 2; i++) {
    dst.A[i].addScaledVector(src.A[i], w);
    dst.Kp[i].addScaledVector(src.Kp[i], w);
    dst.fF[i].addScaledVector(src.fF[i], w);
    dst.fU[i].addScaledVector(src.fU[i], w);
    dst.toe[i] += src.toe[i] * w;
  }
}

export class FirstPersonBody {
  constructor({
    role = 'explorer',
    scene = null,
    groundHeight = null,
  } = {}) {
    this.role = ROLE_TO_INDEX[role] !== undefined ? role : 'explorer';
    this.roleIndex = ROLE_TO_INDEX[this.role];
    this.enabled = true;
    this.groundHeight = typeof groundHeight === 'function' ? groundHeight : null;

    this.root = new THREE.Group();
    this.root.name = 'fpbody';
    this.root.visible = false;
    if (scene) scene.add(this.root);

    this.bones = [];
    this._mats = [];
    for (let i = 0; i < kE; i++) {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      this.root.add(b);
      this.bones.push(b);
      this._mats.push(new THREE.Matrix4());
    }

    const split = lB(this.roleIndex);
    this.material = rB(this.roleIndex);
    // Warm sensible default first-person fill/sky lighting
    Up.fill.value.set(0.32, 0.34, 0.38);
    Up.rim.value.set(0.14, 0.18, 0.24);
    Up.sky.value.set(0.16, 0.19, 0.24);
    Up.gnd.value.set(0.08, 0.08, 0.09);
    Up.sun.value = 0.72;

    this.mesh = new THREE.SkinnedMesh(split.view, this.material);
    this.mesh.name = 'fpbody-lower-view';
    this.mesh.geometry.setDrawRange(0, split.view.userData.core);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.skeleton = new THREE.Skeleton(this.bones, gt0().map((m) => m.clone()));
    this.mesh.bind(this.skeleton, new THREE.Matrix4());
    this.root.add(this.mesh);
    this.triangles = split.view.userData.core / 3;

    // Planetary tangent-frame state (parallel-transported +Y = local planet up)
    this._up = new THREE.Vector3(0, 1, 0);
    this._basisQuat = new THREE.Quaternion();
    this._invBasisQuat = new THREE.Quaternion();
    this._anchorWorld = new THREE.Vector3();
    this._hasAnchor = false;

    // Solver kinematics state
    this.joints = new Float32Array(48);
    this._hint = {
      headFwd: new THREE.Vector3(0, 0, -1),
      headUp: new THREE.Vector3(0, 1, 0),
      handQ: [new THREE.Quaternion(), new THREE.Quaternion()],
      handP: [new THREE.Vector3(), new THREE.Vector3()],
      handW: [0, 0],
      footF: [new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, -1)],
      footU: [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)],
      footW: 1,
      toeBend: [0, 0],
      magM: null,
    };

    this.feet = [makeFpFoot(), makeFpFoot()];
    this.g = {
      duty: 0.6, f: 1, Lc: 0.5, xl: 0.2, thHS: 0.2, phO: 0.8,
      k1: 0.2, k2: 0.5, ya: 0.2, yb: 0.13, yc: 0.11, re: 0.04,
      xa: 0.1, xb: 0.03, rk: 0, dsw: 0.5, moveK: 0,
    };
    this.rU = makeFpRigRig();
    this.rS = makeFpRigRig();
    this.rO = makeFpRigRig();

    this._localPos = new THREE.Vector3();
    this._localRoot = new THREE.Vector3();
    this._prevRoot = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.acc = new THREE.Vector3();
    this._pvd = new THREE.Vector3(0, 0, -1);
    this._rockTmp = [0, 0];
    this._swingTmp = [0, 0, 0];

    this.reset();
  }

  reset() {
    this._live = false;
    this.time = 0;
    this.wCrouch = 0;
    this.wSlide = 0;
    this.wSprint = 0;
    this.wAir = 0;
    this.wMove = 0;
    this.phase = 0;
    this.gaitOn = false;
    this.stepCool = 0;
    this.off = 0.24;
    this.back = false;
    this._airT = 0;
    this._wasAir = false;
    this._peak = 0;
    this.drop = 0;
    this._shift = 0;
    this._hasAnchor = false;
  }

  _updateTangentFrame(upInput, worldPos) {
    if (upInput) {
      readVec3(upInput, _tmpV0);
      if (_tmpV0.lengthSq() > 1e-8) {
        _tmpV0.normalize();
        if (this._up.dot(_tmpV0) < -0.999) {
          _tmpV1.set(1, 0, 0);
          if (Math.abs(this._up.dot(_tmpV1)) > 0.9) _tmpV1.set(0, 0, 1);
          _tmpV1.addScaledVector(this._up, -_tmpV1.dot(this._up)).normalize();
          _tmpQ0.setFromAxisAngle(_tmpV1, Math.PI);
        } else {
          _tmpQ0.setFromUnitVectors(this._up, _tmpV0);
        }
        this._basisQuat.premultiply(_tmpQ0).normalize();
        this._up.copy(_tmpV0);
      }
    }
    this._invBasisQuat.copy(this._basisQuat).invert();

    if (!this._hasAnchor) {
      this._anchorWorld.copy(worldPos);
      this._hasAnchor = true;
    }

    _tmpV1.subVectors(worldPos, this._anchorWorld).applyQuaternion(this._invBasisQuat);
    // Re-center tangent anchor cleanly if player travels > 64m from origin
    if (_tmpV1.lengthSq() > 4096) {
      this._anchorWorld.copy(worldPos);
      _tmpV1.set(0, 0, 0);
      this._live = false;
    }
    this._localPos.copy(_tmpV1);
  }

  _sampleLocalGround(lx, lz, fallbackY) {
    if (!this.groundHeight) return fallbackY;
    const h = this.groundHeight(lx, lz);
    if (!Number.isFinite(h)) return fallbackY;
    return h > fallbackY - 0.8 && h < fallbackY + 0.6 ? h : fallbackY;
  }

  _homeFoot(idx, rootPos, pf, pr, crouchK, out) {
    const sgn = idx ? 1 : -1;
    const fwdOff = idx ? Ht(-0.12, -0.09, crouchK) : Ht(0.13, 0.31, crouchK);
    return out
      .copy(rootPos)
      .addScaledVector(pr, sgn * Ht(0.15, idx ? 0.16 : 0.21, crouchK))
      .addScaledVector(pf, fwdOff);
  }

  _teleportLocal(fwd, right, crouchK, slideK) {
    const a = this._localRoot;
    this._prevRoot.copy(a);
    this.vel.set(0, 0, 0);
    this.acc.set(0, 0, 0);
    this.gaitOn = false;
    this.back = false;
    this.off = 0.24;
    this.drop = 0;
    this._shift = 0;

    const c = Math.cos(this.off);
    const s = Math.sin(this.off);
    const pf = _tmpV2.copy(fwd).multiplyScalar(c).addScaledVector(right, s);
    const pr = _tmpV3.copy(right).multiplyScalar(c).addScaledVector(fwd, -s);

    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this._homeFoot(i, a, pf, pr, crouchK, f.plant);
      f.plant.y = this._sampleLocalGround(f.plant.x, f.plant.z, this._localPos.y);
      f.dir.copy(pf);
      f.mode = 0;
      f.pitch = 0;
      f.toe = 0;
      f.t = 1;
      f.pEnd = 1;
      f.blendT = 0;
      f.ankle.copy(f.plant);
      f.ankle.y += Sn;
      f.prevA.copy(f.ankle);
    }

    this.wCrouch = crouchK;
    this.wSlide = slideK;
    this._live = true;
  }

  _gaitParams(speed, crouchK, sprintK, backK, latK) {
    const l = this.g;
    let duty = is.tab(is.G_V, is.G_DUTY, speed);
    let freq = is.tab(is.G_V, is.G_FREQ, speed) * (1 + 0.26 * backK + 0.45 * latK);
    if (crouchK > 1e-3) {
      freq *= 1 + 0.1 * crouchK;
      duty = Ht(duty, Math.max(duty, 0.5), crouchK);
    }
    const maxStride = Ht(0.72, 0.58, crouchK) * (1 - 0.2 * backK - 0.22 * latK);
    if (speed > 0.2) duty = Math.min(duty, (maxStride * freq) / speed);
    duty = Zt(duty, 0.12, 0.7);

    l.duty = duty;
    l.f = freq;
    l.Lc = (speed * duty) / freq;
    l.dsw = (speed * (1 - duty)) / freq;
    l.rk = Fo(0.53, 0.4, duty);
    l.moveK = Fo(0.3, 1.2, speed);

    const liftScale = (1 - 0.4 * crouchK) * (1 - 0.4 * backK);
    l.xl = l.Lc * (is.tab(is.S_V, is.S_KL, speed) + 0.25 * backK + 0.12 * latK + 0.08 * crouchK);
    l.thHS = is.tab(is.S_V, is.S_TH, speed) * l.moveK;
    l.phO = is.tab(is.S_V, is.S_PH, speed) * l.moveK * (1 - 0.25 * crouchK);
    l.k1 = Ht(0.2, 0.14, l.rk);
    l.k2 = Ht(0.52, 0.34, l.rk);
    l.ya = is.tab(is.S_V, is.S_YA, speed) * liftScale + 0.05 * sprintK;
    l.yb = is.tab(is.S_V, is.S_YB, speed) * liftScale + 0.04 * sprintK;
    l.yc = is.tab(is.S_V, is.S_YC, speed) * liftScale;
    l.re = is.tab(is.S_V, is.S_RE, speed) * (1 - 0.6 * backK);
    l.xa = is.tab(is.S_V, is.S_XA, speed);
    l.xb = is.tab(is.S_V, is.S_XB, speed);
    return l;
  }

  _stPitch(k, dirDotVel) {
    const s = this.g;
    const fwd = dirDotVel > 0 ? dirDotVel : 0;
    const rev = dirDotVel < 0 ? -dirDotVel : 0;
    const hs = s.thHS * fwd - 0.24 * rev * s.moveK;
    if (k < s.k1) return hs * (1 - Ao(k / s.k1));
    if (k < s.k2) return 0;
    return -s.phO * Ht(0.4, 1, fwd) * Math.pow((k - s.k2) / (1 - s.k2), 1.6);
  }

  _buildSwing(foot, dirDotVel, dirDotLat) {
    const n = this.g;
    const eps = 0.02;
    const ratio = (1 - n.duty) / n.duty;
    const r0 = this._stPitch(1, dirDotVel);
    const r0m = this._stPitch(1 - eps, dirDotVel);
    const r1 = this._stPitch(0, dirDotVel);
    const r1p = this._stPitch(eps, dirDotVel);
    const tl = this._rockTmp;

    is.rock(r0, tl); const f = tl[0], u = tl[1];
    is.rock(r0m, tl); const d = tl[0], m = tl[1];
    is.rock(r1, tl); const p = tl[0], x = tl[1];
    is.rock(r1p, tl); const g = tl[0], b = tl[1];

    const v = n.xl - n.Lc;
    const y = v + f * dirDotVel;
    const w = n.xl + p * dirDotVel;
    foot.mx0 = Math.max(((y - (v + n.Lc * eps + d * dirDotVel)) / eps) * ratio, -0.9);
    foot.my0 = ((u - m) / eps) * ratio;
    foot.mx1 = (((n.xl - n.Lc * eps + g * dirDotVel - w) / eps) * ratio) * 0.55;
    foot.my1 = ((b - x) / eps) * ratio - 0.25;

    const fwd = Math.max(dirDotVel, 0);
    foot.X[0] = y; foot.Y[0] = u;
    foot.X[1] = y + n.xa * Ht(0.4, 1, fwd) + 0.06 * (1 - fwd);
    foot.Y[1] = Math.max(n.ya * Ht(0.55, 1, fwd), u + 0.025);
    foot.X[2] = n.xb;
    foot.Y[2] = Math.max(n.yb * Ht(0.6, 1, fwd), Sn + 0.03);
    foot.X[3] = w + n.re * Ht(0.3, 1, fwd);
    foot.Y[3] = Math.max(n.yc * Ht(0.75, 1, fwd), x + 0.015);
    foot.X[4] = w; foot.Y[4] = x;

    foot.Pk[0] = r0;
    foot.Pk[1] = r0 - (0.1 + 0.25 * n.rk) * fwd;
    foot.Pk[2] = Ht(-0.15, -0.6, n.rk) * Ht(0.3, 1, fwd);
    foot.Pk[3] = Ht(r1 + 0.03, -0.1, n.rk * fwd);
    foot.Pk[4] = r1;
    foot.l0 = f * dirDotLat;
    foot.l1 = p * dirDotLat;
  }

  _evalSwing(foot, u, out) {
    out[0] = is.herm5(foot.X, foot.mx0, foot.mx1, u, 0);
    out[1] = is.herm5(foot.Y, foot.my0, foot.my1, u);
    out[2] = is.herm5(foot.Pk, 0, 0, u);
    return out;
  }

  _solveUpright(dt, fwd, right, pitch, crouchK, speed, onGround, sprinting, vy, eyeLocal) {
    const u = this._localRoot;
    const feet = this.feet;
    const m = this.rU;
    const p = this.vel;
    const airborne = !onGround;

    this.wAir = Ee(this.wAir, airborne ? 1 : 0, airborne ? 14 : 18, dt);
    this.wSprint = Ee(this.wSprint, sprinting && speed > 2.4 ? 1 : 0, 8, dt);

    const vFwd = p.x * fwd.x + p.z * fwd.z;
    const vRight = p.x * right.x + p.z * right.z;
    const moveK = (this.wMove = Fo(0.4, 1.4, speed));
    const fastK = Fo(2, 4, speed);
    let targetOff = 0.24 * (1 - this.wSprint) * (1 - 0.5 * crouchK);

    if (speed > 0.5) {
      const ang = Math.atan2(vRight, vFwd);
      const absAng = Math.abs(ang);
      if (this.back) { if (absAng < 1.75) this.back = false; }
      else if (absAng > 2.05) this.back = true;
      const maxTwist = Ht(0.85, 1.2, fastK);
      const twist = this.back ? Zt(E1(Math.PI, ang), -0.8, 0.8) : Zt(ang, -maxTwist, maxTwist);
      targetOff = Ht(targetOff, twist, moveK);
    } else {
      this.back = false;
    }
    this.off += E1(this.off, targetOff) * (1 - Math.exp(-9 * dt));

    const cosO = Math.cos(this.off);
    const sinO = Math.sin(this.off);
    const pf = new THREE.Vector3().copy(fwd).multiplyScalar(cosO).addScaledVector(right, sinO);
    const pr = new THREE.Vector3().copy(right).multiplyScalar(cosO).addScaledVector(fwd, -sinO);
    const H = speed > 0.05 ? new THREE.Vector3(p.x / speed, 0, p.z / speed) : pf.clone();
    const F = new THREE.Vector3(-H.z, 0, H.x);

    const backK = this.back ? moveK : 0;
    const latK = moveK * (1 - Math.abs(pf.dot(H)));
    const gait = this._gaitParams(speed, crouchK, this.wSprint, backK, latK);
    const duty = gait.duty;

    if (airborne && !this._wasAir) {
      for (let i = 0; i < 2; i++) {
        feet[i].rel.subVectors(feet[i].ankle, u);
        feet[i].mode = 0;
      }
      this.gaitOn = false;
      this._airT = 0;
    }
    if (airborne) this._airT += dt;
    if (!airborne && this._wasAir) {
      for (let i = 0; i < 2; i++) {
        const w0 = feet[i];
        const gy = this._sampleLocalGround(w0.ankle.x, w0.ankle.z, this._localPos.y);
        w0.mode = 3;
        w0.from.copy(w0.ankle);
        w0.fromPitch = w0.pitch;
        w0.t = 0;
        w0.dur = 0.07;
        w0.lift = 0;
        w0.bo.set(0, 0, 0);
        w0.to.set(w0.ankle.x, gy + Sn, w0.ankle.z);
        w0.plant.set(w0.ankle.x, gy, w0.ankle.z);
      }
    }
    this._wasAir = airborne;

    let dirChanged = this._pvd.dot(H) < 0.9;
    this._pvd.copy(H);
    if (!airborne && speed > (this.gaitOn ? 0.3 : 0.5)) {
      if (!this.gaitOn) {
        const d0 = (feet[0].ankle.x - u.x) * H.x + (feet[0].ankle.z - u.z) * H.z;
        const d1 = (feet[1].ankle.x - u.x) * H.x + (feet[1].ankle.z - u.z) * H.z;
        this.phase = d0 < d1 ? (0.25 * duty + 0.5) % 1 : 0.25 * duty;
        dirChanged = true;
      } else {
        this.phase = (this.phase + gait.f * dt) % 1;
      }
      this.gaitOn = true;
    } else {
      this.gaitOn = false;
    }

    this.stepCool -= dt;
    const toeOut = Ht(0.14, 0.05, moveK);
    const prDotF = pr.dot(F);
    const prDotH = pr.dot(H);
    const stanceHalfW = Ht(0.105, 0.072, gait.rk);
    const latSign = (prDotF < 0 ? -1 : 1) * Math.max(Math.abs(prDotF), 0.068 / stanceHalfW);
    const home = new THREE.Vector3();
    const base = new THREE.Vector3();
    const dirT = new THREE.Vector3();

    for (let idx = 0; idx < 2; idx++) {
      const w0 = feet[idx];
      const other = feet[1 - idx];
      const sgn = idx ? 1 : -1;
      dirT.copy(pf).multiplyScalar(Math.cos(toeOut * sgn)).addScaledVector(pr, Math.sin(toeOut * sgn));
      this._homeFoot(idx, u, pf, pr, crouchK, home);
      home.y = this._sampleLocalGround(home.x, home.z, this._localPos.y);
      w0.stance = false;

      const prevAx = w0.ankle.x, prevAy = w0.ankle.y, prevAz = w0.ankle.z;
      if (airborne) {
        const riseK = Fo(-2.5, 1.5, vy);
        const tuckK = 1 - Ao(this._airT / 0.15);
        const isLead = idx === 0;
        const relT = new THREE.Vector3()
          .copy(pr)
          .multiplyScalar(sgn * 0.11)
          .addScaledVector(pf, isLead ? Ht(0.12, 0.24, riseK) : Ht(-0.04, -0.2, riseK));
        relT.y = Sn + (isLead ? Ht(0.07, 0.36, riseK) : Ht(0.05, 0.28, riseK));
        relT.y = Ht(relT.y, Sn + 0.03, tuckK);
        w0.rel.lerp(relT, 1 - Math.exp(-(12 + 10 * tuckK) * dt));
        w0.ankle.copy(u).add(w0.rel);
        const gy = this._sampleLocalGround(w0.ankle.x, w0.ankle.z, this._localPos.y);
        if (w0.ankle.y < gy + Sn) w0.ankle.y = gy + Sn;
        w0.pitch = Ee(w0.pitch, Ht(Ht(-0.1, -0.55, riseK), -0.95, tuckK), 14, dt);
        w0.toe = 0;
        w0.dir.lerp(dirT, 1 - Math.exp(-10 * dt));
        is.safeNorm(w0.dir, dirT);
        w0.prevA.set(prevAx, prevAy, prevAz);
        continue;
      }

      const ph = (this.phase + idx * 0.5) % 1;
      if (this.gaitOn && !(w0.mode === 3 && ph < duty)) {
        const k0 = dirT.dot(H);
        const o0 = dirT.dot(F);
        base
          .copy(u)
          .addScaledVector(F, sgn * stanceHalfW * latSign)
          .addScaledVector(H, sgn * Pi * prDotH + 0.1 * crouchK * (this.back ? -1 : 1));
        const stanceEnd = Math.min(duty, w0.pEnd);
        if (ph < stanceEnd) {
          const ot = ph / duty;
          if (w0.mode !== 1) {
            if (w0.mode === 2) {
              w0.blendFrom.copy(w0.ankle);
              w0.plant.copy(base).addScaledVector(H, gait.xl - gait.Lc * ot);
              w0.plant.y = this._sampleLocalGround(w0.plant.x, w0.plant.z, this._localPos.y);
              w0.dir.copy(dirT);
              const dx = w0.blendFrom.x - w0.plant.x;
              const dz = w0.blendFrom.z - w0.plant.z;
              w0.blendT = dx * dx + dz * dz > 0.0144 ? 0.07 : 0;
            }
            w0.mode = 1;
            w0.k0 = ot;
            w0.pitch0 = w0.pitch;
            w0.pEnd = 1;
          }
          let fp = this._stPitch(ot, w0.dir.dot(H));
          if (w0.k0 > 0.02) fp = Ht(w0.pitch0, fp, Ao(((ot - w0.k0) / Math.max(1 - w0.k0, 0.05)) * 3));
          w0.pitch = fp;
          w0.toe = fp < 0 ? Math.min(-fp, 0.95) : 0;
          w0.k = ot;
          is.rock(fp, this._rockTmp);
          w0.ankle.copy(w0.plant).addScaledVector(w0.dir, this._rockTmp[0]);
          w0.ankle.y += this._rockTmp[1];
          w0.stance = w0.blendT <= 0;
          if (w0.blendT > 0) {
            w0.ankle.lerp(w0.blendFrom, Ao(w0.blendT / 0.07));
            w0.blendT -= dt;
          }
        } else {
          const ot = Zt((ph - stanceEnd) / (1 - stanceEnd), 0, 1);
          this._buildSwing(w0, k0, o0);
          this._evalSwing(w0, ot, this._swingTmp);
          const enteredSwing = w0.mode !== 2;
          if (enteredSwing) {
            w0.mode = 2;
            w0.dir0.copy(w0.dir);
            w0.gy0 = w0.plant.y;
          }
          const gyT = this._sampleLocalGround(base.x + H.x * gait.xl, base.z + H.z * gait.xl, this._localPos.y);
          w0.gyT = gyT;
          w0.u = ot;
          const arcY = Ht(w0.gy0, gyT, Ao(ot * 1.3)) + 0.55 * Math.abs(gyT - w0.gy0) * Math.sin(Math.PI * Math.min(ot * 1.15, 1));
          const latShift = Ht(w0.l0, w0.l1, Ao(ot));
          const ideal = new THREE.Vector3()
            .copy(base)
            .addScaledVector(H, this._swingTmp[0])
            .addScaledVector(F, latShift)
            .setY(arcY + this._swingTmp[1]);
          let decay = 1 - Ao((ot - w0.u0) / Math.max(Math.min(0.5, 0.92 - w0.u0), 0.04));
          const blended = ideal.clone().addScaledVector(w0.off, decay);
          if (enteredSwing || dirChanged) {
            blended.copy(w0.ankle).multiplyScalar(2).sub(w0.prevA);
            w0.off.subVectors(blended, ideal);
            w0.u0 = ot;
            w0.pitchOff = w0.pitch - this._swingTmp[2];
            decay = 1;
          }
          w0.ankle.copy(blended);
          w0.pitch = this._swingTmp[2] + w0.pitchOff * decay;
          w0.toe = Math.max(0, -w0.pitch) * (1 - Ao(ot / 0.18)) * 0.9;
          w0.dir.copy(w0.dir0).lerp(dirT, Ao((ot - w0.u0) / Math.max(0.75 - w0.u0, 0.05)));
          is.safeNorm(w0.dir, dirT);
        }
      } else {
        w0.pEnd = 1;
        if (w0.mode === 2) {
          w0.mode = 3;
          w0.from.copy(w0.ankle);
          w0.fromPitch = w0.pitch;
          w0.t = 0;
          const dHome = Math.hypot(home.x - w0.ankle.x, home.z - w0.ankle.z);
          w0.dur = Zt(0.1 + dHome * 0.3, 0.12, 0.3);
          w0.lift = 0.02 + 0.06 * Math.min(dHome, 1);
          w0.bo.copy(this._pvd).multiplyScalar(Math.min(0.26, 0.055 * this._peak));
          w0.to.copy(home).add(w0.bo);
          w0.to.y += Sn;
          w0.dir0.copy(w0.dir);
        } else if (w0.mode === 1) {
          w0.mode = 0;
        }

        if (w0.mode === 3) {
          w0.t = Math.min(1, w0.t + dt / w0.dur);
          const ease = Ao(w0.t);
          if (!this.gaitOn && w0.lift > 0) {
            w0.to.copy(home).add(w0.bo);
            w0.to.y += Sn;
          }
          w0.ankle.lerpVectors(w0.from, w0.to, ease);
          w0.ankle.y += w0.lift * Math.sin(Math.PI * w0.t);
          w0.pitch = Ht(w0.fromPitch, 0, ease) - (0.3 * w0.lift / 0.08) * Math.sin(Math.PI * w0.t);
          w0.toe = 0;
          if (w0.lift > 0) {
            w0.dir.copy(w0.dir0).lerp(dirT, ease);
            is.safeNorm(w0.dir, dirT);
          }
          if (w0.t >= 1) {
            w0.mode = 0;
            w0.pitch = 0;
            w0.plant.copy(w0.to);
            w0.plant.y -= Sn;
          }
        } else {
          const kneelBack = idx === 1 ? crouchK * (1 - moveK) : 0;
          w0.pitch = Ee(w0.pitch, -1.0 * kneelBack, 14, dt);
          w0.toe = Math.max(0, -w0.pitch) * 0.9;
          is.rock(w0.pitch, this._rockTmp);
          w0.ankle.copy(w0.plant).addScaledVector(w0.dir, this._rockTmp[0]);
          w0.ankle.y += this._rockTmp[1];

          const ox = w0.plant.x - home.x;
          const oz = w0.plant.z - home.z;
          const dist2 = ox * ox + oz * oz;
          const urgent = dist2 > 0.2 || w0.force;
          w0.force = false;
          if (!this.gaitOn && (dist2 > 0.0196 || Math.abs(w0.plant.y - home.y) > 0.08 || w0.dir.dot(pf) < 0.84) && (urgent || (other.mode === 0 && this.stepCool <= 0))) {
            w0.mode = 3;
            w0.from.copy(w0.ankle);
            w0.fromPitch = w0.pitch;
            w0.t = 0;
            w0.dir0.copy(w0.dir);
            w0.bo.set(0, 0, 0);
            const dLen = Math.sqrt(dist2);
            w0.dur = urgent ? 0.11 : Zt(0.16 + dLen * 0.3, 0.17, 0.3);
            w0.lift = 0.04 + 0.07 * Math.min(dLen, 0.6);
            w0.to.copy(home);
            w0.to.y += Sn;
            this.stepCool = w0.dur + 0.05;
          }
          w0.stance = w0.mode === 0;
        }
      }
      w0.prevA.set(prevAx, prevAy, prevAz);
    }

    const lookDownK = Ao((-pitch - 0.12) / 1.25);
    const neckBack = Ht(FP_GEOM.neckLevel, FP_GEOM.neckDown, lookDownK) + 0.02 * crouchK * (1 - lookDownK);
    m.N.copy(eyeLocal).addScaledVector(fwd, -neckBack);
    m.N.y -= FP_GEOM.neckDrop + 0.01 * lookDownK;

    const idleSway = Math.sin(this.time * 0.23) * (1 - moveK) * (1 - 0.6 * crouchK);
    let hipSide = Math.sin(this.time * 0.63) * 0.006 * (1 - moveK) + 0.012 * idleSway;
    let hipYaw = 0;
    let hipDropTilt = 0.025 * idleSway;

    if (this.gaitOn) {
      const wWave = Math.cos(Vt * (this.phase - duty * 0.5));
      hipSide -= Ht(0.022, 0.01, gait.rk) * wWave * moveK;
      hipDropTilt = Ht(0.05, 0.035, gait.rk) * wWave * moveK;
      hipYaw = Ht(0.08, 0.17 + 0.05 * this.wSprint, gait.rk) * Math.cos(Vt * this.phase) * moveK * (1 - 0.5 * backK) * (prDotF < 0 ? -1 : 1);
    }

    const stepShift = !this.gaitOn ? (feet[0].mode === 3 ? 0.03 : feet[1].mode === 3 ? -0.03 : 0) : 0;
    this._shift = Ee(this._shift, stepShift, 12, dt);

    m.P.copy(u)
      .addScaledVector(pr, hipSide + this._shift)
      .addScaledVector(H, Math.min(speed, 7) * 0.006 * moveK * (this.back ? -0.4 : 1));
    const spineLen = h2 + f2 - 0.014;
    const dxNP = m.N.x - m.P.x;
    const dzNP = m.N.z - m.P.z;
    m.P.y = m.N.y - Math.sqrt(Math.max(spineLen * spineLen - (dxNP * dxNP + dzNP * dzNP), 0.04)) - 0.035 * fastK * (1 - crouchK);

    const minPelvisY = this._localPos.y + Ht(0.52, Ht(0.335, 0.455, moveK), crouchK);
    if (m.P.y < minPelvisY) m.P.y = Ht(m.P.y, minPelvisY, 1 - this.wAir * 0.5);

    m.hip.copy(pr).multiplyScalar(Math.cos(hipYaw)).addScaledVector(pf, -Math.sin(hipYaw));
    m.hip.y -= hipDropTilt;
    m.hip.normalize();
    m.pole.copy(fwd).multiplyScalar(-1).addScaledVector(WORLD_UP, 0.2);

    // Prevent leg over-extension by dropping pelvis smoothly when needed
    const chestTmp = new THREE.Vector3();
    const neckTmp = new THREE.Vector3();
    is.ik2(m.P, m.N, h2, f2, m.pole, chestTmp, neckTmp, 0.999, 0.6);
    const cd = is.safeNorm(chestTmp.clone().sub(m.P), WORLD_UP);
    const hipAx = is.ortho(m.hip.clone(), cd, right);
    const maxLeg = hp * 0.955 - 0.003;
    let reqDrop = 0;
    for (let idx = 0; idx < 2; idx++) {
      const sgn = idx ? 1 : -1;
      const b0 = feet[idx];
      const hx = m.P.x - cd.x * lf + hipAx.x * sgn * Pi;
      const hy = m.P.y - cd.y * lf + hipAx.y * sgn * Pi;
      const hz = m.P.z - cd.z * lf + hipAx.z * sgn * Pi;
      const dx = b0.ankle.x - hx;
      const dz = b0.ankle.z - hz;
      const d2 = dx * dx + dz * dz;
      b0.hx = hx; b0.hy = hy; b0.hz = hz; b0.d2 = d2;
      if (b0.mode === 1 || b0.mode === 0) {
        const drop = hy - (b0.ankle.y + Math.sqrt(Math.max(maxLeg * maxLeg - d2, 0.0004)));
        if (drop > reqDrop) reqDrop = drop;
      }
    }
    reqDrop = Math.min(reqDrop, 0.5) * (1 - this.wAir);
    this.drop = reqDrop > this.drop
      ? Math.min(reqDrop, this.drop + Math.max(0.015, 2.4 * dt, (reqDrop - this.drop) * 0.6))
      : Ee(this.drop, reqDrop, 9, dt);
    m.P.y -= this.drop;
    m.N.y -= this.drop;

    const shTwist = Ht(0.3, this.off * 0.6, this.wSprint) - hipYaw * Ht(0.5, 1.2, this.wSprint);
    m.sh.copy(right).multiplyScalar(Math.cos(shTwist)).addScaledVector(fwd, -Math.sin(shTwist));
    m.sh.y += hipDropTilt * 0.5;
    m.sh.normalize();

    const kneeOut = 0.2 + 0.45 * crouchK;
    for (let idx = 0; idx < 2; idx++) {
      const w0 = feet[idx];
      const sgn = idx ? 1 : -1;
      m.A[idx].copy(w0.ankle);
      m.Kp[idx].copy(pf).addScaledVector(w0.dir, 0.6).addScaledVector(pr, sgn * kneeOut).addScaledVector(WORLD_UP, 0.12);
      const cp = Math.cos(w0.pitch);
      const sp = Math.sin(w0.pitch);
      m.fU[idx].copy(WORLD_UP).multiplyScalar(cp).addScaledVector(w0.dir, -sp);
      m.fF[idx].copy(w0.dir).multiplyScalar(cp).addScaledVector(WORLD_UP, sp);
      m.toe[idx] = w0.toe;
    }
  }

  _solveSlide(fwd, right, pitch, speed, eyeLocal, slideDir) {
    const a = this.rS;
    const sDir = slideDir ? readVec3(slideDir, new THREE.Vector3()) : fwd.clone();
    sDir.y = 0;
    if (sDir.lengthSq() < 0.05) sDir.copy(fwd);
    else sDir.normalize();

    const dFwd = sDir.dot(fwd);
    const dRight = sDir.dot(right);
    const u = new THREE.Vector3()
      .copy(fwd)
      .multiplyScalar(0.62 + 0.38 * Math.abs(dFwd))
      .addScaledVector(right, 0.8 * dRight)
      .normalize();
    const d = new THREE.Vector3(-u.z, 0, u.x);
    const groundY = this._sampleLocalGround(this._localPos.x, this._localPos.z, this._localPos.y);
    const spdK = Math.min(1, speed / 9);
    const vibA = Math.sin(this.time * 48) * 0.006 * spdK;
    const vibB = Math.sin(this.time * 70 + 1.7) * 0.008 * spdK;

    const lookDownK = Ao((-pitch - 0.12) / 1.25);
    a.N.copy(eyeLocal).addScaledVector(fwd, -Ht(FP_GEOM.neckLevel + 0.02, FP_GEOM.neckDown + 0.03, lookDownK));
    a.N.y -= FP_GEOM.neckDrop;

    const spineLen = h2 + f2 - 0.014;
    const lowY = groundY + 0.155 + vibA;
    const dy = Math.max(a.N.y - lowY, 0.12);
    const horiz = Math.sqrt(Math.max(spineLen * spineLen - dy * dy, 0.01));
    a.P.copy(a.N).addScaledVector(u, horiz);
    a.P.y = a.N.y - Math.min(dy, spineLen * 0.98);
    a.pole.copy(u).multiplyScalar(-1).addScaledVector(WORLD_UP, 0.3);
    a.hip.copy(d);
    a.sh.copy(right).multiplyScalar(Math.cos(0.3)).addScaledVector(fwd, -Math.sin(0.3)).lerp(d, 0.35).normalize();

    a.A[0].copy(a.P).addScaledVector(u, 0.79).addScaledVector(d, -0.05);
    a.A[0].y = this._sampleLocalGround(a.A[0].x, a.A[0].z, this._localPos.y) + 0.105 + vibB;
    a.A[1].copy(a.P).addScaledVector(u, 0.36).addScaledVector(d, 0.19);
    a.A[1].y = this._sampleLocalGround(a.A[1].x, a.A[1].z, this._localPos.y) + Sn + 0.012 + vibA;

    a.Kp[0].copy(WORLD_UP).addScaledVector(u, 0.3).addScaledVector(d, -0.25);
    a.Kp[1].copy(WORLD_UP).multiplyScalar(1.2).addScaledVector(u, 0.2).addScaledVector(d, 0.5);

    a.fF[0].copy(u).multiplyScalar(0.55).addScaledVector(WORLD_UP, 0.83).addScaledVector(d, -0.12).normalize();
    a.fU[0].copy(WORLD_UP).multiplyScalar(0.55).addScaledVector(u, -0.83).normalize();
    a.fF[1].copy(u).addScaledVector(d, 0.25).normalize();
    a.fU[1].copy(WORLD_UP);
    a.toe[0] = 0;
    a.toe[1] = 0;
  }

  _commitSkeleton(fwd, right) {
    const c = this.rO;
    const f = this.joints;
    const origin = this._localPos;

    is.safeNorm(c.pole, WORLD_UP);
    const chest = new THREE.Vector3();
    const neckOut = new THREE.Vector3();
    is.ik2(c.P, c.N, h2, f2, c.pole, chest, neckOut, 0.999, 0.6);
    c.N.copy(neckOut);

    const cd = is.safeNorm(chest.clone().sub(c.P), WORLD_UP);
    const nd = is.safeNorm(c.N.clone().sub(chest), cd);
    const shAx = is.ortho(c.sh.clone(), nd, right);
    const hipAx = is.ortho(c.hip.clone(), cd, right);

    const shMid = chest.clone().addScaledVector(nd, AE);
    const sL = shMid.clone().addScaledVector(shAx, -Yc);
    const sR = shMid.clone().addScaledVector(shAx, Yc);
    const hipMid = c.P.clone().addScaledVector(cd, -lf);
    const hL = hipMid.clone().addScaledVector(hipAx, -Pi);
    const hR = hipMid.clone().addScaledVector(hipAx, Pi);

    const kL = new THREE.Vector3(), fL = new THREE.Vector3();
    const kR = new THREE.Vector3(), fR = new THREE.Vector3();

    for (let idx = 0; idx < 2; idx++) {
      const hip = idx ? hR : hL;
      const knee = idx ? kR : kL;
      const foot = idx ? fR : fL;
      const pole = c.Kp[idx].clone();
      is.ik2(hip, c.A[idx], qr, rf, pole, knee, foot, 0.955, 0.27);
      const minKneeY = this._sampleLocalGround(knee.x, knee.z, origin.y) + 0.068;
      if (knee.y < minKneeY && hip.y > minKneeY) {
        for (let it = 0; it < 3 && knee.y < minKneeY; it++) {
          pole.addScaledVector(WORLD_UP, 0.8);
          is.ik2(hip, c.A[idx], qr, rf, pole, knee, foot, 0.955, 0.27);
        }
      }
    }

    // Write joints in this.root-local tangent space (relative to origin = player foot point)
    const writeRel = (jointIdx, v) => {
      f[jointIdx * 3] = v.x - origin.x;
      f[jointIdx * 3 + 1] = v.y - origin.y;
      f[jointIdx * 3 + 2] = v.z - origin.z;
    };

    const headPos = c.N.clone().addScaledVector(nd, u5);
    writeRel(fs.head, headPos);
    writeRel(fs.neck, c.N);
    writeRel(fs.chest, chest);
    writeRel(fs.pelvis, c.P);
    writeRel(fs.lShoulder, sL);
    writeRel(fs.rShoulder, sR);
    // Arms are culled from this.mesh.geometry, keep finite rest positions on their bones
    writeRel(fs.lElbow, sL.clone().addScaledVector(WORLD_UP, -Ca));
    writeRel(fs.lHand, sL.clone().addScaledVector(WORLD_UP, -(Ca + mh)));
    writeRel(fs.rElbow, sR.clone().addScaledVector(WORLD_UP, -Ca));
    writeRel(fs.rHand, sR.clone().addScaledVector(WORLD_UP, -(Ca + mh)));
    writeRel(fs.lHip, hL);
    writeRel(fs.lKnee, kL);
    writeRel(fs.lFoot, fL);
    writeRel(fs.rHip, hR);
    writeRel(fs.rKnee, kR);
    writeRel(fs.rFoot, fR);

    const u = this._hint;
    u.footW = 1;
    for (let idx = 0; idx < 2; idx++) {
      is.safeNorm(c.fF[idx], fwd);
      is.safeNorm(c.fU[idx], WORLD_UP);
      u.footF[idx].copy(c.fF[idx]);
      u.footU[idx].copy(c.fU[idx]);
      u.toeBend[idx] = c.toe[idx];
    }

    CE(f, u, this._mats);
    for (let i = 0; i < kE; i++) {
      const b = this.bones[i];
      b.matrix.copy(this._mats[i]);
      b.matrixWorldNeedsUpdate = true;
    }
    this.root.updateMatrixWorld(true);
  }

  update(dt, {
    state = 'walk',
    pos = [0, 0, 0],
    renderPos = null,
    eyeHeight = null,
    yaw = 0,
    pitch = 0,
    up = null,
    forward = null,
    velocity = null,
    onGround = undefined,
    grounded = true,
    crouch = undefined,
    crouching = false,
    sprint = undefined,
    sprinting = false,
    slide = undefined,
    sliding = false,
    slideDir = null,
    vy = 0,
    inCockpit = false,
    skydiving = false,
    ads = 0,
    hasScope = false,
    groundHeight = null,
  } = {}) {
    if (typeof groundHeight === 'function') this.groundHeight = groundHeight;
    const resolvedOnGround = onGround !== undefined ? Boolean(onGround) : Boolean(grounded);
    const resolvedCrouch = crouch !== undefined ? Boolean(crouch) : Boolean(crouching);
    const resolvedSprint = sprint !== undefined ? Boolean(sprint) : Boolean(sprinting);
    const resolvedSlide = slide !== undefined ? Boolean(slide) : Boolean(sliding);

    // Visibility gate: hide in cockpit, skydiving, non-walk states, or magnified scope ADS
    const scopedHide = (Number(ads) || 0) > 0.6 && Boolean(hasScope);
    const shouldShow =
      this.enabled &&
      state === 'walk' &&
      !inCockpit &&
      !skydiving &&
      !scopedHide;

    if (!shouldShow) {
      this.root.visible = false;
      this._live = false;
      return;
    }

    this.root.visible = true;
    const stepDt = dt > 1e-6 && Number.isFinite(dt) ? Math.min(dt, 0.05) : 1 / 60;
    this.time += stepDt;

    const worldPos = readVec3(pos, new THREE.Vector3());
    if (velocity) {
      if (up) {
        readVec3(up, _tmpV0);
        if (_tmpV0.lengthSq() > 1e-8) {
          _tmpV0.normalize();
          if (this._up.dot(_tmpV0) < -0.999) {
            _tmpV1.set(1, 0, 0);
            if (Math.abs(this._up.dot(_tmpV1)) > 0.9) _tmpV1.set(0, 0, 1);
            _tmpV1.addScaledVector(this._up, -_tmpV1.dot(this._up)).normalize();
            _tmpQ0.setFromAxisAngle(_tmpV1, Math.PI);
          } else {
            _tmpQ0.setFromUnitVectors(this._up, _tmpV0);
          }
          this._basisQuat.premultiply(_tmpQ0).normalize();
          this._up.copy(_tmpV0);
        }
      }
      this._invBasisQuat.copy(this._basisQuat).invert();
      const velBasis = readVec3(velocity, new THREE.Vector3()).applyQuaternion(this._invBasisQuat);
      if (dt > 1e-6 && this._live) {
        this._localPos.x += velBasis.x * stepDt;
        this._localPos.z += velBasis.z * stepDt;
      }
      if (this._localPos.lengthSq() > 4096) {
        this._localPos.set(0, 0, 0);
        this._live = false;
      }
    } else {
      this._updateTangentFrame(up, worldPos);
    }

    // Position and orient this.root on the planet's local up normal
    if (renderPos) readVec3(renderPos, this.root.position);
    else this.root.position.copy(worldPos);
    this.root.quaternion.copy(this._basisQuat);

    const clampedPitch = Zt(Number(pitch) || 0, -1.5, 1.5);
    let resolvedYaw = yaw;
    if (forward) {
      const fwdBasis = readVec3(forward, new THREE.Vector3()).applyQuaternion(this._invBasisQuat);
      if (fwdBasis.x * fwdBasis.x + fwdBasis.z * fwdBasis.z > 1e-8) {
        resolvedYaw = Math.atan2(-fwdBasis.x, -fwdBasis.z);
      }
    }
    const sinY = Math.sin(resolvedYaw);
    const cosY = Math.cos(resolvedYaw);
    const fwd = new THREE.Vector3(-sinY, 0, -cosY);
    const right = new THREE.Vector3(cosY, 0, -sinY);

    const isSlide = resolvedSlide;
    const isCrouch = resolvedCrouch && !isSlide;
    this.wSlide = Ee(this.wSlide, isSlide ? 1 : 0, 13, stepDt);
    const wUpright = 1 - this.wSlide;
    this.wCrouch = Ee(this.wCrouch, isCrouch ? 1 : 0, 11, stepDt);

    const prevSpeed = this.vel.length();
    const moveBlend = Fo(0.4, 1.4, prevSpeed);
    const backOff = Ht(
      FP_GEOM.backStand,
      Ht(FP_GEOM.backKneel, FP_GEOM.backCrouchMove, moveBlend),
      this.wCrouch
    );
    this._localRoot.set(
      this._localPos.x - fwd.x * backOff,
      this._localPos.y,
      this._localPos.z - fwd.z * backOff
    );

    if (!this._live || this._localRoot.distanceToSquared(this._prevRoot) > 4.0) {
      this._teleportLocal(fwd, right, this.wCrouch, this.wSlide);
    }

    const vx = (this._localRoot.x - this._prevRoot.x) / stepDt;
    const vz = (this._localRoot.z - this._prevRoot.z) / stepDt;
    const vBlend = 1 - Math.exp(-22 * stepDt);
    const oldVx = this.vel.x, oldVz = this.vel.z;
    this.vel.x += (vx - this.vel.x) * vBlend;
    this.vel.z += (vz - this.vel.z) * vBlend;
    const aBlend = 1 - Math.exp(-7 * stepDt);
    this.acc.x += (Zt((this.vel.x - oldVx) / stepDt, -30, 30) - this.acc.x) * aBlend;
    this.acc.z += (Zt((this.vel.z - oldVz) / stepDt, -30, 30) - this.acc.z) * aBlend;
    this._prevRoot.copy(this._localRoot);

    const speed = Math.hypot(this.vel.x, this.vel.z);
    this._peak = Math.max(speed, Ee(this._peak, speed, 6, stepDt));

    const resolvedEyeH = eyeHeight !== null && eyeHeight !== undefined
      ? Number(eyeHeight)
      : Ht(FP_GEOM.standEye, FP_GEOM.crouchEye, Math.max(this.wCrouch, this.wSlide * 0.85));
    const eyeLocal = new THREE.Vector3(
      this._localPos.x,
      this._localPos.y + resolvedEyeH,
      this._localPos.z
    );

    let resolvedSlideDir = slideDir;
    if (slideDir && forward) {
      resolvedSlideDir = readVec3(slideDir, new THREE.Vector3()).applyQuaternion(this._invBasisQuat);
    }

    zeroFpRig(this.rO);
    if (wUpright > 1e-3) {
      this._solveUpright(
        stepDt,
        fwd,
        right,
        clampedPitch,
        this.wCrouch,
        speed,
        resolvedOnGround,
        resolvedSprint,
        Number(vy) || 0,
        eyeLocal
      );
      addScaledFpRig(this.rO, this.rU, wUpright);
    }
    if (this.wSlide > 1e-3) {
      this._solveSlide(fwd, right, clampedPitch, speed, eyeLocal, resolvedSlideDir);
      addScaledFpRig(this.rO, this.rS, this.wSlide);
    }

    this._commitSkeleton(fwd, right);
  }

  dispose() {
    if (this.root && this.root.parent) this.root.parent.remove(this.root);
    this.skeleton.dispose();
  }
}
