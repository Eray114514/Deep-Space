// Tool-only admission. Observe textures when acquired, before any possible disposal.
// Three textures have no persistent disposed flag; late observation cannot prove life.
export function createCloudSplitResourceTracker() {
  const states = new Map();
  return {
    observe(texture, owner = texture) {
      if (!texture?.isTexture || !owner?.addEventListener) throw Error('Invalid resource owner');
      if (texture.isRenderTargetTexture && !owner.textures?.includes(texture)) throw Error('Render target owner required');
      if (states.has(texture)) {
        if (states.get(texture).owner !== owner) throw Error('Resource owner changed');
        return;
      }
      const state = { alive: true, listener: null, owner };
      state.listener = () => { state.alive = false; };
      texture.addEventListener('dispose', state.listener);
      if (owner !== texture) owner.addEventListener('dispose', state.listener);
      states.set(texture, state);
    },
    alive(texture) { return states.get(texture)?.alive === true; },
    dispose() {
      for (const [texture, state] of states) {
        texture.removeEventListener('dispose', state.listener);
        if (state.owner !== texture) state.owner.removeEventListener('dispose', state.listener);
      }
      states.clear();
    },
  };
}

const fields = ['uColumnsReady', 'uColumnsJointReady', 'uColumnMix',
  'uOpticalColumns', 'uOpticalColumnsNext', 'uColumnHeights', 'uColumnHeightsNext'];
export function admitCloudFarSplit(material, { tracker, minimumFootprint = 0, scratchBytes = Infinity, width, height }) {
  if (![width, height].every(value => Number.isSafeInteger(value) && value > 0)) throw Error('Invalid split dimensions');
  if (!(scratchBytes >= 0)) throw Error('Invalid scratch budget');
  const uniforms = material.uniforms;
  const snapshot = fields.map(name => [name, uniforms[name], uniforms[name]?.value]);
  const ready = uniforms.uColumnsReady?.value;
  if (!Number.isFinite(ready)) throw Error('Invalid column readiness');
  const resources = ready > .5 ? fields.slice(3).map(name => uniforms[name]?.value) : [];
  if (resources.some(texture => !tracker.alive(texture))) throw Error('Untracked or retired column resource');
  if (ready > .5 && (!Number.isFinite(uniforms.uColumnMix?.value)
    || uniforms.uColumnMix.value < 0 || uniforms.uColumnMix.value > 1)) throw Error('Invalid column interpolation');
  // A lower bound can prove cached-only, never point-only. Unknown bounds stay mixed.
  const route = ready <= .5 ? 'point' : Number.isFinite(minimumFootprint) && minimumFootprint > 2400 ? 'cached' : 'mixed';
  const bytes = route === 'mixed' ? width * height * 32 : 0;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > scratchBytes) throw Error('Split scratch budget unavailable');
  return {
    route, scratchBytes: bytes, draws: route === 'mixed' ? 3 : 1,
    validate() {
      if (material.uniforms !== uniforms || snapshot.some(([name, binding, value]) =>
        uniforms[name] !== binding || !Object.is(uniforms[name]?.value, value))
        || resources.some(texture => !tracker.alive(texture))) throw Error('Stale split admission');
    },
  };
}
