/* ==================================================================== *
 *  "HALCYON VII"  —  long range exploration corvette
 *  --------------------------------------------------------------------
 *  Convention:  −Z = forward,  +Y = up,  y = 0 is the interior deck.
 *  Overall: 27.9 m long · 21.6 m span · 4.0 m tall (hull) / 6.6 m w/ fin
 *
 *  The vessel itself is authored in Blender (tools/blender/halcyon/) and
 *  shipped as assets/halcyon/halcyon.glb.  This file is the part of the
 *  design the GAME needs as numbers: where the pilot's eye is, where a
 *  person can stand, where the ramp hinges.  Keep it in step with
 *  tools/blender/halcyon/design.py (DIMS) and interior.py / cockpit.py.
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
  holdStartZ: -0.6,
  holdEndZ: 6.2,
  /* pilot */
  seatZ: -7.35,
  seatY: 0.0,
  eyeY: 1.50,
  eyeZ: -7.70,
  /* nacelles */
  nacX: 3.6,
};

/** walkable volumes (axis aligned, ship local). y is floor height.
 *  ship-view.js insets every room by the walker's radius (0.26 m) on all four
 *  sides, so two rooms only connect if they OVERLAP by more than 0.52 m along
 *  the way through — a doorway is a room that reaches well into both of its
 *  neighbours, not a slab the thickness of the bulkhead. */
const ROOMS = [
  /* the aisle between the side consoles, then the open deck behind the seat */
  { name: 'cockpit-aisle', x0: -0.50, x1: 0.50, z0: -8.45, z1: -5.50 },
  { name: 'cockpit-aft', x0: -1.28, x1: 1.28, z0: -6.52, z1: -5.52 },
  { name: 'door', x0: -0.72, x1: 0.72, z0: -6.40, z1: -4.50 },
  { name: 'corridor', x0: -1.24, x1: 1.24, z0: -5.36, z1: -1.00 },
  { name: 'throat', x0: -0.94, x1: 0.94, z0: -2.00, z1: 0.40 },
  { name: 'hold', x0: -2.08, x1: 2.08, z0: -0.60, z1: 6.05 },
];

/** solid furniture footprints, ship local — see ShipDef.blocks */
const BLOCKS = [
  { x0: -0.36, x1: 0.36, z0: -8.10, z1: -7.22 },   // pilot seat
  { x0: -2.05, x1: -0.82, z0: -0.42, z1: 0.90 },   // port crate stack
  { x0: -2.02, x1: -0.90, z0: 1.02, z1: 2.22 },    // port crate
  { x0: 0.78, x1: 2.05, z0: -0.36, z1: 1.04 },     // starboard crate
  { x0: 0.98, x1: 2.05, z0: 1.26, z1: 2.24 },      // starboard crate
  { x0: -2.10, x1: -1.48, z0: 3.20, z1: 4.95 },    // pressure tanks
  { x0: 1.34, x1: 2.12, z0: 3.42, z1: 5.18 },      // workbench
  { x0: -1.35, x1: 1.35, z0: 5.75, z1: 6.60 },     // ramp threshold / field
];

export const HALCYON = {
  id: 'halcyon',
  name: 'HALCYON VII',
  klass: 'EXPLORATION CORVETTE',
  reg: 'REG HX-2291',
  dims: DIMS,
  rooms: ROOMS,
  blocks: BLOCKS,
};
