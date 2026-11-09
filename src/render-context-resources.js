// Three rebuilds its GPU registries on restoration. A surviving geometry or
// texture can still hold a dispose listener from an older registry. Its
// handles were already retired by the browser and cannot be deleted again.
export function installRenderContextResources(renderer) {
  const gl = renderer.getContext(), canvas = renderer.domElement;
  const restore = [];
  let epoch = 0;
  const onRestored = () => { epoch++; };
  // Advance before Three allocates the new registry's default resources.
  canvas.addEventListener('webglcontextrestored', onRestored, true);

  function wrap(name, handler) {
    const descriptor = Object.getOwnPropertyDescriptor(gl, name), native = gl[name];
    const wrapper = function (...args) { return handler(this, native, args); };
    Object.defineProperty(gl, name, { configurable:true, writable:true, enumerable:descriptor?.enumerable ?? false, value:wrapper });
    restore.push(() => {
      if (gl[name] !== wrapper) return;
      if (descriptor) Object.defineProperty(gl, name, descriptor);
      else delete gl[name];
    });
  }

  for (const kind of ['Buffer','VertexArray','Texture','Framebuffer','Renderbuffer']) {
    const ownerEpoch = new WeakMap();
    wrap('create'+kind, (receiver,native,args) => {
      const handle = native.apply(receiver,args);
      if (receiver === gl && handle) ownerEpoch.set(handle,epoch);
      return handle;
    });
    wrap('delete'+kind, (receiver,native,args) => {
      const owner = ownerEpoch.get(args[0]);
      if (receiver === gl && owner !== undefined && owner < epoch) return;
      return native.apply(receiver,args);
    });
  }

  const dispose = renderer.dispose;
  renderer.dispose = function (...args) {
    try { return dispose.apply(this,args); }
    finally {
      canvas.removeEventListener('webglcontextrestored',onRestored,true);
      for (const undo of restore) undo();
    }
  };
}
