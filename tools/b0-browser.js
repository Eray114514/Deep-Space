// Browser-only helpers, imported by B0 diagnostics. No campaign mutations.
import * as THREE from 'three';

export function installCaptureHold() {
  const pipeline = NMS._pipeline;
  const original = pipeline.render;
  window.__b0Exposure = null;
  pipeline.render = function (...args) {
    if (window.__b0Exposure !== null) NMS._renderer.toneMappingExposure = window.__b0Exposure;
    if (pipeline.grade?.uniforms.uTime) pipeline.grade.uniforms.uTime.value = 0;
    return original.apply(this, args);
  };
}

export function snapshot(index) {
  const p = NMS._planet(index), { nav, camera } = NMS._internals;
  const local = p.worldPositionToLocal(nav.pos, new THREE.Vector3());
  const radial = local.clone().normalize();
  const renderer = NMS._renderer;
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  return {
    body: { index, id: p.bodyId, seed: p.seed, type: p.type, radiusMeters: p.R,
      atmosphere: p.atmosphere, cloudBand: { ...p.volCloudBand } },
    camera: { navLocalMeters: local.toArray(), navWorldMeters: nav.pos.toArray(),
      cameraRelativeMeters: camera.position.toArray(), worldQuaternion: camera.quaternion.toArray(),
      projection: camera.projectionMatrix.toArray(), fov: camera.fov, near: camera.near, far: camera.far,
      altitudeMeters: local.length() - p.R, groundClearanceMeters: local.length() - p.surfaceRadius(radial) },
    time: NMS.time(), weatherHours: p.weatherHours, cloudSpin: p.cloudSpin,
    weatherFingerprint: p.weatherFingerprint(64), cloudOffsets: p.cloudOffsets,
    sources: (p.stellarLightField?.sources || []).map((s) => ({ id: s.id,
      localDirection: s.localDirection.toArray(), color: s.colorValue.toArray(), energy: s.irradianceFraction,
      elevationDegrees: Math.asin(THREE.MathUtils.clamp(s.localDirection.dot(radial), -1, 1)) * 180 / Math.PI })),
    render: { exposure: renderer.toneMappingExposure, exposureHeld: window.__b0Exposure !== null,
      css: [innerWidth, innerHeight], drawingBuffer: size.toArray(), browserDpr: devicePixelRatio,
      renderDpr: NMS.stats().dpr, adaptiveLocked: true, post: true, hud: true, gradeTime: 0 },
    stats: NMS.stats(), atmosphere: NMS.atmosphereState(), volume: NMS.volumeState(),
  };
}

// Fix time, then select dry ground on the requested solar-elevation circle.
// A scenic landing's latitude need not reach every elevation by rotation.
export function groundPose(index, degrees) {
  NMS.setTime(9.5);
  if (!NMS.land(index)) throw Error('Baseline world must be landable');
  const p = NMS._planet(index), sun = p.sunDirLocal.clone().normalize();
  const axis = Math.abs(sun.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
  const east = new THREE.Vector3().crossVectors(sun, axis).normalize();
  const north = new THREE.Vector3().crossVectors(sun, east).normalize();
  const elevation = degrees * Math.PI / 180;
  let best = null, score = Infinity;
  for (let i = 0; i < 512; i++) {
    const phi = i * Math.PI * 2 / 512;
    const dir = sun.clone().multiplyScalar(Math.sin(elevation))
      .addScaledVector(east, Math.cos(elevation) * Math.cos(phi))
      .addScaledVector(north, Math.cos(elevation) * Math.sin(phi)).normalize();
    const h = p.height(dir, p.fullMaxFreq);
    if (p.hasLiquid && h < p.seaLevel + 4) continue;
    const tangent = new THREE.Vector3().crossVectors(dir, sun).normalize();
    const nearby = dir.clone().addScaledVector(tangent, 20 / p.R).normalize();
    const slope = Math.abs(p.height(nearby, p.fullMaxFreq) - h) / 20;
    if (slope < score) { score = slope; best = dir; }
  }
  if (!best || !NMS.setWalkDirection(best.toArray())) throw Error(`No dry ground at ${degrees}° on p${index}`);
  NMS.lookPitch(45);
  return { hours: NMS.time().hours, requestedDegrees: degrees,
    actualDegrees: Math.asin(sun.dot(best)) * 180 / Math.PI, groundDirection: best.toArray() };
}

// Read production density on a spherical grid, then choose an occupied column
// near the requested local solar elevation. This confirms cloud presence, not
// global coverage or species identity. Never use the disconnected CPU fixture.
export function occupiedColumn(index, solarDegrees) {
  const p = NMS._planet(index), source = p.volCloudMat;
  const columns = 1024, rows = 48;
  const prefix = source.fragmentShader.slice(0, source.fragmentShader.lastIndexOf('void main()'));
  const material = new THREE.ShaderMaterial({ uniforms: source.uniforms, depthTest: false, depthWrite: false,
    vertexShader: `varying vec3 vDirection,vViewDirection; void main() {
      vDirection=vec3(0,1,0);vViewDirection=vec3(0,0,-1);gl_Position=vec4(position.xy,0,1); }`,
    fragmentShader: prefix + `void main() {
      float i=floor(gl_FragCoord.x), z=1.0-2.0*(i+0.5)/${columns}.0;
      float phi=i*2.399963229728653;
      vec3 d=vec3(sqrt(1.0-z*z)*cos(phi),z,sqrt(1.0-z*z)*sin(phi));
      float r=mix(uRin,uRout,(floor(gl_FragCoord.y)+0.5)/${rows}.0);
      float density=densityAt(d*r);gl_FragColor=vec4(density,0,0,1); }` });
  const geometry = new THREE.PlaneGeometry(2, 2), scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const target = new THREE.WebGLRenderTarget(columns, rows, { type: THREE.FloatType, depthBuffer: false });
  const renderer = NMS._renderer, previous = renderer.getRenderTarget();
  const scissorTest = renderer.getScissorTest();
  const data = new Float32Array(columns * rows * 4);
  try {
    renderer.setScissorTest(false); renderer.setRenderTarget(target);
    renderer.render(scene, new THREE.Camera());
    renderer.readRenderTargetPixels(target, 0, 0, columns, rows, data);
  } finally {
    renderer.setRenderTarget(previous); renderer.setScissorTest(scissorTest);
    geometry.dispose(); material.dispose(); target.dispose();
  }
  if (data[3] !== 1 || data.some((v) => !Number.isFinite(v))) throw Error('Invalid density readback');
  const band = p.volCloudBand, thickness = band.rOut - band.rIn;
  const candidates = [];
  let occupied = 0;
  for (let i = 0; i < columns; i++) {
    const z = 1 - 2 * (i + 0.5) / columns, phi = i * 2.399963229728653;
    const direction = new THREE.Vector3(Math.sqrt(1 - z * z) * Math.cos(phi), z,
      Math.sqrt(1 - z * z) * Math.sin(phi));
    const elevation = Math.asin(THREE.MathUtils.clamp(direction.dot(p.sunDirLocal), -1, 1)) * 180 / Math.PI;
    let sum = 0, maximum = 0, row = 0, first = rows, last = -1;
    for (let j = 0; j < rows; j++) {
      const d = data[(j * columns + i) * 4];
      if (d > 0.01) { first = Math.min(first, j); last = j; occupied++; }
      if (d > maximum) { maximum = d; row = j; }
      sum += d;
    }
    if (maximum > 0.1 && Math.abs(elevation - solarDegrees) < 6) {
      const firstAltitude = band.rIn - p.R + (first + 0.5) / rows * thickness;
      if (p.surfaceRadius(direction) - p.R + 500 >= firstAltitude) continue;
      candidates.push({ gridIndex: i, direction: direction.toArray(), elevation,
        maximum, sum, firstAltitude, lastAltitude: band.rIn - p.R + (last + 0.5) / rows * thickness,
        insideAltitude: band.rIn - p.R + (row + 0.5) / rows * thickness });
    }
  }
  candidates.sort((a, b) => b.sum - a.sum);
  if (!candidates.length) throw Error(`No occupied sun-angle column for body ${index}, ${solarDegrees}°`);
  return { ...candidates[0], occupiedSamples: occupied, totalSamples: columns * rows,
    method: 'Production densityAt, 1024 directions x 48 heights; occupancy >0.01, peak >0.1',
    belowAltitude: Math.max(p.surfaceRadius(new THREE.Vector3(...candidates[0].direction)) - p.R + 500,
      candidates[0].firstAltitude - 1500), aboveAltitude: band.rOut - p.R + 1500 };
}

export function cloudPose(index, column, scene) {
  const p = NMS._planet(index), dir = new THREE.Vector3(...column.direction);
  let altitude = column.insideAltitude;
  let pitch = 0;
  if (scene === 'S2-below') { altitude = column.belowAltitude; pitch = 0.3; }
  if (scene === 'S2-above') { altitude = column.aboveAltitude; pitch = -0.22; }
  if (scene === 'S3-oblique') { altitude = Math.max(p.R / 15, column.aboveAltitude * 2); pitch = -0.28; }
  if (scene === 'S4-globe') {
    NMS.teleport(index, 1.2, { dir: column.direction }); return;
  }
  if (scene === 'S2-side') {
    const tangent = new THREE.Vector3().crossVectors(dir, p.sunDirLocal).normalize();
    const cameraDir = dir.clone().addScaledVector(tangent, Math.min(80000, p.R * 0.1) / p.R).normalize();
    NMS.teleport(index, altitude / p.R, { dir: cameraDir.toArray(), horizon: true });
    const target = p.localPositionToWorld(dir.clone().multiplyScalar(p.R + altitude), new THREE.Vector3());
    const up = p.localOffsetToWorld(cameraDir, new THREE.Vector3()).normalize();
    NMS._internals.nav.quat.setFromRotationMatrix(new THREE.Matrix4().lookAt(NMS._internals.nav.pos, target, up));
  } else NMS.setAtmosphereAltitude(index, altitude, { dir: column.direction, pitch });
}
