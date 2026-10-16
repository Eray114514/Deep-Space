import * as THREE from 'three';

// The real draw eye in canonical body-local doubles. Translation never enters
// the GPU linear transform; callers choose their own small residual domain.
export class SurfaceViewFrame {
  constructor(planet) {
    this.planet = planet;
    this.origin = new THREE.Vector3();
    this.linear = { value: new THREE.Matrix3() };
    this.cameraMatrix = new THREE.Matrix4();
    this.bodyMatrix = new THREE.Matrix4();
    this.localView = new THREE.Matrix4();
    this.initialized = false;
  }

  sync(camera) {
    const body = this.planet.group.matrixWorld;
    if (this.initialized && this.cameraMatrix.equals(camera.matrixWorld) && this.bodyMatrix.equals(body)) return false;
    this.initialized = true;
    this.cameraMatrix.copy(camera.matrixWorld);
    this.bodyMatrix.copy(body);
    this.localView.copy(body).invert().multiply(camera.matrixWorld);
    this.origin.setFromMatrixPosition(this.localView);
    this.linear.value.setFromMatrix4(this.localView);
    return true;
  }
}
