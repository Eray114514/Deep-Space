import * as THREE from 'three';
import { rendererAdapterLabel } from './renderer-policy.js';

// WebGL 2 is the sole render backend. This factory always returns a
// THREE.WebGLRenderer; WebGPU/NodeMaterial paths have been retired.
export async function createGameRenderer(policy, options = {}) {
  const renderer = new THREE.WebGLRenderer(options);
  return describeRenderer(renderer, policy);
}

function describeRenderer(renderer, policy, reasonOverride = null) {
  return {
    renderer,
    backend: 'webgl2',
    adapterInfo: null,
    gpuName: rendererAdapterLabel(renderer),
    reason: reasonOverride || policy.reason || 'webgl2',
  };
}

// WebGL context-loss recovery. The WebGPU device-lost reload path was retired
// with the WebGPU backend; only the WebGL 2 context loss handlers remain.
export function installDeviceRecovery(renderer, onState) {
  let disposed = false;
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

  return () => {
    disposed = true;
    canvas.removeEventListener('webglcontextlost', glLost, false);
    canvas.removeEventListener('webglcontextrestored', glRestored, false);
  };
}
