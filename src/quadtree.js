// Chunked quadtree LOD on a cube-sphere. Six root faces subdivide toward the
// camera; every chunk at every level samples the planet's height/color
// functions (with a frequency cap matched to its grid spacing), so each level
// is a faithful, coarser view of the exact same world.

import * as THREE from 'three';

export let GRID_CELLS = 24;            // quads per chunk edge
export function setGridCells(n) { GRID_CELLS = n; }   // quality presets
const SPLIT = 4.0;                     // split when dist < size * SPLIT
const MERGE = 5.2;                     // merge when dist > size * MERGE
const MORPH_TIME = 0.7;                // seconds for a LOD transition to relax

const FACE_FN = [
  (u, v, out) => out.set(1, v, -u),
  (u, v, out) => out.set(-1, v, u),
  (u, v, out) => out.set(u, 1, -v),
  (u, v, out) => out.set(u, -1, v),
  (u, v, out) => out.set(u, v, 1),
  (u, v, out) => out.set(-u, v, -1),
];

const _v = new THREE.Vector3();
const _d1 = new THREE.Vector3();
const _d2 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _p0 = new THREE.Vector3();
const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _dirV = new THREE.Vector3();
const _cP = new THREE.Vector3();
const _cN = new THREE.Vector3();
const _ex = new THREE.Vector4();
const _camDir = new THREE.Vector3();

// position/normal of the surface at one LOD cutoff; height and slope are
// left in _ss for the caller (colors are the fragment shader's job now)
const _ss = { h: 0, slope: 0 };
function sampleSurface(p, dir, maxFreq, eps, outPos, outNrm) {
  const h = p.height(dir, maxFreq);
  outPos.copy(dir).multiplyScalar(p.R + h);
  if (Math.abs(dir.y) < 0.95) _t1.set(-dir.z, 0, dir.x).normalize();
  else _t1.set(1, 0, 0).projectOnPlane(dir).normalize();
  _t2.crossVectors(dir, _t1);
  _d1.copy(dir).addScaledVector(_t1, eps).normalize();
  _p1.copy(_d1).multiplyScalar(p.R + p.height(_d1, maxFreq));
  _d2.copy(dir).addScaledVector(_t2, eps).normalize();
  _p2.copy(_d2).multiplyScalar(p.R + p.height(_d2, maxFreq));
  outNrm.crossVectors(_p1.sub(outPos), _p2.sub(outPos)).normalize();
  _ss.h = h;
  _ss.slope = Math.max(0, 1 - outNrm.dot(dir));
}

// ---- global build scheduler -------------------------------------------------
const buildQueue = [];

export function pendingChunks() {
  let n = 0;
  for (const e of buildQueue) if (!e.dead) n++;
  return n;
}

// budget is in MILLISECONDS: build as many chunks as fit, so refinement
// speed tracks the hardware instead of starving on big worlds
export function flushChunkQueue(budgetMs = 7) {
  if (buildQueue.length === 0) return 0;
  for (const e of buildQueue) {
    e.prio = e.dead ? Infinity : e.lod.nodeDistance(e) / e.size;
  }
  buildQueue.sort((a, b) => a.prio - b.prio);
  const t0 = performance.now();
  let built = 0;
  while (buildQueue.length && (built === 0 || performance.now() - t0 < budgetMs)) {
    const node = buildQueue.shift();
    node.queued = false;
    if (node.dead || node.mesh) continue;
    node.lod.buildNodeMesh(node);
    built++;
  }
  return built;
}

function makeNode(lod, face, level, ix, iy) {
  const span = 2 / (1 << level);
  const u0 = -1 + ix * span, v0 = -1 + iy * span;
  const node = {
    lod, face, level, ix, iy,
    u0, v0, u1: u0 + span, v1: v0 + span,
    size: (Math.PI / 2) * lod.planet.R / (1 << level),
    centerDir: new THREE.Vector3(),
    centerPos: new THREE.Vector3(),
    children: null, mesh: null, queued: false, dead: false,
    // geomorph state: 1 = parent's shape, 0 = own full detail
    morph: 1, morphTo: 0, splitActive: false, mergePending: false,
  };
  FACE_FN[face]((u0 + node.u1) / 2, (v0 + node.v1) / 2, node.centerDir);
  node.centerDir.normalize();
  node.centerPos.copy(node.centerDir)
    .multiplyScalar(lod.planet.R + lod.planet.height(node.centerDir, 24));
  return node;
}

export class ChunkedLOD {
  constructor(planet) {
    this.planet = planet;
    this.camLocal = new THREE.Vector3(1e9, 0, 0);
    this.roots = [];
    for (let f = 0; f < 6; f++) {
      const root = makeNode(this, f, 0, 0, 0);
      this.buildNodeMesh(root);           // synchronous: planet visible immediately
      this.roots.push(root);
    }
  }

  nodeDistance(node) {
    return Math.max(node.centerPos.distanceTo(this.camLocal) - node.size * 0.75, 1);
  }

  beyondHorizon(node) {
    const p = this.planet;
    const camR = this.camLocal.length();
    const R0 = p.R * 0.94;
    if (camR <= R0 + 1) return false;
    const horizon = Math.acos(Math.min(1, R0 / camR))
      + Math.sqrt(2 * Math.max(p.hAmp, 1) / R0)
      + (node.size / p.R) * 0.9 + 0.08;
    const ang = Math.acos(Math.max(-1, Math.min(1, _camDir.copy(this.camLocal).normalize().dot(node.centerDir))));
    return ang > horizon;
  }

  update(camLocal, dt = 0.016) {
    this.camLocal.copy(camLocal);
    this._dt = dt;
    // a planet that fills the screen must never show a polygonal limb:
    // force a minimum subdivision depth from its apparent size
    const d = Math.max(camLocal.length() - this.planet.R, 1);
    const ang = this.planet.R / d;
    this._forceLevel = ang > 1.2 ? 3 : ang > 0.45 ? 2 : ang > 0.15 ? 1 : 0;
    for (const root of this.roots) this.process(root);
  }

  setMorph(node, v) {
    node.morph = v;
    if (node.mesh && node.mesh.morphTargetInfluences) node.mesh.morphTargetInfluences[0] = v;
  }

  advanceMorph(node) {
    if (node.morph === node.morphTo) return;
    const step = this._dt / MORPH_TIME;
    const m = node.morph < node.morphTo
      ? Math.min(node.morphTo, node.morph + step)
      : Math.max(node.morphTo, node.morph - step);
    this.setMorph(node, m);
  }

  process(node) {
    const d = this.nodeDistance(node);
    const wantSplit = node.level < this.planet.maxLevel
      && (d < node.size * SPLIT || node.level < this._forceLevel)
      && !this.beyondHorizon(node);

    if (wantSplit) {
      if (!node.children) this.createChildren(node);
      let ready = true;
      for (const c of node.children) if (!c.mesh) { ready = false; break; }
      if (ready) {
        if (node.mergePending) {            // re-approached mid-merge: refine again
          node.mergePending = false;
          for (const c of node.children) c.morphTo = 0;
        }
        if (!node.splitActive) {
          node.splitActive = true;
          // children appear in the parent's exact shape, then relax into detail
          for (const c of node.children) { this.setMorph(c, 1); c.morphTo = 0; }
        }
        if (node.mesh) node.mesh.visible = false;
        for (const c of node.children) this.process(c);
        return;
      }
      // children still building: keep this level on screen meanwhile
    } else if (node.children && d > node.size * MERGE) {
      // far behind us the morph theatre is sub-pixel: collapse instantly so
      // departing a planet frees its thousands of chunks at once
      if (node.mesh && d > node.size * MERGE * 2.5) {
        this.disposeChildren(node);
      } else {
        const leavesOnly = node.children.every((c) => !c.children);
        if (leavesOnly && node.mesh) {
          // animate children back into the parent's shape, then swap — no pop
          if (!node.mergePending) {
            node.mergePending = true;
            for (const c of node.children) c.morphTo = 1;
          }
          const done = node.children.every((c) => !c.mesh || c.morph >= 0.999);
          if (done) {
            this.disposeChildren(node);
          } else {
            if (node.mesh) node.mesh.visible = false;
            for (const c of node.children) {
              if (c.mesh) c.mesh.visible = true;
              this.advanceMorph(c);
            }
            return;
          }
        } else if (!leavesOnly) {
          // grandchildren must collapse first; keep recursing
          if (node.mesh) node.mesh.visible = false;
          for (const c of node.children) this.process(c);
          return;
        }
      }
    }

    if (!node.mesh && !node.queued) {
      node.queued = true;
      buildQueue.push(node);
    }
    if (node.mesh) {
      node.mesh.visible = true;
      this.advanceMorph(node);
    }
    if (node.children) {
      for (const c of node.children) this.hideSubtree(c);
    }
  }

  hideSubtree(node) {
    if (node.mesh) node.mesh.visible = false;
    if (node.children) for (const c of node.children) this.hideSubtree(c);
  }

  createChildren(node) {
    node.children = [];
    for (let dy = 0; dy < 2; dy++) {
      for (let dx = 0; dx < 2; dx++) {
        const c = makeNode(this, node.face, node.level + 1, node.ix * 2 + dx, node.iy * 2 + dy);
        node.children.push(c);
        c.queued = true;
        buildQueue.push(c);
      }
    }
  }

  disposeChildren(node) {
    for (const c of node.children) {
      c.dead = true;
      if (c.children) this.disposeChildren(c);
      if (c.mesh) {
        this.planet.group.remove(c.mesh);
        c.mesh.geometry.dispose();
        c.mesh = null;
      }
    }
    node.children = null;
    node.splitActive = false;
    node.mergePending = false;
  }

  buildNodeMesh(node) {
    const p = this.planet;
    // flat liquid surfaces don't need dense grids — p.gridCells overrides
    const N = p.gridCells || GRID_CELLS;
    const cellAngle = (Math.PI / 2) / (N * (1 << node.level));
    const maxFreq = p.freqAtLevel(node.level);
    const eps = cellAngle * 0.5;
    const skirtDrop = p.R * cellAngle * 2.5 + 6;
    // non-root chunks carry their parent's shape as a morph target, so LOD
    // transitions can relax between levels instead of popping
    const hasMorph = node.level > 0 && !p.noMorph;
    const coarseFreq = hasMorph ? p.freqAtLevel(node.level - 1) : 0;

    const gridVerts = (N + 1) * (N + 1);
    // flat liquid surfaces skip skirts — they'd show as a grid through the
    // transparency, and a level surface can't crack visibly anyway
    const skirtVerts = p.noSkirt ? 0 : 4 * (N + 1);
    const total = gridVerts + skirtVerts;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    // per-vertex material weights: x = rockiness, y = vegetation,
    // z = baked ray-marched sun visibility (long mountain shadows)
    const aMat = p.pal ? new Float32Array(total * 3) : null;
    if (aMat) aMat.fill(1);
    // low-frequency tint masks (forest/blotch/stripe/extra) — the actual
    // palette is evaluated per-pixel in the fragment shader
    const aExtra = p.extrasAt ? new Float32Array(total * 4) : null;
    // water depth beneath each sea-surface vertex (Beer–Lambert absorption)
    const aDepth = p.bakeDepth ? new Float32Array(total) : null;
    const dPos = hasMorph ? new Float32Array(total * 3) : null;
    const dNrm = hasMorph ? new Float32Array(total * 3) : null;

    const faceFn = FACE_FN[node.face];

    for (let j = 0; j <= N; j++) {
      const v = node.v0 + (node.v1 - node.v0) * (j / N);
      for (let i = 0; i <= N; i++) {
        const u = node.u0 + (node.u1 - node.u0) * (i / N);
        const idx = j * (N + 1) + i;

        faceFn(u, v, _dirV).normalize();
        sampleSurface(p, _dirV, maxFreq, eps, _p0, _n);
        const h = _ss.h, slope = _ss.slope;

        positions[idx * 3] = _p0.x;
        positions[idx * 3 + 1] = _p0.y;
        positions[idx * 3 + 2] = _p0.z;
        normals[idx * 3] = _n.x; normals[idx * 3 + 1] = _n.y; normals[idx * 3 + 2] = _n.z;

        if (aExtra) {
          p.extrasAt(_dirV, h, maxFreq, _ex);
          aExtra[idx * 4] = _ex.x; aExtra[idx * 4 + 1] = _ex.y;
          aExtra[idx * 4 + 2] = _ex.z; aExtra[idx * 4 + 3] = _ex.w;
        }
        if (aDepth) aDepth[idx] = p.bakeDepth(_dirV);
        if (aMat) {
          const sl = (slope - p.pal.slopeLo) / (p.pal.slopeHi - p.pal.slopeLo);
          aMat[idx * 3] = Math.min(1, Math.max(0, sl));
          aMat[idx * 3 + 1] = aExtra ? Math.min(1, _ex.x * 1.4) : 0;
        }

        if (hasMorph) {
          // the same vertex as the parent level sees it (coarser cutoff,
          // parent's sampling eps) — stored relative to the fine vertex
          sampleSurface(p, _dirV, coarseFreq, eps * 2, _cP, _cN);
          dPos[idx * 3] = _cP.x - _p0.x;
          dPos[idx * 3 + 1] = _cP.y - _p0.y;
          dPos[idx * 3 + 2] = _cP.z - _p0.z;
          dNrm[idx * 3] = _cN.x - _n.x;
          dNrm[idx * 3 + 1] = _cN.y - _n.y;
          dNrm[idx * 3 + 2] = _cN.z - _n.z;
        }
      }
    }

    // baked sun shadows: march on a half-resolution subgrid (shadows are
    // broad and soft) and bilinearly upsample — quarter the march cost
    if (aMat && p.sunVis && p.sunDirLocal) {
      const SN = N / 2;
      const sub = new Float32Array((SN + 1) * (SN + 1));
      for (let sj = 0; sj <= SN; sj++) {
        const v = node.v0 + (node.v1 - node.v0) * ((sj * 2) / N);
        for (let si = 0; si <= SN; si++) {
          const u = node.u0 + (node.u1 - node.u0) * ((si * 2) / N);
          faceFn(u, v, _dirV).normalize();
          const idx = (sj * 2) * (N + 1) + si * 2;
          const hh = Math.hypot(positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]) - p.R;
          sub[sj * (SN + 1) + si] = p.sunVis(_dirV, hh);
        }
      }
      for (let j = 0; j <= N; j++) {
        const fj = j / 2, j0 = Math.min(SN - 1, fj | 0), tj = fj - j0;
        for (let i = 0; i <= N; i++) {
          const fi = i / 2, i0 = Math.min(SN - 1, fi | 0), ti = fi - i0;
          const a = sub[j0 * (SN + 1) + i0], b = sub[j0 * (SN + 1) + i0 + 1];
          const c = sub[(j0 + 1) * (SN + 1) + i0], d = sub[(j0 + 1) * (SN + 1) + i0 + 1];
          aMat[(j * (N + 1) + i) * 3 + 2] = (a * (1 - ti) + b * ti) * (1 - tj) + (c * (1 - ti) + d * ti) * tj;
        }
      }
    }

    // skirt vertices: copies of the border ring, pulled toward planet center
    const edges = [];
    if (!p.noSkirt) {
      for (let i = 0; i <= N; i++) edges.push(i);                      // j = 0
      for (let i = 0; i <= N; i++) edges.push(N * (N + 1) + i);        // j = N
      for (let j = 0; j <= N; j++) edges.push(j * (N + 1));            // i = 0
      for (let j = 0; j <= N; j++) edges.push(j * (N + 1) + N);        // i = N
    }

    for (let s = 0; s < edges.length; s++) {
      const src = edges[s], dst = gridVerts + s;
      const px = positions[src * 3], py = positions[src * 3 + 1], pz = positions[src * 3 + 2];
      const len = Math.hypot(px, py, pz);
      const k = (len - skirtDrop) / len;
      positions[dst * 3] = px * k; positions[dst * 3 + 1] = py * k; positions[dst * 3 + 2] = pz * k;
      normals[dst * 3] = normals[src * 3]; normals[dst * 3 + 1] = normals[src * 3 + 1]; normals[dst * 3 + 2] = normals[src * 3 + 2];
      if (aMat) {
        aMat[dst * 3] = aMat[src * 3];
        aMat[dst * 3 + 1] = aMat[src * 3 + 1];
        aMat[dst * 3 + 2] = aMat[src * 3 + 2];
      }
      if (aExtra) {
        aExtra[dst * 4] = aExtra[src * 4]; aExtra[dst * 4 + 1] = aExtra[src * 4 + 1];
        aExtra[dst * 4 + 2] = aExtra[src * 4 + 2]; aExtra[dst * 4 + 3] = aExtra[src * 4 + 3];
      }
      if (hasMorph) {
        dPos[dst * 3] = dPos[src * 3]; dPos[dst * 3 + 1] = dPos[src * 3 + 1]; dPos[dst * 3 + 2] = dPos[src * 3 + 2];
        dNrm[dst * 3] = dNrm[src * 3]; dNrm[dst * 3 + 1] = dNrm[src * 3 + 1]; dNrm[dst * 3 + 2] = dNrm[src * 3 + 2];
      }
    }

    const indices = [];
    // all six FACE_FN have du×dv pointing outward, so CCW (front) is (a,b,c)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
        indices.push(a, b, c, b, d, c);
      }
    }
    // skirt quads (both windings; backface culling drops the wrong one)
    const skirtEdge = (offset, count, gridIdx) => {
      for (let s = 0; s < count - 1; s++) {
        const g0 = gridIdx(s), g1 = gridIdx(s + 1);
        const s0 = gridVerts + offset + s, s1 = gridVerts + offset + s + 1;
        indices.push(g0, g1, s0, s0, g1, s1, g0, s0, g1, g1, s0, s1);
      }
    };
    if (!p.noSkirt) {
      skirtEdge(0, N + 1, (s) => s);
      skirtEdge(N + 1, N + 1, (s) => N * (N + 1) + s);
      skirtEdge(2 * (N + 1), N + 1, (s) => s * (N + 1));
      skirtEdge(3 * (N + 1), N + 1, (s) => s * (N + 1) + N);
    }

    // store vertices relative to the chunk's own center: on 100 km planets
    // the f32 GPU subtraction (planet offset + huge local vertex) would
    // otherwise lose centimetres and make geometry shimmer near the camera.
    // aLocal keeps the ORIGINAL planet-local position: the detail shaders
    // need coordinates that don't move with camera-relative rebasing.
    const aLocal = new Float32Array(positions);
    const ax = node.centerPos.x, ay = node.centerPos.y, az = node.centerPos.z;
    for (let i = 0; i < total; i++) {
      positions[i * 3] -= ax;
      positions[i * 3 + 1] -= ay;
      positions[i * 3 + 2] -= az;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('aLocal', new THREE.BufferAttribute(aLocal, 3));
    if (aMat) geo.setAttribute('aMat', new THREE.BufferAttribute(aMat, 3));
    if (aExtra) geo.setAttribute('aExtra', new THREE.BufferAttribute(aExtra, 4));
    if (aDepth) geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
    if (hasMorph) {
      geo.morphAttributes.position = [new THREE.BufferAttribute(dPos, 3)];
      geo.morphAttributes.normal = [new THREE.BufferAttribute(dNrm, 3)];
      geo.morphTargetsRelative = true;
    }
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    if (hasMorph) geo.boundingSphere.radius += p.hAmp;   // morphed verts may bulge

    const mesh = new THREE.Mesh(geo, p.terrainMaterial);
    mesh.position.copy(node.centerPos);
    if (hasMorph && mesh.morphTargetInfluences) mesh.morphTargetInfluences[0] = node.morph;
    mesh.castShadow = !p.noShadow;
    mesh.receiveShadow = true;
    mesh.visible = false;
    node.mesh = mesh;
    p.group.add(mesh);
  }

  dispose() {
    for (const root of this.roots) {
      root.dead = true;
      if (root.children) this.disposeChildren(root);
      if (root.mesh) {
        this.planet.group.remove(root.mesh);
        root.mesh.geometry.dispose();
        root.mesh = null;
      }
    }
    this.roots = [];
  }

  countChunks() {
    let n = 0;
    const walk = (node) => {
      if (node.mesh) n++;
      if (node.children) for (const c of node.children) walk(c);
    };
    for (const r of this.roots) walk(r);
    return n;
  }
}
