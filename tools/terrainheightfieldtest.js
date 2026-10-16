import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Planet, TYPES } from '../src/planet.js';
import { TerrainHeightField } from '../src/terrain-height-field.js';
import { TerrainHeightOracle } from './terrain-height-oracle.js';
import { frequencyBlend, clamp } from '../src/noise.js';
import { makeRng } from '../src/rng.js';

const oldBlend = (f, maxFreq) => {
  if (!Number.isFinite(maxFreq)) return 1;
  const t = clamp(Math.log2(Math.max(maxFreq,1e-12)/Math.max(f,1e-12)),0,1);
  return t*t*(3-2*t);
};
const rng = makeRng('exact-height-snapshot-contract');
let blends = 0, heights = 0;
for (const f of [NaN, Infinity, -Infinity, 0, 1e-14, 1e-12, 1e-9, 1, 2.3, 1e8, 1e308]) {
  for (const cap of [NaN, Infinity, -Infinity, -1, 0, 1e-14, 1e-12,
    f*(1-Number.EPSILON), f, f*(1+Number.EPSILON), f*1.5, f*2*(1-Number.EPSILON), f*2, f*2*(1+Number.EPSILON)]) {
    assert.equal(frequencyBlend(f,cap),oldBlend(f,cap)); blends++;
  }
}
for (let i=0;i<20000;i++) {
  const f=2**(rng()*80-40),cap=f*2**(rng()*6-3);
  assert.equal(frequencyBlend(f,cap),oldBlend(f,cap)); blends++;
}
for (const type of Object.keys(TYPES)) {
  const planet = new Planet({ seed: `height-snapshot:${type}`, name: type, type,
    posUniv: new THREE.Vector3(), radius: 6000000,
    tuning: { oceanProfile: type==='ocean'?'pelagic-storm':undefined },
    formation: { tectonicActivity:.7, volcanicActivity:.6, impactRate:.8, erosion:.4, waterInventory:.5 } });
  const snapshot = planet.createTerrainSnapshot();
  const field = TerrainHeightField.fromSnapshot(structuredClone(snapshot));
  const oracle = Object.assign(Object.create(planet), { craters: TerrainHeightOracle.prototype.craters });
  for (let i=0;i<1800;i++) {
    const dir = new THREE.Vector3(rng()*2-1,rng()*2-1,rng()*2-1).normalize();
    const cap = [planet.fullMaxFreq,1e9,0,5,50,300][i%6];
    const expected = TerrainHeightOracle.prototype.height.call(oracle,dir,cap);
    assert.equal(planet.height(dir,cap),expected,`${type} live height`);
    assert.equal(field.height(dir,cap),expected,`${type} snapshot height`);
    heights++;
  }
  const probe = new THREE.Vector3(1,2,-3).normalize(), before=field.height(probe);
  snapshot.parameters.contAmp*=5; snapshot.noise.nA.perm.fill(0); planet.contAmp*=7;
  assert.equal(field.height(probe),before,'Snapshot restore must own its parameters/permutations');
  assert.equal(field._craterField.slots.length,2);
}
assert.throws(()=>TerrainHeightField.fromSnapshot({version:2}),/Unsupported/);
console.log(`PASS: exact terrain snapshot/oracle (${heights} heights, all 8 planet types and 6 cutoffs; ${blends} blend cases), independent ownership and bounded crater cache.`);
