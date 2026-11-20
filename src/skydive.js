import * as THREE from 'three';
import { keys } from './controls.js';
import { createSkydiveRig } from './skydive-rig.js';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const _horizontal = new THREE.Vector3();

const _u = new THREE.Vector3();
const _east = new THREE.Vector3();
const _north = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _viewDir = new THREE.Vector3();
const _camRight = new THREE.Vector3();
const _camUp = new THREE.Vector3();
const _canopyUp = new THREE.Vector3();
const _canopyRight = new THREE.Vector3();
const _canopyBack = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
function lerp(a, b, t) { return a + (b - a) * t; }
function damp(a, b, lambda, dt) { return lerp(a, b, 1 - Math.exp(-lambda * dt)); }
function smootherstep01(t) {
  const x = clamp(t, 0, 1);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

export class SkydiveController {
  constructor(dom, scene, {
    onDeploy = null,
    onAadWarning = null,
    onLoad = null,
    onLand = null,
  } = {}) {
    this.dom = dom;
    this.scene = scene;
    this.onDeploy = onDeploy;
    this.onLoad = onLoad;
    this.onAadWarning = onAadWarning;
    this.onLand = onLand;

    this.active = false;
    this.planet = null;
    this.phase = 'idle'; // 'idle' | 'freefall' | 'canopy'
    this.posLocal = new THREE.Vector3();
    this.velLocal = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = -0.18;
    this.glideYaw = 0;
    this.bankRoll = 0;
    this.pitchJolt = 0;
    this.deployT = 0;
    this.agl = 0;
    this.airspeed = 0;
    this.aadTriggered = false;
    this.time = 0;
    this.eyeHeight = 1.70;
    this.quat = new THREE.Quaternion();

    this.touchMove = new THREE.Vector2();
    this.frameAxis = Y_AXIS;
    this.rig = null;
    this.rampPose = { quat: new THREE.Quaternion(), posLocal: new THREE.Vector3(),
      phase: 'ramp', deployT: 0, brakeLeft: 0, brakeRight: 0, dive: 0, airspeed: 0 };
    this.collapsing = false;
    this.collapse = 0;
    this.collapsePose = { quat: new THREE.Quaternion(), posLocal: new THREE.Vector3(), planet: null,
      phase: 'canopy', deployT: 1, brakeLeft: 0, brakeRight: 0, dive: 0, airspeed: 0, agl: 0,
      time: 0, collapse: 0, glideYaw: 0 };

    this._drag = null;
    this._onMove = (e) => {
      if (!this.active) return;
      let mx = 0, my = 0;
      if (document.pointerLockElement) {
        mx = e.movementX;
        my = e.movementY;
      } else if (this._drag && this._drag.id === e.pointerId) {
        mx = e.clientX - this._drag.x;
        my = e.clientY - this._drag.y;
        this._drag.x = e.clientX;
        this._drag.y = e.clientY;
      } else {
        return;
      }
      this.yaw += mx * 0.0024;
      const minPitch = this.phase === 'canopy' ? -0.62 : -1.48;
      this.pitch = clamp(this.pitch - my * 0.0024, minPitch, 1.46);
    };
    this._onDown = (e) => {
      if (this.active && !document.pointerLockElement && !this._drag) {
        try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic */ }
        this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      }
    };
    this._onUp = (e) => { if (this._drag && this._drag.id === e.pointerId) this._drag = null; };
    dom.addEventListener('pointermove', this._onMove);
    dom.addEventListener('pointerdown', this._onDown);
    dom.addEventListener('pointerup', this._onUp);
    dom.addEventListener('pointercancel', this._onUp);
  }

  frame(up, east, north) {
    east.crossVectors(this.frameAxis, up).normalize();
    north.crossVectors(up, east);
  }

  prepareRig() {
    if (this.rig) return;
    this.rig = createSkydiveRig();
    this.scene.add(this.rig.root);
  }

  showRampPose(progress, planet, nav, altitude) {
    if (this.active || !this.rig || this.collapsing) return;
    if (!progress || !planet) {
      this.rig.root.visible = false;
      this.rampPose.planet = null;
      return;
    }
    const pose = this.rampPose;
    pose.planet = planet;
    pose.time = (progress - 1) * .65;
    planet.worldPositionToLocal(nav.pos, pose.posLocal);
    pose.quat.copy(planet.frameOrientation).invert().multiply(nav.quat);
    pose.agl = altitude;
    this.rig.update(pose, pose.quat, this.dom.clientWidth / Math.max(1, this.dom.clientHeight));
  }

  enter(planet, posLocal, viewDir, initialVelLocal = null) {
    this.endCollapse();
    this.active = true;
    this.planet = planet;
    this.phase = 'freefall';
    this.posLocal.copy(posLocal);
    if (initialVelLocal) this.velLocal.copy(initialVelLocal);
    else this.velLocal.set(0, 0, 0);

    _u.copy(posLocal).normalize();
    this.frameAxis = Math.abs(_u.y) < .93 ? Y_AXIS : X_AXIS;
    this.frame(_u, _east, _north);
    _fwd.copy(viewDir).projectOnPlane(_u).normalize();
    if (_fwd.lengthSq() < 0.05) _fwd.copy(_north);
    this.yaw = Math.atan2(_fwd.dot(_east), _fwd.dot(_north));
    this.glideYaw = this.yaw;
    this.pitch = clamp(Math.asin(clamp(viewDir.dot(_u), -1, 1)), -1.45, 1.42);
    this.bankRoll = 0;
    this.pitchJolt = 0;
    this.deployT = 0;
    this.aadTriggered = false;
    this.time = 0;
    this.dive = 0;
    this.brakeLeft = 0;
    this.brakeRight = 0;
    this.sinkRate = -this.velLocal.dot(_u);
    this.airspeed = this.velLocal.length();
    this.prepareRig();
    this.measureClearance();
    this.updateQuat();
    this.syncRig();
  }

  exit() {
    this.active = false;
    this.planet = null;
    this.phase = 'idle';
    this.rig.root.visible = false;
    this.rig.canopy.visible = false;
    this.touchMove.set(0, 0);
    this._drag = null;
    this.airspeed = 0;
  }

  deployParachute({ automatic = false } = {}) {
    if (!this.active || this.phase !== 'freefall') return false;
    this.phase = 'canopy';
    this.deployT = 0.001;
    this.openSeconds = lerp(1.05, 1.52, clamp(this.airspeed / 160, 0, 1));
    const headLimit = THREE.MathUtils.degToRad(26);
    const headOffset = Math.atan2(Math.sin(this.yaw - this.glideYaw), Math.cos(this.yaw - this.glideYaw));
    this.yaw = this.glideYaw + clamp(headOffset, -headLimit, headLimit);
    this.aadTriggered = automatic;
    this.rig.root.visible = true;
    if (automatic) this.onAadWarning?.();
    this.onDeploy?.({ automatic, agl: this.agl });
    return true;
  }

  measureClearance() {
    if (!this.planet) return 0;
    const r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / Math.max(r, 1));
    const surfaceR = this.planet.hasLiquid && Number.isFinite(this.planet.seaRadius)
      ? Math.max(this.planet.surfaceRadius(_u), this.planet.seaRadius)
      : this.planet.surfaceRadius(_u);
    this.agl = Math.max(0, r - surfaceR);
    return surfaceR;
  }

  fovOffset() {
    if (!this.active) return 0;
    if (this.phase === 'freefall') {
      // Wind rush of the leap itself, before airspeed has built up.
      const rush = 5 * Math.sin(Math.PI * THREE.MathUtils.smoothstep(this.time, 0, 1.3));
      return 8 * clamp((this.airspeed - 8) / 58, 0, 1) + 7 * this.dive + rush;
    }
    const settle = smootherstep01(this.deployT);
    return lerp(11.5, 3.0, settle);
  }

  interactPrompt(touch = false) {
    if (!this.active) return '';
    const meters = Math.max(0, Math.round(this.agl));
    const altitude = `${meters} m AGL`;
    if (this.phase === 'freefall') return `${altitude}   ·   ${touch ? '前推俯冲' : 'W 俯冲   /   SPACE 开伞'}`;
    if (this.aadTriggered && this.deployT < 0.95) {
      return `紧急自动开伞保护（AAD）已触发 · 离地 ${meters} m`;
    }
    if (meters < 25) return `${altitude}   ·   ${touch ? '后拉' : 'S'} 拉平着陆`;
    return `${altitude}   ·   ${touch ? '摇杆控伞' : 'A / D 控伞   ·   S 刹伞'}`;
  }

  updateQuat() {
    if (this.phase === 'canopy') {
      const headLimit = THREE.MathUtils.degToRad(26);
      this.yaw = this.glideYaw + clamp(this.yaw - this.glideYaw, -headLimit, headLimit);
    } else if (this.phase === 'freefall') {
      const maxNeck = THREE.MathUtils.degToRad(34);
      const headOffset = Math.atan2(Math.sin(this.yaw - this.glideYaw), Math.cos(this.yaw - this.glideYaw));
      if (Math.abs(headOffset) > maxNeck) {
        this.glideYaw = this.yaw - clamp(headOffset, -maxNeck, maxNeck);
      }
    }
    _u.copy(this.posLocal).normalize();
    this.frame(_u, _east, _north);
    _fwd.copy(_north).multiplyScalar(Math.cos(this.yaw)).addScaledVector(_east, Math.sin(this.yaw));
    const tremor = this.phase === 'freefall'
      ? Math.sin(this.time * 31.0) * 0.0032 * clamp(this.airspeed / 55, 0, 1)
      : 0;
    const { tip: tipForward, roll: exitRoll } = this.exitMotion();
    const effPitch = clamp(this.pitch + this.pitchJolt + tremor - tipForward - .29 * this.dive, -1.49, 1.47);
    _viewDir.copy(_fwd).multiplyScalar(Math.cos(effPitch)).addScaledVector(_u, Math.sin(effPitch));
    _camRight.crossVectors(_viewDir, _u);
    if (_camRight.lengthSq() < 1e-6) _camRight.set(1, 0, 0);
    _camRight.normalize();
    _camUp.crossVectors(_camRight, _viewDir);
    _m.makeBasis(_camRight, _camUp, _fwd.copy(_viewDir).negate());
    this.quat.setFromRotationMatrix(_m);
    const roll = this.bankRoll + exitRoll;
    if (Math.abs(roll) > 1e-4) {
      this.quat.multiply(_qBank.setFromAxisAngle(Z_AXIS, -roll));
    }
  }

  // The leap off the ramp: a short hop, then the head and shoulders roll
  // forward into the airstream before the arch flattens belly-to-earth.
  exitMotion() {
    const t = this.time;
    const env = 1 - this.deployT;
    const hop = .09 * Math.sin(Math.PI * THREE.MathUtils.smoothstep(t, 0, .34));
    const tumble = .50 * Math.pow(Math.sin(Math.PI * THREE.MathUtils.smoothstep(t, .12, 1.75)), 1.2);
    const roll = .07 * Math.sin(t * 4.3 + .6) * Math.sin(Math.PI * THREE.MathUtils.smoothstep(t, .1, 1.5));
    return { tip: (tumble - hop) * env, roll: roll * env };
  }

  syncRig() {
    _fwd.copy(_north).multiplyScalar(Math.cos(this.glideYaw)).addScaledVector(_east, Math.sin(this.glideYaw));
    const exit = this.exitMotion();
    const tipForward = exit.tip * .95;
    const canopySettle = this.phase === 'canopy' ? smootherstep01(this.deployT) : 0;
    // Keep torso/arms pitched with the body's dive/arch state (never head pitch),
    // then swing smoothly upright into the parachute harness on deployment.
    const bodyPitch = clamp(
      (this.pitchJolt - tipForward - .32 * this.dive) * (1 - canopySettle * .75)
      + (this.phase === 'canopy' ? this.pitchJolt * canopySettle * .75 : 0),
      -1.1, 0.6);
    _viewDir.copy(_fwd).multiplyScalar(Math.cos(bodyPitch)).addScaledVector(_u, Math.sin(bodyPitch));
    _canopyRight.crossVectors(_viewDir, _u);
    if (_canopyRight.lengthSq() < 1e-6) _canopyRight.set(1, 0, 0);
    _canopyRight.normalize();
    _canopyUp.crossVectors(_canopyRight, _viewDir);
    _canopyBack.copy(_viewDir).negate();
    _q.setFromRotationMatrix(_m.makeBasis(_canopyRight, _canopyUp, _canopyBack));
    const rigBank = (this.phase === 'canopy' ? this.bankRoll * .58 : this.bankRoll) + exit.roll * 1.3;
    if (Math.abs(rigBank) > 1e-4) {
      _q.multiply(_qBank.setFromAxisAngle(Z_AXIS, -rigBank));
    }
    this.rig.update(this, _q, this.dom.clientWidth / Math.max(1, this.dom.clientHeight));
  }

  update(dt) {
    if (!this.active || !this.planet) return;
    this.time += dt;
    const p = this.planet;
    const g = clamp(p.gravity || 9.8, 6.8, 14.2);

    const fIn = clamp((keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0) + this.touchMove.y, -1, 1);
    const rIn = clamp((keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0) + this.touchMove.x, -1, 1);

    let r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / Math.max(r, 1));
    this.frame(_u, _east, _north);

    // Decompose current planet-local velocity into vertical (upward) and tangent components.
    let vVert = this.velLocal.dot(_u);
    const horizVel = _horizontal.copy(this.velLocal).addScaledVector(_u, -vVert);
    this.dive = damp(this.dive, this.phase === 'freefall' ? Math.max(fIn, 0) : 0, 2.8, dt);

    if (this.phase === 'freefall') {
      // Head free-look leads while the skydiver's torso aerodynamically banks
      // and weathervanes into the new heading with natural rotational inertia
      // (never snapping 1:1 with the camera, yet aligning for straight dives).
      const maxNeck = THREE.MathUtils.degToRad(34);
      const headOffset = Math.atan2(Math.sin(this.yaw - this.glideYaw), Math.cos(this.yaw - this.glideYaw));
      const followRate = lerp(.65, 3.6, THREE.MathUtils.smoothstep(Math.abs(headOffset), .25, .55));
      this.glideYaw = this.yaw - headOffset;
      this.glideYaw += headOffset * (1 - Math.exp(-followRate * dt));
      const after = Math.atan2(Math.sin(this.yaw - this.glideYaw), Math.cos(this.yaw - this.glideYaw));
      if (Math.abs(after) > maxNeck) {
        this.glideYaw = this.yaw - clamp(after, -maxNeck, maxNeck);
      }

      _fwd.copy(_north).multiplyScalar(Math.cos(this.glideYaw)).addScaledVector(_east, Math.sin(this.glideYaw));
      _right.crossVectors(_fwd, _u).normalize();

      // A tucked suit trades drag for speed in thin air. Reserve the fast
      // descent for a deliberate dive, so releasing W opens the body again.
      const thinAir = 1 - Math.exp(-Math.max(0, this.agl) / 7800);
      const terminalDown = 57 + thinAir * 13 + this.dive * (76 + thinAir * 148) + Math.min(0, fIn) * 15;
      const airborne = THREE.MathUtils.smoothstep(this.time, .32, 1.10);
      const accel = g * (1 + this.dive * airborne * 2.35);
      vVert -= accel * dt * (1 - Math.pow(Math.max(0, -vVert) / terminalDown, 2));
      const targetHoriz = _camRight.set(0, 0, 0)
        .addScaledVector(_fwd, fIn * (21 + 19 * this.dive))
        .addScaledVector(_right, rIn * 15);
      horizVel.lerp(targetHoriz, 1 - Math.exp(-dt * lerp(.16, 2.6, airborne)));
      const turnBank = clamp(headOffset * .32, -.18, .18);
      this.bankRoll = damp(this.bankRoll, rIn * 0.14 + turnBank, 5.5, dt);
      this.pitchJolt = damp(this.pitchJolt, 0, 6.0, dt);

      // Line stretch and deceleration consume more altitude on a fast dive.
      if (this.agl <= Math.max(32, -vVert * 1.45 + 14) && vVert < -8) {
        this.deployParachute({ automatic: true });
      }
    }

    if (this.phase === 'canopy') {
      const previous = this.deployT;
      this.deployT = Math.min(1, previous + dt / this.openSeconds);
      if (previous < .46 && this.deployT >= .46) this.onLoad?.();
      if (this.pitch < -0.62) this.pitch = damp(this.pitch, -0.62, 5.5, dt);
      const load = THREE.MathUtils.smoothstep(this.deployT, .14, .79);
      this.pitchJolt = .21 * Math.sin(Math.PI * load) - .041 * Math.sin(Math.PI * this.deployT * 2);
      const flare = Math.max(0, -fIn);
      this.brakeLeft = damp(this.brakeLeft, clamp(flare - Math.min(0, rIn), 0, 1), 4.6, dt);
      this.brakeRight = damp(this.brakeRight, clamp(flare + Math.max(0, rIn), 0, 1), 4.6, dt);

      // Steering toggles yaw both the parafoil heading and the suspended jumper.
      const turnRate = (this.brakeRight - this.brakeLeft) * 1.14 * load;
      this.glideYaw += turnRate * dt;
      this.yaw += turnRate * dt;
      this.bankRoll = damp(this.bankRoll, turnRate * .28, 3.7, dt);

      _fwd.copy(_north).multiplyScalar(Math.cos(this.glideYaw)).addScaledVector(_east, Math.sin(this.glideYaw));
      const brake = Math.min(this.brakeLeft, this.brakeRight);
      const targetSink = 6.2 + 8.8 * Math.max(0, fIn) - 3.8 * brake + 2.4 * Math.abs(turnRate);
      const targetGlide = 14.8 + 12 * Math.max(0, fIn) - 9.6 * brake;

      vVert = damp(vVert, -targetSink, .12 + 3.8 * load, dt);
      const targetHoriz = _camRight.copy(_fwd).multiplyScalar(targetGlide);
      horizVel.lerp(targetHoriz, 1 - Math.exp(-dt * (.25 + 2.3 * load)));
    }

    this.velLocal.copy(horizVel).addScaledVector(_u, vVert);
    this.airspeed = this.velLocal.length();
    this.sinkRate = -vVert;
    this.posLocal.addScaledVector(this.velLocal, dt);

    r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / Math.max(r, 1));
    const surfaceR = this.measureClearance();
    const touchR = surfaceR + this.eyeHeight;

    if (r <= touchR) {
      this.posLocal.copy(_u).multiplyScalar(touchR);
      this.agl = 0;
      this.updateQuat();
      const landedPos = this.posLocal.clone();
      const landedCarry = horizVel.clone().multiplyScalar(0.55);
      const landedPlanet = p;
      const wasCanopy = this.phase === 'canopy';
      const impact = clamp((this.sinkRate - 1.5) / 9, .15, 1);
      this.frame(_u, _east, _north);
      const landedViewDir = _fwd.copy(_north).multiplyScalar(Math.cos(this.yaw))
        .addScaledVector(_east, Math.sin(this.yaw))
        .multiplyScalar(Math.cos(clamp(this.pitch, -0.6, 0.6)))
        .addScaledVector(_u, Math.sin(clamp(this.pitch, -0.6, 0.6)))
        .normalize();
      this.exit();
      this.onLand?.({
        planet: landedPlanet,
        posLocal: landedPos,
        viewDir: landedViewDir,
        carryHoriz: landedCarry,
        impact,
        water: (p.liquid === 'water' || p.liquid === 'toxic') && surfaceR === p.seaRadius,
      });
      if (wasCanopy) this.beginCollapse(landedPlanet, landedPos, this.quat);
      return;
    }

    this.updateQuat();
    this.syncRig();
  }

  // Touchdown follow-through: the gloves let go and drop clear while the
  // depressurised wing stalls behind the jumper as walking takes over.
  beginCollapse(planet = null, posLocal = null, camQuatLocal = null) {
    if (!this.rig) return;
    this.collapsing = true;
    this.collapse = 0;
    const pose = this.collapsePose;
    pose.phase = 'canopy';
    pose.deployT = 1;
    pose.time = this.time;
    pose.collapse = 0;
    pose.brakeLeft = this.brakeLeft;
    pose.brakeRight = this.brakeRight;
    pose.glideYaw = this.glideYaw;
    pose.frameAxis = this.frameAxis;
    this.rig.root.visible = true;
    if (planet && posLocal && camQuatLocal) {
      this.updateCollapse(0, planet, posLocal, camQuatLocal);
    }
  }

  updateCollapse(dt, planet, posLocal, camQuatLocal) {
    if (!this.collapsing) return;
    if (!planet) { this.endCollapse(); return; }
    if (dt > 0) this.collapse = Math.min(1, this.collapse + dt / .95);
    if (this.collapse >= 1) { this.endCollapse(); return; }
    const pose = this.collapsePose;
    pose.planet = planet;
    pose.posLocal.copy(posLocal);
    pose.quat.copy(camQuatLocal);
    pose.time += dt;
    pose.collapse = this.collapse;
    pose.brakeLeft = damp(pose.brakeLeft, 0, 6, dt);
    pose.brakeRight = damp(pose.brakeRight, 0, 6, dt);
    _u.copy(posLocal).normalize();
    const axis = Math.abs(_u.y) < .93 ? Y_AXIS : X_AXIS;
    _east.crossVectors(axis, _u).normalize();
    _north.crossVectors(_u, _east);
    _fwd.copy(_north).multiplyScalar(Math.cos(pose.glideYaw)).addScaledVector(_east, Math.sin(pose.glideYaw));
    _canopyRight.crossVectors(_fwd, _u).normalize();
    _canopyBack.copy(_fwd).negate();
    _q.setFromRotationMatrix(_m.makeBasis(_canopyRight, _u, _canopyBack));
    this.rig.update(pose, _q, this.dom.clientWidth / Math.max(1, this.dom.clientHeight));
  }

  endCollapse() {
    if (!this.collapsing) return;
    this.collapsing = false;
    this.collapse = 0;
    if (this.rig && !this.active) {
      this.rig.root.visible = false;
      this.rig.canopy.visible = false;
    }
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointercancel', this._onUp);
    if (this.rig) {
      this.scene.remove(this.rig.root);
      this.rig.dispose();
    }
  }
}
