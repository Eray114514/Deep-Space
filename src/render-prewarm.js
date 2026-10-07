import * as THREE from 'three';
import { createSurfaceWarmupScene } from './surface-warmup.js';

// Three.compileAsync gathers programs synchronously, then polls readiness.
// Give that synchronous phase its own camera/renderable/light objects. Never
// retain a lease on live camera layers, mesh flags or framebuffer while awaiting.
export function compileRenderVariant(renderer,source,camera,scene,{layer,target,shadowLight=null}) {
  const compileCamera=camera.clone(),group=new THREE.Group(),instances=[];
  compileCamera.layers.set(layer);
  source.traverse(object=>{
    if(!(object.isMesh||object.isPoints||object.isLine||object.isSprite)
      || !object.layers.test(compileCamera.layers))return;
    const copy=object.clone(false);group.add(copy);
    if(copy.isInstancedMesh)instances.push(copy);
  });
  // The input contains no lights, so compile's two traversals cannot collect
  // the ship's interior lights twice. Only the private target scene owns them.
  const warmup=createSurfaceWarmupScene(scene,group,compileCamera,shadowLight);
  const saved=renderer.getRenderTarget(),face=renderer.getActiveCubeFace(),mip=renderer.getActiveMipmapLevel();
  try {
    renderer.setRenderTarget(target);
    return renderer.compileAsync(group,compileCamera,warmup.scene);
  } finally {
    renderer.setRenderTarget(saved,face,mip);
    warmup.dispose();for(const instance of instances)instance.dispose();group.clear();
  }
}
