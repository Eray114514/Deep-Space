// Chunked quadtree LOD on a cube-sphere. Six root faces subdivide toward the
// camera; every chunk at every level samples the planet's height/color
// functions (with a frequency cap matched to its grid spacing), so each level
// is a faithful, coarser view of the exact same world.

import * as THREE from 'three';

export const GRID_CELLS = 20;          // quads per chunk edge
const SPLIT = 4.0;                     // split when dist < size * SPLIT
const MERGE = 5.2;                     // merge when dist > size * MERGE

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
const _col = new THREE.Color();
const _camDir = new THREE.Vector3();

// ---- global build scheduler -------------------------------------------------
const buildQueue = [];

export function pendingChunks() {
  let n = 0;
  for (const e of buildQueue) if (!e.dead) n++;
  return n;
}

export function flushChunkQueue(budget = 8) {
  if (buildQueue.length === 0) return 0;
  for (const e of buildQueue) {
    e.prio = e.dead ? Infinity : e.lod.nodeDistance(e) / e.size;
  }
  buildQueue.sort((a, b) => a.prio - b.prio);
  let built = 0;
  while (built < budget && buildQueue.length) {
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

  update(camLocal) {
    this.camLocal.copy(camLocal);
    for (const root of this.roots) this.process(root);
  }

  process(node) {
    const d = this.nodeDistance(node);
    const wantSplit = node.level < this.planet.maxLevel
      && d < node.size * SPLIT
      && !this.beyondHorizon(node);

    if (wantSplit) {
      if (!node.children) this.createChildren(node);
      let ready = true;
      for (const c of node.children) if (!c.mesh) { ready = false; break; }
      if (ready) {
        if (node.mesh) node.mesh.visible = false;
        for (const c of node.children) this.process(c);
        return;
      }
      // children still building: keep this level on screen meanwhile
    } else if (node.children && d > node.size * MERGE) {
      this.disposeChildren(node);
    }

    if (!node.mesh && !node.queued) {
      node.queued = true;
      buildQueue.push(node);
    }
    if (node.mesh) node.mesh.visible = true;
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
  }

  buildNodeMesh(node) {
    const p = this.planet;
    const N = GRID_CELLS;
    const cellAngle = (Math.PI / 2) / (N * (1 << node.level));
    const maxFreq = p.freqAtLevel(node.level);
    const eps = cellAngle * 0.5;
    const skirtDrop = p.R * cellAngle * 2.5 + 6;

    const gridVerts = (N + 1) * (N + 1);
    const skirtVerts = 4 * (N + 1);
    const total = gridVerts + skirtVerts;
    const positions = new Float32Array(total * 3);
    const normals = new Float32Array(total * 3);
    const colors = new Float32Array(total * 3);

    const faceFn = FACE_FN[node.face];

    for (let j = 0; j <= N; j++) {
      const v = node.v0 + (node.v1 - node.v0) * (j / N);
      for (let i = 0; i <= N; i++) {
        const u = node.u0 + (node.u1 - node.u0) * (i / N);
        const idx = j * (N + 1) + i;

        faceFn(u, v, _v).normalize();
        const h = p.height(_v, maxFreq);
        _p0.copy(_v).multiplyScalar(p.R + h);

        // analytic-ish normal from two forward differences of the same field
        if (Math.abs(_v.y) < 0.95) _t1.set(-_v.z, 0, _v.x).normalize();
        else _t1.set(1, 0, 0).projectOnPlane(_v).normalize();
        _t2.crossVectors(_v, _t1);

        _d1.copy(_v).addScaledVector(_t1, eps).normalize();
        _p1.copy(_d1).multiplyScalar(p.R + p.height(_d1, maxFreq));
        _d2.copy(_v).addScaledVector(_t2, eps).normalize();
        _p2.copy(_d2).multiplyScalar(p.R + p.height(_d2, maxFreq));

        _n.crossVectors(_p1.sub(_p0), _p2.sub(_p0)).normalize();
        const slope = Math.max(0, 1 - _n.dot(_v));

        p.colorAt(_v, h, slope, maxFreq, _col);

        positions[idx * 3] = _p0.x;
        positions[idx * 3 + 1] = _p0.y;
        positions[idx * 3 + 2] = _p0.z;
        normals[idx * 3] = _n.x; normals[idx * 3 + 1] = _n.y; normals[idx * 3 + 2] = _n.z;
        colors[idx * 3] = _col.r; colors[idx * 3 + 1] = _col.g; colors[idx * 3 + 2] = _col.b;
      }
    }

    // skirt vertices: copies of the border ring, pulled toward planet center
    const edges = [];
    for (let i = 0; i <= N; i++) edges.push(i);                        // j = 0
    for (let i = 0; i <= N; i++) edges.push(N * (N + 1) + i);          // j = N
    for (let j = 0; j <= N; j++) edges.push(j * (N + 1));              // i = 0
    for (let j = 0; j <= N; j++) edges.push(j * (N + 1) + N);          // i = N

    for (let s = 0; s < edges.length; s++) {
      const src = edges[s], dst = gridVerts + s;
      const px = positions[src * 3], py = positions[src * 3 + 1], pz = positions[src * 3 + 2];
      const len = Math.hypot(px, py, pz);
      const k = (len - skirtDrop) / len;
      positions[dst * 3] = px * k; positions[dst * 3 + 1] = py * k; positions[dst * 3 + 2] = pz * k;
      normals[dst * 3] = normals[src * 3]; normals[dst * 3 + 1] = normals[src * 3 + 1]; normals[dst * 3 + 2] = normals[src * 3 + 2];
      colors[dst * 3] = colors[src * 3]; colors[dst * 3 + 1] = colors[src * 3 + 1]; colors[dst * 3 + 2] = colors[src * 3 + 2];
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
    skirtEdge(0, N + 1, (s) => s);
    skirtEdge(N + 1, N + 1, (s) => N * (N + 1) + s);
    skirtEdge(2 * (N + 1), N + 1, (s) => s * (N + 1));
    skirtEdge(3 * (N + 1), N + 1, (s) => s * (N + 1) + N);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();

    const mesh = new THREE.Mesh(geo, p.terrainMaterial);
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
