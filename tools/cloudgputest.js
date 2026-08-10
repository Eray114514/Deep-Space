import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from './server.js';
import { launchWebGPUHardwareBrowser } from './browser.js';

const outputDir = new URL('../test-results/cloud-gpu/', import.meta.url);
await mkdir(outputDir, { recursive: true });
const { server, port } = await startServer(0);
const browser = await launchWebGPUHardwareBrowser({ headless: true });
if (!browser) {
  console.log('SKIP: cloud GPU parity needs an installed hardware WebGPU browser.');
  await new Promise((resolve) => server.close(resolve));
  process.exit(0);
}

const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.stack || String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});

function distribution(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return {
    max: ordered.at(-1) || 0,
    p95: ordered[Math.min(ordered.length - 1,
      Math.floor(ordered.length * 0.95))] || 0,
    mean: ordered.reduce((sum, value) => sum + value, 0)
      / Math.max(1, ordered.length),
  };
}

function compare(label, result) {
  const densityErrors = [];
  const extinctionErrors = [];
  const densityAbsolute = [];
  const extinctionAbsolute = [];
  let nonZero = 0;
  let worstDensity = null;
  let worstExtinction = null;
  for (let index = 0; index < result.cpu.length; index++) {
    const cpu = result.cpu[index];
    const gpu = result.gpu[index];
    assert.ok(Number.isFinite(gpu.density)
      && Number.isFinite(gpu.extinctionPerMeter),
    `${label}[${index}] returned non-finite GPU medium`);
    // Density is a [0,1] condensate fraction, so its percentage error is
    // measured against that full physical range. Extinction has no unitless
    // upper bound; 0.02 m^-1 (one e-fold per 50 m) is the conservative dense
    // cloud reference floor, while still using the actual value above it.
    const densityScale = 1;
    const extinctionScale = Math.max(0.02, Math.abs(cpu.extinctionPerMeter));
    const densityDelta = Math.abs(gpu.density - cpu.density);
    const extinctionDelta = Math.abs(gpu.extinctionPerMeter
      - cpu.extinctionPerMeter);
    densityErrors.push(densityDelta / densityScale);
    extinctionErrors.push(extinctionDelta / extinctionScale);
    densityAbsolute.push(densityDelta);
    extinctionAbsolute.push(extinctionDelta);
    if (!worstDensity || densityDelta > worstDensity.delta) {
      worstDensity = { index, delta: densityDelta, cpu, gpu };
    }
    if (!worstExtinction || extinctionDelta > worstExtinction.delta) {
      worstExtinction = { index, delta: extinctionDelta, cpu, gpu };
    }
    if (cpu.density > 0.02) nonZero++;
  }
  return {
    label,
    samples: result.cpu.length,
    nonZero,
    densityRelative: distribution(densityErrors),
    extinctionRelative: distribution(extinctionErrors),
    densityAbsolute: distribution(densityAbsolute),
    extinctionAbsolute: distribution(extinctionAbsolute),
    worstDensity,
    worstExtinction,
  };
}

try {
  const url = `http://127.0.0.1:${port}/?renderer=webgpu&quality=high`
    + '&worldlab=1&seed=CLOUD-PHASE4-A&nolock=1&nohero=1&farflora=0'
    + '&vclouds=1&scene=orbit&planet=0&factor=0.15&time=9.5';
  await page.goto(url);
  await page.waitForFunction('window.NMS?.booted === true', null, {
    timeout: 120000,
  });
  await page.evaluate(() => NMS.setAdaptiveQualityLocked(true));
  try {
    await page.waitForFunction(
      'NMS.cloudResourceState(0).planet?.status === "ready"', null,
      { timeout: 180000 },
    );
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      resource: NMS.cloudResourceState(0),
      volume: NMS.volumeState(),
      stats: NMS.stats(),
      planet: {
        hasVolume: Boolean(NMS._planet(0)?.volCloudState),
        volumeActive: NMS._planet(0)?.volumeActive,
        visible: NMS._planet(0)?.volCloudMesh?.visible,
      },
    })).catch(() => null);
    console.error(JSON.stringify({ diagnostic, errors }, null, 2));
    throw error;
  }

  const probe = await page.evaluate(async () => {
    const planet = NMS._planet(0);
    const occupancy = planet.cloudResource.occupancy;
    const fields = planet.cloudResource.fields;
    const { lonCount, latCount, altCount, data } = occupancy;
    let best = { score: -1, i: 0, j: 0 };
    for (let j = 0; j < latCount; j++) {
      for (let i = 0; i < lonCount; i++) {
        let score = 0;
        for (let k = 0; k < altCount; k++) {
          score += data[((k * latCount + j) * lonCount + i) * 4];
        }
        if (score > best.score) best = { score, i, j };
      }
    }
    const lon = ((best.i + 0.5) / lonCount) * Math.PI * 2;
    const lat = ((best.j + 0.5) / latCount - 0.5) * Math.PI;
    const direction = {
      x: Math.cos(lon) * Math.cos(lat),
      y: Math.sin(lat),
      z: Math.sin(lon) * Math.cos(lat),
    };
    const reference = Math.abs(direction.y) < 0.9
      ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    const tangent = {
      x: direction.y * reference.z - direction.z * reference.y,
      y: direction.z * reference.x - direction.x * reference.z,
      z: direction.x * reference.y - direction.y * reference.x,
    };
    const tangentLength = Math.hypot(tangent.x, tangent.y, tangent.z);
    tangent.x /= tangentLength;
    tangent.y /= tangentLength;
    tangent.z /= tangentLength;
    const slice = [];
    for (let row = 0; row < 32; row++) {
      const altitude = occupancy.shellFloor
        + (row + 0.5) / 32 * (occupancy.shellTop - occupancy.shellFloor);
      for (let column = 0; column < 32; column++) {
        const lateral = (column / 31 - 0.5) * 180000;
        const displaced = {
          x: direction.x + tangent.x * lateral / fields.groundR,
          y: direction.y + tangent.y * lateral / fields.groundR,
          z: direction.z + tangent.z * lateral / fields.groundR,
        };
        const length = Math.hypot(displaced.x, displaced.y, displaced.z);
        const radius = fields.groundR + altitude;
        slice.push({
          x: displaced.x / length * radius,
          y: displaced.y / length * radius,
          z: displaced.z / length * radius,
        });
      }
    }
    let randomState = 0x6d2b79f5;
    const random = () => {
      randomState = Math.imul(randomState ^ randomState >>> 15,
        randomState | 1);
      randomState ^= randomState + Math.imul(randomState ^ randomState >>> 7,
        randomState | 61);
      return ((randomState ^ randomState >>> 14) >>> 0) / 4294967296;
    };
    const randomPoints = [];
    for (let index = 0; index < 512; index++) {
      const y = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const horizontal = Math.sqrt(Math.max(0, 1 - y * y));
      const radius = fields.groundR + occupancy.shellFloor
        + random() * (occupancy.shellTop - occupancy.shellFloor);
      randomPoints.push({
        x: Math.cos(angle) * horizontal * radius,
        y: y * radius,
        z: Math.sin(angle) * horizontal * radius,
      });
    }
    return {
      best,
      dimensions: [lonCount, latCount, altCount],
      slice: await NMS.cloudGpuProbe(0, slice),
      random: await NMS.cloudGpuProbe(0, randomPoints),
      resource: NMS.cloudResourceState(0),
      renderer: NMS.stats().rendererBackend,
    };
  });
  assert.equal(probe.renderer, 'webgpu');
  assert.deepEqual(errors, []);
  const report = {
    renderer: probe.renderer,
    occupancy: probe.dimensions,
    selectedColumn: probe.best,
    resource: probe.resource,
    fixedSlice: compare('fixed-slice', probe.slice),
    random: compare('random', probe.random),
  };
  console.log(JSON.stringify(report, null, 2));
  assert.ok(report.fixedSlice.nonZero >= 16,
    `fixed slice did not exercise cloud medium: ${report.fixedSlice.nonZero}`);
  assert.ok(report.random.nonZero >= 4,
    `random probe did not exercise cloud medium: ${report.random.nonZero}`);
  for (const sampleSet of [report.fixedSlice, report.random]) {
    assert.ok(sampleSet.densityRelative.max < 0.01,
      `${sampleSet.label} density error >= 1%: ${sampleSet.densityRelative.max}`);
    assert.ok(sampleSet.extinctionRelative.max < 0.01,
      `${sampleSet.label} extinction error >= 1%: ${sampleSet.extinctionRelative.max}`);
  }
  await writeFile(new URL('report.json', outputDir),
    `${JSON.stringify(report, null, 2)}\n`);
  console.log('PASS: fixed-slice and deterministic-random WebGPU readback match CPU below 1%.');
} finally {
  await page.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
