// Cockpit shell — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/frame.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { mergeGeos, sweepProfile, rectProfile, xf, mat } from '../../loft.js';
import { bevelBox, greebleField } from '../../prims.js';
import { makeCanopyGlass, bindGlass } from './glass.js';

/* ------------------------------------------------------------------ *
 *  COCKPIT SHELL  —  glazing, frames, sill, coaming, roof, coves.
 *
 *  Every part here is placed by (z, ringIndex) on the shared surface in
 *  datum.js and pushed out along the local normal by half its own
 *  thickness, so it SITS ON the skin by construction.  Nothing is
 *  positioned by an absolute triple, which is the whole difference from
 *  the file this replaces: a frame member cannot float off the glass or
 *  sink into it, because its position is not an independent number.
 * ------------------------------------------------------------------ */

class Bin {
  constructor() {
    this.m = new Map();
  }
  add(key, g) {
    let a = this.m.get(key);
    if (!a) this.m.set(key, (a = []));
    a.push(g);
  }
  /** the same part on both sides, built from the mirrored ring index */
  flush(parent, mats, cast = true) {
    const out = [];
    for (const [k, list] of this.m) {
      const mesh = new THREE.Mesh(mergeGeos(list), mats[k]);
      mesh.castShadow = cast;
      mesh.receiveShadow = cast;
      mesh.name = 'cockpit-' + k;
      parent.add(mesh);
      out.push(mesh);
    }
    this.m.clear();
    return out;
  }
}

/** a frame member run along the surface at constant ring index */
function railZ(
  B, SKIN, key, ri, z0, z1,
  halfW, halfD, off,
) {
  const { path, ups } = SKIN.runZ(ri, z0, z1, 0.16, off);
  B.add(key, sweepProfile(path, ups, rectProfile(halfW, halfD, 0.32)));
}

/** a frame member run across the surface at constant z */
function railRing(
  B, SKIN, key, z, ri0, ri1,
  halfW, halfD, off,
) {
  const { path, ups } = SKIN.runRing(z, ri0, ri1, 0.4, off);
  B.add(key, sweepProfile(path, ups, rectProfile(halfW, halfD, 0.32)));
}

export function buildShell(M, D) {
  const group = new THREE.Group();
  group.name = 'cockpit-shell';
  const B = new Bin();
  const mats = M;
  const {
    SKIN, GLAZE, PANES, WS_AFT, GZ_FWD, GZ_AFT, RI_SILL, RI_ROOF,
    COVE_X, COVE_Y, COVE_Z0, COVE_Z1, LAMPS,
  } = D;

  /* ---------------- glazing ---------------------------------------- *
   *  One merged mesh for all panes: a single draw call, and because each
   *  pane carries its own 0..1 uv the shader still measures "metres from
   *  the edge of THIS pane", so the printed frit border and the seal
   *  grime print round every pane rather than round the whole canopy. */
  const panes = PANES.map((p) =>
    GLAZE.patch(p.z0, p.z1, p.ri0, p.ri1, 0, p.nz ?? 3, p.nr ?? 3, false, true),
  );
  // The source demo exposes the canopy against a dark nebula under AgX 0.95.
  // 深空 now shares that highlight roll-off but also frames bright planets,
  // so the plate keeps a little more clean-centre coverage: visibly present,
  // never an opaque cyan screen.
  const glassMat = makeCanopyGlass(LAMPS, {
    spanU: 2.2, spanV: 2.0, rim: 0.30, envGain: 0.92,
    lamp: 1.15, cover: 0.23, coverLum: 0.76, sheen: 1.12,
  });
  const glass = new THREE.Mesh(mergeGeos(panes), glassMat);
  glass.name = 'canopy-glazing';
  glass.renderOrder = 6;
  bindGlass(glass, glassMat);
  group.add(glass);

  /* ---------------- solid roof over the head ----------------------- *
   *  This is what the old layout had no room for.  Outer skin plus an
   *  inner liner, so the roof reads as a thickness from both sides.
   *
   *  The liner's `flip` is FALSE, which looks wrong and is not: for this
   *  band's (z, ring) parameterisation `Surf.patch` already winds toward the
   *  cabin, so passing true turned the roof inside out.  It still RENDERED,
   *  because M.liner is DoubleSide — but its normals then pointed out into
   *  space, so the ceiling over the pilot's head was being lit by the star
   *  instead of by the two coves 30 cm from it, and read as a flat grey lid.
   *  Measured with tools/holes.mjs: 98 of 798 rays from a walk-height eye
   *  hit this surface from BEHIND before the change, 0 after. */
  B.add('hull', GLAZE.patch(WS_AFT, GZ_AFT, -RI_ROOF, RI_ROOF, 0, 4, 5));
  B.add('liner', SKIN.patch(WS_AFT, GZ_AFT, -RI_ROOF, RI_ROOF, 0, 4, 5, false));

  /* ---- ceiling panelling over the head ---------------------------- *
   *  The bare liner patch measured 2.4% of the walk view as a featureless
   *  region (tools/blank.mjs).  A pressure-hull ceiling is not one moulded
   *  sheet: it is removable acoustic panels on a frame, with the fasteners
   *  and the frame visible because that is how you get at the loom above.
   *  Panels are placed on the surface, so they follow the roof's curve. */
  {
    const nz = 4, nr = 3;
    for (let i = 0; i < nz; i++) {
      const z = WS_AFT + ((GZ_AFT - WS_AFT) * (i + 0.5)) / nz;
      /* transverse frame between panel bays */
      railRing(B, SKIN, 'trim', WS_AFT + ((GZ_AFT - WS_AFT) * i) / nz, -RI_ROOF, RI_ROOF, 0.035, 0.022, -0.030);
      for (let j = 0; j < nr; j++) {
        const ri = -RI_ROOF + ((2 * RI_ROOF) * (j + 0.5)) / nr;
        const m = SKIN.place(z, ri, -0.020, 0);
        B.add('liner', xf(bevelBox(0.62, 0.022, 0.72, 0.010), m));
        B.add('darkMetal', xf(greebleField(0.5, 0.58, 4, 1200 + i * 5 + j, 0.014), SKIN.place(z, ri, -0.044, 0)));
        for (const dx of [-0.26, 0.26]) {
          for (const dz of [-0.31, 0.31]) {
            B.add('brushed', xf(new THREE.CylinderGeometry(0.010, 0.012, 0.012, 8),
              SKIN.place(z + dz, ri + dx * 1.6, -0.050, 0)));
          }
        }
      }
    }
    railRing(B, SKIN, 'trim', GZ_AFT - 0.02, -RI_ROOF, RI_ROOF, 0.035, 0.022, -0.030);
    /* the loom the panels hide, glimpsed along the centreline gap */
    for (const ri of [-RI_ROOF / 3, RI_ROOF / 3]) {
      railZ(B, SKIN, 'rubber', ri, WS_AFT + 0.1, GZ_AFT - 0.1, 0.022, 0.022, -0.048);
    }
  }

  /* ---------------- glazing frames --------------------------------- *
   *  Outside: the retaining strips that hold the panes down, standing
   *  proud of the skin.  Inside: the trim caps.  Both derive from the
   *  same pane boundaries, so a mullion is always exactly on a seam. */
  /* Frame strips stand proud of the OUTER skin, but Surf.runZ/place measure
     their offset from the surface they were constructed on — SKIN, which is
     already inset by the liner thickness.  So every "push out" here is that
     thickness plus the part's own half-depth.  It is read from the datum
     rather than written as 0.14 because the three hulls have different
     plating. */
  const INSET = SKIN.inset;
  const OUT = 0.034;   // strip half-depth, pushed out by the same amount
  const IN = -0.05;    // inner cap, pushed in

  /* longitudinal mullions of the windscreen */
  for (const ri of [-RI_SILL, -2.6, 2.6, RI_SILL]) {
    railZ(B, SKIN, 'brushed', ri, GZ_FWD, WS_AFT, 0.038, OUT, INSET + OUT);
    railZ(B, SKIN, 'trim', ri, GZ_FWD, WS_AFT, 0.05, 0.032, INSET + IN);
  }
  /* longitudinal mullions of the side lights */
  for (const ri of [-RI_SILL, -RI_ROOF, RI_ROOF, RI_SILL]) {
    railZ(B, SKIN, 'brushed', ri, WS_AFT, GZ_AFT, 0.034, OUT, INSET + OUT);
    railZ(B, SKIN, 'trim', ri, WS_AFT, GZ_AFT, 0.046, 0.03, INSET + IN);
  }
  /* transverse frames: the two ends of the windscreen and the side-light
     split, each running the full glazed width at that station */
  railRing(B, SKIN, 'brushed', GZ_FWD + 0.03, -RI_SILL, RI_SILL, 0.075, OUT, INSET + OUT);
  railRing(B, SKIN, 'trim', GZ_FWD + 0.03, -RI_SILL, RI_SILL, 0.09, 0.05, INSET + IN);
  railRing(B, SKIN, 'brushed', WS_AFT, -RI_SILL, RI_SILL, 0.062, OUT + 0.008, INSET + OUT);
  railRing(B, SKIN, 'trim', WS_AFT, -RI_SILL, RI_SILL, 0.075, 0.04, INSET + IN);
  for (const s of [-1, 1]) {
    railRing(B, SKIN, 'brushed', D.SIDE_LIGHTS[0].z1, s * RI_ROOF, s * RI_SILL, 0.045, OUT, INSET + OUT);
    railRing(B, SKIN, 'trim', D.SIDE_LIGHTS[0].z1, s * RI_ROOF, s * RI_SILL, 0.06, 0.035, INSET + IN);
    railRing(B, SKIN, 'brushed', GZ_AFT - 0.03, s * RI_ROOF, s * RI_SILL, 0.07, OUT, INSET + OUT);
  }

  /* bolt pads where a mullion crosses a frame — the cheapest thing that
     makes a frame read as fastened rather than drawn on */
  for (const ri of [-RI_SILL, -2.6, 2.6, RI_SILL]) {
    for (const z of [GZ_FWD + 0.03, WS_AFT]) {
      B.add('brushed', xf(bevelBox(0.16, 0.05, 0.16, 0.018), SKIN.place(z, ri, INSET + OUT + 0.02)));
    }
  }

  /* ---------------- sill and coaming ------------------------------- *
   *  The glazing lands on the fuselage shoulder 2.5 m outboard, so the
   *  sill is a structure against the hull wall, not part of the panel.
   *  A heavy beam under the glass edge, a padded bead inboard of it, and
   *  a kick panel below — which also hides the liner/glazing seam, the
   *  trick high-fidelity's sill rail uses. */
  for (const s of [-1, 1]) {
    const ri = s * RI_SILL;
    railZ(B, SKIN, 'darkMetal', ri, GZ_FWD, GZ_AFT, 0.16, 0.10, INSET - 0.10);
    railZ(B, SKIN, 'seatTrim', ri, GZ_FWD, GZ_AFT, 0.085, 0.075, INSET - 0.235);
    railZ(B, SKIN, 'hullAccent', ri, GZ_FWD + 0.4, GZ_AFT - 0.3, 0.05, 0.012, INSET - 0.02);
    /* The wall below the sill is already lined by interior.js (the hull skin
       offset inward over the cockpit span), so only the sill's own parts are
       added here — building the patch again would z-fight with it.

       There WAS a fourth rail here, a rubbing strake at ring RI_SILL + 1.1
       with an offset of 0.02.  Offsets on this surface are measured from the
       LINER, and its own half-depth was 0.025, so the bar spanned -0.005 to
       +0.045: five millimetres of it stood in the cabin and the rest was
       buried in the wall.  What that looks like is a razor-thin steel sheet
       lying flush along both walls and clipping through the bulkhead, which
       is exactly how it was reported.  A 7 cm bar cannot be made to read at
       that standoff, and the sill already has a beam, a padded bead and an
       accent line, so it is deleted rather than pushed out. */
  }

  /* ---------------- ceiling coves ---------------------------------- *
   *  Positions come from LAMPS, which is also what the glass reflects —
   *  so a cove and its reflection cannot end up in different places. */
  for (const l of LAMPS.slice(0, 2)) {
    const dir = new THREE.Vector3().subVectors(l.b, l.a);
    const len = dir.length();
    const mid = new THREE.Vector3().addVectors(l.a, l.b).multiplyScalar(0.5);
    /* housing above the strip, so the strip is seen as a lit slot */
    B.add('trim', xf(bevelBox(0.19, 0.13, len, 0.03), mat(mid.x, mid.y + 0.075, mid.z)));
    B.add('strip', xf(new THREE.PlaneGeometry(0.13, len).rotateX(Math.PI / 2), mat(mid.x, mid.y + 0.005, mid.z)));
    B.add('trim', xf(bevelBox(0.05, 0.09, len, 0.015), mat(mid.x + 0.085 * Math.sign(mid.x || 1), mid.y + 0.02, mid.z)));
  }
  /* ceiling spine between the coves, with the overhead panel's mounts */
  B.add('liner', xf(bevelBox(2 * COVE_X - 0.24, 0.09, COVE_Z0 - COVE_Z1, 0.03),
    mat(0, COVE_Y + 0.16, (COVE_Z0 + COVE_Z1) / 2)));
  for (let z = COVE_Z1 + 0.3; z < COVE_Z0 - 0.2; z += 0.52) {
    B.add('darkMetal', xf(bevelBox(2 * COVE_X - 0.3, 0.06, 0.11, 0.02), mat(0, COVE_Y + 0.11, z)));
  }

  /* The frames CAST.
     They did not, and that is what made the sunbeam on the flight-deck floor
     read as a blank untextured polygon: the canopy glazing deliberately does
     not cast (a transparent sheet would write a solid silhouette into the
     shadow map), so the star shines straight through the windscreen onto the
     deck — correctly — but with the mullions and header not casting either,
     the patch it made had no window pattern in it and no reason to be there.
     Measured with tools/hotspot.mjs: the star contributes 83 of the ~120
     luminance in that region, so it is by far the dominant light on the
     cockpit floor and it needs to arrive through a window frame. */
  const solid = B.flush(group, mats, true);
  return { group, glass, solid };
}
