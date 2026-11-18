// PAC-9 Longshore first-person viewmodel, ported from Saltline.
//
// This file was produced by
//   node tools/saltline/extract.mjs dm --stop sa --rename tools/saltline/maps/pac9.json
// and adapted for the game's controllers and shared first-person glove rig.
// The procedural weapon geometry and micro-detail shader retain their original
// generated local names.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { buildHand, SHARED_LENS_SUN, SHARED_LENS_SKY } from './viewmodel-kit.js';

// Scene light the red-dot glass reflects: bound to the shared live-updated
// planetary sun & sky vectors in viewmodel-kit.js (L-7).
export const LENS_SUN = SHARED_LENS_SUN;
export const LENS_SKY = SHARED_LENS_SKY;
var clamp = (i, e, t) => Math.min(t, Math.max(e, i)), lerp = (i, e, t) => i + (e - i) * t, saturate = (i) => Math.min(1, Math.max(0, i)), smoothstep = (i, e, t) => {
  let n = saturate((t - i) / (e - i));
  return n * n * (3 - 2 * n);
}, damp = (i, e, t, n) => e + (i - e) * Math.exp(-t * n);
var tmpRoundBoxVec = new THREE.Vector3();
function roundedBox(i, e, t, n = 0.02, s = "center") {
  n = Math.min(n, i / 2 - 1e-4, e / 2 - 1e-4, t / 2 - 1e-4);
  let o = new THREE.BoxGeometry(i, e, t, 3, 3, 3), r = o.attributes.position, a = o.attributes.normal, l = o.attributes.uv, c = i / 2, u = e / 2, h = t / 2, f = (p, d) => {
    let v = Math.abs(p), g = Math.sign(p);
    return v > d - 1e-5 ? g * d : g * (d - n);
  };
  for (let p = 0; p < r.count; p++) {
    let d = f(r.getX(p), c), v = f(r.getY(p), u), g = f(r.getZ(p), h), x = Math.max(-(c - n), Math.min(c - n, d)), y = Math.max(-(u - n), Math.min(u - n, v)), b = Math.max(-(h - n), Math.min(h - n, g));
    if (tmpRoundBoxVec.set(d - x, v - y, g - b), tmpRoundBoxVec.lengthSq() > 1e-10) {
      tmpRoundBoxVec.normalize();
      let M = a.getX(p), E = a.getY(p), w = a.getZ(p);
      (Math.abs(d) > c - 1e-5 ? 1 : 0) + (Math.abs(v) > u - 1e-5 ? 1 : 0) + (Math.abs(g) > h - 1e-5 ? 1 : 0) >= 2 ? (d = x + tmpRoundBoxVec.x * n, v = y + tmpRoundBoxVec.y * n, g = b + tmpRoundBoxVec.z * n, a.setXYZ(p, tmpRoundBoxVec.x, tmpRoundBoxVec.y, tmpRoundBoxVec.z)) : a.setXYZ(p, M, E, w);
    }
    r.setXYZ(p, d, v, g);
    let m = Math.abs(a.getX(p)), A = Math.abs(a.getY(p)), _ = Math.abs(a.getZ(p));
    m >= A && m >= _ ? l.setXY(p, g, v) : A >= m && A >= _ ? l.setXY(p, d, g) : l.setXY(p, d, v);
  }
  return s === "bottom" && o.translate(0, e / 2, 0), o;
}
function tubeAlong(i, e = 0.03, t = 8, n = false, s = 0) {
  let o = i.map((h) => h.isVector3 ? h : new THREE.Vector3(h[0], h[1], h[2])), r = new THREE.CatmullRomCurve3(o, n, "catmullrom", s), a = r.getLength(), l = Math.max(2, Math.ceil(a / Math.max(0.08, e * 3))), c = new THREE.TubeGeometry(r, Math.min(l, 400), e, t, n), u = c.attributes.uv;
  for (let h = 0; h < u.count; h++) u.setXY(h, u.getX(h) * a, u.getY(h) * Math.PI * 2 * e);
  return c;
}
function mergeColored(i) {
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
  return mergeGeometries(r, false) || new THREE.BufferGeometry();
}
var hash3 = (i, e, t) => {
  let n = Math.sin(i * 12.9898 + e * 78.233 + t * 37.719) * 43758.5453;
  return n - Math.floor(n);
}, isBoxFace = (i, e, t) => Math.max(Math.abs(i), Math.abs(e), Math.abs(t)) < 0.95, isExtrudeSide = (i, e, t) => {
  let n = Math.abs(t);
  return n > 0.15 && n < 0.95;
};
function paintVertexColors(i, e, t = 0, n = null) {
  let s = i.attributes.position, o = i.attributes.normal, r = s.count, a = new Float32Array(r * 3);
  for (let l = 0; l < r; l++) {
    let c = s.getX(l), u = s.getY(l), h = s.getZ(l), f = 0.9 + 0.2 * hash3(Math.round(c * 70), Math.round(u * 70), Math.round(h * 70));
    if (t > 0 && n && n(o.getX(l), o.getY(l), o.getZ(l))) {
      let p = hash3(Math.round(c * 300), Math.round(u * 300), Math.round(h * 300));
      {
        let d = Math.max(0, p - 0.84) / 0.16;
        f *= 1 + t * 1.6 * d * d;
      }
    }
    a[l * 3] = e[0] * f, a[l * 3 + 1] = e[1] * f, a[l * 3 + 2] = e[2] * f;
  }
  return i.setAttribute("color", new THREE.BufferAttribute(a, 3)), i;
}
var tmpEuler = new THREE.Euler(), tmpRotMatrix = new THREE.Matrix4();
function colorBox(i, e, t, n, s, o, r, a, l = 0, c = null) {
  let u = roundedBox(i, e, t, n);
  return paintVertexColors(u, a, l, isBoxFace), c && (tmpEuler.set(c[0], c[1], c[2]), u.applyMatrix4(tmpRotMatrix.makeRotationFromEuler(tmpEuler))), u.translate(s, o, -r), u;
}
function outlineShape(i, e) {
  let t = new THREE.Shape();
  if (i.forEach((n, s) => s ? t.lineTo(n[0], n[1]) : t.moveTo(n[0], n[1])), t.closePath(), e) for (let n of e) t.holes.push(new THREE.Path(n.map((s) => new THREE.Vector2(s[0], s[1]))));
  return t;
}
function extrudeOutline(i, e, t, n) {
  return new THREE.ExtrudeGeometry(outlineShape(i, n), { depth: Math.max(1e-4, e - 2 * t), bevelEnabled: t > 0, bevelThickness: t, bevelSize: t, bevelOffset: -t, bevelSegments: 1, steps: 1, curveSegments: 6 });
}
function fixExtrudeNormals(i) {
  i.computeBoundingBox();
  let e = i.boundingBox.min.z, t = i.boundingBox.max.z, n = i.attributes.position, s = i.attributes.normal;
  for (let o = 0; o < n.count; o++) {
    let r = s.getZ(o), a = Math.abs(r);
    if (a < 0.15 || a > 0.95) continue;
    let l = n.getZ(o);
    if (Math.abs(l - e) < 1e-6 || Math.abs(l - t) < 1e-6) s.setXYZ(o, 0, 0, Math.sign(r));
    else {
      let c = Math.hypot(s.getX(o), s.getY(o)) || 1;
      s.setXYZ(o, s.getX(o) / c, s.getY(o) / c, 0);
    }
  }
  return i;
}
function extrudeSideProfile(i, e, t, n, s, o = 0, r = null) {
  let a = extrudeOutline(i, t - e, n, r);
  return paintVertexColors(a, s, o, isExtrudeSide), fixExtrudeNormals(a), a.translate(0, 0, e + n), a.rotateY(Math.PI / 2), a;
}
function extrudeLengthProfile(i, e, t, n, s, o = 0, r = null) {
  let a = extrudeOutline(i, t - e, n, r);
  return paintVertexColors(a, s, o, isExtrudeSide), fixExtrudeNormals(a), a.translate(0, 0, -t + n), a;
}
function lathe(i, e, t, n = 0, s = 0, o = 0, r = null) {
  let a = [], l = [], c = [], u = [], h = 0;
  for (let p = 0; p < i.length - 1; p++) {
    let [d, v] = i[p], [g, x] = i[p + 1], y = g - d, b = x - v, m = Math.hypot(y, b);
    if (m < 1e-7) continue;
    let A = b / m, _ = -y / m, M = Math.abs(A) > 0.25 && Math.abs(_) > 0.25;
    for (let E = 0; E <= e; E++) {
      let w = E / e * Math.PI * 2, S = Math.cos(w), z = Math.sin(w);
      for (let H = 0; H < 2; H++) {
        let O = H ? g : d, q = H ? x : v, U = s + O * S, T = o + O * z, D = -q;
        a.push(U, T, D), l.push(A * S, A * z, -_);
        let C = 0.9 + 0.2 * hash3(Math.round(q * 150), Math.round(w * 3), p);
        if (M && n > 0) {
          let j = hash3(E * 7.1, p * 3.3, q * 100);
          {
            let N = Math.max(0, j - 0.84) / 0.16;
            C *= 1 + n * 1.6 * N * N;
          }
        }
        let G = r ? r(O, q, t) : t;
        c.push(G[0] * C, G[1] * C, G[2] * C);
      }
    }
    for (let E = 0; E < e; E++) {
      let w = h + E * 2, S = w + 2, z = w + 1, H = w + 3;
      u.push(w, z, S, S, z, H);
    }
    h += (e + 1) * 2;
  }
  let f = new THREE.BufferGeometry();
  return f.setAttribute("position", new THREE.Float32BufferAttribute(a, 3)), f.setAttribute("normal", new THREE.Float32BufferAttribute(l, 3)), f.setAttribute("color", new THREE.Float32BufferAttribute(c, 3)), f.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(a.length / 3 * 2), 2)), f.setIndex(u), f;
}
function latheBar(i, e, t, n, s, o, r = 12, a = 0) {
  let l = Math.min(i * 0.25, e * 0.25), c = e / 2, u = lathe([[0, -c], [i - l, -c], [i, -c + l], [i, c - l], [i - l, c], [0, c]], r, o, a);
  return u.rotateY(Math.PI / 2), u.translate(t, n, -s), u;
}
function stadiumPath(i, e, t, n, s = 4) {
  let o = [], r = n / 2, a = t / 2 - r;
  for (let l = 0; l <= s; l++) {
    let c = -Math.PI / 2 + l / s * Math.PI;
    o.push([i + a + Math.cos(c) * r, e + Math.sin(c) * r]);
  }
  for (let l = 0; l <= s; l++) {
    let c = Math.PI / 2 + l / s * Math.PI;
    o.push([i - a + Math.cos(c) * r, e + Math.sin(c) * r]);
  }
  return o;
}
var chamferRect = (i, e, t, n, s) => [[i + s, e], [t - s, e], [t, e + s], [t, n - s], [t - s, n], [i + s, n], [i, n - s], [i, e + s]], PAC9 = { name: "PAC-9 Longshore", muzzle: [0, 0, -0.531], eject: [0.023, 4e-3, -0.028], sightY: 0.069, lensF: 0.0285, window: [[-0.016, 0.057], [0.016, 0.057], [0.016, 0.0772], [0.0122, 0.081], [-0.0122, 0.081], [-0.016, 0.0772]], magPos: [0, -0.02, -0.0665], boltTravel: 0.062, railTop: 0.0435, grip: [0, -0.1, 0.073], handguard: [0, 0, -0.255], handguardR: 0.021, handlePos: [-0.026, 7e-3, -0.078], squeeze: 0.86 };
function buildPac9Geometry() {
  let i = [1, 1, 1], e = [1, 1, 1], t = [5.5, 5.5, 5.7], n = [0.4, 0.4, 0.42], s = [1, 1, 1], o = [0.022, 0.022, 0.023], r = [], a = [], l = [], c = [], u = [], h = [], f = [], p = 9, d = 5, v = 0.6, g = [[-0.1, -0.02], [0.1, -0.02], [0.1, 0.027], [0.093, 0.034], [-0.088, 0.034], [-0.1, 0.024]];
  r.push(extrudeSideProfile(g, 0, 0.0205, 14e-4, i, p, [chamferRect(-0.012, -0.01, 0.06, 0.012, 3e-3)])), r.push(extrudeSideProfile(g, -0.0205, 0, 14e-4, i, p, [stadiumPath(0.032, 7e-3, 0.112, 75e-4, 4)])), a.push(colorBox(4e-3, 0.036, 0.19, 5e-4, -0.0135, 6e-3, 0, n)), a.push(colorBox(4e-3, 0.012, 0.19, 5e-4, 0.0145, 0.022, 0, n)), a.push(colorBox(4e-3, 8e-3, 0.19, 5e-4, 0.0145, -0.014, 0, n)), a.push(lathe([[0, 0.058], [0.0128, 0.058], [0.0128, 0.099], [0, 0.099]], 16, [0.8, 0.8, 0.82])), r.push(colorBox(9e-3, 0.02, 0.018, 3e-3, 0.0225, 4e-3, -0.026, i, p, [0, -0.35, 0])), r.push(lathe([[0, -0.086], [62e-4, -0.086], [72e-4, -0.084], [72e-4, -0.06], [45e-4, -0.057], [0, -0.057]], 12, i, p, 0.0215, 0.012)), a.push(lathe([[0, -0.094], [48e-4, -0.094], [55e-4, -0.092], [55e-4, -0.086], [0, -0.086]], 12, t, 0, 0.0215, 0.012)), r.push(colorBox(4e-3, 0.012, 0.05, 15e-4, -0.0212, -6e-3, -0.055, i, p)), r.push(colorBox(4e-3, 6e-3, 0.15, 15e-4, -0.0212, 0.0215, 0.012, i, p)), r.push(colorBox(3e-3, 0.01, 0.03, 1e-3, 0.0212, 0.022, 0.075, i, p)), r.push(extrudeLengthProfile([[-78e-4, 0.0335], [78e-4, 0.0335], [0.0106, 0.0402], [-0.0106, 0.0402]], -0.096, 0.397, 5e-4, i, 0));
  let x = [[-0.0102, 0.0398], [0.0102, 0.0398], [0.0106, 0.0408], [84e-4, 0.0435], [-84e-4, 0.0435], [-0.0106, 0.0408]];
  for (let F = 0; F < 49; F++) {
    let X = -0.094 + F * 0.01;
    r.push(extrudeLengthProfile(x, X, X + 48e-4, 8e-4, i, p));
  }
  let y = [[-0.1, -0.021], [0.099, -0.021], [0.101, -0.03], [0.098, -0.088], [0.036, -0.082], [0.031, -0.058], [-0.03, -0.058], [-0.04, -0.066], [-0.078, -0.055], [-0.1, -0.044]];
  l.push(extrudeSideProfile(y, -0.019, 0.019, 14e-4, s, v)), l.push(colorBox(0.043, 0.01, 0.066, 2e-3, 0, -0.0835, 0.0668, s, v, [-0.095, 0, 0])), l.push(colorBox(0.0405, 0.052, 5e-3, 8e-4, 0, -0.052, 0.0975, s, v)), l.push(colorBox(0.0405, 0.04, 5e-3, 8e-4, 0, -0.048, 0.0345, s, v)), a.push(latheBar(38e-4, 0.0396, 0, -0.031, -0.086, t, 12)), a.push(latheBar(38e-4, 0.0396, 0, -0.029, 0.087, t, 12)), a.push(latheBar(22e-4, 0.0392, 0, -0.04, -0.012, t, 8)), a.push(latheBar(22e-4, 0.0392, 0, -0.032, -0.032, t, 8));
  for (let F of [-1, 1]) a.push(latheBar(68e-4, 4e-3, F * 0.0205, -0.036, -0.048, e, 14, d)), a.push(colorBox(4e-3, 6e-3, 0.024, 15e-4, F * 0.0228, -0.036, -0.036, e, d, [0.5, 0, 0]));
  a.push(colorBox(45e-4, 0.024, 0.013, 15e-4, -0.0212, -0.03, 0.022, e, d));
  for (let F = 0; F < 4; F++) a.push(colorBox(12e-4, 2e-3, 0.012, 5e-4, -0.0238, -0.021 - F * 45e-4, 0.022, e, d));
  a.push(latheBar(58e-4, 5e-3, 0.0205, -0.042, 0.016, e, 12, d)), l.push(colorBox(4e-3, 4e-3, 0.026, 8e-4, 0.0205, -0.051, 0.016, s, v)), l.push(colorBox(4e-3, 0.02, 4e-3, 8e-4, 0.0205, -0.043, 0.027, s, v)), l.push(extrudeSideProfile([[0.033, -0.056], [0.033, -0.093], [0.024, -0.1005], [-0.031, -0.1005], [-0.041, -0.09], [-0.041, -0.06]], -85e-4, 85e-4, 8e-4, s, v, [[[0.028, -0.059], [0.028, -0.091], [0.022, -0.096], [-0.029, -0.096], [-0.036, -0.088], [-0.036, -0.061]]])), a.push(extrudeSideProfile([[-6e-3, -0.057], [4e-3, -0.057], [3e-3, -0.069], [65e-4, -0.079], [0.01, -0.086], [65e-4, -0.088], [1e-3, -0.081], [-4e-3, -0.07]], -32e-4, 32e-4, 8e-4, t, 0)), l.push(extrudeSideProfile([[-0.038, -0.05], [-0.045, -0.074], [-0.049, -0.086], [-0.049, -0.1], [-0.054, -0.112], [-0.057, -0.13], [-0.064, -0.158], [-0.11, -0.152], [-0.102, -0.112], [-0.096, -0.082], [-0.095, -0.064], [-0.103, -0.046], [-0.08, -0.044]], -0.0165, 0.0165, 5e-3, s, v));
  for (let F = 0; F < 9; F++) {
    let X = -0.078 - F * 82e-4, ne = -0.073 + (X + 0.078) * 0.26;
    l.push(colorBox(0.0345, 28e-4, 0.03, 1e-3, 0, X, ne, s, v, [-0.25, 0, 0]));
  }
  for (let F = 0; F < 7; F++) {
    let X = -0.078 - F * 0.01, ne = -0.098 + (X + 0.078) * 0.14;
    l.push(colorBox(0.022, 45e-4, 6e-3, 15e-4, 0, X, ne, s, v, [-0.14, 0, 0]));
  }
  l.push(colorBox(0.035, 6e-3, 0.05, 2e-3, 0, -0.157, -0.087, s, v, [0.13, 0, 0])), a.push(latheBar(3e-3, 0.034, 0, -0.15, -0.085, t, 8));
  let b = PAC9.handguardR, m = 885e-5, A = 28e-4, _ = 0.101, M = 0.398, E = [[_, -m], [M, -m], [M, m], [_, m]];
  for (let F = 0; F < 8; F++) {
    let X = [];
    if (F === 0 || F === 4 || F === 6) for (let $ = 0; $ < 6; $++) X.push(stadiumPath(0.13 + $ * 0.047, 0, 0.032, 7e-3, 4));
    else if (F !== 2) for (let $ = 0; $ < 10; $++) {
      let ue = 0.124 + $ * 0.027;
      F === 3 && ue > 0.3 || X.push(stadiumPath(ue, 0, 0.013, 52e-4, 3));
    }
    let ne = extrudeSideProfile(E, b - A, b, 9e-4, i, p, X);
    ne.rotateZ(F * Math.PI / 4), r.push(ne);
    let re = (F + 0.5) * Math.PI / 4;
    r.push(lathe([[0, _], [3e-3, _], [3e-3, M], [0, M]], 8, i, 0, Math.cos(re) * 0.0197, Math.sin(re) * 0.0197));
  }
  r.push(extrudeLengthProfile([[-88e-4, 0.02], [88e-4, 0.02], [0.0106, 0.029], [82e-4, 0.0338], [-82e-4, 0.0338], [-0.0106, 0.029]], 0.1012, 0.3978, 12e-4, i, p)), r.push(lathe([[0.016, 0.096], [0.0238, 0.096], [0.0243, 0.0966], [0.0243, 0.106], [0.0232, 0.1075], [0.016, 0.1075]], 24, i, p)), r.push(lathe([[0.018, 0.3985], [0.0224, 0.3985], [0.0224, 0.4003], [0.0218, 0.401], [0.018, 0.401], [0.018, 0.3985]], 8, i, p));
  for (let F of [-1, 1]) for (let X of [0.112, 0.126]) a.push(latheBar(24e-4, 24e-4, F * 0.0212, -4e-3, X, t, 10));
  for (let F of [0.115, 0.215, 0.3, 0.385]) for (let X of [-1, 1]) a.push(lathe([[0, -8e-4], [17e-4, -8e-4], [2e-3, -4e-4], [2e-3, 6e-4], [0, 6e-4]], 8, t, 0, 0, 0).rotateX(Math.PI / 2).translate(X * 98e-4, 0.0312, -F));
  {
    let X = [extrudeLengthProfile([[-78e-4, 0.0206], [78e-4, 0.0206], [0.0106, 0.0242], [-0.0106, 0.0242]], 0.318, 0.396, 5e-4, i, 0)];
    for (let ne = 0; ne < 8; ne++) {
      let re = 0.319 + ne * 0.01;
      X.push(extrudeLengthProfile(x.map(($) => [$[0], $[1] - 0.016]), re, re + 48e-4, 5e-4, i, p));
    }
    for (let ne of X) ne.rotateZ(Math.PI / 4), r.push(ne);
  }
  {
    let F = [];
    for (let X = 0; X < 4; X++) {
      let ne = 0.352 + X * 0.01;
      F.push(extrudeLengthProfile(x.map((re) => [re[0], re[1] - 0.016]), ne, ne + 48e-4, 5e-4, i, p));
    }
    F.push(extrudeLengthProfile([[-78e-4, 0.0206], [78e-4, 0.0206], [0.0106, 0.0242], [-0.0106, 0.0242]], 0.35, 0.392, 5e-4, i, 0));
    for (let X of F) X.rotateZ(Math.PI), r.push(X);
  }
  l.push(extrudeSideProfile([[0.35, -0.026], [0.392, -0.026], [0.388, -0.036], [0.372, -0.05], [0.362, -0.05], [0.354, -0.036]], -0.011, 0.011, 3e-3, s, v)), l.push(extrudeSideProfile([[0.2395, -0.0215], [0.2725, -0.0215], [0.2725, -0.03], [0.27, -0.092], [0.2665, -0.0965], [0.2455, -0.0975], [0.242, -0.093], [0.2395, -0.03]], -0.014, 0.014, 45e-4, s, v));
  for (let F = 0; F < 6; F++) l.push(colorBox(0.0292, 22e-4, 0.0315, 8e-4, 0, -0.04 - F * 85e-4, 0.256 - F * 3e-4, s, v));
  l.push(colorBox(0.03, 5e-3, 0.04, 15e-4, 0, -0.024, 0.256, s, v)), a.push(latheBar(3e-3, 0.031, 0, -0.025, 0.256, t, 10)), a.push(lathe([[0.0115, 0.095], [0.0115, 0.15], [95e-4, 0.153], [95e-4, 0.285], [9e-3, 0.288], [9e-3, 0.322], [86e-4, 0.326], [86e-4, 0.435], [92e-4, 0.437], [92e-4, 0.453], [75e-4, 0.455], [75e-4, 0.461]], 20, e, d)), a.push(lathe([[92e-4, 0.286], [0.0135, 0.286], [0.0142, 0.2875], [0.0142, 0.3165], [0.0135, 0.318], [92e-4, 0.318]], 16, e, d)), a.push(colorBox(0.014, 9e-3, 0.03, 2e-3, 0, 0.0145, 0.302, e, d)), a.push(lathe([[0, 0.1], [26e-4, 0.1], [26e-4, 0.3], [0, 0.3]], 8, t, 0, 0, 0.0172)), a.push(latheBar(2e-3, 0.0145, 0, 0.012, 0.308, t, 6)), a.push(lathe([[75e-4, 0.459], [0.0108, 0.459], [0.0116, 0.4605], [0.0116, 0.477], [0.011, 0.478], [52e-4, 0.478]], 20, e, d)), a.push(lathe([[52e-4, 0.477], [52e-4, 0.517]], 12, n));
  for (let F of [0.4865, 0.4965, 0.5065]) a.push(lathe([[52e-4, F - 19e-4], [0.011, F - 19e-4], [0.0116, F - 12e-4], [0.0116, F + 12e-4], [0.011, F + 19e-4], [52e-4, F + 19e-4]], 20, e, d));
  a.push(lathe([[52e-4, 0.5145], [0.011, 0.5145], [0.0116, 0.5155], [0.0116, 0.527], [0.0102, 0.5305], [48e-4, 0.5305], [36e-4, 0.526], [36e-4, 0.495]], 20, e, d, 0, 0, (F, X, ne) => F < 47e-4 ? [0.25, 0.25, 0.25] : ne));
  for (let F of [-1, 1]) a.push(colorBox(0.0125, 42e-4, 0.042, 12e-4, 0, F * 96e-4, 0.496, e, d));
  for (let F = 0; F < 3; F++) a.push(latheBar(16e-4, 0.0236, 0, 0, 0.4675 + F * 35e-4, n, 6));
  r.push(lathe([[0, -0.292], [0.0142, -0.292], [0.0148, -0.2905], [0.0148, -0.1]], 20, i, p)), r.push(lathe([[0.0148, -0.122], [0.0185, -0.122], [0.0195, -0.1205], [0.0195, -0.1115], [0.0185, -0.11], [0.0148, -0.11]], 12, i, p * 1.5));
  {
    let F = [[-0.019, -0.024], [0.019, -0.024], [0.021, -0.018], [0.021, 0.018], [0.016, 0.024], [-0.016, 0.024], [-0.021, 0.018], [-0.021, 6e-3], [-0.036, 4e-3], [-0.04, -2e-3], [-0.04, -0.014], [-0.034, -0.02], [-0.021, -0.02]], X = [[-0.025, -0.014], [-0.025, -2e-3], [-0.033, -5e-4], [-0.036, -4e-3], [-0.036, -0.012], [-0.032, -0.016]];
    a.push(extrudeLengthProfile(F, -0.1095, -0.1045, 8e-4, [1.6, 1.6, 1.65], d, [X]));
  }
  l.push(extrudeSideProfile([[-0.146, 0.024], [-0.3, 0.024], [-0.331, 0.014], [-0.334, -0.086], [-0.318, -0.101], [-0.29, -0.096], [-0.232, -0.04], [-0.146, -0.024]], -0.019, 0.019, 4e-3, s, v, [[[-0.262, -0.036], [-0.306, -0.036], [-0.306, -0.074], [-0.292, -0.074]]])), l.push(colorBox(0.033, 0.016, 0.118, 6e-3, 0, 0.031, -0.232, s, v));
  for (let F of [-0.196, -0.268]) a.push(latheBar(32e-4, 0.035, 0, 0.03, F, t, 8));
  l.push(colorBox(0.012, 0.012, 0.04, 3e-3, 0, -0.033, -0.19, s, v, [0.2, 0, 0])), f.push(colorBox(0.037, 0.12, 0.011, 4e-3, 0, -0.04, -0.3395, o, 0));
  for (let F = 0; F < 9; F++) f.push(colorBox(0.031, 4e-3, 3e-3, 1e-3, 0, 4e-3 - F * 0.011, -0.3455, o, 0));
  for (let F of [-1, 1]) a.push(latheBar(65e-4, 3e-3, F * 0.0195, -0.06, -0.318, t, 12));
  let w = PAC9.sightY, S = PAC9.window, z = [0.012, 0.012, 0.013];
  r.push(colorBox(0.03, 92e-4, 0.04, 16e-4, 0, 0.048, 0.021, i, p)), r.push(colorBox(45e-4, 85e-4, 0.034, 1e-3, -0.0162, 0.0452, 0.021, i, p));
  for (let F of [9e-3, 0.033]) a.push(latheBar(4e-3, 42e-4, -0.02, 0.0452, F, t, 6)), a.push(latheBar(3e-3, 22e-4, 0.016, 0.0452, F, t, 10));
  let H = [[-0.0192, 0.0525], [0.0192, 0.0525], [0.0192, 0.0788], [0.0138, 0.0842], [-0.0138, 0.0842], [-0.0192, 0.0788]];
  r.push(extrudeLengthProfile(H, 8e-3, 0.034, 1e-3, i, p, [S])), f.push(extrudeLengthProfile(S.map((F) => [F[0] * 1.004, (F[1] - w) * 1.004 + w]), 78e-4, 0.0342, 0, z, 0, [S.map((F) => [F[0] * 0.982, (F[1] - w) * 0.982 + w])]));
  let O = [[-0.0204, 0.06], [-0.0204, 0.0792], [-0.0143, 0.0854], [0.0143, 0.0854], [0.0204, 0.0792], [0.0204, 0.06], [0.0193, 0.06], [0.0193, 0.0788], [0.0138, 0.0843], [-0.0138, 0.0843], [-0.0193, 0.0788], [-0.0193, 0.06]];
  r.push(extrudeLengthProfile(O, 0.029, 0.038, 3e-4, i, p)), a.push(lathe([[0, -6e-3], [52e-4, -6e-3], [58e-4, -54e-4], [58e-4, 36e-4], [52e-4, 42e-4], [0, 42e-4]], 14, e, d, 0, 0).rotateY(Math.PI / 2).translate(0.0222, 0.0625, -0.021));
  for (let F of [0.0165, 0.0245]) f.push(colorBox(22e-4, 55e-4, 55e-4, 9e-4, -0.0196, 0.064, F, o, 0));
  for (let F of [0.012, 0.03]) for (let X of [-1, 1]) a.push(latheBar(16e-4, 12e-4, X * 0.0195, 0.0555, F, t, 8));
  f.push(colorBox(9e-3, 26e-4, 6e-3, 6e-4, 0, 0.058, 0.0115, z));
  for (let [F, X] of [[0.0128, 0.0548], [-0.0128, 0.0548]]) a.push(lathe([[0, -6e-4], [19e-4, -6e-4], [22e-4, -2e-4], [22e-4, 7e-4], [0, 7e-4]], 10, t, 0, F, X).translate(0, 0, -8e-3 + 1e-4).rotateY(0));
  a.push(lathe([[0, -1e-3], [26e-4, -1e-3], [3e-3, -5e-4], [3e-3, 12e-4], [0, 12e-4]], 12, t, 0, 0, 0).rotateX(Math.PI / 2).translate(9e-3, 0.0842, -0.014)), f.push(colorBox(12e-4, 2e-4, 44e-4, 5e-5, 9e-3, 0.0855, 0.014, z)), f.push(extrudeLengthProfile(S, 0.0304, 0.0318, 0, z, 0, [S.map((F) => [F[0] * 0.955, (F[1] - w) * 0.955 + w])]));
  for (let [F, X] of [[-0.03, 1], [0.372, -1]]) a.push(colorBox(0.021, 75e-4, 0.03, 15e-4, 0, 0.0472, F, e, d)), a.push(colorBox(0.0125, 4e-3, 0.036, 1e-3, 0, 0.0527, F + X * 4e-3, e, d)), a.push(latheBar(28e-4, 0.024, 0, 0.0505, F - X * 0.013, e, 8)), a.push(colorBox(4e-3, 6e-3, 6e-3, 1e-3, X * 0.0125, 0.0475, F, e, d)), a.push(latheBar(42e-4, 45e-4, -0.0125, 0.0475, F + 6e-3, t, 8));
  a.push(lathe([[16e-4, -12e-4], [34e-4, -12e-4], [38e-4, -8e-4], [38e-4, 8e-4], [34e-4, 12e-4], [16e-4, 12e-4], [16e-4, -12e-4]], 12, e, d, 0, 0).rotateX(Math.PI / 2).translate(0, 0.0553, 0.016)), a.push(latheBar(48e-4, 5e-3, 0.015, 0.049, -0.036, e, 12, d));
  for (let F = 0; F < 6; F++) a.push(colorBox(44e-4, 1e-3, 1e-3, 3e-4, 0.015, 0.049 + Math.sin(F * 1.047) * 46e-4, -0.036 + Math.cos(F * 1.047) * 46e-4, e, d));
  r.push(colorBox(0.016, 5e-3, 0.02, 12e-4, 0, 0.0355, -0.098, i, p)), a.push(colorBox(0.01, 3e-3, 8e-3, 8e-4, 0, 0.0392, -0.0985, e, d));
  for (let F = 0; F < 4; F++) a.push(colorBox(92e-4, 8e-4, 1e-3, 3e-4, 0, 0.0409, -0.0958 - F * 18e-4, e, d));
  let q = -0.0267, U = 0.0267;
  a.push(lathe([[0, 0.308], [95e-4, 0.308], [0.0108, 0.3095], [0.0108, 0.322], [0.0118, 0.323], [0.0118, 0.378], [0.0128, 0.38], [0.0142, 0.382], [0.0142, 0.404], [0.0136, 0.406], [0.0142, 0.408], [0.0142, 0.412], [0.0128, 0.4135], [0.0118, 0.4135], [0.0112, 0.409]], 18, e, d, q, U)), a.push(lathe([[0.0112, 0.409], [0, 0.409]], 18, [0.35, 0.4, 0.45], 0, q, U));
  for (let F = 0; F < 5; F++) a.push(lathe([[0.0118, 0.33 + F * 8e-3], [0.0124, 0.3305 + F * 8e-3], [0.0124, 0.3335 + F * 8e-3], [0.0118, 0.334 + F * 8e-3]], 18, e, d, q, U));
  {
    let F = colorBox(0.02, 8e-3, 0.04, 12e-4, 0, 0.028, 0.352, e, d);
    F.rotateZ(Math.PI / 4), a.push(F);
  }
  {
    let F = latheBar(4e-3, 6e-3, 0.0135, 0.028, 0.352, t, 8);
    F.rotateZ(Math.PI / 4), a.push(F);
  }
  f.push(colorBox(0.0185, 65e-4, 0.07, 25e-4, 0, 0.0468, 0.214, o, 0));
  for (let F = 0; F < 6; F++) f.push(colorBox(0.014, 12e-4, 4e-3, 5e-4, 0, 0.0503, 0.192 + F * 9e-3, o, 0));
  let T = tubeAlong([[q, U, -0.308], [q - 1e-3, U + 2e-3, -0.296], [-0.0265, 0.0235, -0.284], [-0.0255, 0.0215, -0.272], [-0.0235, 0.027, -0.262], [-0.016, 0.04, -0.256], [-7e-3, 0.0465, -0.252], [-2e-3, 0.047, -0.247]], 18e-4, 6);
  paintVertexColors(T, o, 0), f.push(T);
  for (let F of [[-0.0262, 0.0228, 0.28], [-0.0242, 0.0255, 0.265]]) {
    let X = colorBox(65e-4, 26e-4, 35e-4, 8e-4, 0, 0, 0, [0.03, 0.03, 0.03], 0);
    X.rotateZ(Math.PI / 4), X.translate(F[0], F[1], -F[2]), f.push(X);
  }
  c.push(lathe([[0, -0.058], [0.0118, -0.058], [0.0124, -0.057], [0.0124, -0.01], [0.0116, -8e-3], [0.0116, -2e-3], [0.0124, 0], [0.0124, 0.046], [0.0105, 0.048], [0.0105, 0.056], [62e-4, 0.056], [62e-4, 0.06], [0, 0.06]], 16, [7, 7, 7.2], 0, 0, 1e-3));
  for (let F = 0; F < 5; F++) c.push(colorBox(15e-4, 8e-3, 3e-3, 5e-4, 0.0122, 1e-3, 0.01 + F * 7e-3, [1.2, 1.2, 1.2], 0));
  c.push(colorBox(0.012, 55e-4, 0.014, 15e-4, -0.0165, 7e-3, 0.078, e, d));
  {
    let F = lathe([[0, -9e-3], [45e-4, -9e-3], [56e-4, -78e-4], [56e-4, -3e-3], [48e-4, -2e-3], [48e-4, 2e-3], [56e-4, 3e-3], [56e-4, 78e-4], [45e-4, 9e-3], [0, 9e-3]], 12, e, d);
    F.rotateY(Math.PI / 2), F.translate(-0.031, 7e-3, -0.078), c.push(F);
  }
  let D = (F) => 1.5 * Math.pow(Math.max(0, F - 0.07), 2), C = (F) => 3 * Math.max(0, F - 0.07), G = [1, 1, 1], j = [], N = 0.212, Q = 12;
  for (let F = 0; F <= Q; F++) {
    let X = -4e-3 + (N + 4e-3) * F / Q;
    j.push([D(X) + 0.0298, -X]);
  }
  for (let F = Q; F >= 0; F--) {
    let X = -4e-3 + (N + 4e-3) * F / Q;
    j.push([D(X) - 0.0298, -X]);
  }
  u.push(extrudeSideProfile(j, -0.0113, 0.0113, 2e-3, G, 0.25));
  for (let F = 0; F < 8; F++) {
    let X = 0.082 + F * 0.0155;
    u.push(colorBox(0.0246, 58e-4, 0.05, 16e-4, 0, -X, D(X), G, 0.3, [Math.atan(C(X)), 0, 0]));
  }
  for (let F = 0; F < 10; F++) {
    let X = 0.078 + F * 0.013;
    u.push(colorBox(0.012, 0.011, 4e-3, 1e-3, 0, -X, D(X) + 0.0302, G, 0.3, [Math.atan(C(X)), 0, 0]));
  }
  u.push(colorBox(0.027, 9e-3, 0.068, 3e-3, 0, -N - 3e-3, D(N) + 1e-3, G, 0.3, [Math.atan(C(N)), 0, 0])), u.push(colorBox(0.01, 4e-3, 0.012, 1e-3, 0, -N - 8e-3, D(N) - 0.01, [0.6, 0.6, 0.6], 0, [Math.atan(C(N)), 0, 0])), u.push(colorBox(3e-3, 6e-3, 0.04, 1e-3, -85e-4, 45e-4, 4e-3, G, 0.3)), u.push(colorBox(3e-3, 6e-3, 0.04, 1e-3, 85e-4, 45e-4, 4e-3, G, 0.3));
  let K = [1.25, 0.72, 0.5];
  h.push(lathe([[0, -0.02], [4e-3, -0.02], [47e-4, -0.019], [47e-4, 0.01], [34e-4, 0.014], [34e-4, 0.018]], 12, [1, 1, 1], 0, 2e-3, 62e-4)), h.push(lathe([[3e-3, 0.018], [29e-4, 0.024], [22e-4, 0.03], [1e-3, 0.0345], [0, 0.0352]], 12, K, 0, 2e-3, 62e-4)), h.push(lathe([[0, -0.02], [4e-3, -0.02], [47e-4, -0.019], [47e-4, 0.01]], 10, [0.8, 0.8, 0.8], 0, -3e-3, 5e-4));
  let ie = { ano: mergeColored(r), gun: mergeColored(a), poly: mergeColored(l), plain: mergeColored(f), bolt: mergeColored(c), mag: mergeColored(u), round: mergeColored(h) };
  for (let F of ["ano", "gun", "poly", "plain", "bolt"]) {
    let X = ie[F].attributes.position;
    for (let ne = 0; ne < X.count; ne++) X.getZ(ne) > -0.1002 && X.getY(ne) < 0.0341 && X.setX(ne, X.getX(ne) * PAC9.squeeze);
  }
  for (let F in ie) ie[F].computeBoundingSphere();
  return ie;
}
var triangleCount = (i) => (i.index ? i.index.count : i.attributes.position.count) / 3;
var MARKING_ATLAS = { model: [8, 8, 330, 84], maker: [8, 100, 560, 40], cal: [8, 146, 560, 40], prop: [8, 192, 700, 40], safe: [8, 240, 90, 34], semi: [110, 240, 90, 34], auto: [212, 240, 90, 34], rack: [8, 290, 300, 110], warn: [330, 290, 420, 110], optic: [580, 8, 300, 60], light: [580, 76, 300, 60], dots: [320, 240, 60, 34], r2: [8, 420, 56, 40], r4: [72, 420, 56, 40], r6: [136, 420, 56, 40], r8: [200, 420, 56, 40], r10: [264, 420, 56, 40], r12: [328, 420, 56, 40] }, MARKING_ATLAS_W = 1024, MARKING_ATLAS_H = 512;
function drawMarkingAtlas() {
  let i = document.createElement("canvas");
  i.width = MARKING_ATLAS_W, i.height = MARKING_ATLAS_H;
  let e = i.getContext("2d");
  e.clearRect(0, 0, MARKING_ATLAS_W, MARKING_ATLAS_H), e.textBaseline = "middle";
  let t = (u, h, f, p, d = "left") => {
    let [v, g, x, y] = MARKING_ATLAS[u];
    e.font = f, e.fillStyle = p, e.textAlign = d, e.fillText(h, d === "left" ? v + 2 : v + x / 2, g + y / 2 + 1, x - 4);
  }, n = '"Barlow Condensed", "Arial Narrow", Arial, sans-serif', s = '"IBM Plex Mono", "Courier New", monospace', o = '"Big Shoulders Display", "Barlow Condensed", Impact, sans-serif', r = "rgba(196,198,194,0.92)";
  t("model", "PAC-9", `700 78px ${o}`, r), t("maker", "LONGSHORE ARMS WORKS  \xB7  SALTLINE", `600 30px ${n}`, r), t("cal", "CAL 5.8\xD740   SN PA-004217", `500 27px ${s}`, r), t("prop", "PROPERTY OF PORT AUTHORITY \u2014 BERTH 4 ARMOURY", `600 28px ${n}`, r), t("safe", "S", `700 30px ${n}`, r, "center"), t("semi", "1", `700 30px ${n}`, r, "center"), t("auto", "A", `700 30px ${n}`, "rgba(205,60,40,0.95)", "center"), t("rack", "B4-07", `800 104px ${o}`, "rgba(214,206,170,0.9)", "center");
  for (let u of [2, 4, 6, 8, 10, 12]) t("r" + u, "T" + u, `600 30px ${s}`, "rgba(190,192,188,0.85)", "center");
  t("optic", "HX-2 REFLEX", `700 44px ${n}`, r, "center"), t("light", "900 LM  IPX8", `600 40px ${n}`, r, "center");
  {
    let [u, h] = MARKING_ATLAS.warn;
    e.fillStyle = r, e.textAlign = "left", e.font = `600 24px ${n}`, ["WARNING \u2014 CLEAR CHAMBER BEFORE", "STOWAGE. AUTHORISED BREACH", "PERSONNEL ONLY. PA-REG 44/7"].forEach((f, p) => e.fillText(f, u + 2, h + 20 + p * 34));
  }
  {
    let [u, h, f, p] = MARKING_ATLAS.dots;
    e.fillStyle = r, e.beginPath(), e.arc(u + 12, h + p / 2, 7, 0, 7), e.fill(), e.fillStyle = "rgba(205,60,40,0.95)", e.beginPath(), e.arc(u + 40, h + p / 2, 7, 0, 7), e.fill();
  }
  e.globalCompositeOperation = "destination-out";
  let a = 7, l = () => (a = a * 16807 % 2147483647, a / 2147483647);
  for (let u = 0; u < 2600; u++) {
    e.fillStyle = `rgba(0,0,0,${0.25 + l() * 0.6})`;
    let h = l() < 0.9 ? 1 + l() * 1.5 : 2 + l() * 5;
    e.fillRect(l() * MARKING_ATLAS_W, l() * MARKING_ATLAS_H, h, h * (0.4 + l()));
  }
  let c = new THREE.CanvasTexture(i);
  return c.colorSpace = THREE.SRGBColorSpace, c.anisotropy = 8, c.generateMipmaps = true, c.minFilter = THREE.LinearMipmapLinearFilter, c;
}
function buildMarkings(i) {
  let e = [], t = [], n = [], s = [];
  for (let [l, c, u, h, f, p, d = 0] of i) {
    let [v, g, x, y] = MARKING_ATLAS[l], b = f * x / y, m = v / MARKING_ATLAS_W, A = (v + x) / MARKING_ATLAS_W, _ = 1 - g / MARKING_ATLAS_H, M = 1 - (g + y) / MARKING_ATLAS_H, E = e.length / 3, w;
    if (p === "L" ? w = [[c, u - f / 2, -(h + b / 2)], [c, u - f / 2, -(h - b / 2)], [c, u + f / 2, -(h - b / 2)], [c, u + f / 2, -(h + b / 2)]] : p === "R" ? w = [[c, u - f / 2, -(h - b / 2)], [c, u - f / 2, -(h + b / 2)], [c, u + f / 2, -(h + b / 2)], [c, u + f / 2, -(h - b / 2)]] : w = [[c - b / 2, u, -(h - f / 2)], [c + b / 2, u, -(h - f / 2)], [c + b / 2, u, -(h + f / 2)], [c - b / 2, u, -(h + f / 2)]], d) {
      let z = Math.cos(d), H = Math.sin(d), O = u, q = -h;
      for (let U of w) {
        let T = U[1] - O, D = U[2] - q;
        U[1] = O + T * z - D * H, U[2] = q + T * H + D * z;
      }
    }
    for (let z of w) e.push(z[0], z[1], z[2]);
    t.push(m, M, A, M, A, _, m, _);
    let S = p === "L" ? [-1, 0, 0] : p === "R" ? [1, 0, 0] : [0, 1, 0];
    for (let z = 0; z < 4; z++) n.push(S[0], S[1], S[2]);
    s.push(E, E + 1, E + 2, E, E + 2, E + 3);
  }
  let o = new THREE.BufferGeometry();
  o.setAttribute("position", new THREE.Float32BufferAttribute(e, 3)), o.setAttribute("uv", new THREE.Float32BufferAttribute(t, 2)), o.setAttribute("normal", new THREE.Float32BufferAttribute(n, 3)), o.setIndex(s);
  let r = new THREE.MeshStandardMaterial({ map: drawMarkingAtlas(), transparent: true, roughness: 0.62, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3, side: THREE.DoubleSide }), a = new THREE.Mesh(o, r);
  return a.renderOrder = 2, a;
}
function buildRedDotLens(i, e) {
  let t = new THREE.Shape();
  i.forEach((r, a) => a ? t.lineTo(r[0], r[1]) : t.moveTo(r[0], r[1])), t.closePath();
  let n = new THREE.ShapeGeometry(t);
  n.translate(0, 0, -e);
  {
    let r = 1e9, a = -1e9, l = 1e9, c = -1e9;
    for (let f of i) r = Math.min(r, f[0]), a = Math.max(a, f[0]), l = Math.min(l, f[1]), c = Math.max(c, f[1]);
    let u = n.attributes.position, h = n.attributes.uv;
    for (let f = 0; f < u.count; f++) h.setXY(f, (u.getX(f) - r) / (a - r), (u.getY(f) - l) / (c - l));
  }
  let s = new THREE.ShaderMaterial({ transparent: true, premultipliedAlpha: true, depthWrite: false, side: THREE.DoubleSide, uniforms: { uBright: { value: 7 }, uSun: { value: LENS_SUN.dir.clone() }, uSunCol: { value: LENS_SUN.color.clone() }, uZen: { value: LENS_SKY.zenith.clone() }, uHor: { value: LENS_SKY.horizonAway.clone() }, uTilt: { value: 0.1 } }, vertexShader: `
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN; varying vec2 vUv;
      uniform float uTilt;
      void main(){
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0); vView = mv.xyz;
        vFwd = (modelViewMatrix * vec4(0.0, 0.0, -1.0, 0.0)).xyz; vRight = (modelViewMatrix * vec4(1.0, 0.0, 0.0, 0.0)).xyz; vUp = (modelViewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
        vWPos = (modelMatrix * vec4(position, 1.0)).xyz;
        vWN = normalize(mat3(modelMatrix) * normalize(vec3(0.0, -uTilt, 1.0)));   // real sights tilt the glass a few degrees
        gl_Position = projectionMatrix * mv;
      }`, fragmentShader: `
      varying vec3 vView, vFwd, vRight, vUp, vWPos, vWN; varying vec2 vUv;
      uniform float uBright; uniform vec3 uSun, uSunCol, uZen, uHor;
      void main(){
        vec3 d = normalize(vView), fw = normalize(vFwd);
        float k = max(dot(d, fw), 1e-3);
        vec2 a = vec2(dot(d, normalize(vRight)), dot(d, normalize(vUp))) / k;      // tangent of the angle off the bore axis
        float r = length(a), px = max(fwidth(r), 1e-5);
        float dotR = max(0.0011, px * 0.9), ringW = max(0.00045, px * 0.6);
        float dotI = 1.0 - smoothstep(dotR - px, dotR + px, r);
        float ring = 1.0 - smoothstep(ringW - px * 0.5, ringW + px, abs(r - 0.0128));
        float ang = atan(a.y, a.x);
        float tick = (1.0 - smoothstep(0.0, px * 1.2 + 0.0004, min(abs(a.x), abs(a.y)))) * step(0.0128, r) * (1.0 - smoothstep(0.0165, 0.0175, r));
        float ret = clamp(dotI + ring * 0.8 + tick * 0.8, 0.0, 1.0);
        // faint halo so the bloom has something to hold on to
        ret += 0.05 * exp(-r * r / 0.00002);
        vec3 retCol = vec3(1.0, 0.11, 0.045) * ret * uBright;
        // coated glass: sky/sun reflection through a ruby-teal dichroic coating, stronger at grazing angles
        vec3 wv = normalize(vWPos - cameraPosition); vec3 n = normalize(vWN); if (dot(n, wv) > 0.0) n = -n;
        vec3 rf = reflect(wv, n);
        float fres = pow(1.0 - abs(dot(wv, n)), 3.0);
        vec3 sky = mix(uHor, uZen, clamp(rf.y * 1.4 + 0.2, 0.0, 1.0));
        float sd = max(dot(rf, uSun), 0.0);
        sky += uSunCol * (pow(sd, 6.0) * 0.6 + pow(sd, 90.0) * 6.0);
        // blue -> amber dichroic coating across the glass, a soft diagonal sheen band, and a thin dark edge
        float band = smoothstep(0.25, 0.5, vUv.x * 0.6 + vUv.y) * (1.0 - smoothstep(0.62, 0.95, vUv.x * 0.6 + vUv.y));
        vec3 coat = mix(vec3(0.30, 0.50, 0.95), vec3(1.0, 0.62, 0.28), clamp(fres * 2.2 + vUv.y * 0.75 - 0.15, 0.0, 1.0));
        vec2 e = abs(vUv - 0.5) * 2.0; float edge = smoothstep(0.90, 1.0, max(e.x, e.y));
        float refl = 0.12 + 0.60 * fres + 0.07 * band;
        // faint emitter glow that stays visible off-axis (what you see of a powered sight from the hip)
        vec2 eg = (vUv - vec2(0.5, 0.16)) * vec2(1.0, 1.6); retCol += vec3(1.0, 0.10, 0.04) * 0.20 * exp(-dot(eg, eg) * 60.0) * (1.0 - smoothstep(0.985, 0.9995, k));
        vec3 col = (sky * 1.5 + vec3(0.03, 0.035, 0.045)) * coat * refl * (1.0 - edge) + retCol;
        float alpha = clamp(0.20 + 0.32 * fres + 0.05 * band + 0.6 * edge, 0.0, 0.94);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }), o = new THREE.Mesh(n, s);
  return o.renderOrder = 5, o;
}
function buildMuzzleFlash() {
  let i = [], e = [], t = [], n = [], s = (d, v, g, x, y) => {
    let b = i.length / 3;
    for (let m of [d, v, g, x]) i.push(m[0], m[1], m[2]);
    e.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let m = 0; m < 4; m++) t.push(y);
    n.push(b, b + 1, b + 2, b, b + 2, b + 3);
  };
  s([-0.13, -0.13, -0.03], [0.13, -0.13, -0.03], [0.13, 0.13, -0.03], [-0.13, 0.13, -0.03], 0), s([-0.13 * 0.7, -0.13 * 0.7, -0.09], [0.13 * 0.7, -0.13 * 0.7, -0.09], [0.13 * 0.7, 0.13 * 0.7, -0.09], [-0.13 * 0.7, 0.13 * 0.7, -0.09], 0);
  let r = 0.065, a = 0.34;
  s([-r, 0, 0.01], [r, 0, 0.01], [r, 0, -a], [-r, 0, -a], 1), s([0, -r, 0.01], [0, r, 0.01], [0, r, -a], [0, -r, -a], 1);
  let l = 0.17, c = 0.05, u = 0.035;
  s([-l, -c, u], [l, -c, u], [l, c, u], [-l, c, u], 2), s([-l, 0, u + c], [l, 0, u + c], [l, 0, u - c], [-l, 0, u - c], 2), s([-0.05, -0.05, -0.01], [0.05, -0.05, -0.01], [0.05, 0.05, -0.01], [-0.05, 0.05, -0.01], 3), s([-0.03, -0.03, 0.02], [0.03, -0.03, 0.02], [0.03, 0.03, 0.02], [-0.03, 0.03, 0.02], 4);
  let h = new THREE.BufferGeometry();
  h.setAttribute("position", new THREE.Float32BufferAttribute(i, 3)), h.setAttribute("uv", new THREE.Float32BufferAttribute(e, 2)), h.setAttribute("aType", new THREE.Float32BufferAttribute(t, 1)), h.setIndex(n);
  let f = new THREE.ShaderMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, uniforms: { uSeed: { value: 0 }, uInt: { value: 0 }, uHeat: { value: 0 }, uJet: { value: 1 } }, vertexShader: `attribute float aType; varying vec2 vUv; varying float vType;
      void main(){ vUv = uv; vType = aType; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`, fragmentShader: `varying vec2 vUv; varying float vType; uniform float uSeed, uInt, uHeat, uJet;
      float h1(float n){ return fract(sin(n * 127.1 + uSeed * 311.7) * 43758.5453); }
      void main(){
        vec2 p = vUv * 2.0 - 1.0; float r = length(p), a = atan(p.y, p.x); float I = 0.0; vec3 tintc = vec3(1.0, 0.50, 0.16);
        if (vType < 0.5) {
          float n1 = 3.0 + floor(h1(1.0) * 3.0), n2 = 5.0 + floor(h1(2.0) * 4.0);
          float pet = pow(abs(cos(a * n1 * 0.5 + h1(3.0) * 6.283)), 5.0) * (0.55 + 0.45 * h1(4.0));
          pet += pow(abs(cos(a * n2 * 0.5 + h1(5.0) * 6.283)), 14.0) * 0.55;
          float reach = 0.35 + 0.65 * pet;
          I = (0.25 + pet) * smoothstep(reach, reach * 0.15, r) * (0.75 + 0.25 * sin(r * 26.0 + h1(6.0) * 20.0));
        } else if (vType < 1.5) {
          float y = vUv.y, x = p.x * (1.0 + 0.5 * sin(y * 17.0 + h1(7.0) * 30.0) * y);
          float wdt = mix(0.20, 0.75, smoothstep(0.0, 0.35, y)) * (1.0 - y * 0.75);
          I = exp(-x * x / (wdt * wdt * 0.35)) * pow(1.0 - y, 1.4) * (0.7 + 0.3 * sin(y * 31.0 + h1(8.0) * 9.0)) * 0.9;
        } else if (vType < 2.5) {
          float u = abs(p.x), len = 0.55 + 0.45 * h1(9.0 + step(0.0, p.x));
          float wv = p.y * (1.0 + u * 3.0) + 0.12 * sin(u * 14.0 + h1(10.0) * 20.0) * u;
          I = exp(-wv * wv * 22.0) * smoothstep(len, 0.06, u) * smoothstep(0.02, 0.10, u) * 0.85 * uJet;
        } else if (vType < 3.5) {
          I = exp(-r * r * 5.0) * 2.4 * smoothstep(1.0, 0.6, r); tintc = vec3(1.0, 0.82, 0.58);
        } else {
          gl_FragColor = vec4(vec3(1.0, 0.28, 0.06) * exp(-r * r * 4.0) * smoothstep(1.0, 0.5, r) * uHeat, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          return;
        }
        vec3 col = mix(tintc, vec3(1.0, 0.90, 0.70), clamp(I * I * 0.7, 0.0, 1.0)) * I * uInt;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }` }), p = new THREE.Mesh(h, f);
  return p.renderOrder = 10, p.frustumCulled = false, p;
}
var RAIN_WETNESS = { value: 1 }, DETAIL_COMMON_GLSL = `
varying vec3 vObjP; varying vec3 vWNrm; varying vec3 vONrm; uniform float uKind; uniform float uRain;
float dh3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float dn3(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(dh3(i), dh3(i + vec3(1,0,0)), f.x), mix(dh3(i + vec3(0,1,0)), dh3(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(dh3(i + vec3(0,0,1)), dh3(i + vec3(1,0,1)), f.x), mix(dh3(i + vec3(0,1,1)), dh3(i + vec3(1,1,1)), f.x), f.y), f.z); }
vec2 dh2(vec2 p){ return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
vec2 dDrops(vec2 uv, float cell, float seed){ vec2 g = uv / cell, i = floor(g), f = fract(g); float best = 0.0;
  for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) { vec2 o = vec2(float(a), float(b)); vec2 r = dh2(i + o + seed);
    float keep = step(0.70, fract(r.x * 7.31 + r.y * 3.17)); vec2 c = o + 0.2 + 0.6 * r; float rad = (0.16 + 0.22 * fract(r.x * 13.7)) * keep;
    float d = length(f - c); best = max(best, sqrt(max(rad * rad - d * d, 0.0))); }
  return vec2(best * cell, step(1e-6, best)); }
vec3 dBump(vec3 N, float h){ vec3 dpdx = dFdx(-vViewPosition), dpdy = dFdy(-vViewPosition); float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx); float det = dot(dpdx, r1); vec3 g = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * N - g); }
`, DETAIL_ROUGHNESS_GLSL = `
vec3 dP = vObjP; vec3 dAn = abs(vONrm);
vec2 dUV = (dAn.y > dAn.x && dAn.y > dAn.z) ? dP.xz : (dAn.x > dAn.z ? dP.zy : dP.xy);
float dSm = dn3(dP * 36.0), dSm2 = dn3(dP * 150.0 + 7.0), dFine = dn3(dP * 2400.0);
float dHt = 0.0, dR = 0.0;
if (uKind < 0.5) {
  float scuff = smoothstep(0.70, 0.9, dn3(dP * vec3(420.0, 420.0, 26.0) + 3.0));
  float smudge = smoothstep(0.55, 0.8, dn3(dP * 55.0 + 11.0));
  dR = (dSm - 0.5) * 0.20 + (dSm2 - 0.5) * 0.10 + (dFine - 0.5) * 0.08 + scuff * 0.18 - smudge * 0.12;
  dHt = dFine * 0.000010 - scuff * 0.000015;
} else if (uKind < 1.5) {
  float ring = sin(dP.z * 5200.0) * 0.5 + 0.5, streak = dn3(vec3(dP.z * 950.0, 1.0, 2.0));
  dR = (streak - 0.5) * 0.26 + (dSm - 0.5) * 0.14 + (dFine - 0.5) * 0.10;
  dHt = ring * 0.000014 + dFine * 0.000010;
} else {
  float st = dn3(dP * 1500.0) * 0.6 + dn3(dP * 3100.0 + 5.0) * 0.4;
  dR = (dSm - 0.5) * 0.18 + (st - 0.5) * 0.14 - smoothstep(0.6, 0.85, dSm2) * 0.10;
  dHt = st * 0.000075;
}
float dUp = smoothstep(0.30, 0.75, vWNrm.y) * uRain;
vec2 dD1 = dDrops(dUV, 0.0046, 3.0), dD2 = dDrops(dUV + 0.31, 0.0023, 9.0);
float dDrop = max(dD1.y, dD2.y) * dUp, dDropH = max(dD1.x, dD2.x) * dUp;
float dWet = dUp * (0.5 + 0.5 * smoothstep(0.3, 0.7, dSm));
roughnessFactor = clamp(roughnessFactor + dR, 0.10, 1.0);
roughnessFactor = mix(roughnessFactor, roughnessFactor * 0.5, dWet);
roughnessFactor = mix(roughnessFactor, 0.10, dDrop);
diffuseColor.rgb *= 1.0 - 0.18 * dWet;
`, DETAIL_NORMAL_GLSL = `
normal = dBump(normal, dHt + dDropH * 0.32);
`;
function applyDetailShader(i, e) {
  return i.onBeforeCompile = (t) => {
    t.uniforms.uKind = { value: e }, t.uniforms.uRain = RAIN_WETNESS, t.vertexShader = t.vertexShader.replace("#include <common>", `#include <common>
varying vec3 vObjP; varying vec3 vWNrm; varying vec3 vONrm;`).replace("#include <begin_vertex>", `#include <begin_vertex>
vObjP = position; vONrm = normal; vWNrm = normalize(mat3(modelMatrix) * normal);`), t.fragmentShader = t.fragmentShader.replace("#include <common>", `#include <common>
` + DETAIL_COMMON_GLSL).replace("#include <roughnessmap_fragment>", `#include <roughnessmap_fragment>
` + DETAIL_ROUGHNESS_GLSL).replace("#include <normal_fragment_maps>", `#include <normal_fragment_maps>
` + DETAIL_NORMAL_GLSL);
  }, i.customProgramCacheKey = () => "pac9-detail-" + e, i;
}
var Vec3 = THREE.Vector3, Quaternion = THREE.Quaternion, MAG_SIZE = 30, RESERVE = 150, RPM = 720, DAMAGE = 26, RANGE = 300, POSE_HIP = { p: [0.118, -0.122, -0.275], r: [0.034, 0.085, -0.03] }, POSE_ADS = { p: [0, -PAC9.sightY, -0.135], r: [0, 0, 0] }, POSE_SPRINT = { p: [-0.035, 4e-3, 0.03], r: [-0.04, 0.62, 0.26] }, POSE_RELOAD = { p: [-0.03, 0.1, -0.02], r: [0.46, 0.22, -0.8] }, RELOAD_TIME = 2.1, RELOAD_EMPTY_TIME = 2.72, smootherstep = (i) => (i = saturate(i), i * i * i * (i * (6 * i - 15) + 10)), spring = (i, e) => ({ x: 0, v: 0, k: i, c: e });
function stepSpring(i, e, t) {
  let n = t > 0.012 ? Math.ceil(t / 8e-3) : 1, s = t / n;
  for (let o = 0; o < n; o++) i.v += ((e - i.x) * i.k - i.v * i.c) * s, i.x += i.v * s;
  return i.x;
}
var quatEuler = (i, e, t, n = "XYZ") => new Quaternion().setFromEuler(new THREE.Euler(i, e, t, n));

// ---------------------------------------------------------------- controller
//
// Rewritten from Saltline's `dm`. Geometry, poses, reload keyframes, spring
// constants and the recoil pattern are unchanged; the game-specific plumbing
// (Saltline's material library, player, input, combat and fx singletons) is
// replaced by an explicit context and a per-frame input record.
//
// ctx:
//   camera, viewCamera   world camera and the camera the viewmodel layer is
//                        drawn with (same transform, own fov/near)
//   material(name)       optional: returns a material for 'brass' | 'glove_fabric'
//   rng()                optional random source
//   emit(type, data)     'weapon:fire' | 'weapon:reload' {phase} | 'weapon:dry'
//   shot(origin, dir)    optional: returns hit point (Vector3) or null
//   tracer(from, to)     optional
//   shell(pos, vel)      optional, world space
//   recoil(pitch, yaw)   optional camera recoil impulse (radians)
// update(dt, input):
//   input = { fire, ads, reload, move:{x,y}, look:{dx,dy}, speed, onGround,
//             velY, sprinting, crouching, eye: Vector3, vel?: Vector3 }

const SALTLINE_BASE_COLOURS = {
  // From Saltline's material table: brass = brushed metal 0xc29a45,
  // glove_fabric = woven fabric 0x23262a. Their vertex colours are multipliers
  // on these bases, so the base value matters more than any texture.
  brass: () => new THREE.MeshStandardMaterial({ color: 0xc29a45, roughness: 0.42, metalness: 1, vertexColors: true }),
  // Saltline's fabric also multiplies a dark weave albedo (~0.5) we do not
  // bake, so the plain base is halved to keep the glove from reading white.
  glove_fabric: () => new THREE.MeshStandardMaterial({ color: new THREE.Color(0x23262a).multiplyScalar(0.5), roughness: 0.93, metalness: 0, vertexColors: true }),
};

// Draw/holster and relaxed-carry poses, added here (Saltline never holsters):
// offsets layered on top of the hip pose like Saltline's sprint/reload poses.
const POSE_HOLSTER = { p: [0.07, -0.34, 0.1], r: [-0.85, 0.6, 0.55] };
const POSE_LOWER = { p: [-0.01, -0.028, 0.02], r: [-0.22, 0.26, 0.15] };

export const PAC9_SPEC = PAC9;
export const PAC9_VIEW_FOV = 54;
export const PAC9_ADS_FOV = 52;

const MARKING_LAYOUT = [['model', -0.0168, -0.0315, 0.064, 95e-4, 'L'], ['maker', -0.0168, -0.042, 0.064, 3e-3, 'L'], ['cal', -0.0168, -0.0465, 0.064, 28e-4, 'L'], ['prop', -0.0168, -0.071, 0.066, 26e-4, 'L'], ['auto', -0.0168, -0.027, -0.0335, 36e-4, 'L'], ['semi', -0.0168, -0.0262, -0.049, 36e-4, 'L'], ['safe', -0.0168, -0.0362, -0.062, 36e-4, 'L'], ['rack', -0.0168, -4e-3, -0.205, 0.02, 'L'], ['warn', -0.0181, -0.01, 0.03, 62e-4, 'L'], ['optic', -0.0195, 0.0735, 0.021, 24e-4, 'L'], ['model', 0.0168, -0.0315, 0.068, 95e-4, 'R'], ['warn', 0.0168, -0.066, 0.066, 75e-4, 'R'], ['rack', 0.0168, -4e-3, -0.205, 0.02, 'R'], ['auto', 0.0168, -0.027, -0.0335, 36e-4, 'R'], ['safe', 0.0168, -0.0362, -0.062, 36e-4, 'R'], ['optic', 0.0195, 0.0735, 0.021, 24e-4, 'R'], ['cal', 0.0181, 0.0245, -0.055, 26e-4, 'R'], ['r2', 0, 0.04365, -0.0816, 3e-3, 'T'], ['r4', 0, 0.04365, -0.0616, 3e-3, 'T'], ['r6', 0, 0.04365, 0.0584, 3e-3, 'T'], ['r8', 0, 0.04365, 0.0784, 3e-3, 'T'], ['r10', 0, 0.04365, 0.0984, 3e-3, 'T'], ['r12', 0, 0.04365, 0.1184, 3e-3, 'T']];

export function createPac9Viewmodel(ctx) {
  const root = new THREE.Group();
  root.name = 'viewmodel-pac9';
  const geo = buildPac9Geometry();
  const material = (name) => ctx.material?.(name) || SALTLINE_BASE_COLOURS[name]();
  const mesh = (g, m) => {
    const out = new THREE.Mesh(g, m);
    out.castShadow = false;
    out.receiveShadow = false;
    out.frustumCulled = false;
    return out;
  };
  const anodised = new THREE.MeshStandardMaterial({ color: new THREE.Color(85e-4, 9e-3, 0.0105), roughness: 0.4, metalness: 0.45, vertexColors: true });
  anodised.name = 'pac9_anodised';
  applyDetailShader(anodised, 0);
  const matte = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0, vertexColors: true });
  matte.name = 'pac9_matte';
  const phosphate = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.016, 0.016, 0.0165), roughness: 0.5, metalness: 0.7, vertexColors: true });
  phosphate.name = 'pac9_phosphate';
  applyDetailShader(phosphate, 1);
  const polymer = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.0125, 0.0128, 0.0135), roughness: 0.62, metalness: 0, vertexColors: true });
  polymer.name = 'pac9_polymer';
  applyDetailShader(polymer, 2);
  const polymerTan = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.105, 0.08, 0.05), roughness: 0.62, metalness: 0, vertexColors: true });
  polymerTan.name = 'pac9_polymer_tan';
  applyDetailShader(polymerTan, 2);
  root.add(mesh(geo.ano, anodised), mesh(geo.gun, phosphate), mesh(geo.poly, polymer), mesh(geo.plain, matte));
  const bolt = mesh(geo.bolt, phosphate);
  root.add(bolt);

  const magazine = new THREE.Group();
  const magHome = new Vec3().fromArray(PAC9.magPos);
  magazine.position.copy(magHome);
  const topRound = mesh(geo.round, material('brass'));
  magazine.add(mesh(geo.mag, polymerTan), topRound);
  root.add(magazine);

  let markings = null;
  try {
    markings = buildMarkings(MARKING_LAYOUT);
    markings.castShadow = false;
    markings.frustumCulled = false;
    root.add(markings);
  } catch (error) {
    console.warn(`[pac9] markings skipped: ${error}`);
  }
  const lens = buildRedDotLens(PAC9.window.map((p) => [p[0] * 1.01, (p[1] - PAC9.sightY) * 1.01 + PAC9.sightY]), PAC9.lensF + 25e-4);
  lens.frustumCulled = false;
  root.add(lens);
  const flash = buildMuzzleFlash();
  flash.position.fromArray(PAC9.muzzle);
  flash.visible = false;
  root.add(flash);

  // ---- hands
  const dirIn = (q, v, mirror) => {
    const out = new Vec3(v[0], v[1], v[2]).normalize().applyQuaternion(q.clone().invert());
    if (mirror) out.x *= -1;
    return [out.x, out.y, out.z];
  };
  const gripQ = quatEuler(-0.24, 0, 0).multiply(quatEuler(0, 0, -Math.PI / 2));
  const rightHand = buildHand({
    mirror: false,
    fingers: [null, [0.62, 1.72, 0.8, 0], [0.68, 1.7, 0.8, -0.03], [0.74, 1.66, 0.8, -0.09]],
    indexPoses: [[0.1, 0.16, 0.1, 0.05], [0.46, 1.15, 0.5, 0]],
    thumb: [dirIn(gripQ, [-0.85, 0.05, -0.5]), dirIn(gripQ, [-0.6, -0.05, -0.8]), dirIn(gripQ, [-0.05, -0.2, -0.97])],
    forearm: dirIn(gripQ, [0.27, -0.44, 0.86]),
    upperArm: dirIn(gripQ, [-.16, -.18, .97]),
    sleeve: 0.34,
  });
  const rightGroup = new THREE.Group();
  rightGroup.quaternion.copy(gripQ);
  rightGroup.position.fromArray(PAC9.grip).sub(new Vec3(6e-3, -0.031, -0.085).applyQuaternion(gripQ));
  const glove = material('glove_fabric');
  rightGroup.add(mesh(rightHand.fabric, glove));
  const triggerFinger = mesh(rightHand.index[0].clone(), glove);
  rightGroup.add(triggerFinger);
  root.add(rightGroup);
  const fingerRest = rightHand.index[0].attributes, fingerPull = rightHand.index[1].attributes;
  let fingerShown = -1;
  function setTriggerFinger(w) {
    if (Math.abs(w - fingerShown) < 4e-3) return;
    fingerShown = w;
    const pos = triggerFinger.geometry.attributes.position, nrm = triggerFinger.geometry.attributes.normal;
    const p0 = fingerRest.position.array, p1 = fingerPull.position.array, n0 = fingerRest.normal.array, n1 = fingerPull.normal.array;
    for (let i = 0; i < p0.length; i++) {
      pos.array[i] = p0[i] + (p1[i] - p0[i]) * w;
      nrm.array[i] = n0[i] + (n1[i] - n0[i]) * w;
    }
    pos.needsUpdate = true;
    nrm.needsUpdate = true;
  }

  const supportQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.06, 0, 0));
  const leftHand = buildHand({
    mirror: true,
    fingers: [[1.27, 1.42, 0.75, 0.02], [1.3, 1.45, 0.75, 0], [1.3, 1.45, 0.75, -0.02], [1.33, 1.45, 0.75, -0.05]],
    thumb: [dirIn(supportQ, [0, 0.25, -0.97], true), dirIn(supportQ, [0.05, 0.1, -0.99], true), dirIn(supportQ, [0, 0, -1], true)],
    forearm: dirIn(supportQ, [-0.5, -0.35, 0.79], true),
    upperArm: dirIn(supportQ, [.24, -.10, .96], true),
    sleeve: 0.34,
  });
  const leftGroup = new THREE.Group();
  leftGroup.add(mesh(leftHand.fabric, glove));
  root.add(leftGroup);

  // ---- support-hand reload keyframes (seconds, pose). `key(q, p, anchor)`
  // places the hand so `anchor` (a palm point) lands on p.
  const palmAnchor = new Vec3(0, -0.015, -0.055);
  const key = (q, p, anchor = palmAnchor) => ({ q: q.clone(), p: new Vec3(p[0], p[1], p[2]).sub(anchor.clone().applyQuaternion(q)) });
  const offset = (k, x, y, z, q = null) => ({ q: q ? q.clone() : k.q.clone(), p: k.p.clone().add(new Vec3(x, y, z)) });
  const magGripQ = quatEuler(0, 0, Math.PI / 2).multiply(quatEuler(0.12, 0, 0));
  const kGuard = key(supportQ, [-0.015, -0.062, -0.236]);
  const kMag = key(magGripQ, [-0.0135, -0.15, -0.0745]);
  const kMagPull = offset(kMag, -0.035, -0.02, 0.01);
  const kMagAway = offset(kMag, -0.06, -0.3, 0.13, magGripQ.clone().multiply(quatEuler(-0.5, 0, 0.25)));
  const kMagSeat = offset(kMag, 0, -0.035, 4e-3);
  const kMagPush = offset(kMag, -4e-3, -0.06, 0);
  const kMagTap = offset(kMag, 0, -0.012, 0);
  const handleQ = quatEuler(-0.6, 0, 0).multiply(new Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, -1, 0))));
  const kHandle = key(handleQ, [PAC9.handlePos[0] - 4e-3, PAC9.handlePos[1], PAC9.handlePos[2]], new Vec3(0, -0.024, -0.118));
  const kHandleBack = offset(kHandle, 0, 0, PAC9.boltTravel);
  const TACTICAL = [[0, kGuard], [0.1, kGuard], [0.36, kMagPull], [0.44, kMag], [0.5, kMag], [0.8, kMagAway], [0.98, kMagAway], [1.28, kMagSeat], [1.35, kMag], [1.45, kMagPush], [1.52, kMagTap], [1.62, kMag], [1.7, kMagPull], [2.02, kGuard], [9, kGuard]];
  const EMPTY = [...TACTICAL.slice(0, 12), [1.7, kMagPull], [1.96, kHandle], [2.02, kHandle], [2.14, kHandleBack], [2.19, kHandleBack], [2.26, kHandle], [2.36, kHandle], [2.66, kGuard], [9, kGuard]];
  const T_MAG_OUT = 0.47, T_MAG_IN = 1.345, T_RACK = 2.02, T_RACK_BACK = 2.14, T_BOLT = 2.19;
  // draw: the rifle rises out of the holster pose with the support hand on the
  // charging handle, racks a round, and the hand returns to the handguard
  const DRAW_KEYS = [[0, kHandle], [0.45, kHandle], [0.57, kHandleBack], [0.62, kHandleBack], [0.68, kHandle], [0.78, kHandle], [1.05, kGuard], [9, kGuard]];
  const T_DRAW = 1.05, T_DRAW_RACK = 0.45, T_DRAW_BACK = 0.57, T_DRAW_RELEASE = 0.62, T_HOLSTER = 0.42;
  const keyPos = new Vec3(), keyQ = new Quaternion(), magQ = new Quaternion(), camQ = new Quaternion();
  function sampleKeys(keys, t) {
    let i = 0;
    while (i < keys.length - 2 && t > keys[i + 1][0]) i++;
    const a = keys[i], b = keys[i + 1];
    const w = smootherstep((t - a[0]) / Math.max(1e-4, b[0] - a[0]));
    keyPos.copy(a[1].p).lerp(b[1].p, w);
    keyQ.copy(a[1].q).slerp(b[1].q, w);
  }
  const magGripInv = magGripQ.clone().invert();

  const tris = Object.values(geo).reduce((n, g) => n + triangleCount(g), 0) + triangleCount(rightHand.fabric) + triangleCount(rightHand.index[0]) + triangleCount(leftHand.fabric) + (markings ? triangleCount(markings.geometry) : 0) + 2;

  // ---- state
  const rand = ctx.rng || Math.random;
  const s = {
    draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0,
    t: 0, cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9, bloom: 0, heat: 0,
    adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0, bobPhase: 0, bobAmt: 0, finger: 0, boltT: 9, boltLocked: false,
    flashT: 0, flashDur: 0.05, recPhase: 0, wasGround: true, lastVy: 0, spreadS: 0.0125, idleT: 0, inspect: -1,
    kZ: spring(520, 30), kP: spring(380, 26), kY: spring(300, 22), kR: spring(300, 20),
    swY: spring(110, 15), swP: spring(110, 15), jY: spring(140, 13), jP: spring(140, 13), bump: spring(600, 30),
  };
  const SPRINGS = ['kZ', 'kP', 'kY', 'kR', 'swY', 'swP', 'jY', 'jP', 'bump'];
  const api = {
    name: PAC9.name, root, ammo: MAG_SIZE, magSize: MAG_SIZE, reserve: Infinity, state: 'idle', ads: 0, spread: 0.0125,
    info: { tris: Math.round(tris) }, magazine, leftHand: leftGroup, update, reset, reloadNow, cancelReload, muzzleWorld,
    isReloading: () => !!s.reload,
    reloadProgress: () => (s.reload ? Math.min(1, s.reload.t / s.reload.T) : 0),
    reloadDuration: () => (s.reload ? s.reload.T : 0),
    draw: drawNow, holster: holsterNow,
    isHolstered: () => s.holstered,
    isHolstering: () => !!s.holster,
    equipState: () => (s.draw ? 'drawing' : s.holster ? 'holstering' : s.holstered ? 'holstered' : s.relaxW > 0.5 ? 'lowered' : 'ready'),
    setWetness(w) { RAIN_WETNESS.value = Math.max(0, Math.min(1, +w || 0)); },
    snap(input = {}) {
      s.adsLin = input.ads ? 1 : 0;
      for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
      s.sprintT = input.sprinting ? 1 : 0;
    },
  };
  RAIN_WETNESS.value = 0;

  function restPose() {
    magazine.visible = true;
    magazine.position.copy(magHome);
    magazine.quaternion.identity();
    leftGroup.position.copy(kGuard.p);
    leftGroup.quaternion.copy(kGuard.q);
  }
  function reset() {
    Object.assign(s, { draw: null, holster: null, holstered: true, equipW: 0, relaxW: 0, quietT: 0 });
    api.ammo = MAG_SIZE; api.state = 'idle'; api.ads = 0;
    Object.assign(s, { cooldown: 0, dryDone: false, autoReload: -1, reload: null, burst: 0, lastShot: -9, bloom: 0, heat: 0, adsLin: 0, adsE: 0, sprintT: 0, reloadW: 0, rackW: 0, boltT: 9, boltLocked: false, flashT: 0, idleT: 0, inspect: -1 });
    for (const k of SPRINGS) { s[k].x = 0; s[k].v = 0; }
    topRound.visible = true;
    restPose();
  }
  // Interrupting a reload (weapon switch) keeps the round count it reached.
  // Bring the rifle up (resumes from wherever a holster left it).
  function drawNow() {
    if (s.draw || (!s.holstered && !s.holster)) return false;
    const from = s.equipW;
    s.holster = null;
    s.holstered = false;
    s.draw = { t: from * T_DRAW_RACK * 0.999, f: {} };
    ctx.emit?.('weapon:draw', { phase: 'start' });
    return true;
  }
  // Put it away: a reload in progress is abandoned (rounds already seated stay).
  function holsterNow() {
    if (s.holstered || s.holster) return false;
    if (s.reload) cancelReload();
    s.draw = null;
    s.relaxW = 0;
    s.holster = { t: (1 - s.equipW) * T_HOLSTER };
    restPose();
    ctx.emit?.('weapon:holster', { phase: 'start' });
    return true;
  }

  function cancelReload() {
    if (!s.reload) return;
    s.reload = null; s.reloadW = 0; s.rackW = 0;
    topRound.visible = api.ammo > 0;
    restPose();
  }

  // Viewmodel-local point -> world point as the player perceives it: the
  // viewmodel is drawn with its own (narrower) fov, so re-project from the
  // view frustum into the world camera frustum like Saltline did.
  function viewToWorld(local, out) {
    out.fromArray(local);
    root.updateWorldMatrix(true, false);
    root.localToWorld(out);
    const cam = ctx.camera, view = ctx.viewCamera || cam;
    cam.worldToLocal(out);
    const k = Math.tan(cam.fov * Math.PI / 360) / Math.tan(view.fov * Math.PI / 360);
    out.x *= k; out.y *= k;
    return cam.localToWorld(out);
  }
  function muzzleWorld(out = new Vec3()) { return viewToWorld(PAC9.muzzle, out); }

  function reloadNow() {
    if (s.holstered || s.holster || s.draw || s.reload || api.ammo >= api.magSize || api.reserve <= 0) return false;
    const empty = api.ammo <= 0;
    s.reload = { t: 0, T: empty ? RELOAD_EMPTY_TIME : RELOAD_TIME, empty, f: {} };
    s.autoReload = -1;
    ctx.emit?.('weapon:reload', { phase: 'start', empty });
    return true;
  }

  const shotDir = new Vec3(), muzzle = new Vec3(), hit = new Vec3(), eject = new Vec3(), shellVel = new Vec3(), eye = new Vec3();
  function fireRound(input) {
    const cam = ctx.camera;
    api.ammo--;
    s.burst++;
    s.lastShot = s.t;
    s.heat = Math.min(1.3, s.heat + 0.05);
    cam.getWorldQuaternion(camQ);
    const a = rand() * Math.PI * 2, r = Math.tan(api.spread) * Math.sqrt(rand());
    shotDir.set(Math.cos(a) * r, Math.sin(a) * r, -1).normalize().applyQuaternion(camQ);
    if (input.eye) eye.copy(input.eye); else cam.getWorldPosition(eye);
    const point = ctx.shot?.(eye, shotDir) || null;
    if (point) hit.copy(point); else hit.copy(eye).addScaledVector(shotDir, RANGE);
    muzzleWorld(muzzle);
    ctx.tracer?.(muzzle, hit);
    if (ctx.shell) {
      viewToWorld(PAC9.eject, eject);
      shellVel.set(2 + rand() * 1.2, 1.2 + rand() * 0.8, 0.5 - rand() * 0.6).applyQuaternion(camQ);
      if (input.vel) shellVel.add(input.vel);
      ctx.shell(eject, shellVel);
    }
    ctx.emit?.('weapon:fire', { origin: eye, dir: shotDir, muzzle, ads: s.adsE });
    const k = lerp(1, 0.55, s.adsE) * (input.crouching ? 0.85 : 1);
    const n = s.burst, falloff = n <= 9 ? 1 : 0.38;
    const yaw = (n < 4 ? (rand() - 0.5) * 22e-4 : Math.sin(n * 0.57 + s.recPhase) * 42e-4 + (rand() - 0.5) * 2e-3) * k;
    ctx.recoil?.(68e-4 * falloff * k * (0.85 + rand() * 0.3), yaw);
    s.kZ.v += 1.5 * lerp(1, 0.6, s.adsE);
    s.kP.v += 1.5 * k;
    s.kY.v += (rand() - 0.5) * k;
    s.kR.v += (rand() - 0.5) * 1.8 * k;
    s.bloom = Math.min(1, s.bloom + 0.17);
    s.flashT = s.flashDur = 0.036 + rand() * 0.02;
    const u = flash.material.uniforms;
    u.uSeed.value = rand() * 100;
    u.uJet.value = 0.6 + rand() * 0.6;
    flash.rotation.z = (rand() - 0.5) * 0.4;
    const fs = (0.8 + rand() * 0.5) * lerp(1, 0.62, s.adsE);
    flash.scale.set(fs, fs, fs * (0.8 + rand() * 0.5));
    s.boltT = 0;
    if (api.ammo <= 0) { s.boltLocked = true; topRound.visible = false; }
  }

  function update(dt, input) {
    s.t += dt;
    // ---- draw / holster
    let drawRack = 0;
    if (s.draw) {
      const D = s.draw;
      D.t += dt;
      const t = D.t;
      s.equipW = smootherstep(t / T_DRAW_RACK);
      sampleKeys(DRAW_KEYS, t);
      leftGroup.position.copy(keyPos);
      leftGroup.quaternion.copy(keyQ);
      if (t >= T_DRAW_RACK) drawRack = t < T_DRAW_BACK ? smootherstep((t - T_DRAW_RACK) / (T_DRAW_BACK - T_DRAW_RACK)) : t < T_DRAW_RELEASE ? 1 : Math.max(0, 1 - (t - T_DRAW_RELEASE) / 0.035);
      if (t >= T_DRAW_RELEASE && !D.f.rack) { D.f.rack = 1; s.bump.v += 0.3; s.kZ.v -= 0.5; ctx.emit?.('weapon:draw', { phase: 'rack' }); }
      if (t >= T_DRAW) { s.draw = null; s.equipW = 1; restPose(); ctx.emit?.('weapon:draw', { phase: 'done' }); }
    } else if (s.holster) {
      const H = s.holster;
      H.t += dt;
      s.equipW = 1 - smootherstep(H.t / T_HOLSTER);
      if (H.t >= T_HOLSTER) { s.holster = null; s.holstered = true; s.equipW = 0; ctx.emit?.('weapon:holster', { phase: 'done' }); }
    }
    const equipped = !s.holstered && !s.holster && (!s.draw || s.draw.t > 0.8);
    const fire = !!input.fire && root.visible && equipped;
    if (!fire) s.dryDone = false;
    const wantsSprint = !!input.sprinting && !fire && !input.ads && !s.reload;
    s.sprintT = damp(s.sprintT, wantsSprint ? 1 : 0, 9, dt);
    if (input.reload && equipped) reloadNow();
    if (s.autoReload >= 0) { s.autoReload -= dt; if (s.autoReload < 0) reloadNow(); }

    let rack = 0;
    if (s.reload) {
      const R = s.reload;
      R.t += dt;
      const t = R.t;
      const phase = (name, at) => (t >= at && !R.f[name] ? (R.f[name] = 1, ctx.emit?.('weapon:reload', { phase: name, empty: R.empty }), true) : false);
      if (phase('magout', T_MAG_OUT)) s.bump.v -= 0.25;
      if (t > 0.86 && !R.f.fresh) { R.f.fresh = 1; topRound.visible = true; }
      if (phase('magin', T_MAG_IN)) {
        s.bump.v += 0.55;
        const n = Math.min(api.magSize - api.ammo, api.reserve);
        api.ammo += n;
        api.reserve -= n;
        if (!R.empty) s.boltLocked = false;
      }
      if (t >= 1.5 && !R.f.tap) { R.f.tap = 1; s.bump.v += 0.4; }
      if (R.empty) {
        if (t >= T_RACK) rack = t < T_RACK_BACK ? smootherstep((t - T_RACK) / (T_RACK_BACK - T_RACK)) : t < T_BOLT ? 1 : Math.max(0, 1 - (t - T_BOLT) / 0.035);
        if (phase('bolt', T_BOLT)) { s.boltLocked = false; s.bump.v += 0.3; s.kZ.v -= 0.5; }
      }
      sampleKeys(R.empty ? EMPTY : TACTICAL, t);
      leftGroup.position.copy(keyPos);
      leftGroup.quaternion.copy(keyQ);
      if (t >= T_MAG_OUT && t < T_MAG_IN) {
        // the magazine rides in the support hand between mag-out and mag-in
        magQ.copy(keyQ).multiply(magGripInv);
        magazine.quaternion.copy(magQ);
        magazine.position.copy(magHome).sub(kMag.p).applyQuaternion(magQ).add(keyPos);
      } else {
        magazine.quaternion.identity();
        magazine.position.copy(magHome);
      }
      const inW = smootherstep(t / 0.3), outW = 1 - smootherstep((t - (R.T - 0.46)) / 0.4);
      s.reloadW = Math.min(inW, outW);
      s.rackW = R.empty ? smootherstep((t - 1.62) / 0.3) * outW : 0;
      if (t >= R.T) {
        s.reload = null; s.reloadW = 0; s.rackW = 0;
        ctx.emit?.('weapon:reload', { phase: 'done' });
        restPose();
      }
    }

    s.cooldown -= dt;
    const canFire = !s.reload && s.sprintT < 0.45 && s.relaxW < 0.3;
    if (fire && canFire) {
      if (api.ammo > 0) {
        let n = 0;
        while (s.cooldown <= 0 && api.ammo > 0 && n < 3) { fireRound(input); s.cooldown += 60 / RPM; n++; }
      } else if (!s.dryDone) {
        s.dryDone = true;
        ctx.emit?.('weapon:dry', {});
        s.bump.v -= 0.08;
        if (api.reserve > 0) s.autoReload = 0.32;
      }
    }
    if (s.cooldown < 0) s.cooldown = Math.max(s.cooldown, -1e-3);
    if (s.t - s.lastShot > 0.24) { if (s.burst > 0) s.recPhase = rand() * 6.28; s.burst = 0; }
    s.bloom = Math.max(0, s.bloom - dt * 1.5);
    s.heat = Math.max(0, s.heat - dt * 0.2);

    const adsHeld = !!input.ads && !s.reload && s.sprintT < 0.35 && equipped;
    s.adsLin = clamp(s.adsLin + (adsHeld ? dt : -dt) / 0.18, 0, 1);
    s.adsE = smootherstep(s.adsLin);
    api.ads = s.adsE;
    const speed = input.speed || 0, moving = saturate(speed / 6);
    const onGround = input.onGround !== false;
    const target = lerp(0.0125, 12e-4, s.adsE) + moving * lerp(0.013, 4e-3, s.adsE) + s.bloom * lerp(65e-4, 22e-4, s.adsE) + (onGround ? 0 : 0.022) - (input.crouching ? 2e-3 * (1 - s.adsE) : 0);
    s.spreadS = damp(s.spreadS, target, 18, dt);
    api.spread = s.spreadS;
    const look = input.look || { dx: 0, dy: 0 };
    if (fire || input.ads || s.reload || speed > 0.2 || Math.abs(look.dx) + Math.abs(look.dy) > 2e-3 || s.sprintT > 0.1) {
      s.idleT = 0;
      if (s.inspect >= 0) s.inspect = Math.max(s.inspect, 2.9);
    } else s.idleT += dt;
    if (s.inspect < 0 && s.idleT > 24) s.inspect = 0;
    // relaxed carry: after a few quiet seconds the rifle sinks to a low ready;
    // any trigger or aim input snaps it back up (~50 ms) before a shot leaves
    const quiet = !input.fire && !input.ads && !s.reload && !s.draw && s.inspect < 0;
    s.quietT = quiet ? s.quietT + dt : 0;
    const relaxTarget = s.quietT > 3.5 && s.sprintT < 0.5 ? 1 : 0;
    s.relaxW = damp(s.relaxW, relaxTarget, relaxTarget > s.relaxW ? 1.4 : 24, dt);
    let inspectRoll = 0, inspectFlip = 0, inspectLift = 0;
    if (s.inspect >= 0) {
      const t = s.inspect += dt;
      inspectRoll = smootherstep(t / 0.5) * (1 - smootherstep((t - 1.4) / 0.5));
      inspectFlip = smootherstep((t - 1.5) / 0.5) * (1 - smootherstep((t - 2.8) / 0.5));
      inspectLift = smootherstep(t / 0.5) * (1 - smootherstep((t - 2.9) / 0.5));
      if (t > 3.5) { s.inspect = -1; s.idleT = 0; }
    }
    api.state = s.reload ? 'reloading' : s.inspect >= 0 ? 'inspect' : s.sprintT > 0.5 ? 'sprinting' : s.t - s.lastShot < 0.14 ? 'firing' : 'idle';

    s.boltT += dt;
    const boltDur = 0.072;
    let boltW = s.boltT < boltDur ? Math.sin(Math.PI * s.boltT / boltDur) : 0;
    if (s.boltLocked && s.boltT > boltDur * 0.5) boltW = Math.max(boltW, 0.86);
    bolt.position.z = PAC9.boltTravel * Math.max(boltW * 0.95, rack, drawRack);
    s.finger = damp(s.finger, fire && canFire ? 1 : 0, 30, dt);
    setTriggerFinger(s.finger);

    const fu = flash.material.uniforms;
    s.flashT -= dt;
    fu.uInt.value = s.flashT > 0 ? 9.5 * Math.sqrt(Math.max(0, s.flashT / s.flashDur)) : 0;
    fu.uHeat.value = saturate((s.heat - 0.45) / 0.8) * 2.2;
    flash.visible = fu.uInt.value > 0 || fu.uHeat.value > 0.02;

    const velY = input.velY || 0;
    s.bobAmt = damp(s.bobAmt, onGround ? saturate(speed / 3.6) : 0, 8, dt);
    s.bobPhase += dt * (speed > 0.3 && onGround ? 5.2 + speed * 1.55 : 0);
    const ph = s.bobPhase, bob = s.bobAmt * lerp(1, 0.12, s.adsE) * (1 + s.sprintT * 1.4);
    const bobX = Math.sin(ph) * 6e-3 * bob;
    const bobY = (Math.sin(2 * ph) * 42e-4 - Math.pow(0.5 + 0.5 * Math.cos(2 * ph + 0.6), 4) * 48e-4) * bob;
    const breathe = lerp(1, 0.3, s.adsE), t = s.t, swayK = lerp(1, 0.4, s.adsE);
    s.swY.v += clamp(look.dx, -0.2, 0.2) * 3.2 * swayK;
    s.swP.v += clamp(look.dy, -0.2, 0.2) * 2.6 * swayK;
    stepSpring(s.swY, 0, dt);
    stepSpring(s.swP, 0, dt);
    s.swY.x = clamp(s.swY.x, -0.09, 0.09);
    s.swP.x = clamp(s.swP.x, -0.07, 0.07);
    if (s.wasGround && !onGround && velY > 1) { s.jY.v -= 0.22; s.jP.v += 0.7; }
    if (!s.wasGround && onGround) {
      const land = clamp(-s.lastVy * 0.06, 0, 0.6);
      s.jY.v -= land; s.jP.v -= land * 3.2; s.kR.v += (rand() - 0.5) * land * 2;
    }
    s.wasGround = onGround;
    if (!onGround) s.lastVy = velY;
    stepSpring(s.jY, onGround ? 0 : clamp(-velY * 45e-4, -0.02, 0.024), dt);
    stepSpring(s.jP, onGround ? 0 : clamp(velY * 0.012, -0.06, 0.06), dt);
    for (const k of ['kZ', 'kP', 'kY', 'kR', 'bump']) stepSpring(s[k], 0, dt);

    const mx = input.move ? input.move.x : 0, my = input.move ? input.move.y : 0;
    const hip = 1 - s.adsE, ads = s.adsE, spr = s.sprintT, rl = s.reloadW, rk = s.rackW;
    const hol = 1 - s.equipW, lw = s.relaxW * (1 - s.adsE);
    const x = lerp(POSE_HIP.p[0], POSE_ADS.p[0], ads) + POSE_SPRINT.p[0] * spr + POSE_RELOAD.p[0] * rl + bobX + Math.sin(t * 0.85 + 1) * 12e-4 * breathe - s.swY.x * 0.06 - mx * 4e-3 * hip - 0.035 * inspectLift + POSE_HOLSTER.p[0] * hol + POSE_LOWER.p[0] * lw;
    const y = lerp(POSE_HIP.p[1], POSE_ADS.p[1], ads) + POSE_SPRINT.p[1] * spr + POSE_RELOAD.p[1] * rl + bobY + Math.sin(t * 1.7) * 16e-4 * breathe + s.swP.x * 0.05 + s.jY.x + s.bump.x * 0.6 + 0.045 * inspectLift + POSE_HOLSTER.p[1] * hol + POSE_LOWER.p[1] * lw;
    const z = lerp(POSE_HIP.p[2], POSE_ADS.p[2], ads) + POSE_SPRINT.p[2] * spr + POSE_RELOAD.p[2] * rl + s.kZ.x * 0.55 + my * 4e-3 * hip * (1 - spr) + POSE_HOLSTER.p[2] * hol + POSE_LOWER.p[2] * lw;
    const rx = POSE_HIP.r[0] * hip + POSE_SPRINT.r[0] * spr + POSE_RELOAD.r[0] * rl - 0.16 * rk + Math.sin(t * 1.7 + 0.8) * 35e-4 * breathe + Math.sin(2 * ph + 0.5) * 8e-3 * bob + s.swP.x + s.jP.x + s.kP.x + s.bump.x * 1.5 + 0.3 * inspectLift + POSE_HOLSTER.r[0] * hol + POSE_LOWER.r[0] * lw;
    const ry = POSE_HIP.r[1] * hip + POSE_SPRINT.r[1] * spr + POSE_RELOAD.r[1] * rl + Math.sin(t * 0.6) * 2e-3 * breathe + Math.sin(ph) * 0.01 * bob + s.swY.x + s.kY.x + 0.18 * inspectLift + 0.25 * inspectFlip + POSE_HOLSTER.r[1] * hol + POSE_LOWER.r[1] * lw;
    const rz = POSE_HIP.r[2] * hip + POSE_SPRINT.r[2] * spr + POSE_RELOAD.r[2] * rl + 0.62 * rk + Math.sin(ph) * 0.014 * bob + s.swY.x * 0.7 - mx * 0.035 * hip + s.kR.x - 0.75 * inspectRoll + 0.55 * inspectFlip + Math.sin(t * 0.5) * 4e-3 * breathe + POSE_HOLSTER.r[2] * hol + POSE_LOWER.r[2] * lw;
    root.position.set(x, y, z);
    root.rotation.set(rx, ry, rz, 'YXZ');
  }

  reset();
  return api;
}
