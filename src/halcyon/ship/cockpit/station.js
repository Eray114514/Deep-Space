// Flight station — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/station.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { mergeGeos, sweepProfile, rectProfile, xf, mat } from '../../loft.js';
import { bevelBox, frameRect, greebleField, conduit } from '../../prims.js';

/* ------------------------------------------------------------------ *
 *  FLIGHT STATION  —  glareshield, main panel, side consoles, controls,
 *  overhead panel, outboard racks.
 *
 *  Three rules here, and between them they are most of the difference
 *  between hardware and a toy:
 *
 *  1  NOTHING FLOATS.  Every console has legs to the deck, every panel
 *     has a carrier behind it, every rack is bolted to the hull wall
 *     through SKIN.place() so it lies on the liner.  The old cockpit hung
 *     slabs in mid-air, which is what reads as plastic parts in a kit.
 *
 *  2  FACES SIT IN RECESSES.  A display or a switch plate is a smaller
 *     face inset into a carrier with a shadow gap round it, never a decal
 *     on a flat box.  The gap is what gives an edge somewhere to catch
 *     light, and baked AO in the ORM map darkens it for free.
 *
 *  3  CHAMFERS ARE PHYSICAL.  bevelBox's chamfer is held between 8 and
 *     18 mm regardless of part size, because a chamfer that scales with
 *     the part is exactly how CAD hobby models betray themselves — real
 *     hardware has a tool radius, not a proportion.
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
  flush(parent, mats) {
    const out = [];
    for (const [k, list] of this.m) {
      const mesh = new THREE.Mesh(mergeGeos(list), mats[k]);
      /* The station CASTS and RECEIVES.
         Both were false, so the panel, the consoles and the pedestal took no
         part in the shadow pass at all — nothing on the flight deck occluded
         the sunbeam coming through the windscreen, and nothing was seated in
         the room.  See the note on B.flush in frame.js. */
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'station-' + k;
      parent.add(mesh);
      out.push(mesh);
    }
    this.m.clear();
    return out;
  }
}

/** a face recessed into a carrier: carrier, shadow gap, then the face */
function recess(
  B, m, w, h,
  carrier = 'trim', face = 'blackMetal', depth = 0.026,
) {
  B.add(carrier, xf(bevelBox(w + 0.07, 0.05, h + 0.07, 0.012), m.clone().multiply(mat(0, -0.026, 0))));
  B.add('blackMetal', xf(bevelBox(w + 0.03, 0.03, h + 0.03, 0.008), m.clone().multiply(mat(0, -0.006, 0))));
  B.add(face, xf(bevelBox(w, depth, h, 0.008), m.clone().multiply(mat(0, 0.004, 0))));
}

/** four bolt pads on the corners of a w x d footprint */
function bolts(B, m, w, d, r = 0.022) {
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      B.add('brushed', xf(new THREE.CylinderGeometry(r, r * 1.15, 0.016, 8),
        m.clone().multiply(mat(sx * w * 0.5, 0.008, sz * d * 0.5))));
    }
  }
}

export function buildStation(M, D) {
  const group = new THREE.Group();
  group.name = 'cockpit-station';
  const B = new Bin();
  const mats = M;
  const screens = [];
  const {
    EYE, SKIN, PANEL_TOP, PANEL_BOT, PANEL_HALF_W,
    CONSOLE_X, CONSOLE_Y, CONSOLE_Z0, CONSOLE_Z1, OVER_Y, OVER_Z,
    COAM_Y, COAM_Z, RI_SILL,
  } = D;

  const P = D.panel;
  /** matrix on the fascia: local X across, +Y out of the face, +Z down the rake */
  const onPanel = (u, v, lift = 0) =>
    mat(0, P.midY, P.midZ, P.tilt).multiply(mat(u, lift, v));

  /* ---- WALL MOUNT FRAME -------------------------------------------- *
   *  SKIN is Surf(hull, linerInset), so `off` is measured OUTWARD from the
   *  hull skin and off = 0 lands on the liner.  Both of those run the wrong
   *  way for a fitting inside the cockpit, and every wall part below was
   *  written as if they did not:
   *
   *    - the equipment bays put their dark back plate at off = -0.085 with
   *      the intent of recessing it, and -0.085 is 8.5 cm PROUD — so a plate
   *      of greebles floated 8.5 cm off the wall while the frame that was to
   *      surround it sat at +0.004, i.e. 4 mm BEHIND the liner and therefore
   *      invisible.  Seen at the grazing angle the cockpit walls are seen at,
   *      that is a tilted sheet hanging in mid-air on both sides — the plates
   *      in the report;
   *    - conversely the one box that was meant to stand proud (off +0.11),
   *      the gussets carrying it, the wall grab handle (+0.055) and the kick
   *      strip (+0.03) were all pushed INTO the wall and could not be seen at
   *      all.
   *
   *  `onWall(z, ri, stand)` lands on the liner and flips +Y inboard, so a
   *  part's own thickness reads as "how far it stands off the wall" — the
   *  same helper the cabin uses.  R_x(PI) keeps the basis right-handed.
   */
  const FLIP = new THREE.Matrix4().makeRotationX(Math.PI);
  const onWall = (z, ri, stand = 0) =>
    SKIN.place(z, ri, -stand, 0).multiply(FLIP);

  /* ================= COAMING ================= *
   *  THERE IS NO GLARESHIELD.  There was one, twice, and both times it read
   *  as a horizontal awning hanging over the instrument panel — which is
   *  what it was.  It has been deleted rather than redesigned a third time.
   *
   *  A real glareshield exists to keep sunlight off glass instruments in an
   *  aircraft flying under a sky.  This ship's panel is a wall of self-lit
   *  displays inside a hull, so the part has no job here, and the two
   *  functions it was carrying can be built into the panel itself:
   *
   *    - the coaming light strip becomes a slot IN the fascia's top edge,
   *      firing down the panel face, with a lip that is part of the slab;
   *    - the annunciator row moves onto the fascia's upper margin, where a
   *      pilot actually looks for it.
   *
   *  LAMPS still knows where the coaming is (datum.js), so the canopy
   *  reflects it — that has to stay true whatever carries the fixture. */
  {
    const fy = PANEL_TOP.x, fz = PANEL_TOP.y;   // fascia top edge
    const HW = PANEL_HALF_W;

    /* The top edge cap: a returned lip on the slab, 55 mm deep, NOT a shelf.
       It closes the panel's top and gives the light slot something to sit
       in, and it is short enough that from the seat it reads as the edge of
       the panel rather than as a separate object. */
    B.add('trim', xf(bevelBox(HW * 2, 0.055, 0.075, 0.010), mat(0, fy + 0.012, fz + 0.028)));
    B.add('darkMetal', xf(bevelBox(HW * 2 - 0.06, 0.020, 0.05, 0.006), mat(0, fy + 0.040, fz + 0.030)));

    /* the light slot, recessed INTO that lip and aimed down the fascia */
    B.add('blackMetal', xf(bevelBox(HW * 2 - 0.12, 0.030, 0.06, 0.006),
      mat(0, COAM_Y - 0.004, COAM_Z)));
    B.add('strip', xf(new THREE.PlaneGeometry(HW * 2 - 0.18, 0.042).rotateX(Math.PI / 2),
      mat(0, COAM_Y - 0.020, COAM_Z)));

    /* annunciators on the fascia's upper margin, let into the slab */
    const ann = onPanel(0, -P.run * 0.44, 0.045);
    recess(B, ann, 0.50, 0.045, 'trim', 'blackMetal', 0.012);
    for (let i = 0; i < 9; i++) {
      B.add(i % 3 === 0 ? 'glowAmber' : 'glowGreen',
        xf(bevelBox(0.038, 0.010, 0.018, 0.003), ann.clone().multiply(mat(-0.192 + i * 0.048, 0.014, 0))));
    }
  }

  /* ================= MAIN PANEL ================= *
   *  A carrier slab on the rake with three display bays recessed into it,
   *  a switch block below, and legs to the deck.  The carrier is what the
   *  old version was missing: its screens were separate floating planes. */
  {
    B.add('trim', xf(bevelBox(PANEL_HALF_W * 2, 0.10, P.run, 0.018), mat(0, P.midY, P.midZ, P.tilt)));
    /* returned edges, so the slab reads as a thickness rather than a card */
    for (const sx of [-1, 1]) {
      B.add('trim', xf(bevelBox(0.055, 0.12, P.run + 0.02, 0.014), onPanel(sx * PANEL_HALF_W, 0, -0.01)));
    }
    B.add('trim', xf(bevelBox(PANEL_HALF_W * 2 + 0.04, 0.11, 0.06, 0.014), onPanel(0, P.run / 2)));

    /* three MFD bays across the upper fascia */
    const bayW = 0.46, bayH = 0.30;
    for (let i = -1; i <= 1; i++) {
      const m = onPanel(i * 0.53, -P.run * 0.16, 0.05);
      recess(B, m, bayW, bayH);
      screens.push({ m: m.clone().multiply(mat(0, 0.021, 0)), w: bayW - 0.03, h: bayH - 0.03, kind: i + 1, role: ['mfd-port', 'mfd-centre', 'mfd-stbd'][i + 1] });
      bolts(B, m, bayW + 0.09, bayH + 0.09, 0.017);
    }
    /* switch and breaker block along the lower fascia */
    for (let i = -1; i <= 1; i++) {
      const m = onPanel(i * 0.53, P.run * 0.26, 0.045);
      recess(B, m, 0.44, 0.16, 'trim', 'blackMetal', 0.02);
      B.add('trim', xf(greebleField(0.4, 0.13, 7, 310 + i, 0.022), m.clone().multiply(mat(0, 0.024, 0))));
      for (let k = 0; k < 5; k++) {
        B.add('brushed', xf(new THREE.CylinderGeometry(0.011, 0.011, 0.026, 8),
          m.clone().multiply(mat(-0.16 + k * 0.08, 0.032, 0.055))));
      }
    }
    /* two standby dials, because a real panel is never all glass */
    for (const sx of [-1, 1]) {
      const m = onPanel(sx * 0.30, -P.run * 0.42, 0.05);
      B.add('trim', xf(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 20), m));
      B.add('blackMetal', xf(new THREE.CylinderGeometry(0.062, 0.062, 0.056, 20), m));
      B.add('glowCyan', xf(new THREE.CylinderGeometry(0.05, 0.05, 0.058, 18), m));
    }
    /* Legs, and a knee bolster closing the gap under the fascia.
       With cavity AO on, the previous two thin posts made the panel read as
       SUSPENDED: contact shadow at the feet proves it touches the deck, and
       then the eye immediately asks what is holding the middle up.  A real
       panel has a closed lower half — a bolster you would knock your knees
       on — so the answer is structure, not thicker posts. */
    for (const sx of [-1, 1]) {
      B.add('trim', xf(bevelBox(0.13, PANEL_BOT.x, 0.16, 0.014),
        mat(sx * (PANEL_HALF_W - 0.10), PANEL_BOT.x / 2, PANEL_BOT.y + 0.05)));
      B.add('darkMetal', xf(bevelBox(0.17, 0.045, 0.22, 0.012),
        mat(sx * (PANEL_HALF_W - 0.10), 0.022, PANEL_BOT.y + 0.05)));
      bolts(B, mat(sx * (PANEL_HALF_W - 0.10), 0.045, PANEL_BOT.y + 0.05), 0.13, 0.17, 0.016);
    }
    /* the bolster: canted back so knees clear it, with a rubber rub strip */
    const bz = PANEL_BOT.y + 0.02;
    B.add('trim', xf(bevelBox(PANEL_HALF_W * 2 - 0.22, 0.40, 0.10, 0.014), mat(0, 0.40, bz, 0.22)));
    B.add('rubber', xf(bevelBox(PANEL_HALF_W * 2 - 0.30, 0.075, 0.045, 0.018), mat(0, 0.56, bz + 0.055, 0.22)));
    B.add('darkMetal', xf(bevelBox(PANEL_HALF_W * 2 - 0.26, 0.05, 0.13, 0.012), mat(0, 0.20, bz)));
    /* a cable tray under the bolster, so the void behind it is not empty */
    B.add('blackMetal', xf(bevelBox(PANEL_HALF_W * 1.6, 0.09, 0.16, 0.01), mat(0, 0.11, bz - 0.13)));
    for (let i = -2; i <= 2; i++) {
      B.add('copper', xf(new THREE.CylinderGeometry(0.014, 0.014, 0.30, 8).rotateZ(Math.PI / 2),
        mat(i * 0.14, 0.155, bz - 0.13)));
    }
    /* cable bundle down the back of the panel to the deck */
    B.add('rubber', conduit([
      new THREE.Vector3(0.22, PANEL_TOP.x - 0.08, PANEL_TOP.y - 0.02),
      new THREE.Vector3(0.30, 0.62, PANEL_TOP.y + 0.06),
      new THREE.Vector3(0.34, 0.12, PANEL_BOT.y + 0.1),
    ], 0.038, 8));
  }

  /* ================= SIDE CONSOLES ================= *
   *  Elbow height either side of the seat, canted 8 degrees inboard so
   *  their faces look at the pilot, standing on a plinth with a toe
   *  recess — the recess is what stops a box on the floor reading as a
   *  crate.  Cable trunking runs along the outboard cheek. */
  for (const sx of [-1, 1]) {
    const len = CONSOLE_Z1 - CONSOLE_Z0;
    const cz = (CONSOLE_Z0 + CONSOLE_Z1) / 2;
    const cant = -sx * 0.14;
    const base = mat(sx * CONSOLE_X, CONSOLE_Y, cz, 0, cant, 0);
    /* plinth, set in from the top so there is a toe recess and a shadow line */
    B.add('trim', xf(bevelBox(0.34, CONSOLE_Y - 0.10, len - 0.10, 0.014),
      mat(sx * CONSOLE_X, (CONSOLE_Y - 0.10) / 2 + 0.045, cz, 0, cant, 0)));
    B.add('darkMetal', xf(bevelBox(0.30, 0.05, len - 0.16, 0.01), mat(sx * CONSOLE_X, 0.03, cz, 0, cant, 0)));
    /* the working top, overhanging the plinth on all sides */
    B.add('trim', xf(bevelBox(0.44, 0.075, len, 0.016), base));
    B.add('darkMetal', xf(frameRect(0.42, len - 0.02, 0.022, 0.03), base.clone().multiply(mat(0, 0.05, 0))));
    /* two recessed plates and a keypad */
    const p1 = base.clone().multiply(mat(0, 0.045, -len * 0.26));
    recess(B, p1, 0.28, 0.34, 'trim', 'darkMetal', 0.02);
    B.add('darkMetal', xf(greebleField(0.25, 0.3, 8, 420 + sx, 0.026), p1.clone().multiply(mat(0, 0.025, 0))));
    const p2 = base.clone().multiply(mat(0, 0.045, len * 0.24));
    recess(B, p2, 0.26, 0.2, 'trim', 'blackMetal', 0.018);
    screens.push({ m: p2.clone().multiply(mat(0, 0.02, 0)), w: 0.24, h: 0.18, kind: sx > 0 ? 4 : 5, role: sx > 0 ? 'console-stbd' : 'console-port' });
    /* outboard cheek: trunking and a grab handle, which is also the one
       place the anodised family is allowed a highlight */
    B.add('rubber', xf(bevelBox(0.06, 0.16, len - 0.2, 0.012),
      mat(sx * (CONSOLE_X + 0.235), CONSOLE_Y - 0.14, cz, 0, cant, 0)));
    const gh = SKIN.runZ(sx * (RI_SILL + 2.0), cz - 0.62, cz + 0.62, 0.2, -0.055);
    B.add('darkMetal', sweepProfile(gh.path, gh.ups, rectProfile(0.022, 0.022, 0.4)));
    for (const dz of [-0.5, 0.5]) {
      B.add('brushed', xf(bevelBox(0.05, 0.055, 0.05, 0.010), onWall(cz + dz, sx * (RI_SILL + 2.0), 0.027)));
    }
  }

  /* ================= CENTRE PEDESTAL + CONTROLS ================= *
   *  Between the knees, forward of the seat pan at SHIP.seatZ.  The stick
   *  is a real column with a boot, not a cylinder ending in mid-air. */
  {
    const pz = EYE.z - 0.72;
    B.add('trim', xf(bevelBox(0.40, 0.52, 0.46, 0.016), mat(0, 0.27, pz)));
    B.add('darkMetal', xf(bevelBox(0.36, 0.05, 0.42, 0.01), mat(0, 0.028, pz)));
    const top = mat(0, 0.55, pz, -0.38);
    B.add('trim', xf(bevelBox(0.38, 0.06, 0.44, 0.014), top));
    recess(B, top.clone().multiply(mat(0, 0.03, -0.06)), 0.26, 0.18, 'trim', 'blackMetal', 0.016);
    screens.push({ m: top.clone().multiply(mat(0, 0.052, -0.06)), w: 0.24, h: 0.16, kind: 2, role: 'pedestal' });
    B.add('darkMetal', xf(greebleField(0.3, 0.12, 6, 515, 0.024), top.clone().multiply(mat(0, 0.032, 0.13))));
  }

  /* ---- side stick, on the starboard console, with a rubber boot ---- */
  {
    const sx = 1, cz = -7.62;
    const root = mat(sx * (CONSOLE_X - 0.02), CONSOLE_Y + 0.03, cz);
    B.add('darkMetal', xf(new THREE.CylinderGeometry(0.055, 0.075, 0.05, 14), root));
    B.add('rubber', xf(new THREE.CylinderGeometry(0.048, 0.062, 0.07, 14), root.clone().multiply(mat(0, 0.05, 0))));
    const col = root.clone().multiply(mat(0, 0.13, 0.015, -0.10));
    B.add('brushed', xf(new THREE.CylinderGeometry(0.026, 0.032, 0.22, 12), col));
    /* grip: a canted moulding with a trigger guard and two hat switches */
    const grip = col.clone().multiply(mat(0, 0.16, 0.01, -0.22, -0.12, 0));
    B.add('rubber', xf(bevelBox(0.075, 0.20, 0.095, 0.026), grip));
    B.add('blackMetal', xf(bevelBox(0.085, 0.045, 0.055, 0.014), grip.clone().multiply(mat(0, 0.115, -0.02))));
    B.add('brushed', xf(new THREE.CylinderGeometry(0.014, 0.014, 0.03, 8), grip.clone().multiply(mat(0.02, 0.14, -0.03))));
    B.add('glowRed', xf(new THREE.SphereGeometry(0.011, 8, 6), grip.clone().multiply(mat(-0.024, 0.135, -0.025))));
  }

  /* ---- throttle quadrant, port console: two levers in a slot ------- */
  {
    const sx = -1, cz = -7.95;
    const box = mat(sx * (CONSOLE_X - 0.01), CONSOLE_Y + 0.035, cz, 0, 0.14, 0);
    B.add('trim', xf(bevelBox(0.24, 0.07, 0.40, 0.014), box));
    B.add('blackMetal', xf(bevelBox(0.13, 0.045, 0.34, 0.008), box.clone().multiply(mat(0, 0.03, 0))));
    for (let i = 0; i < 2; i++) {
      const lv = box.clone().multiply(mat(-0.045 + i * 0.09, 0.03, -0.05, -0.30));
      B.add('brushed', xf(bevelBox(0.028, 0.20, 0.05, 0.008), lv.clone().multiply(mat(0, 0.10, 0))));
      B.add('rubber', xf(bevelBox(0.05, 0.075, 0.075, 0.022), lv.clone().multiply(mat(0, 0.215, 0))));
    }
    B.add('darkMetal', xf(greebleField(0.2, 0.1, 5, 611, 0.02), box.clone().multiply(mat(0, 0.038, 0.15))));
  }

  /* ---- rudder pedals, on rails under the panel -------------------- */
  for (const sx of [-1, 1]) {
    const pz = PANEL_BOT.y + 0.30;
    B.add('darkMetal', xf(bevelBox(0.07, 0.05, 0.62, 0.01), mat(sx * 0.21, 0.055, pz)));
    const ped = mat(sx * 0.21, 0.20, pz - 0.10, -0.34);
    B.add('brushed', xf(bevelBox(0.14, 0.24, 0.035, 0.008), ped));
    B.add('rubber', xf(bevelBox(0.12, 0.20, 0.018, 0.006), ped.clone().multiply(mat(0, 0, 0.024))));
    B.add('darkMetal', xf(new THREE.CylinderGeometry(0.02, 0.02, 0.1, 10).rotateZ(Math.PI / 2), mat(sx * 0.21, 0.09, pz - 0.06)));
  }

  /* ================= OVERHEAD PANEL ================= *
   *  Under the solid roof, canted forward so its faces look down at the
   *  pilot rather than at the back of the head.  This is only possible
   *  because the roof is no longer glazed. */
  {
    const m = mat(0, OVER_Y, OVER_Z, 0.30);
    B.add('trim', xf(bevelBox(1.06, 0.09, 0.66, 0.016), m));
    B.add('trim', xf(frameRect(1.02, 0.62, 0.03, 0.035), m.clone().multiply(mat(0, -0.05, 0))));
    for (let i = -1; i <= 1; i++) {
      const p = m.clone().multiply(mat(i * 0.34, -0.05, 0, Math.PI));
      recess(B, p, 0.28, 0.50, 'trim', 'darkMetal', 0.018);
      B.add('darkMetal', xf(greebleField(0.25, 0.46, 9, 720 + i, 0.02), p.clone().multiply(mat(0, 0.024, 0))));
    }
    /* guarded switches: the covers are what make an overhead read as one */
    for (let i = 0; i < 6; i++) {
      const g = m.clone().multiply(mat(-0.42 + i * 0.168, -0.062, -0.24, Math.PI));
      B.add('brushed', xf(bevelBox(0.055, 0.018, 0.075, 0.006), g));
      B.add('hullAccent', xf(bevelBox(0.05, 0.014, 0.03, 0.005), g.clone().multiply(mat(0, 0.016, -0.02))));
    }
    /* mounts up into the ceiling spine */
    for (const sx of [-1, 1]) {
      B.add('darkMetal', xf(bevelBox(0.07, 0.22, 0.09, 0.012), mat(sx * 0.44, OVER_Y + 0.14, OVER_Z + 0.05)));
    }
  }

  /* ================= OUTBOARD SYSTEMS BAYS ================= *
   *  The hull is 5.1 m wide here and the pilot occupies the middle 1.8 m,
   *  so without something outboard the flight deck reads as a hangar with a
   *  chair in it.
   *
   *  These used to be pads standing 0.10 m PROUD of the liner: at the
   *  grazing angle you see the cockpit wall from, a 0.66 x 0.34 m pad with
   *  nothing under it reads as a shelf hanging in mid-air, and three of them
   *  per side read as a row of them.  They are recessed INTO the wall now —
   *  a bay is a hole with a frame round it, which cannot float because its
   *  edges are the wall itself.  The equipment inside sits at the bottom of
   *  the recess, below the wall surface, so nothing overhangs.
   *
   *  Everything is still placed through SKIN.place(), so the bays follow the
   *  liner's curve exactly. */
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const z = -8.30 + i * 0.86;
      const ri = sx * (RI_SILL + 2.4);
      /* A bay on a single-sheet liner cannot be a hole, so it is a shallow
         TRAY: a frame ring 9 cm proud forms the mouth, and everything else
         lives inside it, close to the wall.  The mouth is what casts the
         shadow that makes the contents read as set back. */
      B.add('blackMetal', xf(bevelBox(0.62, 0.03, 0.30, 0.006), onWall(z, ri, 0.017)));
      B.add('darkMetal', xf(greebleField(0.54, 0.24, 7, 800 + i * 7 + sx, 0.045), onWall(z, ri, 0.030)));
      B.add('trim', xf(frameRect(0.66, 0.34, 0.055, 0.09), onWall(z, ri, 0.045)));
      bolts(B, onWall(z, ri, 0.085), 0.68, 0.36, 0.017);
      if (i === 1) {
        /* the one lit face, deep in the tray rather than on top of it */
        const f = onWall(z, ri, 0.045);
        recess(B, f, 0.30, 0.20, 'trim', 'blackMetal', 0.014);
        screens.push({ m: f.clone().multiply(mat(0, 0.02, 0)), w: 0.28, h: 0.18, kind: sx > 0 ? 3 : 0, role: sx > 0 ? 'rack-stbd' : 'rack-port' });
      }
    }
    /* One proud box per side, and it gets a full bracket to the wall plus a
       leg to the sill — the point being that anything that DOES stand off
       the liner has visible structure carrying it. */
    {
      const z = -6.10, ri = sx * (RI_SILL + 1.9);
      const m = onWall(z, ri, 0.19);
      B.add('trim', xf(bevelBox(0.44, 0.22, 0.52, 0.016), m));
      B.add('darkMetal', xf(bevelBox(0.40, 0.04, 0.48, 0.010), onWall(z, ri, 0.31)));
      /* two gussets from the wall up to the box's underside, so it is
         carried and not hung */
      for (const dz of [-0.20, 0.20]) {
        B.add('darkMetal', xf(bevelBox(0.045, 0.08, 0.20, 0.010), onWall(z + dz, ri, 0.04)));
      }
      bolts(B, onWall(z, ri, 0.006), 0.46, 0.54, 0.018);
    }
    /* conduit run down the wall to the deck, and a kick strip at its base.
       The strip is VERTICAL against the wall, in dark alloy.  It used to be a
       0.5 x 2.4 m brushed-metal slab lying flat on the deck half a metre out
       from the wall, which is not what a kick plate is and which caught the
       nearest point light as a blown white rectangle on the floor — the
       brightest thing in the cockpit after the displays. */
    const pts = [-8.6, -7.9, -7.2, -6.5].map((z) => SKIN.pt(z, sx * (RI_SILL + 4.0), -0.055));
    B.add('rubber', conduit(pts, 0.045, 8));
    const kick = SKIN.runZ(sx * (RI_SILL + 5.6), -8.55, -6.05, 0.25, -0.035);
    B.add('darkMetal', sweepProfile(kick.path, kick.ups, rectProfile(0.075, 0.02, 0.4)));
    B.add('trim', sweepProfile(kick.path, kick.ups, rectProfile(0.09, 0.008, 0.4)));
  }

  const solid = B.flush(group, mats);
  return { group, solid, screens };
}
