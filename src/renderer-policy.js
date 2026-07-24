// WebGL 2 is the sole render backend.
// WebGPU migration was attempted and retired; the last WebGPU code is
// preserved at git commit b746772 for reference if migration is reconsidered.

export const RENDER_PIPELINE_VERSION = 1;
export const WEBGPU_PARITY_READY = false;

// resolveRendererPolicy keeps its original signature so callers throughout the
// codebase do not need to change, but the result is now hard-wired to WebGL 2.
export function resolveRendererPolicy(params = new URLSearchParams()) {
  return {
    requested: 'webgl',
    backend: 'webgl2',
    useNodeMaterials: false,
    webgpuAvailable: false,
    parityReady: false,
    reason: 'webgl2-only',
  };
}

export function actualRendererBackend() {
  return 'webgl2';
}

export function rendererAdapterLabel(renderer) {
  const gl = renderer?.getContext?.() || renderer?.backend?.getContext?.();
  const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'WebGL 2 adapter';
}

// No longer used — kept as a no-op stub so legacy imports do not break.
export async function probeAdapterInfo() {
  return null;
}
