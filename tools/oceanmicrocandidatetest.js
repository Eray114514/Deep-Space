import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createOceanMicroCandidate, oceanMicroCandidatePhases,
  sampleOceanMicroCandidate, oceanMicroCandidateGLSL, microWaveFilter } from './ocean-micro-wave-candidate.js';

const savedRandom = Math.random;
Math.random = () => { throw new Error('Unseeded random used'); };
try {
  const field = createOceanMicroCandidate('micro-contract');
  assert.deepEqual(field, createOceanMicroCandidate('micro-contract'));
  assert.notDeepEqual(field, createOceanMicroCandidate('micro-other'));
  assert.equal(field.modes.length, 10);
  assert.throws(() => createOceanMicroCandidate('bad', { count: 24 }), RangeError);
  assert.throws(() => createOceanMicroCandidate('bad', { gravity: 0 }), RangeError);
  for (const mode of field.modes) {
    assert.ok(Math.abs(Math.hypot(...mode.axis) - 1) < 1e-12);
    assert.ok(2 * Math.PI / mode.k >= 0.7 && 2 * Math.PI / mode.k <= 20);
    assert.ok(Math.abs(mode.omega ** 2 - 9.81 * mode.k) < 1e-12);
  }
  const anchor = { x: 6000000.125, y: -931.6, z: 835.2 };
  const relative = { x: 3.2, y: 2.1, z: -1.7 }, seconds = 123456.75;
  const phases = oceanMicroCandidatePhases(field, anchor, seconds);
  const options = { up: anchor, footprint: 0.12, strength: 0.8 };
  const sample = sampleOceanMicroCandidate(field, relative, phases, options);
  let maxGradientError = 0, maxAnchorError = 0;
  for (const axis of ['x', 'y', 'z']) {
    const epsilon = 1e-5;
    const a = sampleOceanMicroCandidate(field, { ...relative, [axis]: relative[axis] - epsilon }, phases, options);
    const b = sampleOceanMicroCandidate(field, { ...relative, [axis]: relative[axis] + epsilon }, phases, options);
    const error = Math.abs((b.height - a.height) / (2 * epsilon) - sample.gradient[axis]);
    maxGradientError = Math.max(maxGradientError, error);
    assert.ok(error < 1e-8, `Analytic height derivative ${axis}: ${error}`);
  }
  for (const delta of [1, 128, 1000, -4096]) {
    const nextAnchor = { x: anchor.x + delta, y: anchor.y - delta * 0.4, z: anchor.z + delta * 0.7 };
    const nextRelative = { x: relative.x - delta, y: relative.y + delta * 0.4, z: relative.z - delta * 0.7 };
    const next = sampleOceanMicroCandidate(field, nextRelative, oceanMicroCandidatePhases(field, nextAnchor, seconds), options);
    for (const error of [Math.abs(next.height - sample.height), Math.abs(next.compression - sample.compression),
      ...['x', 'y', 'z'].map((axis) => Math.abs(next.gradient[axis] - sample.gradient[axis]))]) {
      maxAnchorError = Math.max(maxAnchorError, error);
      assert.ok(error < 1e-8, `Anchor seam: ${error}`);
    }
  }
  for (const mode of field.modes) {
    const lambda = 2 * Math.PI / mode.k;
    for (const threshold of [lambda / 8, lambda / 4]) {
      assert.ok(Math.abs(microWaveFilter(mode.k, threshold - 1e-6)
        - microWaveFilter(mode.k, threshold + 1e-6)) < 1e-8, 'C1 footprint endpoint');
    }
    assert.equal(microWaveFilter(mode.k, lambda / 8), 1);
    assert.equal(microWaveFilter(mode.k, lambda / 4), 0);
  }
  const gone = sampleOceanMicroCandidate(field, relative, phases, { ...options, footprint: 5 });
  assert.deepEqual(gone, { height: 0, gradient: { x: 0, y: 0, z: 0 }, compression: 0, crest: 0 });
  const one = { modes: [{ axis: [1, 0, 0], k: 1, amplitude: 0.1 }], heightBound: 0.1 };
  const crest = sampleOceanMicroCandidate(one, { x: 0, y: 0, z: 0 }, [[0, 0.1]]);
  const trough = sampleOceanMicroCandidate(one, { x: Math.PI, y: 0, z: 0 }, [[0, 0.1]]);
  assert.equal(crest.crest, 1); assert.ok(crest.compression > 0);
  assert.equal(trough.crest, 0); assert.ok(trough.compression < 0);
  const glsl = oceanMicroCandidateGLSL(field);
  assert.ok(glsl.includes('i < 10') && !glsl.includes('cameraPosition'));
  const start = performance.now();
  for (let i = 0; i < 100000; i++) sampleOceanMicroCandidate(field, { x: i * 0.003, y: 0, z: -i * 0.007 }, phases, options);
  console.log(JSON.stringify({ status: 'CPU candidate contracts pass, not production or visual acceptance',
    modes: field.modes.length, maxGradientError, maxAnchorError,
    heightBound: field.heightBound, slopeBound: field.slopeBound,
    samples100kMilliseconds: performance.now() - start,
    shaderCostBound: '10 sin + 10 cos; 10 filters; 320 bytes std140 mode+phase arrays; no texture lookups. GPU cost unmeasured.' }, null, 2));
} finally { Math.random = savedRandom; }
