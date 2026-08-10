// Off-main-thread cloud-field generation. One worker owns one generation so
// cancellation is real: the resource manager terminates this worker instead
// of waiting for a 5+ second synchronous bake to finish and merely discarding
// its result.

import {
  cloudFieldTransferables, createCloudFields, serializeCloudFields,
} from './cloud-density.js';
import {
  buildOccupancyVolume, occupancyTransferables, serializeOccupancyVolume,
} from './cloud-occupancy.js';
import { createWeatherSystem } from './weather-system.js';

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== 'generate') return;
  const startedAt = performance.now();
  try {
    const descriptor = message.descriptor || {};
    const weatherStartedAt = performance.now();
    const system = createWeatherSystem(descriptor.seed, descriptor.weatherOptions || {});
    const weatherMs = performance.now() - weatherStartedAt;
    const fieldsStartedAt = performance.now();
    const fields = createCloudFields(system, descriptor.fieldOptions || {});
    const fieldsMs = performance.now() - fieldsStartedAt;
    const occupancyStartedAt = performance.now();
    const occupancy = buildOccupancyVolume(fields, descriptor.occupancyOptions || {});
    const occupancyMs = performance.now() - occupancyStartedAt;
    const payload = {
      fields: serializeCloudFields(fields),
      occupancy: serializeOccupancyVolume(occupancy),
      timings: {
        weatherMs,
        fieldsMs,
        occupancyMs,
        totalMs: performance.now() - startedAt,
      },
    };
    self.postMessage({
      type: 'result',
      token: message.token,
      key: message.key,
      payload,
    }, [
      ...cloudFieldTransferables(fields),
      ...occupancyTransferables(occupancy),
    ]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      token: message.token,
      key: message.key,
      error: String(error?.stack || error),
    });
  }
};
