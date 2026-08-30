// Interior clip — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/clip.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { sectionAt, widthAtY } from '../loft.js';

/* ------------------------------------------------------------------ *
 *  INTERIOR CLIP
 *
 *  Every appendage on this ship is a loft whose ROOT section is buried
 *  inside the fuselage, because that is the only way to guarantee no gap
 *  opens at the join.  The strake's root is at x 1.30, the wing's at 1.90,
 *  and the engine pods run from x 1.78 outboard.
 *
 *  On a ship whose y = 0 is the interior DECK, "buried inside the fuselage"
 *  is not hidden at all: it is standing in the cabin.  Measured with
 *  tools/intrude.mjs, 1352 exterior triangles were inside the habitable
 *  volume — the strake's root top surface sat 6 to 30 cm ABOVE the flight
 *  deck as a pale sheet along both walls, running the length of its chord
 *  and straight through the aft bulkhead.  That is the "2 侧贴边、穿透隔墙、
 *  纯单面的薄钢板" in the report, and the engine pods' inboard flanks (with
 *  their plating and their navigation strips) were doing the same thing in
 *  the cargo hold.
 *
 *  Rather than move five roots by hand and re-check the silhouette five
 *  times, the whole exterior is passed through one filter: drop every
 *  triangle whose centroid lies INSIDE the cabin liner.  Nothing there can
 *  ever be seen from outside — the liner is between it and the skin — so
 *  the exterior cannot change, and the interior cannot be invaded again.
 *
 *  The margin is what keeps the hull's OWN skin: the clip surface is the
 *  liner pulled a further `SAFE` inboard, so a triangle has to be well
 *  inside the liner to be dropped, not merely at it.
 * ------------------------------------------------------------------ */

const SAFE = 0.05;

/**
 * A predicate for "this point is inside the pressure cabin".
 *
 * Forward of the bulkhead the cabin wall is the hull skin offset inward by
 * `linerFwd`; aft of it the wall is the independent cabin loft.
 */
export function insideCabin(def, linerFwd = 0.14) {
  const D = def.dims;
  return (x, y, z) => {
    if (z < D.canopyFront || z > D.holdEndZ) return false;
    if (y < D.deckY - 0.04) return false;
    const aft = z >= D.bulkheadZ;
    const spec = sectionAt(aft ? def.cabin : def.hull, z);
    const inset = aft ? 0.0 : linerFwd;
    if (y > spec.yTop - inset - SAFE) return false;
    const wall = widthAtY(spec, y) - inset;
    if (wall <= 0) return false;
    return Math.abs(x) < wall - SAFE;
  };
}

/**
 * Rewrite a mesh's geometry without the triangles whose centroid satisfies
 * `inside`.  Returns how many were dropped.
 *
 * The geometry the exterior builds is always non-indexed (mergeGeos calls
 * toNonIndexed), but the indexed case is handled so this cannot silently
 * do nothing if that ever changes.
 */
export function dropTrisInside(mesh, inside) {
  const geo = mesh.geometry;
  const src = geo.index ? geo.toNonIndexed() : geo;
  const pos = src.getAttribute('position');
  const tris = pos.count / 3;
  const keep = new Array(tris);
  let dropped = 0;
  for (let t = 0; t < tris; t++) {
    const i = t * 3;
    const cx = (pos.getX(i) + pos.getX(i + 1) + pos.getX(i + 2)) / 3;
    const cy = (pos.getY(i) + pos.getY(i + 1) + pos.getY(i + 2)) / 3;
    const cz = (pos.getZ(i) + pos.getZ(i + 1) + pos.getZ(i + 2)) / 3;
    const bad = inside(cx, cy, cz);
    keep[t] = !bad;
    if (bad) dropped++;
  }
  if (!dropped) { if (src !== geo) src.dispose(); return 0; }

  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(src.attributes)) {
    const a = src.getAttribute(name);
    const it = a.itemSize;
    const arr = new Float32Array((tris - dropped) * 3 * it);
    let w = 0;
    for (let t = 0; t < tris; t++) {
      if (!keep[t]) continue;
      for (let v = 0; v < 3; v++) {
        const s = (t * 3 + v) * it;
        for (let c = 0; c < it; c++) arr[w++] = a.array[s + c];
      }
    }
    out.setAttribute(name, new THREE.Float32BufferAttribute(arr, it));
  }
  mesh.geometry = out;
  geo.dispose();
  if (src !== geo) src.dispose();
  return dropped;
}

/**
 * Clip every mesh that is a DIRECT child of the exterior group.
 *
 * Direct children only, deliberately: the cargo ramp lives under a pivot
 * that rotates, so its vertices are not in ship coordinates and testing
 * them against a ship-space volume would be meaningless.  The ramp is aft
 * of holdEndZ anyway, which the predicate already excludes.
 */
export function clipExteriorToCabin(group, def) {
  const inside = insideCabin(def);
  let total = 0;
  for (const child of group.children) {
    const m = child;
    if (!m.isMesh) continue;
    /* Instanced meshes store authored transforms outside the shared geometry.
       Feeding their local template into a ship-space cabin predicate corrupts
       every instance identically — engine throat circles were literally cut
       in half at local y=0.  This clipper has no instance-transform contract,
       so instanced exterior systems must remain owned by their builders. */
    if (m.isInstancedMesh) continue;
    total += dropTrisInside(m, inside);
  }
  return total;
}
