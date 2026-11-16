// Saltline's robots: the "hound" quadruped and the "gull" ducted-fan drone —
// rigid-skinned procedural meshes, procedural gait / hover / gimbal animation,
// rotor and servo audio loops, and the enemy AI they carry (sight cone,
// hearing, attack tokens). In 深空 they run in passive mode (patrol only) as
// the HALCYON's survey units; see src/saltline/robots.js for the adapter that
// supplies the flat local "physics", player and fx this code expects.
//
// Produced by
//   node tools/saltline/extract.mjs Em --stop sa --rename tools/saltline/maps/robots.json
// (`async` dropped from the factory: it never awaited). Kept as generated.
// See docs/saltline-reuse.md.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const sa = mergeGeometries;
function seededRng(i = 1337) {
  let e = i >>> 0, t = () => {
    e |= 0, e = e + 1831565813 | 0;
    let n = Math.imul(e ^ e >>> 15, 1 | e);
    return n = n + Math.imul(n ^ n >>> 7, 61 | n) ^ n, ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
  return t.range = (n, s) => n + (s - n) * t(), t.int = (n, s) => Math.floor(n + (s - n + 1) * t()), t.pick = (n) => n[Math.floor(t() * n.length)], t.sign = () => t() < 0.5 ? -1 : 1, t.fork = () => seededRng(Math.floor(t() * 4294967296)), t;
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
var RigBuilder = class {
  constructor() {
    this.bones = [], this.index = {}, this.slots = {}, this.order = [];
  }
  bone(e, t, n = 0, s = 0, o = 0) {
    let r = t ? this.bones[this.index[t]] : null;
    if (t && !r) throw new Error("rig: unknown parent bone " + t);
    let a = { name: e, parent: r ? r.i : -1, local: [n, s, o], world: [n + (r ? r.world[0] : 0), s + (r ? r.world[1] : 0), o + (r ? r.world[2] : 0)], i: this.bones.length };
    return this.index[e] = a.i, this.bones.push(a), a;
  }
  add(e, t, n, s = [1, 1, 1], o = true) {
    let r = this.bones[this.index[t]];
    if (!r) throw new Error("rig: unknown bone " + t);
    let a = n;
    a.attributes.normal || a.computeVertexNormals();
    for (let p of Object.keys(a.attributes)) p !== "position" && p !== "normal" && p !== "uv" && a.deleteAttribute(p);
    let l = a.attributes.position.count;
    a.attributes.uv || a.setAttribute("uv", new THREE.BufferAttribute(new Float32Array(l * 2), 2)), a.translate(r.world[0], r.world[1], r.world[2]);
    let c = new Float32Array(l * 3), u = new Uint16Array(l * 4), h = new Float32Array(l * 4), f = a.attributes.normal;
    for (let p = 0; p < l; p++) {
      let d = o ? 0.74 + 0.26 * (f.getY(p) * 0.5 + 0.5) : 1;
      c[p * 3] = s[0] * d, c[p * 3 + 1] = s[1] * d, c[p * 3 + 2] = s[2] * d, u[p * 4] = r.i, h[p * 4] = 1;
    }
    return a.setAttribute("color", new THREE.BufferAttribute(c, 3)), a.setAttribute("skinIndex", new THREE.BufferAttribute(u, 4)), a.setAttribute("skinWeight", new THREE.BufferAttribute(h, 4)), this.slots[e] || (this.slots[e] = [], this.order.push(e)), this.slots[e].push(a), this;
  }
  build(e) {
    let t = (e || this.order).filter((o) => this.slots[o] && this.slots[o].length), n = t.map((o) => {
      let r = this.slots[o], l = r.some((u) => !u.index) ? r.map((u) => u.index ? u.toNonIndexed() : u) : r, c = sa(l, false);
      return c.index ? c.toNonIndexed() : c;
    }), s = sa(n, true);
    return s.computeBoundingSphere(), s.computeBoundingBox(), { geometry: s, slots: t, bones: this.bones, tris: s.attributes.position.count / 3 };
  }
};
function instantiateRig(i, e, { castShadow: t = true, receiveShadow: n = true, radius: s = 1.5, center: o = [0, 0.5, 0], extra: r = null } = {}) {
  let a = i.bones.map((p) => {
    let d = new THREE.Bone();
    return d.name = p.name, d.position.set(p.local[0], p.local[1], p.local[2]), d;
  });
  i.bones.forEach((p, d) => {
    p.parent >= 0 && a[p.parent].add(a[d]);
  });
  let l = new THREE.Group(), c = new THREE.SkinnedMesh(i.geometry, i.slots.map((p) => e[p]));
  c.castShadow = t, c.receiveShadow = n, l.add(c), i.bones.forEach((p, d) => {
    p.parent < 0 && c.add(a[d]);
  }), l.updateMatrixWorld(true);
  let u = new THREE.Skeleton(a);
  c.bind(u), c.boundingSphere = new THREE.Sphere(new THREE.Vector3(o[0], o[1], o[2]), s), c.boundingBox = new THREE.Box3(new THREE.Vector3(o[0] - s, o[1] - s, o[2] - s), new THREE.Vector3(o[0] + s, o[1] + s, o[2] + s));
  let h = {};
  a.forEach((p) => {
    h[p.name] = p;
  });
  let f = { group: l, mesh: c, bones: h, skeleton: u, extraMesh: null };
  if (r) {
    let p = new THREE.SkinnedMesh(r.def.geometry, r.def.slots.map((d) => e[d]));
    p.castShadow = false, p.receiveShadow = false, p.renderOrder = 5, l.add(p), p.updateMatrixWorld(true), p.bind(u, c.bindMatrix), p.boundingSphere = new THREE.Sphere(new THREE.Vector3(o[0], o[1], o[2]), r.radius || s), p.boundingBox = new THREE.Box3().setFromCenterAndSize(p.boundingSphere.center, new THREE.Vector3(1, 1, 1).multiplyScalar(2 * (r.radius || s))), f.extraMesh = p;
  }
  return f;
}
function q_(i, e, t, n, s, o, r, a) {
  let l = e * e + t * t, c = Math.sqrt(Math.max(l - o * o, 1e-6));
  i.abd = Math.atan2(t, e) - Math.atan2(-c, s * o), i.abd > Math.PI ? i.abd -= 2 * Math.PI : i.abd < -Math.PI && (i.abd += 2 * Math.PI);
  let u = Math.hypot(c, n), h = (r + a) * 0.995, f = Math.abs(r - a) + 0.03;
  i.reach = u / (r + a), u > h ? u = h : u < f && (u = f);
  let p = Math.atan2(n, c), d = (r * r + u * u - a * a) / (2 * r * u), v = (r * r + a * a - u * u) / (2 * r * a), g = Math.acos(d < -1 ? -1 : d > 1 ? 1 : d), x = Math.acos(v < -1 ? -1 : v > 1 ? 1 : v);
  return i.hip = g - p, i.knee = -(Math.PI - x), i;
}
var Ss = [1.15, 1.15, 1.15], vm = [0.95, 0.96, 0.97], Ts = [1, 0.34, 0.08], s0 = [0.1, 0.11, 0.12], ga = [0.035, 0.035, 0.038], Of = [1, 0.7, 0.07], As = [1, 1, 1], Yn = [2.4, 2.5, 2.6], an = [0.45, 0.46, 0.48], IC = [9, 9, 9.6], zC = [5.5, 4, 1.6], va = Math.PI / 2, ft = (i, e, t, n = 8e-3) => Wi(i, e, t, n), Ce = (i, e, t, n, s = 0, o = 0, r = 0, a = 1) => Dc(i, { p: [e, t, n], r: [s, o, r], s: a }), ds = (i, e, t, n = 12) => ot(i, e, t, n), Ro = (i, e, t, n = 12) => Dc(ot(i, e, t, n), { r: [0, 0, -va] }), Si = (i, e, t, n = 12) => Dc(ot(i, e, t, n), { r: [va, 0, 0] }), mm = new THREE.Vector3(), gm = new THREE.Vector3(), X_ = new THREE.Quaternion(), DC = new THREE.Vector3(0, 1, 0), Y_ = new THREE.Matrix4(), LC = new THREE.Vector3(1, 1, 1);
function su(i, e, t, n = t, s = 8) {
  mm.set(i[0], i[1], i[2]), gm.set(e[0], e[1], e[2]);
  let o = mm.distanceTo(gm), r = ot(n, t, o, s);
  return X_.setFromUnitVectors(DC, gm.clone().sub(mm).normalize()), Y_.compose(mm.clone().add(gm).multiplyScalar(0.5), X_, LC), r.applyMatrix4(Y_), r;
}
var Ur = (i, e = 14, t = 10, n = 1, s = 1, o = 1) => {
  let r = new THREE.SphereGeometry(i, e, t);
  return r.scale(n, s, o), r;
}, $_ = (i, e, t) => Ce(Ro(75e-4, 75e-4, 6e-3, 6), i, e, t), Yv = (i, e, t) => Ce(ds(75e-4, 75e-4, 6e-3, 6), i, e, t), kC = (i, e, t) => Ce(Si(75e-4, 75e-4, 6e-3, 6), i, e, t), $v = { stand: 0.72, L1: 0.4, L2: 0.42, l0: 0.075, hipX: 0.165, hipY: -0.01, hipZ: 0.4, footX: 0.275, footZ: [0.37, 0.37, -0.42, -0.42], legs: ["FL", "FR", "RL", "RR"], side: [1, -1, 1, -1], fore: [1, 1, -1, -1], muzzle: [0, 0, 0.43], eye: [0, 0, 0.14], footR: 0.046 };
function buildHoundRig() {
  let i = $v, e = new RigBuilder();
  e.bone("root", null, 0, 0, 0), e.bone("body", "root", 0, i.stand, 0), e.bone("neck", "body", 0, 0.06, 0.49), e.bone("head", "neck", 0, 0.13, 0.12), e.bone("turret", "body", 0, 0.152, -0.03), e.bone("gun", "turret", 0, 0.095, 0.02), e.bone("antenna", "body", -0.105, 0.15, -0.46), e.bone("beacon", "body", 0.105, 0.2, -0.455);
  for (let n = 0; n < 4; n++) {
    let s = i.legs[n], o = i.side[n];
    e.bone("abd" + s, "body", o * i.hipX, i.hipY, i.fore[n] * i.hipZ), e.bone("thigh" + s, "abd" + s, o * i.l0, 0, 0), e.bone("shin" + s, "thigh" + s, 0, -i.L1, 0);
  }
  let t = (n, s, o, r, a) => e.add(n, s, o, r, a);
  t("metal", "body", Ce(ft(0.27, 0.2, 0.98, 0.02), 0, -0.01, 0), an), t("shell", "body", Ce(ft(0.35, 0.05, 0.3, 0.014), 0, 0.125, 0.33), Ss), t("shell", "body", Ce(ft(0.35, 0.05, 0.36, 0.014), 0, 0.125, -0.012), Ss), t("shell", "body", Ce(ft(0.1, 0.052, 0.36, 0.01), 0, 0.126, -0.012 + 0), vm);
  for (let n of [-0.15, 0.15]) for (let s of [0.21, 0.45, -0.17, 0.145]) t("metal", "body", Yv(n, 0.152, s), Yn);
  t("metal", "body", Ce(ft(0.31, 0.03, 0.25, 6e-3), 0, 0.112, -0.335), As);
  for (let n = 0; n < 10; n++) t("metal", "body", Ce(ft(7e-3, 0.062, 0.225, 2e-3), -0.126 + n * 0.028, 0.155, -0.335), Yn);
  t("metal", "body", Ce(ft(0.3, 0.012, 0.02, 3e-3), 0, 0.186, -0.24), an), t("metal", "body", Ce(ft(0.3, 0.012, 0.02, 3e-3), 0, 0.186, -0.43), an);
  for (let n of [1, -1]) {
    t("shell", "body", Ce(ft(0.032, 0.15, 0.31, 0.012), n * 0.15, 0.022, -0.075), Ss), t("shell", "body", Ce(ft(0.032, 0.15, 0.135, 0.012), n * 0.15, 0.022, 0.1625), vm), t("metal", "body", Fn([[n * 0.168, 0.06, 0.125], [n * 0.182, 0.06, 0.135], [n * 0.182, 0.06, 0.19], [n * 0.168, 0.06, 0.2]], 5e-3, 5), Yn), t("shell", "body", Ce(ft(0.034, 0.016, 0.135, 4e-3), n * 0.151, -0.035, 0.1625), Of), t("shell", "body", Ce(ft(0.034, 0.042, 0.46, 8e-3), n * 0.151, -0.078, 0), Ts), t("shell", "body", Ce(ft(0.028, 0.1, 0.11, 8e-3), n * 0.146, 0.01, 0.305), s0);
    for (let s = 0; s < 4; s++) t("metal", "body", Ce(ft(4e-3, 0.012, 0.085, 1e-3), n * 0.161, -0.02 + s * 0.022, 0.305), an);
    for (let s of [-0.035, 0.08]) for (let o of [-0.21, 0.06, 0.115, 0.21]) t("metal", "body", $_(n * 0.167, s, o), Yn);
    t("metal", "body", Fn([[n * 0.135, 0.148, -0.19], [n * 0.135, 0.205, -0.16], [n * 0.135, 0.212, 0], [n * 0.135, 0.205, 0.43], [n * 0.135, 0.148, 0.465]], 0.0105, 6), Yn);
    for (let s of [0, 0.26]) t("metal", "body", Ce(ds(8e-3, 8e-3, 0.06, 6), n * 0.135, 0.178, s), Yn);
    t("shell", "body", Fn([[n * 0.118, -0.105, -0.36], [n * 0.132, -0.118, -0.2], [n * 0.13, -0.112, 0.1], [n * 0.118, -0.1, 0.36]], 9e-3, 5), ga), t("metal", "body", Ce(new THREE.TorusGeometry(0.02, 5e-3, 5, 10), n * 0.17, 0.085, -0.335, 0, va, 0), Yn);
  }
  t("shell", "body", Ce(ft(0.3, 0.15, 0.075, 0.018), 0, -5e-3, 0.505), Ts), t("shell", "body", Ce(ft(0.2, 0.07, 0.02, 6e-3), 0, 0.012, 0.545), s0);
  for (let n = 0; n < 6; n++) t("shell", "body", Ce(ft(0.05, 0.034, 0.014, 3e-3), -0.125 + n * 0.05, -0.098, 0.538, 0, 0, 0), n % 2 ? s0 : Of);
  for (let n of [-0.115, 0.115]) t("metal", "body", Ce(Si(0.021, 0.021, 0.014, 10), n, 0.012, 0.547), an), t("glow", "body", Ce(Si(0.015, 0.015, 4e-3, 10), n, 0.012, 0.556), [6.5, 4.6, 2.2], false);
  t("metal", "body", Ce(ft(0.24, 0.095, 0.56, 0.02), 0, -0.145, 0), As), t("shell", "body", Ce(ft(0.246, 0.03, 0.09, 6e-3), 0, -0.14, 0.12), Ts), t("shell", "body", Ce(ft(0.246, 0.03, 0.09, 6e-3), 0, -0.14, -0.12), Ts), t("shell", "body", Ce(ft(0.29, 0.15, 0.05, 0.014), 0, 0, -0.495), Ss), t("shell", "body", Ce(ft(0.17, 0.05, 0.012, 4e-3), 0, 0.03, -0.523), s0), t("glow", "body", Ce(ft(0.13, 0.012, 4e-3, 1e-3), 0, 0.03, -0.531), [5, 0.3, 0.1], false), t("metal", "body", Ce(Si(0.022, 0.022, 0.02, 10), 0.085, -0.035, -0.525), Yn), t("metal", "body", Ce(new THREE.TorusGeometry(0.024, 6e-3, 5, 10), -0.07, -0.05, -0.528, va, 0, 0), Yn);
  for (let n of [-0.125, 0.125]) for (let s of [-0.055, 0.055]) t("metal", "body", kC(n, s, -0.523), Yn);
  t("shell", "body", Fn([[0.09, 0.15, -0.2], [0.13, 0.2, -0.16], [0.12, 0.2, -0.08], [0.09, 0.165, -0.05]], 9e-3, 5), ga), t("metal", "neck", su([0, -0.02, -0.02], [0, 0.11, 0.1], 0.045, 0.036, 10), an);
  for (let n = 0; n < 3; n++) {
    let s = 0.2 + n * 0.28;
    t("shell", "neck", su([0, -0.02 + 0.13 * s - 8e-3, -0.02 + 0.12 * s - 75e-4], [0, -0.02 + 0.13 * s + 8e-3, -0.02 + 0.12 * s + 75e-4], 0.052, 0.052, 10), ga);
  }
  t("shell", "neck", Ce(ft(0.13, 0.05, 0.1, 0.012), 0, -0.01, -0.03), Ss), t("shell", "neck", Fn([[0.05, -0.02, -0.04], [0.07, 0.05, 0.02], [0.06, 0.11, 0.07], [0.045, 0.12, 0.1]], 7e-3, 5), ga), t("shell", "head", Ce(ft(0.19, 0.118, 0.25, 0.03), 0, 0, 0), Ss), t("shell", "head", Ce(ft(0.168, 0.074, 0.03, 0.012), 0, -4e-3, 0.118), s0), t("lens", "head", Ce(ft(0.128, 0.024, 6e-3, 2e-3), 0, 6e-3, 0.1345), [1, 1, 1], false);
  for (let n of [-0.056, 0.056]) t("metal", "head", Ce(Si(0.015, 0.015, 0.012, 10), n, -0.022, 0.132), an), t("metal", "head", Ce(Si(9e-3, 9e-3, 4e-3, 8), n, -0.022, 0.139), [0.1, 0.12, 0.2]);
  t("shell", "head", Ce(ft(0.062, 8e-3, 0.2, 3e-3), 0, 0.06, -5e-3), Ts), t("metal", "head", Ce(Ro(0.032, 0.032, 0.214, 12), 0, 0, -0.055), an);
  for (let n of [1, -1]) t("shell", "head", Ce(Ro(0.022, 0.022, 6e-3, 10), n * 0.108, 0, -0.055), Ts);
  t("metal", "head", Ce(ds(0.036, 0.036, 0.026, 14), 0, 0.072, -0.05), an), t("metal", "head", Ce(ds(0.037, 0.037, 6e-3, 14), 0, 0.074, -0.05), [0.2, 0.3, 0.5]), t("metal", "head", Ce(ft(0.12, 0.03, 0.13, 8e-3), 0, -0.068, 0.02), As);
  for (let n of [-0.08, 0.08]) for (let s of [-0.09, 0.07]) t("metal", "head", Yv(n, 0.061, s), Yn);
  t("metal", "turret", Ce(ds(0.105, 0.118, 0.034, 18), 0, 0, 0), an), t("metal", "turret", Ce(ft(0.18, 0.02, 0.16, 5e-3), 0, 0.026, 0), As);
  for (let n of [1, -1]) t("shell", "turret", Ce(ft(0.028, 0.115, 0.15, 0.012), n * 0.078, 0.085, 5e-3), Ss), t("metal", "turret", Ce(Ro(0.022, 0.022, 8e-3, 10), n * 0.094, 0.095, 0.02), Yn);
  t("shell", "gun", Ce(ft(0.108, 0.086, 0.21, 0.016), 0, 0, -0.012), Ss), t("shell", "gun", Ce(ft(0.11, 0.02, 0.212, 6e-3), 0, -0.022, -0.012), Ts), t("metal", "gun", Ce(Si(0.035, 0.035, 0.11, 12), 0, 0, 0.145), an);
  for (let n = 0; n < 4; n++) t("metal", "gun", Ce(Si(0.039, 0.039, 8e-3, 12), 0, 0, 0.105 + n * 0.026), As);
  t("metal", "gun", Ce(Si(0.022, 0.024, 0.3, 12), 0, 0, 0.25), As), t("metal", "gun", Ce(Si(0.036, 0.036, 0.06, 10), 0, 0, 0.395), an), t("metal", "gun", Ce(ft(0.08, 0.012, 0.025, 3e-3), 0, 0, 0.395), [0.15, 0.15, 0.15]), t("metal", "gun", Ce(Ro(0.056, 0.056, 0.06, 14), 0.084, -4e-3, -0.045), an), t("metal", "gun", Ce(Ro(0.02, 0.02, 0.066, 8), 0.084, -4e-3, -0.045), zC), t("metal", "gun", Ce(ft(0.036, 0.036, 0.095, 8e-3), -0.03, 0.06, 0), an), t("glow", "gun", Ce(Si(0.011, 0.011, 3e-3, 8), -0.03, 0.06, 0.049), [1.6, 0.12, 0.05], false), t("shell", "gun", Fn([[0.05, -0.03, -0.11], [0.06, -0.07, -0.13], [0.04, -0.09, -0.1]], 8e-3, 5), ga), t("metal", "body", Ce(ds(0.022, 0.026, 0.05, 10), 0.105, 0.175, -0.455), an), t("glow", "beacon", Ce(Ur(0.02, 10, 6, 1, 1.25, 1), 0, 0.012, 0), [14, 5.5, 0.5], false), t("metal", "antenna", Ce(ds(0.011, 0.014, 0.05, 8), 0, 0.025, 0), an), t("metal", "antenna", Ce(ds(28e-4, 5e-3, 0.62, 5), 0, 0.36, 0), an), t("shell", "antenna", Ce(Ur(9e-3, 6, 4), 0, 0.67, 0), Ts);
  for (let n = 0; n < 4; n++) {
    let s = i.legs[n], o = i.side[n], r = "abd" + s, a = "thigh" + s, l = "shin" + s;
    t("metal", r, Ce(Si(0.06, 0.06, 0.17, 14), -o * 0.02, 0, 0), an), t("shell", r, Ce(ft(0.11, 0.05, 0.155, 0.014), o * 0, 0.058, 0), Ss), t("metal", r, Ce(Si(0.03, 0.03, 0.18, 8), -o * 0.02, 0, 0), Yn), t("shell", a, Ce(Ro(0.078, 0.078, 0.07, 18), 0, 0, 0), Ss), t("shell", a, Ce(Ro(0.081, 0.081, 0.016, 18), o * 0.012, 0, 0), Ts), t("metal", a, Ce(Ro(0.048, 0.048, 0.082, 12), 0, 0, 0), an);
    for (let c = 0; c < 5; c++) {
      let u = c * 1.2566;
      t("metal", a, $_(o * 0.039, Math.cos(u) * 0.062, Math.sin(u) * 0.062), Yn);
    }
    t("shell", a, Ce(ft(0.062, i.L1 - 0.07, 0.1, 0.022), 0, -i.L1 * 0.5 - 5e-3, 4e-3), Ss), t("metal", a, Ce(ft(0.044, i.L1 - 0.04, 0.06, 0.012), 0, -i.L1 * 0.5, -0.035), an), t("shell", a, Ce(ft(0.065, 0.045, 0.103, 0.01), 0, -0.145, 4e-3), Ts), t("shell", a, Ce(ft(0.064, 0.012, 0.102, 4e-3), 0, -0.26, 4e-3), s0), t("metal", a, su([0, -0.06, -0.082], [0, -i.L1 * 0.62, -0.078], 0.021, 0.021, 10), Yn), t("metal", a, su([0, -i.L1 * 0.62, -0.078], [0, -i.L1 + 0.025, -0.058], 9e-3, 9e-3, 6), IC), t("metal", a, Ce(ft(0.05, 0.03, 0.035, 6e-3), 0, -0.055, -0.07), As), t("shell", a, Fn([[o * 0.036, -0.02, 0.05], [o * 0.044, -0.13, 0.062], [o * 0.042, -0.28, 0.058], [o * 0.034, -i.L1 + 0.03, 0.035]], 65e-4, 5), ga), t("metal", a, Ce(Ro(0.05, 0.05, 0.086, 14), 0, -i.L1, 0), an), t("shell", a, Ce(Ro(0.036, 0.036, 0.092, 12), 0, -i.L1, 0), vm), t("metal", l, Ce(ds(0.03, 0.021, i.L2 - 0.08, 10), 0, -(i.L2 - 0.08) / 2 - 0.01, 0), an), t("shell", l, Ce(ft(0.052, 0.21, 0.04, 0.014), 0, -0.14, 0.02), Ss), t("shell", l, Ce(ft(0.054, 0.02, 0.042, 6e-3), 0, -0.215, 0.02), Ts), t("metal", l, Ce(ft(0.03, 0.06, 0.05, 8e-3), 0, -0.02, -0.03), As), t("metal", l, Ce(ds(0.024, 0.03, 0.03, 10), 0, -i.L2 + 0.085, 0), Yn), t("shell", l, Ce(Ur(i.footR + 2e-3, 12, 8, 1, 0.86, 1.08), 0, -i.L2 + i.footR * 0.86, 4e-3), ga);
  }
  return e.build(["shell", "metal", "glow", "lens"]);
}
var xm = { rotors: [[0.33, 0.035, 0.3], [-0.33, 0.035, 0.3], [0.33, 0.035, -0.3], [-0.33, 0.035, -0.3]], gimbal: [0, -0.095, 0.275], ball: [0, -0.072, 0], gun: [0, -0.085, -0.1], muzzle: [0, -0.032, 0.27], lamp: [0, -0.066, 0.025] };
function FC() {
  let i = [[0.176, -0.036], [0.196, -0.032], [0.206, 0], [0.202, 0.03], [0.19, 0.04], [0.178, 0.032], [0.173, 0], [0.176, -0.036]].map((e) => new THREE.Vector2(e[0], e[1]));
  return new THREE.LatheGeometry(i, 28);
}
function buildGullRig() {
  let i = xm, e = new RigBuilder(), t = new RigBuilder(), n = (l, c, u, h, f) => {
    e.bone(l, c, u, h, f), t.bone(l, c, u, h, f);
  };
  n("root", null, 0, 0, 0), n("body", "root", 0, 0, 0);
  for (let l = 0; l < 4; l++) n("rotor" + l, "body", i.rotors[l][0], i.rotors[l][1], i.rotors[l][2]);
  n("gimbalYaw", "body", i.gimbal[0], i.gimbal[1], i.gimbal[2]), n("ball", "gimbalYaw", i.ball[0], i.ball[1], i.ball[2]), n("lamp", "ball", i.lamp[0], i.lamp[1], i.lamp[2]), n("gun", "body", i.gun[0], i.gun[1], i.gun[2]), n("strobeG", "body", 0, 0, 0), n("strobeR", "body", 0, 0, 0), n("strobeW", "body", 0, 0, 0);
  let s = (l, c, u, h, f) => e.add(l, c, u, h, f);
  s("shell", "body", Ce(Ur(1, 20, 12, 0.118, 0.074, 0.27), 0, 0.02, 0), Ss), s("shell", "body", Ce(ot(1, 0.9, 1, 20), 0, 0.02, 0.165, va, 0, 0, [0.094, 0.05, 0.06]), Ts), s("shell", "body", Ce(ot(1, 1, 1, 20), 0, 0.02, -0.02, va, 0, 0, [0.121, 0.012, 0.0765]), s0), s("shell", "body", Ce(ft(0.118, 0.014, 0.2, 5e-3), 0, 0.089, -0.03), vm), s("shell", "body", Ce(ft(0.03, 6e-3, 0.2, 2e-3), 0, 0.0975, -0.03), Ts);
  for (let l of [-0.05, 0.05]) for (let c of [-0.12, 0.06]) s("metal", "body", Yv(l, 0.097, c), Yn);
  s("metal", "body", Ce(ft(0.175, 0.06, 0.37, 0.016), 0, -0.035, -5e-3), an), s("metal", "body", Ce(ft(0.12, 0.075, 0.11, 0.014), 0, 5e-3, -0.265), As), s("shell", "body", Ce(ft(0.124, 0.02, 0.03, 5e-3), 0, 0.03, -0.3), Ts), s("glow", "body", Ce(ft(0.05, 6e-3, 3e-3, 1e-3), 0, 0, -0.321), [0.3, 1.6, 0.4], false);
  for (let l of [1, -1]) {
    for (let c = 0; c < 4; c++) s("metal", "body", Ce(ft(4e-3, 0.01, 0.06, 1e-3), l * 0.0885, -0.045 + c * 0.016, -0.06), [0.2, 0.2, 0.2]);
    s("metal", "body", Fn([[l * 0.075, -0.055, 0.13], [l * 0.135, -0.175, 0.16], [l * 0.135, -0.192, 0.11], [l * 0.135, -0.192, -0.14], [l * 0.135, -0.175, -0.19], [l * 0.075, -0.055, -0.15]], 85e-4, 6, false, 0.5), Yn);
    for (let c of [0.07, -0.1]) s("shell", "body", Ce(Si(0.0135, 0.0135, 0.07, 8), l * 0.135, -0.192, c), ga);
    s("metal", "body", su([l * 0.04, 0.07, -0.17], [l * 0.085, 0.37, -0.27], 4e-3, 2e-3, 5), an), s("metal", "body", Ce(ds(8e-3, 0.01, 0.025, 6), l * 0.04, 0.078, -0.17), Yn);
  }
  s("metal", "body", Ce(ds(7e-3, 7e-3, 0.04, 6), 0, 0.105, 0.1), Yn), s("shell", "body", Ce(ds(0.034, 0.036, 0.018, 14), 0, 0.132, 0.1), Ss), s("metal", "body", Ce(ft(0.07, 0.03, 0.09, 8e-3), 0, -0.075, 0.235), As);
  let o = FC();
  for (let l = 0; l < 4; l++) {
    let [c, u, h] = i.rotors[l], f = Math.sign(c), p = Math.sign(h);
    s("metal", "body", su([f * 0.07, 0, p * 0.09], [c, u - 0.05, h], 0.017, 0.015, 8), an), s("shell", "body", Ce(ft(0.07, 0.045, 0.07, 0.014), f * 0.085, 0, p * 0.1, 0, f * p * 0.74, 0), Ss), s("shell", "body", Fn([[f * 0.09, 0.02, p * 0.12], [f * 0.18, 0.012, p * 0.19], [c - f * 0.05, u - 0.03, h - p * 0.04]], 5e-3, 5), ga), s("metal", "body", Ce(ds(0.04, 0.03, 0.075, 12), c, u - 0.05, h), an), s("metal", "body", Ce(ds(0.042, 0.042, 0.012, 12), c, u - 0.02, h), Yn), s("shell", "body", Ce(o.clone(), c, u, h), Ss), s("shell", "body", Ce(new THREE.TorusGeometry(0.196, 85e-4, 6, 28), c, u + 0.036, h, va, 0, 0), Ts);
    for (let v = 0; v < 3; v++) {
      let g = v * 2.094 + 0.5 + l;
      s("metal", "body", Ce(ft(0.145, 7e-3, 0.016, 2e-3), c + Math.cos(g) * 0.105, u - 0.022, h - Math.sin(g) * 0.105, 0, g, 0), an);
    }
    for (let v = -1; v <= 1; v++) {
      let g = Math.atan2(p, f) + v * 0.2;
      s("shell", "body", Ce(ft(0.012, 0.05, 0.036, 3e-3), c + Math.cos(g) * 0.205, u, h + Math.sin(g) * 0.205, 0, -g, 0), v === 0 ? s0 : Of);
    }
    s("metal", "rotor" + l, Ce(ds(0.017, 0.02, 0.03, 8), 0, -2e-3, 0), Yn), s("metal", "rotor" + l, Ce(ft(0.158, 35e-4, 0.03, 1e-3), 0.088, 8e-3, 0, 0.22, 0, 0), an), s("metal", "rotor" + l, Ce(ft(0.158, 35e-4, 0.03, 1e-3), -0.088, 8e-3, 0, -0.22, 0, 0), an), s("shell", "rotor" + l, Ce(ft(0.02, 4e-3, 0.031, 1e-3), 0.158, 8e-3, 0, 0.22, 0, 0), Of), s("shell", "rotor" + l, Ce(ft(0.02, 4e-3, 0.031, 1e-3), -0.158, 8e-3, 0, -0.22, 0, 0), Of);
    let d = new THREE.RingGeometry(0.03, 0.168, 24, 1);
    d.rotateX(-va), t.add("disc", "body", Ce(d, c, u + 8e-3, h), [1, 1, 1], false);
  }
  s("glow", "strobeR", Ce(Ur(0.012, 8, 6), 0.33 + 0.215, 0.035, 0.3), [10, 0.4, 0.2], false), s("glow", "strobeR", Ce(Ur(0.012, 8, 6), 0.33 + 0.215, 0.035, -0.3), [10, 0.4, 0.2], false), s("glow", "strobeG", Ce(Ur(0.012, 8, 6), -0.33 - 0.215, 0.035, 0.3), [0.3, 9, 1], false), s("glow", "strobeG", Ce(Ur(0.012, 8, 6), -0.33 - 0.215, 0.035, -0.3), [0.3, 9, 1], false), s("glow", "strobeW", Ce(Ur(0.011, 8, 6), 0, 0.05, -0.325), [9, 9, 9], false), s("metal", "gimbalYaw", Ce(ds(0.036, 0.036, 0.014, 12), 0, -4e-3, 0), an), s("metal", "gimbalYaw", Ce(ft(0.156, 0.01, 0.03, 3e-3), 0, -0.014, 0), As);
  for (let l of [1, -1]) s("metal", "gimbalYaw", Ce(ft(9e-3, 0.075, 0.03, 3e-3), l * 0.0735, -0.05, 0), As);
  s("metal", "ball", Ce(Ur(0.06, 18, 12), 0, 0, 0), an), s("metal", "ball", Ce(Ro(0.013, 0.013, 0.142, 8), 0, 0, 0), Yn), s("metal", "ball", Ce(Si(0.031, 0.036, 0.03, 14), 0, 4e-3, 0.048), As), s("lens", "ball", Ce(Si(0.025, 0.025, 4e-3, 14), 0, 4e-3, 0.0645), [1, 1, 1], false), s("metal", "ball", Ce(Si(0.012, 0.012, 0.01, 8), 0.03, 0.036, 0.04), [0.1, 0.12, 0.2]), s("metal", "ball", Ce(Si(0.019, 0.023, 0.045, 10), i.lamp[0], i.lamp[1], i.lamp[2] - 0.022), an), s("glow", "lamp", Ce(Si(0.016, 0.016, 3e-3, 10), 0, 0, 1e-3), [11, 9.8, 7.6], false);
  {
    let u = new THREE.ConeGeometry(1.25, 9, 20, 6, true);
    u.translate(0, -9 / 2, 0), u.rotateX(-va), t.add("cone", "lamp", u, [1, 1, 1], false);
  }
  s("metal", "gun", Ce(ft(0.05, 0.03, 0.05, 6e-3), 0, 0.012, 0), As), s("metal", "gun", Ce(Ro(0.012, 0.012, 0.07, 8), 0, -5e-3, 0), Yn), s("metal", "gun", Ce(ft(0.052, 0.046, 0.13, 8e-3), 0, -0.032, 0), As), s("shell", "gun", Ce(ft(0.054, 0.012, 0.05, 3e-3), 0, -0.02, -0.03), Ts);
  for (let l of [-0.014, 0.014]) s("metal", "gun", Ce(Si(85e-4, 85e-4, 0.2, 8), l, -0.032, 0.16), an), s("metal", "gun", Ce(Si(0.012, 0.012, 0.03, 8), l, -0.032, 0.255), As);
  s("metal", "gun", Ce(ft(0.045, 0.012, 0.012, 2e-3), 0, -0.032, 0.2), Yn), s("metal", "gun", Ce(ft(0.03, 0.05, 0.05, 6e-3), 0.04, -0.035, -0.02), an);
  let r = e.build(["shell", "metal", "glow", "lens"]), a = t.build(["disc", "cone"]);
  return r.extra = a, r;
}
var GULL_TUNE = { hp: 45, boltDamage: 7, boltSpeed: 70, burst: 3, burstGap: 0.12, telegraph: 0.55, cooldown: [1.9, 3.3], rangeMin: 12, rangeMax: 25, altMin: 4, altMax: 8, maxSpeed: 8, patrolSpeed: 3, accel: 11, spreadFar: 0.065, spreadNear: 0.018, fireRange: 42, explodeRadius: 3, explodeDamage: 30 }, Pn = GULL_TUNE, $o = new THREE.Vector3(), iz = new THREE.Vector3(), Bs = new THREE.Vector3(), Co = new THREE.Vector3(), sz = new THREE.Vector3(), ou = new THREE.Vector3(), Hf = new THREE.Vector3(0, 1, 0), J_ = new THREE.Vector3(0, -1, 0), ym = [8, 4, 0.7], UC = [14, 1, 0.35], K_ = (i, e) => {
  let t = (i - e) % (Math.PI * 2);
  return t > Math.PI ? t -= Math.PI * 2 : t < -Math.PI && (t += Math.PI * 2), t;
}, bl = (i, e, t) => i < e ? e : i > t ? t : i;
function createGull(i, e, t, n) {
  let s = i.G, o = i.rng, r = t.lensBase.clone(), a = instantiateRig(e, { shell: t.shell, metal: t.metal, glow: t.glow, lens: r, disc: t.disc, cone: t.cone }, { radius: 0.9, center: [0, 0, 0], extra: { def: e.extra, radius: 10 } }), l = a.bones;
  a.group.rotation.order = "YXZ", a.group.visible = false;
  let c = s.mats.label("G-" + String(n + 11), { color: "black", font: "stencil", distress: 0.35 }), u = 0.105, h = Math.min(0.045, u / (c.aspect || 3)), f = new THREE.PlaneGeometry(u, h);
  f.rotateX(-Math.PI / 2), f.rotateY(Math.PI);
  let p = new THREE.Mesh(f, c.material);
  p.position.set(0, 0.0985, -0.085), p.castShadow = false, p.receiveShadow = true, l.body.add(p);
  let d = { id: 0, type: "gull", pos: a.group.position, alive: false, hp: Pn.hp, active: false, rig: a, lens: r, vel: new THREE.Vector3(), yaw: 0, pitch: 0, roll: 0, home: new THREE.Vector3(), lastKnown: new THREE.Vector3(), sensor: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), muzzle: new THREE.Vector3(), mode: "patrol", los: false, seeT: 0, noSeeT: 0, senseT: 0, exposure: 0, modeT: 0, passive: false, hasToken: false, orbitA: 0, orbitDir: 1, orbitR: 16, alt: 6, hoverY: 0, phase: 0, ceil: 1e9, ceilT: 0, flipT: 0, avoid: new THREE.Vector3(), atk: "idle", atkT: 0, cool: 1, shots: 0, smokeT: 0, feeler: 0, strobeT: 0, flare: 0, lensC: [ym[0], ym[1], ym[2]], dieT: 0, spin: 0, lostRotor: 0, gy: 0, gp: 0, loop: null, sweep: 0, thr: 1, damage(y, b, m, A) {
    return d.alive ? (d.hp -= y, s.events.emit("enemy:hit", { enemy: d, point: b, part: A || "body" }), m && (d.vel.addScaledVector(m, Math.min(3, y * 0.09)), d.roll += (o() - 0.5) * 0.5, d.pitch += (o() - 0.5) * 0.4), i.provoke(d), d.hp <= 0 ? (v(m), true) : false) : false;
  }, _activate(y, b = {}) {
    d.active = true, d.alive = true, d.hp = Pn.hp, d.passive = !!b.passive, d.pos.copy(y), d.home.copy(y), d.vel.set(0, 0, 0), d.yaw = b.yaw ?? o() * 6.283, d.pitch = d.roll = 0, d.mode = b.state === "alert" ? "investigate" : "patrol", d.modeT = 8, d.lastKnown.copy(b.target || (s.player ? s.player.pos : y)), d.los = false, d.seeT = d.noSeeT = 0, d.exposure = 0, d.senseT = o() * 0.2, d.hasToken = false, d.orbitDir = o() < 0.5 ? 1 : -1, d.orbitR = Pn.rangeMin + 2 + o() * (Pn.rangeMax - Pn.rangeMin - 5), d.alt = b.hover ?? Pn.altMin + 0.8 + o() * (Pn.altMax - Pn.altMin - 1.6), d.hoverFixed = b.hover != null, d.patrolR = b.patrolRadius ?? 4 + o() * 5, d.phase = o() * 6.283, d.orbitA = o() * 6.283, d.ceil = 1e9, d.flipT = 3 + o() * 4, d.atk = "idle", d.cool = 1 + o() * 1.5, d.dieT = 0, d.spin = 0, d.lostRotor = -1, d.flare = 0, d.thr = 1;
    for (let m = 0; m < 4; m++) l["rotor" + m].scale.setScalar(1);
    if (l.lamp.scale.setScalar(1), l.body.rotation.set(0, 0, 0), a.group.visible = true, a.group.rotation.set(0, d.yaw, 0), s.audio && s.audio.loop && !d.loop) try {
      d.loop = s.audio.loop("gull_rotor", { pos: d.pos, gain: 0.5 });
    } catch {
      d.loop = null;
    }
  }, _deactivate() {
    if (d.active = false, d.alive = false, a.group.visible = false, i.releaseToken(d), d.loop) {
      try {
        d.loop.stop();
      } catch {
      }
      d.loop = null;
    }
  }, _raycast(y, b, m, A) {
    let E = y.x - d.pos.x, w = (y.y - d.pos.y + 0.03) * 2.3, S = y.z - d.pos.z, z = b.x, H = b.y * 2.3, O = b.z, q = z * z + H * H + O * O, U = E * z + w * H + S * O, T = E * E + w * w + S * S - 0.5 * 0.5, D = U * U - q * T;
    if (D < 0) return false;
    let C = (-U - Math.sqrt(D)) / q;
    return C < 0 || C > m || C >= A.dist ? false : (A.dist = C, A.part = "body", A.enemy = d, A.point.copy(y).addScaledVector(b, C), A.normal.copy(A.point).sub(d.pos), A.normal.y *= 2.3, A.normal.normalize(), true);
  }, _update(y) {
    d.alive ? x(y) : g(y);
  } };
  function v(y) {
    d.alive = false, i.releaseToken(d), d.dieT = 0, d.lostRotor = Math.floor(o() * 4), l["rotor" + d.lostRotor].scale.setScalar(1e-4), $o.set(xm.rotors[d.lostRotor][0], 0.05, xm.rotors[d.lostRotor][2]).applyAxisAngle(Hf, d.yaw).add(d.pos), s.fx.sparks($o, Hf, 14), s.fx.debris($o, { count: 3 }), s.fx.smoke($o, { size: 0.5, life: 1 }), d.spin = (o() < 0.5 ? -1 : 1) * (5 + o() * 3), d.vel.y += 1.5, y && d.vel.addScaledVector(y, 2.5), l.lamp.scale.setScalar(1e-4), l.strobeG.scale.setScalar(1e-4), l.strobeR.scale.setScalar(1e-4), l.strobeW.scale.setScalar(1e-4), r.color.setRGB(0.3, 0.05, 0.02), s.events.emit("enemy:killed", { enemy: d, pos: d.pos, type: "gull" });
  }
  function g(y) {
    d.dieT += y, d.vel.y -= 9.5 * y, d.vel.x *= 1 - 0.4 * y, d.vel.z *= 1 - 0.4 * y, d.spin += Math.sign(d.spin) * 7 * y, d.yaw += d.spin * y, d.roll += d.spin * 0.35 * y, d.pitch += 0.9 * y;
    let b = d.vel.length(), m = b * y, A = d.dieT > 5 || d.pos.y < -3;
    if (!A && b > 0.01) {
      Bs.copy(d.vel).multiplyScalar(1 / b);
      let _ = s.physics.raycast(d.pos, Bs, m + 0.3);
      _ && (d.pos.copy(_.point).addScaledVector(_.normal, 0.2), A = true);
    }
    A || d.pos.addScaledVector(d.vel, y), a.group.rotation.set(d.pitch, d.yaw, d.roll);
    for (let _ = 0; _ < 4; _++) _ !== d.lostRotor && (l["rotor" + _].rotation.y += (_ % 3 === 0 ? 1 : -1) * 30 * Math.max(0.2, 1 - d.dieT * 0.5) * y);
    d.smokeT -= y, d.smokeT <= 0 && (d.smokeT = 0.045, s.fx.smoke(d.pos, { size: 0.45, life: 1.3, color: 1381914, rise: 0.6 }), o() < 0.5 && ($o.set(o() - 0.5, o(), o() - 0.5).normalize(), s.fx.sparks(d.pos, $o, 3))), d.loop && (d.loop.setPos(d.pos), d.loop.setPitch(Math.max(0.4, 1.25 - d.dieT * 0.4)), d.loop.setGain(0.5)), A && (s.fx.explosion(d.pos, 1.2), s.combat && s.combat.explode && s.combat.explode(d.pos, Pn.explodeRadius, Pn.explodeDamage, "enemy"), i.retire(d));
  }
  function x(y) {
    let b = s.player, m = i.t;
    d.fwd.set(Math.sin(d.yaw), 0, Math.cos(d.yaw)), d.sensor.set(0, -0.17, 0.27).applyAxisAngle(Hf, d.yaw).add(d.pos), i.think(d, y, 0.4);
    let A = d.mode === "engage", _ = d.hp < Pn.hp * 0.5, M = Pn.patrolSpeed, E, w, S;
    if (A && b) {
      M = Pn.maxSpeed;
      let P = d.atk !== "idle";
      d.flipT -= y, d.flipT <= 0 && (d.flipT = 3 + o() * 5, o() < 0.6 && (d.orbitDir = -d.orbitDir), d.orbitR = bl(d.orbitR + (o() - 0.5) * 6, Pn.rangeMin + 1, Pn.rangeMax - 2)), d.noSeeT > 1.5 ? (E = d.lastKnown.x, S = d.lastKnown.z, w = d.lastKnown.y + d.alt + 1, d.orbitA = Math.atan2(d.pos.z - d.lastKnown.z, d.pos.x - d.lastKnown.x)) : (d.orbitA += d.orbitDir * (P ? 0.9 : 3.6) / d.orbitR * y, E = b.pos.x + Math.cos(d.orbitA) * d.orbitR, S = b.pos.z + Math.sin(d.orbitA) * d.orbitR, w = b.pos.y + d.alt);
    } else d.mode === "investigate" || d.mode === "search" ? (M = 5.5, d.orbitA += 0.5 * y, E = d.lastKnown.x + Math.cos(d.orbitA) * 4.5, S = d.lastKnown.z + Math.sin(d.orbitA) * 4.5, w = d.lastKnown.y + Math.min(d.alt, 5.5)) : (d.orbitA += 0.28 * y * d.orbitDir, E = d.home.x + Math.cos(d.orbitA) * d.patrolR, S = d.home.z + Math.sin(d.orbitA) * d.patrolR, w = d.hoverFixed ? d.alt : d.home.y);
    w > d.ceil && (w = d.ceil), !d.hoverFixed && w < 2.2 && (w = 2.2), Co.set((E - d.pos.x) * 2.2 - d.vel.x * 2.4, (w - d.pos.y) * 5 - d.vel.y * 3.6, (S - d.pos.z) * 2.2 - d.vel.z * 2.4), d.feeler = (d.feeler + 1) % 3;
    let z = Math.hypot(d.vel.x, d.vel.z);
    if (d.feeler === 0 && z > 0.6) {
      Bs.set(d.vel.x / z, 0, d.vel.z / z);
      let P = 2.2 + z * 0.5, V = s.physics.raycast(d.pos, Bs, P);
      if (V) {
        let Y = 1 - V.dist / P;
        d.avoid.copy(V.normal).multiplyScalar(26 * Y), d.avoid.y += 9 * Y, Y > 0.5 && (d.orbitDir = -d.orbitDir, d.flipT = 2.5);
      }
    } else if (d.feeler === 1) {
      let P = s.physics.raycast(d.pos, J_, 2.4);
      P && !d.hoverFixed && (d.avoid.y += (2.4 - P.dist) * 10);
    } else if (d.feeler === 2 && (d.ceilT -= y * 3, d.ceilT <= 0)) {
      d.ceilT = 0.35;
      let P = s.physics.raycast(d.pos, Hf, 4);
      d.ceil = P ? d.pos.y + P.dist - 1.3 : 1e9;
    }
    Co.add(d.avoid), d.avoid.multiplyScalar(Math.exp(-6 * y)), _ && (Co.x += Math.sin(m * 7.3 + d.phase) * 5, Co.z += Math.cos(m * 6.1 + d.phase) * 5, Co.y += Math.sin(m * 9.7) * 3);
    let H = Co.length();
    H > Pn.accel && Co.multiplyScalar(Pn.accel / H), d.vel.addScaledVector(Co, y);
    let O = d.vel.length();
    O > M && (d.vel.multiplyScalar(M / O), O = M);
    for (let P = 0; P < 3; P++) {
      let V = P === 0 ? d.vel.x : P === 1 ? d.vel.y : d.vel.z;
      if (Math.abs(V) < 0.02) continue;
      let Y = V > 0 ? 1 : -1, L = P === 1 ? 0.35 : 0.62;
      Bs.set(P === 0 ? Y : 0, P === 1 ? Y : 0, P === 2 ? Y : 0);
      let Z = s.physics.raycast(d.pos, Bs, Math.abs(V) * y + L);
      Z && (d.vel.setComponent(P, -V * 0.25), d.avoid.setComponent(P, d.avoid.getComponent(P) - Y * 8), Z.dist < L && d.pos.setComponent(P, d.pos.getComponent(P) - Y * (L - Z.dist)));
    }
    if (d.pos.addScaledVector(d.vel, y), !d.hoverFixed) {
      let P = s.physics.groundHeight(d.pos.x, d.pos.z, d.pos.y + 0.5) + 1.1;
      d.pos.y < P && (d.pos.y = P, d.vel.y < 0 && (d.vel.y = 0));
    }
    let q = d.yaw;
    if ((A || d.mode === "search" || d.mode === "investigate") && b) {
      let P = A && d.noSeeT < 1.5 ? b.pos : d.lastKnown;
      q = Math.atan2(P.x - d.pos.x, P.z - d.pos.z);
    } else z > 0.4 && (q = Math.atan2(d.vel.x, d.vel.z));
    let U = K_(q, d.yaw);
    d.yaw += bl(U, -3.2 * y, 3.2 * y);
    let T = Math.cos(d.yaw), D = Math.sin(d.yaw), C = Co.x * D + Co.z * T, G = Co.x * T - Co.z * D, j = bl(C * 0.04, -0.42, 0.42), N = bl(-G * 0.04, -0.42, 0.42);
    _ && (j += Math.sin(m * 11 + d.phase) * 0.1, N += Math.cos(m * 8.7 + d.phase * 2) * 0.13);
    let Q = 1 - Math.exp(-7 * y);
    d.pitch += (j - d.pitch) * Q, d.roll += (N - d.roll) * Q, a.group.rotation.set(d.pitch, d.yaw, d.roll), l.body.position.y = Math.sin(m * 2.1 + d.phase) * 0.045 + Math.sin(m * 3.7 + d.phase * 1.7) * 0.018, d.thr += (1 + bl(Co.y * 0.03, -0.25, 0.4) + z * 0.02 - d.thr) * Q;
    let K = 41 * d.thr * y;
    l.rotor0.rotation.y += K, l.rotor1.rotation.y -= K * 1.03, l.rotor2.rotation.y -= K * 0.98, l.rotor3.rotation.y += K * 1.01;
    let ie = (m * 0.9 + d.phase * 0.1) % 1, F = ie < 0.05 || ie > 0.13 && ie < 0.18 ? 1 : 1e-4;
    if (l.strobeR.scale.setScalar(F), l.strobeG.scale.setScalar(F), l.strobeW.scale.setScalar(ie > 0.5 && ie < 0.56 ? 1 : 1e-4), A && b) ou.set(b.pos.x, b.pos.y + 1.1, b.pos.z);
    else if (d.mode !== "patrol") d.sweep += y, ou.set(d.lastKnown.x + Math.sin(d.sweep * 0.9) * 3, d.lastKnown.y, d.lastKnown.z + Math.cos(d.sweep * 0.7) * 3);
    else {
      d.sweep += y;
      let P = d.yaw + Math.sin(d.sweep * 0.5 + d.phase) * 0.9;
      ou.set(d.pos.x + Math.sin(P) * 5, d.pos.y - (d.hoverFixed ? 1.6 : 5), d.pos.z + Math.cos(P) * 5);
    }
    $o.copy(ou).sub(d.sensor);
    let X = $o.x * T - $o.z * D, ne = $o.x * D + $o.z * T, re = $o.y, $ = Math.atan2(X, ne), ue = bl(Math.atan2(-re, Math.hypot(X, ne)), -0.5, 1.5), me = 1 - Math.exp(-9 * y);
    d.gy += K_($, d.gy) * me, d.gp += (ue - d.gp) * me, l.gimbalYaw.rotation.y = d.gy, l.ball.rotation.x = d.gp - d.pitch, l.gun.rotation.x = bl(d.gp, -0.2, 1.3) - d.pitch;
    let ee = A ? UC : ym, B = 1 + d.flare * 3.2 + (A ? 0 : Math.sin(m * 3 + d.phase) * 0.15);
    for (let P = 0; P < 3; P++) d.lensC[P] += (ee[P] - d.lensC[P]) * (1 - Math.exp(-8 * y));
    if (r.color.setRGB(d.lensC[0] * B, d.lensC[1] * B, d.lensC[2] * B), d.flare = Math.max(0, d.flare - y * 1.5), d.muzzle.set(0, -0.12, 0.17).applyAxisAngle(Hf, d.yaw).add(d.pos), d.cool -= y, d.atk === "idle") A && d.los && d.cool <= 0 && b && b.alive && Math.abs(U) < 0.35 && d.pos.distanceTo(b.pos) < Pn.fireRange && i.requestToken(d) && (d.atk = "tele", d.atkT = Pn.telegraph, s.events.emit("enemy:telegraph", { enemy: d, type: "gull", time: Pn.telegraph, pos: d.pos }));
    else if (d.atk === "tele") d.atkT -= y, d.flare = Math.min(1, d.flare + y * 4.5), A ? d.atkT <= 0 && (d.atk = "burst", d.shots = Pn.burst, d.atkT = 0, d.lead = 0.2 + o() * 0.65) : (d.atk = "idle", i.releaseToken(d));
    else if (d.atk === "burst" && (d.atkT -= y, d.flare = 1, d.atkT <= 0)) {
      if (d.atkT = Pn.burstGap, d.shots--, b) {
        let P = d.muzzle.distanceTo(b.pos), V = P / Pn.boltSpeed;
        ou.set(b.pos.x + b.vel.x * V * d.lead, b.pos.y + 1.05, b.pos.z + b.vel.z * V * d.lead), Bs.copy(ou).sub(d.muzzle).normalize();
        let Y = (Pn.spreadFar + (Pn.spreadNear - Pn.spreadFar) * d.exposure) * (1 + i.playerSpeed * 0.45) * (_ ? 1.5 : 1);
        Bs.x += (o() - 0.5) * 2 * Y, Bs.y += (o() - 0.5) * 2 * Y, Bs.z += (o() - 0.5) * 2 * Y, Bs.normalize(), i.fireBolt(d.muzzle, Bs, d), s.fx.muzzleFlash(d.muzzle, Bs, { scale: 0.55 }), s.events.emit("enemy:fire", { enemy: d, pos: d.muzzle, dir: Bs, type: "gull" }), d.vel.addScaledVector(Bs, -0.35);
      }
      d.shots <= 0 && (d.atk = "idle", d.cool = Pn.cooldown[0] + o() * (Pn.cooldown[1] - Pn.cooldown[0]), i.releaseToken(d));
    }
    _ && (d.smokeT -= y, d.smokeT <= 0 && (d.smokeT = 0.16, s.fx.smoke(d.pos, { size: 0.3, life: 1.1, color: 2500652, rise: 0.8 }), o() < 0.15 && s.fx.sparks(d.pos, J_, 2))), d.loop && (d.loop.setPos(d.pos), d.loop.setPitch(0.85 + d.thr * 0.2 + (_ ? Math.sin(m * 13) * 0.05 : 0)));
  }
  return d;
}
var HOUND_TUNE = { hp: 140, shotDamage: 5, burst: 4, burstGap: 0.11, telegraph: 0.5, cooldown: [1.8, 3], runSpeed: 4.5, stalkSpeed: 2, patrolSpeed: 1.5, accel: 7, turnRate: 2.5, rangeMin: 8, rangeMax: 18, spreadFar: 0.12, spreadNear: 0.045, lungeRange: 3, lungeDamage: 15, lungeCooldown: 3.5, lungeSpeed: 9.5, replan: 0.6, smokeBelow: 0.4 }, Gt = HOUND_TUNE, ni = $v, ps = new THREE.Vector3(), ru = new THREE.Vector3(), Po = new THREE.Vector3(), Io = new THREE.Vector3(), eM = new THREE.Vector3(), Vf = new THREE.Vector3(), jv = new THREE.Vector3(0, 1, 0), bm = { abd: 0, hip: 0, knee: 0, reach: 0 }, _m = [8, 4, 0.7], NC = [14, 1, 0.35], Mm = (i, e) => {
  let t = (i - e) % (Math.PI * 2);
  return t > Math.PI ? t -= Math.PI * 2 : t < -Math.PI && (t += Math.PI * 2), t;
}, uo = (i, e, t) => i < e ? e : i > t ? t : i, wm = [[0, 3], [1, 2]];
function xa(i, e, t, n, s) {
  return i.v += ((e - i.x) * t - i.v * n) * s, i.x += i.v * s, i.x;
}
function createHound(i, e, t, n) {
  let s = i.G, o = i.rng, r = t.lensBase.clone(), a = instantiateRig(e, { shell: t.shell, metal: t.metal, glow: t.glow, lens: r }, { radius: 1.5, center: [0, 0.6, 0] }), l = a.bones;
  a.group.visible = false;
  let c = [], u = [], h = [];
  for (let T = 0; T < 4; T++) c.push(l["abd" + ni.legs[T]]), u.push(l["thigh" + ni.legs[T]]), h.push(l["shin" + ni.legs[T]]);
  let f = s.mats.label("H-" + String(n + 3).padStart(2, "0"), { color: "black", font: "stencil", distress: 0.3 }), p = 0.2, d = Math.min(0.085, p / (f.aspect || 3)), v = new THREE.PlaneGeometry(p, d);
  v.rotateY(Math.PI / 2), v.translate(0.1675, 0.03, -0.085);
  let g = new THREE.PlaneGeometry(p, d);
  g.rotateY(-Math.PI / 2), g.translate(-0.1675, 0.03, -0.085);
  let x = i.mergeSimple([v, g]), y = new THREE.Mesh(x, f.material);
  y.castShadow = false, y.receiveShadow = true, l.body.add(y);
  let b = [0, 1, 2, 3].map(() => ({ p: new THREE.Vector3(), from: new THREE.Vector3(), to: new THREE.Vector3(), slide: new THREE.Vector3() })), m = { id: 0, type: "hound", pos: a.group.position, alive: false, hp: Gt.hp, active: false, rig: a, lens: r, feet: b, yaw: 0, speed: 0, yawRate: 0, home: new THREE.Vector3(), lastKnown: new THREE.Vector3(), goal: new THREE.Vector3(), firePos: new THREE.Vector3(), firePlayer: new THREE.Vector3(), sensor: new THREE.Vector3(), fwd: new THREE.Vector3(0, 0, 1), muzzle: new THREE.Vector3(), headPos: new THREE.Vector3(), push: new THREE.Vector3(), mode: "patrol", los: false, seeT: 0, noSeeT: 0, senseT: 0, exposure: 0, modeT: 0, passive: false, hasToken: false, es: "move", esT: 0, cool: 1, shots: 0, bursts: 0, lungeCd: 0, path: null, wp: 0, planT: 0, hasGoal: false, waitT: 0, moveT: 0, stuckT: 0, sw: -1, swT: 0, swDur: 0.2, lastPair: 1, idleT: 0, lift: 0.08, sY: { x: 0, v: 0 }, sP: { x: 0, v: 0 }, sR: { x: 0, v: 0 }, sL: { x: 0, v: 0 }, sA: { x: 0, v: 0 }, sA2: { x: 0, v: 0 }, crouch: 0, tyaw: 0, tpitch: 0, hyaw: 0, hpitch: 0, flare: 0, lensC: [_m[0], _m[1], _m[2]], smokeT: 0, phase: 0, scan: 0, dieT: 0, vy: 0, dieRoll: 0, diePitch: 0, wreck: false, sink: 0, loop: null, prevSpeed: 0, maxSpeed: Gt.patrolSpeed, damage(T, D, C, G) {
    if (!m.alive) return false;
    if (m.hp -= T, s.events.emit("enemy:hit", { enemy: m, point: D, part: G || "body" }), C) {
      let j = Math.cos(m.yaw), N = Math.sin(m.yaw), Q = Math.min(1.6, T / 28), K = C.x * N + C.z * j, ie = C.x * j - C.z * N;
      m.sL.v += ie * 1.4 * Q, m.sR.v += -ie * 3.2 * Q, m.sP.v += K * 2.4 * Q * (G === "weak" ? 1.6 : 1), m.sY.v -= 0.5 * Q;
    }
    return i.provoke(m), m.hp <= 0 ? (q(C), true) : false;
  }, _activate(T, D = {}) {
    m.active = true, m.alive = true, m.wreck = false, m.hp = Gt.hp, m.passive = !!D.passive, m.sink = 0, m.pos.copy(T), m.pos.y = s.physics.groundHeight(T.x, T.z, T.y + 1), m.home.copy(m.pos), m.yaw = D.yaw ?? o() * 6.283, m.speed = 0, m.yawRate = 0, m.push.set(0, 0, 0), m.mode = D.state === "alert" ? "investigate" : "patrol", m.modeT = 10, m.modeSeen = m.mode, m.lastKnown.copy(D.target || (s.player ? s.player.pos : T)), m.los = false, m.seeT = m.noSeeT = 0, m.exposure = 0, m.senseT = o() * 0.2, m.hasToken = false, m.patrolR = D.patrolRadius ?? 7, m.patrolLine = D.patrolLine || null, m.patrolI = 0, m.es = "move", m.cool = 0.6 + o(), m.lungeCd = 0.3, m.path = null, m.hasGoal = false, m.waitT = o() * 1.5, m.planT = 0, m.sw = -1, m.idleT = 0, m.crouch = 0, m.feelT = 0, m.blocked = false, m.flare = 0, m.phase = o() * 6.283, m.dieT = 0, m.tyaw = m.hyaw = 0, m.tpitch = m.hpitch = 0;
    for (let C of [m.sY, m.sP, m.sR, m.sL, m.sA, m.sA2]) C.x = 0, C.v = 0;
    for (let C = 0; C < 4; C++) A(b[C].p, C, m.pos.x, m.pos.z, m.yaw);
    if (l.neck.rotation.set(0, 0, 0), l.gun.rotation.set(0, 0, 0), a.group.visible = true, O(0.016), s.audio && s.audio.loop && !m.loop) try {
      m.loop = s.audio.loop("hound_servo", { pos: m.pos, gain: 0 });
    } catch {
      m.loop = null;
    }
  }, _deactivate() {
    if (m.active = false, m.alive = false, m.wreck = false, a.group.visible = false, i.releaseToken(m), m.loop) {
      try {
        m.loop.stop();
      } catch {
      }
      m.loop = null;
    }
  }, _raycast(T, D, C, G) {
    let j = false;
    sM(T, D, m.headPos, 0.155, C, G) && (G.part = "weak", G.enemy = m, j = true);
    let N = Math.cos(m.yaw), Q = Math.sin(m.yaw), K = m.pos.y + ni.stand + m.sY.x - m.crouch;
    return ps.set(m.pos.x - Q * 0.45, K + 0.03, m.pos.z - N * 0.45), ru.set(m.pos.x + Q * 0.47, K + 0.03, m.pos.z + N * 0.47), nM(T, D, ps, ru, 0.27, C, G) && (G.part = "body", G.enemy = m, j = true), ps.y = ru.y = m.pos.y + (K - m.pos.y) * 0.45, nM(T, D, ps, ru, 0.25, C, G) && (G.part = "body", G.enemy = m, j = true), j;
  }, _update(T) {
    m.alive ? S(T) : U(T);
  } };
  function A(T, D, C, G, j) {
    let N = ni.side[D] * ni.footX, Q = ni.footZ[D], K = Math.cos(j), ie = Math.sin(j);
    return T.set(C + N * K + Q * ie, 0, G - N * ie + Q * K), T;
  }
  function _(T, D) {
    !D && m.hasGoal && m.goal.distanceToSquared(T) < 0.25 || (m.goal.copy(T), m.hasGoal = true, m.planT = 0, m.stuckT = 0);
  }
  function M() {
    m.planT = Gt.replan + o() * 0.15;
    let T = null;
    try {
      T = s.physics.nav.findPath(m.pos, m.goal);
    } catch {
      T = null;
    }
    m.path = T && T.length ? T : null, m.wp = 0, m.path && m.path.length > 1 && m.path[0].distanceToSquared(m.pos) < 0.36 && (m.wp = 1);
  }
  function E(T, D) {
    if (!m.hasGoal) return m.maxSpeed = 0, true;
    m.planT -= T, m.planT <= 0 && M();
    let C = m.goal;
    if (m.path) {
      for (; m.wp < m.path.length - 1 && Math.hypot(m.path[m.wp].x - m.pos.x, m.path[m.wp].z - m.pos.z) < 0.55; ) m.wp++;
      C = m.path[Math.min(m.wp, m.path.length - 1)];
    }
    let G = m.goal.x - m.pos.x, j = m.goal.z - m.pos.z, N = Math.hypot(G, j);
    if (N < 0.45) return m.hasGoal = false, m.maxSpeed = 0, true;
    let Q = C.x - m.pos.x, K = C.z - m.pos.z;
    m.wantYaw = Math.atan2(Q, K);
    let ie = Math.abs(Mm(m.wantYaw, m.yaw));
    return m.maxSpeed = ie > 1.1 ? 0 : Math.min(D * (1 - ie * 0.5), 0.4 + N * 2.6), false;
  }
  function w() {
    let T = s.player;
    if (!T) return;
    let D = 1 / 0, C = T.eye || T.pos, G = (Q, K) => {
      let ie = Math.hypot(Q.x - T.pos.x, Q.z - T.pos.z);
      if (ie < Gt.rangeMin || ie > Gt.rangeMax || s.physics.nav.isWalkable && !s.physics.nav.isWalkable(Q.x, Q.z)) return;
      let F = Math.hypot(Q.x - m.pos.x, Q.z - m.pos.z) * 0.9 + K + o() * 3, X = Q.x - T.pos.x, ne = Q.z - T.pos.z;
      for (let re of i.list) {
        if (re === m || !re.alive || re.type !== "hound" || re.mode !== "engage") continue;
        let $ = re.es === "move" ? re.firePos : re.pos, ue = $.x - T.pos.x, me = $.z - T.pos.z, ee = (X * ue + ne * me) / (Math.hypot(X, ne) * Math.hypot(ue, me) + 1e-4);
        ee > 0.86 && (F += 14 * (ee - 0.86) / 0.14), Math.hypot(Q.x - $.x, Q.z - $.z) < 3 && (F += 16);
      }
      F >= D || (Vf.set(Q.x, Q.y + 0.95, Q.z), s.physics.lineOfSight(Vf, C) || (F += 22), F < D && (D = F, m.firePos.set(Q.x, Q.y, Q.z)));
    }, j = s.level && s.level.coverPoints;
    if (j) for (let Q = 0; Q < j.length; Q++) G(j[Q], -2);
    for (let Q = 0; Q < 7; Q++) {
      let K = s.physics.nav.randomPoint(T.pos, Gt.rangeMax);
      K && G(K, 0);
    }
    let N = Math.atan2(m.pos.z - T.pos.z, m.pos.x - T.pos.x);
    for (let Q = 0; Q < 5; Q++) {
      let K = N + (o() - 0.5) * 2.6, ie = Gt.rangeMin + 1 + o() * (Gt.rangeMax - Gt.rangeMin - 2);
      Io.set(T.pos.x + Math.cos(K) * ie, T.pos.y, T.pos.z + Math.sin(K) * ie), Io.y = s.physics.groundHeight(Io.x, Io.z, T.pos.y + 1), G(Io, 1);
    }
    D === 1 / 0 && m.firePos.copy(m.pos), m.firePlayer.copy(T.pos), _(m.firePos, true), m.es = "move", m.esT = 0, m.moveT = 0, m.bursts = 0;
  }
  function S(T) {
    let D = s.player, C = i.t;
    m.fwd.set(Math.sin(m.yaw), 0, Math.cos(m.yaw)), m.sensor.copy(m.headPos), i.think(m, T, 0.55), m.mode !== m.modeSeen && (m.modeSeen = m.mode, m.hasGoal = false, m.path = null, m.waitT = 0, m.mode === "engage" ? w() : (m.es === "tele" || m.es === "burst") && (i.releaseToken(m), m.es = "move")), m.wantYaw = m.yaw, m.maxSpeed = 0, m.cool -= T, m.lungeCd -= T;
    let G = null, j = null, N = 0, Q = false, K = D ? Math.hypot(D.pos.x - m.pos.x, D.pos.z - m.pos.z) : 1e9;
    if (m.mode === "patrol") {
      if (m.hasGoal) E(T, Gt.patrolSpeed) && (m.waitT = 1.5 + o() * 3);
      else if (m.waitT -= T, m.waitT <= 0) if (m.patrolLine) m.patrolI = (m.patrolI + 1) % m.patrolLine.length, _(m.patrolLine[m.patrolI], true);
      else {
        let I = s.physics.nav.randomPoint(m.home, m.patrolR);
        I ? _(I, true) : m.waitT = 1;
      }
    } else if (m.mode === "investigate" || m.mode === "search") {
      j = m.lastKnown;
      let I = Math.hypot(m.lastKnown.x - m.pos.x, m.lastKnown.z - m.pos.z);
      I > 2.2 ? (_(m.lastKnown), E(T, I < 8 ? Gt.stalkSpeed : Gt.runSpeed)) : (m.hasGoal = false, m.scan += T, m.wantYaw = m.yaw + Math.sin(m.scan * 0.8) * 0.9, j = null);
    } else if (D) {
      G = D.pos, j = D.pos;
      let I = Math.atan2(D.pos.x - m.pos.x, D.pos.z - m.pos.z);
      switch ((m.es === "move" || m.es === "aim" || m.es === "cool") && K < Gt.lungeRange && m.lungeCd <= 0 && D.alive && (m.es = "wind", m.esT = 0.28, i.releaseToken(m), s.events.emit("enemy:telegraph", { enemy: m, type: "hound", time: 0.28, pos: m.pos, melee: true })), m.es) {
        case "move": {
          m.moveT += T;
          let se = E(T, Gt.runSpeed), ae = K > Gt.rangeMin - 1 && K < Gt.rangeMax + 2;
          se || m.moveT > 1.4 && m.los && ae && o() < T * 0.7 || m.moveT > 7 ? (m.es = "aim", m.esT = 0, m.hasGoal = false) : D.pos.distanceToSquared(m.firePlayer) > 49 && w();
          break;
        }
        case "aim":
        case "cool": {
          m.wantYaw = I, m.esT += T, m.los ? K < Gt.rangeMin - 3 && m.esT > 0.8 ? w() : m.cool <= 0 && D.alive && Math.abs(Mm(I - m.yaw, m.tyaw)) < 0.14 && i.requestToken(m) && (m.es = "tele", m.esT = Gt.telegraph, s.events.emit("enemy:telegraph", { enemy: m, type: "hound", time: Gt.telegraph, pos: m.pos })) : (m.noSeeT > 1.1 || m.esT > 3) && w();
          break;
        }
        case "tele": {
          m.wantYaw = I, m.esT -= T, m.flare = Math.min(1, m.flare + T * 5), N = 0.05, m.esT <= 0 && (m.es = "burst", m.shots = Gt.burst, m.esT = 0);
          break;
        }
        case "burst": {
          m.wantYaw = I, m.esT -= T, m.flare = 1, N = 0.05, m.esT <= 0 && (m.esT = Gt.burstGap, m.shots--, z(D)), m.shots <= 0 && (i.releaseToken(m), m.cool = Gt.cooldown[0] + o() * (Gt.cooldown[1] - Gt.cooldown[0]), m.bursts++, m.bursts >= 1 + (o() < 0.4 ? 1 : 0) ? w() : (m.es = "cool", m.esT = 0));
          break;
        }
        case "wind": {
          m.wantYaw = I, m.esT -= T, N = 0.16, m.sP.v += 3 * T, m.esT <= 0 && (m.es = "lunge", m.esT = 0.36, m.speed = Gt.lungeSpeed, m.yaw = I);
          break;
        }
        case "lunge": {
          Q = true, m.esT -= T, m.wantYaw = I, m.maxSpeed = Gt.lungeSpeed, m.speed = Gt.lungeSpeed, K < 1.35 && D.alive && (D.damage(Gt.lungeDamage, m.pos), s.events.emit("enemy:melee", { enemy: m, pos: m.pos }), m.esT = 0, m.sP.v -= 4), m.esT <= 0 && (m.es = "recover", m.esT = 0.55, m.lungeCd = Gt.lungeCooldown, m.speed *= 0.3);
          break;
        }
        case "recover": {
          m.esT -= T, m.wantYaw = I, m.esT <= 0 && w();
          break;
        }
      }
    }
    let ie = Mm(m.wantYaw, m.yaw), F = uo(ie * 6, -Gt.turnRate, Gt.turnRate) * (Q ? 2 : 1);
    m.yawRate += (F - m.yawRate) * (1 - Math.exp(-10 * T)), m.yaw += m.yawRate * T;
    let X = m.maxSpeed > m.speed ? Gt.accel : -Gt.accel * 1.4;
    m.prevSpeed = m.speed, m.speed = Q ? m.speed : uo(m.speed + X * T, 0, Math.max(m.maxSpeed, 0)), !Q && X < 0 && m.speed < m.maxSpeed && (m.speed = m.maxSpeed);
    let ne = Math.sin(m.yaw), re = Math.cos(m.yaw);
    for (let I of i.list) {
      if (I === m || I.type !== "hound" || !I.active) continue;
      let se = m.pos.x - I.pos.x, ae = m.pos.z - I.pos.z, k = Math.hypot(se, ae);
      if (k < 1.7 && k > 1e-3) {
        let ce = (1.7 - k) * 2.2 / k;
        m.push.x += se * ce * T * 6, m.push.z += ae * ce * T * 6;
      }
    }
    if (D && !Q && K < 1.25 && K > 1e-3) {
      let I = (1.25 - K) * 3 / K;
      m.push.x += (m.pos.x - D.pos.x) * I * T * 6, m.push.z += (m.pos.z - D.pos.z) * I * T * 6;
    }
    m.push.multiplyScalar(Math.exp(-5 * T));
    let $ = m.pos.x + (ne * m.speed + m.push.x) * T, ue = m.pos.z + (re * m.speed + m.push.z) * T, me = s.physics.nav;
    if (m.feelT -= T, m.feelT <= 0 && m.speed > 0.3) {
      m.feelT = 0.12, Io.set(m.pos.x, m.pos.y + 0.55, m.pos.z), Po.set(ne, 0, re);
      let I = s.physics.raycast(Io, Po, 0.75 + m.speed * 0.12);
      m.blocked = !!I;
    } else m.speed <= 0.3 && (m.blocked = false);
    (me.isWalkable && !me.isWalkable($, ue) || m.blocked && !Q || m.blocked && Q && m.esT < 0.3) && (m.blocked ? ($ = m.pos.x + m.push.x * T, ue = m.pos.z + m.push.z * T, m.yawRate += (m.phase > 3.14 ? 1 : -1) * 4 * T) : me.isWalkable($, m.pos.z) ? ue = m.pos.z : me.isWalkable(m.pos.x, ue) ? $ = m.pos.x : ($ = m.pos.x, ue = m.pos.z), m.speed *= 0.6, m.stuckT += T, m.stuckT > 0.5 && (m.stuckT = 0, m.planT = 0, m.mode === "engage" && m.es === "move" ? w() : m.mode === "patrol" && (m.hasGoal = false))), m.pos.x = $, m.pos.z = ue, m.pos.y += (s.physics.groundHeight($, ue, m.pos.y + 0.6) - m.pos.y) * (1 - Math.exp(-12 * T)), H(T), m.crouch += (N - m.crouch) * (1 - Math.exp(-12 * T));
    let ee = Math.cos(m.yaw), B = Math.sin(m.yaw), P = 0, V = 0, Y = 0, L = 0.05, Z = m.pos.y + ni.stand + m.sY.x - m.crouch;
    if (G) {
      let I = G.x - m.pos.x, se = G.z - m.pos.z, ae = G.y + 1 - (Z + 0.25);
      P = Math.atan2(I * ee - se * B, I * B + se * ee), V = uo(Math.atan2(-ae, Math.hypot(I, se)), -0.9, 0.35);
    } else m.scan += T * 0.5, P = Math.sin(m.scan * 0.9 + m.phase) * 1.1;
    if (j) {
      let I = j.x - m.pos.x, se = j.z - m.pos.z, ae = j.y + 1.2 - (Z + 0.2);
      Y = uo(Math.atan2(I * ee - se * B, I * B + se * ee), -1.2, 1.2), L = uo(Math.atan2(-ae, Math.hypot(I, se)), -0.6, 0.5);
    } else Y = Math.sin(i.t * 0.7 + m.phase) * 0.5 + uo(m.yawRate * 0.25, -0.6, 0.6);
    let J = uo(4.5 * T, 0, 1);
    m.tyaw += uo(Mm(P, m.tyaw), -J, J), m.tpitch += (V - m.tpitch) * (1 - Math.exp(-10 * T));
    let oe = 1 - Math.exp(-7 * T);
    m.hyaw += (Y - m.hyaw) * oe, m.hpitch += (L - m.hpitch) * oe, O(T);
    let fe = (i.t * (m.mode === "patrol" ? 0.8 : 2.2) + m.phase) % 1;
    l.beacon.scale.setScalar(fe < 0.12 || fe > 0.22 && fe < 0.3 ? 1 : 1e-4);
    let le = m.mode === "engage" ? NC : _m, R = 1 + m.flare * 3.5;
    for (let I = 0; I < 3; I++) m.lensC[I] += (le[I] - m.lensC[I]) * (1 - Math.exp(-8 * T));
    r.color.setRGB(m.lensC[0] * R, m.lensC[1] * R, m.lensC[2] * R), m.flare = Math.max(0, m.flare - T * 2), m.hp < Gt.hp * Gt.smokeBelow && (m.smokeT -= T, m.smokeT <= 0 && (m.smokeT = 0.2, ps.set(m.pos.x - ne * 0.3, Z + 0.2, m.pos.z - re * 0.3), s.fx.smoke(ps, { size: 0.35, life: 1.3, color: 2303272, rise: 0.9 }), o() < 0.2 && s.fx.sparks(ps, jv, 3))), m.loop && (m.loop.setPos(m.pos), m.loop.setGain(uo(0.12 + m.speed * 0.12 + Math.abs(m.yawRate) * 0.1, 0, 0.8)), m.loop.setPitch(0.8 + m.speed * 0.08));
  }
  function z(T) {
    let D = Math.cos(m.yaw + m.tyaw), C = Math.sin(m.yaw + m.tyaw);
    Io.setFromMatrixPosition(l.gun.matrixWorld), (Io.lengthSq() < 1e-6 || Math.abs(Io.x - m.pos.x) > 2) && Io.set(m.pos.x, m.pos.y + ni.stand + 0.25, m.pos.z), Vf.set(T.pos.x, T.pos.y + 1, T.pos.z), Po.copy(Vf).sub(Io).normalize(), m.muzzle.copy(Io).addScaledVector(Po, 0.43);
    let G = (Gt.spreadFar + (Gt.spreadNear - Gt.spreadFar) * m.exposure) * (1 + i.playerSpeed * 0.3);
    Po.x += (o() - 0.5) * 2 * G, Po.y += (o() - 0.5) * 2 * G, Po.z += (o() - 0.5) * 2 * G, Po.normalize();
    let j = s.physics.raycast(m.muzzle, Po, 200), Q = s.combat.enemyShot(m.muzzle, Po, { damage: Gt.shotDamage, range: 200 }) ? m.muzzle.distanceTo(Vf) : j ? j.dist : 90;
    eM.copy(m.muzzle).addScaledVector(Po, Q), s.fx.tracer(m.muzzle, eM, { color: 16760944, speed: 260, width: 0.035 }), s.fx.muzzleFlash(m.muzzle, Po, { scale: 0.9 }), s.render && s.render.lightPool && s.render.lightPool.flash(m.muzzle, 16756832, 22, 7, 0.05), s.events.emit("enemy:fire", { enemy: m, pos: m.muzzle, dir: Po, type: "hound" }), m.sP.v += 1.1, m.sY.v -= 0.25;
  }
  function H(T) {
    let D = Math.sin(m.yaw) * m.speed + m.push.x, C = Math.cos(m.yaw) * m.speed + m.push.z, G = m.speed > 0.15 || Math.abs(m.yawRate) > 0.25;
    if (m.sw < 0) {
      m.idleT = G ? 0 : m.idleT + T;
      let j = m.speed + Math.abs(m.yawRate) * 0.5, N = uo(0.27 - j * 0.026, 0.14, 0.27), Q = -1, K = 0;
      for (let F = 0; F < 2; F++) {
        let X = 0;
        for (let ne of wm[F]) {
          A(ps, ne, m.pos.x + D * N, m.pos.z + C * N, m.yaw + m.yawRate * N);
          let re = Math.hypot(ps.x - b[ne].p.x, ps.z - b[ne].p.z);
          re > X && (X = re);
        }
        F !== m.lastPair && (X *= 1.25), X > K && (K = X, Q = F);
      }
      let ie = G ? 0.09 : m.idleT > 0.25 ? 0.035 : 1e9;
      if (Q >= 0 && K > ie) {
        m.sw = Q, m.swT = 0, m.swDur = N, m.lift = 0.065 + Math.min(0.09, j * 0.02);
        for (let F of wm[Q]) {
          let X = b[F];
          X.from.copy(X.p), A(X.to, F, m.pos.x + D * N * 1.5, m.pos.z + C * N * 1.5, m.yaw + m.yawRate * N * 1.5), X.to.y = s.physics.groundHeight(X.to.x, X.to.z, m.pos.y + 0.6);
        }
      }
    } else {
      m.swT += T / m.swDur;
      let j = m.swT >= 1 ? 1 : m.swT, N = j * j * (3 - 2 * j);
      for (let Q of wm[m.sw]) {
        let K = b[Q];
        K.p.lerpVectors(K.from, K.to, N), K.p.y += Math.sin(Math.PI * j) * m.lift;
      }
      if (m.swT >= 1) {
        let Q = b[wm[m.sw][0]];
        s.events.emit("enemy:step", { pos: Q.p, type: "hound", enemy: m, speed: m.speed }), m.sY.v -= 0.12 + m.speed * 0.03, m.lastPair = m.sw, m.sw = -1;
      }
    }
  }
  function O(T) {
    let D = Math.cos(m.yaw), C = Math.sin(m.yaw), G = (b[0].p.y + b[1].p.y) * 0.5, j = (b[2].p.y + b[3].p.y) * 0.5, N = (b[0].p.y + b[2].p.y) * 0.5, Q = (b[1].p.y + b[3].p.y) * 0.5, K = (G + j) * 0.5 - m.pos.y, ie = T > 0 ? (m.speed - m.prevSpeed) / T : 0, F = Math.atan2(j - G, 0.8) * 0.6 + uo(ie * 6e-3, -0.07, 0.07), X = Math.atan2(N - Q, 0.55) * 0.6 + uo(m.yawRate * m.speed * 0.02, -0.12, 0.12), ne = K * 0.45 - Math.min(0.05, m.speed * 0.011);
    m.alive || (F = m.diePitch, X = m.dieRoll, ne = 0), m.alive && (xa(m.sY, ne, 160, 17, T), xa(m.sP, F, 130, 15, T), xa(m.sR, X, 130, 15, T), xa(m.sL, 0, 110, 13, T));
    let re = m.alive ? Math.sin(i.t * 1.7 + m.phase) * 4e-3 : 0, $ = m.sL.x, ue = ni.stand + m.sY.x - m.crouch + re, me = m.sP.x, ee = m.sR.x;
    a.group.rotation.y = m.yaw, l.body.position.set($, ue, 0), l.body.rotation.set(me, 0, ee), l.turret.rotation.y = m.tyaw, l.gun.rotation.x = m.tpitch - me * 0.5, l.head.rotation.set(m.hpitch, m.hyaw, 0), xa(m.sA, uo(-ie * 0.03 - me, -0.6, 0.6), 60, 5, T), xa(m.sA2, uo(m.yawRate * 0.12 - ee, -0.6, 0.6), 60, 5, T), l.antenna.rotation.set(m.sA.x, 0, m.sA2.x);
    let B = Math.cos(me), P = Math.sin(me), V = Math.cos(ee), Y = Math.sin(ee);
    for (let L = 0; L < 4; L++) {
      let Z = b[L].p, J = Z.x - m.pos.x, oe = Z.y + ni.footR * 0.6 - m.pos.y, fe = Z.z - m.pos.z, le = J * D - fe * C - $, R = oe - ue, I = J * C + fe * D, se = R * B + I * P, ae = -R * P + I * B, k = le * V + se * Y, ce = -le * Y + se * V;
      q_(bm, k - ni.side[L] * ni.hipX, ce - ni.hipY, ae - ni.fore[L] * ni.hipZ, ni.side[L], ni.l0, ni.L1, ni.L2 - ni.footR * 0.6), c[L].rotation.z = bm.abd, u[L].rotation.x = bm.hip, h[L].rotation.x = bm.knee;
    }
    a.group.updateMatrixWorld(true), m.headPos.setFromMatrixPosition(l.head.matrixWorld);
  }
  function q(T) {
    m.alive = false, i.releaseToken(m), m.dieT = 0, m.vy = 0, m.es = "move", l.beacon.scale.setScalar(1e-4), m.dieRoll = (o() < 0.5 ? -1 : 1) * (0.25 + o() * 0.3), m.diePitch = (o() - 0.5) * 0.25, m.sR.v += m.dieRoll * 3, m.sP.v += (o() - 0.5) * 2;
    for (let D = 0; D < 4; D++) {
      let C = b[D];
      m.sw >= 0 && (C.p.y = m.pos.y);
      let G = m.yaw, j = ni.side[D] * (0.16 + o() * 0.2), N = ni.fore[D] * (0.05 + o() * 0.22) + (o() - 0.5) * 0.1;
      C.slide.set(j * Math.cos(G) + N * Math.sin(G), 0, -j * Math.sin(G) + N * Math.cos(G));
    }
    m.sw = -1, m.speed *= 0.3, ps.copy(m.headPos), s.fx.sparks(ps, jv, 16), s.fx.debris(ps, { count: 4 }), s.events.emit("enemy:killed", { enemy: m, pos: m.pos, type: "hound" }), i.addWreck(m);
  }
  function U(T) {
    if (m.sink > 0) {
      m.sink += T, m.pos.y -= 0.22 * T, m.sink > 3.2 && i.retire(m);
      return;
    }
    m.dieT += T;
    let D = m.dieT;
    if (D < 2.2) {
      let C = 0.215 - ni.stand;
      m.vy -= 9.8 * T * (D < 0.12 ? 0.3 : 1), m.sY.x += m.vy * T, m.sY.x < C && (m.sY.x = C, m.vy < -1.2 && (s.events.emit("enemy:step", { pos: m.pos, type: "hound", enemy: m, speed: 5, crash: true }), s.fx.dust(m.pos, jv)), m.vy = -m.vy * 0.22), xa(m.sP, m.diePitch, 60, 9, T), xa(m.sR, m.dieRoll, 60, 9, T), xa(m.sL, 0, 40, 8, T);
      let G = Math.exp(-3.2 * T);
      for (let N = 0; N < 4; N++) {
        let Q = b[N];
        Q.p.x += Q.slide.x * (1 - G), Q.p.z += Q.slide.z * (1 - G), Q.slide.multiplyScalar(G);
      }
      m.pos.x += Math.sin(m.yaw) * m.speed * T, m.pos.z += Math.cos(m.yaw) * m.speed * T, m.speed *= Math.exp(-5 * T), m.hpitch += (0.55 - m.hpitch) * (1 - Math.exp(-5 * T)), m.hyaw += (m.dieRoll - m.hyaw) * (1 - Math.exp(-3 * T)), m.tpitch += (0.3 - m.tpitch) * (1 - Math.exp(-4 * T));
      let j = D < 1.2 ? Math.sin(D * 60) > 0.2 ? 1 - D / 1.2 : 0.05 : 0.02;
      r.color.setRGB(6 * j + 0.05, 0.6 * j + 0.01, 0.2 * j), O(T);
    }
    if (D < 6.5) m.smokeT -= T, m.smokeT <= 0 && (m.smokeT = D < 2 ? 0.09 : 0.2, ps.set(m.pos.x + (o() - 0.5) * 0.4, m.pos.y + 0.42, m.pos.z + (o() - 0.5) * 0.4), s.fx.smoke(ps, { size: 0.5 + o() * 0.3, life: 1.8, color: 1513499, rise: 1.1 }), D < 4 && o() < 0.55 && (ru.set(o() - 0.5, 1, o() - 0.5).normalize(), s.fx.sparks(ps, ru, D < 1 ? 8 : 3)), D < 3.5 && o() < 0.4 && s.fx.smoke(ps, { size: 0.22, life: 0.45, color: 16742946, rise: 1.6 }));
    else if (!m.wreck && (m.wreck = true, m.loop)) {
      try {
        m.loop.stop();
      } catch {
      }
      m.loop = null;
    }
    m.loop && m.loop.setGain(Math.max(0, 0.4 - D * 0.3));
  }
  return m;
}
function sM(i, e, t, n, s, o) {
  let r = i.x - t.x, a = i.y - t.y, l = i.z - t.z, c = r * e.x + a * e.y + l * e.z, u = r * r + a * a + l * l - n * n, h = c * c - u;
  if (h < 0) return false;
  let f = -c - Math.sqrt(h);
  return f < 0 || f > s || f >= o.dist ? false : (o.dist = f, o.point.copy(i).addScaledVector(e, f), o.normal.copy(o.point).sub(t).normalize(), true);
}
var au = new THREE.Vector3(), Jv = new THREE.Vector3(), tM = new THREE.Vector3();
function nM(i, e, t, n, s, o, r) {
  au.copy(n).sub(t), Jv.copy(i).sub(t);
  let a = au.dot(au), l = au.dot(e), c = au.dot(Jv), u = e.dot(Jv), h = a - l * l, f = h > 1e-8 ? (c - l * u) / h : 0;
  return f = f < 0 ? 0 : f > 1 ? 1 : f, tM.copy(t).addScaledVector(au, f), sM(i, e, tM, s, o, r);
}
var ROBOT_TUNE = { gull: GULL_TUNE, hound: HOUND_TUNE, sightRange: 45, sightCone: 200, loseSight: 4, searchTime: 8, hearRadius: 45, maxTokens: 2, maxTokensCrowd: 3, tokenGap: 1.25, exposureUp: 0.1, exposureDown: 0.45, poolGulls: 10, poolHounds: 8, maxWrecks: 5, maxBolts: 32 }, BC = Math.cos(ROBOT_TUNE.sightCone / 2 * Math.PI / 180), oM = new THREE.Vector3(), pz = new THREE.Vector3(), Qv = new THREE.Vector3(), rM = new THREE.Quaternion(), aM = new THREE.Matrix4(), lM = new THREE.Vector3(1, 1, 1), OC = new THREE.Vector3(0, 0, 1), mz = new THREE.Vector3(0, -1, 0), cM = new THREE.Vector3(), uM = new THREE.Vector3();
function createRobotFleet(i) {
  let e = seededRng(+(i.params && i.params.eseed || 9001)), t = [], n = [], s = new THREE.Group();
  s.name = "enemies", i.scene.add(s);
  let o = i.mats.emissive(16777215, 1), r = o && o.isMeshBasicMaterial ? o.clone() : new THREE.MeshBasicMaterial();
  r.color.setRGB(1, 1, 1), r.vertexColors = true, r.needsUpdate = true;
  let a = i.mats.emissive(16752704, 6), l = a && a.isMeshBasicMaterial ? a : new THREE.MeshBasicMaterial({ color: 16752704 }), c = o && o.toneMapped !== void 0 ? o.toneMapped : true, u = { shell: i.mats.get("armor_white", { triplanar: true, vertexColors: true }), metal: i.mats.get("gunmetal", { triplanar: true, vertexColors: true }), glow: r, lensBase: l, disc: new THREE.MeshBasicMaterial({ color: 789775, transparent: true, opacity: 0.42, depthWrite: false, side: THREE.DoubleSide, toneMapped: c }), cone: new THREE.ShaderMaterial({ uniforms: { uColor: { value: new THREE.Color(1, 0.9, 0.74) }, uGain: { value: 0.085 } }, vertexShader: `
        #include <common>
        #include <skinning_pars_vertex>
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          #include <beginnormal_vertex>
          #include <skinbase_vertex>
          #include <skinnormal_vertex>
          #include <begin_vertex>
          #include <skinning_vertex>
          vec4 mv = modelViewMatrix * vec4(transformed, 1.0);
          vN = normalMatrix * objectNormal; vV = -mv.xyz; vT = 1.0 - uv.y;
          gl_Position = projectionMatrix * mv;
        }`, fragmentShader: `
        uniform vec3 uColor; uniform float uGain;
        varying float vT; varying vec3 vN; varying vec3 vV;
        void main() {
          float f = abs(dot(normalize(vN), normalize(vV)));
          f = f * f * (3.0 - 2.0 * f);
          float t = clamp(vT, 0.0, 1.0);
          float k = pow(1.0 - t, 1.7) * (0.35 + 0.65 * smoothstep(0.0, 0.06, t));
          gl_FragColor = vec4(uColor * (uGain * f * k), 1.0);
        }`, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }) }, h = { G: i, rng: e, list: t, t: 0, playerSpeed: 0, tokens: 0, tokenT: -9, lastType: "", wantT: { gull: -9, hound: -9 }, mergeSimple: (T) => sa(T, false), requestToken(T) {
    if (T.hasToken) return true;
    let D = 0;
    for (let Q of t) Q.alive && D++;
    let C = D > 5 ? ROBOT_TUNE.maxTokensCrowd : ROBOT_TUNE.maxTokens, G = h.t - h.tokenT, j = T.type === "gull" ? "hound" : "gull", N = h.lastType === T.type && h.t - h.wantT[j] < 0.5 && G < ROBOT_TUNE.tokenGap * 2.2;
    return h.tokens >= C || G < ROBOT_TUNE.tokenGap || N ? (h.wantT[T.type] = h.t, false) : (h.tokens++, h.tokenT = h.t, h.lastType = T.type, T.hasToken = true, true);
  }, releaseToken(T) {
    T.hasToken && (T.hasToken = false, h.tokens = Math.max(0, h.tokens - 1));
  }, think(T, D, C) {
    let G = i.player;
    if (T.passive || !G) {
      T.los = false;
      return;
    }
    if (T.senseT -= D, T.senseT <= 0) {
      T.senseT = 0.11 + e() * 0.08;
      let j = false;
      if (G.alive !== false) {
        let N = G.eye || G.pos, Q = N.x - T.sensor.x, K = N.y - T.sensor.y, ie = N.z - T.sensor.z, F = Math.hypot(Q, K, ie);
        if (F < ROBOT_TUNE.sightRange) {
          let X = Math.hypot(Q, ie) || 1e-4, ne = (Q * T.fwd.x + ie * T.fwd.z) / X;
          (T.mode === "engage" || ne > BC || F < 3.5) && (j = i.physics.lineOfSight(T.sensor, N));
        }
      }
      T.los = j;
    }
    T.los ? (T.seeT += D, T.noSeeT = 0, T.lastKnown.copy(G.pos), T.exposure = Math.min(1, T.exposure + D * ROBOT_TUNE.exposureUp)) : (T.noSeeT += D, T.seeT = Math.max(0, T.seeT - D * 0.6), T.exposure = Math.max(0, T.exposure - D * ROBOT_TUNE.exposureDown)), T.mode === "engage" ? (T.noSeeT > ROBOT_TUNE.loseSight || G.alive === false) && (T.mode = "search", T.modeT = ROBOT_TUNE.searchTime + e() * 3, h.releaseToken(T)) : T.los && T.seeT > (T.mode === "patrol" ? C : C * 0.45) ? (T.mode = "engage", T.noSeeT = 0, i.events.emit("enemy:alert", { enemy: T }), h.rally(T.pos, 18, G.pos, T)) : T.mode !== "patrol" && (T.modeT -= D, T.modeT <= 0 && (T.mode = "patrol", T.home.x = T.pos.x, T.home.z = T.pos.z));
  }, rally(T, D, C, G) {
    for (let j of t) j === G || !j.alive || j.passive || j.mode === "engage" || j.pos.distanceToSquared(T) > D * D || (j.lastKnown.copy(C), j.mode = "investigate", j.modeT = 9 + e() * 4);
  }, provoke(T) {
    let D = i.player;
    !D || T.passive || !T.alive || (T.mode !== "engage" && (T.lastKnown.copy(D.pos), T.mode = "investigate", T.modeT = 10, T.seeT = 1, T.senseT = 0), h.rally(T.pos, 20, D.pos, T));
  }, fireBolt(T, D, C) {
    let G = null;
    for (let j = 0; j < g.length; j++) if (!g[j].on) {
      G = g[j];
      break;
    }
    G && (G.on = true, G.life = 1.3, G.pos.copy(T), G.dir.copy(D), G.from.copy(T), G.len = 0);
  }, addWreck(T) {
    for (n.push(T); n.length > ROBOT_TUNE.maxWrecks; ) {
      let D = n.shift();
      D.active && (D.sink = 1e-3);
    }
  }, retire(T) {
    T._deactivate();
    let D = t.indexOf(T);
    D >= 0 && t.splice(D, 1), D = n.indexOf(T), D >= 0 && n.splice(D, 1);
  } }, f = buildGullRig(), p = buildHoundRig(), d = [], v = [];
  for (let T = 0; T < ROBOT_TUNE.poolGulls; T++) {
    let D = createGull(h, f, u, T);
    d.push(D), s.add(D.rig.group);
  }
  for (let T = 0; T < ROBOT_TUNE.poolHounds; T++) {
    let D = createHound(h, p, u, T);
    v.push(D), s.add(D.rig.group);
  }
  let g = [];
  for (let T = 0; T < ROBOT_TUNE.maxBolts; T++) g.push({ on: false, life: 0, len: 0, pos: new THREE.Vector3(), dir: new THREE.Vector3(), from: new THREE.Vector3() });
  let x = new THREE.CylinderGeometry(0.016, 0.03, 1, 6, 1);
  x.rotateX(Math.PI / 2), x.translate(0, 0, -0.5);
  let y = i.mats.emissive(16738858, 14), b = y && y.isMeshBasicMaterial ? y : new THREE.MeshBasicMaterial({ color: new THREE.Color(16738858).multiplyScalar(14) }), m = new THREE.InstancedMesh(x, b, ROBOT_TUNE.maxBolts);
  m.frustumCulled = false, m.castShadow = false, m.receiveShadow = false, m.count = 0, m.instanceMatrix.setUsage(THREE.DynamicDrawUsage), s.add(m);
  let A = { point: new THREE.Vector3(), normal: new THREE.Vector3(), dist: 0, surface: "concrete", enemy: null, part: null, dir: new THREE.Vector3(), from: "enemy" };
  function _(T) {
    let D = i.player, C = 0;
    for (let G = 0; G < g.length; G++) {
      let j = g[G];
      if (!j.on) continue;
      let N = ROBOT_TUNE.gull.boltSpeed * T;
      j.life -= T;
      let Q = i.physics.raycast(j.pos, j.dir, N), K = Q ? Q.dist : N, ie = false;
      if (D && D.alive !== false && (oM.copy(j.pos).addScaledVector(j.dir, K), cM.set(D.pos.x, D.pos.y + 0.35, D.pos.z), uM.set(D.pos.x, D.pos.y + (D.crouching ? 1 : 1.5), D.pos.z), segmentSegmentDistSq(j.pos, oM, cM, uM) < 0.36 * 0.36 && (ie = true)), ie) {
        D.damage(ROBOT_TUNE.gull.boltDamage, j.from), j.on = false;
        continue;
      }
      if (Q) {
        A.point.copy(Q.point), A.normal.copy(Q.normal), A.dist = Q.dist, A.surface = Q.surface, A.dir.copy(j.dir), i.events.emit("impact", A), j.on = false;
        continue;
      }
      if (j.life <= 0) {
        j.on = false;
        continue;
      }
      j.pos.addScaledVector(j.dir, N), j.len = Math.min(1.5, j.len + N), rM.setFromUnitVectors(OC, j.dir), lM.set(1, 1, Math.max(0.2, j.len)), aM.compose(j.pos, rM, lM), m.setMatrixAt(C++, aM);
    }
    (C || m.count) && (m.count = C, m.instanceMatrix.needsUpdate = true);
  }
  let M = null, E = false, w = 0, S = new THREE.Vector3(), z = 0;
  function H(T) {
    if (!E) {
      E = true;
      try {
        M = i.render && i.render.lightPool && i.render.lightPool.acquire ? i.render.lightPool.acquire() : null;
      } catch {
        M = null;
      }
      M && M.light && (M.light.color.setRGB(1, 0.9, 0.75), M.light.distance = 9);
    }
    if (!M || !M.light) return;
    let D = null, C = 3600, G = i.camera ? i.camera.position : null;
    for (let N of t) {
      if (N.type !== "gull" || !N.alive) continue;
      let Q = G ? N.pos.distanceToSquared(G) : 0;
      Q < C && (C = Q, D = N);
    }
    let j = 0;
    if (D) {
      if (w -= T, w <= 0) {
        w = 0.1;
        let N = D.yaw + D.gy, Q = Math.cos(D.gp);
        Qv.set(Math.sin(N) * Q, -Math.sin(D.gp), Math.cos(N) * Q).normalize();
        let K = i.physics.raycast(D.sensor, Qv, 14);
        S.copy(D.sensor).addScaledVector(Qv, (K ? K.dist : 8) - 0.6), z = K ? 1 : 0.3;
      }
      j = 26 * z, M.light.position.lerp(S, 1 - Math.exp(-12 * T));
    }
    M.light.intensity += (j - M.light.intensity) * (1 - Math.exp(-8 * T));
  }
  let O = 1, q = 0, U = { list: t, TUNE: ROBOT_TUNE, spawn(T, D, C = {}) {
    let G = T === "gull" ? d : T === "hound" ? v : null;
    if (!G) return null;
    let j = null;
    for (let N of G) if (!N.active) {
      j = N;
      break;
    }
    if (!j && T === "hound" && n.length) {
      let N = n[0];
      h.retire(N), j = N;
    }
    return j ? (j.id = O++, t.push(j), j._activate(D, C), i.events.emit("enemy:spawn", { enemy: j }), j) : null;
  }, raycast(T, D, C = 300) {
    let G = null;
    for (let j = 0; j < t.length; j++) {
      let N = t[j];
      if (!N.alive) continue;
      let Q = N.pos.x - T.x, K = N.pos.y + (N.type === "hound" ? 0.6 : 0) - T.y, ie = N.pos.z - T.z, F = Q * D.x + K * D.y + ie * D.z;
      F < -1.5 || F > C + 1.5 || Q * Q + K * K + ie * ie - F * F > 1.7 || (G || (G = { dist: 1 / 0, point: new THREE.Vector3(), normal: new THREE.Vector3(), enemy: null, part: "body" }), N._raycast(T, D, C, G));
    }
    return G && G.enemy ? G : null;
  }, aliveCount() {
    let T = 0;
    for (let D of t) D.alive && T++;
    return T;
  }, clear() {
    for (let T of d) T.active && T._deactivate();
    for (let T of v) T.active && T._deactivate();
    t.length = 0, n.length = 0, h.tokens = 0;
    for (let T of g) T.on = false;
    m.count = 0, M && M.light && (M.light.intensity = 0);
  }, alert(T, D = 40) {
    for (let C of t) !C.alive || C.passive || C.mode === "engage" || C.pos.distanceToSquared(T) > D * D || (C.lastKnown.copy(T), C.lastKnown.y = Math.max(0, T.y - 1.6), C.mode === "patrol" && i.events.emit("enemy:alert", { enemy: C, noise: true }), C.mode = "investigate", C.modeT = 9 + e() * 4);
  }, update(T) {
    if (T <= 0) return;
    T > 0.05 && (T = 0.05), h.t += T, q -= T;
    let D = i.player;
    if (D) {
      let C = D.vel ? Math.hypot(D.vel.x, D.vel.z) : D.speed || 0;
      h.playerSpeed += (C - h.playerSpeed) * (1 - Math.exp(-6 * T));
    }
    for (let C = t.length - 1; C >= 0; C--) t[C]._update(T);
    _(T), H(T);
  }, debug: { ctx: h, gulls: d, hounds: v, wrecks: n, bolts: g, mats: u, tris: { gull: f.tris + f.extra.tris, hound: p.tris } } };
  return i.events.on("weapon:fire", (T) => {
    if (q > 0) return;
    q = 0.3;
    let D = T && (T.origin || T.muzzle) || i.player && i.player.pos;
    D && U.alert(D, ROBOT_TUNE.hearRadius);
  }), i.events.on("explosion", (T) => {
    T && T.pos && U.alert(T.pos, 30);
  }), i.events.on("game:state", (T) => {
    T && T.state === "title" && U.clear();
  }), U;
}
var o0 = new THREE.Vector3(), r0 = new THREE.Vector3(), a0 = new THREE.Vector3();
function segmentSegmentDistSq(i, e, t, n) {
  o0.copy(e).sub(i), r0.copy(n).sub(t), a0.copy(i).sub(t);
  let s = o0.dot(o0), o = r0.dot(r0), r = r0.dot(a0), a, l;
  if (s <= 1e-9 && o <= 1e-9) return a0.dot(a0);
  if (s <= 1e-9) a = 0, l = Math.min(1, Math.max(0, r / o));
  else {
    let f = o0.dot(a0);
    if (o <= 1e-9) l = 0, a = Math.min(1, Math.max(0, -f / s));
    else {
      let p = o0.dot(r0), d = s * o - p * p;
      a = d > 1e-9 ? Math.min(1, Math.max(0, (p * r - f * o) / d)) : 0, l = (p * a + r) / o, l < 0 ? (l = 0, a = Math.min(1, Math.max(0, -f / s))) : l > 1 && (l = 1, a = Math.min(1, Math.max(0, (p - f) / s)));
    }
  }
  let c = a0.x + o0.x * a - r0.x * l, u = a0.y + o0.y * a - r0.y * l, h = a0.z + o0.z * a - r0.z * l;
  return c * c + u * u + h * h;
}

export { createRobotFleet, ROBOT_TUNE, buildGullRig, buildHoundRig };
