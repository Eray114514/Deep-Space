import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ChunkedLOD, setTerrainScreenError } from '../src/quadtree.js';

setTerrainScreenError(0.72);
const planet = { R: 6000000, hAmp: 1, gridCells: 4, maxLevel: 5, noSkirt: true,
  height: () => 0, freqAtLevel: () => 1, terrainMaterial: new THREE.MeshBasicMaterial(), group: new THREE.Group() };
const lod = new ChunkedLOD(planet);
lod._levelCap = 5; lod._forceLevel = 0; lod._frame = 20; lod._dt = 0.016;
// Isolate ownership from visibility: a requested peer ancestor lies beyond
// its own distance/prefetch thresholds but must retain the requested branch.
lod.camLocal.set(1e9, 0, 0);
lod.beyondHorizon = () => false;
const source = lod.findNode(0, 3, 0, 0, true);
const addresses = lod.boundaryEdges(source).map((edge) => lod.neighbourAddress(source, edge));
lod.synchronizeFaceBoundarySplit(source);
for (const address of addresses) {
  const peer = lod.findNode(address.face, 3, address.ix, address.iy, false);
  assert.ok(peer);
  for (let node = peer; node; node = node.parent) assert.ok(node.forceSplitUntil >= lod._frame,
    `Forced descendant ownership must reach ancestor L${node.level}`);
  lod.process(lod.roots[address.face]);
  assert.equal(lod.findNode(address.face, 3, address.ix, address.iy, false), peer,
    'Distance cleanup cannot destroy a freshly requested peer branch.');
}
lod._frame = 100;
for (const address of addresses) {
  lod.process(lod.roots[address.face]);
  assert.equal(lod.roots[address.face].children, null, 'Expired unneeded forced branches remain reclaimable.');
}
lod._levelCap = 2;
assert.equal(lod.findNode(5, 4, 0, 0, true), null, 'Peer creation never exceeds the active LOD cap.');
const visit = (node) => { assert.ok(node.level <= 2); for (const child of node.children || []) visit(child); };
visit(lod.roots[5]);
lod.dispose(); planet.terrainMaterial.dispose();
const hiddenPlanet = { ...planet, group: new THREE.Group(), terrainMaterial: new THREE.MeshBasicMaterial() };
const hiddenLod = new ChunkedLOD(hiddenPlanet);
hiddenLod._levelCap = 5;
const visibleSource = hiddenLod.findNode(0, 3, 0, 0, true);
hiddenLod.beyondHorizon = (node) => node.face !== 0;
let hiddenCreates = 0;
const create = hiddenLod.createChildren;
hiddenLod.createChildren = function (node) {
  if (node.face !== 0) hiddenCreates++;
  return create.call(this, node);
};
for (let frame = 0; frame < 120; frame++) {
  hiddenLod._frame = frame;
  hiddenLod.synchronizeFaceBoundarySplit(visibleSource);
}
assert.equal(hiddenCreates, 0, 'Occluded cross-face peers must not create then discard queued ancestry.');
for (let face = 1; face < 6; face++) assert.equal(hiddenLod.roots[face].children, null);
hiddenLod.dispose(); hiddenPlanet.terrainMaterial.dispose();
console.log('PASS: cross-face ancestor ownership, expiry reclamation, and level cap');
