// Serialized with the supplied passive installer. Capture the first WebGL2
// context before Three creates its first program, without additional GL calls.
export function installFoundationBootProbe(install) {
  const prototype = HTMLCanvasElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'getContext');
  const original = prototype.getContext;
  const state = { acquired: false, installed: false, restored: false, error: null };
  window.__foundationBootProbe = state;
  const restore = () => {
    if (prototype.getContext !== wrapper) return;
    if (descriptor) Object.defineProperty(prototype, 'getContext', descriptor);
    else delete prototype.getContext;
    state.restored = true;
  };
  function wrapper(...args) {
    const context = original.apply(this, args);
    if (args[0] !== 'webgl2' || !context || state.acquired) return context;
    state.acquired = true;state.acquiredAtMs = performance.now();
    try { install(context);state.installed = true; }
    catch (error) { state.error = String(error); }
    finally { restore(); }
    return context;
  }
  Object.defineProperty(prototype, 'getContext', descriptor ? { ...descriptor, value: wrapper }
    : { configurable: true, writable: true, value: wrapper });
}
