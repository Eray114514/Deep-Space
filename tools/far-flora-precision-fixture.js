import * as THREE from 'three';
import { hash3i, hashFloat } from '../src/rng.js';

// Record the double-precision terrain queries that actually plant a tree.
// Expected positions never pass through an instance buffer or render origin.
export function farFloraPrecisionFixture(radius = 6000000, terrainProfile = 'flat') {
  const geometry = new THREE.BoxGeometry(1, 5, 1);
  geometry.setAttribute('color', new THREE.BufferAttribute(
    new Float32Array(geometry.attributes.position.count * 3).fill(1), 3));
  const expected = [[], []];
  const cell = new THREE.Vector3();
  let pending = false;
  const heightAt = direction => 13.125 + (terrainProfile === 'relief'
    ? 17000 * (direction.x * 0.31 + direction.y * 0.47 + direction.z * 0.19) : 0);
  const planet = {
    R: radius, intSeed: 76123, fullMaxFreq: 128, hasLiquid: false,
    group: new THREE.Group(), flora: { far0: geometry, far1: geometry },
    biomeAt: () => 'forest',
    height(direction, frequency) {
      const height = heightAt(direction);
      if (frequency === 96) {
        cell.copy(direction);
        pending = true;
      } else if (frequency === 128 && pending) {
        const Q = this.R / 32;
        const hash = hash3i(Math.round(cell.x * Q), Math.round(cell.y * Q),
          Math.round(cell.z * Q), this.intSeed ^ 0xfa12);
        expected[hashFloat(hash, 3) < 0.72 ? 0 : 1]
          .push(direction.clone().multiplyScalar(this.R + height - 0.4));
        pending = false;
      }
      return height;
    },
  };
  return { planet, geometry, expected,
    reset() { expected.forEach(points => { points.length = 0; }); pending = false; },
  };
}
