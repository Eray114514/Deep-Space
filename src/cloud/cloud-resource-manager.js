// Cloud-field resource ownership (phase 4 A0).
//
// The CPU bake is worker-owned and cancellable. GPU upload is spread across
// animation frames, resource generations are tokened, and dynamic
// bands/occupancy pairs commit through one atomic pointer swap. This module is
// deliberately independent of Planet: the same manager serves the live world
// and a prepared portal destination without either system owning the other's
// textures.

import * as THREE from 'three';
import {
  cloudFieldByteLength, hydrateCloudFields,
} from './cloud-density.js';
import {
  hydrateOccupancyVolume, occupancyByteLength,
} from './cloud-occupancy.js';

const DEFAULT_MAX_ENTRIES = 2;
const RELEASE_GRACE_FRAMES = 2;
const GPU_UPLOAD_SLICE_BYTES = 1024 * 1024;

function nextFrame(scheduleFrame) {
  return new Promise((resolve) => scheduleFrame(resolve));
}

function configureTexture(texture, {
  format = THREE.RGBAFormat,
  minFilter = THREE.LinearFilter,
  magFilter = THREE.LinearFilter,
  wrapS = THREE.ClampToEdgeWrapping,
  wrapT = THREE.ClampToEdgeWrapping,
  wrapR = THREE.ClampToEdgeWrapping,
} = {}) {
  texture.format = format;
  texture.type = THREE.FloatType;
  texture.minFilter = minFilter;
  texture.magFilter = magFilter;
  texture.wrapS = wrapS;
  texture.wrapT = wrapT;
  texture.wrapR = wrapR;
  texture.generateMipmaps = false;
  texture.unpackAlignment = 1;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

function createFieldTextures(fields, occupancy) {
  const shape = configureTexture(new THREE.Data3DTexture(
    fields.shape.data, fields.shape.size, fields.shape.size, fields.shape.size), {
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    wrapR: THREE.RepeatWrapping,
  });
  shape.name = 'Cloud shape field';

  const detail = configureTexture(new THREE.Data3DTexture(
    fields.detail.data, fields.detail.size, fields.detail.size, fields.detail.size), {
    format: THREE.RedFormat,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    wrapR: THREE.RepeatWrapping,
  });
  detail.name = 'Cloud detail field';

  const jitter = configureTexture(new THREE.DataTexture(
    fields.jitter.data, fields.jitter.width, fields.jitter.height));
  jitter.wrapS = THREE.RepeatWrapping;
  jitter.name = 'Cloud regional jitter';

  const bands = configureTexture(new THREE.DataArrayTexture(
    fields.bands.data, fields.bands.width, fields.bands.height, fields.bands.layers));
  bands.wrapS = THREE.RepeatWrapping;
  bands.name = 'Cloud species bands';

  const occupancyTexture = configureTexture(new THREE.Data3DTexture(
    occupancy.data, occupancy.lonCount, occupancy.latCount, occupancy.altCount), {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
  });
  occupancyTexture.name = 'Cloud occupancy volume';

  return { shape, detail, jitter, bands, occupancy: occupancyTexture };
}

function createDynamicTextures(fields, occupancy) {
  const bands = configureTexture(new THREE.DataArrayTexture(
    fields.bands.data, fields.bands.width, fields.bands.height, fields.bands.layers));
  bands.wrapS = THREE.RepeatWrapping;
  bands.name = `Cloud species bands @ ${fields.hours}`;
  const occupancyTexture = configureTexture(new THREE.Data3DTexture(
    occupancy.data, occupancy.lonCount, occupancy.latCount, occupancy.altCount), {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    wrapS: THREE.RepeatWrapping,
  });
  occupancyTexture.name = `Cloud occupancy @ ${occupancy.hours}`;
  return { bands, occupancy: occupancyTexture };
}

function textureBytes(texture) {
  return texture?.image?.data?.byteLength || 0;
}

function textureSetBytes(textures) {
  return Object.values(textures || {}).reduce(
    (sum, texture) => sum + textureBytes(texture), 0);
}

function disposeTextures(textures) {
  for (const texture of new Set(Object.values(textures || {}))) texture?.dispose?.();
}

function disposeResourceTextures(resource) {
  const owned = new Set(Object.values(resource?.textures || {}));
  for (const slot of resource?.dynamicSlots || []) {
    for (const texture of Object.values(slot || {})) {
      if (texture?.dispose) owned.add(texture);
    }
  }
  for (const texture of owned) texture.dispose();
}

async function uploadTextures(renderer, textures, scheduleFrame, onSlice) {
  for (const [name, texture] of Object.entries(textures)) {
    const device = renderer?.backend?.device;
    const image = texture.image;
    const canSlice = device?.queue?.writeTexture && image?.data
      && renderer?.backend?.get && renderer?.initTexture;
    if (!canSlice) {
      await nextFrame(scheduleFrame);
      const startedAt = performance.now();
      renderer?.initTexture?.(texture);
      const elapsedMs = performance.now() - startedAt;
      onSlice?.({ name, elapsedMs, bytes: textureBytes(texture) });
      continue;
    }

    // Ask Three to allocate and register the complete texture without copying
    // its source. A single initTexture(shape128^3 RGBA32F) previously queued
    // all 32 MiB synchronously and blocked the main thread for 11-15 ms.
    texture.source.dataReady = false;
    const allocationStartedAt = performance.now();
    renderer.initTexture(texture);
    const allocationMs = performance.now() - allocationStartedAt;
    texture.source.dataReady = true;
    onSlice?.({ name: `${name}:allocate`, elapsedMs: allocationMs, bytes: 0 });
    const gpuTexture = renderer.backend.get(texture)?.texture;
    if (!gpuTexture) throw new Error(`cloud upload could not allocate ${name}`);

    const channels = texture.format === THREE.RedFormat ? 1 : 4;
    const width = image.width;
    const height = image.height;
    const depth = Math.max(1, image.depth || 1);
    const elementsPerLayer = width * height * channels;
    const bytesPerLayer = elementsPerLayer * image.data.BYTES_PER_ELEMENT;
    const layersPerSlice = Math.max(1,
      Math.floor(GPU_UPLOAD_SLICE_BYTES / bytesPerLayer));
    for (let layer = 0; layer < depth; layer += layersPerSlice) {
      await nextFrame(scheduleFrame);
      const layerCount = Math.min(layersPerSlice, depth - layer);
      const first = layer * elementsPerLayer;
      const source = image.data.subarray(
        first, first + layerCount * elementsPerLayer);
      const startedAt = performance.now();
      device.queue.writeTexture(
        { texture: gpuTexture, origin: { x: 0, y: 0, z: layer } },
        source,
        {
          bytesPerRow: width * channels * image.data.BYTES_PER_ELEMENT,
          rowsPerImage: height,
        },
        { width, height, depthOrArrayLayers: layerCount },
      );
      const elapsedMs = performance.now() - startedAt;
      onSlice?.({
        name,
        layer,
        layerCount,
        elapsedMs,
        bytes: source.byteLength,
      });
    }
  }
  return textures;
}

function defaultWorkerFactory() {
  if (typeof Worker === 'undefined') {
    throw new Error('CloudResourceManager: Worker is unavailable');
  }
  return new Worker(new URL('./cloud-field-worker.js', import.meta.url), {
    type: 'module',
    name: 'cloud-field-generation',
  });
}

function descriptorFingerprint(descriptor) {
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.keys(value).sort()
        .map((key) => [key, stable(value[key])]));
    }
    return value;
  };
  return JSON.stringify(stable(descriptor));
}

export class CloudResourceManager {
  constructor({
    renderer = null,
    enabled = true,
    maxEntries = DEFAULT_MAX_ENTRIES,
    workerFactory = defaultWorkerFactory,
    generate = null,
    upload = null,
    uploadDynamic = null,
    scheduleFrame = (callback) => requestAnimationFrame(callback),
  } = {}) {
    this.renderer = renderer;
    this.enabled = !!enabled;
    this.maxEntries = Math.max(1, Math.round(maxEntries));
    this.workerFactory = workerFactory;
    this.generate = generate;
    this.upload = upload;
    this.uploadDynamic = uploadDynamic;
    this.scheduleFrame = scheduleFrame;
    this.entries = new Map();
    this.frame = 0;
    this.nextToken = 1;
    this.disposed = false;
    this.deferredDisposals = [];
    this.stats = {
      generationsStarted: 0,
      generationsCompleted: 0,
      generationsCancelled: 0,
      generationErrors: 0,
      cacheHits: 0,
      uploadSlices: 0,
      uploadBudgetViolations: 0,
      maxUploadSliceMs: 0,
      atomicCommits: 0,
      disposals: 0,
      deviceLosses: 0,
    };
  }

  acquire(key, descriptor = {}) {
    if (!this.enabled || this.disposed) return null;
    const resourceKey = String(key);
    const fingerprint = descriptorFingerprint(descriptor);
    let entry = this.entries.get(resourceKey);
    if (entry && entry.fingerprint !== fingerprint) {
      if (entry.status === 'generating' || entry.status === 'uploading') {
        this._cancelEntry(entry, 'descriptor-changed');
      } else {
        this._disposeEntry(entry, 'descriptor-changed');
      }
      entry = null;
    }
    if (!entry) {
      entry = this._createEntry(resourceKey, descriptor, fingerprint);
      this.entries.set(resourceKey, entry);
      this._start(entry);
    } else {
      this.stats.cacheHits++;
      entry.lastUsedFrame = this.frame;
      entry.releaseFrame = null;
    }

    const leaseId = Symbol(resourceKey);
    entry.leases.add(leaseId);
    let released = false;
    const lease = {
      key: resourceKey,
      token: entry.token,
      promise: entry.promise,
      release: () => {
        if (released) return;
        released = true;
        this._release(entry, leaseId);
      },
      onCommit: (callback) => {
        if (typeof callback !== 'function') return () => {};
        entry.listeners.set(leaseId, callback);
        if (entry.resource?.textures) callback(entry.resource);
        return () => entry.listeners.delete(leaseId);
      },
    };
    return lease;
  }

  _createEntry(key, descriptor, fingerprint) {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    // A cancelled prefetch can legitimately have no awaiter. Keep its
    // rejection from becoming a global unhandledrejection while preserving
    // the rejecting promise for callers that do await it.
    promise.catch(() => {});
    return {
      key,
      descriptor,
      fingerprint,
      token: this.nextToken++,
      status: 'queued',
      promise,
      resolvePromise,
      rejectPromise,
      leases: new Set(),
      listeners: new Map(),
      worker: null,
      cancelled: false,
      resource: null,
      lastUsedFrame: this.frame,
      releaseFrame: null,
    };
  }

  _start(entry) {
    entry.status = 'generating';
    this.stats.generationsStarted++;
    if (this.generate) {
      const cancellation = { cancelled: false };
      entry.worker = { terminate: () => { cancellation.cancelled = true; } };
      Promise.resolve(this.generate(entry.descriptor, cancellation))
        .then((payload) => this._accept(entry, payload))
        .catch((error) => this._fail(entry, error));
      return;
    }

    let worker;
    try {
      worker = this.workerFactory();
    } catch (error) {
      this._fail(entry, error);
      return;
    }
    entry.worker = worker;
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.token !== entry.token || message.key !== entry.key) return;
      if (message.type === 'error') this._fail(entry, new Error(message.error));
      else if (message.type === 'result') this._accept(entry, message.payload);
    };
    worker.onerror = (event) => this._fail(entry,
      new Error(event?.message || 'cloud worker failed'));
    worker.postMessage({
      type: 'generate',
      token: entry.token,
      key: entry.key,
      descriptor: entry.descriptor,
    });
  }

  async _accept(entry, payload) {
    if (!this._isCurrent(entry)) return;
    entry.worker?.terminate?.();
    entry.worker = null;
    try {
      const fields = typeof payload.fields?.terrainMeters === 'function'
        ? payload.fields : hydrateCloudFields(payload.fields);
      const occupancy = typeof payload.occupancy?.voxelAt === 'function'
        ? payload.occupancy : hydrateOccupancyVolume(payload.occupancy, fields);
      entry.status = 'uploading';
      const onSlice = (slice) => {
        this.stats.uploadSlices++;
        this.stats.maxUploadSliceMs = Math.max(
          this.stats.maxUploadSliceMs, slice.elapsedMs || 0);
        if ((slice.elapsedMs || 0) > 4) this.stats.uploadBudgetViolations++;
      };
      const textures = this.upload
        ? await this.upload({ renderer: this.renderer, fields, occupancy, onSlice })
        : await uploadTextures(this.renderer,
          createFieldTextures(fields, occupancy), this.scheduleFrame, onSlice);
      if (!this._isCurrent(entry)) {
        disposeTextures(textures);
        return;
      }
      const cpuBytes = cloudFieldByteLength(fields) + occupancyByteLength(occupancy);
      const resource = {
        key: entry.key,
        token: entry.token,
        fields,
        occupancy,
        textures,
        dynamicSlots: [
          { bands: textures.bands, occupancy: textures.occupancy, hours: fields.hours },
          null,
        ],
        activeDynamicSlot: 0,
        stagedDynamicSlot: null,
        cpuBytes,
        gpuBytes: textureSetBytes(textures),
        generationTimings: payload.timings || null,
        readyFrame: this.frame,
      };
      entry.resource = resource;
      entry.status = 'ready';
      entry.lastUsedFrame = this.frame;
      this.stats.generationsCompleted++;
      entry.resolvePromise(resource);
      this._notify(entry);
      this._evictOverflow();
    } catch (error) {
      this._fail(entry, error);
    }
  }

  _fail(entry, error) {
    if (!this._isCurrent(entry)) return;
    entry.worker?.terminate?.();
    entry.worker = null;
    entry.status = 'failed';
    this.stats.generationErrors++;
    entry.rejectPromise(error instanceof Error ? error : new Error(String(error)));
  }

  _isCurrent(entry) {
    return !this.disposed && !entry.cancelled
      && this.entries.get(entry.key) === entry;
  }

  _release(entry, leaseId) {
    entry.leases.delete(leaseId);
    entry.listeners.delete(leaseId);
    if (entry.leases.size > 0) return;
    if (entry.status === 'generating' || entry.status === 'uploading') {
      this._cancelEntry(entry, 'unreferenced');
      return;
    }
    entry.releaseFrame = this.frame + RELEASE_GRACE_FRAMES;
  }

  _cancelEntry(entry, reason) {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.worker?.terminate?.();
    entry.worker = null;
    this.entries.delete(entry.key);
    this.stats.generationsCancelled++;
    entry.status = 'cancelled';
    entry.rejectPromise(new Error(`cloud generation cancelled: ${reason}`));
  }

  async stageDynamic(key, fields, occupancy, hours = fields?.hours ?? 0) {
    const entry = this.entries.get(String(key));
    if (!entry?.resource?.textures || entry.status !== 'ready') return false;
    const resource = entry.resource;
    const inactive = resource.activeDynamicSlot === 0 ? 1 : 0;
    const onSlice = (slice) => {
      this.stats.uploadSlices++;
      this.stats.maxUploadSliceMs = Math.max(
        this.stats.maxUploadSliceMs, slice.elapsedMs || 0);
      if ((slice.elapsedMs || 0) > 4) this.stats.uploadBudgetViolations++;
    };
    const dynamic = this.uploadDynamic
      ? await this.uploadDynamic({ renderer: this.renderer, fields, occupancy, onSlice })
      : await uploadTextures(this.renderer, createDynamicTextures(fields, occupancy),
        this.scheduleFrame, onSlice);
    if (!this._isCurrent(entry)) {
      disposeTextures(dynamic);
      return false;
    }
    disposeTextures(resource.dynamicSlots[inactive]);
    resource.dynamicSlots[inactive] = { ...dynamic, hours };
    resource.stagedDynamicSlot = inactive;
    return true;
  }

  commitDynamic(key) {
    const entry = this.entries.get(String(key));
    const resource = entry?.resource;
    const slot = resource?.stagedDynamicSlot;
    if (slot == null || !resource.dynamicSlots[slot]) return false;
    const previous = resource.dynamicSlots[resource.activeDynamicSlot];
    const next = resource.dynamicSlots[slot];
    // The two assignments below are the only dynamic ownership handoff. Every
    // material listener is notified after both pointers and the timestamp have
    // advanced, so a frame can never sample new bands with old occupancy.
    resource.textures = {
      ...resource.textures,
      bands: next.bands,
      occupancy: next.occupancy,
    };
    resource.activeDynamicSlot = slot;
    resource.stagedDynamicSlot = null;
    resource.gpuBytes = textureSetBytes(resource.textures)
      + textureSetBytes(previous);
    this.stats.atomicCommits++;
    this._notify(entry);
    this.deferredDisposals.push({
      frame: this.frame + RELEASE_GRACE_FRAMES,
      textures: previous,
      onDispose: () => {
        const oldSlot = slot === 0 ? 1 : 0;
        if (resource.dynamicSlots[oldSlot] === previous) {
          resource.dynamicSlots[oldSlot] = null;
        }
        resource.gpuBytes = textureSetBytes(resource.textures);
      },
    });
    return true;
  }

  _notify(entry) {
    for (const callback of entry.listeners.values()) callback(entry.resource);
  }

  tickFrame() {
    this.frame++;
    for (const entry of [...this.entries.values()]) {
      if (entry.releaseFrame != null && entry.releaseFrame <= this.frame
          && entry.leases.size === 0) {
        this._disposeEntry(entry, 'release-grace-expired');
      }
    }
    const due = this.deferredDisposals.filter((item) => item.frame <= this.frame);
    this.deferredDisposals = this.deferredDisposals
      .filter((item) => item.frame > this.frame);
    for (const item of due) {
      disposeTextures(item.textures);
      item.onDispose?.();
    }
  }

  _evictOverflow() {
    if (this.entries.size <= this.maxEntries) return;
    const candidates = [...this.entries.values()]
      .filter((entry) => entry.leases.size === 0)
      .sort((a, b) => a.lastUsedFrame - b.lastUsedFrame);
    while (this.entries.size > this.maxEntries && candidates.length) {
      this._disposeEntry(candidates.shift(), 'lru');
    }
  }

  _disposeEntry(entry, reason) {
    if (!entry) return;
    entry.cancelled = true;
    entry.worker?.terminate?.();
    entry.worker = null;
    disposeResourceTextures(entry.resource);
    entry.resource = null;
    entry.status = `disposed:${reason}`;
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    this.stats.disposals++;
  }

  handleDeviceLost() {
    this.stats.deviceLosses++;
    for (const entry of this.entries.values()) {
      if (!entry.resource) continue;
      disposeResourceTextures(entry.resource);
      entry.resource.textures = null;
      entry.resource.dynamicSlots = [null, null];
      entry.resource.gpuBytes = 0;
      entry.status = 'cpu-ready-device-lost';
    }
  }

  async restoreDevice(renderer = this.renderer) {
    this.renderer = renderer;
    for (const entry of this.entries.values()) {
      if (!entry.resource || entry.resource.textures) continue;
      const resource = entry.resource;
      resource.textures = await uploadTextures(this.renderer,
        createFieldTextures(resource.fields, resource.occupancy),
        this.scheduleFrame, (slice) => {
          this.stats.uploadSlices++;
          this.stats.maxUploadSliceMs = Math.max(
            this.stats.maxUploadSliceMs, slice.elapsedMs || 0);
          if ((slice.elapsedMs || 0) > 4) this.stats.uploadBudgetViolations++;
        });
      resource.dynamicSlots = [
        {
          bands: resource.textures.bands,
          occupancy: resource.textures.occupancy,
          hours: resource.fields.hours,
        },
        null,
      ];
      resource.activeDynamicSlot = 0;
      resource.gpuBytes = textureSetBytes(resource.textures);
      entry.status = 'ready';
      this._notify(entry);
    }
  }

  telemetry() {
    const entries = [...this.entries.values()].map((entry) => ({
      key: entry.key,
      token: entry.token,
      status: entry.status,
      leases: entry.leases.size,
      cpuBytes: entry.resource?.cpuBytes || 0,
      gpuBytes: entry.resource?.gpuBytes || 0,
      timings: entry.resource?.generationTimings || null,
      readyFrame: entry.resource?.readyFrame ?? null,
      hours: entry.resource?.dynamicSlots?.[entry.resource.activeDynamicSlot]?.hours ?? null,
    }));
    return {
      ...this.stats,
      frame: this.frame,
      entries,
      cpuBytes: entries.reduce((sum, entry) => sum + entry.cpuBytes, 0),
      gpuBytes: entries.reduce((sum, entry) => sum + entry.gpuBytes, 0),
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.entries.values()]) {
      if (entry.status === 'generating' || entry.status === 'uploading') {
        this._cancelEntry(entry, 'manager-disposed');
      } else {
        this._disposeEntry(entry, 'manager-disposed');
      }
    }
    for (const item of this.deferredDisposals) disposeTextures(item.textures);
    this.deferredDisposals.length = 0;
  }
}

let activeManager = null;

export function configureCloudResourceManager(options = {}) {
  activeManager?.dispose();
  activeManager = new CloudResourceManager(options);
  return activeManager;
}

export function getCloudResourceManager() {
  return activeManager;
}

export function disposeCloudResourceManager() {
  activeManager?.dispose();
  activeManager = null;
}
