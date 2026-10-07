// Cooperative builds must preserve content across deadlines and cancellation.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Scatter } from '../src/scatter.js';
import { vegetationPrecisionFixture } from './vegetation-precision-fixture.js';

const snapshot = s => Object.fromEntries(Object.entries(s.meshes).map(([kind, mesh]) => [kind,
  { count: mesh.count, origin: mesh.position.toArray(),
    matrix: mesh.instanceMatrix.array.slice(0,mesh.count*16),
    color: mesh.instanceColor.array.slice(0,mesh.count*3) }]));
const start = (s,p,d) => {
  const a = new THREE.Vector3(...d).normalize().multiplyScalar(p.R/9).round();
  s.beginJob(p,a.x,a.y,a.z,p.R/9,9/p.R);
};
const finish = (s,deadline=Infinity) => {
  let calls = 0;
  while (!s.stepJob(deadline)) assert.ok(++calls < 100000,'Build stopped making progress');
  s.commitJob(s.job);s.job=null;
  return calls;
};
let slicedCalls = 0;
for (const biome of ['grass','forest','rock']) {
  const fixture = vegetationPrecisionFixture(6000000,'relief'),p=fixture.planet;
  p.biomeAt = () => biome;
  const a = new Scatter({grassRadius:36,grassDensity:.35});
  const b = new Scatter({grassRadius:36,grassDensity:.35});
  try {
    a.setPlanet(p);b.setPlanet(p);
    start(a,p,[1,-2,-3]);finish(a);const expected = snapshot(a);
    // Interleave a second field using the module's shared scratch vectors.
    // Every candidate and every rejected/empty cell must eventually finish.
    start(a,p,[1,-2,-3]);start(b,p,[-1,2,3]);
    while (!a.stepJob(-Infinity)) {b.stepJob(-Infinity);slicedCalls++;}
    a.commitJob(a.job);a.job=null;
    assert.deepEqual(snapshot(a),expected,'Slicing/interleaving rewrote seeded content');
    start(a,p,[1,-2,-3]);a.stepJob(-Infinity);
    // Changing destination midway drops the unfinished cell's iterator.
    start(a,p,[-1,2,3]);finish(a,-Infinity);const away = snapshot(a);
    start(a,p,[-1,2,3]);finish(a);
    assert.deepEqual(snapshot(a),away,'Cancelled candidates leaked into the replacement');
    start(a,p,[1,-2,-3]);finish(a,-Infinity);
    assert.deepEqual(snapshot(a),expected,'Returning must restore the complete original ring');

    if (biome === 'grass') {
      const originalClock = globalThis.performance;
      let clock = 0,maximumQueries = 0;
      const height = p.height;p.height = (...args) => {clock++;return height(...args);};
      try {
        globalThis.performance = {now:()=>clock};
        start(a,p,[1,-2,-3]);
        let done = false;
        while (!done) {
          const before = clock;done=a.stepJob(clock+2);
          maximumQueries=Math.max(maximumQueries,clock-before);
        }
        // Eight yielded units plus at most one cell-height preflight. The old
        // implementation queried hundreds of roots before any clock check.
        assert.ok(maximumQueries<=10,`Atomic work burst was ${maximumQueries} terrain queries`);
        a.commitJob(a.job);a.job=null;
        assert.deepEqual(snapshot(a),expected);
      } finally {globalThis.performance=originalClock;p.height=height;}
    }
  } finally {a.clear();b.clear();fixture.geometry.dispose();}
}
console.log(`PASS: near vegetation bounded inner work, ${slicedCalls} slices, interleaved fields, cancellation, empty biome and exact seeded return.`);
