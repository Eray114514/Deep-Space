// Verify: does coarse-LOD terrain sink below the liquid shell because the
// ridged-mountain fractal has a positive mean that vanishes with its octaves?

import * as THREE from 'three';
import { Planet } from '../src/planet.js';

const dir = new THREE.Vector3();
for (const type of ['lava', 'lush', 'ocean', 'toxic', 'ice']) {
  const p = new Planet({ seed: 'EUCLID:p:0,0,0:2', name: 'X', posUniv: new THREE.Vector3(), type });
  const rnd = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(7);
  const levels = [0, 1, 2, 4, p.maxLevel];
  const out = [];
  for (const lvl of levels) {
    const f = p.freqAtLevel(lvl);
    let mean = 0, below = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      dir.set(rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1);
      if (dir.lengthSq() < 0.01 || dir.lengthSq() > 1) { i--; continue; }
      dir.normalize();
      const h = p.height(dir, f);
      mean += h;
      if (p.hasLiquid && h < p.seaLevel) below++;
    }
    out.push(`L${lvl}: mean=${(mean / N).toFixed(1)}m flooded=${(below / N * 100).toFixed(0)}%`);
  }
  console.log(`${type.padEnd(6)} sea=${p.hasLiquid ? p.seaLevel.toFixed(1) : '—'}  ${out.join('  ')}`);
  p.dispose();
}
