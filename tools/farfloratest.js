import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FarFlora } from '../src/farflora.js';

// Real discovery, generation, streaming and cache paths on a controlled biome.
// Terrain/lighting quality and precision have separate focused gates.
const tileMeters = 1024;
const geometry = new THREE.BoxGeometry(1, 5, 1);
const planet = {
  R: 6000000, intSeed: 76123, fullMaxFreq: 128, hasLiquid: false,
  group: new THREE.Group(),
  // the tree field draws one geometry per detail level and species
  flora: { trees: { atlas: new THREE.Texture(), species: [0, 1].map((slot) => ({
    name: 'test' + slot,
    geometries: { near: geometry, mid: geometry, far: geometry, horizon: geometry },
  })) } },
  height: () => 13.125, biomeAt: () => 'forest',
};
const directions = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  [1, 1, 1], [-1, -1, -1], [-2963, 5053, 134], [1, -2, -3],
];
const flora = new FarFlora({ streamBudgetMs: 0 });
const cameraAt = (direction, radius = planet.R) => new THREE.Vector3(...direction)
  .normalize().multiplyScalar(radius + 800);
const usedMatrices = (tile, species) => tile.m[species].subarray(0, tile.n[species] * 16);
const treeCount = (tile) => tile.n[0] + tile.n[1];
let checkedTiles = 0;
let checkedTrees = 0;

try {
  for (const radius of [286000, 6000000, 20000000]) {
    planet.R = radius;
    for (const direction of directions) {
      flora.clear();
      flora.update(planet, cameraAt(direction), 800);
      assert.ok(flora.targetKeys.size > 80, 'Discovery must cover an actual local ring.');
      const coordinates = new Set();
      for (const key of flora.targetKeys) {
        const job = flora.createTileJob(planet, key);
        const cell = new THREE.Vector3(job.qx, job.qy, job.qz);
        assert.ok(Math.abs(cell.length() - radius / tileMeters) <= 0.710001,
          `Tile ${key} must decode onto the ${radius} m planet shell.`);
        assert.ok(cell.distanceTo(new THREE.Vector3(...flora.anchorK)) < 7,
          `Tile ${key} must remain in the discovered camera neighborhood.`);
        const identity = [job.qx, job.qy, job.qz].join(':');
        assert.ok(!coordinates.has(identity), 'Discovered tiles must have distinct coordinates.');
        coordinates.add(identity);
        checkedTiles++;
      }

      const key = flora.job?.key ?? flora.queue[0];
      const job = flora.createTileJob(planet, key);
      const tile = flora.buildTile(planet, key);
      assert.ok(treeCount(tile) > 20, 'Controlled forest must populate the nearest tile.');
      assert.ok(tile.n[1] > 0 && tile.n[0] > 0, 'Mixed woodland must plant both authored species.');
      const center = job.anchor.clone().multiplyScalar(radius + planet.height() - 0.25);
      for (const species of [0, 1]) {
        const matrices = usedMatrices(tile, species);
        for (let i = 0; i < matrices.length; i += 16) {
          const position = new THREE.Vector3(matrices[i + 12], matrices[i + 13], matrices[i + 14]).add(tile.origin);
          // repack() bounds a tile by TILE_M around its origin; the lattice scan
          // reaches every cell the tile owns, up to ~870 m from its centre
          assert.ok(position.distanceTo(center) < 960,
            'Generated trees must belong to this tile, including jitter near its edge.');
          assert.ok(Math.abs(position.length() - (radius + planet.height() - 0.25)) < 0.001,
            'Trees must stay on the terrain shell within a millimetre.');
          checkedTrees++;
        }
      }

      // Every scan slice can resume without changing seeded tree placement.
      const sliced = flora.createTileJob(planet, key);
      while (!flora.stepTileJob(planet, sliced, -Infinity)) {}
      const streamed = flora.finishTileJob(sliced);
      for (const species of [0, 1]) {
        assert.equal(streamed.n[species], tile.n[species]);
        assert.deepEqual(streamed.r[species].subarray(0, tile.n[species]), tile.r[species].subarray(0, tile.n[species]));
        assert.deepEqual(usedMatrices(streamed, species), usedMatrices(tile, species));
      }
    }
  }

  planet.R = 6000000;
  flora.clear();
  flora.streamBudgetMs = Infinity;
  const home = cameraAt([-2963, 5053, 134]);
  const tangent = new THREE.Vector3().crossVectors(home.clone().normalize(), new THREE.Vector3(0, 0, 1)).normalize();
  const snapshot = () => flora.meshes.map(mesh => new Float32Array(mesh.instanceMatrix.array.subarray(0, mesh.count * 16)));
  flora.update(planet, home, 800);
  const first = snapshot();
  assert.equal(flora.pending(), 0);
  assert.ok(flora.debugStats().instances > 1000, 'A complete real forest ring must be visible.');
  const counts = flora.meshes.map(mesh => mesh.count);
  const overhead = home.clone().normalize().multiplyScalar(planet.R + 8000);
  flora.update(planet, overhead, 8000);
  assert.equal(flora.debugStats().levels.horizon, 0);
  flora.update(planet, home, 800);
  assert.equal(flora.debugStats().levels.horizon, counts[0] + counts[1],
    'Vertical descent must refill the horizon tier even when the tile ring stays fixed.');
  flora.setDisplayDensity(0.48);
  const nearest = [...flora.tiles.values()].sort((a, b) =>
    a.origin.distanceToSquared(home) - b.origin.distanceToSquared(home))[0];
  const uploaded = new Set(flora.meshes[0].geometry.getAttribute('aRand').array.subarray(0, flora.meshes[0].count));
  const tail = nearest.r[0].subarray(Math.floor(nearest.n[0] * 0.75), nearest.n[0]);
  assert.ok(tail.filter(r => uploaded.has(r)).length > tail.length * 0.2,
    'Reduced density must still draw trees from the last quarter of a tile scan.');
  flora.setDisplayDensity(1);
  const initialKeys = [...flora.targetKeys];
  for (const distance of [1200, 7200, 14400, 21600]) {
    const camera = home.clone().addScaledVector(tangent, distance).normalize().multiplyScalar(planet.R + 800);
    flora.update(planet, camera, 800);
    flora.pruneCache();
    assert.equal(flora.pending(), 0, 'Crossing tiles must finish the new ring.');
    assert.ok(flora.tiles.size <= 384, 'Inactive tiles must remain evictable with the new keys.');
    assert.ok([...flora.targetKeys].every(key => flora.tiles.has(key)), 'Eviction must retain the current ring.');
  }
  assert.ok(initialKeys.some(key => !flora.tiles.has(key)), 'The revisit test must actually exercise eviction.');
  flora.update(planet, home, 800);
  assert.deepEqual(flora.meshes.map(mesh => mesh.count), counts);
  assert.deepEqual(snapshot(), first, 'Returning after eviction must recreate exactly the same forest.');

  const key = flora.targetKeys.values().next().value;
  const axisTile = flora.createTileJob(planet, '0:5859:0');
  const formerlyAliased = flora.createTileJob(planet, '0:4835:1');
  assert.deepEqual([axisTile.qx, axisTile.qy, axisTile.qz], [0, 5859, 0]);
  assert.deepEqual([formerlyAliased.qx, formerlyAliased.qy, formerlyAliased.qz], [0, 4835, 1]);
  planet.biomeAt = () => 'snow';
  const barren = flora.buildTile(planet, key);
  assert.equal(treeCount(barren), 0, 'A barren biome must not gain trees.');
  planet.biomeAt = () => 'forest';
  planet.hasLiquid = true;
  planet.seaLevel = 100;
  const submerged = flora.buildTile(planet, key);
  assert.equal(treeCount(submerged), 0, 'Submerged ground must not gain trees.');
  assert.ok(Object.values(flora.debugStats().levels).some((count) => count > 0), 'The level meshes must be populated.');
  console.log(`PASS: tree field ${checkedTiles} discovered tiles, ${checkedTrees} trees; signed directions, three radii, sliced generation, streaming, eviction and return.`);
} finally {
  flora.clear();
  geometry.dispose();
}
