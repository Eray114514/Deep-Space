// Shared camera-layer ownership. Render order only sorts objects within one
// queue; pass membership and composition order must stay explicit.

export const WORLD_LAYER = 0;
export const VOLUME_LAYER = 2;
export const FOREGROUND_LAYER = 3;
export const SKY_BACKDROP_LAYER = 4;
// Rendered as its own light domain. Combining this with the exterior camera
// mask in one renderer call would still gather both light lists and recreate
// the unoccluded exterior fill inside the hull.
export const SHIP_INTERIOR_LAYER = 6;
// First-person equipment has its own outdoor light list, independent of the
// ship's calibrated exterior and cabin rigs.
export const WEAPON_FOREGROUND_LAYER = 7;
