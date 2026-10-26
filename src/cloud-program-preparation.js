import * as THREE from 'three';
import { compilePrograms } from './program-preparation.js';
import { createCompileCamera } from './render-prewarm.js';
import { VOLUME_LAYER } from './render-layers.js';

const cacheDefine = 'CLOUD_FAR_CACHE';
const materialFields = ['type', 'glslVersion', 'precision', 'side', 'forceSinglePass', 'transparent',
  'premultipliedAlpha', 'vertexColors', 'fog', 'lights', 'clipping', 'clipIntersection', 'clipShadows',
  'alphaHash', 'alphaToCoverage', 'dithering', 'toneMapped', 'flatShading', 'wireframe',
  'blending', 'blendSrc', 'blendDst', 'blendEquation', 'blendSrcAlpha', 'blendDstAlpha', 'blendEquationAlpha'];
const failure = (code, message) => Object.assign(new Error(message), { code });
const diagnostic = error => ({ code: typeof error?.code === 'string' ? error.code : 'preparation-failed',
  message: String(error?.message ?? error) });
const attribute = value => [value.itemSize, value.normalized, value.gpuType, value.array?.constructor.name,
  Boolean(value.isInstancedBufferAttribute), value.meshPerAttribute];

// Read the live transform chain without updating camera rigs or scene flags.
function worldMatrix(object) {
  const chain = [];
  while (object && object.matrixWorldAutoUpdate !== false) { chain.push(object);object = object.parent; }
  const matrix = object ? object.matrixWorld.clone() : new THREE.Matrix4();
  for (const node of chain.reverse()) matrix.multiply(node.matrixAutoUpdate
    ? new THREE.Matrix4().compose(node.position, node.quaternion, node.scale) : node.matrix);
  return matrix;
}

// This manager submits only the caller's current volume closure. It never
// draws, clones uniform/texture/instance data, or queries ready programs again
// on the normal ensure() path. Native readiness lives inside the shared queue.
export class CloudProgramPreparation {
  constructor(renderer, { prepare, signal, maxIdleEntries = 32 } = {}) {
    if (typeof prepare !== 'function') throw new TypeError('Cloud preparation requires the pipeline preparation queue');
    if (!Number.isInteger(maxIdleEntries) || maxIdleEntries < 0) throw new RangeError('Invalid cloud preparation cache limit');
    this.renderer = renderer;this.prepare = prepare;this.signal = signal;this.maxIdleEntries = maxIdleEntries;
    this.entries = new Map();this.required = new Set();this.ids = new WeakMap();this.strings = new Map();this.nextId = 0;
    this.epoch = 0;this.clock = 0;this.submitted = 0;this.reused = 0;this.cancelled = 0;
    this.blocked = false;this.disposed = false;this.lost = false;this.inputFailure = null;
    this.controller = new AbortController();this.targetEpochs = new WeakMap();this.activeTarget = null;
    this.onAbort = () => this.dispose();this.onLost = () => { this.lost = true;this.reset('context-lost'); };
    this.onRestored = () => { this.lost = false;this.reset('context-restored'); };
    this.onTargetDispose = () => {
      const target = this.activeTarget;if (!target) return;
      this.targetEpochs.set(target, (this.targetEpochs.get(target) || 0) + 1);this.reset('target-disposed');
    };
    renderer.domElement?.addEventListener('webglcontextlost', this.onLost);
    renderer.domElement?.addEventListener('webglcontextrestored', this.onRestored);
    if (signal?.aborted) this.dispose();else signal?.addEventListener('abort', this.onAbort, { once: true });
  }

  id(value) { if (!value || !['object', 'function'].includes(typeof value)) return value ?? null;
    if (!this.ids.has(value)) this.ids.set(value, ++this.nextId);return this.ids.get(value); }
  text(value) { if (!this.strings.has(value)) this.strings.set(value, ++this.nextId);return this.strings.get(value); }

  lights(scene) {
    const lights = [], layer = new THREE.Layers();layer.set(VOLUME_LAYER);
    scene.traverseVisible(object => { if (object.isLight && object.layers.test(layer)) lights.push(object); });return lights;
  }

  key(config, request, variant) {
    const { material, mesh } = request, geometry = mesh.geometry, renderer = this.renderer, target = config.target;
    const defines = Object.fromEntries(Object.entries(material.defines || {}).filter(([name]) => name !== cacheDefine).sort(([a], [b]) => a.localeCompare(b)));
    // Standard custom keys may inspect this.defines. A read-only receiver view
    // normalizes CACHE without changing the live material or its version.
    const view = Object.create(material);Object.defineProperty(view, 'defines', { value: { ...defines, [cacheDefine]: 0 } });
    const custom = material.customProgramCacheKey.call(view);
    const textures = target?.textures || (target?.texture ? [target.texture] : []);
    return JSON.stringify({ material: this.id(material), shader: [this.text(material.vertexShader), this.text(material.fragmentShader)],
      hooks: [this.id(material.onBeforeCompile), this.id(material.customProgramCacheKey), this.text(String(custom))],
      fields: materialFields.map(name => [name, material[name]]), alphaTest: material.alphaTest > 0,
      defines, extensions: material.extensions, clipping: material.clippingPlanes?.length || 0,
      geometry: [Object.entries(geometry.attributes || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, attribute(value)]),
        Object.entries(geometry.morphAttributes || {}).sort(([a], [b]) => a.localeCompare(b)).map(([name, values]) => [name, values.map(attribute)]),
        geometry.morphTargetsRelative, Boolean(mesh.isInstancedMesh), Boolean(mesh.instanceColor), Boolean(mesh.morphTexture),
        Boolean(mesh.isSkinnedMesh), Boolean(mesh.isBatchedMesh)],
      camera: [config.camera.type, Boolean(config.camera.isOrthographicCamera), config.camera.coordinateSystem, config.camera.reversedDepth],
      renderer: [this.id(renderer.properties), renderer.capabilities?.logarithmicDepthBuffer, renderer.capabilities?.reversedDepthBuffer,
        renderer.capabilities?.precision, renderer.outputColorSpace, renderer.toneMapping, renderer.shadowMap?.enabled, renderer.shadowMap?.type],
      target: [this.id(target), this.targetEpochs.get(target) || 0, target.samples, Boolean(target.isWebGLCubeRenderTarget),
        textures.map(texture => [texture.type, texture.format, texture.internalFormat, texture.colorSpace, texture.mapping])],
      scene: [config.scene.fog?.constructor.name, Boolean(config.scene.environment), config.scene.environment?.mapping,
        config.scene.environment?.colorSpace, this.lights(config.scene).map(light => [this.id(light), light.type, light.castShadow, light.layers.mask])], variant });
  }

  valid(entry) {
    const registry = this.renderer.properties;
    if (entry.state !== 'ready' || registry !== entry.registry || !registry.has(entry.material) || registry.get(entry.material) !== entry.properties) return false;
    const present = new Set(entry.properties.programs?.values() || []);
    return entry.programs.length > 0 && entry.programs.every(({ program, handle }) => handle && program.program === handle && present.has(program));
  }

  remove(entry) {
    if (this.entries.get(entry.key) !== entry) return;
    if (entry.state === 'pending') { entry.state = 'cancelled';this.cancelled++; }
    entry.material.removeEventListener('dispose', entry.onDispose);this.entries.delete(entry.key);
  }

  cancelPending(reason) {
    this.controller.abort(reason);this.controller = new AbortController();
    for (const entry of [...this.entries.values()]) if (entry.state === 'pending') this.remove(entry);
  }

  reset(reason) {
    this.epoch++;this.cancelPending(reason);for (const entry of [...this.entries.values()]) this.remove(entry);
    this.required.clear();this.plan = null;this.blocked = !this.disposed;
  }

  compile(config, request, variant, signal) {
    const { renderer } = this, { mesh, material } = request;
    // The planner may request FarMat while the live sphere still owns NearMat.
    // This prototype view borrows every geometry/instance flag and attribute;
    // only its compiler-facing material differs from the live object.
    const compilerMesh = Object.create(mesh);Object.defineProperty(compilerMesh, 'material', { value: material });
    const source = new THREE.Group();source.traverse = work => { work(source);work(compilerMesh); };source.traverseVisible = () => {};
    const camera = createCompileCamera(config.camera, VOLUME_LAYER), scene = new THREE.Scene(), copies = [];
    scene.environment = config.scene.environment;scene.environmentIntensity = config.scene.environmentIntensity;
    scene.environmentRotation.copy(config.scene.environmentRotation);scene.fog = config.scene.fog;
    for (const light of this.lights(config.scene)) {
      const copy = light.clone(false);worldMatrix(light).decompose(copy.position, copy.quaternion, copy.scale);
      copy.visible = true;copy.layers.set(VOLUME_LAYER);
      if (copy.target) { worldMatrix(light.target).decompose(copy.target.position, copy.target.quaternion, copy.target.scale);scene.add(copy.target); }
      scene.add(copy);copies.push(copy);
    }
    const saved = renderer.getRenderTarget(), face = renderer.getActiveCubeFace(), mip = renderer.getActiveMipmapLevel();
    const original = material.defines, defines = original || {}, descriptor = Object.getOwnPropertyDescriptor(defines, cacheDefine), own = Object.hasOwn(material, 'defines');
    let pending, failed = false, error;
    const attempt = work => { try { work(); } catch (cause) { if (!failed) { failed = true;error = cause; } } };
    try {
      material.defines = defines;defines[cacheDefine] = variant;material.needsUpdate = true;renderer.setRenderTarget(config.target);
      pending = compilePrograms(renderer, source, camera, scene, { signal });
    } catch (cause) { failed = true;error = cause; }
    attempt(() => renderer.setRenderTarget(saved, face, mip));
    attempt(() => {
      // Preserve unrelated edits by a legitimate onBeforeCompile hook.
      if (material.defines !== defines) for (const name of Reflect.ownKeys(material.defines || {})) {
        if (name !== cacheDefine) Object.defineProperty(defines, name, Object.getOwnPropertyDescriptor(material.defines, name));
      }
      if (descriptor) Object.defineProperty(defines, cacheDefine, descriptor);else delete defines[cacheDefine];
      if (original || Reflect.ownKeys(defines).length) material.defines = defines;
      else if (own) material.defines = original;else delete material.defines;
      // compile() selected a temporary currentProgram. Force the next real
      // draw to select the restored live family; never roll version backwards.
      material.needsUpdate = true;
    });
    source.traverse = () => {};for (const light of copies) attempt(() => light.shadow?.dispose());attempt(() => scene.clear());
    if (failed) { pending?.catch(() => {});throw error; }
    try {
      const registry = renderer.properties, properties = registry.get(material);
      if (!properties) throw failure('registry-reset', 'Cloud program properties disappeared during submission');
      const programs = [...new Set(properties.programs?.values() || [])];
      if (properties.currentProgram && !programs.includes(properties.currentProgram)) programs.push(properties.currentProgram);
      const handles = programs.map(program => ({ program, handle: program.program }));
      return pending.then(() => ({ registry, properties, programs: handles }));
    } catch (cause) { pending.catch(() => {});throw cause; }
  }

  schedule(key, config, request, variant) {
    const epoch = this.epoch, signal = this.controller.signal;
    const entry = { key, material: request.material, variant, state: 'pending', used: ++this.clock, error: null };
    entry.onDispose = () => { this.remove(entry);this.plan = null;this.blocked = true; };
    entry.material.addEventListener('dispose', entry.onDispose);this.entries.set(key, entry);this.submitted++;
    const current = () => !this.disposed && !this.lost && !signal.aborted && epoch === this.epoch && this.required.has(key) && this.entries.get(key) === entry;
    let work;
    try { work = this.prepare(() => {
      if (!current()) throw failure('obsolete', 'Cloud preparation owner changed');
      if (this.key(config, request, variant) !== key) throw failure('source-changed', 'Cloud source changed before submission');
      return this.compile(config, request, variant, signal);
    }, { signal, label: `cloud-program:${request.material.id}:cache${variant}`, isCurrent: current }); }
    catch (error) { work = Promise.reject(error); }
    Promise.resolve(work).then(result => {
      if (!current()) return;
      if (this.key(config, request, variant) !== key) throw failure('source-changed', 'Cloud source changed during readiness');
      Object.assign(entry, result, { state: 'ready' });
      if (!this.valid(entry)) throw failure('program-invalid', 'Prepared cloud program registry or native handle changed');
    }).catch(error => {
      if (!current()) return;entry.state = 'failed';entry.error = diagnostic(error);this.blocked = true;
    });
  }

  ensure(config) {
    if (this.disposed) { this.blocked = true;return false; }
    try {
      if (!config || !Array.isArray(config.requests)) throw new TypeError('Cloud requests must be an array');
      // No native calls or renderer capabilities needed on ordinary no-cloud
      // frames (including lightweight CPU pipeline fixtures).
      if (!config.requests.length) {
        if (this.required.size) { this.epoch++;this.cancelPending('empty-plan');this.required.clear();this.plan = null; }
        const idle = [...this.entries.values()].sort((a, b) => b.used - a.used);
        for (const entry of idle.slice(this.maxIdleEntries)) this.remove(entry);
        this.inputFailure = null;this.blocked = this.lost;return !this.blocked;
      }
      if (!config.scene?.isScene || !config.camera?.isCamera || !config.target) throw new TypeError('Cloud preparation requires a scene, camera and HDR target');
      if (this.lost || this.renderer.getContext().isContextLost()) { if (!this.lost) this.onLost();this.blocked = true;return false; }
      const descriptions = new Map();
      for (const request of config.requests) {
        if (!request.mesh?.isMesh || !request.mesh.geometry || !request.material?.isShaderMaterial
          || !Array.isArray(request.cacheVariants) || !request.cacheVariants.length || request.cacheVariants.some(value => value !== 0 && value !== 1)) throw new TypeError('Invalid cloud mesh/material/cache variant request');
        for (const variant of new Set(request.cacheVariants)) descriptions.set(this.key(config, request, variant), { request, variant });
      }
      const plan = JSON.stringify([...descriptions.keys()].sort());
      if (plan !== this.plan) { this.epoch++;this.cancelPending('plan-changed');this.plan = plan;this.required = new Set(descriptions.keys()); }
      if (this.activeTarget !== config.target) {
        this.activeTarget?.removeEventListener?.('dispose', this.onTargetDispose);this.activeTarget = config.target;
        this.activeTarget.addEventListener?.('dispose', this.onTargetDispose);
      }
      this.inputFailure = null;
      for (const [key, { request, variant }] of descriptions) {
        let entry = this.entries.get(key);
        if (entry?.state === 'ready' && !this.valid(entry)) { this.remove(entry);entry = null; }
        if (!entry) this.schedule(key, config, request, variant);else { entry.used = ++this.clock;this.reused++; }
      }
      const idle = [...this.entries.values()].filter(entry => !this.required.has(entry.key)).sort((a, b) => b.used - a.used);
      for (const entry of idle.slice(this.maxIdleEntries)) this.remove(entry);
      this.blocked = [...this.required].some(key => !this.valid(this.entries.get(key) || {}));return !this.blocked;
    } catch (error) {
      this.epoch++;this.cancelPending('invalid-plan');this.required.clear();this.plan = null;
      this.inputFailure = diagnostic(error);this.blocked = true;return false;
    }
  }

  snapshot() {
    const entries = [...this.required].map(key => this.entries.get(key)).filter(Boolean), failures = entries.filter(entry => entry.state === 'failed').map(entry => ({ variant: entry.variant, ...entry.error }));
    if (this.inputFailure) failures.push(this.inputFailure);
    return { epoch: this.epoch, blocked: this.blocked, failed: failures.length > 0, failureCount: failures.length, failures,
      required: this.required.size, ready: entries.filter(entry => this.valid(entry)).length, pending: entries.filter(entry => entry.state === 'pending').length,
      cached: this.entries.size, submitted: this.submitted, reused: this.reused, cancelled: this.cancelled, disposed: this.disposed, contextLost: this.lost };
  }

  dispose() {
    if (this.disposed) return;this.disposed = true;this.reset('disposed');this.blocked = true;
    this.activeTarget?.removeEventListener?.('dispose', this.onTargetDispose);this.activeTarget = null;
    this.renderer.domElement?.removeEventListener('webglcontextlost', this.onLost);this.renderer.domElement?.removeEventListener('webglcontextrestored', this.onRestored);
    this.signal?.removeEventListener('abort', this.onAbort);this.strings.clear();
  }
}
