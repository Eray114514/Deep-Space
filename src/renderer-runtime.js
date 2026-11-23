import * as THREE from 'three';
import { actualRendererBackend, rendererAdapterLabel } from './renderer-policy.js';
import { installProgramRetirement } from './program-retirement.js';
import { installRenderContextResources } from './render-context-resources.js';

// WebGL 2 is the only production backend (see docs/optimization-roadmap.md,
// 2026-08-15 decision). Keeping renderer creation in one place prevents
// gameplay code from accidentally touching backend state before it exists.
export function classifyWebGLCreationError(statusMessage = '', error = null) {
  const text = `${statusMessage || ''} ${error?.message || ''}`;
  if (/context loss.*blocked|was blocked|domain.*blocked/i.test(text)) {
    return 'webgl-domain-blocked';
  }
  if (/disabled|not supported|unsupported|blocklist|blacklist/i.test(text)) {
    return 'webgl-disabled';
  }
  return 'webgl-unavailable';
}

function tryCreateWebGLRenderer(options) {
  const ownsCanvas = !options.canvas && typeof document !== 'undefined';
  const canvas = options.canvas || (ownsCanvas ? document.createElement('canvas') : undefined);
  let statusMessage = '';
  const onCreationError = (event) => {
    if (event?.statusMessage) statusMessage = String(event.statusMessage);
  };
  canvas?.addEventListener?.('webglcontextcreationerror', onCreationError, false);
  try {
    const renderer = new THREE.WebGLRenderer(canvas ? { ...options, canvas } : options);
    return { renderer, statusMessage };
  } catch (error) {
    error.statusMessage = statusMessage;
    throw error;
  } finally {
    canvas?.removeEventListener?.('webglcontextcreationerror', onCreationError, false);
  }
}

export async function createGameRenderer(policy, options = {}) {
  let renderer = null;
  let fallbackUsed = false;
  let lastError = null;
  let lastStatus = '';

  const attempts = [options];
  if (options.antialias || options.preserveDrawingBuffer || options.powerPreference === 'high-performance') {
    attempts.push({
      ...options,
      canvas: undefined,
      antialias: false,
      preserveDrawingBuffer: false,
      powerPreference: 'default',
    });
  }

  for (let i = 0; i < attempts.length; i++) {
    try {
      const result = tryCreateWebGLRenderer(attempts[i]);
      renderer = result.renderer;
      fallbackUsed = i > 0;
      break;
    } catch (error) {
      lastError = error;
      lastStatus = error.statusMessage || lastStatus;
      // When Chromium blocks the domain after a prior context loss, retrying
      // with downgraded attributes cannot succeed and only duplicates console noise.
      if (classifyWebGLCreationError(lastStatus, error) === 'webgl-domain-blocked') break;
    }
  }

  if (!renderer) {
    const code = classifyWebGLCreationError(lastStatus, lastError);
    const wrapped = new Error(lastError?.message || 'Error creating WebGL context.');
    wrapped.code = code;
    wrapped.statusMessage = lastStatus;
    wrapped.cause = lastError;
    throw wrapped;
  }

  installRenderContextResources(renderer);
  renderer.programRetirement = installProgramRetirement(renderer);
  return describeRenderer(renderer, policy, null, { fallbackUsed });
}

function describeRenderer(renderer, policy, adapterInfo, extra = {}) {
  const backend = actualRendererBackend(renderer);
  return {
    renderer,
    backend,
    adapterInfo,
    gpuName: rendererAdapterLabel(renderer, adapterInfo),
    reason: extra.fallbackUsed ? `${policy.reason} (safe-fallback)` : policy.reason,
    fallbackUsed: !!extra.fallbackUsed,
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
