import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Scatter } from '../src/scatter.js';
import { VegetationFrame } from '../src/vegetation-frame.js';
import { SurfaceInteractionField } from '../src/surface-interaction.js';
import { vegetationPrecisionFixture } from './vegetation-precision-fixture.js';

let roots = 0, maxError = 0, maxPhaseError = 0;
const directions = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1],
  [1,1,1],[-1,-1,-1],[-2963,5053,134],[1,-2,-3]];
const snapshot = scatter => Object.fromEntries(Object.entries(scatter.meshes).map(([kind, mesh]) => [kind,
  { count: mesh.count, origin: mesh.position.toArray(),
    matrix: new Float32Array(mesh.instanceMatrix.array.subarray(0, mesh.count * 16)),
    color: new Float32Array(mesh.instanceColor.array.subarray(0, mesh.count * 3)) }]));
const finish = scatter => { assert.ok(scatter.stepJob(Infinity)); scatter.commitJob(scatter.job); scatter.job = null; };

for (const profile of ['flat', 'relief']) for (const radius of [286000, 6000000, 20000000]) {
  const fixture = vegetationPrecisionFixture(radius, profile), p = fixture.planet;
  const scatter = new Scatter({ streamBudgetMs: 0, grassRadius: 36, grassDensity: 0.35 });
  try {
    scatter.setPlanet(p);
    for (const direction of directions) {
      const anchor = new THREE.Vector3(...direction).normalize().multiplyScalar(radius / 9).round();
      fixture.reset();
      scatter.beginJob(p, anchor.x, anchor.y, anchor.z, radius / 9, 9 / radius);
      finish(scatter);
      const first = snapshot(scatter), origin = scatter.frame.origin.clone();
      const expected = new Map();
      // One-metre bins identify independent recorded planting points, never
      // positions reconstructed from the matrices under test.
      for (const point of fixture.expected) {
        const local = point.clone().sub(origin), key = local.clone().floor().toArray().join(':');
        if (!expected.has(key)) expected.set(key, []);
        expected.get(key).push(local);
      }
      let grassCount = 0;
      for (const [kind, mesh] of Object.entries(scatter.meshes)) {
        assert.deepEqual(mesh.position.toArray(), origin.toArray());
        assert.ok(mesh.customDepthMaterial && mesh.customDistanceMaterial, 'Both native shadow paths must deform with the instance.');
        assert.equal(mesh.geometry.hasAttribute('iAnchor'), false, 'Unused planet-scale anchor buffers must not be allocated.');
        for (let i = 0; i < mesh.count; i++) {
          const local = new THREE.Vector3().fromArray(mesh.instanceMatrix.array, i * 16 + 12);
          if (!kind.startsWith('grass')) {
            const world = local.clone().add(origin), up = world.clone().normalize();
            assert.ok(Math.abs(world.length() - (radius + fixture.heightAt(up))) < 0.0001);
            continue;
          }
          grassCount++;
          const cell = local.clone().floor();
          let error = Infinity;
          for (let z = -1; z <= 1; z++) for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) {
            for (const point of expected.get(`${cell.x+x}:${cell.y+y}:${cell.z+z}`) || []) {
              error = Math.min(error, local.distanceTo(point));
            }
          }
          maxError = Math.max(maxError, error); roots++;
          assert.ok(error < 0.0001, `Grass root lost precision at R=${radius}: ${error} m.`);
        }
      }
      assert.equal(grassCount, fixture.expected.length, 'All independently recorded grass roots are submitted.');

      // Partial replacement must retain the complete ring, origin and phase.
      const phase = scatter.frame.uniforms.uWindPhase.value.toArray();
      scatter.beginJob(p, anchor.x + 2, anchor.y, anchor.z + 1, radius / 9, 9 / radius);
      assert.equal(scatter.stepJob(-Infinity), false);
      assert.deepEqual(snapshot(scatter), first);
      assert.deepEqual(scatter.frame.uniforms.uWindPhase.value.toArray(), phase);
      finish(scatter);
      scatter.beginJob(p, anchor.x, anchor.y, anchor.z, radius / 9, 9 / radius);
      finish(scatter);
      assert.deepEqual(snapshot(scatter), first, 'Return must restore seeded transforms, colours and origin exactly.');
    }
  } finally { scatter.clear(); fixture.geometry.dispose(); }
}

// Interaction injection remains canonical; shader-facing centres are local,
// including after an origin change and a different planet's pressure field.
const field = new SurfaceInteractionField(), frame = new VegetationFrame(field);
field.setPlanet('p');
const canonical = new THREE.Vector3(6000000.12345, -177731.34567, 835123.87654);
field.inject(canonical, 1.65, 0.9, 1.25);
field.update(0.4);
const before = field.positions.map(value => value.clone());
for (const origin of [canonical.clone().addScalar(40), canonical.clone().addScalar(-75), canonical.clone().addScalar(40)]) {
  frame.setOrigin(origin); frame.syncInteractions('p');
  assert.ok(new THREE.Vector3().fromArray(frame.uniforms.uBendPos.value[0].toArray()).add(origin).distanceTo(canonical) < 1e-9);
  assert.equal(frame.uniforms.uBendPos.value[0].w, 1.65);
  assert.deepEqual(field.positions, before, 'Rebasing must not mutate canonical interactions.');
  const local = canonical.clone().sub(origin);
  const localPhase = local.x * 0.61 + local.y * 0.53 + local.z * 0.47;
  const canonicalPhase = canonical.x * 0.61 + canonical.y * 0.53 + canonical.z * 0.47;
  const offsets = [...frame.uniforms.uWindPhase.value.toArray(), frame.uniforms.uWindFlutterPhase.value];
  for (const [i, frequency] of [1, 1.67, 0.73, 0.11, 2.31].entries()) {
    const error = Math.abs(Math.sin(localPhase * frequency + offsets[i]) - Math.sin(canonicalPhase * frequency));
    maxPhaseError = Math.max(maxPhaseError, error);
    assert.ok(error < 2e-9, 'All five wind frequencies must survive origin changes.');
  }
}
frame.syncInteractions('other');
assert.ok(frame.uniforms.uBendPos.value.every(value => value.x === 1e9));
field.inject(canonical.clone().addScalar(0.125), 2);
frame.syncInteractions('p');
assert.equal(frame.uniforms.uBendPos.value[1].w, 2, 'An injection after streaming must refresh before either shadow or visible draw.');
console.log(`PASS: ${roots} near-grass roots, 60 poses, flat/relief, atomic ring replacement and return; max root error ${(maxError*1000).toFixed(4)} mm, phase error ${maxPhaseError}.`);
