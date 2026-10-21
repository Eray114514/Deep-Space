import * as THREE from 'three';
import { actualRendererBackend, rendererAdapterLabel } from './renderer-policy.js';
import { installProgramRetirement } from './program-retirement.js';

// WebGL 2 is the only production backend (see docs/optimization-roadmap.md,
// 2026-08-15 decision). Keeping renderer creation in one place prevents
// gameplay code from accidentally touching backend state before it exists.
export async function createGameRenderer(policy, options = {}) {
  const renderer = new THREE.WebGLRenderer(options);
  renderer.programRetirement = installProgramRetirement(renderer);
  return describeRenderer(renderer, policy, null);
}

function describeRenderer(renderer, policy, adapterInfo) {
  const backend = actualRendererBackend(renderer);
  return {
    renderer,
    backend,
    adapterInfo,
    gpuName: rendererAdapterLabel(renderer, adapterInfo),
    reason: policy.reason,
  };
}

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
