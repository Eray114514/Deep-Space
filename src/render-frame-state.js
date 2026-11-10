import * as THREE from 'three';

function snapshot() {
  return {
    origin: new THREE.Vector3(),
    cameraWorld: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
    inverseProjection: new THREE.Matrix4(),
    viewProjection: new THREE.Matrix4(),
    bodyPosition: new THREE.Vector3(),
    bodyOrientation: new THREE.Quaternion(),
    context: null, timeEpoch: null, body: null, medium: null, weather: null, near: 0, far: 0,
  };
}

function continuousWeather(current,previous) {
  if(current===previous)return true;
  // A natural forecast rollover shares the actual endpoint object identity
  // represented by its revision. A replacement at the same hour does not.
  return Boolean(current&&previous&&current.owner===previous.owner
    &&(current.first===previous.second||current.second===previous.first));
}

// One transaction per view/context, shared by the pipeline's temporal consumers.
// Keep universe translations in CPU doubles; only small relative transforms go
// to shaders. A failed or private warm-up frame must never become the previous
// player frame. This owns correspondence, not a second color accumulator.
export class RenderFrameState {
  constructor() {
    this.current = snapshot();
    this.previous = snapshot();
    this.valid = false;
    this.pending = false;
    this.sequence = 0;
    this.epoch = 0;
    this.reason = 'initial';
    this.rotation = new THREE.Matrix3();
    this.translation = new THREE.Vector3();
    this._rotation = new THREE.Quaternion();
    this._matrix = new THREE.Matrix4();
    this._previousCenter = new THREE.Vector3();
    this._eyeOffset = new THREE.Vector3();
  }

  invalidate(reason = 'explicit') {
    this.valid = false;
    this.reason = reason;
    this.epoch++;
  }

  begin(camera, origin, { context = null, timeEpoch = null, body = null } = {}) {
    if (this.pending) throw new Error('Render frame already pending');
    camera.updateWorldMatrix(true, false);
    const c = this.current, p = this.previous;
    c.origin.copy(origin);
    c.cameraWorld.copy(camera.matrixWorld);
    c.projection.copy(camera.projectionMatrix);
    c.inverseProjection.copy(camera.projectionMatrixInverse);
    c.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    c.context = context;c.timeEpoch = timeEpoch;c.body = body;
    c.near = camera.near;c.far = camera.far;
    c.medium = body?.weatherField || null;
    c.weather = body?.cloudWeatherPublication || null;
    c.bodyPosition.copy(body?.posUniv || c.origin);
    if (body?.frameOrientation) c.bodyOrientation.copy(body.frameOrientation);
    else c.bodyOrientation.identity();
    if (this.valid) {
      if (c.context !== p.context) this.invalidate('context');
      else if (c.timeEpoch !== p.timeEpoch) this.invalidate('time');
      // Continuous FOV/pose changes are mapped by the two projections. A
      // depth-encoding change cannot compare old logarithmic depth directly.
      else if (c.near !== p.near || c.far !== p.far) this.invalidate('depth-encoding');
    }
    this.pending = true;
    this._beginEpoch = this.epoch;
    return this.valid;
  }

  // Map a current render-space point on a rigid body into the previous render
  // space. Subtract nearby universe positions BEFORE rotation or float upload.
  // Weather advection/deformation needs its own mapping, not this rigid map.
  mapBody() {
    const c = this.current, p = this.previous;
    if (!this.pending || !this.valid || c.body !== p.body || c.medium !== p.medium) return false;
    if(!continuousWeather(c.weather,p.weather))return false;
    if (c.bodyOrientation.equals(p.bodyOrientation)) this.rotation.identity();
    else {
      this._rotation.copy(c.bodyOrientation).invert().premultiply(p.bodyOrientation);
      this.rotation.setFromMatrix4(this._matrix.makeRotationFromQuaternion(this._rotation));
    }
    this._previousCenter.copy(p.bodyPosition).sub(p.origin);
    this.translation.copy(c.origin).sub(c.bodyPosition).applyMatrix3(this.rotation)
      .add(this._previousCenter);
    return true;
  }

  localEye(body, out) {
    const c = this.current;
    this._eyeOffset.setFromMatrixPosition(c.cameraWorld);
    out.copy(c.origin).sub(body.posUniv).add(this._eyeOffset);
    if (body.frameOrientation) out.applyQuaternion(this._rotation.copy(body.frameOrientation).invert());
    return out;
  }

  stationaryBodyView() {
    const c = this.current, p = this.previous;
    return this.pending && this.valid && c.body === p.body && c.medium === p.medium
      && continuousWeather(c.weather,p.weather)
      && c.origin.equals(p.origin) && c.bodyPosition.equals(p.bodyPosition)
      && c.bodyOrientation.equals(p.bodyOrientation) && c.cameraWorld.equals(p.cameraWorld)
      && c.projection.equals(p.projection);
  }

  commit() {
    if (!this.pending) throw new Error('No render frame pending');
    this.pending = false;
    if (this.epoch !== this._beginEpoch) return false;
    const previous = this.previous;
    this.previous = this.current;this.current = previous;
    this.valid = true;
    this.sequence++;
    return true;
  }

  abort(reason = 'failed-frame') {
    this.pending = false;
    this.invalidate(reason);
  }
}
