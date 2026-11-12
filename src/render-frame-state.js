import * as THREE from 'three';

function halton(index, base) {
  let result = 0, f = 1 / base, i = index;
  while (i > 0) {
    result += f * (i % base);
    i = Math.floor(i / base);
    f /= base;
  }
  return result;
}

export function haltonSubpixelJitter(sequence, out = new THREE.Vector2()) {
  const idx = (Math.abs(Math.trunc(sequence)) % 8) + 1;
  return out.set(halton(idx, 2) - 0.5, halton(idx, 3) - 0.5);
}

function snapshot() {
  return {
    origin: new THREE.Vector3(),
    cameraWorld: new THREE.Matrix4(),
    projection: new THREE.Matrix4(),
    inverseProjection: new THREE.Matrix4(),
    viewProjection: new THREE.Matrix4(),
    jitterPixels: new THREE.Vector2(),
    jitterNdc: new THREE.Vector2(),
    bodyPosition: new THREE.Vector3(),
    bodyOrientation: new THREE.Quaternion(),
    view: new THREE.Matrix4(),
    rigidObjects: new WeakMap(),
    capturedRigidMeshes: [],
    rigidCapture: 0,
    exposure: 1,
    weatherHours: null,
    windRadiansPerHour: 0,
    oceanTime: null,
    oceanPhases: null,
    context: null, timeEpoch: null, body: null, medium: null, weather: null, near: 0, far: 0,
  };
}

function continuousWeather(current, previous) {
  if (current === previous) return true;
  // A natural forecast rollover shares the actual endpoint object identity
  // represented by its revision. A replacement at the same hour does not.
  return Boolean(current && previous && current.owner === previous.owner
    && (current.first === previous.second || current.second === previous.first));
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
    this.jitterEnabled = false;
    this.sequence = 0;
    this.epoch = 0;
    this.reason = 'initial';
    this.rotation = new THREE.Matrix3();
    this.translation = new THREE.Vector3();
    this.curBodyInv = new THREE.Matrix3();
    this.prevBodyRot = new THREE.Matrix3();
    this.curBodyCenter = new THREE.Vector3();
    this.prevBodyCenter = new THREE.Vector3();
    this.weatherWindDeltaRad = 0;
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

  begin(camera, origin, {
    context = null,
    timeEpoch = null,
    body = null,
    exposure = 1,
    jitterWidth = 0,
    jitterHeight = 0,
  } = {}) {
    if (this.pending) throw new Error('Render frame already pending');
    camera.updateWorldMatrix(true, false);
    const c = this.current, p = this.previous;
    c.origin.copy(origin);
    c.cameraWorld.copy(camera.matrixWorld);
    c.projection.copy(camera.projectionMatrix);
    c.inverseProjection.copy(camera.projectionMatrixInverse);
    c.view.copy(camera.matrixWorldInverse);
    c.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    if (this.jitterEnabled && jitterWidth > 0 && jitterHeight > 0) {
      haltonSubpixelJitter(this.sequence, c.jitterPixels);
      c.jitterNdc.set(
        (2 * c.jitterPixels.x) / jitterWidth,
        (2 * c.jitterPixels.y) / jitterHeight,
      );
    } else {
      c.jitterPixels.set(0, 0);
      c.jitterNdc.set(0, 0);
    }
    c.rigidCapture++;
    c.capturedRigidMeshes.length = 0;
    c.context = context; c.timeEpoch = timeEpoch; c.body = body;
    c.near = camera.near; c.far = camera.far;
    c.medium = body?.weatherField || null;
    c.weather = body?.cloudWeatherPublication || null;
    c.weatherHours = Number.isFinite(body?.weatherHours) ? Number(body.weatherHours) : null;
    c.windRadiansPerHour = Number.isFinite(body?.weatherField?.windRadiansPerHour)
      ? Number(body.weatherField.windRadiansPerHour)
      : Number.isFinite(body?.weatherField?.system?.advectionRadiansPerHour)
        ? Number(body.weatherField.system.advectionRadiansPerHour) : 0;
    const oceanUniforms = body?.liquidMat?.userData?.shader?.uniforms
      || body?.liquidMat?.userData?.waterUniforms || null;
    c.oceanTime = Number.isFinite(oceanUniforms?.uOceanTime?.value)
      ? Number(oceanUniforms.uOceanTime.value) : null;
    if (Array.isArray(oceanUniforms?.uOceanPhases?.value)) {
      const src = oceanUniforms.uOceanPhases.value;
      if (!c.oceanPhases || c.oceanPhases.length !== src.length) {
        c.oceanPhases = src.map(v => new THREE.Vector2(v.x, v.y));
      } else {
        for (let i = 0; i < src.length; i++) c.oceanPhases[i].copy(src[i]);
      }
    } else {
      c.oceanPhases = null;
    }
    const validExposure = Number.isFinite(exposure) && exposure > 0;
    c.exposure = validExposure ? Number(exposure) : 1;
    c.bodyPosition.copy(body?.posUniv || c.origin);
    if (body?.frameOrientation) c.bodyOrientation.copy(body.frameOrientation);
    else c.bodyOrientation.identity();
    if (this.valid) {
      if (!validExposure) this.invalidate('exposure');
      else if (c.context !== p.context) this.invalidate('context');
      else if (c.timeEpoch !== p.timeEpoch) this.invalidate('time');
      // Continuous FOV/pose changes are mapped by the two projections. A
      // depth-encoding change cannot compare old logarithmic depth directly.
      else if (c.near !== p.near || c.far !== p.far) this.invalidate('depth-encoding');
    }
    this.pending = true;
    this._beginEpoch = this.epoch;
    return this.valid;
  }

  applyCameraJitter(camera) {
    if (!this.pending) return false;
    const j = this.current.jitterNdc;
    if (j.x === 0 && j.y === 0) return false;
    camera.projectionMatrix.copy(this.current.projection);
    camera.projectionMatrix.elements[8] += j.x;
    camera.projectionMatrix.elements[9] += j.y;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    return true;
  }

  restoreCameraProjection(camera) {
    if (!this.pending) return;
    camera.projectionMatrix.copy(this.current.projection);
    camera.projectionMatrixInverse.copy(this.current.inverseProjection);
  }

  exposureRatio() {
    if (!this.pending || !this.valid) return 1;
    return this.current.exposure / Math.max(this.previous.exposure, 1e-6);
  }

  #recordRigidNode(node, owner, current) {
    let record = current.rigidObjects.get(node);
    if (!record) {
      record = { clipFromLocal: new THREE.Matrix4() };
      current.rigidObjects.set(node, record);
    }
    // Compose in CPU doubles against the UNJITTERED projection before upload.
    this._matrix.multiplyMatrices(current.view, node.matrixWorld);
    record.clipFromLocal.multiplyMatrices(current.projection, this._matrix);
    record.capture = current.rigidCapture;
    record.owner = owner;
  }

  captureRigidObjects(objects, scene) {
    if (!this.pending) throw new Error('No render frame pending');
    const current = this.current;
    for (const [object, owner] of objects) {
      let node = object;
      while (node && node !== scene && node.visible) node = node.parent;
      if (node !== scene || !scene.visible) continue;
      object.updateWorldMatrix(true, true);
      this.#recordRigidNode(object, owner, current);
      object.traverseVisible((child) => {
        if (child !== object && child.isMesh) {
          this.#recordRigidNode(child, owner, current);
          current.capturedRigidMeshes.push({ mesh: child, root: object, owner });
        } else if (child === object && child.isMesh) {
          current.capturedRigidMeshes.push({ mesh: child, root: object, owner });
        }
      });
    }
  }

  rigidProjection(object, currentClipFromLocal, previousClipFromLocal) {
    if (!this.pending || !this.valid) return false;
    const current = this.current.rigidObjects.get(object);
    const previous = this.previous.rigidObjects.get(object);
    if (!current || !previous || current.capture !== this.current.rigidCapture
      || previous.capture !== this.previous.rigidCapture || current.owner !== previous.owner) return false;
    currentClipFromLocal.copy(current.clipFromLocal);
    previousClipFromLocal.copy(previous.clipFromLocal);
    return true;
  }

  // Map a current render-space point on a rigid body into the previous render
  // space. Subtract nearby universe positions BEFORE rotation or float upload.
  mapBody() {
    const c = this.current, p = this.previous;
    if (!this.pending || !this.valid || c.body !== p.body || c.medium !== p.medium) return false;
    if (!continuousWeather(c.weather, p.weather)) return false;
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

  // Multi-layer weather advection + rigid body rotation + CPU-double origin shift.
  mapWeatherAdvection() {
    if (!this.mapBody()) return false;
    const c = this.current, p = this.previous;
    this.curBodyCenter.copy(c.bodyPosition).sub(c.origin);
    this.prevBodyCenter.copy(p.bodyPosition).sub(p.origin);
    this._rotation.copy(c.bodyOrientation).invert();
    this.curBodyInv.setFromMatrix4(this._matrix.makeRotationFromQuaternion(this._rotation));
    this.prevBodyRot.setFromMatrix4(this._matrix.makeRotationFromQuaternion(p.bodyOrientation));
    const dh = (c.weatherHours !== null && p.weatherHours !== null)
      ? c.weatherHours - p.weatherHours : 0;
    this.weatherWindDeltaRad = Number.isFinite(dh) && Math.abs(dh) < 2.0
      ? dh * c.windRadiansPerHour : 0;
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
      && continuousWeather(c.weather, p.weather)
      && c.jitterPixels.equals(p.jitterPixels)
      && (c.weatherHours === p.weatherHours || c.windRadiansPerHour === 0)
      && c.origin.equals(p.origin) && c.bodyPosition.equals(p.bodyPosition)
      && c.bodyOrientation.equals(p.bodyOrientation) && c.cameraWorld.equals(p.cameraWorld)
      && c.projection.equals(p.projection);
  }

  commit() {
    if (!this.pending) throw new Error('No render frame pending');
    this.pending = false;
    if (this.epoch !== this._beginEpoch) return false;
    const previous = this.previous;
    this.previous = this.current; this.current = previous;
    this.valid = true;
    this.sequence++;
    return true;
  }

  abort(reason = 'failed-frame') {
    this.pending = false;
    this.invalidate(reason);
  }
}
