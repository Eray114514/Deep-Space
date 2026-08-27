// "HALCYON-VII" hull definition — ported 1:1 from
// 3aaa-spaceship-flight-prototype/src/game/ship/ships/halcyon.ts
// (types stripped only; logic, constants and comments unchanged).
import { expandSections } from '../../loft.js';
import { dressHalcyon } from './halcyon-dress.js';

/* ==================================================================== *
 *  "HALCYON-VII"  —  long range exploration corvette
 *  --------------------------------------------------------------------
 *  Convention:  −Z = forward,  +Y = up,  y = 0 is the interior deck.
 *  Overall: 27.0 m long · 21.4 m span · 4.1 m tall (hull) / 7.3 m w/ fin
 *
 *  This is the reference def: the ship the whole material, cavity-bake and
 *  parametric-cockpit pipeline was developed against.  Its numbers are
 *  unchanged from when they lived in blueprint.ts, deliberately — the
 *  framing gate's figures (46.5% of the forward field blocked, 11.5 deg of
 *  clear down-vision) are regression values for exactly these tables.
 * ==================================================================== */

const DIMS = {
  noseZ: -15.6,
  tailZ: 11.3,
  /* canopy glazing band, in Z */
  canopyFront: -10.4,
  canopyRear: -5.4,
  /* cargo ramp */
  rampHingeZ: 6.2,
  rampHingeY: -0.16,
  rampTopZ: 8.66,
  rampTopY: 2.3,
  rampHalfW: 1.78,
  /* interior */
  deckY: 0,
  cockpitFrontZ: -10.3,
  bulkheadZ: -5.4,
  holdStartZ: -1.0,
  holdEndZ: 6.2,
  /* pilot */
  seatZ: -7.35,
  seatY: 0.0,
  eyeY: 1.50,
  eyeZ: -7.70,
  /* nacelles */
  nacX: 3.0,
};

/* -------------------------------------------------------------------- *
 *  MAIN FUSELAGE
 *
 *  NOSE, z -15.60 to -10.40.  The `rTop`/`rBot` fields are the corner
 *  fillet weights in sampleSection, and the original nose ran 0.8 down to
 *  0.40 — a soft, almost circular section all the way to the tip, which is
 *  what read as blunt and not 前卫 enough.  Faceting it is a matter of
 *  taking those weights DOWN (a low weight pulls the quadratic Bezier's
 *  control point away from the corner, so the section keeps a crease
 *  instead of rounding over) and widening the chines with wTop/wBot.
 *
 *  The result is a chined, wedge-sectioned forebody: sharp along the top
 *  and bottom centrelines, with a hard chine either side that catches the
 *  star as a line rather than as a soft gradient.  Nothing aft of -10.40
 *  is touched — the rest of the exterior is being preserved.
 * -------------------------------------------------------------------- */
const HULL_KEYS = [
  { at: -15.60, yBot: -0.10, yTop: 0.02, w: 0.09, wTop: 0.01, wBot: 0.01, chTop: 0.03, chBot: 0.03, rTop: 0.16, rBot: 0.16 },
  { at: -15.10, yBot: -0.30, yTop: 0.11, w: 0.46, wTop: 0.05, wBot: 0.05, chTop: 0.09, chBot: 0.09, rTop: 0.14, rBot: 0.14 },
  { at: -14.20, yBot: -0.52, yTop: 0.20, w: 1.02, wTop: 0.13, wBot: 0.13, chTop: 0.15, chBot: 0.15, rTop: 0.13, rBot: 0.13 },
  { at: -13.00, yBot: -0.70, yTop: 0.33, w: 1.66, wTop: 0.30, wBot: 0.26, chTop: 0.22, chBot: 0.22, rTop: 0.14, rBot: 0.14 },
  { at: -11.80, yBot: -0.81, yTop: 0.45, w: 2.08, wTop: 0.58, wBot: 0.48, chTop: 0.28, chBot: 0.30, rTop: 0.18, rBot: 0.18 },
  { at: -10.40, yBot: -0.88, yTop: 0.55, w: 2.20, wTop: 1.30, wBot: 1.10, chTop: 0.30, chBot: 0.38, rTop: 0.40, rBot: 0.45, sharp: true },
  { at: -9.40, yBot: -0.90, yTop: 1.30, w: 2.45, wTop: 1.45, wBot: 1.25, chTop: 0.55, chBot: 0.40, rTop: 0.40, rBot: 0.45 },
  { at: -8.60, yBot: -0.92, yTop: 1.95, w: 2.55, wTop: 1.50, wBot: 1.35, chTop: 0.85, chBot: 0.40, rTop: 0.40, rBot: 0.45 },
  { at: -7.80, yBot: -0.94, yTop: 2.45, w: 2.60, wTop: 1.50, wBot: 1.40, chTop: 1.15, chBot: 0.42, rTop: 0.42, rBot: 0.45 },
  { at: -7.00, yBot: -0.95, yTop: 2.70, w: 2.62, wTop: 1.45, wBot: 1.45, chTop: 1.35, chBot: 0.42, rTop: 0.45, rBot: 0.45 },
  { at: -6.20, yBot: -0.95, yTop: 2.78, w: 2.64, wTop: 1.35, wBot: 1.45, chTop: 1.40, chBot: 0.42, rTop: 0.48, rBot: 0.45 },
  { at: -5.40, yBot: -0.95, yTop: 2.72, w: 2.66, wTop: 1.28, wBot: 1.45, chTop: 1.32, chBot: 0.42, rTop: 0.46, rBot: 0.45, sharp: true },
  { at: -4.40, yBot: -0.96, yTop: 2.62, w: 2.74, wTop: 1.30, wBot: 1.50, chTop: 0.85, chBot: 0.42, rTop: 0.40, rBot: 0.45 },
  { at: -3.00, yBot: -1.00, yTop: 2.58, w: 2.95, wTop: 1.55, wBot: 1.60, chTop: 0.80, chBot: 0.45, rTop: 0.38, rBot: 0.45 },
  { at: -1.00, yBot: -1.05, yTop: 2.62, w: 3.30, wTop: 1.75, wBot: 1.75, chTop: 0.85, chBot: 0.50, rTop: 0.38, rBot: 0.45 },
  { at: 1.00, yBot: -1.05, yTop: 2.72, w: 3.52, wTop: 1.90, wBot: 1.78, chTop: 0.90, chBot: 0.50, rTop: 0.38, rBot: 0.45 },
  { at: 3.00, yBot: -0.98, yTop: 2.82, w: 3.58, wTop: 1.95, wBot: 1.78, chTop: 0.95, chBot: 0.48, rTop: 0.38, rBot: 0.42 },
  { at: 5.00, yBot: -0.62, yTop: 2.92, w: 3.48, wTop: 1.90, wBot: 1.78, chTop: 1.00, chBot: 0.42, rTop: 0.38, rBot: 0.38 },
  { at: 6.20, yBot: -0.16, yTop: 2.96, w: 3.40, wTop: 1.86, wBot: 1.78, chTop: 1.00, chBot: 0.30, rTop: 0.36, rBot: 0.3, sharp: true },
  { at: 7.40, yBot: 1.04, yTop: 3.02, w: 3.32, wTop: 1.82, wBot: 1.78, chTop: 0.98, chBot: 0.22, rTop: 0.34, rBot: 0.25 },
  { at: 8.66, yBot: 2.30, yTop: 3.12, w: 3.22, wTop: 1.80, wBot: 1.78, chTop: 0.62, chBot: 0.10, rTop: 0.3, rBot: 0.2, sharp: true },
  { at: 9.40, yBot: 2.34, yTop: 3.30, w: 3.10, wTop: 1.72, wBot: 1.66, chTop: 0.52, chBot: 0.14, rTop: 0.3, rBot: 0.3 },
  { at: 10.30, yBot: 2.38, yTop: 3.34, w: 2.86, wTop: 1.58, wBot: 1.48, chTop: 0.48, chBot: 0.14, rTop: 0.3, rBot: 0.3 },
  { at: 11.00, yBot: 2.44, yTop: 3.22, w: 2.52, wTop: 1.36, wBot: 1.24, chTop: 0.36, chBot: 0.12, rTop: 0.3, rBot: 0.3 },
];

const HULL = expandSections(HULL_KEYS, 0.26);

/* -------------------------------------------------------------------- *
 *  ENGINE NACELLE  (starboard master; port is mirrored)
 * -------------------------------------------------------------------- */
const NACELLE_KEYS = [
  { at: -0.90, off: DIMS.nacX, yBot: 0.62, yTop: 1.10, w: 0.22, wTop: 0.11, wBot: 0.11, chTop: 0.10, chBot: 0.10, rTop: 0.8, rBot: 0.8 },
  { at: 0.30, off: DIMS.nacX, yBot: 0.34, yTop: 1.40, w: 0.56, wTop: 0.30, wBot: 0.28, chTop: 0.24, chBot: 0.24, rTop: 0.6, rBot: 0.6 },
  { at: 1.70, off: DIMS.nacX, yBot: 0.02, yTop: 1.66, w: 0.92, wTop: 0.52, wBot: 0.48, chTop: 0.36, chBot: 0.34, rTop: 0.5, rBot: 0.5 },
  { at: 3.30, off: DIMS.nacX, yBot: -0.32, yTop: 1.82, w: 1.14, wTop: 0.66, wBot: 0.60, chTop: 0.44, chBot: 0.42, rTop: 0.45, rBot: 0.45 },
  { at: 5.20, off: DIMS.nacX, yBot: -0.50, yTop: 1.88, w: 1.22, wTop: 0.72, wBot: 0.64, chTop: 0.46, chBot: 0.44, rTop: 0.42, rBot: 0.42 },
  { at: 7.20, off: DIMS.nacX, yBot: -0.55, yTop: 1.90, w: 1.22, wTop: 0.72, wBot: 0.66, chTop: 0.46, chBot: 0.44, rTop: 0.42, rBot: 0.42 },
  { at: 9.20, off: DIMS.nacX, yBot: -0.52, yTop: 1.90, w: 1.22, wTop: 0.74, wBot: 0.66, chTop: 0.46, chBot: 0.44, rTop: 0.42, rBot: 0.42 },
  { at: 10.30, off: DIMS.nacX, yBot: -0.46, yTop: 1.86, w: 1.18, wTop: 0.72, wBot: 0.64, chTop: 0.44, chBot: 0.42, rTop: 0.42, rBot: 0.42 },
  { at: 11.05, off: DIMS.nacX, yBot: -0.34, yTop: 1.76, w: 1.06, wTop: 0.64, wBot: 0.56, chTop: 0.40, chBot: 0.38, rTop: 0.42, rBot: 0.42, sharp: true },
  { at: 11.30, off: DIMS.nacX, yBot: -0.24, yTop: 1.66, w: 0.96, wTop: 0.56, wBot: 0.50, chTop: 0.36, chBot: 0.34, rTop: 0.42, rBot: 0.42 },
];
const NACELLE = expandSections(NACELLE_KEYS, 0.24);

/* -------------------------------------------------------------------- *
 *  MAIN WING  (axis = X, in-plane a = Z chord, b = Y thickness)
 * -------------------------------------------------------------------- */
const WING_KEYS = [
  { at: 1.90, off: 3.10, yBot: -0.28, yTop: 1.28, w: 3.35, wTop: 2.00, wBot: 2.00, chTop: 0.62, chBot: 0.62, rTop: 0.5, rBot: 0.5 },
  { at: 3.40, off: 3.55, yBot: -0.05, yTop: 1.08, w: 3.10, wTop: 1.85, wBot: 1.85, chTop: 0.50, chBot: 0.50, rTop: 0.5, rBot: 0.5 },
  { at: 5.20, off: 4.30, yBot: 0.06, yTop: 0.92, w: 2.70, wTop: 1.60, wBot: 1.60, chTop: 0.38, chBot: 0.38, rTop: 0.5, rBot: 0.5 },
  { at: 7.20, off: 5.30, yBot: 0.14, yTop: 0.78, w: 2.20, wTop: 1.28, wBot: 1.28, chTop: 0.28, chBot: 0.28, rTop: 0.5, rBot: 0.5 },
  { at: 9.00, off: 6.30, yBot: 0.18, yTop: 0.64, w: 1.66, wTop: 0.95, wBot: 0.95, chTop: 0.20, chBot: 0.20, rTop: 0.5, rBot: 0.5 },
  { at: 10.20, off: 7.00, yBot: 0.20, yTop: 0.54, w: 1.22, wTop: 0.70, wBot: 0.70, chTop: 0.14, chBot: 0.14, rTop: 0.5, rBot: 0.5 },
  { at: 10.70, off: 7.30, yBot: 0.23, yTop: 0.47, w: 0.95, wTop: 0.52, wBot: 0.52, chTop: 0.10, chBot: 0.10, rTop: 0.5, rBot: 0.5, sharp: true },
];
const WING = expandSections(WING_KEYS, 0.22);

/* -- forward canard / strake: small, blends the nose into the body ---- */
const STRAKE_KEYS = [
  { at: 1.30, off: -6.00, yBot: -0.42, yTop: 0.30, w: 2.60, wTop: 1.50, wBot: 1.50, chTop: 0.28, chBot: 0.28, rTop: 0.5, rBot: 0.5 },
  { at: 2.30, off: -6.30, yBot: -0.34, yTop: 0.14, w: 2.20, wTop: 1.25, wBot: 1.25, chTop: 0.20, chBot: 0.20, rTop: 0.5, rBot: 0.5 },
  { at: 3.30, off: -6.65, yBot: -0.26, yTop: 0.02, w: 1.70, wTop: 0.95, wBot: 0.95, chTop: 0.13, chBot: 0.13, rTop: 0.5, rBot: 0.5 },
  { at: 4.05, off: -6.95, yBot: -0.20, yTop: -0.04, w: 1.25, wTop: 0.68, wBot: 0.68, chTop: 0.09, chBot: 0.09, rTop: 0.5, rBot: 0.5 },
  { at: 4.45, off: -7.12, yBot: -0.17, yTop: -0.07, w: 0.95, wTop: 0.50, wBot: 0.50, chTop: 0.06, chBot: 0.06, rTop: 0.5, rBot: 0.5, sharp: true },
];
const STRAKE = expandSections(STRAKE_KEYS, 0.2);

/* -------------------------------------------------------------------- *
 *  DORSAL FIN  (axis = Y, in-plane a = Z chord, b = X thickness)
 * -------------------------------------------------------------------- */
const FIN_KEYS = [
  { at: 2.60, off: 7.60, yBot: -0.46, yTop: 0.46, w: 2.40, wTop: 1.40, wBot: 1.40, chTop: 0.34, chBot: 0.34, rTop: 0.5, rBot: 0.5 },
  { at: 3.50, off: 7.95, yBot: -0.37, yTop: 0.37, w: 2.10, wTop: 1.22, wBot: 1.22, chTop: 0.27, chBot: 0.27, rTop: 0.5, rBot: 0.5 },
  { at: 4.40, off: 8.35, yBot: -0.28, yTop: 0.28, w: 1.78, wTop: 1.02, wBot: 1.02, chTop: 0.20, chBot: 0.20, rTop: 0.5, rBot: 0.5 },
  { at: 5.30, off: 8.75, yBot: -0.20, yTop: 0.20, w: 1.42, wTop: 0.80, wBot: 0.80, chTop: 0.14, chBot: 0.14, rTop: 0.5, rBot: 0.5 },
  { at: 6.10, off: 9.15, yBot: -0.13, yTop: 0.13, w: 1.05, wTop: 0.58, wBot: 0.58, chTop: 0.09, chBot: 0.09, rTop: 0.5, rBot: 0.5 },
  { at: 6.45, off: 9.35, yBot: -0.08, yTop: 0.08, w: 0.80, wTop: 0.44, wBot: 0.44, chTop: 0.05, chBot: 0.05, rTop: 0.5, rBot: 0.5, sharp: true },
];
const FIN = expandSections(FIN_KEYS, 0.2);

/* -- canted nacelle stabiliser (built vertical, then canted outboard) -- */
const CANT_KEYS = [
  { at: 0.60, off: 8.20, yBot: -0.34, yTop: 0.34, w: 2.10, wTop: 1.20, wBot: 1.20, chTop: 0.26, chBot: 0.26, rTop: 0.5, rBot: 0.5 },
  { at: 1.60, off: 8.55, yBot: -0.26, yTop: 0.26, w: 1.80, wTop: 1.02, wBot: 1.02, chTop: 0.20, chBot: 0.20, rTop: 0.5, rBot: 0.5 },
  { at: 2.60, off: 8.95, yBot: -0.17, yTop: 0.17, w: 1.42, wTop: 0.80, wBot: 0.80, chTop: 0.13, chBot: 0.13, rTop: 0.5, rBot: 0.5 },
  { at: 3.40, off: 9.30, yBot: -0.10, yTop: 0.10, w: 1.02, wTop: 0.56, wBot: 0.56, chTop: 0.08, chBot: 0.08, rTop: 0.5, rBot: 0.5 },
  { at: 3.80, off: 9.50, yBot: -0.06, yTop: 0.06, w: 0.78, wTop: 0.42, wBot: 0.42, chTop: 0.05, chBot: 0.05, rTop: 0.5, rBot: 0.5, sharp: true },
];
const CANT = expandSections(CANT_KEYS, 0.2);

/* -------------------------------------------------------------------- *
 *  COCKPIT / CABIN LINER
 *  The forward liner is the hull skin offset inward, so the canopy
 *  glazing and the interior share one continuous surface.
 *  Aft of the bulkhead the liner is an independent, narrower tube.
 * -------------------------------------------------------------------- */
const CABIN_KEYS = [
  { at: -5.40, yBot: -0.34, yTop: 2.46, w: 2.30, wTop: 1.20, wBot: 1.32, chTop: 1.16, chBot: 0.40, rTop: 0.45, rBot: 0.45, sharp: true },
  { at: -4.60, yBot: -0.34, yTop: 2.34, w: 1.92, wTop: 1.05, wBot: 1.18, chTop: 0.80, chBot: 0.38, rTop: 0.45, rBot: 0.45 },
  { at: -3.60, yBot: -0.32, yTop: 2.26, w: 1.64, wTop: 0.94, wBot: 1.06, chTop: 0.58, chBot: 0.36, rTop: 0.45, rBot: 0.45 },
  { at: -2.20, yBot: -0.32, yTop: 2.24, w: 1.58, wTop: 0.92, wBot: 1.04, chTop: 0.54, chBot: 0.36, rTop: 0.45, rBot: 0.45 },
  { at: -1.00, yBot: -0.32, yTop: 2.30, w: 1.72, wTop: 1.02, wBot: 1.14, chTop: 0.56, chBot: 0.36, rTop: 0.45, rBot: 0.45 },
  { at: 0.40, yBot: -0.32, yTop: 2.44, w: 2.16, wTop: 1.34, wBot: 1.50, chTop: 0.66, chBot: 0.38, rTop: 0.45, rBot: 0.45 },
  { at: 2.00, yBot: -0.32, yTop: 2.52, w: 2.34, wTop: 1.52, wBot: 1.70, chTop: 0.72, chBot: 0.38, rTop: 0.45, rBot: 0.45 },
  { at: 4.20, yBot: -0.26, yTop: 2.52, w: 2.34, wTop: 1.54, wBot: 1.72, chTop: 0.72, chBot: 0.34, rTop: 0.45, rBot: 0.45 },
  { at: 6.20, yBot: -0.10, yTop: 2.50, w: 2.30, wTop: 1.52, wBot: 1.70, chTop: 0.70, chBot: 0.26, rTop: 0.45, rBot: 0.45, sharp: true },
];
const CABIN = expandSections(CABIN_KEYS, 0.24);

/** walkable volumes (axis aligned, ship local). y is floor height. */
const ROOMS = [
  /* forward limit is set by canopy headroom, not by the hull */
  { name: 'cockpit', x0: -2.05, x1: 2.05, z0: -8.28, z1: -5.55 },
  { name: 'door', x0: -0.88, x1: 0.88, z0: -6.40, z1: -4.40 },
  { name: 'corridor', x0: -1.30, x1: 1.30, z0: -5.35, z1: -0.20 },
  { name: 'throat', x0: -1.45, x1: 1.45, z0: -1.40, z1: 1.40 },
  { name: 'hold', x0: -1.98, x1: 1.98, z0: 0.60, z1: 6.00 },
];

/** solid furniture footprints, ship local — see ShipDef.blocks */
const BLOCKS = [
  { x0: -0.47, x1: 0.47, z0: -7.90, z1: -6.75 },   // pilot seat
  { x0: -1.72, x1: 1.72, z0: -9.90, z1: -8.35 },   // main panel
  { x0: -0.42, x1: 0.42, z0: -8.62, z1: -7.85 },   // pedestal / stick
  { x0: 1.28, x1: 2.50, z0: -8.90, z1: -6.30 },    // stbd console
  { x0: -2.50, x1: -1.28, z0: -8.90, z1: -6.30 },  // port console
  { x0: 1.32, x1: 1.95, z0: -5.90, z1: -5.05 },    // stbd jump seat
  { x0: -1.95, x1: -1.32, z0: -5.90, z1: -5.05 },  // port jump seat
  { x0: -1.92, x1: -0.78, z0: -0.38, z1: 0.98 },   // deck crates
  { x0: 0.78, x1: 1.92, z0: -0.38, z1: 0.98 },
  { x0: 0.73, x1: 1.97, z0: 1.38, z1: 2.52 },
  { x0: -1.83, x1: -0.87, z0: 1.53, z1: 2.47 },
  { x0: 1.35, x1: 2.12, z0: 3.45, z1: 5.15 },      // work benches
  { x0: -2.12, x1: -1.35, z0: 3.45, z1: 5.15 },
  { x0: -1.35, x1: 1.35, z0: 5.75, z1: 6.60 },     // ramp threshold / field
];

/* -------------------------------------------------------------------- *
 *  FLIGHT DECK
 *
 *  These were module-level constants in cockpit/datum.ts, and the long
 *  arguments for each number still live there — this is only the data.
 *  The short version:
 *
 *  The glazing is a 5.2 m wide WRAPAROUND, not a fighter canopy: the
 *  shoulder line it lands on (riSill = 9) is 2.5 m outboard, far outside
 *  the pilot's reach, so the panel cannot hang off the window frame and is
 *  a free-standing console on the deck instead.
 *
 *  The roof falls from 2.45 m at the eye to 0.55 m at z -10.40, a 36-deg
 *  rake, so the screen is steeply laid back and the pilot looks forward
 *  and DOWN through it.  The panel's top edge is then placed to leave
 *  8 degrees of clear sight over it.
 *
 *  coamLamp's gain is an eighth of the cove's over a lobe nearly three
 *  times wider, and that is this hull's geometry rather than taste: a
 *  36-degree screen reflects what is BELOW it into the UPPER field of
 *  view, so a full-strength coaming lamp printed a pale bar across the
 *  middle of the windscreen.
 * -------------------------------------------------------------------- */
export const HALCYON = {
  id: 'halcyon',
  name: 'HALCYON VII',
  klass: 'EXPLORATION CORVETTE',
  reg: 'REG 兀-2291',
  dims: DIMS,
  hull: HULL,
  cabin: CABIN,
  nacelle: NACELLE,
  wing: WING,
  strake: STRAKE,
  fin: FIN,
  cant: CANT,
  rooms: ROOMS,
  blocks: BLOCKS,
  /* Conformal paint.  Ring edge indices, each mirrored to the far side:
     10 is the upper chine, 12/13 the shoulder, 2 the nose crown, 3 the
     dorsal shoulder, 17/18 the lower flank.  All lofted off the hull
     surface itself, so a band cannot float, gap or z-fight. */
  livery: [
    { edges: [10], z0: -9.4, z1: 4.0, key: 'hullAccent' },
    { edges: [12, 13], z0: -13.0, z1: 6.2, key: 'hullDark', off: 0.012 },
    { edges: [2], z0: -14.2, z1: -10.4, key: 'hullAccent' },
    { edges: [3], z0: -4.4, z1: 8.0, key: 'hullDark', off: 0.012 },
    { edges: [17, 18], z0: -13.0, z1: 5.0, key: 'trim', off: 0.012 },
  ],
  /* two main bells on the nacelles, two smaller manoeuvring bells on the
     upper hull — the asymmetry in size is what makes the stern read as a
     drive system rather than as four identical holes */
  engines: [
    { x: DIMS.nacX, y: 0.66, z: 11.05, r: 0.94 },
    { x: -DIMS.nacX, y: 0.66, z: 11.05, r: 0.94 },
    { x: 1.2, y: 2.84, z: 10.86, r: 0.36 },
    { x: -1.2, y: 2.84, z: 10.86, r: 0.36 },
  ],
  dressExterior: dressHalcyon,
  cockpit: {
    linerInset: 0.14,
    riSill: 9,
    riRoof: 4.4,
    gzFwd: -10.32,
    gzAft: -6.02,
    wsAft: -8.30,
    sideSplitZ: -7.18,
    panelTop: [DIMS.eyeY - 0.44, DIMS.eyeZ - 1.76],
    panelBot: [0.58, DIMS.eyeZ - 1.40],
    panelHalfW: 0.88,
    consoleX: 0.79,
    consoleY: 0.76,
    consoleZ0: -8.62,
    consoleZ1: -7.10,
    overY: 2.24,
    overZ: -7.94,
    coveX: 1.20,
    coveY: 2.30,
    coveZ0Off: 0.06,
    coveZ1Off: 0.10,
    coamYOff: -0.010,
    coamZOff: 0.12,
    coveLamp: { hex: 0xffd7b0, gain: 2.4, sig: 0.085 },
    coamLamp: { hex: 0xfff0da, gain: 0.13, sig: 0.21 },
    overLamp: { hex: 0xf2f8ff, gain: 0.85, sig: 0.06 },
  },
};
