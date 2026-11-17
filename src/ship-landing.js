// Seamless ship landing, tripod terrain-conforming pad solver, atmospheric
// hover + HALO jump entry, out-of-sight cinematic recall fly-in (landed or
// steep-slope Hot Extraction hover), and seated liftoff trajectories.
//
// Coordinates:
//   - Planet-local space: origin at planet center, rotates with frameOrientation.
//   - Ship-local space: y = 0 is cabin deck, -Z = nose, +Z = aft, +Y = dorsal.
//   - Physical landing gear pads (tools/blender/halcyon/exterior_detail.py):
//     nose (0, -1.60, -9.30), stbd (+2.45, -1.60, +3.60), port (-2.45, -1.60, +3.60).

import * as THREE from 'three';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export const GEAR_GROUND_Y = -1.60;
export const MAX_LANDING_SLOPE_DEG = 15.5;
const MAX_LANDING_SLOPE_RAD = (MAX_LANDING_SLOPE_DEG * Math.PI) / 180;

// Exact (x, z) positions of the 3 landing gear footpads in ship-local space,
// matching the ['gear-nose', 'gear-main-stbd', 'gear-main-port'] array order.
export const GEAR_PADS = Object.freeze([
  Object.freeze([0.0, -9.30]),
  Object.freeze([2.45, 3.60]),
  Object.freeze([-2.45, 3.60]),
]);

// Hull underbody, chine, nose sensor, nacelle and wingtip clearance checkpoints:
// [localX, minSafeLocalY, localZ]. Using real mesh heights (instead of -1.60
// everywhere) prevents elevated wingtips from falsely lifting the landing gear
// off sloped ground while still preventing any part of the hull from clipping.
const HULL_CLEARANCE_POINTS = Object.freeze([
  [0.0, -0.98, -6.5],
  [0.0, -1.03, -2.0],
  [0.0, -1.03, 1.5],
  [2.5, -0.92, -1.5],
  [-2.5, -0.92, -1.5],
  [3.2, -0.88, 2.8],
  [-3.2, -0.88, 2.8],
  [0.0, -0.58, 5.4],
  [0.0, -1.18, -12.6], // ventral sensor ball
  [0.0, -0.26, -15.3], // nose cone
  [3.6, -0.48, 6.2],   // stbd nacelle belly
  [-3.6, -0.48, 6.2],  // port nacelle belly
  [3.6, -0.22, 10.9],  // stbd nozzle lip
  [-3.6, -0.22, 10.9], // port nozzle lip
  [7.2, 0.12, 6.5],    // mid wing
  [-7.2, 0.12, 6.5],
  [10.6, 0.24, 8.6],   // wingtip rail
  [-10.6, 0.24, 8.6],
]);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _pNose = new THREE.Vector3();
const _pStbd = new THREE.Vector3();
const _pPort = new THREE.Vector3();
const _mainMid = new THREE.Vector3();
const _planeFwd = new THREE.Vector3();
const _planeRight = new THREE.Vector3();
const _planeUp = new THREE.Vector3();
const _planeBack = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function lerp(a, b, t) { return a + (b - a) * t; }

function smoothstep(x, e0, e1) {
  const t = clamp((x - e0) / Math.max(1e-6, e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

function smootherstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function cubicBezier1D(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return u * u * u * p0
    + 3 * u * u * t * p1
    + 3 * u * t * t * p2
    + t * t * t * p3;
}

function tangentBasis(up, e1, e2) {
  if (Math.abs(up.y) < 0.93) e1.set(up.z, 0, -up.x).normalize();
  else e1.set(0, -up.z, up.y).normalize();
  e2.crossVectors(up, e1).normalize();
}

function sampleSurfacePoint(planet, baseCenter, quat, lx, lz, out) {
  _v1.set(lx, 0, lz).applyQuaternion(quat).add(baseCenter);
  const len = _v1.length();
  out.copy(_v1).multiplyScalar(1 / Math.max(len, 1));
  const r = planet.surfaceRadius(out);
  return out.multiplyScalar(r);
}

/**
 * Evaluate whether the 3 physical landing-gear pads can set down cleanly at
 * `candDir` facing `fwdHint`, fitting the exact tripod plane and solving
 * per-leg oleo-strut offsets so zero pads float in mid-air.
 */
export function evaluateTripodPad(planet, candDir, fwdHint, {
  horizonQuat,
  allowSubmerged = false,
  maxSlopeRad = MAX_LANDING_SLOPE_RAD,
  rampExitZ = 9.45,
}) {
  const centerH = planet.height(candDir, planet.fullMaxFreq);
  if (!allowSubmerged && planet.hasLiquid && centerH < planet.seaLevel + 0.8) {
    return null;
  }

  const fwdH = _v2.copy(fwdHint).addScaledVector(candDir, -fwdHint.dot(candDir));
  if (fwdH.lengthSq() < 1e-5) tangentBasis(candDir, fwdH, _v3);
  else fwdH.normalize();

  const levelQuat = horizonQuat(candDir, fwdH, _q1);
  const baseCenter = _v4.copy(candDir).multiplyScalar(planet.R + centerH);

  // 1. Sample exact planet-local 3D surface positions under the 3 gear pads.
  sampleSurfacePoint(planet, baseCenter, levelQuat, GEAR_PADS[0][0], GEAR_PADS[0][1], _pNose);
  sampleSurfacePoint(planet, baseCenter, levelQuat, GEAR_PADS[1][0], GEAR_PADS[1][1], _pStbd);
  sampleSurfacePoint(planet, baseCenter, levelQuat, GEAR_PADS[2][0], GEAR_PADS[2][1], _pPort);

  if (!allowSubmerged && planet.hasLiquid) {
    const minSeaR = planet.seaRadius + 0.55;
    if (_pNose.length() < minSeaR || _pStbd.length() < minSeaR || _pPort.length() < minSeaR) {
      return null;
    }
  }

  // 2. Fit exact plane through the 3 gear pads: +X = stbd - port, -Z = nose - mainMid.
  _mainMid.copy(_pStbd).add(_pPort).multiplyScalar(0.5);
  _planeFwd.copy(_pNose).sub(_mainMid);
  _planeRight.copy(_pStbd).sub(_pPort);
  if (_planeFwd.lengthSq() < 1 || _planeRight.lengthSq() < 1) return null;
  _planeFwd.normalize();
  _planeRight.normalize();

  // Right-hand basis: (+X) × (-Z) = +Y (upward tripod normal).
  _planeUp.crossVectors(_planeRight, _planeFwd);
  if (_planeUp.lengthSq() < 1e-5) return null;
  _planeUp.normalize();
  if (_planeUp.dot(candDir) < 0) _planeUp.negate();

  const slopeRad = Math.acos(clamp(_planeUp.dot(candDir), -1, 1));
  if (slopeRad > maxSlopeRad) return null;

  // Orthonormalize ship frame on the tripod plane.
  _planeRight.crossVectors(_planeFwd, _planeUp).normalize();
  _planeBack.crossVectors(_planeRight, _planeUp).normalize();
  _m1.makeBasis(_planeRight, _planeUp, _planeBack);
  const parkedLocalQuat = new THREE.Quaternion().setFromRotationMatrix(_m1);

  // Place ship origin so main-gear midpoint (0, GEAR_GROUND_Y, 3.60) sits right on _mainMid.
  const padLocal = _mainMid.clone().sub(
    _v1.set(0, GEAR_GROUND_Y, 3.60).applyQuaternion(parkedLocalQuat),
  );

  // 3. Check hull belly, nose, nacelles & wingtips against actual terrain.
  let maxIntrusion = 0;
  for (let i = 0; i < HULL_CLEARANCE_POINTS.length; i++) {
    const [lx, minY, lz] = HULL_CLEARANCE_POINTS[i];
    _v1.set(lx, minY, lz).applyQuaternion(parkedLocalQuat).add(padLocal);
    const ptR = _v1.length();
    _v2.copy(_v1).multiplyScalar(1 / Math.max(ptR, 1));
    const groundR = planet.surfaceRadius(_v2);
    const intrusion = groundR - ptR;
    if (intrusion > maxIntrusion) maxIntrusion = intrusion;
  }
  // Up to 0.24 m of convex micro-bump under the belly can be absorbed by
  // extending the 3 telescopic gear pistons; larger rocks reject the pad.
  if (maxIntrusion > 0.24) return null;
  if (maxIntrusion > 0) {
    padLocal.addScaledVector(_planeUp, maxIntrusion + 0.02);
  }

  // 4. Check rear cargo ramp exit ground (neither a sheer wall nor a cliff drop).
  _v1.set(0, GEAR_GROUND_Y, rampExitZ).applyQuaternion(parkedLocalQuat).add(padLocal);
  const rampRefR = _v1.length();
  _v2.copy(_v1).multiplyScalar(1 / Math.max(rampRefR, 1));
  const rampGroundR = planet.surfaceRadius(_v2);
  if (!allowSubmerged && planet.hasLiquid && rampGroundR < planet.seaRadius + 0.4) {
    return null;
  }
  const rampDelta = rampGroundR - rampRefR; // + means ground rises above -1.60, - means drops below
  if (rampDelta > 1.05 || rampDelta < -1.85) return null;

  // 5. Solve exact per-leg telescopic piston offsets (in local +Y along each leg)
  // so every circular footpad rests 100% flush on the terrain underneath it.
  const gearOffsets = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const [px, pz] = GEAR_PADS[i];
    _v1.set(px, GEAR_GROUND_Y, pz).applyQuaternion(parkedLocalQuat).add(padLocal);
    const nominalR = _v1.length();
    _v2.copy(_v1).multiplyScalar(1 / Math.max(nominalR, 1));
    const actualGroundR = planet.surfaceRadius(_v2);
    gearOffsets[i] = clamp(actualGroundR - nominalR, -0.36, 0.24);
  }

  const slopeDeg = (slopeRad * 180) / Math.PI;
  const padUniv = planet.localPositionToWorld(padLocal, new THREE.Vector3());
  const parkedWorldQuat = planet.frameOrientation.clone().multiply(parkedLocalQuat);

  return {
    landable: true,
    padLocal,
    padUniv,
    parkedLocalQuat,
    parkedWorldQuat,
    gearOffsets,
    slopeDeg,
    rampDelta: Math.abs(rampDelta),
    bumpLift: Math.max(0, maxIntrusion),
  };
}

/**
 * Search ahead of (and around) the ship for a valid tripod landing pad.
 * When terrain is too steep or rugged (`> 15.5°` or rocky), returns
 * `landable: false` so the flight computer offers Hover + Skydive instead!
 */
export function findLandingSite(planet, shipStartLocal, shipStartLocalQuat, {
  horizonQuat,
  allowSubmerged = false,
  forceFallback = false,
}) {
  const startR = shipStartLocal.length();
  const startDir = shipStartLocal.clone().multiplyScalar(1 / Math.max(startR, 1));
  const startGround = planet.surfaceRadius(startDir);
  const startAlt = Math.max(0, startR - startGround);

  const forwardH = new THREE.Vector3(0, 0, -1).applyQuaternion(shipStartLocalQuat);
  forwardH.addScaledVector(startDir, -forwardH.dot(startDir));
  if (forwardH.lengthSq() < 1e-4) tangentBasis(startDir, forwardH, _v1);
  else forwardH.normalize();

  const leadMeters = clamp(startAlt * 0.26, 0, 38);
  const aimDir = startDir.clone().addScaledVector(forwardH, leadMeters / planet.R).normalize();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  tangentBasis(aimDir, e1, e2);

  const cand = new THREE.Vector3();
  const candFwd = new THREE.Vector3();
  const maxSlopeRad = allowSubmerged ? (24 * Math.PI) / 180 : MAX_LANDING_SLOPE_RAD;

  let best = null;
  let bestScore = Infinity;

  for (const rad of [0, 12, 22, 32]) {
    const samples = rad === 0 ? 1 : 12;
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * Math.PI * 2;
      cand.copy(aimDir)
        .addScaledVector(e1, (Math.cos(a) * rad) / planet.R)
        .addScaledVector(e2, (Math.sin(a) * rad) / planet.R)
        .normalize();

      for (const yawOffset of [0, 0.38, -0.38]) {
        candFwd.copy(forwardH).addScaledVector(cand, -forwardH.dot(cand));
        if (candFwd.lengthSq() < 1e-4) tangentBasis(cand, candFwd, _v1);
        else candFwd.normalize();
        if (yawOffset !== 0) {
          candFwd.applyQuaternion(_q2.setFromAxisAngle(cand, yawOffset)).normalize();
        }
        const evalRes = evaluateTripodPad(planet, cand, candFwd, {
          horizonQuat,
          allowSubmerged,
          maxSlopeRad,
        });
        if (!evalRes) continue;
        const score = evalRes.slopeDeg * 0.14
          + rad * 0.055
          + Math.abs(yawOffset) * 0.35
          + evalRes.rampDelta * 0.45
          + evalRes.bumpLift * 1.8;
        if (score < bestScore) {
          bestScore = score;
          best = evalRes;
        }
      }
    }
    if (best && bestScore < 2.2) break;
  }

  if (best) {
    return { ...best, dryFound: !allowSubmerged };
  }

  if (!forceFallback && !allowSubmerged) {
    return { landable: false, dryFound: false };
  }

  // Seabed / deterministic fixture fallback: conform as closely as possible.
  candFwd.copy(forwardH).addScaledVector(aimDir, -forwardH.dot(aimDir));
  if (candFwd.lengthSq() < 1e-4) tangentBasis(aimDir, candFwd, _v1);
  else candFwd.normalize();
  const relaxed = evaluateTripodPad(planet, aimDir, candFwd, {
    horizonQuat,
    allowSubmerged: true,
    maxSlopeRad: Math.PI * 0.45,
  });
  if (relaxed) return { ...relaxed, dryFound: false };

  const parkedLocalQuat = horizonQuat(aimDir, candFwd, new THREE.Quaternion());
  const groundR = planet.surfaceRadius(aimDir);
  const padLocal = aimDir.clone().multiplyScalar(groundR - GEAR_GROUND_Y);
  const padUniv = planet.localPositionToWorld(padLocal, new THREE.Vector3());
  const parkedWorldQuat = planet.frameOrientation.clone().multiply(parkedLocalQuat);
  return {
    landable: true,
    dryFound: false,
    padLocal,
    padUniv,
    parkedLocalQuat,
    parkedWorldQuat,
    gearOffsets: [0, 0, 0],
    slopeDeg: 0,
  };
}

/**
 * Pick whichever flank (+1 starboard, -1 port) gives the cinematic landing
 * camera lower obstructing terrain and better key-light modelling on the hull.
 */
function pickCinematicFlank(planet, padLocal, parkedLocalQuat) {
  const up = padLocal.clone().normalize();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(parkedLocalQuat).normalize();
  const aft = new THREE.Vector3(0, 0, 1).applyQuaternion(parkedLocalQuat).normalize();
  const sun = planet.sunDirLocal || up;
  const padR = padLocal.length();
  let bestSide = 1;
  let bestScore = -Infinity;
  for (const side of [1, -1]) {
    const sample = padLocal.clone()
      .addScaledVector(right, side * 19)
      .addScaledVector(aft, 12);
    const dir = sample.clone().normalize();
    const groundClearance = (padR + 4.4) - planet.surfaceRadius(dir);
    const sunScore = right.dot(sun) * side * 2.4;
    const score = groundClearance + sunScore;
    if (score > bestScore) {
      bestScore = score;
      bestSide = side;
    }
  }
  return bestSide;
}

/**
 * Build a zero-cut landing sequence from the exact live flight frame into the
 * parked pilot's seat.
 */
export function createLandingSequence({
  planet,
  ship,
  shipView,
  nav,
  camera,
  landing,
  onTouchdown = null,
  onCockpitReached = null,
}) {
  const wasCockpit = shipView.isCockpit();
  const D = ship.def.dims;
  const invFrame = planet.frameOrientation.clone().invert();

  const shipStartWorld = nav.pos.clone().add(ship.group.position);
  const shipStartLocal = planet.worldPositionToLocal(shipStartWorld, new THREE.Vector3());
  const shipStartLocalQuat = invFrame.clone().multiply(ship.group.quaternion).normalize();
  const invShipStart = shipStartLocalQuat.clone().invert();

  const camStartWorld = nav.pos.clone().add(camera.position);
  const camStartLocal = planet.worldPositionToLocal(camStartWorld, new THREE.Vector3());
  const camStartLocalQuat = invFrame.clone()
    .multiply(wasCockpit ? nav.quat : camera.quaternion).normalize();
  const camStartShipOffset = camStartLocal.clone().sub(shipStartLocal).applyQuaternion(invShipStart);
  const camStartShipQuat = invShipStart.clone().multiply(camStartLocalQuat).normalize();

  const upLocal = landing.padLocal.clone().normalize();
  const deltaStart = shipStartLocal.clone().sub(landing.padLocal);
  const startVert = deltaStart.dot(upLocal);
  const horizStart = deltaStart.clone().addScaledVector(upLocal, -startVert);
  const travelDist = deltaStart.length();

  const duration = wasCockpit
    ? clamp(2.4 + Math.sqrt(travelDist) * 0.08, 2.6, 3.8)
    : clamp(3.1 + Math.sqrt(travelDist) * 0.08, 3.3, 4.4);
  const touchdownK = wasCockpit ? 0.90 : 0.72;
  const side = wasCockpit ? 1 : pickCinematicFlank(planet, landing.padLocal, landing.parkedLocalQuat);

  const eyeLocalP = new THREE.Vector3(0, D.eyeY, D.eyeZ);
  const eyeLocalQ = new THREE.Quaternion();
  const heroShipOffset = new THREE.Vector3(side * 18.2, 4.3, 11.6);

  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const camLocal = new THREE.Vector3();
  const camLocalQuat = new THREE.Quaternion();
  const glideFromP = new THREE.Vector3();
  const glideFromQ = new THREE.Quaternion();
  let glideCaptured = false;
  let touchdownCued = false;
  let cockpitSignaled = wasCockpit;

  function evalHull(k) {
    const u = clamp(k / touchdownK, 0, 1);
    const uh = 1 - Math.pow(1 - u, 3);
    const us = smootherstep01(u);

    let vert;
    if (startVert >= 0) {
      const flareHover = clamp(startVert * 0.34, 6.5, 26);
      vert = cubicBezier1D(
        startVert,
        Math.max(flareHover, startVert * 0.56),
        flareHover * 0.38,
        0,
        us,
      );
    } else {
      const crest = Math.max(9, -startVert * 0.25 + 9);
      vert = cubicBezier1D(startVert, startVert * 0.3 + crest, crest * 0.45, 0, us);
    }

    if (k > touchdownK) {
      const settle = (k - touchdownK) / Math.max(1e-4, 1 - touchdownK);
      vert += -0.10 * Math.sin(Math.PI * Math.min(1, settle * 1.45)) * Math.exp(-2.5 * settle);
    }

    shipLocal.copy(landing.padLocal)
      .addScaledVector(horizStart, 1 - uh)
      .addScaledVector(upLocal, vert);

    const uRot = smootherstep01(Math.min(1, u * 1.06));
    const flarePitch = 0.082 * Math.sin(Math.PI * Math.pow(u, 0.82)) * (1 - us);
    shipLocalQuat.copy(shipStartLocalQuat).slerp(landing.parkedLocalQuat, uRot);
    if (Math.abs(flarePitch) > 1e-5) {
      shipLocalQuat.multiply(_q1.setFromAxisAngle(X_AXIS, flarePitch)).normalize();
    }

    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat).normalize();
    const gearProgress = clamp(0.14 + u * 0.96, 0, 1);
    return { u, gearProgress };
  }

  function step(k) {
    const { u, gearProgress } = evalHull(k);
    ship.setLandingPose(shipWorld, shipWorldQuat, gearProgress);

    if (!touchdownCued && k >= touchdownK) {
      touchdownCued = true;
      onTouchdown?.();
    }

    if (wasCockpit) {
      const settleIn = smootherstep01(k / 0.16);
      _v1.lerpVectors(camStartShipOffset, eyeLocalP, settleIn);
      const vib = (1 - u) * 0.0014;
      _v1.x += Math.sin(k * 95) * vib;
      _v1.y += Math.cos(k * 113) * vib;
      let nodPitch = 0;
      if (k > touchdownK) {
        const s = (k - touchdownK) / Math.max(1e-4, 1 - touchdownK);
        const bump = Math.sin(Math.PI * Math.min(1, s * 1.4)) * Math.exp(-2.4 * s);
        _v1.y -= 0.028 * bump;
        nodPitch = -0.015 * bump;
      }
      camLocal.copy(shipLocal).add(_v1.applyQuaternion(shipLocalQuat));
      _q2.copy(camStartShipQuat).slerp(eyeLocalQ, settleIn);
      if (Math.abs(nodPitch) > 1e-5) {
        _q2.multiply(_q1.setFromAxisAngle(X_AXIS, nodPitch));
      }
      camLocalQuat.copy(shipLocalQuat).multiply(_q2).normalize();
    } else if (k <= touchdownK) {
      const w = smootherstep01(k / touchdownK);
      _v1.lerpVectors(camStartShipOffset, heroShipOffset, w);
      _v1.x += side * 4.6 * Math.sin(Math.PI * w);
      _v1.y += 2.2 * Math.sin(Math.PI * w);
      camLocal.copy(shipLocal).add(_v1.applyQuaternion(shipLocalQuat));

      const camR = camLocal.length();
      _v2.copy(camLocal).multiplyScalar(1 / Math.max(camR, 1));
      const minCamR = planet.surfaceRadius(_v2) + 2.4;
      if (camR < minCamR) camLocal.copy(_v2).multiplyScalar(minCamR);

      _v3.set(0, 0.85, -4.4).applyQuaternion(shipLocalQuat).add(shipLocal);
      _m1.lookAt(camLocal, _v3, upLocal);
      _q1.setFromRotationMatrix(_m1);
      const trackBlend = smootherstep01(k / 0.22);
      camLocalQuat.copy(camStartLocalQuat).slerp(_q1, trackBlend).normalize();
    } else {
      if (!glideCaptured) {
        glideCaptured = true;
        _v2.copy(heroShipOffset).applyQuaternion(landing.parkedLocalQuat).add(landing.padLocal);
        const camR = _v2.length();
        _v3.copy(_v2).multiplyScalar(1 / Math.max(camR, 1));
        const minCamR = planet.surfaceRadius(_v3) + 2.4;
        if (camR < minCamR) _v2.copy(_v3).multiplyScalar(minCamR);
        _v3.set(0, 0.85, -4.4).applyQuaternion(landing.parkedLocalQuat).add(landing.padLocal);
        _m1.lookAt(_v2, _v3, upLocal);
        _q2.setFromRotationMatrix(_m1);
        _q1.copy(landing.parkedLocalQuat).invert();
        glideFromP.copy(_v2).sub(landing.padLocal).applyQuaternion(_q1);
        glideFromQ.copy(_q1).multiply(_q2).normalize();
      }
      const rawG = (k - touchdownK) / Math.max(1e-4, 1 - touchdownK);
      const g = smootherstep01(rawG);
      _v1.set(
        glideFromP.x * Math.pow(1 - g, 1.45),
        lerp(glideFromP.y, eyeLocalP.y, g) + Math.sin(Math.PI * g) * 1.12,
        lerp(glideFromP.z, eyeLocalP.z, g),
      );
      _q2.copy(glideFromQ).slerp(eyeLocalQ, smootherstep01(Math.pow(rawG, 0.92)));

      if (!cockpitSignaled && rawG >= 0.72) {
        cockpitSignaled = true;
        shipView.viewMode = 'cockpit';
        shipView.viewBlend = 1;
        shipView.parkedCamBlend = 1;
        shipView.freeYaw = 0;
        shipView.freePitch = 0;
        onCockpitReached?.();
      }

      camLocal.copy(shipLocal).add(_v1.applyQuaternion(shipLocalQuat));
      camLocalQuat.copy(shipLocalQuat).multiply(_q2).normalize();
    }

    planet.localPositionToWorld(camLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(camLocalQuat).normalize();
    return { descent: u, gearProgress, shipLocal, shipWorld };
  }

  return { duration, wasCockpit, step };
}

/**
 * Zero-cut transition from flight into stationary level atmospheric hover
 * (`hoverMode = 'high'`) when terrain below is too rugged/steep to land, or
 * when engaging high-altitude HALO skydiving.
 */
export function createHoverEntrySequence({
  planet,
  ship,
  shipView,
  nav,
  camera,
  horizonQuat,
  minClearance = 92,
  onCockpitReached = null,
}) {
  const wasCockpit = shipView.isCockpit();
  const D = ship.def.dims;
  const invFrame = planet.frameOrientation.clone().invert();

  const shipStartWorld = nav.pos.clone().add(ship.group.position);
  const shipStartLocal = planet.worldPositionToLocal(shipStartWorld, new THREE.Vector3());
  const shipStartLocalQuat = invFrame.clone().multiply(ship.group.quaternion).normalize();
  const invShipStart = shipStartLocalQuat.clone().invert();

  const camStartWorld = nav.pos.clone().add(camera.position);
  const camStartLocal = planet.worldPositionToLocal(camStartWorld, new THREE.Vector3());
  const camStartLocalQuat = invFrame.clone()
    .multiply(wasCockpit ? nav.quat : camera.quaternion).normalize();
  const camStartShipOffset = camStartLocal.clone().sub(shipStartLocal).applyQuaternion(invShipStart);
  const camStartShipQuat = invShipStart.clone().multiply(camStartLocalQuat).normalize();

  const startR = shipStartLocal.length();
  const startDir = shipStartLocal.clone().multiplyScalar(1 / Math.max(startR, 1));
  const fwdH = new THREE.Vector3(0, 0, -1).applyQuaternion(shipStartLocalQuat);
  fwdH.addScaledVector(startDir, -fwdH.dot(startDir));
  if (fwdH.lengthSq() < 1e-4) tangentBasis(startDir, fwdH, _v1);
  else fwdH.normalize();

  // Brake slightly forward while levelling off at safe skydive clearance.
  const hoverDir = startDir.clone().addScaledVector(fwdH, 16 / planet.R).normalize();
  const groundR = planet.hasLiquid && Number.isFinite(planet.seaRadius)
    ? Math.max(planet.surfaceRadius(hoverDir), planet.seaRadius)
    : planet.surfaceRadius(hoverDir);
  const targetR = Math.max(startR, groundR + minClearance);
  const hoverLocal = hoverDir.clone().multiplyScalar(targetR);
  const hoverLocalQuat = horizonQuat(hoverDir, fwdH, new THREE.Quaternion());
  const hoverUniv = planet.localPositionToWorld(hoverLocal, new THREE.Vector3());
  const hoverWorldQuat = planet.frameOrientation.clone().multiply(hoverLocalQuat);

  const eyeLocalP = new THREE.Vector3(0, D.eyeY, D.eyeZ);
  const eyeLocalQ = new THREE.Quaternion();
  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const camLocal = new THREE.Vector3();
  const camLocalQuat = new THREE.Quaternion();

  const duration = wasCockpit ? 1.65 : 2.25;
  let cockpitSignaled = wasCockpit;

  function step(k) {
    const e = smootherstep01(k);
    const brakeFlare = 0.095 * Math.sin(Math.PI * Math.pow(k, 0.78));
    shipLocal.lerpVectors(shipStartLocal, hoverLocal, 1 - Math.pow(1 - k, 2.6));
    shipLocalQuat.copy(shipStartLocalQuat).slerp(hoverLocalQuat, e)
      .multiply(_q1.setFromAxisAngle(X_AXIS, brakeFlare)).normalize();

    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat).normalize();
    ship.setLandingPose(shipWorld, shipWorldQuat, 0);

    if (wasCockpit) {
      const settle = smootherstep01(k / 0.25);
      _v1.lerpVectors(camStartShipOffset, eyeLocalP, settle);
      _q2.copy(camStartShipQuat).slerp(eyeLocalQ, settle);
    } else {
      _v1.lerpVectors(camStartShipOffset, eyeLocalP, e);
      _v1.y += Math.sin(Math.PI * e) * 1.45;
      _q2.copy(camStartShipQuat).slerp(eyeLocalQ, smootherstep01(Math.pow(k, 0.90)));
      if (!cockpitSignaled && k >= 0.80) {
        cockpitSignaled = true;
        shipView.viewMode = 'cockpit';
        shipView.viewBlend = 1;
        shipView.parkedCamBlend = 1;
        shipView.freeYaw = 0;
        shipView.freePitch = 0;
        onCockpitReached?.();
      }
    }

    camLocal.copy(shipLocal).add(_v1.applyQuaternion(shipLocalQuat));
    camLocalQuat.copy(shipLocalQuat).multiply(_q2).normalize();
    planet.localPositionToWorld(camLocal, nav.pos);
    nav.quat.copy(planet.frameOrientation).multiply(camLocalQuat).normalize();
    return { k };
  }

  return {
    duration,
    hoverLocal,
    hoverUniv,
    hoverLocalQuat,
    hoverWorldQuat,
    step,
  };
}

/**
 * Find the best recall arrival pose for a player on foot (`playerPosLocal`,
 * facing `playerLookFwd`):
 *   1. Prioritize flat landable spots in front of the player's gaze (`18..36 m`),
 *      then around the player (`20..42 m`), with the ship's rear cargo ramp (+Z)
 *      pointing straight toward the player (`mode: 'landed'`).
 *   2. When surrounded by steep cliffs/slopes with no landable ground, solve a
 *      low-altitude **Hot Extraction Hover** (`mode: 'hover-extract'`) that
 *      extends the hull out over downhill/open air while positioning the open
 *      rear cargo ramp lip `+0.18 m` above the slope `~6.2 m` in front of the
 *      player so they can run straight aboard!
 */
export function findRecallSite(planet, playerPosLocal, playerLookFwd, {
  horizonQuat,
  rampTipAt,
}) {
  const playerR = playerPosLocal.length();
  const playerDir = playerPosLocal.clone().multiplyScalar(1 / Math.max(playerR, 1));
  const playerGroundH = planet.height(playerDir, planet.fullMaxFreq);

  const lookH = playerLookFwd.clone().addScaledVector(playerDir, -playerLookFwd.dot(playerDir));
  if (lookH.lengthSq() < 1e-4) tangentBasis(playerDir, lookH, _v1);
  else lookH.normalize();
  const lookRight = new THREE.Vector3().crossVectors(lookH, playerDir).normalize();

  const cand = new THREE.Vector3();
  const shipFwd = new THREE.Vector3();

  // Pass 1: Gaze-prioritized tripod landing search.
  let bestLand = null;
  let bestScore = Infinity;
  for (const rad of [21, 27, 33, 40]) {
    for (let k = 0; k < 16; k++) {
      // Sample outward from gaze center (angle 0 = dead ahead of player)
      const relAngle = ((k % 2 === 0 ? k / 2 : -((k + 1) / 2)) / 8) * Math.PI;
      cand.copy(playerDir)
        .addScaledVector(lookH, (Math.cos(relAngle) * rad) / planet.R)
        .addScaledVector(lookRight, (Math.sin(relAngle) * rad) / planet.R)
        .normalize();

      // Tail (+Z) faces the player => nose (-Z, shipFwd) points away from player!
      shipFwd.copy(cand).sub(playerDir).projectOnPlane(cand);
      if (shipFwd.lengthSq() < 1e-5) shipFwd.copy(lookH);
      else shipFwd.normalize();

      const evalRes = evaluateTripodPad(planet, cand, shipFwd, { horizonQuat });
      if (!evalRes) continue;
      const candH = evalRes.padLocal.length() - planet.R;
      const elevDiff = Math.abs(candH - playerGroundH);
      if (elevDiff > 16) continue;

      const gazePenalty = (1 - Math.cos(relAngle)) * 2.2;
      const score = gazePenalty + evalRes.slopeDeg * 0.14 + rad * 0.025 + elevDiff * 0.15;
      if (score < bestScore) {
        bestScore = score;
        bestLand = evalRes;
      }
    }
    if (bestLand && bestScore < 1.8) break;
  }

  if (bestLand) {
    return {
      mode: 'landed',
      rampOpenSwing: 1.0,
      ...bestLand,
    };
  }

  // Pass 2: Steep / rugged terrain — Hot Extraction Hover!
  // Place the open ramp tip (swing = 0.88) ~6.4 m from the player at +0.18 m
  // above the slope, picking the azimuth where terrain falls away under the nose.
  const extractSwing = 0.88;
  const tipLocal = rampTipAt ? rampTipAt(extractSwing) : { y: -1.42, z: 9.48 };
  let bestHover = null;
  let bestHoverScore = -Infinity;

  for (let k = 0; k < 16; k++) {
    const relAngle = (k / 16) * Math.PI * 2;
    const dirHoriz = _v3.copy(lookH).multiplyScalar(Math.cos(relAngle))
      .addScaledVector(lookRight, Math.sin(relAngle)).normalize();

    // Ramp tip point ~6.4 m from player along dirHoriz
    const tipGroundDir = cand.copy(playerDir)
      .addScaledVector(dirHoriz, 6.4 / planet.R).normalize();
    const tipSurfaceR = planet.hasLiquid && Number.isFinite(planet.seaRadius)
      ? Math.max(planet.surfaceRadius(tipGroundDir), planet.seaRadius)
      : planet.surfaceRadius(tipGroundDir);
    const tipTargetLocal = tipGroundDir.clone().multiplyScalar(tipSurfaceR + 0.18);

    // Hull nose (-Z) extends outward along dirHoriz so the open tail ramp (+Z) faces the player.
    const hullQuat = horizonQuat(tipGroundDir, dirHoriz, new THREE.Quaternion());
    const padLocal = tipTargetLocal.clone().sub(
      _v1.set(0, tipLocal.y, tipLocal.z).applyQuaternion(hullQuat),
    );

    // Check clearance along belly, wings and nose out over the valley/slope.
    let minClearance = Infinity;
    for (let i = 0; i < HULL_CLEARANCE_POINTS.length; i++) {
      const [lx, minY, lz] = HULL_CLEARANCE_POINTS[i];
      _v1.set(lx, minY, lz).applyQuaternion(hullQuat).add(padLocal);
      const ptR = _v1.length();
      _v2.copy(_v1).multiplyScalar(1 / Math.max(ptR, 1));
      const gR = planet.surfaceRadius(_v2);
      minClearance = Math.min(minClearance, ptR - gR);
    }

    // Gaze preference + strong reward for positive hull clearance over open air.
    const gazeAlign = Math.cos(relAngle);
    const clearanceScore = minClearance >= 0.4
      ? Math.min(minClearance, 12) * 1.2
      : minClearance * 18.0;
    const score = clearanceScore + gazeAlign * 3.2;
    if (score > bestHoverScore) {
      bestHoverScore = score;
      // If every single direction is inside a narrow pit (minClearance < 0.35),
      // lift just enough to keep the hull safe.
      const safetyLift = minClearance < 0.35 ? (0.35 - minClearance) : 0;
      const safePadLocal = padLocal.addScaledVector(tipGroundDir, safetyLift);
      bestHover = {
        mode: 'hover-extract',
        rampOpenSwing: extractSwing,
        padLocal: safePadLocal,
        padUniv: planet.localPositionToWorld(safePadLocal, new THREE.Vector3()),
        parkedLocalQuat: hullQuat,
        parkedWorldQuat: planet.frameOrientation.clone().multiply(hullQuat),
        gearOffsets: [0, 0, 0],
        slopeDeg: 0,
      };
    }
  }

  return bestHover;
}

/**
 * Out-of-sight cinematic fly-in recall sequence: relocates the ship outside the
 * player's view frustum (~340 m away, ~125 m up on the rear flank) and sweeps it
 * in with a banked braking flare, yawing tail-first toward the player while
 * opening the cargo ramp so they can run straight aboard.
 */
export function createRecallFlyInSequence({
  planet,
  ship,
  shipView,
  playerPosLocal,
  playerLookFwd,
  target,
}) {
  const endLocal = target.padLocal.clone();
  const endQuat = target.parkedLocalQuat.clone();
  const upLocal = endLocal.clone().normalize();

  const lookH = playerLookFwd.clone().addScaledVector(upLocal, -playerLookFwd.dot(upLocal));
  if (lookH.lengthSq() < 1e-4) tangentBasis(upLocal, lookH, _v1);
  else lookH.normalize();
  const lookRight = new THREE.Vector3().crossVectors(lookH, upLocal).normalize();

  // Spawn behind-and-beside the player's camera frustum (~115° off gaze) so it
  // roars in from out of sight rather than popping in front of the player.
  const startLocal = endLocal.clone()
    .addScaledVector(lookH, -145)
    .addScaledVector(lookRight, 285)
    .addScaledVector(upLocal, 132);
  // Ensure approach start is well above any nearby mountain peak.
  const startR = startLocal.length();
  _v1.copy(startLocal).multiplyScalar(1 / Math.max(startR, 1));
  const minStartR = planet.surfaceRadius(_v1) + 75;
  if (startR < minStartR) startLocal.copy(_v1).multiplyScalar(minStartR);

  // Midpoint control curves wide into the player's forward view before braking.
  const midLocal = endLocal.clone()
    .addScaledVector(lookH, 42)
    .addScaledVector(lookRight, 68)
    .addScaledVector(upLocal, 34);

  const approachFwd = endLocal.clone().sub(startLocal).projectOnPlane(upLocal).normalize();
  tangentBasis(upLocal, _v2, _v3);
  const startRight = new THREE.Vector3().crossVectors(approachFwd, upLocal).normalize();
  const startBack = approachFwd.clone().negate();
  _m1.makeBasis(startRight, upLocal, startBack);
  const startQuat = new THREE.Quaternion().setFromRotationMatrix(_m1);

  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const duration = 3.65;
  const deployGear = target.mode === 'landed';

  ship.orbitalStandby = false;
  ship.group.visible = true;
  shipView.closeRamp();
  shipView.rampT = 0;

  function step(k) {
    const u = 1 - Math.pow(1 - clamp(k, 0, 1), 2.55);
    const omt = 1 - u;
    shipLocal.set(
      omt * omt * startLocal.x + 2 * omt * u * midLocal.x + u * u * endLocal.x,
      omt * omt * startLocal.y + 2 * omt * u * midLocal.y + u * u * endLocal.y,
      omt * omt * startLocal.z + 2 * omt * u * midLocal.z + u * u * endLocal.z,
    );

    const rotK = smootherstep01(clamp((k - 0.08) / 0.84, 0, 1));
    const bankAngle = -0.44 * Math.sin(Math.PI * clamp(k / 0.78, 0, 1));
    const flarePitch = 0.16 * Math.sin(Math.PI * smoothstep(k, 0.28, 0.96));
    shipLocalQuat.copy(startQuat).slerp(endQuat, rotK)
      .multiply(_q1.setFromAxisAngle(Z_AXIS, bankAngle))
      .multiply(_q2.setFromAxisAngle(X_AXIS, flarePitch))
      .normalize();

    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat).normalize();

    const gearProgress = deployGear ? smoothstep(k, 0.36, 0.90) : 0;
    ship.setLandingPose(shipWorld, shipWorldQuat, gearProgress);

    // Open the hydraulic cargo ramp automatically during the final flare!
    if (k >= 0.44) {
      shipView.openRamp();
      const rampK = smoothstep(k, 0.44, 0.98);
      shipView.rampT = Math.max(shipView.rampT, rampK * (target.rampOpenSwing ?? 1));
    }

    return { k, shipLocal, shipWorld };
  }

  return { duration, step };
}

/**
 * Unmanned auto-departure after the pilot skydives out of a high-hovering ship:
 * seals the cargo ramp and climbs steeply into high-altitude orbital standby.
 */
export function createAutoDepartSequence({
  planet,
  ship,
  shipView,
}) {
  const startLocal = ship.parkedLocal.clone();
  const startQuat = ship.parkedLocalQuat.clone();
  const upLocal = startLocal.clone().normalize();
  const fwdLocal = new THREE.Vector3(0, 0, -1).applyQuaternion(startQuat).normalize();
  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const duration = 3.4;

  shipView.closeRamp();

  function step(k) {
    const accel = Math.pow(clamp(k, 0, 1), 2.3);
    const pitchUp = 0.46 * smoothstep(k, 0.05, 0.65);
    shipLocal.copy(startLocal)
      .addScaledVector(upLocal, 620 * accel)
      .addScaledVector(fwdLocal, 480 * accel);
    shipLocalQuat.copy(startQuat)
      .multiply(_q1.setFromAxisAngle(X_AXIS, pitchUp)).normalize();

    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat).normalize();
    ship.setLandingPose(shipWorld, shipWorldQuat, 0);
  }

  return { duration, step };
}

/**
 * Build a zero-cut liftoff sequence from a parked or hovering seat (works in
 * both 1st-person cockpit and 3rd-person chase, and supports toggling V mid-climb).
 */
export function createTakeoffSequence({
  planet,
  ship,
  shipView,
  nav,
}) {
  const D = ship.def.dims;
  const shipStartLocal = ship.parkedLocal.clone();
  const shipStartLocalQuat = ship.parkedLocalQuat.clone();
  const upLocal = shipStartLocal.clone().normalize();
  const forwardLocal = new THREE.Vector3(0, 0, -1)
    .applyQuaternion(shipStartLocalQuat).normalize();

  const wasHover = Boolean(ship.hoverMode);
  const camStartShip = shipView.captureShipLocalCamera();
  const duration = wasHover ? 2.10 : 2.55;
  const maxLift = wasHover ? 72 : 96;
  const maxSurge = wasHover ? 168 : 148;

  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const prevShipLocal = shipStartLocal.clone();
  const lastVelLocal = new THREE.Vector3();

  function step(k, dt = 1 / 60) {
    const liftK = Math.pow(smoothstep(k, 0, 1), 2.05);
    const surgeK = Math.pow(smoothstep(k, wasHover ? 0.04 : 0.15, 1), 2.05);
    const pitchAngle = 0.20 * smoothstep(k, 0.06, 0.56);

    prevShipLocal.copy(shipLocal);
    shipLocal.copy(shipStartLocal)
      .addScaledVector(upLocal, maxLift * liftK)
      .addScaledVector(forwardLocal, maxSurge * surgeK);
    if (k > 0.02 && dt > 1e-4) {
      lastVelLocal.copy(shipLocal).sub(prevShipLocal).multiplyScalar(1 / dt);
    }

    shipLocalQuat.copy(shipStartLocalQuat)
      .multiply(_q1.setFromAxisAngle(X_AXIS, pitchAngle)).normalize();
    planet.localPositionToWorld(shipLocal, shipWorld);
    shipWorldQuat.copy(planet.frameOrientation).multiply(shipLocalQuat).normalize();

    const gearProgress = wasHover ? 0 : (1 - smoothstep(k, 0.14, 0.78));
    ship.setLandingPose(shipWorld, shipWorldQuat, gearProgress);

    const settleStart = smootherstep01(k / 0.42);
    if (shipView.parkedCamBlend < 1) {
      shipView.evalParkedCameraLocal(null, _v1, _q2);
    } else if (shipView.isCockpit()) {
      const gPush = Math.sin(Math.PI * k) * 0.042;
      _v1.set(0, D.eyeY, D.eyeZ + gPush);
      _q2.identity();
      if (settleStart < 1) {
        _v1.lerpVectors(camStartShip.p, _v1, settleStart);
        _q2.slerpQuaternions(camStartShip.q, _q2, settleStart);
      }
    } else {
      const lunge = Math.sin(Math.PI * smoothstep(k, 0.08, 0.98));
      _v1.set(0, 6.5 - lunge * 0.32, 30 + lunge * 2.8);
      _q2.identity();
      if (settleStart < 1) {
        _v1.lerpVectors(camStartShip.p, _v1, settleStart);
        _q2.slerpQuaternions(camStartShip.q, _q2, settleStart);
      }
    }

    _v4.copy(_v1).applyQuaternion(shipLocalQuat).add(shipLocal);
    if (!shipView.isCockpit()) {
      const camR = _v4.length();
      _v2.copy(_v4).multiplyScalar(1 / Math.max(camR, 1));
      const minCamR = planet.surfaceRadius(_v2) + 2.2;
      if (camR < minCamR) _v4.copy(_v2).multiplyScalar(minCamR);
    }

    planet.localPositionToWorld(_v4, nav.pos);
    nav.quat.copy(shipWorldQuat).multiply(_q2).normalize();
    return { k, gearProgress };
  }

  function finish() {
    step(1, 1 / 60);
    shipView.parkedCamBlend = 1;
    shipView.parkedOrbitYaw = 0;
    shipView.parkedOrbitPitch = 0;
    if (shipView.isCockpit()) {
      _v1.set(0, D.eyeY, D.eyeZ).applyQuaternion(shipWorldQuat).add(shipWorld);
    } else {
      _v1.set(0, 6.5, 30).applyQuaternion(shipWorldQuat).add(shipWorld);
    }
    nav.pos.copy(_v1);
    nav.quat.copy(shipWorldQuat);

    if (lastVelLocal.lengthSq() > 1) {
      planet.localOffsetToWorld(lastVelLocal, nav.vel);
    } else {
      _v2.copy(upLocal).multiplyScalar(68).addScaledVector(forwardLocal, 112);
      planet.localOffsetToWorld(_v2, nav.vel);
    }
  }

  return { duration, step, finish };
}
