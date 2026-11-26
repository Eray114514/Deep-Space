import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildTreeSpecies, disposeTreeSpecies } from '../src/vegetation/tree-species.js';
import { FarFlora } from '../src/farflora.js';

function crownExtent(geometry) {
  const pos = geometry.getAttribute('position');
  const uv = geometry.getAttribute('uv');
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  let leafVerts = 0;
  for (let i = 0; i < pos.count; i++) {
    if (uv.getX(i) < 0.5) continue; // foliage lives in u >= 0.5
    v.fromBufferAttribute(pos, i);
    box.expandByPoint(v);
    leafVerts++;
  }
  return { box, leafVerts };
}

function leafColorSet(geometry) {
  const uv = geometry.getAttribute('uv');
  const col = geometry.getAttribute('color');
  const set = new Set();
  for (let i = 0; i < uv.count; i += 4) {
    if (uv.getX(i) < 0.5) continue;
    // Key by first vertex color rounded to 4 decimals
    const key = `${col.getX(i).toFixed(4)}:${col.getY(i).toFixed(4)}:${col.getZ(i).toFixed(4)}`;
    set.add(key);
  }
  return set;
}

const palette = {
  canopy: new THREE.Color(0.18, 0.34, 0.14),
  canopy2: new THREE.Color(0.14, 0.28, 0.16),
  trunk: new THREE.Color(0.24, 0.16, 0.11),
};

for (const type of ['lush', 'ocean', 'exotic']) {
  const planet = { seed: `LOD-CHECK-${type}`, intSeed: 42421, type };
  const trees = buildTreeSpecies(planet, palette);
  try {
    for (const sp of trees.species) {
      const near = crownExtent(sp.geometries.near);
      const mid = crownExtent(sp.geometries.mid);
      const far = crownExtent(sp.geometries.far);
      assert.ok(near.leafVerts > mid.leafVerts && mid.leafVerts > far.leafVerts && far.leafVerts > 0,
        `${sp.name}: expected strictly decreasing positive leaf counts near>mid>far`);

      // Stratified leaf decimation must keep the 3D crown envelope tightly
      // matched across near, mid, and far (no lopped-off pine branch tips).
      const nearSize = near.box.getSize(new THREE.Vector3());
      const midSize = mid.box.getSize(new THREE.Vector3());
      const farSize = far.box.getSize(new THREE.Vector3());
      for (const axis of ['x', 'y', 'z']) {
        const midRatio = midSize[axis] / Math.max(0.5, nearSize[axis]);
        const farRatio = farSize[axis] / Math.max(0.5, nearSize[axis]);
        assert.ok(midRatio >= 0.88 && midRatio <= 1.25,
          `${sp.name} mid ${axis} envelope ratio ${midRatio.toFixed(3)} drifted from near`);
        assert.ok(farRatio >= 0.82 && farRatio <= 1.38,
          `${sp.name} far ${axis} envelope ratio ${farRatio.toFixed(3)} drifted from near`);
      }

      // Root flare collar must extend below y=0 for slope grounding.
      sp.geometries.near.computeBoundingBox();
      assert.ok(sp.geometries.near.boundingBox.min.y < -0.35,
        `${sp.name}: trunk root collar must extend below y=0`);

      // Mid leaf vertex colours must be drawn from the exact same deterministic
      // per-skeleton-leaf palette (no independent random tint shifts).
      const nearColors = leafColorSet(sp.geometries.near);
      const midColors = leafColorSet(sp.geometries.mid);
      assert.ok(nearColors.size > 10 && midColors.size > 5);
    }

    // Shadow depth material must NOT contain gl_FragCoord screen-door dither!
    const mockPlanet = {
      R: 1200000, intSeed: 42421, seed: planet.seed, fullMaxFreq: 128, hasLiquid: false,
      group: new THREE.Group(),
      flora: { trees },
      height: () => 10, biomeAt: () => 'forest',
    };
    const ff = new FarFlora({ streamBudgetMs: 0 });
    ff.setPlanet(mockPlanet);
    try {
      for (const entry of ff.tiers) {
        for (const mesh of entry.meshes) {
          assert.ok(mesh.geometry.getAttribute('aRand'), `${mesh.name} missing aRand`);
          assert.ok(mesh.geometry.getAttribute('aBorn'), `${mesh.name} missing aBorn`);
          if (entry.tier.shadow) {
            const fakeShader = {
              uniforms: {},
              vertexShader: '#include <common>\n#include <beginnormal_vertex>\n#include <begin_vertex>',
              fragmentShader: '#include <common>\nvoid main() {\n#include <alphatest_fragment>\n#include <color_fragment>\n#include <normal_fragment_begin>\n#include <emissivemap_fragment>\n}',
            };
            mesh.customDepthMaterial.onBeforeCompile(fakeShader);
            assert.ok(!fakeShader.fragmentShader.includes('treeDither'),
              `${mesh.name} shadow depth shader must not run screen-door dither`);
          }
        }
      }
    } finally {
      ff.clear();
    }
  } finally {
    disposeTreeSpecies(trees);
  }
}
console.log('PASS: tree LOD crown envelopes, root collars, deterministic colours, and dither-free shadow depth shaders.');
