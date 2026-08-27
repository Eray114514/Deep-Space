// Cabin fittings — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/fittings.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { mergeGeos, sweepProfile, rectProfile, xf, mat } from '../loft.js';
import { bevelBox, frameRect } from '../prims.js';

/* ------------------------------------------------------------------ *
 *  CABIN FITTINGS
 *
 *  Reusable hardware for the habitable volume, built to the same three
 *  rules the flight station uses, because they are what separate
 *  "hardware" from "a kit of plastic parts":
 *
 *  1  NOTHING FLOATS.  Every unit stands on a plinth or hangs from a
 *     bracket that reaches a real surface.  The cabin was full of thin
 *     slabs hovering at waist height with nothing under them.
 *  2  FACES SIT IN RECESSES, with a shadow gap the cavity bake can find.
 *  3  CHAMFERS ARE PHYSICAL — 8 to 18 mm regardless of part size.  A
 *     chamfer that scales with the part is how CAD hobby models give
 *     themselves away; real hardware has a tool radius.
 *
 *  Plus one that only applies in here: a crewed volume is FULL.  Empty
 *  pale panels read as unfinished, so every unit carries fasteners,
 *  handles, labels and a service seam.
 * ------------------------------------------------------------------ */

/** four bolt pads on the corners of a w x d footprint, on the +Y face */
export function bolts(B, m, w, d, r = 0.02) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      B.add('brushed', xf(new THREE.CylinderGeometry(r, r * 1.15, 0.014, 8),
        m.clone().multiply(mat(sx * w * 0.5, 0.007, sz * d * 0.5))));
    }
  }
}

/** a face let into a carrier with a shadow gap round it */
export function recess(
  B, m, w, h,
  carrier = 'trim', face = 'blackMetal', depth = 0.022,
) {
  B.add(carrier, xf(bevelBox(w + 0.06, 0.045, h + 0.06, 0.011), m.clone().multiply(mat(0, -0.024, 0))));
  B.add('blackMetal', xf(bevelBox(w + 0.026, 0.028, h + 0.026, 0.008), m.clone().multiply(mat(0, -0.006, 0))));
  B.add(face, xf(bevelBox(w, depth, h, 0.008), m.clone().multiply(mat(0, 0.004, 0))));
}

/**
 * OPEN FLOOR GRATING — the single biggest change to how a deck reads.
 *
 * A flat plate with a tiling map on it is still a flat plate: TLS's notes
 * record forcing the deck to roughness 1 / metalness 0 and moving the frame
 * by 1.5 display levels out of 255, because what the eye was reading was
 * never the specular lobe — it was a smooth surface with a pool of light on
 * it.  The answer is relief, and real relief means you can see THROUGH it
 * to a tray below, which no texture can fake.
 *
 * Built as bars along z with cross-ties, over a recessed tray, so there is
 * genuine depth and genuine occlusion for the cavity bake to find.
 */
export function grating(
  B, x0, x1, z0, z1, y = 0,
  barPitch = 0.075, barW = 0.016, depth = 0.055,
) {
  const w = x1 - x0, d = z1 - z0;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  /* tray below, dark, so the gaps read as holes rather than as lines */
  B.add('blackMetal', xf(bevelBox(w, 0.02, d, 0.006), mat(cx, y - depth, cz)));
  /* longitudinal bars */
  const n = Math.max(2, Math.round(w / barPitch));
  for (let i = 0; i <= n; i++) {
    const x = x0 + (w * i) / n;
    B.add('darkMetal', xf(bevelBox(barW, depth * 0.85, d, 0.004), mat(x, y - depth * 0.42, cz)));
  }
  /* cross-ties every 0.42 m, set lower so the bars stay proud */
  const m2 = Math.max(1, Math.round(d / 0.42));
  for (let j = 0; j <= m2; j++) {
    const z = z0 + (d * j) / m2;
    B.add('darkMetal', xf(bevelBox(w, barW * 0.8, barW * 1.4, 0.003), mat(cx, y - depth * 0.72, z)));
  }
  /* bright kerb trim on all four edges — the highlight line that says the
     grating is a fitted panel and not a hole in the floor */
  for (const sx of [-1, 1]) {
    B.add('brushed', xf(bevelBox(0.028, 0.030, d, 0.008), mat(cx + sx * (w / 2 + 0.014), y - 0.012, cz)));
    B.add('brushed', xf(bevelBox(w + 0.056, 0.030, 0.028, 0.008), mat(cx, y - 0.012, cz + sx * (d / 2 + 0.014))));
  }
}

/**
 * A wall-mounted equipment rack.
 *
 * `place` is a matrix whose +Y is the wall's outward normal, so a rack
 * follows the hull's curve by construction — from Surf.place().
 */
export function rack(
  B, place, w, h, depth, seed,
) {
  /* carcass, standing off the liner on a visible sub-frame */
  B.add('trim', xf(bevelBox(w, depth, h, 0.014), place.clone().multiply(mat(0, depth / 2 + 0.02, 0))));
  B.add('darkMetal', xf(bevelBox(w - 0.06, 0.04, h - 0.06, 0.008), place.clone().multiply(mat(0, 0.02, 0))));
  bolts(B, place, w - 0.05, h - 0.05, 0.018);

  /* two service faces, one louvred, one blank with a handle */
  const face = place.clone().multiply(mat(0, depth + 0.02, 0));
  recess(B, face.clone().multiply(mat(0, 0, -h * 0.24)), w * 0.72, h * 0.36, 'trim', 'darkMetal', 0.018);
  const nL = Math.max(3, Math.round(h * 0.36 / 0.035));
  for (let i = 0; i < nL; i++) {
    B.add('blackMetal', xf(bevelBox(w * 0.66, 0.012, 0.016, 0.003),
      face.clone().multiply(mat(0, 0.026, -h * 0.24 - h * 0.16 + (i * h * 0.32) / nL))));
  }
  recess(B, face.clone().multiply(mat(0, 0, h * 0.26)), w * 0.72, h * 0.30, 'trim', 'trim', 0.018);
  B.add('brushed', xf(bevelBox(w * 0.30, 0.026, 0.03, 0.008), face.clone().multiply(mat(0, 0.03, h * 0.26))));
  /* a label plate, because unmarked hardware reads as unfinished */
  B.add('hullAccent', xf(bevelBox(w * 0.34, 0.008, 0.05, 0.004),
    face.clone().multiply(mat(-w * 0.16, 0.028, h * 0.44))));
  B.add(seed % 2 ? 'glowGreen' : 'glowAmber', xf(new THREE.SphereGeometry(0.013, 8, 6),
    face.clone().multiply(mat(w * 0.36, 0.03, h * 0.44))));
}

/**
 * A cargo container.
 *
 * The old version was a bevelled box with a frame on top.  What makes a
 * container read is the CORNER CASTINGS — the eight steel blocks every real
 * intermodal box is lifted and locked by — plus recessed door panels, a
 * latch bar and a stencilled face.
 */
export function crate(
  B, x, z, w, h, d, seed, spin = 0,
) {
  const base = mat(x, h / 2, z, 0, spin, 0);
  /* body, slightly inset from the corner castings so they stand proud */
  B.add('hullDark', xf(bevelBox(w - 0.06, h - 0.06, d - 0.06, 0.012), base));
  /* corrugated side panels: three recessed bays per long face */
  for (const sx of [-1, 1]) {
    for (let i = -1; i <= 1; i++) {
      B.add('hullDark', xf(bevelBox(0.03, h * 0.62, d * 0.26, 0.008),
        base.clone().multiply(mat(sx * (w / 2 - 0.05), 0, i * d * 0.3))));
    }
  }
  /* eight corner castings */
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) {
        B.add('darkMetal', xf(bevelBox(0.11, 0.11, 0.11, 0.014),
          base.clone().multiply(mat(sx * (w / 2 - 0.05), sy * (h / 2 - 0.05), sz * (d / 2 - 0.05)))));
      }
    }
  }
  /* door end: two leaves, a latch bar and a stencil */
  const door = base.clone().multiply(mat(0, 0, -d / 2 + 0.01, -Math.PI / 2));
  for (const sx of [-1, 1]) {
    B.add('trim', xf(bevelBox(w * 0.44, 0.022, h * 0.78, 0.008), door.clone().multiply(mat(sx * w * 0.23, 0.02, 0))));
  }
  B.add('brushed', xf(new THREE.CylinderGeometry(0.017, 0.017, h * 0.84, 10),
    base.clone().multiply(mat(0, 0, -d / 2 - 0.005))));
  B.add('hullAccent', xf(bevelBox(w * 0.5, 0.008, 0.07, 0.004), door.clone().multiply(mat(0, 0.032, h * 0.30))));
  /* top rails and a tie-down eye at each end */
  B.add('trim', sweepProfile(
    [new THREE.Vector3(x - w / 2 + 0.06, h, z), new THREE.Vector3(x + w / 2 - 0.06, h, z)],
    [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 1, 0)], rectProfile(0.022, 0.014, 0.3)));
  B.add('darkMetal', xf(frameRect(w * 0.7, d * 0.7, 0.03, 0.026), mat(x, h + 0.01, z, 0, spin, 0)));
  void seed;
}

/** merge a bin's buckets into one mesh per material */
export class Bucket {
  constructor() {
    this.m = new Map();
  }
  add(key, g) {
    let a = this.m.get(key);
    if (!a) this.m.set(key, (a = []));
    a.push(g);
  }
  flush(parent, mats, name = 'cabin') {
    const out = [];
    for (const [k, list] of this.m) {
      const mesh = new THREE.Mesh(mergeGeos(list), mats[k]);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.name = `${name}-${k}`;
      parent.add(mesh);
      out.push(mesh);
    }
    this.m.clear();
    return out;
  }
}
