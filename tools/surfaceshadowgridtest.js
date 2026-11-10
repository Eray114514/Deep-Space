import assert from 'node:assert/strict';
import { DirectionalLight, Vector3 } from 'three';
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
console.log(JSON.stringify({passed:true,cases,maximumPhaseError,previousDrift}));

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
