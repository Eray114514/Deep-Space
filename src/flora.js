// Procedural alien flora: every planet grows its own SPECIES. A seeded
// grammar assembles each one from organic pieces — bent trunks, bulb
// clusters, mushroom caps, frond fans, curling tentacles, glowing pods —
// with colors baked per-vertex from a hue-shifted planet palette. Low-poly
// flat-shaded to match the art style; alien by construction.

import * as THREE from 'three';
import { makeRng } from './rng.js';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const Y = new THREE.Vector3(0, 1, 0);

// paint a solid (slightly dithered) vertex color onto a geometry
function paint(geo, color, rng, jitter = 0.08) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const k = 1 + (rng() - 0.5) * jitter * 2;
    arr[i * 3] = color.r * k; arr[i * 3 + 1] = color.g * k; arr[i * 3 + 2] = color.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

function place(geo, x, y, z, quat = null, s = 1) {
  _m.compose(_v.set(x, y, z), quat || _q.identity(),
    typeof s === 'number' ? new THREE.Vector3(s, s, s) : s);
  geo.applyMatrix4(_m);
  return geo;
}

// merge geometries (indexed or triangle-soup) that all carry position+color
function mergeGeos(list) {
  let vTotal = 0, iTotal = 0;
  for (const g of list) {
    vTotal += g.attributes.position.count;
    iTotal += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vTotal * 3);
  const col = new Float32Array(vTotal * 3);
  const idx = new Uint32Array(iTotal);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3);
    col.set(g.attributes.color.array, vo * 3);
    const n = g.attributes.position.count;
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < n; i++) idx[io + i] = i + vo;
      io += n;
    }
    vo += n;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeVertexNormals();
  return out;
}

// a tapering tube along a quadratic bezier — trunks, stalks, tentacles
function bentTube(rng, pal, h, r0, r1, leanX, leanZ, color, segs = 5, radial = 6) {
  const parts = [];
  const pt = (t) => _v.set(
    leanX * h * t * t, h * (t - 0.12 * t * t * (leanX * leanX + leanZ * leanZ)),
    leanZ * h * t * t).clone();
  let prev = pt(0);
  for (let s = 0; s < segs; s++) {
    const t0 = s / segs, t1 = (s + 1) / segs;
    const a = prev, b = pt(t1);
    const mid = a.clone().lerp(b, 0.5);
    const dir = b.clone().sub(a);
    const len = dir.length();
    const rA = r0 + (r1 - r0) * t0, rB = r0 + (r1 - r0) * t1;
    const cyl = new THREE.CylinderGeometry(rB, rA, len, radial, 1);
    _q.setFromUnitVectors(Y, dir.normalize());
    paint(cyl, color, rng, 0.1);
    parts.push(place(cyl, mid.x, mid.y, mid.z, _q.clone()));
    prev = b;
  }
  return { parts, top: prev };
}

function blob(rng, r, color) {
  // icosahedra are triangle soup: co-located corners must jitter together
  // or the surface tears open
  const g = new THREE.IcosahedronGeometry(r, 1);
  const p = g.attributes.position;
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = p.getX(i).toFixed(4) + ',' + p.getY(i).toFixed(4) + ',' + p.getZ(i).toFixed(4);
    let k = seen.get(key);
    if (k === undefined) {
      k = [1 + (rng() - 0.5) * 0.35, 0.8 + rng() * 0.4];
      seen.set(key, k);
    }
    p.setXYZ(i, p.getX(i) * k[0], p.getY(i) * k[1], p.getZ(i) * k[0]);
  }
  return paint(g, color, rng, 0.12);
}

function frond(rng, len, wid, curl, color) {
  // a tapering strip, bent forward row by row — a leaf blade / palm frond
  const rows = 4;
  const g = new THREE.PlaneGeometry(wid, len, 1, rows);
  g.translate(0, len / 2, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const t = p.getY(i) / len;
    const taper = 1 - t * 0.8;
    p.setX(i, p.getX(i) * taper);
    p.setZ(i, Math.sin(t * curl) * len * 0.35);
    p.setY(i, p.getY(i) * (1 - 0.25 * t * curl * 0.4));
  }
  return paint(g, color, rng, 0.12);
}

// ---- species builders (origin at base, ~2–6 m tall) ------------------------

function buildTree(rng, pal, canopyColor) {
  const style = ['orbs', 'cap', 'fronds', 'tentacles', 'orbs', 'cap'][(rng() * 6) | 0];
  const h = 2.3 + rng() * 3.2;
  const leanX = (rng() - 0.5) * 0.65, leanZ = (rng() - 0.5) * 0.65;
  const bulb = rng() < 0.35 ? 1.8 + rng() : 1;      // some trunks are bulbous
  const r0 = (0.05 + h * 0.028) * bulb, r1 = r0 * (0.22 + rng() * 0.2);
  const trunk = bentTube(rng, pal, h, r0, r1, leanX, leanZ, pal.trunk);
  const parts = trunk.parts;
  const top = trunk.top;

  if (style === 'orbs') {
    const n = 3 + (rng() * 3) | 0;
    for (let i = 0; i < n; i++) {
      const r = h * (0.16 + rng() * 0.14);
      parts.push(place(blob(rng, r, canopyColor),
        top.x + (rng() - 0.5) * h * 0.36,
        top.y + (rng() - 0.6) * h * 0.22,
        top.z + (rng() - 0.5) * h * 0.36));
    }
  } else if (style === 'cap') {
    const r = h * (0.3 + rng() * 0.22), ch = r * (0.55 + rng() * 0.4);
    const cap = new THREE.LatheGeometry([
      new THREE.Vector2(0.02, 0), new THREE.Vector2(r * 0.9, ch * 0.18),
      new THREE.Vector2(r, ch * 0.5), new THREE.Vector2(r * 0.5, ch * 0.85),
      new THREE.Vector2(0.03, ch)], 9);
    paint(cap, canopyColor, rng, 0.1);
    parts.push(place(cap, top.x, top.y - ch * 0.15, top.z));
    if (rng() < 0.6) {          // glowing spots under the cap rim
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2 + rng();
        parts.push(place(blob(rng, r * 0.08, pal.accent),
          top.x + Math.cos(a) * r * 0.8, top.y + ch * 0.18, top.z + Math.sin(a) * r * 0.8));
      }
    }
  } else if (style === 'fronds') {
    const n = 5 + (rng() * 4) | 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.5;
      const f = frond(rng, h * (0.45 + rng() * 0.25), h * 0.09, 1.6 + rng(), canopyColor);
      _q.setFromAxisAngle(Y, a).multiply(
        new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.9 + rng() * 0.5));
      parts.push(place(f, top.x, top.y, top.z, _q.clone()));
    }
    parts.push(place(blob(rng, h * 0.07, pal.accent), top.x, top.y, top.z));
  } else {                       // tentacles
    const n = 4 + (rng() * 3) | 0;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng() * 0.6;
      const t = bentTube(rng, pal, h * (0.4 + rng() * 0.3), r1 * 1.5, 0.02,
        Math.cos(a) * (0.8 + rng() * 0.7), Math.sin(a) * (0.8 + rng() * 0.7), canopyColor, 4, 5);
      for (const g of t.parts) parts.push(place(g, top.x, top.y, top.z));
      parts.push(place(blob(rng, h * 0.045, pal.accent), top.x + t.top.x, top.y + t.top.y, top.z + t.top.z));
    }
  }
  return mergeGeos(parts);
}

function buildShrub(rng, pal) {
  const parts = [];
  const n = 6 + (rng() * 4) | 0;
  const len = 0.55 + rng() * 0.5;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng() * 0.7;
    const f = frond(rng, len * (0.8 + rng() * 0.4), len * 0.16, 1.2 + rng() * 0.9,
      rng() < 0.25 ? pal.accent : pal.canopy);
    _q.setFromAxisAngle(Y, a).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.55 + rng() * 0.6));
    parts.push(place(f, 0, 0.02, 0, _q.clone()));
  }
  return mergeGeos(parts);
}

function buildPodPlant(rng, pal) {
  const parts = [];
  const n = 1 + (rng() * 2.4) | 0;
  for (let i = 0; i < n; i++) {
    const h = 0.55 + rng() * 0.6;
    const t = bentTube(rng, pal, h, 0.03, 0.018,
      (rng() - 0.5) * 0.9, (rng() - 0.5) * 0.9, pal.trunk, 4, 5);
    parts.push(...t.parts);
    parts.push(place(blob(rng, 0.1 + rng() * 0.07, pal.accent), t.top.x, t.top.y + 0.05, t.top.z));
  }
  return { geo: mergeGeos(parts), glow: pal.accent.clone() };
}

function buildGrassTuft(rng) {
  // real blades (white — each instance is tinted from the ground beneath it)
  const white = new THREE.Color(1, 1, 1);
  const parts = [];
  const n = 4 + (rng() * 2) | 0;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng();
    const f = frond(rng, 0.5 + rng() * 0.3, 0.05, 0.8 + rng() * 0.8, white);
    _q.setFromAxisAngle(Y, a).multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.25 + rng() * 0.35));
    parts.push(place(f, (rng() - 0.5) * 0.14, 0, (rng() - 0.5) * 0.14, _q.clone()));
  }
  return mergeGeos(parts);
}

function floraPalette(planet, rng) {
  const base = (planet.pal.forest || planet.pal.land[Math.min(2, planet.pal.land.length - 1)].c).clone();
  // alien hue drift: exotic/toxic worlds shift hard, lush worlds sometimes
  const shift = planet.type === 'exotic' ? 0.15 + rng() * 0.5
    : planet.type === 'toxic' ? 0.1 + rng() * 0.3
      : rng() < 0.4 ? 0.06 + rng() * 0.24 : (rng() - 0.5) * 0.08;
  const canopy = base.clone().offsetHSL(shift, 0.18, 0.06);
  const canopy2 = canopy.clone().offsetHSL(0.3 + rng() * 0.35, 0.05, (rng() - 0.5) * 0.1);
  const trunk = (planet.pal.rock || base).clone()
    .lerp(new THREE.Color(0.24, 0.15, 0.1), 0.45 + rng() * 0.3);
  const accent = new THREE.Color().setHSL(rng(), 0.85, 0.58);
  return { canopy, canopy2, trunk, accent };
}

// every geometry here is a pure function of the planet seed
export function buildFlora(planet) {
  const rng = makeRng(planet.seed + ':flora');
  const pal = floraPalette(planet, rng);
  const pod = buildPodPlant(rng, pal);
  return {
    tree0: buildTree(rng, pal, pal.canopy),
    tree1: buildTree(rng, pal, pal.canopy2),
    shrub: buildShrub(rng, pal),
    pod: pod.geo,
    podGlow: pod.glow,
    grass: buildGrassTuft(rng),
  };
}
