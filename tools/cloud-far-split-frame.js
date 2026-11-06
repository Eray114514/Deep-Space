import { Frustum, Matrix4, Vector4 } from '../vendor/three.module.js';
import { minimumCloudRayCone } from '../src/cloud/cloud-footprint.js';
import { admitCloudFarSplit } from './cloud-far-split-routing.js';

// Restricted diagnostic collector: the current cloud meshes, scalar transparent
// materials and Three's default sort. Unsupported renderables fail closed.
export function collectCloudSplitOwners(scene, camera, owners) {
  scene.updateMatrixWorld(true);camera.updateMatrixWorld(true);
  const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const frustum = new Frustum().setFromProjectionMatrix(projection);
  const rows = [];
  function visit(object, groupOrder = 0) {
    if (!object.visible) return;
    if (object.layers.test(camera.layers)) {
      if (object.isGroup) groupOrder = object.renderOrder;
      if (object.isLOD || object.isSprite || object.isLine || object.isPoints) throw Error('Unsupported split renderable');
      if (object.isMesh && (!object.frustumCulled || frustum.intersectsObject(object))) {
        const material = object.material, owner = owners.get(object);
        if (Array.isArray(material)) throw Error('Split material arrays require group-aware routing');
        if (material?.visible) {
          if (!owner || owner.reference !== material || !material.transparent || material.transmission > 0
            || object.isInstancedMesh || object.isSkinnedMesh) throw Error('Unsupported split owner');
          if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
          // Match the vendored renderer's clip-space z exactly. Dividing by w
          // (Vector3.applyMatrix4) loses far-distance ordering precision.
          const center = new Vector4().copy(object.geometry.boundingSphere.center)
            .applyMatrix4(object.matrixWorld).applyMatrix4(projection);
          rows.push({object, owner, groupOrder, renderOrder:object.renderOrder, z:center.z, id:object.id});
        }
      }
    }
    for (const child of object.children) visit(child, groupOrder);
  }
  visit(scene);
  return rows.sort((a,b) => a.groupOrder-b.groupOrder || a.renderOrder-b.renderOrder || b.z-a.z || a.id-b.id);
}

function values(value, out) {
  out.push(value);
  if (value === null || typeof value !== 'object') return;
  if (value.isTexture) { out.push(value.version);return; }
  if (Array.isArray(value) || ArrayBuffer.isView(value)) { for (const item of value) values(item,out);return; }
  if (value.toArray) { out.push(...value.toArray());return; }
  throw Error('Unsupported mutable split uniform');
}
function snapshot(scene, camera, owners, rows, targets) {
  const out = [scene, camera, camera.layers.mask, camera.near, camera.far,
    ...camera.matrixWorld.elements, ...camera.projectionMatrix.elements, ...camera.projectionMatrixInverse.elements];
  scene.traverse(object => out.push(object, object.parent, object.visible, object.layers.mask, object.renderOrder,
    object.geometry, object.material, ...object.matrixWorld.elements));
  for (const row of rows) {
    out.push(owners.get(row.object),row.owner.outerRadius,row.groupOrder,row.renderOrder,row.z);
    for (const material of Object.values(row.owner.programs)) {
      out.push(material,material.version,material.uniforms,material.visible,material.transparent,material.blending,
        material.depthTest,material.depthWrite,material.colorWrite,material.side,material.premultipliedAlpha,
        material.forceSinglePass,material.vertexShader,material.fragmentShader,JSON.stringify(material.defines));
      for (const [name, uniform] of Object.entries(material.uniforms)) { out.push(name,uniform);values(uniform.value,out); }
    }
  }
  for (const target of targets) out.push(target,target.width,target.height,...target.textures,
    ...target.viewport.toArray(),...target.scissor.toArray(),target.scissorTest);
  return out;
}

// All draws must target unpublished staging storage. publish is invoked only
// after every stage validates. This deliberately scans state, not a hot-path API.
export function planCloudSplitFrame({scene,camera,owners,tracker,prepared,targets,width,height,scratchBytes}) {
  const rows = collectCloudSplitOwners(scene,camera,owners);
  const entries = rows.map(row => {
    const owner = row.owner;
    const eye = owner.reference.uniforms.uCameraLocal.value;
    const admission = admitCloudFarSplit(owner.reference,{tracker,width,height,scratchBytes,
      minimumFootprint:Math.max(0,eye.length()-owner.outerRadius)*minimumCloudRayCone(camera.projectionMatrix.elements,width,height)});
    const stages = admission.route === 'mixed' ? ['point','cached','combine'] : [admission.route+'Direct'];
    if (stages.some(stage => !prepared.has(owner.programs[stage]))) throw Error('Split program not prepared');
    return {...row,admission,stages};
  });
  const initial = snapshot(scene,camera,owners,rows,targets);
  let retired = false, consumed = false, cancelled = false;
  const disposables = new Set(targets);
  for (const row of rows) {
    disposables.add(row.object.geometry);
    for (const material of Object.values(row.owner.programs)) {
      disposables.add(material);
      for (const uniform of Object.values(material.uniforms)) if (uniform.value?.isTexture) disposables.add(uniform.value);
    }
  }
  const retire = () => { retired = true; };
  for (const object of disposables) object.addEventListener('dispose',retire);
  const release = () => { for (const object of disposables) object.removeEventListener('dispose',retire); };
  function validate() {
    if (retired || cancelled) throw Error('Retired or cancelled split frame');
    const currentRows = collectCloudSplitOwners(scene,camera,owners);
    const current = snapshot(scene,camera,owners,currentRows,targets);
    if (initial.length !== current.length || initial.some((value,i) => !Object.is(value,current[i]))) throw Error('Stale split frame');
    for (const entry of entries) {
      entry.admission.validate();
      if (entry.stages.some(stage => !prepared.has(entry.owner.programs[stage]))) throw Error('Split preparation revoked');
    }
  }
  return {
    entries,
    cancel() { cancelled = true;release(); },
    execute({draw,publish}) {
      if (consumed) throw Error('Split frame already consumed');
      consumed = true;
      try {
        validate();
        for (const entry of entries) for (const stage of entry.stages) { validate();draw(entry,stage); }
        validate();return publish();
      } finally { release(); }
    },
  };
}
