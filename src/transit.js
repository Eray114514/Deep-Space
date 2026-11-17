// Transit choreography shared by the local pulse and the interstellar warp.
//
// Every visible and audible part of a transit (starflow streak length,
// relativistic aberration, the post-pass tunnel, FOV, camera kick, hull light)
// reads one continuous timeline. Phases therefore hand over by changing the
// same parameters, never by fading one effect out while another one appears.
// Everything here is pure so the choreography is testable in Node.

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const smootherstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Rise over [a, b], hold, fall over [c, d].
const envelope = (t, a, b, c, d) => smoothstep(a, b, t) * (1 - smoothstep(c, d, t));

// One low-frequency, critically damped-looking push: the camera is shoved back
// once and settles. Never a sustained high-frequency shake.
export function transitKick(t, start, { decay = 5.2, frequency = 1.45 } = {}) {
  const x = t - start;
  if (x <= 0) return 0;
  return Math.exp(-x * decay) * Math.sin(x * Math.PI * 2 * frequency);
}

export function emptyTransitChannels() {
  return {
    streak: 0, // starflow streak length (0 = points)
    aberr: 0, // relativistic aberration β (-: spread, +: gather forward)
    doppler: 0, // colour shift of the gathered stars
    blur: 0, // radial motion blur of the rendered scene
    fold: 0, // pulse: space pinched toward the vanishing point
    shockRadius: 0, // pulse: refractive ring radius (screen heights)
    shockAmp: 0,
    flash: 0, // brief exposure lift at the vanishing point
    tunnel: 0, // tunnel wall density / opacity
    mouth: 1e4, // tunnel start depth (tunnel radii); large = not reached
    exit: 1e4, // tunnel end depth; large = no exit in sight
    endGlow: 0, // the exit light at the vanishing point
    flowSpeed: 0, // tunnel radii per second
    colorMix: 0, // source star colour -> destination star colour
    fov: 0, // degrees added to the base field of view
    kick: 0, // camera push along its local +Z, in units of the shot's kick scale
    hull: 0, // transit light on the hull
  };
}

// ---------------------------------------------------------------------------
// Pulse: a miniature fold. Charge, jump, release in ~1.15 s. Almost all of the
// displacement happens inside the ~0.12 s window where the starflow is longest
// and space is most compressed, so the player reads a skip, not a sprint.
export const PULSE_TIMING = Object.freeze({
  charge: 0.20,
  jumpStart: 0.16,
  jumpEnd: 0.40,
  retrigger: 0.40,
  total: 1.15,
});

export function pulseDisplacement(t) {
  return smootherstep(PULSE_TIMING.jumpStart, PULSE_TIMING.jumpEnd, t);
}

export function pulseChannels(t, out = emptyTransitChannels()) {
  if (t < 0 || t >= PULSE_TIMING.total) return out;
  const charge = smoothstep(0, PULSE_TIMING.charge, t);
  out.streak = Math.max(out.streak,
    Math.max(0.3 * charge, smoothstep(0.17, 0.27, t)) * (1 - smoothstep(0.30, 0.80, t)));
  out.aberr += 0.13 * charge * (1 - smoothstep(0.30, 0.48, t))
    + 0.40 * envelope(t, 0.18, 0.28, 0.30, 0.46)
    - 0.085 * envelope(t, 0.38, 0.52, 0.58, 0.98);
  out.doppler = Math.max(out.doppler, 0.55 * envelope(t, 0.14, 0.26, 0.32, 0.62));
  out.fold = Math.max(out.fold,
    0.34 * charge * (1 - smoothstep(0.26, 0.40, t)) + 0.66 * envelope(t, 0.18, 0.27, 0.29, 0.42));
  out.blur = Math.max(out.blur, 0.85 * envelope(t, 0.15, 0.25, 0.31, 0.55));
  if (t > 0.33) {
    const amp = envelope(t, 0.33, 0.40, 0.52, 1.08);
    if (amp >= out.shockAmp) {
      out.shockAmp = amp;
      out.shockRadius = (t - 0.33) / 0.72 * 1.55;
    }
  }
  out.flash = Math.max(out.flash, 0.32 * envelope(t, 0.23, 0.29, 0.31, 0.46));
  out.fov += -3.2 * envelope(t, 0, 0.17, 0.19, 0.27)
    + 14.5 * envelope(t, 0.19, 0.29, 0.33, 0.72)
    - 2.2 * envelope(t, 0.56, 0.72, 0.80, 1.12);
  out.kick += transitKick(t, 0.25);
  out.hull = Math.max(out.hull, 0.9 * envelope(t, 0.18, 0.28, 0.32, 0.7));
  return out;
}

// ---------------------------------------------------------------------------
// Warp: five phases whose exit state is the next phase's entry state.
//   A  spool    stars streak and gather forward, FOV opens
//   B  entry    streak field thickens into the tunnel wall; mouth sweeps out
//   C  tunnel   long curving passage; the universe is swapped out of sight
//   D  exit     the end light opens from the centre; wall breaks back to streaks
//   E  arrival  streaks retract while the camera brakes onto the destination
export function warpPlan(distance = 0) {
  // Interstellar distances are 1e11..1e14 m; give long hauls a longer tunnel.
  const tunnel = Math.max(4, Math.min(8, 3.4 + Math.log10(Math.max(distance, 1e10) / 1e10) * 1.4));
  const plan = { spool: 3.0, entry: 1.25, tunnel, exit: 1.2, arrival: 3.2 };
  plan.entryStart = plan.spool;
  plan.tunnelStart = plan.entryStart + plan.entry;
  plan.exitStart = plan.tunnelStart + plan.tunnel;
  plan.arrivalStart = plan.exitStart + plan.exit;
  plan.total = plan.arrivalStart + plan.arrival;
  // The destination is adopted half a second into the opaque tunnel.
  plan.swapAt = plan.tunnelStart + 0.5;
  return plan;
}

// Remaining fraction of the final approach distance, over exit + arrival.
// Velocity is continuous and reaches exactly zero at the authored framing.
export function warpApproachRemaining(t, plan) {
  const span = plan.exit + plan.arrival;
  const u = clamp01((t - plan.exitStart) / span);
  return Math.pow(1 - u, 3.2);
}

// Pre-tunnel travel, as a fraction of the spool distance (cubic, continues
// smoothly through the entry until the swap).
export function warpDepartureTravel(t, plan) {
  const u = Math.max(0, t) / plan.spool;
  return u * u * u;
}

export function warpChannels(t, plan, out = emptyTransitChannels()) {
  if (t < 0 || t > plan.total) return out;
  const { entryStart: B, tunnelStart: C, exitStart: D, arrivalStart: E } = plan;
  if (t < B) {
    const u = t / plan.spool;
    out.streak = 0.82 * Math.pow(u, 1.7);
    out.aberr = 0.30 * u * u;
    out.doppler = 0.6 * u * u;
    out.blur = 0.55 * u * u;
    out.fov = -3 * envelope(t, 0.15, 0.7, 0.9, 1.6) + 16 * Math.pow(smoothstep(0.6, B, t), 1.35);
    out.flowSpeed = 6;
    out.hull = 0.25 * u * u;
  } else if (t < C) {
    const u = (t - B) / plan.entry;
    const s = smoothstep(0, 1, u);
    out.streak = 0.82 + 0.18 * s;
    out.aberr = 0.30 + 0.58 * s;
    out.doppler = 0.6 + 0.4 * s;
    out.blur = 0.55 + 0.3 * s;
    out.tunnel = smoothstep(0.0, 0.5, u);
    out.mouth = 70 * Math.pow(1 - u, 2.3);
    out.endGlow = 0.6 * s;
    out.flowSpeed = 6 + 34 * s;
    out.fov = 16 + 6 * s;
    out.flash = 0.22 * envelope(t, C - 0.24, C - 0.1, C - 0.06, C + 0.25);
    out.hull = 0.25 + 0.75 * s;
  } else if (t < D) {
    const u = (t - C) / plan.tunnel;
    out.streak = 1;
    out.aberr = 0.88;
    out.doppler = 1;
    out.blur = 0.85;
    out.tunnel = 1;
    out.mouth = 0;
    out.endGlow = 0.6 + 0.4 * smoothstep(0, 1, u);
    out.flowSpeed = 40;
    out.colorMix = smoothstep(0.15, 0.85, u);
    out.fov = 22 - 2 * smoothstep(0, 0.3, u) + Math.sin(u * Math.PI * 2) * 0.8;
    out.flash = 0.22 * envelope(t, C - 0.24, C - 0.1, C - 0.06, C + 0.25);
    out.hull = 1;
  } else if (t < E) {
    const u = (t - D) / plan.exit;
    const s = smoothstep(0, 1, u);
    out.streak = 1 - 0.2 * s;
    out.aberr = 0.88 - 0.43 * s;
    out.doppler = 1 - 0.4 * s;
    out.blur = 0.85 - 0.25 * s;
    // The exit opens through the hole, never by thinning the wall.
    out.tunnel = 1 - smoothstep(0.78, 1, u);
    out.mouth = 0;
    out.exit = 90 * Math.pow(1 - u, 2.2);
    // Flares as the opening sweeps past, then hands the frame to the real sky.
    out.endGlow = (1 + 1.1 * envelope(u, 0, 0.35, 0.55, 1)) * (1 - smoothstep(0.5, 1, u));
    out.flowSpeed = 40 - 20 * s;
    out.colorMix = 1;
    out.fov = 20 - 8 * s;
    out.hull = 1 - 0.6 * s;
  } else {
    const u = (t - E) / plan.arrival;
    const fall = (1 - u) * (1 - u);
    out.streak = 0.8 * fall;
    out.aberr = 0.45 * fall;
    out.doppler = 0.6 * fall;
    out.blur = 0.6 * fall;
    out.colorMix = 1;
    out.fov = 12 * (1 - smoothstep(0, 0.55, u)) - 3 * envelope(u, 0.35, 0.6, 0.7, 1);
    out.hull = 0.4 * fall;
  }
  out.kick += transitKick(t, C - 0.12, { decay: 3.6, frequency: 1.1 }) * 1.2
    + transitKick(t, D + 0.25, { decay: 4.5, frequency: 1.3 }) * 0.45;
  return out;
}

export function transitIntensity(channels) {
  return clamp01(Math.max(channels.streak, channels.tunnel, channels.fold));
}
