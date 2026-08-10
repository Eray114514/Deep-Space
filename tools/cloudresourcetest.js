import assert from 'node:assert/strict';
import { CloudResourceManager } from '../src/cloud/cloud-resource-manager.js';
import { createCloudFields } from '../src/cloud/cloud-density.js';
import { buildOccupancyVolume } from '../src/cloud/cloud-occupancy.js';
import { createWeatherSystem } from '../src/cloud/weather-system.js';

const system = createWeatherSystem('cloud-resource-test', {
  targetCoverage: 0.5,
  calibrationSamples: 256,
  calibrationIterations: 8,
});
const fields = createCloudFields(system, {
  noiseSize: 16,
  detailSize: 8,
  atlasWidth: 32,
  atlasHeight: 16,
});
const occupancy = buildOccupancyVolume(fields, {
  longitude: 16,
  latitude: 8,
  altitude: 8,
});

const pending = new Map();
let disposedTextures = 0;
let uploadGeneration = 0;
const makeTexture = (name, bytes = 16) => ({
  name,
  image: { data: new Uint8Array(bytes) },
  dispose() { disposedTextures++; },
});
const upload = async ({ onSlice }) => {
  uploadGeneration++;
  const generation = uploadGeneration;
  const out = Object.fromEntries(['shape', 'detail', 'jitter', 'bands', 'occupancy']
    .map((name) => [name, makeTexture(`${name}:${generation}`)]));
  for (const [name, texture] of Object.entries(out)) {
    onSlice({ name, elapsedMs: 0.2, bytes: texture.image.data.byteLength });
  }
  return out;
};
const uploadDynamic = async ({ onSlice }) => {
  uploadGeneration++;
  const generation = uploadGeneration;
  const out = {
    bands: makeTexture(`bands:${generation}`),
    occupancy: makeTexture(`occupancy:${generation}`),
  };
  for (const [name, texture] of Object.entries(out)) {
    onSlice({ name, elapsedMs: 0.1, bytes: texture.image.data.byteLength });
  }
  return out;
};

const manager = new CloudResourceManager({
  generate(descriptor, cancellation) {
    return new Promise((resolve, reject) => {
      pending.set(descriptor.label, { resolve, reject, cancellation });
    });
  },
  upload,
  uploadDynamic,
  scheduleFrame: (callback) => callback(),
});

const descriptorA = { label: 'a', nested: { value: 1 } };
const leaseA = manager.acquire('planet-a', descriptorA);
const leaseASecond = manager.acquire('planet-a', descriptorA);
assert.equal(leaseA.token, leaseASecond.token, 'same generation is cache-hit shared');
assert.equal(manager.telemetry().cacheHits, 1, 'cache hit is counted');
pending.get('a').resolve({ fields, occupancy, timings: { totalMs: 1 } });
const resourceA = await leaseA.promise;
assert.equal(resourceA.cpuBytes > 0, true, 'CPU bytes are measured');
assert.equal(resourceA.gpuBytes, 80, 'GPU bytes are measured from uploaded textures');

let committedPair = null;
leaseA.onCommit((resource) => {
  committedPair = [resource.textures.bands.name, resource.textures.occupancy.name];
});
await manager.stageDynamic('planet-a', fields, occupancy, 12);
const beforeCommit = [...committedPair];
assert.equal(manager.commitDynamic('planet-a'), true, 'dynamic pair commits');
assert.notDeepEqual(committedPair, beforeCommit, 'listeners see the new pair');
assert.equal(committedPair[0].split(':')[1], committedPair[1].split(':')[1],
  'bands and occupancy advance through one generation');
assert.equal(manager.telemetry().atomicCommits, 1, 'atomic commit is counted');

const cancelLease = manager.acquire('planet-cancel', { label: 'cancel' });
cancelLease.release();
await assert.rejects(cancelLease.promise, /cancelled/);
assert.equal(pending.get('cancel').cancellation.cancelled, true,
  'cancellation terminates the owning generation');

const leaseDevice = manager.acquire('planet-device', { label: 'device' });
pending.get('device').resolve({ fields, occupancy });
await leaseDevice.promise;
let deviceCommitCount = 0;
leaseDevice.onCommit(() => { deviceCommitCount++; });
manager.handleDeviceLost();
assert.equal(manager.telemetry().gpuBytes, 0, 'device loss drops GPU ownership');
await manager.restoreDevice({});
assert.equal(deviceCommitCount >= 2, true, 'device restore rebinds the texture set');
assert.equal(manager.telemetry().deviceLosses, 1, 'device loss is counted');

leaseASecond.release();
leaseA.release();
manager.tickFrame();
assert.equal(manager.telemetry().entries.some((entry) => entry.key === 'planet-a'), true,
  'handoff source remains alive for the first grace frame');
manager.tickFrame();
assert.equal(manager.telemetry().entries.some((entry) => entry.key === 'planet-a'), false,
  'handoff source is released within two frames');

leaseDevice.release();
manager.tickFrame();
manager.tickFrame();
manager.dispose();
assert.equal(disposedTextures > 0, true, 'dispose reaches uploaded texture owners');

console.log('PASS: cloud resource worker/token/cache/upload/dispose lifecycle, '
  + 'two-frame handoff release, atomic bands+occupancy commit, byte telemetry, '
  + 'cancellation and device-loss restore all hold.');
