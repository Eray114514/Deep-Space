// Ship definition contract — ported 1:1 from 3aaa-spaceship-flight-prototype/src/game/ship/def.ts
// (types stripped only; logic, constants and comments unchanged).

/* ==================================================================== *
 *  SHIP DEFINITION
 *
 *  Everything that makes one vessel different from another, and nothing
 *  else.  The builders (exterior, interior, cockpit) are generic over
 *  this; the geometry machinery (loft, prims, Surf, fittings, materials,
 *  the cavity bake) is shared verbatim.
 *
 *  WHY THIS EXISTS AS A TYPE RATHER THAN THREE FORKS OF THE BUILDERS
 *
 *  The three hulls came from three separate prototypes, and each carried
 *  its own copy of the same ideas — its own loft, its own cockpit, its own
 *  materials.  Merging them by copying meshes across would import their
 *  materials too, and the whole point of the PBR/cavity/parametric work is
 *  that it applies to a SHAPE.  So a ship contributes tables of numbers
 *  and gets the pipeline for free.
 *
 *  Two conventions every def must honour, because the shared code assumes
 *  them and nothing can check them for you:
 *
 *    -Z is forward, +Y is up, x = 0 is the plane of symmetry
 *    y = 0 is the interior DECK, not the keel
 *
 *  The second one bites when porting: a hull authored with the keel at
 *  y = 0 has its whole section table sitting above zero, and every fitting
 *  placed against the deck then floats by the deck height.  Shift the
 *  sections, do not shift the fittings.
 * ==================================================================== */

/**
 * hull-relative dimensions the builders need by name
 * @typedef {Object} ShipDims
 * @property {number} noseZ
 * @property {number} tailZ
 * @property {number} canopyFront canopy glazing band, in Z
 * @property {number} canopyRear
 * @property {number} rampHingeZ cargo ramp
 * @property {number} rampHingeY
 * @property {number} rampTopZ
 * @property {number} rampTopY
 * @property {number} rampHalfW
 * @property {number} deckY interior
 * @property {number} cockpitFrontZ
 * @property {number} bulkheadZ
 * @property {number} holdStartZ
 * @property {number} holdEndZ
 * @property {number} seatZ pilot
 * @property {number} seatY
 * @property {number} eyeY
 * @property {number} eyeZ
 * @property {number} nacX lateral offset of the engine nacelles
 */

/** convenience for the engine: a Vector3-free eye point */
export function eyeOf(def) {
  return [0, def.dims.eyeY, def.dims.eyeZ];
}
