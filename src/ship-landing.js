// Seamless landing & liftoff choreography for HALCYON VII.
//
// Design contract:
// 1. Zero camera cuts: landing starts from the exact on-screen hull and camera
//    pose at k = 0.
//    - In cockpit view (1st person), the camera stays in the pilot's seat
//      throughout approach, flare and strut touchdown (with RMB free-look live).
//    - In chase view (3rd person), one unbroken crane shot sweeps from the
//      chase formation around the sunlit flank as the gear unfolds and touches
//      down, then glides forward over the wing root and canopy into the
//      first-person pilot's seat so the player can stand up (F) and walk out.
// 2. Liftoff from a parked seat works identically in either 1st person or 3rd
//    person (and V can toggle between them before or during the climb), handing
//    off to free space flight at k = 1 with continuous position, attitude and
//    velocity.

import * as THREE from 'three';

const clamp = THREE.MathUtils.clamp;
const lerp = THREE.MathUtils.lerp;
const smoothstep = THREE.MathUtils.smoothstep;

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

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

/**
 * Find a flat, dry landing pad ahead of (or beneath) the ship that preserves
 * its approach heading and keeps the rear cargo ramp over walkable ground.
 */
export function findLandingSite(planet, shipStartLocal, shipStartLocalQuat, {
  horizonQuat,
  footprintRange,
  profile,
  rampExitZ = 10.2,
}) {
  const startR = shipStartLocal.length();
  const startDir = shipStartLocal.clone().multiplyScalar(1 / Math.max(startR, 1));
  const startGround = planet.surfaceRadius(startDir);
  const startAlt = Math.max(0, startR - startGround);

  const forwardH = new THREE.Vector3(0, 0, -1).applyQuaternion(shipStartLocalQuat);
  forwardH.addScaledVector(startDir, -forwardH.dot(startDir));
  if (forwardH.lengthSq() < 1e-4) {
    tangentBasis(startDir, forwardH, _v1);
  } else {
    forwardH.normalize();
  }

  const leadMeters = clamp(startAlt * 0.36, 0, 68);
  const aimDir = startDir.clone().addScaledVector(forwardH, leadMeters / planet.R).normalize();
  const e1 = new THREE.Vector3();
  const e2 = new THREE.Vector3();
  tangentBasis(aimDir, e1, e2);

  const cand = new THREE.Vector3();
  const candFwd = new THREE.Vector3();
  const exitOffset = new THREE.Vector3();
  const exitDir = new THREE.Vector3();
  const aimH = planet.height(aimDir, planet.fullMaxFreq);

  let best = null;
  let bestH = 0;
  let bestQuat = null;
  let bestScore = Infinity;

  for (const rad of [0, 15, 28, 42, 56]) {
    const samples = rad === 0 ? 1 : 12;
    for (let k = 0; k < samples; k++) {
      const a = (k / samples) * Math.PI * 2;
      cand.copy(aimDir)
        .addScaledVector(e1, Math.cos(a) * rad / planet.R)
        .addScaledVector(e2, Math.sin(a) * rad / planet.R)
        .normalize();
      const h = planet.height(cand, planet.fullMaxFreq);
      if (planet.hasLiquid && h < planet.seaLevel + 1.0) continue;

      for (const yawOffset of [0, 0.42, -0.42]) {
        candFwd.copy(forwardH).addScaledVector(cand, -forwardH.dot(cand));
        if (candFwd.lengthSq() < 1e-4) tangentBasis(cand, candFwd, _v1);
        else candFwd.normalize();
        if (yawOffset !== 0) {
          candFwd.applyQuaternion(_q1.setFromAxisAngle(cand, yawOffset)).normalize();
        }
        const candidateQuat = horizonQuat(cand, candFwd, new THREE.Quaternion());
        const footprint = footprintRange(planet, cand, candidateQuat);
        const slope = (footprint.max - footprint.min) / (profile.bounds.halfZ * 2);

        // Verify the ground right outside the rear cargo ramp is dry & reachable.
        exitOffset.set(0, 0, rampExitZ).applyQuaternion(candidateQuat);
        exitDir.copy(cand).multiplyScalar(planet.R).add(exitOffset).normalize();
        const exitH = planet.height(exitDir, planet.fullMaxFreq);
        if (planet.hasLiquid && exitH < planet.seaLevel + 0.6) continue;
        const rampDrop = Math.abs(footprint.max - exitH);

        const score = slope * 26
          + rad * 0.022
          + Math.abs(yawOffset) * 0.35
          + rampDrop * 0.42
          + Math.abs(footprint.max - aimH) * 0.04;
        if (score < bestScore) {
          bestScore = score;
          best = cand.clone();
          bestH = footprint.max - profile.bounds.minY + profile.groundClearance;
          bestQuat = candidateQuat;
        }
      }
    }
    if (best && bestScore < 1.35) break;
  }

  const dryFound = Boolean(best);
  if (!best) {
    // Open ocean / extreme relief fallback: set down ahead along current heading.
    best = aimDir.clone();
    candFwd.copy(forwardH).addScaledVector(best, -forwardH.dot(best));
    if (candFwd.lengthSq() < 1e-4) tangentBasis(best, candFwd, _v1);
    else candFwd.normalize();
    bestQuat = horizonQuat(best, candFwd, new THREE.Quaternion());
    const footprint = footprintRange(planet, best, bestQuat);
    bestH = clamp(footprint.max, aimH - 28, aimH + 28)
      - profile.bounds.minY + profile.groundClearance;
  }

  const padLocal = best.clone().multiplyScalar(planet.R + bestH);
  const padUniv = planet.localPositionToWorld(padLocal, new THREE.Vector3());
  const parkedLocalQuat = bestQuat;
  const parkedWorldQuat = planet.frameOrientation.clone().multiply(parkedLocalQuat);
  return { padLocal, padUniv, parkedLocalQuat, parkedWorldQuat, dryFound };
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
  // In cockpit mode applyCockpitLook dresses camera.quaternion after nav.quat,
  // so capture nav.quat for cockpit and camera.quaternion for chase.
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
      // Beat 1: unbroken crane sweep from exact chase pose to 3/4 flank hero shot.
      const w = smootherstep01(k / touchdownK);
      _v1.lerpVectors(camStartShipOffset, heroShipOffset, w);
      _v1.x += side * 4.6 * Math.sin(Math.PI * w);
      _v1.y += 2.2 * Math.sin(Math.PI * w);
      camLocal.copy(shipLocal).add(_v1.applyQuaternion(shipLocalQuat));

      // Keep the cinematic lens safely above nearby terrain ridges.
      const camR = camLocal.length();
      _v2.copy(camLocal).multiplyScalar(1 / Math.max(camR, 1));
      const minCamR = planet.surfaceRadius(_v2) + 2.4;
      if (camR < minCamR) camLocal.copy(_v2).multiplyScalar(minCamR);

      // Frame the forward hull, unfolding gear and landing pad ahead.
      _v3.set(0, 0.85, -4.4).applyQuaternion(shipLocalQuat).add(shipLocal);
      _m1.lookAt(camLocal, _v3, upLocal);
      _q1.setFromRotationMatrix(_m1);
      const trackBlend = smootherstep01(k / 0.22);
      camLocalQuat.copy(camStartLocalQuat).slerp(_q1, trackBlend).normalize();
    } else {
      // Beat 2: seamless forward glide over the wing root & canopy into the seat.
      // Evaluate the exact Beat-1 endpoint at k = touchdownK analytically so the
      // handoff is frame-rate invariant even on coarse low-FPS frames.
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
 * Build a zero-cut liftoff sequence from a parked seat (works in both 1st-person
 * cockpit and 3rd-person chase, and supports toggling V mid-climb).
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

  const camStartShip = shipView.captureShipLocalCamera();
  const duration = 2.55;
  const maxLift = 96;
  const maxSurge = 148;

  const shipLocal = new THREE.Vector3();
  const shipWorld = new THREE.Vector3();
  const shipLocalQuat = new THREE.Quaternion();
  const shipWorldQuat = new THREE.Quaternion();
  const prevShipLocal = shipStartLocal.clone();
  const lastVelLocal = new THREE.Vector3();

  function step(k, dt = 1 / 60) {
    const liftK = Math.pow(smoothstep(k, 0, 1), 2.05);
    const surgeK = Math.pow(smoothstep(k, 0.15, 1), 2.15);
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

    const gearProgress = 1 - smoothstep(k, 0.14, 0.78);
    ship.setLandingPose(shipWorld, shipWorldQuat, gearProgress);

    // Solve ship-local camera pose for whichever view mode the pilot chose.
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
    // Match exact free-flight formation / cockpit pose on handoff to 'space'.
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
