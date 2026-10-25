import * as THREE from 'three';
import { WORLD_LAYER } from './render-layers.js';
import { compilePrograms } from './program-preparation.js';
import { createCompileCamera, withSurfaceWarmupVariant } from './render-prewarm.js';

const renderable = object => object.isMesh || object.isPoints || object.isLine || object.isSprite;

function visit(root, excluded, work, visible = false) {
  if (!root || excluded.has(root) || (visible && !root.visible)) return;
  work(root);
  for (const child of root.children || []) visit(child, excluded, work, visible);
}

// Read transforms without forcing updates on live objects while preparing a
// future light domain. Respect an explicitly maintained world-matrix boundary.
function worldMatrix(object) {
  const chain = [];
  let parent = object;
  while (parent && parent.matrixWorldAutoUpdate !== false) {
    chain.push(parent);parent = parent.parent;
  }
  const matrix = parent ? parent.matrixWorld.clone() : new THREE.Matrix4();
  for (const node of chain.reverse()) matrix.multiply(node.matrixAutoUpdate
    ? new THREE.Matrix4().compose(node.position, node.quaternion, node.scale) : node.matrix);
  return matrix;
}

// This source is for the vendored compile() protocol only. Its material walk
// visits actual selected objects, preserving instancing/skinning/geometry flags
// without reparenting them or cloning their CPU instance buffers. Its light walk
// is empty: the independent target scene is the sole light owner.
export function compileDestinationVariant(renderer, {
  scene, camera, universeRoot, body, destination, ship, shadowLight, target,
  shadows = false, exclude = [],
}, { signal } = {}) {
  const compileCamera = createCompileCamera(camera, WORLD_LAYER);
  const omitted = new Set([universeRoot, ship?.group, ...exclude]);
  const selected = new Set();
  const collect = object => {
    if (renderable(object) && object.material && object.layers.test(compileCamera.layers)) selected.add(object);
  };
  visit(scene, omitted, collect);
  visit(body?.group, new Set(), collect);
  for (const view of destination?.starViews || []) visit(view.group, new Set(), collect);
  for (const site of destination?.artificialSites || []) {
    if (!site.parentBody) visit(site.group, new Set(), collect);
  }
  // Future parked hulls are currently on the foreground layer. Cabin lighting
  // stays isolated on layer 6 unless the legacy combined ship mode is selected.
  visit(ship?.group, new Set(ship?.separateInterior ? [ship.int?.group] : []), object => {
    if (renderable(object) && object.material) selected.add(object);
  });

  const source = new THREE.Group();
  source.traverse = work => { work(source);for (const object of selected) work(object); };
  source.traverseVisible = () => {};
  const lighting = new THREE.Scene();
  lighting.environment = scene.environment;lighting.fog = scene.fog;
  lighting.environmentIntensity = scene.environmentIntensity;
  lighting.environmentRotation.copy(scene.environmentRotation);
  const lights = new Set(), copies = [];
  const addLight = light => {
    if (!light || lights.has(light)) return;
    lights.add(light);
    const copy = light.clone(false);
    worldMatrix(light).decompose(copy.position, copy.quaternion, copy.scale);
    copy.visible = true;copy.layers.set(WORLD_LAYER);
    if (copy.target) {
      worldMatrix(light.target).decompose(copy.target.position, copy.target.quaternion, copy.target.scale);
      lighting.add(copy.target);
    }
    copies.push(copy);lighting.add(copy);
  };
  visit(scene, omitted, object => {
    if (object.isLight && object !== shadowLight && object.layers.test(compileCamera.layers)) addLight(object);
  }, true);
  if (shadows) addLight(shadowLight);
  const collectLight = object => {
    if (object.isLight && object.layers.test(compileCamera.layers)) addLight(object);
  };
  const futureRootLights = root => {
    if (!root) return;
    // Prepared ownership hides these roots until preview/adoption. Only that
    // root's visibility changes; locally hidden descendants remain hidden.
    collectLight(root);
    for (const child of root.children || []) visit(child, new Set(), collectLight, true);
  };
  for (const view of destination?.starViews || []) {
    addLight(view.light);futureRootLights(view.group);
  }
  futureRootLights(body?.group);
  for (const site of destination?.artificialSites || []) {
    if (!site.parentBody) futureRootLights(site.group);
  }
  if (ship && !ship.separateInterior) visit(ship.group, new Set(), object => {
    if (object.isLight) addLight(object);
  }, true);

  const saved = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
  let compilation, failed = false, failure;
  const attempt = work => {
    try { work(); }
    catch (error) { if (!failed) { failed = true;failure = error; } }
  };
  try {
    renderer.setRenderTarget(target);
    compilation = withSurfaceWarmupVariant(source,
      () => compilePrograms(renderer, source, compileCamera, lighting, { signal }));
  } catch (error) { failed = true;failure = error; }
  attempt(() => renderer.setRenderTarget(saved, face, mip));
  selected.clear();
  for (const light of copies) attempt(() => light.shadow?.dispose());
  attempt(() => lighting.clear());
  if (failed) {
    compilation?.catch(() => {});
    throw failure;
  }
  return compilation;
}
