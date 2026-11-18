import * as THREE from 'three';
import { selectStellarOcclusionVariant } from './stellar-occlusion.js';
import { createSurfaceWarmupScene } from './surface-warmup.js';
import { compilePrograms } from './program-preparation.js';
import { cloudSurfaceReceiverReady } from './cloud/cloud-surface-shadow-pass.js';
import { surfaceCloudOwner, withCloudSurfacePreparation } from './cloud/surface-clouds.js';

const screenDefine='SURFACE_CLOUD_SCREEN';

// compile() does not run material draw hooks. Select the same screen receiver
// variant as an actual receiver-depth draw, without retaining live state across
// readiness awaits. A private warm draw uses this same synchronous scope.
export function withSurfaceWarmupVariant(source, work, screenClouds = true) {
  const materials=new Map();
  source.traverse(object=>{
    if(!object.isMesh)return;
    for(const material of [object.material].flat()) {
      const owner=surfaceCloudOwner(material);
      if(owner)materials.set(material,owner);
    }
  });
  const screen=Number(screenClouds && [...materials.values()].some(cloudSurfaceReceiverReady));
  const saved=[];
  try {
    for(const [material,owner] of materials) {
      selectStellarOcclusionVariant(material,owner);
      const original=material.defines,defines=original||{};
      const property=Object.getOwnPropertyDescriptor(defines,screenDefine);
      const changed=!property||property.value!==screen;
      saved.push({material,original,defines,property,changed,own:Object.hasOwn(material,'defines')});
      material.defines=defines;defines[screenDefine]=screen;
      if(changed)material.needsUpdate=true;
    }
    return withCloudSurfacePreparation(Boolean(screen),work);
  } finally {
    for(const {material,original,defines,property,changed,own} of saved.reverse()) {
      const current=material.defines;
      // Preserve unrelated define edits even if work replaces the dictionary;
      // the original dictionary's identity still belongs to the caller.
      if(current!==defines) {
        for(const name of Reflect.ownKeys(defines)) {
          if(name!==screenDefine&&!Object.hasOwn(current||{},name))delete defines[name];
        }
        for(const name of Reflect.ownKeys(current||{})) {
          if(name!==screenDefine)Object.defineProperty(defines,name,Object.getOwnPropertyDescriptor(current,name));
        }
      }
      const mutated=!Object.hasOwn(defines,screenDefine)||defines[screenDefine]!==screen;
      if(property)Object.defineProperty(defines,screenDefine,property);
      else delete defines[screenDefine];
      if(original||Reflect.ownKeys(defines).length)material.defines=defines;
      else if(own)material.defines=original;
      else delete material.defines;
      // Never roll back Three's monotonic version: both selecting the temporary
      // variant and restoring the live one must invalidate cached selection.
      if(changed||mutated||current!==defines)material.needsUpdate=true;
    }
  }
}

// Three.compileAsync gathers programs synchronously, then polls readiness.
// Give that synchronous phase its own camera/renderable/light objects. Never
// retain a lease on live camera layers, mesh flags or framebuffer while awaiting.
export function createCompileCamera(camera, layer) {
  // Camera.clone() ignores the recursive argument. copy(..., false) is needed
  // to avoid cloning attached first-person rigs and their instance buffers.
  const copy = new camera.constructor().copy(camera, false);
  copy.layers.set(layer);
  return copy;
}

export function compileRenderVariant(renderer,source,camera,scene,{layer,target,shadowLight=null,signal}) {
  const compileCamera=createCompileCamera(camera,layer),group=new THREE.Group(),instances=[];
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
    return compilePrograms(renderer,group,compileCamera,warmup.scene,{signal});
  } finally {
    renderer.setRenderTarget(saved,face,mip);
    warmup.dispose();for(const instance of instances)instance.dispose();group.clear();
  }
}
