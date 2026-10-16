// CPU attribution baseline, NOT GPU or visual acceptance. Run with
// node tools/nearwaterprecisiontest.js. No browser or files are created.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import * as THREE from 'three';
import { Planet } from '../src/planet.js';
import { NearWaterPatch } from '../src/near-water-patch.js';
import { sampleOceanWaveField } from '../src/ocean-wave-field.js';
import { oceanSeconds } from '../src/ocean-clock.js';
import { generateSystemSpec } from '../src/astronomy.js';
import { GalaxyCatalog, HOME_SYSTEM_ID } from '../src/galaxy-layout.js';
import { getGalaxyConfig, resolveBodyTuning } from '../src/world-config.js';

const galaxy = getGalaxyConfig();
const catalog = new GalaxyCatalog(galaxy.seed);
const system = generateSystemSpec(galaxy.seed, catalog.getSystem(HOME_SYSTEM_ID));
const body = system.bodies.find((b) => b.bodyId === 'planet-0');
const home = new Planet({ ...body, radius: body.radius, posUniv: new THREE.Vector3(),
  tuning: resolveBodyTuning({ galaxyId: galaxy.id, seed: galaxy.seed,
    systemId: system.systemId, bodyId: body.bodyId }) });
const clocks = [0, 12.345, 50];
const offsets = [0, 256, 400, 540, 700, 1000, 1100]; // Includes 60/30 FPS fixed-core budget replay bounds.
const radii = [0, 5, 20, 100];
const candidateCore = Number(process.env.NEAR_WATER_CORE || 640);
assert.ok([640, 800].includes(candidateCore));
const sources = Object.fromEntries(['near-water-patch.js', 'shaders-webgl.js', 'ocean-surface.js',
  'ocean-wave-field.js'].map((file) => {
  const content = readFileSync(new URL(`../src/${file}`, import.meta.url));
  return [file, createHash('sha256').update(content).digest('hex')];
}));
const shaderSource = readFileSync(new URL('../src/shaders-webgl.js', import.meta.url), 'utf8');
const usesCellAttribute = /max\(4\.0,\s*aWaterCell\)/.test(shaderSource);
assert.ok(usesCellAttribute || /mix\(4\.0, 88\.0, pow\(clamp\(length\(transformed\) \/ 8192\.0/.test(shaderSource),
  'Unknown shader footprint: update this baseline rather than silently measuring an old formula.');
function directions() {
  let seed = 61;
  const random = () => ((seed = seed * 16807 % 2147483647) / 2147483647);
  const result = [];
  while (result.length < 3000) {
    const p = new THREE.Vector3(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
    if (p.lengthSq() >= 0.01 && p.lengthSq() <= 1) result.push(p.normalize());
  }
  return result;
}
const depthAt = (direction) => home.seaLevel - home.height(direction, home.fullMaxFreq);
const metric = (samples, key) => samples.length ? {
  maxAbs: Math.max(...samples.map((s) => Math.abs(s[key]))),
  rms: Math.sqrt(samples.reduce((sum, s) => sum + s[key] ** 2, 0) / samples.length),
} : null;
function summary(samples) {
  return { count: samples.length,
    ...Object.fromEntries(['heightError', 'legacyHeightError', 'cellAttributeHeightError',
      'depthError', 'hsOnly', 'depthOnly', 'geometryRemainder']
      .map((key) => [key, metric(samples, key)])) };
}

// Candidate scheduler only. The live class deliberately remains reactive until
// sudden-motion regressions are understood. Units are local tangent metres.
// Fixed build-frame workloads make the experiment reproducible; the actual
// machine's measured 2 ms budget is reported independently below.
function simulateAnchorPolicy({ fps, buildFrames, policy, scenario, core = candidateCore }) {
  const dt = 1 / fps, duration = 24;
  let x = 0, y = 0, cx = 0, cy = 0, job = null;
  let lastBuildSeconds = buildFrames / fps;
  let maxDistance = 0, afterWarmupMax = 0, starts = 0, commits = 0, rejected = 0;
  let outsideCoreFrames = 0, outsideFootprintFrames = 0, maximumPendingFrames = 0;
  const firstMotion = 2;
  const velocity = (time) => {
    if (time < firstMotion) return [0, 0];
    if (scenario === 'stop-during-build' && time >= 4.25) return [0, 0];
    if (scenario === 'early-one-second-turn') {
      const angle = Math.min(1, Math.max(0, (time - 2.25))) * Math.PI * 0.5;
      return [150 * Math.cos(angle), 150 * Math.sin(angle)];
    }
    if (scenario === 'right-angle-and-stop') {
      if (time >= 14) return [0, 0];
      if (time >= 7) return [0, 150];
    }
    return [150, 0];
  };
  for (let frame = 0; frame < duration * fps; frame++) {
    const time = frame * dt;
    const [vx, vy] = velocity(time);
    x += vx * dt; y += vy * dt;
    if (job) {
      // No cancellation/restart on changing direction or stopping.
      job.frames++;
      maximumPendingFrames = Math.max(maximumPendingFrames, job.frames);
      if (job.frames >= buildFrames) {
        const candidateDistance = Math.hypot(x - job.x, y - job.y);
        const oldDistance = Math.hypot(x - cx, y - cy);
        // A completed wrong prediction must not replace a closer valid mesh
        // with a farther out-of-core one. This is a commit decision, not churn.
        if (policy !== 'reactive' && candidateDistance > Math.max(540, oldDistance)) rejected++;
        else { cx = job.x; cy = job.y; commits++; }
        lastBuildSeconds = job.frames * dt;
        job = null;
      }
    }
    if (!job) {
      const distance = Math.hypot(x - cx, y - cy);
      const projected = Math.hypot(x + vx * lastBuildSeconds * 1.1 - cx,
        y + vy * lastBuildSeconds * 1.1 - cy);
      const trigger = policy === 'reactive' ? distance > 256 : projected > 540 || distance > 540;
      if (trigger) {
        const lead = policy === 'endpoint' ? 1 : policy === 'visible-midpoint' ? 1.5 : 0;
        job = { x: x + vx * lastBuildSeconds * lead,
          y: y + vy * lastBuildSeconds * lead, frames: 0 };
        starts++;
      }
    }
    const distance = Math.hypot(x - cx, y - cy);
    maxDistance = Math.max(maxDistance, distance);
    if (time > firstMotion + 2 * buildFrames / fps) afterWarmupMax = Math.max(afterWarmupMax, distance);
    if (distance > core) outsideCoreFrames++;
    if (distance > core - 100) outsideFootprintFrames++;
  }
  assert.ok(starts <= Math.ceil(duration * fps / buildFrames) + 1, 'prediction cannot restart pending builds');
  assert.ok(maximumPendingFrames <= buildFrames);
  return { fps, buildFrames, policy, scenario, maxDistance, afterWarmupMax,
    starts, commits, rejected, maximumPendingFrames,
    outsideCoreSeconds: outsideCoreFrames / fps,
    outside100mFootprintSeconds: outsideFootprintFrames / fps,
    sourceOfDuration: 'previous completed build frame count, updated after every completion',
    modelBoundary: 'exact instantaneous planet-local velocity and fixed workload per run; estimator noise/variable GPU frame time can make real behaviour worse',
    core,
    uniform4mCoreCoversWhole100mFootprint: maxDistance <= core - 100,
    precisionBoundary: maxDistance <= core - 100
      ? '4 m cell coverage; use measured core errors, not an analytic GPU error guarantee'
      : 'outside fixed core during some frames; no sub-centimetre contact claim' };
}

const anchorCandidates = [];
for (const fps of [60, 30]) for (const buildFrames of [180, 270])
  for (const scenario of ['straight-from-rest', 'right-angle-and-stop',
    'early-one-second-turn', 'stop-during-build'])
    for (const policy of ['reactive', 'endpoint', 'visible-midpoint']) {
      anchorCandidates.push(simulateAnchorPolicy({ fps, buildFrames, scenario, policy }));
    }

function useWideCoreCandidate(patch) {
  const coreCells = candidateCore / 4;
  const outerCells = 256 - coreCells;
  patch._gridCoordinate = (index) => {
    const distance = Math.abs(index - 256);
    const outer = Math.max(0, distance - coreCells);
    return Math.sign(index - 256) * (Math.min(distance, coreCells) * 4
      + outer * 4 + (8192 - candidateCore - outerCells * 4) * (outer / outerCells) ** 3);
  };
}

// Run each budget in its own fresh Node process for a genuine first-build row
// workload: NEAR_WATER_BUDGET_ONLY=2 (or 4/8) node tools/nearwaterprecisiontest.js.
// NEAR_WATER_CORE=800 selects the wider candidate (default 640 m).
// This path does not first run terrain/precision sweeps that warm height().
if (process.env.NEAR_WATER_BUDGET_ONLY) {
  const budgetMs = Number(process.env.NEAR_WATER_BUDGET_ONLY);
  assert.ok([2, 4, 8].includes(budgetMs));
  const runs = [];
  try {
    for (let run = 0; run < 4; run++) {
      const material = new THREE.MeshBasicMaterial();
      const patch = new NearWaterPatch(home, material, { buildBudgetMs: budgetMs });
      useWideCoreCandidate(patch);
      try {
        patch._begin(new THREE.Vector3(0.34669147556655305, 0.07291666666666663, -0.9351407276403421));
        const batches = [], rows = [];
        while (patch.build) {
          const beforeRow=patch.build.row,beforeColumn=patch.build.column;
          const start = performance.now();
          patch._buildRows();
          batches.push(performance.now() - start);
          rows.push(patch.lastBuildRows);
          assert.ok(!patch.build||patch.build.row>beforeRow||patch.build.column>beforeColumn);
        }
        const sorted = [...batches].sort((a, b) => a - b);
        runs.push({ run, phase: run ? 'repeat-build' : 'fresh-process-first-build',
          batches: batches.length, totalMs: batches.reduce((a, b) => a + b, 0),
          p50Ms: sorted[Math.floor(sorted.length * 0.5)], p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          maxMs: sorted.at(-1), rowsMin: Math.min(...rows), rowsMax: Math.max(...rows),
          commitMs: patch.lastCommitMs,
          outerGrid: [200, 208, 224, 240, 255].map((offset) => ({
            indexFromCenter: offset,
            distance: patch._gridCoordinate(256 + offset),
            nextCell: patch._gridCoordinate(257 + offset) - patch._gridCoordinate(256 + offset),
          })),
          stallAdjustedSimulations: [60, 30].map((fps) => {
            const frames = batches.reduce((sum, ms) => sum + Math.max(1, Math.ceil(ms / (1000 / fps))), 0);
            return simulateAnchorPolicy({ fps, buildFrames: frames, policy: 'reactive', scenario: 'straight-from-rest' });
          }),
          simulations: [60, 30].flatMap((fps) =>
            ['straight-from-rest', 'right-angle-and-stop', 'early-one-second-turn', 'stop-during-build']
              .map((scenario) => simulateAnchorPolicy({ fps, buildFrames: batches.length,
                policy: 'reactive', scenario }))) });
      } finally { patch.dispose(); material.dispose(); }
    }
    console.log(JSON.stringify({ schema: 'near-water-fixed-core-budget-v1', budgetMs,
      grid: `${candidateCore} m half-width fixed 4 m core; C1 cubic outer ring; 512 cells`,
      scheduling: 'no prediction, 256 m low-altitude trigger, no pending restarts',
      sourceHashes: sources,
      boundary: 'CPU fresh-process/repeat-build observations; frame count replay assumes 60 or 30 FPS, not GPU or browser frame-time acceptance. Upper-altitude policy remains untouched.',
      runs, worstBatchCount: Math.max(...runs.map((r) => r.batches)),
      worstBatchMs: Math.max(...runs.map((r) => r.maxMs)) }, null, 2));
  } finally { home.dispose(); }
  process.exit(0);
}

const reports = [];
try {
  // A zero grant holds the cursor; a positive grant resumes the same build.
  const fake = { name: 'budget-contract', group: new THREE.Group(), seaRadius: 6000000,
    seaLevel: 0, fullMaxFreq: 1, height: () => -10 };
  const mat = new THREE.MeshBasicMaterial();
  for (const options of [{}, { cells: 8, size: 64 }, { cells: 8, size: 16 }]) {
    const gridPatch = new NearWaterPatch(fake, mat, options);
    try {
      assert.equal(gridPatch._gridCoordinate(0), -gridPatch.size / 2);
      assert.equal(gridPatch._gridCoordinate(gridPatch.cells), gridPatch.size / 2);
      assert.equal(gridPatch._gridCoordinate(gridPatch.cells / 2), 0);
      const join = gridPatch.cells / 2 + gridPatch.coreCells;
      const epsilon = 0.0001;
      const left = (gridPatch._gridCoordinate(join) - gridPatch._gridCoordinate(join - epsilon)) / epsilon;
      const right = (gridPatch._gridCoordinate(join + epsilon) - gridPatch._gridCoordinate(join)) / epsilon;
      assert.ok(Math.abs(left - right) < 0.00001, 'core joins the graded tail with C1 slope');
      for (let i = 1; i <= gridPatch.cells; i++)
        assert.ok(gridPatch._gridCoordinate(i) > gridPatch._gridCoordinate(i - 1));
      gridPatch.update(new THREE.Vector3(fake.seaRadius + 50, 0, 0), true, 1 / 60);
      assert.equal(gridPatch.buildBudgetMs, 4);
      gridPatch.update(new THREE.Vector3(fake.seaRadius + 50, 0, 0), true, 1 / 30);
      assert.equal(gridPatch.buildBudgetMs, 8);
      gridPatch.update(new THREE.Vector3(fake.seaRadius + 50, 0, 0), true, 1 / 120);
      assert.equal(gridPatch.buildBudgetMs, 4);
      gridPatch.update(new THREE.Vector3(fake.seaRadius + 150, 0, 0), true, 1 / 30);
      assert.equal(gridPatch.buildBudgetMs, 2);
    } finally { gridPatch.dispose(); }
  }
  const budgetPatch = new NearWaterPatch(fake, mat, { cells: 8, size: 64, buildBudgetMs: 0 });
  try {
    budgetPatch._begin(new THREE.Vector3(1, 0, 0));
    const initialJob = budgetPatch.build;
    for (let i = 0; i < 9; i++) {
      const direction = new THREE.Vector3(1, 0, 0);
      budgetPatch.update(direction.multiplyScalar(fake.seaRadius + 50), true);
      assert.equal(budgetPatch.lastBuildRows, 0);
      if (budgetPatch.build) assert.equal(budgetPatch.build, initialJob);
    }
    assert.equal(budgetPatch.rebuilds, 0,'Zero grant retains resumable work');
    budgetPatch._buildRows(Infinity);
    assert.equal(budgetPatch.rebuilds,1);
    const moved = new THREE.Vector3(1, 300 / fake.seaRadius, 0).normalize();
    budgetPatch.update(moved.clone().multiplyScalar(fake.seaRadius + 150), true);
    assert.equal(budgetPatch.build, null, 'high-altitude rebuild threshold remains 1024 m');
    budgetPatch.update(moved.clone().multiplyScalar(fake.seaRadius + 50), true,1/60,Number.MIN_VALUE);
    assert.ok(budgetPatch.build, 'below 100 m the 256 m threshold starts a replacement');
    assert.equal(budgetPatch.debugStats().rebuildDistance, 256);
    assert.equal(budgetPatch.buildBudgetMs, Number.MIN_VALUE);
    const committed = budgetPatch.mesh.geometry;
    budgetPatch.update(moved.clone().multiplyScalar(fake.seaRadius + 18001), true);
    assert.equal(budgetPatch.build, null, 'hidden patch cancels orphaned pending work');
    assert.equal(budgetPatch.mesh.geometry, committed, 'committed mesh survives cancellation');
    assert.equal(budgetPatch.mesh.visible, false);
  } finally { budgetPatch.dispose(); mat.dispose(); }
  assert.ok(home.oceanSurface && !home.oceanSurface.tidalField,
    'this home baseline isolates ordinary waves; add a separate tidal reference if content changes');
  const dirs = directions();
  let land = dirs.find((d) => depthAt(d) < 0);
  let water = dirs.find((d) => depthAt(d) > 100);
  for (let i = 0; i < 50; i++) {
    const mid = land.clone().add(water).normalize();
    if (depthAt(mid) > 0.9) water = mid; else land = mid;
  }
  assert.ok(Math.abs(depthAt(water) - 0.9) < 1e-6);
  const sites = [
    ['shallow', water],
    ['deep', new THREE.Vector3(0.34669147556655305, 0.07291666666666663, -0.9351407276403421).normalize()],
  ];
  for (const grid of ['production', 'wide-core-candidate'])
    for (const [label, direction] of sites) for (const anchorOffset of offsets) {
    const tangent = direction.clone().cross(new THREE.Vector3(0, 1, 0)).normalize();
    const side = direction.clone().cross(tangent).normalize();
    const anchor = direction.clone().addScaledVector(tangent, -anchorOffset / home.seaRadius).normalize();
    const material = new THREE.MeshBasicMaterial();
    const patch = new NearWaterPatch(home, material, { rowsPerFrame: 1 });
    if (grid === 'wide-core-candidate') {
      // Attribution only; runtime grid is intentionally unchanged. C1 join:
      // A fixed 4 m core, then the remaining cells extend cubically to 8192 m.
      useWideCoreCandidate(patch);
    }
    try {
      assert.equal(patch.cells, 512, 'review baseline when production grid changes');
      patch._begin(anchor);
      const job = patch.build, stride = patch.cells + 1;
      const builtRows = new Set(), testedTriangles = [];
      const coordinates = Array.from({ length: stride }, (_, i) => patch._gridCoordinate(i));
      const slot = (v) => {
        let i = 0;
        while (i < patch.cells - 1 && coordinates[i + 1] < v) i++;
        assert.ok(v >= coordinates[i] && v <= coordinates[i + 1]);
        return i;
      };
      const groups = [];
      for (const radius of radii) {
        const samples = [];
        for (const hours of clocks) for (let heading = 0; heading < (radius ? 16 : 1); heading++) {
          const theta = heading / 16 * Math.PI * 2;
          const dir = direction.clone().addScaledVector(tangent, Math.cos(theta) * radius / home.seaRadius)
            .addScaledVector(side, Math.sin(theta) * radius / home.seaRadius).normalize();
          const px = home.seaRadius * dir.dot(job.tangent) / dir.dot(anchor);
          const py = home.seaRadius * dir.dot(job.bitangent) / dir.dot(anchor);
          const x = slot(px), y = slot(py);
          const fx = (px - coordinates[x]) / (coordinates[x + 1] - coordinates[x]);
          const fy = (py - coordinates[y]) / (coordinates[y + 1] - coordinates[y]);
          // Execute the real builder only for needed rows (all vertices in each
          // row), preserving its Float32 assignments and terrain frequency.
          for (const row of [y, y + 1]) if (!builtRows.has(row)) {
            job.row = row; job.column = 0;
            // This sparse attribution fixture needs the complete requested
            // row. Production 2 ms slices can pause inside a row; marking that
            // partial row complete silently sampled zero-filled attributes.
            patch._buildRows(Infinity);
            assert.equal(patch.lastBuildRows,1);
            builtRows.add(row);
          }
          const lower = fx + fy <= 1;
          const indices = lower ? [y * stride + x, y * stride + x + 1, (y + 1) * stride + x]
            : [y * stride + x + 1, (y + 1) * stride + x + 1, (y + 1) * stride + x];
          const weights = lower ? [1 - fx - fy, fx, fy] : [1 - fy, fx + fy - 1, 1 - fx];
          testedTriangles.push({ offset: (y * patch.cells + x) * 6 + (lower ? 0 : 3), indices });
          const hs = home.oceanAt(anchor, hours).offshoreSignificantHeight;
          const seconds = oceanSeconds(hours);
          const rendered = new THREE.Vector3(), renderedLegacy = new THREE.Vector3();
          let depth = 0, shaderCell = 0, attributeCell = 0;
          for (let i = 0; i < 3; i++) {
            const k = indices[i];
            const offset = new THREE.Vector3().fromArray(job.position, k * 3);
            const position = offset.clone().add(job.centerPosition);
            const up = new THREE.Vector3().fromArray(job.local, k * 3).normalize();
            const legacyFootprint = 4 + 84 * (Math.min(1, offset.length() / 8192) ** 2);
            const footprint = Math.max(4, job.waterCell[k]);
            assert.ok(Number.isFinite(footprint) && footprint > 0);
            shaderCell = Math.max(shaderCell, usesCellAttribute ? footprint : legacyFootprint);
            attributeCell = Math.max(attributeCell, footprint);
            const wave = (cell) => sampleOceanWaveField(home.oceanSurface.waveField, position, seconds,
              { significantHeight: hs, footprint: cell }).height
              * Math.min(1, Math.max(0, job.depth[k]) * 0.62 / Math.max(hs, 0.001));
            rendered.addScaledVector(position.clone().addScaledVector(up, wave(footprint) + 0.18), weights[i]);
            renderedLegacy.addScaledVector(position.addScaledVector(up, wave(legacyFootprint) + 0.18), weights[i]);
            depth += job.depth[k] * weights[i];
          }
          const point = dir.clone().multiplyScalar(home.seaRadius);
          const logical = home.sampleWaterSurface(point, hours, { normal: false });
          const wave = sampleOceanWaveField(home.oceanSurface.waveField, point, seconds,
            { significantHeight: hs, footprint: 4 }).height;
          const withDepth = (d) => wave * Math.min(1, Math.max(0, d) * 0.62 / Math.max(hs, 0.001)) + 0.18;
          const hsOnly = withDepth(logical.depth) - logical.height;
          const depthOnly = withDepth(depth) - withDepth(logical.depth);
          const cellAttributeHeightError = rendered.length() - home.seaRadius - logical.height;
          const legacyHeightError = renderedLegacy.length() - home.seaRadius - logical.height;
          const heightError = usesCellAttribute ? cellAttributeHeightError : legacyHeightError;
          const a = new THREE.Vector3().fromArray(job.position, y * stride * 3 + x * 3);
          const b = new THREE.Vector3().fromArray(job.position, y * stride * 3 + (x + 1) * 3);
          const c = new THREE.Vector3().fromArray(job.position, (y + 1) * stride * 3 + x * 3);
          assert.ok(job.waterCell[y * stride + x] + 0.0002 >= Math.max(a.distanceTo(b), a.distanceTo(c)),
            'aWaterCell conservatively covers actual adjacent Float32 mesh edges');
          samples.push({ hours, wet: logical.wet, heightError, legacyHeightError, cellAttributeHeightError,
            depthError: depth - logical.depth,
            hsOnly, depthOnly, geometryRemainder: heightError - hsOnly - depthOnly,
            actualCell: Math.max(a.distanceTo(b), a.distanceTo(c)), shaderCell, attributeCell });
        }
        for (const sample of samples) assert.ok(Object.values(sample).every((v) => typeof v !== 'number' || Number.isFinite(v)));
        groups.push({ radius, wet: summary(samples.filter((s) => s.wet)),
          dry: summary(samples.filter((s) => !s.wet)),
          actualCellMax: Math.max(...samples.map((s) => s.actualCell)),
          cellAttributeMax: Math.max(...samples.map((s) => s.attributeCell)),
          shaderFootprintMax: Math.max(...samples.map((s) => s.shaderCell)) });
      }
      // Commit only to verify actual index-buffer triangulation. Unrequested
      // rows remain zero and are NEVER sampled or presented as a complete mesh.
      patch._commit();
      assert.equal(patch.mesh.geometry.getAttribute('aWaterCell').array, job.waterCell);
      const index = patch.mesh.geometry.index.array;
      for (const triangle of testedTriangles) assert.deepEqual(
        Array.from(index.slice(triangle.offset, triangle.offset + 3)), triangle.indices);
      reports.push({ grid, label, anchorOffset, direction: direction.toArray(), depth: depthAt(direction),
        builtRows: builtRows.size, groups });
    } finally { patch.dispose(); material.dispose(); }
  }
  const budgetMaterial = new THREE.MeshBasicMaterial();
  const timedPatch = new NearWaterPatch(home, budgetMaterial);
  let budgetProbe;
  try {
    timedPatch._begin(sites[1][1]);
    const batches = [];
    while (timedPatch.build) {
      const beforeRow=timedPatch.build.row,beforeColumn=timedPatch.build.column;
      const started = performance.now();
      timedPatch._buildRows();
      batches.push({ rows: timedPatch.lastBuildRows, milliseconds: performance.now() - started });
      assert.ok(!timedPatch.build||timedPatch.build.row>beforeRow||timedPatch.build.column>beforeColumn,
        'budget cannot starve construction');
    }
    const durations = batches.map((batch) => batch.milliseconds).sort((a, b) => a - b);
    budgetProbe = { budgetMs: timedPatch.buildBudgetMs, batches: batches.length,
      totalMs: durations.reduce((sum, value) => sum + value, 0),
      p50Ms: durations[Math.floor(durations.length * 0.5)],
      p95Ms: durations[Math.floor(durations.length * 0.95)], maxMs: durations.at(-1),
      commitMs: timedPatch.lastCommitMs,
      illustrativeDelay: { assumedFps: 60, assumedSpeedMetersPerSecond: 150,
        oldAnchorDistanceBeforeSwap: timedPatch.lowRebuildDistance + batches.length / 60 * 150,
        boundary: 'illustration from this CPU batch count, not a browser frame-rate guarantee' } };
  } finally { timedPatch.dispose(); budgetMaterial.dispose(); }
  console.log(JSON.stringify({ schema: 'near-water-precision-v2',
    units: 'metres', systemId: system.systemId, bodyId: body.bodyId, seed: home.seed, clocks, sources, usesCellAttribute,
    boundary: 'CPU production-builder attributes and triangles; double wave arithmetic, no GPU fp32 transcendental or raster/depth readback. Wet/dry separated. Sparse builder rows only.',
    budgetProbe, anchorCandidates, reports }, null, 2));
  console.log('PASS: finite reproducible near-field measurements and actual builder triangle correspondence; no visual/precision acceptance threshold asserted.');
} finally { home.dispose(); }
