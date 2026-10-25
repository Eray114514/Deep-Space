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

function compileSelection(renderer, { scene, compileCamera, target, selected, lights, signal }) {
  const source = new THREE.Group();
  source.traverse = work => { work(source);for (const object of selected) work(object); };
  source.traverseVisible = () => {};
  const lighting = new THREE.Scene();
  lighting.environment = scene.environment;lighting.fog = scene.fog;
  lighting.environmentIntensity = scene.environmentIntensity;
  lighting.environmentRotation.copy(scene.environmentRotation);
  const copies = [];
  const addLight = light => {

    const copy = light.clone(false);
    worldMatrix(light).decompose(copy.position, copy.quaternion, copy.scale);
    copy.visible = true;copy.layers.set(WORLD_LAYER);
    if (copy.target) {
      worldMatrix(light.target).decompose(copy.target.position, copy.target.quaternion, copy.target.scale);
      lighting.add(copy.target);
    }
    copies.push(copy);lighting.add(copy);
  };
  for (const light of lights) addLight(light);
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
  source.traverse = () => {};
  for (const light of copies) attempt(() => light.shadow?.dispose());
  attempt(() => lighting.clear());
  if (failed) {
    compilation?.catch(() => {});
    throw failure;
  }
  return compilation;
}

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

  const lights = new Set();
  visit(scene, omitted, object => {
    if (object.isLight && object !== shadowLight && object.layers.test(compileCamera.layers)) lights.add(object);
  }, true);
  if (shadows) lights.add(shadowLight);
  const collectLight = object => {
    if (object.isLight && object.layers.test(compileCamera.layers)) lights.add(object);
  };
  const futureRootLights = root => {
    if (!root) return;
    // Prepared ownership hides these roots until preview/adoption. Only that
    // root's visibility changes; locally hidden descendants remain hidden.
    collectLight(root);
    for (const child of root.children || []) visit(child, new Set(), collectLight, true);
  };
  for (const view of destination?.starViews || []) {
    lights.add(view.light);futureRootLights(view.group);
  }
  futureRootLights(body?.group);
  for (const site of destination?.artificialSites || []) {
    if (!site.parentBody) futureRootLights(site.group);
  }
  if (ship && !ship.separateInterior) visit(ship.group, new Set(), object => {
    if (object.isLight) lights.add(object);
  }, true);

  lights.delete(undefined);lights.delete(null);
  return compileSelection(renderer, { scene, compileCamera, target, selected, lights, signal });
}

function publicationSelection({ scene, universeRoot, ship, shadowLight, shadows = false, publication }) {
  const visibility = publication.visibility, layers = new THREE.Layers();layers.set(WORLD_LAYER);
  const selected = new Set(), lights = new Set();
  const collect = object => {
    if (renderable(object) && object.material && object.layers.test(layers)) selected.add(object);
  };
  const collectSubtree = root => {
    if (visibility.get(root) === false) return;
    collect(root);
    for (const child of root.children || []) collectSubtree(child);
  };
  // Persistent WORLD consumers retain future hidden/zero-instance families.
  visit(scene, new Set([universeRoot, ship?.group]), collect);
  if (universeRoot?.visible) for (const root of universeRoot.children) {
    if (visibility.get(root) ?? root.visible) collectSubtree(root);
  }
  visit(ship?.group, new Set(ship?.separateInterior ? [ship.int?.group] : []), object => {
    if (renderable(object) && object.material) selected.add(object);
  });
  const collectLights = root => {
    if (!(visibility.get(root) ?? root.visible)) return;
    if (root.isLight && root !== shadowLight && root.layers.test(layers)) lights.add(root);
    for (const child of root.children || []) collectLights(child);
  };
  collectLights(scene);
  if (shadows && shadowLight) lights.add(shadowLight);
  return { selected, lights };
}

const materialDependencies = new WeakMap();
const ignoredMaterialFields = new Set(['id', 'uuid', 'name', 'version', 'userData', 'uniforms', 'uniformsNeedUpdate']);

function dependencyValue(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    // Integer enums/counts remain exact; continuous uniform magnitudes need
    // only their zero/sign boundary. Custom shader structure belongs in the
    // material's declared customProgramCacheKey/defines.
    return Number.isInteger(value) ? value : value > 0 ? 'positive' : 'negative';
  }
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (value?.isTexture) return [value.constructor.name, value.mapping, value.type,
    value.format, value.internalFormat, value.colorSpace, value.channel];
  if (Array.isArray(value)) return ['array', value.length, value.map(item => item?.constructor?.name || typeof item)];
  if (value?.isColor || value?.isVector2 || value?.isVector3 || value?.isVector4) return value.constructor.name;
  return undefined;
}

function materialDependency(material) {
  const fields = Object.keys(material).filter(key => !ignoredMaterialFields.has(key) && key !== 'defines' && key !== 'extensions')
    .sort().map(key => [key, dependencyValue(material[key])]).filter(([, value]) => value !== undefined);
  const descriptor = JSON.stringify([fields, material.customProgramCacheKey(),
    Object.entries(material.defines || {}).sort(([a], [b]) => a.localeCompare(b)),
    Object.entries(material.extensions || {}).sort(([a], [b]) => a.localeCompare(b))]);
  const previous = materialDependencies.get(material);
  if (previous?.descriptor === descriptor) return previous.revision;
  const revision = (previous?.revision || 0) + 1;
  materialDependencies.set(material, { descriptor, revision });
  return revision;
}

function publicationRevision(renderer, config, { selected, lights }) {
  const materials = new Set(), shapes = new Set();
  for (const object of selected) {
    const attributes = Object.entries(object.geometry?.attributes || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => [name, value.itemSize, value.normalized, value.gpuType, value.array?.constructor.name]);
    const morphs = Object.entries(object.geometry?.morphAttributes || {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([name, values]) => [name, values.map(value => [value.itemSize, value.normalized])]);
    const shape = [object.type, attributes, morphs, object.geometry?.morphTargetsRelative,
      object.isInstancedMesh === true, Boolean(object.instanceColor), Boolean(object.morphTexture),
      object.isSkinnedMesh === true, object.isBatchedMesh === true];
    for (const material of [object.material].flat()) if (material) {
      materials.add(material);shapes.add(JSON.stringify([material.id, shape]));
    }
  }
  // This is a conservative dependency fingerprint, not a copy of Three's
  // program cache key. Uniform values and streamed vertex data may advance.
  const materialStates = [...materials].map(material => [material.id, materialDependency(material)]);
  const target = config.target;
  return JSON.stringify({
    lights: [...lights].filter(light => light !== config.shadowLight)
      .map(light => [light.id, light.type, light.castShadow, light.layers.mask]).sort(([a], [b]) => a - b),
    materials: materialStates.sort(([a], [b]) => a - b), shapes: [...shapes].sort(),
    roots: [...config.publication.visibility].map(([root, visible]) => [root.id, root.parent?.id ?? null, visible]),
    renderer: [renderer.shadowMap?.enabled, renderer.shadowMap?.type, renderer.toneMapping, renderer.outputColorSpace],
    target: target ? [Boolean(target.isWebGLCubeRenderTarget), target.samples,
      target.texture?.type, target.texture?.colorSpace, target.texture?.mapping,
      target.texture?.format, target.texture?.internalFormat] : null,
    environment: [config.scene.fog?.constructor.name, config.scene.environment?.mapping, config.scene.environment?.colorSpace],
    shadow: config.shadowLight ? [config.shadowLight.id, config.shadowLight.type, config.shadowLight.castShadow] : null,
  });
}

export function worldPublicationRevision(renderer, config) {
  return publicationRevision(renderer, config, publicationSelection(config));
}

// A batch may introduce lamps under an already visible planet. Every current
// WORLD consumer must see the future light family before that batch is exposed.
export function compileWorldPublicationVariant(renderer, config, { signal } = {}) {
  const selection = publicationSelection(config);
  const pending = compileSelection(renderer, { scene: config.scene,
    compileCamera: createCompileCamera(config.camera, WORLD_LAYER), target: config.target,
    ...selection, signal });
  const revision = publicationRevision(renderer, config, selection);
  return pending.then(() => revision);
}
