import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FarFlora } from '../src/farflora.js';
import { farFloraPrecisionFixture } from './far-flora-precision-fixture.js';

const directions = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 1], [-1, -1, -1], [-2963, 5053, 134], [1, -2, -3],
];
let treeCount = 0;
let tileError = 0;
let ringError = 0;
const position = new THREE.Vector3();
const scenarios = ['flat', 'relief'].flatMap(terrainProfile => [286000, 6000000, 20000000]
  .map(radius => ({ terrainProfile, radius })));

for (const { radius, terrainProfile } of scenarios) {
  const fixture = farFloraPrecisionFixture(radius, terrainProfile);
  const { planet, expected } = fixture;
  const flora = new FarFlora({ streamBudgetMs: 0 });
  try {
    for (const direction of directions) {
      flora.clear();
      const camera = new THREE.Vector3(...direction).normalize();
      camera.multiplyScalar(radius + planet.height(camera, planet.fullMaxFreq) + 400);
      flora.update(planet, camera, 400);
      const key = flora.job?.key ?? flora.queue[0];
      fixture.reset();
      const tile = flora.buildTile(planet, key);
      for (const species of [0, 1]) {
        assert.equal(tile[`n${species}`], expected[species].length, 'Terrain queries must describe every drawn tree.');
        const matrices = tile[`m${species}`];
        for (let i = 0; i < expected[species].length; i++) {
          position.fromArray(matrices, i * 16 + 12).add(tile.origin || new THREE.Vector3());
          const error = position.distanceTo(expected[species][i]);
          tileError = Math.max(tileError, error);
          assert.ok(error < 0.0001, `Cached tree must retain sub-0.1 mm placement, got ${error} m at R=${radius}.`);
          treeCount++;
        }
      }
      flora.tiles.set(key, tile);
      flora.repack();
      for (const species of [0, 1]) {
        const mesh = flora.meshes[species];
        assert.equal(mesh.count, expected[species].length);
        for (let i = 0; i < mesh.count; i++) {
          position.fromArray(mesh.instanceMatrix.array, i * 16 + 12).add(mesh.position);
          const error = position.distanceTo(expected[species][i]);
          ringError = Math.max(ringError, error);
          assert.ok(error < 0.001, `Drawn tree must retain sub-mm placement, got ${error} m.`);
        }
      }
      assert.ok(flora.uCamL.value.distanceTo(camera.clone().sub(flora.meshes[0].position)) < 1e-9,
        'Fade camera and rendered matrices must use the same origin.');

      // A second real tile forces offset translation and a new render origin.
      // Both rings fit below CAP, so rebasing cannot hide a content change.
      const originalAnchor = [...flora.anchorK];
      const distantKey = [...flora.targetKeys].sort((a, b) => {
        const distance = value => new THREE.Vector3(...value.split(':').map(Number))
          .distanceToSquared(new THREE.Vector3(...originalAnchor));
        return distance(b) - distance(a);
      })[0];
      const reference = [new Map(), new Map()];
      const record = (value) => {
        for (const species of [0, 1]) {
          for (let i = 0; i < value[`n${species}`]; i++) {
            const identity = value[`m${species}`].subarray(i * 16, i * 16 + 12).join(':');
            if (!reference[species].has(identity)) reference[species].set(identity, []);
            reference[species].get(identity).push(expected[species][i].clone());
          }
        }
      };
      record(tile);
      fixture.reset();
      const distantTile = flora.buildTile(planet, distantKey);
      record(distantTile);
      flora.tiles.set(distantKey, distantTile);
      const cached = [new Float32Array(tile.m0), new Float32Array(tile.m1)];
      let first;
      for (const anchor of [originalAnchor, distantKey.split(':').map(Number), originalAnchor]) {
        flora.anchorK = anchor;
        flora.repack();
        for (const species of [0, 1]) {
          const mesh = flora.meshes[species];
          assert.equal(mesh.count, [...reference[species].values()].reduce((count, points) => count + points.length, 0));
          const unmatched = new Map([...reference[species]].map(([identity, points]) => [identity, [...points]]));
          for (let i = 0; i < mesh.count; i++) {
            const identity = mesh.instanceMatrix.array.subarray(i * 16, i * 16 + 12).join(':');
            position.fromArray(mesh.instanceMatrix.array, i * 16 + 12).add(mesh.position);
            const candidates = unmatched.get(identity);
            assert.ok(candidates?.length, 'A rebase must retain the same seeded trees, scales and rotations.');
            candidates.sort((a, b) => position.distanceToSquared(a) - position.distanceToSquared(b));
            const canonical = candidates.shift();
            const error = position.distanceTo(canonical);
            ringError = Math.max(ringError, error);
            assert.ok(error < 0.001, `Rebased tree must retain sub-mm placement, got ${error} m.`);
          }
          if (anchor === originalAnchor && first) {
            assert.deepEqual(mesh.instanceMatrix.array.subarray(0, mesh.count * 16), first[species]);
          }
        }
        if (!first) first = flora.meshes.map(mesh => new Float32Array(mesh.instanceMatrix.array.subarray(0, mesh.count * 16)));
        assert.ok(flora.uCamL.value.distanceTo(camera.clone().sub(flora.origin)) < 1e-9);
      }
      assert.deepEqual(tile.m0, cached[0], 'Repacking must never mutate cached tile-local matrices.');
      assert.deepEqual(tile.m1, cached[1]);
    }
  } finally {
    flora.clear();
    fixture.geometry.dispose();
  }
}
console.log(`PASS: ${treeCount} far trees across 60 poses, flat/relief terrain and rebasing; cached error ${(tileError * 1000).toFixed(4)} mm, draw error ${(ringError * 1000).toFixed(4)} mm.`);
