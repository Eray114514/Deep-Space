import {cloudLightPageShaders} from '../src/cloud/cloud-light-query-glsl.js';

// Reconstruct F3l's cached/partial-light preparation on the same renderer,
// layout, inputs and optimized metadata, for controlled cost comparisons.
export function previousCloudPreparation(shaders,source) {
  const from='bool cached=false;';
  if(!shaders.compose.includes(from))throw Error('Previous preparation composition boundary changed');
  return {prepare:cloudLightPageShaders(source).prepare,compose:shaders.compose.replace(from,
    'bool cached=cloudCachedLight(local,path,pathDepth);')};
}

export async function installPreviousPreparationReference() {
  const {CloudLightBatchRenderer}=await import('/src/cloud/cloud-light-batch-renderer.js');
  const configure=CloudLightBatchRenderer.prototype.configure;
  CloudLightBatchRenderer.prototype.configure=function(material,options) {
    this.legacyRadiance=true;
    this.page.tPageCached??={value:null};this.page.tPageMask??={value:null};
    return configure.call(this,material,options);
  };
  const create=CloudLightBatchRenderer.prototype.createPrograms;
  CloudLightBatchRenderer.prototype.createPrograms=function(material) {
    create.call(this,material);
    const shaders=previousCloudPreparation({compose:this.compose.fragmentShader},material.fragmentShader);
    this.prepare.fragmentShader=shaders.prepare;this.compose.fragmentShader=shaders.compose;
  };
}
