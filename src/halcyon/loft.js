// Loft engine — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/loft.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  LOFT ENGINE
 *  ------------------------------------------------------------------
 *  Every major hull component of the ship (fuselage, nacelles, wings,
 *  fins, ramp, canopy glass) is generated from a single lofted
 *  cross-section pipeline.  Because all components share one vertex
 *  grid, sub-surfaces extracted from that grid (canopy glass, the
 *  cargo ramp, accent trim strips) are *exactly* coincident with the
 *  hull — mathematically impossible to have gaps, floating parts or
 *  z-fighting seams.
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} SectionSpec
 * @property {number} at position along the loft axis
 * @property {number} [off] lateral offset of the section inside its own plane (sweep / stagger)
 * @property {number} yTop
 * @property {number} yBot
 * @property {number} w max half-width
 * @property {number} wTop half-width of the top flat
 * @property {number} wBot half-width of the bottom flat
 * @property {number} chTop vertical drop from yTop before the section reaches full width
 * @property {number} chBot vertical rise from yBot before the section reaches full width
 * @property {number} [rTop] 0 = crisp chamfer, 1 = fully rounded shoulder
 * @property {number} [rBot] 0 = crisp chamfer, 1 = fully rounded shoulder
 * @property {boolean} [sharp] force linear (non-spline) interpolation across the adjacent spans
 */

/* -- ring topology ------------------------------------------------- */
/* right half: A(top centre) B(top flat end) C(upper shoulder)
                D(lower shoulder) E(bottom flat end) F(bottom centre) */
const N_AB = 4;
const N_BC = 6;
const N_CD = 4;
const N_DE = 6;
const N_EF = 5;
export const HALF = N_AB + N_BC + N_CD + N_DE + N_EF; // 25
export const RING = HALF * 2 - 2; // 48

/** ring edge indices covered by the canopy / dorsal glazing band */
export const EDGES_TOP = [];
/** ring edge indices covered by the flat belly (the cargo ramp lives here) */
export const EDGES_BELLY = [];
/** ring edge indices of the vertical flanks */
export const EDGES_SIDE = [];
{
  const topEnd = N_AB + N_BC - 1; // 9  (point index of C)
  for (let e = 0; e < RING; e++) {
    const a = e;
    const b = (e + 1) % RING;
    const ra = a < HALF ? a : RING - a;
    const rb = b < HALF ? b : RING - b;
    const m = Math.max(ra, rb);
    if (m <= topEnd) EDGES_TOP.push(e);
    else if (m >= N_AB + N_BC + N_CD + N_DE) EDGES_BELLY.push(e);
    else EDGES_SIDE.push(e);
  }
}
const inSet = (s) => {
  const set = new Set(s);
  return (e) => set.has(e);
};
export const isTopEdge = inSet(EDGES_TOP);
export const isBellyEdge = inSet(EDGES_BELLY);
export const isSideEdge = inSet(EDGES_SIDE);

/* -- section sampling ---------------------------------------------- */
const lerp = (a, b, t) => a + (b - a) * t;
function qbez(p0, p1, p2, t) {
  const m = 1 - t;
  return p0 * m * m + 2 * p1 * m * t + p2 * t * t;
}

/** samples one closed section ring: RING points, index 0 = top centre */
export function sampleSection(s) {
  const rT = s.rTop ?? 0.45;
  const rB = s.rBot ?? 0.45;
  const half = [];

  const A = new THREE.Vector2(0, s.yTop);
  const B = new THREE.Vector2(s.wTop, s.yTop);
  const C = new THREE.Vector2(s.w, s.yTop - s.chTop);
  const D = new THREE.Vector2(s.w, s.yBot + s.chBot);
  const E = new THREE.Vector2(s.wBot, s.yBot);
  const F = new THREE.Vector2(0, s.yBot);

  for (let i = 0; i < N_AB; i++) {
    const t = i / N_AB;
    half.push(new THREE.Vector2(lerp(A.x, B.x, t), lerp(A.y, B.y, t)));
  }
  const kBC = new THREE.Vector2(s.w, s.yTop);
  const cBC = new THREE.Vector2(
    lerp((B.x + C.x) / 2, kBC.x, rT),
    lerp((B.y + C.y) / 2, kBC.y, rT),
  );
  for (let i = 0; i < N_BC; i++) {
    const t = i / N_BC;
    half.push(new THREE.Vector2(qbez(B.x, cBC.x, C.x, t), qbez(B.y, cBC.y, C.y, t)));
  }
  for (let i = 0; i < N_CD; i++) {
    const t = i / N_CD;
    half.push(new THREE.Vector2(lerp(C.x, D.x, t), lerp(C.y, D.y, t)));
  }
  const kDE = new THREE.Vector2(s.w, s.yBot);
  const cDE = new THREE.Vector2(
    lerp((D.x + E.x) / 2, kDE.x, rB),
    lerp((D.y + E.y) / 2, kDE.y, rB),
  );
  for (let i = 0; i < N_DE; i++) {
    const t = i / N_DE;
    half.push(new THREE.Vector2(qbez(D.x, cDE.x, E.x, t), qbez(D.y, cDE.y, E.y, t)));
  }
  for (let i = 0; i < N_EF; i++) {
    const t = i / (N_EF - 1);
    half.push(new THREE.Vector2(lerp(E.x, F.x, t), lerp(E.y, F.y, t)));
  }

  const ring = half.slice();
  for (let i = HALF - 2; i >= 1; i--) ring.push(new THREE.Vector2(-half[i].x, half[i].y));
  return ring;
}

/**
 * Half-width of a section AT A GIVEN HEIGHT, measured on the sampled ring.
 *
 * `SectionSpec.w` is the section's MAXIMUM half-width, reached only between
 * the upper and lower shoulders.  Using it as "how wide is the ship here"
 * is wrong everywhere else, and wrong by a lot near the belly round — which
 * is exactly where y = 0 sits, because y = 0 is this ship's interior DECK.
 */
export function widthAtY(s, y) {
  const ring = sampleSection(s);
  let best = -1;
  /* indices 0 .. HALF-1 are the right half, top centre down to bottom centre */
  for (let i = 0; i < HALF - 1; i++) {
    const a = ring[i], b = ring[i + 1];
    if (a.y === b.y) { if (Math.abs(a.y - y) < 1e-6) best = Math.max(best, a.x, b.x); continue; }
    const t = (y - a.y) / (b.y - a.y);
    if (t < 0 || t > 1) continue;
    best = Math.max(best, a.x + (b.x - a.x) * t);
  }
  return best;
}

/** outward 2-D normals of a ring */
function ringNormals(ring) {
  const n = [];
  const L = ring.length;
  for (let i = 0; i < L; i++) {
    const p = ring[(i - 1 + L) % L];
    const q = ring[(i + 1) % L];
    const tx = q.x - p.x;
    const ty = q.y - p.y;
    const v = new THREE.Vector2(-ty, tx);
    if (v.lengthSq() < 1e-12) v.set(ring[i].x, ring[i].y);
    n.push(v.normalize());
  }
  return n;
}

/* -- key-frame interpolation --------------------------------------- */
const FIELDS = ['off', 'yTop', 'yBot', 'w', 'wTop', 'wBot', 'chTop', 'chBot', 'rTop', 'rBot'];
const get = (s, f) => {
  const v = s[f];
  if (typeof v === 'number') return v;
  if (f === 'rTop' || f === 'rBot') return 0.45;
  return 0;
};
function catmull(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/** densify a key-frame list into a smooth, evenly stepped section list */
export function expandSections(keys, step = 0.28) {
  const out = [];
  for (let i = 0; i < keys.length - 1; i++) {
    const k1 = keys[i];
    const k2 = keys[i + 1];
    const k0 = keys[i - 1] ?? k1;
    const k3 = keys[i + 2] ?? k2;
    const span = Math.abs(k2.at - k1.at);
    const n = Math.max(1, Math.round(span / step));
    const linear = !!k1.sharp || !!k2.sharp;
    for (let j = 0; j < n; j++) {
      const t = j / n;
      const s = { at: lerp(k1.at, k2.at, t) };
      for (const f of FIELDS) {
        s[f] = linear
          ? lerp(get(k1, f), get(k2, f), t)
          : catmull(get(k0, f), get(k1, f), get(k2, f), get(k3, f), t);
      }
      out.push(s);
    }
  }
  out.push({ ...keys[keys.length - 1] });
  return out;
}

/* -- creased normals ----------------------------------------------- */
/** Averages face normals only across edges below the crease angle.
 *  Produces true hard-surface shading: smooth on curved panels,
 *  razor sharp on chamfers. */
export function creaseNormals(geo, angleDeg = 38) {
  const pos = geo.getAttribute('position');
  const count = pos.count;
  const faceN = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const cb = new THREE.Vector3();
  for (let f = 0; f < count / 3; f++) {
    a.fromBufferAttribute(pos, f * 3);
    b.fromBufferAttribute(pos, f * 3 + 1);
    c.fromBufferAttribute(pos, f * 3 + 2);
    cb.subVectors(c, b);
    ab.subVectors(a, b);
    faceN.push(cb.cross(ab).normalize().clone());
  }
  const buckets = new Map();
  const key = (i) =>
    `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
  for (let i = 0; i < count; i++) {
    const k = key(i);
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }
  const limit = Math.cos((angleDeg * Math.PI) / 180);
  const out = new Float32Array(count * 3);
  const acc = new THREE.Vector3();
  for (const arr of buckets.values()) {
    for (const i of arr) {
      const nf = faceN[(i / 3) | 0];
      acc.set(0, 0, 0);
      for (const j of arr) {
        const nj = faceN[(j / 3) | 0];
        if (nf.dot(nj) >= limit) acc.add(nj);
      }
      if (acc.lengthSq() < 1e-10) acc.copy(nf);
      acc.normalize();
      out[i * 3] = acc.x;
      out[i * 3 + 1] = acc.y;
      out[i * 3 + 2] = acc.z;
    }
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return geo;
}

/* -- the loft itself ------------------------------------------------ */

function place(axis, a, b, s, target) {
  if (axis === 'z') target.set(a, b, s);
  else if (axis === 'x') target.set(s, b, a);
  else target.set(b, s, a);
  return target;
}

export function buildLoft(sections, opt = {}) {
  const axis = opt.axis ?? 'z';
  const off = opt.offset ?? 0;
  const uvS = opt.uvScale ?? 1.6;
  const flip = opt.flipWinding ?? axis !== 'x';

  const rings = sections.map(sampleSection);
  const norms = rings.map(ringNormals);

  const pts = [];
  const us = [];
  const vs = [];
  let vAcc = 0;
  const tmp = new THREE.Vector3();

  for (let i = 0; i < sections.length; i++) {
    const sec = sections[i];
    const ring = rings[i];
    const nrm = norms[i];
    const row = [];
    const urow = [];
    let uAcc = 0;
    for (let j = 0; j < RING; j++) {
      const p = ring[j];
      const n = nrm[j];
      const a = p.x + n.x * off + (sec.off ?? 0);
      const b = p.y + n.y * off;
      row.push(place(axis, a, b, sec.at, tmp).clone());
      urow.push(uAcc / uvS);
      const q = ring[(j + 1) % RING];
      uAcc += Math.hypot(q.x - p.x, q.y - p.y);
    }
    urow.push(uAcc / uvS);
    pts.push(row);
    us.push(urow);
    if (i > 0) vAcc += Math.abs(sections[i].at - sections[i - 1].at);
    vs.push(vAcc / uvS);
  }

  const P = [];
  const U = [];
  const push = (v, u, w) => {
    P.push(v.x, v.y, v.z);
    U.push(u, w);
  };
  const quad = (
    p0, p1, p2, p3,
    u0, u1, v0, v1,
  ) => {
    if (!flip) {
      push(p0, u0, v0); push(p1, u1, v0); push(p2, u1, v1);
      push(p0, u0, v0); push(p2, u1, v1); push(p3, u0, v1);
    } else {
      push(p0, u0, v0); push(p2, u1, v1); push(p1, u1, v0);
      push(p0, u0, v0); push(p3, u0, v1); push(p2, u1, v1);
    }
  };

  for (let i = 0; i < sections.length - 1; i++) {
    if (opt.span && !opt.span(sections[i].at, sections[i + 1].at, i)) continue;
    for (let e = 0; e < RING; e++) {
      if (opt.edge && !opt.edge(e)) continue;
      const e2 = (e + 1) % RING;
      quad(
        pts[i][e], pts[i][e2], pts[i + 1][e2], pts[i + 1][e],
        us[i][e], us[i][e + 1], vs[i], vs[i + 1],
      );
    }
  }

  const cap = (idx, invert) => {
    const row = pts[idx];
    const centre = new THREE.Vector3();
    for (const p of row) centre.add(p);
    centre.multiplyScalar(1 / row.length);
    for (let e = 0; e < RING; e++) {
      const e2 = (e + 1) % RING;
      if (opt.edge && !opt.edge(e)) continue;
      const A = row[e], B = row[e2];
      const forward = invert !== flip;
      if (forward) { push(centre, 0.5, 0.5); push(B, 1, 0); push(A, 0, 0); }
      else { push(centre, 0.5, 0.5); push(A, 0, 0); push(B, 1, 0); }
    }
  };
  if (opt.capStart) cap(0, true);
  if (opt.capEnd) cap(sections.length - 1, false);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  creaseNormals(geo, opt.crease ?? 38);
  geo.computeBoundingSphere();
  return geo;
}

/* -- generic swept profile (frames, rails, pipes, trim) ------------- */
export function sweepProfile(
  path,
  up,
  profile,
  closed = false,
  crease = 30,
) {
  const n = path.length;
  const rows = [];
  const tangent = new THREE.Vector3();
  const side = new THREE.Vector3();
  const realUp = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const prev = path[Math.max(0, i - 1)];
    const next = path[Math.min(n - 1, i + 1)];
    tangent.subVectors(next, prev).normalize();
    realUp.copy(up[i]).normalize();
    side.crossVectors(realUp, tangent).normalize();
    realUp.crossVectors(tangent, side).normalize();
    const row = [];
    for (const p of profile) {
      row.push(
        new THREE.Vector3()
          .copy(path[i])
          .addScaledVector(side, p.x)
          .addScaledVector(realUp, p.y),
      );
    }
    rows.push(row);
  }
  const P = [];
  const U = [];
  const m = profile.length;
  const add = (v, u, w) => { P.push(v.x, v.y, v.z); U.push(u, w); };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % n;
    for (let j = 0; j < m; j++) {
      const j2 = (j + 1) % m;
      const a = rows[i][j], b = rows[i][j2], c = rows[i2][j2], d = rows[i2][j];
      add(a, j / m, i / n); add(b, (j + 1) / m, i / n); add(c, (j + 1) / m, (i + 1) / n);
      add(a, j / m, i / n); add(c, (j + 1) / m, (i + 1) / n); add(d, j / m, (i + 1) / n);
    }
  }
  if (!closed) {
    const capEnds = [[rows[0], true], [rows[n - 1], false]];
    for (const [row, inv] of capEnds) {
      const cen = new THREE.Vector3();
      for (const p of row) cen.add(p);
      cen.multiplyScalar(1 / row.length);
      for (let j = 0; j < m; j++) {
        const j2 = (j + 1) % m;
        if (inv) { add(cen, 0.5, 0.5); add(row[j], 0, 0); add(row[j2], 1, 0); }
        else { add(cen, 0.5, 0.5); add(row[j2], 1, 0); add(row[j], 0, 0); }
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(U, 2));
  creaseNormals(geo, crease);
  return geo;
}

/** rectangular sweep profile with chamfered corners */
export function rectProfile(w, h, chamfer = 0.25) {
  const cx = Math.min(w, h) * chamfer;
  return [
    new THREE.Vector2(-w + cx, -h), new THREE.Vector2(w - cx, -h),
    new THREE.Vector2(w, -h + cx), new THREE.Vector2(w, h - cx),
    new THREE.Vector2(w - cx, h), new THREE.Vector2(-w + cx, h),
    new THREE.Vector2(-w, h - cx), new THREE.Vector2(-w, -h + cx),
  ];
}

export function circleProfile(r, seg = 10) {
  const out = [];
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out.push(new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r));
  }
  return out;
}

/* -- geometry merge (no external deps) ------------------------------ */
export function mergeGeos(list) {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  let pc = 0;
  for (const g of parts) pc += g.getAttribute('position').count;
  const P = new Float32Array(pc * 3);
  const N = new Float32Array(pc * 3);
  const U = new Float32Array(pc * 2);
  let o = 0;
  for (const g of parts) {
    const p = g.getAttribute('position');
    let nAttr = g.getAttribute('normal');
    if (!nAttr) { g.computeVertexNormals(); nAttr = g.getAttribute('normal'); }
    const u = g.getAttribute('uv');
    for (let i = 0; i < p.count; i++) {
      P[(o + i) * 3] = p.getX(i); P[(o + i) * 3 + 1] = p.getY(i); P[(o + i) * 3 + 2] = p.getZ(i);
      N[(o + i) * 3] = nAttr.getX(i); N[(o + i) * 3 + 1] = nAttr.getY(i); N[(o + i) * 3 + 2] = nAttr.getZ(i);
      U[(o + i) * 2] = u ? u.getX(i) : 0; U[(o + i) * 2 + 1] = u ? u.getY(i) : 0;
    }
    o += p.count;
  }
  const geo = new THREE.BufferGeometry();
  /* DROP NON-FINITE TRIANGLES.
     ShapeGeometry's triangulator emits the occasional NaN vertex when an
     outline has coincident consecutive points, which every ring sampled from
     a section eventually does.  Two bad vertices out of six thousand are
     enough to make computeBoundingSphere() return NaN, and a NaN bounding
     sphere means the mesh is either never frustum-culled or always culled and
     raycasts against it silently return nothing — measured on int-liner with
     tools/nancheck.mjs.  One pass here covers every merged mesh in the ship
     rather than each producer having to be careful. */
  const tris = pc / 3;
  const good = new Uint8Array(tris).fill(1);
  let dropped = 0;
  for (let t = 0; t < tris; t++) {
    for (let k = t * 9; k < t * 9 + 9; k++) {
      if (Number.isFinite(P[k])) continue;
      good[t] = 0; dropped++; break;
    }
  }
  if (dropped) {
    const n = (tris - dropped) * 3;
    const P2 = new Float32Array(n * 3), N2 = new Float32Array(n * 3), U2 = new Float32Array(n * 2);
    let w = 0;
    for (let t = 0; t < tris; t++) {
      if (!good[t]) continue;
      for (let v = 0; v < 3; v++, w++) {
        const s = t * 3 + v;
        P2[w * 3] = P[s * 3]; P2[w * 3 + 1] = P[s * 3 + 1]; P2[w * 3 + 2] = P[s * 3 + 2];
        N2[w * 3] = N[s * 3]; N2[w * 3 + 1] = N[s * 3 + 1]; N2[w * 3 + 2] = N[s * 3 + 2];
        U2[w * 2] = U[s * 2]; U2[w * 2 + 1] = U[s * 2 + 1];
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(P2, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N2, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(U2, 2));
    geo.computeBoundingSphere();
    return geo;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  geo.computeBoundingSphere();
  return geo;
}

export function xf(g, m) {
  const c = g.clone();
  c.applyMatrix4(m);
  return c;
}

export function mat(
  px = 0, py = 0, pz = 0,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
) {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(px, py, pz),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
}

/** mirror a geometry across X (keeps winding correct) */
export function mirrorX(g) {
  const c = g.clone();
  const src = c.index ? c.toNonIndexed() : c;
  const p = src.getAttribute('position');
  const n = src.getAttribute('normal');
  const u = src.getAttribute('uv');
  const cnt = p.count;
  const P = new Float32Array(cnt * 3);
  const N = new Float32Array(cnt * 3);
  const U = new Float32Array(cnt * 2);
  for (let f = 0; f < cnt / 3; f++) {
    const order = [0, 2, 1];
    for (let k = 0; k < 3; k++) {
      const s = f * 3 + order[k];
      const d = f * 3 + k;
      P[d * 3] = -p.getX(s); P[d * 3 + 1] = p.getY(s); P[d * 3 + 2] = p.getZ(s);
      N[d * 3] = -n.getX(s); N[d * 3 + 1] = n.getY(s); N[d * 3 + 2] = n.getZ(s);
      U[d * 2] = u ? u.getX(s) : 0; U[d * 2 + 1] = u ? u.getY(s) : 0;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(U, 2));
  return geo;
}

/** world-space point of a section ring vertex (used to hang detail on the skin) */
export function ringPoint(sec, j, axis = 'z', offset = 0) {
  const ring = sampleSection(sec);
  const nrm = ringNormals(ring);
  const p = ring[j];
  const n = nrm[j];
  const v = new THREE.Vector3();
  place(axis, p.x + n.x * offset + (sec.off ?? 0), p.y + n.y * offset, sec.at, v);
  const nv = new THREE.Vector3();
  place(axis, n.x, n.y, 0, nv);
  return { pos: v, normal: nv.normalize() };
}

/** interpolate a section list at an arbitrary axis position */
export function sectionAt(sections, at) {
  if (at <= sections[0].at) return sections[0];
  const last = sections[sections.length - 1];
  if (at >= last.at) return last;
  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i], b = sections[i + 1];
    if (at >= a.at && at <= b.at) {
      const t = (at - a.at) / (b.at - a.at || 1);
      const s = { at };
      for (const f of FIELDS) s[f] = lerp(get(a, f), get(b, f), t);
      return s;
    }
  }
  return last;
}
