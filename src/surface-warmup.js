import * as THREE from 'three';

// Warm the real material/geometry variants without drawing the live world or
// changing its light/shadow state. The temporary scene owns only light clones.
export function createSurfaceWarmupScene(source,group,camera,shadowLight) {
  const scene=new THREE.Scene(),parent=group.parent,lights=[];
  scene.environment=source.environment;scene.fog=source.fog;
  scene.environmentIntensity=source.environmentIntensity;
  scene.environmentRotation.copy(source.environmentRotation);
  const add=light=>{
    const copy=light.clone();copy.position.copy(light.getWorldPosition(new THREE.Vector3()));
    copy.quaternion.copy(light.getWorldQuaternion(new THREE.Quaternion()));
    if(copy.target) {
      copy.target.position.copy(light.target.getWorldPosition(new THREE.Vector3()));
      scene.add(copy.target);
    }
    if(copy.shadow) {
      copy.shadow.mapSize.set(2,2);
      if(light===shadowLight) {
        copy.shadow.autoUpdate=true;
        copy.shadow.needsUpdate=true;
      }
    }
    if(light===shadowLight) {
      copy.visible=true;copy.intensity=1;
      copy.position.set(0,4000,0);copy.target.position.set(0,0,0);
    }
    lights.push(copy);scene.add(copy);
  };
  let included=false;
  source.traverseVisible(object=>{
    if(object.isLight && object.layers.test(camera.layers)) {
      add(object);if(object===shadowLight)included=true;
    }
  });
  if(shadowLight && !included)add(shadowLight);
  scene.add(group);
  let disposed=false;
  return {scene,lights,dispose() {
    if(disposed)return;disposed=true;
    group.removeFromParent();if(parent)parent.add(group);
    for(const light of lights)light.shadow?.dispose();
    scene.clear();
  }};
}
