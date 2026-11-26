import { Matrix4, Vector3 } from 'three';

const ANCHOR_REBASE_M = 48;
const ANCHOR_REBASE_SQ = ANCHOR_REBASE_M * ANCHOR_REBASE_M;

export class SurfaceShadowGrid {
  constructor() {
    this.basis = new Matrix4();
    this.origin = new Vector3();
    this.localOrigin = new Vector3();
    this.anchorLocal = new Vector3();
    this.anchorBodyId = null;
    this.hasAnchor = false;
    this.phaseX = 0;
    this.phaseY = 0;
  }

  update(light, renderOrigin, bodyCenter, radius, maxTextureSize, body = null) {
    const { camera, mapSize } = light.shadow;
    // Match the shadow camera's lookAt basis, including the pole fallback.
    const m = this.basis.lookAt(light.position, light.target.position, camera.up).elements;
    const stepX = 2 * radius / Math.min(mapSize.x, maxTextureSize);
    const stepY = 2 * radius / Math.min(mapSize.y, maxTextureSize);

    let projectedX;
    let projectedY;
    if (body?.worldOffsetToLocal && body?.localOffsetToWorld) {
      const bodyId = body.bodyId || body.seed || body;
      this.origin.subVectors(renderOrigin, bodyCenter);
      body.worldOffsetToLocal(this.origin, this.localOrigin);
      // Anchor the texel lattice to a nearby point fixed on the planet's
      // rotating surface instead of the body centre (1.2e6+ m away). On a
      // rotating planet, snapping against bodyCenter multiplies live angular
      // motion by the planetary radius, sweeping projectedX across dozens of
      // texels per frame and causing 60 Hz shadow shimmer while standing still.
      if (!this.hasAnchor || this.anchorBodyId !== bodyId) {
        this.anchorLocal.copy(this.localOrigin);
        this.anchorBodyId = bodyId;
        this.hasAnchor = true;
        this.phaseX = 0;
        this.phaseY = 0;
      }
      this.origin.subVectors(this.localOrigin, this.anchorLocal);
      const distSq = this.origin.lengthSq();
      body.localOffsetToWorld(this.origin, this.origin);
      projectedX = this.origin.x * m[0] + this.origin.y * m[1] + this.origin.z * m[2] + this.phaseX;
      projectedY = this.origin.x * m[4] + this.origin.y * m[5] + this.origin.z * m[6] + this.phaseY;
      // Keep the surface lever arm bounded (<= 48 m) while carrying the exact
      // sub-texel remainder into (phaseX, phaseY) so rebasing introduces zero
      // single-frame shadow phase jump.
      if (distSq > ANCHOR_REBASE_SQ) {
        this.anchorLocal.copy(this.localOrigin);
        this.phaseX = projectedX - Math.round(projectedX / stepX) * stepX;
        this.phaseY = projectedY - Math.round(projectedY / stepY) * stepY;
        projectedX = this.phaseX;
        projectedY = this.phaseY;
      }
    } else {
      const { x, y, z } = this.origin.subVectors(renderOrigin, bodyCenter);
      projectedX = x * m[0] + y * m[1] + z * m[2];
      projectedY = x * m[4] + y * m[5] + z * m[6];
    }

    // Snap in the light-space grid in CPU doubles, then keep only the
    // subtexel shift in the camera-relative orthographic projection.
    const centerX = Math.round(projectedX / stepX) * stepX - projectedX;
    const centerY = Math.round(projectedY / stepY) * stepY - projectedY;
    const left = centerX - radius, right = centerX + radius;
    const bottom = centerY - radius, top = centerY + radius;
    if (camera.left === left && camera.right === right && camera.bottom === bottom && camera.top === top) return;
    camera.left = left;
    camera.right = right;
    camera.bottom = bottom;
    camera.top = top;
    camera.updateProjectionMatrix();
  }
}
