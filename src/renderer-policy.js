// WebGPU is the preferred production path on capable browsers. WebGL 2 stays
// available as a complete compatibility backend and recovery target.

export const RENDER_PIPELINE_VERSION = 2;
// WebGPU is now the default for `auto`. WebGL 2 remains as fallback when WebGPU
// is unavailable, fails to initialize, or is explicitly requested via ?renderer=webgl.
export const WEBGPU_PARITY_READY = true;

export function resolveRendererPolicy(params = new URLSearchParams(), gpu = globalThis.navigator?.gpu) {
  const value = params.get('renderer');
  const requested = value === 'webgl' ? 'webgl'
    : value === 'webgpu' ? 'webgpu'
    : value === 'tsl-webgl' ? 'tsl-webgl'
    : 'auto';
  const webgpuAvailable = Boolean(gpu);
  const useWebGPU = webgpuAvailable
    && (requested === 'webgpu' || (requested === 'auto' && WEBGPU_PARITY_READY));
  // tsl-webgl: TSL/NodeMaterial shaders compiled to GLSL and run on WebGL 2 via
  // WebGPURenderer({forceWebGL:true}). Used to compare TSL vs hand-written GLSL
  // shader equivalence without the WebGPU backend as a variable.
  const useNodeMaterials = useWebGPU || requested === 'tsl-webgl';
  return {
    requested,
    backend: useWebGPU ? 'webgpu' : 'webgl2',
    useNodeMaterials,
    webgpuAvailable,
    parityReady: WEBGPU_PARITY_READY,
    reason: requested === 'webgl' ? 'player-forced-webgl2'
      : requested === 'webgpu' ? 'developer-forced-webgpu'
        : requested === 'tsl-webgl' ? 'developer-forced-tsl-webgl'
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
