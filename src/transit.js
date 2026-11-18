// Transit choreography shared by the local pulse and the interstellar warp.
//
// Every visible and audible part of a transit (starflow streak length,
// relativistic aberration, the 3D conduit, FOV, camera kick, hull light)
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
    warp: 0, // conduit flow 0..1 (warp and throat)
    conduitEnter: 0, // conduit formation front 0..1
    conduitExit: 0, // conduit opening front 0..1
    speed: 0, // conduit visual speed, fraction of peak
    accel: 0, // normalised acceleration of the flow
    charge: 0, // warp spool charge
    sky: 1, // visibility of the real sky starfield
  };
}

// ---------------------------------------------------------------------------
// Pulse: a miniature fold. Charge, jump, release in ~1.15 s. Almost all of the
// displacement happens inside the ~0.12 s window where the starflow is longest
// and space is most compressed, so the player reads a skip, not a sprint.
//
// Holding the key parks the timeline at `hold` (just before the jump) while
// the charge builds; releasing continues from there with a longer reach and a
// proportionally stronger fold.
export const PULSE_TIMING = Object.freeze({
  charge: 0.20,
  hold: 0.15,
  jumpStart: 0.16,
  jumpEnd: 0.40,
  retrigger: 0.40,
  total: 1.15,
  tapWindow: 0.18, // a press shorter than this is a plain tap
  fullCharge: 1.6, // seconds of holding (after the tap window) to full charge
});

// Charge 0..1 from how long the key has been held.
export function pulseChargeFromHold(holdSeconds) {
  return clamp01((holdSeconds - PULSE_TIMING.tapWindow) / PULSE_TIMING.fullCharge);
}

// Reach and fuel both grow with charge; a full charge folds 8x the tap reach
// for 2.5x the fuel.
export function pulseChargeScaling(charge) {
  const k = clamp01(charge);
  return {
    distance: 1 + 7 * Math.pow(k, 1.4),
    fuel: 1 + 1.5 * k,
    power: 1 + 0.55 * k,
  };
}

export function pulseDisplacement(t) {
  return smootherstep(PULSE_TIMING.jumpStart, PULSE_TIMING.jumpEnd, t);
}

// options: power (>=1, released charge), charge (0..1 while holding),
// holdTime (seconds held, drives the charging breath).
export function pulseChannels(t, out = emptyTransitChannels(), { power = 1, charge = 0, holdTime = 0 } = {}) {
  if (t < 0 || t >= PULSE_TIMING.total) return out;
  const p = Math.max(1, power);
  const ramp = smoothstep(0, PULSE_TIMING.charge, t);
  const breath = charge > 0 ? 0.5 + 0.5 * Math.sin(holdTime * 7.5) : 0;
  const streak = Math.max(0.3 * ramp + 0.32 * charge, smoothstep(0.17, 0.27, t)) * (1 - smoothstep(0.30, 0.80, t));
  out.streak = Math.max(out.streak, Math.min(1, streak * (0.85 + 0.15 * p)));
  out.aberr += (0.13 * ramp * (1 - smoothstep(0.30, 0.48, t))
    + 0.40 * envelope(t, 0.18, 0.28, 0.30, 0.46)) * p
    + 0.2 * charge
    - 0.085 * envelope(t, 0.38, 0.52, 0.58, 0.98) * p;
  out.doppler = Math.max(out.doppler, 0.55 * envelope(t, 0.14, 0.26, 0.32, 0.62) * p + 0.4 * charge);
  out.fold = Math.max(out.fold,
    (0.34 * ramp * (1 - smoothstep(0.26, 0.40, t)) + 0.66 * envelope(t, 0.18, 0.27, 0.29, 0.42)) * p
    + charge * (0.28 + 0.06 * breath));
  out.blur = Math.max(out.blur, Math.min(1, 0.85 * envelope(t, 0.15, 0.25, 0.31, 0.55) * p) + 0.25 * charge);
  if (t > 0.33) {
    const amp = envelope(t, 0.33, 0.40, 0.52, 1.08) * p;
    if (amp >= out.shockAmp) {
      out.shockAmp = amp;
      out.shockRadius = (t - 0.33) / 0.72 * 1.55;
    }
  }
  out.flash = Math.max(out.flash, 0.32 * envelope(t, 0.23, 0.29, 0.31, 0.46) * p);
  out.fov += (-3.2 * envelope(t, 0, 0.17, 0.19, 0.27)
    + 14.5 * envelope(t, 0.19, 0.29, 0.33, 0.72)
    - 2.2 * envelope(t, 0.56, 0.72, 0.80, 1.12)) * p
    - 4.5 * charge * (0.9 + 0.1 * breath);
  out.kick += transitKick(t, 0.25) * p;
  out.hull = Math.max(out.hull, 0.9 * envelope(t, 0.18, 0.28, 0.32, 0.7) * p + 0.7 * charge * (0.8 + 0.2 * breath));
  return out;
}

// ---------------------------------------------------------------------------
// Warp: one shot driven by a single flow scalar w(u) over normalised time u.
//   spool     0    – .085  charge: space pinches, the lens tightens
//   accelerate .085 – .16   near-field stars start to streak past
//   enter     .16  – .33   a formation front sweeps from the far end back over
//                           the ship; streaks are bent onto the conduit and
//                           become its filaments (see warp-conduit.js)
//   covered   .33  – .66   inside the conduit; the universe is swapped here
//   exit      .66  – .82   an opening front sweeps the same way; the
//                           destination appears through the dissolving mouth
//   arrive    .82  – 1     streaks shorten back to points while braking
// Visual travel is the integral of the speed curve, pre-computed into a
// table, so streak flow, the departure drift and the arrival approach all
// follow the same speed.
export const WARP_MARKS = Object.freeze({
  spoolEnd: 0.085, enterStart: 0.16, enterEnd: 0.33, decelStart: 0.62,
  exitStart: 0.66, exitEnd: 0.82, decelEnd: 0.94,
});
const WARP_SAMPLES = 1024;
const WARP_SPEED_K = 4.2;

export function warpFlow(u) {
  if (u <= 0 || u >= 1) return 0;
  const rise = Math.pow(smoothstep(0.02, 0.31, u), 1.7);
  const fall = 1 - smoothstep(WARP_MARKS.decelStart, WARP_MARKS.decelEnd, u);
  return Math.min(rise, fall);
}

// Visual speed as a fraction of peak: exponential in w, so the last stretch
// of acceleration is violent and the first stretch of braking is decisive.
export function warpSpeedFraction(w, cruise = 0.0015) {
  return cruise + (1 - cruise) * (Math.exp(WARP_SPEED_K * w) - 1) / (Math.exp(WARP_SPEED_K) - 1);
}

export function warpPlan(distance = 0) {
  const duration = 14.8 + Math.min(4, Math.log10(Math.max(distance, 1e10) / 1e10) * 1.3);
  const travel = new Float64Array(WARP_SAMPLES + 1);
  const accel = new Float32Array(WARP_SAMPLES + 1);
  // travel speed: the flow curve, settling to exactly zero at the end so
  // the arrival approach comes to rest on the framing
  const travelSpeed = (u) => warpSpeedFraction(warpFlow(u)) * (1 - smoothstep(WARP_MARKS.decelEnd, 1, u));
  let acc = 0, prev = travelSpeed(0), maxA = 1e-9;
  for (let i = 1; i <= WARP_SAMPLES; i++) {
    const v = travelSpeed(i / WARP_SAMPLES);
    acc += 0.5 * (v + prev) * duration / WARP_SAMPLES;
    travel[i] = acc;
    accel[i] = (v - prev) * WARP_SAMPLES / duration;
    maxA = Math.max(maxA, Math.abs(accel[i]));
    prev = v;
  }
  accel[0] = accel[1];
  for (let i = 0; i <= WARP_SAMPLES; i++) accel[i] /= maxA;
  const m = WARP_MARKS;
  return {
    duration, total: duration, travel, accel,
    spool: duration * m.enterStart,
    entryStart: duration * m.enterStart,
    tunnelStart: duration * m.enterEnd,
    exitStart: duration * m.exitStart,
    arrivalStart: duration * m.exitEnd,
    // the universe is swapped in the middle of the fully covered window
    swapAt: duration * (m.enterEnd + 0.4 * (m.exitStart - m.enterEnd)),
  };
}

function sampleTable(table, u) {
  const x = clamp01(u) * WARP_SAMPLES;
  const i = Math.min(WARP_SAMPLES - 1, Math.floor(x));
  const f = x - i;
  return table[i] * (1 - f) + table[i + 1] * f;
}

// Fraction of the final approach distance still ahead (1 at the opening,
// exactly 0 at the end), following the same speed curve as the streaks.
export function warpApproachRemaining(t, plan) {
  const u = clamp01(t / plan.duration);
  const start = sampleTable(plan.travel, WARP_MARKS.exitStart);
  const end = plan.travel[WARP_SAMPLES];
  if (u <= WARP_MARKS.exitStart) return 1;
  return Math.max(0, (end - sampleTable(plan.travel, u)) / Math.max(end - start, 1e-9));
}

// Departure drift before the ship is enclosed, as a fraction of the spool
// distance at full enclosure (continues smoothly to the swap).
export function warpDepartureTravel(t, plan) {
  const u = clamp01(t / plan.duration);
  return sampleTable(plan.travel, u) / Math.max(sampleTable(plan.travel, WARP_MARKS.enterEnd), 1e-9);
}

export function warpChannels(t, plan, out = emptyTransitChannels()) {
  if (t < 0 || t > plan.duration) return out;
  const m = WARP_MARKS;
  const u = clamp01(t / plan.duration);
  const w = warpFlow(u);
  const enter = smoothstep(m.enterStart, m.enterEnd, u);
  const exit = smoothstep(m.exitStart, m.exitEnd, u);
  const charge = u <= 0 || u >= 1 ? 0 : smoothstep(0, 0.075, u) * (1 - smoothstep(0.11, 0.26, u));
  const accel = u < 1 ? sampleTable(plan.accel, u) : 0;
  const coverage = Math.min(enter, 1 - exit);
  out.warp = w;
  out.conduitEnter = enter;
  out.conduitExit = exit;
  out.speed = warpSpeedFraction(w);
  out.accel = accel;
  out.charge = charge;
  out.tunnel = coverage;
  // Keep the same stars in view until the wall overtakes them. On exit
  // the central opening reveals the sky before the near banks fall away.
  out.sky = Math.max(1 - smoothstep(0.14, 0.92, enter), smoothstep(0, .30, exit));
  const entrySurge = envelope(u, .09, .18, .21, .29);
  const exitSurge = envelope(u, .68, .75, .78, .86);
  out.streak = Math.min(1, (.82 * Math.sqrt(w) + .12 * charge) * out.sky + .42 * Math.max(entrySurge, exitSurge) * out.sky);
  out.aberr = 0.22 * w * out.sky + 0.08 * charge;
  out.doppler = (.5 * w + .28 * Math.max(entrySurge, exitSurge)) * out.sky;
  out.blur = Math.min(1, w * (0.25 + 0.45 * Math.max(accel, 0)));
  out.fold = 3 * (0.035 * charge + 0.02 * Math.max(accel, 0)) * (1 - enter);
  out.colorMix = smoothstep(m.enterEnd, m.exitStart, u);
  // lens: tightens while charging, opens with the flow, punches with accel
  out.fov = 62 * (-0.045 * charge * (1 - w) + 0.19 * w + 0.07 * accel);
  out.kick += 0.85 * accel - 0.25 * charge * (1 - w);
  out.flash = Math.max(out.flash, .30 * envelope(u, .21, .255, .26, .315), .36 * envelope(u, .70, .75, .76, .81));
  out.hull = Math.max(out.hull, 0.25 * charge + 0.75 * smoothstep(0.15, 1, w));
  return out;
}

export function transitIntensity(channels) {
  return clamp01(Math.max(channels.streak, channels.tunnel, channels.fold));
}
