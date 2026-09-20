// The authored celestial clock advances one world hour per real minute at
// normal speed. Surface dynamics retain real-second wave periods while sharing
// that persisted world clock: reloads, time travel and different observers all
// reconstruct the same ocean phase. Never derive it from a camera or Date.now.
export const OCEAN_SECONDS_PER_WORLD_HOUR = 60;

export function oceanSeconds(worldHours) {
  if (!Number.isFinite(worldHours)) throw new RangeError('Ocean world time must be finite.');
  return worldHours * OCEAN_SECONDS_PER_WORLD_HOUR;
}

// Transient pressure sources cannot survive a saved-clock jump while the
// underlying waves instantly move to a different phase. Small normal frame
// jitter is tolerated; fast-forward and backwards travel invalidate history.
export function oceanClockJumped(previousSeconds, currentSeconds, frameSeconds) {
  if (previousSeconds === null) return false;
  const elapsed = currentSeconds - previousSeconds;
  return elapsed < -1e-5 || elapsed > Math.max(0.25, Math.max(0, frameSeconds) * 3);
}
