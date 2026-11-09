import * as THREE from 'three';
import { cloudFarSplitShaders } from './cloud-far-split-shaders.js';
import { VOLUME_LAYER } from '../render-layers.js';

// Experimental single-owner path. Admission covers the ready and unready
// routes because the column bank can publish its pair inside volume.render.
export class CloudFarSplitPass {
  constructor(renderer) {
    this.renderer = renderer;
    this.source = null;
    this.scratch = null;
    this.plan = null;
    this.frames = 0;
    this.lastRoute = null;
    this.releaseSource = () => this.dispose();
  }

  soleOwner(scene, mesh) {
    let count = 0, found = false;
    scene.traverseVisible(object => {
      if (!object.layers.isEnabled(VOLUME_LAYER)) return;
      if (object.isMesh || object.isLine || object.isPoints || object.isSprite || object.isLOD) {
        count++;
        if (object === mesh && !Array.isArray(object.material)) found = true;
      }
    });
    const defaults = THREE.Object3D.prototype;
    return count === 1 && found && !scene.background && !scene.overrideMaterial
      && !mesh.isInstancedMesh && !mesh.isSkinnedMesh && !mesh.isBatchedMesh
      && mesh.onBeforeRender === defaults.onBeforeRender && mesh.onAfterRender === defaults.onAfterRender
      && scene.onBeforeRender === defaults.onBeforeRender && scene.onAfterRender === defaults.onAfterRender;
  }

  requests(scene, request, target) {
    this.plan = null;
    const { mesh, material, cacheVariants } = request;
    if (!material.visible || material.onBeforeRender !== THREE.Material.prototype.onBeforeRender
      || material.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile
      || !material.defines.CLOUD_FAR_VIEW || material.defines.PRODUCTION_CLOUD_MEDIUM !== 1
      || target.width * target.height * 32 > 64 * 1024 * 1024
      || !this.renderer.extensions.has('EXT_color_buffer_float') || !this.soleOwner(scene, mesh)) return null;
    const defines = { ...material.defines, CLOUD_FAR_CACHE: 0 };
    const signature = JSON.stringify(defines);
    if (this.source !== material || this.signature !== signature || this.fragmentShader !== material.fragmentShader) {
      this.dispose();
      const shaders = cloudFarSplitShaders(material.fragmentShader);
      this.source = material;
      this.signature = signature;
      this.fragmentShader = material.fragmentShader;
      this.materials = {};
      for (const stage of ['point', 'cached', 'pointDirect', 'cachedDirect', 'combine']) {
        const split = new THREE.ShaderMaterial().copy(Object.assign(Object.create(material), { uniforms: {} }));
        split.defines = { ...defines };
        split.fragmentShader = shaders[stage];
        // Three retains this dictionary when it prepares the program. Update
        // its entries in place as the frame replaces air/depth bindings.
        Object.assign(split.uniforms, material.uniforms);
        if (stage === 'combine') {
          split.uniforms.uSplitPoint = { value: null };
          split.uniforms.uSplitCached = { value: null };
        }
        if (stage === 'point' || stage === 'cached') split.blending = THREE.NoBlending;
        this.materials[stage] = split;
      }
      material.addEventListener('dispose', this.releaseSource);
    }
    const cachedOnly = cacheVariants.includes(1);
    const stages = cachedOnly ? ['pointDirect', 'cachedDirect'] : ['pointDirect', 'point', 'cached', 'combine'];
    this.plan = { mesh, material, cachedOnly, target, width: target.width, height: target.height };
    return stages.map(stage => ({ mesh, material: this.materials[stage], cacheVariants: [0] }));
  }

  render(scene, camera, current, bank) {
    const plan = this.plan;
    if (!plan) return false;
    const { mesh, material } = plan;
    const renderer = this.renderer;
    if (plan.target !== current || plan.width !== current.width || plan.height !== current.height
      || mesh.material !== material || !this.soleOwner(scene, mesh) || renderer.getContext().isContextLost()) {
      throw Error('Cloud split frame changed after preparation');
    }
    const uniforms = material.uniforms;
    const ready = uniforms.uColumnsReady.value > .5;
    const cachedOnly = material.defines.CLOUD_FAR_CACHE === 1;
    if (ready && (!bank || bank.disposed || cachedOnly !== plan.cachedOnly)) throw Error('Cloud split column route changed after preparation');
    const stages = !ready ? ['pointDirect'] : cachedOnly ? ['cachedDirect'] : ['point', 'cached', 'combine'];
    if (stages.length > 1 && !this.scratch) {
      const allocate = () => new THREE.WebGLRenderTarget(current.width, current.height, {
        type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false,
      });
      this.scratch = [allocate(), allocate()];
    }
    renderer.autoClear = false;
    try {
      for (const stage of stages) {
        const split = this.materials[stage];
        Object.assign(split.uniforms, uniforms);
        if (stage === 'combine') {
          split.uniforms.uSplitPoint.value = this.scratch[0].texture;
          split.uniforms.uSplitCached.value = this.scratch[1].texture;
        }
        split.uniformsNeedUpdate = true;
        mesh.material = split;
        const payload = stage === 'point' ? this.scratch[0] : stage === 'cached' ? this.scratch[1] : null;
        renderer.setRenderTarget(payload || current);
        if (payload) renderer.clear(true, false, false);
        renderer.render(scene, camera);
        if (this.plan !== plan || renderer.getContext().isContextLost()) throw Error('Cloud split frame retired during draw');
      }
    } finally {
      mesh.material = material;
    }
    this.frames++;
    this.lastRoute = stages.at(-1);
    return true;
  }

  releaseScratch() {
    this.plan = null;
    for (const target of this.scratch || []) target.dispose();
    this.scratch = null;
    if (this.materials) {
      const { uniforms } = this.materials.combine;
      uniforms.uSplitPoint.value = uniforms.uSplitCached.value = null;
    }
  }

  dispose() {
    this.releaseScratch();
    this.source?.removeEventListener('dispose', this.releaseSource);
    for (const material of Object.values(this.materials || {})) material.dispose();
    this.source = this.materials = null;
  }
}
