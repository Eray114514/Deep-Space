// WebGL 2 is the production baseline: the authored GLSL chain is the visual
// reference. The WebGPU/TSL line has been removed from the tree (2026-08-15);
// its last state lives in git history for reference.

export const RENDER_PIPELINE_VERSION = 2;

export function resolveRendererPolicy(params = new URLSearchParams(), gpu = globalThis.navigator?.gpu) {
  const value = params.get('renderer');
  const requested = value === 'webgl' ? 'webgl' : value === 'webgpu' ? 'webgpu' : 'auto';
  // 'webgpu' is accepted but no longer routes anywhere: the TSL pipeline was
  // shelved and then deleted. Redirect to the WebGL 2 baseline with an
  // explicit reason so stale links/flags degrade gracefully.
  return {
    requested,
    backend: 'webgl2',
    webgpuAvailable: Boolean(gpu),
    parityReady: false,
    reason: requested === 'webgl' ? 'player-forced-webgl2'
      : requested === 'webgpu' ? 'webgpu-shelved-webgl2'
        : 'webgl2-baseline',
  };
}

export function actualRendererBackend() {
  return 'webgl2';
}

export function rendererAdapterLabel(renderer) {
  const gl = renderer?.getContext?.();
  if (!gl) return 'WebGL 2 adapter';
  const ext = gl.getExtension?.('WEBGL_debug_renderer_info');
  const rawRenderer = (ext && gl.getParameter?.(ext.UNMASKED_RENDERER_WEBGL))
    || gl.getParameter?.(gl.RENDERER)
    || '';
  const label = String(rawRenderer).trim();
  if (!label) return 'WebGL 2 adapter';
  if (/Intel|AMD|NVIDIA|ATI|Apple|SwiftShader|llvmpipe|softpipe|lavapipe|Microsoft/i.test(label)) {
    return label;
  }
  const vendor = String((ext && gl.getParameter?.(ext.UNMASKED_VENDOR_WEBGL))
    || gl.getParameter?.(gl.VENDOR) || '').trim();
  return vendor && /Intel|AMD|NVIDIA|ATI/i.test(vendor) ? `${vendor} ${label}` : label;
}
