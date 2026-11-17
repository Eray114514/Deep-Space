// Golden Hour destructible architectural glass panes (Ew) & Verlet shootable
// physics props (_w), adapted into a local tangent-space controller for Deep Space.
//
// Operates inside a caller-supplied local tangent `THREE.Group` (`root`, where
// +Y is local surface up and `groundHeight(x, z)` returns local terrain height),
// matching `SurveyUnits` in `src/saltline/robots.js`. All materials use
// `MeshStandardMaterial` (preserving Three.js's `#include <logdepthbuf_...>`
// chunks) so glass panes, tumbling shards, frames, and debris never Z-fight in
// Deep Space's astronomical logarithmic depth buffer.

import * as THREE from 'three';

const MAX_SHARDS = 3200;
const MAX_CHUNKS = 320;
const GRAVITY = 9.81;

const ZERO_SCALE_MAT = new THREE.Matrix4().makeScale(0, 0, 0);
const _mat4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _invQuat = new THREE.Quaternion();
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _axX = new THREE.Vector3();
const _axY = new THREE.Vector3();
const _axZ = new THREE.Vector3();
const _color = new THREE.Color();
const _cellIdx = new Int32Array(6);
const _cornerWeights = new Float32Array(8);

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

function saturate(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function makeSeededRng(seed = 4107) {
  let state = (seed >>> 0) || 1;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + (hi - lo) * next();
  next.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * next());
  next.sign = () => (next() < 0.5 ? -1 : 1);
  return next;
}

function toVec3(input, out = new THREE.Vector3()) {
  if (!input) return out.set(0, 0, 0);
  if (Array.isArray(input)) return out.set(Number(input[0]) || 0, Number(input[1]) || 0, Number(input[2]) || 0);
  return out.set(Number(input.x) || 0, Number(input.y) || 0, Number(input.z) || 0);
}

// Architectural glass material with procedural Voronoi fracture lines (adapted
// from Golden Hour's `d$`). Built on `MeshStandardMaterial` so Three.js's
// logarithmic depth buffer (`#include <logdepthbuf_...>`) remains active.
export function createDestructibleGlassMaterial() {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xb9d4f8,
    roughness: 0.04,
    metalness: 0.0,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
    envMapIntensity: 2.2,
  });

  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
attribute float crack;
varying float vCrack;
varying vec2 vGuv;`
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
vCrack = crack;
vGuv = uv;`
      );

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vCrack;
varying vec2 vGuv;
vec2 ghGlassHash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float ghGlassEdge(vec2 x) {
  vec2 n = floor(x), f = fract(x);
  vec2 mg = vec2(0.0), mr = vec2(0.0);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + ghGlassHash2(n + g) - f;
      float d = dot(r, r);
      if (d < md) { md = d; mr = r; mg = g; }
    }
  }
  md = 8.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      vec2 g = mg + vec2(float(i), float(j));
      vec2 r = g + ghGlassHash2(n + g) - f;
      if (dot(mr - r, mr - r) > 0.00001) {
        md = min(md, dot(0.5 * (mr + r), normalize(r - mr)));
      }
    }
  }
  return md;
}`
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
float gCk = 0.0;
if (vCrack > 0.01) {
  vec2 gq = vGuv * 5.5;
  float e = min(ghGlassEdge(gq), ghGlassEdge(gq * 2.7 + 3.7) * 0.75);
  float aw = fwidth(gq.x) + fwidth(gq.y) + 0.004;
  float ln = (1.0 - smoothstep(aw * 0.5, aw * 1.6 + 0.012, e)) * smoothstep(1.2, 0.25, aw);
  gCk = vCrack * (0.06 + 0.94 * ln);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.92, 0.97, 1.0), gCk);
  diffuseColor.a = clamp(diffuseColor.a + vCrack * (0.04 + 0.82 * ln), 0.0, 1.0);
}`
      )
      .replace(
        '#include <opaque_fragment>',
        `float gFres = pow(clamp(1.0 - abs(dot(normalize(vViewPosition), normal)), 0.0, 1.0), 4.0);
float gA = clamp(diffuseColor.a + gFres * 0.45, 0.0, 1.0);
gl_FragColor = vec4(totalDiffuse * mix(0.14, 0.65, gCk) + totalEmissiveRadiance + totalSpecular / max(gA, 0.06), gA);`
      );
  };

  mat.customProgramCacheKey = () => 'ds-gh-destructible-glass-v1';
  return mat;
}

const SURFACE_DEBRIS_COLOR = {
  ceramic: 0xe9e5da,
  glass: 0xcbe2fa,
  wood: 0x6b4a2e,
  plastic: 0xd9a81e,
  fabric: 0x4c5860,
  stone: 0x9b968c,
  metal: 0x8d939a,
};

export class OutpostDestructibles {
  constructor({
    root = null,
    groundHeight = (_x, _z) => 0,
    onAudio = null,
    onFx = null,
    seed = 4107,
  } = {}) {
    this.root = root || new THREE.Group();
    if (!this.root.name) this.root.name = 'outpost-destructibles';
    this.groundHeight = typeof groundHeight === 'function' ? groundHeight : () => 0;
    this.onAudio = typeof onAudio === 'function' ? onAudio : null;
    this.onFx = typeof onFx === 'function' ? onFx : null;
    this.rng = makeSeededRng(seed);
    this.time = 0;

    this.panes = [];
    this.props = [];
    this._hPrev = 1 / 90;
    this._h = 1 / 90;
    this._floodVisited = new Uint8Array(1024);
    this._floodStack = new Int32Array(1024);

    // Shared materials & geometries
    this.glassMaterial = createDestructibleGlassMaterial();
    this.frameMaterial = new THREE.MeshStandardMaterial({
      color: 0x262a30,
      roughness: 0.44,
      metalness: 0.78,
    });
    this._unitFrameBox = new THREE.BoxGeometry(1, 1, 1);

    // Tumbling 3D triangular glass shard pool (Golden Hour Ew)
    this._shardPos = new Float32Array(MAX_SHARDS * 3);
    this._shardVel = new Float32Array(MAX_SHARDS * 3);
    this._shardLocalTri = new Float32Array(MAX_SHARDS * 9);
    this._shardAxis = new Float32Array(MAX_SHARDS * 3);
    this._shardAngle = new Float32Array(MAX_SHARDS);
    this._shardSpin = new Float32Array(MAX_SHARDS);
    this._shardLife = new Float32Array(MAX_SHARDS);
    this._shardState = new Uint8Array(MAX_SHARDS); // 0 = dead, 1 = flying, 2 = settled
    this._shardBounces = new Uint8Array(MAX_SHARDS);
    this._shardCursor = 0;
    this.activeShards = 0;

    this.shardGeometry = new THREE.BufferGeometry();
    this._shardPosAttr = new THREE.BufferAttribute(new Float32Array(MAX_SHARDS * 9), 3);
    this._shardPosAttr.setUsage(THREE.DynamicDrawUsage);
    this._shardNrmAttr = new THREE.BufferAttribute(new Float32Array(MAX_SHARDS * 9), 3);
    this._shardNrmAttr.setUsage(THREE.DynamicDrawUsage);
    const shardUv = new Float32Array(MAX_SHARDS * 6);
    const shardCrack = new Float32Array(MAX_SHARDS * 3);
    for (let i = 0; i < MAX_SHARDS; i++) {
      const u0 = this.rng(), v0 = this.rng();
      shardUv.set([u0, v0, u0 + 0.2, v0, u0, v0 + 0.2], i * 6);
      shardCrack.fill(0.26, i * 3, i * 3 + 3);
    }
    this.shardGeometry.setAttribute('position', this._shardPosAttr);
    this.shardGeometry.setAttribute('normal', this._shardNrmAttr);
    this.shardGeometry.setAttribute('uv', new THREE.BufferAttribute(shardUv, 2));
    this.shardGeometry.setAttribute('crack', new THREE.BufferAttribute(shardCrack, 1));
    this.shardMesh = new THREE.Mesh(this.shardGeometry, this.glassMaterial);
    this.shardMesh.name = 'destructible-glass-shards';
    this.shardMesh.frustumCulled = false;
    this.shardMesh.renderOrder = 11;
    this.root.add(this.shardMesh);

    // Tumbling 3D instanced debris chunks pool (Golden Hour _w)
    this._chunkGeom = new THREE.BoxGeometry(1, 1, 1);
    this._chunkMat = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.18 });
    this.chunkMesh = new THREE.InstancedMesh(this._chunkGeom, this._chunkMat, MAX_CHUNKS);
    this.chunkMesh.name = 'destructible-debris-chunks';
    this.chunkMesh.frustumCulled = false;
    this.chunkMesh.castShadow = true;
    this.chunkMesh.receiveShadow = true;
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunkMesh.setMatrixAt(i, ZERO_SCALE_MAT);
      this.chunkMesh.setColorAt(i, _color.setHex(0xffffff));
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;
    if (this.chunkMesh.instanceColor) this.chunkMesh.instanceColor.needsUpdate = true;
    this.root.add(this.chunkMesh);

    this._chunks = {
      x: new Float32Array(MAX_CHUNKS * 3),
      v: new Float32Array(MAX_CHUNKS * 3),
      s: new Float32Array(MAX_CHUNKS * 3),
      ax: new Float32Array(MAX_CHUNKS * 3),
      ang: new Float32Array(MAX_CHUNKS),
      w: new Float32Array(MAX_CHUNKS),
      life: new Float32Array(MAX_CHUNKS),
      st: new Uint8Array(MAX_CHUNKS),
      b: new Uint8Array(MAX_CHUNKS),
      cursor: 0,
    };
    this.activeChunks = 0;
  }

  _emitAudio(event, pos, detail = {}) {
    if (this.onAudio) this.onAudio({ event, position: pos.clone(), ...detail });
  }

  _emitFx(event, pos, detail = {}) {
    if (this.onFx) this.onFx({ event, position: pos.clone(), ...detail });
  }

  _sampleGround(x, z) {
    const h = this.groundHeight(x, z);
    return Number.isFinite(h) ? h : 0;
  }

  _sampleGroundNormal(x, z, out) {
    const eps = 0.2;
    const hx = this._sampleGround(x + eps, z) - this._sampleGround(x - eps, z);
    const hz = this._sampleGround(x, z + eps) - this._sampleGround(x, z - eps);
    return out.set(-hx / (2 * eps), 1, -hz / (2 * eps)).normalize();
  }

  // ---------------------------------------------------------------------------
  // Architectural Destructible Glass Panes (Ew)
  // ---------------------------------------------------------------------------

  addGlassPane({
    center,
    width = 2.0,
    height = 2.2,
    yaw = 0,
    hp = 35,
    frame = true,
    cell = 0.22,
    support = 'frame',
  } = {}) {
    const c = toVec3(center, new THREE.Vector3());
    const w = Math.max(0.25, Number(width) || 2.0);
    const h = Math.max(0.25, Number(height) || 2.2);
    const nx = Math.max(2, Math.round(w / cell));
    const ny = Math.max(2, Math.round(h / cell));

    // Local tangent basis of the pane: uAxis along width, +Y along height, nAxis = uAxis x +Y
    const cosY = Math.cos(yaw);
    const sinY = Math.sin(yaw);
    const uAxis = new THREE.Vector3(cosY, 0, -sinY);
    const nAxis = new THREE.Vector3(sinY, 0, cosY);

    const group = new THREE.Group();
    group.name = `glass-pane-${this.panes.length}`;
    group.position.copy(c);
    group.rotation.set(0, yaw, 0);

    // Intact glass quad
    const intactGeo = new THREE.PlaneGeometry(w, h);
    intactGeo.setAttribute('crack', new THREE.BufferAttribute(new Float32Array(4), 1));
    const intactMesh = new THREE.Mesh(intactGeo, this.glassMaterial);
    intactMesh.renderOrder = 10;
    group.add(intactMesh);

    // Architectural metallic window frame
    if (frame) {
      const bar = 0.04;
      const depth = 0.06;
      const addMullion = (px, py, sx, sy) => {
        const m = new THREE.Mesh(this._unitFrameBox, this.frameMaterial);
        m.position.set(px, py, 0);
        m.scale.set(sx, sy, depth);
        m.castShadow = true;
        m.receiveShadow = true;
        group.add(m);
      };
      addMullion(0, h * 0.5 + bar * 0.5, w + bar * 2, bar);
      addMullion(0, -h * 0.5 - bar * 0.5, w + bar * 2, bar);
      addMullion(-w * 0.5 - bar * 0.5, 0, bar, h);
      addMullion(w * 0.5 + bar * 0.5, 0, bar, h);
    }

    this.root.add(group);

    const pane = {
      id: this.panes.length,
      kind: 'glass',
      center: c,
      width: w,
      height: h,
      yaw,
      uAxis,
      nAxis,
      nx,
      ny,
      total: nx * ny,
      count: nx * ny,
      hp: Math.max(1, Number(hp) || 35),
      maxHp: Math.max(1, Number(hp) || 35),
      support,
      group,
      intactGeo,
      intactMesh,
      fractureMesh: null,
      alive: null,
      crack: null,
      verts: null,
      diag: null,
      cascade: null,
      dirty: false,
      intact: true,
      cracked: false,
      shattered: false,
      gone: false,
      colliderOff: false,
    };

    this.panes.push(pane);
    return pane;
  }

  _panePointToLocal(pane, u, v, out) {
    return out
      .copy(pane.center)
      .addScaledVector(pane.uAxis, u)
      .setY(pane.center.y + v);
  }

  _cellTriangles(pane, cellIndex, out) {
    const ix = cellIndex % pane.nx;
    const iy = (cellIndex / pane.nx) | 0;
    const stride = pane.nx + 1;
    const r0 = iy * stride + ix;
    const r1 = r0 + 1;
    const r2 = r0 + stride;
    const r3 = r2 + 1;
    if (pane.diag[cellIndex]) {
      out[0] = r0; out[1] = r1; out[2] = r3;
      out[3] = r0; out[4] = r3; out[5] = r2;
    } else {
      out[0] = r0; out[1] = r1; out[2] = r2;
      out[3] = r1; out[4] = r3; out[5] = r2;
    }
    return out;
  }

  _fracturePane(pane) {
    if (pane.alive) return;
    const { nx, ny, width: w, height: h } = pane;
    const prng = makeSeededRng(pane.id * 7919 + 13);

    pane.intact = false;
    pane.cracked = true;
    pane.alive = new Uint8Array(nx * ny).fill(1);
    pane.crack = new Float32Array(nx * ny);
    pane.diag = new Uint8Array(nx * ny);
    pane.verts = new Float32Array((nx + 1) * (ny + 1) * 2);

    const cw = w / nx;
    const ch = h / ny;
    for (let iy = 0; iy <= ny; iy++) {
      for (let ix = 0; ix <= nx; ix++) {
        const idx = (iy * (nx + 1) + ix) * 2;
        const jx = ix > 0 && ix < nx ? prng.range(-0.36, 0.36) : 0;
        const jy = iy > 0 && iy < ny ? prng.range(-0.36, 0.36) : 0;
        pane.verts[idx] = -w * 0.5 + (ix + jx) * cw;
        pane.verts[idx + 1] = -h * 0.5 + (iy + jy) * ch;
      }
    }
    for (let i = 0; i < nx * ny; i++) {
      pane.diag[i] = prng() < 0.5 ? 1 : 0;
    }

    const vertCount = nx * ny * 6;
    const pos = new Float32Array(vertCount * 3);
    const nrm = new Float32Array(vertCount * 3);
    const uv = new Float32Array(vertCount * 2);
    const crack = new Float32Array(vertCount);

    for (let i = 0; i < vertCount; i++) {
      nrm[i * 3] = pane.nAxis.x;
      nrm[i * 3 + 1] = pane.nAxis.y;
      nrm[i * 3 + 2] = pane.nAxis.z;
    }

    for (let c = 0; c < nx * ny; c++) {
      const tri = this._cellTriangles(pane, c, _cellIdx);
      for (let k = 0; k < 6; k++) {
        const u = pane.verts[tri[k] * 2];
        const v = pane.verts[tri[k] * 2 + 1];
        const pOff = (c * 6 + k) * 3;
        pos[pOff] = pane.center.x + pane.uAxis.x * u;
        pos[pOff + 1] = pane.center.y + v;
        pos[pOff + 2] = pane.center.z + pane.uAxis.z * u;
        const uvOff = (c * 6 + k) * 2;
        uv[uvOff] = u + w * 0.5;
        uv[uvOff + 1] = v + h * 0.5;
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('crack', new THREE.BufferAttribute(crack, 1));

    const mesh = new THREE.Mesh(geo, this.glassMaterial);
    mesh.name = `glass-fractured-${pane.id}`;
    mesh.frustumCulled = false;
    mesh.renderOrder = 10;
    this.root.add(mesh);

    pane.fractureMesh = mesh;
    pane.intactMesh.visible = false;
  }

  _spawnGlassShard(pane, u0, v0, u1, v1, u2, v2, vx, vy, vz, jitter) {
    let slot = this._shardCursor;
    let guard = 0;
    while (this._shardState[slot] === 1 && guard < 64) {
      slot = (slot + 1) % MAX_SHARDS;
      guard++;
    }
    this._shardCursor = (slot + 1) % MAX_SHARDS;

    const cu = (u0 + u1 + u2) / 3;
    const cv = (v0 + v1 + v2) / 3;
    const triBase = slot * 9;
    const ux = pane.uAxis.x;
    const uz = pane.uAxis.z;
    const writeLocalVert = (off, u, v) => {
      const du = u - cu;
      const dv = v - cv;
      this._shardLocalTri[triBase + off] = ux * du;
      this._shardLocalTri[triBase + off + 1] = dv;
      this._shardLocalTri[triBase + off + 2] = uz * du;
    };
    writeLocalVert(0, u0, v0);
    writeLocalVert(3, u1, v1);
    writeLocalVert(6, u2, v2);

    this._panePointToLocal(pane, cu, cv, _v0);
    const pBase = slot * 3;
    this._shardPos[pBase] = _v0.x;
    this._shardPos[pBase + 1] = _v0.y;
    this._shardPos[pBase + 2] = _v0.z;

    this._shardVel[pBase] = vx + this.rng.range(-1, 1) * jitter;
    this._shardVel[pBase + 1] = vy + this.rng.range(-0.6, 1.0) * jitter;
    this._shardVel[pBase + 2] = vz + this.rng.range(-1, 1) * jitter;

    const ax = this.rng.range(-1, 1);
    const ay = this.rng.range(-1, 1);
    const az = this.rng.range(-1, 1);
    const aLen = Math.hypot(ax, ay, az) || 1;
    this._shardAxis[pBase] = ax / aLen;
    this._shardAxis[pBase + 1] = ay / aLen;
    this._shardAxis[pBase + 2] = az / aLen;

    this._shardAngle[slot] = 0;
    this._shardSpin[slot] = this.rng.range(4, 16) * this.rng.sign();
    this._shardLife[slot] = 0;
    this._shardBounces[slot] = 0;

    if (this._shardState[slot] === 0) this.activeShards++;
    this._shardState[slot] = 1;

    // Seed initial triangle positions immediately so raycasts/inspections see valid non-zero shards
    this._writeShardVertices(slot, false, 0);
    this._shardPosAttr.needsUpdate = true;
    this._shardNrmAttr.needsUpdate = true;
  }

  _writeShardVertices(slot, flatOnGround, groundY) {
    const pBase = slot * 3;
    const triBase = slot * 9;
    const px = this._shardPos[pBase];
    const py = this._shardPos[pBase + 1];
    const pz = this._shardPos[pBase + 2];
    const ax = this._shardAxis[pBase];
    const ay = this._shardAxis[pBase + 1];
    const az = this._shardAxis[pBase + 2];
    const cosA = Math.cos(this._shardAngle[slot]);
    const sinA = Math.sin(this._shardAngle[slot]);
    const oneMinusCos = 1 - cosA;
    const outPos = this._shardPosAttr.array;
    const outNrm = this._shardNrmAttr.array;

    for (let k = 0; k < 9; k += 3) {
      const lx = this._shardLocalTri[triBase + k];
      const ly = this._shardLocalTri[triBase + k + 1];
      const lz = this._shardLocalTri[triBase + k + 2];
      const dot = ax * lx + ay * ly + az * lz;
      const rx = lx * cosA + (ay * lz - az * ly) * sinA + ax * dot * oneMinusCos;
      let ry = ly * cosA + (az * lx - ax * lz) * sinA + ay * dot * oneMinusCos;
      const rz = lz * cosA + (ax * ly - ay * lx) * sinA + az * dot * oneMinusCos;
      if (flatOnGround) ry = 0.004 + k * 0.0007;
      outPos[triBase + k] = px + rx;
      outPos[triBase + k + 1] = (flatOnGround ? groundY : py) + ry;
      outPos[triBase + k + 2] = pz + rz;
    }

    const e1x = outPos[triBase + 3] - outPos[triBase];
    const e1y = outPos[triBase + 4] - outPos[triBase + 1];
    const e1z = outPos[triBase + 5] - outPos[triBase + 2];
    const e2x = outPos[triBase + 6] - outPos[triBase];
    const e2y = outPos[triBase + 7] - outPos[triBase + 1];
    const e2z = outPos[triBase + 8] - outPos[triBase + 2];
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;
    const nLen = Math.hypot(nx, ny, nz) || 1;
    nx /= nLen; ny /= nLen; nz /= nLen;
    for (let k = 0; k < 9; k += 3) {
      outNrm[triBase + k] = nx;
      outNrm[triBase + k + 1] = ny;
      outNrm[triBase + k + 2] = nz;
    }
  }

  _breakCell(pane, cellIndex, vx, vy, vz, jitter) {
    if (!pane.alive[cellIndex]) return 0;
    pane.alive[cellIndex] = 0;
    pane.count--;
    const posArr = pane.fractureMesh.geometry.attributes.position.array;
    const tri = this._cellTriangles(pane, cellIndex, _cellIdx);
    const verts = pane.verts;
    for (let t = 0; t < 2; t++) {
      const i0 = tri[t * 3];
      const i1 = tri[t * 3 + 1];
      const i2 = tri[t * 3 + 2];
      this._spawnGlassShard(
        pane,
        verts[i0 * 2], verts[i0 * 2 + 1],
        verts[i1 * 2], verts[i1 * 2 + 1],
        verts[i2 * 2], verts[i2 * 2 + 1],
        vx, vy, vz, jitter
      );
    }
    posArr.fill(0, cellIndex * 18, cellIndex * 18 + 18);
    pane.dirty = true;
    return 2;
  }

  _settlePane(pane, pushSign) {
    const { nx, ny, alive } = pane;
    const total = nx * ny;
    if (this._floodVisited.length < total) {
      this._floodVisited = new Uint8Array(total * 2);
      this._floodStack = new Int32Array(total * 2);
    }
    const vis = this._floodVisited;
    const stack = this._floodStack;
    vis.fill(0, 0, total);
    let sp = 0;
    const push = (idx) => {
      if (alive[idx] && !vis[idx]) {
        vis[idx] = 1;
        stack[sp++] = idx;
      }
    };
    for (let ix = 0; ix < nx; ix++) {
      push(ix);
      if (pane.support === 'frame') push((ny - 1) * nx + ix);
    }
    if (pane.support === 'frame') {
      for (let iy = 0; iy < ny; iy++) {
        push(iy * nx);
        push(iy * nx + nx - 1);
      }
    }
    while (sp > 0) {
      const cur = stack[--sp];
      const ix = cur % nx;
      const iy = (cur / nx) | 0;
      if (ix > 0) push(cur - 1);
      if (ix < nx - 1) push(cur + 1);
      if (iy > 0) push(cur - nx);
      if (iy < ny - 1) push(cur + nx);
    }
    const vx = pane.nAxis.x * pushSign * 0.5;
    const vz = pane.nAxis.z * pushSign * 0.5;
    let spawned = 0;
    for (let idx = 0; idx < total; idx++) {
      if (alive[idx] && !vis[idx]) {
        spawned += this._breakCell(pane, idx, vx, -0.35, vz, 0.5);
      }
    }
    return spawned;
  }

  _commitPane(pane) {
    if (!pane.fractureMesh) return;
    const geo = pane.fractureMesh.geometry;
    geo.attributes.position.needsUpdate = true;
    const crackArr = geo.attributes.crack.array;
    for (let i = 0; i < pane.total; i++) {
      crackArr.fill(pane.crack[i], i * 6, i * 6 + 6);
    }
    geo.attributes.crack.needsUpdate = true;
    pane.dirty = false;
  }

  _shatterPane(pane, uHit, vHit, dir, intensity = 1) {
    if (pane.gone || pane.cascade) return 0;
    this._fracturePane(pane);
    pane.shattered = true;
    pane.colliderOff = true;
    pane.cascade = {
      u: uHit,
      v: vHit,
      t: 0,
      dx: dir.x,
      dy: dir.y,
      dz: dir.z,
      k: intensity,
    };

    // Immediately burst inner core cells so shards are live on frame 0
    let spawned = this._stepPaneCascade(pane, 0.03);
    this._panePointToLocal(pane, uHit, vHit, _v1);
    this._emitAudio('glassShatter', _v1, { intensity: saturate((pane.width * pane.height) / 7) });
    this._emitFx('glassShatter', _v1, { direction: dir.clone(), intensity });
    return spawned;
  }

  _stepPaneCascade(pane, dt) {
    const s = pane.cascade;
    if (!s) return 0;
    s.t += dt;
    const waveRadius = s.t * 12 + 0.25;
    const cw = pane.width / pane.nx;
    const ch = pane.height / pane.ny;
    const speed = 2.4 * s.k;
    let remaining = 0;
    let spawned = 0;

    for (let c = 0; c < pane.total; c++) {
      if (!pane.alive[c]) continue;
      const ix = c % pane.nx;
      const iy = (c / pane.nx) | 0;
      const cu = -pane.width * 0.5 + (ix + 0.5) * cw;
      const cv = -pane.height * 0.5 + (iy + 0.5) * ch;
      const dist = Math.hypot(cu - s.u, cv - s.v);
      if (dist < waveRadius) {
        const falloff = Math.min(1, dist / 1.2);
        const outU = (cu - s.u) * 0.65;
        const vx = s.dx * speed * (1.6 - falloff) + pane.uAxis.x * outU;
        const vy = s.dy * speed * 0.45 + (cv - s.v) * 0.35;
        const vz = s.dz * speed * (1.6 - falloff) + pane.uAxis.z * outU;
        spawned += this._breakCell(pane, c, vx, vy, vz, 0.95);
      } else {
        remaining++;
      }
    }

    if (remaining === 0) {
      pane.gone = true;
      pane.cascade = null;
      if (pane.fractureMesh) {
        this.root.remove(pane.fractureMesh);
        pane.fractureMesh.geometry.dispose();
        pane.fractureMesh = null;
      }
      pane.dirty = false;
    } else if (pane.dirty) {
      this._commitPane(pane);
    }
    return spawned;
  }

  _hitGlassPane(pane, hitPointLocal, damage, dir, impulse) {
    if (pane.gone) return 0;
    this._fracturePane(pane);
    pane.hp = Math.max(0, pane.hp - damage);

    _v2.subVectors(hitPointLocal, pane.center);
    const uHit = clamp(_v2.dot(pane.uAxis), -pane.width * 0.5, pane.width * 0.5);
    const vHit = clamp(hitPointLocal.y - pane.center.y, -pane.height * 0.5, pane.height * 0.5);

    const cw = pane.width / pane.nx;
    const ch = pane.height / pane.ny;
    const power = clamp(impulse / 6, 0.5, 2.5);
    const holeRadius = this.rng.range(0.14, 0.25) * power;
    const pushSign = dir.dot(pane.nAxis) >= 0 ? 1 : -1;
    const baseSpeed = 2.2 + 2.0 * power;
    const vx = dir.x * baseSpeed;
    const vy = dir.y * baseSpeed * 0.5;
    const vz = dir.z * baseSpeed;

    const uMin = -pane.width * 0.5;
    const vMin = -pane.height * 0.5;
    const ix0 = Math.max(0, Math.floor((uHit - holeRadius * 3.6 - uMin) / cw));
    const ix1 = Math.min(pane.nx - 1, Math.floor((uHit + holeRadius * 3.6 - uMin) / cw));
    const iy0 = Math.max(0, Math.floor((vHit - holeRadius * 3.6 - vMin) / ch));
    const iy1 = Math.min(pane.ny - 1, Math.floor((vHit + holeRadius * 3.6 - vMin) / ch));
    const centerIx = clamp(Math.floor((uHit - uMin) / cw), 0, pane.nx - 1);
    const centerIy = clamp(Math.floor((vHit - vMin) / ch), 0, pane.ny - 1);

    let spawned = 0;
    for (let iy = iy0; iy <= iy1; iy++) {
      for (let ix = ix0; ix <= ix1; ix++) {
        const idx = iy * pane.nx + ix;
        const cu = uMin + (ix + 0.5) * cw;
        const cv = vMin + (iy + 0.5) * ch;
        const dist = Math.hypot(cu - uHit, cv - vHit);
        const jitterR = holeRadius * (0.72 + 0.56 * (Math.abs(Math.sin(idx * 12.9898) * 43758.5453) % 1));
        if (dist < jitterR || (ix === centerIx && iy === centerIy)) {
          spawned += this._breakCell(pane, idx, vx, vy, vz, 1.2);
        } else if (pane.alive[idx]) {
          const ck = saturate(1 - (dist - jitterR) / (holeRadius * 2.8));
          if (ck > pane.crack[idx]) pane.crack[idx] = ck;
        }
      }
    }

    spawned += this._settlePane(pane, pushSign);
    this._commitPane(pane);

    this._emitAudio('glassCrack', hitPointLocal);
    this._emitFx('glassChips', hitPointLocal, { direction: dir.clone() });

    if (pane.hp <= 0 || pane.count < pane.total * 0.42) {
      spawned += this._shatterPane(pane, uHit, vHit, dir, Math.max(0.8, power));
    }
    return spawned;
  }

  // ---------------------------------------------------------------------------
  // Shootable / Breakable Verlet Physics Props (_w)
  // ---------------------------------------------------------------------------

  addPhysicsProp(meshGroup, {
    pos = [0, 0, 0],
    yaw = 0,
    size = null,
    mass = 2,
    breakable = false,
    explosive = false,
    hp = null,
    surface = null,
  } = {}) {
    if (!meshGroup) throw new Error('addPhysicsProp requires a THREE.Object3D meshGroup');

    // Measure local geometry bounds before placing so both floor-origin and center-origin props align cleanly
    meshGroup.position.set(0, 0, 0);
    meshGroup.rotation.set(0, 0, 0);
    meshGroup.scale.set(1, 1, 1);
    meshGroup.updateMatrixWorld(true);
    const localBox = new THREE.Box3().setFromObject(meshGroup);
    const boxSize = new THREE.Vector3();
    const boxCenter = new THREE.Vector3();
    if (!localBox.isEmpty()) {
      localBox.getSize(boxSize);
      localBox.getCenter(boxCenter);
    } else {
      boxSize.set(0.3, 0.3, 0.3);
      boxCenter.set(0, 0.15, 0);
    }

    const udSize = Array.isArray(size) ? size : meshGroup.userData?.size;
    const sx = Math.max(0.06, Number(udSize?.[0]) || boxSize.x || 0.3);
    const sy = Math.max(0.06, Number(udSize?.[1]) || boxSize.y || 0.3);
    const sz = Math.max(0.06, Number(udSize?.[2]) || boxSize.z || 0.3);
    const centerOffset = [
      Number.isFinite(boxCenter.x) ? boxCenter.x : 0,
      Number.isFinite(boxCenter.y) ? boxCenter.y : sy * 0.5,
      Number.isFinite(boxCenter.z) ? boxCenter.z : 0,
    ];

    const p = toVec3(pos, new THREE.Vector3());
    // Ensure bottom of prop sits at or above pos.y if local origin was centered (e.g. wall-mounted extinguisher placed on floor)
    if (!localBox.isEmpty() && localBox.min.y < -0.04 && p.y <= this._sampleGround(p.x, p.z) + 0.02) {
      p.y -= localBox.min.y;
    }
    meshGroup.position.copy(p);
    meshGroup.rotation.set(0, yaw, 0);
    meshGroup.updateMatrix();
    this.root.add(meshGroup);

    const hx = Math.max(0.025, sx * 0.5 - 0.02);
    const hy = Math.max(0.025, sy * 0.5 - 0.02);
    const hz = Math.max(0.025, sz * 0.5 - 0.02);
    const resolvedSurface = surface || meshGroup.userData?.surface || meshGroup.userData?.surf || 'metal';
    const resolvedBreakable = breakable || Boolean(meshGroup.userData?.breakable);
    const breakKind = typeof breakable === 'string'
      ? breakable
      : typeof meshGroup.userData?.breakable === 'string'
        ? meshGroup.userData.breakable
        : resolvedSurface;
    const defaultHp = explosive ? 24 : resolvedBreakable ? 20 : Infinity;
    const maxHp = hp !== null && hp !== undefined ? Number(hp) : defaultHp;

    const ci = [];
    const cl = [];
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        ci.push(i, j);
        const dx = ((i & 1) - (j & 1)) * 2 * hx;
        const dy = (((i >> 1) & 1) - ((j >> 1) & 1)) * 2 * hy;
        const dz = (((i >> 2) & 1) - ((j >> 2) & 1)) * 2 * hz;
        cl.push(Math.hypot(dx, dy, dz));
      }
    }

    const prop = {
      id: this.props.length,
      kind: 'prop',
      obj: meshGroup,
      size: [sx, sy, sz],
      half: [hx, hy, hz],
      center: centerOffset,
      mass: Math.max(0.4, Number(mass) || meshGroup.userData?.mass || 2),
      surface: resolvedSurface,
      breakable: resolvedBreakable,
      breakKind,
      explosive: Boolean(explosive),
      hp: maxHp,
      maxHp,
      n: 8,
      x: new Float32Array(24),
      o: new Float32Array(24),
      cornerR: 0.025,
      ci,
      cl,
      iters: 5,
      damp: 0.996,
      fric: 0.06,
      restitution: 0.28,
      glassSpeed: 3.0,
      radius: Math.hypot(hx, hy, hz) + 0.05,
      cx: 0,
      cy: 0,
      cz: 0,
      pvx: 0,
      pvy: 0,
      pvz: 0,
      sleeping: true,
      still: 0,
      cool: 0,
      dead: false,
      broken: false,
      exploded: false,
      homePos: meshGroup.position.clone(),
      homeQuat: meshGroup.quaternion.clone(),
    };

    this._placePropBox(prop);
    this.props.push(prop);
    return prop;
  }

  _placePropBox(prop) {
    const obj = prop.obj;
    obj.updateMatrix();
    for (let i = 0; i < 8; i++) {
      _v0.set(
        prop.center[0] + (i & 1 ? 1 : -1) * prop.half[0],
        prop.center[1] + (i & 2 ? 1 : -1) * prop.half[1],
        prop.center[2] + (i & 4 ? 1 : -1) * prop.half[2]
      ).applyMatrix4(obj.matrix);
      const b = i * 3;
      prop.x[b] = prop.o[b] = _v0.x;
      prop.x[b + 1] = prop.o[b + 1] = _v0.y;
      prop.x[b + 2] = prop.o[b + 2] = _v0.z;
    }
    this._updatePropCentroid(prop);
  }

  _updatePropCentroid(prop) {
    let sx = 0, sy = 0, sz = 0;
    const x = prop.x;
    for (let i = 0; i < 8; i++) {
      sx += x[i * 3];
      sy += x[i * 3 + 1];
      sz += x[i * 3 + 2];
    }
    prop.cx = sx * 0.125;
    prop.cy = sy * 0.125;
    prop.cz = sz * 0.125;
  }

  _syncPropTransform(prop) {
    const x = prop.x;
    _axX.set(0, 0, 0);
    _axY.set(0, 0, 0);
    _axZ.set(0, 0, 0);
    for (let i = 0; i < 8; i++) {
      const px = x[i * 3];
      const py = x[i * 3 + 1];
      const pz = x[i * 3 + 2];
      const sx = i & 1 ? 1 : -1;
      const sy = i & 2 ? 1 : -1;
      const sz = i & 4 ? 1 : -1;
      _axX.x += px * sx; _axX.y += py * sx; _axX.z += pz * sx;
      _axY.x += px * sy; _axY.y += py * sy; _axY.z += pz * sy;
      _axZ.x += px * sz; _axZ.y += py * sz; _axZ.z += pz * sz;
    }
    if (_axX.lengthSq() < 1e-8) _axX.set(1, 0, 0);
    else _axX.normalize();
    _axY.addScaledVector(_axX, -_axY.dot(_axX));
    if (_axY.lengthSq() < 1e-8) _axY.set(0, 1, 0).addScaledVector(_axX, -_axX.y);
    _axY.normalize();
    _axZ.crossVectors(_axX, _axY);

    _mat4.makeBasis(_axX, _axY, _axZ);
    prop.obj.quaternion.setFromRotationMatrix(_mat4);
    _v0.set(prop.center[0], prop.center[1], prop.center[2]).applyQuaternion(prop.obj.quaternion);
    prop.obj.position.set(prop.cx - _v0.x, prop.cy - _v0.y, prop.cz - _v0.z);
    prop.obj.updateMatrix();
  }

  _wakeProp(prop) {
    if (prop.sleeping) {
      prop.pvx = 0;
      prop.pvy = 0;
      prop.pvz = 0;
    }
    prop.sleeping = false;
    prop.still = 0;
  }

  _impulseProp(prop, pointLocal, ix, iy, iz) {
    this._wakeProp(prop);
    const dt = this._h;
    const x = prop.x;
    const o = prop.o;
    const invMass = 1 / Math.max(prop.mass, 1.2);
    const falloffR = prop.radius * 1.35;
    let weightSum = 0;
    for (let i = 0; i < 8; i++) {
      const dist = Math.hypot(
        x[i * 3] - pointLocal.x,
        x[i * 3 + 1] - pointLocal.y,
        x[i * 3 + 2] - pointLocal.z
      );
      const w = Math.max(0.05, 1 - dist / falloffR);
      _cornerWeights[i] = w * w;
      weightSum += _cornerWeights[i];
    }
    for (let i = 0; i < 8; i++) {
      const dv = (_cornerWeights[i] / (weightSum || 1)) * 8 * invMass * dt;
      o[i * 3] -= ix * dv;
      o[i * 3 + 1] -= iy * dv;
      o[i * 3 + 2] -= iz * dv;
    }
  }

  _spawnChunk(px, py, pz, vx, vy, vz, scale, colorHex, life = 5) {
    const c = this._chunks;
    const slot = c.cursor;
    c.cursor = (slot + 1) % MAX_CHUNKS;
    const b = slot * 3;
    c.x[b] = px; c.x[b + 1] = py; c.x[b + 2] = pz;
    c.v[b] = vx; c.v[b + 1] = vy; c.v[b + 2] = vz;
    c.s[b] = scale * this.rng.range(0.6, 1.4);
    c.s[b + 1] = scale * this.rng.range(0.35, 0.95);
    c.s[b + 2] = scale * this.rng.range(0.6, 1.35);

    _v2.set(this.rng.range(-1, 1), this.rng.range(-1, 1), this.rng.range(-1, 1));
    if (_v2.lengthSq() < 1e-6) _v2.set(0, 1, 0);
    else _v2.normalize();
    c.ax[b] = _v2.x; c.ax[b + 1] = _v2.y; c.ax[b + 2] = _v2.z;
    c.ang[slot] = this.rng.range(0, Math.PI * 2);
    c.w[slot] = this.rng.range(-14, 14);
    c.life[slot] = life * this.rng.range(0.75, 1.2);
    if (c.st[slot] === 0) this.activeChunks++;
    c.st[slot] = 1;
    c.b[slot] = 0;

    this.chunkMesh.setColorAt(slot, _color.setHex(colorHex));
    if (this.chunkMesh.instanceColor) this.chunkMesh.instanceColor.needsUpdate = true;

    _quat.setFromAxisAngle(_v2, c.ang[slot]);
    _v0.set(px, py, pz);
    _v1.set(c.s[b], c.s[b + 1], c.s[b + 2]);
    this.chunkMesh.setMatrixAt(slot, _mat4.compose(_v0, _quat, _v1));
    this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  _burstChunks(center, count, colorHex, size, speed, upBias = 2.0) {
    for (let i = 0; i < count; i++) {
      this._spawnChunk(
        center.x + this.rng.range(-0.1, 0.1),
        center.y + this.rng.range(-0.1, 0.1),
        center.z + this.rng.range(-0.1, 0.1),
        this.rng.range(-1, 1) * speed,
        this.rng.range(0.1, 1.0) * speed + upBias,
        this.rng.range(-1, 1) * speed,
        size,
        colorHex
      );
    }
  }

  _breakProp(prop, dir = null) {
    if (prop.dead) return;
    prop.dead = true;
    prop.broken = true;
    prop.obj.visible = false;
    const center = new THREE.Vector3(prop.cx, prop.cy, prop.cz);
    const hex = SURFACE_DEBRIS_COLOR[prop.breakKind] || SURFACE_DEBRIS_COLOR[prop.surface] || 0x9aa0a6;
    const chunkSize = clamp(Math.min(prop.size[0], prop.size[1], prop.size[2]) * 0.24, 0.035, 0.11);
    for (let i = 0; i < 14; i++) {
      this._spawnChunk(
        center.x + this.rng.range(-0.08, 0.08),
        center.y + this.rng.range(-0.08, 0.08),
        center.z + this.rng.range(-0.08, 0.08),
        (dir ? dir.x * 1.8 : 0) + this.rng.range(-2.6, 2.6),
        this.rng.range(0.6, 3.2),
        (dir ? dir.z * 1.8 : 0) + this.rng.range(-2.6, 2.6),
        chunkSize,
        hex
      );
    }
    this._emitAudio('breakProp', center, { surface: prop.surface, breakKind: prop.breakKind });
    this._emitFx('propBreak', center, { surface: prop.surface });
  }

  _detonateProp(prop) {
    if (prop.dead) return;
    prop.dead = true;
    prop.broken = true;
    prop.exploded = true;
    prop.obj.visible = false;
    const center = new THREE.Vector3(prop.cx, prop.cy, prop.cz);
    // Pressurized cylinder / canister burst: red casing shards + pale powder/foam chunks
    this._burstChunks(center, 14, 0xb82018, 0.075, 5.5, 2.8);
    this._burstChunks(center, 8, 0xe8ecee, 0.06, 4.2, 2.2);
    this._emitAudio('propExplode', center, { surface: prop.surface });
    this._emitFx('explosion', center, { radius: 5.5 });
    this.explode(center, 5.5, 14);
  }

  // ---------------------------------------------------------------------------
  // Raycast, Damage & Blast API
  // ---------------------------------------------------------------------------

  raycast(originLocal, dirLocal, maxDist = 200) {
    const ox = Number(originLocal.x ?? originLocal[0]) || 0;
    const oy = Number(originLocal.y ?? originLocal[1]) || 0;
    const oz = Number(originLocal.z ?? originLocal[2]) || 0;
    _v3.set(
      Number(dirLocal.x ?? dirLocal[0]) || 0,
      Number(dirLocal.y ?? dirLocal[1]) || 0,
      Number(dirLocal.z ?? dirLocal[2]) || 0
    );
    const dirLen = _v3.length();
    if (dirLen < 1e-8) return null;
    const dx = _v3.x / dirLen;
    const dy = _v3.y / dirLen;
    const dz = _v3.z / dirLen;

    let bestDist = maxDist;
    let bestHit = null;

    // 1. Test glass panes
    for (let i = 0; i < this.panes.length; i++) {
      const p = this.panes[i];
      if (p.gone) continue;
      const denom = dx * p.nAxis.x + dy * p.nAxis.y + dz * p.nAxis.z;
      if (Math.abs(denom) < 1e-6) continue;
      const rcx = p.center.x - ox;
      const rcy = p.center.y - oy;
      const rcz = p.center.z - oz;
      const t = (rcx * p.nAxis.x + rcy * p.nAxis.y + rcz * p.nAxis.z) / denom;
      if (t <= 1e-3 || t >= bestDist) continue;

      const hx = ox + dx * t;
      const hy = oy + dy * t;
      const hz = oz + dz * t;
      const v = hy - p.center.y;
      if (v < -p.height * 0.5 || v > p.height * 0.5) continue;
      const u = (hx - p.center.x) * p.uAxis.x + (hz - p.center.z) * p.uAxis.z;
      if (u < -p.width * 0.5 || u > p.width * 0.5) continue;

      if (p.alive) {
        const ix = clamp(Math.floor(((u + p.width * 0.5) / p.width) * p.nx), 0, p.nx - 1);
        const iy = clamp(Math.floor(((v + p.height * 0.5) / p.height) * p.ny), 0, p.ny - 1);
        if (!p.alive[iy * p.nx + ix]) continue;
      }

      bestDist = t;
      const sign = denom < 0 ? 1 : -1;
      bestHit = {
        dist: t,
        point: new THREE.Vector3(hx, hy, hz),
        normal: new THREE.Vector3(p.nAxis.x * sign, p.nAxis.y * sign, p.nAxis.z * sign),
        surface: 'glass',
        kind: 'glass',
        target: p,
      };
    }

    // 2. Test physics props (OBB slab intersection in prop's local frame)
    for (let i = 0; i < this.props.length; i++) {
      const d = this.props[i];
      if (d.dead) continue;
      const mcx = d.cx - ox;
      const mcy = d.cy - oy;
      const mcz = d.cz - oz;
      const proj = mcx * dx + mcy * dy + mcz * dz;
      if (proj < -d.radius || proj > bestDist + d.radius) continue;
      if (mcx * mcx + mcy * mcy + mcz * mcz - proj * proj > d.radius * d.radius) continue;

      _invQuat.copy(d.obj.quaternion).invert();
      _v0.set(-mcx, -mcy, -mcz).applyQuaternion(_invQuat);
      _v1.set(dx, dy, dz).applyQuaternion(_invQuat);

      let tNear = 0;
      let tFar = bestDist;
      let hitAxis = -1;
      let hitSign = 0;
      let valid = true;

      for (let axis = 0; axis < 3; axis++) {
        const ro = axis === 0 ? _v0.x : axis === 1 ? _v0.y : _v0.z;
        const rd = axis === 0 ? _v1.x : axis === 1 ? _v1.y : _v1.z;
        const half = d.half[axis] + 0.025;
        if (Math.abs(rd) < 1e-8) {
          if (ro < -half || ro > half) {
            valid = false;
            break;
          }
          continue;
        }
        let t1 = (-half - ro) / rd;
        let t2 = (half - ro) / rd;
        let sgn = -1;
        if (t1 > t2) {
          const tmp = t1; t1 = t2; t2 = tmp;
          sgn = 1;
        }
        if (t1 > tNear) {
          tNear = t1;
          hitAxis = axis;
          hitSign = sgn;
        }
        if (t2 < tFar) tFar = t2;
        if (tNear > tFar) {
          valid = false;
          break;
        }
      }

      if (valid && hitAxis >= 0 && tNear > 1e-3 && tNear < bestDist) {
        bestDist = tNear;
        const normal = new THREE.Vector3(
          hitAxis === 0 ? hitSign : 0,
          hitAxis === 1 ? hitSign : 0,
          hitAxis === 2 ? hitSign : 0
        ).applyQuaternion(d.obj.quaternion);
        bestHit = {
          dist: tNear,
          point: new THREE.Vector3(ox + dx * tNear, oy + dy * tNear, oz + dz * tNear),
          normal,
          surface: d.surface,
          kind: 'prop',
          target: d,
        };
      }
    }

    return bestHit;
  }

  damageAt(hit, damage = 28, impulseDir = null, impulse = 6) {
    if (!hit || !hit.target) return null;
    const dir = new THREE.Vector3();
    if (impulseDir) {
      toVec3(impulseDir, dir);
      if (dir.lengthSq() < 1e-8) dir.copy(hit.normal).negate();
      else dir.normalize();
    } else {
      dir.copy(hit.normal).negate();
    }

    if (hit.kind === 'glass') {
      const pane = hit.target;
      const spawnedShards = this._hitGlassPane(pane, hit.point, damage, dir, impulse);
      return {
        kind: 'glass',
        cracked: pane.cracked,
        shattered: pane.shattered,
        spawnedShards,
      };
    }

    if (hit.kind === 'prop') {
      const prop = hit.target;
      if (prop.dead) return { kind: 'prop', woken: false, broken: prop.broken, exploded: prop.exploded };
      const liftY = Math.max(dir.y, 0.22);
      this._impulseProp(prop, hit.point, dir.x * impulse, liftY * impulse, dir.z * impulse);

      const chipHex = SURFACE_DEBRIS_COLOR[prop.surface] || 0x9aa0a6;
      for (let i = 0; i < 2; i++) {
        this._spawnChunk(
          hit.point.x, hit.point.y, hit.point.z,
          -dir.x * 1.5 + this.rng.range(-1.4, 1.4),
          this.rng.range(0.5, 2.2),
          -dir.z * 1.5 + this.rng.range(-1.4, 1.4),
          0.025,
          chipHex,
          2.2
        );
      }
      this._emitAudio('propHit', hit.point, { surface: prop.surface, strength: saturate(impulse / 10) });

      prop.hp -= damage;
      if (prop.explosive && prop.hp <= 0) {
        this._detonateProp(prop);
      } else if (prop.breakable && prop.hp <= 0) {
        this._breakProp(prop, dir);
      }

      return {
        kind: 'prop',
        woken: true,
        broken: prop.broken,
        exploded: prop.exploded,
      };
    }

    return null;
  }

  explode(centerLocal, radius = 6, force = 12) {
    const center = toVec3(centerLocal, new THREE.Vector3());
    const r = Math.max(0.25, Number(radius) || 6);
    const f = Math.max(0, Number(force) || 12);

    // 1. Shatter or crack nearby glass panes
    for (let i = 0; i < this.panes.length; i++) {
      const p = this.panes[i];
      if (p.gone) continue;
      const relX = center.x - p.center.x;
      const relZ = center.z - p.center.z;
      const nearU = clamp(relX * p.uAxis.x + relZ * p.uAxis.z, -p.width * 0.5, p.width * 0.5);
      const nearV = clamp(center.y - p.center.y, -p.height * 0.5, p.height * 0.5);
      const nearPt = this._panePointToLocal(p, nearU, nearV, new THREE.Vector3());
      const dist = nearPt.distanceTo(center);
      if (dist > r) continue;

      const blastDir = nearPt.clone().sub(center);
      if (blastDir.lengthSq() < 1e-5) blastDir.copy(p.nAxis);
      else blastDir.normalize();

      if (dist < r * 0.75) {
        p.hp = 0;
        this._shatterPane(p, nearU, nearV, blastDir, 1.6);
      } else {
        this._hitGlassPane(p, nearPt, 24, blastDir, 8);
      }
    }

    // 2. Blast nearby physics props outward
    const dt = this._h;
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      if (prop.dead) continue;
      const dx = prop.cx - center.x;
      const dy = prop.cy - center.y;
      const dz = prop.cz - center.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist > r + prop.radius) continue;

      if (prop.explosive && dist < r * 0.65) {
        this._detonateProp(prop);
        continue;
      }
      if (prop.breakable && dist < r * 0.65) {
        const bDir = new THREE.Vector3(dx, dy + 0.3, dz);
        if (bDir.lengthSq() > 1e-6) bDir.normalize();
        this._breakProp(prop, bDir);
        continue;
      }

      this._wakeProp(prop);
      const massGain = Math.min(1.8, 9 / (prop.mass + 2.5));
      for (let k = 0; k < 8; k++) {
        const b = k * 3;
        const cx = prop.x[b] - center.x;
        const cy = prop.x[b + 1] - center.y + 0.4;
        const cz = prop.x[b + 2] - center.z;
        const cd = Math.hypot(cx, cy, cz) || 0.02;
        if (cd > r + prop.radius) continue;
        const fall = Math.max(0.08, 1 - cd / (r + prop.radius));
        const push = (f * massGain * fall * fall / cd) * dt;
        prop.o[b] -= cx * push;
        prop.o[b + 1] -= cy * push;
        prop.o[b + 2] -= cz * push;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Simulation Step, Cleanup & Disposal
  // ---------------------------------------------------------------------------

  _stepProp(prop, h, dtRatio) {
    const x = prop.x;
    const o = prop.o;
    const grav = GRAVITY * h * h;
    const damp = prop.damp * dtRatio;
    const prevCx = prop.cx;
    const prevCy = prop.cy;
    const prevCz = prop.cz;

    for (let i = 0; i < 8; i++) {
      const b = i * 3;
      const vx = (x[b] - o[b]) * damp;
      const vy = (x[b + 1] - o[b + 1]) * damp;
      const vz = (x[b + 2] - o[b + 2]) * damp;
      o[b] = x[b];
      o[b + 1] = x[b + 1];
      o[b + 2] = x[b + 2];
      x[b] += vx;
      x[b + 1] += vy - grav;
      x[b + 2] += vz;
    }

    const ci = prop.ci;
    const cl = prop.cl;
    const edgeCount = cl.length;
    let contacts = 0;

    for (let iter = 0; iter < prop.iters; iter++) {
      for (let e = 0; e < edgeCount; e++) {
        const a = ci[e * 2] * 3;
        const b = ci[e * 2 + 1] * 3;
        const dx = x[b] - x[a];
        const dy = x[b + 1] - x[a + 1];
        const dz = x[b + 2] - x[a + 2];
        const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-6;
        const corr = ((len - cl[e]) / len) * 0.5;
        x[a] += dx * corr; x[a + 1] += dy * corr; x[a + 2] += dz * corr;
        x[b] -= dx * corr; x[b + 1] -= dy * corr; x[b + 2] -= dz * corr;
      }

      const lastIter = iter === prop.iters - 1;
      for (let i = 0; i < 8; i++) {
        const b = i * 3;
        const px = x[b];
        const py = x[b + 1];
        const pz = x[b + 2];

        // Collide flying props against intact glass panes
        for (let pIdx = 0; pIdx < this.panes.length; pIdx++) {
          const pane = this.panes[pIdx];
          if (pane.gone || pane.colliderOff) continue;
          const relX = px - pane.center.x;
          const relY = py - pane.center.y;
          const relZ = pz - pane.center.z;
          const nDist = relX * pane.nAxis.x + relZ * pane.nAxis.z;
          if (Math.abs(nDist) >= prop.cornerR + 0.035) continue;
          if (Math.abs(relY) > pane.height * 0.5) continue;
          const uDist = relX * pane.uAxis.x + relZ * pane.uAxis.z;
          if (Math.abs(uDist) > pane.width * 0.5) continue;

          const vn = Math.abs(((px - o[b]) * pane.nAxis.x + (pz - o[b + 2]) * pane.nAxis.z) / h);
          if (vn > prop.glassSpeed) {
            _v2.set((px - o[b]) / h, (py - o[b + 1]) / h, (pz - o[b + 2]) / h);
            if (_v2.lengthSq() > 1e-6) _v2.normalize();
            else _v2.copy(pane.nAxis);
            this._shatterPane(pane, uDist, relY, _v2, Math.max(0.7, vn / 5));
          } else {
            const sgn = nDist >= 0 ? 1 : -1;
            const pushOut = prop.cornerR + 0.035 - Math.abs(nDist);
            x[b] += pane.nAxis.x * sgn * pushOut;
            x[b + 2] += pane.nAxis.z * sgn * pushOut;
            contacts++;
          }
        }

        // Collide against local terrain heightfield `groundHeight(x, z)`
        const floorY = this._sampleGround(px, pz) + prop.cornerR;
        if (x[b + 1] < floorY) {
          this._sampleGroundNormal(px, pz, _v2);
          const pen = (floorY - x[b + 1]) * _v2.y;
          x[b] += _v2.x * pen;
          x[b + 1] = Math.max(x[b + 1] + _v2.y * pen, floorY);
          x[b + 2] += _v2.z * pen;
          contacts++;

          const vx = x[b] - o[b];
          const vy = x[b + 1] - o[b + 1];
          const vz = x[b + 2] - o[b + 2];
          const vn = vx * _v2.x + vy * _v2.y + vz * _v2.z;
          const tx = vx - vn * _v2.x;
          const ty = vy - vn * _v2.y;
          const tz = vz - vn * _v2.z;
          o[b] += tx * prop.fric;
          o[b + 1] += ty * prop.fric;
          o[b + 2] += tz * prop.fric;

          if (lastIter) {
            const preVn = (px - o[b]) * _v2.x + (py - o[b + 1]) * _v2.y + (pz - o[b + 2]) * _v2.z;
            if (preVn < -0.02 * h) {
              const bounce = -preVn * prop.restitution;
              o[b] -= _v2.x * bounce;
              o[b + 1] -= _v2.y * bounce;
              o[b + 2] -= _v2.z * bounce;
            }
          }
        }
      }
    }

    this._updatePropCentroid(prop);
    const dvx = prop.cx - prevCx - prop.pvx;
    const dvy = prop.cy - prevCy - prop.pvy;
    const dvz = prop.cz - prevCz - prop.pvz;
    const impactSpeed = Math.hypot(dvx, dvy, dvz) / h;
    prop.pvx = prop.cx - prevCx;
    prop.pvy = prop.cy - prevCy;
    prop.pvz = prop.cz - prevCz;

    if (contacts > 0 && impactSpeed > 2.2 && prop.cool <= 0) {
      prop.cool = 0.18;
      if (prop.explosive && impactSpeed > 7.5) {
        this._detonateProp(prop);
        return;
      }
      if (prop.breakable && impactSpeed > 5.0) {
        this._breakProp(prop);
        return;
      }
      this._emitAudio('propBounce', _v0.set(prop.cx, prop.cy, prop.cz), {
        surface: prop.surface,
        strength: saturate(impactSpeed / 9),
      });
    }

    let maxDisp = 0;
    for (let i = 0; i < 8; i++) {
      const b = i * 3;
      const disp = Math.abs(x[b] - o[b]) + Math.abs(x[b + 1] - o[b + 1]) + Math.abs(x[b + 2] - o[b + 2]);
      if (disp > maxDisp) maxDisp = disp;
    }
    if (contacts > 0 && maxDisp / h < 0.14) {
      prop.still += h;
      if (prop.still > 0.65) {
        prop.sleeping = true;
        o.set(x);
      }
    } else {
      prop.still = 0;
    }

    if (prop.cy < -120) {
      prop.dead = true;
      prop.obj.visible = false;
    }
  }

  _stepShards(dt) {
    if (this.activeShards <= 0) return;
    const pos = this._shardPos;
    const vel = this._shardVel;
    const state = this._shardState;
    const outPos = this._shardPosAttr.array;
    let dirty = false;

    for (let i = 0; i < MAX_SHARDS; i++) {
      const st = state[i];
      if (st === 0) continue;
      if (st === 2) {
        this._shardLife[i] += dt;
        if (this._shardLife[i] > 14) {
          state[i] = 0;
          outPos.fill(0, i * 9, i * 9 + 9);
          this.activeShards--;
          dirty = true;
        }
        continue;
      }

      dirty = true;
      const b = i * 3;
      vel[b + 1] -= GRAVITY * dt;
      const drag = Math.max(0, 1 - 0.35 * dt);
      vel[b] *= drag;
      vel[b + 2] *= drag;
      pos[b] += vel[b] * dt;
      pos[b + 1] += vel[b + 1] * dt;
      pos[b + 2] += vel[b + 2] * dt;
      this._shardAngle[i] += this._shardSpin[i] * dt;

      const groundY = this._sampleGround(pos[b], pos[b + 2]);
      let settledNow = false;
      if (pos[b + 1] <= groundY + 0.02 && vel[b + 1] < 0) {
        pos[b + 1] = groundY + 0.02;
        if (vel[b + 1] < -2.1 && this._shardBounces[i] < 2) {
          vel[b + 1] *= -this.rng.range(0.18, 0.34);
          vel[b] *= 0.55;
          vel[b + 2] *= 0.55;
          this._shardSpin[i] *= 0.6;
          this._shardBounces[i]++;
        } else {
          settledNow = true;
          state[i] = 2;
          this._shardLife[i] = this.rng.range(0, 4);
        }
      } else if (pos[b + 1] < groundY - 80) {
        state[i] = 0;
        outPos.fill(0, i * 9, i * 9 + 9);
        this.activeShards--;
        continue;
      }

      this._writeShardVertices(i, settledNow, groundY);
    }

    if (dirty) {
      this._shardPosAttr.needsUpdate = true;
      this._shardNrmAttr.needsUpdate = true;
    }
  }

  _stepChunks(dt) {
    if (this.activeChunks <= 0) return;
    const c = this._chunks;
    let dirty = false;

    for (let i = 0; i < MAX_CHUNKS; i++) {
      const st = c.st[i];
      if (!st) continue;
      c.life[i] -= dt;
      if (c.life[i] <= 0) {
        c.st[i] = 0;
        this.activeChunks--;
        this.chunkMesh.setMatrixAt(i, ZERO_SCALE_MAT);
        dirty = true;
        continue;
      }

      const b = i * 3;
      if (st === 1) {
        c.v[b + 1] -= GRAVITY * dt;
        let nx = c.x[b] + c.v[b] * dt;
        let ny = c.x[b + 1] + c.v[b + 1] * dt;
        let nz = c.x[b + 2] + c.v[b + 2] * dt;
        const halfH = c.s[b + 1] * 0.5;
        const floorY = this._sampleGround(nx, nz);
        if (ny <= floorY + halfH && c.v[b + 1] < 0) {
          ny = floorY + halfH;
          const downSpeed = -c.v[b + 1];
          if (downSpeed > 1.2 && c.b[i] < 3) {
            c.v[b + 1] = downSpeed * 0.3;
            c.v[b] = c.v[b] * 0.6 + this.rng.range(-0.4, 0.4);
            c.v[b + 2] = c.v[b + 2] * 0.6 + this.rng.range(-0.4, 0.4);
            c.w[i] *= 0.7;
            c.b[i]++;
          } else {
            c.st[i] = 2;
            c.v[b] = c.v[b + 1] = c.v[b + 2] = 0;
          }
        } else if (ny < floorY - 80) {
          c.st[i] = 0;
          this.activeChunks--;
          this.chunkMesh.setMatrixAt(i, ZERO_SCALE_MAT);
          dirty = true;
          continue;
        }
        c.x[b] = nx;
        c.x[b + 1] = ny;
        c.x[b + 2] = nz;
        c.ang[i] += c.w[i] * dt;
      } else if (c.life[i] > 1.0) {
        continue;
      }

      const fade = c.st[i] === 2 ? Math.min(1, c.life[i]) : 1;
      _v2.set(c.ax[b], c.ax[b + 1], c.ax[b + 2]);
      _quat.setFromAxisAngle(_v2, c.ang[i]);
      _v0.set(c.x[b], c.x[b + 1], c.x[b + 2]);
      _v1.set(c.s[b] * fade, c.s[b + 1] * fade, c.s[b + 2] * fade);
      this.chunkMesh.setMatrixAt(i, _mat4.compose(_v0, _quat, _v1));
      dirty = true;
    }

    if (dirty) this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  update(dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    const stepDt = Math.min(dt, 0.1);
    this.time += stepDt;

    // 1. Glass shatter cascades & 3D tumbling shards
    for (let i = 0; i < this.panes.length; i++) {
      const pane = this.panes[i];
      if (pane.cascade) this._stepPaneCascade(pane, stepDt);
    }
    this._stepShards(stepDt);

    // 2. Verlet rigid-body props (substepped at ~90 Hz)
    const substeps = Math.max(1, Math.min(3, Math.ceil(stepDt * 90)));
    const h = stepDt / substeps;
    for (let s = 0; s < substeps; s++) {
      const dtRatio = h / this._hPrev;
      this._h = h;
      for (let i = 0; i < this.props.length; i++) {
        const prop = this.props[i];
        if (!prop.dead && !prop.sleeping) this._stepProp(prop, h, dtRatio);
      }
      this._hPrev = h;
    }
    for (let i = 0; i < this.props.length; i++) {
      const prop = this.props[i];
      if (prop.dead) continue;
      if (prop.cool > 0) prop.cool = Math.max(0, prop.cool - stepDt);
      if (!prop.sleeping) this._syncPropTransform(prop);
    }

    // 3. Instanced debris chunks
    this._stepChunks(stepDt);
  }

  clear() {
    for (const pane of this.panes) {
      if (pane.group && pane.group.parent) pane.group.parent.remove(pane.group);
      if (pane.intactGeo) pane.intactGeo.dispose();
      if (pane.fractureMesh) {
        if (pane.fractureMesh.parent) pane.fractureMesh.parent.remove(pane.fractureMesh);
        pane.fractureMesh.geometry.dispose();
        pane.fractureMesh = null;
      }
    }
    this.panes.length = 0;

    for (const prop of this.props) {
      if (prop.obj && prop.obj.parent === this.root) {
        this.root.remove(prop.obj);
      }
    }
    this.props.length = 0;

    this._shardState.fill(0);
    this._shardPosAttr.array.fill(0);
    this._shardPosAttr.needsUpdate = true;
    this.activeShards = 0;

    this._chunks.st.fill(0);
    this.activeChunks = 0;
    for (let i = 0; i < MAX_CHUNKS; i++) {
      this.chunkMesh.setMatrixAt(i, ZERO_SCALE_MAT);
    }
    this.chunkMesh.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.clear();
    if (this.shardMesh && this.shardMesh.parent) this.shardMesh.parent.remove(this.shardMesh);
    if (this.chunkMesh && this.chunkMesh.parent) this.chunkMesh.parent.remove(this.chunkMesh);
    this.shardGeometry.dispose();
    this._chunkGeom.dispose();
    this._unitFrameBox.dispose();
    this._chunkMat.dispose();
    this.glassMaterial.dispose();
    this.frameMaterial.dispose();
  }
}
