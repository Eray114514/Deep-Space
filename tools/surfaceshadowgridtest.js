import assert from 'node:assert/strict';
import { DirectionalLight, Quaternion, Vector3 } from 'three';
import { SurfaceShadowGrid } from '../src/surface-shadow-grid.js';

const grid=new SurfaceShadowGrid(), light=new DirectionalLight();
const body=new Vector3(2e11,-1e11,3e11);
const localReceiver=new Vector3(4372851,-2861923,2929279);
const relative=new Vector3(), uv=new Vector3();
let maximumPhaseError=0, previousDrift=0, cases=0;

for(const [distance,mapSize] of [[180,1024],[350,2048],[650,4096],[422.5,4096]]) {
  light.shadow.mapSize.set(mapSize,mapSize);
  for(const direction of [new Vector3(.48,.77,-.62),new Vector3(0,1,0),new Vector3(0,-1,0)]) {
    light.position.copy(direction.normalize()).multiplyScalar(4000);
    light.updateMatrixWorld();light.target.updateMatrixWorld();
    const oldSample=sample(false,0,distance);
    const first=sample(true,0,distance);
    for(const move of [-1.25,-.53,-.29,.21,.61,1.37]) {
      const next=sample(true,move,distance);
      const x=next.x-first.x, y=next.y-first.y;
      const error=Math.max(Math.abs(x-Math.round(x)),Math.abs(y-Math.round(y)));
      maximumPhaseError=Math.max(maximumPhaseError,error);
      assert.ok(error<1e-6,`Subtexel phase shifted by ${error}`);
      const unsnapped=sample(false,move,distance);
      previousDrift=Math.max(previousDrift,Math.abs(unsnapped.x-oldSample.x-Math.round(unsnapped.x-oldSample.x)));
      cases++;
    }
  }
}
assert.ok(previousDrift>.2,'Control must reproduce subtexel drift');

// Rotating-planet stability: on a live R=1,200 km world at TIME_SCALE=60,
// snapping against bodyCenter multiplied angular spin by 1.2e6 m and caused
// ~0.9 texel single-frame sawtooth jumps while standing still. Anchoring in
// the planet's rotating local frame must keep standing-still step < 0.02 texel
// AND preserve exact sub-texel phase across >48 m walking rebases.
{
  const rotGrid = new SurfaceShadowGrid();
  const rotLight = new DirectionalLight();
  rotLight.shadow.mapSize.set(2048, 2048);
  rotLight.position.set(0.48, 0.77, -0.62).normalize().multiplyScalar(1400);
  rotLight.updateMatrixWorld(); rotLight.target.updateMatrixWorld();
  const radius = 180;
  const R = 1200000;
  const spinAxis = new Vector3(0.12, 0.98, -0.15).normalize();
  const q = new Quaternion(), invQ = new Quaternion();
  const planet = {
    bodyId: 'rot-test',
    worldOffsetToLocal: (w, out = new Vector3()) => out.copy(w).applyQuaternion(invQ),
    localOffsetToWorld: (l, out = new Vector3()) => out.copy(l).applyQuaternion(q),
  };
  const camLocal = new Vector3(0.71, -0.16, 0.68).normalize().multiplyScalar(R);
  const treeLocal = camLocal.clone().add(new Vector3(18, 0, -10));
  const spinPerFrame = (Math.PI * 2 / (24 * 3600)) * 60 / 60; // TIME_SCALE=60 at 60fps
  let prevUv = null, maxSpinStep = 0;
  for (let frame = 0; frame < 30; frame++) {
    q.setFromAxisAngle(spinAxis, frame * spinPerFrame);
    invQ.copy(q).invert();
    const camWorld = body.clone().add(planet.localOffsetToWorld(camLocal, new Vector3()));
    const treeWorld = body.clone().add(planet.localOffsetToWorld(treeLocal, new Vector3()));
    rotGrid.update(rotLight, camWorld, body, radius, 2048, planet);
    rotLight.shadow.updateMatrices(rotLight);
    const sampleUv = treeWorld.clone().sub(camWorld).applyMatrix4(rotLight.shadow.matrix).multiplyScalar(2048);
    if (prevUv) maxSpinStep = Math.max(maxSpinStep, Math.hypot(sampleUv.x - prevUv.x, sampleUv.y - prevUv.y));
    prevUv = sampleUv;
  }
  assert.ok(maxSpinStep < 0.02, `Rotating-planet standing-still shadow jumped ${maxSpinStep} texels/frame`);

  // Walking across multiple 48 m rebases with fixed orientation must keep exact sub-texel phase.
  q.setFromAxisAngle(spinAxis, 0.3); invQ.copy(q).invert();
  const walkBase = camLocal.clone();
  let walkFirst = null, maxWalkPhaseError = 0;
  for (const dist of [0, 12.3, 47.9, 48.2, 75.6, 120.4, 210.7]) {
    const posL = walkBase.clone().add(new Vector3(dist, 0, dist * 0.43));
    const camWorld = body.clone().add(planet.localOffsetToWorld(posL, new Vector3()));
    const treeWorld = body.clone().add(planet.localOffsetToWorld(treeLocal, new Vector3()));
    rotGrid.update(rotLight, camWorld, body, radius, 2048, planet);
    rotLight.shadow.updateMatrices(rotLight);
    const sampleUv = treeWorld.clone().sub(camWorld).applyMatrix4(rotLight.shadow.matrix).multiplyScalar(2048);
    if (!walkFirst) walkFirst = sampleUv;
    else {
      const dx = sampleUv.x - walkFirst.x, dy = sampleUv.y - walkFirst.y;
      const err = Math.max(Math.abs(dx - Math.round(dx)), Math.abs(dy - Math.round(dy)));
      maxWalkPhaseError = Math.max(maxWalkPhaseError, err);
    }
  }
  assert.ok(maxWalkPhaseError < 1e-6, `Phase-continuous rebase drifted by ${maxWalkPhaseError} texels`);
  console.log(JSON.stringify({ passed: true, cases, maximumPhaseError, previousDrift, maxSpinStep, maxWalkPhaseError }));
}

function sample(snapped,move,radius) {
  const map=light.shadow.mapSize, camera=light.shadow.camera;
  const origin=new Vector3().copy(body).add(localReceiver).add(new Vector3(3+move,8,12-move*.63));
  if(snapped) {
    grid.update(light,origin,body,radius,map.x);
    assert.ok(Math.abs(camera.right-camera.left-2*radius)<1e-10);
    assert.ok(Math.abs(camera.top-camera.bottom-2*radius)<1e-10);
    assert.ok(Math.abs(camera.left+radius)<=radius/map.x+1e-9);
    assert.ok(Math.abs(camera.bottom+radius)<=radius/map.y+1e-9);
  } else {
    camera.left=camera.bottom=-radius;camera.right=camera.top=radius;
    camera.updateProjectionMatrix();
  }
  light.shadow.updateMatrices(light);
  relative.subVectors(body,origin).add(localReceiver);
  return uv.copy(relative).applyMatrix4(light.shadow.matrix).multiplyScalar(map.x).clone();
}
