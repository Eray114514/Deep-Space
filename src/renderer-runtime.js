import * as THREE from 'three';
import * as THREE_WEBGPU from 'three/webgpu';
import { actualRendererBackend, probeAdapterInfo, rendererAdapterLabel } from './renderer-policy.js';

const WEBGPU_PROBE_TIMEOUT_MS = 4500;
const RENDERER_INIT_TIMEOUT_MS = 12000;

function withTimeout(promise, timeoutMs, label) {
  let timer = 0;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

// WebGPURenderer initialization is asynchronous even when its WebGL 2 backend
// is forced. Keeping creation in one place prevents gameplay code from
// accidentally touching backend state before it exists.
export async function createGameRenderer(policy, options = {}) {
  let effectivePolicy = policy;
  let adapterInfo = null;
  if (policy.backend === 'webgpu') {
    try {
      adapterInfo = await withTimeout(probeAdapterInfo(undefined, options.powerPreference),
        WEBGPU_PROBE_TIMEOUT_MS, 'WebGPU adapter probe');
    } catch (error) {
      console.warn('WebGPU adapter probe did not complete; using WebGL 2.', error);
    }
    if (!adapterInfo) {
      effectivePolicy = { ...policy, backend: 'webgl2', reason: 'webgpu-adapter-unavailable-fallback' };
    }
  }
  // When auto resolves to WebGPU (the default), the page already loaded
  // NodeMaterial facades before renderer init. If the adapter is unavailable,
  // keep those materials on WebGPURenderer's WebGL backend; switching to
  // classic WebGLRenderer would feed NodeMaterial objects to an incompatible
  // renderer and fail shader compilation.
  if (effectivePolicy.backend === 'webgl2' && policy.backend === 'webgpu') {
    const renderer = new THREE_WEBGPU.WebGPURenderer({ ...options, forceWebGL: true });
    await withTimeout(renderer.init(), RENDERER_INIT_TIMEOUT_MS, 'WebGPU experiment fallback initialization');
    return describeRenderer(renderer, effectivePolicy, null, 'webgpu-adapter-unavailable-node-fallback');
  }

  if (effectivePolicy.backend === 'webgl2') {
    const renderer = new THREE.WebGLRenderer(options);
    return describeRenderer(renderer, effectivePolicy, null);
  }

  const renderer = new THREE_WEBGPU.WebGPURenderer({
    ...options,
    forceWebGL: false,
  });

  try {
    await withTimeout(renderer.init(), RENDERER_INIT_TIMEOUT_MS, 'renderer initialization');
  } catch (error) {
    // `auto` can reach a browser that exposes navigator.gpu but cannot create
    // a device (driver reset, missing DXIL, policy restriction). Retry through
    // the node renderer's WebGL backend without changing the public canvas.
    console.warn('WebGPU initialization failed; retrying with WebGL 2.', error);
    renderer.dispose();
    // The page already loaded the NodeMaterial facade before renderer init.
    // Stay in that material family and run it on WebGPURenderer's WebGL 2
    // backend; swapping to classic WebGLRenderer would feed NodeMaterials to
    // an incompatible renderer after an automatic WebGPU failure.
    const fallback = new THREE_WEBGPU.WebGPURenderer({ ...options, forceWebGL: true });
    await withTimeout(fallback.init(), RENDERER_INIT_TIMEOUT_MS, 'Node WebGL fallback initialization');
    return describeRenderer(fallback, policy, null, 'webgpu-init-failed-fallback');
  }

  return describeRenderer(renderer, effectivePolicy,
    actualRendererBackend(renderer) === 'webgpu' ? adapterInfo : null);
}

function describeRenderer(renderer, policy, adapterInfo, reasonOverride = null) {
  const backend = actualRendererBackend(renderer);
  return {
    renderer,
    backend,
    adapterInfo,
    gpuName: rendererAdapterLabel(renderer, adapterInfo),
    reason: reasonOverride || (backend === policy.backend
      ? policy.reason
      : 'webgpu-device-unavailable-fallback'),
  };
}

export function installDeviceRecovery(renderer, onState) {
  let disposed = false;
  let stableTimer = 0;
  const canvas = renderer.domElement;

  const mark = (state, detail = null) => {
    if (!disposed) onState?.(state, detail);
  };

  const glLost = (event) => {
    event.preventDefault();
    mark('lost', 'webgl-context-lost');
  };
  const glRestored = () => mark('restored', 'webgl-context-restored');
  canvas.addEventListener('webglcontextlost', glLost, false);
  canvas.addEventListener('webglcontextrestored', glRestored, false);

  const device = renderer.backend?.device;
  if (device?.lost) {
    stableTimer = setTimeout(() => sessionStorage.removeItem('nms-webgpu-recovery'), 30000);
    device.lost.then((info) => {
      if (disposed || info?.reason === 'destroyed') return;
      mark('lost', info?.message || info?.reason || 'webgpu-device-lost');
      // A fresh page reconstructs all procedural GPU resources from stable
      // IDs. Guard the reload so a persistently broken driver yields one
      // fallback attempt instead of a reload loop.
      const key = 'nms-webgpu-recovery';
      if (sessionStorage.getItem(key) !== '1') {
        sessionStorage.setItem(key, '1');
        // Reload with ?renderer=webgl so the device-lost fallback does not
        // loop back into WebGPU on the same broken adapter.
        setTimeout(() => {
          const recoveryUrl = new URL(location.href);
          recoveryUrl.searchParams.set('renderer', 'webgl');
          recoveryUrl.searchParams.set('renderer-recovery', 'device-lost');
          location.replace(recoveryUrl);
        }, 350);
      }
    });
  } else {
    sessionStorage.removeItem('nms-webgpu-recovery');
  }

  return () => {
    disposed = true;
    clearTimeout(stableTimer);
    canvas.removeEventListener('webglcontextlost', glLost, false);
    canvas.removeEventListener('webglcontextrestored', glRestored, false);
  };
}
