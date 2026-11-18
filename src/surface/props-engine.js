// Procedural outpost prop & spaceport megastructure geometry builders
// (36 industrial props + 5 standalone megastructures).
// See src/surface/props.js for the public palette & Node-safe material adapter.
import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
const sa = mergeGeometries;
function il(i = 1337) {
  let e = i >>> 0, t = () => {
    e |= 0, e = e + 1831565813 | 0;
    let n = Math.imul(e ^ e >>> 15, 1 | e);
    return n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n, ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
  return t.range = (n, s) => n + (s - n) * t(), t.int = (n, s) => Math.floor(n + (s - n + 1) * t()), t.pick = (n) => n[Math.floor(t() * n.length)], t.sign = () => t() < 0.5 ? -1 : 1, t.fork = () => il(Math.floor(t() * 4294967296)), t;
}
function $e(i, e, t, n = "center") {
  let s = new THREE.BoxGeometry(i, e, t), o = s.attributes.uv, r = s.attributes.position, a = s.attributes.normal;
  for (let l = 0; l < o.count; l++) {
    let c = Math.abs(a.getX(l)), u = Math.abs(a.getY(l)), h = r.getX(l), f = r.getY(l), p = r.getZ(l);
    c > 0.5 ? o.setXY(l, p, f) : u > 0.5 ? o.setXY(l, h, p) : o.setXY(l, h, f);
  }
  return n === "bottom" && s.translate(0, e / 2, 0), s;
}
function ot(i, e, t, n = 16, s = false, o = "center") {
  let r = new THREE.CylinderGeometry(i, e, t, n, 1, s), a = r.attributes.uv, l = r.attributes.position, c = r.attributes.normal, u = Math.PI * (i + e);
  for (let h = 0; h < a.count; h++) Math.abs(c.getY(h)) > 0.9 ? a.setXY(h, l.getX(h), l.getZ(h)) : a.setXY(h, a.getX(h) * u, l.getY(h));
  return o === "bottom" && r.translate(0, t / 2, 0), r;
}
function Fn(i, e = 0.03, t = 8, n = false, s = 0) {
  let o = i.map((h) => h.isVector3 ? h : new THREE.Vector3(h[0], h[1], h[2])), r = new THREE.CatmullRomCurve3(o, n, "catmullrom", s), a = r.getLength(), l = Math.max(2, Math.ceil(a / Math.max(0.08, e * 3))), c = new THREE.TubeGeometry(r, Math.min(l, 400), e, t, n), u = c.attributes.uv;
  for (let h = 0; h < u.count; h++) u.setXY(h, u.getX(h) * a, u.getY(h) * Math.PI * 2 * e);
  return c;
}
var ky = new THREE.Matrix4(), Fy = new THREE.Quaternion(), Uy = new THREE.Euler(), Ny = new THREE.Vector3(), Fg = new THREE.Vector3();
function Dc(i, { p: e = [0, 0, 0], r: t = [0, 0, 0], s: n = 1 } = {}) {
  return Uy.set(t[0], t[1], t[2]), Fy.setFromEuler(Uy), Ny.set(e[0], e[1], e[2]), typeof n == "number" ? Fg.set(n, n, n) : Fg.set(n[0], n[1], n[2]), ky.compose(Ny, Fy, Fg), i.applyMatrix4(ky), i;
}
function Lc(i, e) {
  let t = i.attributes.position, n = t.count, s = new Float32Array(n * 3);
  for (let o = 0; o < n; o++) {
    let r = typeof e == "function" ? e(t.getX(o), t.getY(o), t.getZ(o)) : e;
    s[o * 3] = r[0], s[o * 3 + 1] = r[1], s[o * 3 + 2] = r[2];
  }
  return i.setAttribute("color", new THREE.BufferAttribute(s, 3)), i;
}
function Ii(i) {
  let e = i.filter(Boolean).map((l) => (l.attributes.uv || l.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(l.attributes.position.count * 2), 2)), l.attributes.normal || l.computeVertexNormals(), l));
  if (!e.length) return new THREE.BufferGeometry();
  let t = e.some((l) => l.attributes.color), n = e.map((l) => {
    let c = (l.index, l);
    if (t && !c.attributes.color) {
      let u = new Float32Array(c.attributes.position.count * 3).fill(1);
      c.setAttribute("color", new THREE.BufferAttribute(u, 3));
    }
    for (let u of Object.keys(c.attributes)) ["position", "normal", "uv", "color"].includes(u) || c.deleteAttribute(u);
    return c;
  }), s = n.every((l) => l.index), o = n.every((l) => !l.index), r = s || o ? n : n.map((l) => l.index ? l.toNonIndexed() : l);
  return sa(r, false) || new THREE.BufferGeometry();
}
function Qi(i, e, { cast: t = true, recv: n = true } = {}) {
  let s = new THREE.Mesh(i, e);
  return s.castShadow = t, s.receiveShadow = n, s;
}
var Gi = { container20: [6.06, 2.59, 2.44, "paint_red", "metal"], container40: [12.19, 2.59, 2.44, "paint_blue", "metal"], container40hc: [12.19, 2.9, 2.44, "paint_green", "metal"], jersey_barrier: [3, 0.81, 0.6, "concrete", "concrete"], light_mast: [0.5, 14, 0.5, "steel_galv", "metal"], fence_panel: [3, 2.4, 0.08, "chainlink", "metal"], guard_booth: [2.6, 2.7, 2.2, "paint_white", "metal"], gate_arm: [5, 1.1, 0.3, "hazard_stripes", "metal"], bollard_mooring: [0.7, 0.6, 0.7, "steel_dark", "metal"], bollard_post: [0.17, 1, 0.17, "paint_yellow", "metal"], relay_node: [1.2, 2.4, 0.8, "paint_grey", "metal"], shelf_rack: [2.7, 4.2, 1.1, "paint_orange", "metal"], stairs_metal: [3, 2.6, 1, "diamond_plate", "metal"], catwalk: [3, 1.1, 1.2, "diamond_plate", "metal"], reefer_unit: [0.5, 2.3, 2.3, "paint_white", "metal"], barrel: [0.6, 0.9, 0.6, "paint_blue", "metal"], pallet: [1.2, 0.144, 1, "wood_pallet", "wood"], pallet_stack: [1.2, 1.15, 1, "wood_pallet", "wood"], crate_wood: [1.1, 1, 0.9, "wood_pallet", "wood"], crate_stack: [1.2, 1.9, 1, "wood_pallet", "wood"], ibc_tote: [1.2, 1.16, 1, "plastic_grey", "metal"], forklift: [3.4, 2.2, 1.25, "paint_yellow", "metal"], cable_reel: [1.3, 1.3, 0.8, "wood_dark", "wood"], tire_stack: [0.8, 1, 0.8, "tire", "rubber"], dumpster: [1.9, 1.35, 1.1, "paint_green", "metal"], generator: [2.2, 1.4, 1, "paint_yellow", "metal"], jerry_can: [0.35, 0.47, 0.17, "paint_green", "metal"], traffic_cone: [0.36, 0.7, 0.36, "plastic_red", "rubber"], gas_cylinders: [0.9, 1.6, 0.5, "steel_dark", "metal"], tarp_cargo: [2.4, 1.5, 1.4, "tarp", "dirt"], sandbags: [2, 0.9, 0.6, "tarp", "dirt"], toolbox_cart: [0.9, 0.95, 0.5, "plastic_red", "metal"], floodlight_stand: [1, 2.2, 1, "paint_yellow", "metal"], cardboard_boxes: [1, 0.8, 0.8, "cardboard", "wood"], pipe_stack: [6, 0.9, 1.2, "steel_rust", "metal"], sign_post: [0.6, 2.4, 0.08, "paint_white", "metal"] }, Xg = {};
function _i(i, e) {
  Xg[i] = e;
}
function Yg(i) {
  return { names: () => Object.keys(Gi), has: (e) => !!Gi[e], build(e, t = {}) {
    if (Xg[e]) try {
      let o = Xg[e](i, t);
      if (o) return o.userData.prop = e, o;
    } catch (o) {
      console.error(`[props] builder "${e}" threw`, o);
    }
    let n = Gi[e] || [1, 1, 1, "concrete", "concrete"];
    Gi[e] || console.warn(`[props] unknown prop "${e}"`);
    let s = new THREE.Group();
    return s.add(Qi($e(n[0], n[1], n[2], "bottom"), i.mats.get(n[3]))), s.userData.colliders = [{ min: [-n[0] / 2, 0, -n[2] / 2], max: [n[0] / 2, n[1], n[2] / 2], surface: n[4] }], s.userData.size = [n[0], n[1], n[2]], s.userData.prop = e, s;
  } };
}
function $a(i) {
  let e = (i | 0) * 2654435761 | 0;
  return () => {
    e = e + 1831565813 | 0;
    let t = Math.imul(e ^ e >>> 15, 1 | e);
    return t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t, ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function h1(i, e) {
  let t = Math.sin(i * 127.1 + e * 311.7) * 43758.5453;
  return t - Math.floor(t);
}
function ri(i, e) {
  let t = Math.floor(i), n = Math.floor(e), s = i - t, o = e - n, r = s * s * (3 - 2 * s), a = o * o * (3 - 2 * o), l = h1(t, n), c = h1(t + 1, n), u = h1(t, n + 1), h = h1(t + 1, n + 1);
  return l + (c - l) * r + (u - l) * a + (l - c - u + h) * r * a;
}
var RA = (i) => Math.max(0, Math.min(1, i)), mn = (i, e, t) => {
  let n = RA((t - i) / (e - i));
  return n * n * (3 - 2 * n);
}, Ir = (i, e, t) => [i[0] + (e[0] - i[0]) * t, i[1] + (e[1] - i[1]) * t, i[2] + (e[2] - i[2]) * t];
function p3(i, e, t, n = 0.01, s = "center") {
  n = Math.max(5e-4, Math.min(n, i / 2 - 1e-4, e / 2 - 1e-4, t / 2 - 1e-4));
  let o = i / 2, r = e / 2, a = t / 2, l = new Float32Array(72), c = new Float32Array(72), u = new Float32Array(48), h = (x, y, b, m) => ((x > 0 ? 1 : 0) + (y > 0 ? 2 : 0) + (b > 0 ? 4 : 0)) * 3 + m;
  for (let x of [-1, 1]) for (let y of [-1, 1]) for (let b of [-1, 1]) {
    let m = [[x * o, y * (r - n), b * (a - n)], [x * (o - n), y * r, b * (a - n)], [x * (o - n), y * (r - n), b * a]], A = [[x, 0, 0], [0, y, 0], [0, 0, b]];
    for (let _ = 0; _ < 3; _++) {
      let M = h(x, y, b, _);
      l.set(m[_], M * 3), c.set(A[_], M * 3), _ === 0 ? (u[M * 2] = m[_][2], u[M * 2 + 1] = m[_][1]) : _ === 1 ? (u[M * 2] = m[_][0], u[M * 2 + 1] = m[_][2]) : (u[M * 2] = m[_][0], u[M * 2 + 1] = m[_][1]);
    }
  }
  let f = [], p = (x, y, b) => {
    let m = l[x * 3], A = l[x * 3 + 1], _ = l[x * 3 + 2], M = l[y * 3] - m, E = l[y * 3 + 1] - A, w = l[y * 3 + 2] - _, S = l[b * 3] - m, z = l[b * 3 + 1] - A, H = l[b * 3 + 2] - _, O = E * H - w * z, q = w * S - M * H, U = M * z - E * S, T = m + (M + S) / 3, D = A + (E + z) / 3, C = _ + (w + H) / 3;
    O * T + q * D + U * C >= 0 ? f.push(x, y, b) : f.push(x, b, y);
  }, d = (x, y, b, m) => {
    p(x, y, b), p(x, b, m);
  }, v = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (let x of [-1, 1]) d(...v.map(([y, b]) => h(x, y, b, 0))), d(...v.map(([y, b]) => h(y, x, b, 1))), d(...v.map(([y, b]) => h(y, b, x, 2)));
  for (let x of [-1, 1]) for (let y of [-1, 1]) d(h(-1, x, y, 1), h(1, x, y, 1), h(1, x, y, 2), h(-1, x, y, 2)), d(h(x, -1, y, 0), h(x, 1, y, 0), h(x, 1, y, 2), h(x, -1, y, 2)), d(h(x, y, -1, 0), h(x, y, 1, 0), h(x, y, 1, 1), h(x, y, -1, 1));
  for (let x of [-1, 1]) for (let y of [-1, 1]) for (let b of [-1, 1]) p(h(x, y, b, 0), h(x, y, b, 1), h(x, y, b, 2));
  let g = new THREE.BufferGeometry();
  return g.setAttribute("position", new THREE.BufferAttribute(l, 3)), g.setAttribute("normal", new THREE.BufferAttribute(c, 3)), g.setAttribute("uv", new THREE.BufferAttribute(u, 2)), g.setIndex(f), s === "bottom" && g.translate(0, e / 2, 0), g;
}
function m3(i, e, t, n, s, o) {
  let r = 0;
  for (let a = t; a < n; a += 9) {
    let l = i[a + 3] - i[a], c = i[a + 4] - i[a + 1], u = i[a + 5] - i[a + 2], h = i[a + 6] - i[a], f = i[a + 7] - i[a + 1], p = i[a + 8] - i[a + 2], d = c * p - u * f, v = u * h - l * p, g = l * f - c * h;
    r += d * ((i[a] + i[a + 3] + i[a + 6]) / 3 - s[0]) + v * ((i[a + 1] + i[a + 4] + i[a + 7]) / 3 - s[1]) + g * ((i[a + 2] + i[a + 5] + i[a + 8]) / 3 - s[2]);
  }
  if (r < 0 != !!o) for (let a = t; a < n; a += 9) {
    for (let c = 0; c < 3; c++) {
      let u = i[a + 3 + c];
      i[a + 3 + c] = i[a + 6 + c], i[a + 6 + c] = u;
    }
    let l = a / 3 * 2;
    for (let c = 0; c < 2; c++) {
      let u = e[l + 2 + c];
      e[l + 2 + c] = e[l + 4 + c], e[l + 4 + c] = u;
    }
  }
}
function la(i, e, t, { closed: n = false, center: s = null, inward: o = false, caps: r = false } = {}) {
  let a = [], l = [], c = i.length, u = n ? c : c - 1, h = [0];
  for (let g = 0; g < u; g++) {
    let x = i[g], y = i[(g + 1) % c];
    h.push(h[g] + Math.hypot(y[0] - x[0], y[1] - x[1]));
  }
  for (let g = 0; g < e.length - 1; g++) {
    let x = e[g], y = e[g + 1];
    for (let b = 0; b < u; b++) {
      let m = i[b], A = i[(b + 1) % c], _ = t(m[0], m[1], x, g), M = t(A[0], A[1], x, g), E = t(A[0], A[1], y, g + 1), w = t(m[0], m[1], y, g + 1);
      a.push(..._, ...M, ...E, ..._, ...E, ...w), l.push(h[b], x, h[b + 1], x, h[b + 1], y, h[b], x, h[b + 1], y, h[b], y);
    }
  }
  let f = a.length, p = null, d = () => {
    if (s) return s;
    if (!p) {
      p = [0, 0, 0];
      for (let x = 0; x < f; x += 3) p[0] += a[x], p[1] += a[x + 1], p[2] += a[x + 2];
      let g = 3 / f;
      p[0] *= g, p[1] *= g, p[2] *= g;
    }
    return p;
  };
  if (m3(a, l, 0, f, d(), o), r && n) {
    let g = 0, x = 0;
    for (let y of i) g += y[0], x += y[1];
    g /= c, x /= c;
    for (let y of [0, e.length - 1]) {
      let b = a.length, m = e[y], A = t(g, x, m, y);
      for (let _ = 0; _ < c; _++) {
        let M = i[_], E = i[(_ + 1) % c];
        a.push(...A, ...t(M[0], M[1], m, y), ...t(E[0], E[1], m, y)), l.push(g, x, M[0], M[1], E[0], E[1]);
      }
      m3(a, l, b, a.length, d(), o);
    }
  }
  let v = new THREE.BufferGeometry();
  return v.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a), 3)), v.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(l), 2)), v.computeVertexNormals(), v;
}
function CA(i, e, t, n, s) {
  let o = i % e;
  o < 0 && (o += e);
  let r = e - n - 2 * s;
  return o <= n ? 0 : o < n + s ? -t * (o - n) / s : o <= n + s + r ? -t : -t * (1 - (o - n - s - r) / s);
}
function Uc(i, e, t, n, s, o, r = i) {
  let a = t - s - 2 * o, l = [0, s, s + o, s + o + a], c = [i], u = Math.floor((i - r) / t) - 1, h = Math.ceil((e - r) / t) + 1;
  for (let f = u; f <= h; f++) for (let p of l) {
    let d = r + f * t + p;
    d > i + 1e-4 && d < e - 1e-4 && c.push(d);
  }
  return c.push(e), c.map((f) => [f, CA(f - r, t, n, s, o)]);
}
function pr(i, e, t = 5) {
  let n = [], s = Math.min(i, e) / 2, o = i / 2 - s, r = e / 2 - s;
  for (let u = 0; u < 4; u++) for (let h = 0; h <= t; h++) {
    let f = (u + h / t) * Math.PI / 2;
    n.push([Math.cos(f) * s + (u === 0 || u === 3 ? o : -o), Math.sin(f) * s + (u < 2 ? r : -r)]);
  }
  let a = [], l = [];
  for (let u = 0; u < n.length; u++) {
    let h = n[u], f = n[(u + 1) % n.length];
    a.push(0, 0, 0, h[0], h[1], 0, f[0], f[1], 0), l.push(0.5, 0.5, h[0] / i + 0.5, h[1] / e + 0.5, f[0] / i + 0.5, f[1] / e + 0.5);
  }
  let c = new THREE.BufferGeometry();
  return c.setAttribute("position", new THREE.BufferAttribute(new Float32Array(a), 3)), c.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(l), 2)), c.computeVertexNormals(), c;
}
function cn(i, e) {
  return new THREE.PlaneGeometry(i, e);
}
function Nc(i, e) {
  let t = new THREE.PlaneGeometry(i, e), n = t.attributes.uv;
  for (let s = 0; s < n.count; s++) n.setXY(s, n.getX(s) * i, n.getY(s) * e);
  return t;
}
function PA(i) {
  let e = i.index ? i.toNonIndexed() : i;
  return e.computeVertexNormals(), e;
}
function mr(i, e = 10, t = 6, n = Math.PI * 2, s = 0, o = Math.PI) {
  return new THREE.SphereGeometry(i, e, t, 0, n, s, o);
}
function g1(i, e = 16) {
  return new THREE.LatheGeometry(i.map((t) => new THREE.Vector2(t[0], t[1])), e);
}
var f1 = new THREE.Euler(), Fc = new THREE.Quaternion(), g3 = new THREE.Matrix4(), d1 = new THREE.Vector3(), p1 = new THREE.Vector3(1, 1, 1);
function je(i, e = 0, t = 0, n = 0, s = null) {
  return s ? (f1.set(s[0], s[1], s[2]), Fc.setFromEuler(f1)) : Fc.identity(), d1.set(e, t, n), g3.compose(d1, Fc, p1), i.applyMatrix4(g3), i;
}
function _o(i = 0, e = 0, t = 0, n = null) {
  return n ? (f1.set(n[0], n[1], n[2]), Fc.setFromEuler(f1)) : Fc.identity(), d1.set(i, e, t), new THREE.Matrix4().compose(d1, Fc, p1);
}
var jn = class {
  constructor(e) {
    this.G = e, this.buckets = /* @__PURE__ */ new Map(), this.stack = [], this.m = null, this.defCol = /* @__PURE__ */ new Map();
  }
  M(e, t) {
    return this.G.mats.get(e, t);
  }
  push(e) {
    return this.stack.push(this.m), this.m = this.m ? this.m.clone().multiply(e) : e.clone(), this;
  }
  pop() {
    return this.m = this.stack.pop(), this;
  }
  add(e, t, n, s) {
    this.m && t.applyMatrix4(this.m);
    let o = n || this.defCol.get(e);
    o && Lc(t, o);
    let r = this.buckets.get(e);
    return r || (r = { mat: e, geos: [], cast: !s }, this.buckets.set(e, r)), r.geos.push(t), t;
  }
  box(e, t, n, s, o, r, a, l = {}) {
    return this.add(e, je(l.r === 0 ? $e(t, n, s) : p3(t, n, s, l.r || Math.min(0.012, Math.min(t, n, s) * 0.25)), o, r, a, l.rot), l.col);
  }
  cyl(e, t, n, s, o, r, a, l = {}) {
    let c = ot(t, n, s, l.seg || 12, !!l.open);
    return l.flat && (c = PA(c)), this.add(e, je(c, o, r, a, l.rot), l.col);
  }
  tube(e, t, n, s = {}) {
    return this.add(e, Fn(t, n, s.seg || 6, false, s.tension === void 0 ? 0.5 : s.tension), s.col);
  }
  bar(e, t, n, s, o = {}) {
    let r = new THREE.Vector3(n[0] - t[0], n[1] - t[1], n[2] - t[2]), a = r.length(), l = ot(o.r2 === void 0 ? s : o.r2, s, a, o.seg || 6, !o.caps), c = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), r.normalize());
    return l.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((t[0] + n[0]) / 2, (t[1] + n[1]) / 2, (t[2] + n[2]) / 2), c, p1)), this.add(e, l, o.col);
  }
  beam(e, t, n, s, o, r = {}) {
    let a = new THREE.Vector3(n[0] - t[0], n[1] - t[1], n[2] - t[2]), l = a.length(), c = r.r === 0 ? $e(s, l, o) : p3(s, l, o, r.r || Math.min(s, o) * 0.2), u = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), a.normalize());
    return r.twist && u.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.twist)), c.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3((t[0] + n[0]) / 2, (t[1] + n[1]) / 2, (t[2] + n[2]) / 2), u, p1)), this.add(e, c, r.col);
  }
  decal(e, t, n, s, o, r, a) {
    return this.add(e.material, je(cn(a || t * e.aspect, t), n, s, o, r), null, true);
  }
  parts() {
    let e = [];
    for (let t of this.buckets.values()) e.push({ mat: t.mat, geo: Ii(t.geos), cast: t.cast });
    return e;
  }
  group(e) {
    return Zg(this.parts(), e);
  }
};
function Zg(i, e) {
  let t = new THREE.Group();
  for (let n of i) {
    let s = new THREE.Mesh(n.geo, e && e.get(n.mat) || n.mat);
    s.castShadow = n.cast, s.receiveShadow = true, t.add(s);
  }
  return t;
}
function qi(i, e, t, n) {
  return i.userData.size = t, i.userData.colliders = n, i.name = e, i;
}
var m1 = /* @__PURE__ */ new WeakMap();
function Mi(i, e, t) {
  let n = m1.get(i.mats);
  n || (n = /* @__PURE__ */ new Map(), m1.set(i.mats, n));
  let s = "L|" + e + "|" + JSON.stringify(t || {});
  if (!n.has(s)) {
    let o;
    try {
      o = i.mats.label(e, t || {});
    } catch {
      o = null;
    }
    n.set(s, o && o.material ? o : { material: i.mats.get("paint_white"), aspect: Math.max(1, e.length * 0.6) });
  }
  return n.get(s);
}
function Jn(i, e) {
  let t = m1.get(i.mats);
  t || (t = /* @__PURE__ */ new Map(), m1.set(i.mats, t));
  let n = "D|" + e;
  if (!t.has(n)) {
    let s;
    try {
      s = i.mats.decal(e);
    } catch {
      s = null;
    }
    t.set(n, s && s.material ? s : { material: i.mats.get("paint_white"), aspect: 1 });
  }
  return t.get(n);
}
var Bc = 2.438, _3 = { container20: { type: "22G1", gross: "30,480", tare: "2,230", net: "28,250", cu: "33.2", def: "red" }, container40: { type: "42G1", gross: "32,500", tare: "3,750", net: "28,750", cu: "67.7", def: "blue" }, container40hc: { type: "45G1", gross: "32,500", tare: "3,940", net: "28,560", cu: "76.3", def: "green" } }, v1 = ["SLTU 482915 7", "HBMU 307144 2", "NRDU 665201 9", "OKTU 119873 4", "VSLU 850362 1", "TQLU 274590 6"], v3 = ["logo_a", "logo_b", "logo_c", "logo_d"], jg = ["red", "blue", "green", "yellow", "orange", "white", "grey", "teal"], Jt = { body: true }, IA = 6, x3 = /* @__PURE__ */ new Map(), y3 = 0.178, bf = 0.118, b3 = 0.162, Uo = { P: 0.278, d: 0.036, fo: 0.072, sl: 0.068 }, x1 = { P: 0.209, d: 0.02, fo: 0.09, sl: 0.03 }, y1 = { P: 0.25, d: 0.042, fo: 0.07, sl: 0.06 };
function zA(i, e, t, n, s) {
  let o = Gi[e][0], r = Gi[e][1], a = _3[e], l = $a(1e3 + t * 77 + e.length * 13), c = new jn(i), u = c.M("steel_galv"), h = c.M("wood_pallet"), f = Bc / 2, p = o / 2, d = f - 0.012, v = -p + 0.085, g = p - 0.135, x = 0.167, y = r - 0.06, b = [], m = Math.round((1 + l() * 2.4) * (0.4 + s)), A = [[-p * 0.75, -p * 0.05], [p - 2.2, p]];
  for (let $ = 0; $ < m; $++) {
    let ue = l() < 0.5 ? 1 : -1, me = 0, ee = 0;
    do
      me = (l() * 2 - 1) * (p - 0.9), ee++;
    while (ee < 8 && A.some((B) => me > B[0] - 0.4 && me < B[1] + 0.4 && l() < 0.9));
    b.push({ side: ue, x: ue * me, y: 0.45 + l() * 1.3, r: 0.22 + l() * 0.3, depth: 0.025 + l() * 0.04 });
  }
  let _ = [], M = Math.round(o / 2.2 * (0.5 + s) * (0.6 + l()));
  for (let $ = 0; $ < M * 2; $++) _.push({ side: $ % 2 ? 1 : -1, x: (l() * 2 - 1) * (p - 0.3), w: 0.05 + l() * 0.12, k: 0.4 + l() * 0.6 });
  let E = [0.5, 0.44, 0.38], w = [0.62, 0.38, 0.24], S = t * 9.7, z = ($, ue, me) => {
    let ee = 1 + (ri($ * 0.9 + S, ue * 1.7 + me * 0.4) - 0.5) * 0.16 * (0.5 + s);
    ee *= 0.94 + 0.06 * ri($ * 6.1 + me * 3.3, ue * 5 + S);
    let B = [ee, ee, ee], P = mn(0.62, 0.02, ue) * (0.45 + 0.5 * s) * (0.75 + 0.5 * ri($ * 2.3 + me, S));
    return B = Ir(B, [E[0] * ee, E[1] * ee, E[2] * ee], Math.min(1, P)), B;
  };
  c.defCol.set(Jt, z);
  let H = ($, ue, me) => {
    let ee = 0;
    for (let B of b) if (B.side === me) {
      let P = Math.hypot($ - B.x, (ue - B.y) * 0.9) / B.r;
      if (P < 1) {
        let V = 1 - P * P;
        ee += B.depth * V * V;
      }
    }
    return ee;
  }, O = [0.035, 0.035, 0.04];
  for (let $ of [-1, 1]) for (let ue of [0, 1]) for (let me of [-1, 1]) {
    let ee = $ * (p - y3 / 2), B = ue ? r - bf / 2 : bf / 2, P = me * (f - b3 / 2);
    c.box(Jt, y3, bf, b3, ee, B, P, { r: 0.012 }), c.add(Jt, je(pr(0.078, 0.052, 3), ee, B, me * (f + 12e-4), [0, me > 0 ? 0 : Math.PI, 0]), O), c.add(Jt, je(pr(0.064, 0.05, 3), $ * (p + 12e-4), B, P, [0, $ * Math.PI / 2, 0]), O), ue && c.add(Jt, je(pr(0.124, 0.064, 3), ee, r + 12e-4, P, [-Math.PI / 2, 0, 0]), O);
  }
  for (let $ of [-1, 1]) c.box(Jt, 0.085, r - 2 * bf + 0.01, 0.15, -p + 0.0465, r / 2, $ * (f - 0.079), { r: 0.014 }), c.box(Jt, 0.14, r - 2 * bf + 0.01, 0.056, p - 0.074, r / 2, $ * (f - 0.032), { r: 0.012 }), c.box(Jt, o - 0.2, 0.062, 0.062, -0.02, r - 0.031, $ * (f - 0.035), { r: 8e-3 }), c.box(Jt, o - 0.2, 0.158, 0.05, -0.02, 0.012 + 0.079, $ * (f - 0.029), { r: 8e-3 });
  if (c.box(Jt, 0.062, 0.062, Bc - 0.2, -p + 0.035, r - 0.031, 0, { r: 8e-3 }), c.box(Jt, 0.05, 0.158, Bc - 0.2, -p + 0.029, 0.091, 0, { r: 8e-3 }), c.box(Jt, 0.13, 0.12, Bc - 0.12, p - 0.072, r - 0.06, 0, { r: 0.01 }), c.box(Jt, 0.13, 0.158, Bc - 0.12, p - 0.072, 0.091, 0, { r: 0.01 }), c.box(Jt, 0.03, 0.012, Bc - 0.4, p - 0.012, r - 0.125, 0, { r: 3e-3, rot: [0, 0, -0.5] }), e === "container20") for (let $ of [-1, 1]) for (let ue of [-1.025, 1.025]) {
    c.add(Jt, je(cn(0.36, 0.112), ue, 0.075, $ * (f - 35e-4), [0, $ > 0 ? 0 : Math.PI, 0]), O), c.box(Jt, 0.46, 0.018, 0.012, ue, 0.142, $ * (f - 2e-3), { r: 3e-3 });
    for (let me of [-1, 1]) c.box(Jt, 0.018, 0.13, 0.01, ue + me * 0.19, 0.078, $ * (f - 3e-3), { r: 3e-3 });
  }
  let q = [x, 0.44, 1.25, r - 0.5, y], U = Uc(v, g, Uo.P, Uo.d, Uo.fo, Uo.sl, v + 0.02);
  for (let $ of [-1, 1]) {
    let ue = la(U, q, (B, P, V) => [B, V, $ * (d + P - H(B, V, $))], { center: [0, r / 2, 0] });
    ue.computeVertexNormals();
    let me = ue.attributes.position, ee = new Float32Array(me.count * 3);
    for (let B = 0; B < me.count; B++) {
      let P = me.getX(B), V = me.getY(B), Y = me.getZ(B), L = z(P, V, Y), Z = d - Math.abs(Y), J = mn(8e-3, 0.034, Z);
      L = [L[0] * (1 - 0.17 * J), L[1] * (1 - 0.18 * J), L[2] * (1 - 0.18 * J)];
      let oe = mn(r - 0.75, y, V);
      if (oe > 0) {
        for (let le of _) if (le.side === $) {
          let R = Math.abs(P - le.x) / le.w;
          R < 1 && (L = Ir(L, [L[0] * w[0], L[1] * w[1], L[2] * w[2]], oe * oe * le.k * (1 - R * R) * (0.45 + 0.55 * s)));
        }
      }
      let fe = H(P, V, $);
      fe > 4e-3 && (L = Ir(L, [L[0] * 0.66, L[1] * 0.46, L[2] * 0.36], Math.min(0.8, fe * 22))), ee[B * 3] = L[0], ee[B * 3 + 1] = L[1], ee[B * 3 + 2] = L[2];
    }
    ue.setAttribute("color", new THREE.BufferAttribute(ee, 3)), c.buckets.get(Jt).geos.push(ue);
  }
  for (let $ of [-1, 1]) for (let ue of o > 7 ? [-1, 1] : [1]) {
    let me = $ * ue * (p - 0.62), ee = r - 0.165, B = $ * (d - 4e-3);
    c.box(Jt, 0.24, 0.1, 0.03, me, ee, B, { r: 8e-3 });
    for (let P = -1; P <= 1; P++) c.add(Jt, je(cn(0.18, 0.012), me, ee + P * 0.026, $ * (d + 0.0116), [0, $ > 0 ? 0 : Math.PI, 0]), O);
  }
  {
    let $ = Uc(-f + 0.155, f - 0.155, y1.P, y1.d, y1.fo, y1.sl, -f + 0.155 + 0.03), ue = la($, [x, 1.25, y], (ee, B, P) => [-(p - 0.014 + B), P, ee], { center: [0, r / 2, 0] }), me = -(p - 0.014);
    c.add(Jt, ue, (ee, B, P) => {
      let V = z(ee, B, P), Y = mn(8e-3, 0.038, ee - me);
      return [V[0] * (1 - 0.17 * Y), V[1] * (1 - 0.18 * Y), V[2] * (1 - 0.18 * Y)];
    });
  }
  {
    let $ = Uc(-p + 0.07, p - 0.13, x1.P, x1.d, x1.fo, x1.sl, -p + 0.1), ue = r - 8e-3, me = la($, o > 7 ? [-(f - 0.066), f - 0.066] : [-(f - 0.066), 0, f - 0.066], (ee, B, P) => [ee, ue + B + (Math.abs(P) < 0.01 ? 6e-3 : 0), P], { center: [0, r / 2, 0] });
    c.add(Jt, me, (ee, B, P) => {
      let V = 0.78 + 0.3 * ri(ee * 0.8 + S, P * 1.1), Y = mn(4e-3, 0.018, ue - B);
      return [V * (1 - 0.25 * Y), V * (1 - 0.3 * Y) * 0.97, V * (1 - 0.32 * Y) * 0.94];
    });
  }
  let T = n > 0.03, D = 0.172;
  if (T) {
    let $ = (ee, B, P) => {
      let Y = (0.16 + 0.62 * mn(-p, p, ee) * mn(-p, p, ee)) * (0.8 + 0.2 * mn(0.2, 1.4, B));
      return [Y, Y, Y];
    }, ue = Uc(v, g, Uo.P, Uo.d, Uo.fo, Uo.sl, v + 0.02);
    for (let ee of [-1, 1]) c.add(Jt, la(ue, [D, y - 0.02], (B, P, V) => [B, V, ee * (d + P - 4e-3)], { center: [0, r / 2, 0], inward: true }), $);
    c.add(Jt, je(cn(g - v, 2 * d), (v + g) / 2, y - 0.03, 0, [Math.PI / 2, 0, 0]), $), c.add(Jt, je(cn(2 * d, y - D), v + 0.03, (D + y) / 2, 0, [0, Math.PI / 2, 0]), $);
    let me = Nc(g - v + 0.1, 2 * d - 0.02);
    c.add(h, je(me, (v + g) / 2 + 0.05, D, 0, [-Math.PI / 2, 0, 0]), (ee) => {
      let B = 0.3 + 0.6 * mn(-p, p, ee) ** 2;
      return [B, B * 0.97, B * 0.93];
    }), c.box(u, 0.05, 6e-3, 2 * d - 0.1, p - 0.11, D + 1e-3, 0, { r: 2e-3 });
  }
  let C = 0.175, G = r - 0.124, j = G - C, N = f - 0.058 - 4e-3, Q = p - 0.066, K = ($, ue, me) => z($, ue, me), ie = [];
  for (let $ of [1, -1]) {
    let ue = n * ($ > 0 ? 1 : 0.88) * THREE.MathUtils.degToRad($ > 0 ? 112 : 100), me = $ * (f - 0.058);
    c.push(_o(Q, 0, me, [0, -$ * ue, 0]));
    let ee = (k) => -$ * k, B = (C + G) / 2;
    c.box(Jt, 0.034, j, N - 6e-3, 0, B, ee(N / 2), { r: 8e-3, col: K });
    let P = e === "container40hc" ? 7 : 6, V = C + 0.085, Y = G - 0.085, L = (Y - V) / P, Z = 0.019, J = 0.031, oe = [];
    for (let k = 0; k < P; k++) {
      let ce = V + k * L;
      oe.push([ce, Z], [ce + 0.022, Z], [ce + 0.05, J], [ce + L - 0.05, J], [ce + L - 0.022, Z]);
    }
    oe.push([Y, Z]), c.add(Jt, la(oe, [0.075, N - 0.085], (k, ce, ve) => [ce, k, ee(ve)], { center: [-1, B, ee(N / 2)] }), (k, ce, ve) => z(k, ce, ve));
    let fe = (k) => V + (k + 0.5) * L, le = [0.05, 0.05, 0.05];
    c.box(Jt, 0.022, j + 0.012, 0.018, 4e-3, B, ee(N + 1e-3), { r: 0, col: le }), c.box(Jt, 0.022, 0.016, N, 4e-3, G + 4e-3, ee(N / 2), { r: 0, col: le }), c.box(Jt, 0.022, 0.016, N, 4e-3, C - 4e-3, ee(N / 2), { r: 0, col: le });
    let R = e === "container40hc" ? 5 : 4;
    for (let k = 0; k < R; k++) {
      let ce = C + 0.16 + k * (j - 0.32) / (R - 1);
      c.box(Jt, 0.012, 0.062, 0.15, 0.021, ce, ee(0.085), { r: 0 }), c.cyl(u, 0.013, 0.013, 0.086, 0.026, ce, ee(-2e-3), { seg: 6, open: true });
    }
    for (let k of [0.31, 0.83]) {
      c.cyl(u, 0.0155, 0.0155, j + 0.2, 0.052, B, ee(k), { seg: 7, open: true });
      for (let Te of [-1, 1]) c.add(u, je($e(0.03, 0.045, 0.085), 0.052 - 4e-3, B + Te * (j / 2 + 0.065), ee(k))), c.box(Jt, 0.03, 0.05, 0.075, 0.052 - 0.012, B + Te * (j / 2 - 0.035), ee(k), { r: 0 });
      for (let Te of [C + j * 0.3, C + j * 0.72]) c.box(Jt, 0.026, 0.04, 0.07, 0.052 - 0.012, Te, ee(k), { r: 0 });
      let ve = 1.02 + (k > 0.5 ? 0 : 0.13), _e = k > 0.5 ? -1 : 1;
      c.box(u, 0.02, 0.05, 0.05, 0.052 + 8e-3, ve, ee(k), { r: 0 }), c.box(u, 0.011, 0.032, 0.36, 0.052 + 0.016, ve, ee(k + _e * 0.19), { r: 4e-3 }), c.box(Jt, 0.03, 0.07, 0.05, 0.052 - 8e-3, ve, ee(k + _e * 0.33), { r: 0 }), c.box(u, 0.012, 0.085, 0.012, 0.052 + 0.012, ve + 5e-3, ee(k + _e * 0.33), { r: 0 });
    }
    let I = 0.031 + 25e-4, se = [0, Math.PI / 2, 0], ae = (k, ce, ve, _e, Te) => {
      let Pe = ce * k.aspect;
      Te && Pe > Te && (ce *= Te / Pe, Pe = Te), c.add(k.material, je(cn(Pe, ce), I, ve, ee(_e), se), null, true);
    };
    if ($ < 0) {
      ae(Mi(i, v1[t % v1.length], { color: "white", font: "stencil", distress: 0.3 }), 0.115, fe(P - 1), N / 2, N - 0.24), ae(Mi(i, a.type, { color: "white", font: "stencil", distress: 0.3 }), 0.1, fe(P - 2), N / 2 + 0.2, 0.4);
      let k = { color: "white", font: "sans", distress: 0.2 };
      ae(Mi(i, "MAX GROSS " + a.gross + " KG", k), 0.052, fe(P - 3) + 0.062, N / 2 - 0.01, 0.44), ae(Mi(i, "TARE " + a.tare + " KG   NET " + a.net + " KG", k), 0.045, fe(P - 3), N / 2 - 0.01, 0.44), ae(Mi(i, "CU.CAP. " + a.cu + " CU.M", k), 0.045, fe(P - 3) - 0.062, N / 2 - 0.01, 0.44);
    } else ae(Jn(i, v3[t % 4]), 0.2, fe(P - 1), N / 2, N - 0.36), ae(Jn(i, "csc_plate"), 0.17, fe(1), N / 2 + 0.05, 0.36), e === "container40hc" && ae(Jn(i, "caution_stripes"), 0.1, G - 0.04, N / 2, N - 0.1);
    if (c.pop(), T) for (let k = 0; k < 3; k++) {
      let ce = N * k / 3, ve = N * (k + 1) / 3, _e = [Q + Math.sin(ue) * ce, me - $ * Math.cos(ue) * ce], Te = [Q + Math.sin(ue) * ve, me - $ * Math.cos(ue) * ve];
      ie.push({ min: [Math.min(_e[0], Te[0]) - 0.03, C, Math.min(_e[1], Te[1]) - 0.03], max: [Math.max(_e[0], Te[0]) + 0.03, G, Math.max(_e[1], Te[1]) + 0.03], surface: "metal" });
    }
  }
  for (let $ of [1, -1]) for (let ue of [0.31, 0.83]) for (let me of [-1, 1]) {
    let ee = $ * (f - 0.058) - $ * ue;
    c.add(Jt, je($e(0.035, 0.05, 0.11), p - 0.03, me > 0 ? r - 0.07 : 0.115, ee));
  }
  let F = ($, ue, me, ee, B, P) => {
    let V = B * $.aspect;
    P && V > P && (B *= P / V, V = P);
    let Y = me - V / 2, L = me + V / 2, Z = ue > 0 ? Y : -L, J = ue > 0 ? L : -Y, oe = Uc(Math.max(v, Z), Math.min(g, J), Uo.P, Uo.d, Uo.fo, Uo.sl, v + 0.02), fe = ee - B / 2, le = ee + B / 2, R = la(oe, [fe, le], (ae, k, ce) => [ae, ce, ue * (d + k + 3e-3 - H(ae, ce, ue))], { center: [0, r / 2, 0] }), I = R.attributes.position, se = R.attributes.uv;
    for (let ae = 0; ae < I.count; ae++) {
      let k = (I.getX(ae) - Z) / (J - Z);
      se.setXY(ae, ue > 0 ? k : 1 - k, (I.getY(ae) - fe) / B);
    }
    return c.add($.material, R, null, true), V;
  }, X = Mi(i, v1[t % v1.length], { color: "white", font: "stencil", distress: 0.3 }), ne = Mi(i, a.type, { color: "white", font: "stencil", distress: 0.3 }), re = Jn(i, v3[t % 4]);
  for (let $ of [-1, 1]) {
    let ue = Math.min(r * 0.4, 1.05), me = Math.min(ue * re.aspect, e === "container20" ? 2.2 : 3.4);
    F(re, $, e === "container20" ? -0.75 : -p * 0.42, r * 0.52, me / re.aspect, me);
    let ee = Math.min(0.14 * X.aspect, 1.9);
    F(X, $, p - 0.3 - ee / 2, r - 0.32, 0.14, 1.9);
    let B = Math.min(0.11 * ne.aspect, 0.6);
    F(ne, $, p - 0.3 - B / 2, r - 0.52, 0.11, 0.6);
    let P = Math.round((1 + l() * 2) * (0.4 + s) * (o > 7 ? 1.6 : 1));
    for (let V = 0; V < P; V++) {
      let Y = Jn(i, l() < 0.6 ? "rust_run" : "grime_streak"), L = 0.5 + l() * 0.7, Z = Math.min(0.5, Math.max(0.16, L * Y.aspect));
      F({ material: Y.material, aspect: Z / L }, $, (l() * 2 - 1) * (p - 0.6), y - L / 2 - 5e-3, L);
    }
  }
  return T ? ie.push({ min: [-p, 0, -f], max: [p, D, f], surface: "wood" }, { min: [-p, r - 0.09, -f], max: [p, r, f], surface: "metal" }, { min: [-p, 0, -f], max: [p, r, -f + 0.07], surface: "metal" }, { min: [-p, 0, f - 0.07], max: [p, r, f], surface: "metal" }, { min: [-p, 0, -f], max: [-p + 0.07, r, f], surface: "metal" }) : ie.push({ min: [-p, 0, -f], max: [p, r, f], surface: "metal" }), { parts: c.parts(), colliders: ie };
}
function M3(i, e, t = {}) {
  let n = _3[e], s = t.seed === void 0 ? 0 : Math.abs(Math.floor(t.seed)), o = s % IA, r = Math.round(THREE.MathUtils.clamp(t.doors || 0, 0, 1) * 10) / 10, a = Math.round(THREE.MathUtils.clamp(t.wear === void 0 ? 0.5 : t.wear, 0, 1) * 2) / 2, l = e + "|" + o + "|" + r + "|" + a, c = x3.get(i.mats);
  c || (c = /* @__PURE__ */ new Map(), x3.set(i.mats, c)), c.has(l) || c.set(l, zA(i, e, o, r, a));
  let u = c.get(l), h = t.color;
  jg.includes(h) || (h = t.seed === void 0 ? n.def : jg[(s * 7 + 3) % jg.length]);
  let f = Zg(u.parts, /* @__PURE__ */ new Map([[Jt, i.mats.get("paint_" + h, { vertexColors: true })]])), p = Gi[e];
  return f.userData.color = h, f.userData.doors = r, qi(f, e, [p[0], p[1], p[2]], u.colliders.map((d) => ({ min: d.min.slice(), max: d.max.slice(), surface: d.surface })));
}
var ca = (i) => Gi[i].slice(0, 3), hn = Math.PI;
function S3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = $a(n + 11), o = n * 3.7, r = t.M("concrete", { vertexColors: true }), a = [[-0.3, 0], [0.3, 0], [0.3, 0.076], [0.127, 0.33], [0.1, 0.57], [0.077, 0.79], [0.06, 0.81], [-0.06, 0.81], [-0.077, 0.79], [-0.1, 0.57], [-0.127, 0.33], [-0.3, 0.076]], l = [-1.5, -1.47];
  for (let f = -1.25; f <= 1.26; f += 0.25) l.push(f);
  l.push(1.47, 1.5);
  let c = [];
  for (let f = 0; f < 7; f++) c.push([(s() * 2 - 1) * 1.5, s() * 0.8, 0.08 + s() * 0.14, s() < 0.5 ? 1 : -1]);
  let u = la(a, l, (f, p, d) => {
    let v = Math.abs(d) > 1.49 ? 1 : 0;
    return [d, p - v * 0.022 * (p / 0.81), f * (1 - v * 0.09)];
  }, { closed: true, caps: true });
  t.add(r, u, (f, p, d) => {
    let v = 0.86 + 0.2 * ri(f * 1.3 + o, p * 3 + d * 2) + 0.08 * ri(f * 7, p * 9 + o), g = [v, v * 0.99, v * 0.97];
    g = Ir(g, [v * 0.5, v * 0.48, v * 0.44], mn(0.3, 0, p) * 0.8);
    let x = mn(0.55, 0.8, ri(f * 4.5 + o, 3.3)) * mn(0.25, 0.8, p);
    g = Ir(g, [v * 0.62, v * 0.6, v * 0.56], x * 0.6);
    let y = mn(0.6, 0.85, ri(f * 2.1 + o * 2, d * 3)) * mn(0.2, 0.33, p) * mn(0.62, 0.4, p);
    g = Ir(g, [0.22, 0.22, 0.22], y * 0.65);
    for (let b of c) if (Math.sign(d || 1) === b[3]) {
      let m = Math.hypot(f - b[0], p - b[1]) / b[2];
      m < 1 && (g = Ir(g, [1.12, 1.1, 1.05], (1 - m) * 0.7));
    }
    return Math.abs(f) > 1.4 && (g = Ir(g, [1.08, 1.06, 1.02], 0.4 * ri(p * 9, d * 9 + o))), g;
  });
  let h = [0.05, 0.05, 0.05];
  for (let f of [-1, 1]) for (let p of [-0.85, 0.85]) t.add(r, je(cn(0.3, 0.058), p, 0.03, f * 0.3008, [0, f > 0 ? 0 : hn, 0]), h), t.box(r, 0.34, 0.012, 0.012, p, 0.064, f * 0.3, { r: 3e-3, col: [0.7, 0.7, 0.68] });
  for (let f of [-0.9, 0.9]) t.tube(t.M("steel_rust"), [[f - 0.05, 0.8, 0], [f - 0.04, 0.85, 0], [f + 0.04, 0.85, 0], [f + 0.05, 0.8, 0]], 8e-3, { seg: 5 });
  if (e.stripe) {
    let f = t.M("hazard_stripes");
    t.add(f, je(Nc(2.9, 0.118), 0, 0.8125, 0, [-hn / 2, 0, 0]));
    for (let p of [-1, 1]) t.add(f, je(Nc(2.9, 0.2), 0, 0.68, p * 0.0905, [p > 0 ? -0.108 : 0.108, p > 0 ? 0 : hn, 0]));
  }
  return qi(t.group(), "jersey_barrier", ca("jersey_barrier"), [{ min: [-1.5, 0, -0.3], max: [1.5, 0.33, 0.3], surface: "concrete" }, { min: [-1.5, 0.33, -0.13], max: [1.5, 0.81, 0.13], surface: "concrete" }]);
}
function w3(i, e, t, n, s, o, r, a, l) {
  i.push(_o(s, o, r, [0, a, 0])), i.push(_o(0, 0, 0, [0, 0, l])), i.box(t, 0.1, 0.34, 0.46, 0.09, 0, 0, { r: 0.014 }), i.add(n, je(cn(0.4, 0.28), 0.1415, 0, 0, [0, hn / 2, 0]), null, true), i.box(t, 0.012, 0.018, 0.47, 0.146, 0.156, 0, { r: 0 }), i.box(t, 0.012, 0.018, 0.47, 0.146, -0.156, 0, { r: 0 }), i.box(t, 0.012, 0.33, 0.018, 0.146, 0, 0.222, { r: 0 }), i.box(t, 0.012, 0.33, 0.018, 0.146, 0, -0.222, { r: 0 }), i.box(t, 0.09, 8e-3, 0.48, 0.17, 0.175, 0, { r: 0, rot: [0, 0, -0.12] });
  for (let c = -3; c <= 3; c++) i.add(t, je($e(0.045, 0.3, 8e-3), 0.02, 0, c * 0.062));
  i.pop(), i.box(e, 0.03, 0.05, 0.56, 0.02, -0.02, 0, { r: 4e-3 });
  for (let c of [-1, 1]) i.box(e, 0.1, 0.05, 0.012, 0.05, -0.02, c * 0.275, { r: 0, rot: [0, 0, l * 0.5] });
  i.pop();
}
function T3(i, e = {}) {
  let t = new jn(i), n = t.M("steel_galv"), s = t.M("concrete", { vertexColors: true }), o = t.M("steel_dark"), r = i.mats.emissive(16769981, e.on === false ? 0.02 : 8);
  t.box(s, 0.8, 0.32, 0.8, 0, 0.16, 0, { r: 0.03, col: (x, y, b) => {
    let m = 0.62 + 0.36 * mn(0, 0.3, y) + 0.1 * ri(x * 5, b * 5);
    return [m, m, m * 0.97];
  } }), t.box(n, 0.5, 0.03, 0.5, 0, 0.335, 0, { r: 6e-3 });
  for (let x = 0; x < 8; x++) {
    let y = (x + 0.5) * hn / 4, b = Math.cos(y) * 0.215, m = Math.sin(y) * 0.215;
    t.cyl(n, 0.014, 0.014, 0.1, b, 0.38, m, { seg: 6 }), t.cyl(n, 0.027, 0.027, 0.024, b, 0.362, m, { seg: 6, flat: true });
  }
  let a = 0.35, l = 13.3, c = 0.168, u = 0.07, h = (x) => c + (u - c) * (x - a) / (l - a), f = [[a, 4.75, 0], [4.6, 9.15, 7e-3], [9, l, 0.014]];
  for (let [x, y, b] of f) t.cyl(n, h(y) + b, h(x) + b, y - x, 0, (x + y) / 2, 0, { seg: 8, flat: true, open: true, rot: [0, hn / 8, 0] });
  for (let x = 0; x < 4; x++) {
    let y = x * hn / 2;
    t.box(n, 0.012, 0.2, 0.12, Math.cos(y) * 0.2, 0.45, -Math.sin(y) * 0.2, { r: 0, rot: [0, y + hn / 2, 0] });
  }
  t.cyl(n, 0.2, 0.2, 0.02, 0, 0.36, 0, { seg: 8, rot: [0, hn / 8, 0] }), t.cyl(n, 0.09, 0.09, 0.03, 0, l, 0, { seg: 8, rot: [0, hn / 8, 0] });
  let p = h(1.05) * 0.924;
  t.box(n, 0.13, 0.52, 0.012, 0, 1.05, p + 5e-3, { r: 4e-3 }), t.box(o, 0.03, 0.045, 0.012, 0.04, 1.05, p + 0.013, { r: 3e-3 }), t.decal(Jn(i, "hazard_voltage"), 0.09, -0.01, 1.2, p + 0.0125, null), t.tube(o, [[-0.3, 0.3, 0.28], [-0.3, 0.52, 0.28], [-0.24, 0.72, 0.2], [-0.1, 0.8, 0.1]], 0.024, { seg: 6 }), t.cyl(o, 0.034, 0.034, 0.03, -0.3, 0.335, 0.28, { seg: 8 }), t.bar(n, [0.1, 3, -0.13], [0.42, 3, -0.13], 0.012), t.bar(n, [0.1, 3, 0.13], [0.42, 3, 0.13], 0.012), t.bar(n, [0.42, 3, -0.16], [0.42, 3, 0.16], 0.012, { caps: true }), t.bar(n, [0.42, 3, -0.13], [0.42, 3.09, -0.13], 0.012, { caps: true }), t.bar(n, [0.42, 3, 0.13], [0.42, 3.09, 0.13], 0.012, { caps: true }), t.cyl(n, h(3) + 0.012, h(3) + 0.012, 0.05, 0, 3, 0, { seg: 8, rot: [0, hn / 8, 0] });
  let d = 0;
  for (let x = 3.45; x < 12.9; x += 0.38, d++) {
    let y = d % 2 ? 1 : -1;
    t.bar(n, [0, x, y * h(x) * 0.8], [0, x, y * (h(x) + 0.15)], 9e-3, { seg: 5, caps: true });
  }
  let v = l + 0.12;
  t.box(n, 0.1, 0.1, 1.9, 0, v, 0, { r: 0.012 }), t.box(n, 0.5, 0.07, 0.07, 0, v + 0.085, 0.55, { r: 0.01 }), t.box(n, 0.5, 0.07, 0.07, 0, v + 0.085, -0.55, { r: 0.01 }), t.beam(n, [0, l - 0.5, 0.08], [0, v - 0.03, 0.7], 0.04, 0.04), t.beam(n, [0, l - 0.5, -0.08], [0, v - 0.03, -0.7], 0.04, 0.04);
  for (let x of [-0.55, 0.55]) w3(t, n, o, r, 0.22, v - 0.14, x, 0, -0.62), w3(t, n, o, r, -0.22, v - 0.14, x, hn, -0.62);
  t.box(o, 0.16, 0.2, 0.12, 0, l - 0.25, -0.14, { r: 0.01 }), t.bar(n, [0, v, 0], [0, 14, 0], 0.012, { r2: 3e-3, seg: 5, caps: true });
  let g = t.group();
  g.userData.lamps = [];
  for (let x of [-0.55, 0.55]) for (let y of [-1, 1]) g.userData.lamps.push({ pos: [y * 0.34, v - 0.22, x], dir: [y * 0.81, -0.58, 0], color: 16769981 });
  return qi(g, "light_mast", ca("light_mast"), [{ min: [-0.4, 0, -0.4], max: [0.4, 0.32, 0.4], surface: "concrete" }, { min: [-0.17, 0.32, -0.17], max: [0.17, 14, 0.17], surface: "metal" }]);
}
function A3(i, e = {}) {
  let t = new jn(i), n = $a((e.seed | 0) + 5), s = t.M("steel_galv"), o = t.M("concrete", { vertexColors: true }), r = t.M("chainlink", { doubleSide: true }), a = e.posts || "both", l = e.lean === 1 ? 1 : -1, c = a === "both" ? [-1.5, 1.5] : a === "left" ? [-1.5] : a === "right" ? [1.5] : [];
  for (let p of c) {
    t.box(o, 0.32, 0.09, 0.32, p, 0.035, 0, { r: 0.02, col: (d, v) => {
      let g = 0.6 + 0.4 * mn(0, 0.08, v);
      return [g, g, g];
    } }), t.cyl(s, 0.03, 0.03, 2.02, p, 1.05, 0, { seg: 8, open: true }), t.cyl(s, 0.05, 0.05, 0.012, p, 0.086, 0, { seg: 8 }), t.bar(s, [p, 2.02, 0], [p, 2.4 - 0.02, l * 0.36], 0.019, { seg: 6, caps: true }), t.cyl(s, 0.034, 0.034, 0.05, p, 2.03, 0, { seg: 8 });
    for (let d of [0.2, 1.05, 1.9]) t.cyl(s, 0.034, 0.034, 0.03, p, d, 0, { seg: 8, open: true });
  }
  t.bar(s, [-1.5, 2, 0.036], [1.5, 2, 0.036], 0.021, { seg: 7 });
  for (let p of [0.09, 1.02]) t.bar(s, [-1.5, p, 0.012], [1.5, p, 0.012], 35e-4, { seg: 4 });
  t.box(s, 8e-3, 1.9, 0.02, -1.462, 1.03, 0.012, { r: 0 }), t.box(s, 8e-3, 1.9, 0.02, 1.462, 1.03, 0.012, { r: 0 });
  let u = new THREE.PlaneGeometry(2.92, 1.93, 6, 3), h = u.attributes.position, f = u.attributes.uv;
  for (let p = 0; p < h.count; p++) {
    let d = h.getX(p), v = h.getY(p);
    f.setXY(p, d + 1.5, v + 1), h.setZ(p, 0.012 + 0.02 * (ri(d * 1.3 + (e.seed | 0), v * 1.5) - 0.5) * (1 - Math.abs(d) / 1.46));
  }
  u.computeVertexNormals(), t.add(r, je(u, 0, 1.025, 0));
  for (let p = 0; p < 3; p++) {
    let d = 0.3 + p * 0.33, v = 2.02 + d * 0.36, g = l * d * 0.36;
    t.bar(s, [-1.5, v, g], [1.5, v, g], 32e-4, { seg: 4 });
    for (let x = -1.42 + p % 2 * 0.09; x < 1.45; x += 0.18) t.add(s, je($e(4e-3, 0.032, 4e-3), x, v, g, [n() * 3, 0, 0.8 + n()]));
  }
  for (let p = 0; p < 5; p++) t.add(s, je($e(0.012, 0.012, 0.03), -1.2 + p * 0.6, 2, 0.02));
  return qi(t.group(), "fence_panel", ca("fence_panel"), [{ min: [-1.5, 0, -0.04], max: [1.5, 2.4, 0.04], surface: "metal" }]);
}
function R3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = n * 1.3, o = 2.6, r = 2.2, a = o / 2, l = r / 2, c = t.M("paint_" + (["white", "grey", "teal"].includes(e.color) ? e.color : "white"), { vertexColors: true }), u = t.M("steel_dark"), h = t.M("steel_galv"), f = t.M("glass", { doubleSide: true }), p = t.M("wood_dark"), d = t.M("polymer_black"), v = (H, O, q) => {
    let U = (0.9 + 0.14 * ri(H * 2 + s, O * 2 + q)) * (0.6 + 0.4 * mn(0.1, 0.7, O)) * (1 - 0.25 * mn(2.25, 2.45, O));
    return [U, U * 0.985, U * 0.96];
  };
  t.defCol.set(c, v);
  let g = 0.12, x = 1, y = 2.08, b = 2.42;
  t.box(u, o, 0.12, r, 0, 0.06, 0, { r: 0.015 });
  for (let H of [-0.7, 0.7]) t.box(u, o + 0.06, 0.06, 0.1, 0, 0.03, H, { r: 0.01 });
  for (let H of [-1, 1]) for (let O of [-1, 1]) t.box(c, 0.09, b - g, 0.09, H * (a - 0.045), (b + g) / 2, O * (l - 0.045), { r: 0.012 });
  let m = 0.3, A = 1.12, _ = (H, O) => {
    let q = O > 0 ? [[-a + 0.09, m - 0.04]] : [[-a + 0.09, a - 0.09]];
    for (let [U, T] of q) {
      t.box(c, T - U, x - g, 0.05, (U + T) / 2, (x + g) / 2, H, { r: 6e-3 }), t.box(c, T - U, 0.05, 0.075, (U + T) / 2, x + 0.01, H + O * 5e-3, { r: 8e-3 }), t.box(f, T - U, y - x - 0.03, 8e-3, (U + T) / 2, (x + y) / 2 + 0.01, H, { r: 0 });
      let D = T - U > 1.6 ? 2 : 1;
      for (let C = 1; C <= D; C++) t.box(c, 0.04, y - x, 0.05, U + (T - U) * C / (D + 1), (x + y) / 2, H, { r: 6e-3 });
      for (let C = 1; C < 3; C++) t.box(c, 6e-3, x - g - 0.04, 0.056, U + (T - U) * C / 3, (x + g) / 2, H, { r: 0 });
    }
    t.box(c, o - 0.18, b - y, 0.05, 0, (b + y) / 2, H, { r: 6e-3 });
  };
  _(l - 0.03, 1), _(-l + 0.03, -1);
  for (let H of [-1, 1]) {
    let O = H * (a - 0.03);
    t.box(c, 0.05, x - g, r - 0.18, O, (x + g) / 2, 0, { r: 6e-3 }), t.box(c, 0.075, 0.05, r - 0.18, O + H * 5e-3, x + 0.01, 0, { r: 8e-3 }), t.box(f, 8e-3, y - x - 0.03, r - 0.18, O, (x + y) / 2 + 0.01, 0, { r: 0 }), t.box(c, 0.05, y - x, 0.04, O, (x + y) / 2, 0, { r: 6e-3 }), t.box(c, 0.05, b - y, r - 0.18, O, (b + y) / 2, 0, { r: 6e-3 });
  }
  let M = l - 0.03;
  t.box(c, 0.05, y - g, 0.07, m - 0.015, (y + g) / 2, M, { r: 6e-3 }), t.box(c, 0.05, y - g, 0.07, A + 0.015, (y + g) / 2, M, { r: 6e-3 }), t.box(c, a - 0.09 - A - 0.04, y - g, 0.05, (a - 0.09 + A + 0.04) / 2, (y + g) / 2, M, { r: 6e-3 });
  let E = A - m - 0.02, w = (m + A) / 2;
  t.box(c, E, x - g - 0.01, 0.04, w, (x + g) / 2, M + 5e-3, { r: 6e-3 }), t.box(c, E, 0.07, 0.04, w, y - 0.04, M + 5e-3, { r: 6e-3 });
  for (let H of [-1, 1]) t.box(c, 0.07, y - x, 0.04, w + H * (E / 2 - 0.035), (x + y) / 2, M + 5e-3, { r: 6e-3 });
  t.box(f, E - 0.12, y - x - 0.08, 8e-3, w, (x + y) / 2 - 0.02, M + 5e-3, { r: 0 }), t.box(h, E - 0.06, 0.22, 4e-3, w, g + 0.14, M + 0.027, { r: 0 }), t.box(h, 0.03, 0.14, 0.02, m + 0.09, 1.05, M + 0.035, { r: 4e-3 }), t.bar(h, [m + 0.09, 1, M + 0.06], [m + 0.2, 1, M + 0.06], 9e-3, { caps: true });
  for (let H of [0.4, 1.75]) t.cyl(h, 0.012, 0.012, 0.1, A + 2e-3, H, M + 0.03, { seg: 6 });
  t.box(u, 0.9, 0.03, 0.3, w, 0.105, l + 0.15, { r: 6e-3 }), t.box(c, o + 0.36, 0.1, r + 0.4, 0, b + 0.05, 0, { r: 0.02, col: (H, O, q) => {
    let U = 0.72 + 0.2 * ri(H * 1.5, q * 1.5 + s);
    return [U, U, U * 0.97];
  } }), t.box(u, o + 0.3, 0.03, r + 0.34, 0, b + 0.112, 0, { r: 0.01 });
  for (let H of [-1, 1]) t.box(h, o + 0.36, 0.06, 0.08, 0, b - 5e-3, H * (l + 0.2 + 0.03), { r: 0.012 });
  t.tube(h, [[-a - 0.16, b - 0.03, l + 0.23], [-a - 0.1, b - 0.2, l + 0.1], [-a - 0.03, b - 0.4, l + 0.03], [-a - 0.03, 0.2, l + 0.03], [-a - 0.1, 0.06, l + 0.1]], 0.03, { seg: 6, tension: 0.2 });
  let S = -a - 0.17;
  t.box(c, 0.3, 0.52, 0.78, S, 0.62, -0.25, { r: 0.02 }), t.add(c, je(pr(0.44, 0.44, 6), S - 0.151, 0.62, -0.14, [0, -hn / 2, 0]), [0.06, 0.06, 0.06]);
  for (let H = -3; H <= 3; H++) t.add(u, je($e(6e-3, 8e-3, Math.sqrt(0.22 * 0.22 - (H * 0.06) ** 2) * 2), S - 0.154, 0.62 + H * 0.06, -0.14));
  t.cyl(u, 0.05, 0.05, 0.012, S - 0.156, 0.62, -0.14, { seg: 8, rot: [0, 0, hn / 2] });
  for (let H of [-0.55, 0.05]) t.beam(u, [-a, 0.32, H], [S - 0.1, 0.34, H], 0.03, 0.03, { r: 0 });
  t.tube(t.M("rubber"), [[S + 0.05, 0.86, 0.14], [S + 0.06, 1, 0.2], [-a - 0.02, 1.25, 0.24], [-a - 0.02, 2.2, 0.24]], 0.014, { seg: 5 }), t.add(t.M("floor_epoxy"), je(Nc(o - 0.1, r - 0.1), 0, 0.122, 0, [-hn / 2, 0, 0])), t.box(p, 0.6, 0.04, r - 0.3, -a + 0.4, 0.76, 0, { r: 8e-3 });
  for (let H of [-0.85, 0.85]) t.box(u, 0.5, 0.64, 0.03, -a + 0.4, 0.44, H, { r: 5e-3 });
  t.box(d, 0.05, 0.32, 0.5, -a + 0.3, 1.02, -0.3, { r: 0.01, rot: [0, 0.25, 0] }), t.add(i.mats.emissive(9418984, 1.6), je(cn(0.45, 0.27), -a + 0.3 + 0.027, 1.02, -0.3 - 7e-3, [0, hn / 2 + 0.25, 0]), null, true), t.box(d, 0.05, 0.1, 0.06, -a + 0.28, 0.83, -0.3, { r: 8e-3 }), t.box(d, 0.18, 0.015, 0.22, -a + 0.28, 0.787, -0.3, { r: 4e-3 }), t.box(d, 0.14, 0.02, 0.42, -a + 0.52, 0.79, -0.25, { r: 4e-3 }), t.box(d, 0.46, 0.07, 0.46, -a + 1, 0.5, -0.2, { r: 0.02, rot: [0, 0.3, 0] }), t.box(d, 0.07, 0.55, 0.42, -a + 1.22, 0.86, -0.13, { r: 0.02, rot: [0, 0.3, -0.12] }), t.cyl(u, 0.025, 0.025, 0.36, -a + 1, 0.3, -0.2, { seg: 6 });
  for (let H = 0; H < 5; H++) {
    let O = H * hn * 0.4;
    t.beam(u, [-a + 1, 0.16, -0.2], [-a + 1 + Math.cos(O) * 0.26, 0.14, -0.2 + Math.sin(O) * 0.26], 0.03, 0.025, { r: 0 });
  }
  t.box(u, 0.2, 0.07, 0.1, w, y + 0.19, l + 0.03, { r: 0.012 }), t.add(i.mats.emissive(16767398, e.on === false ? 0.02 : 5), je(cn(0.17, 0.05), w, y + 0.152, l + 0.035, [hn / 2, 0, 0]), null, true), t.decal(Mi(i, "GATE CONTROL", { color: "black", font: "stencil", distress: 0.2 }), 0.1, -0.45, (b + y) / 2, l - 3e-3, null, 0.9), t.decal(Jn(i, "berth4"), 0.34, a - 3e-3, 0.56, 0.3, [0, hn / 2, 0]), t.decal(Jn(i, "no_entry"), 0.2, w, 0.72, M + 0.0265, null), t.decal(Jn(i, "grime_streak"), 0.7, -0.6, 0.55, l - 3e-3, null, 0.3), t.decal(Jn(i, "rust_run"), 0.6, -a + 3e-3 - 0, 0.6, 0.55, [0, -hn / 2, 0], 0.25);
  let z = t.group();
  return z.userData.lamps = [{ pos: [w, y + 0.14, l + 0.04], dir: [0, -1, 0.2], color: 16767398 }], qi(z, "guard_booth", ca("guard_booth"), [{ min: [-a, 0, -l], max: [a, 2.54, l], surface: "metal" }]);
}
function C3(i, e = {}) {
  let t = new jn(i), n = THREE.MathUtils.clamp(e.open || 0, 0, 1), s = t.M("paint_orange", { vertexColors: true }), o = t.M("paint_white"), r = t.M("paint_red"), a = t.M("steel_dark"), l = t.M("steel_galv"), c = t.M("paint_yellow"), u = -2.5 + 0.19, h = 0.92;
  t.box(t.M("concrete"), 0.5, 0.06, 0.46, u, 0.03, 0, { r: 0.015 }), t.box(s, 0.36, 1, 0.3, u, 0.56, 0, { r: 0.02, col: (y, b) => {
    let m = 0.6 + 0.4 * mn(0.05, 0.5, b);
    return [m, m, m];
  } }), t.box(a, 0.4, 0.04, 0.34, u, 1.075, 0, { r: 0.012 }), t.box(s, 0.3, 0.6, 0.012, u, 0.5, 0.151, { r: 4e-3, col: [0.9, 0.9, 0.9] }), t.cyl(l, 0.012, 0.012, 0.016, u + 0.1, 0.5, 0.16, { seg: 6, rot: [hn / 2, 0, 0] }), t.decal(Jn(i, "hazard_general"), 0.14, u, 0.9, 0.153, null), t.decal(Jn(i, "caution_stripes"), 0.08, u, 0.12, 0.153, null, 0.34), t.cyl(a, 0.03, 0.03, 0.05, u, 1.12, 0, { seg: 8 }), t.add(i.mats.emissive(16734750, 2.2), je(ot(0.026, 0.026, 0.045, 8), u, 1.165, 0), null, true), t.push(_o(u, h, 0, [0, 0, n * 1.48])), t.cyl(a, 0.075, 0.075, 0.36, 0, 0, 0, { seg: 10, rot: [hn / 2, 0, 0] });
  for (let y of [-1, 1]) t.box(a, 0.62, 0.11, 0.012, 0.05, 0, y * 0.175, { r: 4e-3 });
  t.box(a, 0.3, 0.16, 0.3, -0.33, -0.02, 0, { r: 0.02 });
  let f = 4.62, p = 0.12, d = 9, v = f / d;
  for (let y = 0; y < d; y++) t.box(y % 2 ? o : r, v + 1e-3, 0.1 - y * 3e-3, 0.05, p + v * (y + 0.5), 0, 0, { r: 8e-3 });
  t.box(a, 0.03, 0.11, 0.06, p + f + 0.012, 0, 0, { r: 8e-3 }), t.add(i.mats.emissive(16722450, 1.5), je($e(0.05, 0.03, 0.054), p + f - 0.5, 0.058, 0), null, true), t.pop();
  let g = 2.5 - 0.1;
  t.box(t.M("concrete"), 0.3, 0.05, 0.3, g, 0.025, 0, { r: 0.012 }), t.cyl(c, 0.04, 0.04, 0.8, g, 0.45, 0, { seg: 8 }), t.box(c, 0.14, 0.02, 0.16, g, 0.855, 0, { r: 5e-3 });
  for (let y of [-1, 1]) t.box(c, 0.14, 0.14, 0.014, g, 0.93, y * 0.073, { r: 4e-3 });
  t.cyl(l, 0.07, 0.07, 0.01, g, 0.055, 0, { seg: 8 });
  let x = [{ min: [u - 0.2, 0, -0.17], max: [u + 0.2, 1.1, 0.17], surface: "metal" }, { min: [g - 0.07, 0, -0.08], max: [g + 0.07, 1, 0.08], surface: "metal" }];
  return n < 0.5 && x.push({ min: [u, h - 0.07, -0.04], max: [g, h + 0.07, 0.04], surface: "metal" }), qi(t.group(), "gate_arm", ca("gate_arm"), x);
}
function P3(i, e = {}) {
  let t = new jn(i), n = (e.seed | 0) * 2.1, s = t.M("steel_dark", { vertexColors: true }), o = t.M("steel_rust"), r = (a, l, c) => {
    let u = mn(0.3, 0.4, l) * mn(0.47, 0.4, l), h = 0.75 + 0.4 * ri(a * 6 + n, c * 6 + l * 4) + u * 0.9;
    return [h, h * 0.97, h * 0.93];
  };
  t.defCol.set(s, r), t.cyl(s, 0.34, 0.35, 0.045, 0, 0.0225, 0, { seg: 20 }), t.cyl(o, 0.37, 0.37, 6e-3, 0, 3e-3, 0, { seg: 20 });
  for (let a = 0; a < 6; a++) {
    let l = a * hn / 3 + 0.3;
    t.cyl(o, 0.026, 0.026, 0.03, Math.cos(l) * 0.285, 0.058, Math.sin(l) * 0.285, { seg: 6, flat: true }), t.cyl(o, 0.013, 0.013, 0.022, Math.cos(l) * 0.285, 0.08, Math.sin(l) * 0.285, { seg: 6 });
  }
  t.add(s, g1([[0.25, 0.045], [0.21, 0.08], [0.165, 0.16], [0.145, 0.27], [0.15, 0.36], [0.17, 0.43], [0.19, 0.5], [0.17, 0.57], [0.1, 0.6], [0, 0.602]], 18)), t.cyl(s, 0.105, 0.115, 0.5, 0, 0.485, 0, { seg: 14, open: true, rot: [0, 0, hn / 2] });
  for (let a of [-1, 1]) {
    let l = mr(0.108, 14, 8);
    l.scale(0.55, 1, 1), t.add(s, je(l, a * 0.25, 0.485, 0)), t.cyl(s, 0.125, 0.125, 0.03, a * 0.235, 0.485, 0, { seg: 14, rot: [0, 0, hn / 2] });
  }
  return qi(t.group(), "bollard_mooring", ca("bollard_mooring"), [{ min: [-0.3, 0, -0.22], max: [0.3, 0.6, 0.22], surface: "metal" }]);
}
function I3(i, e = {}) {
  let t = new jn(i), n = (e.seed | 0) * 1.7, s = t.M("paint_yellow", { vertexColors: true }), o = t.M("steel_galv"), r = 0.083, a = (u) => u > 0.6 && u < 0.69 || u > 0.78 && u < 0.87, l = [0.012, 0.3, 0.6, 0.6001, 0.69, 0.6901, 0.78, 0.7801, 0.87, 0.8701, 0.955];
  for (let u = 0; u < l.length - 1; u++) {
    let h = l[u], f = l[u + 1];
    if (f - h < 1e-3) continue;
    let p = a((h + f) / 2);
    t.cyl(s, r, r, f - h, 0, (h + f) / 2, 0, { seg: 14, open: true, col: (d, v, g) => {
      if (p) return [0.05, 0.05, 0.05];
      let x = (0.55 + 0.45 * mn(0, 0.35, v)) * (0.9 + 0.2 * ri(d * 30 + n, v * 6 + g * 30));
      return [x, x * 0.97, x * 0.9];
    } });
  }
  let c = mr(r, 14, 5, hn * 2, 0, hn / 2);
  c.scale(1, 0.55, 1), t.add(s, je(c, 0, 0.955, 0), [0.95, 0.93, 0.88]), t.cyl(o, 0.085, 0.085, 0.012, 0, 6e-3, 0, { seg: 4, rot: [0, hn / 4, 0] }), t.box(o, 0.17, 0.012, 0.17, 0, 6e-3, 0, { r: 4e-3 });
  for (let u of [-1, 1]) for (let h of [-1, 1]) t.cyl(o, 0.011, 0.011, 0.012, u * 0.066, 0.017, h * 0.066, { seg: 6 });
  return t.cyl(s, r + 6e-3, r + 6e-3, 0.02, 0, 0.022, 0, { seg: 14, open: true, col: [0.5, 0.48, 0.42] }), qi(t.group(), "bollard_post", ca("bollard_post"), [{ min: [-0.085, 0, -0.085], max: [0.085, 1, 0.085], surface: "metal" }]);
}
var Jg = ["hazard_general", "no_entry", "hazard_voltage", "berth4", "arrow", "hazard_flammable"], E3 = ["AUTHORISED PERSONNEL ONLY", "NO PEDESTRIANS", "HI-VIS AND HELMET", "AUTOMATED VEHICLES", "KEEP CLEAR"];
function z3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = t.M("steel_galv"), o = t.M("aluminium"), r = t.M("paint_white"), a = t.M("paint_yellow"), l = Jg.includes(e.sign) ? e.sign : Jg[n % Jg.length];
  t.box(t.M("concrete"), 0.3, 0.07, 0.3, 0, 0.03, 0, { r: 0.015 }), t.box(s, 0.05, 2.38, 0.05, 0, 1.2, 0, { r: 6e-3 }), t.box(s, 0.058, 0.012, 0.058, 0, 2.395, 0, { r: 4e-3 }), t.box(s, 0.13, 0.012, 0.13, 0, 0.07, 0, { r: 3e-3 });
  let c = (n % 5 - 2) * 6e-3;
  t.push(_o(0, 0, 0, [0, 0, c])), t.box(o, 0.6, 0.6, 4e-3, 0, 2.02, 0.031, { r: 15e-4 }), t.box(l.startsWith("hazard") ? a : r, 0.58, 0.58, 2e-3, 0, 2.02, 0.034, { r: 8e-4 }), t.decal(Jn(i, l), 0.5, 0, 2.02, 0.0362, null, 0.5), t.box(o, 0.6, 0.22, 4e-3, 0, 1.56, 0.031, { r: 15e-4 }), t.box(r, 0.58, 0.2, 2e-3, 0, 1.56, 0.034, { r: 8e-4 }), t.decal(Mi(i, e.text || E3[n % E3.length], { color: "black", font: "sans", distress: 0.15 }), 0.07, 0, 1.56, 0.0362, null, 0.52);
  for (let u of [1.85, 2.2, 1.56]) t.box(s, 0.5, 0.03, 0.012, 0, u, 0.024, { r: 0 }), t.box(s, 0.09, 0.04, 0.07, 0, u, -2e-3, { r: 4e-3 });
  for (let [u, h] of [[-0.26, 2.28], [0.26, 2.28], [-0.26, 1.76], [0.26, 1.76]]) t.cyl(s, 8e-3, 8e-3, 4e-3, u, h, 0.0365, { seg: 6, rot: [hn / 2, 0, 0] });
  return t.pop(), qi(t.group(), "sign_post", ca("sign_post"), [{ min: [-0.03, 0, -0.03], max: [0.03, 2.4, 0.03], surface: "metal" }, { min: [-0.3, 1.44, 0.02], max: [0.3, 2.33, 0.04], surface: "metal", bulletOnly: true }]);
}
function D3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = $a(n + 3), o = t.M("paint_yellow"), r = t.M("steel_dark"), a = t.M("aluminium"), l = t.M("rubber"), c = i.mats.emissive(16773596, e.on === false ? 0.02 : 10);
  t.cyl(a, 0.021, 0.021, 1.1, 0, 0.75, 0, { seg: 8, open: true }), t.cyl(a, 0.016, 0.016, 0.9, 0, 1.6, 0, { seg: 8, open: true }), t.cyl(r, 0.03, 0.03, 0.06, 0, 1.3, 0, { seg: 8 }), t.bar(r, [0.03, 1.3, 0], [0.085, 1.3, 0], 8e-3, { caps: true }), t.box(r, 0.02, 0.03, 0.05, 0.09, 1.3, 0, { r: 5e-3 }), t.cyl(r, 0.032, 0.032, 0.07, 0, 0.82, 0, { seg: 8 }), t.cyl(r, 0.03, 0.03, 0.05, 0, 0.36, 0, { seg: 8 });
  for (let d = 0; d < 3; d++) {
    let v = d * hn * 2 / 3 + 0.5, g = Math.cos(v), x = Math.sin(v);
    t.bar(a, [g * 0.035, 0.82, x * 0.035], [g * 0.5, 0.025, x * 0.5], 0.013, { seg: 6 }), t.bar(a, [g * 0.03, 0.36, x * 0.03], [g * 0.3, 0.37, x * 0.3], 8e-3, { seg: 5 }), t.add(l, je(mr(0.028, 8, 5), g * 0.5, 0.02, x * 0.5));
  }
  t.box(r, 0.05, 0.04, 0.72, 0, 2.03, 0, { r: 8e-3 });
  for (let d of [-1, 1]) {
    t.push(_o(0.03, 2.03, d * 0.2, [0, d * -0.12, 0])), t.push(_o(0, 0, 0, [0, 0, -0.22])), t.box(o, 0.075, 0.24, 0.32, 0.06, 0.02, 0, { r: 0.012 }), t.add(c, je(cn(0.28, 0.2), 0.0985, 0.02, 0, [0, hn / 2, 0]), null, true), t.box(r, 0.012, 0.25, 0.012, 0.1, 0.02, 0.157, { r: 0 }), t.box(r, 0.012, 0.25, 0.012, 0.1, 0.02, -0.157, { r: 0 }), t.box(r, 0.012, 0.012, 0.33, 0.1, 0.143, 0, { r: 0 }), t.box(r, 0.012, 0.012, 0.33, 0.1, -0.103, 0, { r: 0 });
    for (let v = -3; v <= 3; v++) t.add(r, je($e(0.035, 0.2, 6e-3), 8e-3, 0.02, v * 0.043));
    t.tube(o, [[0.05, 0.14, -0.1], [0.05, 0.2, -0.06], [0.05, 0.2, 0.06], [0.05, 0.14, 0.1]], 8e-3, { seg: 5 }), t.pop(), t.pop();
  }
  let u = s() * hn * 2, h = Math.cos(u), f = Math.sin(u);
  t.tube(l, [[0, 2, 0.03], [-0.03, 1.7, 0.04], [0.035, 1.25, 0.02], [-0.03, 0.9, 0.03], [0.05, 0.5, 0.06], [0.12, 0.08, 0.1], [0.25, 0.012, 0.16], [0.3 + h * 0.3, 0.012, 0.2 + f * 0.3], [0.2 + h * 0.75 - f * 0.2, 0.012, 0.1 + f * 0.75 + h * 0.2], [h * 1.2, 0.012, f * 1.2]], 0.011, { seg: 5 }), t.box(o, 0.09, 0.05, 0.06, h * 1.24, 0.026, f * 1.24, { r: 0.01, rot: [0, -u, 0] });
  let p = t.group();
  return p.userData.lamps = [{ pos: [0.14, 2.03, 0], dir: [0.976, -0.218, 0], color: 16773596 }], qi(p, "floodlight_stand", ca("floodlight_stand"), [{ min: [-0.12, 0, -0.12], max: [0.12, 2.2, 0.12], surface: "metal" }]);
}
var b1 = (i) => Gi[i].slice(0, 3), wi = Math.PI;
function k3(i, e = {}) {
  let t = new jn(i), n = t.M("diamond_plate"), s = t.M("steel_dark"), o = t.M("paint_yellow"), r = t.M("steel_galv"), a = 12, l = 0.2, c = 0.2, u = -1.5, h = 0.5, f = u + a * c, p = [];
  for (let g = 0; g < a; g++) {
    let x = (g + 1) * l, y = u + g * c;
    t.box(n, 0.25, 0.03, 0.9, y + 0.125, x - 0.015, 0, { r: 5e-3 }), t.box(o, 0.035, 0.034, 0.9, y + 0.016, x - 0.015, 0, { r: 6e-3 });
    for (let b of [-1, 1]) t.box(s, 0.2, 0.05, 0.01, y + 0.13, x - 0.05, b * 0.452, { r: 0 });
    p.push({ min: [y, 0, -h], max: [y + c, x, h], surface: "metal" });
  }
  for (let g of [-1, 1]) {
    t.beam(s, [u + 0.07, 0.13, g * 0.465], [f + 0.04, 2.5, g * 0.465], 0.24, 0.014, { r: 4e-3 }), t.box(r, 0.3, 0.012, 0.12, u + 0.06, 6e-3, g * 0.465, { r: 0 });
    for (let x of [-0.08, 0.1]) t.cyl(r, 0.012, 0.012, 0.02, u + 0.06 + x, 0.02, g * 0.5, { seg: 6 });
  }
  let d = (a + 1) * l;
  t.box(n, 0.64, 0.035, 0.96, f + 0.3, d - 0.0175, 0, { r: 5e-3 }), t.box(o, 0.035, 0.038, 0.96, f + 0.016, d - 0.0175, 0, { r: 6e-3 });
  for (let g of [-1, 1]) t.box(s, 0.66, 0.16, 0.06, f + 0.3, d - 0.115, g * 0.47, { r: 8e-3 });
  t.box(s, 0.06, 0.16, 0.96, 1.47, d - 0.115, 0, { r: 8e-3 }), t.box(s, 0.06, 0.12, 0.9, f + 0.02, d - 0.1, 0, { r: 8e-3 });
  for (let g of [-1, 1]) t.box(s, 0.08, d - 0.19, 0.08, 1.44, (d - 0.19) / 2, g * 0.45, { r: 8e-3 }), t.box(r, 0.18, 0.012, 0.18, 1.44, 6e-3, g * 0.45, { r: 0 }), t.beam(s, [1.44, 1.5, g * 0.45], [f + 0.1, d - 0.2, g * 0.45], 0.05, 0.05, { r: 6e-3 });
  t.beam(s, [1.44, 0.15, -0.42], [1.44, 2.2, 0.42], 0.045, 8e-3, { r: 0 }), t.beam(s, [1.44, 0.15, 0.42], [1.44, 2.2, -0.42], 0.045, 8e-3, { r: 0 }), t.box(s, 0.06, 0.06, 0.82, 1.44, 1.2, 0, { r: 6e-3 }), p.push({ min: [f, d - 0.2, -h], max: [1.5, d, h], surface: "metal" });
  for (let g of [-1, 1]) p.push({ min: [1.4, 0, g * 0.45 - 0.04], max: [1.48, d - 0.2, g * 0.45 + 0.04], surface: "metal" });
  let v = (g) => (g - u) / c * l + l;
  for (let g of [-1, 1]) {
    let x = g * 0.485, y = [[u + 0.1, v(u + 0.1)], [u + 0.9, v(u + 0.9) - 0.1], [u + 1.7, v(u + 1.7) - 0.1], [f + 0.03, d], [1.47, d]];
    for (let [b, m] of y) t.bar(o, [b, m - 0.12, x], [b, m + 1, x], 0.019, { seg: 7 }), t.box(s, 0.07, 0.1, 0.012, b, m - 0.1, x - g * 0.012, { r: 0 });
    for (let b of [1, 0.52]) {
      let m = b === 1 ? 0.021 : 0.016;
      t.bar(o, [y[0][0], y[0][1] + b, x], [y[3][0], y[3][1] + b, x], m, { seg: 7 }), t.bar(o, [y[3][0], y[3][1] + b, x], [y[4][0], y[4][1] + b, x], m, { seg: 7 }), t.add(o, je(mr(m * 1.05, 7, 5), y[3][0], y[3][1] + b, x)), t.add(o, je(mr(m * 1.05, 7, 5), y[0][0], y[0][1] + b, x)), t.add(o, je(mr(m * 1.05, 7, 5), y[4][0], y[4][1] + b, x));
    }
    t.box(s, 0.6, 0.1, 8e-3, f + 0.3, d + 0.05, g * 0.476, { r: 0 }), p.push({ min: [f, d, x - 0.03], max: [1.5, d + 1.02, x + 0.03], surface: "metal" });
  }
  return qi(t.group(), "stairs_metal", b1("stairs_metal"), p);
}
function F3(i, e = {}) {
  let t = new jn(i), n = t.M("steel_dark"), s = t.M("paint_yellow"), o = t.M("steel_galv"), r = e.rails || "both", a = r === "both" ? [-1, 1] : r === "left" ? [-1] : r === "right" ? [1] : [], l = 0.05;
  for (let u = -0.51; u <= 0.511; u += 0.034) t.add(o, je($e(2.98, 0.03, 4e-3), 0, l - 0.015, u));
  for (let u = -1.45; u <= 1.451; u += 0.1) t.add(o, je($e(6e-3, 6e-3, 1.04), u, l - 4e-3, 0));
  for (let u of [-1, 1]) t.add(o, je($e(2.99, 0.032, 5e-3), 0, l - 0.016, u * 0.525)), t.add(o, je($e(5e-3, 0.032, 1.05), u * 1.493, l - 0.016, 0));
  for (let u of [-1, 1]) t.box(n, 3, 0.18, 0.06, 0, l - 0.09, u * 0.565, { r: 8e-3 });
  for (let u of [-1.45, -0.5, 0.5, 1.45]) t.box(n, 0.05, 0.1, 1.08, u, l - 0.085, 0, { r: 6e-3 });
  let c = [{ min: [-1.5, l - 0.08, -0.6], max: [1.5, l, 0.6], surface: "metal" }];
  for (let u of a) {
    let h = u * 0.565;
    t.box(n, 3, 0.1, 8e-3, 0, l + 0.05, u * 0.535, { r: 0 });
    for (let f of [-1.42, 0, 1.42]) t.box(s, 0.045, 1.07, 0.045, f, l + 0.52, h, { r: 6e-3 }), t.box(n, 0.09, 0.012, 0.09, f, l + 6e-3, h, { r: 0 });
    t.bar(s, [-1.5, l + 1.05, h], [1.5, l + 1.05, h], 0.021, { seg: 7, caps: true }), t.bar(s, [-1.5, l + 0.55, h], [1.5, l + 0.55, h], 0.016, { seg: 6, caps: true }), c.push({ min: [-1.5, l, h - 0.035], max: [1.5, l + 1.05, h + 0.035], surface: "metal" });
  }
  return qi(t.group(), "catwalk", b1("catwalk"), c);
}
function L3(i, e, t, n, s) {
  for (let o = -2; o <= 2; o++) i.add(e, je($e(0.14 + (o === 0 ? 0.02 : 0), 0.022, 1), t + o * 0.2525, n + 0.133, s));
  for (let o of [-1, 0, 1]) i.add(e, je($e(1.15, 0.022, 0.1), t, n + 0.111, s + o * 0.45));
  for (let o of [-1, 0, 1]) for (let r of [-1, 0, 1]) i.add(e, je($e(0.14, 0.078, 0.1), t + r * 0.505, n + 0.061, s + o * 0.45));
  for (let o of [-1, 0, 1]) i.add(e, je($e(1.15, 0.022, 0.1), t, n + 0.011, s + o * 0.45));
}
function DA(i, e, t, n, s, o, r) {
  L3(i, e.wood, n, s, o);
  let a = s + 0.144;
  if (t === "cartons") {
    let l = 2 + Math.floor(r() * 2), c = 0.36;
    for (let u = 0; u < l; u++) for (let h of [-1, 1]) for (let f of [-1, 1]) u === l - 1 && r() < 0.25 || (i.box(e.card, 0.53, c - 6e-3, 0.46, n + h * 0.272 + (r() - 0.5) * 0.02, a + c * (u + 0.5), o + f * 0.237 + (r() - 0.5) * 0.02, { r: 8e-3, rot: [0, (r() - 0.5) * 0.05, 0] }), i.add(e.tape, je($e(0.535, 2e-3, 0.05), n + h * 0.272, a + c * (u + 1) - 4e-3, o + f * 0.237)));
    for (let u of [-0.3, 0.3]) i.add(e.poly, je($e(0.016, l * c + 4e-3, 2e-3), n + u, a + l * c / 2, o + 0.475)), i.add(e.poly, je($e(0.016, l * c + 4e-3, 2e-3), n + u, a + l * c / 2, o - 0.475));
  } else if (t === "wrapped") {
    let l = 0.9 + r() * 0.25;
    i.box(e.card, 1.08, l, 0.92, n, a + l / 2, o, { r: 0.012 }), i.box(e.wrap, 1.1, l + 0.012, 0.94, n, a + l / 2 + 2e-3, o, { r: 0.03 });
    for (let c of [-1, 1]) for (let u of [-1, 1]) i.box(e.card, 0.05, l * 0.96, 0.05, n + c * 0.535, a + l / 2, o + u * 0.455, { r: 4e-3 });
    i.decal(Mi(i.G, "LOT " + (1e3 + Math.floor(r() * 8999)), { color: "black", font: "sans", distress: 0.1 }), 0.06, n + 0.2, a + l * 0.7, o + 0.474, null, 0.3);
  } else if (t === "drums") {
    for (let l of [-1, 1]) for (let c of [-1, 1]) {
      let u = n + l * 0.285, h = o + c * 0.24, f = r() < 0.3 ? e.drum2 : e.drum;
      i.cyl(f, 0.225, 0.225, 0.86, u, a + 0.43, h, { seg: 14, open: true });
      for (let p of [0.29, 0.58]) i.cyl(f, 0.233, 0.233, 0.022, u, a + p, h, { seg: 14, open: true });
      i.cyl(f, 0.232, 0.232, 0.02, u, a + 0.85, h, { seg: 14, open: true }), i.cyl(f, 0.232, 0.232, 0.02, u, a + 0.01, h, { seg: 14, open: true }), i.add(e.dark, je(pr(0.44, 0.44, 4), u, a + 0.845, h, [-wi / 2, 0, 0])), i.cyl(e.dark, 0.03, 0.03, 0.02, u + 0.13, a + 0.855, h, { seg: 6 });
    }
    i.add(e.poly, je($e(1.04, 0.03, 2e-3), n, a + 0.6, o + 0.468)), i.add(e.poly, je($e(1.04, 0.03, 2e-3), n, a + 0.6, o - 0.468));
  } else if (t === "pallets") {
    let l = 2 + Math.floor(r() * 4);
    for (let c = 0; c < l; c++) L3(i, e.wood, n + (r() - 0.5) * 0.04, a + c * 0.146, o + (r() - 0.5) * 0.04);
  }
}
function U3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = $a(n + 21), o = t.M("paint_blue", { vertexColors: true }), r = t.M("paint_orange"), a = t.M("steel_galv"), l = { wood: t.M("wood_pallet"), card: t.M("cardboard"), tape: t.M("polymer_tan"), poly: t.M("polymer_black"), wrap: t.M("glass_dirty"), drum: t.M("plastic_blue"), drum2: t.M("paint_red"), dark: t.M("steel_dark") }, c = 4.2, u = 1.305, h = 0.5, f = [0.04, 0.04, 0.05];
  for (let v of [-1, 1]) {
    for (let x of [-1, 1]) {
      t.box(o, 0.09, c, 0.07, v * u, c / 2, x * h, { r: 8e-3, col: (y, b) => {
        let m = 0.7 + 0.3 * mn(0, 0.5, b);
        return [m, m, m];
      } }), t.box(a, 0.14, 0.01, 0.12, v * u, 5e-3, x * h, { r: 0 });
      for (let y of [-0.05, 0.05]) t.cyl(a, 0.01, 0.01, 0.02, v * u + y, 0.016, x * h, { seg: 6 });
      for (let y = 0.12; y < c - 0.05; y += 0.1) for (let b of [-0.022, 0.022]) t.add(o, je(cn(0.014, 0.034), v * u + b, y, x * (h + 0.0356), [0, x > 0 ? 0 : wi, 0]), f);
    }
    let g = [0.2, 1.1, 2, 2.9, 3.8];
    for (let x = 0; x < g.length; x++) t.box(o, 0.03, 0.03, 2 * h - 0.07, v * u, g[x], 0, { r: 0 }), x < g.length - 1 && t.beam(o, [v * u, g[x], x % 2 ? h - 0.04 : -h + 0.04], [v * u, g[x + 1], x % 2 ? -h + 0.04 : h - 0.04], 0.03, 0.03, { r: 0 });
    t.box(t.M("paint_yellow"), 0.14, 0.4, 0.02, v * u, 0.2, h + 0.06, { r: 6e-3 });
  }
  let p = [1.45, 2.86];
  for (let v of p) {
    for (let g of [-1, 1]) {
      t.box(r, 2 * u - 0.09, 0.12, 0.05, 0, v, g * (h + 0.01), { r: 8e-3 });
      for (let x of [-1, 1]) t.box(r, 0.012, 0.2, 0.065, x * (u - 0.051), v - 0.02, g * (h + 5e-3), { r: 0 });
    }
    for (let g of [-0.85, 0, 0.85]) t.add(a, je($e(0.04, 0.025, 2 * h), g, v + 0.045, 0));
    for (let g = -0.45; g <= 0.451; g += 0.1) t.add(a, je($e(2 * u - 0.1, 5e-3, 5e-3), 0, v + 0.062, g));
    for (let g = -1.2; g <= 1.201; g += 0.2) t.add(a, je($e(5e-3, 5e-3, 2 * h + 0.04), g, v + 0.066, 0));
  }
  t.decal(Mi(i, "BAY " + String.fromCharCode(65 + n % 6) + "-" + (10 + n % 40), { color: "black", font: "sans", distress: 0.1 }), 0.07, 0, p[0], h + 0.0365, null, 0.34), t.decal(Mi(i, "MAX 2000 KG / LEVEL", { color: "black", font: "sans", distress: 0.1 }), 0.045, 0.6, p[1], h + 0.0365, null, 0.5);
  let d = ["cartons", "wrapped", "drums", "cartons", "wrapped", "pallets", "none"];
  return [0, p[0] + 0.068, p[1] + 0.068].forEach((v, g) => {
    for (let x of [-1, 1]) {
      let y = d[Math.floor(s() * d.length)];
      g === 2 && y === "drums" && (y = "wrapped"), y !== "none" && DA(t, l, y, x * 0.615 + (s() - 0.5) * 0.03, v, (s() - 0.5) * 0.05, s);
    }
  }), qi(t.group(), "shelf_rack", b1("shelf_rack"), [{ min: [-1.35, 0, -0.55], max: [1.35, 4.2, 0.55], surface: "metal" }]);
}
function N3(i, e = {}) {
  let t = new jn(i), n = e.seed | 0, s = n * 2.3, o = t.M("paint_white", { vertexColors: true }), r = t.M("steel_dark"), a = t.M("steel_galv"), l = t.M("paint_grey"), c = t.M("brass"), u = t.M("rubber"), h = t.M("aluminium"), f = (g, x, y) => {
    let b = (0.86 + 0.18 * ri(y * 2 + s, x * 2)) * (0.62 + 0.38 * mn(0, 0.6, x));
    return [b, b * 0.985, b * 0.955];
  };
  t.defCol.set(o, f);
  let p = [0.05, 0.05, 0.055];
  e.flip || t.push(_o(0, 0, 0, [0, wi, 0]));
  let d = 0.13;
  t.box(o, 0.38, 2.3, 2.3, -0.06, 1.15, 0, { r: 0.012 });
  for (let g of [-1, 1]) t.box(o, 0.12, 2.3, 0.09, 0.19, 1.15, g * 1.105, { r: 0.012 });
  t.box(o, 0.12, 0.09, 2.12, 0.19, 2.255, 0, { r: 0.012 }), t.box(o, 0.12, 0.1, 2.12, 0.19, 0.05, 0, { r: 0.012 }), t.box(o, 0.1, 0.06, 2.12, 0.18, 1.42, 0, { r: 0.01 }), t.box(o, 0.1, 0.06, 2.12, 0.18, 0.9, 0, { r: 0.01 });
  for (let g of [0.3, 0.9, 1.5, 2.1]) for (let x of [-1, 1]) t.cyl(a, 0.014, 0.014, 0.012, 0.255, g, x * 1.105, { seg: 6, rot: [0, 0, wi / 2] });
  for (let g of [-0.8, -0.3, 0.3, 0.8]) for (let x of [0.05, 2.255]) t.cyl(a, 0.014, 0.014, 0.012, 0.255, x, g, { seg: 6, rot: [0, 0, wi / 2] });
  for (let g of [-1, 1]) {
    let x = g * 0.53, y = 1.83;
    t.add(o, je(pr(0.66, 0.66, 6), d + 4e-3, y, x, [0, wi / 2, 0]), p), t.cyl(o, 0.335, 0.345, 0.1, d + 0.05, y, x, { seg: 20, open: true, rot: [0, 0, wi / 2] }), t.cyl(o, 0.36, 0.36, 0.014, d + 6e-3, y, x, { seg: 20, open: true, rot: [0, 0, wi / 2] });
    for (let b = 0; b < 3; b++) t.add(r, je($e(0.012, 0.6, 0.12), d + 0.04, y, x, [b * wi / 3 + g * 0.4, 0.5, 0]));
    t.cyl(r, 0.07, 0.07, 0.06, d + 0.05, y, x, { seg: 10, rot: [0, 0, wi / 2] });
    for (let b = 0; b < 8; b++) {
      let m = b * wi / 4;
      t.add(a, je($e(5e-3, 0.66, 5e-3), d + 0.098, y, x, [m, 0, 0]));
    }
    for (let b of [0.12, 0.22, 0.32]) t.cyl(a, b, b, 6e-3, d + 0.1, y, x, { seg: 20, open: true, rot: [0, 0, wi / 2] });
  }
  t.decal(Mi(i, "KELVAR  MARINE  REFRIGERATION", { color: "black", font: "sans", distress: 0.2 }), 0.05, 0.2505, 2.255, 0, [0, wi / 2, 0], 1.2);
  for (let g of [-1, 1]) {
    t.add(o, je(cn(0.98, 0.44), d + 4e-3, 1.16, g * 0.53, [0, wi / 2, 0]), p);
    for (let x = 0; x < 9; x++) t.box(o, 0.06, 6e-3, 0.98, d + 0.035, 0.965 + x * 0.049, g * 0.53, { r: 0, rot: [0, 0, -0.75] });
    t.box(o, 0.05, 0.46, 0.03, d + 0.03, 1.16, g * 0.53, { r: 5e-3 });
  }
  t.add(o, je(cn(1, 0.76), d + 4e-3, 0.49, -0.53, [0, wi / 2, 0]), p), t.cyl(r, 0.15, 0.15, 0.46, d + 0.1, 0.36, -0.58, { seg: 14, open: true, rot: [wi / 2, 0, 0] });
  for (let g of [-1, 1]) {
    let x = mr(0.15, 14, 6);
    x.scale(1, 1, 0.45), t.add(r, je(x, d + 0.1, 0.36, -0.58 + g * 0.23));
  }
  t.box(r, 0.26, 0.03, 0.5, d + 0.1, 0.19, -0.58, { r: 6e-3 }), t.cyl(h, 0.07, 0.07, 0.4, d + 0.07, 0.5, -0.17, { seg: 10 }), t.tube(c, [[d + 0.1, 0.5, -0.5], [d + 0.1, 0.68, -0.5], [d + 0.08, 0.78, -0.4], [d + 0.08, 0.8, -0.2], [d + 0.07, 0.72, -0.17]], 0.012, { seg: 6 }), t.tube(c, [[d + 0.12, 0.42, -0.36], [d + 0.14, 0.6, -0.33], [d + 0.1, 0.84, -0.34], [d + 0.06, 0.88, -0.6], [d + 0.03, 0.88, -0.9]], 9e-3, { seg: 6 }), t.tube(c, [[d + 0.1, 0.36, -0.82], [d + 0.1, 0.36, -0.93], [d + 0.06, 0.6, -0.96], [d + 0.04, 0.86, -0.96]], 0.012, { seg: 6 }), t.box(t.M("paint_red"), 0.04, 0.05, 0.05, d + 0.12, 0.6, -0.33, { r: 8e-3 });
  let v = 0.55;
  t.box(l, 0.11, 0.56, 0.74, d + 0.055, 0.5, v, { r: 0.012 }), t.box(l, 0.012, 0.5, 0.68, d + 0.114, 0.5, v, { r: 4e-3 }), t.add(r, je(cn(0.26, 0.11), d + 0.1215, 0.66, v - 0.1, [0, wi / 2, 0])), t.add(i.mats.emissive(16757850, 2.4), je(cn(0.15, 0.05), d + 0.122, 0.665, v - 0.06, [0, wi / 2, 0]), null, true), t.add(i.mats.emissive(5832570, 3), je(cn(0.014, 0.014), d + 0.122, 0.66, v - 0.2, [0, wi / 2, 0]), null, true);
  for (let g = 0; g < 4; g++) for (let x = 0; x < 2; x++) t.box(r, 8e-3, 0.03, 0.03, d + 0.122, 0.5 - x * 0.045, v - 0.04 - g * 0.045, { r: 3e-3 });
  return t.box(t.M("paint_red"), 0.03, 0.09, 0.03, d + 0.13, 0.42, v + 0.22, { r: 6e-3 }), t.cyl(a, 0.012, 0.012, 0.1, d + 0.124, 0.5, v + 0.325, { seg: 6 }), t.decal(Jn(i, "hazard_voltage"), 0.11, d + 0.1215, 0.64, v + 0.2, [0, wi / 2, 0]), t.tube(u, [[d + 0.06, 0.78, v + 0.2], [d + 0.06, 0.95, v + 0.25], [d + 0.05, 1.4, v + 0.5], [d + 0.05, 1.5, v - 0]], 0.012, { seg: 5 }), t.tube(u, [[d + 0.06, 0.78, v - 0.2], [d + 0.06, 0.92, v - 0.3], [d + 0.05, 0.93, -0.1]], 0.01, { seg: 5 }), t.cyl(a, 0.022, 0.022, 0.04, d + 0.06, 0.2, v + 0.2, { seg: 8 }), t.tube(u, [[d + 0.06, 0.2, v + 0.2], [d + 0.08, 0.12, v + 0.1], [d + 0.1, 0.16, v - 0.15], [d + 0.1, 0.2, v - 0.3], [d + 0.1, 0.13, v - 0.36], [d + 0.09, 0.12, v - 0.1], [d + 0.09, 0.14, v + 0.05]], 0.016, { seg: 6 }), t.box(t.M("paint_blue"), 0.07, 0.07, 0.12, d + 0.09, 0.14, v + 0.1, { r: 0.015 }), t.decal(Jn(i, "grime_streak"), 0.8, 0.2512, 0.5, -1.105, [0, wi / 2, 0], 0.08), e.flip || t.pop(), qi(t.group(), "reefer_unit", b1("reefer_unit"), [{ min: [-0.25, 0, -1.15], max: [0.25, 2.3, 1.15], surface: "metal" }]);
}
var es = Math.PI, Kg = new THREE.Color(16752680), LA = new THREE.Color(16721940), kA = new THREE.Color(16767392);
function B3(i, e = {}) {
  let t = e.seed | 0, n = t * 1.9, s = e.id || e.label || "ABC"[t % 3], o = new jn(i), r = new jn(i), a = new jn(i), l = new jn(i), c = o.M("paint_grey", { vertexColors: true }), u = o.M("steel_dark"), h = o.M("steel_galv"), f = o.M("aluminium"), p = o.M("rubber"), d = o.M("concrete", { vertexColors: true }), v = (le, R, I) => {
    let se = (0.88 + 0.2 * ri(le * 3 + n, R * 3 + I * 2)) * (0.6 + 0.4 * mn(0.16, 0.7, R));
    return [se, se, se * 0.98];
  };
  o.defCol.set(c, v), r.defCol.set(c, (le, R, I) => {
    let se = 0.9 + 0.14 * ri(le * 4 + n, R * 3);
    return [se, se, se];
  });
  let g = [0.035, 0.035, 0.04], x = { em: true };
  o.box(d, 1.36, 0.16, 0.96, 0, 0.08, 0, { r: 0.025, col: (le, R, I) => {
    let se = 0.6 + 0.38 * mn(0, 0.15, R) + 0.1 * ri(le * 5, I * 5);
    return [se, se, se * 0.97];
  } }), o.decal(Jn(i, "caution_stripes"), 0.1, 0, 0.085, 0.4815, null, 1.2);
  for (let le of [-1, 1]) for (let R of [-1, 1]) o.cyl(h, 0.016, 0.016, 0.03, le * 0.44, 0.185, R * 0.36, { seg: 6 }), o.box(h, 0.1, 0.012, 0.1, le * 0.44, 0.166, R * 0.36, { r: 0 });
  let y = -0.5, b = 0.5, m = 0.18, A = 1.62, _ = -0.3, M = 0.3, E = 0.025, w = (m + A) / 2, S = A - m;
  o.box(c, 1, S, E, 0, w, _ + E / 2, { r: 6e-3 });
  for (let le of [-1, 1]) o.box(c, E, S, 0.6, le * (0.5 - E / 2), w, 0, { r: 6e-3 });
  o.box(c, 1, E, 0.6, 0, m + E / 2, 0, { r: 6e-3 }), o.box(c, 1, E, 0.6, 0, A - E / 2, 0, { r: 6e-3 }), o.box(c, E, S, 0.58, 0, w, 0, { r: 4e-3 }), o.box(c, 1, 0.12, E, 0, A - 0.06, M - E / 2, { r: 6e-3 }), o.box(c, 1, 0.07, E, 0, m + 0.035, M - E / 2, { r: 6e-3 }), o.box(u, 1.04, 0.04, 0.64, 0, m - 0.01, 0, { r: 8e-3 }), o.box(c, 1.12, 0.05, 0.74, 0, A + 0.025, 0.01, { r: 0.012 });
  for (let le of [-1, 1]) o.tube(h, [[le * 0.4 - 0.04, A + 0.05, 0.2], [le * 0.4 - 0.03, A + 0.1, 0.2], [le * 0.4 + 0.03, A + 0.1, 0.2], [le * 0.4 + 0.04, A + 0.05, 0.2]], 8e-3, { seg: 5 });
  let z = (le, R, I) => [0.16, 0.16, 0.17];
  o.add(c, je(cn(0.45, S - 0.06), -0.25, w, _ + E + 2e-3), z), o.add(c, je(cn(0.55, S - 0.06), y + E + 2e-3, w, 0, [0, es / 2, 0]), z), o.add(c, je(cn(0.55, S - 0.06), -E / 2 - 2e-3, w, 0, [0, -es / 2, 0]), z);
  for (let le = 0; le < 5; le++) {
    let R = 0.42 + le * 0.22;
    o.box(u, 0.42, 0.17, 0.4, -0.25, R, -0.05, { r: 8e-3 }), o.box(f, 0.4, 0.02, 0.012, -0.25, R + 0.06, 0.152, { r: 0 });
    for (let I = 0; I < 4; I++) a.add(x, je(cn(0.012, 0.012), -0.41 + I * 0.035, R - 0.04, 0.1512));
    for (let I = 0; I < 3; I++) o.add(u, je(pr(0.03, 0.022, 2), -0.2 + I * 0.06, R - 0.03, 0.1512), g);
  }
  let H = [p, p, p];
  for (let le = 0; le < 4; le++) o.tube(H[le % 3], [[-0.2 + le % 3 * 0.06, 0.39 + le * 0.22, 0.15], [-0.14 + le % 3 * 0.05, 0.36 + le * 0.22, 0.24], [-0.07, 0.55 + le * 0.22, 0.22], [-0.2 + (le + 1) % 3 * 0.06, 0.61 + le * 0.22, 0.15]], 7e-3, { seg: 5 });
  let O = 0.474, q = 1.3, U = 0.9, T = (le, R, I) => {
    let se = R + O / 2, ae = 0;
    le.box(c, O, q, 0.024, se, U, ae, { r: 6e-3 }), le.box(c, O - 0.07, q - 0.07, 6e-3, se, U, ae + 0.013, { r: 3e-3 });
    for (let ve of [U + 0.36, U - 0.4]) {
      le.add(c, je(cn(O - 0.14, 0.3), se, ve, ae + 0.0165), g);
      for (let _e = 0; _e < 7; _e++) le.box(c, O - 0.13, 0.034, 5e-3, se, ve - 0.125 + _e * 0.042, ae + 0.027, { r: 0, rot: [0.75, 0, 0] });
      le.box(c, 0.02, 0.31, 0.02, se - (O - 0.13) / 2, ve, ae + 0.022, { r: 3e-3 }), le.box(c, 0.02, 0.31, 0.02, se + (O - 0.13) / 2, ve, ae + 0.022, { r: 3e-3 });
    }
    let k = I ? R + 0.07 : R + O - 0.07;
    le.box(u, 0.045, 0.2, 0.02, k, U - 0.02, ae + 0.026, { r: 6e-3 }), le.box(h, 0.028, 0.13, 0.018, k, U + 0, ae + 0.042, { r: 6e-3 }), le.cyl(h, 0.012, 0.012, 0.012, k, U - 0.09, ae + 0.04, { seg: 8, rot: [es / 2, 0, 0] });
    let ce = I ? R + O : R;
    for (let ve of [U - 0.5, U, U + 0.5]) le.cyl(h, 0.011, 0.011, 0.09, ce, ve, ae + 0.016, { seg: 6 });
  };
  o.push(_o(0, 0, M - 4e-3)), T(o, 0.013, true), o.decal(Mi(i, "RELAY " + s, { color: "yellow", font: "stencil", distress: 0.15 }), 0.12, 0.013 + O / 2, U + 0.02, 0.018, null, O - 0.1), o.decal(Mi(i, "HARBORMASTER UPLINK", { color: "white", font: "sans", distress: 0.15 }), 0.034, 0.013 + O / 2, U - 0.1, 0.018, null, O - 0.1), o.decal(Jn(i, "hazard_voltage"), 0.13, 0.013 + O / 2 + 0.1, U + 0.14, 0.018, null), o.pop();
  let D = [-0.487, 0, M - 4e-3];
  T(r, 0, false), r.decal(Jn(i, "hazard_general"), 0.13, O / 2, U + 0.1, 0.018, null), r.box(c, O - 0.1, 0.03, 0.014, O / 2, U + 0.55, -0.018, { r: 3e-3 }), r.box(c, O - 0.1, 0.03, 0.014, O / 2, U - 0.55, -0.018, { r: 3e-3 }), r.box(c, 0.03, 1.1, 0.014, 0.07, U, -0.018, { r: 3e-3 }), r.box(c, 0.03, 1.1, 0.014, O - 0.07, U, -0.018, { r: 3e-3 }), r.box(u, 0.24, 0.3, 0.02, O / 2, U - 0.05, -0.02, { r: 4e-3 }), r.add(Mi(i, "WIRING DIAGRAM  SLT-R4", { color: "white", font: "sans", distress: 0.1 }).material, je(cn(0.2, 0.03), O / 2, U + 0.03, -0.0305, [0, es, 0]), null, true);
  for (let le of [U + 0.36, U - 0.4]) r.add(c, je(cn(O - 0.14, 0.3), O / 2, le, -0.0125, [0, es, 0]), g);
  r.decal(Mi(i, "ISOLATE BEFORE SERVICE", { color: "white", font: "sans", distress: 0.15 }), 0.03, O / 2, U - 0.03, 0.018, null, O - 0.1);
  for (let le of [-1, 1]) {
    o.box(f, 0.012, 0.98, 0.5, le * 0.506, 1.06, 0, { r: 3e-3 });
    for (let R = -6; R <= 6; R++) o.add(f, je($e(0.06, 0.94, 7e-3), le * 0.54, 1.06, R * 0.038));
    o.box(c, 0.075, 0.03, 0.52, le * 0.54, 1.56, 0, { r: 6e-3 });
  }
  for (let le = 0; le < 3; le++) {
    let R = -0.17 + le * 0.17, I = 0.44 - le * 0.02, se = 0.86 + le * 0.07;
    o.tube(p, [[0.5, I, R], [0.6, I, R], [0.72 + le * 0.04, I - 0.06, R], [se - 0.02, 0.16, R + 0.02], [se, -0.03, R + 0.02]], 0.04, { seg: 8, tension: 0.4 }), o.cyl(h, 0.055, 0.055, 0.05, 0.515, I, R, { seg: 8, flat: true, rot: [0, 0, es / 2] }), o.cyl(h, 0.06, 0.066, 0.03, se, 0.015, R + 0.02, { seg: 8 });
  }
  o.tube(p, [[-0.3, 0.35, _], [-0.3, 0.33, _ - 0.1], [-0.34, 0.2, _ - 0.2], [-0.5, 0.165, _ - 0.3], [-0.9, 0.02, _ - 0.36], [-1.5, 0.018, _ - 0.2]], 0.022, { seg: 6 }), o.box(u, 0.3, 0.22, 0.1, 0.2, 0.75, _ - 0.05, { r: 0.012 }), o.tube(p, [[0.2, 0.86, _ - 0.06], [0.2, 1.2, _ - 0.04], [-0.1, 1.55, _ - 0.03], [-0.3, 1.66, -0.16]], 0.012, { seg: 5 });
  let C = -0.3, G = -0.14, j = A + 0.05, N = 2.5, Q = [0, 1, 2].map((le) => [C + Math.cos(le * 2.094 + 0.52) * 0.085, G + Math.sin(le * 2.094 + 0.52) * 0.085]);
  o.box(h, 0.24, 0.012, 0.24, C, j + 6e-3, G, { r: 0 });
  for (let le = 0; le < 3; le++) {
    let R = Q[le], I = Q[(le + 1) % 3];
    o.bar(h, [R[0], j, R[1]], [R[0], N, R[1]], 0.011, { seg: 6 });
    let se = 5, ae = (N - j) / se;
    for (let k = 0; k < se; k++) o.bar(h, [R[0], j + k * ae, R[1]], [I[0], j + (k + 1) * ae, I[1]], 5e-3, { seg: 4 }), o.bar(h, [R[0], j + (k + 1) * ae, R[1]], [I[0], j + (k + 1) * ae, I[1]], 5e-3, { seg: 4 });
  }
  o.cyl(h, 0.11, 0.11, 0.014, C, N + 7e-3, G, { seg: 10 }), o.cyl(u, 0.05, 0.06, 0.1, C, N + 0.06, G, { seg: 10 });
  let K = (le, R, I) => {
    o.cyl(u, 0.016, 0.02, 0.07, le, A + 0.085, R, { seg: 8 }), o.cyl(h, 0.011, 0.011, 0.06, le, A + 0.15, R, { seg: 6 }), o.bar(u, [le, A + 0.17, R], [le + 0.02, I, R - 0.015], 5e-3, { r2: 18e-4, seg: 5, caps: true });
  };
  K(0.4, -0.24, 3.15), K(0.26, -0.24, 2.72), o.cyl(u, 0.03, 0.03, 0.26, 0.42, A + 0.18, 0.18, { seg: 8 }), o.add(u, je(mr(0.03, 8, 4, es * 2, 0, es / 2), 0.42, A + 0.31, 0.18));
  let ie = g1([[0, 0], [0.06, 6e-3], [0.12, 0.024], [0.18, 0.054], [0.215, 0.078], [0.222, 0.078], [0.185, 0.05], [0.12, 0.016], [0.06, -3e-3], [0, -0.01]], 18);
  ie.computeVertexNormals(), l.add(f, je(ie, 0, 0.3, 0.02, [es / 2 - 0.12, 0, 0])), l.cyl(f, 0.022, 0.03, 0.2, 0, 0.1, 0, { seg: 8 }), l.box(f, 0.07, 0.1, 0.06, 0, 0.26, -0.02, { r: 0.01 });
  for (let le of [0.5, 2.6, 4.7]) l.bar(f, [Math.cos(le) * 0.2, 0.3 + Math.sin(le) * 0.2, 0.09], [0, 0.325, 0.25], 45e-4, { seg: 4 });
  l.cyl(f, 0.022, 0.016, 0.05, 0, 0.325, 0.25, { seg: 8, rot: [es / 2, 0, 0] });
  let F = [C, N + 0.11, G];
  o.box(u, 0.9, 0.07, 0.03, 0, A - 0.06, M + 0.012, { r: 8e-3 }), a.add(x, je(cn(0.84, 0.036), 0, A - 0.06, M + 0.0275));
  for (let le = 1; le < 6; le++) o.add(u, je($e(8e-3, 0.05, 6e-3), -0.42 + le * 0.14, A - 0.06, M + 0.028));
  o.box(u, 0.6, 0.06, 0.03, 0, A - 0.06, _ - 0.012, { r: 8e-3 }), a.add(x, je(cn(0.54, 0.03), 0, A - 0.06, _ - 0.0275, [0, es, 0]));
  for (let le of [-1, 1]) o.box(u, 0.03, 1.2, 0.03, le * 0.5, 0.86, M, { r: 8e-3, rot: [0, es / 4, 0] }), a.add(x, je(cn(0.014, 1.14), le * 0.5, 0.86, M + 0.0215, [0, le * es / 4, 0]).translate(le * 0.0152, 0, 0)), a.add(x, je(cn(0.014, 0.9), le * 0.5715, 1.06, 0.262, [0, le * es / 2, 0]));
  for (let le of [-1, 1]) o.box(u, 0.03, 0.06, 0.46, le * 0.587, A - 0.01, 0, { r: 8e-3 }), a.add(x, je(cn(0.4, 0.032), le * 0.6025, A - 0.01, 0, [0, le * es / 2, 0]));
  o.cyl(u, 0.028, 0.028, 0.02, C + 0.2, A + 0.06, G, { seg: 8 }), o.bar(h, [C + 0.2, A + 0.06, G], [C + 0.2, 2.64, G], 9e-3, { seg: 6 }), a.add(x, je(ot(0.045, 0.045, 0.1, 10), C + 0.2, 2.69, G)), o.cyl(u, 0.05, 0.05, 0.014, C + 0.2, 2.747, G, { seg: 10 }), o.cyl(u, 0.05, 0.05, 0.014, C + 0.2, 2.633, G, { seg: 10 }), o.decal(Jn(i, "rust_run"), 0.5, 0.5135, 0.3, 0.2, [0, es / 2, 0], 0.14), o.decal(Jn(i, "grime_streak"), 0.6, -0.2, 1.2, _ - 1e-3, [0, es, 0], 0.2);
  let X = o.group(), ne = new THREE.Group();
  ne.userData.noMerge = true, ne.name = "relay_dynamic", X.add(ne);
  let re = i.mats.emissive(16752680, 4);
  re = re.clone();
  let $ = new THREE.Mesh(Ii(a.buckets.get(x).geos), re);
  $.userData.noMerge = true, ne.add($);
  let ue = r.group().children.slice();
  for (let le of ue) le.position.set(D[0], D[1], D[2]), le.userData.noMerge = true, ne.add(le);
  let me = l.group().children.slice();
  for (let le of me) le.position.set(F[0], F[1], F[2]), le.userData.noMerge = true, ne.add(le);
  let ee = new THREE.Color(), B = (le, R) => {
    if (re.userData && typeof re.userData.setEmissive == "function") {
      re.userData.setEmissive(le, R);
      return;
    }
    re.emissive && re.emissive.isColor && re.isMeshStandardMaterial ? (re.emissive.copy(le), re.emissiveIntensity = R) : re.uniforms && re.uniforms.color && re.uniforms.color.value && re.uniforms.color.value.isColor ? (re.uniforms.color.value.copy(le).multiplyScalar(R), re.uniforms.intensity && (re.uniforms.intensity.value = 1)) : re.color && re.color.isColor && re.color.copy(le).multiplyScalar(R);
  }, P = "live", V = t % 7 * 0.9, Y = 0, L = 0.7, Z = 0, J = 0, oe = 0, fe = X.userData;
  if (fe.state = P, fe.beacon = [C + 0.2, 2.68, G], fe.interact = [0, 1, 0.75], fe.emissiveMaterial = re, fe.level = 0, fe.setState = (le) => {
    le !== "live" && le !== "cutting" && le !== "cut" || le !== P && (P = le, fe.state = le, le === "cut" && (Y = 0, oe = 1.32, J = 2.5), le === "live" && (oe = 0));
  }, fe.update = (le) => {
    le = Math.min(le || 0, 0.1), V += le;
    let R = 0, I = Kg, se = 0.7;
    if (P === "live") R = 5.5 + 3 * Math.sin(V * 2.2);
    else if (P === "cutting") {
      let ae = Math.sin(V * 2 * es * 5.5) > 0;
      R = ae ? 9 : 0.5, I = ae ? kA : Kg, se = 2.6 + Math.sin(V * 9) * 1.5;
    } else if (Y += le, I = LA, se = 0, Y < 0.3) R = 9;
    else if (Y < 2.6) {
      let ae = 1 - (Y - 0.3) / 2.3;
      R = 7 * ae * ae * (Math.sin(Y * 37) * Math.sin(Y * 13.3) > -0.2 ? 1 : 0.08);
    } else R = 0;
    if (fe.level = R, B(ee.copy(I), R), L += (se - L) * Math.min(1, le * (P === "cut" ? 1.6 : 3)), Math.abs(L) > 1e-3) for (let ae of me) ae.rotateY(L * le);
    if (Math.abs(oe - Z) > 1e-4 || Math.abs(J) > 1e-3) {
      J += (-(Z - oe) * 30 - J * 3.2) * le;
      let ae = Z + J * le;
      ae < 0 && (ae = 0, J = Math.abs(J) * 0.3), ae > 1.9 && (ae = 1.9, J = -Math.abs(J) * 0.4);
      let k = ae - Z;
      Z = ae;
      for (let ce of ue) ce.rotateY(-k);
    }
  }, e.state === "cut") {
    fe.setState("cut");
    for (let le = 0; le < 80; le++) fe.update(0.05);
  } else e.state === "cutting" && fe.setState("cutting"), fe.update(0), P === "live" && B(ee.copy(Kg), 6);
  return qi(X, "relay_node", Gi.relay_node.slice(0, 3), [{ min: [-0.68, 0, -0.48], max: [0.68, 0.16, 0.48], surface: "concrete" }, { min: [-0.57, 0.16, -0.32], max: [0.57, 1.67, 0.33], surface: "metal" }, { min: [-0.42, 1.67, -0.26], max: [-0.18, 2.5, -0.02], surface: "metal", bulletOnly: true }]);
}
var At = Math.PI, tt = Math.PI / 2, zi = (i, e, t) => Math.min(t, Math.max(e, i));
function Za(i, e, t) {
  let n = Math.imul(i, 374761393) ^ Math.imul(e, 668265263) ^ Math.imul(t, 2147483647);
  return n = Math.imul(n ^ n >>> 13, 1274126177), ((n ^ n >>> 16) >>> 0) / 4294967296;
}
function gn(i, e = 0, t = 0) {
  let n = Math.floor(i), s = Math.floor(e), o = Math.floor(t), r = i - n, a = e - s, l = t - o;
  r = r * r * (3 - 2 * r), a = a * a * (3 - 2 * a), l = l * l * (3 - 2 * l);
  let c = (u, h, f) => u + (h - u) * f;
  return c(c(c(Za(n, s, o), Za(n + 1, s, o), r), c(Za(n, s + 1, o), Za(n + 1, s + 1, o), r), a), c(c(Za(n, s, o + 1), Za(n + 1, s, o + 1), r), c(Za(n, s + 1, o + 1), Za(n + 1, s + 1, o + 1), r), a), l);
}
function Mf(i, e, t, n) {
  let s = new THREE.BufferGeometry();
  return s.setAttribute("position", new THREE.BufferAttribute(new Float32Array(i), 3)), e && s.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(e), 3)), s.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(t), 2)), n && s.setIndex(n), e || s.computeVertexNormals(), s;
}
function us(i, e = 16) {
  let t = i.length, n = [], s = [], o = [], r = [], a = [], l = [], c = [], u = 0, h = 0;
  for (let f = 0; f < t; f++) {
    let p = 0, d = 0;
    if (f > 0) {
      let g = i[f][0] - i[f - 1][0], x = i[f][1] - i[f - 1][1], y = Math.hypot(g, x);
      y > 1e-6 && (p += g / y, d += x / y, h += y);
    }
    if (f < t - 1) {
      let g = i[f + 1][0] - i[f][0], x = i[f + 1][1] - i[f][1], y = Math.hypot(g, x);
      y > 1e-6 && (p += g / y, d += x / y);
    }
    let v = Math.hypot(p, d) || 1;
    a.push(d / v), l.push(-p / v), c.push(h), u = Math.max(u, i[f][0]);
  }
  for (let f = 0; f < t; f++) for (let p = 0; p <= e; p++) {
    let d = p / e * At * 2, v = Math.cos(d), g = Math.sin(d);
    n.push(i[f][0] * v, i[f][1], i[f][0] * g), s.push(a[f] * v, l[f], a[f] * g), o.push(p / e * At * 2 * u, c[f]);
  }
  for (let f = 0; f < t - 1; f++) if (!(Math.hypot(i[f + 1][0] - i[f][0], i[f + 1][1] - i[f][1]) < 1e-6)) for (let p = 0; p < e; p++) {
    let d = f * (e + 1) + p, v = d + e + 1, g = v + 1, x = d + 1;
    i[f][0] > 1e-6 && r.push(d, v, x), i[f + 1][0] > 1e-6 && r.push(v, g, x);
  }
  return Mf(n, s, o, r);
}
function Ge(i, e, t, n = 8e-3, s = "center") {
  let o = [i / 2, e / 2, t / 2];
  n = Math.min(n, o[0] * 0.9, o[1] * 0.9, o[2] * 0.9);
  let r = [], a = [], l = [], c = [];
  for (let p = 0; p < 8; p++) for (let d = 0; d < 3; d++) {
    let v = [p & 1 ? 1 : -1, p & 2 ? 1 : -1, p & 4 ? 1 : -1], g = [0, 1, 2].map((x) => v[x] * (o[x] - (x !== d ? n : 0)));
    r.push(g[0], g[1], g[2]), a.push(d === 0 ? v[0] : 0, d === 1 ? v[1] : 0, d === 2 ? v[2] : 0), d === 0 ? l.push(g[2], g[1]) : d === 1 ? l.push(g[0], g[2]) : l.push(g[0], g[1]);
  }
  let u = (p, d) => p * 3 + d, h = (p, d, v, g, x, y) => {
    let b = r[d * 3] - r[p * 3], m = r[d * 3 + 1] - r[p * 3 + 1], A = r[d * 3 + 2] - r[p * 3 + 2], _ = r[v * 3] - r[p * 3], M = r[v * 3 + 1] - r[p * 3 + 1], E = r[v * 3 + 2] - r[p * 3 + 2];
    (m * E - A * M) * g + (A * _ - b * E) * x + (b * M - m * _) * y >= 0 ? c.push(p, d, v) : c.push(p, v, d);
  };
  for (let p = 0; p < 3; p++) {
    let d = (p + 1) % 3, v = (p + 2) % 3;
    for (let g of [0, 1]) {
      let x = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([b, m]) => g << p | b << d | m << v), y = [0, 0, 0];
      y[p] = g ? 1 : -1, h(u(x[0], p), u(x[1], p), u(x[2], p), ...y), h(u(x[0], p), u(x[2], p), u(x[3], p), ...y);
    }
    for (let g of [0, 1]) for (let x of [0, 1]) {
      let y = g << d | x << v, b = y | 1 << p, m = [0, 0, 0];
      m[d] = g ? 1 : -1, m[v] = x ? 1 : -1, h(u(y, d), u(b, d), u(b, v), ...m), h(u(y, d), u(b, v), u(y, v), ...m);
    }
  }
  for (let p = 0; p < 8; p++) h(u(p, 0), u(p, 1), u(p, 2), p & 1 ? 1 : -1, p & 2 ? 1 : -1, p & 4 ? 1 : -1);
  let f = Mf(r, a, l, c);
  return s === "bottom" && f.translate(0, e / 2, 0), f;
}
function eo(i, e, t, n = 0.03, s = 3, o = 3, r = 3, a = "center") {
  let l = new THREE.BoxGeometry(i, e, t, s, o, r), c = l.attributes.position, u = l.attributes.normal, h = l.attributes.uv, f = i / 2, p = e / 2, d = t / 2;
  n = Math.min(n, f * 0.95, p * 0.95, d * 0.95);
  let v = (x, y, b) => {
    if (Math.abs(x) > y - 1e-6 || b < 3) return x;
    let m = 2 * y / b;
    return x * (y - n) / (y - m);
  }, g = new THREE.Vector3();
  for (let x = 0; x < c.count; x++) {
    let y = v(c.getX(x), f, s), b = v(c.getY(x), p, o), m = v(c.getZ(x), d, r), A = zi(y, -(f - n), f - n), _ = zi(b, -(p - n), p - n), M = zi(m, -(d - n), d - n);
    g.set(y - A, b - _, m - M), (Math.abs(y) > f - 1e-5 ? 1 : 0) + (Math.abs(b) > p - 1e-5 ? 1 : 0) + (Math.abs(m) > d - 1e-5 ? 1 : 0) >= 2 && g.lengthSq() > 1e-12 && (g.normalize(), y = A + g.x * n, b = _ + g.y * n, m = M + g.z * n, u.setXYZ(x, g.x, g.y, g.z)), c.setXYZ(x, y, b, m);
    let w = Math.abs(u.getX(x)), S = Math.abs(u.getY(x)), z = Math.abs(u.getZ(x));
    w >= S && w >= z ? h.setXY(x, m, b) : S >= w && S >= z ? h.setXY(x, y, m) : h.setXY(x, y, b);
  }
  return a === "bottom" && l.translate(0, e / 2, 0), l;
}
function to(i, e) {
  let t = i.attributes.position, n = new THREE.Vector3();
  for (let s = 0; s < t.count; s++) n.fromBufferAttribute(t, s), e(n, s), t.setXYZ(s, n.x, n.y, n.z);
  return i;
}
function gr(i) {
  let e = i.attributes.position, t = i.index, n = e.count, s = /* @__PURE__ */ new Map(), o = (f) => Math.round(e.getX(f) * 2e3) + "," + Math.round(e.getY(f) * 2e3) + "," + Math.round(e.getZ(f) * 2e3), r = new Array(n);
  for (let f = 0; f < n; f++) r[f] = o(f);
  let a = new THREE.Vector3(), l = new THREE.Vector3(), c = new THREE.Vector3(), u = t ? t.count : n;
  for (let f = 0; f < u; f += 3) {
    let p = t ? t.getX(f) : f, d = t ? t.getX(f + 1) : f + 1, v = t ? t.getX(f + 2) : f + 2;
    a.fromBufferAttribute(e, p), l.fromBufferAttribute(e, d), c.fromBufferAttribute(e, v), l.sub(a), c.sub(a), l.cross(c);
    for (let g of [p, d, v]) {
      let x = s.get(r[g]);
      x || (x = [0, 0, 0], s.set(r[g], x)), x[0] += l.x, x[1] += l.y, x[2] += l.z;
    }
  }
  let h = new Float32Array(n * 3);
  for (let f = 0; f < n; f++) {
    let p = s.get(r[f]) || [0, 1, 0], d = Math.hypot(p[0], p[1], p[2]) || 1;
    h[f * 3] = p[0] / d, h[f * 3 + 1] = p[1] / d, h[f * 3 + 2] = p[2] / d;
  }
  return i.setAttribute("normal", new THREE.BufferAttribute(h, 3)), i;
}
function M1(i) {
  if (i.index) {
    let t = i.index.array;
    for (let n = 0; n < t.length; n += 3) {
      let s = t[n + 1];
      t[n + 1] = t[n + 2], t[n + 2] = s;
    }
  } else for (let t of Object.keys(i.attributes)) {
    let n = i.attributes[t], s = n.itemSize, o = n.array;
    for (let r = 0; r < n.count; r += 3) for (let a = 0; a < s; a++) {
      let l = o[(r + 1) * s + a];
      o[(r + 1) * s + a] = o[(r + 2) * s + a], o[(r + 2) * s + a] = l;
    }
  }
  let e = i.attributes.normal.array;
  for (let t = 0; t < e.length; t++) e[t] = -e[t];
  return i;
}
function ev(i, e) {
  let t = i.groups[e];
  if (!t) return i;
  let n = Array.from(i.index.array);
  n.splice(t.start, t.count), i.setIndex(n);
  for (let s of i.groups) s.start > t.start && (s.start -= t.count);
  return t.count = 0, i;
}
var O3 = new THREE.Quaternion(), FA = new THREE.Vector3(0, 1, 0), _1 = new THREE.Vector3(), H3 = new THREE.Matrix4();
function vn(i, e, t = 0.02, n = 6, s = false, o = t) {
  _1.set(e[0] - i[0], e[1] - i[1], e[2] - i[2]);
  let r = _1.length();
  _1.normalize();
  let a = ot(o, t, r, n, !s);
  return O3.setFromUnitVectors(FA, _1), H3.compose(new THREE.Vector3((i[0] + e[0]) / 2, (i[1] + e[1]) / 2, (i[2] + e[2]) / 2), O3, new THREE.Vector3(1, 1, 1)), a.applyMatrix4(H3), a;
}
function Mo(i, e, { soft: t = 0.6, caps: n = true } = {}) {
  let s = i.length, o = [], r = [], a = [], l = [], c = e / 2, u = [], h = 0, f = [0];
  for (let d = 0; d < s; d++) {
    let v = i[d], g = i[(d + 1) % s], x = g[0] - v[0], y = g[1] - v[1], b = Math.hypot(x, y) || 1;
    u.push([y / b, -x / b]), h += b, f.push(h);
  }
  let p = (d, v) => {
    let g = u[d], x = u[(v + s) % s];
    if (g[0] * x[0] + g[1] * x[1] > Math.cos(t)) {
      let y = g[0] + x[0], b = g[1] + x[1], m = Math.hypot(y, b) || 1;
      return [y / m, b / m];
    }
    return g;
  };
  for (let d = 0; d < s; d++) {
    let v = i[d], g = i[(d + 1) % s], x = p(d, d - 1), y = p(d, d + 1), b = o.length / 3;
    o.push(v[0], v[1], c, v[0], v[1], -c, g[0], g[1], -c, g[0], g[1], c), r.push(x[0], x[1], 0, x[0], x[1], 0, y[0], y[1], 0, y[0], y[1], 0), a.push(f[d], c, f[d], -c, f[d + 1], -c, f[d + 1], c), l.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  if (n) {
    let d = THREE.ShapeUtils.triangulateShape(i.map((v) => new THREE.Vector2(v[0], v[1])), []);
    for (let v of [1, -1]) {
      let g = o.length / 3;
      for (let x of i) o.push(x[0], x[1], v * c), r.push(0, 0, v), a.push(x[0], x[1]);
      for (let x of d) v > 0 ? l.push(g + x[0], g + x[1], g + x[2]) : l.push(g + x[0], g + x[2], g + x[1]);
    }
  }
  return Mf(o, r, a, l);
}
function vr(i, e, t = true) {
  let n = i.length, s = [], o = [], r = [], a = 0, l = Math.hypot(e[0], e[1], e[2]) * 2;
  for (let p = 0; p < n; p++) p && (a += Math.hypot(i[p][0] - i[p - 1][0], i[p][1] - i[p - 1][1], i[p][2] - i[p - 1][2])), s.push(i[p][0] - e[0], i[p][1] - e[1], i[p][2] - e[2], i[p][0] + e[0], i[p][1] + e[1], i[p][2] + e[2]), o.push(a, 0, a, l);
  for (let p = 0; p < n - 1; p++) {
    let d = p * 2;
    r.push(d, d + 1, d + 3, d, d + 3, d + 2);
  }
  let c = Mf(s, null, o, r);
  if (!t) return c;
  let u = c.clone(), h = u.index.array;
  for (let p = 0; p < h.length; p += 3) {
    let d = h[p + 1];
    h[p + 1] = h[p + 2], h[p + 2] = d;
  }
  let f = u.attributes.normal.array;
  for (let p = 0; p < f.length; p++) f[p] = -f[p];
  return Ii([c, u]);
}
function _f(i, e) {
  return new THREE.PlaneGeometry(i, e);
}
function UA(i, e, t, n = 4) {
  let s = [], o = [], r = [], a = [];
  for (let l = 0; l <= n; l++) {
    let c = (l / n - 0.5) * e / i, u = Math.sin(c), h = Math.cos(c);
    s.push(i * u, -t / 2, i * h, i * u, t / 2, i * h), o.push(u, 0, h, u, 0, h), r.push(l / n, 0, l / n, 1);
  }
  for (let l = 0; l < n; l++) {
    let c = l * 2;
    a.push(c, c + 2, c + 3, c, c + 3, c + 1);
  }
  return Mf(s, o, r, a);
}
function ja(i, e, t = 6, n = 12, s = At * 2) {
  let o = new THREE.TorusGeometry(i, e, t, n, s), r = o.attributes.uv;
  for (let a = 0; a < r.count; a++) r.setXY(a, r.getX(a) * s * i, r.getY(a) * 2 * At * e);
  return o;
}
function Y3(i, e = 8, t = 6) {
  let n = new THREE.SphereGeometry(i, e, t), s = n.attributes.uv;
  for (let o = 0; o < s.count; o++) s.setXY(o, s.getX(o) * 2 * At * i, s.getY(o) * At * i);
  return n;
}
function NA(i, e) {
  let t = i.attributes.position.count, n = i.attributes.color;
  if (n || (n = new THREE.BufferAttribute(new Float32Array(t * 3).fill(1), 3), i.setAttribute("color", n)), e === 1 || e == null) return i;
  let s = n.array;
  if (typeof e == "function") {
    let l = i.attributes.position;
    for (let c = 0; c < t; c++) {
      let u = e(l.getX(c), l.getY(c), l.getZ(c));
      typeof u == "number" ? (s[c * 3] *= u, s[c * 3 + 1] *= u, s[c * 3 + 2] *= u) : (s[c * 3] *= u[0], s[c * 3 + 1] *= u[1], s[c * 3 + 2] *= u[2]);
    }
    return i;
  }
  let o = typeof e == "number" ? e : e[0], r = typeof e == "number" ? e : e[1], a = typeof e == "number" ? e : e[2];
  for (let l = 0; l < t; l++) s[l * 3] *= o, s[l * 3 + 1] *= r, s[l * 3 + 2] *= a;
  return i;
}
var V3 = { red: ["paint_red", 1], blue: ["paint_blue", 1], green: ["paint_green", 1], yellow: ["paint_yellow", 1], orange: ["paint_orange", 1], white: ["paint_white", 1], grey: ["paint_grey", 1], teal: ["paint_teal", 1], rust: ["steel_rust", 1], black: ["paint_grey", [0.2, 0.2, 0.22]], olive: ["paint_green", [0.75, 0.8, 0.45]] };
function Ja(i, e = "blue") {
  return V3[i] || V3[e];
}
var pI = new THREE.Matrix4(), W3 = new THREE.Quaternion(), G3 = new THREE.Euler(), q3 = new THREE.Vector3(), Qg = new THREE.Vector3();
function BA({ p: i = [0, 0, 0], r: e = [0, 0, 0], s: t = 1 } = {}) {
  return G3.set(e[0], e[1], e[2]), W3.setFromEuler(G3), q3.set(i[0], i[1], i[2]), typeof t == "number" ? Qg.set(t, t, t) : Qg.set(t[0], t[1], t[2]), new THREE.Matrix4().compose(q3, W3, Qg);
}
var Kn = class {
  constructor(e, t, n = 1) {
    this.G = e, this.name = t, this.seed = Math.abs(n | 0), this.rng = il((this.seed + 1) * 7919 + t.length * 131), this.b = /* @__PURE__ */ new Map(), this.stack = [new THREE.Matrix4()];
  }
  push(e) {
    return this.stack.push(this.stack[this.stack.length - 1].clone().multiply(BA(e))), this;
  }
  pop() {
    return this.stack.pop(), this;
  }
  mat(e, t) {
    return this.G.mats.get(e, { vertexColors: true, ...t || {} });
  }
  add(e, t, n, s = 1, { raw: o = false, cast: r = true } = {}) {
    let a = typeof e == "string" ? this.mat(e) : e;
    n && Dc(t, n), t.applyMatrix4(this.stack[this.stack.length - 1]), o || NA(t, s);
    let l = a.uuid + (r ? "c" : "n"), c = this.b.get(l);
    return c || (c = { mat: a, geos: [], raw: o, cast: r }, this.b.set(l, c)), c.geos.push(t), this;
  }
  decal(e, t, n, s) {
    return this.add(e.material, _f(t, s || t / (e.aspect || 1)), n, 1, { raw: true, cast: false });
  }
  label(e, t, n, s, o) {
    let r = this.G.mats.label(e, t), a = Math.min(n, s * (r.aspect || 1));
    return this.add(r.material, _f(a, a / (r.aspect || 1)), o, 1, { raw: true, cast: false });
  }
  cdecal(e, t, n, s, o) {
    return this.add(e.material, UA(t, n, o || n / (e.aspect || 1)), s, 1, { raw: true, cast: false });
  }
  finish({ size: e, colliders: t, grime: n = 1, surface: s } = {}) {
    let o = new THREE.Group(), r = this.seed * 3.71;
    for (let c of this.b.values()) {
      let u = Ii(c.geos);
      if (!c.raw && n > 0 && u.attributes.color) {
        let f = u.attributes.position, p = u.attributes.normal, d = u.attributes.color.array;
        for (let v = 0; v < f.count; v++) {
          let g = f.getX(v), x = f.getY(v), y = f.getZ(v), b = p.getY(v), m = gn(g * 1.9 + r, x * 1.9, y * 1.9 + 5.3), A = gn(g * 9 + 2.1, x * 9 + r, y * 9), _ = (0.82 + 0.18 * m) * (0.92 + 0.08 * A) * (0.76 + 0.24 * zi(b * 0.6 + 0.62, 0, 1)), M = zi(1 - x / 0.2, 0, 1);
          _ *= 1 - 0.42 * M * M * (0.55 + 0.45 * A), _ = 1 + (_ - 1) * n, d[v * 3] *= _, d[v * 3 + 1] *= _ * (1 - 0.05 * M * n), d[v * 3 + 2] *= _ * (1 - 0.12 * M * n);
        }
      }
      let h = new THREE.Mesh(u, c.mat);
      h.castShadow = c.cast, h.receiveShadow = true, o.add(h);
    }
    let a = Gi[this.name] || [1, 1, 1, "", "metal"], l = e || [a[0], a[1], a[2]];
    return o.userData.size = l, o.userData.colliders = t || [{ min: [-l[0] / 2, 0, -l[2] / 2], max: [l[0] / 2, l[1], l[2] / 2], surface: s || a[4] }], o;
  }
};
var X3 = /* @__PURE__ */ new WeakMap();
function wf(ctx, key, buildFn) {
  let map = X3.get(ctx.mats);
  if (!map) {
    map = /* @__PURE__ */ new Map();
    X3.set(ctx.mats, map);
  }
  let proto = map.get(key);
  if (!proto) {
    proto = buildFn();
    map.set(key, proto);
  }
  return proto.clone(true);
}
var j3 = (i, e, t) => {
  let n = zi((t - i) / (e - i), 0, 1);
  return n * n * (3 - 2 * n);
};
function $3(i, e, t = 0, n = 0) {
  let s = new THREE.PlaneGeometry(i, e), o = s.attributes.uv, r = s.attributes.position;
  for (let a = 0; a < o.count; a++) o.setXY(a, r.getX(a) + t, r.getY(a) + n);
  return s;
}
var w1 = { pz: [0, 0, 0], nz: [0, At, 0], px: [0, tt, 0], nx: [0, -tt, 0] };
function OA(i) {
  let t = [[0, 0.016], [0.262, 0.016], [0.262, 0.016], [0.268, 2e-3], [0.288, 0], [0.295, 8e-3], [0.295, 0.022], [0.284, 0.034]];
  for (let n of [0.305, 0.595]) t.push([0.283, n - 0.03], [0.291, n - 0.018], [0.297, n], [0.291, n + 0.018], [0.283, n + 0.03]);
  return t.push([0.284, 0.866], [0.295, 0.878], [0.295, 0.892], [0.288, 0.9], [0.268, 0.898]), i ? t.push([0.268, 0.898], [0.272, 0.888], [0.272, 0.03], [0.272, 0.03], [0, 0.03]) : t.push([0.262, 0.884], [0.262, 0.884], [0, 0.884]), t;
}
function HA(i, e, t) {
  let n = new Kn(i, "barrel", t), s = n.rng, o = 22, [r, a] = Ja(e.color, "blue");
  e.lying && n.push({ p: [-0.45, 0.297, 0], r: [0, 0, -tt] });
  let l = us(OA(!!e.open), o), c = [];
  for (let d = 0; d < 2 + t % 2; d++) c.push([s() * At * 2, s.range(0.12, 0.78), s.range(0.07, 0.13), s.range(6e-3, 0.014)]);
  to(l, (d) => {
    let v = Math.hypot(d.x, d.z);
    if (v < 0.27) return;
    let g = Math.atan2(d.z, d.x);
    for (let x of c) {
      let y = Math.abs(g - x[0]) % (At * 2);
      y > At && (y = At * 2 - y);
      let b = Math.hypot(y * 0.285, d.y - x[1]);
      if (b < x[2]) {
        let m = 1 - x[3] * (0.5 + 0.5 * Math.cos(At * b / x[2])) / v;
        d.x *= m, d.z *= m;
      }
    }
  }), l.computeVertexNormals();
  let u = l.attributes.normal, h = l.attributes.position.count / (o + 1);
  for (let d = 0; d < h; d++) {
    let v = d * (o + 1), g = v + o, x = u.getX(v) + u.getX(g), y = u.getY(v) + u.getY(g), b = u.getZ(v) + u.getZ(g), m = Math.hypot(x, y, b) || 1;
    u.setXYZ(v, x / m, y / m, b / m), u.setXYZ(g, x / m, y / m, b / m);
  }
  let f = t * 2.37, p = e.color === "rust";
  return n.add(r, l, null, (d, v, g) => {
    let x = Math.hypot(d, g), y = Math.atan2(g, d);
    if (x < 0.27) {
      let w = v > 0.5 ? 0.62 + 0.3 * gn(d * 9 + f, g * 9) : 0.6;
      return [w, w, w];
    }
    let b = Math.pow(gn(y * 2.6 + f, 3.1), 2.2), m = v > 0.6 ? (0.88 - v) / 0.28 : v > 0.31 ? (0.6 - v) / 0.29 : (0.31 - v) / 0.31, A = 1 - 0.55 * b * (1 - 0.6 * zi(m, 0, 1)), M = (x > 0.289 ? 1 : 0) * (0.35 + 0.65 * gn(y * 7 + f, v * 20)), E = [A * (1 - 0.25 * M), A * (1 - 0.42 * M), A * (1 - 0.55 * M)];
    return typeof a != "number" && (E[0] *= a[0], E[1] *= a[1], E[2] *= a[2]), E;
  }), e.open || (n.add("steel_galv", ot(0.036, 0.038, 0.016, 8), { p: [0.17, 0.891, 0.02] }, 0.8), n.add("steel_galv", ot(0.017, 0.018, 0.014, 8), { p: [-0.16, 0.89, -0.08] }, 0.8)), !p && t % 3 !== 2 && n.cdecal(i.mats.decal("hazard_flammable"), 0.2855, 0.15, { p: [0, 0.455, 0], r: [0, 0.9 + t, 0] }), t % 2 === 0 && n.cdecal(i.mats.label("UN 1202", { color: p || e.color === "white" || e.color === "yellow" ? "black" : "white", font: "stencil", distress: 0.5 }), 0.2855, 0.2, { p: [0, 0.74, 0], r: [0, 2.6 + t, 0] }), n.finish(e.lying ? { size: [0.9, 0.6, 0.6] } : {});
}
function S1(i, e, { broken: t = false, stamp: n = true, bevel: s = false } = {}) {
  let o = s ? (u, h, f) => Ge(u, h, f, 4e-3) : (u, h, f) => $e(u, h, f), r = () => {
    let u = e.range(0.62, 1), h = e.range(0.9, 1);
    return [u, u * (0.93 + 0.07 * h), u * (0.82 + 0.18 * h)];
  }, a = (u = 3e-3) => e.range(-u, u);
  for (let [u, h] of [[-0.45, 0.1], [0, 0.145], [0.45, 0.1]]) i.add("wood_pallet", o(1.2, 0.022, h), { p: [a(), 0.011, u + a()], r: [0, a(6e-3), 0] }, r());
  let l = (u, h, f = 0.012) => [[-u / 2 + f, -h / 2], [u / 2 - f, -h / 2], [u / 2, -h / 2 + f], [u / 2, h / 2 - f], [u / 2 - f, h / 2], [-u / 2 + f, h / 2], [-u / 2, h / 2 - f], [-u / 2, -h / 2 + f]];
  for (let u of [-0.5275, 0, 0.5275]) for (let h of [-0.45, 0, 0.45]) i.add("wood_pallet", Mo(l(0.145, h === 0 ? 0.145 : 0.1), 0.078, { caps: false, soft: 0 }), { p: [u + a(), 0.061, h + a()], r: [-tt, a(0.03), 0] }, r().map((f) => f * 0.8));
  for (let u of [-0.5275, 0, 0.5275]) i.add("wood_pallet", o(0.145, 0.022, 1), { p: [u + a(), 0.111, a()], r: [0, a(6e-3), 0] }, r());
  if ([[-0.4275, 0.145], [-0.215, 0.1], [0, 0.145], [0.215, 0.1], [0.4275, 0.145]].forEach(([u, h], f) => {
    t && f === 3 || i.add("wood_pallet", o(1.2, 0.022, h), { p: [a(), 0.133, u + a(6e-3)], r: [a(4e-3), a(8e-3), 0] }, r());
  }), n) {
    let u = i.G.mats.label("EUR", { color: "black", font: "sans", distress: 0.6 });
    i.decal(u, 0.085, { p: [-0.5275, 0.062, 0.5015] }), i.decal(u, 0.085, { p: [0.5275, 0.062, -0.5015], r: [0, At, 0] });
  }
}
function VA(i, e, t) {
  let n = new Kn(i, "pallet", t);
  return S1(n, n.rng, { broken: !!e.broken, bevel: true }), n.finish();
}
function WA(i, e) {
  let t = new Kn(i, "pallet_stack", e.seed || 0), n = t.rng, s = zi(e.count | 0 || 8, 1, 12);
  for (let o = 0; o < s; o++) {
    let r = o === s - 1;
    t.push({ p: [o ? n.range(-0.028, 0.028) : 0, o * 0.144, o ? n.range(-0.022, 0.022) : 0], r: [0, n.range(-0.035, 0.035) + (n() < 0.3 ? At : 0) + (r ? n.range(-0.06, 0.06) : 0), 0] }), S1(t, n, { broken: !r && n() < 0.2, stamp: o % 3 === 0, bevel: r }), t.pop();
  }
  return t.finish({ size: [1.2, s * 0.144, 1] });
}
function E1(i, e, t, n, { detail: s = true, label: o = "FRAGILE", code: r = "B4-117", skids: a = true } = {}) {
  let l = i.rng, c = i.G, u = 0.022, h = 0.07, f = a ? 0.07 : 0, p = t - f, d = f + p / 2, v = (z = 1) => {
    let H = l.range(0.7, 1) * z;
    return [H, H * l.range(0.92, 1), H * l.range(0.82, 0.95)];
  }, g = s ? (z, H, O) => Ge(z, H, O, 4e-3) : (z, H, O) => $e(z, H, O);
  if (a) for (let z of [-(e / 2 - 0.13), 0, e / 2 - 0.13]) i.add("wood_pallet", Ge(0.09, f, n - 0.02, 6e-3), { p: [z, f / 2, 0] }, v(0.6));
  i.add("wood_dark", $e(e - 2 * u - 0.012, p - u - 0.012, n - 2 * u - 0.012), { p: [0, f + (p - u - 0.012) / 2 + 2e-3, 0] }, 0.25);
  let x = Math.max(3, Math.round(p / 0.125)), y = p / x;
  for (let z = 0; z < x; z++) {
    let H = f + y * (z + 0.5);
    for (let [O, q, U] of [["pz", e, n / 2 - u], ["nz", e, n / 2 - u], ["px", n, e / 2 - u], ["nx", n, e / 2 - u]]) {
      let T = U - l.range(0, 4e-3), D = O === "pz" ? [0, H, T] : O === "nz" ? [0, H, -T] : O === "px" ? [T, H, 0] : [-T, H, 0];
      i.add("wood_pallet", $3(q - 0.03, y - 5e-3, l() * 3, l() * 3), { p: D, r: w1[O] }, v());
    }
  }
  let b = Math.max(3, Math.round(n / 0.13)), m = (n - 0.02) / b;
  for (let z = 0; z < b; z++) i.add("wood_pallet", $3(e - 0.03, m - 5e-3, l() * 3, l() * 3), { p: [0, t - u - l.range(0, 3e-3), -n / 2 + 0.01 + m * (z + 0.5)], r: [-tt, 0, 0] }, v());
  let A = Math.atan2(p - 2 * h, e - 2 * h), _ = Math.hypot(e - 2 * h, p - 2 * h);
  for (let z of [1, -1]) {
    let H = z * (n / 2 - u / 2);
    i.add("wood_pallet", g(e, h, u), { p: [0, f + h / 2, H] }, v(0.85)), i.add("wood_pallet", g(e, h, u), { p: [0, t - h / 2, H] }, v(0.85));
    for (let U of [1, -1]) i.add("wood_pallet", g(h, p - 2 * h, u), { p: [U * (e / 2 - h / 2), d, H] }, v(0.85));
    s && i.add("wood_pallet", Ge(_, h * 0.85, u * 0.8, 4e-3), { p: [0, d, z * (n / 2 - u * 0.6)], r: [0, 0, z * A] }, v(0.8));
    let O = z * (e / 2 - u / 2), q = n - 2 * u;
    for (let U of [1, -1]) i.add("wood_pallet", g(u, p, h), { p: [O, d, U * (q / 2 - h / 2)] }, v(0.85));
    i.add("wood_pallet", g(u, h, q - 2 * h), { p: [O, f + h / 2, 0] }, v(0.85)), i.add("wood_pallet", g(u, h, q - 2 * h), { p: [O, t - h / 2, 0] }, v(0.85)), i.add("wood_pallet", g(e, u, h), { p: [0, t - u / 2, z * (n / 2 - h / 2)] }, v(0.85)), i.add("wood_pallet", g(h, u, n - 2 * h), { p: [z * (e / 2 - h / 2), t - u / 2, 0] }, v(0.85));
  }
  s && i.add("wood_pallet", Ge(h, u, n - 2 * h, 4e-3), { p: [0, t - u / 2, 0] }, v(0.85));
  let M = 0.085, E = () => {
    let z = l.range(0.55, 0.9);
    return [z, z * 0.9, z * 0.8];
  };
  for (let z of [1, -1]) for (let H of [1, -1]) for (let O of s ? [1, 0] : [1]) {
    let q = O ? t - M / 2 : f + M / 2, U = E();
    i.add("steel_galv", $e(M, M, 3e-3), { p: [z * (e / 2 - M / 2), q, H * (n / 2 + 15e-4)] }, U), i.add("steel_galv", $e(3e-3, M, M), { p: [z * (e / 2 + 15e-4), q, H * (n / 2 - M / 2)] }, U), O && i.add("steel_galv", $e(M, 3e-3, M), { p: [z * (e / 2 - M / 2), t + 15e-4, H * (n / 2 - M / 2)] }, U);
  }
  let w = n / 2 - u + 3e-3, S = Math.min(0.11, p * 0.15);
  o && (i.label(o, { color: "black", font: "stencil", distress: 0.25 }, e * 0.4, S, { p: [-e * 0.2, t - h - S * 0.95, w] }), i.label(o, { color: "black", font: "stencil", distress: 0.25 }, e * 0.4, S, { p: [e * 0.2, t - h - S * 0.95, -w], r: [0, At, 0] }), i.decal(c.mats.decal("arrow"), Math.min(0.14, p * 0.2), { p: [e * 0.27, f + h + p * 0.16, w], r: [0, 0, tt] })), r && i.label(r, { color: "black", font: "stencil", distress: 0.3 }, n * 0.5, S * 0.9, { p: [e / 2 - u + 3e-3, d + p * 0.12, 0], r: w1.px }), s && i.decal(c.mats.decal("logo_b"), Math.min(0.2, p * 0.25), { p: [-(e / 2 - u + 3e-3), d - p * 0.05, 0], r: w1.nx });
}
function GA(i, e) {
  let t = new Kn(i, "crate_wood", e.seed || 0);
  return E1(t, 1.1, 1, 0.9, { label: e.label === void 0 ? ["FRAGILE", "THIS SIDE UP", "KEEP DRY", "MACHINE PARTS"][t.seed % 4] : e.label, code: e.code || "B4-" + [117, 204, 318][t.seed % 3] }), t.finish();
}
function qA(i, e) {
  let t = new Kn(i, "crate_stack", e.seed || 0), n = t.rng;
  E1(t, 1.2, 0.95, 1, { label: "HEAVY", code: "SLT 04" + t.seed % 2 });
  let s = { x: n.range(-0.1, 0.02), z: n.range(-0.05, 0.05), th: (n() < 0.5 ? -1 : 1) * n.range(0.1, 0.16), L: 0.86, W: 0.72 };
  t.push({ p: [s.x, 0.95, s.z], r: [0, s.th, 0] }), E1(t, s.L, 0.6, s.W, { detail: false, skids: false, label: "FRAGILE", code: "B4-204" }), t.pop();
  let o = { x: s.x + n.range(-0.05, 0.05), z: s.z + n.range(-0.04, 0.04), th: n.range(-0.12, 0.12) };
  t.push({ p: [o.x, 1.55, o.z], r: [0, o.th, 0] }), E1(t, 0.55, 0.35, 0.45, { detail: false, skids: false, label: "", code: "" }), t.pop();
  let r = (a, l, c, u, h) => {
    let f = (a - l.x - h * u * Math.sin(c)) / Math.cos(c);
    return l.z - f * Math.sin(c) + h * u * Math.cos(c);
  };
  for (let a of [-0.2, 0.17]) {
    let c = [], u = (h) => [[a, 0.09, h * 0.506], [a, 0.956, h * 0.506], [a, 1.556, r(a, s, s.th, s.W / 2, h) + h * 6e-3], [a, 1.906, r(a, o, o.th, 0.225, h) + h * 6e-3]];
    c.push(...u(1), ...u(-1).reverse()), t.add("paint_orange", vr(c, [0.02, 0, 0]), null, [1, 0.8, 0.5]), t.add("steel_worn", Ge(0.06, 0.09, 0.025, 6e-3), { p: [a, 0.62, 0.5 + 0.016] }, 0.8), t.add("steel_dark", vn([a - 0.035, 0.66, 0.53], [a + 0.035, 0.66, 0.53], 8e-3, 6, true), null, 0.8);
  }
  return t.finish();
}
function XA(i, e) {
  let t = new Kn(i, "ibc_tote", e.seed || 0), n = t.rng, s = () => n.range(0.75, 1);
  for (let y of [-0.44, 0, 0.44]) t.add("steel_galv", $e(1.2, 0.028, 0.1), { p: [0, 0.014, y] }, s());
  for (let y of [-0.54, 0, 0.54]) for (let b of [-0.44, 0, 0.44]) t.add("steel_galv", Ge(0.12, 0.074, 0.1, 8e-3), { p: [y, 0.065, b] }, s() * 0.85);
  for (let y of [-0.48, 0.48]) t.add("steel_galv", Ge(1.2, 0.03, 0.04, 6e-3), { p: [0, 0.115, y] }, s());
  for (let y of [-0.58, 0.58]) t.add("steel_galv", Ge(0.04, 0.03, 0.92, 6e-3), { p: [y, 0.115, 0] }, s());
  t.add("steel_galv", $e(1.12, 0.012, 0.92), { p: [0, 0.124, 0] }, 0.6);
  let o = 1.1, r = 0.95, a = 0.9, l = 0.13 + r / 2, c = eo(o, r, a, 0.07, 8, 6, 8);
  to(c, (y) => {
    let b = y.x / (o / 2), m = y.y / (r / 2), A = y.z / (a / 2), _ = Math.cos(tt * m) * Math.cos(tt * A), M = Math.cos(tt * b) * Math.cos(tt * A), E = Math.cos(tt * b) * Math.cos(tt * m);
    Math.abs(b) > 0.9 && (y.x += Math.sign(b) * (0.016 * _ + 4e-3 * Math.abs(Math.sin(y.y * At / 0.22)) * _)), Math.abs(A) > 0.9 && (y.z += Math.sign(A) * (0.016 * E + 4e-3 * Math.abs(Math.sin(y.y * At / 0.22)) * E)), m > 0.9 && (y.y += 0.012 * M - 0.01 * Math.max(0, 1 - Math.hypot(y.x, y.z) / 0.3));
  }), gr(c);
  let u = 0.13 + r * n.range(0.45, 0.8), h = t.seed * 1.3, f = t.mat("plastic_grey", { color: 14278096 });
  t.add(f, c, { p: [0, l, 0] }, (y, b, m) => {
    let A = j3(u - 0.03, u + 0.03, b + 0.02 * gn(y * 3 + h, m * 3)), _ = 0.9 + 0.1 * gn(y * 6, b * 6 + h, m * 6);
    return [_ * (0.52 + 0.48 * A), _ * (0.6 + 0.4 * A), _ * (0.66 + 0.34 * A)];
  }), t.add(f, ot(0.12, 0.125, 0.03, 14), { p: [0, 0.13 + r + 5e-3, 0] }, 0.9), t.add("plastic_red", us([[0.105, 0], [0.105, 0.042], [0.105, 0.042], [0.09, 0.05], [0, 0.05]], 14), { p: [0, 0.13 + r + 0.015, 0] }, 0.9);
  for (let y = 0; y < 8; y++) {
    let b = y * At / 4;
    t.add("plastic_red", $e(0.012, 0.04, 0.02), { p: [Math.cos(b) * 0.108, 0.13 + r + 0.036, Math.sin(b) * 0.108], r: [0, -b, 0] }, 0.8);
  }
  let p = 0.575, d = 0.475, v = 0.13, g = 1.1, x = 0.011;
  for (let y of [0.2, 0.42, 0.64, 0.86, g]) {
    let b = y === g ? 0.014 : x;
    for (let m of [1, -1]) t.add("steel_galv", vn([-p, y, m * d], [p, y, m * d], b, 5), null, s()), t.add("steel_galv", vn([m * p, y, -d], [m * p, y, d], b, 5), null, s());
  }
  for (let y of [1, -1]) {
    for (let b = -0.46; b <= 0.461; b += 0.184) t.add("steel_galv", vn([b, v, y * (d - 0.012)], [b, g, y * (d - 0.012)], x, 5), null, s());
    for (let b = -0.36; b <= 0.361; b += 0.18) t.add("steel_galv", vn([y * (p - 0.012), v, b], [y * (p - 0.012), g, b], x, 5), null, s());
    t.add("steel_galv", vn([y * 0.28, g + 0.01, -d], [y * 0.28, g + 0.01, d], 0.013, 5), null, s());
  }
  return t.add("aluminium", Ge(0.42, 0.3, 4e-3, 15e-4), { p: [-0.1, 0.72, d + 0.014] }, 0.85), t.label("IBC 1000 L", { color: "black", font: "sans", distress: 0.2 }, 0.36, 0.06, { p: [-0.1, 0.8, d + 0.0175] }), t.decal(i.mats.decal(["hazard_flammable", "hazard_general"][t.seed % 2]), 0.15, { p: [-0.19, 0.67, d + 0.0175] }), t.decal(i.mats.decal("numbers_0_9"), 0.2, { p: [0, 0.66, d + 0.0175] }), t.decal(i.mats.decal("leak_stain"), 0.3, { p: [p + 4e-3, 0.3, 0.02], r: w1.px }), t.add("polymer_black", vn([0.52, 0.2, 0], [0.575, 0.2, 0], 0.05, 10, true), null, 1), t.add("plastic_red", vn([0.575, 0.2, 0], [0.598, 0.2, 0], 0.045, 10, true), null, 0.9), t.add("plastic_red", Ge(0.02, 0.022, 0.13, 5e-3), { p: [0.55, 0.262, 0.02], r: [0, 0.4, 0] }, 0.9), t.add("polymer_black", ot(0.012, 0.012, 0.03, 6), { p: [0.55, 0.245, 0] }), t.finish();
}
function Z3(i, e, t, n = 0) {
  let s = [], o = 2 * i / e;
  for (let r = 0; r < e; r++) {
    let a = -i + r * o + 3e-3, l = -i + (r + 1) * o - 3e-3, c = [a, (a + l) / 2, l], u = [], h = [], f = [], p = [], d = (y) => Math.sqrt(Math.max(0, i * i - y * y)), v = t() * 2, g = t() * 2;
    for (let y of c) u.push(y, -d(y), 0, y, d(y), 0), h.push(0, 0, 1, 0, 0, 1), f.push(-d(y) + v, y + g, d(y) + v, y + g);
    p.push(0, 2, 3, 0, 3, 1, 2, 4, 5, 2, 5, 3);
    let x = new THREE.BufferGeometry();
    x.setAttribute("position", new THREE.BufferAttribute(new Float32Array(u), 3)), x.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(h), 3)), x.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(f), 2)), x.setIndex(p), s.push(x);
  }
  return s;
}
function YA(i, e) {
  let t = new Kn(i, "cable_reel", e.seed || 0), n = t.rng, s = 0.65, o = s, r = 0.4, a = 0.045, l = (y = 1) => {
    let b = n.range(0.7, 1) * y;
    return [b, b * n.range(0.93, 1), b * n.range(0.85, 0.97)];
  }, c = n.range(-0.5, 0.5);
  t.push({ p: [0, o, 0], r: [0, 0, c] });
  for (let y of [1, -1]) {
    for (let b of Z3(s - 4e-3, 9, n)) t.add("wood_dark", b, { p: [0, 0, y * (r + n.range(0, 3e-3))], r: [0, y > 0 ? 0 : At, 0] }, l());
    for (let b of Z3(s - 4e-3, 9, n)) t.add("wood_dark", b, { p: [0, 0, y * (r - a)], r: [0, y > 0 ? At : 0, tt] }, l(0.8));
    t.add("wood_dark", ot(s, s, a, 24, true), { p: [0, 0, y * (r - a / 2)], r: [tt, 0, 0] }, l(0.75)), t.add("steel_dark", ot(0.105, 0.105, 8e-3, 12), { p: [0, 0, y * (r + 6e-3)], r: [tt, 0, 0] }, 0.9), t.add("polymer_black", ot(0.04, 0.04, 4e-3, 10), { p: [0, 0, y * (r + 0.0105)], r: [tt, 0, 0] }, 0.3);
    for (let b = 0; b < 6; b++) {
      let m = b * At / 3 + 0.3;
      t.add("steel_galv", ot(0.017, 0.017, 0.014, 6), { p: [Math.cos(m) * 0.3, Math.sin(m) * 0.3, y * (r + 6e-3)], r: [tt, 0, 0] }, n.range(0.5, 0.9));
    }
    t.label(y > 0 ? "NYY-J 4x95 mm2  500 m" : "HALCYON TERMINAL", { color: "white", font: "stencil", distress: 0.45 }, 0.7, 0.085, { p: [0, 0.4, y * (r + 6e-3)], r: [0, y > 0 ? 0 : At, 0] }), y > 0 && t.decal(i.mats.decal("arrow"), 0.2, { p: [0.36, -0.2, r + 6e-3], r: [0, 0, -1.2] });
  }
  let u = 16, h = r - a, f = 2 * h / u, p = 0.47, d = [];
  for (let y = 0; y <= u; y++) d.push([p - 0.017, -h + y * f]), y < u && d.push([p, -h + (y + 0.5) * f]);
  let v = t.seed * 0.7;
  t.add("rubber", us(d, 20), { r: [tt, 0, 0] }, (y, b, m) => 0.7 + 0.5 * gn(Math.atan2(b, y) * 2 + v, m * 30)), t.pop();
  let g = 0.2, x = [];
  for (let y = 1.9; y >= -0.25; y -= 0.36) x.push([Math.cos(y) * (p + 0.012), o + Math.sin(y) * (p + 0.012), g + (1.9 - y) * 0.02]);
  x.push([0.53, 0.3, g + 0.05], [0.56, 0.08, g + 0.06], [0.5, 0.024, g + 0.02], [0.3, 0.022, g - 0.1], [0.05, 0.022, g - 0.02], [-0.2, 0.022, g + 0.06], [-0.38, 0.022, g - 0.05]), t.add("rubber", Fn(x, 0.02, 6, false, 0.5), null, 0.9), t.add("brass", vn([-0.38, 0.022, g - 0.05], [-0.41, 0.022, g - 0.07], 0.014, 6, true), null, 0.9);
  for (let y of [r - a / 2, -(r - a / 2)]) t.add("wood_pallet", Mo([[0.14, 0], [0.37, 0], [0.37, 0.1]], 0.1, { soft: 0 }), { p: [0, 0, y] }, l(0.8)), t.add("wood_pallet", Mo([[-0.37, 0], [-0.14, 0], [-0.37, 0.1]], 0.1, { soft: 0 }), { p: [0, 0, y] }, l(0.8));
  return t.finish();
}
function tv(i, e, t, n = 20) {
  let s = i - t, o = Math.min(0.011, s * 0.08), r = [[t, e * 0.18], [t + s * 0.45, e * 0.035], [i - s * 0.2, e * 0.02], [i - s * 0.06, e * 0.07], [i, e * 0.17], [i, e * 0.17], [i, e * 0.355], [i - o, e * 0.385], [i, e * 0.415], [i, e * 0.585], [i - o, e * 0.615], [i, e * 0.645], [i, e * 0.83], [i, e * 0.83], [i - s * 0.06, e * 0.93], [i - s * 0.2, e * 0.98], [t + s * 0.45, e * 0.965], [t, e * 0.82], [t, e * 0.82], [t, e * 0.18]], a = us(r, n), l = a.attributes.uv, c = r.length, u = [0];
  for (let v = 1; v < c; v++) u.push(u[v - 1] + Math.hypot(r[v][0] - r[v - 1][0], r[v][1] - r[v - 1][1]));
  let h = (u[8] + u[9]) / 2, f = h - u[4], p = u[4] - u[0], d = Math.max(1, Math.round(2 * At * i / 0.5)) * 0.5;
  for (let v = 0; v < c; v++) {
    let g = v >= c - 2 ? -(f + p) : u[v] - h, x = Math.abs(g), y = Math.sign(g) * (x <= f + 1e-6 ? x / f * 0.126 : 0.126 + Math.min(1, (x - f) / p) * 0.022);
    for (let b = 0; b <= n; b++) l.setXY(v * (n + 1) + b, b / n * d, y);
  }
  return a;
}
function $A(i, e) {
  let t = new Kn(i, "tire_stack", e.seed || 0), n = t.rng, s = zi(e.count | 0 || 4, 1, 5);
  for (let o = 0; o < s; o++) {
    let r = tv(0.39, 0.25, 0.215, s > 4 ? 16 : 20), a = { p: [o ? n.range(-0.022, 0.022) : 0, o * 0.25 - (o ? 4e-3 : 0), o ? n.range(-0.022, 0.022) : 0], r: [0, n() * 6, 0] }, l = n.range(0.75, 1), c = o * 3.1;
    t.add("tire", r, a, (u, h, f) => {
      let p = Math.hypot(u - a.p[0], f - a.p[2]);
      return l * (p < 0.23 ? 0.5 : 0.8 + 0.2 * gn(Math.atan2(f, u) * 3 + c, p * 30));
    });
  }
  return t.finish({ size: [0.8, s * 0.25, 0.8] });
}
function ZA(i, e, t) {
  let n = new Kn(i, "jerry_can", t), [s, o] = Ja(e.color, "olive"), r = eo(0.336, 0.36, 0.156, 0.022, 3, 3, 3, "bottom"), a = (x, y) => y > 0.3 && x > 0.04 ? y - (x - 0.04) * 0.5 : y;
  to(r, (x) => {
    x.y = a(x.x, x.y), Math.abs(x.z) > 0.07 && Math.abs(x.x) < 0.14 && x.y > 0.04 && x.y < 0.3 && (x.z *= 1.02);
  }), r.computeVertexNormals(), n.add(s, r, null, o), n.add(s, Mo([[-0.172, 0], [0.172, 0], [0.172, 0.297], [0.045, 0.364], [-0.172, 0.364]], 7e-3, { soft: 0 }), null, typeof o == "number" ? 0.8 : o.map((x) => x * 0.8));
  let l = 0.24, c = 0.2, u = -0.025, h = 0.165, f = Math.hypot(l, c) - 0.02, p = Math.atan2(c, l);
  for (let x of [1, -1]) {
    let y = x * 0.079;
    for (let b of [1, -1]) n.add(s, Ge(l, 0.016, 7e-3, 3e-3), { p: [u, h + b * c / 2, y] }, o);
    for (let b of [1, -1]) n.add(s, Ge(0.016, c, 7e-3, 3e-3), { p: [u + b * l / 2, h, y] }, o);
    for (let b of [1, -1]) n.add(s, Ge(f, 0.018, 8e-3, 3e-3), { p: [u, h, y], r: [0, 0, b * p] }, o);
  }
  for (let x of [-0.042, 0, 0.042]) n.add(s, Fn([[-0.135, 0.35, x], [-0.125, 0.42, x], [-0.09, 0.44, x], [-0.02, 0.44, x], [0.01, 0.42, x], [0.02, 0.35, x]], 0.0105, 5, false, 0.5), null, o);
  let d = [0.1, 0.33, 0], v = [0.42, 0.9, 0], g = (x) => [d[0] + v[0] * x, d[1] + v[1] * x, 0];
  return n.add(s, vn(g(-0.02), g(0.07), 0.03, 8, true), null, o), n.add("steel_dark", vn(g(0.07), g(0.1), 0.036, 8, true), null, 0.9), n.add("steel_galv", Ge(0.07, 8e-3, 0.02, 2e-3), { p: g(0.108), r: [0, 0, -0.44] }, 0.8), n.decal(i.mats.decal("hazard_flammable"), 0.055, { p: [0.125, 0.25, 0.0795] }), n.decal(i.mats.decal("hazard_flammable"), 0.055, { p: [-0.125, 0.25, -0.0795], r: [0, At, 0] }), n.finish();
}
function jA(i, e, t) {
  let n = new Kn(i, "traffic_cone", t), s = n.rng, o = t * 4.1;
  e.lying && (n.push({ p: [-0.34, 0.18, 0], r: [0, s() * 6, 0] }), n.push({ r: [0, 0, -tt + 0.16] }));
  let r = (h) => 0.128 + (0.031 - 0.128) * (h - 0.05) / (0.685 - 0.05);
  n.add("rubber", Ge(0.36, 0.03, 0.36, 8e-3, "bottom"), null, 0.9);
  let a = (h, f, p) => {
    let d = gn(Math.atan2(p, h) * 3 + o, f * 14);
    return d > 0.68 ? 0.45 : 0.85 + 0.15 * d;
  }, l = (h, f, p = [], d = []) => us([...p, [r(h), h], [r(f), f], ...d], 16), c = n.mat("plastic_red", { color: 12734234 }), u = n.mat("plastic_grey", { color: 13224386 });
  return n.add(c, l(0.05, 0.36, [[0.165, 0.03], [0.15, 0.04], [0.136, 0.05]]), null, a), n.add(u, l(0.36, 0.5), null, (h, f, p) => 0.85 * a(h, f, p)), n.add(c, l(0.5, 0.56), null, a), n.add(u, l(0.56, 0.61), null, (h, f, p) => 0.85 * a(h, f, p)), n.add(c, l(0.61, 0.685, [], [[0.028, 0.696], [0.018, 0.7], [0.018, 0.7], [0, 0.7]]), null, a), e.lying && (n.pop(), n.pop()), n.finish(e.lying ? { size: [0.72, 0.36, 0.36] } : {});
}
function JA(i, e) {
  let t = new Kn(i, "gas_cylinders", e.seed || 0), n = t.rng, s = 12, o = () => n.range(0.6, 0.9);
  t.add("diamond_plate", Ge(0.9, 0.016, 0.5, 4e-3, "bottom"), null, 0.8);
  for (let u of [-0.43, 0.43]) t.add("steel_dark", Ge(0.04, 1.14, 0.04, 5e-3), { p: [u, 0.585, -0.225] }, o()), t.add("steel_dark", Ge(0.036, 0.036, 0.43, 5e-3), { p: [u, 1.06, -0.01] }, o()), t.add("steel_dark", Ge(0.036, 0.036, 0.43, 5e-3), { p: [u, 0.3, -0.01] }, o()), t.add("steel_dark", Ge(0.036, 0.32, 0.036, 5e-3), { p: [u, 0.16, 0.19] }, o()), t.add("steel_galv", ja(0.016, 4e-3, 4, 8), { p: [u - Math.sign(u) * 0, 1.06, 0.215], r: [0, tt, 0] }, 0.8);
  for (let u of [0.45, 1.06]) t.add("steel_dark", Ge(0.9, 0.04, 0.036, 5e-3), { p: [0, u, -0.225] }, o());
  t.add("paint_yellow", Ge(0.3, 0.2, 4e-3, 1e-3), { p: [0, 0.76, -0.245] }, 0.9), t.decal(i.mats.decal("hazard_flammable"), 0.15, { p: [0, 0.76, -0.2475], r: [0, At, 0] });
  let r = [["paint_red", 1], ["paint_white", 1], ["paint_blue", 1], ["paint_yellow", 1], ["paint_grey", 0.5]], a = [["paint_grey", 0.75], ["paint_grey", 0.55], ["paint_red", [0.55, 0.4, 0.4]], ["paint_blue", 0.8]];
  for (let u = 0; u < 3; u++) {
    let h = (u - 1) * 0.272, f = 1 - n.range(0, 0.05), p = 0.115, d = r[(t.seed + u * 2) % r.length], v = a[(t.seed + u) % a.length], g = u * 5.3 + t.seed, x = n() * 6;
    t.push({ p: [h, 0.016, 0.015 + n.range(-0.01, 0.01)], r: [0, x, 0], s: [1, f, 1] }), t.add(v[0], us([[0, 0.012], [0.095, 0.012], [0.095, 0.012], [0.1, 0], [0.111, 0], [p, 8e-3], [p, 0.4], [p, 0.8], [p, 1.22]], s), null, (y, b, m) => {
      let A = gn(Math.atan2(m, y) * 3 + g, b * 5), _ = A > 0.7 ? 0.55 : 1, M = typeof v[1] == "number" ? [v[1], v[1], v[1]] : v[1];
      return [M[0] * _, M[1] * _ * (A > 0.7 ? 0.85 : 1), M[2] * _ * (A > 0.7 ? 0.7 : 1)];
    }), t.add(d[0], us([[p, 1.22], [0.111, 1.285], [0.098, 1.34], [0.075, 1.385], [0.052, 1.41], [0.04, 1.42]], s), null, d[1]), t.add("steel_dark", us([[0.04, 1.42], [0.057, 1.42], [0.057, 1.42], [0.057, 1.448], [0.057, 1.448], [0.05, 1.452], [0.053, 1.53], [0.046, 1.565], [0.026, 1.585], [0, 1.588]], s), null, 0.8);
    for (let y of [0, At]) t.add("polymer_black", ot(0.016, 0.016, 4e-3, 6), { p: [Math.cos(y) * 0.052, 1.5, Math.sin(y) * 0.052], r: [0, -y, tt] }, 0.2);
    u !== 1 && t.cdecal(i.mats.decal(u ? "hazard_general" : "hazard_flammable"), p + 15e-4, 0.1, { p: [0, 1.08, 0], r: [0, n.range(-0.5, 0.5) - x, 0] }), t.cdecal(i.mats.label(["ACETYLENE", "OXYGEN", "ARGON", "PROPANE"][(t.seed + u) % 4], { color: "white", font: "stencil", distress: 0.4 }), p + 15e-4, 0.2, { p: [0, 0.86, 0], r: [0, n.range(-0.4, 0.4) - x, 0] }), t.pop();
  }
  let l = 19, c = (u) => {
    let h = 0.215;
    for (let f = -1; f <= 1; f++) {
      let p = u - f * 0.272;
      Math.abs(p) < 0.115 && (h = Math.max(h, 0.015 + Math.sqrt(0.123 * 0.123 - p * p) + 0));
    }
    return Math.max(h, 0.1);
  };
  for (let u = 0; u < l; u++) {
    let h = u / (l - 1), f = -0.425 + 0.85 * h, p = Math.max(c(f), c(f - 0.03), c(f + 0.03)) + 4e-3, d = 1.05 - 0.035 * Math.sin(At * (h * 3 % 1)) - 0.01;
    t.add("steel_galv", ja(0.017, 45e-4, 3, 6), { p: [f, d, p], r: [u % 2 ? tt : 0.15, 0, 0], s: [1.35, 1, 1] }, n.range(0.6, 0.95));
  }
  return t.finish();
}
function KA(i, e) {
  let t = new Kn(i, "pipe_stack", e.seed || 0), n = t.rng, s = 0.1365, o = 0.012, r = 0.08, a = 14, l = (h = 1) => {
    let f = n.range(0.6, 0.95) * h;
    return [f, f * 0.95, f * 0.86];
  };
  for (let h of [-2.2, 0, 2.2]) {
    t.add("wood_dark", Ge(0.11, r, 1.2, 8e-3), { p: [h + n.range(-0.1, 0.1), r / 2, 0], r: [0, n.range(-0.03, 0.03), 0] }, l());
    for (let f of [1, -1]) t.add("wood_pallet", Mo(f > 0 ? [[0, 0], [0.158, 0], [0.158, 0.1]] : [[-0.158, 0], [0, 0], [-0.158, 0.1]], 0.1, { soft: 0 }), { p: [h, r, f * 0.44], r: [0, -tt, 0] }, l(0.9));
  }
  let c = [4, 3, 2], u = 2 * s * Math.sin(At / 3);
  c.forEach((h, f) => {
    for (let p = 0; p < h; p++) {
      let d = (p - (h - 1) / 2) * 2 * s, v = r + s + f * u, g = n.range(5.78, 5.92), x = n.range(-3, 3 - g) * 0.999 + 0, y = Math.max(-3, Math.min(3 - g, x)) + g / 2, b = n() < 0.7 ? "steel_rust" : "steel_dark", m = n() * 50, A = n.range(0.75, 1), _ = new THREE.CylinderGeometry(s, s, g, a, 4, true);
      {
        let w = _.attributes.uv, S = _.attributes.position;
        for (let z = 0; z < w.count; z++) w.setXY(z, w.getX(z) * 2 * At * s, S.getY(z));
      }
      let M = { p: [y, v, d], r: [n() * 6, 0, tt] };
      t.add(b, _, M, (w, S, z) => A * (0.75 + 0.35 * gn(w * 1.3 + m, z * 9, S * 9)));
      let E = M1(ot(s - o, s - o, g - 2e-3, a, true));
      t.add("steel_rust", E, M, (w) => 0.16 + 0.5 * j3(g / 2 + Math.abs(y) - 0.9, g / 2 + Math.abs(y) + 0.2, Math.abs(w - y) + Math.abs(y)));
      for (let w of [1, -1]) t.add(b, us(w > 0 ? [[s, 0], [s - o, 0]] : [[s - o, 0], [s, 0]], a), { p: [y + w * g / 2, v, d], r: [0, 0, -tt] }, A * 1.1);
    }
  });
  for (let h of [-1.35, 1.5]) {
    let p = 2 * s, d = r + s + 2 * u + s + 4e-3, v = [], g = [[-(1.5 * p + s + 4e-3), r + s], [-(0.5 * p + s * 0.5 + 4e-3), r + s + 2 * u + s * 0.87], [-0.5 * p, d], [0.5 * p, d], [0.5 * p + s * 0.5 + 4e-3, r + s + 2 * u + s * 0.87], [1.5 * p + s + 4e-3, r + s], [1.5 * p, r - 4e-3], [-1.5 * p, r - 4e-3], [-(1.5 * p + s + 4e-3), r + s]];
    for (let x of g) v.push([h, x[1], x[0]]);
    t.add("steel_dark", vr(v, [0.016, 0, 0]), null, 0.7), t.add("steel_galv", Ge(0.04, 0.012, 0.05, 3e-3), { p: [h, d + 5e-3, 0.03] }, 0.8);
  }
  return t.cdecal(i.mats.label("API 5L X52  273.1 x 12.5  HEAT 40719", { color: "white", font: "stencil", distress: 0.5 }), s + 2e-3, 0.2, { p: [0.9, r + s + 2 * u, s], r: [-tt + 0.9, 0, tt] }, 1.6), t.finish();
}
function J3(i) {
  i("barrel", (e, t = {}) => {
    let n = Math.abs(t.seed | 0) % 4;
    return wf(e, `barrel|${t.color}|${!!t.lying}|${!!t.open}|${n}`, () => HA(e, t, n));
  }), i("pallet", (e, t = {}) => {
    let n = Math.abs(t.seed | 0) % 4;
    return wf(e, `pallet|${!!t.broken}|${n}`, () => VA(e, t, n));
  }), i("pallet_stack", (e, t = {}) => WA(e, t)), i("crate_wood", (e, t = {}) => GA(e, t)), i("crate_stack", (e, t = {}) => qA(e, t)), i("ibc_tote", (e, t = {}) => XA(e, t)), i("cable_reel", (e, t = {}) => YA(e, t)), i("tire_stack", (e, t = {}) => $A(e, t)), i("jerry_can", (e, t = {}) => {
    let n = Math.abs(t.seed | 0) % 2;
    return wf(e, `jerry|${t.color}|${n}`, () => ZA(e, t, n));
  }), i("traffic_cone", (e, t = {}) => {
    let n = Math.abs(t.seed | 0) % 3;
    return wf(e, `cone|${!!t.lying}|${n}`, () => jA(e, t, n));
  }), i("gas_cylinders", (e, t = {}) => JA(e, t)), i("pipe_stack", (e, t = {}) => KA(e, t));
}
var Q3 = (i, e, t) => {
  let n = zi((t - i) / (e - i), 0, 1);
  return n * n * (3 - 2 * n);
};
function nv(i, e, t = 0, n = 0) {
  let s = new THREE.PlaneGeometry(i, e), o = s.attributes.uv, r = s.attributes.position;
  for (let a = 0; a < o.count; a++) o.setXY(a, r.getX(a) + t, r.getY(a) + n);
  return s;
}
function QA(i, e) {
  let t = new Kn(i, "tarp_cargo", e.seed || 0), n = t.rng, s = t.seed * 1.7, o = 0.144, r = [[-1.06, -0.12, -0.58, 0.58, n.range(0.98, 1.12)], [-0.06, 1.06, -0.58, 0.12, n.range(1.32, 1.42)], [0.02, 0.62, 0.16, 0.58, n.range(0.72, 0.86)], [0.66, 1.06, 0.18, 0.56, n.range(0.5, 0.62)]];
  for (let N of [-0.6, 0.6]) t.push({ p: [N, 0, 0], r: [0, 0, 0] }), S1(t, n, { stamp: false }), t.pop();
  for (let N of r) {
    let Q = N[1] - N[0], K = N[3] - N[2], ie = N[4] - o, F = (N[0] + N[1]) / 2, X = (N[2] + N[3]) / 2, ne = n.range(0.7, 0.95);
    t.add("wood_pallet", Ge(Q, ie, K, 6e-3), { p: [F, o + ie / 2, X] }, [ne, ne * 0.95, ne * 0.88]), t.add("wood_pallet", $e(Q + 0.012, 0.07, K + 0.012), { p: [F, o + 0.04, X] }, ne * 0.75);
  }
  let a = 1.9, l = 22, c = 14, u = -1.125, h = 1.125, f = -0.645, p = 0.645, d = 5, v = (N, Q) => {
    let K = 0.3;
    for (let ie of r) {
      let F = Math.max(ie[0] - N, 0, N - ie[1]), X = Math.max(ie[2] - Q, 0, Q - ie[3]), ne = Math.hypot(F, X);
      K = Math.max(K, ie[4] - 0.95 * ne - 0.9 * ne * ne);
    }
    return K + 0.016 + 0.022 * gn(N * 5 + s, Q * 5) + 8e-3 * Math.sin(N * 23 + Q * 7 + s) + 6e-3 * Math.sin(Q * 31 - N * 5);
  }, g = [], x = [], y = [], b = (N, Q) => Q * (l + 1) + N;
  for (let N = 0; N <= c; N++) for (let Q = 0; Q <= l; Q++) {
    let K = u + (h - u) * Q / l, ie = f + (p - f) * N / c;
    g.push(K, v(K, ie), ie), x.push(K * a, ie * a);
  }
  for (let N = 0; N < c; N++) for (let Q = 0; Q < l; Q++) {
    let K = b(Q, N), ie = b(Q + 1, N), F = b(Q + 1, N + 1), X = b(Q, N + 1);
    y.push(K, X, ie, ie, X, F);
  }
  let m = [];
  for (let N = 0; N < l; N++) m.push([N, 0, 0, -1]);
  for (let N = 0; N < c; N++) m.push([l, N, 1, 0]);
  for (let N = l; N > 0; N--) m.push([N, c, 0, 1]);
  for (let N = c; N > 0; N--) m.push([0, N, -1, 0]);
  let A = m.length, _ = (l + 1) * (c + 1), M = /* @__PURE__ */ new Map(), E = n() * A;
  m.forEach((N, Q) => {
    M.set(N[0] + "," + N[1], Q);
    let K = (N[0] === 0 || N[0] === l) && (N[1] === 0 || N[1] === c), ie = N[2], F = N[3];
    K && (ie = N[0] === 0 ? -0.707 : 0.707, F = N[1] === 0 ? -0.707 : 0.707);
    let X = b(N[0], N[1]), ne = g[X * 3], re = g[X * 3 + 1], $ = g[X * 3 + 2], ue = Math.abs(Q - E);
    ue = Math.min(ue, A - ue);
    let me = 0.17 + 0.07 * Math.sin(Q * 0.55 + s) + 0.07 * gn(Q * 0.31 + s, 2.2) + 0.3 * Math.exp(-ue * ue / 14), ee = n() * 6;
    for (let B = 1; B <= d; B++) {
      let P = B / d, V = re + (me - re) * (0.25 * P + 0.75 * P * P) - (B === 1 ? 0.02 : 0), Y = (N[0] === 5 || N[0] === 16) && N[2] === 0 ? 0.035 * Math.sin(Math.PI * P) : 0, L = P * (0.04 * Math.sin(Q * 1.7 + ee * 0.2) + 0.028 * Math.sin(Q * 0.83 + 1.3 + s)) + 0.02 * P * gn(Q * 0.8, B * 0.9 + s) - Y, Z = (B === 1 ? 0.028 : 0.04 + 0.03 * P) + L + (K ? 0.012 * P : 0), J = zi(ne + ie * Z, -1.2, 1.2), oe = zi($ + F * Z, -0.7, 0.7), fe = re - V;
      g.push(J, V, oe), x.push((ne + ie * (Z + fe)) * a, ($ + F * (Z + fe)) * a);
    }
  });
  let w = (N, Q) => Q === 0 ? b(m[N][0], m[N][1]) : _ + N * d + (Q - 1);
  for (let N = 0; N < A; N++) for (let Q = 0; Q < d; Q++) {
    let K = (N + 1) % A, ie = w(N, Q), F = w(K, Q), X = w(K, Q + 1), ne = w(N, Q + 1);
    y.push(ie, F, ne, F, X, ne);
  }
  let S = new THREE.BufferGeometry();
  S.setAttribute("position", new THREE.BufferAttribute(new Float32Array(g), 3)), S.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(x), 2)), S.setIndex(y), S.computeVertexNormals();
  let z = S.attributes.normal, H = S.attributes.position, O = (N, Q) => [H.getX(N) + z.getX(N) * Q, H.getY(N) + z.getY(N) * Q, H.getZ(N) + z.getZ(N) * Q], q = [];
  for (let N of [5, 16]) {
    let Q = [], K = M.get(N + ",0"), ie = M.get(N + "," + c);
    Q.push([H.getX(w(K, d)), 0.11, -0.52]);
    for (let F = d; F >= 1; F--) Q.push(O(w(K, F), 7e-3));
    for (let F = 0; F <= c; F++) Q.push(O(b(N, F), 7e-3));
    for (let F = 1; F <= d; F++) Q.push(O(w(ie, F), 7e-3));
    Q.push([H.getX(w(ie, d)), 0.11, 0.52]), q.push(Q);
  }
  let U = 6, T = [], D = M.get("0," + U), C = M.get(l + "," + U);
  T.push([-1.1, 0.1, H.getZ(w(D, d))]);
  for (let N = d; N >= 1; N -= 2) T.push(O(w(D, N), 0.012));
  for (let N = 0; N <= l; N += 2) T.push(O(b(N, U), 0.012));
  for (let N = 1; N <= d; N += 2) T.push(O(w(C, N), 0.012));
  T.push([1.1, 0.1, H.getZ(w(C, d))]), t.add(t.mat("tarp", { doubleSide: true }), S, null, (N, Q, K) => {
    let ie = gn(N * 2.3 + s, Q * 2.3, K * 2.3), F = gn(N * 11, Q * 11, K * 11 + s);
    return (0.72 + 0.28 * ie) * (0.9 + 0.1 * F) * (0.8 + 0.2 * Q3(0.15, 0.6, Q));
  });
  for (let N of q) {
    t.add("paint_orange", vr(N, [0.024, 0, 0]), null, [1, 0.82, 0.5]);
    let Q = N[N.length - 4];
    t.add("steel_worn", Ge(0.065, 0.1, 0.03, 6e-3), { p: [Q[0], Q[1], Q[2] + 0.014], r: [0.25, 0, 0] }, 0.8), t.add("steel_dark", Ge(0.02, 0.09, 0.012, 3e-3), { p: [Q[0] + 0.03, Q[1] + 0.06, Q[2] + 0.04], r: [0.9, 0, 0] }, 0.8);
  }
  t.add("rope", Fn(T, 9e-3, 4, false, 0.5), null, 0.85);
  let G = [2.4, 1.5, 1.4], j = Math.max(...r.map((N) => N[4])) + 0.04;
  return t.finish({ size: G, colliders: [{ min: [-1.2, 0, -0.7], max: [1.2, j, 0.7], surface: "dirt" }] });
}
function eR(i, e, t, n) {
  let s = ev(eo(i, e, t, Math.min(e * 0.46, 0.075), 3, 3, 3), 3), o = n() * 9, r = n.range(-0.05, 0.05), a = n.range(0.4, 1);
  return to(s, (l) => {
    let c = l.x / (i / 2), u = l.z / (t / 2), h = l.y / (e / 2), f = 1 - 0.22 * Math.pow(Math.abs(c), 2.5);
    l.z *= f * (h < 0 ? 1.05 : 1), l.y = (l.y + e / 2) * (1 - 0.3 * Math.pow(Math.abs(c), 3)) - e / 2, h > 0 && (l.y += 0.016 * Math.cos(tt * c) * Math.cos(tt * u)), l.y -= a * 0.018 * Math.abs(c) * Math.abs(c) * (h > -0.9 ? 1 : 0) + r * l.x * 0.3;
    let p = gn(l.x * 9 + o, l.y * 9, l.z * 9 + o) - 0.5;
    l.x += p * 0.014, l.z += p * 0.016, h > -0.9 && (l.y += p * 0.014);
  }), gr(s);
}
function tR(i, e) {
  let t = new Kn(i, "sandbags", e.seed || 0), n = t.rng, s = 0.18, o = zi(e.courses | 0 || 5, 1, 7), r = t.mat(K3[0], K3[1]), a = (l, c, u, h) => {
    let f = s * n.range(1.02, 1.12), p = n() < 0.3 ? n.range(0.55, 0.75) : n.range(0.82, 1), d = n() * 30, v = { p: [u[0] + n.range(-0.012, 0.012), u[1] + f / 2 - 4e-3, u[2] + n.range(-0.012, 0.012)], r: [n.range(-0.03, 0.03), h + n.range(-0.06, 0.06), 0] };
    t.add(r, eR(l, f, c, n), v, (g, x, y) => {
      let b = gn(g * 7 + d, x * 7, y * 7);
      return [p * (0.85 + 0.15 * b), p * (0.84 + 0.15 * b), p * (0.8 + 0.16 * b)];
    });
    for (let g of [1, -1]) t.add(r, vr([[g * (l / 2 - 4e-3), n.range(-8e-3, 8e-3), -c * 0.27], [g * (l / 2 - 2e-3), n.range(-8e-3, 8e-3), c * 0.27]], [g * 9e-3, 1e-3, 0]), v, p * 0.9);
  };
  for (let l = 0; l < o; l++) {
    let c = l * s, u = l === o - 1;
    if (l % 2 === 0) for (let h = 0; h < 3; h++) for (let f of [1, -1]) u && h === 2 && f === 1 && o > 2 || a(0.655, 0.3, [(h - 1) * 0.655, c, f * 0.148], 0);
    else for (let h = 0; h < 5; h++) u && h === 0 && o > 2 || a(0.585, 0.385, [(h - 2) * 0.392, c, 0], tt);
  }
  return t.finish({ size: [2, o * s, 0.6], surface: "dirt" });
}
var K3 = ["glove_fabric", { color: 9207134 }];
function Oc(i, e, t, n, s, { crush: o = 0, damp: r = 0.3, open: a = false, tape: l = true, label: c = "", arrow: u = false, tint: h = 1 } = {}) {
  let f = i.rng, p = i.G, d = f() * 40;
  i.push(s);
  let v = (_) => {
    if (!o) return;
    let M = zi(_.y / t, 0, 1), E = M * M;
    _.y -= o * t * 0.32 * E * (0.55 + 0.45 * Math.cos(At * _.x / e * 0.9 + 0.5)) * (0.8 + 0.2 * Math.cos(At * _.z / n)), _.z *= 1 + 0.1 * o * Math.sin(At * M), _.x += 0.12 * o * t * M + 0.02 * o * Math.sin(At * M) * Math.sign(_.x);
  }, g = eo(e, t, n, 7e-3, 4, 5, 4, "bottom");
  a && ev(g, 2), o && (to(g, v), gr(g));
  let x = r * t, y = (_, M, E) => {
    let w = gn(_ * 6 + d, M * 3, E * 6 + d), S = Q3(x - 0.03, x + 0.04, M + 0.08 * (w - 0.5)), z = (0.86 + 0.14 * gn(_ * 13, M * 13 + d, E * 13)) * h;
    return [z * (0.5 + 0.5 * S), z * (0.47 + 0.53 * S), z * (0.42 + 0.58 * S)];
  };
  {
    let _ = g.attributes.position, M = new Float32Array(_.count * 3);
    for (let E = 0; E < _.count; E++) {
      let w = y(_.getX(E), _.getY(E), _.getZ(E));
      M[E * 3] = w[0], M[E * 3 + 1] = w[1], M[E * 3 + 2] = w[2];
    }
    g.setAttribute("color", new THREE.BufferAttribute(M, 3));
  }
  i.add("cardboard", g);
  let b = 25e-4;
  if (a) {
    let _ = Math.min(0.16, t * 0.6);
    i.add("cardboard", nv(e - 0.012, n - 0.012), { p: [0, t - _, 0], r: [-tt, 0, 0] }, 0.45 * h);
    for (let [E, w, S] of [[0, e, n / 2], [At, e, n / 2], [tt, n, e / 2], [-tt, n, e / 2]]) i.add("cardboard", M1(nv(w - 0.012, _)), { p: [Math.sin(E) * (S - 6e-3), t - _ / 2, Math.cos(E) * (S - 6e-3)], r: [0, E, 0] }, 0.55 * h);
    let M = (E, w, S) => {
      let z = Math.sin(S), H = Math.cos(S);
      return [E, w, z, H];
    };
    for (let E of [1, -1]) {
      let w = f.range(0.3, 1.9), S = n / 2 - 0.01;
      i.add("cardboard", vr([[0, t, E * n / 2], [0, t + Math.sin(w) * S * 0.5, E * (n / 2 + Math.cos(w) * S * 0.5)], [0, t + Math.sin(w) * S, E * (n / 2 + Math.cos(w) * S + 0.01)]], [e / 2 - 4e-3, 0, 0]), null, 0.9 * h);
    }
    for (let E of [1, -1]) {
      let w = f.range(0.9, 2.3), S = n / 2 - 0.02;
      i.add("cardboard", vr([[E * e / 2, t, 0], [E * (e / 2 + Math.cos(w) * S), t + Math.sin(w) * S, 0]], [0, 0, n / 2 - 4e-3]), null, 0.82 * h);
    }
  } else if (l) {
    let M = [];
    M.push([-e / 2 - b, t - 0.075, 0]);
    for (let w = 0; w <= 8; w++) M.push([(-0.5 + w / 8) * (e + 2 * b), t + b, 0]);
    M.push([e / 2 + b, t - 0.075, 0]);
    let E = new THREE.Vector3();
    for (let w of M) E.set(w[0], w[1], w[2]), v(E), w[0] = E.x, w[1] = E.y + (o ? 4e-3 : 0), w[2] = E.z;
    i.add("polymer_tan", vr(M, [0, 0, 0.025], false), null, 0.9);
  }
  let m = n / 2 + b, A = Math.min(0.055, t * 0.2);
  if (c && !o && (i.label(c, { color: "black", font: "sans", distress: 0.3 }, e * 0.6, A, { p: [-e * 0.1, t * 0.62, m] }), i.add("paint_white", nv(0.11, 0.075), { p: [e * 0.26, t * 0.3, m - 1e-3] }, 0.9, { cast: false }), i.decal(p.mats.decal("numbers_0_9"), 0.095, { p: [e * 0.26, t * 0.3, m + 6e-4] })), u && !o) for (let _ of [1, -1]) i.decal(p.mats.decal("arrow"), Math.min(0.09, t * 0.3), { p: [_ * (e / 2 + b), t * 0.55, _ * n * 0.2], r: [0, _ * tt, tt] });
  i.pop();
}
function nR(i, e) {
  let t = new Kn(i, "cardboard_boxes", e.seed || 0), n = t.rng, s = () => n.range(-0.015, 0.015), o = () => n.range(0.82, 1);
  return Oc(t, 0.5, 0.38, 0.44, { p: [-0.23 + s(), 0, -0.16 + s()], r: [0, n.range(-0.05, 0.05), 0] }, { damp: 0.45, label: "FRAGILE", arrow: true, tint: o() }), Oc(t, 0.42, 0.33, 0.4, { p: [0.26 + s(), 0, -0.17 + s()], r: [0, n.range(-0.08, 0.08), 0] }, { damp: 0.5, label: "KEEP DRY", tint: o() }), Oc(t, 0.46, 0.28, 0.4, { p: [-0.24 + s(), 0.38, -0.15 + s()], r: [0, n.range(-0.2, 0.2), 0] }, { crush: 1, damp: 0.75, tint: o() * 0.92 }), Oc(t, 0.33, 0.26, 0.32, { p: [0.27 + s(), 0.33, -0.18 + s()], r: [0, n.range(-0.3, 0.3), 0] }, { open: true, damp: 0.1, label: "", arrow: true, tint: o() }), Oc(t, 0.3, 0.16, 0.24, { p: [-0.26 + s(), 0.565, -0.16 + s()], r: [0.03, n.range(-0.5, 0.5), -0.09] }, { damp: 0.2, label: "HX-2291", tint: o() }), Oc(t, 0.36, 0.26, 0.3, { p: [0.06 + s(), 0.105, 0.2], r: [0.62, n.range(-0.25, 0.25), 0] }, { damp: 0.9, crush: 0.25, tint: o() * 0.85 }), t.finish();
}
function eb(i) {
  i("tarp_cargo", (e, t = {}) => QA(e, t)), i("sandbags", (e, t = {}) => tR(e, t)), i("cardboard_boxes", (e, t = {}) => nR(e, t));
}
var tb = new THREE.Quaternion(), iR = new THREE.Vector3(0, 1, 0), T1 = new THREE.Vector3(), nb = new THREE.Matrix4();
function zr(i, e, t, n, s = 6e-3, o = false) {
  T1.set(e[0] - i[0], e[1] - i[1], e[2] - i[2]);
  let r = T1.length();
  T1.normalize();
  let a = o ? $e(t, r, n) : Ge(t, r, n, s);
  return tb.setFromUnitVectors(iR, T1), nb.compose(new THREE.Vector3((i[0] + e[0]) / 2, (i[1] + e[1]) / 2, (i[2] + e[2]) / 2), tb, new THREE.Vector3(1, 1, 1)), a.applyMatrix4(nb), a;
}
var sR = (i) => {
  let e = 0;
  for (let t = 0; t < i.length; t++) {
    let n = i[t], s = i[(t + 1) % i.length];
    e += n[0] * s[1] - s[0] * n[1];
  }
  return e < 0 ? i.slice().reverse() : i;
};
function ib(i, e, t, n, s, o, r, a, l, c) {
  let u = tv(t, n, r, a);
  i.push({ p: [e, t, o > 0 ? s - n / 2 : -(s - n / 2)], r: [o > 0 ? tt : -tt, 0, 0] }), i.push({ r: [0, c() * 6, 0] });
  let h = c() * 20;
  i.add("tire", u, null, (p, d, v) => {
    let g = Math.hypot(p, v);
    return g < r + 0.01 ? 0.45 : 0.78 + 0.22 * gn(Math.atan2(v, p) * 3 + h, g * 30);
  });
  let f = n * 0.8;
  i.add("paint_yellow", us([[r + 6e-3, f + 0.012], [r - 0.012, f + 0.016], [r - 0.03, f - 0.02], [r * 0.62, f - 0.05], [r * 0.5, f - 0.02], [r * 0.42, f - 0.012], [0, f - 0.012]], 14), null, (p, d, v) => Math.hypot(p, v) > r * 0.7 ? [0.55, 0.5, 0.42] : [0.8, 0.78, 0.7]), i.add("steel_dark", us([[0, n * 0.2], [r + 4e-3, n * 0.2]], 10), null, 0.4), i.add("steel_dark", ot(r * 0.2, r * 0.24, 0.035, 8), { p: [0, f, 0] }, 0.7);
  for (let p = 0; p < 6; p++) {
    let d = p * At / 3;
    i.add("steel_galv", ot(0.011, 0.012, 0.016, 6), { p: [Math.cos(d) * r * 0.33, f - 6e-3, Math.sin(d) * r * 0.33] }, c.range(0.5, 0.8));
  }
  i.pop(), i.pop();
}
function oR(i, e) {
  let t = new Kn(i, "forklift", e.seed || 0), n = t.rng, s = zi(+e.forksUp || 0, 0, 1), o = s * 1.5, r = o / 2, [a, l] = Ja(e.color, "yellow"), c = (K = 1) => typeof l == "number" ? l * K : l.map((ie) => ie * K), u = "steel_dark", h = () => n.range(0.68, 0.95), f = e.number || ["04", "07", "12", "22"][t.seed % 4], p = 0.33, d = 0.23, v = 0.22, g = 0.47, x = 0.27, y = 0.18, b = -1.1, m = 0.46;
  for (let K of [1, -1]) ib(t, v, p, d, g, K, 0.195, 24, 0, n), ib(t, b, x, y, m, K, 0.155, 20, 0, n);
  t.add(u, vn([v, p, -0.4], [v, p, 0.4], 0.07, 8), null, 0.5), t.add(u, Ge(0.12, 0.1, 0.78, 0.01), { p: [b, x, 0] }, 0.5), t.add(u, Ge(1.95, 0.34, 0.68, 0.02), { p: [-0.425, 0.37, 0] }, 0.55);
  for (let K of [1, -1]) {
    t.add(a, Ge(0.6, 0.3, 0.17, 0.02), { p: [-0.47, 0.4, K * 0.42] }, c(0.92)), t.add("diamond_plate", Ge(0.3, 0.012, 0.16, 3e-3), { p: [-0.32, 0.556, K * 0.42] }, 0.7), t.add(u, ot(0.03, 0.03, 0.02, 8), { p: [-0.62, 0.56, K * 0.42] }, 0.6);
    let ie = [], F = p + 0.035, X = p + 0.06;
    for (let ne = 0; ne <= 7; ne++) {
      let re = 0.12 + (At - 0.5) * ne / 7;
      ie.push([v + Math.cos(re) * X, p + Math.sin(re) * X]);
    }
    for (let ne = 7; ne >= 0; ne--) {
      let re = 0.12 + (At - 0.5) * ne / 7;
      ie.push([v + Math.cos(re) * F, p + Math.sin(re) * F]);
    }
    t.add(a, Mo(ie, 0.27, { soft: 0.7 }), { p: [0, 0, K * 0.475] }, c(0.95));
  }
  t.add("diamond_plate", $e(0.66, 0.016, 0.68), { p: [0.2, 0.548, 0] }, 0.6);
  for (let K of [-0.12, 0.1]) t.add("rubber", Ge(0.1, 0.02, 0.07, 6e-3), { p: [0.33, 0.6, K], r: [0, 0, 0.5] }, 0.8);
  let A = eo(0.62, 0.63, 1.12, 0.12, 3, 3, 3);
  to(A, (K) => {
    if (K.y > 0.1) {
      let ie = (K.y - 0.1) / 0.215;
      K.x += 0.03 * ie * (K.x < 0 ? 1 : 0);
    }
  }), t.add(a, gr(A), { p: [-1.39, 0.915, 0] }, c(0.97)), t.add(a, Ge(0.56, 0.37, 0.64, 0.05), { p: [-1.4, 0.43, 0] }, c(0.85)), t.add("hazard_stripes", Ge(0.014, 0.085, 0.84, 4e-3), { p: [-1.702, 0.77, 0] }, 0.95), t.label(f, { color: "black", font: "stencil", distress: 0.35 }, 0.4, 0.2, { p: [-1.703, 0.96, 0], r: [0, -tt, 0] });
  for (let K of [1, -1]) t.add(i.mats.emissive(16722450, 0.16), Ge(0.012, 0.05, 0.11, 4e-3), { p: [-1.69, 1.1, K * 0.37] }, 1, { raw: true }), t.add(u, Ge(0.016, 0.066, 0.126, 4e-3), { p: [-1.684, 1.1, K * 0.37] }, 0.4), t.label("HALCYON", { color: "black", font: "sans", distress: 0.3 }, 0.42, 0.085, { p: [-1.39, 0.99, K * 0.5625], r: [0, K > 0 ? 0 : At, 0] }), t.add(u, Ge(0.06, 0.05, 0.02, 4e-3), { p: [-1.67, 0.44, K * 0.05] }, 0.5);
  t.add("steel_worn", ot(0.02, 0.02, 0.13, 8), { p: [-1.68, 0.44, 0] }, 0.7), t.add(a, Ge(0.98, 0.46, 0.94, 0.04), { p: [-0.59, 0.79, 0] }, c());
  for (let K of [1, -1]) {
    t.label(f, { color: "black", font: "stencil", distress: 0.35 }, 0.3, 0.19, { p: [-0.84, 0.8, K * 0.4715], r: [0, K > 0 ? 0 : At, 0] }), t.add(u, $e(0.34, 0.2, 4e-3), { p: [-0.36, 0.8, K * 0.47] }, 0.2);
    for (let ie = 0; ie < 5; ie++) t.add(a, $e(0.34, 0.03, 6e-3), { p: [-0.36, 0.72 + ie * 0.04, K * 0.474], r: [K * 0.5, 0, 0] }, c(0.85));
  }
  t.add(u, Ge(0.4, 0.05, 0.4, 0.01), { p: [-0.54, 1.045, 0] }, 0.5);
  let _ = eo(0.46, 0.1, 0.46, 0.04, 3, 3, 3);
  to(_, (K) => {
    K.y > 0 && (K.y -= 0.018 * Math.cos(K.x * 5) * Math.cos(K.z * 5));
  }), t.add("rubber", gr(_), { p: [-0.53, 1.115, 0] }, 1);
  let M = eo(0.1, 0.5, 0.44, 0.04, 3, 4, 3);
  to(M, (K) => {
    K.x > 0 && (K.x -= 0.02 * Math.cos(K.z * 5.5));
  }), t.add("rubber", gr(M), { p: [-0.8, 1.39, 0], r: [0, 0, 0.16] }, 1);
  for (let K of [1, -1]) t.add(u, zr([-0.78, 1.08, K * 0.24], [-0.82, 1.3, K * 0.24], 0.03, 0.012, 4e-3), null, 0.5);
  t.add(a, Mo([[0.2, 0.55], [0.54, 0.55], [0.54, 1], [0.46, 1.12], [0.3, 1.14], [0.21, 1.02]], 0.7, { soft: 0.5 }), null, c());
  let E = Math.atan2(0.12, 0.09);
  t.push({ p: [0.253, 1.082, 0], r: [0, 0, E] }), t.add(u, Ge(0.012, 0.13, 0.44, 4e-3), { p: [-6e-3, 0, 0] }, 0.45), t.add(i.mats.emissive(9429168, 0.3), _f(0.09, 0.05), { p: [-0.0135, 0.01, 0.1], r: [0, -tt, 0] }, 1, { raw: true, cast: false }), t.decal(i.mats.decal("csc_plate"), 0.09, { p: [-0.0135, 0, -0.12], r: [0, -tt, 0] }), t.add("plastic_red", ot(0.016, 0.016, 0.02, 8), { p: [-0.02, 0, 0.19], r: [0, 0, tt] }, 0.9), t.add("steel_bare", ot(9e-3, 9e-3, 0.02, 6), { p: [-0.018, -0.03, -0.01], r: [0, 0, tt] }, 0.9), t.pop();
  let w = [0.3, 1.1, 0.04], S = [0.1, 1.31, 0.04];
  t.add(u, vn(w, S, 0.024, 8), null, 0.5), t.push({ p: S, r: [0, 0, Math.atan2(S[1] - w[1], S[0] - w[0])] }), t.add("rubber", ja(0.165, 0.014, 6, 18), { r: [0, tt, 0] }, 1);
  for (let K = 0; K < 3; K++) {
    let ie = K * At * 2 / 3 + 0.5;
    t.add(u, vn([-0.01, 0, 0], [0, Math.cos(ie) * 0.16, Math.sin(ie) * 0.16], 9e-3, 5), null, 0.5);
  }
  t.add(u, ot(0.035, 0.04, 0.03, 10), { p: [-5e-3, 0, 0], r: [0, 0, tt] }, 0.5), t.add("rubber", ot(0.016, 0.014, 0.045, 8), { p: [0.03, 0.16, 0.02], r: [0, 0, tt] }, 1), t.pop();
  for (let K = 0; K < 3; K++) {
    let ie = -0.2 - K * 0.055, F = [0.33, 1.12, ie], X = [0.25 - K * 0.012, 1.3 - K * 0.01, ie - 0.01];
    t.add("steel_bare", vn(F, X, 7e-3, 5), null, 0.8), t.add("rubber", Y3(0.02, 7, 5), { p: X }, 1);
  }
  {
    let K = [0.3, 1.1, 0.27], ie = [0.2, 1.24, 0.29];
    t.add("steel_bare", vn(K, ie, 8e-3, 5), null, 0.8), t.add("plastic_red", ot(0.016, 0.016, 0.07, 7), { p: ie, r: [0, 0, 0.6] }, 0.9);
  }
  let z = 2.045, H = [];
  for (let K of [1, -1]) {
    let ie = [0.47, 1.08, K * 0.4], F = [0.27, z, K * 0.46], X = [-1, 1, K * 0.44], ne = [-0.95, z, K * 0.46];
    t.add(u, zr(ie, F, 0.06, 0.05, 0.01), null, h()), t.add(u, zr(X, ne, 0.06, 0.05, 0.01), null, h()), t.add(u, zr([0.3, z, K * 0.46], [-0.98, z, K * 0.46], 0.05, 0.06, 0.01), null, h()), t.add(u, Ge(0.09, 0.012, 0.08, 3e-3), { p: [0.47, 1.085, K * 0.4] }, 0.5), t.add(u, Ge(0.09, 0.012, 0.08, 3e-3), { p: [-1, 1.024, K * 0.44] }, 0.5);
    let re = 0.36, $ = 1.66;
    t.add(u, eo(0.085, 0.1, 0.13, 0.02, 3, 3, 3), { p: [re + 0.045, $, K * 0.47] }, 0.45), t.add(i.mats.emissive(16773330, 0.7), Ge(6e-3, 0.075, 0.105, 2e-3), { p: [re + 0.089, $, K * 0.47] }, 1, { raw: true }), t.add(u, vn([0.385, 1.5, K * 0.42], [0.42, 1.52, K * 0.57], 8e-3, 5), null, 0.5), t.add(u, Ge(0.022, 0.17, 0.1, 6e-3), { p: [0.42, 1.52, K * 0.573], r: [0, K * 0.25, 0] }, 0.5), t.add("steel_bare", $e(2e-3, 0.15, 0.084), { p: [0.408, 1.52, K * 0.57], r: [0, K * 0.25, 0] }, 1), H.push({ min: [-1.03, 1, K > 0 ? 0.41 : -0.5], max: [-0.92, z, K > 0 ? 0.5 : -0.41], surface: "metal" }, { min: [0.24, 1.08, K > 0 ? 0.37 : -0.5], max: [0.5, z, K > 0 ? 0.5 : -0.37], surface: "metal" });
  }
  for (let K of [0.28, -0.96]) t.add(u, Ge(0.05, 0.06, 0.92, 0.01), { p: [K, z, 0] }, h());
  for (let K = 0; K < 8; K++) t.add(u, Ge(0.03, 0.028, 0.9, 6e-3), { p: [-0.83 + K * 0.139, z + 0.012, 0] }, h());
  t.add(u, Fn([[0.44, 1.2, 0.44], [0.47, 1.25, 0.49], [0.41, 1.55, 0.5], [0.36, 1.6, 0.455]], 0.011, 5, false, 0.5), null, 0.5), t.add(u, ot(0.045, 0.05, 0.03, 10), { p: [-0.86, z + 0.045, 0.3] }, 0.5), t.add(i.mats.emissive(16747026, 0.9), us([[0.04, 0], [0.04, 0.06], [0.03, 0.082], [0, 0.09]], 10), { p: [-0.86, z + 0.06, 0.3] }, 1, { raw: true });
  let O = -1.4, q = 1.23 + 0.05 + 0.155;
  for (let K of [-0.2, 0.2]) t.add(u, Ge(0.3, 0.07, 0.04, 8e-3), { p: [O, 1.262, K] }, 0.5), t.add(u, ot(0.159, 0.159, 0.035, 16, true), { p: [O, q, K], r: [tt, 0, 0] }, 0.35);
  t.add("steel_galv", us([[0, -0.37], [0.08, -0.36], [0.132, -0.33], [0.155, -0.27], [0.155, 0.27], [0.132, 0.33], [0.08, 0.36], [0, 0.37]], 16), { p: [O, q, 0], r: [tt, 0, 0] }, (K, ie, F) => 0.8 + 0.2 * gn(K * 8, ie * 8, F * 8)), t.add("steel_galv", ot(0.09, 0.09, 0.07, 12, true), { p: [O, q, 0.39], r: [tt, 0, 0] }, 0.7), t.add("steel_galv", ot(0.02, 0.02, 0.05, 8), { p: [O, q, 0.39], r: [tt, 0, 0] }, 0.9), t.add("rubber", Fn([[O, q, 0.41], [O + 0.05, q - 0.02, 0.46], [O + 0.2, q - 0.15, 0.44], [-1.07, 1.1, 0.38], [-1, 0.98, 0.36]], 0.012, 5, false, 0.5), null, 1), t.push({ p: [O, q, 0], r: [0, 0, 0.7] }), t.cdecal(i.mats.decal("hazard_flammable"), 0.157, 0.12, { p: [0, 0, -0.05], r: [-tt, 0, 0] }), t.cdecal(i.mats.label("LPG", { color: "red", font: "stencil", distress: 0.3 }), 0.157, 0.16, { p: [0, 0, 0.14], r: [-tt, 0, 0] }), t.pop();
  let U = 0.6, T = 0.73, D = 0.375, C = 0.08, G = 2.02;
  for (let K of [1, -1]) {
    let ie = K * D, F = [[U, ie], [T, ie], [T, ie - K * 0.065], [T - 0.014, ie - K * 0.065], [T - 0.014, ie - K * 0.014], [U + 0.014, ie - K * 0.014], [U + 0.014, ie - K * 0.065], [U, ie - K * 0.065]];
    t.add(u, Mo(sR(F.map((P) => [P[0], -P[1]])), G - C, { soft: 0 }), { p: [0, (C + G) / 2, 0], r: [-tt, 0, 0] }, h()), t.add(u, Ge(0.085, 1.86, 0.036, 6e-3), { p: [0.665, 0.13 + r + 0.93, K * 0.335] }, h() * 1.25), t.decal(i.mats.decal("hazard_general"), 0.1, { p: [0.665, 1.3, K * (D + 2e-3)], r: [0, K > 0 ? 0 : At, 0] });
    let X = [0.36, 0.66, K * 0.3], ne = [0.6, 0.86, K * 0.33], re = [0.5, 0.777, K * 0.317];
    t.add(u, vn(X, re, 0.034, 8, true), null, 0.55), t.add("steel_bare", vn(re, ne, 0.018, 6), null, 1);
    let $ = K * 0.13, ue = 1.9 + r, me = 0.055, ee = [[0.725, 0.5 + o, $], [0.725, ue, $]];
    for (let P = 0.5; P < At; P += 0.55) ee.push([0.67 + Math.cos(P) * me, ue + Math.sin(P) * me, $]);
    ee.push([0.615, ue, $], [0.615, 1, $]);
    let B = 0;
    for (let P = 0; P < ee.length - 1; P++) {
      let V = ee[P], Y = ee[P + 1], L = Math.hypot(Y[0] - V[0], Y[1] - V[1]), Z = Math.max(1, Math.round(L / 0.058));
      for (let J = 0; J < Z; J++, B++) {
        let oe = J / Z, fe = (J + 0.86) / Z, le = (R) => [V[0] + (Y[0] - V[0]) * R, V[1] + (Y[1] - V[1]) * R, $];
        t.add("steel_worn", zr(le(oe), le(fe), 0.011, B % 2 ? 0.034 : 0.022, 0, true), null, B % 2 ? 0.55 : 0.75);
      }
    }
    t.add(u, ot(me - 6e-3, me - 6e-3, 0.04, 12), { p: [0.67, ue, $], r: [tt, 0, 0] }, 0.7);
  }
  t.add(u, Ge(0.04, 0.09, 0.78, 8e-3), { p: [U - 0.012, 1.96, 0] }, h()), t.add(u, Ge(0.04, 0.12, 0.78, 8e-3), { p: [U - 0.012, 0.42, 0] }, h()), t.add(u, Ge(0.07, 0.09, 0.66, 8e-3), { p: [0.665, 1.99 + r, 0] }, h()), t.add(u, ot(0.048, 0.048, 1.15, 10), { p: [0.645, 0.72, 0] }, 0.6), t.add(u, ot(0.055, 0.055, 0.05, 10), { p: [0.645, 1.3, 0] }, 0.5), t.add("steel_bare", ot(0.027, 0.027, 0.64 + r, 8, true), { p: [0.645, 1.31 + (0.64 + r) / 2, 0] }, 1), t.label("MAX 2500 kg", { color: "yellow", font: "stencil", distress: 0.3 }, 0.5, 0.05, { p: [U - 0.033, 0.42, 0], r: [0, -tt, 0] });
  for (let K of [0.21, 0.245]) t.add("rubber", Fn([[0.6, 1.25, K], [0.59, 1.65 + r * 0.6, K], [0.655, 1.86 + r, K + 5e-3], [0.735, 1.6 + r * 1.2, K], [0.74, 0.56 + o, K]], 0.011, 5, false, 0.5), null, 1);
  t.push({ p: [0, o, 0] });
  let j = 0.06;
  for (let K of [j + 0.12, j + 0.5]) t.add(u, Ge(0.04, 0.1, 1.02, 8e-3), { p: [0.755, K, 0] }, h());
  t.add("hazard_stripes", $e(3e-3, 0.06, 0.4), { p: [0.7765, j + 0.5, 0] }, 0.9);
  for (let K of [1, -1]) t.add(u, Ge(0.03, 0.5, 0.06, 6e-3), { p: [0.745, j + 0.31, K * 0.3] }, h()), t.add(u, Ge(0.11, 0.36, 0.022, 5e-3), { p: [0.685, j + 0.31, K * 0.305] }, h()), t.add(u, Ge(0.03, 0.78, 0.04, 6e-3), { p: [0.755, j + 0.94, K * 0.5] }, h()), t.add("steel_worn", ot(0.04, 0.04, 0.03, 10), { p: [0.67, j + 0.2, K * 0.325], r: [tt, 0, 0] }, 0.7);
  t.add(u, Ge(0.03, 0.04, 1.04, 6e-3), { p: [0.755, j + 1.33, 0] }, h()), t.add(u, Ge(0.02, 0.03, 1, 4e-3), { p: [0.755, j + 0.94, 0] }, h());
  for (let K = -2; K <= 2; K++) t.add(u, Ge(0.02, 0.76, 0.02, 4e-3), { p: [0.755, j + 0.94, K * 0.165] }, h());
  let N = 0.035;
  for (let K of [1, -1]) {
    let ie = Mo([[0.777, N], [1.45, N], [1.7, N + 6e-3], [1.7, N + 0.016], [0.87, N + 0.046], [0.826, N + 0.075], [0.822, N + 0.62], [0.777, N + 0.62]], 0.1, { soft: 0.45 });
    t.add("steel_worn", ie, { p: [0, 0, K * 0.26] }, (F, X, ne) => {
      let re = zi((F - 0.8) / 0.9, 0, 1), $ = gn(F * 14, ne * 30 + K);
      return (0.5 + 0.5 * re) * (0.8 + 0.2 * $);
    }), t.add(u, Ge(0.075, 0.05, 0.112, 6e-3), { p: [0.772, j + 0.575, K * 0.26] }, 0.55), t.add(u, Ge(0.03, 0.04, 0.112, 6e-3), { p: [0.79, j + 0.07, K * 0.26] }, 0.55);
  }
  t.pop();
  let Q = Math.max(2.2, 0.06 + o + 1.36, 2.04 + r);
  return t.finish({ size: [3.4, Q, 1.25], colliders: [{ min: [-1.7, 0, -0.6], max: [0.58, 1.24, 0.6], surface: "metal" }, { min: [-1.56, 1.24, -0.4], max: [-1.22, 1.6, 0.4], surface: "metal" }, { min: [-0.88, 1.24, -0.24], max: [-0.7, 1.66, 0.24], surface: "rubber" }, { min: [0.56, 0, -0.42], max: [0.78, 2.04 + r, 0.42], surface: "metal" }, { min: [0.72, o, -0.53], max: [0.8, o + 1.42, 0.53], surface: "metal" }, { min: [0.8, o, -0.33], max: [1.7, o + 0.1, 0.33], surface: "metal" }, { min: [-1.02, 2, -0.5], max: [0.32, 2.1, 0.5], surface: "metal" }, ...H] });
}
function rR(i, e) {
  let t = new Kn(i, "generator", e.seed || 0), n = t.rng, [s, o] = Ja(e.color, "yellow"), r = (m = 1) => typeof o == "number" ? o * m : o.map((A) => A * m), a = "steel_dark", l = 0.46, c = 1.03, u = 0.3, h = 1.16, f = (u + h) / 2;
  for (let m of [1, -1]) {
    t.add(a, Ge(2.2, 0.14, 0.1, 0.012), { p: [0, 0.07, m * 0.4] }, 0.6);
    for (let A of [-0.45, 0.45]) t.add(a, $e(0.22, 0.075, 4e-3), { p: [A, 0.075, m * 0.451] }, 0.12);
  }
  for (let m of [-0.85, 0, 0.85]) t.add(a, $e(0.1, 0.1, 0.72), { p: [m, 0.07, 0] }, 0.55);
  t.add(a, Ge(2.1, 0.17, 0.94, 0.012), { p: [0, 0.215, 0] }, 0.8), t.add(s, Ge(2.06, h - u, l * 2, 0.025), { p: [0, f, 0] }, r()), t.add(s, Ge(2.13, 0.045, 0.99, 0.014), { p: [0, h + 0.02, 0] }, r(0.9));
  for (let m of [-0.52, 0.52]) t.add(s, $e(0.04, 0.012, 0.95), { p: [m, h + 0.046, 0] }, r(0.85));
  for (let m of [1, -1]) {
    let A = m > 0 ? 0 : At;
    [-0.66, 0, 0.66].forEach((_, M) => {
      t.add(s, Ge(0.62, 0.72, 0.012, 6e-3), { p: [_, f + 0.01, m * (l + 4e-3)] }, r(n.range(0.9, 1))), t.add(a, $e(0.03, 0.11, 0.016), { p: [_ + 0.27, f, m * (l + 0.012)] }, 0.6), t.add("steel_galv", $e(0.012, 0.03, 6e-3), { p: [_ + 0.27, f + 0.03, m * (l + 0.022)] }, 0.8);
      for (let E of [-0.25, 0.25]) t.add("steel_galv", ot(9e-3, 9e-3, 0.06, 5, true), { p: [_ - 0.305, f + E, m * (l + 0.012)] }, 0.7);
      if (M > 0) {
        let E = M === 2 ? 8 : 5, w = 0.42, S = M === 2 ? f + 0.14 : f - 0.16;
        t.add(a, $e(w, E * 0.05, 4e-3), { p: [_ - 0.03, S, m * (l + 0.0105)] }, 0.12);
        for (let z = 0; z < E; z++) t.add(s, $e(w, 0.04, 5e-3), { p: [_ - 0.03, S + (z - (E - 1) / 2) * 0.05, m * (l + 0.018)], r: [m * 0.6, 0, 0] }, r(0.82));
        M === 2 && t.decal(i.mats.decal("rust_run"), 0.3, { p: [_ - 0.03, S - 0.36, m * (l + 0.011)], r: [0, A, 0] });
      }
    }), t.label(e.label || "GEN-0" + (1 + t.seed % 2), { color: "black", font: "stencil", distress: 0.35 }, 0.5, 0.13, { p: [-0.66 * m, f + 0.17, m * (l + 0.0108)], r: [0, A, 0] }), t.decal(i.mats.decal("hazard_voltage"), 0.15, { p: [-0.66 * m - m * 0.18, f - 0.17, m * (l + 0.0108)], r: [0, A, 0] });
  }
  t.add(a, $e(4e-3, 0.66, 0.74), { p: [c + 1e-3, f, 0] }, 0.1);
  for (let m = 0; m < 11; m++) t.add(s, $e(6e-3, 0.046, 0.74), { p: [c + 0.012, f - 0.3 + m * 0.06, 0], r: [0, 0, -0.6] }, r(0.8));
  for (let m of [1, -1]) t.add(s, $e(0.03, 0.72, 0.03), { p: [c + 0.012, f, m * 0.385] }, r(0.9)), t.add(s, $e(0.03, 0.03, 0.8), { p: [c + 0.012, f + m * 0.345, 0] }, r(0.9));
  let p = -c - 4e-3, d = 0.14;
  t.add(a, Ge(0.01, 0.44, 0.52, 4e-3), { p: [p, 0.87, d] }, 0.45), t.add(s, Ge(0.075, 0.014, 0.56, 4e-3), { p: [p - 0.03, 1.1, d], r: [0, 0, 0.12] }, r(0.9));
  for (let m of [1, -1]) t.add(s, $e(0.06, 0.44, 0.012), { p: [p - 0.025, 0.87, d + m * 0.268] }, r(0.9));
  let v = p - 55e-4, g = [0, -tt, 0];
  t.add(i.mats.emissive(8840104, 0.32), _f(0.13, 0.07), { p: [v - 1e-3, 0.99, d - 0.12], r: g }, 1, { raw: true, cast: false }), t.add(a, Ge(8e-3, 0.09, 0.15, 3e-3), { p: [v + 3e-3, 0.99, d - 0.12] }, 0.3), t.add("steel_galv", ot(0.02, 0.02, 0.012, 10), { p: [v - 4e-3, 1, d + 0.19], r: [0, 0, tt] }, 0.7), t.add(i.mats.emissive(4063082, 3.2), ot(0.013, 0.013, 0.014, 10), { p: [v - 9e-3, 1, d + 0.19], r: [0, 0, tt] }, 1, { raw: true }), t.add(s, ot(0.042, 0.042, 6e-3, 12), { p: [v - 3e-3, 0.8, d + 0.17], r: [0, 0, tt] }, 1), t.add("plastic_red", us([[0, 0], [0.018, 0], [0.018, 0.018], [0.03, 0.02], [0.03, 0.034], [0.02, 0.042], [0, 0.044]], 10), { p: [v - 4e-3, 0.8, d + 0.17], r: [0, 0, tt] }, 0.95);
  for (let m = 0; m < 3; m++) {
    let A = d - 0.2 + m * 0.105;
    t.add("aluminium", ot(0.04, 0.042, 0.012, 10), { p: [v - 4e-3, 0.86, A], r: [0, 0, tt] }, 0.8), t.add("aluminium", ot(0.034, 0.034, 2e-3, 10), { p: [v - 0.0105, 0.86, A], r: [0, 0, tt] }, 1), t.add(a, $e(2e-3, 0.028, 4e-3), { p: [v - 0.0125, 0.868, A + 5e-3], r: [n.range(-1, 1), 0, 0] }, 0.3);
  }
  for (let m = 0; m < 5; m++) t.add(m === 0 ? "plastic_red" : a, $e(0.014, 0.04, 0.022), { p: [v - 6e-3, 0.74, d - 0.2 + m * 0.03], r: [0, 0, n() < 0.5 ? 0.25 : -0.25] }, 0.8);
  t.decal(i.mats.decal("hazard_voltage"), 0.13, { p: [-c - 2e-3, 0.95, -0.28], r: g }), t.label("DANGER", { color: "red", font: "stencil", distress: 0.3 }, 0.22, 0.05, { p: [-c - 2e-3, 0.82, -0.28], r: g });
  let x = [["plastic_red", 0.02], ["plastic_blue", 0.2], ["plastic_blue", -0.25]];
  for (let [m, A] of x) t.add(a, Ge(0.02, 0.12, 0.1, 6e-3), { p: [-c - 8e-3, 0.5, A] }, 0.4), t.add(m, vn([-c - 0.01, 0.5, A], [-c - 0.06, 0.47, A], 0.036, 10, true), null, 0.9);
  t.add("plastic_blue", vn([-c - 0.06, 0.47, 0.2], [-c - 0.068, 0.39, 0.2], 0.03, 8, true, 0.02), null, 0.85), t.add("rubber", Fn([[-c - 0.066, 0.4, 0.2], [-c - 0.064, 0.25, 0.21], [-c - 0.05, 0.06, 0.26], [-c + 0.05, 0.016, 0.4], [-c + 0.3, 0.016, 0.478], [-0.35, 0.016, 0.486]], 0.014, 5, false, 0.5), null, 1);
  let y = h + 0.0425;
  t.add(a, Ge(0.2, 0.012, 0.14, 4e-3), { p: [0, y + 4e-3, 0] }, 0.6), t.add("steel_galv", ja(0.045, 0.014, 5, 10), { p: [0, y + 0.058, 0] }, 0.7);
  let b = [0.72, y, 0.24];
  return t.add("steel_rust", ot(0.062, 0.066, 0.025, 12), { p: [b[0], y + 0.012, b[2]] }, 0.6), t.add("steel_rust", ot(0.04, 0.04, 0.17, 12, true), { p: [b[0], y + 0.085, b[2]] }, (m, A) => 0.45 + 0.55 * zi((y + 0.17 - A) / 0.17, 0, 1)), t.add("steel_rust", ot(0.034, 0.034, 2e-3, 10), { p: [b[0], y + 0.15, b[2]] }, 0.08), t.add("steel_rust", ot(0.046, 0.046, 5e-3, 12), { p: [b[0] - 0.012, y + 0.186, b[2]], r: [0, 0, 0.5] }, 0.6), t.decal(i.mats.decal("scorch"), 0.3, { p: [b[0], y + 1e-3, b[2]], r: [-tt, 0, 0] }), t.add(a, vn([-0.72, 0.25, 0.46], [-0.72, 0.32, 0.5], 0.03, 8, true), null, 0.6), t.add("plastic_red", vn([-0.72, 0.32, 0.5], [-0.72, 0.338, 0.51], 0.037, 10, true), null, 0.9), t.decal(i.mats.decal("hazard_flammable"), 0.11, { p: [-0.52, 0.215, 0.4712] }), t.label("DIESEL", { color: "white", font: "stencil", distress: 0.4 }, 0.2, 0.05, { p: [-0.34, 0.215, 0.4712] }), t.finish({ colliders: [{ min: [-1.1, 0, -0.5], max: [1.1, 1.21, 0.5], surface: "metal" }] });
}
function aR(i, e) {
  let t = new Kn(i, "dumpster", e.seed || 0), n = t.rng, [s, o] = Ja(e.color, "green"), r = (M = 1) => typeof o == "number" ? o * M : o.map((E) => E * M), a = 0.89, l = 0.2, c = 1.12, u = 0.3, h = 0.5, f = -0.44, p = -0.5, d = 0.022, v = [[-h, c], [-u, l], [-f, l], [-p, c], [-p - d, c], [-f - d * 0.8, l + d], [-u + d * 0.8, l + d], [-h + d, c]], g = t.seed * 2.3;
  t.add(s, Mo(v, a * 2, { soft: 0 }), { r: [0, tt, 0] }, (M, E, w) => {
    let S = Math.abs(w) < 0.4 && E > l + 0.01 && E < c - 0.01 && Math.abs(M) < a - 0.01;
    return r(0.9 + 0.1 * gn(M * 3 + g, E * 3));
  });
  for (let M of [1, -1]) {
    t.add(s, Mo([[-h, c], [-u, l], [-f, l], [-p, c]], d, { soft: 0 }), { p: [M * (a - d / 2), 0, 0], r: [0, tt, 0] }, r(0.95)), t.add(s, Ge(0.05, 0.045, h - p + 0.04, 8e-3), { p: [M * a, c, 0] }, r(0.9));
    for (let E of [-0.22, 0.14]) t.add(s, Ge(0.03, 0.84, 0.05, 6e-3), { p: [M * (a + 0.012), 0.66, E] }, r(0.9));
    t.add(s, Ge(0.035, 0.1, 0.84, 8e-3), { p: [M * (a + 0.014), 0.93, 0] }, r(0.85)), t.add("steel_worn", vn([M * (a + 0.01), 0.93, 0.3], [M * (a + 0.065), 0.93, 0.3], 0.03, 10, true), null, 0.7), t.add("steel_worn", ot(0.042, 0.042, 8e-3, 10), { p: [M * (a + 0.064), 0.93, 0.3], r: [0, 0, tt] }, 0.6);
  }
  t.add(s, Ge(a * 2 + 0.04, 0.045, 0.05, 8e-3), { p: [0, c, h] }, r(0.9)), t.add(s, Ge(a * 2 + 0.04, 0.045, 0.05, 8e-3), { p: [0, c, p] }, r(0.9));
  let x = Math.atan2(h - u, c - l), y = Math.atan2(p - f, c - l);
  for (let M of [-0.6, -0.2, 0.2, 0.6]) t.add(s, zr([M, l + 0.03, u + 0.022], [M, c - 0.04, h + 0.012], 0.055, 0.03, 6e-3), null, r(0.9)), t.add(s, zr([M, l + 0.03, f - 0.016], [M, c - 0.04, p - 0.012], 0.055, 0.03, 6e-3), null, r(0.9));
  t.add(s, zr([-a, l + 0.5, u + 0.022 + 0.5 * (h - u) / (c - l)], [a, l + 0.5, u + 0.022 + 0.5 * (h - u) / (c - l)], 0.03, 0.06, 6e-3), { r: [0, 0, 0] }, r(0.88));
  let b = (M) => u + (M - l) * (h - u) / (c - l) + 3e-3;
  t.label(e.label || "B4 WASTE " + (11 + t.seed % 2), { color: "white", font: "stencil", distress: 0.5 }, 0.36, 0.09, { p: [-0.4, 0.93, b(0.93)], r: [-x, 0, 0] }), t.decal(i.mats.decal("grime_streak"), 0.36, { p: [0.4, 0.82, b(0.82)], r: [-x, 0, 0] }), t.decal(i.mats.decal("rust_run"), 0.3, { p: [0, 0.5, b(0.5)], r: [-x, 0, 0] }), t.decal(i.mats.decal("logo_c"), 0.26, { p: [0.4, 0.42, b(0.42)], r: [-x, 0, 0] }), t.decal(i.mats.decal("leak_stain"), 0.34, { p: [-0.4, 0.45, b(0.45)], r: [-x, 0, 0] });
  let m = c + 0.045, A = p - 0.02;
  t.add("steel_galv", vn([-a - 0.02, m, A], [a + 0.02, m, A], 0.013, 6, true), null, 0.7);
  let _ = (M, E) => {
    t.push({ p: [M, m, A], r: [E, 0, 0] });
    let w = 1.07, S = eo(0.885, 0.04, w, 0.016, 3, 3, 4);
    to(S, (H) => {
      H.y > 0 && (H.y += 0.018 * Math.cos(H.z / w * At) * Math.cos(H.x / 0.885 * At));
    }), S.computeVertexNormals();
    let z = n.range(0.75, 0.95);
    t.add("plastic_grey", S, { p: [0, 5e-3, w / 2] }, z);
    for (let H of [-0.26, 0.26]) t.add("plastic_grey", Ge(0.07, 0.016, w - 0.16, 6e-3), { p: [H, 0.036, w / 2] }, z * 0.9);
    t.add("plastic_grey", Ge(0.3, 0.035, 0.05, 0.01), { p: [0, 0.02, w + 0.01] }, z * 0.8);
    for (let H of [-0.3, 0.3]) t.add("plastic_grey", Ge(0.08, 0.03, 0.09, 8e-3), { p: [H, 5e-3, 0.03] }, z * 0.8);
    t.pop();
  };
  _(-0.45, 0), _(0.45, tt + 0.07 + n.range(0, 0.05));
  for (let [M, E, w, S] of [[0.45, 0.93, 0.05, 1], [0.66, 0.9, -0.24, 0.8], [0.22, 0.86, -0.2, 0.85]]) {
    let z = eo(0.46 * S, 0.4 * S, 0.42 * S, 0.17 * S, 3, 3, 3), H = n() * 20;
    to(z, (O) => {
      let q = gn(O.x * 9 + H, O.y * 9, O.z * 9) - 0.5;
      O.x += q * 0.06, O.z += q * 0.06, O.y += q * 0.04;
    }), t.add("polymer_black", gr(z), { p: [M, E, w], r: [n() * 0.5, n() * 6, 0] }, 0.8);
  }
  t.add("cardboard", vr([[0.2, 0.9, 0.2], [0.24, 1.14, 0.26], [0.3, 1.2, 0.33]], [0.16, 0, -0.05]), null, 0.7);
  for (let M of [-0.7, 0.7]) for (let E of [-0.3, 0.17]) {
    t.push({ p: [M, 0, E], r: [0, n() * 6, 0] }), t.add("steel_galv", Ge(0.13, 0.012, 0.11, 3e-3), { p: [0, 0.194, 0] }, 0.7);
    for (let w of [1, -1]) t.add("steel_galv", zr([0, 0.19, w * 0.034], [0.035, 0.08, w * 0.034], 0.05, 6e-3, 0, true), null, 0.65);
    t.add("rubber", ot(0.08, 0.08, 0.045, 14), { p: [0.035, 0.08, 0], r: [tt, 0, 0] }, 0.9), t.add("steel_galv", ot(0.035, 0.035, 0.05, 8), { p: [0.035, 0.08, 0], r: [tt, 0, 0] }, 0.6), t.pop();
  }
  return t.finish({ colliders: [{ min: [-0.95, 0.05, -0.56], max: [0.95, 1.2, 0.55], surface: "metal" }] });
}
function lR(i, e) {
  let t = new Kn(i, "toolbox_cart", e.seed || 0), n = t.rng, [s, o] = Ja(e.color, "red"), r = (y = 1) => typeof o == "number" ? o * y : o.map((b) => b * y), a = 0.04, l = 0.74, c = 0.125, u = 0.785, h = 0.23;
  t.add(s, Ge(l, u - c, h * 2, 0.012), { p: [a, (c + u) / 2, 0] }, r()), t.add("steel_dark", Ge(l + 0.01, 0.02, h * 2 + 0.01, 6e-3), { p: [a, c + 4e-3, 0] }, 0.5);
  let f = [0.075, 0.075, 0.1, 0.13, 0.19], p = 1 + t.seed % 3, d = u - 0.03;
  f.forEach((y, b) => {
    let m = b === p ? 0.05 : n() < 0.3 ? 4e-3 : 0, A = d - y / 2;
    if (t.add(s, Ge(l - 0.05, y - 0.01, 0.014, 4e-3), { p: [a, A, h + 5e-3 + m] }, r(n.range(0.9, 1))), t.add("aluminium", Ge(l - 0.09, 0.016, 0.016, 4e-3), { p: [a, A + y / 2 - 0.02, h + 0.019 + m] }, 0.85), m > 0.01) {
      t.add("steel_dark", $e(l - 0.07, y - 0.02, m), { p: [a, A, h + m / 2] }, 0.4), t.add("polymer_black", $e(l - 0.08, 4e-3, m), { p: [a, A + y / 2 - 0.012, h + m / 2] }, 0.3);
      for (let _ = 0; _ < 4; _++) t.add("steel_bare", vn([a - 0.25 + _ * 0.15, A + y / 2 - 0.016, h + 8e-3], [a - 0.23 + _ * 0.15, A + y / 2 - 0.014, h + m - 0.012], 7e-3, 5, true), null, 0.8);
    }
    d -= y;
  }), t.add("steel_bare", ot(0.011, 0.011, 8e-3, 8), { p: [a + l / 2 - 0.06, u - 0.016, h + 4e-3], r: [tt, 0, 0] }, 0.8), t.add("rubber", $e(l - 0.04, 6e-3, h * 2 - 0.04), { p: [a, u + 3e-3, 0] }, 0.9), t.add(s, Ge(l, 0.03, 0.014, 4e-3), { p: [a, u + 0.013, -h + 7e-3] }, r(0.95));
  for (let y of [1, -1]) t.add(s, Ge(0.014, 0.03, h * 2, 4e-3), { p: [a + y * (l / 2 - 7e-3), u + 0.013, 0] }, r(0.95));
  t.add("aluminium", Fn([[a - l / 2, 0.56, -0.17], [-0.41, 0.6, -0.17], [-0.435, 0.73, -0.17], [-0.435, 0.73, 0.17], [-0.41, 0.6, 0.17], [a - l / 2, 0.56, 0.17]], 0.012, 6, false, 0.2), null, 0.85);
  for (let y of [1, -1]) for (let b of [1, -1]) {
    t.push({ p: [a + y * (l / 2 - 0.07), 0, b * (h - 0.06)], r: [0, y > 0 ? n() * 6 : 0, 0] }), t.add("steel_galv", Ge(0.08, 8e-3, 0.07, 2e-3), { p: [0, 0.119, 0] }, 0.7);
    for (let m of [1, -1]) t.add("steel_galv", zr([0, 0.117, m * 0.022], [0.02, 0.05, m * 0.022], 0.035, 4e-3, 0, true), null, 0.65);
    t.add("rubber", ot(0.05, 0.05, 0.03, 12), { p: [0.02, 0.05, 0], r: [tt, 0, 0] }, 0.9), t.add("steel_galv", ot(0.02, 0.02, 0.034, 6), { p: [0.02, 0.05, 0], r: [tt, 0, 0] }, 0.6), t.pop();
  }
  t.label(e.label || "MAINT " + (1 + t.seed % 2), { color: "white", font: "stencil", distress: 0.4 }, 0.3, 0.07, { p: [a + l / 2 + 2e-3, 0.6, 0], r: [0, tt, 0] }), t.decal(i.mats.decal("logo_d"), 0.2, { p: [a + l / 2 + 2e-3, 0.42, 0], r: [0, tt, 0] }), t.decal(i.mats.decal("grime_streak"), 0.3, { p: [a, 0.45, -h - 2e-3], r: [0, At, 0] });
  let v = u + 6e-3;
  t.push({ p: [a - 0.18, v, 0.08], r: [0, 0.5, 0] }), t.add("steel_bare", Ge(0.2, 6e-3, 0.02, 2e-3), { p: [0, 4e-3, 0] }, 0.9), t.add("steel_bare", ja(0.016, 6e-3, 4, 10), { p: [0.11, 5e-3, 0], r: [tt, 0, 0] }, 0.9), t.add("steel_bare", ja(0.017, 6e-3, 4, 7, At * 1.4), { p: [-0.112, 5e-3, 0], r: [tt, 0, 2.2] }, 0.9), t.pop(), t.push({ p: [a + 0.02, v, -0.1], r: [0, -0.3, 0] }), t.add("wood_pallet", vn([-0.14, 0.014, 0], [0.12, 0.016, 0], 0.012, 6, true, 0.01), null, 0.9), t.add("steel_dark", Ge(0.032, 0.03, 0.1, 6e-3), { p: [0.125, 0.017, 5e-3] }, 0.8), t.pop(), t.push({ p: [a + 0.2, v, 0.1], r: [0, 0.12, 0] }), t.add("polymer_black", Ge(0.22, 0.014, 0.05, 4e-3), { p: [0, 7e-3, 0] }, 0.6);
  for (let y = 0; y < 6; y++) t.add("steel_bare", ot(8e-3 + y * 14e-4, 8e-3 + y * 14e-4, 0.03, 8), { p: [-0.085 + y * 0.034, 0.029, 0] }, 0.9);
  t.pop(), t.add("plastic_blue", ot(0.032, 0.032, 0.13, 12), { p: [a + 0.28, v + 0.065, -0.12] }, 0.9), t.add("steel_bare", us([[0.032, 0], [0.028, 0.012], [0.014, 0.018], [0.014, 0.018], [0.014, 0.03], [0, 0.03]], 10), { p: [a + 0.28, v + 0.13, -0.12] }, 0.9), t.add("plastic_red", ot(0.012, 0.012, 0.014, 8), { p: [a + 0.28, v + 0.165, -0.12] }, 0.95), t.add("paint_yellow", vn([a - 0.3, v + 0.012, -0.13], [a - 0.2, v + 0.012, -0.16], 0.014, 7, true), null, 0.9), t.add("steel_bare", vn([a - 0.2, v + 0.012, -0.16], [a - 0.08, v + 0.01, -0.196], 4e-3, 5, true), null, 0.9);
  let g = eo(0.2, 0.02, 0.15, 9e-3, 4, 3, 4), x = n() * 9;
  return to(g, (y) => {
    y.y += 0.012 * gn(y.x * 30 + x, y.z * 30) * (y.y > 0 ? 1 : 0), y.x += 0.012 * (gn(y.z * 20, x) - 0.5);
  }), t.add(t.mat("glove_fabric", { color: 8203044 }), gr(g), { p: [a - 0.26, v + 0.01, 0.12], r: [0, 0.8, 0] }, 0.9), t.finish();
}
function sb(i) {
  i("forklift", (e, t = {}) => oR(e, t)), i("generator", (e, t = {}) => rR(e, t)), i("dumpster", (e, t = {}) => aR(e, t)), i("toolbox_cart", (e, t = {}) => lR(e, t));
}
var oa = new THREE.Vector3();
function Wi(i, e, t, n = 0.02, s = "center") {
  n = Math.min(n, i / 2 - 1e-4, e / 2 - 1e-4, t / 2 - 1e-4);
  let o = new THREE.BoxGeometry(i, e, t, 3, 3, 3), r = o.attributes.position, a = o.attributes.normal, l = o.attributes.uv, c = i / 2, u = e / 2, h = t / 2, f = (p, d) => {
    let v = Math.abs(p), g = Math.sign(p);
    return v > d - 1e-5 ? g * d : g * (d - n);
  };
  for (let p = 0; p < r.count; p++) {
    let d = f(r.getX(p), c), v = f(r.getY(p), u), g = f(r.getZ(p), h), x = Math.max(-(c - n), Math.min(c - n, d)), y = Math.max(-(u - n), Math.min(u - n, v)), b = Math.max(-(h - n), Math.min(h - n, g));
    if (oa.set(d - x, v - y, g - b), oa.lengthSq() > 1e-10) {
      oa.normalize();
      let M = a.getX(p), E = a.getY(p), w = a.getZ(p);
      (Math.abs(d) > c - 1e-5 ? 1 : 0) + (Math.abs(v) > u - 1e-5 ? 1 : 0) + (Math.abs(g) > h - 1e-5 ? 1 : 0) >= 2 ? (d = x + oa.x * n, v = y + oa.y * n, g = b + oa.z * n, a.setXYZ(p, oa.x, oa.y, oa.z)) : a.setXYZ(p, M, E, w);
    }
    r.setXYZ(p, d, v, g);
    let m = Math.abs(a.getX(p)), A = Math.abs(a.getY(p)), _ = Math.abs(a.getZ(p));
    m >= A && m >= _ ? l.setXY(p, g, v) : A >= m && A >= _ ? l.setXY(p, d, g) : l.setXY(p, d, v);
  }
  return s === "bottom" && o.translate(0, e / 2, 0), o;
}
var _t = (i, e, t) => new THREE.Vector3(i, e, t), al = (i) => i.isVector3 ? i : new THREE.Vector3(i[0], i[1], i[2]), hb = new THREE.Vector3(0, 1, 0), gR = new THREE.Vector3(1, 1, 1), ub = new THREE.Quaternion(), I1 = new THREE.Matrix4();
function t0(i, e, t) {
  let n = Math.imul(i, 374761393) ^ Math.imul(e, 668265263) ^ Math.imul(t, 1274126177);
  return n = Math.imul(n ^ n >>> 13, 1274126177), ((n ^ n >>> 16) >>> 0) / 4294967295;
}
function rl(i, e, t) {
  let n = Math.floor(i), s = Math.floor(e), o = Math.floor(t), r = i - n, a = e - s, l = t - o;
  r = r * r * (3 - 2 * r), a = a * a * (3 - 2 * a), l = l * l * (3 - 2 * l);
  let c = (u, h, f) => u + (h - u) * f;
  return c(c(c(t0(n, s, o), t0(n + 1, s, o), r), c(t0(n, s + 1, o), t0(n + 1, s + 1, o), r), a), c(c(t0(n, s, o + 1), t0(n + 1, s, o + 1), r), c(t0(n, s + 1, o + 1), t0(n + 1, s + 1, o + 1), r), a), l);
}
function uv(i) {
  let e = i >>> 0;
  return () => (e = Math.imul(e, 1664525) + 1013904223 >>> 0, e / 4294967296);
}
var P1 = [1, 1, 1], fb = [1, 1, 1];
function hv(i, e, t, n = fb, s = 1) {
  let o = rl(i * 0.31 + 11.3, e * 0.23 + 5.1, t * 0.31 + 3.7), r = rl(i * 1.7 + 40.2, 9.5, t * 1.7 + 17.9), a = 1 - s * (0.3 - 0.36 * o), l = n[0] * a, c = n[1] * a, u = n[2] * a;
  if (r > 0.68) {
    let h = Math.min(1, (r - 0.68) / 0.3) * 0.6 * s * (0.35 + 0.65 * rl(i * 0.9, e * 0.45, t * 0.9));
    l *= 1 + 0.45 * h, c *= 1 - 0.3 * h, u *= 1 - 0.6 * h;
  }
  return P1[0] = l, P1[1] = c, P1[2] = u, P1;
}
var db = /* @__PURE__ */ new WeakSet();
function so(i, e, t = {}) {
  let n = i.mats.get(e, { vertexColors: true, ...t });
  return db.add(n), n;
}
var io = class {
  constructor() {
    this.b = /* @__PURE__ */ new Map(), this.tris = 0, this.remap = null, this.dz = 0, this.minSize = 0;
  }
  add(e, t, n) {
    if (!t) return;
    if (Array.isArray(t)) {
      for (let o of t) this.add(e, o, n);
      return;
    }
    if (this.remap) {
      let o = this.remap(e, n);
      if (!o) return;
      if (this.minSize) {
        t.computeBoundingBox();
        let r = t.boundingBox;
        if (Math.max(r.max.x - r.min.x, r.max.y - r.min.y, r.max.z - r.min.z) < this.minSize) return;
      }
      e = o[0], n = o[1], this.dz && t.translate(0, 0, this.dz);
    }
    db.has(e) && !t.attributes.color && Lc(t, (o, r, a) => hv(o, r, a, n || fb));
    let s = this.b.get(e.uuid);
    s || (s = { mat: e, geos: [] }, this.b.set(e.uuid, s)), s.geos.push(t), this.tris += (t.index ? t.index.count : t.attributes.position.count) / 3;
  }
  build({ cast: e = true, recv: t = true } = {}) {
    let n = new THREE.Group();
    for (let s of this.b.values()) {
      let o = Ii(s.geos), r = new THREE.Mesh(o, s.mat), a = s.mat.isMeshBasicMaterial || s.mat.transparent;
      r.castShadow = e && !a, r.receiveShadow = t && !a, n.add(r);
    }
    return this.b.clear(), n;
  }
};
function Ee(i, e, t, n, s, o, r = 0) {
  let a = Math.abs(n - i), l = Math.abs(s - e), c = Math.abs(o - t), u = r > 0 ? Wi(a, l, c, r) : $e(a, l, c);
  return u.translate((i + n) / 2, (e + s) / 2, (t + o) / 2), u;
}
function xt(i, e, t, n, s, o, r, a = 12, l = false) {
  let c = ot(i, e, t, a, l);
  return n === "x" ? c.rotateZ(Math.PI / 2) : n === "z" && c.rotateX(Math.PI / 2), c.translate(s, o, r), c;
}
function Ke(i, e, t = 0.03, n = 5, s = false) {
  i = al(i), e = al(e);
  let o = new THREE.Vector3().subVectors(e, i), r = o.length();
  if (r < 1e-5) return null;
  let a = ot(t, t, r, n, !s);
  return ub.setFromUnitVectors(hb, o.multiplyScalar(1 / r)), I1.compose(new THREE.Vector3().addVectors(i, e).multiplyScalar(0.5), ub, gR), a.applyMatrix4(I1), a;
}
function jt(i, e, t = 0.3, n = 0.3, s = 0) {
  i = al(i), e = al(e);
  let o = new THREE.Vector3().subVectors(e, i), r = o.length();
  o.multiplyScalar(1 / r);
  let a = new THREE.Vector3().crossVectors(o, hb);
  a.lengthSq() < 1e-6 ? a.set(1, 0, 0) : a.normalize();
  let l = new THREE.Vector3().crossVectors(a, o), c = s > 0 ? Wi(t, r, n, s) : $e(t, r, n);
  return I1.makeBasis(a, o, l).setPosition((i.x + e.x) / 2, (i.y + e.y) / 2, (i.z + e.z) / 2), c.applyMatrix4(I1), c;
}
function kr(i, e = 0.03, t = 5) {
  let n = [];
  for (let s = 0; s < i.length - 1; s++) {
    let o = Ke(i[s], i[s + 1], e, t);
    o && n.push(o);
  }
  return n;
}
function ua(i, e, t = 1, n = 10) {
  i = al(i), e = al(e);
  let s = [];
  for (let o = 0; o <= n; o++) {
    let r = o / n, a = new THREE.Vector3().lerpVectors(i, e, r);
    a.y -= t * 4 * r * (1 - r), s.push(a);
  }
  return s;
}
function ll(i, e, t, n, s, o = 0, r = 0) {
  let a = new THREE.PlaneGeometry(i, e);
  return r && a.rotateX(r), o && a.rotateY(o), a.translate(t, n, s), a;
}
function ns(i, e, t, { h: n = 1.1, post: s = 2.2, r: o = 0.022, tint: r, mid: a = true } = {}) {
  t = t.map(al);
  for (let l = 0; l < t.length - 1; l++) {
    let c = t[l], u = t[l + 1], h = c.distanceTo(u), f = Math.max(1, Math.round(h / s));
    for (let p = l === 0 ? 0 : 1; p <= f; p++) {
      let d = new THREE.Vector3().lerpVectors(c, u, p / f);
      i.add(e, Ke(d, _t(d.x, d.y + n, d.z), o, 4), r);
    }
    i.add(e, Ke(_t(c.x, c.y + n, c.z), _t(u.x, u.y + n, u.z), o * 1.15, 5), r), a && i.add(e, Ke(_t(c.x, c.y + n * 0.5, c.z), _t(u.x, u.y + n * 0.5, u.z), o * 0.9, 4), r);
  }
}
var Bn = (i, e, t, n = 0.12) => {
  let s = new THREE.OctahedronGeometry(n, 0);
  return s.translate(i, e, t), s;
};
var Bt = 18.5, is = 28.5, Di = 5.4, fv = 21.2, ai = 22.8, On = 1.8, wo = 12, Xi = 62, ks = 41, wn = [0.82, 0.95, 1.12], Ms = [0.6, 0.72, 0.86], En = [1, 0.95, 0.85], cl = [0.95, 0.96, 0.97];
function z1(i, e, t = {}) {
  let n = !!t.into, s = t.dz || 0, o = t.into || new io(), r = n ? { add(R, I, se, ae, k) {
    R.translate(0, 0, s), e.add(R, I, se, ae, k);
  } } : e, a = so(i, "paint_grey"), l = so(i, "paint_yellow"), c = so(i, "paint_white"), u = so(i, "paint_red"), h = i.mats.get("steel_galv"), f = i.mats.get("steel_dark"), p = i.mats.get("hazard_stripes"), d = i.mats.get("glass"), v = i.mats.emissive(16769716, 6), g = (R, I, se) => o.add(R, I, se), x = [];
  if (n) {
    let R = /* @__PURE__ */ new Map([[a.uuid, [0.2, 0.25, 0.31]], [l.uuid, [0.72, 0.52, 0.12]], [c.uuid, [0.78, 0.78, 0.76]], [u.uuid, [0.5, 0.14, 0.1]], [h.uuid, [0.5, 0.52, 0.54]], [f.uuid, [0.1, 0.1, 0.11]], [p.uuid, [0.7, 0.5, 0.1]]]), I = t.mat;
    o.remap = (se, ae) => {
      let k = R.get(se.uuid);
      return k ? [I, ae ? [k[0] * ae[0], k[1] * ae[1], k[2] * ae[2]] : k] : null;
    }, o.dz = s, o.minSize = 2.6;
  }
  function y(R, I) {
    let se = R < 23.5 ? 1 : -1;
    for (let ae of [-1.12, 1.12]) {
      let k = I + ae;
      g(l, Ee(R - 0.3, 0.36, k - 0.98, R + 0.3, 0.84, k + 0.98, 0.04), En);
      for (let ce of [-0.56, 0.56]) g(f, xt(0.33, 0.33, 0.14, "x", R, 0.33, k + ce, 16)), g(f, xt(0.37, 0.37, 0.025, "x", R - 0.085, 0.33, k + ce, 16)), g(f, xt(0.37, 0.37, 0.025, "x", R + 0.085, 0.33, k + ce, 16)), g(h, xt(0.11, 0.11, 0.7, "x", R, 0.33, k + ce, 8));
      g(f, xt(0.16, 0.16, 0.5, "z", R + se * 0.5, 0.6, k, 10)), g(l, Ee(R + se * 0.3, 0.42, k - 0.56 - 0.16, R + se * 0.62, 0.8, k - 0.3, 0.03), En);
    }
    g(f, Ee(R - 0.2, 0.1, I - 0.22, R + 0.2, 0.9, I + 0.22, 0.03)), g(a, Ee(R - 0.34, 0.9, I - 1.8, R + 0.34, 1.42, I + 1.8, 0.05), wn);
    for (let ae of [-1.12, 0, 1.12]) g(h, xt(0.14, 0.14, 0.8, "x", R, ae ? 1.08 : 1.22, I + ae, 10));
    g(a, Ee(R - 0.54, 1.42, I - 0.54, R + 0.54, 1.6, I + 0.54, 0.03), Ms);
    for (let ae of [-1, 1]) {
      let k = I + ae * 2.1;
      g(l, Ee(R - 0.16, 0.44, k - 0.12, R + 0.16, 0.8, k + 0.12, 0.02), En), g(h, xt(0.08, 0.08, 0.34, "z", R, 0.62, k + ae * 0.28, 8)), g(f, xt(0.17, 0.15, 0.12, "z", R, 0.62, k + ae * 0.5, 12)), g(p, Ee(R - 0.28, 0.04, k + ae * 0.13, R + 0.28, 0.4, k + ae * 0.16));
    }
    x.push({ min: [R - 0.5, 0, I - 2.7], max: [R + 0.5, 1.5, I + 2.7] }), x.push({ min: [R - 0.62, 0, I - 0.62], max: [R + 0.62, 24, I + 0.62] });
  }
  let b = [3.6, 7.6, 11.2, 12.5, 13.5, 17.2, 20.6, 23.8];
  for (let R of [Bt, is]) for (let I of [-Di, Di]) {
    y(R, I), g(p, Ee(R - 0.6, 1.6, I - 0.6, R + 0.6, 3.6, I + 0.6, 0.04));
    for (let se = 0; se < b.length - 1; se++) g(a, Ee(R - 0.6, b[se], I - 0.6, R + 0.6, b[se + 1], I + 0.6, 0.05), wn), (se === 0 || se === 1 || se === 5) && g(a, Ee(R - 0.64, b[se] - 0.05, I - 0.64, R + 0.64, b[se] + 0.05, I + 0.64), Ms);
  }
  let m = i.mats.decal("hazard_voltage");
  for (let R of [-Di, Di]) {
    let I = Bt - 0.6;
    g(c, Ee(I - 0.035, 1.72, R - 0.36, I, 3.48, R + 0.36, 0.012), [0.62, 0.66, 0.7]), g(f, Ee(I - 0.05, 1.66, R - 0.42, I - 5e-3, 1.72, R + 0.42)), g(f, Ee(I - 0.05, 3.48, R - 0.42, I - 5e-3, 3.54, R + 0.42)), g(f, Ee(I - 0.05, 1.66, R - 0.42, I - 5e-3, 3.54, R - 0.36)), g(f, Ee(I - 0.05, 1.66, R + 0.36, I - 5e-3, 3.54, R + 0.42)), g(h, Ke([I - 0.08, 2.45, R + 0.26], [I - 0.08, 2.75, R + 0.26], 0.014, 5));
    for (let se of [2, 3.2]) g(f, Ee(I - 0.06, se - 0.07, R - 0.37, I - 0.03, se + 0.07, R - 0.33));
    g(h, Ee(I - 0.3, 1.5, R - 0.4, I, 1.56, R + 0.4)), g(h, Ee(I - 0.3, 1, R - 0.4, I - 0.02, 1.05, R + 0.4)), g(m.material, ll(0.3, 0.3, I - 0.04, 3.1, R, -Math.PI / 2));
  }
  for (let R of [Bt, is]) {
    g(a, Ee(R - 0.45, 3.6, -Di + 0.6, R + 0.45, 4.6, Di - 0.6, 0.05), wn);
    for (let I of [-2.4, 0, 2.4]) g(a, Ee(R - 0.48, 3.58, I - 0.03, R + 0.48, 4.62, I + 0.03), Ms);
  }
  g(l, xt(1.15, 1.15, 0.06, "x", Bt - 0.62, 5.85, -2.2, 24), En), g(l, xt(1.15, 1.15, 0.06, "x", Bt - 1.02, 5.85, -2.2, 24), En), g(f, xt(0.7, 0.7, 0.36, "x", Bt - 0.82, 5.85, -2.2, 20)), g(h, xt(0.12, 0.12, 0.9, "x", Bt - 0.6, 5.85, -2.2, 8)), g(a, Ee(Bt - 0.5, 4.6, -2.5, Bt + 0.3, 5.9, -1.9, 0.03), Ms), g(f, Ke([Bt - 0.82, 4.75, -2.2 + 1], [Bt - 0.82, 0.02, -1.2 + 0.3], 0.035, 6)), g(h, Ee(Bt - 1, 0, -1.15, Bt - 0.64, 0.5, -0.65, 0.02)), x.push({ min: [Bt - 1, 0, -1.15], max: [Bt - 0.64, 0.5, -0.65] }), g(c, Ee(Bt - 0.42, 4.6, 1, Bt + 0.42, 6.3, 3.6, 0.03), cl);
  for (let R of [1.65, 2.3, 2.95]) g(f, Ee(Bt - 0.44, 4.7, R - 0.01, Bt - 0.42, 6.2, R + 0.01));
  g(h, Ee(Bt - 0.47, 5.6, 1.2, Bt - 0.42, 6.1, 1.55));
  for (let R of [-Di, Di]) {
    g(a, Ee(Bt + 0.6, 12.5, R - 0.45, is - 0.6, 13.5, R + 0.45, 0.05), wn);
    for (let se of [21, 23.5, 26]) g(a, Ee(se - 0.03, 12.48, R - 0.48, se + 0.03, 13.52, R + 0.48), Ms);
    let I = Math.sign(R);
    g(a, jt([Bt + 0.5, 9.6, R], [Bt + 3.4, 12.6, R], 0.4, 0.4, 0.03), wn), g(a, jt([is - 0.5, 9.6, R], [is - 3.4, 12.6, R], 0.4, 0.4, 0.03), wn);
    for (let se of [Bt, is]) g(a, jt([se, 9.6, R - I * 0.5], [se, 12.6, R - I * 3.4], 0.4, 0.4, 0.03), wn);
    g(a, Ke([is - 0.4, 13.7, R], [Bt + 0.4, 22.7, R], 0.2, 10), wn), g(a, Ke([Bt + 0.4, 13.7, R], [is - 0.4, 22.7, R], 0.2, 10), wn), g(a, Ee(23.5 - 0.5, 17.7, R - 0.24, 23.5 + 0.5, 18.7, R + 0.24, 0.03), Ms), g(a, Ee(Bt + 0.6, 22.95, R - 0.35, is - 0.6, 23.7, R + 0.35, 0.04), wn);
  }
  for (let R of [Bt, is]) {
    g(a, Ee(R - 0.45, 12.5, -Di + 0.6, R + 0.45, 13.5, Di - 0.6, 0.05), wn), g(a, Ee(R - 0.45, 22.8, -Di + 0.6, R + 0.45, 23.8, Di - 0.6, 0.05), wn);
    for (let I of [-1, 1]) g(a, jt([R, 20.2, I * (Di - 0.5)], [R, 22.8, I * (On + 1.2)], 0.36, 0.36, 0.03), wn);
  }
  g(h, Ee(Bt + 0.9, 13.5, 4.05, is - 0.9, 13.55, 4.95)), ns(o, l, [[Bt + 0.9, 13.55, 4.08], [is - 0.9, 13.55, 4.08]], { tint: En }), g(h, Ee(Bt + 0.45, 13.45, -4.6, Bt + 1.25, 13.5, 4.05)), ns(o, l, [[Bt + 1.22, 13.5, -4.6], [Bt + 1.22, 13.5, 4.05]], { tint: En });
  let A = is + 1.3;
  for (let R of [-1, 1]) {
    let I = R * On, se = [wo, 15.4, Bt, 22, 25.2, is, A - 0.15, A + 0.15, 34.6, 39.2, 43.8, 48.4, 53, 57.6, Xi];
    for (let ce = 0; ce < se.length - 1; ce++) ce !== 6 && (g(a, Ee(se[ce], fv, I - 0.45, se[ce + 1], ai, I + 0.45, 0.05), wn), ce > 0 && ce !== 7 && g(a, Ee(se[ce] - 0.035, fv - 0.05, I - 0.5, se[ce] + 0.035, ai + 0.05, I + 0.5), Ms));
    g(a, Ee(A - 0.7, ai - 0.1, I - 0.52, A + 0.7, ai + 0.55, I - 0.4, 0.03), Ms), g(a, Ee(A - 0.7, ai - 0.1, I + 0.4, A + 0.7, ai + 0.55, I + 0.52, 0.03), Ms), g(h, xt(0.16, 0.16, 1.2, "z", A, ai + 0.22, I, 12)), g(f, Ee(wo + 0.3, ai, I - R * 0.32 - 0.05, Xi - 0.3, ai + 0.09, I - R * 0.32 + 0.05));
    let ae = I + R * 0.45, k = I + R * 1.35;
    g(h, Ee(wo + 0.2, 21.86, Math.min(ae, k), Xi - 0.2, 21.9, Math.max(ae, k)));
    for (let ce = wo + 0.6; ce < Xi; ce += 2.45) g(a, jt([ce, 21.84, ae], [ce, 21.3, ae], 0.07, 0.07), Ms), g(a, jt([ce, 21.82, k], [ce, 21.36, ae], 0.06, 0.08), Ms);
    ns(o, l, [[wo + 0.2, 21.9, k - R * 0.03], [Xi - 0.2, 21.9, k - R * 0.03]], { post: 2.45, tint: En }), g(l, Ee(wo + 0.2, 21.9, k - R * 0.03 - 8e-3, Xi - 0.2, 22.02, k - R * 0.03 + 8e-3), En);
    for (let ce of [44, 58]) g(a, Ee(ce - 0.18, ai, I - 0.2, ce + 0.18, ai + 1.5, I + 0.2, 0.03), wn);
  }
  for (let R of [44, 58]) g(a, Ee(R - 0.2, ai + 1.2, -On - 0.3, R + 0.2, ai + 1.6, On + 0.3, 0.04), wn);
  for (let R of [wo + 0.25, Xi - 0.25]) {
    g(a, Ee(R - 0.25, fv + 0.1, -On + 0.45, R + 0.25, ai - 0.1, On - 0.45, 0.05), wn);
    let I = R < 30 ? 1 : -1;
    for (let se of [-0.8, 0.8]) g(f, xt(0.14, 0.14, 0.4, "x", R + I * 0.45, 22, se, 10));
  }
  g(h, Ee(Xi - 0.1, 21.86, -On - 1.35, Xi + 0.9, 21.9, On + 1.35)), ns(o, l, [[Xi - 0.1, 21.9, -On - 1.32], [Xi + 0.87, 21.9, -On - 1.32], [Xi + 0.87, 21.9, On + 1.32], [Xi - 0.1, 21.9, On + 1.32]], { post: 1.4, tint: En }), g(h, Ke([Xi + 0.6, 21.9, 0], [Xi + 0.6, 25.2, 0], 0.035, 6)), g(h, Ke([Xi + 0.6, 24.8, -0.45], [Xi + 0.6, 24.8, 0.45], 0.015, 4)), r.add(Bn(Xi + 0.6, 25.32, 0, 0.13), [9, 0.5, 0.25], 2.6, 0.5, 0.45), g(f, xt(0.1, 0.12, 0.1, "y", Xi + 0.6, 25.2, 0, 8));
  let _ = 27.6, M = 30, E = 1.5;
  for (let R of [-1, 1]) {
    g(a, jt([is, 23.8, R * Di], [_, M, R * E], 0.55, 0.55, 0.04), wn), g(a, jt([Bt, 23.8, R * Di], [_, M, R * E], 0.5, 0.5, 0.04), wn);
    for (let [I, se] of [[44, 0.1], [58, 0.1]]) {
      let ae = _t(_ + 0.3, M, R * E), k = _t(I, ai + 1.45, R * On);
      g(a, Ke(ae, k, se, 8), wn);
      let ce = ae.clone().lerp(k, 0.5);
      g(a, Ee(ce.x - 0.3, ce.y - 0.16, ce.z - 0.14, ce.x + 0.3, ce.y + 0.16, ce.z + 0.14, 0.03), Ms);
    }
    g(f, Ke([_ + 0.2, M + 0.35, R * 0.9], [50, ai + 0.2, R * 1], 0.022, 5)), g(f, xt(0.5, 0.5, 0.18, "z", _, M + 0.25, R * 0.9, 16));
  }
  g(a, Ee(_ - 0.45, M - 0.35, -E - 0.5, _ + 0.45, M + 0.3, E + 0.5, 0.05), wn);
  {
    let R = (k, ce) => _t(is + (_ - is) * k, 23.8 + (M - 23.8) * k, ce * (Di + (E - Di) * k)), I = (k, ce) => _t(Bt + (_ - Bt) * k, 23.8 + (M - 23.8) * k, ce * (Di + (E - Di) * k));
    g(a, jt(R(0.5, -1), R(0.5, 1), 0.3, 0.3, 0.02), wn), g(a, jt(I(0.55, -1), I(0.55, 1), 0.3, 0.3, 0.02), wn), g(a, Ke(I(0.55, -1), R(0.5, -1), 0.09, 6), wn), g(a, Ke(I(0.55, 1), R(0.5, 1), 0.09, 6), wn);
    let se = R(0.02, 1), ae = R(0.97, 1);
    for (let k of [-0.22, 0.22]) g(h, Ke([se.x - 0.42, se.y, se.z + k], [ae.x - 0.42, ae.y, ae.z + k], 0.02, 4));
    for (let k = 0.03; k < 1; k += 0.045) {
      let ce = se.clone().lerp(ae, k);
      g(h, Ke([ce.x - 0.42, ce.y, ce.z - 0.22], [ce.x - 0.42, ce.y, ce.z + 0.22], 0.012, 4));
    }
  }
  g(a, Ee(wo + 0.05, ai, -3.6, wo + 0.55, ai + 0.4, 3.6, 0.04), wn);
  for (let R of [-1, 1]) g(a, Ee(wo + 0.08, ai + 0.4, R * 3.3 - 0.2, wo + 0.52, ai + 1, R * 3.3 + 0.2, 0.03), Ms), g(a, Ke([_ - 0.3, M, R * E], [wo + 0.3, ai + 0.8, R * 3.3], 0.1, 8), wn), g(h, xt(0.12, 0.12, 0.6, "z", wo + 0.3, ai + 0.8, R * 3.3, 10));
  g(h, Ee(_ - 1, M + 0.3, -E - 0.6, _ + 1, M + 0.34, E + 0.6)), ns(o, l, [[_ - 0.98, M + 0.34, -E - 0.58], [_ + 0.98, M + 0.34, -E - 0.58], [_ + 0.98, M + 0.34, E + 0.58], [_ - 0.98, M + 0.34, E + 0.58], [_ - 0.98, M + 0.34, -E - 0.58]], { post: 1.2, tint: En }), g(h, Ke([_, M + 0.34, 0], [_, M + 2, 0], 0.045, 6)), g(h, Ke([_, M + 2, 0], [_, M + 3.6, 0], 0.016, 4)), g(h, Ke([_ - 0.5, M + 1.5, 0], [_ + 0.5, M + 1.5, 0], 0.018, 4));
  for (let R of [-0.5, 0.5]) g(f, xt(0.1, 0.12, 0.1, "y", _ + R, M + 1.56, 0, 8)), r.add(Bn(_ + R, M + 1.72, 0, 0.15), [10, 0.5, 0.25], 2.6, 0, 0.45);
  let w = 20.4, S = 27.9, z = ai, H = 26, O = 2.9;
  g(c, Ee(w, z, -O, S, H, O, 0.06), cl), g(a, Ee(w - 0.15, z - 0.12, -O - 0.15, S + 0.15, z + 0.1, O + 0.15, 0.03), Ms), g(h, Ee(w - 0.2, H, -O - 0.2, S + 0.2, H + 0.12, O + 0.2, 0.03));
  for (let R = w + 1.3; R < S; R += 1.3) for (let I of [-1, 1]) g(c, Ee(R - 0.02, z + 0.1, I * O - 0.015, R + 0.02, H, I * O + 0.015), [0.7, 0.72, 0.74]);
  function q(R, I, se, ae, k, ce) {
    let ve = [Ee(-ae / 2, -k / 2, 0, ae / 2, k / 2, 0.02)], _e = Math.round(k / 0.12);
    for (let Te = 0; Te < _e; Te++) {
      let Pe = Ee(-ae / 2 + 0.03, -0.012, 0, ae / 2 - 0.03, 0.012, 0.11);
      Pe.rotateX(0.7), Pe.translate(0, -k / 2 + (Te + 0.5) * (k / _e), 0.03), ve.push(Pe);
    }
    for (let Te of ve) Te.rotateY(ce), Te.translate(R, I, se);
    g(f, ve.shift()), g(h, ve);
  }
  for (let R of [-1, 1]) for (let I of [w + 1.4, w + 3.9, w + 6.1]) q(I, 24.5, R * (O + 5e-3), 1.5, 1.3, R > 0 ? 0 : Math.PI);
  q(w - 5e-3, 23.75, -1.9, 1.4, 1.1, -Math.PI / 2), g(c, Ee(w - 0.03, z + 0.15, 0.8, w, z + 2.15, 1.7, 0.01), [0.6, 0.64, 0.68]), g(h, Ke([w - 0.06, z + 1, 1.55], [w - 0.06, z + 1.3, 1.55], 0.014, 5)), g(h, Ee(w - 0.9, z + 0.05, 0.3, w, z + 0.1, 2.2)), ns(o, l, [[w, z + 0.1, 0.32], [w - 0.88, z + 0.1, 0.32], [w - 0.88, z + 0.1, 2.18], [w, z + 0.1, 2.18]], { post: 1, tint: En });
  let U = i.mats.decal("logo_a");
  g(U.material, ll(1.1 * Math.min(3, U.aspect || 1), 1.1, w - 0.012, 25.2, 0, -Math.PI / 2)), ns(o, l, [[w, H + 0.12, -O], [S, H + 0.12, -O], [S, H + 0.12, O], [w, H + 0.12, O], [w, H + 0.12, -O]], { post: 1.95, tint: En });
  for (let R of [w + 1.9, w + 5.6]) g(h, xt(0.28, 0.28, 0.5, "y", R, H + 0.37, -1.2, 10)), g(h, xt(0.1, 0.5, 0.22, "y", R, H + 0.72, -1.2, 10));
  g(f, xt(0.13, 0.13, 1.6, "y", w + 3.7, H + 0.9, 1.9, 8)), g(f, xt(0.2, 0.14, 0.2, "y", w + 3.7, H + 1.75, 1.9, 8)), g(c, Ee(w + 5.4, H + 0.12, 0.4, w + 6.7, H + 0.85, 1.8, 0.03), [0.7, 0.72, 0.75]), g(h, Ke([w + 0.3, H + 0.12, 2.5], [w + 0.3, H + 1.9, 2.5], 0.03, 5)), r.add(Bn(w + 0.3, H + 2.02, 2.5, 0.13), [9, 0.5, 0.25], 2.6, 0.25, 0.45);
  let T = 6.15, D = 6.97, C = 7.8, G = [19.4, 20.6], j = [26.4, 27.6];
  function N(R, I, se, ae, k, ce) {
    let ve = ae - I, _e = Math.max(2, Math.round(ve / 0.21));
    for (let Te of [k + 0.03, ce - 0.03]) {
      g(h, jt([R, I - 0.12, Te], [se, ae - 0.12, Te], 0.05, 0.24)), g(l, Ke([R, I + 1, Te], [se, ae + 1, Te], 0.024, 5), En), g(l, Ke([R, I + 0.5, Te], [se, ae + 0.5, Te], 0.018, 4), En);
      for (let Pe = 0; Pe <= 4; Pe++) {
        let Re = Pe / 4, Fe = R + (se - R) * Re, ze = I + ve * Re;
        g(l, Ke([Fe, ze - 0.05, Te], [Fe, ze + 1, Te], 0.02, 4), En);
      }
    }
    for (let Te = 1; Te <= _e; Te++) {
      let Pe = (Te - 0.5) / _e, Re = R + (se - R) * Pe, Fe = I + ve * (Te / _e);
      g(h, Ee(Re - 0.13, Fe - 0.03, k + 0.06, Re + 0.13, Fe, ce - 0.06));
    }
  }
  function Q(R, I, se, ae) {
    g(h, Ee(R, se - 0.05, T, I, se, C)), g(h, Ee(R, se - 0.2, T, I, se - 0.05, T + 0.06)), g(h, Ee(R, se - 0.2, C - 0.06, I, se - 0.05, C));
    let k = ae > 0 ? I - 0.03 : R + 0.03, ce = ae > 0 ? R : I;
    ns(o, l, [[ce, se, C - 0.03], [k, se, C - 0.03], [k, se, T + 0.03]], { post: 0.9, tint: En });
  }
  let K = [3.6, 6.9, 10.2, 13.5, 16.8, 20.1];
  for (let R = 0; R < 5; R++) R % 2 === 0 ? (Q(G[0], G[1], K[R], -1), N(G[1], K[R], j[0], K[R + 1], T, D)) : (Q(j[0], j[1], K[R], 1), N(j[0], K[R], G[1], K[R + 1], D, C));
  Q(j[0], j[1], K[5], 1), N(j[0], K[5], 23.4, 21.9, D, C), g(h, Ee(22.5, 21.85, On + 1.35, 23.4, 21.9, C)), ns(o, l, [[22.53, 21.9, On + 1.4], [22.53, 21.9, C - 0.03], [23.37, 21.9, C - 0.03]], { post: 1.3, tint: En }), ns(o, l, [[23.37, 21.9, On + 1.4], [23.37, 21.9, D]], { post: 1.3, tint: En }), g(h, Ee(j[0], 13.45, 4.95, j[1], 13.5, T));
  for (let R of [G[0], j[1]]) for (let I of [T - 0.05, C + 0.05]) g(a, Ee(R - 0.07, 3.3, I - 0.07, R + 0.07, 21.4, I + 0.07), wn);
  for (let R = 0; R < K.length; R++) {
    let I = K[R] - 0.25;
    g(a, Ee(G[0], I - 0.06, C + 0, j[1], I + 0.06, C + 0.1), Ms);
    for (let se of [G[0], j[1]]) g(a, Ee(se - 0.05, I - 0.06, 5.9, se + 0.05, I + 0.06, C + 0.1), Ms);
    if (R < K.length - 1) {
      let se = K[R + 1] - 0.25;
      g(a, Ke([G[0], I, C + 0.05], [j[1], se, C + 0.05], 0.03, 5), wn), g(a, Ke([j[1], I, C + 0.05], [G[0], se, C + 0.05], 0.03, 5), wn);
    }
  }
  {
    let R = G[0] - 0.05, I = 7.35;
    for (let ae of [-0.22, 0.22]) g(h, Ke([R, 0.05, I + ae], [R, 4.75, I + ae], 0.022, 5));
    for (let ae = 0.3; ae < 4.7; ae += 0.3) g(h, Ke([R, ae, I - 0.22], [R, ae, I + 0.22], 0.012, 4));
    let se = (ae) => {
      let k = [];
      for (let ce = 0; ce <= 8; ce++) {
        let ve = Math.PI * ce / 8;
        k.push(_t(R - Math.sin(ve) * 0.7, ae, I - Math.cos(ve) * 0.36));
      }
      return k;
    };
    for (let ae = 2.3; ae <= 4.75; ae += 0.6) g(h, kr(se(ae), 0.012, 4));
    for (let ae = 1; ae < 8; ae += 1.5) {
      let k = Math.PI * ae / 8;
      g(h, Ke([R - Math.sin(k) * 0.7, 2.3, I - Math.cos(k) * 0.36], [R - Math.sin(k) * 0.7, 4.75, I - Math.cos(k) * 0.36], 0.01, 4));
    }
    x.push({ min: [R - 0.72, 0, I - 0.4], max: [R + 0.05, 4.7, I + 0.4], bulletOnly: false });
  }
  g(f, Ee(13, 21.02, -On - 0.95, ks - 1.2, 21.12, -On - 0.85));
  for (let R = 13.5; R < ks - 1.2; R += 3.3) g(f, Ee(R - 0.03, 21.1, -On - 0.93, R + 0.03, 21.86, -On - 0.87));
  {
    let se = (ks - 1.6 - 13.6) / 15;
    for (let ae = 0; ae < 15; ae++) {
      let k = 13.6 + ae * se, ce = 1.1 + 0.25 * Math.sin(ae * 2.1);
      g(f, Ee(k - 0.1, 20.9, -On - 0.98, k + 0.1, 21.02, -On - 0.82));
      for (let ve of [-0.05, 0.05]) {
        let _e = [];
        for (let Te = 0; Te <= 7; Te++) {
          let Pe = Te / 7;
          _e.push(_t(k + se * Pe, 20.92 - ce * (1 - (2 * Pe - 1) ** 2), -On - 0.9 + ve));
        }
        g(f, kr(_e, 0.03, 4));
      }
    }
  }
  function ie(R, I, se, ae, k = "z") {
    let ce = ae * 0.46;
    k === "z" ? g(f, Ee(R - 0.03, I, se - ce / 2, R + 0.03, I + 0.06, se + ce / 2)) : g(f, Ee(R - ce / 2, I, se - 0.03, R + ce / 2, I + 0.06, se + 0.03));
    for (let ve = 0; ve < ae; ve++) {
      let _e = (ve - (ae - 1) / 2) * 0.46, Te = k === "z" ? R : R + _e, Pe = k === "z" ? se + _e : se;
      g(f, Ee(Te - 0.17, I - 0.2, Pe - 0.17, Te + 0.17, I, Pe + 0.17, 0.02)), g(v, Ee(Te - 0.14, I - 0.215, Pe - 0.14, Te + 0.14, I - 0.2, Pe + 0.14));
    }
  }
  for (let R of [33, 47.5, 59.5]) for (let I of [-1, 1]) ie(R, 21.3, I * (On + 1.3), 3, "x");
  for (let R of [-1, 1]) ie(23.5, 12.28, R * (Di - 0.2), 4, "x"), ie(15, 21.3, R * (On + 1.3), 2, "x");
  ie(is + 0.1, 12.28, 0, 3, "z"), ie(Bt - 0.1, 12.28, 0, 3, "z"), ie(_ + 0.6, M - 0.55, 0, 3, "z"), g(l, Ee(ks - 2.3, 21.35, -1.25, ks + 2.3, 22.2, 1.25, 0.06), En), g(l, Ee(ks - 1.6, 20.7, -1.1, ks + 1.6, 21.35, 1.1, 0.05), En);
  for (let R of [-1.8, 1.8]) for (let I of [-1, 1]) g(f, xt(0.24, 0.24, 0.16, "z", ks + R, 22.42, I * 1.3, 12)), g(l, Ee(ks + R - 0.35, 22.1, I * 1.3 - 0.14, ks + R + 0.35, 22.5, I * 1.3 + 0.14, 0.03), En);
  g(f, xt(0.42, 0.42, 1.5, "z", ks - 0.9, 22.35, 0, 14)), g(f, xt(0.42, 0.42, 1.5, "z", ks + 0.9, 22.35, 0, 14));
  let F = ks + 0.25, X = ks + 2.65, ne = 2.35, re = 4.4, $ = 18.3, ue = 20.7;
  for (let R of [F + 0.12, X - 0.3]) {
    g(l, Ee(R - 0.12, 20.88, -1, R + 0.12, 21.16, re, 0.03), En);
    for (let I of [ne + 0.1, re - 0.1]) g(l, Ee(R - 0.06, ue, I - 0.06, R + 0.06, 20.9, I + 0.06), En);
  }
  g(c, Ee(F, $, ne, X, $ + 0.14, re, 0.03), cl), g(c, Ee(F - 0.08, ue - 0.02, ne - 0.08, X + 0.12, ue + 0.12, re + 0.08, 0.03), cl), g(c, Ee(F, $ + 0.14, ne, F + 0.08, ue, re), cl);
  for (let R of [ne, re - 0.06]) g(c, Ee(F, $ + 0.14, R, X - 0.5, $ + 0.95, R + 0.06), cl), g(d, Ee(F + 0.08, $ + 0.95, R + 0.02, X - 0.06, ue, R + 0.04)), g(d, Ee(X - 0.5, $ + 0.14, R + 0.02, X - 0.06, $ + 0.95, R + 0.04));
  for (let R of [X - 0.06]) for (let I of [ne, re - 0.06, (ne + re) / 2 - 0.03]) g(c, Ee(R, $ + 0.14, I, R + 0.06, ue, I + 0.06), cl);
  g(d, Ee(X - 0.04, $ + 0.14, ne + 0.06, X - 0.02, ue, re - 0.06)), g(d, Ee(X - 0.9, $ + 0.02, ne + 0.3, X - 0.1, $ + 0.04, re - 0.3)), g(f, Ee(F + 0.9, $ + 0.14, 3.1, F + 1.45, $ + 0.6, 3.65, 0.04)), g(f, Ee(F + 0.82, $ + 0.6, 3.1, F + 0.96, $ + 1.35, 3.65, 0.04));
  for (let R of [2.75, 4]) g(f, Ee(F + 1.2, $ + 0.14, R - 0.16, F + 1.75, $ + 0.85, R + 0.16, 0.03)), r.add(Ee(F + 1.3, $ + 0.855, R - 0.1, F + 1.6, $ + 0.865, R + 0.1), [0.75, 0.5, 0.26], 0);
  r.add(Ee(F + 0.5, ue - 0.045, 3, F + 1.5, ue - 0.03, 3.2), [0.75, 0.5, 0.26], 0), ie(X + 0.15, $ + 0.1, 3.37, 2, "z"), g(h, Ee(F - 0.9, $ + 0.1, ne, F, $ + 0.14, re)), ns(o, l, [[F, $ + 0.14, ne + 0.03], [F - 0.87, $ + 0.14, ne + 0.03], [F - 0.87, $ + 0.14, re - 0.03], [F, $ + 0.14, re - 0.03]], { post: 1, tint: En });
  let me = i.mats.label("HALCYON 04", { color: "white", font: "stencil", distress: 0.35 }), ee = Math.max(1, me.aspect || 6);
  {
    let R = Math.min(1.15, 8.6 / ee);
    for (let I of [-1, 1]) g(me.material, ll(R * ee, R, 36.9, 22, I * (On + 0.453), I > 0 ? 0 : Math.PI));
  }
  {
    let R = Math.min(0.86, 9.4 / ee);
    g(me.material, ll(R * ee, R, Bt - 0.453, 13, 0, -Math.PI / 2));
  }
  if (n) return o.remap = null, o.dz = 0, o.minSize = 0, null;
  let B = o.build({ cast: true, recv: true });
  B.name = "crane";
  let P = new io(), V = (R, I, se) => P.add(R, I, se), Y = 8.3;
  for (let R of [-0.9, 0.9]) for (let I of [-0.8, 0.8]) V(f, Ke([R, 0, I], [R * 0.8, -Y, I * 0.7], 0.022, 5));
  V(l, Ee(-0.95, -Y - 0.55, -0.75, 0.95, -Y, 0.75, 0.05), En);
  for (let R of [-0.45, 0.45]) V(f, xt(0.3, 0.3, 0.12, "z", 0, -Y + 0.12, R, 12));
  let L = -Y - 0.55, Z = L - 0.34;
  for (let R of [-0.6, 0.6]) V(l, Ee(R - 0.16, Z, -6.02, R + 0.16, L, 6.02, 0.03), En);
  for (let R of [-5.92, 5.92]) V(l, Ee(-1.22, Z, R - 0.14, 1.22, L, R + 0.14, 0.03), En);
  V(l, Ee(-0.9, Z - 0.02, -1.3, 0.9, L + 0.1, 1.3, 0.04), En);
  for (let R of [-1.2, 1.2]) for (let I of [-6, 6]) V(f, Ee(R - 0.1, Z - 0.1, I - 0.1, R + 0.1, Z + 0.05, I + 0.1)), V(l, jt([R * 1.02, Z, I * 1.01], [R * 1.22, Z - 0.55, I * 1.04], 0.28, 0.03), En);
  let J = Z - 0.08, oe = J - 2.59, fe = [0.9, 0.82, 0.8];
  V(u, Ee(-1.2, oe, -6.08, 1.2, J, 6.08, 0.03), fe);
  for (let R of [-1.22, 1.22]) for (let I = -5.7; I <= 5.71; I += 0.57) V(u, Ee(R - 0.02, oe + 0.16, I - 0.1, R + 0.02, J - 0.12, I + 0.1), fe);
  for (let R of [-6.095, 6.095]) for (let I of [-1.22, 1.22]) V(u, Ee(I - 0.08, oe, R - 0.08, I + 0.08, J, R + 0.08), [0.7, 0.62, 0.6]);
  for (let R of [-0.8, -0.3, 0.3, 0.8]) V(f, Ke([R, oe + 0.08, 6.1], [R, J - 0.08, 6.1], 0.02, 5));
  let le = P.build({ cast: true, recv: true });
  return le.position.set(ks, 20.7, 0), le.userData.noMerge = true, le.name = "crane-spreader", B.add(le), { root: B, spreader: le, colliders: x, tris: o.tris + P.tris };
}
var rt = 41, vR = 8, Eo = -9, qn = 63, xR = -4.4, Fs = 13, Vc = -1.6, gb = (i, e, t) => {
  let n = Math.min(1, Math.max(0, (t - i) / (e - i)));
  return n * n * (3 - 2 * n);
}, yR = (i) => 1.7 * Math.pow(Math.max(0, 1 - i / 20), 2) + 0.5 * Math.pow(Math.max(0, (i - (qn - 12)) / 12), 2), hs = (i) => Fs + yR(i), Tf = (i) => 1.15 * (1 - gb(14.5, 18, i) + gb(qn - 10.5, qn - 8, i)), Bo = (i) => hs(i) + Tf(i), bR = Bo(0);
function fn(i, e, t) {
  let n = (bR - e) * 0.22, s = Math.max(0, 1 - i / 22), o = Eo - i - n * s, r = Math.min(1, Math.max(0, (e - Vc) / (Fs - Vc))), a = 17 - 8.5 * Math.pow(r, 1.3), l = i / a, c = l >= 1 ? 1 : Math.pow(Math.sin(l * Math.PI / 2), 0.72), u = 0.2 + (vR - 0.2) * c, h = (i - (qn - 10)) / 10;
  return h > 0 && (u *= 1 - 0.24 * h * h * (1 - 0.6 * r)), new THREE.Vector3(rt + t * u, e, o);
}
function ha(i, e, t) {
  let s = fn(i + 0.05, e, t).sub(fn(Math.max(0, i - 0.05), e, t)), o = fn(i, e + 0.05, t).sub(fn(i, e - 0.05, t)), r = s.cross(o).normalize();
  return r.x * t + r.z * 0.25 < 0 && r.negate(), r;
}
function ul(i, e, t, n, s, o = 0.012, r = 6, a = 1) {
  let l = [], c = [], u = [], h = [];
  for (let d = 0; d <= a; d++) for (let v = 0; v <= r; v++) {
    let g = i + (e - i) * v / r, x = t + (n - t) * d / a, y = ha(g, x, s), b = fn(g, x, s).addScaledVector(y, o);
    l.push(b.x, b.y, b.z), u.push(y.x, y.y, y.z), c.push(s < 0 ? 1 - v / r : v / r, d / a);
  }
  let f = r + 1;
  for (let d = 0; d < a; d++) for (let v = 0; v < r; v++) {
    let g = d * f + v, x = g + 1, y = g + f + 1, b = g + f;
    s > 0 ? h.push(g, x, y, g, y, b) : h.push(g, y, x, g, b, y);
  }
  let p = new THREE.BufferGeometry();
  return p.setAttribute("position", new THREE.Float32BufferAttribute(l, 3)), p.setAttribute("normal", new THREE.Float32BufferAttribute(u, 3)), p.setAttribute("uv", new THREE.Float32BufferAttribute(c, 2)), p.setIndex(h), p;
}
var D1 = class {
  constructor() {
    this.p = [], this.n = [], this.u = [], this.c = [];
  }
  v(e, t, n, s, o) {
    this.p.push(e.x, e.y, e.z), this.n.push(t.x, t.y, t.z), this.u.push(n, s), this.c.push(o[0], o[1], o[2]);
  }
  quad(e, t, n, s) {
    let o = e[1].clone().sub(e[0]), r = e[3].clone().sub(e[0]), a = o.cross(r).dot(t[0]) >= 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
    for (let l of a) this.v(e[l], t[l], n[l][0], n[l][1], s[l]);
  }
  geo() {
    let e = new THREE.BufferGeometry();
    return e.setAttribute("position", new THREE.Float32BufferAttribute(this.p, 3)), e.setAttribute("normal", new THREE.Float32BufferAttribute(this.n, 3)), e.setAttribute("uv", new THREE.Float32BufferAttribute(this.u, 2)), e.setAttribute("color", new THREE.Float32BufferAttribute(this.c, 3)), e;
  }
}, hl = (i, e) => {
  let t = Math.imul(i + 31, 374761393) ^ Math.imul(e + 17, 668265263);
  return t = Math.imul(t ^ t >>> 13, 1274126177), ((t ^ t >>> 16) >>> 0) / 4294967295;
};
function vb(i, e) {
  let t = new io(), n = so(i, "hull_paint"), s = so(i, "hull_red"), o = so(i, "paint_white"), r = i.mats.get("steel_dark"), a = i.mats.get("steel_galv"), l = i.mats.get("rope"), c = i.mats.get("rubber"), u = [2.6, 1.75, 0.95], h = ($) => e.add($, u, 0), f = ($, ue, me) => t.add($, ue, me), p = [0, 0.35, 0.9, 1.8, 3, 4.5, 6, 8, 10, 12, 14.5, 17, 20];
  for (let $ = 23; $ < qn - 0.5; $ += 3) p.push($);
  p.push(qn);
  let d = [0, 0.17, 0.34, 0.5, 0.66, 0.83, 1], v = ($) => {
    let ue = hs($), me = [xR, -2.3, -0.4, 1];
    for (let ee = 1; ee < d.length; ee++) me.push(1 + (ue - 1) * d[ee]);
    return me.push(Bo($)), me;
  }, g = 10, x = 3, y = new D1(), b = new D1(), m = ($, ue, me, ee) => {
    let B = hv($.x * 0.6, $.y, $.z * 0.6, void 0, 0.8), P = [B[0] * ee, B[1] * ee, B[2] * ee];
    return ue < x ? $.y < -0.2 ? (P[0] *= 0.55, P[1] *= 0.72, P[2] *= 0.55) : me && (P[0] *= 1.12, P[1] *= 1, P[2] *= 0.92) : $.y < 1.1 && (P[0] *= 1.7, P[1] *= 1.62, P[2] *= 1.45), P;
  };
  for (let $ of [-1, 1]) for (let ue = 0; ue < p.length - 1; ue++) {
    let me = p[ue], ee = p[ue + 1], B = v(me), P = v(ee);
    for (let V = 0; V < g; V++) {
      if (V === g - 1 && Tf(me) < 0.02 && Tf(ee) < 0.02) continue;
      let Y = (V < x ? 0.8 : 0.58) + 0.36 * hl(ue * 7 + ($ > 0 ? 100 : 0), V), L = [fn(me, B[V], $), fn(ee, P[V], $), fn(ee, P[V + 1], $), fn(me, B[V + 1], $)], Z = [ha(me, B[V], $), ha(ee, P[V], $), ha(ee, P[V + 1], $), ha(me, B[V + 1], $)], J = [[me, B[V]], [ee, P[V]], [ee, P[V + 1]], [me, B[V + 1]]], oe = [m(L[0], V, false, Y), m(L[1], V, false, Y), m(L[2], V, true, Y), m(L[3], V, true, Y)];
      if (me > 1.5 && V >= 2 && V < g - 1) {
        let fe = L[0].clone().add(L[1]).add(L[2]).add(L[3]).multiplyScalar(0.25);
        for (let le = 0; le < 4; le++) Z[le].addScaledVector(fe.clone().sub(L[le]).normalize(), 0.075).normalize();
      }
      (V < x ? y : b).quad(L, Z, J, oe);
    }
  }
  {
    let $ = v(0), ue = v(qn), me = _t(0, 0.2, 1).normalize(), ee = _t(0, 0, -1), B = _t(0, 1, 0);
    for (let P = 0; P < g; P++) {
      let V = P < x ? [0.8, 0.8, 0.8] : [0.9, 0.9, 0.9];
      (P < x ? y : b).quad([fn(0, $[P], -1), fn(0, $[P], 1), fn(0, $[P + 1], 1), fn(0, $[P + 1], -1)], [me, me, me, me], [[0, $[P]], [0.4, $[P]], [0.4, $[P + 1]], [0, $[P + 1]]], [V, V, V, V]), (P < x ? y : b).quad([fn(qn, ue[P], -1), fn(qn, ue[P], 1), fn(qn, ue[P + 1], 1), fn(qn, ue[P + 1], -1)], [ee, ee, ee, ee], [[0, ue[P]], [14, ue[P]], [14, ue[P + 1]], [0, ue[P + 1]]], [V, V, V, V]);
    }
    for (let P = 0; P < p.length - 1; P++) {
      let V = fn(p[P], hs(p[P]), -1), Y = fn(p[P], hs(p[P]), 1), L = fn(p[P + 1], hs(p[P + 1]), 1), Z = fn(p[P + 1], hs(p[P + 1]), -1), J = [0.75, 0.72, 0.7];
      y.quad([V, Y, L, Z], [B, B, B, B], [[V.x, V.z], [Y.x, Y.z], [L.x, L.z], [Z.x, Z.z]], [J, J, J, J]);
    }
  }
  f(s, y.geo()), f(n, b.geo());
  {
    let $ = (me, ee) => fn(me, ee, -1).addScaledVector(ha(me, ee, -1), 0.012), ue = [1.05, 0.92, 0.8];
    for (let me = 2; me < p.length - 1; me++) {
      let ee = v(p[me]), B = v(p[me + 1]);
      for (let P = 4; P <= 9; P++) f(n, jt($(p[me], ee[P]), $(p[me + 1], B[P]), 0.03, 0.045), ue);
      for (let P = 3; P < 9; P++) (me + P) % 2 === 0 && f(n, jt($(p[me], ee[P]), $(p[me], ee[P + 1]), 0.035, 0.03), ue);
    }
  }
  for (let $ of [-1, 1]) {
    for (let Y = 3; Y < p.length - 1; Y++) {
      let L = (Z, J) => fn(Z, J, $).addScaledVector(ha(Z, J, $), 0.07);
      f(n, jt(L(p[Y], 9.6), L(p[Y + 1], 9.6), 0.16, 0.3), [0.55, 0.55, 0.55]), Tf(p[Y]) > 0.6 && Tf(p[Y + 1]) > 0.6 && f(r, Ke(fn(p[Y], Bo(p[Y]), $), fn(p[Y + 1], Bo(p[Y + 1]), $), 0.07, 6));
    }
    for (let Y = 0; Y < 3; Y++) f(r, Ke(fn(p[Y], Bo(p[Y]), $), fn(p[Y + 1], Bo(p[Y + 1]), $), 0.07, 6));
    let ue = [];
    for (let Y = 18; Y <= qn - 10.4; Y += 3) ue.push(fn(Y, hs(Y), $).add(_t(-$ * 0.12, 0, 0)));
    ns(t, r, ue, { h: 1.05, post: 1.5, r: 0.028 });
    let me = 4.6, ee = hs(me) - 2.3, B = fn(me, ee, $), P = ha(me, ee, $);
    f(r, Ke(B.clone().addScaledVector(P, -0.3), B.clone().addScaledVector(P, 0.22), 0.5, 12, true));
    let V = (Y, L, Z) => fn(Y, L, $).addScaledVector(ha(Y, L, $), Z);
    f(r, jt(V(me, ee - 0.1, 0.34), V(me, ee - 2.3, 0.3), 0.22, 0.22, 0.03)), f(r, jt(V(me - 0.95, ee - 2.45, 0.34), V(me + 0.95, ee - 2.45, 0.34), 0.42, 0.42, 0.05));
    for (let Y of [-0.8, 0.8]) f(r, jt(V(me + Y, ee - 2.4, 0.3), V(me + Y * 1.1, ee - 1.1, 0.34), 0.5, 0.12, 0.02));
  }
  let A = i.mats.label("KITTIWAKE", { color: "white", font: "sans", distress: 0.3 });
  {
    let ue = Math.min(12, 1.7 * Math.max(2, A.aspect || 6));
    f(A.material, ul(7.6, 7.6 + ue, 10.25, 10.25 + 1.7, -1, 0.014, 10, 1)), f(A.material, ul(7.6, 7.6 + ue, 10.25, 10.25 + 1.7, 1, 0.014, 10, 1));
  }
  let _ = i.mats.decal("rust_run");
  f(_.material, ul(4.6 - 0.8, 4.6 + 0.8, hs(4.6) - 9.5, hs(4.6) - 2.6, -1, 0.012, 2, 3));
  for (let $ = 21.5; $ < qn - 11; $ += 5.5) {
    let ue = fn($, Fs - 0.45, -1);
    f(r, Ee(ue.x - 0.04, ue.y - 0.09, ue.z - 0.3, ue.x + 0.01, ue.y + 0.09, ue.z + 0.3));
    let me = 2.6 + 3.2 * hl(Math.round($ * 10), 5);
    f(_.material, ul($ - 0.45, $ + 0.45, Fs - 0.5 - me, Fs - 0.5, -1, 0.012, 1, 1));
  }
  for (let $ of [6.4, qn - 7]) for (let ue = 0; ue < 9; ue++) {
    let me = 1.6 + ue * 0.62;
    f(o, ul($, $ + (ue % 2 ? 0.28 : 0.5), me, me + 0.13, -1, 0.01, 1, 1), [1.1, 1.1, 1.05]);
  }
  f(o, ul(33, 33.9, 3.2, 3.3, -1, 0.01, 1, 1), [1.1, 1.1, 1.05]), f(o, ul(33.4, 33.5, 2.4, 4.1, -1, 0.01, 1, 1), [1.1, 1.1, 1.05]);
  let M = hs(7);
  for (let $ of [-1, 1]) {
    f(r, xt(0.55, 0.55, 0.9, "x", rt + $ * 1.5, M + 0.75, Eo - 6.2, 12)), f(r, Ee(rt + $ * 0.5, M, Eo - 6.9, rt + $ * 2.6, M + 0.5, Eo - 5.5, 0.04));
    for (let ue of [0, 0.7]) f(r, xt(0.16, 0.16, 0.7, "y", rt + $ * 4.2, M + 0.35, Eo - 8.5 - ue, 8));
  }
  let E = Eo - 10.5, w = M + 15;
  f(o, xt(0.26, 0.42, 15, "y", rt, M + 7.5, E, 10), [0.85, 0.8, 0.7]), f(o, Ee(rt - 2.6, M + 10, E - 0.12, rt + 2.6, M + 10.24, E + 0.12), [0.85, 0.8, 0.7]), f(r, Ke([rt, w, E], [rt, w + 2.4, E], 0.03, 5));
  for (let $ of [-1, 1]) f(r, Ke([rt + $ * 2.5, M + 10.2, E], [rt + $ * 5.6, M + 0.6, E - 1.2], 0.022, 4)), f(r, Ke([rt + $ * 2.5, M + 10.2, E], [rt, w, E], 0.02, 4));
  f(r, Ke([rt, w, E], [rt, Bo(0) + 0.3, Eo - 0.4], 0.022, 4)), f(r, Ke([rt, Bo(0), Eo - 0.3], [rt, Bo(0) + 2.6, Eo - 0.15], 0.03, 5));
  let S = _t(rt, M + 2.2, E - 0.5), z = _t(rt + 1.2, M + 9.5, E - 11.5);
  f(o, Ke(S, z, 0.2, 8, true), [0.85, 0.8, 0.7]), f(r, Ke(z, [rt, w - 0.4, E], 0.022, 4)), f(r, Ke(z, [z.x, Fs + 4, z.z], 0.018, 4)), f(r, Ee(z.x - 0.18, Fs + 3.4, z.z - 0.18, z.x + 0.18, Fs + 4, z.z + 0.18, 0.04)), e.add(Bn(rt, w - 0.6, E + 0.5, 0.14), [5, 4.6, 3.8], 0);
  let H = [[0.62, 0.17, 0.13], [0.17, 0.29, 0.5], [0.2, 0.42, 0.3], [0.78, 0.36, 0.12], [0.8, 0.62, 0.16], [0.82, 0.83, 0.8], [0.4, 0.43, 0.47], [0.16, 0.42, 0.45]];
  [[-45.6, 12.19], [-32.7, 12.19], [-22.8, 6.06]].forEach(([$, ue], me) => {
    f(s, Ee(rt - 7.7, Fs, $ - ue / 2 - 0.2, rt + 7.7, Fs + 0.42, $ + ue / 2 + 0.2, 0.04), [0.6, 0.6, 0.62]);
    for (let ee = 0; ee < 6; ee++) {
      let B = rt + (ee - 2.5) * 2.52, P = me === 2 ? 2 : 2 + (hl(ee * 3 + me, 9) > 0.4 ? 1 : 0);
      for (let V = 0; V < P; V++) {
        let Y = Fs + 0.44 + V * 2.61, L = H[Math.floor(hl(ee * 5 + V * 13 + me * 29, 2) * H.length)];
        if (f(o, Ee(B - 1.22, Y, $ - ue / 2, B + 1.22, Y + 2.59, $ + ue / 2, 0.035), L), ee === 0) for (let Z = $ - ue / 2 + 0.5; Z < $ + ue / 2 - 0.3; Z += 0.58) f(o, Ee(B - 1.24, Y + 0.15, Z - 0.1, B - 1.21, Y + 2.45, Z + 0.1), L);
      }
    }
    for (let ee of [$ - ue / 2 - 0.45, $ + ue / 2 + 0.45]) {
      for (let B = 0; B <= 6; B++) f(r, Ee(rt + (B - 3) * 2.52 - 0.05, Fs, ee - 0.05, rt + (B - 3) * 2.52 + 0.05, Fs + 5.6, ee + 0.05));
      for (let B of [Fs + 2.9, Fs + 5.6]) f(r, Ee(rt - 7.6, B - 0.05, ee - 0.12, rt + 7.6, B + 0.05, ee + 0.12));
    }
  });
  let q = [0.92, 0.93, 0.92], U = -53, T = -66.5;
  [[7.2, 13, 15.9, 0], [6.7, 15.9, 18.7, 0.5], [6.3, 18.7, 21.5, 1], [6.5, 21.5, 24.4, 1.5]].forEach(([$, ue, me, ee], B) => {
    f(o, Ee(rt - $, ue, T + ee * 0.4, rt + $, me, U - ee, 0.08), q), f(o, Ee(rt - $ - 0.7, me - 0.06, T + ee * 0.4 - 0.3, rt + $ + 0.7, me + 0.06, U - ee + 1), [0.7, 0.72, 0.72]);
    let P = me + 0.06, V = rt - $ - 0.67, Y = rt + $ + 0.67, L = U - ee + 0.97, Z = T + ee * 0.4 - 0.27;
    if (ns(t, a, [[V, P, Z], [V, P, L], [Y, P, L], [Y, P, Z]], { h: 1.05, post: 1.6, r: 0.026 }), B < 3) for (let J = U - ee - 1.2, oe = 0; J > T + 1.5; J -= 1.45, oe++) {
      let fe = hl(oe * 3 + B * 11, 4) > 0.8;
      for (let le of [-1, 1]) {
        let R = Ee(rt + le * ($ + 0.012) - 0.012, ue + 1.25, J - 0.33, rt + le * ($ + 0.012) + 0.012, ue + 1.85, J + 0.33);
        fe && le < 0 ? h(R) : f(r, R);
      }
    }
    if (B < 3) for (let J = rt - $ + 1, oe = 0; J < rt + $ - 0.6; J += 1.5, oe++) {
      let fe = Ee(J - 0.33, ue + 1.25, U - ee - 0.01, J + 0.33, ue + 1.85, U - ee + 0.014);
      hl(oe + B * 7, 8) > 0.84 ? h(fe) : f(r, fe);
    }
  });
  let C = 21.5, G = U - 1.5, j = 6.5;
  f(r, Ee(rt - j + 0.2, C + 1.3, G - 0.01, rt + j - 0.2, C + 2.25, G + 0.02));
  for (let $ = rt - j + 0.75, ue = 0; $ < rt + j - 0.4; $ += 1.05, ue++) hl(ue, 21) > 0.62 && h(Ee($ - 0.44, C + 1.36, G + 0.02, $ + 0.44, C + 2.19, G + 0.03)), f(o, Ee($ + 0.48, C + 1.3, G, $ + 0.57, C + 2.25, G + 0.04), q);
  for (let $ of [-1, 1]) f(r, Ee(rt + $ * j - 0.02, C + 1.3, G - 5, rt + $ * j + 0.02, C + 2.25, G - 0.2)), f(o, Ee(rt + $ * 6.4, C - 0.12, G - 3.4, rt + $ * 8.3, C + 0.02, G + 0.9, 0.03), q), f(o, Ee(rt + $ * 8.22, C, G - 3.4, rt + $ * 8.3, C + 1.1, G + 0.9), q), f(o, Ee(rt + $ * 6.5, C, G + 0.82, rt + $ * 8.3, C + 1.1, G + 0.9), q), f(r, jt([rt + $ * 6.6, C - 2.6, G - 1.2], [rt + $ * 8.1, C - 0.1, G - 1.2], 0.12, 0.12)), e.add(Bn(rt + $ * 8.25, C + 1.35, G - 0.4, 0.13), $ < 0 ? [0.3, 5, 1.6] : [6, 0.4, 0.3], 0);
  h(Ee(rt - 2.2, 24.42, G + 0.6, rt - 1.6, 24.52, G + 0.9)), h(Ee(rt + 1.6, 24.42, G + 0.6, rt + 2.2, 24.52, G + 0.9));
  let N = _t(rt, 24.46, -57.5);
  f(o, xt(0.16, 0.28, 8.5, "y", N.x, N.y + 4.25, N.z, 8), q), f(o, Ee(N.x - 2.4, N.y + 5.2, N.z - 0.08, N.x + 2.4, N.y + 5.36, N.z + 0.08), q), f(o, Ee(N.x - 1.3, N.y + 7.3, N.z - 0.06, N.x + 1.3, N.y + 7.42, N.z + 0.06), q), f(o, Ee(N.x - 0.5, N.y + 3.2, N.z, N.x + 0.5, N.y + 3.3, N.z + 1.2), q);
  for (let $ of [-2.3, -1.2, 1.2, 2.3]) f(r, Ke([N.x + $, N.y + 5.36, N.z], [N.x + $, N.y + 5.36 + (Math.abs($) > 2 ? 3.2 : 1.2), N.z], 0.012, 4));
  f(r, Ke([N.x, N.y + 8.5, N.z], [N.x, N.y + 10.8, N.z], 0.015, 4));
  for (let $ of [-1, 1]) f(r, Ke([N.x + $ * 2.3, N.y + 5.3, N.z], [rt + $ * 6, 24.5, T + 2], 0.014, 4));
  e.add(Bn(N.x, N.y + 8.7, N.z + 0.3, 0.14), [5, 4.6, 3.8], 0), e.add(Bn(N.x, N.y + 7.6, N.z, 0.12), [8, 0.4, 0.25], 3.4, 0.6, 0.4);
  let Q = -62.6;
  f(o, Ee(rt - 1.7, 24.4, Q - 2.3, rt + 1.7, 29.3, Q + 2.1, 0.25), [0.2, 0.34, 0.5]), f(o, Ee(rt - 1.72, 27.2, Q - 2.32, rt + 1.72, 28.1, Q + 2.12, 0.1), [0.9, 0.88, 0.8]), f(o, Ee(rt - 1.75, 29.3, Q - 2.35, rt + 1.75, 30.3, Q + 2.15, 0.2), [0.07, 0.07, 0.08]);
  for (let $ of [-0.9, 0.5]) f(r, xt(0.28, 0.28, 1.1, "y", rt, 30.7, Q + $, 10));
  let K = i.mats.decal("logo_b");
  f(K.material, ll(2.6, 2.6 / Math.max(1, K.aspect || 1), rt - 1.705, 26.1, Q - 0.1, -Math.PI / 2));
  {
    let $ = rt - 7.9, ue = 17.5, me = -61, ee = [1.25, 0.42, 0.1], B = new THREE.CapsuleGeometry(1.15, 3.6, 4, 12);
    B.rotateX(Math.PI / 2), B.scale(0.95, 0.82, 1), B.translate($, ue, me), f(o, B, ee), f(o, Ee($ - 0.6, ue + 0.7, me - 1.2, $ + 0.6, ue + 1.25, me + 0.9, 0.12), ee);
    for (let P of [-2.1, 2.1]) f(r, jt([rt - 6.9, 15.9, me + P], [$ - 0.2, ue + 2.3, me + P], 0.16, 0.22)), f(r, Ke([$ - 0.2, ue + 2.2, me + P], [$, ue + 0.9, me + P * 0.8], 0.02, 4));
  }
  f(r, Ke([rt, Bo(qn), Eo - qn + 0.4], [rt, Bo(qn) + 3.4, Eo - qn - 0.3], 0.03, 5)), e.add(Bn(rt, Bo(qn) + 0.6, Eo - qn - 0.1, 0.1), [4, 3.7, 3], 0);
  let F = t.build({ cast: true, recv: true });
  F.name = "ship";
  let X = new io();
  X.add(o, Ee(-1.25, -0.07, -0.1, 1.25, 0.07, 0.1, 0.02), q), X.add(o, xt(0.1, 0.12, 0.25, "y", 0, -0.18, 0, 8), q);
  let ne = X.build({ cast: false });
  ne.position.set(N.x, N.y + 3.62, N.z + 0.8), ne.userData.noMerge = true, F.add(ne);
  let re = [{ min: [33, -5, Eo - qn], max: [49, 15, -17.5] }, { min: [34.9, -5, -17.5], max: [47.1, 15.5, -13] }, { min: [37.7, -5, -13], max: [44.3, 16, -9.3] }, { min: [rt - 7.2, 13, T], max: [rt + 7.2, 24.4, U] }];
  return { root: F, radar: ne, colliders: re, tris: t.tris, name: "KITTIWAKE" };
}
function xb(i, e) {
  let t = new io(), n = so(i, "plastic_grey"), s = so(i, "paint_orange"), o = i.mats.get("polymer_black"), r = i.mats.get("steel_galv"), a = i.mats.get("glass"), l = (U, T, D) => t.add(U, T, D), c = [2, 2.02, 2.08], u = [0.5, 0.5, 0.52], h = [1.9, 1.7, 1.2], f = [[-3.35, 0.5, 1.03], [-1.6, 0.5, 1.06], [0.5, 0.52, 1.05], [1.8, 0.58, 0.93], [2.75, 0.68, 0.6], [3.3, 0.78, 0.22]], p = [...f.map((U) => _t(U[0], U[1], U[2])), _t(3.43, 0.8, 0), ...f.slice().reverse().map((U) => _t(U[0], U[1], -U[2]))], d = new THREE.CatmullRomCurve3(p, false, "centripetal"), v = new THREE.TubeGeometry(d, 60, 0.27, 12, false);
  {
    let U = v.attributes.uv, T = d.getLength();
    for (let D = 0; D < U.count; D++) U.setXY(D, U.getX(D) * T, U.getY(D) * 1.7);
  }
  l(n, v, c);
  for (let U of [-1, 1]) l(n, xt(0.07, 0.27, 0.42, "x", -3.56, 0.5, U * 1.03, 12), c);
  let g = 11, x = [];
  for (let U = 0; U < g; U++) {
    let T = 0.04 + 0.92 * U / (g - 1), D = d.getPointAt(T), C = d.getTangentAt(T), G = new THREE.TorusGeometry(0.276, 0.016, 5, 14);
    G.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(_t(0, 0, 1), C)), G.translate(D.x, D.y, D.z), l(n, G, u);
    let j = _t(D.x, 0, D.z).sub(_t(Math.min(D.x, 2.2), 0, 0)).normalize();
    x.push(D.clone().addScaledVector(j, 0.2).add(_t(0, 0.2, 0)));
  }
  for (let U = 0; U < g - 1; U++) l(n, kr(ua(x[U], x[U + 1], 0.1, 4), 0.012, 4), h);
  let y = [-3.4, -2, -0.5, 1, 2, 2.8, 3.3], b = [0.9, 0.93, 0.93, 0.85, 0.62, 0.34, 0.08], m = [0.22, 0.22, 0.24, 0.3, 0.42, 0.56, 0.7], A = [-0.3, -0.32, -0.33, -0.3, -0.15, 0.15, 0.62], _ = [], M = (U, T, D) => {
    let C = T.clone().sub(U).cross(D.clone().sub(U)), G = U.clone().add(T).add(D).multiplyScalar(1 / 3), j = _t(0, G.y - 0.45, G.z);
    Math.abs(G.x) > 3.39 && j.set(G.x, 0, 0), C.dot(j) < 0 ? _.push(U.x, U.y, U.z, D.x, D.y, D.z, T.x, T.y, T.z) : _.push(U.x, U.y, U.z, T.x, T.y, T.z, D.x, D.y, D.z);
  };
  for (let U of [-1, 1]) {
    for (let T = 0; T < y.length - 1; T++) {
      let D = _t(y[T], A[T], 0), C = _t(y[T + 1], A[T + 1], 0), G = _t(y[T], m[T], U * b[T]), j = _t(y[T + 1], m[T + 1], U * b[T + 1]), N = _t(y[T], 0.5 + Math.max(0, m[T] - 0.22) * 0.6, U * (b[T] + 0.1)), Q = _t(y[T + 1], 0.5 + Math.max(0, m[T + 1] - 0.22) * 0.6, U * (b[T + 1] + 0.1));
      M(D, C, j), M(D, j, G), M(G, j, Q), M(G, Q, N);
    }
    M(_t(-3.4, A[0], 0), _t(-3.4, m[0], U * b[0]), _t(-3.4, 0.78, U * (b[0] + 0.1))), M(_t(-3.4, A[0], 0), _t(-3.4, 0.78, U * (b[0] + 0.1)), _t(-3.4, 0.78, 0));
  }
  let E = new THREE.BufferGeometry();
  E.setAttribute("position", new THREE.Float32BufferAttribute(_, 3)), E.computeVertexNormals(), l(o, E), l(n, Ee(-3.38, 0.2, -0.86, 2.1, 0.26, 0.86), u), l(n, Ee(2, 0.26, -0.62, 2.85, 0.56, 0.62, 0.05), u), l(o, Ee(-3.46, 0.1, -0.92, -3.34, 0.8, 0.92, 0.02)), l(r, Ke([3.2, 0.95, -0.12], [3.2, 0.95, 0.12], 0.02, 5)), l(r, Ke([3.2, 0.8, 0], [3.2, 0.95, 0], 0.018, 5)), l(s, Ee(0.3, 0.26, -0.4, 1, 1.12, 0.4, 0.05), [1, 0.9, 0.85]), l(o, jt([0.28, 1.14, 0], [0.86, 1.3, 0], 0.76, 0.05));
  let w = Ee(-0.012, 0, -0.42, 0.012, 0.5, 0.42);
  w.rotateZ(0.42), w.translate(0.95, 1.2, 0), l(a, w);
  for (let U of [-0.43, 0.43]) l(r, Ke([0.95, 1.2, U], [0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, U], 0.016, 5));
  l(r, Ke([0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, -0.43], [0.95 - Math.sin(0.42) * 0.52, 1.2 + Math.cos(0.42) * 0.52, 0.43], 0.016, 5));
  let S = new THREE.TorusGeometry(0.18, 0.017, 6, 18);
  S.rotateY(Math.PI / 2), S.rotateZ(-0.5), S.translate(0.2, 1.12, -0.12), l(o, S), l(r, Ke([0.2, 1.12, -0.12], [0.36, 1.03, -0.12], 0.02, 5));
  for (let U of [0, 2.1, 4.2]) l(r, Ke([0.2, 1.12, -0.12], [0.2 + Math.sin(-0.5) * Math.cos(U) * -0.17, 1.12 + Math.cos(-0.5) * Math.cos(U) * 0.17, -0.12 + Math.sin(U) * 0.17], 0.01, 4));
  l(o, Ee(0.34, 1.16, 0.16, 0.5, 1.34, 0.3, 0.02)), l(r, Ke([0.42, 1.34, 0.23], [0.36, 1.48, 0.23], 0.012, 4)), l(r, Ke([0.35, 0.3, -0.46], [0.35, 1, -0.46], 0.02, 5)), l(r, Ke([0.35, 1, -0.46], [0.95, 1, -0.46], 0.02, 5)), l(r, Ke([0.35, 0.3, 0.46], [0.35, 1, 0.46], 0.02, 5)), l(r, Ke([0.35, 1, 0.46], [0.95, 1, 0.46], 0.02, 5));
  for (let U of [-0.75, -1.75]) l(s, Ee(U - 0.28, 0.26, -0.2, U + 0.28, 0.82, 0.2, 0.05), [1, 0.9, 0.85]), l(o, Ee(U - 0.3, 0.82, -0.22, U + 0.3, 0.93, 0.22, 0.04)), l(o, Ee(U - 0.34, 0.93, -0.2, U - 0.26, 1.2, 0.2, 0.03)), l(r, Ke([U + 0.3, 0.6, -0.22], [U + 0.3, 1.02, 0], 0.014, 4)), l(r, Ke([U + 0.3, 0.6, 0.22], [U + 0.3, 1.02, 0], 0.014, 4));
  l(s, Ee(-2.9, 0.26, -0.3, -2.45, 0.58, 0.3, 0.04), [1.1, 0.5, 0.4]);
  for (let U of [-1, 1]) l(r, Ke([-2.95, 0.55, U * 0.9], [-2.75, 2, U * 0.55], 0.03, 6)), l(r, Ke([-2.3, 0.55, U * 0.9], [-2.75, 1.3, U * 0.7], 0.022, 5));
  l(r, Ke([-2.75, 2, -0.55], [-2.75, 2, 0.55], 0.03, 6)), l(r, Ee(-2.88, 2, -0.2, -2.62, 2.04, 0.2)), l(o, xt(0.05, 0.06, 0.1, "y", -2.75, 2.09, 0, 8)), l(o, Ke([-2.75, 2, 0.42], [-2.9, 3.7, 0.46], 0.011, 5)), l(o, xt(0.16, 0.16, 0.07, "y", -2.75, 2.1, -0.36, 10));
  for (let U of [-0.36, 0.36]) l(r, Ee(-3.6, 0.42, U - 0.16, -3.44, 0.78, U + 0.16, 0.02)), l(o, Ee(-4.1, 0.78, U - 0.23, -3.48, 1.4, U + 0.23, 0.09)), l(n, Ee(-4.11, 1, U - 0.235, -3.47, 1.05, U + 0.235), [1.4, 1.4, 1.4]), l(o, Ee(-3.92, -0.05, U - 0.085, -3.62, 0.8, U + 0.085, 0.03)), l(o, Ee(-4.02, -0.52, U - 0.04, -3.6, -0.05, U + 0.04, 0.015)), l(o, xt(0.07, 0.03, 0.42, "x", -3.9, -0.3, U, 8));
  for (let U of [-1.8, 0.4, 1.7]) l(s, xt(0.11, 0.11, 0.42, "y", U, 0.42, 1.36, 10), [1.2, 0.8, 0.7]), l(n, Ke([U, 0.63, 1.36], [U, 0.78, 1.12], 0.01, 4), h);
  let z = new THREE.TorusGeometry(0.26, 0.07, 6, 16);
  z.rotateY(Math.PI / 2), z.translate(1.02, 0.72, 0), l(s, z, [1.3, 0.6, 0.45]);
  let H = t.build({ cast: true, recv: true });
  e.add(Bn(-2.75, 2.2, 0, 0.075), [1.2, 11, 3.2], 1.5, 0, 0.1), e.add(Bn(-2.75, 2.2, 0, 0.074), [1.2, 11, 3.2], 1.5, 0.2, 0.08);
  let O = e.build();
  O && (O.frustumCulled = false, H.add(O));
  let q = new THREE.Group();
  return q.name = "boat", q.add(H), q.userData.noMerge = true, { root: q, hullGrp: H, tris: t.tris };
}
function makeBeaconCollector(ctx) {
  const buckets = /* @__PURE__ */ new Map();
  const tmpColor = new THREE.Color();
  return {
    add(geo, hdrRgb = [4, 3.6, 3]) {
      if (!geo) return;
      const maxC = Math.max(hdrRgb[0] || 0, hdrRgb[1] || 0, hdrRgb[2] || 0, 0.1);
      tmpColor.setRGB((hdrRgb[0] || 0) / maxC, (hdrRgb[1] || 0) / maxC, (hdrRgb[2] || 0) / maxC);
      const hex = tmpColor.getHex();
      const intensity = Math.round(maxC * 10) / 10;
      const key = hex + "|" + intensity;
      let b = buckets.get(key);
      if (!b) {
        b = { mat: ctx.mats.emissive(hex, intensity), geos: [] };
        buckets.set(key, b);
      }
      b.geos.push(geo);
    },
    build() {
      if (!buckets.size) return null;
      const grp = new THREE.Group();
      grp.name = "beacons";
      for (const b of buckets.values()) {
        const g = Ii(b.geos);
        const m = new THREE.Mesh(g, b.mat);
        m.castShadow = false;
        m.receiveShadow = false;
        grp.add(m);
      }
      buckets.clear();
      return grp;
    }
  };
}
function shiftDirectGeometries(group, dx, dy, dz) {
  for (const child of group.children) {
    if (child.isMesh && child.geometry) {
      child.geometry.translate(dx, dy, dz);
    } else if (child.isGroup && child.name === "beacons") {
      shiftDirectGeometries(child, dx, dy, dz);
    }
  }
}
function buildPortCraneProp(ctx) {
  const beacons = makeBeaconCollector(ctx);
  const res = z1(ctx, beacons);
  const lampGrp = beacons.build();
  if (lampGrp) res.root.add(lampGrp);
  const dx = -23.5;
  shiftDirectGeometries(res.root, dx, 0, 0);
  if (res.spreader) res.spreader.position.x += dx;
  const colliders = res.colliders.map((c) => ({
    min: [c.min[0] + dx, c.min[1], c.min[2]],
    max: [c.max[0] + dx, c.max[1], c.max[2]],
    surface: "metal"
  }));
  return qi(res.root, "port_crane", Gi.port_crane.slice(0, 3), colliders);
}
function buildRtgCraneProp(ctx, opts = {}) {
  const seed = Math.abs(opts.seed | 0);
  const rng = uv(90417 + seed * 7919);
  const builder = new io();
  const beacons = makeBeaconCollector(ctx);
  const matGrey = so(ctx, "paint_grey");
  const matYellow = so(ctx, "paint_yellow");
  const matWhite = so(ctx, "paint_white");
  const matDark = ctx.mats.get("steel_dark");
  const matGalv = ctx.mats.get("steel_galv");
  const matGlass = ctx.mats.get("glass");
  const trolleyZ = (rng() - 0.5) * 8;
  const drop = 4.5 + rng() * 4.5;
  const bodyTint = [0.88, 0.9, 0.94];
  const darkTint = [0.62, 0.65, 0.7];
  const yelTint = [1, 0.95, 0.85];
  for (const sz of [-1, 1]) {
    const rz = sz * 9.5;
    for (const sx of [-1, 1]) {
      const lx = sx * 7.5;
      builder.add(matDark, Ee(lx - 1.5, 0, rz - 0.32, lx + 1.5, 0.8, rz + 0.32));
      for (const wx of [-0.95, 0.95]) {
        builder.add(matDark, xt(0.42, 0.42, 0.36, "z", lx + wx, 0.42, rz, 14));
      }
      builder.add(matGrey, Ee(lx - 0.36, 0.8, rz - 0.36, lx + 0.36, 19.1, rz + 0.36, 0.03), bodyTint);
      builder.add(matGrey, Ee(lx - 0.4, 6.9, rz - 0.4, lx + 0.4, 7, rz + 0.4), darkTint);
      builder.add(matGrey, Ee(lx - 0.4, 13, rz - 0.4, lx + 0.4, 13.1, rz + 0.4), darkTint);
      builder.add(matGrey, jt([lx, 14.6, rz], [lx - sx * 3.2, 19.1, rz], 0.3, 0.3, 0.02), bodyTint);
    }
    builder.add(matGrey, Ee(-9.3, 0.8, rz - 0.4, 9.3, 1.7, rz + 0.4, 0.03), bodyTint);
    builder.add(matGrey, Ee(-8, 19.1, rz - 0.45, 8, 20.2, rz + 0.45, 0.03), bodyTint);
    builder.add(matWhite, Ee(-2.4, 1.7, rz - 0.5, 0.8, 3.9, rz + 0.5, 0.03), [0.86, 0.88, 0.9]);
  }
  for (const sx of [-1, 1]) {
    const gx = sx * 3.3;
    const z0 = -15.1;
    const z12 = 15.1;
    builder.add(matGrey, Ee(gx - 0.45, 20.2, z0, gx + 0.45, 21.9, z12, 0.04), bodyTint);
    for (let mz = z0 + 4.4; mz < z12; mz += 4.4) {
      builder.add(matGrey, Ee(gx - 0.48, 20.15, mz - 0.03, gx + 0.48, 21.95, mz + 0.03), darkTint);
    }
    builder.add(matGalv, Ee(gx + sx * 0.45, 21, z0, gx + sx * 1.3, 21.05, z12));
    ns(builder, matYellow, [[gx + sx * 1.27, 21.05, z0], [gx + sx * 1.27, 21.05, z12]], { post: 3.3, r: 0.03, mid: true, tint: yelTint });
    builder.add(matDark, Ke([gx, 20.2, -9], [gx, 20.2, 9], 0.05, 5));
  }
  for (const ez of [-14.9, 14.9]) {
    builder.add(matGrey, Ee(-3.3, 20.4, ez - 0.25, 3.3, 21.7, ez + 0.25, 0.03), bodyTint);
  }
  builder.add(matYellow, Ee(-4, 21.9, trolleyZ - 2.3, 4, 22.5, trolleyZ + 2.3, 0.03), yelTint);
  builder.add(matWhite, Ee(-2.6, 22.5, trolleyZ - 1.7, 1.4, 24.5, trolleyZ + 1.7, 0.03), [0.88, 0.9, 0.9]);
  builder.add(matDark, Ee(1.8, 22.5, trolleyZ - 0.9, 3.4, 23.3, trolleyZ + 0.9, 0.02));
  builder.add(matWhite, Ee(4.3, 17.2, trolleyZ - 1, 6.1, 19.5, trolleyZ + 1, 0.03), [0.9, 0.9, 0.92]);
  builder.add(matGlass, Ee(4.4, 18.2, trolleyZ - 1.02, 6.12, 19.2, trolleyZ + 1.02));
  for (const cz of [-0.9, 0.9]) {
    builder.add(matYellow, Ee(4.9, 19.5, trolleyZ + cz - 0.06, 5.05, 21.9, trolleyZ + cz + 0.06), yelTint);
  }
  const spY = 21.9 - drop;
  for (const cx of [-2.2, 2.2]) {
    for (const cz of [-0.8, 0.8]) {
      builder.add(matDark, Ke([cx, 21.9, trolleyZ + cz], [cx, spY, trolleyZ + cz], 0.03, 5));
    }
  }
  builder.add(matYellow, Ee(-6.1, spY - 0.4, trolleyZ - 1.22, 6.1, spY, trolleyZ + 1.22, 0.03), yelTint);
  builder.add(matYellow, Ee(-2.4, spY, trolleyZ - 0.9, 2.4, spY + 0.5, trolleyZ + 0.9, 0.03), yelTint);
  const stX = -8;
  const stZ = -9.5;
  let stY = 1.7;
  for (let s = 0; s < 6; s++) {
    const zA2 = stZ + (s % 2 ? 1.9 : -1.9);
    const zB = stZ + (s % 2 ? -1.9 : 1.9);
    const yNext = Math.min(20.2, stY + 3.1);
    builder.add(matGalv, jt([stX, stY, zA2], [stX, yNext, zB], 0.6, 0.07));
    builder.add(matYellow, Ke([stX - 0.3, stY + 1, zA2], [stX - 0.3, yNext + 1, zB], 0.03, 4), yelTint);
    builder.add(matGalv, Ee(stX - 0.35, yNext - 0.04, zB - 0.5, stX + 0.35, yNext, zB + 0.5));
    stY = yNext;
  }
  builder.add(matYellow, xt(1.25, 1.25, 0.5, "z", 8.5, 3.3, 10.4, 12), yelTint);
  builder.add(matDark, xt(0.5, 0.5, 0.6, "z", 8.5, 3.3, 10.4, 8));
  beacons.add(Bn(0, 24.9, trolleyZ, 0.22), [8, 0.45, 0.25]);
  beacons.add(Bn(-3.3, 20, -4, 0.2), [5.5, 4.3, 2.9]);
  beacons.add(Bn(3.3, 20, 4, 0.2), [5.5, 4.3, 2.9]);
  const root = builder.build({ cast: true, recv: true });
  root.name = "rtg_crane";
  const lampGrp = beacons.build();
  if (lampGrp) root.add(lampGrp);
  const colliders = [
    { min: [-9.3, 0, -10], max: [9.3, 20.2, -9], surface: "metal" },
    { min: [-9.3, 0, 9], max: [9.3, 20.2, 10], surface: "metal" },
    { min: [-4.6, 20.2, -15.1], max: [4.6, 25.2, 15.1], surface: "metal" }
  ];
  return qi(root, "rtg_crane", Gi.rtg_crane.slice(0, 3), colliders);
}
function buildCargoShipProp(ctx) {
  const beacons = makeBeaconCollector(ctx);
  const res = vb(ctx, beacons);
  const lampGrp = beacons.build();
  if (lampGrp) res.root.add(lampGrp);
  const dx = -41;
  const dy = 4.4;
  const dz = 40.5;
  shiftDirectGeometries(res.root, dx, dy, dz);
  if (res.radar) {
    res.radar.position.x += dx;
    res.radar.position.y += dy;
    res.radar.position.z += dz;
  }
  const colliders = res.colliders.map((c) => ({
    min: [c.min[0] + dx, Math.max(0, c.min[1] + dy), c.min[2] + dz],
    max: [c.max[0] + dx, c.max[1] + dy, c.max[2] + dz],
    surface: "metal"
  }));
  return qi(res.root, "cargo_ship", Gi.cargo_ship.slice(0, 3), colliders);
}
function buildRigidBoatProp(ctx) {
  const beacons = makeBeaconCollector(ctx);
  const res = xb(ctx, beacons);
  const dy = 0.52;
  shiftDirectGeometries(res.hullGrp, 0, dy, 0);
  return qi(res.root, "rigid_boat", Gi.rigid_boat.slice(0, 3), [
    { min: [-4.1, 0, -1.4], max: [3.5, 4.22, 1.4], surface: "rubber" }
  ]);
}
function buildCommsTowerProp(ctx, opts = {}) {
  const seed = Math.abs(opts.seed | 0);
  const builder = new io();
  const beacons = makeBeaconCollector(ctx);
  const matWhite = so(ctx, "paint_white");
  const matRed = so(ctx, "paint_red");
  const matGalv = ctx.mats.get("steel_galv");
  const matDark = ctx.mats.get("steel_dark");
  const matConc = so(ctx, "concrete");
  const matAlum = ctx.mats.get("aluminium");
  const H = 31.5;
  const legs = [[-1.35, -0.78], [1.35, -0.78], [0, 1.56]];
  for (const [lx, lz] of legs) {
    builder.add(matConc, Ee(lx - 0.45, 0, lz - 0.45, lx + 0.45, 0.35, lz + 0.45, 0.03), [0.85, 0.85, 0.82]);
    builder.add(matGalv, Ee(lx - 0.22, 0.35, lz - 0.22, lx + 0.22, 0.42, lz + 0.22));
  }
  const tiers = 9;
  const tierH = (H - 0.4) / tiers;
  for (let t = 0; t < tiers; t++) {
    const y0 = 0.4 + t * tierH;
    const y12 = y0 + tierH;
    const s0 = 1 - 0.68 * ((y0 - 0.4) / H);
    const s1 = 1 - 0.68 * ((y12 - 0.4) / H);
    const bandMat = t % 2 === 0 ? matRed : matWhite;
    const bandTint = t % 2 === 0 ? [0.95, 0.9, 0.88] : [0.95, 0.96, 0.97];
    for (let k = 0; k < 3; k++) {
      const a = legs[k];
      const b = legs[(k + 1) % 3];
      const p0 = [a[0] * s0, y0, a[1] * s0];
      const p12 = [a[0] * s1, y12, a[1] * s1];
      const q0 = [b[0] * s0, y0, b[1] * s0];
      const q1 = [b[0] * s1, y12, b[1] * s1];
      builder.add(bandMat, Ke(p0, p12, 0.065, 6), bandTint);
      builder.add(matGalv, Ke(p12, q1, 0.036, 5));
      builder.add(bandMat, Ke(p0, q1, 0.032, 4), bandTint);
      builder.add(bandMat, Ke(q0, p12, 0.032, 4), bandTint);
    }
  }
  builder.add(matGalv, xt(0.95, 0.95, 0.08, "y", 0, H, 0, 12));
  ns(builder, matGalv, [[-0.75, H + 0.04, -0.75], [0.75, H + 0.04, -0.75], [0.75, H + 0.04, 0.75], [-0.75, H + 0.04, 0.75], [-0.75, H + 0.04, -0.75]], { h: 0.95, post: 0.8, r: 0.02 });
  builder.add(matWhite, Ee(-0.7, H * 0.74, -0.35, 0.7, H * 0.74 + 1.5, 0.35, 0.03), [0.88, 0.9, 0.92]);
  builder.add(matDark, Ke([0.18, 0.4, 0.12], [0.12, H, 0.08], 0.035, 5));
  const dishAng = seed % 8 * (Math.PI / 4);
  const dishGeo = g1([[0, 0], [0.18, 0.02], [0.38, 0.09], [0.56, 0.2], [0.68, 0.3], [0.7, 0.3], [0.58, 0.18], [0.38, 0.07], [0.18, 0], [0, -0.02]], 18);
  dishGeo.computeVertexNormals();
  dishGeo.rotateX(Math.PI / 2);
  dishGeo.rotateY(dishAng);
  dishGeo.translate(Math.sin(dishAng) * 0.65, H * 0.84, Math.cos(dishAng) * 0.65);
  builder.add(matAlum, dishGeo);
  builder.add(matDark, xt(0.28, 0.28, 0.85, "y", -0.35, H + 0.5, 0, 10));
  builder.add(matGalv, Ke([0, H, 0], [0, H + 4.6, 0], 0.032, 6));
  beacons.add(Bn(0, H + 4.78, 0, 0.18), [9, 0.45, 0.22]);
  beacons.add(Bn(0, H * 0.55, 0, 0.15), [8, 0.4, 0.2]);
  const root = builder.build({ cast: true, recv: true });
  root.name = "comms_tower";
  const lampGrp = beacons.build();
  if (lampGrp) root.add(lampGrp);
  return qi(root, "comms_tower", Gi.comms_tower.slice(0, 3), [
    { min: [-1.8, 0, -1.25], max: [1.8, 1.2, 2.05], surface: "concrete" },
    { min: [-1.2, 1.2, -1], max: [1.2, H + 4.9, 1.4], surface: "metal" }
  ]);
}
Object.assign(Gi, {
  port_crane: [51, 33.6, 15.6, "paint_grey", "metal"],
  rtg_crane: [18.6, 25.2, 30.2, "paint_grey", "metal"],
  cargo_ship: [16.6, 39.7, 63.5, "hull_paint", "metal"],
  rigid_boat: [7.6, 4.22, 2.8, "plastic_grey", "rubber"],
  comms_tower: [4.2, 36.4, 4.2, "paint_white", "metal"]
});
for (const cName of ["container20", "container40", "container40hc"]) {
  _i(cName, (ctx, opts) => M3(ctx, cName, opts));
}
_i("jersey_barrier", S3);
_i("light_mast", T3);
_i("fence_panel", A3);
_i("guard_booth", R3);
_i("gate_arm", C3);
_i("bollard_mooring", P3);
_i("bollard_post", I3);
_i("sign_post", z3);
_i("floodlight_stand", D3);
_i("stairs_metal", k3);
_i("catwalk", F3);
_i("shelf_rack", U3);
_i("reefer_unit", N3);
_i("relay_node", B3);
J3(_i);
eb(_i);
sb(_i);
_i("port_crane", (ctx) => buildPortCraneProp(ctx));
_i("rtg_crane", (ctx, opts) => buildRtgCraneProp(ctx, opts));
_i("cargo_ship", (ctx) => buildCargoShipProp(ctx));
_i("rigid_boat", (ctx) => buildRigidBoatProp(ctx));
_i("comms_tower", (ctx, opts) => buildCommsTowerProp(ctx, opts));
function disposePropEngineCaches(mats) {
  if (!mats) return;
  const contMap = x3.get(mats);
  if (contMap) {
    for (const entry of contMap.values()) {
      for (const part of entry.parts) {
        if (part.geo) part.geo.dispose();
      }
    }
    contMap.clear();
    x3.delete(mats);
  }
  const protoMap = X3.get(mats);
  if (protoMap) {
    for (const grp of protoMap.values()) {
      grp.traverse((obj) => {
        if (obj.isMesh && obj.geometry) obj.geometry.dispose();
      });
    }
    protoMap.clear();
    X3.delete(mats);
  }
  m1.delete(mats);
}
export {
  Gi as ENGINE_PROP_SIZES,
  Yg as createPropEngine,
  disposePropEngineCaches
};
