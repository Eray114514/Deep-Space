import * as THREE from 'three';

// Each final RepeatWrapping lookup owns its phase. In particular, the rock
// scale cannot be applied AFTER reducing the grass coordinate modulo one.
export function terrainDetailDomains(scale1 = 1 / 26, scale2 = 1 / 3.2) {
  if (![scale1, scale2].every(value => Number.isFinite(value) && value > 0)) {
    throw new RangeError('Invalid terrain detail scale.');
  }
  return [
    ['Sediment', 0.035], ['SedimentFine', 0.18], ['Ripple', 0.12],
    ['Shore', 0.0048], ['ShoreFine', 0.0011],
    ['Grain', scale1], ['GrainFine', scale2], ['Organic', scale2 * 0.32],
    ['Patch', 0.0035], ['PatchFine', 0.0012],
    ['Grass', 0.085], ['Rock', 0.085 * 0.78, 0.17],
  ].map(([name, scale, shift = 0]) => ({ name, scale, shift }));
}

export function terrainDetailPhase(domain, anchor, target = [0, 0, 0]) {
  const x = anchor.x * domain.scale + domain.shift;
  const y = anchor.y * domain.scale + domain.shift;
  const z = anchor.z * domain.scale + domain.shift;
  target[0] = x - Math.floor(x);
  target[1] = y - Math.floor(y);
  target[2] = z - Math.floor(z);
  return target;
}

export function terrainDetailGLSL(domains) {
  return `uniform mat3 uTerrainViewToLocal;
uniform vec4 uTerrainDomains[${domains.length}];
vec3 terrainDetailPosition() { return uTerrainViewToLocal * -vViewPosition; }
` + domains.map((domain, index) =>
    `#define terrain${domain.name} uTerrainDomains[${index}]`).join('\n') + '\n';
}

export function bindTerrainDetailFrame(material, planet, domains) {
  const uniforms = {
    uTerrainViewToLocal: { value: new THREE.Matrix3() },
    uTerrainDomains: { value: domains.map(() => new THREE.Vector4()) },
  };
  const cameraMatrix = new THREE.Matrix4(), bodyMatrix = new THREE.Matrix4();
  const localView = new THREE.Matrix4(), anchor = new THREE.Vector3();
  const phase = [0, 0, 0];
  let initialized = false;
  const previous = material.onBeforeRender;
  material.onBeforeRender = function (renderer, scene, camera, ...args) {
    previous?.call(this, renderer, scene, camera, ...args);
    // Common to all chunks: no per-object StandardMaterial uniform upload.
    // Actual draw camera includes cockpit offsets, remote views and rotation.
    const body = planet.group.matrixWorld;
    if (initialized && cameraMatrix.equals(camera.matrixWorld) && bodyMatrix.equals(body)) return;
    initialized = true;
    cameraMatrix.copy(camera.matrixWorld);
    bodyMatrix.copy(body);
    localView.copy(body).invert().multiply(camera.matrixWorld);
    anchor.setFromMatrixPosition(localView);
    uniforms.uTerrainViewToLocal.value.setFromMatrix4(localView);
    for (let index = 0; index < domains.length; index++) {
      const domain = domains[index];
      terrainDetailPhase(domain, anchor, phase);
      uniforms.uTerrainDomains.value[index].set(...phase, domain.scale);
    }
  };
  material.userData.terrainDetailUniforms = uniforms;
  return uniforms;
}
