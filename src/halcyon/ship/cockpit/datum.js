// Cockpit datum — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/cockpit/datum.ts
// (types stripped only; logic, constants and comments unchanged).
import * as THREE from 'three';
import { Surf } from '../surface.js';

/* ------------------------------------------------------------------ *
 *  COCKPIT DATUM
 *
 *  ONE place where a flight deck's dimensions are resolved, and every
 *  other cockpit module reads them from the object this returns.  The file
 *  this replaces carried its own eye point in a comment —
 *  (0, 1.45, -7.62) — while the blueprint said eyeY 1.50 / eyeZ -7.70, and
 *  every fitting had been hand-placed against the stale one.  That is the
 *  whole reason the old cockpit interpenetrated, so the eye is read from
 *  the def, never restated.
 *
 *  This used to be a module of top-level constants.  It is a factory now
 *  because three ships share the machinery, and a module-level const is
 *  computed once at import — which would have silently given ships 1 and 2
 *  the Halcyon's panel height and glazing extent.  Nothing else changed:
 *  the numbers still come from one place, that place is now per ship.
 *
 *  WHAT IS DATA AND WHAT IS DERIVED
 *
 *  Data (in the def): where to glaze, how tall the panel is, where the
 *  consoles and coves sit.  Those are design decisions the hull
 *  constrains but does not determine.
 *
 *  Derived (here): the panel's rake and centre, the coaming and cove
 *  positions, the pane list, the lamp table.  Anything that can be
 *  computed is computed, because the two things that broke the old
 *  cockpit were a restated eye point and a hand-written tilt.
 *
 *  WHAT THE HULL DICTATES — worked through for the Halcyon
 *
 *  Its HULL_KEYS through the flight deck:
 *
 *      z        yTop    w      point C (shoulder)
 *    -10.40     0.55   2.20    y 0.25
 *     -9.40     1.30   2.45    y 0.75
 *     -8.60     1.95   2.55    y 1.10
 *     -7.80     2.45   2.60    y 1.30
 *     -7.00     2.70   2.62    y 1.35
 *     -6.20     2.78   2.64    y 1.38
 *
 *  Two things follow, and they set the whole architecture:
 *
 *  1  The glazing is a 5.2 m wide WRAPAROUND, not a fighter canopy.  The
 *     shoulder line it lands on is 2.5 m outboard — far outside the
 *     pilot's reach — so the instrument panel cannot hang off the window
 *     frame.  It is a free-standing console on the deck, and the sill
 *     under the glass is a separate structure against the hull wall.
 *     The old cockpit tried to be a fighter canopy at fuselage width,
 *     which is why its panel and its frames could not agree.
 *
 *  2  The roof falls from 2.45 m at the eye station to 0.55 m at z
 *     -10.40, a 36-degree rake.  So the windscreen is steeply laid back
 *     and the pilot looks forward-and-DOWN through it.  Down-vision over
 *     the glazing edge works out at 7 degrees at z -9.40 and 19 degrees
 *     at the forward edge, which is a real number for a large ship and
 *     is what the panel height is then chosen to protect.
 * ------------------------------------------------------------------ */

const lamp = (s) => ({
  a: new THREE.Vector3(...s.a),
  b: new THREE.Vector3(...s.b),
  c: new THREE.Color(s.hex).convertSRGBToLinear().multiplyScalar(s.gain),
  sig: s.sig,
});

export function makeDatum(def) {
  const C = def.cockpit;
  const EYE = new THREE.Vector3(0, def.dims.eyeY, def.dims.eyeZ);

  /* ---- glazing layout ---------------------------------------------- *
   *  The old canopy glazed the ENTIRE roof from z -10.4 to -5.4, which is
   *  why the cockpit had nowhere to put an overhead panel or a light cove
   *  and why an earlier build ended up with a truss hanging in the middle
   *  of the windscreen: there was no structure to hang anything on, so it
   *  was hung in the glass.
   *
   *  A real flight deck is glazed like this instead —
   *
   *    windscreen   the steeply raked forward glass, full width, from the
   *                 nose bay back to just ahead of the pilot's head
   *    side lights  long shoulder windows either side, from there aft
   *    roof         SOLID over the head, which is where the overhead panel
   *                 and the two light coves live
   *
   *  Ring indices 0..4 are the flat of the roof (A to B in sampleSection,
   *  x = 0 to wTop), so riRoof just above 4 keeps the whole roof flat and
   *  structural and starts the side lights in the shoulder radius.
   *
   *  Ring indices are SIGNED — -9 is the port shoulder — which the Surf
   *  modulo handles. */
  const WINDSCREEN = [
    { z0: C.gzFwd, z1: C.wsAft, ri0: -C.riSill, ri1: -2.6, nz: 5, nr: 4 },
    { z0: C.gzFwd, z1: C.wsAft, ri0: -2.6, ri1: 2.6, nz: 5, nr: 4 },
    { z0: C.gzFwd, z1: C.wsAft, ri0: 2.6, ri1: C.riSill, nz: 5, nr: 4 },
  ];
  const SIDE_LIGHTS = [
    { z0: C.wsAft, z1: C.sideSplitZ, ri0: C.riRoof, ri1: C.riSill, nz: 3, nr: 3 },
    { z0: C.sideSplitZ, z1: C.gzAft, ri0: C.riRoof, ri1: C.riSill, nz: 3, nr: 3 },
    { z0: C.wsAft, z1: C.sideSplitZ, ri0: -C.riSill, ri1: -C.riRoof, nz: 3, nr: 3 },
    { z0: C.sideSplitZ, z1: C.gzAft, ri0: -C.riSill, ri1: -C.riRoof, nz: 3, nr: 3 },
  ];

  /* ---- main instrument panel --------------------------------------- *
   *  Defined by its two edges in the y/z plane and nothing else, so the
   *  rake is DERIVED rather than guessed.  The old file carried a `TILT`
   *  constant and separate absolute positions for the panel, its screens
   *  and its hood, and they disagreed.
   *
   *  The top edge leans AWAY from the pilot and the bottom sits at the
   *  knees, which is the way round every real panel is built.  Getting it
   *  backwards makes the fascia overhang and the pilot sees its underside. */
  const PANEL_TOP = new THREE.Vector2(C.panelTop[0], C.panelTop[1]);
  const PANEL_BOT = new THREE.Vector2(C.panelBot[0], C.panelBot[1]);
  const dy = PANEL_BOT.x - PANEL_TOP.x;
  const dz = PANEL_BOT.y - PANEL_TOP.y;
  /* mat(x, y, z, rx) maps local +Y to (0, cos rx, sin rx) and local +Z to
     (0, -sin rx, cos rx).  We want +Z to run from the top edge down to the
     bottom one — that is (dy, dz)/run — and +Y to be the face normal, which
     then comes out pointing up and aft at the pilot automatically.  Solving
     -sin rx = dy/run and cos rx = dz/run gives this and nothing else; an
     extra quarter turn here is what laid the fascia flat and left the
     displays edge-on. */
  const panel = {
    run: Math.hypot(dy, dz),
    tilt: Math.atan2(-dy, dz),
    midY: (PANEL_TOP.x + PANEL_BOT.x) / 2,
    midZ: (PANEL_TOP.y + PANEL_BOT.y) / 2,
  };

  /* ceiling cove z range — the coves stop where the glazing header starts */
  const COVE_Z0 = C.gzAft + C.coveZ0Off;
  const COVE_Z1 = C.wsAft + C.coveZ1Off;
  /* the coaming strip, tucked under the glareshield lip and aimed down the
     fascia.  Tied to PANEL_TOP so that when the shroud moves this moves with
     it — the fixture and the reflection the canopy draws of it read the same
     two numbers. */
  const COAM_Y = PANEL_TOP.x + C.coamYOff;
  const COAM_Z = PANEL_TOP.y + C.coamZOff;

  /* ---- LAMPS ------------------------------------------------------- *
   *  The canopy glass reflects the cockpit's own fixtures, and TLS's notes
   *  are emphatic that those positions are a "standing obligation": it had
   *  a reflected light cove running 1.1 m forward of where the cove
   *  physically stopped, reflecting a lamp that was not there, in the part
   *  of the pane you look through.
   *
   *  So the table is built here, the geometry places the real fixtures FROM
   *  it, and the glass shader reflects FROM it.  They cannot drift apart
   *  because there is only one of them.
   *
   *  ORDER IS LOAD-BEARING: cockpit/index.ts takes LAMPS.slice(0, 2) as the
   *  two ceiling coves and puts two point lights along each. */
  const LAMPS = [
    lamp({ a: [-C.coveX, C.coveY, COVE_Z0], b: [-C.coveX, C.coveY, COVE_Z1], ...C.coveLamp }),
    lamp({ a: [C.coveX, C.coveY, COVE_Z0], b: [C.coveX, C.coveY, COVE_Z1], ...C.coveLamp }),
    lamp({
      a: [-C.panelHalfW + 0.06, COAM_Y, COAM_Z],
      b: [C.panelHalfW - 0.06, COAM_Y, COAM_Z],
      ...C.coamLamp,
    }),
    /* the overhead console's cold forward lip — behind and above the eye, so
       its reflection lands low on the screen where it belongs */
    lamp({
      a: [-0.58, C.overY - 0.10, C.overZ - 0.34],
      b: [0.58, C.overY - 0.10, C.overZ - 0.34],
      ...C.overLamp,
    }),
  ];

  return {
    EYE,
    /* The same inset the liner shell in interior.js uses, so the cockpit
       fittings and the cabin lining are on one surface and cannot part. */
    SKIN: new Surf(def.hull, C.linerInset),
    GLAZE: new Surf(def.hull, 0.0),
    RI_SILL: C.riSill,
    RI_ROOF: C.riRoof,
    GZ_FWD: C.gzFwd,
    GZ_AFT: C.gzAft,
    WS_AFT: C.wsAft,
    WINDSCREEN,
    SIDE_LIGHTS,
    PANES: [...WINDSCREEN, ...SIDE_LIGHTS],
    PANEL_TOP,
    PANEL_BOT,
    PANEL_HALF_W: C.panelHalfW,
    panel,
    CONSOLE_X: C.consoleX,
    CONSOLE_Y: C.consoleY,
    CONSOLE_Z0: C.consoleZ0,
    CONSOLE_Z1: C.consoleZ1,
    OVER_Y: C.overY,
    OVER_Z: C.overZ,
    COVE_X: C.coveX,
    COVE_Y: C.coveY,
    COVE_Z0,
    COVE_Z1,
    COAM_Y,
    COAM_Z,
    LAMPS,
  };
}
