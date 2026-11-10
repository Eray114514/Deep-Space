import { Matrix4, Vector3 } from 'three';

export class SurfaceShadowGrid {
  constructor() {
    this.basis = new Matrix4();
    this.origin = new Vector3();
  }

  update(light, renderOrigin, bodyCenter, radius, maxTextureSize) {
    const { camera, mapSize } = light.shadow;
    // Match the shadow camera's lookAt basis, including the pole fallback.
    const m = this.basis.lookAt(light.position, light.target.position, camera.up).elements;
    const { x, y, z } = this.origin.subVectors(renderOrigin, bodyCenter);
    const projectedX = x * m[0] + y * m[1] + z * m[2];
    const projectedY = x * m[4] + y * m[5] + z * m[6];
    const stepX = 2 * radius / Math.min(mapSize.x, maxTextureSize);
    const stepY = 2 * radius / Math.min(mapSize.y, maxTextureSize);
    // Snap in the body's light-space grid in CPU doubles, then keep only
    // the subtexel shift in the camera-relative orthographic projection.
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
