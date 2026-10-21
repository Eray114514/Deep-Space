import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FullScreenQuad } from '../vendor/jsm/postprocessing/Pass.js';
import { OwnedScreenTriangle } from '../src/owned-screen-triangle.js';
const material = new THREE.ShaderMaterial(), persistent = new FullScreenQuad(material), original = new FullScreenQuad(material);
let invalidations = 0, materialDisposals = 0;
persistent._mesh.geometry.addEventListener('dispose', () => invalidations++);
material.addEventListener('dispose', () => materialDisposals++);
original.dispose();assert.equal(invalidations, 1, 'Old temporary quad invalidates a live pass');
const a = new OwnedScreenTriangle(material), b = new OwnedScreenTriangle(material);
assert.notEqual(a._mesh.geometry, b._mesh.geometry);assert.notEqual(a._mesh.geometry, persistent._mesh.geometry);
for (const name of ['position', 'uv']) assert.deepEqual(a._mesh.geometry.getAttribute(name).array, persistent._mesh.geometry.getAttribute(name).array);
let disposed = 0;a._mesh.geometry.addEventListener('dispose', () => disposed++);a.dispose();
assert.equal(disposed, 1);assert.equal(invalidations, 1);assert.equal(materialDisposals, 0);
const next = new THREE.ShaderMaterial();a.material = next;
a.render({ render(mesh, camera) { assert.equal(mesh, a._mesh);assert.equal(mesh.material, next);
  assert.equal(camera.isOrthographicCamera, true);assert.equal(camera.near, 0);assert.equal(camera.far, 1); } });
// Like BufferGeometry/FullScreenQuad, geometry can be uploaded again after a
// context loss. dispose() must not turn the CPU triangle into a dead object.
assert.equal(a._mesh.geometry.getAttribute('position').count, 3);
a.dispose();b.dispose();persistent.dispose();material.dispose();next.dispose();
console.log('PASS: temporary screen triangles own geometry, preserve native vertices/UV/projection and material ownership, and remain reconstructible after GPU release.');
