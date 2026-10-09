// Cache snapshots retain revision tokens, not the worker's raw frame arrays.
// Only the frames actually sampled belong to this cache's dependency set.
export function captureWeatherSources(stream, hours) {
  return { stream, frames: hours.map(hour => ({ hours: hour, revision: stream.revisionAt(hour) })) };
}

export function weatherSourcesCurrent(sources, stream) {
  return Boolean(sources && stream && !stream.disposed && sources.stream === stream
    && sources.frames.every(({ hours, revision }) => revision !== null && stream.revisionAt(hours) === revision));
}
