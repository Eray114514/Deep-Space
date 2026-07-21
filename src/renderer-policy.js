// The authored WebGLRenderer/EffectComposer stack remains the production
// baseline. WebGPU is opt-in until every visual pass reaches that baseline.

export const RENDER_PIPELINE_VERSION = 2;
// Keep the public policy honest: the node pipeline is functional, but the
// fixed-camera beauty suite has not yet demonstrated parity with the authored
// WebGL look. `auto` may still be requested explicitly by tests while this flag
// prevents diagnostics from presenting the migration as finished.
export const WEBGPU_PARITY_READY = false;

export function resolveRendererPolicy(params = new URLSearchParams(), gpu = globalThis.navigator?.gpu) {
  const value = params.get('renderer');
  const requested = value === 'webgl' ? 'webgl' : value === 'webgpu' ? 'webgpu' : 'auto';
  const webgpuAvailable = Boolean(gpu);
  const useWebGPU = webgpuAvailable
    && (requested === 'webgpu' || (requested === 'auto' && WEBGPU_PARITY_READY));
  return {
    requested,
    backend: useWebGPU ? 'webgpu' : 'webgl2',
    webgpuAvailable,
    parityReady: WEBGPU_PARITY_READY,
    reason: requested === 'webgl' ? 'player-forced-webgl2'
      : requested === 'webgpu' ? 'developer-forced-webgpu'
        : webgpuAvailable && !WEBGPU_PARITY_READY ? 'visual-parity-pending-fallback'
          : webgpuAvailable ? 'webgpu-preferred' : 'webgpu-unavailable-fallback',
  };
}

export function actualRendererBackend(renderer) {
  return renderer?.backend?.isWebGPUBackend ? 'webgpu' : 'webgl2';
}

export function rendererAdapterLabel(renderer, adapterInfo = null) {
  if (renderer?.backend?.isWebGPUBackend) {
    const fields = [adapterInfo?.vendor, adapterInfo?.architecture,
      adapterInfo?.device, adapterInfo?.description].filter(Boolean);
    return fields.join(' · ') || 'WebGPU high-performance adapter';
  }
  const gl = renderer?.getContext?.() || renderer?.backend?.getContext?.();
  const ext = gl?.getExtension?.('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'WebGL 2 adapter';
}

export async function probeAdapterInfo(gpu = globalThis.navigator?.gpu, powerPreference = 'high-performance') {
  if (!gpu) return null;
  try {
    const adapter = await gpu.requestAdapter({ powerPreference });
    if (!adapter) return null;
    const info = adapter.info || {};
    return {
      vendor: info.vendor || '', architecture: info.architecture || '',
      device: info.device || '', description: info.description || '',
    };
  } catch {
    return null;
  }
}
