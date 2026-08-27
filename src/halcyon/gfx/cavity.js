// Cavity bake — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/gfx/cavity.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';

/* ------------------------------------------------------------------ *
 *  CAVITY BAKE  —  ported from TheLongSilence's occupancy() /
 *  bakeSurface() in src/gfx/greeble.js.
 *
 *  THE GAP THIS CLOSES
 *
 *  The baked ORM tiles carry occlusion, but it is the occlusion of a 2 m
 *  square of plating — it knows nothing about THIS ship's geometry.  So
 *  every place two parts meet had no darkening at all: the panel meeting
 *  its carrier, a console standing on the deck, a leg touching the floor,
 *  a bolt pad lying on a frame.  Contact with no contact shadow is one of
 *  the strongest "kit of plastic parts" cues there is, and it is most of
 *  what still separated this from TLS, which ships a ray-traced kit_ao
 *  atlas baked with the whole ship assembled around every piece.
 *
 *  HOW
 *
 *  Rasterise every triangle into a coarse voxel grid, then for each vertex
 *  ask how much of two spherical shells around it is occupied.  The near
 *  shell finds a LIP, the far one finds a POCKET, so one pass yields both
 *  channels: enclosure (crevices) and exposure (edges).  O(1) per sample
 *  instead of a ray cast, which is why it runs at load instead of needing
 *  Blender.
 *
 *  The calibration detail is worth keeping verbatim from TLS, because the
 *  obvious version is wrong: normalising by percentiles alone adapts to
 *  ANY object, so a part that is nothing but struts has all its values
 *  within a few per cent of each other, and stretching that to 0..1
 *  paints the whole part as an exposed edge.  The absolute numbers are
 *  knowable — a flat plate sits near 0.3 of the shell occupied, a lip near
 *  0.15, a crevice past 0.5 — so the ramp is never allowed to be narrower
 *  than that, and a uniform object comes out uniform.
 * ------------------------------------------------------------------ */

/** 6 axes + 8 corners: enough directions for a shell average, cheap to sample */
const DIRS = (() => {
  const d = [];
  const push = (x, y, z) => {
    const l = Math.hypot(x, y, z);
    d.push(x / l, y / l, z / l);
  };
  push(1, 0, 0); push(-1, 0, 0);
  push(0, 1, 0); push(0, -1, 0);
  push(0, 0, 1); push(0, 0, -1);
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) push(sx, sy, sz);
  return d;
})();

export function occupancy(geos, cell = 0.05) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) continue;
    const a = p.array;
    for (let i = 0; i < a.length; i += 3) {
      if (a[i] < x0) x0 = a[i]; if (a[i] > x1) x1 = a[i];
      if (a[i + 1] < y0) y0 = a[i + 1]; if (a[i + 1] > y1) y1 = a[i + 1];
      if (a[i + 2] < z0) z0 = a[i + 2]; if (a[i + 2] > z1) z1 = a[i + 2];
    }
  }
  if (!isFinite(x0)) return null;
  /* margin, so a sample stepping off the geometry still lands in the grid */
  const pad = cell * 5;
  x0 -= pad; y0 -= pad; z0 -= pad; x1 += pad; y1 += pad; z1 += pad;
  const inv = 1 / cell;
  const nx = Math.max(2, Math.min(400, Math.ceil((x1 - x0) * inv)));
  const ny = Math.max(2, Math.min(400, Math.ceil((y1 - y0) * inv)));
  const nz = Math.max(2, Math.min(400, Math.ceil((z1 - z0) * inv)));
  const data = new Uint8Array(nx * ny * nz);

  const mark = (x, y, z) => {
    const i = ((x - x0) * inv) | 0, j = ((y - y0) * inv) | 0, k = ((z - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return;
    data[(k * ny + j) * nx + i] = 1;
  };
  /* rasterise each triangle at better than one sample per voxel */
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) continue;
    const a = p.array;
    const idx = g.index ? g.index.array : null;
    const n = idx ? idx.length : p.count;
    for (let t = 0; t + 2 < n; t += 3) {
      const i0 = (idx ? idx[t] : t) * 3;
      const i1 = (idx ? idx[t + 1] : t + 1) * 3;
      const i2 = (idx ? idx[t + 2] : t + 2) * 3;
      const ax = a[i0], ay = a[i0 + 1], az = a[i0 + 2];
      const bx = a[i1], by = a[i1 + 1], bz = a[i1 + 2];
      const cx = a[i2], cy = a[i2 + 1], cz = a[i2 + 2];
      const e = Math.max(
        Math.hypot(bx - ax, by - ay, bz - az),
        Math.hypot(cx - ax, cy - ay, cz - az),
        Math.hypot(cx - bx, cy - by, cz - bz));
      const s = Math.min(10, Math.max(1, Math.ceil(e * inv * 1.4)));
      for (let u = 0; u <= s; u++) {
        for (let v = 0; v <= s - u; v++) {
          const wu = u / s, wv = v / s, ww = 1 - wu - wv;
          mark(ax * ww + bx * wu + cx * wv,
            ay * ww + by * wu + cy * wv,
            az * ww + bz * wu + cz * wv);
        }
      }
    }
  }
  return { x0, y0, z0, inv, nx, ny, nz, data, cell };
}

/**
 * Write `aCav` — (enclosure, exposedEdge) — onto every geometry in the list,
 * calibrated across all of them at once so "flat plate" means the same thing
 * everywhere.  Must be called AFTER merging: mergeGeometries compares the
 * attribute set and refuses a mixed list.
 */
export function bakeCavity(geos, grid) {
  if (!grid) return;
  const { x0, y0, z0, inv, nx, ny, nz, data, cell } = grid;
  const at = (x, y, z) => {
    const i = ((x - x0) * inv) | 0, j = ((y - y0) * inv) | 0, k = ((z - z0) * inv) | 0;
    if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return 0;
    return data[(k * ny + j) * nx + i];
  };
  /* two shells: the near one finds a lip, the far one finds a pocket */
  const R = [cell * 1.7, cell * 3.6];
  const W = [0.62, 0.38];
  const nd = DIRS.length / 3;

  /* one value per distinct position — a de-indexed merge carries each corner
     three or four times and the answer is identical every time */
  const seen = new Map();
  const enc = [];
  const key = (x, y, z) =>
    (Math.round(x * 200) + 65536) * 17179869184
    + (Math.round(y * 200) + 65536) * 131072
    + (Math.round(z * 200) + 65536);

  const perGeo = [];
  for (const g of geos) {
    const p = g.attributes.position;
    if (!p) { perGeo.push(null); continue; }
    const a = p.array;
    const ids = new Int32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const x = a[i * 3], y = a[i * 3 + 1], z = a[i * 3 + 2];
      const k = key(x, y, z);
      let id = seen.get(k);
      if (id === undefined) {
        id = enc.length;
        seen.set(k, id);
        let s = 0, tot = 0;
        for (let r = 0; r < R.length; r++) {
          const rr = R[r], w = W[r];
          for (let d = 0; d < nd; d++) {
            s += w * at(x + DIRS[d * 3] * rr, y + DIRS[d * 3 + 1] * rr, z + DIRS[d * 3 + 2] * rr);
            tot += w;
          }
        }
        enc.push(s / tot);
      }
      ids[i] = id;
    }
    perGeo.push(ids);
  }
  if (!enc.length) return;

  const sorted = Float32Array.from(enc).sort();
  const q = (t) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(t * (sorted.length - 1))))];
  const flatA = q(0.62), flatB = q(0.42);
  /* the floors under the span are the whole point — see the header */
  const deep = Math.max(flatA + 0.13, q(0.97));
  const lip = Math.min(flatB - 0.13, q(0.03));

  const out = new Float32Array(enc.length * 2);
  for (let i = 0; i < enc.length; i++) {
    const e = enc[i];
    const a = Math.min(1, Math.max(0, (e - flatA) / (deep - flatA)));
    const b = Math.min(1, Math.max(0, (flatB - e) / (flatB - lip)));
    out[i * 2] = a * a * (3 - 2 * a);
    /* Steeper than TLS's 2.3.  An exposed-edge term only means anything on
       the last couple of per cent of a surface; at 2.3, over a grid that
       spans a whole 27 m ship, every large open bulkhead landed in the low
       tail of the enclosure distribution and the entire wall was lightened as
       if it were a chamfer — which washed the cabin out.  This is the failure
       mode the calibration comment above describes, one level up: not a
       uniform PART, but a uniform ROOM. */
    out[i * 2 + 1] = Math.pow(b, 4.2);
  }

  for (let gi = 0; gi < geos.length; gi++) {
    const ids = perGeo[gi];
    if (!ids) continue;
    const buf = new Uint8Array(ids.length * 2);
    for (let i = 0; i < ids.length; i++) {
      buf[i * 2] = (out[ids[i] * 2] * 255) | 0;
      buf[i * 2 + 1] = (out[ids[i] * 2 + 1] * 255) | 0;
    }
    geos[gi].setAttribute('aCav', new THREE.BufferAttribute(buf, 2, true));
  }
}

/** collect the geometries of every mesh under a node, for one shared bake */
export function collectGeometries(root) {
  const out = [];
  root.traverse((o) => {
    const m = o;
    if (m.isMesh && m.geometry && m.geometry.attributes.position) out.push(m.geometry);
  });
  return out;
}
