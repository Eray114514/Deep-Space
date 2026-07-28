// Shared camera-layer ownership. Render order only sorts objects within one
// queue; pass membership and composition order must stay explicit.

export const WORLD_LAYER = 0;
export const VOLUME_LAYER = 2;
export const FOREGROUND_LAYER = 3;
export const SKY_BACKDROP_LAYER = 4;
