// Chunked quadtree LOD on a cube-sphere. Six root faces subdivide toward the
// camera; every chunk at every level samples the planet's height/color
// functions (with a frequency cap matched to its grid spacing), so each level
// is a faithful, coarser view of the exact same world.

import * as THREE from 'three';

export let GRID_CELLS = 24;            // quads per chunk edge
export function setGridCells(n) { GRID_CELLS = n; }   // quality presets
let SPLIT = 4.0;                       // split when dist < size * SPLIT
let MERGE = 5.2;                       // merge when dist > size * MERGE
let PREFETCH = 5.0;                    // BUILD children this early — by the
                                       // time they're wanted on screen the
                                       // morph starts at once, while chunks
                                       // are still small enough not to notice
const MORPH_TIME = 0.7;                // seconds for a LOD transition to relax

// seam instrumentation: every level change that is NOT hidden behind a morph
// gets counted with its apparent size — the seam test asserts these stay
// sub-pixel. (A pop nobody can resolve is not a pop.)
export const lodStats = {
  instantCollapses: 0, worstCollapsePx: 0,
  hardSwaps: 0, worstSwapPx: 0,
};
export function lodStatsReset() {
  lodStats.instantCollapses = 0; lodStats.worstCollapsePx = 0;
  lodStats.hardSwaps = 0; lodStats.worstSwapPx = 0;
}
let PX_PER_RAD = 900;                  // set by main from the real projection
export function setPxPerRad(v) { PX_PER_RAD = v; }
export function setTerrainScreenError(error = 1) {
  const value = Math.max(0.65, Math.min(1.5, Number(error) || 1));
  // Even performance keeps the near field at the historical highest detail;
  // the profile only changes how aggressively the middle/far field refines.
  SPLIT = Math.max(4.5, 5 / value);
  MERGE = SPLIT * 1.3;
  PREFETCH = SPLIT * 1.25;
}

const FACE_FN = [
  (u, v, out) => out.set(1, v, -u),
  (u, v, out) => out.set(-1, v, u),
  (u, v, out) => out.set(u, 1, -v),
  (u, v, out) => out.set(u, -1, v),
  (u, v, out) => out.set(u, v, 1),
  (u, v, out) => out.set(-u, v, -1),
];

// [neighbour face, neighbour edge, edge-coordinate orientation].
// Edge ids are v-, v+, u-, u+. Keeping both sides of each cube-face seam at
// the same displayed level avoids both T-junction cracks and the conspicuous
// whole-face frequency boundary produced by independently refining six trees.
const FACE_EDGE_NEIGHBOUR = [
  [[3, 3, -1], [2, 3, 1], [4, 3, 1], [5, 2, 1]],
  [[3, 2, 1], [2, 2, -1], [5, 3, 1], [4, 2, 1]],
  [[4, 1, 1], [5, 1, -1], [1, 1, -1], [0, 1, 1]],
  [[5, 0, -1], [4, 0, 1], [1, 0, 1], [0, 0, -1]],
  [[3, 1, 1], [2, 0, 1], [1, 3, 1], [0, 2, 1]],
  [[3, 0, -1], [2, 1, -1], [0, 3, 1], [1, 2, 1]],
];

export function crossFaceNeighbourAddress(face, edge, level, ix, iy) {
  const span = 1 << level;
  const along = edge < 2 ? ix : iy;
  const [neighbourFace, neighbourEdge, orientation] = FACE_EDGE_NEIGHBOUR[face][edge];
  const mapped = orientation > 0 ? along : span - 1 - along;
  let neighbourIx, neighbourIy;
  if (neighbourEdge === 0) { neighbourIx = mapped; neighbourIy = 0; }
  else if (neighbourEdge === 1) { neighbourIx = mapped; neighbourIy = span - 1; }
  else if (neighbourEdge === 2) { neighbourIx = 0; neighbourIy = mapped; }
  else { neighbourIx = span - 1; neighbourIy = mapped; }
  return {
    face: neighbourFace,
    edge: neighbourEdge,
    ix: neighbourIx,
    iy: neighbourIy,
  };
}

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
const _edgeP0 = new THREE.Vector3();
const _edgeP1 = new THREE.Vector3();
const _edgeN0 = new THREE.Vector3();
const _edgeN1 = new THREE.Vector3();
const _edgeD0 = new THREE.Vector3();
const _edgeD1 = new THREE.Vector3();
const _ex = new THREE.Vector4();
const _camDir = new THREE.Vector3();

// position/normal of the surface at one LOD cutoff; height and slope are
// left in _ss for the caller (colors are the fragment shader's job now)
const _ss = { h: 0, slope: 0 };

export function skirtDropForMorph(maxMorphHeightDelta) {
  // The skirt only seals the actual parent/fine height delta. A fixed six
  // metre minimum turned centimetre-scale high-LOD seams into visible black
  // canyon walls, most obviously through shallow water and at the limb.
  return Math.max(0.08, Math.max(0, maxMorphHeightDelta) * 1.12 + 0.04);
}
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
let activeBuildJob = null;

export function pendingChunks(lod = null) {
  let n = 0;
  for (const e of buildQueue) if (!e.dead && (!lod || e.lod === lod)) n++;
  if (activeBuildJob && !activeBuildJob.node.dead
    && (!lod || activeBuildJob.node.lod === lod)) n++;
  return n;
}

// budget is in MILLISECONDS: build as many chunks as fit, so refinement
// speed tracks the hardware instead of starving on big worlds
export function flushChunkQueue(budgetMs = 7) {
  if (buildQueue.length === 0 && !activeBuildJob) return 0;
  const t0 = performance.now();
  const deadline = t0 + budgetMs;
  let built = 0;
  let attempted = false;
  while (activeBuildJob || buildQueue.length) {
    if (activeBuildJob?.node.dead || activeBuildJob?.node.mesh) activeBuildJob = null;

    // A full sort of 1–2k moving priorities every frame cost more than the
    // one or two chunks we normally build. Select only the best entry needed
    // this frame; focused terrain wins over background worlds.
    if (!activeBuildJob) {
      let bestIndex = -1;
      let bestPriority = Infinity;
      for (let i = 0; i < buildQueue.length; i++) {
        const e = buildQueue[i];
        if (e.dead || e.mesh) continue;
        const focusK = e.lod.focused ? 0.18 : 1.0;
        // During the covered startup pass complete the whole coarse shell
        // before drilling into a few central patches. The old depth-first-ish
        // ordering left half the globe coarse while isolated areas sharpened.
        const startupLevel = e.lod.startupPriority ? e.level * 1000 : 0;
        const prio = startupLevel + (e.lod.nodeDistance(e) / e.size) * focusK;
        if (prio < bestPriority) {
          bestPriority = prio;
          bestIndex = i;
        }
      }
      if (bestIndex < 0) {
        buildQueue.length = 0;
        break;
      }
      const node = buildQueue[bestIndex];
      buildQueue[bestIndex] = buildQueue[buildQueue.length - 1];
      buildQueue.pop();
      node.queued = false;
      if (node.dead || node.mesh) continue;
      activeBuildJob = node.lod.createBuildJob(node);
    }

    attempted = true;
    if (activeBuildJob.node.lod.stepBuildJob(activeBuildJob, deadline)) {
      activeBuildJob.node.lod.finishBuildJob(activeBuildJob);
      activeBuildJob = null;
      built++;
    }
    // A partial chunk consumed this frame's budget. Keeping it active avoids
    // throwing away sampled vertices, while the next frame resumes exactly
    // where this one stopped.
    if (activeBuildJob || performance.now() >= deadline) break;
    if (attempted && performance.now() - t0 >= budgetMs) break;
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
    parent: null, childX: 0, childY: 0,
    children: null, mesh: null, queued: false, dead: false,
    // geomorph state: 1 = parent's shape, 0 = own full detail
    // born settled at the parent's shape; the split path explicitly starts
    // the 1→0 relax when (and only when) the node is actually displayed —
    // prefetched-but-undisplayed children must not read as pending morphs
    morph: 1, morphTo: 1, splitActive: false, mergePending: false,
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
    this.visible = true;
    this.camLocal = new THREE.Vector3(1e9, 0, 0);
    this.roots = [];
    this._frame = 0;
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
    const liveCamR = this.camLocal.length();
    const camR = this._orbitCapped && this.startupPriority
      && node.level < (this.planet.orbitLevelCap ?? 0)
      && this.planet.orbitPrewarmRadiusRatio
      ? Math.max(liveCamR, p.R * this.planet.orbitPrewarmRadiusRatio)
      : liveCamR;
    const R0 = p.R * 0.94;
    if (camR <= R0 + 1) return false;
    const horizon = Math.acos(Math.min(1, R0 / camR))
      + Math.sqrt(2 * Math.max(p.hAmp, 1) / R0)
      + (node.size / p.R) * 0.9 + 0.08;
    const ang = Math.acos(Math.max(-1, Math.min(1,
      _camDir.copy(this.camLocal).normalize().dot(node.centerDir))));
    return ang > horizon;
  }

  update(camLocal, dt = 0.016) {
    this.camLocal.copy(camLocal);
    this._dt = dt;
    this._frame++;
    const radiusRatio = camLocal.length() / Math.max(this.planet.R, 1);
    // A 64×64 terrain chunk already resolves sub-pixel geometry at orbit.
    // Refining beyond the authored orbit cap only rebuilt imperceptible
    // frequencies while the player watched the whole globe change shape.
    // Hysteresis prevents cap churn at the atmosphere/space boundary.
    if (this._orbitCapped == null) this._orbitCapped = radiusRatio > 1.12;
    else if (this._orbitCapped && radiusRatio < 1.08) this._orbitCapped = false;
    else if (!this._orbitCapped && radiusRatio > 1.16) this._orbitCapped = true;
    if (this._orbitCapped && Number.isFinite(this.planet.orbitLevelCap)) {
      // "Orbit" spans a full-disk view and a planet-filling 120 km approach;
      // one fixed cap cannot serve both. The old level-4 cap left ~2.7 km
      // triangles on the 900 km homeworld until only 72 km above terrain,
      // exactly the broad polygonal facets visible in orbital descent. Add
      // detail continuously through the approach while retaining the cheap
      // full-disk cap at long range.
      let approachLevels = 0;
      const thresholds = this.planet.orbitApproachLevelThresholds
        || [1.32, 1.20, 1.12];
      for (const threshold of thresholds) {
        if (radiusRatio < threshold) approachLevels++;
      }
      this._levelCap = Math.min(this.planet.maxLevel,
        this.planet.orbitLevelCap + approachLevels);
    } else {
      this._levelCap = this.planet.maxLevel;
    }
    // a planet that fills the screen must never show a polygonal limb:
    // force a minimum subdivision depth from its apparent size
    const d = Math.max(camLocal.length() - this.planet.R, 1);
    const ang = this.planet.R / d;
    const baseForceLevel = ang > 1.2 ? 3 : ang > 0.45 ? 2 : ang > 0.15 ? 1 : 0;
    if (this.planet.lodLevelForCanonical) {
      this._forceLevel = Math.min(this._levelCap,
        this.planet.lodLevelForCanonical(baseForceLevel));
    } else {
      const detailOffset = Math.max(0, Math.round(Math.log2(1 / (this.planet.lodDistanceScale || 1))));
      this._forceLevel = Math.min(this._levelCap,
        Math.max(0, baseForceLevel - detailOffset));
    }
    for (const root of this.roots) this.process(root);
    if (!this.visible) {
      for (const root of this.roots) this.hideSubtree(root);
    }
  }

  setVisible(visible) {
    this.visible = visible;
    if (!visible) {
      for (const root of this.roots) this.hideSubtree(root);
    }
  }

  setMorph(node, v) {
    node.morph = v;
    if (node.mesh) {
      node.mesh.userData.lodMorph = v;
      if (node.mesh.morphTargetInfluences) node.mesh.morphTargetInfluences[0] = v;
    }
  }

  advanceMorph(node) {
    if (node.morph === node.morphTo) return;
    // small on screen → faster morph: the transition is equally invisible
    // but chunks free sooner when departing a planet
    const step = (this._dt / MORPH_TIME) * (node.pxBoost || 1);
    const m = node.morph < node.morphTo
      ? Math.min(node.morphTo, node.morph + step)
      : Math.max(node.morphTo, node.morph - step);
    this.setMorph(node, m);
  }

  process(node) {
    node.processedFrame = this._frame;
    const d = this.nodeDistance(node);
    const px = (node.size / Math.max(d, 1)) * PX_PER_RAD;   // apparent size
    node.pxBoost = Math.min(12, Math.max(1, 24 / Math.max(px, 0.01)));
    const beyond = this.beyondHorizon(node);
    const distanceScale = this.planet.lodDistanceScaleAtLevel
      ? this.planet.lodDistanceScaleAtLevel(node.level)
      : this.planet.lodDistanceScale || 1;
    const splitDistance = SPLIT * distanceScale;
    const mergeDistance = MERGE * distanceScale;
    const prefetchDistance = PREFETCH * distanceScale;
    const naturalWantSplit = node.level < this._levelCap
      && (d < node.size * splitDistance || node.level < this._forceLevel)
      && !beyond;
    const forcedAcrossFace = node.forceSplitUntil >= this._frame && !beyond;
    const wantSplit = naturalWantSplit || forcedAcrossFace;
    const wantMerge = node.level >= this._levelCap
      || d > node.size * mergeDistance || beyond;

    if (!node.children && !beyond && node.level < this._levelCap) {
      // prefetch exists to feed morphs; water (noMorph) swaps sub-pixel and
      // creates at the display threshold like before
      // Focused terrain gets a modest lead for fast descents. Going much
      // farther than this refines the whole visible cap and destroys frame
      // time before the extra geometry is actually resolvable.
      const reach = (this.planet.noMorph ? SPLIT : (this.focused ? 5.8 : PREFETCH)) * distanceScale;
      if (d < node.size * reach || node.level < this._forceLevel || forcedAcrossFace) {
        this.createChildren(node);
      }
    }

    // A cube face is not a parent/child boundary, so normal geomorph ownership
    // cannot protect it by itself. If a boundary node wants another level,
    // prebuild and force the exact peer interval on the adjacent face. Both
    // sides wait until they have been processed in the same frame before
    // exposing children, then relax from identical parent-edge line segments.
    if (wantSplit && node.level < this._levelCap) {
      this.synchronizeFaceBoundarySplit(node);
    }

    if (node.children) {
      let ready = true;
      for (const c of node.children) if (!c.mesh) { ready = false; break; }

      // The DISPLAYED level owns the hysteresis: once children are on screen
      // (splitActive) they stay on screen until a true merge — swapping
      // levels anywhere inside the SPLIT..MERGE band is an instant pop.
      const boundaryReady = !wantSplit || this.faceBoundaryPeersReady(node);
      if (ready && boundaryReady && (wantSplit || (node.splitActive && !wantMerge))) {
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

      if (node.splitActive && wantMerge && node.mesh) {
        // truly sub-pixel: swap at once — nobody can resolve it, and departing
        // a planet must free its thousands of chunks quickly
        if (px < 4) {
          for (const c of node.children) {
            if (c.mesh && c.mesh.visible) {
              lodStats.instantCollapses++;
              lodStats.worstCollapsePx = Math.max(lodStats.worstCollapsePx, px);
              break;
            }
          }
          this.disposeChildren(node);
        } else {
          const leavesOnly = node.children.every((c) => !c.children);
          if (leavesOnly) {
            // animate children back into the parent's shape, then swap — no pop
            if (!node.mergePending) {
              node.mergePending = true;
              for (const c of node.children) c.morphTo = 1;
            }
            const done = node.children.every((c) => !c.mesh || c.morph >= 0.999);
            if (done) {
              this.disposeChildren(node);
            } else {
              node.mesh.visible = false;
              for (const c of node.children) {
                c.pxBoost = node.pxBoost;
                if (c.mesh) c.mesh.visible = true;
                this.advanceMorph(c);
              }
              return;
            }
          } else {
            // grandchildren must collapse first; keep recursing
            node.mesh.visible = false;
            for (const c of node.children) this.process(c);
            return;
          }
        }
      } else if (!node.splitActive && node.children && !wantSplit
        && d > node.size * (prefetchDistance + 0.4 * distanceScale)) {
        // children were built for a split that never displayed (fast flyby)
        // and we're beyond the prefetch band: dropping them changes nothing
        // on screen (inside the band they stay warm, ready for the approach)
        this.disposeChildren(node);
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
      // any child still visible at this point is an unmorphed level swap —
      // count it so the seam test can fail loudly
      for (const c of node.children) {
        if (c.mesh && c.mesh.visible) {
          lodStats.hardSwaps++;
          lodStats.worstSwapPx = Math.max(lodStats.worstSwapPx, px);
          break;
        }
      }
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
        c.parent = node;
        c.childX = dx;
        c.childY = dy;
        node.children.push(c);
        c.queued = true;
        buildQueue.push(c);
      }
    }
  }

  boundaryEdges(node) {
    const span = 1 << node.level;
    const edges = [];
    if (node.iy === 0) edges.push(0);
    if (node.iy === span - 1) edges.push(1);
    if (node.ix === 0) edges.push(2);
    if (node.ix === span - 1) edges.push(3);
    return edges;
  }

  neighbourAddress(node, edge) {
    return crossFaceNeighbourAddress(
      node.face, edge, node.level, node.ix, node.iy,
    );
  }

  findNode(face, level, ix, iy, create = false) {
    let node = this.roots[face];
    for (let depth = 1; depth <= level; depth++) {
      if (!node.children) {
        if (!create || node.level >= this._levelCap) return null;
        this.createChildren(node);
      }
      const bit = level - depth;
      const childX = (ix >> bit) & 1;
      const childY = (iy >> bit) & 1;
      node = node.children[childY * 2 + childX];
    }
    return node;
  }

  synchronizeFaceBoundarySplit(node) {
    for (const edge of this.boundaryEdges(node)) {
      const address = this.neighbourAddress(node, edge);
      const peer = this.findNode(address.face, node.level, address.ix, address.iy, true);
      if (!peer || this.beyondHorizon(peer)) continue;
      peer.forceSplitUntil = Math.max(peer.forceSplitUntil || 0, this._frame + 2);
      if (!peer.children && peer.level < this._levelCap) this.createChildren(peer);
    }
  }

  faceBoundaryPeersReady(node) {
    for (const edge of this.boundaryEdges(node)) {
      const address = this.neighbourAddress(node, edge);
      const peer = this.findNode(address.face, node.level, address.ix, address.iy, false);
      if (!peer || this.beyondHorizon(peer)) continue;
      if (!peer.children || !peer.children.every((child) => child.mesh)) return false;
      // If the peer already ran before this force request, wait one frame so
      // neither side can expose a finer edge on its own.
      if (peer.processedFrame === this._frame && !peer.splitActive) return false;
    }
    return true;
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

  createBuildJob(node) {
    return { node, iterator: this.buildNodeMeshGenerator(node) };
  }

  stepBuildJob(job, deadline) {
    do {
      const step = job.iterator.next();
      if (step.done) return true;
    } while (performance.now() < deadline);
    return false;
  }

  finishBuildJob(job) {
    // Geometry is committed by the generator only after every attribute and
    // index is complete, so partially-built chunks never reach rendering.
    return job.node.mesh;
  }

  buildNodeMesh(node) {
    const job = this.createBuildJob(node);
    while (!this.stepBuildJob(job, Infinity)) { /* synchronous root build */ }
    return this.finishBuildJob(job);
  }

  *buildNodeMeshGenerator(node) {
    const p = this.planet;
    // flat liquid surfaces don't need dense grids — p.gridCells overrides
    const N = p.gridCellsAtLevel ? p.gridCellsAtLevel(node.level) : p.gridCells || GRID_CELLS;
    const cellAngle = (Math.PI / 2) / (N * (1 << node.level));
    const maxFreq = p.freqAtLevel(node.level);
    const eps = cellAngle * 0.5;
    // non-root chunks carry their parent's shape as a morph target, so LOD
    // transitions can relax between levels instead of popping
    const hasMorph = node.level > 0 && !p.noMorph;
    const parentFreq = node.level > 0 ? p.freqAtLevel(node.level - 1) : 0;
    const coarseFreq = hasMorph ? parentFreq : 0;
    const parentLocalAttribute = hasMorph
      ? node.parent?.mesh?.geometry?.getAttribute('aLocal') : null;
    const parentNormalAttribute = hasMorph
      ? node.parent?.mesh?.geometry?.getAttribute('normal') : null;
    const parentN = hasMorph && node.parent
      ? (p.gridCellsAtLevel
        ? p.gridCellsAtLevel(node.parent.level) : p.gridCells || GRID_CELLS)
      : 0;

    const gridVerts = (N + 1) * (N + 1);
    // A spherical level surface can still crack at mixed quadtree levels:
    // the coarse edge is a longer chord while the fine edge follows the arc.
    // Water therefore uses short, radial skirts rather than skipping them.
    // Parent-edge constraints remove T-junction disagreement; a tightly
    // fitted skirt remains as a conservative seal for arbitrary neighbour
    // level differences while the asynchronous tree refines. Limiting skirts
    // to levels < 3 left the moving fine/coarse frontier visibly unsealed.
    const faceSpan = 1 << node.level;
    const skirtEdgeIds = [];
    if (!p.noSkirt || (p.faceBoundarySkirts && node.iy === 0)) skirtEdgeIds.push(0);
    if (!p.noSkirt || (p.faceBoundarySkirts && node.iy === faceSpan - 1)) skirtEdgeIds.push(1);
    if (!p.noSkirt || (p.faceBoundarySkirts && node.ix === 0)) skirtEdgeIds.push(2);
    if (!p.noSkirt || (p.faceBoundarySkirts && node.ix === faceSpan - 1)) skirtEdgeIds.push(3);
    const hasSkirt = skirtEdgeIds.length > 0;
    const skirtVerts = skirtEdgeIds.length * (N + 1);
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
    // Terrain material semantics must follow the same parent-triangle morph
    // as geometry. Root arrays remain zero; child arrays store parent-minus-
    // child deltas consumed by the shared NodeMaterial.
    const dLocal = p.pal ? new Float32Array(total * 3) : null;
    const dMat = aMat ? new Float32Array(total * 3) : null;
    const dExtra = aExtra ? new Float32Array(total * 4) : null;
    // water depth beneath each sea-surface vertex (Beer–Lambert absorption)
    const aDepth = p.bakeDepth ? new Float32Array(total) : null;
    const dDepth = aDepth ? new Float32Array(total) : null;
    const dPos = hasMorph ? new Float32Array(total * 3) : null;
    const dNrm = hasMorph ? new Float32Array(total * 3) : null;
    const parentMatAttribute = hasMorph
      ? node.parent?.mesh?.geometry?.getAttribute('aMat') : null;
    const parentExtraAttribute = hasMorph
      ? node.parent?.mesh?.geometry?.getAttribute('aExtra') : null;
    const parentDepthAttribute = hasMorph
      ? node.parent?.mesh?.geometry?.getAttribute('aDepth') : null;

    const faceFn = FACE_FN[node.face];
    let maxMorphHeightDelta = 0;
    // Terrain noise is much more expensive than flat water. Four-vertex
    // interactive batches keep the 3.2 ms scheduler budget honest even for
    // 64×64 high-tier chunks; startup and liquid jobs retain the
    // cache-friendly sixteen-vertex batch.
    const batchMask = p.hAmp > 10 && !this.startupPriority ? 3 : 15;

    for (let j = 0; j <= N; j++) {
      const v = node.v0 + (node.v1 - node.v0) * (j / N);
      for (let i = 0; i <= N; i++) {
        const u = node.u0 + (node.u1 - node.u0) * (i / N);
        const idx = j * (N + 1) + i;

        faceFn(u, v, _dirV).normalize();
        sampleSurface(p, _dirV, maxFreq, eps, _p0, _n);
        const edgeConstrained = false;
        let h = _p0.length() - p.R;
        let slope = Math.max(0, 1 - _n.dot(_dirV));

        positions[idx * 3] = _p0.x;
        positions[idx * 3 + 1] = _p0.y;
        positions[idx * 3 + 2] = _p0.z;
        normals[idx * 3] = _n.x; normals[idx * 3 + 1] = _n.y; normals[idx * 3 + 2] = _n.z;

        if (aExtra) {
          p.extrasAt(_dirV, h, maxFreq, _ex);
          aExtra[idx * 4] = _ex.x; aExtra[idx * 4 + 1] = _ex.y;
          aExtra[idx * 4 + 2] = _ex.z; aExtra[idx * 4 + 3] = _ex.w;
        }
        if (aDepth) aDepth[idx] = p.bakeDepth(_dirV, maxFreq, node.level);
        if (aMat) {
          const sl = (slope - p.pal.slopeLo) / (p.pal.slopeHi - p.pal.slopeLo);
          aMat[idx * 3] = Math.min(1, Math.max(0, sl));
          aMat[idx * 3 + 1] = aExtra ? Math.min(1, _ex.x * 1.4) : 0;
        }

        if (hasMorph) {
          // Reconstruct the exact point on the parent mesh's two real
          // triangles. Sampling the parent frequency again at the child's
          // spherical direction produces a different curved surface, so a
          // child at morph=1 still cracks against its visible neighbour.
          // Barycentric interpolation is exact and reuses already-built data,
          // avoiding one expensive height+normal evaluation per child vertex.
          if (parentLocalAttribute && parentNormalAttribute && parentN > 0) {
            const gx = (node.childX + i / N) * parentN * 0.5;
            const gy = (node.childY + j / N) * parentN * 0.5;
            const x0 = Math.min(parentN - 1, Math.floor(gx));
            const y0 = Math.min(parentN - 1, Math.floor(gy));
            const tx = gx - x0;
            const ty = gy - y0;
            const a = y0 * (parentN + 1) + x0;
            const b = a + 1;
            const c = a + parentN + 1;
            const d = c + 1;
            let i0, i1, i2, w0, w1, w2;
            if (tx + ty <= 1) {
              i0 = a; i1 = b; i2 = c;
              w0 = 1 - tx - ty; w1 = tx; w2 = ty;
            } else {
              i0 = b; i1 = d; i2 = c;
              w0 = 1 - ty; w1 = tx + ty - 1; w2 = 1 - tx;
            }
            _cP.set(
              parentLocalAttribute.getX(i0) * w0
                + parentLocalAttribute.getX(i1) * w1
                + parentLocalAttribute.getX(i2) * w2,
              parentLocalAttribute.getY(i0) * w0
                + parentLocalAttribute.getY(i1) * w1
                + parentLocalAttribute.getY(i2) * w2,
              parentLocalAttribute.getZ(i0) * w0
                + parentLocalAttribute.getZ(i1) * w1
                + parentLocalAttribute.getZ(i2) * w2,
            );
            _cN.set(
              parentNormalAttribute.getX(i0) * w0
                + parentNormalAttribute.getX(i1) * w1
                + parentNormalAttribute.getX(i2) * w2,
              parentNormalAttribute.getY(i0) * w0
                + parentNormalAttribute.getY(i1) * w1
                + parentNormalAttribute.getY(i2) * w2,
              parentNormalAttribute.getZ(i0) * w0
                + parentNormalAttribute.getZ(i1) * w1
                + parentNormalAttribute.getZ(i2) * w2,
            ).normalize();
            if (dMat && parentMatAttribute) {
              dMat[idx * 3] = parentMatAttribute.getX(i0) * w0
                + parentMatAttribute.getX(i1) * w1
                + parentMatAttribute.getX(i2) * w2 - aMat[idx * 3];
              dMat[idx * 3 + 1] = parentMatAttribute.getY(i0) * w0
                + parentMatAttribute.getY(i1) * w1
                + parentMatAttribute.getY(i2) * w2 - aMat[idx * 3 + 1];
              dMat[idx * 3 + 2] = parentMatAttribute.getZ(i0) * w0
                + parentMatAttribute.getZ(i1) * w1
                + parentMatAttribute.getZ(i2) * w2 - aMat[idx * 3 + 2];
            }
            if (dExtra && parentExtraAttribute) {
              dExtra[idx * 4] = parentExtraAttribute.getX(i0) * w0
                + parentExtraAttribute.getX(i1) * w1
                + parentExtraAttribute.getX(i2) * w2 - aExtra[idx * 4];
              dExtra[idx * 4 + 1] = parentExtraAttribute.getY(i0) * w0
                + parentExtraAttribute.getY(i1) * w1
                + parentExtraAttribute.getY(i2) * w2 - aExtra[idx * 4 + 1];
              dExtra[idx * 4 + 2] = parentExtraAttribute.getZ(i0) * w0
                + parentExtraAttribute.getZ(i1) * w1
                + parentExtraAttribute.getZ(i2) * w2 - aExtra[idx * 4 + 2];
              dExtra[idx * 4 + 3] = parentExtraAttribute.getW(i0) * w0
                + parentExtraAttribute.getW(i1) * w1
                + parentExtraAttribute.getW(i2) * w2 - aExtra[idx * 4 + 3];
            }
            if (dDepth && parentDepthAttribute) {
              dDepth[idx] = parentDepthAttribute.getX(i0) * w0
                + parentDepthAttribute.getX(i1) * w1
                + parentDepthAttribute.getX(i2) * w2 - aDepth[idx];
            }
          } else {
            // Root/bootstrap fallback; normal child builds always have a
            // committed parent mesh because display ownership is top-down.
            sampleSurface(p, _dirV, coarseFreq, eps * 2, _cP, _cN);
          }
          dPos[idx * 3] = _cP.x - _p0.x;
          dPos[idx * 3 + 1] = _cP.y - _p0.y;
          dPos[idx * 3 + 2] = _cP.z - _p0.z;
          dNrm[idx * 3] = _cN.x - _n.x;
          dNrm[idx * 3 + 1] = _cN.y - _n.y;
          dNrm[idx * 3 + 2] = _cN.z - _n.z;
          if (dLocal) {
            dLocal[idx * 3] = _cP.x - _p0.x;
            dLocal[idx * 3 + 1] = _cP.y - _p0.y;
            dLocal[idx * 3 + 2] = _cP.z - _p0.z;
          }
          maxMorphHeightDelta = Math.max(maxMorphHeightDelta,
            Math.abs(_cP.length() - _p0.length()));
        }
        // Yield in small cache-friendly batches. Yielding every vertex creates
        // millions of short-lived IteratorResult objects during a descent and
        // eventually hands the render loop a large garbage-collection pause.
        if ((i & batchMask) === batchMask || i === N) yield;
      }
    }

    // Optional static worlds may still provide a baked visibility function.
    // Rotating planets deliberately omit it so moving sunlight never leaves
    // stale mountain shadows in rebuilt chunks.
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
          if ((si & 15) === 15 || si === SN) yield;
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
        yield;
      }
    }

    // skirt vertices: copies of the border ring, pulled toward planet center
    // A skirt only has to cover the radial gap to the neighbouring parent LOD.
    // The former radius×cellAngle formula was 14–22× oversized near the
    // surface, bloating bounds and exposing dark walls at grazing angles.
    let skirtDrop = Number.isFinite(p.skirtDrop)
      ? Math.max(0.05, p.skirtDrop)
      : skirtDropForMorph(maxMorphHeightDelta);
    const edges = [];
    for (const edgeId of skirtEdgeIds) {
      if (edgeId === 0) for (let i = 0; i <= N; i++) edges.push(i);
      else if (edgeId === 1) for (let i = 0; i <= N; i++) edges.push(N * (N + 1) + i);
      else if (edgeId === 2) for (let j = 0; j <= N; j++) edges.push(j * (N + 1));
      else for (let j = 0; j <= N; j++) edges.push(j * (N + 1) + N);
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
      if (dLocal) {
        dLocal[dst * 3] = dLocal[src * 3];
        dLocal[dst * 3 + 1] = dLocal[src * 3 + 1];
        dLocal[dst * 3 + 2] = dLocal[src * 3 + 2];
      }
      if (dMat) {
        dMat[dst * 3] = dMat[src * 3];
        dMat[dst * 3 + 1] = dMat[src * 3 + 1];
        dMat[dst * 3 + 2] = dMat[src * 3 + 2];
      }
      if (dExtra) {
        dExtra[dst * 4] = dExtra[src * 4];
        dExtra[dst * 4 + 1] = dExtra[src * 4 + 1];
        dExtra[dst * 4 + 2] = dExtra[src * 4 + 2];
        dExtra[dst * 4 + 3] = dExtra[src * 4 + 3];
      }
      if (aDepth) aDepth[dst] = aDepth[src];
      if (dDepth) dDepth[dst] = dDepth[src];
      if (hasMorph) {
        dPos[dst * 3] = dPos[src * 3]; dPos[dst * 3 + 1] = dPos[src * 3 + 1]; dPos[dst * 3 + 2] = dPos[src * 3 + 2];
        dNrm[dst * 3] = dNrm[src * 3]; dNrm[dst * 3 + 1] = dNrm[src * 3 + 1]; dNrm[dst * 3 + 2] = dNrm[src * 3 + 2];
      }
      yield;
    }

    const gridIndexCount = N * N * 6;
    const skirtIndexCount = skirtEdgeIds.length * N * 12;
    const indices = new Uint16Array(gridIndexCount + skirtIndexCount);
    let indexCursor = 0;
    // all six FACE_FN have du×dv pointing outward, so CCW (front) is (a,b,c)
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i, b = a + 1, c = a + (N + 1), d = c + 1;
        indices[indexCursor++] = a; indices[indexCursor++] = b;
        indices[indexCursor++] = c; indices[indexCursor++] = b;
        indices[indexCursor++] = d; indices[indexCursor++] = c;
      }
      yield;
    }
    // skirt quads (both windings; backface culling drops the wrong one)
    const skirtEdge = (offset, count, gridIdx) => {
      for (let s = 0; s < count - 1; s++) {
        const g0 = gridIdx(s), g1 = gridIdx(s + 1);
        const s0 = gridVerts + offset + s, s1 = gridVerts + offset + s + 1;
        indices[indexCursor++] = g0; indices[indexCursor++] = g1;
        indices[indexCursor++] = s0; indices[indexCursor++] = s0;
        indices[indexCursor++] = g1; indices[indexCursor++] = s1;
        indices[indexCursor++] = g0; indices[indexCursor++] = s0;
        indices[indexCursor++] = g1; indices[indexCursor++] = g1;
        indices[indexCursor++] = s0; indices[indexCursor++] = s1;
      }
    };
    for (let edgeOffset = 0; edgeOffset < skirtEdgeIds.length; edgeOffset++) {
      const edgeId = skirtEdgeIds[edgeOffset];
      const offset = edgeOffset * (N + 1);
      if (edgeId === 0) skirtEdge(offset, N + 1, (s) => s);
      else if (edgeId === 1) skirtEdge(offset, N + 1, (s) => N * (N + 1) + s);
      else if (edgeId === 2) skirtEdge(offset, N + 1, (s) => s * (N + 1));
      else skirtEdge(offset, N + 1, (s) => s * (N + 1) + N);
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
    if (dLocal) geo.setAttribute('aLocalDelta', new THREE.BufferAttribute(dLocal, 3));
    if (dMat) geo.setAttribute('aMatDelta', new THREE.BufferAttribute(dMat, 3));
    if (dExtra) geo.setAttribute('aExtraDelta', new THREE.BufferAttribute(dExtra, 4));
    if (aDepth) geo.setAttribute('aDepth', new THREE.BufferAttribute(aDepth, 1));
    if (dDepth) geo.setAttribute('aDepthDelta', new THREE.BufferAttribute(dDepth, 1));
    if (hasMorph) {
      geo.morphAttributes.position = [new THREE.BufferAttribute(dPos, 3)];
      geo.morphAttributes.normal = [new THREE.BufferAttribute(dNrm, 3)];
      geo.morphTargetsRelative = true;
    }
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    if (hasMorph) geo.boundingSphere.radius += p.hAmp;   // morphed verts may bulge

    const mesh = new THREE.Mesh(geo, p.terrainMaterial);
    mesh.userData.lodMorph = node.morph;
    mesh.position.copy(node.centerPos);
    if (p.underlayMaterial) {
      const underlay = new THREE.Mesh(geo, p.underlayMaterial);
      underlay.renderOrder = -10;
      underlay.castShadow = false;
      underlay.receiveShadow = false;
      mesh.add(underlay);
    }
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

  debugStats() {
    let chunks = 0, visible = 0, activeMorphs = 0;
    let visibleMinLevel = Infinity, visibleMaxLevel = -1;
    const levels = {};
    const visibleLevels = {};
    const walk = (node) => {
      if (node.mesh) {
        chunks++;
        levels[node.level] = (levels[node.level] || 0) + 1;
        if (node.mesh.visible) {
          visible++;
          visibleLevels[node.level] = (visibleLevels[node.level] || 0) + 1;
          visibleMinLevel = Math.min(visibleMinLevel, node.level);
          visibleMaxLevel = Math.max(visibleMaxLevel, node.level);
          if (Math.abs(node.morph - node.morphTo) > 1e-4) activeMorphs++;
        }
      }
      if (node.children) for (const child of node.children) walk(child);
    };
    for (const root of this.roots) walk(root);
    return {
      chunks,
      visible,
      visibleMinLevel: Number.isFinite(visibleMinLevel) ? visibleMinLevel : null,
      visibleMaxLevel: visibleMaxLevel >= 0 ? visibleMaxLevel : null,
      maxLevel: this.planet.maxLevel,
      activeMorphs,
      pending: pendingChunks(this),
      levels,
      visibleLevels,
    };
  }
}
