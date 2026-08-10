// Hardware readback for the phase-4 CPU/GPU medium contract. This is a real
// WebGPU fragment pass over the same uploaded textures and TSL graph used by
// the production marcher; no fp32 CPU emulation is involved.

import {
  DataTexture, FloatType, NearestFilter, NodeMaterial, NoColorSpace, QuadMesh,
  RenderTarget, RendererUtils, RGBAFormat,
} from 'three/webgpu';
import {
  Fn, screenUV, texture, texture3D, uniform,
} from 'three/tsl';
import { cloudDensityTSL } from './cloud-density.js';

let rendererState;

export async function runCloudDensityGpuProbe(renderer, resource, points) {
  if (!renderer?.isWebGPURenderer && renderer?.backend?.isWebGPUBackend !== true) {
    throw new Error('runCloudDensityGpuProbe() requires the WebGPU renderer');
  }
  if (!resource?.textures || !resource?.fields || !resource?.occupancy) {
    throw new TypeError('runCloudDensityGpuProbe() needs a ready cloud resource');
  }
  if (!Array.isArray(points) || points.length === 0) {
    throw new TypeError('runCloudDensityGpuProbe() needs at least one point');
  }

  const data = new Float32Array(points.length * 4);
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    data[index * 4] = point.x ?? point[0];
    data[index * 4 + 1] = point.y ?? point[1];
    data[index * 4 + 2] = point.z ?? point[2];
    data[index * 4 + 3] = 1;
  }
  const pointTexture = new DataTexture(data, points.length, 1, RGBAFormat, FloatType);
  pointTexture.minFilter = NearestFilter;
  pointTexture.magFilter = NearestFilter;
  pointTexture.generateMipmaps = false;
  pointTexture.colorSpace = NoColorSpace;
  pointTexture.needsUpdate = true;

  const position = texture(pointTexture).sample(screenUV).xyz;
  const medium = Fn(() => cloudDensityTSL(position, {
    shapeTextureNode: texture3D(resource.textures.shape),
    detailTextureNode: texture3D(resource.textures.detail),
    jitterTextureNode: texture(resource.textures.jitter),
    bandsTextureNode: texture(resource.textures.bands),
    groundR: uniform(resource.fields.groundR),
    shellTopMeters: uniform(resource.fields.shellTopMeters),
    maxTerrainMeters: uniform(resource.fields.maxTerrainMeters),
  }))();
  const material = new NodeMaterial();
  material.name = 'Cloud CPU GPU consistency probe';
  material.fragmentNode = medium;
  material.toneMapped = false;
  const quad = new QuadMesh(material);
  const target = new RenderTarget(points.length, 1, {
    type: FloatType,
    format: RGBAFormat,
    depthBuffer: false,
  });
  target.texture.minFilter = NearestFilter;
  target.texture.magFilter = NearestFilter;
  target.texture.generateMipmaps = false;
  target.texture.colorSpace = NoColorSpace;

  rendererState = RendererUtils.resetRendererState(renderer, rendererState);
  try {
    renderer.setRenderTarget(target);
    renderer.setMRT(null);
    renderer.setClearColor(0, 0);
    quad.render(renderer);
    const pixels = await renderer.readRenderTargetPixelsAsync(
      target, 0, 0, points.length, 1);
    const results = [];
    for (let index = 0; index < points.length; index++) {
      results.push({
        density: pixels[index * 4],
        extinctionPerMeter: pixels[index * 4 + 1],
        lowCondensate: pixels[index * 4 + 2],
        upperCondensate: pixels[index * 4 + 3],
      });
    }
    return results;
  } finally {
    RendererUtils.restoreRendererState(renderer, rendererState);
    target.dispose();
    material.dispose();
    pointTexture.dispose();
  }
}
