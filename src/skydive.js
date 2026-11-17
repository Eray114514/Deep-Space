// First-person skydiving and ram-air parafoil controller (HALO / rugged-terrain
// hover jump). Operates in planet-local coordinates so planet orbit and axial
// rotation never introduce drift, and renders an overhead 7-cell ribbed
// parafoil canopy with suspension lines and steering toggles on FOREGROUND_LAYER.

import * as THREE from 'three';
import { keys } from './controls.js';
import { FOREGROUND_LAYER } from './render-layers.js';

const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);

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

/**
 * Build a 7-cell arched ram-air parafoil wing + ribs + 14 suspension lines +
 * left/right steering toggles, using a self-lit ripstop nylon shader (no scene
 * light dependencies, keeping world shader keys untouched).
 */
function buildParafoilRig() {
  const root = new THREE.Group();
  root.name = 'halcyon-parafoil-rig';
  root.visible = false;

  const canopyGroup = new THREE.Group();
  root.add(canopyGroup);

  const cells = 7;
  const span = 4.85;
  const chord = 1.84;
  const archDrop = 0.64;
  const baseHeight = 4.35;
  const segX = cells * 6;
  const segZ = 10;

  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];

  const cWhite = new THREE.Color(0xdce4ec);
  const cOrange = new THREE.Color(0xe85d1a);
  const cSlate = new THREE.Color(0x27323d);
  const cRib = new THREE.Color(0x1b232c);

  const airfoilProfile = (v, upper) => {
    // v in [0..1] from leading edge (-Z) to trailing edge (+Z)
    const camber = Math.sin(Math.PI * Math.pow(v, 0.78)) * 0.13;
    const thick = Math.sin(Math.PI * Math.pow(v, 0.62)) * (1 - 0.55 * v) * 0.115;
    return upper ? camber + thick : camber - thick * 0.38;
  };

  const canopyPoint = (u, v, upper, cellBillow = 1) => {
    // u in [-0.5..0.5] across span, v in [0..1] front-to-back
    const x = u * span;
    const archAngle = u * 0.62;
    const cellU = (u + 0.5) * cells;
    const cellFrac = cellU - Math.floor(cellU);
    const puff = Math.sin(Math.PI * clamp(cellFrac, 0, 1)) * 0.042 * (upper ? 1 : 0.35) * cellBillow;
    const profY = airfoilProfile(v, upper) + puff;
    const y = baseHeight - Math.sin(archAngle) * Math.sin(archAngle) * archDrop / 0.36 + profY;
    const z = (v - 0.56) * chord;
    return [x, y, z];
  };

  const pushShell = (upper) => {
    const baseVertex = positions.length / 3;
    for (let iz = 0; iz <= segZ; iz++) {
      const v = iz / segZ;
      for (let ix = 0; ix <= segX; ix++) {
        const u = ix / segX - 0.5;
        const [x, y, z] = canopyPoint(u, v, upper, 1);
        positions.push(x, y, z);
        const nx = -u * 0.55 * (upper ? 1 : -1);
        const ny = upper ? 1 : -1;
        const nz = (v - 0.35) * 0.25 * (upper ? 1 : -1);
        const inv = 1 / Math.hypot(nx, ny, nz);
        normals.push(nx * inv, ny * inv, nz * inv);

        const cellIdx = Math.min(cells - 1, Math.floor((u + 0.5) * cells));
        let col = cWhite;
        if (cellIdx === 0 || cellIdx === cells - 1) col = cOrange;
        else if (v < 0.20) col = cSlate;
        else if (cellIdx === 3 && v > 0.68) col = cOrange;
        colors.push(col.r, col.g, col.b);
      }
    }
    const row = segX + 1;
    for (let iz = 0; iz < segZ; iz++) {
      for (let ix = 0; ix < segX; ix++) {
        const a = baseVertex + iz * row + ix;
        const b = a + 1;
        const c = a + row;
        const d = c + 1;
        if (upper) indices.push(a, c, b, b, c, d);
        else indices.push(a, b, c, b, d, c);
      }
    }
  };

  pushShell(true);
  pushShell(false);

  // Internal vertical airfoil ribs between the 7 cells.
  for (let r = 0; r <= cells; r++) {
    const u = r / cells - 0.5;
    const baseVertex = positions.length / 3;
    for (let iz = 0; iz <= segZ; iz++) {
      const v = iz / segZ;
      const top = canopyPoint(u, v, true, 0);
      const bot = canopyPoint(u, v, false, 0);
      positions.push(top[0], top[1], top[2], bot[0], bot[1], bot[2]);
      normals.push(1, 0, 0, 1, 0, 0);
      colors.push(cRib.r, cRib.g, cRib.b, cRib.r, cRib.g, cRib.b);
    }
    for (let iz = 0; iz < segZ; iz++) {
      const a = baseVertex + iz * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
  }

  const canopyGeo = new THREE.BufferGeometry();
  canopyGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  canopyGeo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  canopyGeo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  canopyGeo.setIndex(indices);

  const uniforms = {
    uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.96, 0.90) },
    uSkyColor: { value: new THREE.Color(0.38, 0.52, 0.72) },
    uDeploy: { value: 1.0 },
    uTime: { value: 0.0 },
  };

  const canopyMat = new THREE.ShaderMaterial({
    name: 'halcyon-parafoil-ripstop',
    uniforms,
    side: THREE.DoubleSide,
    lights: false,
    vertexShader: /* glsl */ `
      attribute vec3 color;
      uniform float uDeploy;
      uniform float uTime;
      varying vec3 vColor;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      void main() {
        vColor = color;
        vec3 p = position;
        // Unfurl from overhead pack during deployment (0 -> 1)
        float open = clamp(uDeploy, 0.04, 1.0);
        p.x *= mix(0.14, 1.0, open);
        p.z *= mix(0.28, 1.0, open);
        p.y = mix(1.95, p.y, open);
        // Subtle trailing-edge fabric flutter in the airflow
        float flutter = sin(uTime * 19.0 + p.x * 5.2) * 0.008 * smoothstep(-0.1, 0.7, p.z);
        p.y += flutter;
        vLocalPos = p;
        vWorldNormal = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      varying vec3 vColor;
      varying vec3 vWorldNormal;
      varying vec3 vLocalPos;
      void main() {
        vec3 n = normalize(vWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
        vec3 L = normalize(uSunDir);
        float ndl = max(0.0, dot(n, L));
        // Ripstop nylon backlit translucency when looking up against the sun/sky
        float backlit = max(0.0, dot(-n, L)) * 0.52 + 0.16;
        float grid = 0.96 + 0.04 * step(0.5, fract(vLocalPos.x * 26.0)) * step(0.5, fract(vLocalPos.z * 26.0));
        vec3 hemi = uSkyColor * (0.36 + 0.28 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
        vec3 lit = vColor * grid * (hemi + uSunColor * (ndl * 0.85 + backlit));
        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });

  const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
  canopyMesh.frustumCulled = false;
  canopyGroup.add(canopyMesh);

  // Suspension lines converging from the 8 ribs (front & rear attachment tabs)
  // down to upper-peripheral riser shackles. Also animate lineunfurl in sync!
  const lineVerts = [];
  for (let r = 0; r <= cells; r++) {
    const u = r / cells - 0.5;
    const side = u < -0.02 ? -1 : u > 0.02 ? 1 : (r % 2 === 0 ? -1 : 1);
    const riser = [side * 0.44, 0.36, -0.44];
    for (const v of [0.16, 0.82]) {
      const attach = canopyPoint(u, v, false, 0);
      lineVerts.push(riser[0], riser[1], riser[2], attach[0], attach[1], attach[2]);
    }
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lineVerts, 3));
  const lineMat = new THREE.LineBasicMaterial({
    color: 0xc2ccd6,
    transparent: true,
    opacity: 0.82,
  });
  const lines = new THREE.LineSegments(lineGeo, lineMat);
  lines.frustumCulled = false;
  canopyGroup.add(lines);

  const makeHardwareMat = (hex) => new THREE.ShaderMaterial({
    uniforms: {
      uSunDir: uniforms.uSunDir,
      uSunColor: uniforms.uSunColor,
      uSkyColor: uniforms.uSkyColor,
      uBaseColor: { value: new THREE.Color(hex) },
    },
    lights: false,
    vertexShader: /* glsl */ `
      varying vec3 vNormalW;
      void main() {
        vNormalW = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uSunDir;
      uniform vec3 uSunColor;
      uniform vec3 uSkyColor;
      uniform vec3 uBaseColor;
      varying vec3 vNormalW;
      void main() {
        vec3 n = normalize(vNormalW);
        float ndl = max(0.0, dot(n, normalize(uSunDir)));
        vec3 hemi = uSkyColor * (0.34 + 0.30 * clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
        gl_FragColor = vec4(uBaseColor * (hemi + uSunColor * (0.14 + ndl * 0.90)), 1.0);
      }
    `,
  });

  // Slim woven riser straps rising from behind the shoulders to the upper corners.
  const strapGeo = new THREE.BoxGeometry(0.022, 0.34, 0.010);
  const strapMat = makeHardwareMat(0x232a33);
  for (const side of [-1, 1]) {
    const strap = new THREE.Mesh(strapGeo, strapMat);
    strap.position.set(side * 0.40, 0.24, -0.32);
    strap.rotation.x = -0.68;
    strap.rotation.z = -side * 0.22;
    strap.frustumCulled = false;
    root.add(strap);
  }

  // Left and right steering toggle handles + brake cords framed in upper peripheral vision.
  const toggleGeo = new THREE.TorusGeometry(0.038, 0.0085, 10, 20);
  const toggleMat = makeHardwareMat(0xe85d1a);
  const cordGeo = new THREE.CylinderGeometry(0.0022, 0.0022, 0.22, 6);
  cordGeo.translate(0, 0.11, 0);
  const cordMat = makeHardwareMat(0xd0d8e0);
  const makeToggle = () => {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(toggleGeo, toggleMat);
    const cord = new THREE.Mesh(cordGeo, cordMat);
    cord.position.set(0, 0.035, 0.008);
    cord.rotation.z = 0.05;
    ring.frustumCulled = false;
    cord.frustumCulled = false;
    g.add(ring, cord);
    return g;
  };
  const toggleLeft = makeToggle();
  const toggleRight = makeToggle();
  toggleLeft.position.set(-0.42, 0.24, -0.46);
  toggleRight.position.set(0.42, 0.24, -0.46);
  root.add(toggleLeft, toggleRight);

  root.traverse((obj) => obj.layers.set(FOREGROUND_LAYER));
  return { root, canopyGroup, uniforms, toggleLeft, toggleRight };
}

export class SkydiveController {
  constructor(dom, scene, {
    onDeploy = null,
    onAadWarning = null,
    onLand = null,
  } = {}) {
    this.dom = dom;
    this.scene = scene;
    this.onDeploy = onDeploy;
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

    this.rig = buildParafoilRig();
    this.scene.add(this.rig.root);

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
      this.pitch = clamp(this.pitch - my * 0.0024, -1.48, 1.46);
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
    if (Math.abs(up.y) < 0.93) east.crossVectors(Y_AXIS, up).normalize();
    else east.crossVectors(X_AXIS, up).normalize();
    north.crossVectors(up, east);
  }

  enter(planet, posLocal, viewDir, initialVelLocal = null) {
    this.active = true;
    this.planet = planet;
    this.phase = 'freefall';
    this.posLocal.copy(posLocal);
    if (initialVelLocal) this.velLocal.copy(initialVelLocal);
    else this.velLocal.set(0, 0, 0);

    _u.copy(posLocal).normalize();
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
    this.rig.root.visible = false;
    this.measureClearance();
    this.updateQuat();
  }

  exit() {
    this.active = false;
    this.planet = null;
    this.phase = 'idle';
    this.rig.root.visible = false;
    this.airspeed = 0;
  }

  deployParachute({ automatic = false } = {}) {
    if (!this.active || this.phase !== 'freefall') return false;
    this.phase = 'canopy';
    this.deployT = 0.02;
    this.glideYaw = this.yaw;
    this.pitchJolt = -0.24;
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
      return clamp((this.airspeed - 8) / 48, 0, 1) * 13.0;
    }
    const settle = smootherstep01(this.deployT);
    return lerp(11.5, 3.0, settle);
  }

  interactPrompt() {
    if (!this.active) return '';
    const meters = Math.max(0, Math.round(this.agl));
    if (this.phase === 'freefall') {
      return `[SPACE / F] 展开滑翔翼伞 · 离地高度 ${meters} m`;
    }
    if (this.aadTriggered && this.deployT < 0.95) {
      return `紧急自动开伞保护（AAD）已触发 · 离地 ${meters} m`;
    }
    return `WASD 控伞滑翔（W 俯冲 · S 减速飘降 · A/D 盘旋） · 离地 ${meters} m`;
  }

  updateQuat() {
    _u.copy(this.posLocal).normalize();
    this.frame(_u, _east, _north);
    _fwd.copy(_north).multiplyScalar(Math.cos(this.yaw)).addScaledVector(_east, Math.sin(this.yaw));
    const tremor = this.phase === 'freefall'
      ? Math.sin(this.time * 31.0) * 0.0032 * clamp(this.airspeed / 55, 0, 1)
      : 0;
    const effPitch = clamp(this.pitch + this.pitchJolt + tremor, -1.49, 1.47);
    _viewDir.copy(_fwd).multiplyScalar(Math.cos(effPitch)).addScaledVector(_u, Math.sin(effPitch));
    _camRight.crossVectors(_viewDir, _u);
    if (_camRight.lengthSq() < 1e-6) _camRight.set(1, 0, 0);
    _camRight.normalize();
    _camUp.crossVectors(_camRight, _viewDir);
    _m.makeBasis(_camRight, _camUp, _fwd.copy(_viewDir).negate());
    this.quat.setFromRotationMatrix(_m);
    if (Math.abs(this.bankRoll) > 1e-4) {
      this.quat.multiply(_qBank.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -this.bankRoll));
    }
  }

  syncCanopyRig() {
    if (!this.active || this.phase !== 'canopy' || !this.planet) {
      this.rig.root.visible = false;
      return;
    }
    this.rig.root.visible = true;
    this.rig.root.position.set(0, 0, 0);

    _u.copy(this.posLocal).normalize();
    this.frame(_u, _east, _north);
    _fwd.copy(_north).multiplyScalar(Math.cos(this.glideYaw)).addScaledVector(_east, Math.sin(this.glideYaw));
    _right.crossVectors(_fwd, _u).normalize();
    _canopyUp.copy(_u).addScaledVector(_right, Math.sin(this.bankRoll) * 0.85).normalize();
    _canopyRight.copy(_right).projectOnPlane(_canopyUp).normalize();
    _canopyBack.crossVectors(_canopyRight, _canopyUp).normalize();

    _m.makeBasis(_canopyRight, _canopyUp, _canopyBack);
    _q.setFromRotationMatrix(_m);
    this.rig.root.quaternion.copy(this.planet.frameOrientation).multiply(_q);

    const open = smootherstep01(this.deployT);
    this.rig.uniforms.uDeploy.value = open;
    this.rig.uniforms.uTime.value = this.time;
    if (this.planet.sunDirWorld) {
      this.rig.uniforms.uSunDir.value.copy(this.planet.sunDirWorld);
    }

    const fIn = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const rIn = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    const leftPull = clamp((fIn < 0 ? -fIn * 0.14 : 0) + (rIn < 0 ? -rIn * 0.16 : 0), 0, 0.22);
    const rightPull = clamp((fIn < 0 ? -fIn * 0.14 : 0) + (rIn > 0 ? rIn * 0.16 : 0), 0, 0.22);
    this.rig.toggleLeft.position.set(-0.42, 0.24 - leftPull * 0.75, -0.46);
    this.rig.toggleRight.position.set(0.42, 0.24 - rightPull * 0.75, -0.46);
  }

  update(dt) {
    if (!this.active || !this.planet) return;
    this.time += dt;
    const p = this.planet;
    const g = clamp(p.gravity || 9.8, 6.8, 14.2);

    const fIn = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const rIn = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);

    let r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / Math.max(r, 1));
    this.frame(_u, _east, _north);

    // Decompose current planet-local velocity into vertical (upward) and tangent components.
    let vVert = this.velLocal.dot(_u);
    const horizVel = _camUp.copy(this.velLocal).addScaledVector(_u, -vVert);

    if (this.phase === 'freefall') {
      _fwd.copy(_north).multiplyScalar(Math.cos(this.yaw)).addScaledVector(_east, Math.sin(this.yaw));
      _right.crossVectors(_fwd, _u).normalize();

      const terminalDown = fIn > 0 ? 68 : fIn < 0 ? 43 : 54;
      vVert -= g * dt;
      const drag = g / (terminalDown * terminalDown);
      if (vVert < 0) {
        vVert += drag * vVert * vVert * dt;
      }
      const targetHoriz = _camRight.set(0, 0, 0)
        .addScaledVector(_fwd, fIn * 21)
        .addScaledVector(_right, rIn * 15);
      horizVel.lerp(targetHoriz, 1 - Math.exp(-dt * 2.6));
      this.bankRoll = damp(this.bankRoll, rIn * 0.14, 5.5, dt);
      this.pitchJolt = damp(this.pitchJolt, 0, 6.0, dt);
      this.glideYaw = this.yaw;

      const surfaceR = this.measureClearance();
      // Automatic Activation Device (AAD) safety canopy deployment near ground.
      if (this.agl <= 32 && vVert < -10) {
        this.deployParachute({ automatic: true });
      } else {
        void surfaceR;
      }
    }

    if (this.phase === 'canopy') {
      this.deployT = Math.min(1, this.deployT + dt / 0.80);
      this.pitchJolt = damp(this.pitchJolt, 0, 3.8, dt);

      // Steering toggles yaw both the parafoil heading and the suspended jumper.
      const turnRate = -rIn * 1.32;
      this.glideYaw += turnRate * dt;
      this.yaw += turnRate * dt * 0.92;
      this.bankRoll = damp(this.bankRoll, rIn * 0.32, 4.6, dt);

      _fwd.copy(_north).multiplyScalar(Math.cos(this.glideYaw)).addScaledVector(_east, Math.sin(this.glideYaw));
      const targetSink = fIn > 0 ? 8.8 : fIn < 0 ? 3.1 : 5.6;
      const targetGlide = fIn > 0 ? 18.5 : fIn < 0 ? 4.2 : 11.2;

      vVert = damp(vVert, -targetSink, 4.4, dt);
      const targetHoriz = _camRight.copy(_fwd).multiplyScalar(targetGlide);
      horizVel.lerp(targetHoriz, 1 - Math.exp(-dt * 3.8));
    }

    this.velLocal.copy(horizVel).addScaledVector(_u, vVert);
    this.airspeed = this.velLocal.length();
    this.posLocal.addScaledVector(this.velLocal, dt);

    r = this.posLocal.length();
    _u.copy(this.posLocal).multiplyScalar(1 / Math.max(r, 1));
    const groundSurfaceR = p.surfaceRadius(_u);
    const touchR = groundSurfaceR + this.eyeHeight;
    this.agl = Math.max(0, r - groundSurfaceR);

    if (r <= touchR) {
      this.posLocal.copy(_u).multiplyScalar(touchR);
      this.agl = 0;
      this.updateQuat();
      const landedPos = this.posLocal.clone();
      const landedCarry = horizVel.clone().multiplyScalar(0.55);
      const landedPlanet = p;
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
      });
      return;
    }

    this.updateQuat();
    this.syncCanopyRig();
  }

  dispose() {
    this.dom.removeEventListener('pointermove', this._onMove);
    this.dom.removeEventListener('pointerdown', this._onDown);
    this.dom.removeEventListener('pointerup', this._onUp);
    this.dom.removeEventListener('pointercancel', this._onUp);
    this.scene.remove(this.rig.root);
  }
}
