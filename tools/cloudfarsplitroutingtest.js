import assert from 'node:assert/strict';
import { Texture, WebGLRenderTarget } from '../vendor/three.module.js';
import { admitCloudFarSplit, createCloudSplitResourceTracker } from './cloud-far-split-routing.js';
const tracker = createCloudSplitResourceTracker();
const uniforms = Object.fromEntries(['uColumnsReady','uColumnsJointReady','uColumnMix',
  'uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext'].map(name => [name,{value:0}]));
const material = {uniforms};
const options = {tracker,width:32,height:24,scratchBytes:24576};
const admit = extra => admitCloudFarSplit(material,{...options,...extra});
for (const dimensions of [{width:-1,height:-1},{width:0},{height:NaN},{width:.5}]) assert.throws(() => admit(dimensions),/dimensions/);
assert.throws(() => admit({scratchBytes:NaN}),/budget/);
assert.equal(admit().route,'point');
uniforms.uColumnsReady.value = 1;
assert.throws(admit,/resource/);
for (const name of ['uOpticalColumns','uOpticalColumnsNext','uColumnHeights','uColumnHeightsNext']) {
  const texture = new Texture();tracker.observe(texture);uniforms[name].value = texture;
}
for (const minimumFootprint of [0,900,2400,NaN,Infinity]) assert.equal(admit({minimumFootprint}).route,'mixed');
assert.equal(admit({minimumFootprint:2400.01}).route,'cached');
assert.throws(() => admit({scratchBytes:24575}),/budget/);
assert.equal(admit({minimumFootprint:2500,scratchBytes:0}).scratchBytes,0);
for (const name of Object.keys(uniforms)) {
  const plan = admit(), old = uniforms[name];uniforms[name] = {...old};
  assert.throws(() => plan.validate(),/Stale/);uniforms[name] = old;
}
for (const name of ['uColumnsReady','uColumnsJointReady','uColumnMix']) {
  const plan = admit(), old = uniforms[name].value;uniforms[name].value = .7;
  assert.throws(() => plan.validate(),/Stale/);uniforms[name].value = old;
}
const plan = admit();uniforms.uOpticalColumns.value.dispose();
assert.throws(() => plan.validate(),/Stale/);assert.throws(admit,/resource/);
uniforms.uColumnsReady.value = 0;
assert.equal(admit({scratchBytes:0}).route,'point');
tracker.dispose();
for (const operation of ['dispose','resize']) {
  const target = new WebGLRenderTarget(2,2);
  assert.throws(() => tracker.observe(target.texture),/owner/);
  tracker.observe(target.texture,target);
  assert.equal(tracker.alive(target.texture),true);
  if (operation === 'resize') target.setSize(4,4); else target.dispose();
  assert.equal(tracker.alive(target.texture),false);
  tracker.observe(target.texture,target);
  assert.equal(tracker.alive(target.texture),false,'Retirement cannot be undone by re-observing');
  tracker.dispose();
}
console.log('PASS split admission: missing/retired resources, bindings, readiness, mix, strict footprint and budget');
